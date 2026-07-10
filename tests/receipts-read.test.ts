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
const { materializeReceipt, listReceipts, getReceipt } = await import('../packages/gateway/src/receipts.js');
const { sessions } = await import('../packages/gateway/src/sessions.js');
const { publishOnly, sessionBus } = await import('../packages/gateway/src/events.js');

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

function rowCounts(): { tasks: number; events: number; tool_approvals: number } {
  const tasks = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  const events = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const tool_approvals = (db.prepare(`SELECT COUNT(*) AS n FROM tool_approvals`).get() as { n: number }).n;
  return { tasks, events, tool_approvals };
}

function snapshotStates(): { taskStates: string[]; approvalStates: string[] } {
  const taskStates = (db.prepare(`SELECT state FROM tasks ORDER BY request_id`).all() as { state: string }[]).map((r) => r.state);
  const approvalStates = (db.prepare(`SELECT status FROM tool_approvals ORDER BY approval_id`).all() as { status: string }[]).map((r) => r.status);
  return { taskStates, approvalStates };
}

/**
 * Mirrors server.ts's GET_RECEIPT ownership decision exactly (row null OR
 * row.session_id !== sid -> the SAME "no receipt" response). Encodes the
 * decision as a pure function so the no-existence-oracle invariant is
 * testable without standing up a live WebSocket server.
 */
function ownershipDecision(taskId: string, requesterSid: string): { receipt: null } | { receipt: unknown } {
  const row = getReceipt(taskId);
  if (!row || row.session_id !== requesterSid) {
    return { receipt: null };
  }
  return { receipt: JSON.parse(row.full_receipt_json) };
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

  it('2+3. getReceipt owned -> row; foreign session AND absent taskId -> indistinguishable receipt:null', () => {
    const owner = makeSession();
    const other = makeSession();
    const taskId = makeTask({ sessionId: owner, requestJson: baseRequestJson({ sourceChannel: 'slack' }) });
    materializeReceipt(taskId);

    const ownedDecision = ownershipDecision(taskId, owner);
    expect('receipt' in ownedDecision && ownedDecision.receipt).not.toBeNull();

    const foreignDecision = ownershipDecision(taskId, other);
    const absentDecision = ownershipDecision(randomUUID(), other);

    expect(foreignDecision).toEqual({ receipt: null });
    expect(absentDecision).toEqual({ receipt: null });
    // Byte-identical shape — no existence oracle.
    expect(JSON.stringify(foreignDecision)).toBe(JSON.stringify(absentDecision));
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

  it('5. includeEvents OVERSIZE -> events=null + eventsOmitted marker (reason too_large, seq range), NO partial array', () => {
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

    const events = sessions.getEventsForRequest(taskId, firstSeq!, lastSeq);
    const serialized = JSON.stringify(events);
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    const MAX_REPLAY_BYTES = 512 * 1024;
    expect(byteLength).toBeGreaterThan(MAX_REPLAY_BYTES); // sanity: fixture is actually oversize

    // Replicate the exact server.ts oversize-guard branch.
    let metaEvents: unknown;
    let eventsOmitted: unknown;
    if (byteLength > MAX_REPLAY_BYTES) {
      metaEvents = null;
      eventsOmitted = {
        reason: 'too_large',
        eventCount: events.length,
        evidenceStartSeq: firstSeq,
        evidenceEndSeq: lastSeq,
      };
    } else {
      metaEvents = events;
    }

    expect(metaEvents).toBeNull();
    expect(eventsOmitted).toEqual({
      reason: 'too_large',
      eventCount: 400,
      evidenceStartSeq: firstSeq,
      evidenceEndSeq: lastSeq,
    });
  });

  it('6. read-only/inert: a replayed PENDING_APPROVAL event is plain data; row counts UNCHANGED before vs after GET_RECEIPT+includeEvents', () => {
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

    // Simulate the full GET_RECEIPT+includeEvents read path.
    const row = getReceipt(taskId)!;
    expect(row.session_id).toBe(sid);
    const events = sessions.getEventsForRequest(taskId, row.evidence_start_seq!, row.evidence_end_seq!);
    const pendingApprovalEvent = events.find((e) => e.type === 'PENDING_APPROVAL')!;
    expect(pendingApprovalEvent).toBeTruthy();
    expect((pendingApprovalEvent.metadata as any).approvalId).toBe('approval-xyz');
    publishOnly(sid, { message: 'Receipt', metadata: { receiptView: true, taskId, receipt: JSON.parse(row.full_receipt_json), events } });

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

  it('8. no mutation: after LIST_RECEIPTS and GET_RECEIPT, tasks/events/tool_approvals counts and states are byte-identical', () => {
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

    // LIST_RECEIPTS.
    const list = listReceipts(sid, 20);
    expect(list.length).toBeGreaterThan(0);
    publishOnly(sid, { message: 'Receipts listed', metadata: { receiptList: true, receipts: list } });

    // GET_RECEIPT.
    const row = getReceipt(taskId)!;
    publishOnly(sid, { message: 'Receipt', metadata: { receiptView: true, taskId, receipt: JSON.parse(row.full_receipt_json) } });

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
});
