/**
 * C1-4 / Ruling H-1 — operator short-circuit subordination.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §2.7.1 (FROZEN), §3.14 (CT-2), §1.2.1.
 *
 * "The highest-value security change in C1" (operator ruling). Before this,
 * `authorize()` answered ALLOW for every operator command without ever
 * consulting the surface layer, so a compromised operator SURFACE inherited
 * the full principal authority.
 *
 * These tests drive the REAL `authorize()` entry point with a real
 * `holdsAuthority` closure over a real state.db -- not a hand-rolled copy of
 * the policy. Asserting at the outermost surface is the GS-ROLLBACK lesson:
 * a taxonomy pinned below the surface lets an ordering bug survive a green
 * suite.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ClientCommand } from '@torqclaw/contracts';
import { authorize, type AuthzContext } from '../packages/gateway/src/authz.js';
import {
  ensureSurfaceSecuritySchema,
  activateSurfaceProjection,
  revokeSurfaceProjection,
  grantAuthority,
  revokeAuthority,
  holdsAuthority,
  CAPABILITY_CLASSES,
} from '../packages/gateway/src/surfaceSecurity.js';

const APPROVE_TOOL = { action: 'APPROVE_TOOL', approvalId: 'a1', decision: 'APPROVE' } as unknown as ClientCommand;
const SUBMIT_PROMPT = { action: 'SUBMIT_PROMPT', prompt: 'hi' } as unknown as ClientCommand;

function stateDb(): Database.Database {
  const db = new Database(':memory:');
  ensureSurfaceSecuritySchema(db);
  return db;
}

function activate(
  db: Database.Database,
  surfaceId: string,
  role: 'operator' | 'agent' | 'automation',
  kind: 'desktop' | 'telegram' = 'desktop',
): void {
  activateSurfaceProjection(db, {
    surfaceId, principalId: 'p1', surfaceKind: kind, surfaceRole: role,
    allowedCapabilityClasses: [...CAPABILITY_CLASSES],   // every EXECUTION capability
    authEpoch: 1, capabilityRevision: 1, sourceIdentityRevision: 'r',
  });
}

/** Build the real ctx the server builds, closing over the real DB. */
function ctxFor(
  db: Database.Database,
  surfaceId: string,
  surfaceRole: 'operator' | 'agent' | 'automation',
): AuthzContext {
  return {
    sessionId: 'sess-1',
    lookupTaskSession: () => 'sess-1',
    surface: {
      surfaceId,
      surfaceRole,
      holdsAuthority: (authority) => holdsAuthority(db, surfaceId, authority),
    },
  };
}

const legacyCtx: AuthzContext = { sessionId: 'sess-1', lookupTaskSession: () => 'sess-1' };

describe('H-1 — flag-off / legacy connections keep today behaviour byte-identically', () => {
  it('an operator with NO surface layer still gets blanket ALLOW', () => {
    for (const cmd of [APPROVE_TOOL, SUBMIT_PROMPT]) {
      expect(authorize('operator', cmd, legacyCtx)).toEqual({ ok: true });
    }
  });

  it('non-operator roles are completely unaffected by the H-1 change', () => {
    expect(authorize('node', SUBMIT_PROMPT, legacyCtx)).toEqual({ ok: false, reason: 'action not permitted for this role' });
    expect(authorize('channel', SUBMIT_PROMPT, legacyCtx)).toEqual({ ok: true });
    expect(authorize('channel', APPROVE_TOOL, legacyCtx)).toEqual({ ok: false, reason: 'action not permitted for this role' });
    // ...and equally unaffected when a surface layer IS present.
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());
    expect(authorize('channel', APPROVE_TOOL, ctxFor(db, 'op', 'operator')))
      .toEqual({ ok: false, reason: 'action not permitted for this role' });
    db.close();
  });
});

describe('H-1 — operator authority is INTERSECTED with the presenting surface', () => {
  it('an operator surface WITH a live approve grant may APPROVE_TOOL', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());
    expect(authorize('operator', APPROVE_TOOL, ctxFor(db, 'op', 'operator'))).toEqual({ ok: true });
    db.close();
  });

  it('THE HOLE H-1 CLOSES: an operator principal on a surface WITHOUT the grant is DENIED', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    // Operator role, every execution capability, but no `approve` authority.
    const decision = authorize('operator', APPROVE_TOOL, ctxFor(db, 'op', 'operator'));
    expect(decision.ok).toBe(false);
    expect((decision as { reason: string }).reason).toMatch(/authority/i);
    db.close();
  });

  it('a compromised operator surface cannot reach approve through EXECUTION capability', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');   // holds read|write|exec|send
    expect(authorize('operator', APPROVE_TOOL, ctxFor(db, 'op', 'operator')).ok).toBe(false);
    // Granting more execution capability changes nothing -- separate paths.
    activateSurfaceProjection(db, {
      surfaceId: 'op', principalId: 'p1', surfaceKind: 'desktop', surfaceRole: 'operator',
      allowedCapabilityClasses: [...CAPABILITY_CLASSES], allowedOperationIds: ['*'],
      authEpoch: 1, capabilityRevision: 2, sourceIdentityRevision: 'r2',
    });
    expect(authorize('operator', APPROVE_TOOL, ctxFor(db, 'op', 'operator')).ok).toBe(false);
    db.close();
  });

  it('CT-2 at decision time: an agent-role surface is denied even if a grant row somehow exists', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());
    // The SAME live grant, presented by a surface claiming agent role, is
    // refused on the role predicate before the authority read.
    const decision = authorize('operator', APPROVE_TOOL, ctxFor(db, 'op', 'agent'));
    expect(decision.ok).toBe(false);
    expect((decision as { reason: string }).reason).toMatch(/operator-role/i);
    db.close();
  });

  it('revocation is observed by the very next command (no caching)', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());
    const ctx = ctxFor(db, 'op', 'operator');
    expect(authorize('operator', APPROVE_TOOL, ctx).ok).toBe(true);

    revokeAuthority(db, 'op', 'approve');
    // Same ctx object, re-evaluated live.
    expect(authorize('operator', APPROVE_TOOL, ctx).ok).toBe(false);
    db.close();
  });

  it('a deny-first surface revocation immediately blocks approval', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());
    const ctx = ctxFor(db, 'op', 'operator');
    expect(authorize('operator', APPROVE_TOOL, ctx).ok).toBe(true);

    revokeSurfaceProjection(db, 'op');
    expect(authorize('operator', APPROVE_TOOL, ctx).ok).toBe(false);
    db.close();
  });

  it('epoch drift under a live grant denies (stale authority cannot survive)', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    grantAuthority(db, 'op', 'approve', randomUUID());
    const ctx = ctxFor(db, 'op', 'operator');
    expect(authorize('operator', APPROVE_TOOL, ctx).ok).toBe(true);

    db.prepare("UPDATE gateway_surface_security SET auth_epoch = auth_epoch + 1 WHERE surface_id='op'").run();
    expect(authorize('operator', APPROVE_TOOL, ctx).ok).toBe(false);
    db.close();
  });

  it('other operator commands are not gated by C1 (exactly one authority token exists)', () => {
    const db = stateDb();
    activate(db, 'op', 'operator');
    // No approve grant, yet ordinary operator commands still work -- C1
    // introduces `approve` only; inventing gates for unspecified commands
    // would be scope drift with real lockout risk.
    expect(authorize('operator', SUBMIT_PROMPT, ctxFor(db, 'op', 'operator'))).toEqual({ ok: true });
    db.close();
  });
});
