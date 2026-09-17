import cron from "node-cron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crawlCandidates, crawlDetails } from "./crawler/tasks.js";
import { generateRichDraft, generateBriefHtml } from "./content/generator.js";
import { listTodayArticles, listArticles, saveBrief, db } from "./database.js";
import { isCrawlerPaused, crawlerPauseMessage } from "./crawler/pause.js";
import { finalizeCrawlRun } from "./crawlFinalize.js";
import { syncFeishuTopicMonitor } from "./feishuTopicMonitor.js";
import { writeWeeklyPoster } from "./weeklyPoster.js";
import { getDashboardProjection } from "./briefProjection.js";
import { promisify } from "node:util";

const MOBILE_SOURCES = ["ref-haoyou","ref-taptap","ref-x7"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
let monitorRunning = false;
let pipelineRunning = false;
let posterRunning = false;

async function runRetentionMaintenance() {
  try {
    const { stdout = "" } = await execFileAsync(
      process.execPath,
      [path.join(root, "scripts", "retention-maintenance.mjs"), "--stage"],
      { cwd: root, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 },
    );
    console.log(`[retention-maintenance] ${String(stdout).trim()}`);
  } catch (error) {
    console.error(`[retention-maintenance] ${error.message}`);
  }
}

/**
 * 海报投递：复用既有脚本完成 HTML 归档、PNG 导出、飞书图片上传和消息发送。
 * 发送结果独立写入 cron-result，避免“简讯/周报已生成”被误当作“已投递”。
 */
async function runPosterDelivery(kind, sourceFile = "", articleIds = []) {
  const label = kind === "weekly" ? "weekly-poster" : "daily-poster";
  if (posterRunning) {
    console.log(`[${label}] 上一轮海报投递仍在运行，本轮跳过`);
    return null;
  }
  posterRunning = true;
  try {
    const args = [path.join(root, "scripts", "scheduled-posters.mjs"), kind];
    if (sourceFile) args.push("--file", path.basename(sourceFile));
    if (kind === "daily" && articleIds.length) args.push("--article-ids", articleIds.join(","));
    const { stdout = "", stderr = "" } = await execFileAsync(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 2 * 1024 * 1024,
    });
    let result;
    try {
      result = JSON.parse(String(stdout).trim());
    } catch {
      throw new Error(`海报脚本未返回可识别结果${stderr ? `：${String(stderr).trim()}` : ""}`);
    }
    if (!result?.ok || result?.feishu !== "sent") {
      throw new Error(result?.feishu || "飞书海报未发送");
    }
    await writeCronLog(label, {
      success: true,
      kind,
      fileName: path.basename(result.target || sourceFile || ""),
      previewGenerated: Boolean(result.previewPath),
      publicUrlAvailable: Boolean(result.publicUrl),
      publicError: result.publicError || "",
      feishu: result.feishu,
    });
    console.log(`[${label}] ✓ 飞书已发送：${path.basename(result.target || sourceFile || "")}`);
    return result;
  } catch (error) {
    const message = error?.message || "海报投递失败";
    await writeCronLog(label, { success: false, kind, fileName: path.basename(sourceFile || ""), error: message });
    console.error(`[${label}] ✗ ${message}`);
    return null;
  } finally {
    posterRunning = false;
  }
}

function safeJsonArray(val) { try { return typeof val === "string" ? JSON.parse(val) : val; } catch { return null; } }

function contentCompleteness(article) {
  const paragraphs = (article.paragraphs || []).filter(Boolean);
  const images = safeJsonArray(article.images_json) || article.images || [];
  const facts = article.facts || {};
  const structuredTapTapEvent = Array.isArray(facts.taptapEvents) && facts.taptapEvents.some((event) => event?.blocks?.length);
  return paragraphs.length * 18 + paragraphs.join(" ").length / 90 + images.length * 5 + (structuredTapTapEvent ? 60 : 0);
}

function preferDuplicate(candidate, current) {
  const candidateTapTapDetail = candidate.source_id === "ref-taptap" && contentCompleteness(candidate) > 30;
  const currentTapTapDetail = current.source_id === "ref-taptap" && contentCompleteness(current) > 30;
  // 同游戏去重时，TapTap 完整活动详情优先于好游快爆的列表摘要；
  // 若 TapTap 没有真正详情，则继续按内容完整度和评分比较。
  if (candidateTapTapDetail && current.source_id === "ref-haoyou") return true;
  if (currentTapTapDetail && candidate.source_id === "ref-haoyou") return false;
  const candidateScore = contentCompleteness(candidate) + (candidate.score || 0);
  const currentScore = contentCompleteness(current) + (current.score || 0);
  return candidateScore > currentScore;
}

