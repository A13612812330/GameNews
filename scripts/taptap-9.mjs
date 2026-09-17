import { fetchHtml } from "../server/crawler/fetcher.js";
import * as cheerio from "cheerio";

const targets = [
  // MOMENT 页 ———— 官方公告/动态
  { n:1,  url:"https://www.taptap.cn/moment/831943893871231441", game:"怪物猎人：旅人" },
  { n:3,  url:"https://www.taptap.cn/moment/830805650979164149", game:"QQ宠物" },
  // APP 页 ———— 需检测"新版本"标记
  { n:4,  url:"https://www.taptap.cn/app/43639",     game:"我的世界" },
  { n:7,  url:"https://www.taptap.cn/app/234493",    game:"绝区零" },
  { n:8,  url:"https://www.taptap.cn/app/54031",     game:"植物大战僵尸2" },
  { n:6,  url:"https://www.taptap.cn/app/708247",    game:"黄油猫" },
  { n:14, url:"https://www.taptap.cn/app/722210",    game:"无畏契约" },
  { n:15, url:"https://www.taptap.cn/app/760944",    game:"魂坠深境" },
  { n:16, url:"https://www.taptap.cn/app/766691",    game:"万华律" },
];

function detectAppType($) {
  // 查找"新版本" tab 或 "新版本更新" 标签
  const hasNewVerTab = $(".app-layout__header").text().includes("新版本") ||
                       $(".tap-slide__wrap").text().includes("新版本");
  const hasUpdateTag = /X月X日\s*新版本更新/.test($("body").text()) ||
                       /[0-9]+月[0-9]+日\s*新版本/.test($("body").text());
  const hasUpdateLog = $("body").text().includes("更新日志");

  if (hasNewVerTab && (hasUpdateTag || hasUpdateLog)) return "app_update";
  // 看游戏名后是否有首发/上线标识
  const isDebut = /[0-9]+月[0-9]+日\s*首发/.test($("body").text()) ||
                  /新品/.test($("body").text().slice(0, 2000));
  return isDebut ? "app_newgame" : "app_general";
}

function getUpdateTitle($) {
  // 从"X月X日 新版本更新"附近找版本标题
  const text = $("body").text();
  const match = text.match(/新版本[：:\s]*([^\n\r]{1,40})/);
  if (match) return match[1].trim();
  return null;
}

function inferCategory(text) {
  const t = text.toLowerCase();
  if (/联动|×\s*[^0-9]|合作/.test(t)) return "联动活动";
  if (/测试|公测|内测/.test(t)) return "测试公测";
  if (/版本|更新|赛季|资料片/.test(t)) return "版本更新";
  if (/上线|回归|发售|发布|首发/.test(t)) return "产品上线";
  return "新游上线";
}

const results = [];

