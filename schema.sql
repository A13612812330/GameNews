-- =====================================================================
-- GameNewsUnified 统一数据中心 Schema  v1
-- 生成: 2026-08-26 (P1)
-- 约定:
--   1. Steam AppID 是 games 的唯一主键
--   2. steam_snapshots 只追加、不覆盖
--   3. AI 结论只写入 ai_analyses, 禁止写回 articles/events 原始字段
--   4. 游戏名称不作为唯一主键; 名称关联走 game_aliases
--   5. 所有迁移只增不删, 保留 legacy_id / source_system 可回溯
-- =====================================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------- website / 资讯 ----------------
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,               -- 手游/端游/Steam...
  urls_json     TEXT,
  access_policy TEXT DEFAULT 'list_public',
  detail_policy TEXT DEFAULT 'public_detail',
  enabled       INTEGER DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id                 TEXT PRIMARY KEY,      -- 统一 id: {system}:{legacy_id}
  legacy_id          TEXT NOT NULL,          -- 旧系统原始 id
  source_system      TEXT NOT NULL,          -- game-news | wx-news-wiki | workbuddy
  source_id          TEXT,
  source_name        TEXT,
  title              TEXT NOT NULL,
  game_name          TEXT,
  category           TEXT DEFAULT '新游上线',
  detail_url         TEXT,
  image_url          TEXT,
  date_text          TEXT,
  score              INTEGER DEFAULT 50,
  status             TEXT,                   -- candidate/detail/unselected/selected...
  quality            TEXT DEFAULT 'pending', -- pending/ok/low/demo
  paragraphs_json    TEXT,
  facts_json         TEXT,
  images_json        TEXT,
  payload_json       TEXT,                   -- 原始载荷(WX crawler_records.payload)
  game_match         TEXT,
  diagnostic_json    TEXT,
  review_status      TEXT DEFAULT 'pending',
  review_notes       TEXT,
  ai_summary         TEXT,                   -- 仅历史迁移值; 新 AI 结论写 ai_analyses
  selected_for_brief INTEGER DEFAULT 0,
  reviewed_at        TEXT,
  discovered_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  imported_batch     TEXT,
  UNIQUE (source_system, legacy_id)
);
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
CREATE INDEX IF NOT EXISTS idx_articles_sys    ON articles(source_system);

CREATE TABLE IF NOT EXISTS events (
  id                TEXT PRIMARY KEY,
  game_id           INTEGER,                 -- 关联 games.appid, 可为空
  title             TEXT NOT NULL,
  event_type        TEXT,                    -- 上线定档/测试公测/版本更新/活动...
  started_at        TEXT,
  ended_at          TEXT,
  source_article_id TEXT,
  source_url        TEXT,
  description       TEXT,
  source_system     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  imported_batch    TEXT
);

CREATE TABLE IF NOT EXISTS editorial_drafts (
  id            TEXT PRIMARY KEY,
  legacy_id     TEXT,
  source_system TEXT,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  template_id   TEXT,
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  article_id    TEXT,
  src           TEXT NOT NULL,
  original_url  TEXT,
  type          TEXT DEFAULT 'body_candidate',
  width         INTEGER,
  height        INTEGER,
  size          INTEGER,
  mime_type     TEXT,
  sha1          TEXT,
  created_at    TEXT NOT NULL
);

-- ---------------- crawler ----------------
CREATE TABLE IF NOT EXISTS crawl_runs (
  id          TEXT PRIMARY KEY,
  source_id   TEXT,
  run_kind    TEXT NOT NULL,                 -- crawl/detail/steam
  started_at  TEXT,
  finished_at TEXT,
  status      TEXT,
  items_found INTEGER DEFAULT 0,
  items_new   INTEGER DEFAULT 0,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS raw_payloads (
  id           TEXT PRIMARY KEY,
  source_id    TEXT,
  ref_id       TEXT,                         -- 关联 articles.id
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- ---------------- Steam ----------------
CREATE TABLE IF NOT EXISTS games (
  appid              INTEGER PRIMARY KEY,   -- Steam AppID 唯一主键
  cn_name            TEXT,
  name               TEXT,
  developer          TEXT,
  tags               TEXT,
  release_date       TEXT,
  installed_size     TEXT,
  is_indie           INTEGER,
  min_config         TEXT,
  recommended_config TEXT,
  first_seen_at      TEXT,
  updated_at         TEXT,
  imported_batch     TEXT
);

CREATE TABLE IF NOT EXISTS steam_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  appid           INTEGER NOT NULL REFERENCES games(appid),
  snapshot_at     TEXT NOT NULL,             -- 采集/快照时间
  snapshot_source TEXT NOT NULL,             -- workbuddy-history | game-news-steam | external
  metric_name     TEXT NOT NULL,             -- current_online/peak_online/rank/...
  metric_value    TEXT,
  raw_json        TEXT,
  data_grade      TEXT NOT NULL DEFAULT 'history', -- realtime/history/demo
  UNIQUE (appid, snapshot_at, snapshot_source, metric_name)
);
CREATE INDEX IF NOT EXISTS idx_snap_appid ON steam_snapshots(appid, snapshot_at);

CREATE TABLE IF NOT EXISTS steam_source_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  appid        INTEGER REFERENCES games(appid), -- 可为空(如无法对应)
  game_name    TEXT,
  source_kind  TEXT NOT NULL,                -- search | jingyun
  metric_name  TEXT NOT NULL,
  metric_value TEXT,
  extra_json   TEXT,
  snapshot_at   TEXT,
  data_grade    TEXT DEFAULT 'history',
  source_system TEXT DEFAULT 'workbuddy',
  UNIQUE (source_kind, game_name, metric_name, snapshot_at)
);

