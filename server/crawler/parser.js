import * as cheerio from "cheerio";
import { scoreArticle } from "./scorer.js";
import { contentFilter as haoyouFilter, extractGameName as extractHaoyouGameName, filterGameplayTags as filterHaoyouTags, cleanTimelineDate, cleanTimelineSummary, cleanDetailTitle, cleanUpdateTitle, parseCurrentUpdate, isWithinNextDays, extractHaoyouFollowerCount, extractHaoyouPublisher, extractHaoyouReviewCount, extractHaoyouReserveCount } from "./platforms/haoyou.js";
import { contentFilter as taptapFilter, hashtagFilter as taptapHashtagFilter, hotTopicFilter as taptapHotTopicFilter, extractTapTapFollowerCount, extractTapTapPublisher, extractTapTapReviewCount, extractTapTapReserveCount } from "./platforms/taptap.js";
import { contentFilter as jiuyouFilter } from "./platforms/ninegame.js";
import { contentFilter as gamerskyFilter, cleanTitle as cleanGamerskyTitle, extractGameName as extractGamerskyGameName } from "./platforms/gamersky.js";
import { contentFilter as gcoresFilter, cleanTitle as cleanGcoresTitle, extractGameName as extractGcoresGameName } from "./platforms/gcores.js";
import { contentFilter as ali213Filter } from "./platforms/ali213.js";
import { contentFilter as steamFilter } from "./platforms/steam.js";
import { parseList as parseX7List, parseDetail as parseX7Detail } from "./platforms/x7.js";

const NOISE_TITLE = /下载客户端|首页|攻略|礼包|论坛|登录|注册|排行榜|专题页|邀请码|兑换码|进群|加群|求助|组队|VIP|会员|充值|付费/;
const LOW_CONTENT = /夏促|特卖|特惠|折扣|限时|免单|红包|福袋|直播中|签到|每日任务|新手福利/;
const DETAIL_NOISE = /下载客户端|关注公众号|扫码|二维码|相关推荐|本文由|责任编辑|编辑[：:]|t\d+_\d+-t\d+_\d+:\d+\.\d+|t2631_|关于我们|网站地图|玩家客服|帐号申诉|开放平台|廉正举报|成长关爱|送\d+限时|云游戏平台/;

function cleanText(s) { return String(s||"").replace(/\s+/g," ").trim(); }
function resolveUrl(href, base) { try { return new URL(href, base).href } catch { return "" } }

function isCurrentOrFutureReserveDate(value = "") {
  const text = cleanText(value);
  if (!text || /昨天|前天|\d+\s*天前|已上线|已更新/.test(text)) return false;
  if (/今天|明天|后天/.test(text)) return true;
  const match = /(\d{1,2})月(\d{1,2})日/.exec(text);
  if (!match) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]));
  return target.getTime() >= today.getTime();
}

function formatNewsDate(date) {
  const pad = value => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isTodayOrFutureNewsDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date.getTime() >= today.getTime();
}

function parseGcoresListDate(value = "") {
  const text = cleanText(value);
  const now = new Date();
  if (/刚刚/.test(text)) return now;
  const min = /(\d+)\s*分钟前/.exec(text);
  if (min) return new Date(now.getTime() - Number(min[1]) * 60 * 1000);
  const hour = /(\d+)\s*小时前/.exec(text);
  if (hour) return new Date(now.getTime() - Number(hour[1]) * 3600 * 1000);
  const day = /(\d+)\s*天前/.exec(text);
  if (day) return new Date(now.getTime() - Number(day[1]) * 86400 * 1000);
  return null;
}

function parseGamerskyListDate(value = "") {
  const match = /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(cleanText(value));
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])) : null;
}

