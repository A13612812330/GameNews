import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { createSteamWriter } from "../server/steam/realtime.mjs";
import { createAppIdMap } from "../server/steam/appid-map.mjs";
import { createAnalysisService } from "../server/ai/analysis.mjs";
import { PROMPT_VERSIONS, TARGET_TYPES } from "../server/ai/config.mjs";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE games (
      appid INTEGER PRIMARY KEY, cn_name TEXT, name TEXT, developer TEXT, tags TEXT,
      release_date TEXT, installed_size TEXT, is_indie INTEGER, min_config TEXT,
      recommended_config TEXT, first_seen_at TEXT, updated_at TEXT, imported_batch TEXT
    );
    CREATE TABLE steam_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, appid INTEGER NOT NULL, snapshot_at TEXT NOT NULL,
      snapshot_source TEXT NOT NULL, metric_name TEXT NOT NULL, metric_value TEXT, raw_json TEXT,
      data_grade TEXT NOT NULL DEFAULT 'history',
      UNIQUE (appid, snapshot_at, snapshot_source, metric_name)
    );
    CREATE TABLE game_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, appid INTEGER, alias TEXT NOT NULL, alias_type TEXT NOT NULL, UNIQUE (alias, alias_type));
    CREATE TABLE ai_analyses (
      id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      input_snapshot_json TEXT, model TEXT, prompt_version TEXT, conclusion TEXT,
      confidence REAL, manual_override TEXT, manual_override_at TEXT, created_at TEXT NOT NULL,
      UNIQUE (target_type, target_id, prompt_version)
    );
    CREATE TABLE articles (id TEXT PRIMARY KEY, title TEXT, score INTEGER);
  `);
  return db;
}

describe("STEAM-01 快照只追加", () => {
  test("同一 AppID 连续两次采集 -> 两条快照均在，历史不覆盖", () => {
    const db = memoryDb();
    const w = createSteamWriter(db);
    const appid = 4108000;
    w.saveSnapshot({ appid, snapshotAt: "2026-08-26T00:00:00.000Z", metrics: { current_online: "1514" } });
    w.saveSnapshot({ appid, snapshotAt: "2026-08-26T06:00:00.000Z", metrics: { current_online: "1820" } });
    const rows = db.prepare("SELECT * FROM steam_snapshots WHERE appid=?").all(appid);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].metric_value, "1514");
    assert.equal(rows[1].metric_value, "1820");
    db.close();
  });
  test("upsertGame 幂等且不覆盖已有非空字段", () => {
    const db = memoryDb();
    const w = createSteamWriter(db);
    w.upsertGame({ appid: 550, cnName: "求生之路2", name: "Left 4 Dead 2", developer: "Valve" });
    w.upsertGame({ appid: 550, cnName: null, name: "Left 4 Dead 2", developer: null, tags: "co-op" });
    const g = db.prepare("SELECT * FROM games WHERE appid=550").get();
    assert.equal(g.cn_name, "求生之路2"); // 不被 null 覆盖
    assert.equal(g.developer, "Valve");
    assert.equal(g.tags, "co-op"); // 新字段补充
    db.close();
  });
});

describe("AppID 映射", () => {
  test("cn/en 别名均能解析到 AppID；未知返回 null", () => {
    const db = memoryDb();
    db.prepare("INSERT INTO games (appid, cn_name, name) VALUES (550,'求生之路2','Left 4 Dead 2')").run();
    db.prepare("INSERT INTO game_aliases (appid, alias, alias_type) VALUES (550,'求生之路2','cn'),(550,'L4D2','search')").run();
    const map = createAppIdMap(db);
    assert.equal(map.resolve("求生之路2"), 550);
    assert.equal(map.resolve("Left 4 Dead 2"), 550);
    assert.equal(map.resolve("L4D2"), 550);
    assert.equal(map.resolve("不存在的游戏"), null);
    db.close();
  });
});

describe("AI-01 分析与人工修正", () => {
  test("记录 AI 分析：原始数据不变；人工结果优先；有版本与时间", () => {
    const db = memoryDb();
    db.prepare("INSERT INTO articles (id, title, score) VALUES ('a1','测试',50)").run();
    const svc = createAnalysisService(db);
    const r = svc.run({
      targetType: "article", targetId: "a1",
      input: { title: "测试", score: 50 },
      model: "pending-config", promptVersion: PROMPT_VERSIONS[0].version,
      conclusion: "S", confidence: 0.8,
    });
    assert.equal(r.prompt_version, "v0-unconfigured");
    assert.ok(r.created_at);
    // 原始数据未被修改
    assert.equal(db.prepare("SELECT * FROM articles WHERE id='a1'").get().score, 50);
    // 人工修正优先
    const over = svc.override("article", "a1", "A", "编辑确认");
    assert.equal(over.manual_override, "A（编辑确认）");
    // 提示词版本登记完整
    assert.ok(PROMPT_VERSIONS.length >= 1);
    assert.deepEqual(TARGET_TYPES, ["article", "game", "event"]);
    db.close();
  });
  test("无 AI 记录时人工覆盖也持久化", () => {
    const db = memoryDb();
    const svc = createAnalysisService(db);
    const r = svc.override("game", "4108000", "S");
    assert.equal(r.manual_override, "S");
    assert.equal(r.prompt_version, "manual-override");
    db.close();
  });
});
