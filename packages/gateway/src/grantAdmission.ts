/**
 * C2-8 — the ONE pre-tool-execution admission seam.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §1.4 (controlling invariant), §3.3 props
 * 11/12, §3.12, §3.4.2 step 4-5, §8 C2-8.
 *
 * THE CONTROLLING INVARIANT, IN ONE PLACE
 * ----------------------------------------
 * "A command may cause direct external work only when ... one unconsumed
 * exact-action grant validate[s] in the same canonical state.db
 * serialization interval at the actual pre-tool-execution seam immediately
 * before dispatch_started."
 *
 * Task-level dispatch is too early: the model-generated arguments do not
 * exist yet. So every executor must call `admitToolCall` with the ACTUAL
 * `(tool, args)` immediately before the side effect. Missing, mismatched,
 * consumed, revoked, or expired grant => no side effect.
 *
 * WHY CONSUMPTION AND THE CHECK SHARE ONE TRANSACTION
 * ---------------------------------------------------
 * The revocation/dispatch race has exactly one legal outcome per side:
 * whichever commits first wins and the loser observes it. If the check and
 * the consume were separate transactions, a revocation could land between
 * them and the executor would proceed on a grant that no longer existed.
 * The single `UPDATE ... WHERE consumed_at IS NULL AND revoked_at IS NULL
 * AND expires_at > now` is both the check and the consumption: SQLite
 * reports `changes === 1` only for the transaction that actually won it.
 *
 * ONE-SHOT IS THE ONLY GRANT THAT EXISTS HERE (property 11, OQ-3)
 * ----------------------------------------------------------------
 * There is exactly one grant per approval (`approval_id UNIQUE`) and it is
 * consumed once. There is no grant TYPE parameter anywhere in this module,
 * no durable/session scope, and no enum a future caller could widen. The
 * durable per-session grant option that property 11 prohibits would
 * require a new primitive with its own threat model; it is deliberately
 * absent, not merely unused.
 *
 * The prohibited literal itself is kept OUT of this file on purpose: the
 * §10 rule lints the shipped implementation/config surface for its
 * ABSENCE, and a doc comment quoting it would trip that lint for the one
 * reason the corrected rule says it should not. The prohibition is
 * DOCUMENTED in the PRD; this module's job is simply never to offer it.
 */

import type Database from 'better-sqlite3';
import { actionHash, validateAndCanonicalizeArgs } from './approvalContext.js';
import { liveSurfaceSecurity, delegationById } from './surfaceSecurity.js';

/** Every reason admission can refuse. All are explicit (§6.8). */
export type AdmissionRefusal =
  | 'grant-missing'
  | 'grant-consumed'
  | 'grant-revoked'
  | 'grant-expired'
  | 'action-binding-mismatch'
  | 'profile-delegation-stale'
  | 'authority-epoch-stale'
  | 'frontier-structured-grant-unavailable'
  | 'args-invalid';

export type AdmissionResult =
  | { ok: true; grantId: string; toolName: string }
  | { ok: false; reason: AdmissionRefusal; detail: string };

/**
 * Execution paths that may reach this seam.
 *
 * FRONTIER is listed so it can be REFUSED by name rather than by omission
 * -- see `admitToolCall`.
 */
export type ExecutionPath = 'LOCAL_EDGE' | 'BRIDGE' | 'FRONTIER';

export interface AdmitParams {
  /** The re-minted dispatch request whose grant this is. */
  dispatchRequestId: string;
  /** The ACTUAL namespaced tool about to execute. */
  toolName: string;
  /** The ACTUAL model-generated arguments, unvalidated. */
  args: unknown;
  /** Which executor is asking. FRONTIER fails closed (see below). */
  path: ExecutionPath;
}

function canonicalNow(db: Database.Database): string {
  const row = db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f','now') AS now`).get() as { now: string };
  return row.now;
}

