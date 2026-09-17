// 严格官方资讯模式：游民星空只保留可核验的产品动态，不收录玩家反应、审美图集、争议八卦和未经证实的传闻。
const NOISE = /卖掉|白菜价|硬件|配件|周边|招聘|行业报告|玩家|调侃|吐槽|美图|脸模|颜值|身材|雕像|手办|壁纸|表情包|COS|偷拍|丑闻|争议|LGBT|炒冷饭|媒体评分|评分汇总|差评|攻略|MOD|影视|电影|电视剧|爆料|曝[：：]|传闻|或将|有可能|前员工称|光驱|显卡|CPU|性能测试|包装/iu;
const OFFICIAL_SIGNAL = /官方|官宣|公布|发布|上线|发售|预售|更新|版本|补丁|DLC|测试|实机|定档|预约|开放|开发完成|推出|登陆|登录|版号|销量|财报|合作|联动/iu;
const GAME_CONTEXT = /《[^》]{2,36}》|游戏|手游|端游|新作|版本|赛季|联动|更新|发售|测试|预售|实机|预告|DLC|Steam|Xbox|任天堂|PS[45]|PlayStation/iu;

export function cleanTitle(title = "") { return String(title).replace(/\s+/g, " ").trim(); }
export function extractGameName(title = "") { return /《([^》]{2,36})》/u.exec(cleanTitle(title))?.[1]?.trim() || ""; }
export function contentFilter(title = "") { const value=cleanTitle(title); return value.length >= 10 && !NOISE.test(value) && GAME_CONTEXT.test(value) && OFFICIAL_SIGNAL.test(value); }
export function isDetailUrl(url) { try { const u=new URL(url); return u.hostname.includes("gamersky.com")&&/\/news\/\d{6}\/\d+\.shtml$/.test(u.pathname); } catch { return false; } }
