import React, { useEffect, useMemo, useState } from "react";
import { ExternalLink, FileText, Flame, LoaderCircle, Radar, RefreshCw, X } from "lucide-react";
import { api } from "../services/api.js";
import "../dashboard-page.css";

const CATEGORY_ORDER = ["联动活动", "版本更新", "新游上线", "Steam 榜单", "游戏热点话题", "行业资讯"];
const CATEGORY_META = {
  "联动活动": { label: "联动活动", note: "限时合作、主题活动与福利" },
  "版本更新": { label: "版本更新", note: "版本、赛季、补丁与内容扩展" },
  "新游上线": { label: "新游上线", note: "发售、首发、测试与预约节点" },
  "Steam 榜单": { label: "Steam 榜单", note: "中国区热玩与畅销表现" },
  "游戏热点话题": { label: "游戏热点话题", note: "社区热榜前列游戏话题" },
  "行业资讯": { label: "行业资讯", note: "官方动态、公告与平台热点" },
};

function clean(text = "") {
  return String(text).replace(/<br\s*\/?>(\s*)/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function detectCategory(heading = "", body = "", source = "") {
  const text = `${heading} ${body}`.toLowerCase();
  if (/联动|合作活动|跨界|联名/.test(text)) return "联动活动";
  if (/版本|更新|赛季|补丁|dlc|扩展包|改版/.test(text)) return "版本更新";
  if (/行业|工作室|开发商|发行商|平台|财报|访谈|发布会|榜单/.test(text)) return "行业资讯";
  if (/机核|游民星空/.test(source)) return "行业资讯";
  return "新游上线";
}

function getCardData(section, index) {
  const body = clean(section.body || section.content || "");
  const firstImage = (section.blocks || []).find((block) => block.type === "image");
  const heading = section.heading || "未命名资讯";
  const gameMatch = /《([^》]+)》/.exec(heading);
  const gameName = gameMatch ? gameMatch[1].split(/[：:]/)[0].trim() : heading.split(/[：:]/)[0].trim();
  return {
    idx: index + 1,
    cat: detectCategory(heading, body, section.sourceName),
    heading,
    gameName: gameName ? `《${gameName}》` : heading,
    body: body || "暂无摘要",
    source: section.sourceName || "游戏资讯",
    url: section.detailUrl || section.url || "",
    image: firstImage?.src || firstImage?.url || null,
    dateText: section.dateText || "",
    event: heading,
    content: (section.blocks || []).filter((block) => block.type === "text").map((block) => block.content).filter(Boolean),
    contentBlocks: section.blocks || [],
    sourceId: section.sourceId || "",
  };
}

function normalizedName(value = "") {
  return String(value)
    .replace(/[《》]/g, "")
    .replace(/[（(][^)）]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function conciseEventTitle(title = "", gameName = "") {
  let value = String(title || "").trim();
  const name = String(gameName || "").trim();
  for (const prefix of [`《${name}》`, name]) {
    if (name && value.toLowerCase().startsWith(prefix.toLowerCase())) {
      value = value.slice(prefix.length);
      break;
    }
  }
  return value
    .replace(/^[\s：:、,，—-]+/, "")
    .replace(/^\s*《[^》]+》\s*[：:、,，\-—]*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryForSupplement(item = {}) {
  if (item.sourceId === "ref-steam" && /Steam\s*(?:热玩|畅销)/.test(item.table || item.title || "")) return "Steam 榜单";
  if (item.sourceId === "ref-taptap" && /\/forum\/hot\/hashtags/.test(item.detailUrl || item.sourceUrl || "")) return "游戏热点话题";
  return detectCategory(
    `${item.table || ""} ${item.title || ""}`,
    item.summary || item.content?.join(" ") || "",
    item.platform || "",
  );
}

function dashboardImage(item = {}) {
  const src = String(item.imageUrl || item.image || "").trim();
  if (!src || src.startsWith("/crawler-assets/") || src.startsWith("/api/image-proxy")) return src || null;
  return ["ref-taptap", "ref-haoyou", "ref-gcores", "ref-gamersky"].includes(item.sourceId)
    ? `/api/image-proxy?url=${encodeURIComponent(src)}`
    : src;
}

function priorityForCategory(category) {
  return { "联动活动": 0, "版本更新": 1, "新游上线": 2, "Steam 榜单": 3, "游戏热点话题": 4, "行业资讯": 5 }[category] ?? 6;
}

function sourcePriorityForItem(item = {}) {
  if (item.sourceId === "ref-taptap") return 100;
  if (item.sourceId === "ref-haoyou") return 70;
  return 0;
}

function buildLiveCards(supplements = {}) {
  const steam = supplements.steam || {};
  const taptap = supplements.taptap || {};
  const haoyou = supplements.haoyou || {};
  const news = supplements.news || {};
  const items = [
    ...(supplements.mobileEvents || taptap.events || []),
    ...(steam.newGames || []),
    ...(steam.mostPlayed || []),
    ...(steam.topSellingCN || []),
    ...(taptap.hotTopics || []),
    ...(supplements.mobileUpcoming || [...(taptap.upcoming || []), ...(haoyou.upcoming || [])]),
    ...(news.gcores || []),
    ...(news.gamersky || []),
  ];
  const deduped = new Map();
  for (const item of items) {
    const cat = categoryForSupplement(item);
    const key = normalizedName(item.gameName) || normalizedName(item.title) || item.id;
    const current = deduped.get(key);
    const candidatePriority = priorityForCategory(cat);
    const currentPriority = priorityForCategory(current?.cat);
    const sameMobileCategory = current && ["联动活动", "版本更新", "新游上线"].includes(cat) && cat === current.cat;
    if (!current || candidatePriority < currentPriority || (sameMobileCategory && sourcePriorityForItem(item) > sourcePriorityForItem(current))) {
      deduped.set(key, { ...item, cat });
    }
  }
  const limits = { "联动活动": 4, "版本更新": 5, "新游上线": 5, "Steam 榜单": 10, "游戏热点话题": 5, "行业资讯": 4 };
  const used = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0]));
  return [...deduped.values()]
    .sort((a, b) => {
      const priority = priorityForCategory(a.cat) - priorityForCategory(b.cat);
      if (priority) return priority;
      return Number(b.dateTimestamp || 0) - Number(a.dateTimestamp || 0);
    })
    .filter((item) => {
      if (used[item.cat] >= limits[item.cat]) return false;
      used[item.cat] += 1;
      return true;
    })
    .map((item, index) => ({
      idx: index + 1,
      id: item.id,
      cat: item.cat,
      heading: item.title || item.gameName || "未命名资讯",
      event: conciseEventTitle(item.title, item.gameName) || item.table || "查看资讯详情",
      gameName: item.gameName ? `《${item.gameName}》` : item.title || "未识别游戏",
      body: clean(item.summary || item.content?.[0] || "暂无摘要"),
      source: item.platform || "游戏资讯",
      sourceId: item.sourceId || "",
      url: item.detailUrl || "",
      image: dashboardImage(item),
      dateText: item.dateText || "",
      tags: item.tags || [],
      content: item.content || [],
      contentBlocks: item.contentBlocks || [],
    }));
}

// 顶部统计必须直接基于下方 PlatformSupplements 渲染的同一份数据，
// 不能再使用额外的跨平台去重/限额数组，否则会出现“统计 27、卡片 43”的口径不一致。
function displayStatsFor(supplements = {}) {
  const steam = supplements.steam || {};
  const taptap = supplements.taptap || {};
  const haoyou = supplements.haoyou || {};
  const news = supplements.news || {};
  const count = (items) => Array.isArray(items) ? items.length : 0;
  return [
    { category: "新游上线", count: count(supplements.mobileUpcoming || [...(taptap.upcoming || []), ...(haoyou.upcoming || [])]) + count(steam.newGames) },
    { category: "Steam 榜单", count: count(steam.mostPlayed) + count(steam.topSellingCN) },
    { category: "游戏热点话题", count: count(taptap.hotTopics) },
    { category: "版本更新", count: count(supplements.mobileEventsToday || []) + count(supplements.mobileEventsFuture || []) },
    { category: "行业资讯", count: count(news.gcores) + count(news.gamersky) },
  ].filter((item) => item.count > 0);
}

function DetailImage({ sourceId, image, alt = "资讯图片" }) {
  const [isIcon, setIsIcon] = useState(false);
  const url = dashboardImage({ sourceId, imageUrl: typeof image === "string" ? image : image?.url || image?.src });
  if (!url) return null;
  return (
    <figure className={`brief-detail-image${isIcon ? " is-icon" : ""}`}>
      <img
        src={url}
        alt={alt}
        loading="lazy"
        onLoad={(event) => {
          const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
          setIsIcon(Boolean(width && height && Math.abs(width - height) / Math.max(width, height) < 0.12));
        }}
      />
    </figure>
  );
}

function StructuredContent({ card }) {
  const blocks = Array.isArray(card.contentBlocks) ? card.contentBlocks : [];
  const coverUrl = String(card.image || "").trim();
  const renderText = (value, className = "", key) => (
    <p key={key} className={`brief-detail-text ${className}`.trim()}>{value}</p>
  );
  if (blocks.length) {
    return (
      <>
        {blocks.map((block, index) => {
          if (block.type === "image" && block.url) {
            return <DetailImage key={`image-${index}`} sourceId={card.sourceId} image={block.url} alt={block.alt || "正文图片"} />;
          }
          if (block.type === "text") {
            if (Array.isArray(block.segments)) {
              return (
                <p className={`brief-detail-text${block.quote ? " is-quote" : ""}`} key={`text-${index}`}>
                  {block.segments.map((segment, segmentIndex) => {
                    const text = segment.text || "";
                    if (segment.bold) return <strong key={segmentIndex}>{text}</strong>;
                    if (segment.italic) return <em key={segmentIndex}>{text}</em>;
                    return <React.Fragment key={segmentIndex}>{text}</React.Fragment>;
                  })}
                </p>
              );
            }
            return renderText(block.text || block.content || "", block.quote ? "is-quote" : "", `text-${index}`);
          }
          if (block.title || block.items) {
            return (
              <section className="brief-detail-module" key={`module-${index}`}>
                {block.title ? <h3>{block.title}</h3> : null}
                {(block.items || []).map((item, itemIndex) => (
                  <div className="brief-detail-item" key={`item-${itemIndex}`}>
                    {item.title ? <h4>{item.title}</h4> : null}
                    {item.content ? renderText(item.content, "", `item-text-${itemIndex}`) : null}
                    {(item.images || []).map((image, imageIndex) => {
                      return <DetailImage key={`item-image-${imageIndex}`} sourceId={card.sourceId} image={image.url} alt={image.label || "活动图片"} />;
                    })}
                  </div>
                ))}
              </section>
            );
          }
          return null;
        })}
      </>
    );
  }
  const paragraphs = Array.isArray(card.content) && card.content.length ? card.content : [card.body];
  return (
    <>
      {coverUrl ? <DetailImage sourceId={card.sourceId} image={coverUrl} /> : null}
      {paragraphs.filter(Boolean).map((paragraph, index) => renderText(paragraph, "", `paragraph-${index}`))}
    </>
  );
}

function BriefDetailModal({ card, onClose }) {
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  useEffect(() => {
    let disposed = false;
    if (!card?.articleId) {
      setDetail(null);
      setDetailError("");
      return undefined;
    }
    setDetail(null);
    setDetailError("");
    api.dashboardDetail(card.articleId, card.eventIndex)
      .then((result) => {
        if (!disposed) setDetail(toDetailCard(result.item));
      })
      .catch((error) => {
        if (!disposed) setDetailError(error.message || "详情读取失败");
      });
    return () => { disposed = true; };
  }, [card?.articleId, card?.eventIndex]);
  if (!card) return null;
  const displayCard = detail || card;
  return (
    <div className="brief-detail-modal" role="presentation" onMouseDown={onClose}>
      <section className="brief-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="brief-detail-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="brief-detail-header">
          <div className="brief-detail-meta"><span>{displayCard.cat}</span><span>{displayCard.source}</span><time>{displayCard.dateText || "今日"}</time></div>
          <h2 id="brief-detail-title">{displayCard.gameName}</h2>
          <p>{displayCard.event}</p>
          {displayCard.url ? <a href={displayCard.url} target="_blank" rel="noreferrer">打开来源原文 <ExternalLink size={13} /></a> : null}
          <button className="brief-detail-close" type="button" onClick={onClose} aria-label="关闭内容查看"><X size={18} /></button>
        </header>
        <div className="brief-detail-body">{detail ? <StructuredContent card={displayCard} /> : detailError ? <p className="brief-detail-text">{detailError}</p> : <div className="brief-detail-loading"><LoaderCircle className="spin" size={20} /><span>正在读取完整内容…</span></div>}</div>
      </section>
    </div>
  );
}

function Tags({ tags, tagStatus }) {
  if (!tags?.length) {
    const label = tagStatus === "pending_enrichment"
      ? "标签待补全"
      : tagStatus === "fetch_failed"
        ? "标签获取失败，待重试"
        : tagStatus === "no_gameplay_tags"
          ? "确实没有玩法标签"
          : "暂无标签";
    return <span className="supplement-tag supplement-tag--muted">{label}</span>;
  }
  return <div className="supplement-tags">{tags.map((tag) => <span className="supplement-tag" key={tag}>{tag}</span>)}</div>;
}

function RankChange({ item }) {
  if (item.isNewEntry) return <span className="chart-change chart-change--new">重点 · 新上榜</span>;
  if (item.rankGain > 0) return <span className="chart-change chart-change--up">▲ {item.rankGain}</span>;
  if (item.rankGain < 0) return <span className="chart-change chart-change--down">▼ {Math.abs(item.rankGain)}</span>;
  return <span className="chart-change">—</span>;
}

function HotRankSignal({ item }) {
  if (item.isNewEntry) return <span className="supplement-chart-label is-new">重点 · 新上榜</span>;
  if (item.rankGain > 0) return <span className="supplement-chart-label is-up">排名提升 {item.rankGain} 位</span>;
  return null;
}

function toDetailCard(item = {}) {
  return {
    id: item.id,
    articleId: item.articleId || item.id,
    eventIndex: item.eventIndex ?? null,
    cat: categoryForSupplement(item),
    gameName: item.gameName ? `《${item.gameName}》` : item.title || "游戏资讯",
    event: conciseEventTitle(item.title, item.gameName) || item.table || "查看资讯详情",
    dateText: item.dateText || "今日",
    source: item.platform || "游戏资讯",
    sourceId: item.sourceId || "",
    url: item.detailUrl || item.sourceUrl || "",
    image: dashboardImage(item),
    content: item.content || [],
    contentBlocks: item.contentBlocks || [],
  };
}

function mobileScheduleTime(item = {}) {
  if (Number(item.dateTimestamp || 0)) return Number(item.dateTimestamp);
  const match = /(\d{1,2})月(\d{1,2})日/.exec(String(item.dateText || ""));
  if (!match) return Number.MAX_SAFE_INTEGER;
  return new Date(new Date().getFullYear(), Number(match[1]) - 1, Number(match[2])).getTime();
}

function cleanMobileUpcomingSummary(item = {}) {
  return splitSummary(item.summary)
    .filter((part) => !/^标签：/u.test(part) && part !== "下载")
    .filter((part) => !isMobileEventLabel(part) && !isMobileScheduleLabel(part))
    .join("；");
}

function cleanCardSummary(item = {}) {
  const value = clean(item.summary || "");
  if (item.sourceId !== "ref-haoyou") return value;
  return splitSummary(value)
    .filter((part) => !/^标签：/u.test(part) && part !== "下载")
    .join("；");
}

function splitSummary(value = "") {
  return clean(value)
    .split(/[；;]/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isMobileEventLabel(value = "") {
  return /^(?:(?:\d{1,2}:\d{2}\s*)?(?:正式)?(?:首发|上线|开测|测试|预约|即将上线|即将测试))(?:[！!，,。].*)?$/u.test(value.trim());
}

function isMobileScheduleLabel(value = "") {
  const text = value.trim();
  return /^(?:今天|明天|后天|\d{1,2}月\d{1,2}日|\d{1,2}[月\-/]\d{1,2}日?)\s*(?:首发|上线|测试|预约|开测)$/u.test(text);
}

function mobileScheduleLabel(item = {}) {
  const candidates = splitSummary(item.summary).filter(isMobileScheduleLabel);
  if (candidates.length) return candidates[0];
  const date = clean(item.dateText || "").replace(/\s*(?:首发|上线|测试|预约).*$/u, "").trim();
  const event = conciseEventTitle(item.title, item.gameName);
  return [date, event].filter(Boolean).join(" ") || "查看原文";
}

function cardImage(item = {}, variant = "default") {
  const rawImage = String(item.imageUrl || item.image || "").trim();
  if (variant === "mobile-upcoming" && item.sourceId === "ref-haoyou") {
    const coverImage = String(item.coverImageUrl || "").trim();
    return coverImage ? dashboardImage({ ...item, imageUrl: coverImage }) : dashboardImage(item);
  }
  if (variant !== "mobile-upcoming" || item.sourceId !== "ref-taptap" || !rawImage) return dashboardImage(item);
  const appIcon = rawImage.replace(/\/_tap_(?:banner|cover)\.(?:jpg|jpeg|png|webp)(?:\?.*)?$/iu, "/_tap_appicon.jpg");
  return dashboardImage({ ...item, imageUrl: appIcon });
}

function SupplementCard({ item, showRank = false, compact = false, variant = "default", onOpen }) {
  const title = item.title || item.gameName;
  const image = cardImage(item, variant);
  const [haoyouImageShape, setHaoyouImageShape] = useState("pending");
  const isMobileUpcoming = variant === "mobile-upcoming";
  const isMobileTodayEvent = variant === "mobile-today-event";
  const isHaoyouUpdate = variant === "haoyou-update";
  const isSteamChart = variant === "steam-highlight";
  const isSteamNewGame = variant === "steam-new-game";
  const isEditorial = variant === "editorial";
  const isTimedUpdate = variant === "taptap-event" || variant === "haoyou-update" || isMobileTodayEvent;
  const canOpen = !["mobile-upcoming", "hot-topic", "steam-highlight", "steam-new-game"].includes(variant);
  const sourceHref = item.sourceUrl || item.detailUrl || "";
  const displaySummary = isMobileUpcoming
    ? cleanMobileUpcomingSummary(item)
    : cleanCardSummary(item);
  const openDetail = (event) => {
    event?.stopPropagation();
    onOpen?.(toDetailCard(item));
  };
  const originalLink = (className, children) => sourceHref ? (
    <a className={className} href={sourceHref} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{children}</a>
  ) : <span className={className}>{children}</span>;

  let mainContent;
  if (isSteamChart) {
    mainContent = <>
      {originalLink("supplement-card-game-link", item.gameName)}
      <div className="supplement-chart-signal"><HotRankSignal item={item} />{item.chartSummary && <span className="supplement-chart-label">{item.chartSummary}</span>}</div>
      <Tags tags={item.tags} tagStatus={item.tagStatus} />
    </>;
  } else if (isSteamNewGame) {
    mainContent = <>
      {originalLink("supplement-card-game-link", item.gameName)}
      <Tags tags={item.tags} tagStatus={item.tagStatus} />
      {displaySummary && <p>{displaySummary}</p>}
    </>;
  } else if (variant === "hot-topic") {
    mainContent = <>
      {originalLink("supplement-card-title supplement-card-title--topic", title)}
      <div className="supplement-card-game-name">《{item.gameName}》</div>
      {displaySummary && <p>{displaySummary}</p>}
    </>;
  } else if (isMobileUpcoming) {
    mainContent = <>
      <div className="supplement-card-game-row"><h4>{item.gameName}</h4><span className="supplement-card-platform">{item.platform}</span></div>
      <Tags tags={item.tags} tagStatus={item.tagStatus} />
      {originalLink("supplement-mobile-schedule", mobileScheduleLabel(item))}
      {displaySummary && <p>{displaySummary}</p>}
    </>;
  } else if (isEditorial) {
    mainContent = <>
      {originalLink("supplement-card-title supplement-card-title--editorial", title)}
      <div className="supplement-card-game-name">《{item.gameName}》</div>
      {displaySummary && <p>{displaySummary}</p>}
      <button className="supplement-card-open" type="button" onClick={openDetail}>查看内容</button>
    </>;
  } else if (isTimedUpdate) {
    mainContent = <>
      <div className="supplement-card-game-row"><h4>{item.gameName}</h4>{isMobileTodayEvent ? <span className="supplement-card-update-pill">更新</span> : <div className="supplement-card-update-meta">{item.dateText && <span className="supplement-card-date">{item.dateText}</span>}</div>}</div>
      {originalLink("supplement-card-title", title)}
      {isMobileTodayEvent ? <><div className="supplement-card-update-actions"><Tags tags={item.tags} tagStatus={item.tagStatus} /><button className="supplement-card-open" type="button" onClick={openDetail}>查看内容</button></div>{item.dateText && originalLink("supplement-mobile-schedule supplement-mobile-update-time", `更新时间：${item.dateText}`)}</> : <Tags tags={item.tags} tagStatus={item.tagStatus} />}
      {displaySummary && <p>{displaySummary}</p>}
      {!isMobileTodayEvent && <button className="supplement-card-open" type="button" onClick={openDetail}>查看内容</button>}
    </>;
  } else {
    mainContent = <>
      <div className="supplement-card-kicker">
        {showRank && <span className="chart-rank">#{item.rank || "—"}</span>}
        {item.dateText && <span>{item.dateText}</span>}
        {showRank && <RankChange item={item} />}
      </div>
      <h4>{item.gameName}</h4>
      {originalLink("supplement-card-title", title)}
      <Tags tags={item.tags} tagStatus={item.tagStatus} />
      {displaySummary && <p>{displaySummary}</p>}
      <button className="supplement-card-open" type="button" onClick={openDetail}>查看内容</button>
    </>;
  }

  const resolveHaoyouImageShape = (event) => {
    if (!isHaoyouUpdate) return;
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (!naturalWidth || !naturalHeight) return;
    // 图片偶有 1-2px 的源站压缩误差，允许 8% 偏差仍按方图展示。
    setHaoyouImageShape(Math.abs(naturalWidth / naturalHeight - 1) <= 0.08 ? "square" : "nonsquare");
  };

  return (
    <article className={`supplement-card supplement-card--${variant}${isHaoyouUpdate ? ` is-haoyou-${haoyouImageShape}` : ""}${compact ? " supplement-card--compact" : ""}${canOpen ? " is-openable" : " is-static"}`} tabIndex={canOpen ? 0 : undefined} onClick={canOpen ? openDetail : undefined} onKeyDown={canOpen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetail(event); } } : undefined}>
      {image && <img className="supplement-card-image" src={image} alt="" loading="lazy" onLoad={resolveHaoyouImageShape} />}
      <div className="supplement-card-main">{mainContent}</div>
    </article>
  );
}

function ChartPanel({ title, subtitle, icon, items, allItems, variant, emptyText, onOpen, onViewAll }) {
  return <section className="chart-panel"><header className="supplement-panel-header"><div><span className="supplement-eyebrow">{icon}{subtitle}</span><h3>{title}</h3></div><button type="button" className="supplement-view-all" onClick={() => onViewAll?.({ title, subtitle, items: allItems || items, variant, chart: true })}>查看全部</button></header>{items?.length ? <div className="chart-list">{items.map((item) => <SupplementCard item={item} showRank compact variant={variant} onOpen={onOpen} key={item.id} />)}</div> : <div className="supplement-empty">{emptyText || "本次没有可展示的资讯。"}</div>}</section>;
}

function PlatformPanel({ title, source, items, allItems, variant, variantFor, onOpen, onViewAll }) {
  const resolveVariant = (item) => variantFor?.(item) || variant;
  return <section className={`supplement-panel${variant ? ` supplement-panel--${variant}` : ""}`}><header className="supplement-panel-header"><div><span className="supplement-eyebrow">{source}</span><h3>{title}</h3></div><button type="button" className="supplement-view-all" onClick={() => onViewAll?.({ title, subtitle: source, items: allItems || items, variant, variantFor })}>查看全部</button></header>{items?.length ? <div className="supplement-list">{items.map((item) => <SupplementCard item={item} variant={resolveVariant(item)} onOpen={onOpen} key={item.id} />)}</div> : <div className="supplement-empty">暂无可展示的资讯。</div>}</section>;
}

function AllCardsModal({ value, onClose, onOpen }) {
  if (!value) return null;
  return <div className="brief-detail-modal supplement-list-modal" role="presentation" onMouseDown={onClose}><section className="supplement-list-dialog" role="dialog" aria-modal="true" aria-labelledby="supplement-list-title" onMouseDown={(event) => event.stopPropagation()}><header className="supplement-list-dialog-header"><div><span>{value.subtitle || "已完成筛选"}</span><h2 id="supplement-list-title">{value.title}</h2><small>共 {value.items?.length || 0} 条，已按当前栏目规则去重</small></div><button className="brief-detail-close" type="button" onClick={onClose} aria-label="关闭查看全部"><X size={18} /></button></header><div className={`supplement-list-dialog-body${value.chart ? " is-chart" : ""}`}>{value.items?.length ? value.items.map((item) => <SupplementCard item={item} showRank={value.chart} compact={value.chart} variant={value.variantFor?.(item) || value.variant} onOpen={(detail) => { onOpen(detail); onClose(); }} key={item.id} />) : <div className="supplement-empty">暂无符合筛选规则的资讯。</div>}</div></section></div>;
}

function PlatformSupplements({ data, onOpen, onViewAll }) {
  const steam = data?.steam || {};
  const taptap = data?.taptap || {};
  const haoyou = data?.haoyou || {};
  const news = data?.news || {};
  const mobileUpcoming = data?.mobileUpcoming || [...(taptap.upcoming || []), ...(haoyou.upcoming || [])].sort((left, right) => mobileScheduleTime(left) - mobileScheduleTime(right));
  const mobileUpcomingAll = data?.mobileUpcomingAll || mobileUpcoming;
  const mobileEventsToday = data?.mobileEventsToday || [];
  const mobileEventsFuture = data?.mobileEventsFuture || [];
  const mobileEventsTodayAll = data?.mobileEventsTodayAll || mobileEventsToday;
  const mobileEventsFutureAll = data?.mobileEventsFutureAll || mobileEventsFuture;
  const editorial = data?.editorial || [...(news.gcores || []), ...(news.gamersky || [])];
  const editorialAll = data?.editorialAll || editorial;
  const viewAll = (value) => onViewAll?.(value);
  return <section className="supplements" aria-label="今日简讯内容">
    <section id="daily-new-games" className="supplement-anchor"><PlatformPanel title="手机游戏 · 即将上线" source="TapTap / 好游快爆 · 仅今日 · 完整展示" items={mobileUpcoming} allItems={mobileUpcomingAll} variant="mobile-upcoming" onOpen={onOpen} onViewAll={viewAll} /></section>
    <section id="daily-events" className="supplement-anchor"><div className="supplement-two-column"><PlatformPanel title="版本更新 / 活动 / 联动 · 今日" source="TapTap / 好游快爆 · 今日 · 最多 15 条" items={mobileEventsToday} allItems={mobileEventsTodayAll} variant="taptap-event" variantFor={(item) => item.sourceId === "ref-haoyou" ? "haoyou-update" : "taptap-event"} onOpen={onOpen} onViewAll={viewAll} /><PlatformPanel title="版本更新 / 活动 / 联动 · 未来" source="TapTap / 好游快爆 · 明日完整展示 · 不足 10 条按日期补充" items={mobileEventsFuture} allItems={mobileEventsFutureAll} variant="taptap-event" variantFor={(item) => item.sourceId === "ref-haoyou" ? "haoyou-update" : "taptap-event"} onOpen={onOpen} onViewAll={viewAll} /></div></section>
    <section id="daily-hot-topics" className="supplement-anchor"><PlatformPanel title="热榜话题" source="TapTap · 热门话题" items={taptap.hotTopics || []} allItems={taptap.hotTopics || []} variant="hot-topic" onOpen={onOpen} onViewAll={viewAll} /></section>
    <section id="daily-steam" className="supplement-anchor"><ChartPanel title="Steam · 热门 / 新上榜" subtitle="热玩榜 × 畅销榜 · 至多 10 条" icon={<Flame size={12} />} items={steam.highlights || []} allItems={steam.highlights || []} variant="steam-highlight" emptyText="暂无符合“热门 / 新上榜”条件的 Steam 游戏。" onOpen={onOpen} onViewAll={viewAll} /><PlatformPanel title="Steam 新游上线" source="Steam · 新游上线" items={steam.newGames || []} allItems={steam.newGames || []} variant="steam-new-game" onOpen={onOpen} onViewAll={viewAll} /></section>
    {editorial.length ? <section id="daily-editorial" className="supplement-anchor"><PlatformPanel title="端游资讯" source="机核 / 游民星空 · 已完成正文与图文布局校验" items={editorial} allItems={editorialAll} variant="editorial" onOpen={onOpen} onViewAll={viewAll} /></section> : null}
  </section>;
}

function UpdateProgressModal({ open, running, progress, onClose }) {
  if (!open) return null;
  const failed = Boolean(progress?.error);
  const completed = !running && !failed && Boolean(progress?.finishedAt);
  const note = failed
    ? "本次更新未完成，请稍后重试。"
    : completed
      ? "资讯已更新完成。"
      : "正在抓取并整理最新资讯…";
  return (
    <div className="brief-detail-modal update-progress-modal" role="presentation" onMouseDown={() => !running && onClose()}>
      <section className="update-progress-dialog" role="dialog" aria-modal="true" aria-labelledby="update-progress-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="update-progress-spinner" aria-hidden="true"><LoaderCircle className={running ? "spin" : ""} size={25} /></div>
        <h2 id="update-progress-title">更新资讯</h2>
        <p>{note}</p>
        <div className={`update-progress-track${running ? " is-running" : ""}${completed ? " is-complete" : ""}${failed ? " is-failed" : ""}`} role="progressbar" aria-label="资讯更新进度" aria-busy={running} aria-valuemin="0" aria-valuemax="100" aria-valuenow={completed ? 100 : undefined}>
          <span />
        </div>
        {!running && <button className="daily-brief-action update-progress-close" type="button" onClick={onClose}>完成</button>}
      </section>
    </div>
  );
}

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastUpdate, setLastUpdate] = useState("");
  const [error, setError] = useState("");
  const [selectedCard, setSelectedCard] = useState(null);
  const [allCardsModal, setAllCardsModal] = useState(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [crawlProgress, setCrawlProgress] = useState(null);

  const load = async ({ quiet = false, recover = true } = {}) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      // 今日简讯只消费实时 Dashboard 数据；按日期留档由简讯编辑页单独读取。
      const dashboardResult = await api.dashboard();
      setDashboard(dashboardResult);
      setError("");
    } catch (error) {
      if (recover) {
        try {
          await api.recoverBackend();
          const dashboardResult = await api.dashboard();
          setDashboard(dashboardResult);
          setError("");
          return;
        } catch (recoveryError) {
          setError(recoveryError.message || error.message || "今日资讯暂时无法读取");
          setDashboard(null);
          return;
        }
      }
      setError(error.message || "今日资讯暂时无法读取");
      setDashboard(null);
    } finally {
      setLastUpdate(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); const timer = setInterval(() => load({ quiet: true }), 300000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!selectedCard) return undefined;
    const handleKeyDown = (event) => { if (event.key === "Escape") setSelectedCard(null); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCard]);

  useEffect(() => {
    if (!updateDialogOpen || !running) return undefined;
    let disposed = false;
    const readProgress = async () => {
      try {
        const result = await api.crawlStatus();
        if (!disposed) setCrawlProgress(result);
      } catch {}
    };
    readProgress();
    const timer = window.setInterval(readProgress, 700);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [updateDialogOpen, running]);

  const updateNews = async () => {
    setUpdateDialogOpen(true);
    setRunning(true);
    setCrawlProgress({ active: true, operation: "更新资讯", stage: "starting", sourceProgress: [] });
    setError("");
    try {
      await api.crawlCandidates([]);
      const latest = await api.crawlStatus();
      setCrawlProgress(latest);
      await load({ quiet: true });
    }
    catch (e) { setCrawlProgress((current) => ({ ...(current || {}), active: false, error: e.message || "资讯更新失败" })); }
    finally { setRunning(false); }
  };

  const displayStats = useMemo(() => displayStatsFor(dashboard?.supplements), [dashboard]);
  const activeStats = displayStats;
  const totalCardCount = activeStats.reduce((sum, item) => sum + item.count, 0);
  const visibleCategories = activeStats.map((item) => item.category);
  const date = dashboard?.generatedAt
    ? new Date(dashboard.generatedAt).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })
    : new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
  const liveLead = visibleCategories.length
    ? `${date}重点游戏动态：${activeStats.map((item) => `${item.category}${item.count}条`).join("、")}。`
    : "当前暂无可阅读的游戏动态。";

  const scrollToCategory = (category) => {
    const targets = {
      "全部": "daily-brief-top",
      "联动活动": "daily-events",
      "版本更新": "daily-events",
      "新游上线": "daily-new-games",
      "Steam 榜单": "daily-steam",
      "游戏热点话题": "daily-hot-topics",
      "行业资讯": "daily-editorial",
    };
    const target = targets[category] || "daily-brief-top";
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (loading) return <div className="daily-brief-empty"><LoaderCircle className="spin" size={24} /><p>正在整理今日简讯…</p></div>;
  if (error && !dashboard) return <div className="daily-brief-error"><p>{error}</p><button className="btn btn-primary" onClick={() => load()}><RefreshCw size={13} />重新加载并恢复服务</button></div>;

  return (
    <div className="daily-brief" id="daily-brief-top">
      <header className="daily-brief-hero">
        <div className="daily-brief-hero-inner">
          <h1>今日简讯</h1>
          <p className="daily-brief-date">{date}{lastUpdate ? ` · 更新于 ${lastUpdate}` : ""}</p>
          <div className="daily-brief-total"><strong>{totalCardCount}</strong><span>条今日重点</span></div>
          <div className="daily-brief-stat-row"><button className="daily-brief-stat" type="button" onClick={() => scrollToCategory("全部")}><strong>{totalCardCount}</strong><span>全部</span></button>{activeStats.map((item) => <button className="daily-brief-stat" type="button" key={item.category} onClick={() => scrollToCategory(item.category)}><strong>{item.count}</strong><span>{item.category}</span></button>)}</div>
          <div className="daily-brief-actions">
            <button className="daily-brief-action" title="重新读取当前已更新的资讯，不启动联网抓取。" onClick={() => load({ quiet: true })} disabled={refreshing || running}>{refreshing ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}刷新阅读</button>
            <button className="daily-brief-action daily-brief-action-alt" title="立即启动本项目已启用的资讯更新，并在此页显示运行进度。" onClick={updateNews} disabled={running || refreshing}>{running ? <LoaderCircle className="spin" size={13} /> : <Radar size={13} />}更新资讯</button>
          </div>
        </div>
      </header>

      <main className="daily-brief-main">
        <PlatformSupplements data={dashboard?.supplements} onOpen={setSelectedCard} onViewAll={setAllCardsModal} />
        <footer className="daily-brief-footer">GameNews Hub</footer>
      </main>
      <BriefDetailModal card={selectedCard} onClose={() => setSelectedCard(null)} />
      <AllCardsModal value={allCardsModal} onClose={() => setAllCardsModal(null)} onOpen={setSelectedCard} />
      <UpdateProgressModal open={updateDialogOpen} running={running} progress={crawlProgress} onClose={() => setUpdateDialogOpen(false)} />
    </div>
  );
}
