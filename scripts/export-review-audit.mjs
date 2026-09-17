import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../server/database.js";

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
const sourceTableId = userEnv("FEISHU_MONITOR_TABLE_ID");
if (!appId || !appSecret || !appToken || !sourceTableId) throw new Error("飞书监控配置不完整");

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
}

function parseFacts(value) {
  try { return typeof value === "string" ? JSON.parse(value || "{}") : (value || {}); } catch { return {}; }
}

function normalize(value = "") {
  return String(value).toLowerCase()
    .replace(/[《》【】\[\]（）()\s\-_:：·・,，。！!？?「」]/gu, "");
}

function cleanGameName(value = "") {
  return String(value)
    .replace(/[《》【】]/gu, "")
    .replace(/[（(](?:官服|测试服|正式服|国际服|渠道服)[）)]/giu, "")
    .replace(/[-—–]\s*(?:预下载|预约|下载|首发|公测|内测|测试|上线|更新|活动|联动|新版本).*$/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function esc(value = "") {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function platformName(sourceId = "") {
  return sourceId === "ref-taptap" ? "TapTap" : sourceId === "ref-haoyou" ? "好游快爆" : sourceId === "ref-x7" ? "小七" : sourceId;
}

function metricInfo(sourceId, type, facts) {
  if (type === "新游") {
    if (sourceId === "ref-taptap") {
      const value = Number(facts.taptapReserveCount);
      if (Number.isFinite(value) && value >= 0) return { count: value, field: "TapTap 预约" };
      const follower = Number(facts.taptapFollowerCount);
      return Number.isFinite(follower) && follower >= 0 ? { count: follower, field: "TapTap 关注" } : null;
    }
    if (sourceId === "ref-haoyou") {
      const value = Number(facts.haoyouReserveCount);
      if (Number.isFinite(value) && value >= 0) return { count: value, field: "好游快爆 预约" };
      const follower = Number(facts.haoyouFollowerCount);
      if (Number.isFinite(follower) && follower >= 0) return { count: follower, field: "好游快爆 关注" };
      const review = Number(facts.haoyouReviewCount);
      return Number.isFinite(review) && review >= 0 ? { count: review, field: "好游快爆 评论（新游兜底）" } : null;
    }
    if (sourceId === "ref-x7") {
      const value = Number(facts.x7ReserveCount);
      return Number.isFinite(value) && value >= 0 ? { count: value, field: "小七 预约" } : null;
    }
    return null;
  }
  if (sourceId === "ref-taptap") {
    const value = Number(facts.taptapReviewCount);
    return Number.isFinite(value) && value >= 0 ? { count: value, field: "TapTap 评论" } : null;
  }
  if (sourceId === "ref-haoyou") {
    const value = Number(facts.haoyouReviewCount);
    return Number.isFinite(value) && value >= 0 ? { count: value, field: "好游快爆 评论" } : null;
  }
  return null;
}

function articleType(article) {
  return /新游上线|测试公测/iu.test(String(article?.category || "")) ? "新游" : "活动";
}

async function listRecords(tableId, headers) {
  const rows = [];
  let pageToken = "";
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
    const payload = await api(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500${suffix}`, { headers });
    rows.push(...(payload.data?.items || []));
    pageToken = payload.data?.page_token || "";
  } while (pageToken);
  return rows;
}

const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const tables = (await api(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables?page_size=100`, { headers })).data?.items || [];
const ratingTable = tables.find((table) => table.name === "游戏评级");
if (!ratingTable) throw new Error("未找到游戏评级表");
const ratingRows = await listRecords(ratingTable.table_id, headers);
const sourceRows = await listRecords(sourceTableId, headers);

const localArticles = db.prepare(`
  SELECT source_id, game_name, detail_url, facts, updated_at
  FROM articles
  WHERE source_id IN ('ref-taptap', 'ref-haoyou', 'ref-x7')
  ORDER BY updated_at DESC
`).all().map((article) => ({ ...article, facts: parseFacts(article.facts) }));

const byGame = new Map();
for (const article of localArticles) {
  const key = normalize(cleanGameName(article.game_name));
  if (!key) continue;
  const list = byGame.get(key) || [];
  list.push(article);
  byGame.set(key, list);
}

const platformOrder = { "ref-taptap": 0, "ref-haoyou": 1, "ref-x7": 2 };
const rows = ratingRows.map((row) => {
  const fields = row.fields || {};
  const game = String(fields["游戏名"] || "").trim();
  const candidates = (byGame.get(normalize(cleanGameName(game))) || [])
    .sort((left, right) => (platformOrder[left.source_id] ?? 9) - (platformOrder[right.source_id] ?? 9));
  const preferred = candidates.find((article) => metricInfo(article.source_id, articleType(article), article.facts)) || candidates[0] || null;
  const type = preferred ? articleType(preferred) : "";
  const metric = preferred ? metricInfo(preferred.source_id, type, preferred.facts) : null;
  return {
    game,
    platform: String(fields["平台"] || ""),
    rating: String(fields["评级"] || ""),
    publisher: String(fields["厂商"] || ""),
    type,
    reviewCount: metric?.count ?? null,
    reviewField: metric?.field || (type === "新游" && preferred?.source_id === "ref-x7" ? "小七 预约" : "未获取"),
    source: preferred ? platformName(preferred.source_id) : "未匹配本地详情",
    url: preferred?.detail_url || "",
  };
}).sort((left, right) => left.game.localeCompare(right.game, "zh-CN"));

const generatedAt = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "medium",
}).format(new Date());
const body = rows.map((row) => {
  const link = row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noreferrer">打开原文</a>` : "—";
  const count = row.reviewCount == null ? "未获取" : row.reviewCount.toLocaleString("zh-CN");
  return `<tr><td>${esc(row.game)}</td><td>${esc(row.platform)}</td><td>${esc(row.type || "未识别")}</td><td><span class="badge badge-${esc(row.rating.slice(0, 1))}">${esc(row.rating)}</span></td><td>${esc(row.publisher || "未获取")}</td><td class="count">${count}</td><td>${esc(row.reviewField)}</td><td>${esc(row.source)}</td><td>${link}</td></tr>`;
}).join("\n");

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>游戏评论量核对清单</title>
<style>
body{margin:0;background:#f5f7fb;color:#202938;font:14px/1.5 "Microsoft YaHei",sans-serif}.wrap{max-width:1500px;margin:32px auto;padding:0 24px}h1{margin:0 0 8px;font-size:26px}.meta{color:#667085;margin-bottom:20px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:auto;box-shadow:0 8px 24px #1d29390b}table{border-collapse:collapse;width:100%;min-width:1050px}th,td{padding:11px 12px;border-bottom:1px solid #edf0f4;text-align:left;white-space:nowrap}th{background:#f8fafc;color:#475467;position:sticky;top:0;z-index:1}.count{font-weight:700;text-align:right}.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}.badge-S{background:#fff0a8}.badge-A{background:#d9f7df}.badge-B{background:#e6f0ff}.badge-C{background:#f1f3f5}a{color:#1677ff;text-decoration:none}a:hover{text-decoration:underline}.note{margin-top:14px;color:#667085}
</style></head><body><main class="wrap"><h1>游戏评论/预约量核对清单</h1><div class="meta">生成时间：${esc(generatedAt)}　共 ${rows.length} 个游戏</div><div class="card"><table><thead><tr><th>游戏名</th><th>平台</th><th>类型</th><th>评级</th><th>厂商</th><th>评论/预约量</th><th>数量来源</th><th>匹配平台</th><th>原文链接</th></tr></thead><tbody>${body}</tbody></table></div><div class="note">规则：新游读取预约量；活动读取评论量；小七当前只进入新游，因此活动指标不适用。论坛讨论数、帖子数、下载量和关注数不计入该列；“未获取”不等于 0。</div></main></body></html>`;

const outputDir = join(process.cwd(), "output");
mkdirSync(outputDir, { recursive: true });
const outputPath = join(outputDir, `GAME_REVIEW_AUDIT_${new Date().toISOString().slice(0, 10)}.html`);
writeFileSync(outputPath, html, "utf8");
console.log(JSON.stringify({ outputPath, total: rows.length, withReviewCount: rows.filter((row) => row.reviewCount != null).length, withoutReviewCount: rows.filter((row) => row.reviewCount == null).length }, null, 2));
