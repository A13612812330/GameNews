// P5 飞书验收测试：分类不串表、跨平台去重（新游 TapTap / 活动好游）、人工评级不覆盖、自动评级
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  cleanGameName, eventType, eventTitlesOverlap, sameNewGameEvent, sameActivityEvent,
  sourcePriority, ratingFor, ratingLabelForScore, toMonitorEvent,
} from "../server/feishu/algorithm.mjs";
import { upsertRating, getRatingByGame, ensureRatingsSchema, getRatingSource, SOURCE_MANUAL, SOURCE_LEGACY, SOURCE_AUTO } from "../server/feishu/rating-store.mjs";
import { buildEvents, auditExisting } from "../server/feishu/sync.mjs";
import { sendSAAlerts } from "../server/feishu/notifier.mjs";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE articles (
      id TEXT PRIMARY KEY, source_id TEXT, source_name TEXT, title TEXT, game_name TEXT,
      category TEXT, detail_url TEXT, image_url TEXT, date_text TEXT, score INTEGER,
      quality TEXT DEFAULT 'ok', discovered_at TEXT, paragraphs_json TEXT, facts_json TEXT
    );
    CREATE TABLE ratings (
      id TEXT PRIMARY KEY, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, rating TEXT NOT NULL,
      score INTEGER DEFAULT 0, game_name TEXT, source TEXT NOT NULL DEFAULT 'manual', note TEXT,
      reason_json TEXT, algorithm_version TEXT, feishu_record_id TEXT,
      last_seen_grade TEXT, last_seen_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(ref_type, ref_id, source)
    );
  `);
  return db;
}
const today = new Date().toISOString().slice(0, 10);
const mk = (id, sourceId, game, title, category, extra = {}) => ({
  id, source_id: sourceId, source_name: sourceId === "ref-taptap" ? "TapTap" : "好游快爆",
  title, game_name: game, category, detail_url: `https://x/${id}`, image_url: "",
  date_text: today, score: 70, quality: "ok", discovered_at: `${today}T02:00:00`,
  paragraphs_json: JSON.stringify(["测试内容" + title]), facts_json: JSON.stringify(extra.facts || {}),
  ...extra,
});

describe("P5 分类：新游/活动不串表", () => {
  test("小七恒为新游；好游 update 为活动；显式首发为新游", () => {
    assert.equal(eventType({ sourceId: "ref-x7", title: "预约新游", facts: {} }), "新游");
    assert.equal(eventType({ sourceId: "ref-haoyou", title: "版本", facts: { haoyouKind: "update" } }), "活动");
    assert.equal(eventType({ sourceId: "ref-taptap", title: "《X》8月21日首发", facts: {} }), "新游");
    // 活动侧拦截新游词：已运营游戏的版本上线属于活动
    assert.equal(eventType({ sourceId: "ref-haoyou", title: "新版本上线", category: "版本更新", facts: { haoyouKind: "update" } }), "活动");
  });
  test("TapTap game-event 详情属于活动", () => {
    assert.equal(eventType({ sourceId: "ref-taptap", title: "正式上线", facts: { taptapEvents: [{ title: "周年活动" }] } }), "活动");
  });
});

describe("P5 跨平台去重：新游 TapTap / 活动好游", () => {
  test("新游同游戏合并，TapTap 优先", () => {
    const tap = { type: "新游", game: "无限大", title: "上线", time: Date.now(), sourceId: "ref-taptap", content: "c", score: 90 };
    const hao = { type: "新游", game: "无限大", title: "即将上线", time: Date.now(), sourceId: "ref-haoyou", content: "d", score: 80 };
    assert.equal(sameNewGameEvent(tap, hao), true);
    assert.ok(sourcePriority(tap) > sourcePriority(hao)); // TapTap 优先
  });
  test("活动同游戏同日期标题重叠合并，好游优先", () => {
    const t = Date.now();
    const hao = { type: "活动", game: "逆水寒", title: "逆水寒七夕活动开启", time: t, dateKey: "2026-08-27", sourceId: "ref-haoyou", content: "七夕限定内容", score: 90 };
    const tap = { type: "活动", game: "逆水寒", title: "逆水寒七夕活动上线", time: t, dateKey: "2026-08-27", sourceId: "ref-taptap", content: "七夕上线", score: 80 };
    assert.equal(sameActivityEvent(hao, tap), true);
    assert.ok(sourcePriority(hao) > sourcePriority(tap)); // 好游优先
  });
  test("同游戏不同日期的活动（超过 2 天）保留多条", () => {
    const base = Date.now();
    const a = { type: "活动", game: "逆水寒", title: "活动A", time: base, dateKey: "2026-08-10", sourceId: "ref-haoyou", content: "a" };
    const b = { type: "活动", game: "逆水寒", title: "活动B", time: base + 10 * 86400000, dateKey: "2026-08-20", sourceId: "ref-haoyou", content: "b" };
    assert.equal(sameActivityEvent(a, b), false);
  });
});

