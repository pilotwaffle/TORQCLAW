/**
 * C2 BROKER WIRING — the seam that connects the C2 machinery to the live
 * gateway paths.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §1.4, §3.1, §3.4.2, §8 C2-2/C2-3/C2-5/C2-8.
 *
 * WHY THIS MODULE EXISTS (G2A D-1)
 * ---------------------------------
 * The first C2 build shipped `registerC2Approval` / `decideC2Approval` with
 * ZERO production callers. Every gate was green and the feature was
 * completely non-functional: flag-on, the live flow still ran the legacy
 * register/decide, so no grant row was ever minted and every approved
 * LOCAL_EDGE re-run was refused `grant-missing` at the admission seam.
 * That is the recurring unenforced-claim defect -- a control that exists
 * but is connected to nothing.
 *
 * So this module is deliberately the ONLY place that decides "C2 or
 * legacy", and both `dispatch.ts` (registration) and `server.ts`
 * (decision) route through it. One decision point, not two, because two
 * would drift.
 *
 * FLAG-OFF IS UNTOUCHED LEGACY (SI-4)
 * ------------------------------------
 * Every entry point below returns `null` immediately when
 * `collabEnabled()` is false, and the caller then runs exactly the code it
 * ran before C2 existed. No new table is read or written, no new column is
 * populated, and the wire transcript is byte-identical.
 *
 * FAIL-CLOSED, BUT NOT FAIL-BROKEN
 * ---------------------------------
 * C2 registration needs evidence the legacy path never had: an immutable
 * task origin, a live profile delegation, a resolved effective profile.
 * When that evidence is absent -- a flag-on connection that never
 * presented a C1 surface, say -- registration CANNOT produce a valid
 * binding. It returns null and the caller falls back to the legacy
 * registration, which yields an approval with no binding and no expiry.
 * The writer already treats exactly that row as inert and
 * reissue-required (§3.9), so the fallback denies rather than opens: such
 * an approval can be created but never decided under the flag.
 */

import { randomUUID } from 'node:crypto';
import type { GatewayRequest, RouterDiagnostics } from '@torqclaw/contracts';
import { db } from './storage.js';
import { collabEnabled } from './principalBridge.js';
import { taskOrigin, liveProfileDelegation } from './surfaceSecurity.js';
import {
  registerC2Approval, decideC2Approval, ApprovalDecisionError,
  type DecidedC2Approval,
} from './approvalWriter.js';
import {
  validateAndCanonicalizeArgs, privacyContextHash, routingContextHash,
  securityPolicyHash, type ContextHashInput,
} from './approvalContext.js';

/**
 * Resolve the ten CTXHASH_V1 inputs for a request, or null when any
 * required source is missing.
 *
 * Missing evidence REFUSES rather than substituting a placeholder: a
 * digest computed over a fabricated value would compare equal to another
 * fabrication and silently authorize drift (§3.4.1).
 */
function resolveContext(
  req: GatewayRequest,
  diag: RouterDiagnostics,
  toolName: string,
  canonicalArgs: string,
): { context: ContextHashInput; delegationId: string; delegationRevision: number } | null {
  const origin = taskOrigin(db, req.id);
  if (!origin) return null;                      // no immutable origin evidence
  const profile = req.effectiveProfile;
  if (!profile) return null;                     // no resolved execution profile

  const delegation = liveProfileDelegation(db, origin.surfaceId, profile.profileId);
  if (!delegation) return null;                  // no live profile delegation

  const privacy = privacyContextHash({
    containsSensitiveData: req.constraints.containsSensitiveData === true,
  });
  // NOTE (must stay aligned with decideApprovalC2): the routing digest
  // uses the tier this task actually ran at, and `ruleId: null`. The
  // decision side re-resolves from the PERSISTED `tasks.tier`, where the
  // router's ruleId is not retained, so registration must not fold it in
  // either -- otherwise every decision would see spurious context drift
  // and refuse a legitimate approval.
  const routing = routingContextHash({
    executionMode: req.constraints.executionMode ?? 'AUTO',
    selectedTier: String(diag.tier),
    ruleId: null,
  });
  const security = securityPolicyHash({
    effectiveProfile: {
      schemaVersion: profile.schemaVersion,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      toolRegistryVersion: profile.toolRegistryVersion,
      effectiveProfilePolicyHash: profile.policyHash,
    },
    capabilityRevision: origin.capabilityRevision,
    profileDelegationRevision: delegation.profileDelegationRevision,
    registryEnforcementHash: delegation.registryEnforcementHash,
  });

  return {
    context: {
      originPrincipalId: origin.principalId,
      originSurfaceId: origin.surfaceId,
      sourceRequestId: req.id,
      originSurfaceKind: origin.surfaceKind,
      profileId: profile.profileId,
      toolName,
      canonicalArgs,
      privacyContextHash: privacy,
      routingContextHash: routing,
      securityPolicyHash: security,
    },
    delegationId: delegation.delegationId,
    delegationRevision: delegation.profileDelegationRevision,
  };
}

