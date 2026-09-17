export function contentFilter(title = "") {
  const noise = /论坛|讨论|社区|话题|回复|楼主|评分|评分卡|排行|TOP\d+|合集|日历|即将上线|编辑推荐|玩家评价|热门标签|合集推荐|猜你喜欢|为你推荐|抽奖|开奖|幸运用户|预约人数|下载量|人气值|快爆攻略|开服表|兑换码|礼包|夏促|特卖|特惠|折扣|直播|免单|券|红包|福袋|签到|风评|收购|项目组|ChinaJoy|高分|趣闻|数学家|续作|曝光|平账|开发商|老资历|值得被看见|玩家竟/iu;
  if (title.length < 10 || noise.test(title)) return false;
  if (/^(你|我|大家|各位|有人|有没有|求助|请问)/u.test(title)) return false;
  if (/[？?]$/u.test(title)) return false;
  if (/PC游戏|端游|Steam|Epic|主机|PS4|PS5|Xbox|Switch|PC\b/i.test(title)) return false;
  const hasInfoSignal = /上线|开测|测试|公测|内测|首测|二测|预约|联动|版本更新|版本|赛季|资料片|活动公告|活动|首发|定档|开服|福利|招募|实机|维护|公告/iu.test(title);
  return hasInfoSignal && (/《[^》]{2,36}》/.test(title) || /游戏|手游|新游|新作|版本|测试|上线|首发/iu.test(title));
}

