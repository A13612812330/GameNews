import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  contentFilter as haoyouFilter,
  cleanUpdateTitle,
  parseCurrentUpdate,
  cleanTimelineSummary,
  extractGameName as extractHaoyouGameName,
  extractHaoyouPublisher,
  extractHaoyouFollowerCount,
  extractHaoyouReserveCount,
  extractHaoyouReviewCount,
} from "../server/crawler/platforms/haoyou.js";
import {
  contentFilter as taptapFilter,
  extractUpcomingTags,
  extractTapTapPublisher,
  extractTapTapReserveCount,
  extractTapTapReviewCount,
  extractTapTapFollowerCount,
  hashtagFilter as taptapHashtagFilter,
  hasExcludedTapTapNewGameTag,
} from "../server/crawler/platforms/taptap.js";
import { scoreArticle, getMobilePrioritySignals } from "../server/crawler/scorer.js";
import {
  contentFilter as steamFilter,
  cleanSteamTitle,
  cleanLocalizedSteamName,
  parseSearchPage,
  parseStorePage,
  potentialGate,
  classifySteamReleaseDate,
  selectSteamTags,
} from "../server/crawler/platforms/steam.js";
import { generateRichDraft } from "../server/content/generator.js";
import { downloadImages } from "../server/crawler/imageSaver.js";

const cases = [
  ["好游论坛帖", haoyouFilter, "《原神》综合讨论区欢迎大家", false],
  ["好游评分卡", haoyouFilter, "《原神》评分卡 9.8 编辑推荐", false],
  ["好游抽奖帖", haoyouFilter, "《原神》抽奖｜8月8日开奖", false],
  ["好游正常资讯", haoyouFilter, "《原神》8月开启全新赛季", true],
  ["TapTap论坛帖", taptapFilter, "大家来讨论一下《原神》", false],
  ["TapTap评分卡", taptapFilter, "《原神》评分卡 9.8分", false],
  ["TapTap抽奖帖", taptapFilter, "《原神》抽奖｜8月8日开奖", false],
  ["TapTap推荐帖", taptapFilter, "热门推荐：本周值得玩的十款游戏", false],
  ["TapTap兑换码", taptapFilter, "《原神》最新兑换码礼包领取", false],
  ["TapTap短标题公告", taptapFilter, "《诡秘之主》首发", true],
  ["TapTap正常公告", taptapFilter, "【更新公告】《原神》版本更新", true],
  [
    "Steam附属包",
    steamFilter,
    "SUPER ROBOT WARS Y - Anniversary Expansion Pack",
    false,
  ],
  ["Steam DLC", steamFilter, "Example Game - DLC", false],
  ["Steam Demo", steamFilter, "Example Game Demo", false],
  ["Steam支持者包", steamFilter, "Example Game Supporter Pack", false],
  ["Steam中文工具", steamFilter, "游戏截图工具", false],
  ["Steam工具", steamFilter, "Huiyu Image Tools", false],
  ["Steam低投入", steamFilter, "Idle Immortal Sentinel", false],
  ["Steam正常新品", steamFilter, "Beast of Reincarnation", true],
  ["Steam正常中文版", steamFilter, "星际远征：新纪元", true],
];

for (const [name, filter, title, expected] of cases) {
  assert.equal(filter(title), expected, `${name}过滤结果不符合预期: ${title}`);
}

