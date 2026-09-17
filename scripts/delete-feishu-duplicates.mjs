import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim(); } catch { return ""; }
}
const appId = userEnv("FEISHU_MONITOR_APP_ID");
const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
const tableId = userEnv("FEISHU_MONITOR_TABLE_ID");
if (!appId || !appSecret || !appToken || !tableId) throw new Error("飞书配置不完整");

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
}
function urlKey(value = "") {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return String(value || "").trim(); }
}
function norm(value = "") { return String(value).toLowerCase().replace(/[《》【】\[\]（）()\s\-_:：·・,，。！!？?「」]/gu, ""); }
function ratingOrder(value = "") { const x = String(value); return x.startsWith("S") ? 4 : x.startsWith("A") ? 3 : x.startsWith("B") ? 2 : 1; }
function isX7(row) { return /x7sy\.com\/game\/app\//iu.test(row.fields?.["原文链接"]?.link || "") || String(row.fields?.["平台"] || "") === "小七"; }
function groupKey(row) {
  const url = urlKey(row.fields?.["原文链接"]?.link || "");
  if (!url) return "";
  return isX7(row) ? `${url}|${Number(row.fields?.["时间"] || 0)}` : url;
}
function keepScore(row) {
  const f = row.fields || {};
  return ratingOrder(f["评级"]) * 1_000_000
    + Number(f["评分"] || 0) * 10_000
    + String(f["内容"] || "").trim().length * 10
    + String(f["标签"] || "").trim().length
    + String(f["厂商"] || "").trim().length;
}

const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const tableBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`;
const rows = [];
let pageToken = "";
do {
  const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
  const payload = await api(`${tableBase}/records?page_size=500${suffix}`, { headers });
  rows.push(...(payload.data?.items || []));
  pageToken = payload.data?.page_token || "";
} while (pageToken);

const backupDir = join(process.cwd(), "data", "backups");
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `feishu-before-delete-duplicates-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), tableId, rows }, null, 2), "utf8");

const groups = new Map();
for (const row of rows) {
  if (!String(row.fields?.["游戏名"] || "").trim()) continue;
  const key = groupKey(row);
  if (!key) continue;
  const list = groups.get(key) || [];
  list.push(row);
  groups.set(key, list);
}
const deleteIds = [];
const kept = [];
for (const list of groups.values()) {
  if (list.length < 2) continue;
  const ordered = [...list].sort((a, b) => keepScore(b) - keepScore(a) || String(b.updated_time || "").localeCompare(String(a.updated_time || "")));
  kept.push(ordered[0]);
  deleteIds.push(...ordered.slice(1).map((row) => row.record_id));
}
for (let index = 0; index < deleteIds.length; index += 500) {
  await api(`${tableBase}/records/batch_delete`, {
    method: "POST", headers,
    body: JSON.stringify({ records: deleteIds.slice(index, index + 500) }),
  });
}
console.log(JSON.stringify({
  mode: "delete-feishu-duplicates",
  totalRows: rows.length,
  duplicateGroups: kept.length,
  deleted: deleteIds.length,
  kept: kept.length,
  backupPath,
  rule: "非小七按原文链接去重；小七按原文链接+上线时间去重；保留评级、评分、内容、标签、厂商更完整的一条",
}, null, 2));
