// 双跑对照（P6）：旧项目 GameNews 输出 vs 统一项目输出
// 提取两侧简讯的 游戏+分类 集合做差异报告，另附失败清单。
// 用法: node scripts/double-run-compare.mjs --date 2026-08-26
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OLD = "E:/新建文件夹/Codex-GPT/GameNews/output";
const UNI = path.join(ROOT, "output");

function extractOld(file) {
  const html = fs.readFileSync(file, "utf8");
  const out = [];
  const re = /<span class="brief-card-heading">([\s\S]*?)<span class="brief-card-meta">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const heading = m[1].replace(/<[^>]+>/g, "").trim();
    const meta = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const game = /《([^》]*)》/.exec(heading)?.[1] || heading;
    const kind = /(新游|测试|更新|活动|联动|资讯|热点|榜单)/.exec(meta)?.[1] || "";
    out.push({ game, heading, kind, meta });
  }
  return out;
}
function extractUnified(file) {
  const html = fs.readFileSync(file, "utf8");
  const out = [];
  const cardRe = /<div class="card"><h2>(.*?)<\/h2>([\s\S]*?)<div class="src">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = cardRe.exec(html))) {
    const heading = m[1].replace(/<[^>]+>/g, "").trim();
    const meta = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const game = /《([^》]*)》/.exec(heading)?.[1] || heading;
    const kind = /(新游|测试|更新|活动|联动|资讯|热点|榜单)/.exec(meta)?.[1] || "";
    out.push({ game, heading, kind, meta });
  }
  return out;
}

function pickOldFile(date) {
  const candidates = [
    path.join(OLD, "brief-archive", `今日简讯-${date}.html`),
    path.join(OLD, "poster-archive", `简讯海报-${date}.html`),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // 没有同日 -> 取最近一份（用于口径说明）
  const dir = path.join(OLD, "brief-archive");
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
    if (files.length) return path.join(dir, files[files.length - 1]);
  }
  return null;
}

const date = process.argv[process.argv.indexOf("--date") + 1] || new Date().toISOString().slice(0, 10);
const uniFile = path.join(UNI, "brief-archive", `今日简讯-${date}.html`);
const oldFile = pickOldFile(date);

console.log(`===== 双跑对照 ${date} =====`);
console.log(`旧项目文件: ${oldFile || "（无）"}`);
console.log(`统一项目文件: ${fs.existsSync(uniFile) ? uniFile : "（无）"}`);

const oldItems = oldFile && fs.existsSync(oldFile) ? extractOld(oldFile) : [];
const uniItems = fs.existsSync(uniFile) ? extractUnified(uniFile) : [];

const keyOf = (i) => `${i.game}|${i.kind}`;
const oldKeys = new Set(oldItems.map(keyOf));
const uniKeys = new Set(uniItems.map(keyOf));
const onlyOld = [...oldKeys].filter((k) => !uniKeys.has(k));
const onlyUni = [...uniKeys].filter((k) => !oldKeys.has(k));
const both = [...oldKeys].filter((k) => uniKeys.has(k));

console.log(`旧项目条目: ${oldItems.length}  统一条目: ${uniItems.length}`);
console.log(`重叠: ${both.length}  仅旧: ${onlyOld.length}  仅统一: ${onlyUni.length}`);
console.log("\n[仅旧项目]");
for (const k of onlyOld) console.log("  -", k);
console.log("\n[仅统一项目]");
for (const k of onlyUni) console.log("  -", k);

// 失败清单
const failFile = path.join(UNI, "failures-P6.jsonl");
let fails = [];
if (fs.existsSync(failFile)) fails = fs.readFileSync(failFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log(`\n[统一项目失败清单] ${fails.length} 条`);
for (const f of fails) console.log("  -", f.task, f.runId, f.error?.slice(0, 120));

// 写报告
const report = { date, oldFile, uniFile: uniFile, oldCount: oldItems.length, uniCount: uniItems.length, both, onlyOld, onlyUni, failures: fails };
fs.writeFileSync(path.join(ROOT, "docs", "double-run-report-P6.md"),
  `# 双跑对照报告 ${date}\n\n` +
  `- 旧项目输出：${oldFile || "无"}\n- 统一项目输出：${uniFile}\n` +
  `- 条目：旧 ${oldItems.length} / 统一 ${uniItems.length}；重叠 ${both.length}；仅旧 ${onlyOld.length}；仅统一 ${onlyUni.length}\n\n` +
  `## 仅旧项目\n${onlyOld.map((k) => `- ${k}`).join("\n") || "（无）"}\n\n` +
  `## 仅统一项目\n${onlyUni.map((k) => `- ${k}`).join("\n") || "（无）"}\n\n` +
  `## 失败清单\n${fails.map((f) => `- ${f.task}: ${f.error}`).join("\n") || "（无）"}\n`,
  "utf8");
console.log("\n报告已写入 docs/double-run-report-P6.md");
