// AI 分析记录层（P4）
// 契约：AI 结论只写入 ai_analyses，绝不写回 articles/events/games 原始字段（AI-01）。
// 人工修正写入 manual_override，展示与排序始终以人工结果优先。
export function createAnalysisService(db) {
  function latest(targetType, targetId) {
    return (
      db
        .prepare(
          `SELECT * FROM ai_analyses WHERE target_type=? AND target_id=?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(targetType, targetId) || null
    );
  }

  function insert({ id, targetType, targetId, input, model, promptVersion, conclusion, confidence }) {
    db.prepare(
      `INSERT INTO ai_analyses
         (id, target_type, target_id, input_snapshot_json, model, prompt_version, conclusion, confidence, created_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
    ).run(id, targetType, targetId, JSON.stringify(input), model, promptVersion, conclusion, confidence ?? null);
  }

  // 记录一次 AI 分析；input 为输入快照（分析时的数据快照，用于审计与复现）
  function run({ targetType, targetId, input, model, promptVersion, conclusion, confidence }) {
    const id = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    insert({ id, targetType, targetId, input, model, promptVersion, conclusion, confidence });
    return latest(targetType, targetId);
  }

  // 人工修正：只更新最近一条分析的 manual_override，不影响结论字段与原始数据
  function override(targetType, targetId, manual, note = null) {
    const row = latest(targetType, targetId);
    if (row) {
      db.prepare(
        `UPDATE ai_analyses SET manual_override=?, created_at=datetime('now') WHERE id=?`
      ).run(note ? `${manual}（${note}）` : manual, row.id);
    } else {
      insert({
        id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        targetType, targetId, input: {}, model: "manual", promptVersion: "manual-override",
        conclusion: null, confidence: null,
      });
      const r = latest(targetType, targetId);
      db.prepare(`UPDATE ai_analyses SET manual_override=? WHERE id=?`).run(manual, r.id);
    }
    return latest(targetType, targetId);
  }

  function get(targetType, targetId) {
    return latest(targetType, targetId);
  }

  return { run, override, get };
}
