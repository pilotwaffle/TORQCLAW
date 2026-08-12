/**
 * C2-2 / C2-3 / C2-4 / C2-8 — THE single centralized approval-state writer.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §3.1 (M-1/M-2), §3.3, §3.4.2, §3.5, §3.9,
 * §3.14 (CT-2), §1.4, §8.
 *
 * WHY ONE WRITER (M-1/M-2, normative)
 * ------------------------------------
 * The shipped `tool_approvals.status` column has NO DDL CHECK constraint
 * (CT-3), so the database itself will happily accept any string. The state
 * machine `pending -> approved|rejected|expired` is therefore enforced by
 * code, and that only works if there is exactly ONE writer. Every lazy
 * decide and every expiry sweep enters `decideApprovalGuarded` /
 * `sweepExpiredApprovals` below; no other module may UPDATE the status
 * column. The absence of a DDL CHECK converts directly into this
 * code-audit-plus-mutation-test obligation.
 *
 * THE FOUR-STEP PROCEDURE (§3.1), IN ORDER
 * -----------------------------------------
 *   1. BEGIN IMMEDIATE, and capture ONE database-derived `canonical_now`
 *      for the whole transaction. One clock read, not several: two reads
 *      could straddle the expiry boundary and let a row be both "not yet
 *      expired" for the decision predicate and "already expired" for the
 *      sweep predicate within a single transaction.
 *   2. Materialize expiry for the target first (writes no decision
 *      evidence, mints no grant).
 *   3. If still pending, decide -- but only with a finite unexpired
 *      deadline, matching context, live authority, and the guarded status
 *      predicate. APPROVE writes evidence AND exactly one grant; REJECT
 *      writes evidence and no grant.
 *   4. Commit. A competing decision/expiry/replay observes the serialized
 *      winner and changes ZERO rows.
 *
 * WHY THE GUARDED UPDATE IS STILL THE CORE
 * -----------------------------------------
 * `UPDATE ... WHERE approval_id=? AND status='pending'` already gave the
 * shipped gateway first-decision-wins and replay-harmlessness (properties 3
 * and 4). C2 does not replace that; it WIDENS THE SAME TRANSACTION to also
 * write the canonical decision evidence and the one grant. That is why
 * evidence can never disagree with status: they are the same commit.
 */

import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  holdsAuthority, liveSurfaceSecurity, delegationById,
  type LiveSurfaceSecurity,
} from './surfaceSecurity.js';
import { actionHash, contextHash, type ContextHashInput } from './approvalContext.js';

/**
 * OQ-5 fail-closed defaults (§3.9, §3.1). Both are finite by construction;
 * the PRD is explicit that "unset or unbounded values are invalid".
 */
export const APPROVAL_TTL_SECONDS = 15 * 60;
export const GRANT_TTL_SECONDS = 60;

/** Channel/automation surface kinds — structurally barred from `approve`. */
const CHANNEL_KINDS: ReadonlySet<string> = new Set(['telegram', 'slack', 'automation']);

/** Operator-facing failure states (§6.8). A refusal is always explicit. */
export type ApprovalRefusal =
  | 'approval-unknown'
  | 'approval-already-decided'
  | 'approval-expired'
  | 'approval-legacy-reissue-required'
  | 'authority-denied'
  | 'surface-not-operator'
  | 'channel-self-approve-refused'
  | 'cross-channel-approval-forbidden'
  | 'approval-context-invalidated'
  | 'profile-delegation-stale'
  | 'capability-revision-stale';

export class ApprovalDecisionError extends Error {
  readonly code: ApprovalRefusal;
  constructor(code: ApprovalRefusal, message: string) {
    super(message);
    this.name = 'ApprovalDecisionError';
    this.code = code;
  }
}

export interface ApprovalRow {
  approvalId: string;
  requestId: string;
  toolName: string;
  status: string;
  argsJson: string;
  originPrincipalId: string | null;
  originSurfaceId: string | null;
  decidedPrincipalId: string | null;
  decidedSurfaceId: string | null;
  expiresAt: string | null;
  contextHash: string | null;
}

export interface BindingRow {
  approvalId: string;
  requestId: string;
  actionHash: string;
  canonicalArgsHash: string;
  registrationContextHash: string;
  delegationId: string;
  profileDelegationRevision: number;
  registeredCapabilityRevision: number;
  registeredEffectiveProfilePolicyHash: string;
  registeredRegistryEnforcementHash: string;
  registeredProfileId: string;
}