describe("P5 自动评级", () => {
  test("头部厂商 + 高热 IP 新游进入 S/A；弱信号不抬 A", () => {
    const s = ratingFor({ type: "新游", game: "崩坏", title: "《崩坏》首发", content: "重磅动作RPG全新上线，跨平台二次元冒险大作".repeat(2), sourceId: "ref-taptap", facts: {}, reviews: 12000, followers: 200000, publisher: "米哈游", platformCount: 2, tags: ["动作", "RPG", "二次元"] });
    assert.match(s.label, /^(?:S|A)/);
    const weak = ratingFor({ type: "新游", game: "无名小作", title: "无名小作预约", content: "测试", sourceId: "ref-haoyou", facts: {}, reviews: null, followers: null, publisher: "", platformCount: 1, tags: [] });
    assert.ok(ratingValue(weak.label) <= 59);
  });
});

function ratingValue(label) { return label.startsWith("S") ? 80 : label.startsWith("A") ? 60 : label.startsWith("B") ? 45 : 0; }

describe("P5 人工评级优先，自动不覆盖", () => {
  test("upsertRating manual 后，auto 不改变最终评级", () => {
    const db = memoryDb();
    ensureRatingsSchema(db);
    upsertRating(db, { refType: "game", refId: "逆水寒", rating: "A · 优先", score: 60, gameName: "逆水寒", source: "manual" });
    upsertRating(db, { refType: "game", refId: "逆水寒", rating: "S · 重点", score: 80, gameName: "逆水寒", source: "auto" });
    const eff = getRatingByGame(db, "逆水寒");
    assert.equal(eff.rating, "A · 优先"); // manual 优先
    assert.equal(eff.source, "manual");
    db.close();
  });
});

