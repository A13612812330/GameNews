import { db } from "../server/database.js";
import { classifySteamReleaseDate, cleanLocalizedSteamName } from "../server/crawler/platforms/steam.js";

const rows = db.prepare("SELECT id, game_name, date_text, title FROM articles WHERE source_id = 'ref-steam'").all();
const update = db.prepare("UPDATE articles SET game_name=?, title=?, category=?, updated_at=datetime('now') WHERE id=?");
let changed = 0;

for (const row of rows) {
  const name = cleanLocalizedSteamName(row.game_name || "").replace(/^《|》$/g, "").trim();
  if (!name) continue;
  const release = classifySteamReleaseDate(row.date_text || "");
  const title = `《${name}》${release.suffix}`;
  if (row.title !== title || row.game_name !== name) {
    update.run(name, title, release.category, row.id);
    changed++;
  }
}

console.log(JSON.stringify({ scanned: rows.length, changed }, null, 2));