/**
 * ONE database-derived clock for the whole transaction (§3.1 step 1).
 *
 * Deliberately the DATABASE's clock, not the process's: the sweep and the
 * decision must order against the same timebase, and `expires_at` values
 * are written by SQLite's own `CURRENT_TIMESTAMP` family elsewhere.
 */
function canonicalNow(db: Database.Database): string {
  const row = db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f','now') AS now`).get() as { now: string };
  return row.now;
}

/**
 * Add seconds to a `canonical_now` string, staying in the exact
 * 'YYYY-MM-DD HH:MM:SS.SSS' shape SQLite's `strftime` produced, so that
 * string comparison in the SQL predicates orders correctly. The value is
 * interpreted as UTC because `strftime('...','now')` is UTC.
 */
function addSeconds(canonical: string, seconds: number): string {
  const ms = Date.parse(`${canonical.replace(' ', 'T')}Z`);
  return new Date(ms + seconds * 1000)
    .toISOString().replace('T', ' ').replace('Z', '');
}

function readApproval(db: Database.Database, approvalId: string): ApprovalRow | null {
  const row = db.prepare(
    `SELECT approval_id AS approvalId, request_id AS requestId, tool_name AS toolName,
            status, args_json AS argsJson,
            origin_principal_id AS originPrincipalId, origin_surface_id AS originSurfaceId,
            decided_principal_id AS decidedPrincipalId, decided_surface_id AS decidedSurfaceId,
            expires_at AS expiresAt, context_hash AS contextHash
       FROM tool_approvals WHERE approval_id = ?`,
  ).get(approvalId) as ApprovalRow | undefined;
  return row ?? null;
}

