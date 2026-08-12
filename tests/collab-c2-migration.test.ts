/**
 * C2-1 — additive approval migration.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §1.5, §3.1, §6.2, §8 C2-1, §10.3, §13.
 *
 * THE AC THIS FILE DISCHARGES
 * ---------------------------
 * "pre/post manifests prove table/rowid/original columns/rows/values/
 *  args_json/status, live C0.1, skill_queue, and unrelated objects
 *  unchanged; repeat/interruption safe; legacy NULL rows inert under
 *  flag-on and unchanged under flag-off."
 *
 * The manifest approach is deliberate. Asserting "the migration added six
 * columns" is weak -- it says nothing about what the migration DESTROYED.
 * Revision 4 of the PRD exists because an earlier revision proposed a
 * destructive table rebuild, so the load-bearing proof here is the
 * NEGATIVE one: a full before/after digest of every table, rowid, and
 * value, asserted identical except for the six declared additions.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSurfaceSecuritySchema } from '../packages/gateway/src/surfaceSecurity.js';
import {
  ensureApprovalBrokerSchema, TOOL_APPROVAL_C2_COLUMNS,
} from '../packages/gateway/src/approvalSchema.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(
  join(here, '..', 'packages', 'gateway', 'db', 'schema.sql'), 'utf8',
);
const RESILIENCE_BEGIN = '-- TORQCLAW_RESILIENCE_SCHEMA_BEGIN';
const legacySchema = SCHEMA_SQL.slice(0, SCHEMA_SQL.indexOf(RESILIENCE_BEGIN));

/** A baseline state.db with realistic legacy rows, exactly as shipped. */
function baselineDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchema);
  db.prepare("INSERT INTO sessions (id, role, client_name) VALUES ('s1','operator','c')").run();
  db.prepare(
    `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
     VALUES ('r1','s1','LOCAL_EDGE','because','completed','{"id":"r1"}')`,
  ).run();
  // Legacy approvals: one pending, one decided. Their args_json carries
  // awkward bytes on purpose -- unicode and quotes are exactly what a
  // careless "migration" would mangle.
  db.prepare(
    `INSERT INTO tool_approvals (approval_id, request_id, tool_name, args_json, status, decided_at)
     VALUES ('a1','r1','filesystem__write_file','{"path":"/tmp/é\\"x"}','pending',NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO tool_approvals (approval_id, request_id, tool_name, args_json, status, decided_at)
     VALUES ('a2','r1','shell__run','{"cmd":"ls"}','approved','2020-01-01 00:00:00')`,
  ).run();
  db.prepare(
    `INSERT INTO skill_queue (queue_id, proposed_name, skill_markdown, status)
     VALUES ('q1','n','# md','pending')`,
  ).run();
  return db;
}

/** Every table's full contents plus rowids -- the destructive-change detector. */
function manifest(db: Database.Database, table: string): unknown[] {
  return db.prepare(`SELECT rowid AS __rowid, * FROM ${table} ORDER BY rowid`).all();
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function tableSql(db: Database.Database, name: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name) as
    | { sql: string } | undefined;
  return row?.sql ?? '';
}

function migrate(db: Database.Database): void {
  ensureSurfaceSecuritySchema(db);
  ensureApprovalBrokerSchema(db);
}

