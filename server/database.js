import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  contentFilter as taptapFilter,
  hotTopicFilter as taptapHotTopicFilter,
  isDetailUrl as isTapTapDetailUrl,
} from "./crawler/platforms/taptap.js";
import {
  cleanTimelineSummary as cleanHaoyouTimelineSummary,
  cleanUpdateTitle as cleanHaoyouUpdateTitle,
  extractGameName as extractHaoyouGameName,
  filterGameplayTags as filterHaoyouGameplayTags,
} from "./crawler/platforms/haoyou.js";
import { getMobilePrioritySignals } from "./crawler/scorer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "game-news-hub.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    urls TEXT NOT NULL, access_policy TEXT DEFAULT 'list_public',
    detail_policy TEXT DEFAULT 'public_detail', is_builtin INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
    source_name TEXT NOT NULL, title TEXT NOT NULL, game_name TEXT,
    category TEXT NOT NULL DEFAULT '新游上线', detail_url TEXT NOT NULL,
    image_url TEXT, date_text TEXT, score INTEGER DEFAULT 50,
    paragraphs TEXT, facts TEXT, images_json TEXT,
    quality TEXT DEFAULT 'pending', game_match TEXT, diagnostic TEXT,
    review_status TEXT DEFAULT 'pending', selected_paragraph_ids TEXT,
    selected_image_ids TEXT, cover_image_id TEXT,
    selected_for_brief INTEGER DEFAULT 0, reviewed_at TEXT,
    discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(discovered_at);
  CREATE INDEX IF NOT EXISTS idx_articles_score ON articles(score DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
  CREATE INDEX IF NOT EXISTS idx_articles_quality ON articles(quality);
  CREATE INDEX IF NOT EXISTS idx_articles_review ON articles(review_status);

  CREATE TABLE IF NOT EXISTS briefs (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    style TEXT DEFAULT 'professional', max_length INTEGER DEFAULT 1200,
    lead TEXT, template_id TEXT, total_characters INTEGER DEFAULT 0,
    reading_minutes INTEGER DEFAULT 3, sections_json TEXT,
    source_notes TEXT, slot TEXT DEFAULT 'daily',
    status TEXT DEFAULT 'draft',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_briefs_date ON briefs(created_at);
`);

// 兼容旧 DB
try {
  db.exec("ALTER TABLE briefs ADD COLUMN slot TEXT DEFAULT 'daily'");
} catch {}
try {
  db.exec("ALTER TABLE articles ADD COLUMN ai_summary TEXT DEFAULT ''");
} catch {}

const now = () => new Date().toISOString();

export { db };

export function seedBuiltinSources() {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sources (id, name, category, urls, access_policy, detail_policy, is_builtin, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'))
  `);
  const platforms = [
    [
      "ref-haoyou",
      "好游快爆",
      "手游",
      JSON.stringify(["https://m.3839.com/wap.html"]),
      "list_mobile",
      "detail_may_403",
    ],
    [
      "ref-taptap",
      "TapTap",
      "手游",
      JSON.stringify(["https://www.taptap.cn/forum/hot/hashtags"]),
      "list_dynamic",
      "public_detail",
    ],
    [
      "ref-x7",
      "小七",
      "手游",
      JSON.stringify(["https://www.x7sy.com/reserve"]),
      "list_public",
      "public_detail",
    ],
    [
      "ref-gamersky",
      "游民星空",
      "端游",
      JSON.stringify(["https://www.gamersky.com/news/"]),
      "list_public",
      "public_detail",
    ],
    [
      "ref-gcores",
      "机核",
      "资讯",
      JSON.stringify(["https://www.gcores.com/news"]),
      "list_public",
      "public_detail",
    ],
    [
      "ref-steam",
      "Steam",
      "端游",
      JSON.stringify(["https://store.steampowered.com/api/featuredcategories"]),
      "api",
      "public_detail",
    ],
  ];
  for (const p of platforms) stmt.run(...p);
  // 九游、游侠网已从固定采集范围移除：清理历史来源配置和文章，防止 API、统计与 RAW 规则出现双重口径。
  db.prepare("DELETE FROM articles WHERE source_id IN ('ref-jiuyou','ref-ali213')").run();
  db.prepare("DELETE FROM sources WHERE id IN ('ref-jiuyou','ref-ali213')").run();
  db.prepare(
    "UPDATE sources SET urls = ?, access_policy = ?, detail_policy = ?, updated_at = datetime('now') WHERE id = ? AND is_builtin = 1",
  ).run(
    JSON.stringify(["https://www.taptap.cn/forum/hot/hashtags", "https://www.taptap.cn/upcoming", "https://www.taptap.cn/top/download/new", "https://www.taptap.cn/top/in-app-event-reserve"]),
    "list_dynamic",
    "public_detail",
    "ref-taptap",
  );
  db.prepare(
    "UPDATE sources SET urls = ?, access_policy = ?, detail_policy = ?, updated_at = datetime('now') WHERE id = ? AND is_builtin = 1",
  ).run(
    JSON.stringify(["https://www.3839.com/timeline.html"]),
    "list_public",
    "detail_may_403",
    "ref-haoyou",
  );
}

export function listSources() {
  return db.prepare("SELECT * FROM sources WHERE enabled = 1").all();
}

export function addSource(source) {
  const id = source.id || `custom-${Date.now()}`;
  db.prepare(
    `
    INSERT OR REPLACE INTO sources (id, name, category, urls, access_policy, is_builtin, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'list_public', 0, 1, datetime('now'), datetime('now'))
  `,
  ).run(
    id,
    source.name,
    source.category || "资讯",
    JSON.stringify(source.urls || []),
  );
  return db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
}

export function deleteSource(id) {
  const src = db.prepare("SELECT is_builtin FROM sources WHERE id = ?").get(id);
  if (src && src.is_builtin) throw new Error("不能删除内置来源");
  db.prepare("DELETE FROM sources WHERE id = ?").run(id);
}

