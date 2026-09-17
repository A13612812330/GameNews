import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
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

const fieldPayload = await api(`${base}/fields?page_size=100`, { headers });
const hasField = (fieldPayload.data?.items || []).some((field) => field.field_name === "入库时间");
if (!hasField) {
  await api(`${base}/fields`, {
    method: "POST",
    headers,
    body: JSON.stringify({ field_name: "入库时间", type: 5 }),
  });
}

const rows = [];
let pageToken = "";
do {
  const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
  const payload = await api(`${base}/records?page_size=500${suffix}`, { headers });
  rows.push(...(payload.data?.items || []));
  pageToken = payload.data?.page_token || "";
} while (pageToken);

const backupDir = join(process.cwd(), "data", "backups");
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `feishu-before-ingest-time-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows }, null, 2), "utf8");

const updates = rows
  .filter((row) => String(row.fields?.["游戏名"] || "").trim() && !row.fields?.["入库时间"])
  .map((row) => ({
    record_id: row.record_id,
    fields: { "入库时间": Number(row.created_time || Date.now()) },
  }));
for (let index = 0; index < updates.length; index += 100) {
  await api(`${base}/records/batch_update`, {
    method: "POST",
    headers,
    body: JSON.stringify({ records: updates.slice(index, index + 100) }),
  });
}

console.log(JSON.stringify({ fieldCreated: !hasField, totalRows: rows.length, backfilled: updates.length, backupPath }, null, 2));
