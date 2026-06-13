import { randomUUID } from 'node:crypto';
import { db } from './storage.js';

/** A decided approval row, with everything the re-mint / reject needs. */
export interface DecidedApproval {
  approvalId: string;
  requestId: string;
  toolName: string;        // the grant unit (real, namespaced tool name)
  status: 'approved' | 'rejected';
  /** The full original GatewayRequest JSON of the blocked task (tasks.request_json),
   *  so APPROVE can mint a faithful re-run and REJECT can build recovery copy. */
  requestJson: string | null;
}

/**
 * Register a gated-tool hit. Called ONLY by dispatch (which owns the DB);
 * inference signals via a thrown ToolApprovalRequired and never touches this.
 * args is stored for the card / audit — it is display-only and never replayed.
 * Returns the approvalId the gateway puts in the terminal PENDING_APPROVAL.
 */
export function registerApproval(
  requestId: string,
  toolName: string,
  args: unknown,
): string {
  const approvalId = randomUUID();
  db.prepare(
    `INSERT INTO tool_approvals (approval_id, request_id, tool_name, args_json, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(approvalId, requestId, toolName, JSON.stringify(args ?? null));
  return approvalId;
}

/**
 * Decide an approval. Idempotency + exactly-once live in the guarded UPDATE:
 * `WHERE status='pending'` means a double-click / replayed APPROVE_TOOL changes
 * nothing on the second pass. better-sqlite3 is synchronous, so this single
 * statement is atomic — two near-simultaneous APPROVE frames cannot both
 * transition the row, so at most ONE re-dispatch can ever fire (invariant 7:
 * no duplicate side-effecting re-run of a write tool).
 *
 * Returns the decided row (joined with the blocked task's request_json) ONLY
 * when THIS call transitioned it; returns null if unknown OR already-decided.
 */
export function decideApproval(
  approvalId: string,
  decision: 'APPROVE' | 'REJECT',
): DecidedApproval | null {
  const status = decision === 'APPROVE' ? 'approved' : 'rejected';
  const info = db.prepare(
    `UPDATE tool_approvals
        SET status = ?, decided_at = CURRENT_TIMESTAMP
      WHERE approval_id = ? AND status = 'pending'`,
  ).run(status, approvalId);

  if (info.changes === 0) return null; // unknown or already-decided

  const row = db.prepare(
    `SELECT a.request_id, a.tool_name, a.status, t.request_json
       FROM tool_approvals a
       LEFT JOIN tasks t ON t.request_id = a.request_id
      WHERE a.approval_id = ?`,
  ).get(approvalId) as {
    request_id: string; tool_name: string; status: string; request_json: string | null;
  };

  return {
    approvalId,
    requestId: row.request_id,
    toolName: row.tool_name,
    status: row.status as 'approved' | 'rejected',
    requestJson: row.request_json,
  };
}
