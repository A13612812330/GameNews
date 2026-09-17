import fs from "node:fs/promises";
import path from "node:path";
import { readWeeklyMaterialSnapshots } from "./weeklySnapshots.js";
import { cleanUpdateTitle, extractGameName as extractHaoyouGameName } from "./crawler/platforms/haoyou.js";

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function cleanText(value = "") {
  return String(value).replace(/<br\s*\/?>(\s*)/giu, " ").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
}

function cleanGameName(value = "", sourceId = "") {
  const raw = cleanText(value);
  // 好游快爆时间线会把运营活动拼进游戏名，例如“游戏名-送2600限时三角券”。
  // 周报展示和跨平台合并必须先回到正式游戏名，避免同一游戏拆成两个条目。
  const sourceCleaned = sourceId === "ref-haoyou" ? extractHaoyouGameName(raw) : raw;
  return sourceCleaned
    .replace(/[《》]/gu, "")
    .replace(/[（(](?:官服|测试服|正式服)[）)]/giu, "")
    .replace(/[\-—–]\s*(?:预下载|预约|下载|首发|公测|内测|测试|上线|发售|开放预购|至冬开放|新版本|版本更新|更新|活动|联动|赛季|周年庆?|限时|福利|开服|开放|首曝).*$/giu, "")
    .replace(/[\-—–]\s*(?:送|赠|领|免费领|限时领|登录领|预约赢|参与).*$/giu, "")
    .trim();
}

function gameKey(article = {}) {
  return cleanGameName(article.game_name || article.title || "", article.source_id).replace(/[\s\-_:：·・]/gu, "").toLowerCase();
}

function tagsFor(article = {}) {
  const facts = article.facts || {};
  const raw = facts.steamTags || facts.taptapTags || facts.haoyouTags || [];
  return (Array.isArray(raw) ? raw : String(raw).split(/[\s,，;；/|]+/u)).map((tag) => cleanText(tag)).filter(Boolean).slice(0, 5);
}

function assetUrl(value = "", assetBase) {
  if (!value) return "";
  if (String(value).startsWith("/crawler-assets/") || String(value).startsWith("/weekly-assets/")) return `${assetBase}${value}`;
  if (String(value).startsWith("/api/image-proxy")) return `${assetBase}${value}`;
  return ["ref-taptap", "ref-haoyou", "ref-gcores", "ref-gamersky"].includes(String(value.source_id || "")) ? `${assetBase}/api/image-proxy?url=${encodeURIComponent(value)}` : value;
}

function imageFor(article, assetBase) {
  const images = Array.isArray(article.images) ? article.images : [];
  const localValue = (item) => item?.localUrl || item?.src || item?.originalUrl || item?.url || "";
  const saved = images.find((item) => String(localValue(item)).startsWith("/weekly-assets/"))
    || images.find((item) => String(localValue(item)).startsWith("/crawler-assets/"))
    || images[0];
  // 周报快照已把图片落盘时，必须优先本地路径；否则会重新走不稳定的源站图片。
  const value = saved?.localUrl || saved?.src || saved?.originalUrl || article.image_url || "";
  if (!value) return "";
  if (String(value).startsWith("/crawler-assets/") || String(value).startsWith("/weekly-assets/") || String(value).startsWith("/api/image-proxy")) return `${assetBase}${value}`;
  return ["ref-taptap", "ref-haoyou", "ref-gcores", "ref-gamersky"].includes(article.source_id)
    ? `${assetBase}/api/image-proxy?url=${encodeURIComponent(value)}`
    : value;
}

function iconFor(article, assetBase) {
  const value = article.image_url || "";
  if (!value) return imageFor(article, assetBase);
  if (String(value).startsWith("/crawler-assets/") || String(value).startsWith("/weekly-assets/") || String(value).startsWith("/api/image-proxy")) return `${assetBase}${value}`;
  return ["ref-taptap", "ref-haoyou"].includes(article.source_id)
    ? `${assetBase}/api/image-proxy?url=${encodeURIComponent(value)}`
    : value;
}

function summaryFor(article = {}) {
  const facts = article.facts || {};
  return cleanText(facts.steamDescriptionSnippet || facts.haoyouIntro || facts.haoyouUpdateContent || article.paragraphs?.find(Boolean) || "暂无正文摘要");
}

function cardTitle(article = {}, game = "") {
  const raw = cleanText(article.title || game);
  const escapedGame = game.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const withoutGame = escapedGame
    ? raw.replace(new RegExp(`(?:《\\s*)?${escapedGame}(?:\\s*》)?[-：:·—\\s]*`, "giu"), "").trim()
    : raw;
  return withoutGame || raw || "本周重点内容";
}

function titleForSection(title = "", section = "") {
  if (section !== "new") return title;
  const cleaned = cleanText(title)
    .replace(/(?:今天|今日|昨天|昨日|明天)\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*\d{0,2}\s*(?:点|时)?\s*/gu, "")
    .replace(/^(?:\d{1,2}月\d{1,2}日)\s*/u, "")
    .trim();
  return cleaned || "首发";
}

function cardSummary(article = {}) {
  const text = summaryFor(article).replace(/^(?:简介|游戏介绍|内容)[：:]/u, "").trim();
  return text.length > 92 ? `${text.slice(0, 92)}…` : text;
}

function shortMonthDay(value = "", fallback = "") {
  const text = cleanText(value);
  const chinese = text.match(/(\d{1,2})月(\d{1,2})日/u);
  // 统一去掉日期中的补零：08月12日 与 8月12日必须落在同一个时间树节点。
  if (chinese) return `${Number(chinese[1])}月${Number(chinese[2])}日`;
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/u);
  if (iso) return `${Number(iso[2])}月${Number(iso[3])}日`;
  const fallbackText = cleanText(fallback);
  const fallbackIso = fallbackText.match(/(\d{4})-(\d{2})-(\d{2})/u);
  if (fallbackIso) return `${Number(fallbackIso[2])}月${Number(fallbackIso[3])}日`;
  const fallbackChinese = fallbackText.match(/(\d{1,2})月(\d{1,2})日/u);
  if (fallbackChinese) return `${Number(fallbackChinese[1])}月${Number(fallbackChinese[2])}日`;
  return "本周";
}

