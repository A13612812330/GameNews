const TEMPLATES = {
  T1: { title: "今日游戏简讯", style: "极简报" },
  T2: { title: "今日游戏动态速览", style: "活泼报" },
  T3: { title: "今日游戏简讯", style: "专业报" },
  T4: { title: "游戏资讯日报", style: "深度报" },
  T5: { title: "今日重点游戏资讯", style: "重点报" },
};

function normalizedGameName(value = "") {
  return String(value)
    .replace(/[《》]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedEventText(value = "") {
  return String(value)
    .replace(/《[^》]+》/g, " ")
    .replace(/(?:\d{1,2}月\d{1,2}日|\d{1,2}[./-]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/g, " ")
    .replace(/(?:更新|版本|活动|联动|上线|开启|首发|公测|测试|官方|游戏)/g, " ")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 36);
}

function monthDayKey(value = "") {
  const match = String(value).match(/(?:\d{4}年)?\s*(\d{1,2})月\s*(\d{1,2})日/);
  return match ? `${Number(match[1])}-${Number(match[2])}` : "";
}

function cleanEventParagraphs(event = {}) {
  const targetDate = monthDayKey(event.dateText || event.title);
  const isHaoyouEvent = event.sourceId === "ref-haoyou" && /版本|更新|活动|联动|赛季/.test(`${event.category || ""} ${event.title || ""}`);
  const noise = /^(?:好游快爆APP提供|浙B\d|下载|预约|标签[：:]|非对称竞技|动作\s*[\/、]\s*冒险|论坛\d+|免责声明)/iu;
  const unique = new Set();
  return (event.paragraphs || []).filter(Boolean).map((paragraph) => String(paragraph).replace(/\s+/g, " ").trim()).filter((paragraph) => {
    if (paragraph.length < 8 || noise.test(paragraph)) return false;
    const compact = paragraph.replace(/\s+/g, "");
    if (unique.has(compact)) return false;
    unique.add(compact);
    if (!isHaoyouEvent) return true;
    const lineDate = monthDayKey(paragraph);
    // 好游快爆详情页会把多年动态、测试公告和介绍文案拼进同一列表。
    // 时间线卡片已有本次更新日期时，只接受同一天的动态，避免把无日期的历史长文误带入简讯。
    if (targetDate && lineDate !== targetDate) return false;
    if (/已于.*(?:公测|测试)|测试资格|问卷|版号|备案|520发布会|正式曝光/.test(paragraph)) return false;
    return true;
  });
}

function eventPriority(event = {}) {
  const source = event.sourceId || "";
  const sourceWeight = source === "ref-taptap" ? 300 : source === "ref-haoyou" ? 200 : source === "ref-steam" ? 160 : source === "ref-gcores" || source === "ref-gamersky" ? 120 : 0;
  const meta = event.facts?.briefMeta || {};
  return sourceWeight + Number(meta.qualityScore || 0) + Math.min(40, (event.paragraphs || []).join(" ").length / 80);
}

function dedupeBriefEvents(events = []) {
  const chosen = new Map();
  for (const event of events) {
    const kind = briefKindFor(event);
    const game = normalizedGameName(event.gameName || event.title).toLowerCase();
    const text = normalizedEventText(event.title || event.category);
    // 新游只保留同游戏的一条；版本/活动则按游戏 + 事件标题去重，避免不同活动被误合并。
    const key = kind === "new-game" ? `${kind}:${game}` : `${kind}:${game}:${text || event.category || "动态"}`;
    const current = chosen.get(key);
    if (!current || eventPriority(event) > eventPriority(current)) chosen.set(key, event);
  }
  return [...chosen.values()];
}

function stripRepeatedGameName(value, gameName) {
  const canonicalName = normalizedGameName(gameName);
  if (!canonicalName) return String(value || "").trim();
  const escapedName = canonicalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(value || "")
    .replace(/《([^》]+)》/g, (matched, name) =>
      normalizedGameName(name) === canonicalName ? "" : matched,
    )
    .replace(new RegExp(`^${escapedName}[：:、,，\\s-]*`), "")
    .replace(/^[：:、,，\s-]+/, "")
    .trim();
}

/** 清洗标题：去平台名、评分、状态后缀、噪声 */
function cleanHeading(
  gameName = "",
  category = "",
  title = "",
  paragraphs = [],
) {
  let h = title;

  // 1. 优先用书名号内容 + 事件
  const bm = h.match(/《([^》]{2,20})》/);
  const gm = gameName.replace(/预约|下载|测试|首曝/g, "").trim();
  const displayGameName = normalizedGameName(gm) || normalizedGameName(bm?.[1]);
  // 先去掉完整游戏名再抽取事件，避免“更新”前固定窗口截取到游戏名尾部。
  const eventSource = stripRepeatedGameName(h, displayGameName)
    .replace(/《[^》]+》/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 2. 提取事件关键词
  let event = "";
  if (/联动/.test(h)) {
    const m =
      h.match(/《[^》]+》[^，,\n]{0,20}/) || h.match(/联动[^，,\n]{0,20}/);
    event = m ? m[0].slice(0, 20) : "联动活动";
  } else if (/赛季/.test(h)) {
    const m =
      h.match(/S?\d+赛季[^，,\n]{0,15}/) ||
      h.match(/[^，,\n]*赛季[^，,\n]{0,10}/);
    event = m ? m[0] : "新赛季";
  } else if (/版本/.test(h) || /更新/.test(h)) {
    const m = eventSource.match(/[^，,\n]{0,10}(版本|更新)[^，,\n]{0,20}/);
    event = m ? m[0] : "版本更新";
  } else if (/测试|公测|内测/.test(h)) {
    const m = h.match(/[^，,\n]{0,15}(测试|公测|内测)/);
    event = m ? m[0] : "开启测试";
  } else if (/上线|发售|发布/.test(h)) {
    event = "正式上线";
  } else if (/定档/.test(h)) {
    event = "上线定档";
  } else if (/预告|前瞻/.test(h)) {
    event = "最新预告";
  } else if (/活动|福利|白嫖|送\w+|领取/.test(h)) {
    const m = h.match(/[^，,\n]{0,15}(活动|福利)/);
    event = m ? m[0] : "限时活动";
  } else {
    event = category === "新游上线" ? "新品上线" : "";
  }

  // 3. 拼接: 《游戏名》+ 事件
  event = stripRepeatedGameName(event, displayGameName);
  const name = displayGameName ? `《${displayGameName.slice(0, 12)}》` : "";
  if (name && event) return `${name}${event}`;
  if (name) return name;
  if (event) return event;

  // 4. 降级：直接清洗标题
  return h
    .replace(/好游快爆APP提供|快爆|TapTap|游民星空|机核|九游|游侠/g, "")
    .replace(/【[^】]*】/g, "")
    .replace(/\[\d{4}-\d{2}-\d{2}\]/g, "")
    .replace(/\d+\.\d+分?\s*/g, "")
    .replace(/\d+人评价/g, "")
    .replace(/预约|下载|首曝/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 40);
}

/** 按分类生摘要 */
function bodyByCategory(paragraphs, category, title, gameName) {
  const ps = (paragraphs || []).filter((p) => p.length >= 12);

  // 联动/活动/版本更新 → 找事件描述
  if (/联动|更新|赛季|版本|活动/.test(category)) {
    for (const p of ps) {
      if (
        /联动/.test(p) ||
        /版本/.test(p) ||
        /赛季/.test(p) ||
        /更新/.test(p) ||
        /开启/.test(p) ||
        /上线/.test(p)
      ) {
        return p.slice(0, 200);
      }
    }
  }

  // 新游上线 → 优先找简介段落
  if (/新游|上线|发售/.test(category)) {
    for (const p of ps) {
      if (
        /(?:一款|打造|呈现|世界|开放|角色|动作|策略|模拟|射击)/.test(p) &&
        p.length > 30
      ) {
        return p.slice(0, 200);
      }
    }
  }

  // 测试/公测 → 找时间+平台
  if (/测试|公测|内测/.test(category)) {
    for (const p of ps) {
      if (/月|日|测试|开启|iOS|Android|PC|Steam/.test(p)) {
        return p.slice(0, 200);
      }
    }
  }

  // 降级
  return ps[0]?.slice(0, 150) || `${title} — 详情待核实`;
}

/** 智能导语 */
function smartLead(events, date, style = "professional") {
  const byCat = {};
  for (const e of events) {
    const cat = e.category || "新游上线";
    byCat[cat] = (byCat[cat] || 0) + 1;
  }

  // 选最重要的 2~3 条做导语
  const highlights = events
    .filter((e) => /联动|赛季|版本|测试/.test(e.category || ""))
    .slice(0, 3);
  const restCount = events.length - highlights.length;

  const parts = [`${date}游戏动态`];
  if (highlights.length) {
    parts.push(
      highlights
        .map((e) => {
          const gn =
            e.gameName?.replace(/[-\s]*预约|下载|测试/g, "").trim() || "";
          if (gn) return `《${gn.slice(0, 10)}》${e.category}`;
          return e.category;
        })
        .join("、"),
    );
  }
  if (restCount > 0) parts.push(`另有${restCount}款新游资讯`);
  const normal =
    parts.length === 1 ? parts[0] : parts[0] + "：" + parts.slice(1).join("，");
  if (style === "minimal") return `${date} · 已选 ${events.length} 条游戏资讯`;
  if (style === "casual")
    return `今天值得关注：${normal.replace(/^\d+月\d+日游戏动态：?/, "")}`;
  return normal;
}

function imageFor(event, value, fallbackId) {
  const found = (event.images || []).find(
    (image) => image.originalUrl === value || image.src === value,
  );
  const remote = found?.src || value || "";
  const src = String(remote).startsWith("/crawler-assets/")
    ? remote
    : ["ref-taptap", "ref-gcores", "ref-gamersky"].includes(event.sourceId)
      ? `/api/image-proxy?url=${encodeURIComponent(remote)}`
      : remote;
  return src
    ? { id: found?.id || fallbackId, type: "image", src, alt: "" }
    : null;
}

function contentBlocksFor(event, index, fallbackBody) {
  const blocks = [];
  const addText = (content, format = "body") => {
    const value = String(content || "").trim();
    if (value)
      blocks.push({
        id: `b-${index}-text-${blocks.length}`,
        type: "text",
        content: value,
        format,
      });
  };
  const addImage = (value) => {
    const image = imageFor(event, value, `b-${index}-img-${blocks.length}`);
    if (image) blocks.push(image);
  };
  const facts = event.facts || {};
  const tapEvent = Array.isArray(facts.taptapEvents)
    ? facts.taptapEvents.find(
        (item) => item.title && event.title?.includes(item.title),
      ) || facts.taptapEvents[0]
    : null;

  if (tapEvent?.blocks?.length) {
    for (const section of tapEvent.blocks) {
      addText(section.title || "活动内容", "section");
      for (const item of section.items || []) {
        addText(item.title, "subheading");
        addText(item.content, "body");
        for (const image of item.images || []) addImage(image.url);
      }
    }
  } else if (facts.gcoresLayout?.length) {
    for (const block of facts.gcoresLayout) {
      if (block.type === "image") addImage(block.url);
      else if (block.type === "text")
        addText(
          (block.segments || []).map((segment) => segment.text || "").join(""),
          block.quote ? "quote" : "body",
        );
    }
  } else if (facts.gamerskyLayout?.length) {
    for (const block of facts.gamerskyLayout) {
      if (block.type === "image") addImage(block.url);
      else if (block.type === "text") addText(block.text, "body");
    }
  } else {
    for (const paragraph of (event.paragraphs || []).filter(Boolean))
      addText(paragraph, "body");
  }

  if (!blocks.some((block) => block.type === "text"))
    addText(fallbackBody, "body");
  const usedImages = new Set(
    blocks.filter((block) => block.type === "image").map((block) => block.src),
  );
  for (const image of event.images || []) {
    if (image?.src && !usedImages.has(image.src))
      blocks.push({
        id: image.id || `b-${index}-img-${blocks.length}`,
        type: "image",
        src: image.src,
        alt: "",
      });
  }
  return blocks;
}

function cloneBlock(block) {
  return {
    ...block,
    materialId: block.materialId || block.id,
    id: `${block.id}-draft`,
  };
}

function briefKindFor(event = {}) {
  const text = `${event.category || ""} ${event.title || ""}`;
  if (/联动|活动|版本|更新|赛季|补丁/.test(text)) return "event";
  if (
    event.sourceId === "ref-gcores" ||
    event.sourceId === "ref-gamersky" ||
    /行业资讯|官方资讯/.test(text)
  ) return "news";
  return "new-game";
}

function defaultBlocksFor(
  materialBlocks,
  { contentMode, imagesPerArticle, textBudget, briefKind },
) {
  const requestedImages = Number(imagesPerArticle);
  const imageLimit =
    requestedImages < 0 ? Infinity : Math.max(0, requestedImages || 0);
  const clip = (value, limit) =>
    value.length > limit
      ? `${value.slice(0, Math.max(0, limit - 1)).trim()}…`
      : value;
  const primaryImage = materialBlocks.find((block) => block.type === "image");
  // 全文模式是编辑器的保真入口：不重排、不裁剪、不限制图片数量。
  // 摘要模式才应用字数和图片上限，避免“全文”仍被总字数预算截断。
  if (contentMode === "full") {
    return materialBlocks.map(cloneBlock);
  }
  if (briefKind === "new-game") {
    return primaryImage ? [cloneBlock(primaryImage)] : [];
  }

  const summary =
    materialBlocks.find(
      (block) => block.type === "text" && block.format === "body",
    ) || materialBlocks.find((block) => block.type === "text");
  const images = materialBlocks
    .filter((block) => block.type === "image")
    .slice(0, imageLimit);
  const compactBlocks = [
    summary
      ? {
          ...cloneBlock(summary),
          content: clip(summary.content || "", textBudget),
        }
      : null,
    ...images.map(cloneBlock),
  ].filter(Boolean);
  if (briefKind === "event" || briefKind === "news") {
    const imageIndex = compactBlocks.findIndex((block) => block.type === "image");
    if (imageIndex > 0) {
      const [firstImage] = compactBlocks.splice(imageIndex, 1);
      compactBlocks.unshift(firstImage);
    }
  }
  return compactBlocks;
}

export function generateRichDraft(events, opts = {}) {
  const {
    templateId = "T3",
    style = "professional",
    maxLength = 1200,
    imagesPerArticle = -1,
    contentMode = "full",
  } = opts;
  const tmpl = TEMPLATES[templateId] || TEMPLATES.T3;
  const uniqueEvents = dedupeBriefEvents(events);
  if (!uniqueEvents.length)
    return {
      title: tmpl.title,
      lead: "",
      sections: [],
      sourceNotes: [],
      totalCharacters: 0,
      readingMinutes: 0,
    };
  const bucketFor = (event) => {
    const meta = event.facts?.briefMeta || {};
    const sourceId = event.sourceId || "";
    const sourceName = event.sourceName || "";
    if (meta.platformType === "mobile" || /TapTap|好游快爆/.test(sourceName) || sourceId === "ref-taptap" || sourceId === "ref-haoyou") return "手游";
    if (meta.platformType === "pc" || /Steam/.test(sourceName) || sourceId === "ref-steam") return "端游";
    if (/机核|游民星空/.test(sourceName) || sourceId === "ref-gcores" || sourceId === "ref-gamersky") return "资讯";
    if (sourceId === "ref-gcores" || sourceId === "ref-gamersky" || /行业资讯|官方资讯/.test(`${event.category || ""} ${event.title || ""}`)) return "资讯";
    return "资讯";
  };
  const today = new Date().toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
  });
  const lead = smartLead(uniqueEvents, today, style);
  const bucketWeight = {
    手游: 0,
    端游: 1,
    资讯: 2,
  };
  // 只按用户可理解的三类排序：手游 → 端游 → 资讯；分类字段也会随草稿保留给导出模板。
  const orderedEvents = [...uniqueEvents].sort((left, right) => {
    const leftMeta = left.facts?.briefMeta || {};
    const rightMeta = right.facts?.briefMeta || {};
    return (
      bucketWeight[bucketFor(left)] - bucketWeight[bucketFor(right)] ||
      Number(rightMeta.qualityScore || 0) -
        Number(leftMeta.qualityScore || 0) ||
      String(left.dateText || "").localeCompare(
        String(right.dateText || ""),
        "zh-CN",
      )
    );
  });
  // 全文模式不使用字数预算；保留该参数仅供摘要模式和偏好元数据使用。
  const perArticleBudget = contentMode === "full"
    ? Infinity
    : Math.max(
      80,
      Math.floor(Math.max(300, Number(maxLength) || 1200) / orderedEvents.length),
    );
  const sections = orderedEvents.map((e, i) => {
    const ps = cleanEventParagraphs(e);
    const normalizedEvent = { ...e, paragraphs: ps };
    const body = bodyByCategory(ps, e.category, e.title, e.gameName);
    const heading = cleanHeading(e.gameName, e.category, e.title, ps);
    const materialBlocks = contentBlocksFor(normalizedEvent, i, body);
    const briefKind = briefKindFor(normalizedEvent);
    const blocks = defaultBlocksFor(materialBlocks, {
      contentMode,
      imagesPerArticle,
      textBudget: perArticleBudget,
      briefKind,
    });

    const group = bucketFor(e);
    const fullBody = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.content || "")
      .join("\n");
    return {
      id: `s-${i}`,
      sourceArticleId: e.articleId || "",
      heading,
      gameName: normalizedGameName(e.gameName),
      eventTitle: stripRepeatedGameName(heading, e.gameName) || heading,
      dateText: e.dateText || "",
      briefKind,
      body: fullBody.replace(/\n/g, "<br/>"),
      blocks,
      materialBlocks,
      sourceName: e.sourceName || "",
      sourceId: e.sourceId || "",
      detailUrl: e.detailUrl || "",
      group,
    };
  });

  const sourceNotes = orderedEvents.map((e) => ({
    name: e.sourceName || "",
    url: e.detailUrl || "",
    title: e.title || "",
  }));

  const allText = sections
    .flatMap((section) =>
      section.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.content || ""),
    )
    .join(" ");
  const totalCharacters = allText.length;
  const readingMinutes = Math.max(1, Math.ceil(totalCharacters / 350));

  return {
    title: tmpl.title,
    lead,
    sections,
    sourceNotes,
    totalCharacters,
    readingMinutes,
    style,
    templateId,
    preferences: { contentMode, imagesPerArticle, maxLength },
  };
}

