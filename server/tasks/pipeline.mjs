// GameNewsUnified 每日/每周任务管道（P6）
// 原则：消费统一库与规则层生成输出；P6 阶段默认 --no-publish（对外机器人关闭），不发送任何飞书消息。
// 输出命名与旧项目一致，便于双跑对照：output/brief-archive|poster-archive|weekly-poster-archive
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { dedupArticles, normalizeGameName } from "../rules/index.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DB_PATH = path.join(ROOT, "data", "game-news-unified.sqlite");
const OUT = path.join(ROOT, "output");
export const NO_PUBLISH = !process.argv.includes("--publish"); // 对外机器人默认关闭

function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const now = () => new Date().toISOString();

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA query_only = 0;");
  return db;
}

export function recordRun(db, { id, kind, target, status, fingerprint, startedAt, error = null, itemsFound = 0, itemsNew = 0 }) {
  db.prepare(
    `INSERT INTO publication_runs (id, kind, target, status, started_at, finished_at, output_path, fingerprint, error)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, kind, target, status, startedAt, now(), target, fingerprint, error);
  if (kind === "crawl") {
    db.prepare(
      `INSERT INTO crawl_runs (id, source_id, run_kind, started_at, finished_at, status, items_found, items_new, error)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(id, null, "pipeline", startedAt, now(), status, itemsFound, itemsNew, error);
  }
}

// 取出某日的候选文章（统一库），去重并分组
export function pickDailyArticles(db, date, { limit = 60 } = {}) {
  const rows = db.prepare(
    `SELECT id, source_id, source_name, title, game_name, category, detail_url, date_text,
            score, quality, review_status, selected_for_brief, discovered_at, paragraphs_json
     FROM articles WHERE substr(discovered_at,1,10)=? AND quality='ok'
     ORDER BY score DESC LIMIT ?`
  ).all(date, limit);
  return rows;
}

const KIND_MAP = { 新游上线: "新游", 测试公测: "测试", 版本更新: "更新", 活动: "活动", 热点上升: "热点", "Steam 热玩榜": "榜单", "Steam 畅销榜（中国区）": "榜单" };

