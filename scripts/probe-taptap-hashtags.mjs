/**
 * 一次性探测：TapTap「热榜话题」入口现在到底还能不能抓、有没有替代接口。
 * 只读，不写库。
 *
 * 2026-09-28 结论（据此把 registry.js 里该条置 enabled:false）：
 *   - `/forum/hot/hashtags` 已 302 到 `/forum`：两者返回的页面几乎字节相同
 *     （281796 vs 282022），旧选择器 `hot-hashtag-item` 在新页面 **0 次**出现，
 *     旧话题链接 `/forum/hot/hashtags?item=N` 也是 0 个。
 *   - 但 `HotHashtagItem` 的 CSS/JS **仍在页面预加载**，且 `/forum` 里有
 *     `<div data-column-id="hashtags">` 列切换条（纯 JS `<button>`，无链接、无参数）
 *     ⇒ 功能没被删，只是从独立页改成了 /forum 的一个 tab，数据由前端点击后异步取。
 *   - `?column=hashtags` / `?tab=hashtags` / `/forum/hashtags` 都不改变服务端输出，
 *     页面内暴露的 webapiv2 路径只剩 `discover-categories/v2/feed-list`。
 *   - 下一步若要恢复：需要用无头浏览器点击该 tab 并抓包，定位它真正请求的接口。
 *
 * 用法：node scripts/probe-taptap-hashtags.mjs
 */
import { fetchHtml } from "../server/crawler/fetcher.js";

function normalize(html) {
  return String(html)
    .replace(/\\u002F/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/");
}

function markers(text) {
  return {
    len: text.length,
    hot_hashtag_item: (text.match(/hot-hashtag-item/g) || []).length,
    old_topic_links: (text.match(/\/forum\/hot\/hashtags\?item=\d+/g) || []).length,
    residual_hot_paths: [...new Set(text.match(/\/forum\/hot\/[A-Za-z0-9\-_/]*/g) || [])].length,
    hot_hashtag_asset: (text.match(/HotHashtagItem/g) || []).length,
    columns: [...new Set(text.match(/data-column-id="[^"]+"/g) || [])],
  };
}

async function probe(label, url, opts = {}) {
  try {
    const text = normalize(await fetchHtml(url, opts));
    console.log(`\n[${label}] ${url}${opts.dynamic ? "  (dynamic)" : ""}`);
    console.log("  ", JSON.stringify(markers(text)));
    const apis = [...new Set(text.match(/webapiv2\/[A-Za-z0-9\-_/]+/g) || [])];
    console.log("   webapiv2 路径:", apis.join(", ") || "(无)");
  } catch (e) {
    console.log(`\n[${label}] ${url}`);
    console.log("   ERROR", e.message);
  }
}

// 1) 旧入口 vs 论坛首页：若两者内容近似则为 302
await probe("旧入口", "https://www.taptap.cn/forum/hot/hashtags");
await probe("论坛首页", "https://www.taptap.cn/forum");
// 2) 动态渲染下是否出现旧选择器
await probe("旧入口", "https://www.taptap.cn/forum/hot/hashtags", { dynamic: true });
// 3) 猜列切换参数是否影响服务端输出
await probe("?column=", "https://www.taptap.cn/forum?column=hashtags");
await probe("?tab=", "https://www.taptap.cn/forum?tab=hashtags");
// 4) 猜路径
await probe("/forum/hashtags", "https://www.taptap.cn/forum/hashtags");

// 5) 深挖 Nuxt 载荷里是否还有话题结构
const html = normalize(await fetchHtml("https://www.taptap.cn/forum"));
const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
if (!m) {
  console.log("\n未找到 __NUXT_DATA__");
} else {
  try {
    const payload = JSON.parse(m[1]);
    const keys = new Set();
    const strings = new Set();
    const walk = (v, depth = 0) => {
      if (depth > 40 || v == null) return;
      if (typeof v === "string") { strings.add(v); return; }
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      if (typeof v === "object") {
        for (const [k, val] of Object.entries(v)) { keys.add(k); walk(val, depth + 1); }
      }
    };
    walk(payload);
    console.log("\n__NUXT_DATA__ 长度:", payload.length);
    console.log("  可疑 key:", [...keys].filter((k) => /hashtag|hot|tag/i.test(k)).join(", ") || "(无)");
    console.log(
      "  可疑字符串:",
      [...strings].filter((s) => /hot-hashtag|hashtag/i.test(s) && s.length < 120).slice(0, 12).join(" | ") || "(无)",
    );
  } catch (e) {
    console.log("\n__NUXT_DATA__ 解析失败:", e.message);
  }
}
