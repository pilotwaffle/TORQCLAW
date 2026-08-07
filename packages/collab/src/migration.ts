import Database from 'better-sqlite3';

/**
 * Applies the Collaboration Substrate v1 migration.
 * Migration ID: 20260806_001_collaboration_v1
 *
 * Requires SQLite >= 3.35 and applies exact DDL from PRD Section 9.
 * Per PRD v0.14: if the migration ID already exists in collab_schema_migrations,
 * returns without executing anything (a complete no-op that succeeds).
 * Runs under BEGIN EXCLUSIVE, sets pragmas, applies schema, records version.
 * Rolls back completely on any error.
 */
export function runCollaborationMigration(db: Database.Database): void {
  // Check SQLite version
  const versionRow = db.prepare('SELECT sqlite_version() AS version').get() as { version: string } | undefined;
  if (!versionRow) {
    throw new Error('Could not determine SQLite version');
  }
  const parts = versionRow.version.split('.');
  const major = parts[0] ? parseInt(parts[0], 10) : 0;
  const minor = parts[1] ? parseInt(parts[1], 10) : 0;
  if (major < 3 || (major === 3 && minor < 35)) {
    throw new Error(`SQLite 3.35+ required; found ${versionRow.version}`);
  }

  // Ensure pragmas are set before migration
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');

  const transaction = db.transaction(() => {
    // Check if migration has already been run (v0.14 re-run semantics: no-op if exists)
    // We check this INSIDE the transaction so the table exists after the first run
    let tableExists = false;
    try {
      const result = db.prepare('SELECT 1 FROM collab_schema_migrations LIMIT 1').get();
      tableExists = true;
    } catch {
      // Table doesn't exist yet, that's fine - we'll create it
      tableExists = false;
    }

    if (tableExists) {
      const existingMigration = db.prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?').get('20260806_001_collaboration_v1');
      if (existingMigration) {
        // Migration already applied; skip schema creation, just return
        return;
      }
    }
    // Exact DDL from PRD Section 9
    db.exec(`
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('operator','agent')),
  display_name TEXT NOT NULL,
  owner_principal_id TEXT REFERENCES principals(id),
  status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')),
  auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK(auth_epoch > 0),
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind='operator' AND owner_principal_id IS NULL AND status IN ('active','revoked'))
    OR
    (kind='agent' AND owner_principal_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX principals_single_operator
  ON principals(kind) WHERE kind='operator';

CREATE TABLE principal_credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  secret_hmac BLOB NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE collab_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','archived')),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  channel_epoch INTEGER NOT NULL DEFAULT 1 CHECK(channel_epoch > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX collab_channels_active_name_key
  ON collab_channels(name_key) WHERE state='active';

CREATE TABLE collab_members (
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  role TEXT NOT NULL CHECK(role IN ('owner','agent')),
  state TEXT NOT NULL CHECK(state IN ('active','removed')),
  membership_epoch INTEGER NOT NULL DEFAULT 1 CHECK(membership_epoch > 0),
  rejoined_seq INTEGER NOT NULL DEFAULT 0 CHECK(rejoined_seq >= 0),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY(channel_id, principal_id)
);

CREATE TABLE collab_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  channel_seq INTEGER NOT NULL CHECK(channel_seq > 0),
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL CHECK(kind IN (
    'channel_created','member_added','member_removed',
    'message_posted','channel_archived','channel_unarchived'
  )),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id,channel_seq),
  UNIQUE(channel_id,id)
);

CREATE TABLE collab_cursors (
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  acknowledged_seq INTEGER NOT NULL CHECK(acknowledged_seq >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(channel_id,principal_id)
);

CREATE TABLE collab_mutation_results (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  command TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash BLOB NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(principal_id,command,idempotency_key)
);

CREATE TABLE collab_session_bindings (
  session_id TEXT PRIMARY KEY,
  protocol_version INTEGER NOT NULL CHECK(protocol_version=2),
  connection_role TEXT NOT NULL CHECK(connection_role IN ('operator','channel')),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  credential_id TEXT NOT NULL REFERENCES principal_credentials(id),
  auth_epoch_snapshot INTEGER NOT NULL CHECK(auth_epoch_snapshot > 0),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK(close_reason IS NULL OR close_reason IN (
    'credential_revoked','principal_suspended','principal_restored',
    'principal_revoked','operator_revoked','slow_consumer',
    'socket_closed','recovery'
  ))
);

CREATE INDEX collab_session_credential_open
  ON collab_session_bindings(credential_id,closed_at);

CREATE INDEX collab_members_principal_state_channel
  ON collab_members(principal_id,state,channel_id);

CREATE INDEX collab_cursors_principal_channel
  ON collab_cursors(principal_id,channel_id);

CREATE INDEX principal_credentials_principal_state
  ON principal_credentials(principal_id,state);

CREATE TABLE collab_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN (
    'bootstrap_completed','credential_created','credential_revoked',
    'agent_suspended','agent_restored','agent_revoked',
    'operator_revoked','recovery_completed','recovery_kit_exported',
    'recovery_kit_verified'
  )),
  actor_principal_id TEXT REFERENCES principals(id),
  subject_principal_id TEXT REFERENCES principals(id),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX collab_audit_kind_created
  ON collab_audit(kind, created_at);

CREATE TABLE collab_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  installation_id TEXT NOT NULL UNIQUE,
  recovery_secret_hmac BLOB NOT NULL,
  principal_pepper_check BLOB NOT NULL,
  recovery_pepper_check BLOB NOT NULL,
  recovery_kit_id TEXT,
  recovery_kit_checksum TEXT,
  recovery_kit_verified_at TEXT,
  schema_version INTEGER NOT NULL CHECK(schema_version=1)
);

CREATE TABLE collab_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
    `);

    // Record schema version last
    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      '20260806_001_collaboration_v1',
      new Date().toISOString()
    );
  });

  // Run transaction with exclusive lock
  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
