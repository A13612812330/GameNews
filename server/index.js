import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listSources,
  addSource,
  deleteSource,
  listArticles,
  listTodayArticles,
  reviewArticle,
  saveBrief,
  listBriefs,
  deleteBrief,
  setBriefStatus,
  clearBriefs,
  seedBuiltinSources,
  getArticlesByIds,
  getDashboardDetail,
  db,
} from "./database.js";
import { getDashboardProjection } from "./briefProjection.js";
import {
  crawlCandidates,
  crawlDetails,
  estimateDetails,
} from "./crawler/tasks.js";
import { getSources as getCrawlerSources } from "./crawler/registry.js";
import {
  beginMonitor,
  finishMonitor,
  getMonitorState,
  reportSourceProgress,
  updateMonitor,
} from "./crawler/monitor.js";
import {
  isCrawlerPaused,
  crawlerPauseMessage,
  getCrawlerPauseInfo,
} from "./crawler/pause.js";
import { generateRichDraft } from "./content/generator.js";
import { runPipeline, runWeeklyBrief, startScheduler } from "./scheduler.js";
import {
  rawArticlesDataPath,
  archiveRawSnapshotOnce,
  refreshRawArticlesSnapshot,
} from "./rawSnapshot.js";
import { finalizeCrawlRun } from "./crawlFinalize.js";
import { syncFeishuTopicMonitor } from "./feishuTopicMonitor.js";
import {
  deleteDailyPosterPermanently,
  listDailyPosters,
  moveDailyPosterToTrash,
  restoreDailyPoster,
  writeDailyPoster,
} from "./dailyPoster.js";
import { writeWeeklyPoster } from "./weeklyPoster.js";
import { buildStandaloneHtml } from "../src/utils/export.js";

const app = express();
const port = Number(process.env.GAME_NEWS_API_PORT || 64424);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ACTIVE_RAW_SOURCES = {
  "ref-steam": {
    name: "Steam",
    url: "https://store.steampowered.com/charts/mostplayed?cc=CN&l=schinese",
    rule: "新游、热玩榜、畅销榜；过滤 DLC、Demo、工具和低价值条目",
  },
  "ref-taptap": {
    name: "TapTap",
    url: "https://www.taptap.cn/forum/hot/hashtags",
    rule: "热榜前 5、即将上线、今日至未来 7 日版本/活动",
  },
  "ref-haoyou": {
    name: "好游快爆",
    url: "https://www.3839.com/timeline.html",
    rule: "仅时间线；上线/测试未来 7 日，更新仅今日及未来",
  },
  "ref-gcores": {
    name: "机核",
    url: "https://www.gcores.com/news",
    rule: "仅保留今日及未来官方游戏资讯；正文与插图按原文布局展示",
  },
  "ref-gamersky": {
    name: "游民星空",
    url: "https://www.gamersky.com/news/",
    rule: "严格官方资讯模式；仅保留今日及未来的完整正文与插图",
  },
};

const ARCHIVE_SLOTS = new Set(["daily", "morning", "afternoon", "weekly"]);

function archiveDirectory(slot, scope = "active") {
  return path.join(root, "data", scope === "trash" ? "brief-archive-trash" : "brief-archive", slot);
}

function archiveFilePath(slot, date, scope = "active") {
  return path.join(archiveDirectory(slot, scope), `${date}.json`);
}

// 旧版编辑页曾写到项目根目录；保留只读兼容，新的保存/定时任务统一写 data/brief-archive。
function legacyArchiveFilePath(slot, date) {
  return path.join(root, "brief-archive", slot, `${date}.json`);
}

function archiveReadPaths(slot, date, scope = "active") {
  const paths = [archiveFilePath(slot, date, scope)];
  if (scope === "active") paths.push(legacyArchiveFilePath(slot, date));
  return paths;
}

function existingArchiveFilePath(slot, date, scope = "active") {
  return archiveReadPaths(slot, date, scope).find((file) => fs.existsSync(file)) || null;
}

function readArchivePayload(slot, date, scope = "active") {
  const file = existingArchiveFilePath(slot, date, scope);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function archiveDates(slot, scope = "active") {
  const directories = [archiveDirectory(slot, scope)];
  if (scope === "active") directories.push(path.join(root, "brief-archive", slot));
  const dates = new Set();
  for (const directory of directories) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) dates.add(name.slice(0, -5));
      }
    } catch {}
  }
  return [...dates].sort().reverse();
}

function assertArchiveParams(slot, date) {
  if (!ARCHIVE_SLOTS.has(slot) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const error = new Error("无效的简讯归档参数");
    error.code = "EINVAL";
    throw error;
  }
}

function archiveBrief(slot, brief) {
  if (!ARCHIVE_SLOTS.has(slot)) return null;
  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);
  const file = archiveFilePath(slot, date);
  const payload = { ok: true, generatedAt, type: slot, brief };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return { date, generatedAt, file };
}