CREATE TABLE IF NOT EXISTS game_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  appid      INTEGER REFERENCES games(appid),
  alias      TEXT NOT NULL,
  alias_type TEXT NOT NULL,                  -- cn/en/search/jingyun/game_news
  UNIQUE (alias, alias_type)
);

-- ---------------- publishing ----------------
CREATE TABLE IF NOT EXISTS briefs (
  id                TEXT PRIMARY KEY,
  legacy_id         TEXT,
  source_system     TEXT,
  title             TEXT NOT NULL,
  style             TEXT DEFAULT 'professional',
  max_length        INTEGER DEFAULT 1200,
  lead              TEXT,
  template_id       TEXT,
  total_characters  INTEGER DEFAULT 0,
  reading_minutes   INTEGER DEFAULT 3,
  sections_json     TEXT,
  source_notes_json TEXT,
  status            TEXT DEFAULT 'draft',
  slot              TEXT DEFAULT 'daily',
  published_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brief_items (
  brief_id   TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (brief_id, article_id)
);

CREATE TABLE IF NOT EXISTS publication_runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                -- brief/poster/weekly/feishu
  target       TEXT,
  status       TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  output_path  TEXT,
  fingerprint  TEXT,
  error        TEXT
);

-- ---------------- feishu / 评级 ----------------
CREATE TABLE IF NOT EXISTS ratings (
  id                TEXT PRIMARY KEY,
  ref_type          TEXT NOT NULL,                  -- article/game/event
  ref_id            TEXT NOT NULL,                  -- article id 或 game_key
  rating            TEXT NOT NULL,                  -- S·重点/A·优先/B·常规/C·留档
  score             INTEGER DEFAULT 0,              -- 自动评级分值（0-100）
  game_name         TEXT,
  source            TEXT NOT NULL DEFAULT 'manual', -- manual/auto；manual 优先
  note              TEXT,
  reason_json       TEXT,                           -- 自动评级原因/证据
  algorithm_version TEXT,                           -- 自动评级算法版本
  feishu_record_id  TEXT,                           -- 飞书评级表对应 record_id（回写用）
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (ref_type, ref_id, source)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                 -- s_alert/a_alert/brief/weekly...
  title       TEXT,
  payload_json TEXT,
  status      TEXT DEFAULT 'pending',
  fingerprint TEXT UNIQUE,                   -- 发送指纹防重复
  created_at  TEXT NOT NULL,
  sent_at     TEXT,
  error       TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS deliveries (
  id              TEXT PRIMARY KEY,
  notification_id TEXT,
  channel         TEXT NOT NULL,             -- feishu_sheet/feishu_bot
  status          TEXT,
  sent_at         TEXT,
  error           TEXT,
  message_id      TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  UNIQUE (notification_id, channel)
);

-- ---------------- AI 分析层 ----------------
CREATE TABLE IF NOT EXISTS ai_analyses (
  id                  TEXT PRIMARY KEY,
  target_type         TEXT NOT NULL,         -- article/game/event
  target_id           TEXT NOT NULL,
  input_snapshot_json TEXT,
  model               TEXT,
  prompt_version      TEXT,
  conclusion          TEXT,
  confidence          REAL,
  manual_override     TEXT,
  manual_override_at  TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (target_type, target_id, prompt_version)
);

-- ---------------- 迁移日志 ----------------
CREATE TABLE IF NOT EXISTS migration_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  read_count      INTEGER DEFAULT 0,
  written_count   INTEGER DEFAULT 0,
  skipped_count   INTEGER DEFAULT 0,
  conflict_count  INTEGER DEFAULT 0,
  duplicate_count INTEGER DEFAULT 0,
  detail_json     TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', 'v1');
INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('created_at', datetime('now'));
