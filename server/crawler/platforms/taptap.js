/**
 * TapTap 平台适配器
 * TapTap 分为两条链路：热榜话题内容流、即将上线开测表。
 */
export function contentFilter(title = "") {
  const value = String(title || "").replace(/\s+/g, " ").trim();
  if (value.length < 8 && !/《[^》]{2,36}》/.test(value)) return false;
  // 排除日历页日期导航（「昨」「明」「01」「20」等纯日期/数字 + 周几）
  if (/^[「【]?(昨|今|明|周[一二三四五六日天]|\d{1,2})[」】]?\s*(周|星期)?[一二三四五六日天]?\s*\d{0,2}$/.test(value)) return false;
  if (/^「?(\d{1,2}|昨|今|明)」?$/.test(value)) return false;
  // 先排除噪音，再判断是否含有资讯信号，避免《游戏名》绕过过滤。
  if (/论坛|讨论|社区|话题|回复|楼主|评分|评分卡|排行|榜单|TOP\s*\d+|合集|热榜|投票|抽奖|开奖|幸运用户|玩家评价|热门标签|猜你喜欢|为你推荐|编辑推荐|攻略|求助|组队|礼包|兑换码|下载|充值|什么时候上线|有人知道|有人不知道|大家有什么问题|萌新|全收集|怎么打/iu.test(value)) return false;
  // 排除行业资讯汇总（很长且含"行业""圈内"等泛词）
  if (value.length > 80 && /行业|圈内|值得关注|汇总|简报|日报|周报/.test(value)) return false;
  // 排除编辑/官方账号简介页
  if (/^TapTap(官方|编辑)/.test(value)) return false;
  // 排除纯用户讨论帖
  if (/^(大家|各位|有人|求助|请教|问一下|讨论|求推荐|求解)/u.test(value)) return false;
  // 必须有游戏名《》或更新公告信号
  const hasBookmark = /《[^》]{2,36}》/.test(value);
  const hasUpdate = /更新公告|版本更新|维护公告|更新预告|停服维护|活动预告|活动公告|新版本|新赛季|新角色|新英雄|联动|上线|开测|公测|定档|首发/;
  if (hasBookmark || hasUpdate.test(value)) return true;
  // 放宽：标题含游戏关键词 + 事件信号
  const hasGame = /游戏|手游|端游|新作|版本/i;
  const hasEvent = /上线|开\w*测试|发布|发售|开启|预告|宣布|公布/;
  if (hasGame.test(value) && hasEvent.test(value)) return true;
  return false;
}

const GAME_TOPIC = /游戏|手游|端游|新游|新作|版本|更新|公测|首发|上线|联动|赛季|角色|英雄|副本|活动|玩法|剧情|卡牌|战斗|射击|模拟|策略|动作|冒险|RPG|MMO|Steam|原神|米哈游|网易|腾讯|国产游戏/i;
const BAD_TOPIC = /生活区|闲谈|情感|投票|抽奖|攻略|求助|讨论|兑换码|礼包|壁纸|表情包|欠薪|纠纷|招聘|广告|群号|加群|测评打分|好评率/i;
const INFO_TOPIC = /版本|更新|公告|维护|测试|公测|首发|上线|联动|活动|发布|发售|预约|定档|开放|推出|实机|资讯|新闻|新游|新作/i;
const HOT_NOISE = /抽奖|开奖|中奖|群号|加群|招聘|广告|兑换码|礼包|壁纸|背景图|表情包|直播|下载|充值|欠薪|纠纷/i;

export function hashtagFilter(title = "", body = "", author = "", honor = "", group = "") {
  const text = `${title} ${body} ${group}`.replace(/\s+/g, " ").trim();
  if (BAD_TOPIC.test(text)) return false;
  if (!contentFilter(text) && !(GAME_TOPIC.test(text) && INFO_TOPIC.test(text))) return false;
  if (!GAME_TOPIC.test(text)) return false;
  if (/创作者|玩家|普通用户/.test(`${author} ${honor}`) && !/官方|制作组|工作室|发行商/.test(`${author} ${honor}`)) return false;
  return true;
}

