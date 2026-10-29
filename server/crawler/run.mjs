// 统一爬虫编排（P2）：按来源抓取 → 规则层清洗 → 只写新增/缺失详情 → crawl_runs 记录。
// 对外不发送（爬虫只写入统一库）。
import { openDb, ADAPTERS, sourceInfo } from "./registry.mjs";
import { cleanBusinessGameName, extractBookTitle, normalizeTitle } from "../rules/index.mjs";

function mapItem(source, it) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  return {
    id: `cr:${source.id}:${it.legacy || ""}`,
    legacy_id: `${source.id}:${it.legacy || ""}`,
    source_system: "crawler",
    source_id: source.id,
    source_name: source.name,
    title: it.title || "",
    game_name: it.gameName || extractBookTitle(it.title),
    category: it.category || "新游上线",
    detail_url: it.detailUrl || "",
    image_url: it.imageUrl || null,
    date_text: it.dateText || null,
    score: Number(it.score) || 50,
    quality: it.paragraphs?.length ? "ok" : "pending",
    paragraphs_json: JSON.stringify(it.paragraphs || []),
    facts_json: it.facts ? JSON.stringify(it.facts) : null,
    images_json: it.images ? JSON.stringify(it.images) : null,
    discovered_at: now,
    updated_at: now,
  };
}

// 单个来源抓取→清洗→入库；返回 summary 条目。Steam 网络波动频繁，外部接口间歇性失败，
// 由调用方对 ref-steam 失败时重试（runSources 内实现）。
async function runOneSource({ db, id, src, adapter, runKind, startedAt, dryRun }) {
  const runId = `cr-${id}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const fail = (reason) => {
    db.prepare(`INSERT INTO crawl_runs (id, source_id, run_kind, started_at, finished_at, status, items_found, items_new, error)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, id, runKind, startedAt, new Date().toISOString(), "failed", 0, 0, String(reason).slice(0, 400));
    return { source: id, status: "failed", error: reason };
  };
  try {
    const mod = await adapter.module();
    const fetchFn = adapter.fetch(mod);
    const { items, error } = await fetchFn();
    // 部分成功也接受（如 Steam 单边失败）；仅当无结果且有错误才算失败
    if (error && !items.length) throw new Error(error);
    const rows = items.map((it) => mapItem(src, it));
    // 清洗去重（规则层）：业务游戏名+同日期+同分类 去重，避免同游戏被官服/预约后缀拆开
    const kept = [];
    const seen = new Set();
    for (const r of rows) {
      const key = `${cleanBusinessGameName(r.game_name)}|${r.date_text || ""}|${r.category}`;
      if (seen.has(key)) continue;
      seen.add(key); kept.push(r);
    }
    let inserted = 0;
    if (!dryRun) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO articles (id, legacy_id, source_system, source_id, source_name, title, game_name, category, detail_url, image_url, date_text, score, quality, paragraphs_json, facts_json, images_json, discovered_at, updated_at, imported_batch)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const newRows = [];
      for (const r of kept) {
        const changed = stmt.run(r.id, r.legacy_id, r.source_system, r.source_id, r.source_name, r.title, r.game_name, r.category, r.detail_url, r.image_url, r.date_text, r.score, r.quality, r.paragraphs_json, r.facts_json, r.images_json, r.discovered_at, r.updated_at, "crawler").changes;
        inserted += changed;
        if (changed) newRows.push(r);
      }
      // 详情补全：仅对新增且正文缺失的条目抓详情（P2：详情只对新增/缺失记录抓取）
      if (adapter.detail && newRows.length) {
        const detailFn = adapter.detail(mod);
        for (const r of newRows) {
          if (!r.detail_url) continue;
          try {
            const d = await detailFn(r.detail_url);
            if (d?.paragraphs?.length) {
              db.prepare(`UPDATE articles SET paragraphs_json=?, images_json=?, quality=? WHERE id=?`)
                .run(JSON.stringify(d.paragraphs), d.images ? JSON.stringify(d.images) : r.images_json, d.quality || "ok", r.id);
            }
          } catch { /* 详情失败不阻塞，保留 pending */ }
        }
      }
      db.prepare(`INSERT INTO crawl_runs (id, source_id, run_kind, started_at, finished_at, status, items_found, items_new, error)
                  VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, id, runKind, startedAt, new Date().toISOString(), "ok", rows.length, inserted, null);
    }
    return { source: id, status: "ok", found: rows.length, new: inserted, dryRun };
  } catch (e) {
    return fail(e.message);
  }
}

export async function runSources(sourceIds, { dryRun = false, runKind = "crawl" } = {}) {
  const db = openDb();
  const summary = [];
  const roundStartedAt = new Date().toISOString(); // 本轮所有来源共享同一 started_at，便于按轮聚合
  for (const id of sourceIds) {
    const src = sourceInfo(db, id);
    const startedAt = roundStartedAt;
    const adapter = ADAPTERS[id];
    if (!src || !adapter) { summary.push({ source: id, status: "skipped", reason: "未知来源" }); continue; }
    if (!adapter.runnable) {
      summary.push({ source: id, status: "pending", reason: adapter.note || "待迁入" });
      db.prepare(`INSERT INTO crawl_runs (id, source_id, run_kind, started_at, finished_at, status, items_found, items_new, error)
                  VALUES (?,?,?,?,?,?,?,?,?)`).run(`cr-${id}-${Date.now()}`, id, runKind, startedAt, new Date().toISOString(), "pending", 0, 0, adapter.note || "待迁入");
      continue;
    }
    const base = { db, id, src, adapter, runKind, startedAt, dryRun };
    let r = await runOneSource(base);
    // Steam 网络波动：失败自动重试一次，显著提升成功率（重试前短暂等待避开波动窗口）
    if (r.status === "failed" && id === "ref-steam") {
      await new Promise((res) => setTimeout(res, 4000));
      r = await runOneSource(base);
      if (r.status === "ok") r.retried = true;
    }
    summary.push(r);
  }
  db.close();
  return summary;
}