function archiveMeta(slot, date, scope = "active") {
  const payload = readArchivePayload(slot, date, scope);
  if (payload) {
    const brief = payload.brief || payload;
    return {
      date,
      title: brief.title || "今日简讯",
      totalCharacters: brief.totalCharacters || 0,
      updatedAt: payload.generatedAt || null,
    };
  }
  if (scope === "active") {
    const currentFile = path.join(
      root,
      "data",
      slot === "weekly" ? "weekly-brief.json" : `brief-${slot}.json`,
    );
    try {
      const current = JSON.parse(fs.readFileSync(currentFile, "utf8"));
      const generatedDate = current.generatedAt
        ? new Date(current.generatedAt).toISOString().slice(0, 10)
        : "";
      if (generatedDate === date) {
        const brief = current.brief || current;
        return {
          date,
          title: brief.title || "今日简讯",
          totalCharacters: brief.totalCharacters || 0,
          updatedAt: current.generatedAt || null,
        };
      }
    } catch {}
  }
  return { date, title: "今日简讯", totalCharacters: 0, updatedAt: null };
}

function readRawFeedSnapshot() {
  if (!fs.existsSync(rawArticlesDataPath))
    throw new Error("RAW_ARTICLES.json 尚未生成");
  return JSON.parse(fs.readFileSync(rawArticlesDataPath, "utf8"));
}

function rawDateStart(value = "") {
  const text = String(value || "").trim();
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const today = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  if (/^(今天|今日)/u.test(text)) return today;
  if (/^明天/u.test(text)) return today + 86400000;
  if (/^后天/u.test(text)) return today + 2 * 86400000;
  let match = /(20\d{2})\s*(?:年|[\/-])\s*(\d{1,2})\s*(?:月|[\/-])\s*(\d{1,2})/u.exec(text);
  if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  match = /(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*日?/u.exec(text);
  if (!match) return null;
  let year = Number(parts.year);
  let candidate = Date.UTC(year, Number(match[1]) - 1, Number(match[2]));
  if (candidate < today && Number(parts.month) >= 10 && Number(match[1]) <= 3) {
    year += 1;
    candidate = Date.UTC(year, Number(match[1]) - 1, Number(match[2]));
  }
  return candidate;
}

function matchesRawScope(article, scope) {
  if (scope === "audit") return true;
  const timestamp = rawDateStart(article.date_text);
  const todayParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const today = Date.UTC(Number(todayParts.year), Number(todayParts.month) - 1, Number(todayParts.day));
  const facts = article.facts || {};
  const isSteamSnapshot = Boolean(facts.steamList);

  // Steam 的新游栏目是明确约定的“过去 7 天 + 今日 + 未来 7 天”，
  // 不能再套用其他来源的纯“今日 + 未来”条件；热玩/畅销榜则是当天快照。
  // 这使 RAW、抓取资讯和 Dashboard 对 Steam 采用同一业务口径。
  if (isSteamSnapshot) {
    const isChart = facts.steamList !== "new";
    if (timestamp == null) {
      if (scope === "today") return isChart && isTodayPosterArticle(article);
      return scope === "today_future" && isChart;
    }
    if (scope === "today") return timestamp === today;
    if (scope === "future") return timestamp > today && timestamp <= today + 7 * 86400000;
    return timestamp >= today - 7 * 86400000 && timestamp <= today + 7 * 86400000;
  }
  if (timestamp == null) {
    return scope === "today_future" && /\/forum\/hot\/hashtags\?item=\d+/.test(article.detail_url || "");
  }
  if (scope === "today") return timestamp === today;
  if (scope === "future") return timestamp > today;
  return timestamp >= today;
}

function shanghaiStartOfToday() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

function isTodayPosterArticle(article) {
  const start = shanghaiStartOfToday();
  const timestamp = rawDateStart(article.date_text);
  if (timestamp != null) return timestamp === start;
  const facts = article.facts || {};
  const isSnapshot = Boolean(facts.steamList) || /\/forum\/hot\/hashtags\?item=\d+/.test(article.detail_url || "");
  if (!isSnapshot) return false;
  const discovered = new Date(article.discovered_at || article.updated_at || 0).getTime();
  return Number.isFinite(discovered) && discovered >= start && discovered < start + 86400000;
}

function readActiveRawFeedSnapshot({ scope = "audit" } = {}) {
  const snapshot = readRawFeedSnapshot();
  const sourceIds = new Set(Object.keys(ACTIVE_RAW_SOURCES));
  const allArticles = Array.isArray(snapshot.articles) ? snapshot.articles : [];
  const activeArticles = allArticles.filter((article) => sourceIds.has(article.source_id));
  const articles = activeArticles.filter((article) => matchesRawScope(article, scope));
  return {
    ...snapshot,
    total: articles.length,
    snapshotTotal: activeArticles.length,
    scope,
    inactive: allArticles.length - activeArticles.length,
    scopeExcluded: activeArticles.length - articles.length,
    articles,
  };
}

function rawTableName(article = {}) {
  const facts = article.facts || {};
  if (article.source_id === "ref-steam")
    return (
      {
        new: "新游上线",
        most_played: "中国区热玩榜",
        top_selling_cn: "中国区畅销榜",
      }[facts.steamList] || "Steam 候选"
    );
  if (article.source_id === "ref-taptap") {
    if (/\/forum\/hot\/hashtags\?item=\d+/.test(article.detail_url || ""))
      return "热榜话题";
    if (/\/game-event\/?/.test(article.detail_url || ""))
      return "版本更新 / 活动 / 联动";
    return "即将上线 / 首发";
  }
  return facts.haoyouKind === "update" ? "即将更新" : "即将上线 + 即将测试";
}

// 全文简讯会带原始图文布局，导出时正文 JSON 可能超过 1MB。
// 仅提高本地 API 的请求体限制，不改变数据库结构或图片落盘策略。
app.use(express.json({ limit: "8mb" }));

const ALLOW_ORIGIN = process.env.CLIENT_ORIGIN || "http://127.0.0.1:64423";
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,DELETE,OPTIONS",
  );
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    name: "Game News Hub API",
    time: new Date().toISOString(),
  }),
);

