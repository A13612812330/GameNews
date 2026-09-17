import { db } from '../server/database.js';
import fs from 'fs';
import { contentFilter as steamFilter } from '../server/crawler/platforms/steam.js';
import { contentFilter as taptapFilter, hotTopicFilter as taptapHotTopicFilter, isDetailUrl as isTapTapDetailUrl } from '../server/crawler/platforms/taptap.js';
import {
  isWithinNextDays as isHaoyouWithinNextDays,
  extractGameName as extractHaoyouGameName,
  cleanUpdateTitle as cleanHaoyouUpdateTitle,
  cleanTimelineSummary as cleanHaoyouTimelineSummary,
} from '../server/crawler/platforms/haoyou.js';
import { contentFilter as gcoresFilter, cleanTitle as cleanGcoresTitle, extractGameName as extractGcoresGameName, isDetailUrl as isGcoresDetailUrl } from '../server/crawler/platforms/gcores.js';
import { contentFilter as gamerskyFilter } from '../server/crawler/platforms/gamersky.js';
import { getMobilePrioritySignals } from '../server/crawler/scorer.js';
import { getBriefProjection, projectionDecisionFor } from '../server/briefProjection.js';

const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
const allArts = db.prepare(`SELECT id,title,game_name,source_name,source_id,category,score,quality,paragraphs,facts,images_json,detail_url,image_url,date_text,discovered_at FROM articles WHERE discovered_at >= ? AND source_id <> 'ref-jiuyou' ORDER BY source_name, score DESC`).all(since);
const isTapTapHotSnapshot = article => article.source_id === 'ref-taptap' && /\/forum\/hot\/hashtags\?item=\d+/.test(article.detail_url || '');
const isTapTapUpcomingSnapshot = article => article.source_id === 'ref-taptap' && /\/app\/\d+\/?$/.test(article.detail_url || '');
const isTapTapEventSnapshot = article => article.source_id === 'ref-taptap' && /\/app\/\d+\/game-event\/?/.test(article.detail_url || '');
// RAW 是 file:// 静态验收页，不能使用站点根相对路径。将已落盘图片指向
// 本地后端静态服务，避免浏览器把 /crawler-assets 解析为磁盘根目录。
const RAW_ASSET_ORIGIN = 'http://127.0.0.1:64424';

