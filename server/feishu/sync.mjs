// 飞书同步管线（P5）：1 张事件表 + 1 张评级表 + 2 个视图。
// 每轮：校验表/视图 → 拉飞书评级回写 SQLite（分级）→ 事件去重/评级 → 兼容匹配审计 → 增量同步 → S/A 提醒。
// 只新增/更新"今日及未来"事件；历史不删除、不重排、不覆盖人工评级。
// 用法: node server/feishu/sync.mjs [--dry-run(默认)] [--stage] [--no-notify]
import {
  monitorConfig, tenantAccessToken, listTables, listViews, getView, listRecords,
  batchCreateRecords, batchUpdateRecords,
} from "./client.mjs";
import {
  ensureRatingsSchema, upsertRating, getRatingByGame, getRatingSource,
  SOURCE_MANUAL, SOURCE_LEGACY, SOURCE_AUTO,
} from "./rating-store.mjs";
import {
  toMonitorEvent, eventKey, sameNewGameEvent, sameActivityEvent, sourcePriority,
  ratingFor, normalize, cleanGameName, eventTitlesOverlap, eventDateKey,
} from "./algorithm.mjs";
import { sendSAAlerts } from "./notifier.mjs";
import { ensureNotificationAuditSchema, queueAlertNotifications, pendingAlertNotifications, recordAlertAttempt } from "./audit-store.mjs";

const DAY = 86400000;
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }

// ---------- 表/视图校验（启动时只读；不通过则任务失败不写入） ----------
export async function validateLayout(cfg) {
  const token = await tenantAccessToken(cfg.appId, cfg.appSecret);
  const tables = await listTables(token, cfg.appToken);
  const table = tables.find((t) => t.table_id === cfg.tableId);
  const ratingTable = tables.find((t) => t.table_id === cfg.ratingTableId);
  if (!table) throw new Error(`主数据表不存在: ${cfg.tableId}（Base 内查无此表）`);
  if (!ratingTable) throw new Error(`游戏评级表不存在: ${cfg.ratingTableId}`);
  const views = await listViews(token, cfg.appToken, cfg.tableId);
  const pickView = async (name) => {
    const v = views.find((x) => String(x.view_name || x.name || "").includes(name));
    if (!v) return null;
    try { return await getView(token, cfg.appToken, cfg.tableId, v.view_id); } catch { return v; }
  };
  const newGameView = await pickView("新游");
  const activityView = await pickView("活动");
  if (!newGameView) throw new Error("缺少名为「新游」的视图");
  if (!activityView) throw new Error("缺少名为「活动」的视图");
  const typeFilter = (view) => {
    const cond = (view.filter_info?.conditions || []).find((c) => c.field_name === "类型");
    return cond ? String(cond.value || "") : "";
  };
  const ngFilter = typeFilter(newGameView);
  const acFilter = typeFilter(activityView);
  if (ngFilter && !ngFilter.includes("新游")) throw new Error(`新游视图筛选不正确（当前筛选: ${ngFilter}）`);
  if (acFilter && !acFilter.includes("活动")) throw new Error(`活动视图筛选不正确（当前筛选: ${acFilter}）`);
  return { token, table, ratingTable, newGameView, activityView };
}

