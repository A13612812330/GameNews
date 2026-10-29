// 爬虫回归测试（P2）：x7 解析 + 游民/机核列表解析 + 注册表
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { parseApiPage } from "../server/crawler/x7.mjs";
import { ADAPTERS } from "../server/crawler/registry.mjs";
import { parseGamerskyListDate, parseGcoresListDate, isTodayOrFutureNewsDate } from "../server/crawler/pc-news.mjs";
import * as pcNews from "../server/crawler/pc-news.mjs";
import * as hykb from "../server/crawler/hykb.mjs";
import * as taptap from "../server/crawler/taptap.mjs";
import { mapSteamPayload } from "../server/crawler/steam.mjs";

function stubFetch(html) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html });
  return () => { globalThis.fetch = orig; };
}

// x7 API 载荷样本（结构仿真实响应，日期取近期未来以便通过 7 天窗口）
function samplePayload() {
  const near = new Date();
  near.setDate(near.getDate() + 2);
  const ts = Math.floor(near.getTime() / 1000);
  const date = `${near.getFullYear()}年${near.getMonth() + 1}月${near.getDate()}日10:00首发`;
  return {
    data: { list: [{ gameData: { gid: 12345, showName: "明日方舟：终末地", onlineTimeText: date, labels: [{ labelName: "策略" }, { labelName: "二次元" }], gameLogo: "/logo.png" }, serviceTime: ts, subscribeData: { subscribeCount: 52000 } }] },
  };
}

describe("x7 适配器解析", () => {
  test("parseApiPage 产出统一条目字段", () => {
    const items = parseApiPage(samplePayload());
    assert.ok(items.length === 1);
    const it = items[0];
    assert.equal(it.gameName, "明日方舟：终末地");
    assert.equal(it.category, "新游上线");
    assert.ok(it.detailUrl.includes("/game/app/12345"));
    assert.ok(it.dateText.includes("首发"));
    assert.equal(it.facts.x7ReserveCount, 52000);
    assert.deepEqual(it.tags, ["策略", "二次元"]);
  });
  test("未来窗口之外的记录被过滤", () => {
    const p = samplePayload();
    p.data.list[0].serviceTime = Math.floor(Date.now() / 1000) - 30 * 86400; // 30 天前
    assert.equal(parseApiPage(p).length, 0);
  });
});

