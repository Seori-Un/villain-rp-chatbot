-- 채티 장기 기억 (Cloudflare D1)
-- apply: npx wrangler d1 migrations apply chaeti-memory --remote

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT DEFAULT '',
  mode TEXT DEFAULT 'rp',
  tz TEXT DEFAULT 'Asia/Seoul',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  summary TEXT DEFAULT '',
  summarized_count INTEGER DEFAULT 0,
  topic_done INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,          -- user | assistant
  content TEXT NOT NULL,
  kind TEXT DEFAULT 'chat',    -- chat | browse | event
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,           -- YYYY-MM-DD in user's tz
  meta TEXT DEFAULT ''         -- JSON (sources, event, …)
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_ts ON messages(conv_id, ts);
CREATE INDEX IF NOT EXISTS idx_msg_user_day ON messages(user_id, day, ts);

-- unicode61 + prefix queries (날씨* matches 날씨가/날씨는…) works well for Korean stems
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TABLE IF NOT EXISTS day_summaries (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  summary TEXT DEFAULT '',
  highlights TEXT DEFAULT '[]', -- JSON array of strings
  message_count INTEGER DEFAULT 0,
  summarized_count INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT DEFAULT '',
  keywords TEXT DEFAULT '',    -- comma separated
  conv_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_user ON topics(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS topic_links (
  topic_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  snippet TEXT DEFAULT '',
  ts INTEGER NOT NULL,
  PRIMARY KEY (topic_id, conv_id)
);
CREATE INDEX IF NOT EXISTS idx_tl_conv ON topic_links(conv_id);
