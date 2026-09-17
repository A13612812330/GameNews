function escapeHtml(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

const TEMPLATE_STYLES = new Set(["professional", "minimal", "casual"]);

/**
 * 唯一的简讯排版源：右侧预览与独立 HTML 均使用这份样式，避免依赖页面 CSS 变量。
 */
export const BRIEF_TEMPLATE_CSS = `
body.gamenews-brief-document { margin: 0; background: #f4f5f1; color: #28342d; }
.gamenews-brief, .gamenews-brief * { box-sizing: border-box; }
.gamenews-brief { max-width: 680px; margin: 0 auto; padding: 32px 28px 40px; background: #fff; color: #28342d; font-family: "Noto Serif SC", "Songti SC", SimSun, serif; font-size: 16px; line-height: 1.9; word-break: break-word; }
.gamenews-brief .brief-masthead { margin: -32px -28px 26px; padding: 29px 28px 24px; background: #173e2c; color: #f7faf5; }
.gamenews-brief .brief-eyebrow { margin: 0 0 7px; color: #9fc9ae; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 11px; font-weight: 800; letter-spacing: .14em; }
.gamenews-brief .brief-masthead .brief-title { margin: 0; color: #fff; text-align: left; }
.gamenews-brief .brief-masthead .brief-lead { margin: 12px 0 0; padding: 0; border: 0; background: transparent; color: #d4e4d9; }
.gamenews-brief .brief-nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 22px; }
.gamenews-brief .brief-nav a { padding: 4px 10px; border: 1px solid #d7e4d9; border-radius: 999px; color: #326d50; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 12px; font-weight: 700; text-decoration: none; }
.gamenews-brief .brief-title { margin: 0 0 12px; color: #183d2b; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 28px; font-weight: 800; line-height: 1.35; letter-spacing: .02em; text-align: center; }
.gamenews-brief .brief-lead { margin: 0 0 24px; padding: 13px 15px; border-left: 4px solid #2c6b4f; background: #f1f6f2; color: #405147; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 14px; line-height: 1.8; }
.gamenews-brief .brief-card { padding: 0 0 24px; border-bottom: 1px solid #e4e9e5; }
.gamenews-brief .brief-card + .brief-card { margin-top: 24px; }
.gamenews-brief .brief-card > h2 { margin: 0 0 13px; color: #1f6245; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 19px; font-weight: 800; line-height: 1.5; }
.gamenews-brief .brief-card--foldable { padding-bottom: 0; }
.gamenews-brief .brief-card--foldable > summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 0 0 13px; color: #1f6245; cursor: pointer; list-style: none; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 19px; font-weight: 800; line-height: 1.5; }
.gamenews-brief .brief-card--foldable > summary::-webkit-details-marker { display: none; }
.gamenews-brief .brief-card--foldable > summary::after { content: "展开"; flex: 0 0 auto; color: #6b8375; font-size: 12px; font-weight: 700; }
.gamenews-brief .brief-card--foldable[open] > summary::after { content: "收起"; }
.gamenews-brief .brief-card-heading { min-width: 0; }
.gamenews-brief .brief-card-body { padding-bottom: 24px; }
.gamenews-brief .brief-card-meta { display: flex; flex-wrap: wrap; gap: 6px 8px; margin-top: 6px; color: #75857a; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 11px; font-weight: 700; }
.gamenews-brief .brief-card-meta span { white-space: nowrap; }
.gamenews-brief .brief-card-meta .brief-card-kind { padding: 1px 7px; border-radius: 999px; background: #eef6f0; color: #2c6b4f; }
.gamenews-brief .brief-group { margin-top: 30px; }
.gamenews-brief .brief-group:first-of-type { margin-top: 0; }
.gamenews-brief .brief-group-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 0 14px; padding: 8px 12px; border-left: 4px solid #2c6b4f; background: #f1f6f2; color: #183d2b; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 18px; font-weight: 800; line-height: 1.4; }
.gamenews-brief .brief-group-title small { color: #6a8273; font-size: 11px; font-weight: 700; }
.gamenews-brief p { margin: 0 0 15px; white-space: pre-wrap; }
.gamenews-brief .brief-text--section { margin: 21px 0 10px; color: #193e2c; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 18px; font-weight: 800; line-height: 1.55; }
.gamenews-brief .brief-text--subheading { margin: 17px 0 8px; color: #2c4e3c; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 16px; font-weight: 800; line-height: 1.6; }
.gamenews-brief .brief-text--quote { margin: 17px 0; padding: 11px 14px; border-left: 3px solid #87a995; background: #f7f8f5; color: #516157; font-style: italic; }
.gamenews-brief figure { margin: 18px 0; text-align: center; }
.gamenews-brief figure img { display: block; width: 100%; max-width: 100%; height: auto; margin: 0 auto; border-radius: 6px; object-fit: contain; background: #f5f6f4; }
.gamenews-brief figcaption { margin-top: 7px; color: #78837c; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 12px; line-height: 1.5; }
.gamenews-brief--minimal { font-size: 15px; line-height: 1.8; }
.gamenews-brief--minimal .brief-title { font-size: 25px; }
.gamenews-brief--casual { font-family: "Microsoft YaHei", Arial, sans-serif; }
.gamenews-brief--casual .brief-card > h2 { color: #b75b28; }
@media (max-width: 520px) { .gamenews-brief { padding: 24px 18px 32px; font-size: 15px; line-height: 1.85; } .gamenews-brief .brief-title { font-size: 24px; } .gamenews-brief .brief-card > h2 { font-size: 18px; } .gamenews-brief .brief-lead { font-size: 13px; } }
`;

function imageSource(src, assetBase = "") {
  const value = String(src || "");
  return assetBase && value.startsWith("/")
    ? `${assetBase.replace(/\/$/, "")}${value}`
    : value;
}

function sectionGroup(section = {}) {
  const group = String(section.group || "").trim();
  const source = String(section.sourceName || section.source || "");
  if (/TapTap|好游快爆/.test(source)) return "手游";
  if (/Steam|机核|游民星空/.test(source)) return /机核|游民星空/.test(source) ? "资讯" : "端游";
  if (/^手游/.test(group)) return "手游";
  if (/^(?:端游|Steam)/.test(group)) return "端游";
  if (/^资讯/.test(group)) return "资讯";
  return "资讯";
}

const GROUP_ORDER = { 手游: 0, 端游: 1, 资讯: 2 };

function sectionKind(section = {}) {
  if (section.briefKind === "news") return "资讯";
  if (section.briefKind === "new-game") return "新游";
  return /联动/.test(section.heading || "") ? "联动" : /活动/.test(section.heading || "") ? "活动" : "更新";
}

function renderBlocks(section, assetBase) {
  const blocks = section.blocks?.length
    ? section.blocks
    : [{ type: "text", content: section.bodyHtml || section.body || "", format: "body" }];
  return blocks.map((block) => block.type === "image"
    ? `<figure><img src="${escapeHtml(imageSource(block.src, assetBase))}" alt="${escapeHtml(block.alt || "")}" />${block.alt ? `<figcaption>${escapeHtml(block.alt)}</figcaption>` : ""}</figure>`
    : `<p class="brief-text--${escapeHtml(block.format || "body")}">${escapeHtml(block.content || "").replace(/\n/g, "<br/>")}</p>`).join("");
}

function renderCard(section, { assetBase, collapsible }) {
  const heading = section.heading ? escapeHtml(section.heading) : "未命名资讯";
  const meta = `<span class="brief-card-kind">${escapeHtml(sectionKind(section))}</span>${section.dateText ? `<span>${escapeHtml(section.dateText)}</span>` : ""}${section.sourceName ? `<span>${escapeHtml(section.sourceName)}</span>` : ""}`;
  const body = renderBlocks(section, assetBase);
  if (collapsible) return `<details class="brief-card brief-card--foldable"><summary><span class="brief-card-heading">${heading}<span class="brief-card-meta">${meta}</span></span></summary><div class="brief-card-body">${body}</div></details>`;
  return `<section class="brief-card"><h2>${heading}</h2><div class="brief-card-meta">${meta}</div>${body}</section>`;
}

export function buildInlineHtml(draft, { assetBase = "", collapsible = false } = {}) {
  if (!draft) return "";
  const style = TEMPLATE_STYLES.has(draft.style) ? draft.style : "professional";
  const title = draft.title ? `<h1 class="brief-title">${escapeHtml(draft.title)}</h1>` : "";
  const lead = draft.lead ? `<p class="brief-lead">${escapeHtml(draft.lead).replace(/\n/g, "<br/>")}</p>` : "";
  const orderedSections = [...(draft.sections || [])].sort((left, right) =>
    GROUP_ORDER[sectionGroup(left)] - GROUP_ORDER[sectionGroup(right)]
  );
  if (!orderedSections.length) return `<article class="gamenews-brief gamenews-brief--${style}">${title}${lead}</article>`;
  const grouped = ["手游", "端游", "资讯"].map((group) => {
    const rows = orderedSections.filter((section) => sectionGroup(section) === group);
    if (!rows.length) return "";
    return `<section class="brief-group" id="brief-group-${group}"><h2 class="brief-group-title"><span>${group}</span><small>${rows.length} 条</small></h2>${rows.map((section) => renderCard(section, { assetBase, collapsible })).join("")}</section>`;
  }).join("");
  const nav = `<nav class="brief-nav">${["手游", "端游", "资讯"].filter((group) => orderedSections.some((section) => sectionGroup(section) === group)).map((group) => `<a href="#brief-group-${group}">${group}</a>`).join("")}</nav>`;
  const masthead = collapsible ? `<header class="brief-masthead"><p class="brief-eyebrow">GAME NEWS DAILY · ${orderedSections.length} 条</p>${title}${lead}</header>` : `${title}${lead}`;
  return `<article class="gamenews-brief gamenews-brief--${style}">${masthead}${collapsible ? nav : ""}${grouped}</article>`;
}

export function buildStandaloneHtml(draft, { assetBase = "" } = {}) {
  const title = escapeHtml(draft?.title || "简讯");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${BRIEF_TEMPLATE_CSS}</style></head><body class="gamenews-brief-document">${buildInlineHtml(draft, { assetBase, collapsible: true })}</body></html>`;
}

// 编辑器草稿还包含素材池、历史来源等交互状态；导出 HTML 只需要正文结构。
// 先压缩请求体，避免“全文 + 大量素材”把本地 API 请求推到上限附近。
export function briefHtmlExportPayload(draft) {
  return {
    title: draft?.title || "今日简讯",
    lead: draft?.lead || "",
    style: draft?.style || "professional",
    sections: (draft?.sections || []).map((section) => ({
      heading: section.heading || "",
      group: section.group || "",
      sourceName: section.sourceName || "",
      sourceId: section.sourceId || "",
      dateText: section.dateText || "",
      briefKind: section.briefKind || "",
      blocks: (section.blocks || []).map((block) =>
        block.type === "image"
          ? {
              type: "image",
              src: block.src || block.localUrl || block.url || block.originalUrl || "",
              alt: block.alt || "",
            }
          : {
              type: "text",
              content: block.content || "",
              format: block.format || "body",
            },
      ),
    })),
  };
}

export function buildMarkdown(draft) {
  if (!draft) return "";
  const parts = [
    draft.title ? `# ${draft.title}\n` : "",
    draft.lead ? `> ${draft.lead}\n` : "",
  ];
  for (const section of draft.sections || []) {
    if (section.heading) parts.push(`## ${section.heading}\n`);
    const blocks = section.blocks?.length
      ? section.blocks
      : [{ type: "text", content: section.body || "" }];
    parts.push(
      `${blocks
        .map((block) =>
          block.type === "image"
            ? `![${block.alt || "图片"}](${block.src})`
            : block.content || "",
        )
        .join("\n\n")}\n`,
    );
  }
  return parts.filter(Boolean).join("\n");
}

function fileDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function downloadRemoteFile(url, fileName = "") {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => a.remove(), 0);
}

export function downloadHtml(draft) {
  const html = buildStandaloneHtml(draft, {
    assetBase: window.location.origin,
  });
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const values = fileDateParts();
  const fileName = `今日简讯-${values.year}-${values.month}-${values.day}.html`;
  downloadRemoteFile(url, fileName);
  // 立即 revoke 会导致某些 Chromium 内核下载到空文件；延迟释放。
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { fileName };
}

export async function writeRichHtmlToClipboard(html, plainFallback) {
  try {
    const blob = new Blob([html], { type: "text/html" });
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": blob,
        "text/plain": new Blob([plainFallback || ""], { type: "text/plain" }),
      }),
    ]);
    return "rich";
  } catch {
    await navigator.clipboard.writeText(plainFallback || "");
    return "text";
  }
}