export function listArticles({
  source,
  category,
  q,
  page = 1,
  limit = 50,
  date_from,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const clauses = [];
  const params = [];
  if (source) {
    clauses.push("source_id = ?");
    params.push(source);
  }
  if (category && category !== "all") {
    clauses.push("category = ?");
    params.push(category);
  }
  if (q) {
    clauses.push("(title LIKE ? OR game_name LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (date_from) {
    clauses.push("discovered_at >= ?");
    params.push(date_from);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const allRows = db
    .prepare(
      `SELECT * FROM articles ${where} ORDER BY score DESC, discovered_at DESC`,
    )
    .all(...params);
  const visibleRows = capSteamRows(allRows.filter(isVisibleArticle));
  const rows = visibleRows.slice(
    (safePage - 1) * safeLimit,
    safePage * safeLimit,
  );
  return {
    page: safePage,
    limit: safeLimit,
    total: visibleRows.length,
    articles: rows.map(parseArticle),
    sourceStats: getSourceStats(),
  };
}

export function getArticlesByIds(ids) {
  if (!ids || !ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM articles WHERE id IN (${ph})`)
    .all(...ids)
    .filter(isVisibleArticle);
  return rows.map(parseArticle);
}

export function listTodayArticles(now = new Date(), { includeMonitorOnly = false } = {}) {
  // “今日”统一以调用当刻的上海自然日为准，不再使用最近 48 小时滚动窗口。
  const { start, now: current } = shanghaiDayWindow(now);
  const rows = capSteamRows(
    db
      .prepare(
        "SELECT * FROM articles WHERE datetime(discovered_at) >= datetime(?) AND datetime(discovered_at) <= datetime(?) ORDER BY score DESC",
      )
      .all(start.toISOString(), current.toISOString())
      .filter((row) => isVisibleArticle(row) || (includeMonitorOnly && row.source_id === "ref-x7")),
  );
  return { articles: rows.map(parseArticle), sourceStats: getSourceStats() };
}

/**
 * Dashboard 只读资讯补充层。
 *
 * RAW_ARTICLES.html 用于人工验收候选、过滤和详情；Dashboard 只消费已经
 * 通过可见性规则的数据，并按产品栏目提供有限数量的高密度条目。
 * 不新增数据表，也不写入 articles。
 */
export function getDashboardSupplements() {
  const rows = capSteamRows(
    db
      .prepare(
        "SELECT * FROM articles ORDER BY updated_at DESC, discovered_at DESC",
      )
      .all()
      .filter(isVisibleArticle),
  );
  const nowDate = shanghaiCalendarDate();
  const sourceRows = new Map();
  for (const row of rows) {
    const list = sourceRows.get(row.source_id) || [];
    list.push({ row, facts: safeJson(row.facts, {}) });
    sourceRows.set(row.source_id, list);
  }

  const steamRows = sourceRows.get("ref-steam") || [];
  const tapRows = sourceRows.get("ref-taptap") || [];
  const haoyouRows = sourceRows.get("ref-haoyou") || [];
  const newsRows = [
    ...(sourceRows.get("ref-gcores") || []),
    ...(sourceRows.get("ref-gamersky") || []),
  ];

  const toItem = (entry, overrides = {}) =>
    dashboardItem(entry.row, entry.facts, {
      dateTimestamp: overrides.dateTimestamp ?? articleTimestamp(entry, nowDate),
      ...overrides,
    });
  const sortByRank = (a, b) =>
    Number(a.facts.steamRankCurrent || Number.MAX_SAFE_INTEGER) -
    Number(b.facts.steamRankCurrent || Number.MAX_SAFE_INTEGER);
  const sortByDate = (a, b) =>
    articleTimestamp(a, nowDate) - articleTimestamp(b, nowDate) ||
    Number(b.row.score || 0) - Number(a.row.score || 0);
  const isHotTopic = ({ row }) =>
    /\/forum\/hot\/hashtags\?item=\d+/.test(row.detail_url || "");
  const hotTopicRank = ({ row }) =>
    Number(
      /item=(\d+)/.exec(row.detail_url || "")?.[1] || Number.MAX_SAFE_INTEGER,
    );
  const isEventRow = ({ facts }) =>
    Array.isArray(facts.taptapEvents) && facts.taptapEvents.length > 0;
  const isUpcomingRow = ({ facts }) =>
    !isEventRow({ facts }) &&
    Number.isFinite(Number(facts.taptapUpcomingStartTime));
  // 编辑资讯必须先经过详情阶段：候选列表只提供标题、链接和缩略图，
  // 没有正文/图文布局时不能混入“今日简讯”，否则会出现“暂无摘要”的伪内容。
  const hasEditorialDetail = ({ row, facts }) => {
    const paragraphs = safeJson(row.paragraphs, []).filter(Boolean);
    const layout = Array.isArray(facts.gcoresLayout)
      ? facts.gcoresLayout
      : Array.isArray(facts.gamerskyLayout)
        ? facts.gamerskyLayout
        : [];
    return paragraphs.length > 0 && layout.length > 0;
  };
  const normalizedGameKey = (value = "") =>
    String(value)
      .replace(/[《》]/g, "")
      .replace(/[（(][^)）]*[）)]/g, "")
      .replace(/[\s\-_:：]/g, "")
      // 平台常把“预下载/体验服/版本预约”等阶段写进游戏名；它们不是作品实体的一部分。
      // 仅用于跨平台去重，展示层仍使用来源提供的正式名称。
      .replace(/(?:\d+(?:\.\d+){0,3})?版本(?:预约|预下载|预载)?$/g, "")
      .replace(/(预下载|预载|预约中|体验服|测试服|先遣服|官服|国际服|渠道服)$/g, "")
      .toLowerCase();
  const calendarKey = (value = "") => {
    const match = /(?:20\d{2}[年\/-])?\s*(\d{1,2})月(\d{1,2})日/.exec(String(value));
    return match ? `${Number(match[1])}-${Number(match[2])}` : "";
  };
  const eventTerms = (item = {}) =>
    `${item.title || ""} ${item.summary || ""}`
      .match(/[\u4e00-\u9fff]{2,10}/g)
      ?.map((term) => term.replace(/版本|更新|活动|开启|上线|游戏|限时|全新/g, ""))
      .filter((term) => term.length >= 2) || [];
  const eventVersions = (item = {}) =>
    `${item.title || ""} ${item.summary || ""}`
      .match(/(?:v(?:ersion)?\s*)?\d+(?:\.\d+){1,3}/giu)
      ?.map((value) => value.replace(/^v(?:ersion)?\s*/iu, "")) || [];
  const hasSameEventFocus = (left, right) => {
    const leftTerms = eventTerms(left);
    const rightTerms = eventTerms(right);
    const leftVersions = eventVersions(left);
    const rightVersions = eventVersions(right);
    return leftVersions.some((version) => rightVersions.includes(version)) ||
      leftTerms.some((term) => rightTerms.some((other) => term.includes(other) || other.includes(term)));
  };
  // 不依赖 AI 的标题语义近似：去掉游戏名和“版本/活动/更新”等通用词后，
  // 用中文双字片段比对。它只作为“同游戏 + 日期接近”的第三道确认，
  // 避免把同一游戏不同期活动误并。
  const eventSemanticText = (item = {}) => {
    const gameKey = normalizedGameKey(item.gameName || "");
    const escapedGameKey = gameKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    let text = String(item.title || "").toLowerCase();
    if (escapedGameKey) text = text.replace(new RegExp(escapedGameKey, "giu"), "");
    return text
      .replace(/[《》【】\[\]（）()\s\-_:：,，。！!？?·•]/gu, "")
      .replace(/(?:版本|更新|活动|联动|开启|上线|游戏|限时|全新|今日|正式)/gu, "");
  };
  const eventBigrams = (value = "") => {
    const text = eventSemanticText({ title: value });
    const result = new Set();
    for (let index = 0; index < text.length - 1; index += 1) {
      const pair = text.slice(index, index + 2);
      if (/^[\u4e00-\u9fff0-9a-z]{2}$/iu.test(pair)) result.add(pair);
    }
    return result;
  };
  const eventTitleSimilarity = (left, right) => {
    const a = eventSemanticText(left);
    const b = eventSemanticText(right);
    if (!a || !b) return 0;
    if (a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)))) return 1;
    const aPairs = eventBigrams(a);
    const bPairs = eventBigrams(b);
    if (!aPairs.size || !bPairs.size) return 0;
    let overlap = 0;
    for (const pair of aPairs) if (bPairs.has(pair)) overlap += 1;
    return overlap / new Set([...aPairs, ...bPairs]).size;
  };
  const isSameCrossPlatformEvent = (left, right) => {
    if (!left.sourceId || left.sourceId === right.sourceId) return false;
    if (left.dateTimestamp == null || right.dateTimestamp == null) return false;
    if (Math.abs(left.dateTimestamp - right.dateTimestamp) > 2 * 86400000) return false;
    return hasSameEventFocus(left, right) || eventTitleSimilarity(left, right) >= 0.35;
  };
  const isSameGameEntity = (leftName = "", rightName = "") => {
    const left = normalizedGameKey(leftName);
    const right = normalizedGameKey(rightName);
    if (!left || !right) return false;
    return left === right ||
      (Math.min(left.length, right.length) >= 2 && (left.includes(right) || right.includes(left)));
  };

  // 同一游戏、同一栏目只保留内容更完整且来源更可靠的一条。
  // 注意：这不是全局按游戏去重；新游、版本更新、联动、热榜话题是不同事件，必须并存。
  const mobileSourcePriority = (entry) => {
    const facts = entry.facts || {};
    if (entry.row.source_id === "ref-taptap") {
      if (Array.isArray(facts.taptapEvents) && facts.taptapEvents.length) return 100;
      if (facts.taptapSource === "new_downloads_today") return 95;
      return 90;
    }
    if (entry.row.source_id === "ref-haoyou") return facts.haoyouKind === "update" ? 70 : 60;
    return 0;
  };
  const selectPreferredMobileEntries = (entries) => {
    const winners = new Map();
    for (const entry of entries) {
      const key = normalizedGameKey(entry.row.game_name || entry.row.title);
      if (!key) continue;
      const current = winners.get(key);
      if (!current) {
        winners.set(key, entry);
        continue;
      }
      const priorityDiff = mobileSourcePriority(entry) - mobileSourcePriority(current);
      if (
        priorityDiff > 0 ||
        (priorityDiff === 0 && sortByDate(entry, current) < 0)
      ) {
        winners.set(key, entry);
      }
    }
    return [...winners.values()];
  };
  const mobileUpcomingPriority = (entry) => {
    const facts = entry.facts || {};
    const tags = entry.row.source_id === "ref-haoyou"
      ? filterHaoyouGameplayTags(facts.haoyouTags || [])
      : facts.taptapTags || facts.haoyouTags || [];
    const tagText = Array.isArray(tags) ? tags.join(" ") : String(tags || "");
    const onlineGame = /MMORPG|多人联机|多人|竞技|MOBA|团战|PVP|合作|射击|开放世界/iu.test(tagText) ? 1 : 0;
    const gameplayScore = Math.min(5, Array.isArray(tags) ? tags.length : 0);
    const ipScore = getMobilePrioritySignals({
      sourceId: entry.row.source_id,
      title: entry.row.title,
      gameName: entry.row.game_name,
      facts,
    }).ipBoost;
    return { onlineGame, ipScore, gameplayScore };
  };
  const sortMobileUpcoming = (left, right) => {
    const a = mobileUpcomingPriority(left);
    const b = mobileUpcomingPriority(right);
    return b.onlineGame - a.onlineGame ||
      b.ipScore - a.ipScore ||
      b.gameplayScore - a.gameplayScore ||
      sortByDate(left, right);
  };
  const todayStart = startOfDay(nowDate);
  const todayEnd = todayStart + 86400000;
  const tomorrowEnd = todayEnd + 86400000;
  const isTodayEntry = (entry) => {
    const timestamp = articleTimestamp(entry, nowDate);
    return timestamp != null && timestamp >= todayStart && timestamp < todayEnd;
  };

  const tapTapUpcomingEntries = tapRows
    .filter(isUpcomingRow)
    .filter((entry) =>
      isWithinDays(articleTimestamp(entry, nowDate), nowDate, 7),
    );
  const haoyouUpcomingEntries = haoyouRows
    .filter(({ facts }) => facts.haoyouKind !== "update")
    // 适配器未标出 kind 的历史数据也不能把“版本预约/更新”混进上线栏目。
    .filter(({ row }) => !/(?:版本|更新|联动|赛季|周年庆)/u.test(`${row.category || ""} ${row.title || ""}`))
    .filter((entry) =>
      isWithinDays(articleTimestamp(entry, nowDate), nowDate, 7),
    );
  const preferredMobileUpcoming = selectPreferredMobileEntries([
    ...tapTapUpcomingEntries,
    ...haoyouUpcomingEntries,
  ]);
  // 主栏目只完整展示今日上线，不能让未来项目按优先级抢占今日位置。
  const mobileUpcoming = preferredMobileUpcoming
    .filter(isTodayEntry)
    .sort(sortMobileUpcoming)
    .map(toItem);
  const mobileUpcomingAll = preferredMobileUpcoming
    .sort(sortMobileUpcoming)
    .map(toItem);
  const upcomingTapTap = mobileUpcoming.filter((item) => item.sourceId === "ref-taptap");

  const tapTapEventCandidates = tapRows
    .filter(isEventRow)
    .flatMap((entry) => flattenTapTapEvents(entry, nowDate))
    .filter(
      (item) =>
        item.dateTimestamp == null ||
        isWithinDays(item.dateTimestamp, nowDate, 30),
    )
    .sort(
      (a, b) =>
        (a.dateTimestamp ?? Number.MAX_SAFE_INTEGER) -
        (b.dateTimestamp ?? Number.MAX_SAFE_INTEGER),
    );

  const haoyouUpcoming = mobileUpcoming.filter((item) => item.sourceId === "ref-haoyou");
  const haoyouUpdateCandidates = haoyouRows
    .filter(({ facts }) => facts.haoyouKind === "update")
    .filter((entry) =>
      isTodayOrFuture(articleTimestamp(entry, nowDate), nowDate),
    )
    .sort(sortByDate)
    .map(toItem);
  // 版本/活动只合并“同游戏 + 跨平台 + 日期相差不超过 2 天 + 标题语义相似”的
  // 同一事件；并优先 TapTap 的完整分段正文、原图和活动详情。
  const mobileEvents = [];
  for (const item of [...tapTapEventCandidates, ...haoyouUpdateCandidates]) {
    const duplicateIndex = mobileEvents.findIndex((current) =>
      isSameGameEntity(current.gameName, item.gameName) &&
      isSameCrossPlatformEvent(current, item),
    );
    if (duplicateIndex < 0) {
      mobileEvents.push(item);
      continue;
    }
    const current = mobileEvents[duplicateIndex];
    const candidatePriority = item.sourceId === "ref-taptap" ? 100 : 70;
    const currentPriority = current.sourceId === "ref-taptap" ? 100 : 70;
    if (candidatePriority > currentPriority) mobileEvents[duplicateIndex] = item;
  }
  mobileEvents.sort((a, b) =>
    (a.dateTimestamp ?? Number.MAX_SAFE_INTEGER) - (b.dateTimestamp ?? Number.MAX_SAFE_INTEGER) ||
    Number(b.sourceId === "ref-taptap") - Number(a.sourceId === "ref-taptap"),
  );
  const mobileEventsAll = [...mobileEvents];
  const mobileEventsTodayAll = mobileEventsAll
    .filter((item) => item.dateTimestamp != null && item.dateTimestamp >= todayStart && item.dateTimestamp < todayEnd);
  const mobileEventsFutureAll = mobileEventsAll
    .filter((item) => item.dateTimestamp != null && item.dateTimestamp >= todayEnd);
  const mobileEventsToday = mobileEventsTodayAll.slice(0, 15);
  const mobileEventsTomorrow = mobileEventsFutureAll
    .filter((item) => item.dateTimestamp < tomorrowEnd);
  const mobileEventsLater = mobileEventsFutureAll
    .filter((item) => item.dateTimestamp >= tomorrowEnd);
  // “未来”栏完整展示明日；若明日不足 10 条，再按时间顺序补充之后的活动。
  const mobileEventsFuture = mobileEventsTomorrow.length >= 10
    ? mobileEventsTomorrow
    : [...mobileEventsTomorrow, ...mobileEventsLater.slice(0, 10 - mobileEventsTomorrow.length)];
  // 今日的上线与更新共用一套优先级：网游玩法、重点 IP、标签完整度、时间。
  const mobileDisplayPriority = (item) => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const tagText = tags.join(" ");
    const onlineGame = /MMORPG|多人联机|多人|竞技|MOBA|团战|PVP|合作|射击|开放世界/iu.test(tagText) ? 1 : 0;
    const ipScore = getMobilePrioritySignals({
      sourceId: item.sourceId,
      title: item.title,
      gameName: item.gameName,
      facts: {},
    }).ipBoost;
    return { onlineGame, ipScore, gameplayScore: Math.min(5, tags.length) };
  };
  const sortMobileDisplay = (left, right) => {
    const a = mobileDisplayPriority(left);
    const b = mobileDisplayPriority(right);
    return b.onlineGame - a.onlineGame ||
      b.ipScore - a.ipScore ||
      b.gameplayScore - a.gameplayScore ||
      (left.dateTimestamp ?? Number.MAX_SAFE_INTEGER) - (right.dateTimestamp ?? Number.MAX_SAFE_INTEGER);
  };
  const sortMobileSchedule = (left, right) =>
    (left.dateTimestamp ?? Number.MAX_SAFE_INTEGER) - (right.dateTimestamp ?? Number.MAX_SAFE_INTEGER) ||
    sortMobileDisplay(left, right);
  const markTodayEvent = (item) => ({ ...item, cardKind: "today-event" });
  const isTodayMobileItem = (item) =>
    item.dateTimestamp != null && item.dateTimestamp >= todayStart && item.dateTimestamp < todayEnd;
  // 主栏目只展示今天；弹窗保留未来新游，并按日程时间正序展开。
  const mobileToday = [
    ...mobileUpcoming.filter(isTodayMobileItem),
    ...mobileEventsTodayAll.map(markTodayEvent),
  ].sort(sortMobileDisplay);
  const mobileTodayAll = [
    ...mobileUpcomingAll,
    ...mobileEventsTodayAll.map(markTodayEvent),
  ].sort(sortMobileSchedule);
  const tapTapEvents = mobileEventsAll.filter((item) => item.sourceId === "ref-taptap");
  const haoyouUpdates = mobileEventsAll.filter((item) => item.sourceId === "ref-haoyou");

  const officialNewsAll = newsRows
    .filter((entry) =>
      isTodayOrFuture(articleTimestamp(entry, nowDate), nowDate),
    )
    .filter(hasEditorialDetail)
    .sort(sortByDate)
    .map(toItem);
  const officialNews = officialNewsAll.slice(0, 6);
  // 热玩、畅销是两个信号源，不是两个需要完整铺开的栏目。
  // 只保留真正值得进入简讯的游戏：新上榜、提升至少 5 位、双榜同时在列，
  // 或任一榜单前 5。每个游戏只出现一次，最多 10 条，不以低价值条目补足。
  const steamHighlightGroups = new Map();
  for (const entry of steamRows) {
    if (!["most_played", "top_selling_cn"].includes(entry.facts.steamList))
      continue;
    const appId = /\/app\/(\d+)/.exec(entry.row.detail_url || "")?.[1];
    const key = appId || normalizedGameKey(entry.row.game_name || entry.row.title);
    if (!key) continue;
    const group = steamHighlightGroups.get(key) || [];
    group.push(entry);
    steamHighlightGroups.set(key, group);
  }
  const steamHighlights = [...steamHighlightGroups.values()]
    .map((entries) => {
      const ranked = [...entries].sort(sortByRank);
      const primary = ranked[0];
      const bestRank = Number(primary.facts.steamRankCurrent || 0);
      const rankGain = Math.max(
        0,
        ...entries.map((entry) => Number(entry.facts.steamRankGain || 0)),
      );
      const isNewEntry = entries.some(
        (entry) =>
          Boolean(entry.facts.steamRankBaselineKnown) &&
          Boolean(entry.facts.steamRankNewEntry),
      );
      const lists = new Set(entries.map((entry) => entry.facts.steamList));
      const dualChart = lists.size > 1;
      const isQualified =
        isNewEntry || rankGain >= 5 || dualChart || (bestRank > 0 && bestRank <= 5);
      if (!isQualified) return null;
      const chartSummary = entries
        .sort((left, right) => String(left.facts.steamList).localeCompare(String(right.facts.steamList)))
        .map((entry) => `${entry.facts.steamList === "most_played" ? "热玩榜" : "畅销榜"} #${entry.facts.steamRankCurrent || "—"}`)
        .join(" · ");
      return {
        entry: primary,
        isNewEntry,
        rankGain,
        bestRank,
        dualChart,
        chartSummary,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      Number(right.isNewEntry) - Number(left.isNewEntry) ||
      right.rankGain - left.rankGain ||
      Number(right.dualChart) - Number(left.dualChart) ||
      left.bestRank - right.bestRank,
    )
    .slice(0, 10)
    .map((highlight) =>
      toItem(highlight.entry, {
        table: "Steam 热门 / 新上榜",
        rank: highlight.bestRank,
        rankGain: highlight.rankGain,
        isNewEntry: highlight.isNewEntry,
        chartSummary: highlight.chartSummary,
      }),
    );

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalCandidates: rows.length,
      platformCounts: Object.fromEntries(
        [...sourceRows.entries()].map(([sourceId, entries]) => [
          sourceId,
          entries.length,
        ]),
      ),
    },
    supplements: {
      mobileUpcoming,
      mobileUpcomingAll,
      mobileToday,
      mobileTodayAll,
      mobileEvents: mobileEventsAll,
      mobileEventsAll,
      mobileEventsTodayAll,
      mobileEventsFutureAll,
      mobileEventsToday,
      mobileEventsFuture,
      editorial: officialNews,
      editorialAll: officialNewsAll,
      steam: {
        // 今日简讯收录以上海当天为中心的过去 7 天至未来 7 天新游；RAW
        // 仍保留全量候选，供人工验收。展示时优先离今天最近的发售日。
        newGames: steamRows
          .filter(({ facts }) => facts.steamList === "new")
          .filter((entry) => {
            const timestamp = articleTimestamp(entry, nowDate);
            return timestamp != null &&
              timestamp >= todayStart - 7 * 86400000 &&
              timestamp < todayStart + 8 * 86400000;
          })
          .filter((entry) => cleanDashboardTags(entry.facts.steamTags || []).length > 0)
          .sort((left, right) =>
            Math.abs(articleTimestamp(left, nowDate) - todayStart) - Math.abs(articleTimestamp(right, nowDate) - todayStart) ||
            articleTimestamp(right, nowDate) - articleTimestamp(left, nowDate) ||
            Number(right.facts.potentialScore || 0) - Number(left.facts.potentialScore || 0) ||
            Number(right.row.score || 0) - Number(left.row.score || 0),
          )
          .slice(0, 5)
          .map(toItem),
        highlights: steamHighlights,
      },
      taptap: {
        hotTopics: tapRows
          .filter(isHotTopic)
          .sort((a, b) => hotTopicRank(a) - hotTopicRank(b))
          .slice(0, 5)
          .map(toItem),
        upcoming: upcomingTapTap,
        events: tapTapEvents,
      },
      haoyou: { upcoming: haoyouUpcoming, updates: haoyouUpdates },
      news: {
        gcores: officialNews
          .filter((item) => item.sourceId === "ref-gcores")
          .slice(0, 3),
        gamersky: officialNews.filter(
          (item) => item.sourceId === "ref-gamersky",
        ).slice(0, 3),
      },
    },
  };
}

export function getDashboardDetail(articleId, eventIndex = null) {
  const row = db.prepare("SELECT * FROM articles WHERE id = ?").get(articleId);
  if (!row || !isVisibleArticle(row)) return null;
  const facts = safeJson(row.facts, {});
  const normalizedEventIndex = Number.isInteger(eventIndex) && eventIndex >= 0
    ? eventIndex
    : null;
  if (normalizedEventIndex != null) {
    const event = Array.isArray(facts.taptapEvents)
      ? facts.taptapEvents[normalizedEventIndex]
      : null;
    if (!event) return null;
    const nowDate = shanghaiCalendarDate();
    return flattenTapTapEvents({ row, facts }, nowDate, true)
      .find((item) => item.eventIndex === normalizedEventIndex && item.articleId === row.id) || null;
  }
  return dashboardItem(row, facts, { includeDetail: true });
}

export function reviewArticle(
  id,
  { selectedParagraphIds, selectedImageIds, coverImageId },
) {
  db.prepare(
    `
    UPDATE articles SET review_status = 'confirmed',
      selected_paragraph_ids = ?, selected_image_ids = ?,
      cover_image_id = ?, selected_for_brief = 1, reviewed_at = datetime('now'),
      updated_at = datetime('now') WHERE id = ?
  `,
  ).run(
    JSON.stringify(selectedParagraphIds || []),
    JSON.stringify(selectedImageIds || []),
    coverImageId || null,
    id,
  );
}

function parseArticle(row) {
  return {
    ...row,
    paragraphs: row.paragraphs ? JSON.parse(row.paragraphs) : [],
    facts: row.facts ? JSON.parse(row.facts) : [],
    images: row.images_json ? JSON.parse(row.images_json) : [],
    selectedParagraphIds: row.selected_paragraph_ids
      ? JSON.parse(row.selected_paragraph_ids)
      : [],
    selectedImageIds: row.selected_image_ids
      ? JSON.parse(row.selected_image_ids)
      : [],
  };
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function imageLookupKey(value) {
  return String(value || "").trim().replace(/&amp;/g, "&").replace(/#.*$/, "");
}

// 已落盘图片优先用于正文布局，避免好游快爆等受 Referer 防盗链影响的远程图断开。
function localizeLayoutImages(layout, images) {
  if (!Array.isArray(layout)) return layout;
  const localByOriginal = new Map(
    (Array.isArray(images) ? images : [])
      .filter((image) => image?.originalUrl && (image?.src || image?.localUrl))
      .map((image) => [imageLookupKey(image.originalUrl), image.src || image.localUrl]),
  );
  return layout.map((block) => {
    if (!block || block.type !== "image") return block;
    const original = block.url || block.src || block.originalUrl || "";
    const local = localByOriginal.get(imageLookupKey(original));
    return local ? { ...block, url: local, src: local, originalUrl: original } : block;
  });
}

function dashboardItem(row, facts, overrides = {}) {
  const images = safeJson(row.images_json, []);
  const paragraphs = safeJson(row.paragraphs, []);
  // 仪表盘优先显示已落盘的图片。好游快爆等来源的远程热链会因 Referer
  // 或防盗链失败，而本地 /crawler-assets 路径可通过 Vite 代理稳定访问。
  const localImage = images.find(
    (image) => String(image?.src || image?.localUrl || "").startsWith("/crawler-assets/"),
  );
  const savedImage = localImage || images.find(
    (image) => image?.src || image?.localUrl || image?.url || image?.originalUrl,
  );
  const rawTags = facts.steamTags?.length
    ? facts.steamTags
    : facts.taptapTags?.length
      ? facts.taptapTags
      : facts.haoyouTags?.length
        ? facts.haoyouTags
        : [];
  const imageUrl =
    overrides.imageUrl ||
    savedImage?.src ||
    savedImage?.localUrl ||
    savedImage?.url ||
    savedImage?.originalUrl ||
    row.image_url ||
    null;
  // `imageUrl` 保持正文图优先，供详情弹窗按原文图文布局展示。
  // 列表卡片则单独保留采集入口给出的游戏封面，避免好游快爆的论坛正文图
  // 覆盖“即将上线 / 即将测试”中的游戏图标或封面。
  const coverImageUrl = overrides.coverImageUrl || row.image_url || imageUrl;
  const haoyouGameName = row.source_id === "ref-haoyou"
    ? extractHaoyouGameName(row.game_name || row.title || "")
    : row.game_name;
  const haoyouTitle = row.source_id === "ref-haoyou" && facts.haoyouKind === "update"
    ? cleanHaoyouUpdateTitle(row.title || "", haoyouGameName)
    : row.title;
  const summary =
    overrides.summary ||
    facts.taptapHotDescription ||
    facts.steamDescriptionSnippet ||
    facts.haoyouIntro ||
    (row.source_id === "ref-haoyou"
      ? cleanHaoyouTimelineSummary(facts.haoyouUpdateContent || "")
      : "") ||
    paragraphs.filter(Boolean).slice(0, 2).join("\n") ||
    "暂无摘要";
  const structuredContent = Array.isArray(facts.gcoresLayout)
    ? facts.gcoresLayout
    : Array.isArray(facts.gamerskyLayout)
      ? facts.gamerskyLayout
      : Array.isArray(facts.haoyouLayout)
        ? localizeLayoutImages(facts.haoyouLayout, images)
      : paragraphs.filter(Boolean).map((text) => ({ type: "text", text }));
  const includeDetail = Boolean(overrides.includeDetail);
  return {
    id: overrides.id || row.id,
    articleId: row.id,
    eventIndex: overrides.eventIndex ?? null,
    sourceId: row.source_id,
    platform: row.source_name,
    table: overrides.table || row.category,
    title: overrides.title || haoyouTitle,
    gameName: haoyouGameName || "未命名游戏",
    dateText: overrides.dateText ?? row.date_text ?? "",
    dateTimestamp: overrides.dateTimestamp ?? null,
    summary,
    content: includeDetail
      ? (overrides.content || paragraphs.filter(Boolean))
      : [],
    contentBlocks:
      includeDetail
        ? (overrides.contentBlocks !== undefined
          ? overrides.contentBlocks
          : structuredContent)
        : [],
    tags: cleanDashboardTags(rawTags, row.source_id),
    imageUrl,
    coverImageUrl,
    detailUrl: overrides.detailUrl || row.detail_url,
    sourceUrl: overrides.sourceUrl || facts.taptapOriginalUrl || row.detail_url,
    rank: overrides.rank ?? (Number(facts.steamRankCurrent || 0) || null),
    previousRank:
      overrides.previousRank ??
      (Number(facts.steamRankPrevious || 0) || null),
    rankGain: overrides.rankGain ?? (Number(facts.steamRankGain || 0) || 0),
    isNewEntry:
      overrides.isNewEntry ??
      (Boolean(facts.steamRankBaselineKnown) &&
        Boolean(facts.steamRankNewEntry)),
    chartSummary: overrides.chartSummary || "",
    tagStatus: facts.tagStatus || "unknown",
  };
}

function flattenTapTapEvents(entry, nowDate, includeDetail = false) {
  return entry.facts.taptapEvents.map((event, index) => {
    const timestamp = parseDateText(
      event.status || entry.row.date_text,
      nowDate,
    );
    const imageUrl =
      event.images?.find((image) => image?.url)?.url ||
      entry.row.image_url ||
      null;
    return dashboardItem(entry.row, entry.facts, {
      id: `${entry.row.id}-event-${index}`,
      eventIndex: index,
      includeDetail,
      table: "版本更新 / 活动 / 联动",
      title: event.title || entry.row.title,
      dateText: event.status || entry.row.date_text || "敬请期待",
      dateTimestamp: timestamp,
      summary:
        event.summary || event.paragraphs?.slice(0, 2).join("\n") || "暂无摘要",
      content: event.paragraphs || [],
      contentBlocks: event.blocks || [],
      imageUrl,
      detailUrl: event.url || entry.row.detail_url,
      sourceUrl: entry.row.detail_url,
    });
  });
}

function articleTimestamp(entry, nowDate) {
  const startTime = Number(entry.facts.taptapUpcomingStartTime || 0);
  if (Number.isFinite(startTime) && startTime > 0)
    return startTime * 1000;
  return parseDateText(
    entry.facts.timelineDate || entry.row.date_text,
    nowDate,
  );
}

function parseDateText(value, nowDate) {
  const text = String(value || "").trim();
  if (!text || /(敬请期待|未知|暂无)/.test(text)) return null;
  // Steam 中文商店常返回“2026 年 8 月 10 日”，需兼容其中的空格与“年”。
  const compactText = text.replace(/\s+/g, "");
  const timeMatch = /(?:\s|^)(\d{1,2})(?::|点)(\d{1,2})?/.exec(text);
  const hours = timeMatch ? Number(timeMatch[1]) : 0;
  const minutes = timeMatch?.[2] ? Number(timeMatch[2]) : 0;
  const relative = /(\d+)\s*天前/.exec(text);
  if (relative) return startOfDay(nowDate) - Number(relative[1]) * 86400000 + hours * 3600000 + minutes * 60000;
  const match = /(?:(\d{4})(?:年|[\/-]))?(\d{1,2})月?(\d{1,2})日?/.exec(compactText);
  if (match) {
    const year = Number(match[1] || nowDate.getUTCFullYear());
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    return Date.UTC(year, month, day, hours, minutes);
  }
  if (/今天/.test(text)) return startOfDay(nowDate) + hours * 3600000 + minutes * 60000;
  if (/明天/.test(text)) return startOfDay(nowDate) + 86400000 + hours * 3600000 + minutes * 60000;
  return null;
}

function startOfDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function shanghaiCalendarDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)),
  );
}