for (const t of targets) {
  const html = await fetchHtml(t.url);
  const $ = cheerio.load(html);

  let title = "";
  let category = "新游资讯";
  const bodyItems = [];
  let type = "moment_event";

  // ─── MOMENT ───
  if (t.url.includes("/moment/")) {
    type = "moment_event";
    const rawTitle = $("title").text().replace(/\s*[-–—].*$/, "").trim();
    const eventPart = rawTitle.replace(/《[^》]+》/, "").replace(/^[「」\s]+/, "").trim().slice(0, 30);
    title = `《${t.game}》${eventPart || "重要动态"}`;
    $(".tap-rich-content__wrapper").children(".tap-rich-content__row").each((_, el) => {
      const cls = $(el).attr("class") || "";
      if (cls.includes("paragraph")) {
        const txt = $(el).text().trim();
        if (txt.length > 2) bodyItems.push({ type: "text", content: txt });
      } else if (cls.includes("image")) {
        const img = $(el).find("img");
        const src = img.attr("src") || "";
        if (src && !src.startsWith("data:")) bodyItems.push({ type: "image", src });
      }
    });
    category = inferCategory(bodyItems.map(b=>b.content||"").join(" "));

  // ─── APP 页 ———— 自动检测类型 ───
  } else {
    type = detectAppType($);

    if (type === "app_update") {
      // 标题: 《游戏名》全新"X"版本现已开启！ + 版本主题
      const versionTheme = getUpdateTitle($);
      title = versionTheme
        ? `《${t.game}》全新"${versionTheme}"版本现已开启！`
        : `《${t.game}》最新版本现已开启！`;
      category = "版本更新";

      // 正文: 提取"更新日志"区域 + 活动公告
      // 方法1: 找含【】段落的块（标题-内容对）
      $("body *").each((_, el) => {
        const txt = $(el).text().trim();
        // 匹配段落结构：标题【...】+内容
        if (txt.startsWith("【") && txt.includes("】")) {
          const decoded = txt.replace(/\\u003C/g, "<").replace(/\\u003E/g, ">");
          // 拆分【】对
          const segs = decoded.split(/【|】/);
          for (let i = 0; i < segs.length - 1; i += 2) {
            const header = segs[i]?.trim();
            const content = segs[i + 1]?.trim().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (header && content && content.length > 30) {
              bodyItems.push({ type: "text", content: `${header}\n${content}` });
            }
          }
        }
      });
      // 去重
      const seen = new Set();
      const deduped = bodyItems.filter(b => {
        if (seen.has(b.content)) return false;
        seen.add(b.content);
        return true;
      });
      bodyItems.length = 0;
      bodyItems.push(...deduped);

      // 补充: 找页面内的真实更新描述（"X更新于X"之后的描述）
      if (!bodyItems.length || bodyItems.every(b => b.content.length < 50)) {
        // 找"更新日志 版本："或"X日更新"附近的描述
        $("div, section").each((_, el) => {
          const html = $(el).html() || "";
          if (html.includes("\\u003Cbr")) {
            const decoded = html.replace(/\\u003C/g, "<").replace(/\\u003E/g, ">");
            const txt = decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (txt.length > 50 && txt.length < 2000 && !txt.includes("TapTap 提供")) {
              bodyItems.push({ type: "text", content: txt });
            }
          }
        });
      }

      // 降级: og:description
      if (!bodyItems.some(b => b.type === "text")) {
        const d = ($("meta[property='og:description']").attr("content") || "")
          .replace(/TapTap\s*提供.{0,80}?官方正版下载[，,]\s*/g, "");
        if (d.length > 20) bodyItems.push({ type: "text", content: d });
      }

    } else {
      // 新游/通用 — 使用 og:description
      type = "app_newgame";
      title = `《${t.game}》新品上线`;
      category = "新游上线";

      const desc = ($("meta[property='og:description']").attr("content") || "")
        .replace(/TapTap\s*提供.{0,80}?官方正版下载[，,]\s*/g, "")
        .replace(/TapTap.*$/g, "")
        .slice(0, 400);

      const tags = [];
      $("meta[name='keywords']").attr("content")?.split(",").slice(0, 4).forEach(k => {
        const kw = k.trim();
        if (kw && kw.length < 10 && !/tap/i.test(kw)) tags.push(kw);
      });
      if (desc.length > 20) {
        bodyItems.push({ type: "text", content: tags.length ? `标签：${tags.join("、")}\n${desc}` : desc });
      }
    }
  }

  // 封面图
  const ogImg = $("meta[property='og:image']").attr("content");
  if (ogImg && !bodyItems.some(b => b.type === "image" && b.src === ogImg)) {
    bodyItems.unshift({ type: "image", src: ogImg, isCover: true });
  }

  results.push({
    n: t.n, url: t.url, game: t.game, type,
    title, category, bodyItems,
    hasContent: bodyItems.some(b => b.type === "text"),
  });
}

// ──── Build HTML ────
import fs from "fs";

