import { fetchSteamBoardNames, isSteamNoiseTitle } from "./crawler/platforms/steam.js";
import { db } from "./database.js";

const CACHE_TTL_MS = Math.max(60_000, Number(process.env.STEAM_BOARD_CACHE_TTL_MS || 10 * 60_000));
let cache = { expiresAt: 0, value: null };

// Steam 同一张 header 图会在多个官方 CDN 主机上提供。国内镜像优先是为了避免
// Fastly 在当前网络下的间歇性超时；浏览器仍可按顺序回退到 Steam 官方 CDN。
const STEAM_IMAGE_HOSTS = [
  "shared.cdn.queniuqe.com",
  "shared.akamai.steamstatic.com",
  "shared.cloudflare.steamstatic.com",
  "shared.fastly.steamstatic.com",
];
const STEAM_IMAGE_SOURCE_HOSTS = new Set(STEAM_IMAGE_HOSTS);

function nameItem(name, index, kind, imageUrl = "", detailUrl = "") {
  const gameName = normalizeGameName(name);
  const imageUrls = steamImageCandidates(imageUrl);
  return {
    id: `${kind}-${index}-${gameName}`,
    gameName,
    title: gameName,
    rank: index + 1,
    kind,
    imageUrl: imageUrls[0] || "",
    imageFallbackUrls: imageUrls.slice(1),
    detailUrl,
  };
}

function normalizeGameName(value = "") {
  const gameName = String(value || "").replace(/^《|》$/gu, "").trim();
  // Steam AppID 是链接定位信息，不是用户可读的游戏名称。
  if (/^\d{3,}$/u.test(gameName) || /\b(?:steam\s*(?:app)?\s*id|steamid|appid)\b/i.test(gameName)) return "";
  return gameName;
}

function steamImageCandidates(value = "") {
  const imageUrl = String(value || "").trim();
  if (!imageUrl) return [];
  try {
    const url = new URL(imageUrl);
    if (!STEAM_IMAGE_SOURCE_HOSTS.has(url.hostname)) return [imageUrl];
    // 仅替换主机，保留榜单/API 给出的图片路径与查询参数，避免按游戏名猜图。
    return [...new Set(STEAM_IMAGE_HOSTS.map((hostname) => {
      const candidate = new URL(url);
      candidate.hostname = hostname;
      return candidate.toString();
    }))];
  } catch {
    return [imageUrl];
  }
}

function normalizeSteamImageUrl(value = "") {
  return steamImageCandidates(value)[0] || "";
}

function fallbackHeader() {
  // 没有可验证的首图时宁可留空，不拼接可能不可达的 CDN 地址。
  return "";
}

function storedBoardItem(row, facts = {}) {
  const detailUrl = String(row.detail_url || "");
  return {
    gameName: normalizeGameName(row.game_name || row.title || ""),
    imageUrl: normalizeSteamImageUrl(row.image_url) || fallbackHeader(detailUrl),
    detailUrl,
    rank: Number(facts.steamRankCurrent || 0) || null,
  };
}

function isChineseTitle(value = "") {
  return /[\u3400-\u9fff]/u.test(String(value));
}

function isDisplayableGame(item) {
  const gameName = normalizeGameName(item?.gameName);
  return Boolean(gameName && item?.detailUrl) && !isSteamNoiseTitle(gameName);
}

// 商店新游里中英文混排很常见。中文标题优先，英文条目仍作为补位，
// 让榜单在中文资讯页更易读，同时不丢掉真正有热度的游戏。
function prioritizeChinese(items = []) {
  return [...items].sort((left, right) => Number(isChineseTitle(right.gameName)) - Number(isChineseTitle(left.gameName)));
}

// 榜单接口偶发超时不应让今日简讯变空。这里只读本项目上一轮 Steam 快照，
// 不写数据库、不把旧快照伪装成实时数据；实时数据恢复后会立即覆盖它。
function getStoredSteamBoards(limit = 10) {
  const rows = db.prepare("SELECT game_name, title, detail_url, image_url, facts, updated_at FROM articles WHERE source_id = ? ORDER BY updated_at DESC").all("ref-steam");
  const entries = rows.map((row) => {
    try { return { row, facts: JSON.parse(row.facts || "{}") }; } catch { return { row, facts: {} }; }
  });
  const latestSnapshot = entries
    .filter(({ facts }) => facts.steamList === "top_selling_cn")
    .reduce((latest, { facts }) => String(facts.steamSnapshotId || "") > latest ? String(facts.steamSnapshotId || "") : latest, "");
  const hot = prioritizeChinese(entries
    .filter(({ facts }) => facts.steamList === "top_selling_cn")
    .filter(({ facts }) => !latestSnapshot || facts.steamSnapshotId === latestSnapshot)
    .sort((a, b) => Number(a.facts.steamRankCurrent || Number.MAX_SAFE_INTEGER) - Number(b.facts.steamRankCurrent || Number.MAX_SAFE_INTEGER))
    .map(({ row, facts }) => storedBoardItem(row, facts))
    .filter(isDisplayableGame))
    .slice(0, limit);
  const seen = new Set();
  const newGames = prioritizeChinese(entries
    .filter(({ facts }) => facts.steamList === "new")
    .map(({ row, facts }) => storedBoardItem(row, facts))
    .filter((item) => isDisplayableGame(item) && !seen.has(item.detailUrl) && seen.add(item.detailUrl)))
    .slice(0, limit);
  return { hot, newGames };
}

function mergeBoards(primary = [], fallback = [], limit = 10) {
  const seen = new Set();
  return prioritizeChinese([...primary, ...fallback]
    .filter(isDisplayableGame)
    .filter((item) => {
      const key = item.detailUrl || item.gameName;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }))
    .slice(0, limit);
}

export async function getSteamBoards({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && cache.expiresAt > now) return cache.value;
  try {
    const result = await fetchSteamBoardNames({ limit: 10 });
    const stored = getStoredSteamBoards(10);
    const value = {
      hot: mergeBoards(result.hot, stored.hot).map((item, index) => nameItem(item.gameName, index, "hot", item.imageUrl || fallbackHeader(item.detailUrl), item.detailUrl)),
      newGames: mergeBoards(result.newGames, stored.newGames).map((item, index) => nameItem(item.gameName, index, "new", item.imageUrl || fallbackHeader(item.detailUrl), item.detailUrl)),
      generatedAt: new Date().toISOString(),
      source: "Steam 中国区商店（热门畅销榜与新游）",
      error: null,
    };
    cache = { expiresAt: now + CACHE_TTL_MS, value };
    return value;
  } catch (error) {
    if (cache.value) return { ...cache.value, stale: true, error: error.message || "Steam 榜单暂时无法获取" };
    const stored = getStoredSteamBoards(10);
    return {
      hot: prioritizeChinese(stored.hot).map((item, index) => nameItem(item.gameName, index, "hot", item.imageUrl, item.detailUrl)),
      newGames: prioritizeChinese(stored.newGames).map((item, index) => nameItem(item.gameName, index, "new", item.imageUrl, item.detailUrl)),
      generatedAt: new Date().toISOString(),
      source: "Steam 中国区商店（本地快照兜底）",
      stale: true,
      error: error.message || "Steam 榜单暂时无法获取",
    };
  }
}