function shanghaiDayWindow(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const start = new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)) - 8 * 3600000,
  );
  return { start, now: new Date(value) };
}

function isWithinDays(timestamp, nowDate, days) {
  if (timestamp == null) return false;
  const start = startOfDay(nowDate);
  return timestamp >= start && timestamp < start + (days + 1) * 86400000;
}

function isTodayOrFuture(timestamp, nowDate) {
  return timestamp != null && timestamp >= startOfDay(nowDate);
}

function cleanDashboardTags(tags, sourceId = "") {
  if (sourceId === "ref-haoyou") return filterHaoyouGameplayTags(tags);
  const blocked =
    /^(编辑推荐|多平台|多端互通|Steam移植|端游改编|SOC|高画质|中国风|第一人称|DIY创造|行云流水|美少女|手绘|竖屏|论坛\d+)$/i;
  return [
    ...new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag || "").trim())
        .filter((tag) => tag && !blocked.test(tag)),
    ),
  ].slice(0, 5);
}

function isVisibleArticle(row) {
  // 九游平台已移除：保留历史数据库记录，但不再参与 API / RAW 展示。
  if (row.source_id === "ref-jiuyou") return false;
  // 小七是飞书新游监控专用来源：保留在本地库供监控脚本读取，
  // 不进入 Dashboard、RAW、海报或今日简讯，避免两套产品口径混在一起。
  if (row.source_id === "ref-x7") return false;
  if (row.source_id === "ref-taptap") {
    const isHotTopic = /\/forum\/hot\/hashtags\?item=\d+/.test(
      row.detail_url || "",
    );
    if (isHotTopic) {
      // 热榜固定展示页面前五条，不使用即将上线的过滤规则。
      // `?item=1` 是榜位标识而不是详情页；缺描述时仍应显示，不能被 low 误隐藏。
      return row.quality !== "failed";
    }
    if (!taptapFilter(row.title || "")) return false;
    if (!isTapTapDetailUrl(row.detail_url || "")) return false;
    if (["low", "low_quality", "failed"].includes(row.quality)) return false;
    return true;
  }
  if (row.source_id !== "ref-steam") return true;
  if (["low", "low_quality", "failed", "pending"].includes(row.quality))
    return false;
  const title = `${row.title || ""} ${row.game_name || ""}`;
  const body = row.paragraphs || "";
  if (
    /\b(DLC|Demo|Beta|Expansion|Season\s*Pass|Supporter\s*Pack|Soundtrack|OST|Bundle|Upgrade|Add[-\s]?on)\b/i.test(
      title,
    )
  )
    return false;
  if (
    /(下载内容|扩展包|季票|原声带|演示版|试玩版|支持者包|工具|编辑器|服务器|壁纸)/i.test(
      title,
    )
  )
    return false;
  if (
    /(productivity\s+app|writing\s+tool|desktop\s+app|desktop\s+pet|screen\s+companion|scratchpad|image\s+editor|video\s+editor|audio\s+production)/i.test(
      body,
    )
  )
    return false;
  try {
    const facts = JSON.parse(row.facts || "{}");
    if (Array.isArray(facts.rejectReasons) && facts.rejectReasons.length)
      return false;
    // 榜单先落基础记录、详情异步补全时，potentialScore=0 只是“尚未评分”。
    // 已通过工具/DLC过滤的官方榜单不应因此全部从业务列表隐藏。
    if (
      facts.storePageStatus !== "pending_enrichment" &&
      facts.potentialScore !== undefined &&
      Number(facts.potentialScore) < 55
    )
      return false;
  } catch {}
  return true;
}

