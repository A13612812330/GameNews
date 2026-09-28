/**
 * 移除 Edge 长截图底部的空白背景，保留海报实际内容和底部留白。
 *
 * 为什么用 Node 而不是 Python/PIL（2026-09-28 定位）：
 * 原实现是 `execFileSync(process.env.PYTHON_BIN || "python", [...])`。本机 PATH 上的
 * `python` 是托管 3.13.12，**没有装 PIL** ⇒ 每次都抛 `ModuleNotFoundError`；
 * 而调用处是 `try/catch + console.warn`，错误被吞掉 ⇒ 裁边静默失效 ⇒
 * 1100x12000 的整块空白画布被原样上传到飞书（09-24/25/26 的日报都是 12000px，
 * 实测底部空白占 82%）。改成纯 Node（zlib 解 PNG 像素）后不再依赖任何外部解释器。
 *
 * 用法：
 *   node scripts/trim-poster-preview.mjs <png-path>          # 就地裁边
 *   node scripts/trim-poster-preview.mjs <png-path> --report # 只报告，不写盘
 */

import fs from "node:fs";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 底部保留的呼吸空间，与旧 Python 版保持一致，避免视觉回归。 */
const BOTTOM_PADDING = 73;
/** 单像素判定为“与背景不同”的曼哈顿距离阈值。 */
const PIXEL_DELTA = 10;
/** 一行内至少有这么多采样点变化才算内容行。 */
const MIN_CHANGED_SAMPLES = 3;

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("不是合法的 PNG 文件");
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function buildChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 解出 IHDR 与逐行无过滤的像素数据（仅支持 8bit、非隔行）。 */
function decodePixels(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr) throw new Error("PNG 缺少 IHDR");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}（仅支持 8bit）`);
  if (interlace !== 0) throw new Error("不支持隔行扫描 PNG");
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);

  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)));
  if (inflated.length !== height * (stride + 1)) {
    throw new Error(`PNG 数据长度异常：期望 ${height * (stride + 1)}，实际 ${inflated.length}`);
  }

  const pixels = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[cursor];
    cursor += 1;
    const lineStart = y * stride;
    const prevStart = lineStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[cursor + x];
      const a = x >= channels ? pixels[lineStart + x - channels] : 0;
      const b = y > 0 ? pixels[prevStart + x] : 0;
      const c = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;
      let value = raw;
      if (filterType === 1) value = (raw + a) & 0xff;
      else if (filterType === 2) value = (raw + b) & 0xff;
      else if (filterType === 3) value = (raw + ((a + b) >> 1)) & 0xff;
      else if (filterType === 4) value = (raw + paeth(a, b, c)) & 0xff;
      else if (filterType !== 0) throw new Error(`未知的行过滤类型 ${filterType}（第 ${y} 行）`);
      pixels[lineStart + x] = value;
    }
    cursor += stride;
  }
  return { width, height, channels, colorType, stride, pixels };
}

function isContentRow(pixels, width, channels, stride, y, background) {
  const step = Math.max(1, Math.floor(width / 180));
  let changed = 0;
  for (let x = 0; x < width; x += step) {
    const offset = y * stride + x * channels;
    let delta = 0;
    for (let index = 0; index < 3; index += 1) {
      delta += Math.abs(pixels[offset + index] - background[index]);
      if (delta > PIXEL_DELTA) break;
    }
    if (delta > PIXEL_DELTA) {
      changed += 1;
      if (changed >= MIN_CHANGED_SAMPLES) return true;
    }
  }
  return false;
}

function findLastContentRow(pixels, width, channels, stride, y, background) {
  for (let row = y; row >= 0; row -= 1) {
    if (isContentRow(pixels, width, channels, stride, row, background)) return row;
  }
  return -1;
}

function encodePng(width, height, colorType, pixels, stride) {
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk("IHDR", ihdr),
    buildChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    buildChunk("IEND", Buffer.alloc(0)),
  ]);
}

function main() {
  const args = process.argv.slice(2);
  const reportOnly = args.includes("--report");
  const filePath = args.find((arg) => !arg.startsWith("--"));
  if (!filePath) throw new Error("用法：node scripts/trim-poster-preview.mjs <png-path> [--report]");

  const decoded = decodePixels(fs.readFileSync(filePath));
  const { width, height, channels, colorType, stride, pixels } = decoded;
  const background = [pixels[(height - 1) * stride], pixels[(height - 1) * stride + 1], pixels[(height - 1) * stride + 2]];
  const lastContent = findLastContentRow(pixels, width, channels, stride, height - 1, background);

  if (lastContent < 0) {
    console.log(JSON.stringify({ file: filePath, width, height, lastContent: null, action: "skip", reason: "整图无内容行" }));
    return;
  }
  // 与旧 Python 版逐像素对齐：bottom = last_content + 73（73 是含末行的偏移量）。
  const bottom = Math.min(height, lastContent + BOTTOM_PADDING);
  if (bottom >= height) {
    console.log(JSON.stringify({ file: filePath, width, height, lastContent, action: "skip", reason: "底部无需裁边" }));
    return;
  }

  const summary = { file: filePath, width, height, lastContent, trimmedHeight: bottom, removed: height - bottom, action: reportOnly ? "report" : "written" };
  if (!reportOnly) {
    const cropped = Buffer.alloc(bottom * stride);
    pixels.copy(cropped, 0, 0, bottom * stride);
    fs.writeFileSync(filePath, encodePng(width, bottom, colorType, cropped, stride));
  }
  console.log(JSON.stringify(summary));
}

try {
  main();
} catch (error) {
  // 让调用方能看到真实原因，不再像旧实现那样只剩一句模糊 warn。
  console.error(`[trim-poster-preview] ${error.message}`);
  process.exit(1);
}
