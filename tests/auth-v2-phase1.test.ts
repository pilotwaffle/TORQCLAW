import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  AUTH_FOUNDATION_MIGRATION_CHECKSUM,
  AUTH_FOUNDATION_MIGRATION_ID,
  AUTH_RUNTIME_MARKER_ATTACHED_DB,
  AUTH_RUNTIME_MARKER_INCOMPATIBLE,
  AUTH_RUNTIME_MARKER_TEMP_SHADOW,
  FOUNDATION_GATEWAY_MIGRATION_SQL,
  foundationMigrationChecksum,
  readAuthRuntimeMarker,
  traceAuthRuntimeState,
  runAuthFoundationMigration,
  AuthRuntimeMarkerError,
} from '../packages/gateway/src/authRuntimeMarker.js';
import {
  V2_HELLO_MAX_BYTES,
  V2_PREVIEW_OF_MAX_BYTES,
  V2_ATTACHMENT_COUNT_MAX,
  V2_PROMPT_MAX_BYTES,
  V2_SKILL_DECISION_MAX_BYTES,
  V2HelloSchema,
  V2ClientCommandSchema,
} from '../packages/gateway/src/v2Contracts.js';
import {
  parseStrictJson,
  parseV2Hello,
  parseV2ClientCommand,
  parseV2PromptOrPreview,
  parseV2SkillDecision,
  StrictWireError,
} from '../packages/gateway/src/strictWire.js';

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'torq-auth-v2-')), 'state.db');
}

function open(): Database.Database {
  return new Database(dbPath());
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[])
    .map((row) => row.name);
}