assert.equal(
  extractHaoyouGameName('雾海之下-“吃”打撤新游(官服)'),
  "雾海之下",
  "好游游戏名营销后缀清洗失败",
);
assert.equal(
  extractHaoyouGameName("燕云十六声(官服)"),
  "燕云十六声",
  "好游游戏名官服后缀清洗失败",
);
assert.equal(
  extractHaoyouGameName("第五人格-1v4对抗"),
  "第五人格",
  "好游游戏名玩法后缀清洗失败",
);
assert.equal(
  extractHaoyouGameName("盗墓笔记：启程-预下载"),
  "盗墓笔记：启程",
  "好游游戏名预下载后缀清洗失败",
);
assert.equal(
  extractHaoyouGameName("影之刃零-8月12日开放预购"),
  "影之刃零",
  "好游游戏名日期预购后缀清洗失败",
);
assert.equal(
  cleanTimelineSummary("标签：非对称竞技；第四十四赛季·精华3开启；下载"),
  "第四十四赛季·精华3开启",
  "好游时间线正文标签或下载文案清洗失败",
);
assert.equal(
  cleanTimelineSummary("标签：动作 / 冒险 / 第三人称；新内容即将上线；和；预约"),
  "新内容即将上线",
  "好游时间线正文玩法标签或预约文案清洗失败",
);
assert.equal(
  cleanTimelineSummary("标签：解谜 / 角色扮演；10:00 预下载，8月11日上线；下载"),
  "8月11日上线",
  "好游时间线预下载状态清洗失败",
);
assert.equal(
  cleanTimelineSummary("标签：动作 / 冒险 / 第三人称；10:00 开启预售，来快爆购买；预约"),
  "",
  "好游时间线纯营销摘要应清洗为空",
);
assert.equal(
  cleanUpdateTitle("《时空中的绘旅人(官服)》 「怪谈：电子」活动画廊限时开启", "时空中的绘旅人"),
  "「怪谈：电子」活动画廊限时开启",
  "好游更新标题游戏名去重失败",
);
const currentHaoyouUpdate = parseCurrentUpdate(
  "2026.08.21",
  "8月21日更新：【少女前线兑换礼】返场，【限时CP福利放送】第三周开放",
  "使命召唤手游",
);
assert.equal(currentHaoyouUpdate.recordedAt, "2026.08.21", "好游收录日期解析失败");
assert.equal(currentHaoyouUpdate.eventDateText, "8月21日", "好游实际活动日期必须取更新文案");
assert.equal(currentHaoyouUpdate.title, "【少女前线兑换礼】返场，【限时CP福利放送】第三周开放", "好游当前更新标题清洗失败");
assert.equal(
  extractTapTapReviewCount('<span class="universal-tab-bar__label">评价</span><span class="universal-tab-bar__count">4287</span>'),
  4287,
  "TapTap 评价数量提取失败",
);
assert.equal(
  extractTapTapReviewCount('<span data-v-5bd959ad="">共 20,954 条评价</span>'),
  20954,
  "TapTap 汇总评价数量提取失败",
);
assert.equal(
  extractTapTapReviewCount('<span data-v-5bd959ad="">共 0 条评价</span>'),
  0,
  "TapTap 0 评价数量不能被当成未获取",
);
assert.equal(
  extractTapTapReviewCount('<span>评价 <span class="app-layout__tap-header__sub-text">2.5万</span></span>'),
  25000,
  "TapTap 紧凑评价数量提取失败",
);
assert.equal(
  extractTapTapFollowerCount('<button class="app-basic-info__title app-basic-info__title--follow"><span>关注</span></button><span class="app-basic-info__value">1381</span>'),
  1381,
  "TapTap 关注数量提取失败",
);
assert.equal(
  extractTapTapReserveCount('{"reserve_count":217,"review_count":12}'),
  217,
  "TapTap 预约数量提取失败",
);
assert.equal(
  extractTapTapPublisher('<span class="app-aside-overview__info-label">厂商</span><a><span class="app-aside-overview__info-value-text">中山市旺好网络科技有限公司</span></a>'),
  "中山市旺好网络科技有限公司",
  "TapTap 厂商提取失败",
);
assert.equal(
  extractTapTapPublisher('<div class="gray-06">厂商</div><a href="/developer/386241"><div class="tap-text tap-text__one-line">jax游戏</div></a>'),
  "jax游戏",
  "TapTap div 厂商结构提取失败",
);
assert.equal(
  extractHaoyouReviewCount('<li id="pj_tab"><em>评价</em><span id="pl_num">17</span></li>'),
  17,
  "好游快爆评价数量提取失败",
);
assert.equal(
  extractHaoyouReviewCount('<li id="pj_tab"><em>评价</em><span id="pl_num">6617</span></li>'),
  6617,
  "好游快爆 pl_num 评论数量提取失败",
);
assert.equal(
  extractHaoyouReviewCount('<div class="sp-txt">6616人评价</div>'),
  6616,
  "好游快爆紧凑评价数量提取失败",
);
assert.equal(
  extractHaoyouReserveCount('<div class="frag-li"><div class="sp1"><span class="sp-val">6</span></div><div class="sp2">预约人数</div></div>'),
  6,
  "好游快爆 frag-li 预约数量提取失败",
);
assert.equal(
  extractHaoyouFollowerCount('<div class="frag-li"><div class="sp1"><span class="sp-val">1084</span></div><div class="sp2">关注人数</div></div>'),
  1084,
  "好游快爆关注数量提取失败",
);
assert.equal(
  extractHaoyouReserveCount('<div class="GD-info"><p class="sp-info"><span>8.0</span> 125.8万预约人数</p></div>'),
  1258000,
  "好游快爆预约数量提取失败",
);
assert.equal(
  extractHaoyouPublisher('<a class="lk" href="//www.3839.com/cp/38621.html">上海游卡网络技术有限公司</a>'),
  "上海游卡网络技术有限公司",
  "好游快爆厂商提取失败",
);
assert.equal(
  extractHaoyouPublisher('<li><span>发行：</span><a class="lk" href="//www.3839.com/cp/15048.html">Level Infinite</a></li>'),
  "Level Infinite",
  "好游发行商字段提取失败",
);
assert.equal(
  extractHaoyouPublisher('<td width="25%"><em>开发商</em><p><a href="//www.3839.com/cp/31082.html">广州游星信息技术有限公司</a></p></td>'),
  "广州游星信息技术有限公司",
  "好游开发商字段提取失败",
);
assert.equal(
  extractHaoyouPublisher('<a class="lk" href="//www.3839.com/cp/1.html">官方已入驻</a>'),
  "",
  "好游快爆账号状态不能误当厂商",
);

