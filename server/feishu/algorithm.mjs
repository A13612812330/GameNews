// 飞书同步算法（P5）：从旧项目 topic-monitor-preview.mjs / scorer.js 迁移的纯函数，
// 按统一口径调整：新游优先 TapTap、活动优先好游快爆（剔除旧"TapTap 活动详情优先"残留）。
// 本模块不触碰飞书网络，全部可单测。
import { cleanBusinessGameName } from "../rules/index.mjs";

// ---------- 清洗 ----------
export function cleanGameName(value = "") {
  return String(value)
    .replace(/[《》【】]/gu, "")
    .replace(/[（(](?:官服|测试服|正式服|国际服|渠道服)[）)]/giu, "")
    .replace(/[-—–]\s*(?:国服|台服|周年庆|周年庆典|农友节)$/giu, "")
    .replace(/[-—–]\s*(?:预下载|预约|下载|首发|公测|内测|测试|上线|更新|活动|联动|新版本).*$/giu, "")
    .replace(/[-—–]\s*(?:全员恶人群像|手绘寻物解谜|嘉年华盛典|暹罗厘普联动|联动版本|版本活动).*$/giu, "")
    .replace(/\s*StarToU(?:-V)?\s*Project\s*$/iu, "")
    .replace(/[-—–]\s*(?:都市开放世界|开放世界|新世界|角色扮演|动作|策略|卡牌|冒险|模拟经营|模拟|休闲|射击|格斗|音游|解谜|悬疑|仙侠|国漫|足球|航海|沙盒|生存|塔防|Roguelike|MMO|ARPG|SLG|FPS|放置|社交|第一人称|搜打撤|吃鸡|手游|官方版|正式版).*$/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalize(value = "") {
  return String(value).toLowerCase().replace(/[《》【】\[\]（）()\s\-_:：·・,，。！!？?「」]/gu, "");
}

export function cleanTitle(value = "", game = "") {
  let text = String(value).replace(/\s+/gu, " ").trim();
  const name = cleanGameName(game);
  if (name) text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"), "");
  return text
    .replace(/[《》]\s*[《》]/gu, "")
    .replace(/[【】]\s*[【】]/gu, "")
    .replace(/^\s*[：:·\-]+/gu, "")
    .replace(/^\s*(?:今天|明天|后天|\d{1,2}月\d{1,2}日(?:\s*\d{1,2}:\d{2})?)\s*/gu, "")
    .replace(/^(?:上午|下午)?\s*\d{1,2}(?::|点)\d{0,2}\s*/gu, "")
    .replace(/^(?:更新|更新：|版本更新|活动|联动|首发|上线|测试|公测)\s*[:：]?\s*/gu, "")
    .replace(/(?:下载|预约|论坛\s*\d+|\d+\s*楼|动作|冒险|第三人称|非对称竞技|DIY创造|和)(?:\s*[|｜/,，；;、]\s*|\s+|$)/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[\s【】《》：:·\-]+|[\s【】《》：:·\-]+$/gu, "")
    .trim();
}

export function isNoise(value = "") {
  const text = String(value).replace(/\s+/gu, "").trim();
  return !text || /^(?:下载|预约|论坛\d*|动作|冒险|第三人称|非对称竞技|DIY创造|和|暂无摘要|敬请期待|新游|游戏介绍|简介|什么是官服[？?]?)$/u.test(text);
}
export function isInvalidGameName(value = "") {
  const text = cleanGameName(value).replace(/\s+/gu, "");
  return !text || /(?:工作室.*(?:周年|直播|神秘新游)|(?:周年|直播)夜|游戏展|发布会|神秘新游|多款游戏)/u.test(text);
}

// ---------- 标题关键词 / 相似度 ----------
export function titleKeywords(value = "") {
  const text = normalize(value).replace(/(?:版本|更新|活动|联动|开启|上线|正式|全新|限时|新游|测试|公测|首发|游戏|手游)/gu, "");
  const tokens = new Set();
  for (const match of text.matchAll(/\d+(?:\.\d+){1,3}|s\d+|[a-z]{2,}|[\p{Script=Han}]{2,}/gu)) {
    if (match[0].length >= 2) tokens.add(match[0]);
  }
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (/^[\p{Script=Han}\d]{2}$/u.test(pair)) tokens.add(pair);
  }
  return tokens;
}
export function eventTitlesOverlap(left = "", right = "") {
  const a = titleKeywords(left);
  const b = titleKeywords(right);
  if (!a.size || !b.size) return false;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common >= 2 || [...a].some((token) => /\d+\.\d+|s\d+/iu.test(token) && b.has(token));
}
export function contentSimilarity(left = "", right = "") {
  const a = titleKeywords(left);
  const b = titleKeywords(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(1, Math.min(a.size, b.size));
}

// ---------- 业务日期 ----------
export function parseDateText(value, today = new Date()) {
  const text = String(value || "").replace(/\s+/gu, "");
  if (!text || /(敬请期待|未知|暂无)/u.test(text)) return null;
  let date = /(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/u.exec(text);
  let time = /(?:上午|下午)?(\d{1,2})(?::|点)(\d{1,2})?/u.exec(text);
  // ISO / 连字符格式（2026-08-27）兜底
  if (!date) {
    const iso = /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
    if (iso) date = iso;
  }
  if (!date) return null;
  let hour = time ? Number(time[1]) : 0;
  const minute = time?.[2] ? Number(time[2]) : 0;
  if (/下午/u.test(text) && hour < 12) hour += 12;
  let year = Number(date[1] || today.getFullYear());
  const result = new Date(year, Number(date[2]) - 1, Number(date[3]), hour, minute);
  if (!date[1] && result.getTime() < today.getTime() - 180 * 86400000) result.setFullYear(year + 1);
  return result.getTime();
}
export function eventDateKey(value) {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 100000000000) {
    const d = new Date(numeric);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const match = String(value).match(/(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})/u);
  return match ? `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}` : "";
}
function calendarDay(timestamp = 0) {
  const d = new Date(Number(timestamp) || 0);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// ---------- 分类（统一口径） ----------
// 活动侧额外拦截新游词，避免"首发/上线/测试/公测/预下载/预约开启"串入活动表
const NEW_GAME_WORDS = /上线|首发|测试|公测|预下载|预约开启/u;

// TapTap 话题/资讯帖中的"新游生命周期"信号（修复话题内容误入"新游"回归）。
// 版本/更新/活动/联动/赛季/周年 等活动信号由 eventType 内活动分支先行接管。
const TAP_LIFECYCLE = /上线|定档|首发|公测|内测|开测|删档|不删档|测试|预下载|预约(?:开启|下载|测试|上线)?|开服|发售|开放(?:测试|下载|预约)|正式(?:上线|公测|推出)/iu;

export function isExplicitNewGameLifecycle(value = "") {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (!text) return false;
  const inGameActivity = /(?:版本|更新|活动|联动|赛季|返场|周年|新角色|角色|新皮肤|皮肤|新地图|地图|副本|玩法|装备|英雄|礼包|维护)/u.test(text);
  const directLaunch = /(?:首发|公测|内测|开测|预下载|预约(?:开启|下载|测试)?|新游(?:上线|预约)|(?:限量|不限量|删档|不删档)\s*测试|测试(?:资格|招募|开启|开始|进行中)?|正式上线)/u.test(text);
  return directLaunch && !(inGameActivity && !/(?:首发|公测|内测|开测|预下载|新游(?:上线|预约)|(?:限量|不限量|删档|不删档)\s*测试|测试(?:资格|招募)|正式上线)/u.test(text));
}

// 分类：返回 "新游" | "活动" | null（无法判定则 null）
export function eventType({ sourceId = "", category = "", title = "", facts = {} } = {}) {
  // 端游媒体文章统一归入资讯，不参与新游/活动飞书监控。
  // 真正的新游仍由 TapTap、好游快爆、小七和 Steam 目录入口采集。
  if (["ref-gamersky", "ref-gcores"].includes(sourceId) || /(?:行业|端游)?资讯|新闻/u.test(category)) return null;
  // 小七预约入口只采集新游
  if (sourceId === "ref-x7") return "新游";
  const tapTapEventText = Array.isArray(facts.taptapEvents)
    ? facts.taptapEvents.map((e) => [e?.title, e?.summary, e?.status].filter(Boolean).join(" ")).join(" ")
    : "";
  const lifecycleText = [title, facts.taptapEventType, facts.haoyouKind, facts.haoyouUpdateContent, tapTapEventText].filter(Boolean).join(" ");
  // TapTap game-event 详情 = 版本/活动/联动
  if (sourceId === "ref-taptap" && Array.isArray(facts.taptapEvents) && facts.taptapEvents.length) return "活动";
  if (facts.haoyouKind === "update") return "活动";
  if (facts.haoyouKind === "test" && /赛季|版本|体验服|维护|返场|周年/u.test(facts.haoyouUpdateContent || "")) return "活动";
  if (isExplicitNewGameLifecycle(lifecycleText)) return "新游";
  if (facts.haoyouKind) return "新游";
  if (/版本|更新|活动|联动|赛季|周年/u.test(`${category || ""} ${facts.haoyouUpdateContent || ""}`)) return "活动";
  // 修复回归：TapTap 话题/资讯帖不再默认落入"新游"。
  // 有活动信号（版本/更新/活动/联动/赛季/周年）→ 活动；无新游生命周期信号 → 资讯（null）。
  if (sourceId === "ref-taptap") {
    if (/版本|更新|活动|联动|赛季|周年/u.test(`${title} ${facts.haoyouUpdateContent || ""}`)) return "活动";
    if (!TAP_LIFECYCLE.test(title)) return null;
  }
  return "新游";
}

// 事件时间（毫秒时间戳）；无法解析返回 0
export function eventTime({ facts = {}, dateText = "" }, today = new Date()) {
  const x7 = Number(facts.x7LaunchTime || 0);
  if (Number.isFinite(x7) && x7 > 0) return x7 > 100000000000 ? x7 : x7 * 1000;
  const unix = Number(facts.releaseTime || facts.taptapUpcomingStartTime || 0);
  if (Number.isFinite(unix) && unix > 0) return unix * 1000;
  const event = Array.isArray(facts.taptapEvents) ? facts.taptapEvents[0] : null;
  return parseDateText(event?.status || facts.timelineDate || dateText, today) || 0;
}

// ---------- 去重（统一口径） ----------
// 新游：标准游戏名 + 类型（同游戏跨平台合并，TapTap 优先）
// 活动：标准游戏名 + 类型 + 业务日期 ±2 天 + 标题关键词重叠（好游快爆优先）
export function sameNewGameEvent(a, b) {
  return a.type === "新游" && b.type === "新游" && a.game && b.game && normalize(a.game) === normalize(b.game);
}

export function sameActivityEvent(a, b) {
  if (a.type !== "活动" || b.type !== "活动") return false;
  if (!a.game || !b.game || normalize(a.game) !== normalize(b.game)) return false;
  const aDate = a.dateKey || eventDateKey(a.time);
  const bDate = b.dateKey || eventDateKey(b.time);
  // 跨平台日期表达存在小时/时区差异；同游戏活动在两天内仍可合并，超过两天保留为另一场
  const aTs = Number(a.time || 0);
  const bTs = Number(b.time || 0);
  if (aTs && bTs) {
    if (Math.abs(calendarDay(aTs) - calendarDay(bTs)) > 2 * 86400000) return false;
  } else if (aDate && bDate && aDate !== bDate) {
    return false;
  }
  // 相同活动链接
  if (a.eventUrl && b.eventUrl && a.eventUrl === b.eventUrl) return true;
  // 标题关键词重叠或内容相似
  const titleMatch = eventTitlesOverlap(a.title || "", b.title || "") || normalize(a.title || "") === normalize(b.title || "");
  const contentMatch = contentSimilarity(a.content || "", b.content || "") >= 0.6;
  if (a.sourceUrl && a.sourceUrl === b.sourceUrl && (titleMatch || contentMatch)) return true;
  if (titleMatch) return true;
  return false;
}

// 来源优先级：新游 TapTap 优先、活动好游快爆优先（统一口径，移除旧 taptapEvents 加成）
export function sourcePriority(item) {
  const type = item.type === "活动" ? "活动" : "新游";
  const platform = type === "活动"
    ? (item.sourceId === "ref-haoyou" ? 40 : item.sourceId === "ref-taptap" ? 20 : 15)
    : (item.sourceId === "ref-taptap" ? 40 : item.sourceId === "ref-haoyou" ? 20 : 15);
  return (type === "活动" ? 200 : 100) + platform + Math.min(String(item.content || "").length, 500) + Number(item.score || 0);
}

// 事件唯一键（增量同步去重用）
export function eventKey(item) {
  const game = normalize(item.game || "");
  const date = item.dateKey || eventDateKey(item.time) || "无日期";
  if (item.type === "活动") {
    const ev = item.eventUrl || "";
    const url = item.sourceUrl || "";
    const content = normalize(item.content || "").slice(0, 260);
    return `${game}|活动|${date}|${ev ? `event:${ev}` : `url:${url}|content:${content}`}`;
  }
  return `${game}|新游|${date}`;
}

// ---------- 热度 / IP（迁入 scorer.js） ----------
const MOBILE_SOURCES = ["ref-haoyou", "ref-taptap", "ref-x7", "ref-jiuyou"];
const MOBILE_IP_WEIGHTS = [
  { name: "黑神话", weight: 14, terms: ["黑神话", "Black Myth"] },
  { name: "遮天", weight: 7, terms: ["遮天"] },
  { name: "愤怒的小鸟", weight: 4, terms: ["愤怒的小鸟", "Angry Birds"] },
  { name: "宝可梦", weight: 8, terms: ["宝可梦", "Pokémon", "Pokemon", "精灵宝可梦"] },
  { name: "奥特曼", weight: 8, terms: ["奥特曼", "Ultraman"] },
  { name: "西游", weight: 7, terms: ["西游", "西游记", "大话西游"] },
  { name: "铠甲勇士", weight: 7, terms: ["铠甲勇士"] },
  { name: "叶罗丽", weight: 6, terms: ["叶罗丽"] },
  { name: "斗罗大陆", weight: 7, terms: ["斗罗大陆", "斗罗"] },
  { name: "斗破苍穹", weight: 7, terms: ["斗破苍穹", "斗破"] },
  { name: "英雄联盟", weight: 8, terms: ["英雄联盟", "League of Legends", "LOL手游"] },
  { name: "地下城与勇士", weight: 8, terms: ["地下城与勇士", "DNF"] },
  { name: "原神", weight: 7, terms: ["原神"] },
  { name: "崩坏", weight: 7, terms: ["崩坏", "星穹铁道", "绝区零"] },
  { name: "王者荣耀", weight: 7, terms: ["王者荣耀"] },
  { name: "燕云十六声", weight: 8, terms: ["燕云十六声"] },
  { name: "三角洲行动", weight: 8, terms: ["三角洲行动"] },
  { name: "鸣潮", weight: 7, terms: ["鸣潮"] },
  { name: "恋与深空", weight: 7, terms: ["恋与深空"] },
  { name: "明日方舟", weight: 7, terms: ["明日方舟"] },
  { name: "第五人格", weight: 7, terms: ["第五人格"] },
  { name: "逆水寒", weight: 7, terms: ["逆水寒"] },
  { name: "和平精英", weight: 7, terms: ["和平精英"] },
  { name: "蛋仔派对", weight: 6, terms: ["蛋仔派对"] },
  { name: "金铲铲之战", weight: 6, terms: ["金铲铲之战"] },
  { name: "使命召唤", weight: 7, terms: ["使命召唤", "CODM"] },
  { name: "火影忍者", weight: 7, terms: ["火影忍者"] },
  { name: "航海王", weight: 7, terms: ["航海王", "海贼王"] },
  { name: "暗黑破坏神", weight: 6, terms: ["暗黑破坏神"] },
  { name: "魔兽世界", weight: 6, terms: ["魔兽世界"] },
  { name: "穿越火线", weight: 6, terms: ["穿越火线", "CF手游"] },
  { name: "阴阳师", weight: 6, terms: ["阴阳师"] },
  { name: "仙剑奇侠传", weight: 6, terms: ["仙剑奇侠传", "仙剑"] },
  { name: "盗墓笔记", weight: 6, terms: ["盗墓笔记"] },
  { name: "诡秘之主", weight: 6, terms: ["诡秘之主"] },
  { name: "三体", weight: 6, terms: ["三体"] },
];
const LIVE_EVENT = /新游|上线|发售|开测|公测|内测|测试|预约|首发|定档|开服|版本更新|版本|更新|赛季|资料片|联动|合作|活动|公告/iu;

function matchMobileIp(text = "") {
  const value = String(text || "").toLowerCase();
  return MOBILE_IP_WEIGHTS.find((ip) => ip.terms.some((term) => value.includes(term.toLowerCase()))) || null;
}

// 热度/IP 信号：热度最多 +15、IP 最多 +8、总加成最多 +18
export function getMobilePrioritySignals({ sourceId = "", title = "", gameName = "", facts = {}, forceEvent = false } = {}) {
  if (!MOBILE_SOURCES.includes(sourceId)) return { totalBoost: 0, heatBoost: 0, ipBoost: 0, reasons: [], ipName: "" };
  const safeFacts = facts && typeof facts === "object" ? facts : {};
  const text = `${gameName} ${title}`.replace(/\s+/g, " ").trim();
  const reasons = [];
  let heatBoost = 0;
  const newRank = Number(safeFacts.taptapNewDownloadRank || 0);
  const hotRank = Number(safeFacts.taptapHotRank || 0);
  if (newRank > 0) {
    const boost = newRank <= 3 ? 12 : newRank <= 10 ? 9 : newRank <= 30 ? 6 : 0;
    if (boost) { heatBoost += boost; reasons.push(`TapTap新品榜第${newRank}名 +${boost}`); }
  }
  if (hotRank > 0) {
    const boost = hotRank <= 3 ? 12 : hotRank <= 5 ? 9 : 0;
    if (boost) { heatBoost += boost; reasons.push(`TapTap热榜话题第${hotRank}名 +${boost}`); }
  }
  heatBoost = Math.min(15, heatBoost);
  const ip = matchMobileIp(text);
  const ipBoost = ip && (forceEvent || LIVE_EVENT.test(text) || heatBoost > 0) ? ip.weight : 0;
  if (ipBoost) reasons.push(`${ip.name} IP +${ipBoost}`);
  return { totalBoost: Math.min(18, heatBoost + ipBoost), heatBoost, ipBoost, reasons, ipName: ipBoost ? ip.name : "" };
}

// ---------- 自动评级 ----------
const TOP_PUBLISHER_PATTERN = /腾讯|网易|米哈游|miHoYo|莉莉丝|心动|鹰角|叠纸|库洛|沐瞳|灵犀|朝夕光年|完美世界|哔哩哔哩|bilibili|游科|游戏科学|金山/iu;

export function engagementRatingBonus(reviews) {
  if (reviews == null) return 0;
  if (reviews >= 10000) return 18;
  if (reviews >= 5000) return 14;
  if (reviews >= 1000) return 10;
  if (reviews >= 500) return 7;
  if (reviews >= 100) return 4;
  return 0;
}
export function followerRatingBonus(followers) {
  if (followers == null) return 0;
  if (followers >= 300000) return 20;
  if (followers >= 100000) return 14;
  if (followers >= 50000) return 10;
  if (followers >= 10000) return 5;
  return 0;
}
export function publisherRatingSignal(publisher) {
  if (!publisher) return { bonus: 0, reason: "" };
  if (TOP_PUBLISHER_PATTERN.test(publisher)) return { bonus: 10, reason: `头部厂商 ${publisher} +10` };
  return { bonus: -5, reason: `非头部厂商 ${publisher} -5` };
}
export function ratingLabelForScore(value = 0) {
  const score = Number(value) || 0;
  return score >= 80 ? "S · 重点" : score >= 60 ? "A · 优先" : score >= 45 ? "B · 常规" : "C · 留档";
}
export function ratingValueForLabel(value = "") {
  const label = String(value || "").trim();
  return label.startsWith("S") ? 80 : label.startsWith("A") ? 60 : label.startsWith("B") ? 45 : 0;
}

function activityImpact(text = "") {
  if (/限时券后|新史低|折扣/u.test(text)) return { base: 8, ceiling: 44, reason: "促销类活动" };
  // 联动/周年规格天然更高，但最终由分发价值决定能否 A/S（不允许仅因联动/周年自动升 S/A，见 ceiling）
  if (/(?:周年(?:庆典|活动|版本)?|联动)/u.test(text)) {
    const major = /(?:重磅|大型|全新|限定|免费.*(?:领取|解锁)|多个|系列|版本|赛季|地图|玩法|角色)/u.test(text);
    return major ? { base: 68, ceiling: 88, reason: "大型联动/周年" } : { base: 58, ceiling: 79, reason: "联动/周年活动" };
  }
  if (/全新赛季|新赛季|资料片|新地图|新模式|新区域|主线(?:剧情)?.*(?:开启|更新)|大版本/u.test(text)) {
    return { base: 60, ceiling: 84, reason: "赛季/玩法级活动" };
  }
  if (/(?:\d+\.\d+|版本|暑期|体验服|赛季|新角色|全新角色|活动(?:开启|上线)|限定.*(?:复刻|返场))/u.test(text)) {
    return { base: 30, ceiling: 59, reason: "常规版本/活动" };
  }
  return { base: 15, ceiling: 44, reason: "轻量活动" };
}

// 自动评级输入：{ type, game, title, content, platformCount, tags, publisher, reviews, followers, sourceId, score, facts }
export function ratingFor(item) {
  const text = `${item.game} ${item.title} ${item.content}`;
  const heat = getMobilePrioritySignals({ sourceId: item.sourceId, title: item.title, gameName: item.game, facts: item.facts, forceEvent: true });
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const publisher = publisherRatingSignal(item.publisher);
  if (item.type === "活动") {
    const impact = activityImpact(text);
    let value = impact.base + Math.min(16, heat.ipBoost * 2);
    if (publisher.bonus > 0) value += 8;
    if (item.platformCount >= 2) value += 4;
    if (tags.length >= 3) value += 2;
    if (String(item.content || "").length >= 160) value += 5;
    else if (String(item.content || "").length >= 60) value += 3;
    value = Math.min(value, impact.ceiling);
    if (item.reviews != null) value = item.reviews <= 100 ? Math.min(value, 44) : Math.max(value, 45);
    return {
      value: Math.min(value, 100),
      label: ratingLabelForScore(value),
      source: "auto",
      reasons: [impact.reason, ...(publisher.reason ? [publisher.reason] : [])],
    };
  }
  let value = 32;
  value += Math.round(heat.heatBoost * 1.25 + heat.ipBoost * 3);
  if (item.platformCount >= 2) value += 12;
  if (tags.length >= 3) value += 4;
  const contentLen = String(item.content || "").length;
  if (contentLen >= 160) value += 10;
  else if (contentLen >= 60) value += 6;
  else if (contentLen >= 24) value += 3;
  value += engagementRatingBonus(item.reviews);
  value += followerRatingBonus(item.followers);
  value += publisher.bonus;
  if (publisher.bonus > 0) value += 6;
  if (/(?:首发|正式上线|公测|开服)/u.test(text)) value += 20;
  else if (/(?:测试|内测|删档|招募|试玩)/u.test(text)) value += 12;
  else value += 5;
  // 单平台/低关注/低评价/非头部厂商且无高热 IP 的新游最高只到 B
  const weakNewGame = (item.followers == null || item.followers < 10000) &&
    (item.reviews == null || item.reviews < 100) &&
    publisher.bonus <= 0 &&
    heat.ipBoost < 6 &&
    Number(item.facts?.taptapNewDownloadRank || 0) > 5;
  let calibrated = weakNewGame ? Math.min(value, 59) : value;
  if (item.reviews != null) calibrated = item.reviews <= 100 ? Math.min(calibrated, 44) : Math.max(calibrated, 45);
  return {
    value: Math.min(calibrated, 100),
    label: ratingLabelForScore(calibrated),
    source: "auto",
    reasons: [...heat.reasons, ...(publisher.reason ? [publisher.reason] : [])],
  };
}

// ---------- 事件条目构建（从统一 articles 行 + 评级） ----------
export function toMonitorEvent(article, factsOverride = null) {
  const facts = factsOverride || parseFacts(article.facts_json);
  const type = eventType({ sourceId: article.source_id, category: article.category, title: article.title, facts });
  if (!type) return null;
  const game = cleanGameName(article.game_name || article.title);
  if (isInvalidGameName(game)) return null;
  const time = eventTime({ facts, dateText: article.date_text });
  if (!time) return null;
  const title = cleanTitle(article.title || "", game);
  const content = String(article.paragraphs_json ? (JSON.parse(article.paragraphs_json || "[]")[0] || "") : "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
  if (!title || isNoise(title) || !content || isNoise(content)) return null;
  const tags = (article.facts_json ? (JSON.parse(article.facts_json)?.tags || []) : []);
  return {
    type,
    game,
    title,
    content,
    time,
    dateKey: eventDateKey(time),
    sourceId: article.source_id,
    sourceName: article.source_name,
    sourceUrl: article.detail_url || "",
    imageUrl: article.image_url || "",
    score: Number(article.score) || 0,
    tags,
    publisher: "",
    reviews: engagementOf(facts),
    followers: Number(facts.taptapFollowerCount) || null,
    platformCount: 1,
    facts,
  };
}

function parseFacts(json) {
  try { return JSON.parse(json || "{}") || {}; } catch { return {}; }
}
function engagementOf(facts) {
  const v = Number(facts.taptapReserveCount ?? facts.haoyouReserveCount ?? facts.haoyouReviewCount ?? 0);
  return Number.isFinite(v) && v >= 0 ? v : null;
}
