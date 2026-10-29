// 飞书同步管线（P5）：从统一库选取 S/A 评级的新游/活动，按业务日期→评级→评分排序，
// 生成待发送通知写 notifications（指纹防重），dry-run 默认只报告不真实发送。
// 用法:
//   node server/tasks/feishu-sync.mjs --date 2026-08-27          # dry-run（默认，不写 notifications）
//   node server/tasks/feishu-sync.mjs --date 2026-08-27 --stage  # 真实写入 notifications（仍不发送）
//   node server/tasks/feishu-sync.mjs --date 2026-08-27 --stage --publish  # 真实发送（需飞书授权）
import { openDb } from "./pipeline.mjs";
import { createRatingService, dateBucket } from "../rules/index.mjs";

const NOW = () => new Date().toISOString();
const NEW_GAME = new Set(["新游上线", "测试公测"]);
const ACTIVITY = new Set(["活动", "版本更新", "联动活动"]);

// 收集某窗口内 S/A 评级的新游/活动候选（含评级），按业务日期→评级→评分排序
export function collectFeishuAlerts(db, { date = new Date().toISOString().slice(0, 10), windowDays = 2, onlySA = true } = {}) {
  const ratings = createRatingService(db);
  const since = new Date(date); since.setDate(since.getDate() - (windowDays - 1));
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT id, source_id, source_name, title, game_name, category, date_text, score, detail_url
     FROM articles WHERE substr(discovered_at,1,10) BETWEEN ? AND ? AND quality='ok'
     ORDER BY discovered_at ASC`
  ).all(sinceStr, date);
  const out = [];
  for (const r of rows) {
    let kind = null;
    if (NEW_GAME.has(r.category)) kind = "new_game";
    else if (ACTIVITY.has(r.category)) kind = "activity";
    if (!kind) continue;
    const grade = ratings.getEffective("article", r.id)?.rating || "";
    if (onlySA && grade !== "S" && grade !== "A") continue;
    out.push({
      articleId: r.id, kind, grade: grade || "—",
      gameName: r.game_name || "待补", title: r.title, category: r.category,
      sourceName: r.source_name, detailUrl: r.detail_url,
      dateText: r.date_text || "", bucket: dateBucket(r.date_text, r.discovered_at),
      score: Number(r.score) || 0,
    });
  }
  // 排序：业务日期升序 → S 前 A 后 → 评分降序
  out.sort((a, b) =>
    (a.bucket || "9999").localeCompare(b.bucket || "9999") ||
    (a.grade === "S" ? 0 : 1) - (b.grade === "S" ? 0 : 1) ||
    b.score - a.score
  );
  return out;
}

// 写入 notifications（指纹防重）；deliveries 仅在真实发送时记录
export function stageFeishuNotifications(db, alerts, { dryRun = true } = {}) {
  let staged = 0, dup = 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO notifications (id, kind, title, payload_json, status, fingerprint, created_at)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (const a of alerts) {
    const fingerprint = `feishu:${a.kind}:${a.articleId}:${a.bucket || "nodate"}`;
    const payload = JSON.stringify(a);
    if (dryRun) { dup += 1; continue; }
    const changed = stmt.run(
      `n-${a.kind}-${a.articleId}-${a.bucket || "nodate"}`, a.kind, `${a.grade}级 · ${a.gameName}`, payload,
      "pending", fingerprint, NOW()
    ).changes;
    if (changed) staged += 1; else dup += 1;
  }
  return { staged, dup };
}

// CLI
const isMain = process.argv[1] && process.argv[1].endsWith("feishu-sync.mjs");
if (isMain) {
  const argv = process.argv;
  const di = argv.indexOf("--date");
  const date = di >= 0 ? argv[di + 1] : new Date().toISOString().slice(0, 10);
  const dryRun = !argv.includes("--stage");
  const db = openDb();
  const alerts = collectFeishuAlerts(db, { date });
  const byKind = { new_game: 0, activity: 0 };
  for (const a of alerts) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  console.log(`===== 飞书同步 dry-run ${date} =====`);
  console.log(`S/A 提醒候选：新游 ${byKind.new_game || 0} 条 / 活动 ${byKind.activity || 0} 条（合计 ${alerts.length}）`);
  console.log("\n[待发送清单]");
  for (const a of alerts) {
    console.log(`  [${a.grade}] ${a.kind === "new_game" ? "新游" : "活动"} ${a.gameName}（${a.bucket || a.dateText || "日期待补"}）评分${a.score} ${a.sourceName}`);
  }
  const res = stageFeishuNotifications(db, alerts, { dryRun });
  console.log(`\n模式: ${dryRun ? "DRY-RUN（未写入）" : "已写入 notifications"}（防重跳过 ${res.dup}）`);
  if (!dryRun) console.log("真实发送需 --publish + 飞书授权，且须用户单独确认");
  db.close();
}
