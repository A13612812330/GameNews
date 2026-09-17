import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../server/database.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crawlerRoot = path.join(root, "data", "crawler");
const outputPath = path.join(crawlerRoot, "cache-cleanup-manifest.json");
const keepDays = Math.max(0, Number(process.env.CRAWLER_IMAGE_KEEP_DAYS || 14));
const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
const executeDelete = process.argv.includes("--delete");

function batchIdFromImage(value) {
  const source = String(value || "");
  const match = /\/crawler-assets\/([^/]+)/.exec(source);
  return match?.[1] || null;
}

const referencedBatches = new Set();
for (const row of db.prepare("SELECT images_json FROM articles WHERE images_json IS NOT NULL AND images_json != '[]'").all()) {
  try {
    const images = JSON.parse(row.images_json || "[]");
    for (const image of images) {
      const batch = batchIdFromImage(image?.src || image?.localUrl || image?.url);
      if (batch) referencedBatches.add(batch);
    }
  } catch {
    // 单条损坏元数据不能中断只读审计。
  }
}

async function scanReferences(rootDir) {
  const roots = [
    path.join(root, "data", "brief-archive"),
    path.join(root, "data", "raw-archive"),
    path.join(root, "data", "weekly-snapshots"),
    path.join(root, "output"),
  ];
  const allowed = /\.(?:json|html|htm|js|mjs|md)$/iu;
  for (const scanRoot of roots) {
    const files = await fs.readdir(scanRoot, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of files) {
      if (!entry.isFile() || !allowed.test(entry.name)) continue;
      const filePath = path.join(entry.parentPath || scanRoot, entry.name);
      try {
        const text = await fs.readFile(filePath, "utf8");
        for (const match of text.matchAll(/\/crawler-assets\/([^/"'\\\s]+)/gu)) referencedBatches.add(match[1]);
      } catch {}
    }
  }
}

await scanReferences(root);

const entries = await fs.readdir(crawlerRoot, { withFileTypes: true });
const batches = [];
for (const entry of entries) {
  // 只处理旧图片批次，不触碰 Steam 榜单等非图片运行数据。
  if (!entry.isDirectory() || !/^detail-\d+$/u.test(entry.name)) continue;
  const fullPath = path.join(crawlerRoot, entry.name);
  const stat = await fs.stat(fullPath);
  const files = await fs.readdir(fullPath, { recursive: true }).catch(() => []);
  const filePaths = files.map((item) => path.join(fullPath, item));
  let bytes = 0;
  for (const file of filePaths) {
    try {
      const fileStat = await fs.stat(file);
      if (fileStat.isFile()) bytes += fileStat.size;
    } catch {}
  }
  const referenced = referencedBatches.has(entry.name);
  let latestFileMs = stat.mtimeMs;
  for (const file of filePaths) {
    try { latestFileMs = Math.max(latestFileMs, (await fs.stat(file)).mtimeMs); } catch {}
  }
  batches.push({
    batchId: entry.name,
    path: fullPath,
    modifiedAt: stat.mtime.toISOString(),
    files: filePaths.length,
    bytes,
    referenced,
    eligibleForReview: !referenced && latestFileMs < cutoffMs,
  });
}

const eligible = batches.filter((item) => item.eligibleForReview);
const manifest = {
  generatedAt: new Date().toISOString(),
  mode: executeDelete ? "audit-and-delete" : "audit-only",
  keepDays,
  cutoff: new Date(cutoffMs).toISOString(),
  rule: "仅处理未被 SQLite、简讯、RAW、周报或海报产物引用，且所有文件均早于保留期的批次。",
  totals: {
    batches: batches.length,
    referencedBatches: batches.filter((item) => item.referenced).length,
    eligibleBatches: eligible.length,
    eligibleBytes: eligible.reduce((sum, item) => sum + item.bytes, 0),
  },
  eligible,
};

let deletedBatches = 0;
let deletedBytes = 0;
if (executeDelete) {
  for (const item of eligible) {
    await fs.rm(item.path, { recursive: true, force: true });
    deletedBatches += 1;
    deletedBytes += item.bytes;
  }
}

await fs.writeFile(outputPath, JSON.stringify(manifest, null, 2), "utf8");
console.log(JSON.stringify({ outputPath, ...manifest.totals, deletedBatches, deletedBytes }, null, 2));
