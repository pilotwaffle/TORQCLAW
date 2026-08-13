import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

// Kept literal in this foundation module so the direct Node/strip-types
// Phase 1 worker path has no Phase 2A module-resolution dependency.
const GATEWAY_AUTH_IDENTITY_MIGRATION_ID = 'gateway-auth-identity-reconciliation-002';
const GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM = 'b0fc3b85b8851a1f3f79615f0270e056c4fdd3992e1d89973250dbf9506b0028';
const PHASE2A_SECURITY_INDEX_SQL = 'CREATE UNIQUE INDEX idx_gateway_surface_security_v2_tuple ON gateway_surface_security(surface_id,surface_kind,surface_role,connection_class,connection_class_revision)';
const PHASE2A_SECURITY_TABLE_SQL = `CREATE TABLE gateway_surface_security (
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
, connection_class TEXT NOT NULL DEFAULT 'none' CHECK(connection_class IN ('none','browser_bff','channel_dedicated','agent_node','diagnostic','benchmark_submit','acceptance_submit','fixture_operator')), connection_class_revision INTEGER NOT NULL DEFAULT 1 CHECK(connection_class_revision > 0))`;
const PHASE2A_DIAGNOSTIC_TABLE_SQL = "CREATE TABLE auth_reconciliation_diagnostics (\n  diagnostic_id TEXT PRIMARY KEY,\n  non_authoritative INTEGER NOT NULL CHECK(non_authoritative=1),\n  status TEXT NOT NULL CHECK(status IN ('MATCH','MISMATCH','INVALID')),\n  collab_auth_ledger_sha256 TEXT NOT NULL,\n  collab_tuple_sha256 TEXT NOT NULL,\n  state_projection_sha256 TEXT NOT NULL,\n  observed_at TEXT NOT NULL,\n  detail_code TEXT NOT NULL\n)";
const PHASE2A_DIAGNOSTIC_INDEX_SQL = 'CREATE INDEX idx_auth_reconciliation_diagnostics_observed ON auth_reconciliation_diagnostics(observed_at)';

/**
 * Phase 1 foundation marker and downgrade fence.
 *
 * This module is deliberately state-only.  It does not open collab.db, does
 * not parse a V2 connection, and does not provide any authority to callers.
 * The read fence must run immediately after the state Database constructor,
 * before writable pragmas or the legacy gateway schema are touched.
 */

export const AUTH_FOUNDATION_MIGRATION_ID = 'gateway-auth-foundation-001';

