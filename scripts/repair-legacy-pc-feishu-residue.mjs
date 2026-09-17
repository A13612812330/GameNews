import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 飞书游戏库只保留手游监控来源：TapTap / 好游快爆 / 小七。
// 默认 dry-run；--stage 才会删除。删除前完整备份“数据表”和“游戏评级”表。
const PC_PLATFORMS = new Set(["Steam", "游民星空", "机核"]);
const DUPLICATE = {
  game: "胜利女神：新的希望",
  platform: "TapTap",
  eventDate: "2026-09-01",
  urlPattern: /taptap\.cn/iu,
};
const stage = process.argv.includes("--stage");

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim(); }
  catch { return ""; }
}
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `飞书请求失败：${response.status}`);
  return payload;
}
async function listRows(base, headers) {
  const rows = [];
  let pageToken = "";
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
    const payload = await api(`${base}/records?page_size=500${suffix}`, { headers });
    rows.push(...(payload.data?.items || []));
    pageToken = payload.data?.page_token || "";
  } while (pageToken);
  return rows;
}
function dateKey(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 100000000000 ? new Date(timestamp).toISOString().slice(0, 10) : "";
}

const [appId, appSecret, appToken, mainTableId] = ["FEISHU_MONITOR_APP_ID", "FEISHU_MONITOR_APP_SECRET", "FEISHU_MONITOR_APP_TOKEN", "FEISHU_MONITOR_TABLE_ID"].map(userEnv);
if (!appId || !appSecret || !appToken || !mainTableId) throw new Error("飞书监控配置不完整");
const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const appBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}`;
const tables = (await api(`${appBase}/tables?page_size=100`, { headers })).data?.items || [];
const ratingTable = tables.find((table) => table.name === "游戏评级");
if (!ratingTable?.table_id) throw new Error("未找到游戏评级表");
const [mainRows, ratingRows] = await Promise.all([
  listRows(`${appBase}/tables/${mainTableId}`, headers),
  listRows(`${appBase}/tables/${ratingTable.table_id}`, headers),
]);
const mainPcRows = mainRows.filter((row) => PC_PLATFORMS.has(String(row.fields?.["平台"] || "").trim()));
const ratingPcRows = ratingRows.filter((row) => PC_PLATFORMS.has(String(row.fields?.["平台"] || "").trim()));
const duplicateRows = mainRows.filter((row) => {
  const fields = row.fields || {};
  return String(fields["游戏名"] || "").trim() === DUPLICATE.game
    && String(fields["平台"] || "").trim() === DUPLICATE.platform
    && dateKey(fields["时间"]) === DUPLICATE.eventDate
    && DUPLICATE.urlPattern.test(String(fields["原文链接"]?.link || ""));
});
if (mainPcRows.length !== 36 || ratingPcRows.length !== 36 || duplicateRows.length !== 1) {
  throw new Error(`安全中止：预期主表端游36/评级端游36/重复1，实际为 ${mainPcRows.length}/${ratingPcRows.length}/${duplicateRows.length}`);
}

let backupPath = "";
if (stage) {
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  backupPath = join(backupDir, `feishu-before-legacy-pc-residue-repair-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    purpose: "清理数据表和游戏评级中的端游/资讯残留；按活动优先级删除胜利女神 TapTap 备用活动。",
    mainRows, ratingRows,
    deleteMainRecordIds: [...mainPcRows, ...duplicateRows].map((row) => row.record_id),
    deleteRatingRecordIds: ratingPcRows.map((row) => row.record_id),
  }, null, 2), "utf8");
  const deleteRows = async (tableId, ids) => {
    for (let index = 0; index < ids.length; index += 500) {
      await api(`${appBase}/tables/${tableId}/records/batch_delete`, { method: "POST", headers, body: JSON.stringify({ records: ids.slice(index, index + 500) }) });
    }
  };
  await deleteRows(mainTableId, [...mainPcRows, ...duplicateRows].map((row) => row.record_id));
  await deleteRows(ratingTable.table_id, ratingPcRows.map((row) => row.record_id));
}

console.log(JSON.stringify({
  mode: stage ? "stage" : "dry-run",
  mainPcRows: mainPcRows.length,
  ratingPcRows: ratingPcRows.length,
  duplicateRemoved: stage ? duplicateRows.length : 0,
  backupPath,
  mainDeleted: stage ? mainPcRows.length + duplicateRows.length : 0,
  ratingDeleted: stage ? ratingPcRows.length : 0,
}, null, 2));
