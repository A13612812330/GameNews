import { execFileSync } from "node:child_process";
import { sendTopicMonitorNotification } from "../server/feishuTopicNotifier.js";
import { db } from "../server/database.js";

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

function text(value = "") {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function parseImages(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "[]") : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function remoteImage(value = {}) {
  const candidate = typeof value === "string" ? value : value?.originalUrl || value?.url || value?.src || "";
  return /^https?:\/\//iu.test(String(candidate)) ? String(candidate) : "";
}

function mediaForLink(link = "") {
  if (!link) return {};
  const row = db.prepare("SELECT image_url, images_json FROM articles WHERE detail_url = ? ORDER BY updated_at DESC LIMIT 1").get(link);
  const images = parseImages(row?.images_json);
  return {
    iconUrl: remoteImage(row?.image_url) || remoteImage(images[0]),
    coverUrl: remoteImage(images[0]) || remoteImage(row?.image_url),
  };
}

async function listRecords(base, headers, tableId) {
  const rows = [];
  let pageToken = "";
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
    const payload = await api(`${base}/tables/${tableId}/records?page_size=500${suffix}`, { headers });
    rows.push(...(payload.data?.items || []));
    pageToken = payload.data?.page_token || "";
  } while (pageToken);
  return rows;
}

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  const parsed = value ? Number(value.slice(prefix.length)) : fallback;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function ingestBatchMatches(value, batch = "") {
  if (!batch) return true;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return false;
  if (/^\d{12,}$/u.test(String(batch))) return numeric === Number(batch);
  const date = new Date(numeric);
  const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return key === batch;
}

function fieldText(value) {
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(", ");
  if (value && typeof value === "object") return text(value.text || value.name || value.value || value.link || "");
  return text(value);
}

function ratingRank(value) {
  const rating = fieldText(value).toUpperCase();
  if (/\bS\b/u.test(rating)) return 2;
  if (/\bA\b/u.test(rating)) return 1;
  return 0;
}

function platformKey(value) {
  const name = fieldText(value).replace(/[ ·•|]/gu, "").toLowerCase();
  if (name.includes("taptap")) return "TapTap";
  if (name.includes("好游快爆") || name.includes("3839")) return "好游快爆";
  if (name.includes("小七")) return "小七";
  return fieldText(value);
}

function sampleByPlatforms(rows, type, platforms, limit) {
  if (limit === 0) return [];
  const candidates = rows
    .map((row) => row.fields || {})
    .filter((fields) => fieldText(fields["游戏名"]) && fieldText(fields["内容"]) && ratingRank(fields["评级"]) > 0)
    .sort((a, b) => ratingRank(b["评级"]) - ratingRank(a["评级"]) || Number(b["评分"] || 0) - Number(a["评分"] || 0));
  const selected = [];
  const usedGames = new Set();
  for (const platform of platforms) {
    const fields = candidates.find((item) => platformKey(item["平台"]) === platform && !usedGames.has(fieldText(item["游戏名"])));
    if (fields) {
      selected.push(fields);
      usedGames.add(fieldText(fields["游戏名"]));
    }
  }
  if (selected.length < limit) {
    for (const fields of candidates) {
      if (selected.length >= limit) break;
      const game = fieldText(fields["游戏名"]);
      if (!usedGames.has(game)) {
        selected.push(fields);
        usedGames.add(game);
      }
    }
  }
  if (selected.length < limit) throw new Error(`飞书${type}表可用的 S/A 样本不足：需要 ${limit} 条，实际 ${selected.length} 条`);
  return selected.slice(0, limit).map((fields) => {
    const originalLink = fields["原文链接"]?.link || fieldText(fields["原文链接"]);
    const lines = fieldText(fields["内容"]).split(/\n+/u).filter(Boolean);
    return {
      类型: type,
      游戏名: fieldText(fields["游戏名"]),
      标题: lines[0] || "",
      内容: lines.slice(1, 3).join(" "),
      时间: fieldText(fields["时间"]),
      平台: fieldText(fields["平台"]),
      评级: fieldText(fields["评级"]),
      评分: fieldText(fields["评分"]),
      原文链接: originalLink,
      ...mediaForLink(originalLink),
    };
  });
}

