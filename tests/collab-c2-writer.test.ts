/**
 * C2-2 / C2-3 / C2-4 — the single centralized approval writer.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §3.1 (M-1/M-2), §3.3 props 1-4/7/9/11,
 * §3.5, §3.9, §3.14 (CT-2), §7 rows A4-A8, §8 C2-2/C2-3/C2-4.
 *
 * Adversarial rows discharged here: A4 (channel attempts APPROVE_TOOL),
 * A5 (operator surface lacking `approve`), A6 (authorized decisions race),
 * A7 (replay), A8 (decision races expiry).
 *
 * PRE-REGISTERED OBLIGATION 1 also lives here: the
 * demotion-without-revocation attack. C1 fixed that hole (epoch bump on
 * role change + live role read); these tests prove C2's decide path cannot
 * regress it, because the writer re-reads the live projection inside its
 * own transaction rather than trusting anything cached at connect.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ensureSurfaceSecuritySchema, activateSurfaceProjection, grantAuthority,
  revokeAuthority, grantProfileDelegation, revokeProfileDelegation,
  revokeSurfaceProjection,
} from '../packages/gateway/src/surfaceSecurity.js';
import { ensureApprovalBrokerSchema } from '../packages/gateway/src/approvalSchema.js';
import {
  registerC2Approval, decideC2Approval, sweepExpiredApprovals, sweepExpiredGrants,
  ApprovalDecisionError, APPROVAL_TTL_SECONDS, GRANT_TTL_SECONDS, legacyStatusTransition,
} from '../packages/gateway/src/approvalWriter.js';
import {
  contextHash, privacyContextHash, routingContextHash, securityPolicyHash,
  type ContextHashInput,
} from '../packages/gateway/src/approvalContext.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'packages', 'gateway', 'db', 'schema.sql'), 'utf8');
const legacySchema = SCHEMA.slice(0, SCHEMA.indexOf('-- TORQCLAW_RESILIENCE_SCHEMA_BEGIN'));

const PRINCIPAL = 'prn_op';
const OP_SURFACE = 'srf_desktop_op';
const OP2_SURFACE = 'srf_desktop_op2';
const CHANNEL_SURFACE = 'srf_telegram';
const PROFILE = 'workspace_write';
const POLICY_HASH = 'e'.repeat(64);
const REGISTRY_HASH = 'd'.repeat(64);

let db: Database.Database;
let delegationId: string;

function makeContext(over: Partial<ContextHashInput> = {}): ContextHashInput {
  return {
    originPrincipalId: PRINCIPAL,
    originSurfaceId: OP_SURFACE,
    sourceRequestId: 'req-1',
    originSurfaceKind: 'desktop',
    profileId: PROFILE,
    toolName: 'filesystem__write_file',
    canonicalArgs: '{"path":"/tmp/x"}',
    privacyContextHash: privacyContextHash({ containsSensitiveData: false }),
    routingContextHash: routingContextHash({
      executionMode: 'AUTO', selectedTier: 'OLLAMA_LOCAL', ruleId: null,
    }),
    securityPolicyHash: securityPolicyHash({
      effectiveProfile: {
        schemaVersion: 'torqclaw.effective-profile/v1', profileId: PROFILE,
        profileVersion: 1, toolRegistryVersion: 'torqclaw.tools/v1',
        effectiveProfilePolicyHash: POLICY_HASH,
      },
      capabilityRevision: 1, profileDelegationRevision: 1,
      registryEnforcementHash: REGISTRY_HASH,
    }),
    ...over,
  };
}

/** Register a pending C2 approval and return its id. */
function register(approvalId = randomUUID(), ctx = makeContext(), originSurfaceId = OP_SURFACE): string {
  registerC2Approval(db, {
    approvalId,
    requestId: 'req-1',
    toolName: 'filesystem__write_file',
    canonicalArgs: ctx.canonicalArgs,
    originPrincipalId: PRINCIPAL,
    originSurfaceId,
    contextInput: ctx,
    binding: {
      delegationId,
      profileDelegationRevision: 1,
      registeredProfileId: PROFILE,
      registeredProfileVersion: 1,
      registeredToolRegistryVersion: 'torqclaw.tools/v1',
      registeredEffectiveProfilePolicyHash: POLICY_HASH,
      registeredCapabilityRevision: 1,
      registeredRegistryEnforcementHash: REGISTRY_HASH,
      registeredPrivacyContextHash: ctx.privacyContextHash,
      registeredRoutingContextHash: ctx.routingContextHash,
      registeredSecurityPolicyHash: ctx.securityPolicyHash,
    },
  });
  return approvalId;
}

