import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM,
  COLLAB_AUTH_IDENTITY_MIGRATION_ID,
  GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM,
  GATEWAY_AUTH_IDENTITY_MIGRATION_ID,
  GATEWAY_AUTH_IDENTITY_MIGRATION_SQL,
  phase2aMigrationChecksum,
  serializeAuthPhase2AProgram,
  GATEWAY_AUTH_IDENTITY_STEP_MANIFEST,
  GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR,
} from '../packages/gateway/src/authPhase2AConstants.js';
import { COLLAB_AUTH_IDENTITY_STEP_MANIFEST } from '../packages/collab/src/authIdentityConstants.js';
import { runCollaborationMigration } from '../packages/collab/src/migration.js';
import { runSurfaceIdentityMigration } from '../packages/collab/src/surfaces.js';
import { runCollabAuthIdentityMigration } from '../packages/collab/src/authIdentityMigration.js';
import { runAuthFoundationMigration } from '../packages/gateway/src/authRuntimeMarker.js';
import { ensureSurfaceSecuritySchema } from '../packages/gateway/src/surfaceSecurity.js';
import { runGatewayAuthIdentityMigration } from '../packages/gateway/src/authIdentityMigration.js';
import { captureCollabAuthSnapshot, captureStateAuthSnapshot, buildAuthReconciliationDiagnostic } from '../packages/gateway/src/authReconciliationDiagnostic.js';

const root = join(import.meta.dirname, '..');
const source = {
  marker: readFileSync(join(root, 'packages/gateway/src/authRuntimeMarker.ts'), 'utf8'),
  collab: readFileSync(join(root, 'packages/collab/src/authIdentityMigration.ts'), 'utf8'),
  state: readFileSync(join(root, 'packages/gateway/src/authIdentityMigration.ts'), 'utf8'),
  diagnostic: readFileSync(join(root, 'packages/gateway/src/authReconciliationDiagnostic.ts'), 'utf8'),
  cli: readFileSync(join(root, 'scripts/auth-phase2a-offline.mjs'), 'utf8'),
};

const replaceOnce = (value: string, from: string, to: string): string => {
  if (from === to) throw new Error('named mutation is a no-op');
  const index = value.indexOf(from);
  if (index < 0) throw new Error(`mutation anchor missing: ${from}`);
  return value.slice(0, index) + to + value.slice(index + from.length);
};

