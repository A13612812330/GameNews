import { db } from "../server/database.js";
import { crawlDetails } from "../server/crawler/tasks.js";

// 1. 补抓详情
const pending = db.prepare("SELECT id FROM articles WHERE quality='pending' ORDER BY score DESC LIMIT 30").all();
console.log("待抓取:", pending.length, "篇");
if (pending.length) {
  const result = await crawlDetails(pending);
  const done = result.articles?.length || 0;
  console.log("完成:", done, "篇");
}

// 2. 正文覆盖率
const after = db.prepare("SELECT COUNT(*) as c FROM articles WHERE paragraphs IS NOT NULL AND paragraphs != '[]'").get().c;
const total = db.prepare("SELECT COUNT(*) as c FROM articles").get().c;
console.log("正文覆盖:", after, "/", total, "(", Math.round(after/total*100), "%)");

// 3. 清广告 + SPA垃圾
const a1 = db.prepare("UPDATE articles SET paragraphs='[]', quality='low_quality' WHERE paragraphs LIKE '%好游快爆APP提供%' OR paragraphs LIKE '%精品手游平台%'").run();
const a2 = db.prepare("UPDATE articles SET paragraphs='[]', quality='low_quality' WHERE paragraphs LIKE '%t2631_%'").run();
console.log("清广告:", a1.changes + a2.changes, "篇");

// 4. 重新触发流水线生成简讯
const afterClean = db.prepare("SELECT COUNT(*) as c FROM articles WHERE paragraphs IS NOT NULL AND paragraphs != '[]' AND quality != 'low_quality'").get().c;
console.log("可用正文:", afterClean, "篇");
console.log("DONE");
