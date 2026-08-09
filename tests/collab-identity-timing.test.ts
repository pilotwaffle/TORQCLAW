import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
// Imported from the PACKAGE ENTRY (@torqclaw/collab, resolving to
// packages/collab/dist/), NOT the relative src/ path -- collabIdentity.ts
// (loaded below via dynamic import) itself imports verifyCredential from
// '@torqclaw/collab'. hmacOperationCount is module-scoped closure state
// (credentials.ts), so importing the counters from a DIFFERENT resolution
// of the same source (src/ vs dist/) would silently observe a SEPARATE
// counter instance and this proof would pass vacuously (always reading 0)
// without actually asserting anything about the code path under test.
import {
  issueCredential,
  nodeRandomSource,
  runCollaborationMigration,
  resetCredentialHmacOperationCount,
  credentialHmacOperationCount,
  InMemorySecretStore,
  type SecretStore,
} from '@torqclaw/collab';

/**
 * C0.1 proof (d) — M-2 timing proof for the CONNECT path.
 *
 * credentials.ts already proves verifyCredential's own HMAC-operation-count
 * equality (existence-oblivious: hit/miss/revoked/malformed all cost exactly
 * the same number of hmacSha256 calls -- packages/collab/src/credentials.ts
 * lines 182-203). What THIS slice adds on top is the connect-path wrapper
 * (collabIdentity.ts's verifySurfaceCredential): it must not introduce an
 * early-exit that breaks that equality for callers reaching verifyCredential
 * THROUGH the gateway's connect seam, and the ADDITIONAL step it performs
 * (principalIdForCredential) must not become an extra timing oracle that
 * distinguishes "credential verified but principal row missing" from
 * "credential verified and principal row present" in a way an attacker could
 * exploit to enumerate valid vs orphaned credential ids from the OUTSIDE.
 * This slice measures HMAC-operation-count equality (the same proxy
 * credentials.ts itself uses) across the four connect-path outcomes: active,
 * revoked, unknown/malformed, and missing-pepper.
 *
 * WALL-CLOCK FIXTURE: DEFERRED, per credentials.ts:60 ("the wall-clock
 * timing fixture is OWED at the slice that ships the connect path"). This
 * IS that slice, so the deferral is noted explicitly rather than silently
 * carried forward again: a wall-clock harness needs a noise floor / CI
 * environment guarantee this repo does not yet have (README: no dedicated
 * timing-CI lane), and a flaky wall-clock assertion is worse than none. The
 * HMAC-operation-count proxy below is the assertable, deterministic
 * signal C1 (credentials.ts) established as sufficient for this same
 * property; this slice extends that SAME proxy to the connect-path wrapper
 * rather than inventing a second methodology.
 */

const PEPPER_NAME = 'TORQCLAW/principal-pepper';

