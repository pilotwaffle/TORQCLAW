import { describe, it, expect, beforeEach } from 'vitest';
import {
  collabEnabled,
  resolvePrincipalBinding,
  assertResumeAllowed,
  PrincipalBindingError,
} from '../packages/gateway/src/principalBridge.js';

/**
 * C0 — Principal Identity Bridge.
 *
 * packages/collab has a serious authorization model (principals, credentials,
 * auth epochs, revocation). The gateway's `sessions` table has only `role` and
 * `client_name`. sessions.resolve() therefore returns ANY session whose id is
 * known, with no check that the resuming caller is the same party that created
 * it -- a session id alone is a bearer token for someone else's session
 * (SEC-1: cross-channel resume).
 *
 * This slice bridges the two WITHOUT replacing gateway sessions: it adds
 * principal/surface identity alongside them so authorization can be checked,
 * while the gateway remains the execution authority.
 *
 * The flag defaults OFF. With it off, behaviour must be byte-identical to
 * today -- including the existing hole. Closing a security gap and enabling a
 * new subsystem are separate decisions; conflating them would make the rollout
 * un-revertable.
 */

describe('C0 principal bridge — flag semantics', () => {
  beforeEach(() => {
    delete process.env.TORQCLAW_COLLAB_ENABLED;
  });

  it('is OFF by default', () => {
    expect(collabEnabled()).toBe(false);
  });

  it('is enabled only by an explicit truthy value', () => {
    for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.TORQCLAW_COLLAB_ENABLED = on;
      expect(collabEnabled()).toBe(true);
    }
    for (const off of ['0', 'false', 'no', 'off', '', '   ']) {
      process.env.TORQCLAW_COLLAB_ENABLED = off;
      expect(collabEnabled()).toBe(false);
    }
  });
});

describe('C0 principal bridge — resume authorization (SEC-1)', () => {
  beforeEach(() => {
    process.env.TORQCLAW_COLLAB_ENABLED = '1';
  });

  it('allows a principal to resume its own session', () => {
    expect(() =>
      assertResumeAllowed(
        { principalId: 'p-barry', surfaceId: 's-desktop' },
        { principalId: 'p-barry', surfaceId: 's-desktop' },
      ),
    ).not.toThrow();
  });

  it('allows the SAME principal to resume from a DIFFERENT surface', () => {
    // Barry on desktop must be able to pick a session back up on his phone.
    // Surface is not an authorization boundary between a principal and itself;
    // that is the whole reason Surface exists as a separate concept from
    // Principal rather than each device becoming its own "user".
    expect(() =>
      assertResumeAllowed(
        { principalId: 'p-barry', surfaceId: 's-desktop' },
        { principalId: 'p-barry', surfaceId: 's-iphone' },
      ),
    ).not.toThrow();
  });

  it('REFUSES a different principal holding the session id (the SEC-1 hole)', () => {
    expect(() =>
      assertResumeAllowed(
        { principalId: 'p-barry', surfaceId: 's-desktop' },
        { principalId: 'p-attacker', surfaceId: 's-http' },
      ),
    ).toThrow(PrincipalBindingError);
  });

  it('REFUSES an unbound caller against a bound session', () => {
    // A session that HAS an owner must not be resumable by a caller who
    // presents no identity at all -- otherwise omitting credentials becomes
    // the easiest way past the check.
    expect(() =>
      assertResumeAllowed({ principalId: 'p-barry', surfaceId: 's-desktop' }, null),
    ).toThrow(PrincipalBindingError);
  });

  it('allows resuming a legacy session that predates the bridge', () => {
    // Sessions created before this slice have no principal. They must stay
    // resumable or enabling the flag would lock users out of live sessions --
    // a migration, not a security decision.
    expect(() =>
      assertResumeAllowed(null, { principalId: 'p-barry', surfaceId: 's-desktop' }),
    ).not.toThrow();
  });

  it('allows an unbound caller on a legacy session (fully pre-bridge flow)', () => {
    expect(() => assertResumeAllowed(null, null)).not.toThrow();
  });
});

describe('C0 principal bridge — binding resolution', () => {
  beforeEach(() => {
    process.env.TORQCLAW_COLLAB_ENABLED = '1';
  });

  it('returns null when the flag is off, whatever the frame carries', () => {
    process.env.TORQCLAW_COLLAB_ENABLED = '0';
    expect(
      resolvePrincipalBinding({ principalId: 'p-barry', surfaceId: 's-desktop' } as any),
    ).toBeNull();
  });

  it('returns null for a frame carrying no identity', () => {
    expect(resolvePrincipalBinding({} as any)).toBeNull();
  });

  it('extracts a well-formed binding', () => {
    expect(
      resolvePrincipalBinding({ principalId: 'p-barry', surfaceId: 's-desktop' } as any),
    ).toEqual({ principalId: 'p-barry', surfaceId: 's-desktop' });
  });

  it('rejects a principalId with no surfaceId', () => {
    // Credentials belong to surfaces, not directly to principals. A principal
    // claim with no surface is an incomplete identity and must not be treated
    // as authenticated.
    expect(() => resolvePrincipalBinding({ principalId: 'p-barry' } as any))
      .toThrow(PrincipalBindingError);
  });

  it('rejects malformed identifiers rather than coercing them', () => {
    for (const bad of ['', '   ', 'a'.repeat(200), 'has space', 'has/slash']) {
      expect(() =>
        resolvePrincipalBinding({ principalId: bad, surfaceId: 's-desktop' } as any),
      ).toThrow(PrincipalBindingError);
    }
  });
});

describe('C0 principal bridge — schema migration against a legacy database', () => {
  it('adds principal_id/surface_id to a sessions table created before the bridge', async () => {
    // `sessions` is created with CREATE TABLE IF NOT EXISTS, so an existing
    // dev/production DB never re-runs the CREATE and would never see the new
    // columns. Every insert in sessions.resolve() would then fail at runtime
    // while unit tests -- which build a fresh schema -- stayed green. That is
    // the stale-artifact failure mode this repo already hit once, so the
    // migration is verified against a genuinely old database, not a new one.
    const Database = (await import('better-sqlite3')).default;
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'torq-c0-mig-'));
    const legacy = new Database(join(dir, 'state.db'));
    legacy.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, client_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    legacy.prepare("INSERT INTO sessions (id,role,client_name) VALUES ('legacy-1','operator','old')").run();
    legacy.close();

    const prev = process.env.TORQCLAW_DATA_DIR;
    process.env.TORQCLAW_DATA_DIR = dir;
    try {
      const { db } = await import('../packages/gateway/src/storage.js');
      const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(cols).toContain('principal_id');
      expect(cols).toContain('surface_id');

      // The pre-existing row survives and has no owner, so it stays resumable.
      const row = db.prepare("SELECT id, principal_id FROM sessions WHERE id='legacy-1'").get() as
        { id: string; principal_id: string | null };
      expect(row.id).toBe('legacy-1');
      expect(row.principal_id).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.TORQCLAW_DATA_DIR;
      else process.env.TORQCLAW_DATA_DIR = prev;
    }
  });
});
