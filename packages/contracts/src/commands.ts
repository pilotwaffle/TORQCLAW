import { z } from 'zod';

/** Dumb client, smart server: the ONLY judgment calls the client makes
 *  are things only the user can know. */
export const ClientCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('SUBMIT_PROMPT'),
    prompt: z.string().min(1).max(32_000),
    sensitive: z.boolean().default(false),
    urgent: z.boolean().default(false),
    attachmentIds: z.array(z.string()).default([]),
    // User judgments only the user can make — budget, where it may run.
    maxCostUsd: z.number().min(0).max(100).optional(),
    executionMode: z.enum(['AUTO', 'LOCAL_ONLY', 'CLOUD_OK']).default('AUTO'),
    // P4.5: when false, enrich skips memory recall for this task (no past
    // context assembled). Default true = normal tiered-memory behavior.
    useMemory: z.boolean().default(true),
  }),
  z.object({
    action: z.literal('APPROVE_SKILL'),
    queueId: z.string(),
    decision: z.enum(['APPROVE', 'REJECT']),
    // P4: approve-with-edits. Operator-edited SKILL.md to write instead of the
    // draft. APPROVE only (a REJECT discards). Capped to keep frames sane.
    editedMarkdown: z.string().max(100_000).optional(),
  }),
  z.object({
    // P4: fetch a skill draft's full markdown when it was too large (>8KB) to
    // ride along in the PENDING_APPROVAL event metadata.
    action: z.literal('GET_SKILL_DRAFT'),
    queueId: z.string(),
  }),
  z.object({
    // P2: decide a one-time tool grant. Carries NO tool name — the granted
    // tool is read server-side from the approval row, so a client can never
    // widen the grant. decision APPROVE re-runs; REJECT aborts with an ERROR.
    action: z.literal('APPROVE_TOOL'),
    approvalId: z.string(),
    decision: z.enum(['APPROVE', 'REJECT']),
  }),
  z.object({
    action: z.literal('CANCEL_TASK'),
    taskId: z.uuid(),
  }),
  z.object({
    // P4.5: memory controls. SHOW lists this session's episodes; FORGET_SESSION
    // deletes them (+ FTS entries via the delete triggers).
    action: z.literal('MEMORY'),
    op: z.enum(['SHOW', 'FORGET_SESSION']),
  }),
  z.object({
    // TCLAW-4B: list this session's run receipts (summary columns only).
    // Session-scoped by the connection's own sid on the server side — there is
    // deliberately NO sessionId param here, which closes foreign-session reads
    // by construction (a client cannot even ask for another session's list).
    action: z.literal('LIST_RECEIPTS'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    // TCLAW-4B: fetch one receipt (+ optionally its evidence events) by task.
    // taskId = gateway request_id, same field type as CANCEL_TASK.taskId.
    action: z.literal('GET_RECEIPT'),
    taskId: z.uuid(),
    includeEvents: z.boolean().default(false),
  }),
  z.object({
    // TCLAW-1B: read-only Cost Control Center summary for this session.
    // Session-scoped by construction (NO sessionId param — server passes the
    // connection's own sid), exactly like LIST_RECEIPTS. recentLedger is a
    // preview window only; authoritative totals come from the backend SUMs.
    action: z.literal('GET_COST_SUMMARY'),
    recentLimit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    // TCLAW-2D-1: read-only route preview ("simulate this route"). Runs the
    // REAL enrichment (classifier + memory-derived contextSize + predictTools)
    // and the REAL router.evaluateRequest at compose time, WITHOUT dispatching:
    // no task, no persisted event, no TIER_SELECTED, no receipt, no spend.
    // Mirrors SUBMIT_PROMPT's judgment fields exactly (field-parity keeps a
    // future shared composer field-mapper honest); deliberately NO sessionId
    // (session-scoped by the connection's own sid) and NO attachmentIds
    // (enrichment never reads them). previewOf is a client nonce echoed back
    // verbatim so the UI can bind responses to draft instances (stale/edit-back
    // safety) — it is never persisted.
    action: z.literal('PREVIEW_ROUTE'),
    previewOf: z.string().min(1).max(128),
    prompt: z.string().min(1).max(32_000),
    sensitive: z.boolean().default(false),
    urgent: z.boolean().default(false),
    maxCostUsd: z.number().min(0).max(100).optional(),
    executionMode: z.enum(['AUTO', 'LOCAL_ONLY', 'CLOUD_OK']).default('AUTO'),
    useMemory: z.boolean().default(true),
  }),
  z.object({
    // TCLAW-5A-1: list this session's tool-approval history — summary columns
    // ONLY (approvalId/requestId/toolName/status/createdAt/decidedAt); there is
    // deliberately NO args payload per row (proposed args are display/audit-only
    // and can be large — the drill-down is the existing GET_RECEIPT, whose
    // replayed PENDING_APPROVAL event carries them, oversize-guarded).
    // Session-scoped by construction: NO sessionId param — the server always
    // passes the connection's own sid, exactly like LIST_RECEIPTS. This is a
    // pure read surface: it can never decide, expire, or re-dispatch an
    // approval (the ONLY decide path remains APPROVE_TOOL). status values are
    // the raw persisted three states — there is no 'expired' (no TTL exists)
    // and no actor (no actor column exists); absent facts are never fabricated.
    action: z.literal('LIST_APPROVALS'),
    limit: z.number().int().min(1).max(100).default(20),
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
  }),
  z.object({
    // TCLAW-5B-1: server-redacted diagnostic export for ONE receipt. The ONLY
    // path that emits redacted material — redaction runs in the gateway
    // (packages/gateway/src/export.ts), never assembled client-side. taskId =
    // gateway request_id, same field type as GET_RECEIPT/CANCEL_TASK.
    // Deliberately NO sessionId param (a client can never even ask for
    // another session's export; ownership is re-checked server-side against
    // the owning session regardless). Deliberately NO includeEvents — event
    // replay is categorically omitted from this export, not merely
    // size-guarded like GET_RECEIPT's. Deliberately NO format param — this
    // command always returns one canonical JSON artifact; a Markdown
    // projection (if any) is a pure client-side rendering of that JSON only.
    action: z.literal('GET_SAFE_EXPORT'),
    taskId: z.uuid(),
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

/** First frame on every connection — no anonymous sockets.
 *  sessionId present = resume; absent = create. Sessions outlive sockets. */
export const ConnectFrameSchema = z.object({
  role: z.enum(['operator', 'channel', 'node']),
  token: z.string(),
  sessionId: z.uuid().optional(),
  clientInfo: z.object({ name: z.string(), version: z.string() }),
});
export type ConnectFrame = z.infer<typeof ConnectFrameSchema>;
