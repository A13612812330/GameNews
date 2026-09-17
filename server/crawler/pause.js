import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const CRAWLER_PAUSE_FLAG = path.join(root, "data", "crawler", "PAUSED");

export function isCrawlerPaused() {
  return (
    process.env.GAME_NEWS_CRAWLER_PAUSED !== "0" &&
    fs.existsSync(CRAWLER_PAUSE_FLAG)
  );
}

export function crawlerPauseMessage() {
  return "爬虫当前处于维护暂停状态，服务仍在运行；完成规则优化后再恢复抓取。";
}

export function getCrawlerPauseInfo() {
  const paused = isCrawlerPaused();
  let since = null;
  if (paused) {
    try {
      since = fs.statSync(CRAWLER_PAUSE_FLAG).mtime.toISOString();
    } catch {}
  }
  return { paused, message: paused ? crawlerPauseMessage() : "", since };
}

export function assertCrawlerActive() {
  if (isCrawlerPaused()) {
    const error = new Error(crawlerPauseMessage());
    error.code = "CRAWLER_PAUSED";
    throw error;
  }
}
