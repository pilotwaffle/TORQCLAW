PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Sessions outlive sockets. A session is resumed by passing its id in the
--    ConnectFrame; a new WebSocket does NOT mean a new session.
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    client_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Immutable event log. seq is the replay cursor: monotonic AUTOINCREMENT,
--    never wall-clock (CURRENT_TIMESTAMP has 1s resolution; tool loops emit
--    several events per second).
CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    request_id TEXT,
    tier TEXT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);

-- 3. Task lifecycle (persist BEFORE executing; crash leaves a resumable row).
CREATE TABLE IF NOT EXISTS tasks (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    tier TEXT NOT NULL,
    router_reason TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',     -- running | completed | failed
    request_json TEXT NOT NULL,                 -- full GatewayRequest (audit + replay)
    result TEXT,
    error TEXT,
    telemetry_json TEXT,                        -- final telemetry incl. costUsd
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
);

-- 4. Episodic memory: LLM-condensed summaries of completed tasks.
CREATE TABLE IF NOT EXISTS task_episodes (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    original_prompt TEXT NOT NULL,
    final_result TEXT NOT NULL,
    summary TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. FTS5 external-content index over episodic memory.
CREATE VIRTUAL TABLE IF NOT EXISTS task_search USING fts5(
    original_prompt,
    summary,
    content='task_episodes',
    content_rowid='rowid'
);

-- 6. Full trigger set. External-content FTS5 corrupts silently if deletes
--    and updates aren't mirrored with the special 'delete' insert.
CREATE TRIGGER IF NOT EXISTS task_episodes_ai AFTER INSERT ON task_episodes BEGIN
  INSERT INTO task_search(rowid, original_prompt, summary)
  VALUES (new.rowid, new.original_prompt, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS task_episodes_ad AFTER DELETE ON task_episodes BEGIN
  INSERT INTO task_search(task_search, rowid, original_prompt, summary)
  VALUES ('delete', old.rowid, old.original_prompt, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS task_episodes_au AFTER UPDATE ON task_episodes BEGIN
  INSERT INTO task_search(task_search, rowid, original_prompt, summary)
  VALUES ('delete', old.rowid, old.original_prompt, old.summary);
  INSERT INTO task_search(rowid, original_prompt, summary)
  VALUES (new.rowid, new.original_prompt, new.summary);
END;

-- 7. Pending skill approvals (human-in-the-loop gate over the Hermes loop).
CREATE TABLE IF NOT EXISTS skill_queue (
    queue_id TEXT PRIMARY KEY,
    proposed_name TEXT NOT NULL,
    skill_markdown TEXT NOT NULL,
    source_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at DATETIME
);
