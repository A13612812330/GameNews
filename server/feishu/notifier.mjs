// 飞书提醒（P5）：仅 S/A 发送；新游=红色主题、无 ICON、一条事件一条消息、无系统文案；
// 活动=橙色主题、展示首图、标题与内容清洗后分行。
import { sendCard, uploadRemoteImage, topicConfig, tenantAccessToken } from "./client.mjs";

export function displayTime(value = 0) {
  const ts = Number(value || 0);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  const pad = (v) => String(v).padStart(2, "0");
  const time = d.getHours() || d.getMinutes() ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
  return `${d.getMonth() + 1}月${d.getDate()}日${time}`;
}

// 内容清洗：去 HTML、分行；仅清除开头首次出现的"X月X日更新："，正文后续时间保留
export function cleanMessageText(value = "") {
  return String(value || "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    // 仅开头首次出现的"8月21日更新："清掉；正文中的时间保留
    .replace(/^(?:\d{1,2}月\d{1,2}日(?:\s*\d{1,2}:\d{2})?|今天|明天|后天)\s*更新\s*[:：]?\s*/u, "")
    // ;、；、，、！ 分行（既有规则）
    .replace(/[；;]\s*/gu, "；\n")
    .replace(/[！!]\s*/gu, "！\n")
    .trim();
}

export function compactIntro(value = "", max = 180) {
  const text = String(value || "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
  if (!text) return "";
  const first = text.split(/[\n。！？!?]/u).map((s) => s.trim()).find(Boolean) || text;
  return first.slice(0, max);
}

async function cardFor(item, token) {
  const type = item.type === "活动" ? "活动" : "新游";
  const game = item.game ? `《${item.game}》` : "未命名游戏";
  const title = cleanMessageText(item.title || "").split("\n")[0] || (type === "活动" ? "活动信息待补充" : "新游信息");
  const summary = compactIntro(item.content || "");
  const time = displayTime(item.time);
  const sourceUrl = String(item.sourceUrl || "").trim();
  const lines = [
    `**${[game, item.sourceName].filter(Boolean).join("-")}**`,
    ...(type === "活动" ? [title, summary] : [summary || title]),
    time ? `时间：${time}` : "",
    sourceUrl ? `[原文链接](${sourceUrl})` : "",
  ];
  const body = { tag: "div", text: { tag: "lark_md", content: lines.filter(Boolean).join("\n") } };
  // 活动展示首图（上传为飞书图片）；新游不显示 ICON
  const imageKey = type === "活动" ? await uploadRemoteImage(token, item.imageUrl || "") : "";
  return {
    config: { wide_screen_mode: true },
    header: { template: type === "活动" ? "orange" : "red", title: { tag: "plain_text", content: type === "活动" ? "活动提醒" : "新游提醒" } },
    elements: [
      ...(imageKey ? [{ tag: "img", img_key: imageKey, alt: { tag: "plain_text", content: "活动首图" }, mode: "fit_horizontal" }] : []),
      body,
    ],
  };
}

// 发送 S/A 提醒：一条事件一条消息；任一失败不影响其余
export async function sendSAAlerts({ items = [], dryRun = false } = {}) {
  const cfg = topicConfig({ required: !dryRun });
  if (dryRun) {
    return { sent: false, dryRun: true, planned: items.map((i) => ({ type: i.type, game: i.game, grade: i.grade })) };
  }
  const token = await tenantAccessToken(cfg.appId, cfg.appSecret);
  const messages = [];
  let failed = 0;
  for (const item of items) {
    try {
      const messageId = await sendCard(token, cfg.chatId, await cardFor(item, token));
      messages.push({ eventKey: item.eventKey, type: item.type, game: item.game, messageId });
    } catch (e) {
      failed += 1;
      messages.push({ eventKey: item.eventKey, type: item.type, game: item.game, error: e.message });
    }
  }
  return { sent: messages.length > 0, messages, failed };
}

// CLI：真实发送 1 条 S 级 fixture 到新游/活动提醒群（连通性测试）
const isMain = process.argv[1] && process.argv[1].endsWith("notifier.mjs");
if (isMain && process.argv.includes("--test-s")) {
  const { loadEnv } = await import("../env.mjs");
  loadEnv();
  const item = {
    type: "新游",
    game: "连通性测试",
    grade: "S · 重点",
    title: "《连通性测试》首发",
    content: "这是一条飞书卡片连通性测试（S 级 fixture）：确认机器人身份、卡片样式（红色主题/无 ICON）、时间与原文链接。",
    time: Date.now(),
    sourceUrl: "https://example.com/gamenews-connectivity-test",
    sourceName: "TapTap",
  };
  const r = await sendSAAlerts({ items: [item] });
  console.log(JSON.stringify(r));
}