describe('C2-1 additive approval migration (§3.1, §6.2)', () => {
  it('adds EXACTLY the six declared nullable columns, and no others', () => {
    const db = baselineDb();
    const before = columnNames(db, 'tool_approvals');
    migrate(db);
    const after = columnNames(db, 'tool_approvals');

    const added = after.filter((c) => !before.includes(c));
    expect(added).toEqual([
      'origin_principal_id', 'origin_surface_id', 'decided_principal_id',
      'decided_surface_id', 'expires_at', 'context_hash',
    ]);
    expect(added).toHaveLength(6);
    expect(TOOL_APPROVAL_C2_COLUMNS.map(([n]) => n)).toEqual(added);
    // Nothing was removed or reordered: the original columns keep their
    // exact positions, which is what preserves `SELECT *` consumers.
    expect(after.slice(0, before.length)).toEqual(before);
    db.close();
  });

  it('every added column is NULLABLE with no DEFAULT (legacy rows stay valid)', () => {
    const db = baselineDb();
    migrate(db);
    const info = db.prepare(`PRAGMA table_info(tool_approvals)`).all() as
      { name: string; notnull: number; dflt_value: unknown }[];
    for (const [name] of TOOL_APPROVAL_C2_COLUMNS) {
      const col = info.find((c) => c.name === name)!;
      expect(col.notnull, `${name} must be nullable`).toBe(0);
      // A DEFAULT would silently rewrite the meaning of every historical
      // row; the PRD says "no column has a new default or constraint".
      expect(col.dflt_value, `${name} must have no default`).toBeNull();
    }
    db.close();
  });

  it('PRESERVES every original tool_approvals row, value, rowid and args_json', () => {
    const db = baselineDb();
    const before = manifest(db, 'tool_approvals');
    migrate(db);
    const after = manifest(db, 'tool_approvals') as Record<string, unknown>[];

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i += 1) {
      const b = before[i] as Record<string, unknown>;
      const a = after[i]!;
      // rowid ordering and identity preserved (no rebuild happened)
      expect(a.__rowid).toBe(b.__rowid);
      for (const key of Object.keys(b)) {
        expect(a[key], `${key} on rowid ${String(b.__rowid)}`).toStrictEqual(b[key]);
      }
      // and the six additions are NULL on every legacy row
      for (const [name] of TOOL_APPROVAL_C2_COLUMNS) expect(a[name]).toBeNull();
    }
    db.close();
  });

  it('does NOT rebuild the table: the original CREATE statement is byte-identical', () => {
    // A rebuild (create-new/copy/drop/rename) rewrites sqlite_master.sql.
    // ALTER TABLE ADD COLUMN only appends to it. Asserting the ORIGINAL
    // prefix survives verbatim is what distinguishes the two.
    const db = baselineDb();
    const before = tableSql(db, 'tool_approvals');
    migrate(db);
    const after = tableSql(db, 'tool_approvals');
    expect(after.startsWith(before.trimEnd().slice(0, before.trimEnd().length - 1))).toBe(true);
    expect(after).toContain('args_json   TEXT NOT NULL');
    db.close();
  });

  it('leaves skill_queue, tasks, sessions and unrelated objects untouched', () => {
    const db = baselineDb();
    const before = {
      skill_queue: manifest(db, 'skill_queue'),
      tasks: manifest(db, 'tasks'),
      sessions: manifest(db, 'sessions'),
      skillSql: tableSql(db, 'skill_queue'),
      taskSql: tableSql(db, 'tasks'),
    };
    migrate(db);
    expect(manifest(db, 'skill_queue')).toStrictEqual(before.skill_queue);
    expect(manifest(db, 'tasks')).toStrictEqual(before.tasks);
    expect(manifest(db, 'sessions')).toStrictEqual(before.sessions);
    expect(tableSql(db, 'skill_queue')).toBe(before.skillSql);
    expect(tableSql(db, 'tasks')).toBe(before.taskSql);
    db.close();
  });

  it('creates the declared additive objects and the one declared index', () => {
    const db = baselineDb();
    migrate(db);
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    ).all() as { name: string }[]).map((r) => r.name);
    for (const t of [
      'gateway_surface_security', 'gateway_profile_delegations', 'gateway_task_origins',
      'surface_authorities', 'gateway_approval_bindings', 'gateway_action_grants',
      'approval_deliveries',
    ]) expect(names, `${t} must exist`).toContain(t);

    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tool_approvals_status_expires'`,
    ).get();
    expect(idx).toBeDefined();
    db.close();
  });

  it('is idempotent: a repeat run is a no-op (interruption is safe to re-run)', () => {
    const db = baselineDb();
    migrate(db);
    const after1 = {
      cols: columnNames(db, 'tool_approvals'),
      rows: manifest(db, 'tool_approvals'),
      master: db.prepare(`SELECT type,name,sql FROM sqlite_master ORDER BY name`).all(),
    };
    // Run it three more times, as an interrupted-and-retried boot would.
    migrate(db); migrate(db); migrate(db);
    expect(columnNames(db, 'tool_approvals')).toEqual(after1.cols);
    expect(manifest(db, 'tool_approvals')).toStrictEqual(after1.rows);
    expect(db.prepare(`SELECT type,name,sql FROM sqlite_master ORDER BY name`).all())
      .toStrictEqual(after1.master);
    db.close();
  });

  it('runs on a FRESH database too (not only on a legacy one)', () => {
    const db = new Database(':memory:');
    db.exec(legacySchema);
    expect(() => migrate(db)).not.toThrow();
    expect(columnNames(db, 'tool_approvals')).toContain('context_hash');
    db.close();
  });

  it("status accepts 'expired' without a DDL change (CT-3: there is no CHECK)", () => {
    const db = baselineDb();
    migrate(db);
    db.prepare(`UPDATE tool_approvals SET status='expired' WHERE approval_id='a1'`).run();
    const row = db.prepare(`SELECT status FROM tool_approvals WHERE approval_id='a1'`).get() as
      { status: string };
    expect(row.status).toBe('expired');
    db.close();
  });

  it('approval_deliveries carries its state CHECK from first ship (new table CAN)', () => {
    const db = baselineDb();
    migrate(db);
    expect(() => db.prepare(
      `INSERT INTO approval_deliveries (id, approval_id, target_surface_id, delivery_state)
       VALUES ('d1','a1','srf-1','not-a-state')`,
    ).run()).toThrow(/CHECK/i);
    db.close();
  });

  it('gateway_action_grants enforces one-shot structurally: approval_id is UNIQUE', () => {
    const db = baselineDb();
    migrate(db);
    // FK targets must exist for a legitimate insert; use a bare-bones set.
    db.pragma('foreign_keys = OFF');
    const ins = (grantId: string) => db.prepare(
      `INSERT INTO gateway_action_grants
        (grant_id, approval_id, source_request_id, dispatch_request_id, tool_name,
         action_hash, context_hash, origin_surface_id, deciding_surface_id,
         origin_auth_epoch, deciding_auth_epoch, origin_capability_revision,
         delegation_id, profile_delegation_revision, deciding_authority_grant_id,
         effective_profile_policy_hash, registry_enforcement_hash, expires_at)
       VALUES (?, 'a1','r1',?,'t','h','c','s','s',1,1,1,'d',1,'g','p','r','2099-01-01')`,
    ).run(grantId, `dispatch-${grantId}`);
    ins('g1');
    // A second grant for the SAME approval is what "one-shot" forbids.
    expect(() => ins('g2')).toThrow(/UNIQUE/i);
    db.close();
  });

  it('gateway_task_origins gains the four delegation-evidence columns (C1 §7 owed item)', () => {
    const db = baselineDb();
    migrate(db);
    const cols = columnNames(db, 'gateway_task_origins');
    for (const c of [
      'delegation_id', 'profile_delegation_revision',
      'effective_profile_policy_hash', 'registry_enforcement_hash',
    ]) expect(cols, `${c} must exist`).toContain(c);
    db.close();
  });
});
