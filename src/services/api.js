const BASE = "/api";

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...options.headers },
      ...options,
      signal: options.signal || AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error("本地服务暂时不可用，请点击重新加载并恢复服务");
  }
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error("本地服务返回了无效响应，请点击重新加载以恢复后端服务"); }
  if (!raw) throw new Error("本地服务暂无响应，请点击重新加载以恢复后端服务");
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

async function recoverBackend() {
  const res = await fetch("/__local/recover-backend", { method: "POST" });
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error("本地恢复服务返回无效响应"); }
  if (!res.ok || !data.ok) throw new Error(data.message || "后端恢复失败");
  return data;
}

export const api = {
  health: () => request("/health"),
  recoverBackend,

  listSources: () => request("/sources"),
  createSource: (body) => request("/sources", { method: "POST", body: JSON.stringify(body) }),
  deleteSource: (id) => request(`/sources/${id}`, { method: "DELETE" }),

  crawlCandidates: (sourceIds) => request("/crawl/candidates", {
    method: "POST", body: JSON.stringify({ sourceIds }),
  }),
  crawlDetails: (articleIds) => request("/crawl/details", {
    method: "POST", body: JSON.stringify({ articleIds }),
  }),
  refreshRaw: () => request("/crawl/raw-refresh", { method: "POST" }),
  estimateDetails: (articleIds) => request("/crawl/estimate", {
    method: "POST", body: JSON.stringify({ articleIds }),
  }),
  crawlStatus: () => request("/crawl/status"),
  crawlMonitor: () => request("/crawl/monitor"),

  listTodayArticles: () => request("/articles/today"),
  listArticles: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/articles${qs ? "?" + qs : ""}`);
  },
  reviewArticle: (id, body) => request(`/articles/${id}/review`, {
    method: "POST", body: JSON.stringify(body),
  }),

  generateBrief: (body) => request("/briefs/generate", {
    method: "POST", body: JSON.stringify(body),
  }),
  exportBriefHtml: (brief) => request("/briefs/export-html", {
    method: "POST", body: JSON.stringify({ brief }),
  }),
  generateDailyPoster: (body) => request("/daily-poster/generate", {
    method: "POST", body: JSON.stringify(body),
  }),
  generateWeeklyPoster: () => request("/weekly-poster/generate", { method: "POST" }),
  listDailyPosters: ({ scope = "active" } = {}) => request(`/daily-poster/records${scope === "trash" ? "?scope=trash" : ""}`),
  trashDailyPoster: (fileName) => request(`/daily-poster/${encodeURIComponent(fileName)}/trash`, { method: "POST" }),
  restoreDailyPoster: (fileName) => request(`/daily-poster/${encodeURIComponent(fileName)}/restore`, { method: "POST" }),
  deleteDailyPoster: (fileName) => request(`/daily-poster/${encodeURIComponent(fileName)}`, { method: "DELETE" }),
  listBriefs: ({ scope = "active" } = {}) =>
    request(`/briefs${scope === "trash" ? "?scope=trash" : ""}`),
  clearBriefs: () => request("/briefs", { method: "DELETE" }),
  listBriefArchive: (slot = "daily", { scope = "active" } = {}) => request(`/brief/archive/${slot}${scope === "trash" ? "?scope=trash" : ""}`),
  getBriefArchive: (slot, date, { scope = "active" } = {}) => request(`/brief/archive/${slot}/${date}${scope === "trash" ? "?scope=trash" : ""}`),
  trashBriefArchive: (slot, date) => request(`/brief/archive/${slot}/${date}/trash`, { method: "POST" }),
  restoreBriefArchive: (slot, date) => request(`/brief/archive/${slot}/${date}/restore`, { method: "POST" }),
  deleteBriefArchive: (slot, date) => request(`/brief/archive/${slot}/${date}?scope=trash`, { method: "DELETE" }),
  saveBrief: (brief) => request("/briefs", {
    method: "POST", body: JSON.stringify(brief),
  }),
  deleteBrief: (id) => request(`/briefs/${id}`, { method: "DELETE" }),
  trashBrief: (id) => request(`/briefs/${id}/trash`, { method: "POST" }),
  restoreBrief: (id) => request(`/briefs/${id}/restore`, { method: "POST" }),

  dailyBrief: () => request("/daily-brief"),
  dashboard: () => request("/dashboard"),
  dashboardDetail: (articleId, eventIndex = null) => {
    const qs = eventIndex == null ? "" : `?eventIndex=${encodeURIComponent(eventIndex)}`;
    return request(`/dashboard/detail/${encodeURIComponent(articleId)}${qs}`);
  },
  rawFeed: (scope = "today_future") => request(`/raw-feed?scope=${encodeURIComponent(scope)}`),
  runPipeline: () => request("/pipeline/run", { method: "POST" }),
};