export function parseList(html, platform, baseUrl) {
  const urlType = platform.urlType || "default";
  const $ = cheerio.load(html);
  const seen = new Set();
  const articles = [];

  function payloadText(value = "") {
    return String(value)
      .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\(["\\/])/g, "$1");
  }

  // 根据页面类型选择提取策略
  const extractors = {
    // 小七预约页：SSR payload 中直接提供未来上线游戏，平台只进入“新游”链路。
    x7: () => {
      for (const item of parseX7List(html, baseUrl)) {
        if (seen.has(item.detailUrl)) continue;
        addArticle(
          item.title,
          item.detailUrl,
          item.imageUrl,
          item.dateText,
          item.gameName,
          item.paragraphs?.[0] || "",
          item.sourceTags || [],
        );
        const current = articles[articles.length - 1];
        current.category = "新游上线";
        current.eventReleaseTime = item.eventReleaseTime;
        current.facts = item.facts || {};
      }
    },
    // 好游快爆热点：提取 bbs.3839.com/thread-{id}.htm
    rdzx: () => {
      $("a[href*=thread]").each((_, el) => {
        const href = ($(el).attr("href")||"").trim();
        let title = cleanText($(el).text() || $(el).attr("title") || "");
        if (!title || title.length < 8) return;
        const detailUrl = resolveUrl(href, "https://bbs.3839.com/");
        if (!detailUrl || seen.has(detailUrl)) return;
        if (/日本男子|去世|黑客|假扮|马斯克|网恋|东野圭吾/.test(title)) return;
        if (!haoyouFilter(title)) return;
        addArticle(title, detailUrl, "", extractDate($(el)), extractHaoyouGameName(title));
      });
    },
    // 好游快爆社区
    bbs: () => {
      $("a[href*=forum]").each((_, el) => {
        const href = ($(el).attr("href")||"").trim();
        let title = cleanText($(el).text());
        if (!title || title.length < 4) return;
        const detailUrl = resolveUrl(href, "https://bbs.3839.com/");
        if (!detailUrl || seen.has(detailUrl)) return;
        addArticle(title + " 论坛板块", detailUrl);
      });
    },
    // 好游快爆时间线
    timeline: () => {
      // 页面有四个并行面板：全部、即将上线、即将测试、即将更新。
      // 只读取后三个面板，并只保留 rel=now/tomorrow 的日期卡片。
      // 以页面顶部 panelTab 的 rel 值作为栏目真源，不依赖“第几个面板”猜测分类。
      // rel=1 即将上线、rel=2 即将测试、rel=3 即将更新。
      const timelineKinds = { 1: "upcoming", 2: "test", 3: "update" };
      const timelineTabRels = $("#panelTab > li").map((_, tab) => Number($(tab).attr("rel"))).get();
      $(".panelList > .foreArea").each((panelIndex, panel) => {
        const kind = timelineKinds[timelineTabRels[panelIndex]];
        if (!kind) return;
        $(panel).find(".foreCard").filter((_, card) => ["now", "tomorrow"].includes($(card).attr("rel"))).each((_, card) => {
            const group = $(card);
            const dateText = cleanTimelineDate(cleanText(group.find(".foreCard-hd").first().text()));
          if (!isWithinNextDays(dateText, 7)) return;
          group.find("ul.foreList > li").each((__, li) => {
            const item = $(li);
            const link = item.children("a[href]").first();
            const detailUrl = resolveUrl(link.attr("href") || "", baseUrl);
            const gameName = extractHaoyouGameName(cleanText(item.find(".name em").first().text()));
            const tags = filterHaoyouTags(item.find(".tags .it").map((___, tag) => cleanText($(tag).text())).get());
            const score = cleanText(item.find(".info .score").first().text());
            const info = cleanTimelineSummary(
              cleanText(item.find(".info").first().text()).replace(score, "").trim(),
            );
            if (!gameName || !detailUrl || !/3839\.com\/a\/\d+\.htm/.test(detailUrl)) return;
            if (seen.has(detailUrl)) return;
            // 更新卡片已经单独展示游戏名，标题只保留更新事件本身，避免出现“游戏名 + 《游戏名》更新标题”的重复。
            const title = kind === "update"
              ? (info || "即将更新")
              : `《${gameName}》${info ? ` ${info}` : kind === "test" ? " 即将测试" : " 即将上线"}`;
            const imageNode = item.find(".img img").first();
            const rawImageUrl = imageNode.attr("data-src") || imageNode.attr("src") || imageNode.attr("lz_src") || "";
            const imageUrl = rawImageUrl ? resolveUrl(rawImageUrl, baseUrl) : "";
            const category = kind === "update" ? "版本更新" : kind === "test" ? "测试公测" : "新游上线";
            // 标签仅作为结构化字段保存；正文不再拼入“标签：…”或“下载”按钮文案。
            addArticle(title, detailUrl, imageUrl, dateText, gameName, info, tags);
            articles[articles.length - 1].category = category;
            articles[articles.length - 1].facts = {
              haoyouKind: kind,
              haoyouTimelineTab: kind === "update" ? "即将更新" : kind === "test" ? "即将测试" : "即将上线",
              haoyouTags: tags,
              timelineDate: dateText,
              score,
            };
          });
        });
      });
    },
    // TapTap 论坛
    forum: () => {
      const filter = ADAPTERS["ref-taptap"]?.contentFilter;
      $("a[href]").each((_, el) => {
        const href = ($(el).attr("href")||"").trim();
        let title = cleanText($(el).find(".moment-article__summary--title,[itemprop='name']").first().text() || $(el).attr("title") || $(el).text() || "");
        if (!title || title.length < 10) return;
        if (filter && !filter(title)) return;
        const card = $(el).parents(".moment-feed-list-item,.moment-card").first();
        const author = cleanText(card.find(".user-name,.user-name__text,[itemprop='author']").first().text());
        const honor = cleanText(card.find(".user-name__honor-title,.user-name__honor-title-wrapper").first().text());
        // 热门论坛里大量是普通创作者/玩家发帖；只保留官方、制作组、发行商等可作为资讯源的动态。
        if (/创作者|玩家|普通用户/.test(`${author} ${honor}`) && !/官方|制作组|工作室|发行商/.test(`${author} ${honor}`)) return;
        const detailUrl = resolveUrl(href, baseUrl);
        if (!detailUrl || seen.has(detailUrl) || !detailUrl.includes("taptap.cn") || !/\/moment\/\d+/.test(new URL(detailUrl).pathname)) return;
        addArticle(title, detailUrl);
      });
    },
    hashtags: () => {
      // TapTap 热榜专用列表：不筛选，按页面顺序直接取前5项。
      const hotItems = $(".hot-hashtag-item");
      if (hotItems.length) {
        hotItems.slice(0, 5).each((index, el) => {
          const item = $(el);
          const title = cleanText(item.find(".hot-hashtag-item__title").first().text());
          const gameName = cleanText(item.find(".hot-hashtag-item__app").first().text());
          const body = cleanText(item.find(".hot-hashtag-item__description").first().text());
          const imageNode = item.find(".hot-hashtag-item__cover img,img").first();
          const imageUrl = resolveUrl(imageNode.attr("data-src") || imageNode.attr("src") || "", baseUrl);
          const detailUrl = `${baseUrl.split("#")[0].split("?")[0]}?item=${index + 1}`;
          addArticle(title, detailUrl, imageUrl, "", gameName, body);
        });
        return;
      }

      // 热榜动态常只存在于 Nuxt SSR payload，DOM 没有可选中的卡片。
      const momentPattern = /(?:https?:\/\/www\.taptap\.cn)?(?:\\\/|\/)moment(?:\\\/|\/)(\d+)/g;
      let match;
      while ((match = momentPattern.exec(html))) {
        const detailUrl = `https://www.taptap.cn/moment/${match[1]}`;
        const chunk = html.slice(match.index, match.index + 1600);
        const strings = [...chunk.matchAll(/["']((?:\\.|[^"']){4,240})["']/g)]
          .map(item => cleanText(payloadText(item[1])))
          .filter(Boolean);
        const body = strings.find(value => value.length >= 20 && !/^https?:/i.test(value)) || "";
        const titleCandidate = strings.find(value => value.length >= 8 && value !== body && !/^https?:/i.test(value)) || "";
        const title = /^(page_view|topicDetail|message_params|normal_hashtags|identification|obj_type|uri|params)$/i.test(titleCandidate)
          ? body.slice(0, 72)
          : (titleCandidate || body.slice(0, 72));
        if (!title || !taptapHotTopicFilter(title, body, "", "") || seen.has(detailUrl)) continue;
        addArticle(title, detailUrl, "", "", "", body);
      }

      $("a[href*=\"/moment/\"]").each((_, el) => {
        const href = ($(el).attr("href") || "").trim();
        const scope = $(el).closest(".moment-article");
        const article = $(el).closest(".moment-feed-list-item,.moment-card");
        const contentScope = scope.length ? scope : (article.length ? article : $(el).parent());
        const title = cleanText(contentScope.find(".moment-article__summary--title,[itemprop='name'],h1,h2,h3").first().text() || $(el).attr("title") || $(el).text());
        const body = cleanText(contentScope.find(".moment-article__summary--content,[itemprop='text'],.tap-rich-content__wrapper,.content").first().text());
        const author = cleanText(article.find(".user-name,.user-name__text,[itemprop='author']").first().text());
        const honor = cleanText(article.find(".user-name__honor-title,.user-name__honor-title-wrapper").first().text());
        const group = cleanText(article.find(".moment-card-footer__group-text,.moment-card__footer,.app-name,[itemprop='isPartOf']").first().text());
        const gameLink = article.find("a[href*='/app/']").first();
        const linkedGameName = cleanText(gameLink.find("[itemprop='name'],.app-name,.name,.title").first().text() || gameLink.attr("title") || gameLink.text());
        const gameName = linkedGameName || inferHotGameName(title, body);
        if (!href || !taptapHotTopicFilter(title, body, gameName, group)) return;
        const detailUrl = resolveUrl(href, baseUrl);
        if (!detailUrl || seen.has(detailUrl)) return;
        const imageNode = contentScope.find(".moment-article__image-list img,img").first();
        const imageUrl = resolveUrl(imageNode.attr("data-src") || imageNode.attr("src") || "", baseUrl);
        addArticle(title, detailUrl, imageUrl, "", gameName, body);
      });
    },
    // TapTap 新版本预约榜：只读取 ranking-card，不读取 App 详情页的历史版本列表。
    eventReserve: () => {
      // 完整榜单由 app-top 接口返回；允许 tasks.js 将接口 JSON 直接交给这里，
      // 避免依赖分页 HTML 的 SSR/A-B 结果。
      if (/^\s*\{/.test(html)) {
        try {
          const payload = JSON.parse(html);
          for (const item of payload?.data?.list || []) {
            const event = item?.in_app_event || {};
            const app = event?.app_card || {};
            const gameName = cleanText(app.title);
            const eventTitle = cleanText(event.title);
            const appId = Number(app.id || 0);
            if (!gameName || !eventTitle || !appId) continue;
            const detailUrl = `https://www.taptap.cn/app/${appId}/game-event?os=android`;
            if (seen.has(detailUrl)) continue;
            const imageUrl = resolveUrl(event.banner?.url || app.icon?.url || "", baseUrl);
            const releaseTime = Number(event.release_time || 0);
            const dateText = releaseTime
              ? (() => { const d = new Date(releaseTime * 1000); const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d); const get = key => parts.find(item => item.type === key)?.value || ""; return `${get("month")}月${get("day")}日 ${get("hour")}:${get("minute")}`; })()
              : "";
            const tags = (event.tags || []).map(tag => cleanText(tag?.label || tag?.value || tag)).filter(Boolean);
            const content = [event.whatsnew || event.intro, tags.length ? `标签：${tags.join(" / ")}` : "", event.stat?.reserve_count ? `${event.stat.reserve_count}预约` : ""].filter(Boolean).join("；");
            addArticle(`《${gameName}》${eventTitle}`, detailUrl, imageUrl, dateText, gameName, content, tags);
            articles[articles.length - 1].eventUrl = event.id ? `https://www.taptap.cn/game-event/${event.id}` : "";
            articles[articles.length - 1].eventReleaseTime = releaseTime;
            articles[articles.length - 1].facts = { taptapEventId: event.id || 0, taptapEventStatus: event.status, releaseTime, taptapTags: tags, taptapCandidateSummary: event.whatsnew || event.intro || "" };
          }
          return;
        } catch { /* 非 JSON 时继续走 HTML 解析 */ }
      }
      $("a[href^=\"/app/\"]").filter((_, el) => String($(el).attr("href") || "").includes("/game-event")).each((_, el) => {
        const card = $(el);
        const href = card.attr("href") || "";
        const gameName = cleanText(card.find(".ranking-card__title").first().text());
        const version = cleanText(card.find(".ranking-card__version-description").first().text());
        const updateInfo = cleanText(card.find(".ranking-card__update-info").first().text());
        const reserveCount = cleanText(card.find(".ranking-card__reserve-count").first().text());
        const platform = cleanText(card.find(".ranking-card__platform-tag").first().text());
        // 预约榜卡片的“更新时间”是榜单更新时间，不是活动上线时间；不能据此过滤整张卡。
        // 真正的“今日及未来”过滤在读取 App 页“新版本”事件后，依据 event.status 执行。
        if (!gameName || !version || /历史|旧版|已结束|已上线/.test(`${version} ${updateInfo}`)) return;
        const detailUrl = resolveUrl(href, baseUrl);
        if (!detailUrl || seen.has(detailUrl)) return;
        const imageNode = card.find(".ranking-card__icon img").first();
        const imageUrl = resolveUrl(imageNode.attr("data-src") || imageNode.attr("src") || "", baseUrl);
        const content = [version, platform, updateInfo, reserveCount].filter(Boolean).join("；");
        addArticle(`《${gameName}》${version}`, detailUrl, imageUrl, updateInfo, gameName, content);
      });
    },
    // TapTap 日历/即将上线
    calendar: () => {
      // /upcoming 首屏 SSR 只渲染少量日期卡片；tasks.js 会继续请求官方
      // calendar API 分页，并把 JSON 原样交给这里。不能只依赖 upcoming-item DOM。
      if (/^\s*\{/.test(html)) {
        try {
          const payload = JSON.parse(html);
          const formatTime = (seconds) => {
            const value = Number(seconds || 0);
            if (!value) return "";
            const date = new Date(value * 1000);
            return new Intl.DateTimeFormat("zh-CN", {
              timeZone: "Asia/Shanghai", month: "numeric", day: "numeric",
              hour: "2-digit", minute: "2-digit", hour12: false,
            }).format(date).replace(/\//g, "月").replace(/ (\d{2}:\d{2})$/, "日 $1");
          };
          const calendarGroups = Array.isArray(payload?.data?.list)
            ? payload.data.list
            : ["list_a", "list_b", "list_c", "list_d"]
                .map((key) => payload?.data?.[key])
                .filter(Array.isArray)
                .map((list) => ({ list }));
          for (const group of calendarGroups) {
            for (const eventItem of group?.list || []) {
              const app = eventItem?.app_card_info || eventItem?.app_card || {};
              const name = cleanText(app.title || "");
              const appId = Number(app.id || eventItem.game_id || 0);
              const event = cleanText(eventItem.sub_event_type_title || eventItem.event_type_title || "近期上线");
              if (!name || !appId || /新版本|版本更新|更新|活动|联动|合作|周年庆|赛季/.test(event)) continue;
              const detailUrl = `https://www.taptap.cn/app/${appId}`;
              if (seen.has(detailUrl)) continue;
              const startTime = Number(eventItem.start_time || group.day || 0);
              const tags = (app.tags || []).map(tag => cleanText(tag?.value || tag?.label || tag?.name || tag)).filter(Boolean);
              const hints = Array.isArray(app.hints) ? app.hints.map(cleanText).filter(Boolean).join(" / ") : cleanText(app.hints || "");
              const description = cleanText(app.rec_text || app.description?.text || "");
              // 即将上线卡片应优先使用游戏 Icon：列表 banner 多为横幅，无法作为小型游戏卡片完整展示。
              const imageUrl = resolveUrl(app.icon?.url || app.icon?.original_url || eventItem.banner?.url || app.banner?.url || app.ad_banner?.url || "", baseUrl);
              const rawEventUrl = [eventItem.event_url, eventItem.jump_url, eventItem.url, eventItem.event?.url]
                .find((value) => typeof value === "string" && value.trim());
              const taptapOriginalUrl = rawEventUrl ? resolveUrl(rawEventUrl, baseUrl) : detailUrl;
              const dateText = [formatTime(startTime), event].filter(Boolean).join(" ");
              const content = [event, hints, description].filter(Boolean).join("；");
              addArticle(`《${name}》${event}`, detailUrl, imageUrl, dateText, name, content, tags);
              articles[articles.length - 1].eventReleaseTime = startTime;
              articles[articles.length - 1].facts = { taptapUpcomingStartTime: startTime, taptapEventType: event, taptapTags: tags, taptapOriginalUrl };
            }
          }
          return;
        } catch { /* 不是预期的 calendar JSON 时回退 HTML 解析 */ }
      }
      // TapTap 当前结构按 upcoming-item 分组：日期在组头，事件类型/时间/游戏名/标签/封面在卡片内。
      $(".upcoming-item").each((_, group) => {
        const date = cleanText($(group).find(".upcoming-item__title").first().text());
        $(group).find("a[href^='/app/'],a[href*='taptap.cn/app/']").each((__, el) => {
          const card = $(el);
          const name = cleanText(card.find(".daily-event-app-info__title").first().text() || card.find("[itemprop='name']").first().text());
          const href = card.attr("href") || "";
          if (!name || name.length < 2 || !href) return;
          const detailUrl = resolveUrl(href, baseUrl);
          if (!detailUrl || seen.has(detailUrl)) return;
          const event = cleanText(card.find(".event-type-label__title").first().text() || "近期上线");
          const eventTime = cleanText(card.find(".daily-event-big-card__time").first().text());
          const extra = cleanText(card.find(".daily-event-app-info__extra").first().text());
          // 即将上线表只保留首发/测试/上线类条目；版本更新、活动、联动由新版本独立表处理。
          if (/新版本|版本更新|更新|活动|联动|合作|周年庆|赛季/.test(event)) return;
          const tags = card.find(".daily-event-app-info__tag [itemprop='genre'],.daily-event-app-info__tag .tap-label-tag")
            .map((___, tagEl) => cleanText($(tagEl).text())).get().filter(Boolean);
          const content = [event, eventTime, extra || tags.join("/")].filter(Boolean).join("；");
          const title = `《${name}》${event}${eventTime ? ` ${eventTime}` : ""}`;
          const imageNode = card.find(".daily-event-app-info__app-icon img,.daily-event-big-card__banner img,img").first();
          const imageUrl = resolveUrl(imageNode.attr("data-src") || imageNode.attr("src") || "", baseUrl);
          addArticle(title, detailUrl, imageUrl, [date, eventTime].filter(Boolean).join(" "), name, content, tags);
          articles[articles.length - 1].facts = { taptapOriginalUrl: detailUrl, taptapTags: tags };
        });
      });
    },
    upcoming: "calendar",
    appCalendar: "calendar",
    // TapTap 新品榜：榜单接口给出应用实际 released_time；只保留上海时区当天上线的游戏，
    // 过去条目即使仍在榜单内也不进入“即将上线 / 首发”。
    newDownloads: () => {
      if (!/^\s*\{/.test(html)) return;
      try {
        const payload = JSON.parse(html);
        const shanghaiKey = (seconds) => {
          const value = Number(seconds || 0);
          if (!value) return "";
          const parts = new Intl.DateTimeFormat("zh-CN", {
            timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
          }).formatToParts(new Date(value * 1000));
          const pick = (type) => parts.find((part) => part.type === type)?.value || "";
          return `${pick("year")}-${pick("month")}-${pick("day")}`;
        };
        const today = shanghaiKey(Date.now() / 1000);
        for (const [index, item] of (payload?.data?.list || []).entries()) {
          const app = item?.app || item?.app_card || {};
          const gameName = cleanText(app.title || "");
          const appId = Number(app.id || 0);
          const releasedTime = Number(app.released_time || item.released_time || 0);
          if (!gameName || !appId || !releasedTime || shanghaiKey(releasedTime) !== today) continue;
          const hints = Array.isArray(app.hints) ? app.hints.map(cleanText).filter(Boolean) : [];
          const hintedEvent = hints.find((hint) => /首发|上线|开测|测试/.test(hint)) || "";
          // released_time 是新品榜的可靠日期。提示文案偶尔会与服务端时间不同步，
          // 当它写“明天”却落在今日 released_time 时，统一显示为“今日首发”，避免错误日期进入卡片。
          const event = /今天|今日/.test(hintedEvent) ? hintedEvent : "今日首发";
          if (/昨天|前天|已上线|历史/.test(event)) continue;
          const detailUrl = `https://www.taptap.cn/app/${appId}?os=android`;
          if (seen.has(detailUrl)) continue;
          const tags = (app.tags || []).map((tag) => cleanText(tag?.value || tag?.label || tag)).filter(Boolean);
          const imageUrl = resolveUrl(app.icon?.url || app.icon?.original_url || app.cover?.url || "", baseUrl);
          const summary = cleanText(app.rec_text || app.description?.text || "");
          const dateText = new Intl.DateTimeFormat("zh-CN", {
            timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
          }).format(new Date(releasedTime * 1000)).replace(/\//g, "月").replace(/ (\d{2}:\d{2})$/, "日 $1");
          addArticle(`《${gameName}》${event}`, detailUrl, imageUrl, `${dateText} ${event}`, gameName, summary, tags);
          articles[articles.length - 1].eventReleaseTime = releasedTime;
          articles[articles.length - 1].facts = {
            taptapUpcomingStartTime: releasedTime,
            taptapEventType: event,
            taptapTags: tags,
            taptapOriginalUrl: detailUrl,
            taptapSource: "new_downloads_today",
            taptapNewDownloadRank: index + 1,
          };
        }
      } catch { /* 保持空候选，交由 tasks.js 的回退处理 */ }
    },
    // 机核资讯：专用卡片结构，保留列表时间、摘要与封面；仅保留今天及未来。
    gcores: () => {
      $("a.news[href*='/articles/']").each((_, el) => {
        const card = $(el);
        const href = card.attr("href") || "";
        const title = cleanGcoresTitle(card.find("h3").first().text() || card.attr("title") || "");
        const detailUrl = resolveUrl(href, baseUrl);
        const publishedAt = parseGcoresListDate(card.find(".news_meta span").first().text());
        if (!title || !detailUrl || !isTodayOrFutureNewsDate(publishedAt) || !gcoresFilter(title)) return;
        const imageStyle = card.find(".news_imgArea").first().attr("style") || "";
        const imageUrl = resolveUrl(/url\((['"]?)(.*?)\1\)/i.exec(imageStyle)?.[2] || "", baseUrl);
        const summary = cleanText(card.find(".news_content,.news_desc,.desc").text()).replace(title, "").trim();
        addArticle(title, detailUrl, imageUrl, formatNewsDate(publishedAt), extractGcoresGameName(title), summary);
      });
    },
    // 游民星空资讯：列表卡片自带精确发布时间、摘要和封面；仅保留今天及未来。
    gamersky: () => {
      $("li").each((_, el) => {
        const card = $(el);
        const link = card.find(".tit a.tt[href]").first();
        const href = link.attr("href") || "";
        const title = cleanGamerskyTitle(link.attr("title") || link.text());
        const detailUrl = resolveUrl(href, baseUrl);
        const publishedAt = parseGamerskyListDate(card.find(".tem .time").first().text());
        if (!title || !detailUrl || !isTodayOrFutureNewsDate(publishedAt) || !gamerskyFilter(title)) return;
        const imageUrl = resolveUrl(card.find(".img img").first().attr("src") || "", baseUrl);
        const summary = cleanText(card.find(".con .txt").first().text());
        addArticle(title, detailUrl, imageUrl, formatNewsDate(publishedAt), extractGamerskyGameName(title), summary);
      });
    },
    // 九游新闻
    news: () => {
      $("a[href*=news]").each((_, el) => {
        const href = ($(el).attr("href")||"").trim();
        let title = cleanText($(el).text());
        if (!title || title.length < 8) return;
        if (/攻略|暗号|怎么|哪里|如何|技巧/.test(title)) return;
        const detailUrl = resolveUrl(href, "https://www.9game.cn/");
        if (!detailUrl || seen.has(detailUrl) || !/9game\.cn\/news\/\d+/.test(detailUrl)) return;
        addArticle(title, detailUrl);
      });
    },
    // 九游开测
    kcb: () => {
      $("a[href]").each((_, el) => {
        const href = ($(el).attr("href")||"").trim();
        let title = cleanText($(el).text());
        if (!title || title.length < 4) return;
        const detailUrl = resolveUrl(href, "https://www.9game.cn/");
        if (!detailUrl || seen.has(detailUrl) || !/9game\.cn\/[a-z]/.test(detailUrl)) return;
        if (/APP|登录|绑定|隐私|用户|资质/.test(title)) return;
        addArticle(title, detailUrl);
      });
    },
    default: () => {
      $("a[href]").each((_, el) => {
        const href = ($(el).attr("href")||"").trim();
        if (!href || /^#|javascript/.test(href)) return;
        let title = cleanText($(el).attr("title") || $(el).text());
        if (!title || title.length < 8 || NOISE_TITLE.test(title)) return;
        const detailUrl = resolveUrl(href, baseUrl);
        if (!detailUrl || seen.has(detailUrl)) return;
        if (!isPlatformDetailUrl(platform.id, detailUrl)) return;
        const adapter = ADAPTERS[platform.id];
        if (platform.id === "ref-gcores") title = cleanGcoresTitle(title);
        if (adapter && !adapter.contentFilter(title)) return;
        const gameNameOverride = platform.id === "ref-gcores" ? extractGcoresGameName(title) : "";
        addArticle(title, detailUrl, "", "", gameNameOverride);
      });
    },
  };

  function addArticle(title, detailUrl, imageUrl = "", dateText = "", gameNameOverride = "", body = "", sourceTags = []) {
    if (seen.has(detailUrl)) return;
    seen.add(detailUrl);
    const gameName = gameNameOverride || inferGameName(title);
    articles.push({
      title, gameName, detailUrl,
      category: inferCategory(title),
      sourceId: platform.id,
      sourceName: platform.name,
      dateText,
      paragraphs: body ? [body] : [],
      sourceTags: [...new Set(sourceTags.filter(Boolean))],
      imageUrl,
      score: scoreArticle({ title, detailUrl, dateText: "", sourceId: platform.id }),
      discoveredAt: new Date().toISOString(),
    });
  }

  const fn = extractors[urlType] || extractors.default;
  if (typeof fn === "string") extractors[fn]?.();
  else fn();

  if (urlType === "hashtags") return articles.slice(0, 5);
  if (platform.id === "ref-haoyou" && urlType === "timeline") return articles.slice(0, 120);
  return articles.slice(0, 60);
}

export function parseDetail(html, { url, gameName, category }) {
  const $ = cheerio.load(html);
  $("script,style,noscript,nav,footer,aside,form").remove();

  const title = cleanText(
    $("meta[property='og:title']").attr("content") ||
    $("article h1,main h1,h1").first().text() ||
    $("title").text()
  );

  const selectors = getDetailSelectors(url);
  let paragraphs, images;
  const taptapMomentImages = [];

  if (new URL(url).hostname.includes("x7sy.com")) {
    const x7 = parseX7Detail(html, { url, gameName, category });
    return {
      title: x7.title,
      paragraphs: x7.paragraphs,
      images: x7.images,
      quality: x7.quality,
      gameMatch: x7.gameMatch,
      facts: x7.facts,
    };
  }

  if (selectors === "__haoyou__") {
    const haoyou = parseHaoyouDetail($, url, gameName, category);
    return { title: haoyou.title, paragraphs: haoyou.paragraphs, images: haoyou.images, quality: haoyou.quality, gameMatch: haoyou.gameMatch, facts: haoyou.facts };
  }

  // 机核文章是 Draft.js 块编辑器结构。通用纯文本提取会丢失加粗与图片顺序，
  // 因此将安全的文本样式片段、正文图片按原文块顺序存入 facts，供 RAW 弹窗还原。
  if (new URL(url).hostname.includes("gcores.com")) {
    const gcores = parseGcoresDetail($, url, title, gameName);
    return { title, paragraphs: gcores.paragraphs, images: gcores.images, quality: gcores.quality, gameMatch: gcores.gameMatch, facts: gcores.facts };
  }

  // 游民星空的正文图片位于 Mid2L_con 内的 GsImageLabel 段落中。
  // 通用提取会把所有图片追加到正文末尾，改为保留“文字块 / 图片块”的原始顺序。
  if (new URL(url).hostname.includes("gamersky.com")) {
    const gamersky = parseGamerskyDetail($, url, title, gameName);
    return { title, paragraphs: gamersky.paragraphs, images: gamersky.images, quality: gamersky.quality, gameMatch: gamersky.gameMatch, facts: gamersky.facts };
  }

  // 正文段落
  paragraphs = $(selectors).map((_, el) => cleanText($(el).text())).get()
    .filter(t => t.length >= 20)
    .filter(t => !DETAIL_NOISE.test(t));

  // TapTap: 三类内容提取策略
  if (url.includes("taptap.cn")) {
    // (a) MOMENT 页 — Nuxt SSR 段落提取
    if (url.includes("/moment/")) {
      const momentParas = [];
      $(".tap-rich-content__wrapper").children(".tap-rich-content__row").each((_, el) => {
        const cls = $(el).attr("class") || "";
        if (cls.includes("paragraph")) {
          const txt = $(el).text().trim();
          if (txt.length > 10) momentParas.push(txt);
        }
      });
      if (momentParas.length) paragraphs = momentParas;
      // MOMENT 的图片通常和段落并列，不能只从首个 p 的父节点取图。
      $(".tap-rich-content__wrapper img").each((_, el) => {
        const src = $(el).attr("data-src") || $(el).attr("src");
        if (src && !src.startsWith("data:") && !/logo|avatar|icon|qrcode/i.test(src)) {
          taptapMomentImages.push({ url: resolveUrl(src, url), position: "moment_content", label: "动态图片" });
        }
      });
    }

    // (b) APP 页 — 检测"新版本"标签，提取更新日志
    if (!paragraphs.length && (url.includes("/app/") || url.includes("taptap.cn/app"))) {
      // 判断是否有"新版本"tab
      const hasNewVer = $("body").text().includes("新版本");
      const updateLogTexts = [];
      $(".app-update-log-entry-content, [class*=update-log]").each((_, el) => {
        const raw = ($(el).html() || "").replace(/\\u003C/g, "<").replace(/\\u003E/g, ">");
        // 拆【】段落
        const chunks = raw.split(/【|】/).map(p => p.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).filter(p => p.length > 15);
        updateLogTexts.push(...chunks);
      });
      if (updateLogTexts.length) paragraphs = updateLogTexts;
    }

    // (c) 其他 — og:description 降级 + 广告清洗
    if (!paragraphs.length) {
      paragraphs = $("meta[property='og:description'],meta[name='description']").map((_, el) => {
        return ($(el).attr("content") || "").replace(/TapTap\s*提供.{0,80}?官方正版下载[，,]\s*/g, "").trim();
      }).get()
        .filter(t => t.length > 20)
        .filter(t => !DETAIL_NOISE.test(t))
        .slice(0, 5);
    }
  }

  // 图片提取——带位置信息
  images = [];
  images.push(...taptapMomentImages);
  const ogImg = $("meta[property='og:image']").attr("content");
  if (ogImg) images.push({ url: resolveUrl(ogImg, url), position: "before_text", label: "封面图" });

  // 找到内容容器内的图片
  const container = $(selectors).first().parent() || $("body");
  container.find("img").each((_, el) => {
    const src = $(el).attr("data-src") || $(el).attr("src");
    if (!src || src.startsWith("data:") || /logo|avatar|icon|qrcode/i.test(src)) return;
    // 确定图片出现在哪段之前
    const prevP = $(el).prevAll("p").first();
    const nextP = $(el).nextAll("p").first();
    const prevIdx = prevP.length ? paragraphs.findIndex(p => p === cleanText(prevP.text())) : -1;
    const pos = prevIdx >= 0 ? `after_paragraph_${prevIdx}` : "before_first_paragraph";
    images.push({
      url: resolveUrl(src, url),
      position: pos,
      width: parseInt($(el).attr("width")) || undefined,
      height: parseInt($(el).attr("height")) || undefined,
    });
  });

  const body = paragraphs.join(" ");
  const normalizedTarget = normalize(gameName || "");
  const normalizedAll = normalize(title + body);
  const gm = normalizedTarget && normalizedAll.includes(normalizedTarget);
  const em = normalizedTarget.length >= 3 && (normalizedAll.includes(normalizedTarget.slice(0, 3)) || normalizedTarget.includes(normalize(title).slice(0, 3)));
  // 标题也可作为内容：含游戏名 + 够长
  const titleHasContent = title.length >= 20 && /《|上线|更新|测试|版本|开测|公测|预约|发售|首发|定档|联动|赛季/.test(title);
  const hasContent = paragraphs.length > 0 || titleHasContent;
  // 机核、游民星空是资讯列表页：部分标题不使用《游戏名》书名号，
  // 不能因 game_name 为空而把已成功提取的正文误判为低质并从 RAW 中隐藏。
  const isEditorialNews = /(?:gcores|gamersky)\.com$/i.test(new URL(url).hostname);
  const quality = hasContent && (gm || isEditorialNews) ? "ok" : "low";

  const taptapPublisher = url.includes("taptap.cn") ? extractTapTapPublisher(html) : "";
  const taptapReviewCount = url.includes("taptap.cn") ? extractTapTapReviewCount(html) : null;
  const taptapReserveCount = url.includes("taptap.cn") ? extractTapTapReserveCount(html) : null;
  const taptapFollowerCount = url.includes("taptap.cn") ? extractTapTapFollowerCount(html) : null;
  return {
    title,
    paragraphs,
    images: [...new Map(images.map(image => [image.url, image])).values()].slice(0, 24),
    quality,
    gameMatch: gm ? "strong" : em ? "weak" : "none",
    facts: {
      ...(taptapPublisher ? { taptapPublisher } : {}),
      ...(Number.isFinite(taptapReviewCount) ? { taptapReviewCount } : {}),
      ...(Number.isFinite(taptapReserveCount) ? { taptapReserveCount } : {}),
      ...(Number.isFinite(taptapFollowerCount) ? { taptapFollowerCount } : {}),
    },
  };
}

function parseGamerskyDetail($, url, title, gameName) {
  const layout = [];
  const images = [];
  const seenImages = new Set();
  const root = $(".Mid2L_con").first();
  const addImage = (src, alt = "") => {
    const imageUrl = src ? resolveUrl(src, url) : "";
    if (!imageUrl || seenImages.has(imageUrl) || /logo|avatar|icon|qrcode/i.test(imageUrl)) return;
    seenImages.add(imageUrl);
    layout.push({ type: "image", url: imageUrl, alt: alt || "游民星空正文图片" });
    images.push({ url: imageUrl, position: `gamersky_block_${layout.length}`, label: "正文插图" });
  };
  root.children().each((_, el) => {
    const block = $(el);
    const blockImages = block.find("img");
    if (blockImages.length) {
      blockImages.each((__, imageEl) => addImage($(imageEl).attr("data-src") || $(imageEl).attr("src"), cleanText($(imageEl).attr("alt") || "")));
      return;
    }
    const text = cleanText(block.text());
    if (!text || text.length < 20 || DETAIL_NOISE.test(text) || /更多相关资讯请关注|未经允许禁止转载|本文由游民星空/.test(text)) return;
    layout.push({ type: "text", text });
  });

  const paragraphs = layout.filter(block => block.type === "text").map(block => block.text);
  const normalizedTarget = normalize(gameName || "");
  const normalizedAll = normalize(title + paragraphs.join(" "));
  const gameMatch = normalizedTarget && normalizedAll.includes(normalizedTarget);
  return {
    paragraphs,
    images: images.slice(0, 24),
    quality: paragraphs.length ? "ok" : "low",
    gameMatch: gameMatch ? "strong" : "none",
    facts: { gamerskyLayout: layout.slice(0, 160) },
  };
}

function parseGcoresDetail($, url, title, gameName) {
  const layout = [];
  const images = [];
  const seenImageUrls = new Set();
  const coverUrl = gcoresImageUrl($("meta[property='og:image']").attr("content") || "");
  if (coverUrl) {
    seenImageUrls.add(coverUrl);
    layout.push({ type: "image", url: coverUrl, alt: "文章头图", cover: true });
    images.push({ url: coverUrl, position: "cover", label: "文章头图" });
  }
  const root = $(".newsPage_story,.story-show,.story").first();
  const blocks = root.find(".story_block-text,.story_block-atomic-image");

  blocks.each((_, el) => {
    const block = $(el);
    if (block.hasClass("story_block-text")) {
      const segments = extractGcoresTextSegments(el).filter(segment => segment.text);
      const text = segments.map(segment => segment.text).join("").replace(/\s+/g, " ").trim();
      if (text.length >= 20 && !DETAIL_NOISE.test(text)) layout.push({ type: "text", segments });
      return;
    }

    block.find("img").each((__, imageEl) => {
      const src = $(imageEl).attr("data-src") || $(imageEl).attr("src");
      const imageUrl = src ? resolveUrl(src, url) : "";
      if (!imageUrl || seenImageUrls.has(imageUrl) || /logo|avatar|icon|qrcode/i.test(imageUrl)) return;
      seenImageUrls.add(imageUrl);
      layout.push({ type: "image", url: imageUrl, alt: cleanText($(imageEl).attr("alt") || "机核正文图片") });
      images.push({ url: imageUrl, position: `gcores_block_${layout.length}`, label: "正文图片" });
    });
  });

  const paragraphs = layout.filter(block => block.type === "text").map(block => block.segments.map(segment => segment.text).join("").replace(/\s+/g, " ").trim());
  const normalizedTarget = normalize(gameName || "");
  const normalizedAll = normalize(title + paragraphs.join(" "));
  const gameMatch = normalizedTarget && normalizedAll.includes(normalizedTarget);
  const hasContent = paragraphs.length > 0;
  return {
    paragraphs,
    images: images.slice(0, 24),
    quality: hasContent ? "ok" : "low",
    gameMatch: gameMatch ? "strong" : "none",
    facts: { gcoresLayout: layout.slice(0, 160) },
  };
}

// 机核公开 GAPI 返回的是 Draft.js 原始内容，包含静态 HTML 没有输出的正文图片实体。
// 此处只保留文本样式、图片、媒体链接等安全数据，供 RAW 预览还原，不注入来源 HTML。
export function parseGcoresApiDetail(article, { url, gameName, fallbackTitle = "" } = {}) {
  const attrs = article?.attributes || article || {};
  let draft;
  try { draft = typeof attrs.content === "string" ? JSON.parse(attrs.content) : attrs.content; } catch { draft = null; }
  if (!draft?.blocks) return null;

  const layout = [];
  const images = [];
  const seenImageUrls = new Set();
  const addImage = (path, { caption = "", cover = false, width, height } = {}) => {
    const imageUrl = gcoresImageUrl(path);
    if (!imageUrl || seenImageUrls.has(imageUrl)) return;
    seenImageUrls.add(imageUrl);
    layout.push({ type: "image", url: imageUrl, alt: caption || (cover ? "文章头图" : "机核正文图片"), caption, cover });
    images.push({ url: imageUrl, position: cover ? "cover" : `gcores_block_${layout.length}`, label: caption || (cover ? "文章头图" : "正文图片"), width, height });
  };
  addImage(attrs.cover || attrs.thumb || "", { cover: true });

  const entityMap = draft.entityMap || {};
  for (const block of draft.blocks) {
    if (block.type === "atomic") {
      const entityKey = block.entityRanges?.[0]?.key;
      const entity = entityMap[String(entityKey)] || entityMap[entityKey];
      const data = entity?.data || {};
      if (String(entity?.type || "").toUpperCase() === "IMAGE") {
        addImage(data.path || data.url || "", { caption: String(data.caption || "").trim(), width: data.width, height: data.height });
      } else if (String(entity?.type || "").toUpperCase() === "EMBED") {
        const mediaUrl = extractGcoresEmbedUrl(data.content || "");
        if (mediaUrl) layout.push({ type: "embed", url: mediaUrl, caption: String(data.caption || "").trim() });
      }
      continue;
    }
    const text = String(block.text || "").replace(/\s+/g, " ").trim();
    if (!text || DETAIL_NOISE.test(text)) continue;
    layout.push({ type: "text", segments: draftTextSegments(text, block.inlineStyleRanges || []), quote: block.type === "blockquote" });
  }

  const paragraphs = layout.filter(block => block.type === "text").map(block => block.segments.map(segment => segment.text).join("").trim()).filter(Boolean);
  const title = cleanText(attrs.title || fallbackTitle);
  const normalizedTarget = normalize(gameName || "");
  const normalizedAll = normalize(title + paragraphs.join(" "));
  const gameMatch = normalizedTarget && normalizedAll.includes(normalizedTarget);
  return {
    title,
    paragraphs,
    images: images.slice(0, 24),
    quality: paragraphs.length ? "ok" : "low",
    gameMatch: gameMatch ? "strong" : "none",
    facts: { gcoresLayout: layout.slice(0, 160), gcoresContentSource: "gapi" },
  };
}

function draftTextSegments(text, ranges = []) {
  const chars = Array.from(text);
  const styleAt = index => ranges.reduce((style, range) => {
    const active = index >= Number(range.offset || 0) && index < Number(range.offset || 0) + Number(range.length || 0);
    if (!active) return style;
    const name = String(range.style || "").toUpperCase();
    return { bold: style.bold || name === "BOLD", italic: style.italic || name === "ITALIC" };
  }, { bold: false, italic: false });
  const segments = [];
  chars.forEach((textPart, index) => {
    const style = styleAt(index);
    const previous = segments.at(-1);
    if (previous && previous.bold === style.bold && previous.italic === style.italic) previous.text += textPart;
    else segments.push({ text: textPart, ...style });
  });
  return segments;
}

function gcoresImageUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://image.gcores.com/${raw.replace(/^\/+/, "")}`;
}

function extractGcoresEmbedUrl(value = "") {
  const raw = String(value || "");
  const src = /<iframe[^>]+src=["']([^"']+)["']/i.exec(raw)?.[1] || "";
  const normalized = src.startsWith("//") ? `https:${src}` : src;
  return /^https?:\/\//i.test(normalized) ? normalized : "";
}

function extractGcoresTextSegments(node) {
  const segments = [];
  const walk = (current, style = {}) => {
    if (current.type === "text") {
      const text = String(current.data || "").replace(/\s+/g, " ");
      if (text) {
        const previous = segments.at(-1);
        if (previous && previous.bold === !!style.bold && previous.italic === !!style.italic) previous.text += text;
        else segments.push({ text, bold: !!style.bold, italic: !!style.italic });
      }
      return;
    }
    if (current.type !== "tag") return;
    const name = String(current.name || "").toLowerCase();
    if (name === "br") {
      segments.push({ text: "\n", bold: !!style.bold, italic: !!style.italic });
      return;
    }
    const nextStyle = {
      bold: !!style.bold || name === "strong" || name === "b" || /font-weight\s*:\s*(bold|[6-9]00)/i.test(current.attribs?.style || ""),
      italic: !!style.italic || name === "em" || name === "i" || /font-style\s*:\s*italic/i.test(current.attribs?.style || ""),
    };
    for (const child of current.children || []) walk(child, nextStyle);
  };
  walk(node);
  return segments;
}

function isPlatformDetailUrl(pid, url) {
  try { const u = new URL(url); return detailRules[pid] ? detailRules[pid](u) : true; } catch { return false; }
}

const detailRules = {
  "ref-haoyou": u => u.hostname.includes("3839.com") && (/\/thread-\d+\.htm/.test(u.pathname) || /\/a\/\d+\.htm/.test(u.pathname)),
  "ref-taptap": u => u.hostname.includes("taptap.cn") && (/\/moment\/\d+/.test(u.pathname) || /\/app\/\d+\/?$/.test(u.pathname) || /\/app\/\d+\/game-event\/?$/.test(u.pathname) || (/\/forum\/hot\/hashtags$/.test(u.pathname) && u.searchParams.has("item"))) && !/\/search\//.test(u.pathname),
  "ref-jiuyou": u => u.hostname.includes("9game.cn") && !/\/download\//.test(u.pathname),
  "ref-gamersky": u => u.hostname.includes("gamersky.com"),
  "ref-gcores": u => u.hostname.includes("gcores.com") && /\/articles\/\d+/.test(u.pathname),
  "ref-ali213": u => u.hostname.includes("ali213.net"),
  "ref-steam": () => true,
};

const ADAPTERS = {
  "ref-haoyou": { contentFilter: haoyouFilter },
  "ref-taptap": { contentFilter: taptapFilter },
  "ref-jiuyou": { contentFilter: jiuyouFilter },
  "ref-gamersky": { contentFilter: gamerskyFilter },
  "ref-gcores": { contentFilter: gcoresFilter },
  "ref-ali213": { contentFilter: ali213Filter },
  "ref-steam": { contentFilter: steamFilter },
};

function getDetailSelectors(url) {
  try { const u = new URL(url);
    if (u.hostname.includes("3839.com")) return "__haoyou__";
    if (u.hostname.includes("taptap.cn")) return ".moment-content p,.post-content p,.article-content p,article p,main p,.content p";
    if (u.hostname.includes("9game.cn")) return ".article-content p,.news-content p,.detail-content p,article p,.art-review p,body p";
    // 游民星空当前新闻详情正文容器为 Mid2L_con，.n_show 是旧版选择器。
    // 保留旧选择器兼容存量页面，优先读取实际正文段落。
    if (u.hostname.includes("gamersky.com")) return ".Mid2L_con > p,.Mid2L_con p,.n_show p";
    if (u.hostname.includes("gcores.com")) return ".story_block-text";
    if (u.hostname.includes("ali213.net")) return ".n_show p";
  } catch {}
  return "article p";
}

function extractDate($el) {
  const t = $el.closest("li,div").find("time,span.date,.time").text() ||
    $el.parent().find("time").text();
  return cleanText(t).slice(0, 20) || "";
}

function inferGameName(title) {
  const m = /《([^》]{2,36})》/.exec(title);
  if (m) {
    const extracted = m[1].trim();
    const before = cleanText(title.slice(0, m.index));
    // 如果书名号内容太短(<5字)且前面有实质文字(>2字) → 前面的是游戏名
    if (extracted.length < 5 && before.length > 2 && !/赛季|版本|活动|开启|上线/.test(extracted)) {
      // 提取前面的第一部分作为游戏名
      const firstWord = before.split(/[\s]+/)[0];
      if (firstWord && firstWord.length >= 2) return firstWord.slice(0, 36);
    }
    return extracted;
  }
  const jp = /「([^」]{1,30})」/.exec(title);
  if (jp) {
    // 「」内通常是事件名（"有友节"），不是游戏名。
    // 如果「」前有实质文字（>3字且无事件关键词），优先用前面的做游戏名
    const before = cleanText(title.slice(0, jp.index)).trim();
    if (before.length > 1 && !/赛季|版本|活动|开启|上线|测试|更新/.test(before)) {
      return before.split(/[\s]+/)[0].replace(/[（(][^）)]+[）)]/g, "").trim().slice(0, 36);
    }
    return jp[1].trim();
  }
  let t = cleanText(title)
    .replace(/^\d{1,2}[./-]\d{1,2}\s*/u, "")
    .replace(/^[【\[][^】\]]*[】\]][\s:：\-—]*/u, "")
    .replace(/\d{1,2}月\d{1,2}日\s*/u, "");
  const dn = /^(代号|Project)\s*[：:]\s*(\S{1,20})/.exec(t);
  if (dn) return `${dn[1]}：${dn[2]}`;
  // 剥离开头的评分/媒体前缀（IGN6分、GS8分、游民8.5 等）
  t = t.replace(/^(?:IGN|GS|游民|MC|GameSpot)?\s*[0-9]+(?:\.[0-9]+)?\s*分?[\s,，:：]*/iu, "");
  // 好游快爆格式: {游戏名} {类型标签} {评分} ...
  const firstSpace = t.search(/[\s]+(?:动作|策略|模拟|角色|RPG|卡牌|休闲|竞技|射击|冒险|格斗|音乐|MOBA|SLG|ACT|FPS|测试|上线|更新|预约|首发|\d\.|\d+分)/iu);
  if (firstSpace > 0) t = t.slice(0, firstSpace);
  // 去括号元数据: （官服）（新赛季）(送XX) 等
  t = t.replace(/[（(][^）)]{1,20}[）)]/g, "");
  // 去末尾数字+日期
  t = t.replace(/[\s]*\d+\.\d+.*$/u, "");
  return t.replace(/[\s\uFF1A:：].*$/u, "").trim().slice(0, 36) || "未识别";
}

function inferHotGameName(title = "", body = "") {
  const text = `${title} ${body}`;
  const quoted = /《([^》]{2,40})》/.exec(text);
  if (quoted) return quoted[1].trim();
  const prefix = /^(.{2,16}?)(?:玩家|游戏圈|玩家圈|游戏最近|游戏近期|版本更新)/.exec(text);
  if (prefix) return prefix[1].trim();
  const named = /(?:游戏名|游戏|手游)[：: ]+([^，。！？\n]{2,30})/.exec(text);
  return named ? named[1].trim().replace(/[。！!？，,].*$/, "") : "";
}

function inferCategory(title) {
  if (/联动|合作/.test(title)) return "联动活动";
  if (/版本|更新|赛季|资料片/.test(title)) return "版本更新";
  if (/测试|公测|内测|首测/.test(title)) return "测试公测";
  return "新游上线";
}

/** 统一标题格式: 《游戏名》 + 事件 */
function buildTitle(gameName, category, rawTitle = "") {
  const name = gameName && gameName !== "未识别" ? `《${gameName.slice(0, 24)}》` : "";
  const EVENT = {
    "版本更新": "版本更新", "联动活动": "联动活动", "测试公测": "测试开启", "新游上线": "新品上线",
  };
  const event = EVENT[category] || "新品上线";
  if (name) return `${name} ${event}`;
  // 无游戏名时降级: 清洗原文标题
  return (rawTitle || "").replace(/好游快爆APP提供|快爆|TapTap|游民星空|机核|九游|游侠/g, "").trim().slice(0, 60) || "未命名资讯";
}

function normalize(s) { return (s||"").toLowerCase().replace(/\s+/g,""); }

function parseHaoyouDetail($, url, expectedGameName = "", category = "") {
  const isThread = url.includes("thread-");
  const meta = cleanText($("meta[name='description'],meta[property='og:description']").attr("content") || "");
  const forumTitle = isThread
    ? cleanText($(".forum-left .docArea .title,.docArea .title,.title").first().text())
        .replace(/^快爆快讯\s*/u, "")
        .trim()
    : "";
  const gameTitle = cleanText(
    forumTitle ||
    $("meta[property='og:title']").attr("content") ||
    $("h1,.game-name,.app-name").first().text() ||
    $("title").text().replace(/[-_|].*$/, "")
  );
  const firstUpdateLink = $("#game_open_log_a").first();
  const firstUpdateItem = firstUpdateLink.closest("li");
  const firstUpdateText = cleanText(
    firstUpdateItem.find("p").first().text() || firstUpdateLink.text(),
  );
  const currentUpdate = parseCurrentUpdate(
    cleanText(firstUpdateItem.find("span").first().text()),
    firstUpdateText,
    expectedGameName,
  );
  const originalTitle = currentUpdate.title || cleanUpdateTitle(cleanText(firstUpdateLink.text()), expectedGameName);
  const introTitle = cleanText($(".lb-focal").first().text());
  const detailTags = filterHaoyouTags($("ul.cf li a").map((_, el) => cleanText($(el).text())).get()).slice(0, 5);
  const introNode = $(".lb-text-in").first().clone();
  introNode.find("em.sp-it").remove();
  const introText = cleanText(introNode.text());
  introNode.find("script,style,noscript,iframe,object,form").remove();
  introNode.find("*").each((_, el) => {
    Object.keys($(el).attribs || {}).forEach(name => {
      if (/^on/i.test(name) || name === "style" || name === "class" || name === "id") $(el).removeAttr(name);
    });
  });
  const introHtml = introNode.html() || "";
  const body = $("body").clone();
  body.find("nav,footer,.comment,.related,.recommend,.tabbar,.tab-content,script,style,a.btn,.btn-area,.quote,blockquote,.pstatus").remove();
  
  // Discuz 论坛帖优先读取快爆快讯的 docCon 内容；通用 Discuz 结构作为回退。
  const threadRoot = body.find(".forum-left .docArea .docCon .content,.docCon .content,.t_fsz td,.t_f td,.postmessage,.message,.thread-content").first();
  let ps;
  if (isThread) {
    ps = (threadRoot.length ? threadRoot : body).find("p,div").map((_, el) => cleanText($(el).text())).get()
      .filter(t => t.length >= 16);
  } else {
    ps = body.find("p,.desc,.intro,.content,.game-desc,.app-desc").map((_, el) => cleanText($(el).text())).get()
      .filter(t => t.length >= 16);
  }
  
  ps = ps.filter(t => !/下载|扫码|微信|加群|客服|举报|ICP|备案|Copyright|互联网|许可证|回复|评分|收藏|分享|支持|反对|发表于/i.test(t));
  const images = [];
  const layout = [];
  const addImage = (src, label = "好游正文图片") => {
    if (!src || /^data:/i.test(src) || /logo|avatar|icon|qrcode|emoji|smile|\/common\/|mn-|competition/i.test(src)) return;
    const imageUrl = resolveUrl(src, url);
    if (!imageUrl || images.some(image => image.url === imageUrl)) return;
    const image = { url: imageUrl, position: `content_image_${images.length}`, label };
    images.push(image);
    layout.push({ type: "image", url: imageUrl, alt: label });
  };
  const contentRoot = isThread
    ? threadRoot
    : body.find("article,.article-content,.content,.game-desc,.app-desc,main").first();
  const root = contentRoot.length ? contentRoot : body;
  if (isThread) {
    root.children().each((_, el) => {
      const node = $(el);
      if (node.is(".panel-game,.video,.card-tag")) return;
      const nodeImages = node.find("img");
      if (node.is("img")) addImage(node.attr("data-src") || node.attr("data-original") || node.attr("src"));
      else if (nodeImages.length) nodeImages.each((__, image) => addImage($(image).attr("data-src") || $(image).attr("data-original") || $(image).attr("src")));
      const text = cleanText(node.clone().find("img,.panel-game,.video").remove().end().text());
      if (
        text.length >= 16 &&
        !/下载|扫码|微信|加群|客服|举报|回复|评分|收藏|分享|发表于|责任编辑|审核编辑|快爆编辑部|Video Player is loading/i.test(text)
      ) {
        layout.push({ type: "text", text });
      }
    });
  } else {
    root.find("img").each((_, el) => addImage($(el).attr("data-src") || $(el).attr("data-original") || $(el).attr("src")));
  }
  const titleHasContent = (gameTitle||"").length >= 20 && /《|上线|更新|测试|版本|开测/.test(gameTitle||"");
  const allPs = meta ? [meta, ...ps] : ps;
  const threadParagraphs = layout
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .filter(Boolean);
  const normalizedExpected = normalize(expectedGameName);
  const normalizedText = normalize(`${gameTitle} ${(isThread ? threadParagraphs : allPs).join(" ")}`);
  const gameMatch = normalizedExpected && normalizedText.includes(normalizedExpected) ? "strong" : "weak";
  const isLaunchOrTest = category === "新游上线" || category === "测试公测";
  // 快爆时间线的“即将更新”既可能被归为版本更新，也可能因文案含“联动”被归为联动活动。
  // 两种都是游戏页的历史累计动态，必须只保留第一条，不能把旧图片/旧正文带进详情。
  const isCurrentHaoyouUpdate = !isThread && ["版本更新", "联动活动"].includes(category) && Boolean(currentUpdate.title);
  return {
    title: isThread
      ? (forumTitle || gameTitle || cleanText($("title").text()))
      : isLaunchOrTest
        ? (introTitle || originalTitle || gameTitle || cleanText($("title").text()))
        : (originalTitle || gameTitle || cleanText($("title").text())),
    paragraphs: isThread
      ? threadParagraphs
      : isCurrentHaoyouUpdate
        ? [currentUpdate.title]
      : isLaunchOrTest && introText
        ? [introText]
        : allPs.filter(Boolean),
    // 更新动态详情页包含历年图片，当前活动只沿用列表卡片的封面，不能把历史图带入。
    images: isCurrentHaoyouUpdate ? [] : images.slice(0, 24),
    quality: (allPs.length >= 1 || titleHasContent) ? "ok" : "low",
    gameMatch,
    facts: {
      haoyouIntroTitle: introTitle,
      haoyouIntro: introText,
      haoyouIntroHtml: introHtml,
      haoyouUpdateContent: originalTitle,
      ...(currentUpdate.recordedAt ? { haoyouRecordedAt: currentUpdate.recordedAt } : {}),
      ...(currentUpdate.eventDateText ? { timelineDate: currentUpdate.eventDateText } : {}),
      // 更新动态详情页的图片区是历史累计内容；当前活动仅使用列表封面，
      // 不能把历史图片布局保存下来供飞书、海报或详情弹窗二次读取。
      ...(!isCurrentHaoyouUpdate && layout.length ? { haoyouLayout: layout.slice(0, 160) } : {}),
      ...(detailTags.length ? { haoyouTags: detailTags } : {}),
      ...(extractHaoyouPublisher($.html()) ? { haoyouPublisher: extractHaoyouPublisher($.html()) } : {}),
      ...(Number.isFinite(extractHaoyouReviewCount($.html())) ? { haoyouReviewCount: extractHaoyouReviewCount($.html()) } : {}),
      ...(Number.isFinite(extractHaoyouReserveCount($.html())) ? { haoyouReserveCount: extractHaoyouReserveCount($.html()) } : {}),
      ...(Number.isFinite(extractHaoyouFollowerCount($.html())) ? { haoyouFollowerCount: extractHaoyouFollowerCount($.html()) } : {}),
    },
  };
}
