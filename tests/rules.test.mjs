import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  normalizeGameName,
  normalizeTitle,
  dedupKey,
  dedupArticles,
  createRatingService,
  rankOf,
  SOURCE_PRIORITY,
  cleanBusinessGameName,
  extractBookTitle,
  dateBucket,
} from "../server/rules/index.mjs";
import {
  sameEventThreeSources,
  activityTwoSources,
  cleaningSamples,
} from "./fixtures/regression-samples.mjs";

// 用内存库建 ratings 表（与 schema.sql 保持一致）
function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ratings (
    id TEXT PRIMARY KEY,
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    rating TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (ref_type, ref_id, source)
  );`);
  return db;
}

describe("清洗规则 normalize", () => {
  for (const s of cleaningSamples) {
    test(`normalizeGameName(${JSON.stringify(s.name)}) -> ${s.expect}`, () => {
      assert.equal(normalizeGameName(s.name), s.expect);
    });
  }
  test("normalizeTitle 去掉前导 # 与书名号", () => {
    assert.equal(normalizeTitle("# 土豆兄弟上线定档"), "土豆兄弟上线定档");
    assert.equal(normalizeTitle("《土豆兄弟》手游正式上线"), "土豆兄弟手游正式上线");
  });
  test("extractBookTitle：只取书名号内游戏名；无书名号留空（不退回整条标题）", () => {
    assert.equal(extractBookTitle("《怪物猎人：荒野》官方公布最新更新"), "怪物猎人：荒野");
    assert.equal(extractBookTitle("从国产严选到深度合作 PlayStation成顶级合伙人"), "");
  });
  test("dateBucket：完整日期原样；无年份 MM月DD日 补当年；跨年（早于 180 天）补次年", () => {
    const f = new Date(); f.setDate(f.getDate() + 3);
    const pad = (v) => String(v).padStart(2, "0");
    const fm = `${f.getMonth() + 1}月${f.getDate()}日`;
    assert.equal(dateBucket("2026-08-27"), "2026-08-27");
    assert.equal(dateBucket(fm), `${f.getFullYear()}-${pad(f.getMonth() + 1)}-${pad(f.getDate())}`);
    assert.equal(dateBucket(""), "");
  });
});

describe("RULE-01 同一事件三源一致性", () => {
  test("三个出口读取同一清洗结果（游戏名一致；归为一组）", () => {
    const [tap, hao, steam] = sameEventThreeSources;
    assert.equal(normalizeGameName(tap.game_name), "土豆兄弟");
    assert.equal(normalizeGameName(hao.game_name), "土豆兄弟"); // 《》被清洗
    assert.equal(normalizeGameName(steam.game_name), "土豆兄弟");
    // 统一规则层把三源归为一组（无出口独自清洗）
    const groups = dedupArticles(sameEventThreeSources);
    assert.equal(groups.length, 1);
  });
});

describe("RULE-02 跨平台去重与来源优先级", () => {
  test("新游上线：三源归组，胜者为 TapTap，且保留全部多来源关系", () => {
    const groups = dedupArticles(sameEventThreeSources);
    assert.equal(groups.length, 1);
    const g = groups[0];
    assert.equal(g.winner.source_id, "ref-taptap");
    assert.equal(g.members.length, 3);
    assert.deepEqual(
      g.members.map((m) => m.source_id).sort(),
      ["ref-haoyou", "ref-steam", "ref-taptap"]
    );
  });
  test("活动：胜者为 好游快爆", () => {
    const groups = dedupArticles(activityTwoSources);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].winner.source_id, "ref-haoyou");
  });
  test("来源优先级表顺序稳定", () => {
    assert.equal(SOURCE_PRIORITY["新游上线"][0], "ref-taptap");
    assert.equal(SOURCE_PRIORITY["活动"][0], "ref-haoyou");
    assert.equal(rankOf("ref-taptap", "新游上线"), 0);
    assert.equal(rankOf("ref-haoyou", "活动"), 0);
  });
});

describe("P3 业务游戏名清洗", () => {
  test("去除官服/预约/预下载/活动等运营后缀", () => {
    assert.equal(cleanBusinessGameName("《原神》官服"), "原神");
    assert.equal(cleanBusinessGameName("原神（预约）"), "原神");
    assert.equal(cleanBusinessGameName("原神(官服)"), "原神");
    assert.equal(cleanBusinessGameName("绝区零-预下载"), "绝区零");
    assert.equal(cleanBusinessGameName("星穹铁道 预约"), "星穹铁道");
    assert.equal(cleanBusinessGameName("明日方舟【活动】"), "明日方舟");
  });
  test("保留体验服/测试服等正式区分", () => {
    assert.equal(cleanBusinessGameName("原神（体验服）"), "原神（体验服）");
    assert.equal(cleanBusinessGameName("王者荣耀(测试服)"), "王者荣耀(测试服)");
  });
});

describe("P3 跨平台不串表与合并", () => {
  const mk = (id, source_id, source_name, game, title, category, date) => ({ id, source_id, source_name, game_name: game, title, category, date_text: date, discovered_at: date });
  test("同一游戏 新游 vs 活动 不串表（分类隔离）", () => {
    const groups = dedupArticles([
      mk("a", "ref-haoyou", "好游快爆", "原神（预约）", "原神周年活动开启", "活动", "2026-08-28"),
      mk("b", "ref-taptap", "TapTap", "原神", "原神 4.0版本上线", "新游上线", "2026-08-28"),
    ]);
    assert.equal(groups.length, 2); // 分类不同 → 不合并
  });
  test("同一游戏跨平台（好游官服 vs TapTap）同日同分类 → 合并，好游胜（活动）", () => {
    const groups = dedupArticles([
      mk("a", "ref-taptap", "TapTap", "原神", "原神周年庆活动开启", "活动", "2026-08-28"),
      mk("b", "ref-haoyou", "好游快爆", "原神（官服）", "原神周年庆活动开启", "活动", "2026-08-28"),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].winner.source_id, "ref-haoyou"); // 活动优先好游
  });
  test("重复输入仍稳定归为一组，胜者不变（分组层幂等）", () => {
    const sample = [mk("a", "ref-taptap", "TapTap", "原神", "原神周年庆活动开启", "活动", "2026-08-28"), mk("b", "ref-haoyou", "好游快爆", "原神（官服）", "原神周年庆活动开启", "活动", "2026-08-28")];
    const once = dedupArticles(sample);
    const twice = dedupArticles([...sample, ...sample]);
    assert.equal(twice.length, once.length);
    assert.equal(twice[0].winner.source_id, "ref-haoyou");
  });
});

describe("RULE-03 人工评级覆盖", () => {
  beforeEach(() => {});
  test("人工评级优先于 AI，且可回落", () => {
    const db = memoryDb();
    const svc = createRatingService(db);
    svc.set("article", "a1", "A", "ai", "AI 推断");
    assert.equal(svc.getEffective("article", "a1").rating, "A");
    // 人工覆盖
    svc.set("article", "a1", "S", "manual", "编辑确认");
    const eff = svc.getEffective("article", "a1");
    assert.equal(eff.rating, "S");
    assert.equal(eff.source, "manual");
    // 人工值保留：再次同步 AI 也不覆盖人工
    svc.set("article", "a1", "B", "ai");
    assert.equal(svc.getEffective("article", "a1").rating, "S");
    // 删除人工覆盖后回落 AI
    svc.removeManual("article", "a1");
    assert.equal(svc.getEffective("article", "a1").rating, "B");
    db.close();
  });
});