function rawImageSrc(value = '', sourceId = '') {
  const src = String(value || '').trim();
  if (src.startsWith('/crawler-assets/')) return `${RAW_ASSET_ORIGIN}${src}`;
  // 好游快爆远程封面有防盗链，静态 RAW 页面没有前端代理能力，改走后端图片代理。
  if (sourceId === 'ref-haoyou' && /^https:\/\/[^/]*(?:71acg\.net|3839img\.com|3839video\.com)\//iu.test(src)) {
    return `${RAW_ASSET_ORIGIN}/api/image-proxy?url=${encodeURIComponent(src)}`;
  }
  return src;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function renderRichHtml(value = '') {
  return String(value || '')
    .replace(/<\s*(script|style|iframe|object|form)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/\son[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

function haoyouDateValue(value = '') {
  const match = /^(\d{1,2})月(\d{1,2})日/u.exec(String(value || '').trim());
  if (!match) return Number.MAX_SAFE_INTEGER;
  const now = new Date();
  let target = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (target.getTime() < today.getTime() && now.getMonth() >= 10 && Number(match[1]) <= 3) {
    target = new Date(now.getFullYear() + 1, Number(match[1]) - 1, Number(match[2]));
  }
  return target.getTime();
}

// 所有 RAW 表统一使用的时间排序：最早在前；无法解析来源时间时排到表尾，
// 并用发现时间和原始顺序维持稳定展示，避免同一批次刷新时跳动。
function articleTimeValue(article = {}) {
  const value = String(article.date_text || '').trim();
  const now = new Date();
  const makeDate = (year, month, day, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();
  // TapTap 即将上线使用“08/07 周五”“08/05 周三 02:00 开始”等格式；
  // 去掉星期与状态文本后再解析，确保按真实上线时间排序。
  const compact = value
    .replace(/\s*(?:周|星期)[一二三四五六日天]/u, ' ')
    .replace(/\s*(?:开始|首发|上线|开测|测试|更新)$/u, '')
    .trim();
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/.exec(value);
  if (match) return makeDate(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] || 0), Number(match[5] || 0));
  match = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s+(\d{1,2}):(\d{2}))?/.exec(value);
  if (match) return makeDate(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] || 0), Number(match[5] || 0));
  match = /^(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?/.exec(compact);
  if (!match) match = /^(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/.exec(compact);
  if (match) {
    let year = now.getFullYear();
    const candidate = makeDate(year, Number(match[1]), Number(match[2]), Number(match[3] || 0), Number(match[4] || 0));
    const today = new Date(year, now.getMonth(), now.getDate()).getTime();
    if (candidate < today && now.getMonth() >= 10 && Number(match[1]) <= 3) year++;
    return makeDate(year, Number(match[1]), Number(match[2]), Number(match[3] || 0), Number(match[4] || 0));
  }
  if (/今天|今日/.test(value)) return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (/明天/.test(value)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return Number.MAX_SAFE_INTEGER;
}

function isWithinNextDaysByArticleDate(article = {}, days = 7) {
  const value = articleTimeValue(article);
  if (!Number.isFinite(value) || value === Number.MAX_SAFE_INTEGER) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 999);
  return value >= today.getTime() && value <= end.getTime();
}

function sortArticlesByTime(articles = []) {
  return articles
    .map((article, index) => ({ article, index }))
    .sort((left, right) => articleTimeValue(left.article) - articleTimeValue(right.article)
      || String(left.article.discovered_at || '').localeCompare(String(right.article.discovered_at || ''), 'zh-CN')
      || left.index - right.index)
    .map(item => item.article);
}

function getFacts(article) {
  try { return JSON.parse(article.facts || '{}'); } catch { return {}; }
}

function imageLookupKey(value = '') {
  return String(value || '').trim().replace(/&amp;/g, '&').replace(/#.*$/, '');
}

function localizeHaoyouFacts(facts = {}, imageMeta = []) {
  const localByOriginal = new Map((Array.isArray(imageMeta) ? imageMeta : [])
    .filter(image => image?.originalUrl && (image?.src || image?.localUrl))
    .map(image => [imageLookupKey(image.originalUrl), rawImageSrc(image.src || image.localUrl, 'ref-haoyou')]));
  const localizeUrl = value => localByOriginal.get(imageLookupKey(value)) || rawImageSrc(value, 'ref-haoyou');
  const localizeHtml = value => String(value || '').replace(/(\bsrc\s*=\s*["'])([^"']+)(["'])/giu, (all, start, url, end) => `${start}${localizeUrl(url)}${end}`);
  return {
    ...facts,
    haoyouLayout: Array.isArray(facts.haoyouLayout)
      ? facts.haoyouLayout.map(block => block?.type === 'image'
        ? { ...block, url: localizeUrl(block.url || block.src || block.originalUrl), src: localizeUrl(block.url || block.src || block.originalUrl) }
        : block)
      : facts.haoyouLayout,
    haoyouIntroHtml: localizeHtml(facts.haoyouIntroHtml),
  };
}

function getArticleImageItems(article) {
  try {
    // 已落盘图片优先：详情抓取成功后不再依赖原站热链；远程地址只作回退。
    const images = JSON.parse(article.images_json || '[]').map(item => {
      const src = rawImageSrc(item.src || item.originalUrl || item.url, article.source_id);
      return src ? { src, originalUrl: item.originalUrl || item.url || src, alt: item.alt || '' } : null;
    }).filter(Boolean);
    return images.length ? images : (article.image_url ? [{ src: rawImageSrc(article.image_url, article.source_id), originalUrl: article.image_url, alt: '' }] : []);
  } catch { return article.image_url ? [{ src: rawImageSrc(article.image_url, article.source_id), originalUrl: article.image_url, alt: '' }] : []; }
}

function getArticleImages(article) {
  return getArticleImageItems(article).map(item => item.src);
}

function renderGcoresLayout(article, paragraphs, images) {
  const layout = getFacts(article).gcoresLayout;
  if (!Array.isArray(layout) || !layout.length) return '';
  return `<div class="gcores-rich-content">${layout.map(block => {
    if (block.type === 'image' && block.url) {
      return `<figure class="gcores-rich-image${block.cover ? ' is-cover' : ''}"><a href="${escapeHtml(block.url)}" target="_blank"><img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.alt || '机核正文图片')}"></a>${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>`;
    }
    if (block.type === 'text' && Array.isArray(block.segments)) {
      const text = block.segments.map(segment => {
        let value = escapeHtml(segment.text || '');
        if (segment.bold) value = `<strong>${value}</strong>`;
        if (segment.italic) value = `<em>${value}</em>`;
        return value;
      }).join('');
      return text.trim() ? `<p class="${block.quote ? 'is-quote' : ''}">${text}</p>` : '';
    }
    if (block.type === 'embed' && block.url) return `<div class="gcores-rich-embed"><a href="${escapeHtml(block.url)}" target="_blank">打开原文媒体${block.caption ? `：${escapeHtml(block.caption)}` : ''}</a></div>`;
    return '';
  }).join('')}</div>`;
}

function renderGamerskyLayout(article) {
  const layout = getFacts(article).gamerskyLayout;
  if (!Array.isArray(layout) || !layout.length) return '';
  return `<div class="gamersky-rich-content">${layout.map(block => {
    if (block.type === 'text' && block.text) return `<p>${escapeHtml(block.text)}</p>`;
    if (block.type === 'image' && block.url) return `<figure class="gamersky-rich-image"><a href="${escapeHtml(block.url)}" target="_blank"><img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.alt || '游民星空正文图片')}"></a></figure>`;
    return '';
  }).join('')}</div>`;
}

function isTodayOrFutureNewsDateText(value = '') {
  const match = /(\d{1,2})月(\d{1,2})日/.exec(String(value));
  if (!match) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]));
  if (target.getTime() < today.getTime() && now.getMonth() >= 10 && Number(match[1]) <= 3) target = new Date(now.getFullYear() + 1, Number(match[1]) - 1, Number(match[2]));
  return target.getTime() >= today.getTime();
}

function visibleArticle(article) {
  if (article.source_id === 'ref-taptap') {
    const isHotTopic = isTapTapHotSnapshot(article);
    const isEventReserve = isTapTapEventSnapshot(article);
    let body = '';
    try { body = JSON.parse(article.paragraphs || '[]').join(' '); } catch {}
    if (isHotTopic) {
      // 热榜按页面顺序固定保留前五条，不套用即将上线的资讯过滤器。
      if (!isTapTapDetailUrl(article.detail_url || '')) return false;
      return true;
    } else if (isEventReserve) {
      // 版本更新 / 活动 / 联动只保留今日至未来 7 天，避免旧事件或远期预告混入。
      return isWithinNextDaysByArticleDate(article, 7);
    } else if (!taptapFilter(article.title || '')) return false;
    if (!isTapTapDetailUrl(article.detail_url || '')) return false;
    if (['low', 'low_quality', 'failed'].includes(article.quality)) return false;
    return true;
  }
  if (article.source_id === 'ref-gcores') {
    if (!gcoresFilter(article.title || '')) return false;
    if (!isGcoresDetailUrl(article.detail_url || '')) return false;
    if (!isTodayOrFutureNewsDateText(article.date_text)) return false;
    if (['low', 'low_quality', 'failed', 'pending'].includes(article.quality)) return false;
    try { if (JSON.parse(article.paragraphs || '[]').join('').length < 80) return false; } catch { return false; }
    return true;
  }
  if (article.source_id === 'ref-gamersky') {
    if (!gamerskyFilter(article.title || '')) return false;
    if (!isTodayOrFutureNewsDateText(article.date_text)) return false;
    if (['low', 'low_quality', 'failed', 'pending'].includes(article.quality)) return false;
    try { if (JSON.parse(article.paragraphs || '[]').join('').length < 80) return false; } catch { return false; }
    return true;
  }
  if (article.source_id === 'ref-haoyou') {
    // 仅收紧“即将上线 + 即将测试”；即将更新仍遵循已有的今日/未来规则。
    return getFacts(article).haoyouKind === 'update' || isHaoyouWithinNextDays(article.date_text, 7);
  }
  if (article.source_id !== 'ref-steam') return true;
  if (['low', 'low_quality', 'failed', 'pending'].includes(article.quality)) return false;
  const title = `${article.title || ''} ${article.game_name || ''}`;
  const body = article.paragraphs || '';
  if (/\b(DLC|Demo|Beta|Expansion|Season\s*Pass|Supporter\s*Pack|Soundtrack|OST|Bundle|Upgrade|Add[-\s]?on)\b/i.test(title)) return false;
  if (/(下载内容|扩展包|季票|原声带|演示版|试玩版|支持者包|工具|编辑器|服务器|壁纸)/i.test(title)) return false;
  if (/(productivity\s+app|writing\s+tool|desktop\s+app|desktop\s+pet|screen\s+companion|scratchpad|image\s+editor|video\s+editor|audio\s+production)/i.test(body)) return false;
  try {
    const facts = JSON.parse(article.facts || '{}');
    if (Array.isArray(facts.rejectReasons) && facts.rejectReasons.length) return false;
    if (facts.potentialScore !== undefined && Number(facts.potentialScore) < 55) return false;
  } catch {}
  return true;
}

const arts = allArts.filter(visibleArticle).map(article => {
  if (article.source_id === 'ref-gcores') {
    const title = cleanGcoresTitle(article.title || '');
    return { ...article, title, game_name: extractGcoresGameName(title) || article.game_name };
  }
  if (article.source_id === 'ref-haoyou') {
    const facts = getFacts(article);
    const gameName = extractHaoyouGameName(article.game_name || article.title || '');
    const title = facts.haoyouKind === 'update'
      ? cleanHaoyouUpdateTitle(article.title || '', gameName)
      : article.title || '';
    const paragraphs = (() => {
      try {
        return JSON.parse(article.paragraphs || '[]')
          .map(item => cleanHaoyouTimelineSummary(item))
          .filter(Boolean);
      } catch { return []; }
    })();
    let imageMeta = [];
    try { imageMeta = JSON.parse(article.images_json || '[]'); } catch {}
    return {
      ...article,
      title,
      game_name: gameName,
      paragraphs: JSON.stringify(paragraphs),
      facts: JSON.stringify(localizeHaoyouFacts(facts, imageMeta)),
    };
  }
  return article;
});
const hiddenCount = allArts.length - arts.length;
// 统一投影是 Dashboard 与 RAW 的共同标准。RAW 可以保留更宽的验收候选，
// 但不得再因旧的来源级过滤漏掉已经进入 Dashboard 的资讯。
const projection = getBriefProjection();

function keepCurrentSteamLists(rows) {
  // 旧的“新游上线 / 热门爆款 / 近期热点”记录没有列表来源与排名快照，
  // 不能混入新的双表输出；历史仍保留在数据库，RAW 只显示新规则产物。
  const retainedKinds = new Set(['new', 'most_played', 'top_selling_cn']);
  const latestSnapshots = new Map();
  for (const row of rows) {
    if (row.source_id !== 'ref-steam') continue;
    const facts = getFacts(row);
    if (!['most_played', 'top_selling_cn'].includes(facts.steamList) || !facts.steamSnapshotId) continue;
    const current = latestSnapshots.get(facts.steamList) || '';
    if (String(facts.steamSnapshotId) > current) latestSnapshots.set(facts.steamList, String(facts.steamSnapshotId));
  }
  return rows.filter(row => {
    if (row.source_id !== 'ref-steam') return true;
    const facts = getFacts(row);
    if (!retainedKinds.has(facts.steamList)) return false;
    const latest = latestSnapshots.get(facts.steamList);
    return !latest || facts.steamSnapshotId === latest;
  });
}

function capTapTapHotTopics(rows) {
  const hot = rows.filter(isTapTapHotSnapshot)
    .sort((a, b) => Number(/item=(\d+)/.exec(a.detail_url || '')?.[1] || 999) - Number(/item=(\d+)/.exec(b.detail_url || '')?.[1] || 999))
    .slice(0, 5);
  return [...rows.filter(a => !isTapTapHotSnapshot(a)), ...hot];
}

function capStrictGamersky(rows) {
  const strictRows = rows.filter(article => article.source_id === 'ref-gamersky');
  const others = rows.filter(article => article.source_id !== 'ref-gamersky');
  const rank = article => {
    const title = article.title || '';
    const contentLength = (() => { try { return JSON.parse(article.paragraphs || '[]').join('').length; } catch { return 0; } })();
    const officialSignals = (title.match(/官方|官宣|公布|发布|上线|发售|预售|更新|版本|补丁|DLC|测试|实机|定档|预约|开放|开发完成|版号/giu) || []).length;
    return officialSignals * 10000 + contentLength + Number(article.score || 0);
  };
  const retained = [];
  const seen = new Set();
  strictRows.sort((a, b) => rank(b) - rank(a) || (b.date_text || '').localeCompare(a.date_text || '', 'zh-CN'));
  for (const article of strictRows) {
    const day = /^(\d{2}月\d{2}日)/u.exec(article.date_text || '')?.[1] || article.date_text || '';
    const game = (article.game_name || article.title || '').trim();
    const key = `${day}:${game}`;
    if (seen.has(key)) continue;
    seen.add(key);
    retained.push(article);
  }
  return [...others, ...retained];
}

// RAW 验收面保留五条已经完成规则整理的来源；其他来源仍留在历史数据库，
// 但不参与当前候选展示或简讯选择。
const ACTIVE_RAW_SOURCE_IDS = new Set(['ref-steam', 'ref-taptap', 'ref-haoyou', 'ref-gcores', 'ref-gamersky']);
let displayArts = capStrictGamersky(capTapTapHotTopics(keepCurrentSteamLists(arts)))
  .filter(article => ACTIVE_RAW_SOURCE_IDS.has(article.source_id));
const haoyouRows = displayArts.filter(article => article.source_id === 'ref-haoyou');
const latestHaoyouAt = haoyouRows.reduce((latest, row) => {
  const time = new Date(row.discovered_at || 0).getTime();
  return time > latest.time ? { value: row.discovered_at, time } : latest;
}, { value: '', time: 0 }).value;
const latestHaoyouTime = new Date(latestHaoyouAt || 0).getTime();
// 好游 94 条候选抓取可能跨越多个 SQLite 秒级时间戳，按最近10分钟识别同一批次。
if (latestHaoyouTime) displayArts = displayArts.filter(article => article.source_id !== 'ref-haoyou' || new Date(article.discovered_at || 0).getTime() >= latestHaoyouTime - 10 * 60 * 1000);

const dashboardSelectedIds = new Set(Object.keys(projection.audit.decisionByArticleId || {}));
const displayIds = new Set(displayArts.map(article => article.id));
const projectionForcedIds = [];
for (const article of allArts) {
  if (!dashboardSelectedIds.has(article.id) || displayIds.has(article.id)) continue;
  if (!ACTIVE_RAW_SOURCE_IDS.has(article.source_id)) continue;
  displayArts.push({ ...article, projectionForced: true });
  displayIds.add(article.id);
  projectionForcedIds.push(article.id);
}

const MOBILE_SOURCES = new Set(['ref-taptap', 'ref-haoyou']);
const PC_SOURCES = new Set(['ref-steam', 'ref-gcores', 'ref-gamersky']);
// 抓取资讯等级只用于人工筛选和“今日推荐”，不替代平台过滤。
// 评分强调可读性、时效和事件价值，来源仅作为轻微可靠性修正，避免“有图就重点”。
const SOURCE_TRUST = { 'ref-gcores': 6, 'ref-gamersky': 6, 'ref-steam': 5, 'ref-taptap': 5, 'ref-haoyou': 4 };
function normalizeGameKey(value = '') {
  return String(value).toLowerCase()
    .replace(/[《》【】\[\]()（）\s·:：,，.!！?？'"-]/g, '')
    // “盗墓笔记：启程-预下载”与“盗墓笔记：启程”是同一个作品；
    // 此处只影响去重和跨平台热度归并，不改变页面展示名称。
    .replace(/(预下载|预载|预约中|版本预约|体验服|测试服|先遣服|官服|国际服|渠道服)$/g, '')
    .replace(/(手游|游戏|官方|最新版|测试|预约)$/g, '')
    .slice(0, 40);
}
function eventKind(article) {
  const text = `${article.category || ''} ${article.title || ''}`;
  if (/热玩榜|畅销榜|榜单/.test(text)) return 'chart';
  if (/联动/.test(text)) return 'collab';
  if (/版本|更新|补丁|赛季|活动/.test(text)) return 'update';
  if (/测试|公测|内测|首发|预约/.test(text)) return 'test';
  if (/上线|发售|预购|预售/.test(text)) return 'release';
  return 'news';
}
function enrichBriefMeta(rows) {
  // 同一游戏在 TapTap 和好游快爆的当前候选中同时出现，是比单个平台短内容更可靠的
  // 热度交叉信号。它只奖励手游，且与榜单/IP 加分共用 +18 总上限。
  const mobilePlatformHits = new Map();
  for (const article of rows) {
    if (!MOBILE_SOURCES.has(article.source_id)) continue;
    const key = normalizeGameKey(article.game_name || '');
    if (!key) continue;
    const sources = mobilePlatformHits.get(key) || new Set();
    sources.add(article.source_id);
    mobilePlatformHits.set(key, sources);
  }
  const decorated = rows.map(article => {
    const facts = getFacts(article);
    const paragraphLength = (() => { try { return JSON.parse(article.paragraphs || '[]').join('').length; } catch { return 0; } })();
    const images = getArticleImages(article);
    const imageMeta = (() => { try { return JSON.parse(article.images_json || '[]'); } catch { return []; } })();
    const localImageCount = imageMeta.filter(image => String(image.src || '').startsWith('/crawler-assets/')).length;
    const platformType = MOBILE_SOURCES.has(article.source_id) ? 'mobile' : PC_SOURCES.has(article.source_id) ? 'pc' : 'other';
    const contentScore = paragraphLength >= 1200 ? 30 : paragraphLength >= 600 ? 26 : paragraphLength >= 280 ? 21 : paragraphLength >= 120 ? 14 : paragraphLength >= 80 ? 9 : paragraphLength >= 40 ? 4 : 0;
    const visualScore = Math.min(15, (images.length ? 6 : 0) + Math.min(6, images.length * 2) + Math.min(3, localImageCount));
    const eventValue = ({ collab: 15, update: 13, release: 13, test: 11, chart: 10, news: 7 })[eventKind(article)] || 5;
    const timestamp = articleTimeValue(article);
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const freshness = timestamp === Number.MAX_SAFE_INTEGER ? 2 : timestamp < now.getTime() ? 0 : timestamp <= now.getTime() + 24 * 3600 * 1000 ? 14 : timestamp <= now.getTime() + 7 * 24 * 3600 * 1000 ? 10 : 6;
    const mobilePriority = getMobilePrioritySignals({ sourceId: article.source_id, title: article.title, gameName: article.game_name, facts });
    // articles.score 已包含同一套手游热度/IP 加成；质量层单独展示该加成时扣回，
    // 防止“榜位/IP”在 qualityScore 内重复累计。
    const crawlerScore = Math.min(12, Math.max(0, Number(article.score || 0) - 55 - mobilePriority.totalBoost));
    const hasStructuredContent = Array.isArray(facts.gcoresLayout) && facts.gcoresLayout.length
      || Array.isArray(facts.gamerskyLayout) && facts.gamerskyLayout.length
      || Array.isArray(facts.taptapEvents) && facts.taptapEvents.some(event => event?.blocks?.length);
    const scheduledGame = ['release', 'test'].includes(eventKind(article)) && timestamp !== Number.MAX_SAFE_INTEGER && timestamp >= now.getTime();
    const readable = paragraphLength >= 80 || hasStructuredContent || eventKind(article) === 'chart' || scheduledGame;
    const gameKey = normalizeGameKey(article.game_name || '');
    const crossPlatformSources = mobilePlatformHits.get(gameKey)?.size || 0;
    const crossPlatformBoost = crossPlatformSources >= 2 ? 5 : 0;
    const relevanceBoost = Math.min(18, mobilePriority.totalBoost + crossPlatformBoost);
    const priorityReasons = [...mobilePriority.reasons];
    if (crossPlatformBoost) priorityReasons.push('TapTap + 好游快爆当前均有候选 +5');
    const qualityScore = Math.min(100, Math.round((SOURCE_TRUST[article.source_id] || 3) + contentScore + visualScore + eventValue + freshness + crawlerScore + relevanceBoost));
    const isSteamChart = article.source_id === 'ref-steam' && ['most_played', 'top_selling_cn'].includes(facts.steamList);
    const hasRankMomentum = Boolean(facts.steamRankNewEntry) || Number(facts.steamRankGain || 0) > 0;
    const basePriority = isSteamChart
      ? (hasRankMomentum ? '重点' : '可选')
      : qualityScore >= 74 && readable && (images.length > 0 || eventKind(article) === 'chart')
        ? '重点'
        : qualityScore >= 55 && readable
          ? '可选'
          : '观察';
    const kind = eventKind(article);
    const dateKey = articleTimeValue(article) === Number.MAX_SAFE_INTEGER ? String(article.date_text || '').slice(0, 12) : new Date(articleTimeValue(article)).toISOString().slice(0, 10);
    const dedupeKey = gameKey && !['chart', 'news'].includes(kind) ? `${gameKey}:${kind}:${dateKey}` : '';
    return { ...article, _briefMeta: { platformType, qualityScore, priority: basePriority, paragraphLength, imageCount: images.length, localImageCount, eventKind: kind, freshness, contentScore, visualScore, eventValue, mobileHeatBoost: Math.min(15, mobilePriority.heatBoost + crossPlatformBoost), crossPlatformBoost, ipBoost: mobilePriority.ipBoost, relevanceBoost, priorityReasons, ipName: mobilePriority.ipName, readable, dedupeKey } };
  });
  const winner = new Map();
  for (const article of decorated) {
    const key = article._briefMeta.dedupeKey;
    if (!key) continue;
    const current = winner.get(key);
    if (!current || article._briefMeta.qualityScore > current._briefMeta.qualityScore) winner.set(key, article);
  }
  return decorated.map(article => {
    const facts = getFacts(article);
    const primary = !article._briefMeta.dedupeKey || winner.get(article._briefMeta.dedupeKey)?.id === article.id;
    const priority = primary ? article._briefMeta.priority : '观察';
    return { ...article, facts: JSON.stringify({ ...facts, briefMeta: { ...article._briefMeta, priority, dedupePrimary: primary, duplicateOf: primary ? '' : winner.get(article._briefMeta.dedupeKey)?.id || '' } }) };
  });
}
function recordSteamRankSnapshots(rows) {
  const dir = 'E:/新建文件夹/Codex-GPT/GameNews/data/crawler/rank-history/steam';
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const previousFile = fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < today).sort().at(-1);
  const previous = previousFile ? JSON.parse(fs.readFileSync(`${dir}/${previousFile}`, 'utf8')) : [];
  const hasBaseline = previous.length > 0;
  const previousMap = new Map(previous.map(item => [`${item.list}:${item.appId || item.gameName}`, item.rank]));
  const snapshot = [];
  const result = rows.map(article => {
    if (article.source_id !== 'ref-steam') return article;
    const facts = getFacts(article); const list = facts.steamList;
    if (!['most_played', 'top_selling_cn'].includes(list)) return article;
    const rank = Number(facts.steamRankCurrent || 0); const appId = facts.steamAppId || '';
    const previousRank = previousMap.get(`${list}:${appId || article.game_name}`) || 0;
    snapshot.push({ list, appId, gameName: article.game_name, rank });
    return { ...article, facts: JSON.stringify({ ...facts, steamRankPrevious: previousRank || undefined, steamRankGain: previousRank ? previousRank - rank : 0, steamRankBaselineKnown: hasBaseline, steamRankNewEntry: hasBaseline && !previousRank }) };
  });
  fs.writeFileSync(`${dir}/${today}.json`, JSON.stringify(snapshot, null, 2));
  return result;
}
displayArts = recordSteamRankSnapshots(enrichBriefMeta(displayArts));

const Q = { verified:'已验证', ok:'可用', needs_review:'待审', low:'低质', low_quality:'低质', failed:'失败', pending:'未处理' };
const SOURCE_PAGES = {
  'ref-haoyou': [{url:'https://www.3839.com/timeline.html', label:'时间线'}],
  'ref-taptap': [{url:'https://www.taptap.cn/forum/hot/hashtags', label:'热榜话题'},{url:'https://www.taptap.cn/upcoming', label:'即将上线'},{url:'https://www.taptap.cn/top/download/new', label:'新品榜（今日）'},{url:'https://www.taptap.cn/top/in-app-event-reserve', label:'新版本/活动入口'}],
  'ref-gamersky': [{url:'https://www.gamersky.com/news/', label:'资讯'}],
  'ref-gcores': [{url:'https://www.gcores.com/news', label:'资讯'}],
  'ref-steam': [{url:'https://store.steampowered.com/api/featuredcategories', label:'新游 API'},{url:'https://store.steampowered.com/search/?filter=globaltopsellers&l=schinese', label:'Top Sellers'}],
};

function guessSourcePage(detailUrl, sourceId) {
  const pages = SOURCE_PAGES[sourceId] || [];
  for (const p of pages) {
    const u = new URL(p.url);
    if (detailUrl.includes(u.hostname) && detailUrl.includes('bbs') && p.label==='热点') return p;
    if (detailUrl.includes('act.') && p.label==='时间线') return p;
    if (detailUrl.includes('taptap.cn/forum') && p.label==='热榜话题') return p;
    if (detailUrl.match(/taptap\.cn\/app\/\d+\/?$/) && p.label==='即将上线') return p;
    if (detailUrl.includes('taptap.cn/app/') && detailUrl.includes('/game-event') && p.label==='新版本/活动入口') return p;
    if (detailUrl.includes('taptap.cn/app-calendar') && p.label==='日历') return p;
    if (detailUrl.includes('store.steampowered') && p.label==='新游 API') return p;
    if (detailUrl.includes('9game.cn/news') && p.label==='新闻') return p;
    if (detailUrl.includes('9game.cn/kc') && p.label==='开测表') return p;
  }
  return pages[0] || null;
}

function dashboardBadge(article = {}) {
  const decision = projectionDecisionFor(article.id, projection.audit);
  if (decision.selected) {
    return `<small class="projection-picked">Dashboard · ${escapeHtml(decision.channels.join(' / '))}${article.projectionForced ? ' · 补回' : ''}</small>`;
  }
  return '<small class="projection-audit">RAW 验收候选</small>';
}

function buildTable(articles, label, startIdx, options = {}) {
  if (!articles.length) return { html: '', idx: startIdx };
  const showContent = !options.hideContent;
  let rows = '';
  const modals = [];
  let junk = 0;
  articles.forEach((a, i) => {
    const idx = startIdx + i + 1;
    let paraText = '';
    try {
      const p = JSON.parse(a.paragraphs||'[]');
      const isTapTapUpcoming = a.source_id === 'ref-taptap' && /\/app\/\d+\/?$/.test(a.detail_url || '');
       const sourceText = isTapTapUpcoming ? p.slice(0, 8).join('\n\n') : (p[0] || '');
       paraText = sourceText.replace(/<[^>]+>/g,'').slice(0, isTapTapUpcoming ? 1200 : 120);
    } catch {}
    let steamTags = '';
    let potentialScore = '';
    let tagStatus = '';
    let taptapTags = [];
    const facts = getFacts(a);
    try {
      steamTags = (facts.steamTags || []).join(' / ');
      taptapTags = facts.taptapTags || [];
      potentialScore = facts.potentialScore ?? '';
      tagStatus = facts.tagStatus || 'unknown';
    } catch {}
    const steamNoise = a.source_id === 'ref-steam' && !steamFilter(a.title || a.game_name || '');
    // 好游已在来源解析和详情页阶段完成专用过滤；不能再用通用正文噪音规则，
    // 否则“送2600限时三角券”这类游戏名会被误判为抽奖/促销噪音。
    // “抽奖”出现在游戏玩法介绍中时不是垃圾内容；仅拦截明确的营销/转发语境。
    const giveawaySpam = /(?:参与|转发|评论|留言|分享|关注|预约).{0,10}(?:抽奖|抽取|开奖)|(?:抽奖|开奖).{0,14}(?:福利|奖品|礼包|周边|外设|资格|活动)/i;
    const genericJunk = /关于我们|网站地图|玩家客服|帐号申诉|云游戏平台|送\d+限时|试玩投票|活动投票|平台公告/i.test(paraText) || giveawaySpam.test(`${a.title || ''}\n${paraText}`) || /金海豚|专项公告|排行.{0,4}前十|不容错过|好玩的游戏/i.test(a.title||'');
    const isJunk = a.source_id === 'ref-haoyou' ? false : (steamNoise || genericJunk);
    if (isJunk) junk++;
    const cls = isJunk ? ' class="jar"' : '';
    const sp = guessSourcePage(a.detail_url, a.source_id);
    const spLink = sp ? `<a href="${sp.url}" target="_blank" title="${sp.label}">${sp.label}</a>` : '';
    const imgLink = a.image_url ? ` <a href="${a.image_url}" target="_blank">图片</a>` : '';
    const thumbnail = getArticleImages(a)[0] || rawImageSrc(a.image_url, a.source_id);
    const hotImage = ['ref-steam', 'ref-taptap', 'ref-haoyou'].includes(a.source_id) && thumbnail
      ? `<br><img src="${escapeHtml(thumbnail)}" alt="缩略图" style="width:96px;max-height:64px;object-fit:cover;border-radius:3px">` : '';
    const tagHint = tagStatus === 'fetch_failed' ? '标签抓取失败' : tagStatus === 'no_gameplay_tags' || tagStatus === 'no_tags' ? '无玩法标签' : tagStatus === 'unknown' ? '历史记录未判定' : '';
    const haoyouTags = Array.isArray(facts.haoyouTags) ? facts.haoyouTags : [];
    const tagCell = a.source_id === 'ref-steam' ? `<td class="tags">${steamTags || `(${tagHint || '无玩法标签'})`}${tagHint && steamTags ? `<br><small>${tagHint}</small>` : ''}${potentialScore !== '' ? `<br><small>潜力门槛 ${potentialScore}</small>` : ''}</td>` : a.source_id === 'ref-taptap' && /\/app\/\d+\/?$/.test(a.detail_url || '') ? `<td class="tags">${taptapTags.length ? taptapTags.join(' / ') : (tagStatus === 'fetch_failed' ? '标签抓取失败' : '无玩法标签')}</td>` : a.source_id === 'ref-haoyou' ? `<td class="tags">${haoyouTags.length ? haoyouTags.join(' / ') : '—'}</td>` : '<td class="tags">—</td>';
    const isTapTapUpcoming = a.source_id === 'ref-taptap' && /\/app\/\d+\/?$/.test(a.detail_url || '');
    let contentCell = `<td class="p">${escapeHtml(paraText||'(无内容)')}</td>`;
    if (isTapTapUpcoming) {
      const modalId = `tap-upcoming-${idx}`;
      const paragraphs = (() => { try { return JSON.parse(a.paragraphs || '[]').filter(Boolean); } catch { return []; } })();
      const images = getArticleImages(a);
      contentCell = `<td class="p"><button class="event-open-btn" onclick="openEventModal('${modalId}')">查看完整内容</button></td>`;
      modals.push(`<div class="event-modal" id="${modalId}" aria-hidden="true"><div class="event-modal-backdrop" onclick="closeEventModal('${modalId}')"></div><div class="event-modal-panel" role="dialog" aria-modal="true"><button class="event-modal-close" onclick="closeEventModal('${modalId}')">×</button><h3>${escapeHtml(a.game_name || a.title || '-')} · 首发/即将上线</h3><div class="event-modal-meta">${escapeHtml(a.date_text || '')}</div><div class="event-modal-text">${paragraphs.map(item => `<div class="detail-paragraph">${escapeHtml(item)}</div>`).join('') || escapeHtml(paraText || '(无内容)')}</div><div class="event-modal-images detail-images">${images.map(url => `<a href="${escapeHtml(url)}" target="_blank"><img src="${escapeHtml(url)}" alt="游戏图片"></a>`).join('')}</div><div class="event-modal-links"><a href="${escapeHtml(a.detail_url)}" target="_blank">打开游戏详情</a></div></div></div>`);
    }
    const isSteamNew = a.source_id === 'ref-steam' && facts.steamList === 'new';
    if (isSteamNew) {
      const modalId = `steam-intro-${idx}`;
      const paragraphs = (() => { try { return JSON.parse(a.paragraphs || '[]').filter(Boolean); } catch { return []; } })();
      const intro = String(facts.steamDescriptionSnippet
        || paragraphs.find(item => !/^\s*关于此游戏/u.test(String(item || '')) && String(item || '').trim().length >= 20)
        || paragraphs[0] || paraText || '').trim();
      const images = getArticleImages(a);
      contentCell = `<td class="p"><button class="event-open-btn" onclick="openEventModal('${modalId}')">查看游戏简介</button></td>`;
      modals.push(`<div class="event-modal" id="${modalId}" aria-hidden="true"><div class="event-modal-backdrop" onclick="closeEventModal('${modalId}')"></div><div class="event-modal-panel" role="dialog" aria-modal="true"><button class="event-modal-close" onclick="closeEventModal('${modalId}')">×</button><h3>${escapeHtml(a.game_name || a.title || '-')} · 游戏简介</h3><div class="event-modal-meta">${escapeHtml(a.date_text || '')}</div><div class="event-modal-text"><div class="detail-paragraph">${escapeHtml(intro || '(无内容)')}</div></div><div class="event-modal-images detail-images">${images.map(url => `<a href="${escapeHtml(url)}" target="_blank"><img src="${escapeHtml(url)}" alt="Steam 游戏封面"></a>`).join('')}</div><div class="event-modal-links"><a href="${escapeHtml(a.detail_url)}" target="_blank">打开 Steam 商店页</a></div></div></div>`);
    }
    const isHaoyou = a.source_id === 'ref-haoyou';
    if (isHaoyou && showContent && facts.haoyouKind !== 'update') {
      const modalId = `haoyou-detail-${idx}`;
      const intro = String(facts.haoyouIntro || '').trim();
      const introHtml = String(facts.haoyouIntroHtml || '').trim();
      const paragraphs = (() => { try { return JSON.parse(a.paragraphs || '[]').filter(Boolean); } catch { return []; } })();
      const fullText = facts.haoyouKind === 'update' ? (facts.haoyouUpdateContent || paragraphs.join('\n\n')) : (intro || paragraphs.join('\n\n'));
      const images = getArticleImages(a);
      const modalLabel = facts.haoyouKind === 'update' ? '更新内容' : (facts.haoyouIntroTitle || '游戏介绍');
      contentCell = `<td class="p"><button class="event-open-btn" onclick="openEventModal('${modalId}')">查看完整内容</button></td>`;
      const richBody = introHtml ? `<div class="haoyou-rich-content">${renderRichHtml(introHtml)}</div>` : `<div class="event-modal-text">${escapeHtml(fullText || '(无内容)')}</div>`;
      modals.push(`<div class="event-modal" id="${modalId}" aria-hidden="true"><div class="event-modal-backdrop" onclick="closeEventModal('${modalId}')"></div><div class="event-modal-panel" role="dialog" aria-modal="true"><button class="event-modal-close" onclick="closeEventModal('${modalId}')">×</button><h3>${escapeHtml(a.game_name || '-')} · ${escapeHtml(modalLabel)}</h3><div class="event-modal-meta">${escapeHtml(a.date_text || '')}</div>${facts.haoyouIntroTitle ? `<div class="event-layout-module"><h4>${escapeHtml(facts.haoyouIntroTitle)}</h4></div>` : ''}${richBody}<div class="event-modal-images detail-images">${images.map(url => `<a href="${escapeHtml(url)}" target="_blank"><img src="${escapeHtml(url)}" alt="好游快爆图片"></a>`).join('')}</div><div class="event-modal-links"><a href="${escapeHtml(a.detail_url)}" target="_blank">打开详情页</a></div></div></div>`);
    }
    rows += `<tr${cls}><td class="n">${idx}</td><td class="sc">${a.score||'?'}</td><td class="qz ${a.quality||'pending'}">${Q[a.quality]||a.quality||'未处理'}</td><td class="g">${escapeHtml(a.game_name||'-')}${dashboardBadge(a)}</td><td class="date">${escapeHtml(a.date_text||'-')}</td>${tagCell}<td class="t">${escapeHtml((a.title||'').slice(0,80))}${isJunk?' <span class="junk">🚫</span>':''}</td>${showContent ? contentCell : ''}<td class="u">${hotImage}<a href="${a.detail_url}" target="_blank">详情</a>${spLink}${imgLink}</td></tr>`;
  });
  const contentHeader = articles.some(article => article.source_id === 'ref-haoyou') ? '内容' : '内容（前120字）';
  const html = `<div class="subhead">📋 ${label}（${articles.length}篇，🚫${junk}）</div><table><tr><th>#</th><th>评分</th><th>质量</th><th>游戏名</th><th>时间</th><th>游戏标签/门槛</th><th>标题</th>${showContent ? `<th>${contentHeader}</th>` : ''}<th>链接</th></tr>${rows}</table>`;
  return { html: html + modals.join(''), idx: startIdx + articles.length, junk };
}

