import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { imageSize, isEventBannerSize } from "./imageSize.js";

function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function snapshotArticle(article) {
  return {
    ...article,
    facts: article.facts || {},
    paragraphs: Array.isArray(article.paragraphs) ? article.paragraphs : safeJson(article.paragraphs, []),
    images: Array.isArray(article.images) ? article.images : safeJson(article.images_json, []),
  };
}

function imageValue(image = {}) {
  return typeof image === "string"
    ? image
    : image?.localUrl || image?.src || image?.originalUrl || image?.url || "";
}

function primaryImage(article = {}) {
  const images = Array.isArray(article.images) ? article.images : [];
  return article.image_url || images.map(imageValue).find(Boolean) || "";
}

function safeImageName(value = "", contentType = "") {
  const typeExt = String(contentType).match(/^image\/(png|jpe?g|webp|gif|avif)/iu)?.[1]?.toLowerCase();
  const ext = typeExt || String(value).match(/\.(png|jpe?g|webp|gif|avif)(?:[?#].*)?$/iu)?.[1]?.toLowerCase() || "jpg";
  const hash = crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16);
  return `main-${hash}.${ext === "jpeg" ? "jpg" : ext}`;
}

/**
 * 源站图片基本都按 Referer 做防盗链，而且**要求各不相同**：
 * TapTap 收到站外 Referer 回 567、机核/游民回 403，但都不带 Referer 时放行；
 * 好游快爆两种都放行。原先统一发 `https://www.3839.com/` 的结果是
 * TapTap / 机核 / 游民的主图全部落不了盘 —— 只有 113/130 张成功。
 * 因此按图片域名给对应站点 Referer，失败再退回「不带 Referer」。
 */
const IMAGE_REFERERS = [
  [/tapimg\.com/iu, "https://www.taptap.cn/"],
  [/gcores\.com/iu, "https://www.gcores.com/"],
  [/gamersky\.com/iu, "https://www.gamersky.com/"],
  [/(?:71acg|3839img|3839video)\.com/iu, "https://www.3839.com/"],
];

function refererCandidates(value = "") {
  let host = "";
  try { host = new URL(value).host; } catch {}
  const matched = IMAGE_REFERERS.find(([pattern]) => pattern.test(host));
  return matched ? [matched[1], ""] : [""];
}

async function fetchImageBody(value) {
  let lastError = null;
  for (const referer of refererCandidates(value)) {
    try {
      const headers = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
      if (referer) headers.referer = referer;
      const response = await fetch(value, { headers, signal: AbortSignal.timeout(15000) });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.startsWith("image/")) throw new Error(`image ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (!body.length || body.length > 4 * 1024 * 1024) throw new Error("image empty or too large");
      return { body, contentType };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("image fetch failed");
}

async function fetchImageBodySafe(value) {
  try {
    return await fetchImageBody(value);
  } catch {
    return null;
  }
}

/**
 * 好游快爆「即将更新 / 即将测试 / 即将上线」条目的列表封面都是 256×256 游戏图标。
 * 周报活动卡要的是活动/宣传大图，因此按解析阶段排好的候选顺序下载并**实测**像素尺寸：
 * 只接受「长边 ≥600、短边 ≥300、长宽比 ≥1.3」的图（判定见 server/imageSize.js）。
 *
 * 是否属于「活动」与周报分类保持一致（更新类，或更新文案是版本/活动/联动/赛季/福利）。
 * 全部不合格时返回 null —— 宁可继续显示图标，也不能把另一张图标当大图用。
 */
const EVENT_BANNER_ATTEMPTS = 3;
// 与 weeklyPoster.classify 的好游活动判定保持一致；两者必须同改。
const HAOYOU_ACTIVITY_TEXT = /(?:版本|更新|活动|联动|赛季|周年|福利|开启)/u;

export function isHaoyouActivity(article = {}) {
  if (article.source_id !== "ref-haoyou") return false;
  const facts = article.facts || {};
  return facts.haoyouKind === "update" || HAOYOU_ACTIVITY_TEXT.test(String(facts.haoyouUpdateContent || ""));
}

async function pickHaoyouEventBanner(article = {}) {
  if (!isHaoyouActivity(article)) return null;
  const facts = article.facts || {};
  const cover = primaryImage(article);
  const seen = new Set();
  const candidates = [];
  for (const item of facts.haoyouEventImages || []) {
    const value = item?.url || item?.src || item || "";
    if (!value || value === cover || seen.has(value)) continue;
    seen.add(value);
    candidates.push(value);
  }
  if (!candidates.length) return null;
  let attempts = 0;
  for (const value of candidates) {
    if (attempts >= EVENT_BANNER_ATTEMPTS) break;
    attempts += 1;
    const downloaded = await fetchImageBodySafe(value);
    if (!downloaded) continue;
    if (!isEventBannerSize(imageSize(downloaded.body))) continue;
    return { value, ...downloaded };
  }
  return null;
}

function eventBannerImage(value, localUrl) {
  return {
    id: "weekly-event-banner",
    type: "event_banner",
    src: value,
    url: value,
    originalUrl: value,
    localUrl,
    alt: "活动大图",
  };
}

async function persistImageBody({ root, date, value, body, contentType }) {
  const assetDir = path.join(root, "data", "weekly-snapshots", date, "assets");
  await fs.mkdir(assetDir, { recursive: true });
  const fileName = safeImageName(value, contentType);
  await fs.writeFile(path.join(assetDir, fileName), body);
  return `/weekly-assets/${date}/assets/${fileName}`;
}

async function copyPrimaryImage({ root, date, article }) {
  const value = primaryImage(article);
  if (!value) return { value: "", localUrl: "", copied: false };
  const assetDir = path.join(root, "data", "weekly-snapshots", date, "assets");
  let fileName = safeImageName(value);
  const target = path.join(assetDir, fileName);
  try {
    await fs.mkdir(assetDir, { recursive: true });
    if (String(value).startsWith("/crawler-assets/")) {
      const source = path.join(root, "data", String(value).slice("/crawler-assets/".length).replaceAll("/", path.sep));
      await fs.copyFile(source, target);
    } else if (/^https?:\/\//iu.test(String(value))) {
      const { body, contentType } = await fetchImageBody(value);
      fileName = safeImageName(value, contentType);
      const typedTarget = path.join(assetDir, fileName);
      await fs.writeFile(typedTarget, body);
      if (typedTarget !== target) await fs.rm(target, { force: true });
      return { value, localUrl: `/weekly-assets/${date}/assets/${fileName}`, copied: true };
    } else {
      return { value, localUrl: "", copied: false };
    }
    return { value, localUrl: `/weekly-assets/${date}/assets/${fileName}`, copied: true };
  } catch {
    try { await fs.rm(target, { force: true }); } catch {}
    return { value, localUrl: "", copied: false };
  }
}

async function withPrimaryImage({ root, date, article }) {
  const copied = await copyPrimaryImage({ root, date, article });
  const original = copied.value || "";
  const images = original
    ? [{ id: "weekly-main", src: original, url: original, originalUrl: original, localUrl: copied.localUrl, type: "cover_candidate" }]
    : [];
  // 活动条目额外落一张实测过的活动大图：卡片按分区各取所需 ——
  // 活动区走 event_banner，新游/榜单区仍走第一张（游戏图标）。
  const banner = await pickHaoyouEventBanner(article);
  if (banner) {
    try {
      images.push(eventBannerImage(banner.value, await persistImageBody({ root, date, ...banner })));
    } catch {
      // 大图落盘失败不影响封面：卡片退回图标。
    }
  }
  return { ...article, image_url: original, images, images_json: undefined };
}

/**
 * 单条素材的「活动大图」升级：与快照同一套判定，供历史快照回填脚本复用。
 * 返回 `{ images }`（在原封面上追加 event_banner）；没有合格大图时返回 null。
 */
export async function upgradeHaoyouEventImage({ root, date, article }) {
  const banner = await pickHaoyouEventBanner(article);
  if (!banner) return null;
  const localUrl = await persistImageBody({ root, date, ...banner });
  const existing = (Array.isArray(article.images) ? article.images : [])
    .filter((item) => item && item.type !== "event_banner");
  return { images: [...existing, eventBannerImage(banner.value, localUrl)] };
}

function cleanGameKey(value = "") {
  return String(value)
    .replace(/[《》]/gu, "")
    .replace(/[（(](?:官服|测试服|正式服)[）)]/giu, "")
    .replace(/[\-—–]\s*(?:预下载|预约|下载|首发|公测|内测|测试|上线|发售|开放预购|至冬开放|新版本|版本更新|更新|活动|联动|赛季|周年庆?|限时|福利|开服|开放|首曝).*$/giu, "")
    .replace(/[\s\-_:：·・]/gu, "")
    .toLowerCase();
}

function candidateWeight(article = {}) {
  const facts = article.facts || {};
  const layoutCount = [facts.gcoresLayout, facts.gamerskyLayout, facts.haoyouLayout].find(Array.isArray)?.length || 0;
  const eventCount = Array.isArray(facts.taptapEvents) ? facts.taptapEvents.reduce((sum, event) => sum + (event?.blocks?.length || 0), 0) : 0;
  return Number(article.score || 0) + (article.paragraphs?.join(" ").length || 0) / 20 + (article.images?.length || 0) * 12 + layoutCount * 40 + eventCount * 100;
}

function pickDistinct(rows, limit = Infinity, { eventMode = false } = {}) {
  const selected = new Map();
  for (const article of rows) {
    const facts = article.facts || {};
    const game = cleanGameKey(article.game_name || article.title);
    if (!game) continue;
    const eventKey = eventMode
      ? `${game}:${String(article.title || "").replace(/(?:版本|更新|活动|联动|开启|上线|游戏|限时|全新|《[^》]+》)/gu, "").replace(/\s+/gu, "").slice(0, 28)}`
      : game;
    const current = selected.get(eventKey);
    const priority = article.source_id === "ref-taptap" ? 1000 : article.source_id === "ref-steam" ? 900 : article.source_id === "ref-gcores" || article.source_id === "ref-gamersky" ? 800 : 700;
    const candidate = { article, priority, weight: candidateWeight(article), facts };
    if (!current || candidate.priority > current.priority || (candidate.priority === current.priority && candidate.weight > current.weight)) selected.set(eventKey, candidate);
  }
  return [...selected.values()].sort((left, right) => right.priority - left.priority || right.weight - left.weight).slice(0, limit).map((item) => item.article);
}

function editorialQuality(article = {}) {
  const facts = article.facts || {};
  const layout = Array.isArray(facts.gcoresLayout)
    ? facts.gcoresLayout
    : Array.isArray(facts.gamerskyLayout)
      ? facts.gamerskyLayout
      : [];
  const textLength = (article.paragraphs || []).join(" ").trim().length;
  const imageCount = Array.isArray(article.images) ? article.images.length : 0;
  return Number(article.score || 0) + Math.min(textLength, 1600) / 40 + layout.length * 5 + imageCount * 4;
}

function pickEditorial(rows, limit = 15) {
  // 端游资讯必须已经取得正文布局或足够正文，避免把仅标题的候选写进周报快照。
  const qualified = rows.filter((article) => {
    const facts = article.facts || {};
    const layoutCount = Array.isArray(facts.gcoresLayout) ? facts.gcoresLayout.length : Array.isArray(facts.gamerskyLayout) ? facts.gamerskyLayout.length : 0;
    const textLength = (article.paragraphs || []).join(" ").trim().length;
    return layoutCount >= 2 || textLength >= 120;
  });
  return pickDistinct(qualified, limit).sort((left, right) => editorialQuality(right) - editorialQuality(left));
}

/** 周报素材按游戏/事件去重；仅端游资讯保留质量上限。 */
function selectWeeklyMaterials(articles) {
  const newGames = [];
  const events = [];
  const steam = [];
  const editorial = [];
  for (const article of articles) {
    const facts = article.facts || {};
    if (article.source_id === "ref-steam") {
      if (facts.steamList === "new") newGames.push(article);
      else if (["most_played", "top_selling_cn"].includes(facts.steamList) && (facts.steamRankNewEntry || Number(facts.steamRankGain || 0) >= 5)) steam.push(article);
      continue;
    }
    if (article.source_id === "ref-taptap") {
      if (/\/forum\/hot\/hashtags\?item=/u.test(article.detail_url || "")) continue;
      if ((Array.isArray(facts.taptapEvents) && facts.taptapEvents.length) || /\/game-event\//u.test(article.detail_url || "")) events.push(article);
      else newGames.push(article);
      continue;
    }
    if (article.source_id === "ref-haoyou") {
      if (facts.haoyouKind === "update") events.push(article);
      else newGames.push(article);
      continue;
    }
    if (["ref-gcores", "ref-gamersky"].includes(article.source_id)) editorial.push(article);
  }
  return [
    ...pickDistinct(newGames),
    ...pickDistinct(events, Infinity, { eventMode: true }),
    ...pickDistinct(steam),
    ...pickEditorial(editorial, 15),
  ];
}

/**
 * 每日抓取完成后，把仍在活跃库中的完整文章固化为周报素材。
 * 每篇只保留一张主图，并**落盘到同目录 assets/**（`/weekly-assets/<date>/assets/...`），
 * 因为源站对站外 Referer 有防盗链，公开链接只能引用本地副本。
 */
export async function writeWeeklyMaterialSnapshot({ root, articles = [], generatedAt = new Date() }) {
  const date = shanghaiDateKey(generatedAt);
  const snapshotDir = path.join(root, "data", "weekly-snapshots", date);
  // 同一天再次生成时直接替换这份运行产物，避免快照无限膨胀。
  await fs.rm(snapshotDir, { recursive: true, force: true });
  await fs.mkdir(snapshotDir, { recursive: true });

  const selected = selectWeeklyMaterials(articles.map(snapshotArticle));
  const normalized = [];
  let copiedAssets = 0;
  for (const article of selected) {
    const item = await withPrimaryImage({ root, date, article });
    if (item.images?.[0]?.localUrl) copiedAssets += 1;
    normalized.push(item);
  }

  const snapshot = {
    version: 3,
    date,
    generatedAt: generatedAt.toISOString(),
    articleCount: normalized.length,
    copiedAssets,
    articles: normalized,
  };
  await fs.writeFile(path.join(snapshotDir, "materials.json"), JSON.stringify(snapshot, null, 2), "utf8");
  return { date, articleCount: normalized.length, copiedAssets: snapshot.copiedAssets, path: path.join(snapshotDir, "materials.json") };
}

export async function readWeeklyMaterialSnapshots({ root, from, to }) {
  const rootDir = path.join(root, "data", "weekly-snapshots");
  let entries = [];
  try { entries = await fs.readdir(rootDir, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    if (from && entry.name < from) continue;
    if (to && entry.name > to) continue;
    try {
      const raw = await fs.readFile(path.join(rootDir, entry.name, "materials.json"), "utf8");
      const snapshot = safeJson(raw, null);
      if (snapshot?.articles?.length) snapshots.push(snapshot);
    } catch {}
  }
  return snapshots.sort((left, right) => left.date.localeCompare(right.date));
}

/** 周报素材和其独立图片保留 90 天；活跃资讯 48 小时清理不会影响它。 */
export async function cleanupWeeklyMaterialSnapshots({ root, keepDays = 90, now = new Date() } = {}) {
  const rootDir = path.join(root, "data", "weekly-snapshots");
  const cutoff = new Date(now.getTime() - Math.max(1, Number(keepDays) || 90) * 86400000);
  const cutoffKey = shanghaiDateKey(cutoff);
  let entries = [];
  try { entries = await fs.readdir(rootDir, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return { deleted: 0, keepDays };
    throw error;
  }
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name) || entry.name >= cutoffKey) continue;
    await fs.rm(path.join(rootDir, entry.name), { recursive: true, force: true });
    deleted += 1;
  }
  return { deleted, keepDays, cutoff: cutoffKey };
}
