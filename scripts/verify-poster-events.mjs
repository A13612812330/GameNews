import fs from "node:fs/promises";
import { buildDailyPosterHtml } from "../server/dailyPoster.js";

const payload = JSON.parse((await fs.readFile(new URL("../data/tmp-today-response.json", import.meta.url), "utf8")).replace(/^\uFEFF/u, ""));
const mobileRows = (payload.articles || []).filter((article) => ["ref-taptap", "ref-haoyou"].includes(article.source_id));
const eventRows = mobileRows.filter((article) => article.source_id === "ref-haoyou"
  ? article.facts?.haoyouKind === "update"
  : /\/game-event\b/u.test(article.detail_url || ""));
const tapTapEvent = eventRows.find((article) => article.source_id === "ref-taptap");
const haoyouEvent = eventRows.find((article) => article.source_id === "ref-haoyou");
if (!tapTapEvent || !haoyouEvent) throw new Error("缺少 TapTap 或好游快爆版本更新验证样本");

const html = buildDailyPosterHtml([tapTapEvent, haoyouEvent], {
  assetBase: "http://127.0.0.1:64424",
  generatedAt: new Date("2026-08-12T10:30:00+08:00"),
});
await fs.writeFile(new URL("../output/poster-event-validation.html", import.meta.url), html, "utf8");

const haoyouMarkupStart = html.indexOf('<div class="poster-event-column poster-event-column--haoyou">');
const haoyouMarkup = haoyouMarkupStart >= 0 ? html.slice(haoyouMarkupStart, html.indexOf('</section>', haoyouMarkupStart)) : "";
const duplicate = {
  ...haoyouEvent,
  game_name: tapTapEvent.game_name,
  date_text: tapTapEvent.date_text,
  title: tapTapEvent.title,
};
const dedupeHtml = buildDailyPosterHtml([tapTapEvent, duplicate], {
  assetBase: "http://127.0.0.1:64424",
  generatedAt: new Date("2026-08-12T10:30:00+08:00"),
});
const gameMarker = '<article class="poster-card';

console.log(JSON.stringify({
  sourceRows: eventRows.length,
  hasTapTapColumn: html.includes('poster-event-column--taptap'),
  hasHaoyouColumn: html.includes('poster-event-column--haoyou'),
  haoyouDetailButtonCount: (haoyouMarkup.match(/\u67e5\u770b\u5b8c\u6574\u5185\u5bb9/g) || []).length,
  forcedSameGameCardCount: (dedupeHtml.split(gameMarker).length - 1),
  sampleIds: [tapTapEvent.id, haoyouEvent.id],
  output: "output/poster-event-validation.html",
}, null, 2));