function sectionLabel(section) {
  return ({ new: "重点新游", events: "版本更新", steam: "Steam 榜单", editorial: "端游资讯" })[section] || "游戏资讯";
}

function eventUpdatedAt(article = "") {
  const events = Array.isArray(article?.facts?.taptapEvents) ? article.facts.taptapEvents : [];
  const status = cleanText(events.find((event) => event?.status)?.status || "");
  if (status) return status;
  return shortMonthDay(article?.date_text || "", article?.__snapshotDate || "");
}

function dateSortValue(article = {}) {
  const text = cleanText(article.date_text || article.__snapshotDate || "");
  const match = text.match(/(\d{1,2})月(\d{1,2})日/u) || text.match(/\d{4}-(\d{2})-(\d{2})/u);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 100 + Number(match[2]);
}

function bodyFor(article, assetBase) {
  const facts = article.facts || {};
  const layouts = [facts.gcoresLayout, facts.gamerskyLayout, facts.haoyouLayout].find(Array.isArray) || [];
  const image = (item) => {
    const value = item?.localUrl || item?.src || item?.originalUrl || item?.url || item;
    const src = value && (String(value).startsWith("/") ? `${assetBase}${value}` : imageFor({ ...article, images: [{ src: value }] }, assetBase));
    return src ? `<figure class="weekly-body-image"><img src="${escapeHtml(src)}" alt="" loading="lazy"></figure>` : "";
  };
  if (layouts.length) return layouts.map((block) => {
    if (block?.type === "image") return image(block);
    const text = block?.text || (block?.segments || []).map((segment) => segment?.text || "").join("");
    return text ? `<p${block?.quote ? ' class="is-quote"' : ""}>${escapeHtml(text)}</p>` : "";
  }).join("") || "<p>该资讯暂未获取到可展示正文。</p>";
  const event = Array.isArray(facts.taptapEvents) ? facts.taptapEvents[0] : null;
  if (event?.blocks?.length) return event.blocks.map((section) => `<section class="weekly-event-section"><h4>${escapeHtml(section.title || "活动内容")}</h4>${(section.items || []).map((item) => `<div><h5>${escapeHtml(item.title || "")}</h5><p>${escapeHtml(item.content || "")}</p>${(item.images || []).map(image).join("")}</div>`).join("")}</section>`).join("");
  const text = (article.paragraphs || []).filter(Boolean).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
  return text || "<p>该资讯暂未获取到可展示正文。</p>";
}

function sourcePriority(article) {
  if (article.source_id === "ref-taptap") return 100;
  if (article.source_id === "ref-steam") return 90;
  if (article.source_id === "ref-gcores" || article.source_id === "ref-gamersky") return 80;
  if (article.source_id === "ref-haoyou") return 70;
  return 0;
}

function completeness(article) {
  const facts = article.facts || {};
  const layout = [facts.gcoresLayout, facts.gamerskyLayout, facts.haoyouLayout].find(Array.isArray)?.length || 0;
  const events = Array.isArray(facts.taptapEvents) ? facts.taptapEvents.reduce((total, event) => total + (event?.blocks?.length || 0), 0) : 0;
  return summaryFor(article).length + layout * 180 + events * 260 + (article.images?.length || 0) * 80 + (article.score || 0);
}

function editorialQuality(article = {}) {
  const facts = article.facts || {};
  const layout = Array.isArray(facts.gcoresLayout)
    ? facts.gcoresLayout.length
    : Array.isArray(facts.gamerskyLayout)
      ? facts.gamerskyLayout.length
      : 0;
  const textLength = (article.paragraphs || []).join(" ").trim().length;
  const imageCount = Array.isArray(article.images) ? article.images.length : 0;
  return Number(article.score || 0) + Math.min(textLength, 1600) / 40 + layout * 5 + imageCount * 4;
}

function latestDistinct(rows = []) {
  const winner = new Map();
  for (const article of rows) {
    const key = `${article.source_id}:${article.id || ""}:${article.detail_url || article.title}`;
    const current = winner.get(key);
    if (!current || String(article.__snapshotDate || "") > String(current.__snapshotDate || "") || completeness(article) > completeness(current)) winner.set(key, article);
  }
  return [...winner.values()];
}

function dedupeByGame(rows = [], { preferTapTap = false } = {}) {
  const winner = new Map();
  for (const article of rows) {
    const key = gameKey(article);
    if (!key) continue;
    const current = winner.get(key);
    if (!current) { winner.set(key, article); continue; }
    const candidatePriority = sourcePriority(article) + (preferTapTap && article.source_id === "ref-taptap" ? 1000 : 0);
    const currentPriority = sourcePriority(current) + (preferTapTap && current.source_id === "ref-taptap" ? 1000 : 0);
    if (candidatePriority > currentPriority || (candidatePriority === currentPriority && completeness(article) > completeness(current))) winner.set(key, article);
  }
  return [...winner.values()];
}

