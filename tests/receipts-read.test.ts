import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// receipts.ts / sessions.ts / events.ts (via storage.ts) open the gateway DB
// at import time, so TORQCLAW_DATA_DIR must be set before they load — exact
// pattern of tests/receipt-projection.test.ts / tests/sessions-memory.test.ts.
process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-receipts-read-'));
const { db } = await import('../packages/gateway/src/storage.js');
const {
  materializeReceipt, listReceipts, getReceipt,
  handleListReceipts, handleGetReceipt, MAX_REPLAY_BYTES, PROJECTION_VERSION,
} = await import('../packages/gateway/src/receipts.js');
const { sessions } = await import('../packages/gateway/src/sessions.js');
const { publishOnly, sessionBus } = await import('../packages/gateway/src/events.js');

// NOTE on what "the real handler" means here: server.ts's /ws command switch
// delegates LIST_RECEIPTS/GET_RECEIPT verbatim to handleListReceipts /
// handleGetReceipt in receipts.ts (no parallel copy — see the switch cases).
// server.ts itself has import-time side effects (bridge connect + app.listen)
// so it cannot be imported headlessly; driving the exported handler functions
// IS driving the production handler bodies.

// ---- fixture helpers (mirrors tests/receipt-projection.test.ts) -----------

function makeSession(): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')`).run(id);
  return id;
}

interface TaskFixtureOpts {
  sessionId: string;
  tier?: string;
  state?: 'running' | 'completed' | 'failed';
  requestJson: Record<string, unknown>;
  telemetry?: Record<string, unknown> | null;
  error?: string | null;
  result?: string | null;
}

function makeTask(opts: TaskFixtureOpts): string {
  const requestId = randomUUID();
  db.prepare(
    `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json, result, error, telemetry_json)
     VALUES (@request_id, @session_id, @tier, @router_reason, @state, @request_json, @result, @error, @telemetry_json)`,
  ).run({
    request_id: requestId,
    session_id: opts.sessionId,
    tier: opts.tier ?? 'OLLAMA_LOCAL',
    router_reason: 'TEST: fixture',
    state: opts.state ?? 'completed',
    request_json: JSON.stringify(opts.requestJson),
    result: opts.result ?? null,
    error: opts.error ?? null,
    telemetry_json: opts.telemetry === undefined ? null : opts.telemetry === null ? null : JSON.stringify(opts.telemetry),
  });
  return requestId;
}

function baseRequestJson(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    sourceChannel: 'test-channel',
    receivedAt: new Date().toISOString(),
    payload: {
      prompt: 'do the thing',
      assembledContext: '',
      contextSize: 100,
      requiredTools: [],
      taskType: 'ROUTINE_AUTOMATION',
      grantedTools: [],
    },
    constraints: {
      latencySensitivity: 'LOW',
      containsSensitiveData: false,
      executionMode: 'AUTO',
    },
    enrichment: {
      classifierUsed: 'LOCAL_LLM',
      classifierConfidence: 0.9,
      classifierLatencyMs: 10,
      estimatedTokens: 100,
      memoryUsed: true,
    },
    ...overrides,
  };
}

const insertEvent = db.prepare(
  `INSERT INTO events (id, session_id, request_id, tier, type, message, metadata)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

function emitEvent(
  sessionId: string, requestId: string, type: string, message: string, metadata?: unknown,
): number {
  const info = insertEvent.run(
    randomUUID(), sessionId, requestId, 'OLLAMA_LOCAL', type, message,
    metadata === undefined ? null : JSON.stringify(metadata),
  );
  return Number(info.lastInsertRowid);
}

function insertApproval(requestId: string, toolName: string, status: string): void {
  db.prepare(
    `INSERT INTO tool_approvals (approval_id, request_id, tool_name, args_json, status, decided_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  ).run(randomUUID(), requestId, toolName, JSON.stringify({}), status);
}

