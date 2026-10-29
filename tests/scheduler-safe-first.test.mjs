// 受控重启测试：safe-first 播种后 interval 任务首个周期不触发；runAt 任务不受影响
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TASKS } from "../server/tasks/config.mjs";
import { seedSafeFirst, isDue, summarizeResult } from "../server/tasks/scheduler.mjs";

describe("受控重启：safe-first 播种", () => {
  test("interval 任务播种后首个周期内不立即触发", () => {
    const now = new Date(2026, 7, 28, 10, 0, 0, 0); // 10:00（在 monitor activeHours 8-23 内）
    const seeded = seedSafeFirst(TASKS, now);
    const monitor = TASKS.find((t) => t.id === "monitor");
    const steam = TASKS.find((t) => t.id === "steam");
    assert.ok(seeded.includes(`monitor(${monitor.intervalMinutes}min)`));
    assert.ok(seeded.includes(`steam(${steam.intervalMinutes}min)`));
    assert.equal(isDue(monitor, now), false, "播种后立即不应触发 monitor");
    const later = new Date(now.getTime() + monitor.intervalMinutes * 60000);
    assert.equal(isDue(monitor, later), true, "一个周期后应触发 monitor");
  });
  test("runAt 型任务（简讯 09:30）不受播种影响，到点仍触发", () => {
    const now = new Date(2026, 7, 28, 9, 30, 0, 0);
    const brief = TASKS.find((t) => t.id === "daily-brief");
    seedSafeFirst(TASKS, now);
    assert.equal(isDue(brief, now), true);
  });
});

describe("受控重启：日志仅保留摘要", () => {
  test("monitor 摘要只含来源状态与飞书统计，不含完整同步对象/事件正文", () => {
    const verbose = {
      summary: [{ source: "ref-taptap", status: "ok", found: 5, new: 2 }, { source: "ref-steam", status: "partial", found: 3, new: 1 }],
      feishu: { inserted: 3, actualUpdated: 1, skippedAmbiguous: 2, alertCount: 1, queuedAlerts: 1, notification: { attempted: 1, sent: true, messages: [{ messageId: "om_x", type: "新游", game: "游戏A" }], failed: 0 }, createdRecords: [{ fields: { "类型": "新游", "游戏名": "游戏A", "内容": "超长正文" } }], audit: { stats: { total: 999 } } },
    };
    const s = summarizeResult("monitor", verbose);
    assert.deepEqual(s.sources, ["ref-taptap:ok:5/2", "ref-steam:partial:3/1"]);
    assert.equal(s.feishu.inserted, 3);
    assert.equal(s.feishu.sent, 1);
    assert.equal(JSON.stringify(s).includes("om_x"), false, "摘要不应含飞书消息ID");
    assert.equal(JSON.stringify(s).includes("超长正文"), false, "摘要不应含事件正文");
    assert.equal(JSON.stringify(s).includes("audit"), false, "摘要不应含审计对象");
  });
  test("daily-brief 摘要只含文件路径与海报状态", () => {
    const s = summarizeResult("daily-brief", { posterFile: "/output/x.html", poster: { skipped: true, reason: "凭据不完整" } });
    assert.deepEqual(s, { file: "/output/x.html", poster: "skipped" });
  });
});
