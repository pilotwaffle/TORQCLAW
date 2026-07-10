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

-- 8. Pending tool approvals (P2: one-shot tool grant over the LOCAL_EDGE loop).
--    A gated-tool hit registers a row; the gateway emits the terminal
--    PENDING_APPROVAL carrying approval_id. APPROVE re-mints the GatewayRequest
--    from tasks.request_json with grantedTools=[tool_name]; REJECT -> terminal
--    ERROR. args_json is the model-proposed args (display/audit only; NEVER
--    replayed — the re-run regenerates the call under the grant).
CREATE TABLE IF NOT EXISTS tool_approvals (
    approval_id TEXT PRIMARY KEY,
    request_id  TEXT NOT NULL,                 -- the BLOCKED task's request id
    tool_name   TEXT NOT NULL,                 -- real (namespaced) name = grant unit
    args_json   TEXT NOT NULL,                 -- proposed args, display/audit only
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at  DATETIME
);
CREATE INDEX IF NOT EXISTS idx_tool_approvals_request ON tool_approvals(request_id);

-- 9. Run receipts (TCLAW-4A): a DETERMINISTIC PROJECTION over tasks/events/
--    tool_approvals for one task (request_id), materialized after each
--    terminal dispatch outcome. The event log + tasks table remain the
--    source of truth; this table is a derived, rebuildable read cache — it
--    is NEVER the only copy of anything and can be dropped and rebuilt from
--    events/tasks/tool_approvals at any time (see ops/receipts-rebuild.mjs).
--    Gateway-DB-only: this is NOT an emitted contract (no schema in
--    packages/contracts/generated or engines/hermes_kernel/mcp_wrapper/schemas).
--    TCLAW-4B: read-only via LIST_RECEIPTS/GET_RECEIPT as untyped SYSTEM-event
--    metadata; still not a typed emitted contract of its own.
CREATE TABLE IF NOT EXISTS run_receipts (
  id TEXT PRIMARY KEY,                      -- randomUUID, receipt row id (preserved on re-projection)
  task_id TEXT NOT NULL UNIQUE,             -- = tasks.request_id (upsert key)
  session_id TEXT NOT NULL,
  source_channel TEXT,
  selected_tier TEXT,
  route_diagnostics_json TEXT,
  budget_limit REAL,
  budget_source TEXT,                       -- NULL for 4A (not persisted)
  cost_usd REAL,
  cost_enforceable INTEGER,                 -- NULL for 4A (not persisted)
  elapsed_ms INTEGER,
  iterations INTEGER,
  tools_called_json TEXT,
  cancelled INTEGER,
  blocked_on TEXT,
  memory_used INTEGER,
  context_chars INTEGER,
  result_state TEXT,                        -- 'completed' | 'failed' | 'blocked' (derived)
  safe_export_json TEXT,                    -- NULL for 4A (redaction is a later ticket)
  full_receipt_json TEXT,
  evidence_start_seq INTEGER,
  evidence_end_seq INTEGER,
  projection_version INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,   -- materialization time (preserved on conflict)
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP    -- bumped each projection
);
CREATE INDEX IF NOT EXISTS idx_run_receipts_session ON run_receipts(session_id);
CREATE INDEX IF NOT EXISTS idx_events_request ON events(request_id);
