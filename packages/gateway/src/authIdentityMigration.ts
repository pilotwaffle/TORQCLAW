import type Database from 'better-sqlite3';
import {
  GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM,
  GATEWAY_AUTH_IDENTITY_MIGRATION_ID,
  GATEWAY_AUTH_IDENTITY_MIGRATION_SQL,
  PHASE2A_HASH_HEX,
  PHASE2A_UTC_ISO,
  GATEWAY_AUTH_IDENTITY_STEP_MANIFEST,
  phase2aMigrationChecksum,
  serializeAuthPhase2AProgram,
} from './authPhase2AConstants.js';
import { readAuthRuntimeMarker } from './authRuntimeMarker.js';

export class GatewayAuthIdentityMigrationError extends Error {
  readonly code = 'GATEWAY_AUTH_IDENTITY_MIGRATION_REFUSED';
  constructor() {
    super('GATEWAY_AUTH_IDENTITY_MIGRATION_REFUSED');
    this.name = 'GatewayAuthIdentityMigrationError';
  }
}

export interface GatewayAuthIdentityMigrationTestOptions {
  /** Test-only fault after a DDL/receipt boundary. */
  failAfterStatement?: number;
  /** Test-only execution trace; never a production input. */
  trace?: string[];
  /** Offline-only transaction event trace; never a production input. */
  events?: string[];
}

type Column = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type Receipt = { id: string; checksum_sha256: string; applied_at: string };
const SECURITY_BASE_SQL = `CREATE TABLE gateway_surface_security (
    surface_id                      TEXT PRIMARY KEY,
    principal_id                    TEXT NOT NULL,
    surface_kind                    TEXT NOT NULL CHECK (surface_kind IN
                                      ('desktop','mobile','http','telegram','slack','automation')),
    surface_role                    TEXT NOT NULL
                                      CHECK (surface_role IN ('operator','agent','automation')),
    state                           TEXT NOT NULL DEFAULT 'revoked'
                                      CHECK (state IN ('active','revoked')),
    auth_epoch                      INTEGER NOT NULL CHECK (auth_epoch > 0),
    allowed_capability_classes_json TEXT NOT NULL DEFAULT '[]',
    allowed_operation_ids_json      TEXT NOT NULL DEFAULT '[]',
    capability_revision             INTEGER NOT NULL CHECK (capability_revision > 0),
    source_identity_revision        TEXT NOT NULL,
    activated_at                    DATETIME,
    revoked_at                      DATETIME
)`;
const SECURITY_P2A_SQL = SECURITY_BASE_SQL.slice(0, -1) + ", connection_class TEXT NOT NULL DEFAULT 'none' CHECK(connection_class IN ('none','browser_bff','channel_dedicated','agent_node','diagnostic','benchmark_submit','acceptance_submit','fixture_operator')), connection_class_revision INTEGER NOT NULL DEFAULT 1 CHECK(connection_class_revision > 0))";
const fail = (): never => { throw new GatewayAuthIdentityMigrationError(); };

function statementFault(options: GatewayAuthIdentityMigrationTestOptions | undefined, count: number): void {
  if (options?.failAfterStatement === count) throw new Error('GATEWAY_AUTH_IDENTITY_TEST_FAULT');
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(name));
}

function readReceipts(db: Database.Database): Receipt[] {
  return db.prepare('SELECT id, checksum_sha256, applied_at FROM main.gateway_schema_migrations ORDER BY id COLLATE BINARY').all() as Receipt[];
}

function assertLedgerState(db: Database.Database): 'foundation' | 'phase2a' {
  const rows = readReceipts(db);
  if (rows.length !== 1 && rows.length !== 2) fail();
  const foundation = rows.find((row) => row.id === 'gateway-auth-foundation-001');
  if (!foundation || foundation.checksum_sha256 !== 'd92ae5f9cb4c4dec6fc300b2cb2f226d1743c9d70be89868dc37698a1be6d5df'
    || !PHASE2A_UTC_ISO.test(foundation.applied_at) || new Date(foundation.applied_at).toISOString() !== foundation.applied_at) fail();
  if (rows.length === 1) return 'foundation';
  const phase2a = rows.find((row) => row.id === GATEWAY_AUTH_IDENTITY_MIGRATION_ID);
  if (!phase2a || phase2a.checksum_sha256 !== GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM
    || !PHASE2A_UTC_ISO.test(phase2a.applied_at) || new Date(phase2a.applied_at).toISOString() !== phase2a.applied_at) fail();
  return 'phase2a';
}

