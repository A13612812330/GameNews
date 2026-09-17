import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, listTodayArticles } from "../server/database.js";
import { extractHaoyouFollowerCount, extractHaoyouPublisher, extractHaoyouReserveCount, extractHaoyouReviewCount, filterGameplayTags } from "../server/crawler/platforms/haoyou.js";
import { extractTapTapFollowerCount, extractTapTapPublisher, extractTapTapReserveCount, extractTapTapReviewCount, extractUpcomingTags, fetchTapTapAppTags, hasExcludedTapTapNewGameTag } from "../server/crawler/platforms/taptap.js";
import { extractPublisher as extractX7Publisher, extractDiscount as extractX7Discount, parseDetail as parseX7Detail } from "../server/crawler/platforms/x7.js";
import { getMobilePrioritySignals } from "../server/crawler/scorer.js";

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

// 收益汇总是手游分发价值的强信号，但不是人工评级的替代品。
// 文件不存在时自动降级为没有收益信号，不影响现有爬虫/同步流程。
const revenueCsvPath = userEnv("GAME_REVENUE_CSV") || "E:\\新建文件夹\\游戏详情收益汇总.csv";
const revenueSignalsByGame = new Map();
try {
  const revenueText = readFileSync(revenueCsvPath, "utf8").replace(/^\uFEFF/u, "");
  const [headerLine, ...dataLines] = revenueText.split(/\r?\n/u).filter((line) => line.trim());
  const headers = headerLine.split(",").map((value) => value.trim());
  const indexOf = (name) => headers.findIndex((header) => header === name);
  const rankIndex = indexOf("序号");
  const nameIndex = indexOf("游戏名");
  const revenueIndex = indexOf("收益汇总");
  const registrantIndex = indexOf("注册汇总");
  const payerIndex = indexOf("付费汇总");
  if (nameIndex >= 0) {
    for (const line of dataLines) {
      const columns = line.split(",");
      const game = String(columns[nameIndex] || "")
        .toLowerCase()
        .replace(/[《》【】\[\]（）()\s\-_:：·・,，。！!？?「」]/gu, "");
      if (!game) continue;
      const number = (value) => Number(String(value ?? "").replace(/,/gu, "")) || 0;
      revenueSignalsByGame.set(game, {
        rank: number(columns[rankIndex]),
        revenue: number(columns[revenueIndex]),
        registrants: number(columns[registrantIndex]),
        payers: number(columns[payerIndex]),
      });
    }
  }
} catch {
  // 本地部署或 TraeWork 未提供收益表时，继续使用在线热度/评论/预约规则。
}

function revenueRatingSignal(item) {
  const signal = revenueSignalsByGame.get(normalize(item.game || ""));
  if (!signal || !signal.rank) return { floor: 0, bonus: 0, reason: "" };
  if (signal.rank <= 20) return { floor: 80, bonus: 12, reason: `收益排名 ${signal.rank}，分发价值底线 S` };
  if (signal.rank <= 50) return { floor: 60, bonus: 8, reason: `收益排名 ${signal.rank}，分发价值底线 A` };
  if (signal.rank <= 100) return { floor: 45, bonus: 5, reason: `收益排名 ${signal.rank}，分发价值加分` };
  if (signal.rank <= 200) return { floor: 0, bonus: 3, reason: `收益排名 ${signal.rank}，分发价值参考` };
  return { floor: 0, bonus: 0, reason: "" };
}

const appId = userEnv("FEISHU_MONITOR_APP_ID");
const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
const sourceTableId = userEnv("FEISHU_MONITOR_TABLE_ID");
if (!appId || !appSecret || !appToken || !sourceTableId) throw new Error("监控配置不完整");
const dryRun = process.argv.includes("--dry-run");
const onlyNewGames = process.argv.includes("--only-new-games");
const repairExisting = process.argv.includes("--repair-existing");
const repairEventIds = process.argv.includes("--repair-event-ids");
const rebuildSchedule = process.argv.includes("--rebuild-schedule");
const markAllHistory = process.argv.includes("--mark-all-history");
const restoreBackupArg = process.argv.find((arg) => arg.startsWith("--restore-backup="));
const restoreBackupPath = restoreBackupArg ? restoreBackupArg.slice("--restore-backup=".length) : "";
const formatExistingContent = process.argv.includes("--format-content");
const repairLeadingUpdate = process.argv.includes("--repair-leading-update");
const scoreExisting = process.argv.includes("--score-existing");
const repairTags = process.argv.includes("--repair-tags");
const repairGameNames = process.argv.includes("--repair-game-names");
const repairMetadata = process.argv.includes("--repair-metadata");
const migrateLaunchRecords = process.argv.includes("--migrate-launch-records");
const resetMonitorTables = process.argv.includes("--reset-monitor-tables");
const sourceArg = process.argv.find((arg) => arg.startsWith("--source="));
const sourceFilter = sourceArg ? sourceArg.slice("--source=".length).trim() : "";
const repairX7 = process.argv.includes("--repair-x7");
const auditTable = process.argv.includes("--audit-table");
const repairSummary = process.argv.includes("--repair-summary");
const dedupeExistingActivities = process.argv.includes("--dedupe-existing-activities");
const restoreHistoryArchive = process.argv.includes("--restore-history-archive");
const inspectSharedViews = process.argv.includes("--inspect-shared-views");
const rebuildHistoryArchive = process.argv.includes("--rebuild-history-archive");
const auditHistoryLayout = process.argv.includes("--audit-history-layout");
const inspectTables = process.argv.includes("--inspect-tables");
const auditGameRatings = process.argv.includes("--audit-game-ratings");
const syncGameRatings = process.argv.includes("--sync-game-ratings");
const rebuildMonitorLayout = process.argv.includes("--rebuild-monitor-layout");
const repairViewSorts = process.argv.includes("--repair-view-sorts");
const removeBlankRows = process.argv.includes("--remove-blank-rows");
const promoteCToB = process.argv.includes("--promote-c-to-b");
const restoreFullLayoutArg = process.argv.find((arg) => arg.startsWith("--restore-full-layout="));
const restoreFullLayoutPath = restoreFullLayoutArg ? restoreFullLayoutArg.slice("--restore-full-layout=".length) : "";
const removeHistoryView = process.argv.includes("--remove-history-view");
const runIngestTime = Date.now();
const monitorDayStart = new Date();
monitorDayStart.setHours(0, 0, 0, 0);
// 正常同步开始时把上轮“新增”降为“历史”。重排脚本会在同一轮同步后再次运行，
// 因此绝不能在 --rebuild-schedule 模式里重复降级刚写入的新记录。
const rotateAlertState = !sourceFilter && !repairX7 && !dryRun && !rebuildSchedule && !repairExisting && !repairEventIds && !formatExistingContent && !repairLeadingUpdate && !scoreExisting && !repairMetadata && !repairTags && !repairGameNames && !resetMonitorTables;

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
}

function parseFacts(value) {
  try { return typeof value === "string" ? JSON.parse(value || "{}") : (value || {}); } catch { return {}; }
}

const localArticleFactsByUrl = new Map(
  db.prepare("SELECT detail_url, facts FROM articles WHERE detail_url IS NOT NULL AND facts IS NOT NULL")
    .all()
    .map((row) => [canonicalEventUrl(row.detail_url), parseFacts(row.facts)]),
);

function parseParagraphs(value) {
  try { return typeof value === "string" ? JSON.parse(value || "[]") : (value || []); } catch { return []; }
}

