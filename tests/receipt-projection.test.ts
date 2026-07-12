import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// receipts.ts (via storage.ts) opens the gateway DB at import time, so
// TORQCLAW_DATA_DIR must be set before it loads — exact pattern of
// tests/sessions-memory.test.ts.
process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-receipts-'));
const { db } = await import('../packages/gateway/src/storage.js');
const receipts = await import('../packages/gateway/src/receipts.js');
const { projectReceipt, materializeReceipt, safeMaterializeReceipt, rebuildAll, PROJECTION_VERSION } = receipts;

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'gateway', 'db', 'schema.sql',
);

// ---- fixture helpers -------------------------------------------------------

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

function getReceipt(taskId: string): any {
  return db.prepare(`SELECT * FROM run_receipts WHERE task_id = ?`).get(taskId);
}

function contentColumns(row: any): any {
  if (!row) return row;
  const { id, created_at, updated_at, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------

describe('TCLAW-4A run receipt projection', () => {
  it('(a) determinism/idempotency: materializing twice preserves id + created_at, content stable', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson({ sourceChannel: 'slack' }),
      telemetry: { costUsd: 0.02, inferenceLatencyMs: 500, iterations: 2 },
    });
    emitEvent(sid, taskId, 'TIER_SELECTED', 'local edge', { score: 1, reason: 'x', tier: 'OLLAMA_LOCAL' });
    emitEvent(sid, taskId, 'TOOL_CALL', 'Executing filesystem__read_file');

    materializeReceipt(taskId);
    const first = getReceipt(taskId);
    expect(first).toBeTruthy();

    materializeReceipt(taskId);
    const second = getReceipt(taskId);

    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    expect(contentColumns(second)).toEqual(contentColumns(first));
    // updated_at is allowed to differ (bumped each projection); not asserted.
  });

  it('(b) rebuild content-identical: rebuildAll -> delete -> rebuildAll again matches', () => {
    const sid = makeSession();
    const t1 = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson({ sourceChannel: 'cli' }),
      telemetry: { costUsd: 0.5, inferenceLatencyMs: 1200, iterations: 3 },
    });
    emitEvent(sid, t1, 'TIER_SELECTED', 'frontier', { score: 5, reason: 'y', tier: 'API_EXTERNAL' });
    emitEvent(sid, t1, 'TOOL_CALL', 'Executing web_search');
    const t2 = makeTask({
      sessionId: sid,
      state: 'failed',
      requestJson: baseRequestJson({ sourceChannel: 'cli' }),
      telemetry: null,
      error: 'boom',
    });

    const n1 = rebuildAll();
    expect(n1).toBeGreaterThanOrEqual(2);
    const snapshot1 = contentColumns(getReceipt(t1));
    const snapshot2 = contentColumns(getReceipt(t2));

    db.prepare(`DELETE FROM run_receipts`).run();
    expect(getReceipt(t1)).toBeUndefined();

    const n2 = rebuildAll();
    expect(n2).toBe(n1);
    expect(contentColumns(getReceipt(t1))).toEqual(snapshot1);
    expect(contentColumns(getReceipt(t2))).toEqual(snapshot2);
  });

  it('(c) failure-cascade safety: safeMaterializeReceipt swallows a thrown projector and never rethrows', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });

    // ES module namespace exports are non-writable, so we can't monkeypatch
    // projectReceipt directly. Instead force a REAL failure deep in
    // materializeReceipt's write path by dropping run_receipts out from under
    // it — the prepared UPSERT statement then throws a genuine SQLite
    // "no such table" error, exercising the actual guarded/unguarded code.
    db.exec('DROP TABLE run_receipts');

    try {
      // materializeReceipt (unguarded) DOES propagate — proves the wrapper is
      // the one doing the swallowing, not some incidental catch elsewhere.
      expect(() => materializeReceipt(taskId)).toThrow();

      // safeMaterializeReceipt is the ONLY form dispatch.ts calls. It must
      // NEVER throw, regardless of what the projector/write path does.
      expect(() => safeMaterializeReceipt(taskId)).not.toThrow();
    } finally {
      // Restore the table so later tests in this file are unaffected —
      // schema.sql is idempotent (CREATE TABLE IF NOT EXISTS).
      db.exec(readFileSync(schemaPath, 'utf8'));
    }
  });

  it('(c) dispatch contract: the success terminal path calls the guarded wrapper, not the bare projector', async () => {
    // Static assertion over the real dispatch.ts source: the SUCCESS path
    // (inside the try, before the outer catch) must call safeMaterializeReceipt,
    // and dispatch.ts must never call the bare materializeReceipt anywhere —
    // any bare call, even one that "looks" outside the try, is a hazard the
    // wrapper contract exists to rule out entirely.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../packages/gateway/src/dispatch.ts', import.meta.url));
    const src = readFileSync(path, 'utf8');

    const bareCalls = src.match(/(?<!safe)materializeReceipt\(/g) ?? [];
    expect(bareCalls.length).toBe(0);

    const guardedCalls = src.match(/safeMaterializeReceipt\(/g) ?? [];
    // 6 call sites: SUCCESS, BLOCKED, FAILED, CAP_EXCEEDED (TCLAW-1A-core),
    // FRONTIER_UNAVAILABLE, emitToolDenied.
    expect(guardedCalls.length).toBe(6);
  });

  it('(d) no-fabrication: failed task with NULL telemetry -> cost/iterations/elapsed NULL', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      state: 'failed',
      requestJson: baseRequestJson(),
      telemetry: null,
      error: 'Execution failed: boom',
    });
    const row = projectReceipt(taskId)!;
    expect(row.cost_usd).toBeNull();
    expect(row.iterations).toBeNull();
    expect(row.elapsed_ms).toBeNull();
    expect(row.cancelled).toBeNull();
    expect(row.blocked_on).toBeNull();
    expect(row.result_state).toBe('failed');
  });

  it('(d) no-fabrication: local success with no cost -> cost_usd NULL', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson(),
      telemetry: { inferenceLatencyMs: 300, iterations: 1 }, // no costUsd (local tier)
    });
    const row = projectReceipt(taskId)!;
    expect(row.cost_usd).toBeNull();
    expect(row.elapsed_ms).toBe(300);
    expect(row.iterations).toBe(1);
  });

  it('(d) no-fabrication: no TIER_SELECTED event -> route_diagnostics_json NULL (never rebuilt from router_reason)', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const row = projectReceipt(taskId)!;
    expect(row.route_diagnostics_json).toBeNull();
  });

  it('(d) safe_export_json is ALWAYS null (TCLAW-5B-1: deliberately NULL forever -- GET_SAFE_EXPORT computes the redacted export on demand, never persisted here)', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson(),
      telemetry: { costUsd: 1.23, inferenceLatencyMs: 400, iterations: 4 },
    });
    const row = projectReceipt(taskId)!;
    expect(row.safe_export_json).toBeNull();
  });

  it('(d) TCLAW-1A-core: budget_source/cost_enforceable are null when telemetry carries no budgetSource key (pre-1A task)', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      tier: 'OLLAMA_LOCAL',
      requestJson: baseRequestJson(),
      telemetry: { costUsd: 1.23, inferenceLatencyMs: 400, iterations: 4 }, // no budgetSource key
    });
    const row = projectReceipt(taskId)!;
    expect(row.budget_source).toBeNull();
    // costUsd IS a number here, so cost_enforceable is derived as 1 regardless
    // of budgetSource presence — the two columns are independent signals.
    expect(row.cost_enforceable).toBe(1);
  });

  it('(d) TCLAW-1A-core: budget_source reflects the persisted source (per_task/env_default/unlimited)', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      tier: 'API_EXTERNAL',
      requestJson: baseRequestJson(),
      telemetry: { costUsd: 0.5, inferenceLatencyMs: 400, iterations: 2, budgetSource: 'per_task' },
    });
    const row = projectReceipt(taskId)!;
    expect(row.budget_source).toBe('per_task');
    expect(row.cost_enforceable).toBe(1);
  });

  it('(d) TCLAW-1A-core: cost_enforceable=0 when a FRONTIER task ran but costUsd was null (provider unavailable)', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      tier: 'API_EXTERNAL',
      requestJson: baseRequestJson(),
      telemetry: { costUsd: null, inferenceLatencyMs: 400, iterations: 2, budgetSource: 'env_default' },
    });
    const row = projectReceipt(taskId)!;
    expect(row.cost_enforceable).toBe(0);
  });

  it('(d) TCLAW-1A-core: cost_enforceable=NULL when there was no cloud attempt at all (no telemetry)', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      tier: 'OLLAMA_LOCAL',
      state: 'failed',
      requestJson: baseRequestJson(),
      telemetry: null,
      error: 'boom',
    });
    const row = projectReceipt(taskId)!;
    expect(row.cost_enforceable).toBeNull();
    expect(row.budget_source).toBeNull();
  });

  it('(e) result_state derivation: blocked fixture -> result_state=blocked, blocked_on set', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      state: 'completed', // taskStore.complete() marks blocked runs 'completed'
      requestJson: baseRequestJson(),
      telemetry: { blockedOn: 'filesystem__write_file' },
      result: '',
    });
    const row = projectReceipt(taskId)!;
    expect(row.result_state).toBe('blocked');
    expect(row.blocked_on).toBe('filesystem__write_file');
  });

  it('(e) cancelled fixture -> cancelled=1', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson(),
      telemetry: { cancelled: true, inferenceLatencyMs: 900, iterations: 2 },
    });
    const row = projectReceipt(taskId)!;
    expect(row.cancelled).toBe(1);
    // cancelled is surfaced via the cancelled column, not result_state.
    expect(row.result_state).toBe('completed');
  });

  it('(f) tools parsing: BOTH local ("Executing filesystem__write_file") and cloud shape, in seq order', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    // Local ollama.ts shape: emit('TOOL_CALL', `Executing ${realName}`, ...)
    emitEvent(sid, taskId, 'TOOL_CALL', 'Executing filesystem__write_file', { args: {} });
    // Cloud hermes_runner.py shape: task_store.emit(task_id, "TOOL_CALL", f"Executing {name}", ...)
    // — identical "Executing <name>" text shape from the Python f-string.
    emitEvent(sid, taskId, 'TOOL_CALL', 'Executing web_search__query', { call_id: 'c1', args: {} });

    const row = projectReceipt(taskId)!;
    const tools = JSON.parse(row.tools_called_json);
    expect(tools).toEqual(['filesystem__write_file', 'web_search__query']);
  });

  it('(f) tools parsing falls back gracefully when message does not match the prefix', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    emitEvent(sid, taskId, 'TOOL_CALL', 'some unexpected shape', { name: 'metadata_name_field' });
    const row = projectReceipt(taskId)!;
    const tools = JSON.parse(row.tools_called_json);
    // Falls back to metadata.name when the message doesn't match the prefix.
    expect(tools).toEqual(['metadata_name_field']);
  });

  it('(g) evidence range: evidence_start_seq/end_seq = min/max(seq) over all events for the task', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const s1 = emitEvent(sid, taskId, 'ROUTING', 'classified');
    emitEvent(sid, taskId, 'TIER_SELECTED', 'local', { tier: 'OLLAMA_LOCAL' });
    const s3 = emitEvent(sid, taskId, 'RESULT', 'done');

    const row = projectReceipt(taskId)!;
    expect(row.evidence_start_seq).toBe(s1);
    expect(row.evidence_end_seq).toBe(s3);
  });

  it('(g) evidence range is null when there are no events for the task', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const row = projectReceipt(taskId)!;
    expect(row.evidence_start_seq).toBeNull();
    expect(row.evidence_end_seq).toBeNull();
  });

  it('(h) source_channel: top-level request_json.sourceChannel is copied verbatim', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson({ sourceChannel: 'discord' }),
    });
    const row = projectReceipt(taskId)!;
    expect(row.source_channel).toBe('discord');
  });

  it('projectReceipt returns null when the tasks row is absent', () => {
    expect(projectReceipt(randomUUID())).toBeNull();
  });

  it('full_receipt_json folds approvals + evidence + route diagnostics into one composite object', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson({ sourceChannel: 'slack' }),
      telemetry: { costUsd: 0.1, inferenceLatencyMs: 200, iterations: 1 },
    });
    emitEvent(sid, taskId, 'TIER_SELECTED', 'local', { tier: 'OLLAMA_LOCAL', score: 1 });
    insertApproval(taskId, 'filesystem__write_file', 'approved');

    const row = projectReceipt(taskId)!;
    const full = JSON.parse(row.full_receipt_json);
    expect(full.taskId).toBe(taskId);
    expect(full.sourceChannel).toBe('slack');
    expect(full.approvals).toEqual([
      { status: 'approved', toolName: 'filesystem__write_file', decidedAt: expect.any(String) },
    ]);
    expect(full.routeDiagnostics).toEqual({ tier: 'OLLAMA_LOCAL', score: 1 });
  });

  it('projection_version is stamped with the current PROJECTION_VERSION', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const row = projectReceipt(taskId)!;
    expect(row.projection_version).toBe(PROJECTION_VERSION);
  });
});