async function writeCronLog(label, detail) {
  const logFile = path.join(root, "data", "logs", "cron-result.json");
  const entry = { time: new Date().toISOString(), label, ...detail };
  try {
    let logs = [];
    try { logs = JSON.parse(await fs.readFile(logFile, "utf-8")); } catch {}
    logs.push(entry);
    if (logs.length > 50) logs = logs.slice(-50);
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.writeFile(logFile, JSON.stringify(logs, null, 2));
  } catch (e) { console.error("[cron-log]", e.message); }
}

/**
 * 高频监控流水线：只负责手游新游/活动、飞书文档和提醒机器人。
 * 不刷新 RAW，不生成今日简讯，不生成海报。
 */
async function runMonitorPipeline(label = "monitor-hourly") {
  if (monitorRunning) {
    console.log(`[${label}] 上一轮监控仍在运行，本轮跳过`);
    return null;
  }
  if (isCrawlerPaused()) {
    console.log(`[${label}] ${crawlerPauseMessage()}`);
    return null;
  }
  monitorRunning = true;
  const startedAt = new Date().toISOString();
  const log = (...args) => console.log(`[${label} ${startedAt.slice(11, 19)}]`, ...args);
  try {
    log("监控流水线启动");
    log("Step 1/3 抓取 TapTap/好游快爆候选...");
    const crawlResults = await crawlCandidates(MOBILE_SOURCES);
    const candidateIds = crawlResults
      .flatMap((result) => (result.candidates || []).map((candidate) => candidate.id))
      .filter(Boolean);
    log(`  ✓ 候选 ${candidateIds.length} 条`);

    log("Step 2/3 补全新增或变化详情...");
    if (candidateIds.length) {
      const details = await crawlDetails(candidateIds);
      const success = (details.perPlatform || []).reduce((sum, item) => sum + (item.successCount || 0), 0);
      const failed = (details.perPlatform || []).reduce((sum, item) => sum + (item.failCount || 0), 0);
      log(`  ✓ 详情 ${success} 篇成功${failed ? `，${failed} 篇失败` : ""}`);
    } else {
      log("  - 没有需要补全的详情");
    }

    log("Step 3/3 同步飞书并发送新增提醒...");
    const sync = await syncFeishuTopicMonitor();
    const notification = sync.notification || {};
    const notificationStatus = notification.sent
      ? "已发送"
      : notification.error
        ? `发送失败：${notification.error}`
        : notification.reason || "未发送";
    log(`  ✓ 飞书新增 ${sync.inserted || 0} 条，机器人${notificationStatus}`);
    await writeCronLog(label, {
      success: true,
      candidates: candidateIds.length,
      inserted: sync.inserted || 0,
      notification: sync.notification || null,
    });
    return sync;
  } catch (error) {
    log(`  ✗ ${error.message}`);
    await writeCronLog(label, { success: false, error: error.message });
    return null;
  } finally {
    monitorRunning = false;
  }
}

