import { db } from "../server/database.js";
import { crawlDetails } from "../server/crawler/tasks.js";

console.log("=== 数据质量优化 ===");

// 1. 全量补抓 pending 详情（不限 30 篇）
const pending = db.prepare(
  "SELECT id FROM articles WHERE quality='pending' ORDER BY score DESC"
).all();
console.log("待抓取:", pending.length, "篇");

// 分批抓取，每批 20 篇
const batchSize = 20;
for (let i = 0; i < pending.length; i += batchSize) {
  const batch = pending.slice(i, i + batchSize);
  try {
    const result = await crawlDetails(batch);
    const done = result.articles?.length || 0;
    console.log(`  批次 ${Math.floor(i / batchSize) + 1}: ${done}/${batch.length} 篇`);
  } catch (e) {
    console.log(`  批次 ${Math.floor(i / batchSize) + 1}: 失败 - ${e.message}`);
  }
}

// 2. og:description 降级：无正文的取 meta description
const noPara = db.prepare(
  "SELECT id, detail_url FROM articles WHERE (paragraphs IS NULL OR paragraphs = '[]' OR paragraphs = 'null') LIMIT 500"
).all();
console.log("无正文需降级:", noPara.length, "篇");

let filled = 0;
for (const a of noPara) {
  try {
    const html = await fetch(a.detail_url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000),
    }).then(r => r.text());
    
    // 提取 og:description
    const match = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)
               || html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
    if (match && match[1]) {
      const desc = match[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim().slice(0, 300);
      if (desc.length > 20) {
        db.prepare("UPDATE articles SET paragraphs = ?, quality = 'needs_review' WHERE id = ?")
          .run(JSON.stringify([desc]), a.id);
        filled++;
      }
    }
  } catch {}
}
console.log("og:description 补填:", filled, "篇");

// 3. 清垃圾
const a1 = db.prepare("UPDATE articles SET paragraphs='[]', quality='low_quality' WHERE paragraphs LIKE '%好游快爆APP提供%' OR paragraphs LIKE '%精品手游平台%'").run();
const a2 = db.prepare("UPDATE articles SET paragraphs='[]', quality='low_quality' WHERE paragraphs LIKE '%t2631_%'").run();
console.log("清广告:", a1.changes + a2.changes, "篇");

// 4. 统计
const withPara = db.prepare(
  "SELECT COUNT(*) as c FROM articles WHERE paragraphs IS NOT NULL AND paragraphs != '[]' AND paragraphs != 'null' AND quality != 'low_quality'"
).get().c;
const total = db.prepare("SELECT COUNT(*) as c FROM articles").get().c;
console.log("最终正文覆盖:", withPara, "/", total, "(", Math.round(withPara * 100 / total), "%)");
console.log("DONE");
