/**
 * 调度器支撑件 —— 把「需要被断言的行为」从 server/scheduler.js 里剥出来。
 *
 * 为什么要单独一个文件：scheduler.js 一旦被 import 就会执行 cron.schedule（有副作用），
 * 于是它的内部逻辑在验证脚本里根本引不到。把这三件事抽成纯函数/纯工厂之后，
 * server/scheduler.js 只需调用，scripts/verify-poster-pipeline-hardening.mjs 可以直接断言。
 *
 * 1. createKindLock()          —— 按 kind 分离的「运行中」标志
 * 2. summarizeProcessFailure() —— 把子进程失败的真实原因（stdout/stderr）留下来
 * 3. parsePosterStdout()       —— 从可能被诊断行污染的 stdout 里取出结果 JSON
 */

/**
 * 按 kind 分离的运行锁。
 *
 * 旧实现是模块级布尔 `let posterRunning = false`，日报与周报共用：
 * 日报卡住占用标志时，周报会被 `if (posterRunning) return null` 静默跳过
 * （2026-09-28 实测：当天恰好是「日报被外层 180s 超时杀掉 → 标志释放 → 周报才得以运行」，
 *  换句话说周报能否发出去取决于日报有没有失败）。
 * 互斥的正确粒度是「同一 kind 不并发」，同 kind 的并发已由子脚本的
 * data/logs/poster-delivery-<kind>.lock 兜底，父进程这里只负责省掉重复拉起。
 */
export function createKindLock() {
  const running = new Set();
  return {
    isRunning(kind) {
      return running.has(kind);
    },
    /** 占用成功返回 true；同 kind 已在运行返回 false。 */
    tryBegin(kind) {
      if (running.has(kind)) return false;
      running.add(kind);
      return true;
    },
    end(kind) {
      running.delete(kind);
    },
    runningKinds() {
      return [...running];
    },
  };
}

const MAX_TAIL = 1500;

function tailText(value) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= MAX_TAIL) return trimmed;
  return `…${trimmed.slice(-MAX_TAIL)}`;
}

/**
 * 子进程失败时，error.message 往往只有一句 `Command failed: <整条命令>`。
 * 真正的原因（「截图超时 90s，已终止并尝试下一个浏览器」「PNG 裁边失败」…）
 * 全在子进程的 stdout/stderr 里，而旧实现的 catch 只取 error?.message，
 * 把两者一起丢掉了 ⇒ cron-result.json 里看不出任何原因（2026-09-28 定位）。
 * 这里全部保留，并各自截断到 1500 字符，避免 2MB maxBuffer 灌进日志文件。
 */
export function summarizeProcessFailure(error) {
  const rawCode = error?.code;
  return {
    error: error?.message || "子进程执行失败",
    exitCode: typeof rawCode === "number" ? rawCode : null,
    failureCode: typeof rawCode === "string" ? rawCode : "",
    signal: error?.signal || "",
    killed: Boolean(error?.killed),
    stdoutTail: tailText(error?.stdout),
    stderrTail: tailText(error?.stderr),
  };
}

/**
 * 海报脚本（scripts/scheduled-posters.mjs）的 stdout 契约是「只打印一个结果 JSON」，
 * 因为父进程要 JSON.parse 它。
 *
 * 但该脚本历史上也往 stdout 打过诊断行：
 *   - `[poster-lock] 清除僵死锁 …`（抢占残留锁时才出现）
 *   - `[poster] PNG 裁边 …`（**每次成功裁边都有**，6190ca4 换成 Node 版裁边后才开始出现）
 * 于是 `JSON.parse(整个 stdout)` 必然抛语法错误，日报即使截图与投递全部成功，
 * 也会被记成「海报脚本未返回可识别结果」（2026-09-28 定位，属 6190ca4 引入的回归）。
 *
 * 两层修：子脚本的诊断行改走 stderr（console.warn）；父进程这里再做一次容错，
 * 从 stdout 中取出最后一个 JSON 块，避免同类污染再次把成功误判为失败。
 */
export function parsePosterStdout(stdout) {
  const text = (typeof stdout === "string" ? stdout : "").replace(/^\uFEFF/u, "");
  const trimmed = text.trim();
  if (!trimmed) throw new Error("海报脚本没有输出任何内容");
  try {
    return JSON.parse(trimmed);
  } catch {
    // 落到下面的兜底解析
  }
  const lines = text.split(/\r?\n/u);
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // 结果 JSON 一定是 stdout 里最后一段以 `{` 开头的文本（脚本结尾才打印）。
    if (lines[index].trim().startsWith("{")) {
      start = index;
      break;
    }
  }
  if (start === -1) throw new Error("海报脚本输出中没有找到结果 JSON");
  try {
    return JSON.parse(lines.slice(start).join("\n"));
  } catch (error) {
    throw new Error(`海报脚本输出的 JSON 无法解析：${error.message}`);
  }
}
