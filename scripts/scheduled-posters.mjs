import { execFileSync, spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "output");
const archiveRoot = path.join(outputRoot, "scheduled-posters");
const serverBase = process.env.GAMENEWS_SERVER || "http://127.0.0.1:64424";
const publicServerBase = process.env.POSTER_PUBLIC_SERVER || "http://127.0.0.1:64425";
const publicStatePath = path.join(projectRoot, "data", "poster-public-tunnel.json");
const publicLogPath = path.join(projectRoot, "data", "poster-public-tunnel.log");
const posterTrimScript = path.join(projectRoot, "scripts", "trim-poster-preview.mjs");
const kind = process.argv[2] === "weekly" ? "weekly" : "daily";
const sourceFileIndex = process.argv.indexOf("--file");
const sourceFileArg = sourceFileIndex >= 0 ? String(process.argv[sourceFileIndex + 1] || "") : "";
const sourceFileName = sourceFileArg ? path.basename(sourceFileArg) : "";
if (sourceFileArg && sourceFileName !== sourceFileArg) throw new Error("海报文件名无效");
const articleIdsIndex = process.argv.indexOf("--article-ids");
const articleIdsArg = articleIdsIndex >= 0 ? String(process.argv[articleIdsIndex + 1] || "") : "";
const articleIds = [...new Set(articleIdsArg.split(",").map((id) => id.trim()).filter(Boolean))];
const deliveryLockPath = path.join(projectRoot, "data", "logs", `poster-delivery-${kind}.lock`);
const deliveryStatePath = path.join(projectRoot, "data", "logs", "poster-delivery.json");
let deliveryLockOwned = false;