function seedExactV1(db: Database.Database): void {
  db.exec(FOUNDATION_GATEWAY_MIGRATION_SQL);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_runtime_state
    (singleton,state_schema,mode,launcher_generation,serving_state,
     config_digest_sha256,secret_set_id,cutover_id,updated_at)
    VALUES (1,1,'V1_COMPAT',NULL,NULL,NULL,NULL,NULL,?)`).run(now);
  db.prepare(`INSERT INTO gateway_schema_migrations(id,checksum_sha256,applied_at)
    VALUES (?,?,?)`).run(AUTH_FOUNDATION_MIGRATION_ID, AUTH_FOUNDATION_MIGRATION_CHECKSUM, now);
}

function expectedCatalogSql(ddl: string): string {
  const prefix = 'CREATE TABLE IF NOT EXISTS ';
  if (!ddl.startsWith(prefix) || !ddl.endsWith(';')) throw new Error('unexpected checked-in Phase 1 DDL');
  return `CREATE TABLE ${ddl.slice(prefix.length, -1)}`;
}

type CollisionObjectType = 'table' | 'view' | 'index' | 'trigger';
type CollisionAxis = 'name' | 'tbl_name';
type CollisionCase = {
  name: string;
  identifier: string;
  objectType: CollisionObjectType;
  axis: CollisionAxis;
  seed: (db: Database.Database) => void;
};

const RESERVED_IDENTIFIERS = ['gateway_schema_migrations', 'auth_runtime_state'] as const;
const mixedIdentifier = (identifier: string): string => identifier === 'gateway_schema_migrations'
  ? 'Gateway_Schema_Migrations'
  : 'Auth_Runtime_State';
const quoteIdentifier = (identifier: string): string => `"${identifier}"`;

const COLLISION_MATRIX: CollisionCase[] = RESERVED_IDENTIFIERS.flatMap((identifier) =>
  ([false, true] as const).flatMap((mixed) =>
    (['table', 'view', 'index', 'trigger'] as const).flatMap((objectType) =>
      (['name', 'tbl_name'] as const).map((axis) => {
        const objectIdentifier = mixed ? mixedIdentifier(identifier) : identifier;
        const label = `collision-${identifier}-${mixed ? 'mixed' : 'exact'}-${objectType}-${axis}`;
        return {
          name: label,
          identifier,
          objectType,
          axis,
          seed: (db: Database.Database) => {
            const target = quoteIdentifier(objectIdentifier);
            if (objectType === 'table') {
              db.exec(`CREATE TABLE ${target} (collision INTEGER)`);
            } else if (objectType === 'view') {
              db.exec(`CREATE VIEW ${target} AS SELECT 1 AS collision`);
            } else if (objectType === 'index') {
              if (axis === 'name') {
                db.exec(`CREATE TABLE collision_owner (collision INTEGER); CREATE INDEX ${target} ON collision_owner(collision)`);
              } else {
                db.exec(`CREATE TABLE ${target} (collision INTEGER); CREATE INDEX collision_index ON ${target}(collision)`);
              }
            } else if (axis === 'name') {
              db.exec(`CREATE TABLE collision_owner (collision INTEGER); CREATE TRIGGER ${target} AFTER INSERT ON collision_owner BEGIN SELECT 1; END`);
            } else {
              db.exec(`CREATE TABLE ${target} (collision INTEGER); CREATE TRIGGER collision_trigger AFTER INSERT ON ${target} BEGIN SELECT 1; END`);
            }
          },
        } satisfies CollisionCase;
      }),
    ),
  ),
);

function stateFileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stateJournalArtifacts(path: string): Array<{ path: string; exists: boolean; hash: string | null }> {
  return ['', '-wal', '-shm', '-journal'].map((suffix) => {
    const artifactPath = `${path}${suffix}`;
    return {
      path: join(dirname(artifactPath), basename(artifactPath)),
      exists: existsSync(artifactPath),
      hash: existsSync(artifactPath) ? stateFileHash(artifactPath) : null,
    };
  });
}

function stateSqliteSnapshot(path: string): unknown {
  const db = new Database(path, { readonly: true });
  try {
    const hasTable = (name: string) => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
    const tableRows = (name: string): unknown => {
      try {
        return db.prepare(`SELECT * FROM "${name}"`).all();
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'query-failed' };
      }
    };
    return {
      objects: db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all(),
      marker: hasTable('auth_runtime_state') ? tableRows('auth_runtime_state') : [],
      ledger: hasTable('gateway_schema_migrations') ? tableRows('gateway_schema_migrations') : [],
    };
  } finally {
    db.close();
  }
}

describe('Phase 1 auth runtime marker and migration ledger', () => {
  it('pins the embedded checksum and creates exactly one V1 marker/receipt', () => {
    expect(foundationMigrationChecksum()).toBe(AUTH_FOUNDATION_MIGRATION_CHECKSUM);
    const db = open();
    runAuthFoundationMigration(db);
    expect(readAuthRuntimeMarker(db)).toEqual({ state: 'v1' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM auth_runtime_state`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT id, checksum_sha256 FROM gateway_schema_migrations`).get()).toEqual({
      id: AUTH_FOUNDATION_MIGRATION_ID,
      checksum_sha256: AUTH_FOUNDATION_MIGRATION_CHECKSUM,
    });
    db.close();
  });

  it('is an exact no-op for an already committed V1 foundation', () => {
    const db = open();
    runAuthFoundationMigration(db);
    const before = tableNames(db);
    runAuthFoundationMigration(db);
    expect(tableNames(db)).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM gateway_schema_migrations`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM auth_runtime_state`).get()).toEqual({ n: 1 });
    db.close();
  });

  it('records a verbose collision-safe trace for legacy and exact V1 scans', () => {
    const db = open();
    const legacy = traceAuthRuntimeState(db);
    expect(legacy.state).toBe('legacy');
    expect(legacy.steps).toEqual(['database-list', 'schema-inventory']);
    runAuthFoundationMigration(db);
    const exact = traceAuthRuntimeState(db);
    expect(exact.state).toBe('v1');
    expect(exact.steps).toContain('catalog-sql');
    expect(exact.steps).toContain('table-info:gateway_schema_migrations');
    expect(exact.steps).toContain('index-list:gateway_schema_migrations');
    expect(exact.steps).toContain('index-info:gateway_schema_migrations');
    expect(exact.steps).toContain('foreign-key-list:auth_runtime_state');
    expect(exact.steps).toContain('marker-select');
    expect(exact.steps).toContain('ledger-select');
    db.close();
  });

  it.each(['wrong-case-table', 'reserved-view-name', 'reserved-index-name', 'reserved-trigger-name'])('rejects reserved collision by type/name (%s)', (kind) => {
    const db = open();
    if (kind === 'wrong-case-table') db.exec('CREATE TABLE Gateway_Schema_Migrations (collision INTEGER)');
    if (kind === 'reserved-view-name') db.exec('CREATE VIEW auth_runtime_state AS SELECT 1 AS collision');
    if (kind === 'reserved-index-name') db.exec('CREATE TABLE unrelated (collision INTEGER); CREATE INDEX gateway_schema_migrations ON unrelated(collision)');
    if (kind === 'reserved-trigger-name') db.exec('CREATE TABLE unrelated (collision INTEGER); CREATE TRIGGER auth_runtime_state AFTER INSERT ON unrelated BEGIN SELECT 1; END');
    expect(traceAuthRuntimeState(db).state).toBe('incompatible');
    expect(() => readAuthRuntimeMarker(db)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
    expect(tableNames(db)).not.toContain('gateway_schema_migrations');
    db.close();
  });

  it('runs the exhaustive reserved-object collision matrix before BEGIN', () => {
    expect(COLLISION_MATRIX).toHaveLength(32);
    expect(new Set(COLLISION_MATRIX.map((testCase) => testCase.name)).size).toBe(COLLISION_MATRIX.length);
    for (const testCase of COLLISION_MATRIX) {
      const db = open();
      testCase.seed(db);
      const trace = traceAuthRuntimeState(db);
      expect(trace.state, testCase.name).toBe('incompatible');
      expect(trace.steps, testCase.name).toEqual(['database-list', 'schema-inventory']);
      const rows = db.prepare(`
        SELECT type, name, tbl_name
          FROM main.sqlite_schema
         WHERE lower(name) IN ('gateway_schema_migrations','auth_runtime_state')
            OR lower(tbl_name) IN ('gateway_schema_migrations','auth_runtime_state')
         ORDER BY type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY
      `).all() as Array<{ type: string; name: string; tbl_name: string }>;
      expect(rows.some((row) => row.type === testCase.objectType
        && (row.name.toLowerCase() === testCase.identifier || row.tbl_name.toLowerCase() === testCase.identifier))).toBe(true);
      const beforeCatalog = db.prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name, tbl_name`).all();
      expect(() => readAuthRuntimeMarker(db)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
      expect(db.prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name, tbl_name`).all()).toEqual(beforeCatalog);
      db.close();
    }
  });

  it('catches a TEMP collision and an attached-database collision on the same connection', () => {
    const tempDb = open();
    expect(readAuthRuntimeMarker(tempDb)).toEqual({ state: 'legacy' });
    tempDb.exec('CREATE TEMP TABLE auth_runtime_state (collision INTEGER)');
    expect(() => runAuthFoundationMigration(tempDb)).toThrow(AUTH_RUNTIME_MARKER_TEMP_SHADOW);
    expect(tableNames(tempDb)).not.toContain('gateway_schema_migrations');
    tempDb.close();

    const attachedDb = open();
    expect(readAuthRuntimeMarker(attachedDb)).toEqual({ state: 'legacy' });
    attachedDb.exec("ATTACH ':memory:' AS aux; CREATE TABLE aux.auth_runtime_state (collision INTEGER)");
    expect(() => runAuthFoundationMigration(attachedDb)).toThrow(AUTH_RUNTIME_MARKER_ATTACHED_DB);
    expect(tableNames(attachedDb)).not.toContain('gateway_schema_migrations');
    attachedDb.close();
  });

  it.each(['missing', 'extra', 'non-null'] as const)('rejects %s inherent ledger autoindex catalog row before BEGIN', async (variant) => {
    const path = dbPath();
    const seeded = new Database(path);
    seedExactV1(seeded);
    seeded.close();
    const db = new Database(path);
    expect(readAuthRuntimeMarker(db)).toEqual({ state: 'v1' });
    const coordination = mkdtempSync(join(tmpdir(), `torq-auth-v2-autoindex-${variant}-`));
    const ready = join(coordination, 'ready');
    const release = join(coordination, 'release');
    const worker = join(import.meta.dirname, 'helpers', 'auth-foundation-worker.mjs');
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', worker, path, ready, release, `autoindex-${variant}`], {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    const done = new Promise<number | null>((resolve) => child.once('close', resolve));
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error(`autoindex worker readiness timeout: ${variant}`);
      await sleep(10);
    }
    writeFileSync(release, 'go', 'utf8');
    const code = await Promise.race([done, sleep(10_000).then(() => { throw new Error(`autoindex worker timeout: ${variant}`); })]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout.trim())).toEqual({ result: 'autoindex-mutated' });
    const before = db.prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name, tbl_name`).all();
    expect(traceAuthRuntimeState(db).state, variant).toBe('incompatible');
    expect(() => readAuthRuntimeMarker(db)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
    expect(db.prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name, tbl_name`).all(), variant).toEqual(before);
    db.close();
  });

  it.each(['temp', 'attach'])('worker/preload-style same-connection collision refuses before migration (%s)', async (collisionMode) => {
    const path = dbPath();
    const coordination = mkdtempSync(join(tmpdir(), `torq-auth-v2-${collisionMode}-`));
    const ready = join(coordination, 'ready');
    const release = join(coordination, 'release');
    const worker = join(import.meta.dirname, 'helpers', 'auth-foundation-worker.mjs');
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', worker, path, ready, release, collisionMode], {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    const done = new Promise<number | null>((resolve) => child.once('close', resolve));
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error(`collision worker readiness timeout: ${collisionMode}`);
        await sleep(10);
      }
      writeFileSync(release, 'go', 'utf8');
      const code = await Promise.race([done, sleep(10_000).then(() => { throw new Error(`collision worker timeout: ${collisionMode}`); })]);
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toMatchObject({ result: 'refused' });
      const db = new Database(path, { readonly: true });
      expect(db.prepare(`SELECT name FROM main.sqlite_schema WHERE name IN ('gateway_schema_migrations','auth_runtime_state')`).all()).toEqual([]);
      db.close();
    } finally {
      writeFileSync(release, 'go', 'utf8');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.race([done, sleep(2_000)]);
    }
  });

  it('catches a committed collision from a separate process between the initial scan and BEGIN IMMEDIATE', async () => {
    const path = dbPath();
    const coordination = mkdtempSync(join(tmpdir(), 'torq-auth-v2-toctou-'));
    const ready = join(coordination, 'ready');
    const release = join(coordination, 'release');
    const worker = join(import.meta.dirname, 'helpers', 'auth-foundation-worker.mjs');
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', worker, path, ready, release, 'toctou-writer'], {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    const done = new Promise<number | null>((resolve) => child.once('close', resolve));
    const parent = new Database(path);
    try {
      expect(readAuthRuntimeMarker(parent)).toEqual({ state: 'legacy' });
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error('TOCTOU worker readiness timeout');
        await sleep(10);
      }
      writeFileSync(release, 'go', 'utf8');
      const code = await Promise.race([done, sleep(10_000).then(() => { throw new Error('TOCTOU worker timeout'); })]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout.trim())).toEqual({ result: 'collision-committed' });
      expect(() => runAuthFoundationMigration(parent)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
      expect(parent.prepare(`SELECT type,name,tbl_name FROM main.sqlite_schema ORDER BY type,name,tbl_name`).all()).toEqual([
        { type: 'table', name: 'auth_runtime_state', tbl_name: 'auth_runtime_state' },
      ]);
    } finally {
      writeFileSync(release, 'go', 'utf8');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.race([done, sleep(2_000)]);
      parent.close();
    }
  });

  it('catches a child-process non-null autoindex mutation after the initial V1 scan', async () => {
    const path = dbPath();
    const seed = new Database(path);
    seedExactV1(seed);
    seed.close();
    const parent = new Database(path);
    expect(readAuthRuntimeMarker(parent)).toEqual({ state: 'v1' });
    const coordination = mkdtempSync(join(tmpdir(), 'torq-auth-v2-autoindex-toctou-'));
    const ready = join(coordination, 'ready');
    const release = join(coordination, 'release');
    const worker = join(import.meta.dirname, 'helpers', 'auth-foundation-worker.mjs');
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', worker, path, ready, release, 'toctou-autoindex'], {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    const done = new Promise<number | null>((resolve) => child.once('close', resolve));
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error('autoindex TOCTOU worker readiness timeout');
        await sleep(10);
      }
      writeFileSync(release, 'go', 'utf8');
      const code = await Promise.race([done, sleep(10_000).then(() => { throw new Error('autoindex TOCTOU worker timeout'); })]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout.trim())).toEqual({ result: 'autoindex-mutated' });
      const childCatalog = parent.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name`).all();
      expect(childCatalog).toContainEqual({
        type: 'index',
        name: 'sqlite_autoindex_gateway_schema_migrations_1',
        tbl_name: 'gateway_schema_migrations',
        sql: 'CREATE INDEX sqlite_autoindex_gateway_schema_migrations_1 ON gateway_schema_migrations(id)',
      });
      const childHash = stateFileHash(path);
      expect(() => readAuthRuntimeMarker(parent)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
      expect(() => runAuthFoundationMigration(parent)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
      expect(stateFileHash(path)).toBe(childHash);
      expect(parent.prepare(`SELECT COUNT(*) AS n FROM main.gateway_schema_migrations`).get()).toEqual({ n: 1 });
      expect(parent.prepare(`SELECT COUNT(*) AS n FROM main.auth_runtime_state`).get()).toEqual({ n: 1 });
    } finally {
      writeFileSync(release, 'go', 'utf8');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.race([done, sleep(2_000)]);
      parent.close();
    }
  });

  it.each([
    'one-table', 'bad-checksum', 'extra-ledger', 'schema-two', 'bad-mode', 'duplicate-marker',
  ])('refuses %s before any writable state change', (caseName) => {
    const db = open();
    if (caseName === 'one-table') {
      db.exec(`CREATE TABLE gateway_schema_migrations (id TEXT PRIMARY KEY, checksum_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    } else {
      seedExactV1(db);
      if (caseName === 'bad-checksum') {
        db.prepare(`UPDATE gateway_schema_migrations SET checksum_sha256=?`).run('0'.repeat(64));
      } else if (caseName === 'extra-ledger') {
        db.prepare(`INSERT INTO gateway_schema_migrations VALUES ('extra','${'0'.repeat(64)}','2026-08-12T00:00:00.000Z')`).run();
      } else if (caseName === 'schema-two') {
        db.prepare(`UPDATE auth_runtime_state SET state_schema=2, mode='V2_TEST', launcher_generation=1, serving_state='STOPPED', config_digest_sha256='x', secret_set_id='x'`).run();
      } else if (caseName === 'bad-mode') {
        db.exec(`DROP TABLE auth_runtime_state`);
        const markerDdl = FOUNDATION_GATEWAY_MIGRATION_SQL.split('\n\n')[1]!;
        db.exec(markerDdl);
        db.prepare(`INSERT INTO auth_runtime_state
          (singleton,state_schema,mode,launcher_generation,serving_state,
           config_digest_sha256,secret_set_id,cutover_id,updated_at)
          VALUES (1,2,'V2_TEST',1,'STOPPED','x','x',NULL,?)`).run('2026-08-12T00:00:00.000Z');
      } else if (caseName === 'duplicate-marker') {
        db.exec(`DROP TABLE auth_runtime_state;
          CREATE TABLE auth_runtime_state (
            singleton INTEGER,
            state_schema INTEGER NOT NULL,
            mode TEXT NOT NULL,
            launcher_generation INTEGER,
            serving_state TEXT,
            config_digest_sha256 TEXT,
            secret_set_id TEXT,
            cutover_id TEXT,
            updated_at TEXT NOT NULL
          )`);
        db.prepare(`INSERT INTO auth_runtime_state VALUES (1,1,'V1_COMPAT',NULL,NULL,NULL,NULL,NULL,'2026-08-12T00:00:00.000Z')`).run();
        db.prepare(`INSERT INTO auth_runtime_state VALUES (1,1,'V1_COMPAT',NULL,NULL,NULL,NULL,NULL,'2026-08-12T00:00:00.000Z')`).run();
      }
    }
    const beforeJournal = db.pragma('journal_mode', { simple: true });
    const beforeTables = tableNames(db);
    expect(() => readAuthRuntimeMarker(db)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
    expect(db.pragma('journal_mode', { simple: true })).toBe(beforeJournal);
    expect(tableNames(db)).toEqual(beforeTables);
    db.close();
  });

  it.each([1, 2, 3, 4])('rolls back every injected migration statement fault (%s)', (failAfterStatement) => {
    const db = open();
    expect(() => runAuthFoundationMigration(db, { failAfterStatement })).toThrow();
    expect(tableNames(db)).not.toContain('gateway_schema_migrations');
    expect(tableNames(db)).not.toContain('auth_runtime_state');
    runAuthFoundationMigration(db);
    expect(readAuthRuntimeMarker(db)).toEqual({ state: 'v1' });
    db.close();
  });

  it.each([
    ['marker', `UPDATE auth_runtime_state SET updated_at='2023-02-31T00:00:00.000Z'`],
    ['ledger', `UPDATE gateway_schema_migrations SET applied_at='2023-02-31T00:00:00.000Z'`],
  ])('rejects impossible calendar dates in the %s timestamp', (_name, mutation) => {
    const db = open();
    seedExactV1(db);
    db.exec(mutation);
    expect(() => readAuthRuntimeMarker(db)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
    db.close();
  });

  it('rejects a case-mutated quoted CHECK literal while preserving literal case in canonical SQL', () => {
    const db = open();
    const [ledgerDdl, markerDdl] = FOUNDATION_GATEWAY_MIGRATION_SQL.split('\n\n') as [string, string];
    db.exec(ledgerDdl);
    db.exec(markerDdl.replace("state_schema=1 AND mode='V1_COMPAT'", "state_schema=1 AND mode='v1_compat'"));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO gateway_schema_migrations(id,checksum_sha256,applied_at)
      VALUES (?,?,?)`).run(AUTH_FOUNDATION_MIGRATION_ID, AUTH_FOUNDATION_MIGRATION_CHECKSUM, now);
    expect(() => readAuthRuntimeMarker(db)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
    db.close();
  });

  it.each([
    ['alternative whitespace', (ddl: string) => ddl.replace('state_schema=1', 'state_schema = 1'), false],
    ['quoted lowercase table name', (ddl: string) => ddl.replace('CREATE TABLE IF NOT EXISTS auth_runtime_state', 'CREATE TABLE IF NOT EXISTS "auth_runtime_state"'), false],
    ['keyword case drift', (ddl: string) => ddl.replace('CREATE TABLE IF NOT EXISTS auth_runtime_state', 'CREATE table IF NOT EXISTS auth_runtime_state'), true],
  ])('catalog-byte-equality mutation: handles %s against pinned SQLite SQL', (_name, alterMarker, accepts) => {
    const exactDb = open();
    seedExactV1(exactDb);
    expect(readAuthRuntimeMarker(exactDb)).toEqual({ state: 'v1' });
    exactDb.close();
    const db = open();
    const [ledgerDdl, markerDdl] = FOUNDATION_GATEWAY_MIGRATION_SQL.split('\n\n') as [string, string];
    db.exec(ledgerDdl);
    const mutatedMarkerDdl = alterMarker(markerDdl);
    expect(mutatedMarkerDdl).not.toBe(markerDdl);
    const pinnedCatalogSql = expectedCatalogSql(markerDdl);
    db.exec(mutatedMarkerDdl);
    const storedCatalogSql = (db.prepare(`SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='auth_runtime_state'`).get() as { sql: string }).sql;
    if (accepts) {
      expect(storedCatalogSql).toBe(pinnedCatalogSql);
    } else {
      expect(storedCatalogSql).not.toBe(pinnedCatalogSql);
    }
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO auth_runtime_state
      (singleton,state_schema,mode,launcher_generation,serving_state,
       config_digest_sha256,secret_set_id,cutover_id,updated_at)
      VALUES (1,1,'V1_COMPAT',NULL,NULL,NULL,NULL,NULL,?)`).run(now);
    db.prepare(`INSERT INTO gateway_schema_migrations(id,checksum_sha256,applied_at)
      VALUES (?,?,?)`).run(AUTH_FOUNDATION_MIGRATION_ID, AUTH_FOUNDATION_MIGRATION_CHECKSUM, now);
    if (accepts) {
      expect(readAuthRuntimeMarker(db)).toEqual({ state: 'v1' });
    } else {
      expect(() => readAuthRuntimeMarker(db)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
    }
    db.close();
  });

  it.each(['index', 'trigger'])('rejects an unexpected foundation %s', (kind) => {
    const db = open();
    seedExactV1(db);
    if (kind === 'index') db.exec('CREATE INDEX attacker_foundation_index ON auth_runtime_state(mode)');
    else db.exec(`CREATE TRIGGER attacker_foundation_trigger AFTER INSERT ON auth_runtime_state BEGIN SELECT 1; END`);
    expect(() => readAuthRuntimeMarker(db)).toThrow(AUTH_RUNTIME_MARKER_INCOMPATIBLE);
    db.close();
  });

  it('rechecks after BEGIN IMMEDIATE and refuses an incomplete marker that appeared after the read fence', () => {
    const db = open();
    expect(readAuthRuntimeMarker(db)).toEqual({ state: 'legacy' });
    db.exec(`CREATE TABLE auth_runtime_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      state_schema INTEGER NOT NULL CHECK(state_schema IN (1,2)),
      mode TEXT NOT NULL CHECK(mode IN ('V1_COMPAT','V2_TEST','V2_FINAL')),
      launcher_generation INTEGER CHECK(launcher_generation > 0),
      serving_state TEXT CHECK(serving_state IN ('STOPPED','VERIFYING','SERVING','FAILED')),
      config_digest_sha256 TEXT,
      secret_set_id TEXT,
      cutover_id TEXT,
      updated_at TEXT NOT NULL
    )`);
    expect(() => runAuthFoundationMigration(db)).toThrow(AuthRuntimeMarkerError);
    expect(() => readAuthRuntimeMarker(db)).toThrow(AuthRuntimeMarkerError);
    db.close();
  });

  it('allows two simultaneous independent processes to converge on one exact receipt', async () => {
    const path = dbPath();
    const root = join(import.meta.dirname, '..');
    const worker = join(root, 'tests', 'helpers', 'auth-foundation-worker.mjs');
    const coordination = mkdtempSync(join(tmpdir(), 'torq-auth-v2-race-'));
    const release = join(coordination, 'release');
    const readyPaths = [join(coordination, 'ready-a'), join(coordination, 'ready-b')];
    const children = readyPaths.map((readyPath) => {
      const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', worker, path, readyPath, release], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
      return { child, done };
    });
    try {
      const readyDeadline = Date.now() + 5_000;
      while (!readyPaths.every((readyPath) => existsSync(readyPath))) {
        if (Date.now() >= readyDeadline) throw new Error('foundation worker readiness timeout');
        await sleep(10);
      }
      writeFileSync(release, 'go', 'utf8');
      const results = await Promise.race([
        Promise.all(children.map((entry) => entry.done)),
        sleep(10_000).then(() => { throw new Error('foundation worker completion timeout'); }),
      ]);
      expect(results.every((result) => result.code === 0)).toBe(true);
      const outcomes = results.map((result) => JSON.parse(result.stdout.trim()) as { outcome: string });
      expect(outcomes.map((result) => result.outcome).sort()).toEqual(['migrated', 'noop']);
      expect(results.every((result) => result.stderr === '')).toBe(true);
      const db = new Database(path);
      expect(readAuthRuntimeMarker(db)).toEqual({ state: 'v1' });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM gateway_schema_migrations`).get()).toEqual({ n: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM auth_runtime_state`).get()).toEqual({ n: 1 });
      db.close();
    } finally {
      writeFileSync(release, 'go', 'utf8');
      for (const entry of children) {
        if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
      }
      await Promise.allSettled(children.map((entry) => entry.done));
    }
  });
});

describe('Phase 1 inert strict V2 wire contracts', () => {
  const hello = { protocolVersion: 2, expectedRole: 'operator', clientInfo: { name: 'torq-console', version: '1.0.0' } };

  function expectFixedStrictFailure(run: () => unknown, secret: string): void {
    let caught: unknown;
    try { run(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(StrictWireError);
    const error = caught as StrictWireError;
    expect(error.name).toBe('StrictWireError');
    expect(error.message).toBe('strict wire input rejected');
    expect(error.message).toHaveLength('strict wire input rejected'.length);
    expect(String(error)).not.toContain(secret);
  }

  it('accepts exact hello and rejects unknown fields', () => {
    expect(parseV2Hello(JSON.stringify(hello))).toEqual(hello);
    expect(() => V2HelloSchema.parse({ ...hello, role: 'operator' })).toThrow();
  });

  it('counts UTF-8 bytes and rejects valid or invalid UTF-8 binary payloads', () => {
    const multi = 'é'.repeat(Math.floor(V2_HELLO_MAX_BYTES / 2) + 1);
    expect(() => parseStrictJson(JSON.stringify({ value: multi }), V2_HELLO_MAX_BYTES)).toThrow(StrictWireError);
    const validBinary = new TextEncoder().encode(JSON.stringify({ value: 'ok' }));
    const invalidBinary = new Uint8Array([0xff, 0xfe]);
    expect(() => parseStrictJson(validBinary as unknown as string, V2_HELLO_MAX_BYTES)).toThrow(StrictWireError);
    expect(() => parseV2Hello(validBinary as unknown as string)).toThrow(StrictWireError);
    expect(() => parseStrictJson(invalidBinary as unknown as string, V2_HELLO_MAX_BYTES)).toThrow(StrictWireError);
    expect(() => parseV2Hello(invalidBinary as unknown as string)).toThrow(StrictWireError);
  });

  it('rejects escape-equivalent duplicate semantic keys before JSON.parse', () => {
    expect(() => parseStrictJson('{"a":1,"\\u0061":2}', 100)).toThrow(StrictWireError);
  });

  it('preserves the approved 32k prompt and 100k edited-markdown envelopes', () => {
    const prompt = { action: 'SUBMIT_PROMPT', prompt: 'p'.repeat(32_000), attachmentIds: [] };
    expect(parseV2PromptOrPreview(JSON.stringify(prompt)).prompt).toHaveLength(32_000);
    const edited = { action: 'APPROVE_SKILL', queueId: 'q', decision: 'APPROVE', editedMarkdown: 'm'.repeat(100_000) };
    expect(parseV2SkillDecision(JSON.stringify(edited)).editedMarkdown).toHaveLength(100_000);
    expect(JSON.stringify(prompt).length).toBeLessThan(V2_PROMPT_MAX_BYTES);
    expect(JSON.stringify(edited).length).toBeLessThan(V2_SKILL_DECISION_MAX_BYTES);
  });

  it('rejects strict-contract extras and malformed command shapes', () => {
    expect(() => V2ClientCommandSchema.parse({ action: 'APPROVE_TOOL', approvalId: 'a', decision: 'APPROVE', toolName: 'x' })).toThrow();
    expect(() => parseV2SkillDecision(JSON.stringify({ action: 'APPROVE_SKILL', queueId: 'q', decision: 'APPROVE', extra: true }))).toThrow();
  });

  it('dispatches public decoders by action and enforces the action envelope cap', () => {
    const skill = { action: 'APPROVE_SKILL', queueId: 'q', decision: 'APPROVE' };
    const preview = { action: 'PREVIEW_ROUTE', previewOf: 'p', prompt: 'p' };
    const oversizedPrompt = JSON.stringify({ action: 'SUBMIT_PROMPT', prompt: 'p'.repeat(290_000), attachmentIds: [] });
    expect(Buffer.byteLength(oversizedPrompt, 'utf8')).toBeGreaterThan(V2_PROMPT_MAX_BYTES);
    expect(parseV2ClientCommand(JSON.stringify(skill))).toEqual(skill);
    expect(parseV2ClientCommand(JSON.stringify(preview))).toMatchObject(preview);
    expect(() => parseV2PromptOrPreview(JSON.stringify(skill))).toThrow(StrictWireError);
    expect(() => parseV2SkillDecision(JSON.stringify(preview))).toThrow(StrictWireError);
    expect(() => parseV2Hello(oversizedPrompt)).toThrow(StrictWireError);
    expect(() => parseV2ClientCommand(oversizedPrompt)).toThrow(StrictWireError);
    expect(() => parseV2PromptOrPreview(oversizedPrompt)).toThrow(StrictWireError);
    expect(() => parseV2SkillDecision(oversizedPrompt)).toThrow(StrictWireError);
  });

  it('enforces exact and plus-one UTF-8 bounds for shared identifiers and client info', () => {
    const idExact = 'é'.repeat(128);
    const idPlusOne = `${'é'.repeat(127)}aé`;
    const infoExact = 'é'.repeat(64);
    const infoPlusOne = `${'é'.repeat(63)}aé`;
    expect(Buffer.byteLength(idExact, 'utf8')).toBe(256);
    expect(Buffer.byteLength(idPlusOne, 'utf8')).toBe(257);
    expect(Buffer.byteLength(infoExact, 'utf8')).toBe(128);
    expect(Buffer.byteLength(infoPlusOne, 'utf8')).toBe(129);

    expect(parseV2SkillDecision(JSON.stringify({ action: 'APPROVE_SKILL', queueId: idExact, decision: 'APPROVE' })).queueId).toBe(idExact);
    expect(() => parseV2SkillDecision(JSON.stringify({ action: 'APPROVE_SKILL', queueId: idPlusOne, decision: 'APPROVE' }))).toThrow(StrictWireError);
    expect(parseV2ClientCommand(JSON.stringify({ action: 'APPROVE_TOOL', approvalId: idExact, decision: 'APPROVE' })).approvalId).toBe(idExact);
    expect(() => parseV2ClientCommand(JSON.stringify({ action: 'APPROVE_TOOL', approvalId: idPlusOne, decision: 'APPROVE' }))).toThrow(StrictWireError);
    expect(parseV2PromptOrPreview(JSON.stringify({ action: 'SUBMIT_PROMPT', prompt: 'p', attachmentIds: [idExact] })).attachmentIds).toEqual([idExact]);
    expect(() => parseV2PromptOrPreview(JSON.stringify({ action: 'SUBMIT_PROMPT', prompt: 'p', attachmentIds: [idPlusOne] }))).toThrow(StrictWireError);
    expect(parseV2Hello(JSON.stringify({ protocolVersion: 2, expectedRole: 'operator', clientInfo: { name: infoExact, version: infoExact } })).clientInfo.name).toBe(infoExact);
    expect(() => parseV2Hello(JSON.stringify({ protocolVersion: 2, expectedRole: 'operator', clientInfo: { name: infoPlusOne, version: infoExact } }))).toThrow(StrictWireError);
    expect(() => parseV2Hello(JSON.stringify({ protocolVersion: 2, expectedRole: 'operator', clientInfo: { name: infoExact, version: infoPlusOne } }))).toThrow(StrictWireError);
  });

  it('maps long unknown-key/schema failures to one bounded non-secret error', () => {
    const secret = 'AUTH_ATTACKER_SECRET_SENTINEL';
    const unknown = `unknown_${'x'.repeat(1_024)}_${secret}`;
    expectFixedStrictFailure(
      () => parseV2Hello(JSON.stringify({ ...hello, [unknown]: true })),
      secret,
    );
    expectFixedStrictFailure(
      () => parseV2ClientCommand(JSON.stringify({ action: 'APPROVE_TOOL', approvalId: 'a', decision: 'APPROVE', [unknown]: true })),
      secret,
    );
    expectFixedStrictFailure(
      () => parseV2PromptOrPreview(JSON.stringify({ action: 'SUBMIT_PROMPT', prompt: 'p', attachmentIds: [], [unknown]: true })),
      secret,
    );
    expectFixedStrictFailure(
      () => parseV2SkillDecision(JSON.stringify({ action: 'APPROVE_SKILL', queueId: 'q', decision: 'APPROVE', [unknown]: true })),
      secret,
    );
  });

  it('enforces the exact attachment count and previewOf UTF-8 byte bounds', () => {
    const attachment = { action: 'SUBMIT_PROMPT', prompt: 'p', attachmentIds: Array.from({ length: V2_ATTACHMENT_COUNT_MAX }, (_, i) => `a-${i}`) };
    expect(V2ClientCommandSchema.parse(attachment).attachmentIds).toHaveLength(64);
    expect(() => V2ClientCommandSchema.parse({ ...attachment, attachmentIds: [...attachment.attachmentIds, 'a-64'] })).toThrow();

    const preview = (value: string) => ({ action: 'PREVIEW_ROUTE', previewOf: value, prompt: 'p' });
    const exact = 'é'.repeat(Math.floor(V2_PREVIEW_OF_MAX_BYTES / 2));
    expect(Buffer.byteLength(exact, 'utf8')).toBe(V2_PREVIEW_OF_MAX_BYTES);
    expect(V2ClientCommandSchema.parse(preview(exact)).previewOf).toBe(exact);
    expect(() => V2ClientCommandSchema.parse(preview(`${exact}é`))).toThrow();
  });
});

describe('Phase 4 protected semantic manifest', () => {
  it('retains the c2850f5 shared live approve predicate and physical test/guidance seams', () => {
    const root = join(import.meta.dirname, '..');
    const read = (path: string) => readFileSync(join(root, path), 'utf8');
    const authz = read('packages/gateway/src/authz.ts');
    const phase4Tests = read('tests/collab-h1-operator-subordination.test.ts');
    const guidance = read('packages/gateway/src/skillDecision.ts');
    expect(authz).toContain("cmd.action === 'APPROVE_TOOL' || cmd.action === 'APPROVE_SKILL'");
    expect(authz).toContain("holdsAuthority('approve')");
    expect(phase4Tests).toContain('P4-8');
    expect(phase4Tests).toContain('a single grant authorizes BOTH APPROVE_TOOL and APPROVE_SKILL');
    expect(guidance).toContain('describeSkillDecision');

    // OPERATOR RULING 2026-08-16 ("Re-pin phase1, leave 2a red"): the phase1
    // server-owned-authority migration (landed 985f8b9 on operator
    // instruction) deliberately moved resume-role enforcement out of
    // authz.ts into sessions.resolve(), and PRD-TCLAW-COLLAB-PRESENCE-UI-005
    // S1 added explicit channel-seat deny arms for the two collab read
    // commands. authz.ts therefore no longer matches the c2850f5 bytes.
    // The seam-freeze survives as an EXPLICIT baseline pin: any change to
    // authz.ts still fails this test until the pin is re-authorized with a
    // dated note — incidental drift stays caught, authorized migration
    // does not. The semantic containment assertions above (approve
    // predicate, holdsAuthority) are unchanged and still enforced.
    const frozenPaths = [
      'packages/gateway/src/skillDecision.ts',
      'tests/collab-h1-operator-subordination.test.ts',
    ];
    const changed = execFileSync('git', ['diff', '--name-only', 'c2850f5', '--', ...frozenPaths], { cwd: root, encoding: 'utf8' });
    expect(changed.trim()).toBe('');
    // Post-phase1 authz baseline (authorizations: phase1 landing 985f8b9 +
    // PRD-005 S1 deny arms (2026-08-16) + PRD-005 S3 POST_CHANNEL_MESSAGE
    // deny arm, 2026-08-17 -- same seat-lattice ruling as the S1 read
    // commands, adding one explicit `case 'POST_CHANNEL_MESSAGE':` deny arm
    // to the channel-seat switch plus its doc-comment entry +
    // PRD-TCLAW-AGENT-PARTICIPATION-007 S1 (2026-08-17): added
    // AuthzContext.agentCollabWrite, the ONE seat-lattice widening this
    // slice makes -- role 'node' now admits POST_CHANNEL_MESSAGE when the
    // caller (server.ts) has already verified the connection is a real
    // agent-kind collab principal AND TORQCLAW_AGENT_PARTICIPATION is on;
    // every other action on 'node' is unchanged (still DENY_NOT_PERMITTED)
    // and the flag-off/absent-field case is byte-identical to before this
    // slice) +
    // PRD-TCLAW-AGENT-PARTICIPATION-007 S3 (2026-08-18): added an explicit
    // `case 'SET_AUTOREPLY_STOP': return DENY_NOT_PERMITTED;` arm to the
    // 'channel'-seat switch (grouped with the existing POST_CHANNEL_MESSAGE
    // deny, same seat-lattice reasoning) plus its doc-comment entry. The
    // 'node'-seat branch is UNCHANGED -- STOP falls through its existing
    // `return DENY_NOT_PERMITTED;` default with no new allow-arm, so an
    // agent connection has no path to this command regardless of
    // TORQCLAW_AGENT_PARTICIPATION/TORQCLAW_AGENT_AUTOREPLY. The operator
    // branch (authorizeOperator) is untouched; STOP falls through its
    // existing blanket ALLOW for any non-APPROVE_TOOL/APPROVE_SKILL action,
    // exactly like every other pre-existing operator-only command.
    // Recompute and re-authorize deliberately on any future approved
    // change; never delete this pin.
    const authzSha = createHash('sha256').update(authz).digest('hex');
    expect(authzSha).toBe('80cf29c50c2eac1835830ea282613d4b1cb21f571812655f670e81b472198d10');
    // The migration's own markers: the moved guard must not silently return,
    // and the relocation note must remain declared where it happened.
    expect(authz).not.toContain('export function checkResumeRole');
    expect(authz).toContain('sessions.resolve()');
  });
});

describe('Phase 1 scope and dependency guards', () => {
  it('keeps strict V2 code gateway-local and out of production WebSocket wiring', () => {
    const root = join(import.meta.dirname, '..');
    const read = (path: string) => readFileSync(join(root, path), 'utf8');
    const v2Contracts = read('packages/gateway/src/v2Contracts.ts');
    const strictWire = read('packages/gateway/src/strictWire.ts');
    const server = read('packages/gateway/src/server.ts');
    expect(v2Contracts).not.toMatch(/(?:[\\/]node_modules[\\/]|\.\.[\\/]\.\.[\\/]contracts)/);
    expect(strictWire).not.toMatch(/(?:[\\/]node_modules[\\/]|\.\.[\\/]\.\.[\\/]contracts)/);
    expect(server).not.toMatch(/(?:from\s+['"].*(?:v2Contracts|strictWire)|import\s*\(\s*['"].*(?:v2Contracts|strictWire))/);
    expect(server).not.toContain('V2HelloSchema');
    expect(server).not.toContain('V2ClientCommandSchema');
  });
});

describe('Phase 1 built-process downgrade fence', () => {
  it('refuses a non-V1 marker before the gateway listener binds', async () => {
    const { ensureGatewayBuild, launchGateway } = await import('./helpers/collab-gateway-harness.js');
    await ensureGatewayBuild();
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-auth-v2-built-'));
    const state = new Database(join(dataDir, 'state.db'));
    seedExactV1(state);
    state.prepare(`UPDATE auth_runtime_state
      SET state_schema=2, mode='V2_FINAL', launcher_generation=1,
          serving_state='STOPPED', config_digest_sha256='x', secret_set_id='x'`).run();
    state.close();

    const gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_GATEWAY_TOKEN: 'root-token',
      TORQCLAW_COLLAB_ENABLED: '0',
    }, false);
    try {
      await expect(gateway.ready).rejects.toThrow(/exited before readiness/);
      expect(gateway.stderr()).not.toContain('listening on');
    } finally {
      await gateway.stop();
    }
  }, 240_000);

  it('refuses every malformed marker matrix case before bind, bridge discovery, or state mutation', async () => {
    const root = join(import.meta.dirname, '..');
    const { ensureGatewayBuild, GATEWAY_DIST_ENTRY, reservePort } = await import('./helpers/collab-gateway-harness.js');
    await ensureGatewayBuild();
    const markerDdl = FOUNDATION_GATEWAY_MIGRATION_SQL.split('\n\n')[1]!;
    const ledgerDdl = FOUNDATION_GATEWAY_MIGRATION_SQL.split('\n\n')[0]!;
    const cases: Array<{ name: string; seed: (db: Database.Database) => void }> = [
      ...COLLISION_MATRIX.map(({ name, seed }) => ({ name, seed })),
      { name: 'marker-only', seed: (db) => db.exec(markerDdl) },
      { name: 'ledger-only', seed: (db) => db.exec(ledgerDdl) },
      { name: 'wrong-case-table', seed: (db) => db.exec('CREATE TABLE Gateway_Schema_Migrations (collision INTEGER)') },
      { name: 'canonical-view', seed: (db) => db.exec('CREATE VIEW auth_runtime_state AS SELECT 1 AS collision') },
      { name: 'reserved-index-name', seed: (db) => db.exec('CREATE TABLE unrelated (collision INTEGER); CREATE INDEX gateway_schema_migrations ON unrelated(collision)') },
      { name: 'reserved-trigger-name', seed: (db) => db.exec('CREATE TABLE unrelated (collision INTEGER); CREATE TRIGGER auth_runtime_state AFTER INSERT ON unrelated BEGIN SELECT 1; END') },
      ...(['V2_TEST', 'V2_FINAL'] as const).map((mode) => ({
        name: `schema2-${mode}`,
        seed: (db: Database.Database) => {
          seedExactV1(db);
          db.prepare(`UPDATE auth_runtime_state
            SET state_schema=2, mode=?, launcher_generation=1,
                serving_state='STOPPED', config_digest_sha256='x', secret_set_id='x'`).run(mode);
        },
      })),
      {
        name: 'wrong-checksum',
        seed: (db: Database.Database) => {
          seedExactV1(db);
          db.prepare(`UPDATE gateway_schema_migrations SET checksum_sha256=?`).run('0'.repeat(64));
        },
      },
      {
        name: 'extra-ledger',
        seed: (db: Database.Database) => {
          seedExactV1(db);
          db.prepare(`INSERT INTO gateway_schema_migrations VALUES ('extra','${'0'.repeat(64)}','2026-08-12T00:00:00.000Z')`).run();
        },
      },
      {
        name: 'malformed-table-shape',
        seed: (db: Database.Database) => {
          seedExactV1(db);
          db.exec(`DROP TABLE auth_runtime_state; CREATE TABLE auth_runtime_state (singleton INTEGER PRIMARY KEY)`);
        },
      },
      {
        name: 'missing-singleton',
        seed: (db: Database.Database) => {
          seedExactV1(db);
          db.exec(`DELETE FROM auth_runtime_state`);
        },
      },
      {
        name: 'impossible-timestamp',
        seed: (db: Database.Database) => {
          seedExactV1(db);
          db.exec(`UPDATE auth_runtime_state SET updated_at='2023-02-31T00:00:00.000Z'`);
        },
      },
      {
        name: 'case-mutated-check',
        seed: (db: Database.Database) => {
          db.exec(ledgerDdl);
          db.exec(markerDdl.replace("state_schema=1 AND mode='V1_COMPAT'", "state_schema=1 AND mode='v1_compat'"));
        },
      },
      {
        name: 'unexpected-index',
        seed: (db: Database.Database) => {
          seedExactV1(db);
          db.exec(`CREATE INDEX attacker_foundation_index ON auth_runtime_state(mode)`);
        },
      },
      {
        name: 'unexpected-trigger',
        seed: (db: Database.Database) => {
          seedExactV1(db);
          db.exec(`CREATE TRIGGER attacker_foundation_trigger AFTER INSERT ON auth_runtime_state BEGIN SELECT 1; END`);
        },
      },
    ];

    for (const testCase of cases) {
      const dataDir = mkdtempSync(join(tmpdir(), `torq-auth-v2-built-${testCase.name}-`));
      const statePath = join(dataDir, 'state.db');
      const state = new Database(statePath);
      testCase.seed(state);
      state.close();
      const beforeHash = stateFileHash(statePath);
      const beforeSqlite = stateSqliteSnapshot(statePath);
      const beforeJournalArtifacts = stateJournalArtifacts(statePath);
      const port = await reservePort();
      const child = spawn(process.execPath, [GATEWAY_DIST_ENTRY], {
        cwd: join(root, 'packages', 'gateway'),
        env: {
          ...process.env,
          TORQCLAW_DATA_DIR: dataDir,
          TORQCLAW_GATEWAY_TOKEN: 'root-token',
          TORQCLAW_COLLAB_ENABLED: '0',
          TORQCLAW_PORT: String(port),
          TORQCLAW_HOST: '127.0.0.1',
          NODE_OPTIONS: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      const done = new Promise<number | null>((resolve) => child.once('close', resolve));
      let result: number | null = null;
      try {
        result = await Promise.race([
          done,
          sleep(15_000).then(() => { throw new Error(`built refusal timeout: ${testCase.name}`); }),
        ]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await Promise.race([done, sleep(2_000)]);
      }
      expect(result, testCase.name).not.toBe(0);
      expect(`${stdout}\n${stderr}`).not.toContain('listening on');
      expect(`${stdout}\n${stderr}`).not.toMatch(/bridge discovery|MCP server|discovered/i);
      expect(stateFileHash(statePath), testCase.name).toBe(beforeHash);
      expect(stateSqliteSnapshot(statePath), testCase.name).toEqual(beforeSqlite);
      expect(stateJournalArtifacts(statePath), testCase.name).toEqual(beforeJournalArtifacts);
    }
  }, 240_000);
});
