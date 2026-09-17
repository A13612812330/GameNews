import { getSources } from "./registry.js";
import { fetchHtml } from "./fetcher.js";
import { parseList, parseDetail, parseGcoresApiDetail } from "./parser.js";
import { scoreArticle } from "./scorer.js";
import { stableId, dedupeByUrl, dedupeAgainstDB, contentDedupeKey } from "./deduper.js";
import { crawlTask, firecrawlFallback } from "./rateLimiter.js";
import { extractUpcomingTags, extractTapTapFollowerCount, extractTapTapPublisher, extractTapTapReviewCount, extractTapTapReserveCount, fetchTapTapAppTags, hasExcludedTapTapNewGameTag } from "./platforms/taptap.js";
import { isWithinNextDays as isHaoyouWithinNextDays } from "./platforms/haoyou.js";
import { extractPublisher as extractX7Publisher, extractDiscount as extractX7Discount, extractReserveCount as extractX7ReserveCount, fetchReservePages } from "./platforms/x7.js";
import { assertCrawlerActive } from "./pause.js";
import { db } from "../database.js";
import * as cheerio from "cheerio";
const MAX_PER_SOURCE = 60;

function imageLookupKey(value = "") {
  return String(value || "").trim().replace(/&amp;/g, "&").replace(/#.*$/, "");
}

function localizeHaoyouLayout(layout, images) {
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

function cleanTapTapApiText(value = "") {
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t\r\f]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function cleanTapTapRichText(value = "") {
  return String(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|section|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t\r\f]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isTodayOrFutureTapTapEvent(event = {}) {
  const status = cleanTapTapApiText(event.status || event.title || "");
  if (!status) return true;
  if (/昨天|前天|\d+\s*天前|已结束|已上线|已过期|历史/.test(status))
    return false;
  if (/今天|今日|明天|后天/.test(status)) return true;
  const match = /(\d{1,2})月(\d{1,2})日/.exec(status);
  if (!match) return true;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(
    now.getFullYear(),
    Number(match[1]) - 1,
    Number(match[2]),
  );
  if (
    target.getTime() < today.getTime() &&
    now.getMonth() >= 10 &&
    Number(match[1]) <= 3
  ) {
    target = new Date(
      now.getFullYear() + 1,
      Number(match[1]) - 1,
      Number(match[2]),
    );
  }
  return target.getTime() >= today.getTime();
}

function isWithinNextThirtyDaysTapTap(timestampSeconds) {
  const timestamp = Number(timestampSeconds || 0) * 1000;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + 30);
  end.setHours(23, 59, 59, 999);
  return timestamp >= today.getTime() && timestamp <= end.getTime();
}

function extractTapTapApiUrl(html, pathPart) {
  const pattern = new RegExp(
    `https?:\\\\?/\\\\?/www\\.taptap\\.cn\\\\?/webapiv2\\\\?/${pathPart}[^\\\\"]+`,
    "i",
  );
  const match = String(html).match(pattern);
  return match?.[0]?.replace(/\\u0026/g, "&").replace(/\\\//g, "/") || "";
}

async function fetchTapTapJson(endpoint, referer) {
  if (!endpoint) return null;
  try {
    const res = await fetch(endpoint, {
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "application/json",
        referer,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.success === false ? null : json;
  } catch {
    return null;
  }
}

function eventKind(title = "") {
  if (/联动|合作/.test(title)) return "collaboration";
  if (/活动/.test(title)) return "activity";
  if (/版本|更新|赛季|资料片/.test(title)) return "version";
  return "event";
}

function cleanHaoyouWarmText(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/预约赢|讨论分享|快爆专属好礼|立即前往|马上前往/giu, "")
    .trim();
}

// 好游论坛对非浏览器请求可能返回 HTTP 200 的加密壳，而不是真正正文。
// 不能仅根据请求是否报错判断成功；只对已经筛出的单条官方快讯使用
// Firecrawl 渲染回退，避免把额度消耗在候选列表或营销帖上。
function isHaoyouForumShell(html = "") {
  const source = String(html || "");
  if (!source) return true;
  return (
    source.length < 8000 ||
    (/zJqKEY\(|bbs_encrypt\.js/iu.test(source) &&
      !/class=["'][^"']*\bdocCon\b[^"']*["']/iu.test(source))
  );
}

async function fetchHaoyouWarmDetail(gameHtml, gameUrl, gameName) {
  const $ = cheerio.load(gameHtml);
  const candidates = [];
  $(".game-warm .lb-warm-li").each((_, item) => {
    const scope = $(item);
    const heading = cleanHaoyouWarmText(scope.find(".sp-tit").first().text());
    const description = cleanHaoyouWarmText(scope.find(".sp-txt").first().text());
    scope.find("a[href]").each((__, link) => {
      const href = $(link).attr("href") || "";
      let detailUrl = "";
      try { detailUrl = new URL(href, gameUrl).href; } catch { return; }
      const linkText = cleanHaoyouWarmText($(link).text());
      const isThread = /bbs\.3839\.com\/thread-\d+\.htm/iu.test(detailUrl);
      if (!isThread) return;
      const text = `${heading} ${description} ${linkText}`;
      if (/预约赢|讨论分享|礼包|福利|抽奖|签到|领奖|分享活动/iu.test(text)) return;
      let score = 0;
      if (/游戏首曝|首曝|官方资讯|官方消息|快爆快讯/iu.test(text)) score += 100;
      if (/曝光|新作|实机|预告|宣布|公布|开发|制作|上线|测试/iu.test(text)) score += 30;
      if (gameName && text.includes(gameName)) score += 20;
      candidates.push({ detailUrl, heading, linkText, score });
    });
  });
  const target = candidates.sort((left, right) => right.score - left.score)[0];
  if (!target || target.score < 30) return null;

  let threadHtml = "";
  try {
    threadHtml = await fetchHtml(target.detailUrl);
  } catch {
    // 交由下面的统一回退逻辑处理。
  }
  if (isHaoyouForumShell(threadHtml))
    threadHtml = await firecrawlFallback(target.detailUrl);
  if (!threadHtml) return null;
  const detail = parseDetail(threadHtml, {
    url: target.detailUrl,
    gameName,
    category: "新游上线",
  });
  if (!detail.paragraphs?.length && !detail.images?.length) return null;
  return {
    ...detail,
    facts: {
      ...(detail.facts || {}),
      haoyouWarmDetailUrl: target.detailUrl,
      haoyouWarmLabel: target.heading || target.linkText,
    },
  };
}

function eventImageList(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => {
      const url =
        typeof item === "string"
          ? item
          : item?.url ||
            item?.original_url ||
            item?.large_url ||
            item?.medium_url ||
            "";
      return url && /^https?:\/\//i.test(url)
        ? {
            url,
            label:
              typeof item === "object"
                ? item.alt || item.title || "活动图片"
                : "活动图片",
          }
        : null;
    })
    .filter(Boolean);
}

function parseTapTapEventJson(payload, eventUrl, fallback = {}) {
  const event = payload?.data || {};
  const paragraphs = [];
  const blocks = [];
  const push = (value) => {
    const text = cleanTapTapRichText(value);
    if (text) paragraphs.push(text);
  };
  push(event.title || fallback.title);
  push(event.whatsnew || fallback.summary);
  const images = eventImageList([event.banner, ...(event.images || [])]);
  for (const module of event.modules || []) {
    push(`【${module.title || "内容"}】`);
    const moduleBlock = { title: module.title || "内容", items: [] };
    for (const focus of module.focus || []) {
      push(`【${focus.title || ""}】`);
      push(focus.content);
      const focusImages = eventImageList(focus.images);
      images.push(...focusImages);
      moduleBlock.items.push({
        title: focus.title || "",
        content: cleanTapTapRichText(focus.content || ""),
        images: focusImages,
      });
    }
    blocks.push(moduleBlock);
  }
  return {
    kind: eventKind(event.title || fallback.title || ""),
    title:
      cleanTapTapRichText(event.title || fallback.title || "") ||
      fallback.title ||
      "TapTap活动",
    summary: cleanTapTapRichText(event.whatsnew || fallback.summary || ""),
    status: cleanTapTapRichText(event.hints || fallback.status || ""),
    url: eventUrl,
    paragraphs: [...new Set(paragraphs)],
    blocks,
    images: [...new Map(images.map((item) => [item.url, item])).values()],
    fetched: Boolean(payload),
  };
}

async function fetchTapTapEventDetail(eventUrl, fallback = {}) {
  const html = await fetchHtml(eventUrl, { dynamic: true });
  const endpoint = extractTapTapApiUrl(html, "in-app-event/v1/detail");
  const payload = await fetchTapTapJson(endpoint, eventUrl);
  if (payload) return parseTapTapEventJson(payload, eventUrl, fallback);

  const $ = cheerio.load(html);
  const paragraphs = [];
  const images = [];
  const blocks = [];
  $(".game-event-module").each((_, module) => {
    const moduleTitle = cleanTapTapRichText(
      $(module).find(".game-event-module__title").first().text(),
    );
    if (moduleTitle) paragraphs.push(`【${moduleTitle}】`);
    const moduleBlock = { title: moduleTitle || "内容", items: [] };
    $(module)
      .find(".game-event-important")
      .each((__, focus) => {
        const title = cleanTapTapRichText(
          $(focus).find(".heading-m16-w16").first().text(),
        );
        const content = cleanTapTapRichText(
          $(focus).find(".game-event-important__content").first().text(),
        );
        if (title) paragraphs.push(`【${title}】`);
        if (content) paragraphs.push(content);
        const blockImages = [];
        $(focus)
          .find("img")
          .each((___, img) => {
            const url = $(img).attr("data-src") || $(img).attr("src") || "";
            if (/^https?:\/\//i.test(url)) {
              const item = {
                url,
                label: $(img).attr("alt") || title || "活动图片",
              };
              images.push(item);
              blockImages.push(item);
            }
          });
        moduleBlock.items.push({ title, content, images: blockImages });
      });
    blocks.push(moduleBlock);
  });
  return {
    kind: eventKind(fallback.title || ""),
    title: fallback.title || cleanTapTapRichText($("h1").first().text()),
    summary: fallback.summary || "",
    status: fallback.status || "",
    url: eventUrl,
    paragraphs: [...new Set(paragraphs)],
    blocks,
    images: [...new Map(images.map((item) => [item.url, item])).values()],
    fetched: paragraphs.length > 0,
  };
}

async function fetchTapTapEvents(html, detailUrl) {
  if (!detailUrl.includes("taptap.cn/app/")) return [];
  const endpoint = extractTapTapApiUrl(html, "app/v2/whats-new");
  const payload = await fetchTapTapJson(endpoint, detailUrl);
  const list = payload?.data?.list || [];
  const events = [];
  for (const item of list) {
    const href = item.web_url || "";
    const eventUrl = href ? new URL(href, "https://www.taptap.cn").href : "";
    // App“新版本”入口可能同时返回官方动态 Moment；这里只保留可展开的 game-event 活动页。
    if (!eventUrl || !/\/game-event\/\d+/.test(new URL(eventUrl).pathname))
      continue;
    events.push(
      await fetchTapTapEventDetail(eventUrl, {
        title: item.title,
        summary: item.content,
        status: item.label_status,
      }),
    );
  }
  return events.filter(
    (event) => event.fetched || event.summary || event.images.length,
  );
}

async function fetchTapTapFullIntroduction(html, detailUrl) {
  if (!detailUrl.includes("taptap.cn/app/")) return [];
  const match = String(html).match(
    /https?:\\?\/\\?\/www\.taptap\.cn\\?\/webapiv2\\?\/app\\?\/v5\\?\/information[^"'<>\s]+/i,
  );
  if (!match) return [];
  const endpoint = match[0].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  try {
    const res = await fetch(endpoint, {
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "application/json",
        referer: detailUrl,
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = cleanTapTapRichText(data?.data?.description?.text || "");
    if (!text || text.length < 40) return [];
    // 以空行作为段落边界，保留段内换行；不能按单行切碎，否则会破坏 TapTap 原文排版。
    return text
      .split(/\n{2,}/)
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchGcoresArticle(detailUrl) {
  const articleId = /\/articles\/(\d+)/.exec(detailUrl || "")?.[1];
  if (!articleId) return null;
  try {
    const response = await fetch(
      `https://www.gcores.com/gapi/v1/articles/${articleId}`,
      {
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "application/vnd.api+json",
          referer: detailUrl,
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) return null;
    return (await response.json())?.data || null;
  } catch {
    return null;
  }
}

export async function crawlCandidates(
  sourceIds,
  { urlTypes, steamModes, onProgress } = {},
) {
  assertCrawlerActive();
  const platforms = (await getSources()).filter(
    (p) => p.enabled && (sourceIds?.length ? sourceIds.includes(p.id) : !p.monitorOnly),
  );
  const allResults = [];

  for (const p of platforms) {
    // 遍历该平台所有URL
    for (const urlEntry of p.urls || []) {
      const url = typeof urlEntry === "string" ? urlEntry : urlEntry.url;
      const urlType =
        typeof urlEntry === "string" ? "default" : urlEntry.type || "default";
      if (
        Array.isArray(urlTypes) &&
        urlTypes.length &&
        !urlTypes.includes(urlType)
      )
        continue;
      onProgress?.({
        sourceId: p.id,
        sourceName: p.name,
        urlType,
        status: "running",
      });

      const result = await crawlTask(`list:${p.id}:${urlType}`, async () => {
        try {
          if (p.id === "ref-steam") {
            // 常规模块导入：避免带版本查询串时形成独立模块实例，导致 Firecrawl 额度/缓存和最新解析逻辑不一致。
            const {
              fetchSteamItems,
              fetchSteamChartItems,
              enrichSteamChartItem,
            } = await import("./platforms/steam.js");
            const includeCatalog =
              !Array.isArray(steamModes) ||
              !steamModes.length ||
              steamModes.includes("catalog");
            const includeCharts =
              !Array.isArray(steamModes) ||
              !steamModes.length ||
              steamModes.includes("charts");
            const stmt = db.prepare(
              `INSERT INTO articles (id,source_id,source_name,title,game_name,category,detail_url,image_url,date_text,score,paragraphs,facts,quality,discovered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(id) DO UPDATE SET title=excluded.title, game_name=excluded.game_name, category=excluded.category, detail_url=excluded.detail_url, image_url=excluded.image_url, date_text=excluded.date_text, score=excluded.score, paragraphs=excluded.paragraphs, facts=excluded.facts, quality=excluded.quality, discovered_at=datetime('now'), updated_at=datetime('now')`,
            );
            const persistSteamItems = (items) => {
              const latestSnapshots = new Map();
              for (const row of db.prepare("SELECT facts FROM articles WHERE source_id='ref-steam'").all()) {
                try {
                  const facts = JSON.parse(row.facts || "{}");
                  const kind = facts.steamList;
                  const snapshotId = String(facts.steamSnapshotId || "");
                  if (kind && snapshotId && snapshotId > String(latestSnapshots.get(kind) || "")) latestSnapshots.set(kind, snapshotId);
                } catch {}
              }
              for (const item of items) {
                // 同一游戏可同时在新游、热玩、畅销三张表出现，稳定 ID 必须带列表类型。
                item.id = stableId(
                  p.id,
                  `${item.listKind || "legacy"}:${item.detailUrl}`,
                );
                // Steam 详情页是动态页抓不到正文，直接内嵌游戏介绍作为正文
                const paras = (item.paragraphs || []).filter(Boolean);
                let previousFacts = {};
                try {
                  previousFacts = JSON.parse(
                    db
                      .prepare("SELECT facts FROM articles WHERE id=?")
                      .get(item.id)?.facts || "{}",
                  );
                } catch {}
                const rankCurrent = Number.isInteger(item.rankCurrent)
                  ? item.rankCurrent
                  : null;
                const rankedList = ["most_played", "top_selling_cn"].includes(
                  item.listKind,
                );
                const wasInPreviousSnapshot =
                  previousFacts.steamList === item.listKind &&
                  previousFacts.steamSnapshotId === latestSnapshots.get(item.listKind);
                // 第一次采集还没有可比较的上一期快照，不能把整张榜单误标为“新上榜”。
                const hasPreviousSnapshot = Boolean(
                  latestSnapshots.get(item.listKind),
                );
                const priorCurrent =
                  wasInPreviousSnapshot &&
                  Number.isInteger(previousFacts.steamRankCurrent)
                    ? previousFacts.steamRankCurrent
                    : null;
                const rankPrevious =
                  rankedList && rankCurrent && priorCurrent
                    ? priorCurrent
                    : null;
                const rankGain =
                  rankPrevious && rankCurrent
                    ? rankPrevious - rankCurrent
                    : null;
                const facts = {
                  steamTags: item.tags || [],
                  steamGenres: item.genres || [],
                  steamCategories: item.categories || [],
                  steamDescriptionSnippet:
                    item.descriptionSnippet || paras[0] || "",
                  potentialScore: item.potentialScore || 0,
                  rejectReasons: item.rejectReasons || [],
                  storePageStatus: item.storePageStatus || "unknown",
                  tagStatus: item.tagStatus || "unknown",
                  steamList: item.listKind || "legacy",
                  steamRankCurrent: rankCurrent,
                  steamRankPrevious: rankPrevious,
                  steamRankGain: rankGain,
                  steamRankBaselineKnown: hasPreviousSnapshot,
                  steamRankNewEntry: Boolean(
                    rankedList &&
                      hasPreviousSnapshot &&
                      rankCurrent &&
                      !wasInPreviousSnapshot,
                  ),
                  steamRankObservedAt: rankCurrent
                    ? new Date().toISOString()
                    : null,
                  steamChartMetric: item.chartMetric || null,
                  steamSnapshotId: item.snapshotId || null,
                };
                stmt.run(
                  item.id,
                  p.id,
                  p.name,
                  item.title,
                  item.gameName,
                  item.category,
                  item.detailUrl,
                  item.imageUrl,
                  item.dateText || "",
                  item.score,
                  JSON.stringify(paras),
                  JSON.stringify(facts),
                  ["most_played", "top_selling_cn"].includes(item.listKind) ||
                    paras.length
                    ? "ok"
                    : "pending",
                );
              }
            };
            // 先写入基础榜单快照。即使新游详情或榜单详情补全超时，RAW 仍保留前15名次。
            const chartItems = includeCharts
              ? await fetchSteamChartItems({ limit: 15 })
              : [];
            persistSteamItems(chartItems);
            const catalogItems = includeCatalog ? await fetchSteamItems() : [];
            persistSteamItems(catalogItems);

            // 第二阶段：单条 appdetails 补中文名、玩法标签、简介。异步执行且单条失败隔离。
            if (chartItems.length) {
              void (async () => {
                for (const item of chartItems) {
                  try {
                    const enriched = await enrichSteamChartItem(item);
                    const id = stableId(
                      p.id,
                      `${item.listKind || "legacy"}:${item.detailUrl}`,
                    );
                    if (!enriched) continue;
                    const current = db
                      .prepare("SELECT facts FROM articles WHERE id=?")
                      .get(id);
                    let facts = {};
                    try {
                      facts = JSON.parse(current?.facts || "{}");
                    } catch {}
                    const merged = {
                      ...facts,
                      steamTags: enriched.tags || [],
                      steamGenres: enriched.genres || [],
                      steamCategories: enriched.categories || [],
                      steamDescriptionSnippet:
                        enriched.descriptionSnippet ||
                        facts.steamDescriptionSnippet ||
                        "",
                      storePageStatus:
                        enriched.storePageStatus || "appdetails_cn",
                      tagStatus: enriched.tagStatus || "no_gameplay_tags",
                      rejectReasons: enriched.rejectReasons || [],
                    };
                    db.prepare(
                      "UPDATE articles SET game_name=?, image_url=?, facts=?, quality=?, updated_at=datetime('now') WHERE id=?",
                    ).run(
                      enriched.gameName || item.gameName,
                      enriched.imageUrl || item.imageUrl,
                      JSON.stringify(merged),
                      enriched.rejected ? "low_quality" : "ok",
                      id,
                    );
                  } catch {
                    // 详情失败不删除榜单快照；明确标记失败，下一次刷新继续尝试，避免与“确实没有玩法标签”混淆。
                    try {
                      const current = db.prepare("SELECT facts FROM articles WHERE id=?").get(id);
                      const facts = JSON.parse(current?.facts || "{}");
                      db.prepare("UPDATE articles SET facts=?, updated_at=datetime('now') WHERE id=?").run(
                        JSON.stringify({ ...facts, storePageStatus: "fetch_failed", tagStatus: "fetch_failed" }),
                        id,
                      );
                    } catch {}
                  }
                }
              })();
            }
            const items = [...chartItems, ...catalogItems];
            return {
              sourceId: p.id,
              name: p.name,
              urlType,
              count: items.length,
              candidates: items,
            };
          }

          // TapTap 热榜话题也是 SSR/动态入口：普通 fetch 可能只返回壳或侧栏，必须允许动态回退。
          const dynamic =
            urlType === "calendar" ||
            urlType === "upcoming" ||
            urlType === "appCalendar" ||
            urlType === "newDownloads" ||
            urlType === "hashtags" ||
            urlType === "eventReserve";
          const requestPage = async (pageUrl) => {
            // 热榜页 CDN 会返回已过期的 SSR 快照；每次主动刷新都带缓存穿透参数，
            // 但向解析器仍传入原始来源 URL，以便 detail_url 的 item 排名稳定。
            const requestUrl =
              urlType === "hashtags"
                ? `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}_crawl=${Date.now()}`
                : pageUrl;
            const html = await fetchHtml(requestUrl, {
              // 新版本榜是 SSR 分页页，使用浏览器请求头避免拿到空壳。
              dynamic: dynamic,
              headers:
                urlType === "eventReserve"
                  ? {
                      "user-agent": "Mozilla/5.0",
                      accept: "text/html,application/xhtml+xml",
                    }
                  : {},
            });
            return {
              html,
              candidates: parseList(html, { ...p, urlType }, url),
            };
          };
          let { html, candidates } = await requestPage(url);

          if (p.id === "ref-x7" && urlType === "x7") {
            // 小七首屏 SSR 只有 10 条；继续调用公开页面使用的分页接口。
            // 接口可能因站点风控返回空响应，此时保留 SSR 首屏并把原因带回运行结果，
            // 不把失败误判成“没有更多数据”。
            const paged = await fetchReservePages({ maxPages: 12, pageSize: 10 });
            if (paged.items.length) {
              candidates = [...candidates, ...paged.items];
            }
            if (paged.error) {
              for (const candidate of candidates) {
                candidate.facts = { ...(candidate.facts || {}), x7PaginationStatus: "partial", x7PaginationError: paged.error };
              }
            } else {
              for (const candidate of candidates) {
                candidate.facts = { ...(candidate.facts || {}), x7PaginationStatus: "complete" };
              }
            }
          }

          if (["upcoming", "appCalendar"].includes(urlType)) {
            // 官方 calendar API 的首屏默认仅返回 5 个日期；next_page 带游标，
            // 必须连续读取，才能覆盖用户下拉后可见的即将上线/首发项目。
            const apiEndpoint = extractTapTapApiUrl(
              html,
              "calendar/v1/upcoming",
            );
            if (apiEndpoint) {
              const allCandidates = [];
              let pageUrl = apiEndpoint;
              for (let page = 0; page < 12 && pageUrl; page += 1) {
                const payload = await fetchTapTapJson(pageUrl, url);
                if (!payload?.data?.list?.length) break;
                allCandidates.push(
                  ...parseList(JSON.stringify(payload), { ...p, urlType }, url),
                );
                const next = payload?.data?.next_page || "";
                if (!next) {
                  pageUrl = "";
                } else {
                  // next_page 只给分页游标，不重复携带首屏请求中的 X-UA；
                  // 缺少该参数会返回业务错误，表现为永远只有首屏四、五条。
                  const nextUrl = new URL(next, pageUrl);
                  const currentUrl = new URL(pageUrl);
                  for (const key of ["X-UA"]) {
                    if (
                      !nextUrl.searchParams.has(key) &&
                      currentUrl.searchParams.has(key)
                    ) {
                      nextUrl.searchParams.set(
                        key,
                        currentUrl.searchParams.get(key),
                      );
                    }
                  }
                  pageUrl = nextUrl.href;
                }
              }
              if (allCandidates.length) candidates = allCandidates;
            }
          }

          if (urlType === "appCalendar") {
            // “今日游戏”独立使用 event-list：当前日期页同时包含首发、预下载、测试招募，
            // 不是 /upcoming 的 calendar/v1/upcoming 分页接口。
            const apiEndpoint = extractTapTapApiUrl(
              html,
              "calendar/v1/event-list",
            );
            if (apiEndpoint) {
              const payload = await fetchTapTapJson(apiEndpoint, url);
              const calendarCandidates = parseList(
                JSON.stringify(payload || {}),
                { ...p, urlType },
                url,
              );
              if (calendarCandidates.length) candidates = calendarCandidates;
            }
          }

          if (urlType === "eventReserve") {
            // 入口 HTML 只带首屏 10 条；完整榜单由 app-top 接口分页返回。
            // 例如 from=0、10、20...，当前接口 total 通常超过 100 条。
            const apiEndpoint = extractTapTapApiUrl(html, "app-top/v2/hits");
            if (apiEndpoint) {
              const allCandidates = [];
              let total = Number.POSITIVE_INFINITY;
              for (let from = 0; from < total; from += 10) {
                const apiUrl = new URL(apiEndpoint);
                apiUrl.searchParams.set("type_name", "in_app_event_reserve");
                apiUrl.searchParams.set("from", String(from));
                apiUrl.searchParams.set("limit", "10");
                const payload = await fetchTapTapJson(apiUrl.href, url);
                const pageCandidates = parseList(
                  JSON.stringify(payload || {}),
                  { ...p, urlType },
                  url,
                );
                allCandidates.push(...pageCandidates);
                total = Number(payload?.data?.total || allCandidates.length);
                if (!payload?.data?.list?.length) break;
              }
              // 只保留今日至未来 30 天的官方事件；缺少可靠发布时间的不进入详情链路。
              candidates = allCandidates.filter((item) =>
                isWithinNextThirtyDaysTapTap(item.eventReleaseTime),
              );
            }
          }

          if (urlType === "newDownloads") {
            // 新品榜同样由 app-top 接口分页返回。解析器只接受上海时区“当天”
            // released_time 的条目，因此榜单里的历史新品不会混入今日上线。
            const apiEndpoint = extractTapTapApiUrl(html, "app-top/v2/hits");
            if (apiEndpoint) {
              const allCandidates = [];
              let pageUrl = apiEndpoint;
              for (let page = 0; page < 12 && pageUrl; page += 1) {
                const payload = await fetchTapTapJson(pageUrl, url);
                const pageCandidates = parseList(
                  JSON.stringify(payload || {}),
                  { ...p, urlType },
                  url,
                );
                allCandidates.push(...pageCandidates);
                if (!payload?.data?.list?.length) break;
                const next = payload?.data?.next_page || "";
                if (!next) {
                  pageUrl = "";
                } else {
                  const nextUrl = new URL(next, pageUrl);
                  const currentUrl = new URL(pageUrl);
                  // next_page 常省略 X-UA；缺失时 TapTap 会返回 400。
                  if (!nextUrl.searchParams.has("X-UA") && currentUrl.searchParams.has("X-UA")) {
                    nextUrl.searchParams.set("X-UA", currentUrl.searchParams.get("X-UA"));
                  }
                  pageUrl = nextUrl.href;
                }
              }
              candidates = allCandidates;
            }
          }
          if (urlType === "hashtags" && !html.includes("hot-hashtag-item")) {
            // TapTap 热榜 SSR 响应存在缓存/A-B 波动；换查询参数重试一次，不改变来源链接。
            const retryUrl =
              urlType === "eventReserve"
                ? `${url}${url.includes("?") ? "&" : "?"}_crawl=2`
                : `${url}${url.includes("?") ? "&" : "?"}_crawl=${Date.now()}`;
            const retryHtml = await fetchHtml(retryUrl, {
              dynamic: urlType !== "eventReserve",
              headers:
                urlType === "eventReserve"
                  ? {
                      "user-agent": "Mozilla/5.0",
                      accept: "text/html,application/xhtml+xml",
                    }
                  : {},
            });
            candidates = parseList(retryHtml, { ...p, urlType }, url);
            if (!retryHtml.includes("hot-hashtag-item")) {
              const fb = await firecrawlFallback(url);
              if (fb) candidates = parseList(fb, { ...p, urlType }, url);
            }
          }

          if (
            (["upcoming", "appCalendar", "newDownloads", "eventReserve"].includes(urlType)) &&
            !candidates.length
          ) {
            // 即将上线页面存在 SSR/A-B 空壳，空结果时强制换查询参数再取一次。
            const retryValues =
              urlType === "eventReserve" ? [1, 2, 3, 4, 5, 6] : [Date.now()];
            for (const retryValue of retryValues) {
              const retryUrl = `${url}${url.includes("?") ? "&" : "?"}_crawl=${retryValue}`;
              const retryHtml = await fetchHtml(retryUrl, {
                dynamic: urlType !== "eventReserve",
                headers:
                  urlType === "eventReserve"
                    ? {
                        "user-agent": "Mozilla/5.0",
                        accept: "text/html,application/xhtml+xml",
                      }
                    : {},
              });
              candidates = parseList(retryHtml, { ...p, urlType }, url);
              if (candidates.length) break;
            }
            if (!candidates.length) {
              const fb = await firecrawlFallback(url);
              if (fb) candidates = parseList(fb, { ...p, urlType }, url);
            }
          }

          if (!candidates.length && dynamic) {
            const fb = await firecrawlFallback(url);
            if (fb) candidates = parseList(fb, { ...p, urlType }, url);
          }

          const candidateLimit =
            urlType === "hashtags"
              ? 5
              : urlType === "eventReserve"
                ? 200
                : ["upcoming", "appCalendar"].includes(urlType)
                  ? 80
                  : p.id === "ref-haoyou" && urlType === "timeline"
                    ? 120
                    : 60;
          candidates = dedupeByUrl(candidates).slice(0, candidateLimit);
          if (p.id === "ref-taptap" && urlType === "hashtags") {
            // 保留页面原始顺序，同时让前五条拥有可核验的实时热度位置。
            candidates.forEach((candidate, index) => {
              candidate.facts = {
                ...(candidate.facts || {}),
                taptapSource: "hot_hashtags",
                taptapHotRank: index + 1,
              };
            });
          }
          if (p.id === "ref-haoyou" && urlType === "timeline") {
            // 好游“即将上线 + 即将测试”只保留今日及未来 7 天；更新表保持原有今日/未来策略。
            candidates = candidates.filter(
              (item) =>
                item.facts?.haoyouKind === "update" ||
                isHaoyouWithinNextDays(item.dateText, 7),
            );
          }
          // 热榜是当前快照：同一 Moment 重新抓取时需要更新正文、游戏名和首图。
          // 热榜和即将上线都是当前页面快照：允许覆盖同一 App 的旧候选，不能因数据库已有记录而变成 0 条。
          // 好游时间线/热点页是当前快照：重新抓取时需要刷新标题、游戏名和正文状态，
          // 否则适配器规则修正后仍会被历史候选拦截，页面看不到修正结果。
          const isSnapshot =
            ["hashtags", "upcoming", "appCalendar", "newDownloads", "eventReserve"].includes(urlType) ||
            ["ref-haoyou", "ref-gcores", "ref-gamersky", "ref-x7"].includes(p.id);
          if (!isSnapshot) candidates = dedupeAgainstDB(candidates, db);
          for (const a of candidates) {
            a.id = stableId(p.id, a.detailUrl);
          }

          if (p.id === "ref-taptap" && ["upcoming", "appCalendar", "newDownloads"].includes(urlType)) {
            const detailedCandidates = [];
            for (const a of candidates) {
              try {
                const detailHtml = await fetchHtml(a.detailUrl, {
                  dynamic: true,
                });
                const appId = /\/app\/(\d+)/u.exec(a.detailUrl || "")?.[1] || "";
                const tags = [...new Set([...(extractUpcomingTags(detailHtml) || []), ...(await fetchTapTapAppTags(detailHtml, appId))])].slice(0, 20);
                const publisher = extractTapTapPublisher(detailHtml);
                const reviewCount = extractTapTapReviewCount(detailHtml);
                const reserveCount = extractTapTapReserveCount(detailHtml);
                a.facts = {
                  ...(a.facts || {}),
                  ...(publisher ? { taptapPublisher: publisher } : {}),
                  ...(Number.isFinite(reviewCount) ? { taptapReviewCount: reviewCount } : {}),
                  ...(Number.isFinite(reserveCount) ? { taptapReserveCount: reserveCount } : {}),
                  ...(Number.isFinite(extractTapTapFollowerCount(detailHtml)) ? { taptapFollowerCount: extractTapTapFollowerCount(detailHtml) } : {}),
                };
                a.tags = [...new Set([...(a.sourceTags || []), ...tags])].slice(
                  0,
                  8,
                );
                if (hasExcludedTapTapNewGameTag(a.tags)) continue;
                a.tagStatus = a.tags.length ? "available" : "no_gameplay_tags";
                a.tagSource = "taptap_app_page";
                // 即将上线只保留 App 的上线/测试信息，不读取 App 页历史版本。
                a.taptapEvents = [];
                detailedCandidates.push(a);
              } catch {
                a.tags = [...new Set(a.sourceTags || [])].slice(0, 8);
                if (hasExcludedTapTapNewGameTag(a.tags)) continue;
                a.tagStatus = a.tags.length ? "available" : "fetch_failed";
                a.tagSource = "taptap_app_page";
                a.taptapEvents = [];
                detailedCandidates.push(a);
              }
            }
            candidates = detailedCandidates;
          }

          if (p.id === "ref-x7" && urlType === "x7") {
            // 小七只监控预约页中未来 7 天的新游；详情仅补厂商，完整简介由 crawlDetails 写入。
            for (const a of candidates) {
              try {
                const detailHtml = await fetchHtml(a.detailUrl, { dynamic: true });
                const publisher = extractX7Publisher(detailHtml);
                const discount = extractX7Discount(detailHtml);
                if (publisher || discount) a.facts = {
                  ...(a.facts || {}),
                  ...(publisher ? { x7Publisher: publisher } : {}),
                  ...(discount ? { x7Discount: discount } : {}),
                };
              } catch {
                // 列表已包含准确上线时间和标签，单篇详情失败不丢弃新游候选。
              }
            }
          }

          if (p.id === "ref-taptap" && urlType === "eventReserve") {
            const detailCandidates = [];
            for (const a of candidates) {
              try {
                // 直接使用榜单接口返回的 event_id 抓活动详情，不再进入 App 页查找。
                if (!a.eventUrl) continue;
                const event = await fetchTapTapEventDetail(a.eventUrl, {
                  title: a.title.replace(/^《[^》]+》/, "").trim(),
                  summary: a.facts?.taptapCandidateSummary || "",
                  status: a.dateText,
                });
                if (
                  !event ||
                  !(event.fetched || event.summary || event.images?.length)
                )
                  continue;
                if (!isWithinNextThirtyDaysTapTap(a.eventReleaseTime)) continue;
                a.taptapEvents = [
                  {
                    ...event,
                    url: a.eventUrl,
                    status: event.status || a.dateText,
                  },
                ];
                a.paragraphs = event.paragraphs || [];
                a.imageUrl = event.images?.[0]?.url || a.imageUrl;
                a.category =
                  event.kind === "collaboration"
                    ? "联动活动"
                    : event.kind === "activity"
                      ? "活动"
                      : "版本更新";
                // 活动接口返回的标签常是“新副本/新玩法”等事件标签；
                // 飞书与卡片需要展示游戏详情页的真实玩法标签，优先补抓 App 侧栏。
                const appId = /\/app\/(\d+)/u.exec(a.detailUrl || "")?.[1];
                const appUrl = appId ? `https://www.taptap.cn/app/${appId}` : "";
                try {
                  const appHtml = appUrl ? await fetchHtml(appUrl, { dynamic: true }) : "";
                  const appTags = [...new Set([...(extractUpcomingTags(appHtml) || []), ...(await fetchTapTapAppTags(appHtml, appId))])].slice(0, 20);
                  const publisher = extractTapTapPublisher(appHtml);
                  const reviewCount = extractTapTapReviewCount(appHtml);
                  const followerCount = extractTapTapFollowerCount(appHtml);
                  a.facts = {
                    ...(a.facts || {}),
                    ...(publisher ? { taptapPublisher: publisher } : {}),
                    ...(Number.isFinite(reviewCount) ? { taptapReviewCount: reviewCount } : {}),
                    ...(Number.isFinite(followerCount) ? { taptapFollowerCount: followerCount } : {}),
                  };
                  a.tags = appTags.length ? appTags : (a.sourceTags || a.facts?.taptapTags || []);
                  a.tagSource = appTags.length ? "taptap_app_page" : "taptap_event_api";
                } catch {
                  a.tags = a.sourceTags || a.facts?.taptapTags || [];
                  a.tagSource = "taptap_event_api";
                }
                a.tagStatus = a.tags.length ? "available" : "unknown";
                detailCandidates.push(a);
              } catch {
                // 单条详情失败隔离，不阻断其他版本/活动。
              }
            }
            candidates = detailCandidates;
          }

          // 经过榜单/详情补全后再评分，候选阶段可拿到新品榜名次和 IP 预加分。
          for (const a of candidates) {
            a.score = scoreArticle({
              title: a.title,
              detailUrl: a.detailUrl,
              dateText: a.dateText,
              sourceId: p.id,
              gameName: a.gameName,
              facts: a.facts || {},
            });
          }

          const isTapTapSnapshot =
            p.id === "ref-taptap" &&
            ["hashtags", "upcoming", "appCalendar", "newDownloads", "eventReserve"].includes(urlType);
          const isTapTapListSnapshot =
            p.id === "ref-taptap" && ["hashtags", "upcoming", "appCalendar", "newDownloads"].includes(urlType);
          // 即将上线/新品榜需要等待详情补全；热榜本身已在列表中拿到标题、简介和首图，
          // 不能在 ON CONFLICT 时又被统一覆盖回 pending。
          const pendingTapTapListSnapshot =
            p.id === "ref-taptap" && ["upcoming", "appCalendar", "newDownloads"].includes(urlType);
          const pendingListSnapshot = pendingTapTapListSnapshot || (p.id === "ref-x7" && urlType === "x7");
          const stmt = db.prepare(
            `INSERT INTO articles (id,source_id,source_name,title,game_name,category,detail_url,image_url,date_text,score,paragraphs,facts,quality,discovered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(id) DO UPDATE SET title=excluded.title, game_name=excluded.game_name, category=excluded.category, image_url=excluded.image_url, date_text=excluded.date_text, score=excluded.score, paragraphs=excluded.paragraphs, facts=excluded.facts, quality=${pendingListSnapshot ? "'pending'" : "excluded.quality"}, discovered_at=datetime('now'), updated_at=datetime('now')`,
          );
          for (const a of candidates) {
            const isTapTapHotSnapshot =
              p.id === "ref-taptap" &&
              /\/forum\/hot\/hashtags\?item=\d+/.test(a.detailUrl || "");
            const facts =
              p.id === "ref-taptap" &&
              ["hashtags", "upcoming", "appCalendar", "newDownloads", "eventReserve"].includes(urlType)
                ? {
                    ...(a.facts || {}),
                    taptapTags: a.tags || [],
                    tagStatus: a.tagStatus || "fetch_failed",
                    tagSource: a.tagSource || "taptap_event_api",
                    taptapEvents: a.taptapEvents || [],
                    // 热榜的正文摘要就在列表元素里，不能等详情阶段再取。
                    taptapHotDescription: isTapTapHotSnapshot
                      ? String((a.paragraphs || []).find(Boolean) || "").trim()
                      : "",
                  }
                : p.id === "ref-haoyou" || p.id === "ref-x7"
                  ? a.facts || {}
                  : {};
            const quality = isTapTapHotSnapshot
              ? ((a.paragraphs || []).some(Boolean) ? "ok" : "needs_review")
              : isTapTapListSnapshot || (p.id === "ref-x7" && urlType === "x7")
                ? "pending"
                : "ok";
            stmt.run(
              a.id,
              p.id,
              p.name,
              a.title,
              a.gameName,
              a.category,
              a.detailUrl,
              a.imageUrl,
              a.dateText,
              a.score,
              JSON.stringify(a.paragraphs || []),
              JSON.stringify(facts),
              quality,
            );
          }
          return {
            sourceId: p.id,
            name: p.name,
            urlType,
            count: candidates.length,
            candidates,
          };
        } catch (e) {
          return {
            sourceId: p.id,
            name: p.name,
            urlType,
            count: 0,
            error: e.message,
          };
        }
      });
      onProgress?.({
        sourceId: p.id,
        sourceName: p.name,
        urlType,
        status: result.error ? "failed" : "completed",
        count: result.count || 0,
        error: result.error || "",
      });
      allResults.push(result);
    }
  }
  return allResults;
}

export async function crawlDetails(articleIds) {
  assertCrawlerActive();
  const batchId = `detail-${Date.now()}`;
  if (!Array.isArray(articleIds) || !articleIds.length)
    return { batchId, articles: [] };

  const ids = articleIds.map((a) =>
    typeof a === "string" ? a : a.id || a.candidateId || "",
  );
  const articles = ids
    .map((id) => db.prepare("SELECT * FROM articles WHERE id = ?").get(id))
    .filter(Boolean);
  if (!articles.length) return { batchId, articles: [] };

  // 热榜 `?item=n` 用于固定保存页面名次，并不是真实详情地址。
  // 候选阶段已经取得标题、简介和首图，禁止详情抓取把它覆盖成空内容/失败。
  const hotTopicSnapshots = articles
    .filter((article) => article.source_id === "ref-taptap" && /\/forum\/hot\/hashtags\?item=\d+/.test(article.detail_url || ""))
    .map((article) => ({ ...article, _ok: true, _skipped: true, skipReason: "热榜列表快照已包含标题、简介与首图" }));
  const detailArticles = articles.filter((article) => !hotTopicSnapshots.some((snapshot) => snapshot.id === article.id));

  // 详情抓取按“标准化游戏名 + 标题”跨平台去重。TapTap 的详情通常比好游快爆完整，
  // 同批重复内容优先保留 TapTap；数据库已有可用正文时直接复用，不再发起联网请求。
  const sourcePriority = { "ref-taptap": 30, "ref-haoyou": 20, "ref-gcores": 15, "ref-gamersky": 15, "ref-steam": 10 };
  const completedRows = db.prepare("SELECT id,game_name,title,paragraphs,quality FROM articles WHERE quality IN ('ok','verified') AND paragraphs IS NOT NULL AND paragraphs <> '[]'").all();
  const completedByKey = new Map();
  for (const row of completedRows) {
    const key = contentDedupeKey(row);
    if (!key) continue;
    const idsForKey = completedByKey.get(key) || new Set();
    idsForKey.add(row.id);
    completedByKey.set(key, idsForKey);
  }
  const firstByKey = new Map();
  const skipped = [];
  const detailTargets = [...detailArticles]
    .sort((left, right) => (sourcePriority[right.source_id] || 0) - (sourcePriority[left.source_id] || 0))
    .filter((article) => {
      const key = contentDedupeKey(article);
      const existingIds = key ? completedByKey.get(key) : null;
      if (existingIds && [...existingIds].some((id) => id !== article.id)) {
        skipped.push({ ...article, _ok: true, _skipped: true, skipReason: "已复用同游戏同标题的完整详情" });
        return false;
      }
      if (key && firstByKey.has(key)) {
        skipped.push({ ...article, _ok: true, _skipped: true, skipReason: "同批次重复内容" });
        return false;
      }
      if (key) firstByKey.set(key, article.id);
      return true;
    });

  const results = await Promise.all(
    detailTargets.map((a) =>
      crawlTask(`detail:${batchId}:${a.detail_url}`, async () => {
        try {
          let html = "";
          try {
            html = await fetchHtml(a.detail_url);
          } catch (error) {
            // 好游热点文章常对普通请求返回 403；详情页允许使用 Firecrawl 作为回退。
            html = await firecrawlFallback(a.detail_url);
            if (!html) throw error;
          }
          let detail = parseDetail(html, {
            url: a.detail_url,
            gameName: a.game_name,
            category: a.category,
          });

          // 好游快爆的上线/测试页正文往往只有一句简介；优先沿用 game-warm
          // 中的“游戏首曝/官方资讯”论坛链接，获取可阅读的图文快讯。
          if (
            a.source_id === "ref-haoyou" &&
            ["新游上线", "测试公测"].includes(a.category)
          ) {
            const warmDetail = await fetchHaoyouWarmDetail(
              html,
              a.detail_url,
              a.game_name,
            );
            if (warmDetail) {
              detail = {
                ...detail,
                ...warmDetail,
                facts: { ...(detail.facts || {}), ...(warmDetail.facts || {}) },
              };
            }
          }

          // 机核正文图片使用公开 GAPI 的 Draft.js entityMap，普通 HTML 只会给图片占位符。
          // 接口失败时保留 HTML 解析结果，不能让单篇图片增强阻断正文抓取。
          if (a.source_id === "ref-gcores") {
            const gcoresArticle = await fetchGcoresArticle(a.detail_url);
            const gcoresDetail = gcoresArticle
              ? parseGcoresApiDetail(gcoresArticle, {
                  url: a.detail_url,
                  gameName: a.game_name,
                  fallbackTitle: detail.title || a.title,
                })
              : null;
            if (gcoresDetail?.paragraphs?.length) detail = gcoresDetail;
          }

          // 小七详情页有少数游戏只有占位介绍；保留列表页已确认的上线状态，
          // 避免详情覆盖后变成空正文并被飞书新游完整性过滤掉。
          if (a.source_id === "ref-x7" && !detail.paragraphs?.length) {
            let x7Facts = {};
            try { x7Facts = JSON.parse(a.facts || "{}"); } catch {}
            if (x7Facts.x7LaunchStatus) {
              detail = {
                ...detail,
                paragraphs: [x7Facts.x7LaunchStatus],
                quality: "ok",
                facts: { ...(detail.facts || {}), x7Intro: "" },
              };
            }
          }

          if (a.source_id === "ref-x7") {
            const discount = extractX7Discount(html);
            const reserveCount = extractX7ReserveCount(html);
            if (discount || reserveCount) {
              detail.facts = {
                ...(detail.facts || {}),
                ...(discount ? { x7Discount: discount } : {}),
                ...(reserveCount ? { x7ReserveCount: reserveCount } : {}),
              };
            }
          }

          // TapTap App 页的“游戏介绍”经常是折叠内容，SSR HTML 只给摘要。
          // 页面会请求官方 information 接口；优先读取完整介绍，等价于展开“游戏介绍”抽屉后的正文。
          const fullIntroduction = await fetchTapTapFullIntroduction(
            html,
            a.detail_url,
          );
          if (fullIntroduction.length) {
            detail = { ...detail, paragraphs: fullIntroduction, quality: "ok" };
          }

          let existingFacts = {};
          try {
            existingFacts = JSON.parse(a.facts || "{}");
          } catch {}
          const taptapEvents = existingFacts.taptapEvents || [];
          if (a.source_id === "ref-taptap" && taptapEvents.length) {
            const eventParagraphs = taptapEvents
              .flatMap((event) => [
                event.title ? `【${event.title}】` : "",
                event.status ? `时间：${event.status}` : "",
                ...(event.paragraphs || []),
              ])
              .filter(Boolean);
            const eventImages = taptapEvents.flatMap(
              (event) => event.images || [],
            );
            if (eventParagraphs.length)
              detail = {
                ...detail,
                paragraphs: eventParagraphs,
                images: eventImages,
                quality: "ok",
              };
          }

          // TapTap 动态页经常返回空壳：无正文时也走 Firecrawl 回退，不能只判断旧的 low_quality 标记。
          if (
            detail.quality === "low_quality" ||
            detail.quality === "low" ||
            !detail.paragraphs?.length
          ) {
            const fb = await firecrawlFallback(a.detail_url);
            if (fb)
              detail = parseDetail(fb, {
                url: a.detail_url,
                gameName: a.game_name,
                category: a.category,
              });
          }

          // 官方资讯的验收标准比普通候选严格：必须同时有可阅读正文和原始图文布局。
          // 否则不能以 ok 落库并在下一轮被当作“已完成”，而应标记失败后允许重试。
          if (["ref-gcores", "ref-gamersky"].includes(a.source_id)) {
            const editorialLayout = a.source_id === "ref-gcores"
              ? detail.facts?.gcoresLayout
              : detail.facts?.gamerskyLayout;
            if (!detail.paragraphs?.length || !Array.isArray(editorialLayout) || !editorialLayout.length) {
              throw new Error("官方资讯正文或图文布局获取失败，等待下次重试");
            }
          }

          // 封面也进入图片下载队列：详情正文没有图时，卡片仍可稳定使用原列表封面。
          const imageCandidates = [
            ...(Array.isArray(detail.images) ? detail.images : []),
            ...(a.image_url ? [{ url: a.image_url, alt: a.game_name || a.title || "游戏封面" }] : []),
          ].filter((image, index, list) =>
            image?.url && list.findIndex((item) => item?.url === image.url) === index,
          );
          // 图片只保存原站 URL；不再生成 data/crawler 本地图片缓存。
          const images = imageCandidates.map((image, index) => ({
            id: `${a.id}-image-${index + 1}`,
            src: image.url,
            url: image.url,
            originalUrl: image.url,
            alt: image.alt || a.game_name || a.title || "游戏图片",
            type: index === 0 ? "cover_candidate" : "body_candidate",
          }));
          const detailFacts = { ...existingFacts, ...(detail.facts || {}) };
          // 旧版本曾把好游快爆游戏页的整段历史图片布局写入 facts。
          // 详情刷新采用合并写入，若不显式删除，解析器即使不再返回该字段也会继续残留。
          // `haoyouKind=update` 的正文只允许保留当前第一条动态和列表封面。
          if (a.source_id === "ref-haoyou" && existingFacts.haoyouKind === "update") {
            delete detailFacts.haoyouLayout;
          }
          if (a.source_id === "ref-haoyou" && Array.isArray(detailFacts.haoyouLayout)) {
            detailFacts.haoyouLayout = localizeHaoyouLayout(
              detailFacts.haoyouLayout,
              images,
            );
          }
          db.prepare(
            `UPDATE articles SET title=CASE WHEN source_id='ref-haoyou' AND ? <> '' THEN ? ELSE title END, paragraphs=?, facts=?, images_json=?, image_url=COALESCE(NULLIF(image_url,''),?), quality=?, game_match=?, diagnostic=?, updated_at=datetime('now') WHERE id=?`,
          ).run(
            detail.title || "",
            detail.title || "",
            JSON.stringify(detail.paragraphs),
            JSON.stringify(detailFacts),
            JSON.stringify(images),
            images[0]?.src || images[0]?.url || "",
            detail.quality,
            detail.gameMatch,
            JSON.stringify({ pc: detail.paragraphs.length, ic: images.length }),
            a.id,
          );

          return { ...a, ...detail, images, _ok: true };
        } catch (e) {
          db.prepare(
            `UPDATE articles SET quality='failed', diagnostic=?, updated_at=datetime('now') WHERE id=?`,
          ).run(JSON.stringify({ error: e.message }), a.id);
          return { ...a, quality: "failed", error: e.message, _ok: false };
        }
      }),
    ),
  );

  // Per-platform 统计
  const stats = {};
  for (const r of [...results, ...skipped, ...hotTopicSnapshots]) {
    const key = r.source_name || r.source_id || "未知";
    if (!stats[key])
      stats[key] = {
        sourceId: r.source_id,
        sourceName: r.source_name,
        successCount: 0,
        failCount: 0,
        errors: [],
      };
    if (r._ok && !r._skipped) stats[key].successCount++;
    else if (r._skipped) continue;
    else {
      stats[key].failCount++;
      stats[key].errors.push(r.error || "未知错误");
    }
  }
  const perPlatform = Object.values(stats);
  for (const s of perPlatform) {
    console.log(
      `[crawlDetails] ${s.sourceName}: ${s.successCount}篇成功 ${s.failCount}篇失败`,
    );
  }

  return { batchId, articles: [...results, ...skipped, ...hotTopicSnapshots], perPlatform, skippedCount: skipped.length + hotTopicSnapshots.length };
}

/** 只读取详情页面做数量估算，不写库、不下载图片。 */
export async function estimateDetails(articleIds) {
  assertCrawlerActive();
  if (!Array.isArray(articleIds) || !articleIds.length)
    return { estimates: [] };

  const ids = articleIds.map((a) =>
    typeof a === "string" ? a : a.id || a.candidateId || "",
  );
  const articles = ids
    .map((id) =>
      db
        .prepare("SELECT id,title,detail_url FROM articles WHERE id = ?")
        .get(id),
    )
    .filter(Boolean);
  const estimates = await Promise.all(
    articles.map((a) =>
      crawlTask(`estimate:${a.detail_url}`, async () => {
        try {
          const html = await fetchHtml(a.detail_url);
          const detail = parseDetail(html, {
            url: a.detail_url,
            gameName: "",
            category: "",
          });
          const textCharacters = detail.paragraphs.join("").length;
          return {
            id: a.id,
            title: a.title,
            ok: true,
            textCharacters,
            paragraphCount: detail.paragraphs.length,
            imageCount: detail.images.length,
          };
        } catch (e) {
          return {
            id: a.id,
            title: a.title,
            ok: false,
            textCharacters: 0,
            paragraphCount: 0,
            imageCount: 0,
            error: e.message,
          };
        }
      }),
    ),
  );

  return {
    estimates,
    totals: estimates.reduce(
      (sum, item) => ({
        textCharacters: sum.textCharacters + item.textCharacters,
        paragraphCount: sum.paragraphCount + item.paragraphCount,
        imageCount: sum.imageCount + item.imageCount,
      }),
      { textCharacters: 0, paragraphCount: 0, imageCount: 0 },
    ),
  };
}
