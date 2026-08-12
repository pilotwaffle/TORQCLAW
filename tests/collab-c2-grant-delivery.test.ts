/**
 * C2-7 (delivery projection) + C2-8 (one-shot grant admission).
 * PRD-TCLAW-COLLAB-GATEWAY-004 §1.4, §3.3 props 5/6/11/12, §3.13, §7 A10,
 * §8 C2-7/C2-8.
 *
 * PRE-REGISTERED OBLIGATION 5 lives here: FRONTIER must stay FAIL-CLOSED
 * at the pre-tool-execution grant seam until its structured-grant protocol
 * is separately authorized. A FRONTIER task hitting a gated tool with C2
 * grants active must REFUSE, never bypass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ensureSurfaceSecuritySchema, activateSurfaceProjection, grantAuthority,
  grantProfileDelegation, revokeProfileDelegation, revokeSurfaceProjection,
} from '../packages/gateway/src/surfaceSecurity.js';
import { ensureApprovalBrokerSchema } from '../packages/gateway/src/approvalSchema.js';
import {
  registerC2Approval, decideC2Approval,
} from '../packages/gateway/src/approvalWriter.js';
import {
  privacyContextHash, routingContextHash, securityPolicyHash,
  validateAndCanonicalizeArgs, type ContextHashInput,
} from '../packages/gateway/src/approvalContext.js';
import {
  admitToolCall, revokeInertGrants,
} from '../packages/gateway/src/grantAdmission.js';
import {
  rebuildDeliveryProjection, recordDelivery, markDelivery,
  eligibleOperatorSurfaces, actionableForSurface, NO_ELIGIBLE_SURFACE,
} from '../packages/gateway/src/approvalDelivery.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'packages', 'gateway', 'db', 'schema.sql'), 'utf8');
const legacySchema = SCHEMA.slice(0, SCHEMA.indexOf('-- TORQCLAW_RESILIENCE_SCHEMA_BEGIN'));

const PRINCIPAL = 'prn_op';
const OP_SURFACE = 'srf_desktop_op';
const CHANNEL_SURFACE = 'srf_telegram';
const PROFILE = 'workspace_write';
const POLICY_HASH = 'e'.repeat(64);
const REGISTRY_HASH = 'd'.repeat(64);
const TOOL = 'filesystem__write_file';
const ARGS = { path: '/tmp/x.txt', contents: 'hello' };

let db: Database.Database;
let delegationId: string;

function makeContext(canonicalArgs: string): ContextHashInput {
  return {
    originPrincipalId: PRINCIPAL,
    originSurfaceId: OP_SURFACE,
    sourceRequestId: 'req-1',
    originSurfaceKind: 'desktop',
    profileId: PROFILE,
    toolName: TOOL,
    canonicalArgs,
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
  };
}

/** Register + approve, returning the dispatch request id carrying the grant. */
function approvedGrant(args: unknown = ARGS): { dispatchRequestId: string; approvalId: string } {
  const canonicalArgs = validateAndCanonicalizeArgs(args);
  const approvalId = randomUUID();
  const ctx = makeContext(canonicalArgs);
  registerC2Approval(db, {
    approvalId, requestId: 'req-1', toolName: TOOL, canonicalArgs,
    originPrincipalId: PRINCIPAL, originSurfaceId: OP_SURFACE, contextInput: ctx,
    binding: {
      delegationId, profileDelegationRevision: 1, registeredProfileId: PROFILE,
      registeredProfileVersion: 1, registeredToolRegistryVersion: 'torqclaw.tools/v1',
      registeredEffectiveProfilePolicyHash: POLICY_HASH, registeredCapabilityRevision: 1,
      registeredRegistryEnforcementHash: REGISTRY_HASH,
      registeredPrivacyContextHash: ctx.privacyContextHash,
      registeredRoutingContextHash: ctx.routingContextHash,
      registeredSecurityPolicyHash: ctx.securityPolicyHash,
    },
  });
  const dispatchRequestId = randomUUID();
  const decided = decideC2Approval(db, {
    approvalId, decision: 'APPROVE', decidingPrincipalId: PRINCIPAL,
    decidingSurfaceId: OP_SURFACE, currentContext: ctx, dispatchRequestId,
    mintDispatchTask: (id) => {
      db.prepare(
        `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
         VALUES (?, 's1','LOCAL_EDGE','remint','running','{}')`,
      ).run(id);
    },
  });
  expect(decided).not.toBeNull();
  return { dispatchRequestId, approvalId };
}