async function randomSamplesFromFeishu({ newCount = 1, activityCount = 1, ingestBatch = "" } = {}) {
  const appId = userEnv("FEISHU_MONITOR_APP_ID");
  const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
  const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
  const newGameTableId = userEnv("FEISHU_MONITOR_TABLE_ID");
  if (!appId || !appSecret || !appToken || !newGameTableId) throw new Error("飞书监控表配置不完整");
  const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
  const base = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}`;
  const tables = (await api(`${base}/tables?page_size=100`, { headers })).data?.items || [];
  const sourceBase = `${base}/tables/${newGameTableId}`;
  const views = (await api(`${sourceBase}/views?page_size=100`, { headers })).data?.items || [];
  const sharedViewMode = views.some((view) => view.view_name === "新游") && views.some((view) => view.view_name === "活动");
  const activityTableId = sharedViewMode ? newGameTableId : tables.find((table) => table.name === "活动")?.table_id;
  if (!activityTableId) throw new Error("未找到飞书活动视图或活动表");
  const [newGames, activities] = await Promise.all([
    listRecords(base, headers, newGameTableId),
    listRecords(base, headers, activityTableId),
  ]);
  const filteredNewGames = sharedViewMode
    ? newGames.filter((row) => String(row.fields?.["类型"] || "").trim() === "新游")
    : newGames;
  const filteredActivities = sharedViewMode
    ? activities.filter((row) => String(row.fields?.["类型"] || "").trim() === "活动")
    : activities;
  const batchFilter = (rows) => ingestBatch
    ? rows.filter((row) => ingestBatchMatches(row.fields?.["入库时间"], ingestBatch))
    : rows;
  const batchNewGames = batchFilter(filteredNewGames);
  const batchActivities = batchFilter(filteredActivities);
  const sourceRows = ingestBatch ? [...batchNewGames, ...batchActivities] : [];
  if (ingestBatch === "list") {
    const groups = new Map();
    for (const row of [...filteredNewGames, ...filteredActivities]) {
      const value = fieldText(row.fields?.["入库时间"]);
      const group = groups.get(value) || { total: 0, newGames: 0, activities: 0, samples: [] };
      group.total += 1;
      if (String(row.fields?.["类型"] || "") === "活动") group.activities += 1;
      else group.newGames += 1;
      if (group.samples.length < 20) group.samples.push({ 游戏名: fieldText(row.fields?.["游戏名"]), 类型: fieldText(row.fields?.["类型"]), 评级: fieldText(row.fields?.["评级"]), 平台: fieldText(row.fields?.["平台"]) });
      groups.set(value, group);
    }
    console.log(JSON.stringify({ ingestBatches: [...groups.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0]))) }, null, 2));
    return [];
  }
  if (ingestBatch && !sourceRows.length) throw new Error(`未找到入库批次 ${ingestBatch} 的飞书记录`);
  return [
    ...sampleByPlatforms(batchNewGames, "新游", ["TapTap", "好游快爆", "小七"], newCount),
    ...sampleByPlatforms(batchActivities, "活动", ["TapTap", "好游快爆"], activityCount),
  ];
}

const fromFeishu = process.argv.includes("--from-feishu");
const ingestBatchArg = process.argv.find((arg) => arg.startsWith("--ingest-batch="));
const ingestBatch = ingestBatchArg ? ingestBatchArg.slice("--ingest-batch=".length) : "";
const items = fromFeishu
  ? await randomSamplesFromFeishu({ newCount: argValue("new-count", 1), activityCount: argValue("activity-count", 1), ingestBatch })
  : [];
const result = await sendTopicMonitorNotification(fromFeishu ? { items } : { test: true });
console.log(JSON.stringify({ ok: true, fromFeishu, samples: items, ...result }, null, 2));
