// GameNewsUnified 调度器（统一任务执行器 + 守护循环）
// 任务定义读取 config.mjs（唯一来源），默认 --no-publish（对外机器人关闭）。
// 用法：
//   node server/tasks/scheduler.mjs --run <id> --now --date YYYY-MM-DD   # 单次执行
//   node server/tasks/scheduler.mjs --list                               # 列出任务
//   node server/tasks/scheduler.mjs [--once] [--interval 30]             # 守护循环（--once 跑完到点任务即退出）
import { openDb, generateDaily, generateWeekly } from "./pipeline.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSteamSnapshot } from "./steam-snapshot.mjs";
import { runSources } from "../crawler/run.mjs";
import { ADAPTERS } from "../crawler/registry.mjs";
import { TASKS } from "./config.mjs";
import { loadEnv, env } from "../env.mjs";
import { syncFeishu } from "../feishu/sync.mjs";
import { renderPosterPng, sendPoster } from "../feishu/poster.mjs";
import { runRetention } from "./retention.mjs";

const SCHED_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// 旧 id 别名（早报/晚报 → 今日简讯海报），兼容早期脚本
const ALIASES = { morning: "daily-brief", evening: "daily-brief", daily: "daily-brief" };

// 飞书同步：仅当 .env.local 配置了 MONITOR 凭据才执行；失败不阻塞采集入库
async function maybeSyncFeishu(db, { notify = true } = {}) {
  loadEnv();
  if (!env("FEISHU_MONITOR_APP_ID") || !env("FEISHU_MONITOR_APP_SECRET")) {
    return { skipped: true, reason: "未配置 FEISHU_MONITOR 凭据（.env.local），跳过飞书同步" };
  }
  try {
    return await syncFeishu(db, {
      appId: env("FEISHU_MONITOR_APP_ID"), appSecret: env("FEISHU_MONITOR_APP_SECRET"),
      appToken: env("FEISHU_MONITOR_APP_TOKEN"), tableId: env("FEISHU_MONITOR_TABLE_ID"),
      ratingTableId: env("FEISHU_MONITOR_RATING_TABLE_ID"),
    }, { dryRun: false, notify });
  } catch (e) {
    return { skipped: true, error: e.message };
  }
}

// 海报 PNG + 飞书发送：PNG 失败不影响 HTML 留档；发送失败不影响生成/归档
async function maybeSendPoster({ htmlPath, date, isWeekly = false, title = "" }) {
  loadEnv();
  const baseUrl = env("POSTER_BASE_URL") || "http://127.0.0.1:64500";
  const pageUrl = `${baseUrl}/output/${pathRel(htmlPath)}`;
  let pngPath = "";
  let pngError = "";
  try { pngPath = await renderPosterPng(htmlPath, { baseUrl }); } catch (e) { pngError = e.message; }
  // 凭据不完整（任一缺失）→ 跳过推送，不让海报任务失败
  if (!env("FEISHU_POSTER_APP_ID") || !env("FEISHU_POSTER_APP_SECRET") || !env("FEISHU_POSTER_CHAT_ID")) {
    return { skipped: true, reason: "FEISHU_POSTER 凭据不完整（.env.local），跳过海报推送", pngPath, pngError, pageUrl };
  }
  const poster = await sendPoster({ pngPath, pageUrl, title, isWeekly });
  return { pngPath, pngError, pageUrl, poster };
}

function pathRel(p) {
  return path.relative(path.join(SCHED_ROOT, "output"), p).split(path.sep).map((s) => encodeURIComponent(s)).join("/");
}