/** Register a pending approval only (no decision) -- for delivery tests. */
function pendingApproval(): string {
  const canonicalArgs = validateAndCanonicalizeArgs(ARGS);
  const approvalId = randomUUID();
  const ctx = makeContext(canonicalArgs);
  registerC2Approval(db, {
    approvalId, requestId: 'req-1', toolName: TOOL, canonicalArgs,
    originPrincipalId: PRINCIPAL, originSurfaceId: OP_SURFACE, contextInput: ctx,
    binding: {
      delegationId, profileDelegationRevision: 1, registeredProfileId: PROFILE,
      registeredProfileVersion: 1, registeredToolRegistryVersion: 'torqclaw.tools/v1',
      registeredEffectiveProfilePolicyHash: POLICY_HASH, registeredCapabilityRevision: 1,
      registeredRegistryEnforcementHash: REGISTRY_HASH,
      registeredPrivacyContextHash: ctx.privacyContextHash,
      registeredRoutingContextHash: ctx.routingContextHash,
      registeredSecurityPolicyHash: ctx.securityPolicyHash,
    },
  });
  return approvalId;
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
    [CHANNEL_SURFACE, 'telegram', 'agent'],
  ] as const) {
    activateSurfaceProjection(db, {
      surfaceId: id, principalId: PRINCIPAL, surfaceKind: kind, surfaceRole: role,
      allowedCapabilityClasses: ['read', 'write'], authEpoch: 1, capabilityRevision: 1,
      sourceIdentityRevision: 'rev-1',
    });
  }
  grantAuthority(db, OP_SURFACE, 'approve', randomUUID());
  delegationId = randomUUID();
  grantProfileDelegation(db, {
    delegationId, surfaceId: OP_SURFACE, profileId: PROFILE,
    profileDelegationRevision: 1, profileSchemaVersion: 'torqclaw.effective-profile/v1',
    profileVersion: 1, toolRegistryVersion: 'torqclaw.tools/v1',
    effectiveProfilePolicyHash: POLICY_HASH, registryEnforcementHash: REGISTRY_HASH,
  });
});

afterEach(() => db.close());