function buildUnifiedNewsTable(articles, label) {
  const rows = [];
  const modals = [];
  for (const [index, article] of articles.entries()) {
    const modalId = `news-detail-${article.source_id}-${index + 1}`;
    const paragraphs = (() => { try { return JSON.parse(article.paragraphs || '[]').filter(Boolean); } catch { return []; } })();
    const images = getArticleImages(article);
    const isGcores = article.source_id === 'ref-gcores';
    const isGamersky = article.source_id === 'ref-gamersky';
    const contentLayout = isGcores ? renderGcoresLayout(article, paragraphs, images) : isGamersky ? renderGamerskyLayout(article) : '';
    const fallbackContent = `<div class="event-modal-text">${paragraphs.map(item => `<div class="detail-paragraph">${escapeHtml(item)}</div>`).join('') || '(无内容)'}</div><div class="event-modal-images detail-images">${images.map(url => `<a href="${escapeHtml(url)}" target="_blank"><img src="${escapeHtml(url)}" alt="资讯图片"></a>`).join('')}</div>`;
    rows.push(`<tr><td class="g">${escapeHtml(article.game_name || '-')}${dashboardBadge(article)}</td><td class="date">${escapeHtml(article.date_text || '-')}</td><td class="t"><a href="${escapeHtml(article.detail_url)}" target="_blank">${escapeHtml(article.title || '-')}</a></td><td class="p"><button class="event-open-btn" onclick="openEventModal('${modalId}')">查看完整内容</button></td></tr>`);
    modals.push(`<div class="event-modal" id="${modalId}" aria-hidden="true"><div class="event-modal-backdrop" onclick="closeEventModal('${modalId}')"></div><div class="event-modal-panel" role="dialog" aria-modal="true"><button class="event-modal-close" onclick="closeEventModal('${modalId}')">×</button><h3>${escapeHtml(article.game_name || '-')} · ${escapeHtml(article.title || '-')}</h3><div class="event-modal-meta">${escapeHtml(article.date_text || '')}</div>${contentLayout || fallbackContent}<div class="event-modal-links"><a href="${escapeHtml(article.detail_url)}" target="_blank">打开原文</a></div></div></div>`);
  }
  if (!rows.length) return '';
  return `<div class="subhead">📋 ${label}（${rows.length}篇）</div><table><tr><th>游戏名</th><th>时间</th><th>标题</th><th>内容</th></tr>${rows.join('')}</table>${modals.join('')}`;
}

