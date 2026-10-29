// 好游快爆 适配器 —— 迁入自 GameNews（parser.js timeline + platforms/haoyou.js）
// 页面为服务端渲染，纯 fetch + cheerio 即可。
import { load } from "cheerio";

const BASE = "https://www.3839.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 GameNewsUnified/1.0";

function cleanText(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function resolveUrl(href, base = BASE) { try { return new URL(href, base).href; } catch { return ""; } }

// ---- 迁入自 haoyou.js ----
export function extractGameName(title = "") {
  let value = String(title || "").replace(/\s+/g, " ").trim();
  value = value.replace(/^《|》$/g, "").trim();
  value = value.replace(/[（(]\s*(?:官服|测试服|体验服|先遣服|渠道服|国际服)\s*[）)]/giu, "");
  value = value.replace(/[-—–]\s*(?:新版本预约|版本预约|新游预约).*$/iu, "");
  value = value.replace(/[-—–]\s*(?:(?:\d{1,2}月\d{1,2}日)\s*)?(?:开放)?(?:预下载|预购|预售|预约下载|预约开启).*$/iu, "");
  value = value.replace(/[-—–]\s*(?:S\d+(?:[.·]\d+)?赛季|[一二三四五六七八九十百\d]+周年(?:庆典)?|v?\d+(?:\.\d+){1,3}(?:版本)?).*$/iu, "");
  value = value.replace(/[-—–]\s*(?:手游|移动版|手机版).*$/iu, "");
  value = value.replace(/[-—–]\s*(?:送|领|赠)?\s*[^—–]{0,14}?(?:时装|皮肤|礼包|称号|道具|头像框|装扮).*$/iu, "");
  value = value.replace(/[-—–]\s*(?:奇遇|探索)?[^—–]{0,8}?(?:开放世界|沙盒世界).*$/iu, "");
  value = value.replace(/[-—–]\s*(?:\d+\s*[vV]\s*\d+\s*)?(?:对抗|竞技|战斗|射击|冒险|策略|卡牌).*$/iu, "");
  value = value.replace(/[-—–]\s*[“”"'‘’]?[^—–]*?(?:新游|新作|预约|首发|上线|测试|体验|招募|开服).*$/iu, "");
  value = value.replace(/\s+(?:新版本预约|版本预约|招募中|体验服招募中).*$/iu, "");
  value = value.replace(/\s+(?=(?:动漫改编|多人联机|开放世界|角色扮演|动作|策略|卡牌|冒险|模拟经营|模拟|休闲|射击|格斗|音游|解谜|悬疑|仙侠|国漫|足球|航海|沙盒|生存|塔防|Roguelike|MMO|ARPG|SLG|FPS|放置|社交|第一人称|女性向|多平台|江湖|文字|烹饪|建造|即时战斗|搜打撤|吃鸡|竖屏|国风|中国风|萌娘|剧情|横版|刷宝|佛系|竞技|宠物|收集)).*$/iu, "");
  value = value.replace(/\s+\d+(?:\.\d+)?\s+.*$/u, "");
  value = value.replace(/\s+(?:已于|预计|正式|限量|删档|不删档|首曝|定档|开启|更新|上线|测试|预约|海外|具体几点).*$/iu, "");
  return value.replace(/[：:、，,。．.\-—–]+$/u, "").trim() || String(title || "").trim();
}
export function cleanTimelineSummary(value = "") {
  return String(value || "")
    .replace(/(?:^|[；;])\s*标签\s*[:：]\s*[^；;]+/giu, "")
    .replace(/\d{1,2}:\d{2}\s*(?:开启)?(?:预下载|预购|预售|预约)\s*[，,]?\s*/giu, "")
    .replace(/来快爆购买/giu, "")
    .replace(/(?:^|[；;])\s*(?:下载|立即下载|预约|预下载|预购|预售|进入游戏|和)\s*(?=$|[；;])/giu, "")
    .replace(/^[；;\s]+|[；;\s]+$/gu, "")
    .replace(/[；;]\s*[；;]+/gu, "；")
    .replace(/[，,]\s*(?=[；;]|$)/gu, "")
    .trim();
}
export function cleanTimelineDate(value = "") {
  return String(value || "").replace(/\s+(?:今天|明天|后天|昨天|前天|上周[一二三四五六日]|周[一二三四五六日]|下周[一二三四五六日]).*$/u, "").replace(/\s+/g, " ").trim();
}
export function isWithinNextDays(value = "", days = 7) {
  const match = /^(\d{1,2})月(\d{1,2})日/u.exec(String(value || "").trim());
  if (!match) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]));
  if (target.getTime() < today.getTime() && now.getMonth() >= 10 && Number(match[1]) <= 3) target = new Date(now.getFullYear() + 1, Number(match[1]) - 1, Number(match[2]));
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  return diff >= 0 && diff <= days;
}
export function filterGameplayTags(tags = []) {
  const nonGameplay = /^(编辑推荐|力荐佳作|多平台|多端互通|Steam移植|PC游戏|Android|iOS|主机|跨平台|官服|预约|预下载|下载|推荐|热门|精品|高分|新游|新作|手游|端游|网游|单机|免费|测试服|编辑器|独立游戏|买断制|硬核|怀旧向|QQ|微信|QQ空间|微博|朋友圈|分享|论坛(?:\d+)?|讨论(?:\d+)?|社区|话题|回复(?:\d+)?)$/iu;
  const coreGameplay = /动作|射击|格斗|生存|沙盒|竞技|多人联机|角色扮演|卡牌|策略|冒险|解谜|模拟经营|Roguelike|MMO|MOBA|搜打拆|搜打撤|塔防|音游|经营|建造|收集|狩猎|自走棋|战棋|回合|刷宝|开放世界|即时战斗|非对称竞技|类逃离塔科夫/iu;
  const lowPriority = /中国风|第一人称|高画质|DIY创造|行云流水|多端互通|跨平台|PC游戏|端游改编|小说改编|动漫改编|美少女|萌娘|卡通|怀旧向|硬核|独立游戏|买断制/iu;
  const unique = [...new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag || "").replace(/\s+/g, " ").trim()).filter(Boolean))].filter((tag) => !nonGameplay.test(tag));
  const score = (tag) => (coreGameplay.test(tag) ? 3 : lowPriority.test(tag) ? 1 : 2);
  return unique.sort((a, b) => score(b) - score(a)).slice(0, 5);
}