/** Steam 业务 API 暴露完整的新游列表，以及最新快照的热玩/畅销前15。 */
function capSteamRows(rows) {
  const others = rows.filter((row) => row.source_id !== "ref-steam");
  const steam = rows
    .filter((row) => row.source_id === "ref-steam")
    .map((row) => {
      let facts = {};
      try {
        facts = JSON.parse(row.facts || "{}");
      } catch {}
      return { row, facts };
    });
  const newGames = steam
    .filter(({ facts }) => facts.steamList === "new")
    .sort((a, b) => Number(b.row.score || 0) - Number(a.row.score || 0))
    .map(({ row }) => row);
  const chartRows = (listKind) => {
    const candidates = steam.filter(
      ({ facts }) => facts.steamList === listKind,
    );
    const latestSnapshot = candidates.reduce(
      (latest, { facts }) =>
        String(facts.steamSnapshotId || "") > latest
          ? String(facts.steamSnapshotId || "")
          : latest,
      "",
    );
    return candidates
      .filter(({ facts }) =>
        latestSnapshot ? facts.steamSnapshotId === latestSnapshot : true,
      )
      .sort((a, b) =>
        listKind === "most_played"
          ? Number(
              String(b.facts.steamChartMetric?.dailyPeak || 0).replace(
                /[^\d]/g,
                "",
              ),
            ) -
              Number(
                String(a.facts.steamChartMetric?.dailyPeak || 0).replace(
                  /[^\d]/g,
                  "",
                ),
              ) ||
            Number(a.facts.steamRankCurrent || Number.MAX_SAFE_INTEGER) -
              Number(b.facts.steamRankCurrent || Number.MAX_SAFE_INTEGER)
          : Number(a.facts.steamRankCurrent || Number.MAX_SAFE_INTEGER) -
            Number(b.facts.steamRankCurrent || Number.MAX_SAFE_INTEGER),
      )
      .slice(0, 15)
      .map(({ row }) => row);
  };
  return [
    ...others,
    ...newGames,
    ...chartRows("most_played"),
    ...chartRows("top_selling_cn"),
  ];
}