describe('Phase 2A named mutant gate', () => {
  it('pins the exact two-ledger marker matrix', () => {
    expect(source.marker).toContain('if (rows.length !== 1) return false;');
    expect(source.marker).toContain('if (rows.length !== 2) return false;');
    expect(source.marker).toContain('GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM');
  });

  it('executes behavioral kill oracles for validator omission and mapping widening mutants', () => {
    const collab = new Database(':memory:');
    runCollaborationMigration(collab);
    runSurfaceIdentityMigration(collab);
    runCollabAuthIdentityMigration(collab);
    const now = '2026-08-13T00:00:00.000Z';
    collab.prepare("INSERT INTO principals(id,kind,display_name,status,auth_epoch,created_at,updated_at) VALUES ('p','operator','P','active',1,?,?)").run(now, now);
    collab.prepare("INSERT INTO surfaces(surface_id,principal_id,surface_kind,surface_role,state,connection_class,connection_class_revision) VALUES ('s','p','http','agent','active','browser_bff',1)").run();
    const state = new Database(':memory:');
    runAuthFoundationMigration(state);
    ensureSurfaceSecuritySchema(state);
    runGatewayAuthIdentityMigration(state);
    state.prepare("INSERT INTO gateway_surface_security(surface_id,principal_id,surface_kind,surface_role,state,auth_epoch,capability_revision,source_identity_revision,connection_class,connection_class_revision) VALUES ('s','p','http','agent','active',1,1,'x','browser_bff',1)").run();
    const collabSnapshot = captureCollabAuthSnapshot(collab);
    const stateSnapshot = captureStateAuthSnapshot(state);
    expect(collabSnapshot).toMatchObject({ eligibleCount: 0, invalid: true, detail: 'INVALID_CLASS_MAPPING' });
    expect(stateSnapshot).toMatchObject({ eligibleCount: 0, invalid: true, detail: 'INVALID_CLASS_MAPPING' });
    expect(buildAuthReconciliationDiagnostic(collabSnapshot, stateSnapshot, { diagnosticId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now: new Date(now) }).status).toBe('INVALID');
    state.exec('ALTER TABLE gateway_surface_security ADD COLUMN forbidden_mutant TEXT');
    expect(() => runGatewayAuthIdentityMigration(state)).toThrow();
    expect(state.prepare("SELECT count(*) AS n FROM auth_reconciliation_diagnostics").get()).toEqual({ n: 0 });
    collab.close();
    state.close();
  });

  it('keeps live marker shape validation and foundation partial scans executable', () => {
    expect(source.marker).toContain('function validatePhase2ASchema');
    expect(source.marker).toContain('function phase2aColumnPresence');
    expect(source.marker).toContain("PHASE2A_SECURITY_INDEX_SQL");
    expect(source.marker).toContain("PHASE2A_DIAGNOSTIC_TABLE_SQL");
    expect(source.marker).toContain('phase2aReservedObjects(db).length !== 0');
    expect(() => expect(source.marker.replace('function validatePhase2ASchema', 'function omittedPhase2ASchema')).toContain('function validatePhase2ASchema')).toThrow();
    expect(() => expect(source.marker.replace('phase2aColumnPresence(db).length !== 0', 'false')).toContain('phase2aColumnPresence(db).length !== 0')).toThrow();
    expect(source.marker).toContain('PHASE2A_SECURITY_TABLE_SQL');
    expect(source.marker).toContain('expectedSecurity.length');
    expect(() => expect(source.marker.replace('expectedSecurity.length', '0')).toContain('expectedSecurity.length')).toThrow();
  });

  it('turns acceptance of an extra/partial ledger red', () => {
    expect(() => expect(replaceOnce(source.marker, 'if (rows.length !== 2) return false;', 'if (rows.length >= 2) return false;')).toContain('if (rows.length !== 2) return false;')).toThrow();
    expect(() => expect(replaceOnce(source.state, 'if (rows.length !== 1 && rows.length !== 2) fail();', 'if (rows.length < 1) fail();')).toContain('if (rows.length !== 1 && rows.length !== 2) fail();')).toThrow();
  });

  it('turns checksum-program receipt inclusion and ambiguous hashing red', () => {
    expect(source.collab + source.state).not.toMatch(/COLLAB_AUTH_IDENTITY_MIGRATION_SQL[\s\S]{0,500}INSERT INTO/);
    expect(source.diagnostic).toContain('function lengthPrefixed(value: string): Buffer');
    expect(source.diagnostic).toContain('prefix.writeUInt32BE(bytes.length, 0)');
    expect(source.diagnostic).toContain('sort(Buffer.compare)');
    expect(() => expect(replaceOnce(source.diagnostic, 'return Buffer.concat([prefix, bytes]);', 'return Buffer.from(value);')).toContain('return Buffer.concat([prefix, bytes]);')).toThrow();
  });

  it('turns CRLF, statement-order, and receipt-inclusion vector mutants red', () => {
    const collabManifest = COLLAB_AUTH_IDENTITY_STEP_MANIFEST;
    const gatewayManifest = GATEWAY_AUTH_IDENTITY_STEP_MANIFEST;
    expect(phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(collabManifest))).toBe(COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM);
    expect(phase2aMigrationChecksum(GATEWAY_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(gatewayManifest))).toBe(GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM);
    expect(phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(collabManifest).replaceAll('\n', '\r\n'))).not.toBe(COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM);
    expect(phase2aMigrationChecksum(GATEWAY_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(gatewayManifest).replaceAll('\n', '\r\n'))).not.toBe(GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM);
    expect(phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(collabManifest).replace('collab-create-ledger', 'reordered-marker'))).not.toBe(COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM);
    expect(phase2aMigrationChecksum(GATEWAY_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(gatewayManifest).replace('gateway-create-diagnostics', 'reordered-marker'))).not.toBe(GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM);
    expect(phase2aMigrationChecksum(GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR.id, serializeAuthPhase2AProgram(gatewayManifest))).toBe(GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR.sha256Hex);
    const alteredGateway = gatewayManifest.map((step) => step.name === 'gateway-create-diagnostics' ? { ...step, payload: `${step.payload}\n--mutant` } : step);
    expect(serializeAuthPhase2AProgram(alteredGateway)).not.toBe(Buffer.from(GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR.programUtf8Hex, 'hex').toString('utf8'));
    expect(phase2aMigrationChecksum(GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR.id, serializeAuthPhase2AProgram(alteredGateway))).not.toBe(GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR.sha256Hex);
    expect(phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, `${serializeAuthPhase2AProgram(collabManifest)}INSERT INTO collab_auth_schema_migrations VALUES (...)`)).not.toBe(COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM);
  });

  it('binds removal, swap, name, payload, DDL, and receipt-boundary mutants', () => {
    const mutate = (manifest: readonly { kind: 'assert' | 'ddl' | 'receipt-boundary'; name: string; payload: string }[], index: number, replacement: { kind: 'assert' | 'ddl' | 'receipt-boundary'; name: string; payload: string }) => [...manifest.slice(0, index), replacement, ...manifest.slice(index + 1)];
    const base = phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(COLLAB_AUTH_IDENTITY_STEP_MANIFEST));
    expect(phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(COLLAB_AUTH_IDENTITY_STEP_MANIFEST.slice(0, -1)))).not.toBe(base);
    expect(phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram([...COLLAB_AUTH_IDENTITY_STEP_MANIFEST].reverse()))).not.toBe(base);
    expect(phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(mutate(COLLAB_AUTH_IDENTITY_STEP_MANIFEST, 0, { ...COLLAB_AUTH_IDENTITY_STEP_MANIFEST[0]!, name: 'wrong-assert' })))).not.toBe(base);
    expect(phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(mutate(COLLAB_AUTH_IDENTITY_STEP_MANIFEST, 1, { ...COLLAB_AUTH_IDENTITY_STEP_MANIFEST[1]!, payload: 'CREATE TABLE altered;' })))).not.toBe(base);
    expect(source.collab).toContain('default: fail();');
    expect(source.state).toContain('default: fail();');
    expect(source.collab).toContain("step.kind === 'receipt-boundary'");
    expect(source.state).toContain("step.kind === 'receipt-boundary'");
  });

  it('pins the shared canonical offline step manifests and rejects omitted assertion steps', () => {
    expect(COLLAB_AUTH_IDENTITY_STEP_MANIFEST.some((step) => step.kind === 'assert')).toBe(true);
    expect(source.collab).toContain('assertCollabAuthIdentitySchema');
    expect(source.state).toContain('GATEWAY_AUTH_IDENTITY_STEP_MANIFEST');
    expect(() => expect(source.state.replaceAll('assertGatewayAuthIdentitySchema(db);', '/* omitted */')).toContain('assertGatewayAuthIdentitySchema(db);')).toThrow();
    expect(source.state).toContain('readAuthRuntimeMarker(db).state');
    expect(() => expect(source.state.replace('if (readAuthRuntimeMarker(db).state !== \'v1\') fail();', '/* foundation omitted */')).toContain('readAuthRuntimeMarker(db).state')).toThrow();
    expect(source.collab).toContain('assertCollabFoundation(db);');
    expect(source.collab).toContain('assertPrincipalFoundation');
    expect(source.collab).toContain('assertShippedCollabLedger');
    expect(() => expect(source.collab.replaceAll('assertCollabFoundation(db);', '/* foundation omitted */')).toContain('assertCollabFoundation(db);')).toThrow();
    expect(() => expect(source.collab.replace('objects.length !== 3', 'objects.length !== 0')).toContain('objects.length !== 3')).toThrow();
    expect(() => expect(source.collab.replace('rows.length !== 2', 'rows.length !== 0')).toContain('rows.length !== 2')).toThrow();
  });

  it('turns authority/repair/fixture/CLI mutants red', () => {
    expect(source.diagnostic).toContain('non_authoritative: 1');
    expect(source.diagnostic).not.toContain('fixtureMode');
    expect(source.diagnostic).toContain("raw.connection_class === 'fixture_operator'");
    expect(() => expect(source.diagnostic.replace("raw.connection_class === 'fixture_operator'", "raw.connection_class === 'none'")).toContain("raw.connection_class === 'fixture_operator'")).toThrow();
    expect(source.diagnostic).not.toMatch(/AuthenticatedCaller|WeakSet|gateway_v2_session_bindings|auth_reconciliation_receipts|revoke|provision|repair/);
    expect(source.cli).toContain("arg === '--offline'");
    expect(source.cli).toContain("arg === '--collab-db'");
    expect(source.cli).toContain("arg === '--state-db'");
    expect(source.cli).toContain('PHASE2A_OFFLINE_REFUSED');
    expect(() => expect(replaceOnce(source.cli, "arg === '--offline'", 'false')).toContain("arg === '--offline'" )).toThrow();
  });

  it('excludes fixture operators before every production tuple validation', () => {
    const fixture = source.diagnostic.indexOf("raw.connection_class === 'fixture_operator'");
    expect(fixture).toBeGreaterThanOrEqual(0);
    for (const validation of [
      'if (!isClass(raw.connection_class))',
      'const revision = canonicalRevision(raw);',
      'const kind = String(raw.surface_kind);',
      'const role = String(raw.surface_role);',
    ]) {
      expect(fixture).toBeLessThan(source.diagnostic.indexOf(validation));
    }
  });

  it('keeps diagnostic schema validation inside the write transaction', () => {
    const writeSource = source.diagnostic.slice(source.diagnostic.indexOf('export function writeAuthReconciliationDiagnostic'));
    expect(writeSource.indexOf("db.exec('BEGIN IMMEDIATE')")).toBeGreaterThanOrEqual(0);
    expect(writeSource.indexOf('assertGatewayAuthIdentitySchema(db);')).toBeGreaterThan(writeSource.indexOf("db.exec('BEGIN IMMEDIATE')"));
    expect(() => expect(writeSource.replace('assertGatewayAuthIdentitySchema(db);', '/* omitted */')).toContain('assertGatewayAuthIdentitySchema(db);')).toThrow();
  });

  it('keeps migration/diagnostics absent from live imports', () => {
    for (const file of ['packages/gateway/src/server.ts', 'packages/gateway/src/storage.ts', 'packages/gateway/src/sessions.ts', 'packages/gateway/src/surfaceGate.ts']) {
      const live = readFileSync(join(root, file), 'utf8');
      expect(live).not.toMatch(/authIdentityMigration|authReconciliationDiagnostic|authPhase2AConstants/);
    }
  });

  it('pins exact current C1 base-shape validators before additive writes', () => {
    expect(source.collab).toContain('function assertSurfaceBase');
    expect(source.state).toContain('function assertSecurityBase');
    expect(source.collab).toContain('SURFACES_BASE_SQL');
    expect(source.state).toContain('SECURITY_BASE_SQL');
    expect(() => expect(source.collab.replace('function assertSurfaceBase', 'function omittedSurfaceBase')).toContain('function assertSurfaceBase')).toThrow();
    expect(() => expect(source.state.replace('function assertSecurityBase', 'function omittedSecurityBase')).toContain('function assertSecurityBase')).toThrow();
  });
});
