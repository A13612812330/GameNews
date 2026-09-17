import { db } from "../server/database.js";
import { classifySteamReleaseDate, selectSteamTags } from "../server/crawler/platforms/steam.js";

const rows = db.prepare("SELECT id, title, game_name, category, date_text, facts FROM articles WHERE source_id = 'ref-steam'").all();
const update = db.prepare("UPDATE articles SET title=?, category=?, facts=?, updated_at=datetime('now') WHERE id=?");
let changed = 0;

for (const row of rows) {
  let facts = {};
  try { facts = JSON.parse(row.facts || "{}"); } catch {}
  const rawTags = Array.isArray(facts.steamTags) ? facts.steamTags : [];
  const tags = selectSteamTags(facts.steamGenres || [], facts.steamCategories || [], rawTags);
  const release = classifySteamReleaseDate(row.date_text || "");
  const name = row.game_name || String(row.title || "").replace(/^《|》.*$/g, "").trim();
  const title = name ? `《${name}》${release.suffix}` : row.title;
  const nextFacts = { ...facts, steamTags: tags, tagStatus: tags.length ? "available" : (facts.tagStatus || "unknown"), storePageStatus: facts.storePageStatus || "unknown" };
  if (title !== row.title || row.category !== release.category || JSON.stringify(nextFacts) !== String(row.facts || "{}")) {
    update.run(title, release.category, JSON.stringify(nextFacts), row.id);
    changed++;
  }
}

console.log(JSON.stringify({ scanned: rows.length, changed }, null, 2));