const RUNNERS = {
  monitor: { desc: "每小时监控（8:00-23:00）", fn: async (db, _date, opts = {}) => {
    const runnable = Object.keys(ADAPTERS).filter((k) => ADAPTERS[k].runnable);
    const summary = await runSources(runnable, { runKind: "monitor" });
    // 采集完成后飞书增量同步 + S/A 提醒（失败不阻塞）。
    // 受控重启后的首次 monitor 不发送真实提醒（opts.notify=false）。
    const feishu = await maybeSyncFeishu(db, { notify: opts.notify !== false });
    return { summary, feishu };
  } },
  "daily-brief": { desc: "今日简讯海报（每日 09:30）", fn: async (db, d) => {
    const r = generateDaily(db, d, "morning");
    const poster = await maybeSendPoster({ htmlPath: r.posterFile, date: d, title: `今日游戏简讯 ${d}` });
    return { ...r, poster };
  } },
  weekly: { desc: "游戏资讯周报（周一 09:00，过去 14 天）", fn: async (db, d) => {
    const r = generateWeekly(db, d);
    const poster = await maybeSendPoster({ htmlPath: r.file, date: d, isWeekly: true, title: `游戏资讯周报 ${d}` });
    return { ...r, poster };
  } },
  steam: { desc: "Steam 实时快照（保留 GameNews 采集器）", fn: async (db) => runSteamSnapshot(db) },
  retention: { desc: "轻量留档清理（每日 03:15）", fn: async (db) => runRetention(db, { stage: true, keepDays: 7 }) },
};

