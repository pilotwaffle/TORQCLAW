/**
 * C1-1 — surfaces table + guarded additive migration.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §2.2, §2.10, §6.2, §8 C1-1 AC.
 *
 * The load-bearing test here is the LEGACY-DB trap: a database that already
 * ran the C0 collaboration migration must still pick up the C1 tables.
 * `runCollaborationMigration` is a recorded no-op after its first run
 * (migration.ts:44-50), so a C1 DDL folded into that function would never
 * reach any existing installation. That is the exact IF-NOT-EXISTS trap
 * §2.10 calls out, and it is what the "legacy database" cases below pin.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import {
  runSurfaceIdentityMigration,
  addSurfaceColumnIfMissing,
  C1_SURFACES_MIGRATION_ID,
  SURFACE_KINDS,
} from '../../packages/collab/src/surfaces.js';
import {
  createSurface,
  runSurfaceAuditMigration,
  SurfaceProvisioningError,
} from '../../packages/collab/src/surfaceStore.js';

/** A database at the C0 baseline: bootstrapped, no C1 tables yet. */
function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  runCollaborationMigration(db);
  return db;
}

function seedPrincipal(db: Database.Database): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(id, now, now);
  return id;
}

function objectSnapshot(db: Database.Database): string[] {
  return (
    db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as {
      type: string; name: string; sql: string | null;
    }[]
  ).map((r) => `${r.type}:${r.name}:${r.sql ?? ''}`);
}

