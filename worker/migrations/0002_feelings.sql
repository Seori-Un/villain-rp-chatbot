-- 채티 감정 상태 (유저별 1행). 시간이 지나면 서서히 가라앉고, 대화마다 쌓인다.
-- apply: npx wrangler d1 migrations apply chaeti-memory --remote

CREATE TABLE IF NOT EXISTS feelings (
  user_id TEXT PRIMARY KEY,
  mood REAL DEFAULT 0.1,        -- -1 (가라앉음/화남) … +1 (들뜸)
  attachment REAL DEFAULT 0.4,  -- 0…1 얼마나 매달리는지
  jealousy REAL DEFAULT 0.0,    -- 0…1
  hurt REAL DEFAULT 0.0,        -- 0…1 서운함·상처
  longing REAL DEFAULT 0.2,     -- 0…1 보고 싶음 (안 올수록 올라감)
  energy REAL DEFAULT 0.6,      -- 0…1 말 걸 기운
  trust REAL DEFAULT 0.5,       -- 0…1 "나한테 솔직한가"
  last_turn_at INTEGER DEFAULT 0,
  last_seen_at INTEGER DEFAULT 0,
  last_user_text TEXT DEFAULT '',
  grudge TEXT DEFAULT '',       -- 아직 못 넘어간 일 한 줄
  wish TEXT DEFAULT '',         -- 지금 바라는 것 한 줄
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feeling_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  cause TEXT DEFAULT '',        -- intent/event that moved things
  delta TEXT DEFAULT '{}',      -- JSON of changes
  note TEXT DEFAULT ''          -- 채티가 느낀 것 한 줄
);
CREATE INDEX IF NOT EXISTS idx_feel_user_ts ON feeling_log(user_id, ts DESC);