function shanghaiDateKey(now = new Date()) {
  const parts = shanghaiDateParts(now);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

// 锁的年龄兜底阈值。调度器给海报脚本设了 180s 超时（server/scheduler.js 的
// runPosterDelivery），所以超过 10 分钟的锁不可能是「真的还在投递」。
const DELIVERY_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * 判断锁文件是否为僵死残留。
 * 只靠 process.kill(pid, 0) 判活在 Windows 上不可靠：PID 会被系统回收复用，
 * 残留锁里记下的 pid 很容易落到另一个长期存活的进程上，于是锁被永久误判为
 * 「正在投递」，之后每天的日报/周报都会被静默跳过（实测：2026-09-26 08:30 的
 * 残留锁 + PID 被复用给 node index.js ⇒ 09-27 / 09-28 日报连续两天未生成）。
 * 因此额外用 startedAt 做年龄判断，超时即视为可抢占。
 */
function deliveryLockIsStale(current = {}) {
  const startedAt = Date.parse(current?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return Date.now() - startedAt > DELIVERY_LOCK_TTL_MS;
}

function acquireDeliveryLock(attempt = 0) {
  fsSync.mkdirSync(path.dirname(deliveryLockPath), { recursive: true });
  try {
    const fd = fsSync.openSync(deliveryLockPath, "wx");
    fsSync.writeFileSync(fd, JSON.stringify({ pid: process.pid, kind, startedAt: new Date().toISOString() }));
    fsSync.closeSync(fd);
    deliveryLockOwned = true;
    process.once("exit", () => {
      if (deliveryLockOwned) {
        try { fsSync.unlinkSync(deliveryLockPath); } catch {}
      }
    });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (attempt >= 2) return false;
    let current = {};
    try { current = JSON.parse(fsSync.readFileSync(deliveryLockPath, "utf8")); } catch { current = {}; }
    const steal = () => {
      console.log(`[poster-lock] 清除僵死锁 ${path.basename(deliveryLockPath)}（pid=${current.pid ?? "?"} startedAt=${current.startedAt ?? "?"}）`);
      try { fsSync.unlinkSync(deliveryLockPath); } catch {}
      return acquireDeliveryLock(attempt + 1);
    };
    if (deliveryLockIsStale(current)) return steal();
    try {
      process.kill(Number(current.pid), 0);
      return false;
    } catch {
      return steal();
    }
  }
}

async function hasDeliveredToday() {
  try {
    const state = JSON.parse(await fs.readFile(deliveryStatePath, "utf8"));
    return state?.[`${kind}:${shanghaiDateKey()}`]?.status === "sent";
  } catch {
    return false;
  }
}

async function markDelivered(fileName, messageId = "") {
  let state = {};
  try { state = JSON.parse(await fs.readFile(deliveryStatePath, "utf8")); } catch {}
  state[`${kind}:${shanghaiDateKey()}`] = { status: "sent", kind, fileName, messageId, sentAt: new Date().toISOString() };
  const keys = Object.keys(state).sort().slice(-60);
  await fs.mkdir(path.dirname(deliveryStatePath), { recursive: true });
  await fs.writeFile(deliveryStatePath, JSON.stringify(Object.fromEntries(keys.map((key) => [key, state[key]])), null, 2), "utf8");
}

function shanghaiDateParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return parts;
}

function dateLabel(parts) {
  return `${Number(parts.year)}.${Number(parts.month)}.${Number(parts.day)}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.message || `请求失败：${response.status}`);
  return payload;
}

async function waitForServer() {
  let lastError;
  let startedServer = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await requestJson(`${serverBase}/api/health`);
      return;
    } catch (error) {
      lastError = error;
      if (!startedServer && attempt === 0 && serverBase === "http://127.0.0.1:64424") {
        const child = spawn(process.execPath, ["server/index.js"], {
          cwd: projectRoot,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
        startedServer = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`GameNews 后端未启动：${lastError?.message || "未知错误"}`);
}

async function waitForPosterPublicServer() {
  let startedServer = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await requestJson(`${publicServerBase}/health`);
      return;
    } catch {
      if (!startedServer && attempt === 0 && publicServerBase === "http://127.0.0.1:64425") {
        const child = spawn(process.execPath, ["scripts/poster-public-server.mjs"], {
          cwd: projectRoot,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
        startedServer = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("海报公开服务未启动");
}

function publicFileUrl(baseUrl, filePath) {
  return `${baseUrl.replace(/\/$/u, "")}/posters/${encodeURIComponent(path.basename(filePath))}`;
}

async function readTunnelState() {
  try {
    return JSON.parse(await fs.readFile(publicStatePath, "utf8"));
  } catch {
    return null;
  }
}

async function isTunnelReady(url) {
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/iu.test(String(url || ""))) return false;
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(7000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function cloudflaredExecutable() {
  const candidates = [
    path.join(projectRoot, "tools", "cloudflared", "cloudflared.exe"),
    process.env.CLOUDFLARED_BIN,
    "cloudflared",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 5000, windowsHide: true });
      return candidate;
    } catch {
      // Only a verified client may create the public tunnel.
    }
  }
  return "";
}

async function ensurePublicTunnel() {
  await waitForPosterPublicServer();
  const state = await readTunnelState();
  if (state?.url && await isTunnelReady(state.url)) return state.url;

  const executable = await cloudflaredExecutable();
  if (!executable) throw new Error("Cloudflare Tunnel 客户端未安装或未完整下载");
  await fs.mkdir(path.dirname(publicStatePath), { recursive: true });
  await fs.writeFile(publicLogPath, "", "utf8");
  const logHandle = await fs.open(publicLogPath, "a");
  const child = spawn(executable, ["tunnel", "--no-autoupdate", "--url", publicServerBase], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    windowsHide: true,
  });
  child.unref();
  await logHandle.close();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const log = await fs.readFile(publicLogPath, "utf8").catch(() => "");
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu.exec(log);
    if (match) {
      const url = match[0];
      await fs.writeFile(publicStatePath, JSON.stringify({ url, pid: child.pid, updatedAt: new Date().toISOString() }, null, 2));
      return url;
    }
  }
  throw new Error("未获取到 Cloudflare 海报访问地址");
}

async function previewBrowsers() {
  const candidates = [
    process.env.EDGE_BIN,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env.CHROME_BIN,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  const found = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      if (!found.includes(candidate)) found.push(candidate);
    } catch {
      // Try the next installed browser location.
    }
  }
  return found;
}

async function renderPosterPreview(filePath) {
  const browsers = await previewBrowsers();
  if (!browsers.length) throw new Error("未找到可用于生成海报图片的 Edge/Chrome 浏览器");
  const previewPath = filePath.replace(/\.html$/u, ".png");
  const localPath = path.relative(outputRoot, filePath).split(path.sep).map((segment) => encodeURIComponent(segment)).join("/");
  const pageUrl = `${serverBase.replace(/\/$/u, "")}/generated-output/${localPath}`;
  // 飞书消息直接上传此 PNG。今日海报的活动卡片数量会随日变化，1950px 会把
  // 页面下半部分直接截掉；统一使用足够高的完整画布，避免把“打开完整海报”变成
  // 唯一可读入口。12000px 也覆盖当前周报的长图范围。
  const height = "12000";
  // Edge 153 起无头 screenshot 在部分环境下会静默退出（秒退且不落盘），
  // 因此逐个浏览器尝试，直到截图文件真正生成。
  // 单次截图硬超时。--screenshot 要等页面 load 事件，只要有一张走 /api/image-proxy
  // 的图始终不返回，浏览器进程就不会退出；而原实现只监听 close，于是一直等下去
  // （实测 2026-09-28 卡死 8 分钟以上、PNG 始终不落盘，投递锁也被一直占住）。
  // 超时后终止该浏览器并继续尝试下一个，避免单张图把整条投递链路拖死。
  const RENDER_TIMEOUT_MS = 90_000;
  for (const browser of browsers) {
    let timedOut = false;
    await new Promise((resolve) => {
      const child = spawn(browser, ["--headless", "--disable-gpu", "--hide-scrollbars", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=4000", `--screenshot=${previewPath}`, `--window-size=1100,${height}`, pageUrl], { windowsHide: true });
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch {}
        resolve();
      }, RENDER_TIMEOUT_MS);
      child.once("error", finish);
      child.once("close", finish);
    });
    if (timedOut) {
      console.warn(`[poster] ${path.basename(path.dirname(path.dirname(browser)))} 截图超时 ${RENDER_TIMEOUT_MS / 1000}s，已终止并尝试下一个浏览器`);
    }
    try {
      const stat = await fs.stat(previewPath);
      if (stat.size > 0) break;
    } catch {
      console.warn(`[poster] ${path.basename(path.dirname(path.dirname(browser)))} 截图未生成，尝试下一个浏览器`);
    }
  }
  try {
    await fs.access(previewPath);
  } catch {
    throw new Error("海报 PNG 未能生成：所有可用浏览器的截图都失败或超时");
  }
  // Edge 在部分 Windows 环境会在进程退出后才完成落盘；等待文件稳定再继续。
  let previousSize = -1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const stat = await fs.stat(previewPath);
      if (stat.size > 0 && stat.size === previousSize) break;
      previousSize = stat.size;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await fs.access(previewPath);
  // Edge 在 Windows 下可能先写入完整画布，再异步完成像素落盘；仅用文件大小
  // 判断稳定会偶发过早。额外等待后再裁边，避免将 12000px 空白画布直接上传飞书。
  await new Promise((resolve) => setTimeout(resolve, 5000));
  trimPosterPreview(previewPath);
  return previewPath;
}

function pngSize(filePath) {
  const header = fsSync.readFileSync(filePath).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

/**
 * 裁掉长截图底部的空白画布，并核对裁边确实生效。
 *
 * 旧实现是 `execFileSync(process.env.PYTHON_BIN || "python", [...])`：本机 PATH 上的
 * `python` 是没装 PIL 的托管解释器，每次都抛 `ModuleNotFoundError`，又被
 * `catch + console.warn` 吞掉 ⇒ 1100x12000 的空白画布被原样上传飞书
 * （09-24/25/26 日报实测全是 12000px，底部 10044px 全是空白，占 82%）。
 * 现在改用零依赖的 Node 实现（scripts/trim-poster-preview.mjs），失败时打印真实原因，
 * 并核对裁后高度，避免同类问题再次静默退化。
 */
function trimPosterPreview(previewPath) {
  const before = pngSize(previewPath);
  let payload = {};
  try {
    // 跑两次：兼容首次读取仍处于写入边缘的情况；裁边幂等，第二次会直接判定无需处理。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const output = execFileSync(process.execPath, [posterTrimScript, previewPath], {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      try { payload = JSON.parse(String(output).trim().split("\n").pop() || "{}"); } catch { payload = {}; }
    }
  } catch (error) {
    // 裁边失败不阻断投递，但必须把真实原因打出来（旧实现只留一句模糊 warn）。
    console.warn(`[poster] PNG 裁边失败，下方会残留空白：${error.stderr || error.message || error}`);
    return before;
  }
  const after = pngSize(previewPath);
  if (after.height >= before.height && before.height >= 12_000) {
    console.warn(`[poster] PNG 裁边未生效：${before.width}x${before.height} → ${after.width}x${after.height}，请检查 scripts/trim-poster-preview.mjs`);
  } else {
    console.log(`[poster] PNG 裁边 ${before.width}x${before.height} → ${after.width}x${after.height}（去掉 ${before.height - after.height}px 空白）`);
  }
  return after;
}

function readUserEnvironment(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== "win32") return "";
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Environment]::GetEnvironmentVariable('${name}', 'User')`,
    ], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

async function feishuTenantAccessToken() {
  // 海报发送使用专属机器人；保留旧变量仅用于已有部署的兼容兜底。
  const appId = readUserEnvironment("FEISHU_POSTER_APP_ID") || readUserEnvironment("FEISHU_APP_ID");
  const appSecret = readUserEnvironment("FEISHU_POSTER_APP_SECRET") || readUserEnvironment("FEISHU_APP_SECRET");
  if (!appId || !appSecret) throw new Error("未设置海报机器人凭据");
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload?.code) !== 0 || !payload?.tenant_access_token) throw new Error(`飞书令牌获取失败：${payload?.msg || response.status}`);
  return payload.tenant_access_token;
}

