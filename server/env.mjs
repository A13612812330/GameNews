// 本地安全配置加载（P5）：只读取 .env.local，真实值不入代码/文档。
// 服务（api-server / scheduler）启动时调用 loadEnv() 加载同一份配置。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = path.join(ROOT, ".env.local");

let loaded = false;

// 读取 .env.local 并注入 process.env（KEY=VALUE 行；# 注释；引号剥离）
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1].startsWith("#")) continue;
    if (m[1] in process.env) continue; // 已有环境变量优先
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// 取运行时配置；required 时缺失即抛错（防止密钥为空时静默写飞书）
export function env(name, { required = false } = {}) {
  const v = process.env[name];
  if (required && !v) throw new Error(`缺少运行时配置: ${name}（请在 .env.local 填写，勿写入代码/文档）`);
  return v ?? "";
}
