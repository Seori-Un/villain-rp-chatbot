-- 터널 없이 러너를 쓰기 위한 일감 큐 (러너가 Worker로 받으러 옴: pull 모드)
-- apply: npx wrangler d1 migrations apply chaeti-memory --remote

CREATE TABLE IF NOT EXISTS runner_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | taken | done | failed
  payload TEXT NOT NULL,                   -- JSON {action, session_id, ...args}
  result TEXT DEFAULT '',                  -- JSON observation
  created_at INTEGER NOT NULL,
  taken_at INTEGER DEFAULT 0,
  done_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON runner_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS runner_presence (
  runner_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  info TEXT DEFAULT ''
);