describe("P5 事件构建：buildEvents 去重 + 人工继承", () => {
  test("同游戏多平台合并为一条，人工评级被继承", () => {
    const db = memoryDb();
    const t = new Date(); t.setHours(12, 0, 0, 0);
    const rows = [
      mk("a1", "ref-taptap", "无限大", "《无限大》正式上线", "新游上线", { facts: { taptapReserveCount: 20000 } }),
      mk("a2", "ref-haoyou", "无限大", "《无限大》即将上线", "新游上线", { facts: { haoyouKind: "upcoming", haoyouReserveCount: 5000 } }),
    ];
    const stmt = db.prepare(`INSERT INTO articles (id, source_id, source_name, title, game_name, category, detail_url, image_url, date_text, score, quality, discovered_at, paragraphs_json, facts_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rows) stmt.run(r.id, r.source_id, r.source_name, r.title, r.game_name, r.category, r.detail_url, r.image_url, r.date_text, r.score, r.quality, r.discovered_at, r.paragraphs_json, r.facts_json);
    upsertRating(db, { refType: "game", refId: "无限大", rating: "S · 重点", score: 80, gameName: "无限大", source: "manual" });
    const events = buildEvents(db);
    const ev = events.find((e) => e.game === "无限大");
    assert.ok(ev);
    assert.equal(ev.sourceId, "ref-taptap"); // 新游 TapTap 优先
    assert.equal(ev.grade, "S · 重点"); // 人工评级继承
    assert.equal(ev.ratingSource, "manual");
    db.close();
  });
});

describe("P5 评级来源优先级：manual > legacy_reference > auto", () => {
  test("legacy_reference 不压过 manual，也不被 auto 覆盖", () => {
    const db = memoryDb();
    ensureRatingsSchema(db);
    // 首次从飞书迁入旧评级 → legacy_reference
    upsertRating(db, { refType: "game", refId: "逆水寒", rating: "C · 留档", score: 0, gameName: "逆水寒", source: SOURCE_LEGACY, lastSeenGrade: "C · 留档", lastSeenAt: new Date().toISOString() });
    // 统一自动计算 → auto（S）
    upsertRating(db, { refType: "game", refId: "逆水寒", rating: "S · 重点", score: 80, gameName: "逆水寒", source: SOURCE_AUTO });
    assert.equal(getRatingByGame(db, "逆水寒").rating, "C · 留档"); // legacy 高于 auto
    assert.equal(getRatingByGame(db, "逆水寒").source, SOURCE_LEGACY);
    // 飞书人工修改 → manual（A）
    upsertRating(db, { refType: "game", refId: "逆水寒", rating: "A · 优先", score: 60, gameName: "逆水寒", source: SOURCE_MANUAL });
    assert.equal(getRatingByGame(db, "逆水寒").rating, "A · 优先"); // manual 最高
    assert.equal(getRatingByGame(db, "逆水寒").source, SOURCE_MANUAL);
    // 再次自动（B）不覆盖 manual
    upsertRating(db, { refType: "game", refId: "逆水寒", rating: "B · 常规", score: 45, gameName: "逆水寒", source: SOURCE_AUTO });
    assert.equal(getRatingByGame(db, "逆水寒").rating, "A · 优先");
    // 观测变化检测：飞书评级表该游戏改为 S → 判为人工修改
    const legacy = getRatingSource(db, "game", "逆水寒", SOURCE_LEGACY);
    assert.notEqual(legacy.last_seen_grade, "S · 重点"); // 旧观测为 C
    db.close();
  });
});

describe("P5 旧记录兼容匹配审计", () => {
  const ev = (type, game, title, time, url) => ({ type, game, title, content: title, time, dateKey: new Date(time).toISOString().slice(0, 10), sourceUrl: url, eventKey: `k-${game}-${type}` });
  const row = (recordId, type, game, time, title, url, eventId = "") => ({ record_id: recordId, fields: { "类型": type, "游戏名": game, "时间": time, "内容": title, "原文链接": url ? { link: url } : "", "事件ID": eventId } });
  test("事件ID 精确匹配→update；无匹配→safeNew；同 URL→exact", () => {
    const t = Date.now();
    const rows = [
      row("r1", "新游", "无限大", t, "无限大上线", "https://t/1", "k-无限大-新游"),
      row("r2", "新游", "王者荣耀", t, "王者荣耀新版本", "https://t/2"),
    ];
    const audit = auditExisting([ev("新游", "无限大", "无限大上线", t, "https://t/1"), ev("新游", "原神", "原神首发", t, "https://t/3")], rows);
    assert.equal(audit.stats.exact, 1);   // 无限大：事件ID 精确
    assert.equal(audit.stats.unmatched, 1); // 原神：无匹配
    assert.equal(audit.safeNew.length, 1);
    assert.equal(audit.update.length, 1);
  });
  test("歧义记录进入 ambiguous，不自动写", () => {
    const t = Date.now();
    // 一个本地事件匹配两条记录（多对一）
    const rows = [row("r1", "活动", "逆水寒", t, "逆水寒七夕活动开启", "https://t/1"), row("r2", "活动", "逆水寒", t, "逆水寒七夕活动上线", "https://t/2")];
    const audit = auditExisting([ev("活动", "逆水寒", "逆水寒七夕活动开启", t, "https://t/3")], rows);
    assert.equal(audit.ambiguous.length, 1);
    assert.equal(audit.ambiguityList.length, 1);
    assert.equal(audit.safeNew.length, 0);
  });
});

describe("P5 通知 S 级 fixture dry-run（不真实发送）", () => {
  test("sendSAAlerts dryRun 返回 planned，不触网不发送", async () => {
    const r = await sendSAAlerts({ items: [{ type: "新游", game: "测试游戏", grade: "S · 重点", title: "《测试游戏》首发", content: "简介", time: Date.now(), sourceUrl: "https://x/1", sourceName: "TapTap" }], dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.sent, false);
    assert.equal(r.planned.length, 1);
    assert.equal(r.planned[0].grade, "S · 重点");
    assert.equal(r.planned[0].type, "新游");
  });
});
