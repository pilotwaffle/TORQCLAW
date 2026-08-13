import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import {
  COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM,
  COLLAB_AUTH_IDENTITY_MIGRATION_ID,
  CONNECTION_CLASS_VALUES,
  type ConnectionClass,
  PHASE2A_HASH_HEX,
  PHASE2A_UTC_ISO,
} from './authPhase2AConstants.js';
import { assertGatewayAuthIdentitySchema } from './authIdentityMigration.js';
const require = createRequire(import.meta.url);
const { assertCollabAuthIdentitySchema } = require('../../collab/dist/authIdentityMigration.js') as { assertCollabAuthIdentitySchema: (db: Database.Database) => void };

export const AUTH_DIAGNOSTIC_DETAIL_CODES = [
  'MATCH',
  'HASH_MISMATCH',
  'ZERO_ELIGIBLE_TUPLES',
  'INACTIVE_TUPLE',
  'LEGACY_NONE_CLASS',
  'INVALID_CLASS_MAPPING',
  'INVALID_REVISION',
  'AUTOMATION_EXCLUDED',
  'FIXTURE_OPERATOR_EXCLUDED',
] as const;
export type AuthDiagnosticDetailCode = (typeof AUTH_DIAGNOSTIC_DETAIL_CODES)[number];
export type AuthDiagnosticStatus = 'MATCH' | 'MISMATCH' | 'INVALID';

export interface AuthDiagnosticRow {
  diagnostic_id: string;
  non_authoritative: 1;
  status: AuthDiagnosticStatus;
  collab_auth_ledger_sha256: string;
  collab_tuple_sha256: string;
  state_projection_sha256: string;
  observed_at: string;
  detail_code: AuthDiagnosticDetailCode;
}

export interface DiagnosticOptions {
  /** Test-only deterministic values; production callers omit both. */
  now?: Date;
  diagnosticId?: string;
}

export interface DiagnosticWriteOptions {
  /** Offline-only transaction event trace; never a production input. */
  events?: string[];
}

type RawTuple = {
  principal_id: unknown;
  surface_id: unknown;
  surface_kind: unknown;
  surface_role: unknown;
  connection_class: unknown;
  connection_class_revision: unknown;
  revision_type: unknown;
  principal_status?: unknown;
  surface_state?: unknown;
};
type Tuple = {
  principal_id: string;
  surface_id: string;
  surface_kind: string;
  surface_role: string;
  connection_class: ConnectionClass;
  connection_class_revision: number;
};
type Snapshot = {
  ledgerHash: string;
  tupleHash: string;
  rows: RawTuple[];
  invalid: boolean;
  detail: AuthDiagnosticDetailCode | null;
  eligibleCount: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 0xffffffff) throw new Error('AUTH_DIAGNOSTIC_ENCODING_REFUSED');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([prefix, bytes]);
}

function encodedRow(fields: string[]): Buffer {
  return Buffer.concat(fields.map(lengthPrefixed));
}

function hashRows(rows: string[][]): string {
  const encoded = rows.map(encodedRow).sort(Buffer.compare);
  return createHash('sha256').update(Buffer.concat(encoded)).digest('hex');
}

function isClass(value: unknown): value is ConnectionClass {
  return typeof value === 'string' && (CONNECTION_CLASS_VALUES as readonly string[]).includes(value);
}

function canonicalRevision(raw: RawTuple): number | null {
  if (raw.revision_type !== 'integer' || !safeInteger(raw.connection_class_revision)) return null;
  const decimal = String(raw.connection_class_revision);
  if (!/^(?:0|[1-9][0-9]*)$/.test(decimal) || decimal === '0') return null;
  return raw.connection_class_revision;
}

