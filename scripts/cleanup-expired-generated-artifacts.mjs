import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.argv.includes("--stage");
function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
const cutoff = shanghaiDateKey(new Date(Date.now() - 7 * 86400000));
const targets = [path.join(root, "data", "brief-archive"), path.join(root, "output"), path.join(root, "brief-archive")];

function dateFromName(value) {
  const match = String(value).match(/(20\d{2})[-.]?(\d{1,2})[-.]?(\d{1,2})/u);
  return match ? `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}` : "";
}

async function walk(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const output = [];
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) output.push(...await walk(full));
      else output.push(full);
    }
    return output;
  } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

const files = (await Promise.all(targets.map(walk))).flat();
const candidates = [];
for (const file of files) {
  const date = dateFromName(file);
  if (!date || date >= cutoff) continue;
  const stat = await fs.stat(file);
  candidates.push({ file, date, bytes: stat.size });
}
if (stage) {
  for (const candidate of candidates) await fs.rm(candidate.file, { force: true, maxRetries: 3, retryDelay: 500 });
}
console.log(JSON.stringify({ mode: stage ? "stage" : "dry-run", cutoff, files: candidates.length, bytes: candidates.reduce((sum, item) => sum + item.bytes, 0), samples: candidates.slice(0, 20).map((item) => path.relative(root, item.file)) }, null, 2));