function decide(
  approvalId: string,
  decision: 'APPROVE' | 'REJECT' = 'APPROVE',
  decidingSurfaceId = OP_SURFACE,
  currentContext = makeContext(),
) {
  const dispatchRequestId = randomUUID();
  return decideC2Approval(db, {
    approvalId, decision,
    decidingPrincipalId: PRINCIPAL,
    decidingSurfaceId,
    currentContext,
    dispatchRequestId,
    mintDispatchTask: (id) => {
      db.prepare(
        `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
         VALUES (?, 's1','LOCAL_EDGE','remint','running','{}')`,
      ).run(id);
    },
  });
}

function approvalRow(approvalId: string) {
  return db.prepare('SELECT * FROM tool_approvals WHERE approval_id=?').get(approvalId) as
    Record<string, unknown>;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchema);
  ensureSurfaceSecuritySchema(db);
  ensureApprovalBrokerSchema(db);

  db.prepare("INSERT INTO sessions (id, role, client_name) VALUES ('s1','operator','c')").run();
  db.prepare(
    `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
     VALUES ('req-1','s1','LOCAL_EDGE','r','completed','{"id":"req-1"}')`,
  ).run();

  for (const [id, kind, role] of [
    [OP_SURFACE, 'desktop', 'operator'],
    [OP2_SURFACE, 'desktop', 'operator'],
    [CHANNEL_SURFACE, 'telegram', 'agent'],
  ] as const) {
    activateSurfaceProjection(db, {
      surfaceId: id, principalId: PRINCIPAL, surfaceKind: kind, surfaceRole: role,
      allowedCapabilityClasses: ['read', 'write'], authEpoch: 1, capabilityRevision: 1,
      sourceIdentityRevision: 'rev-1',
    });
  }
  grantAuthority(db, OP_SURFACE, 'approve', randomUUID());
  grantAuthority(db, OP2_SURFACE, 'approve', randomUUID());

  delegationId = randomUUID();
  grantProfileDelegation(db, {
    delegationId, surfaceId: OP_SURFACE, profileId: PROFILE,
    profileDelegationRevision: 1, profileSchemaVersion: 'torqclaw.effective-profile/v1',
    profileVersion: 1, toolRegistryVersion: 'torqclaw.tools/v1',
    effectiveProfilePolicyHash: POLICY_HASH, registryEnforcementHash: REGISTRY_HASH,
  });
});

afterEach(() => db.close());

describe('C2 registration (§3.1 canonical row shapes)', () => {
  it('a pending row has origin + expiry, and NULL decision/context evidence', () => {
    const id = register();
    const row = approvalRow(id);
    expect(row.status).toBe('pending');
    expect(row.origin_principal_id).toBe(PRINCIPAL);
    expect(row.origin_surface_id).toBe(OP_SURFACE);
    expect(row.expires_at).not.toBeNull();
    expect(row.decided_principal_id).toBeNull();
    expect(row.decided_surface_id).toBeNull();
    expect(row.decided_at).toBeNull();
    expect(row.context_hash).toBeNull();
    // ...and no grant exists yet
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_action_grants').get()).toEqual({ c: 0 });
  });

  it('stores the immutable binding with the registration context digest', () => {
    const ctx = makeContext();
    const id = register(randomUUID(), ctx);
    const binding = db.prepare('SELECT * FROM gateway_approval_bindings WHERE approval_id=?')
      .get(id) as Record<string, unknown>;
    expect(binding.registration_context_hash).toBe(contextHash(ctx));
    expect(binding.action_hash_version).toBe('ACTIONHASH_V1');
    expect(binding.delegation_id).toBe(delegationId);
  });

  it('gives every new registration a FINITE deadline (prop 9)', () => {
    const id = register();
    const row = approvalRow(id);
    const created = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
    const expires = Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z');
    expect(expires - created).toBeGreaterThan(0);
    expect(Math.round((expires - created) / 1000)).toBeLessThanOrEqual(APPROVAL_TTL_SECONDS + 2);
  });
});

