import { randomUUID } from 'node:crypto';
import { db } from './storage.js';
import { publishOnly } from './events.js';

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

// ── TCLAW-5A-1: read-only surface (SELECT-only, zero writes) ────────────────
//
// server.ts's /ws command switch delegates LIST_APPROVALS here verbatim — the
// switch calls handleListApprovals, there is NO parallel copy of this logic
// anywhere. Lives in this module (not inline in server.ts) so tests can drive
// the exact production handler path headlessly, mirroring receipts.ts's
// LIST_RECEIPTS/GET_RECEIPT discipline.
//
// CRITICAL read-only invariant: this handler does ZERO writes — no INSERT,
// no UPDATE, no DELETE, no taskStore, no registerApproval/decideApproval, no
// dispatch, no persisted emit. It only SELECTs (listApprovals) and
// publishOnly (which never INSERTs — see events.ts). Nothing in this path can
// reach decideApproval; the ONLY way to decide an approval remains the
// existing APPROVE_TOOL case in server.ts.

/** Summary shape returned by LIST_APPROVALS. Deliberately excludes args_json —
 *  the list view must never carry per-row proposed-args payloads (RC-6); the
 *  drill-down for full args is the existing GET_RECEIPT replay. */
export interface ApprovalSummary {
  approvalId: string;
  requestId: string;
  toolName: string;
  /** Raw persisted value: 'pending' | 'approved' | 'rejected'. No 'expired'
   *  exists (no TTL column); display copy (e.g. "denied") is UI work. */
  status: string;
  createdAt: string;
  /** null while pending — an honest null, never a fabricated timestamp. */
  decidedAt: string | null;
}

interface ApprovalSummaryRow {
  approval_id: string;
  request_id: string;
  tool_name: string;
  status: string;
  created_at: string;
  decided_at: string | null;
}

// Both statements INNER JOIN tasks for ownership: an approval whose
// request_id has no tasks row has unprovable session ownership and must never
// be listed (fail-closed, G1R invariant 7). Ordered deterministically
// newest-first; rowid tiebreaks same-second created_at values (created_at is
// only second-resolution).
const selectSessionApprovals = db.prepare(`
  SELECT a.approval_id, a.request_id, a.tool_name, a.status, a.created_at, a.decided_at
    FROM tool_approvals a
    JOIN tasks t ON t.request_id = a.request_id
   WHERE t.session_id = ?
   ORDER BY a.created_at DESC, a.rowid DESC
   LIMIT ?
`);

const selectSessionApprovalsByStatus = db.prepare(`
  SELECT a.approval_id, a.request_id, a.tool_name, a.status, a.created_at, a.decided_at
    FROM tool_approvals a
    JOIN tasks t ON t.request_id = a.request_id
   WHERE t.session_id = ? AND a.status = ?
   ORDER BY a.created_at DESC, a.rowid DESC
   LIMIT ?
`);

/** LIST_APPROVALS backing query: SELECT-only, summary columns, this session
 *  only (proven via INNER JOIN on tasks — no orphan approval row is ever
 *  listable). NULLs are passed through as-is (no-fabrication discipline
 *  mirrors receipts.ts's listReceipts). */
export function listApprovals(
  sessionId: string,
  limit: number,
  status?: 'pending' | 'approved' | 'rejected',
): ApprovalSummary[] {
  const rows = (
    status
      ? selectSessionApprovalsByStatus.all(sessionId, status, limit)
      : selectSessionApprovals.all(sessionId, limit)
  ) as ApprovalSummaryRow[];
  return rows.map((r) => ({
    approvalId: r.approval_id,
    requestId: r.request_id,
    toolName: r.tool_name,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
  }));
}

/** The LIST_APPROVALS handler body. Session-scoped by construction — the
 *  command carries no sessionId param, and server.ts always passes the
 *  CONNECTION's own sid, never a client-supplied value, so a caller can never
 *  list another session's approvals. Read-only: SELECT + publishOnly, zero
 *  writes; nothing here can reach decideApproval. */
export function handleListApprovals(
  sessionId: string,
  limit: number,
  status?: 'pending' | 'approved' | 'rejected',
): void {
  const approvals = listApprovals(sessionId, limit, status);
  publishOnly(sessionId, {
    message: 'Approvals listed',
    metadata: { approvalList: true, approvals },
  });
}
