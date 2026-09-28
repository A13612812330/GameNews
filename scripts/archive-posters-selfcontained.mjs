// 把海报归档成「自包含」版本 —— 推到 GitHub 后外部访客能真正看到图。
//
// 背景（实测）：
//   海报 HTML 里的图片全部指向本机服务，共两类：
//     http://127.0.0.1:64424/weekly-assets/<date>/assets/<file>   本地快照副本
//     http://127.0.0.1:64424/api/image-proxy?url=<encoded>        源站图片代理
//   scripts/poster-public-server.mjs（64425）在**运行时**把这两类改写成
//   /assets/ 与 /image?url= 只是为了分享隧道可用；而 published-posters/ 里
//   存的是**未改写**的原始副本 —— 推到 GitHub 后 127.0.0.1 指向访客自己的
//   机器，满屏破图（实测 9.21 周报 191 处、9.23 日报 40 处）。
//
// 做法：
//   1) 本地快照图 → 复制到 published-posters/assets/<date>/
//   2) 代理图     → 服务端代取（不带 Referer，实测 53/53 可裸抓）落盘到同一目录
//   3) HTML 里两类地址统一改写成相对路径 ../assets/<date>/<file>
//   幂等：目标文件已存在且字节数一致时跳过复制/下载。
//
// 用法：
//   node scripts/archive-posters-selfcontained.mjs --dry          # 只统计，不写盘
//   node scripts/archive-posters-selfcontained.mjs                # 正式归档
//   node scripts/archive-posters-selfcontained.mjs --file <文件名> # 只处理一个
//   node scripts/archive-posters-selfcontained.mjs --jobs 8        # 远程抓取并发

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "output", "scheduled-posters");
const publishRoot = path.join(root, "published-posters");
const assetRoot = path.join(publishRoot, "assets");
const snapshotRoot = path.join(root, "data", "weekly-snapshots");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

