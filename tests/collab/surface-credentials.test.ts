/**
 * C1-2 — surface credential issuance + existence-oblivious verify.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §2.3, §2.4, §8 C1-2 AC; adversarial A2/A3.
 *
 * The load-bearing property is HMAC-operation-count EQUALITY across every
 * failure mode INCLUDING expiry (§2.4). Expiry is the C1 addition to a C0
 * path that was already existence-oblivious, and the natural implementation
 * -- checking `expires_at` before or after the verify call -- would make an
 * expired credential measurably cheaper than a revoked one, reintroducing
 * the oracle the design exists to prevent. These tests assert the count
 * directly rather than trusting the implementation's shape.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import {
  credentialHmacOperationCount,
  resetCredentialHmacOperationCount,
  verifyCredential,
} from '../../packages/collab/src/credentials.js';
import { nodeRandomSource } from '../../packages/collab/src/bootstrap.js';
import {
  runSurfaceIdentityMigration,
  verifySurfaceToken,
  surfaceCredentialLookup,
} from '../../packages/collab/src/surfaces.js';
import {
  createSurface,
  issueSurfaceCredential,
  revokeSurface,
  revokeSurfaceCredential,
  runSurfaceAuditMigration,
  writeSurfaceAudit,
  SurfaceProvisioningError,
} from '../../packages/collab/src/surfaceStore.js';

const PEPPER = Buffer.alloc(32, 0x5a);

function freshDb(): { db: Database.Database; principalId: string } {
  const db = new Database(':memory:');
  runCollaborationMigration(db);
  runSurfaceIdentityMigration(db);
  runSurfaceAuditMigration(db);
  const principalId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(principalId, now, now);
  return { db, principalId };
}

/** HMAC operations consumed by exactly one verify call. */
function hmacCostOf(fn: () => void): number {
  resetCredentialHmacOperationCount();
  fn();
  return credentialHmacOperationCount();
}

describe('C1-2 surface credential issuance', () => {
  it('issues a tq1_ token whose plaintext is returned once and never persisted', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    const issued = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);

    expect(issued.token.startsWith(`tq1_${issued.credentialId}_`)).toBe(true);

    // Only the HMAC is stored -- the token bytes appear nowhere in the DB.
    const row = db.prepare('SELECT secret_hmac, state, expires_at FROM surface_credentials WHERE credential_id = ?')
      .get(issued.credentialId) as { secret_hmac: Buffer; state: string; expires_at: string | null };
    expect(Buffer.isBuffer(row.secret_hmac)).toBe(true);
    expect(row.secret_hmac.toString('utf8')).not.toContain('tq1_');
    expect(row.state).toBe('active');
    expect(row.expires_at).toBeNull();

    const dump = JSON.stringify(db.prepare('SELECT * FROM surface_credentials').all());
    expect(dump).not.toContain(issued.token);
    db.close();
  });

  it('verifies a freshly issued credential and resolves its owning surface', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
    const issued = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);

    const verified = verifySurfaceToken(db, issued.token, PEPPER);
    expect(verified).toEqual({
      credentialId: issued.credentialId,
      surfaceId: 's1',
      principalId,
      surfaceKind: 'desktop',
      surfaceRole: 'operator',
    });
    db.close();
  });

  it('rejects a duplicate secret_hmac collision as a typed refusal, not a raw SQLite error', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });

    // NOTE: a fixed RNG is NOT sufficient to force this collision. The stored
    // HMAC is taken over the COMPLETE TOKEN BYTES (credentials.ts:110-112),
    // and the token embeds the unique credentialId -- so two credentials with
    // an identical 32-byte secret still hash differently. That is a real
    // defence-in-depth property worth stating: secret reuse alone cannot
    // produce a duplicate stored HMAC. To exercise the UNIQUE constraint's
    // refusal path we therefore plant the colliding HMAC directly.
    const first = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);
    const planted = db.prepare('SELECT secret_hmac FROM surface_credentials WHERE credential_id = ?')
      .get(first.credentialId) as { secret_hmac: Buffer };

    expect(() =>
      db.prepare(
        "INSERT INTO surface_credentials(credential_id, surface_id, secret_hmac, state) VALUES (?, 's1', ?, 'active')",
      ).run(randomUUID(), planted.secret_hmac),
    ).toThrow(/UNIQUE/);

    // And the issuance path surfaces a UNIQUE violation as a typed refusal
    // rather than a raw SQLite error (duplicate credential_id, same seam).
    expect(() => issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource, { credentialId: first.credentialId }))
      .toThrow(expect.objectContaining({ code: 'CREDENTIAL_COLLISION' }));
    db.close();
  });

  it('rejects a duplicate credential_id (PRIMARY KEY) as a typed refusal', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    const id = randomUUID();
    issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource, { credentialId: id });
    expect(() => issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource, { credentialId: id }))
      .toThrow(expect.objectContaining({ code: 'CREDENTIAL_COLLISION' }));
    db.close();
  });

  it('refuses to issue against an unknown or revoked surface', () => {
    const { db, principalId } = freshDb();
    expect(() => issueSurfaceCredential(db, 'nope', PEPPER, nodeRandomSource))
      .toThrow(expect.objectContaining({ code: 'UNKNOWN_SURFACE' }));

    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    revokeSurface(db, 's1');
    expect(() => issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource))
      .toThrow(expect.objectContaining({ code: 'SURFACE_REVOKED' }));
    db.close();
  });
});