function eligibleTuple(raw: RawTuple): { tuple: Tuple | null; invalid: boolean; detail: AuthDiagnosticDetailCode | null } {
  // Fixture operators are test-only rows. Exclude them before any class,
  // revision, kind, or role validation can poison the production diagnostic.
  if (raw.connection_class === 'fixture_operator') {
    return { tuple: null, invalid: false, detail: 'FIXTURE_OPERATOR_EXCLUDED' };
  }
  if (raw.principal_status !== undefined && raw.principal_status !== 'active') return { tuple: null, invalid: false, detail: 'INACTIVE_TUPLE' };
  if (raw.surface_state !== undefined && raw.surface_state !== 'active') return { tuple: null, invalid: false, detail: 'INACTIVE_TUPLE' };
  if (!isClass(raw.connection_class)) return { tuple: null, invalid: true, detail: raw.connection_class === 'diagnostic' && (raw.surface_kind === 'automation' || raw.surface_role === 'automation') ? 'AUTOMATION_EXCLUDED' : 'INVALID_CLASS_MAPPING' };
  if (raw.connection_class === 'none') return { tuple: null, invalid: false, detail: 'LEGACY_NONE_CLASS' };
  const revision = canonicalRevision(raw);
  if (revision === null) return { tuple: null, invalid: true, detail: 'INVALID_REVISION' };
  const kind = String(raw.surface_kind);
  const role = String(raw.surface_role);
  const valid = raw.connection_class === 'browser_bff'
    ? ['desktop', 'mobile'].includes(kind) && role === 'operator'
    : raw.connection_class === 'channel_dedicated' || raw.connection_class === 'benchmark_submit' || raw.connection_class === 'acceptance_submit'
      ? kind === 'http' && role === 'agent'
      : raw.connection_class === 'agent_node'
        ? ['desktop', 'mobile', 'http'].includes(kind) && role === 'agent'
        : raw.connection_class === 'diagnostic'
          ? kind !== 'automation' && role !== 'automation'
          : false;
  if (!valid) return { tuple: null, invalid: true, detail: raw.connection_class === 'diagnostic' && (kind === 'automation' || role === 'automation') ? 'AUTOMATION_EXCLUDED' : 'INVALID_CLASS_MAPPING' };
  if (typeof raw.principal_id !== 'string' || typeof raw.surface_id !== 'string' || typeof raw.surface_kind !== 'string' || typeof raw.surface_role !== 'string') {
    return { tuple: null, invalid: true, detail: 'INVALID_CLASS_MAPPING' };
  }
  return {
    tuple: {
      principal_id: raw.principal_id,
      surface_id: raw.surface_id,
      surface_kind: raw.surface_kind,
      surface_role: raw.surface_role,
      connection_class: raw.connection_class,
      connection_class_revision: revision,
    },
    invalid: false,
    detail: null,
  };
}

function tupleHash(rows: RawTuple[]): { hash: string; invalid: boolean; detail: AuthDiagnosticDetailCode | null; eligibleCount: number } {
  const eligible: string[][] = [];
  let invalid = false;
  let detail: AuthDiagnosticDetailCode | null = null;
  for (const row of rows) {
    const result = eligibleTuple(row);
    if (result.invalid) invalid = true;
    if (!detail && result.detail) detail = result.detail;
    if (result.tuple) {
      const tuple = result.tuple;
      eligible.push([
        tuple.principal_id,
        tuple.surface_id,
        tuple.surface_kind,
        tuple.surface_role,
        tuple.connection_class,
        String(tuple.connection_class_revision),
      ]);
    }
  }
  return { hash: hashRows(eligible), invalid, detail, eligibleCount: eligible.length };
}

function assertCollabLedger(db: Database.Database): string {
  assertCollabAuthIdentitySchema(db);
  const rows = db.prepare('SELECT id, checksum_sha256, applied_at FROM main.collab_auth_schema_migrations ORDER BY id COLLATE BINARY').all() as Array<{ id: string; checksum_sha256: string; applied_at: string }>;
  if (rows.length !== 1 || rows[0]?.id !== COLLAB_AUTH_IDENTITY_MIGRATION_ID || rows[0]?.checksum_sha256 !== COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM
    || !PHASE2A_UTC_ISO.test(rows[0]?.applied_at ?? '') || new Date(rows[0]!.applied_at).toISOString() !== rows[0]!.applied_at) throw new Error('AUTH_DIAGNOSTIC_LEDGER_REFUSED');
  return hashRows(rows.map((row) => [row.id, row.checksum_sha256, row.applied_at]));
}

export function captureCollabAuthSnapshot(db: Database.Database): Snapshot {
  const ledgerHash = assertCollabLedger(db);
  const rows = db.prepare(`
    SELECT p.id AS principal_id, s.surface_id, s.surface_kind, s.surface_role,
           s.connection_class, s.connection_class_revision,
           typeof(s.connection_class_revision) AS revision_type,
           p.status AS principal_status, s.state AS surface_state
      FROM main.surfaces s JOIN main.principals p ON p.id=s.principal_id
     ORDER BY s.surface_id COLLATE BINARY`).all() as RawTuple[];
  const projected = tupleHash(rows);
  return { ledgerHash, tupleHash: projected.hash, rows, invalid: projected.invalid, detail: projected.detail, eligibleCount: projected.eligibleCount };
}

export function captureStateAuthSnapshot(db: Database.Database): Snapshot {
  assertGatewayAuthIdentitySchema(db);
  const rows = db.prepare(`
    SELECT principal_id, surface_id, surface_kind, surface_role,
           connection_class, connection_class_revision,
           typeof(connection_class_revision) AS revision_type,
           state AS surface_state
      FROM main.gateway_surface_security
     ORDER BY surface_id COLLATE BINARY`).all() as RawTuple[];
  const projected = tupleHash(rows);
  return { ledgerHash: hashRows([]), tupleHash: projected.hash, rows, invalid: projected.invalid, detail: projected.detail, eligibleCount: projected.eligibleCount };
}

