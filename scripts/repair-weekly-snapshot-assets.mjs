/**
 * 修复历史周报快照里被抹掉的 `localUrl`。
 *
 * 背景：`retention.js` 的归一化会把图片引用还原成远程地址，导致
 * `writeWeeklyMaterialSnapshot` 已经落盘到 `assets/` 的主图失去引用
 * （113 张图躺在磁盘上没人用），周报只能退回源站图片 —— 而源站对
 * 站外 Referer 有防盗链（TapTap 567 / 机核 403 / 游民 403），公开
 * 链接打开必然白图。
 *
 * 资产文件名是 URL 的 sha1 前 16 位（`main-<hash>.<ext>`），因此可以
 * 确定性地把磁盘上的文件重新挂回对应图片，无需重新抓取。
 *
 * 用法：
 *   node scripts/repair-weekly-snapshot-assets.mjs --dry-run   # 只报告
 *   node scripts/repair-weekly-snapshot-assets.mjs             # 实际写入
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotsRoot = path.join(root, "data", "weekly-snapshots");
const dryRun = process.argv.includes("--dry-run");

const shortHash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16);

let snapshotsTouched = 0;
let attachedTotal = 0;
let imagesTotal = 0;
let orphanFiles = 0;

for (const entry of fs.readdirSync(snapshotsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.name)) continue;
  const date = entry.name;
  const dir = path.join(snapshotsRoot, date);
  const jsonPath = path.join(dir, "materials.json");
  const assetDir = path.join(dir, "assets");
  if (!fs.existsSync(jsonPath) || !fs.existsSync(assetDir)) continue;

  const byHash = new Map();
  for (const file of fs.readdirSync(assetDir)) {
    const matched = file.match(/^main-([0-9a-f]{16})\./iu);
    if (matched) byHash.set(matched[1].toLowerCase(), file);
  }
  if (!byHash.size) continue;

  const snapshot = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const used = new Set();
  let attached = 0;
  let images = 0;

  for (const article of snapshot.articles || []) {
    for (const image of article.images || []) {
      images += 1;
      if (String(image.localUrl || "").startsWith("/weekly-assets/")) {
        used.add(path.basename(String(image.localUrl)));
        continue;
      }
      const candidates = [image.originalUrl, image.url, image.src].map((value) => String(value || "")).filter(Boolean);
      const file = candidates.map((value) => byHash.get(shortHash(value))).find(Boolean);
      if (!file) continue;
      image.localUrl = `/weekly-assets/${date}/assets/${file}`;
      used.add(file);
      attached += 1;
    }
  }

  if (attached) {
    snapshotsTouched += 1;
    attachedTotal += attached;
    if (!dryRun) fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");
  }
  imagesTotal += images;
  orphanFiles += [...byHash.values()].filter((file) => !used.has(file)).length;
  console.log(`${date}  图片 ${images}  挂回 ${attached}  资产 ${byHash.size}  未引用 ${byHash.size - used.size}`);
}

console.log("");
console.log(`快照 ${snapshotsTouched} 份被修复，共挂回 ${attachedTotal} 张本地主图（图片条目 ${imagesTotal}）`);
console.log(`仍未被引用的资产文件：${orphanFiles}`);
console.log(dryRun ? "（dry-run，未写入）" : "已写入 materials.json");
