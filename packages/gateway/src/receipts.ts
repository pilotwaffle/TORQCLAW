import { randomUUID } from 'node:crypto';
import { db } from './storage.js';

/**
 * TCLAW-4A: run receipt projection.
 *
 * A run_receipts row is a DETERMINISTIC PROJECTION computed purely from
 * already-persisted rows (tasks, events, tool_approvals) for ONE task
 * (request_id). It reads NO in-memory state and fabricates NOTHING: every
 * column is either a real persisted value or NULL. The event log + tasks
 * table remain the source of truth; run_receipts is a derived, rebuildable
 * read cache (see rebuildAll / ops/receipts-rebuild.mjs) — dropping and
 * re-projecting it must reproduce byte-identical content (see
 * tests/receipt-projection.test.ts).
 *
 * Gateway-DB-only: this is NOT an emitted contract in the schema-drift-gated
 * sense (no dedicated JSON Schema in packages/contracts). TCLAW-4B exposes it
 * read-only via the LIST_RECEIPTS/GET_RECEIPT ClientCommands, which carry
 * receipt content back to the client as untyped SYSTEM-event metadata (an
 * inert `unknown` payload per GatewayEventSchema) — it is no longer accurate
 * to say a run_receipts row is "never sent over the wire", only that it is
 * still not a typed emitted contract of its own.
 */
export const PROJECTION_VERSION = 1;

export interface ReceiptRow {
  id: string;
  task_id: string;
  session_id: string;
  source_channel: string | null;
  selected_tier: string | null;
  route_diagnostics_json: string | null;
  budget_limit: number | null;
  budget_source: string | null;
  cost_usd: number | null;
  cost_enforceable: number | null;
  elapsed_ms: number | null;
  iterations: number | null;
  tools_called_json: string;
  cancelled: number | null;
  blocked_on: string | null;
  memory_used: number | null;
  context_chars: number | null;
  result_state: string | null;
  safe_export_json: string | null;
  full_receipt_json: string;
  evidence_start_seq: number | null;
  evidence_end_seq: number | null;
  projection_version: number;
}

interface TaskRow {
  request_id: string;
  session_id: string;
  tier: string;
  router_reason: string;
  state: string;
  request_json: string;
  result: string | null;
  error: string | null;
  telemetry_json: string | null;
}

interface EventRow {
  seq: number;
  type: string;
  message: string;
  metadata: string | null;
}

interface ApprovalRow {
  status: string;
  tool_name: string;
  decided_at: string | null;
}

const selectTask = db.prepare(`SELECT * FROM tasks WHERE request_id = ?`);
const selectFirstTierSelected = db.prepare(
  `SELECT metadata FROM events WHERE request_id = ? AND type = 'TIER_SELECTED' ORDER BY seq ASC LIMIT 1`,
);
const selectToolCalls = db.prepare(
  `SELECT seq, type, message, metadata FROM events WHERE request_id = ? AND type = 'TOOL_CALL' ORDER BY seq ASC`,
);
const selectEvidenceRange = db.prepare(
  `SELECT MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM events WHERE request_id = ?`,
);
const selectApprovals = db.prepare(
  `SELECT status, tool_name, decided_at FROM tool_approvals WHERE request_id = ?`,
);

/** Both tiers (local ollama.ts and cloud hermes_runner.py) emit the TOOL_CALL
 *  message as `Executing <name>` — the local engine via
 *  `Executing ${realName}` and the cloud engine via `Executing {name}`
 *  (Python f-string). Strip that shared prefix to recover the bare tool name.
 *  If a message doesn't match (unexpected shape), fall back gracefully to the
 *  raw message so we never drop or fabricate data. */
const EXECUTING_PREFIX = 'Executing ';
function parseToolName(row: EventRow): string {
  if (row.message.startsWith(EXECUTING_PREFIX)) {
    return row.message.slice(EXECUTING_PREFIX.length).trim();
  }
  // Fallback: try metadata (some future shape might carry a real tool name
  // there), else use the whole message verbatim — never invent a value.
  if (row.metadata) {
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      if (typeof meta.name === 'string' && meta.name.length > 0) return meta.name;
      if (typeof meta.toolName === 'string' && meta.toolName.length > 0) return meta.toolName;
    } catch {
      /* fall through to raw message */
    }
  }
  return row.message;
}