const normal = scoreArticle({
  title: "《原神》版本更新公告",
  detailUrl: "https://example.com/news/1.html",
  dateText: "2026/07/30",
});
const forum = scoreArticle({
  title: "《原神》综合讨论区欢迎大家",
  detailUrl: "https://bbs.example.com/thread-1",
  dateText: "",
});
const lottery = scoreArticle({
  title: "《原神》抽奖｜8月8日开奖",
  detailUrl: "https://example.com/news/2.html",
  dateText: "",
});
assert(
  normal > forum && normal > lottery,
  `评分分层失败: normal=${normal}, forum=${forum}, lottery=${lottery}`,
);
assert(
  normal >= 10 &&
    normal <= 95 &&
    forum >= 10 &&
    forum <= 95 &&
    lottery >= 10 &&
    lottery <= 95,
  "评分边界失败",
);
const rankedIp = getMobilePrioritySignals({
  sourceId: "ref-taptap", title: "《斗罗大陆》今日首发", gameName: "斗罗大陆",
  facts: { taptapNewDownloadRank: 2 },
});
assert.equal(rankedIp.heatBoost, 12, "TapTap新品榜热度加分失败");
assert.equal(rankedIp.ipBoost, 7, "手游 IP 加分失败");
assert.equal(rankedIp.totalBoost, 18, "热度/IP 总加分上限失败");
assert.equal(getMobilePrioritySignals({ sourceId: "ref-taptap", title: "《斗罗大陆》社区截图分享", gameName: "斗罗大陆" }).totalBoost, 0, "无当前事件或热度的 IP 不应加分");
assert.equal(
  getMobilePrioritySignals({ sourceId: "ref-taptap", title: "中式志怪主题月", gameName: "燕云十六声", forceEvent: true }).ipBoost,
  8,
  "已通过事件校验的燕云十六声应获得高热游戏权重",
);
assert.equal(
  cleanSteamTitle("Example [Demo]"),
  "Example",
  "Steam 标题清洗失败",
);
assert.equal(
  cleanLocalizedSteamName("在 Steam 上购买 星之海 立省 20%"),
  "星之海",
  "Steam 中文名清洗失败",
);
assert.equal(
  classifySteamReleaseDate("2012 年 8 月 21 日", new Date("2026-08-05"))
    .category,
  "热门爆款",
  "Steam 老游戏分类失败",
);
assert.equal(
  classifySteamReleaseDate("2026 年 8 月 4 日", new Date("2026-08-05"))
    .category,
  "新游上线",
  "Steam 新游分类失败",
);
assert.equal(
  classifySteamReleaseDate("2026 年 9 月 1 日", new Date("2026-08-05"))
    .category,
  "近期热点",
  "Steam 未来发行分类失败",
);
assert.equal(
  classifySteamReleaseDate("即将推出", new Date("2026-08-05")).category,
  "近期热点",
  "Steam 无可靠日期分类失败",
);
assert.equal(
  taptapHashtagFilter(
    "谁主沉浮",
    "#单机游戏 #发现好游戏 #游戏日常",
    "普通用户",
    "",
  ),
  false,
  "TapTap 热榜普通话题未过滤",
);
assert.equal(hasExcludedTapTapNewGameTag(["创意工坊", "休闲"]), true, "TapTap 创意工坊新游未过滤");
assert.equal(hasExcludedTapTapNewGameTag(["动作", "冒险"]), false, "普通 TapTap 新游标签被误过滤");
assert.deepEqual(
  extractUpcomingTags('<div class="app-aside-overview__tags--two-lines app-aside-overview__tags"><div class="craft-tag app-aside-overview__craft-tag">创意工坊</div><a class="tap-router app-aside-overview__tag">休闲</a></div>'),
  ["创意工坊", "休闲"],
  "TapTap craft-tag 创意工坊标签提取失败",
);
assert.equal(
  taptapHashtagFilter(
    "《原神》版本更新",
    "#原神 #版本更新",
    "官方账号",
    "官方",
  ),
  true,
  "TapTap 热榜官方动态误过滤",
);
assert.deepEqual(
  selectSteamTags(
    ["Action", "RPG", "Strategy", "Simulation", "Horror", "Sports"],
    ["Multiplayer", "Steam Achievements"],
    ["Open World", "Free to Play", "Co-op"],
  ),
  [
    "Action",
    "RPG",
    "Strategy",
    "Simulation",
    "Horror",
    "Multiplayer",
    "Open World",
    "Co-op",
  ],
  "Steam 标签过滤或上限失败",
);
assert(
  potentialGate({
    name: "TUAN: Scriptum",
    desc: ["A four-in-one local writing tool and productivity app."],
    tags: ["Software"],
    genres: ["Utilities"],
    categories: [],
    type: "game",
  }).reasons.length > 0,
  "Steam 工具产品质量门槛未命中",
);

