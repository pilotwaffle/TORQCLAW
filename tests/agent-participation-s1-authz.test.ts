/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S1 — authz.ts's ONE seat-lattice
 * widening, pinned at the pure-function level (matches the house pattern
 * in tests/collab-h1-operator-subordination.test.ts and
 * tests/collab-surface-post.test.ts's T-3 block: drive the REAL authorize()
 * entry point directly, not a hand-rolled copy of the policy).
 *
 * The wire-level tests in tests/agent-participation-s1.test.ts prove the
 * end-to-end behaviour (connect -> resolve -> authorize -> handler -> DB).
 * This file isolates the ONE new decision authz.ts makes, independent of
 * how server.ts computes ctx.agentCollabWrite -- which is exactly the
 * layering the PRD's §2 requires (the gateway SEAT decision must not be
 * conflated with the substrate SUBJECT decision, and here we additionally
 * keep the SEAT decision's own unit test independent of connect-path
 * plumbing).
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ClientCommand } from '@torqclaw/contracts';
import { authorize, type AuthzContext } from '../packages/gateway/src/authz.js';
import { isAgentSurfaceCaller } from '../packages/gateway/src/collabSurface.js';

describe('collabSurface.ts — isAgentSurfaceCaller (S1 connect-path predicate)', () => {
  it('agent_surface + a binding => true (the ONLY case this slice widens)', () => {
    expect(isAgentSurfaceCaller('agent_surface', { principalId: 'p1', surfaceId: 's1' })).toBe(true);
  });

  it('automation_surface (a REAL C1 authClass, also role:node) => false -- the distinguishing case', () => {
    // collabIdentity.ts:318-322 produces this authClass for a C1 surface
    // whose surfaceRole is 'automation', not 'agent'. It shares role:'node'
    // with a genuine agent connection, which is exactly why authClass (not
    // role) must be the gate here -- role alone cannot tell them apart.
    expect(isAgentSurfaceCaller('automation_surface', { principalId: 'p1', surfaceId: 's1' })).toBe(false);
  });

  it('operator_surface => false', () => {
    expect(isAgentSurfaceCaller('operator_surface', { principalId: 'p1', surfaceId: 's1' })).toBe(false);
  });

  it('channel_service => false', () => {
    expect(isAgentSurfaceCaller('channel_service', { principalId: 'service:channel-http', surfaceId: 'service:channel-http' })).toBe(false);
  });

  it('legacy_gateway => false', () => {
    expect(isAgentSurfaceCaller('legacy_gateway', null)).toBe(false);
  });

  it('agent_surface with a NULL binding => false (defense-in-depth; should be unreachable in practice)', () => {
    expect(isAgentSurfaceCaller('agent_surface', null)).toBe(false);
  });

  it('deletion-probe: the two arguments are BOTH load-bearing -- neither alone flips the result', () => {
    expect(isAgentSurfaceCaller('agent_surface', undefined)).toBe(false);
    expect(isAgentSurfaceCaller('automation_surface', { principalId: 'p1', surfaceId: 's1' })).toBe(false);
  });
});

const POST: ClientCommand = {
  action: 'POST_CHANNEL_MESSAGE', channelId: 'c1', text: 'hi', idempotencyKey: randomUUID(),
};
const SUBMIT_PROMPT: ClientCommand = { action: 'SUBMIT_PROMPT', prompt: 'hi' } as ClientCommand;

const baseCtx: AuthzContext = { sessionId: 'sess-1', lookupTaskSession: () => null };

describe('authz.ts — AuthzContext.agentCollabWrite (S1, the ONE node-seat widening)', () => {
  it('node + agentCollabWrite:true + POST_CHANNEL_MESSAGE => ALLOW', () => {
    expect(authorize('node', POST, { ...baseCtx, agentCollabWrite: true })).toEqual({ ok: true });
  });

  it('node + agentCollabWrite:false + POST_CHANNEL_MESSAGE => deny (byte-identical reason to pre-S1)', () => {
    const d = authorize('node', POST, { ...baseCtx, agentCollabWrite: false });
    expect(d).toEqual({ ok: false, reason: 'action not permitted for this role' });
  });

  it('node + agentCollabWrite ABSENT (undefined) + POST_CHANNEL_MESSAGE => deny (pre-S1 byte-identical default)', () => {
    const d = authorize('node', POST, baseCtx);
    expect(d).toEqual({ ok: false, reason: 'action not permitted for this role' });
  });

  it('node + agentCollabWrite:true does NOT widen any OTHER action -- every other node action still denies', () => {
    const ctx: AuthzContext = { ...baseCtx, agentCollabWrite: true };
    expect(authorize('node', SUBMIT_PROMPT, ctx)).toEqual({ ok: false, reason: 'action not permitted for this role' });
    const APPROVE_TOOL = { action: 'APPROVE_TOOL', approvalId: 'a1', decision: 'APPROVE' } as unknown as ClientCommand;
    expect(authorize('node', APPROVE_TOOL, ctx)).toEqual({ ok: false, reason: 'action not permitted for this role' });
  });

  it('operator and channel seats are COMPLETELY unaffected by agentCollabWrite (it is read only in the node branch)', () => {
    // operator: unconditional ALLOW for POST_CHANNEL_MESSAGE regardless of
    // this field (authorizeOperator never reads it).
    expect(authorize('operator', POST, { ...baseCtx, agentCollabWrite: true })).toEqual({ ok: true });
    expect(authorize('operator', POST, { ...baseCtx, agentCollabWrite: false })).toEqual({ ok: true });
    // channel: PRD-005 S3's explicit named deny is untouched -- S1 adds
    // nothing to the channel-seat switch at all.
    expect(authorize('channel', POST, { ...baseCtx, agentCollabWrite: true })).toEqual({ ok: false, reason: 'action not permitted for this role' });
  });

  it('deletion-probe: node seat DIFFERS from operator/channel for the exact same command+flag, proving the branch is reachable and load-bearing', () => {
    const withFlag: AuthzContext = { ...baseCtx, agentCollabWrite: true };
    expect(authorize('operator', POST, withFlag).ok).toBe(true);
    expect(authorize('node', POST, withFlag).ok).toBe(true);
    expect(authorize('channel', POST, withFlag).ok).toBe(false);
    // And node WITHOUT the flag differs from node WITH it -- the flag itself
    // is what flips the decision, not something else about 'node'.
    expect(authorize('node', POST, { ...baseCtx, agentCollabWrite: false }).ok).toBe(false);
  });
});