/**
 * PRE-REGISTERED OBLIGATION 5 / PRD §1.4 final bullet, §3.4.2 step 5.
 *
 * FRONTIER grants by tool NAME today and its Hermes approval hook does not
 * inspect arguments, so it cannot satisfy the exact-action invariant: it
 * has no way to prove the arguments about to execute are the arguments
 * that were approved. The PRD is explicit that until a separately
 * authorized structured grant/check/consume protocol exists at the Hermes
 * pre-tool-call hook, "FRONTIER approval under the flag fails closed".
 *
 * Failing closed here rather than silently not-checking is the whole
 * point: an unchecked path that quietly proceeds is indistinguishable from
 * a checked one right up until it is not.
 */
function refuseFrontier(): AdmissionResult {
  return frontierGrantRefusal();
}

/**
 * The SINGLE source of the FRONTIER refusal, exported so the executor
 * fence in `dispatch.ts` and this admission seam cannot drift apart.
 *
 * G2A D-2: in the first C2 build `refuseFrontier` was reachable only
 * through `admitToolCall`, which the FRONTIER path never calls -- so it
 * was dead code, the tier was unwired-and-OPEN, and the SCOPE doc's
 * "explicitly fail-closed" claim was false as a runtime statement. Both
 * fences now return this one value, and both are pinned by tests.
 */
export function frontierGrantRefusal(): {
  ok: false; reason: AdmissionRefusal; detail: string;
} {
  return {
    ok: false,
    reason: 'frontier-structured-grant-unavailable',
    detail:
      'FRONTIER has no args-aware structured grant protocol at the Hermes '
      + 'pre-tool-call hook; the exact-action invariant cannot be satisfied, '
      + 'so this path fails closed until that protocol is separately authorized',
  };
}

/**
 * Validate and CONSUME the one-shot grant for the actual tool call.
 *
 * Returns `{ ok: true }` only when this transaction consumed the grant.
 * Every other outcome is an explicit refusal and NO side effect may follow.
 */
