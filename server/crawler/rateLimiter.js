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
  if (urlTasks.has(cacheKey)) return urlTasks.get(cacheKey);

  const task = (async () => {
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
  urlTasks.set(cacheKey, task);
  return task;
}