describe('C1-1 surfaces migration', () => {
  it('creates the C1 tables on a LEGACY database that already ran the C0 migration (IF-NOT-EXISTS trap)', () => {
    const db = legacyDb();
    // Precondition: the C0 migration is recorded, so re-running it is a no-op.
    expect(db.prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?').get('20260806_001_collaboration_v1')).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='surfaces'").get()).toBeUndefined();

    // Re-running the C0 migration alone would NEVER add the C1 tables.
    runCollaborationMigration(db);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='surfaces'").get()).toBeUndefined();

    // The separately-recorded C1 migration does.
    runSurfaceIdentityMigration(db);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='surfaces'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='surface_credentials'").get()).toBeTruthy();
    db.close();
  });

  it('is idempotent: a repeat run changes no schema object and records one migration row', () => {
    const db = legacyDb();
    runSurfaceIdentityMigration(db);
    const before = objectSnapshot(db);

    runSurfaceIdentityMigration(db);
    runSurfaceIdentityMigration(db);

    expect(objectSnapshot(db)).toEqual(before);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM collab_schema_migrations WHERE id = ?').get(C1_SURFACES_MIGRATION_ID) as { n: number };
    expect(rows.n).toBe(1);
    db.close();
  });

  it('leaves every pre-existing C0.1 object and row untouched (strictly additive, §1.5)', () => {
    const db = legacyDb();
    const principalId = seedPrincipal(db);
    const beforeObjects = objectSnapshot(db).filter((o) => !o.includes('surface'));
    const beforePrincipals = db.prepare('SELECT * FROM principals ORDER BY id').all();

    runSurfaceIdentityMigration(db);
    runSurfaceAuditMigration(db);

    expect(objectSnapshot(db).filter((o) => !o.includes('surface'))).toEqual(beforeObjects);
    expect(db.prepare('SELECT * FROM principals ORDER BY id').all()).toEqual(beforePrincipals);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(principalId).toBeTruthy();
    db.close();
  });

  it('enumerates exactly the six surface kinds and rejects a seventh (SI-2)', () => {
    const db = legacyDb();
    runSurfaceIdentityMigration(db);
    runSurfaceAuditMigration(db);
    const principalId = seedPrincipal(db);

    expect(SURFACE_KINDS).toEqual(['desktop', 'mobile', 'http', 'telegram', 'slack', 'automation']);
    for (const kind of SURFACE_KINDS) {
      createSurface(db, { surfaceId: `s-${kind}`, principalId, surfaceKind: kind });
    }
    expect(
      () => createSurface(db, { surfaceId: 's-seventh', principalId, surfaceKind: 'carrier-pigeon' as never }),
    ).toThrow(SurfaceProvisioningError);
    db.close();
  });

  it('defaults surface_role to agent and capability_json to deny-all (fail-closed, §2.2/§2.7)', () => {
    const db = legacyDb();
    runSurfaceIdentityMigration(db);
    runSurfaceAuditMigration(db);
    const principalId = seedPrincipal(db);

    // Insert through raw SQL to prove the DDL DEFAULT itself is fail-closed,
    // not merely the provisioning helper's default argument.
    db.prepare("INSERT INTO surfaces(surface_id, principal_id, surface_kind) VALUES ('raw', ?, 'desktop')").run(principalId);
    const row = db.prepare("SELECT surface_role, capability_json, state FROM surfaces WHERE surface_id='raw'").get() as {
      surface_role: string; capability_json: string; state: string;
    };
    expect(row.surface_role).toBe('agent');
    expect(row.capability_json).toBe('[]');
    expect(row.state).toBe('active');
    db.close();
  });

  it('refuses a duplicate surface_id rather than re-parenting it (SI-1, immutable owner)', () => {
    const db = legacyDb();
    runSurfaceIdentityMigration(db);
    runSurfaceAuditMigration(db);
    const a = seedPrincipal(db);
    const b = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'B', ?, 'active', 1, NULL, ?, ?)",
    ).run(b, a, now, now);

    createSurface(db, { surfaceId: 'dup', principalId: a, surfaceKind: 'desktop' });
    expect(() => createSurface(db, { surfaceId: 'dup', principalId: b, surfaceKind: 'desktop' }))
      .toThrow(/SURFACE_EXISTS|already exists/);

    // Ownership is unchanged — the second principal did not steal the surface.
    const owner = db.prepare("SELECT principal_id FROM surfaces WHERE surface_id='dup'").get() as { principal_id: string };
    expect(owner.principal_id).toBe(a);
    db.close();
  });

  it('refuses an orphan surface whose principal does not exist', () => {
    const db = legacyDb();
    runSurfaceIdentityMigration(db);
    runSurfaceAuditMigration(db);
    expect(() => createSurface(db, { surfaceId: 'orphan', principalId: randomUUID(), surfaceKind: 'desktop' }))
      .toThrow(expect.objectContaining({ code: 'UNKNOWN_PRINCIPAL' }));
    expect(db.prepare("SELECT 1 FROM surfaces WHERE surface_id='orphan'").get()).toBeUndefined();
    db.close();
  });

  it('CT-2 structural backstop: channel/automation kinds can never be operator-role', () => {
    const db = legacyDb();
    runSurfaceIdentityMigration(db);
    runSurfaceAuditMigration(db);
    const principalId = seedPrincipal(db);

    for (const kind of ['telegram', 'slack', 'automation'] as const) {
      // Provisioning-time refusal (legible code).
      expect(() => createSurface(db, { surfaceId: `op-${kind}`, principalId, surfaceKind: kind, surfaceRole: 'operator' }))
        .toThrow(expect.objectContaining({ code: 'CHANNEL_CANNOT_BE_OPERATOR' }));
      // DDL backstop: even a direct INSERT bypassing the helper is refused.
      expect(() =>
        db.prepare(
          "INSERT INTO surfaces(surface_id, principal_id, surface_kind, surface_role) VALUES (?, ?, ?, 'operator')",
        ).run(`raw-op-${kind}`, principalId, kind),
      ).toThrow();
    }
    // desktop/http MAY be operator-role.
    createSurface(db, { surfaceId: 'op-desktop', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
    expect(db.prepare("SELECT surface_role FROM surfaces WHERE surface_id='op-desktop'").get())
      .toEqual({ surface_role: 'operator' });
    db.close();
  });

  it('addSurfaceColumnIfMissing guards post-first-ship columns (storage.ts:107-111 precedent)', () => {
    const db = legacyDb();
    runSurfaceIdentityMigration(db);
    db.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES ('p1','operator','Op',NULL,'active',1,NULL,'t','t')").run();
    db.prepare("INSERT INTO surfaces(surface_id, principal_id, surface_kind) VALUES ('s1','p1','desktop')").run();

    expect(addSurfaceColumnIfMissing(db, 'surfaces', 'future_note', 'TEXT')).toBe(true);
    // Repeat is a no-op, not an error — the whole point of the guard.
    expect(addSurfaceColumnIfMissing(db, 'surfaces', 'future_note', 'TEXT')).toBe(false);
    // Nullable on the existing row (§6.2: new columns are ALWAYS nullable).
    expect(db.prepare("SELECT future_note FROM surfaces WHERE surface_id='s1'").get()).toEqual({ future_note: null });
    db.close();
  });
});
