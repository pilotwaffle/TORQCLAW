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
  external_export_policy TEXT NOT NULL DEFAULT 'local_only' CHECK(external_export_policy IN ('local_only','operator_confirmed_non_sensitive')),
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

  // PRD-TCLAW-AGENT-PARTICIPATION-007 S3: deliberately NOT cascaded here.
  // An earlier version of this function called runAgentAutoreplyMigration
  // unconditionally at the end of every runCollaborationMigration call --
  // that broke tests/auth-v2-phase2a.test.ts's own fail-closed foundation
  // check (authIdentityMigration.ts's assertShippedCollabLedger), which
  // deliberately THROWS if collab_schema_migrations carries an "unexpected"
  // extra row beyond its own known two-row ledger -- that is the exact
  // security property that test's "extra ledger row" case pins. Cascading
  // here made every fresh collab.db carry a third row before the AUTH-005
  // lane ever ran, permanently tripping its ambiguous-foundation refusal.
  // The fix is the SAME pattern packages/gateway/src/collabIdentity.ts's
  // migrateCollabDb already uses for C1 (runSurfaceIdentityMigration,
  // runSurfaceAuditMigration are separate, explicitly-invoked calls, never
  // cascaded inside this function): callers that want S3's tables call
  // runAgentAutoreplyMigration(db) themselves, alongside their own call to
  // runCollaborationMigration, exactly as migrateCollabDb now does.
}

/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S3 — additive migration for the
 * auto-reply turn watermark and the STOP control.
 *
 * Migration ID: 20260818_001_agent_autoreply_v1
 *
 * Strictly additive (same discipline as approvalSchema.ts's C2 migration):
 * two new tables, `CREATE TABLE IF NOT EXISTS`, no change to any existing
 * table or column. Idempotent: re-running when the id is already recorded
 * is a complete no-op.
 *
 * WHY THESE LIVE IN collab.db, NOT state.db
 * ------------------------------------------
 * Both tables are keyed on collab substrate identifiers (channel_id,
 * channel_seq, agent principal_id) that only collab.db can enforce FKs
 * against; cross-database FKs are forbidden (see approvalSchema.ts's own
 * note). The gateway-side dispatcher (autoReplyDispatcher.ts) reads/writes
 * these through the same store DB handle collabSurface.ts's getStore()
 * already resolves -- no second connection.
 *
 * collab_agent_turns — THE WATERMARK (G1R B-3 part b)
 * -----------------------------------------------------
 * "highest seq dispatched" and "highest seq completed" are DIFFERENT
 * watermarks, and conflating them either strands a branch silently (write
 * on dispatch, crash before completion => never re-dispatched, looks like
 * legitimate A3-f silence) or replays a completed turn (write on
 * completion, crash after dispatch => re-dispatched on restart). This table
 * makes both watermarks the SAME durable row, tracked through an explicit
 * state machine: 'dispatched' -> ('completed' | 'no_post' | 'terminated').
 * A boot-time sweep (recoverStrandedAgentTurns, autoReplyDispatcher.ts)
 * finds every row still 'dispatched' past a grace window and re-dispatches
 * it -- the exact recovery discipline grantAdmission.ts's
 * revokeInertGrants uses for the crash-between-decision-and-effect class,
 * reused rather than reinvented (G1R's explicit instruction).
 *
 * PRIMARY KEY (channel_id, agent_principal_id, channel_seq) is itself the
 * idempotency mechanism (anti-storm requirement 2): a second attempt to
 * dispatch the same triple is a duplicate INSERT and fails the uniqueness
 * constraint, so "already dispatched or completed" is enforced by SQLite,
 * not by an application-level read-then-write race.
 *
 * collab_autoreply_stop — THE STOP CONTROL (R-3a)
 * -------------------------------------------------
 * A gateway-side, persisted halt. scope='global' (channel_id NULL) OR
 * scope='channel' (channel_id set) -- checked by the dispatcher BEFORE
 * every new dispatch, never inside a turn (in-flight turns complete; their
 * posts do not re-trigger, per G1R N-2's ruling on N>2 fan-out semantics).
 * Persisted (not in-memory) so STOP survives a gateway restart (OQ-3,
 * ruled: survive, don't just state non-persistence honestly -- persisting
 * is strictly safer and no harder to build).
 */
export const AGENT_AUTOREPLY_MIGRATION_ID = '20260818_001_agent_autoreply_v1';
export const AGENT_TURN_OUTPUT_MIGRATION_ID = '20260821_005_agent_turn_output_v1';
export const AGENT_TURN_PERSONA_ENVELOPE_MIGRATION_ID = '20260821_006_agent_turn_persona_envelope_v1';
export const CHANNEL_EXTERNAL_EXPORT_POLICY_MIGRATION_ID = '20260822_007_channel_external_export_policy_v1';

export function runAgentAutoreplyMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db
      .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_AUTOREPLY_MIGRATION_ID);
    if (existing) return;

    db.exec(`
CREATE TABLE IF NOT EXISTS collab_agent_turns (
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  agent_principal_id TEXT NOT NULL REFERENCES principals(id),
  channel_seq INTEGER NOT NULL CHECK(channel_seq > 0),
  trigger_event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('dispatched','completed','no_post','terminated')),
  dispatch_request_id TEXT,
  dispatched_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(channel_id, agent_principal_id, channel_seq)
);

CREATE INDEX IF NOT EXISTS collab_agent_turns_state_dispatched
  ON collab_agent_turns(state, dispatched_at);

CREATE TABLE IF NOT EXISTS collab_autoreply_stop (
  scope TEXT NOT NULL CHECK(scope IN ('global','channel')),
  channel_id TEXT REFERENCES collab_channels(id),
  stopped_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  stopped_at TEXT NOT NULL,
  CHECK ((scope='global' AND channel_id IS NULL) OR (scope='channel' AND channel_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS collab_autoreply_stop_global_singleton
  ON collab_autoreply_stop(scope) WHERE scope='global';

CREATE UNIQUE INDEX IF NOT EXISTS collab_autoreply_stop_channel_singleton
  ON collab_autoreply_stop(channel_id) WHERE scope='channel';
    `);

    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      AGENT_AUTOREPLY_MIGRATION_ID,
      new Date().toISOString(),
    );
  });

  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  runAgentTurnOutputMigration(db);
}

