import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveExpiredArticles, archiveExpiredRawSnapshots, archiveExpiredWeeklySnapshots, migrateActiveArticlesToRemoteUrls } from "../server/retention.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.argv.includes("--stage");
const keepDays = 7;
const execFileAsync = promisify(execFile);

const result = {
  mode: stage ? "stage" : "dry-run",
  keepDays,
  activeImageMigration: stage ? migrateActiveArticlesToRemoteUrls() : null,
  articles: await archiveExpiredArticles({ root, keepDays, stage }),
  rawArchive: await archiveExpiredRawSnapshots({ root, keepDays, stage }),
  weeklySnapshots: await archiveExpiredWeeklySnapshots({ root, keepDays, stage }),
};

if (stage) {
  const rebase = await execFileAsync(process.execPath, [path.join(root, "scripts", "rebase-generated-image-urls.mjs")], { cwd: root, windowsHide: true });
  result.generatedArtifactRebase = JSON.parse(String(rebase.stdout || "{}"));
  const stripLocalImages = await execFileAsync(process.execPath, [path.join(root, "scripts", "strip-unmapped-local-images.mjs")], { cwd: root, windowsHide: true });
  result.unmappedImageCleanup = JSON.parse(String(stripLocalImages.stdout || "{}"));
  const generatedCleanup = await execFileAsync(process.execPath, [path.join(root, "scripts", "cleanup-expired-generated-artifacts.mjs"), "--stage"], { cwd: root, windowsHide: true });
  result.generatedArtifactCleanup = JSON.parse(String(generatedCleanup.stdout || "{}"));
  const imageCleanup = await execFileAsync(process.execPath, [path.join(root, "scripts", "audit-image-cache.mjs"), "--delete"], { cwd: root, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CRAWLER_IMAGE_KEEP_DAYS: "0" } });
  result.imageCleanup = String(imageCleanup.stdout || "").trim();
  const manifestPath = path.join(root, "data", "light-archive", "retention-last-run.json");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2), "utf8");
}
console.log(JSON.stringify(result, null, 2));
