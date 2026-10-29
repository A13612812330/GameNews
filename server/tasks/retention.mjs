// 统一库留档：活跃资讯仅保留最近 7 天和未来事件；历史转轻量 JSON。
// 不处理 ratings / notifications / deliveries / AI 结论 / Steam history 基线。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DAY = 86400000;

function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function safeJson(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function parseDate(value, now = new Date()) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value);
  const text = String(value || "").trim();
  if (!text) return null;
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime()) && /\d{4}/u.test(text)) return direct;
  const match = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})[:：](\d{2}))?/u)
    || text.match(/(\d{1,2})[./-](\d{1,2})(?:\s*(\d{1,2})[:：](\d{2}))?/u);
  if (!match) return null;
  const [year] = shanghaiDateKey(now).split("-").map(Number);
  const month = String(Number(match[1])).padStart(2, "0");
  const day = String(Number(match[2])).padStart(2, "0");
  const hour = String(Number(match[3] || 0)).padStart(2, "0");
  const minute = String(Number(match[4] || 0)).padStart(2, "0");
  let result = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`);
  if (result.getTime() < now.getTime() - 183 * DAY) result = new Date(`${year + 1}-${month}-${day}T${hour}:${minute}:00+08:00`);
  return result;
}

function articleDate(article, now) {
  const facts = safeJson(article.facts_json, {});
  for (const value of [facts.taptapUpcomingStartTime, facts.timelineDate, facts.haoyouUpdateDate, facts.x7LaunchTime, facts.businessDate, article.date_text, article.discovered_at]) {
    const parsed = parseDate(value, now);
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(article.discovered_at || now);
}

function lightArticle(article, now) {
  const images = safeJson(article.images_json, []).map((item) => String(item?.originalUrl || item?.url || item?.src || "")).filter((url) => /^https?:\/\//iu.test(url));
  return {
    id: article.id, gameName: article.game_name || "", title: article.title || "",
    sourceId: article.source_id || "", sourceName: article.source_name || "", category: article.category || "",
    score: Number(article.score || 0), quality: article.quality || "", businessDate: articleDate(article, now).toISOString(),
    discoveredAt: article.discovered_at || "", detailUrl: article.detail_url || "", imageUrl: article.image_url || images[0] || "", imageUrls: [...new Set(images)],
  };
}

function lightEvent(event) {
  return { id: event.id, gameId: event.game_id ?? null, title: event.title || "", eventType: event.event_type || "", startedAt: event.started_at || "", endedAt: event.ended_at || "", sourceUrl: event.source_url || "", sourceArticleId: event.source_article_id || "", createdAt: event.created_at || "" };
}

function archiveFile(kind, date) { return path.join(ROOT, "data", "light-archive", kind, `${date}.json`); }
function mergeArchive(kind, date, rows) {
  if (!rows.length) return;
  const target = archiveFile(kind, date);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let existing = [];
  try { existing = safeJson(fs.readFileSync(target, "utf8"), []); } catch {}
  const map = new Map(existing.filter(Boolean).map((item) => [item.id || JSON.stringify(item), item]));
  rows.forEach((item) => map.set(item.id || JSON.stringify(item), item));
  fs.writeFileSync(target, JSON.stringify([...map.values()], null, 2), "utf8");
}

function deleteByIds(db, table, ids) {
  if (!ids.length) return 0;
  const stmt = db.prepare(`DELETE FROM ${table} WHERE id=?`);
  db.exec("BEGIN");
  try { ids.forEach((id) => stmt.run(id)); db.exec("COMMIT"); return ids.length; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function groupByDate(rows, dateOf, mapRow) {
  const groups = new Map();
  for (const row of rows) {
    const date = shanghaiDateKey(dateOf(row));
    const list = groups.get(date) || [];
    list.push(mapRow(row)); groups.set(date, list);
  }
  return groups;
}

function summaryArchive(kind, rows, dateField) {
  const groups = new Map();
  for (const row of rows) {
    const date = shanghaiDateKey(new Date(row[dateField]));
    const group = groups.get(date) || { date, total: 0, statuses: {}, sources: {} };
    group.total += 1;
    if (row.status) group.statuses[row.status] = (group.statuses[row.status] || 0) + 1;
    if (row.source_id) group.sources[row.source_id] = (group.sources[row.source_id] || 0) + 1;
    groups.set(date, group);
  }
  for (const [date, data] of groups) mergeArchive(kind, date, [data]);
}

function pruneOutput(cutoffKey, stage) {
  const root = path.join(ROOT, "output");
  const dirs = ["brief-archive", "poster-archive", "weekly-poster-archive"];
  const deleted = [];
  for (const dir of dirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      const match = name.match(/(20\d{2})-(\d{2})-(\d{2})/u);
      if (!match) continue;
      const date = `${match[1]}-${match[2]}-${match[3]}`;
      if (date >= cutoffKey) continue;
      const file = path.join(full, name);
      deleted.push(path.relative(ROOT, file));
      if (stage) fs.rmSync(file, { force: true });
    }
  }
  return deleted;
}

export function runRetention(db, { keepDays = 7, now = new Date(), stage = false } = {}) {
  const cutoff = new Date(new Date(`${shanghaiDateKey(now)}T00:00:00+08:00`).getTime() - Math.max(1, Number(keepDays) || 7) * DAY);
  const cutoffKey = shanghaiDateKey(cutoff);
  const result = { mode: stage ? "stage" : "dry-run", keepDays, cutoff: cutoff.toISOString(), articles: 0, events: 0, briefs: 0, crawlRuns: 0, publicationRuns: 0, realtimeSteamSnapshots: 0, outputs: [] };

  const articles = db.prepare("SELECT * FROM articles").all().filter((row) => articleDate(row, now).getTime() < cutoff.getTime());
  const events = db.prepare("SELECT * FROM events").all().filter((row) => new Date(row.started_at || row.created_at).getTime() < cutoff.getTime());
  const briefs = db.prepare("SELECT * FROM briefs WHERE created_at < ?").all(cutoff.toISOString());
  const crawlRuns = db.prepare("SELECT * FROM crawl_runs WHERE started_at < ?").all(cutoff.toISOString());
  const publicationRuns = db.prepare("SELECT * FROM publication_runs WHERE started_at < ?").all(cutoff.toISOString());
  const realtimeSteam = db.prepare("SELECT * FROM steam_snapshots WHERE data_grade='realtime' AND snapshot_at < ?").all(cutoff.toISOString());

  result.articles = articles.length; result.events = events.length; result.briefs = briefs.length;
  result.crawlRuns = crawlRuns.length; result.publicationRuns = publicationRuns.length; result.realtimeSteamSnapshots = realtimeSteam.length;
  result.outputs = pruneOutput(cutoffKey, false);
  if (!stage) return result;

  for (const [date, rows] of groupByDate(articles, (row) => articleDate(row, now), (row) => lightArticle(row, now))) mergeArchive("articles", date, rows);
  for (const [date, rows] of groupByDate(events, (row) => new Date(row.started_at || row.created_at), lightEvent)) mergeArchive("events", date, rows);
  for (const [date, rows] of groupByDate(briefs, (row) => new Date(row.created_at), (row) => ({ id: row.id, title: row.title, slot: row.slot, status: row.status, createdAt: row.created_at, publishedAt: row.published_at || "" }))) mergeArchive("briefs", date, rows);
  summaryArchive("crawl-runs", crawlRuns, "started_at");
  summaryArchive("publication-runs", publicationRuns, "started_at");
  for (const [date, rows] of groupByDate(realtimeSteam, (row) => new Date(row.snapshot_at), (row) => ({ id: row.id, appid: row.appid, snapshotAt: row.snapshot_at, source: row.snapshot_source, metric: row.metric_name, value: row.metric_value }))) mergeArchive("steam-realtime", date, rows);

  // 先删除关联的原始载荷/远程资源元数据，再删除文章；人工评级与飞书投递不删除。
  if (articles.length) {
    const refs = articles.map((row) => row.id);
    const placeholders = refs.map(() => "?").join(",");
    db.prepare(`DELETE FROM raw_payloads WHERE ref_id IN (${placeholders})`).run(...refs);
    db.prepare(`DELETE FROM assets WHERE article_id IN (${placeholders})`).run(...refs);
  }
  if (briefs.length) {
    const refs = briefs.map((row) => row.id);
    const placeholders = refs.map(() => "?").join(",");
    db.prepare(`DELETE FROM brief_items WHERE brief_id IN (${placeholders})`).run(...refs);
  }
  deleteByIds(db, "articles", articles.map((row) => row.id));
  deleteByIds(db, "events", events.map((row) => row.id));
  deleteByIds(db, "briefs", briefs.map((row) => row.id));
  deleteByIds(db, "crawl_runs", crawlRuns.map((row) => row.id));
  deleteByIds(db, "publication_runs", publicationRuns.map((row) => row.id));
  deleteByIds(db, "steam_snapshots", realtimeSteam.map((row) => row.id));
  result.outputs = pruneOutput(cutoffKey, true);
  fs.mkdirSync(path.join(ROOT, "data", "light-archive"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "light-archive", "retention-last-run.json"), JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2), "utf8");
  return result;
}
