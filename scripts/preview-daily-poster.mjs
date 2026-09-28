// 海报版式预览：直接读库 + 调用 buildDailyPosterHtml，完全不经过 HTTP 服务。
// 用途：打磨版式时服务端模块被缓存，必须重启 64424 才能生效；而在受限沙箱里
// 无法 spawn 守护进程。这个脚本让版式迭代可以离线完成，跑完再交给正式链路投递。
//
// 用法：
//   node scripts/preview-daily-poster.mjs                          # 今日全部入选资讯
//   node scripts/preview-daily-poster.mjs --ids a,b,c              # 指定文章 id
//   node scripts/preview-daily-poster.mjs --ids-file gen-req.json  # 从 JSON 读 { articleIds }
//   node scripts/preview-daily-poster.mjs --out output/scheduled-posters/xxx.html
//   node scripts/preview-daily-poster.mjs --asset-base http://127.0.0.1:64424
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getArticlesByIds, listTodayArticles } from "../server/database.js";
import { buildDailyPosterHtml } from "../server/dailyPoster.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

function shanghaiDateKey(date = new Date()) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function resolveArticleIds() {
  const inline = argValue("--ids");
  if (inline) return [...new Set(inline.split(",").map((id) => id.trim()).filter(Boolean))];
  const idsFile = argValue("--ids-file");
  if (idsFile) {
    const payload = JSON.parse(await fs.readFile(path.resolve(projectRoot, idsFile), "utf8"));
    const ids = Array.isArray(payload) ? payload : payload.articleIds || [];
    return [...new Set(ids.filter(Boolean))];
  }
  return [];
}

// 与 POST /api/daily-poster/generate 同一取舍：给了 id 就原样使用，
// 未给 id 时才按“上海自然日”过滤。
function collectArticles(ids) {
  if (!ids.length) return listTodayArticles().articles;
  const byId = new Map(getArticlesByIds(ids).map((article) => [article.id, article]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function summarize(html) {
  const sectionPattern = /<section class="poster-section([^"]*)"><header[^>]*><span>(\d+)<\/span><h2>([^<]+)<\/h2><small>([^<]+)<\/small>/gu;
  const rows = [];
  for (const match of html.matchAll(sectionPattern)) rows.push(`${match[2]} ${match[3]} — ${match[4].trim()}`);
  const blockPattern = /poster-event-block--(\w+)"><div class="poster-event-block-head"><i><\/i><h3>([^<]+)<\/h3><b>(\d+)<\/b>/gu;
  for (const match of html.matchAll(blockPattern)) rows.push(`    └ ${match[2]} · ${match[3]} 条`);
  return rows;
}

const articleIds = await resolveArticleIds();
const articles = collectArticles(articleIds);
if (!articles.length) {
  console.error("没有可用的资讯（检查 --ids / 今日是否已入库）");
  process.exit(1);
}

const date = shanghaiDateKey();
const assetBase = argValue("--asset-base") || "http://127.0.0.1:64424";
const html = buildDailyPosterHtml(articles, { assetBase });
const outArg = argValue("--out") || path.join("output", `简讯海报-${date}.html`);
const outPath = path.resolve(projectRoot, outArg);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, html, "utf8");

// 相对图片地址会在 file:// 下 404，这是“活动图不显示”的高发点，生成后立即体检。
const relativeImages = [...html.matchAll(/<img src="(\/(?!\/)[^"]*)"/gu)].length;
console.log(`文章 ${articles.length} 条 · 输出 ${outPath}`);
for (const line of summarize(html)) console.log(line);
console.log(relativeImages ? `警告：仍有 ${relativeImages} 张相对地址图片（file:// 下会 404）` : "图片地址体检：全部为绝对地址");
