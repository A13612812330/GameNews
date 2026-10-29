// GameNewsUnified API 服务（零依赖：node:http + node:sqlite）
// 统一数据出口：资讯/来源/Steam/简讯/飞书/运行台 + React 前端(dist) + 输出托管 + 管理接口。
// 工厂化：createServer 供 API 合约测试复用；仅作为主模块执行时才监听端口。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createRatingService } from "./rules/index.mjs";
import { TASKS, nextRunOf } from "./tasks/config.mjs";
import { ensureNotificationAuditSchema, requeueNotification } from "./feishu/audit-store.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, "public");
const DIST_DIR = path.join(ROOT, "dist");
const DOCS_DIR = path.join(ROOT, "docs");
const DEFAULT_DB = path.join(ROOT, "data", "game-news-unified.sqlite");
const PORT = Number(process.env.GN_PORT || 64500);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}
function qp(url) {
  return Object.fromEntries(new URL(url, "http://x").searchParams);
}
function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(fs.readFileSync(filePath));
}

export function createServer({ dbPath = DEFAULT_DB, port = PORT } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 0;");
  const ratings = createRatingService(db);

  function listArticles(params) {
    const where = [];
    const args = [];
    if (params.source) { where.push("source_id=?"); args.push(params.source); }
    if (params.category) { where.push("category=?"); args.push(params.category); }
    if (params.quality) { where.push("quality=?"); args.push(params.quality); }
    if (params.q) { where.push("(title LIKE ? OR game_name LIKE ?)"); args.push(`%${params.q}%`, `%${params.q}%`); }
    const limit = Math.min(Number(params.limit) || 200, 500);
    const offset = Number(params.offset) || 0;
    const sql = `SELECT id, source_id, source_name, title, game_name, category, detail_url, image_url, date_text,
                        score, quality, status, review_status, selected_for_brief, discovered_at,
                        paragraphs_json AS excerpt
                 FROM articles ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY discovered_at DESC LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) c FROM articles ${where.length ? "WHERE " + where.join(" AND ") : ""}`).get(...args).c;
    return { items: rows, total };
  }
  function getArticle(id) {
    const row = db.prepare("SELECT * FROM articles WHERE id=?").get(id);
    if (!row) return null;
    return { ...row, rating: ratings.getEffective("article", id) };
  }
  function steamGames(q) {
    const args = [];
    let sql = `SELECT g.*, (SELECT COUNT(*) FROM steam_snapshots s WHERE s.appid=g.appid AND s.data_grade='realtime') AS realtime_snaps,
                      (SELECT COUNT(*) FROM steam_snapshots s WHERE s.appid=g.appid AND s.data_grade='history') AS history_snaps
               FROM games g`;
    if (q) { sql += " WHERE g.cn_name LIKE ? OR g.name LIKE ?"; args.push(`%${q}%`, `%${q}%`); }
    sql += " ORDER BY g.release_date DESC LIMIT 500";
    return db.prepare(sql).all(...args);
  }

  // ---- 管理接口：任务配置 ----
  function adminTasks() {
    const lastCrawl = new Map(db.prepare("SELECT source_id, MAX(finished_at) m FROM crawl_runs GROUP BY source_id").all().map((r) => [r.source_id, r.m]));
    const lastPub = new Map(db.prepare("SELECT kind, MAX(finished_at) m FROM publication_runs GROUP BY kind").all().map((r) => [r.kind, r.m]));
    const now = new Date();
    return TASKS.map((t) => {
      let lastRun = null;
      let lastStatus = null;
      let lastError = null;
      let sources = [];
      if (t.kind === "crawl") {
        if (t.id === "monitor") {
          // monitor 是多来源聚合：按最近一轮的各来源记录汇总（全部成功=成功；任一失败=部分失败）
          const last = db.prepare("SELECT MAX(started_at) m FROM crawl_runs WHERE run_kind='monitor'").get().m;
          if (last) {
            lastRun = last;
            sources = db.prepare(
              "SELECT source_id, status, error, finished_at, items_found, items_new FROM crawl_runs WHERE run_kind='monitor' AND started_at=? ORDER BY source_id"
            ).all(last);
            const failed = sources.filter((s) => s.status !== "ok");
            lastStatus = failed.length === 0 ? "ok" : failed.length === sources.length ? "failed" : "partial";
            lastError = failed.length ? failed.map((f) => `${f.source_id}: ${String(f.error || "失败").slice(0, 120)}`).join("；").slice(0, 400) : null;
          }
        } else {
          const row = db.prepare("SELECT finished_at, status, error FROM crawl_runs WHERE run_kind=? ORDER BY finished_at DESC LIMIT 1").get(t.id);
          if (row) { lastRun = row.finished_at; lastStatus = row.status; lastError = row.error; }
          lastRun = lastRun || lastCrawl.get("steam") || null;
        }
      } else {
        const row = db.prepare("SELECT finished_at, status, error FROM publication_runs WHERE kind=? ORDER BY finished_at DESC LIMIT 1").get(t.id === "daily-brief" ? "brief" : "weekly");
        if (row) { lastRun = row.finished_at; lastStatus = row.status; lastError = row.error; }
      }
      return {
        id: t.id, name: t.name, rate: t.rate, desc: t.desc, enabled: t.enabled, kind: t.kind,
        lastRun, lastStatus, lastError, sources, nextRun: nextRunOf(t, now, lastRun),
      };
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (p === "/api/health") return json(res, 200, { ok: true, name: "GameNewsUnified API", db: dbPath });

      // ---- 资讯 ----
      if (p === "/api/articles" && req.method === "GET") return json(res, 200, listArticles(qp(req.url)));
      if (/^\/api\/articles\/[^/]+$/.test(p) && req.method === "GET") {
        const a = getArticle(decodeURIComponent(p.split("/")[3]));
        return a ? json(res, 200, a) : json(res, 404, { error: "not found" });
      }
      if (/^\/api\/articles\/[^/]+$/.test(p) && req.method === "PATCH") {
        const id = decodeURIComponent(p.split("/")[3]);
        const body = await readBody(req);
        const sets = [];
        const args = [];
        for (const k of ["review_status", "review_notes", "selected_for_brief", "quality"]) {
          if (k in body) { sets.push(`${k}=?`); args.push(body[k]); }
        }
        if (!sets.length) return json(res, 400, { error: "no fields" });
        args.push(id);
        db.prepare(`UPDATE articles SET ${sets.join(",")}, updated_at=datetime('now') WHERE id=?`).run(...args);
        return json(res, 200, getArticle(id));
      }
      // ---- 评级 ----
      if (/^\/api\/articles\/[^/]+\/rating$/.test(p) && req.method === "POST") {
        const id = decodeURIComponent(p.split("/")[3]);
        const body = await readBody(req);
        const r = ratings.set("article", id, body.rating, "manual", body.note || null);
        return json(res, 200, r);
      }
      // ---- 导出 ----
      if (p === "/api/export/articles.csv") {
        const { items } = listArticles({ limit: 2000 });
        const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const lines = [["id", "来源", "标题", "游戏", "分类", "评分", "质量", "日期", "链接", "人工评级"].map(esc).join(",")];
        for (const a of items) {
          const r = ratings.getEffective("article", a.id);
          lines.push([a.id, a.source_name, a.title, a.game_name, a.category, a.score, a.quality, a.date_text, a.detail_url, r?.rating || ""].map(esc).join(","));
        }
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=articles.csv" });
        return res.end("\uFEFF" + lines.join("\n"));
      }
      // ---- 事件 ----
      if (p === "/api/events") {
        const g = qp(req.url);
        const where = []; const args = [];
        if (g.from) { where.push("created_at>=?"); args.push(g.from); }
        const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 500`;
        return json(res, 200, db.prepare(sql).all(...args));
      }
      // ---- 来源 / 运行 ----
      if (p === "/api/sources") return json(res, 200, db.prepare("SELECT * FROM sources ORDER BY category, name").all());
      if (p === "/api/crawl-runs") return json(res, 200, db.prepare("SELECT * FROM crawl_runs ORDER BY started_at DESC LIMIT 200").all());
      if (p === "/api/publication-runs") return json(res, 200, db.prepare("SELECT * FROM publication_runs ORDER BY started_at DESC LIMIT 200").all());
      if (p === "/api/migration-logs") return json(res, 200, db.prepare("SELECT * FROM migration_logs ORDER BY id DESC LIMIT 200").all());
      // ---- 简讯 ----
      if (p === "/api/briefs") return json(res, 200, db.prepare("SELECT * FROM briefs ORDER BY created_at DESC LIMIT 200").all());
      // ---- Steam ----
      if (p === "/api/steam/games") return json(res, 200, steamGames(qp(req.url).q));
      if (p === "/api/steam/snapshots") {
        const g = qp(req.url);
        const where = []; const args = [];
        if (g.appid) { where.push("appid=?"); args.push(Number(g.appid)); }
        if (g.metric) { where.push("metric_name=?"); args.push(g.metric); }
        if (g.grade) { where.push("data_grade=?"); args.push(g.grade); }
        const sql = `SELECT * FROM steam_snapshots ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY snapshot_at DESC LIMIT 1000`;
        return json(res, 200, db.prepare(sql).all(...args));
      }
      if (p === "/api/steam/metrics") {
        const g = qp(req.url);
        const where = []; const args = [];
        if (g.kind) { where.push("source_kind=?"); args.push(g.kind); }
        const sql = `SELECT * FROM steam_source_metrics ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 1000`;
        return json(res, 200, db.prepare(sql).all(...args));
      }
      // WorkBuddy 三源看板：从统一库重建 s1/s2/s3/s4/category/trend
      if (p === "/api/steam/trisource") {
        const s1 = [];
        const search = db.prepare("SELECT * FROM steam_source_metrics WHERE source_kind='search'").all();
        const byName = new Map();
        for (const m of search) { if (!byName.has(m.game_name)) byName.set(m.game_name, {}); byName.get(m.game_name)[m.metric_name] = m.metric_value; }
        for (const [game, row] of byName) s1.push({ "端游名称(中文)": game, "总搜索次数(7-8月)": row["总搜索次数(7-8月)"] ?? "", "7月搜索": row["7月搜索"] ?? "", "8月搜索": row["8月搜索"] ?? "", "8月相对增长": row["8月相对增长"] ?? "", "相关性": row["相关性"] ?? "" });
        const s2 = [];
        const jingyun = db.prepare("SELECT * FROM steam_source_metrics WHERE source_kind='jingyun'").all();
        const jy = new Map();
        for (const m of jingyun) { if (!jy.has(m.game_name)) jy.set(m.game_name, {}); jy.get(m.game_name)[m.metric_name] = m.metric_value; if (m.extra_json) jy.get(m.game_name).__raw = m.extra_json; }
        for (const [game, row] of jy) {
          const raw = row.__raw ? JSON.parse(row.__raw) : {};
          s2.push({ "鲸云游戏名称": game, "游玩人数": row["游玩人数"] ?? raw["游玩人数"] ?? "", "注册人数": row["注册人数"] ?? raw["注册人数"] ?? "", "Steam对应游戏": raw["Steam对应游戏"] ?? "", "appid": raw["appid"] ?? "—", "备注": raw["备注"] ?? "" });
        }
        const s3Map = new Map();
        const s4 = [];
        const snaps = db.prepare("SELECT * FROM steam_snapshots WHERE snapshot_source='workbuddy-history'").all();
        for (const x of snaps) {
          let raw = null; try { raw = JSON.parse(x.raw_json || "null"); } catch {}
          if (!raw || typeof raw !== "object") continue;
          if (x.metric_name === "current_online") s3Map.set(Number(x.appid), raw);
          if (raw["判定/说明"]) { s4.push(raw); s3Map.set(Number(x.appid), { ...(s3Map.get(Number(x.appid)) || {}), ...raw }); }
        }
        const s3 = [...s3Map.values()];
        const catMap = new Map();
        for (const r of s3) { const c = r["品类"] || "其他"; catMap.set(c, (catMap.get(c) || 0) + 1); }
        const category = [...catMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
        const pv = (v) => { const m = String(v ?? "").replace(/,/g, "").match(/[\d.]+/); return m ? parseFloat(m[0]) : 0; };
        const trend = s1.slice().sort((a, b) => pv(b["总搜索次数(7-8月)"]) - pv(a["总搜索次数(7-8月)"])).slice(0, 10)
          .map((r) => ({ n: r["端游名称(中文)"], g7: pv(r["7月搜索"]), g8: pv(r["8月搜索"]) }));
        return json(res, 200, { s1, s2, s3, s4, category, trend });
      }
      // ---- AI / 评级 / 飞书 ----
      if (p === "/api/ai-analyses") return json(res, 200, db.prepare("SELECT * FROM ai_analyses ORDER BY created_at DESC LIMIT 200").all());
      if (p === "/api/ratings") return json(res, 200, db.prepare("SELECT * FROM ratings ORDER BY updated_at DESC LIMIT 200").all());
      if (p === "/api/notifications") return json(res, 200, db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200").all());
      if (p === "/api/deliveries") return json(res, 200, db.prepare("SELECT * FROM deliveries ORDER BY sent_at DESC LIMIT 200").all());

      // ---- 管理接口 ----
      if (p === "/api/admin/tasks" && req.method === "GET") return json(res, 200, adminTasks());
      if (p === "/api/admin/feishu" && req.method === "GET") {
        // 飞书同步状态：通知/投递记录 + 评级来源分布 + 最近同步
        ensureNotificationAuditSchema(db);
        const notifications = db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50").all();
        const deliveries = db.prepare(`SELECT d.*, n.title AS notification_title, n.kind AS notification_kind
          FROM deliveries d LEFT JOIN notifications n ON n.id=d.notification_id
          ORDER BY COALESCE(d.updated_at, d.sent_at) DESC LIMIT 50`).all();
        const ratings = db.prepare("SELECT source, COUNT(*) c FROM ratings GROUP BY source ORDER BY c DESC").all();
        return json(res, 200, { notifications, deliveries, ratings });
      }
      if (/^\/api\/admin\/feishu\/notifications\/[^/]+\/retry$/.test(p) && req.method === "POST") {
        const id = decodeURIComponent(p.split("/")[5]);
        const queued = requeueNotification(db, id);
        return json(res, queued ? 200 : 409, { ok: queued, message: "已加入下一轮重试队列（不会立即发送）" });
      }
      if (/^\/api\/admin\/tasks\/[^/]+\/run$/.test(p) && req.method === "POST") {
        const id = decodeURIComponent(p.split("/")[4]);
        const task = TASKS.find((t) => t.id === id);
        if (!task) return json(res, 404, { error: `未知任务 ${id}` });
        // 只运行统一管道任务；对外发送默认关闭（--no-publish），真实发送需用户单独授权。
        const date = new Date().toISOString().slice(0, 10);
        await new Promise((resolve) => {
          execFile(process.execPath, ["server/tasks/scheduler.mjs", "--run", id, "--now", "--date", date], { cwd: ROOT, timeout: 120000 }, resolve);
        });
        return json(res, 200, { ok: true, task: id, message: "已触发运行（--no-publish）" });
      }
      if (p === "/api/admin/sources/run" && req.method === "POST") {
        // 爬虫尚未迁入统一项目（P2 实施）；诚实返回未实现，不伪造状态。
        return json(res, 501, { error: "来源爬虫尚未迁入统一项目（P2 实施）；当前仅 Steam 实时快照可经任务运行" });
      }

      // ---- 静态资源（仅服务 React dist；旧 public/ 静态前端不再对外）----
      if (p === "/" || p === "/index.html") {
        const appIndex = path.join(DIST_DIR, "index.html");
        if (fs.existsSync(appIndex)) return serveStatic(res, appIndex);
        return json(res, 404, { error: "frontend dist 未构建（请先 npm run build）" });
      }
      if (p === "/preview/site-concept") return serveStatic(res, path.join(DOCS_DIR, "FRONTEND_SITE_CONCEPT.html"));
      if (p === "/preview/modules") return serveStatic(res, path.join(DOCS_DIR, "FRONTEND_MODULE_PREVIEW.html"));
      if (p.startsWith("/output/")) {
        let decoded = p;
        try { decoded = decodeURIComponent(p); } catch { /* 非法编码，按原样尝试 */ }
        const outFile = path.join(ROOT, decoded.replace(/^\/+/, ""));
        if (fs.existsSync(outFile) && fs.statSync(outFile).isFile()) return serveStatic(res, outFile);
        return json(res, 404, { error: "output not found" });
      }
      // 旧零依赖静态前端遗留文件即使仍在 dist/，也不能被正式服务暴露。
      // React/Vite 的入口只使用 /assets/* 构建产物。
      if (p === "/app.js" || p === "/styles.css") return json(res, 404, { error: "legacy static frontend disabled" });
      const distFile = path.join(DIST_DIR, p.replace(/^\/+/, ""));
      if (fs.existsSync(distFile) && fs.statSync(distFile).isFile()) return serveStatic(res, distFile);
      if (!path.extname(p) && fs.existsSync(path.join(DIST_DIR, "index.html"))) return serveStatic(res, path.join(DIST_DIR, "index.html"));
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  });

  return { server, db, ratings };
}

// 作为主模块执行时启动服务
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { server } = createServer();
  server.listen(PORT, () => {
    console.log(`GameNewsUnified API 运行中: http://127.0.0.1:${PORT}`);
    console.log(`DB: ${DEFAULT_DB}`);
  });
}
