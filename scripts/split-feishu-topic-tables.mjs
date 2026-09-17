import { execFileSync } from "node:child_process";

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
const execute = process.argv.includes("--execute");
if (!appId || !appSecret || !appToken || !sourceTableId) throw new Error("监控配置不完整");

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(payload.msg || `请求失败：${response.status}`);
  return payload;
}

function linkKey(fields = {}) {
  const raw = fields["原文链接"]?.link || "";
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(raw || "").trim();
  }
}

async function listRecords(base, headers) {
  const items = [];
  let pageToken = "";
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
    const payload = await api(`${base}/records?page_size=500${suffix}`, { headers });
    items.push(...(payload.data?.items || []));
    pageToken = payload.data?.page_token || "";
  } while (pageToken);
  return items;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function deleteWithRetry(base, headers, recordId) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await api(`${base}/records/${encodeURIComponent(recordId)}`, { method: "DELETE", headers });
      return;
    } catch (error) {
      lastError = error;
      if (!/Data not ready/iu.test(error.message) || attempt === 5) throw error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

const auth = await api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, "content-type": "application/json" };
const appBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}`;
const tableBase = (id) => `${appBase}/tables/${id}`;
const sourceBase = tableBase(sourceTableId);

const [tablesPayload, fieldsPayload, sourceRows] = await Promise.all([
  api(`${appBase}/tables?page_size=100`, { headers }),
  api(`${sourceBase}/fields?page_size=100`, { headers }),
  listRecords(sourceBase, headers),
]);
const activityRows = sourceRows.filter((row) => String(row.fields?.["类型"] || "").trim() === "活动");
let activityTable = (tablesPayload.data?.items || []).find((table) => table.name === "活动" && table.table_id !== sourceTableId);

if (!execute) {
  console.log(JSON.stringify({
    mode: "dry-run",
    sourceRows: sourceRows.length,
    activityRows: activityRows.length,
    otherRows: sourceRows.length - activityRows.length,
    activityTable: activityTable ? { tableId: activityTable.table_id, name: activityTable.name } : null,
    action: "创建真实活动表、复制活动记录、校验后从原表移除活动记录；空白日期分隔行不移动",
  }, null, 2));
  process.exit(0);
}

if (!activityTable) {
  const fields = (fieldsPayload.data?.items || []).map((field) => ({
    field_name: field.field_name,
    type: field.type,
    // 飞书 URL 字段不接受空对象，必须显式传 null；其他字段沿用原表配置。
    property: field.type === 15 ? null : (field.property || {}),
  }));
  const created = await api(`${appBase}/tables`, {
    method: "POST",
    headers,
    body: JSON.stringify({ table: { name: "活动", fields } }),
  });
  const tableId = created.data?.table_id || created.data?.table?.table_id;
  if (!tableId) throw new Error("活动表创建成功但未返回表 ID");
  activityTable = { table_id: tableId, name: "活动" };
}

const activityBase = tableBase(activityTable.table_id);
const targetRows = await listRecords(activityBase, headers);
const targetKeys = new Set(targetRows.map((row) => linkKey(row.fields)).filter(Boolean));
const toCreate = activityRows.filter((row) => {
  const key = linkKey(row.fields);
  return key ? !targetKeys.has(key) : true;
});
for (let index = 0; index < toCreate.length; index += 100) {
  await api(`${activityBase}/records/batch_create`, {
    method: "POST",
    headers,
    body: JSON.stringify({ records: toCreate.slice(index, index + 100).map((row) => ({ fields: row.fields || {} })) }),
  });
}

const verifiedRows = await listRecords(activityBase, headers);
const verifiedKeys = new Set(verifiedRows.map((row) => linkKey(row.fields)).filter(Boolean));
const missing = activityRows.filter((row) => {
  const key = linkKey(row.fields);
  return key ? !verifiedKeys.has(key) : false;
});
if (missing.length) throw new Error(`活动表校验失败：仍有 ${missing.length} 条活动未复制，原表未删除`);

// 飞书批量删除接口在当前租户返回 RecordIdNotFound；改用低并发单记录删除。
// 每条在“数据未就绪”时自动退避重试，失败时保留可安全重试的双份数据。
for (let index = 0; index < activityRows.length; index += 2) {
  await Promise.all(activityRows.slice(index, index + 2).map((row) =>
    deleteWithRetry(sourceBase, headers, row.record_id),
  ));
}
const sourceAfterDelete = await listRecords(sourceBase, headers);
const remainingActivities = sourceAfterDelete.filter((row) => String(row.fields?.["类型"] || "").trim() === "活动");
if (remainingActivities.length) throw new Error(`原表仍有 ${remainingActivities.length} 条活动未删除，可直接重试迁移脚本`);

console.log(JSON.stringify({
  mode: "execute",
  activityTableId: activityTable.table_id,
  copied: toCreate.length,
  verifiedActivities: activityRows.length,
  removedFromSource: activityRows.length,
  sourceRowsRemaining: sourceAfterDelete.length,
  note: "空白日期分隔行保留在原表；后续同步已按类型写入新游表或活动表",
}, null, 2));