/** 生成可复制的简讯富文本 HTML */
export function generateBriefHtml(draft) {
  const isFullContent = draft?.preferences?.contentMode === "full";
  const date = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const lines = [
    `<section style="max-width:680px;margin:0 auto;font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.8;color:#333;">`,
    `  <h2 style="text-align:center;font-size:22px;font-weight:700;margin:20px 0 12px;color:#1a1a1a;">${draft.title || "今日游戏简讯"}</h2>`,
    `  <p style="text-align:center;color:#999;font-size:13px;margin-bottom:24px;">${date}</p>`,
  ];
  if (draft.lead) {
    lines.push(
      `  <blockquote style="background:#f7f8f5;padding:12px 16px;border-left:3px solid #2c5f4b;margin:0 0 20px;font-size:14px;color:#555;">${draft.lead}</blockquote>`,
    );
  }
  for (const section of draft.sections || []) {
    const kind = section.briefKind || "news";
    const imageBlocks = (section.blocks || []).filter(
      (block) => block.type === "image" && block.src,
    );
    const textBlocks = (section.blocks || []).filter(
      (block) => block.type === "text" && block.content,
    );
    const gameName = section.gameName || "游戏资讯";
    const eventTitle = section.eventTitle || section.heading || "最新动态";
    if (kind === "new-game") {
      const image = imageBlocks[0];
      lines.push(`  <div style="display:flex;align-items:center;gap:12px;margin:0 0 14px;padding:12px;border:1px solid #e8eee9;border-radius:8px;background:#fbfcfa;">`);
      if (image) lines.push(`    <img src="${image.src}" style="width:64px;height:64px;flex:0 0 64px;border-radius:12px;object-fit:cover;background:#edf1ed;" alt="" />`);
      lines.push(`    <div style="min-width:0;">`);
      lines.push(`      <strong style="display:block;color:#1f2e25;font-size:15px;line-height:1.45;">${gameName}</strong>`);
      lines.push(`      <span style="display:block;margin-top:4px;color:#748078;font-size:12px;">上线时间：${section.dateText || "待公布"}</span>`);
      lines.push(`    </div></div>`);
      // 摘要模式维持新游卡片；全文模式继续输出余下原始正文和插图。
      if (!isFullContent) continue;
      lines.push(
        `  <div style="margin:0 0 20px;padding:0 0 16px;border-bottom:1px dashed #e8e8e8;">`,
      );
    } else {
      lines.push(
        `  <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px dashed #e8e8e8;">`,
      );
      if (kind === "event") {
        lines.push(`    <p style="margin:0 0 3px;color:#6f7c73;font-size:12px;">${gameName}</p>`);
        lines.push(`    <h3 style="font-size:17px;font-weight:700;color:#244c3b;margin:0 0 10px;line-height:1.5;">${eventTitle}</h3>`);
      } else {
        lines.push(`    <h3 style="font-size:17px;font-weight:700;color:#244c3b;margin:0 0 10px;line-height:1.5;">${section.heading}</h3>`);
      }
    }
    const primaryImageId = imageBlocks[0]?.materialId || imageBlocks[0]?.id;
    const orderedBlocks = isFullContent
      ? (section.blocks || []).filter(
          (block) =>
            kind !== "new-game" ||
            block.type !== "image" ||
            (block.materialId || block.id) !== primaryImageId,
        )
      : kind === "news" || kind === "event"
        ? [...imageBlocks, ...textBlocks]
        : section.blocks || [];
    if (orderedBlocks.length) {
      for (const block of orderedBlocks) {
        if (block.type === "text") {
          lines.push(
            `    <p style="margin:0 0 6px;">${block.content.replace(/\n/g, "<br/>")}</p>`,
          );
        } else if (block.type === "image" && block.src) {
          lines.push(
            `    <figure style="margin:12px 0;text-align:center;"><img src="${block.src}" style="display:block;width:100%;max-width:680px;height:auto;margin:0 auto;border-radius:4px;" alt="" /></figure>`,
          );
        }
      }
    }
    lines.push(`  </div>`);
  }
  if (draft.sourceNotes?.length) {
    lines.push(
      `  <hr style="border:none;border-top:1px solid #eee;margin:20px 0 10px;" />`,
    );
    lines.push(
      `  <p style="font-size:11px;color:#999;margin-bottom:4px;">📋 资讯来源：</p>`,
    );
    for (const note of draft.sourceNotes.slice(0, 10)) {
      lines.push(
        `  <p style="font-size:10px;color:#999;margin:1px 0;"><a href="${note.url}" style="color:#2c5f4b;text-decoration:none;">${note.name}</a> ${(note.title || "").slice(0, 35)}</p>`,
      );
    }
  }
  lines.push(
    `  <p style="text-align:center;color:#ccc;font-size:11px;margin-top:24px;">— 由 GameNews Hub 自动生成 —</p>`,
  );
  lines.push(`</section>`);
  return lines.join("\n");
}
