import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../server/database.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [path.join(root, "data", "brief-archive"), path.join(root, "output")];
const idToRemote = new Map();
for (const row of db.prepare("SELECT images_json FROM articles WHERE images_json IS NOT NULL AND images_json <> '[]'").all()) {
  try {
    for (const image of JSON.parse(row.images_json)) {
      const remote = String(image?.originalUrl || image?.url || image?.src || "");
      if (image?.id && /^https?:\/\//iu.test(remote)) idToRemote.set(String(image.id), remote);
    }
  } catch {}
}

async function walk(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walk(full));
      else if (/\.(?:json|html?|mjs)$/iu.test(entry.name)) files.push(full);
    }
    return files;
  } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

const replacements = new Map();
function remoteForNode(node) {
  const rawId = String(node?.materialId || node?.id || "");
  return idToRemote.get(rawId) || idToRemote.get(rawId.replace(/-draft$/u, "")) || "";
}
function rebaseNode(value) {
  if (Array.isArray(value)) return value.map(rebaseNode);
  if (!value || typeof value !== "object") return value;
  const output = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebaseNode(item)]));
  const remote = remoteForNode(output);
  if (remote && typeof output.src === "string" && output.src.includes("/crawler-assets/")) {
    replacements.set(output.src, remote);
    output.src = remote;
  }
  return output;
}

const files = (await Promise.all(roots.map(walk))).flat();
let jsonChanged = 0;
for (const file of files.filter((item) => item.endsWith(".json"))) {
  try {
    const original = await fs.readFile(file, "utf8");
    const rebased = JSON.stringify(rebaseNode(JSON.parse(original)), null, 2);
    if (rebased !== original) { await fs.writeFile(file, rebased, "utf8"); jsonChanged += 1; }
  } catch {}
}
for (const file of files.filter((item) => item.endsWith(".json"))) {
  try {
    const original = await fs.readFile(file, "utf8");
    let next = original;
    replacements.forEach((remote, local) => { next = next.split(local).join(remote); });
    if (next !== original) { await fs.writeFile(file, next, "utf8"); jsonChanged += 1; }
  } catch {}
}
let htmlChanged = 0;
for (const file of files.filter((item) => /\.html?$/iu.test(item))) {
  try {
    const original = await fs.readFile(file, "utf8");
    let next = original;
    replacements.forEach((remote, local) => { next = next.split(local).join(remote); });
    if (next !== original) { await fs.writeFile(file, next, "utf8"); htmlChanged += 1; }
  } catch {}
}
console.log(JSON.stringify({ scannedFiles: files.length, knownImageIds: idToRemote.size, mappedUrls: replacements.size, jsonChanged, htmlChanged }, null, 2));