function cleanGameName(value = "") {
  return String(value)
    .replace(/[《》【】]/gu, "")
    .replace(/[（(](?:官服|测试服|正式服|国际服|渠道服)[）)]/giu, "")
    // “体验服/测试服”是服别标识，不是标题噪声，例如“三角洲行动体验服”需要保留。
    .replace(/[-—–]\s*(?:国服|台服|周年庆|周年庆典|农友节)$/giu, "")
    .replace(/[-—–]\s*(?:预下载|预约|下载|首发|公测|内测|测试|上线|更新|活动|联动|新版本).*$/giu, "")
    .replace(/[-—–]\s*(?:全员恶人群像|手绘寻物解谜|嘉年华盛典|暹罗厘普联动|联动版本|版本活动).*$/giu, "")
    .replace(/\s*StarToU(?:-V)?\s*Project\s*$/iu, "")
    .replace(/[-—–]\s*(?:都市开放世界|开放世界|新世界|角色扮演|动作|策略|卡牌|冒险|模拟经营|模拟|休闲|射击|格斗|音游|解谜|悬疑|仙侠|国漫|足球|航海|沙盒|生存|塔防|Roguelike|MMO|ARPG|SLG|FPS|放置|社交|第一人称|搜打撤|吃鸡|手游|官方版|正式版).*$/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalize(value = "") {
  return String(value).toLowerCase().replace(/[《》【】\[\]（）()\s\-_:：·・,，。！!？?「」]/gu, "");
}

function cleanTitle(value = "", game = "") {
  let text = String(value).replace(/\s+/gu, " ").trim();
  const name = cleanGameName(game);
  if (name) text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\$&"), "giu"), "");
  return text
    // 只去掉移除游戏名后残留的空书名号，活动文案里的「」/【】是正文的一部分，必须保留。
    .replace(/[《》]\s*[《》]/gu, "")
    .replace(/[【】]\s*[【】]/gu, "")
    .replace(/^\s*[：:·\-]+/gu, "")
    .replace(/^\s*(?:今天|明天|后天|\d{1,2}月\d{1,2}日(?:\s*\d{1,2}:\d{2})?)\s*/gu, "")
    .replace(/^(?:上午|下午)?\s*\d{1,2}(?::|点)\d{0,2}\s*/gu, "")
    .replace(/^(?:更新|更新：|版本更新|活动|联动|首发|上线|测试|公测)\s*[:：]?\s*/gu, "")
    .replace(/(?:下载|预约|论坛\s*\d+|\d+\s*楼|动作|冒险|第三人称|非对称竞技|DIY创造|和)(?:\s*[|｜/,，；;、]\s*|\s+|$)/gu, " ")
    .replace(/\s+/gu, " ")
    // 「」是活动/联动标题的正式书名号，不能当作首尾噪声清掉。
    .replace(/^[\s【】《》：:·\-]+|[\s【】《》：:·\-]+$/gu, "")
    .trim();
}

function cleanLaunchStatus(value = "") {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .replace(/^(?:(?:20\d{2}年)?\d{1,2}月\d{1,2}日|\d{1,2}\.\d{1,2}|今天|明天|后天|昨天|前天)\s*/u, "")
    .replace(/^(?:上午|下午|早|晚)?\s*\d{1,2}(?::|点)\d{0,2}\s*/u, "")
    .replace(/^[：:·\-\s]+|[：:·\-\s]+$/gu, "")
    .trim();
}

function isNoise(value = "") {
  const text = String(value).replace(/\s+/gu, "").trim();
  return !text || /^(?:下载|预约|论坛\d*|动作|冒险|第三人称|非对称竞技|DIY创造|和|暂无摘要|敬请期待|新游|游戏介绍|简介|什么是官服[？?]?)$/u.test(text);
}

function isGenericNewGameTitle(value = "") {
  const text = normalize(value);
  return !text || /^(?:新游|游戏介绍|简介|最新消息|什么是官服|测试资格)$/u.test(text);
}

function isInvalidGameName(value = "") {
  const text = cleanGameName(value).replace(/\s+/gu, "");
  return !text || /(?:工作室.*(?:周年|直播|神秘新游)|(?:周年|直播)夜|游戏展|发布会|神秘新游|多款游戏)/u.test(text);
}

function titleKeywords(value = "") {
  const text = normalize(value)
    .replace(/(?:版本|更新|活动|联动|开启|上线|正式|全新|限时|新游|测试|公测|首发|游戏|手游)/gu, "");
  const tokens = new Set();
  for (const match of text.matchAll(/\d+(?:\.\d+){1,3}|s\d+|[a-z]{2,}|[\p{Script=Han}]{2,}/gu)) {
    const token = match[0];
    if (token.length >= 2) tokens.add(token);
  }
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (/^[\p{Script=Han}\d]{2}$/u.test(pair)) tokens.add(pair);
  }
  return tokens;
}

function eventTitlesOverlap(left = "", right = "") {
  const a = titleKeywords(left);
  const b = titleKeywords(right);
  if (!a.size || !b.size) return false;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common >= 2 || [...a].some((token) => /\d+\.\d+|s\d+/iu.test(token) && b.has(token));
}

function contentSimilarity(left = "", right = "") {
  const a = titleKeywords(left);
  const b = titleKeywords(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(1, Math.min(a.size, b.size));
}

function parseDateText(value, today) {
  const text = String(value || "").replace(/\s+/gu, "");
  if (!text || /(敬请期待|未知|暂无)/u.test(text)) return null;
  const date = /(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/u.exec(text);
  if (!date) return null;
  const time = /(?:上午|下午)?(\d{1,2})(?::|点)(\d{1,2})?/u.exec(text);
  let hour = time ? Number(time[1]) : 0;
  const minute = time?.[2] ? Number(time[2]) : 0;
  if (/下午/u.test(text) && hour < 12) hour += 12;
  let year = Number(date[1] || today.getFullYear());
  const result = new Date(year, Number(date[2]) - 1, Number(date[3]), hour, minute);
  if (!date[1] && result.getTime() < today.getTime() - 180 * 86400000) result.setFullYear(year + 1);
  return result.getTime();
}

function isExplicitNewGameLifecycle(value = "") {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (!text) return false;
  // 角色、皮肤、地图、版本等“内容上线”仍是活动，不能因为出现“上线”而被迁入新游。
  const inGameActivity = /(?:版本|更新|活动|联动|赛季|返场|周年|新角色|角色|新皮肤|皮肤|新地图|地图|副本|玩法|装备|英雄|礼包|维护)/u.test(text);
  const directLaunch = /(?:首发|公测|内测|开测|预下载|预约(?:开启|下载|测试)?|新游(?:上线|预约)|(?:限量|不限量|删档|不删档)\s*测试|测试(?:资格|招募|开启|开始|进行中)?|正式上线)/u.test(text);
  return directLaunch && !(inGameActivity && !/(?:首发|公测|内测|开测|预下载|新游(?:上线|预约)|(?:限量|不限量|删档|不删档)\s*测试|测试(?:资格|招募)|正式上线)/u.test(text));
}

function isStoredNewGameRow(row = {}) {
  const fields = row?.fields || row || {};
  const sourceUrl = String(fields["原文链接"]?.link || fields["原文链接"] || "");
  // TapTap 游戏活动详情页即使标题包含“正式上线”，也属于版本/活动，
  // 不能按“新游上线”处理。
  if (/taptap\.cn\/game-event\//iu.test(sourceUrl)) return false;
  const contentLead = String(fields["内容"] || "").split(/\n/u)[0] || "";
  const text = [fields["标题"], contentLead, fields["游戏名"]].filter(Boolean).join(" ");
  if (/(?:版本|更新|活动|联动|赛季|周年|新角色|新地图|新副本|新玩法)/u.test(text)
    && !/(?:新游预约|预约开启|预下载|首发|公测|内测|开测|正式上线)/u.test(text)) return false;
  const datedLifecycle = /(?:20\d{2}年)?\d{1,2}月\d{1,2}日(?:\s*\d{1,2}(?::|点)\d{0,2})?\s*(?:上线|测试|首发|预下载|公测|内测|开测)/u;
  return datedLifecycle.test(text) || isExplicitNewGameLifecycle(text);
}

function eventType(article, facts) {
  // 小七预约入口只采集新游，禁止任何标题/简介关键词把它迁入活动视图。
  if (article.source_id === "ref-x7") return "新游";
  const tapTapEventText = Array.isArray(facts.taptapEvents)
    ? facts.taptapEvents.map((event) => [event?.title, event?.summary, event?.status].filter(Boolean).join(" ")).join(" ")
    : "";
  // 栏目分类常被统一标成“新游上线”，已运营游戏的活动也会落入该栏目；
  // 因此只能依据条目自身的标题、状态和详情文案判断生命周期。
  const lifecycleText = [article.title, facts.taptapEventType, facts.haoyouKind, facts.haoyouUpdateContent, tapTapEventText].filter(Boolean).join(" ");
  // TapTap 的 game-event 详情明确对应版本/活动/联动；不能因为“正式上线”等
  // 活动标题措辞再次误判为新游。真正的新游来自新品/预约/首发入口，不带 taptapEvents。
  if (article.source_id === "ref-taptap" && Array.isArray(facts.taptapEvents) && facts.taptapEvents.length) return "活动";
  // 好游“测试/上线/首发”条目的文案也可能出现“赛季”，但它们仍是新游或测试，
  // 只有时间线显式 update 才进入活动记录。
  if (facts.haoyouKind === "update") return "活动";
  if (facts.haoyouKind === "test" && /赛季|版本|体验服|维护|返场|周年/u.test(facts.haoyouUpdateContent || "")) return "活动";
  // 必须在“生命周期关键词”之前判断平台入口。好游快爆更新动态里经常有“版本上线”，
  // 但它是已运营游戏的活动；若先判断“上线”，就会把逆水寒等错放进新游。
  if (Array.isArray(facts.taptapEvents) && facts.taptapEvents.length) return "活动";
  if (isExplicitNewGameLifecycle(lifecycleText)) return "新游";
  if (facts.haoyouKind) return "新游";
  if (/版本|更新|活动|联动|赛季|周年/u.test(`${article.category || ""} ${facts.haoyouUpdateContent || ""}`)) return "活动";
  return "新游";
}

function eventTime(article, facts, today) {
  const x7Time = Number(facts.x7LaunchTime || 0);
  if (Number.isFinite(x7Time) && x7Time > 0) return x7Time > 100000000000 ? x7Time : x7Time * 1000;
  const unix = Number(facts.releaseTime || facts.taptapUpcomingStartTime || 0);
  if (Number.isFinite(unix) && unix > 0) return unix * 1000;
  const event = Array.isArray(facts.taptapEvents) ? facts.taptapEvents[0] : null;
  return parseDateText(event?.status || facts.timelineDate || article.date_text, today);
}

function eventTitle(article, facts, type, game) {
  const event = Array.isArray(facts.taptapEvents) ? facts.taptapEvents[0] : null;
  if (type === "新游" && !event) {
    if (article.source_id === "ref-x7") {
      const launch = cleanLaunchStatus(facts.x7LaunchStatus || article.date_text || "");
      if (launch && !isGenericNewGameTitle(launch)) return launch;
    }
    // “首发/测试/上线”本身就是新游记录的核心状态，不能被通用标题清洗删掉。
    const launch = cleanLaunchStatus(facts.taptapEventType || "");
    if (launch && !isGenericNewGameTitle(launch)) return launch;
    const introTitle = cleanTitle(facts.haoyouIntroTitle || "", game);
    if (introTitle && !isGenericNewGameTitle(introTitle)) return introTitle;
  }
  const raw = event?.title || (type === "活动" ? facts.haoyouUpdateContent : "") || facts.haoyouWarmLabel || article.title || type;
  const cleaned = cleanTitle(raw, game);
  if (/^(?:8\.\d+|\d{1,2}月\d{1,2}日)?好游快爆(?:最新消息|资讯)?$/u.test(cleaned)) return "";
  if (/^(?:置顶官方|官方|游戏介绍|简介|最新消息|新游|什么是官服|测试资格|预约|下载|福利|礼包)$/u.test(cleaned)) return "";
  if (type === "新游" && isGenericNewGameTitle(cleaned)) return "";
  return cleaned;
}

function splitHaoyouActivity(value = "", timestamp = 0) {
  const text = absolutizeDateText(cleanTitle(value), timestamp)
    .replace(/^\s*(?:更新|活动|联动)\s*[:：]?\s*/u, "")
    .trim();
  if (!text) return { title: "", summary: "" };

  // 好游时间线通常只提供一条完整活动文案。按第一个自然停顿拆成
  // “活动标题 + 核心内容”，避免飞书里出现同一句标题和正文重复。
  const match = /^(.{5,70}?)([，；;。！？!?])\s*(.{4,360})$/u.exec(text);
  // 没有可拆分的第二句时保留原句；recordContent 会自动避免重复写两次。
  if (!match) return { title: text, summary: text };
  return { title: match[1].trim(), summary: match[3].trim() };
}

function formatChineseDate(timestamp, { includeTime = false } = {}) {
  const date = new Date(timestamp);
  const dateText = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  if (!includeTime || (!date.getHours() && !date.getMinutes())) return dateText;
  return `${dateText}${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function absolutizeDateText(value = "", timestamp = 0) {
  const fallback = Number.isFinite(Number(timestamp)) && Number(timestamp) > 0
    ? new Date(Number(timestamp))
    : new Date();
  const year = fallback.getFullYear();
  const relative = {
    今天: 0,
    明天: 1,
    后天: 2,
    昨天: -1,
    前天: -2,
  };
  return String(value || "")
    .replace(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日\s*[（(](?:(?:\d+)天[前后]|今天|明天|后天|昨天|前天)[）)]/gu, (_all, explicitYear, month, day) => `${explicitYear || year}年${Number(month)}月${Number(day)}日`)
    .replace(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/gu, (_all, explicitYear, month, day) => `${explicitYear || year}年${Number(month)}月${Number(day)}日`)
    .replace(/(?:(20\d{2})[./])?(\d{1,2})\.(\d{1,2})\s*[（(](?:(?:\d+)天[前后]|今天|明天|后天|昨天|前天)[）)]/gu, (_all, explicitYear, month, day) => `${explicitYear || year}年${Number(month)}月${Number(day)}日`)
    .replace(/(?<!\d)(今天|明天|后天|昨天|前天)(?!\d)/gu, (word) => {
      const date = new Date(fallback);
      date.setDate(date.getDate() + relative[word]);
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    })
    .replace(/\s+/gu, " ")
    .trim();
}

function compactNewGameSchedule(value = "", timestamp = 0) {
  const eventDate = formatChineseDate(timestamp);
  const plain = String(value || "")
    .replace(/<[^>]+>/gu, "\n")
    .replace(/收起内容|展开内容/gu, "");
  const fragments = plain
    .split(/[\n。！？!?；;]/u)
    .map((part) => absolutizeDateText(part, timestamp)
      .replace(/(?:好游快爆)?20\d{2}年\d{1,2}月\d{1,2}日消息[！!]?/gu, "")
      .trim())
    .filter(Boolean);
  const dateKey = eventDate.replace(/年|月|日/gu, "");
  const candidates = fragments.filter((part) => /(?:上线|首发|测试|公测|内测|删档|预下载|招募|开服|试玩)/u.test(part));
  const exactDate = candidates.find((part) => normalize(part).includes(normalize(dateKey)));
  let selected = exactDate || candidates.find((part) => part.length <= 180) || candidates[0] || fragments[0] || "";
  selected = selected.replace(/^.*?(?=(?:测试服|正式服|限量|不限量|删档|公测|内测|预下载|将于|已于|定于|预计|\d{1,2}(?::|点)))/u, "").trim();
  if (!selected) return "";
  if (!/20\d{2}年\d{1,2}月\d{1,2}日/u.test(selected)) {
    if (/^(?:测试服|正式服)?已于/u.test(selected)) selected = selected.replace(/已于/u, `已于${eventDate}`);
    else if (/^(?:将于|定于|预计于)/u.test(selected)) selected = selected.replace(/^(将于|定于|预计于)/u, `$1${eventDate}`);
    else selected = `${eventDate}${selected.startsWith("上午") || selected.startsWith("下午") || selected.startsWith("早") || /^\d/.test(selected) ? "" : " "}${selected}`;
  }
  return selected.replace(/\s+/gu, " ").slice(0, 180).trim();
}

function contentText(article, facts, type, titleText, timestamp) {
  const event = Array.isArray(facts.taptapEvents) ? facts.taptapEvents[0] : null;
  if (type === "活动" && article.source_id === "ref-haoyou" && facts.haoyouUpdateContent) {
    return splitHaoyouActivity(facts.haoyouUpdateContent, timestamp).summary;
  }
  if (type === "新游" && article.source_id === "ref-haoyou") {
    // 时间线没有状态短句时，详情正文只抽取带上线/测试信号的一句，
    // 不把游戏介绍或论坛正文整段写入监控记录。
    return compactNewGameSchedule(facts.haoyouUpdateContent || article.paragraphs || "", timestamp);
  }
  const raw = type === "活动"
    ? (event?.summary || facts.haoyouUpdateContent || article.paragraphs || "")
    : (article.source_id === "ref-haoyou" && facts.haoyouUpdateContent
      ? facts.haoyouUpdateContent
      : facts.haoyouIntro || article.paragraphs || "");
  const values = Array.isArray(raw) ? raw : [raw];
  const cleaned = values
    .flatMap((value) => String(value || "").split(/\n|<br\s*\/?\s*>/iu))
    .map((value) => absolutizeDateText(value.replace(/<[^>]+>/gu, ""), timestamp))
    .filter((value) => {
      const normalizedValue = normalize(value);
      const normalizedTitle = normalize(titleText);
      return value && !isNoise(value) && normalizedValue !== normalizedTitle &&
        !(normalizedTitle && (normalizedValue.includes(normalizedTitle) || normalizedTitle.includes(normalizedValue)));
    });
  if (type === "活动") return cleaned.slice(0, 3).join("\n").slice(0, 500);
  return cleaned.slice(0, 5).join("\n").slice(0, 500);
}

function sourcePriority(article, facts, type, content) {
  // 飞书监控的主来源按事件类型区分：
  // 新游优先 TapTap 的上架/首发详情；活动优先好游快爆的时间线更新。
  // 这只影响飞书文档与提醒机器人，不改变今日简讯、海报的来源选择。
  const platformPriority = type === "活动"
    ? (article.source_id === "ref-haoyou" ? 40 : article.source_id === "ref-taptap" ? 20 : 15)
    : (article.source_id === "ref-taptap" ? 40 : article.source_id === "ref-haoyou" ? 20 : 15);
  return (type === "活动" ? 200 : 100) +
    platformPriority +
    (Array.isArray(facts.taptapEvents) && facts.taptapEvents.length ? 30 : 0) +
    Math.min(content.length, 500) + Number(article.score || 0);
}

function preferMonitorItem(candidate, current) {
  const preferredSource = candidate.type === "活动" ? "ref-haoyou" : "ref-taptap";
  if (candidate.article?.source_id === preferredSource && current.article?.source_id !== preferredSource) return true;
  if (current.article?.source_id === preferredSource && candidate.article?.source_id !== preferredSource) return false;
  return Number(candidate.score || 0) > Number(current.score || 0);
}

function canonicalEventUrl(value = "") {
  return urlKey(String(value || "").replace(/[?#].*$/u, ""));
}

function activityEventUrl(item = {}) {
  const direct = canonicalEventUrl(item.facts?.taptapEvents?.[0]?.url || item.facts?.taptapEventUrl || "");
  if (direct) return direct;
  const sourceUrl = canonicalEventUrl(item.article?.detail_url || item.fields?.["原文链接"]?.link || "");
  const localFacts = localArticleFactsByUrl.get(sourceUrl);
  return canonicalEventUrl(localFacts?.taptapEvents?.[0]?.url || localFacts?.taptapEventUrl || "");
}

function activityStableKey(item = {}) {
  const game = normalize(item.game || item.fields?.["游戏名"] || "");
  const date = item.dateKey || eventDateKey(item.fields?.["时间"]) || "无日期";
  const eventUrl = activityEventUrl(item);
  if (eventUrl) return `${game}|活动|${date}|event:${eventUrl}`;
  const sourceUrl = canonicalEventUrl(item.article?.detail_url || item.fields?.["原文链接"]?.link || "");
  const content = normalize(item.content || item.fields?.["内容"] || "").slice(0, 260);
  return `${game}|活动|${date}|url:${sourceUrl}|content:${content}`;
}

function activitySameEvent(item, row) {
  const rowFields = row.fields || row;
  const game = normalize(item.game || "");
  const rowGame = normalize(cleanGameName(row.game || rowFields["游戏名"] || ""));
  const rowType = row.type || storedType(row);
  if (!game || game !== rowGame || item.type !== "活动" || rowType !== "活动") return false;
  const itemDate = item.dateKey || eventDateKey(item.time);
  const rowDate = row.dateKey || eventDateKey(rowFields["时间"]);
  const itemEventUrl = activityEventUrl(item);
  const rowEventUrl = activityEventUrl(row);
  if (itemEventUrl && rowEventUrl && itemEventUrl === rowEventUrl) return true;
  if (!itemDate || !rowDate) return false;
  const itemTimestamp = Number(item.time || 0);
  const rowTimestamp = Number(row.time || rowFields["时间"] || 0);
  // 跨平台存在小时、时区和“明天/具体日期”表达差异；同游戏活动在两天内仍可合并。
  // 超过两天则视为同游戏的另一场运营事件，必须保留。
  if (itemTimestamp && rowTimestamp) {
    if (Math.abs(calendarDay(itemTimestamp) - calendarDay(rowTimestamp)) > 2 * 86400000) return false;
  } else if (itemDate !== rowDate) {
    return false;
  }
  const rowSourceUrl = canonicalEventUrl(row.article?.detail_url || rowFields["原文链接"]?.link || "");
  const itemSourceUrl = canonicalEventUrl(item.article?.detail_url || "");
  const rowTitle = row.title || cleanTitle(String(rowFields["内容"] || "").split(/\n/u)[0] || "", rowFields["游戏名"] || "");
  const rowContent = row.content || String(rowFields["内容"] || "");
  const titleMatch = eventTitlesOverlap(item.title || "", rowTitle) || normalize(item.title || "") === normalize(rowTitle);
  const contentMatch = contentSimilarity(item.content || "", rowContent) >= 0.6;
  if (itemSourceUrl && itemSourceUrl === rowSourceUrl && (titleMatch || contentMatch)) return true;
  // 不同平台的详情页链接天然不同。只要同游戏、日期相近且活动标题关键词重叠，
  // 即按同一活动处理，再由 sourcePriority 决定保留好游快爆还是 TapTap。
  if (titleMatch) return true;
  return false;
}

function eventKey(item) {
  return activityStableKey(item);
}

function eventDateKey(value) {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 100000000000) return displayDate(numeric).slice(0, 10);
  const match = String(value).match(/(20\d{2})[-年\/](\d{1,2})[-月\/](\d{1,2})/u);
  return match ? `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}` : "";
}

function rowGameDateKey(row) {
  const fields = row?.fields || row || {};
  const game = normalize(cleanGameName(fields["游戏名"] || ""));
  const date = eventDateKey(fields["时间"]);
  return game && date ? `${game}|${date}` : "";
}

function ratingOrder(value = "") {
  const label = String(value || "").trim();
  if (label.startsWith("S")) return 4;
  if (label.startsWith("A")) return 3;
  if (label.startsWith("B")) return 2;
  return 1;
}

function ratingLabelForScore(value = 0) {
  const score = Number(value) || 0;
  return score >= 80 ? "S · 重点" : score >= 60 ? "A · 优先" : score >= 45 ? "B · 常规" : "C · 留档";
}

function normalizeRatingLabel(value = "") {
  const label = String(value || "").trim();
  if (label.startsWith("S")) return "S · 重点";
  if (label.startsWith("A")) return "A · 优先";
  if (label.startsWith("B")) return "B · 常规";
  return "C · 留档";
}

function ratingValueForLabel(value = "") {
  const label = normalizeRatingLabel(value);
  return label.startsWith("S") ? 80 : label.startsWith("A") ? 60 : label.startsWith("B") ? 45 : 0;
}

function calendarDay(timestamp = 0) {
  const date = new Date(Number(timestamp) || 0);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function sortByTimeThenRating(left, right) {
  // 飞书表里的“时间”列展示到日期。业务上的“同一时间”因此按同一天处理，
  // 不能再让 09:50 的 C 级排在 10:00 的 S 级之前。
  const dayDiff = calendarDay(left.fields?.时间) - calendarDay(right.fields?.时间);
  if (dayDiff) return dayDiff;
  const ratingDiff = ratingOrder(right.fields?.评级) - ratingOrder(left.fields?.评级);
  if (ratingDiff) return ratingDiff;
  const scoreDiff = Number(right.fields?.评分 || 0) - Number(left.fields?.评分 || 0);
  return scoreDiff
    || Number(left.fields?.时间 || 0) - Number(right.fields?.时间 || 0)
    || String(left.fields?.游戏名 || "").localeCompare(String(right.fields?.游戏名 || ""), "zh-CN");
}

function sortScheduledRows(left, right) {
  // 视图展示顺序统一为：日期升序 → 评级 S/A/B/C → 同评级评分降序 → 具体时间升序。
  return sortByTimeThenRating(left, right);
}

function normalizeRecordFields(fields = {}) {
  const next = { ...fields };
  for (const field of ["评分", "时间", "排序权重", "排序日期", "入库时间", "评论/预约量"]) {
    if (next[field] !== undefined && next[field] !== "") next[field] = Number(next[field]) || 0;
  }
  return next;
}

function eventIdFor(item = {}) {
  const date = calendarDay(item.time);
  const title = normalize(item.title || item.content || "");
  const source = [item.type || "", normalize(item.game || ""), date, title].join("|");
  return `evt_${createHash("sha1").update(source, "utf8").digest("hex").slice(0, 20)}`;
}

function eventIdForFields(fields = {}) {
  const type = String(fields["类型"] || "").trim();
  const game = cleanGameName(fields["游戏名"] || "");
  const time = Number(fields["时间"] || 0);
  const content = String(fields["内容"] || "").split(/\n/u)[0].trim();
  if (!type || !game || !time || !content) return "";
  return eventIdFor({ type, game, time, title: content });
}

function isCompleteRecord(item) {
  const content = String(item.content || "").trim();
  // TapTap 个别详情页只返回重复的“更新日志 / 更新于 / 开放下载”元数据，
  // 不是可读的新游或活动正文；不进入飞书基线，等待下次详情完整时再收录。
  const logFragments = (content.match(/(?:更新日志|更新于|开放下载)/gu) || []).length;
  const duplicateLines = content.split(/\n+/u).map((line) => normalize(line)).filter(Boolean);
  const uniqueLineCount = new Set(duplicateLines).size;
  return Boolean(
    item.game && item.game.length >= 2 && !isInvalidGameName(item.game) &&
    /^(?:新游|活动)$/u.test(item.type) &&
    Number.isFinite(item.time) && item.time > 0 &&
    item.title && !isNoise(item.title) &&
    item.content && !isNoise(item.content) &&
    logFragments < 3 && !(duplicateLines.length >= 3 && uniqueLineCount <= 1) &&
    item.article?.detail_url,
  );
}

function toMonitorItem(article, now, factsOverride = null) {
  const facts = factsOverride || parseFacts(article.facts);
  const game = cleanGameName(article.game_name || article.title);
  const type = eventType(article, facts);
  const time = eventTime(article, facts, now);
  const haoyouActivity = type === "活动" && article.source_id === "ref-haoyou"
    ? splitHaoyouActivity(facts.haoyouUpdateContent, time)
    : null;
  const title = haoyouActivity?.title || eventTitle(article, facts, type, game);
  const content = contentText(article, facts, type, title, time);
  return {
    article, facts, game, type, time,
    dateKey: time ? displayDate(time).slice(0, 10) : "",
    title, content,
    score: sourcePriority(article, facts, type, content),
  };
}

function toMonitorItems(article, now) {
  return [toMonitorItem(article, now, parseFacts(article.facts))];
}

function fieldsFor(item, { alertStatus = "", ingestTime = runIngestTime } = {}) {
  const rating = ratingFor(item);
  return {
    时间: item.time,
    游戏名: item.game,
    类型: item.type,
    厂商: displayPublisher(item),
    标签: displayTags(item),
    评级: rating.label,
    评级来源: rating.source || "自动",
    评分: rating.value,
    // 飞书的文字排序会把 S 放在 A/B/C 之后，因此保存一个隐藏数值字段供视图稳定排序。
    排序权重: ratingOrder(rating.label),
    // 时间字段包含小时。视图需先按自然日分组，再在同一天内按评级和评分排序。
    排序日期: calendarDay(item.time),
    ...(alertStatus ? { 提醒状态: alertStatus } : {}),
    记录状态: "当前",
    汇总可见: "是",
    "入库时间": ingestTime,
    事件ID: eventIdFor(item),
    "评论/预约量": engagementCountFor(item) ?? undefined,
    平台: item.article.source_id === "ref-taptap" ? "TapTap" : item.article.source_id === "ref-haoyou" ? "好游快爆" : "小七",
    内容: formatRecordLineBreaks(recordContent(item)),
    原文链接: item.article.detail_url ? { link: item.article.detail_url, text: "打开原文" } : undefined,
  };
}

function originalImageUrl(value = {}) {
  const candidate = typeof value === "string" ? value : value?.originalUrl || value?.url || value?.src || "";
  return /^https?:\/\//iu.test(String(candidate)) ? String(candidate) : "";
}

function notificationMedia(item) {
  const images = Array.isArray(item.article?.images) ? item.article.images : [];
  return {
    iconUrl: originalImageUrl(item.article?.image_url) || originalImageUrl(images[0]),
    coverUrl: originalImageUrl(images[0]) || originalImageUrl(item.article?.image_url),
  };
}

function displayPublisher(item) {
  const value = item.article.source_id === "ref-taptap"
    ? item.facts.taptapPublisher
    : item.article.source_id === "ref-haoyou"
      ? item.facts.haoyouPublisher
      : item.facts.x7Publisher;
  const normalized = String(value || "").trim();
  return /^(?:undefined|null|官方已入驻)$/iu.test(normalized) ? "" : normalized;
}

function hasUsablePublisher(value) {
  return Boolean(String(value || "").trim()) && !/^(?:undefined|null|官方已入驻)$/iu.test(String(value || "").trim());
}

function engagementCountFor(item) {
  const value = item.type === "新游"
    ? item.article.source_id === "ref-taptap"
      ? item.facts.taptapReserveCount ?? item.facts.taptapFollowerCount
      : item.article.source_id === "ref-haoyou"
        ? item.facts.haoyouReserveCount ?? item.facts.haoyouFollowerCount ?? item.facts.haoyouReviewCount
        : item.article.source_id === "ref-x7"
          ? item.facts.x7ReserveCount
          : null
    : item.article.source_id === "ref-taptap"
      ? item.facts.taptapReviewCount
      : item.article.source_id === "ref-haoyou"
        ? item.facts.haoyouReviewCount
        : null;
  if (value == null || String(value).trim() === "") return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function engagementMetricName(item) {
  if (item.type === "新游" && item.article.source_id === "ref-taptap" && item.facts.taptapReserveCount == null && item.facts.taptapFollowerCount != null) return "关注量";
  if (item.type === "新游" && item.article.source_id === "ref-haoyou") {
    if (item.facts.haoyouReserveCount != null) return "预约量";
    if (item.facts.haoyouFollowerCount != null) return "关注量";
    if (item.facts.haoyouReviewCount != null) return "评论量（新游兜底）";
  }
  return item.type === "新游" ? "预约量" : "评论量";
}

function followerCountFor(item) {
  if (item.article.source_id !== "ref-taptap") return null;
  const count = Number(item.facts.taptapFollowerCount);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function mobileQualitySignals(item) {
  const heat = getMobilePrioritySignals({
    sourceId: item.article.source_id,
    title: item.title,
    gameName: item.game,
    facts: item.facts,
    forceEvent: true,
  });
  const reviews = engagementCountFor(item);
  const topNewDownload = Number(item.facts.taptapNewDownloadRank || 0) > 0 && Number(item.facts.taptapNewDownloadRank) <= 10;
  const protectedByHeat = heat.ipBoost >= 6 || heat.heatBoost >= 9 || topNewDownload;
  return { heat, reviews, protectedByHeat };
}

// 评价数量只作为新游的低质量拦截信号：首发早期评价天然较少，
// 因此榜单前列、稳定高热 IP 或内容充分的游戏不会被一刀切删除。
function isLowQualityNewGame(item) {
  if (item.type !== "新游") return false;
  const { reviews, protectedByHeat } = mobileQualitySignals(item);
  if (reviews == null || protectedByHeat) return false;
  return reviews < 10 && item.content.length < 160;
}

// 评论量代表已沉淀的真实玩家反馈，只做正向评级加分；
// 新近首发的低评论量仍由低质量过滤与 IP/榜单保护单独判断，不能在评级里重复扣分。
function engagementRatingBonus(reviews) {
  if (reviews == null) return 0;
  if (reviews >= 10000) return 18;
  if (reviews >= 5000) return 14;
  if (reviews >= 1000) return 10;
  if (reviews >= 500) return 7;
  if (reviews >= 100) return 4;
  return 0;
}

function followerRatingBonus(followers) {
  if (followers == null) return 0;
  if (followers >= 300000) return 20;
  if (followers >= 100000) return 14;
  if (followers >= 50000) return 10;
  if (followers >= 10000) return 5;
  return 0;
}

// 厂商反映研发/发行稳定性：头部厂商正向加分；工作室或未识别为头部的厂商减分。
// 厂商缺失只代表未抓到信息，不作为质量负面信号。
const TOP_PUBLISHER_PATTERN = /腾讯|网易|米哈游|miHoYo|莉莉丝|心动|鹰角|叠纸|库洛|沐瞳|灵犀|朝夕光年|完美世界|哔哩哔哩|bilibili|游科|游戏科学|金山/iu;

// 人工校准不是临时改表：它用于记录“同类信号无法概括”的明确编辑判断。
// 后续新增仍以通用 IP、厂商、热度、评论和内容规则为主；仅同名游戏命中时才覆盖边界。
const MANUAL_RATING_CALIBRATIONS = [
  { type: "新游", game: "代号U1", min: 60, reason: "人工确认：重点候选" },
  { type: "新游", game: "菜鸡梦想家", max: 59, reason: "人工确认：不作为重点新游" },
  { type: "新游", game: "江城创业记", max: 59, reason: "人工确认：垂直买断移植，不进入优先层" },
  // 这是手游分发优先级，不是纯玩家热度：以下条目即使活动声量大，
  // 其平台收益/转化价值仍按人工判断限制在对应层级。
  ...["鸣潮", "穿越火线-枪战王者", "第五人格", "明日之后", "永劫无间手游", "QQ飞车", "萤火突击", "使命召唤手游体验服", "蛋仔派对", "崩坏：星穹铁道", "燕云十六声", "烹饪环游记"]
    .map((game) => ({ type: "活动", game, min: 45, max: 59, reason: "人工确认：分发价值常规" })),
  ...["金铲铲之战", "极品飞车：集结", "三角洲行动体验服", "明日方舟：终末地", "西游：笔绘西行", "奥特曼传奇英雄2"]
    .map((game) => ({ type: "活动", game, min: 60, max: 79, reason: "人工确认：分发价值优先" })),
  ...["物华弥新", "夜幕之下", "星之翼", "艾塔纪元", "异世界勇者", "东离剑游纪", "密室逃脱7环游世界", "超阈限空间", "卡拉彼丘", "三国望神州", "完美道途", "大周列国志", "同盟神探", "盲盒派对", "裂隙审判", "战魂觉醒OL", "梦想城镇", "神行少女", "云梦华裳", "奥奇传说", "梦的第七章", "金色传说"]
    .map((game) => ({ type: "活动", game, max: 44, reason: "人工确认：留档活动" })),
];

// 飞书中人工修改过的评级优先于自动计算；本轮同步开始后从已有记录动态读取，
// 不把人工判断硬编码成一次性规则，也不会覆盖用户已经改过的旧行。
let manualRatingOverrides = new Map();
// 游戏评级表是游戏级的人工确认入口；后续新游/活动优先继承它，不再由单条事件覆盖。
let gameRatingOverrides = new Map();

function publisherRatingSignal(item) {
  const publisher = displayPublisher(item);
  if (!publisher) return { bonus: 0, reason: "" };
  if (TOP_PUBLISHER_PATTERN.test(publisher)) return { bonus: 10, reason: `头部厂商 ${publisher} +10` };
  return { bonus: -5, reason: `非头部厂商 ${publisher} -5` };
}

function manualRatingCalibration(item) {
  const game = normalize(item.game || "");
  return MANUAL_RATING_CALIBRATIONS.find((rule) => rule.type === item.type && normalize(rule.game) === game) || null;
}

function activityImpact(text = "") {
  if (/限时券后|新史低|折扣/u.test(text)) return { base: 8, ceiling: 44, reason: "促销类活动" };
  // 联动/周年的事件规格天然高于常规版本。后续再由游戏分发价值决定最终能否保留 A/S。
  if (/(?:周年(?:庆典|活动|版本)?|联动)/u.test(text)) {
    const major = /(?:重磅|大型|全新|限定|免费.*(?:领取|解锁)|多个|系列|版本|赛季|地图|玩法|角色)/u.test(text);
    return major
      ? { base: 68, ceiling: 88, reason: "大型联动/周年" }
      : { base: 58, ceiling: 79, reason: "联动/周年活动" };
  }
  if (/全新赛季|新赛季|资料片|新地图|新模式|新区域|主线(?:剧情)?.*(?:开启|更新)|大版本/u.test(text)) {
    return { base: 60, ceiling: 84, reason: "赛季/玩法级活动" };
  }
  if (/(?:\d+\.\d+|版本|暑期|体验服|赛季|新角色|全新角色|活动(?:开启|上线)|限定.*(?:复刻|返场))/u.test(text)) {
    return { base: 30, ceiling: 59, reason: "常规版本/活动" };
  }
  return { base: 15, ceiling: 44, reason: "轻量活动" };
}

function ratingForActivity(item, { heat, tags, publisher, reviews }) {
  const text = `${item.game} ${item.title} ${item.content}`;
  const impact = activityImpact(text);
  // 对活动而言，规格决定候选档位；游戏热度/厂商/跨平台只用于同规格内的分发价值排序。
  let value = impact.base + Math.min(16, heat.ipBoost * 2);
  if (publisher.bonus > 0) value += 8;
  if (item.platformCount >= 2) value += 4;
  if (tags.length >= 3) value += 2;
  if (item.content.length >= 160) value += 5;
  else if (item.content.length >= 60) value += 3;
  value = Math.min(value, impact.ceiling);
  const revenue = revenueRatingSignal(item);
  value += revenue.bonus;
  value = Math.max(value, revenue.floor);
  // 评论量是活动质量修正；收益排名代表游戏分发价值，两者不再互相覆盖。
  // 人工评级会在后面覆盖该自动计算。
  if (reviews != null) value = reviews <= 100 ? Math.min(value, 44) : Math.max(value, 45);
  value = Math.max(value, revenue.floor);
  const manual = manualRatingCalibration(item);
  if (manual?.min) value = Math.max(value, manual.min);
  if (manual?.max) value = Math.min(value, manual.max);
  const label = value >= 80 ? "S · 重点" : value >= 60 ? "A · 优先" : value >= 45 ? "B · 常规" : "C · 留档";
  return { value: Math.min(value, 100), label, reasons: [impact.reason, ...(revenue.reason ? [revenue.reason] : []), ...(publisher.reason ? [publisher.reason] : []), ...(manual?.reason ? [manual.reason] : [])] };
}

function ratingFor(item) {
  const gameRating = gameRatingOverrides.get(normalize(item.game));
  if (gameRating) {
    return {
      value: gameRating.value,
      label: gameRating.label,
      source: "游戏评级表",
      reasons: ["沿用游戏评级表"],
    };
  }
  const manualOverride = manualRatingOverrides.get(`${item.type}|${normalize(item.game)}`);
  if (manualOverride) {
    return {
      value: manualOverride.value,
      label: manualOverride.label,
      source: manualOverride.source === "人工" ? "继承人工" : "历史参考",
      reasons: ["沿用飞书人工评级"],
    };
  }
  const text = `${item.game} ${item.title} ${item.content}`;
  const heat = getMobilePrioritySignals({
    sourceId: item.article.source_id,
    title: item.title,
    gameName: item.game,
    facts: item.facts,
    // 进入飞书表的条目已经通过“新游 / 活动”事件校验，不再依赖短标题重复出现活动关键词。
    forceEvent: true,
  });
  const tags = displayTags(item).split("|").map((tag) => tag.trim()).filter(Boolean);
  const { reviews } = mobileQualitySignals(item);
  const followers = followerCountFor(item);
  const publisher = publisherRatingSignal(item);
  if (item.type === "活动") return { ...ratingForActivity(item, { heat, tags, publisher, reviews }), source: "自动" };
  let value = item.type === "活动" ? 36 : 32;

  // 实时榜单/IP 信号来自共用 scorer，避免飞书、RAW、今日简讯各自维护一套热度词表。
  // 飞书评级需要更明显地体现“游戏本身是否值得关注”：
  // 实时榜单是短期信号，稳定高热游戏/IP是长期信号，二者分别计算，避免短标题把头部游戏压成 C。
  value += Math.round(heat.heatBoost * 1.25 + heat.ipBoost * 3);
  if (item.platformCount >= 2) value += 12;
  if (tags.length >= 3) value += 4;
  if (item.content.length >= 160) value += 10;
  else if (item.content.length >= 60) value += 6;
  else if (item.content.length >= 24) value += 3;

  value += engagementRatingBonus(reviews);
  value += followerRatingBonus(followers);
  value += publisher.bonus;
  // 头部厂商的新游即使详情尚未补全，也应具备基础关注度；活动不套用该项。
  if (item.type === "新游" && publisher.bonus > 0) value += 6;

  if (item.type === "新游") {
    if (/(?:首发|正式上线|公测|开服)/u.test(text)) value += 20;
    else if (/(?:测试|内测|删档|招募|试玩)/u.test(text)) value += 12;
    else value += 5;
  } else {
    if (/(?:大版本|资料片|赛季|周年|联动|新角色|新玩法|新副本|新地图|新模式|重磅)/u.test(text)) value += 25;
    else if (/(?:版本|更新|活动|限时|开启|上线)/u.test(text)) value += 14;
    if (/(?:免费|福利|奖励|限定|返场|皮肤|礼包)/u.test(text)) value += 6;
  }

  // 新游的“新品榜”只代表短期曝光，不等同于稳定热度。
  // 单平台/低关注/低评价/非头部厂商且无高热 IP 的新游，最高只到 B，避免被榜单第 10 名直接抬到 A。
  const weakNewGame = item.type === "新游" &&
    (followers == null || followers < 10000) &&
    (reviews == null || reviews < 100) &&
    publisher.bonus <= 0 &&
    heat.ipBoost < 6 &&
    Number(item.facts.taptapNewDownloadRank || 0) > 5;
  let calibratedValue = weakNewGame ? Math.min(value, 59) : value;
  // 缺乏头部 IP/厂商支撑的 Steam 移植、买断或纯单机手游，保留但不自动抬入 A/S。
  const nichePortedMobile = item.type === "新游" && /Steam移植|买断制|单机/u.test(tags.join("|")) && heat.ipBoost < 6 && publisher.bonus <= 0;
  if (nichePortedMobile) calibratedValue = Math.min(calibratedValue, 59);
  const revenue = revenueRatingSignal(item);
  calibratedValue += revenue.bonus;
  // 新游按预约量；收益排名是分发价值底线，不再被低预约量硬压成 C。
  if (reviews != null) calibratedValue = reviews <= 100 ? Math.min(calibratedValue, 44) : Math.max(calibratedValue, 45);
  calibratedValue = Math.max(calibratedValue, revenue.floor);
  const manual = manualRatingCalibration(item);
  if (manual?.min) calibratedValue = Math.max(calibratedValue, manual.min);
  if (manual?.max) calibratedValue = Math.min(calibratedValue, manual.max);
  const label = calibratedValue >= 80 ? "S · 重点" : calibratedValue >= 60 ? "A · 优先" : calibratedValue >= 45 ? "B · 常规" : "C · 留档";
  return {
    value: Math.min(calibratedValue, 100),
    label,
    source: "自动",
    reasons: [...heat.reasons, ...(revenue.reason ? [revenue.reason] : []), ...(publisher.reason ? [publisher.reason] : []), ...(nichePortedMobile ? ["垂直买断/移植上限 B"] : []), ...(manual?.reason ? [manual.reason] : [])],
  };
}

// 飞书收录门槛：小七作为独立预约来源全部保留；TapTap/好游快爆仅收录 A/S。
// 该门槛只作用于飞书游戏评级、新游/活动收录，不影响 RAW_ARTICLES 和今日简讯。
function isFeishuAdmissionAllowed(item) {
  if (item.article?.source_id === "ref-x7") return true;
  const label = String(ratingFor(item).label || "").trim();
  return /^(?:A|S)(?:\s|·|$)/u.test(label);
}

function displayTags(item) {
  const sourceTags = item.article.source_id === "ref-taptap"
    ? item.facts.taptapTags
    : item.article.source_id === "ref-haoyou"
      ? item.facts.haoyouTags
      : item.facts.x7Tags;
  const tags = item.article.source_id === "ref-haoyou"
    ? filterGameplayTags(sourceTags || [])
    : [...new Set((sourceTags || []).map((tag) => String(tag || "").trim()).filter(Boolean))].slice(0, 20);
  const discount = item.article.source_id === "ref-x7"
    ? String(item.facts.x7Discount || "").trim()
    : "";
  return [...(discount ? [`${discount}折`] : []), ...tags].join(" | ");
}

function conciseIntro(value = "") {
  const text = String(value || "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
  if (!text) return "";
  const firstSentence = text.match(/^(.{20,360}?[。！？!?])/u)?.[1] || text;
  return firstSentence.trim();
}

// 保留分号本身，在分号后断行，便于飞书窄列快速阅读活动说明。
function formatRecordLineBreaks(value = "") {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    // 只清洗内容开头的“日期 + 更新：”，正文中的“将于9月4日更新”必须保留。
    .replace(/^\s*(?:(?:20\d{2}年)?\d{1,2}月\d{1,2}日)\s*更新\s*[:：]\s*/u, "")
    .replace(/，[ \t]*(?!\n)/gu, "，\n")
    .replace(/([；;])[ \t]*(?!\n)/gu, "$1\n")
    .replace(/([！!])[ \t]*(?!\n)/gu, "$1\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function structuredRecordContent(item) {
  // 正常写入、重排、定时同步必须使用同一套内容模板。
  // 旧版这里另造“标题：/正文：/介绍：”结构，导致重排后内容被覆盖。
  return recordContent(item);
}

function urlKey(value = "") {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || "").trim();
  }
}

function needsContentRepair(fields = {}, item = {}) {
  const content = String(fields["内容"] || "").trim();
  const firstLine = content.split(/\n/u)[0] || "";
  const game = normalize(item.game || fields["游戏名"] || "");
  const first = normalize(firstLine);
  const nextContent = recordContent(item);
  const sameStructuredContent = content === nextContent;
  const hasRelativeTime = /(?:今天|明天|后天|昨天|前天|\d+天[前后])/u.test(content);
  const hasDateLead = /^\s*(?:(?:20\d{2}年)?\d{1,2}月\d{1,2}日|(?:20\d{2}[./])?\d{1,2}\.\d{1,2})[^\n]*(?:更新|上线|首发|测试|活动)/u.test(firstLine);
  const repeatsGame = Boolean(game && first.startsWith(game));
  const hasGenericLead = /^(?:新游|活动)$/u.test(firstLine.trim());
  const isLongNewGameIntro = item.type === "新游" && content.length > 240;
  const isNewGameFormatChanged = item.type === "新游" && content !== nextContent;
  const isUnstructuredTapTapNewGame = item.type === "新游" && item.article?.source_id === "ref-taptap" &&
    !/^20\d{2}年\d{1,2}月\d{1,2}日\s*(?:首发|上线|公测|内测|测试)/u.test(content);
  const activityLines = content.split(/\n/u).map((line) => normalize(line)).filter(Boolean);
  const repeatsActivityTitle = item.type === "活动" && activityLines.slice(1).some((line) => line === normalize(item.title));
  return !sameStructuredContent && (
    hasRelativeTime || hasDateLead || repeatsGame || hasGenericLead || isLongNewGameIntro || isNewGameFormatChanged ||
    isUnstructuredTapTapNewGame || repeatsActivityTitle
  );
}

function displayDate(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}${date.getHours() || date.getMinutes() ? ` ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : ""}`;
}

function recordContent(item) {
  if (item.type === "活动") return [item.title, item.content]
    .filter(Boolean)
    .filter((value, index, values) => index === 0 || normalize(value) !== normalize(values[0]))
    .join("\n")
    .trim();
  if (item.type === "新游") {
    const statusText = [item.facts.taptapEventType, item.facts.haoyouUpdateContent, item.facts.x7LaunchStatus, item.title, item.content].filter(Boolean).join(" ");
    const status = /预下载/iu.test(statusText) ? "预下载"
      : /首发/iu.test(statusText) ? "首发"
        : /上线|上架/iu.test(statusText) ? "上线"
          : /测试|公测|内测|开测/iu.test(statusText) ? "测试" : "上线";
    const date = new Date(item.time);
    const dateText = `${date.getMonth() + 1}月${date.getDate()}日`;
    const timeText = date.getHours() || date.getMinutes()
      ? ` ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
      : "";
    const rawIntro = item.article.source_id === "ref-haoyou"
      ? item.facts.haoyouIntro
      : item.article.source_id === "ref-x7"
        ? item.facts.x7Intro || parseParagraphs(item.article.paragraphs)
        : item.facts.taptapIntro || parseParagraphs(item.article.paragraphs);
    const introValues = Array.isArray(rawIntro) ? rawIntro : [rawIntro];
    const intro = introValues
      .flatMap((value) => String(value || "").split(/\n|<br\s*\/?\s*>/iu))
      .map((value) => value.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim())
      .filter((value) => value && !isNoise(value) && normalize(value) !== normalize(item.game))
      .slice(0, 2)
      .join("\n")
      .slice(0, 420);
    return [`${dateText}${timeText}${status}`, intro].filter(Boolean).join("\n").trim();
  }
  return [`${formatChineseDate(item.time)} ${item.title}`.trim(), item.content].filter(Boolean).join("\n").trim();
}

const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const appBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}`;
const tableBase = (id) => `${appBase}/tables/${id}`;
const base = tableBase(sourceTableId);
const tablePayload = await api(`${appBase}/tables?page_size=100`, { headers });
if (inspectTables) {
  console.log(JSON.stringify({ mode: "inspect-tables", tables: (tablePayload.data?.items || []).map((table) => ({ tableId: table.table_id, name: table.name })) }, null, 2));
  process.exit(0);
}
const viewsPayload = await api(`${base}/views?page_size=100`, { headers });
const sourceViews = viewsPayload.data?.items || [];
const sharedMonitorViews = {
  newGames: sourceViews.find((view) => view.view_name === "新游") || null,
  activities: sourceViews.find((view) => view.view_name === "活动") || null,
  summary: sourceViews.find((view) => view.view_name === "汇总") || null,
  history: sourceViews.find((view) => view.view_name === "历史归档") || null,
};
// 实际结构是同一张“数据表”下的两个视图；没有这两个视图时才兼容旧版双表结构。
const sharedMonitorMode = Boolean(sharedMonitorViews.newGames && sharedMonitorViews.activities);
const legacyActivityTableId = (tablePayload.data?.items || [])
  .find((table) => table.name === "活动" && table.table_id !== sourceTableId)?.table_id || "";
const activityTableId = sharedMonitorMode ? "" : legacyActivityTableId;
let ratingTableId = (tablePayload.data?.items || []).find((table) => table.name === "游戏评级")?.table_id || "";
async function ensureField(targetTableId, fieldName, type = 1) {
  const fieldPayload = await api(`${tableBase(targetTableId)}/fields?page_size=100`, { headers });
  const fields = fieldPayload.data?.items || [];
  if (fields.some((field) => field.field_name === fieldName)) return false;
  if (!dryRun) {
    await api(`${tableBase(targetTableId)}/fields`, {
      method: "POST",
      headers,
      body: JSON.stringify({ field_name: fieldName, type }),
    });
  }
  return true;
}
async function ensureRatingTable() {
  if (ratingTableId) return { tableId: ratingTableId, created: false };
  if (dryRun) return { tableId: "", created: false };
  const created = await api(`${appBase}/tables`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      table: {
        name: "游戏评级",
        default_view_name: "游戏评级",
        fields: [
          { field_name: "游戏名", type: 1 },
          { field_name: "平台", type: 1 },
          { field_name: "游戏标签", type: 1 },
          { field_name: "评论/预约量", type: 2 },
          { field_name: "评级", type: 1 },
          { field_name: "厂商", type: 1 },
        ],
      },
    }),
  });
  ratingTableId = created.data?.table_id || created.data?.table?.table_id || "";
  if (!ratingTableId) throw new Error("创建游戏评级表失败：未返回 table_id");
  return { tableId: ratingTableId, created: true };
}
const ratingTable = await ensureRatingTable();
// 游戏评级表由创建接口一次性带入四个固定字段；部分飞书租户对新表立即查询 fields 会短暂返回 Internal Error，
// 因此不在同步时做额外字段探测，避免影响事件流水线。
if (ratingTableId) await ensureField(ratingTableId, "平台", 1);
const monitorTableIds = [sourceTableId, ...(activityTableId ? [activityTableId] : [])];
const addedFields = [];
for (const tableId of monitorTableIds) {
  for (const field of [
    { name: "类型", type: 1 },
    { name: "评级", type: 1 },
    { name: "评分", type: 2 },
    { name: "排序权重", type: 2 },
    { name: "排序日期", type: 5 },
    { name: "厂商", type: 1 },
    { name: "提醒状态", type: 1 },
    { name: "汇总可见", type: 1 },
    { name: "记录状态", type: 1 },
    { name: "评级来源", type: 1 },
    { name: "入库时间", type: 5 },
    { name: "事件ID", type: 1 },
    { name: "评论/预约量", type: 2 },
  ]) {
    if (await ensureField(tableId, field.name, field.type)) addedFields.push({ tableId, fieldName: field.name });
  }
}
const sourceFieldsPayload = await api(`${base}/fields?page_size=100`, { headers });
const typeField = (sourceFieldsPayload.data?.items || []).find((field) => field.field_name === "类型");
const timeField = (sourceFieldsPayload.data?.items || []).find((field) => field.field_name === "时间");
const ratingSortField = (sourceFieldsPayload.data?.items || []).find((field) => field.field_name === "排序权重");
const dateSortField = (sourceFieldsPayload.data?.items || []).find((field) => field.field_name === "排序日期");
const scoreField = (sourceFieldsPayload.data?.items || []).find((field) => field.field_name === "评分");
const summaryVisibleField = (sourceFieldsPayload.data?.items || []).find((field) => field.field_name === "汇总可见");
const recordStatusField = (sourceFieldsPayload.data?.items || []).find((field) => field.field_name === "记录状态");
const visibleScoreCondition = { field_id: scoreField?.field_id, operator: "isGreaterEqual", value: JSON.stringify(["45"]) };
const sameCondition = (actual, expected) => actual
  && actual.field_id === expected.field_id
  && actual.operator === expected.operator
  && String(actual.value ?? "") === String(expected.value ?? "");
async function configureSharedViews() {
  if (!sharedMonitorMode || !typeField || !timeField || !ratingSortField || !dateSortField || !scoreField || !recordStatusField || dryRun) return [];
  const configured = [];
  async function patchAndVerifyView(viewId, property) {
    const endpoint = `${base}/views/${encodeURIComponent(viewId)}`;
    await api(endpoint, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ property }),
    });
  }
  // 历史归档视图不再由同步流程自动创建。
  // 用户删除后应保持删除；历史数据仍保留在数据表中，不影响新游/活动/汇总视图。
  for (const [view, type] of [[sharedMonitorViews.newGames, "新游"], [sharedMonitorViews.activities, "活动"]]) {
    const detail = await api(`${base}/views/${encodeURIComponent(view.view_id)}`, { headers });
    const currentConditions = detail.data?.view?.property?.filter_info?.conditions || [];
    const hiddenFields = detail.data?.view?.property?.hidden_fields || [];
    const expectedHiddenFields = [...new Set([...hiddenFields, typeField.field_id, recordStatusField.field_id, ratingSortField.field_id])];
    const expectedValue = JSON.stringify([type]);
    const expectedConditions = [
      { field_id: typeField.field_id, operator: "is", value: expectedValue },
      { ...visibleScoreCondition },
    ];
    const expectedSorts = [
      { field_id: dateSortField.field_id, desc: false },
      { field_id: ratingSortField.field_id, desc: true },
      { field_id: scoreField.field_id, desc: true },
      { field_id: timeField.field_id, desc: false },
    ];
    const currentSorts = detail.data?.view?.property?.sort_info?.sorts || [];
    const sortMatches = currentSorts.length === expectedSorts.length
      && currentSorts.every((sort, index) => sort.field_id === expectedSorts[index].field_id && Boolean(sort.desc) === expectedSorts[index].desc);
    const alreadyConfigured = currentConditions.length === expectedConditions.length
      && expectedConditions.every((condition) => currentConditions.some((actual) => sameCondition(actual, condition)))
      && expectedHiddenFields.every((fieldId) => hiddenFields.includes(fieldId))
      && sortMatches;
    if (!alreadyConfigured) {
      await patchAndVerifyView(view.view_id, {
        filter_info: {
          conjunction: "and",
          conditions: expectedConditions,
        },
        hidden_fields: expectedHiddenFields,
        sort_info: { sorts: expectedSorts },
      });
    }
    configured.push({ viewId: view.view_id, viewName: view.view_name, type, changed: !alreadyConfigured, sortPreserved: sortMatches });
  }
  if (sharedMonitorViews.summary && summaryVisibleField) {
    const detail = await api(`${base}/views/${encodeURIComponent(sharedMonitorViews.summary.view_id)}`, { headers });
    const property = detail.data?.view?.property || {};
    const currentConditions = property.filter_info?.conditions || [];
    const expectedSorts = [
      { field_id: dateSortField.field_id, desc: false },
      { field_id: ratingSortField.field_id, desc: true },
      { field_id: scoreField.field_id, desc: true },
      { field_id: timeField.field_id, desc: false },
    ];
    const currentSorts = property.sort_info?.sorts || [];
    const sortMatches = currentSorts.length === expectedSorts.length
      && currentSorts.every((sort, index) => sort.field_id === expectedSorts[index].field_id && Boolean(sort.desc) === expectedSorts[index].desc);
    // 汇总只隐藏技术分隔行、被判重的来源行和 C 级记录；新游/活动/汇总统一只展示 S/A/B。
    const expectedVisible = JSON.stringify(["是"]);
    const expectedConditions = [
      { field_id: summaryVisibleField.field_id, operator: "is", value: expectedVisible },
      { ...visibleScoreCondition },
    ];
    const alreadyConfigured = currentConditions.length === expectedConditions.length
      && expectedConditions.every((condition) => currentConditions.some((actual) => sameCondition(actual, condition)))
      && sortMatches;
    if (!alreadyConfigured) {
      await patchAndVerifyView(sharedMonitorViews.summary.view_id, {
        filter_info: { conjunction: "and", conditions: expectedConditions },
        sort_info: { sorts: expectedSorts },
      });
    }
    configured.push({ viewId: sharedMonitorViews.summary.view_id, viewName: "汇总", type: "全部", changed: !alreadyConfigured, sortPreserved: true });
  }
  if (sharedMonitorViews.history?.view_id) {
    const detail = await api(`${base}/views/${encodeURIComponent(sharedMonitorViews.history.view_id)}`, { headers });
    const property = detail.data?.view?.property || {};
    const hiddenFields = property.hidden_fields || [];
    const expectedStatus = JSON.stringify(["历史"]);
    const currentConditions = property.filter_info?.conditions || [];
    const expectedSorts = [
      { field_id: dateSortField.field_id, desc: false },
      { field_id: ratingSortField.field_id, desc: true },
      { field_id: scoreField.field_id, desc: true },
      { field_id: timeField.field_id, desc: false },
    ];
    const currentSorts = property.sort_info?.sorts || [];
    const sortMatches = currentSorts.length === expectedSorts.length
      && currentSorts.every((sort, index) => sort.field_id === expectedSorts[index].field_id && Boolean(sort.desc) === expectedSorts[index].desc);
    const alreadyConfigured = currentConditions.length === 1
      && currentConditions[0].field_id === recordStatusField.field_id
      && currentConditions[0].operator === "is"
      && currentConditions[0].value === expectedStatus;
    if (!alreadyConfigured || !sortMatches) {
      await api(`${base}/views/${encodeURIComponent(sharedMonitorViews.history.view_id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          property: {
            filter_info: { conjunction: "and", conditions: [{ field_id: recordStatusField.field_id, operator: "is", value: expectedStatus }] },
            hidden_fields: [...new Set([...hiddenFields, recordStatusField.field_id, ratingSortField.field_id])],
            sort_info: { sorts: expectedSorts },
          },
        }),
      });
    }
    configured.push({ viewId: sharedMonitorViews.history.view_id, viewName: "历史归档", type: "历史", changed: !alreadyConfigured || !sortMatches });
  }
  return configured;
}
const configuredSharedViews = await configureSharedViews();
if (repairViewSorts) {
  console.log(JSON.stringify({ mode: dryRun ? "dry-run-repair-view-sorts" : "repair-view-sorts", configuredSharedViews }, null, 2));
  process.exit(0);
}
if (removeHistoryView) {
  const view = sharedMonitorViews.history;
  if (!view?.view_id) {
    console.log(JSON.stringify({ mode: "remove-history-view", removed: false, reason: "历史归档视图不存在" }, null, 2));
    process.exit(0);
  }
  if (!dryRun) {
    await api(`${base}/views/${encodeURIComponent(view.view_id)}`, { method: "DELETE", headers });
  }
  console.log(JSON.stringify({ mode: dryRun ? "dry-run-remove-history-view" : "remove-history-view", removed: !dryRun, viewId: view.view_id, viewName: view.view_name }, null, 2));
  process.exit(0);
}
if (inspectSharedViews) {
  const views = [];
  for (const view of Object.values(sharedMonitorViews).filter((item) => item?.view_id)) {
    const detail = await api(`${base}/views/${encodeURIComponent(view.view_id)}`, { headers });
    const property = detail.data?.view?.property || {};
    views.push({
      viewId: view.view_id,
      viewName: view.view_name,
      filter: property.filter_info || {},
      sorts: property.sort_info?.sorts || [],
      sortInfo: property.sort_info || null,
      viewType: detail.data?.view?.view_type || detail.data?.view?.view_type_name || null,
      hiddenFields: property.hidden_fields || [],
    });
  }
  console.log(JSON.stringify({ mode: "inspect-shared-views", configuredSharedViews, views }, null, 2));
  process.exit(0);
}
async function listTableRecords(targetTableId) {
  const rows = [];
  let pageToken = "";
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
    const payload = await api(`${tableBase(targetTableId)}/records?page_size=500${suffix}`, { headers });
    rows.push(...(payload.data?.items || []).map((row) => ({ ...row, _tableId: targetTableId })));
    pageToken = payload.data?.page_token || "";
  } while (pageToken);
  return rows;
}
const existing = await listTableRecords(sourceTableId);
const storedType = (row = {}) => {
  const fields = row.fields || row;
  const explicit = String(fields["类型"] || "").trim();
  const sourceUrl = String(fields["原文链接"]?.link || fields["原文链接"] || "");
  const facts = localArticleFactsByUrl.get(canonicalEventUrl(sourceUrl)) || {};
  // 存量记录优先依据来源详情结构纠正分类，而不是只看标题关键词。
  // 好游快爆更新动态、TapTap game-event 都是活动，即使正文出现“上线/首发”等词也不能迁入新游。
  if (facts.haoyouKind === "update" || Array.isArray(facts.taptapEvents) && facts.taptapEvents.length || /taptap\.cn\/game-event\//iu.test(sourceUrl)) return "活动";
  // 已经明确标成活动的记录保留活动类型，避免活动正文里的“活动上线/正式上线”被反推成新游。
  if (explicit === "活动") return "活动";
  if (isStoredNewGameRow(row)) return "新游";
  if (explicit === "新游" || explicit === "活动") return explicit;
  return "活动";
};
const activityExisting = activityTableId
  ? await listTableRecords(activityTableId)
  : existing.filter((row) => storedType(row) === "活动");
const allExisting = sharedMonitorMode ? existing : [...existing, ...activityExisting];

if (removeBlankRows) {
  // 只删除物理空白/日期分隔行，不删除任何业务记录。
  // 技术字段（记录状态、汇总可见、评分等）可能存在于分隔行中，因此只检查业务字段。
  const businessFields = ["游戏名", "标题", "内容", "原文链接", "时间", "平台", "厂商", "游戏标签"];
  const isBlankRow = (row) => businessFields.every((field) => !String(row.fields?.[field] || "").trim());
  const blankRows = allExisting.filter((row) => row.record_id && isBlankRow(row));
  let backupPath = "";
  if (!dryRun && blankRows.length) {
    const backupDir = join(process.cwd(), "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `feishu-monitor-before-remove-blank-rows-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      blankRows,
    }, null, 2), "utf8");
    const groups = new Map();
    for (const row of blankRows) {
      const group = groups.get(row._tableId || sourceTableId) || [];
      group.push(row);
      groups.set(row._tableId || sourceTableId, group);
    }
    for (const [tableId, rows] of groups) {
      for (let index = 0; index < rows.length; index += 500) {
        await api(`${tableBase(tableId)}/records/batch_delete`, {
          method: "POST",
          headers,
          body: JSON.stringify({ records: rows.slice(index, index + 500).map((row) => row.record_id) }),
        });
      }
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-remove-blank-rows" : "remove-blank-rows",
    checked: allExisting.length,
    blankRows: blankRows.length,
    deleted: dryRun ? 0 : blankRows.length,
    backupPath,
  }, null, 2));
  process.exit(0);
}

