import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../server/database.js";
import { extractHaoyouFollowerCount, extractHaoyouReviewCount, extractHaoyouReserveCount } from "../server/crawler/platforms/haoyou.js";
import { extractTapTapFollowerCount, extractTapTapReviewCount, extractTapTapReserveCount } from "../server/crawler/platforms/taptap.js";
import { extractReserveCount as extractX7ReserveCount } from "../server/crawler/platforms/x7.js";

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim(); } catch { return ""; }
}
const appId = userEnv("FEISHU_MONITOR_APP_ID");
const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
const sourceTableId = userEnv("FEISHU_MONITOR_TABLE_ID");
if (!appId || !appSecret || !appToken || !sourceTableId) throw new Error("飞书监控配置不完整");

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
}
function parseFacts(value) { try { return typeof value === "string" ? JSON.parse(value || "{}") : value || {}; } catch { return {}; } }
function canonical(value = "") { try { const url = new URL(value); url.search = ""; return url.href.replace(/\/$/u, ""); } catch { return String(value || "").trim(); } }
function articleType(category = "") { return /新游上线|测试公测/iu.test(String(category)) ? "新游" : "活动"; }
function metricFor(sourceId, type, facts) {
  const isNewGame = type === "新游";
  const value = isNewGame
    ? sourceId === "ref-taptap" ? facts.taptapReserveCount ?? facts.taptapFollowerCount : sourceId === "ref-haoyou" ? facts.haoyouReserveCount ?? facts.haoyouFollowerCount ?? facts.haoyouReviewCount : sourceId === "ref-x7" ? facts.x7ReserveCount : null
    : sourceId === "ref-taptap" ? facts.taptapReviewCount : sourceId === "ref-haoyou" ? facts.haoyouReviewCount : null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}
