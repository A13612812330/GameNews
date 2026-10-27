/**
 * 监控卡死防护的回归闸门（2026-10-27 新增）。
 *
 * 事故：2026-10-23 14:00 那轮监控打完 `Step 1/3` 就再无输出，`crawlCandidates` 里
 * 某个 await 永不返回 ⇒ `monitorRunning` 与 `monitor.state.active` 一直是 true
 * ⇒ 之后每小时只打一行「上一轮监控仍在运行，本轮跳过」，整整 4 天没有整点监控，
 * 而且因为回调从未进入 catch，`cron-result` 里一条失败记录都没有。
 *
 * 本脚本只读源码 + 跑纯函数，不启动服务、不抓取、不写任何生产数据
 * （因此不覆盖 beginMonitor/abandonStaleMonitor 的状态机，那会写 monitor-history.json）。
 *
 * 用法：node scripts/verify-monitor-watchdog.mjs
 *
 * 四组性质（都能用「打坏实现」反向对照）：
 *   1 硬截止    —— withDeadline 超时必 reject，且原 promise 的错误要透传
 *   2 抓取截止  —— Step 1 的 crawlCandidates 必须包在 withDeadline 里
 *   3 看门狗    —— 入口先 releaseStaleMonitorRun()，且有周期检查
 *   4 网络上限  —— firecrawl 有超时+缓存 TTL，curl 子进程有 timeout
 */
import fs from "node:fs";
import path from "node:path";
import { withDeadline } from "../server/scheduler-support.js";
import { monitorRunningFor } from "../server/crawler/monitor.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schedulerSrc = read("server/scheduler.js");
const monitorSrc = read("server/crawler/monitor.js");
const rateLimiterSrc = read("server/crawler/rateLimiter.js");
const fetcherSrc = read("server/crawler/fetcher.js");

let passed = 0;
let failed = 0;
const lines = [];

function assert(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    lines.push(`  [PASS] ${name}`);
  } else {
    failed += 1;
    lines.push(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function readNumber(src, pattern, label) {
  const raw = pattern.exec(src)?.[1];
  if (raw == null) throw new Error(`未能从源码中读出 ${label}`);
  return Number(String(raw).replace(/_/gu, ""));
}

// ── 1. withDeadline 行为 ────────────────────────────────────────────────
{
  lines.push("1. 硬截止工具（永不返回的 await 必须能被脱身）");
  const startedAt = Date.now();
  let code = "";
  try {
    await withDeadline(new Promise(() => {}), 150, "永不返回");
  } catch (error) {
    code = error.code || "";
  }
  assert("永不返回的 promise 会按截止时间 reject", code === "DEADLINE_EXCEEDED", code);
  assert("截止本身不会拖太久", Date.now() - startedAt < 2000, `${Date.now() - startedAt}ms`);

  assert("正常返回时原值原样透传", (await withDeadline(Promise.resolve("ok"), 1000, "正常")) === "ok");

  let propagated = "";
  try {
    await withDeadline(Promise.reject(new Error("原始错误")), 1000, "报错");
  } catch (error) {
    propagated = error.message;
  }
  assert("原 promise 的错误不会被伪装成超时", propagated === "原始错误", propagated);

  assert("空闲时 monitorRunningFor 返回 0（不误判为运行中）", monitorRunningFor() === 0);
}

// ── 2. 抓取步骤的硬截止 ─────────────────────────────────────────────────
{
  lines.push("2. Step 1 抓取必须包在硬截止里");
  assert(
    "crawlCandidates 被 withDeadline 包裹",
    /withDeadline\(\s*crawlCandidates\(/u.test(schedulerSrc),
    "外层没有截止 ⇒ 内层 await 不返回时永远进不了 catch",
  );
  const crawlDeadline = readNumber(schedulerSrc, /const MONITOR_CRAWL_DEADLINE_MS = [^|]+\|\| ([\d_]+) \* 60 \* 1000/u, "MONITOR_CRAWL_DEADLINE_MS");
  const watchdog = readNumber(schedulerSrc, /const MONITOR_RUN_WATCHDOG_MS = [^|]+\|\| ([\d_]+) \* 60 \* 1000/u, "MONITOR_RUN_WATCHDOG_MS");
  assert(`抓取截止 ${crawlDeadline} 分钟 ∈ (0, 15)`, crawlDeadline > 0 && crawlDeadline < 15, String(crawlDeadline));
  assert(`看门狗 ${watchdog} 分钟 > 抓取截止 ${crawlDeadline} 分钟（否则看门狗会先杀掉正常轮次）`, watchdog > crawlDeadline);
}

// ── 3. 看门狗 ───────────────────────────────────────────────────────────
{
  lines.push("3. 看门狗：卡死时强制释放运行标志");
  assert(
    "runMonitorPipeline 入口先调 releaseStaleMonitorRun()",
    /async function runMonitorPipeline[\s\S]{0,200}?releaseStaleMonitorRun\(\)/u.test(schedulerSrc),
    "不先释放的话，标志为 true 时连看门狗都走不到",
  );
  assert("releaseStaleMonitorRun 会释放 monitorRunning 并清零计时", /releaseStaleMonitorRun[\s\S]{0,600}?monitorRunning = false;\s*\n\s*monitorStartedAtMs = 0;/u.test(schedulerSrc));
  assert("卡死时会强制收尾监控状态（否则页面一直显示进行中）", /abandonStaleMonitor\(`本轮超过/u.test(schedulerSrc));
  assert("存在每分钟的周期看门狗", /setInterval\(\(\) => releaseStaleMonitorRun\(\), MONITOR_WATCHDOG_INTERVAL_MS\)/u.test(schedulerSrc));
  assert("正常结束会清零计时（不会误判下一轮）", /finally \{\s*\n\s*monitorRunning = false;\s*\n\s*monitorStartedAtMs = 0;/u.test(schedulerSrc));
  assert("abandonStaleMonitor 只在 active 时收尾（幂等，不覆盖已结束的轮次）", /export function abandonStaleMonitor[\s\S]{0,120}?if \(!state\.active\) return false;/u.test(monitorSrc));
}

// ── 4. 网络层上限 ───────────────────────────────────────────────────────
{
  lines.push("4. 网络层：不许有无上限的 await");
  assert("firecrawl 有硬超时", /FIRECRAWL_TIMEOUT_MS=\s*60_000|const FIRECRAWL_TIMEOUT_MS = 60_000/u.test(rateLimiterSrc));
  assert("firecrawl 用 Promise.race 兜底", /Promise\.race\(\[scrape, timeout\]\)/u.test(rateLimiterSrc));
  assert("firecrawl 缓存带 TTL（不再永久缓存可能永不完成的 promise）", /FIRECRAWL_CACHE_TTL_MS/u.test(rateLimiterSrc) && /Date\.now\(\) - cached\.at < FIRECRAWL_CACHE_TTL_MS/u.test(rateLimiterSrc));
  assert("firecrawl 缓存有上限（防无界增长）", /FIRECRAWL_CACHE_MAX/u.test(rateLimiterSrc) && /urlTasks\.delete\(urlTasks\.keys\(\)\.next\(\)\.value\)/u.test(rateLimiterSrc));
  assert("curl 子进程带 timeout（--max-time 杀不掉进程时不再永久等）", /timeout: 25_000/u.test(fetcherSrc));
}

console.log(lines.join("\n"));
console.log(`── 结果：${passed} 通过 / ${failed} 失败 ──`);
process.exit(failed === 0 ? 0 : 1);
