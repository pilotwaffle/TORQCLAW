import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ComputeTier } from '@torqclaw/contracts';

// approvals.ts / receipts.ts / sessions.ts (via storage.ts) open the gateway
// DB at import time, so TORQCLAW_DATA_DIR must be set before they load —
// exact pattern of tests/receipts-read.test.ts.
process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-approvals-read-'));
const { db } = await import('../packages/gateway/src/storage.js');
const {
  listApprovals, handleListApprovals, registerApproval, decideApproval,
} = await import('../packages/gateway/src/approvals.js');
const { materializeReceipt, handleGetReceipt } = await import('../packages/gateway/src/receipts.js');
const { publishOnly, sessionBus } = await import('../packages/gateway/src/events.js');
const { buildGateFacts } = await import('../packages/gateway/src/dispatch.js');

// NOTE on what "the real handler" means here: server.ts's /ws command switch
// delegates LIST_APPROVALS verbatim to handleListApprovals in approvals.ts
// (no parallel copy — see the switch case). server.ts itself has import-time
// side effects (bridge connect + app.listen) so it cannot be imported
// headlessly; driving the exported handler function IS driving the
// production handler body.

// ---- fixture helpers (copied from tests/receipts-read.test.ts) ------------

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

/** Insert an approval row with an EXPLICIT created_at/decided_at (unlike
 *  registerApproval, which always stamps CURRENT_TIMESTAMP) — ordering tests
 *  need distinct explicit values since created_at is only second-resolution. */
