export function stableId(sourceId, url) {
  let h = 0;
  const s = `${sourceId}:${url}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `${String(sourceId).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}-${Math.abs(h)}`;
}

function normalizeContentText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[《》【】\[\]（）()\s·•—_-]+/gu, "")
    .replace(/[，。！？!?,.:：;；"'“”‘’]/gu, "")
    .trim();
}

function normalizeGameName(value = "") {
  return normalizeContentText(value)
    .replace(/(?:官服|测试服|正式服)$/u, "")
    .replace(/(?:预下载|预约|下载|首发|公测|内测|测试|上线|发售|开放预购)$/u, "")
    .replace(/\d{1,2}月\d{1,2}日(?:开放预购|预购|首发|上线|测试)$/u, "")
    .trim();
}

export function contentDedupeKey(item = {}) {
  const game = normalizeGameName(item.gameName ?? item.game_name ?? "");
  const title = normalizeContentText(item.title ?? "");
  return game ? `${game}|${title}` : title;
}

export function dedupeByUrl(items) {
  const seen = new Set();
  const seenContent = new Set();
  return items.filter(item => {
    const k = item.detailUrl || `${item.gameName||""}:${item.title||""}`;
    const contentKey = contentDedupeKey(item);
    if (!k || seen.has(k) || (contentKey && seenContent.has(contentKey))) return false;
    seen.add(k);
    if (contentKey) seenContent.add(contentKey);
    return true;
  });
}

export function dedupeAgainstDB(items, db) {
  const urls = items.map(i => i.detailUrl).filter(Boolean);
  if (!urls.length) return items;
  const ph = urls.map(() => "?").join(",");
  const ex = db.prepare(`SELECT detail_url,game_name,title FROM articles WHERE detail_url IN (${ph})`).all(...urls);
  const set = new Set(ex.map(r => r.detail_url));
  const content = new Set(ex.map(contentDedupeKey).filter(Boolean));
  return items.filter(i => !set.has(i.detailUrl) && (!contentDedupeKey(i) || !content.has(contentDedupeKey(i))));
}