// ---------- 飞书人工评级回写 SQLite（分级：首次 legacy_reference，变化 manual） ----------
export async function pullRatings(db, cfg, { dryRun = false, token } = {}) {
  const tok = token || await tenantAccessToken(cfg.appId, cfg.appSecret);
  const items = [];
  let pageToken = "";
  do {
    const r = await listRecords(tok, cfg.appToken, cfg.ratingTableId, { pageSize: 500, pageToken });
    items.push(...r.items);
    pageToken = r.pageToken;
  } while (pageToken);
  let writtenLegacy = 0, writtenManual = 0, unchanged = 0, skipped = 0;
  for (const rec of items) {
    const f = rec.fields || {};
    const gameName = cleanGameName(f["游戏名"] || f["标准游戏名"] || "");
    const grade = String(f["评级"] || f["rating"] || "").trim();
    if (!gameName || !/^(?:S|A|B|C)/u.test(grade)) { skipped += 1; continue; }
    const key = normalize(gameName);
    if (dryRun) { writtenLegacy += 1; continue; }
    const legacy = getRatingSource(db, "game", key, SOURCE_LEGACY);
    if (!legacy) {
      // 首次观测 → legacy_reference（旧评级可能是自动，不能当人工）
      upsertRating(db, { refType: "game", refId: key, rating: grade, score: gradeScore(grade), gameName, source: SOURCE_LEGACY, feishuRecordId: rec.record_id, lastSeenGrade: grade, lastSeenAt: new Date().toISOString() });
      writtenLegacy += 1;
    } else if (legacy.last_seen_grade !== grade) {
      // 与上次观测不同 → 飞书人工修改 → manual
      upsertRating(db, { refType: "game", refId: key, rating: grade, score: gradeScore(grade), gameName, source: SOURCE_MANUAL, feishuRecordId: rec.record_id, lastSeenGrade: grade, lastSeenAt: new Date().toISOString() });
      // 同步更新 legacy 记录的 last_seen（保持观测一致）
      upsertRating(db, { refType: "game", refId: key, rating: legacy.rating, score: legacy.score, gameName, source: SOURCE_LEGACY, feishuRecordId: rec.record_id, lastSeenGrade: grade, lastSeenAt: new Date().toISOString() });
      writtenManual += 1;
    } else {
      unchanged += 1;
    }
  }
  return { read: items.length, writtenLegacy, writtenManual, unchanged, skipped };
}
function gradeScore(label) { return /^S/u.test(label) ? 80 : /^A/u.test(label) ? 60 : /^B/u.test(label) ? 45 : 0; }