// 热榜话题是内容流：只过滤明显非资讯噪音，保留游戏相关的玩家动态和普通资讯。
export function hotTopicFilter(title = "", body = "", gameName = "", group = "") {
  const text = [title, body, gameName, group].join(" ").replace(/\s+/g, " ").trim();
  if (title.trim().length < 3 || body.trim().length < 8) return false;
  if (HOT_NOISE.test(text)) return false;
  return true;
}

export function extractUpcomingTags(html = "") {
  const tags = [];
  const add = value => {
    const tag = String(value || "").replace(/\s+/g, " ").trim();
    if (!tag || tag.length > 20 || /TapTap|官方|预约|下载|评分|标签包括|游戏标签/i.test(tag)) return;
    if (!tags.includes(tag)) tags.push(tag);
  };
  // 详情页侧栏的真实玩法标签。这里不能先匹配外层 div：内部 craft-tag div
  // 会让非递归正则提前结束。直接扫描唯一 class，既能拿到“创意工坊”，也不丢常规 a 标签。
  for (const match of String(html).matchAll(/<div[^>]*class=["'][^"']*\bcraft-tag\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    add(match[1].replace(/<[^>]+>/g, ""));
  }
  for (const match of String(html).matchAll(/<a[^>]*class=["'][^"']*\bapp-aside-overview__tag\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    add(match[1].replace(/<[^>]+>/g, ""));
  }
  if (tags.length) return [...new Set(tags)].slice(0, 8);
  for (const match of String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        add(item?.applicationSubCategory);
        add(item?.genre);
        const answer = item?.acceptedAnswer?.text || "";
        for (const part of answer.split(/[：:、,，。]/)) add(part);
      }
    } catch {}
  }
  const tagLinks = String(html).matchAll(/href=["'][^"']*\/tag\/[^"']+["'][^>]*>([^<]{1,20})</gi);
  for (const match of tagLinks) add(match[1]);
  return [...new Set(tags)].slice(0, 8);
}

// TapTap 详情页首屏只渲染部分标签，展开按钮对应的完整标签来自 BFF 详情接口。
// 这里从动态 HTML 中读取接口地址，避免硬编码设备参数；静态 HTML 没有地址时再使用稳定的默认请求参数。
export async function fetchTapTapAppTags(html = "", appId = "") {
  const source = String(html || "");
  const apiUrl = [...source.matchAll(/https?:\/\/[^"'\\\s]+\/webapiv2\/app\/v6\/detail\?[^"'\\\s]+/giu)]
    .map((match) => match[0].replace(/\\u0026/gu, "&"))
    .find((value) => !appId || new URL(value).searchParams.get("id") === String(appId))
    || (appId
      ? `https://www.taptap.cn/webapiv2/app/v6/detail?X-UA=${encodeURIComponent("V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=Android&DT=PC")}&id=${encodeURIComponent(appId)}`
      : "");
  if (!apiUrl) return [];
  try {
    const response = await fetch(apiUrl, {
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "application/json,text/plain,*/*",
        referer: appId ? `https://www.taptap.cn/app/${appId}` : "https://www.taptap.cn/",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload?.data?.app?.tags || [])
      .map((tag) => typeof tag === "string" ? tag : tag?.value || tag?.label || tag?.name || "")
      .map((tag) => String(tag).replace(/\s+/gu, " ").trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function parseDisplayCount(value = "") {
  const text = String(value || "").replace(/[\s,，]/g, "").trim();
  const match = /([\d.]+)\s*([万亿]?)/u.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const multiplier = match[2] === "亿" ? 100000000 : match[2] === "万" ? 10000 : 1;
  return Math.round(amount * multiplier);
}

// 评价数是详情页内“评价”标签后的数字；不使用下载量、预约数等替代指标。
export function extractTapTapReviewCount(html = "") {
  const source = String(html || "");
  const labeled = /universal-tab-bar__label[^>]*>\s*评价\s*<\/span>[\s\S]{0,600}?universal-tab-bar__count[^>]*>\s*([^<]+)\s*<\/span>/iu.exec(source);
  if (labeled) return parseDisplayCount(labeled[1]);
  // 新版详情页把评价数直接写成“共 20,954 条评价”，兼容带 data-v 属性的 span。
  const summary = /(?:>\s*)?共\s*([\d.,]+\s*[万亿]?)\s*条评价/iu.exec(source);
  if (summary) return parseDisplayCount(summary[1]);
  // 部分 App 活动页只显示紧凑格式：“评价 2.5万”。
  const compact = /评价[\s\S]{0,300}?(?:sub-text|count)[^>]*>\s*([\d.]+\s*[万亿]?)\s*<\//iu.exec(source);
  return parseDisplayCount(compact?.[1] || "");
}

// TapTap 新游详情页的预约量来自结构化状态数据 `reserve_count`。
// 只读取明确字段，不把评价数、关注数或下载量当成预约量。
export function extractTapTapReserveCount(html = "") {
  const source = String(html || "");
  const match = /["']reserve_count["']\s*:\s*(?:["']([^"']+)["']|(\d+(?:\.\d+)?))/iu.exec(source);
  return parseDisplayCount(match?.[1] || match?.[2] || "");
}

// 详情页基础信息里的“关注”数量，用于衡量长期关注度；不能用预约数或下载数替代。
export function extractTapTapFollowerCount(html = "") {
  const source = String(html || "");
  const match = /app-basic-info__title[^>]*app-basic-info__title--follow[\s\S]{0,500}?<span[^>]*class=["'][^"']*app-basic-info__value[^"']*["'][^>]*>\s*([\d.,]+\s*[万亿]?)\s*<\/span>/iu.exec(source);
  if (match) return parseDisplayCount(match[1]);
  const legacy = /关注[\s\S]{0,500}?single-info__content__value[^>]*>[\s\S]{0,100}?([\d.]+)\s*([万亿]?)/iu.exec(source);
  return parseDisplayCount(legacy ? `${legacy[1]}${legacy[2] || ""}` : "");
}

// 厂商固定来自 App 详情页信息行，避免误拿“开发者动态”的作者名称。
export function extractTapTapPublisher(html = "") {
  const source = String(html || "");
  const labelBlock = /(?:app-aside-overview__info-label|gray-06)[^>]*>\s*(?:厂商|开发商|发行商|运营方|运营商)\s*<\/(?:span|div)>/iu.exec(source);
  if (labelBlock) {
    const tail = source.slice(labelBlock.index + labelBlock[0].length, labelBlock.index + labelBlock[0].length + 1600);
    const developerLink = /<a[^>]*href=["'][^"']*\/developer\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/iu.exec(tail);
    const value = developerLink?.[1] || /(?:app-aside-overview__info-value-text|tap-text[^>]*tap-text__one-line)[^>]*>([\s\S]*?)<\/(?:span|div)>/iu.exec(tail)?.[1] || "";
    const cleaned = value.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
    if (cleaned && !/^(?:TapTap|官方已入驻)$/iu.test(cleaned)) return cleaned;
  }
  // SSR 详情页还可能只留下 JSON-LD 的 author 字段。
  const author = /["']author["']\s*:\s*\{[\s\S]{0,300}?["']name["']\s*:\s*["']([^"']+)["']/iu.exec(source)?.[1] || "";
  return author && !/^(?:TapTap|官方已入驻)$/iu.test(author) ? author.trim() : "";
}

// 用户不需要 TapTap 制造类、创意工坊类的新游。标签来自游戏详情页，
// 只用于“新游”候选过滤，不影响正常游戏的版本更新/活动跟踪。
export function hasExcludedTapTapNewGameTag(tags = []) {
  return (Array.isArray(tags) ? tags : [tags]).some((tag) =>
    /TapTap\s*(?:制造|Maker)|创意工坊/iu.test(String(tag || "")),
  );
}

export function isDetailUrl(url) {
  try {
    const u = new URL(url);
    // 排除用户主页、App下载页、搜索结果、日历日期导航、云游戏、下载页
    if (/\/user\//.test(u.pathname) || /\/search\//.test(u.pathname)) return false;
    if (/\/app\//.test(u.pathname) && !/\/app\/\d+\/?$/.test(u.pathname) && !/\/app\/\d+\/game-event\/?$/.test(u.pathname)) return false;
    if (/\/app-calendar/.test(u.pathname)) return false;            // 整个日历页都是日期导航，无内容
    if (/\/web-cloud-game/.test(u.pathname)) return false;          // 云游戏
    if (/\/download/.test(u.pathname)) return false;                // 下载页
    return u.hostname.includes("taptap.cn");
  } catch { return false; }
}