function getSourceStats() {
  const rows = db
    .prepare("SELECT * FROM articles")
    .all()
    .filter(isVisibleArticle);
  const counts = new Map();
  for (const row of rows)
    counts.set(row.source_id, (counts.get(row.source_id) || 0) + 1);
  return Object.fromEntries(counts);
}

export function saveBrief(brief) {
  const id = brief.id || `brief-${Date.now()}`;
  const timestamp = now();
  const slot = brief.slot || "daily";
  const maxLength = brief.maxLength ?? brief.max_length ?? 1200;
  const suppliedCharacters = Number(
    brief.totalCharacters ?? brief.total_characters ?? 0,
  );
  const totalCharacters =
    Number.isFinite(suppliedCharacters) && suppliedCharacters > 0
      ? suppliedCharacters
      : countBriefCharacters(brief);
  const readingMinutes = brief.readingMinutes ?? brief.reading_minutes ?? 3;
  const templateId = brief.templateId ?? brief.template_id ?? null;
  db.prepare(
    `
    INSERT INTO briefs (id, title, style, max_length, lead, template_id,
      total_characters, reading_minutes, sections_json, source_notes, slot, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM briefs WHERE id = ?), ?), ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, style = excluded.style, max_length = excluded.max_length,
      lead = excluded.lead, total_characters = excluded.total_characters,
      reading_minutes = excluded.reading_minutes, sections_json = excluded.sections_json,
      source_notes = excluded.source_notes, slot = excluded.slot,
      status = excluded.status, updated_at = excluded.updated_at
  `,
  ).run(
    id,
    brief.title || "今日简讯",
    brief.style || "professional",
    maxLength,
    brief.lead || "",
    templateId,
    totalCharacters,
    readingMinutes,
    JSON.stringify(brief.sections || []),
    JSON.stringify(brief.sourceNotes || []),
    slot,
    brief.status || "draft",
    id,
    timestamp,
    timestamp,
  );
  return {
    ...brief,
    id,
    slot,
    maxLength,
    totalCharacters,
    readingMinutes,
    templateId,
    updatedAt: timestamp,
  };
}

