/**
 * 「整源静默 0 条」告警的反证测试。
 *
 * 断言目标：连续 3 轮「完成但 0 条且无报错」必须产出告警；
 * 中途拿到数据或抓取失败必须清空连击，不得告警。
 * 任一条不成立即说明告警是假绿（永远不报）。
 *
 * 用法：node scripts/verify-silent-source-alert.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const streakFile = path.join(root, "data", "crawler", "zero-streak.json");
const backup = fs.existsSync(streakFile) ? fs.readFileSync(streakFile, "utf8") : null;

const { beginMonitor, finishMonitor, reportSourceProgress, standingAlerts } = await import(
  "../server/crawler/monitor.js"
);

const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label} → ${JSON.stringify(actual)}${ok ? "" : `（期望 ${JSON.stringify(expected)}）`}`);
  if (!ok) failures.push(label);
}

function reset() {
  try { fs.rmSync(streakFile, { force: true }); } catch {}
}

/** 跑一轮监控：给定每个来源的 (status, count)。 */
function runRound(operation, entries) {
  beginMonitor(operation, { stage: "list" });
  for (const entry of entries) reportSourceProgress(entry);
  finishMonitor({ stage: "completed", results: [] }, `${operation} 结束`);
}

try {
  reset();

  console.log("\n场景 1：健康源连续拿到数据，不应告警");
  for (let i = 1; i <= 4; i += 1) {
    runRound(`健康-${i}`, [{ sourceId: "ref-haoyou", sourceName: "好游快爆", urlType: "timeline", status: "completed", count: 46 }]);
  }
  check("alerts 为空", standingAlerts().length, 0);

  console.log("\n场景 2：静默源连续 2 轮 0 条（未到阈值），不应告警");
  reset();
  for (let i = 1; i <= 2; i += 1) {
    runRound(`静默-${i}`, [{ sourceId: "ref-taptap", sourceName: "TapTap", urlType: "upcoming", status: "completed", count: 0 }]);
  }
  check("alerts 为空", standingAlerts().length, 0);

  console.log("\n场景 3：第 3 轮仍为 0 条，必须告警");
  runRound("静默-3", [{ sourceId: "ref-taptap", sourceName: "TapTap", urlType: "upcoming", status: "completed", count: 0 }]);
  const alerts3 = standingAlerts();
  check("alerts 条数", alerts3.length, 1);
  check("告警来源", alerts3[0]?.sourceId, "ref-taptap");
  check("告警 urlType", alerts3[0]?.urlType, "upcoming");
  check("连击轮数", alerts3[0]?.streak, 3);

  console.log("\n场景 4：静默源中途恢复数据，连击必须清零");
  runRound("恢复-1", [{ sourceId: "ref-taptap", sourceName: "TapTap", urlType: "upcoming", status: "completed", count: 4 }]);
  check("alerts 为空", standingAlerts().length, 0);

  console.log("\n场景 5：抓取失败（已带 error）不算静默，不得堆连击");
  reset();
  for (let i = 1; i <= 4; i += 1) {
    runRound(`失败-${i}`, [{ sourceId: "ref-taptap", sourceName: "TapTap", urlType: "upcoming", status: "failed", count: 0, error: "HTTP 500" }]);
  }
  check("alerts 为空", standingAlerts().length, 0);

  console.log("\n场景 6：多来源混合，只有静默源进入告警");
  reset();
  for (let i = 1; i <= 3; i += 1) {
    runRound(`混合-${i}`, [
      { sourceId: "ref-taptap", sourceName: "TapTap", urlType: "hashtags", status: "completed", count: 0 },
      { sourceId: "ref-haoyou", sourceName: "好游快爆", urlType: "timeline", status: "completed", count: 46 },
      { sourceId: "ref-gcores", sourceName: "机核", urlType: "gcores", status: "completed", count: 3 },
    ]);
  }
  const mixed = standingAlerts();
  check("alerts 条数", mixed.length, 1);
  check("告警 urlType", mixed[0]?.urlType, "hashtags");
} finally {
  // 恢复现场：探测用的连击文件不能污染真实监控状态。
  if (backup === null) { try { fs.rmSync(streakFile, { force: true }); } catch {} }
  else { fs.writeFileSync(streakFile, backup); }
}

console.log(failures.length ? `\n❌ 反证失败 ${failures.length} 项：${failures.join("；")}` : "\n✅ 全部断言通过");
process.exit(failures.length ? 1 : 0);
