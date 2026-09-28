/**
 * 不经服务、直接复用 builder 重新生成周报 HTML。
 *
 * 存在理由：`writeWeeklyPoster` 的版式逻辑在 `server/weeklyPoster.js` 里，
 * 被服务进程静态 import 并**模块缓存**。改了 builder 却重启不了服务时，
 * 走接口 `/api/weekly-poster/generate` 拿到的仍是旧版式（实测踩过：
 * 接口产出的仍是 32 处旧结构，直连模块才对）。
 *
 * 用法：
 *   node scripts/preview-weekly-poster.mjs                 # assetBase 默认 127.0.0.1:64424
 *   node scripts/preview-weekly-poster.mjs --base http://127.0.0.1:64424
 *   node scripts/preview-weekly-poster.mjs --publish       # 同步到 output/scheduled-posters（发布副本）
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeWeeklyPoster } from "../server/weeklyPoster.js";

const root = process.cwd();
const index = process.argv.indexOf("--base");
const assetBase = index >= 0 ? process.argv[index + 1] : "http://127.0.0.1:64424";
const publish = process.argv.includes("--publish");

const poster = await writeWeeklyPoster({ root, assetBase });
const stat = await fs.stat(poster.outputPath);
console.log(`OK ${poster.fileName}`);
console.log(`   窗口 ${poster.period} | 快照 ${poster.snapshotDays} 天 | 素材 ${poster.articleCount} 条 | ${stat.size} 字节`);
console.log(`   产出 ${poster.outputPath}`);
console.log(`   归档 ${poster.archivePath}`);

if (publish) {
  // 发布副本：公开只读服务（64425）读的是 output/scheduled-posters。
  const short = poster.fileName.replace(/^游戏资讯周报-(\d{4})-(\d{2})-(\d{2})\.html$/u, (_, y, m, d) => `${y}.${Number(m)}.${Number(d)}-周简讯海报.html`);
  const target = path.join(root, "output", "scheduled-posters", short);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(poster.outputPath, target);
  console.log(`   发布副本 ${target}`);
}