describe('C1-2 existence-oblivious verification (A2, A3)', () => {
  it('costs the SAME number of HMAC operations for hit, miss, revoked, EXPIRED, and malformed', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });

    const active = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);
    const revoked = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);
    revokeSurfaceCredential(db, revoked.credentialId);
    const expired = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const lookup = surfaceCredentialLookup(db);
    // Exercise the credential layer directly so the count reflects exactly
    // one verification and nothing else.
    const verify = (token: string) => { verifyCredential(token, PEPPER, lookup); };

    const unknownId = randomUUID();
    const costs = {
      hit: hmacCostOf(() => verify(active.token)),
      revoked: hmacCostOf(() => verify(revoked.token)),
      expired: hmacCostOf(() => verify(expired.token)),
      unknown: hmacCostOf(() => verify(`tq1_${unknownId}_${Buffer.alloc(32, 7).toString('base64url')}`)),
      malformed: hmacCostOf(() => verify('not-a-token')),
      wrongSecret: hmacCostOf(() => verify(`tq1_${active.credentialId}_${Buffer.alloc(32, 9).toString('base64url')}`)),
    };

    // Every path costs exactly two HMACs (presented + decoy) -- credentials.ts
    // contract, now including the C1 expiry gate.
    expect(costs).toEqual({ hit: 2, revoked: 2, expired: 2, unknown: 2, malformed: 2, wrongSecret: 2 });

    // HMAC COUNT ALONE IS NOT ENOUGH (found by deletion probe 1). An expiry
    // check that returns `undefined` from the lookup -- i.e. treats an
    // expired credential as a NON-EXISTENT one -- also costs two HMACs,
    // because the decoy compare replaces the real compare. The counts match
    // while the work differs: the expired path would skip the real row's
    // compare and become distinguishable from `revoked` by the DB read it
    // no longer performs.
    //
    // So pin the MECHANISM, not just the cost: an expired credential must
    // still resolve to a REAL record whose stored HMAC is the compare
    // target, exactly as a revoked one does. Only the reported state differs.
    const expiredRecord = lookup(expired.credentialId);
    const revokedRecord = lookup(revoked.credentialId);
    expect(expiredRecord).toBeDefined();
    expect(revokedRecord).toBeDefined();
    expect(expiredRecord!.state).toBe('revoked');
    expect(revokedRecord!.state).toBe('revoked');
    // The real stored HMAC is returned (not a decoy / not undefined), so the
    // expired path performs the same length-guarded compare as every other
    // known-credential path.
    const storedExpired = db.prepare('SELECT secret_hmac FROM surface_credentials WHERE credential_id = ?')
      .get(expired.credentialId) as { secret_hmac: Buffer };
    expect(Buffer.compare(expiredRecord!.secretHmac, storedExpired.secret_hmac)).toBe(0);

    // An genuinely unknown id is the ONLY case that yields undefined.
    expect(lookup(unknownId)).toBeUndefined();
    db.close();
  });

  it('A3: an expired credential fails on the SAME path as revoked, with the identical result', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    const expired = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource, {
      expiresAt: new Date(Date.now() - 1),
    });
    const revoked = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);
    revokeSurfaceCredential(db, revoked.credentialId);

    expect(verifySurfaceToken(db, expired.token, PEPPER)).toBeNull();
    expect(verifySurfaceToken(db, revoked.token, PEPPER)).toBeNull();
    db.close();
  });

  it('honours the expiry boundary exactly: valid before, refused at and after expires_at', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    const deadline = new Date('2026-08-11T12:00:00.000Z');
    const issued = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource, { expiresAt: deadline });

    const at = (iso: string) => verifySurfaceToken(db, issued.token, PEPPER, () => new Date(iso));
    expect(at('2026-08-11T11:59:59.999Z')).not.toBeNull();
    // `expires_at <= now` is the refusal predicate (§2.4) -- the boundary
    // instant itself is already expired.
    expect(at('2026-08-11T12:00:00.000Z')).toBeNull();
    expect(at('2026-08-11T12:00:00.001Z')).toBeNull();
    db.close();
  });

  it('A2: a revoked SURFACE cascades its credentials, so a still-known token fails at the constant-cost gate', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    const issued = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);
    expect(verifySurfaceToken(db, issued.token, PEPPER)).not.toBeNull();

    const result = revokeSurface(db, 's1');
    expect(result).toEqual({ surfaceRevoked: true, credentialsRevoked: 1 });

    expect(verifySurfaceToken(db, issued.token, PEPPER)).toBeNull();
    // The cascade is what keeps the refusal on the constant-cost path.
    const cred = db.prepare('SELECT state FROM surface_credentials WHERE credential_id = ?').get(issued.credentialId);
    expect(cred).toEqual({ state: 'revoked' });
    db.close();
  });

  it('never throws, whatever it is handed', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    for (const bad of ['', 'tq1_', 'tq1__', 'tq1_x_y', ' ', 'tq1_'.repeat(5000), 'tq1_not-a-uuid_abc']) {
      expect(() => verifySurfaceToken(db, bad, PEPPER)).not.toThrow();
      expect(verifySurfaceToken(db, bad, PEPPER)).toBeNull();
    }
    db.close();
  });

  it('a credential orphaned from its surface fails closed', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    const issued = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);
    // Simulate an interrupted cascade / direct edit: surface row gone.
    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM surfaces WHERE surface_id='s1'").run();
    expect(verifySurfaceToken(db, issued.token, PEPPER)).toBeNull();
    db.close();
  });

  it('a surface revoked WITHOUT cascade is still refused by the backstop check', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    const issued = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);
    // Direct edit bypassing revokeSurface(): credential stays active.
    db.prepare("UPDATE surfaces SET state='revoked' WHERE surface_id='s1'").run();
    expect(db.prepare('SELECT state FROM surface_credentials WHERE credential_id=?').get(issued.credentialId))
      .toEqual({ state: 'active' });
    expect(verifySurfaceToken(db, issued.token, PEPPER)).toBeNull();
    db.close();
  });
});

