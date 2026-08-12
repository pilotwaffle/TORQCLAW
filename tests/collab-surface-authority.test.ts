/**
 * C1-3 + C1-4 — gateway surface security projection, control-plane
 * authority store, CT-2 provisioning gate, and the cross-database
 * deny-first / grant-last coordinator.
 *
 * PRD-TCLAW-COLLAB-GATEWAY-004 §2.5, §2.7, §2.7.1, §3.14, §1.4, §6.6.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  ensureSurfaceSecuritySchema,
  activateSurfaceProjection,
  revokeSurfaceProjection,
  liveSurfaceSecurity,
  grantAuthority,
  revokeAuthority,
  holdsAuthority,
  captureTaskOrigin,
  taskOrigin,
  addStateColumnIfMissing,
  AuthorityError,
  AUTHORITIES,
  CAPABILITY_CLASSES,
} from '../packages/gateway/src/surfaceSecurity.js';
import {
  revokeSurfaceEverywhere,
  completeRevocationBookkeeping,
} from '../packages/gateway/src/surfaceRevocation.js';
import { runCollaborationMigration } from '../packages/collab/src/migration.js';
import { runSurfaceIdentityMigration } from '../packages/collab/src/surfaces.js';
import {
  createSurface,
  issueSurfaceCredential,
  runSurfaceAuditMigration,
} from '../packages/collab/src/surfaceStore.js';
import { nodeRandomSource } from '../packages/collab/src/bootstrap.js';

const PEPPER = Buffer.alloc(32, 0x7c);

function stateDb(): Database.Database {
  const db = new Database(':memory:');
  ensureSurfaceSecuritySchema(db);
  return db;
}

function collabDb(): { db: Database.Database; principalId: string } {
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

function activate(
  db: Database.Database,
  surfaceId: string,
  role: 'operator' | 'agent' | 'automation',
  kind: 'desktop' | 'mobile' | 'http' | 'telegram' | 'slack' | 'automation' = 'desktop',
  epoch = 1,
): void {
  activateSurfaceProjection(db, {
    surfaceId, principalId: 'p1', surfaceKind: kind, surfaceRole: role,
    allowedCapabilityClasses: ['read'], authEpoch: epoch, capabilityRevision: 1,
    sourceIdentityRevision: 'rev-1',
  });
}

describe('C1-4 surface security projection', () => {
  it('is fail-closed: an unknown or revoked surface has no live projection', () => {
    const db = stateDb();
    expect(liveSurfaceSecurity(db, 'nope')).toBeNull();
    activate(db, 's1', 'operator');
    expect(liveSurfaceSecurity(db, 's1')).not.toBeNull();
    revokeSurfaceProjection(db, 's1');
    expect(liveSurfaceSecurity(db, 's1')).toBeNull();
    db.close();
  });

  it('refuses to activate a channel/automation kind as operator-role (CT-2 backstop)', () => {
    const db = stateDb();
    for (const kind of ['telegram', 'slack', 'automation'] as const) {
      expect(() => activate(db, `x-${kind}`, 'operator', kind))
        .toThrow(expect.objectContaining({ code: 'CHANNEL_CANNOT_BE_OPERATOR' }));
    }
    db.close();
  });

  it('refuses to store an AUTHORITY token as an execution capability (§1.2.1)', () => {
    const db = stateDb();
    expect(() =>
      activateSurfaceProjection(db, {
        surfaceId: 's1', principalId: 'p1', surfaceKind: 'desktop', surfaceRole: 'operator',
        allowedCapabilityClasses: ['approve' as never], authEpoch: 1, capabilityRevision: 1,
        sourceIdentityRevision: 'r',
      }),
    ).toThrow(expect.objectContaining({ code: 'AUTHORITY_IN_CAPABILITY' }));
    // The capability vocabulary never contains an authority token.
    for (const a of AUTHORITIES) expect(CAPABILITY_CLASSES).not.toContain(a as never);
    db.close();
  });

  it('rejects non-positive epochs and revisions', () => {
    const db = stateDb();
    const base = {
      surfaceId: 's1', principalId: 'p1', surfaceKind: 'desktop' as const, surfaceRole: 'operator' as const,
      sourceIdentityRevision: 'r',
    };
    expect(() => activateSurfaceProjection(db, { ...base, authEpoch: 0, capabilityRevision: 1 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTH_EPOCH' }));
    expect(() => activateSurfaceProjection(db, { ...base, authEpoch: 1, capabilityRevision: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITY_REVISION' }));
    db.close();
  });

  it('addStateColumnIfMissing guards post-first-ship columns', () => {
    const db = stateDb();
    activate(db, 's1', 'operator');
    expect(addStateColumnIfMissing(db, 'gateway_surface_security', 'later_note', 'TEXT')).toBe(true);
    expect(addStateColumnIfMissing(db, 'gateway_surface_security', 'later_note', 'TEXT')).toBe(false);
    expect(db.prepare("SELECT later_note FROM gateway_surface_security WHERE surface_id='s1'").get())
      .toEqual({ later_note: null });
    db.close();
  });
});

describe('C1-4 CT-2 — `approve` provisioning gate (FROZEN)', () => {
  it('grants `approve` to an operator-ROLE surface', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());
    expect(holdsAuthority(db, 'op', 'approve')).toBe(true);
    db.close();
  });

  it('REFUSES `approve` for agent/automation roles even on an operator-capable KIND', () => {
    const db = stateDb();
    // desktop kind -- the kind is NOT the predicate; the role is.
    activate(db, 'agent-desktop', 'agent', 'desktop');
    expect(() => grantAuthority(db, 'agent-desktop', 'approve', randomUUID()))
      .toThrow(expect.objectContaining({ code: 'CT2_NOT_OPERATOR_ROLE' }));
    expect(holdsAuthority(db, 'agent-desktop', 'approve')).toBe(false);

    activate(db, 'auto', 'automation', 'http');
    expect(() => grantAuthority(db, 'auto', 'approve', randomUUID()))
      .toThrow(expect.objectContaining({ code: 'CT2_NOT_OPERATOR_ROLE' }));
    db.close();
  });

  it('cross-channel approval is structurally impossible: channel kinds can never reach the grant', () => {
    const db = stateDb();
    for (const kind of ['telegram', 'slack', 'automation'] as const) {
      // They cannot even be activated as operator-role...
      expect(() => activate(db, `ch-${kind}`, 'operator', kind)).toThrow();
      // ...and as agent-role they are refused the authority.
      activate(db, `ch-${kind}`, 'agent', kind);
      expect(() => grantAuthority(db, `ch-${kind}`, 'approve', randomUUID())).toThrow(AuthorityError);
      expect(holdsAuthority(db, `ch-${kind}`, 'approve')).toBe(false);
    }
    db.close();
  });

  it('refuses a grant when there is no live projection at all (fail-closed)', () => {
    const db = stateDb();
    expect(() => grantAuthority(db, 'ghost', 'approve', randomUUID()))
      .toThrow(expect.objectContaining({ code: 'NO_LIVE_PROJECTION' }));
    db.close();
  });

  it('refuses a duplicate live grant explicitly rather than silently no-opping', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());
    expect(() => grantAuthority(db, 'op', 'approve', randomUUID()))
      .toThrow(expect.objectContaining({ code: 'AUTHORITY_ALREADY_HELD' }));
    // Exactly one live row.
    const n = db.prepare("SELECT COUNT(*) AS n FROM surface_authorities WHERE surface_id='op' AND revoked_at IS NULL").get() as { n: number };
    expect(n.n).toBe(1);
    db.close();
  });
});

describe('C1-4 holdsAuthority is the single fail-closed decision seam', () => {
  it('is false for absent, revoked, and epoch-drifted grants', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    expect(holdsAuthority(db, 'op', 'approve')).toBe(false);      // absent

    grantAuthority(db, 'op', 'approve', randomUUID());
    expect(holdsAuthority(db, 'op', 'approve')).toBe(true);

    revokeAuthority(db, 'op', 'approve');
    expect(holdsAuthority(db, 'op', 'approve')).toBe(false);      // revoked

    // Re-grant, then drift the epoch underneath it: a stale-epoch row must
    // not authorize. This is what stops a revoke/reactivate cycle from
    // silently resurrecting an old grant.
    grantAuthority(db, 'op', 'approve', randomUUID());
    expect(holdsAuthority(db, 'op', 'approve')).toBe(true);
    db.prepare("UPDATE gateway_surface_security SET auth_epoch = auth_epoch + 1 WHERE surface_id='op'").run();
    expect(holdsAuthority(db, 'op', 'approve')).toBe(false);      // epoch drift
    db.close();
  });

  it('never throws and is false for a revoked projection even with a live row', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());
    db.prepare("UPDATE gateway_surface_security SET state='revoked' WHERE surface_id='op'").run();
    expect(holdsAuthority(db, 'op', 'approve')).toBe(false);
    expect(() => holdsAuthority(db, 'nope', 'approve')).not.toThrow();
    expect(holdsAuthority(db, 'nope', 'approve')).toBe(false);
    db.close();
  });

  it('authority is never implied by execution capability or surface kind', () => {
    const db = stateDb();
    // Every execution capability, operator-capable kind, but AGENT role.
    activateSurfaceProjection(db, {
      surfaceId: 'loaded', principalId: 'p1', surfaceKind: 'desktop', surfaceRole: 'agent',
      allowedCapabilityClasses: [...CAPABILITY_CLASSES], allowedOperationIds: ['*'],
      authEpoch: 1, capabilityRevision: 1, sourceIdentityRevision: 'r',
    });
    expect(liveSurfaceSecurity(db, 'loaded')!.allowedCapabilityClasses).toHaveLength(4);
    expect(holdsAuthority(db, 'loaded', 'approve')).toBe(false);
    db.close();
  });
});

describe('C1-3 deny-first revocation across two databases', () => {
  it('revokes the gateway projection, bumps the epoch, and kills live authorities in one transaction', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());

    const result = revokeSurfaceProjection(db, 'op');
    expect(result.revoked).toBe(true);
    expect(result.authoritiesRevoked).toBe(1);
    expect(result.newAuthEpoch).toBe(2);
    expect(holdsAuthority(db, 'op', 'approve')).toBe(false);
    expect(liveSurfaceSecurity(db, 'op')).toBeNull();
    db.close();
  });

  it('coordinator denies the gateway FIRST, then records collab (A2 end-to-end)', () => {
    const state = stateDb();
    const { db: collab, principalId } = collabDb();
    createSurface(collab, { surfaceId: 's1', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
    const issued = issueSurfaceCredential(collab, 's1', PEPPER, nodeRandomSource);
    activate(state, 's1', 'operator');
    grantAuthority(state, 's1', 'approve', randomUUID());

    const outcome = revokeSurfaceEverywhere(state, collab, 's1');
    expect(outcome).toMatchObject({
      gatewayDenied: true, collabRecorded: true, authoritiesRevoked: 1, credentialsRevoked: 1, newAuthEpoch: 2,
    });
    expect(holdsAuthority(state, 's1', 'approve')).toBe(false);
    expect(collab.prepare('SELECT state FROM surface_credentials WHERE credential_id=?').get(issued.credentialId))
      .toEqual({ state: 'revoked' });
    state.close(); collab.close();
  });

  it('a collab-side failure leaves the gateway DENIED (safe direction), recoverable later', () => {
    const state = stateDb();
    const { db: collab, principalId } = collabDb();
    createSurface(collab, { surfaceId: 's1', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
    issueSurfaceCredential(collab, 's1', PEPPER, nodeRandomSource);
    activate(state, 's1', 'operator');
    grantAuthority(state, 's1', 'approve', randomUUID());

    // Simulate the second-phase crash: collab handle unusable.
    collab.close();
    const outcome = revokeSurfaceEverywhere(state, collab, 's1');
    expect(outcome.gatewayDenied).toBe(true);
    expect(outcome.collabRecorded).toBe(false);
    expect(outcome.collabError).toBeTruthy();

    // The security-critical half stands: no authority, no live projection.
    expect(holdsAuthority(state, 's1', 'approve')).toBe(false);
    expect(liveSurfaceSecurity(state, 's1')).toBeNull();

    // Recovery may finish ONLY the collab bookkeeping.
    const collab2 = new Database(':memory:');
    runCollaborationMigration(collab2);
    runSurfaceIdentityMigration(collab2);
    runSurfaceAuditMigration(collab2);
    const now = new Date().toISOString();
    collab2.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator','Op',NULL,'active',1,NULL,?,?)").run(principalId, now, now);
    createSurface(collab2, { surfaceId: 's1', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
    issueSurfaceCredential(collab2, 's1', PEPPER, nodeRandomSource);
    expect(completeRevocationBookkeeping(collab2, 's1').credentialsRevoked).toBe(1);
    state.close(); collab2.close();
  });

  it('grant-last: a surface configured but not yet activated is INERT', () => {
    const state = stateDb();
    const { db: collab, principalId } = collabDb();
    // Collab-side commit succeeded...
    createSurface(collab, { surfaceId: 's1', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
    // ...gateway activation never ran (the interruption).
    expect(liveSurfaceSecurity(state, 's1')).toBeNull();
    expect(holdsAuthority(state, 's1', 'approve')).toBe(false);
    expect(() => grantAuthority(state, 's1', 'approve', randomUUID()))
      .toThrow(expect.objectContaining({ code: 'NO_LIVE_PROJECTION' }));
    state.close(); collab.close();
  });

  it('the module offers no way to reverse a committed deny', async () => {
    // §6.6: rollback MUST only reduce or preserve authority. Pinned
    // structurally: there is no un-revoke / epoch-restore export at all.
    const mod = await import('../packages/gateway/src/surfaceRevocation.js');
    const names = Object.keys(mod).join(' ').toLowerCase();
    for (const forbidden of ['unrevoke', 'restoreepoch', 'reinstate', 'undeny', 'rollbackrevocation']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('C1-5 immutable per-request task origin (§2.13)', () => {
  const origin = (requestId: string, surfaceId: string, sessionId = 'sess-1') => ({
    requestId, sessionId, connectionId: `conn-${surfaceId}`, principalId: 'p1',
    surfaceId, surfaceKind: 'desktop', credentialId: `cred-${surfaceId}`,
    authEpoch: 1, capabilityRevision: 1,
  });

  it('keys origin by REQUEST, so concurrent surfaces on one session stay distinct', () => {
    const db = stateDb();
    captureTaskOrigin(db, origin('r1', 'desktop-surface'));
    captureTaskOrigin(db, origin('r2', 'mobile-surface'));

    // Same durable session, two different presenting surfaces, both preserved.
    expect(taskOrigin(db, 'r1')!.surfaceId).toBe('desktop-surface');
    expect(taskOrigin(db, 'r2')!.surfaceId).toBe('mobile-surface');
    expect(taskOrigin(db, 'r1')!.sessionId).toBe(taskOrigin(db, 'r2')!.sessionId);
    db.close();
  });

  it('is immutable: a second capture for the same request is refused, not overwritten', () => {
    const db = stateDb();
    captureTaskOrigin(db, origin('r1', 'real-surface'));
    expect(() => captureTaskOrigin(db, origin('r1', 'attacker-surface')))
      .toThrow(expect.objectContaining({ code: 'ORIGIN_ALREADY_CAPTURED' }));
    expect(taskOrigin(db, 'r1')!.surfaceId).toBe('real-surface');
    db.close();
  });

  it('returns null for an unknown request rather than fabricating evidence', () => {
    const db = stateDb();
    expect(taskOrigin(db, 'never-seen')).toBeNull();
    db.close();
  });
});
