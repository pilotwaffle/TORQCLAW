import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { runCollaborationMigration } from '../packages/collab/src/migration.js';
import { runSurfaceIdentityMigration } from '../packages/collab/src/surfaces.js';
import {
  COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM,
  COLLAB_AUTH_IDENTITY_MIGRATION_ID,
  runCollabAuthIdentityMigration,
  SURFACES_P2A_SQL,
} from '../packages/collab/src/authIdentityMigration.js';
import { COLLAB_AUTH_IDENTITY_MIGRATION_SQL } from '../packages/collab/src/authIdentityConstants.js';
import { ensureSurfaceSecuritySchema } from '../packages/gateway/src/surfaceSecurity.js';
import {
  GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM,
  GATEWAY_AUTH_IDENTITY_MIGRATION_ID,
  GATEWAY_AUTH_IDENTITY_MIGRATION_SQL,
  AUTH_PHASE2A_GOLDEN_VECTORS,
  COLLAB_AUTH_IDENTITY_PROGRAM_UTF8_HEX,
  GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR,
  phase2aMigrationChecksum,
  serializeAuthPhase2AProgram,
  runGatewayAuthIdentityMigration,
  SECURITY_P2A_SQL,
} from '../packages/gateway/src/authIdentityMigration.js';
import { runAuthFoundationMigration, readAuthRuntimeMarker } from '../packages/gateway/src/authRuntimeMarker.js';
import { COLLAB_AUTH_IDENTITY_STEP_MANIFEST } from '../packages/collab/src/authIdentityConstants.js';
import { GATEWAY_AUTH_IDENTITY_STEP_MANIFEST } from '../packages/gateway/src/authPhase2AConstants.js';
import {
  captureCollabAuthSnapshot,
  captureStateAuthSnapshot,
  buildAuthReconciliationDiagnostic,
  runAuthReconciliationDiagnostic,
  writeAuthReconciliationDiagnostic,
} from '../packages/gateway/src/authReconciliationDiagnostic.js';

const sha = phase2aMigrationChecksum;
const root = join(import.meta.dirname, '..');

function collab(): Database.Database {
  const db = new Database(':memory:');
  runCollaborationMigration(db);
  runSurfaceIdentityMigration(db);
  return db;
}

function state(): Database.Database {
  const db = new Database(':memory:');
  runAuthFoundationMigration(db);
  ensureSurfaceSecuritySchema(db);
  return db;
}

function seedCollabSurface(db: Database.Database, klass = 'none', revision: unknown = 1): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO principals(id,kind,display_name,status,auth_epoch,created_at,updated_at) VALUES ('p','operator','P','active',1,?,?)").run(now, now);
  db.prepare("INSERT INTO surfaces(surface_id,principal_id,surface_kind,surface_role,state,connection_class,connection_class_revision) VALUES ('s','p','desktop','operator','active',?,?)").run(klass, revision);
}