function securityColumns(db: Database.Database): { hasClass: boolean; hasRevision: boolean } {
  if (!tableExists(db, 'gateway_surface_security')) fail();
  const columns = db.prepare('PRAGMA main.table_info(gateway_surface_security)').all() as Column[];
  const byName = new Map(columns.map((column) => [column.name, column]));
  const required = ['surface_id', 'principal_id', 'surface_kind', 'surface_role', 'state'];
  if (required.some((name) => !byName.has(name))) fail();
  const klass = byName.get('connection_class');
  const revision = byName.get('connection_class_revision');
  if (klass && (klass.cid !== 12 || klass.type !== 'TEXT' || klass.notnull !== 1 || klass.dflt_value !== "'none'" || klass.pk !== 0)) fail();
  if (revision && (revision.cid !== 13 || revision.type !== 'INTEGER' || revision.notnull !== 1 || revision.dflt_value !== '1' || revision.pk !== 0)) fail();
  return { hasClass: Boolean(klass), hasRevision: Boolean(revision) };
}

function assertSecurityBase(db: Database.Database, phase2a: boolean): void {
  if (!tableExists(db, 'gateway_surface_security')) fail();
  const columns = db.prepare('PRAGMA main.table_info(gateway_surface_security)').all() as Column[];
  const expected: Array<[number, string, string, number, string | null, number]> = [
    [0, 'surface_id', 'TEXT', 0, null, 1], [1, 'principal_id', 'TEXT', 1, null, 0], [2, 'surface_kind', 'TEXT', 1, null, 0], [3, 'surface_role', 'TEXT', 1, null, 0], [4, 'state', 'TEXT', 1, "'revoked'", 0], [5, 'auth_epoch', 'INTEGER', 1, null, 0], [6, 'allowed_capability_classes_json', 'TEXT', 1, "'[]'", 0], [7, 'allowed_operation_ids_json', 'TEXT', 1, "'[]'", 0], [8, 'capability_revision', 'INTEGER', 1, null, 0], [9, 'source_identity_revision', 'TEXT', 1, null, 0], [10, 'activated_at', 'DATETIME', 0, null, 0], [11, 'revoked_at', 'DATETIME', 0, null, 0],
  ];
  if (phase2a) expected.push([12, 'connection_class', 'TEXT', 1, "'none'", 0], [13, 'connection_class_revision', 'INTEGER', 1, '1', 0]);
  if (columns.length !== expected.length || columns.some((column, i) => [column.cid, column.name, column.type, column.notnull, column.dflt_value, column.pk].some((value, j) => value !== expected[i]![j]))) fail();
  const catalog = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='gateway_surface_security'").get() as { sql: string | null } | undefined;
  if (!catalog || (!phase2a && catalog.sql !== SECURITY_BASE_SQL) || (phase2a && catalog.sql !== SECURITY_P2A_SQL)) fail();
  const indexes = db.prepare("PRAGMA main.index_list('gateway_surface_security')").all() as Array<{ name: string; unique: number; origin: string; partial: number }>;
  if (phase2a ? indexes.length !== 2 : indexes.length !== 1) fail();
  if (!indexes.some((row) => row.name === 'sqlite_autoindex_gateway_surface_security_1' && row.unique === 1 && row.origin === 'pk' && row.partial === 0)) fail();
  if (phase2a && !indexes.some((row) => row.name === 'idx_gateway_surface_security_v2_tuple' && row.unique === 1 && row.origin === 'c' && row.partial === 0)) fail();
  if ((db.prepare("PRAGMA main.foreign_key_list('gateway_surface_security')").all() as unknown[]).length !== 0) fail();
  const extras = db.prepare("SELECT type,name FROM main.sqlite_schema WHERE tbl_name='gateway_surface_security' AND type IN ('trigger','index') AND name NOT IN ('sqlite_autoindex_gateway_surface_security_1','idx_gateway_surface_security_v2_tuple')").all() as unknown[];
  if (extras.length !== 0) fail();
}