app.get("/api/sources", async (_req, res) => {
  // `sources` 为历史管理记录；真实爬虫入口以 registry 为唯一事实来源。
  // 额外返回 crawlerSources，避免前端/运维把 SQLite 中的旧来源误认为仍会被抓取。
  const crawlerSources = await getCrawlerSources();
  res.json({
    ok: true,
    sources: listSources(),
    crawlerSources: crawlerSources.map((source) => ({
      id: source.id,
      name: source.name,
      category: source.category,
      enabled: source.enabled !== false,
      fixed: Boolean(source.fixed),
      urls: source.urls,
    })),
  });
});
app.post("/api/sources", (req, res) => {
  try {
    res.json({ ok: true, source: addSource(req.body) });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});
app.delete("/api/sources/:id", (req, res) => {
  try {
    deleteSource(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

app.post("/api/crawl/candidates", async (req, res) => {
  if (isCrawlerPaused())
    return res.status(423).json({
      ok: false,
      code: "CRAWLER_PAUSED",
      message: crawlerPauseMessage(),
    });
  const sourceIds = req.body?.sourceIds || [];
  beginMonitor("候选抓取", { stage: "list", sourceIds });
  try {
    updateMonitor({ stage: "list" }, "正在抓取候选列表");
    const r = await crawlCandidates(sourceIds, {
      onProgress: (progress) => {
        reportSourceProgress(progress);
        updateMonitor(
          { stage: "list", currentSource: progress.sourceName },
          progress.status === "running"
            ? `正在抓取 ${progress.sourceName} · ${progress.urlType}`
            : progress.status === "failed"
              ? `${progress.sourceName} · ${progress.urlType} 抓取失败`
              : `${progress.sourceName} · ${progress.urlType} 已写入 ${progress.count || 0} 条`,
        );
      },
    });
    // 手动更新与定时流水线统一：候选写入后立即补全本轮所有详情、图片和图文布局。
    const detailArticleIds = r
      .flatMap((item) => (item.candidates || []).map((candidate) => candidate.id))
      .filter(Boolean);
    let details = null;
    if (detailArticleIds.length) {
      updateMonitor(
        { stage: "detail", currentSource: "详情与图片" },
        `正在补全 ${detailArticleIds.length} 条资讯详情`,
      );
      details = await crawlDetails(detailArticleIds);
      updateMonitor(
        { stage: "detail", details: details.perPlatform || [] },
        "资讯详情与图片补全完成",
      );
    }
    const finalized = await finalizeCrawlRun();
    let feishuSync = null;
    try {
      feishuSync = await syncFeishuTopicMonitor();
    } catch (error) {
      feishuSync = { error: error.message };
    }
    const raw = finalized.raw
      ? { ...finalized.raw, archive: finalized.archive, warnings: finalized.warnings }
      : { error: finalized.warnings.join("；") || "RAW 同步失败", warnings: finalized.warnings };
    const candidateTotal = r.reduce(
      (sum, item) => sum + (item.count || 0),
      0,
    );
    updateMonitor(
      { stage: details ? "detail" : "list", results: r, details, raw, feishuSync },
      raw.error
        ? `候选抓取完成，共 ${candidateTotal} 条；RAW 同步失败：${raw.error}`
        : `候选抓取完成，共 ${candidateTotal} 条；RAW 已同步${raw.archive?.created ? "，已保存当日备份" : ""}`,
    );
    finishMonitor({ results: r, details, raw, feishuSync }, "资讯更新结束");
    res.json({ ok: true, results: r, details, raw, feishuSync, cleanup: finalized.cleanup, warnings: finalized.warnings });
  } catch (e) {
    finishMonitor({ stage: "failed", error: e.message }, "候选抓取失败");
    res.status(400).json({ ok: false, message: e.message });
  }
});
app.post("/api/crawl/raw-refresh", async (_req, res) => {
  try {
    const raw = await refreshRawArticlesSnapshot();
    const archive = await archiveRawSnapshotOnce();
    res.json({ ok: true, raw, archive });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: `RAW 参考页同步失败：${e.message}`,
    });
  }
});
app.post("/api/crawl/details", async (req, res) => {
  if (isCrawlerPaused())
    return res.status(423).json({
      ok: false,
      code: "CRAWLER_PAUSED",
      message: crawlerPauseMessage(),
    });
  const articleIds = req.body?.articleIds || [];
  beginMonitor("详情抓取", { stage: "detail" });
  try {
    updateMonitor({ stage: "detail" }, `正在抓取 ${articleIds.length} 条详情`);
    const r = await crawlDetails(articleIds);
    updateMonitor(
      { stage: "detail", results: r.perPlatform || [] },
      "详情抓取完成",
    );
    finishMonitor({ results: r.perPlatform || [] }, "详情抓取结束");
    res.json({ ok: true, ...r });
  } catch (e) {
    finishMonitor({ stage: "failed", error: e.message }, "详情抓取失败");
    res.status(400).json({ ok: false, message: e.message });
  }
});
app.post("/api/crawl/estimate", async (req, res) => {
  if (isCrawlerPaused())
    return res.status(423).json({
      ok: false,
      code: "CRAWLER_PAUSED",
      message: crawlerPauseMessage(),
    });
  const articleIds = req.body?.articleIds || [];
  beginMonitor("详情估算", { stage: "estimate" });
  try {
    updateMonitor(
      { stage: "estimate" },
      `正在估算 ${articleIds.length} 条详情`,
    );
    const r = await estimateDetails(articleIds);
    finishMonitor({ results: r.estimates || [] }, "详情估算结束");
    res.json({ ok: true, ...r });
  } catch (e) {
    finishMonitor({ stage: "failed", error: e.message }, "详情估算失败");
    res.status(400).json({ ok: false, message: e.message });
  }
});
app.get("/api/crawl/status", (_req, res) => {
  res.json({ ok: true, ...getMonitorState(), pause: getCrawlerPauseInfo() });
});
app.get("/api/crawl/monitor", async (_req, res) => {
  try {
    // 监控页与“抓取资讯”使用同一业务范围：默认是“今日 + 未来”，
    // Steam 新游按既定规则扩展为过去 7 天至未来 7 天，Steam 榜单是当期快照；
    // 额外保留 auditTotal，明确展示 RAW 验收的全量候选，避免 131 / 118 被误解为不同步。
    const rawAudit = readActiveRawFeedSnapshot({ scope: "audit" });
    const raw = readActiveRawFeedSnapshot({ scope: "today_future" });
    const articles = Array.isArray(raw.articles) ? raw.articles : [];
    const sources = Object.entries(ACTIVE_RAW_SOURCES).map(
      ([sourceId, config]) => {
        const rows = articles.filter(
          (article) => article.source_id === sourceId,
        );
        const tables = Object.entries(
          rows.reduce((result, article) => {
            const name = rawTableName(article);
            result[name] = (result[name] || 0) + 1;
            return result;
          }, {}),
        ).map(([name, count]) => ({ name, count }));
        return {
          sourceId,
          sourceName: config.name,
          sourceUrl: config.url,
          rule: config.rule,
          total: rows.length,
          detailCount: rows.filter(
            (article) => (article.paragraphs || []).length > 0,
          ).length,
          imageCount: rows.filter(
            (article) => article.image_url || (article.images || []).length > 0,
          ).length,
          tables,
        };
      },
    );
    const latest = [...articles]
      .sort((a, b) =>
        String(b.discovered_at || "").localeCompare(
          String(a.discovered_at || ""),
        ),
      )
      .slice(0, 12)
      .map((article) => ({
        id: article.id,
        sourceName: article.source_name,
        title: article.title,
        gameName: article.game_name,
        quality: article.quality,
        discoveredAt: article.discovered_at,
        table: rawTableName(article),
      }));
    let cronLogs = [];
    try {
      cronLogs = JSON.parse(
        fs.readFileSync(
          path.join(root, "data", "logs", "cron-result.json"),
          "utf8",
        ),
      )
        .slice(-12)
        .reverse();
    } catch {}
    const monitorState = getMonitorState();
    const lastRun = monitorState.history?.at(-1) || null;
    const liveSince =
      monitorState.startedAt ||
      lastRun?.startedAt ||
      raw.generatedAt ||
      "1970-01-01T00:00:00.000Z";
    const liveRows = db
      .prepare(
        `
      SELECT id, source_id, source_name, title, game_name, category, quality, discovered_at, updated_at
      FROM articles
      WHERE updated_at >= datetime(?)
      ORDER BY updated_at DESC
      LIMIT 1000
    `,
      )
      .all(liveSince);
    const liveSources = Object.entries(ACTIVE_RAW_SOURCES).map(
      ([sourceId, config]) => {
        const rows = liveRows.filter(
          (article) => article.source_id === sourceId,
        );
        return {
          sourceId,
          sourceName: config.name,
          writtenCount: rows.length,
          successfulCount: rows.filter(
            (article) =>
              !["failed", "low", "low_quality"].includes(article.quality),
          ).length,
          failedCount: rows.filter((article) => article.quality === "failed")
            .length,
        };
      },
    );
    res.json({
      ok: true,
      monitor: {
        ...monitorState,
        pause: getCrawlerPauseInfo(),
      },
      live: {
        since: monitorState.startedAt || lastRun?.startedAt || null,
        totalWrites: liveRows.length,
        sources: liveSources,
      },
      raw: {
        generatedAt: raw.generatedAt,
        ageMinutes: raw.generatedAt
          ? Math.max(
              0,
              Math.round(
                (Date.now() - new Date(raw.generatedAt).getTime()) / 60000,
              ),
            )
          : null,
        stale: raw.generatedAt
          ? Date.now() - new Date(raw.generatedAt).getTime() > 24 * 3600 * 1000
          : true,
        total: raw.total || articles.length,
        auditTotal: rawAudit.total || 0,
        hidden: rawAudit.hidden || 0,
        scope: raw.scope,
        scopeLabel: "今日 + 未来（Steam 新游近 7 日至未来 7 日；榜单为当前快照）",
        scopeExcluded: raw.scopeExcluded || 0,
        sources,
        latest,
      },
      cronLogs,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/api/articles/today", (_req, res) =>
  res.json({ ok: true, ...listTodayArticles() }),
);
app.get("/api/articles", (req, res) =>
  res.json({ ok: true, ...listArticles(req.query) }),
);
app.get("/api/dashboard", (_req, res) => {
  try {
    res.json({ ok: true, ...getDashboardProjection() });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, message: e.message || "读取首页资讯补充失败" });
  }
});
app.get("/api/dashboard/detail/:id", (req, res) => {
  try {
    const rawEventIndex = req.query.eventIndex;
    const eventIndex = rawEventIndex === undefined ? null : Number(rawEventIndex);
    const item = getDashboardDetail(req.params.id, eventIndex);
    if (!item)
      return res.status(404).json({ ok: false, message: "资讯详情不存在或已被过滤" });
    return res.json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "读取资讯详情失败" });
  }
});
app.get("/api/raw-feed", (req, res) => {
  try {
    const requestedScope = String(req.query.scope || "today_future");
    const scope = ["audit", "today_future", "today", "future"].includes(requestedScope)
      ? requestedScope
      : "today_future";
    return res.json(readActiveRawFeedSnapshot({ scope }));
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "读取 RAW 数据失败" });
  }
});
app.get("/api/taptap-image", async (req, res) => {
  try {
    const imageUrl = new URL(String(req.query.url || ""));
    if (
      !/(^|\.)tapimg\.com$/i.test(imageUrl.hostname) ||
      imageUrl.protocol !== "https:"
    ) {
      return res
        .status(400)
        .json({ ok: false, message: "不支持的 TapTap 图片地址" });
    }
    const upstream = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 GameNews/1.0",
        Referer: "https://www.taptap.cn/",
      },
      signal: AbortSignal.timeout(12_000),
    });
    const contentType = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !contentType.startsWith("image/"))
      throw new Error(`TapTap 图片请求失败 (${upstream.status})`);
    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type(contentType).send(body);
  } catch (e) {
    res
      .status(502)
      .json({ ok: false, message: e.message || "TapTap 图片代理失败" });
  }
});
app.get("/api/image-proxy", async (req, res) => {
  try {
    const imageUrl = new URL(String(req.query.url || ""));
    const hostname = imageUrl.hostname.toLowerCase();
    const allowed = [
      "tapimg.com",
      "gcores.com",
      "gamersky.com",
      "71acg.net",
      "3839img.com",
      "3839video.com",
    ];
    if (
      imageUrl.protocol !== "https:" ||
      !allowed.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      )
    ) {
      return res
        .status(400)
        .json({ ok: false, message: "不支持的资讯图片地址" });
    }
    const referer = hostname.endsWith("tapimg.com")
      ? "https://www.taptap.cn/"
      : hostname.endsWith("gcores.com")
        ? "https://www.gcores.com/"
        : hostname.endsWith("gamersky.com")
          ? "https://www.gamersky.com/"
          : "https://www.3839.com/";
    const upstream = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 GameNews/1.0", Referer: referer },
      signal: AbortSignal.timeout(12_000),
    });
    const contentType = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !contentType.startsWith("image/"))
      throw new Error(`资讯图片请求失败 (${upstream.status})`);
    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type(contentType).send(body);
  } catch (e) {
    res
      .status(502)
      .json({ ok: false, message: e.message || "资讯图片代理失败" });
  }
});
app.post("/api/articles/:id/review", (req, res) => {
  reviewArticle(req.params.id, req.body);
  res.json({ ok: true });
});

