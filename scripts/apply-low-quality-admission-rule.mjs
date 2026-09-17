import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stage = process.argv.includes("--stage");
const auditPath = join(process.cwd(), "output", "LOW_QUALITY_GAME_ENRICHED_AUDIT_2026-09-03.html");

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim(); } catch { return ""; }
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

const html = readFileSync(auditPath, "utf8");
const candidateIds = [...html.matchAll(/<tr><td>不收录<\/td>[\s\S]*?<code>([^<]+)<\/code><\/td><\/tr>/gu)].map((match) => match[1]);
if (!candidateIds.length) throw new Error("核对表中没有找到“不收录”记录，已安全中止");

const appId = userEnv("FEISHU_MONITOR_APP_ID");
const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
if (!appId || !appSecret || !appToken) throw new Error("飞书监控配置不完整");
const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const appBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}`;
const tables = (await api(`${appBase}/tables?page_size=100`, { headers })).data?.items || [];
const ratingTable = tables.find((table) => table.name === "游戏评级");
if (!ratingTable?.table_id) throw new Error("未找到游戏评级表");
const rows = await listRows(`${appBase}/tables/${ratingTable.table_id}`, headers);
const idSet = new Set(candidateIds);
const deletions = rows.filter((row) => idSet.has(row.record_id));
if (deletions.length !== candidateIds.length) throw new Error(`安全中止：核对表不收录 ${candidateIds.length} 条，但飞书当前仅匹配 ${deletions.length} 条`);

let backupPath = "";
if (stage) {
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  backupPath = join(backupDir, `feishu-game-rating-before-low-quality-admission-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), purpose: "按 A/S 或小七保留规则清理低质量核对候选；未触碰其他评级记录。", ratingTableId: ratingTable.table_id, sourceAudit: auditPath, rows, deleteRecordIds: deletions.map((row) => row.record_id) }, null, 2), "utf8");
  for (let index = 0; index < deletions.length; index += 500) {
    await api(`${appBase}/tables/${ratingTable.table_id}/records/batch_delete`, { method: "POST", headers, body: JSON.stringify({ records: deletions.slice(index, index + 500).map((row) => row.record_id) }) });
  }
}

console.log(JSON.stringify({ mode: stage ? "stage" : "dry-run", ratingRowsBefore: rows.length, candidateCount: candidateIds.length, matchedCount: deletions.length, deleted: stage ? deletions.length : 0, backupPath, samples: deletions.slice(0, 10).map((row) => ({ game: row.fields?.["游戏名"] || "", platform: row.fields?.["平台"] || "", rating: row.fields?.["评级"] || "", recordId: row.record_id })) }, null, 2));
