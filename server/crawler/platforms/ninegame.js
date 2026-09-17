export function contentFilter(t = "") {
  if (t.length < 8) return false;
  if (/攻略|下载|开服表|广告|礼包|兑换|扫码/.test(t)) return false;
  if (/排行榜|排行前十|不容错过|好玩的游戏|必玩|推荐合集|手游推荐/i.test(t)) return false;
  if (/公告|声明|通知|须知$/.test(t) && !/[《》]/.test(t)) return false;
  return true;
}
export function isDetailUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("9game.cn")) return false;
    if (/\/download\//.test(u.pathname) || /\/gift\//.test(u.pathname)) return false;
    // 排除2025年及以前的旧新闻
    const m = /\/news\/(\d{4})\//.exec(u.pathname);
    if (m && parseInt(m[1]) < 2026) return false;
    return true;
  } catch { return false; }
}