const tagColor = { moment_event: "#2563eb", app_update: "#e0a530", app_newgame: "#2c5f4b" };
const tagLabel = { moment_event: "官方公告", app_update: "版本更新", app_newgame: "新游上线" };

let rows = "";
for (const r of results) {
  const color = tagColor[r.type] || "#666";
  const label = tagLabel[r.type] || r.type;
  const cardClass = r.hasContent ? "" : " bad";

  let bodyHtml = "";
  for (const b of r.bodyItems) {
    if (b.type === "text") {
      bodyHtml += `<p>${b.content.replace(/\n/g, "<br>")}</p>`;
    } else {
      bodyHtml += `<div class="img-wrap${b.isCover?' cover':''}"><img src="${b.src}" loading="lazy" /></div>`;
    }
  }

  rows += `
  <div class="card${cardClass}">
    <div class="num">${r.n}</div>
    <div class="info">
      <div class="topline">
        <span class="tag" style="background:#f3f4f6;color:${color}">${label}</span>
        <span class="cat">${r.category}</span>
      </div>
      <h2 class="title">${r.title}</h2>
      <div class="url"><a href="${r.url}" target="_blank">${r.url}</a></div>
      <div class="article-body">${bodyHtml}</div>
    </div>
  </div>`;
}

const out = "E:/新建文件夹/WorkBuddy/2026-07-30-11-37-18/output/taptap_preview.html";
fs.writeFileSync(out, `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TapTap 9条 · 自动版本检测</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#fafbf9;color:#1b1f1d;font-size:13px;max-width:780px;margin:0 auto;padding:28px 20px;line-height:1.7}
h1{font-size:18px;border-bottom:2px solid #2c5f4b;padding-bottom:6px;margin-bottom:20px}
.legend{display:flex;gap:14px;margin-bottom:16px;font-size:11px}
.legend span{display:flex;align-items:center;gap:4px}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.card{border:1px solid #e0e4df;border-radius:10px;padding:18px 20px;margin-bottom:16px;background:#fff;display:flex;gap:12px;align-items:flex-start}
.card.bad{opacity:.4}
.num{width:28px;height:28px;border-radius:7px;background:#2c5f4b;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.info{flex:1;min-width:0}
.topline{display:flex;gap:8px;align-items:center;margin-bottom:4px}
.tag{display:inline-block;padding:1px 7px;border-radius:4px;font-size:9px;font-weight:600}
.cat{font-size:10px;color:#2c5f4b;font-weight:600}
.title{font-size:15px;font-weight:700;margin-bottom:3px}
.url{font-size:10px;color:#2c5f4b;margin-bottom:10px;word-break:break-all}
.url a{color:#2c5f4b;text-decoration:none}
.article-body{font-size:12px;line-height:1.9;color:#333}
.article-body p{margin:0 0 8px}
.article-body .img-wrap{margin:10px 0;text-align:center}
.article-body .img-wrap img{max-width:100%;max-height:400px;border-radius:6px;border:1px solid #e0e4df}
.article-body .img-wrap.cover img{max-width:200px;max-height:150px}
</style>
</head>
<body>
<h1>TapTap 9条 · APP页自动版本检测</h1>
<div class="legend">
  <span><i style="background:#2563eb"></i> 官方公告 (MOMENT)</span>
  <span><i style="background:#e0a530"></i> 版本更新 (新版本标签)</span>
  <span><i style="background:#2c5f4b"></i> 新游上线</span>
</div>
${rows}
<div style="text-align:center;padding:16px;color:#77857c;font-size:10px">
APP页自动检测: 有"新版本"标签 + "更新日志" → 版本更新；否则 → 新游/通用<br>
正文提取: Nuxt SSR 段落块【...】 拆分 + 解码 \\u003C 转义字符
</div>
</body>
</html>`);

console.log(`✅ ${results.filter(r=>r.hasContent).length}/${results.length}条`);