function renderEventLayout(event, fallbackText = '') {
  const blocks = Array.isArray(event.blocks) ? event.blocks : [];
  if (!blocks.length) {
    const images = (event.images || []).map(item => item.url).filter(Boolean);
    return `<div class="event-modal-text">${escapeHtml(fallbackText || event.summary || '(无内容)')}</div><div class="event-modal-images">${images.map(url => `<a href="${escapeHtml(url)}" target="_blank"><img src="${escapeHtml(url)}" alt="活动缩略图"></a>`).join('')}</div>`;
  }
  return `<div class="event-layout">${blocks.map(block => `<section class="event-layout-module"><h4>${escapeHtml(block.title || '内容')}</h4>${(block.items || []).map(item => `<div class="event-layout-item">${item.title ? `<h5>${escapeHtml(item.title)}</h5>` : ''}${item.content ? `<div class="event-layout-text">${escapeHtml(item.content)}</div>` : ''}${(item.images || []).map(image => `<a href="${escapeHtml(image.url)}" target="_blank"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.label || '活动图片')}"></a>`).join('')}</div>`).join('')}</section>`).join('')}</div>`;
}

function buildEventTable(articles, label, startIdx) {
  const rows = [];
  const modals = [];
  for (const article of articles) {
    const facts = getFacts(article);
    for (const event of facts.taptapEvents || []) {
      const rowNumber = startIdx + rows.length + 1;
      const eventId = `tap-event-${rowNumber}`;
      const fullText = (event.paragraphs || []).join('\n\n') || event.summary || '(无内容)';
      const preview = fullText.slice(0, 180);
      const image = event.images?.[0]?.url || article.image_url || '';
      const eventImages = (event.images || []).map(item => item.url).filter(Boolean);
      const eventLayout = renderEventLayout(event, fullText);
      rows.push(`<tr><td class="n">${rowNumber}</td><td class="g">${escapeHtml(article.game_name || '-')}</td><td>${escapeHtml(event.kind || 'event')}</td><td class="t">${escapeHtml(event.title || article.title || '-')}</td><td class="date">${escapeHtml(event.status || article.date_text || '-')}</td><td class="p event-text"><button class="event-open-btn" onclick="openEventModal('${eventId}')">查看完整内容</button></td><td class="u">${image ? `<a href="${escapeHtml(image)}" target="_blank"><img src="${escapeHtml(image)}" alt="缩略图" style="width:120px;max-height:72px;object-fit:cover;border-radius:3px"></a>` : ''}<br><a href="${escapeHtml(event.url || article.detail_url)}" target="_blank">活动详情</a><br><a href="${escapeHtml(article.detail_url)}" target="_blank">游戏页</a></td></tr>`);
      modals.push(`<div class="event-modal" id="${eventId}" aria-hidden="true"><div class="event-modal-backdrop" onclick="closeEventModal('${eventId}')"></div><div class="event-modal-panel" role="dialog" aria-modal="true"><button class="event-modal-close" onclick="closeEventModal('${eventId}')">×</button><h3>${escapeHtml(article.game_name || '-')} · ${escapeHtml(event.title || article.title || '-')}</h3><div class="event-modal-meta">${escapeHtml(event.status || article.date_text || '')} · ${escapeHtml(event.kind || 'event')}</div>${eventLayout}<div class="event-modal-links"><a href="${escapeHtml(event.url || article.detail_url)}" target="_blank">打开活动详情</a><a href="${escapeHtml(article.detail_url)}" target="_blank">打开游戏页</a></div></div></div>`);
    }
  }
  if (!rows.length) return { html: '', idx: startIdx };
  return { html: `<div class="subhead event-head">🆕 ${label}（${rows.length}条）</div><table><tr><th>#</th><th>游戏名</th><th>类型</th><th>事件标题</th><th>时间/状态</th><th>内容</th><th>缩略图/链接</th></tr>${rows.join('')}</table>${modals.join('')}`, idx: startIdx + rows.length };
}