/** 核心流水线：爬取 → 详情 → 简讯 → 输出JSON */
async function runPipeline(label = "daily", maxSections = 12, { syncMonitor = true } = {}) {
  if (pipelineRunning) {
    console.log(`[${label}] 上一轮完整流水线仍在运行，本轮跳过`);
    return null;
  }
  if (isCrawlerPaused()) {
    console.log(`[${label}] ${crawlerPauseMessage()}`);
    return null;
  }
  pipelineRunning = true;
  const startedAt = new Date().toISOString();
  const log = (...args) => console.log(`[${label} ${startedAt.slice(11, 19)}]`, ...args);
  try {
    log("流水线启动");

    // 1. 爬取候选
    log("Step 1/5 候选抓取...");
    let crawlResults;
    try {
      crawlResults = await crawlCandidates();
      const total = crawlResults.reduce((s, r) => s + (r.count || 0), 0);
      log(`  ✓ ${total} 条新候选`);
    } catch (e) { log(`  ✗ ${e.message}`); return null; }

    // 2. 定时任务生成的是可直接阅读的今日简讯，因此对本轮候选直接补全文、图片和布局。
    // 手动“抓取资讯”仍保留人工选择入口；Firecrawl 仅在普通详情抓取失败时回退。
    log("Step 2/5 补全候选详情...");
    try {
    const candidateIds = crawlResults
      .flatMap((result) => (result.candidates || []).map((candidate) => candidate.id))
      .filter(Boolean);
    if (candidateIds.length) {
      const details = await crawlDetails(candidateIds);
      const success = (details.perPlatform || []).reduce((sum, item) => sum + (item.successCount || 0), 0);
      const failed = (details.perPlatform || []).reduce((sum, item) => sum + (item.failCount || 0), 0);
      log(`  ✓ 详情补全 ${success} 篇成功${failed ? `，${failed} 篇失败` : ""}`);
    } else {
      log("  - 本轮没有需要补全的候选");
    }
    } catch (e) {
      // 详情异常只影响个别文章，不中断后续清理和简讯归档。
      log(`  ! 详情补全出现异常：${e.message}`);
    }

    // 2.5 手动更新与定时任务共用同一收尾：保留期清理、RAW 同步和每日首份归档。
    log("Step 3/5 清理旧文章并同步 RAW 验收快照...");
    const finalized = await finalizeCrawlRun({ root, log: (message) => log(`  ✓ ${message}`) });
    const rawSnapshot = finalized.raw;
    finalized.warnings.forEach((warning) => log(`  ! ${warning}`));

    if (syncMonitor) {
    // 手动完整流水线保留原行为；自动定时由独立的每小时监控流水线负责。
    log("Step 3.5/5 同步飞书新游活动记录...");
    try {
      const sync = await syncFeishuTopicMonitor();
      log(`  ✓ 飞书新增 ${sync.inserted || 0} 条，跳过已有 ${sync.skippedExisting || 0} 条`);
    } catch (error) {
      log(`  ! 飞书同步失败：${error.message}`);
    }
    }

    // 3. 生成简讯
    log("Step 4/5 生成简讯...");
    let brief = null;
    let finalArticleCount = 0;
    try {
    const { articles } = listTodayArticles();
    finalArticleCount = (articles || []).length;
    const topArticles = (articles || [])
      .filter(a => a.score >= 48 && !["low_quality","low","failed"].includes(a.quality))
      .filter(a => a.source_id !== "ref-steam")
      .sort((a, b) => {
        const pa = (a.paragraphs || []).length, pb = (b.paragraphs || []).length;
        // 正文≥3段的高质文章优先
        if (pa >= 3 && pb < 3) return -1;
        if (pb >= 3 && pa < 3) return 1;
        // 有正文的优先
        if (pa > 0 && pb === 0) return -1; if (pb > 0 && pa === 0) return 1;
        // 手游来源优先于端游
        if (MOBILE_SOURCES.includes(a.source_id) && !MOBILE_SOURCES.includes(b.source_id)) return -1;
        if (MOBILE_SOURCES.includes(b.source_id) && !MOBILE_SOURCES.includes(a.source_id)) return 1;
        // 按分数降序
        return (b.score || 0) - (a.score || 0);
      });

    // 跨平台去重：同游戏优先保留完整活动详情；TapTap 完整活动详情优先于好游快爆摘要。
    const seenGames = new Map();
    const NON_GAME = /专项公告|排行榜|不容错过|好玩的游戏|试玩投票|抽奖|开奖|活动投票|招募|平台公告|推荐合集|金海豚/i;
    const OLD_YEAR = /(19|20)\d{2}年|去年|前年/;
    const DUP_SUFFIX = /发售|获\d+分|游戏评测|媒体|评价|销量|上线|开启|发布|公开|公布|正式/;
    for (const a of topArticles) {
      const title = a.title || "";
      if (NON_GAME.test(title)) continue;
      if (OLD_YEAR.test(title)) continue; // 排除旧年份文章
      // 去重键：书名号内前8字 + 去事件后缀
      const bm = /《([^》]+)》/.exec(title);
      const base = bm ? bm[1].replace(DUP_SUFFIX, "").trim().slice(0, 8) : (a.game_name || "").slice(0, 8);
      const key = base.replace(/[《》（）()\s]+/g, "") || title.slice(0, 8);
      const exist = seenGames.get(key);
      if (!exist) { seenGames.set(key, a); continue; }
      if (preferDuplicate(a, exist)) seenGames.set(key, a);
    }
    const deduped = [...seenGames.values()];

    // 来源均衡：单平台最多占 1/3 段，从全部候选中轮转选取
    const MAX_PER_SOURCE = Math.max(3, Math.floor(maxSections / 3));
    const srcCount = {};
    const balanced = [];
    for (const a of deduped) {
      if (balanced.length >= maxSections) break;
      const sid = a.source_id || "?";
      if ((srcCount[sid] || 0) >= MAX_PER_SOURCE) continue;
      srcCount[sid] = (srcCount[sid] || 0) + 1;
      balanced.push(a);
    }
    // 若主来源配额未用满，补充其余候选
    if (balanced.length < maxSections) {
      for (const a of deduped) {
        if (balanced.length >= maxSections) break;
        const sid = a.source_id || "?";
        if (balanced.some(x => x.id === a.id)) continue;
        if ((srcCount[sid] || 0) >= MAX_PER_SOURCE) continue;
        srcCount[sid] = (srcCount[sid] || 0) + 1;
        balanced.push(a);
      }
    }

    if (balanced.length) {
      const events = balanced.map(a => ({
        title: a.title || "", gameName: a.game_name || "", category: a.category || "新游上线",
        paragraphs: (a.paragraphs || []).filter(Boolean).slice(0, 5),
        images: safeJsonArray(a.images_json) || a.images || [],
        sourceName: a.source_name || "",
        detailUrl: a.detail_url || "",
      }));
      const draft = generateRichDraft(events, { templateId: "T3" });
      brief = saveBrief({ ...draft, style: "professional", maxLength: 3000, slot: label });
      log(`  ✓ ${draft.sections.length} 段 (${balanced.length} 款游戏, 均衡${Object.keys(srcCount).length}来源)`);
    } else { log("  - 无足够高分资讯"); }
    } catch (e) { log(`  ✗ ${e.message}`); }

    // 4. 输出 JSON
    log("Step 5/5 输出 JSON...");
    const outputFile = path.join(root, "data", `brief-${label}.json`);
    try {
    const { articles: allToday } = listTodayArticles();
    const sourceStats = {};
    for (const a of allToday) sourceStats[a.source_name || a.source_id] = (sourceStats[a.source_name || a.source_id] || 0) + 1;
    const output = {
      generatedAt: new Date().toISOString(), type: label,
      brief: brief ? {
        title: brief.title || "今日游戏简讯",
        date: new Date().toLocaleDateString("zh-CN", { month:"long", day:"numeric" }),
        lead: brief.lead || "", style: brief.style || "professional",
        sections: (brief.sections || []).map(s => ({ heading: s.heading || "", body: s.body || "", blocks: s.blocks || [] })),
        sourceNotes: brief.sourceNotes || [], totalCharacters: brief.totalCharacters || 0, readingMinutes: brief.readingMinutes || 1,
        briefHtml: brief ? generateBriefHtml(brief) : "",
      } : null,
      stats: { totalArticles: allToday.length, newFromCrawl: crawlResults.reduce((s,r)=>s+(r.count||0),0), platformBreakdown: sourceStats, rawSnapshot },
      pipelineLog: { startedAt, finishedAt: new Date().toISOString(), crawlResults: crawlResults.map(r => ({ sourceId:r.sourceId, urlType:r.urlType, count:r.count||0, error:r.error||null })) },
    };
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    const serialized = JSON.stringify(output, null, 2);
    await fs.writeFile(outputFile, serialized);
    const archiveDate = new Date().toISOString().slice(0, 10);
    const archiveFile = path.join(root, "data", "brief-archive", label, `${archiveDate}.json`);
    await fs.mkdir(path.dirname(archiveFile), { recursive: true });
    await fs.writeFile(archiveFile, serialized);
    log(`  ✓ ${outputFile}`);
    log(`  ✓ 归档 ${archiveFile}`);
    } catch (e) { log(`  ✗ ${e.message}`); await writeCronLog(label, { success: false, error: e.message }); }

    log("完成");
    await writeCronLog(label, { success: true, sections: brief?.sections?.length || 0, articles: finalArticleCount });
    return brief;
  } finally {
    pipelineRunning = false;
  }
}