async function uploadFeishuImage(filePath, accessToken) {
  const image = await fs.readFile(filePath);
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", new Blob([image], { type: "image/png" }), path.basename(filePath));
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload?.code) !== 0 || !payload?.data?.image_key) throw new Error(`飞书图片上传失败：${payload?.msg || response.status}`);
  return payload.data.image_key;
}

async function sendFeishuAppBot(filePath, label, { publicBase = "", previewPath = "" } = {}) {
  const chatId = readUserEnvironment("FEISHU_POSTER_CHAT_ID") || readUserEnvironment("FEISHU_CHAT_ID");
  if (!chatId) return { skipped: true, reason: "未设置海报目标群" };
  const accessToken = await feishuTenantAccessToken();
  const localPath = path
    .relative(outputRoot, filePath)
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const link = publicBase
    ? publicFileUrl(publicBase, filePath)
    : `${serverBase.replace(/\/$/u, "")}/generated-output/${localPath}`;
  const isWeekly = kind === "weekly";
  const imageKey = isWeekly ? "" : await uploadFeishuImage(previewPath, accessToken);
  const card = {
    config: { wide_screen_mode: true },
    header: { template: "green", title: { tag: "plain_text", content: label } },
    elements: [
      ...(isWeekly ? [] : [{ tag: "img", img_key: imageKey, alt: { tag: "plain_text", content: label }, mode: "fit_horizontal", compact_width: false }]),
      { tag: "div", text: { tag: "lark_md", content: isWeekly ? "周报内容较长，点击打开完整网页版阅读。" : (publicBase ? "海报已直接展示在消息内，可点击查看完整网页版本。" : "海报已直接展示在消息内。") } },
      { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: isWeekly ? "打开完整周报" : "打开完整海报" }, type: "primary", url: link }] },
    ],
  };
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload?.code) !== 0) throw new Error(`飞书应用机器人发送失败：${payload?.msg || response.status}`);
  return { skipped: false, messageId: payload?.data?.message_id || "" };
}

