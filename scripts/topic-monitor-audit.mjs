import { execFileSync } from "node:child_process";
import { listTodayArticles } from "../server/database.js";

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
const tableId = userEnv("FEISHU_MONITOR_TABLE_ID");
if (!appId || !appSecret || !appToken || !tableId) throw new Error("监控配置不完整");
const deleteEmpty = process.argv.includes("--delete-empty");

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
}

function cleanGameName(value = "") {
  return String(value)
    .replace(/[《》【】]/gu, "")
    .replace(/[（(](?:官服|测试服|正式服|国际服|渠道服)[）)]/giu, "")
    .replace(/[-—–]\s*(?:预下载|预约|下载|首发|公测|内测|测试|上线|更新|活动|联动|新版本).*$/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalize(value = "") {
  return String(value).toLowerCase().replace(/[《》【】\[\]（）()\s\-_:：·・,，。！!？?]/gu, "");
}

function cleanTitle(value = "", game = "") {
  let text = String(value).replace(/\s+/gu, " ").trim();
  const name = cleanGameName(game);
  if (name) text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\$&"), "giu"), "");
  return text
    .replace(/^[\s《》【】「」：:·-]+/gu, "")
    .replace(/(?:下载|预约|论坛\s*\d+|\d+\s*楼|动作|冒险|第三人称|非对称竞技|和)(?:\s*[|｜/,，；;、]\s*|\s+|$)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isNoise(value = "") {
  const text = String(value).replace(/\s+/gu, "").trim();
  if (!text) return true;
  if (/^(?:下载|预约|论坛\d*|动作|冒险|第三人称|非对称竞技|和|暂无摘要|敬请期待)$/u.test(text)) return true;
  return false;
}

function contentKeywords(value = "") {
  const text = normalize(String(value).replace(/\d{1,2}月\d{1,2}日(?:\s*\d{1,2}(?::|点)\d{1,2}分?)?/gu, ""));
  const tokens = new Set();
  for (const match of text.matchAll(/\d+(?:\.\d+){1,3}|s\d+|[a-z]{2,}|[\p{Script=Han}]{2,}/gu)) tokens.add(match[0]);
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (/^[\p{Script=Han}\d]{2}$/u.test(pair)) tokens.add(pair);
  }
  return tokens;
}

function semanticOverlap(left = "", right = "") {
  const a = contentKeywords(left);
  const b = contentKeywords(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(1, Math.min(a.size, b.size));
}

function eventDateValue(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 100000000000) return new Date(number).toISOString().slice(0, 10);
  const text = String(value).replace(/\s+/gu, "");
  const match = /(?:20\d{2}[年\/-])?(\d{1,2})月(\d{1,2})日/u.exec(text);
  return match ? `${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}` : text || null;
}

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

const groups = new Map();
const invalid = [];
const emptyRecords = [];
const dividerRecords = [];
for (const row of rows) {
  const fields = row.fields || {};
  const isEmpty = Object.values(fields).every((value) => value == null || value === "" || (Array.isArray(value) && value.length === 0));
  const game = cleanGameName(fields["游戏名"] || "");
  const type = String(fields["类型"] || "").trim();
  const content = String(fields["内容"] || "").trim();
  const platform = String(fields["平台"] || "").trim();
  // 日期分隔行可能只保留“类型”字段，属于布局节点，不是无效业务记录。
  const isDivider = !game && !content && !platform && /^(?:新游|活动)$/u.test(type);
  if (isDivider) {
    dividerRecords.push(row.record_id);
    continue;
  }
  if (isEmpty) {
    emptyRecords.push(row.record_id);
    continue;
  }
  const title = cleanTitle(content.split(/\n/u)[0] || content, game);
  const date = eventDateValue(fields["时间"]);
  const reason = [];
  if (!game || /^(?:未知|暂无|游戏|新游|活动)$/u.test(game)) reason.push("游戏名无效");
  if (!content || isNoise(content) || !title) reason.push("内容无效或只有噪声");
  if (!/^新游$|^活动$/u.test(type)) reason.push("类型无效");
  if (!platform) reason.push("平台为空");
  if (reason.length) invalid.push({ recordId: row.record_id, game, type, date, platform, content: content.slice(0, 180), reason });

  const key = `${normalize(game)}|${type}|${date || "无事件日期"}|${normalize(title)}`;
  const list = groups.get(key) || [];
  list.push({ recordId: row.record_id, game, type, date, platform, title, content: content.slice(0, 180) });
  groups.set(key, list);
}

const duplicates = [...groups.values()].filter((list) => list.length > 1);
const semanticActivityGroups = [];
const activityRows = rows.filter((row) => {
  const fields = row.fields || {};
  const game = cleanGameName(fields["游戏名"] || "");
  return game && String(fields["类型"] || "").trim() === "活动";
});
for (let leftIndex = 0; leftIndex < activityRows.length; leftIndex += 1) {
  const left = activityRows[leftIndex];
  const leftFields = left.fields || {};
  const leftGame = normalize(cleanGameName(leftFields["游戏名"] || ""));
  const leftDate = eventDateValue(leftFields["时间"]);
  const leftUrl = String(leftFields["原文链接"]?.link || "").replace(/[?#].*$/u, "");
  for (let rightIndex = leftIndex + 1; rightIndex < activityRows.length; rightIndex += 1) {
    const right = activityRows[rightIndex];
    const rightFields = right.fields || {};
    if (leftGame !== normalize(cleanGameName(rightFields["游戏名"] || ""))) continue;
    if (leftDate !== eventDateValue(rightFields["时间"])) continue;
    const rightUrl = String(rightFields["原文链接"]?.link || "").replace(/[?#].*$/u, "");
    if (leftUrl && rightUrl && leftUrl !== rightUrl && String(leftFields["平台"] || "") === String(rightFields["平台"] || "")) continue;
    const leftContent = String(leftFields["内容"] || "");
    const rightContent = String(rightFields["内容"] || "");
    const overlap = semanticOverlap(leftContent, rightContent);
    if (overlap >= 0.6) {
      semanticActivityGroups.push({
        left: { recordId: left.record_id, 游戏名: leftFields["游戏名"], 时间: leftDate, 平台: leftFields["平台"], 内容: leftContent.slice(0, 220), 原文链接: leftFields["原文链接"]?.link || "" },
        right: { recordId: right.record_id, 游戏名: rightFields["游戏名"], 时间: eventDateValue(rightFields["时间"]), 平台: rightFields["平台"], 内容: rightContent.slice(0, 220), 原文链接: rightFields["原文链接"]?.link || "" },
        overlap,
      });
    }
  }
}
const sameGameDifferentEvents = new Map();
for (const row of rows) {
  const fields = row.fields || {};
  const game = cleanGameName(fields["游戏名"] || "");
  const type = String(fields["类型"] || "").trim();
  if (!game) continue;
  const key = `${normalize(game)}|${type}`;
  const list = sameGameDifferentEvents.get(key) || [];
  list.push({ recordId: row.record_id, date: eventDateValue(fields["时间"]), content: String(fields["内容"] || "").slice(0, 140), platform: fields["平台"] || "" });
  sameGameDifferentEvents.set(key, list);
}

const sourceToday = (listTodayArticles().articles || []).filter((article) => ["ref-taptap", "ref-haoyou"].includes(article.source_id));
let deletedEmpty = 0;
if (deleteEmpty) {
  for (const recordId of emptyRecords) {
    await api(`${base}/records/${encodeURIComponent(recordId)}`, { method: "DELETE", headers });
    deletedEmpty += 1;
  }
}
console.log(JSON.stringify({
  total: rows.length,
  dividerRecords: dividerRecords.length,
  emptyRecords: emptyRecords.length,
  deletedEmpty,
  duplicateGroups: duplicates.length,
  duplicateRecords: duplicates.reduce((sum, list) => sum + list.length, 0),
  semanticActivityDuplicatePairs: semanticActivityGroups.length,
  invalidCount: invalid.length,
  sameGameDifferentEventGroups: [...sameGameDifferentEvents.values()].filter((list) => list.length > 1).length,
  sourceTodayCandidates: sourceToday.length,
  invalidSamples: invalid.slice(0, 20),
  duplicateSamples: duplicates.slice(0, 20),
  semanticActivityDuplicateSamples: semanticActivityGroups.slice(0, 30),
  sameGameDifferentEventSamples: [...sameGameDifferentEvents.entries()].filter(([, list]) => list.length > 1).slice(0, 20),
}, null, 2));
