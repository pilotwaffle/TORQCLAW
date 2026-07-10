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
