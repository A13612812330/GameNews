#!/usr/bin/env node
/**
 * 反证：海报投递链路（08:30 日报 / 周一 08:50 周报）的六条硬约束。
 *
 * 背景（2026-09-28 实测）：
 *   - 日报连续失败，耗时正好 180 秒 —— 内层单浏览器 90s × 2 = 180s 与外层
 *     execFile 的 180s 完全相等，外层先把内层杀掉（预算倒挂）。
 *   - 日报与周报共用模块级布尔 posterRunning ⇒ 周报能否发出取决于日报有没有卡住。
 *   - 6190ca4 把裁边换成 Node 实现后，「PNG 裁边成功」这行落到了 stdout，
 *     而父进程要 JSON.parse 整个 stdout ⇒ 日报即使投递成功也会被记成
 *     「海报脚本未返回可识别结果」。这条在没有新日报跑之前一直是隐性的。
 *   - 失败时只留 error.message（就一句 Command failed: <命令>），stdout/stderr 全丢。
 *
 * 本脚本只读源码 + 纯函数断言，不启动服务、不截图、不投递、不碰生产锁。
 * 用法：node scripts/verify-poster-pipeline-hardening.mjs
 *
 * 七组性质（每组都可用「打坏实现」反向对照，绿灯不是因为断言恒真）：
 *   1 超时预算   —— 内层×最坏截图次数 + 固定开销 < 外层   ← 打坏内层或外层任一都会红
 *   2 kind 互斥  —— daily 在跑时 weekly 仍可进入          ← 换回布尔标志就红
 *   3 stdout 契约 —— 子脚本不得往 stdout 写诊断行          ← 把裁边日志改回 console.log 就红
 *   4 解析容错   —— 诊断行在前时仍能取出结果 JSON          ← 去掉兜底解析就红
 *   5 失败诊断   —— stdout/stderr 尾部必须被保留          ← 只留 message 就红
 *   6 调度与锁   —— 周报错开、锁 TTL > 外层超时、含重试的
 *                   日报最坏窗口不越界周报                 ← 改回 08:35/08:50、缩小 TTL 就红
 *   7 渲染防护   —— 不可达图片只占位不改原件、画布触底才加高、
 *                   截图带独立 profile                    ← 见 poster-render-guard.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createKindLock, parsePosterStdout, summarizeProcessFailure } from "../server/scheduler-support.js";
import {
  applyImagePlaceholders,
  buildScreenshotArgs,
  planCanvasHeight,
  probeTargets,
  resolveImageUrl,
} from "../scripts/poster-render-guard.mjs";

const root = path.resolve(import.meta.dirname, "..");
const postersSrc = fs.readFileSync(path.join(root, "scripts", "scheduled-posters.mjs"), "utf8");
const schedulerSrc = fs.readFileSync(path.join(root, "server", "scheduler.js"), "utf8");

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

/** 截出某个函数体（从 `function <name>` 到下一个顶层 function / 注释块）。 */
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start === -1) return "";
  const rest = src.slice(start + 1);
  const nextBoundary = rest.search(/\n(?:export )?(?:async )?function |\n\/\*\*/u);
  return nextBoundary === -1 ? rest : rest.slice(0, nextBoundary);
}

function readNumber(src, pattern, label) {
  const raw = pattern.exec(src)?.[1];
  if (raw == null) throw new Error(`未能从源码中读出 ${label}`);
  return Number(String(raw).replace(/_/gu, ""));
}

/** 读形如 `10 * 60 * 1000` 的乘积表达式并求值。 */
function readProduct(src, pattern, label) {
  const raw = pattern.exec(src)?.[1];
  if (raw == null) throw new Error(`未能从源码中读出 ${label}`);
  return String(raw)
    .split("*")
    .map((part) => Number(part.trim().replace(/_/gu, "")))
    .reduce((acc, value) => {
      if (!Number.isFinite(value)) throw new Error(`${label} 解析失败：${raw}`);
      return acc * value;
    }, 1);
}