function buildSteamRisingTable(articles, label, { baseline = false } = {}) {
  const rows = articles.map((article, index) => {
    const facts = getFacts(article);
    const tags = Array.isArray(facts.steamTags) ? facts.steamTags.join(' / ') : '—';
    const previous = Number(facts.steamRankPrevious || 0);
    const current = Number(facts.steamRankCurrent || 0);
    const gain = Number(facts.steamRankGain || 0);
    const thumbnail = article.image_url ? `<a href="${escapeHtml(article.image_url)}" target="_blank"><img src="${escapeHtml(article.image_url)}" alt="缩略图" style="width:96px;max-height:64px;object-fit:cover;border-radius:3px"></a>` : '';
    return `<tr><td class="n">${index + 1}</td><td class="g">${escapeHtml(article.game_name || '-')}</td><td class="tags">${escapeHtml(tags || '—')}</td><td class="rank-old">${baseline ? '—' : (previous || '-')}</td><td class="rank-current">${current || '-'}</td><td class="rank-gain">${baseline ? '—' : `+${gain}`}</td><td class="t">${escapeHtml(article.title || '-')}</td><td class="u">${thumbnail}<br><a href="${escapeHtml(article.detail_url)}" target="_blank">详情</a></td></tr>`;
  }).join('');
  const note = baseline ? '<div class="empty-note">首期仅有本期榜单，先展示当前排名前五；下一次成功快照后自动切换为排名增长前五。</div>' : '';
  return `<div class="subhead">📈 ${label}（${articles.length}篇）</div>${note}<table><tr><th>#</th><th>游戏名</th><th>游戏标签</th><th>上期排名</th><th>本期排名</th><th>上升名次</th><th>标题</th><th>缩略图/链接</th></tr>${rows}</table>`;
}

