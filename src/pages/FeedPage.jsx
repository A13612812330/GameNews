import React, { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ChevronDown, ExternalLink, FileSearch, ImageDown, ImageIcon, LoaderCircle, RefreshCw, X } from "lucide-react";
import { PageHeader } from "../components/ui.jsx";
import { articleStore } from "../services/articleStore.js";
import { api } from "../services/api.js";
import { downloadRemoteFile } from "../utils/export.js";
import "../feed-page.css";

const SOURCE_ORDER = ["Steam", "TapTap", "好游快爆", "机核", "游民星空"];
const TABLE_ORDER = ["新游上线", "中国区热玩榜", "中国区畅销榜", "热榜话题", "即将上线 / 首发", "版本更新 / 活动 / 联动", "即将上线 + 即将测试", "即将更新", "官方资讯"];

function tableName(article) {
  const facts = article.facts || {};
  if (article.source_id === "ref-steam") return ({ new: "新游上线", most_played: "中国区热玩榜", top_selling_cn: "中国区畅销榜" })[facts.steamList] || "Steam 候选";
  if (article.source_id === "ref-taptap") {
    if (/\/forum\/hot\/hashtags\?item=\d+/.test(article.detail_url || "")) return "热榜话题";
    if (/\/game-event\/?/.test(article.detail_url || "")) return "版本更新 / 活动 / 联动";
    return "即将上线 / 首发";
  }
  if (article.source_id === "ref-haoyou") return facts.haoyouKind === "update" ? "即将更新" : "即将上线 + 即将测试";
  return "官方资讯";
}

function tagsFor(article) {
  const facts = article.facts || {};
  return facts.steamTags?.length ? facts.steamTags : facts.taptapTags?.length ? facts.taptapTags : facts.haoyouTags?.length ? facts.haoyouTags : [];
}
function briefMeta(article) { return article.facts?.briefMeta || {}; }

// 已落盘图片必须优先使用；远程封面仅作为详情图片尚未落盘时的回退。
function primaryImage(article) { return article.images?.[0] || article.image_url || null; }
function resolveImageValue(article, value) {
  const item = article.imageItems?.find(image => image.src === value || image.originalUrl === value);
  return item?.src || value;
}
function imageSrc(article, value = primaryImage(article)) {
  const resolved = resolveImageValue(article, value);
  if (!resolved) return null;
  if (resolved.startsWith("/crawler-assets/")) return resolved;
  try {
    const parsed = new URL(resolved);
    if (
      ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
      parsed.pathname.startsWith("/crawler-assets/")
    ) return parsed.pathname;
  } catch {}
  return ["ref-taptap", "ref-haoyou", "ref-gcores", "ref-gamersky"].includes(article.source_id)
    ? `/api/image-proxy?url=${encodeURIComponent(resolved)}`
    : resolved;
}
function sourceMonogram(article) { return ({ "ref-steam": "ST", "ref-taptap": "TT", "ref-haoyou": "KB", "ref-gcores": "GC", "ref-gamersky": "GS" })[article.source_id] || "GN"; }
function detailText(article) { const facts = article.facts || {}; return facts.steamDescriptionSnippet || facts.haoyouIntro || facts.haoyouUpdateContent || article.paragraphs?.join("\n\n") || "暂无正文"; }
function snapshotTime(value) { const time = new Date(value); return Number.isNaN(time.getTime()) ? "等待生成" : time.toLocaleString("zh-CN", { hour12: false }); }

