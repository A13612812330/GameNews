/**
 * 海报渲染防护 —— 把「截图前必须处理的两件事」从 scripts/scheduled-posters.mjs 里剥出来。
 *
 * 为什么单独一个模块：scheduled-posters.mjs 是顶层脚本（import 到一半就开始投递、发飞书），
 * 它的内部逻辑在验证脚本里根本引不到。把这两件事做成纯函数之后，
 * scripts/verify-poster-pipeline-hardening.mjs 可以直接断言，反证也能逐项打坏。
 *
 * 1. 图片可达性探测 + 占位替换
 *    `--screenshot` 要等页面 load 事件。日报海报实测有 59 张 <img>，全部指向本机
 *    /api/image-proxy?url=…（该路由内部 12s 超时）。任意一张上游慢，load 就被推迟；
 *    多张叠加即可击穿 45s 的内层截图预算 ⇒ PNG 不落盘 ⇒ 当天海报投递失败。
 *    修法：截图前先并发探测这些图片地址，把**确认不可达**的换成内联 data URI 占位图，
 *    让 load 不再依赖外网。归档原件不动，只改渲染副本。
 *
 * 2. 画布高度策略（截断保护）
 *    固定 --window-size=1100,12000：内容不足时靠裁边去掉底部空白；内容**超出**时会被
 *    静默截断 —— 那种缺失裁边救不回来（像素根本没渲染）。这里给出「裁边后仍贴着画布
 *    底边 ⇒ 判定被截断 ⇒ 加高重截一次」的判据、上限与增长系数。
 */

/** 图片被判定不可达时替换成的内联占位图（不产生任何额外网络请求）。 */
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
  '<rect width="320" height="180" fill="#eef1f5"/>' +
  '<text x="160" y="94" font-family="sans-serif" font-size="15" fill="#9aa7b4" text-anchor="middle">图片暂不可用</text>' +
  "</svg>";