function today() { return new Date().toISOString().slice(0, 10); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce(taskId, date = today(), opts = {}) {
  const runName = ALIASES[taskId] || taskId;
  const task = RUNNERS[runName];
  if (!task) return { error: `未知任务: ${runName}` };
  const db = openDb();
  const started = Date.now();
  console.log(`[调度] 开始任务 ${runName} @ ${date}`);
  try {
    const result = await task.fn(db, date, opts);
    console.log(`[调度] 完成 ${runName}:`, JSON.stringify(summarizeResult(runName, result)));
    return { ok: true, result };
  } catch (e) {
    console.error(`[调度] 失败 ${runName}:`, e.message);
    return { ok: false, error: e.message };
  } finally {
    console.log(`[调度] 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    db.close();
  }
}

// 日志收敛：只输出来源状态与飞书统计，不输出完整同步对象/事件正文（导出以便测试）
export function summarizeResult(runName, result = {}) {
  if (runName === "monitor") {
    const sources = (result.summary || []).map((x) => `${x.source}:${x.status}:${x.found ?? 0}/${x.new ?? 0}`);
    const feishu = result.feishu || {};
    return {
      sources,
      feishu: feishu.skipped ? { skipped: true, reason: feishu.reason || feishu.error || "" } : {
        inserted: feishu.inserted || 0, updated: feishu.actualUpdated || 0,
        ambiguous: feishu.skippedAmbiguous || 0, alerts: feishu.alertCount || 0,
        queued: feishu.queuedAlerts || 0, attempted: feishu.notification?.attempted || 0,
        sent: feishu.notification?.sent ? (feishu.notification.messages || []).filter((x) => x.messageId).length : 0,
        failed: feishu.notification?.failed || 0,
      },
    };
  }
  if (runName === "daily-brief" || runName === "weekly") return { file: result.posterFile || result.file || "", poster: result.poster?.skipped ? "skipped" : Boolean(result.poster?.poster?.messageId) ? "sent" : "generated" };
  return { ok: !result?.error };
}

// ---- 守护循环 ----
const lastRun = new Map(); // id -> { ts, dateKey }

// 受控重启：守护启动后 interval 任务不立即执行（先做 lastRun 播种），
// 且首次 monitor 执行不发送飞书提醒，避免重启后立即采集并触发真实消息。
let firstMonitorPending = true;

// 为所有 interval 任务播种 lastRun=启动时刻，使其首个周期内不触发（safe-first）。
export function seedSafeFirst(tasks = TASKS, now = new Date()) {
  const seeded = [];
  for (const t of tasks) {
    if (!t.enabled || !t.intervalMinutes) continue;
    lastRun.set(t.id, { ts: now.getTime(), dateKey: dateKeyOf(now) });
    seeded.push(`${t.id}(${t.intervalMinutes}min)`);
  }
  return seeded;
}

function dateKeyOf(now) {
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}
function weekKeyOf(now) {
  // ISO 周序（简化：距当年 1/1 的天数 / 7），用于周任务每周只跑一次
  const start = new Date(now.getFullYear(), 0, 1);
  return `${now.getFullYear()}-${Math.floor((now - start) / (7 * 86400000))}`;
}
function withinActiveHours(task, now) {
  if (!task.activeHours) return true;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(task.activeHours);
  if (!m) return true; // 配置格式异常时不阻断既有任务
  const current = now.getHours() * 60 + now.getMinutes();
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  return from <= to ? current >= from && current <= to : current >= from || current <= to;
}
function isDue(task, now) {
  if (!withinActiveHours(task, now)) return false;
  if (task.intervalMinutes) {
    const last = lastRun.get(task.id)?.ts;
    if (!last) return true; // 首次立即
    return now.getTime() - last >= task.intervalMinutes * 60000;
  }
  if (task.runAt) {
    if (now.getHours() !== task.runAt.h || now.getMinutes() !== task.runAt.m) return false;
    if (task.runAt.weekday != null) {
      if (now.getDay() !== task.runAt.weekday) return false;
      if (lastRun.get(task.id)?.dateKey === weekKeyOf(now)) return false;
    } else {
      if (lastRun.get(task.id)?.dateKey === dateKeyOf(now)) return false;
    }
    return true;
  }
  return false;
}

async function runLoop({ once = false, intervalSeconds = 30, safeFirst = true } = {}) {
  console.log(`[调度] 守护启动，每 ${intervalSeconds}s 检查（once=${once}${safeFirst ? ", safe-first" : ""}）`);
  if (safeFirst) {
    const seeded = seedSafeFirst();
    if (seeded.length) console.log(`[调度] safe-first 播种（${seeded.join(", ")}）：重启后首个周期不立即采集/提醒`);
  }
  let loop = true;
  while (loop) {
    const now = new Date();
    for (const t of TASKS) {
      if (!t.enabled) continue;
      if (!RUNNERS[t.id]) continue;
      if (!isDue(t, now)) continue;
      lastRun.set(t.id, { ts: now.getTime(), dateKey: t.runAt?.weekday != null ? weekKeyOf(now) : dateKeyOf(now) });
      // 受控重启后的首次 monitor 不通知（opts.notify=false）
      const opts = t.id === "monitor" && firstMonitorPending ? { notify: false } : {};
      if (t.id === "monitor") firstMonitorPending = false;
      try { await runOnce(t.id, undefined, opts); } catch (e) { console.error(`[调度] 执行异常 ${t.id}:`, e.message); }
    }
    if (once) loop = false;
    else await sleep(intervalSeconds * 1000);
  }
  console.log("[调度] 守护退出（once 完成）");
}

async function main() {
  const argv = process.argv;
  const runIdx = argv.indexOf("--run");
  const runName = runIdx >= 0 ? argv[runIdx + 1] : undefined;
  if (argv.includes("--list")) {
    console.log("可用任务（config.mjs）：");
    for (const t of TASKS) console.log(`  ${t.id}: ${t.name}（${t.rate}）`);
    return;
  }
  if (runName) {
    const di = argv.indexOf("--date");
    const dateArg = di >= 0 && argv[di + 1] ? argv[di + 1] : today();
    const r = await runOnce(runName, dateArg);
    if (r.error) process.exit(1);
    return;
  }
  const once = argv.includes("--once");
  const iv = Number(argv[argv.indexOf("--interval") + 1]) || 30;
  const safeFirst = !argv.includes("--no-safe-first");
  await runLoop({ once, intervalSeconds: Math.max(10, iv), safeFirst });
}

// 仅在作为主模块执行时启动守护（可被测试 import，而不启动循环）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { isDue, withinActiveHours };