function assertSecurityIndex(db: Database.Database): void {
  const rows = db.prepare("PRAGMA main.index_list('gateway_surface_security')").all() as Array<{ seq: number; name: string; unique: number; origin: string; partial: number }>;
  if (rows.length !== 2
    || !rows.some((row) => row.name === 'sqlite_autoindex_gateway_surface_security_1' && row.unique === 1 && row.origin === 'pk' && row.partial === 0)) fail();
  const index = rows.find((row) => row.name === 'idx_gateway_surface_security_v2_tuple');
  if (!index || index.unique !== 1 || index.origin !== 'c' || index.partial !== 0) fail();
  const columns = db.prepare("PRAGMA main.index_info('idx_gateway_surface_security_v2_tuple')").all() as Array<{ seqno: number; name: string }>;
  const names = columns.sort((a, b) => a.seqno - b.seqno).map((row) => row.name).join('|');
  if (names !== 'surface_id|surface_kind|surface_role|connection_class|connection_class_revision') fail();
  const catalog = db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE lower(name)='idx_gateway_surface_security_v2_tuple' OR lower(tbl_name)='idx_gateway_surface_security_v2_tuple'").all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  if (catalog.length !== 1 || catalog[0]?.type !== 'index' || catalog[0]?.name !== 'idx_gateway_surface_security_v2_tuple'
    || catalog[0]?.tbl_name !== 'gateway_surface_security'
    || catalog[0]?.sql !== 'CREATE UNIQUE INDEX idx_gateway_surface_security_v2_tuple ON gateway_surface_security(surface_id,surface_kind,surface_role,connection_class,connection_class_revision)') fail();
}

function assertDiagnosticsTable(db: Database.Database): void {
  if (!tableExists(db, 'auth_reconciliation_diagnostics')) fail();
  const columns = db.prepare('PRAGMA main.table_info(auth_reconciliation_diagnostics)').all() as Column[];
  const expected: Array<[number, string, string, number, string | null, number]> = [
    [0, 'diagnostic_id', 'TEXT', 0, null, 1],
    [1, 'non_authoritative', 'INTEGER', 1, null, 0],
    [2, 'status', 'TEXT', 1, null, 0],
    [3, 'collab_auth_ledger_sha256', 'TEXT', 1, null, 0],
    [4, 'collab_tuple_sha256', 'TEXT', 1, null, 0],
    [5, 'state_projection_sha256', 'TEXT', 1, null, 0],
    [6, 'observed_at', 'TEXT', 1, null, 0],
    [7, 'detail_code', 'TEXT', 1, null, 0],
  ];
  if (columns.length !== expected.length || columns.some((column, i) => {
    const want = expected[i]!;
    return [column.cid, column.name, column.type, column.notnull, column.dflt_value, column.pk]
      .some((value, j) => value !== want[j]);
  })) fail();
  const catalog = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='auth_reconciliation_diagnostics'").get() as { sql: string | null } | undefined;
  const expectedCatalog = "CREATE TABLE auth_reconciliation_diagnostics (\n  diagnostic_id TEXT PRIMARY KEY,\n  non_authoritative INTEGER NOT NULL CHECK(non_authoritative=1),\n  status TEXT NOT NULL CHECK(status IN ('MATCH','MISMATCH','INVALID')),\n  collab_auth_ledger_sha256 TEXT NOT NULL,\n  collab_tuple_sha256 TEXT NOT NULL,\n  state_projection_sha256 TEXT NOT NULL,\n  observed_at TEXT NOT NULL,\n  detail_code TEXT NOT NULL\n)";
  if (!catalog || catalog.sql !== expectedCatalog) fail();
  const indexes = db.prepare("PRAGMA main.index_list('auth_reconciliation_diagnostics')").all() as Array<{ name: string; unique: number }>;
  if (indexes.length !== 2 || !indexes.some((row) => row.name === 'sqlite_autoindex_auth_reconciliation_diagnostics_1' && row.unique === 1)
    || !indexes.some((row) => row.name === 'idx_auth_reconciliation_diagnostics_observed' && row.unique === 0)) fail();
  const info = db.prepare("PRAGMA main.index_info('idx_auth_reconciliation_diagnostics_observed')").all() as Array<{ seqno: number; name: string }>;
  if (info.length !== 1 || info[0]?.seqno !== 0 || info[0]?.name !== 'observed_at') fail();
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_schema
    WHERE lower(name)='auth_reconciliation_diagnostics' OR lower(tbl_name)='auth_reconciliation_diagnostics'
    ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  if (objects.length !== 3
    || !objects.some((row) => row.type === 'table' && row.name === 'auth_reconciliation_diagnostics' && row.tbl_name === 'auth_reconciliation_diagnostics')
    || !objects.some((row) => row.type === 'index' && row.name === 'sqlite_autoindex_auth_reconciliation_diagnostics_1' && row.sql === null)
    || !objects.some((row) => row.type === 'index' && row.name === 'idx_auth_reconciliation_diagnostics_observed' && row.sql === 'CREATE INDEX idx_auth_reconciliation_diagnostics_observed ON auth_reconciliation_diagnostics(observed_at)')) fail();
  if ((db.prepare("PRAGMA main.foreign_key_list('auth_reconciliation_diagnostics')").all() as unknown[]).length !== 0) fail();
}

