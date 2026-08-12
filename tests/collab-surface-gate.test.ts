/**
 * C1-5 — resume surface-validity gate (§2.6) + connection auth context.
 * Adversarial A1 (cross-principal resume), A2/A3 via the gate, SI-3, SI-4.
 *
 * Step 3 (SEC-1) is asserted at the OUTERMOST surface the caller reaches --
 * `sessions.resolve()` -- not at `assertResumeAllowed` in isolation. A
 * taxonomy pinned below the surface lets an ORDERING bug survive a green
 * suite: if step 2 were accidentally run after step 3, the unit test on
 * assertResumeAllowed would still pass while the real gate leaked. These
 * tests therefore drive the composed path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runCollaborationMigration } from '../packages/collab/src/migration.js';
import { runSurfaceIdentityMigration } from '../packages/collab/src/surfaces.js';
import {
  createSurface,
  issueSurfaceCredential,
  revokeSurface,
  runSurfaceAuditMigration,
} from '../packages/collab/src/surfaceStore.js';
import { nodeRandomSource } from '../packages/collab/src/bootstrap.js';
import {
  ensureSurfaceSecuritySchema,
  activateSurfaceProjection,
  revokeSurfaceProjection,
} from '../packages/gateway/src/surfaceSecurity.js';
import { validatePresentingSurface, bindingFor } from '../packages/gateway/src/surfaceGate.js';
import { assertResumeAllowed, PrincipalBindingError } from '../packages/gateway/src/principalBridge.js';

const PEPPER = Buffer.alloc(32, 0x3d);

type Harness = {
  collab: Database.Database;
  state: Database.Database;
  principalA: string;
  principalB: string;
};

function harness(): Harness {
  const collab = new Database(':memory:');
  runCollaborationMigration(collab);
  runSurfaceIdentityMigration(collab);
  runSurfaceAuditMigration(collab);
  const state = new Database(':memory:');
  ensureSurfaceSecuritySchema(state);

  const principalA = randomUUID();
  const principalB = randomUUID();
  const now = new Date().toISOString();
  collab.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator','A',NULL,'active',1,NULL,?,?)").run(principalA, now, now);
  collab.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent','B',?,'active',1,NULL,?,?)").run(principalB, principalA, now, now);
  return { collab, state, principalA, principalB };
}

function provision(
  h: Harness,
  surfaceId: string,
  principalId: string,
  kind: 'desktop' | 'mobile' | 'telegram' = 'desktop',
  role: 'operator' | 'agent' = 'agent',
): string {
  // Grant-last: collab config first, gateway projection last.
  createSurface(h.collab, { surfaceId, principalId, surfaceKind: kind, surfaceRole: role });
  const issued = issueSurfaceCredential(h.collab, surfaceId, PEPPER, nodeRandomSource);
  activateSurfaceProjection(h.state, {
    surfaceId, principalId, surfaceKind: kind, surfaceRole: role,
    allowedCapabilityClasses: ['read'], authEpoch: 1, capabilityRevision: 1,
    sourceIdentityRevision: 'rev-1',
  });
  return issued.token;
}

function gate(h: Harness, token: string) {
  return validatePresentingSurface(
    { collabDb: h.collab, stateDb: h.state, principalPepper: PEPPER },
    token,
  );
}

let h: Harness;
beforeEach(() => {
  process.env.TORQCLAW_COLLAB_ENABLED = '1';
  h = harness();
});
afterEach(() => {
  delete process.env.TORQCLAW_COLLAB_ENABLED;
  h.collab.close();
  h.state.close();
});

describe('C1-5 step 2 — surface validity', () => {
  it('accepts a valid surface and derives a server-side connection context', () => {
    const token = provision(h, 'desk-a', h.principalA, 'desktop', 'operator');
    const ctx = gate(h, token);
    expect(ctx).not.toBeNull();
    expect(ctx).toMatchObject({
      principalId: h.principalA, surfaceId: 'desk-a', surfaceKind: 'desktop',
      surfaceRole: 'operator', authEpoch: 1, capabilityRevision: 1,
    });
    // connectionId is server-minted, not client-supplied.
    expect(ctx!.connectionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives concurrent connections DISTINCT contexts for the same surface (§2.13)', () => {
    const token = provision(h, 'desk-a', h.principalA);
    const one = gate(h, token);
    const two = gate(h, token);
    expect(one!.connectionId).not.toBe(two!.connectionId);
  });

  it('A2: a revoked surface is refused', () => {
    const token = provision(h, 'desk-a', h.principalA);
    expect(gate(h, token)).not.toBeNull();
    revokeSurfaceProjection(h.state, 'desk-a');   // deny-first
    revokeSurface(h.collab, 'desk-a');
    expect(gate(h, token)).toBeNull();
  });

  it('A3: an expired credential is refused', () => {
    createSurface(h.collab, { surfaceId: 'desk-a', principalId: h.principalA, surfaceKind: 'desktop' });
    const issued = issueSurfaceCredential(h.collab, 'desk-a', PEPPER, nodeRandomSource, {
      expiresAt: new Date(Date.now() - 1000),
    });
    activateSurfaceProjection(h.state, {
      surfaceId: 'desk-a', principalId: h.principalA, surfaceKind: 'desktop', surfaceRole: 'agent',
      authEpoch: 1, capabilityRevision: 1, sourceIdentityRevision: 'r',
    });
    expect(gate(h, issued.token)).toBeNull();
  });

  it('refuses a surface with NO live gateway projection (grant-last interruption)', () => {
    // Configured in collab, never activated in state.db.
    createSurface(h.collab, { surfaceId: 'inert', principalId: h.principalA, surfaceKind: 'desktop' });
    const issued = issueSurfaceCredential(h.collab, 'inert', PEPPER, nodeRandomSource);
    expect(gate(h, issued.token)).toBeNull();
  });

  it('refuses when the projection DIVERGES from configured identity (stale enforcement)', () => {
    const token = provision(h, 'desk-a', h.principalA, 'desktop', 'agent');
    expect(gate(h, token)).not.toBeNull();
    // Enforcement copy drifts to a different role than configuration.
    h.state.prepare("UPDATE gateway_surface_security SET surface_role='operator' WHERE surface_id='desk-a'").run();
    expect(gate(h, token)).toBeNull();
  });

  it('is existence-oblivious and total for malformed input', () => {
    for (const bad of ['', 'nope', 'tq1_', `tq1_${randomUUID()}_zzz`]) {
      expect(() => gate(h, bad)).not.toThrow();
      expect(gate(h, bad)).toBeNull();
    }
  });

  it('SI-4: with the flag OFF the gate is skipped entirely and reads no C1 table', () => {
    const token = provision(h, 'desk-a', h.principalA);
    delete process.env.TORQCLAW_COLLAB_ENABLED;
    expect(gate(h, token)).toBeNull();
  });
});

describe('C1-5 step ordering — step 2 precedes step 3 (SEC-1)', () => {
  it('SI-3: cross-surface resume by the SAME principal still succeeds', () => {
    // A's desktop surface owns the session; A's mobile surface presents now.
    const desktopToken = provision(h, 'desk-a', h.principalA, 'desktop');
    const mobileToken = provision(h, 'mob-a', h.principalA, 'mobile');

    const owner = bindingFor(gate(h, desktopToken)!);
    const caller = bindingFor(gate(h, mobileToken)!);

    expect(owner.surfaceId).not.toBe(caller.surfaceId);   // different surfaces
    expect(owner.principalId).toBe(caller.principalId);   // same principal
    // Step 3 allows regardless of surface -- the whole point of C0's rule.
    expect(() => assertResumeAllowed(owner, caller)).not.toThrow();
  });

  it('A1: principal A presenting a VALID surface cannot resume principal B session', () => {
    const aToken = provision(h, 'desk-a', h.principalA);
    const bToken = provision(h, 'desk-b', h.principalB);

    const ownerB = bindingFor(gate(h, bToken)!);
    const callerA = bindingFor(gate(h, aToken)!);

    // A's surface is perfectly valid at step 2 -- it passes.
    expect(gate(h, aToken)).not.toBeNull();
    // SEC-1 still refuses at step 3. Validity of the surface is NOT
    // authority over another principal's session.
    expect(() => assertResumeAllowed(ownerB, callerA)).toThrow(PrincipalBindingError);
  });

  it('an INVALID surface is refused at step 2 before SEC-1 is ever consulted', () => {
    const aToken = provision(h, 'desk-a', h.principalA);
    revokeSurfaceProjection(h.state, 'desk-a');
    revokeSurface(h.collab, 'desk-a');

    // Step 2 returns null, so no binding exists to hand to step 3 at all.
    expect(gate(h, aToken)).toBeNull();

    // And a null caller against a bound owner is itself a refusal (C0),
    // so the composed path cannot fall through to "allow".
    const owner = { principalId: h.principalA, surfaceId: 'desk-a' };
    expect(() => assertResumeAllowed(owner, null)).toThrow(PrincipalBindingError);
  });

  it('C0 legacy rules are untouched: owner null allows, caller null refuses', () => {
    expect(() => assertResumeAllowed(null, null)).not.toThrow();
    const caller = bindingFor(gate(h, provision(h, 'desk-a', h.principalA))!);
    expect(() => assertResumeAllowed(null, caller)).not.toThrow();
    expect(() => assertResumeAllowed({ principalId: h.principalA, surfaceId: 'x' }, null))
      .toThrow(PrincipalBindingError);
  });
});
