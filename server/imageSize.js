/**
 * 从图片字节流直接读取真实像素尺寸（零依赖，不引入 sharp/PIL）。
 *
 * 用途：好游快爆活动条目的列表封面是 256×256 游戏图标，周报活动卡需要活动大图，
 * 因此会在快照落盘时按候选顺序下载并**实测**尺寸，只有当图片确实是「非正方形大图」
 * 时才替换，避免把另一个图标当成大图用。
 */

function readPng(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { type: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    // SOF0..SOF15（不含 DHT/JPG/DAC）携带帧尺寸。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: "jpeg", height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (!length) return null;
    offset += 2 + length;
  }
  return null;
}

function readWebp(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const fourcc = buffer.toString("ascii", 12, 16);
  if (fourcc === "VP8X") {
    return {
      type: "webp",
      width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
      height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
    };
  }
  if (fourcc === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === "VP8 ") return { type: "webp", width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  return null;
}

function readGif(buffer) {
  if (buffer.length < 10) return null;
  if (buffer.toString("ascii", 0, 3) !== "GIF") return null;
  return { type: "gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

export function imageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  return readPng(buffer) || readJpeg(buffer) || readWebp(buffer) || readGif(buffer);
}

/**
 * 判定「这张图能不能当活动大图」。
 * - 长边 ≥ 600 且短边 ≥ 300：排除 256×256 / 360×360 / 64×64 这类图标、站内小图与
 *   750×90 这类条形 banner（实际只要 ≥210px 宽就够卡片用，阈值主要是为了挡住图标）。
 * - 长宽比 ≥ 1.3：排除正方形图标（图标判定靠这条 + 短边，横竖版大图都算合格）。
 */
export function isEventBannerSize(size, { minLong = 600, minShort = 300, minRatio = 1.3, maxRatio = 3 } = {}) {
  if (!size?.width || !size?.height) return false;
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  if (long < minLong || short < minShort) return false;
  const ratio = long / short;
  // 上界用来挡掉长条横幅（好游 `~thumb?1280x320` 这类 4:1 图，卡片里只有一条细带、看不清内容）。
  return ratio >= minRatio && ratio <= maxRatio;
}
