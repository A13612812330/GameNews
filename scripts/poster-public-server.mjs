import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posterRoot = path.join(projectRoot, "output", "scheduled-posters");
const snapshotRoot = path.join(projectRoot, "data", "weekly-snapshots");
const port = Number(process.env.POSTER_PUBLIC_PORT || 64425);

const IMAGE_TIMEOUT_MS = 15000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_CACHE_MS = 10 * 60 * 1000;
const IMAGE_CACHE_MAX = 300;
const imageCache = new Map();

function posterNameFromPath(pathname) {
  const prefix = "/posters/";
  if (!pathname.startsWith(prefix)) return "";
  try {
    const name = decodeURIComponent(pathname.slice(prefix.length));
    return /^[^\\/:*?"<>|]+\.(?:html|png)$/iu.test(name) && !name.includes("..") ? name : "";
  } catch {
    return "";
  }
}

function assetPathFromRequest(pathname) {
  const prefix = "/assets/";
  if (!pathname.startsWith(prefix)) return "";
  const relative = decodeURIComponent(pathname.slice(prefix.length));
  if (!/^\d{4}-\d{2}-\d{2}\/assets\/[^\\/:*?"<>|]+\.(?:png|jpe?g|webp|gif|avif)$/iu.test(relative)) return "";
  return path.resolve(snapshotRoot, relative);
}

/**
 * 源站图片（TapTap / 机核 / 游民星空）按 Referer 防盗链：浏览器从隧道域名
 * 直连源站会带站外 Referer，被 403 / 567 拦掉 ⇒ 公开链接整片白图。
 * 所以公开服务必须**由服务端代取**（不带 Referer），而不是把原始地址甩给访问者。
 */
function remoteImageUrl(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  const host = target.hostname.toLowerCase();
  // 只读公开图片代理，禁止把隧道当成内网探测工具。
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/u.test(host)) return null;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)) return null;
  if (!host.includes(".")) return null;
  return target.toString();
}

async function readCachedImage(url) {
  const hit = imageCache.get(url);
  if (hit && Date.now() - hit.at < IMAGE_CACHE_MS) return hit;
  if (hit) imageCache.delete(url);
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    redirect: "follow",
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.startsWith("image/")) throw new Error(`upstream ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length || body.length > IMAGE_MAX_BYTES) throw new Error("image empty or too large");
  const entry = { body, type, at: Date.now() };
  imageCache.set(url, entry);
  if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  return entry;
}

async function serveRemoteImage(requestUrl, req, res) {
  const raw = requestUrl.searchParams.get("url") || "";
  const target = remoteImageUrl(raw);
  if (!target) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad url");
    return;
  }
  try {
    const entry = await readCachedImage(target);
    res.writeHead(200, {
      "content-type": entry.type,
      "content-length": entry.body.length,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") { res.end(); return; }
    res.end(entry.body);
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(`upstream image failed: ${error?.message || "unknown"}`);
  }
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end('{"ok":true}');
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  if (requestUrl.pathname === "/image") {
    serveRemoteImage(requestUrl, req, res);
    return;
  }

  const name = posterNameFromPath(requestUrl.pathname);
  const assetPath = assetPathFromRequest(requestUrl.pathname);
  if (assetPath) {
    if (!assetPath.startsWith(`${snapshotRoot}${path.sep}`) || !fs.existsSync(assetPath)) {
      res.writeHead(404); res.end(); return;
    }
    const ext = path.extname(assetPath).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(assetPath).pipe(res);
    return;
  }
  if (!name) {
    res.writeHead(404);
    res.end();
    return;
  }

  const filePath = path.resolve(posterRoot, name);
  if (!filePath.startsWith(`${posterRoot}${path.sep}`) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end();
    return;
  }

  const contentType = name.endsWith(".png") ? "image/png" : "text/html; charset=utf-8";
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  if (name.endsWith(".html")) {
    let html = fs.readFileSync(filePath, "utf8");
    // 快照主图走本地副本（同源 /assets/），彻底绕开源站防盗链。
    html = html.replace(/https?:\/\/127\.0\.0\.1:\d+\/weekly-assets\//giu, "/assets/");
    // 没有本地副本的图片：改由本服务代取（/image?url=），
    // 不能保留原始地址 —— 访问者浏览器直连源站会因站外 Referer 被 403/567 拦掉。
    html = html.replace(/https?:\/\/127\.0\.0\.1:\d+\/api\/image-proxy\?url=([^"'\s>]+)/giu, (_match, encodedUrl) => `/image?url=${encodedUrl}`);
    res.end(html);
    return;
  }
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Poster public server listening on 127.0.0.1:${port}`);
});