export function runAgentTurnOutputMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db
      .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_TURN_OUTPUT_MIGRATION_ID);
    if (existing) return;

    const columns = new Set(
      (db.prepare('PRAGMA table_info(collab_agent_turns)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has('output_event_id')) {
      db.exec('ALTER TABLE collab_agent_turns ADD COLUMN output_event_id TEXT');
    }
    if (!columns.has('output_kind')) {
      db.exec("ALTER TABLE collab_agent_turns ADD COLUMN output_kind TEXT CHECK(output_kind IN ('tool','fallback'))");
    }
    if (!columns.has('recovery_attempt')) {
      db.exec('ALTER TABLE collab_agent_turns ADD COLUMN recovery_attempt INTEGER NOT NULL DEFAULT 0 CHECK(recovery_attempt >= 0)');
    }
    if (!columns.has('recovery_lease_token')) {
      db.exec('ALTER TABLE collab_agent_turns ADD COLUMN recovery_lease_token TEXT');
    }

    db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS collab_agent_turns_output_event_unique
  ON collab_agent_turns(output_event_id) WHERE output_event_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS collab_agent_turn_output_pair_insert
BEFORE INSERT ON collab_agent_turns
WHEN (NEW.output_event_id IS NULL) <> (NEW.output_kind IS NULL)
BEGIN SELECT RAISE(ABORT, 'agent turn output fields must be paired'); END;

CREATE TRIGGER IF NOT EXISTS collab_agent_turn_output_pair_update
BEFORE UPDATE OF output_event_id, output_kind ON collab_agent_turns
WHEN (NEW.output_event_id IS NULL) <> (NEW.output_kind IS NULL)
BEGIN SELECT RAISE(ABORT, 'agent turn output fields must be paired'); END;

CREATE TRIGGER IF NOT EXISTS collab_agent_turn_output_immutable
BEFORE UPDATE OF output_event_id, output_kind ON collab_agent_turns
WHEN OLD.output_event_id IS NOT NULL
 AND (NEW.output_event_id IS NOT OLD.output_event_id OR NEW.output_kind IS NOT OLD.output_kind)
BEGIN SELECT RAISE(ABORT, 'agent turn output binding is immutable'); END;
    `);

    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      AGENT_TURN_OUTPUT_MIGRATION_ID,
      new Date().toISOString(),
    );
  });

  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  runAgentTurnPersonaEnvelopeMigration(db);
}

export function runAgentTurnPersonaEnvelopeMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_TURN_PERSONA_ENVELOPE_MIGRATION_ID);
    if (existing) return;
    const columns = new Set(
      (db.prepare('PRAGMA table_info(collab_agent_turns)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has('persona_envelope_version')) db.exec('ALTER TABLE collab_agent_turns ADD COLUMN persona_envelope_version INTEGER');
    if (!columns.has('persona_content')) db.exec('ALTER TABLE collab_agent_turns ADD COLUMN persona_content TEXT');
    if (!columns.has('persona_revision')) db.exec('ALTER TABLE collab_agent_turns ADD COLUMN persona_revision INTEGER');
    if (!columns.has('persona_content_sha256')) db.exec('ALTER TABLE collab_agent_turns ADD COLUMN persona_content_sha256 TEXT');

    const forbiddenClause = FORBIDDEN_PERSONA_CODEPOINTS
      .map((codepoint) => `instr(NEW.persona_content, char(${codepoint})) > 0`)
      .join(' OR ');
    db.exec(`
CREATE TRIGGER IF NOT EXISTS collab_agent_turn_persona_insert_guard
BEFORE INSERT ON collab_agent_turns
WHEN
  ((NEW.persona_envelope_version IS NULL) + (NEW.persona_content IS NULL) +
   (NEW.persona_revision IS NULL) + (NEW.persona_content_sha256 IS NULL)) NOT IN (0, 4)
  OR (NEW.persona_envelope_version IS NOT NULL AND (
    NEW.persona_envelope_version <> 1 OR NEW.persona_revision < 0 OR
    length(NEW.persona_content) > 4000 OR length(NEW.persona_content_sha256) <> 64 OR
    NEW.persona_content_sha256 GLOB '*[^0-9a-f]*' OR
    (NEW.persona_content = '' AND NEW.persona_revision <> 0) OR ${forbiddenClause}
  ))
BEGIN SELECT RAISE(ABORT, 'agent turn persona envelope is malformed'); END;

CREATE TRIGGER IF NOT EXISTS collab_agent_turn_persona_update_guard
BEFORE UPDATE OF persona_envelope_version, persona_content, persona_revision, persona_content_sha256
ON collab_agent_turns
WHEN ((NEW.persona_envelope_version IS NULL) + (NEW.persona_content IS NULL) +
      (NEW.persona_revision IS NULL) + (NEW.persona_content_sha256 IS NULL)) NOT IN (0, 4)
BEGIN SELECT RAISE(ABORT, 'agent turn persona envelope must be all-or-none'); END;

CREATE TRIGGER IF NOT EXISTS collab_agent_turn_persona_immutable
BEFORE UPDATE OF persona_envelope_version, persona_content, persona_revision, persona_content_sha256
ON collab_agent_turns
WHEN NEW.persona_envelope_version IS NOT OLD.persona_envelope_version
  OR NEW.persona_content IS NOT OLD.persona_content
  OR NEW.persona_revision IS NOT OLD.persona_revision
  OR NEW.persona_content_sha256 IS NOT OLD.persona_content_sha256
BEGIN SELECT RAISE(ABORT, 'agent turn persona envelope is immutable'); END;
    `);
    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      AGENT_TURN_PERSONA_ENVELOPE_MIGRATION_ID,
      new Date().toISOString(),
    );
  });
  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  runChannelExternalExportPolicyMigration(db);
}

/** Durable, default-deny channel policy for exporting collaboration context
 * to a trusted subscription runtime. Audit storage is additive because the
 * v1 collab_audit kind constraint is intentionally closed. */
export function runChannelExternalExportPolicyMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(CHANNEL_EXTERNAL_EXPORT_POLICY_MIGRATION_ID);
    if (existing) return;
    const columns = new Set(
      (db.prepare('PRAGMA table_info(collab_channels)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has('external_export_policy')) {
      db.exec("ALTER TABLE collab_channels ADD COLUMN external_export_policy TEXT NOT NULL DEFAULT 'local_only' CHECK(external_export_policy IN ('local_only','operator_confirmed_non_sensitive'))");
    }
    db.exec(`
CREATE TABLE IF NOT EXISTS collab_channel_export_policy_audit (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  prior_policy TEXT NOT NULL CHECK(prior_policy IN ('local_only','operator_confirmed_non_sensitive')),
  new_policy TEXT NOT NULL CHECK(new_policy IN ('local_only','operator_confirmed_non_sensitive')),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS collab_channel_export_policy_audit_channel_created
  ON collab_channel_export_policy_audit(channel_id, created_at);
    `);
    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      CHANNEL_EXTERNAL_EXPORT_POLICY_MIGRATION_ID,
      new Date().toISOString(),
    );
  });
  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * CRON — additive migration for scheduled autonomous agent turns.
 * G1R Gate-1 §2A ruling: cron is the SAME threat shape as auto-reply, and
 * strictly worse (no human proximity, no natural terminator, durable state
 * that outlives the regime it was created under). Prerequisite order per
 * that ruling: S0 (argument-scoped grants, shipped) FIRST, then auto-reply
 * and cron in either order. S0 and auto-reply (S3) are both shipped as of
 * this migration; this is the cron slice.
 *
 * Migration ID: 20260818_002_agent_cron_v1
 *
 * Strictly additive: two new tables, `CREATE TABLE IF NOT EXISTS`, no
 * change to any existing table or column. Idempotent.
 *
 * collab_agent_schedules — THE SCHEDULE (a TRIGGER, never a stored
 * authorization; G1R §2A.5(d))
 * -----------------------------------------------------------------------
 * A schedule names WHEN to wake an agent in a channel it is ALREADY a
 * member of. It does NOT store, cache, or widen any authority: every wake
 * re-reads live membership, principal status, and profile delegation from
 * the SAME tables resolveEligibleAgents/admitToolCall already trust
 * (cron.ts's assertScheduleStillAuthorized, called at fire time, never at
 * creation time). Deleting or deactivating a schedule never needs to
 * "revoke" anything beyond itself, because the schedule never held
 * authority to begin with -- only the channel membership row does, and that
 * is unaffected by this table.
 *
 * `interval_seconds` (not a cron expression) is a deliberate scope choice:
 * the brief requires "the smallest honest thing", and a cron-expression
 * parser is a new correctness surface with its own bug class (timezone,
 * DST, month-length edge cases) unrelated to the authority question this
 * slice exists to answer. A fixed-interval scheduler is the smallest
 * mechanism that has a wake time with no natural terminator (G1R's
 * defining cron property) and therefore fully exercises every ruling this
 * slice is scoped to prove.
 *
 * `state` follows the same operator-visible STOP discipline as
 * collab_autoreply_stop: 'active' | 'stopped'. A channel-level or
 * global autoreply STOP (collab_autoreply_stop, already shipped) is ALSO
 * consulted at fire time (cron.ts) -- an operator stopping a channel must
 * stop scheduled turns into it too, without requiring a second STOP
 * command per schedule.
 *
 * collab_agent_schedule_runs — THE WAKE RECORD, and the THIRD STATE
 * -----------------------------------------------------------------------
 * One row per fire attempt. `state` extends the collab_agent_turns state
 * machine with exactly one new terminal: 'blocked_awaiting_approval' --
 * G1R B-8's required THIRD, EXPLICITLY DISTINGUISHABLE state for an
 * unattended run whose approval went unanswered. Never bare 'completed',
 * never bare 'failed' (there is no bare 'failed' in this state machine at
 * all, matching collab_agent_turns' own choice of 'terminated' over a
 * generic failure state), and never silently absent. PRIMARY KEY
 * (schedule_id, fire_seq) is the idempotency mechanism, exactly mirroring
 * collab_agent_turns' (channel_id, agent_principal_id, channel_seq).
 */
export const AGENT_CRON_MIGRATION_ID = '20260818_002_agent_cron_v1';

export function runAgentCronMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db
      .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_CRON_MIGRATION_ID);
    if (existing) return;

    db.exec(`
CREATE TABLE IF NOT EXISTS collab_agent_schedules (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  agent_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds >= 60),
  prompt_hint TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','stopped')),
  next_fire_seq INTEGER NOT NULL DEFAULT 0,
  next_fire_at TEXT NOT NULL,
  last_fired_at TEXT,
  -- G2A C-1: CREATE_SCHEDULE.idempotencyKey was validated by the contract,
  -- threaded to the handler, and NEVER USED. A client applying this repo's own
  -- retry-with-the-same-key discipline -- the pattern S3 built for exactly this
  -- purpose -- silently created a SECOND schedule: double fires, double model
  -- calls, possibly double posts, indefinitely, on the one entity whose
  -- mistakes persist and re-fire unattended.
  --
  -- Enforced in the SCHEMA rather than only in handler logic, so a retry cannot
  -- duplicate even if the handler is later refactored. The unique index is
  -- scoped per creating principal, matching runKeyedCommand's
  -- (principal, command, key) shape rather than inventing a new one.
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS collab_agent_schedules_idem
  ON collab_agent_schedules(created_by_principal_id, idempotency_key);

CREATE INDEX IF NOT EXISTS collab_agent_schedules_due
  ON collab_agent_schedules(state, next_fire_at);

CREATE TABLE IF NOT EXISTS collab_agent_schedule_runs (
  schedule_id TEXT NOT NULL REFERENCES collab_agent_schedules(id),
  fire_seq INTEGER NOT NULL CHECK(fire_seq > 0),
  channel_id TEXT NOT NULL,
  agent_principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('dispatched','completed','no_post','terminated','blocked_awaiting_approval')),
  dispatch_request_id TEXT,
  refusal_reason TEXT,
  fired_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(schedule_id, fire_seq)
);

CREATE INDEX IF NOT EXISTS collab_agent_schedule_runs_state_fired
  ON collab_agent_schedule_runs(state, fired_at);
    `);

    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      AGENT_CRON_MIGRATION_ID,
      new Date().toISOString(),
    );
  });

  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Additive, secret-free execution metadata for agent principals.
 *
 * This deliberately remains separate from `principals`: identity and
 * credential lifecycle semantics stay unchanged, while runtime adapters can
 * evolve independently. `provider_account_id` is an opaque account/catalog
 * identifier, never a token, API key, cookie, or vendor credential.
 */
export const AGENT_RUNTIME_PROFILE_MIGRATION_ID = '20260820_001_agent_runtime_profile_v1';
export const AGENT_RUNTIME_EXTERNAL_CONTEXT_MIGRATION_ID = '20260820_002_agent_runtime_external_context_v1';
export const AGENT_RUNTIME_TRUSTED_SUBSCRIPTION_MIGRATION_ID = '20260821_007_agent_runtime_trusted_subscription_v1';
export const AGENT_PERSONA_MIGRATION_ID = '20260821_003_agent_persona_v1';
export const AGENT_PERSONA_REVISION_MIGRATION_ID = '20260821_004_agent_persona_revision_v1';

const FORBIDDEN_PERSONA_CODEPOINTS = [
  ...Array.from({ length: 9 }, (_, index) => index),
  11,
  12,
  ...Array.from({ length: 18 }, (_, index) => index + 14),
  ...Array.from({ length: 33 }, (_, index) => index + 127),
  0x061c,
  0x200e,
  0x200f,
  ...Array.from({ length: 5 }, (_, index) => index + 0x202a),
  ...Array.from({ length: 4 }, (_, index) => index + 0x2066),
];

export function runAgentRuntimeProfileMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db
      .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_RUNTIME_PROFILE_MIGRATION_ID);
    if (existing) return;

    db.exec(`
CREATE TABLE IF NOT EXISTS collab_agent_runtime_profiles (
  agent_principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  provider_account_id TEXT NOT NULL CHECK(length(trim(provider_account_id)) > 0),
  adapter_id TEXT NOT NULL CHECK(length(trim(adapter_id)) > 0),
  model_id TEXT NOT NULL CHECK(length(trim(model_id)) > 0),
  autostart INTEGER NOT NULL DEFAULT 0 CHECK(autostart IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS collab_agent_runtime_profiles_provider
  ON collab_agent_runtime_profiles(provider_account_id, adapter_id);
    `);

    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      AGENT_RUNTIME_PROFILE_MIGRATION_ID,
      new Date().toISOString(),
    );
  });

  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  runAgentRuntimeExternalContextMigration(db);
  runAgentRuntimeTrustedSubscriptionMigration(db);
  runAgentPersonaMigration(db);
  runAgentPersonaRevisionMigration(db);
}

export function runAgentPersonaMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db
      .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_PERSONA_MIGRATION_ID);
    if (existing) return;

    db.exec(`
CREATE TABLE IF NOT EXISTS collab_agent_personas (
  agent_principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  icon_id TEXT NOT NULL DEFAULT 'robot'
    CHECK(icon_id IN ('robot','brain','shield','search','code','spark','bolt','target')),
  system_directives TEXT NOT NULL DEFAULT ''
    CHECK(length(system_directives) <= 4000 AND instr(system_directives, char(0)) = 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
    `);

    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      AGENT_PERSONA_MIGRATION_ID,
      new Date().toISOString(),
    );
  });

  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function runAgentPersonaRevisionMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db
      .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_PERSONA_REVISION_MIGRATION_ID);
    if (existing) return;

    const columns = new Set(
      (db.prepare('PRAGMA table_info(collab_agent_personas)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has('revision')) {
      db.exec(`ALTER TABLE collab_agent_personas
        ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)`);
    }

    const forbiddenClause = FORBIDDEN_PERSONA_CODEPOINTS
      .map((codepoint) => `instr(NEW.system_directives, char(${codepoint})) > 0`)
      .join(' OR ');
    db.exec(`
CREATE TRIGGER IF NOT EXISTS collab_agent_personas_directives_insert_guard
BEFORE INSERT ON collab_agent_personas
WHEN ${forbiddenClause}
BEGIN
  SELECT RAISE(ABORT, 'system directives contain forbidden control characters');
END;

CREATE TRIGGER IF NOT EXISTS collab_agent_personas_directives_update_guard
BEFORE UPDATE OF system_directives ON collab_agent_personas
WHEN ${forbiddenClause}
BEGIN
  SELECT RAISE(ABORT, 'system directives contain forbidden control characters');
END;
    `);

    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      AGENT_PERSONA_REVISION_MIGRATION_ID,
      new Date().toISOString(),
    );
  });

  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Adds an explicit, provider/model-bound acknowledgement for external model
 * context export. False is the durable default. The companion provider/model
 * columns prevent a prior acknowledgement from silently surviving a runtime
 * selection change.
 */
export function runAgentRuntimeExternalContextMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db
      .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_RUNTIME_EXTERNAL_CONTEXT_MIGRATION_ID);
    if (existing) return;

    const columns = new Set(
      (db.prepare('PRAGMA table_info(collab_agent_runtime_profiles)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has('external_context_confirmed')) {
      db.exec(`ALTER TABLE collab_agent_runtime_profiles
        ADD COLUMN external_context_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK(external_context_confirmed IN (0,1))`);
    }
    if (!columns.has('external_context_provider_account_id')) {
      db.exec('ALTER TABLE collab_agent_runtime_profiles ADD COLUMN external_context_provider_account_id TEXT');
    }
    if (!columns.has('external_context_model_id')) {
      db.exec('ALTER TABLE collab_agent_runtime_profiles ADD COLUMN external_context_model_id TEXT');
    }

    db.exec(`
CREATE TRIGGER IF NOT EXISTS collab_agent_runtime_external_context_insert
BEFORE INSERT ON collab_agent_runtime_profiles
WHEN
  (NEW.external_context_confirmed = 0 AND
    (NEW.external_context_provider_account_id IS NOT NULL OR NEW.external_context_model_id IS NOT NULL))
  OR
  (NEW.external_context_confirmed = 1 AND
    (NEW.external_context_provider_account_id IS NULL OR NEW.external_context_model_id IS NULL
      OR NEW.external_context_provider_account_id <> NEW.provider_account_id
      OR NEW.external_context_model_id <> NEW.model_id))
BEGIN
  SELECT RAISE(ABORT, 'external context acknowledgement must match provider and model');
END;

CREATE TRIGGER IF NOT EXISTS collab_agent_runtime_external_context_update
BEFORE UPDATE ON collab_agent_runtime_profiles
WHEN
  (NEW.external_context_confirmed = 0 AND
    (NEW.external_context_provider_account_id IS NOT NULL OR NEW.external_context_model_id IS NOT NULL))
  OR
  (NEW.external_context_confirmed = 1 AND
    (NEW.external_context_provider_account_id IS NULL OR NEW.external_context_model_id IS NULL
      OR NEW.external_context_provider_account_id <> NEW.provider_account_id
      OR NEW.external_context_model_id <> NEW.model_id))
BEGIN
  SELECT RAISE(ABORT, 'external context acknowledgement must match provider and model');
END;
    `);

    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      AGENT_RUNTIME_EXTERNAL_CONTEXT_MIGRATION_ID,
      new Date().toISOString(),
    );
  });

  try {
    db.exec('BEGIN EXCLUSIVE');
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Upgrades external-context acknowledgement to an exact immutable runtime and
 * persona binding. Every pre-existing acknowledgement is deliberately reset;
 * an old provider/model checkbox cannot authorize the default-on executor.
 */
export function runAgentRuntimeTrustedSubscriptionMigration(db: Database.Database): void {
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_RUNTIME_TRUSTED_SUBSCRIPTION_MIGRATION_ID);
    if (existing) return;
    const columns = new Set(
      (db.prepare('PRAGMA table_info(collab_agent_runtime_profiles)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has('external_context_runtime_fingerprint')) {
      db.exec('ALTER TABLE collab_agent_runtime_profiles ADD COLUMN external_context_runtime_fingerprint TEXT');
    }
    if (!columns.has('external_context_exact_model_id')) {
      db.exec('ALTER TABLE collab_agent_runtime_profiles ADD COLUMN external_context_exact_model_id TEXT');
    }
    if (!columns.has('external_context_persona_revision')) {
      db.exec('ALTER TABLE collab_agent_runtime_profiles ADD COLUMN external_context_persona_revision INTEGER');
    }
    if (!columns.has('external_context_persona_content_sha256')) {
      db.exec('ALTER TABLE collab_agent_runtime_profiles ADD COLUMN external_context_persona_content_sha256 TEXT');
    }
    db.exec(`
UPDATE collab_agent_runtime_profiles
   SET external_context_confirmed = 0,
       external_context_provider_account_id = NULL,
       external_context_model_id = NULL,
       external_context_runtime_fingerprint = NULL,
       external_context_exact_model_id = NULL,
       external_context_persona_revision = NULL,
       external_context_persona_content_sha256 = NULL;
DROP TRIGGER IF EXISTS collab_agent_runtime_external_context_insert;
DROP TRIGGER IF EXISTS collab_agent_runtime_external_context_update;
CREATE TRIGGER collab_agent_runtime_external_context_insert
BEFORE INSERT ON collab_agent_runtime_profiles
WHEN (NEW.external_context_confirmed = 0 AND (NEW.external_context_provider_account_id IS NOT NULL
  OR NEW.external_context_model_id IS NOT NULL OR NEW.external_context_runtime_fingerprint IS NOT NULL
  OR NEW.external_context_exact_model_id IS NOT NULL OR NEW.external_context_persona_revision IS NOT NULL
  OR NEW.external_context_persona_content_sha256 IS NOT NULL))
OR (NEW.external_context_confirmed = 1 AND (NEW.external_context_provider_account_id <> NEW.provider_account_id
  OR NEW.external_context_model_id <> NEW.model_id OR NEW.external_context_exact_model_id <> NEW.model_id
  OR length(NEW.external_context_runtime_fingerprint) <> 64
  OR NEW.external_context_persona_revision IS NULL OR NEW.external_context_persona_revision < 0
  OR length(NEW.external_context_persona_content_sha256) <> 64))
BEGIN SELECT RAISE(ABORT, 'external context consent binding is incomplete'); END;
CREATE TRIGGER collab_agent_runtime_external_context_update
BEFORE UPDATE ON collab_agent_runtime_profiles
WHEN (NEW.external_context_confirmed = 0 AND (NEW.external_context_provider_account_id IS NOT NULL
  OR NEW.external_context_model_id IS NOT NULL OR NEW.external_context_runtime_fingerprint IS NOT NULL
  OR NEW.external_context_exact_model_id IS NOT NULL OR NEW.external_context_persona_revision IS NOT NULL
  OR NEW.external_context_persona_content_sha256 IS NOT NULL))
OR (NEW.external_context_confirmed = 1 AND (NEW.external_context_provider_account_id <> NEW.provider_account_id
  OR NEW.external_context_model_id <> NEW.model_id OR NEW.external_context_exact_model_id <> NEW.model_id
  OR length(NEW.external_context_runtime_fingerprint) <> 64
  OR NEW.external_context_persona_revision IS NULL OR NEW.external_context_persona_revision < 0
  OR length(NEW.external_context_persona_content_sha256) <> 64))
BEGIN SELECT RAISE(ABORT, 'external context consent binding is incomplete'); END;
    `);
    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      AGENT_RUNTIME_TRUSTED_SUBSCRIPTION_MIGRATION_ID,
      new Date().toISOString(),
    );
  });
  db.exec('BEGIN EXCLUSIVE');
  try {
    transaction();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
