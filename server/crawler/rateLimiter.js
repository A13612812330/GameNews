import { Firecrawl } from "firecrawl";

const MAX_C = 3;
let active = 0; const queue = [];

export function crawlTask(key, fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { active--; next(); }
    };
    if (active < MAX_C) run(); else queue.push(run);
  });
}

function next() { if (queue.length) queue.shift()(); }

const urlTasks = new Map();
/**
 * Firecrawl 兜底的硬上限。
 *
 * 2026-10-27 定位：`firecrawl.scrape()` 原本**没有任何超时**，而且它的 promise 被永久
 * 缓存在 `urlTasks` 里 —— 一旦某次 scrape 挂住，同一个 URL 之后每次都撞上同一个
 * 永不 settle 的 promise。TapTap `newDownloads` 恒为 0 条、每轮都走这条兜底，
 * 是整条抓取链路里唯一真正没有上限的 await（实测 2026-10-27 11:00 那轮它占了 185 秒）。
 * 所以这里必须给上限，并让缓存带 TTL，不能缓存一个可能永远不完成的 promise。
 */
const FIRECRAWL_TIMEOUT_MS = 60_000;
const FIRECRAWL_CACHE_TTL_MS = 10 * 60 * 1000;
const FIRECRAWL_CACHE_MAX = 50;
let fcDate = "", fcUsed = 0;
const FC_DAILY = 50;
const firecrawl = process.env.FIRECRAWL_API_KEY
  ? new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY })
  : (console.warn("[firecrawl] 未设置 FIRECRAWL_API_KEY，动态页降级路径不可用"), null);

export function canUseFirecrawl() {
  const today = new Date().toISOString().slice(0,10);
  if (fcDate !== today) { fcDate = today; fcUsed = 0; }
  return fcUsed < FC_DAILY;
}

export function recordFirecrawlUse() { fcUsed++; }

export async function firecrawlFallback(url, { waitFor = 0 } = {}) {
  if (!firecrawl || !canUseFirecrawl()) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  const cacheKey = `firecrawl:${url}:${Number(waitFor) || 0}`;
  const cached = urlTasks.get(cacheKey);
  if (cached && Date.now() - cached.at < FIRECRAWL_CACHE_TTL_MS) return cached.promise;

  const promise = scrapeWithTimeout(url, Number(waitFor) || 0);
  // 缓存只做「短时间内的热点复用」，不做永久记忆；超上限按插入顺序淘汰最旧的。
  if (urlTasks.size >= FIRECRAWL_CACHE_MAX) urlTasks.delete(urlTasks.keys().next().value);
  urlTasks.set(cacheKey, { at: Date.now(), promise });
  return promise;
}

async function scrapeWithTimeout(url, waitFor) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[firecrawl] ${String(url).slice(0, 90)} 超过 ${Math.round(FIRECRAWL_TIMEOUT_MS / 1000)}s 未返回，放弃等待`);
      resolve(null);
    }, FIRECRAWL_TIMEOUT_MS);
  });
  const scrape = (async () => {
    try {
      const options = { formats: ["html", "markdown"] };
      if (Number(waitFor) > 0) options.waitFor = Number(waitFor);
      const result = await firecrawl.scrape(url, options);
      recordFirecrawlUse();
      return result?.html || result?.data?.html || result?.markdown || result?.data?.markdown || null;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([scrape, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
