// API 合约测试（P1）：只读接口字段契约 + 管理接口
// 目标：Codex 前端依赖的字段稳定存在；空值不伪造（返回 null/空串由前端显示“待补”）。
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server/api-server.mjs";

let base = "";
let srv;
before(async () => {
  // 合约测试指向真实统一库（目标项目，含迁移数据）；只读 GET 不产生副作用。
  const { server } = createServer({ dbPath: "E:/新建文件夹/Codex-GPT/GameNewsUnified/data/game-news-unified.sqlite" });
  srv = server;
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));

describe("API 合约：资讯", () => {
  test("GET /api/articles 返回 items 数组与 total，字段齐全", async () => {
    const { status, body } = await get("/api/articles?limit=5");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
    assert.ok(body.total > 0);
    const a = body.items[0];
    for (const k of ["id", "source_id", "source_name", "title", "game_name", "category", "detail_url", "image_url", "date_text", "score", "review_status", "discovered_at", "excerpt"]) {
      assert.ok(k in a, `缺少字段 ${k}`);
    }
  });
  test("GET /api/articles/:id 返回完整详情（含 paragraphs）", async () => {
    const list = await get("/api/articles?limit=1");
    const id = list.body.items[0].id;
    const { status, body } = await get(`/api/articles/${encodeURIComponent(id)}`);
    assert.equal(status, 200);
    assert.ok("paragraphs" in body || "paragraphs_json" in body);
  });
});

describe("API 合约：来源 / 运行", () => {
  test("GET /api/sources 字段齐全", async () => {
    const { body } = await get("/api/sources");
    assert.ok(Array.isArray(body));
    for (const k of ["id", "name", "category", "enabled", "access_policy"]) assert.ok(k in body[0], `缺少 ${k}`);
  });
  test("GET /api/crawl-runs / publication-runs 为数组", async () => {
    assert.ok(Array.isArray((await get("/api/crawl-runs")).body));
    assert.ok(Array.isArray((await get("/api/publication-runs")).body));
  });
});

describe("API 合约：Steam", () => {
  test("GET /api/steam/games 含 appid/cn_name", async () => {
    const { body } = await get("/api/steam/games");
    assert.ok(Array.isArray(body));
    if (body.length) for (const k of ["appid", "cn_name", "name"]) assert.ok(k in body[0], `缺少 ${k}`);
  });
});

describe("API 合约：管理接口（P1 新增）", () => {
  test("GET /api/admin/tasks 返回真实任务配置", async () => {
    const { status, body } = await get("/api/admin/tasks");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body) && body.length >= 4);
    for (const t of body) {
      for (const k of ["id", "name", "rate", "desc", "enabled", "kind", "lastRun", "nextRun"]) assert.ok(k in t, `缺少 ${k}`);
    }
    const ids = body.map((t) => t.id);
    assert.ok(ids.includes("monitor") && ids.includes("daily-brief") && ids.includes("weekly") && ids.includes("steam"));
    assert.ok(body.find((t) => t.id === "daily-brief").nextRun !== null, "daily-brief 应可计算下次执行");
  });
  test("POST /api/admin/sources/run 诚实返回 501（爬虫未迁入）", async () => {
    const r = await fetch(base + "/api/admin/sources/run", { method: "POST" });
    assert.equal(r.status, 501);
  });
});