describe('C2-8 one-shot grant admission (§1.4, props 11/12)', () => {
  it('admits the exact approved action, once', () => {
    const { dispatchRequestId } = approvedGrant();
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(true);
    const grant = db.prepare('SELECT consumed_at FROM gateway_action_grants WHERE dispatch_request_id=?')
      .get(dispatchRequestId) as { consumed_at: string | null };
    expect(grant.consumed_at, 'consumption must be DURABLE').not.toBeNull();
  });

  it('ONE-SHOT: a second admission of the same grant refuses', () => {
    const { dispatchRequestId } = approvedGrant();
    expect(admitToolCall(db, { dispatchRequestId, toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE' }).ok)
      .toBe(true);
    const second = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE',
    });
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toBe('grant-consumed');
  });

  it('ALTERED ARGS refuse: the exact-action digest must match', () => {
    const { dispatchRequestId } = approvedGrant();
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL,
      args: { path: '/etc/passwd', contents: 'hello' },   // <-- the attack
      path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('action-binding-mismatch');
    // and NOTHING was consumed -- the grant survives for its legitimate call
    const grant = db.prepare('SELECT consumed_at FROM gateway_action_grants WHERE dispatch_request_id=?')
      .get(dispatchRequestId) as { consumed_at: string | null };
    expect(grant.consumed_at).toBeNull();
  });

  it('a DIFFERENT TOOL with the same args refuses', () => {
    const { dispatchRequestId } = approvedGrant();
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: 'shell__run', args: ARGS, path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('action-binding-mismatch');
  });

  it('key-order permutation still admits (canonicalJson sorts)', () => {
    const { dispatchRequestId } = approvedGrant();
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL,
      args: { contents: 'hello', path: '/tmp/x.txt' },    // same values, other order
      path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(true);
  });

  it('an unknown dispatch request refuses (no grant, no side effect)', () => {
    const result = admitToolCall(db, {
      dispatchRequestId: randomUUID(), toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('grant-missing');
  });

  it('an EXPIRED grant is materialized revoked, then refused (never revived)', () => {
    const { dispatchRequestId } = approvedGrant();
    db.prepare("UPDATE gateway_action_grants SET expires_at='2000-01-01 00:00:00.000' WHERE dispatch_request_id=?")
      .run(dispatchRequestId);
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('grant-expired');
    const grant = db.prepare('SELECT revoked_at, consumed_at FROM gateway_action_grants WHERE dispatch_request_id=?')
      .get(dispatchRequestId) as { revoked_at: string | null; consumed_at: string | null };
    expect(grant.revoked_at).not.toBeNull();
    expect(grant.consumed_at).toBeNull();
  });

  it('REVOCATION-COMMITS-FIRST wins over dispatch (§1.4)', () => {
    const { dispatchRequestId } = approvedGrant();
    // A revocation lands before admission.
    db.prepare("UPDATE gateway_action_grants SET revoked_at=CURRENT_TIMESTAMP WHERE dispatch_request_id=?")
      .run(dispatchRequestId);
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('grant-revoked');
  });

  it('prop 12: a STALE profile delegation refuses even with a perfect action match', () => {
    const { dispatchRequestId } = approvedGrant();
    revokeProfileDelegation(db, OP_SURFACE, PROFILE);
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('profile-delegation-stale');
  });

  it('prop 12: an auth-epoch change after the decision refuses', () => {
    const { dispatchRequestId } = approvedGrant();
    revokeSurfaceProjection(db, OP_SURFACE);         // bumps the epoch
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('authority-epoch-stale');
  });

  it('invalid regenerated args refuse before any state is touched', () => {
    const { dispatchRequestId } = approvedGrant();
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL, args: null, path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('args-invalid');
    const grant = db.prepare('SELECT consumed_at FROM gateway_action_grants WHERE dispatch_request_id=?')
      .get(dispatchRequestId) as { consumed_at: string | null };
    expect(grant.consumed_at).toBeNull();
  });

  it('recovery revokes inert grants and NEVER dispatches them', () => {
    const { dispatchRequestId } = approvedGrant();
    expect(revokeInertGrants(db)).toBe(1);
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('grant-revoked');
  });
});

// ── PRE-REGISTERED OBLIGATION 5 ────────────────────────────────────────────
describe('OBLIGATION 5: FRONTIER fails closed at the grant seam (§1.4, §3.4.2)', () => {
  it('a FRONTIER task with a PERFECTLY VALID grant is still REFUSED', () => {
    const { dispatchRequestId } = approvedGrant();
    // Everything about this call is legitimate except the path. FRONTIER's
    // Hermes hook cannot prove the args it is about to execute are the
    // args that were approved, so it must refuse rather than bypass.
    const result = admitToolCall(db, {
      dispatchRequestId, toolName: TOOL, args: ARGS, path: 'FRONTIER',
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('frontier-structured-grant-unavailable');
  });

  it('the refused FRONTIER call consumes NOTHING (no side effect, no burn)', () => {
    const { dispatchRequestId } = approvedGrant();
    admitToolCall(db, { dispatchRequestId, toolName: TOOL, args: ARGS, path: 'FRONTIER' });
    const grant = db.prepare('SELECT consumed_at, revoked_at FROM gateway_action_grants WHERE dispatch_request_id=?')
      .get(dispatchRequestId) as { consumed_at: string | null; revoked_at: string | null };
    expect(grant.consumed_at).toBeNull();
    expect(grant.revoked_at).toBeNull();
    // ...and the LOCAL_EDGE path can still legitimately use it
    expect(admitToolCall(db, { dispatchRequestId, toolName: TOOL, args: ARGS, path: 'LOCAL_EDGE' }).ok)
      .toBe(true);
  });

  it('FRONTIER is refused BY NAME, not by falling through an unhandled branch', () => {
    const src = readFileSync(
      join(here, '..', 'packages', 'gateway', 'src', 'grantAdmission.ts'), 'utf8',
    );
    // An unchecked path that quietly proceeds is indistinguishable from a
    // checked one until it is not; the refusal must be explicit.
    expect(src).toMatch(/if \(params\.path === 'FRONTIER'\) return refuseFrontier\(\)/);
  });
});

describe('property 11: "Allow for session" is not implementable here', () => {
  it('the literal never appears in any implementation/config surface', () => {
    const srcDir = join(here, '..', 'packages', 'gateway', 'src');
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      // The PRD lints the IMPLEMENTATION surface for the string's ABSENCE
      // (§10, corrected): it must never ship as a grant option.
      if (/allow\s+for\s+session/i.test(text)) offenders.push(file);
    }
    expect(offenders, '"Allow for session" must not exist as a grant option').toEqual([]);
  });

  it('there is no grant TYPE/scope parameter a caller could widen', () => {
    const src = readFileSync(
      join(here, '..', 'packages', 'gateway', 'src', 'grantAdmission.ts'), 'utf8',
    );
    expect(src).not.toMatch(/grantType|grantScope\s*:|sessionGrant|durableGrant/);
  });

  it('one approval can never mint a second grant (approval_id UNIQUE)', () => {
    const { approvalId } = approvedGrant();
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_action_grants WHERE approval_id=?')
      .get(approvalId)).toEqual({ c: 1 });
  });
});

describe('C2-7 delivery projection (props 5/6; A10)', () => {
  it('eligibility requires operator role AND a live approve authority', () => {
    expect(eligibleOperatorSurfaces(db)).toEqual([OP_SURFACE]);
    // the channel surface is never eligible
    expect(eligibleOperatorSurfaces(db)).not.toContain(CHANNEL_SURFACE);
  });

  it('rebuild projects pending approvals to current eligible surfaces', () => {
    const a = pendingApproval();
    const result = rebuildDeliveryProjection(db);
    expect(result.created).toBe(1);
    expect(result.unroutable).toEqual([]);
    expect(actionableForSurface(db, OP_SURFACE).map((d) => d.approvalId)).toEqual([a]);
  });

  it('A10: rebuild is idempotent and drops stale rows', () => {
    pendingApproval();
    const first = rebuildDeliveryProjection(db);
    const second = rebuildDeliveryProjection(db);
    expect(second.created).toBe(first.created);
    expect(db.prepare('SELECT COUNT(*) c FROM approval_deliveries').get()).toEqual({ c: 1 });
  });

  it('A10: a REVOKED target is never re-projected after a restart', () => {
    pendingApproval();
    rebuildDeliveryProjection(db);
    expect(actionableForSurface(db, OP_SURFACE)).toHaveLength(1);

    // The operator surface loses authority while the gateway is "down".
    revokeSurfaceProjection(db, OP_SURFACE);
    const after = rebuildDeliveryProjection(db);

    expect(after.created).toBe(0);
    expect(after.reason).toBe(NO_ELIGIBLE_SURFACE);
    expect(actionableForSurface(db, OP_SURFACE)).toHaveLength(0);
  });

  it('A10: approval TRUTH survives a projection that cannot be delivered', () => {
    const a = pendingApproval();
    revokeSurfaceProjection(db, OP_SURFACE);
    const result = rebuildDeliveryProjection(db);
    expect(result.unroutable).toEqual([a]);
    // the approval itself is untouched and still pending
    const row = db.prepare('SELECT status FROM tool_approvals WHERE approval_id=?').get(a) as
      { status: string };
    expect(row.status).toBe('pending');
  });

  it('A10: the whole projection can be DROPPED and rebuilt with no loss of truth', () => {
    const a = pendingApproval();
    rebuildDeliveryProjection(db);
    db.prepare('DROP TABLE approval_deliveries').run();
    ensureApprovalBrokerSchema(db);                       // recreate empty
    expect(db.prepare('SELECT COUNT(*) c FROM approval_deliveries').get()).toEqual({ c: 0 });
    const rebuilt = rebuildDeliveryProjection(db);
    expect(rebuilt.created).toBe(1);
    expect(actionableForSurface(db, OP_SURFACE).map((d) => d.approvalId)).toEqual([a]);
  });

  it('prop 5: a delivery FAILURE never changes approval state', () => {
    const a = pendingApproval();
    const deliveryId = recordDelivery(db, a, OP_SURFACE);
    markDelivery(db, deliveryId, 'failed');
    const row = db.prepare('SELECT status FROM tool_approvals WHERE approval_id=?').get(a) as
      { status: string };
    expect(row.status).toBe('pending');
  });

  it('prop 5 STRUCTURALLY: the delivery module contains no tool_approvals write', () => {
    const src = readFileSync(
      join(here, '..', 'packages', 'gateway', 'src', 'approvalDelivery.ts'), 'utf8',
    );
    expect(src).not.toMatch(/UPDATE\s+tool_approvals/i);
    expect(src).not.toMatch(/INSERT\s+INTO\s+tool_approvals/i);
    expect(src).not.toMatch(/DELETE\s+FROM\s+tool_approvals/i);
  });

  it('prop 6: a decided approval drops out of the actionable view', () => {
    pendingApproval();
    rebuildDeliveryProjection(db);
    expect(actionableForSurface(db, OP_SURFACE)).toHaveLength(1);
    const { dispatchRequestId } = approvedGrant();
    void dispatchRequestId;
    // the newly approved one is not pending, so it is not actionable
    const stillActionable = actionableForSurface(db, OP_SURFACE);
    expect(stillActionable.every((d) => d.deliveryState === 'pending')).toBe(true);
  });
});