if (repairEventIds) {
  const repairs = allExisting
    .filter((row) => String(row.fields?.["游戏名"] || "").trim())
    .map((row) => ({
      recordId: row.record_id,
      tableId: row._tableId || sourceTableId,
      eventId: eventIdForFields(row.fields || {}),
      current: String(row.fields?.["事件ID"] || "").trim(),
    }))
    .filter((repair) => repair.eventId && repair.eventId !== repair.current);
  let backupPath = "";
  if (!dryRun && repairs.length) {
    const backupDir = join(process.cwd(), "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `feishu-monitor-before-event-id-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: allExisting, repairs }, null, 2), "utf8");
    const groups = new Map();
    for (const repair of repairs) {
      const group = groups.get(repair.tableId) || [];
      group.push(repair);
      groups.set(repair.tableId, group);
    }
    for (const [tableId, group] of groups) {
      for (let index = 0; index < group.length; index += 100) {
        await api(`${tableBase(tableId)}/records/batch_update`, {
          method: "POST",
          headers,
          body: JSON.stringify({ records: group.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: { 事件ID: repair.eventId } })) }),
        });
      }
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-repair-event-ids" : "repair-event-ids",
    checked: allExisting.filter((row) => String(row.fields?.["游戏名"] || "").trim()).length,
    updated: dryRun ? 0 : repairs.length,
    planned: repairs.length,
    backupPath,
  }, null, 2));
  process.exit(0);
}

