// 统一爬虫 CLI（P2）
// 用法: node scripts/crawl.mjs --sources ref-x7,ref-steam [--dry-run]
import { runSources } from "../server/crawler/run.mjs";
import { ADAPTERS } from "../server/crawler/registry.mjs";

const argv = process.argv;
const idx = argv.indexOf("--sources");
const raw = idx >= 0 ? argv[idx + 1] : Object.keys(ADAPTERS).filter((k) => ADAPTERS[k].runnable).join(",");
const sourceIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
const dryRun = argv.includes("--dry-run");

console.log(`[crawler] 来源: ${sourceIds.join(", ")} ${dryRun ? "(dry-run)" : ""}`);
const summary = await runSources(sourceIds, { dryRun });
for (const s of summary) console.log("  ", JSON.stringify(s));