/** Pure SELECT-only projector for ONE task. Returns null if the tasks row is
 *  absent. No fabrication: a field is null unless the real persisted value
 *  exists (mirrors the no-fabrication discipline of dispatch.ts buildReceipt). */
export function projectReceipt(taskId: string): ReceiptRow | null {
  const task = selectTask.get(taskId) as TaskRow | undefined;
  if (!task) return null;

  let requestJson: Record<string, any> = {};
  try {
    requestJson = JSON.parse(task.request_json);
  } catch {
    requestJson = {};
  }

  let telemetry: Record<string, any> | null = null;
  if (task.telemetry_json) {
    try {
      telemetry = JSON.parse(task.telemetry_json);
    } catch {
      telemetry = null;
    }
  }

  // sourceChannel is TOP-LEVEL on GatewayRequest, not under payload.
  const sourceChannel: string | null =
    typeof requestJson.sourceChannel === 'string' ? requestJson.sourceChannel : null;

  // maxCost lives under constraints.
  const budgetLimit: number | null =
    typeof requestJson?.constraints?.maxCost === 'number' ? requestJson.constraints.maxCost : null;

  // memoryUsed lives under enrichment.
  const memoryUsed: number | null =
    requestJson?.enrichment?.memoryUsed === true
      ? 1
      : requestJson?.enrichment?.memoryUsed === false
        ? 0
        : null;

  // assembledContext lives under payload.
  const assembledContext: string =
    typeof requestJson?.payload?.assembledContext === 'string'
      ? requestJson.payload.assembledContext
      : '';
  const contextChars = assembledContext.length;

  // route_diagnostics_json: metadata of the FIRST TIER_SELECTED event for
  // this request_id. Never rebuild from tasks.router_reason.
  const tierSelectedRow = selectFirstTierSelected.get(taskId) as { metadata: string | null } | undefined;
  const routeDiagnosticsJson: string | null = tierSelectedRow?.metadata ?? null;

  const costUsd: number | null = typeof telemetry?.costUsd === 'number' ? telemetry.costUsd : null;
  const elapsedMs: number | null =
    typeof telemetry?.inferenceLatencyMs === 'number' ? telemetry.inferenceLatencyMs : null;
  const iterations: number | null =
    typeof telemetry?.iterations === 'number' ? telemetry.iterations : null;
  const cancelled: number | null = telemetry ? (telemetry.cancelled === true ? 1 : 0) : null;
  const blockedOn: string | null = typeof telemetry?.blockedOn === 'string' ? telemetry.blockedOn : null;

  // result_state: completed-with-blockedOn -> 'blocked'; else the raw state
  // (completed/failed/running). cancelled is surfaced via its own column.
  let resultState: string | null = task.state ?? null;
  if (task.state === 'completed' && blockedOn) {
    resultState = 'blocked';
  }

  // tools_called_json: ordered tool names parsed from TOOL_CALL events.
  const toolCallRows = selectToolCalls.all(taskId) as EventRow[];
  const toolsCalled = toolCallRows.map(parseToolName);

  // evidence range.
  const evidenceRange = selectEvidenceRange.get(taskId) as { min_seq: number | null; max_seq: number | null };
  const evidenceStartSeq = evidenceRange?.min_seq ?? null;
  const evidenceEndSeq = evidenceRange?.max_seq ?? null;

  // approvals folded into the composite receipt.
  const approvals = (selectApprovals.all(taskId) as ApprovalRow[]).map((a) => ({
    status: a.status,
    toolName: a.tool_name,
    decidedAt: a.decided_at,
  }));

  // budget_source, cost_enforceable, safe_export_json: ALWAYS null for 4A —
  // source data (budget provenance / enforceability) is not persisted yet,
  // and redaction (safe export) is a later ticket.
  const budgetSource: string | null = null;
  const costEnforceable: number | null = null;
  const safeExportJson: string | null = null;

  const fullReceipt = {
    taskId,
    sessionId: task.session_id,
    sourceChannel,
    selectedTier: task.tier ?? null,
    routerReason: task.router_reason ?? null,
    state: task.state,
    resultState,
    routeDiagnostics: routeDiagnosticsJson ? JSON.parse(routeDiagnosticsJson) : null,
    budgetLimit,
    costUsd,
    elapsedMs,
    iterations,
    cancelled: cancelled === 1,
    blockedOn,
    memoryUsed: memoryUsed === 1,
    contextChars,
    toolsCalled,
    approvals,
    evidence: { startSeq: evidenceStartSeq, endSeq: evidenceEndSeq },
    error: task.error ?? null,
  };

  return {
    id: randomUUID(), // only used on INSERT; preserved on conflict via upsert
    task_id: taskId,
    session_id: task.session_id,
    source_channel: sourceChannel,
    selected_tier: task.tier ?? null,
    route_diagnostics_json: routeDiagnosticsJson,
    budget_limit: budgetLimit,
    budget_source: budgetSource,
    cost_usd: costUsd,
    cost_enforceable: costEnforceable,
    elapsed_ms: elapsedMs,
    iterations,
    tools_called_json: JSON.stringify(toolsCalled),
    cancelled,
    blocked_on: blockedOn,
    memory_used: memoryUsed,
    context_chars: contextChars,
    result_state: resultState,
    safe_export_json: safeExportJson,
    full_receipt_json: JSON.stringify(fullReceipt),
    evidence_start_seq: evidenceStartSeq,
    evidence_end_seq: evidenceEndSeq,
    projection_version: PROJECTION_VERSION,
  };
}

