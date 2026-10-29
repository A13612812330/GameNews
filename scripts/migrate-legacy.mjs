#!/usr/bin/env node
// GameNewsUnified 旧数据迁移脚本
// 用法:
//   node scripts/migrate-legacy.mjs --dry-run    # 只统计不写入（默认推荐）
//   node scripts/migrate-legacy.mjs              # 实际写入（幂等，可重复执行）
//
// 数据源：P0 冻结备份 backups/2026-08-26（只读，避免锁与改动旧库）
//         + WorkBuddy 三源数据包 全部数据.json（静态文件）
// 原则：只增不删；保留 legacy_id / source_system；Steam AppID 唯一；快照只追加。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_PATH = path.join(ROOT, "data", "game-news-unified.sqlite");
const BACKUP = "E:/新建文件夹/Codex-GPT/GameNewsUnified/backups/2026-08-26";
const WB_JSON = "E:/新建文件夹/WorkBuddy/端游三源数据_导出v4/全部数据.json";
const BATCH = "P2-2026-08-26";

const DRY = process.argv.includes("--dry-run");
// 目标库：仅实际写入时打开（dry-run 不产生任何副作用）
const db = DRY ? null : new DatabaseSync(DB_PATH);

// ---------- 工具 ----------
function openCopy(rel) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gn-mig-"));
  const name = path.basename(rel);
  const copy = path.join(tmp, name);
  for (const suf of ["", "-wal", "-shm"]) {
    const src = `${BACKUP}/${rel}${suf}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, `${copy}${suf}`);
  }
  const d = new DatabaseSync(copy);
  d.exec("PRAGMA query_only = 1;");
  return { db: d, tmp };
}

function insertOrIgnore(db, table, cols, rows) {
  if (!db || !rows.length) return 0;
  const placeholders = cols.map(() => "?").join(",");
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`
  );
  db.exec("BEGIN");
  let n = 0;
  try {
    for (const r of rows) {
      const args = r.map((v) => (v === undefined ? null : v));
      n += stmt.run(...args).changes;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

// ---------- 日志 ----------
function logMigration(db, kind, c) {
  if (!db || DRY) return;
  db.prepare(
    `INSERT INTO migration_logs (batch, kind, read_count, written_count, skipped_count, conflict_count, duplicate_count, detail_json, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    BATCH, kind, c.read || 0, c.written || 0, c.skipped || 0, c.conflict || 0, c.duplicate || 0,
    JSON.stringify(c.detail || {}),
    c.startedAt ?? new Date().toISOString(), new Date().toISOString()
  );
}

function section(t, s) {
  console.log(`\n[${t}] ${s}`);
}

// ---------- 主流程 ----------
const report = {};

// 1. 来源合并
section("sources", "合并 GameNews(6) + WX(7) 来源");
{
  const srcRows = new Map();
  const startedAt = new Date().toISOString();
  let read = 0;
  for (const rel of ["game-news/game-news-hub.sqlite", "wx-news-wiki/wx-news-wiki.sqlite"]) {
    const { db, tmp } = openCopy(rel);
    for (const r of db.prepare("SELECT * FROM sources").all()) {
      read++;
      const prev = srcRows.get(r.id);
      if (!prev) srcRows.set(r.id, { ...r });
      else {
        // 合并 urls，取较新的 updated_at
        try {
          const a = new Set(JSON.parse(prev.urls_json || "[]"));
          JSON.parse(r.urls_json || "[]").forEach((u) => a.add(u));
          prev.urls_json = JSON.stringify([...a]);
        } catch {}
        prev.updated_at = prev.updated_at > r.updated_at ? prev.updated_at : r.updated_at;
        if (!prev.name && r.name) prev.name = r.name;
      }
    }
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  report.sources = { read, written: srcRows.size, skipped: 0, conflict: 0, duplicate: read - srcRows.size, startedAt };
  if (!DRY) {
    const rows = [...srcRows.values()].map((r) => [r.id, r.name, r.category, r.urls_json, r.access_policy, r.detail_policy, r.enabled, r.created_at, r.updated_at]);
    insertOrIgnore(db, "sources", ["id", "name", "category", "urls_json", "access_policy", "detail_policy", "enabled", "created_at", "updated_at"], rows);
  }
  logMigration(db, "sources", report.sources);
  console.log("  sources 目标行数:", srcRows.size);
}

// 2. 文章（GameNews.articles + WX.crawler_records）
section("articles", "GameNews.articles(279) + WX.crawler_records(710)");
{
  const startedAt = new Date().toISOString();
  const stats = { read: 0, written: 0, skipped: 0, conflict: 0, duplicate: 0, detail: {} };
  const rows = [];
  for (const [sys, rel, table, idPrefix, extra] of [
    ["game-news", "game-news/game-news-hub.sqlite", "articles", "gn", null],
    ["wx-news-wiki", "wx-news-wiki/wx-news-wiki.sqlite", "crawler_records", "wx", (r) => ({ status: r.status || r.record_type })],
  ]) {
    const { db, tmp } = openCopy(rel);
    const all = db.prepare(`SELECT * FROM ${table}`).all();
    stats.read += all.length;
    for (const r of all) {
      const legacy = r.id;
      const id = `${idPrefix}:${legacy}`;
      rows.push([
        id, legacy, sys, r.source_id, r.source_name ?? null,
        r.title ?? "", r.game_name, r.category || "新游上线", r.detail_url ?? r.url, r.image_url,
        r.date_text, r.score ?? 50, extra ? extra(r).status : r.status,
        r.quality ?? (r.record_type ? (r.record_type === "detail" ? "ok" : "pending") : null),
        r.paragraphs ?? null, r.facts ?? null, r.images_json ?? null,
        r.payload ?? null, r.game_match ?? null, r.diagnostic ?? null,
        r.review_status ?? "pending", null, r.ai_summary ?? null,
        r.selected_for_brief ?? 0, r.reviewed_at ?? null,
        r.discovered_at ?? r.created_at, r.updated_at ?? r.created_at, BATCH,
      ]);
    }
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  stats.written = rows.length;
  if (!DRY) insertOrIgnore(db, "articles",
    ["id", "legacy_id", "source_system", "source_id", "source_name", "title", "game_name",
     "category", "detail_url", "image_url", "date_text", "score", "status", "quality",
     "paragraphs_json", "facts_json", "images_json", "payload_json", "game_match",
     "diagnostic_json", "review_status", "review_notes", "ai_summary", "selected_for_brief",
     "reviewed_at", "discovered_at", "updated_at", "imported_batch"], rows);
  report.articles = stats;
  logMigration(db, "articles", stats);
  console.log("  articles 目标行数:", rows.length);

  // 2b. 事件派生（从 articles 中有 game_name 的记录派生，保留来源链接，可追溯）
  // 文章行索引: 0 id,1 legacy,2 sys,3 source_id,4 source_name,5 title,6 game_name,7 category,
  //             8 detail_url,9 image_url,10 date_text,22 ai_summary,25 discovered_at,26 updated_at
  const eventRows = rows
    .filter((r) => r[6]) // game_name 非空
    .map((r) => [
      `ev:${r[0]}`, null, r[5], r[7], r[10] || null, null, r[0], r[8], null,
      r[2], r[25] || r[22], r[26] || r[22], BATCH,
    ]);
  const eventStats = { read: rows.length, written: eventRows.length, skipped: 0, conflict: 0, duplicate: 0, detail: { derived_from_articles: rows.length } };
  if (!DRY) insertOrIgnore(db, "events",
    ["id", "game_id", "title", "event_type", "started_at", "ended_at", "source_article_id",
     "source_url", "description", "source_system", "created_at", "updated_at", "imported_batch"],
    eventRows);
  report.events = eventStats;
  logMigration(db, "events", eventStats);
  console.log("  events 目标行数:", eventRows.length);
}

// 3. 草稿（WX.drafts）
section("editorial_drafts", "WX.drafts(32)");
{
  const { db: srcDb, tmp } = openCopy("wx-news-wiki/wx-news-wiki.sqlite");
  const all = srcDb.prepare("SELECT * FROM drafts").all();
  const rows = all.map((r) => [
    `wx-draft:${r.id}`, r.id, "wx-news-wiki", r.title, r.status, r.template_id, r.payload, r.created_at, r.updated_at,
  ]);
  const stats = { read: all.length, written: rows.length, skipped: 0, conflict: 0, duplicate: 0 };
  if (!DRY) insertOrIgnore(db, "editorial_drafts", ["id", "legacy_id", "source_system", "title", "status", "template_id", "payload_json", "created_at", "updated_at"], rows);
  report.editorial_drafts = stats;
  srcDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  logMigration(db, "editorial_drafts", stats);
  console.log("  editorial_drafts 目标行数:", rows.length);
}

// 4. 简讯（GameNews.briefs + WX.briefs）
section("briefs", "GameNews.briefs(33) + WX.briefs(0)");
{
  const rows = [];
  for (const [sys, rel, prefix] of [
    ["game-news", "game-news/game-news-hub.sqlite", "gn"],
    ["wx-news-wiki", "wx-news-wiki/wx-news-wiki.sqlite", "wx"],
  ]) {
    const { db, tmp } = openCopy(rel);
    const all = db.prepare("SELECT * FROM briefs").all();
    for (const r of all) {
      rows.push([
        `${prefix}:${r.id}`, r.id, sys, r.title, r.style, r.max_length, r.lead, r.template_id,
        r.total_characters, r.reading_minutes, r.sections_json, r.source_notes,
        r.status, r.slot ?? "daily", r.published_at ?? null, r.created_at, r.updated_at,
      ]);
    }
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const stats = { read: rows.length, written: rows.length, skipped: 0, conflict: 0, duplicate: 0 };
  if (!DRY) insertOrIgnore(db, "briefs",
    ["id", "legacy_id", "source_system", "title", "style", "max_length", "lead", "template_id",
     "total_characters", "reading_minutes", "sections_json", "source_notes_json", "status",
     "slot", "published_at", "created_at", "updated_at"], rows);
  report.briefs = stats;
  logMigration(db, "briefs", stats);
  console.log("  briefs 目标行数:", rows.length);
}

// 5. Steam 三源
section("steam", "WorkBuddy 三源数据包");
{
  const wb = JSON.parse(fs.readFileSync(WB_JSON, "utf8"));
  const s3 = wb["③Steam源(近一年·60款)"] || [];
  const s1 = wb["①搜索关键词源"] || [];
  const s2 = wb["②鲸云源"] || [];
  const s4 = wb["④三源关联重点表"] || [];

  const games = [];
  const snapshots = [];
  const aliases = [];
  const metrics = [];

  const now = new Date().toISOString();
  const HIST = "history";
  const DEMO = "demo";

  // ③ → games / snapshots / aliases
  for (const g of s3) {
    const appid = Number(g["appid"]);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    games.push([appid, g["中文名称"] || null, g["游戏名称(原名)"] || null, g["开发者"] || null,
      g["玩法标签"] || null, g["发行日期"] || null, g["安装大小"] || null,
      g["独立游戏"] === "是" ? 1 : 0, g["最低配置"] || null, g["推荐配置"] || null, now, now, BATCH]);
    const cur = String(g["当前在线(8/25)"] || "").replace(/,/g, "");
    const peak = String(g["近一年峰值"] || "").replace(/,/g, "");
    const peakDate = g["峰值日期"] || "2026-08-25";
    const relDate = g["发行日期"] || "2026-08-25";
    // 快照：当前在线(口径8/25) + 近一年峰值(口径峰值日期)
    if (cur) snapshots.push([appid, "2026-08-25", "workbuddy-history", "current_online", cur, JSON.stringify(g), HIST]);
    if (peak) snapshots.push([appid, peakDate || "2026-08-25", "workbuddy-history", "peak_online", peak, JSON.stringify(g), HIST]);
    if (g["中文名称"]) aliases.push([appid, g["中文名称"], "cn"]);
    if (g["游戏名称(原名)"]) aliases.push([appid, g["游戏名称(原名)"], "en"]);
    void relDate;
  }

  // ① → steam_source_metrics (search, demo)
  for (const r of s1) {
    metrics.push([null, r["端游名称(中文)"] || null, "search", "总搜索次数(7-8月)", r["总搜索次数(7-8月)"] || null,
      JSON.stringify(r), "2026-08-25", DEMO, "workbuddy"]);
    metrics.push([null, r["端游名称(中文)"] || null, "search", "7月搜索", r["7月搜索"] || null, null, "2026-08-25", DEMO, "workbuddy"]);
    metrics.push([null, r["端游名称(中文)"] || null, "search", "8月搜索", r["8月搜索"] || null, null, "2026-08-25", DEMO, "workbuddy"]);
    metrics.push([null, r["端游名称(中文)"] || null, "search", "8月相对增长", r["8月相对增长"] || null, null, "2026-08-25", DEMO, "workbuddy"]);
    metrics.push([null, r["端游名称(中文)"] || null, "search", "相关性", r["相关性"] || null, null, "2026-08-25", DEMO, "workbuddy"]);
    aliases.push([null, r["端游名称(中文)"] || "", "search"]);
  }

  // ② → steam_source_metrics (jingyun, history)
  for (const r of s2) {
    const appid = String(r["appid"] || "").trim() === "—" || !r["appid"] ? null : Number(r["appid"]);
    metrics.push([appid, r["鲸云游戏名称"] || null, "jingyun", "游玩人数", String(r["游玩人数"] || "").replace(/,/g, ""), JSON.stringify(r), "2026-08-25", HIST, "workbuddy"]);
    metrics.push([appid, r["鲸云游戏名称"] || null, "jingyun", "注册人数", String(r["注册人数"] || "").replace(/,/g, ""), null, "2026-08-25", HIST, "workbuddy"]);
    if (r["鲸云游戏名称"]) aliases.push([appid, r["鲸云游戏名称"], "jingyun"]);
  }

  // ④ → games(补齐) / snapshots / aliases
  for (const r of s4) {
    const appid = Number(r["appid"]);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    games.push([appid, r["游戏"] || null, r["游戏"] || null, null,
      r["玩法标签"] || null, r["发行日期"] || null, r["安装大小"] || null,
      r["独立游戏"] === "是" ? 1 : 0, r["最低配置"] || null, r["推荐配置"] || null, now, now, BATCH]);
    const peak = String(r["历史峰值"] || "").replace(/,/g, "");
    if (peak) snapshots.push([appid, "2026-08-25", "workbuddy-history", "peak_online", peak, JSON.stringify(r), HIST]);
    if (r["游戏"]) aliases.push([appid, r["游戏"], "cn"]);
  }

  const stats = {
    read: s3.length + s1.length + s2.length + s4.length,
    written: 0, skipped: 0, conflict: 0, duplicate: 0,
    detail: { games: games.length, snapshots: snapshots.length, aliases: aliases.length, metrics: metrics.length },
  };
  if (!DRY) {
    // games 用 upsert（③④可能同一 appid，④做补齐）
    const gStmt = db.prepare(
      `INSERT INTO games (appid, cn_name, name, developer, tags, release_date, installed_size, is_indie, min_config, recommended_config, first_seen_at, updated_at, imported_batch)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(appid) DO UPDATE SET
         cn_name=COALESCE(excluded.cn_name, games.cn_name),
         name=COALESCE(excluded.name, games.name),
         tags=COALESCE(excluded.tags, games.tags),
         release_date=COALESCE(excluded.release_date, games.release_date),
         installed_size=COALESCE(excluded.installed_size, games.installed_size),
         is_indie=COALESCE(excluded.is_indie, games.is_indie),
         min_config=COALESCE(excluded.min_config, games.min_config),
         recommended_config=COALESCE(excluded.recommended_config, games.recommended_config),
         developer=COALESCE(excluded.developer, games.developer),
         updated_at=excluded.updated_at,
         imported_batch=COALESCE(excluded.imported_batch, games.imported_batch)`
    );
    db.exec("BEGIN");
    try {
      for (const r of games) {
        const args = r.map((v) => (v === undefined ? null : v));
        gStmt.run(...args);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    insertOrIgnore(db, "steam_snapshots", ["appid", "snapshot_at", "snapshot_source", "metric_name", "metric_value", "raw_json", "data_grade"], snapshots);
    insertOrIgnore(db, "game_aliases", ["appid", "alias", "alias_type"], aliases);
    insertOrIgnore(db, "steam_source_metrics", ["appid", "game_name", "source_kind", "metric_name", "metric_value", "extra_json", "snapshot_at", "data_grade", "source_system"], metrics);
  }
  report.steam = stats;
  logMigration(db, "steam", stats);
  console.log("  games 目标行数:", games.length, "/ snapshots:", snapshots.length, "/ aliases:", aliases.length, "/ metrics:", metrics.length);
}

// ---------- 汇总 ----------
console.log("\n========== 迁移汇总 ==========");
if (DRY) console.log("模式: DRY-RUN（未写入任何数据）");
else console.log("模式: 实际写入（幂等）");
for (const [k, v] of Object.entries(report)) {
  console.log(`  ${k}: read=${v.read} written=${v.written} skipped=${v.skipped} conflict=${v.conflict} duplicate=${v.duplicate}`);
}
console.log("\n目标库:", DB_PATH);
if (db) db.close();