if (restoreFullLayoutPath) {
  const backup = JSON.parse(readFileSync(restoreFullLayoutPath, "utf8"));
  const restoreRows = (backup.rows || []).filter((row) => row?.fields && Object.keys(row.fields).length);
  const currentRows = allExisting.filter((row) => row?.record_id);
  let currentBackupPath = "";
  if (!dryRun) {
    const backupDir = join(process.cwd(), "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    currentBackupPath = join(backupDir, `feishu-monitor-before-restore-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(currentBackupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: currentRows }, null, 2), "utf8");
    for (let index = 0; index < currentRows.length; index += 500) {
      await api(`${base}/records/batch_delete`, {
        method: "POST", headers,
        body: JSON.stringify({ records: currentRows.slice(index, index + 500).map((row) => row.record_id) }),
      });
    }
    for (let index = 0; index < restoreRows.length; index += 100) {
      await api(`${base}/records/batch_create`, {
        method: "POST", headers,
        body: JSON.stringify({ records: restoreRows.slice(index, index + 100).map((row) => ({ fields: normalizeRecordFields(row.fields) })) }),
      });
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-restore-full-layout" : "restore-full-layout",
    restored: dryRun ? 0 : restoreRows.length,
    planned: restoreRows.length,
    deletedCurrent: dryRun ? 0 : currentRows.length,
    currentBackupPath,
    sourceBackup: restoreFullLayoutPath,
  }, null, 2));
  process.exit(0);
}