// ── 1. 超时预算：内层不能吃掉外层 ──────────────────────────────────────────
{
  lines.push("1. 超时预算不倒挂（2026-09-28 日报 180s 被杀的根因）");
  const posterBody = sliceFunction(postersSrc, "renderPosterPreview");
  const deliveryBody = sliceFunction(schedulerSrc, "runPosterDelivery");
  const inner = readNumber(posterBody, /const RENDER_TIMEOUT_MS = ([\d_]+)/u, "RENDER_TIMEOUT_MS");
  const outer = readNumber(deliveryBody, /timeout:\s*([\d_]+)/u, "runPosterDelivery 外层 timeout");

  // 本机候选浏览器去重后最多同时存在 3 个（Edge 两个安装路径 + Chrome 两个安装路径）。
  const MAX_BROWSERS = 3;
  // 最坏截图次数 = 每个候选浏览器各试一次 + 每次加高重截（重截只复用上一轮成功的那个浏览器，
  // 否则每轮都要把全部浏览器重试一遍、耗时直接翻倍）。
  const canvasRetries = readNumber(postersSrc, /const MAX_CANVAS_RETRIES = (\d+)/u, "MAX_CANVAS_RETRIES");
  const worstCaptures = MAX_BROWSERS + canvasRetries;
  // 子脚本除截图外的固定开销保守上界：
  // waitForServer ≤30s、生成海报、稳定性等待 ≥5s、起公开服务 ≤20s、
  // 探测隧道 ≤7s、新建隧道 ≤30s、裁边自身 60s×2 次 = 120s、飞书上传、
  // 图片可达性探测（58 张实测 0.3s，预算按最坏留足）。
  const CHILD_OVERHEAD_MS = 240_000;

  assert("内层截图超时读到了", Number.isFinite(inner), `inner=${inner}`);
  assert("外层 execFile 超时读到了", Number.isFinite(outer), `outer=${outer}`);
  assert(
    `内层最坏 ${inner}ms × ${worstCaptures} 次(3 候选浏览器 + ${canvasRetries} 次重截) + 固定开销 ${CHILD_OVERHEAD_MS}ms < 外层 ${outer}ms`,
    inner * worstCaptures + CHILD_OVERHEAD_MS < outer,
    `实测 ${inner * worstCaptures + CHILD_OVERHEAD_MS}ms vs ${outer}ms —— 若红灯，外层会先杀掉还在自己预算内的子脚本（旧行为：180 < 180+开销）`,
  );

  // 画布策略必须自洽，否则「加高重截」要么是空操作、要么永远够不到上限。
  const initialCanvas = readNumber(postersSrc, /const INITIAL_CANVAS_HEIGHT = ([\d_]+)/u, "INITIAL_CANVAS_HEIGHT");
  const maxCanvas = readNumber(postersSrc, /const MAX_CANVAS_HEIGHT = ([\d_]+)/u, "MAX_CANVAS_HEIGHT");
  const growth = readNumber(postersSrc, /const CANVAS_GROWTH = ([\d.]+)/u, "CANVAS_GROWTH");
  assert("初始画布 < 上限（否则重截没有空间）", initialCanvas < maxCanvas, `${initialCanvas} / ${maxCanvas}`);
  assert("增长系数 > 1（否则加高是空操作）", growth > 1, String(growth));
  assert(
    `从 ${initialCanvas}px 按 ×${growth} 到达 ${maxCanvas}px 需要 ${canvasRetries} 次以内（否则上限永远够不到）`,
    Math.ceil(Math.log(maxCanvas / initialCanvas) / Math.log(growth)) <= canvasRetries,
    String(Math.ceil(Math.log(maxCanvas / initialCanvas) / Math.log(growth))),
  );
  lines.push("");
}

// ── 2. kind 级互斥 ────────────────────────────────────────────────────────
{
  lines.push("2. 海报互斥粒度是 kind，不是整条链路");
  const lock = createKindLock();
  assert("first daily 占用成功", lock.tryBegin("daily") === true);
  assert("同 kind 重入被拒（防重复投递）", lock.tryBegin("daily") === false);
  assert(
    "daily 在跑时 weekly 仍可进入 ← 旧实现这里会返回 false，周报被静默跳过",
    lock.tryBegin("weekly") === true,
  );
  assert("两个 kind 可同时运行", lock.runningKinds().length === 2, JSON.stringify(lock.runningKinds()));
  lock.end("daily");
  assert("释放后同 kind 可重新占用", lock.tryBegin("daily") === true);
  lock.end("daily");
  lock.end("weekly");
  assert("全部释放后为空", lock.runningKinds().length === 0);
  assert(
    "runPosterDelivery 用的是 kind 锁而非布尔标志",
    /posterKindLock\.tryBegin\(kind\)/u.test(schedulerSrc) && !/let posterRunning = false/u.test(schedulerSrc),
  );
  lines.push("");
}

