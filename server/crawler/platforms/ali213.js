export function contentFilter(t="") { if(t.length<10||/攻略|修改器|补丁|MOD|汉化|破解/iu.test(t)) return false; return /《[^》]{2,36}》/.test(t)||/游戏|手游|端游|新作|上线|发售/.test(t); }
export function isDetailUrl(url) { try { const u=new URL(url); return u.hostname.includes("ali213.net")&&/\/news\/html\/\d{4}-\d+\/\d+\.html?$/.test(u.pathname); } catch { return false; } }
