// 统一评级存储（P5）：ratings 表是唯一最终评级来源。
// source 优先级：manual > legacy_reference > auto
//   - manual：飞书人工修改（后续识别）或本地人工
//   - legacy_reference：首次从飞书评级表迁入的旧评级（可能是旧自动，不能当人工）
//   - auto：统一自动计算
// ai_analyses 仅存解释证据，不参与最终判断。
import { createRatingService } from "../rules/index.mjs";

export const ALGORITHM_VERSION = "feishu-v1";
export const SOURCE_MANUAL = "manual";
export const SOURCE_LEGACY = "legacy_reference";
export const SOURCE_AUTO = "auto";

// 确保 ratings 表含 P5 列（幂等；旧库原地加列）
export function ensureRatingsSchema(db) {
  const cols = new Set(db.prepare("PRAGMA table_info(ratings)").all().map((c) => c.name));
  const adds = [
    ["score", "INTEGER DEFAULT 0"],
    ["game_name", "TEXT"],
    ["reason_json", "TEXT"],
    ["algorithm_version", "TEXT"],
    ["feishu_record_id", "TEXT"],
    ["last_seen_grade", "TEXT"],   // 上次从飞书评级表看到的评级（用于识别人工修改）
    ["last_seen_at", "TEXT"],      // 上次从飞书评级表看到的时间
  ];
  for (const [name, def] of adds) {
    if (!cols.has(name)) db.exec(`ALTER TABLE ratings ADD COLUMN ${name} ${def}`);
  }
}

export function ratingService(db) {
  ensureRatingsSchema(db);
  return createRatingService(db);
}

const PRIORITY_SQL = `ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'legacy_reference' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1`;

// 写入一条评级；source 决定最终优先级。lastSeen 用于记录飞书评级表观测值。
export function upsertRating(db, { refType = "game", refId, rating, score = 0, gameName = "", source = SOURCE_AUTO, reasons = [], algorithmVersion = ALGORITHM_VERSION, feishuRecordId = "", lastSeenGrade = null, lastSeenAt = null }) {
  const label = String(rating || "").trim();
  if (!label || !refId) return null;
  const id = `${refType}:${refId}:${source}`;
  db.prepare(
    `INSERT INTO ratings (id, ref_type, ref_id, rating, score, game_name, source, note, reason_json, algorithm_version, feishu_record_id, last_seen_grade, last_seen_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
     ON CONFLICT(ref_type, ref_id, source) DO UPDATE SET
       rating=excluded.rating, score=excluded.score, game_name=excluded.game_name,
       reason_json=excluded.reason_json, algorithm_version=excluded.algorithm_version,
       feishu_record_id=excluded.feishu_record_id, last_seen_grade=excluded.last_seen_grade,
       last_seen_at=excluded.last_seen_at, updated_at=datetime('now')`
  ).run(id, refType, refId, label, Number(score) || 0, gameName || "", source, null,
    reasons.length ? JSON.stringify(reasons) : null, algorithmVersion || null, feishuRecordId || null,
    lastSeenGrade || null, lastSeenAt || null);
  return getRating(db, refType, refId);
}

// 取最终评级：manual > legacy_reference > auto
export function getRating(db, refType, refId) {
  return db.prepare(`SELECT * FROM ratings WHERE ref_type=? AND ref_id=? ${PRIORITY_SQL}`).get(refType, refId) || null;
}

// 取某游戏最终评级（事件继承用）
export function getRatingByGame(db, gameKey) {
  return getRating(db, "game", gameKey);
}

// 取某游戏特定 source 的评级（供识别人工修改变化）
export function getRatingSource(db, refType, refId, source) {
  return db.prepare(`SELECT * FROM ratings WHERE ref_type=? AND ref_id=? AND source=? LIMIT 1`).get(refType, refId, source) || null;
}
