// 游民星空 / 机核 端游资讯适配器 —— 迁入自 GameNews（parser.js + platforms/*.js 原逻辑）
// 列表：抓取资讯首页，解析卡片（仅保留今日/未来 + 官方资讯过滤）；详情：新增/缺失时才补。
import { load } from "cheerio";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 GameNewsUnified/1.0";

// ---------- 通用工具（迁入自 parser.js） ----------
function cleanText(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function resolveUrl(href, base) { try { return new URL(href, base).href; } catch { return ""; } }
function formatNewsDate(date) { const pad = (v) => String(v).padStart(2, "0"); return `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function isTodayOrFutureNewsDate(date) { if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false; const today = new Date(); today.setHours(0, 0, 0, 0); return date.getTime() >= today.getTime(); }
function parseGcoresListDate(value = "") {
  const text = cleanText(value); const now = new Date();
  if (/刚刚/.test(text)) return now;
  const min = /(\d+)\s*分钟前/.exec(text); if (min) return new Date(now.getTime() - Number(min[1]) * 60 * 1000);
  const hour = /(\d+)\s*小时前/.exec(text); if (hour) return new Date(now.getTime() - Number(hour[1]) * 3600 * 1000);
  const day = /(\d+)\s*天前/.exec(text); if (day) return new Date(now.getTime() - Number(day[1]) * 86400 * 1000);
  return null;
}
function parseGamerskyListDate(value = "") {
  const match = /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(cleanText(value));
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])) : null;
}
export { parseGcoresListDate, parseGamerskyListDate, isTodayOrFutureNewsDate, formatNewsDate };

// ---------- 游民过滤（迁入自 platforms/gamersky.js） ----------
const G_NOISE = /卖掉|白菜价|硬件|配件|周边|招聘|行业报告|玩家|调侃|吐槽|美图|脸模|颜值|身材|雕像|手办|壁纸|表情包|COS|偷拍|丑闻|争议|LGBT|炒冷饭|媒体评分|评分汇总|差评|攻略|MOD|影视|电影|电视剧|爆料|传闻|或将|有可能|前员工称|光驱|显卡|CPU|性能测试|包装/iu;
const G_OFFICIAL = /官方|官宣|公布|发布|上线|发售|预售|更新|版本|补丁|DLC|测试|实机|定档|预约|开放|开发完成|推出|登陆|登录|版号|销量|财报|合作|联动/iu;
const G_CONTEXT = /《[^》]{2,36}》|游戏|手游|端游|新作|版本|赛季|联动|更新|发售|测试|预售|实机|预告|DLC|Steam|Xbox|任天堂|PS[45]|PlayStation/iu;
const gamerskyFilter = (title = "") => { const v = cleanText(title); return v.length >= 10 && !G_NOISE.test(v) && G_CONTEXT.test(v) && G_OFFICIAL.test(v); };
const extractGamerskyGameName = (title = "") => /《([^》]{2,36})》/u.exec(cleanText(title))?.[1]?.trim() || "";

// ---------- 机核过滤（迁入自 platforms/gcores.js） ----------
const TRAILING_META = /\s*(?:刚刚|\d+\s*(?:分钟|小时|天)前)\s*\d*\s*喜欢\s*[•·]\s*\d*\s*评论\s*$/iu;
const C_NON_GAME = /抽奖|周边|手办|模型|书籍|小说|电影|电视剧|爆米花桶|招聘|影评|播客|电台|广告|媒体评分|评分汇总|评分|奖项|展台|ChinaJoy回顾|聊天AI应用|遗作|长篇作品|出版|特卖|折扣|免费领|喜加一/iu;
const C_GAME_SIGNAL = /《[^》]{2,36}》|游戏|手游|端游|主机|独立游戏|RPG|FPS|MMORPG|Steam|PlayStation|Xbox|任天堂|版本更新|赛季|联动|测试|发售|预售|实机|预告|愿望单|销量/iu;
const C_OFFICIAL = /官方|官宣|公布|发布|上线|发售|预售|更新|版本|补丁|测试|实机|定档|开放|开发完成|合作|联动|销量|推出.*(?:新章节|新作|新内容)|新章节/iu;
const cleanGcoresTitle = (title = "") => String(title).replace(/\s+/g, " ").replace(TRAILING_META, "").trim();
const gcoresFilter = (title = "") => { const v = cleanGcoresTitle(title); if (v.length < 8 || C_NON_GAME.test(v)) return false; return C_GAME_SIGNAL.test(v) && C_OFFICIAL.test(v); };
const extractGcoresGameName = (title = "") => { const v = cleanGcoresTitle(title); return [...v.matchAll(/《([^》]{2,36})》/gu)].map((m) => m[1].trim())[0] || ""; };

// ---------- 请求 ----------
async function getHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const text = await r.text();
  if (!text || text.length < 300) throw new Error(`页面过短 ${url}`);
  return text;
}

// ---------- 游民列表 ----------
export async function fetchGamerskyItems() {
  const html = await getHtml("https://www.gamersky.com/news/");
  const $ = load(html);
  const items = [];
  $("li").each((_, el) => {
    const card = $(el);
    const link = card.find(".tit a.tt[href]").first();
    const href = link.attr("href") || "";
    const title = cleanText(link.attr("title") || link.text());
    const detailUrl = resolveUrl(href, "https://www.gamersky.com/");
    const publishedAt = parseGamerskyListDate(card.find(".tem .time").first().text());
    if (!title || !detailUrl || !isTodayOrFutureNewsDate(publishedAt) || !gamerskyFilter(title)) return;
    const imageUrl = resolveUrl(card.find(".img img").first().attr("src") || "", "https://www.gamersky.com/");
    const summary = cleanText(card.find(".con .txt").first().text());
    items.push({
      legacy: `gamersky:${detailUrl}`,
      gameName: extractGamerskyGameName(title) || "",
      title, detailUrl, imageUrl,
      dateText: formatNewsDate(publishedAt),
      paragraphs: summary ? [summary] : [],
      category: "行业资讯",
    });
  });
  return { items, error: "" };
}

// ---------- 机核列表 ----------
export async function fetchGcoresItems() {
  const html = await getHtml("https://www.gcores.com/news");
  const $ = load(html);
  const items = [];
  $("a.news[href*='/articles/']").each((_, el) => {
    const card = $(el);
    const href = card.attr("href") || "";
    const title = cleanGcoresTitle(card.find("h3").first().text() || card.attr("title") || "");
    const detailUrl = resolveUrl(href, "https://www.gcores.com/");
    const publishedAt = parseGcoresListDate(card.find(".news_meta span").first().text());
    if (!title || !detailUrl || !isTodayOrFutureNewsDate(publishedAt) || !gcoresFilter(title)) return;
    const imageStyle = card.find(".news_imgArea").first().attr("style") || "";
    const imageUrl = resolveUrl(/url\((['"]?)(.*?)\1\)/i.exec(imageStyle)?.[2] || "", "https://www.gcores.com/");
    const summary = cleanText(card.find(".news_content,.news_desc,.desc").text()).replace(title, "").trim();
    items.push({
      legacy: `gcores:${detailUrl}`,
      gameName: extractGcoresGameName(title) || "",
      title, detailUrl, imageUrl,
      dateText: formatNewsDate(publishedAt),
      paragraphs: summary ? [summary] : [],
      category: "行业资讯",
    });
  });
  return { items, error: "" };
}

// ---------- 详情补全（仅新增/缺失时调用） ----------
export async function fetchGamerskyDetail(detailUrl) {
  const html = await getHtml(detailUrl);
  const $ = load(html);
  const paragraphs = $(".Mid2L_con > p,.Mid2L_con p,.n_show p").map((_, el) => cleanText($(el).text())).get().filter((t) => t.length >= 10).slice(0, 12);
  return { paragraphs, images: [], quality: paragraphs.length ? "ok" : "pending" };
}
export async function fetchGcoresDetail(detailUrl) {
  const id = /\/articles\/(\d+)/.exec(detailUrl)?.[1];
  if (!id) return { paragraphs: [], images: [], quality: "pending" };
  const r = await fetch(`https://www.gcores.com/gapi/v1/articles/${id}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  const article = await r.json();
  const attrs = article?.data?.attributes || article?.data || {};
  let draft; try { draft = typeof attrs.content === "string" ? JSON.parse(attrs.content) : attrs.content; } catch { draft = null; }
  const paragraphs = (draft?.blocks || []).map((b) => String(b.text || "").replace(/\s+/g, " ").trim()).filter((t) => t && !/^【/.test(t)).slice(0, 12);
  const cover = attrs.cover || attrs.thumb || "";
  return { paragraphs, images: cover ? [{ url: cover, position: "cover", label: "文章头图" }] : [], quality: paragraphs.length ? "ok" : "pending" };
}
