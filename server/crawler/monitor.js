import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const historyFile = path.join(root, "data", "crawler", "monitor-history.json");

function readHistory() {
  try {
    const value = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    return Array.isArray(value) ? value.slice(-20) : [];
  } catch {
    return [];
  }
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

export function finishMonitor(patch = {}, message = "任务完成") {
  Object.assign(state, patch, {
    active: false,
    finishedAt: new Date().toISOString(),
  });
  state.stage = patch.stage || "completed";
  addEvent(message, patch);
  state.history = [
    ...state.history,
    {
      operation: state.operation,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      stage: state.stage,
      error: state.error,
      sourceProgress: state.sourceProgress,
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
    history: state.history.map((item) => ({
      operation: item.operation,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      stage: item.stage,
      error: item.error,
      sourceProgress: Array.isArray(item.sourceProgress) ? item.sourceProgress.map((progress) => ({ ...progress })) : [],
    })),
    raw: summarizeRaw(state.raw),
  };
}
