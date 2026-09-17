import { execFileSync } from "node:child_process";

function userEnv(name) {
  // 暂停开关由用户级配置控制。服务可能是从旧进程继承启动的，
  // 若优先读取 process.env，会让旧的暂停值覆盖用户后来设置的 0。
  if (name === "FEISHU_TOPIC_NOTIFICATIONS_PAUSED") {
    try {
      const userValue = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim();
      if (userValue) return userValue;
    } catch {}
  }
  if (process.env[name] !== undefined) return process.env[name];
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}', 'User')`], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

async function tenantAccessToken() {
  // 新游/活动提醒使用专属机器人；保留旧变量仅用于已有部署的兼容兜底。
  const appId = userEnv("FEISHU_TOPIC_APP_ID") || userEnv("FEISHU_APP_ID");
  const appSecret = userEnv("FEISHU_TOPIC_APP_SECRET") || userEnv("FEISHU_APP_SECRET");
  if (!appId || !appSecret) throw new Error("未设置新游/活动提醒机器人凭据");
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0 || !payload.tenant_access_token) {
    throw new Error(`飞书令牌获取失败：${payload.msg || response.status}`);
  }
  return payload.tenant_access_token;
}

function displayTime(value = "") {
  const raw = String(value || "").trim();
  const timestamp = Number(raw);
  if (!Number.isFinite(timestamp) || timestamp <= 100000000000) return raw.replace(/^\d{4}-/u, "");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const time = Number(timestamp) ? `${parts.hour}:${parts.minute}` : "";
  return `${parts.month}月${parts.day}日${time === "00:00" ? "" : ` ${time}`}`;
}

function remoteImage(value = "") {
  const url = String(value || "").trim();
  return /^https?:\/\//iu.test(url) ? url : "";
}

function markdownImage(value, alt) {
  const url = remoteImage(value);
  return url ? `![${alt}](${url})` : "";
}

