import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posterRoot = path.join(projectRoot, "output", "scheduled-posters");
const port = Number(process.env.POSTER_PUBLIC_PORT || 64425);

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

  const name = posterNameFromPath(requestUrl.pathname);
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
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Poster public server listening on 127.0.0.1:${port}`);
});
