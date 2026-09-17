import iconv from "iconv-lite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];
const RETRYABLE = /5\d\d|429|timeout|network|fetch failed|ECONN|ENOTFOUND/i;

async function fetchTapTapBrowserHtml(url) {
  const { stdout } = await execFileAsync("curl.exe", [
    "-L", "--compressed", "--max-time", "20",
    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "-H", "Accept: text/html,application/xhtml+xml",
    "-H", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
    url,
  ], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return String(stdout || "");
}

export async function fetchHtml(url, opts = {}) {
  const { dynamic = false, timeout = 15000, headers: extraHeaders = {} } = opts;
  const isBbs3839 = url.includes("bbs.3839.com");
  let lastError;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": (dynamic || isBbs3839)
            ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
            : "Mozilla/5.0 WXNewsWiki/1.0",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          ...(isBbs3839 ? { referer: "https://www.3839.com/" } : {}),
          ...(dynamic ? {
            "cache-control": "no-cache",
            "upgrade-insecure-requests": "1",
            "sec-fetch-site": "none",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
            referer: "https://www.taptap.cn/",
          } : {}),
          ...extraHeaders,
        },
        signal: AbortSignal.timeout(timeout),
      });

      // H3: Content-Type 校验
      const ct = res.headers.get("content-type") || "";
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        // 4xx 不重试，5xx/429 重试
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err;
        lastError = err;
        continue;
      }
      if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
        lastError = new Error(`NotHTML (${ct.split(";")[0]}) from ${url}`);
        continue; // 可能是反爬，重试一次
      }

      const buf = Buffer.from(await res.arrayBuffer());
      let charset =
        ct.match(/charset=([^;\s]+)/i)?.[1] ||
        buf.subarray(0, 4096).toString("ascii").match(/charset=["']?([^"'\s/>]+)/i)?.[1] ||
        "";

      // M5: 无 charset 头时启发式检测
      let text;
      if (/gbk|gb2312|gb18030/i.test(charset)) {
        text = iconv.decode(buf, "gb18030");
      } else if (/utf-?8/i.test(charset)) {
        text = buf.toString("utf8");
      } else {
        // 无明确声明：先试 utf-8，若含替换符 U+FFFD 则回退 gb18030
        text = buf.toString("utf8");
        if (text.includes("\uFFFD") && /[\u4e00-\u9fff]/.test(iconv.decode(buf, "gb18030"))) {
          text = iconv.decode(buf, "gb18030");
        }
      }
      // TapTap 新版本榜偶发向 Node fetch 返回不含列表的 SSR 空壳；
      // 使用本机浏览器兼容请求补取真实列表，后续仍由专用 parser 解析。
      if (url.includes("taptap.cn/top/in-app-event-reserve") && !text.includes("ranking-card")) {
        try {
          const browserHtml = await fetchTapTapBrowserHtml(url);
          if (browserHtml.includes("ranking-card")) return browserHtml;
        } catch { /* 继续返回普通响应，交给 Firecrawl 兜底 */ }
      }
      return text;
    } catch (e) {
      lastError = e;
      if (!RETRYABLE.test(e.message || "")) throw e; // 非瞬时错误不重试
    }
    if (attempt < RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
  }
  throw lastError || new Error(`fetch failed after ${RETRIES} attempts: ${url}`);
}