function selectSteamHighlights(articles) {
  const groups = new Map();
  for (const article of articles) {
    const facts = getFacts(article);
    if (!['most_played', 'top_selling_cn'].includes(facts.steamList)) continue;
    const appId = facts.steamAppId || /\/app\/(\d+)/.exec(article.detail_url || '')?.[1] || '';
    const key = appId || normalizeGameKey(article.game_name || article.title);
    if (!key) continue;
    const rows = groups.get(key) || [];
    rows.push(article);
    groups.set(key, rows);
  }
  return [...groups.values()].map(entries => {
    const ranked = [...entries].sort((a, b) => Number(getFacts(a).steamRankCurrent || Number.MAX_SAFE_INTEGER) - Number(getFacts(b).steamRankCurrent || Number.MAX_SAFE_INTEGER));
    const primary = ranked[0];
    const bestRank = Number(getFacts(primary).steamRankCurrent || 0);
    const rankGain = Math.max(0, ...entries.map(article => Number(getFacts(article).steamRankGain || 0)));
    const isNew = entries.some(article => Boolean(getFacts(article).steamRankBaselineKnown) && Boolean(getFacts(article).steamRankNewEntry));
    const dualChart = new Set(entries.map(article => getFacts(article).steamList)).size > 1;
    if (!(isNew || rankGain >= 5 || dualChart || (bestRank > 0 && bestRank <= 5))) return null;
    const chartSummary = entries
      .sort((a, b) => String(getFacts(a).steamList).localeCompare(String(getFacts(b).steamList)))
      .map(article => `${getFacts(article).steamList === 'most_played' ? '热玩榜' : '畅销榜'} #${getFacts(article).steamRankCurrent || '—'}`)
      .join(' · ');
    return { primary, bestRank, rankGain, isNew, dualChart, chartSummary };
  }).filter(Boolean).sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.rankGain - a.rankGain || Number(b.dualChart) - Number(a.dualChart) || a.bestRank - b.bestRank).slice(0, 10);
}

function buildSteamHighlightsTable(highlights, label) {
  const rows = highlights.map(highlight => {
    const article = highlight.primary;
    const facts = getFacts(article);
    const tags = Array.isArray(facts.steamTags) && facts.steamTags.length
      ? facts.steamTags.join(' / ')
      : facts.tagStatus === 'pending_enrichment' ? '标签待补全' : '—';
    const rankChange = highlight.isNew
      ? '<span class="rank-key">重点 · 新上榜</span>'
      : highlight.rankGain > 0
        ? `<span class="rank-up">▲ +${highlight.rankGain}</span>`
        : '<span class="rank-flat">热门入选</span>';
    const image = article.image_url ? `<a href="${escapeHtml(article.image_url)}" target="_blank"><img src="${escapeHtml(article.image_url)}" alt="缩略图" style="width:96px;max-height:64px;object-fit:cover;border-radius:3px"></a>` : '';
    return `<tr><td class="rank-current">${highlight.bestRank || '—'}</td><td class="g">${escapeHtml(article.game_name || '-')}</td><td>${escapeHtml(highlight.chartSummary)}</td><td class="tags">${escapeHtml(tags)}</td><td>${rankChange}</td><td class="u">${image}<br><a href="${escapeHtml(article.detail_url)}" target="_blank">详情</a></td></tr>`;
  }).join('');
  if (!rows) return `<div class="subhead">📊 ${label}（0篇）</div><div class="empty-note">暂无符合“新上榜、排名提升至少5位、双榜在列或任一榜前5”的 Steam 游戏。</div>`;
  return `<div class="subhead">📊 ${label}（${highlights.length}篇）</div><table><tr><th>最佳排名</th><th>游戏名</th><th>榜单来源</th><th>游戏标签</th><th>入选信号</th><th>缩略图/链接</th></tr>${rows}</table>`;
}

// TapTap 独立区块：同一个来源标题下固定两张表，热榜在前、即将上线在后。
const tapTapGroups = { hot: [], upcoming: [], events: [] };
const steamGroups = { new: [], mostPlayed: [], topSellingCN: [] };
const bySource = {};
for (const a of displayArts) {
  if (a.source_id === 'ref-taptap') {
    const group = isTapTapHotSnapshot(a) ? 'hot' : isTapTapEventSnapshot(a) ? 'events' : 'upcoming';
    tapTapGroups[group].push(a);
    continue;
  }
  if (a.source_id === 'ref-steam') {
    const facts = getFacts(a);
    if (facts.steamList === 'new') steamGroups.new.push(a);
    if (facts.steamList === 'most_played') steamGroups.mostPlayed.push(a);
    if (facts.steamList === 'top_selling_cn') steamGroups.topSellingCN.push(a);
    continue;
  }
  const k = a.source_name || '?';
  if (!bySource[k]) bySource[k] = { detail: [], list: [], upcoming: [], update: [], sourceId: a.source_id };
  if (a.source_id === 'ref-haoyou') {
    if (getFacts(a).haoyouKind === 'update') bySource[k].update.push(a);
    else bySource[k].upcoming.push(a);
    continue;
  }
  if (a.quality === 'pending') bySource[k].list.push(a);
  else bySource[k].detail.push(a);
}

// 即将上线是页面快照：只展示最近一次成功读取到的那一批，避免旧 App 记录和当前页面混在一起。
for (const groupName of ['upcoming', 'events']) {
  if (!tapTapGroups[groupName].length) continue;
  const latestAt = tapTapGroups[groupName].reduce((latest, row) => {
    const current = new Date(row.discovered_at || 0).getTime();
    return current > latest.time ? { value: row.discovered_at, time: current } : latest;
  }, { value: "", time: 0 }).value;
  // 一次批量抓取的多条记录可能跨越数秒写入，不能要求 discovered_at 完全相同。
  // 以最新记录向前 2 分钟作为同一快照批次，避免候选被截成最后一秒的少数条目。
  if (latestAt) {
    const latestTime = new Date(latestAt).getTime();
    tapTapGroups[groupName] = tapTapGroups[groupName].filter(row => {
      const current = new Date(row.discovered_at || 0).getTime();
      return current >= latestTime - 2 * 60 * 1000;
    });
  }
}