const dryRun = process.argv.includes("--dry");
const onlyFile = argValue("--file");
// 默认只归档 output/scheduled-posters 里现存的期数（= 当前仍可复现的留档）。
// published-posters 里更早的历史副本默认不动：它们的源站图多已失效，
// 且会给公开仓库平添上百 MB；确需一并修复时显式加 --include-archived。
const includeArchived = process.argv.includes("--include-archived");
const JOBS = Math.max(1, Number(argValue("--jobs") || 6));
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const LOCAL_ASSET_RE =
  /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/weekly-assets\/(\d{4}-\d{2}-\d{2})\/assets\/([^"'\s>)]+)/giu;
const PROXY_RE =
  /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/api\/image-proxy\?url=([^"'\s>)]+)/giu;
const ANY_LOCAL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//giu;

const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

const stats = {
  filesScanned: 0,
  filesWritten: 0,
  pngCopied: 0,
  localCopied: 0,
  localSkipped: 0,
  localMissing: 0,
  remoteFetched: 0,
  remoteSkipped: 0,
  remoteFailed: 0,
  leftover: 0,
};

const problems = [];

function dateFromName(name) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/u.exec(name);
  if (!match) return "";
  const [, y, m, d] = match;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function targetDirFor(name) {
  if (/-今日简讯海报\.(?:html|png)$/iu.test(name)) return path.join(publishRoot, "daily");
  if (/-周简讯海报\.html$/iu.test(name)) return path.join(publishRoot, "weekly");
  return "";
}

function extFromUrl(url) {
  const clean = String(url).split("?")[0];
  const match = /\.(jpe?g|png|webp|gif|avif)$/iu.exec(clean);
  return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : "";
}

function findExistingAsset(dir, prefix) {
  try {
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(prefix));
    return hit || "";
  } catch {
    return "";
  }
}

async function pool(items, size, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(size, queue.length) || 1 }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

/** 本地快照图 → 复制到归档 assets，返回相对引用。 */
function resolveLocalAsset(date, encodedName) {
  let name = encodedName;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    /* 保留原样 */
  }
  const from = path.join(snapshotRoot, date, "assets", name);
  const dir = path.join(assetRoot, date);
  const to = path.join(dir, name);
  if (!fs.existsSync(from)) {
    stats.localMissing += 1;
    problems.push(`missing-local  ${date}/assets/${name}`);
    return null;
  }
  if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) {
    stats.localSkipped += 1;
  } else if (dryRun) {
    stats.localCopied += 1;
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(from, to);
    stats.localCopied += 1;
  }
  return `../assets/${date}/${encodedName}`;
}

/** 代理图 → 服务端代取落盘，返回相对引用。 */
async function downloadRemoteAsset(date, url) {
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
  const dir = path.join(assetRoot, date);
  const existing = findExistingAsset(dir, `remote-${hash}.`);
  if (existing) {
    stats.remoteSkipped += 1;
    return `../assets/${date}/${existing}`;
  }
  if (dryRun) {
    stats.remoteFetched += 1;
    return `../assets/${date}/remote-${hash}${extFromUrl(url) || ".jpg"}`;
  }
  try {
    const response = await fetch(url, {
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!response.ok || !type.startsWith("image/")) {
      stats.remoteFailed += 1;
      problems.push(`remote-http ${response.status} ${type} ${url.slice(0, 90)}`);
      return null;
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length) {
      stats.remoteFailed += 1;
      problems.push(`remote-empty ${url.slice(0, 90)}`);
      return null;
    }
    const ext = MIME_EXT[type] || extFromUrl(url) || ".jpg";
    const fileName = `remote-${hash}${ext}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), body);
    stats.remoteFetched += 1;
    return `../assets/${date}/${fileName}`;
  } catch (error) {
    stats.remoteFailed += 1;
    problems.push(`remote-err ${error?.message || "unknown"} ${url.slice(0, 80)}`);
    return null;
  }
}

async function processHtml(html, date) {
  stats.filesScanned += 1;

  // 1) 先把所有需要联网的代理 URL 收集齐，一次性并发取回（本地复制不联网）。
  const proxyUrls = new Set();
  const collector = new RegExp(PROXY_RE.source, "giu");
  let match;
  while ((match = collector.exec(html))) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (/^https?:\/\//iu.test(decoded)) proxyUrls.add(decoded);
    } catch {
      /* 坏数据跳过 */
    }
  }

  const remoteMap = new Map();
  await pool([...proxyUrls], JOBS, async (url) => {
    const local = await downloadRemoteAsset(date, url);
    if (local) remoteMap.set(url, local);
  });

  // 2) 同步替换：本地快照 + 代理图。
  let changed = 0;
  let out = html.replace(new RegExp(LOCAL_ASSET_RE.source, "giu"), (whole, assetDate, encodedName) => {
    const local = resolveLocalAsset(assetDate, encodedName);
    if (!local) return whole;
    changed += 1;
    return local;
  });
  out = out.replace(new RegExp(PROXY_RE.source, "giu"), (whole, encodedUrl) => {
    let decoded;
    try {
      decoded = decodeURIComponent(encodedUrl);
    } catch {
      return whole;
    }
    const local = remoteMap.get(decoded);
    if (!local) return whole;
    changed += 1;
    return local;
  });

  stats.leftover += (out.match(ANY_LOCAL_RE) || []).length;
  return { out, changed };
}

async function handle(entry) {
  const { from, toName, toDir } = entry;
  const date = dateFromName(toName);

  if (/\.png$/iu.test(toName)) {
    const to = path.join(toDir, toName);
    if (dryRun) {
      if (!fs.existsSync(to)) stats.pngCopied += 1;
      return;
    }
    fs.mkdirSync(toDir, { recursive: true });
    if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) {
      fs.copyFileSync(from, to);
      stats.pngCopied += 1;
    }
    return;
  }

  const html = fs.readFileSync(from, "utf8");
  const { out, changed } = await processHtml(html, date);
  if (dryRun) {
    if (changed > 0) stats.filesWritten += 1;
    return;
  }
  const to = path.join(toDir, toName);
  fs.mkdirSync(toDir, { recursive: true });
  if (out !== html || !fs.existsSync(to)) {
    fs.writeFileSync(to, out, "utf8");
    stats.filesWritten += 1;
  }
}

// ── 收集任务：① output 里同步过来 ② 已归档但 output 没有的历史文件 ──
const tasks = [];
const seenDest = new Set();

for (const name of fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir).sort() : []) {
  if (onlyFile && name !== onlyFile) continue;
  const toDir = targetDirFor(name);
  if (!toDir) continue;
  const from = path.join(sourceDir, name);
  if (!fs.statSync(from).isFile()) continue;
  const key = `${toDir}|${name}`;
  if (seenDest.has(key)) continue;
  seenDest.add(key);
  tasks.push({ from, toName: name, toDir });
}

if (includeArchived) {
  for (const sub of ["daily", "weekly"]) {
    const dir = path.join(publishRoot, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (onlyFile && name !== onlyFile) continue;
      if (!/\.html?$/iu.test(name)) continue;
      const key = `${dir}|${name}`;
      if (seenDest.has(key)) continue;
      if (fs.existsSync(path.join(sourceDir, name))) continue;
      seenDest.add(key);
      tasks.push({ from: path.join(dir, name), toName: name, toDir: dir, inPlace: true });
    }
  }
}

for (const task of tasks) await handle(task);

// 校验范围与处理范围一致：只看本次扫过的文件，避免历史遗留的本机链接造成假警报。
const leftoverAfter = stats.leftover;

console.log(`MODE=${dryRun ? "dry" : "apply"}`);
console.log(`TASKS=${tasks.length}`);
console.log(`HTML_SCANNED=${stats.filesScanned}`);
console.log(`FILES_WRITTEN=${stats.filesWritten}`);
console.log(`PNG_COPIED=${stats.pngCopied}`);
console.log(`LOCAL_ASSETS copied=${stats.localCopied} skipped=${stats.localSkipped} missing=${stats.localMissing}`);
console.log(`REMOTE_ASSETS fetched=${stats.remoteFetched} skipped=${stats.remoteSkipped} failed=${stats.remoteFailed}`);
console.log(`LEFTOVER_LOCALHOST=${leftoverAfter}`);
if (problems.length) {
  console.log(`--- 问题明细（前 25 条 / 共 ${problems.length}）---`);
  console.log(problems.slice(0, 25).join("\n"));
}
console.log(leftoverAfter === 0 ? "DIGEST_OK" : "DIGEST_LEFTOVER");