/**
 * Flag-on registration (C2-2 + C2-5). Returns the approvalId when C2 owned
 * the registration, or null to tell the caller to use the legacy path.
 */
export function registerApprovalC2(
  req: GatewayRequest,
  diag: RouterDiagnostics,
  toolName: string,
  args: unknown,
): string | null {
  if (!collabEnabled()) return null;
  try {
    // §3.1: a flag-on C2 registration requires a present, acyclic plain
    // object. Invalid args are refused BEFORE any pending row exists,
    // because a row that cannot be canonicalized could never be matched at
    // the pre-execution seam.
    const canonicalArgs = validateAndCanonicalizeArgs(args);
    const resolved = resolveContext(req, diag, toolName, canonicalArgs);
    if (!resolved) return null;

    const profile = req.effectiveProfile!;
    const approvalId = randomUUID();
    registerC2Approval(db, {
      approvalId,
      requestId: req.id,
      toolName,
      canonicalArgs,
      originPrincipalId: resolved.context.originPrincipalId,
      originSurfaceId: resolved.context.originSurfaceId,
      contextInput: resolved.context,
      binding: {
        delegationId: resolved.delegationId,
        profileDelegationRevision: resolved.delegationRevision,
        registeredProfileId: profile.profileId,
        registeredProfileVersion: profile.profileVersion,
        registeredToolRegistryVersion: profile.toolRegistryVersion,
        registeredEffectiveProfilePolicyHash: profile.policyHash,
        registeredCapabilityRevision: taskOrigin(db, req.id)!.capabilityRevision,
        registeredRegistryEnforcementHash:
          liveProfileDelegation(db, resolved.context.originSurfaceId, profile.profileId)!
            .registryEnforcementHash,
        registeredPrivacyContextHash: resolved.context.privacyContextHash,
        registeredRoutingContextHash: resolved.context.routingContextHash,
        registeredSecurityPolicyHash: resolved.context.securityPolicyHash,
      },
    });
    return approvalId;
  } catch {
    // Any failure means no valid C2 binding exists. Fall back to the
    // legacy registration, whose resulting row is inert under the flag.
    return null;
  }
}

export type DecideC2Outcome =
  | { kind: 'legacy' }                                  // caller uses decideApproval
  | { kind: 'decided'; decided: DecidedC2Approval }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'noop' };                                   // unknown or already decided

/**
 * Flag-on decision (C2-2/C2-3/C2-4/C2-5/C2-8).
 *
 * Returns `legacy` when this approval has no C2 binding, so the caller runs
 * the untouched legacy decide. Otherwise the C2 writer owns the transition,
 * and on APPROVE it mints the re-minted dispatch task plus exactly one
 * grant inside the same transaction.
 */
