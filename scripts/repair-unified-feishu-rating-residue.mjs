import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 仅删除已确认由 Unified 端游/资讯污染带入“游戏评级”表的记录，
// 以及一个错误清洗出的手游游戏名。默认 dry-run；--stage 才会写入。
// 正常手游评级（三国：百将牌、蛋仔派对、永劫无间手游）明确保留。
const PC_RESIDUALS = new Map([
  ["渔力全开", "Steam"], ["Apex Legends™", "Steam"], ["NBA 2K27", "Steam"],
  ["极限竞速：地平线 5", "Steam"], ["极限竞速：地平线 6", "Steam"],
  ["古墓丽影RE", "游民星空"], ["守墓人2", "游民星空"], ["神鬼寓言4", "游民星空"],
  ["SPINE", "游民星空"], ["永恒之塔2", "游民星空"], ["猿公剑", "游民星空"],
  ["顺风快递", "游民星空"], ["战锤西格玛时代：死亡大师", "游民星空"], ["Ritual Tides", "游民星空"],
  ["GTA6", "游民星空"], ["破坏领主2", "机核"], ["拜拜邦妮", "机核"], ["山海经", "游民星空"],
  ["异域镇魂曲：增强版", "游民星空"], ["狙击精英：抵抗", "游民星空"],
  ["碧蓝幻想Versus -RISING", "机核"], ["碧蓝幻想Versus：崛起", "游民星空"],
  ["JOIN US", "游民星空"], ["超真实麻将 Venus Returns", "游民星空"], ["鬼武者：剑之道", "游民星空"],
]);
const MALFORMED_MOBILE_GAME = "遗忘之海-奇遇海洋开放世界";
const stage = process.argv.includes("--stage");

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim();
  } catch { return ""; }
}
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `飞书请求失败：${response.status}`);
  return payload;
}
function normalize(value = "") {
  return String(value).toLowerCase().replace(/[《》【】\[\]（）()\s\-_:：·・,，。！!？?「」]/gu, "");
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

const appId = userEnv("FEISHU_MONITOR_APP_ID");
const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
if (!appId || !appSecret || !appToken) throw new Error("飞书监控配置不完整");
const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const appBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}`;
const tables = (await api(`${appBase}/tables?page_size=100`, { headers })).data?.items || [];
const ratingTable = tables.find((table) => table.name === "游戏评级");
if (!ratingTable?.table_id) throw new Error("未找到游戏评级表");
const rows = await listRows(`${appBase}/tables/${ratingTable.table_id}`, headers);

const candidateRows = rows.filter((row) => {
  const game = String(row.fields?.["游戏名"] || "").trim();
  const platform = String(row.fields?.["平台"] || "").trim();
  const expected = PC_RESIDUALS.get(game);
  return (expected && platform === expected) || game === MALFORMED_MOBILE_GAME;
});
const expectedCount = PC_RESIDUALS.size + 1;
if (candidateRows.length !== expectedCount) {
  throw new Error(`安全中止：预期 ${expectedCount} 条评级残留，实际匹配 ${candidateRows.length} 条`);
}

let backupPath = "";
if (stage) {
  const backupDir = join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  backupPath = join(backupDir, `feishu-game-rating-before-unified-residue-repair-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    purpose: "删除 Unified 端游/资讯评级残留；保留正常手游游戏级评级。",
    ratingTableId: ratingTable.table_id,
    rows,
    deleteRecordIds: candidateRows.map((row) => row.record_id),
  }, null, 2), "utf8");
  for (let index = 0; index < candidateRows.length; index += 500) {
    await api(`${appBase}/tables/${ratingTable.table_id}/records/batch_delete`, {
      method: "POST", headers,
      body: JSON.stringify({ records: candidateRows.slice(index, index + 500).map((row) => row.record_id) }),
    });
  }
}
console.log(JSON.stringify({
  mode: stage ? "stage" : "dry-run",
  ratingRows: rows.length,
  deletionCount: candidateRows.length,
  backupPath,
  deleted: stage ? candidateRows.length : 0,
  retainedMobileRatings: ["三国：百将牌", "蛋仔派对", "永劫无间手游"],
  samples: candidateRows.map((row) => ({ recordId: row.record_id, 游戏名: row.fields?.["游戏名"] || "", 平台: row.fields?.["平台"] || "", 评级: row.fields?.["评级"] || "" })),
}, null, 2));
