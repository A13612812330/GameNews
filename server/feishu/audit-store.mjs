// 飞书提醒投递审计：通知状态、失败重试与飞书 message_id 均落本地 SQLite。
// 仅管理本地审计数据，不直接调用飞书网络。
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function ensureNotificationAuditSchema(db) {
  const ensure = (table, column, definition) => {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((x) => x.name));
    if (!cols.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  ensure("notifications", "retry_count", "INTEGER NOT NULL DEFAULT 0");
  ensure("notifications", "next_retry_at", "TEXT");
  ensure("notifications", "updated_at", "TEXT");
  ensure("deliveries", "message_id", "TEXT");
  ensure("deliveries", "retry_count", "INTEGER NOT NULL DEFAULT 0");
  ensure("deliveries", "last_error", "TEXT");
  ensure("deliveries", "created_at", "TEXT");
  ensure("deliveries", "updated_at", "TEXT");
}

export function queueAlertNotifications(db, items = []) {
  ensureNotificationAuditSchema(db);
  const stmt = db.prepare(`INSERT OR IGNORE INTO notifications
    (id, kind, title, payload_json, status, fingerprint, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  let queued = 0;
  for (const item of items) {
    const type = item.type === "活动" ? "activity" : "new_game";
    const changed = stmt.run(
      id("nt"), type, `${item.grade || "—"} · ${item.game || "未命名游戏"}`,
      JSON.stringify(item), "pending", `feishu-alert:${item.eventKey}`, now(), now()
    ).changes;
    queued += changed;
  }
  return queued;
}

export function pendingAlertNotifications(db, limit = 30) {
  ensureNotificationAuditSchema(db);
  const rows = db.prepare(`SELECT * FROM notifications
    WHERE kind IN ('new_game','activity')
      AND status IN ('pending','failed')
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC LIMIT ?`).all(now(), limit);
  return rows.flatMap((row) => {
    try { return [{ notification: row, item: JSON.parse(row.payload_json || "{}") }]; } catch { return []; }
  }).filter((x) => x.item && x.item.eventKey);
}

function nextRetry(attempt) {
  const hours = Math.min(6, Math.max(1, 2 ** Math.max(0, attempt - 1)));
  return new Date(Date.now() + hours * 3600000).toISOString();
}

export function recordAlertAttempt(db, notification, result) {
  ensureNotificationAuditSchema(db);
  const attempt = Number(notification.retry_count || 0) + 1;
  const sent = Boolean(result?.messageId);
  const error = sent ? null : String(result?.error || "飞书未返回消息 ID").slice(0, 800);
  const timestamp = now();
  db.prepare(`UPDATE notifications
    SET status=?, sent_at=?, error=?, retry_count=?, next_retry_at=?, updated_at=? WHERE id=?`).run(
    sent ? "sent" : "failed", sent ? timestamp : notification.sent_at || null, error,
    attempt, sent ? null : nextRetry(attempt), timestamp, notification.id
  );
  db.prepare(`INSERT INTO deliveries
    (id, notification_id, channel, status, sent_at, error, message_id, retry_count, last_error, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(notification_id, channel) DO UPDATE SET
      status=excluded.status, sent_at=excluded.sent_at, error=excluded.error,
      message_id=excluded.message_id, retry_count=excluded.retry_count,
      last_error=excluded.last_error, updated_at=excluded.updated_at`).run(
    id("dl"), notification.id, "feishu_bot", sent ? "sent" : "failed", sent ? timestamp : null,
    error, result?.messageId || null, attempt, error, timestamp, timestamp
  );
}

export function requeueNotification(db, notificationId) {
  ensureNotificationAuditSchema(db);
  const changed = db.prepare(`UPDATE notifications
    SET status='pending', next_retry_at=NULL, error=NULL, updated_at=?
    WHERE id=? AND status='failed'`).run(now(), notificationId).changes;
  return changed > 0;
}