function countBriefCharacters(brief) {
  const sections = Array.isArray(brief.sections) ? brief.sections : [];
  const blockText = sections
    .flatMap((section) => (Array.isArray(section.blocks) ? section.blocks : []))
    .filter((block) => block?.type === "text")
    .map((block) => block.content || "")
    .join("");
  const sectionText = sections
    .map((section) => `${section?.heading || ""}${section?.body || ""}`)
    .join("");
  return Array.from(
    `${brief.title || ""}${brief.lead || ""}${blockText || sectionText}`,
  ).length;
}

export function listBriefs({ scope = "active" } = {}) {
  const where = scope === "trash"
    ? "status = 'trash'"
    : "COALESCE(status, 'draft') != 'trash'";
  const rows = db
    .prepare(`SELECT * FROM briefs WHERE ${where} ORDER BY updated_at DESC LIMIT 40`)
    .all();
  return { briefs: rows.map(parseBrief) };
}

export function deleteBrief(id) {
  db.prepare("DELETE FROM briefs WHERE id = ?").run(id);
}

export function setBriefStatus(id, status) {
  const allowed = new Set(["draft", "saved", "exported", "trash"]);
  if (!allowed.has(status)) throw new Error("不支持的简讯状态");
  const result = db
    .prepare("UPDATE briefs SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now(), id);
  if (!result.changes) throw new Error("未找到对应简讯");
  return parseBrief(db.prepare("SELECT * FROM briefs WHERE id = ?").get(id));
}

export function clearBriefs() {
  return db.prepare("DELETE FROM briefs").run().changes;
}

/** 清理超过保留时长的旧文章；daily 简讯不随文章清理。 */
export function cleanupOldArticles(hoursToKeep = 48) {
  const safeHours = Math.max(1, Number(hoursToKeep) || 48);
  const cutoff = new Date(Date.now() - safeHours * 3600 * 1000).toISOString();
  const expiredRows = db
    .prepare("SELECT images_json FROM articles WHERE discovered_at < ?")
    .all(cutoff);
  const result = db
    .prepare("DELETE FROM articles WHERE discovered_at < ?")
    .run(cutoff);
  // 本地图片与文章同生命周期：仅在文章记录已经删除，且没有任何保留文章仍
  // 引用该 /crawler-assets 文件时才删除。远程图片和目录外路径一律不触碰。
  const expiredAssets = new Set();
  for (const row of expiredRows) {
    for (const image of safeJson(row.images_json, [])) {
      const src = String(image?.src || image?.localUrl || "");
      if (src.startsWith("/crawler-assets/")) expiredAssets.add(src);
    }
  }
  const retainedAssets = new Set();
  for (const row of db.prepare("SELECT images_json FROM articles WHERE images_json IS NOT NULL AND images_json <> '[]'").all()) {
    for (const image of safeJson(row.images_json, [])) {
      const src = String(image?.src || image?.localUrl || "");
      if (src.startsWith("/crawler-assets/")) retainedAssets.add(src);
    }
  }
  const crawlerAssetsRoot = path.resolve(dataDir, "crawler");
  const emptyDirectories = new Set();
  let deletedImages = 0;
  let imageCleanupFailures = 0;
  for (const src of expiredAssets) {
    if (retainedAssets.has(src)) continue;
    const relative = src.slice("/crawler-assets/".length).replaceAll("/", path.sep);
    const filePath = path.resolve(crawlerAssetsRoot, relative);
    if (!filePath.startsWith(`${crawlerAssetsRoot}${path.sep}`)) continue;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedImages += 1;
      }
      emptyDirectories.add(path.dirname(filePath));
      emptyDirectories.add(path.dirname(path.dirname(filePath)));
    } catch {
      imageCleanupFailures += 1;
    }
  }
  for (const directory of [...emptyDirectories].sort((left, right) => right.length - left.length)) {
    try { fs.rmdirSync(directory); } catch {}
  }
  // 非 daily 简讯仅保留最近14天；daily 简讯按日期长期留档。
  const briefCutoff = new Date(
    Date.now() - 14 * 24 * 3600 * 1000,
  ).toISOString();
  db.prepare("DELETE FROM briefs WHERE created_at < ? AND slot != 'daily'").run(
    briefCutoff,
  );
  return {
    deletedArticles: result.changes,
    deletedImages,
    imageCleanupFailures,
    cutoff,
    hoursToKeep: safeHours,
  };
}

function parseBrief(row) {
  return {
    ...row,
    maxLength: row.max_length ?? 1200,
    totalCharacters: row.total_characters ?? 0,
    readingMinutes: row.reading_minutes ?? 3,
    templateId: row.template_id ?? null,
    sections: row.sections_json ? JSON.parse(row.sections_json) : [],
    sourceNotes: row.source_notes ? JSON.parse(row.source_notes) : [],
  };
}
