/**
 * Cross-cutting finding 9 — the storage.ts module-level db singleton was a
 * test-isolation hazard. These tests pin the fix.
 *
 * The old shape (`export const db = new Database(...)`) opened the file as
 * an import side effect and could never be re-pointed, so two suites in one
 * vitest worker shared one state.db and could observe each other's rows.
 * That is the suspected root of the transient parallel-suite flakes.
 *
 * What must remain true after the fix (and is asserted below):
 *   - production behaviour is unchanged: same file, same pragmas, same
 *     migrations, same working `db.prepare(...)` at module scope;
 *   - the handle can be dropped and re-resolved against the CURRENT
 *     TORQCLAW_DATA_DIR, so a suite can get a genuinely private database.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirA = mkdtempSync(join(tmpdir(), 'torq-storage-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'torq-storage-b-'));
const originalDataDir = process.env.TORQCLAW_DATA_DIR;
process.env.TORQCLAW_DATA_DIR = dirA;

const { db, resetStateDbForTest } = await import('../packages/gateway/src/storage.js');

afterAll(() => {
  resetStateDbForTest();
  if (originalDataDir === undefined) delete process.env.TORQCLAW_DATA_DIR;
  else process.env.TORQCLAW_DATA_DIR = originalDataDir;
});

describe('storage.ts state.db handle (cross-cutting finding 9)', () => {
  it('behaves exactly like a real better-sqlite3 handle through the export', () => {
    // The whole point of keeping `db` an object (not a getter) is that
    // module-scope `db.prepare(...)` in approvals.ts / receipts.ts keeps
    // working untouched.
    const stmt = db.prepare('SELECT 1 AS one');
    expect((stmt.get() as { one: number }).one).toBe(1);
    expect(typeof db.transaction).toBe('function');
    expect(db.open).toBe(true);
  });

  it('applies the schema and pragmas on open, as production expects', () => {
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    ).all() as { name: string }[]).map((r) => r.name);
    for (const t of ['sessions', 'events', 'tasks', 'tool_approvals', 'run_receipts']) {
      expect(tables, `${t} must be migrated at open`).toContain(t);
    }
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // tasks.telemetry_json is the guarded ALTER that must have run.
    const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain('telemetry_json');
  });

  it('opens against the data dir that was current at first access', () => {
    expect(existsSync(join(dirA, 'state.db'))).toBe(true);
  });

  it('THE FIX: reset re-resolves against the CURRENT data dir', () => {
    // Write a marker into A's database.
    db.prepare("INSERT INTO sessions (id, role, client_name) VALUES ('marker-a','operator','x')").run();
    expect(db.prepare("SELECT id FROM sessions WHERE id='marker-a'").get()).toBeDefined();

    // Re-point at a different directory, exactly as a suite wanting a
    // private database would.
    process.env.TORQCLAW_DATA_DIR = dirB;
    resetStateDbForTest();

    // B is a genuinely separate database: it is migrated, and A's row is
    // NOT visible. Before the fix this was impossible -- the handle was
    // bound for the life of the process.
    //
    // The query comes FIRST: opening is lazy, so the file only exists once
    // something actually touches the handle. That laziness is the feature
    // (it is what lets the data dir be chosen after import), so the test
    // has to respect it rather than assert the file into existence.
    expect(db.prepare("SELECT id FROM sessions WHERE id='marker-a'").get()).toBeUndefined();
    expect(existsSync(join(dirB, 'state.db'))).toBe(true);

    // ...and A still has its own row when we point back.
    process.env.TORQCLAW_DATA_DIR = dirA;
    resetStateDbForTest();
    expect(db.prepare("SELECT id FROM sessions WHERE id='marker-a'").get()).toBeDefined();
  });

  it('reset is idempotent and never throws on teardown', () => {
    expect(() => { resetStateDbForTest(); resetStateDbForTest(); }).not.toThrow();
    // The next access transparently re-opens.
    expect((db.prepare('SELECT 2 AS two').get() as { two: number }).two).toBe(2);
  });
});
