#!/usr/bin/env node
/**
 * 反证：单实例闸门（server/index.js 的 instance.lock）的四条性质。
 *
 * 背景：本机有两套守护都会拉起 server/index.js（本项目 Komo-GameNews-Watchdog 每分钟、
 * 工作区级 Komo-Local-News-Services 每 5 分钟），端口同为 64424。旧写法里
 * seedBuiltinSources() 在「判断自己是不是重复实例」之前就执行，于是重复实例在退出前
 * 已经和正式实例并发写同一个 SQLite，抛 database is locked（实测累计 121 次 / 约占 74%）。
 *
 * 本脚本用临时锁路径 + 临时端口，不碰生产锁、不占用 64424。
 * 用法：node scripts/verify-single-instance-guard.mjs
 *
 * 四条性质（每条都配反向对照，防止断言恒真）：
 *   A 空闲端口 + 无锁      ⇒ 正常启动，并创建锁（pid = 自己）
 *   B 活锁                 ⇒ 立即退出，不写库、不注册定时任务    ← 反向对照：若跑满则红灯
 *   C 死锁（崩溃残留）      ⇒ 接管并正常启动                     ← 反向对照：若被挡住则红灯
 *   D 带 BOM 的活锁        ⇒ 仍被正确识别为「有实例在跑」        ← 反向对照：若接管则红灯
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const serverEntry = path.join(root, "server", "index.js");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gn-guard-"));

let passed = 0;
let failed = 0;
const lines = [];

function assert(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    lines.push(`  [PASS] ${name}`);
  } else {
    failed += 1;
    lines.push(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 起一个只活着的占位进程，用来制造「活 pid」 */
function startHolder() {
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  return holder;
}

/**
 * 启动被测服务，最多等 maxWaitMs；若它没自己退出就强杀。
 * 返回 { exitedBySelf, exitCode, elapsedMs, output }
 */
function runServer({ lockFile, port, maxWaitMs = 8000 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [serverEntry], {
      cwd: root,
      env: {
        ...process.env,
        GAME_NEWS_INSTANCE_LOCK: lockFile,
        GAME_NEWS_API_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));

    const finish = (exitedBySelf, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitedBySelf, exitCode, elapsedMs: Date.now() - startedAt, output });
    };

    child.once("exit", (code) => finish(true, code));

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      // 杀完再等一下，让 exit 事件把 output 收全
      setTimeout(() => finish(false, null), 800);
    }, maxWaitMs);
  });
}

function writeLock(lockFile, pid, { bom = false } = {}) {
  const body = JSON.stringify({ pid, startedAt: new Date().toISOString() });
  fs.writeFileSync(lockFile, bom ? `\uFEFF${body}` : body);
}

function readLockPid(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw).pid;
  } catch {
    return null;
  }
}

// ── A：空闲端口 + 无锁 ⇒ 正常启动并创建锁 ────────────────────────────────
{
  lines.push("A. 无锁 + 空闲端口 ⇒ 应正常启动并创建锁");
  const lockFile = path.join(tmpDir, "a.lock");
  const result = await runServer({ lockFile, port: 64471, maxWaitMs: 8000 });
  assert("打印了 API 地址（说明真的启动了）", result.output.includes("Game News Hub API"));
  assert("锁文件已创建", fs.existsSync(lockFile));
  const lockPid = readLockPid(lockFile);
  assert("锁内 pid 是有效数字", Number.isInteger(lockPid), `实际=${JSON.stringify(lockPid)}`);
  lines.push("");
}

// ── B：活锁 ⇒ 立即退出，零副作用 ────────────────────────────────────────
{
  lines.push("B. 活锁 ⇒ 应被闸门挡住（这是修复的核心）");
  const holder = startHolder();
  await new Promise((r) => setTimeout(r, 600));
  const lockFile = path.join(tmpDir, "b.lock");
  writeLock(lockFile, holder.pid);
  const result = await runServer({ lockFile, port: 64472, maxWaitMs: 8000 });

  assert("进程自己退出了（不是被超时强杀）", result.exitedBySelf, `elapsed=${result.elapsedMs}ms`);
  assert("5 秒内退出", result.elapsedMs < 5000, `实际 ${result.elapsedMs}ms`);
  assert("退出码为 0", result.exitCode === 0, `实际 ${result.exitCode}`);
  assert("输出命中实例闸门", result.output.includes("已有其他 GameNews 实例在运行"));
  // 下面两条是「零副作用」的证据：闸门在 seedBuiltinSources / app.listen 之前
  assert(
    "未打印 API 地址 ⇒ 未走到 listen ⇒ seedBuiltinSources 未执行",
    !result.output.includes("Game News Hub API"),
  );
  assert("未打印 scheduler 日志 ⇒ 未注册定时任务", !result.output.includes("[scheduler]"));
  assert("锁文件仍是占位进程的 pid（未被篡改）", readLockPid(lockFile) === holder.pid);
  try {
    holder.kill();
  } catch {}
  lines.push("");
}

// ── C：死锁 ⇒ 接管并启动（崩溃自恢复） ──────────────────────────────────
{
  lines.push("C. 死 pid 残留锁 ⇒ 应接管并正常启动（否则崩溃后再也起不来）");
  const holder = startHolder();
  await new Promise((r) => setTimeout(r, 600));
  const deadPid = holder.pid;
  holder.kill();
  await new Promise((r) => setTimeout(r, 800)); // 确保它真的死了

  const lockFile = path.join(tmpDir, "c.lock");
  writeLock(lockFile, deadPid);
  const result = await runServer({ lockFile, port: 64473, maxWaitMs: 8000 });

  assert("未被死锁挡住", !result.output.includes("已有其他 GameNews 实例在运行"));
  assert("打印了 API 地址（真的启动了）", result.output.includes("Game News Hub API"));
  const lockPid = readLockPid(lockFile);
  assert(
    "锁已被接管并更新（不再是死 pid）",
    Number.isInteger(lockPid) && lockPid !== deadPid,
    `锁内=${lockPid} 死 pid=${deadPid}`,
  );
  lines.push("");
}

// ── D：带 BOM 的活锁 ⇒ 仍被挡（反向对照） ───────────────────────────────
{
  lines.push("D. 带 BOM 的活锁 ⇒ 仍应被挡住（外部工具写锁会带 BOM）");
  const holder = startHolder();
  await new Promise((r) => setTimeout(r, 600));
  const lockFile = path.join(tmpDir, "d.lock");
  writeLock(lockFile, holder.pid, { bom: true });
  const result = await runServer({ lockFile, port: 64474, maxWaitMs: 8000 });

  assert("进程自己退出了", result.exitedBySelf, `elapsed=${result.elapsedMs}ms`);
  assert(
    "BOM 未导致活锁被误判为损坏（仍命中闸门）",
    result.output.includes("已有其他 GameNews 实例在运行"),
    "若此处红灯说明 BOM 会让活锁被接管 ⇒ 可能起第二个实例",
  );
  try {
    holder.kill();
  } catch {}
  lines.push("");
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(lines.join("\n"));
console.log(`── 结果：${passed} 通过 / ${failed} 失败 ──`);
process.exit(failed === 0 ? 0 : 1);
