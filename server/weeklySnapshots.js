import fs from "node:fs/promises";
import path from "node:path";

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
 * 图片仅保留远程 URL，不复制本地图片缓存。
 */
export async function writeWeeklyMaterialSnapshot({ root, articles = [], generatedAt = new Date() }) {
  const date = shanghaiDateKey(generatedAt);
  const snapshotDir = path.join(root, "data", "weekly-snapshots", date);
  // 同一天再次生成时直接替换这份运行产物，避免快照无限膨胀。
  await fs.rm(snapshotDir, { recursive: true, force: true });
  await fs.mkdir(snapshotDir, { recursive: true });

  const normalized = selectWeeklyMaterials(articles.map(snapshotArticle));

  const snapshot = {
    version: 2,
    date,
    generatedAt: generatedAt.toISOString(),
    articleCount: normalized.length,
    copiedAssets: 0,
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
