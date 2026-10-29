// 回归测试：TapTap 话题/资讯内容误入"新游"分类（修复后应被隔离）
// 场景：热榜话题帖（门票开售/访谈/停服）不得成为 新游；活动信号 → 活动；真生命周期 → 新游。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { eventType } from "../server/feishu/algorithm.mjs";
import { buildEvents } from "../server/feishu/sync.mjs";

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

describe("回归：TapTap 话题/资讯不再误入新游", () => {
  test("话题/资讯帖（门票/访谈/停服）→ 资讯(null)", () => {
    assert.equal(eventType({ sourceId: "ref-taptap", title: "TapTap玩聚节二轮门票开售", category: "新游上线", facts: {} }), null);
    assert.equal(eventType({ sourceId: "ref-taptap", title: "米哈游大伟哥谈源初之结", category: "新游上线", facts: {} }), null);
    assert.equal(eventType({ sourceId: "ref-taptap", title: "# 晴空之下母公司破产清算再度停服", category: "新游上线", facts: {} }), null);
  });
  test("活动信号（周年/活动/版本/联动）→ 活动", () => {
    assert.equal(eventType({ sourceId: "ref-taptap", title: "# 阴阳师十周年活动公布", category: "新游上线", facts: {} }), "活动");
    assert.equal(eventType({ sourceId: "ref-taptap", title: "《千机阵》2.3 新版本", category: "版本更新", facts: {} }), "活动");
  });
  test("真生命周期（定档/首发/测试）仍为新游", () => {
    assert.equal(eventType({ sourceId: "ref-taptap", title: "# 无限大定档1月15日", category: "新游上线", facts: {} }), "新游");
    assert.equal(eventType({ sourceId: "ref-taptap", title: "《排兵布阵》今天10点 首发", category: "新游上线", facts: {} }), "新游");
    assert.equal(eventType({ sourceId: "ref-taptap", title: "《X》8月21日首发", facts: {} }), "新游"); // 既有断言不破坏
    assert.equal(eventType({ sourceId: "ref-taptap", title: "正式上线", facts: { taptapEvents: [{ title: "周年活动" }] } }), "活动"); // 既有断言不破坏
  });
  test("非 TapTap 来源行为不受影响", () => {
    assert.equal(eventType({ sourceId: "ref-haoyou", title: "版本", facts: { haoyouKind: "update" } }), "活动");
    assert.equal(eventType({ sourceId: "ref-x7", title: "预约新游", facts: {} }), "新游");
  });
});

describe("回归：buildEvents 集成（话题不产生新游事件）", () => {
  test("话题行被隔离；定档行产生新游事件", () => {
    const db = memoryDb();
    const stmt = db.prepare(`INSERT INTO articles (id, source_id, source_name, title, game_name, category, detail_url, image_url, date_text, score, quality, discovered_at, paragraphs_json, facts_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const rows = [
      ["t1", "ref-taptap", "TapTap", "TapTap玩聚节二轮门票开售", "发现好游戏", "新游上线", "https://t/1", "", today, 70, "ok", `${today}T02:00:00`, JSON.stringify(["玩聚节门票开售资讯"]), "{}"],
      ["t2", "ref-taptap", "TapTap", "# 无限大定档1月15日", "无限大", "新游上线", "https://t/2", "", today, 70, "ok", `${today}T02:00:00`, JSON.stringify(["定档1月15日"]), "{}"],
    ];
    for (const r of rows) stmt.run(...r);
    const events = buildEvents(db);
    const games = events.map((e) => e.game);
    assert.ok(!games.includes("发现好游戏"), "话题行不应成为事件");
    const ding = events.find((e) => e.game === "无限大");
    assert.ok(ding, "定档行应产生事件");
    assert.equal(ding.type, "新游");
    db.close();
  });
});