function rowCounts(): { tasks: number; events: number; tool_approvals: number; run_receipts: number } {
  const tasks = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  const events = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const tool_approvals = (db.prepare(`SELECT COUNT(*) AS n FROM tool_approvals`).get() as { n: number }).n;
  const run_receipts = (db.prepare(`SELECT COUNT(*) AS n FROM run_receipts`).get() as { n: number }).n;
  return { tasks, events, tool_approvals, run_receipts };
}

/** Byte-level snapshot of all mutable state the read surface could possibly
 *  touch: per-row states PLUS a full serialized dump of run_receipts — so
 *  even a sneaky UPDATE (same row count) inside the handler body fails the
 *  before/after equality. */
function snapshotStates(): { taskStates: string[]; approvalStates: string[]; receiptsDump: string } {
  const taskStates = (db.prepare(`SELECT state FROM tasks ORDER BY request_id`).all() as { state: string }[]).map((r) => r.state);
  const approvalStates = (db.prepare(`SELECT status FROM tool_approvals ORDER BY approval_id`).all() as { status: string }[]).map((r) => r.status);
  const receiptsDump = JSON.stringify(db.prepare(`SELECT * FROM run_receipts ORDER BY task_id`).all());
  return { taskStates, approvalStates, receiptsDump };
}

/** Capture every frame the REAL handler publishes to the session's bus while
 *  fn runs — exactly what a connected ws client would receive. */
function captureFrames(sessionId: string, fn: () => void): any[] {
  const frames: any[] = [];
  const unsubscribe = sessionBus.subscribe(sessionId, (ev) => frames.push(ev));
  try {
    fn();
  } finally {
    unsubscribe();
  }
  return frames;
}

// ---------------------------------------------------------------------------