function cleanText(value = "") {
  return String(value || "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function cleanMessageText(value = "", { breakHaoyouCommas = false } = {}) {
  return String(value || "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    // 好游快爆的时间线文案通常以逗号串联多个独立事件；提醒卡片按事件换行更易读。
    .replace(breakHaoyouCommas ? /，\s*/gu : /$^/u, (mark) => `${mark.trim()}\n`)
    .replace(/[；;]\s*/gu, (mark) => `${mark.trim()}\n`)
    .replace(/[！!]\s*/gu, (mark) => `${mark.trim()}\n`)
    .trim();
}

function stripLeadingTime(value = "") {
  return String(value || "")
    .replace(/^(?:\d{1,4}[年./-]\d{1,2}[月./-]\d{1,2}日?|\d{1,2}月\d{1,2}日|今天|明天|后天|昨天)(?:\s*\d{1,2}(?::|点)\d{0,2})?\s*(?:更新|预下载|首发|上线|测试|公测)?\s*[:：]?\s*/u, "")
    .trim();
}

function splitActivityTitle(value = "") {
  const source = cleanMessageText(value);
  if (!source) return { title: "", summary: "" };
  const match = /^(.*?)(?=\s+(?:全新|新增|限时|活动|联动|版本|开启|上线|登场))/u.exec(source);
  if (match && match[1].trim().length >= 4) {
    const prefix = match[1].trim();
    const suffix = source.slice(match[0].length).trim();
    return { title: `${prefix}：${suffix}`, summary: "" };
  }
  return { title: source, summary: "" };
}

function compactSummary(item = {}, type = "新游") {
  const raw = cleanMessageText(item.摘要 || item.summary || item.简介 || item.content || item.内容 || "", {
    breakHaoyouCommas: type === "活动" && item.平台 === "好游快爆",
  });
  if (!raw) return "";
  const withoutDate = stripLeadingTime(raw);
  const source = withoutDate || raw;
  const firstParagraph = source.split(/[\n。！？!?]/u).map((part) => part.trim()).find(Boolean) || source;
  return type === "新游" ? firstParagraph.slice(0, 120) : source.slice(0, 180);
}

function splitTitleAndSummary(item = {}, type = "新游") {
  const messageOptions = { breakHaoyouCommas: type === "活动" && item.平台 === "好游快爆" };
  let title = cleanMessageText(item.标题 || item.title || "", messageOptions);
  let summary = compactSummary(item, type);
  if (type === "活动") {
    const titlePart = splitActivityTitle(stripLeadingTime(title));
    title = titlePart.title;
    if (!summary || summary === title) summary = titlePart.summary;
    summary = stripLeadingTime(summary);
  }
  // 飞书旧记录可能把“时间状态 + 整段简介”全部放在标题字段里，发送前拆开。
  if (type === "新游" && title.length > 80) {
    const match = /^(?:(\d{1,2}月\d{1,2}日(?:\s*\d{1,2}:\d{2})?|今天|明天|后天|昨天)\s*(?:预下载|首发|上线|测试|公测)?)(.*)$/u.exec(title);
    if (match) {
      title = match[1].trim();
      summary = cleanMessageText(match[2]) || summary;
    } else {
      summary = title.slice(0, 120);
      title = "新游信息";
    }
  }
  return { title, summary };
}

async function uploadImage(token, value) {
  const url = remoteImage(value);
  if (!url) return "";
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return "";
    const blob = await response.blob();
    if (!String(blob.type || "").startsWith("image/")) return "";
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", blob, "gamenews.jpg");
    const uploaded = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const payload = await uploaded.json().catch(() => ({}));
    return uploaded.ok && Number(payload.code || 0) === 0 ? String(payload.data?.image_key || "") : "";
  } catch {
    return "";
  }
}

function itemLine(item = {}) {
  const type = item.类型 === "活动" ? "活动" : "新游";
  const game = item.游戏名 ? `《${item.游戏名}》` : "未命名游戏";
  const { title, summary } = splitTitleAndSummary(item, type);
  const time = displayTime(item.时间);
  const platform = item.平台 || "";
  const sourceUrl = remoteImage(item.原文链接 || item.sourceUrl || "")
    ? String(item.原文链接 || item.sourceUrl)
    : String(item.原文链接 || item.sourceUrl || "").trim();
  const lines = [
    `**${[game, platform].filter(Boolean).join("-")}**`,
    ...(type === "活动" ? [title || "活动信息待补充", summary] : []),
    time ? `时间：${time}` : "",
    sourceUrl ? `[原文链接](${sourceUrl})` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function sendCard(token, chatId, { title, template, items = [], test = false }) {
  const sample = items.slice(0, 8);
  const elements = test
    ? [{ tag: "div", text: { tag: "lark_md", content: "提醒机器人已启用。后续爬虫完成后，仅有新增的新游或活动时才会通知。" } }]
    : await Promise.all(sample.map(async (item, index) => {
      const type = item.类型 === "活动" ? "活动" : "新游";
      const imageUrl = type === "活动" ? item.coverUrl || item.imageUrl : "";
      const imageKey = await uploadImage(token, imageUrl);
      return [
        ...(imageKey ? [{ tag: "img", img_key: imageKey, alt: { tag: "plain_text", content: type === "活动" ? "活动首图" : "游戏ICON" }, mode: "fit_horizontal" }] : []),
        { tag: "div", text: { tag: "lark_md", content: itemLine(item) } },
        ...(index < sample.length - 1 ? [{ tag: "hr" }] : []),
      ];
    })).then((blocks) => [
      ...blocks.flat(),
      ...(items.length > sample.length ? [{ tag: "note", elements: [{ tag: "plain_text", content: `其余 ${items.length - sample.length} 条请查看飞书新游表与活动表。` }] }] : []),
    ]);
  const card = {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: test ? "游戏资讯更新提醒（测试）" : title } },
    elements,
  };
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) throw new Error(`飞书提醒发送失败：${payload.msg || response.status}`);
  return payload.data?.message_id || "";
}

export async function sendTopicMonitorNotification({ items = [], test = false } = {}) {
  if (userEnv("FEISHU_TOPIC_NOTIFICATIONS_PAUSED") === "1") {
    return { sent: false, skipped: true, reason: "机器人提醒已暂停" };
  }
  const chatId = userEnv("FEISHU_TOPIC_CHAT_ID") || userEnv("FEISHU_CHAT_ID");
  if (!chatId) throw new Error("未设置新游/活动提醒目标群");
  const token = await tenantAccessToken();
  if (test) {
    const messageId = await sendCard(token, chatId, { title: "游戏资讯更新提醒", template: "blue", test: true });
    return { messageId, sent: true, messages: [{ type: "测试", messageId }] };
  }
  const groups = [
    { type: "新游", title: "新游提醒", template: "red", items: items.filter((item) => item.类型 !== "活动") },
    { type: "活动", title: "活动提醒", template: "orange", items: items.filter((item) => item.类型 === "活动") },
  ].filter((group) => group.items.length);
  const messages = [];
  for (const group of groups) {
    const messageId = await sendCard(token, chatId, group);
    messages.push({ type: group.type, messageId, count: group.items.length });
  }
  return { sent: messages.length > 0, messages };
}
