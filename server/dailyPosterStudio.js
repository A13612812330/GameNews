function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function cleanText(value = "") {
  return String(value).replace(/<br\s*\/?>(\s*)/giu, " ").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
}

function cleanGameName(value = "") {
  return cleanText(value)
    .replace(/[《》]/gu, "")
    .replace(/[（(](?:官服|测试服|正式服)[）)]/giu, "")
    .replace(/[\-—–]\s*(?:预下载|预约|下载|首发|公测|内测|测试|上线|发售|开放预购).*$/giu, "")
    .trim();
}

function normalizeKey(value = "") {
  return cleanGameName(value).replace(/[\s\-_:：·・]/gu, "").toLowerCase();
}

function sourceLabel(article = {}) {
  if (article.source_id === "ref-haoyou") return "好游快爆";
  if (article.source_id === "ref-taptap") return "TapTap";
  if (article.source_id === "ref-steam") return "Steam";
  return article.source_name || "游戏资讯";
}

function studioGroup(article = {}) {
  const facts = article.facts || {};
  if (article.source_id === "ref-taptap" && /\/forum\/hot\/hashtags\?item=\d+/.test(article.detail_url || "")) return "topic";
  if (article.source_id === "ref-haoyou") return facts.haoyouKind === "update" ? "event" : "upcoming";
  if (article.source_id === "ref-taptap") return /\/game-event\/?/.test(article.detail_url || "") ? "event" : "upcoming";
  if (article.source_id === "ref-steam") return "steam";
  return "editorial";
}

function tagsFor(article = {}) {
  const facts = article.facts || {};
  const raw = facts.steamTags || facts.taptapTags || facts.haoyouTags || [];
  return (Array.isArray(raw) ? raw : String(raw).split(/[\s,，;；/|]+/u)).map((item) => cleanText(item)).filter(Boolean).slice(0, 4);
}

function imageFor(article = {}, assetBase) {
  const images = Array.isArray(article.images) ? article.images : [];
  const saved = images.find((image) => String(image?.src || image?.localUrl || "").startsWith("/crawler-assets/")) || images[0] || {};
  const raw = article.image_url || saved.src || saved.localUrl || saved.originalUrl || "";
  if (!raw) return "";
  if (String(raw).startsWith("/crawler-assets/") || String(raw).startsWith("/api/image-proxy")) return `${assetBase}${raw}`;
  if (["ref-taptap", "ref-haoyou", "ref-gcores", "ref-gamersky"].includes(article.source_id)) return `${assetBase}/api/image-proxy?url=${encodeURIComponent(raw)}`;
  return raw;
}

function eventTitle(article = {}) {
  const game = cleanGameName(article.game_name);
  let title = cleanText(article.title || "");
  if (game) title = title.replace(new RegExp(`^《?${game.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}》?\s*[：:、,，—-]*`, "iu"), "");
  return title || "查看本次更新内容";
}

function summaryFor(article = {}) {
  const facts = article.facts || {};
  return cleanText(
    facts.haoyouUpdateContent || facts.steamDescriptionSnippet || facts.haoyouIntro || article.paragraphs?.find((item) => cleanText(item)) || "暂无摘要",
  );
}

function titleFor(article = {}, group) {
  if (group === "event") return eventTitle(article);
  if (group === "topic") return cleanText(article.title || "今日话题");
  return cleanText(article.title || article.game_name || "游戏资讯");
}

function dedupe(rows = []) {
  const retained = new Map();
  for (const article of rows) {
    const group = studioGroup(article);
    const date = cleanText(article.date_text || "");
    const key = `${group}|${normalizeKey(article.game_name || article.title)}|${date}`;
    const current = retained.get(key);
    if (!current || (article.source_id === "ref-taptap" && current.source_id !== "ref-taptap")) retained.set(key, article);
  }
  return [...retained.values()];
}

function section(title, kicker, items, assetBase, className) {
  if (!items.length) return "";
  return `<section class="signal-section signal-section--${className}">
    <header class="signal-section-head"><span>${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2><small>${items.length} 条</small></header>
    <div class="signal-grid">${items.map((article, index) => card(article, assetBase, index, className)).join("")}</div>
  </section>`;
}

function timelineDateLabel(article = {}) {
  const raw = cleanText(article.date_text || "");
  const matched = raw.match(/(\d{1,2})\D+(\d{1,2})/u);
  if (!matched) return raw || "近期";
  return `${String(matched[1]).padStart(2, "0")}.${String(matched[2]).padStart(2, "0")}`;
}