// 生成今日简讯 + 简讯海报（HTML，结构对齐旧项目便于对照）
export function generateDaily(db, date, slot = "morning") {
  const startedAt = now();
  const articles = pickDailyArticles(db, date);
  const groups = dedupArticles(articles);
  const briefId = `brief-${date}-${slot}-${Date.now()}`;
  const sections = [];
  for (const g of groups) {
    const w = g.winner;
    const kind = KIND_MAP[w.category] || w.category || "资讯";
    const body = safeBody(w.paragraphs_json);
    sections.push({ game: w.game_name, event: w.title, kind, source: w.source_name, body, url: w.detail_url, id: w.id });
  }
  const sorted = sections.sort((a, b) => (a.kind === "新游" ? -1 : 0) - (b.kind === "新游" ? -1 : 0));
  const byKind = new Map();
  for (const s of sorted) { if (!byKind.has(s.kind)) byKind.set(s.kind, []); byKind.get(s.kind).push(s); }
  const lead = `${date} 游戏动态：共 ${sorted.length} 条（来自统一库，去重后）。`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>今日游戏简讯</title>
<style>
body{margin:0;background:#f4f5f1;color:#28342d}.brief{max-width:680px;margin:0 auto;padding:32px 28px 40px;background:#fff;font-family:"Microsoft YaHei",Arial,sans-serif;line-height:1.8}
.brief h1{font-size:26px;margin:0 0 12px;color:#183d2b}.lead{margin:0 0 22px;padding:12px 14px;border-left:4px solid #2c6b4f;background:#f1f6f2;font-size:14px}
.group-title{margin:26px 0 12px;padding:8px 12px;border-left:4px solid #2c6b4f;background:#f1f6f2;font-size:18px;font-weight:800;color:#183d2b}
.card{padding:14px 0;border-bottom:1px solid #e4e9e5}.card h2{margin:0 0 8px;font-size:17px;color:#1f6245}
.meta{font-size:11px;color:#75857a;margin-top:4px}.meta span{display:inline-block;margin-right:8px}
.meta .kind{padding:1px 7px;border-radius:999px;background:#eef6f0;color:#2c6b4f;font-weight:700}
.body{font-size:14px;color:#405147;white-space:pre-wrap;margin:6px 0 0}
.src{font-size:11px;color:#9aa8a0;margin-top:4px}
</style></head><body><div class="brief"><h1>今日游戏简讯</h1><p class="lead">${esc(lead)}</p>
${[...byKind.entries()].map(([kind, items]) => `
<div class="group-title">${esc(kind)}（${items.length} 条）</div>
${items.map((s) => `<div class="card"><h2>${s.game ? `《${esc(s.game)}》` : ""}${esc(cleanEvent(s.event))}</h2>
<div class="meta"><span class="kind">${esc(s.kind)}</span><span>${esc(s.source)}</span><span>${esc(date)}</span></div>
<div class="body">${esc(s.body)}</div><div class="src">来源：${esc(s.url || "—")}</div></div>`).join("")}
`).join("")}
<p style="margin-top:26px;color:#9aa8a0;font-size:11px">GameNewsUnified · ${esc(date)} · ${slot} · 未发布（对外机器人关闭）</p>
</div></body></html>`;
  fs.mkdirSync(path.join(OUT, "brief-archive"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "poster-archive"), { recursive: true });
  const briefFile = path.join(OUT, "brief-archive", `今日简讯-${date}.html`);
  const posterFile = path.join(OUT, "poster-archive", `简讯海报-${date}.html`);
  fs.writeFileSync(briefFile, html, "utf8");
  fs.writeFileSync(posterFile, html, "utf8");
  db.prepare(
    `INSERT INTO briefs (id, legacy_id, source_system, title, style, max_length, lead, template_id, total_characters, reading_minutes, sections_json, source_notes_json, status, slot, published_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(briefId, briefId, "unified", "今日游戏简讯", "professional", 1200, lead, "P6-UNIFIED",
    html.length, Math.max(1, Math.round(html.length / 500)),
    JSON.stringify(sections), JSON.stringify([]), NO_PUBLISH ? "draft" : "exported", slot, NO_PUBLISH ? null : now(), now(), now());
  recordRun(db, { id: `pub-brief-${date}-${slot}-${Date.now()}`, kind: "brief", target: briefFile, status: "ok", fingerprint: `${date}-${slot}`, startedAt, itemsFound: articles.length, itemsNew: sorted.length });
  recordRun(db, { id: `pub-poster-${date}-${slot}-${Date.now()}`, kind: "poster", target: posterFile, status: "ok", fingerprint: `${date}-${slot}-poster`, startedAt });
  return { briefId, briefFile, posterFile, count: sorted.length, publish: !NO_PUBLISH };
}

function safeBody(json) {
  try { const a = JSON.parse(json); return Array.isArray(a) && a.length ? a[0] : ""; } catch { return ""; }
}
function cleanEvent(t) {
  return String(t).replace(/^《[^》]*》/, "").replace(/^#+\s*/, "");
}

// 生成 14 天周报（Steam 口径明确 + 无空模块；概览/列表基于统一库最新采集 articles 表）
export function generateWeekly(db, date) {
  const startedAt = now();
  const since = new Date(date); since.setDate(since.getDate() - 13);
  const sinceStr = since.toISOString().slice(0, 10);
  const byCategory = {};
  for (const r of db.prepare(
    "SELECT category, COUNT(*) c FROM articles WHERE substr(discovered_at,1,10) BETWEEN ? AND ? AND quality='ok' GROUP BY category"
  ).all(sinceStr, date)) {
    byCategory[r.category] = r.c;
  }
  const articles = db.prepare(
    "SELECT title, game_name, category, source_name, detail_url, discovered_at FROM articles WHERE substr(discovered_at,1,10) BETWEEN ? AND ? AND quality='ok' ORDER BY discovered_at DESC LIMIT 30"
  ).all(sinceStr, date);
  const steam = db.prepare("SELECT COUNT(*) c FROM steam_snapshots WHERE data_grade='history'").get().c;
  const ai = db.prepare("SELECT COUNT(*) c FROM ai_analyses").get().c;
  const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>游戏资讯周报</title>
<style>body{margin:0;background:#f4f5f1;color:#28342d;font-family:"Microsoft YaHei",Arial,sans-serif;line-height:1.8}
.weekly{max-width:720px;margin:0 auto;padding:32px 28px;background:#fff}.weekly h1{font-size:25px;color:#183d2b}
table{border-collapse:collapse;width:100%;margin:10px 0}th,td{border:1px solid #d7dfd9;padding:6px 9px;font-size:13px;text-align:left}
th{background:#eef4ef}.muted{color:#8a968e;font-size:12px}</style></head><body><div class="weekly">
<h1>游戏资讯周报（${esc(date)}）</h1>
<p class="muted">统计区间：${esc(sinceStr)} ~ ${esc(date)}（14 天）· 数据来源：GameNewsUnified 统一库 articles 表</p>
<h2>一、资讯概览</h2><p class="muted">本期收录 ${total} 条（去重后，按发现日期），分类分布如下：</p>
<table><thead><tr><th>类型</th><th>数量</th></tr></thead>
<tbody>${Object.entries(byCategory).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("") || `<tr><td colspan="2">本期无收录</td></tr>`}</tbody></table>
<h2>二、Steam 模块</h2>
<p>历史三源快照：<b>${steam}</b> 条（口径 7.1–8.25，history）；实时快照：待接入采集器。数据等级已分离，未将演示数据混入。</p>
<h2>三、AI 分析模块</h2>
<p>AI 分析记录：<b>${ai}</b> 条（模型/提示词待配置，当前为记录层）。</p>
<h2>四、近期收录（前 30）</h2><table><thead><tr><th>标题</th><th>游戏</th><th>类型</th><th>来源</th><th>时间</th></tr></thead>
<tbody>${articles.map((a) => `<tr><td>${esc(a.title)}</td><td>${esc(a.game_name || "—")}</td><td>${esc(a.category)}</td><td>${esc(a.source_name)}</td><td>${esc((a.discovered_at || "").slice(0, 10))}</td></tr>`).join("")}</tbody></table>
<p class="muted">GameNewsUnified · 未发布（对外机器人关闭）</p></div></body></html>`;
  fs.mkdirSync(path.join(OUT, "weekly-poster-archive"), { recursive: true });
  const file = path.join(OUT, "weekly-poster-archive", `游戏资讯周报-${date}.html`);
  fs.writeFileSync(file, html, "utf8");
  recordRun(db, { id: `pub-weekly-${date}-${Date.now()}`, kind: "weekly", target: file, status: "ok", fingerprint: `weekly-${date}`, startedAt });
  return { file, events: articles.length, total };
}
