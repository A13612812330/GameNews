import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

const appId = userEnv("FEISHU_MONITOR_APP_ID");
const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
const tableId = userEnv("FEISHU_MONITOR_RATING_TABLE_ID") || "tblDBrMMQJ3w1y6A";
const revenuePath = userEnv("GAME_REVENUE_CSV") || "E:\\新建文件夹\\游戏详情收益汇总.csv";
const stage = process.argv.includes("--stage");
if (!appId || !appSecret || !appToken || !tableId) throw new Error("飞书评级表配置不完整");

function normalize(value = "") {
  return String(value).toLowerCase().replace(/[《》【】\[\]（）()\s\-_:：·・,，。！!？?「」]/gu, "");
}
function number(value) { return Number(String(value ?? "").replace(/,/gu, "")) || 0; }
function ratingForRank(rank) { return rank <= 20 ? "S · 重点" : "A · 优先"; }
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
}
const tokenPayload = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${tokenPayload.tenant_access_token}`, "content-type": "application/json" };
const tableBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`;
async function listRecords() {
  const rows = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ page_size: "500" });
    if (pageToken) query.set("page_token", pageToken);
    const payload = await api(`${tableBase}/records?${query}`, { headers });
    rows.push(...(payload.data?.items || []));
    pageToken = payload.data?.has_more ? payload.data.page_token || "" : "";
  } while (pageToken);
  return rows;
}

const csv = readFileSync(revenuePath, "utf8").replace(/^\uFEFF/u, "");
const lines = csv.split(/\r?\n/u).filter((line) => line.trim());
const headersCsv = lines.shift().split(",").map((value) => value.trim());
const column = (name) => headersCsv.indexOf(name);
const revenueRows = lines.map((line) => {
  const values = line.split(",");
  return { rank: number(values[column("序号")]), game: values[column("游戏名")]?.trim() || "" };
}).filter((row) => row.rank > 0 && row.rank <= 50 && row.game);

const existing = await listRecords();
const existingByGame = new Map(existing.map((row) => [normalize(row.fields?.["游戏名"] || ""), row]));
const additions = revenueRows
  .filter((row) => !existingByGame.has(normalize(row.game)))
  .map((row) => ({
    rank: row.rank,
    game: row.game,
    fields: { 游戏名: row.game, 平台: "收益汇总（平台待补）", 评级: ratingForRank(row.rank) },
  }));

// 只处理此前候选表明确列出的已有评级调整，避免误覆盖用户后续手工评级。
const approvedAdjustments = new Map([
  [normalize("无畏契约：源能行动"), "S · 重点"],
  [normalize("和平精英"), "S · 重点"],
]);
const adjustments = [];
for (const [key, nextRating] of approvedAdjustments) {
  const row = existingByGame.get(key);
  if (!row) continue;
  const current = String(row.fields?.["评级"] || "").trim();
  if (current === nextRating) continue;
  adjustments.push({ record_id: row.record_id, game: row.fields?.["游戏名"] || "", current, nextRating, fields: { 评级: nextRating } });
}

if (stage) {
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `feishu-game-rating-before-revenue-import-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), tableId, rows: existing }, null, 2), "utf8");
  for (let index = 0; index < additions.length; index += 100) {
    await api(`${tableBase}/records/batch_create`, {
      method: "POST", headers,
      body: JSON.stringify({ records: additions.slice(index, index + 100).map(({ fields }) => ({ fields })) }),
    });
  }
  for (let index = 0; index < adjustments.length; index += 100) {
    await api(`${tableBase}/records/batch_update`, {
      method: "POST", headers,
      body: JSON.stringify({ records: adjustments.slice(index, index + 100).map(({ record_id, fields }) => ({ record_id, fields })) }),
    });
  }
}

console.log(JSON.stringify({
  mode: stage ? "stage" : "dry-run",
  tableId,
  existing: existing.length,
  additions: additions.length,
  adjustments: adjustments.length,
  additionsSample: additions.slice(0, 12).map(({ rank, game, fields }) => ({ rank, game, rating: fields.评级 })),
  adjustments,
  backupPath: stage ? join(process.cwd(), "data", "backups") : "",
  protectedS: ["洛克王国：世界", "命运圣契", "奥特曼传奇英雄2", "西游：笔绘西行"],
  noDelete: true,
}, null, 2));
