// Steam 实时快照写入层（P4）
// 契约：快照只追加、不覆盖（STEAM-01）；games 用 upsert 更新主信息。
// 实时采集逻辑保留自 GameNews 的 server/crawler/platforms/steam.js（不重写），
// 本模块只负责把采集结果写入统一库。
import { createAppIdMap } from "./appid-map.mjs";

export function createSteamWriter(db) {
  const appIdMap = createAppIdMap(db);

  // 写一条/多条快照。metrics: { metricName: value }；source 区分实时/历史来源。
  function saveSnapshot({ appid, snapshotAt, source = "game-news-steam", metrics = {}, raw = null, grade = "realtime" }) {
    if (!Number.isInteger(Number(appid)) || Number(appid) <= 0) return 0;
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO steam_snapshots
         (appid, snapshot_at, snapshot_source, metric_name, metric_value, raw_json, data_grade)
       VALUES (?,?,?,?,?,?,?)`
    );
    let n = 0;
    for (const [metricName, metricValue] of Object.entries(metrics)) {
      n += stmt.run(
        Number(appid), snapshotAt, source, metricName,
        metricValue === null || metricValue === undefined ? null : String(metricValue),
        raw ? JSON.stringify(raw) : null, grade
      ).changes;
    }
    return n;
  }

  // 更新 games 主信息（不覆盖已有非空字段，避免实时采集覆盖人工/历史信息）
  function upsertGame(game) {
    const { appid, cnName = null, name = null, developer = null, tags = null,
            releaseDate = null, installedSize = null, isIndie = null,
            minConfig = null, recommendedConfig = null, firstSeenAt = new Date().toISOString() } = game;
    db.prepare(
      `INSERT INTO games (appid, cn_name, name, developer, tags, release_date, installed_size, is_indie, min_config, recommended_config, first_seen_at, updated_at, imported_batch)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
       ON CONFLICT(appid) DO UPDATE SET
         cn_name=COALESCE(excluded.cn_name, games.cn_name),
         name=COALESCE(excluded.name, games.name),
         developer=COALESCE(excluded.developer, games.developer),
         tags=COALESCE(excluded.tags, games.tags),
         release_date=COALESCE(excluded.release_date, games.release_date),
         installed_size=COALESCE(excluded.installed_size, games.installed_size),
         is_indie=COALESCE(excluded.is_indie, games.is_indie),
         min_config=COALESCE(excluded.min_config, games.min_config),
         recommended_config=COALESCE(excluded.recommended_config, games.recommended_config),
         updated_at=datetime('now')`
    ).run(Number(appid), cnName, name, developer, tags, releaseDate, installedSize, isIndie, minConfig, recommendedConfig, firstSeenAt, "realtime");
  }

  return { saveSnapshot, upsertGame, appIdMap };
}
