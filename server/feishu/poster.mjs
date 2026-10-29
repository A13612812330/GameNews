// 海报推送（P5）：本地 HTTP 访问 HTML → Edge headless 截图 PNG → 上传飞书 → 发送。
// 日海报：PNG + 网页链接；周报：以链接为主。
// PNG 生成失败不影响 HTML 留档；飞书发送失败不影响生成/归档/publication_runs。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { posterConfig, tenantAccessToken, uploadLocalImage, sendCard } from "./client.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const OUT = path.join(ROOT, "output");

async function edgeExecutable() {
  const candidates = [
    process.env.EDGE_BIN,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    try { await fs.promises.access(c); return c; } catch { /* 尝试下一个位置 */ }
  }
  return "";
}

// 用 Edge headless 把 HTML 渲染为 PNG（返回 png 路径；失败抛错）
// baseUrl: 本地 HTTP 服务地址（不对 file:/// 截图）
export async function renderPosterPng(htmlPath, { baseUrl = "http://127.0.0.1:64500", height = 12000 } = {}) {
  const edge = await edgeExecutable();
  if (!edge) throw new Error("未找到可用于生成海报图片的 Edge 浏览器");
  const previewPath = htmlPath.replace(/\.html$/u, ".png");
  const rel = path.relative(OUT, htmlPath).split(path.sep).map((s) => encodeURIComponent(s)).join("/");
  const pageUrl = `${baseUrl.replace(/\/$/u, "")}/output/${rel}`;
  await new Promise((resolve, reject) => {
    const child = spawn(edge, [
      "--headless", "--disable-gpu", "--hide-scrollbars", "--run-all-compositor-stages-before-draw",
      `--screenshot=${previewPath}`, `--window-size=1100,${height}`, pageUrl,
    ], { windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`Edge 截图退出码 ${code}`))));
  });
  // 等待文件落盘稳定
  let prev = -1;
  for (let i = 0; i < 20; i += 1) {
    try {
      const st = fs.statSync(previewPath);
      if (st.size > 0 && st.size === prev) break;
      prev = st.size;
    } catch { /* 文件尚未生成 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  fs.accessSync(previewPath);
  return previewPath;
}

// 发送海报消息。日海报带 PNG 图片 + 链接；周报以链接为主。
// 失败不抛出（由调用方记录），返回 { sent, error? }
export async function sendPoster({ pngPath = "", pageUrl = "", title = "", isWeekly = false, dryRun = false } = {}) {
  try {
    const cfg = posterConfig({ required: !dryRun });
    if (dryRun) return { sent: false, dryRun: true, planned: { title, isWeekly, png: pngPath || null, pageUrl } };
    const token = await tenantAccessToken(cfg.appId, cfg.appSecret);
    const elements = [];
    if (!isWeekly && pngPath && fs.existsSync(pngPath)) {
      const imageKey = await uploadLocalImage(token, pngPath);
      if (imageKey) elements.push({ tag: "img", img_key: imageKey, alt: { tag: "plain_text", content: title }, mode: "by_ratio", ratio: 1.6 });
    }
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**${title}**${pageUrl ? `\n[打开完整海报](${pageUrl})` : ""}` } });
    const card = {
      config: { wide_screen_mode: true },
      header: { template: "blue", title: { tag: "plain_text", content: title } },
      elements,
    };
    const messageId = await sendCard(token, cfg.chatId, card);
    return { sent: true, messageId };
  } catch (e) {
    return { sent: false, error: e.message }; // 发送失败不阻塞生成/归档/记录
  }
}
