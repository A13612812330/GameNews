import * as cheerio from "cheerio";

const BASE_URL = "https://www.x7sy.com";

function cleanText(value = "") {
  return String(value || "")
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function resolveUrl(value = "", base = BASE_URL) {
  try { return new URL(value, base).href; } catch { return ""; }
}

function reviveNuxtPayload(raw) {
  const cache = new Map();
  const resolving = new Set();
  const resolve = (value) => {
    if (typeof value !== "number") return value;
    if (cache.has(value)) return cache.get(value);
    if (resolving.has(value)) return null;
    resolving.add(value);
    const source = raw[value];
    let result;
    if (Array.isArray(source)) result = source.map(resolve);
    else if (source && typeof source === "object") {
      result = {};
      for (const [key, entry] of Object.entries(source)) result[key] = resolve(entry);
    } else result = source;
    resolving.delete(value);
    cache.set(value, result);
    return result;
  };
  return resolve(0);
}

function extractNuxtState(html = "") {
  const $ = cheerio.load(html);
  const raw = $("script#__NUXT_DATA__,script[type='application/json'][data-nuxt-data]").first().text();
  if (!raw) return null;
  try {
    const state = reviveNuxtPayload(JSON.parse(raw));
    // Nuxt SSR 的根节点是 ["ShallowReactive", data]；取内部对象才有 data/state 字段。
    return Array.isArray(state) && state[0] === "ShallowReactive" ? state[1] : state;
  } catch { return null; }
}

function unwrapReactive(value) {
  let current = value;
  while (Array.isArray(current) && current[0] === "ShallowReactive") current = current[1];
  return current;
}

function parseClock(text = "") {
  const match = /(?:上午|下午|早上|晚上|早)?\s*(\d{1,2})(?::|点)(\d{1,2})?/u.exec(text);
  if (!match) return { hour: 0, minute: 0 };
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (/下午|晚上/u.test(text) && hour < 12) hour += 12;
  return { hour, minute };
}

function parseCount(value = "") {
  const match = String(value || "").replace(/[\s,，]/gu, "").match(/([\d.]+)\s*([万亿]?)/u);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const multiplier = match[2] === "亿" ? 100000000 : match[2] === "万" ? 10000 : 1;
  return Math.round(amount * multiplier);
}

function parseLaunchTime(serviceTime, dateText, statusText) {
  const timestamp = Number(serviceTime || 0) * 1000;
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  const date = /(?:(20\d{2})年)?\s*(\d{1,2})[\-/月](\d{1,2})/u.exec(`${dateText} ${statusText}`);
  if (!date) return 0;
  const now = new Date();
  const clock = parseClock(statusText);
  const result = new Date(
    Number(date[1] || now.getFullYear()),
    Number(date[2]) - 1,
    Number(date[3]),
    clock.hour,
    clock.minute,
  );
  if (!date[1] && result.getTime() < now.getTime() - 180 * 86400000) result.setFullYear(result.getFullYear() + 1);
  return result.getTime();
}

function isTodayOrFuture(timestamp, days = 7) {
  if (!timestamp) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 999);
  return timestamp >= today.getTime() && timestamp <= end.getTime();
}

