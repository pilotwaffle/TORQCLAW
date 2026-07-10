import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// gateway modules open the DB at import time (storage.ts) — TORQCLAW_DATA_DIR
// MUST be set before the first import. Exact pattern of
// tests/spend-cost-summary.test.ts / tests/receipts-read.test.ts.
process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-preview-route-'));

// Real-classifier path in CI has no live Ollama: point OLLAMA_HOST at an
// unreachable address BEFORE the gateway (and therefore classifier.ts) is
// imported, so `fetch` fails fast and every non-mocked test in this file
// deterministically exercises the keyword-fallback branch of
// classifyTaskType — never a live LOCAL_LLM call. This is what proves case
// 10(a) (the honest fallback path) throughout the rest of the suite too.
process.env.OLLAMA_HOST = 'http://127.0.0.1:1';

const { db } = await import('../packages/gateway/src/storage.js');
const { handlePreviewRoute } = await import('../packages/gateway/src/preview.js');
const { sessionBus } = await import('../packages/gateway/src/events.js');
const { authorize } = await import('../packages/gateway/src/authz.js');

function makeSession(): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')`).run(id);
  return id;
}

/** rowCounts + snapshotStates: mirrors receipts-read.test.ts:115-135 exactly
 *  — counts alone miss same-row-count UPDATEs, so we pair them with a
 *  byte-level dump of mutable state across every table the preview handler
 *  could conceivably touch. */
function rowCounts(): {
  events: number;
  tasks: number;
  tool_approvals: number;
  spend_ledger: number;
  run_receipts: number;
} {
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    events: count('events'),
    tasks: count('tasks'),
    tool_approvals: count('tool_approvals'),
    spend_ledger: count('spend_ledger'),
    run_receipts: count('run_receipts'),
  };
}

function snapshotStates(): { taskStates: string[]; approvalStates: string[]; receiptsDump: string; eventsDump: string } {
  const taskStates = (db.prepare(`SELECT state FROM tasks ORDER BY request_id`).all() as { state: string }[]).map((r) => r.state);
  const approvalStates = (db.prepare(`SELECT status FROM tool_approvals ORDER BY approval_id`).all() as { status: string }[]).map((r) => r.status);
  const receiptsDump = JSON.stringify(db.prepare(`SELECT * FROM run_receipts ORDER BY task_id`).all());
  const eventsDump = JSON.stringify(db.prepare(`SELECT * FROM events ORDER BY seq`).all());
  return { taskStates, approvalStates, receiptsDump, eventsDump };
}

/** Targeted count for legibility: proves specifically that no USER_PROMPT,
 *  ROUTING, or TIER_SELECTED row ever lands in events — the exact three
 *  emissions the live SUBMIT_PROMPT path makes that PREVIEW_ROUTE must skip. */