let sections = '';
let totalJunk = 0;
const tapLinks = '<a href="https://www.taptap.cn/forum/hot/hashtags" target="_blank" style="font-size:9px;margin:0 4px;color:#2563eb">打开热榜话题</a><a href="https://www.taptap.cn/upcoming" target="_blank" style="font-size:9px;margin:0 4px;color:#2563eb">打开即将上线</a><a href="https://www.taptap.cn/top/in-app-event-reserve" target="_blank" style="font-size:9px;margin:0 4px;color:#2563eb">打开新版本/活动入口</a>';
sections += `<details class="platform-section" open><summary>🏷 TapTap（${tapTapGroups.hot.length + tapTapGroups.upcoming.length + tapTapGroups.events.length}篇）</summary><h2>来源:${tapLinks}<div class="source-flow">热榜话题 → 前5条 Moment；即将上线 → /upcoming；新版本候选 → /top/in-app-event-reserve → App页“新版本” → 完整活动正文/缩略图</div></h2>`;
// 热榜没有发布时间；只能且必须按来源页的 item 序号（榜单原文顺序）展示。
tapTapGroups.hot = tapTapGroups.hot
  .sort((a, b) => Number(/item=(\d+)/.exec(a.detail_url || '')?.[1] || Number.MAX_SAFE_INTEGER) - Number(/item=(\d+)/.exec(b.detail_url || '')?.[1] || Number.MAX_SAFE_INTEGER));
tapTapGroups.upcoming = sortArticlesByTime(tapTapGroups.upcoming);
tapTapGroups.events = sortArticlesByTime(tapTapGroups.events);
const hotResult = buildTable(tapTapGroups.hot, '热榜话题（前5条）', 0);
const upcomingResult = buildTable(tapTapGroups.upcoming, '即将上线 / 首发（含玩法标签）', 0);
const eventResult = buildEventTable(tapTapGroups.events, '版本更新 / 活动 / 联动（独立表）', 0);
sections += hotResult.html + upcomingResult.html + eventResult.html;
sections += '</details>';
totalJunk += hotResult.junk + upcomingResult.junk;

// Steam 固定为新游与合并后的“热门 / 新上榜”两张表；原始双榜仅作为交叉信号源。
steamGroups.new = steamGroups.new.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 5);
const steamHighlights = selectSteamHighlights([...steamGroups.mostPlayed, ...steamGroups.topSellingCN]);
const steamLinks = '<a href="https://store.steampowered.com/api/featuredcategories?cc=CN&l=schinese" target="_blank" style="font-size:9px;margin:0 4px;color:#2563eb">打开中国区新游 API</a><a href="https://store.steampowered.com/charts/mostplayed?cc=CN&l=schinese" target="_blank" style="font-size:9px;margin:0 4px;color:#2563eb">打开热玩榜</a><a href="https://store.steampowered.com/charts/topselling/CN?l=schinese" target="_blank" style="font-size:9px;margin:0 4px;color:#2563eb">打开中国区畅销榜</a>';
sections += `<details class="platform-section" open><summary>🏷 Steam（${steamGroups.new.length + steamHighlights.length}篇）</summary><h2>来源:${steamLinks}<div class="source-flow">新游 API → 详情过滤 → 近14天新游前5；热玩榜与中国区畅销榜 → 商店详情补全中文名/玩法标签 → 合并去重，只保留新上榜、提升至少5位、双榜在列或任一榜前5的游戏（最多10条）。</div></h2>`;
const steamNewResult = buildTable(steamGroups.new, '新游（近14天，前5）', 0);
const steamNewHtml = steamNewResult.html || '<div class="subhead">📋 新游（近14天，前5）（0篇）</div><div class="empty-note">尚未生成新规则的新游快照。下一次 Steam 候选抓取成功后将只保留近 14 天发售、通过质量过滤的前 5 个游戏。</div>';
sections += steamNewHtml
  + buildSteamHighlightsTable(steamHighlights, '热门 / 新上榜（热玩榜 × 畅销榜，最多10条）')
  + '</details>';
totalJunk += steamNewResult.junk;

