// P5 飞书同步管线测试：S/A 筛选、分类、排序、指纹防重
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { collectFeishuAlerts, stageFeishuNotifications } from "../server/tasks/feishu-sync.mjs";
import { createRatingService } from "../server/rules/index.mjs";
import { eventType } from "../server/feishu/algorithm.mjs";
import { queueAlertNotifications, pendingAlertNotifications, recordAlertAttempt } from "../server/feishu/audit-store.mjs";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE articles (
    id TEXT PRIMARY KEY, source_id TEXT, source_name TEXT, title TEXT, game_name TEXT,
    category TEXT, date_text TEXT, score INTEGER, quality TEXT DEFAULT 'ok', detail_url TEXT,
    discovered_at TEXT, paragraphs_json TEXT
  );
  CREATE TABLE ratings (
    id TEXT PRIMARY KEY, ref_type TEXT, ref_id TEXT, rating TEXT, source TEXT DEFAULT 'manual',
    note TEXT, created_at TEXT, updated_at TEXT, UNIQUE(ref_type, ref_id, source)
  );
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, kind TEXT, title TEXT, payload_json TEXT, status TEXT DEFAULT 'pending',
    fingerprint TEXT UNIQUE, created_at TEXT, sent_at TEXT, error TEXT
  );
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY, notification_id TEXT, channel TEXT, status TEXT, sent_at TEXT, error TEXT,
    UNIQUE(notification_id, channel)
  );`);
  return db;
}

const mk = (id, category, game, score, date) => ({
  id, source_id: "ref-test", source_name: "测试源", title: `《${game}》动态`, game_name: game,
  category, date_text: date, score, quality: "ok", detail_url: `https://x/${id}`,
  discovered_at: `${date}T01:00:00`, paragraphs_json: "[]",
});
function insert(db, rows) {
  const stmt = db.prepare(`INSERT INTO articles (id, source_id, source_name, title, game_name, category, date_text, score, quality, detail_url, discovered_at, paragraphs_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) stmt.run(r.id, r.source_id, r.source_name, r.title, r.game_name, r.category, r.date_text, r.score, r.quality, r.detail_url, r.discovered_at, r.paragraphs_json);
}

describe("P5 飞书同步：collectFeishuAlerts", () => {
  test("仅选 S/A；新游/活动分类正确", () => {
    const db = memoryDb();
    insert(db, [
      mk("a1", "新游上线", "新游S", 90, "2026-08-27"),
      mk("a2", "测试公测", "新游A", 80, "2026-08-27"),
      mk("a3", "新游上线", "新游B", 70, "2026-08-27"), // B 被过滤
      mk("a4", "活动", "活动S", 85, "2026-08-26"),
      mk("a5", "版本更新", "更新A", 60, "2026-08-27"),
    ]);
    const svc = createRatingService(db);
    svc.set("article", "a1", "S", "manual");
    svc.set("article", "a2", "A", "manual");
    svc.set("article", "a3", "B", "manual");
    svc.set("article", "a4", "S", "manual");
    svc.set("article", "a5", "A", "manual");
    const alerts = collectFeishuAlerts(db, { date: "2026-08-27" });
    assert.equal(alerts.length, 4); // a3(B) 被过滤
    assert.equal(alerts.filter((a) => a.kind === "new_game").length, 2);
    assert.equal(alerts.filter((a) => a.kind === "activity").length, 2);
    db.close();
  });
  test("排序：业务日期升序 → S 前 A 后 → 评分降序", () => {
    const db = memoryDb();
    insert(db, [
      mk("x1", "新游上线", "S同日后", 60, "2026-08-27"),
      mk("x2", "新游上线", "S早日", 80, "2026-08-26"),
      mk("x3", "新游上线", "S高分", 95, "2026-08-27"),
      mk("x4", "新游上线", "A低分", 50, "2026-08-27"),
    ]);
    const svc = createRatingService(db);
    svc.set("article", "x1", "S", "manual");
    svc.set("article", "x2", "S", "manual");
    svc.set("article", "x3", "S", "manual");
    svc.set("article", "x4", "A", "manual");
    const alerts = collectFeishuAlerts(db, { date: "2026-08-27" });
    const names = alerts.map((a) => a.gameName);
    // 早日 S 在前；同日 S 高分先于 S 低分；S 全部先于 A
    assert.deepEqual(names, ["S早日", "S高分", "S同日后", "A低分"]);
    db.close();
  });
});

describe("P5 飞书同步：stageFeishuNotifications 防重", () => {
  test("dry-run 不写入；--stage 写入且同指纹二次执行跳过", () => {
    const db = memoryDb();
    insert(db, [mk("a1", "新游上线", "新游S", 90, "2026-08-27")]);
    createRatingService(db).set("article", "a1", "S", "manual");
    const alerts = collectFeishuAlerts(db, { date: "2026-08-27" });
    const dry = stageFeishuNotifications(db, alerts, { dryRun: true });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications").get().c, 0);
    assert.equal(dry.dup, 1);
    const first = stageFeishuNotifications(db, alerts, { dryRun: false });
    assert.equal(first.staged, 1);
    const second = stageFeishuNotifications(db, alerts, { dryRun: false });
    assert.equal(second.staged, 0);
    assert.equal(second.dup, 1); // 同指纹防重
    assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications").get().c, 1);
    db.close();
  });
});

describe("资讯隔离与投递审计", () => {
  test("游民/机核资讯不再作为新游或活动事件", () => {
    assert.equal(eventType({ sourceId: "ref-gamersky", category: "新游上线", title: "《示例》官方预告" }), null);
    assert.equal(eventType({ sourceId: "ref-gcores", category: "行业资讯", title: "《示例》发售新闻" }), null);
  });
  test("提醒先入队，发送结果保留消息 ID 和失败重试状态", () => {
    const db = memoryDb();
    const item = { eventKey: "demo|新游|2026-08-27", type: "新游", game: "测试游戏", grade: "S · 重点" };
    assert.equal(queueAlertNotifications(db, [item]), 1);
    const [pending] = pendingAlertNotifications(db);
    recordAlertAttempt(db, pending.notification, { messageId: "om_xxx" });
    assert.equal(db.prepare("SELECT status FROM notifications").get().status, "sent");
    assert.equal(db.prepare("SELECT message_id FROM deliveries").get().message_id, "om_xxx");
    db.close();
  });
});