const upsertReceipt = db.prepare(`
  INSERT INTO run_receipts (
    id, task_id, session_id, source_channel, selected_tier, route_diagnostics_json,
    budget_limit, budget_source, cost_usd, cost_enforceable, elapsed_ms, iterations,
    tools_called_json, cancelled, blocked_on, memory_used, context_chars, result_state,
    safe_export_json, full_receipt_json, evidence_start_seq, evidence_end_seq,
    projection_version, created_at, updated_at
  ) VALUES (
    @id, @task_id, @session_id, @source_channel, @selected_tier, @route_diagnostics_json,
    @budget_limit, @budget_source, @cost_usd, @cost_enforceable, @elapsed_ms, @iterations,
    @tools_called_json, @cancelled, @blocked_on, @memory_used, @context_chars, @result_state,
    @safe_export_json, @full_receipt_json, @evidence_start_seq, @evidence_end_seq,
    @projection_version, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT(task_id) DO UPDATE SET
    session_id = excluded.session_id,
    source_channel = excluded.source_channel,
    selected_tier = excluded.selected_tier,
    route_diagnostics_json = excluded.route_diagnostics_json,
    budget_limit = excluded.budget_limit,
    budget_source = excluded.budget_source,
    cost_usd = excluded.cost_usd,
    cost_enforceable = excluded.cost_enforceable,
    elapsed_ms = excluded.elapsed_ms,
    iterations = excluded.iterations,
    tools_called_json = excluded.tools_called_json,
    cancelled = excluded.cancelled,
    blocked_on = excluded.blocked_on,
    memory_used = excluded.memory_used,
    context_chars = excluded.context_chars,
    result_state = excluded.result_state,
    safe_export_json = excluded.safe_export_json,
    full_receipt_json = excluded.full_receipt_json,
    evidence_start_seq = excluded.evidence_start_seq,
    evidence_end_seq = excluded.evidence_end_seq,
    projection_version = excluded.projection_version,
    updated_at = CURRENT_TIMESTAMP
`);

/** Compute + UPSERT the receipt for one task. id and created_at are PRESERVED
 *  on conflict (re-projection is byte-identical except updated_at); every
 *  other column is overwritten with the freshly-computed value. No-op if the
 *  tasks row is absent. THROWS on projector/DB failure — callers on a
 *  terminal-emission path MUST use safeMaterializeReceipt instead. */
export function materializeReceipt(taskId: string): void {
  const row = projectReceipt(taskId);
  if (!row) return;
  upsertReceipt.run(row);
}

/** The ONLY form dispatch.ts may call. Never throws: a projector failure must
 *  never be able to flip a completed task into a failure or emit a phantom
 *  ERROR (invariant 7 — the terminal emission has already happened by the
 *  time this runs). */
export function safeMaterializeReceipt(taskId: string): void {
  try {
    materializeReceipt(taskId);
  } catch (e) {
    console.error(`[receipts] projection failed for ${taskId}`, e);
  }
}

/** Rebuild exactly one task's receipt. Returns 1 if a row existed to project,
 *  0 otherwise (task not found / not yet terminal). */
export function rebuildReceipt(taskId: string): number {
  const before = projectReceipt(taskId);
  if (!before) return 0;
  materializeReceipt(taskId);
  return 1;
}

const selectSessionTaskIds = db.prepare(
  `SELECT request_id FROM tasks WHERE session_id = ? AND state IN ('completed','failed')`,
);