for (const [src, groups] of Object.entries(bySource)) {
  const sourcePages = SOURCE_PAGES[groups.sourceId] || [];
  const total = groups.detail.length + groups.list.length;
  const spLinks = sourcePages.map(p => `<a href="${p.url}" target="_blank" style="font-size:9px;margin:0 4px;color:#2563eb">${p.label}</a>`).join(' ');
  if (groups.sourceId === 'ref-haoyou') {
    const totalHaoyou = groups.upcoming.length + groups.update.length;
    sections += `<details class="platform-section" open><summary>🏷 ${src}（${totalHaoyou}篇）</summary><h2>来源:${spLinks}<div class="source-flow">仅使用 timeline.html；“即将上线 + 即将测试”仅保留今日及未来7日；即将更新保留今日及未来；按时间排序</div></h2>`;
    groups.upcoming = sortArticlesByTime(groups.upcoming);
    groups.update = sortArticlesByTime(groups.update);
    const upcomingResult = buildTable(groups.upcoming, '即将上线 + 即将测试', 0);
    const updateResult = buildTable(groups.update, '即将更新', 0, { hideContent: true });
    sections += upcomingResult.html + updateResult.html + '</details>';
    continue;
  }
  if (['ref-gcores', 'ref-gamersky'].includes(groups.sourceId)) {
    const unified = sortArticlesByTime([...groups.detail, ...groups.list]);
    sections += `<details class="platform-section" open><summary>🏷 ${src}（${unified.length}篇）</summary><h2>列表页:${spLinks}<div class="source-flow">仅保留今日及未来；统一字段：游戏名、时间、标题、完整内容</div></h2>${buildUnifiedNewsTable(unified, '完整游戏资讯')}</details>`;
    continue;
  }
  sections += `<details class="platform-section" open><summary>🏷 ${src}（${total}篇）</summary><h2>列表页:${spLinks}</h2>`;
  groups.detail = sortArticlesByTime(groups.detail);
  groups.list = sortArticlesByTime(groups.list);
  const detailResult = buildTable(groups.detail, '已抓详情（有正文数据）', 0);
  const listResult = buildTable(groups.list, '仅来源页（未抓详情）', 0);
  sections += detailResult.html + listResult.html;
  sections += '</details>';
  totalJunk += detailResult.junk + listResult.junk;
}

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>游戏资讯对比 — 48小时</title><style>
body{font-family:-apple-system,sans-serif;font-size:11px;max-width:1500px;margin:0 auto;padding:12px;color:#1b1f1d;background:#fafbf9}
h1{font-size:14px;margin:0 0 4px}
h2{font-size:13px;margin:20px 0 6px;color:#2c5f4b;border-bottom:2px solid #2c5f4b;padding-bottom:3px}
h2 a{color:#2563eb;font-weight:400}
.subhead{font-size:10px;font-weight:600;padding:4px 8px;margin:8px 0 2px;border-left:3px solid #2c5f4b;background:#eef6f1;color:#2c5f4b}
.subhead:nth-of-type(2){border-color:#b77200;background:#fef9ee;color:#b77200}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.04);margin-bottom:8px}
th{background:#2c5f4b;color:#fff;text-align:left;padding:5px 7px;font-size:9px}
td{padding:3px 6px;border-bottom:1px solid #eee;font-size:9px;vertical-align:top;line-height:1.45}
td a{color:#2563eb;text-decoration:none;margin:0 2px}
td a:hover{text-decoration:underline}
.n{width:28px;text-align:center;color:#999}
.sc{width:32px;text-align:center;font-weight:600}
.qz{width:44px;text-align:center;font-size:8px;font-weight:600}
.qz.verified{color:#059669}.qz.ok{color:#059669}.qz.needs_review{color:#b77200}.qz.low_quality{color:#e06060}.qz.low{color:#e06060}.qz.failed{color:#999}.qz.pending{color:#2563eb}
.t{max-width:240px}
.g{max-width:200px;word-break:break-word}
.p{max-width:420px;color:#555;white-space:pre-wrap}.event-text{min-width:420px}.tags{max-width:220px;color:#2c5f4b}.tags small{color:#999}
.event-open-btn{margin-top:5px;padding:3px 7px;border:1px solid #2c5f4b;border-radius:4px;background:#eef6f1;color:#2c5f4b;cursor:pointer;font-size:9px}.event-open-btn:hover{background:#dceee2}
.event-modal{display:none;position:fixed;inset:0;z-index:20}.event-modal.is-open{display:block}.event-modal-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.55)}.event-modal-panel{position:relative;width:min(900px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;margin:16px auto;padding:18px 20px;background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.25);color:#1b1f1d}.event-modal-close{position:absolute;right:12px;top:8px;border:0;background:transparent;font-size:24px;color:#64748b;cursor:pointer}.event-modal-panel h3{margin:0 28px 4px 0;font-size:15px;color:#2c5f4b}.event-modal-meta{font-size:10px;color:#77857c;margin-bottom:12px}.event-modal-text{white-space:pre-wrap;line-height:1.75;font-size:12px;border-top:1px solid #e8eee9;border-bottom:1px solid #e8eee9;padding:12px 0}.event-modal-images{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.event-modal-images img{width:180px;max-height:120px;object-fit:cover;border-radius:5px;border:1px solid #e5e7eb}.event-modal-links{margin-top:12px;font-size:10px}.event-modal-links a{color:#2563eb;margin-right:12px}
.detail-paragraph{white-space:pre-wrap;margin:0 0 12px;line-height:1.75}.detail-images{display:flex;flex-direction:column;align-items:flex-start}.detail-images img{width:min(520px,100%);max-height:none;object-fit:contain}.event-layout-module{margin:12px 0 18px}.event-layout-module h4{margin:0 0 10px;padding:7px 10px;border-left:4px solid #2c5f4b;background:#eef6f1;color:#2c5f4b;font-size:13px}.event-layout-item{margin:0 0 16px}.event-layout-item h5{margin:0 0 6px;font-size:12px;color:#334155}.event-layout-text{white-space:pre-wrap;line-height:1.75;font-size:12px;margin-bottom:8px}.event-layout-item img{display:block;width:min(620px,100%);max-height:none;object-fit:contain;margin:8px 0;border-radius:5px}
.gcores-rich-content{font-family:Georgia,'Noto Serif SC','Songti SC',serif;font-size:14px;line-height:2;max-width:720px;margin:0 auto;padding:16px 4px;border-top:1px solid #e8eee9;border-bottom:1px solid #e8eee9;color:#27332c}.gcores-rich-content p{margin:0 0 17px;white-space:pre-wrap}.gcores-rich-content p.is-quote{margin-left:12px;padding-left:12px;border-left:3px solid #9ab8a4;color:#3f5748}.gcores-rich-content strong{font-weight:700;color:#10251a}.gcores-rich-content em{font-style:italic}.gcores-rich-image{margin:18px 0 22px}.gcores-rich-image.is-cover{margin-top:0}.gcores-rich-image img{display:block;width:min(680px,100%);max-height:none;object-fit:contain;border-radius:4px}.gcores-rich-image figcaption{margin-top:5px;text-align:center;font:11px/1.5 -apple-system,sans-serif;color:#7a887e}.gcores-rich-embed{margin:14px 0 18px;padding:9px 12px;border-left:3px solid #6a997a;background:#f2f7f3;font:12px/1.5 -apple-system,sans-serif}.gcores-rich-embed a{color:#2563eb}
.gamersky-rich-content{max-width:720px;margin:0 auto;padding:14px 4px;border-top:1px solid #e8eee9;border-bottom:1px solid #e8eee9;color:#27332c;font-size:13px;line-height:1.9}.gamersky-rich-content p{margin:0 0 16px;white-space:pre-wrap}.gamersky-rich-image{margin:14px 0 20px}.gamersky-rich-image img{display:block;width:min(680px,100%);max-height:none;object-fit:contain;border-radius:3px}
.haoyou-rich-content{font-size:12px;line-height:1.85;padding:12px 0;border-top:1px solid #e8eee9;border-bottom:1px solid #e8eee9;white-space:normal}.haoyou-rich-content p{margin:0 0 12px}.haoyou-rich-content br{display:block;content:"";margin:6px 0}.haoyou-rich-content strong,.haoyou-rich-content b{font-weight:700;color:#243b32}.haoyou-rich-content ul,.haoyou-rich-content ol{padding-left:22px;margin:8px 0}
.u{width:52px;text-align:center;font-size:8px;white-space:nowrap}
.jar{opacity:.45;background:#fff5f5}.jar .t,.jar .p{color:#bbb !important}.jar td{color:#bbb}
.junk{color:#e06060;font-size:10px}
.rank-old,.rank-current,.rank-gain{text-align:center;font-weight:700}.rank-old{color:#64748b}.rank-current{color:#2563eb}.rank-gain{color:#059669}.empty-note{padding:9px 11px;margin-bottom:8px;border:1px dashed #cbd5e1;border-radius:5px;background:#f8fafc;color:#64748b;font-size:10px;line-height:1.6}
.summary{display:flex;gap:12px;align-items:center;padding:8px 12px;border:1px solid #e0d000;border-radius:6px;margin-bottom:8px;font-size:10px;background:#fffb}
.legend{display:flex;gap:14px;padding:6px 10px;margin-bottom:10px;font-size:9px;background:#f5f7f4;border-radius:6px}
.legend span{padding:1px 6px;border-radius:4px}
.lg-detail{background:#eef6f1;color:#2c5f4b}.lg-list{background:#fef9ee;color:#b77200}
.workflow{margin:10px 0 14px;padding:10px 12px;border:1px solid #cfe2d5;border-radius:7px;background:#f4faf6;color:#315442}
.workflow strong{display:block;margin-bottom:6px;font-size:11px}.workflow-flow{font-size:10px;line-height:1.8;word-break:break-word}.workflow-flow span{display:inline-block;padding:2px 6px;margin:2px 2px;border-radius:4px;background:#e2f0e7}.workflow-note{margin-top:6px;color:#6f8175;font-size:9px}
.source-flow{font-size:9px;font-weight:400;color:#6f8175;margin-top:4px}
.platform-section{margin:14px 0}.platform-section>summary{cursor:pointer;list-style:none;font-size:13px;font-weight:700;color:#2c5f4b;border-bottom:2px solid #2c5f4b;padding:7px 4px}.platform-section>summary::-webkit-details-marker{display:none}.platform-section>summary:before{content:'▸';display:inline-block;margin-right:6px;color:#6f8175}.platform-section[open]>summary:before{content:'▾'}
.rank-key{display:inline-block;padding:2px 5px;border-radius:3px;background:#fef3c7;color:#92400e;font-weight:700}.rank-up{color:#dc2626;font-weight:800}.rank-down{color:#2563eb;font-weight:700}.rank-flat{color:#6b7280}
.projection-picked,.projection-audit{display:block;width:max-content;max-width:100%;margin-top:3px;padding:1px 4px;border-radius:3px;font-size:8px;font-weight:600;line-height:1.35}.projection-picked{background:#e7f5ec;color:#187044}.projection-audit{background:#f1f5f9;color:#64748b}
</style></head><body>
<h1>📰 今日游戏资讯 · 48小时 · ${displayArts.length} 篇 <small style="font-weight:400;color:#999">已隐藏 ${hiddenCount + (arts.length - displayArts.length)} 条过滤项/超额项</small></h1>
<section class="workflow"><strong>统一今日简讯投影 · ${projection.audit.signature}</strong><div class="workflow-flow"><span>Dashboard 已选 ${projection.audit.selectedArticleCount} 篇文章 / ${projection.audit.selectedEntryCount} 个栏目条目</span> → <span>RAW 保留更宽的验收候选</span> → <span>RAW_ARTICLES.json 的 dashboardDecision 可查看每条是否进入 Dashboard</span></div><div class="workflow-note">Dashboard 与 RAW 共用同一套栏目投影；RAW 比 Dashboard 多出的条目并非错误，而是保留给人工复核的候选。${projectionForcedIds.length ? ` 本轮补回 ${projectionForcedIds.length} 篇 Dashboard 已选资讯，避免旧 RAW 过滤漏项。` : ''}</div></section>
<section class="workflow"><strong>TapTap 三条来源链路</strong><div class="workflow-flow"><span>热榜话题：/forum/hot/hashtags</span> → <span>按原文顺序前5条</span> → <span>游戏名 + 标题 + 正文 + 首图</span></div><div class="workflow-flow"><span>即将上线：/upcoming</span> → <span>过滤已上线/历史更新</span> → <span>游戏名 + 标签 + 上线信息 + 封面</span></div><div class="workflow-flow"><span>新版本：/top/in-app-event-reserve</span> → <span>接口候选 → 今日/未来过滤 → event_id 详情 → 版本更新 / 活动 / 联动</span></div><div class="workflow-note">新版本榜候选不单独展示；只有日期明确且详情抓取成功的条目进入正式表。</div></section>
<div class="legend"><span class="lg-detail">绿色标题 = 已抓详情（有正文）</span><span class="lg-list">橙色标题 = 仅来源页（未抓详情）</span><span>事件表 = 新版本/活动/联动完整正文</span><span>🚫 = 垃圾/低质</span></div>
${sections}
<script>
function openEventModal(id){const el=document.getElementById(id);if(el){el.classList.add('is-open');el.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';}}
function closeEventModal(id){const el=document.getElementById(id);if(el){el.classList.remove('is-open');el.setAttribute('aria-hidden','true');document.body.style.overflow='';}}
document.addEventListener('keydown',event=>{if(event.key==='Escape'){document.querySelectorAll('.event-modal.is-open').forEach(el=>closeEventModal(el.id));}});
</script>
</body></html>`;

const outDir = 'E:/新建文件夹/WorkBuddy/2026-07-30-11-37-18/output';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outDir + '/RAW_ARTICLES.html', html);
const rawData = {
  ok: true,
  generatedAt: new Date().toISOString(),
  total: displayArts.length,
  hidden: hiddenCount + (arts.length - displayArts.length),
  projection: projection.audit,
  projectionForcedIds,
  articles: displayArts.map(article => ({
    ...article,
    paragraphs: (() => { try { return JSON.parse(article.paragraphs || '[]'); } catch { return []; } })(),
    facts: getFacts(article),
    images: getArticleImages(article),
    imageItems: getArticleImageItems(article),
    dashboardDecision: projectionDecisionFor(article.id, projection.audit),
  })),
};
fs.writeFileSync(outDir + '/RAW_ARTICLES.json', JSON.stringify(rawData, null, 2));
console.log('✅', displayArts.length, 'visible articles,', new Set(displayArts.map(article => article.source_id)).size, 'platforms →', outDir + '/RAW_ARTICLES.html');