function timelineSection(items, assetBase) {
  if (!items.length) return "";
  const buckets = new Map();
  for (const article of items) {
    const label = timelineDateLabel(article);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(article);
  }
  const dates = [...buckets.keys()].slice(0, 9);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(new Date()).replace("/", ".");
  return `<section class="signal-section signal-section--timeline">
    <header class="signal-section-head"><span>DROP</span><h2>上线雷达</h2><small>${items.length} 条</small></header>
    <nav class="signal-date-rail" aria-label="上线日期">${dates.map((label) => `<span class="${label === today ? "is-today" : ""}">${escapeHtml(label)}${label === today ? "<b>今</b>" : ""}</span>`).join("")}</nav>
    <div class="signal-timeline">${dates.map((label) => `<div class="signal-timeline-day"><div class="signal-day-stamp"><b>${escapeHtml(label)}</b><small>${label === today ? "今日" : "上线"}</small></div><div class="signal-grid">${buckets.get(label).map((article, index) => card(article, assetBase, index, "upcoming")).join("")}</div></div>`).join("")}</div>
  </section>`;
}

function card(article, assetBase, index, group) {
  const image = imageFor(article, assetBase);
  const game = cleanGameName(article.game_name) || "未识别游戏";
  const title = titleFor(article, studioGroup(article));
  const tags = tagsFor(article).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const original = article.detail_url || "#";
  // 活动卡仅由图片比例决定结构；首条不再强制放大，避免竖图和大卡规则叠加后产生留白。
  const isLead = false;
  const compactStyle = group === "events"
    ? "style=\"min-height:200px;grid-template-rows:90px minmax(110px,auto)\""
    : group === "topics"
      ? "style=\"min-height:100px;grid-template-columns:115px minmax(0,1fr)\""
      : "";
  return `<article class="signal-card signal-card--${group}${isLead ? " is-lead" : ""}" data-image-card ${compactStyle}>
    <div class="signal-media${image ? "" : " is-empty"}">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(game)}" loading="eager" />` : `<b>${escapeHtml(game.slice(0, 2))}</b>`}</div>
    <div class="signal-copy">
      <div class="signal-meta"><span>${escapeHtml(sourceLabel(article))}</span><time>${escapeHtml(article.date_text || "今日")}</time></div>
      <h3>《${escapeHtml(game)}》</h3>
      <a href="${escapeHtml(original)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>
      <p>${escapeHtml(summaryFor(article))}</p>
      <div class="signal-tags">${tags}</div>
    </div>
  </article>`;
}

export function buildStudioDailyPosterHtml(articles = [], { assetBase = "", generatedAt = new Date() } = {}) {
  const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(generatedAt).replace(/\//gu, ".");
  const rows = dedupe(articles);
  const groups = {
    upcoming: rows.filter((item) => studioGroup(item) === "upcoming"),
    events: rows.filter((item) => studioGroup(item) === "event"),
    topic: rows.filter((item) => studioGroup(item) === "topic"),
    steam: rows.filter((item) => studioGroup(item) === "steam"),
    editorial: rows.filter((item) => studioGroup(item) === "editorial"),
  };
  const sections = [
    timelineSection(groups.upcoming, assetBase),
    section("版本与活动", "PATCH", groups.events, assetBase, "events"),
    section("正在讨论", "PULSE", groups.topic, assetBase, "topics"),
    section("Steam 信号", "PC", groups.steam, assetBase, "steam"),
    section("行业快讯", "WIRE", groups.editorial, assetBase, "editorial"),
  ].join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>游戏信号日报-${date}</title><style>
    :root{--void:#07131a;--ink:#10212a;--paper:#edf2ed;--panel:#f9fbf8;--muted:#6e7d82;--line:#cbd8d5;--acid:#c6ff56;--cyan:#66e6ff;--coral:#ff654b;--violet:#9e8cff}*{box-sizing:border-box}html{background:var(--void)}body{margin:0;background:radial-gradient(circle at 80% 0,#16394b 0,transparent 33%),linear-gradient(180deg,#07131a 0,#10242d 23%,var(--paper) 23%,var(--paper) 100%);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC",sans-serif}.signal-page{width:min(1200px,calc(100% - 40px));margin:0 auto;padding:30px 0 86px}.signal-masthead{display:grid;grid-template-columns:1fr auto;gap:22px;padding:8px 0 38px;color:#f3fff7}.signal-kicker{display:flex;align-items:center;gap:9px;color:var(--acid);font:800 11px/1 "Arial Narrow",sans-serif;letter-spacing:.18em}.signal-kicker:before{width:9px;height:9px;background:var(--acid);box-shadow:0 0 24px var(--acid);content:""}.signal-masthead h1{max-width:750px;margin:16px 0 0;font:900 clamp(48px,7.3vw,96px)/.88 Impact,"Arial Narrow","Microsoft YaHei",sans-serif;letter-spacing:.015em}.signal-masthead p{max-width:560px;margin:16px 0 0;color:#b6c8c8;font-size:13px;line-height:1.65}.signal-date{align-self:end;text-align:right}.signal-date b{display:block;color:var(--cyan);font:900 35px/.95 Impact,"Arial Narrow",sans-serif;letter-spacing:.04em}.signal-date small{color:#a9bdbe;font-weight:700}.signal-feed{position:relative}.signal-feed:before{position:absolute;left:-20px;right:-20px;top:0;height:5px;background:linear-gradient(90deg,var(--acid) 0 18%,var(--cyan) 18% 55%,var(--coral) 55% 100%);content:""}.signal-section{padding-top:36px}.signal-section-head{display:flex;align-items:baseline;gap:11px;padding-bottom:10px;border-bottom:2px solid var(--ink)}.signal-section-head span{color:var(--coral);font:900 12px/1 "Arial Narrow",sans-serif;letter-spacing:.18em}.signal-section-head h2{margin:0;font-size:23px;letter-spacing:.04em}.signal-section-head small{margin-left:auto;color:var(--muted);font-weight:800}.signal-grid{display:grid;gap:12px;margin-top:13px}.signal-card{position:relative;display:grid;overflow:hidden;border:1px solid var(--line);background:var(--panel);box-shadow:0 10px 24px rgba(19,48,50,.08)}.signal-media{display:grid;place-items:center;overflow:hidden;background:linear-gradient(135deg,#16323d,#40707b)}.signal-media img{display:block;width:100%;height:100%;object-fit:cover}.signal-media.is-empty{color:var(--acid);font:900 35px Impact,"Arial Narrow",sans-serif}.signal-copy{min-width:0;padding:14px 15px}.signal-meta{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:10px;font-weight:900}.signal-copy h3{margin:7px 0 1px;font-size:15px;line-height:1.25}.signal-copy>a{display:-webkit-box;color:#173747;font-size:13px;font-weight:900;line-height:1.4;text-decoration:none;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.signal-copy p{display:-webkit-box;margin:7px 0 0;color:#596b70;font-size:11px;line-height:1.55;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.signal-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}.signal-tags span{border:1px solid #abd0cd;border-radius:99px;padding:2px 6px;color:#2b6a6c;font-size:9px;font-weight:800}.signal-section--upcoming .signal-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.signal-card--upcoming{grid-template-columns:76px minmax(0,1fr);min-height:126px}.signal-card--upcoming .signal-media{margin:12px 0 12px 12px;height:76px;border-radius:3px}.signal-card--upcoming .signal-copy{padding:12px 12px}.signal-card--upcoming .signal-copy p{display:none}.signal-card--upcoming .signal-tags{margin-top:6px}.signal-section--events .signal-grid{grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-flow:dense}.signal-card--events{grid-template-rows:148px minmax(170px,auto);min-height:318px}.signal-card--events.is-lead{grid-column:span 2;grid-template-columns:minmax(250px,47%) minmax(0,1fr);grid-template-rows:none;min-height:314px}.signal-card--events.is-lead .signal-media{min-height:314px}.signal-card--events[data-image-shape="square"]{grid-template-columns:96px minmax(0,1fr);grid-template-rows:none;min-height:162px}.signal-card--events[data-image-shape="square"] .signal-media{width:76px;height:76px;align-self:center;justify-self:end;border-radius:4px}.signal-card--events[data-image-shape="square"] .signal-copy{align-self:center}.signal-card--events[data-image-shape="portrait"]{grid-template-columns:minmax(128px,34%) minmax(0,1fr);grid-template-rows:none;min-height:248px}.signal-card--events[data-image-shape="portrait"] .signal-media{min-height:248px}.signal-card--events[data-image-shape="landscape"] .signal-media{min-height:148px}.signal-section--topics .signal-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.signal-card--topics{grid-template-columns:170px minmax(0,1fr);min-height:150px}.signal-card--topics .signal-media{min-height:150px}.signal-card--topics:nth-child(odd):last-child{grid-column:1/-1}.signal-section--steam .signal-grid,.signal-section--editorial .signal-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.signal-card--steam,.signal-card--editorial{grid-template-columns:180px minmax(0,1fr);min-height:166px}.signal-card--steam .signal-media,.signal-card--editorial .signal-media{min-height:166px}@media(max-width:860px){.signal-page{width:min(100% - 24px,1200px);padding-top:20px}.signal-masthead{grid-template-columns:1fr}.signal-date{text-align:left}.signal-section--upcoming .signal-grid,.signal-section--events .signal-grid,.signal-section--topics .signal-grid,.signal-section--steam .signal-grid,.signal-section--editorial .signal-grid{grid-template-columns:1fr}.signal-card--events.is-lead{grid-column:auto;grid-template-columns:1fr;grid-template-rows:210px auto}.signal-card--events.is-lead .signal-media{min-height:210px}.signal-card--events[data-image-shape="portrait"],.signal-card--topics,.signal-card--steam,.signal-card--editorial{grid-template-columns:120px minmax(0,1fr);min-height:150px}.signal-card--events[data-image-shape="portrait"] .signal-media,.signal-card--topics .signal-media,.signal-card--steam .signal-media,.signal-card--editorial .signal-media{min-height:150px}.signal-card--topics:nth-child(odd):last-child{grid-column:auto}}
  </style><style>.signal-section--timeline .signal-grid{grid-template-columns:repeat(3,minmax(0,1fr));margin-top:0}.signal-date-rail{display:flex;gap:7px;overflow:hidden;margin:12px 0 15px;padding:0 0 2px}.signal-date-rail span{position:relative;min-width:52px;padding:7px 6px;border:1px solid var(--line);border-radius:3px;background:#f6faf7;color:#587178;font:900 10px/1 Impact,"Arial Narrow",sans-serif;letter-spacing:.04em;text-align:center}.signal-date-rail span.is-today{border-color:var(--coral);background:var(--coral);color:#fff}.signal-date-rail b{position:absolute;right:3px;top:2px;font:900 8px/1 "Microsoft YaHei",sans-serif}.signal-timeline{position:relative;padding-left:74px}.signal-timeline:before{position:absolute;left:26px;top:8px;bottom:12px;width:1px;background:#a7c4bf;content:""}.signal-timeline-day{position:relative;padding-bottom:13px}.signal-timeline-day:last-child{padding-bottom:0}.signal-day-stamp{position:absolute;left:-74px;top:5px;width:54px;text-align:right}.signal-day-stamp:after{position:absolute;right:-14px;top:3px;width:9px;height:9px;border:2px solid var(--paper);border-radius:50%;background:var(--cyan);box-shadow:0 0 0 1px #6d9f99;content:""}.signal-day-stamp b{display:block;color:var(--ink);font:900 15px/.95 Impact,"Arial Narrow",sans-serif}.signal-day-stamp small{color:var(--muted);font-size:9px;font-weight:800}.signal-section--timeline .signal-card--upcoming{min-height:102px}.signal-section--timeline .signal-card--upcoming .signal-media{width:58px;height:58px;margin:9px 0 9px 9px}.signal-section--timeline .signal-card--upcoming .signal-copy{padding:9px 9px}.signal-section--timeline .signal-card--upcoming .signal-copy h3{font-size:12px}.signal-section--timeline .signal-card--upcoming .signal-copy>a{font-size:10px;line-height:1.3}.signal-section--timeline .signal-card--upcoming .signal-tags{display:none}@media(max-width:860px){.signal-section--timeline .signal-grid{grid-template-columns:1fr}.signal-timeline{padding-left:60px}.signal-day-stamp{left:-60px;width:42px}.signal-date-rail{overflow:auto}.signal-section--timeline .signal-card--upcoming{min-height:96px}}/* image-layout-stability */
.signal-card{min-height:0;align-content:stretch}.signal-card .signal-media{min-width:0;min-height:0}.signal-copy{overflow:hidden}.signal-copy h3,.signal-copy>a,.signal-copy p{max-width:100%;overflow-wrap:anywhere}.signal-section--events .signal-card{height:200px}.signal-section--topics .signal-card{height:100px}.signal-section--timeline .signal-card{height:102px}.signal-card[data-image-shape="portrait"] .signal-media img{object-fit:contain;background:#edf4f0}.signal-card[data-image-shape="landscape"] .signal-media img{object-fit:cover}@media(max-width:860px){.signal-section--events .signal-card{height:190px}.signal-section--topics .signal-card{height:96px}.signal-section--timeline .signal-card{height:96px}}</style></head><body><main class="signal-page"><header class="signal-masthead"><div><div class="signal-kicker">GAME SIGNAL / DAILY DISPATCH</div><h1>游戏信号日报</h1><p>上线、版本、热议与平台动态。每张卡片随抓取图片比例调整框架，保留当天最值得分发的内容。</p></div><div class="signal-date"><b>${escapeHtml(date)}</b><small>上海时间 · ${rows.length} 条信号</small></div></header><div class="signal-feed">${sections || "<p>今日暂无可发布内容。</p>"}</div></main><script>(()=>{const classify=(img)=>{const card=img.closest('[data-image-card]');if(!card||!img.naturalWidth||!img.naturalHeight)return;const ratio=img.naturalWidth/img.naturalHeight;card.dataset.imageShape=Math.abs(ratio-1)<=.12?'square':ratio>=1.25?'landscape':'portrait'};document.querySelectorAll('[data-image-card] img').forEach((img)=>{if(img.complete)classify(img);else img.addEventListener('load',()=>classify(img),{once:true})})})()</script></body></html>`;
}