function eventKey(article) {
  const game = gameKey(article);
  const title = cleanText(article.title || "").replace(new RegExp(game.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"), "").replace(/(?:版本|更新|活动|联动|开启|上线|游戏|限时|全新)/gu, "");
  return `${game}:${title.slice(0, 30)}`;
}

function dedupeEvents(rows = []) {
  const winner = new Map();
  for (const article of rows) {
    const key = eventKey(article);
    const current = winner.get(key);
    if (!current || sourcePriority(article) > sourcePriority(current) || (sourcePriority(article) === sourcePriority(current) && completeness(article) > completeness(current))) winner.set(key, article);
  }
  return [...winner.values()];
}

function preferTapTapForSameGame(rows = []) {
  const taptapGames = new Set(rows
    .filter((article) => article.source_id === "ref-taptap")
    .map((article) => gameKey(article))
    .filter(Boolean));
  return rows.filter((article) => article.source_id === "ref-taptap" || !taptapGames.has(gameKey(article)));
}

function classify(article) {
  const facts = article.facts || {};
  if (article.source_id === "ref-steam") {
    if (facts.steamList === "new") return "newGames";
    if (["most_played", "top_selling_cn"].includes(facts.steamList)) return "steam";
  }
  if (article.source_id === "ref-taptap") {
    if (Array.isArray(facts.taptapEvents) && facts.taptapEvents.length) return "events";
    if (/\/game-event\//u.test(article.detail_url || "")) return "events";
    if (!/\/forum\/hot\/hashtags\?item=/u.test(article.detail_url || "")) return "newGames";
  }
  if (article.source_id === "ref-haoyou") {
    // 入口可以把“已上线游戏的运营活动”标成 upcoming；详情页已经抓到更新/联动内容时，
    // 以详情为准写入活动列，不能当作新游。三角洲行动属于这一类。
    const updateText = cleanText(facts.haoyouUpdateContent || "");
    if (facts.haoyouKind === "update" || /(?:版本|更新|活动|联动|赛季|周年|福利|开启)/u.test(updateText)) return "events";
    return "newGames";
  }
  if (["ref-gcores", "ref-gamersky"].includes(article.source_id)) return "editorial";
  return null;
}

function steamHighlightRows(rows) {
  const grouped = new Map();
  for (const article of rows) {
    const facts = article.facts || {};
    const gain = Number(facts.steamRankGain || 0);
    const isNew = Boolean(facts.steamRankBaselineKnown && facts.steamRankNewEntry);
    if (!isNew && gain < 5) continue;
    const key = gameKey(article);
    if (!key) continue;
    const list = grouped.get(key) || [];
    list.push(article);
    grouped.set(key, list);
  }
  return [...grouped.values()].map((list) => {
    const selected = [...list].sort((left, right) => Number((right.facts || {}).steamRankGain || 0) - Number((left.facts || {}).steamRankGain || 0) || Number((left.facts || {}).steamRankCurrent || 999) - Number((right.facts || {}).steamRankCurrent || 999))[0];
    const facts = selected.facts || {};
    return { ...selected, __steamGain: Math.max(...list.map((item) => Number((item.facts || {}).steamRankGain || 0))), __steamNew: list.some((item) => Boolean(item.facts?.steamRankBaselineKnown && item.facts?.steamRankNewEntry)) };
  }).sort((left, right) => Number(right.__steamNew) - Number(left.__steamNew) || right.__steamGain - left.__steamGain || Number(left.facts?.steamRankCurrent || 999) - Number(right.facts?.steamRankCurrent || 999));
}

function card(article, assetBase, section, index) {
  const game = cleanGameName(article.game_name, article.source_id) || "未识别游戏";
  const image = section === "new" ? iconFor(article, assetBase) : imageFor(article, assetBase);
  const haoyouEventTitle = section === "events" && article.source_id === "ref-haoyou"
    ? cleanUpdateTitle(article.facts?.haoyouUpdateContent || "", game)
    : "";
  // 端游资讯不是游戏详情页：game_name 常由标题猜测，误判率高，展示原始资讯标题即可。
  const title = section === "editorial"
    ? cleanText(article.title || "端游资讯")
    : titleForSection(haoyouEventTitle || cardTitle(article, game), section);
  const date = cleanText(article.date_text || article.__snapshotDate || "本周");
  const shortDate = shortMonthDay(date, article.__snapshotDate);
  const original = article.detail_url || "#";
  const steamFacts = article.facts || {};
  const steamMeta = section === "steam" ? `${article.__steamNew ? "新上榜" : `排名提升 ${article.__steamGain || 0}`} · ${steamFacts.steamList === "most_played" ? "热玩榜" : "畅销榜"} #${steamFacts.steamRankCurrent || "—"}` : "";
  const meta = section === "new"
    ? ""
    : section === "events"
      ? ""
      : section === "editorial"
        ? ""
      : `<div class="weekly-meta"><span>${escapeHtml(sectionLabel(section))}</span><time>${escapeHtml(shortDate)}</time></div>`;
  const gameHeading = section === "editorial" ? "" : `<h3>《${escapeHtml(game)}》</h3>`;
  const eventTitle = section === "events"
    ? `<div class="weekly-event-title-line"><h4>${escapeHtml(title)}</h4>${article.__timeline ? "" : `<time>${escapeHtml(shortMonthDay(eventUpdatedAt(article), article.__snapshotDate))}</time>`}</div>`
    : section === "editorial"
      ? `<div class="weekly-editorial-title-line"><h4>${escapeHtml(title)}</h4><time>${escapeHtml(shortDate)}</time></div>`
      : `<h4>${escapeHtml(title)}</h4>`;
  const summary = ["new", "events"].includes(section) ? "" : `<p>${escapeHtml(cardSummary(article))}</p>`;
  const kind = section === "new" ? '<span class="weekly-kind weekly-kind--new">新游</span>' : section === "events" ? '<span class="weekly-kind weekly-kind--events">活动</span>' : "";
  const newTags = section === "new"
    ? `<div class="weekly-new-tags">${tagsFor(article).slice(0, 3).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";
  return `<article class="weekly-card weekly-card--${section}${image ? " has-image" : ""}">
    <a class="weekly-card-link" href="${escapeHtml(original)}" target="_blank" rel="noreferrer">
      <div class="weekly-cover${image ? "" : " is-empty"}">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(game)}" loading="eager" onerror="this.closest('.weekly-card')?.classList.remove('has-image');this.parentElement?.remove()">` : `<b>${escapeHtml(game.slice(0, 2))}</b>`}</div>
      <div class="weekly-copy">${meta}${kind}${gameHeading}${eventTitle}${newTags}${steamMeta ? `<div class="weekly-rank">${escapeHtml(steamMeta)}</div>` : ""}${summary}</div>
    </a>
  </article>`;
}

function sectionMarkup(number, title, rows, assetBase, key, limit) {
  if (!rows.length) return "";
  const selected = rows.slice(0, limit);
  const content = `<div class="weekly-grid">${selected.map((article, index) => card(article, assetBase, key, index)).join("") || '<p class="weekly-empty">本周暂无符合条件的资讯。</p>'}</div>`;
  return `<section class="weekly-section weekly-section--${key}"><header><span>${number}</span><h2>${escapeHtml(title)}</h2><small>${selected.length} 条</small></header>${content}</section>`;
}

function newActivityTimelineMarkup(newRows, eventRows, assetBase, number = "01") {
  if (!newRows.length && !eventRows.length) return "";
  const groups = new Map();
  const add = (side, article) => {
    const date = side === "events"
      ? shortMonthDay(eventUpdatedAt(article), article.__snapshotDate)
      : shortMonthDay(article.date_text, article.__snapshotDate);
    const key = `${dateSortValue({ date_text: date })}:${date}`;
    const group = groups.get(key) || { date, new: [], events: [] };
    group[side].push(article);
    groups.set(key, group);
  };
  newRows.forEach((article) => add("new", article));
  eventRows.forEach((article) => add("events", article));
  const rows = [...groups.entries()].sort(([left], [right]) => Number(left.split(":")[0]) - Number(right.split(":")[0]));
  const content = rows.map(([, group], rowIndex) => {
    const newMode = group.new.length > 1 ? " is-parallel" : "";
    // 活动卡不并排：标题较长或同日活动较多时，保持卡片宽度与固定高度，按列向下排列。
    return `<div class="weekly-timeline-item"><div class="weekly-timeline-side weekly-timeline-side--new${newMode}">${group.new.map((article, index) => card({ ...article, __timeline: true }, assetBase, "new", rowIndex * 20 + index)).join("")}</div><span class="weekly-timeline-branch weekly-timeline-branch--left" aria-hidden="true"></span><time class="weekly-timeline-date">${escapeHtml(group.date)}</time><span class="weekly-timeline-branch weekly-timeline-branch--right" aria-hidden="true"></span><div class="weekly-timeline-side weekly-timeline-side--events">${group.events.map((article, index) => card({ ...article, __timeline: true }, assetBase, "events", rowIndex * 20 + index)).join("")}</div></div>`;
  }).join("");
  return `<section class="weekly-section weekly-section--new-activity"><header><span>${escapeHtml(number)}</span><h2>新游 &amp; 活动</h2><small>新游 ${newRows.length} 条 · 活动 ${eventRows.length} 条</small></header><div class="weekly-timeline">${content || '<p class="weekly-empty">近 14 天暂无符合条件的资讯。</p>'}</div></section>`;
}

export function buildWeeklyPosterHtml(articles = [], { assetBase = "http://127.0.0.1:64424", period = "" } = {}) {
  const latest = latestDistinct(articles);
  const buckets = { newGames: [], events: [], steam: [], editorial: [] };
  latest.forEach((article) => { const type = classify(article); if (type) buckets[type].push(article); });
  const newGames = dedupeByGame(buckets.newGames, { preferTapTap: true }).sort((left, right) => completeness(right) - completeness(left));
  const events = dedupeEvents(preferTapTapForSameGame(buckets.events)).sort((left, right) => completeness(right) - completeness(left));
  const steam = steamHighlightRows(buckets.steam);
  const editorial = dedupeByGame(buckets.editorial)
    .filter((article) => {
      const facts = article.facts || {};
      const layoutCount = Array.isArray(facts.gcoresLayout) ? facts.gcoresLayout.length : Array.isArray(facts.gamerskyLayout) ? facts.gamerskyLayout.length : 0;
      return layoutCount >= 2 || (article.paragraphs || []).join(" ").trim().length >= 120;
    })
    .sort((left, right) => editorialQuality(right) - editorialQuality(left));
  const sectionEntries = [
    { kind: "newActivity", rows: newGames.length + events.length },
    { kind: "steam", rows: steam.length, title: "Steam 热门", key: "steam", limit: Infinity },
    { kind: "editorial", rows: editorial.length, title: "端游资讯", key: "editorial", limit: 15 },
  ].filter((entry) => entry.rows > 0);
  const sections = sectionEntries.map((entry, index) => {
    const number = String(index + 1).padStart(2, "0");
    if (entry.kind === "newActivity") return newActivityTimelineMarkup(newGames, events, assetBase, number);
    return sectionMarkup(number, entry.title, entry.kind === "steam" ? steam : editorial, assetBase, entry.key, entry.limit);
  }).join("");
  const total = newGames.length + events.length + steam.length + Math.min(editorial.length, 15);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>游戏资讯周报-${escapeHtml(period)}</title><style>
    :root{--night:#102027;--ink:#152a32;--paper:#f7f7f4;--panel:#fff;--line:#dce2df;--mint:#1b806b;--coral:#d95f45;--mist:#eef3f1}*{box-sizing:border-box}html{background:var(--paper)}body{margin:0;color:var(--ink);font-family:"Microsoft YaHei","PingFang SC",sans-serif}.page{width:min(1280px,calc(100% - 40px));margin:0 auto;padding:26px 0 60px}.masthead{display:flex;justify-content:space-between;align-items:end;gap:22px;padding:22px 0 18px;border-bottom:2px solid var(--night);color:var(--ink)}.eyebrow{color:var(--mint);font-size:10px;font-weight:800;letter-spacing:.14em}.masthead h1{margin:6px 0 0;font-size:36px;line-height:1.1;letter-spacing:-.04em}.masthead p{max-width:540px;margin:8px 0 0;color:#6a7b77;font-size:11px}.weekly-date{text-align:right;font-size:10px;color:#6a7b77}.weekly-date b{display:block;margin-bottom:3px;color:var(--ink);font-size:16px}.weekly-section{margin-top:30px}.weekly-section>header{display:flex;align-items:baseline;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--ink)}.weekly-section>header span{color:var(--coral);font:700 21px/.9 Georgia,serif}.weekly-section h2{margin:0;font-size:17px}.weekly-section small{margin-left:auto;color:#7c8985;font-size:10px}.weekly-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-flow:dense;gap:10px;margin-top:10px}.weekly-card{display:grid;grid-column:span 6;grid-template-columns:minmax(170px,38%) minmax(0,1fr);min-height:210px;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:none}.weekly-section--new .weekly-card{grid-column:span 4;grid-template-columns:100px minmax(0,1fr);min-height:132px;border-radius:7px}.weekly-section--new .weekly-card:nth-child(5n+1){grid-column:span 6}.weekly-section--events .weekly-card:nth-child(5n+1),.weekly-section--events .weekly-card:nth-child(5n+4),.weekly-section--editorial .weekly-card:nth-child(3n+1){grid-column:span 7;min-height:250px}.weekly-section--events .weekly-card:nth-child(5n+2),.weekly-section--events .weekly-card:nth-child(5n+3),.weekly-section--editorial .weekly-card:nth-child(3n+2),.weekly-section--editorial .weekly-card:nth-child(3n+3){grid-column:span 5}.weekly-section--steam .weekly-card{grid-column:span 4;grid-template-columns:108px minmax(0,1fr);min-height:150px;border-radius:7px}.weekly-cover{display:grid;place-items:center;overflow:hidden;background:var(--mist);padding:8px}.weekly-cover img{display:block;width:100%;height:100%;object-fit:contain;object-position:center}.weekly-cover.is-empty{color:var(--mint);font:700 32px Georgia,serif}.weekly-copy{position:relative;display:flex;flex-direction:column;min-width:0;padding:13px 13px 39px}.weekly-section--new .weekly-copy,.weekly-section--steam .weekly-copy{padding:8px 9px 32px}.weekly-meta{display:flex;justify-content:space-between;gap:8px;color:#758682;font-size:9px;font-weight:700}.weekly-copy h3{margin:6px 0 2px;font-size:15px;line-height:1.28}.weekly-section--new .weekly-copy h3,.weekly-section--steam .weekly-copy h3{margin:3px 0 1px;font-size:12px}.weekly-copy>a{display:block;color:var(--mint);font-size:13px;font-weight:800;line-height:1.4;text-decoration:none}.weekly-copy>a:hover,.weekly-detail-content a:hover{text-decoration:underline}.weekly-section--new .weekly-copy>a,.weekly-section--steam .weekly-copy>a{font-size:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.weekly-copy>p{margin:6px 0;color:#536560;font-size:11px;line-height:1.58;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.weekly-section--new .weekly-copy>p,.weekly-section--steam .weekly-copy>p{margin:3px 0;font-size:9px;line-height:1.35;-webkit-line-clamp:2}.weekly-actions{position:absolute;right:10px;bottom:8px;left:13px;display:flex;align-items:center;justify-content:space-between;gap:8px}.weekly-section--new .weekly-actions,.weekly-section--steam .weekly-actions{left:9px;right:8px;bottom:7px}.weekly-tags{display:flex;flex-wrap:wrap;gap:3px;max-height:19px;overflow:hidden}.weekly-tags span{padding:2px 6px;border:1px solid #b9d7ce;border-radius:999px;color:var(--mint);font-size:8px;font-weight:700}.weekly-actions button{flex:0 0 auto;border:0;border-radius:4px;background:#edf5f2;color:var(--mint);padding:4px 7px;font:700 9px/1 "Microsoft YaHei",sans-serif;cursor:pointer}.weekly-actions button:hover{background:var(--mint);color:#fff}.weekly-rank{margin-top:4px;color:var(--coral);font-size:14px;font-weight:900}.weekly-rank small{display:block;margin:1px 0 0;color:#758682;font-size:9px}.weekly-empty{grid-column:1/-1;margin:4px 0;color:#758682;font-size:12px}.weekly-event-section+.weekly-event-section{margin-top:22px}.weekly-event-section h4{margin:0 0 10px;padding-left:8px;border-left:3px solid var(--coral);font-size:15px}.weekly-event-section h5{margin:12px 0 5px;color:var(--mint);font-size:13px}.weekly-event-section p,.weekly-detail-body p{margin:0 0 13px;white-space:pre-wrap}.weekly-body-image{margin:16px 0;text-align:center}.weekly-body-image img{display:block;width:auto;max-width:100%;max-height:520px;margin:0 auto;object-fit:contain;border-radius:5px;background:var(--mist)}#weekly-detail-dialog{width:min(880px,calc(100vw - 28px));max-height:min(840px,calc(100vh - 28px));padding:0;border:0;border-radius:8px;background:var(--panel);box-shadow:0 20px 50px rgba(0,0,0,.24)}#weekly-detail-dialog::backdrop{background:rgba(8,24,29,.58)}.weekly-detail-shell{display:flex;flex-direction:column;max-height:inherit}.weekly-detail-toolbar{display:flex;justify-content:space-between;align-items:center;padding:11px 14px;border-bottom:1px solid var(--line);background:#f7faf7}.weekly-detail-close{width:28px;height:28px;border:1px solid var(--line);border-radius:4px;background:#fff;color:var(--ink);font-size:18px;cursor:pointer}.weekly-detail-content{overflow:auto;padding:20px 22px 30px;color:#374d48;font-size:14px;line-height:1.85}.weekly-detail-heading{display:flex;justify-content:space-between;gap:12px;color:#71827d;font-size:11px;font-weight:700}.weekly-detail-content h2{margin:10px 0 4px;font-size:21px}.weekly-detail-content>a{color:var(--mint);font-weight:800;text-decoration:none}.weekly-detail-body{margin-top:16px}.weekly-detail-body .is-quote{padding:10px 13px;border-left:3px solid var(--mint);background:var(--mist)}@media(max-width:980px){.weekly-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.weekly-card,.weekly-section--new .weekly-card,.weekly-section--new .weekly-card:nth-child(5n+1),.weekly-section--events .weekly-card:nth-child(n),.weekly-section--steam .weekly-card,.weekly-section--editorial .weekly-card:nth-child(n){grid-column:auto}}@media(max-width:680px){.page{width:min(100% - 24px,1280px);padding-top:18px}.masthead{display:block;padding:17px 0}.masthead h1{font-size:30px}.weekly-date{text-align:left;margin-top:14px}.weekly-grid{grid-template-columns:1fr}.weekly-card,.weekly-section--new .weekly-card,.weekly-section--steam .weekly-card{grid-template-columns:100px minmax(0,1fr);min-height:150px}.weekly-section--events .weekly-card,.weekly-section--editorial .weekly-card{grid-template-columns:1fr}.weekly-section--events .weekly-cover,.weekly-section--editorial .weekly-cover{height:210px;min-height:210px}.weekly-section--events .weekly-cover img,.weekly-section--editorial .weekly-cover img{max-height:194px;object-fit:contain}.weekly-detail-content{padding:18px 16px 25px}}
  </style><style>
    /* 周报卡片是可阅读的微型海报，不是资讯列表：大图、叙事文字、统一的三列节奏。 */
    .masthead p{display:none}.weekly-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;align-items:stretch}.weekly-card{display:block;grid-column:auto!important;min-height:0!important;overflow:hidden;border:0;border-radius:4px;background:#10232a;box-shadow:0 10px 22px rgba(15,37,42,.16)}.weekly-card-link{display:flex;flex-direction:column;height:100%;color:inherit;text-decoration:none}.weekly-cover{position:relative;display:block;height:208px;padding:0;background:#152b32}.weekly-cover:after{content:"";position:absolute;inset:50% 0 0;background:linear-gradient(transparent,rgba(5,17,21,.52));pointer-events:none}.weekly-cover img{display:block;width:100%;height:100%;object-fit:cover;object-position:center;background:#152b32}.weekly-copy{position:relative;display:flex;flex:1;flex-direction:column;padding:13px 15px 14px;background:#fff}.weekly-copy:before{content:"";position:absolute;top:0;left:0;width:100%;height:4px;background:#1b806b}.weekly-meta{display:flex;justify-content:space-between;gap:10px;color:#69807a;font-size:9px;font-weight:800;letter-spacing:.08em}.weekly-copy h3{margin:9px 0 4px;color:#14272f;font-size:18px;line-height:1.12;letter-spacing:-.04em}.weekly-copy h4{margin:0;color:#166e61;font-size:13px;line-height:1.36;font-weight:800}.weekly-copy>p{margin:8px 0 0;color:#586963;font-size:10px;line-height:1.55}.weekly-rank{margin:7px 0 0;color:#c96246;font-size:10px;font-weight:800}.weekly-section--new-activity .weekly-timeline{position:relative;display:grid;gap:16px;padding:13px 0}.weekly-section--new-activity .weekly-timeline:before{content:"";position:absolute;top:0;bottom:0;left:50%;width:2px;background:#e7c8bc;transform:translateX(-50%)}.weekly-section--new-activity .weekly-timeline-item{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 92px minmax(0,1fr);align-items:center}.weekly-section--new-activity .weekly-timeline-item:before{content:"";grid-column:2;grid-row:1;width:10px;height:10px;margin:auto;border:3px solid #fff;border-radius:50%;background:#e27959;box-shadow:0 0 0 2px #e27959}.weekly-timeline-date{grid-column:2;grid-row:1;margin-top:31px;color:#bd5a41;text-align:center;font:800 11px/1 ui-monospace,monospace;letter-spacing:.02em}.weekly-timeline-side{display:flex;flex-direction:column;gap:12px;min-width:0}.weekly-timeline-side--new{grid-column:1;align-items:flex-end;padding-right:12px}.weekly-timeline-side--events{grid-column:3;align-items:flex-start;padding-left:12px}.weekly-section--new-activity .weekly-card{width:min(100%,420px);background:#fff}.weekly-section--new-activity .weekly-card--new .weekly-card-link{display:grid;grid-template-columns:102px minmax(0,1fr)}.weekly-section--new-activity .weekly-card--new .weekly-cover{height:auto;min-height:106px;background:#f0e7dc}.weekly-section--new-activity .weekly-card--new .weekly-cover:after{display:none}.weekly-section--new-activity .weekly-card--new .weekly-cover img{object-fit:contain;background:#f0e7dc}.weekly-section--new-activity .weekly-card--new .weekly-copy{padding:10px 11px}.weekly-section--new-activity .weekly-card--new .weekly-copy:before{width:4px;height:100%;background:#e27959}.weekly-section--new-activity .weekly-card--new .weekly-copy h3{margin:0 0 4px;font-size:14px}.weekly-section--new-activity .weekly-card--new .weekly-copy h4{font-size:10px;line-height:1.32}.weekly-section--new-activity .weekly-card--events{background:#1c2730}.weekly-section--new-activity .weekly-card--events .weekly-card-link{display:grid;grid-template-columns:minmax(128px,42%) minmax(0,1fr)}.weekly-section--new-activity .weekly-card--events .weekly-cover{height:auto;min-height:126px}.weekly-section--new-activity .weekly-card--events .weekly-copy{padding:10px 12px}.weekly-section--new-activity .weekly-card--events .weekly-copy:before{width:4px;height:100%;background:#dc6048}.weekly-section--new-activity .weekly-card--events .weekly-copy h3{margin:0 0 5px;font-size:15px}.weekly-event-title-line{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.weekly-event-title-line h4{flex:1}.weekly-event-title-line time{flex:0 0 auto;margin-top:2px;color:#788782;font-size:9px;font-weight:800;white-space:nowrap}.weekly-section--new-activity .weekly-card--events .weekly-copy h4{font-size:11px;line-height:1.38}.weekly-section--new-activity .weekly-card--events:nth-child(3n+2) .weekly-copy:before{background:#d2a23a}.weekly-section--new-activity .weekly-card--events:nth-child(3n+2) .weekly-copy h4{color:#a27110}.weekly-section--new-activity .weekly-card--events:nth-child(3n+3) .weekly-copy:before{background:#536fc0}.weekly-section--new-activity .weekly-card--events:nth-child(3n+3) .weekly-copy h4{color:#465dab}.weekly-section--steam .weekly-grid{grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.weekly-section--steam .weekly-card{background:#0d2026}.weekly-section--steam .weekly-cover{height:126px;padding:7px}.weekly-section--steam .weekly-cover:after{display:none}.weekly-section--steam .weekly-cover img{object-fit:contain;background:#112d35}.weekly-section--steam .weekly-copy{min-height:135px;padding:10px 11px 12px;background:#0d2026}.weekly-section--steam .weekly-copy:before{background:#f0b44a}.weekly-section--steam .weekly-meta{color:#9fbab2}.weekly-section--steam .weekly-copy h3{margin:7px 0 3px;color:#fff;font-size:14px}.weekly-section--steam .weekly-copy h4{color:#9fddcc;font-size:10px}.weekly-section--steam .weekly-copy>p{display:none}.weekly-section--steam .weekly-rank{margin-top:7px;color:#f0b44a;font-size:9px}.weekly-section--editorial .weekly-copy:before{background:#527ca5}.weekly-section--editorial .weekly-copy h4{color:#365f89}.weekly-card:not(.has-image){background:#f1f5f3}.weekly-card:not(.has-image) .weekly-cover{display:none}.weekly-card:not(.has-image) .weekly-copy{min-height:148px}.weekly-card:not(.has-image) .weekly-copy:after{content:"GAME";position:absolute;right:13px;bottom:10px;color:#d6e2dd;font:800 28px/.9 Georgia,serif;letter-spacing:-.08em}@media(max-width:980px){.weekly-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.weekly-section--new-activity .weekly-timeline-item{grid-template-columns:minmax(0,1fr) 74px minmax(0,1fr)}.weekly-section--steam .weekly-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:680px){.weekly-grid,.weekly-section--steam .weekly-grid{grid-template-columns:1fr}.weekly-section--new-activity .weekly-timeline:before{left:23px}.weekly-section--new-activity .weekly-timeline-item{display:block;padding-left:48px}.weekly-section--new-activity .weekly-timeline-item:before{position:absolute;top:20px;left:18px}.weekly-section--new-activity .weekly-timeline-date{display:block;margin:0 0 8px;text-align:left}.weekly-timeline-side,.weekly-timeline-side--new,.weekly-timeline-side--events{display:flex;padding:0}.weekly-timeline-side--events{margin-top:10px}.weekly-section--new-activity .weekly-card{width:100%}.weekly-cover,.weekly-section--events .weekly-cover{height:230px}.weekly-copy{min-height:0}}
    .weekly-section--new-activity .weekly-timeline-item{grid-template-columns:minmax(0,5fr) 72px minmax(0,5fr);align-items:center;min-height:132px}.weekly-section--new-activity .weekly-timeline:before{left:50%;transform:translateX(-50%)}.weekly-section--new-activity .weekly-timeline-item:before{grid-column:2}.weekly-section--new-activity .weekly-timeline-date{grid-column:2}.weekly-section--new-activity .weekly-timeline-side{position:relative;z-index:1;display:flex;flex-direction:column;align-items:stretch;align-content:center;gap:10px;min-width:0}.weekly-section--new-activity .weekly-timeline-side.is-parallel{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.weekly-section--new-activity .weekly-timeline-side--events{display:flex;grid-template-columns:none}.weekly-section--new-activity .weekly-timeline-side:empty{display:block}.weekly-section--new-activity .weekly-timeline-side--new{align-items:flex-end;padding-right:0}.weekly-section--new-activity .weekly-timeline-side--events{padding-left:18px}.weekly-section--new-activity .weekly-timeline-branch{position:absolute;top:50%;z-index:0;height:1px;background:#e7c8bc;pointer-events:none}.weekly-section--new-activity .weekly-timeline-branch--left{left:calc(50% - 4px);width:12px;transform:translateX(-100%)}.weekly-section--new-activity .weekly-timeline-branch--right{left:calc(50% + 4px);width:30px}.weekly-section--new-activity .weekly-card{width:100%;max-width:520px}.weekly-section--new-activity .weekly-card--new{max-width:308px}.weekly-section--new-activity .weekly-card--new .weekly-card-link{grid-template-columns:92px minmax(0,1fr);min-height:112px}.weekly-section--new-activity .weekly-card--new .weekly-cover{width:92px;height:112px;min-height:112px}.weekly-section--new-activity .weekly-card--new .weekly-copy{padding:29px 9px 9px}.weekly-section--new-activity .weekly-card--new .weekly-copy h3{font-size:14px;line-height:1.18}.weekly-section--new-activity .weekly-card--new .weekly-copy h4{font-size:10px;line-height:1.32}.weekly-new-tags{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;max-height:18px;overflow:hidden}.weekly-new-tags span{padding:2px 5px;border:1px solid #dfc3b9;border-radius:999px;color:#ad543e;background:#fff9f6;font-size:8px;font-weight:800;line-height:1}.weekly-section--new-activity .weekly-card--events,.weekly-section--new-activity .weekly-card--events .weekly-card-link{height:130px;min-height:130px;max-height:130px}.weekly-section--new-activity .weekly-card--events .weekly-copy{min-width:0;height:130px;min-height:130px;max-height:130px;padding:22px 12px 9px;overflow:hidden}.weekly-section--new-activity .weekly-card--events .weekly-card-link{grid-template-columns:minmax(0,2fr) minmax(0,3fr);align-items:stretch}.weekly-section--new-activity .weekly-card--events .weekly-cover{width:auto;height:130px;min-height:130px;padding:8px;background:#eef3f1}.weekly-section--new-activity .weekly-card--events .weekly-cover:after{display:none}.weekly-section--new-activity .weekly-card--events .weekly-cover img{width:100%;height:100%;object-fit:contain;object-position:center;background:#eef3f1}.weekly-section--new-activity .weekly-card--events .weekly-copy h3{font-size:16px;line-height:1.1}.weekly-section--new-activity .weekly-card--events .weekly-event-title-line{display:block;min-width:0}.weekly-section--new-activity .weekly-card--events .weekly-event-title-line h4{display:-webkit-box;margin:0;overflow:hidden;white-space:normal;overflow-wrap:anywhere;word-break:break-word;-webkit-box-orient:vertical;-webkit-line-clamp:3}.weekly-section--new-activity .weekly-card--events .weekly-copy h4{font-size:11px;line-height:1.3}.weekly-kind{position:absolute;top:9px;right:10px;padding:3px 7px;border-radius:999px;font-size:9px;font-weight:800;line-height:1;background:#f4e1da;color:#bd5a41}.weekly-kind--events{background:#e6f0ed;color:#166e61}.weekly-editorial-title-line{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.weekly-editorial-title-line h4{flex:1;margin-top:0}.weekly-editorial-title-line time{flex:0 0 auto;margin-top:2px;color:#69807a;font-size:9px;font-weight:800;letter-spacing:.04em;white-space:nowrap}.weekly-section--editorial .weekly-copy h4{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}@media(max-width:980px){.weekly-section--new-activity .weekly-timeline-item{grid-template-columns:minmax(0,5fr) 58px minmax(0,5fr)}.weekly-section--new-activity .weekly-timeline-side.is-parallel{grid-template-columns:1fr}.weekly-section--new-activity .weekly-timeline-branch--left,.weekly-section--new-activity .weekly-timeline-branch--right{width:22px}.weekly-section--new-activity .weekly-card--events .weekly-card-link{grid-template-columns:minmax(0,2fr) minmax(0,3fr)}.weekly-section--new-activity .weekly-card--events .weekly-cover{width:auto;height:130px;min-height:130px}}@media(max-width:680px){.weekly-section--new-activity .weekly-timeline:before{left:23px}.weekly-section--new-activity .weekly-timeline-item{display:block;padding-left:48px}.weekly-section--new-activity .weekly-timeline-branch{display:none}.weekly-section--new-activity .weekly-timeline-side--new,.weekly-section--new-activity .weekly-timeline-side--events{padding:0}.weekly-section--new-activity .weekly-timeline-side.is-parallel{grid-template-columns:1fr}.weekly-section--new-activity .weekly-card--new{max-width:none}.weekly-section--new-activity .weekly-card--new .weekly-cover{width:92px;height:112px}.weekly-section--new-activity .weekly-card--events,.weekly-section--new-activity .weekly-card--events .weekly-card-link{height:auto;min-height:0;max-height:none}.weekly-section--new-activity .weekly-card--events .weekly-card-link{grid-template-columns:1fr}.weekly-section--new-activity .weekly-card--events .weekly-cover{width:100%;height:190px;min-height:190px}.weekly-section--new-activity .weekly-card--events .weekly-copy{height:auto;min-height:0;max-height:none}}
    /* 时间树按自然日聚合后，以日期徽标和更大的段间距区分相邻日期。 */
    @media(min-width:681px){.weekly-section--new-activity .weekly-timeline{gap:46px;padding:24px 0 28px}.weekly-section--new-activity .weekly-timeline-item{min-height:132px}.weekly-section--new-activity .weekly-timeline-item:not(:first-child){padding-top:14px}.weekly-section--new-activity .weekly-timeline-item:not(:first-child):after{content:"";position:absolute;top:-24px;right:0;left:0;z-index:0;border-top:1px dashed #e6c7bd}.weekly-section--new-activity .weekly-timeline-date{z-index:2;display:inline-flex;align-items:center;justify-content:center;min-width:70px;margin-top:34px;padding:6px 8px;border:1px solid #efc7ba;border-radius:999px;background:var(--paper);box-shadow:0 0 0 7px var(--paper);font-size:10px;white-space:nowrap}.weekly-section--new-activity .weekly-timeline-item:before{z-index:3;box-shadow:0 0 0 5px var(--paper)}}
  </style></head><body><main class="page"><header class="masthead"><div><div class="eyebrow">GAME NEWS HUB · BIWEEKLY POSTER</div><h1>近14天游戏周报</h1></div><div class="weekly-date"><b>${escapeHtml(period)}</b><span>上海时间 · 共 ${total} 条重点内容</span></div></header>${sections}</main></body></html>`;
}

function rollingFortnightRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const end = new Date(`${values.year}-${values.month}-${values.day}T12:00:00+08:00`);
  const start = new Date(end.getTime() - 13 * 86400000);
  const key = (date) => date.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  return { from: key(start), to: key(end), label: `${key(start)} 至 ${key(end)}` };
}

export async function writeWeeklyPoster({ root, assetBase, now = new Date(), fallbackArticles = [] } = {}) {
  const range = rollingFortnightRange(now);
  const snapshots = await readWeeklyMaterialSnapshots({ root, from: range.from, to: range.to });
  const snapshotArticles = snapshots.flatMap((snapshot) => (snapshot.articles || []).map((article) => ({ ...article, __snapshotDate: snapshot.date })));
  const articles = snapshotArticles.length ? snapshotArticles : fallbackArticles.map((article) => ({ ...article, __snapshotDate: range.to }));
  const html = buildWeeklyPosterHtml(articles, { assetBase, period: range.label });
  const fileName = `游戏资讯周报-${range.to}.html`;
  const outputDir = path.join(root, "output");
  const archiveDir = path.join(outputDir, "weekly-poster-archive");
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, fileName), html, "utf8");
  await fs.writeFile(path.join(archiveDir, fileName), html, "utf8");
  return { fileName, outputPath: path.join(outputDir, fileName), archivePath: path.join(archiveDir, fileName), period: range.label, snapshotDays: snapshots.length, articleCount: articles.length };
}