async function listRecords(tableId, headers) {
  const rows = [];
  let token = "";
  do {
    const suffix = token ? `&page_token=${encodeURIComponent(token)}` : "";
    const payload = await api(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500${suffix}`, { headers });
    rows.push(...(payload.data?.items || []));
    token = payload.data?.page_token || "";
  } while (token);
  return rows;
}
const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const appBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}`;
const tableBase = (id) => `${appBase}/tables/${id}`;
const tables = (await api(`${appBase}/tables?page_size=100`, { headers })).data?.items || [];
const ratingTable = tables.find((table) => table.name === "游戏评级");
const sourceFields = (await api(`${tableBase(sourceTableId)}/fields?page_size=100`, { headers })).data?.items || [];
if (!sourceFields.some((field) => field.field_name === "评论/预约量")) {
  await api(`${tableBase(sourceTableId)}/fields`, { method: "POST", headers, body: JSON.stringify({ field_name: "评论/预约量", type: 2 }) });
}
const local = new Map(db.prepare("SELECT source_id, detail_url, facts, category FROM articles WHERE detail_url IS NOT NULL").all().map((row) => [canonical(row.detail_url), { sourceId: row.source_id, detailUrl: row.detail_url, category: row.category, facts: parseFacts(row.facts) }]));
const updateFacts = db.prepare("UPDATE articles SET facts=?, updated_at=datetime('now') WHERE detail_url=? AND source_id=?");
const localEntries = [...local.entries()];
for (let index = 0; index < localEntries.length; index += 8) {
  const batch = localEntries.slice(index, index + 8);
  await Promise.all(batch.map(async ([url, match]) => {
    const type = articleType(match.category);
    const alreadyPresent = type === "新游"
      ? match.sourceId === "ref-taptap" ? match.facts.taptapReserveCount != null || match.facts.taptapFollowerCount != null : match.sourceId === "ref-haoyou" ? match.facts.haoyouReserveCount != null || match.facts.haoyouFollowerCount != null || match.facts.haoyouReviewCount != null : match.facts.x7ReserveCount != null
      : match.sourceId === "ref-taptap" ? match.facts.taptapReviewCount != null : match.sourceId === "ref-haoyou" ? match.facts.haoyouReviewCount != null : true;
    if (alreadyPresent) return;
    try {
      const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) return;
      const html = await response.text();
      const nextFacts = { ...match.facts };
      if (type === "新游") {
        const reserveValue = match.sourceId === "ref-taptap" ? extractTapTapReserveCount(html) : match.sourceId === "ref-haoyou" ? extractHaoyouReserveCount(html) : extractX7ReserveCount(html);
        if (Number.isFinite(reserveValue)) nextFacts[match.sourceId === "ref-taptap" ? "taptapReserveCount" : match.sourceId === "ref-haoyou" ? "haoyouReserveCount" : "x7ReserveCount"] = reserveValue;
        else if (match.sourceId === "ref-taptap") {
          const followerValue = extractTapTapFollowerCount(html);
          if (Number.isFinite(followerValue)) nextFacts.taptapFollowerCount = followerValue;
        } else if (match.sourceId === "ref-haoyou") {
          const followerValue = extractHaoyouFollowerCount(html);
          if (Number.isFinite(followerValue)) nextFacts.haoyouFollowerCount = followerValue;
          else {
            const reviewValue = extractHaoyouReviewCount(html);
            if (Number.isFinite(reviewValue)) nextFacts.haoyouReviewCount = reviewValue;
          }
        }
      } else if (match.sourceId === "ref-taptap") {
        const value = extractTapTapReviewCount(html);
        if (Number.isFinite(value)) nextFacts.taptapReviewCount = value;
      } else if (match.sourceId === "ref-haoyou") {
        const value = extractHaoyouReviewCount(html);
        if (Number.isFinite(value)) nextFacts.haoyouReviewCount = value;
      }
      if (JSON.stringify(nextFacts) !== JSON.stringify(match.facts)) {
        updateFacts.run(JSON.stringify(nextFacts), match.detailUrl, match.sourceId);
        match.facts = nextFacts;
      }
    } catch {}
  }));
}
const rows = await listRecords(sourceTableId, headers);
const backupDir = join(process.cwd(), "data", "backups");
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `feishu-before-engagement-rule-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), sourceRows: rows }, null, 2), "utf8");
const updates = [];
const preferredMetricByGame = new Map();
for (const row of rows) {
  const fields = row.fields || {};
  const url = fields["原文链接"]?.link || fields["原文链接"] || "";
  const match = local.get(canonical(url));
  if (!match) continue;
  const type = String(fields["类型"] || "").trim();
  const metric = metricFor(match.sourceId, type, match.facts);
  const gameKey = String(fields["游戏名"] || "").toLowerCase().replace(/[《》【】\s\-_:：]/gu, "");
  if (metric == null) continue;
  if (gameKey) {
    const current = preferredMetricByGame.get(gameKey);
    const priority = type === "新游" ? 1 : 0;
    if (!current || priority > current.priority || (priority === current.priority && metric > current.metric)) {
      preferredMetricByGame.set(gameKey, { metric, priority });
    }
  }
  if (Number(fields["评论/预约量"]) === metric) continue;
  updates.push({ record_id: row.record_id, fields: { "评论/预约量": metric } });
}
for (let index = 0; index < updates.length; index += 100) {
  await api(`${tableBase(sourceTableId)}/records/batch_update`, { method: "POST", headers, body: JSON.stringify({ records: updates.slice(index, index + 100) }) });
}
let ratingUpdated = 0;
if (ratingTable) {
  const ratingFields = (await api(`${tableBase(ratingTable.table_id)}/fields?page_size=100`, { headers })).data?.items || [];
  if (!ratingFields.some((field) => field.field_name === "评论/预约量")) {
    await api(`${tableBase(ratingTable.table_id)}/fields`, { method: "POST", headers, body: JSON.stringify({ field_name: "评论/预约量", type: 2 }) });
  }
  const ratingRows = await listRecords(ratingTable.table_id, headers);
  const ratingUpdates = ratingRows.map((row) => {
    const game = String(row.fields?.["游戏名"] || "").trim();
    const key = game.toLowerCase().replace(/[《》【】\s\-_:：]/gu, "");
    const metric = preferredMetricByGame.get(key)?.metric;
    return metric == null || Number(row.fields?.["评论/预约量"]) === metric ? null : { record_id: row.record_id, fields: { "评论/预约量": metric } };
  }).filter(Boolean);
  for (let index = 0; index < ratingUpdates.length; index += 100) {
    await api(`${tableBase(ratingTable.table_id)}/records/batch_update`, { method: "POST", headers, body: JSON.stringify({ records: ratingUpdates.slice(index, index + 100) }) });
  }
  ratingUpdated = ratingUpdates.length;
}
console.log(JSON.stringify({ updated: updates.length, ratingUpdated, matchedLocalArticles: local.size, backupPath }, null, 2));
