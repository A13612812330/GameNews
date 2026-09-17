import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sendTopicMonitorNotification } from "./feishuTopicNotifier.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RETRY_DELAYS_MS = [2000, 5000, 10000];

async function execFeishuScript(args, label) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await execFileAsync(
        process.execPath,
        [path.join(root, "scripts", "topic-monitor-preview.mjs"), ...args],
        { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
      );
    } catch (error) {
      lastError = error;
      if (attempt >= RETRY_DELAYS_MS.length) break;
      console.warn(`[feishu-monitor] ${label} 第 ${attempt + 1} 次失败，${RETRY_DELAYS_MS[attempt] / 1000} 秒后重试：${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

// 飞书写入规则集中在脚本中，服务端只负责在候选、详情、RAW 都完成后调用。
// 写入脚本会自行按飞书已有记录去重；这里不读取或输出任何凭据。
export async function syncFeishuTopicMonitor({ sourceId = "", notify = true } = {}) {
  const sourceArg = sourceId ? [`--source=${sourceId}`] : [];
  // 每轮正式同步前，先把人工维护的“游戏评级”回填到既有事件。
  // 这样用户只需改评级表，下一次小时监控即可同步新游/活动表，无需手工批量改行。
  const ratingSyncRun = await execFeishuScript(["--sync-game-ratings"], "评级回写");
  let ratingSync = {};
  try { ratingSync = JSON.parse(String(ratingSyncRun.stdout || "").trim()); } catch {}
  const { stdout = "", stderr = "" } = await execFeishuScript(sourceArg, "主题同步");
  const output = String(stdout).trim();
  let result = {};
  try {
    result = JSON.parse(output);
  } catch {
    result = { output: output.slice(-1000) };
  }
  // 正常监控只新增或更新字段，不删除、不重建飞书记录。
  // 飞书开放接口无法稳定写入多字段视图排序，因此排序字段继续写入，
  // 但物理排列和历史 record_id 不再由自动任务改动。
  const schedule = { skipped: true, reason: "仅增量同步，未执行删除重建" };
  const insertedItems = Array.isArray(result.insertedItems) ? result.insertedItems : [];
  const alertItems = insertedItems.filter((item) => /^(?:S|A)/u.test(String(item.评级 || "").trim()));
  let notification = { sent: false, skipped: true, reason: "本轮没有新增记录" };
  if (notify && Number(result.inserted || 0) > 0 && alertItems.length) {
    try {
      notification = await sendTopicMonitorNotification({ items: alertItems });
    } catch (error) {
      // 飞书提醒失败不能影响本地爬虫、RAW 或飞书表写入。
      notification = { sent: false, error: error.message };
    }
  }
  if (notify && Number(result.inserted || 0) > 0 && !alertItems.length) {
    notification = { sent: false, skipped: true, reason: "本轮新增均为 B/C，不发送提醒", inserted: insertedItems.length };
  }
  return { ...result, ratingSync, schedule, notification: notify ? notification : { sent: false, skipped: true, reason: "本次专属同步不发送机器人" }, stderr: String(stderr).trim() };
}

export async function syncFeishuTopicMonitorForSource(sourceId, options = {}) {
  return syncFeishuTopicMonitor({ sourceId, notify: false, ...options });
}