function phase2aObjectPresence(db: Database.Database): string[] {
  const objects = db.prepare(`SELECT type,name,tbl_name FROM main.sqlite_schema
    WHERE lower(name) IN ('connection_class','connection_class_revision','idx_gateway_surface_security_v2_tuple','auth_reconciliation_diagnostics','idx_auth_reconciliation_diagnostics_observed')
       OR lower(tbl_name) IN ('idx_gateway_surface_security_v2_tuple','auth_reconciliation_diagnostics')
    ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`).all() as Array<{ type: string; name: string; tbl_name: string }>;
  const columns = db.prepare('PRAGMA main.table_info(gateway_surface_security)').all() as Array<{ name: string }>;
  const indexes = db.prepare("PRAGMA main.index_list('gateway_surface_security')").all() as Array<{ name: string }>;
  return [...objects.map((row) => `${row.type}:${row.name}:${row.tbl_name}`),
    ...columns.filter((row) => row.name === 'connection_class' || row.name === 'connection_class_revision').map((row) => `column:${row.name}`),
    ...indexes.filter((row) => row.name !== 'sqlite_autoindex_gateway_surface_security_1').map((row) => `surface-index:${row.name}`)].sort();
}

export function assertGatewayAuthIdentitySchema(db: Database.Database): void {
  // The diagnostic writer runs this assertion after BEGIN IMMEDIATE. Reuse
  // the authoritative Phase 1 fence here so that the same lock covers the
  // exact foundation catalog, shape, marker row, and accepted ledger set;
  // Phase2A-only validation is not sufficient to protect the insert.
  if (readAuthRuntimeMarker(db).state !== 'v1') fail();
  assertSecurityBase(db, true);
  const columns = securityColumns(db);
  if (!columns.hasClass || !columns.hasRevision) fail();
  assertSecurityIndex(db);
  assertDiagnosticsTable(db);
  if (assertLedgerState(db) !== 'phase2a') fail();
}

