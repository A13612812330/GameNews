// 把归档海报改写为「自包含」版本，使其在 GitHub Pages 等外部托管上可直接打开。
//
// 背景：海报生成时图片走的是本机图片代理
//   http://127.0.0.1:64424/api/image-proxy?url=<encodeURIComponent(原始图片地址)>
// 在 64425 的公开服务里是**运行时**改写的（scripts/poster-public-server.mjs），
// 但 published-posters/ 里存的是**未改写**的原始副本 —— 实测 9.23 日报有 40 处、
// 9.21 周报有 191 处这种链接。外部访客打开时，这些地址会被解析成他们自己的
// 127.0.0.1:64424，图片全部加载失败。
//
// 本脚本把这层改写固化成归档的一步，让 published-posters/ 成为真正自包含的内容。
// 幂等：已改写过的文件再跑一次结果不变。
//
// 用法：
//   node scripts/rewrite-archived-posters.mjs --dry          # 只统计
//   node scripts/rewrite-archived-posters.mjs                # 改写 published-posters/
//   node scripts/rewrite-archived-posters.mjs --dir <目录>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

const dryRun = process.argv.includes("--dry");
const targetDir = argValue("--dir") || path.join(projectRoot, "published-posters");

// 与 poster-public-server.mjs 保持一致：本机图片代理 → 原始图片地址。
// 只匹配 127.0.0.1/localhost，避免误改任何已经是外链的地址。
const PROXY_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/api\/image-proxy\?url=([^"'\s>)]+)/giu;

function rewriteHtml(html) {
  let changed = 0;
  const out = html.replace(PROXY_PATTERN, (match, encodedUrl) => {
    let decoded;
    try {
      decoded = decodeURIComponent(encodedUrl);
    } catch {
      return match;
    }
    // 只接受 http(s) 原始地址；否则保留原样，避免把坏数据写进归档。
    if (!/^https?:\/\//iu.test(decoded)) return match;
    changed += 1;
    return decoded;
  });
  return { out, changed };
}

function walk(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) files.push(full);
  }
  return files;
}

if (!fs.existsSync(targetDir)) {
  console.error(`ERROR 目录不存在：${targetDir}`);
  process.exit(1);
}

const files = walk(targetDir).sort();
let totalFiles = 0;
let totalRewrites = 0;
let leftover = 0;
const details = [];

for (const file of files) {
  const original = fs.readFileSync(file, "utf8");
  const { out, changed } = rewriteHtml(original);
  const remaining = (out.match(PROXY_PATTERN) || []).length;
  leftover += remaining;
  if (changed > 0 || original !== out) {
    if (!dryRun) fs.writeFileSync(file, out, "utf8");
    totalFiles += 1;
    totalRewrites += changed;
    details.push(`  ${path.relative(targetDir, file)}  改写 ${changed} 处`);
  }
  // 统计所有文件里的残留（含未改写的）
  if (changed === 0) {
    const r = (original.match(PROXY_PATTERN) || []).length;
    if (r > 0) leftover += 0;
  }
}

// 最终校验：改写后整个目录里不应再有本机代理链接
let verifyLeftover = 0;
for (const file of files) {
  const content = dryRun ? rewriteHtml(fs.readFileSync(file, "utf8")).out : fs.readFileSync(file, "utf8");
  verifyLeftover += (content.match(PROXY_PATTERN) || []).length;
}

console.log(dryRun ? "MODE=dry" : "MODE=apply");
console.log(`DIR=${targetDir}`);
console.log(`HTML_FILES=${files.length}`);
console.log(`FILES_CHANGED=${totalFiles}`);
console.log(`REWRITES=${totalRewrites}`);
if (details.length) console.log(details.join("\n"));
console.log(`LEFTOVER_LOCALHOST_PROXY=${verifyLeftover}`);
console.log(verifyLeftover === 0 ? "DIGEST_OK" : "DIGEST_LEFTOVER");