function insertApprovalAt(
  requestId: string, toolName: string, status: string, createdAt: string, decidedAt?: string,
): string {
  const approvalId = randomUUID();
  db.prepare(
    `INSERT INTO tool_approvals (approval_id, request_id, tool_name, args_json, status, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(approvalId, requestId, toolName, JSON.stringify({}), status, createdAt, decidedAt ?? null);
  return approvalId;
}

function rowCounts(): { tasks: number; events: number; tool_approvals: number; run_receipts: number } {
  const tasks = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  const events = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const tool_approvals = (db.prepare(`SELECT COUNT(*) AS n FROM tool_approvals`).get() as { n: number }).n;
  const run_receipts = (db.prepare(`SELECT COUNT(*) AS n FROM run_receipts`).get() as { n: number }).n;
  return { tasks, events, tool_approvals, run_receipts };
}

/** Byte-level snapshot of all mutable state the read surface could possibly
 *  touch: per-row states PLUS a full serialized dump of run_receipts and
 *  tool_approvals — so even a sneaky UPDATE (same row count) inside the
 *  handler body fails the before/after equality. */
function snapshotStates(): {
  taskStates: string[];
  approvalStates: string[];
  approvalsDump: string;
  receiptsDump: string;
} {
  const taskStates = (db.prepare(`SELECT state FROM tasks ORDER BY request_id`).all() as { state: string }[]).map((r) => r.state);
  const approvalStates = (db.prepare(`SELECT status FROM tool_approvals ORDER BY approval_id`).all() as { status: string }[]).map((r) => r.status);
  const approvalsDump = JSON.stringify(db.prepare(`SELECT * FROM tool_approvals ORDER BY approval_id`).all());
  const receiptsDump = JSON.stringify(db.prepare(`SELECT * FROM run_receipts ORDER BY task_id`).all());
  return { taskStates, approvalStates, approvalsDump, receiptsDump };
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

describe('TCLAW-5A-1 approval read surface', () => {
  it('1. session scoping: handleListApprovals(A) contains exactly A\'s approvalIds, never B\'s', () => {
    const sidA = makeSession();
    const sidB = makeSession();
    const taskA = makeTask({ sessionId: sidA, requestJson: baseRequestJson() });
    const taskB = makeTask({ sessionId: sidB, requestJson: baseRequestJson() });
    const approvalA = insertApprovalAt(taskA, 'fs__read_file', 'pending', '2026-01-01 00:00:00');
    const approvalB = insertApprovalAt(taskB, 'fs__read_file', 'pending', '2026-01-01 00:00:01');

    const frames = captureFrames(sidA, () => handleListApprovals(sidA, 20));
    expect(frames.length).toBe(1);
    const approvals = frames[0].metadata.approvals as any[];

    // Positive: A's approval is present.
    expect(approvals.some((a) => a.approvalId === approvalA)).toBe(true);
    // Negative: B's approval never appears in A's list.
    expect(approvals.some((a) => a.approvalId === approvalB)).toBe(false);
  });

  it('2. summary-only, exact key set (RC-6 teeth)', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    insertApprovalAt(taskId, 'fs__write_file', 'pending', '2026-01-01 00:00:00');

    const rows = listApprovals(sid, 20);
    expect(rows.length).toBe(1);
    const row = rows[0] as any;

    expect(Object.keys(row).sort()).toEqual(
      ['approvalId', 'createdAt', 'decidedAt', 'requestId', 'status', 'toolName'].sort(),
    );
    expect(row).not.toHaveProperty('args');
    expect(row).not.toHaveProperty('argsJson');
    expect(row).not.toHaveProperty('args_json');
  });

  it('3. REQUIRED — no actor / no TTL / no expired', () => {
    const sid = makeSession();
    const t1 = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const t2 = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const t3 = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    insertApprovalAt(t1, 'fs__read_file', 'pending', '2026-01-01 00:00:00');
    insertApprovalAt(t2, 'fs__write_file', 'approved', '2026-01-01 00:00:01', '2026-01-01 00:05:00');
    insertApprovalAt(t3, 'fs__delete_file', 'rejected', '2026-01-01 00:00:02', '2026-01-01 00:06:00');

    const rows = listApprovals(sid, 20);
    // Positive: all three statuses present in the unfiltered list.
    expect(rows.some((r) => r.status === 'pending')).toBe(true);
    expect(rows.some((r) => r.status === 'approved')).toBe(true);
    expect(rows.some((r) => r.status === 'rejected')).toBe(true);

    for (const row of rows) {
      expect(['pending', 'approved', 'rejected']).toContain(row.status);
      expect(row).not.toHaveProperty('actor');
      expect(row).not.toHaveProperty('decidedBy');
      expect(row).not.toHaveProperty('expiresAt');
      expect(row).not.toHaveProperty('ttl');
      expect(row).not.toHaveProperty('expired');
      if (row.status === 'pending') {
        expect(row.decidedAt).toBeNull();
      } else {
        expect(typeof row.decidedAt).toBe('string');
        expect(row.decidedAt).not.toBeNull();
      }
    }
  });

  it('4. status filter', () => {
    const sid = makeSession();
    const t1 = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const t2 = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    insertApprovalAt(t1, 'fs__read_file', 'pending', '2026-01-01 00:00:00');
    insertApprovalAt(t2, 'fs__write_file', 'approved', '2026-01-01 00:00:01', '2026-01-01 00:05:00');

    const unfiltered = listApprovals(sid, 20);
    // Positive: unfiltered list shows at least one of each before filtering.
    expect(unfiltered.some((r) => r.status === 'pending')).toBe(true);
    expect(unfiltered.some((r) => r.status === 'approved')).toBe(true);

    const pendingOnly = listApprovals(sid, 20, 'pending');
    expect(pendingOnly.length).toBeGreaterThan(0);
    expect(pendingOnly.every((r) => r.status === 'pending')).toBe(true);

    const approvedOnly = listApprovals(sid, 20, 'approved');
    expect(approvedOnly.length).toBeGreaterThan(0);
    expect(approvedOnly.every((r) => r.status === 'approved')).toBe(true);
  });

  it('5. limit + deterministic newest-first ordering', () => {
    const sid = makeSession();
    const t1 = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const t2 = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const t3 = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const a1 = insertApprovalAt(t1, 'fs__read_file', 'pending', '2026-01-01 00:00:00');
    const a2 = insertApprovalAt(t2, 'fs__write_file', 'pending', '2026-01-01 00:00:10');
    const a3 = insertApprovalAt(t3, 'fs__delete_file', 'pending', '2026-01-01 00:00:20');

    const all = listApprovals(sid, 20);
    expect(all.map((r) => r.approvalId)).toEqual([a3, a2, a1]);

    const limited = listApprovals(sid, 2);
    expect(limited.length).toBe(2);
    expect(limited.map((r) => r.approvalId)).toEqual([a3, a2]);
  });

  it('6. zero-write proof: rowCounts + snapshotStates byte-identical before/after handleListApprovals', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    insertApprovalAt(taskId, 'fs__read_file', 'pending', '2026-01-01 00:00:00');

    const before = rowCounts();
    const beforeStates = snapshotStates();

    const frames = captureFrames(sid, () => handleListApprovals(sid, 20));
    expect(frames.length).toBe(1);
    expect((frames[0].metadata.approvals as any[]).length).toBeGreaterThan(0);

    const after = rowCounts();
    const afterStates = snapshotStates();
    expect(after).toEqual(before);
    expect(afterStates).toEqual(beforeStates);
  });

  it('7. publishOnly frame shape', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    insertApprovalAt(taskId, 'fs__read_file', 'pending', '2026-01-01 00:00:00');

    const eventsBefore = rowCounts().events;
    const frames = captureFrames(sid, () => handleListApprovals(sid, 20));

    expect(frames.length).toBe(1);
    const frame = frames[0];
    expect(frame.type).toBe('SYSTEM');
    expect(frame.metadata.approvalList).toBe(true);
    expect(Array.isArray(frame.metadata.approvals)).toBe(true);
    expect('seq' in frame ? frame.seq : undefined).toBeUndefined();

    expect(rowCounts().events).toBe(eventsBefore); // non-persisted
  });

  it('8. orphan approval fail-closed', () => {
    const sid = makeSession();
    // An approval row whose request_id has NO tasks row at all.
    const orphanRequestId = randomUUID();
    const orphanApprovalId = insertApprovalAt(orphanRequestId, 'fs__read_file', 'pending', '2026-01-01 00:00:00');

    // Positive: the row genuinely exists in tool_approvals.
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM tool_approvals WHERE approval_id = ?`).get(orphanApprovalId) as { n: number }
    ).n;
    expect(count).toBe(1);

    // Negative: it appears in NO session's list (the owning session is unprovable).
    const rows = listApprovals(sid, 100);
    expect(rows.some((r) => r.approvalId === orphanApprovalId)).toBe(false);
  });

  it('9. REQUIRED — the divergence test: LIST_APPROVALS reads the live table; the frozen receipt embed does not', () => {
    const sid = makeSession();
    const toolName = 'fs__write_file';
    const taskId = makeTask({
      sessionId: sid,
      state: 'completed',
      requestJson: baseRequestJson(),
      telemetry: { blockedOn: toolName },
      result: '',
    });
    // REAL production sequence: registerApproval -> PENDING_APPROVAL event -> materializeReceipt.
    const approvalId = registerApproval(taskId, toolName, { path: '/tmp/x' });
    emitEvent(sid, taskId, 'PENDING_APPROVAL', `Tool ${toolName} requires approval`, {
      approvalId, toolName, requestId: taskId, args: { path: '/tmp/x' },
    });
    materializeReceipt(taskId);

    // Positive baseline: the frozen embed shows 'pending' right after materialization.
    const baselineFrames = captureFrames(sid, () => handleGetReceipt(sid, { taskId, includeEvents: false }));
    expect(baselineFrames.length).toBe(1);
    const baselineApprovals = baselineFrames[0].metadata.receipt.approvals as any[];
    expect(baselineApprovals.length).toBeGreaterThan(0);
    expect(baselineApprovals[0].status).toBe('pending');

    // REAL decideApproval — the only path a live APPROVE_TOOL command takes.
    const decided = decideApproval(approvalId, 'APPROVE');
    expect(decided).not.toBeNull();

    // (a) LIST_APPROVALS reads the LIVE table: shows 'approved' + non-null decidedAt.
    const listFrames = captureFrames(sid, () => handleListApprovals(sid, 20));
    expect(listFrames.length).toBe(1);
    const listed = (listFrames[0].metadata.approvals as any[]).find((a) => a.approvalId === approvalId);
    expect(listed).toBeTruthy();
    expect(listed.status).toBe('approved');
    expect(listed.decidedAt).not.toBeNull();
    expect(typeof listed.decidedAt).toBe('string');

    // (b) The frozen receipt embed STILL shows 'pending'/'null' — receipts
    // materialize at the PENDING_APPROVAL terminal and are NEVER re-projected
    // after decideApproval (TCLAW-FIX-G tracks the refresh). This pins the
    // staleness LIST_APPROVALS exists to route around: the live table
    // diverges from the frozen embed the instant an approval is decided.
    const afterFrames = captureFrames(sid, () => handleGetReceipt(sid, { taskId, includeEvents: false }));
    expect(afterFrames.length).toBe(1);
    const afterApprovals = afterFrames[0].metadata.receipt.approvals as any[];
    expect(afterApprovals.length).toBeGreaterThan(0);
    expect(afterApprovals[0].status).toBe('pending');
    expect(afterApprovals[0].decidedAt).toBeNull();
  });

  it('10. pending rows are listed, display-only; module exposes no decide surface from this handler', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    insertApprovalAt(taskId, 'fs__read_file', 'pending', '2026-01-01 00:00:00');

    const rows = listApprovals(sid, 20);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].decidedAt).toBeNull();
    // Zero-write proof (test 6) already proves handleListApprovals cannot
    // decide anything; this test additionally confirms a pending row is
    // still returned (never hidden), display-only.
  });

  describe('11. buildGateFacts (pure unit tests)', () => {
    function makeEntry(overrides: Partial<Record<string, unknown>> = {}): any {
      return {
        name: 'fs__write_file',
        description: '',
        inputSchema: {},
        sourceServerId: 'fs',
        rawName: 'write_file',
        requiresApproval: true,
        capability: 'write',
        ...overrides,
      };
    }

    it('LOCAL_EDGE + write-class entry -> capability/rule/sourceServerId present', () => {
      const entry = makeEntry({ capability: 'write' });
      const facts = buildGateFacts(ComputeTier.LOCAL_EDGE, entry, {});
      expect(facts.capability).toBe('write');
      expect(facts.rule).toBe('write-class-capability');
      expect(facts.sourceServerId).toBe('fs');
      expect(facts.targetsSource).toBe('path-heuristic');
    });

    it('LOCAL_EDGE + capability:read entry (registry HIT gated by approvalPattern) -> rule:approval-pattern, capability:read', () => {
      const entry = makeEntry({ capability: 'read' });
      const facts = buildGateFacts(ComputeTier.LOCAL_EDGE, entry, {});
      expect(facts.capability).toBe('read');
      expect(facts.rule).toBe('approval-pattern');
    });

    it('LOCAL_EDGE + undefined entry (registry miss) -> no capability/rule/sourceServerId; targets still extracted', () => {
      const facts = buildGateFacts(ComputeTier.LOCAL_EDGE, undefined, { path: '/tmp/a' });
      expect(facts).not.toHaveProperty('capability');
      expect(facts).not.toHaveProperty('rule');
      expect(facts).not.toHaveProperty('sourceServerId');
      expect(facts.targets).toEqual(['/tmp/a']);
    });

    it('FRONTIER + undefined entry -> rule:engine-approval-hook; no capability (engine has no capability classes)', () => {
      const facts = buildGateFacts(ComputeTier.FRONTIER, undefined, {});
      expect(facts.rule).toBe('engine-approval-hook');
      expect(facts).not.toHaveProperty('capability');
    });

    it('targets extraction: default COMMON_PATH_KEYS vs pathArgKeys override; non-object args -> []', () => {
      const f1 = buildGateFacts(ComputeTier.LOCAL_EDGE, undefined, { path: '/tmp/a', other: 'x' });
      expect(f1.targets).toEqual(['/tmp/a']);

      const entryWithOverride = makeEntry({ pathArgKeys: ['dest'] });
      const f2 = buildGateFacts(ComputeTier.LOCAL_EDGE, entryWithOverride, { dest: '/tmp/b', path: '/tmp/ignored' });
      expect(f2.targets).toEqual(['/tmp/b']);

      const f3 = buildGateFacts(ComputeTier.LOCAL_EDGE, undefined, 'not-an-object' as unknown);
      expect(f3.targets).toEqual([]);
    });
  });

  it('12. schema validation', async () => {
    const { ClientCommandSchema } = await import('@torqclaw/contracts');

    const parsed = ClientCommandSchema.parse({ action: 'LIST_APPROVALS' });
    expect(parsed).toEqual({ action: 'LIST_APPROVALS', limit: 20 });
    expect('status' in parsed).toBe(false);

    expect(ClientCommandSchema.safeParse({ action: 'LIST_APPROVALS', limit: 0 }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ action: 'LIST_APPROVALS', limit: 101 }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ action: 'LIST_APPROVALS', limit: 1.5 }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ action: 'LIST_APPROVALS', status: 'expired' }).success).toBe(false);
  });
});