const ratingExisting = ratingTableId ? await listTableRecords(ratingTableId) : [];

if (promoteCToB) {
  const monitorRepairs = allExisting
    .filter((row) => String(row.fields?.["评级"] || "").trim().startsWith("C"))
    .map((row) => ({
      tableId: row._tableId || sourceTableId,
      recordId: row.record_id,
      fields: { 评级: "B · 常规", 评分: 45, 排序权重: 2, 评级来源: "人工" },
    }));
  const ratingRepairs = ratingExisting
    .filter((row) => String(row.fields?.["评级"] || "").trim().startsWith("C"))
    .map((row) => ({
      tableId: ratingTableId,
      recordId: row.record_id,
      fields: { 评级: "B · 常规" },
    }));
  const repairs = [...monitorRepairs, ...ratingRepairs];
  let backupPath = "";
  if (!dryRun && repairs.length) {
    const backupDir = join(process.cwd(), "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `feishu-monitor-before-promote-c-to-b-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      monitorRows: allExisting,
      ratingRows: ratingExisting,
      repairs,
    }, null, 2), "utf8");
    const groups = new Map();
    for (const repair of repairs) {
      const group = groups.get(repair.tableId) || [];
      group.push(repair);
      groups.set(repair.tableId, group);
    }
    for (const [tableId, group] of groups) {
      for (let index = 0; index < group.length; index += 100) {
        await api(`${tableBase(tableId)}/records/batch_update`, {
          method: "POST",
          headers,
          body: JSON.stringify({ records: group.slice(index, index + 100).map(({ recordId, fields }) => ({ record_id: recordId, fields })) }),
        });
      }
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-promote-c-to-b" : "promote-c-to-b",
    monitorUpdated: dryRun ? 0 : monitorRepairs.length,
    ratingUpdated: dryRun ? 0 : ratingRepairs.length,
    plannedMonitor: monitorRepairs.length,
    plannedRating: ratingRepairs.length,
    backupPath,
  }, null, 2));
  process.exit(0);
}

const ratingRowsByGame = new Map();
for (const row of ratingExisting) {
  const fields = row.fields || {};
  const game = cleanGameName(fields["游戏名"] || "");
  const key = normalize(game);
  if (!key) continue;
  const label = normalizeRatingLabel(fields["评级"]);
  const entry = { game, label, value: ratingValueForLabel(label), platform: String(fields["平台"] || "").trim(), tags: String(fields["游戏标签"] || "").trim(), publisher: String(fields["厂商"] || "").trim(), recordId: row.record_id };
  ratingRowsByGame.set(key, entry);
  gameRatingOverrides.set(key, entry);
}

// 首次留档：从已有新游/活动/历史记录按游戏去重，取评级来源、评级、评分更高的一条作为自动初始评级。
const ratingCandidateQuality = (row) => {
  const fields = row.fields || {};
  const source = String(fields["评级来源"] || "自动").trim();
  const sourceWeight = source === "人工" ? 3 : source === "继承人工" ? 2 : source === "历史参考" ? 1 : 0;
  return sourceWeight * 1_000_000 + ratingOrder(fields["评级"]) * 10_000 + Number(fields["评分"] || 0) * 10 + String(fields["内容"] || "").length;
};
const initialRatingCandidates = new Map();
for (const row of allExisting) {
  const fields = row.fields || {};
  const game = cleanGameName(fields["游戏名"] || "");
  const key = normalize(game);
  if (!key || ratingRowsByGame.has(key)) continue;
  const current = initialRatingCandidates.get(key);
  if (!current || ratingCandidateQuality(row) > ratingCandidateQuality(current.row)) {
    initialRatingCandidates.set(key, { row, game });
  }
}
const platformOrder = ["TapTap", "好游快爆", "小七"];
function mergePlatforms(values = []) {
  const found = new Set(values.flatMap((value) => String(value || "").split(/\s*\|\s*/u)).map((value) => value.trim()).filter(Boolean));
  return [...platformOrder.filter((platform) => found.delete(platform)), ...[...found].sort((left, right) => left.localeCompare(right, "zh-CN"))].join(" | ");
}
const platformsByGame = new Map();
for (const row of allExisting) {
  const key = normalize(cleanGameName(row.fields?.["游戏名"] || ""));
  if (!key) continue;
  const platforms = platformsByGame.get(key) || [];
  platforms.push(row.fields?.["平台"] || "");
  platformsByGame.set(key, platforms);
}
const initialRatingRecords = [...initialRatingCandidates.values()].map(({ row, game }) => {
  const fields = row.fields || {};
  const label = normalizeRatingLabel(fields["评级"] || ratingLabelForScore(fields["评分"]));
  return {
    fields: {
      游戏名: game,
      平台: mergePlatforms(platformsByGame.get(normalize(game)) || [fields["平台"]]),
      游戏标签: String(fields["标签"] || "").trim(),
      评级: label,
      厂商: String(fields["厂商"] || "").trim(),
    },
  };
});
const ratingPlatformUpdates = ratingExisting
  .map((row) => {
    const game = cleanGameName(row.fields?.["游戏名"] || "");
    const nextPlatform = mergePlatforms(platformsByGame.get(normalize(game)) || [row.fields?.["平台"]]);
    return nextPlatform && nextPlatform !== String(row.fields?.["平台"] || "").trim()
      ? { record_id: row.record_id, fields: { 平台: nextPlatform } }
      : null;
  })
  .filter(Boolean);
if (!dryRun && ratingTableId && ratingPlatformUpdates.length) {
  for (let index = 0; index < ratingPlatformUpdates.length; index += 100) {
    await api(`${tableBase(ratingTableId)}/records/batch_update`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records: ratingPlatformUpdates.slice(index, index + 100) }),
    });
  }
}
if (!dryRun && ratingTableId && initialRatingRecords.length) {
  for (let index = 0; index < initialRatingRecords.length; index += 100) {
    await api(`${tableBase(ratingTableId)}/records/batch_create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records: initialRatingRecords.slice(index, index + 100) }),
    });
  }
}
for (const record of initialRatingRecords) {
  const game = String(record.fields.游戏名 || "");
  const key = normalize(game);
  const label = normalizeRatingLabel(record.fields.评级);
  const entry = { game, label, value: ratingValueForLabel(label), platform: String(record.fields.平台 || ""), tags: String(record.fields.游戏标签 || ""), publisher: String(record.fields.厂商 || "") };
  ratingRowsByGame.set(key, entry);
  gameRatingOverrides.set(key, entry);
}

// “游戏评级”是评级的唯一主数据源。事件表保留事件级评分与正文，
// 但评级、排序权重和评级来源必须随游戏评级表的人工调整统一回填。
const ratingSyncRepairs = [];
for (const row of allExisting) {
  const fields = row.fields || {};
  const game = cleanGameName(fields["游戏名"] || "");
  if (!game) continue;
  const rating = gameRatingOverrides.get(normalize(game));
  if (!rating) continue;
  const nextLabel = normalizeRatingLabel(rating.label);
  const patch = {};
  if (String(fields["评级"] || "").trim() !== nextLabel) patch.评级 = nextLabel;
  if (Number(fields["排序权重"] || 0) !== ratingOrder(nextLabel)) patch.排序权重 = ratingOrder(nextLabel);
  if (String(fields["评级来源"] || "").trim() !== "游戏评级表") patch.评级来源 = "游戏评级表";
  if (!Object.keys(patch).length) continue;
  ratingSyncRepairs.push({
    recordId: row.record_id,
    tableId: row._tableId || (sharedMonitorMode || storedType(row) !== "活动" ? sourceTableId : activityTableId),
    fields: patch,
  });
}
let ratingSyncBackupPath = "";
if (!dryRun && syncGameRatings && ratingSyncRepairs.length) {
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  ratingSyncBackupPath = join(backupDir, `feishu-monitor-before-game-rating-sync-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(ratingSyncBackupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: allExisting }, null, 2), "utf8");
  const groups = new Map();
  for (const repair of ratingSyncRepairs) {
    const list = groups.get(repair.tableId) || [];
    list.push(repair);
    groups.set(repair.tableId, list);
  }
  for (const [tableId, repairs] of groups) {
    for (let index = 0; index < repairs.length; index += 100) {
      await api(`${tableBase(tableId)}/records/batch_update`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: repairs.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: repair.fields })) }),
      });
    }
  }
}
if (syncGameRatings) {
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-sync-game-ratings" : "sync-game-ratings",
    checked: allExisting.filter((row) => String(row.fields?.["游戏名"] || "").trim()).length,
    updated: dryRun ? 0 : ratingSyncRepairs.length,
    planned: ratingSyncRepairs.length,
    backupPath: ratingSyncBackupPath,
  }, null, 2));
  process.exit(0);
}

if (auditGameRatings) {
  const distribution = { S: 0, A: 0, B: 0, C: 0 };
  for (const row of [...ratingExisting, ...initialRatingRecords.map((record) => ({ fields: record.fields }))]) {
    const label = normalizeRatingLabel(row.fields?.["评级"] || "");
    distribution[label[0]] += 1;
  }
  console.log(JSON.stringify({
    mode: "audit-game-ratings",
    tableId: ratingTableId,
    existingRecords: ratingExisting.length,
    insertedThisRun: initialRatingRecords.length,
    totalRecords: ratingExisting.length + initialRatingRecords.length,
    distribution,
    samples: [...ratingExisting, ...initialRatingRecords.map((record) => ({ fields: record.fields }))].slice(0, 5).map((row) => row.fields),
  }, null, 2));
  process.exit(0);
}

if (auditHistoryLayout) {
  const historyRows = existing.filter((row) => String(row.fields?.["记录状态"] || "") === "历史");
  const historyRecords = historyRows.filter((row) => String(row.fields?.["游戏名"] || "").trim());
  const dividerIndexes = historyRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !String(row.fields?.["游戏名"] || "").trim())
    .map(({ index }) => index);
  const orderingViolations = [];
  for (let index = 1; index < historyRecords.length; index += 1) {
    if (sortScheduledRows(historyRecords[index - 1], historyRecords[index]) > 0) {
      orderingViolations.push({
        before: { 游戏名: historyRecords[index - 1].fields?.["游戏名"], 时间: displayDate(historyRecords[index - 1].fields?.["时间"]), 评级: historyRecords[index - 1].fields?.["评级"], 评分: historyRecords[index - 1].fields?.["评分"] },
        after: { 游戏名: historyRecords[index].fields?.["游戏名"], 时间: displayDate(historyRecords[index].fields?.["时间"]), 评级: historyRecords[index].fields?.["评级"], 评分: historyRecords[index].fields?.["评分"] },
      });
    }
  }
  const dividerViolations = dividerIndexes.filter((index) => {
    const before = historyRows[index - 1];
    const after = historyRows[index + 1];
    if (!before || !after || !String(before.fields?.["游戏名"] || "").trim() || !String(after.fields?.["游戏名"] || "").trim()) return true;
    return displayDate(before.fields?.["时间"]).slice(0, 10) === displayDate(after.fields?.["时间"]).slice(0, 10);
  });
  console.log(JSON.stringify({
    mode: "audit-history-layout",
    historyRecords: historyRecords.length,
    dateSeparators: dividerIndexes.length,
    orderingViolations: orderingViolations.length,
    dividerViolations: dividerViolations.length,
    first: historyRecords.length ? { 游戏名: historyRecords[0].fields?.["游戏名"], 时间: displayDate(historyRecords[0].fields?.["时间"]), 评级: historyRecords[0].fields?.["评级"] } : null,
    last: historyRecords.length ? { 游戏名: historyRecords.at(-1).fields?.["游戏名"], 时间: displayDate(historyRecords.at(-1).fields?.["时间"]), 评级: historyRecords.at(-1).fields?.["评级"] } : null,
  }, null, 2));
  process.exit(0);
}

