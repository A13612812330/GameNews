import { createHash } from "node:crypto";
import { getDashboardSupplements } from "./database.js";

const CHANNELS = [
  ["手机游戏 · 即将上线", (data) => data.supplements.mobileUpcoming || []],
  ["手机游戏 · 今日更新", (data) => data.supplements.mobileEventsToday || []],
  ["版本更新 / 活动 / 联动 · 未来", (data) => data.supplements.mobileEventsFuture || []],
  ["TapTap 热榜话题", (data) => data.supplements.taptap?.hotTopics || []],
  ["Steam · 新游上线", (data) => data.supplements.steam?.newGames || []],
  ["Steam · 热门 / 新上榜", (data) => data.supplements.steam?.highlights || []],
  ["机核 / 游民星空", (data) => [
    ...(data.supplements.news?.gcores || []),
    ...(data.supplements.news?.gamersky || []),
  ]],
];

function articleKey(item = {}) {
  return String(item.articleId || item.id || "").trim();
}

function eventKey(item = {}) {
  const articleId = articleKey(item);
  if (!articleId) return "";
  return `${articleId}:${item.eventIndex == null ? "article" : item.eventIndex}`;
}

/**
 * 唯一的“今日简讯产品投影”。
 *
 * 数据库层仍负责平台适配、时间、质量、去重与栏目上限；本模块负责把这些
 * 已选结果转成可复用的栏目决策，供 Dashboard、RAW 验收以及后续抓取资讯页使用。
 * RAW 保留更宽的人工验收候选集，但每条记录都可通过 decision 查到是否被产品页选中。
 */
export function getBriefProjection() {
  const dashboard = getDashboardSupplements();
  const decisionByArticleId = {};
  const entries = [];

  for (const [channel, select] of CHANNELS) {
    for (const item of select(dashboard)) {
      const articleId = articleKey(item);
      if (!articleId) continue;
      const entry = {
        key: eventKey(item),
        articleId,
        eventIndex: item.eventIndex ?? null,
        channel,
        gameName: item.gameName || "",
        title: item.title || "",
        dateText: item.dateText || "",
      };
      entries.push(entry);
      const current = decisionByArticleId[articleId] || {
        selected: true,
        channels: [],
        entries: [],
      };
      if (!current.channels.includes(channel)) current.channels.push(channel);
      current.entries.push(entry);
      decisionByArticleId[articleId] = current;
    }
  }

  const signature = createHash("sha1")
    .update(JSON.stringify(entries.map((entry) => [entry.key, entry.channel])))
    .digest("hex")
    .slice(0, 12);

  return {
    generatedAt: dashboard.generatedAt,
    dashboard,
    audit: {
      signature,
      selectedEntryCount: entries.length,
      selectedArticleCount: Object.keys(decisionByArticleId).length,
      channels: Object.fromEntries(
        CHANNELS.map(([channel, select]) => [channel, select(dashboard).length]),
      ),
      decisionByArticleId,
      entries,
    },
  };
}

export function getDashboardProjection() {
  const projection = getBriefProjection();
  return {
    ...projection.dashboard,
    projection: {
      signature: projection.audit.signature,
      selectedEntryCount: projection.audit.selectedEntryCount,
      selectedArticleCount: projection.audit.selectedArticleCount,
      selectedArticleIds: [...new Set(projection.audit.entries.map((entry) => entry.articleId))],
      channels: projection.audit.channels,
    },
  };
}

export function projectionDecisionFor(articleId, audit = {}) {
  const decision = audit.decisionByArticleId?.[articleId];
  if (decision) {
    return {
      ...decision,
      reason: `已进入 Dashboard：${decision.channels.join("、")}`,
    };
  }
  return {
    selected: false,
    channels: [],
    entries: [],
    reason: "当前 Dashboard 投影未选择；仍保留在 RAW 供验收（可能受时间、详情完整度、去重或栏目数量限制影响）。",
  };
}
