const EVENT = /新游|上线|发售|开测|公测|内测|测试|预约|首发|定档|开服|版本更新|版本|更新|赛季|资料片|联动|合作|公告/iu;
const BOOKMARK = /《[^》]{2,36}》/;
const OFFICIAL = /官方|正式|开启|公布|公告|开发者/iu;
const GAME_SIG = /游戏|手游|端游|新作/iu;
const FORUM = /论坛|讨论|社区|话题|回复|楼主|投票|求助|组队/iu;
const RANK = /评分|评分卡|排行|TOP\d+|合集|日历|即将上线|推荐榜|热榜/iu;
const METRIC = /预约人数|下载量|人气值/iu;
const LOTTERY = /抽奖|开奖|幸运用户/iu;
const BBS_URL = /\/thread-\d+/i;
const DISCOUNT_SIGNAL = /限时特惠|折扣|-?\d+%\s/i;
const ENGLISH_ONLY = /^[A-Za-z0-9\s:.-]+$/;
const MOBILE_SOURCES = ["ref-haoyou","ref-taptap","ref-x7","ref-jiuyou"];

// 固定词表只存具备稳定中文名称、且在国内手游资讯中长期有识别度的作品/IP。
// 它是重要性信号，不是质量豁免：平台过滤、时效和正文质量仍然优先。
const MOBILE_IP_WEIGHTS = [
  { name: "黑神话", weight: 14, terms: ["黑神话", "Black Myth"] },
  { name: "遮天", weight: 7, terms: ["遮天"] },
  { name: "愤怒的小鸟", weight: 4, terms: ["愤怒的小鸟", "Angry Birds"] },
  { name: "宝可梦", weight: 8, terms: ["宝可梦", "Pokémon", "Pokemon", "精灵宝可梦"] },
  { name: "奥特曼", weight: 8, terms: ["奥特曼", "Ultraman", "奥特曼传奇英雄"] },
  { name: "西游", weight: 7, terms: ["西游", "西游记", "大话西游"] },
  { name: "铠甲勇士", weight: 7, terms: ["铠甲勇士"] },
  { name: "叶罗丽", weight: 6, terms: ["叶罗丽", "精灵梦叶罗丽"] },
  { name: "斗罗大陆", weight: 7, terms: ["斗罗大陆", "斗罗"] },
  { name: "斗破苍穹", weight: 7, terms: ["斗破苍穹", "斗破"] },
  { name: "英雄联盟", weight: 8, terms: ["英雄联盟", "League of Legends", "LOL手游"] },
  { name: "地下城与勇士", weight: 8, terms: ["地下城与勇士", "DNF", "地下城与勇士：起源"] },
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

/**
 * 给 RAW/今日简讯使用的手游重要性信号。
 * 热度最多 +15，IP 最多 +8，总加成最多 +18，并保留原因供 RAW 验收。
 */
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

export function scoreArticle({ title = "", detailUrl = "", dateText = "", sourceId = "", gameName = "", facts = {} }) {
  let s = 50;

  // 信号加分
  if (EVENT.test(title)) s += 10;
  if (BOOKMARK.test(title)) s += 10;
  if (OFFICIAL.test(title)) s += 5;
  if (dateText) s += 5;

  // 来源质量（手游平台自带游戏信息，比 Steam 纯标题有价值）
  if (MOBILE_SOURCES.includes(sourceId)) s += 12;

  // 抓取资讯与今日简讯共用 articles.score 排序，因此把已验证的实时热度/IP
  // 同步计入候选分；平台过滤仍在评分前执行，且总加成受 getMobilePrioritySignals 的 +18 限制。
  s += getMobilePrioritySignals({ sourceId, title, gameName, facts }).totalBoost;

  // 内容信号扣分
  if (DISCOUNT_SIGNAL.test(title)) s -= 35;
  if (FORUM.test(title)) s -= 20;
  if (RANK.test(title)) s -= 15;
  if (METRIC.test(title)) s -= 12;
  if (LOTTERY.test(title)) s -= 25;

  // 纯英文标题（Steam 无中文内容）= 低价值
  if (ENGLISH_ONLY.test(title)) s -= 18;

  // 无中文书无游戏标识
  if (!BOOKMARK.test(title) && !GAME_SIG.test(title)) s -= 6;
  if (!dateText) s -= 2;

  // URL 信号
  try {
    const u = new URL(detailUrl);
    if (BBS_URL.test(u.pathname)) s -= 25;
    if (u.hostname.includes("bbs.")) s -= 15;
  } catch {}

  return Math.max(10, Math.min(95, Math.round(s)));
}
