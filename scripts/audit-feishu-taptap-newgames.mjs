import { execFileSync } from "node:child_process";
import { extractUpcomingTags, hasExcludedTapTapNewGameTag } from "../server/crawler/platforms/taptap.js";

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim();
  } catch { return ""; }
}
const execute = process.argv.includes("--execute");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
}

async function deleteWithRetry(base, headers, recordId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await api(`${base}/records/${encodeURIComponent(recordId)}`, { method: "DELETE", headers }); }
    catch (error) {
      if (!/Data not ready/iu.test(error.message) || attempt === 4) throw error;
      await sleep(400 * (attempt + 1));
    }
  }
}

const appId = userEnv("FEISHU_MONITOR_APP_ID");
const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
const tableId = userEnv("FEISHU_MONITOR_TABLE_ID");
if (!appId || !appSecret || !appToken || !tableId) throw new Error("监控配置不完整");
const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };
const base = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`;
const records = (await api(`${base}/records?page_size=500`, { headers })).data?.items || [];
const candidates = records.filter((record) => record.fields?.["平台"] === "TapTap" && record.fields?.["原文链接"]?.link);
const rejected = [];
for (const record of candidates) {
  const url = record.fields["原文链接"].link;
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(15000) });
    const html = await response.text();
    const tags = extractUpcomingTags(html);
    if (hasExcludedTapTapNewGameTag(tags)) {
      rejected.push({ recordId: record.record_id, game: record.fields["游戏名"] || "", tags, url });
    }
  } catch {
    // 核验失败不删除，避免网络失败误删正常游戏。
  }
}
if (execute) {
  for (let index = 0; index < rejected.length; index += 2) {
    await Promise.all(rejected.slice(index, index + 2).map((item) => deleteWithRetry(base, headers, item.recordId)));
  }
}
console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", checked: candidates.length, rejected: rejected.length, items: rejected.map(({ recordId, ...item }) => item) }, null, 2));