async function getHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const text = await r.text();
  if (!text || text.length < 300) throw new Error(`页面过短 ${url}`);
  return text;
}

// 时间线：四个面板（全部/即将上线/即将测试/即将更新），只读后三个、只保留 rel=now/tomorrow。
export async function fetchHykbItems() {
  const html = await getHtml("https://www.3839.com/timeline.html");
  const $ = load(html);
  const timelineKinds = { 1: "upcoming", 2: "test", 3: "update" };
  const timelineTabRels = $("#panelTab > li").map((_, tab) => Number($(tab).attr("rel"))).get();
  const items = [];
  $(".panelList > .foreArea").each((panelIndex, panel) => {
    const kind = timelineKinds[timelineTabRels[panelIndex]];
    if (!kind) return;
    $(panel).find(".foreCard").filter((_, card) => ["now", "tomorrow"].includes($(card).attr("rel"))).each((_, card) => {
      const group = $(card);
      const dateText = cleanTimelineDate(cleanText(group.find(".foreCard-hd").first().text()));
      if (!isWithinNextDays(dateText, 7)) return;
      // P3：更新动态仅取第一条当前更新，其余视为历史，禁止重复补入
      const lis = group.find("ul.foreList > li").toArray();
      const target = kind === "update" ? lis.slice(0, 1) : lis;
      for (const liEl of target) {
        const item = $(liEl);
        const link = item.children("a[href]").first();
        const detailUrl = resolveUrl(link.attr("href") || "", BASE);
        const gameName = extractGameName(cleanText(item.find(".name em").first().text()));
        const tags = filterGameplayTags(item.find(".tags .it").map((___, tag) => cleanText($(tag).text())).get());
        const score = cleanText(item.find(".info .score").first().text());
        const info = cleanTimelineSummary(cleanText(item.find(".info").first().text()).replace(score, "").trim());
        if (!gameName || !detailUrl || !/3839\.com\/a\/\d+\.htm/.test(detailUrl)) return;
        const title = kind === "update" ? (info || "即将更新") : `《${gameName}》${info ? ` ${info}` : kind === "test" ? " 即将测试" : " 即将上线"}`;
        const imageNode = item.find(".img img").first();
        const rawImageUrl = imageNode.attr("data-src") || imageNode.attr("src") || imageNode.attr("lz_src") || "";
        const imageUrl = rawImageUrl ? resolveUrl(rawImageUrl, BASE) : "";
        const category = kind === "update" ? "版本更新" : kind === "test" ? "测试公测" : "新游上线";
        items.push({
          legacy: `hykb:${detailUrl}`,
          gameName, title, detailUrl, imageUrl, dateText,
          paragraphs: info ? [info] : [],
          tags, category,
          facts: { haoyouKind: kind, haoyouTimelineTab: kind === "update" ? "即将更新" : kind === "test" ? "即将测试" : "即将上线", haoyouTags: tags, timelineDate: dateText, score },
        });
      }
    });
  });
  return { items, error: "" };
}
