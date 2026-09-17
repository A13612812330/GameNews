import { crawlCandidates, crawlDetails } from "../server/crawler/tasks.js";
import { db } from "../server/database.js";

const candidateResults = await crawlCandidates(["ref-taptap"]);
const candidates = candidateResults.flatMap(result => result.candidates || []);
const ids = candidates
  .filter(item => item?.id)
  .filter(item => !/\/forum\/hot\/hashtags\?item=\d+/.test(item.detailUrl || ''))
  .sort((a, b) => (b.score || 0) - (a.score || 0))
  .slice(0, 30)
  .map(item => item.id);

const details = ids.length ? await crawlDetails(ids) : { articles: [] };
const counts = db.prepare("SELECT category, COUNT(*) AS count FROM articles WHERE source_id='ref-taptap' AND discovered_at >= datetime('now','-48 hours') GROUP BY category").all();

console.log(JSON.stringify({
  candidateBatches: candidateResults.map(result => ({ urlType: result.urlType, count: result.count, error: result.error || null })),
  candidates: candidates.length,
  detailRequested: ids.length,
  detailResults: details.articles?.length || 0,
  recentCounts: counts,
}, null, 2));