app.post("/api/briefs/generate", (req, res) => {
  try {
    const ids = req.body.articleIds || [];
    const articles = getArticlesByIds(ids);
    if (!articles.length)
      return res
        .status(400)
        .json({ ok: false, message: "未找到对应文章，请先抓取资讯" });

    const imageSrcForBrief = (sourceId, value) => {
      if (!value) return "";
      if (String(value).startsWith("/crawler-assets/")) return value;
      return ["ref-taptap", "ref-haoyou", "ref-gcores", "ref-gamersky"].includes(sourceId)
        ? `/api/image-proxy?url=${encodeURIComponent(value)}`
        : value;
    };
    const imageItemsForBrief = (article) => {
      const saved = (article.images || [])
        .map((image, index) => {
          const originalUrl =
            image?.originalUrl || image?.url || image?.src || "";
          const src = imageSrcForBrief(
            article.source_id,
            image?.src || image?.localUrl || image?.url || originalUrl,
          );
          return src
            ? {
                id: image?.id || `${article.id}-image-${index + 1}`,
                src,
                originalUrl,
                alt: image?.alt || "",
              }
            : null;
        })
        .filter(Boolean);
      if (saved.length || !article.image_url) return saved;
      return [
        {
          id: `${article.id}-cover`,
          src: imageSrcForBrief(article.source_id, article.image_url),
          originalUrl: article.image_url,
          alt: "游戏封面",
        },
      ];
    };
    const events = articles.map((a) => ({
      articleId: a.id,
      title: a.title,
      gameName: a.game_name,
      category: a.category,
      paragraphs: a.paragraphs || [],
      images: imageItemsForBrief(a),
      sourceId: a.source_id,
      sourceName: a.source_name,
      detailUrl: a.detail_url,
      facts: a.facts || {},
      dateText: a.date_text || "",
    }));

    const style = ["professional", "casual", "minimal"].includes(req.body.style)
      ? req.body.style
      : "professional";
    const templateId =
      req.body.templateId ||
      { professional: "T3", casual: "T2", minimal: "T1" }[style];
    const requestedLength = Number(req.body.maxLength);
    const maxLength = Math.max(
      300,
      Math.min(5000, Number.isFinite(requestedLength) ? requestedLength : 5000),
    );
    const requestedImages = Number(req.body.imagesPerArticle);
    const imagesPerArticle =
      requestedImages === -1
        ? -1
        : Math.max(
            0,
            Math.min(6, Number.isFinite(requestedImages) ? requestedImages : 6),
          );
    const contentMode = req.body.contentMode === "summary" ? "summary" : "full";
    const draft = generateRichDraft(events, {
      templateId,
      style,
      maxLength,
      imagesPerArticle,
      contentMode,
    });
    // 生成即持久化为草稿，方便在历史中找回未手动保存、未导出的内容。
    const brief = saveBrief({ ...draft, style, maxLength, status: "draft" });
    res.json({ ok: true, brief });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

app.post("/api/daily-poster/generate", async (req, res) => {
  try {
    const requestedIds = [...new Set((req.body?.articleIds || []).filter(Boolean))];
    // 未手动选择时，海报默认取当前上海自然日已入库的资讯；手动选择仍优先。
    const byId = new Map(getArticlesByIds(requestedIds).map((article) => [article.id, article]));
    const selectedArticles = requestedIds.length
      ? requestedIds.map((id) => byId.get(id)).filter(Boolean)
      : listTodayArticles().articles;
    // 人工勾选或定时简讯已确定的素材应原样进入海报；只有未指定素材时，才按
    // “上海自然日”自动补齐。否则会把当天简讯中已选的未来上线/无日期热榜再次剔除。
    const articles = requestedIds.length ? selectedArticles : selectedArticles.filter(isTodayPosterArticle);
    if (!articles.length) {
      return res.status(400).json({ ok: false, message: requestedIds.length ? "所选资讯中没有符合“仅今日”规则的条目" : "今日暂无可生成海报的资讯" });
    }
    const assetBase = `${req.protocol}://${req.get("host")}`;
    const poster = await writeDailyPoster({ root, articles, assetBase });
    res.json({
      ok: true,
      ...poster,
      url: `/generated-output/${encodeURIComponent(poster.fileName)}`,
      archiveUrl: `/generated-output/poster-archive/${encodeURIComponent(poster.fileName)}`,
      downloadUrl: `/api/daily-poster/download/${encodeURIComponent(poster.fileName)}`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || "生成海报失败" });
  }
});

app.post("/api/weekly-poster/generate", async (_req, res) => {
  try {
    const assetBase = `${_req.protocol}://${_req.get("host")}`;
    const poster = await writeWeeklyPoster({ root, assetBase });
    res.json({
      ok: true,
      ...poster,
      url: `/generated-output/${encodeURIComponent(poster.fileName)}`,
      archiveUrl: `/generated-output/weekly-poster-archive/${encodeURIComponent(poster.fileName)}`,
      downloadUrl: `/api/weekly-poster/download/${encodeURIComponent(poster.fileName)}`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || "生成周报失败" });
  }
});

app.get("/api/weekly-poster/download/:fileName", (req, res) => {
  const fileName = path.basename(String(req.params.fileName || ""));
  if (!/^游戏资讯周报-\d{4}-\d{2}-\d{2}\.html$/u.test(fileName)) {
    return res.status(400).json({ ok: false, message: "无效的周报文件名" });
  }
  const outputPath = path.join(root, "output", fileName);
  const archivePath = path.join(root, "output", "weekly-poster-archive", fileName);
  const filePath = fs.existsSync(outputPath) ? outputPath : archivePath;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, message: "周报文件不存在" });
  }
  return res.download(filePath, fileName);
});

function shanghaiFileDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

app.post("/api/briefs/export-html", (req, res) => {
  try {
    const brief = req.body?.brief;
    if (!brief || !Array.isArray(brief.sections)) {
      return res.status(400).json({ ok: false, message: "没有可导出的简讯内容" });
    }
    const fileName = `今日简讯-${shanghaiFileDate()}.html`;
    const outputDir = path.join(root, "output", "brief-archive");
    const filePath = path.join(outputDir, fileName);
    fs.mkdirSync(outputDir, { recursive: true });
    // 用与编辑器实时预览同一份模板输出，图片继续从本地服务绝对地址读取。
    fs.writeFileSync(
      filePath,
      buildStandaloneHtml(brief, {
        assetBase: `${req.protocol}://${req.get("host")}`,
      }),
      "utf8",
    );
    res.json({
      ok: true,
      fileName,
      url: `/generated-output/brief-archive/${encodeURIComponent(fileName)}`,
      downloadUrl: `/api/briefs/export-html/download/${encodeURIComponent(fileName)}`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || "简讯 HTML 导出失败" });
  }
});

app.get("/api/briefs/export-html/download/:fileName", (req, res) => {
  const fileName = path.basename(String(req.params.fileName || ""));
  if (!/^今日简讯-\d{4}-\d{2}-\d{2}\.html$/u.test(fileName)) {
    return res.status(400).json({ ok: false, message: "无效的简讯文件名" });
  }
  const filePath = path.join(root, "output", "brief-archive", fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, message: "简讯 HTML 文件不存在" });
  }
  return res.download(filePath, fileName);
});