function readBinding(db: Database.Database, approvalId: string): BindingRow | null {
  const row = db.prepare(
    `SELECT approval_id AS approvalId, request_id AS requestId, action_hash AS actionHash,
            canonical_args_hash AS canonicalArgsHash,
            registration_context_hash AS registrationContextHash,
            delegation_id AS delegationId,
            profile_delegation_revision AS profileDelegationRevision,
            registered_capability_revision AS registeredCapabilityRevision,
            registered_effective_profile_policy_hash AS registeredEffectiveProfilePolicyHash,
            registered_registry_enforcement_hash AS registeredRegistryEnforcementHash,
            registered_profile_id AS registeredProfileId
       FROM gateway_approval_bindings WHERE approval_id = ?`,
  ).get(approvalId) as BindingRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Expiry (C2-4, prop 9)
// ---------------------------------------------------------------------------

/**
 * Materialize expiry for ONE approval. Writes no `decided_*`, no
 * `decided_at`, no `context_hash`, and mints no grant -- an expired row's
 * terminal shape is deliberately distinguishable from a decided one
 * (§3.1 "canonical row shapes").
 *
 * `expires_at IS NOT NULL` is load-bearing: a legacy row with NULL expiry
 * must NOT be swept into `expired`. It is inert and reissue-required, which
 * is a different (and honest) operator-facing state.
 */
function materializeExpiry(db: Database.Database, approvalId: string, now: string): number {
  const info = db.prepare(
    `UPDATE tool_approvals SET status='expired'
      WHERE approval_id=? AND status='pending'
        AND expires_at IS NOT NULL AND expires_at<=?`,
  ).run(approvalId, now);
  return Number(info.changes);
}

/**
 * The expiry SWEEP -- owned by this same module, sharing the same writer and
 * the same clock as the decision path (A8). A sweep living in another module
 * would be a second status writer and would break M-1/M-2.
 */
export function sweepExpiredApprovals(db: Database.Database): number {
  const tx = db.transaction(() => {
    const now = canonicalNow(db);
    const info = db.prepare(
      `UPDATE tool_approvals SET status='expired'
        WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?`,
    ).run(now);
    return Number(info.changes);
  });
  return tx.immediate() as number;
}

/** Revoke unconsumed grants that have passed their own TTL (§3.1). */
export function sweepExpiredGrants(db: Database.Database): number {
  const tx = db.transaction(() => {
    const now = canonicalNow(db);
    const info = db.prepare(
      `UPDATE gateway_action_grants SET revoked_at=?
        WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at<=?`,
    ).run(now, now);
    return Number(info.changes);
  });
  return tx.immediate() as number;
}

/**
 * The LEGACY (flag-off) guarded status transition, owned here so that
 * `tool_approvals.status` keeps exactly one writer module (M-1/M-2).
 *
 * This is deliberately the shipped statement, unchanged: the same
 * `WHERE approval_id=? AND status='pending'` predicate that has always
 * given the gateway first-decision-wins and replay-harmlessness. C2 does
 * not alter flag-off behaviour; it only moves the statement so the
 * single-writer claim is mechanically auditable.
 *
 * It writes NO C2 evidence -- no `decided_*`, no `context_hash`, no grant.
 * A flag-off decision has no surface identity to record, and fabricating
 * one would be worse than leaving it null.
 */
export function legacyStatusTransition(
  db: Database.Database,
  approvalId: string,
  status: 'approved' | 'rejected',
): { changes: number } {
  const info = db.prepare(
    `UPDATE tool_approvals
        SET status = ?, decided_at = CURRENT_TIMESTAMP
      WHERE approval_id = ? AND status = 'pending'`,
  ).run(status, approvalId);
  return { changes: Number(info.changes) };
}

// ---------------------------------------------------------------------------
// Registration (C2-2 origin capture + C2-5 binding)
// ---------------------------------------------------------------------------

export interface RegisterC2Params {
  approvalId: string;
  requestId: string;
  toolName: string;
  /** The exact canonicalJson(args) bytes to persist (validated upstream). */
  canonicalArgs: string;
  originPrincipalId: string;
  originSurfaceId: string;
  /** The ten CTXHASH_V1 inputs resolved at registration. */
  contextInput: ContextHashInput;
  binding: {
    delegationId: string;
    profileDelegationRevision: number;
    registeredProfileId: string;
    registeredProfileVersion: number;
    registeredToolRegistryVersion: string;
    registeredEffectiveProfilePolicyHash: string;
    registeredCapabilityRevision: number;
    registeredRegistryEnforcementHash: string;
    registeredPrivacyContextHash: string;
    registeredRoutingContextHash: string;
    registeredSecurityPolicyHash: string;
  };
}

/**
 * Write the C2 registration: canonical origin + expiry on `tool_approvals`,
 * and the immutable binding row. One transaction -- a pending row without
 * its binding would be inert and reissue-required, so creating them
 * separately would manufacture exactly the broken state C2 refuses.
 *
 * The pending row's `decided_*` and `context_hash` stay NULL by
 * construction (§3.1 canonical row shapes).
 */
export function registerC2Approval(db: Database.Database, params: RegisterC2Params): void {
  const tx = db.transaction(() => {
    const now = canonicalNow(db);
    const expiresAt = addSeconds(now, APPROVAL_TTL_SECONDS);
    db.prepare(
      `INSERT INTO tool_approvals
         (approval_id, request_id, tool_name, args_json, status,
          origin_principal_id, origin_surface_id, expires_at)
       VALUES (?,?,?,?, 'pending', ?,?,?)`,
    ).run(
      params.approvalId, params.requestId, params.toolName, params.canonicalArgs,
      params.originPrincipalId, params.originSurfaceId, expiresAt,
    );
    db.prepare(
      `INSERT INTO gateway_approval_bindings
         (approval_id, request_id, action_hash_version, action_hash, canonical_args_hash,
          registration_context_hash, delegation_id, profile_delegation_revision,
          registered_profile_id, registered_profile_version, registered_tool_registry_version,
          registered_effective_profile_policy_hash, registered_capability_revision,
          registered_registry_enforcement_hash, registered_privacy_context_hash,
          registered_routing_context_hash, registered_security_policy_hash)
       VALUES (?,?, 'ACTIONHASH_V1', ?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      params.approvalId, params.requestId,
      actionHash(params.requestId, params.toolName, params.canonicalArgs),
      // canonical_args_hash: a digest of the arg bytes alone, so a card or
      // audit can compare argument identity without the surrounding context.
      createHash('sha256').update(Buffer.from(params.canonicalArgs, 'utf8')).digest('hex'),
      contextHash(params.contextInput),
      params.binding.delegationId, params.binding.profileDelegationRevision,
      params.binding.registeredProfileId, params.binding.registeredProfileVersion,
      params.binding.registeredToolRegistryVersion,
      params.binding.registeredEffectiveProfilePolicyHash,
      params.binding.registeredCapabilityRevision,
      params.binding.registeredRegistryEnforcementHash,
      params.binding.registeredPrivacyContextHash,
      params.binding.registeredRoutingContextHash,
      params.binding.registeredSecurityPolicyHash,
    );
  });
  tx.immediate();
}

// ---------------------------------------------------------------------------
// Decision (C2-2 evidence, C2-3 authority, C2-4 expiry, C2-8 grant)
// ---------------------------------------------------------------------------

export interface DecideC2Params {
  approvalId: string;
  decision: 'APPROVE' | 'REJECT';
  /** The CURRENT deciding connection -- server-derived, never from a frame. */
  decidingPrincipalId: string;
  decidingSurfaceId: string;
  /** Recompute of the ten CTXHASH inputs from CURRENT state (§3.4.2 step 2). */
  currentContext: ContextHashInput;
  /** Server-allocated dispatch request id; its tasks row is created by `mintDispatchTask`. */
  dispatchRequestId: string;
  /** Creates the re-minted tasks row inside the winning transaction. */
  mintDispatchTask: (dispatchRequestId: string) => void;
}

export interface DecidedC2Approval {
  approvalId: string;
  requestId: string;
  toolName: string;
  status: 'approved' | 'rejected';
  grantId: string | null;
  dispatchRequestId: string | null;
  contextHash: string;
}

/**
 * The ONE decision seam. Returns the decided row only when THIS call
 * transitioned it; throws an explicit ApprovalDecisionError on refusal, and
 * returns null when the row is unknown or already decided (preserving the
 * shipped replay-harmless contract, property 4).
 *
 * Every authority/context check happens INSIDE the transaction, so what is
 * checked and what is written share one serialization interval (§1.4).
 */
export function decideC2Approval(
  db: Database.Database,
  params: DecideC2Params,
): DecidedC2Approval | null {
  // ── step 2, HOISTED OUT OF THE DECISION TRANSACTION ──
  //
  // Expiry is materialized in its OWN committed transaction, before the
  // decision transaction opens. It has to be: a refusal below is signalled
  // by throwing, which rolls the whole transaction back -- and that would
  // also roll back the `expired` write, leaving a past-deadline row
  // sitting at `pending` forever, re-refusing on every attempt without
  // ever reaching its terminal state.
  //
  // Splitting them is safe precisely BECAUSE both halves live in this one
  // module and share the same predicates: expiry writes no decision
  // evidence and mints no grant, so a crash between the two commits leaves
  // a correctly-expired row and nothing else. The decision's own guarded
  // predicate (`status='pending' AND expires_at>now`) then refuses on its
  // own terms.
  const expiryTx = db.transaction(() => {
    const now = canonicalNow(db);
    const approval = readApproval(db, params.approvalId);
    if (!approval || approval.status !== 'pending') return false;
    return materializeExpiry(db, params.approvalId, now) > 0;
  });
  if (expiryTx.immediate() === true) {
    throw new ApprovalDecisionError('approval-expired', 'approval expired before this decision');
  }

  const tx = db.transaction(() => {
    // ── step 1: one clock for the whole transaction ──
    const now = canonicalNow(db);

    const approval = readApproval(db, params.approvalId);
    if (!approval) return null;                       // unknown -> replay-harmless null
    if (approval.status !== 'pending') return null;   // already decided -> null (prop 4)

    // A legacy (pre-C2) row has no finite deadline and no binding. Under
    // flag-on it is INERT: never silently actionable, never swept to
    // 'expired' -- it must be reissued. This is an honest distinct state.
    const binding = readBinding(db, params.approvalId);
    if (approval.expiresAt === null || binding === null) {
      throw new ApprovalDecisionError(
        'approval-legacy-reissue-required',
        'approval predates C2 binding/expiry and must be reissued',
      );
    }

    // ── step 3a: CT-2 authority (C2-3) ──
    // Read the LIVE projection: a demotion that committed after this
    // connection opened must bite here. This is the same live-read
    // discipline C1 established at the authz seam, repeated at the writer
    // so the control cannot be bypassed by calling this function directly.
    const deciding: LiveSurfaceSecurity | null = liveSurfaceSecurity(db, params.decidingSurfaceId);
    if (!deciding || deciding.surfaceRole !== 'operator') {
      throw new ApprovalDecisionError(
        'surface-not-operator',
        'deciding surface is not a live operator-role surface (CT-2)',
      );
    }
    if (CHANNEL_KINDS.has(deciding.surfaceKind)) {
      throw new ApprovalDecisionError(
        'cross-channel-approval-forbidden',
        'channel/automation surfaces can never decide approvals (CT-2)',
      );
    }
    if (!holdsAuthority(db, params.decidingSurfaceId, 'approve')) {
      throw new ApprovalDecisionError(
        'authority-denied',
        'deciding surface holds no live current-epoch approve authority',
      );
    }

    // ── step 3b: structural self-approve refusal (prop 1, §3.5) ──
    // Defined structurally: same surface as origin AND that surface is
    // channel/automation. An OPERATOR-role surface approving a task it
    // originated is the ordinary single-operator case and is allowed.
    if (
      approval.originSurfaceId !== null
      && approval.originSurfaceId === params.decidingSurfaceId
    ) {
      const origin = liveSurfaceSecurity(db, approval.originSurfaceId);
      if (origin === null || origin.surfaceRole !== 'operator' || CHANNEL_KINDS.has(origin.surfaceKind)) {
        throw new ApprovalDecisionError(
          'channel-self-approve-refused',
          'a channel/automation surface may not approve a task it originated (prop 1)',
        );
      }
    }

    // ── step 3c: registration -> decision context comparison (C2-5) ──
    const currentDigest = contextHash(params.currentContext);
    if (currentDigest !== binding.registrationContextHash) {
      throw new ApprovalDecisionError(
        'approval-context-invalidated',
        'execution context changed between registration and decision (prop 10, C2 part)',
      );
    }

    // ── step 3d: the immutable delegation must still be live ──
    const delegation = delegationById(db, binding.delegationId);
    if (
      delegation === null
      || delegation.revokedAt !== null
      || delegation.profileDelegationRevision !== binding.profileDelegationRevision
      || delegation.effectiveProfilePolicyHash !== binding.registeredEffectiveProfilePolicyHash
      || delegation.registryEnforcementHash !== binding.registeredRegistryEnforcementHash
    ) {
      throw new ApprovalDecisionError(
        'profile-delegation-stale',
        'the profile delegation this approval was registered against is no longer live',
      );
    }
    if (deciding.capabilityRevision !== binding.registeredCapabilityRevision) {
      throw new ApprovalDecisionError(
        'capability-revision-stale',
        'capability revision changed since registration',
      );
    }

    // ── step 3e: the guarded status transition + evidence, one statement ──
    const status = params.decision === 'APPROVE' ? 'approved' : 'rejected';
    const info = db.prepare(
      `UPDATE tool_approvals
          SET status=?, decided_at=?, decided_principal_id=?, decided_surface_id=?, context_hash=?
        WHERE approval_id=? AND status='pending'
          AND expires_at IS NOT NULL AND expires_at>?`,
    ).run(
      status, now, params.decidingPrincipalId, params.decidingSurfaceId, currentDigest,
      params.approvalId, now,
    );
    // Zero changes means a concurrent writer won the race. The loser
    // observes the winner and does nothing (props 3, 4).
    if (info.changes === 0) return null;

    // ── step 3f: APPROVE alone mints exactly ONE grant (C2-8) ──
    let grantId: string | null = null;
    if (params.decision === 'APPROVE') {
      // The re-minted tasks row is created INSIDE this transaction so the
      // grant's FK to it is satisfiable and so a rollback takes both away.
      params.mintDispatchTask(params.dispatchRequestId);
      grantId = randomUUID();
      const authorityGrant = db.prepare(
        `SELECT grant_id AS grantId FROM surface_authorities
          WHERE surface_id=? AND authority='approve' AND revoked_at IS NULL AND auth_epoch=?`,
      ).get(params.decidingSurfaceId, deciding.authEpoch) as { grantId: string } | undefined;

      const originSecurity = approval.originSurfaceId
        ? liveSurfaceSecurity(db, approval.originSurfaceId)
        : null;

      db.prepare(
        `INSERT INTO gateway_action_grants
           (grant_id, approval_id, source_request_id, dispatch_request_id, tool_name,
            action_hash, context_hash, origin_surface_id, deciding_surface_id,
            origin_auth_epoch, deciding_auth_epoch, origin_capability_revision,
            delegation_id, profile_delegation_revision, deciding_authority_grant_id,
            effective_profile_policy_hash, registry_enforcement_hash, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        grantId, params.approvalId, approval.requestId, params.dispatchRequestId,
        approval.toolName, binding.actionHash, currentDigest,
        approval.originSurfaceId ?? '', params.decidingSurfaceId,
        originSecurity?.authEpoch ?? deciding.authEpoch, deciding.authEpoch,
        originSecurity?.capabilityRevision ?? deciding.capabilityRevision,
        binding.delegationId, binding.profileDelegationRevision,
        authorityGrant?.grantId ?? '',
        delegation.effectiveProfilePolicyHash, delegation.registryEnforcementHash,
        // Grant TTL is measured from the DECISION clock and is NEVER copied
        // from the approval's own deadline (§3.1) -- they answer different
        // questions and have different lengths.
        addSeconds(now, GRANT_TTL_SECONDS), now,
      );
    }

    return {
      approvalId: params.approvalId,
      requestId: approval.requestId,
      toolName: approval.toolName,
      status: status as 'approved' | 'rejected',
      grantId,
      dispatchRequestId: params.decision === 'APPROVE' ? params.dispatchRequestId : null,
      contextHash: currentDigest,
    } satisfies DecidedC2Approval;
  });
  return tx.immediate() as DecidedC2Approval | null;
}