// 抓取资讯按业务日期筛选：上线/活动用计划日期，资讯用发布时间。
// 无法可靠解析的时间只在“全部时间”保留，避免被误归为今日或未来。
function articleDateStart(value = "") {
  const text = String(value || "").trim();
  const shanghai = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const today = Date.UTC(Number(shanghai.year), Number(shanghai.month) - 1, Number(shanghai.day));
  if (/^(今天|今日)/u.test(text)) return today;
  if (/^明天/u.test(text)) return today + 24 * 3600 * 1000;
  if (/^后天/u.test(text)) return today + 2 * 24 * 3600 * 1000;
  let match = /(20\d{2})\s*(?:年|[\/-])\s*(\d{1,2})\s*(?:月|[\/-])\s*(\d{1,2})/u.exec(text);
  if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  match = /(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*日?/u.exec(text);
  if (!match) return null;
  let year = Number(shanghai.year);
  let candidate = Date.UTC(year, Number(match[1]) - 1, Number(match[2]));
  // 仅处理跨年场景，不能把已过去的本年日期错误改成未来。
  if (candidate < today && Number(shanghai.month) >= 10 && Number(match[1]) <= 3) {
    year += 1;
    candidate = Date.UTC(year, Number(match[1]) - 1, Number(match[2]));
  }
  return candidate;
}
function matchesTimeRange(article, range) {
  if (range === "all") return true;
  const timestamp = articleDateStart(article.date_text);
  const shanghai = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const today = Date.UTC(Number(shanghai.year), Number(shanghai.month) - 1, Number(shanghai.day));
  const facts = article.facts || {};
  // Steam 新游的业务窗口是过去 7 天到未来 7 天；热玩/畅销是当前榜单快照。
  // 必须与服务端 RAW scope 保持一致，避免服务端已返回、前端又过滤成 0 条。
  if (facts.steamList) {
    const isChart = facts.steamList !== "new";
    if (timestamp == null) {
      if (range === "today") {
        const observed = new Date(article.discovered_at || article.updated_at || 0).getTime();
        return isChart && Number.isFinite(observed) && observed >= today && observed < today + 24 * 3600 * 1000;
      }
      return range === "today_future" && isChart;
    }
    if (range === "today") return timestamp === today;
    if (range === "future") return timestamp > today && timestamp <= today + 7 * 24 * 3600 * 1000;
    return timestamp >= today - 7 * 24 * 3600 * 1000 && timestamp <= today + 7 * 24 * 3600 * 1000;
  }
  // TapTap 热榜是本次快照，不带业务日期；其余无日期记录不在前端展示。
  if (timestamp == null) {
    return range === "today_future" && /\/forum\/hot\/hashtags\?item=\d+/.test(article.detail_url || "");
  }
  if (range === "today_future") return timestamp >= today;
  return range === "today" ? timestamp === today : timestamp > today;
}

function ContentImage({ article, url, alt = "资讯图片", caption = "", cover = false }) {
  const src = imageSrc(article, url);
  if (!src) return null;
  return <figure className={`raw-data-content-image${cover ? " is-cover" : ""}`}><a href={src} target="_blank" rel="noreferrer"><img src={src} alt={alt} loading="lazy" /></a>{caption ? <figcaption>{caption}</figcaption> : null}</figure>;
}

function ParagraphContent({ paragraphs = [] }) {
  return <div className="raw-data-body">{paragraphs.filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
}

function safeRichHtml(article, value = "") {
  if (typeof DOMParser === "undefined" || !value) return "";
  const allowedTags = new Set(["P", "BR", "STRONG", "B", "EM", "I", "UL", "OL", "LI", "H4", "H5", "BLOCKQUOTE", "A", "IMG"]);
  const doc = new DOMParser().parseFromString(value, "text/html");
  [...doc.body.querySelectorAll("*")].forEach(node => {
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }
    const href = node.getAttribute("href") || "";
    const originalSrc = node.getAttribute("src") || "";
    const alt = node.getAttribute("alt") || "";
    [...node.attributes].forEach(attribute => node.removeAttribute(attribute.name));
    if (node.tagName === "A") {
      if (/^https?:\/\//i.test(href)) { node.setAttribute("href", href); node.setAttribute("target", "_blank"); node.setAttribute("rel", "noreferrer"); }
      else node.removeAttribute("href");
    }
    if (node.tagName === "IMG") {
      const src = imageSrc(article, originalSrc);
      if (src) node.setAttribute("src", src);
      else node.remove();
      if (alt) node.setAttribute("alt", alt);
      node.setAttribute("loading", "lazy");
    }
  });
  return doc.body.innerHTML;
}

function RichHtmlContent({ article, html }) {
  const content = safeRichHtml(article, html);
  return content ? <div className="raw-data-rich-html" dangerouslySetInnerHTML={{ __html: content }} /> : null;
}

function TapTapEventContent({ article, event }) {
  const blocks = Array.isArray(event?.blocks) ? event.blocks : [];
  if (!blocks.length) return <ParagraphContent paragraphs={event?.paragraphs?.length ? event.paragraphs : article.paragraphs} />;
  return <div className="raw-data-event-layout">{blocks.map((block, blockIndex) => <section key={`${block.title}-${blockIndex}`} className="raw-data-event-section"><h4>{block.title}</h4>{(block.items || []).map((item, itemIndex) => <article key={`${item.title}-${itemIndex}`} className="raw-data-event-item"><h5>{item.title}</h5>{item.content ? <p>{item.content}</p> : null}{(item.images || []).map((image, imageIndex) => <ContentImage key={`${image.url}-${imageIndex}`} article={article} url={image.url} alt={image.label || item.title || "活动图片"} />)}</article>)}</section>)}</div>;
}

function GcoresContent({ article, layout }) {
  return <div className="raw-data-editorial-layout raw-data-editorial-layout--gcores">{layout.map((block, index) => {
    if (block.type === "image") return <ContentImage key={index} article={article} url={block.url} alt={block.alt || "机核正文图片"} caption={block.caption} cover={block.cover} />;
    if (block.type === "embed") return <a className="raw-data-embed" key={index} href={block.url} target="_blank" rel="noreferrer">打开原文媒体{block.caption ? `：${block.caption}` : ""}</a>;
    if (block.type === "text") return <p key={index} className={block.quote ? "is-quote" : ""}>{(block.segments || []).map((segment, segmentIndex) => { let text = segment.text || ""; if (segment.bold) text = <strong>{text}</strong>; if (segment.italic) text = <em>{text}</em>; return <React.Fragment key={segmentIndex}>{text}</React.Fragment>; })}</p>;
    return null;
  })}</div>;
}

function GamerskyContent({ article, layout }) {
  return <div className="raw-data-editorial-layout raw-data-editorial-layout--gamersky">{layout.map((block, index) => block.type === "image" ? <ContentImage key={index} article={article} url={block.url} alt={block.alt || "游民星空正文图片"} /> : block.text ? <p key={index}>{block.text}</p> : null)}</div>;
}

function StructuredContent({ article }) {
  const facts = article.facts || {};
  const event = Array.isArray(facts.taptapEvents) ? facts.taptapEvents.find(item => item.title && article.title.includes(item.title)) || facts.taptapEvents[0] : null;
  if (article.source_id === "ref-taptap" && event) return <TapTapEventContent article={article} event={event} />;
  if (article.source_id === "ref-gcores" && Array.isArray(facts.gcoresLayout) && facts.gcoresLayout.length) return <GcoresContent article={article} layout={facts.gcoresLayout} />;
  if (article.source_id === "ref-gamersky" && Array.isArray(facts.gamerskyLayout) && facts.gamerskyLayout.length) return <GamerskyContent article={article} layout={facts.gamerskyLayout} />;
  if (article.source_id === "ref-haoyou" && facts.haoyouIntroHtml) return <RichHtmlContent article={article} html={facts.haoyouIntroHtml} />;
  return <><ParagraphContent paragraphs={detailText(article).split(/\n{2,}/)} />{article.images?.length ? <div className="raw-data-images">{article.images.map((url, index) => <ContentImage key={`${url}-${index}`} article={article} url={url} />)}</div> : null}</>;
}

function FeedThumbnail({ article }) {
  const [failed, setFailed] = useState(false);
  const src = imageSrc(article);
  if (!src || failed) return <span className="raw-data-image-placeholder" data-source={article.source_id} title="暂无可用缩略图"><b>{sourceMonogram(article)}</b><ImageIcon size={13} /></span>;
  return <img src={src} alt={`${article.game_name || article.title} 缩略图`} loading="lazy" onError={() => setFailed(true)} />;
}

function DetailDialog({ article, onClose }) {
  if (!article) return null;
  return <div className="raw-data-dialog" role="dialog" aria-modal="true" aria-label="资讯完整内容"><button className="raw-data-dialog-backdrop" onClick={onClose} aria-label="关闭" /><section className="raw-data-dialog-panel"><div className="raw-data-dialog-topbar"><span className="raw-data-kicker">{article.source_name} · {tableName(article)} · {article.date_text || "无时间"}</span><button className="raw-data-dialog-close" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><h2>{article.game_name || "未识别游戏"}</h2><h3>{article.title}</h3><div className="raw-data-tags">{tagsFor(article).map(tag => <span key={tag}>{tag}</span>)}</div><StructuredContent article={article} /><a className="raw-data-original" href={article.detail_url} target="_blank" rel="noreferrer">打开原文 <ExternalLink size={13} /></a></section></div>;
}

function FeedGroup({ sourceName, name, rows, selectedIds, onToggleGroup, onToggleArticle, onShow, defaultOpen = false, selectionMode }) {
  const [open, setOpen] = useState(defaultOpen);
  const selectedCount = rows.filter(article => selectedIds.includes(article.id)).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;
  return <section className={`raw-data-group${open ? " is-open" : ""}`}><header className="raw-data-group-head"><button className="raw-data-group-title" onClick={() => setOpen(!open)}><ChevronDown size={15} /><span className="raw-data-source-dot" data-source={sourceName} /> <span>{sourceName} · {name}</span><small>{rows.length} 条</small></button>{selectionMode === "multiple" ? <button className={`raw-data-group-select${allSelected ? " is-selected" : ""}`} onClick={() => onToggleGroup(rows)}>{allSelected ? <Check size={12} /> : null}{allSelected ? "已全选" : `选择 ${rows.length} 条`}</button> : <span className="raw-data-group-single">逐条选择</span>}</header>{open && <div className="raw-data-list">{rows.map(article => { const checked = selectedIds.includes(article.id); const meta = briefMeta(article); return <article className={`raw-data-row${checked ? " is-selected" : ""}`} key={article.id}><button className={`raw-data-check${checked ? " is-checked" : ""}`} onClick={() => onToggleArticle(article.id)} aria-label={checked ? "取消选择" : "选择资讯"}>{checked && <Check size={13} />}</button><FeedThumbnail article={article} /><div className="raw-data-row-main"><div className="raw-data-meta"><span>{article.date_text || "无时间"}</span><span className={`raw-data-priority raw-data-priority--${meta.priority || "observe"}`}>{meta.priority || "观察"}</span>{!meta.dedupePrimary ? <span>重复来源</span> : null}{article.source_id === "ref-steam" && article.facts?.steamRankCurrent ? <span>#{article.facts.steamRankCurrent}</span> : null}</div><h3>{article.game_name || "未识别游戏"}</h3><p>{article.title}</p><div className="raw-data-tags">{tagsFor(article).slice(0, 5).map(tag => <span key={tag}>{tag}</span>)}</div></div><div className="raw-data-actions"><button onClick={() => onShow(article)}>查看内容</button><a href={article.detail_url} target="_blank" rel="noreferrer" aria-label="打开原文"><ExternalLink size={14} /></a></div></article>; })}</div>}</section>;
}

export default function FeedPage() {
  const [data, setData] = useState(null);
  const [source, setSource] = useState("all");
  const [selectedIds, setSelectedIds] = useState(() => articleStore.getSelected());
  const [activeArticle, setActiveArticle] = useState(null);
  const [selectionMode, setSelectionMode] = useState("multiple");
  const [market, setMarket] = useState("all");
  const [priority, setPriority] = useState("all");
  // 业务前台默认且固定只读今天及未来；历史数据仍留在 SQLite 供归档与排查。
  const [timeRange, setTimeRange] = useState("today_future");
  const [onlyImage, setOnlyImage] = useState(false);
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [posterBusy, setPosterBusy] = useState(false);
  const [posterResult, setPosterResult] = useState(null);

  const load = async () => { setLoading(true); try { const result = await api.rawFeed(); setData(result); setError(""); } catch (e) { setError(e.message || "RAW 数据尚未生成"); } finally { setLoading(false); } };
  useEffect(() => { load(); return articleStore.subscribe(setSelectedIds); }, []);

  const articles = data?.articles || [];
  const sources = useMemo(() => SOURCE_ORDER.filter(name => articles.some(article => article.source_name === name)), [articles]);
  const visible = useMemo(() => articles.filter(article => {
    const meta = briefMeta(article); const text = `${article.game_name || ""} ${article.title || ""}`.toLowerCase();
    if (source !== "all" && article.source_name !== source) return false;
    if (!matchesTimeRange(article, timeRange)) return false;
    if (market !== "all" && meta.platformType !== market) return false;
    if (priority !== "all" && meta.priority !== priority) return false;
    if (onlyImage && !primaryImage(article)) return false;
    if (recommendedOnly && (meta.priority === "观察" || meta.dedupePrimary === false)) return false;
    if (query.trim() && !text.includes(query.trim().toLowerCase())) return false;
    return true;
  }), [articles, source, timeRange, market, priority, onlyImage, recommendedOnly, query]);
  const groups = useMemo(() => Object.entries(visible.reduce((result, article) => { const key = `${article.source_name}::${tableName(article)}`; (result[key] ||= []).push(article); return result; }, {})).sort(([left], [right]) => TABLE_ORDER.indexOf(left.split("::")[1]) - TABLE_ORDER.indexOf(right.split("::")[1])), [visible]);
  const recommendedArticles = useMemo(() => visible
    .filter(article => { const meta = briefMeta(article); return meta.priority !== "观察" && meta.dedupePrimary !== false; })
    .sort((left, right) => {
      const leftMeta = briefMeta(left); const rightMeta = briefMeta(right);
      const priorityWeight = { "重点": 2, "可选": 1, "观察": 0 };
      return (priorityWeight[rightMeta.priority] || 0) - (priorityWeight[leftMeta.priority] || 0)
        || Number(rightMeta.qualityScore || 0) - Number(leftMeta.qualityScore || 0)
        || String(right.date_text || "").localeCompare(String(left.date_text || ""), "zh-CN");
    }).slice(0, 12), [visible]);
  const selectedVisible = selectedIds.filter(id => visible.some(article => article.id === id));
  const selectArticle = (id) => selectionMode === "single" ? articleStore.setSelected(selectedIds[0] === id ? [] : [id]) : articleStore.toggle(id);
  const selectGroup = (rows) => { const ids = rows.map(row => row.id); const allSelected = ids.every(id => selectedIds.includes(id)); articleStore.setSelected(allSelected ? selectedIds.filter(id => !ids.includes(id)) : [...selectedIds, ...ids]); };
  const selectRecommended = () => articleStore.setSelected(recommendedArticles.map(article => article.id));
  const generatePoster = async () => {
    setPosterBusy(true);
    try {
      const result = await api.generateDailyPoster({ articleIds: selectedVisible });
      downloadRemoteFile(result.downloadUrl, result.fileName);
      setPosterResult(result);
    } catch (e) {
      setPosterResult({ error: e.message || "海报生成失败" });
    } finally {
      setPosterBusy(false);
    }
  };

  return <div className="raw-data-feed">
    <PageHeader eyebrow="Rule-driven feed" title="抓取资讯" description="Steam、TapTap、好游快爆、机核、游民星空按 RAW 同一套爬取、过滤、清洗与分表规则展示；可按业务日期筛选今日或未来安排。" />
    <section className="feed-workbench"><div className="feed-workbench-copy"><span>本次规则快照</span><strong>{data?.total ?? "—"}</strong><p>条可见资讯 · 已过滤 {data?.hidden ?? "—"} 条低质或不合规候选</p></div><div className="feed-workbench-steps"><div><b>01</b><span>展开分表</span></div><div><b>02</b><span>勾选资讯</span></div><div><b>03</b><span>进入简讯编辑</span></div></div><div className="feed-workbench-side"><small>更新于 {data?.generatedAt ? snapshotTime(data.generatedAt) : "—"}</small><button className="btn btn-secondary" onClick={load} disabled={loading}>{loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新快照</button></div></section>
    <section className="feed-control-strip"><div><span>当前范围</span><strong>{source === "all" ? "全部启用平台" : source}</strong><small>{visible.length} 条可选资讯</small></div><div><span>已选入简讯</span><strong>{selectedVisible.length}</strong><small>切换平台不会丢失选择</small></div><div className="feed-selection-mode" role="group" aria-label="资讯选择模式"><button className={selectionMode === "single" ? "is-active" : ""} onClick={() => { setSelectionMode("single"); if (selectedIds.length > 1) articleStore.setSelected(selectedIds.slice(0, 1)); }}>单选</button><button className={selectionMode === "multiple" ? "is-active" : ""} onClick={() => setSelectionMode("multiple")}>多选</button></div><FileSearch size={18} aria-hidden="true" /></section>
    <section className="feed-quick-filters"><div className="feed-filter-set feed-filter-set--scope"><select value={timeRange} onChange={(e) => setTimeRange(e.target.value)} aria-label="业务时间"><option value="today_future">今日 + 未来</option><option value="today">仅今日</option><option value="future">未来安排</option></select></div><div className="feed-filter-set"><select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="平台类型"><option value="all">手游 + 端游</option><option value="mobile">仅手游</option><option value="pc">仅端游</option></select><select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="简讯等级"><option value="all">全部等级</option><option value="重点">仅重点</option><option value="可选">仅可选</option><option value="观察">仅观察</option></select><label><input type="checkbox" checked={onlyImage} onChange={(e) => setOnlyImage(e.target.checked)} />有图</label><label><input type="checkbox" checked={recommendedOnly} onChange={(e) => setRecommendedOnly(e.target.checked)} />仅推荐</label></div><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索游戏或标题" aria-label="搜索游戏或标题" /><button className="btn btn-secondary feed-recommend-action" onClick={selectRecommended}>选择今日推荐 {recommendedArticles.length} 条</button></section>
    <nav className="raw-data-tabs">{["all", ...sources].map(name => <button key={name} className={source === name ? "is-active" : ""} onClick={() => setSource(name)}>{name === "all" ? "全部平台" : name}<small>{name === "all" ? articles.length : articles.filter(article => article.source_name === name).length}</small></button>)}</nav>
    {error ? <div className="raw-data-empty"><strong>{error}</strong><p>请先执行 RAW 生成脚本。</p></div> : loading && !data ? <div className="raw-data-empty"><LoaderCircle className="spin" size={22} /><p>正在加载清洗后的资讯…</p></div> : <div className="raw-data-groups">{groups.map(([key, rows], index) => { const [sourceName, name] = key.split("::"); return <FeedGroup key={key} sourceName={sourceName} name={name} rows={rows} selectedIds={selectedIds} onToggleGroup={selectGroup} onToggleArticle={selectArticle} onShow={setActiveArticle} defaultOpen={index === 0} selectionMode={selectionMode} />; })}</div>}
    {articles.length > 0 && <aside className="feed-selection-bar"><div><span>{selectedVisible.length ? "已选择" : "海报范围"}</span><strong>{selectedVisible.length || "今日"}</strong><span>{selectedVisible.length ? "条符合 RAW 规则的资讯" : "未手动选择时，自动使用今日资讯"}</span>{posterResult?.fileName ? <span className="feed-generated-file"><a href={`http://127.0.0.1:64424${posterResult.url}`} target="_blank" rel="noreferrer">打开海报</a><a href={`http://127.0.0.1:64424${posterResult.downloadUrl}`} download={posterResult.fileName}>下载 HTML</a></span> : posterResult?.error ? <small>{posterResult.error}</small> : null}</div><button className="btn btn-ghost" onClick={() => articleStore.setSelected([])} disabled={!selectedVisible.length}>清空</button><button className="btn btn-secondary" onClick={generatePoster} disabled={posterBusy}>{posterBusy ? <LoaderCircle className="spin" size={14} /> : <ImageDown size={14} />}{selectedVisible.length ? "生成海报" : "生成今日海报"}</button><button className="btn btn-primary" onClick={() => { window.location.hash = "#/brief"; }}>进入简讯编辑 <ArrowRight size={14} /></button></aside>}
    <DetailDialog article={activeArticle} onClose={() => setActiveArticle(null)} />
  </div>;
}