if (!acquireDeliveryLock()) {
  console.log(JSON.stringify({ ok: true, kind, skipped: true, reason: "同类型海报投递正在进行，已跳过重复进程" }));
  process.exit(0);
}
if (await hasDeliveredToday()) {
  deliveryLockOwned = false;
  try { fsSync.unlinkSync(deliveryLockPath); } catch {}
  console.log(JSON.stringify({ ok: true, kind, skipped: true, reason: "今天同类型海报已成功发送，跳过重复投递" }));
  process.exit(0);
}

await waitForServer();
const generated = sourceFileName
  ? { fileName: sourceFileName }
  : await requestJson(`${serverBase}/api/${kind === "weekly" ? "weekly-poster" : "daily-poster"}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: kind === "weekly" ? undefined : JSON.stringify(articleIds.length ? { articleIds } : {}),
  });

const parts = shanghaiDateParts();
const sourcePath = path.join(outputRoot, generated.fileName);
await fs.access(sourcePath);
const sourceDate = /-(\d{4})-(\d{2})-(\d{2})\.html$/u.exec(generated.fileName);
const label = sourceDate
  ? `${Number(sourceDate[1])}.${Number(sourceDate[2])}.${Number(sourceDate[3])}`
  : dateLabel(parts);
const targetName = `${label}-${kind === "weekly" ? "周简讯海报" : "今日简讯海报"}.html`;
const targetPath = path.join(archiveRoot, targetName);
await fs.mkdir(archiveRoot, { recursive: true });
await fs.copyFile(sourcePath, targetPath);
let publicBase = "";
let previewPath = "";
let publicError = "";
try {
  if (kind !== "weekly") previewPath = await renderPosterPreview(targetPath);
  publicBase = await ensurePublicTunnel();
} catch (error) {
  publicError = error.message || "HTTPS 海报访问地址不可用";
}
if (kind === "weekly" && !publicBase) {
  throw new Error(`周报公开访问地址不可用：${publicError}`);
}
const feishu = await sendFeishuAppBot(targetPath, targetName.replace(/\.html$/u, ""), { publicBase, previewPath });
if (!feishu.skipped) await markDelivered(targetName, feishu.messageId || "");
deliveryLockOwned = false;
try { fsSync.unlinkSync(deliveryLockPath); } catch {}

console.log(JSON.stringify({
  ok: true,
  kind,
  source: sourcePath,
  target: targetPath,
  publicUrl: publicBase ? publicFileUrl(publicBase, targetPath) : "",
  previewPath,
  publicError,
  feishu: feishu.skipped ? feishu.reason : "sent",
}, null, 2));