export function admitToolCall(db: Database.Database, params: AdmitParams): AdmissionResult {
  // Fail closed BEFORE touching any state: FRONTIER may not consume a
  // grant it cannot honestly validate.
  if (params.path === 'FRONTIER') return refuseFrontier();

  // The regenerated call is independently validated and canonicalized --
  // never trusted from the stored registration bytes. That independence is
  // what makes the hash comparison meaningful.
  let canonicalArgs: string;
  try {
    canonicalArgs = validateAndCanonicalizeArgs(params.args);
  } catch (err) {
    return { ok: false, reason: 'args-invalid', detail: String(err) };
  }

  const tx = db.transaction((): AdmissionResult => {
    const now = canonicalNow(db);

    const grant = db.prepare(
      `SELECT grant_id AS grantId, approval_id AS approvalId, source_request_id AS sourceRequestId,
              tool_name AS toolName, action_hash AS actionHash, delegation_id AS delegationId,
              profile_delegation_revision AS profileDelegationRevision,
              deciding_surface_id AS decidingSurfaceId, deciding_auth_epoch AS decidingAuthEpoch,
              effective_profile_policy_hash AS effectiveProfilePolicyHash,
              registry_enforcement_hash AS registryEnforcementHash,
              consumed_at AS consumedAt, revoked_at AS revokedAt, expires_at AS expiresAt
         FROM gateway_action_grants WHERE dispatch_request_id = ?`,
    ).get(params.dispatchRequestId) as
      | {
          grantId: string; approvalId: string; sourceRequestId: string; toolName: string;
          actionHash: string; delegationId: string; profileDelegationRevision: number;
          decidingSurfaceId: string; decidingAuthEpoch: number;
          effectiveProfilePolicyHash: string; registryEnforcementHash: string;
          consumedAt: string | null; revokedAt: string | null; expiresAt: string;
        }
      | undefined;

    if (!grant) {
      return { ok: false, reason: 'grant-missing', detail: 'no grant for this dispatch request' };
    }
    if (grant.consumedAt !== null) {
      return { ok: false, reason: 'grant-consumed', detail: 'grant was already consumed (one-shot)' };
    }
    if (grant.revokedAt !== null) {
      return { ok: false, reason: 'grant-revoked', detail: 'grant was revoked' };
    }

    // Expiry is MATERIALIZED, not merely observed: an expired grant is
    // marked revoked and then refused, so it cannot be revived by a later
    // clock skew or a retry (§3.1).
    if (grant.expiresAt <= now) {
      db.prepare(
        `UPDATE gateway_action_grants SET revoked_at=?
          WHERE grant_id=? AND consumed_at IS NULL AND revoked_at IS NULL`,
      ).run(now, grant.grantId);
      return { ok: false, reason: 'grant-expired', detail: 'grant TTL elapsed' };
    }

    // ── the exact-action check (§1.4) ──
    // Recomputed with the SOURCE request id, never the dispatch id: the
    // digest binds the originally approved action, and using the re-minted
    // id would make every regenerated call hash differently.
    const regenerated = actionHash(grant.sourceRequestId, params.toolName, canonicalArgs);
    if (regenerated !== grant.actionHash) {
      return {
        ok: false,
        reason: 'action-binding-mismatch',
        detail: 'the regenerated tool call does not match the approved action',
      };
    }

    // ── property 12: approval never bypasses live policy ──
    const delegation = delegationById(db, grant.delegationId);
    if (
      delegation === null
      || delegation.revokedAt !== null
      || delegation.profileDelegationRevision !== grant.profileDelegationRevision
      || delegation.effectiveProfilePolicyHash !== grant.effectiveProfilePolicyHash
      || delegation.registryEnforcementHash !== grant.registryEnforcementHash
    ) {
      return {
        ok: false,
        reason: 'profile-delegation-stale',
        detail: 'the profile delegation bound to this grant is no longer live',
      };
    }

    // A revocation that committed first must win: the deciding surface's
    // epoch is re-read live here, so a revoke-then-dispatch race has one
    // durable outcome.
    const deciding = liveSurfaceSecurity(db, grant.decidingSurfaceId);
    if (deciding === null || deciding.authEpoch !== grant.decidingAuthEpoch) {
      return {
        ok: false,
        reason: 'authority-epoch-stale',
        detail: 'the deciding surface authority changed after the decision',
      };
    }

    // ── consume: this UPDATE is the check AND the consumption ──
    const info = db.prepare(
      `UPDATE gateway_action_grants SET consumed_at=?
        WHERE grant_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`,
    ).run(now, grant.grantId, now);
    if (Number(info.changes) !== 1) {
      // Another transaction won the race between our read and this write.
      return { ok: false, reason: 'grant-consumed', detail: 'lost the consumption race' };
    }

    return { ok: true, grantId: grant.grantId, toolName: grant.toolName };
  });

  return tx.immediate() as AdmissionResult;
}

/**
 * Recovery (§1.4, §6.6): revoke grants left inert by a crash between
 * decision and admission.
 *
 * It revokes; it never completes, dispatches, or reissues. "A crash after
 * decision/grant but before tool admission never auto-dispatches; recovery
 * revokes the inert grant and requires reissue."
 */
export function revokeInertGrants(db: Database.Database, olderThanSeconds = 0): number {
  const tx = db.transaction(() => {
    const now = canonicalNow(db);
    const cutoff = new Date(Date.parse(`${now.replace(' ', 'T')}Z`) - olderThanSeconds * 1000)
      .toISOString().replace('T', ' ').replace('Z', '');
    const info = db.prepare(
      `UPDATE gateway_action_grants SET revoked_at=?
        WHERE consumed_at IS NULL AND revoked_at IS NULL AND created_at<=?`,
    ).run(now, cutoff);
    return Number(info.changes);
  });
  return tx.immediate() as number;
}