describe('C2-2 decision evidence (props 2, 3, 4, 7)', () => {
  it('the winner writes status + evidence + ONE grant in the same transaction', () => {
    const id = register();
    const decided = decide(id)!;
    expect(decided.status).toBe('approved');

    const row = approvalRow(id);
    expect(row.status).toBe('approved');
    expect(row.decided_principal_id).toBe(PRINCIPAL);
    expect(row.decided_surface_id).toBe(OP_SURFACE);
    expect(row.decided_at).not.toBeNull();
    expect(row.context_hash).toBe(decided.contextHash);

    const grants = db.prepare('SELECT * FROM gateway_action_grants WHERE approval_id=?')
      .all(id) as Record<string, unknown>[];
    expect(grants).toHaveLength(1);
    expect(grants[0]!.dispatch_request_id).toBe(decided.dispatchRequestId);
    expect(grants[0]!.consumed_at).toBeNull();
  });

  it('REJECT writes evidence but mints NO grant', () => {
    const id = register();
    const decided = decide(id, 'REJECT')!;
    expect(decided.status).toBe('rejected');
    expect(decided.grantId).toBeNull();
    expect(approvalRow(id).context_hash).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_action_grants').get()).toEqual({ c: 0 });
  });

  it('A7 replay: a second decision changes zero rows and mints no second grant', () => {
    const id = register();
    expect(decide(id)).not.toBeNull();
    // Replay -> null (unknown-or-already-decided), never a throw.
    expect(decide(id)).toBeNull();
    expect(decide(id, 'REJECT')).toBeNull();
    expect(approvalRow(id).status).toBe('approved');
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_action_grants WHERE approval_id=?').get(id))
      .toEqual({ c: 1 });
  });

  it('an unknown approval returns null rather than throwing (replay-harmless)', () => {
    expect(decide(randomUUID())).toBeNull();
  });

  it('A6 origin-independent: a DIFFERENT-origin authorized operator may decide', () => {
    // Registered from OP_SURFACE, decided by OP2_SURFACE. Authority comes
    // from the live `approve` row, never from origin equality (prop 2).
    const id = register();
    const decided = decide(id, 'APPROVE', OP2_SURFACE)!;
    expect(decided.status).toBe('approved');
    expect(approvalRow(id).decided_surface_id).toBe(OP2_SURFACE);
  });

  it('A6 race: two decisions yield exactly ONE transition and ONE grant', () => {
    const id = register();
    const first = decide(id, 'APPROVE', OP_SURFACE);
    const second = decide(id, 'APPROVE', OP2_SURFACE);
    // better-sqlite3 is synchronous, so "concurrent" serializes -- the
    // loser observes the winner and changes zero rows.
    expect([first, second].filter((r) => r !== null)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_action_grants WHERE approval_id=?').get(id))
      .toEqual({ c: 1 });
    // exactly one evidence tuple
    const row = approvalRow(id);
    expect(row.decided_surface_id).toBe(first ? OP_SURFACE : OP2_SURFACE);
  });
});

describe('C2-3 authority vs origin (props 1, 2; A4, A5; CT-2)', () => {
  it('A4: a channel surface can NEVER decide, even holding every capability', () => {
    const id = register();
    expect(() => decide(id, 'APPROVE', CHANNEL_SURFACE))
      .toThrow(/not a live operator-role surface|channel/i);
    expect(approvalRow(id).status).toBe('pending');   // no state change
  });

  it('A5: an operator surface WITHOUT the approve authority is refused', () => {
    revokeAuthority(db, OP_SURFACE, 'approve');
    const id = register();
    try {
      decide(id);
      throw new Error('should have refused');
    } catch (err) {
      expect((err as ApprovalDecisionError).code).toBe('authority-denied');
    }
    expect(approvalRow(id).status).toBe('pending');
  });

  it('prop 1: a channel surface may not approve a task IT originated', () => {
    // Origin is the channel surface; make it the decider too.
    const id = register(randomUUID(), makeContext({ originSurfaceId: CHANNEL_SURFACE }), CHANNEL_SURFACE);
    expect(() => decide(id, 'APPROVE', CHANNEL_SURFACE)).toThrow(ApprovalDecisionError);
    expect(approvalRow(id).status).toBe('pending');
  });

  it('§3.5: an OPERATOR surface MAY approve a task it originated (ordinary case)', () => {
    const id = register();  // origin == OP_SURFACE
    expect(decide(id, 'APPROVE', OP_SURFACE)).not.toBeNull();
  });

  it('a revoked surface projection denies (deny-first revocation bites)', () => {
    const id = register();
    revokeSurfaceProjection(db, OP_SURFACE);
    expect(() => decide(id)).toThrow(ApprovalDecisionError);
    expect(approvalRow(id).status).toBe('pending');
  });

  // ── PRE-REGISTERED OBLIGATION 1 ───────────────────────────────────────
  it('OBLIGATION 1: a DEMOTED-but-UNREVOKED surface is refused at decide', () => {
    const id = register();
    // The attack: demote the operator surface to `agent` WITHOUT ever
    // calling revokeAuthority. Its surface_authorities row still has
    // revoked_at IS NULL, so a naive check ("is there a live approve row?")
    // would still say yes.
    activateSurfaceProjection(db, {
      surfaceId: OP_SURFACE, principalId: PRINCIPAL, surfaceKind: 'desktop',
      surfaceRole: 'agent',                       // <-- demotion, no revocation
      allowedCapabilityClasses: ['read', 'write'], authEpoch: 1, capabilityRevision: 1,
      sourceIdentityRevision: 'rev-2',
    });
    const stillUnrevoked = db.prepare(
      `SELECT COUNT(*) c FROM surface_authorities
        WHERE surface_id=? AND authority='approve' AND revoked_at IS NULL`,
    ).get(OP_SURFACE);
    expect(stillUnrevoked, 'the authority row is deliberately still unrevoked')
      .toEqual({ c: 1 });

    // Two independent defences must both hold: the live ROLE read, and the
    // epoch bump C1 applies on any role change (which strands the old
    // grant at a stale epoch).
    try {
      decide(id);
      throw new Error('demoted surface must not be able to approve');
    } catch (err) {
      expect((err as ApprovalDecisionError).code).toBe('surface-not-operator');
    }
    expect(approvalRow(id).status).toBe('pending');
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_action_grants').get()).toEqual({ c: 0 });
  });

  it('OBLIGATION 1 (b): even re-promotion does not resurrect the stale grant', () => {
    const id = register();
    activateSurfaceProjection(db, {
      surfaceId: OP_SURFACE, principalId: PRINCIPAL, surfaceKind: 'desktop',
      surfaceRole: 'agent', allowedCapabilityClasses: ['read'], authEpoch: 1,
      capabilityRevision: 1, sourceIdentityRevision: 'rev-2',
    });
    // Promote back to operator. The epoch has moved twice now, so the
    // original approve grant (minted at epoch 1) no longer matches.
    activateSurfaceProjection(db, {
      surfaceId: OP_SURFACE, principalId: PRINCIPAL, surfaceKind: 'desktop',
      surfaceRole: 'operator', allowedCapabilityClasses: ['read'], authEpoch: 1,
      capabilityRevision: 1, sourceIdentityRevision: 'rev-3',
    });
    try {
      decide(id);
      throw new Error('a stale-epoch grant must not authorize');
    } catch (err) {
      expect((err as ApprovalDecisionError).code).toBe('authority-denied');
    }
  });
});

describe('C2-4 expiry (prop 9; A8)', () => {
  function expireNow(id: string): void {
    db.prepare("UPDATE tool_approvals SET expires_at='2000-01-01 00:00:00.000' WHERE approval_id=?")
      .run(id);
  }

  it('an expired-deadline approval refuses to be decided', () => {
    const id = register();
    expireNow(id);
    try {
      decide(id);
      throw new Error('should have refused');
    } catch (err) {
      expect((err as ApprovalDecisionError).code).toBe('approval-expired');
    }
  });

  it("A8: the decision path itself materializes expiry -> terminal 'expired'", () => {
    const id = register();
    expireNow(id);
    expect(() => decide(id)).toThrow(ApprovalDecisionError);
    const row = approvalRow(id);
    // Terminal shape for expired: null decision/context, and no grant.
    expect(row.status).toBe('expired');
    expect(row.decided_principal_id).toBeNull();
    expect(row.decided_surface_id).toBeNull();
    expect(row.decided_at).toBeNull();
    expect(row.context_hash).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_action_grants').get()).toEqual({ c: 0 });
  });

  it('the sweep is owned by this same writer module (A8, M-1/M-2)', () => {
    const a = register(); const b = register(); const c = register();
    expireNow(a); expireNow(b);
    expect(sweepExpiredApprovals(db)).toBe(2);
    expect(approvalRow(a).status).toBe('expired');
    expect(approvalRow(b).status).toBe('expired');
    expect(approvalRow(c).status).toBe('pending');
    // idempotent: a second sweep changes nothing
    expect(sweepExpiredApprovals(db)).toBe(0);
  });

  it('the sweep NEVER writes decision evidence or mints a grant', () => {
    const id = register();
    expireNow(id);
    sweepExpiredApprovals(db);
    const row = approvalRow(id);
    expect(row.decided_at).toBeNull();
    expect(row.context_hash).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_action_grants').get()).toEqual({ c: 0 });
  });

  it('the sweep never touches an already-decided row', () => {
    const id = register();
    decide(id);
    expireNow(id);                    // deadline in the past, but decided
    expect(sweepExpiredApprovals(db)).toBe(0);
    expect(approvalRow(id).status).toBe('approved');
  });

  it('a legacy NULL-expiry row is INERT: never swept, never decidable', () => {
    // A pre-C2 row: no expiry, no binding.
    db.prepare(
      `INSERT INTO tool_approvals (approval_id, request_id, tool_name, args_json, status)
       VALUES ('legacy','req-1','filesystem__write_file','{}','pending')`,
    ).run();
    expect(sweepExpiredApprovals(db)).toBe(0);
    expect(approvalRow('legacy').status).toBe('pending');
    try {
      decide('legacy');
      throw new Error('legacy row must not be decidable under flag-on');
    } catch (err) {
      expect((err as ApprovalDecisionError).code).toBe('approval-legacy-reissue-required');
    }
    // still pending and untouched -- reissue is the only path forward
    expect(approvalRow('legacy').status).toBe('pending');
  });
});

describe('C2-5 registration -> decision context drift (prop 10, C2 part)', () => {
  it('a PROFILE change between registration and decision refuses', () => {
    const id = register();
    expect(() => decide(id, 'APPROVE', OP_SURFACE, makeContext({ profileId: 'read_only' })))
      .toThrow(/context changed/i);
    expect(approvalRow(id).status).toBe('pending');
  });

  it('a PRIVACY-posture change refuses', () => {
    const id = register();
    const drifted = makeContext({
      privacyContextHash: privacyContextHash({ containsSensitiveData: true }),
    });
    try {
      decide(id, 'APPROVE', OP_SURFACE, drifted);
      throw new Error('should have refused');
    } catch (err) {
      expect((err as ApprovalDecisionError).code).toBe('approval-context-invalidated');
    }
  });

  it('an ARGUMENT change refuses (the action is not the one approved)', () => {
    const id = register();
    expect(() => decide(id, 'APPROVE', OP_SURFACE, makeContext({ canonicalArgs: '{"path":"/etc/passwd"}' })))
      .toThrow(ApprovalDecisionError);
  });

  it('a refused decision writes NO evidence and NO grant', () => {
    const id = register();
    try { decide(id, 'APPROVE', OP_SURFACE, makeContext({ profileId: 'read_only' })); } catch { /* expected */ }
    const row = approvalRow(id);
    expect(row.decided_surface_id).toBeNull();
    expect(row.context_hash).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_action_grants').get()).toEqual({ c: 0 });
  });

  it('a REVOKED profile delegation refuses even when the context matches', () => {
    const id = register();
    revokeProfileDelegation(db, OP_SURFACE, PROFILE);
    try {
      decide(id);
      throw new Error('should have refused');
    } catch (err) {
      expect((err as ApprovalDecisionError).code).toBe('profile-delegation-stale');
    }
  });
});

describe('C2-8 grant shape (props 11, 12)', () => {
  it('the grant TTL comes from the DECISION clock, never the approval deadline', () => {
    const id = register();
    const decided = decide(id)!;
    const grant = db.prepare('SELECT * FROM gateway_action_grants WHERE grant_id=?')
      .get(decided.grantId!) as Record<string, unknown>;
    const created = Date.parse(String(grant.created_at).replace(' ', 'T') + 'Z');
    const expires = Date.parse(String(grant.expires_at).replace(' ', 'T') + 'Z');
    const ttl = Math.round((expires - created) / 1000);
    expect(ttl).toBe(GRANT_TTL_SECONDS);
    // and it is much SHORTER than the approval TTL -- proving it was not copied
    expect(ttl).toBeLessThan(APPROVAL_TTL_SECONDS);
  });

  it('the grant binds the exact action hash and the source->dispatch pair', () => {
    const id = register();
    const decided = decide(id)!;
    const grant = db.prepare('SELECT * FROM gateway_action_grants WHERE grant_id=?')
      .get(decided.grantId!) as Record<string, unknown>;
    const binding = db.prepare('SELECT action_hash FROM gateway_approval_bindings WHERE approval_id=?')
      .get(id) as { action_hash: string };
    expect(grant.action_hash).toBe(binding.action_hash);
    expect(grant.source_request_id).toBe('req-1');
    expect(grant.dispatch_request_id).toBe(decided.dispatchRequestId);
    expect(grant.deciding_surface_id).toBe(OP_SURFACE);
  });

  it('the expired-grant sweep revokes unconsumed grants past their TTL', () => {
    const id = register();
    const decided = decide(id)!;
    db.prepare("UPDATE gateway_action_grants SET expires_at='2000-01-01 00:00:00.000' WHERE grant_id=?")
      .run(decided.grantId!);
    expect(sweepExpiredGrants(db)).toBe(1);
    const grant = db.prepare('SELECT revoked_at FROM gateway_action_grants WHERE grant_id=?')
      .get(decided.grantId!) as { revoked_at: string | null };
    expect(grant.revoked_at).not.toBeNull();
    // never resurrected
    expect(sweepExpiredGrants(db)).toBe(0);
  });
});

describe('M-1/M-2 single-writer discipline (§3.1)', () => {
  it('no other gateway module contains an UPDATE of tool_approvals.status', async () => {
    // The state machine has no DDL CHECK (CT-3), so "one writer" is a
    // code-audit obligation rather than a schema guarantee. This test IS
    // that audit, mechanically -- it is the reason approvals.ts had to
    // delegate its legacy transition here instead of keeping its own
    // inline UPDATE.
    const { readdirSync, readFileSync: rf } = await import('node:fs');
    const srcDir = join(here, '..', 'packages', 'gateway', 'src');
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      if (file === 'approvalWriter.ts') continue;      // THE one writer
      const text = rf(join(srcDir, file), 'utf8');
      const updates = text.match(/UPDATE\s+tool_approvals[\s\S]{0,200}?SET[\s\S]{0,200}?status\s*=/gi);
      if (updates) offenders.push(`${file}: ${updates.length}`);
    }
    expect(offenders, 'only approvalWriter.ts may write tool_approvals.status').toEqual([]);
  });

  it('the legacy flag-off transition still wins-once and replays harmlessly', () => {
    // approvals.ts now delegates here; prove the delegated statement kept
    // the exact shipped semantics rather than merely compiling.
    const id = register();
    expect(legacyStatusTransition(db, id, 'approved').changes).toBe(1);
    expect(legacyStatusTransition(db, id, 'approved').changes).toBe(0);
    expect(legacyStatusTransition(db, id, 'rejected').changes).toBe(0);
    expect(approvalRow(id).status).toBe('approved');
    // and it writes no C2 evidence, which is correct: a flag-off decision
    // has no surface identity to record.
    expect(approvalRow(id).decided_surface_id).toBeNull();
    expect(approvalRow(id).context_hash).toBeNull();
  });
});
