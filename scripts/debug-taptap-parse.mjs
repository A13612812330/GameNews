import { fetchHtml } from "../server/crawler/fetcher.js";
import { firecrawlFallback } from "../server/crawler/rateLimiter.js";
import { parseList } from "../server/crawler/parser.js";
import { contentFilter, hashtagFilter } from "../server/crawler/platforms/taptap.js";
import * as cheerio from "cheerio";

for (const [urlType, url] of [["hashtags", "https://www.taptap.cn/forum/hot/hashtags"], ["upcoming", "https://www.taptap.cn/upcoming"]]) {
 const html = await fetchHtml(url, { dynamic: urlType === "hashtags" || urlType === "upcoming" });
  const retryHtml = urlType === "hashtags" && !/\/moment\/\d{8,}/.test(html)
    ? await fetchHtml(`${url}?_crawl=${Date.now()}`, { dynamic: true })
    : html;
  let sourceHtml = retryHtml;
  if (urlType === "hashtags" && !/\/moment\/\d{8,}/.test(sourceHtml)) sourceHtml = await firecrawlFallback(url) || sourceHtml;
  const rows = parseList(sourceHtml, { id: "ref-taptap", name: "TapTap", urlType }, url);
  const $ = cheerio.load(sourceHtml);
  if (urlType === "hashtags") {
    console.log(JSON.stringify({ momentLinks: $("a[href*='/moment/']").length, cardClasses: $("a[href*='/moment/']").slice(0, 3).map((_, el) => $(el).parents().slice(0, 6).map((__, node) => `${node.tagName}.${$(node).attr("class") || ""}`).get()).get() }, null, 2));
  }
  const samples = $(urlType === "hashtags" ? "a[href*='/moment/']" : "a[href*='/app/']").map((_, el) => {
    const title = $(el).find(".moment-article__summary--title,[itemprop='name']").first().text().trim() || $(el).text().replace(/\s+/g, " ").trim();
    const card = $(el).parents(".moment-feed-list-item,.moment-card,[class*=moment-article],[class*=moment-item]").first();
    const author = card.find(".user-name,.user-name__text,[itemprop='author']").first().text().replace(/\s+/g, " ").trim();
    const honor = card.find(".user-name__honor-title,.user-name__honor-title-wrapper").first().text().replace(/\s+/g, " ").trim();
    const body = $(el).find(".moment-article__summary--content,[itemprop='text']").first().text().replace(/\s+/g, " ").trim();
    const ancestors = urlType === "hashtags" ? $(el).parents().slice(0, 8).map((_, node) => ({ tag: node.tagName, className: $(node).attr("class") || "", text: $(node).text().replace(/\s+/g, " ").trim().slice(0, 180) })).get() : [];
    return { title, body, author, honor, accepted: urlType === "hashtags" ? hashtagFilter(title, body, author, honor) : contentFilter(title), ancestors };
  }).get().filter(x => x.title).slice(0, 20);
  console.log(JSON.stringify({ urlType, htmlLength: sourceHtml.length, count: rows.length, samples, rows: rows.slice(0, 10) }, null, 2));
}