app.get("/api/daily-poster/download/:fileName", (req, res) => {
  const fileName = path.basename(String(req.params.fileName || ""));
  if (!/^简讯海报-\d{4}-\d{2}-\d{2}\.html$/.test(fileName)) {
    return res.status(400).json({ ok: false, message: "无效的海报文件名" });
  }
  const scope = req.query.scope === "trash" ? "trash" : "active";
  const outputPath = path.join(root, "output", fileName);
  const archivePath = path.join(root, "output", "poster-archive", fileName);
  const trashPath = path.join(root, "output", "poster-trash", fileName);
  const filePath = scope === "trash" ? trashPath : (fs.existsSync(outputPath) ? outputPath : archivePath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, message: "海报文件不存在" });
  }
  return res.download(filePath, fileName);
});
app.get("/api/daily-poster/records", async (req, res) => {
  try {
    const scope = req.query.scope === "trash" ? "trash" : "active";
    const posters = await listDailyPosters({ root, scope });
    res.json({
      ok: true,
      posters: posters.map((poster) => ({
        ...poster,
        url: scope === "trash"
          ? `/generated-output/poster-trash/${encodeURIComponent(poster.fileName)}`
          : `/generated-output/poster-archive/${encodeURIComponent(poster.fileName)}`,
        downloadUrl: `/api/daily-poster/download/${encodeURIComponent(poster.fileName)}${scope === "trash" ? "?scope=trash" : ""}`,
      })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || "读取海报记录失败" });
  }
});
app.post("/api/daily-poster/:fileName/trash", async (req, res) => {
  try {
    const result = await moveDailyPosterToTrash({ root, fileName: req.params.fileName });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error?.code === "ENOENT" ? 404 : 400).json({ ok: false, message: error.message || "海报移入回收站失败" });
  }
});
app.post("/api/daily-poster/:fileName/restore", async (req, res) => {
  try {
    const result = await restoreDailyPoster({ root, fileName: req.params.fileName });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error?.code === "ENOENT" ? 404 : 400).json({ ok: false, message: error.message || "海报恢复失败" });
  }
});
app.delete("/api/daily-poster/:fileName", async (req, res) => {
  try {
    const result = await deleteDailyPosterPermanently({ root, fileName: req.params.fileName });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error?.code === "ENOENT" ? 404 : 400).json({ ok: false, message: error.message || "海报永久删除失败" });
  }
});
app.get("/api/briefs", (req, res) =>
  res.json({
    ok: true,
    ...listBriefs({ scope: req.query.scope === "trash" ? "trash" : "active" }),
  }),
);
app.post("/api/briefs/:id/trash", (req, res) => {
  try {
    res.json({ ok: true, brief: setBriefStatus(req.params.id, "trash") });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});
app.post("/api/briefs/:id/restore", (req, res) => {
  try {
    res.json({ ok: true, brief: setBriefStatus(req.params.id, "draft") });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});
app.delete("/api/briefs/:id", (req, res) => {
  deleteBrief(req.params.id);
  res.json({ ok: true });
});
app.delete("/api/briefs", (_req, res) =>
  res.json({ ok: true, deleted: clearBriefs() }),
);

app.post("/api/briefs", (req, res) => {
  try {
    const brief = saveBrief(req.body);
    const archive =
      brief.slot === "daily" && ["saved", "exported"].includes(brief.status)
        ? archiveBrief("daily", brief)
        : null;
    res.json({ ok: true, brief, archive });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// === WorkBuddy 流水线 API ===

/** 手动触发完整流水线：爬取→清洗→生成简讯→输出JSON */
app.post("/api/pipeline/run", async (_req, res) => {
  if (isCrawlerPaused())
    return res.status(423).json({
      ok: false,
      code: "CRAWLER_PAUSED",
      message: crawlerPauseMessage(),
    });
  try {
    await runPipeline();
    res.json({ ok: true, message: "流水线完成" });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/** Codex 数据契约：读取最新标准化简讯 JSON */
app.get("/api/daily-brief", (_req, res) => {
  // 保留旧接口名，但不再返回 data/brief-daily.json 的历史内容。
  // 当前读取口径与 Dashboard 完全一致；历史内容仅通过按日期留档接口读取。
  const dashboard = getDashboardProjection();
  res.json({
    ok: true,
    type: "dashboard-projection",
    generatedAt: dashboard.generatedAt,
    stale: false,
    message: "已与当前今日简讯投影同步；历史简讯请读取 /api/brief/archive/daily。",
    brief: null,
    dashboard,
  });
});

/** 早报 (data/brief-morning.json) */
app.get("/api/brief/morning", (_req, res) =>
  res.json(readBrief("brief-morning.json")),
);
/** 晚报 (data/brief-afternoon.json) */
app.get("/api/brief/afternoon", (_req, res) =>
  res.json(readBrief("brief-afternoon.json")),
);
/** 周报 (data/weekly-brief.json) */
app.get("/api/brief/weekly", (_req, res) =>
  res.json(readBrief("weekly-brief.json")),
);
app.get("/api/brief/archive/:slot", (req, res) => {
  if (!ARCHIVE_SLOTS.has(req.params.slot))
    return res.status(400).json({ ok: false, message: "不支持的简讯类型" });
  const scope = req.query.scope === "trash" ? "trash" : "active";
  const dates = archiveDates(req.params.slot, scope);
  if (!dates.length && scope === "active") {
    const currentFile = path.join(
      root,
      "data",
      req.params.slot === "weekly"
        ? "weekly-brief.json"
        : `brief-${req.params.slot}.json`,
    );
    try {
      const current = JSON.parse(fs.readFileSync(currentFile, "utf8"));
      const currentDate = current.generatedAt
        ? new Date(current.generatedAt).toISOString().slice(0, 10)
        : "";
      if (currentDate) dates.push(currentDate);
    } catch {}
  }
  return res.json({
    ok: true,
    slot: req.params.slot,
    scope,
    dates,
    archives: dates.map((date) => archiveMeta(req.params.slot, date, scope)),
  });
});
app.post("/api/brief/archive/:slot/:date/trash", (req, res) => {
  try {
    assertArchiveParams(req.params.slot, req.params.date);
    const source = existingArchiveFilePath(req.params.slot, req.params.date);
    const target = archiveFilePath(req.params.slot, req.params.date, "trash");
    if (!source) throw new Error("该日期留档不存在或不能移入回收站");
    if (fs.existsSync(target)) throw new Error("回收站内已有同日期留档，请先处理后再移动");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    res.json({ ok: true, date: req.params.date, scope: "trash" });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "移入留档回收站失败" });
  }
});
app.post("/api/brief/archive/:slot/:date/restore", (req, res) => {
  try {
    assertArchiveParams(req.params.slot, req.params.date);
    const source = archiveFilePath(req.params.slot, req.params.date, "trash");
    const target = archiveFilePath(req.params.slot, req.params.date);
    if (!fs.existsSync(source)) throw new Error("回收站内未找到该日期留档");
    if (fs.existsSync(target)) throw new Error("当前留档已有相同日期，请先处理现有留档");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    res.json({ ok: true, date: req.params.date, scope: "active" });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "恢复留档失败" });
  }
});
app.delete("/api/brief/archive/:slot/:date", (req, res) => {
  try {
    assertArchiveParams(req.params.slot, req.params.date);
    if (req.query.scope !== "trash") throw new Error("请先将留档移入回收站，再执行永久删除");
    const file = archiveFilePath(req.params.slot, req.params.date, "trash");
    if (!fs.existsSync(file)) throw new Error("回收站内未找到该日期留档");
    fs.unlinkSync(file);
    res.json({ ok: true, date: req.params.date, deleted: true });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "永久删除留档失败" });
  }
});
app.get("/api/brief/archive/:slot/:date", (req, res) => {
  if (
    !ARCHIVE_SLOTS.has(req.params.slot) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)
  ) {
    return res.status(400).json({ ok: false, message: "无效的简讯归档参数" });
  }
  const scope = req.query.scope === "trash" ? "trash" : "active";
  const file = existingArchiveFilePath(req.params.slot, req.params.date, scope);
  try {
    if (!file) throw new Error("留档不存在");
    res.type("json").send(fs.readFileSync(file, "utf8"));
  } catch {
    if (scope === "trash") return res.status(404).json({ ok: false, message: "未找到该日期留档" });
    const currentFile = path.join(
      root,
      "data",
      req.params.slot === "weekly"
        ? "weekly-brief.json"
        : `brief-${req.params.slot}.json`,
    );
    try {
      const current = JSON.parse(fs.readFileSync(currentFile, "utf8"));
      const currentDate = current.generatedAt
        ? new Date(current.generatedAt).toISOString().slice(0, 10)
        : "";
      if (currentDate === req.params.date)
        return res.type("json").send(JSON.stringify(current));
    } catch {}
    res.status(404).json({ ok: false, message: "该日期暂无简讯归档" });
  }
});

function readBrief(filename) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, "data", filename), "utf-8"),
    );
  } catch {
    return { ok: true, brief: null, message: "尚未生成" };
  }
}

seedBuiltinSources();

// 启动定时流水线
startScheduler();

const staticDir = path.join(root, "dist");
app.use(express.static(staticDir));
app.use(express.static(path.join(root, "public")));
app.use("/generated-output", express.static(path.join(root, "output")));
// imageSaver 将批次目录直接写入 data/crawler/<batchId>/images。
app.use("/crawler-assets", express.static(path.join(root, "data", "crawler")));
// 周报素材在 48 小时活跃库清理前已复制到独立快照目录，供周报 HTML 长期读取。
app.use("/weekly-assets", express.static(path.join(root, "data", "weekly-snapshots")));
app.use((req, res) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    return res.sendFile(path.join(staticDir, "index.html"));
  }
  res.status(404).json({ ok: false, message: "Not found" });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Game News Hub API: http://127.0.0.1:${port}`);
});