/** Rebuild every terminal task's receipt for one session. Returns the count
 *  of tasks projected. */
export function rebuildSession(sessionId: string): number {
  const ids = (selectSessionTaskIds.all(sessionId) as { request_id: string }[]).map((r) => r.request_id);
  for (const id of ids) materializeReceipt(id);
  return ids.length;
}

const selectAllTerminalTaskIds = db.prepare(
  `SELECT request_id FROM tasks WHERE state IN ('completed','failed')`,
);
const selectStaleTerminalTaskIds = db.prepare(`
  SELECT t.request_id AS request_id
  FROM tasks t
  LEFT JOIN run_receipts r ON r.task_id = t.request_id
  WHERE t.state IN ('completed','failed')
    AND (r.task_id IS NULL OR r.projection_version < ?)
`);

/** Rebuild every terminal (completed/failed) task's receipt across the whole
 *  DB. Still-running tasks are skipped (no terminal telemetry to project
 *  yet). With `onlyStale: true`, restricts to tasks with no receipt yet or
 *  whose receipt's projection_version is behind the current
 *  PROJECTION_VERSION. Returns the count of tasks projected. */
export function rebuildAll(opts?: { onlyStale?: boolean }): number {
  const ids = (
    opts?.onlyStale
      ? (selectStaleTerminalTaskIds.all(PROJECTION_VERSION) as { request_id: string }[])
      : (selectAllTerminalTaskIds.all() as { request_id: string }[])
  ).map((r) => r.request_id);
  for (const id of ids) materializeReceipt(id);
  return ids.length;
}

// ── TCLAW-4B: read-only surface (SELECT-only, zero writes) ─────────────────

/** Summary shape returned by LIST_RECEIPTS. Deliberately excludes
 *  full_receipt_json (and route_diagnostics_json / tools_called_json, which
 *  are detail, not summary) — the list view must never carry the full
 *  receipt payload for every row in a session. */
export interface ReceiptSummary {
  taskId: string;
  sourceChannel: string | null;
  selectedTier: string | null;
  costUsd: number | null;
  elapsedMs: number | null;
  resultState: string | null;
  cancelled: number | null;
  blockedOn: string | null;
  evidenceStartSeq: number | null;
  evidenceEndSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

interface ReceiptSummaryRow {
  task_id: string;
  source_channel: string | null;
  selected_tier: string | null;
  cost_usd: number | null;
  elapsed_ms: number | null;
  result_state: string | null;
  cancelled: number | null;
  blocked_on: string | null;
  evidence_start_seq: number | null;
  evidence_end_seq: number | null;
  created_at: string;
  updated_at: string;
}

const selectSessionReceipts = db.prepare(`
  SELECT task_id, source_channel, selected_tier, cost_usd, elapsed_ms, result_state,
         cancelled, blocked_on, evidence_start_seq, evidence_end_seq, created_at, updated_at
  FROM run_receipts
  WHERE session_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

/** LIST_RECEIPTS backing query: SELECT-only, summary columns, this session
 *  only. NEVER selects full_receipt_json. NULLs are passed through as-is
 *  (no-fabrication discipline mirrors projectReceipt). */
export function listReceipts(sessionId: string, limit: number): ReceiptSummary[] {
  const rows = selectSessionReceipts.all(sessionId, limit) as ReceiptSummaryRow[];
  return rows.map((r) => ({
    taskId: r.task_id,
    sourceChannel: r.source_channel,
    selectedTier: r.selected_tier,
    costUsd: r.cost_usd,
    elapsedMs: r.elapsed_ms,
    resultState: r.result_state,
    cancelled: r.cancelled,
    blockedOn: r.blocked_on,
    evidenceStartSeq: r.evidence_start_seq,
    evidenceEndSeq: r.evidence_end_seq,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

const selectReceiptByTaskId = db.prepare(`SELECT * FROM run_receipts WHERE task_id = ?`);

/** GET_RECEIPT backing query: the full row (including session_id, which the
 *  caller MUST use for the ownership check before doing anything else with
 *  the row — see server.ts GET_RECEIPT handler). Returns null if no receipt
 *  exists for this task_id (task_id is UNIQUE). SELECT-only. */
export function getReceipt(taskId: string): ReceiptRow | null {
  const row = selectReceiptByTaskId.get(taskId) as ReceiptRow | undefined;
  return row ?? null;
}
