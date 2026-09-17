import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [path.join(root, "data", "brief-archive"), path.join(root, "output")];

async function walk(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walk(full));
      else if (/\.(?:json|html?)$/iu.test(entry.name)) files.push(full);
    }
    return files;
  } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<figure\b[^>]*>\s*<img\b[^>]*\/crawler-assets\/[^>]*>\s*<\/figure>/giu, "")
    .replace(/<img\b[^>]*\/crawler-assets\/[^>]*>/giu, "");
}

function scrub(value) {
  if (typeof value === "string") return stripHtml(value);
  if (Array.isArray(value)) return value.map(scrub).filter((item) => item !== null);
  if (!value || typeof value !== "object") return value;
  if (typeof value.src === "string" && value.src.includes("/crawler-assets/")) return null;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]).filter(([, item]) => item !== null));
}

const files = (await Promise.all(roots.map(walk))).flat();
let changed = 0;
for (const file of files) {
  try {
    const original = await fs.readFile(file, "utf8");
    const next = file.endsWith(".json") ? JSON.stringify(scrub(JSON.parse(original)), null, 2) : stripHtml(original);
    if (next !== original) { await fs.writeFile(file, next, "utf8"); changed += 1; }
  } catch {}
}
console.log(JSON.stringify({ scanned: files.length, changed }, null, 2));
