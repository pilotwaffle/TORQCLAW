import type Database from 'better-sqlite3';
import {
  COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM,
  COLLAB_AUTH_IDENTITY_MIGRATION_ID,
  COLLAB_AUTH_IDENTITY_MIGRATION_SQL,
  PHASE2A_UTC_ISO,
  COLLAB_AUTH_IDENTITY_STEP_MANIFEST,
  phase2aMigrationChecksum,
  serializeAuthPhase2AProgram,
} from './authIdentityConstants.js';

/** Phase 2A migration failures are deliberately generic and identifier-free. */
export class CollabAuthIdentityMigrationError extends Error {
  readonly code = 'COLLAB_AUTH_IDENTITY_MIGRATION_REFUSED';
  constructor() {
    super('COLLAB_AUTH_IDENTITY_MIGRATION_REFUSED');
    this.name = 'CollabAuthIdentityMigrationError';
  }
}

export interface AuthIdentityMigrationTestOptions {
  /** Test-only fault after a DDL/receipt boundary. Never a production input. */
  failAfterStatement?: number;
  /** Test-only execution trace; never a production input. */
  trace?: string[];
  /** Offline-only transaction event trace; never a production input. */
  events?: string[];
}

type Column = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type Receipt = { id: string; checksum_sha256: string; applied_at: string };

