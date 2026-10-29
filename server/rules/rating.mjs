// 评级与人工覆盖（统一规则层）
// RULE-03：人工评级（source=manual）优先于 AI 评级；人工值一经设置即保留并生效。
// 依赖注入 db，便于测试与不同出口复用。
export function createRatingService(db) {
  function upsert(refType, refId, rating, source, note) {
    const id = `${refType}:${refId}:${source}`;
    db.prepare(
      `INSERT INTO ratings (id, ref_type, ref_id, rating, source, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))
       ON CONFLICT(ref_type, ref_id, source) DO UPDATE SET
         rating=excluded.rating,
         note=COALESCE(excluded.note, ratings.note),
         updated_at=datetime('now')`
    ).run(id, refType, refId, rating, source, note);
  }

  // 设置评级；source 默认 manual（人工），会覆盖同源旧值
  function set(refType, refId, rating, source = "manual", note = null) {
    upsert(refType, refId, rating, source, note);
    return getEffective(refType, refId);
  }

  // 生效评级：人工优先；无人工则取 AI
  function getEffective(refType, refId) {
    return (
      db
        .prepare(
          `SELECT * FROM ratings WHERE ref_type=? AND ref_id=?
           ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
        )
        .get(refType, refId) || null
    );
  }

  // 删除人工覆盖，回落到 AI 评级
  function removeManual(refType, refId) {
    db.prepare("DELETE FROM ratings WHERE ref_type=? AND ref_id=? AND source='manual'").run(refType, refId);
    return getEffective(refType, refId);
  }

  return { set, getEffective, removeManual };
}