export function decideApprovalC2(
  approvalId: string,
  decision: 'APPROVE' | 'REJECT',
  decidingPrincipalId: string | null,
  decidingSurfaceId: string | null,
  mintDispatchTask: (dispatchRequestId: string) => void,
): DecideC2Outcome {
  if (!collabEnabled()) return { kind: 'legacy' };

  const binding = db.prepare(
    'SELECT approval_id FROM gateway_approval_bindings WHERE approval_id = ?',
  ).get(approvalId);
  if (!binding) return { kind: 'legacy' };  // pre-C2 / unbound row

  // A C2-bound approval REQUIRES a decider identity. A flag-on connection
  // with no verified surface cannot supply one, and guessing would defeat
  // the whole authority model, so it is refused rather than downgraded to
  // the legacy path.
  if (!decidingPrincipalId || !decidingSurfaceId) {
    return {
      kind: 'refused',
      code: 'authority-denied',
      message: 'this approval requires a verified operator surface to decide',
    };
  }

  const req = db.prepare(
    `SELECT t.request_json AS requestJson, t.tier AS tier,
            a.tool_name AS toolName, a.args_json AS argsJson
       FROM tool_approvals a
       LEFT JOIN tasks t ON t.request_id = a.request_id
      WHERE a.approval_id = ?`,
  ).get(approvalId) as
    | { requestJson: string | null; tier: string | null; toolName: string; argsJson: string }
    | undefined;
  if (!req?.requestJson) {
    return { kind: 'refused', code: 'approval-legacy-reissue-required', message: 'no original request to re-run' };
  }

  // Re-resolve the CURRENT ten inputs. The writer compares this digest
  // against the immutable registration digest and refuses on drift; that
  // comparison is the whole of property 10's C2 half, so the inputs must
  // come from live state here rather than from the stored binding.
  const original = JSON.parse(req.requestJson) as GatewayRequest;
  const origin = taskOrigin(db, original.id);
  const profile = original.effectiveProfile;
  if (!origin || !profile) {
    return { kind: 'refused', code: 'approval-context-invalidated', message: 'origin or profile evidence is missing' };
  }
  const delegation = liveProfileDelegation(db, origin.surfaceId, profile.profileId);
  if (!delegation) {
    return { kind: 'refused', code: 'profile-delegation-stale', message: 'no live profile delegation' };
  }

  const currentContext: ContextHashInput = {
    originPrincipalId: origin.principalId,
    originSurfaceId: origin.surfaceId,
    sourceRequestId: original.id,
    originSurfaceKind: origin.surfaceKind,
    profileId: profile.profileId,
    toolName: req.toolName,
    canonicalArgs: req.argsJson,
    privacyContextHash: privacyContextHash({
      containsSensitiveData: original.constraints.containsSensitiveData === true,
    }),
    // The tier comes from the PERSISTED task row -- the tier the blocked
    // task actually ran at -- not from a re-route here. Re-routing at
    // decision time would make the digest depend on the router's current
    // mood rather than on the approved execution context.
    routingContextHash: routingContextHash({
      executionMode: original.constraints.executionMode ?? 'AUTO',
      selectedTier: req.tier ?? 'OLLAMA_LOCAL',
      ruleId: null,
    }),
    securityPolicyHash: securityPolicyHash({
      effectiveProfile: {
        schemaVersion: profile.schemaVersion,
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        toolRegistryVersion: profile.toolRegistryVersion,
        effectiveProfilePolicyHash: profile.policyHash,
      },
      capabilityRevision: origin.capabilityRevision,
      profileDelegationRevision: delegation.profileDelegationRevision,
      registryEnforcementHash: delegation.registryEnforcementHash,
    }),
  };

  try {
    const decided = decideC2Approval(db, {
      approvalId,
      decision,
      decidingPrincipalId,
      decidingSurfaceId,
      currentContext,
      dispatchRequestId: randomUUID(),
      mintDispatchTask,
    });
    if (!decided) return { kind: 'noop' };
    return { kind: 'decided', decided };
  } catch (error) {
    if (error instanceof ApprovalDecisionError) {
      return { kind: 'refused', code: error.code, message: error.message };
    }
    throw error;
  }
}

// G2A N-2: `hasC2Binding` was removed here. It had no production caller,
// and its doc comment claimed it was "used by the FRONTIER guard in
// server.ts" -- which was false: that guard keys on `diag.tier`, never on
// whether a binding exists.
//
// Deleted rather than wired, deliberately. An inaccurate comment about
// where enforcement happens is worse than a missing helper: the next
// reader auditing the FRONTIER path would have gone looking for a check
// that was never there. The binding lookup this function duplicated
// already lives inline in `decideApprovalC2` above, at the one seam that
// actually needs it.
