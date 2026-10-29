// Steam 适配器 —— 子进程调用保留的 GameNews 采集器（不重写），返回统一文章形状条目。
// 覆盖：新游候选（fetchSteamItems）+ 热玩/畅销榜（fetchSteamChartItems）。
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const GAMENEWS_STEAM = "E:/新建文件夹/Codex-GPT/GameNews/server/crawler/platforms/steam.js";

function runCapture(script) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 180000, maxBuffer: 12 * 1024 * 1024,
      cwd: "E:/新建文件夹/Codex-GPT/GameNews",
    }, (err, stdout, stderr) => {
      // 子进程内两路采集各自 try/catch；即使退出码非 0，若 stdout 已含完整 JSON 也接受（部分成功不判失败）
      try {
        const start = stdout.indexOf("{");
        if (start >= 0) {
          const json = JSON.parse(stdout.slice(start));
          return resolve(json);
        }
      } catch { /* stdout 无效，走下方错误分支 */ }
      if (err) return reject(new Error((stderr || err.message || "").slice(0, 500)));
      reject(new Error("Steam 采集无有效输出"));
    });
  });
}

const SCRIPT = `
  import { fetchSteamItems, fetchSteamChartItems } from ${JSON.stringify(pathToFileURL(GAMENEWS_STEAM).href)};
  const out = { newGames: [], charts: [], errors: [] };
  try { out.newGames = await fetchSteamItems({ maxCandidates: 24 }); } catch (e) { out.errors.push("newGames: " + e.message); }
  try { out.charts = await fetchSteamChartItems({ limit: 5 }); } catch (e) { out.errors.push("charts: " + e.message); }
  console.log(JSON.stringify(out));
`;

// 统一标题/游戏名清洗：Steam 官方名可能自带《》，构造标题时产生《《X》》嵌套，需展开
function normalizeSteamName(v) {
  return String(v || "").replace(/《《/g, "《").replace(/》》/g, "》").trim();
}

// 把子进程返回的 { newGames, charts, errors } 映射为统一文章形状条目（纯函数，可单测）
export function mapSteamPayload(payload) {
  const out = [];
  for (const it of payload.newGames || []) {
    out.push({
      legacy: `steam:catalog:${it.detailUrl || ""}`,
      title: normalizeSteamName(it.title), gameName: normalizeSteamName(it.gameName), category: it.category || "新游上线",
      detailUrl: it.detailUrl, imageUrl: it.imageUrl, dateText: it.dateText || "",
      paragraphs: it.paragraphs || [], tags: it.tags || [], score: it.score,
      facts: { steamList: "catalog", potentialScore: it.potentialScore, rejectReasons: it.rejectReasons, storePageStatus: it.storePageStatus },
    });
  }
  for (const it of payload.charts || []) {
    const listKind = it.listKind || (it.category?.includes("热玩") ? "most_played" : "top_selling_cn");
    out.push({
      legacy: `steam:${listKind}:${it.detailUrl || ""}`,
      title: normalizeSteamName(it.title), gameName: normalizeSteamName(it.gameName), category: it.category, detailUrl: it.detailUrl,
      imageUrl: it.imageUrl, dateText: it.dateText || "", paragraphs: it.paragraphs || [],
      tags: it.tags || [], score: it.score,
      facts: { steamList: listKind, steamSnapshotId: it.snapshotId, rankCurrent: it.rankCurrent, chartMetric: it.chartMetric, potentialScore: it.potentialScore },
    });
  }
  const errors = (payload.errors || []).join("; ");
  if (!out.length && errors) return { items: [], error: errors };
  return { items: out, error: "" };
}

// 返回统一文章形状条目（source_id=ref-steam）；单边失败不影响另一边，全部失败才报错。
export async function fetchItems() {
  const payload = await runCapture(SCRIPT);
  return mapSteamPayload(payload);
}