// ---------- 事件构建：articles → 事件 → 跨平台去重 → 评级 ----------
export function buildEvents(db, { windowDays = 3 } = {}) {
  const since = new Date(Date.now() - windowDays * DAY).toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT id, source_id, source_name, title, game_name, category, detail_url, image_url, date_text, score, quality, discovered_at, paragraphs_json, facts_json
     FROM articles WHERE substr(discovered_at,1,10) >= ? AND quality='ok'`
  ).all(since);
  const today = startOfDay(new Date());
  const events = rows.map(toMonitorEvent).filter((e) => e && e.time >= today); // 只操作今日及未来
  const groups = [];
  for (const e of events) {
    let placed = false;
    for (const g of groups) {
      if (e.type === "新游" ? sameNewGameEvent(g[0], e) : sameActivityEvent(g[0], e)) { g.push(e); placed = true; break; }
    }
    if (!placed) groups.push([e]);
  }
  return groups.map((members) => {
    const winner = members.slice().sort((a, b) => sourcePriority(b) - sourcePriority(a))[0];
    winner.platformCount = members.length; // 去重前成员数（跨平台覆盖数）；不挂载 members 避免循环引用
    const manual = getRatingByGame(db, normalize(winner.game));
    if (manual) {
      winner.grade = manual.rating;
      winner.ratingScore = manual.score;
      winner.ratingSource = manual.source; // manual / legacy_reference
      winner.ratingReasons = manual.reason_json ? JSON.parse(manual.reason_json) : ["沿用评级"];
    } else {
      const auto = ratingFor(winner);
      winner.grade = auto.label;
      winner.ratingScore = auto.value;
      winner.ratingSource = SOURCE_AUTO;
      winner.ratingReasons = auto.reasons;
    }
    winner.eventKey = eventKey(winner);
    return winner;
  });
}

// ---------- 字段映射（写入主数据表；以飞书实际字段名为准） ----------
export function fieldsFor(e) {
  return {
    "类型": e.type,
    "时间": e.time,
    "游戏名": e.game,
    "标签": (e.tags || []).join("|"),
    "评级": e.grade,
    "评分": Number(e.ratingScore) || 0,
    "厂商": e.publisher || "",
    "平台": e.sourceName || "",
    "评论/预约量": e.reviews == null ? 0 : Number(e.reviews),
    "内容": String(e.content || "").slice(0, 2000),
    "原文链接": e.sourceUrl ? { link: e.sourceUrl, text: "原文" } : "",
    "入库时间": Date.now(),
    "事件ID": e.eventKey,
    "评级来源": e.ratingSource || SOURCE_AUTO,
  };
}

// ---------- 兼容匹配审计（只读，不改飞书） ----------
// 候选（主表已有记录 → 可比较对象）
function rowCandidate(f) {
  const url = String(f["原文链接"]?.link || f["原文链接"] || "");
  const content = String(f["内容"] || "");
  return {
    recordId: "",
    type: String(f["类型"] || "").trim() === "活动" ? "活动" : "新游",
    game: cleanGameName(f["游戏名"] || ""),
    time: Number(f["时间"] || 0),
    dateKey: eventDateKey(f["时间"]),
    title: content.split("\n")[0] || "",
    content,
    sourceUrl: url,
    eventKey: String(f["事件ID"] || ""),
  };
}
const canonicalUrl = (u) => String(u || "").replace(/[?#].*$/, "");

// 兼容判定：标准游戏名 + 类型 + 业务日期 ±2 天 + 标题关键词重叠；原文链接相同直接同事件
function sameEventCompat(candidate, row) {
  if (!candidate.game || !row.game || normalize(candidate.game) !== normalize(row.game)) return false;
  if (candidate.type !== row.type) return false;
  if (canonicalUrl(candidate.sourceUrl) && canonicalUrl(candidate.sourceUrl) === canonicalUrl(row.sourceUrl)) return true;
  const cTs = Number(candidate.time || 0);
  const rTs = Number(row.time || 0);
  if (candidate.type === "活动") {
    if (cTs && rTs) {
      if (Math.abs(startOfDay(cTs) - startOfDay(rTs)) > 2 * DAY) return false;
    } else if (candidate.dateKey && row.dateKey && candidate.dateKey !== row.dateKey) {
      return false;
    }
    return eventTitlesOverlap(candidate.title || candidate.content, row.title || row.content)
      || normalize(candidate.title || "") === normalize(row.title || "");
  }
  return true; // 新游：同游戏实体即同事件
}

// 审计：对每个本地事件找已有记录匹配，分类 + 歧义检测
export function auditExisting(events, existingRows) {
  const rows = existingRows.map((r) => ({ ...rowCandidate(r.fields || {}), recordId: r.record_id }));
  const byEventId = new Map();
  for (const r of rows) if (r.eventKey) { if (!byEventId.has(r.eventKey)) byEventId.set(r.eventKey, []); byEventId.get(r.eventKey).push(r); }
  const stats = { total: rows.length, hasEventId: rows.filter((r) => r.eventKey).length, exact: 0, compat: 0, unmatched: 0, ambiguous: 0, newGame: 0, activity: 0 };
  const result = { safeNew: [], update: [], suspectedDup: [], ambiguous: [], ambiguityList: [] };
  const rowUsedBy = new Map(); // recordId -> count
  for (const e of events) {
    const matches = [];
    // 1) 事件ID 精确
    if (e.eventKey && byEventId.has(e.eventKey)) matches.push(...byEventId.get(e.eventKey));
    // 2) 原文链接相同 / 兼容匹配
    if (!matches.length) {
      for (const r of rows) {
        if (sameEventCompat(e, r)) { matches.push(r); if (matches.length >= 2) break; }
      }
    }
    if (matches.length === 0) {
      result.safeNew.push(e); stats.unmatched += 1;
    } else if (matches.length === 1) {
      const m = matches[0];
      const used = rowUsedBy.get(m.recordId) || 0;
      if (used > 0) {
        // 该记录已被另一事件匹配 → 一对多歧义
        result.ambiguous.push(e); stats.ambiguous += 1;
        result.ambiguityList.push({ type: e.type, game: e.game, localEventId: e.eventKey, matchedRecordIds: [m.recordId, ...findRowIds(rows, m)] });
      } else {
        rowUsedBy.set(m.recordId, used + 1);
        if (m.eventKey === e.eventKey || canonicalUrl(m.sourceUrl) === canonicalUrl(e.sourceUrl)) {
          result.update.push({ event: e, record: m }); stats.exact += 1;
        } else {
          result.suspectedDup.push({ event: e, record: m }); stats.compat += 1;
        }
      }
    } else {
      result.ambiguous.push(e); stats.ambiguous += 1;
      result.ambiguityList.push({ type: e.type, game: e.game, localEventId: e.eventKey, matchedRecordIds: matches.map((m) => m.recordId) });
    }
    if (e.type === "新游") stats.newGame += 1; else stats.activity += 1;
  }
  return { stats, ...result };
}
function findRowIds(rows, m) { return rows.filter((r) => r.recordId !== m.recordId && canonicalUrl(r.sourceUrl) === canonicalUrl(m.sourceUrl)).map((r) => r.recordId); }

// ---------- 增量同步主表 ----------
export async function syncFeishu(db, cfg, { dryRun = false, notify = true } = {}) {
  ensureRatingsSchema(db);
  ensureNotificationAuditSchema(db);
  const layout = await validateLayout(cfg);
  const ratingPull = await pullRatings(db, cfg, { dryRun, token: layout.token });
  const events = buildEvents(db);
  // 自动评级落库（source=auto；manual/legacy 已在 pullRatings 写入，upsert 不冲突）
  for (const e of events) {
    if (e.ratingSource === SOURCE_AUTO) {
      upsertRating(db, { refType: "game", refId: normalize(e.game), rating: e.grade, score: e.ratingScore, gameName: e.game, source: SOURCE_AUTO, reasons: e.ratingReasons });
    }
  }
  // 拉主表已有记录 + 兼容匹配审计
  const existing = [];
  let pageToken = "";
  do {
    const r = await listRecords(layout.token, cfg.appToken, cfg.tableId, { pageSize: 500, pageToken });
    existing.push(...r.items);
    pageToken = r.pageToken;
  } while (pageToken);
  const audit = auditExisting(events, existing);
  // 歧义不自动写；safeNew → create；匹配到的旧记录 → 只补空缺字段（空 patch 不算实际更新）
  const toCreate = audit.safeNew.map((e) => ({ fields: fieldsFor(e) }));
  const matchedUpdates = [...audit.update, ...audit.suspectedDup].map(({ event, record }) => {
    const current = (existing.find((r) => r.record_id === record.recordId) || {}).fields || {};
    const fresh = fieldsFor(event);
    const patch = {};
    for (const [k, v] of Object.entries(fresh)) {
      const has = current[k] !== undefined && current[k] !== "" && current[k] !== null;
      if (k === "评级") { if (!has) patch[k] = v; continue; }   // 已有评级（人工/旧）不覆盖
      if (!has) patch[k] = v;                                    // 其余字段只补空缺
    }
    return { record_id: record.recordId, fields: patch };
  });
  const actualUpdates = matchedUpdates.filter((u) => Object.keys(u.fields).length > 0); // 有实际补全的才算更新
  const matchedExisting = matchedUpdates.length;
  let inserted = 0, updated = 0;
  let createdRecords = [], updatedRecords = [];
  if (!dryRun) {
    if (toCreate.length) { createdRecords = await batchCreateRecords(layout.token, cfg.appToken, cfg.tableId, toCreate); inserted = toCreate.length; }
    if (actualUpdates.length) { updatedRecords = await batchUpdateRecords(layout.token, cfg.appToken, cfg.tableId, actualUpdates); updated = actualUpdates.length; }
  }
  // S/A 提醒：本轮新增先入本地待投递队列；发送成功/失败均留审计。
  const alertItems = audit.safeNew.filter((e) => /^(?:S|A)/u.test(e.grade));
  let notification = { sent: false, skipped: true, reason: "dry-run 或未启用通知" };
  const paused = process.env.FEISHU_TOPIC_NOTIFICATIONS_PAUSED === "1";
  let queuedAlerts = 0;
  if (!dryRun) queuedAlerts = queueAlertNotifications(db, alertItems);
  if (notify && !dryRun && !paused) {
    const pending = pendingAlertNotifications(db);
    if (pending.length) {
      const sent = await sendSAAlerts({ items: pending.map((x) => x.item) });
      const byKey = new Map((sent.messages || []).map((x) => [x.eventKey, x]));
      for (const entry of pending) recordAlertAttempt(db, entry.notification, byKey.get(entry.item.eventKey) || { error: "未返回发送结果" });
      notification = { ...sent, queued: queuedAlerts, attempted: pending.length };
    } else notification = { sent: false, skipped: true, reason: "没有待投递 S/A 提醒", queued: queuedAlerts, attempted: 0 };
  }
  return {
    auth: { ok: true },
    layout: { table: layout.table.name, ratingTable: layout.ratingTable.name, newGameView: layout.newGameView.view_name || layout.newGameView.name, activityView: layout.activityView.view_name || layout.activityView.name },
    fieldMap: events[0] ? fieldsFor(events[0]) : {},
    audit,
    inserted, actualUpdated: updated, matchedExisting, skippedAmbiguous: audit.ambiguous.length,
    createdRecords, updatedRecords,
    existingTotal: existing.length, total: events.length,
    ratingPull, alertCount: alertItems.length, queuedAlerts, notification,
  };
}

// CLI：dry-run（默认）只读不写；--stage 真实写入；--no-notify 关闭 S/A 提醒
const isMain = process.argv[1] && process.argv[1].endsWith("sync.mjs");
if (isMain) {
  const argv = process.argv;
  const dryRun = !argv.includes("--stage");
  const notify = !argv.includes("--no-notify");
  const { loadEnv } = await import("../env.mjs");
  loadEnv();
  const cfg = monitorConfig({ required: !dryRun });
  const { openDb } = await import("../tasks/pipeline.mjs");
  const database = openDb();
  try {
    const result = await syncFeishu(database, cfg, { dryRun, notify });
    const s = result.audit.stats;
    const byType = (items, t) => items.filter((x) => (x.type || x.event?.type) === t).length;
    console.log(`鉴权: ${result.auth.ok ? "通过" : "失败"}`);
    console.log(`表/视图校验: 主表=${result.layout.table} | 评级表=${result.layout.ratingTable} | 新游视图=${result.layout.newGameView} | 活动视图=${result.layout.activityView}`);
    console.log(`=== 旧记录兼容匹配审计 ===`);
    console.log(`主表总记录: ${s.total} | 已有事件ID: ${s.hasEventId}`);
    console.log(`事件ID精确匹配: ${s.exact} | 旧记录兼容匹配: ${s.compat} | 无法匹配: ${s.unmatched} | 歧义: ${s.ambiguous}`);
    console.log(`按类型: 新游事件 ${s.newGame} | 活动事件 ${s.activity}`);
    if (dryRun) {
      console.log(`=== 最终判定（dry-run） ===`);
      console.log(`matched_existing: ${result.matchedExisting}`);
      console.log(`actual_updated: ${result.actualUpdated}`);
      console.log(`inserted(将新增): ${result.audit.safeNew.length}`);
      console.log(`skipped_ambiguous: ${result.skippedAmbiguous}`);
      console.log(`评级回写: 读 ${result.ratingPull.read} | 旧评级(legacy_reference) ${result.ratingPull.writtenLegacy} | 人工修改(manual) ${result.ratingPull.writtenManual}`);
      console.log(`S/A 提醒候选: ${result.alertCount}`);
      console.log("模式: DRY-RUN（未写入飞书）");
    } else {
      console.log(`=== 实际写入（--stage） ===`);
      console.log(`退出码: 0`);
      console.log(`matched_existing: ${result.matchedExisting}`);
      console.log(`actual_updated: ${result.actualUpdated}（有字段补全的更新）`);
      console.log(`inserted: ${result.inserted}（新游 ${byType(result.audit.safeNew, "新游")} / 活动 ${byType(result.audit.safeNew, "活动")}）`);
      console.log(`skipped_ambiguous: ${result.skippedAmbiguous}`);
      console.log(`评级写入: legacy_reference ${result.ratingPull.writtenLegacy} / manual ${result.ratingPull.writtenManual} | 通知发送数量: ${result.notification.sent ? (result.notification.messages || []).length : 0}`);
      console.log(`=== 抽样核对（新增/实际更新/歧义各 3） ===`);
      for (const [i, c] of (result.createdRecords || []).slice(0, 3).entries()) {
        console.log(`新增#${i + 1}: ${c.record_id} | 游戏=${c.fields?.["游戏名"]} 类型=${c.fields?.["类型"]} 评级=${c.fields?.["评级"]} 时间=${c.fields?.["时间"]}`);
      }
      for (const [i, u] of (result.updatedRecords || []).slice(0, 3).entries()) {
        console.log(`更新#${i + 1}: ${u.record_id} | 补全字段=${Object.keys(u.fields || {}).join(",") || "(无)"}`);
      }
      for (const a of (result.audit.ambiguityList || []).slice(0, 3)) {
        console.log(`歧义: [${a.type}] ${a.game} -> ${a.matchedRecordIds.join(",")}`);
      }
    }
  } catch (e) {
    console.error(`[feishu-sync] ${e.message}`);
    console.log("提示: 需 .env.local 提供 MONITOR 凭据；若鉴权/表校验失败请核对凭据与 Base 结构");
    process.exit(1);
  } finally {
    database.close();
  }
}
