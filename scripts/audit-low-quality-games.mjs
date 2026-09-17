import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim(); } catch { return ""; }
}
const appId = userEnv("FEISHU_MONITOR_APP_ID"); const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET"); const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
if (!appId || !appSecret || !appToken) throw new Error("飞书配置不完整");
async function api(url, options = {}) { const response = await fetch(url, options); const payload = await response.json().catch(() => ({})); if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`); return payload; }
function text(value) { return typeof value === "object" ? value?.text || value?.name || value?.value || "" : String(value ?? ""); }
function esc(value = "") { return String(value ?? "").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;"); }
function ratingRank(value = "") { const x = text(value).trim(); return x.startsWith("S") ? 4 : x.startsWith("A") ? 3 : x.startsWith("B") ? 2 : 1; }
const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const tables = (await api(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables?page_size=100`, { headers })).data?.items || [];
const table = tables.find((item) => item.name === "游戏评级"); if (!table) throw new Error("未找到游戏评级表");
const rows = []; let pageToken = "";
do { const query = new URLSearchParams({ page_size: "500" }); if (pageToken) query.set("page_token", pageToken); const payload = await api(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${table.table_id}/records?${query}`, { headers }); rows.push(...(payload.data?.items || [])); pageToken = payload.data?.has_more ? payload.data.page_token || "" : ""; } while (pageToken);

const hardPattern = /创意工坊|独立游戏|独立开发|个人开发|个人作者|工作室|indie|studio|demo|样品/iu;
const softPattern = /休闲|放置|模拟|文字|解谜|单机|买断制/iu;
const candidates = rows.map((row) => {
  const fields = row.fields || {}; const game = text(fields["游戏名"]).trim(); const tags = text(fields["游戏标签"] || fields["标签"]); const publisher = text(fields["厂商"]); const rating = text(fields["评级"]); const metric = Number(fields["评论/预约量"] || 0); const signals = [];
  if (hardPattern.test(tags)) signals.push("标签含独立/创意工坊/工作室/Demo");
  if (hardPattern.test(publisher)) signals.push("厂商含工作室/个人/Studio");
  if (metric > 0 && metric <= 100) signals.push(`评论/预约量 ${metric} ≤ 100`);
  if (!metric && softPattern.test(tags)) signals.push("无评论/预约量且标签偏轻量");
  const hardTag = /创意工坊|独立游戏|独立开发|Demo|样品/iu.test(tags);
  const hardPublisher = /个人开发|个人作者|indie/iu.test(publisher);
  const lowMetric = metric <= 100;
  const action = (hardTag || hardPublisher) && lowMetric && ratingRank(rating) <= 2
    ? "建议排除"
    : (hardTag || hardPublisher || /工作室|studio/iu.test(publisher)) && (lowMetric || ratingRank(rating) <= 2)
      ? "人工确认"
      : signals.length >= 2 ? "人工确认" : "观察";
  return { row, game, tags, publisher, rating, metric: metric || 0, signals, action };
}).filter((item) => item.game && item.action !== "观察");

const body = candidates.map((item) => `<tr><td>${esc(item.action)}</td><td>${esc(item.game)}</td><td>${esc(item.rating || "未评级")}</td><td>${esc(item.tags || "未获取")}</td><td>${esc(item.publisher || "未获取")}</td><td>${item.metric || "未获取"}</td><td>${esc(item.signals.join("；"))}</td><td><code>${esc(item.row.record_id)}</code></td></tr>`).join("\n");
const generatedAt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "medium" }).format(new Date());
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>低质量游戏排除候选</title><style>body{margin:0;background:#f5f7fb;color:#202938;font:14px/1.5 "Microsoft YaHei",sans-serif}.wrap{max-width:1600px;margin:32px auto;padding:0 24px}h1{margin:0 0 8px}.meta,.note{color:#667085;margin:8px 0 18px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:auto}table{border-collapse:collapse;width:100%;min-width:1250px}th,td{padding:10px 12px;border-bottom:1px solid #edf0f4;text-align:left;white-space:nowrap}th{background:#f8fafc;color:#475467;position:sticky;top:0}.note{background:#fff8e1;border:1px solid #f2d38b;border-radius:10px;padding:10px 12px}code{font-size:11px;color:#667085}</style></head><body><main class="wrap"><h1>低质量游戏排除候选</h1><div class="meta">生成时间：${esc(generatedAt)}　评级表记录：${rows.length}　候选：${candidates.length}　建议排除：${candidates.filter((item) => item.action === "建议排除").length}　人工确认：${candidates.filter((item) => item.action === "人工确认").length}</div><div class="note">体验服不属于排除规则，也不会自动合并到正式服；本表只读，不会删除或修改飞书记录。建议排除仅表示命中强信号且当前评级不高，仍需你最终确认。</div><div class="card"><table><thead><tr><th>建议动作</th><th>游戏名</th><th>评级</th><th>标签</th><th>厂商</th><th>评论/预约量</th><th>命中依据</th><th>记录ID</th></tr></thead><tbody>${body || '<tr><td colspan="8">未发现候选</td></tr>'}</tbody></table></div></main></body></html>`;
const outputDir = join(process.cwd(), "output"); mkdirSync(outputDir, { recursive: true }); const outputPath = join(outputDir, `LOW_QUALITY_GAME_AUDIT_${new Date().toISOString().slice(0, 10)}.html`); writeFileSync(outputPath, html, "utf8");
console.log(JSON.stringify({ outputPath, ratingRecords: rows.length, candidates: candidates.length, recommendRemove: candidates.filter((item) => item.action === "建议排除").length, manualReview: candidates.filter((item) => item.action === "人工确认").length, samples: candidates.slice(0, 30).map(({ game, action, rating, tags, publisher, metric, signals, row }) => ({ game, action, rating, tags, publisher, metric, signals, recordId: row.record_id })) }, null, 2));
