import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 仅处理 2026-08-27 Unified 首次真实同步已审计确认的 33 条记录。
// 默认 dry-run；只有 --stage 才会写入飞书。不会访问“游戏评级”表，也不会发送机器人消息。
const UNIFIED_STAGE_RECORD_IDS = new Set([
  "recvttBNc2UEA8", "recvttBNc2zxC6", "recvttBNc2YDsP", "recvttBNc2ifHj", "recvttBNc2dApr",
  "recvttBNc2vCaD", "recvttBNc2Eeki", "recvttBNc26bDQ", "recvttBNc2fgRp", "recvttBNc2tMJA",
  "recvttBNc2Qf5O", "recvttBNc2gYrl", "recvttBNc2sKab", "recvttBNc2iWhK", "recvttBNc2f7Lh",
  "recvttBNc2a0Ok", "recvttBNc2NU1m", "recvttBNc2Az2W", "recvttBNc2D5Tr", "recvttBNc2z8Fd",
  "recvttBNc2lKC0", "recvttBNc2yxiH", "recvttBNc2Adfg", "recvttBNc25Msc", "recvttBNc2HuOm",
  "recvttBNc2huKr", "recvttBNc2cQmW", "recvttBNc2ZzeF", "recvttBNc2aTAK", "recvttBNc2TmND",
  "recvttBNc2TKhB", "recvttBNc26NUc", "recvttBNc2pHF4",
]);

const stage = process.argv.includes("--stage");

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `飞书请求失败：${response.status}`);
  return payload;
}

function isEmptyBusinessRow(fields = {}) {
  return ["游戏名", "标题", "内容", "原文链接", "时间", "平台", "厂商", "标签"].every((field) => {
    const value = fields[field];
    return value == null || value === "" || (Array.isArray(value) && value.length === 0);
  });
}

function desiredState(time) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Number(time || 0) < today.getTime() ? "历史" : "当前";
}

const appId = userEnv("FEISHU_MONITOR_APP_ID");
const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
const tableId = userEnv("FEISHU_MONITOR_TABLE_ID");
if (!appId || !appSecret || !appToken || !tableId) throw new Error("飞书监控配置不完整");

const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const base = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`;

const rows = [];
let pageToken = "";
do {
  const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
  const payload = await api(`${base}/records?page_size=500${suffix}`, { headers });
  rows.push(...(payload.data?.items || []));
  pageToken = payload.data?.page_token || "";
} while (pageToken);

const unifiedRows = rows.filter((row) => UNIFIED_STAGE_RECORD_IDS.has(row.record_id));
const missingExpectedIds = [...UNIFIED_STAGE_RECORD_IDS].filter((id) => !unifiedRows.some((row) => row.record_id === id));
const blankRows = rows.filter((row) => isEmptyBusinessRow(row.fields || {}));
const stateRepairs = rows
  .filter((row) => !UNIFIED_STAGE_RECORD_IDS.has(row.record_id))
  .filter((row) => String(row.fields?.["游戏名"] || "").trim())
  .filter((row) => !String(row.fields?.["记录状态"] || "").trim())
  .map((row) => ({ record_id: row.record_id, fields: { "记录状态": desiredState(row.fields?.["时间"]) } }));

if (unifiedRows.length !== UNIFIED_STAGE_RECORD_IDS.size || missingExpectedIds.length) {
  throw new Error(`安全中止：预期定位 ${UNIFIED_STAGE_RECORD_IDS.size} 条 Unified 记录，实际仅 ${unifiedRows.length} 条`);
}

let backupPath = "";
if (stage) {
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  backupPath = join(backupDir, `feishu-monitor-before-unified-contamination-repair-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    purpose: "清理已确认的 GameNewsUnified 首次同步污染；不包含游戏评级表。",
    rows,
    deleteRecordIds: [...UNIFIED_STAGE_RECORD_IDS, ...blankRows.map((row) => row.record_id)],
    stateRepairs,
  }, null, 2), "utf8");

  const deleteIds = [...new Set([...UNIFIED_STAGE_RECORD_IDS, ...blankRows.map((row) => row.record_id)])];
  for (let index = 0; index < deleteIds.length; index += 500) {
    await api(`${base}/records/batch_delete`, {
      method: "POST", headers,
      body: JSON.stringify({ records: deleteIds.slice(index, index + 500) }),
    });
  }
  for (let index = 0; index < stateRepairs.length; index += 100) {
    await api(`${base}/records/batch_update`, {
      method: "POST", headers,
      body: JSON.stringify({ records: stateRepairs.slice(index, index + 100) }),
    });
  }
}

console.log(JSON.stringify({
  mode: stage ? "stage" : "dry-run",
  totalRows: rows.length,
  unifiedContaminationRows: unifiedRows.length,
  blankRows: blankRows.length,
  stateRepairs: stateRepairs.length,
  backupPath,
  deleted: stage ? unifiedRows.length + blankRows.length : 0,
  stateUpdated: stage ? stateRepairs.length : 0,
  samples: unifiedRows.slice(-8).map((row) => ({
    recordId: row.record_id,
    游戏名: row.fields?.["游戏名"] || "",
    类型: row.fields?.["类型"] || "",
    平台: row.fields?.["平台"] || "",
  })),
}, null, 2));