function userPromptRoutingTierSelectedCount(): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE type IN ('USER_PROMPT', 'TIER_SELECTED', 'ROUTING')`)
      .get() as { n: number }
  ).n;
}

/** Capture every frame the REAL handler publishes to the session's bus while
 *  fn runs — exactly what a connected ws client would receive. */
async function captureFrames(sessionId: string, fn: () => Promise<void>): Promise<any[]> {
  const frames: any[] = [];
  const unsubscribe = sessionBus.subscribe(sessionId, (ev) => frames.push(ev));
  try {
    await fn();
  } finally {
    unsubscribe();
  }
  return frames;
}

function basePreviewCmd(overrides: Partial<any> = {}) {
  return {
    action: 'PREVIEW_ROUTE' as const,
    previewOf: 'n1',
    prompt: 'summarize this text',
    sensitive: false,
    urgent: false,
    executionMode: 'AUTO' as const,
    useMemory: true,
    ...overrides,
  };
}

describe('TCLAW-2D-1: handlePreviewRoute — read-only route preview surface', () => {
  it('1. real evaluator: frame carries real RouterDiagnostics (score/reason/tier/ruleId/humanReason/overridable)', async () => {
    const sid = makeSession();
    const before = rowCounts();
    const beforeStates = snapshotStates();

    const frames = await captureFrames(sid, () => handlePreviewRoute(sid, basePreviewCmd()));

    expect(frames.length).toBe(1);
    const diag = frames[0].metadata.diagnostics;
    expect(typeof diag.score).toBe('number');
    expect(typeof diag.reason).toBe('string');
    expect(typeof diag.tier).toBe('string');
    expect(typeof diag.ruleId).toBe('string');
    expect(typeof diag.humanReason).toBe('string');
    expect(typeof diag.overridable).toBe('boolean');

    expect(rowCounts()).toEqual(before);
    expect(snapshotStates()).toEqual(beforeStates);
  });

  it('1b. sensitive:true proves the real rule hierarchy runs (PRIVACY_OVERRIDE -> SENSITIVE_DATA -> OLLAMA_LOCAL)', async () => {
    const sid = makeSession();
    const frames = await captureFrames(sid, () =>
      handlePreviewRoute(sid, basePreviewCmd({ sensitive: true })),
    );
    const diag = frames[0].metadata.diagnostics;
    expect(diag.ruleId).toBe('PRIVACY_OVERRIDE');
    expect(diag.safetyLock).toBe('SENSITIVE_DATA');
    expect(diag.tier).toBe('OLLAMA_LOCAL');
  });

  it('2. previewOf is echoed verbatim (and a different nonce echoes that one)', async () => {
    const sid = makeSession();
    const frames1 = await captureFrames(sid, () => handlePreviewRoute(sid, basePreviewCmd({ previewOf: 'n1' })));
    expect(frames1[0].metadata.previewOf).toBe('n1');

    const frames2 = await captureFrames(sid, () => handlePreviewRoute(sid, basePreviewCmd({ previewOf: 'n2-different' })));
    expect(frames2[0].metadata.previewOf).toBe('n2-different');
  });

  it('3. transient: frame has no seq, type SYSTEM, requestId null', async () => {
    const sid = makeSession();
    const frames = await captureFrames(sid, () => handlePreviewRoute(sid, basePreviewCmd()));
    const frame = frames[0];
    expect('seq' in frame ? frame.seq : undefined).toBeUndefined();
    expect(frame.type).toBe('SYSTEM');
    expect(frame.requestId).toBeNull();
  });

  it('4-9+11. ZERO-WRITE PROOF: counts + state snapshots unchanged across events/tasks/tool_approvals/spend_ledger/run_receipts; no USER_PROMPT/TIER_SELECTED/ROUTING row at all', async () => {
    const sid = makeSession();
    const before = rowCounts();
    const beforeStates = snapshotStates();
    const beforeTargeted = userPromptRoutingTierSelectedCount();
    expect(before.events).toBe(0); // sanity: truly zero events before we start

    await captureFrames(sid, () => handlePreviewRoute(sid, basePreviewCmd()));
    // A second call (sensitive variant) for good measure — still zero writes.
    await captureFrames(sid, () => handlePreviewRoute(sid, basePreviewCmd({ sensitive: true, previewOf: 'n2' })));

    const after = rowCounts();
    const afterStates = snapshotStates();
    const afterTargeted = userPromptRoutingTierSelectedCount();

    expect(after).toEqual(before);
    expect(after.events).toBe(0); // NO events row AT ALL — covers #4, #9, #11
    expect(afterStates).toEqual(beforeStates);
    expect(afterTargeted).toBe(0);
    expect(afterTargeted).toBe(beforeTargeted);
  });

  it('10a. fallback path (unreachable OLLAMA_HOST): classifierUsed is an honest lower-fidelity label, zero writes', async () => {
    const sid = makeSession();
    const before = rowCounts();

    const frames = await captureFrames(sid, () => handlePreviewRoute(sid, basePreviewCmd({ prompt: 'summarize this changelog' })));

    const enrichment = frames[0].metadata.enrichment;
    expect(['KEYWORD_FALLBACK', 'DEFAULT']).toContain(enrichment.classifierUsed);

    expect(rowCounts()).toEqual(before);
  });

  it('assembledContext and payload never leak onto the frame metadata', async () => {
    const sid = makeSession();
    const frames = await captureFrames(sid, () => handlePreviewRoute(sid, basePreviewCmd()));
    const meta = frames[0].metadata;
    expect('assembledContext' in meta).toBe(false);
    expect('payload' in meta).toBe(false);
  });

  it('authz: operator allowed, channel denied, node denied', () => {
    const ctx = { sessionId: 'sid', lookupTaskSession: () => null };
    const cmd = basePreviewCmd();
    expect(authorize('operator', cmd as any, ctx)).toEqual({ ok: true });
    expect(authorize('channel', cmd as any, ctx).ok).toBe(false);
    expect(authorize('node', cmd as any, ctx).ok).toBe(false);
  });
});

describe('TCLAW-2D-1: single-flight latch — one inference, honest drop, latch release', () => {
  it('13. second concurrent call drops honestly (dropped:in_flight, own nonce echoed), only ONE enrichment ran, zero writes from both; a third call after completion succeeds normally', async () => {
    const sid = makeSession();
    const before = rowCounts();

    // Hold the classifier open with a manually-resolved promise so the FIRST
    // handlePreviewRoute call's `await enrichCommand(...)` is still pending
    // when we fire the second call — proving true concurrency, not just
    // sequential awaits.
    let releaseClassifier!: () => void;
    const gate = new Promise<void>((resolve) => { releaseClassifier = resolve; });

    const classifierModule = await import('../packages/gateway/src/classifier.js');
    let classifierCallCount = 0;
    const spy = vi.spyOn(classifierModule, 'classifyTaskType').mockImplementation(async () => {
      classifierCallCount++;
      await gate;
      return { taskType: 'SUMMARIZATION', confidence: 0.95, method: 'LOCAL_LLM' as const, latencyMs: 5 };
    });

    try {
      const frames: any[] = [];
      const unsubscribe = sessionBus.subscribe(sid, (ev) => frames.push(ev));

      // Fire the first call WITHOUT awaiting it yet.
      const { handlePreviewRoute } = await import('../packages/gateway/src/preview.js');
      const first = handlePreviewRoute(sid, basePreviewCmd({ previewOf: 'first' }));

      // Give the microtask queue a tick so `first` reaches the pending
      // classifier await and registers itself in the in-flight latch.
      await Promise.resolve();
      await Promise.resolve();

      // Second call while the first is still in flight: must drop immediately.
      await handlePreviewRoute(sid, basePreviewCmd({ previewOf: 'second' }));

      // Release the first call's classifier and let it finish.
      releaseClassifier();
      await first;

      unsubscribe();

      expect(frames.length).toBe(2);
      const dropFrame = frames.find((f) => f.metadata.previewOf === 'second')!;
      const okFrame = frames.find((f) => f.metadata.previewOf === 'first')!;
      expect(dropFrame.metadata.dropped).toBe('in_flight');
      expect(okFrame.metadata.dropped).toBeUndefined();
      expect(okFrame.metadata.diagnostics).toBeDefined();

      // Only ONE real inference ran, even though two handlePreviewRoute calls fired.
      expect(classifierCallCount).toBe(1);

      expect(rowCounts()).toEqual(before);

      // Latch released: a third call after completion succeeds normally.
      const thirdFrames = await captureFrames(sid, () => handlePreviewRoute(sid, basePreviewCmd({ previewOf: 'third' })));
      expect(thirdFrames.length).toBe(1);
      expect(thirdFrames[0].metadata.dropped).toBeUndefined();
      expect(thirdFrames[0].metadata.previewOf).toBe('third');
      expect(classifierCallCount).toBe(2); // the third call is its own fresh inference

      expect(rowCounts()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
});
