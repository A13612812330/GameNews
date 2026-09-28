/**
 * 历史快照回填：把周报「活动」卡里的 256×256 游戏图标换成游戏活动/宣传大图。
 *
 * 背景：好游快爆时间线「即将更新」的列表封面只有 256×256 图标，活动大图只在游戏页图集里。
 * 解析器已在 facts.haoyouEventImages 存下候选，但**历史快照**（materials.json）是当时写的，
 * 里面只有图标，且原文已过 48 小时活跃库保留期，无法靠重新抓取列表补回。
 *
 * 做法：只针对这一版周报**实际渲染**的活动条目（selectWeeklyPosterRows 的结果）回源游戏页
 * 取候选 → 实测尺寸择优 → 落盘到该条目所属日期的 assets/ → 原地更新 materials.json。
 * 不碰其它条目、不删除任何文件，失败即跳过。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readWeeklyMaterialSnapshots, upgradeHaoyouEventImage, isHaoyouActivity } from "../server/weeklySnapshots.js";
import { selectWeeklyPosterRows, rollingFortnightRange } from "../server/weeklyPoster.js";
import { parseDetail } from "../server/crawler/parser.js";

const root = process.cwd();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const dryRun = process.argv.includes("--dry-run");

const range = rollingFortnightRange();
console.log(`[backfill] 周报窗口 ${range.from} ~ ${range.to}`);

const snapshots = await readWeeklyMaterialSnapshots({ root, from: range.from, to: range.to });
const articles = snapshots.flatMap((snapshot) =>
  (snapshot.articles || []).map((article) => ({ ...article, __snapshotDate: snapshot.date })));
console.log(`[backfill] 快照 ${snapshots.length} 天 / 素材 ${articles.length} 条`);

const { events } = selectWeeklyPosterRows(articles);
const targets = events.filter((article) =>
  isHaoyouActivity(article) && /^https?:\/\//u.test(article.detail_url || ""));
console.log(`[backfill] 活动卡 ${events.length} 张，其中好游需回填 ${targets.length} 张`);

// 同一游戏页会被多条活动复用：页面只抓一次（历史快照里已经存不下图集，只能回源）。
const pageCache = new Map();
async function eventCandidates(article) {
  const url = article.detail_url;
  if (!pageCache.has(url)) {
    pageCache.set(url, (async () => {
      const response = await fetch(url, {
        headers: { "user-agent": UA, referer: "https://www.3839.com/" },
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const detail = parseDetail(html, {
        url,
        gameName: article.game_name || "",
        category: article.category || "",
      });
      return Array.isArray(detail.facts?.haoyouEventImages) ? detail.facts.haoyouEventImages : [];
    })());
  }
  try {
    return await pageCache.get(url);
  } catch (error) {
    console.warn(`[backfill] 页面抓取失败 ${url}: ${error.message}`);
    return [];
  }
}

// 按日期分组原地改写 materials.json，避免逐条写文件。
const pending = new Map();
let upgraded = 0;
let skipped = 0;
let pageFailed = 0;

for (const article of targets) {
  const candidates = await eventCandidates(article);
  if (!candidates.length) {
    pageFailed += 1;
    console.log(`  ⏭ 无候选  《${article.game_name}》${String(article.title || "").slice(0, 28)}`);
    continue;
  }
  if (dryRun) {
    upgraded += 1;
    console.log(`  · ${article.__snapshotDate} 《${article.game_name}》 候选 ${candidates.length} 张 → ${candidates[0].slice(-46)}`);
    continue;
  }
  const patched = { ...article, facts: { ...(article.facts || {}), haoyouEventImages: candidates } };
  let result = null;
  try {
    result = await upgradeHaoyouEventImage({ root, date: article.__snapshotDate, article: patched });
  } catch (error) {
    console.warn(`  ⚠ 落盘失败 ${article.id}: ${error.message}`);
  }
  if (!result) {
    skipped += 1;
    console.log(`  ⏭ 无合格大图  《${article.game_name}》${String(article.title || "").slice(0, 28)}`);
    continue;
  }
  upgraded += 1;
  const picked = result.images.at(-1).originalUrl;
  console.log(`  ✓ ${article.__snapshotDate} 《${article.game_name}》 → ${picked.slice(-52)}`);
  const list = pending.get(article.__snapshotDate) || [];
  list.push({ id: article.id, result });
  pending.set(article.__snapshotDate, list);
}

if (dryRun) {
  console.log(`[backfill] dry-run：将更新 ${pending.size} 天快照 / ${upgraded} 条（未写盘）`);
  process.exit(0);
}

let written = 0;
for (const [date, list] of pending) {
  const file = path.join(root, "data", "weekly-snapshots", date, "materials.json");
  const snapshot = JSON.parse(await fs.readFile(file, "utf8"));
  const byId = new Map(list.map((item) => [item.id, item.result]));
  let changed = 0;
  for (const entry of snapshot.articles || []) {
    const result = byId.get(entry.id);
    if (!result) continue;
    // 只追加活动大图，不动 image_url（新游/榜单卡片仍按图标渲染）。
    entry.images = result.images;
    changed += 1;
  }
  if (!changed) continue;
  await fs.writeFile(file, JSON.stringify(snapshot, null, 2), "utf8");
  written += changed;
  console.log(`[backfill] 写入 ${date}/materials.json：${changed} 条`);
}

console.log(`[backfill] 完成：升级 ${upgraded} 条（写盘 ${written}），跳过 ${skipped} 条，页面无候选 ${pageFailed} 条`);