describe('AUTH-005 Phase 2A inert migration and diagnostic slice', () => {
  it('pins both canonical checksum vectors and excludes receipts from program bytes', () => {
    expect(COLLAB_AUTH_IDENTITY_MIGRATION_SQL).not.toMatch(/INSERT INTO/i);
    expect(GATEWAY_AUTH_IDENTITY_MIGRATION_SQL).not.toMatch(/INSERT INTO/i);
    expect(COLLAB_AUTH_IDENTITY_MIGRATION_SQL).toBe(COLLAB_AUTH_IDENTITY_STEP_MANIFEST.filter((step) => step.kind === 'ddl').map((step) => step.payload).join('\n'));
    expect(GATEWAY_AUTH_IDENTITY_MIGRATION_SQL).toBe(GATEWAY_AUTH_IDENTITY_STEP_MANIFEST.filter((step) => step.kind === 'ddl').map((step) => step.payload).join('\n'));
    expect(sha(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(COLLAB_AUTH_IDENTITY_STEP_MANIFEST))).toBe(COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM);
    expect(sha(GATEWAY_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(GATEWAY_AUTH_IDENTITY_STEP_MANIFEST))).toBe(GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM);
    expect(COLLAB_AUTH_IDENTITY_MIGRATION_SQL).not.toMatch(/INSERT INTO/i);
    expect(GATEWAY_AUTH_IDENTITY_MIGRATION_SQL).not.toMatch(/INSERT INTO/i);
    expect(AUTH_PHASE2A_GOLDEN_VECTORS.map((vector) => vector.id)).toEqual([COLLAB_AUTH_IDENTITY_MIGRATION_ID, GATEWAY_AUTH_IDENTITY_MIGRATION_ID]);
    expect(Buffer.from(COLLAB_AUTH_IDENTITY_PROGRAM_UTF8_HEX, 'hex').toString('utf8')).toBe(serializeAuthPhase2AProgram(COLLAB_AUTH_IDENTITY_STEP_MANIFEST));
    const gatewayProgram = serializeAuthPhase2AProgram(GATEWAY_AUTH_IDENTITY_STEP_MANIFEST);
    expect(Buffer.from(GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR.programUtf8Hex, 'hex').toString('utf8')).toBe(gatewayProgram);
    expect(sha(GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR.id, gatewayProgram)).toBe(GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR.sha256Hex);
    expect(GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR.programUtf8Hex).not.toBe(Buffer.from('gateway-live-manifest', 'utf8').toString('hex'));
  });

  it('applies exact additive schemas, accepts the second marker ledger set, and is idempotent', () => {
    const c = collab();
    expect(runCollabAuthIdentityMigration(c)).toBe('migrated');
    expect(runCollabAuthIdentityMigration(c)).toBe('noop');
    expect(c.prepare("SELECT id,checksum_sha256 FROM collab_auth_schema_migrations").all()).toEqual([{ id: COLLAB_AUTH_IDENTITY_MIGRATION_ID, checksum_sha256: COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM }]);
    expect(c.prepare("PRAGMA table_info(surfaces)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'connection_class', type: 'TEXT', notnull: 1, dflt_value: "'none'" }),
      expect.objectContaining({ name: 'connection_class_revision', type: 'INTEGER', notnull: 1, dflt_value: '1' }),
    ]));
    expect(c.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='surfaces'").get()).toEqual({ sql: SURFACES_P2A_SQL });

    const s = state();
    expect(runGatewayAuthIdentityMigration(s)).toBe('migrated');
    expect(readAuthRuntimeMarker(s)).toEqual({ state: 'v1' });
    expect(runGatewayAuthIdentityMigration(s)).toBe('noop');
    expect(s.prepare("SELECT id,checksum_sha256 FROM gateway_schema_migrations ORDER BY id").all()).toHaveLength(2);
    expect(s.prepare("PRAGMA table_info(gateway_surface_security)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'connection_class', type: 'TEXT', notnull: 1, dflt_value: "'none'" }),
      expect.objectContaining({ name: 'connection_class_revision', type: 'INTEGER', notnull: 1, dflt_value: '1' }),
    ]));
    expect(s.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='gateway_surface_security'").get()).toEqual({ sql: SECURITY_P2A_SQL });
    c.close(); s.close();
  });

  it('preserves representative legacy/current-base rows, rowids, and every pre-existing value while applying exact defaults', () => {
    const c = collab();
    const now = '2026-08-13T00:00:00.000Z';
    c.prepare("INSERT INTO principals(id,kind,display_name,status,auth_epoch,created_at,updated_at) VALUES ('legacy-p','operator','Legacy','active',7,?,?)").run(now, now);
    c.prepare("INSERT INTO surfaces(surface_id,principal_id,surface_kind,surface_role,display_name,capability_json,state,created_at,revoked_at,last_seen_at) VALUES ('legacy-s','legacy-p','desktop','operator','Legacy Surface','[\\\"read\\\"]','active',?,?,?)").run(now, null, now);
    const collabBefore = {
      principals: c.prepare('SELECT rowid,id,kind,display_name,owner_principal_id,status,auth_epoch,revoked_at,created_at,updated_at FROM principals').all(),
      surfaces: c.prepare('SELECT rowid,surface_id,principal_id,surface_kind,surface_role,display_name,capability_json,state,created_at,revoked_at,last_seen_at FROM surfaces').all(),
      ledger: c.prepare('SELECT rowid,id,applied_at FROM collab_schema_migrations ORDER BY rowid').all(),
    };
    expect(runCollabAuthIdentityMigration(c)).toBe('migrated');
    expect(c.prepare('SELECT rowid,id,kind,display_name,owner_principal_id,status,auth_epoch,revoked_at,created_at,updated_at FROM principals').all()).toEqual(collabBefore.principals);
    expect(c.prepare('SELECT rowid,surface_id,principal_id,surface_kind,surface_role,display_name,capability_json,state,created_at,revoked_at,last_seen_at FROM surfaces').all()).toEqual(collabBefore.surfaces);
    expect(c.prepare('SELECT rowid,id,applied_at FROM collab_schema_migrations ORDER BY rowid').all()).toEqual(collabBefore.ledger);
    expect(c.prepare("SELECT connection_class,connection_class_revision FROM surfaces WHERE surface_id='legacy-s'").get()).toEqual({ connection_class: 'none', connection_class_revision: 1 });

    const s = state();
    s.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,allowed_capability_classes_json,allowed_operation_ids_json,capability_revision,source_identity_revision,activated_at,revoked_at) VALUES ('legacy-s','legacy-p','desktop','operator','active',7,'[\\\"read\\\"]','[\\\"op\\\"]',9,'legacy-r',?,NULL)").run(now);
    const stateBefore = s.prepare('SELECT rowid,surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,allowed_capability_classes_json,allowed_operation_ids_json,capability_revision,source_identity_revision,activated_at,revoked_at FROM gateway_surface_security').all();
    expect(runGatewayAuthIdentityMigration(s)).toBe('migrated');
    expect(s.prepare('SELECT rowid,surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,allowed_capability_classes_json,allowed_operation_ids_json,capability_revision,source_identity_revision,activated_at,revoked_at FROM gateway_surface_security').all()).toEqual(stateBefore);
    expect(s.prepare("SELECT connection_class,connection_class_revision FROM gateway_surface_security WHERE surface_id='legacy-s'").get()).toEqual({ connection_class: 'none', connection_class_revision: 1 });
    c.close(); s.close();
  });

  it('rolls back every collab and state DDL/receipt boundary, then reruns cleanly', () => {
    for (const boundary of COLLAB_AUTH_IDENTITY_STEP_MANIFEST.map((_, index) => index + 1)) {
      const c = collab();
      const trace: string[] = [];
      expect(() => runCollabAuthIdentityMigration(c, { failAfterStatement: boundary, trace })).toThrow();
      expect(trace).toEqual(COLLAB_AUTH_IDENTITY_STEP_MANIFEST.slice(0, boundary).map((step) => step.name));
      expect(c.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='collab_auth_schema_migrations'").get()).toEqual({ n: 0 });
      expect(c.prepare('PRAGMA table_info(surfaces)').all()).not.toContainEqual(expect.objectContaining({ name: 'connection_class' }));
      const cleanTrace: string[] = [];
      expect(runCollabAuthIdentityMigration(c, { trace: cleanTrace })).toBe('migrated');
      expect(cleanTrace).toEqual(COLLAB_AUTH_IDENTITY_STEP_MANIFEST.map((step) => step.name));
      c.close();
    }
    for (const boundary of GATEWAY_AUTH_IDENTITY_STEP_MANIFEST.map((_, index) => index + 1)) {
      const s = state();
      const trace: string[] = [];
      expect(() => runGatewayAuthIdentityMigration(s, { failAfterStatement: boundary, trace })).toThrow();
      expect(trace).toEqual(GATEWAY_AUTH_IDENTITY_STEP_MANIFEST.slice(0, boundary).map((step) => step.name));
      expect(s.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='auth_reconciliation_diagnostics'").get()).toEqual({ n: 0 });
      expect(s.prepare('PRAGMA table_info(gateway_surface_security)').all()).not.toContainEqual(expect.objectContaining({ name: 'connection_class' }));
      const cleanTrace: string[] = [];
      expect(runGatewayAuthIdentityMigration(s, { trace: cleanTrace })).toBe('migrated');
      expect(cleanTrace).toEqual(GATEWAY_AUTH_IDENTITY_STEP_MANIFEST.map((step) => step.name));
      s.close();
    }
  });

  it('uses length-prefixed binary tuple hashing and records mismatch as non-authoritative evidence', () => {
    const c = collab();
    runCollabAuthIdentityMigration(c);
    seedCollabSurface(c, 'browser_bff');
    const s = state();
    runGatewayAuthIdentityMigration(s);
    s.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES ('s','p','desktop','operator','active',1,1,'x','browser_bff',1)").run();
    const first = captureCollabAuthSnapshot(c);
    const second = captureStateAuthSnapshot(s);
    expect(first.tupleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.tupleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tupleHash).toBe(second.tupleHash);
    s.prepare("UPDATE gateway_surface_security SET connection_class_revision=2 WHERE surface_id='s'").run();
    const diagnostic = runAuthReconciliationDiagnostic(c, s, { diagnosticId: '11111111-1111-4111-8111-111111111111', now: new Date('2026-08-13T00:00:00.000Z') });
    expect(diagnostic.status).toBe('MISMATCH');
    expect(diagnostic.non_authoritative).toBe(1);
    expect(s.prepare('SELECT non_authoritative,status,detail_code FROM auth_reconciliation_diagnostics').get()).toEqual({ non_authoritative: 1, status: 'MISMATCH', detail_code: 'HASH_MISMATCH' });
    c.close(); s.close();
  });

  it('marks invalid non-none mappings INVALID and excludes fixture operators outside the test helper', () => {
    const c = collab();
    runCollabAuthIdentityMigration(c);
    seedCollabSurface(c, 'browser_bff');
    c.prepare("UPDATE surfaces SET surface_kind='http',surface_role='agent' WHERE surface_id='s'").run();
    const s = state();
    runGatewayAuthIdentityMigration(s);
    s.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES ('s','p','http','agent','active',1,1,'x','browser_bff',1)").run();
    const diagnostic = runAuthReconciliationDiagnostic(c, s, { diagnosticId: '22222222-2222-4222-8222-222222222222', now: new Date('2026-08-13T00:00:00.000Z') });
    expect(diagnostic.status).toBe('INVALID');
    expect(diagnostic.detail_code).toBe('INVALID_CLASS_MAPPING');
    c.prepare("UPDATE surfaces SET connection_class='fixture_operator',surface_kind='desktop',surface_role='operator' WHERE surface_id='s'").run();
    s.prepare("UPDATE gateway_surface_security SET connection_class='fixture_operator',surface_kind='desktop',surface_role='operator' WHERE surface_id='s'").run();
    const fixtureCollab = captureCollabAuthSnapshot(c);
    const fixtureState = captureStateAuthSnapshot(s);
    expect(fixtureCollab.eligibleCount).toBe(0);
    expect(fixtureState.eligibleCount).toBe(0);
    expect(fixtureCollab.tupleHash).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
    expect(fixtureState.tupleHash).toBe(fixtureCollab.tupleHash);
    const fixtureDiagnostic = runAuthReconciliationDiagnostic(c, s, { diagnosticId: '99999999-9999-4999-8999-999999999999', now: new Date('2026-08-13T00:00:00.000Z') });
    expect(fixtureDiagnostic.detail_code).toBe('FIXTURE_OPERATOR_EXCLUDED');
    c.prepare("UPDATE surfaces SET connection_class='diagnostic',surface_kind='automation',surface_role='agent' WHERE surface_id='s'").run();
    s.prepare("UPDATE gateway_surface_security SET connection_class='diagnostic',surface_kind='automation',surface_role='agent' WHERE surface_id='s'").run();
    const automationKind = runAuthReconciliationDiagnostic(c, s, { diagnosticId: '55555555-5555-4555-8555-555555555555', now: new Date('2026-08-13T00:00:00.000Z') });
    expect(automationKind.status).toBe('INVALID');
    expect(automationKind.detail_code).toBe('AUTOMATION_EXCLUDED');
    c.prepare("UPDATE surfaces SET surface_kind='desktop',surface_role='automation' WHERE surface_id='s'").run();
    s.prepare("UPDATE gateway_surface_security SET surface_kind='desktop',surface_role='automation' WHERE surface_id='s'").run();
    const automationRole = runAuthReconciliationDiagnostic(c, s, { diagnosticId: '66666666-6666-4666-8666-666666666666', now: new Date('2026-08-13T00:00:00.000Z') });
    expect(automationRole.status).toBe('INVALID');
    expect(automationRole.detail_code).toBe('AUTOMATION_EXCLUDED');

    c.close(); s.close();
  });

  it('unconditionally excludes fixture operators with malformed revisions on both snapshot paths', () => {
    const revisions: Array<[string, unknown]> = [
      ['INTEGER', 1],
      ['TEXT', '2x'],
      ['REAL', 2.5],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
      ['out-of-range REAL', Number.MAX_VALUE],
    ];
    for (const [label, revision] of revisions) {
      const c = collab();
      runCollabAuthIdentityMigration(c);
      seedCollabSurface(c, 'fixture_operator', revision);
      const s = state();
      runGatewayAuthIdentityMigration(s);
      s.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES ('s','p','desktop','operator','active',1,1,'x','fixture_operator',?)").run(revision);

      const collabSnapshot = captureCollabAuthSnapshot(c);
      const stateSnapshot = captureStateAuthSnapshot(s);
      for (const [surface, snapshot] of [['collab', collabSnapshot], ['state', stateSnapshot]] as const) {
        expect(snapshot, label + '/' + surface).toMatchObject({
          invalid: false,
          eligibleCount: 0,
          detail: 'FIXTURE_OPERATOR_EXCLUDED',
        });
        expect(snapshot.tupleHash, label + '/' + surface).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
      }
      const diagnostic = buildAuthReconciliationDiagnostic(collabSnapshot, stateSnapshot, {
        diagnosticId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        now: new Date('2026-08-13T00:00:00.000Z'),
      });
      expect(diagnostic).toMatchObject({ status: 'MATCH', detail_code: 'FIXTURE_OPERATOR_EXCLUDED', non_authoritative: 1 });
      c.close();
      s.close();
    }
    // Probe NULL too; current additive schemas declare this column NOT NULL,
    // but retain the behavioral assertion if a future probe permits it.
    const nullCollab = collab();
    runCollabAuthIdentityMigration(nullCollab);
    seedCollabSurface(nullCollab, 'fixture_operator', 1);
    let collabNullPermitted = true;
    try { nullCollab.prepare("UPDATE surfaces SET connection_class_revision=NULL WHERE surface_id='s'").run(); } catch { collabNullPermitted = false; }
    if (collabNullPermitted) expect(captureCollabAuthSnapshot(nullCollab)).toMatchObject({ invalid: false, eligibleCount: 0, detail: 'FIXTURE_OPERATOR_EXCLUDED' });
    nullCollab.close();

    const nullState = state();
    runGatewayAuthIdentityMigration(nullState);
    nullState.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES ('s','p','desktop','operator','active',1,1,'x','fixture_operator',1)").run();
    let stateNullPermitted = true;
    try { nullState.prepare("UPDATE gateway_surface_security SET connection_class_revision=NULL WHERE surface_id='s'").run(); } catch { stateNullPermitted = false; }
    if (stateNullPermitted) expect(captureStateAuthSnapshot(nullState)).toMatchObject({ invalid: false, eligibleCount: 0, detail: 'FIXTURE_OPERATOR_EXCLUDED' });
    nullState.close();
  });

  it('keeps mixed production hashes and diagnostic status/detail stable as fixture revisions mutate', () => {
    const c = collab();
    runCollabAuthIdentityMigration(c);
    seedCollabSurface(c, 'browser_bff', 1);
    c.prepare("INSERT INTO surfaces(surface_id,principal_id,surface_kind,surface_role,state,connection_class,connection_class_revision) VALUES ('fixture-s','p','desktop','operator','active','fixture_operator',1)").run();

    const s = state();
    runGatewayAuthIdentityMigration(s);
    s.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES ('s','p','desktop','operator','active',1,1,'x','browser_bff',1)").run();
    s.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES ('fixture-s','p','desktop','operator','active',1,1,'fixture-identity','fixture_operator',1)").run();

    const fixtureRevisions: unknown[] = [1, '2x', 2.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE];
    let baseline: { collabHash: string; stateHash: string; status: string; detail: string } | undefined;
    for (const revision of fixtureRevisions) {
      c.prepare("UPDATE surfaces SET connection_class_revision=? WHERE surface_id='fixture-s'").run(revision);
      s.prepare("UPDATE gateway_surface_security SET connection_class_revision=? WHERE surface_id='fixture-s'").run(revision);
      const collabSnapshot = captureCollabAuthSnapshot(c);
      const stateSnapshot = captureStateAuthSnapshot(s);
      const diagnostic = buildAuthReconciliationDiagnostic(collabSnapshot, stateSnapshot, {
        diagnosticId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        now: new Date('2026-08-13T00:00:00.000Z'),
      });
      expect(collabSnapshot).toMatchObject({ invalid: false, eligibleCount: 1, detail: 'FIXTURE_OPERATOR_EXCLUDED' });
      expect(stateSnapshot).toMatchObject({ invalid: false, eligibleCount: 1, detail: 'FIXTURE_OPERATOR_EXCLUDED' });
      const current = {
        collabHash: collabSnapshot.tupleHash,
        stateHash: stateSnapshot.tupleHash,
        status: diagnostic.status,
        detail: diagnostic.detail_code,
      };
      if (!baseline) baseline = current;
      expect(current).toEqual(baseline);
    }
    c.close();
    s.close();
  });

  it('covers the complete origin-auth-class × surface-kind × requested-role eligibility matrix', () => {
    const kinds = ['desktop', 'mobile', 'http', 'telegram', 'slack', 'automation'] as const;
    const roles = ['operator', 'agent', 'automation'] as const;
    const classes = ['browser_bff', 'channel_dedicated', 'agent_node', 'diagnostic', 'benchmark_submit', 'acceptance_submit', 'none', 'fixture_operator'] as const;
    const schemaCompatible = (kind: string, role: string) => !(['telegram', 'slack', 'automation'].includes(kind) && role === 'operator');
    const expected = (klass: string, kind: string, role: string) => {
      if (klass === 'none' || klass === 'fixture_operator') return { eligible: false, invalid: false };
      if (klass === 'browser_bff') return { eligible: ['desktop', 'mobile'].includes(kind) && role === 'operator', invalid: !(['desktop', 'mobile'].includes(kind) && role === 'operator') };
      if (['channel_dedicated', 'benchmark_submit', 'acceptance_submit'].includes(klass)) return { eligible: kind === 'http' && role === 'agent', invalid: !(kind === 'http' && role === 'agent') };
      if (klass === 'agent_node') return { eligible: ['desktop', 'mobile', 'http'].includes(kind) && role === 'agent', invalid: !(['desktop', 'mobile', 'http'].includes(kind) && role === 'agent') };
      return { eligible: kind !== 'automation' && role !== 'automation', invalid: kind === 'automation' || role === 'automation' };
    };
    let index = 0;
    for (const klass of classes) for (const kind of kinds) for (const role of roles) {
      if (!schemaCompatible(kind, role)) continue;
      const c = collab();
      runCollabAuthIdentityMigration(c);
      const now = new Date('2026-08-13T00:00:00.000Z').toISOString();
      c.prepare("INSERT INTO principals(id,kind,display_name,status,auth_epoch,created_at,updated_at) VALUES ('p','operator','P','active',1,?,?)").run(now, now);
      c.prepare("INSERT INTO surfaces(surface_id,principal_id,surface_kind,surface_role,state,connection_class,connection_class_revision) VALUES (?,?,?,?, 'active',?,1)").run(`s-${index}`, 'p', kind, role, klass);
      const s = state();
      runGatewayAuthIdentityMigration(s);
      s.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES (?,?,?,?,'active',1,1,'x',?,1)").run(`s-${index}`, 'p', kind, role, klass);
      const collabSnapshot = captureCollabAuthSnapshot(c);
      const stateSnapshot = captureStateAuthSnapshot(s);
      const want = expected(klass, kind, role);
      expect(collabSnapshot.eligibleCount, `${klass}/${kind}/${role}`).toBe(want.eligible ? 1 : 0);
      expect(stateSnapshot.eligibleCount, `${klass}/${kind}/${role}`).toBe(want.eligible ? 1 : 0);
      expect(collabSnapshot.invalid, `${klass}/${kind}/${role}`).toBe(want.invalid);
      expect(stateSnapshot.invalid, `${klass}/${kind}/${role}`).toBe(want.invalid);
      const diagnostic = runAuthReconciliationDiagnostic(c, s, { diagnosticId: `${String(index + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, now: new Date('2026-08-13T00:00:00.000Z') });
      expect(diagnostic.non_authoritative).toBe(1);
      expect(diagnostic.status).toBe(want.invalid ? 'INVALID' : 'MATCH');
      expect(s.prepare('SELECT non_authoritative FROM auth_reconciliation_diagnostics').get()).toEqual({ non_authoritative: 1 });
      c.close(); s.close();
      index += 1;
    }
  });

  it('excludes inactive principal/surface tuples and legacy none rows without converting them to invalid mappings', () => {
    for (const inactive of ['principal', 'surface'] as const) {
      const c = collab();
      runCollabAuthIdentityMigration(c);
      seedCollabSurface(c, 'browser_bff');
      if (inactive === 'principal') c.prepare("UPDATE principals SET status='revoked', revoked_at='2026-08-13T00:00:00.000Z' WHERE id='p'").run();
      if (inactive === 'surface') c.prepare("UPDATE surfaces SET state='revoked' WHERE surface_id='s'").run();
      const none = collab();
      runCollabAuthIdentityMigration(none);
      seedCollabSurface(none, 'none');
      expect(captureCollabAuthSnapshot(c)).toMatchObject({ eligibleCount: 0, invalid: false });
      expect(captureCollabAuthSnapshot(none)).toMatchObject({ eligibleCount: 0, invalid: false });
      c.close(); none.close();
    }
  });

  it('refuses partial, extra, and checksum-tampered ledgers before any Phase 2A write', () => {
    const p2aOnly = state();
    p2aOnly.prepare("DELETE FROM gateway_schema_migrations WHERE id='gateway-auth-foundation-001'").run();
    p2aOnly.prepare('INSERT INTO gateway_schema_migrations(id,checksum_sha256,applied_at) VALUES (?,?,?)').run(GATEWAY_AUTH_IDENTITY_MIGRATION_ID, GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM, '2026-08-13T00:00:00.000Z');
    expect(() => runGatewayAuthIdentityMigration(p2aOnly)).toThrow();
    expect(p2aOnly.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='auth_reconciliation_diagnostics'").get()).toEqual({ n: 0 });
    expect(p2aOnly.prepare('PRAGMA table_info(gateway_surface_security)').all()).not.toContainEqual(expect.objectContaining({ name: 'connection_class' }));
    p2aOnly.close();

    const badP2aChecksum = state();
    badP2aChecksum.prepare('INSERT INTO gateway_schema_migrations(id,checksum_sha256,applied_at) VALUES (?,?,?)').run(GATEWAY_AUTH_IDENTITY_MIGRATION_ID, '0'.repeat(64), '2026-08-13T00:00:00.000Z');
    expect(() => runGatewayAuthIdentityMigration(badP2aChecksum)).toThrow();
    expect(badP2aChecksum.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='auth_reconciliation_diagnostics'").get()).toEqual({ n: 0 });
    expect(badP2aChecksum.prepare('PRAGMA table_info(gateway_surface_security)').all()).not.toContainEqual(expect.objectContaining({ name: 'connection_class' }));
    badP2aChecksum.close();

    const partial = collab();
    partial.exec("ALTER TABLE surfaces ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none'");
    expect(() => runCollabAuthIdentityMigration(partial)).toThrow();
    expect(partial.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='collab_auth_schema_migrations'").get()).toEqual({ n: 0 });
    partial.close();

    const bothCollabColumns = collab();
    bothCollabColumns.exec("ALTER TABLE surfaces ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none'");
    bothCollabColumns.exec("ALTER TABLE surfaces ADD COLUMN connection_class_revision INTEGER NOT NULL DEFAULT 1");
    expect(() => runCollabAuthIdentityMigration(bothCollabColumns)).toThrow();
    expect(bothCollabColumns.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='collab_auth_schema_migrations'").get()).toEqual({ n: 0 });
    bothCollabColumns.close();

    const emptyCollabLedger = collab();
    emptyCollabLedger.exec(COLLAB_AUTH_IDENTITY_MIGRATION_SQL.split('\nALTER TABLE')[0]!);
    expect(() => runCollabAuthIdentityMigration(emptyCollabLedger)).toThrow();
    expect(emptyCollabLedger.prepare('SELECT count(*) AS n FROM collab_auth_schema_migrations').get()).toEqual({ n: 0 });
    emptyCollabLedger.close();

    const extra = collab();
    extra.exec("CREATE TABLE collab_auth_schema_migrations (id TEXT PRIMARY KEY, checksum_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)");
    extra.prepare('INSERT INTO collab_auth_schema_migrations VALUES (?,?,?)').run('unexpected', '0'.repeat(64), '2026-08-13T00:00:00.000Z');
    expect(() => runCollabAuthIdentityMigration(extra)).toThrow();
    expect(extra.prepare('PRAGMA table_info(surfaces)').all()).not.toContainEqual(expect.objectContaining({ name: 'connection_class' }));
    extra.close();

    const tampered = state();
    tampered.prepare("UPDATE gateway_schema_migrations SET checksum_sha256=? WHERE id='gateway-auth-foundation-001'").run('0'.repeat(64));
    expect(() => runGatewayAuthIdentityMigration(tampered)).toThrow();
    expect(tampered.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='auth_reconciliation_diagnostics'").get()).toEqual({ n: 0 });
    tampered.close();

    const statePartial = state();
    statePartial.exec("CREATE TABLE auth_reconciliation_diagnostics (diagnostic_id TEXT PRIMARY KEY, non_authoritative INTEGER NOT NULL, status TEXT NOT NULL, collab_auth_ledger_sha256 TEXT NOT NULL, collab_tuple_sha256 TEXT NOT NULL, state_projection_sha256 TEXT NOT NULL, observed_at TEXT NOT NULL, detail_code TEXT NOT NULL)");
    expect(() => runGatewayAuthIdentityMigration(statePartial)).toThrow();
    expect(statePartial.prepare('PRAGMA table_info(gateway_surface_security)').all()).not.toContainEqual(expect.objectContaining({ name: 'connection_class' }));
    statePartial.close();

    const stateColumns = state();
    stateColumns.exec("ALTER TABLE gateway_surface_security ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none'");
    stateColumns.exec("ALTER TABLE gateway_surface_security ADD COLUMN connection_class_revision INTEGER NOT NULL DEFAULT 1");
    expect(() => runGatewayAuthIdentityMigration(stateColumns)).toThrow();
    expect(stateColumns.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='auth_reconciliation_diagnostics'").get()).toEqual({ n: 0 });
    stateColumns.close();

    const stateExtraIndex = state();
    stateExtraIndex.exec('CREATE INDEX unexpected_gateway_surface_index ON gateway_surface_security(surface_id)');
    expect(() => runGatewayAuthIdentityMigration(stateExtraIndex)).toThrow();
    expect(stateExtraIndex.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='auth_reconciliation_diagnostics'").get()).toEqual({ n: 0 });
    stateExtraIndex.close();

    const badCollabBase = collab();
    badCollabBase.exec("ALTER TABLE surfaces ADD COLUMN base_extra TEXT");
    expect(() => runCollabAuthIdentityMigration(badCollabBase)).toThrow();
    expect(badCollabBase.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='collab_auth_schema_migrations'").get()).toEqual({ n: 0 });
    badCollabBase.close();

    const badGatewayBase = state();
    badGatewayBase.exec("ALTER TABLE gateway_surface_security ADD COLUMN base_extra TEXT");
    expect(() => runGatewayAuthIdentityMigration(badGatewayBase)).toThrow();
    expect(badGatewayBase.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='auth_reconciliation_diagnostics'").get()).toEqual({ n: 0 });
    badGatewayBase.close();
  });

  it('rejects TEXT, REAL, and unsafe revisions as INVALID while preserving canonical UTF-8 tuple hashes', () => {
    const c = collab();
    runCollabAuthIdentityMigration(c);
    seedCollabSurface(c, 'browser_bff');
    const s = state();
    runGatewayAuthIdentityMigration(s);
    s.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES ('s','p','desktop','operator','active',1,1,'x','browser_bff',1)").run();
    c.prepare("UPDATE surfaces SET connection_class_revision='2x' WHERE surface_id='s'").run();
    expect(c.prepare("SELECT connection_class_revision,typeof(connection_class_revision) AS revision_type FROM surfaces WHERE surface_id='s'").get()).toEqual({ connection_class_revision: '2x', revision_type: 'text' });
    const textSnapshot = captureCollabAuthSnapshot(c);
    expect(textSnapshot).toMatchObject({ eligibleCount: 0, invalid: true, detail: 'INVALID_REVISION' });
    expect(s.prepare('SELECT count(*) AS n FROM auth_reconciliation_diagnostics').get()).toEqual({ n: 0 });
    expect(() => c.exec('BEGIN IMMEDIATE')).not.toThrow();
    c.exec('ROLLBACK');
    s.prepare("UPDATE gateway_surface_security SET connection_class_revision=2.5 WHERE surface_id='s'").run();
    const invalid = runAuthReconciliationDiagnostic(c, s, { diagnosticId: '33333333-3333-4333-8333-333333333333', now: new Date('2026-08-13T00:00:00.000Z') });
    expect(invalid.status).toBe('INVALID');
    expect(invalid.detail_code).toBe('INVALID_REVISION');
    c.prepare("UPDATE surfaces SET connection_class_revision=9007199254740992 WHERE surface_id='s'").run();
    s.prepare("UPDATE gateway_surface_security SET connection_class_revision=9007199254740992 WHERE surface_id='s'").run();
    const unsafe = runAuthReconciliationDiagnostic(c, s, { diagnosticId: '77777777-7777-4777-8777-777777777777', now: new Date('2026-08-13T00:00:00.000Z') });
    expect(unsafe.status).toBe('INVALID');
    expect(unsafe.detail_code).toBe('INVALID_REVISION');
    c.close(); s.close();
  });

  it('uses canonical length-prefixed UTF-8 bytes and binary row order for multibyte tuples', () => {
    const c = collab();
    runCollabAuthIdentityMigration(c);
    seedCollabSurface(c, 'browser_bff');
    c.prepare("INSERT INTO surfaces(surface_id,principal_id,surface_kind,surface_role,state,connection_class,connection_class_revision) VALUES (?, 'p','mobile','operator','active','browser_bff',1)").run('\u00e9');
    const snapshot = captureCollabAuthSnapshot(c);
    const row = (fields: string[]) => Buffer.concat(fields.map((value) => { const bytes = Buffer.from(value, 'utf8'); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length); return Buffer.concat([prefix, bytes]); }));
    const expected = createHash('sha256').update(Buffer.concat([
      row(['p', 's', 'desktop', 'operator', 'browser_bff', '1']),
      row(['p', '\u00e9', 'mobile', 'operator', 'browser_bff', '1']),
    ].sort(Buffer.compare))).digest('hex');
    expect(snapshot.tupleHash).toBe(expected);
    c.close();
  });

  it('rejects malformed diagnostic UUID, timestamp, detail, status, and hashes without writing', () => {
    const c = collab();
    runCollabAuthIdentityMigration(c);
    const s = state();
    runGatewayAuthIdentityMigration(s);
    const valid = buildAuthReconciliationDiagnostic(captureCollabAuthSnapshot(c), captureStateAuthSnapshot(s), { diagnosticId: '88888888-8888-4888-8888-888888888888', now: new Date('2026-08-13T00:00:00.000Z') });
    for (const mutate of [
      () => ({ ...valid, diagnostic_id: 'BAD' }),
      () => ({ ...valid, observed_at: '2026-08-13T00:00:00Z' }),
      () => ({ ...valid, detail_code: 'RAW_ID' as never }),
      () => ({ ...valid, status: 'UNKNOWN' as never }),
      () => ({ ...valid, collab_tuple_sha256: 'ABC' }),
    ]) expect(() => writeAuthReconciliationDiagnostic(s, mutate())).toThrow();
    expect(s.prepare('SELECT count(*) AS n FROM auth_reconciliation_diagnostics').get()).toEqual({ n: 0 });
    c.close(); s.close();
  });

  it('revalidates the complete state schema inside the diagnostic write transaction', () => {
    const c = collab();
    runCollabAuthIdentityMigration(c);
    const validState = state();
    runGatewayAuthIdentityMigration(validState);
    const valid = buildAuthReconciliationDiagnostic(captureCollabAuthSnapshot(c), captureStateAuthSnapshot(validState), { diagnosticId: '99999999-9999-4999-8999-999999999999', now: new Date('2026-08-13T00:00:00.000Z') });

    for (const malformed of [
      (() => { const db = new Database(':memory:'); db.exec(`CREATE TABLE auth_reconciliation_diagnostics (diagnostic_id TEXT PRIMARY KEY, non_authoritative INTEGER, status TEXT, collab_auth_ledger_sha256 TEXT, collab_tuple_sha256 TEXT, state_projection_sha256 TEXT, observed_at TEXT, detail_code TEXT)`); return db; })(),
      (() => { const db = state(); db.exec('DROP TABLE gateway_schema_migrations'); return db; })(),
    ]) {
      expect(() => writeAuthReconciliationDiagnostic(malformed, valid)).toThrow();
      if (malformed.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_reconciliation_diagnostics'").get()) {
        expect(malformed.prepare('SELECT count(*) AS n FROM auth_reconciliation_diagnostics').get()).toEqual({ n: 0 });
      }
      malformed.close();
    }
    c.close(); validState.close();
  });

  it('refuses foundation marker, ledger, catalog, and shape drift before diagnostic insert', () => {
    const c = collab();
    runCollabAuthIdentityMigration(c);
    const makeState = () => {
      const db = state();
      runGatewayAuthIdentityMigration(db);
      const valid = buildAuthReconciliationDiagnostic(captureCollabAuthSnapshot(c), captureStateAuthSnapshot(db), { diagnosticId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now: new Date('2026-08-13T00:00:00.000Z') });
      return { db, valid };
    };
    const mutations: Array<[string, (db: Database.Database) => void]> = [
      ['schema2 marker', (db) => db.prepare("UPDATE auth_runtime_state SET state_schema=2, mode='V2_TEST', launcher_generation=1, serving_state='STOPPED', config_digest_sha256='x', secret_set_id='x'").run()],
      ['extra foundation ledger row', (db) => db.prepare('INSERT INTO gateway_schema_migrations(id,checksum_sha256,applied_at) VALUES (?,?,?)').run('unexpected', '0'.repeat(64), '2026-08-13T00:00:00.000Z')],
      ['extra foundation ledger column', (db) => db.exec('ALTER TABLE gateway_schema_migrations ADD COLUMN extra TEXT')],
      ['extra marker column', (db) => db.exec('ALTER TABLE auth_runtime_state ADD COLUMN extra TEXT')],
      ['missing marker row', (db) => db.exec('DELETE FROM auth_runtime_state')],
    ];
    for (const [name, mutate] of mutations) {
      const { db, valid } = makeState();
      mutate(db);
      expect(() => writeAuthReconciliationDiagnostic(db, valid), name).toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM auth_reconciliation_diagnostics').get()).toEqual({ n: 0 });
      expect(() => db.exec('BEGIN IMMEDIATE')).not.toThrow();
      db.exec('ROLLBACK');
      db.close();
    }
    c.close();
  });

  it('refuses an ambiguous collab foundation before migration, snapshot, or diagnostic write', () => {
    const malformed = collab();
    malformed.exec('DROP TABLE collab_schema_migrations');
    expect(() => runCollabAuthIdentityMigration(malformed)).toThrow();
    expect(() => captureCollabAuthSnapshot(malformed)).toThrow();
    malformed.close();

    const extraColumn = collab();
    extraColumn.exec('ALTER TABLE principals ADD COLUMN unexpected TEXT');
    expect(() => runCollabAuthIdentityMigration(extraColumn)).toThrow();
    expect(() => captureCollabAuthSnapshot(extraColumn)).toThrow();
    extraColumn.close();

    const extraIndex = collab();
    extraIndex.exec('CREATE INDEX unexpected_principals_index ON principals(status)');
    expect(() => runCollabAuthIdentityMigration(extraIndex)).toThrow();
    expect(() => captureCollabAuthSnapshot(extraIndex)).toThrow();
    extraIndex.close();

    const extraLedger = collab();
    extraLedger.prepare('INSERT INTO collab_schema_migrations(id,applied_at) VALUES (?,?)').run('unexpected', '2026-08-13T00:00:00.000Z');
    expect(() => runCollabAuthIdentityMigration(extraLedger)).toThrow();
    expect(() => captureCollabAuthSnapshot(extraLedger)).toThrow();
    extraLedger.close();
  });

  it('records a zero-eligible real diagnostic with bounded hashes and canonical ID/time', () => {
    const c = collab();
    runCollabAuthIdentityMigration(c);
    seedCollabSurface(c);
    const s = state();
    runGatewayAuthIdentityMigration(s);
    s.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES ('s','p','desktop','agent','active',1,1,'x','none',1)").run();
    const diagnostic = runAuthReconciliationDiagnostic(c, s, { diagnosticId: '44444444-4444-4444-8444-444444444444', now: new Date('2026-08-13T00:00:00.000Z') });
    expect(diagnostic.status).toBe('MATCH');
    expect(diagnostic.detail_code).toBe('ZERO_ELIGIBLE_TUPLES');
    expect(diagnostic.collab_auth_ledger_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnostic.collab_tuple_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnostic.state_projection_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => runAuthReconciliationDiagnostic(c, s, { diagnosticId: 'BAD', now: new Date('2026-08-13T00:00:00.000Z') })).toThrow();
    c.close(); s.close();
  });

  it('CLI refuses without opening or echoing explicit database paths', () => {
    const result = spawnSync(process.execPath, ['scripts/auth-phase2a-offline.mjs', '--offline', '--collab-db', 'E:/private-collab.db', '--state-db', 'E:/private-state.db'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private-collab.db');
    expect(result.stderr).not.toContain('private-state.db');
    expect(result.stderr).toContain('PHASE2A_OFFLINE_REFUSED');
    const noArgs = spawnSync(process.execPath, ['scripts/auth-phase2a-offline.mjs'], { cwd: root, encoding: 'utf8' });
    expect(noArgs.status).toBe(2);
    expect(noArgs.stderr).toContain('PHASE2A_OFFLINE_REFUSED');
    expect(noArgs.stderr).not.toMatch(/SQLITE|ENOENT|Error:/i);
    const unknown = spawnSync(process.execPath, ['scripts/auth-phase2a-offline.mjs', '--offline', '--unknown'], { cwd: root, encoding: 'utf8' });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('PHASE2A_OFFLINE_REFUSED');
  });

  it('CLI commits collab before a state refusal, then reruns exactly and remains non-authoritative', () => {
    const dir = mkdtempSync(join(root, '.torq-phase2a-cli-'));
    const collabPath = join(dir, 'collab.db');
    const statePath = join(dir, 'state.db');
    try {
      const c = new Database(collabPath);
      runCollaborationMigration(c);
      runSurfaceIdentityMigration(c);
      c.close();
      const s = new Database(statePath);
      runAuthFoundationMigration(s);
      ensureSurfaceSecuritySchema(s);
      s.prepare('INSERT INTO gateway_schema_migrations(id,checksum_sha256,applied_at) VALUES (?,?,?)').run('unexpected', '0'.repeat(64), '2026-08-13T00:00:00.000Z');
      s.close();
      const first = spawnSync(process.execPath, ['scripts/auth-phase2a-offline.mjs', '--offline', '--collab-db', collabPath, '--state-db', statePath], { cwd: root, encoding: 'utf8', env: { ...process.env, TORQCLAW_PHASE2A_TRACE_STDOUT: '1' } });
      expect(first.status).toBe(2);
      expect(first.stderr).not.toContain(collabPath);
      expect(first.stderr).not.toContain(statePath);
      expect(first.stderr).not.toMatch(/SQLITE|ENOENT|Error:/i);
      const firstTrace = JSON.parse(first.stdout.trim()) as { phase2a_trace: number; result: string; events: string[] };
      expect(firstTrace.phase2a_trace).toBe(1);
      expect(firstTrace.result).toBe('refused');
      expect(firstTrace.events.length).toBeLessThanOrEqual(32);
      expect(firstTrace.events.every((event) => /^(collab|state):(OPEN|CLOSED|REFUSED|BEGIN IMMEDIATE|COMMIT|ROLLBACK|DIAGNOSTIC BEGIN IMMEDIATE|DIAGNOSTIC COMMIT|DIAGNOSTIC ROLLBACK)$/.test(event))).toBe(true);
      expect(firstTrace.events).toEqual(expect.arrayContaining(['collab:OPEN', 'collab:BEGIN IMMEDIATE', 'collab:COMMIT', 'collab:CLOSED', 'state:OPEN', 'state:REFUSED']));
      expect(firstTrace.events).not.toContain('state:BEGIN IMMEDIATE');
      expect(firstTrace.events.indexOf('collab:COMMIT')).toBeLessThan(firstTrace.events.indexOf('collab:CLOSED'));
      expect(firstTrace.events.indexOf('collab:CLOSED')).toBeLessThan(firstTrace.events.indexOf('state:OPEN'));
      expect(firstTrace.events.filter((event) => event.includes('BEGIN IMMEDIATE')).length).toBe(1);
      const afterCollab = new Database(collabPath);
      expect(afterCollab.prepare('SELECT id FROM collab_auth_schema_migrations').get()).toEqual({ id: COLLAB_AUTH_IDENTITY_MIGRATION_ID });
      afterCollab.close();
      const failedState = new Database(statePath);
      expect(failedState.prepare('SELECT id FROM gateway_schema_migrations WHERE id=?').get('gateway-auth-identity-reconciliation-002')).toBeUndefined();
      failedState.prepare('DELETE FROM gateway_schema_migrations WHERE id=?').run('unexpected');
      failedState.close();
      const second = spawnSync(process.execPath, ['scripts/auth-phase2a-offline.mjs', '--offline', '--collab-db', collabPath, '--state-db', statePath], { cwd: root, encoding: 'utf8', env: { ...process.env, TORQCLAW_PHASE2A_TRACE_STDOUT: '1' } });
      expect(second.status).toBe(0);
      const secondLines = second.stdout.trim().split('\n');
      expect(secondLines).toHaveLength(2);
      expect(JSON.parse(secondLines[0]!)).toEqual(expect.objectContaining({ non_authoritative: 1 }));
      const secondTrace = JSON.parse(secondLines[1]!) as { phase2a_trace: number; result: string; events: string[] };
      expect(secondTrace.phase2a_trace).toBe(1);
      expect(secondTrace.result).toBe('ok');
      expect(secondTrace.events.length).toBeLessThanOrEqual(32);
      expect(secondTrace.events.every((event) => /^(collab|state):(OPEN|CLOSED|REFUSED|BEGIN IMMEDIATE|COMMIT|ROLLBACK|DIAGNOSTIC BEGIN IMMEDIATE|DIAGNOSTIC COMMIT|DIAGNOSTIC ROLLBACK)$/.test(event))).toBe(true);
      expect(secondTrace.events.indexOf('collab:COMMIT')).toBeLessThan(secondTrace.events.indexOf('collab:CLOSED'));
      expect(secondTrace.events.indexOf('collab:CLOSED')).toBeLessThan(secondTrace.events.indexOf('state:BEGIN IMMEDIATE'));
      expect(secondTrace.events.filter((event) => event.includes('BEGIN IMMEDIATE')).length).toBe(3);
      const normalEnv = { ...process.env };
      delete normalEnv.TORQCLAW_PHASE2A_TRACE_STDOUT;
      const normal = spawnSync(process.execPath, ['scripts/auth-phase2a-offline.mjs', '--offline', '--collab-db', collabPath, '--state-db', statePath], { cwd: root, encoding: 'utf8', env: normalEnv });
      expect(normal.status).toBe(0);
      expect(normal.stdout.trim().split('\n')).toHaveLength(1);
      expect(normal.stdout).not.toContain('phase2a_trace');
      const finalState = new Database(statePath);
      expect(finalState.prepare('SELECT non_authoritative FROM auth_reconciliation_diagnostics').get()).toEqual({ non_authoritative: 1 });
      expect(finalState.prepare("SELECT name FROM sqlite_master WHERE name IN ('gateway_v2_session_bindings','auth_reconciliation_receipts')").all()).toEqual([]);
      finalState.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Phase 2A unreachable from live V1 modules and exposes no authority type', () => {
    const root = join(import.meta.dirname, '..');
    for (const file of ['packages/gateway/src/server.ts', 'packages/gateway/src/storage.ts', 'packages/gateway/src/sessions.ts', 'packages/gateway/src/surfaceGate.ts']) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source).not.toMatch(/authIdentityMigration|authReconciliationDiagnostic|authPhase2AConstants/);
    }
    expect(readFileSync(join(root, 'packages/gateway/src/authIdentityMigration.ts'), 'utf8')).not.toMatch(/AuthenticatedCaller|WeakSet|session_bindings|auth_reconciliation_receipts/);
  });

  it('proves the pinned Phase 1 source rejects the Phase 2A ledger by design', () => {
    const oldMarker = execFileSync('git', ['show', '37667e9:packages/gateway/src/authRuntimeMarker.ts'], { cwd: root, encoding: 'utf8' });
    expect(oldMarker).not.toContain('gateway-auth-identity-reconciliation-002');
    expect(oldMarker).toContain('if (rows.length !== 1) return false;');
  });

  it('live marker validates exact Phase 2A shape and refuses receipt-only or partial states before startup', () => {
    const receiptOnly = state();
    receiptOnly.prepare('INSERT INTO gateway_schema_migrations(id,checksum_sha256,applied_at) VALUES (?,?,?)').run(GATEWAY_AUTH_IDENTITY_MIGRATION_ID, GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM, '2026-08-13T00:00:00.000Z');
    expect(() => readAuthRuntimeMarker(receiptOnly)).toThrow();
    receiptOnly.close();

    const columnsOnly = state();
    columnsOnly.exec("ALTER TABLE gateway_surface_security ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none'");
    columnsOnly.exec("ALTER TABLE gateway_surface_security ADD COLUMN connection_class_revision INTEGER NOT NULL DEFAULT 1");
    expect(() => readAuthRuntimeMarker(columnsOnly)).toThrow();
    columnsOnly.close();

    const mixedCaseColumn = state();
    mixedCaseColumn.exec('ALTER TABLE gateway_surface_security ADD COLUMN "Connection_Class" TEXT NOT NULL DEFAULT \'none\'');
    expect(() => readAuthRuntimeMarker(mixedCaseColumn)).toThrow();
    mixedCaseColumn.close();

    const complete = state();
    runGatewayAuthIdentityMigration(complete);
    expect(readAuthRuntimeMarker(complete)).toEqual({ state: 'v1' });
    complete.close();

    for (const [name, mutate] of [
      ['extra base column', (db: Database.Database) => db.exec('ALTER TABLE gateway_surface_security ADD COLUMN base_extra TEXT')],
      ['renamed base column', (db: Database.Database) => db.exec('ALTER TABLE gateway_surface_security RENAME COLUMN principal_id TO principal_renamed')],
      ['base table trigger drift', (db: Database.Database) => db.exec('CREATE TRIGGER base_security_trigger AFTER INSERT ON gateway_surface_security BEGIN SELECT 1; END')],
    ] as const) {
      const db = state();
      runGatewayAuthIdentityMigration(db);
      mutate(db);
      expect(() => readAuthRuntimeMarker(db), name).toThrow();
      db.close();
    }

    for (const [name, mutate] of [
      ['missing security index', (db: Database.Database) => db.exec('DROP INDEX idx_gateway_surface_security_v2_tuple')],
      ['missing observed index', (db: Database.Database) => db.exec('DROP INDEX idx_auth_reconciliation_diagnostics_observed')],
      ['missing diagnostics table', (db: Database.Database) => db.exec('DROP TABLE auth_reconciliation_diagnostics')],
      ['extra security index', (db: Database.Database) => db.exec('CREATE INDEX extra_phase2a_index ON gateway_surface_security(surface_id)')],
      ['extra diagnostics table', (db: Database.Database) => db.exec('CREATE TABLE auth_reconciliation_diagnostics_extra (id TEXT)')],
    ]) {
      const db = state();
      runGatewayAuthIdentityMigration(db);
      mutate(db);
      expect(() => readAuthRuntimeMarker(db), name).toThrow();
      db.close();
    }

    const malformed = ['wrong security index SQL', 'diagnostic foreign key drift'] as const;
    for (const name of malformed) {
      const db = state();
      db.exec("ALTER TABLE gateway_surface_security ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none'");
      db.exec("ALTER TABLE gateway_surface_security ADD COLUMN connection_class_revision INTEGER NOT NULL DEFAULT 1");
      if (name === 'wrong security index SQL') {
        db.exec("CREATE UNIQUE INDEX idx_gateway_surface_security_v2_tuple ON gateway_surface_security(surface_id)");
        db.exec("CREATE TABLE auth_reconciliation_diagnostics (diagnostic_id TEXT PRIMARY KEY, non_authoritative INTEGER NOT NULL, status TEXT NOT NULL, collab_auth_ledger_sha256 TEXT NOT NULL, collab_tuple_sha256 TEXT NOT NULL, state_projection_sha256 TEXT NOT NULL, observed_at TEXT NOT NULL, detail_code TEXT NOT NULL)");
      } else {
        db.exec("CREATE UNIQUE INDEX idx_gateway_surface_security_v2_tuple ON gateway_surface_security(surface_id,surface_kind,surface_role,connection_class,connection_class_revision)");
        db.exec("CREATE TABLE auth_reconciliation_diagnostics (diagnostic_id TEXT PRIMARY KEY, non_authoritative INTEGER NOT NULL, status TEXT NOT NULL, collab_auth_ledger_sha256 TEXT NOT NULL, collab_tuple_sha256 TEXT NOT NULL, state_projection_sha256 TEXT NOT NULL, observed_at TEXT NOT NULL, detail_code TEXT NOT NULL, FOREIGN KEY (diagnostic_id) REFERENCES gateway_surface_security(surface_id))");
      }
      db.exec("CREATE INDEX idx_auth_reconciliation_diagnostics_observed ON auth_reconciliation_diagnostics(observed_at)");
      db.exec("INSERT INTO gateway_schema_migrations VALUES ('gateway-auth-identity-reconciliation-002', 'b0fc3b85b8851a1f3f79615f0270e056c4fdd3992e1d89973250dbf9506b0028', '2026-08-13T00:00:00.000Z')");
      expect(() => readAuthRuntimeMarker(db), name).toThrow();
      db.close();
    }

    const foundationPartial = state();
    foundationPartial.exec('CREATE TABLE auth_reconciliation_diagnostics_extra (id TEXT)');
    expect(() => readAuthRuntimeMarker(foundationPartial)).toThrow();
    foundationPartial.close();
  });

  it('refuses TEMP shadow collisions for base and Phase2A reserved objects', () => {
    for (const ddl of [
      'CREATE TEMP TABLE Gateway_Surface_Security (id TEXT)',
      'CREATE TEMP VIEW AUTH_RECONCILIATION_DIAGNOSTICS AS SELECT 1 AS id',
    ]) {
      const db = state();
      db.exec(ddl);
      expect(() => readAuthRuntimeMarker(db)).toThrow();
      db.close();
    }
    const collabDb = collab();
    collabDb.exec('CREATE TEMP TABLE SURFACES (id TEXT)');
    expect(() => runCollabAuthIdentityMigration(collabDb)).toThrow();
    collabDb.close();
  });
});
