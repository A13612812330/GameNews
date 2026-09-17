const TRAILING_META = /\s*(?:刚刚|\d+\s*(?:分钟|小时|天)前)\s*\d*\s*喜欢\s*[•·]\s*\d*\s*评论\s*$/iu;
const NON_GAME = /抽奖|周边|手办|模型|书籍|小说|电影|电视剧|爆米花桶|招聘|影评|播客|电台|广告|媒体评分|评分汇总|评分|奖项|展台|ChinaJoy回顾|聊天AI应用|遗作|长篇作品|出版|特卖|折扣|免费领|喜加一/iu;
const GAME_SIGNAL = /《[^》]{2,36}》|游戏|手游|端游|主机|独立游戏|RPG|FPS|MMORPG|Steam|PlayStation|Xbox|任天堂|版本更新|赛季|联动|测试|发售|预售|实机|预告|愿望单|销量/iu;
const OFFICIAL_EVENT = /官方|官宣|公布|发布|上线|发售|预售|更新|版本|补丁|测试|实机|定档|开放|开发完成|合作|联动|销量|推出.*(?:新章节|新作|新内容)|新章节/iu;

export function cleanTitle(title = "") {
  return String(title).replace(/\s+/g, " ").replace(TRAILING_META, "").trim();
}

export function extractGameName(title = "") {
  const value = cleanTitle(title);
  const matches = [...value.matchAll(/《([^》]{2,36})》/gu)].map(match => match[1].trim());
  if (matches.length) return matches[0];
  return "";
}

export function contentFilter(title = "") {
  const value = cleanTitle(title);
  if (value.length < 8 || NON_GAME.test(value)) return false;
  return GAME_SIGNAL.test(value) && OFFICIAL_EVENT.test(value);
}

export function isDetailUrl(url) { try { const u=new URL(url); return u.hostname.includes("gcores.com")&&/\/articles\/\d+/.test(u.pathname); } catch { return false; } }
