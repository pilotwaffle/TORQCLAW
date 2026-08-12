/**
 * C2-7 — the `approval_deliveries` PROJECTION and its rebuild.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §3.3 props 5/6, §3.8, §3.13, §7 A10, §8 C2-7.
 *
 * THIS TABLE IS NOT TRUTH (§3.13, modelled on run_receipts)
 * ---------------------------------------------------------
 * A row here is a record of a DELIVERY ATTEMPT, never of a decision. It
 * can be dropped and rebuilt from `tool_approvals` plus current routing at
 * any time without losing approval truth. Two structural consequences the
 * PRD requires, both pinned by tests:
 *
 *   - Property 5: a delivery failure can NEVER become an approval. This
 *     module contains no UPDATE of `tool_approvals` at all -- not a
 *     guarded one, not any. Delivery and decision are separate tables with
 *     separate writers, so there is no code route from one to the other.
 *   - Property 6: an undelivered approval survives disconnect/restart,
 *     because the truth is the `pending` row and the projection is merely
 *     re-derived on reconnect.
 *
 * ELIGIBILITY IS RE-EVALUATED AT REBUILD, NOT REMEMBERED (A10)
 * ------------------------------------------------------------
 * A rebuild targets CURRENT eligible operator surfaces. A surface that has
 * since been revoked, demoted, or had its epoch bumped is not a target any
 * more, so a restart cannot resurrect a card aimed at a surface that lost
 * its authority while the gateway was down.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type DeliveryState = 'pending' | 'delivered' | 'acked' | 'failed';

/** Why no card could be offered. Textual and explicit, never a silent no-op. */
export const NO_ELIGIBLE_SURFACE = 'no-eligible-operator-surface';
export const DELIVERY_FAILED = 'delivery-failed';

export interface DeliveryRow {
  id: string;
  approvalId: string;
  targetSurfaceId: string;
  deliveryState: DeliveryState;
}

/**
 * The surfaces a card may currently be routed to: live, active,
 * operator-role, non-channel, and holding a current-epoch `approve` grant.
 *
 * Holding the AUTHORITY is part of eligibility on purpose. Delivering a
 * decision card to a surface that could not act on it is not merely
 * useless -- it invites an operator to believe an approval is actionable
 * from somewhere it is not.
 */
export function eligibleOperatorSurfaces(db: Database.Database): string[] {
  const rows = db.prepare(
    `SELECT s.surface_id AS surfaceId
       FROM gateway_surface_security s
       JOIN surface_authorities a
         ON a.surface_id = s.surface_id
        AND a.authority = 'approve'
        AND a.revoked_at IS NULL
        AND a.auth_epoch = s.auth_epoch
      WHERE s.state = 'active'
        AND s.surface_role = 'operator'
        AND s.surface_kind NOT IN ('telegram','slack','automation')
      ORDER BY s.surface_id`,
  ).all() as { surfaceId: string }[];
  return rows.map((r) => r.surfaceId);
}

/** Record a delivery attempt. Projection-only; touches no approval state. */
export function recordDelivery(
  db: Database.Database,
  approvalId: string,
  targetSurfaceId: string,
  state: DeliveryState = 'pending',
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO approval_deliveries (id, approval_id, target_surface_id, delivery_state)
     VALUES (?,?,?,?)`,
  ).run(id, approvalId, targetSurfaceId, state);
  return id;
}

/**
 * Advance a delivery attempt's state. Returns rows changed.
 *
 * Note what this CANNOT do: there is no branch here, and no branch
 * anywhere in this module, that writes `tool_approvals`. A delivery that
 * fails marks itself `failed` and stops. That is property 5 as a
 * structural fact rather than a promise.
 */
export function markDelivery(
  db: Database.Database,
  deliveryId: string,
  state: DeliveryState,
): number {
  const info = db.prepare(
    `UPDATE approval_deliveries SET delivery_state=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).run(state, deliveryId);
  return Number(info.changes);
}

/** The currently actionable delivery view for one surface. */
export function actionableForSurface(db: Database.Database, surfaceId: string): DeliveryRow[] {
  return db.prepare(
    `SELECT d.id, d.approval_id AS approvalId, d.target_surface_id AS targetSurfaceId,
            d.delivery_state AS deliveryState
       FROM approval_deliveries d
       JOIN tool_approvals a ON a.approval_id = d.approval_id
      WHERE d.target_surface_id = ?
        AND a.status = 'pending'
      ORDER BY d.created_at, d.id`,
  ).all(surfaceId) as DeliveryRow[];
}

export interface RebuildResult {
  /** Delivery rows created for currently-pending approvals. */
  created: number;
  /** Pending approvals that could not be routed anywhere. */
  unroutable: string[];
  /** Textual reason when nothing could be routed (§6.8). */
  reason: string | null;
}

/**
 * Drop and regenerate the CURRENT actionable delivery view (§3.13, A10).
 *
 * Rebuild is the whole reason this table is allowed to exist: because the
 * view is reconstructible, losing it costs nothing. Historical transport
 * attempts/acks are observability only and are explicitly NOT required to
 * reproduce byte-identically -- they cannot authorize a decision, so their
 * loss is not a correctness event.
 *
 * Approval truth is untouched: a pending approval with no eligible target
 * stays canonically `pending` until its ordinary expiry, and the caller is
 * told `no-eligible-operator-surface` rather than being handed a silent
 * success.
 */
export function rebuildDeliveryProjection(db: Database.Database): RebuildResult {
  const tx = db.transaction(() => {
    // Safe because this is a projection, never truth.
    db.prepare('DELETE FROM approval_deliveries').run();

    const targets = eligibleOperatorSurfaces(db);
    const pending = db.prepare(
      `SELECT approval_id AS approvalId FROM tool_approvals
        WHERE status='pending' ORDER BY created_at, rowid`,
    ).all() as { approvalId: string }[];

    let created = 0;
    const unroutable: string[] = [];
    for (const { approvalId } of pending) {
      if (targets.length === 0) { unroutable.push(approvalId); continue; }
      for (const surfaceId of targets) { recordDelivery(db, approvalId, surfaceId); created += 1; }
    }
    return {
      created,
      unroutable,
      reason: unroutable.length > 0 ? NO_ELIGIBLE_SURFACE : null,
    } satisfies RebuildResult;
  });
  return tx.immediate() as RebuildResult;
}