/** 周报生成（不爬取，只用已审核文章） */
async function runWeeklyBrief() {
  if (isCrawlerPaused()) {
    console.log(`[weekly] ${crawlerPauseMessage()}`);
    return null;
  }
  const startedAt = new Date().toISOString();
  const log = (...args) => console.log(`[weekly ${startedAt.slice(11, 19)}]`, ...args);
  log("周报生成");

  try {
    const poster = await writeWeeklyPoster({
      root,
      assetBase: "http://127.0.0.1:64424",
    });
    log(`  ✓ 周报长海报 ${poster.fileName}（${poster.snapshotDays} 天快照 / ${poster.articleCount} 条素材）`);
    const output = {
      generatedAt: new Date().toISOString(),
      type: "weekly",
      poster: {
        fileName: poster.fileName,
        period: poster.period,
        snapshotDays: poster.snapshotDays,
        articleCount: poster.articleCount,
        url: `/generated-output/${encodeURIComponent(poster.fileName)}`,
        archiveUrl: `/generated-output/weekly-poster-archive/${encodeURIComponent(poster.fileName)}`,
      },
      stats: { period: poster.period, snapshotDays: poster.snapshotDays, sourceArticles: poster.articleCount },
    };
    await writeBriefArchive("weekly", JSON.stringify(output, null, 2));
    await writeCronLog("weekly", { success: true, articles: poster.articleCount, snapshotDays: poster.snapshotDays });
    return output;
  } catch (e) { log(`  ✗ ${e.message}`); }
  await writeCronLog("weekly", { success: false });
}