/** Canonical LF-normalized SQL bytes owned by this Phase 1 migration. */
export const FOUNDATION_GATEWAY_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256)=64 AND checksum_sha256 GLOB '[0-9a-f]*'),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_runtime_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state_schema INTEGER NOT NULL CHECK(state_schema IN (1,2)),
  mode TEXT NOT NULL CHECK(mode IN ('V1_COMPAT','V2_TEST','V2_FINAL')),
  launcher_generation INTEGER CHECK(launcher_generation > 0),
  serving_state TEXT CHECK(serving_state IN ('STOPPED','VERIFYING','SERVING','FAILED')),
  config_digest_sha256 TEXT,
  secret_set_id TEXT,
  cutover_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK(
    (state_schema=1 AND mode='V1_COMPAT' AND launcher_generation IS NULL
      AND serving_state IS NULL AND config_digest_sha256 IS NULL
      AND secret_set_id IS NULL AND cutover_id IS NULL)
    OR
    (state_schema=2 AND launcher_generation > 0 AND serving_state IS NOT NULL
      AND config_digest_sha256 IS NOT NULL AND secret_set_id IS NOT NULL)
  )
);`;

/** Checked-in receipt for migration-id + LF + canonical SQL bytes. */
export const AUTH_FOUNDATION_MIGRATION_CHECKSUM = 'd92ae5f9cb4c4dec6fc300b2cb2f226d1743c9d70be89868dc37698a1be6d5df';

export const AUTH_RUNTIME_MARKER_INCOMPATIBLE = 'AUTH_RUNTIME_MARKER_INCOMPATIBLE';
export const AUTH_RUNTIME_MARKER_ATTACHED_DB = 'AUTH_RUNTIME_MARKER_ATTACHED_DB';
export const AUTH_RUNTIME_MARKER_TEMP_SHADOW = 'AUTH_RUNTIME_MARKER_TEMP_SHADOW';

export type AuthRuntimeFenceState = 'legacy' | 'v1';

export interface AuthRuntimeMarker {
  singleton: 1;
  state_schema: 1;
  mode: 'V1_COMPAT';
  launcher_generation: null;
  serving_state: null;
  config_digest_sha256: null;
  secret_set_id: null;
  cutover_id: null;
  updated_at: string;
}

export interface AuthRuntimeFenceResult {
  state: AuthRuntimeFenceState;
}

export interface AuthRuntimeTrace {
  state: AuthRuntimeFenceState | 'incompatible';
  steps: string[];
}

export class AuthRuntimeMarkerError extends Error {
  readonly code: typeof AUTH_RUNTIME_MARKER_INCOMPATIBLE | typeof AUTH_RUNTIME_MARKER_ATTACHED_DB | typeof AUTH_RUNTIME_MARKER_TEMP_SHADOW;

  constructor(code: typeof AUTH_RUNTIME_MARKER_INCOMPATIBLE | typeof AUTH_RUNTIME_MARKER_ATTACHED_DB | typeof AUTH_RUNTIME_MARKER_TEMP_SHADOW = AUTH_RUNTIME_MARKER_INCOMPATIBLE) {
    super(code);
    this.code = code;
    this.name = code;
  }
}

export interface MigrationTestOptions {
  /** Inject a deterministic failure after the Nth migration statement. */
  failAfterStatement?: number;
}

function fail(code: typeof AUTH_RUNTIME_MARKER_INCOMPATIBLE | typeof AUTH_RUNTIME_MARKER_ATTACHED_DB | typeof AUTH_RUNTIME_MARKER_TEMP_SHADOW = AUTH_RUNTIME_MARKER_INCOMPATIBLE): never {
  throw new AuthRuntimeMarkerError(code);
}

const FOUNDATION_TABLE_NAMES = ['gateway_schema_migrations', 'auth_runtime_state'] as const;
type FoundationTableName = (typeof FOUNDATION_TABLE_NAMES)[number];

function asciiFold(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    result += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char;
  }
  return result;
}

function quotedIdentifier(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function expectedTableSql(name: 'gateway_schema_migrations' | 'auth_runtime_state'): string {
  const statements = FOUNDATION_GATEWAY_MIGRATION_SQL.split('\n\n');
  const statement = statements.find((candidate) => candidate.includes(` ${name} `));
  if (!statement) throw new Error('Phase 1 SQL constant is incomplete');
  const prefix = 'CREATE TABLE IF NOT EXISTS ';
  if (!statement.startsWith(prefix) || !statement.endsWith(';')) throw new Error('Phase 1 SQL constant is not canonical');
  return `CREATE TABLE ${statement.slice(prefix.length, -1)}`;
}

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };

function databaseList(db: Database.Database): Array<{ seq: number; name: string; file: string }> {
  return db.pragma('database_list') as Array<{ seq: number; name: string; file: string }>;
}

function schemaInventory(db: Database.Database): { main: SchemaObject[]; temp: SchemaObject[] } {
  const predicate = `WHERE lower(name) IN ('gateway_schema_migrations','auth_runtime_state')
      OR lower(tbl_name) IN ('gateway_schema_migrations','auth_runtime_state')
     ORDER BY type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY`;
  const main = db.prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema ${predicate}`).all() as SchemaObject[];
  const temp = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_temp_schema ${predicate}`).all() as SchemaObject[];
  return { main, temp };
}

function assertDatabaseTopology(db: Database.Database, trace: string[]): void {
  trace.push('database-list');
  const attached = databaseList(db);
  if (
    attached.length < 1
    || attached[0]?.seq !== 0
    || attached[0]?.name !== 'main'
    || attached.slice(1).some((entry) => entry.name !== 'temp' || entry.file !== '')
  ) fail(AUTH_RUNTIME_MARKER_ATTACHED_DB);
}

function reservedCollision(row: SchemaObject): boolean {
  const foldedName = asciiFold(row.name);
  const foldedTable = asciiFold(row.tbl_name);
  return FOUNDATION_TABLE_NAMES.some((name) => {
    const folded = asciiFold(name);
    return foldedName === folded || foldedTable === folded;
  });
}

function validateSchemaInventory(
  inventory: { main: SchemaObject[]; temp: SchemaObject[] },
  trace: string[],
  requireFoundation: boolean,
): void {
  trace.push('schema-inventory');
  if (inventory.temp.length !== 0) fail(AUTH_RUNTIME_MARKER_TEMP_SHADOW);
  const collisions = inventory.main.filter(reservedCollision);
  if (!requireFoundation) {
    if (collisions.length !== 0) fail();
    return;
  }
  const allowed = new Set([
    'gateway_schema_migrations:table:gateway_schema_migrations',
    'auth_runtime_state:table:auth_runtime_state',
    'gateway_schema_migrations:index:sqlite_autoindex_gateway_schema_migrations_1',
  ]);
  for (const row of collisions) {
    if (!allowed.has(`${row.tbl_name}:${row.type}:${row.name}`)) fail();
    if (row.name === 'sqlite_autoindex_gateway_schema_migrations_1' && row.sql !== null) fail();
  }
  if (collisions.length !== 3) fail();
}

function pragmaRows<T>(db: Database.Database, pragma: string, name: string): T[] {
  return db.prepare(`PRAGMA main.${pragma}(${quotedIdentifier(name)})`).all() as T[];
}

function validateTablePragmas(db: Database.Database, name: FoundationTableName, trace: string[]): void {
  trace.push(`table-info:${name}`);
  const columns = pragmaRows<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(db, 'table_info', name);
  const expected = name === 'gateway_schema_migrations'
    ? [[0, 'id', 'TEXT', 0, null, 1], [1, 'checksum_sha256', 'TEXT', 1, null, 0], [2, 'applied_at', 'TEXT', 1, null, 0]]
    : [[0, 'singleton', 'INTEGER', 0, null, 1], [1, 'state_schema', 'INTEGER', 1, null, 0], [2, 'mode', 'TEXT', 1, null, 0], [3, 'launcher_generation', 'INTEGER', 0, null, 0], [4, 'serving_state', 'TEXT', 0, null, 0], [5, 'config_digest_sha256', 'TEXT', 0, null, 0], [6, 'secret_set_id', 'TEXT', 0, null, 0], [7, 'cutover_id', 'TEXT', 0, null, 0], [8, 'updated_at', 'TEXT', 1, null, 0]];
  if (columns.length !== expected.length || columns.some((column, index) => {
    const want = expected[index]!;
    return [column.cid, column.name, column.type, column.notnull, column.dflt_value, column.pk].some((value, i) => value !== want[i]);
  })) fail();
  trace.push(`index-list:${name}`);
  const indexes = pragmaRows<{ seq: number; name: string; unique: number; origin: string; partial: number }>(db, 'index_list', name);
  if (name === 'auth_runtime_state') {
    if (indexes.length !== 0) fail();
    trace.push(`foreign-key-list:${name}`);
    if (pragmaRows(db, 'foreign_key_list', name).length !== 0) fail();
    return;
  }
  const indexName = `sqlite_autoindex_${name}_1`;
  if (indexes.length !== 1 || indexes[0]?.seq !== 0 || indexes[0]?.name !== indexName || indexes[0]?.unique !== 1 || indexes[0]?.origin !== 'pk' || indexes[0]?.partial !== 0) fail();
  trace.push(`index-info:${name}`);
  const indexInfo = pragmaRows<{ seqno: number; cid: number; name: string }>(db, 'index_info', indexName);
  const pkColumn = name === 'gateway_schema_migrations' ? 'id' : 'singleton';
  if (indexInfo.length !== 1 || indexInfo[0]?.seqno !== 0 || indexInfo[0]?.cid !== 0 || indexInfo[0]?.name !== pkColumn) fail();
  trace.push(`foreign-key-list:${name}`);
  if (pragmaRows(db, 'foreign_key_list', name).length !== 0) fail();
}

function validateFoundationSchema(db: Database.Database, trace: string[]): void {
  assertDatabaseTopology(db, trace);
  const inventory = schemaInventory(db);
  validateSchemaInventory(inventory, trace, true);
  trace.push('catalog-sql');
  for (const name of FOUNDATION_TABLE_NAMES) {
    const rows = inventory.main.filter((row) => row.type === 'table' && row.name === name && row.tbl_name === name);
    if (rows.length !== 1 || rows[0]!.sql !== expectedTableSql(name)) fail();
    validateTablePragmas(db, name, trace);
  }
}

function validateFoundation(db: Database.Database, trace: string[]): void {
  validateFoundationSchema(db, trace);
  trace.push('marker-select');
  if (readV1Marker(db) === null) fail();
  trace.push('ledger-select');
  if (!readFoundationReceipt(db)) fail();
}

function validateState(db: Database.Database, trace: string[]): AuthRuntimeFenceResult {
  assertDatabaseTopology(db, trace);
  const inventory = schemaInventory(db);
  if (phase2aTempReservedObjects(db).length !== 0) fail(AUTH_RUNTIME_MARKER_TEMP_SHADOW);
  const hasLedger = inventory.main.some((row) => row.type === 'table' && row.name === 'gateway_schema_migrations');
  const hasMarker = inventory.main.some((row) => row.type === 'table' && row.name === 'auth_runtime_state');
  validateSchemaInventory(inventory, trace, hasLedger && hasMarker);
  if (!hasLedger && !hasMarker) {
    return { state: 'legacy' };
  }
  if (!hasLedger || !hasMarker) fail();
  validateFoundation(db, trace);
  const ledgerState = readLedgerState(db);
  if (ledgerState === 'foundation') {
    if (phase2aReservedObjects(db).length !== 0 || phase2aColumnPresence(db).length !== 0) fail();
  } else if (ledgerState === 'phase2a') {
    validatePhase2ASchema(db, trace);
  } else {
    fail();
  }
  return { state: 'v1' };
}

function isUtcIso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function readV1Marker(db: Database.Database): AuthRuntimeMarker | null {
  const rows = db.prepare(
    `SELECT singleton, state_schema, mode, launcher_generation,
            serving_state, config_digest_sha256, secret_set_id, cutover_id, updated_at
       FROM main.auth_runtime_state`,
  ).all() as AuthRuntimeMarker[];
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (
    row.singleton !== 1
    || row.state_schema !== 1
    || row.mode !== 'V1_COMPAT'
    || row.launcher_generation !== null
    || row.serving_state !== null
    || row.config_digest_sha256 !== null
    || row.secret_set_id !== null
    || row.cutover_id !== null
    || !isUtcIso(row.updated_at)
  ) return null;
  return row;
}

function readFoundationReceipt(db: Database.Database): boolean {
  const rows = db.prepare(
    `SELECT id, checksum_sha256, applied_at FROM main.gateway_schema_migrations`,
  ).all() as Array<{ id: string; checksum_sha256: string; applied_at: string }>;
  if (readExactFoundationReceipt(rows)) return true;
  if (rows.length !== 2) return false;
  const foundation = rows.find((row) => row.id === AUTH_FOUNDATION_MIGRATION_ID);
  if (!foundation || foundation.checksum_sha256 !== AUTH_FOUNDATION_MIGRATION_CHECKSUM || !isUtcIso(foundation.applied_at)) return false;
  const identity = rows.find((row) => row.id === GATEWAY_AUTH_IDENTITY_MIGRATION_ID);
  return identity !== undefined
    && identity.checksum_sha256 === GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM
    && isUtcIso(identity.applied_at);
}

function readLedgerState(db: Database.Database): 'foundation' | 'phase2a' | null {
  const rows = db.prepare('SELECT id, checksum_sha256, applied_at FROM main.gateway_schema_migrations ORDER BY id COLLATE BINARY').all() as Array<{ id: string; checksum_sha256: string; applied_at: string }>;
  if (readExactFoundationReceipt(rows)) return 'foundation';
  if (rows.length !== 2) return null;
  const foundation = rows.find((row) => row.id === AUTH_FOUNDATION_MIGRATION_ID);
  const phase2a = rows.find((row) => row.id === GATEWAY_AUTH_IDENTITY_MIGRATION_ID);
  if (!foundation || !phase2a
    || foundation.checksum_sha256 !== AUTH_FOUNDATION_MIGRATION_CHECKSUM
    || phase2a.checksum_sha256 !== GATEWAY_AUTH_IDENTITY_MIGRATION_CHECKSUM
    || !isUtcIso(foundation.applied_at) || !isUtcIso(phase2a.applied_at)) return null;
  return 'phase2a';
}

type PhaseObject = { type: string; name: string; tbl_name: string; sql: string | null };

function phase2aReservedObjects(db: Database.Database): PhaseObject[] {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_schema
    WHERE lower(name) IN ('idx_gateway_surface_security_v2_tuple','auth_reconciliation_diagnostics','idx_auth_reconciliation_diagnostics_observed')
       OR lower(tbl_name) IN ('idx_gateway_surface_security_v2_tuple','auth_reconciliation_diagnostics')
       OR lower(name) LIKE 'idx_gateway_surface_security_v2_tuple_%'
       OR lower(name) LIKE 'idx_auth_reconciliation_diagnostics_observed_%'
       OR lower(name) LIKE 'auth_reconciliation_diagnostics_%'
       OR (type='index' AND lower(tbl_name)='gateway_surface_security' AND lower(name) <> 'sqlite_autoindex_gateway_surface_security_1')
       OR (type='trigger' AND lower(tbl_name)='gateway_surface_security')
    ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`).all() as PhaseObject[];
}

