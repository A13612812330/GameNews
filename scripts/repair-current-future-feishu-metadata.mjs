import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { extractHaoyouFollowerCount, extractHaoyouPublisher, extractHaoyouReserveCount, extractHaoyouReviewCount, filterGameplayTags } from "../server/crawler/platforms/haoyou.js";
import { extractTapTapFollowerCount, extractTapTapPublisher, extractTapTapReserveCount, extractTapTapReviewCount, extractUpcomingTags, fetchTapTapAppTags } from "../server/crawler/platforms/taptap.js";
import { extractDiscount as extractX7Discount, extractPublisher as extractX7Publisher, extractReserveCount as extractX7ReserveCount, parseDetail as parseX7Detail } from "../server/crawler/platforms/x7.js";

// 只补今天及未来的手游记录；默认 dry-run，--stage 才写飞书。
// 不覆盖已有内容，也不触碰评级、评分、正文、时间、原文链接或本地 SQLite。
const stage = process.argv.includes("--stage");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim(); }
  catch { return ""; }
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
function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}
function normalize(value = "") {
  return String(value).replace(/[《》【】()（）\s\-—–·・:：,，.。]/gu, "").toLowerCase();
}
function dayStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
function rowUrl(fields) {
  const value = fields?.["原文链接"];
  return typeof value === "object" ? String(value.link || "") : String(value || "");
}
function sourceFor(platform, url) {
  if (platform === "TapTap" || /taptap\.cn/iu.test(url)) return "taptap";
  if (platform === "好游快爆" || /3839\.com/iu.test(url)) return "haoyou";
  if (platform === "小七" || /x7sy\.com/iu.test(url)) return "x7";
  return "";
}
function countText(value) {
  return Number.isFinite(value) ? String(value) : "";
}
function hasTapTapReserve(html) { return /["']reserve_count["']\s*:/iu.test(html); }
function hasTapTapFollower(html) { return /app-basic-info__title--follow[\s\S]{0,600}?app-basic-info__value/iu.test(html); }
function hasTapTapReview(html) { return /共\s*[\d.,]+\s*[万亿]?\s*条评价|评价[\s\S]{0,300}?(?:sub-text|count)/iu.test(html); }
function hasHaoyouReserve(html) { return /预约人数/iu.test(html); }
function hasHaoyouFollower(html) { return /关注人数/iu.test(html); }
function hasHaoyouReview(html) { return /id=["']pj_tab["'][\s\S]{0,800}?id=["']pl_num["'][^>]*>\s*[\d.,]+\s*[万亿]?\s*</iu.test(html) || /[\d.,]+\s*[万亿]?人评价/iu.test(html); }
function hasX7Reserve(html) { return /class=["'][^"']*count_num[^"']*["']/iu.test(html); }
function urlKey(value = "") {
  try { const parsed = new URL(value); parsed.hash = ""; return parsed.href; } catch { return String(value || "").trim(); }
}
function factCount(facts, names) {
  for (const name of names) {
    if (Object.hasOwn(facts, name) && Number.isFinite(Number(facts[name]))) return String(Number(facts[name]));
  }
  return "";
}
function metadataFromFacts(source, facts, type) {
  if (source === "taptap") return {
    tags: Array.isArray(facts.taptapTags) ? facts.taptapTags.join(" | ") : "",
    publisher: String(facts.taptapPublisher || ""),
    count: type === "活动" ? factCount(facts, ["taptapReviewCount"]) : factCount(facts, ["taptapReserveCount", "taptapFollowerCount"]),
  };
  if (source === "haoyou") return {
    tags: filterGameplayTags(facts.haoyouTags || []).join(" | "),
    publisher: String(facts.haoyouPublisher || ""),
    count: type === "活动" ? factCount(facts, ["haoyouReviewCount"]) : factCount(facts, ["haoyouReserveCount", "haoyouFollowerCount"]),
  };
  const discount = String(facts.x7Discount || "");
  return {
    tags: [...(discount ? [`${discount}折`] : []), ...(facts.x7Tags || [])].join(" | "),
    publisher: String(facts.x7Publisher || ""),
    count: factCount(facts, ["x7ReserveCount"]),
  };
}

async function fetchMetadata({ source, url, game, type }) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`详情页 HTTP ${response.status}`);
  const html = await response.text();
  if (source === "taptap") {
    const appId = /\/app\/(\d+)/u.exec(url)?.[1] || "";
    const tags = [...new Set([...(extractUpcomingTags(html) || []), ...(appId ? await fetchTapTapAppTags(html, appId) : [])])];
    const count = type === "活动"
      ? (hasTapTapReview(html) ? extractTapTapReviewCount(html) : null)
      : (hasTapTapReserve(html) ? extractTapTapReserveCount(html) : (hasTapTapFollower(html) ? extractTapTapFollowerCount(html) : null));
    return { tags: tags.join(" | "), publisher: extractTapTapPublisher(html), count: countText(count) };
  }
  if (source === "haoyou") {
    const count = type === "活动"
      ? (hasHaoyouReview(html) ? extractHaoyouReviewCount(html) : null)
      : (hasHaoyouReserve(html) ? extractHaoyouReserveCount(html) : (hasHaoyouFollower(html) ? extractHaoyouFollowerCount(html) : null));
    return { tags: "", publisher: extractHaoyouPublisher(html), count: countText(count) };
  }
  const detail = parseX7Detail(html, { url, gameName: game });
  const tags = detail.facts?.x7Tags || [];
  const discount = extractX7Discount(html);
  const count = hasX7Reserve(html) ? extractX7ReserveCount(html) : null;
  return { tags: [...(discount ? [`${discount}折`] : []), ...tags].join(" | "), publisher: extractX7Publisher(html), count: countText(count) };
}

const [appId, appSecret, appToken, mainTableId] = ["FEISHU_MONITOR_APP_ID", "FEISHU_MONITOR_APP_SECRET", "FEISHU_MONITOR_APP_TOKEN", "FEISHU_MONITOR_TABLE_ID"].map(userEnv);
if (!appId || !appSecret || !appToken || !mainTableId) throw new Error("飞书监控配置不完整");
const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const appBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}`;
const tables = (await api(`${appBase}/tables?page_size=100`, { headers })).data?.items || [];
const ratingTable = tables.find((table) => table.name === "游戏评级");
if (!ratingTable?.table_id) throw new Error("未找到游戏评级表");
const [mainRows, ratingRows] = await Promise.all([listRows(`${appBase}/tables/${mainTableId}`, headers), listRows(`${appBase}/tables/${ratingTable.table_id}`, headers)]);
const localDb = new DatabaseSync("data/game-news-hub.sqlite");
const localFactsByUrl = new Map(localDb.prepare("SELECT detail_url, facts FROM articles WHERE detail_url IS NOT NULL AND facts IS NOT NULL").all()
  .map((row) => {
    try { return [urlKey(row.detail_url), JSON.parse(row.facts || "{}")]; } catch { return [urlKey(row.detail_url), {}]; }
  }));
const today = dayStart();
const targets = mainRows.filter((row) => {
  const fields = row.fields || {};
  const source = sourceFor(String(fields["平台"] || "").trim(), rowUrl(fields));
  return source && Number(fields["时间"] || 0) >= today
    && (!hasValue(fields["标签"]) || !hasValue(fields["厂商"]) || !hasValue(fields["评论/预约量"]));
});
const metadataByGame = new Map();
const mainRepairs = [];
const failed = [];
for (const row of targets) {
  const fields = row.fields || {};
  const url = rowUrl(fields);
  const source = sourceFor(String(fields["平台"] || "").trim(), url);
  try {
    const type = String(fields["类型"] || "");
    const localMetadata = metadataFromFacts(source, localFactsByUrl.get(urlKey(url)) || {}, type);
    const needsFetch = (!hasValue(fields["标签"]) && !hasValue(localMetadata.tags))
      || (!hasValue(fields["厂商"]) && !hasValue(localMetadata.publisher))
      || (!hasValue(fields["评论/预约量"]) && !hasValue(localMetadata.count));
    const fetchedMetadata = needsFetch ? await fetchMetadata({ source, url, game: String(fields["游戏名"] || ""), type }) : {};
    const metadata = {
      tags: localMetadata.tags || fetchedMetadata.tags || "",
      publisher: localMetadata.publisher || fetchedMetadata.publisher || "",
      count: localMetadata.count || fetchedMetadata.count || "",
    };
    const next = {};
    if (!hasValue(fields["标签"]) && hasValue(metadata.tags)) next.标签 = metadata.tags;
    if (!hasValue(fields["厂商"]) && hasValue(metadata.publisher)) next.厂商 = metadata.publisher;
    if (!hasValue(fields["评论/预约量"]) && hasValue(metadata.count)) next["评论/预约量"] = Number(metadata.count);
    if (Object.keys(next).length) mainRepairs.push({ record_id: row.record_id, fields: next, game: fields["游戏名"] });
    // 评级表缺指标时优先用本轮已验证的详情值；数据表原有 0 不视为“空”，因此不覆盖它。
    const merged = { tags: metadata.tags || fields["标签"], publisher: metadata.publisher || fields["厂商"], count: metadata.count || fields["评论/预约量"] };
    if (hasValue(merged.tags) || hasValue(merged.publisher) || hasValue(merged.count)) metadataByGame.set(normalize(fields["游戏名"]), merged);
  } catch (error) {
    failed.push({ recordId: row.record_id, game: fields["游戏名"], reason: error.message || String(error) });
  }
}
const ratingRepairs = [];
for (const row of ratingRows) {
  const fields = row.fields || {};
  const metadata = metadataByGame.get(normalize(fields["游戏名"] || fields["标准游戏名"]));
  if (!metadata) continue;
  const next = {};
  if (!hasValue(fields["游戏标签"]) && hasValue(metadata.tags)) next.游戏标签 = metadata.tags;
  if (!hasValue(fields["厂商"]) && hasValue(metadata.publisher)) next.厂商 = metadata.publisher;
  if (!hasValue(fields["评论/预约量"]) && hasValue(metadata.count)) next["评论/预约量"] = Number(metadata.count);
  if (Object.keys(next).length) ratingRepairs.push({ record_id: row.record_id, fields: next, game: fields["游戏名"] || fields["标准游戏名"] });
}
async function batchUpdate(tableId, repairs) {
  for (let index = 0; index < repairs.length; index += 100) {
    await api(`${appBase}/tables/${tableId}/records/batch_update`, { method: "POST", headers, body: JSON.stringify({ records: repairs.slice(index, index + 100).map(({ record_id, fields }) => ({ record_id, fields })) }) });
  }
}
if (stage) {
  await batchUpdate(mainTableId, mainRepairs);
  await batchUpdate(ratingTable.table_id, ratingRepairs);
}
console.log(JSON.stringify({
  mode: stage ? "stage" : "dry-run",
  currentOrFutureCandidates: targets.length,
  mainRecordsToUpdate: mainRepairs.length,
  ratingRecordsToUpdate: ratingRepairs.length,
  fields: { tags: mainRepairs.filter((row) => "标签" in row.fields).length, publishers: mainRepairs.filter((row) => "厂商" in row.fields).length, engagement: mainRepairs.filter((row) => "评论/预约量" in row.fields).length },
  mainSamples: mainRepairs.slice(0, 8).map(({ game, fields }) => ({ game, fields })),
  ratingSamples: ratingRepairs.slice(0, 8).map(({ game, fields }) => ({ game, fields })),
  failed: failed.length,
  failedSamples: failed.slice(0, 8),
  notify: false,
}, null, 2));