describe('TCLAW-4B receipt read surface', () => {
  it('1. listReceipts returns ONLY the caller session\'s rows, newest first, summary columns, NULLs intact', () => {
    const sidA = makeSession();
    const sidB = makeSession();

    const tA1 = makeTask({ sessionId: sidA, requestJson: baseRequestJson({ sourceChannel: 'slack' }) });
    const tA2 = makeTask({
      sessionId: sidA, state: 'failed', requestJson: baseRequestJson({ sourceChannel: 'cli' }), telemetry: null, error: 'boom',
    });
    const tB1 = makeTask({ sessionId: sidB, requestJson: baseRequestJson() });

    materializeReceipt(tA1);
    materializeReceipt(tA2);
    materializeReceipt(tB1);

    const listA = listReceipts(sidA, 20);
    expect(listA.length).toBe(2);
    expect(listA.map((r) => r.taskId).sort()).toEqual([tA1, tA2].sort());
    expect(listA.some((r) => r.taskId === tB1)).toBe(false);

    // Newest-first ordering.
    expect(listA[0].createdAt >= listA[1].createdAt).toBe(true);

    // Summary columns only — no full_receipt_json / route_diagnostics_json / tools_called_json leak.
    for (const r of listA) {
      expect((r as any).full_receipt_json).toBeUndefined();
      expect((r as any).route_diagnostics_json).toBeUndefined();
      expect((r as any).tools_called_json).toBeUndefined();
    }

    // NULLs intact (failed task has no telemetry -> costUsd/elapsedMs null).
    const failedSummary = listA.find((r) => r.taskId === tA2)!;
    expect(failedSummary.costUsd).toBeNull();
    expect(failedSummary.elapsedMs).toBeNull();
    expect(failedSummary.resultState).toBe('failed');
  });

  it('2+3. REAL handler: owned -> receipt frame; foreign session AND absent taskId -> indistinguishable receipt:null frames', () => {
    const owner = makeSession();
    const other = makeSession();
    const taskId = makeTask({ sessionId: owner, requestJson: baseRequestJson({ sourceChannel: 'slack' }) });
    materializeReceipt(taskId);

    // Owned: the real handler publishes the receipt.
    const ownedFrames = captureFrames(owner, () => handleGetReceipt(owner, { taskId, includeEvents: false }));
    expect(ownedFrames.length).toBe(1);
    expect(ownedFrames[0].message).toBe('Receipt');
    expect((ownedFrames[0].metadata as any).receipt).not.toBeNull();
    expect((ownedFrames[0].metadata as any).receipt.taskId).toBe(taskId);

    // Foreign (row exists, other session) vs absent (no row at all).
    const foreignFrames = captureFrames(other, () => handleGetReceipt(other, { taskId, includeEvents: false }));
    const absentId = randomUUID();
    const absentFrames = captureFrames(other, () => handleGetReceipt(other, { taskId: absentId, includeEvents: false }));

    expect(foreignFrames.length).toBe(1);
    expect(absentFrames.length).toBe(1);
    const f = foreignFrames[0];
    const a = absentFrames[0];
    expect(f.metadata.receipt).toBeNull();
    expect(a.metadata.receipt).toBeNull();
    // No existence oracle: byte-identical message + metadata once the echoed
    // taskId (which the prober itself chose) is normalized out.
    const normalize = (frame: any) =>
      JSON.stringify({ message: frame.message, metadata: { ...frame.metadata, taskId: 'X' } });
    expect(normalize(f)).toBe(normalize(a));
  });

  it('4. includeEvents size-safe -> getEventsForRequest returns seq-ascending events within [start,end]', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const s1 = emitEvent(sid, taskId, 'ROUTING', 'classified');
    const s2 = emitEvent(sid, taskId, 'TIER_SELECTED', 'local', { tier: 'OLLAMA_LOCAL' });
    const s3 = emitEvent(sid, taskId, 'RESULT', 'done');

    materializeReceipt(taskId);
    const row = getReceipt(taskId)!;
    expect(row.evidence_start_seq).toBe(s1);
    expect(row.evidence_end_seq).toBe(s3);

    const events = sessions.getEventsForRequest(taskId, row.evidence_start_seq!, row.evidence_end_seq!);
    expect(events.map((e) => e.seq)).toEqual([s1, s2, s3]);
    // Mapped like the reconnect backlog: same rowToEvent shape (has id/type/message/timestamp).
    for (const e of events) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.type).toBe('string');
      expect(typeof e.message).toBe('string');
      expect(typeof e.timestamp).toBe('string');
    }
  });

  it('5. REAL handler OVERSIZE: includeEvents over MAX_REPLAY_BYTES -> events=null + eventsOmitted marker, NO partial array', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });

    // Build enough TOOL_CALL events with large metadata to exceed MAX_REPLAY_BYTES (512KB).
    const bigArg = 'x'.repeat(2000);
    let firstSeq: number | null = null;
    let lastSeq = 0;
    for (let i = 0; i < 400; i++) {
      const s = emitEvent(sid, taskId, 'TOOL_CALL', `Executing tool_${i}`, { blob: bigArg });
      if (firstSeq === null) firstSeq = s;
      lastSeq = s;
    }
    materializeReceipt(taskId); // evidence range = [firstSeq, lastSeq]

    // Sanity: the fixture really is oversize against the PRODUCTION constant.
    const events = sessions.getEventsForRequest(taskId, firstSeq!, lastSeq);
    expect(Buffer.byteLength(JSON.stringify(events), 'utf8')).toBeGreaterThan(MAX_REPLAY_BYTES);

    // Drive the REAL handler; its own guard must omit the array entirely.
    const frames = captureFrames(sid, () => handleGetReceipt(sid, { taskId, includeEvents: true }));
    expect(frames.length).toBe(1);
    const meta = frames[0].metadata;
    expect(meta.receiptView).toBe(true);
    expect(meta.events).toBeNull(); // all-or-marker: null, never a truncated array
    expect(meta.eventsOmitted).toEqual({
      reason: 'too_large',
      eventCount: 400,
      evidenceStartSeq: firstSeq,
      evidenceEndSeq: lastSeq,
    });
  });

  it('6. REAL handler read-only/inert: replayed PENDING_APPROVAL is plain data; rows UNCHANGED after GET_RECEIPT+includeEvents', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      state: 'completed',
      requestJson: baseRequestJson(),
      telemetry: { blockedOn: 'filesystem__write_file' },
      result: '',
    });
    emitEvent(sid, taskId, 'ROUTING', 'classified');
    emitEvent(sid, taskId, 'PENDING_APPROVAL', 'Blocked on filesystem__write_file', {
      approvalId: 'approval-xyz', toolName: 'filesystem__write_file',
    });
    insertApproval(taskId, 'filesystem__write_file', 'pending');
    materializeReceipt(taskId);

    const before = rowCounts();
    const beforeStates = snapshotStates();

    // Drive the REAL production handler body (the same function server.ts's
    // switch calls) — this is the path a live GET_RECEIPT command takes.
    const frames = captureFrames(sid, () => handleGetReceipt(sid, { taskId, includeEvents: true }));
    expect(frames.length).toBe(1);
    const meta = frames[0].metadata;
    expect(meta.receiptView).toBe(true);
    const replayed = (meta.events as any[]).find((e) => e.type === 'PENDING_APPROVAL')!;
    expect(replayed).toBeTruthy();
    expect(replayed.metadata.approvalId).toBe('approval-xyz');

    const after = rowCounts();
    const afterStates = snapshotStates();
    expect(after).toEqual(before);
    expect(afterStates).toEqual(beforeStates);
    // The approval itself is still 'pending' — reading its replayed event never decided it.
    expect(afterStates.approvalStates).toContain('pending');
  });

  it('7. publishOnly does NOT insert into events; the published event has no seq', () => {
    const sid = makeSession();
    const before = rowCounts();

    let received: any = null;
    const unsubscribe = sessionBus.subscribe(sid, (ev) => { received = ev; });
    try {
      publishOnly(sid, { message: 'Receipts listed', metadata: { receiptList: true, receipts: [] } });
    } finally {
      unsubscribe();
    }

    const after = rowCounts();
    expect(after.events).toBe(before.events); // unchanged — no INSERT

    expect(received).not.toBeNull();
    expect(received.sessionId).toBe(sid);
    expect(received.message).toBe('Receipts listed');
    expect('seq' in received ? received.seq : undefined).toBeUndefined();
  });

  it('8. REAL handlers no mutation: LIST_RECEIPTS + GET_RECEIPT leave tasks/events/tool_approvals/run_receipts byte-identical', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson({ sourceChannel: 'slack' }),
      telemetry: { costUsd: 0.05, inferenceLatencyMs: 400, iterations: 2 },
    });
    emitEvent(sid, taskId, 'TIER_SELECTED', 'local', { tier: 'OLLAMA_LOCAL' });
    emitEvent(sid, taskId, 'TOOL_CALL', 'Executing filesystem__read_file');
    insertApproval(taskId, 'filesystem__read_file', 'approved');
    materializeReceipt(taskId);

    const before = rowCounts();
    const beforeStates = snapshotStates();

    // Drive the REAL production handler bodies (same functions server.ts's
    // switch calls). A write introduced ANYWHERE in these handler bodies —
    // not just in publishOnly/getReceipt — fails the equality below.
    const listFrames = captureFrames(sid, () => handleListReceipts(sid, 20));
    expect(listFrames.length).toBe(1);
    expect(listFrames[0].metadata.receiptList).toBe(true);
    expect((listFrames[0].metadata.receipts as any[]).length).toBeGreaterThan(0);

    const getFrames = captureFrames(sid, () => handleGetReceipt(sid, { taskId, includeEvents: true }));
    expect(getFrames.length).toBe(1);
    expect(getFrames[0].metadata.receiptView).toBe(true);

    const after = rowCounts();
    const afterStates = snapshotStates();
    expect(after).toEqual(before);
    expect(afterStates).toEqual(beforeStates);
  });

  it('9. NULL honesty: failed-task receipt has cost_usd/elapsed_ms/iterations null (not 0); budget_source/cost_enforceable/safe_export_json null; getReceipt round-trips full_receipt_json', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      state: 'failed',
      requestJson: baseRequestJson({ sourceChannel: 'cli' }),
      telemetry: null,
      error: 'Execution failed: boom',
    });
    materializeReceipt(taskId);

    const row = getReceipt(taskId)!;
    expect(row.cost_usd).toBeNull();
    expect(row.elapsed_ms).toBeNull();
    expect(row.iterations).toBeNull();
    expect(row.budget_source).toBeNull();
    expect(row.cost_enforceable).toBeNull();
    expect(row.safe_export_json).toBeNull();

    // Round-trip: full_receipt_json parses and matches the projected fields.
    const full = JSON.parse(row.full_receipt_json);
    expect(full.taskId).toBe(taskId);
    expect(full.costUsd).toBeNull();
    expect(full.elapsedMs).toBeNull();
    expect(full.iterations).toBeNull();
    expect(full.error).toBe('Execution failed: boom');
  });

  it('10. REAL handler frames: full response shape — receiptList summary, receiptView + receipt + own-key taskPrompt + projectionVersion + seq-ascending events; frames are seq-less', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson({ sourceChannel: 'slack' }),
      telemetry: { costUsd: 0.02, inferenceLatencyMs: 300, iterations: 1 },
    });
    const s1 = emitEvent(sid, taskId, 'ROUTING', 'classified');
    const s2 = emitEvent(sid, taskId, 'TIER_SELECTED', 'local', { tier: 'OLLAMA_LOCAL' });
    const s3 = emitEvent(sid, taskId, 'RESULT', 'done');
    materializeReceipt(taskId);

    // LIST_RECEIPTS via the real handler.
    const listFrames = captureFrames(sid, () => handleListReceipts(sid, 20));
    expect(listFrames.length).toBe(1);
    expect(listFrames[0].type).toBe('SYSTEM');
    expect(listFrames[0].message).toBe('Receipts listed');
    expect(listFrames[0].metadata.receiptList).toBe(true);
    const summaries = listFrames[0].metadata.receipts as any[];
    const mine = summaries.find((r) => r.taskId === taskId)!;
    expect(mine).toBeTruthy();
    expect(mine.costUsd).toBe(0.02);
    expect(mine.full_receipt_json).toBeUndefined(); // summary only, over the real handler too
    expect('seq' in listFrames[0] ? listFrames[0].seq : undefined).toBeUndefined(); // transient frame

    // GET_RECEIPT(includeEvents) via the real handler.
    const getFrames = captureFrames(sid, () => handleGetReceipt(sid, { taskId, includeEvents: true }));
    expect(getFrames.length).toBe(1);
    const frame = getFrames[0];
    expect(frame.type).toBe('SYSTEM');
    expect(frame.message).toBe('Receipt');
    const meta = frame.metadata;
    expect(meta.receiptView).toBe(true);
    expect(meta.taskId).toBe(taskId);
    expect(meta.receipt.taskId).toBe(taskId);
    expect(meta.receipt.costUsd).toBe(0.02);
    expect(meta.projectionVersion).toBe(PROJECTION_VERSION);
    // taskPrompt rides under its OWN metadata key, never merged into receipt.
    expect(meta.taskPrompt).toBe('do the thing');
    expect(meta.receipt.taskPrompt).toBeUndefined();
    // Events: seq-ascending, exactly the evidence range.
    expect((meta.events as any[]).map((e) => e.seq)).toEqual([s1, s2, s3]);
    expect(meta.eventsOmitted).toBeUndefined();
    expect('seq' in frame ? frame.seq : undefined).toBeUndefined(); // transient frame
  });
});
