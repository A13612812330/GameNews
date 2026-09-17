import { fetchSteamItems } from "../server/crawler/platforms/steam.js";
import { db } from "../server/database.js";
import { stableId } from "../server/crawler/deduper.js";

const maxCandidates = Math.max(1, Number(process.argv[2]) || 24);
const items = await fetchSteamItems({ maxCandidates });
const statement = db.prepare(`
  INSERT INTO articles
  (id, source_id, source_name, title, game_name, category, detail_url, image_url, date_text, score, paragraphs, facts, quality, discovered_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, game_name=excluded.game_name, category=excluded.category,
    detail_url=excluded.detail_url, image_url=excluded.image_url, date_text=excluded.date_text,
    score=excluded.score, paragraphs=excluded.paragraphs, facts=excluded.facts,
    quality=excluded.quality, updated_at=datetime('now')
`);

for (const item of items) {
  const id = stableId("ref-steam", item.detailUrl);
  const paragraphs = (item.paragraphs || []).filter(Boolean);
  statement.run(
    id, "ref-steam", "Steam", item.title, item.gameName, item.category,
    item.detailUrl, item.imageUrl || "", item.dateText || "", item.score,
    JSON.stringify(paragraphs), JSON.stringify({ steamTags: item.tags || [], steamGenres: item.genres || [], steamCategories: item.categories || [], potentialScore: item.potentialScore || 0, rejectReasons: item.rejectReasons || [], storePageStatus: item.storePageStatus || "unknown", tagStatus: item.tagStatus || "unknown" }), paragraphs.length ? "ok" : "pending",
  );
}

console.log(JSON.stringify({ fetched: items.length, maxCandidates, source: "Steam", databaseWrite: true }, null, 2));