function formatDate(timestamp, statusText = "") {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  const time = date.getHours() || date.getMinutes()
    ? ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : "";
  const status = /测试|内测|公测|开测/u.test(statusText) ? "测试" : /预下载/u.test(statusText) ? "预下载" : /首发/u.test(statusText) ? "首发" : "上线";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${time}${status}`;
}

function labelsOf(gameData = {}) {
  return [...new Set((gameData.labels || [])
    .map((item) => cleanText(item?.labelName || item?.name || item))
    .filter(Boolean))].slice(0, 8);
}

function findGameItems(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) findGameItems(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  if (value.gameData?.gid) result.push(value);
  for (const child of Object.values(value)) findGameItems(child, result);
  return result;
}

function parseItem(item, baseUrl = BASE_URL) {
  const game = item?.gameData || {};
  const gameName = cleanText(game.showName || game.gameName);
  const statusText = cleanText(game.onlineTimeText || game.showText || item.collectionTitle || "");
  const timestamp = parseLaunchTime(item.serviceTime, item.collectionTitle, statusText);
  const tags = labelsOf(game);
  const detailUrl = resolveUrl(`/game/app/${game.gid}`, baseUrl);
  if (!gameName || !game.gid || !detailUrl || !isTodayOrFuture(timestamp)) return null;
  const reserveCount = Number.parseInt(String(item.subscribeData?.subscribeCount || game.playerNum || "").replace(/\D/g, ""), 10) || 0;
  return {
    title: `《${gameName}》${formatDate(timestamp, statusText)}`,
    gameName,
    detailUrl,
    imageUrl: resolveUrl(game.gameLogo, baseUrl),
    dateText: formatDate(timestamp, statusText),
    paragraphs: [statusText].filter(Boolean),
    sourceTags: tags,
    category: "新游上线",
    score: reserveCount,
    eventReleaseTime: timestamp,
    facts: {
      x7LaunchTime: timestamp,
      x7LaunchStatus: statusText,
      x7Tags: tags,
      x7ReserveCount: reserveCount || null,
    },
  };
}

export function parseApiPage(payload, baseUrl = BASE_URL) {
  const items = findGameItems(payload);
  return items.map((item) => parseItem(item, baseUrl)).filter(Boolean);
}

export async function fetchReservePages({ maxPages = 12, pageSize = 10 } = {}) {
  const results = [];
  let lastError = "";
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const response = await fetch("https://x7market.x7sy.com/v5/home/gameList", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json, text/plain, */*",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
          "x7web-user-agent": "X7Market/6.30.1/Android/10/cloudPhone/MARKETiOS_IOS/bfe0528c145d9b5753ad98a346067918/ba749fd1f911418d2bddb5e304c881fe",
          referer: "https://www.x7sy.com/reserve",
        },
        body: new URLSearchParams({ mid: "0", page: String(page), pageSize: String(pageSize), columnType: "2" }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      if (!text.trim()) throw new Error("分页接口返回空响应");
      const payload = JSON.parse(text);
      if (Number(payload.errorno || 0) !== 0) throw new Error(payload.errormsg || `分页接口错误 ${payload.errorno}`);
      const pageItems = parseApiPage(payload, BASE_URL);
      results.push(...pageItems);
      const rawList = payload?.data?.list || payload?.list || [];
      if (!rawList.length || String(payload?.data?.hasMorePage || payload?.hasMorePage || "-1") === "-1") break;
    } catch (error) {
      lastError = error.message || String(error);
      break;
    }
  }
  return { items: results, error: lastError };
}

export function parseList(html = "", baseUrl = BASE_URL) {
  if (/^\s*[{"[]/u.test(String(html))) {
    try { return parseApiPage(JSON.parse(html), baseUrl); } catch { /* fall through to SSR parsing */ }
  }
  const state = extractNuxtState(html);
  const data = unwrapReactive(state?.data);
  const list = data?.reserveGameListInitialData?.list || [];
  return list.map((item) => parseItem(item, baseUrl)).filter(Boolean);
}

export function parseDetail(html = "", { url = "", gameName = "" } = {}) {
  const $ = cheerio.load(html);
  const title = cleanText($("h1.game_name").first().text() || $("meta[property='og:title']").attr("content") || gameName);
  const tags = [...new Set($(".game_introduction_tag_list .gray_tab").map((_, el) => cleanText($(el).text())).get().filter(Boolean))].slice(0, 8);
  const intro = $(".introduction_content").first().children().not(".hidden_content")
    .map((_, el) => cleanText($(el).text())).get().join("\n")
    .replace(/更多福利正在加急沟通中，敬请期待~?/u, "")
    .trim();
  const publisher = $(".infoItem").filter((_, el) => /厂商|开发|发行|运营/u.test(cleanText($(el).find(".info_title").first().text())))
    .map((_, el) => cleanText($(el).find(".developer, .info_value, span").last().text()))
    .get().find(Boolean) || "";
  const discount = cleanText($(".big .num").first().text()).match(/\d+(?:\.\d+)?/u)?.[0] || "";
  const reserveCount = parseCount($(".text_box .count_num").first().text());
  return {
    title: title || gameName,
    paragraphs: intro ? [intro] : [],
    // 列表页的 gameLogo 是准确 ICON；详情页 og:image 是站点默认图，不能覆盖它。
    images: [],
    quality: intro ? "ok" : "pending",
    gameMatch: gameName && title.includes(gameName) ? "strong" : "weak",
    facts: {
      ...(tags.length ? { x7Tags: tags } : {}),
      ...(publisher ? { x7Publisher: publisher } : {}),
      ...(discount ? { x7Discount: discount } : {}),
      ...(reserveCount ? { x7ReserveCount: reserveCount } : {}),
      ...(intro ? { x7Intro: intro } : {}),
    },
  };
}

export function extractDiscount(html = "") {
  const $ = cheerio.load(html);
  return cleanText($(".big .num").first().text()).match(/\d+(?:\.\d+)?/u)?.[0] || "";
}

export function extractReserveCount(html = "") {
  const $ = cheerio.load(html);
  return parseCount($(".text_box .count_num").first().text());
}

export function extractPublisher(html = "") {
  const $ = cheerio.load(html);
  return $(".infoItem").filter((_, el) => /厂商|开发|发行|运营/u.test(cleanText($(el).find(".info_title").first().text())))
    .map((_, el) => cleanText($(el).find(".developer, span").last().text())).get().find(Boolean) || "";
}