/** Apply the state-side Phase 2A migration under one immediate transaction. */
export function runGatewayAuthIdentityMigration(
  db: Database.Database,
  options?: GatewayAuthIdentityMigrationTestOptions,
): 'migrated' | 'noop' {
  let inTransaction = false;
  let statements = 0;
  try {
    if (phase2aMigrationChecksum(GATEWAY_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(GATEWAY_AUTH_IDENTITY_STEP_MANIFEST)) !== GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM) fail();
    const marker = readAuthRuntimeMarker(db);
    if (marker.state !== 'v1') fail();
    const ledger = assertLedgerState(db);
    const beforeColumns = securityColumns(db);
    assertSecurityBase(db, ledger === 'phase2a');
    const hasDiagnostics = tableExists(db, 'auth_reconciliation_diagnostics');
    const beforeObjects = phase2aObjectPresence(db);
    if (ledger === 'phase2a') {
      if (!beforeColumns.hasClass || !beforeColumns.hasRevision || !hasDiagnostics) fail();
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      options?.events?.push('state:BEGIN IMMEDIATE');
      assertGatewayAuthIdentitySchema(db);
      db.exec('COMMIT');
      inTransaction = false;
      options?.events?.push('state:COMMIT');
      return 'noop';
    }
    if (beforeColumns.hasClass !== beforeColumns.hasRevision) fail();
    // A diagnostics table without the two projection columns is a partial
    // Phase 2A state. It is never repaired or completed by this migration.
    if (hasDiagnostics && !beforeColumns.hasClass) fail();
    if (beforeObjects.length !== 0) fail();

    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    options?.events?.push('state:BEGIN IMMEDIATE');
    const afterMarker = readAuthRuntimeMarker(db);
    if (afterMarker.state !== 'v1' || assertLedgerState(db) !== 'foundation') fail();
    const lockedColumns = securityColumns(db);
    assertSecurityBase(db, false);
    if (lockedColumns.hasClass !== lockedColumns.hasRevision || lockedColumns.hasClass !== beforeColumns.hasClass) fail();
    if (phase2aObjectPresence(db).length !== 0) fail();
    if (lockedColumns.hasClass || hasDiagnostics) fail();
    for (const step of GATEWAY_AUTH_IDENTITY_STEP_MANIFEST) {
      options?.trace?.push(step.name);
      if (step.kind === 'assert') {
        switch (step.name) {
          case 'gateway-current-foundation': assertSecurityBase(db, false); if (assertLedgerState(db) !== 'foundation' || phase2aObjectPresence(db).length !== 0) fail(); break;
          case 'gateway-post-schema-before-receipt': assertSecurityBase(db, true); assertDiagnosticsTable(db); if (assertLedgerState(db) !== 'foundation') fail(); break;
          case 'gateway-foundation-receipt-only': if (assertLedgerState(db) !== 'foundation') fail(); break;
          case 'gateway-post-schema-with-receipt': assertGatewayAuthIdentitySchema(db); break;
          default: fail();
        }
      } else if (step.kind === 'ddl') {
        db.exec(step.payload);
      } else if (step.kind === 'receipt-boundary') {
        const now = new Date().toISOString();
        db.prepare('INSERT INTO main.gateway_schema_migrations(id, checksum_sha256, applied_at) VALUES (?,?,?)')
          .run(GATEWAY_AUTH_IDENTITY_MIGRATION_ID, GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM, now);
      } else {
        fail();
      }
      statements += 1;
      statementFault(options, statements);
    }
    db.exec('COMMIT');
    inTransaction = false;
    options?.events?.push('state:COMMIT');
    return 'migrated';
  } catch (error) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); options?.events?.push('state:ROLLBACK'); } catch { /* preserve original error */ }
    }
    throw error;
  }
}

export { GATEWAY_AUTH_IDENTITY_MIGRATION_ID, GATEWAY_AUTH_IDENTITY_MIGRATION_SQL, GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM };
export { PHASE2A_HASH_HEX };
export { SECURITY_BASE_SQL, SECURITY_P2A_SQL };
export {
  AUTH_PHASE2A_GOLDEN_VECTORS,
  COLLAB_AUTH_IDENTITY_PROGRAM_UTF8_HEX,
  GATEWAY_AUTH_IDENTITY_GOLDEN_VECTOR,
  phase2aMigrationChecksum,
  serializeAuthPhase2AProgram,
} from './authPhase2AConstants.js';
