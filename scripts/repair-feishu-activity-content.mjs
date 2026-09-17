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
const checkOnly = process.argv.includes("--check-only");
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

const repairs = [
  {
    url: "https://www.3839.com/a/151743.htm",
    game: "三角洲行动",
    content: "钢铁巨兽捆绑包上线、\n炫迈联动活动开启，\n七夕活动持续进行中；\n将于9月4日更新「群星」赛季",
  },
  {
    url: "https://www.3839.com/a/136127.htm",
    game: "暗区突围",
    content: "「星座系列」主题军需上新！\n金色品质枪械涂装【室女座·QBZ191】上线盲盒中心；\n9月2日开启S19赛季「硝烟无声」",
  },
];
const targets = repairs.map((repair) => {
  const row = rows.find((item) => item.fields?.["原文链接"]?.link === repair.url && String(item.fields?.["类型"] || "") === "活动");
  if (!row) throw new Error(`未找到${repair.game}对应的活动记录`);
  return { ...repair, row };
});
if (checkOnly) {
  console.log(JSON.stringify({
    checked: targets.map((target) => ({ game: target.game, recordId: target.row.record_id, content: target.row.fields?.["内容"] || "" })),
  }, null, 2));
  process.exit(0);
}
const backupDir = join(process.cwd(), "data", "backups");
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `feishu-before-delta-activity-content-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: targets.map(({ row }) => row) }, null, 2), "utf8");

const updated = [];
for (const target of targets) {
  if (String(target.row.fields?.["内容"] || "") === target.content) continue;
  await api(`${base}/records/${encodeURIComponent(target.row.record_id)}`, {
    method: "PUT", headers, body: JSON.stringify({ fields: { 内容: target.content } }),
  });
  updated.push({ game: target.game, recordId: target.row.record_id, content: target.content });
}

console.log(JSON.stringify({ updated, backupPath }, null, 2));