// 用 charset=utf-8 + encodeURIComponent 而不是手写 base64：无需手工编码，中文也不会变成乱码。
// encodeURIComponent 会把双引号转成 %22，因此放进 src="…" 里是安全的。
export const POSTER_PLACEHOLDER_DATA_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PLACEHOLDER_SVG)}`;

const IMG_TAG_RE = /<img\b[^>]*>/giu;
const SRC_ATTR_RE = /\bsrc\s*=\s*"([^"]*)"/iu;

/** 只做必要的最小实体解码 —— 生成器统一用双引号属性，且 URL 整体经 encodeURIComponent，不会出现裸 '&'。 */
function decodeBasicEntities(value) {
  return String(value)
    .replace(/&amp;/giu, "&")
    .replace(/&#39;/gu, "'")
    .replace(/&quot;/giu, '"');
}

/** 取出 HTML 里全部 <img src="…"> 的原始值（去重、保序）。非 <img> 的图片（CSS background）不在此列。 */
export function extractImageSources(html) {
  const out = [];
  const seen = new Set();
  const text = String(html);
  for (const tag of text.match(IMG_TAG_RE) || []) {
    const matched = SRC_ATTR_RE.exec(tag);
    if (!matched) continue;
    const raw = decodeBasicEntities(matched[1]).trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * 把 <img src> 的原始值解析成可探测的绝对地址。
 * 返回 null 表示「不需要/无法探测」：空值、已是内联 data URI、或无法解析。
 */
export function resolveImageUrl(raw, serverBase = "") {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/^data:/iu.test(value)) return null; // 已经是内联内容，不会产生网络请求
  const base = String(serverBase || "").replace(/\/+$/u, "");
  const absolute = /^https?:\/\//iu.test(value);
  const joined = absolute ? value : `${base}/${value.replace(/^\/+/u, "")}`;
  try {
    return new URL(joined).toString();
  } catch {
    return null;
  }
}

/**
 * 列出需要探测的图片地址。
 * 本机图片（image-proxy / crawler-assets）是主要瓶颈来源；外网绝对地址同样会拖住 load，
 * 所以一并纳入 —— 探测只读响应头、不下载图片内容，代价很低。
 */
export function probeTargets(html, { serverBase = "" } = {}) {
  const targets = [];
  const seen = new Set();
  for (const raw of extractImageSources(html)) {
    const resolved = resolveImageUrl(raw, serverBase);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    targets.push({ raw, resolved });
  }
  return targets;
}

/** 探测单个地址：只读状态码与 content-type，拿到响应头就立刻取消 body（不下载图片）。 */
async function probeOne(url, { timeoutMs, fetchImpl }) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "GameNews-Poster-Probe/1.0" },
    });
    const contentType = String(response.headers?.get?.("content-type") || "");
    const status = Number(response.status);
    // 立刻释放连接，避免把整张图拉进内存
    try { await response.body?.cancel?.(); } catch {}
    if (!response.ok) return { ok: false, reason: `HTTP ${status}` };
    if (contentType && !contentType.startsWith("image/")) return { ok: false, reason: `content-type=${contentType}` };
    return { ok: true };
  } catch (error) {
    const name = error?.name || "";
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: `探测超时 >${timeoutMs}ms` };
    return { ok: false, reason: error?.message || "探测失败" };
  }
}

/**
 * 并发探测一批图片地址。
 *
 * 参数取值来自「最坏情况也要留在预算内」的倒推：
 *   59 张全部不可达时 = ceil(59 / 12) × 3000ms ≈ 15s，远小于外层 420s 预算里的固定开销余量。
 * budgetMs 是防御性保险：万一本机服务本身拥塞，超过预算的剩余地址标记为 unprobed
 * 并**保留原样**（绝不因为探测没跑完就把可达的图换成占位）。
 */
export async function probeImageReachability(urls, {
  timeoutMs = 3000,
  concurrency = 12,
  budgetMs = 30000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const list = [...new Set((urls || []).filter(Boolean))];
  const startedAt = Date.now();
  const failed = [];
  const unprobed = [];
  const queue = [...list];
  let reachable = 0;
  if (!list.length || typeof fetchImpl !== "function") {
    return { total: 0, reachable: 0, failed, unprobed: list, elapsedMs: 0 };
  }
  const workerCount = Math.max(1, Math.min(concurrency, list.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      if (Date.now() - startedAt > budgetMs) {
        unprobed.push(...queue.splice(0, queue.length));
        return;
      }
      const url = queue.shift();
      const result = await probeOne(url, { timeoutMs, fetchImpl });
      if (result.ok) reachable += 1;
      else failed.push({ url, reason: result.reason });
    }
  });
  await Promise.all(workers);
  return { total: list.length, reachable, failed, unprobed, elapsedMs: Date.now() - startedAt };
}

/**
 * 把判定失败的图片换成内联占位图。
 *
 * 只改 <img src="…">（生成器统一双引号）。解析不出 src 的 <img> 计入 unmatched，
 * 而不是假装成功 —— 漏改会让该图继续拖住 load，必须能被看见。
 */
export function applyImagePlaceholders(html, failedUrls, { serverBase = "", placeholder = POSTER_PLACEHOLDER_DATA_URI } = {}) {
  const failed = failedUrls instanceof Set ? failedUrls : new Set(failedUrls || []);
  if (!failed.size) return { html: String(html), replaced: 0, unmatched: 0 };
  let replaced = 0;
  let unmatched = 0;
  const out = String(html).replace(IMG_TAG_RE, (tag) => {
    const matched = SRC_ATTR_RE.exec(tag);
    if (!matched) return tag;
    const raw = decodeBasicEntities(matched[1]).trim();
    const resolved = resolveImageUrl(raw, serverBase);
    if (!resolved || !failed.has(resolved)) return tag;
    const patched = tag.replace(SRC_ATTR_RE, `src="${placeholder}" data-poster-placeholder="1"`);
    if (patched === tag) {
      unmatched += 1;
      return tag;
    }
    replaced += 1;
    return patched;
  });
  return { html: out, replaced, unmatched };
}

/**
 * 画布高度策略：裁边后仍贴着画布底边 ⇒ 内容被截断（像素根本没渲染，裁边救不回来）
 * ⇒ 加高重截一次。
 *
 * 返回的 height 是「下一轮该用的画布高度」，retry=false 时表示沿用当前高度、不再截图。
 */
export function planCanvasHeight({
  canvasHeight,
  trimmedHeight,
  attempt = 0,
  maxAttempts = 1,
  maxCanvasHeight = 24000,
  growth = 1.5,
  bottomTolerancePx = 4,
} = {}) {
  const current = Number(canvasHeight);
  if (!Number.isFinite(current) || current <= 0) {
    return { height: canvasHeight, retry: false, reason: "画布高度非法" };
  }
  if (attempt >= maxAttempts) {
    return { height: current, retry: false, reason: `已达重截上限 ${maxAttempts} 次` };
  }
  const trimmed = Number(trimmedHeight);
  if (!Number.isFinite(trimmed) || trimmed <= 0) {
    return { height: current, retry: false, reason: "裁边后高度非法" };
  }
  if (trimmed < current - bottomTolerancePx) {
    return { height: current, retry: false, reason: "内容完整落在画布内" };
  }
  const next = Math.min(Math.round(current * growth), maxCanvasHeight);
  if (next <= current) {
    return { height: current, retry: false, reason: `画布已达上限 ${maxCanvasHeight}px` };
  }
  return { height: next, retry: true, reason: `内容触底（${trimmed}px/${current}px），加高至 ${next}px 重截` };
}

/**
 * 截图命令行参数。
 *
 * `--user-data-dir` 是关键项：Edge 154 的 headless `--screenshot` 在**本机已有同 profile 的
 * GUI 实例运行**时，会把截图请求转交给那个实例，自己秒退（exit 0、约 0.1s）且不落盘 ——
 * 表现成「所有候选浏览器都截图失败」而完全看不出原因（2026-09-28 卡死的候选根因之一，
 * 当时只有「PNG 未能生成」一句笼统报错）。指向项目自有目录后，headless 必定自己处理截图。
 *
 * --no-first-run / --no-default-browser-check / --disable-extensions 都是为了去掉
 * 「首次运行向导」「默认浏览器提示」「扩展后台页」这类与截图无关的额外等待。
 */
export function buildScreenshotArgs({ previewPath, height, pageUrl, profileDir = "", extraArgs = [] }) {
  const args = [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=4000",
  ];
  if (profileDir) args.push(`--user-data-dir=${profileDir}`);
  for (const arg of extraArgs || []) args.push(arg);
  // 截图参数放最后：它们必须是「目标态」，不能被前面的选项覆盖。
  args.push(`--screenshot=${previewPath}`, `--window-size=1100,${height}`, pageUrl);
  return args;
}

/** 把探测结果压成一行诊断 + 一组结果字段，供 stderr 与结果 JSON 共用。 */
export function summarizeImageProbe(probe) {
  const failed = probe?.failed || [];
  const unprobed = probe?.unprobed || [];
  const total = Number(probe?.total) || 0;
  const reachable = Number(probe?.reachable) || 0;
  const reasonCount = new Map();
  for (const item of failed) {
    const key = String(item.reason || "未知");
    reasonCount.set(key, (reasonCount.get(key) || 0) + 1);
  }
  const reasons = [...reasonCount.entries()].map(([reason, count]) => `${reason}×${count}`).join("；");
  return {
    fields: {
      imageProbeTotal: total,
      imageProbeFailed: failed.length,
      imageProbeUnprobed: unprobed.length,
      imageProbeElapsedMs: Number(probe?.elapsedMs) || 0,
    },
    line: total
      ? `[poster] 图片可达性：${reachable}/${total} 可达` +
        (failed.length ? `，${failed.length} 张不可达已换占位图（${reasons}）` : "") +
        (unprobed.length ? `，${unprobed.length} 张未探测（超预算，保留原样）` : "") +
        `，耗时 ${Number(probe?.elapsedMs) || 0}ms`
      : "[poster] 图片可达性：素材页无外链图片，跳过探测",
  };
}