describe("游民/机核 解析（pc-news）", () => {
  test("日期工具：刚刚=今日；x 天前=已过去被过滤", () => {
    assert.ok(isTodayOrFutureNewsDate(parseGcoresListDate("刚刚")));
    assert.equal(isTodayOrFutureNewsDate(parseGcoresListDate("3天前")), false);
    const d = parseGamerskyListDate("2026-08-27 10:30");
    assert.ok(d instanceof Date);
  });
  test("游民列表解析：卡片含标题/原文链接/游戏名", async () => {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} 10:30`;
    const html = `<!--filler-->${"x".repeat(260)}<ul><li>
      <div class="tit"><a class="tt" href="/news/202608/123456.shtml" title="《怪物猎人：荒野》官方公布最新更新预告">《怪物猎人：荒野》官方公布最新更新预告</a></div>
      <div class="tem"><span class="time">${stamp}</span></div>
      <div class="img"><img src="/pic/a.jpg"></div>
      <div class="con"><div class="txt">官方公布全新更新内容与联动详情。</div></div>
    </li></ul>`;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html });
    try {
      const { items } = await pcNews.fetchGamerskyItems();
      assert.equal(items.length, 1);
      assert.equal(items[0].gameName, "怪物猎人：荒野");
      assert.ok(items[0].detailUrl.includes("gamersky.com"));
      assert.equal(items[0].category, "行业资讯");
    } finally { globalThis.fetch = orig; }
  });
  test("机核列表解析：卡片含标题/原文链接", async () => {
    const html = `<!--filler-->${"y".repeat(260)}<div><a class="news" href="/articles/123456"><div class="news_imgArea" style="background:url('/images/a.jpg')"></div><h3>《黑神话：悟空》官方发布新更新</h3><div class="news_meta"><span>刚刚</span></div></a></div>`;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html });
    try {
      const { items } = await pcNews.fetchGcoresItems();
      assert.equal(items.length, 1);
      assert.equal(items[0].gameName, "黑神话：悟空");
      assert.ok(items[0].detailUrl.includes("gcores.com"));
    } finally { globalThis.fetch = orig; }
  });
});

describe("好游/TapTap 解析（SSR 直取）", () => {
  test("好游时间线：panelTab rel + foreCard 解析出新游", async () => {
    const near = new Date(); near.setDate(near.getDate() + 1);
    const md = `${near.getMonth() + 1}月${near.getDate()}日`;
    const html = `<!--f-->${"z".repeat(260)}<div id="panelTab"><li rel="1"></li><li rel="2"></li><li rel="3"></li></div>
      <div class="panelList">
        <div class="foreArea"><div class="foreCard" rel="now"><div class="foreCard-hd">${md}（明天）</div><ul class="foreList">
          <li><a href="/a/12345.htm"><div class="name"><em>《明日方舟：终末地》</em></div><div class="tags"><span class="it">策略</span><span class="it">二次元</span></div><div class="info"><span class="score">9.2</span>开启公测预约</div><div class="img"><img data-src="/img.jpg"></div></a></li>
        </ul></div></div>
        <div class="foreArea"></div><div class="foreArea"></div>
      </div>`;
    const restore = stubFetch(html);
    try {
      const { items } = await hykb.fetchHykbItems();
      assert.equal(items.length, 1);
      assert.equal(items[0].gameName, "明日方舟：终末地");
      assert.equal(items[0].category, "新游上线");
      assert.ok(items[0].detailUrl.includes("3839.com/a/12345.htm"));
      assert.deepEqual(items[0].tags, ["策略", "二次元"]);
    } finally { restore(); }
  });
  test("好游更新动态：仅取第一条当前更新；游戏名清洗运营后缀", async () => {
    const near = new Date(); near.setDate(near.getDate() + 1);
    const md = `${near.getMonth() + 1}月${near.getDate()}日`;
    const html = `<!--f-->${"u".repeat(260)}<div id="panelTab"><li rel="1"></li><li rel="2"></li><li rel="3"></li></div>
      <div class="panelList">
        <div class="foreArea"></div><div class="foreArea"></div>
        <div class="foreArea"><div class="foreCard" rel="now"><div class="foreCard-hd">${md}（明天）</div><ul class="foreList">
          <li><a href="/a/111.htm"><div class="name"><em>超自然行动组-送高泰明时装</em></div><div class="info"><span class="score">8.0</span>限时活动开启</div></a></li>
          <li><a href="/a/222.htm"><div class="name"><em>卡拉彼丘-手游</em></div><div class="info">全新赛季开启</div></a></li>
        </ul></div></div>
      </div>`;
    const restore = stubFetch(html);
    try {
      const { items } = await hykb.fetchHykbItems();
      assert.equal(items.length, 1); // update 面板仅取第一条
      assert.equal(items[0].gameName, "超自然行动组"); // -送X时装 后缀已清洗
      assert.equal(items[0].category, "版本更新");
    } finally { restore(); }
  });
  test("TapTap contentFilter：游戏资讯通过、讨论/攻略/日期导航剔除", () => {
    assert.ok(taptap.contentFilter("《黑神话：悟空》官方宣布DLC定档明年"));
    assert.ok(taptap.contentFilter("《崩坏：星穹铁道》3.0版本更新公告"));
    assert.equal(taptap.contentFilter("求助：这个Boss怎么打"), false);
    assert.equal(taptap.contentFilter("攻略合集：新手必看"), false);
    assert.equal(taptap.contentFilter("今日"), false);
  });
  test("Steam mapSteamPayload：catalog 与 charts 映射为统一条目；全部失败才报错", () => {
    const r = mapSteamPayload({
      newGames: [{ title: "《新作A》上线", gameName: "新作A", detailUrl: "/app/1001", score: 80 }],
      charts: [{ title: "《《NBA 2K27》》Steam 畅销榜（中国区） #3", gameName: "《NBA 2K27》", detailUrl: "/app/1002", category: "Steam 热玩榜", rankCurrent: 1 }],
      errors: ["newGames: x"],
    });
    assert.equal(r.items.length, 2);
    assert.equal(r.error, "");
    assert.equal(r.items[0].legacy, "steam:catalog:/app/1001");
    assert.equal(r.items[1].facts.steamList, "most_played");
    // Steam 官方名自带《》时，标题/游戏名中的嵌套书名号应被展开（单层书名号保留原名）
    assert.equal(r.items[1].title, "《NBA 2K27》Steam 畅销榜（中国区） #3");
    assert.equal(r.items[1].gameName, "《NBA 2K27》");
    const fail = mapSteamPayload({ newGames: [], charts: [], errors: ["全部失败"] });
    assert.equal(fail.items.length, 0);
    assert.match(fail.error, /全部失败/);
  });
});

describe("爬虫注册表", () => {
  test("六个来源全部可运行", () => {
    for (const id of ["ref-x7", "ref-steam", "ref-gamersky", "ref-gcores", "ref-haoyou", "ref-taptap"]) {
      assert.equal(ADAPTERS[id].runnable, true, `${id} 应可运行`);
    }
  });
  test("统一库 sources 表存在 ref-x7", () => {
    const db = new DatabaseSync("E:/新建文件夹/Codex-GPT/GameNewsUnified/data/game-news-unified.sqlite", { readOnly: true });
    const s = db.prepare("SELECT * FROM sources WHERE id='ref-x7'").get();
    assert.ok(s && s.name === "小七");
    db.close();
  });
});
