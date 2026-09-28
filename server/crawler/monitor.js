import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const historyFile = path.join(root, "data", "crawler", "monitor-history.json");
const zeroStreakFile = path.join(root, "data", "crawler", "zero-streak.json");

/**
 * 「整源静默 0 条」连击阈值。
 * 阈值来自本机 monitor-history.json 实测校准：健康源（好游快爆/游民星空/机核/Steam）
 * 的 completed 且 count=0 从未连续出现 3 次，而 TapTap 改版事故期多个 urlType
 * 连续 3~4 轮为 0 且 error 为空。因此单轮 0 条按正常处理（当日无新内容或全部命中去重），
 * 连续 3 轮才升级为告警。
 */
const ZERO_STREAK_THRESHOLD = 3;

function readHistory() {
  try {
    const value = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    return Array.isArray(value) ? value.slice(-20) : [];
  } catch {
    return [];
  }
}

function readZeroStreak() {
  try {
    const value = JSON.parse(fs.readFileSync(zeroStreakFile, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeZeroStreak(map) {
  try {
    fs.mkdirSync(path.dirname(zeroStreakFile), { recursive: true });
    fs.writeFileSync(zeroStreakFile, JSON.stringify(map, null, 2));
  } catch {
    // 连击状态写不进去不能影响抓取本身。
  }
}

/**
 * 把「完成但 0 条且无报错」累积成连击，达到阈值即产出告警。
 * 抓取失败（status=failed）本身就带 error，属于响亮失败，直接清连击；
 * 拿到数据（count>0）说明来源健康，同样清连击。
 */
function evaluateSilentSources() {
  const streaks = readZeroStreak();
  const alerts = [];
  for (const item of state.sourceProgress) {
    if (!item.key) continue;
    if (item.status !== "completed" || Number(item.count || 0) > 0) {
      delete streaks[item.key];
      continue;
    }
    const prev = streaks[item.key];
    const streak = Number(prev?.streak || 0) + 1;
    streaks[item.key] = {
      streak,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      urlType: item.urlType,
      since: prev?.since || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (streak >= ZERO_STREAK_THRESHOLD) {
      alerts.push({
        level: "warn",
        code: "SOURCE_SILENT_ZERO",
        sourceId: item.sourceId,
        sourceName: item.sourceName,
        urlType: item.urlType,
        streak,
        since: streaks[item.key].since,
        message: `${item.sourceName} · ${item.urlType} 已连续 ${streak} 轮 0 条且无报错，疑似改版/接口下线导致的静默失效`,
      });
    }
  }
  writeZeroStreak(streaks);
  return alerts;
}

/** 供定时流水线判断监控是否已被手动抓取占用。 */
export function isMonitorBusy() {
  return state.active;
}

const state = {
  active: false,
  operation: null,
  stage: "idle",
  startedAt: null,
  finishedAt: null,
  currentSource: null,
  sourceIds: [],
  results: [],
  error: null,
  events: [],
  sourceProgress: [],
  history: readHistory(),
  details: null,
  raw: null,
  alerts: [],
};

function compactExtra(extra = {}) {
  const { stage, sourceId, sourceName, urlType, status, count, error, currentSource } = extra;
  return Object.fromEntries(
    Object.entries({ stage, sourceId, sourceName, urlType, status, count, error, currentSource })
      .filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function addEvent(message, extra = {}) {
  state.events = [
    ...state.events,
    { time: new Date().toISOString(), message, ...compactExtra(extra) },
  ].slice(-80);
}

export function beginMonitor(operation, meta = {}) {
  state.active = true;
  state.operation = operation;
  state.stage = meta.stage || "starting";
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.currentSource = null;
  state.sourceIds = meta.sourceIds || [];
  state.results = [];
  state.error = null;
  state.sourceProgress = [];
  state.details = null;
  state.raw = null;
  state.alerts = [];
  addEvent(`${operation} 开始`, { stage: state.stage });
}

export function updateMonitor(patch = {}, message = "") {
  Object.assign(state, patch);
  if (message) addEvent(message, patch);
}

export function reportSourceProgress(progress = {}) {
  const timestamp = new Date().toISOString();
  const key = `${progress.sourceId || "unknown"}:${progress.urlType || "default"}`;
  const next = {
    key,
    sourceId: progress.sourceId || "unknown",
    sourceName: progress.sourceName || progress.sourceId || "未知来源",
    urlType: progress.urlType || "default",
    status: progress.status || "queued",
    count: Number(progress.count || 0),
    error: progress.error || "",
    updatedAt: timestamp,
  };
  const index = state.sourceProgress.findIndex((item) => item.key === key);
  if (index >= 0)
    state.sourceProgress[index] = { ...state.sourceProgress[index], ...next };
  else state.sourceProgress.push(next);
  state.currentSource = next.sourceName;
  addEvent(
    `${next.sourceName} · ${next.urlType} ${next.status === "running" ? "抓取中" : next.status === "failed" ? "失败" : "完成"}${next.status === "completed" ? `，${next.count} 条` : ""}`,
    { stage: next.status, sourceId: next.sourceId, urlType: next.urlType },
  );
}

function persistHistory() {
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(
      historyFile,
      JSON.stringify(state.history.slice(-20), null, 2),
    );
  } catch {
    // 监控历史写入失败不能影响实际抓取。
  }
}

/** 从连击文件派生的「当前仍处于静默失效」清单，空闲期也能看到。 */
export function standingAlerts() {
  const streaks = readZeroStreak();
  return Object.values(streaks)
    .filter((entry) => Number(entry?.streak || 0) >= ZERO_STREAK_THRESHOLD)
    .map((entry) => ({
      level: "warn",
      code: "SOURCE_SILENT_ZERO",
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      urlType: entry.urlType,
      streak: Number(entry.streak),
      since: entry.since || null,
      updatedAt: entry.updatedAt || null,
      message: `${entry.sourceName} · ${entry.urlType} 已连续 ${entry.streak} 轮 0 条且无报错，疑似改版/接口下线导致的静默失效`,
    }))
    .sort((a, b) => (b.streak || 0) - (a.streak || 0));
}

export function finishMonitor(patch = {}, message = "任务完成") {
  Object.assign(state, patch, {
    active: false,
    finishedAt: new Date().toISOString(),
  });
  state.stage = patch.stage || "completed";
  addEvent(message, patch);
  // 静默失效检测放在收尾：只有跑完一轮才能判断「完成但 0 条」的连击。
  state.alerts = evaluateSilentSources();
  for (const alert of state.alerts) {
    addEvent(`⚠️ ${alert.message}`, { stage: "alert", sourceId: alert.sourceId, urlType: alert.urlType });
  }
  state.history = [
    ...state.history,
    {
      operation: state.operation,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      stage: state.stage,
      error: state.error,
      sourceProgress: state.sourceProgress,
      alerts: state.alerts.map((alert) => ({ ...alert })),
    },
  ].slice(-20);
  persistHistory();
}

function summarizeResult(value) {
  if (Array.isArray(value)) return value.map(summarizeResult).filter(Boolean);
  if (!value || typeof value !== "object") return value ?? null;
  return {
    sourceId: value.sourceId || value.source_id || null,
    sourceName: value.sourceName || value.source_name || null,
    urlType: value.urlType || null,
    count: Number(value.count || value.total || value.candidateCount || 0),
    successCount: Number(value.successCount || value.success || 0),
    failCount: Number(value.failCount || value.failed || 0),
    error: value.error || "",
  };
}

function summarizeRaw(value) {
  if (!value || typeof value !== "object") return null;
  return {
    generatedAt: value.generatedAt || null,
    total: Number(value.total || 0),
    hidden: Number(value.hidden || 0),
    output: value.output || "",
    error: value.error || "",
    archive: value.archive
      ? { created: Boolean(value.archive.created), date: value.archive.date || null }
      : null,
  };
}

/** 监控接口只输出摘要，避免把全文、图片和候选列表重复传给轮询页面。 */
export function getMonitorState() {
  return {
    active: state.active,
    operation: state.operation,
    stage: state.stage,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    currentSource: state.currentSource,
    sourceIds: [...state.sourceIds],
    results: summarizeResult(state.results),
    details: summarizeResult(state.details?.perPlatform || state.details),
    error: state.error,
    events: state.events.map((event) => ({ time: event.time, message: event.message, ...compactExtra(event) })),
    sourceProgress: state.sourceProgress.map((item) => ({ ...item })),
    alerts: standingAlerts(),
    runAlerts: state.alerts.map((alert) => ({ ...alert })),
    history: state.history.map((item) => ({
      operation: item.operation,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      stage: item.stage,
      error: item.error,
      sourceProgress: Array.isArray(item.sourceProgress) ? item.sourceProgress.map((progress) => ({ ...progress })) : [],
      alerts: Array.isArray(item.alerts) ? item.alerts.map((alert) => ({ ...alert })) : [],
    })),
    raw: summarizeRaw(state.raw),
  };
}
