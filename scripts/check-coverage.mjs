import { db } from "./server/database.js";

const total = db.prepare("SELECT COUNT(*) as c FROM articles").get().c;
const withPara = db.prepare("SELECT COUNT(*) as c FROM articles WHERE paragraphs IS NOT NULL AND paragraphs != '[]'").get().c;

const sources = db.prepare("SELECT DISTINCT source_id, source_name FROM articles").all();
const rows = [];
for (const s of sources) {
  const t = db.prepare("SELECT COUNT(*) as c FROM articles WHERE source_id=?").get(s.source_id).c;
  const w = db.prepare("SELECT COUNT(*) as c FROM articles WHERE source_id=? AND paragraphs IS NOT NULL AND paragraphs != '[]'").get(s.source_id).c;
  rows.push({ name: s.source_name, total: t, withPara: w, pct: Math.round(w * t ? w / t * 100 : 0) });
}

console.log("=== 正文覆盖率 ===");
console.log("总:", total, "篇 | 有正文:", withPara, "篇 |", Math.round(withPara / (total || 1) * 100), "%");
console.log();
console.log("平台明细:");
rows.sort((a, b) => b.pct - a.pct).forEach(r =>
  console.log("  " + r.name.padEnd(8), r.total + "篇", r.withPara + "有正文", r.pct + "%")
);

const needFallback = db.prepare("SELECT COUNT(*) as c FROM articles WHERE (paragraphs IS NULL OR paragraphs = '[]') AND quality = 'pending'").get().c;
console.log();
console.log("需og:desc降级:", needFallback, "篇");
