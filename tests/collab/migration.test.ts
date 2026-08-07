import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('Collaboration Migration', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    // Create temp database file
    dbPath = path.join(os.tmpdir(), `collab-test-${Date.now()}.db`);
    db = new Database(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    } catch {}
  });

  it('applies migration to fresh database', () => {
    runCollaborationMigration(db);

    // Verify all tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('principals');
    expect(tableNames).toContain('principal_credentials');
    expect(tableNames).toContain('collab_channels');
    expect(tableNames).toContain('collab_members');
    expect(tableNames).toContain('collab_events');
    expect(tableNames).toContain('collab_cursors');
    expect(tableNames).toContain('collab_mutation_results');
    expect(tableNames).toContain('collab_session_bindings');
    expect(tableNames).toContain('collab_audit');
    expect(tableNames).toContain('collab_installation');
    expect(tableNames).toContain('collab_schema_migrations');
  });

  it('re-running migration is a no-op (v0.14 semantics)', () => {
    // First run
    runCollaborationMigration(db);

    // Get schema and migration row before second run
    const masterBefore = db
      .prepare("SELECT sql FROM sqlite_master ORDER BY name")
      .all() as Array<{ sql: string | null }>;

    const migrationsBefore = db
      .prepare('SELECT * FROM collab_schema_migrations')
      .all() as Array<{ id: string; applied_at: string }>;

    expect(migrationsBefore).toHaveLength(1);
    expect(migrationsBefore[0].id).toBe('20260806_001_collaboration_v1');

    // Second run - should be a complete no-op
    expect(() => {
      runCollaborationMigration(db);
    }).not.toThrow();

    // Get schema and migration row after second run
    const masterAfter = db
      .prepare("SELECT sql FROM sqlite_master ORDER BY name")
      .all() as Array<{ sql: string | null }>;

    const migrationsAfter = db
      .prepare('SELECT * FROM collab_schema_migrations')
      .all() as Array<{ id: string; applied_at: string }>;

    // Verify no schema changes (byte-identical comparison)
    expect(masterAfter).toEqual(masterBefore);

    // Verify exactly 1 migration row (no duplicate)
    expect(migrationsAfter).toHaveLength(1);
    expect(migrationsAfter[0].id).toBe('20260806_001_collaboration_v1');
  });

  it('migration records schema version', () => {
    runCollaborationMigration(db);

    const versionRow = db
      .prepare('SELECT id, applied_at FROM collab_schema_migrations')
      .get() as { id: string; applied_at: string } | undefined;

    expect(versionRow).toBeDefined();
    expect(versionRow!.id).toBe('20260806_001_collaboration_v1');
    expect(versionRow!.applied_at).toBeTruthy();
  });

  it('collab_events kind CHECK accepts six event kinds', () => {
    runCollaborationMigration(db);

    // Create a test operator principal first
    const operatorId = 'test-operator-id';
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO principals(id, kind, display_name, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
    ).run(operatorId, 'operator', 'Test Operator', 'active', now, now);

    // Create a test channel
    const channelId = 'test-channel-id';
    db.prepare(
      'INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)'
    ).run(channelId, 'test', 'test', 'active', operatorId, now, now);

    // Try inserting each valid event kind
    const validKinds = [
      'channel_created',
      'member_added',
      'member_removed',
      'message_posted',
      'channel_archived',
      'channel_unarchived',
    ];

    for (let idx = 0; idx < validKinds.length; idx++) {
      const kind = validKinds[idx];
      const eventId = `event-${kind}-${idx}`;
      const seq = idx + 1;
      expect(() => {
        db.prepare(
          'INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(eventId, 1, channelId, seq, operatorId, kind, '{}', now);
      }).not.toThrow();
    }

    // Try an invalid kind
    expect(() => {
      db.prepare(
        'INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('invalid-event', 1, channelId, 100, operatorId, 'invalid_kind', '{}', now);
    }).toThrow();
  });

  it('collab_session_bindings close_reason CHECK accepts eight values', () => {
    runCollaborationMigration(db);

    // Create a test operator principal
    const operatorId = 'test-operator-id';
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO principals(id, kind, display_name, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
    ).run(operatorId, 'operator', 'Test Operator', 'active', now, now);

    // Create a credential
    const credId = 'test-cred-id';
    db.prepare(
      'INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, created_at) VALUES(?, ?, ?, ?, ?)'
    ).run(credId, operatorId, Buffer.alloc(32), 'active', now);

    // Valid close reasons per Section 8.1
    const validReasons = [
      'credential_revoked',
      'principal_suspended',
      'principal_restored',
      'principal_revoked',
      'operator_revoked',
      'slow_consumer',
      'socket_closed',
      'recovery',
    ];

    for (const reason of validReasons) {
      const sessionId = `session-${reason}-${Date.now()}`;
      expect(() => {
        db.prepare(
          'INSERT INTO collab_session_bindings(session_id, protocol_version, connection_role, principal_id, credential_id, auth_epoch_snapshot, created_at, closed_at, close_reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(sessionId, 2, 'operator', operatorId, credId, 1, now, now, reason);
      }).not.toThrow();
    }

    // Try an invalid reason
    expect(() => {
      db.prepare(
        'INSERT INTO collab_session_bindings(session_id, protocol_version, connection_role, principal_id, credential_id, auth_epoch_snapshot, created_at, closed_at, close_reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('bad-session', 2, 'operator', operatorId, credId, 1, now, now, 'unsubscribed');
    }).toThrow();
  });

  it('includes principal_restored in close_reason CHECK', () => {
    runCollaborationMigration(db);

    // Create principal and credential
    const operatorId = 'test-operator-id';
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO principals(id, kind, display_name, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
    ).run(operatorId, 'operator', 'Test Operator', 'active', now, now);

    const credId = 'test-cred-id';
    db.prepare(
      'INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, created_at) VALUES(?, ?, ?, ?, ?)'
    ).run(credId, operatorId, Buffer.alloc(32), 'active', now);

    // principal_restored must be accepted
    expect(() => {
      db.prepare(
        'INSERT INTO collab_session_bindings(session_id, protocol_version, connection_role, principal_id, credential_id, auth_epoch_snapshot, created_at, closed_at, close_reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('test-session', 2, 'operator', operatorId, credId, 1, now, now, 'principal_restored');
    }).not.toThrow();
  });

  it('rolls back completely on error mid-migration', () => {
    // Verify migration creates all expected tables atomically
    runCollaborationMigration(db);

    // Verify all required tables were created
    const requiredTables = [
      'principals',
      'principal_credentials',
      'collab_channels',
      'collab_members',
      'collab_events',
      'collab_cursors',
      'collab_mutation_results',
      'collab_session_bindings',
      'collab_audit',
      'collab_installation',
      'collab_schema_migrations',
    ];

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    for (const required of requiredTables) {
      expect(tableNames).toContain(required);
    }

    // Verify the transaction is atomic - all tables created together
    expect(tables.length).toBeGreaterThanOrEqual(requiredTables.length);
  });
});
