import { load } from "cheerio";
import { firecrawlFallback } from "../rateLimiter.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Steam 全部固定到中国商店上下文：中文名称、可售状态与价格均按 CN 返回。
// 热玩榜官方没有按国家拆分的在线人数口径；cc=CN 仅锁定中国商店展示上下文，排名仍是 Steam 官方全站实时人数排名。
const FEATURED_API = "https://store.steampowered.com/api/featuredcategories?cc=CN&l=schinese";
const DETAIL_API = "https://store.steampowered.com/api/appdetails?appids=";
const SEARCH_PAGE = "https://store.steampowered.com/search/?category1=998&os=win&filter=popularnew&cc=CN&l=schinese";
const TOP_SELLERS_PAGE = "https://store.steampowered.com/search/?filter=globaltopsellers&cc=CN&l=schinese";
const MOST_PLAYED_CN_CHART = "https://store.steampowered.com/charts/mostplayed?cc=CN&l=schinese";
const TOP_SELLING_CN_CHART = "https://store.steampowered.com/charts/topselling/CN?l=schinese";
const TOP_SELLING_CN_LEGACY_PAGE = "https://store.steampowered.com/search/?filter=topsellers&cc=CN&l=schinese";
const MOST_PLAYED_API = "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/?cc=CN";
const REQUEST_TIMEOUT = 12000;
const RETRIES = 3;
const RETRY_DELAYS = [700, 1400, 2800];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 GameNews/1.0";

const ADULT = /\b(sex|porn|hentai|nsfw|nude|ero|fap|furry)\b/i;
const LOW_EFFORT = /\b(clicker|idle|match.?3|hidden.?object|jigsaw|mahjong|solitaire|poker|casino|slots?|slot.?grind)\b/i;
const ADD_ON = /\b(DLC|demo|beta|downloadable\s+content|season\s+pass|soundtrack|OST|bundle|expansion(?:\s+pack)?|anniversary\s+expansion|supporter\s+pack|supporter|upgrade|add[-\s]?on|bonus\s+pack|pre[-\s]?order)\b/i;
const TOOL_PRODUCT = /\b(server|dedicated\s+server|image\s+tools?|creator|editor|utility|toolkit|wallpaper|collectors?\s+plane)\b/i;
const CN_NON_GAME = /(下载内容|扩展包|季票|原声带|音乐包|演示版|试玩版|测试版|支持者包|工具|编辑器|服务器|壁纸|升级包|附加内容)/i;
const TOOL_DESCRIPTION = /(productivity\s+app|writing\s+tool|local\s+writing|desktop\s+app|screen\s+companion|desktop\s+pet|wallpaper|image\s+editor|video\s+editor|audio\s+production|four[-\s]in[-\s]one.*tool|software\s+for\s+(?:game|creative|writing)|scratchpad|script(?:ing)?\s+tool)/i;
const NON_GAME_GENRE = /^(utilities|software|design\s*&\s*illustration|animation\s*&\s*modeling|audio\s+production|video\s+production|photo\s+editing|web\s+publishing|education|game\s+development|accounting)$/i;
const NON_GAME_CATEGORY = /(utilities|software|game\s+development|steam\s+workshop|remote\s+play|教育|软件|工具|开发工具)/i;
const GAME_SIGNAL = /\b(game|adventure|quest|rpg|simulator|simulation|strategy|shooter|survival|horror|racing|tactics|tactical|story|chronicles|wars?|world|party|puzzle|roguelike|metroidvania)\b/i;
const MAJOR_GENRE = /(action|adventure|rpg|role[-\s]?playing|strategy|simulation|shooter|survival|horror|racing|sports|roguelike|metroidvania|动作|冒险|角色扮演|策略|模拟|射击|生存|恐怖|竞速|体育|肉鸽|银河恶魔城)/i;
const GAMEPLAY_CATEGORY = /(multiplayer|multi-player|co[-\s]?op|online co[-\s]?op|player versus|pvp|战斗|多人|合作|玩家对战|Steam 成就|完全支持控制器|single-player|单人)/i;
const GENERIC_TAG = /(Steam 成就|完全支持控制器|可调整|自定义音量|家庭共享|颜色|文字大小|视角舒适度|无需应对快速反应|单人|single[-\s]?player)/i;
const NON_GAMEPLAY_TAG = /(免费开玩|应用内购买|Steam\s*(成就|集换式卡牌|创意工坊|VR\s*收藏品)|已启用\s*Valve\s*反作弊|立体声|环绕声|部分支持控制器|完全支持控制器|DualSense|DUALSHOCK|控制器支持|随时保存|朗读游戏菜单|无障碍|跨平台保存|字幕|照片模式|色盲|辅助功能|家庭共享|远程同乐)/i;
const GAMEPLAY_TAG = /(action|adventure|rpg|role[-\s]?playing|strategy|simulation|shooter|fps|survival|horror|racing|sports|puzzle|platformer|roguelike|metroidvania|sandbox|open\s*world|management|farming|building|crafting|multiplayer|multi-player|co[-\s]?op|online co[-\s]?op|player versus|pvp|first[-\s]?person|third[-\s]?person|tactical|competitive|military|war|anime|psychological|动作|冒险|角色扮演|策略|模拟|射击|第一人称|第三人称|生存|恐怖|竞速|体育|益智|平台|肉鸽|银河恶魔城|沙盒|开放世界|经营|农场|建造|制作|多人|合作|玩家对战|竞技|团队导向|电竞|战术|军事|战争|回合制|卡牌|探索|潜行|叙事|剧情|资源管理|城市建造|塔防|格斗|竞速)/i;

