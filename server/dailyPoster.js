import fs from "node:fs/promises";
import path from "node:path";
import { buildStudioDailyPosterHtml } from "./dailyPosterStudio.js";

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function tableName(article = {}) {
  const facts = article.facts || {};
  if (article.source_id === "ref-steam") return ({ new: "Steam 新游上线", most_played: "Steam 热玩榜", top_selling_cn: "Steam 畅销榜" })[facts.steamList] || "Steam";
  if (article.source_id === "ref-taptap") {
    if (/\/forum\/hot\/hashtags\?item=\d+/.test(article.detail_url || "")) return "TapTap 热榜话题";
    if (/\/game-event\/?/.test(article.detail_url || "")) return "版本更新 / 活动 / 联动";
    return "手机游戏 · 即将上线";
  }
  if (article.source_id === "ref-haoyou") return facts.haoyouKind === "update" ? "即将更新" : "手机游戏 · 即将上线";
  return "端游资讯";
}

function sectionName(article) {
  const table = tableName(article);
  if (/热榜话题/.test(table)) return "热榜话题";
  if (/Steam/.test(table)) return "Steam";
  if (/版本更新|即将更新|联动|活动/.test(table)) return "版本更新 / 活动 / 联动";
  if (/手机游戏/.test(table)) return "手机游戏 · 即将上线";
  return "端游资讯";
}

