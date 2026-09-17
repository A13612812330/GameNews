import { listArticles } from "./database.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveRawSnapshotOnce, refreshRawArticlesSnapshot } from "./rawSnapshot.js";
import { writeWeeklyMaterialSnapshot } from "./weeklySnapshots.js";
import { archiveExpiredArticles, archiveExpiredRawSnapshots, archiveExpiredWeeklySnapshots, migrateActiveArticlesToRemoteUrls } from "./retention.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 候选抓取成功后的统一收尾。
 * 手动更新与定时流水线都调用这里，避免 SQLite、RAW 和保留策略出现不同步。
 */
export async function finalizeCrawlRun({ root = projectRoot, keepDays = 7, log = () => {} } = {}) {
  const result = { weeklySnapshot: null, cleanup: null, raw: null, archive: null, warnings: [] };

  // 快照与活跃库均保留最近 7 天和未来事件；图片只引用远程 URL。
  if (root) {
    try {
      const migrated = migrateActiveArticlesToRemoteUrls();
      const { articles } = listArticles({ limit: 200 });
      result.weeklySnapshot = await writeWeeklyMaterialSnapshot({ root, articles });
      const retention = await archiveExpiredWeeklySnapshots({ root, keepDays, stage: true });
      log(`周报素材已快照 ${result.weeklySnapshot.articleCount} 条，图片仅保留 URL${migrated.changed ? `，迁移 ${migrated.changed} 条旧图片引用` : ""}${retention.deleted ? `，归档并清理 ${retention.deleted} 份过期周报快照` : ""}`);
    } catch (error) {
      result.warnings.push(`周报素材快照失败：${error.message}`);
    }
  }

  try {
    result.cleanup = await archiveExpiredArticles({ root, keepDays, stage: true });
    if (result.cleanup.deletedArticles > 0) {
      log(`轻量留档并清理 ${result.cleanup.deletedArticles} 篇超过 ${keepDays} 天的旧文章`);
    }
  } catch (error) {
    result.warnings.push(`旧文章清理失败：${error.message}`);
  }

  try {
    result.raw = await refreshRawArticlesSnapshot();
    result.archive = await archiveRawSnapshotOnce();
    if (root) result.rawRetention = await archiveExpiredRawSnapshots({ root, keepDays, stage: true });
    log(`RAW 已同步 ${result.raw.total} 条${result.archive.created ? "，已保存当日备份" : ""}`);
  } catch (error) {
    result.warnings.push(`RAW 同步失败：${error.message}`);
  }

  return result;
}