const duplicateNameDraft = generateRichDraft([
  {
    gameName: "拉斯维加斯模拟器",
    title: "《拉斯维加斯模拟器》重大更新今日上线",
    category: "版本更新",
    paragraphs: ["版本更新内容已正式上线。"],
  },
]);
assert.equal(
  duplicateNameDraft.sections[0].heading,
  "《拉斯维加斯模拟器》重大更新今日上线",
  "简讯标题不应重复拼接游戏名尾部",
);

const searchFallback = parseSearchPage(`
  <a class="search_result_row" data-ds-appid="12345"><span class="title">Fallback Game</span><img src="cover.jpg"></a>
  <a class="search_result_row" data-ds-appid="12346"><span class="title">Fallback Game Demo</span></a>
`);
assert.deepEqual(
  searchFallback.map((item) => item.id),
  ["12345"],
  "Steam 搜索页回退解析或过滤失败",
);

const detailFallback = parseStorePage(
  `
  <meta property="og:title" content="Fallback Game">
  <meta property="og:description" content="这是一段足够长的 Steam 商店简介，用于验证详情页回退解析。">
  <meta property="og:image" content="cover.jpg">
  <div class="release_date"><div class="date">2026年8月5日</div></div>
  <div id="game_area_description">这是中文商店的完整游戏介绍，包含玩法和世界设定。</div>
  <div class="glance_tags"><a>动作</a><a>战术</a><a>免费开玩</a><a>创意工坊</a></div>
  <div class="details_block"><a href="/genre/Action/">动作</a></div>
`,
  "12345",
);
assert.equal(detailFallback.ok, true, "Steam 详情页回退解析失败");
assert.equal(detailFallback.imageUrl, "cover.jpg", "Steam 详情页图片解析失败");
assert(
  detailFallback.desc[0].includes("完整游戏介绍"),
  "Steam 中文商店正文优先解析失败",
);
assert(
  detailFallback.tags.includes("战术") &&
    detailFallback.tags.includes("免费开玩"),
  "Steam 中文商店标签解析失败",
);
assert(
  !detailFallback.tags.some((tag) => /\\s{2,}/.test(tag)),
  "Steam 标签空白清洗失败",
);

const imageReuseTemp = await fs.mkdtemp(path.join(os.tmpdir(), "gamenews-image-reuse-"));
try {
  const oldImageDir = path.join(imageReuseTemp, "detail-old", "images");
  await fs.mkdir(oldImageDir, { recursive: true });
  const png = Buffer.alloc(21 * 1024);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(450, 20);
  await fs.writeFile(path.join(oldImageDir, "cover.png"), png);
  const reused = await downloadImages(
    [{ url: "https://invalid.example.test/game/cover.png" }],
    "detail-new",
    "same-game",
    imageReuseTemp,
    {
      reuseImages: [{
        originalUrl: "https://old.example.test/game/cover.png",
        src: "/crawler-assets/detail-old/images/cover.png",
      }],
    },
  );
  assert.equal(reused.length, 1, "同游戏同图片名应复用历史文件，不应再次下载");
  assert.equal(reused[0].src, "/crawler-assets/detail-old/images/cover.png", "复用图片路径错误");
  assert.equal(reused[0].reused, true, "复用图片应标记 reused");
} finally {
  await fs.rm(imageReuseTemp, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    { ok: true, filterCases: cases.length, scores: { normal, forum, lottery } },
    null,
    2,
  ),
);
