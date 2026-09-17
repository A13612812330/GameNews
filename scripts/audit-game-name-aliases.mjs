import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim(); } catch { return ""; }
}
const appId = userEnv("FEISHU_MONITOR_APP_ID");
const appSecret = userEnv("FEISHU_MONITOR_APP_SECRET");
const appToken = userEnv("FEISHU_MONITOR_APP_TOKEN");
if (!appId || !appSecret || !appToken) throw new Error("飞书配置不完整");
const KNOWN_SEPARATE_PAIRS = new Set([
  "少年三国志|少年三国志2", "少年三国志2|少年三国志",
  "明日方舟|明日方舟：终末地", "明日方舟：终末地|明日方舟",
]);
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
}
function normalize(value = "") { return String(value).toLowerCase().replace(/[《》【】\[\]（）()\s\-_:：·・,，。！!？?「」]/gu, ""); }
function cleanNoise(value = "") {
  return String(value)
    .replace(/[（(](?:TapTap|好游快爆|小七|官方|渠道|安卓|iOS|苹果|Android|测试版|官服|正式服|国际服|渠道服|预约|预下载)[^）)]*[）)]/giu, "")
    .replace(/[-—–_\s]*(?:抢先下载资源|抢先下载|预下载资源|预下载|预约下载|预约|测试版|官服|正式服|国际服|渠道服|少前平行世界)$/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
function esc(value = "") { return String(value ?? "").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;"); }
function fieldText(value) { return typeof value === "object" ? value?.text || value?.name || value?.value || "" : String(value ?? ""); }
const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const tables = (await api(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables?page_size=100`, { headers })).data?.items || [];
const ratingTable = tables.find((table) => table.name === "游戏评级");
if (!ratingTable) throw new Error("未找到游戏评级表");
const rows = [];
let pageToken = "";
do {
  const query = new URLSearchParams({ page_size: "500" });
  if (pageToken) query.set("page_token", pageToken);
  const payload = await api(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${ratingTable.table_id}/records?${query}`, { headers });
  rows.push(...(payload.data?.items || []));
  pageToken = payload.data?.has_more ? payload.data.page_token || "" : "";
} while (pageToken);

const candidates = [];
for (const row of rows) {
  const original = fieldText(row.fields?.["游戏名"]).trim();
  const cleaned = cleanNoise(original);
  if (original && cleaned && normalize(original) !== normalize(cleaned)) {
    candidates.push({ type: "名称噪声", confidence: "高", original, suggested: cleaned, recordId: row.record_id, platform: fieldText(row.fields?.["平台"]), rating: fieldText(row.fields?.["评级"]), reason: "名称包含平台/服别/预约/预下载/资源等状态后缀" });
  }
}
const named = rows.map((row) => ({ row, name: fieldText(row.fields?.["游戏名"]).trim() })).filter((item) => item.name);
for (let leftIndex = 0; leftIndex < named.length; leftIndex += 1) {
  for (let rightIndex = leftIndex + 1; rightIndex < named.length; rightIndex += 1) {
    const left = named[leftIndex]; const right = named[rightIndex];
    const leftClean = cleanNoise(left.name); const rightClean = cleanNoise(right.name);
    // 体验服是独立运营/版本实体，不与正式服合并，也不作为疑似别名提示。
    if (/体验服/iu.test(left.name) !== /体验服/iu.test(right.name)) continue;
    if (KNOWN_SEPARATE_PAIRS.has(`${leftClean}|${rightClean}`)) continue;
    const a = normalize(leftClean); const b = normalize(rightClean);
    if (!a || !b || a === b) continue;
    const shorter = a.length <= b.length ? a : b; const longer = a.length <= b.length ? b : a;
    if (shorter.length < 4 || !longer.startsWith(shorter) || longer.length - shorter.length > 10) continue;
    const canonical = a.length <= b.length ? leftClean : rightClean;
    const alias = a.length <= b.length ? left.name : right.name;
    const pairedWith = a.length <= b.length ? right.name : left.name;
    if (alias === pairedWith) continue;
    if (candidates.some((item) => item.type === "同游戏疑似别名" && item.original === alias && item.suggested === canonical)) continue;
    candidates.push({ type: "已确认同游戏关联", confidence: "高", original: alias, suggested: canonical, recordId: a.length <= b.length ? left.row.record_id : right.row.record_id, platform: fieldText((a.length <= b.length ? left : right).row.fields?.["平台"]), rating: fieldText((a.length <= b.length ? left : right).row.fields?.["评级"]), reason: `关联名称：${pairedWith}；按本轮人工确认视为同一游戏` });
  }
}
const unique = candidates.filter((item, index, all) => all.findIndex((other) => other.type === item.type && other.original === item.original && other.suggested === item.suggested) === index);
const body = unique.map((item) => `<tr><td>${esc(item.type)}</td><td><b>${esc(item.confidence)}</b></td><td>${esc(item.original)}</td><td>${esc(item.suggested)}</td><td>${esc(item.platform || "未标注")}</td><td>${esc(item.rating || "未评级")}</td><td>${esc(item.reason)}</td><td><code>${esc(item.recordId)}</code></td></tr>`).join("\n");
const generatedAt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "medium" }).format(new Date());
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>游戏名关联核对清单</title><style>body{margin:0;background:#f5f7fb;color:#202938;font:14px/1.5 "Microsoft YaHei",sans-serif}.wrap{max-width:1500px;margin:32px auto;padding:0 24px}h1{margin:0 0 8px}.meta,.note{color:#667085;margin:8px 0 18px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:auto}table{border-collapse:collapse;width:100%;min-width:1100px}th,td{padding:10px 12px;border-bottom:1px solid #edf0f4;text-align:left;white-space:nowrap}th{background:#f8fafc;color:#475467;position:sticky;top:0}code{font-size:11px;color:#667085}.note{background:#fff8e1;border:1px solid #f2d38b;border-radius:10px;padding:10px 12px}</style></head><body><main class="wrap"><h1>游戏名关联核对清单</h1><div class="meta">生成时间：${esc(generatedAt)}　评级表记录：${rows.length}　候选：${unique.length}</div><div class="note">本表只读分析，不会自动合并或删除。高置信度主要是平台/服别/预约/预下载等后缀；中置信度是疑似同游戏前缀匹配，需你人工确认。</div><div class="card"><table><thead><tr><th>候选类型</th><th>置信度</th><th>当前游戏名</th><th>建议关联到</th><th>平台</th><th>评级</th><th>判断依据</th><th>记录ID</th></tr></thead><tbody>${body || '<tr><td colspan="8">未发现候选</td></tr>'}</tbody></table></div></main></body></html>`;
const outputDir = join(process.cwd(), "output"); mkdirSync(outputDir, { recursive: true });
const outputPath = join(outputDir, `GAME_NAME_ALIAS_AUDIT_${new Date().toISOString().slice(0, 10)}.html`);
writeFileSync(outputPath, html, "utf8");
console.log(JSON.stringify({ outputPath, ratingRecords: rows.length, candidates: unique.length, highConfidence: unique.filter((item) => item.confidence === "高").length, mediumConfidence: unique.filter((item) => item.confidence === "中").length, samples: unique.slice(0, 30) }, null, 2));
