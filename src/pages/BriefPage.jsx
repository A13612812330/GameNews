import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Clipboard,
  ChevronDown,
  Code,
  Download,
  FileText,
  GripVertical,
  ImagePlus,
  LoaderCircle,
  Plus,
  Save,
  Settings,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { PageHeader, Toast } from "../components/ui.jsx";
import { articleStore } from "../services/articleStore.js";
import { getBriefPreferences, saveBriefPreferences } from "../services/briefPreferences.js";
import { api } from "../services/api.js";
import { BRIEF_STYLES, BRIEF_LENGTHS } from "../utils/constants.js";
import { insertMaterialAtSourceOrder } from "../utils/materialOrder.js";
import {
  BRIEF_TEMPLATE_CSS,
  briefHtmlExportPayload,
  buildInlineHtml,
  buildMarkdown,
  buildStandaloneHtml,
  downloadHtml,
  downloadRemoteFile,
  writeRichHtmlToClipboard,
} from "../utils/export.js";
import "../brief-page.css";

const FORMAT_OPTIONS = [
  { value: "body", label: "正文" },
  { value: "section", label: "章节" },
  { value: "subheading", label: "小标题" },
  { value: "quote", label: "引用" },
];

function uid() {
  return `blk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// 历史草稿保存的是当时的成品，不直接回写数据库；这里仅在加载时按当前展示规则清理。
function cleanLegacyGameName(value = "") {
  return String(value)
    .replace(/[（(]官服[）)]/g, "")
    .replace(/[-—–]\s*(?:预下载|预购|首发|新品|S\d+赛季|\d+月\d+日开放预购).*$/iu, "")
    .trim();
}

function cleanLegacyText(value = "") {
  return String(value)
    .replace(/^\s*标签[：:][^\n]*(?:\n|$)/gmu, "")
    .replace(/^\s*(?:下载|预约)\s*$/gmu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLegacyHeading(value = "") {
  return cleanLegacyText(value).replace(/《([^》]+)》/g, (_all, name) => `《${cleanLegacyGameName(name)}》`);
}

function normalizeBlock(block = {}, index = 0) {
  if (block.type === "image") {
    const rawAlt = String(block.alt || "").trim();
    const alt = /^(?:游戏封面|资讯图片)$/.test(rawAlt) ? "" : rawAlt;
    return {
      ...block,
      id: block.id || `image-${index}`,
      materialId: block.materialId || block.id || `image-${index}`,
      src: block.src || block.localUrl || block.url || block.originalUrl || "",
      alt,
    };
  }
  return {
    ...block,
    id: block.id || `text-${index}`,
    materialId: block.materialId || block.id || `text-${index}`,
    type: "text",
    content: cleanLegacyText(String(block.content || "").replace(/<br\s*\/?>/gi, "\n")),
    format: block.format || "body",
  };
}
function normalizeSection(section, index) {
  const legacyImages = [
    ...(section.imagesBefore || []),
    ...(section.imagesAfter || []),
  ];
  const blocks = section.blocks?.length
    ? section.blocks
    : [
        {
          id: `${section.id || `s-${index}`}-text`,
          type: "text",
          content: section.body || "",
        },
        ...legacyImages,
      ];
  const heading = cleanLegacyHeading(String(section.heading || "").replace(
    /^【(?:今日重点|手游动态|端游动态|Steam 榜单变化|观察项)】/,
    "",
  ));
  return {
    ...section,
    id: section.id || `s-${index}`,
    heading,
    blocks: blocks.map(normalizeBlock),
    materialBlocks: (section.materialBlocks || blocks).map(normalizeBlock),
  };
}
function withStats(draft) {
  const sections = draft.sections || [];
  const totalCharacters = sections
    .flatMap((section) => section.blocks || [])
    .filter((block) => block.type === "text")
    .map((block) => block.content || "")
    .join("").length;
  return {
    ...draft,
    totalCharacters,
    readingMinutes: Math.max(1, Math.ceil(totalCharacters / 350)),
  };
}
function normalizeDraft(draft) {
  return draft
    ? withStats({
        ...draft,
        sections: (draft.sections || []).map(normalizeSection),
      })
    : null;
}
function persistDraft(draft) {
  return withStats({
    ...draft,
    sections: (draft.sections || []).map((section) => ({
      ...section,
      body: section.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.content || "")
        .join("\n"),
      blocks: section.blocks,
    })),
  });
}

export default function BriefPage() {
  const [selectedIds, setSelectedIds] = useState(() =>
    articleStore.getSelected(),
  );
  const [draft, setDraft] = useState(null);
  const [collapsedSectionIds, setCollapsedSectionIds] = useState(() => new Set());
  const [briefs, setBriefs] = useState([]);
  const [trashedBriefs, setTrashedBriefs] = useState([]);
  const [showTrash, setShowTrash] = useState(false);
  const [archiveDates, setArchiveDates] = useState([]);
  const [archiveItems, setArchiveItems] = useState([]);
  const [trashedArchiveItems, setTrashedArchiveItems] = useState([]);
  const [showArchiveTrash, setShowArchiveTrash] = useState(false);
  const [archiveDate, setArchiveDate] = useState("");
  const [posterRecords, setPosterRecords] = useState([]);
  const [trashedPosterRecords, setTrashedPosterRecords] = useState([]);
  const [showPosterTrash, setShowPosterTrash] = useState(false);
  const [activePoster, setActivePoster] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [style, setStyle] = useState(() => getBriefPreferences().style);
  const [maxLen, setMaxLen] = useState(() => getBriefPreferences().maxLen);
  const [contentMode, setContentMode] = useState(() => getBriefPreferences().contentMode);
  const [imagesPerArticle, setImagesPerArticle] = useState(() => getBriefPreferences().imagesPerArticle);
  const [dragState, setDragState] = useState(null);
  const [toast, setToast] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [exportedHtml, setExportedHtml] = useState(null);

  useEffect(() => articleStore.subscribe(setSelectedIds), []);
  useEffect(() => {
    saveBriefPreferences({ style, maxLen, contentMode, imagesPerArticle });
  }, [style, maxLen, contentMode, imagesPerArticle]);
  useEffect(() => {
    const receiveGeneratedDraft = (event) => {
      const nextDraft = normalizeDraft(event.detail);
      if (!nextDraft) return;
      setDraft(nextDraft);
      setCollapsedSectionIds(new Set(nextDraft.sections.map((section) => section.id)));
      setDirty(false);
    };
    try {
      const stored = sessionStorage.getItem("gamenews:generated-brief");
      if (stored) {
        sessionStorage.removeItem("gamenews:generated-brief");
        receiveGeneratedDraft({ detail: JSON.parse(stored) });
      }
    } catch {
      sessionStorage.removeItem("gamenews:generated-brief");
    }
    window.addEventListener("gamenews:brief-generated", receiveGeneratedDraft);
    return () => window.removeEventListener("gamenews:brief-generated", receiveGeneratedDraft);
  }, []);
  const flash = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2400);
  };
  const mutateDraft = (updater) => {
    setDirty(true);
    setDraft((current) => (current ? withStats(updater(current)) : current));
  };
  const loadHistory = async () => {
    try {
      const [result, trash, archive, archiveTrash, posters, posterTrash] = await Promise.all([
        api.listBriefs(),
        api.listBriefs({ scope: "trash" }),
        api.listBriefArchive("daily"),
        api.listBriefArchive("daily", { scope: "trash" }),
        api.listDailyPosters(),
        api.listDailyPosters({ scope: "trash" }),
      ]);
      setBriefs(result.briefs || []);
      setTrashedBriefs(trash.briefs || []);
      setArchiveDates(archive.dates || []);
      setArchiveItems(archive.archives || []);
      setTrashedArchiveItems(archiveTrash.archives || []);
      setPosterRecords(posters.posters || []);
      setTrashedPosterRecords(posterTrash.posters || []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  };
  useEffect(() => {
    loadHistory();
  }, []);
  // 编辑中的内容以草稿状态防抖保存，刷新或切页后仍可从历史简讯恢复。
  useEffect(() => {
    if (!draft?.id || !dirty) return undefined;
    const timer = window.setTimeout(async () => {
      try {
        await api.saveBrief({ ...persistDraft(draft), status: "draft" });
        setDirty(false);
        await loadHistory();
      } catch {
        // 保留当前编辑器内容；网络恢复后用户可继续手动保存。
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, dirty]);

  const generate = async () => {
    if (!selectedIds.length)
      return flash("请先在抓取资讯勾选需要加入简讯的资讯");
    setBusy(true);
    try {
      const result = await api.generateBrief({
        articleIds: selectedIds,
        style,
        maxLength: maxLen,
        contentMode,
        imagesPerArticle,
      });
      const nextDraft = normalizeDraft(result.brief);
      setDraft(nextDraft);
      setCollapsedSectionIds(new Set(nextDraft.sections.map((section) => section.id)));
      setDirty(false);
      await loadHistory();
      flash("已按当前偏好生成：全文与图片已按原始顺序入稿");
    } catch (error) {
      flash("生成失败：" + error.message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const result = await api.saveBrief({ ...persistDraft(draft), status: "saved" });
      setDraft(normalizeDraft(result.brief || draft));
      setDirty(false);
      await loadHistory();
      flash("简讯已保存");
    } catch (error) {
      flash("保存失败：" + error.message);
    } finally {
      setBusy(false);
    }
  };
  const loadArchivedBrief = async (date) => {
    setArchiveDate(date);
    if (!date) return;
    try {
      const result = await api.getBriefArchive("daily", date);
      if (!result.brief) return flash(`${date} 暂无可编辑内容`);
      const nextDraft = normalizeDraft({
        ...result.brief,
        id: `archive-daily-${date}`,
        slot: "daily",
      });
      setDraft(nextDraft);
      setCollapsedSectionIds(new Set(nextDraft.sections.map((section) => section.id)));
      setDirty(false);
    } catch (error) {
      flash("历史简讯加载失败：" + error.message);
    }
  };
  const moveArchiveToTrash = async (date) => {
    if (!date || !window.confirm(`将 ${date} 的简讯留档移入回收站？`)) return;
    try {
      await api.trashBriefArchive("daily", date);
      setArchiveDate("");
      await loadHistory();
      flash("日期留档已移入回收站");
    } catch (error) {
      flash("移入回收站失败：" + error.message);
    }
  };
  const restoreArchive = async (date) => {
    try {
      await api.restoreBriefArchive("daily", date);
      setArchiveDate("");
      await loadHistory();
      flash("日期留档已恢复");
    } catch (error) {
      flash("恢复失败：" + error.message);
    }
  };
  const deleteArchivePermanently = async (date) => {
    if (!date || !window.confirm(`永久删除 ${date} 的简讯留档？此操作无法恢复。`)) return;
    try {
      await api.deleteBriefArchive("daily", date);
      setArchiveDate("");
      await loadHistory();
      flash("日期留档已永久删除");
    } catch (error) {
      flash("永久删除失败：" + error.message);
    }
  };
  const movePosterToTrash = async (poster) => {
    if (!window.confirm(`将「${poster.fileName}」移入海报回收站？`)) return;
    try {
      await api.trashDailyPoster(poster.fileName);
      if (activePoster?.fileName === poster.fileName) setActivePoster(null);
      await loadHistory();
      flash("海报已移入回收站");
    } catch (error) {
      flash("移入回收站失败：" + error.message);
    }
  };
  const restorePoster = async (poster) => {
    try {
      await api.restoreDailyPoster(poster.fileName);
      await loadHistory();
      flash("海报已恢复到记录列表");
    } catch (error) {
      flash("恢复失败：" + error.message);
    }
  };
  const deletePosterPermanently = async (poster) => {
    if (!window.confirm(`永久删除「${poster.fileName}」？此操作无法恢复。`)) return;
    try {
      await api.deleteDailyPoster(poster.fileName);
      if (activePoster?.fileName === poster.fileName) setActivePoster(null);
      await loadHistory();
      flash("海报已永久删除");
    } catch (error) {
      flash("永久删除失败：" + error.message);
    }
  };
  const updateDraft = (patch) =>
    mutateDraft((current) => ({ ...current, ...patch }));
  const updateSection = (sectionId, patch) =>
    mutateDraft((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.id === sectionId ? { ...section, ...patch } : section,
      ),
    }));
  const updateBlock = (sectionId, blockId, patch) =>
    updateSection(sectionId, {
      blocks: draft.sections
        .find((section) => section.id === sectionId)
        .blocks.map((block) =>
          block.id === blockId ? { ...block, ...patch } : block,
        ),
    });
  const removeBlock = (sectionId, blockId) =>
    updateSection(sectionId, {
      blocks: draft.sections
        .find((section) => section.id === sectionId)
        .blocks.filter((block) => block.id !== blockId),
    });
  const insertText = (sectionId) =>
    updateSection(sectionId, {
      blocks: [
        ...draft.sections.find((section) => section.id === sectionId).blocks,
        { id: uid(), type: "text", content: "", format: "body" },
      ],
    });
  const insertImage = (sectionId) => {
    const src = window.prompt("请输入图片 URL：");
    if (src?.trim())
      updateSection(sectionId, {
        blocks: [
          ...draft.sections.find((section) => section.id === sectionId).blocks,
          { id: uid(), type: "image", src: src.trim(), alt: "" },
        ],
      });
  };
  const moveSection = (from, to) =>
    mutateDraft((current) => {
      if (to < 0 || to >= current.sections.length) return current;
      const sections = [...current.sections];
      const [section] = sections.splice(from, 1);
      sections.splice(to, 0, section);
      return { ...current, sections };
    });
  const moveBlock = (fromSectionId, fromIndex, toSectionId, toIndex) =>
    mutateDraft((current) => {
      const sections = current.sections.map((section) => ({
        ...section,
        blocks: [...section.blocks],
      }));
      const fromSection = sections.find(
        (section) => section.id === fromSectionId,
      );
      const toSection = sections.find((section) => section.id === toSectionId);
      if (!fromSection || !toSection || fromIndex < 0) return current;
      const [block] = fromSection.blocks.splice(fromIndex, 1);
      toSection.blocks.splice(toIndex, 0, block);
      return { ...current, sections };
    });
  const onDrop = (sectionId, targetIndex) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    const type = event.dataTransfer.getData("text/type");
    const sourceId = event.dataTransfer.getData("text/id");
    if (type === "section")
      moveSection(
        draft.sections.findIndex((section) => section.id === sourceId),
        targetIndex,
      );
    if (type === "block") {
      const fromSectionId = event.dataTransfer.getData("text/section");
      const from =
        draft.sections
          .find((section) => section.id === fromSectionId)
          ?.blocks.findIndex((block) => block.id === sourceId) ?? -1;
      moveBlock(fromSectionId, from, sectionId, targetIndex);
    }
    setDragState(null);
  };
  const addMaterial = (sectionId, mode) => {
    const section = draft?.sections.find((item) => item.id === sectionId);
    if (!section) return;
    const existing = new Set(
      section.blocks.map((block) => block.materialId || block.id),
    );
    const candidates = section.materialBlocks.filter(
      (block) =>
        !existing.has(block.materialId || block.id) &&
        (mode === "all" || block.type === mode),
    );
    if (!candidates.length)
      return flash(mode === "image" ? "没有未使用图片" : "没有未使用正文");
    updateSection(sectionId, {
      blocks: insertMaterialAtSourceOrder(
        section.blocks,
        section.materialBlocks,
        candidates,
        uid,
      ),
    });
  };
  const html = useMemo(
    () => buildInlineHtml(draft ? persistDraft(draft) : null),
    [draft],
  );
  const clipboardHtml = useMemo(
    () =>
      buildStandaloneHtml(draft ? persistDraft(draft) : null, {
        assetBase: window.location.origin,
      }),
    [draft],
  );
  const markdown = draft ? buildMarkdown(persistDraft(draft)) : "";

  return (
    <div className="brief-workspace">
      <PageHeader
        eyebrow="今日简讯"
        title="简讯编辑"
        description="默认保留全文与全部图片，并使用固定简讯图文排版；素材补充会回到原始图文位置。"
      />
      <div className="brief-toolbar">
        <button
          className="btn btn-primary"
          onClick={generate}
          disabled={busy || !selectedIds.length}
        >
          {busy ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <Plus size={14} />
          )}
          {busy
            ? "处理中…"
            : `生成简讯${selectedIds.length ? `（${selectedIds.length}）` : ""}`}
        </button>
        <button className="btn" onClick={() => setShowPrefs(!showPrefs)}>
          <Settings size={14} />
          偏好设置
        </button>
        <button
          className="btn btn-secondary"
          onClick={save}
          disabled={!draft || busy}
        >
          <Save size={14} />
          保存修改
        </button>
        <span className="brief-toolbar-spacer" />
        {draft && (
          <>
            <button
              className="btn btn-secondary"
              onClick={async () =>
                flash(
                  (await writeRichHtmlToClipboard(
                    clipboardHtml,
                    draft.lead || "",
                  )) === "rich"
                    ? "富文本已复制"
                    : "纯文本已复制",
                )
              }
            >
              <Clipboard size={14} />
              复制富文本
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                navigator.clipboard?.writeText(markdown);
                flash("Markdown 已复制");
              }}
            >
              <Code size={14} />
              复制 MD
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                try {
                  const result = await api.saveBrief({
                    ...persistDraft(draft),
                    status: "exported",
                  });
                  const exportedDraft = normalizeDraft(result.brief || draft);
                  setDraft(exportedDraft);
                  setDirty(false);
                  const output = await api.exportBriefHtml(briefHtmlExportPayload(exportedDraft));
                  downloadRemoteFile(output.downloadUrl, output.fileName);
                  setExportedHtml(output);
                  await loadHistory();
                  flash(`HTML 已导出：${output.fileName}`);
                } catch (error) {
                  flash("导出失败：" + error.message);
                }
              }}
            >
              <Download size={14} />
              导出 HTML
            </button>
            {exportedHtml?.url ? (
              <a
                className="btn btn-ghost"
                href={`http://127.0.0.1:64424${exportedHtml.url}`}
                target="_blank"
                rel="noreferrer"
              >
                打开导出文件
              </a>
            ) : null}
          </>
        )}
      </div>
      {showPrefs && (
        <section className="brief-preferences">
          <div className="prefs-col">
            <span className="prefs-label">文风模板</span>
            {BRIEF_STYLES.map((item) => (
              <button
                key={item.value}
                className={`pref-btn ${style === item.value ? "is-active" : ""}`}
                onClick={() => setStyle(item.value)}
              >
                <span>{item.label}</span>
                <small>{item.desc}</small>
              </button>
            ))}
          </div>
          <div className="prefs-col">
            <span className="prefs-label">初始内容</span>
            <div className="segmented">
              <button
                className={contentMode === "summary" ? "is-active" : ""}
                onClick={() => setContentMode("summary")}
              >
                摘要
              </button>
              <button
                className={contentMode === "full" ? "is-active" : ""}
                onClick={() => setContentMode("full")}
              >
                全文
              </button>
            </div>
            <small className="pref-note">
              默认全文：按原始图文顺序完整入稿；摘要模式仅保留首段。
            </small>
            <label className="pref-field">
              每篇图片{" "}
              <select
                value={imagesPerArticle}
                onChange={(event) =>
                  setImagesPerArticle(Number(event.target.value))
                }
              >
                {[-1, 0, 1, 2, 3, 4, 5, 6].map((value) => (
                  <option key={value} value={value}>
                    {value < 0 ? "全部" : `${value} 张`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="prefs-col">
            <span className="prefs-label">总字数上限</span>
            {BRIEF_LENGTHS.map((item) => (
              <button
                key={item.value}
                className={`pref-btn ${maxLen === item.value ? "is-active" : ""}`}
                onClick={() => setMaxLen(item.value)}
              >
                <span>{item.label}</span>
              </button>
            ))}
            <small className="pref-note">仅摘要模式按每篇配额裁剪；全文不受此限制。</small>
          </div>
        </section>
      )}
      <div className="brief-layout">
        <aside className="brief-side-panel">
          <section className="side-section">
            <div className="side-title">
              <span>{showTrash ? "回收站" : "历史简讯"}</span>
              <small>{showTrash ? trashedBriefs.length : briefs.length + archiveDates.length}</small>
            </div>
            <button
              className="btn btn-ghost"
              style={{ width: "100%", marginBottom: 8, fontSize: 12 }}
              onClick={() => setShowTrash((value) => !value)}
            >
              <Trash2 size={13} /> {showTrash ? "返回历史简讯" : `回收站${trashedBriefs.length ? ` (${trashedBriefs.length})` : ""}`}
            </button>
            {!showTrash && <div className="history-archive-picker">
              <div className="history-archive-title-row">
                <label htmlFor="daily-brief-archive">{showArchiveTrash ? "留档回收站" : "按日期留档"}</label>
                <button
                  className="history-archive-trash-toggle"
                  type="button"
                  onClick={() => { setShowArchiveTrash((value) => !value); setArchiveDate(""); }}
                >
                  <Trash2 size={12} /> {showArchiveTrash ? "返回留档" : `留档回收站${trashedArchiveItems.length ? ` (${trashedArchiveItems.length})` : ""}`}
                </button>
              </div>
              <select
                id="daily-brief-archive"
                value={archiveDate}
                onChange={(event) => {
                  const date = event.target.value;
                  setArchiveDate(date);
                  if (!showArchiveTrash) loadArchivedBrief(date);
                }}
              >
                <option value="">{showArchiveTrash ? "选择回收站留档" : "选择留档日期"}</option>
                {(showArchiveTrash
                  ? trashedArchiveItems
                  : (archiveItems.length ? archiveItems : archiveDates.map((date) => ({ date })))
                ).map((item) => (
                  <option key={item.date} value={item.date}>
                    {item.date}
                    {item.title
                      ? ` · ${item.title}${item.totalCharacters ? ` · ${item.totalCharacters}字` : ""}`
                      : ""}
                  </option>
                ))}
              </select>
              {archiveDate && <div className="history-archive-actions">
                {showArchiveTrash ? <>
                  <button type="button" className="history-archive-action is-restore" onClick={() => restoreArchive(archiveDate)}><RotateCcw size={12} />恢复</button>
                  <button type="button" className="history-archive-action is-delete" onClick={() => deleteArchivePermanently(archiveDate)}><Trash2 size={12} />永久删除</button>
                </> : <button type="button" className="history-archive-action is-delete" onClick={() => moveArchiveToTrash(archiveDate)}><Trash2 size={12} />移入回收站</button>}
              </div>}
            </div>}
            {loadError ? (
              <div className="history-error">
                加载失败{" "}
                <button className="btn" onClick={loadHistory}>
                  重试
                </button>
              </div>
            ) : (
              (showTrash ? trashedBriefs : briefs).slice(0, 12).map((item) => (
                <div
                  key={item.id}
                  className={`history-item ${draft?.id === item.id ? "is-active" : ""}`}
                >
                  <button
                    className="history-main"
                    onClick={() => {
                      const nextDraft = normalizeDraft(item);
                      setDraft(nextDraft);
                      setCollapsedSectionIds(new Set(nextDraft.sections.map((section) => section.id)));
                      setDirty(false);
                    }}
                  >
                    <b>{item.title || "今日简讯"}</b>
                    <span>
                      {item.created_at
                        ? new Date(item.created_at).toLocaleDateString("zh-CN")
                        : "未命名"}{" "}
                      · {item.total_characters || 0} 字 · {item.status === "exported" ? "已导出" : item.status === "saved" ? "已保存" : item.status === "trash" ? "已删除" : "草稿未导出"}
                    </span>
                  </button>
                  {showTrash ? <div className="history-record-actions">
                    <button
                      className="history-delete is-restore"
                      onClick={async () => {
                        try {
                          await api.restoreBrief(item.id);
                          await loadHistory();
                          flash("简讯已恢复到草稿");
                        } catch (error) {
                          flash("恢复失败：" + error.message);
                        }
                      }}
                      aria-label="恢复简讯"
                      title="恢复为草稿"
                    >
                      <RotateCcw size={13} />
                    </button>
                    <button
                      className="history-delete is-delete"
                      onClick={() => setConfirmDelete(item.id)}
                      aria-label="永久删除简讯"
                      title="永久删除"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div> : <button
                    className="history-delete"
                    onClick={async () => {
                      try {
                        await api.trashBrief(item.id);
                        if (draft?.id === item.id) {
                          setDraft(null);
                          setDirty(false);
                        }
                        await loadHistory();
                        flash("已移入回收站");
                      } catch (error) {
                        flash("移入回收站失败：" + error.message);
                      }
                    }}
                    aria-label="移入回收站"
                    title="移入回收站"
                  >
                    <Trash2 size={13} />
                  </button>}
                </div>
              ))
            )}
          </section>
          <section className="side-section poster-records">
            <div className="side-title">
              <span>{showPosterTrash ? "海报回收站" : "海报记录"}</span>
              <small>{showPosterTrash ? trashedPosterRecords.length : posterRecords.length}</small>
            </div>
            <button
              className="btn btn-ghost"
              style={{ width: "100%", marginBottom: 8, fontSize: 12 }}
              onClick={() => setShowPosterTrash((value) => !value)}
            >
              <Trash2 size={13} /> {showPosterTrash ? "返回海报记录" : `海报回收站${trashedPosterRecords.length ? ` (${trashedPosterRecords.length})` : ""}`}
            </button>
            {(showPosterTrash ? trashedPosterRecords : posterRecords).length ? (showPosterTrash ? trashedPosterRecords : posterRecords).map((poster) => (
              <div key={`${poster.scope || "active"}-${poster.fileName}`} className="poster-record-row">
                <button className="poster-record" onClick={() => setActivePoster(poster)}>
                  <FileText size={13} />
                  <span><b>{poster.date}</b><small>{showPosterTrash ? "已移入回收站" : "只读海报"} · {Math.max(1, Math.round(poster.bytes / 1024))} KB</small></span>
                </button>
                {showPosterTrash ? <div className="poster-record-actions"><button className="poster-record-action is-restore" title="恢复海报" onClick={() => restorePoster(poster)}><RotateCcw size={13} /></button><button className="poster-record-action is-delete" title="永久删除海报" onClick={() => deletePosterPermanently(poster)}><Trash2 size={13} /></button></div> : <button className="poster-record-action is-delete" title="移入海报回收站" onClick={() => movePosterToTrash(poster)}><Trash2 size={13} /></button>}
              </div>
            )) : <p className="side-empty">{showPosterTrash ? "回收站为空。" : "生成海报后，会在这里按日期留档，可直接查看或下载。"}</p>}
          </section>
          <section className="side-section material-pool">
            <div className="side-title">
              <span>素材池</span>
              <small>{draft ? draft.sections.length : 0}</small>
            </div>
            {!draft ? (
              <p className="side-empty">
                生成简讯后，这里会保留每篇未入稿的原始正文与图片。
              </p>
            ) : (
              draft.sections.map((section) => {
                const used = new Set(
                  section.blocks.map((block) => block.materialId || block.id),
                );
                const remainText = section.materialBlocks.filter(
                  (block) =>
                    block.type === "text" &&
                    !used.has(block.materialId || block.id),
                ).length;
                const remainImage = section.materialBlocks.filter(
                  (block) =>
                    block.type === "image" &&
                    !used.has(block.materialId || block.id),
                ).length;
                return (
                  <article key={section.id} className="material-card">
                    <strong>
                      {section.heading.replace(/^【[^】]+】/, "")}
                    </strong>
                    <small>
                      {remainText} 段正文 · {remainImage} 张图片待用
                    </small>
                    <div>
                      <button
                        onClick={() => addMaterial(section.id, "text")}
                        disabled={!remainText}
                      >
                        补入下一段
                      </button>
                      <button
                        onClick={() => addMaterial(section.id, "image")}
                        disabled={!remainImage}
                      >
                        补入图片
                      </button>
                      <button
                        onClick={() => addMaterial(section.id, "all")}
                        disabled={!remainText && !remainImage}
                      >
                        补入剩余
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </section>
        </aside>
        <main className="brief-editor-column">
          {!draft ? (
            <section className="brief-empty">
              <FileText size={24} />
              <h3>还没有简讯草稿</h3>
              <p>从抓取资讯勾选条目后进入这里，按偏好生成初稿。</p>
            </section>
          ) : (
            <section className="brief-editor">
              <div className="editor-heading">
                <div>
                  <strong>简讯结构</strong>
                  <span>标题、导语、资讯卡片、正文段落、图片</span>
                </div>
                <small>
                  {draft.totalCharacters} 字 · {draft.readingMinutes} 分钟
                </small>
              </div>
              <input
                className="brief-title-input"
                value={draft.title || ""}
                onChange={(event) => updateDraft({ title: event.target.value })}
                placeholder="简讯标题"
              />
              <textarea
                className="brief-lead-input"
                value={draft.lead || ""}
                onChange={(event) => updateDraft({ lead: event.target.value })}
                placeholder="导语"
                rows={3}
              />
              <div className="article-card-list">
                {draft.sections.map((section, sectionIndex) => {
                  const collapsed = collapsedSectionIds.has(section.id);
                  return <article
                    key={section.id}
                    className={`article-card${collapsed ? " is-collapsed" : ""}`}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={onDrop(section.id, sectionIndex)}
                  >
                    <header className="article-card-header">
                      <button
                        type="button"
                        className="drag-handle"
                        draggable
                        aria-label="拖动资讯卡排序"
                        title="拖动资讯卡排序"
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/type", "section");
                          event.dataTransfer.setData("text/id", section.id);
                          setDragState(section.id);
                        }}
                        onDragEnd={() => setDragState(null)}
                      >
                        <GripVertical size={16} />
                      </button>
                      <div className="article-card-title">
                        <div className="article-card-title-row">
                          <button
                            type="button"
                            className="section-collapse"
                            onClick={() => setCollapsedSectionIds((current) => {
                              const next = new Set(current);
                              if (next.has(section.id)) next.delete(section.id);
                              else next.add(section.id);
                              return next;
                            })}
                            aria-label={collapsed ? "展开资讯内容" : "折叠资讯内容"}
                            title={collapsed ? "展开内容" : "折叠内容"}
                          >
                            <ChevronDown size={14} />
                          </button>
                          <input
                            value={section.heading || ""}
                            onChange={(event) =>
                              updateSection(section.id, {
                                heading: event.target.value,
                              })
                            }
                          />
                        </div>
                        <small>{section.sourceName || "未知来源"}</small>
                      </div>
                      <div className="card-actions">
                        <button
                          onClick={() => insertText(section.id)}
                          title="添加正文"
                        >
                          <Plus size={13} />
                          正文
                        </button>
                        <button
                          onClick={() => insertImage(section.id)}
                          title="添加图片"
                        >
                          <ImagePlus size={13} />
                          图片
                        </button>
                        <button
                          onClick={() =>
                            moveSection(sectionIndex, sectionIndex - 1)
                          }
                          aria-label="上移资讯卡"
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          onClick={() =>
                            moveSection(sectionIndex, sectionIndex + 1)
                          }
                          aria-label="下移资讯卡"
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          className="is-danger"
                          onClick={() =>
                            updateDraft({
                              sections: draft.sections.filter(
                                (item) => item.id !== section.id,
                              ),
                            })
                          }
                          title="删除整张资讯卡"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </header>
                    {!collapsed && <div className="article-card-blocks">
                      {section.blocks.map((block, blockIndex) => (
                        <div
                          key={block.id}
                          className={`editor-block editor-block--${block.type}`}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={onDrop(section.id, blockIndex)}
                        >
                          <button
                            type="button"
                            className="block-grip"
                            draggable
                            aria-label={
                              block.type === "image" ? "拖动图片" : "拖动段落"
                            }
                            title="拖动排序"
                            onDragStart={(event) => {
                              event.stopPropagation();
                              event.dataTransfer.setData("text/type", "block");
                              event.dataTransfer.setData("text/id", block.id);
                              event.dataTransfer.setData(
                                "text/section",
                                section.id,
                              );
                              setDragState(block.id);
                            }}
                            onDragEnd={() => setDragState(null)}
                          >
                            <GripVertical size={14} />
                          </button>
                          {block.type === "image" ? (
                            <div className="editor-image">
                              <img src={block.src} alt={block.alt || ""} />
                              <div className="image-caption">
                                <input
                                  value={block.alt || ""}
                                  placeholder="图片说明（可选）"
                                  onChange={(event) =>
                                    updateBlock(section.id, block.id, {
                                      alt: event.target.value,
                                    })
                                  }
                                />
                              </div>
                            </div>
                          ) : (
                            <div className="editor-text">
                              <select
                                value={block.format || "body"}
                                onChange={(event) =>
                                  updateBlock(section.id, block.id, {
                                    format: event.target.value,
                                  })
                                }
                              >
                                {FORMAT_OPTIONS.map((option) => (
                                  <option
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              <textarea
                                value={block.content || ""}
                                onChange={(event) =>
                                  updateBlock(section.id, block.id, {
                                    content: event.target.value,
                                  })
                                }
                                rows={Math.max(
                                  3,
                                  Math.min(
                                    9,
                                    (block.content || "").split("\n").length +
                                      1,
                                  ),
                                )}
                              />
                            </div>
                          )}
                          <button
                            className="block-delete"
                            onClick={() => removeBlock(section.id, block.id)}
                            aria-label={
                              block.type === "image" ? "删除图片" : "删除段落"
                            }
                            title={
                              block.type === "image" ? "删除图片" : "删除段落"
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>}
                  </article>;
                })}
              </div>
            </section>
          )}
        </main>
        <aside className="brief-preview-column">
          <section className="brief-preview">
            <header className="preview-header">
              <span>实时富文本预览</span>
              <strong>
                {draft
                  ? `${draft.readingMinutes} 分钟 · ${draft.totalCharacters} 字`
                  : "等待生成"}
              </strong>
            </header>
            <div className="preview-body">
              {draft ? (
                <>
                  <style>{BRIEF_TEMPLATE_CSS}</style>
                  <div dangerouslySetInnerHTML={{ __html: html }} />
                </>
              ) : (
                <p className="preview-empty">编辑内容会实时显示在这里。</p>
              )}
            </div>
          </section>
        </aside>
      </div>
      <Toast message={toast} onClose={() => setToast("")} />
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div
            className="modal-box"
            onClick={(event) => event.stopPropagation()}
          >
            <p>永久删除后无法恢复，确认删除这条简讯吗？</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    await api.deleteBrief(confirmDelete);
                    if (draft?.id === confirmDelete) setDraft(null);
                    await loadHistory();
                    flash("简讯已永久删除");
                  } catch (error) {
                    flash("删除失败：" + error.message);
                  } finally {
                    setConfirmDelete(null);
                  }
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
      {activePoster && (
        <div className="modal-overlay poster-viewer-overlay" onClick={() => setActivePoster(null)}>
          <section className="poster-viewer" onClick={(event) => event.stopPropagation()}>
            <header><div><strong>简讯海报 · {activePoster.date}</strong><small>只读预览，不会影响简讯编辑内容</small></div><div><a className="btn btn-secondary" href={`http://127.0.0.1:64424${activePoster.downloadUrl}`}>下载 HTML</a><button className="history-delete" onClick={() => setActivePoster(null)} aria-label="关闭海报预览" title="关闭"><X size={16} /></button></div></header>
            <iframe title={`简讯海报 ${activePoster.date}`} src={`http://127.0.0.1:64424${activePoster.url}`} />
          </section>
        </div>
      )}
    </div>
  );
}