function phase2aTempReservedObjects(db: Database.Database): PhaseObject[] {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_temp_schema
    WHERE lower(name) IN ('gateway_surface_security','idx_gateway_surface_security_v2_tuple','auth_reconciliation_diagnostics','idx_auth_reconciliation_diagnostics_observed')
       OR lower(tbl_name) IN ('gateway_surface_security','idx_gateway_surface_security_v2_tuple','auth_reconciliation_diagnostics')
       OR lower(name) LIKE 'sqlite_autoindex_gateway_surface_security_%'
       OR lower(name) LIKE 'sqlite_autoindex_auth_reconciliation_diagnostics_%'
       OR (type='trigger' AND lower(tbl_name) IN ('gateway_surface_security','auth_reconciliation_diagnostics'))`).all() as PhaseObject[];
}

function phase2aColumnPresence(db: Database.Database): string[] {
  const table = db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='gateway_surface_security'").get();
  if (!table) return [];
  const columns = db.prepare('PRAGMA main.table_info(gateway_surface_security)').all() as Array<{ name: string }>;
  return columns.filter((column) => ['connection_class', 'connection_class_revision'].includes(column.name.toLowerCase())).map((column) => column.name);
}

function validatePhase2ASchema(db: Database.Database, trace: string[]): void {
  trace.push('phase2a-schema');
  const reserved = phase2aReservedObjects(db);
  const expectedReserved = new Set([
    'index:idx_gateway_surface_security_v2_tuple:gateway_surface_security',
    'table:auth_reconciliation_diagnostics:auth_reconciliation_diagnostics',
    'index:sqlite_autoindex_auth_reconciliation_diagnostics_1:auth_reconciliation_diagnostics',
    'index:idx_auth_reconciliation_diagnostics_observed:auth_reconciliation_diagnostics',
  ]);
  if (reserved.length !== expectedReserved.size || reserved.some((row) => !expectedReserved.has(`${row.type}:${row.name}:${row.tbl_name}`))) fail();
  const security = db.prepare("SELECT type,name,tbl_name FROM main.sqlite_schema WHERE type='table' AND name='gateway_surface_security'").all() as Array<{ type: string; name: string; tbl_name: string }>;
  if (security.length !== 1 || security[0]?.tbl_name !== 'gateway_surface_security') fail();
  const securityCatalog = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='gateway_surface_security'").get() as { sql: string | null } | undefined;
  if (!securityCatalog || securityCatalog.sql !== PHASE2A_SECURITY_TABLE_SQL) fail();
  const columns = db.prepare('PRAGMA main.table_info(gateway_surface_security)').all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
  const expectedSecurity = [['surface_id', 'TEXT', 0, null, 1], ['principal_id', 'TEXT', 1, null, 0], ['surface_kind', 'TEXT', 1, null, 0], ['surface_role', 'TEXT', 1, null, 0], ['state', 'TEXT', 1, "'revoked'", 0], ['auth_epoch', 'INTEGER', 1, null, 0], ['allowed_capability_classes_json', 'TEXT', 1, "'[]'", 0], ['allowed_operation_ids_json', 'TEXT', 1, "'[]'", 0], ['capability_revision', 'INTEGER', 1, null, 0], ['source_identity_revision', 'TEXT', 1, null, 0], ['activated_at', 'DATETIME', 0, null, 0], ['revoked_at', 'DATETIME', 0, null, 0], ['connection_class', 'TEXT', 1, "'none'", 0], ['connection_class_revision', 'INTEGER', 1, '1', 0]] as const;
  if (columns.length !== expectedSecurity.length || columns.some((column, index) => [column.name, column.type, column.notnull, column.dflt_value, column.pk].some((value, field) => value !== expectedSecurity[index]![field]))) fail();
  const indexes = db.prepare("PRAGMA main.index_list('gateway_surface_security')").all() as Array<{ seq: number; name: string; unique: number; origin: string; partial: number }>;
  if (indexes.length !== 2
    || !indexes.some((index) => index.name === 'sqlite_autoindex_gateway_surface_security_1' && index.unique === 1 && index.origin === 'pk' && index.partial === 0)) fail();
  const phaseIndex = indexes.find((index) => index.name === 'idx_gateway_surface_security_v2_tuple');
  if (!phaseIndex || phaseIndex.unique !== 1 || phaseIndex.origin !== 'c' || phaseIndex.partial !== 0) fail();
  const phaseInfo = db.prepare("PRAGMA main.index_info('idx_gateway_surface_security_v2_tuple')").all() as Array<{ seqno: number; name: string }>;
  if (phaseInfo.length !== 5 || phaseInfo.map((row) => row.name).join('|') !== 'surface_id|surface_kind|surface_role|connection_class|connection_class_revision') fail();
  const phaseCatalog = phase2aReservedObjects(db).filter((row) => row.type === 'index' && row.name === 'idx_gateway_surface_security_v2_tuple');
  if (phaseCatalog.length !== 1 || phaseCatalog[0]?.tbl_name !== 'gateway_surface_security' || phaseCatalog[0]?.sql !== PHASE2A_SECURITY_INDEX_SQL) fail();
  const pkInfo = db.prepare("PRAGMA main.index_info('sqlite_autoindex_gateway_surface_security_1')").all() as Array<{ seqno: number; cid: number; name: string }>;
  if (pkInfo.length !== 1 || pkInfo[0]?.seqno !== 0 || pkInfo[0]?.cid !== 0 || pkInfo[0]?.name !== 'surface_id') fail();
  const diagnostics = db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE lower(name)='auth_reconciliation_diagnostics' OR lower(tbl_name)='auth_reconciliation_diagnostics'").all() as PhaseObject[];
  if (diagnostics.length !== 3
    || !diagnostics.some((row) => row.type === 'table' && row.name === 'auth_reconciliation_diagnostics' && row.tbl_name === 'auth_reconciliation_diagnostics' && row.sql === PHASE2A_DIAGNOSTIC_TABLE_SQL)
    || !diagnostics.some((row) => row.type === 'index' && row.name === 'sqlite_autoindex_auth_reconciliation_diagnostics_1' && row.sql === null)
    || !diagnostics.some((row) => row.type === 'index' && row.name === 'idx_auth_reconciliation_diagnostics_observed' && row.tbl_name === 'auth_reconciliation_diagnostics' && row.sql === PHASE2A_DIAGNOSTIC_INDEX_SQL)) fail();
  const diagnosticColumns = db.prepare('PRAGMA main.table_info(auth_reconciliation_diagnostics)').all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
  const expected = [['diagnostic_id', 'TEXT', 0, null, 1], ['non_authoritative', 'INTEGER', 1, null, 0], ['status', 'TEXT', 1, null, 0], ['collab_auth_ledger_sha256', 'TEXT', 1, null, 0], ['collab_tuple_sha256', 'TEXT', 1, null, 0], ['state_projection_sha256', 'TEXT', 1, null, 0], ['observed_at', 'TEXT', 1, null, 0], ['detail_code', 'TEXT', 1, null, 0]] as const;
  if (diagnosticColumns.length !== expected.length || diagnosticColumns.some((column, index) => [column.cid, column.name, column.type, column.notnull, column.dflt_value, column.pk].some((value, field) => value !== [index, ...expected[index]!][field]))) fail();
  const diagnosticIndexes = db.prepare("PRAGMA main.index_list('auth_reconciliation_diagnostics')").all() as Array<{ name: string; unique: number; origin: string; partial: number }>;
  if (diagnosticIndexes.length !== 2 || !diagnosticIndexes.some((index) => index.name === 'sqlite_autoindex_auth_reconciliation_diagnostics_1' && index.unique === 1 && index.origin === 'pk' && index.partial === 0) || !diagnosticIndexes.some((index) => index.name === 'idx_auth_reconciliation_diagnostics_observed' && index.unique === 0 && index.origin === 'c' && index.partial === 0)) fail();
  const observedInfo = db.prepare("PRAGMA main.index_info('idx_auth_reconciliation_diagnostics_observed')").all() as Array<{ seqno: number; name: string }>;
  if (observedInfo.length !== 1 || observedInfo[0]?.seqno !== 0 || observedInfo[0]?.name !== 'observed_at') fail();
  const diagnosticAutoInfo = db.prepare("PRAGMA main.index_info('sqlite_autoindex_auth_reconciliation_diagnostics_1')").all() as Array<{ seqno: number; cid: number; name: string }>;
  if (diagnosticAutoInfo.length !== 1 || diagnosticAutoInfo[0]?.seqno !== 0 || diagnosticAutoInfo[0]?.cid !== 0 || diagnosticAutoInfo[0]?.name !== 'diagnostic_id') fail();
  if ((db.prepare("PRAGMA main.foreign_key_list('gateway_surface_security')").all() as unknown[]).length !== 0
    || (db.prepare("PRAGMA main.foreign_key_list('auth_reconciliation_diagnostics')").all() as unknown[]).length !== 0) fail();
}

function readExactFoundationReceipt(rows: Array<{ id: string; checksum_sha256: string; applied_at: string }>): boolean {
  if (rows.length !== 1) return false;
  const row = rows[0]!;
  return row.id === AUTH_FOUNDATION_MIGRATION_ID
    && row.checksum_sha256 === AUTH_FOUNDATION_MIGRATION_CHECKSUM
    && isUtcIso(row.applied_at);
}

function readFenceUnsafe(db: Database.Database): AuthRuntimeFenceResult {
  return validateState(db, []);
}

/** Read-only pre-write downgrade fence. */
export function readAuthRuntimeMarker(db: Database.Database): AuthRuntimeFenceResult {
  try {
    return readFenceUnsafe(db);
  } catch (error) {
    if (error instanceof AuthRuntimeMarkerError) throw error;
    throw new AuthRuntimeMarkerError();
  }
}

export function traceAuthRuntimeState(db: Database.Database): AuthRuntimeTrace {
  const steps: string[] = [];
  try {
    return { ...validateState(db, steps), steps };
  } catch {
    return { state: 'incompatible', steps };
  }
}

export function assertV1CompatibleState(db: Database.Database): void {
  readAuthRuntimeMarker(db);
}

function statementFault(options: MigrationTestOptions | undefined, count: number): void {
  if (options?.failAfterStatement === count) throw new Error('AUTH_FOUNDATION_TEST_FAULT');
}

/**
 * Apply the Phase 1 foundation under BEGIN IMMEDIATE.  The read-only fence is
 * repeated after lock acquisition so a TOCTOU marker change cannot be
 * overwritten or downgraded.
 */
export function runAuthFoundationMigration(
  db: Database.Database,
  options?: MigrationTestOptions,
): 'migrated' | 'noop' {
  let inTransaction = false;
  let statements = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    const current = validateState(db, []);
    if (current.state === 'v1') {
      db.exec('COMMIT');
      inTransaction = false;
      return 'noop';
    }

    const [ledgerDdl, markerDdl] = FOUNDATION_GATEWAY_MIGRATION_SQL.split('\n\n');
    if (!ledgerDdl || !markerDdl) throw new AuthRuntimeMarkerError();
    db.exec(ledgerDdl);
    statements += 1;
    statementFault(options, statements);
    db.exec(markerDdl);
    statements += 1;
    statementFault(options, statements);
    validateFoundationSchema(db, []);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO auth_runtime_state
       (singleton, state_schema, mode, launcher_generation, serving_state,
        config_digest_sha256, secret_set_id, cutover_id, updated_at)
       VALUES (1, 1, 'V1_COMPAT', NULL, NULL, NULL, NULL, NULL, ?)`,
    ).run(now);
    statements += 1;
    statementFault(options, statements);

    db.prepare(
      `INSERT INTO gateway_schema_migrations(id, checksum_sha256, applied_at)
       VALUES (?, ?, ?)`,
    ).run(AUTH_FOUNDATION_MIGRATION_ID, AUTH_FOUNDATION_MIGRATION_CHECKSUM, now);
    statements += 1;
    statementFault(options, statements);

    validateFoundation(db, []);
    db.exec('COMMIT');
    inTransaction = false;
    return 'migrated';
  } catch (error) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
    throw error instanceof AuthRuntimeMarkerError ? error : error;
  }
}

export function foundationMigrationChecksum(): string {
  return createHash('sha256')
    .update(`${AUTH_FOUNDATION_MIGRATION_ID}\n${FOUNDATION_GATEWAY_MIGRATION_SQL}`, 'utf8')
    .digest('hex');
}