function tagsFor(article = {}) {
  const facts = article.facts || {};
  const raw = facts.steamTags || facts.taptapTags || facts.haoyouTags || [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return String(raw).split(/[\s,，;；/|]+/u).map((tag) => tag.trim()).filter(Boolean);
}

function cleanText(value = "") {
  return String(value)
    .replace(/<br\s*\/?>(\s*)/giu, " ")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function cleanGameName(value = "") {
  return cleanText(value)
    .replace(/[《》]/gu, "")
    .replace(/[（(](?:官服|测试服|正式服)[）)]/giu, "")
    .replace(/[\-—–]\s*(?:预下载|预约|下载|首发|公测|内测|测试|上线|发售|开放预购).*$/giu, "")
    .replace(/[\-—–]\s*\d+(?:\.\d+){0,2}(?:版本|赛季|周年).*$/giu, "")
    // 好游快爆会将版本、地区开放等运营信息拼接到游戏名后，展示与跨平台合并均不能使用该后缀。
    .replace(/[\-—–]\s*(?:至冬开放|新版本|版本更新|更新|活动|联动|赛季|周年庆?|限时|福利|开服|开放|首曝).*$/giu, "")
    .trim();
}

function posterGameKey(article = {}) {
  return cleanGameName(article.game_name || article.title || "")
    .replace(/[\s\-_:：·・]/gu, "")
    .replace(/(?:手游|游戏)$/u, "")
    .toLowerCase();
}

// 标题归一键：去掉日期与标点后比较。date_text 常把活动文案里的未来日期
//（如“10月15日登录领”）抽成事件日期，导致同一条活动被“日期相隔过远”
// 误判为两条（异环 1.4 案例），标题一致时必须无条件合并。
function posterTitleKey(title = "") {
  return String(title || "")
    .replace(/\d{1,2}月\d{1,2}日?/gu, "")
    .replace(/[\s，,。：:；;、【】\[\]（）()「」『』·！!？?\-—～~*]+/gu, "")
    .slice(0, 48);
}

function preferTapTapForSameGame(rows = []) {
  const tapTapGames = new Set(
    rows
      .filter((article) => article.source_id === "ref-taptap")
      .map((article) => posterGameKey(article))
      .filter(Boolean),
  );
  return rows.filter((article) => article.source_id === "ref-taptap" || !tapTapGames.has(posterGameKey(article)));
}

function posterDateValue(value = "") {
  const text = cleanText(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (/^(?:今天|今日)/u.test(text)) return today;
  if (/^明天/u.test(text)) return today + 86400000;
  let match = /(20\d{2})\s*(?:年|[\/-])\s*(\d{1,2})\s*(?:月|[\/-])\s*(\d{1,2})/u.exec(text);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  match = /(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})/u.exec(text);
  if (!match) return null;
  let year = now.getFullYear();
  let target = new Date(year, Number(match[1]) - 1, Number(match[2])).getTime();
  if (target < today && now.getMonth() >= 10 && Number(match[1]) <= 3) {
    year += 1;
    target = new Date(year, Number(match[1]) - 1, Number(match[2])).getTime();
  }
  return target;
}

function splitSummary(value = "") {
  return cleanText(value).split(/[；;]/u).map((item) => item.trim()).filter(Boolean);
}

function safePosterFileName(value = "") {
  const fileName = path.basename(String(value || ""));
  if (!/^简讯海报-\d{4}-\d{2}-\d{2}\.html$/.test(fileName)) {
    throw new Error("无效的海报文件名");
  }
  return fileName;
}

function posterDirectory(root, scope = "active") {
  return path.join(root, "output", scope === "trash" ? "poster-trash" : "poster-archive");
}

async function moveFile(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
}

function isMobileEventLabel(value = "") {
  return /^(?:(?:\d{1,2}:\d{2}\s*)?(?:正式)?(?:首发|上线|开测|测试|预约|即将上线|即将测试))(?:[！!，,。].*)?$/u.test(value.trim());
}

function isMobileScheduleLabel(value = "") {
  return /^(?:今天|明天|后天|\d{1,2}月\d{1,2}日|\d{1,2}[月\-/]\d{1,2}日?)\s*(?:首发|上线|测试|预约|开测)$/u.test(value.trim());
}

function conciseEventTitle(title = "", gameName = "") {
  const game = cleanGameName(gameName);
  let value = cleanText(title);
  if (game) {
    value = value.replace(new RegExp(`^《?${game.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}》?\s*[：:、,，—-]*`, "iu"), "");
  }
  return value.replace(/^《[^》]+》\s*[：:、,，—-]*/u, "").trim();
}

function eventSummary(value = "") {
  // 海报摘要只清掉包住整句的最外层书名式方括号，正文详情保持原样。
  return cleanText(value).replace(/^【\s*([\s\S]*?)\s*】$/u, "$1").trim();
}

function mobileScheduleLabel(article = {}) {
  const candidates = splitSummary(summaryFor(article)).filter(isMobileScheduleLabel);
  if (candidates.length) return candidates[0];
  const sourceDate = cleanText(article.date_text || "")
    .replace(/(\d{1,2}月\d{1,2}日?\s+\d{1,2}:\d{2})\s*(?:今天|明天|后天)\d{1,2}点\s*/u, "$1 ")
    .trim();
  if (/(?:首发|上线|测试|预约|开测)/u.test(sourceDate)) return sourceDate;
  const date = sourceDate.replace(/\s*(?:首发|上线|测试|预约).*$/u, "").trim();
  const event = conciseEventTitle(article.title, article.game_name);
  return [date, event].filter(Boolean).join(" ") || "查看原文";
}

function remoteImage(sourceId, source, assetBase) {
  if (!source) return "";
  if (String(source).startsWith("/crawler-assets/")) return `${assetBase}${source}`;
  if (String(source).startsWith("/api/image-proxy")) return `${assetBase}${source}`;
  return ["ref-taptap", "ref-haoyou", "ref-gcores", "ref-gamersky"].includes(sourceId)
    ? `${assetBase}/api/image-proxy?url=${encodeURIComponent(source)}`
    : source;
}

function imageFor(article, assetBase) {
  const isMobileUpcoming = sectionName(article) === "手机游戏 · 即将上线";
  const images = Array.isArray(article.images) ? article.images : [];
  const saved = images.find((image) => String(image?.src || image?.localUrl || "").startsWith("/crawler-assets/")) || images[0];
  const raw = isMobileUpcoming
    ? article.image_url || saved?.src || saved?.originalUrl || ""
    : saved?.src || saved?.localUrl || saved?.originalUrl || article.image_url || "";
  return remoteImage(article.source_id, raw, assetBase);
}

function summaryFor(article) {
  const facts = article.facts || {};
  const value = facts.steamDescriptionSnippet || facts.haoyouIntro || facts.haoyouUpdateContent || article.paragraphs?.find((paragraph) => String(paragraph).trim()) || "暂无正文摘要";
  const normalized = cleanText(value);
  if (sectionName(article) !== "手机游戏 · 即将上线") return normalized;
  let cleaned = splitSummary(normalized)
    .filter((part) => !/^标签：/u.test(part) && part !== "下载")
    .filter((part) => !isMobileEventLabel(part) && !isMobileScheduleLabel(part))
    .join("；");
  for (let index = 0; index < 3; index += 1) cleaned = cleaned.replace(/^(?:(?:新品|首发|上线|预约|公测|内测|测试)\s*[；;，,、\s]*)?(?:(?:\d{1,2}月\d{1,2}(?:日|号)?|\d{1,2}[./-]\d{1,2})\s*)?(?:新品|首发|上线|预约|公测|内测|测试)\s*[；;，,、\s]*/iu, "");
  return cleaned || normalized;
}

function bodyFor(article, assetBase, { includeImages = true } = {}) {
  const facts = article.facts || {};
  const layout = Array.isArray(facts.gcoresLayout)
    ? facts.gcoresLayout
    : Array.isArray(facts.gamerskyLayout)
      ? facts.gamerskyLayout
      : Array.isArray(facts.haoyouLayout)
        ? facts.haoyouLayout
        : [];
  const image = (value) => {
    const src = remoteImage(article.source_id, value?.src || value?.localUrl || value?.originalUrl || value?.url || value, assetBase);
    return src ? `<figure class="poster-body-image"><img src="${escapeHtml(src)}" alt="" loading="lazy" /></figure>` : "";
  };
  if (layout.length) {
    return layout.map((block) => {
      if (block?.type === "image") return includeImages ? image(block) : "";
      const text = block?.text || (block?.segments || []).map((segment) => segment?.text || "").join("");
      return text ? `<p${block?.quote ? " class=\"is-quote\"" : ""}>${escapeHtml(text)}</p>` : "";
    }).join("") || "<p>该资讯暂未获取到可展示正文。</p>";
  }
  const tapEvent = Array.isArray(facts.taptapEvents) ? facts.taptapEvents[0] : null;
  if (tapEvent?.blocks?.length) {
    return tapEvent.blocks.map((section) => `<section class="poster-event-section"><h4>${escapeHtml(section.title || "活动内容")}</h4>${(section.items || []).map((item) => `<div class="poster-event-item">${item.title ? `<h5>${escapeHtml(item.title)}</h5>` : ""}${item.content ? `<p>${escapeHtml(item.content)}</p>` : ""}${includeImages ? (item.images || []).map(image).join("") : ""}</div>`).join("")}</section>`).join("");
  }
  const paragraphs = (article.paragraphs || []).filter(Boolean);
  const text = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
  const images = includeImages ? (article.images || []).map(image).join("") : "";
  return text || images || "<p>该资讯暂未获取到可展示正文。</p>";
}

function posterDetailWeight(article, assetBase) {
  const facts = article.facts || {};
  const body = bodyFor(article, assetBase);
  const eventBlocks = Array.isArray(facts.taptapEvents?.[0]?.blocks)
    ? facts.taptapEvents[0].blocks.length
    : 0;
  const layoutBlocks = [facts.haoyouLayout, facts.gcoresLayout, facts.gamerskyLayout]
    .find(Array.isArray)?.length || 0;
  const imageCount = Array.isArray(article.images) ? article.images.length : 0;
  return cleanText(body).length + eventBlocks * 260 + layoutBlocks * 100 + imageCount * 90;
}

// 海报是阅读成品，不应因“勾选了两个平台”而将同一游戏的活动重复排版。
// 跨平台时固定 TapTap 优先：TapTap 与好游快爆同时存在同游戏记录，海报只展示
// TapTap，避免“原神”等同一事件在左右栏重复。单平台内仍按两天窗口合并，
// 日期明显不同的独立活动会继续保留。
function dedupePosterEvents(rows = [], assetBase) {
  const grouped = new Map();
  for (const item of rows) {
    const gameKey = posterGameKey(item);
    const bucket = grouped.get(gameKey) || [];
    bucket.push(item);
    grouped.set(gameKey, bucket);
  }

  const selected = [];
  for (const group of grouped.values()) {
    // 同游戏跨平台时整组切换为 TapTap，避免一条进入左栏、一条进入右栏。
    const taps = group.filter((item) => item.source_id === "ref-taptap");
    const primaryRows = taps.length ? taps : group;
    for (const item of primaryRows) {
      const date = posterDateValue(item.date_text);
      const titleKey = posterTitleKey(item.title);
      const index = selected.findIndex((current) => {
        if (posterGameKey(current) !== posterGameKey(item)) return false;
        if (titleKey && posterTitleKey(current.title) === titleKey) return true;
        const currentDate = posterDateValue(current.date_text);
        return date == null || currentDate == null || Math.abs(date - currentDate) <= 2 * 86400000;
      });
      if (index < 0) {
        selected.push(item);
        continue;
      }
      if (posterDetailWeight(item, assetBase) > posterDetailWeight(selected[index], assetBase)) selected[index] = item;
    }
  }
  return selected;
}

function cardFor(article, assetBase, index = 0, { hideDetailButton = false, showFullText = false, hideSummary = false, omitDetailImages = false, eventLayout = false } = {}) {
  const image = imageFor(article, assetBase);
  const section = sectionName(article);
  const kind = section === "手机游戏 · 即将上线" ? "upcoming" : /Steam/.test(section) ? "steam" : section === "热榜话题" ? "topic" : /版本更新/.test(section) ? "update" : "editorial";
  const compact = kind === "upcoming" || kind === "steam";
  const game = cleanGameName(article.game_name) || "未识别游戏";
  const title = article.title || game;
  const original = article.detail_url || "#";
  const visual = Boolean(image) && !compact;
  const lengthClass = summaryFor(article).length > 140 ? " is-long" : " is-brief";
  const rich = false;
  const cardTitle = kind === "upcoming" ? mobileScheduleLabel(article) : title;
  const haoyouEventLayout = eventLayout === "haoyou";
  const summary = eventSummary(summaryFor(article));
  const detailButton = "";
  const detailTemplate = "";
  const copy = haoyouEventLayout
    ? `<div class="poster-copy poster-copy--haoyou-event"><h3>《${escapeHtml(game)}》</h3><a class="poster-haoyou-title" href="${escapeHtml(original)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>${hideSummary ? "" : `<p class="poster-haoyou-summary">${escapeHtml(summary)}</p>`}</div>`
    : eventLayout ? `<div class="poster-copy poster-copy--event"><div class="poster-event-game">《${escapeHtml(game)}》</div><a class="poster-event-title" href="${escapeHtml(original)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>${hideSummary ? "" : `<p class="poster-event-summary">${escapeHtml(summary)}</p>`}</div>` : `<div class="poster-copy"><h3>${escapeHtml(game)}</h3><a class="poster-title" href="${escapeHtml(original)}" target="_blank" rel="noreferrer">${escapeHtml(cardTitle)}</a>${hideSummary ? "" : `<p class="${showFullText ? "poster-full-summary" : ""}">${escapeHtml(summaryFor(article))}</p>`}</div>`;
  return `<article class="poster-card poster-card--${kind}${haoyouEventLayout ? " poster-card--haoyou-event is-haoyou-square" : ""}${visual ? " is-visual" : " is-text"}${lengthClass}${rich ? " is-rich" : ""}${index === 0 && !compact && !haoyouEventLayout ? " is-featured" : ""}">
    <div class="poster-cover${image ? "" : " is-empty"}${compact ? " is-contain" : ""}">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(game)}" loading="${haoyouEventLayout ? "eager" : "lazy"}" />` : `<b>${escapeHtml(game.slice(0, 2))}</b>`}</div>
    ${copy}
  </article>`;
}

// 活动缩略图必须使用**带 assetBase 的绝对地址**：此前这里传空串，
// remoteImage 会退化出 `/api/image-proxy?url=...` 这种相对路径，用 file://
// 直接打开海报时全部 404 —— 这就是“看不到活动图”的根因。
// 活动标题换行优化，三步：
// ① 标题开头常重复卡片上已经写过的游戏名（如卡片「邂逅在迷宫」+ 标题
//    「《邂逅在迷宫》公测五周年」），去掉重复前缀，省下的那一行留给真正的内容；
//    只在前缀**等于本卡游戏名**时才剥离 —— 「战双帕弥什」标题里的
//    《约会大作战V》是联动方，不能误删。
// ② 纯靠 CSS 做不到「只在标点处换行」：word-break:keep-all 只禁掉汉字之间
//    的断点，Chrome 的 CJK 分词仍会在「」、『』这类括号边界给断点，于是出现
//    “新角色 /「狩勋女巫红弩箭」”这种半句悬挂。所以改为**在 JS 里按标点预排**
// ③ 贪心装箱：按标点切段后，把段拼成不超过 maxUnits 的行，行尾正好落在标点上。
//    这样断点确定、每行都填得比较满，也不丢内容（不像强制一段一行那样留白）。
const TITLE_PART_SPLIT = /(?<=[，；。！!])/u;
const TITLE_UNIT = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/u;

// 中文字按 1 格、西文按 0.55 格估算宽度，用于决定一行放几段。
function titleUnits(text = "") {
  let total = 0;
  for (const ch of String(text)) total += TITLE_UNIT.test(ch) ? 1 : 0.55;
  return total;
}

function packTitleLines(text = "", maxUnits = 38) {
  const parts = String(text).split(TITLE_PART_SPLIT).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return [String(text).trim()];
  const lines = [];
  let current = "";
  for (const part of parts) {
    // 单段本身就超长时只能自己占一行（交由浏览器在该行内自然折行）。
    if (current && titleUnits(current + part) > maxUnits) {
      lines.push(current);
      current = part;
    } else {
      current += part;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function eventTitleText(article = {}, game = "") {
  const raw = cleanText(article.title || "");
  if (!raw || !game || game === "未识别游戏") return raw;
  const name = escapeRegExp(game);
  // 允许《X》X：X、X，X - 这类前缀分隔符，但不允许完全没有分隔符时吞掉正文。
  const prefix = new RegExp(`^《\\s*${name}\\s*》\\s*[：:、,，—\\-–·]?\\s*|^${name}\\s*[：:、,，—\\-–·]\\s*`, "u");
  const stripped = raw.replace(prefix, "");
  return stripped.length >= 4 ? stripped : raw;
}

// 预排好的行用 <br> 落地，断点确定；行内仍可自然折行兜底（窄屏时）。
function eventTitleMarkup(article = {}, game = "") {
  return packTitleLines(eventTitleText(article, game))
    .map((line) => escapeHtml(line))
    .join("<br />");
}

function compactEventCard(article, assetBase) {
  const image = imageFor(article, assetBase);
  const game = cleanGameName(article.game_name) || "未识别游戏";
  const title = eventTitleMarkup(article, game);
  const original = article.detail_url || "#";
  const thumb = image
    ? `<span class="poster-event-thumb"><img src="${escapeHtml(image)}" alt="${escapeHtml(game)}" loading="lazy" /></span>`
    : `<span class="poster-event-thumb poster-event-thumb--empty">${escapeHtml(game.slice(0, 2))}</span>`;
  return `<article class="poster-event-item">${thumb}
    <div class="poster-event-item-body"><div class="poster-event-item-head"><b>${escapeHtml(game)}</b><span class="poster-event-src">${escapeHtml(article.source_name || "")}</span></div>
    <a class="poster-event-item-title" href="${escapeHtml(original)}" target="_blank" rel="noreferrer">${title}</a></div>
  </article>`;
}

// 运营动态按标题语义分块。27 条混在一个网格里没有层次，读起来就是“长墙”；
// 拆成 版本更新 / 活动 / 联动 / 折扣 · 促销 四块后同题材内容聚在一起，
// 每块自带小标题与条数，扫读成本明显下降。
const EVENT_KIND_RULES = [
  // 折扣必须最先判定：促销标题里常同时出现“版本”“联动”，归到折扣才准确。
  { key: "promo", test: /折扣|史低|大促|促销|特惠|买断制|限时\s*\d+(?:\.\d+)?\s*元|\d+(?:\.\d+)?\s*元(?:史低|折扣|特惠)/u },
  { key: "version", test: /版本|赛季|V\d+\.\d+|新角色|新英雄|新干员|新地图|新地区|新首领|新神明|新异界|新宠物|新职业|新剧情|全新(?:地区|地图|职业|主线|剧情|内容)/iu },
  { key: "collab", test: /联动|联名|[×✕]/u },
];
const EVENT_KIND_LABELS = { version: "版本更新", activity: "活动", collab: "联动", promo: "折扣 · 促销" };
const EVENT_KIND_ORDER = ["version", "activity", "collab", "promo"];

function eventKindOf(article = {}) {
  // 只用标题判定：正文摘要常夹带无关的“联动/折扣”字样，会把归类带偏。
  const text = cleanText(article.title || "");
  for (const rule of EVENT_KIND_RULES) if (rule.test.test(text)) return rule.key;
  return "activity";
}

function eventBlockMarkup(key, rows, assetBase) {
  if (!rows.length) return "";
  return `<div class="poster-event-block poster-event-block--${key}"><div class="poster-event-block-head"><i></i><h3>${escapeHtml(EVENT_KIND_LABELS[key] || "活动")}</h3><b>${rows.length}</b></div><div class="poster-event-grid">${rows.map((article) => compactEventCard(article, assetBase)).join("")}</div></div>`;
}

function eventColumns(rows, assetBase) {
  const deduped = dedupePosterEvents(rows, assetBase);
  const groups = new Map();
  for (const article of deduped) {
    const key = eventKindOf(article);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(article);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => posterDetailWeight(b, assetBase) - posterDetailWeight(a, assetBase));
  }
  const blocks = EVENT_KIND_ORDER
    .filter((key) => groups.has(key))
    .map((key) => eventBlockMarkup(key, groups.get(key), assetBase))
    .join("");
  return `<section class="poster-section poster-section--events"><header class="poster-section-title"><span>02</span><h2>版本更新 / 活动 / 联动</h2><small>${deduped.length} 条 · 按内容分块</small></header>${blocks}</section>`;
}

// 热榜话题改为排行榜单列：序号 + 封面 + 游戏名 / 话题 / 摘要，一列读到底。
function topicRankCard(article, assetBase, rank = 0) {
  const image = imageFor(article, assetBase);
  const game = cleanGameName(article.game_name) || "未识别游戏";
  const title = article.title || game;
  const original = article.detail_url || "#";
  const summary = summaryFor(article);
  const thumb = image
    ? `<span class="poster-topic-rank-thumb"><img src="${escapeHtml(image)}" alt="${escapeHtml(game)}" loading="lazy" /></span>`
    : `<span class="poster-topic-rank-thumb is-empty">${escapeHtml(game.slice(0, 2))}</span>`;
  return `<article class="poster-topic-rank">
    <span class="poster-topic-rank-no${rank < 3 ? " is-top" : ""}">${String(rank + 1).padStart(2, "0")}</span>
    ${thumb}
    <div class="poster-topic-rank-body"><div class="poster-topic-rank-head"><h3>${escapeHtml(game)}</h3>${article.source_name ? `<span>${escapeHtml(article.source_name)}</span>` : ""}</div>
    <a class="poster-topic-rank-title" href="${escapeHtml(original)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ""}</div>
  </article>`;
}

function topicColumns(rows, assetBase, sectionIndex) {
  return `<section class="poster-section poster-section--topics"><header><span>0${sectionIndex + 1}</span><h2>热榜话题</h2><small>${rows.length} 条 · 按热榜排名</small></header><div class="poster-topic-rank-list">${rows.map((article, rank) => topicRankCard(article, assetBase, rank)).join("")}</div></section>`;
}

function buildLegacyDailyPosterHtml(articles = [], { assetBase = "http://127.0.0.1:64424", generatedAt = new Date() } = {}) {
  const date = shanghaiDateKey(generatedAt);
  const buckets = new Map([
    ["手机游戏 · 即将上线", []], ["版本更新 / 活动 / 联动", []], ["热榜话题", []], ["Steam", []], ["端游资讯", []],
  ]);
  for (const article of articles) buckets.get(sectionName(article))?.push(article);
  // 新游与活动统一采用 TapTap 优先；数据库通常已合并，这里是海报独立生成时的兜底。
  for (const name of ["手机游戏 · 即将上线", "版本更新 / 活动 / 联动"]) {
    buckets.set(name, preferTapTapForSameGame(buckets.get(name) || []));
  }
  const sectionMarkup = [...buckets.entries()].filter(([, rows]) => rows.length).map(([name, rows], index) => {
    if (name === "版本更新 / 活动 / 联动") return eventColumns(rows, assetBase);
    if (name === "热榜话题") return topicColumns(rows, assetBase, index);
    // 「即将上线」单独成一类：它是一排窄卡（一行 5 个），与 Steam 的三列卡
    // 在栅格、封面尺寸上都不一样，不能再共用 poster-section--compact。
    const upcoming = name === "手机游戏 · 即将上线";
    const compact = name === "Steam";
    return `<section class="poster-section poster-section--${upcoming ? "upcoming" : compact ? "compact" : "feature"}"><header><span>0${index + 1}</span><h2>${escapeHtml(name)}</h2><small>${rows.length} 条</small></header><div class="poster-grid">${rows.map((article, itemIndex) => cardFor(article, assetBase, itemIndex)).join("")}</div></section>`;
  }).join("");
  const sections = sectionMarkup ? `${sectionMarkup}<style>
    .poster-section--feature .poster-card:nth-child(n){grid-column:span 5;min-height:208px}
    .poster-section--topics .poster-topic-rank-list{display:flex;flex-direction:column;gap:9px;margin-top:14px}
    .poster-topic-rank{display:grid;grid-template-columns:44px 84px minmax(0,1fr);gap:13px;align-items:center;padding:11px 15px;border:1px solid var(--line);border-radius:11px;background:var(--panel)}
    .poster-topic-rank-no{text-align:center;color:#b3c4bf;font:700 22px/1 Georgia,serif;letter-spacing:-.02em}
    .poster-topic-rank-no.is-top{color:var(--coral)}
    .poster-topic-rank-thumb{display:grid;place-items:center;width:84px;height:84px;overflow:hidden;border-radius:10px;background:var(--mist);color:var(--mint);font:700 18px Georgia,serif}
    .poster-topic-rank-thumb img{width:100%;height:100%;object-fit:cover}
    .poster-topic-rank-body{display:flex;flex-direction:column;gap:4px;min-width:0}
    .poster-topic-rank-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
    .poster-topic-rank-head h3{margin:0;font-size:15px;line-height:1.25}
    .poster-topic-rank-head span{flex:0 0 auto;padding:2px 7px;border-radius:999px;background:rgba(27,128,107,.1);color:var(--mint);font-size:9px;font-weight:800}
    .poster-topic-rank-title{color:var(--ink);font-size:13.5px;font-weight:800;line-height:1.38;text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .poster-topic-rank-title:hover{color:var(--mint);text-decoration:underline}
    .poster-topic-rank-body>p{margin:0;color:#536560;font-size:11px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .poster-section--events{margin-top:38px}.poster-section--events>.poster-section-title{display:flex;align-items:baseline;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--ink)}.poster-section--events>.poster-section-title span{color:var(--coral);font:700 30px/.8 Georgia,serif}.poster-section--events>.poster-section-title h2{margin:0;font-size:20px;letter-spacing:.02em}.poster-section--events>.poster-section-title small{margin-left:auto;color:#697b78;font-size:11px}
    .poster-event-block{margin-top:16px}
    .poster-event-block-head{display:flex;align-items:center;gap:9px;margin-bottom:9px}
    .poster-event-block-head i{width:4px;height:15px;border-radius:2px;background:var(--mint)}
    .poster-event-block--promo .poster-event-block-head i{background:var(--coral)}
    .poster-event-block-head h3{margin:0;font-size:14px;font-weight:800;letter-spacing:.04em}
    .poster-event-block-head b{padding:1px 8px;border-radius:999px;background:var(--mist);color:var(--mint);font-size:10px;font-weight:800}
    .poster-event-block-head:after{content:"";flex:1;height:1px;background:var(--line)}
    .poster-event-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
    .poster-event-item{display:grid;grid-template-columns:72px minmax(0,1fr);gap:13px;align-items:center;padding:10px 13px;border:1px solid var(--line);border-radius:11px;background:var(--panel)}
    .poster-event-thumb{display:grid;place-items:center;width:72px;height:72px;overflow:hidden;border-radius:10px;background:var(--mist)}
    .poster-event-thumb img{width:100%;height:100%;object-fit:cover}
    .poster-event-thumb--empty{color:var(--mint);font:700 18px Georgia,serif}
    .poster-event-item-body{display:flex;flex-direction:column;gap:5px;min-width:0}
    .poster-event-item-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
    .poster-event-item-head b{overflow:hidden;color:var(--ink);font-size:17px;line-height:1.26;letter-spacing:-.01em;text-overflow:ellipsis;white-space:nowrap}
    .poster-event-src{flex:0 0 auto;padding:2px 7px;border-radius:999px;background:rgba(27,128,107,.1);color:var(--mint);font-size:9px;font-weight:800}
    .poster-event-item-title{color:#41605a;font-size:12px;line-height:1.6;font-weight:600;text-decoration:none;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;line-break:strict}
    .poster-event-item-title:hover{color:var(--mint);text-decoration:underline}
    .poster-section--feature .poster-card.is-rich{grid-column:span 7 !important;min-height:296px !important}
    .poster-section--feature .poster-card.is-rich.is-visual{grid-template-columns:minmax(235px,47%) minmax(0,1fr)}
    .poster-section--feature .poster-card:not(.is-rich){grid-column:span 5 !important;min-height:208px !important}
    .poster-cover img{object-fit:contain;background:var(--mist)}
    .poster-section--upcoming .poster-grid{grid-template-columns:repeat(5,minmax(0,1fr));gap:9px}
    .poster-card--upcoming{grid-column:auto;grid-template-columns:70px minmax(0,1fr);gap:11px;align-items:center;height:98px;min-height:98px;padding:0 11px 0 12px;border-radius:10px}
    .poster-card--upcoming .poster-copy{padding:0;justify-content:center}
    .poster-card--upcoming .poster-cover,.poster-card--upcoming .poster-cover.is-contain{width:70px;height:70px;min-height:0;align-self:center;padding:0;border-radius:9px}
    .poster-card--upcoming .poster-cover img{width:100%;height:100%;object-fit:cover;border-radius:9px}
    .poster-card--upcoming .poster-cover.is-empty b{font-size:24px}
    .poster-card--upcoming .poster-copy h3{margin:0 0 4px;font-size:14px;line-height:1.26;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere}
    .poster-card--upcoming .poster-title{font-size:10px;line-height:1.36;font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere}
    .poster-card--upcoming .poster-copy>p{display:none}
    .poster-card--upcoming .poster-tags{display:none}
    .poster-tags{margin-top:6px}
    .poster-copy{position:relative}
    .poster-card:not(.poster-card--upcoming):not(.poster-card--steam) .poster-copy{padding-bottom:44px}
    .poster-open{position:absolute;right:13px;bottom:11px;padding:5px 9px;border:1px solid rgba(27,128,107,.35);border-radius:999px;background:#fffdf8;color:var(--mint);font:700 10px/1 "Microsoft YaHei","PingFang SC",sans-serif;cursor:pointer}
    .poster-open:hover{background:var(--mint);color:#fff}
    #poster-detail-dialog{width:min(860px,calc(100vw - 28px));max-height:min(820px,calc(100vh - 28px));padding:0;border:0;border-radius:14px;background:var(--panel);box-shadow:0 24px 70px rgba(0,0,0,.32)}
    #poster-detail-dialog::backdrop{background:rgba(8,24,29,.64)}
    .poster-detail-shell{display:flex;flex-direction:column;max-height:inherit}
    .poster-detail-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);background:#f7faf7}
    .poster-detail-toolbar strong{font-size:13px}.poster-detail-close{width:30px;height:30px;border:1px solid var(--line);border-radius:50%;background:#fff;color:var(--ink);font-size:19px;cursor:pointer}
    .poster-detail-content{overflow:auto;padding:22px 24px 32px}.poster-detail-heading{display:flex;justify-content:space-between;gap:12px;color:#71827d;font-size:11px;font-weight:700}.poster-detail-content h2{margin:11px 0 4px;font-size:22px;line-height:1.35}.poster-detail-title{display:block;color:var(--mint);font-weight:800;font-size:15px;line-height:1.6;text-decoration:none}.poster-detail-title:hover{text-decoration:underline}
    .poster-detail-body{margin-top:18px;color:#374d48;font-size:14px;line-height:1.9}.poster-detail-body p{margin:0 0 14px;white-space:pre-wrap}.poster-detail-body .is-quote{padding:10px 13px;border-left:3px solid var(--mint);background:var(--mist)}.poster-detail-body h4{margin:22px 0 9px;color:var(--ink);font-size:17px}.poster-detail-body h5{margin:14px 0 5px;font-size:14px}.poster-detail-body figure{margin:18px 0;text-align:center}.poster-detail-body figure img{display:block;width:auto;max-width:100%;max-height:540px;margin:0 auto;object-fit:contain;border-radius:8px;background:var(--mist)}
    @media(max-width:980px){.poster-section--feature .poster-card.is-rich,.poster-section--feature .poster-card:not(.is-rich){grid-column:auto !important}.poster-section--upcoming .poster-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.poster-card--upcoming{height:98px;min-height:98px}.poster-event-grid{grid-template-columns:1fr}}
    @media(max-width:680px){.poster-section--upcoming .poster-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.poster-card--upcoming{height:92px;min-height:92px;grid-template-columns:62px minmax(0,1fr);gap:9px;padding:0 9px 0 10px}.poster-card--upcoming .poster-cover,.poster-card--upcoming .poster-cover.is-contain{width:62px;height:62px}.poster-detail-content{padding:18px 16px 25px}.poster-detail-content h2{font-size:19px}.poster-detail-body figure img{max-height:390px}}
  </style><dialog id="poster-detail-dialog"><div class="poster-detail-shell"><header class="poster-detail-toolbar"><strong>完整抓取内容</strong><button class="poster-detail-close" type="button" aria-label="关闭">×</button></header><div class="poster-detail-content"></div></div></dialog><script>
    (() => { const dialog = document.querySelector('#poster-detail-dialog'); const content = dialog?.querySelector('.poster-detail-content'); const close = dialog?.querySelector('.poster-detail-close'); document.querySelectorAll('[data-poster-detail]').forEach((button) => button.addEventListener('click', () => { const source = document.getElementById(button.dataset.posterDetail); if (!dialog || !content || !source) return; content.replaceChildren(source.content.cloneNode(true)); dialog.showModal(); })); close?.addEventListener('click', () => dialog.close()); dialog?.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }); })();
  </script>` : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>简讯海报-${date}</title><style>
    :root{--night:#102027;--ink:#152a32;--paper:#f4f0e8;--panel:#fffdf8;--line:rgba(21,42,50,.16);--mint:#1b806b;--coral:#e85d3f;--mist:#e2ede8}*{box-sizing:border-box}html{background:var(--paper)}body{margin:0;background:linear-gradient(180deg,#dfece7 0,var(--paper) 430px);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC",sans-serif}.page{width:min(1280px,calc(100% - 40px));margin:0 auto;padding:34px 0 72px}.masthead{position:relative;display:flex;justify-content:space-between;align-items:end;gap:22px;padding:25px 28px 23px;overflow:hidden;background:var(--night);color:#f8f3e8;border-radius:0 0 26px 26px;box-shadow:0 16px 38px rgba(16,32,39,.18)}.masthead:after{content:"";position:absolute;right:-60px;top:-130px;width:420px;height:420px;border:1px solid rgba(255,255,255,.18);border-radius:50%;box-shadow:0 0 0 42px rgba(255,255,255,.04),0 0 0 84px rgba(255,255,255,.03)}.masthead>div{position:relative;z-index:1}.eyebrow{color:#a4e5d3;font-size:11px;font-weight:800;letter-spacing:.16em}.masthead h1{margin:7px 0 0;font:700 clamp(42px,6vw,74px)/.92 Georgia,"Microsoft YaHei",serif;letter-spacing:-.06em}.masthead p{max-width:540px;margin:12px 0 0;color:#c6d7d2;font-size:12px}.date{text-align:right;font-size:11px;color:#b9cbc6}.date b{display:block;margin-bottom:4px;color:#fff9ee;font-size:19px}.poster-section{margin-top:38px}.poster-section header{display:flex;align-items:baseline;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--ink)}.poster-section header span{color:var(--coral);font:700 30px/.8 Georgia,serif}.poster-section h2{margin:0;font-size:20px;letter-spacing:.02em}.poster-section small{margin-left:auto;color:#697b78;font-size:11px}.poster-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px;margin-top:16px;grid-auto-flow:dense}.poster-section--compact .poster-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.poster-card{display:grid;grid-column:span 6;grid-template-columns:minmax(150px,36%) minmax(0,1fr);min-height:224px;overflow:hidden;background:var(--panel);border:1px solid var(--line);border-radius:13px;box-shadow:0 8px 22px rgba(16,32,39,.09)}.poster-section--feature .poster-card:nth-child(5n+1){grid-column:span 7;min-height:270px}.poster-section--feature .poster-card:nth-child(5n+2){grid-column:span 5}.poster-section--feature .poster-card:nth-child(5n+3){grid-column:span 5}.poster-section--feature .poster-card:nth-child(5n+4){grid-column:span 7}.poster-card--update.is-visual,.poster-card--editorial.is-visual,.poster-card--topic{grid-template-columns:minmax(185px,42%) minmax(0,1fr)}.poster-cover{display:grid;min-height:100%;place-items:center;overflow:hidden;background:var(--mist)}.poster-cover img{display:block;width:100%;height:100%;object-fit:cover}.poster-cover.is-contain{padding:10px}.poster-cover.is-contain img{object-fit:contain;border-radius:9px}.poster-cover.is-empty{color:var(--mint);font:700 42px Georgia,serif}.poster-copy{display:flex;flex-direction:column;min-width:0;padding:16px}.poster-meta{display:flex;justify-content:space-between;gap:8px;color:#758682;font-size:10px;font-weight:700}.poster-copy h3{margin:8px 0 3px;font-size:16px;line-height:1.28}.poster-title,.poster-mobile-schedule{display:block;color:var(--mint);font-weight:800;font-size:14px;line-height:1.48;text-decoration:none}.poster-title:hover,.poster-mobile-schedule:hover{text-decoration:underline}.poster-copy>p{margin:9px 0;color:#536560;font-size:12px;line-height:1.72;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.poster-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:auto}.poster-tags span{border:1px solid rgba(27,128,107,.28);border-radius:999px;color:var(--mint);padding:3px 7px;font-size:9px;font-weight:700}.poster-card--upcoming{grid-column:auto;grid-template-columns:98px minmax(0,1fr);height:158px;min-height:158px;border-radius:10px}.poster-card--upcoming .poster-copy{padding:8px 10px}.poster-card--upcoming .poster-copy h3{margin:3px 0;font-size:13px}.poster-card--upcoming .poster-mobile-schedule{font-size:10px;line-height:1.25;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}.poster-card--upcoming .poster-copy>p{display:-webkit-box;margin:4px 0;font-size:10px;line-height:1.45;-webkit-line-clamp:2;-webkit-box-orient:vertical}.poster-card--upcoming .poster-tags{max-height:18px;overflow:hidden}.poster-card--steam{grid-column:auto;grid-template-columns:104px minmax(0,1fr);min-height:160px;border-radius:10px}.poster-card--steam .poster-copy{padding:12px}.poster-card--steam .poster-copy>p{display:none}.poster-card--topic .poster-title{font-size:16px;color:var(--ink)}@media(max-width:980px){.poster-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.poster-card,.poster-section--feature .poster-card:nth-child(n){grid-column:auto}.poster-section--compact .poster-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:680px){.page{width:min(100% - 24px,1280px);padding-top:18px}.masthead{display:block;padding:22px 20px;border-radius:0 0 18px 18px}.date{text-align:left;margin-top:18px}.poster-grid,.poster-section--compact .poster-grid{grid-template-columns:1fr}.poster-card,.poster-card--topic{grid-column:auto;grid-template-columns:118px minmax(0,1fr);min-height:170px}.poster-card--upcoming{height:158px;min-height:158px;grid-template-columns:94px minmax(0,1fr)}.poster-card--editorial,.poster-card--update{grid-template-columns:1fr}.poster-card--editorial .poster-cover,.poster-card--update .poster-cover{min-height:210px}.poster-card--editorial .poster-cover img,.poster-card--update .poster-cover img{max-height:300px;object-fit:contain}.poster-copy{padding:13px}}
  </style></head><body><main class="page"><header class="masthead"><div><div class="eyebrow">GAME NEWS HUB · POSTER EDITION</div><h1>今日简讯</h1><p>仅收录上海时间今日的已选资讯 · 点击标题可打开来源原文。</p></div><div class="date"><b>${date}</b><span>上海时间 · 共 ${articles.length} 条</span></div></header>${sections || "<p>尚未选择可生成的资讯。</p>"}</main></body></html>`;
}

// 恢复为已稳定投递的“今日简讯”日报版式；新版独立模板仅保留代码，
// 不参与日常生成与机器人投递。
export function buildDailyPosterHtml(articles = [], options = {}) {
  return buildLegacyDailyPosterHtml(articles, options);
}

export async function writeDailyPoster({ root, articles, assetBase }) {
  const date = shanghaiDateKey();
  const fileName = `简讯海报-${date}.html`;
  const outputDir = path.join(root, "output");
  const archiveDir = path.join(outputDir, "poster-archive");
  const html = buildDailyPosterHtml(articles, { assetBase });
  const outputPath = path.join(outputDir, fileName);
  const archivePath = path.join(archiveDir, fileName);
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(outputPath, html, "utf8");
  await fs.writeFile(archivePath, html, "utf8");
  return { fileName, outputPath, archivePath, date, articleCount: articles.length };
}

export async function listDailyPosters({ root, scope = "active" }) {
  scope = scope === "trash" ? "trash" : "active";
  const archiveDir = posterDirectory(root, scope);
  try {
    const records = await fs.readdir(archiveDir, { withFileTypes: true });
    const posters = await Promise.all(records
      .filter((entry) => entry.isFile() && /^简讯海报-\d{4}-\d{2}-\d{2}\.html$/.test(entry.name))
      .map(async (entry) => {
        const stat = await fs.stat(path.join(archiveDir, entry.name));
        const date = entry.name.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
        return { fileName: entry.name, date, updatedAt: stat.mtime.toISOString(), bytes: stat.size, scope };
      }));
    return posters.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function moveDailyPosterToTrash({ root, fileName }) {
  const safeName = safePosterFileName(fileName);
  const source = path.join(posterDirectory(root), safeName);
  const target = path.join(posterDirectory(root, "trash"), safeName);
  await fs.access(source);
  await moveFile(source, target);
  await fs.rm(path.join(root, "output", safeName), { force: true });
  return { fileName: safeName, scope: "trash" };
}

export async function restoreDailyPoster({ root, fileName }) {
  const safeName = safePosterFileName(fileName);
  const source = path.join(posterDirectory(root, "trash"), safeName);
  const archivePath = path.join(posterDirectory(root), safeName);
  await fs.access(source);
  await moveFile(source, archivePath);
  await fs.copyFile(archivePath, path.join(root, "output", safeName));
  return { fileName: safeName, scope: "active" };
}

export async function deleteDailyPosterPermanently({ root, fileName }) {
  const safeName = safePosterFileName(fileName);
  const trashPath = path.join(posterDirectory(root, "trash"), safeName);
  await fs.access(trashPath);
  await fs.unlink(trashPath);
  return { fileName: safeName, deleted: true };
}