if (false && repairHaoyouHistory) {
  // 历史版本曾把好游详情页的所有更新覆盖为“当前时间线日期”。
  // 这里按同一原文链接和正文语义匹配，将存量飞书行恢复到详情页历史事件日期。
  const historyItems = (listTodayArticles(new Date(), { includeMonitorOnly: true }).articles || [])
    .filter((article) => article.source_id === "ref-haoyou")
    .flatMap((article) => toMonitorItems(article, new Date(), { includeHaoyouHistory: true }))
    .filter((item) => item.type === "活动" && item.isHaoyouHistory && item.time);
  const byUrl = new Map();
  for (const item of historyItems) {
    const key = canonicalEventUrl(item.article.detail_url);
    const list = byUrl.get(key) || [];
    list.push(item);
    byUrl.set(key, list);
  }
  const repairs = [];
  for (const row of activityExisting) {
    const fields = row.fields || {};
    if (String(fields["平台"] || "") !== "好游快爆") continue;
    const game = cleanGameName(fields["游戏名"] || "");
    if (repairHaoyouGame && normalize(game) !== normalize(repairHaoyouGame)) continue;
    const candidates = (byUrl.get(canonicalEventUrl(fields["原文链接"]?.link || "")) || [])
      .filter((item) => normalize(item.game) === normalize(game));
    if (!candidates.length) continue;
    const currentContent = String(fields["内容"] || "");
    const currentTitle = cleanTitle(currentContent.split(/\n/u)[0] || "", game);
    const matched = [...candidates]
      .map((item) => ({
        item,
        score: contentSimilarity(currentContent, item.content) + (eventTitlesOverlap(currentTitle, item.title) ? 1 : 0),
      }))
      .sort((left, right) => right.score - left.score)[0];
    if (!matched) continue;
    // 仅修复能被正文首句或标题明确对应的历史事件。好游详情中常同时包含
    // 多个“将于 xx 日”的预告；低阈值关键词相似会把这些预告错配到别的日期。
    const currentLead = normalize(currentContent.split(/\n/u)[0] || currentTitle);
    const eventLead = normalize(matched.item.title || matched.item.content.split(/\n/u)[0] || "");
    const directLeadMatch = currentLead.length >= 6 && eventLead.length >= 6
      && (currentLead.includes(eventLead) || eventLead.includes(currentLead));
    const robustSemanticMatch = eventTitlesOverlap(currentTitle, matched.item.title)
      && contentSimilarity(currentContent, matched.item.content) >= 0.72;
    if (!(directLeadMatch || robustSemanticMatch) || matched.score < 0.85) continue;
    const next = fieldsFor(matched.item, { alertStatus: String(fields["提醒状态"] || "历史"), ingestTime: Number(fields["入库时间"] || runIngestTime) });
    const nextFields = { 时间: next.时间, 内容: next.内容 };
    if (Number(nextFields.时间) < repairHaoyouRangeStart || Number(nextFields.时间) > repairHaoyouRangeEnd) continue;
    if (Number(fields["时间"] || 0) !== Number(nextFields.时间) || String(fields["内容"] || "") !== String(nextFields.内容)) {
      repairs.push({ recordId: row.record_id, tableId: row._tableId || sourceTableId, fields: nextFields, preview: { 游戏名: game, 原时间: displayDate(fields["时间"]), 新时间: displayDate(nextFields.时间), 内容: nextFields.内容, 匹配分: Number(matched.score.toFixed(2)) } });
    }
  }
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `feishu-monitor-before-haoyou-history-repair-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: allExisting, repairs }, null, 2), "utf8");
  if (!dryRun) {
    const groups = new Map();
    for (const repair of repairs) {
      const list = groups.get(repair.tableId) || [];
      list.push(repair);
      groups.set(repair.tableId, list);
    }
    for (const [tableId, group] of groups) {
      for (let index = 0; index < group.length; index += 100) {
        await api(`${tableBase(tableId)}/records/batch_update`, {
          method: "POST",
          headers,
          body: JSON.stringify({ records: group.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: repair.fields })) }),
        });
      }
    }
  }
  console.log(JSON.stringify({ mode: dryRun ? "dry-run-repair-haoyou-history" : "repair-haoyou-history", historyEvents: historyItems.length, repaired: dryRun ? 0 : repairs.length, repairPlanned: repairs.length, backupPath, samples: repairs.slice(0, 20).map((repair) => repair.preview) }, null, 2));
  process.exit(0);
}

if (auditTable) {
  const nonEmpty = existing.filter((row) => String(row.fields?.["游戏名"] || "").trim());
  const byUrl = new Map();
  for (const row of nonEmpty) {
    const key = urlKey(row.fields?.["原文链接"]?.link || "");
    if (!key) continue;
    const rows = byUrl.get(key) || [];
    rows.push(row);
    byUrl.set(key, rows);
  }
  const duplicates = [...byUrl.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([url, rows]) => ({ url, count: rows.length, games: [...new Set(rows.map((row) => row.fields?.["游戏名"] || "")).values()] }))
    .slice(0, 50);
  const ordering = { 新游: [], 活动: [] };
  for (const type of Object.keys(ordering)) {
    const rows = existing
      .filter((row) => String(row.fields?.["游戏名"] || "").trim())
      .filter((row) => storedType(row) === type);
    for (let index = 1; index < rows.length; index += 1) {
      if (sortScheduledRows(rows[index - 1], rows[index]) > 0) {
        ordering[type].push({
          before: { 游戏名: rows[index - 1].fields?.["游戏名"], 时间: displayDate(rows[index - 1].fields?.["时间"]), 评级: rows[index - 1].fields?.["评级"], 评分: rows[index - 1].fields?.["评分"] },
          after: { 游戏名: rows[index].fields?.["游戏名"], 时间: displayDate(rows[index].fields?.["时间"]), 评级: rows[index].fields?.["评级"], 评分: rows[index].fields?.["评分"] },
        });
      }
    }
  }
  console.log(JSON.stringify({
    mode: "audit-table",
    sharedMonitorMode,
    views: sourceViews.map((view) => view.view_name),
    totalRows: existing.length,
    nonEmptyRows: nonEmpty.length,
    dividerRows: existing.length - nonEmpty.length,
    duplicateUrlGroups: duplicates.length,
    duplicates,
    orderingViolations: { 新游: ordering.新游.length, 活动: ordering.活动.length },
    orderingSamples: { 新游: ordering.新游.slice(0, 5), 活动: ordering.活动.slice(0, 5) },
  }, null, 2));
  process.exit(0);
}

if (dedupeExistingActivities) {
  // 仅清理既有活动中的明确重复记录；不处理日期分隔行，不处理新游。
  // 优先按“同一原文链接 + 同一事件日期 + 标题关键词重叠”判断，
  // 再兼容跨平台的“同游戏 + 日期接近 + 标题关键词重叠”。
  const activityRows = allExisting.filter((row) => {
    const fields = row.fields || {};
    return String(fields["游戏名"] || "").trim() && storedType(row) === "活动";
  });
  const titleOfRow = (row) => {
    const fields = row.fields || {};
    const game = cleanGameName(fields["游戏名"] || "");
    const content = String(fields["内容"] || "").split(/\n/u).map((line) => line.trim()).filter(Boolean);
    return cleanTitle(content[0] || "", game);
  };
  const platformOfRow = (row) => String(row.fields?.["平台"] || "").trim();
  const scoreOfRow = (row) => Number(row.fields?.["评分"] || 0) || 0;
  const qualityOfRow = (row) => {
    const fields = row.fields || {};
    const rating = ratingOrder(fields["评级"]);
    const content = String(fields["内容"] || "").trim().length;
    const tags = String(fields["标签"] || "").trim().length;
    const publisher = String(fields["厂商"] || "").trim().length;
    const ingest = Number(fields["入库时间"] || 0) || Number(row.created_time || 0) || Number.MAX_SAFE_INTEGER;
    return { rank: rating * 1_000_000 + scoreOfRow(row) * 10_000 + content * 10 + tags + publisher, ingest };
  };
  const activityDuplicate = (left, right) => {
    const leftFields = left.fields || {};
    const rightFields = right.fields || {};
    const leftGame = normalize(cleanGameName(leftFields["游戏名"] || ""));
    const rightGame = normalize(cleanGameName(rightFields["游戏名"] || ""));
    if (!leftGame || leftGame !== rightGame) return false;
    const leftDate = eventDateKey(leftFields["时间"]);
    const rightDate = eventDateKey(rightFields["时间"]);
    const leftEventUrl = activityEventUrl(left);
    const rightEventUrl = activityEventUrl(right);
    if (leftEventUrl && rightEventUrl && leftEventUrl === rightEventUrl) return true;
    if (!leftDate || !rightDate || leftDate !== rightDate) return false;
    const leftUrl = urlKey(leftFields["原文链接"]?.link || "");
    const rightUrl = urlKey(rightFields["原文链接"]?.link || "");
    const leftTitle = titleOfRow(left);
    const rightTitle = titleOfRow(right);
    const overlap = eventTitlesOverlap(leftTitle, rightTitle) || normalize(leftTitle) === normalize(rightTitle);
    if (!overlap) return false;
    // 同链接是最强证据；不同平台允许在同一事件上合并，但不合并两个完全不同来源的标题。
    if (leftUrl && rightUrl && leftUrl === rightUrl) return true;
    return platformOfRow(left) !== platformOfRow(right);
  };
  const groups = [];
  for (const row of activityRows) {
    const group = groups.find((items) => items.some((item) => activityDuplicate(item, row)));
    if (group) group.push(row);
    else groups.push([row]);
  }
  const duplicateGroups = groups.filter((group) => group.length > 1);
  const keepRow = (rows) => [...rows].sort((left, right) => {
    const a = qualityOfRow(left);
    const b = qualityOfRow(right);
    return b.rank - a.rank || a.ingest - b.ingest;
  })[0];
  const deletions = duplicateGroups.flatMap((group) => {
    const keeper = keepRow(group);
    return group.filter((row) => row.record_id !== keeper.record_id).map((row) => ({
      recordId: row.record_id,
      tableId: row._tableId || sourceTableId,
      keeperId: keeper.record_id,
      游戏名: row.fields?.["游戏名"] || "",
      时间: displayDate(row.fields?.["时间"]),
      平台: row.fields?.["平台"] || "",
      标题: titleOfRow(row),
      原文链接: row.fields?.["原文链接"]?.link || "",
    }));
  });
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `feishu-monitor-before-activity-dedupe-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    sourceTableId,
    activityTableId,
    rows: allExisting,
    duplicateGroups: duplicateGroups.map((group) => group.map((row) => row.record_id)),
    deletions,
  }, null, 2), "utf8");
  if (!dryRun && deletions.length) {
    const byTable = new Map();
    for (const item of deletions) {
      const list = byTable.get(item.tableId) || [];
      list.push(item.recordId);
      byTable.set(item.tableId, list);
    }
    for (const [tableId, recordIds] of byTable) {
      for (let index = 0; index < recordIds.length; index += 500) {
        await api(`${tableBase(tableId)}/records/batch_delete`, {
          method: "POST",
          headers,
          body: JSON.stringify({ records: recordIds.slice(index, index + 500) }),
        });
      }
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-dedupe-existing-activities" : "dedupe-existing-activities",
    activityRows: activityRows.length,
    duplicateGroups: duplicateGroups.length,
    duplicateRecords: deletions.length,
    deleted: dryRun ? 0 : deletions.length,
    backupPath,
    samples: deletions.slice(0, 20),
  }, null, 2));
  process.exit(0);
}

if (repairSummary) {
  // “汇总”与“新游/活动”同属一张飞书数据表，不能物理删除汇总里的行而不影响另两个视图。
  // 因此仅给汇总增加可见标记：重复行隐藏，源视图仍保留全部原始记录。
  const candidates = existing.filter((row) => String(row.fields?.["游戏名"] || "").trim());
  const groups = new Map();
  for (const row of candidates) {
    const fields = row.fields || {};
    const url = urlKey(fields["原文链接"]?.link || "");
    const isX7 = /x7sy\.com\/game\/app\//iu.test(url) || String(fields["平台"] || "") === "小七";
    // 小七同名游戏只在“同一上线时间”内视为重复；不同上线时间是不同发售事件。
    const key = isX7 ? `${url}|${Number(fields["时间"] || 0)}` : url || `${normalize(fields["游戏名"] || "")}|${Number(fields["时间"] || 0)}|${String(fields["类型"] || "")}`;
    const rows = groups.get(key) || [];
    rows.push(row);
    groups.set(key, rows);
  }
  const rankRow = (row) => {
    const fields = row.fields || {};
    const rating = ratingOrder(fields["评级"]);
    const score = Number(fields["评分"] || 0);
    const content = String(fields["内容"] || "").trim().length;
    const metadata = String(fields["标签"] || "").trim().length + String(fields["厂商"] || "").trim().length;
    return rating * 1_000_000 + score * 10_000 + content * 10 + metadata;
  };
  const updates = [];
  let duplicateGroups = 0;
  for (const rows of groups.values()) {
    const keeper = [...rows].sort((left, right) => rankRow(right) - rankRow(left))[0];
    if (rows.length > 1) duplicateGroups += 1;
    for (const row of rows) {
      const visible = row.record_id === keeper.record_id ? "是" : "否";
      if (String(row.fields?.["汇总可见"] || "") !== visible) {
        updates.push({ record_id: row.record_id, fields: { 汇总可见: visible } });
      }
    }
  }
  // 空白分隔行不属于汇总内容，避免在按时间排序的汇总视图中制造无意义空白。
  for (const row of existing.filter((row) => !String(row.fields?.["游戏名"] || "").trim())) {
    if (String(row.fields?.["汇总可见"] || "") !== "否") updates.push({ record_id: row.record_id, fields: { 汇总可见: "否" } });
  }
  let backupPath = "";
  if (!dryRun) {
    const backupDir = join(process.cwd(), "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `feishu-monitor-before-summary-visibility-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: existing }, null, 2), "utf8");
    for (let index = 0; index < updates.length; index += 100) {
      await api(`${base}/records/batch_update`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: updates.slice(index, index + 100) }),
      });
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-repair-summary" : "repair-summary",
    totalRows: existing.length,
    contentRows: candidates.length,
    summaryVisible: groups.size,
    hiddenRows: candidates.length - groups.size,
    duplicateGroups,
    updated: dryRun ? 0 : updates.length,
    updatePlanned: updates.length,
    backupPath,
    scope: "仅汇总视图；新游与活动视图不删除、不隐藏",
  }, null, 2));
  process.exit(0);
}

// 新建记录会明确标记为“自动”。为兼容此前没有来源字段的人工调整，旧记录作为“历史参考”
// 保留继承能力；之后用户手改评级，只需把“评级来源”标为“人工”，其优先级最高。
const ratingSourcePriority = { "人工": 3, "继承人工": 2, "历史参考": 1, "自动": 0 };
manualRatingOverrides = new Map();
for (const row of allExisting) {
  if (!row.fields?.["游戏名"] || !/^(?:S|A|B|C)/u.test(String(row.fields?.["评级"] || ""))) continue;
  const type = String(row.fields?.["类型"] || storedType(row) || "新游");
  const game = normalize(cleanGameName(row.fields?.["游戏名"] || ""));
  if (!game) continue;
  const label = String(row.fields?.["评级"] || "").trim();
  const value = Number(row.fields?.["评分"] || (label.startsWith("S") ? 80 : label.startsWith("A") ? 60 : label.startsWith("B") ? 45 : 0));
  const storedSource = String(row.fields?.["评级来源"] || "历史参考").trim() || "历史参考";
  // 用户通常只改“评级”文字；当自动来源的评级与原评分档位不一致时，自动识别为人工调整。
  const source = storedSource === "自动" && label !== ratingLabelForScore(value) ? "人工" : storedSource;
  // 明确标为自动的行只用于当前展示，不能反向锁死同游戏后续事件的重新评分。
  if (source === "自动") continue;
  const key = `${type}|${game}`;
  const candidate = { label, value: Number.isFinite(value) ? value : 0, source };
  const current = manualRatingOverrides.get(key);
  if (!current || (ratingSourcePriority[candidate.source] || 0) > (ratingSourcePriority[current.source] || 0)) {
    manualRatingOverrides.set(key, candidate);
  }
}

if (restoreHistoryArchive) {
  // 旧版“删表重建”已把过去日期从飞书移除；只从本地重排备份恢复过去事件，
  // 绝不覆盖现有记录，也不把未来条目写成历史。
  const backupDir = join(process.cwd(), "data", "backups");
  const backupFiles = readdirSync(backupDir)
    .filter((name) => /^feishu-monitor-before-schedule-.*\.json$/u.test(name))
    .sort();
  const archived = new Map();
  const historyKey = (row) => {
    const fields = row.fields || {};
    const type = storedType(row);
    const game = normalize(cleanGameName(fields["游戏名"] || ""));
    const day = eventDateKey(fields["时间"]);
    const lead = normalize(String(fields["内容"] || "").split(/\n/u).find(Boolean) || fields["原文链接"]?.link || "");
    return game && day ? `${type}|${game}|${day}|${type === "活动" ? lead : ""}` : "";
  };
  const quality = (row) => {
    const fields = row.fields || {};
    return (ratingSourcePriority[String(fields["评级来源"] || "历史参考")] || 0) * 1_000_000
      + ratingOrder(fields["评级"]) * 10_000
      + Number(fields["评分"] || 0) * 100
      + String(fields["内容"] || "").length;
  };
  for (const fileName of backupFiles) {
    const snapshot = JSON.parse(readFileSync(join(backupDir, fileName), "utf8"));
    for (const row of [...(snapshot.newGames || []), ...(snapshot.activities || [])]) {
      const timestamp = Number(row.fields?.["时间"] || 0);
      const key = timestamp > 0 && timestamp < monitorDayStart.getTime() ? historyKey(row) : "";
      if (!key) continue;
      const prior = archived.get(key);
      if (!prior || quality(row) >= quality(prior)) archived.set(key, row);
    }
  }
  const existingKeys = new Set(allExisting.map(historyKey).filter(Boolean));
  const recordsToRestore = [...archived.entries()]
    .filter(([key]) => !existingKeys.has(key))
    .map(([, row]) => ({
      fields: normalizeRecordFields({
        ...(row.fields || {}),
        类型: storedType(row),
        记录状态: "历史",
        提醒状态: "历史",
        评级来源: String(row.fields?.["评级来源"] || "历史参考").trim() || "历史参考",
        排序权重: ratingOrder(row.fields?.["评级"]),
      }),
    }));
  let backupPath = "";
  if (!dryRun && recordsToRestore.length) {
    backupPath = join(backupDir, `feishu-monitor-before-history-restore-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), existing: allExisting, recordsToRestore }, null, 2), "utf8");
    for (let index = 0; index < recordsToRestore.length; index += 100) {
      await api(`${base}/records/batch_create`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: recordsToRestore.slice(index, index + 100) }),
      });
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-history-restore" : "restore-history-archive",
    backupFiles: backupFiles.length,
    archivedCandidates: archived.size,
    existingRecords: allExisting.filter((row) => String(row.fields?.["游戏名"] || "").trim()).length,
    restored: dryRun ? 0 : recordsToRestore.length,
    restorePlanned: recordsToRestore.length,
    backupPath,
  }, null, 2));
  process.exit(0);
}

if (rebuildHistoryArchive) {
  // 用户已明确授权：仅重建历史归档行的物理顺序，以实现飞书视图的日期排序与空行分隔。
  // 当前/未来真实记录不触碰；历史空行及新游/活动专属技术空行会一起重建，避免重复累积。
  const historyRows = allExisting.filter((row) => String(row.fields?.["记录状态"] || "") === "历史");
  const viewDividerRows = allExisting.filter((row) =>
    !String(row.fields?.["游戏名"] || "").trim()
    && String(row.fields?.["汇总可见"] || "") === "否"
    && ["新游", "活动"].includes(String(row.fields?.["类型"] || "")),
  );
  const rowsToReplace = [...historyRows, ...viewDividerRows];
  const historyRecords = historyRows
    .filter((row) => String(row.fields?.["游戏名"] || "").trim())
    .sort(sortScheduledRows);
  const rebuiltRows = [];
  let previousDate = "";
  for (const row of historyRecords) {
    const date = displayDate(Number(row.fields?.["时间"] || 0)).slice(0, 10) || "未标注日期";
    if (previousDate && date !== previousDate) {
      // 三个视图筛选条件不同：分别写入专属空行，避免“类型=新游/活动”把空行过滤掉。
      // 历史归档只会看到第一条；新游、活动分别只会看到对应类型的第二、三条。
      // 汇总以“汇总可见=是”隐藏全部技术空行。
      rebuiltRows.push({ fields: { 记录状态: "历史", 汇总可见: "否" }, divider: true });
      // 新游/活动视图有“评分 >= 45”筛选；分隔行补一个最低可见评分，
      // 但仍通过“汇总可见=否”排除在汇总视图之外。评分只是布局占位，不是业务评级。
      rebuiltRows.push({ fields: { 类型: "新游", 评分: 45, 排序权重: 0, 记录状态: "当前", 汇总可见: "否" }, divider: true });
      rebuiltRows.push({ fields: { 类型: "活动", 评分: 45, 排序权重: 0, 记录状态: "当前", 汇总可见: "否" }, divider: true });
    }
    rebuiltRows.push({
      fields: normalizeRecordFields({
        ...(row.fields || {}),
        类型: storedType(row),
        记录状态: "历史",
        提醒状态: "历史",
        汇总可见: "是",
        排序权重: ratingOrder(row.fields?.["评级"]),
        评级来源: String(row.fields?.["评级来源"] || "历史参考").trim() || "历史参考",
      }),
      divider: false,
    });
    previousDate = date;
  }
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  let backupPath = "";
  if (!dryRun) {
    backupPath = join(backupDir, `feishu-monitor-before-history-layout-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      preservedCurrentRecords: allExisting.filter((row) => String(row.fields?.["记录状态"] || "") !== "历史"),
      rebuiltHistoryRows: rowsToReplace,
      rebuiltRows,
    }, null, 2), "utf8");
    for (let index = 0; index < rowsToReplace.length; index += 500) {
      await api(`${base}/records/batch_delete`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: rowsToReplace.slice(index, index + 500).map((row) => row.record_id) }),
      });
    }
    for (let index = 0; index < rebuiltRows.length; index += 100) {
      await api(`${base}/records/batch_create`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: rebuiltRows.slice(index, index + 100).map(({ fields }) => ({ fields })) }),
      });
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-history-layout" : "rebuild-history-archive",
    preservedCurrentRecords: allExisting.filter((row) => String(row.fields?.["记录状态"] || "") !== "历史" && String(row.fields?.["游戏名"] || "").trim()).length,
    rebuiltHistoryRecords: historyRecords.length,
    dateSeparators: rebuiltRows.filter((row) => row.divider).length,
    createdRows: rebuiltRows.length,
    deletedHistoryRows: dryRun ? 0 : rowsToReplace.length,
    backupPath,
  }, null, 2));
  process.exit(0);
}