// ── 3. stdout 契约 ────────────────────────────────────────────────────────
{
  lines.push("3. 子脚本 stdout 只允许结果 JSON（诊断行必须走 stderr）");
  const stdoutLines = postersSrc
    .split(/\r?\n/u)
    .filter((line) => line.includes("console.log("))
    .map((line, index) => `${index}: ${line.trim()}`);
  const offenders = stdoutLines.filter((line) => !line.includes("JSON.stringify"));
  assert(
    `stdout 的 ${stdoutLines.length} 个写入点全部是结果 JSON`,
    offenders.length === 0,
    `污染点 → ${offenders.join(" | ")}`,
  );
  assert(
    "裁边日志已改走 stderr（它就在结果 JSON 之前，最容易被漏掉）",
    /console\.warn\(`\[poster\] PNG 裁边/u.test(postersSrc),
  );
  assert(
    "抢占僵死锁的日志已改走 stderr",
    /console\.warn\(`\[poster-lock\] 清除僵死锁/u.test(postersSrc),
  );
  lines.push("");
}

// ── 4. 父进程解析容错 ─────────────────────────────────────────────────────
{
  lines.push("4. 父进程解析容错（真实污染样本必须能解出来）");
  const polluted = [
    "[poster] PNG 裁边 1100x12000 → 1100x1980（去掉 10020px 空白）",
    "[poster-lock] 清除僵死锁 poster-delivery-daily.lock（pid=36924 startedAt=2026-09-28T00:35:00.270Z）",
    JSON.stringify({ ok: true, kind: "daily", feishu: "sent", target: "E:/x/9.28-今日简讯海报.html" }, null, 2),
  ].join("\n");
  let parsed = null;
  let parseError = null;
  try {
    parsed = parsePosterStdout(polluted);
  } catch (error) {
    parseError = error;
  }
  assert(
    "诊断行在前时仍能取出结果 JSON",
    parsed?.feishu === "sent",
    parseError ? `抛错：${parseError.message}` : JSON.stringify(parsed),
  );
  assert("取到的是最后那段 JSON（不会被前半段日志带偏）", parsed?.kind === "daily");
  let plainOk = false;
  try {
    plainOk = parsePosterStdout('{"ok":true,"skipped":true}').skipped === true;
  } catch {}
  assert("纯一行 JSON 仍可解析", plainOk);
  let threw = false;
  try {
    parsePosterStdout("[poster] 只有日志，没有任何 JSON");
  } catch {
    threw = true;
  }
  assert("没有任何 JSON 时必须报错（不能假装成功）", threw);
  assert(
    "runPosterDelivery 用 parsePosterStdout 而不是裸 JSON.parse(stdout)",
    /parsePosterStdout\(String\(stdout\)\)/u.test(schedulerSrc),
  );
  lines.push("");
}

// ── 5. 失败诊断完整性 ─────────────────────────────────────────────────────
{
  lines.push("5. 失败时保留子进程 stdout/stderr（旧实现只剩一句 Command failed）");
  const fake = Object.assign(new Error("Command failed: node scripts/scheduled-posters.mjs daily"), {
    code: "ETIMEDOUT",
    killed: true,
    signal: "SIGTERM",
    stdout: `${"x".repeat(5000)}TAIL-STDOUT`,
    stderr: "[poster] msedge.exe 截图超时 45s，已终止并尝试下一个浏览器",
  });
  const summary = summarizeProcessFailure(fake);
  assert("保留了 stderr（真正的失败原因在这里）", summary.stderrTail.includes("截图超时"));
  assert("保留了 stdout 尾部", summary.stdoutTail.endsWith("TAIL-STDOUT"), summary.stdoutTail.slice(0, 40));
  assert("stdout 尾部有长度上限（不会把 2MB 灌进日志）", summary.stdoutTail.length <= 1600, `${summary.stdoutTail.length}`);
  assert(
    "保留了 killed / signal / 超时码",
    summary.killed === true && summary.signal === "SIGTERM" && summary.failureCode === "ETIMEDOUT",
    JSON.stringify({ killed: summary.killed, signal: summary.signal, code: summary.failureCode }),
  );
  const deliveryBody = sliceFunction(schedulerSrc, "runPosterDelivery");
  assert(
    "runPosterDelivery 失败分支落盘的是完整诊断",
    /summarizeProcessFailure\(error\)/u.test(deliveryBody) && /\.\.\.lastFailure/u.test(deliveryBody),
    "失败诊断必须来自 summarizeProcessFailure，且以展开方式整体落盘（旧实现只剩一句 message）",
  );
  lines.push("");
}

// ── 6. 调度错开、重试窗口与锁 TTL ─────────────────────────────────────────
{
  lines.push("6. 周报错开「含重试的日报最坏窗口」/ 投递锁 TTL 大于外层超时");
  const weeklyCron = /cron\.schedule\("(\d{1,2}) (\d{1,2}) \* \* 1"[\s\S]{0,600}?runWeeklyBriefAndPoster/u.exec(schedulerSrc);
  assert("周报 cron 读到了", Boolean(weeklyCron), "未匹配到 cron.schedule(... * * 1 ...) → runWeeklyBriefAndPoster");
  const weeklyMinutes = weeklyCron ? Number(weeklyCron[2]) * 60 + Number(weeklyCron[1]) : NaN;
  assert(
    "周报已错开到 09:00（日报加入重试后，原 08:50 不再安全）",
    weeklyMinutes === 9 * 60,
    `实际 ${weeklyCron?.[1]}:${weeklyCron?.[2]}`,
  );
  assert("启动日志文案与实际调度一致（09:00）", schedulerSrc.includes("周一09:00周报"));

  const dailyCron = /cron\.schedule\("(\d{1,2}) (\d{1,2}) \* \* \*"[\s\S]{0,600}?runMorningBriefAndPoster/u.exec(schedulerSrc);
  assert("日报 cron 读到了", Boolean(dailyCron), "未匹配到 cron.schedule(... * * * ...) → runMorningBriefAndPoster");
  const dailyMinutes = dailyCron ? Number(dailyCron[2]) * 60 + Number(dailyCron[1]) : NaN;

  const deliveryBody = sliceFunction(schedulerSrc, "runPosterDelivery");
  const outer = readNumber(deliveryBody, /timeout:\s*([\d_]+)/u, "外层 timeout");
  const attempts = readNumber(schedulerSrc, /const POSTER_ATTEMPTS = (\d+)/u, "POSTER_ATTEMPTS");
  const retryDelay = readNumber(schedulerSrc, /const POSTER_RETRY_DELAY_MS = ([\d_]+)/u, "POSTER_RETRY_DELAY_MS");
  assert("失败后会重试（POSTER_ATTEMPTS > 1）", attempts > 1, String(attempts));
  assert("重试逻辑确实写进了投递循环", /for \(let attempt = 0; attempt < POSTER_ATTEMPTS/u.test(deliveryBody));

  // 关键不变式：日报最坏总时长（每次尝试都跑满外层超时 + 中间的重试间隔）
  // 必须小于「日报 → 周报」的 cron 间隔，否则两者并发抢 Cloudflare 隧道与
  // poster-delivery.json（读-改-写会丢记录）。
  const dailyWorstMs = outer * attempts + retryDelay * Math.max(0, attempts - 1);
  const gapMs = (weeklyMinutes - dailyMinutes) * 60_000;
  assert(
    `日报最坏 ${dailyWorstMs / 60_000} 分钟（${outer}ms × ${attempts} + 间隔 ${retryDelay}ms）< 日报→周报间隔 ${gapMs / 60_000} 分钟`,
    Number.isFinite(gapMs) && dailyWorstMs < gapMs,
    `日报最坏窗口会盖住周报：${dailyMinutes} → ${weeklyMinutes}`,
  );

  const ttl = readProduct(postersSrc, /const DELIVERY_LOCK_TTL_MS = (\d+ \* \d+ \* \d+)/u, "DELIVERY_LOCK_TTL_MS");
  assert(`投递锁 TTL ${ttl}ms > 外层超时 ${outer}ms（不会误抢真实投递的锁）`, ttl > outer);
  lines.push("");
}

// ── 7. 渲染防护（图片占位 + 画布策略 + 截图启动参数） ─────────────────────
{
  lines.push("7. 渲染防护：不可达图片只占位不改原件 / 画布触底才加高 / 截图带独立 profile");
  const base = "http://127.0.0.1:64424";
  const html = [
    '<div>',
    `<img src="${base}/api/image-proxy?url=https%3A%2F%2Fa.com%2F1.png" />`,
    '<img src="data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E" />',
    '<img src="/crawler-assets/x.png" />',
    "</div>",
  ].join("");

  const targets = probeTargets(html, { serverBase: base });
  assert("提取出 2 个待探测地址（内联 data: 不算）", targets.length === 2, JSON.stringify(targets.map((t) => t.resolved)));
  assert("相对路径被解析成本机绝对地址", targets.some((t) => t.resolved === `${base}/crawler-assets/x.png`));
  assert("data: URI 不参与探测", resolveImageUrl("data:image/png;base64,AAA", base) === null);
  assert("空值不参与探测", resolveImageUrl("", base) === null);

  const failing = new URL(`${base}/api/image-proxy?url=https%3A%2F%2Fa.com%2F1.png`).toString();
  const applied = applyImagePlaceholders(html, [failing], { serverBase: base });
  assert("只替换失败的那 1 张", applied.replaced === 1, JSON.stringify(applied));
  // 注意：样例 HTML 里本来就有一张内联 data: URI 的图，所以「html 包含 src="data:image/svg」
  // 会被这张图满足，从而把断言蒙绿 —— 反证用例 ⑩ 就是这么漏报的。
  // 必须取「被标记的那张」自身的 src 才作数。
  const placedSrc = /<img src="([^"]*)" data-poster-placeholder="1"/u.exec(applied.html)?.[1] || "";
  assert("占位图是内联 data URI（不能再产生网络请求）", placedSrc.startsWith("data:image/svg+xml"), placedSrc.slice(0, 80));
  assert("可达的那张保持原样（没被顺手改掉）", applied.html.includes('src="/crawler-assets/x.png"'), applied.html);
  assert("替换处带标记便于排查", applied.html.includes('data-poster-placeholder="1"'));
  const noMatch = applyImagePlaceholders(html, [`${base}/never.png`], { serverBase: base });
  assert("失败地址与实际图片不匹配时不做任何替换", noMatch.replaced === 0 && noMatch.html === html);

  const inside = planCanvasHeight({ canvasHeight: 6000, trimmedHeight: 4063, attempt: 0, maxAttempts: 2, maxCanvasHeight: 24000, growth: 2 });
  assert("内容完整落在画布内 ⇒ 不重截（实测日报约 4063px）", inside.retry === false && inside.height === 6000, JSON.stringify(inside));
  const truncated = planCanvasHeight({ canvasHeight: 6000, trimmedHeight: 6000, attempt: 0, maxAttempts: 2, maxCanvasHeight: 24000, growth: 2 });
  assert("内容触底 ⇒ 加高重截（6000 → 12000）", truncated.retry === true && truncated.height === 12000, JSON.stringify(truncated));
  const nearBottom = planCanvasHeight({ canvasHeight: 6000, trimmedHeight: 5998, attempt: 0, maxAttempts: 2, maxCanvasHeight: 24000, growth: 2 });
  assert("距底在容差内也算触底（抗 PNG 边缘噪声）", nearBottom.retry === true);
  const exhausted = planCanvasHeight({ canvasHeight: 12000, trimmedHeight: 12000, attempt: 2, maxAttempts: 2, maxCanvasHeight: 24000, growth: 2 });
  assert("已达重截上限 ⇒ 停止（不会无限重截）", exhausted.retry === false, JSON.stringify(exhausted));
  const ceiling = planCanvasHeight({ canvasHeight: 24000, trimmedHeight: 24000, attempt: 0, maxAttempts: 2, maxCanvasHeight: 24000, growth: 2 });
  assert("画布已到上限 ⇒ 停止", ceiling.retry === false && ceiling.height === 24000);
  assert("裁边高度异常 ⇒ 不重截（不因脏数据乱截图）", planCanvasHeight({ canvasHeight: 6000, trimmedHeight: Number.NaN }).retry === false);

  const args = buildScreenshotArgs({ previewPath: "C:/x/a.png", height: 6000, pageUrl: "http://127.0.0.1:64424/generated-output/a.html", profileDir: "C:/x/profile" });
  assert("截图带独立 user-data-dir（避免被转交给 GUI 实例 ⇒ 秒退且不落盘）", args.includes("--user-data-dir=C:/x/profile"));
  assert("截图高度来自策略而不是写死", args.includes("--window-size=1100,6000"));
  assert("路径与目标参数在末尾（不会被前面选项覆盖）", args[args.length - 1].startsWith("http") && args.indexOf("--screenshot=C:/x/a.png") >= args.length - 3, args.join(" "));
  assert(
    "不传 profileDir 时不注入空目录参数",
    !buildScreenshotArgs({ previewPath: "a.png", height: 100, pageUrl: "u", profileDir: "" }).some((arg) => arg.startsWith("--user-data-dir=")),
  );

  assert("旧的写死 12000 画布已移除", !/const height = "12000"/u.test(postersSrc));
  assert("图片探测结论走 stderr（不污染 stdout 契约）", /console\.warn\(summary\.line\)/u.test(postersSrc));
  assert("截图前会先删旧 PNG（否则加高重截会把残留当成成功）", /await fs\.rm\(previewPath, \{ force: true \}\)/u.test(postersSrc));
  lines.push("");
}

console.log(lines.join("\n"));
console.log(`── 结果：${passed} 通过 / ${failed} 失败 ──`);
process.exit(failed === 0 ? 0 : 1);