function chooseDetail(collab: Snapshot, state: Snapshot, status: AuthDiagnosticStatus): AuthDiagnosticDetailCode {
  const priority: AuthDiagnosticDetailCode[] = ['INVALID_REVISION', 'INVALID_CLASS_MAPPING', 'AUTOMATION_EXCLUDED'];
  for (const code of priority) if (collab.detail === code || state.detail === code) return code;
  if (collab.detail === 'FIXTURE_OPERATOR_EXCLUDED' || state.detail === 'FIXTURE_OPERATOR_EXCLUDED') return 'FIXTURE_OPERATOR_EXCLUDED';
  if (collab.eligibleCount === 0 && state.eligibleCount === 0) return 'ZERO_ELIGIBLE_TUPLES';
  for (const code of ['FIXTURE_OPERATOR_EXCLUDED', 'INACTIVE_TUPLE', 'LEGACY_NONE_CLASS'] as const) {
    if (collab.detail === code || state.detail === code) return code;
  }
  return status === 'MATCH' ? 'MATCH' : status === 'MISMATCH' ? 'HASH_MISMATCH' : 'ZERO_ELIGIBLE_TUPLES';
}

export function buildAuthReconciliationDiagnostic(
  collab: Snapshot,
  state: Snapshot,
  options: DiagnosticOptions = {},
): AuthDiagnosticRow {
  const status: AuthDiagnosticStatus = collab.invalid || state.invalid
    ? 'INVALID'
    : collab.tupleHash === state.tupleHash ? 'MATCH' : 'MISMATCH';
  const observed = (options.now ?? new Date()).toISOString();
  const diagnosticId = options.diagnosticId ?? randomUUID();
  if (!UUID.test(diagnosticId) || diagnosticId !== diagnosticId.toLowerCase() || !PHASE2A_UTC_ISO.test(observed)
    || !PHASE2A_HASH_HEX.test(collab.ledgerHash) || !PHASE2A_HASH_HEX.test(collab.tupleHash) || !PHASE2A_HASH_HEX.test(state.tupleHash)) throw new Error('AUTH_DIAGNOSTIC_FORMAT_REFUSED');
  return {
    diagnostic_id: diagnosticId,
    non_authoritative: 1,
    status,
    collab_auth_ledger_sha256: collab.ledgerHash,
    collab_tuple_sha256: collab.tupleHash,
    state_projection_sha256: state.tupleHash,
    observed_at: observed,
    detail_code: chooseDetail(collab, state, status),
  };
}

export function writeAuthReconciliationDiagnostic(db: Database.Database, row: AuthDiagnosticRow, options?: DiagnosticWriteOptions): void {
  if (row.non_authoritative !== 1 || !UUID.test(row.diagnostic_id) || row.diagnostic_id !== row.diagnostic_id.toLowerCase()
    || !PHASE2A_UTC_ISO.test(row.observed_at) || new Date(row.observed_at).toISOString() !== row.observed_at
    || !['MATCH', 'MISMATCH', 'INVALID'].includes(row.status)
    || !AUTH_DIAGNOSTIC_DETAIL_CODES.includes(row.detail_code) || !PHASE2A_HASH_HEX.test(row.collab_auth_ledger_sha256)
    || !PHASE2A_HASH_HEX.test(row.collab_tuple_sha256) || !PHASE2A_HASH_HEX.test(row.state_projection_sha256)) throw new Error('AUTH_DIAGNOSTIC_FORMAT_REFUSED');
  db.exec('BEGIN IMMEDIATE');
  options?.events?.push('state:DIAGNOSTIC BEGIN IMMEDIATE');
  try {
    // Revalidate the complete ledger and catalog under the same write lock as
    // the evidence insert. A permissive or drifted diagnostics table is never
    // sufficient to accept a diagnostic row.
    assertGatewayAuthIdentitySchema(db);
    db.prepare(`INSERT INTO main.auth_reconciliation_diagnostics
      (diagnostic_id,non_authoritative,status,collab_auth_ledger_sha256,collab_tuple_sha256,state_projection_sha256,observed_at,detail_code)
      VALUES (?,?,?,?,?,?,?,?)`).run(row.diagnostic_id, 1, row.status, row.collab_auth_ledger_sha256, row.collab_tuple_sha256, row.state_projection_sha256, row.observed_at, row.detail_code);
    db.exec('COMMIT');
    options?.events?.push('state:DIAGNOSTIC COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); options?.events?.push('state:DIAGNOSTIC ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  }
}

/** Read collab, then state, and write one evidence-only diagnostic. */
export function runAuthReconciliationDiagnostic(
  collabDb: Database.Database,
  stateDb: Database.Database,
  options: DiagnosticOptions = {},
): AuthDiagnosticRow {
  const collab = captureCollabAuthSnapshot(collabDb);
  const state = captureStateAuthSnapshot(stateDb);
  const diagnostic = buildAuthReconciliationDiagnostic(collab, state, options);
  writeAuthReconciliationDiagnostic(stateDb, diagnostic);
  return diagnostic;
}