if (rebuildMonitorLayout) {
  // 飞书开放接口无法稳定保存多字段视图排序。为保证新增不会追加到表尾，
  // 以“日期升序 → S/A/B/C → 评分降序 → 具体时间升序”重建整张事件表的物理顺序。
  // 新游、活动分别需要专属空行，才能继续保持各自的“类型=…”单条件筛选。
  const eventRows = allExisting
    .filter((row) => String(row.fields?.["游戏名"] || "").trim())
    .sort(sortScheduledRows);
  const rebuiltRows = [];
  let previousDate = "";
  for (const row of eventRows) {
    const fields = row.fields || {};
    const date = displayDate(Number(fields["时间"] || 0)).slice(0, 10) || "未标注日期";
    if (previousDate && date !== previousDate) {
      // 汇总无筛选会同时看到这两条空行；这是“新游/活动保持纯类型筛选”与
      // “汇总不设筛选”并存时的必要代价，不写入任何业务内容。
      rebuiltRows.push({ fields: { 记录状态: "历史", 汇总可见: "否" }, divider: true });
      // 新游/活动视图有“评分 >= 45”筛选；分隔行补一个最低可见评分，
      // 但仍通过“汇总可见=否”排除在汇总视图之外。评分只是布局占位，不是业务评级。
      rebuiltRows.push({ fields: { 类型: "新游", 评分: 45, 排序权重: 0, 记录状态: "当前", 汇总可见: "否" }, divider: true });
      rebuiltRows.push({ fields: { 类型: "活动", 评分: 45, 排序权重: 0, 记录状态: "当前", 汇总可见: "否" }, divider: true });
    }
    rebuiltRows.push({
      fields: normalizeRecordFields({
        ...fields,
        类型: storedType(row),
        汇总可见: "是",
        排序日期: calendarDay(Number(fields["时间"] || 0)),
        排序权重: ratingOrder(fields["评级"]),
      }),
      divider: false,
    });
    previousDate = date;
  }
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  let backupPath = "";
  if (!dryRun) {
    backupPath = join(backupDir, `feishu-monitor-before-full-layout-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: allExisting, rebuiltRows }, null, 2), "utf8");
    for (let index = 0; index < allExisting.length; index += 500) {
      await api(`${base}/records/batch_delete`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: allExisting.slice(index, index + 500).map((row) => row.record_id) }),
      });
    }
    for (let index = 0; index < rebuiltRows.length; index += 100) {
      await api(`${base}/records/batch_create`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: rebuiltRows.slice(index, index + 100).map(({ fields }) => ({ fields })) }),
      });
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-rebuild-monitor-layout" : "rebuild-monitor-layout",
    events: eventRows.length,
    dateSeparators: rebuiltRows.filter((row) => row.divider).length,
    createdRows: rebuiltRows.length,
    deletedRows: dryRun ? 0 : allExisting.length,
    backupPath,
  }, null, 2));
  process.exit(0);
}

if (repairX7) {
  const localRows = db.prepare("SELECT * FROM articles WHERE source_id='ref-x7' ORDER BY updated_at DESC").all();
  const localByUrl = new Map(localRows.map((row) => [urlKey(row.detail_url), row]));
  const repairs = [];
  for (const row of allExisting) {
    const detailUrl = row.fields?.["原文链接"]?.link || "";
    if (!detailUrl.includes("x7sy.com/game/app/")) continue;
    const local = localByUrl.get(urlKey(detailUrl));
    if (!local) continue;
    try {
      const response = await fetch(detailUrl, {
        headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(15000),
      });
      const html = await response.text();
      const detail = parseX7Detail(html, { url: detailUrl, gameName: local.game_name || row.fields?.["游戏名"] || "" });
      const facts = { ...parseFacts(local.facts), ...(detail.facts || {}) };
      const discount = extractX7Discount(html);
      if (discount) facts.x7Discount = discount;
      const nextArticle = { ...local, facts: JSON.stringify(facts), paragraphs: local.paragraphs };
      db.prepare("UPDATE articles SET facts=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(facts), local.id);
      const item = toMonitorItem(nextArticle, new Date());
      if (!item.game || !item.time) continue;
      const nextTags = displayTags(item);
      const nextPublisher = displayPublisher(item);
      if (String(row.fields?.["标签"] || "") !== nextTags || String(row.fields?.["厂商"] || "") !== nextPublisher) {
        repairs.push({ recordId: row.record_id, fields: { 时间: item.time, 标签: nextTags, 厂商: nextPublisher } });
      }
    } catch {
      // 单条详情失败不阻断其他小七记录；下一次修复继续重试。
    }
  }
  if (!dryRun) {
    for (let index = 0; index < repairs.length; index += 100) {
      await api(`${base}/records/batch_update`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: repairs.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: repair.fields })) }),
      });
    }
  }
  console.log(JSON.stringify({ mode: dryRun ? "dry-run-repair-x7" : "repair-x7", checked: allExisting.length, repaired: repairs.length, notify: false }, null, 2));
  process.exit(0);
}
const typeRepairs = sharedMonitorMode
  ? existing
    .filter((row) => String(row.fields?.["游戏名"] || "").trim())
    .map((row) => ({ recordId: row.record_id, type: storedType(row), current: String(row.fields?.["类型"] || "").trim() }))
    .filter((repair) => repair.current !== repair.type)
  : [];
if (!dryRun && typeRepairs.length) {
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `feishu-monitor-before-type-repair-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), sourceTableId, rows: existing }, null, 2), "utf8");
  for (let index = 0; index < typeRepairs.length; index += 100) {
    await api(`${base}/records/batch_update`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        records: typeRepairs.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: { 类型: repair.type } })),
      }),
    });
  }
}
if (resetMonitorTables) {
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `feishu-monitor-before-full-rebuild-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), newGames: existing, activities: activityExisting }, null, 2), "utf8");
  if (!dryRun) {
    const resetPlans = sharedMonitorMode
      ? [[sourceTableId, existing]]
      : [[sourceTableId, existing], [activityTableId, activityExisting]];
    for (const [tableId, rows] of resetPlans) {
      for (let index = 0; index < rows.length; index += 500) {
        await api(`${tableBase(tableId)}/records/batch_delete`, {
          method: "POST", headers,
          body: JSON.stringify({ records: rows.slice(index, index + 500).map((row) => row.record_id) }),
        });
      }
    }
  }
  console.log(JSON.stringify({ mode: dryRun ? "dry-run-reset-monitor-tables" : "reset-monitor-tables", sharedMonitorMode, deleted: { sourceTable: existing.length, activities: sharedMonitorMode ? 0 : activityExisting.length }, addedFields, configuredSharedViews, backupPath }, null, 2));
  process.exit(0);
}
const alertStateRepairs = rotateAlertState
  ? allExisting
    .filter((row) => String(row.fields?.["游戏名"] || "").trim())
    .filter((row) => String(row.fields?.["提醒状态"] || "").trim() !== "历史")
    .map((row) => ({ recordId: row.record_id, tableId: row._tableId, fields: { 提醒状态: "历史" } }))
  : [];
if (alertStateRepairs.length) {
  const groups = new Map();
  for (const repair of alertStateRepairs) {
    const group = groups.get(repair.tableId) || [];
    group.push(repair);
    groups.set(repair.tableId, group);
  }
  for (const [targetTableId, group] of groups) for (let index = 0; index < group.length; index += 100) {
    await api(`${tableBase(targetTableId)}/records/batch_update`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        records: group.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: repair.fields })),
      }),
    });
  }
}
let restoreBackup = null;
if (restoreBackupPath) {
  try {
    restoreBackup = JSON.parse(readFileSync(restoreBackupPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取飞书备份：${error.message}`);
  }
}

if (migrateLaunchRecords) {
  if (!activityTableId) throw new Error("未找到飞书活动表，无法迁移误分类的新游记录");
  const nonEmpty = (rows) => rows.filter((row) => Object.values(row.fields || {}).some((value) => String(value || "").trim()));
  const launchRows = nonEmpty(activityExisting).filter(isStoredNewGameRow);
  const sourceKeys = new Set(nonEmpty(existing).map((row) => normalize(cleanGameName(row.fields?.["游戏名"] || ""))).filter(Boolean));
  const sourceGameDateKeys = new Set(nonEmpty(existing).map(rowGameDateKey).filter(Boolean));
  const movedRows = [];
  const skippedDuplicateRows = [];
  for (const row of launchRows) {
    const key = normalize(cleanGameName(row.fields?.["游戏名"] || ""));
    if (key && sourceKeys.has(key)) skippedDuplicateRows.push(row);
    else {
      movedRows.push({ fields: { ...(row.fields || {}), 提醒状态: "历史" } });
      if (key) sourceKeys.add(key);
    }
  }
  const crossTypeRows = nonEmpty(activityExisting)
    .filter((row) => !launchRows.some((candidate) => candidate.record_id === row.record_id))
    .filter((row) => sourceGameDateKeys.has(rowGameDateKey(row)));
  const remainingActivityRows = nonEmpty(activityExisting)
    .filter((row) => !launchRows.some((candidate) => candidate.record_id === row.record_id))
    .filter((row) => !sourceGameDateKeys.has(rowGameDateKey(row)))
    .map((row) => ({ fields: { ...(row.fields || {}) } }));
  const newGameRows = [...nonEmpty(existing).map((row) => ({ fields: { ...(row.fields || {}) } })), ...movedRows];
  const scheduleRows = (rows) => {
    rows.sort(sortScheduledRows);
    const planned = [];
    let previousDate = "";
    for (const row of rows) {
      const date = displayDate(Number(row.fields.时间 || 0)).slice(0, 10) || "未标注日期";
      if (previousDate && date !== previousDate) planned.push({ fields: {} });
      planned.push(row);
      previousDate = date;
    }
    return planned;
  };
  const plans = [
    { tableId: sourceTableId, original: existing, rows: scheduleRows(newGameRows) },
    { tableId: activityTableId, original: activityExisting, rows: scheduleRows(remainingActivityRows) },
  ];
  if (!dryRun) {
    const backupDir = join(process.cwd(), "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `feishu-monitor-before-launch-migration-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), newGames: existing, activities: activityExisting }, null, 2), "utf8");
    for (const plan of plans) {
      for (let index = 0; index < plan.original.length; index += 500) {
        await api(`${tableBase(plan.tableId)}/records/batch_delete`, {
          method: "POST", headers,
          body: JSON.stringify({ records: plan.original.slice(index, index + 500).map((row) => row.record_id) }),
        });
      }
      for (let index = 0; index < plan.rows.length; index += 100) {
        await api(`${tableBase(plan.tableId)}/records/batch_create`, {
          method: "POST", headers,
          body: JSON.stringify({ records: plan.rows.slice(index, index + 100).map(({ fields }) => ({ fields })) }),
        });
      }
    }
    console.log(JSON.stringify({
      mode: "migrate-launch-records",
      moved: movedRows.length,
      skippedExistingNewGame: skippedDuplicateRows.length,
      removedSameDayCrossType: crossTypeRows.length,
      remainingActivities: remainingActivityRows.length,
      tables: plans.map((plan) => ({ tableId: plan.tableId, records: plan.rows.filter((row) => Object.keys(row.fields).length).length, dateSeparators: plan.rows.filter((row) => !Object.keys(row.fields).length).length })),
      backupPath,
    }, null, 2));
  }
  process.exit(0);
}

const now = new Date();
now.setHours(0, 0, 0, 0);
const rawMonitorCandidates = (listTodayArticles(new Date(), { includeMonitorOnly: true }).articles || [])
  .filter((article) => ["ref-taptap", "ref-haoyou", "ref-x7"].includes(article.source_id))
  .filter((article) => !sourceFilter || article.source_id === sourceFilter)
  .flatMap((article) => toMonitorItems(article, now))
  .filter((item) => item.time >= (item.isHaoyouHistory ? now.getTime() - 7 * 86400000 : now.getTime()) && (!onlyNewGames || item.type === "新游"));
const invalidContentFiltered = rawMonitorCandidates.filter((item) => !isCompleteRecord(item));
let candidates = rawMonitorCandidates.filter(isCompleteRecord);

// 旧缓存可能来自 craft-tag 提取修复之前，只有“休闲”等常规标签。
// 飞书写入前针对 TapTap 新游复核一次详情页，命中“创意工坊”则不写入；
// 详情核验失败保留条目，避免网络波动误删正常新游。
const verifiedCandidates = [];
for (const item of candidates) {
  if (item.type === "新游" && item.article.detail_url) {
    try {
      const response = await fetch(item.article.detail_url, {
        headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(15000),
      });
      const html = await response.text();
      if (item.article.source_id === "ref-taptap") {
        const appId = /\/app\/(\d+)/u.exec(item.article.detail_url || "")?.[1] || "";
        const tags = [...new Set([...(extractUpcomingTags(html) || []), ...(await fetchTapTapAppTags(html, appId))])].slice(0, 20);
        if (hasExcludedTapTapNewGameTag(tags)) continue;
        if (tags.length) item.facts.taptapTags = tags;
        const publisher = extractTapTapPublisher(html);
        const reviewCount = extractTapTapReviewCount(html);
        const reserveCount = extractTapTapReserveCount(html);
        const followerCount = extractTapTapFollowerCount(html);
        if (publisher) item.facts.taptapPublisher = publisher;
        if (Number.isFinite(reviewCount)) item.facts.taptapReviewCount = reviewCount;
        if (Number.isFinite(reserveCount)) item.facts.taptapReserveCount = reserveCount;
        if (Number.isFinite(followerCount)) item.facts.taptapFollowerCount = followerCount;
      } else if (item.article.source_id === "ref-haoyou") {
        const publisher = extractHaoyouPublisher(html);
        const reviewCount = extractHaoyouReviewCount(html);
        const reserveCount = extractHaoyouReserveCount(html);
        const followerCount = extractHaoyouFollowerCount(html);
        if (publisher) item.facts.haoyouPublisher = publisher;
        if (Number.isFinite(reviewCount)) item.facts.haoyouReviewCount = reviewCount;
        if (Number.isFinite(reserveCount)) item.facts.haoyouReserveCount = reserveCount;
        if (Number.isFinite(followerCount)) item.facts.haoyouFollowerCount = followerCount;
      } else if (item.article.source_id === "ref-x7") {
        const publisher = extractX7Publisher(html);
        if (publisher) item.facts.x7Publisher = publisher;
      }
      db.prepare("UPDATE articles SET facts=?, updated_at=datetime('now') WHERE detail_url=? AND source_id=?")
        .run(JSON.stringify(item.facts), item.article.detail_url, item.article.source_id);
    } catch {}
  }
  verifiedCandidates.push(item);
}
candidates = verifiedCandidates;
const lowQualityFiltered = candidates.filter(isLowQualityNewGame);
candidates = candidates.filter((item) => !isLowQualityNewGame(item));

const platformCounts = new Map();
for (const item of candidates) {
  const key = `${normalize(item.game)}|${item.type}`;
  const platforms = platformCounts.get(key) || new Set();
  platforms.add(item.article.source_id);
  platformCounts.set(key, platforms);
}
for (const item of candidates) {
  item.platformCount = platformCounts.get(`${normalize(item.game)}|${item.type}`)?.size || 1;
}

// 新游是游戏实体：同游戏只保留一条。活动则按“同游戏 + 日期接近 + 标题关键词重叠”合并，
// 保留同一游戏在不同日期或不同主题下的独立运营事件。
const merged = new Map();
for (const item of candidates) {
  const key = item.type === "新游"
    ? `${normalize(item.game)}|新游|${item.article.source_id === "ref-x7" ? item.dateKey : "实体"}`
    : eventKey(item);
  let matchedKey = key;
  for (const [candidateKey, current] of merged) {
    if (normalize(current.game) !== normalize(item.game) || current.type !== item.type) continue;
    if (item.type === "新游") {
      const sameX7Launch = item.article.source_id === "ref-x7" && current.article?.source_id === "ref-x7"
        ? item.dateKey === current.dateKey
        : true;
      if (sameX7Launch) { matchedKey = candidateKey; break; }
      continue;
    }
    if (Math.abs(current.time - item.time) > 2 * 86400000) continue;
    if (activitySameEvent(item, current)) {
      matchedKey = candidateKey;
      break;
    }
  }
  const current = merged.get(matchedKey);
  if (!current || preferMonitorItem(item, current)) merged.set(matchedKey, item);
}

const existingNewGameKeys = new Set();
const existingActivityKeys = new Set();
for (const row of existing) {
  const fields = row.fields || {};
  const game = cleanGameName(fields["游戏名"] || "");
  if (game && storedType(row) === "新游") existingNewGameKeys.add(`${normalize(game)}|新游`);
}
for (const row of activityExisting) {
  const fields = row.fields || {};
  const game = cleanGameName(fields["游戏名"] || "");
  const dateKey = eventDateKey(fields["时间"]);
  const title = cleanTitle(String(fields["内容"] || "").split(/\n/u)[0].replace(/^活动标题\s*[:：]\s*/u, ""), game);
  if (game && dateKey && title) existingActivityKeys.add(activityStableKey({
    game,
    type: "活动",
    dateKey,
    title,
    content: fields["内容"] || "",
    fields,
  }));
}

// 本轮首次出现的游戏也先写入游戏评级表，再创建事件记录；这样活动/新游始终使用同一套游戏评级。
const admittedMerged = new Map([...merged.entries()].filter(([, item]) => isFeishuAdmissionAllowed(item)));
const admissionFilteredCount = merged.size - admittedMerged.size;
const newRatingRecords = [];
for (const item of admittedMerged.values()) {
  const key = normalize(item.game);
  if (!key || gameRatingOverrides.has(key)) continue;
  const rating = ratingFor(item);
  const record = {
    fields: {
      游戏名: item.game,
      平台: item.article.source_id === "ref-taptap" ? "TapTap" : item.article.source_id === "ref-haoyou" ? "好游快爆" : "小七",
      游戏标签: displayTags(item),
      "评论/预约量": engagementCountFor(item) ?? undefined,
      评级: normalizeRatingLabel(rating.label),
      厂商: displayPublisher(item),
    },
  };
  newRatingRecords.push(record);
  gameRatingOverrides.set(key, {
    game: item.game,
    label: normalizeRatingLabel(rating.label),
    value: ratingValueForLabel(rating.label),
    platform: record.fields.平台,
    tags: record.fields.游戏标签,
    publisher: record.fields.厂商,
  });
}

if (!dryRun && ratingTableId && newRatingRecords.length) {
  for (let index = 0; index < newRatingRecords.length; index += 100) {
    await api(`${tableBase(ratingTableId)}/records/batch_create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records: newRatingRecords.slice(index, index + 100) }),
    });
  }
}

const records = [...admittedMerged.values()]
  .sort((left, right) => {
    const leftFields = { fields: fieldsFor(left) };
    const rightFields = { fields: fieldsFor(right) };
    return sortScheduledRows(leftFields, rightFields);
  })
  .filter((item) => item.type !== "活动" || ![...admittedMerged.values()].some((candidate) =>
    candidate.type === "新游" && normalize(candidate.game) === normalize(item.game) && candidate.dateKey === item.dateKey,
  ))
  .filter((item) => item.type === "新游"
    ? !existingNewGameKeys.has(`${normalize(item.game)}|新游`)
    : !activityExisting.some((row) => activitySameEvent(item, row)))
  .map((item) => ({
    targetTableId: item.type === "活动" && activityTableId ? activityTableId : sourceTableId,
    fields: fieldsFor(item, { alertStatus: "新增" }),
    preview: { 游戏名: item.game, 类型: item.type, 时间: displayDate(item.time), 标题: item.title, 内容: item.content, 评级: fieldsFor(item).评级, 评分: fieldsFor(item).评分, 平台: item.article.source_id === "ref-taptap" ? "TapTap" : item.article.source_id === "ref-haoyou" ? "好游快爆" : "小七", 原文链接: item.article.detail_url, ...notificationMedia(item) },
  }));

if (rebuildSchedule) {
  // 历史数据不再删表重建：仅按事件日期切换“当前/历史”状态。
  // 飞书视图负责排序和筛选，避免重写记录导致原始入库时间、人工评级和历史行丢失。
  const scheduleRows = restoreBackup
    ? [
      ...(restoreBackup.newGames || []).map((row) => ({ ...row, _tableId: sourceTableId })),
      ...(activityTableId ? (restoreBackup.activities || []).map((row) => ({ ...row, _tableId: activityTableId })) : []),
    ]
    : allExisting;
  const updates = [];
  let currentRows = 0;
  let historicalRows = 0;
  for (const row of scheduleRows) {
    const fields = row.fields || {};
    if (!String(fields["游戏名"] || "").trim()) continue;
    const recordTime = Number(fields["时间"] || 0);
    const nextStatus = markAllHistory || (recordTime > 0 && recordTime < monitorDayStart.getTime()) ? "历史" : "当前";
    if (nextStatus === "历史") historicalRows += 1;
    else currentRows += 1;
    const fieldsPatch = {
      ...(String(fields["记录状态"] || "") !== nextStatus ? { 记录状态: nextStatus } : {}),
      ...(nextStatus === "历史" && String(fields["提醒状态"] || "") !== "历史" ? { 提醒状态: "历史" } : {}),
      ...(nextStatus === "当前" && String(fields["排序权重"] || "") !== String(ratingOrder(fields["评级"])) ? { 排序权重: ratingOrder(fields["评级"]) } : {}),
      ...(recordTime > 0 && Number(fields["排序日期"] || 0) !== calendarDay(recordTime) ? { 排序日期: calendarDay(recordTime) } : {}),
      ...(String(fields["评级来源"] || "") === "自动" && String(fields["评级"] || "") !== ratingLabelForScore(fields["评分"]) ? { 评级来源: "人工" } : {}),
      // 迁移前的存量评级没有来源字段，标为“历史参考”，供同游戏后续事件继承；不改评级本身。
      ...(String(fields["评级来源"] || "").trim() ? {} : { 评级来源: "历史参考" }),
    };
    if (Object.keys(fieldsPatch).length) updates.push({ record_id: row.record_id, fields: fieldsPatch, _tableId: row._tableId || sourceTableId });
  }
  let backupPath = "";
  if (!dryRun && updates.length) {
    const backupDir = join(process.cwd(), "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `feishu-monitor-before-history-status-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: allExisting, updates }, null, 2), "utf8");
    const groups = new Map();
    for (const update of updates) {
      const group = groups.get(update._tableId) || [];
      group.push(update);
      groups.set(update._tableId, group);
    }
    for (const [targetTableId, group] of groups) {
      for (let index = 0; index < group.length; index += 100) {
        await api(`${tableBase(targetTableId)}/records/batch_update`, {
          method: "POST",
          headers,
          body: JSON.stringify({ records: group.slice(index, index + 100).map(({ record_id, fields }) => ({ record_id, fields })) }),
        });
      }
    }
  }
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run-history-status" : "rebuild-schedule",
    currentRows,
    historicalRows,
    statusUpdates: updates.length,
    backupPath,
    configuredSharedViews,
    addedFields,
  }, null, 2));
  process.exit(0);
}

