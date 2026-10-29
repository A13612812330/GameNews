// Steam 实时快照任务（P6）
// 保留 GameNews 现有采集器（不重写）：以子进程方式调用 GameNews 的 steam.js 榜单采集，
// 结果写入统一库 steam_snapshots（realtime，只追加）。失败则记录 crawl_run + 失败清单。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSteamWriter } from "../steam/realtime.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const GAMENEWS_STEAM = "file:///E:/新建文件夹/Codex-GPT/GameNews/server/crawler/platforms/steam.js";
const FAIL_LIST = path.join(ROOT, "output", "failures-P6.jsonl");

function logFail(entry) {
  fs.mkdirSync(path.dirname(FAIL_LIST), { recursive: true });
  fs.appendFileSync(FAIL_LIST, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

export async function runSteamSnapshot(db) {
  const startedAt = new Date().toISOString();
  const runId = `steam-${Date.now()}`;
  const script = `
    import { fetchSteamChartItems } from ${JSON.stringify(GAMENEWS_STEAM)};
    const items = await fetchSteamChartItems({ limit: 5 });
    console.log(JSON.stringify({ items }));
  `;
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile(process.execPath, ["--input-type=module", "-e", script], {
        timeout: 90000, maxBuffer: 8 * 1024 * 1024,
        cwd: "E:/新建文件夹/Codex-GPT/GameNews",
      }, (err, so, se) => (err ? reject(new Error((se || err.message).slice(0, 400))) : resolve({ stdout: so })));
    });
    const payload = JSON.parse(stdout.slice(stdout.indexOf("{")));
    const items = payload.items || [];
    if (!items.length) throw new Error("采集器返回空");
    const w = createSteamWriter(db);
    const snapAt = new Date().toISOString();
    let n = 0;
    for (const it of items) {
      const appid = Number(it.rankCurrent && /^\d+$/.test(String(it.appid || "")) ? it.appid : (it.appid || 0));
      const id = /\/app\/(\d+)/.exec(it.detailUrl || "")?.[1];
      const appId = Number(it.appid || id || 0);
      if (!appId) continue;
      w.upsertGame({ appid: appId, cnName: it.gameName || it.name, name: it.name, tags: (it.tags || []).join("/") });
      const metrics = { current_online: it.chartMetric?.currentPlayers, peak_online: it.chartMetric?.dailyPeak, rank: it.rankCurrent };
      n += w.saveSnapshot({ appid: appId, snapshotAt: snapAt, source: "game-news-steam", metrics, raw: it, grade: "realtime" });
    }
    db.prepare(`INSERT INTO crawl_runs (id, source_id, run_kind, started_at, finished_at, status, items_found, items_new, error)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(runId, "ref-steam", "steam", startedAt, new Date().toISOString(), "ok", items.length, n, null);
    return { ok: true, items: items.length, snapshots: n };
  } catch (e) {
    logFail({ task: "steam", runId, error: e.message });
    db.prepare(`INSERT INTO crawl_runs (id, source_id, run_kind, started_at, finished_at, status, items_found, items_new, error)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(runId, "ref-steam", "steam", startedAt, new Date().toISOString(), "failed", 0, 0, e.message);
    return { ok: false, error: e.message };
  }
}