describe('C1-6 audit rows are secret-free', () => {
  it('records issuance/revocation without any token, secret, or HMAC bytes', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    const issued = issueSurfaceCredential(db, 's1', PEPPER, nodeRandomSource);
    revokeSurface(db, 's1');

    const rows = db.prepare('SELECT kind, content_json FROM collab_surface_audit ORDER BY seq').all() as {
      kind: string; content_json: string;
    }[];
    expect(rows.map((r) => r.kind)).toEqual(['surface_created', 'surface_credential_issued', 'surface_revoked']);

    const all = JSON.stringify(rows);
    expect(all).not.toContain(issued.token);
    expect(all).not.toContain('tq1_');
    expect(all).not.toContain(PEPPER.toString('base64'));
    db.close();
  });

  it('refuses at write time to record a payload carrying a forbidden key', () => {
    const { db, principalId } = freshDb();
    createSurface(db, { surfaceId: 's1', principalId, surfaceKind: 'desktop' });
    expect(() => writeSurfaceAudit(db, 'surface_created', { surfaceId: 's1' }, { token: 'tq1_leak' }))
      .toThrow(expect.objectContaining({ code: 'AUDIT_SECRET_LEAK' }));
    expect(() => writeSurfaceAudit(db, 'surface_created', { surfaceId: 's1' }, { nested: { secretHmac: 'x' } }))
      .toThrow(expect.objectContaining({ code: 'AUDIT_SECRET_LEAK' }));
    expect(SurfaceProvisioningError).toBeTruthy();
    db.close();
  });
});