if (!dryRun && !repairExisting && !formatExistingContent && !scoreExisting && !repairMetadata && !repairTags && !repairGameNames && !repairLeadingUpdate && records.length) {
  const groups = new Map();
  for (const record of records) {
    const group = groups.get(record.targetTableId) || [];
    group.push(record);
    groups.set(record.targetTableId, group);
  }
  for (const [targetTableId, group] of groups) {
    for (let index = 0; index < group.length; index += 100) {
      await api(`${tableBase(targetTableId)}/records/batch_create`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: group.slice(index, index + 100).map(({ fields }) => ({ fields })) }),
      });
    }
  }
}

const formatRepairs = [];
if (formatExistingContent) {
  for (const row of allExisting) {
    const current = String(row.fields?.["内容"] || "");
    const formatted = formatRecordLineBreaks(current);
    if (!current || current === formatted) continue;
    formatRepairs.push({ recordId: row.record_id, tableId: row._tableId, fields: { 内容: formatted } });
  }
  if (!dryRun) {
    const backupDir = join(process.cwd(), "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `feishu-monitor-before-content-format-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: allExisting }, null, 2), "utf8");
    const groups = new Map();
    for (const repair of formatRepairs) {
      const group = groups.get(repair.tableId) || [];
      group.push(repair);
      groups.set(repair.tableId, group);
    }
    for (const [targetTableId, group] of groups) {
      for (let index = 0; index < group.length; index += 100) {
        await api(`${tableBase(targetTableId)}/records/batch_update`, {
          method: "POST",
          headers,
          body: JSON.stringify({ records: group.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: repair.fields })) }),
        });
      }
    }
    console.log(JSON.stringify({ mode: "content-format-backup", backupPath, updated: formatRepairs.length }, null, 2));
  }
}

const leadingUpdateRepairs = [];
if (repairLeadingUpdate) {
  for (const row of allExisting) {
    const fields = row.fields || {};
    if (String(fields["类型"] || "").trim() !== "活动") continue;
    const current = String(fields["内容"] || "");
    const repaired = current
      .replace(/^\s*(?:(?:20\d{2}年)?\d{1,2}月\d{1,2}日)\s*更新\s*[:：]\s*/u, "")
      .replace(/，[ \t]*(?!\n)/gu, "，\n")
      .replace(/\r\n?/gu, "\n")
      .replace(/([；;])[ \t]*(?!\n)/gu, "$1\n")
      .replace(/([！!])[ \t]*(?!\n)/gu, "$1\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    if (current !== repaired) leadingUpdateRepairs.push({ recordId: row.record_id, tableId: row._tableId, fields: { 内容: repaired }, preview: { 游戏名: fields["游戏名"], 平台: fields["平台"], 内容: repaired } });
  }
  if (!dryRun && leadingUpdateRepairs.length) {
    const backupDir = join(process.cwd(), "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `feishu-monitor-before-leading-update-repair-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: allExisting }, null, 2), "utf8");
    for (const repair of leadingUpdateRepairs) {
      await api(`${tableBase(repair.tableId)}/records/${encodeURIComponent(repair.recordId)}`, {
        method: "PUT", headers, body: JSON.stringify({ fields: repair.fields }),
      });
    }
    console.log(JSON.stringify({ mode: "leading-update-backup", backupPath, updated: leadingUpdateRepairs.length }, null, 2));
  }
}

const repairCandidates = new Map();
if (repairExisting || scoreExisting || repairMetadata || repairTags || repairGameNames) {
  // 历史修复不能复用列表接口：该接口按分数截断，低分但已写入飞书的旧记录会遗漏。
  // 这里仅遍历两个已授权手游来源的本地归档，并继续由 needsContentRepair 严格控制写入范围。
  const historicalRows = db.prepare(`
    SELECT * FROM articles
    WHERE source_id IN ('ref-taptap', 'ref-haoyou')
    ORDER BY updated_at DESC
  `).all();
  for (const row of historicalRows) {
    const article = { ...row, paragraphs: parseParagraphs(row.paragraphs) };
    const item = toMonitorItem(article, now);
    if (scoreExisting && article.source_id === "ref-taptap" && article.detail_url && !item.facts.taptapFollowerCount) {
      try {
        const response = await fetch(article.detail_url, {
          headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/xhtml+xml" },
          signal: AbortSignal.timeout(15000),
        });
        const html = await response.text();
        const followerCount = extractTapTapFollowerCount(html);
        if (Number.isFinite(followerCount)) {
          item.facts.taptapFollowerCount = followerCount;
          db.prepare("UPDATE articles SET facts=?, updated_at=datetime('now') WHERE id=?")
            .run(JSON.stringify(item.facts), article.id);
        }
      } catch {}
    }
    if (isCompleteRecord(item)) repairCandidates.set(urlKey(article.detail_url), item);
  }
}
const repairs = [];
if (repairExisting) {
  for (const row of allExisting) {
    const fields = row.fields || {};
    const item = repairCandidates.get(urlKey(fields["原文链接"]?.link || ""));
    if (!item) continue;
    const nextFields = fieldsFor(item);
    const oldContent = String(fields["内容"] || "").trim();
    if (!needsContentRepair(fields, item)) continue;
    if (oldContent === nextFields.内容 && Number(fields["时间"] || 0) === Number(nextFields.时间)) continue;
    repairs.push({ recordId: row.record_id, tableId: row._tableId, fields: nextFields, preview: { 游戏名: item.game, 类型: item.type, 时间: displayDate(item.time), 内容: nextFields.内容 } });
  }
  if (!dryRun) {
    for (const repair of repairs) {
      await api(`${tableBase(repair.tableId)}/records/${encodeURIComponent(repair.recordId)}`, {
        method: "PUT", headers, body: JSON.stringify({ fields: repair.fields }),
      });
    }
  }
}

const tagRepairs = [];
if (repairTags) {
  for (const row of allExisting) {
    const fields = row.fields || {};
    const detailUrl = fields["原文链接"]?.link || "";
    if (!/taptap\.cn/iu.test(detailUrl)) continue;
    const item = repairCandidates.get(urlKey(detailUrl));
    if (!item?.article?.detail_url) continue;
    try {
      const response = await fetch(item.article.detail_url, {
        headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(15000),
      });
      const html = await response.text();
      const appId = /\/app\/(\d+)/u.exec(item.article.detail_url)?.[1] || "";
      const tags = [...new Set([...(extractUpcomingTags(html) || []), ...(await fetchTapTapAppTags(html, appId))])].slice(0, 20);
      if (tags.length) item.facts.taptapTags = tags;
      db.prepare("UPDATE articles SET facts=?, updated_at=datetime('now') WHERE detail_url=? AND source_id='ref-taptap'")
        .run(JSON.stringify(item.facts), item.article.detail_url);
      const nextTags = displayTags(item);
      if (String(fields["标签"] || "").trim() !== nextTags) {
        tagRepairs.push({ recordId: row.record_id, tableId: row._tableId, fields: { 标签: nextTags } });
      }
    } catch {
      // 单条详情或标签接口失败不阻断其余记录。
    }
  }
  if (!dryRun) {
    const groups = new Map();
    for (const repair of tagRepairs) {
      const group = groups.get(repair.tableId) || [];
      group.push(repair);
      groups.set(repair.tableId, group);
    }
    for (const [targetTableId, group] of groups) for (let index = 0; index < group.length; index += 100) {
      await api(`${tableBase(targetTableId)}/records/batch_update`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: group.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: repair.fields })) }),
      });
    }
  }
}

const gameNameRepairs = [];
if (repairGameNames) {
  for (const row of allExisting) {
    const fields = row.fields || {};
    const item = repairCandidates.get(urlKey(fields["原文链接"]?.link || ""));
    if (!item?.game) continue;
    if (String(fields["游戏名"] || "").trim() !== item.game) {
      gameNameRepairs.push({ recordId: row.record_id, tableId: row._tableId, fields: { 游戏名: item.game } });
    }
  }
  if (!dryRun) {
    const groups = new Map();
    for (const repair of gameNameRepairs) {
      const group = groups.get(repair.tableId) || [];
      group.push(repair);
      groups.set(repair.tableId, group);
    }
    for (const [targetTableId, group] of groups) for (let index = 0; index < group.length; index += 100) {
      await api(`${tableBase(targetTableId)}/records/batch_update`, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: group.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: repair.fields })) }),
      });
    }
  }
}

const ratingRepairs = [];
if (scoreExisting) {
  for (const row of allExisting) {
    const fields = row.fields || {};
    const item = repairCandidates.get(urlKey(fields["原文链接"]?.link || ""));
    if (!item || !isCompleteRecord(item)) continue;
    const rating = ratingFor(item);
    if (String(fields["评级"] || "").trim() === rating.label && Number(fields["评分"] || 0) === rating.value) continue;
    ratingRepairs.push({ recordId: row.record_id, tableId: row._tableId, fields: { 评级: rating.label, 评分: rating.value } });
  }
  if (!dryRun) {
    const groups = new Map();
    for (const repair of ratingRepairs) {
      const group = groups.get(repair.tableId) || [];
      group.push(repair);
      groups.set(repair.tableId, group);
    }
    for (const [targetTableId, group] of groups) for (let index = 0; index < group.length; index += 100) {
      await api(`${tableBase(targetTableId)}/records/batch_update`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          records: group.slice(index, index + 100).map((repair) => ({
            record_id: repair.recordId,
            fields: repair.fields,
          })),
        }),
      });
    }
  }
}

const metadataRepairs = [];
if (repairMetadata) {
  // 历史记录里部分详情是在厂商解析上线前写入的。只为飞书“厂商为空”的关联条目补抓，
  // 不重跑全量爬虫，也不触碰正文、时间、链接等既有业务字段。
  const missingPublisherItems = new Map();
  for (const row of allExisting) {
    const fields = row.fields || {};
    if (hasUsablePublisher(fields["厂商"])) continue;
    const key = urlKey(fields["原文链接"]?.link || "");
    const item = repairCandidates.get(key);
    if (item?.article?.detail_url) missingPublisherItems.set(key, item);
  }
  for (const item of missingPublisherItems.values()) {
    try {
      const response = await fetch(item.article.detail_url, {
        headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(15000),
      });
      const html = await response.text();
      const publisher = item.article.source_id === "ref-taptap"
        ? extractTapTapPublisher(html)
        : extractHaoyouPublisher(html);
      if (!publisher) continue;
      if (item.article.source_id === "ref-taptap") item.facts.taptapPublisher = publisher;
      else item.facts.haoyouPublisher = publisher;
      db.prepare("UPDATE articles SET facts=?, updated_at=datetime('now') WHERE detail_url=? AND source_id=?")
        .run(JSON.stringify(item.facts), item.article.detail_url, item.article.source_id);
    } catch {
      // 单条厂商补抓失败不阻断其余飞书记录；下次元数据修复会继续尝试。
    }
  }
  for (const row of allExisting) {
    const fields = row.fields || {};
    const item = repairCandidates.get(urlKey(fields["原文链接"]?.link || ""));
    if (!item || !isCompleteRecord(item)) continue;
    const next = {};
    const publisher = displayPublisher(item);
    const rating = ratingFor(item);
    if (publisher && String(fields["厂商"] || "").trim() !== publisher) next.厂商 = publisher;
    else if (!publisher && !hasUsablePublisher(fields["厂商"]) && String(fields["厂商"] || "").trim()) next.厂商 = "";
    if (String(fields["评级"] || "").trim() !== rating.label) next.评级 = rating.label;
    if (Number(fields["评分"] || 0) !== rating.value) next.评分 = rating.value;
    if (Object.keys(next).length) metadataRepairs.push({ recordId: row.record_id, tableId: row._tableId, fields: next });
  }
  if (!dryRun) {
    const groups = new Map();
    for (const repair of metadataRepairs) {
      const group = groups.get(repair.tableId) || [];
      group.push(repair);
      groups.set(repair.tableId, group);
    }
    for (const [targetTableId, group] of groups) for (let index = 0; index < group.length; index += 100) {
      await api(`${tableBase(targetTableId)}/records/batch_update`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          records: group.slice(index, index + 100).map((repair) => ({ record_id: repair.recordId, fields: repair.fields })),
        }),
      });
    }
  }
}

console.log(JSON.stringify({
  mode: dryRun ? "dry-run" : repairLeadingUpdate ? "repair-leading-update" : repairGameNames ? "repair-game-names" : repairTags ? "repair-tags" : repairMetadata ? "repair-metadata" : repairExisting ? "repair" : formatExistingContent ? "format-content" : scoreExisting ? "score-existing" : "write",
  sourceCandidates: candidates.length,
  invalidContentFiltered: invalidContentFiltered.length,
  lowQualityFiltered: lowQualityFiltered.length,
  dedupedPreview: merged.size,
  inserted: dryRun || repairExisting || formatExistingContent || scoreExisting ? 0 : records.length,
  skippedExisting: merged.size - records.length,
  repaired: dryRun || !repairExisting ? 0 : repairs.length,
  repairPlanned: repairs.length,
  contentFormatted: dryRun || !formatExistingContent ? 0 : formatRepairs.length,
  contentFormatPlanned: formatRepairs.length,
  leadingUpdateRepaired: dryRun || !repairLeadingUpdate ? 0 : leadingUpdateRepairs.length,
  leadingUpdateRepairPlanned: leadingUpdateRepairs.length,
  rated: dryRun || !scoreExisting ? 0 : ratingRepairs.length,
  ratingPlanned: ratingRepairs.length,
  metadataRepaired: dryRun || !repairMetadata ? 0 : metadataRepairs.length,
  metadataRepairPlanned: metadataRepairs.length,
  tagsRepaired: dryRun || !repairTags ? 0 : tagRepairs.length,
  tagsRepairPlanned: tagRepairs.length,
  gameNamesRepaired: dryRun || !repairGameNames ? 0 : gameNameRepairs.length,
  gameNamesRepairPlanned: gameNameRepairs.length,
  rule: "新游按同游戏全局去重；活动按同游戏+日期相差不超过2天+标题关键词重叠合并；同游戏不同活动保留；TapTap活动详情优先；字段不完整、泛标题或无明确事件时间不写入",
  timeDefinition: "新游=上架/首发/测试开始时间；活动=活动开始或版本上线时间；抓取/发现时间不写入时间字段",
  sample: records.slice(0, 20).map((record) => record.preview),
  // 供服务端机器人提醒使用；只在本轮实际插入时消费，不参与页面或 RAW 展示。
  insertedItems: records.slice(0, 20).map((record) => record.preview),
  repairSample: repairs.slice(0, 20).map((repair) => repair.preview),
}, null, 2));