// Stored catalog bytes pinned to the shipped Collaboration Substrate v1
// migration (`migration.ts`, c2850f5). The offline diagnostic must reject a
// permissive principals table or ambiguous base ledger before snapshotting.
const COLLABORATION_MIGRATION_ID = '20260806_001_collaboration_v1';
const C1_SURFACES_MIGRATION_ID = '20260811_002_surface_identity_c1';
const PRINCIPALS_TABLE_SQL = `CREATE TABLE principals (
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
)`;
const PRINCIPALS_OPERATOR_INDEX_SQL = "CREATE UNIQUE INDEX principals_single_operator\n  ON principals(kind) WHERE kind='operator'";
const COLLAB_SCHEMA_MIGRATIONS_TABLE_SQL = `CREATE TABLE collab_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

const SURFACES_BASE_SQL = `CREATE TABLE surfaces (
    surface_id        TEXT PRIMARY KEY,
    principal_id      TEXT NOT NULL,
    surface_kind      TEXT NOT NULL CHECK (surface_kind IN
                        ('desktop','mobile','http','telegram','slack','automation')),
    surface_role      TEXT NOT NULL DEFAULT 'agent'
                        CHECK (surface_role IN ('operator','agent','automation')),
    display_name      TEXT,
    capability_json   TEXT NOT NULL DEFAULT '[]',
    state             TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','revoked')),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at        DATETIME,
    last_seen_at      DATETIME,
    FOREIGN KEY (principal_id) REFERENCES principals(id),
    CHECK (surface_kind NOT IN ('telegram','slack','automation')
           OR surface_role != 'operator')
)`;
const SURFACES_P2A_SQL = SURFACES_BASE_SQL.replace('    FOREIGN KEY', "    last_seen_at      DATETIME, connection_class TEXT NOT NULL DEFAULT 'none' CHECK(connection_class IN ('none','browser_bff','channel_dedicated','agent_node','diagnostic','benchmark_submit','acceptance_submit','fixture_operator')), connection_class_revision INTEGER NOT NULL DEFAULT 1 CHECK(connection_class_revision > 0),\n    FOREIGN KEY").replace('    last_seen_at      DATETIME,\n    last_seen_at', '    last_seen_at');

function assertPrincipalFoundation(db: Database.Database): void {
  const temp = db.prepare(`SELECT type,name,tbl_name FROM sqlite_temp_schema
    WHERE lower(name)='principals' OR lower(tbl_name)='principals'
       OR lower(name) LIKE 'sqlite_autoindex_principals_%'`).all() as unknown[];
  if (temp.length !== 0) fail();
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_schema
    WHERE lower(name)='principals' OR lower(tbl_name)='principals'
    ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  if (objects.length !== 3
    || !objects.some((row) => row.type === 'table' && row.name === 'principals' && row.tbl_name === 'principals' && row.sql === PRINCIPALS_TABLE_SQL)
    || !objects.some((row) => row.type === 'index' && row.name === 'principals_single_operator' && row.tbl_name === 'principals' && row.sql === PRINCIPALS_OPERATOR_INDEX_SQL)
    || !objects.some((row) => row.type === 'index' && row.name === 'sqlite_autoindex_principals_1' && row.tbl_name === 'principals' && row.sql === null)) fail();
  const columns = db.prepare('PRAGMA main.table_info(principals)').all() as Column[];
  const expected: Array<[number, string, string, number, string | null, number]> = [
    [0, 'id', 'TEXT', 0, null, 1], [1, 'kind', 'TEXT', 1, null, 0], [2, 'display_name', 'TEXT', 1, null, 0],
    [3, 'owner_principal_id', 'TEXT', 0, null, 0], [4, 'status', 'TEXT', 1, null, 0], [5, 'auth_epoch', 'INTEGER', 1, '1', 0],
    [6, 'revoked_at', 'TEXT', 0, null, 0], [7, 'created_at', 'TEXT', 1, null, 0], [8, 'updated_at', 'TEXT', 1, null, 0],
  ];
  if (columns.length !== expected.length || columns.some((column, i) => {
    const want = expected[i]!;
    return [column.cid, column.name, column.type, column.notnull, column.dflt_value, column.pk].some((value, j) => value !== want[j]);
  })) fail();
  const indexes = db.prepare('PRAGMA main.index_list(principals)').all() as Array<{ seq: number; name: string; unique: number; origin: string; partial: number }>;
  if (indexes.length !== 2
    || !indexes.some((row) => row.seq === 0 && row.name === 'principals_single_operator' && row.unique === 1 && row.origin === 'c' && row.partial === 1)
    || !indexes.some((row) => row.seq === 1 && row.name === 'sqlite_autoindex_principals_1' && row.unique === 1 && row.origin === 'pk' && row.partial === 0)) fail();
  const operatorInfo = db.prepare("PRAGMA main.index_info('principals_single_operator')").all() as Array<{ seqno: number; cid: number; name: string }>;
  if (operatorInfo.length !== 1 || operatorInfo[0]?.seqno !== 0 || operatorInfo[0]?.cid !== 1 || operatorInfo[0]?.name !== 'kind') fail();
  const primaryInfo = db.prepare("PRAGMA main.index_info('sqlite_autoindex_principals_1')").all() as Array<{ seqno: number; cid: number; name: string }>;
  if (primaryInfo.length !== 1 || primaryInfo[0]?.seqno !== 0 || primaryInfo[0]?.cid !== 0 || primaryInfo[0]?.name !== 'id') fail();
  const foreignKeys = db.prepare("PRAGMA main.foreign_key_list('principals')").all() as Array<{ table: string; from: string; to: string; on_update: string; on_delete: string; match: string }>;
  if (foreignKeys.length !== 1 || foreignKeys[0]?.table !== 'principals' || foreignKeys[0]?.from !== 'owner_principal_id' || foreignKeys[0]?.to !== 'id'
    || foreignKeys[0]?.on_update !== 'NO ACTION' || foreignKeys[0]?.on_delete !== 'NO ACTION' || foreignKeys[0]?.match !== 'NONE') fail();
  const foreignKeysSetting = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
  if (foreignKeysSetting[0]?.foreign_keys !== 1) fail();
}

function assertShippedCollabLedger(db: Database.Database): void {
  const temp = db.prepare(`SELECT type,name,tbl_name FROM sqlite_temp_schema
    WHERE lower(name)='collab_schema_migrations' OR lower(tbl_name)='collab_schema_migrations'
       OR lower(name) LIKE 'sqlite_autoindex_collab_schema_migrations_%'`).all() as unknown[];
  if (temp.length !== 0) fail();
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_schema
    WHERE lower(name)='collab_schema_migrations' OR lower(tbl_name)='collab_schema_migrations'
    ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  if (objects.length !== 2
    || !objects.some((row) => row.type === 'table' && row.name === 'collab_schema_migrations' && row.tbl_name === 'collab_schema_migrations' && row.sql === COLLAB_SCHEMA_MIGRATIONS_TABLE_SQL)
    || !objects.some((row) => row.type === 'index' && row.name === 'sqlite_autoindex_collab_schema_migrations_1' && row.tbl_name === 'collab_schema_migrations' && row.sql === null)) fail();
  const columns = db.prepare('PRAGMA main.table_info(collab_schema_migrations)').all() as Column[];
  const expected: Array<[number, string, string, number, string | null, number]> = [[0, 'id', 'TEXT', 0, null, 1], [1, 'applied_at', 'TEXT', 1, null, 0]];
  if (columns.length !== expected.length || columns.some((column, i) => {
    const want = expected[i]!;
    return [column.cid, column.name, column.type, column.notnull, column.dflt_value, column.pk].some((value, j) => value !== want[j]);
  })) fail();
  const indexes = db.prepare('PRAGMA main.index_list(collab_schema_migrations)').all() as Array<{ seq: number; name: string; unique: number; origin: string; partial: number }>;
  if (indexes.length !== 1 || indexes[0]?.seq !== 0 || indexes[0]?.name !== 'sqlite_autoindex_collab_schema_migrations_1' || indexes[0]?.unique !== 1 || indexes[0]?.origin !== 'pk' || indexes[0]?.partial !== 0) fail();
  const info = db.prepare("PRAGMA main.index_info('sqlite_autoindex_collab_schema_migrations_1')").all() as Array<{ seqno: number; cid: number; name: string }>;
  if (info.length !== 1 || info[0]?.seqno !== 0 || info[0]?.cid !== 0 || info[0]?.name !== 'id') fail();
  if ((db.prepare("PRAGMA main.foreign_key_list('collab_schema_migrations')").all() as unknown[]).length !== 0) fail();
  const rows = db.prepare('SELECT id, applied_at FROM main.collab_schema_migrations ORDER BY id COLLATE BINARY').all() as Array<{ id: string; applied_at: string }>;
  if (rows.length !== 2
    || rows.some((row) => ![COLLABORATION_MIGRATION_ID, C1_SURFACES_MIGRATION_ID].includes(row.id)
      || !PHASE2A_UTC_ISO.test(row.applied_at) || new Date(row.applied_at).toISOString() !== row.applied_at)
    || new Set(rows.map((row) => row.id)).size !== 2) fail();
}

function assertCollabFoundation(db: Database.Database): void {
  assertPrincipalFoundation(db);
  assertShippedCollabLedger(db);
}

function assertSurfaceBase(db: Database.Database, phase2a: boolean): void {
  if (!tableExists(db, 'surfaces')) fail();
  const temp = db.prepare(`SELECT type,name,tbl_name FROM sqlite_temp_schema
    WHERE lower(name)='surfaces' OR lower(tbl_name)='surfaces' OR lower(name) LIKE 'sqlite_autoindex_surfaces_%'`).all() as unknown[];
  if (temp.length !== 0) fail();
  const columns = db.prepare('PRAGMA main.table_info(surfaces)').all() as Column[];
  const expected: Array<[number, string, string, number, string | null, number]> = [
    [0, 'surface_id', 'TEXT', 0, null, 1], [1, 'principal_id', 'TEXT', 1, null, 0], [2, 'surface_kind', 'TEXT', 1, null, 0], [3, 'surface_role', 'TEXT', 1, "'agent'", 0], [4, 'display_name', 'TEXT', 0, null, 0], [5, 'capability_json', 'TEXT', 1, "'[]'", 0], [6, 'state', 'TEXT', 1, "'active'", 0], [7, 'created_at', 'DATETIME', 0, 'CURRENT_TIMESTAMP', 0], [8, 'revoked_at', 'DATETIME', 0, null, 0], [9, 'last_seen_at', 'DATETIME', 0, null, 0],
  ];
  if (phase2a) expected.push([10, 'connection_class', 'TEXT', 1, "'none'", 0], [11, 'connection_class_revision', 'INTEGER', 1, '1', 0]);
  if (columns.length !== expected.length || columns.some((column, i) => [column.cid, column.name, column.type, column.notnull, column.dflt_value, column.pk].some((value, j) => value !== expected[i]![j]))) fail();
  const catalog = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='surfaces'").get() as { sql: string | null } | undefined;
  if (!catalog || (!phase2a && catalog.sql !== SURFACES_BASE_SQL) || (phase2a && catalog.sql !== SURFACES_P2A_SQL)) fail();
  const indexes = db.prepare("PRAGMA main.index_list('surfaces')").all() as Array<{ seq: number; name: string; unique: number; origin: string; partial: number }>;
  if (indexes.length !== 2 || !indexes.some((row) => row.name === 'sqlite_autoindex_surfaces_1' && row.unique === 1 && row.origin === 'pk' && row.partial === 0) || !indexes.some((row) => row.name === 'idx_surfaces_principal_state' && row.unique === 0 && row.origin === 'c' && row.partial === 0)) fail();
  const info = db.prepare("PRAGMA main.index_info('idx_surfaces_principal_state')").all() as Array<{ seqno: number; cid: number; name: string }>;
  if (info.length !== 2 || info[0]?.seqno !== 0 || info[0]?.cid !== 1 || info[0]?.name !== 'principal_id' || info[1]?.seqno !== 1 || info[1]?.cid !== 6 || info[1]?.name !== 'state') fail();
  const pk = db.prepare("PRAGMA main.index_info('sqlite_autoindex_surfaces_1')").all() as Array<{ seqno: number; cid: number; name: string }>;
  if (pk.length !== 1 || pk[0]?.seqno !== 0 || pk[0]?.cid !== 0 || pk[0]?.name !== 'surface_id') fail();
  const fk = db.prepare("PRAGMA main.foreign_key_list('surfaces')").all() as Array<{ table: string; from: string; to: string; on_update: string; on_delete: string; match: string }>;
  if (fk.length !== 1 || fk[0]?.table !== 'principals' || fk[0]?.from !== 'principal_id' || fk[0]?.to !== 'id' || fk[0]?.on_update !== 'NO ACTION' || fk[0]?.on_delete !== 'NO ACTION' || fk[0]?.match !== 'NONE') fail();
  const extras = db.prepare("SELECT type,name FROM main.sqlite_schema WHERE tbl_name='surfaces' AND type IN ('trigger','index') AND name NOT IN ('sqlite_autoindex_surfaces_1','idx_surfaces_principal_state')").all() as unknown[];
  if (extras.length !== 0) fail();
}

const fail = (): never => { throw new CollabAuthIdentityMigrationError(); };

function statementFault(options: AuthIdentityMigrationTestOptions | undefined, count: number): void {
  if (options?.failAfterStatement === count) throw new Error('COLLAB_AUTH_IDENTITY_TEST_FAULT');
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(name));
}

function ledgerObjectPresence(db: Database.Database): number {
  return (db.prepare(`SELECT type,name,tbl_name FROM main.sqlite_schema
    WHERE lower(name)='collab_auth_schema_migrations' OR lower(tbl_name)='collab_auth_schema_migrations'`).all() as unknown[]).length;
}

function assertLedgerSchema(db: Database.Database): void {
  if (!tableExists(db, 'collab_auth_schema_migrations')) return;
  const tempLedger = db.prepare(`SELECT type,name,tbl_name FROM sqlite_temp_schema
    WHERE lower(name)='collab_auth_schema_migrations' OR lower(tbl_name)='collab_auth_schema_migrations'`).all() as unknown[];
  if (tempLedger.length !== 0) fail();
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_schema
    WHERE lower(name)='collab_auth_schema_migrations' OR lower(tbl_name)='collab_auth_schema_migrations'
    ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  if (objects.length !== 2
    || !objects.some((row) => row.type === 'table' && row.name === 'collab_auth_schema_migrations' && row.tbl_name === 'collab_auth_schema_migrations')
    || !objects.some((row) => row.type === 'index' && row.name === 'sqlite_autoindex_collab_auth_schema_migrations_1' && row.tbl_name === 'collab_auth_schema_migrations' && row.sql === null)) fail();
  const columns = db.prepare('PRAGMA main.table_info(collab_auth_schema_migrations)').all() as Column[];
  const expected: Array<[number, string, string, number, string | null, number]> = [
    [0, 'id', 'TEXT', 0, null, 1],
    [1, 'checksum_sha256', 'TEXT', 1, null, 0],
    [2, 'applied_at', 'TEXT', 1, null, 0],
  ];
  if (columns.length !== expected.length || columns.some((column, i) => {
    const want = expected[i]!;
    return [column.cid, column.name, column.type, column.notnull, column.dflt_value, column.pk]
      .some((value, j) => value !== want[j]);
  })) fail();
  const indexes = db.prepare('PRAGMA main.index_list(collab_auth_schema_migrations)').all() as Array<{ seq: number; name: string; unique: number; origin: string; partial: number }>;
  if (indexes.length !== 1 || indexes[0]?.seq !== 0 || indexes[0]?.name !== 'sqlite_autoindex_collab_auth_schema_migrations_1'
    || indexes[0]?.unique !== 1 || indexes[0]?.origin !== 'pk' || indexes[0]?.partial !== 0) fail();
  const info = db.prepare("PRAGMA main.index_info('sqlite_autoindex_collab_auth_schema_migrations_1')").all() as Array<{ seqno: number; cid: number; name: string }>;
  if (info.length !== 1 || info[0]?.seqno !== 0 || info[0]?.cid !== 0 || info[0]?.name !== 'id') fail();
  if ((db.prepare("PRAGMA main.foreign_key_list('collab_auth_schema_migrations')").all() as unknown[]).length !== 0) fail();
  const catalog = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='collab_auth_schema_migrations'").get() as { sql: string | null } | undefined;
  const expectedCatalog = `CREATE TABLE collab_auth_schema_migrations (`
    + "\n  id TEXT PRIMARY KEY,\n  checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256)=64 AND checksum_sha256 GLOB '[0-9a-f]*'),\n  applied_at TEXT NOT NULL\n)";
  if (!catalog || catalog.sql !== expectedCatalog) fail();
}

function readReceipts(db: Database.Database): Receipt[] {
  if (!tableExists(db, 'collab_auth_schema_migrations')) return [];
  return db.prepare('SELECT id, checksum_sha256, applied_at FROM main.collab_auth_schema_migrations ORDER BY id COLLATE BINARY').all() as Receipt[];
}

function assertReceiptState(db: Database.Database): 'absent' | 'applied' {
  const rows = readReceipts(db);
  if (rows.length === 0) return 'absent';
  if (rows.length !== 1) fail();
  const row = rows[0]!;
  if (row.id !== COLLAB_AUTH_IDENTITY_MIGRATION_ID
    || row.checksum_sha256 !== COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM
    || !PHASE2A_UTC_ISO.test(row.applied_at)
    || new Date(row.applied_at).toISOString() !== row.applied_at) fail();
  return 'applied';
}

function surfaceColumnState(db: Database.Database): { hasClass: boolean; hasRevision: boolean } {
  if (!tableExists(db, 'surfaces')) fail();
  const columns = db.prepare('PRAGMA main.table_info(surfaces)').all() as Column[];
  const byName = new Map(columns.map((column) => [column.name, column]));
  const required = ['surface_id', 'principal_id', 'surface_kind', 'surface_role', 'state'];
  if (required.some((name) => !byName.has(name))) fail();
  const klass = byName.get('connection_class');
  const revision = byName.get('connection_class_revision');
  if (klass && (klass.cid !== 10 || klass.type !== 'TEXT' || klass.notnull !== 1 || klass.dflt_value !== "'none'" || klass.pk !== 0)) fail();
  if (revision && (revision.cid !== 11 || revision.type !== 'INTEGER' || revision.notnull !== 1 || revision.dflt_value !== '1' || revision.pk !== 0)) fail();
  return { hasClass: Boolean(klass), hasRevision: Boolean(revision) };
}

function assertMigrationState(db: Database.Database): void {
  assertLedgerSchema(db);
  assertSurfaceBase(db, true);
  const receipt = assertReceiptState(db);
  if (receipt !== 'applied') fail();
}

/** Exact read-only post-P2A validator used by the offline diagnostic seam. */
export function assertCollabAuthIdentitySchema(db: Database.Database): void {
  assertCollabFoundation(db);
  assertLedgerSchema(db);
  if (assertReceiptState(db) !== 'applied') fail();
  assertSurfaceBase(db, true);
}

/**
 * Apply the collab-side Phase 2A additive migration.  It only touches
 * `collab_auth_schema_migrations` and the two new surface columns; shipped
 * `collab_schema_migrations` and all existing rows remain untouched.
 */
export function runCollabAuthIdentityMigration(
  db: Database.Database,
  options?: AuthIdentityMigrationTestOptions,
): 'migrated' | 'noop' {
  let inTransaction = false;
  let statements = 0;
  try {
    if (phase2aMigrationChecksum(COLLAB_AUTH_IDENTITY_MIGRATION_ID, serializeAuthPhase2AProgram(COLLAB_AUTH_IDENTITY_STEP_MANIFEST)) !== COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM) fail();
    assertCollabFoundation(db);
    const beforeLedgerTable = tableExists(db, 'collab_auth_schema_migrations');
    const beforeLedger = assertReceiptState(db);
    const beforeColumns = surfaceColumnState(db);
    assertSurfaceBase(db, beforeColumns.hasClass && beforeColumns.hasRevision);
    if (beforeLedger === 'applied') {
      if (!beforeColumns.hasClass || !beforeColumns.hasRevision) fail();
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      options?.events?.push('collab:BEGIN IMMEDIATE');
      assertMigrationState(db);
      db.exec('COMMIT');
      inTransaction = false;
      options?.events?.push('collab:COMMIT');
      return 'noop';
    }
    if (beforeColumns.hasClass !== beforeColumns.hasRevision) fail();
    if (beforeLedgerTable || ledgerObjectPresence(db) !== 0 || beforeColumns.hasClass || beforeColumns.hasRevision) fail();

    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    options?.events?.push('collab:BEGIN IMMEDIATE');
    assertCollabFoundation(db);
    if (tableExists(db, 'collab_auth_schema_migrations') !== beforeLedgerTable || surfaceColumnState(db).hasClass || surfaceColumnState(db).hasRevision) fail();
    assertSurfaceBase(db, false);
    for (const step of COLLAB_AUTH_IDENTITY_STEP_MANIFEST) {
      options?.trace?.push(step.name);
      if (step.kind === 'assert') {
        switch (step.name) {
          case 'collab-current-base': assertSurfaceBase(db, false); if (ledgerObjectPresence(db) !== 0) fail(); break;
          case 'collab-ledger-empty-exact': assertLedgerSchema(db); if (assertReceiptState(db) !== 'absent') fail(); break;
          case 'collab-post-schema-before-receipt': assertLedgerSchema(db); assertSurfaceBase(db, true); if (assertReceiptState(db) !== 'absent') fail(); break;
          case 'collab-receipt-absent': if (assertReceiptState(db) !== 'absent') fail(); break;
          case 'collab-post-schema-with-receipt': assertMigrationState(db); break;
          default: fail();
        }
      } else if (step.kind === 'ddl') {
        db.exec(step.payload);
      } else if (step.kind === 'receipt-boundary') {
        const now = new Date().toISOString();
        db.prepare('INSERT INTO collab_auth_schema_migrations(id, checksum_sha256, applied_at) VALUES (?,?,?)')
          .run(COLLAB_AUTH_IDENTITY_MIGRATION_ID, COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM, now);
      } else {
        fail();
      }
      statements += 1;
      statementFault(options, statements);
    }
    db.exec('COMMIT');
    inTransaction = false;
    options?.events?.push('collab:COMMIT');
    return 'migrated';
  } catch (error) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); options?.events?.push('collab:ROLLBACK'); } catch { /* preserve original error */ }
    }
    throw error;
  }
}

export { COLLAB_AUTH_IDENTITY_MIGRATION_ID, COLLAB_AUTH_IDENTITY_MIGRATION_SQL, COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM };
export { serializeAuthPhase2AProgram } from './authIdentityConstants.js';
export { SURFACES_BASE_SQL, SURFACES_P2A_SQL };
