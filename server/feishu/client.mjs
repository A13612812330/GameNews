// 飞书 OpenAPI 客户端（P5）：bot 身份 + tenant_access_token，raw fetch。
// lark-cli 仅用于排查权限/连通性，不作为正式运行依赖。
// 密钥只来自 .env.local（server/env.mjs），不读写/打印任何凭据。
import { env } from "../env.mjs";

const BASE = "https://open.feishu.cn/open-apis";

const tokenCache = new Map(); // appId -> { token, expiresAt }

// 获取租户令牌（内部应用），带过期缓存
export async function tenantAccessToken(appId, appSecret) {
  const cached = tokenCache.get(appId);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const r = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const p = await r.json().catch(() => ({}));
  if (!r.ok || Number(p.code || 0) !== 0 || !p.tenant_access_token) {
    throw new Error(`飞书令牌获取失败: ${p.msg || r.status}`);
  }
  const expiresMs = (Number(p.expire) || 7200) * 1000;
  tokenCache.set(appId, { token: p.tenant_access_token, expiresAt: Date.now() + expiresMs });
  return p.tenant_access_token;
}

async function request(token, url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(30000),
  });
  const p = await r.json().catch(() => ({}));
  if (!r.ok || Number(p.code || 0) !== 0) {
    const e = new Error(`飞书 API 失败 ${r.status}: ${p.msg || p.code || "未知"}`);
    e.feishu = p;
    throw e;
  }
  return p.data || {};
}

// ---------- bitable 结构（启动校验用） ----------
export async function listTables(token, appToken) {
  const data = await request(token, `${BASE}/bitable/v1/apps/${appToken}/tables?page_size=100`);
  return data.items || [];
}
export async function listViews(token, appToken, tableId) {
  const data = await request(token, `${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/views?page_size=100`);
  return data.items || [];
}
export async function getView(token, appToken, tableId, viewId) {
  const data = await request(token, `${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/views/${viewId}`);
  return data.view || data;
}

// ---------- 记录 ----------
export async function searchRecords(token, appToken, tableId, { filter = "", pageSize = 500, pageToken = "" } = {}) {
  const params = new URLSearchParams({ page_size: String(pageSize) });
  if (pageToken) params.set("page_token", pageToken);
  const body = filter ? { filter } : {};
  const data = await request(token, `${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/search?${params}`, {
    method: "POST", body: JSON.stringify(body),
  });
  return { items: data.items || [], total: data.total ?? 0, pageToken: data.has_more ? data.page_token : "" };
}
export async function listRecords(token, appToken, tableId, { pageSize = 500, pageToken = "" } = {}) {
  const params = new URLSearchParams({ page_size: String(pageSize) });
  if (pageToken) params.set("page_token", pageToken);
  const data = await request(token, `${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params}`);
  return { items: data.items || [], pageToken: data.has_more ? data.page_token : "" };
}
export async function createRecord(token, appToken, tableId, fields) {
  const data = await request(token, `${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: "POST", body: JSON.stringify({ fields }),
  });
  return data.record || {};
}
export async function updateRecord(token, appToken, tableId, recordId, fields) {
  const data = await request(token, `${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: "PUT", body: JSON.stringify({ fields }),
  });
  return data.record || {};
}
export async function batchCreateRecords(token, appToken, tableId, records) {
  const data = await request(token, `${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
    method: "POST", body: JSON.stringify({ records }),
  });
  return data.records || [];
}
export async function batchUpdateRecords(token, appToken, tableId, updates) {
  const data = await request(token, `${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`, {
    method: "POST", body: JSON.stringify({ records: updates }),
  });
  return data.records || [];
}

// ---------- 图片 / 消息 ----------
// 下载远程图片并上传为飞书消息图片，返回 image_key（失败返回空，不抛）
export async function uploadRemoteImage(token, url) {
  if (!/^https?:\/\//iu.test(String(url || ""))) return "";
  try {
    const img = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    if (!img.ok) return "";
    const blob = await img.blob();
    if (!String(blob.type || "").startsWith("image/")) return "";
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", blob, "gamenews.jpg");
    const data = await request(token, `${BASE}/im/v1/images`, { method: "POST", body: form });
    return String(data.image_key || "");
  } catch {
    return "";
  }
}

// 上传本地 PNG 为飞书消息图片（海报用），返回 image_key
export async function uploadLocalImage(token, filePath) {
  const fs = await import("node:fs");
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", new Blob([buf], { type: "image/png" }), "poster.png");
  const data = await request(token, `${BASE}/im/v1/images`, { method: "POST", body: form });
  return String(data.image_key || "");
}

// 发送交互卡片到群（receive_id_type=chat_id）
export async function sendCard(token, chatId, card) {
  const data = await request(token, `${BASE}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) }),
  });
  return String(data.message_id || "");
}

// ---------- 配置读取（汇总三套应用，便于排查） ----------
export function monitorConfig({ required = false } = {}) {
  return {
    appId: env("FEISHU_MONITOR_APP_ID", { required }),
    appSecret: env("FEISHU_MONITOR_APP_SECRET", { required }),
    appToken: env("FEISHU_MONITOR_APP_TOKEN", { required }),
    tableId: env("FEISHU_MONITOR_TABLE_ID", { required }),
    ratingTableId: env("FEISHU_MONITOR_RATING_TABLE_ID", { required }),
  };
}
export function topicConfig({ required = false } = {}) {
  return {
    appId: env("FEISHU_TOPIC_APP_ID", { required }),
    appSecret: env("FEISHU_TOPIC_APP_SECRET", { required }),
    chatId: env("FEISHU_TOPIC_CHAT_ID", { required }),
  };
}
export function posterConfig({ required = false } = {}) {
  return {
    appId: env("FEISHU_POSTER_APP_ID", { required }),
    appSecret: env("FEISHU_POSTER_APP_SECRET", { required }),
    chatId: env("FEISHU_POSTER_CHAT_ID", { required }),
  };
}
