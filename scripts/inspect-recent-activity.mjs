import { db } from '../server/database.js';
const rows = db.prepare(`SELECT id, source_id, game_name, title, date_text, detail_url, score, quality, updated_at, facts FROM articles WHERE source_id IN ('ref-taptap','ref-haoyou','ref-x7') ORDER BY updated_at DESC LIMIT 80`).all();
for (const row of rows) {
  if (/活动|更新|联动|赛季|版本|开启|上线/u.test(`${row.title} ${row.date_text}`)) console.log(JSON.stringify({id:row.id,source_id:row.source_id,game_name:row.game_name,title:row.title,date_text:row.date_text,detail_url:row.detail_url,score:row.score,quality:row.quality,updated_at:row.updated_at},null,2));
}