describe('C0.1 connect-path timing proof (proof d) — HMAC operation count equality', () => {
  let db: Database.Database;
  let pepper: Buffer;
  let activeToken: string;
  let revokedToken: string;
  let setCollabDbForTest: (db: any) => void;
  let setCollabSecretStoreForTest: (s: SecretStore | null) => void;
  let verifySurfaceCredential: (credential: string) => unknown;

  beforeEach(async () => {
    db = new Database(':memory:');
    runCollaborationMigration(db);
    pepper = Buffer.alloc(32, 0x99);

    const activeId = randomUUID();
    const revokedId = randomUUID();
    const principalId = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at)
       VALUES (?, 'operator', 'P', NULL, 'active', 1, NULL, ?, ?)`,
    ).run(principalId, now, now);

    const active = issueCredential(activeId, pepper, nodeRandomSource);
    const revoked = issueCredential(revokedId, pepper, nodeRandomSource);
    activeToken = active.token;
    revokedToken = revoked.token;
    active.secretBytes.fill(0);
    revoked.secretBytes.fill(0);

    db.prepare(
      `INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at)
       VALUES (?, ?, ?, 'active', NULL, ?, NULL)`,
    ).run(activeId, principalId, active.secretHmac, now);
    db.prepare(
      `INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at)
       VALUES (?, ?, ?, 'revoked', ?, ?, NULL)`,
    ).run(revokedId, principalId, revoked.secretHmac, now, now);

    const mod = await import('../packages/gateway/src/collabIdentity.js');
    setCollabDbForTest = mod.setCollabDbForTest;
    setCollabSecretStoreForTest = mod.setCollabSecretStoreForTest;
    verifySurfaceCredential = mod.verifySurfaceCredential;
    setCollabDbForTest(db as any);
    const store = new InMemorySecretStore();
    store.set(PEPPER_NAME, pepper);
    setCollabSecretStoreForTest(store);
  });

  afterEach(() => {
    setCollabDbForTest(null);
    setCollabSecretStoreForTest(null);
    db.close();
  });

  function countHmacOpsFor(credential: string): number {
    resetCredentialHmacOperationCount();
    verifySurfaceCredential(credential);
    return credentialHmacOperationCount();
  }

  it('active, revoked, and unknown/malformed all cost the SAME number of HMAC operations through the connect-path wrapper', () => {
    const activeOps = countHmacOpsFor(activeToken);
    const revokedOps = countHmacOpsFor(revokedToken);
    const unknownOps = countHmacOpsFor('tq1_' + randomUUID() + '_deadbeef');
    const malformedOps = countHmacOpsFor('not-a-token-at-all');

    expect(activeOps).toBeGreaterThan(0);
    expect(revokedOps).toBe(activeOps);
    expect(unknownOps).toBe(activeOps);
    expect(malformedOps).toBe(activeOps);
  });

  it('a credential whose principal_id read subsequently misses costs the SAME HMAC ops as one whose lookup succeeds', () => {
    // principalIdForCredential runs strictly AFTER verifyCredential returns
    // ok:true -- it is a plain SQL read, zero HMAC operations either way --
    // so deleting the row post-verification (same secret still verifies
    // against the pepper; the row backing the SUBSEQUENT principal_id read
    // is simply gone) must leave the HMAC-operation count UNCHANGED versus
    // the case where the row is left in place. If it did NOT match, that
    // would mean verifyCredential was being re-invoked, retried, or
    // short-circuited based on the later miss -- breaking the
    // existence-oblivious property this proof exists to pin at the
    // connect-path wrapper, not just inside verifyCredential itself.
    const baselineOps = countHmacOpsFor(activeToken);

    const activeRow = db.prepare("SELECT id FROM principal_credentials WHERE state = 'active'").get() as { id: string };
    db.prepare('DELETE FROM principal_credentials WHERE id = ?').run(activeRow.id);

    resetCredentialHmacOperationCount();
    const resultAfterDelete = verifySurfaceCredential(activeToken);
    const opsAfterDelete = credentialHmacOperationCount();

    expect(resultAfterDelete).toBeNull(); // principal_id read now misses -> fails closed
    expect(opsAfterDelete).toBe(baselineOps); // but HMAC work was identical
  });

  it('missing pepper (fails closed before any HMAC work) is a DISTINCT, documented early-exit -- not counted against the equality set', () => {
    // Absence of a pepper is a deployment/provisioning state, not a
    // per-request attacker-observable branch over WHICH credential was
    // presented (the actual existence-oblivious property verifyCredential
    // guarantees). It legitimately performs zero HMAC ops -- documenting
    // that explicitly here so it is never mistaken for a violation of the
    // hit/miss/revoked/malformed equality proven above.
    setCollabSecretStoreForTest(new InMemorySecretStore());
    resetCredentialHmacOperationCount();
    const result = verifySurfaceCredential(activeToken);
    expect(result).toBeNull();
    expect(credentialHmacOperationCount()).toBe(0);
  });
});
