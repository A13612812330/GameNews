import { fetchHtml } from "../server/crawler/fetcher.js";
import { parseList, parseDetail } from "../server/crawler/parser.js";
import { scoreArticle } from "../server/crawler/scorer.js";

const TAPTAP_URLS = [
  { url: "https://www.taptap.cn/forum/hot", type: "forum" },
  { url: "https://www.taptap.cn/app-calendar", type: "calendar" },
  { url: "https://www.taptap.cn/upcoming", type: "upcoming" },
];

const platform = { id: "ref-taptap", name: "TapTap" };

// Step 1: extract links from all 3 pages
console.log("Step 1: 提取链接...");
const allCandidates = [];
const seenUrls = new Set();

for (const src of TAPTAP_URLS) {
  try {
    const html = await fetchHtml(src.url);
    const candidates = parseList(html, { ...platform, urlType: src.type }, src.url);
    console.log(`  ${src.type}: ${candidates.length}条`);
    for (const c of candidates) {
      if (!seenUrls.has(c.detailUrl)) {
        seenUrls.add(c.detailUrl);
        allCandidates.push(c);
      }
    }
  } catch (e) {
    console.log(`  ${src.type}: FAIL ${e.message}`);
  }
}
console.log(`  去重后: ${allCandidates.length}条`);

// Step 2: detail crawl on top 30
console.log("\nStep 2: 详情抓取(前30条)...");
const toCrawl = allCandidates.slice(0, 30);
const articles = [];

for (let i = 0; i < toCrawl.length; i++) {
  const c = toCrawl[i];
  try {
    const html = await fetchHtml(c.detailUrl);
    const detail = parseDetail(html, {
      url: c.detailUrl,
      gameName: c.gameName,
      category: c.category,
    });
    articles.push({
      idx: i + 1,
      title: c.title,
      gameName: c.gameName,
      category: c.category,
      detailUrl: c.detailUrl,
      score: c.score,
      paragraphs: detail.paragraphs || [],
      images: detail.images || [],
      quality: detail.quality || "pending",
    });
    if ((i + 1) % 5 === 0) console.log(`  ${i + 1}/${toCrawl.length}...`);
  } catch (e) {
    articles.push({
      idx: i + 1,
      title: c.title,
      gameName: c.gameName,
      category: c.category,
      detailUrl: c.detailUrl,
      score: c.score,
      paragraphs: [],
      images: [],
      quality: "failed",
      error: e.message,
    });
  }
}

console.log(`  完成: ${articles.length}篇, ${articles.filter(a => a.paragraphs.length).length}篇有正文`);

// Step 3: Build HTML
console.log("\nStep 3: 生成 HTML...");

const getUrlType = (u) => {
  if (u.includes("/moment/")) return ["MOMENT", "t-moment"];
  if (u.includes("/app/")) return ["APP", "t-app"];
  if (u.includes("/user/")) return ["USER", "t-user"];
  if (u.includes("/app-calendar") || u.includes("/upcoming")) return ["CALENDAR", "t-calendar"];
  return ["OTHER", "t-other"];
};

let rows = "";
for (const a of articles) {
  const [utag, utagClass] = getUrlType(a.detailUrl);
  const isGood = a.paragraphs.length > 0 && a.paragraphs[0].length > 30;
  const cardClass = isGood ? "" : " card-bad";
  const numClass = isGood ? "" : " num-bad";
  const sc = a.score || 0;
  const sclass = sc >= 65 ? "s-good" : sc >= 55 ? "s-mid" : "s-bad";
  const q = a.quality || "pending";
  const qclass = q === "verified" || q === "needs_review" ? "q-ok" : "q-bad";

  const title = (a.title || "").slice(0, 150);
  const para = a.paragraphs[0] || (a.error || "");
  const url = a.detailUrl;

  rows += `<div class="card${cardClass}"><div class="row">
    <div class="num${numClass}">${a.idx}</div>
    <div class="info">
      <div class="topline"><span class="tag ${utagClass}">${utag}</span><span class="score ${sclass}">${sc}分</span><span class="quality ${qclass}">${q}</span><span style="font-size:9px;color:#77857c">${a.gameName?.slice(0,20) || ""} | ${a.category || ""}</span></div>
      <div class="title">${title}</div>
      <div class="url"><a href="${url}" target="_blank">${url}</a></div>
      ${para ? `<div class="body">${para.slice(0, 300)}</div>` : ""}
    </div>
  </div></div>`;
}

const good = articles.filter(a => a.paragraphs.length > 0 && a.paragraphs[0].length > 30).length;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TapTap 优化后 · ${articles.length}篇 · ${good}篇可用</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#fafbf9;color:#1b1f1d;font-size:12px;max-width:960px;margin:0 auto;padding:24px 20px;line-height:1.7}
h1{font-size:18px;border-bottom:2px solid #2c5f4b;padding-bottom:6px;margin-bottom:16px}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;font-size:10px}
.stats div{background:#f7faf6;border-radius:6px;padding:4px 10px}
.stats b{color:#2c5f4b}
.card{border:1px solid #e0e4df;border-radius:10px;padding:14px 16px;margin-bottom:10px;background:#fff}
.card-bad{opacity:.4}
.row{display:flex;align-items:flex-start;gap:10px}
.num{width:24px;height:24px;border-radius:6px;background:#2c5f4b;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.num-bad{background:#ccc}
.info{flex:1;min-width:0}
.topline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px}
.tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:9px;font-weight:600}
.t-moment{background:#e8f0fb;color:#2563eb}.t-app{background:#fef2f2;color:#e06060}
.t-calendar{background:#fef2f2;color:#e06060}.t-user{background:#fef9ee;color:#e0a530}
.score{font-size:10px;font-weight:600}.s-good{color:#2c5f4b}.s-mid{color:#e0a530}.s-bad{color:#e06060}
.quality{font-size:9px;padding:1px 5px;border-radius:4px}.q-ok{background:#eef6f1;color:#2c5f4b}.q-bad{background:#fef2f2;color:#e06060}
.title{font-size:12px;font-weight:600;margin:2px 0}
.url{font-size:9px;color:#2c5f4b;word-break:break-all}
.url a{color:#2c5f4b;text-decoration:none}.url a:hover{text-decoration:underline}
.body{font-size:11px;margin-top:6px;padding:8px 10px;background:#f9faf8;border-radius:6px;max-height:100px;overflow-y:auto;line-height:1.6;color:#1b1f1d}
</style>
</head>
<body>
<h1>TapTap 优化后爬取 · ${articles.length}篇 · ${good}篇正文可用</h1>
<div class="stats">
  <div>总<b>${articles.length}</b></div>
  <div>MOMENT <b>${articles.filter(a=>a.detailUrl.includes('/moment/')).length}</b></div>
  <div>APP <b>${articles.filter(a=>a.detailUrl.includes('/app/')).length}</b></div>
  <div>有正文 <b>${good}</b></div>
</div>
${rows}
<div style="text-align:center;padding:20px;color:#77857c;font-size:10px">
  共 ${articles.length} 篇 · ${good} 篇正文可用 · Parser已优化(TapTap广告前缀清洗) · 灰色=无正文
</div>
</body>
</html>`;

import fs from "fs";
const outPath = "E:/新建文件夹/WorkBuddy/2026-07-30-11-37-18/output/taptap_preview.html";
fs.writeFileSync(outPath, html);
console.log(`\n✅ ${outPath} (${articles.length}篇, ${(html.length/1024).toFixed(1)}KB)`);
