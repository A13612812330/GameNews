import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MIN_BYTES = 20 * 1024;
const MAX_BYTES = 6 * 1024 * 1024;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 270;
// 详情页正文需要保留足够的插图顺序；上限仍用于隔离超长图集和异常页面。
const MAX_IMAGES = 24;

export async function downloadImages(imageUrls = [], batchId, articleId, outputDir, options = {}) {
  const dir = path.join(outputDir, batchId, "images");
  await fs.mkdir(dir, { recursive: true });

  const maxImages = Math.min(Number(options.maxImages) || MAX_IMAGES, 32);
  const minWidth = Number(options.minWidth) || MIN_WIDTH;
  const minHeight = Number(options.minHeight) || MIN_HEIGHT;
  const candidates = imageUrls.slice(0, maxImages).filter(i => i?.url && /^https?:\/\//i.test(i.url));
  const results = [];
  const seen = new Set();
  // 跨批次复用依据：标准游戏名 + 图片原文件名。调用方只传入同游戏的历史图片，
  // 因此这里无需扫描整个 crawler 目录，也不会把其他游戏的同名图片误复用。
  const reusableByFileName = new Map();
  for (const saved of options.reuseImages || []) {
    const fileName = imageFileName(saved?.originalUrl || saved?.url || saved?.src || "");
    const localPath = crawlerAssetPath(saved?.src || saved?.localUrl, outputDir);
    if (fileName && localPath && !reusableByFileName.has(fileName)) {
      reusableByFileName.set(fileName, { saved, localPath });
    }
  }
  const seenFileNames = new Set();
  const CONCURRENCY = 3;

  async function downloadOne(image, index) {
    try {
      const remoteFileName = imageFileName(image.url);
      // 同游戏下同名图片只保留一次；先尝试复用历史本地文件，避免再次联网下载。
      if (seenFileNames.has(remoteFileName)) return null;
      seenFileNames.add(remoteFileName);

      const reusable = reusableByFileName.get(remoteFileName);
      if (reusable) {
        const reused = await readReusableImage(reusable.localPath, image, index, articleId, minWidth, minHeight, reusable.saved);
        if (reused) return reused;
      }

      const hostname = new URL(image.url).hostname.toLowerCase();
      const referer = hostname.endsWith("tapimg.com") ? "https://www.taptap.cn/"
        : hostname.endsWith("gcores.com") ? "https://www.gcores.com/"
          : hostname.endsWith("gamersky.com") ? "https://www.gamersky.com/"
            : hostname.endsWith("71acg.net") ? "https://www.3839.com/" : undefined;
      const response = await fetch(image.url, {
        headers: { "user-agent": "Mozilla/5.0 GameNewsHub/1.0", ...(referer ? { referer } : {}) },
        signal: AbortSignal.timeout(10000),
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.toLowerCase().startsWith("image/")) return null;

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < MIN_BYTES || buffer.length > MAX_BYTES) return null;
      const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
      if (seen.has(sha1)) return null;
      seen.add(sha1);

      const dimensions = readImageDimensions(buffer, contentType);
      if (!dimensions || dimensions.width < minWidth || dimensions.height < minHeight) return null;

      const extension = extensionFor(contentType);
      const fileName = `${articleId}-${index + 1}.${extension}`;
      await fs.writeFile(path.join(dir, fileName), buffer);

      return {
        id: `${articleId}-image-${index + 1}`,
        src: `/crawler-assets/${batchId}/images/${fileName}`,
        originalUrl: image.url,
        type: index === 0 ? "cover_candidate" : "body_candidate",
        width: dimensions.width,
        height: dimensions.height,
        size: buffer.length,
        mimeType: contentType,
        sha1,
      };
    } catch {
      return null; // 图片是增强数据，单张失败不应让详情任务失败。
    }
  }

  // 3 并发分片
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map((img, k) => downloadOne(img, i + k)));
    results.push(...chunkResults.filter(Boolean));
  }
  return results;
}

function imageFileName(value = "") {
  try {
    const url = new URL(String(value));
    const name = decodeURIComponent(path.posix.basename(url.pathname || ""));
    return name.replace(/[^a-z0-9._-]/gi, "_").slice(0, 180) || "image";
  } catch {
    return "";
  }
}

function crawlerAssetPath(value, outputDir) {
  const prefix = "/crawler-assets/";
  const source = String(value || "");
  if (!source.startsWith(prefix)) return null;
  const root = path.resolve(outputDir);
  const localPath = path.resolve(root, source.slice(prefix.length).replaceAll("/", path.sep));
  return localPath.startsWith(`${root}${path.sep}`) ? localPath : null;
}

async function readReusableImage(localPath, image, index, articleId, minWidth, minHeight, saved = {}) {
  try {
    const buffer = await fs.readFile(localPath);
    if (buffer.length < MIN_BYTES || buffer.length > MAX_BYTES) return null;
    const mimeType = mimeTypeForPath(localPath);
    const dimensions = readImageDimensions(buffer, mimeType);
    if (!dimensions || dimensions.width < minWidth || dimensions.height < minHeight) return null;
    return {
      id: `${articleId}-image-${index + 1}`,
      src: saved.src || saved.localUrl,
      originalUrl: image.url,
      type: index === 0 ? "cover_candidate" : "body_candidate",
      width: dimensions.width,
      height: dimensions.height,
      size: buffer.length,
      mimeType,
      sha1: crypto.createHash("sha1").update(buffer).digest("hex"),
      reused: true,
    };
  } catch {
    return null;
  }
}

function mimeTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function extensionFor(contentType) {
  const subtype = contentType.split("/")[1]?.split(";")[0] || "jpg";
  return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/gi, "") || "jpg";
}

function readImageDimensions(buffer, contentType) {
  const type = contentType.toLowerCase();
  if (type.includes("png") && buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (type.includes("gif") && buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (type.includes("webp") && buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (type.includes("jpeg") || type.includes("jpg")) return readJpegDimensions(buffer);
  return null;
}

function readJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