const TAG_WEIGHTS = {
  multiplayer: 15, co_op: 15, survival: 15, roguelike: 14, rpg: 14,
  action: 13, horror: 13, souls_like: 13, open_world: 12, sandbox: 12,
  adventure: 10, strategy: 10, simulation: 10, fps: 10, shooter: 10,
  crafting: 9, building: 9, exploration: 9, metroidvania: 9,
  casual: 5, indie: 5, puzzle: 5, platformer: 5, visual_novel: 5,
  anime: 8, cute: 7, story_rich: 8, atmospheric: 7, difficult: 7,
  management: 6, farming: 6, tactical: 7, sexual_content: -20, nudity: -15,
};

const EMPTY_DETAIL = { ok: false, bonus: 0, zhName: "", desc: [], descriptionSnippet: "", releaseDate: "", tags: [], genres: [], categories: [], potentialScore: 0, rejectReasons: [], storePageStatus: "fetch_failed", tagStatus: "fetch_failed" };
const NEW_RELEASE_WINDOW_DAYS = 14;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);
}

export function parseSteamReleaseDate(value = "") {
  const text = String(value).trim();
  const chinese = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
  if (chinese) return new Date(Number(chinese[1]), Number(chinese[2]) - 1, Number(chinese[3]));
  const normalized = text.replace(/[年月]/g, "-").replace(/日/g, "").replace(/\./g, "-");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function classifySteamReleaseDate(value = "", now = new Date()) {
  const release = parseSteamReleaseDate(value);
  if (!release) return { category: "近期热点", suffix: "近期热点", isRecent: false, reliable: false };
  const ageDays = Math.floor((now.getTime() - release.getTime()) / 86400000);
  if (ageDays < 0) return { category: "近期热点", suffix: "近期热点", isRecent: false, reliable: true, future: true, ageDays };
  if (ageDays <= NEW_RELEASE_WINDOW_DAYS) return { category: "新游上线", suffix: "新游上线", isRecent: true, reliable: true, ageDays };
  return { category: "热门爆款", suffix: "热门爆款", isRecent: false, reliable: true, ageDays };
}
function normTag(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "_"); }
function cleanDesc(html = "") {
  return String(html).replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

export function cleanLocalizedSteamName(name = "") {
  return String(name)
    .replace(/^在\s*Steam\s*上(?:购买|预购)\s*/i, "")
    .replace(/^Steam\s*上的\s*/i, "")
    .replace(/\s*立省\s*\d+%.*$/i, "")
    .replace(/\s*购买.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function request(url, { parse = "text", timeout = REQUEST_TIMEOUT } = {}) {
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": UA, Accept: parse === "json" ? "application/json,text/plain,*/*" : "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        const error = new Error(`Steam HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const body = parse === "json" ? await response.json() : await response.text();
      if (parse === "json" && (!body || typeof body !== "object")) throw new Error("Steam JSON 结构无效");
      if (parse === "text" && (!body || body.length < 200)) throw new Error("Steam 页面内容过短");
      return body;
    } catch (error) {
      lastError = error;
      const retryable = error?.name === "TimeoutError" || error?.name === "AbortError" || error?.retryable !== false;
      if (!retryable || attempt >= RETRIES - 1) break;
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
  throw lastError || new Error("Steam 请求失败");
}

// Steam appdetails 在部分 Windows/Node 网络栈下会在动态榜单回退后出现连接中断。
// 仅对官方 JSON 详情使用 curl 兼容请求；榜单页面仍保持 fetch → Firecrawl 回退策略。
async function requestSteamDetails(url) {
  try {
    const { stdout } = await execFileAsync("curl.exe", [
      "-L", "--compressed", "--max-time", "15",
      "-A", UA, "-H", "Accept: application/json,text/plain,*/*", url,
    ], { maxBuffer: 8 * 1024 * 1024 });
    const payload = JSON.parse(stdout);
    if (!payload || typeof payload !== "object") throw new Error("Steam details JSON 无效");
    return payload;
  } catch (error) {
    throw new Error(`Steam appdetails 兼容请求失败: ${error.message}`);
  }
}

