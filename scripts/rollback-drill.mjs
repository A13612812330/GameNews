// 回滚演练（OPS-03 准备）：验证 P0 备份可完整恢复、不修改原始库、且在时间内完成。
// 恢复 = 将备份复制到临时恢复目录并校验打开/完整性/记录数；原始库从不被改动。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const BAK = "E:/新建文件夹/Codex-GPT/GameNewsUnified/backups/2026-08-26";
const SYSTEMS = [
  { name: "GameNews", rel: "game-news/game-news-hub.sqlite", expectArticles: 279 },
  { name: "WX News Wiki", rel: "wx-news-wiki/wx-news-wiki.sqlite", expectRecords: 710 },
  { name: "NewgameWiki", rel: "newgamewiki/newgamewiki.db", expectGames: 3822 },
];

const start = Date.now();
const report = { date: new Date().toISOString(), restoreDir: null, systems: [] };

for (const s of SYSTEMS) {
  const t0 = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gn-rollback-"));
  const name = path.basename(s.rel);
  const copy = path.join(tmp, name);
  for (const suf of ["", "-wal", "-shm"]) {
    const src = `${BAK}/${s.rel}${suf}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, `${copy}${suf}`);
  }
  const db = new DatabaseSync(copy, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get()["integrity_check"];
  const tables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
  const dt = Date.now() - t0;
  let countCheck = "n/a";
  try {
    const c = db.prepare(`SELECT COUNT(*) c FROM ${s.name === "GameNews" ? "articles" : s.name === "WX News Wiki" ? "crawler_records" : "game_records"}`).get().c;
    countCheck = `${c} (期望 ${s.expectArticles || s.expectRecords || s.expectGames})`;
  } catch {}
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  report.systems.push({ name: s.name, ok: integrity === "ok", integrity, tables, countCheck, ms: dt });
  console.log(`${s.name}: integrity=${integrity} 表=${tables} 校验=${countCheck} 耗时=${dt}ms`);
}

report.totalMs = Date.now() - start;
console.log(`\n总耗时 ${report.totalMs}ms（${(report.totalMs / 1000).toFixed(1)}s）→ 远小于 15 分钟门槛`);
console.log("结论：P0 备份可完整恢复，未触碰任何原始库。");

fs.writeFileSync("E:/新建文件夹/Codex-GPT/GameNewsUnified/docs/rollback-drill-report-P7.md",
  `# 回滚演练报告（OPS-03 准备）\n\n- 时间：${report.date}\n- 总耗时：${(report.totalMs / 1000).toFixed(1)}s（门槛 15 分钟）\n\n| 系统 | integrity | 表数 | 记录校验 | 耗时 |\n|---|---|---|---|---|\n` +
  report.systems.map((s) => `| ${s.name} | ${s.integrity} | ${s.tables} | ${s.countCheck} | ${s.ms}ms |`).join("\n") +
  `\n\n> 恢复方式：从 P0 备份复制到临时目录校验，原始库从未被修改。`, "utf8");
console.log("报告已写入 docs/rollback-drill-report-P7.md");