// 时间线卡片把“游戏名、玩法标签、评分、活动文案”拼在同一个链接文本里。
// 只在好游适配器内归一化，避免影响其他平台的游戏名推断。
export function extractGameName(title = "") {
  let value = String(title || "").replace(/\s+/g, " ").trim();
  value = value.replace(/^《|》$/g, "").trim();
  value = value.replace(/[（(]\s*(?:官服|测试服|体验服|先遣服|渠道服|国际服)\s*[）)]/giu, "");
  value = value.replace(/[-—–]\s*(?:新版本预约|版本预约|新游预约).*$/iu, "");
  // 上架前的“预下载 / 预购 / 带日期预购”是运营状态，不属于游戏正式名。
  value = value.replace(/[-—–]\s*(?:(?:\d{1,2}月\d{1,2}日)\s*)?(?:开放)?(?:预下载|预购|预售|预约下载|预约开启).*$/iu, "");
  // 时间线会把运营节点接在正式名后，例如“S3赛季 / 二周年 / 4.4版本”。
  // 这类属于条目状态，不能作为跨平台去重和展示用游戏名的一部分。
  value = value.replace(/[-—–]\s*(?:S\d+(?:[.·]\d+)?赛季|[一二三四五六七八九十百\d]+周年(?:庆典)?|v?\d+(?:\.\d+){1,3}(?:版本)?).*$/iu, "");
  // “-火车山谷2手游”这类是副标题/平台标记，正式名以前半段为准。
  value = value.replace(/[-—–]\s*[^—–]{1,60}?(?:手游|移动版|手机版).*$/iu, "");
  // 部分时间线把对战模式写进名称，例如“第五人格-1v4对抗”。
  // 这类是玩法描述，不属于正式游戏名。
  value = value.replace(/[-—–]\s*(?:\d+\s*[vV]\s*\d+\s*)?(?:对抗|竞技|战斗|射击|冒险|策略|卡牌).*$/iu, "");
  // 时间线偶尔把玩法卖点写进名称，例如“雾海之下-‘吃’打撤新游(官服)”。
  // 该段不是作品正式名，只在好游候选阶段移除。
  value = value.replace(/[-—–]\s*[“”"'‘’]?[^—–]*?(?:新游|新作|预约|首发|上线|测试|体验|招募|开服).*$/iu, "");
  value = value.replace(/\s+(?:新版本预约|版本预约|招募中|体验服招募中).*$/iu, "");
  // 玩法标签通常紧跟在名称后，以“角色扮演/动作/多人联机”等词开头。
  value = value.replace(/\s+(?=(?:动漫改编|多人联机|开放世界|角色扮演|动作|策略|卡牌|冒险|模拟经营|模拟|休闲|射击|格斗|音游|解谜|悬疑|仙侠|国漫|足球|航海|沙盒|生存|塔防|Roguelike|MMO|ARPG|SLG|FPS|放置|社交|第一人称|女性向|多平台|江湖|文字|烹饪|建造|即时战斗|搜打撤|吃鸡|竖屏|国风|中国风|萌娘|剧情|横版|刷宝|佛系|竞技|宠物|收集)).*$/iu, "");
  value = value.replace(/\s+\d+(?:\.\d+)?\s+.*$/u, "");
  value = value.replace(/\s+(?:已于|预计|正式|限量|删档|不删档|首曝|定档|开启|更新|上线|测试|预约|海外|具体几点).*$/iu, "");
  return value.replace(/[：:、，,。．.\-—–]+$/u, "").trim() || String(title || "").trim();
}

// 时间线“信息”字段与玩法标签、下载按钮混在同一行时，只保留可阅读的资讯文案。
// 玩法标签仍单独写入 facts.haoyouTags，供卡片胶囊使用。
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

export function cleanUpdateTitle(value = "", gameName = "") {
  let title = cleanDetailTitle(value);
  const name = extractGameName(gameName);
  if (name) {
    // 好游更新标题常把“(官服)”写进书名号，候选侧已清成正式名；
    // 先按同一清洗规则比较并移除整个前置游戏名，避免留下重复标题。
    title = title.replace(/^\s*《([^》]{1,80})》\s*/u, (whole, leadingName) =>
      extractGameName(leadingName) === name ? "" : whole,
    );
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(new RegExp(`^\\s*《?${escaped}》?\\s*`, "iu"), "");
  }
  return title.replace(/^\s*[-—–:：]+\s*/u, "").trim();
}

// 游戏详情页的“更新动态”会保留整份历史时间线。只允许使用列表第一项：
// span 是快爆收录日期，p 开头的“8月21日更新：”才是实际活动日期。
export function parseCurrentUpdate(recordedAt = "", updateText = "", gameName = "") {
  const source = String(updateText || "").replace(/\s+/gu, " ").trim();
  const match = /^(?:已于|将于)?\s*(?:(20\d{2})[年./-])?(\d{1,2})月(\d{1,2})日(?:\s*(?:上午|下午|早|晚)?\s*\d{1,2}(?::\d{2}|点(?:\d{1,2}分?)?)?)?\s*(?:更新|上线|开启|测试|首发)?\s*[:：]?/u.exec(source);
  return {
    recordedAt: String(recordedAt || "").replace(/\s+/gu, "").trim(),
    eventDateText: match ? `${match[2]}月${match[3]}日` : "",
    title: cleanUpdateTitle(source, gameName),
  };
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

// 好游快爆游戏页的“评价”tab 只取 pl_num，不把论坛回帖数混作评价数。
export function extractHaoyouReviewCount(html = "") {
  const source = String(html || "");
  const match = /<li[^>]*id=["']pj_tab["'][^>]*>[\s\S]{0,800}?<span[^>]*id=["']pl_num["'][^>]*>\s*([\d.,]+\s*[万亿]?)\s*<\/span>/iu.exec(source);
  if (match) return parseDisplayCount(match[1]);
  const compact = /<div[^>]*class=["'][^"']*\bsp-txt\b[^"']*["'][^>]*>[\s\S]{0,300}?([\d.,]+\s*[万亿]?)\s*人\s*评价/iu.exec(source);
  return parseDisplayCount(compact?.[1] || "");
}

// 好游快爆详情页预约量位于游戏信息块：`<p class="sp-info">... 125.8万预约人数</p>`。
// 仅接受同一信息块中的“预约人数”，不读取论坛数、下载量或评价数。
export function extractHaoyouReserveCount(html = "") {
  const source = String(html || "");
  const match = /<p[^>]*class=["'][^"']*\bsp-info\b[^"']*["'][^>]*>[\s\S]{0,500}?([\d.]+\s*[万亿]?)\s*预约人数/iu.exec(source);
  if (match) return parseDisplayCount(match[1]);
  const compact = /<div[^>]*class=["'][^"']*frag-li[^"']*["'][^>]*>[\s\S]{0,500}?<(?:div|span)[^>]*class=["'][^"']*sp-val[^"']*["'][^>]*>\s*([\d.,]+\s*[万亿]?)\s*<\/(?:div|span)>[\s\S]{0,300}?<div[^>]*class=["'][^"']*sp2[^"']*["'][^>]*>\s*预约人数\s*<\/div>/iu.exec(source);
  return parseDisplayCount(compact?.[1] || "");
}

// 好游快爆部分新游没有预约人数，会展示“关注人数”。仅作为新游指标的第二兜底。
export function extractHaoyouFollowerCount(html = "") {
  const source = String(html || "");
  const match = /<div[^>]*class=["'][^"']*\bfrag-li\b[^"']*["'][^>]*>[\s\S]{0,500}?<(?:div|span)[^>]*class=["'][^"']*\bsp-val\b[^"']*["'][^>]*>\s*([\d.,]+\s*[万亿]?)\s*<\/(?:div|span)>[\s\S]{0,300}?<div[^>]*class=["'][^"']*\bsp2\b[^"']*["'][^>]*>\s*关注人数\s*<\/div>/iu.exec(source);
  return parseDisplayCount(match?.[1] || "");
}

// 仅接受指向 /cp/ 的厂商链接，避免取到正文或论坛中的普通超链接。
export function extractHaoyouPublisher(html = "") {
  const source = String(html || "");
  const values = [];
  const labeledValues = [];
  // 详情页信息列表结构：<li><span>发行：</span><a .../cp/15048.html>Level Infinite</a></li>
  for (const match of source.matchAll(/<li[^>]*>[\s\S]{0,180}?<span[^>]*>\s*(开发商|开发|厂商|发行商|发行|运营方|运营商|运营)\s*[:：]?\s*<\/span>[\s\S]{0,300}?<a[^>]*href=["'](?:(?:https?:)?\/\/)?(?:www\.)?3839\.com\/cp\/\d+\.html["'][^>]*>\s*([\s\S]*?)\s*<\/a>/giu)) {
    const value = String(match[2] || "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
    if (value && !/官方已入驻/iu.test(value)) labeledValues.push(value);
  }
  if (labeledValues.length) return labeledValues[0];
  // 游戏详情信息表：开发商 / 厂商 / 发行商 / 运营方。兼容绝对、协议相对和站内相对 cp 链接。
  for (const match of source.matchAll(/<t[dh][^>]*>[\s\S]{0,500}?<(?:em|span)>\s*(开发商|开发|厂商|发行商|发行|运营方|运营商|运营)\s*<\/(?:em|span)>[\s\S]{0,500}?<a[^>]*href=["'](?:(?:https?:)?\/\/(?:www\.)?3839\.com)?\/cp\/\d+\.html["'][^>]*>\s*([\s\S]*?)\s*<\/a>/giu)) {
    values.push(String(match[2] || "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim());
  }
  // 快爆卡片信息：开发：<a .../cp/xxx.html>公司名</a>。
  for (const match of source.matchAll(/<(?:span|em)[^>]*>\s*(?:开发|开发商|厂商|发行|发行商|运营方|运营商|运营)\s*[:：]?\s*<\/(?:span|em)>[\s\S]{0,300}?<a[^>]*href=["'](?:(?:https?:)?\/\/(?:www\.)?3839\.com)?\/cp\/\d+\.html["'][^>]*>\s*([\s\S]*?)\s*<\/a>/giu)) {
    values.push(String(match[1] || "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim());
  }
  // 最后兼容旧版直接出现的 cp 链接，但仍只接受实体公司/工作室名称。
  values.push(...[...source.matchAll(/<a[^>]*href=["'](?:(?:https?:)?\/\/(?:www\.)?3839\.com)?\/cp\/\d+\.html["'][^>]*>\s*([\s\S]*?)\s*<\/a>/giu)]
    .map((match) => String(match[1] || "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim()));
  const filtered = values
    .filter(Boolean);
  // “官方已入驻”只是账号状态，不是厂商名称；优先公司/工作室等实体名称。
  return filtered.find((value) => /(公司|工作室|网络|科技|游戏|互动|文化|传媒)/u.test(value) && !/官方已入驻/u.test(value)) || "";
}

export function filterGameplayTags(tags = []) {
  // 详情页的 `ul.cf` 在部分游戏页会退化成分享栏；QQ/微信/论坛数量不是玩法标签。
  const nonGameplay = /^(编辑推荐|力荐佳作|多平台|多端互通|Steam移植|PC游戏|Android|iOS|主机|跨平台|官服|预约|预下载|下载|推荐|热门|精品|高分|新游|新作|手游|端游|网游|单机|免费|测试服|编辑器|独立游戏|买断制|硬核|怀旧向|QQ|微信|QQ空间|微博|朋友圈|分享|论坛(?:\d+)?|讨论(?:\d+)?|社区|话题|回复(?:\d+)?)$/iu;
  const lowPriority = /中国风|第一人称|高画质|DIY创造|行云流水|多端互通|跨平台|PC游戏|端游改编|小说改编|动漫改编|美少女|萌娘|卡通|怀旧向|硬核|独立游戏|买断制/iu;
  const coreGameplay = /动作|射击|格斗|生存|沙盒|竞技|多人联机|角色扮演|卡牌|策略|冒险|解谜|模拟经营|Roguelike|MMO|MOBA|搜打拆|搜打撤|塔防|音游|经营|建造|收集|狩猎|自走棋|战棋|回合|刷宝|开放世界|即时战斗|非对称竞技|类逃离塔科夫/iu;
  const unique = [...new Set((Array.isArray(tags) ? tags : []).map(tag => String(tag || '').replace(/\s+/g, ' ').trim()).filter(Boolean))]
    .filter(tag => !nonGameplay.test(tag));
  return unique
    .sort((a, b) => {
      const score = tag => (coreGameplay.test(tag) ? 3 : lowPriority.test(tag) ? 1 : 2);
      return score(b) - score(a);
    })
    .slice(0, 5);
}

export function cleanTimelineDate(value = "") {
  return String(value || '')
    .replace(/\s+(?:今天|明天|后天|昨天|前天|上周[一二三四五六日]|周[一二三四五六日]|下周[一二三四五六日]).*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isWithinNextDays(value = "", days = 7) {
  const match = /^(\d{1,2})月(\d{1,2})日/u.exec(String(value || '').trim());
  if (!match) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]));
  if (target.getTime() < today.getTime() && now.getMonth() >= 10 && Number(match[1]) <= 3) {
    target = new Date(now.getFullYear() + 1, Number(match[1]) - 1, Number(match[2]));
  }
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  return diff >= 0 && diff <= days;
}

export function cleanDetailTitle(value = "") {
  return String(value || '')
    .replace(/^\s*(?:将于)?\d{1,2}月\d{1,2}日\s*(?:\([^)]*\))?\s*(?:更新|上线|测试|活动)?\s*(?:[:：]\s*)?/u, '')
    .replace(/([；;]\s*)(?:将于)?\d{1,2}月\d{1,2}日\s*(?:\([^)]*\))?\s*(?:更新|上线|测试|活动)?\s*(?:[:：]\s*)?/u, '$1')
    .trim();
}

export function isDetailUrl(url) {
  try {
    const u = new URL(url);
    if (/\/forum-\d+\.htm/.test(u.pathname)) return false; // 版块首页，非文章
    return u.hostname.includes("3839.com") && (/\/thread-\d+\.htm/.test(u.pathname) || /\/a\/\d+\.htm/.test(u.pathname));
  } catch { return false; }
}