async function runMorningBriefAndPoster() {
  await runPipeline("morning", 12, { syncMonitor: false });
  // 日海报与首页“今日简讯”使用同一份产品投影：新游、今日活动、未来活动、
  // TapTap 热点、Steam 与端游资讯均由 briefProjection 的渠道上限和去重规则决定。
  const articleIds = getDashboardProjection().projection?.selectedArticleIds || [];
  if (!articleIds.length) console.warn("[daily-poster] 今日简讯投影为空，回退为今日自动选稿");
  return runPosterDelivery("daily", "", articleIds);
}

async function runWeeklyBriefAndPoster() {
  const weekly = await runWeeklyBrief();
  const sourceFile = weekly?.poster?.fileName || "";
  if (!sourceFile) return null;
  return runPosterDelivery("weekly", sourceFile);
}

async function writeBriefArchive(label, serialized) {
  const currentFile = path.join(root, "data", label === "weekly" ? "weekly-brief.json" : `brief-${label}.json`);
  const archiveDate = new Date().toISOString().slice(0, 10);
  const archiveFile = path.join(root, "data", "brief-archive", label, `${archiveDate}.json`);
  await fs.mkdir(path.dirname(currentFile), { recursive: true });
  await fs.writeFile(currentFile, serialized);
  await fs.mkdir(path.dirname(archiveFile), { recursive: true });
  await fs.writeFile(archiveFile, serialized);
}

/** 启动定时任务 */
export function startScheduler() {
  if (isCrawlerPaused()) {
    console.log("[scheduler] 爬虫维护暂停，定时任务未注册；服务继续启动");
    return;
  }
  // 每日早报 08:30
  cron.schedule("0 8-23 * * *", () => runMonitorPipeline().catch(e => console.error("[monitor-hourly]", e)));
  cron.schedule("30 8 * * *", () => runMorningBriefAndPoster().catch(e => console.error("[morning-poster]", e)));
  // 每日晚报 17:50
  cron.schedule("50 17 * * *", () => runPipeline("afternoon", 12, { syncMonitor: false }).catch(e => console.error("[afternoon]", e)));
  // 每周一 08:35 周报
  cron.schedule("35 8 * * 1", () => runWeeklyBriefAndPoster().catch(e => console.error("[weekly-poster]", e)));
  // 每日凌晨：最近 7 天和未来保留完整数据；更早内容轻量 JSON 留档，图片不缓存。
  cron.schedule("15 3 * * *", () => runRetentionMaintenance().catch(e => console.error("[retention-maintenance]", e)));

  console.log("[scheduler] 已启动 — 08:00-23:00每小时监控 + 08:30早报/日海报 + 17:50晚报 + 周一08:35周报/飞书投递 + 每日03:15轻量留档清理");
}

export { runPipeline, runMonitorPipeline, runWeeklyBrief };
