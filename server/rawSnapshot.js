import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

export const rawArticlesDataPath =
  process.env.RAW_ARTICLES_DATA_PATH ||
  path.resolve(
    root,
    "..",
    "..",
    "WorkBuddy",
    "2026-07-30-11-37-18",
    "output",
    "RAW_ARTICLES.json",
  );
export const rawArticlesHtmlPath = path.join(
  path.dirname(rawArticlesDataPath),
  "RAW_ARTICLES.html",
);
export const projectRawArticlesHtmlPath = path.join(root, "output", "RAW_ARTICLES.html");

function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function readRawSnapshot() {
  if (!fsSync.existsSync(rawArticlesDataPath)) {
    throw new Error("RAW_ARTICLES.json 尚未生成");
  }
  return JSON.parse(fsSync.readFileSync(rawArticlesDataPath, "utf8"));
}

/** 仅重建当前 RAW 快照，不联网抓取。 */
export async function refreshRawArticlesSnapshot() {
  const { stdout = "", stderr = "" } = await execFileAsync(
    process.execPath,
    ["scripts/gen-raw-articles.mjs"],
    {
      cwd: root,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  const raw = readRawSnapshot();
  if (fsSync.existsSync(rawArticlesHtmlPath)) {
    await fs.mkdir(path.dirname(projectRawArticlesHtmlPath), { recursive: true });
    await fs.copyFile(rawArticlesHtmlPath, projectRawArticlesHtmlPath);
  }
  return {
    generatedAt: raw.generatedAt || null,
    total: raw.total || 0,
    hidden: raw.hidden || 0,
    output: String(stdout || stderr || "RAW 参考页已同步").trim(),
    projectHtmlPath: projectRawArticlesHtmlPath,
  };
}

/**
 * 每天只保留第一次完成流水线后的 RAW 版本；后续任务只更新当前快照，
 * 不覆盖当天备份，便于回看当天最初的验收数据。
 */
export async function archiveRawSnapshotOnce() {
  const date = shanghaiDateKey();
  const directory = path.join(root, "data", "raw-archive", date);
  const manifestPath = path.join(directory, "manifest.json");
  try {
    await fs.access(manifestPath);
    return { created: false, date, directory, reason: "当天备份已存在" };
  } catch {}

  const raw = readRawSnapshot();
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(rawArticlesDataPath, path.join(directory, "RAW_ARTICLES.json"));
  if (fsSync.existsSync(rawArticlesHtmlPath)) {
    await fs.copyFile(rawArticlesHtmlPath, path.join(directory, "RAW_ARTICLES.html"));
  }
  const manifest = {
    date,
    archivedAt: new Date().toISOString(),
    generatedAt: raw.generatedAt || null,
    total: raw.total || 0,
    hidden: raw.hidden || 0,
    source: {
      json: rawArticlesDataPath,
      html: rawArticlesHtmlPath,
    },
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { created: true, date, directory, manifest };
}