export function cleanSteamTitle(title = "") {
  return String(title)
    .replace(/\s*\[[^\]]+\]\s*/g, " ")
    .replace(/\s*\((?:OST|Soundtrack|Demo|Beta|DLC|Expansion|Supporter\s+Pack)\)\s*/gi, " ")
    .replace(/\s+/g, " ").trim();
}

export function isSteamNoiseTitle(title = "") {
  const value = cleanSteamTitle(title);
  return !value || ADULT.test(value) || LOW_EFFORT.test(value) || ADD_ON.test(value) || TOOL_PRODUCT.test(value) || CN_NON_GAME.test(value);
}

function hasGameSignal(title = "") {
  return GAME_SIGNAL.test(title) || /[：:!?'-]/.test(title) || /\d/.test(title);
}

function normalizeTags(tags = []) {
  return [...new Set(tags
    .map(tag => typeof tag === "string" ? tag : tag?.description)
    .map(tag => String(tag || "").replace(/\s+/g, " ").trim())
    .filter(Boolean))];
}

function selectSteamTags(genres = [], categories = [], tags = []) {
  const groups = [genres, categories, tags].map(group => normalizeTags(group)
    .filter(tag => GAMEPLAY_TAG.test(tag) && !GENERIC_TAG.test(tag) && !NON_GAMEPLAY_TAG.test(tag))
    .slice(0, 5));
  return [...new Set(groups.flat())].slice(0, 15);
}

function potentialGate({ name = "", desc = [], tags = [], genres = [], categories = [], type = "game" } = {}) {
  const normalizedName = cleanLocalizedSteamName(name);
  const text = `${normalizedName} ${desc.join(" ")} ${tags.join(" ")} ${genres.join(" ")} ${categories.join(" ")}`;
  const reasons = [];
  if (type !== "game") reasons.push(`type:${type}`);
  if (isSteamNoiseTitle(normalizedName)) reasons.push("title-noise");
  if (TOOL_DESCRIPTION.test(text)) reasons.push("tool-description");
  if (genres.some(item => NON_GAME_GENRE.test(item)) || categories.some(item => NON_GAME_CATEGORY.test(item))) reasons.push("non-game-category");
  if (ADULT.test(text)) reasons.push("adult");
  if (LOW_EFFORT.test(text)) reasons.push("low-effort");

  const descriptionLength = desc.join(" ").length;
  const gameGenres = genres.filter(item => !NON_GAME_GENRE.test(item));
  const positiveTags = [...genres, ...categories, ...tags].filter(tag => GAMEPLAY_TAG.test(tag));
  const majorGenre = gameGenres.some(item => MAJOR_GENRE.test(item)) || MAJOR_GENRE.test(text);
  const gameplayCategory = categories.some(item => GAMEPLAY_CATEGORY.test(item));
  let score = 0;
  score += descriptionLength >= 280 ? 28 : descriptionLength >= 120 ? 18 : descriptionLength >= 60 ? 8 : -18;
  score += majorGenre ? 24 : (gameGenres.length ? 8 : 0);
  score += Math.min(24, positiveTags.length * 6);
  score += hasGameSignal(normalizedName) ? 6 : 0;
  score += gameplayCategory ? 10 : 0;
  if (!majorGenre && !gameplayCategory) reasons.push("weak-game-signal");
  if (descriptionLength < 120) reasons.push("short-description");
  if (positiveTags.length === 0) reasons.push("no-game-tags");
  if (reasons.length) score -= 60;
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function scoreDetail(detail, name) {
  const bonus = detail.tags.reduce((sum, tag) => sum + (TAG_WEIGHTS[normTag(tag)] || 0), 0);
  const hasDescription = detail.desc.some(text => text.length >= 30);
  return Math.max(10, Math.min(95, 45
    + (detail.releaseDate ? 12 : 0)
    + (hasDescription ? 12 : -18)
    + (hasGameSignal(name) ? 5 : 0)
    + Math.round(Math.max(-30, Math.min(35, bonus)) * 0.45)));
}

function parseStorePage(html, appId = "") {
  const $ = load(html);
  const title = cleanLocalizedSteamName(cleanSteamTitle($("#appHubAppName").text() || $(".apphub_AppName").text() || $("meta[property='og:title']").attr("content") || $("title").text()));
  // 新游内容统一优先用商店卡片的简介，避免把“关于此游戏”的长正文直接塞进列表。
  const descriptionSnippet = cleanDesc($(".game_description_snippet").first().text());
  const description = descriptionSnippet || cleanDesc($("#game_area_description").text() || $("meta[property='og:description']").attr("content"));
  const releaseDate = cleanDesc($(".release_date .date").first().text() || $(".date").first().text());
  const tags = normalizeTags($(".glance_tags a, .app_tag").map((_, el) => $(el).text()).get());
  const genres = normalizeTags($(".details_block a[href*='/genre/']").map((_, el) => $(el).text()).get());
  const paragraphs = description ? [description] : [];
  const imageUrl = $("meta[property='og:image']").attr("content") || "";
  const gate = potentialGate({ name: title, desc: paragraphs, tags, genres });
  return {
    ok: Boolean(title),
    name: title,
    zhName: /[\u4e00-\u9fff]/.test(title) ? title : "",
    desc: paragraphs,
    descriptionSnippet: descriptionSnippet || description,
    releaseDate,
    tags,
    genres,
    categories: [],
    potentialScore: gate.score,
    rejectReasons: gate.reasons,
    imageUrl,
    appId: String(appId || $("[data-ds-appid]").first().attr("data-ds-appid") || ""),
    storePageStatus: "ok",
    tagStatus: selectSteamTags(genres, [], tags).length ? "available" : (tags.length ? "no_gameplay_tags" : "no_tags"),
  };
}

async function fetchStorePage(appId) {
  const url = `https://store.steampowered.com/app/${appId}/?cc=CN&l=schinese`;
  try {
    const html = await request(url);
    const detail = parseStorePage(html, appId);
    if (detail.ok && !isSteamNoiseTitle(detail.name)) return { ...detail, rejected: detail.rejectReasons?.length > 0 || detail.potentialScore < 55 };
  } catch (error) {
    console.warn(`[steam] 商店页回退失败 app=${appId}: ${error.message}`);
  }
  const fallback = await firecrawlFallback(url);
  if (!fallback) return { ...EMPTY_DETAIL };
  const detail = parseStorePage(fallback, appId);
  return detail.ok && !isSteamNoiseTitle(detail.name)
    ? { ...detail, rejected: detail.rejectReasons?.length > 0 || detail.potentialScore < 55 }
    : { ...EMPTY_DETAIL, rejected: true };
}

async function fetchDetail(appId) {
  // 中文商店页优先：它同时提供本地化名称、完整简介、发行日期和社区标签。
  let localizedPage = null;
  try { localizedPage = await fetchStorePage(appId); } catch (pageError) {
    console.warn(`[steam] 中文商店页预抓失败 app=${appId}: ${pageError.message}`);
  }
  try {
    const data = await request(`${DETAIL_API}${appId}&cc=CN&l=schinese`, { parse: "json" });
    const entry = data?.[String(appId)];
    if (!entry?.success || !entry.data || typeof entry.data !== "object") throw new Error("Steam appdetails 无有效数据");
    const game = entry.data;
    if (game.type !== "game") return { ...EMPTY_DETAIL, rejected: true };
    const genres = normalizeTags(game.genres || []);
    const categories = normalizeTags(game.categories || []);
    const tags = normalizeTags([...(localizedPage?.tags || []), ...genres, ...categories, ...(game.tags || [])]);
    const desc = [];
    if (localizedPage?.desc?.length) desc.push(...localizedPage.desc);
    if (game.short_description) desc.push(cleanDesc(game.short_description));
    const detailed = cleanDesc(game.detailed_description || "");
    for (const paragraph of detailed.split(/(?<=[。！？.!?])\s+/)) {
      if (paragraph.length >= 20 && !/收藏|购买|预购|DLC|扩展内容|合集|礼包|立即|愿望单|即将推出/.test(paragraph)) desc.push(paragraph);
      if (desc.length >= 4) break;
    }
    let zhName = localizedPage?.zhName || (/[\u4e00-\u9fff]/.test(game.name || "") ? String(game.name).trim() : "");
    const name = cleanLocalizedSteamName(zhName || String(game.name || "").trim());
    const gate = potentialGate({ name, desc: desc.slice(0, 4), tags, genres, categories, type: game.type });
    const filteredTags = selectSteamTags(normalizeTags([...(localizedPage?.genres || []), ...genres]), categories, tags);
    const descriptionSnippet = localizedPage?.descriptionSnippet || cleanDesc(game.short_description || "");
    const result = {
      ok: true, name, zhName, desc: desc.slice(0, 4), releaseDate: localizedPage?.releaseDate || game.release_date?.date || "",
      descriptionSnippet,
      tags, genres: normalizeTags([...(localizedPage?.genres || []), ...genres]), categories, potentialScore: gate.score, rejectReasons: gate.reasons,
      imageUrl: game.header_image || localizedPage?.imageUrl || "",
      storePageStatus: localizedPage?.storePageStatus || "fetch_failed",
      tagStatus: filteredTags.length ? "available" : (localizedPage?.storePageStatus === "ok" ? "no_gameplay_tags" : "fetch_failed"),
    };
    if (gate.reasons.length || gate.score < 55) return { ...result, rejected: true };
    return result;
  } catch (error) {
    console.warn(`[steam] appdetails 失败 app=${appId}: ${error.message}`);
    if (localizedPage?.ok) return localizedPage;
    return fetchStorePage(appId);
  }
}

function parseSearchPage(html) {
  const $ = load(html);
  return $("a.search_result_row").map((index, el) => {
    const id = $(el).attr("data-ds-appid")?.split(",")[0] || $(el).attr("data-ds-itemkey")?.replace("App_", "");
    const name = cleanSteamTitle($(el).find(".title").text());
    const imageUrl = $(el).find("img").attr("src") || "";
    const rankText = $(el).find(".search_rank").first().text();
    // Top Sellers 页面当前按搜索结果顺序返回条目；页面未必提供 data-rank，
    // 因此用 DOM 顺序补齐排名，避免把整页候选误判为“无排名”。
    const rank = Number(String($(el).attr("data-rank") || rankText || "").replace(/\D/g, "")) || index + 1;
    return id && name && !isSteamNoiseTitle(name) ? { id, name, imageUrl, rank } : null;
  }).get().filter(Boolean);
}

function parseSteamChartPage(html, { chartKind, limit = 5 } = {}) {
  const $ = load(html);
  const rows = [];
  $("table tbody tr").each((_, element) => {
    const row = $(element);
    const cells = row.children("td");
    const links = row.find('a[href*="/app/"]').toArray().map(link => $(link));
    const appLink = links.find(link => cleanLocalizedSteamName(link.text()).length > 0) || links[0];
    const href = appLink?.attr("href") || "";
    const appId = /\/app\/(\d+)/.exec(href)?.[1];
    const name = cleanLocalizedSteamName(cleanSteamTitle(appLink?.text() || ""));
    const rank = Number($(cells[1]).text().replace(/\D/g, ""));
    if (!appId || !name || !Number.isInteger(rank) || rank < 1) return;
    const imageUrl = row.find("img").first().attr("src") || "";
    const base = { id: appId, name, rank, imageUrl, detailUrl: `https://store.steampowered.com/app/${appId}/?cc=CN&l=schinese` };
    if (chartKind === "most_played") {
      rows.push({ ...base, currentPlayers: $(cells[4]).text().replace(/\s+/g, " ").trim(), dailyPeak: $(cells[5]).text().replace(/\s+/g, " ").trim() });
    } else if (chartKind === "top_selling_cn") {
      rows.push({ ...base, rankChange: $(cells[4]).text().replace(/\s+/g, " ").trim(), weeksOnChart: $(cells[5]).text().replace(/\s+/g, " ").trim() });
    }
  });
  return rows.slice(0, limit);
}

function parseMostPlayedApi(payload, limit = 5) {
  const ranks = payload?.response?.ranks;
  if (!Array.isArray(ranks)) return [];
  return ranks
    .map(item => ({
      id: String(item?.appid || ""),
      rank: Number(item?.rank),
      dailyPeak: Number(item?.peak_in_game || 0) || null,
    }))
    .filter(item => /^\d+$/.test(item.id) && Number.isInteger(item.rank) && item.rank > 0)
    .slice(0, limit);
}

async function hydrateChartGames(items) {
  const hydrated = [];
  // Steam 对批量 appids 偶发超时，因此使用小并发的单 App 请求；
  // 详情页字段仍全部来自中国区 appdetails API。
  const BATCH = 3;
  for (let offset = 0; offset < items.length; offset += BATCH) {
    const chunk = items.slice(offset, offset + BATCH);
    const payloads = await Promise.all(chunk.map(async item => {
      try { return await requestSteamDetails(`${DETAIL_API}${item.id}&cc=CN&l=schinese`); } catch { return null; }
    }));
    for (let index = 0; index < chunk.length; index += 1) {
      const item = chunk[index];
      const game = payloads[index]?.[String(item.id)]?.data;
      if (!game || game.type !== "game" || !game.name) continue;
      const genres = normalizeTags(game.genres || []);
      const categories = normalizeTags(game.categories || []);
      const tags = normalizeTags([...(game.tags || []), ...genres, ...categories]);
      const descriptionSnippet = cleanDesc(game.short_description || "");
      const gate = potentialGate({ name: game.name, desc: descriptionSnippet ? [descriptionSnippet] : [], tags, genres, categories, type: game.type });
      if (gate.reasons.length || gate.score < 55) continue;
      const gameplayTags = selectSteamTags(genres, categories, tags);
      hydrated.push({
        ...item,
        name: cleanLocalizedSteamName(game.name) || item.name,
        imageUrl: game.header_image || item.imageUrl || "",
        detailUrl: `https://store.steampowered.com/app/${item.id}/?cc=CN&l=schinese`,
        tags: gameplayTags,
        genres,
        categories,
        descriptionSnippet,
        potentialScore: gate.score,
        rejectReasons: gate.reasons,
        storePageStatus: "appdetails_cn",
        tagStatus: gameplayTags.length ? "available" : "no_gameplay_tags",
        currentPlayers: item.currentPlayers ?? null,
      });
    }
  }
  return hydrated;
}

async function fetchMostPlayedChart(limit = 15) {
  // 动态 chart HTML 常返回反爬壳；先走官方 JSON API，避免先等待动态回退。
  try {
    const payload = await request(MOST_PLAYED_API, { parse: "json" });
    // 只对高位候选补 appdetails：前端最多展示 5 条变化项，继续为完整前15逐批请求会拖慢全局更新。
    const baseItems = parseMostPlayedApi(payload, Math.min(limit, 8));
    const items = await hydrateChartGames(baseItems);
    if (items.length) return { items, via: "steam-chart-api-fallback" };
    if (baseItems.length) {
      return {
        items: baseItems.map((item) => ({
          ...item,
          name: item.name || `Steam App ${item.id}`,
          detailUrl: `https://store.steampowered.com/app/${item.id}/?cc=CN&l=schinese`,
          tags: [],
          storePageStatus: "fetch_failed",
          tagStatus: "fetch_failed",
        })),
        via: "steam-chart-api-base",
      };
    }
  } catch (error) {
    console.warn(`[steam] 热玩 API 兜底失败: ${error.message}`);
  }
  return fetchSteamChart(MOST_PLAYED_CN_CHART, "most_played", limit, { waitFor: 8000 });
}

async function fetchTopSellingCNChart(limit = 15) {
  // 中国商店搜索页即使带反爬标记仍含 search_result_row，优先稳定回退。
  try {
    const items = parseSearchPage(await request(TOP_SELLING_CN_LEGACY_PAGE))
      .slice(0, limit)
      .map(item => ({
        ...item,
        rankChange: "—",
        weeksOnChart: "—",
        detailUrl: `https://store.steampowered.com/app/${item.id}/?cc=CN&l=schinese`,
      }));
    // 搜索结果只提供名次和封面。只同步补全页面展示的前五名，并给每条硬超时；
    // 不让 15 条 appdetails 的重试链路阻塞整轮候选抓取。
    const enriched = await Promise.all(items.slice(0, 5).map(async (item) => {
      try {
        return await withTimeout(enrichSteamChartItem(item), 6500);
      } catch {
        return null;
      }
    }));
    const enrichedById = new Map(enriched.filter((item) => item && !item.rejected).map((item) => [String(item.appId), item]));
    const completed = items.map((item) => {
      const detail = enrichedById.get(String(item.id));
      return detail ? {
        ...item,
        name: detail.gameName || item.name,
        imageUrl: detail.imageUrl || item.imageUrl,
        tags: detail.tags || [],
        genres: detail.genres || [],
        categories: detail.categories || [],
        descriptionSnippet: detail.descriptionSnippet || "",
        storePageStatus: detail.storePageStatus || "appdetails_cn",
        tagStatus: detail.tagStatus || "no_gameplay_tags",
      } : { ...item, storePageStatus: "fetch_failed", tagStatus: "fetch_failed" };
    });
    if (completed.length) return { items: completed, via: "steam-cn-store-search+top5-appdetails" };
  } catch (error) {
    console.warn(`[steam] 中国商店畅销回退失败: ${error.message}`);
  }
  return fetchSteamChart(TOP_SELLING_CN_CHART, "top_selling_cn", limit, { waitFor: 8000 });
}

async function fetchSteamChart(url, chartKind, limit = 5, { waitFor = 0 } = {}) {
  try {
    const items = parseSteamChartPage(await request(url), { chartKind, limit });
    if (!items.length) throw new Error("榜单页面没有可解析条目");
    return { items, via: "steam-chart" };
  } catch (error) {
    console.warn(`[steam] ${chartKind} 榜单页面失败，尝试 Firecrawl 回退: ${error.message}`);
    // Firecrawl 只作为最终兜底，并设置硬超时；超时不能阻塞整轮候选抓取。
    const fallback = await withTimeout(firecrawlFallback(url, { waitFor }), 15000);
    return { items: fallback ? parseSteamChartPage(fallback, { chartKind, limit }) : [], via: fallback ? "firecrawl-chart" : "none" };
  }
}

export async function fetchSteamChartItems({ limit = 15 } = {}) {
  // 两个动态榜单都可能触发 Firecrawl 回退；串行避免 SDK 并发请求互相中断，
  // 代价可控（榜单是手动/定时低频刷新），稳定性优先。
  const mostPlayed = await fetchMostPlayedChart(limit);
  const topSellingCN = await fetchTopSellingCNChart(limit);
  const snapshotId = new Date().toISOString();
  const toArticle = (item, chartKind) => {
    const isMostPlayed = chartKind === "most_played";
    const metric = isMostPlayed
      ? { currentPlayers: item.currentPlayers || "—", dailyPeak: item.dailyPeak || "—" }
      : { rankChange: item.rankChange || "—", weeksOnChart: item.weeksOnChart || "—" };
    return {
      title: `《${item.name}》${isMostPlayed ? "Steam 热玩榜" : "Steam 畅销榜（中国区）"} #${item.rank}`,
      gameName: item.name, category: isMostPlayed ? "Steam 热玩榜" : "Steam 畅销榜（中国区）",
      detailUrl: item.detailUrl, imageUrl: item.imageUrl, sourceId: "ref-steam", sourceName: "Steam",
      score: Math.max(50, 100 - item.rank), paragraphs: item.descriptionSnippet ? [item.descriptionSnippet] : [],
      tags: item.tags || [], genres: item.genres || [], categories: item.categories || [],
      potentialScore: item.potentialScore || 0, rejectReasons: item.rejectReasons || [], dateText: new Date().toLocaleDateString("zh-CN"),
      // 榜单基础快照必须先落库；详情字段由第二阶段独立补全。
      storePageStatus: item.storePageStatus || "pending_enrichment", tagStatus: item.tagStatus || "pending_enrichment",
      listKind: chartKind, rankCurrent: item.rank, chartMetric: metric, snapshotId,
    };
  };
  console.log(`[steam] 热玩榜=${mostPlayed.items.length}(${mostPlayed.via}) 中国区畅销榜=${topSellingCN.items.length}(${topSellingCN.via})`);
  return [...mostPlayed.items.map(item => toArticle(item, "most_played")), ...topSellingCN.items.map(item => toArticle(item, "top_selling_cn"))];
}

/**
 * Steam 榜单详情补全：只请求官方 appdetails，不调用 Firecrawl。
 * 失败由调用方按单项隔离，不能影响已落库的排名快照。
 */
export async function enrichSteamChartItem(item) {
  const appId = String(item?.appId || item?.id || /\/app\/(\d+)/.exec(item?.detailUrl || "")?.[1] || "");
  if (!/^\d+$/.test(appId)) return null;
  const payload = await requestSteamDetails(`${DETAIL_API}${appId}&cc=CN&l=schinese`);
  const game = payload?.[appId]?.data;
  if (!game || game.type !== "game" || !game.name) return { rejected: true, rejectReasons: ["non-game-or-unavailable"] };
  const genres = normalizeTags(game.genres || []);
  const categories = normalizeTags(game.categories || []);
  const tags = normalizeTags([...(game.tags || []), ...genres, ...categories]);
  const gameplayTags = selectSteamTags(genres, categories, tags);
  const name = cleanLocalizedSteamName(game.name) || item.gameName || item.name || "";
  if (isSteamNoiseTitle(name)) return { rejected: true, rejectReasons: ["title-noise"] };
  return {
    appId,
    gameName: name,
    imageUrl: game.header_image || item.imageUrl || "",
    tags: gameplayTags,
    genres,
    categories,
    descriptionSnippet: cleanDesc(game.short_description || ""),
    tagStatus: gameplayTags.length ? "available" : "no_gameplay_tags",
    storePageStatus: "appdetails_cn",
    rejected: false,
    rejectReasons: [],
  };
}

async function fetchCandidates(maxCandidates = 24) {
  try {
    const data = await request(FEATURED_API, { parse: "json" });
    const items = data?.new_releases?.items;
    if (!Array.isArray(items) || !items.length) throw new Error("featuredcategories 缺少 new_releases.items");
    return { items: items.filter(item => item?.id && !isSteamNoiseTitle(item.name)).slice(0, maxCandidates), via: "api" };
  } catch (error) {
    console.warn(`[steam] 新游 API 失败，切换商店搜索页: ${error.message}`);
    try {
      const items = parseSearchPage(await request(SEARCH_PAGE));
      if (items.length) return { items: items.slice(0, maxCandidates), via: "store-search" };
    } catch (pageError) {
      console.warn(`[steam] 商店搜索页失败: ${pageError.message}`);
    }
    const fallback = await firecrawlFallback(SEARCH_PAGE);
    const items = fallback ? parseSearchPage(fallback) : [];
    return { items: items.slice(0, maxCandidates), via: fallback ? "firecrawl-search" : "none" };
  }
}

async function fetchTopSellerCandidates(maxCandidates = 30) {
  try {
    const items = parseSearchPage(await request(TOP_SELLERS_PAGE));
    if (!items.length) throw new Error("Top Sellers 页面没有可解析的游戏条目");
    return { items: items.filter(item => Number.isInteger(item.rank) && item.rank > 0).slice(0, maxCandidates), via: "top-sellers-page" };
  } catch (error) {
    console.warn(`[steam] Top Sellers 页面失败，尝试 Firecrawl 回退: ${error.message}`);
    const fallback = await firecrawlFallback(TOP_SELLERS_PAGE);
    const items = fallback ? parseSearchPage(fallback) : [];
    return { items: items.filter(item => Number.isInteger(item.rank) && item.rank > 0).slice(0, maxCandidates), via: fallback ? "firecrawl-top-sellers" : "none" };
  }
}

async function hydrateSteamCandidates(candidates, { listKind }) {
  const result = [];
  const BATCH = 3;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const chunk = candidates.slice(i, i + BATCH);
    const details = await Promise.all(chunk.map(candidate => fetchDetail(candidate.id)));
    for (let index = 0; index < chunk.length; index++) {
      const candidate = chunk[index];
      const detail = details[index];
      if (detail.rejected) continue;
      const rawName = cleanSteamTitle(candidate.name || detail.name || "");
      const name = detail.zhName || rawName;
      if (isSteamNoiseTitle(name)) continue;
      const releaseClass = classifySteamReleaseDate(detail.releaseDate);
      // 新游表仅保留已在近 14 天内发售的游戏；未来日期、无法确认日期和旧作不混入新游表。
      if (listKind === "new" && !releaseClass.isRecent) continue;
      const isHot = listKind === "hot";
      result.push({
        title: isHot ? `《${name}》热门上升候选` : `《${name}》新游上线`,
        gameName: name,
        category: isHot ? "热点上升" : "新游上线",
        detailUrl: `https://store.steampowered.com/app/${candidate.id}/`,
        imageUrl: detail.imageUrl || candidate.header_image || candidate.imageUrl || "",
        sourceId: "ref-steam", sourceName: "Steam", score: scoreDetail(detail, name),
        paragraphs: listKind === "new" && detail.descriptionSnippet ? [detail.descriptionSnippet] : (detail.desc || []),
        descriptionSnippet: detail.descriptionSnippet || "",
        tags: selectSteamTags(detail.genres || [], detail.categories || [], detail.tags || []), genres: detail.genres || [], categories: detail.categories || [],
        potentialScore: detail.potentialScore || 0, rejectReasons: detail.rejectReasons || [],
        dateText: detail.releaseDate || "",
        listKind,
        rankCurrent: isHot ? candidate.rank : null,
      });
    }
    if (i + BATCH < candidates.length) await sleep(450);
  }
  return result;
}

export async function fetchSteamItems({ maxCandidates = 24 } = {}) {
  const newResult = await fetchCandidates(maxCandidates);
  console.log(`[steam] 新游候选=${newResult.items.length}(${newResult.via})`);
  const newItems = await hydrateSteamCandidates(newResult.items, { listKind: "new" });
  return newItems.sort((a, b) => b.score - a.score).slice(0, 5);
}

export function contentFilter(title = "") { return !isSteamNoiseTitle(title); }
export function isDetailUrl() { return true; }
export { parseSearchPage, parseStorePage, parseSteamChartPage, parseMostPlayedApi, potentialGate, selectSteamTags, fetchTopSellerCandidates };
