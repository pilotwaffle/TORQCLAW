import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// gateway modules open the DB at import time (storage.ts) — TORQCLAW_DATA_DIR
// MUST be set before the first import. Exact pattern of
// tests/spend-caps.test.ts / tests/receipts-read.test.ts.
process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-cost-summary-'));

const { db } = await import('../packages/gateway/src/storage.js');
const { handleGetCostSummary } = await import('../packages/gateway/src/spend.js');
const { sessionBus } = await import('../packages/gateway/src/events.js');

const SESSION_CAP = 'TORQCLAW_SESSION_CAP_USD';
const DAILY_CAP = 'TORQCLAW_DAILY_CAP_USD';

function makeSession(): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')`).run(id);
  return id;
}

function seedSpend(opts: {
  sessionId: string;
  costUsd: number | null;
  attribution: string;
  provider?: string | null;
}): string {
  const taskId = randomUUID();
  db.prepare(
    `INSERT INTO spend_ledger (id, task_id, session_id, source_channel, provider, cost_usd, attribution)
     VALUES (@id, @task_id, @session_id, @source_channel, @provider, @cost_usd, @attribution)`,
  ).run({
    id: randomUUID(),
    task_id: taskId,
    session_id: opts.sessionId,
    source_channel: null,
    provider: opts.provider ?? 'openai',
    cost_usd: opts.costUsd,
    attribution: opts.attribution,
  });
  return taskId;
}

function seedReceipt(opts: { sessionId: string; selectedTier: string }): void {
  const taskId = randomUUID();
  db.prepare(
    `INSERT INTO run_receipts (id, task_id, session_id, selected_tier, tools_called_json, full_receipt_json, projection_version)
     VALUES (?, ?, ?, ?, '[]', '{}', 1)`,
  ).run(randomUUID(), taskId, opts.sessionId, opts.selectedTier);
}

function rowCounts(): { spend_ledger: number; run_receipts: number; events: number } {
  const spend_ledger = (db.prepare(`SELECT COUNT(*) AS n FROM spend_ledger`).get() as { n: number }).n;
  const run_receipts = (db.prepare(`SELECT COUNT(*) AS n FROM run_receipts`).get() as { n: number }).n;
  const events = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  return { spend_ledger, run_receipts, events };
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

let savedSession: string | undefined;
let savedDaily: string | undefined;
beforeEach(() => {
  savedSession = process.env[SESSION_CAP];
  savedDaily = process.env[DAILY_CAP];
  delete process.env[SESSION_CAP];
  delete process.env[DAILY_CAP];
});
afterEach(() => {
  if (savedSession === undefined) delete process.env[SESSION_CAP]; else process.env[SESSION_CAP] = savedSession;
  if (savedDaily === undefined) delete process.env[DAILY_CAP]; else process.env[DAILY_CAP] = savedDaily;
});

describe('TCLAW-1B: handleGetCostSummary — read-only Cost Control Center surface', () => {
  it('publishes exactly one seq-less SYSTEM frame with metadata.costSummary=true, and performs zero writes', () => {
    const sid = makeSession();
    seedSpend({ sessionId: sid, costUsd: 1.5, attribution: 'exact' });

    const before = rowCounts();
    const frames = captureFrames(sid, () => handleGetCostSummary(sid, 20));
    const after = rowCounts();

    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe('SYSTEM');
    expect(frames[0].message).toBe('Cost summary');
    expect(frames[0].metadata.costSummary).toBe(true);
    expect('seq' in frames[0] ? frames[0].seq : undefined).toBeUndefined(); // publishOnly: no seq

    // ZERO WRITES: row counts unchanged before/after driving the handler.
    expect(after).toEqual(before);
  });

  it('sessionTotal excludes NULL rows and equals exact+account_delta (not +0 for unavailable)', () => {
    const sid = makeSession();
    seedSpend({ sessionId: sid, costUsd: 2.0, attribution: 'exact' });
    seedSpend({ sessionId: sid, costUsd: 3.0, attribution: 'account_delta' });
    seedSpend({ sessionId: sid, costUsd: null, attribution: 'unavailable' });

    const frames = captureFrames(sid, () => handleGetCostSummary(sid, 20));
    expect(frames[0].metadata.sessionTotal).toBe(5.0);
  });

  it('dailyTotal is GLOBAL across sessions (includes another session\'s spend)', () => {
    const sidA = makeSession();
    const sidB = makeSession();
    seedSpend({ sessionId: sidA, costUsd: 1.0, attribution: 'exact' });
    seedSpend({ sessionId: sidB, costUsd: 4.0, attribution: 'exact' });

    const frames = captureFrames(sidA, () => handleGetCostSummary(sidA, 20));
    // dailyTotal must reflect BOTH sessions' spend (global), while
    // sessionTotal must reflect only sidA's own spend.
    expect(frames[0].metadata.sessionTotal).toBe(1.0);
    expect(frames[0].metadata.dailyTotal).toBeGreaterThanOrEqual(5.0);
  });

  it('attributionCounts are SESSION-SCOPED: {exact:1, account_delta:1, unavailable:1} for this session only', () => {
    const sidA = makeSession();
    const sidB = makeSession();
    seedSpend({ sessionId: sidA, costUsd: 1.0, attribution: 'exact' });
    seedSpend({ sessionId: sidA, costUsd: 2.0, attribution: 'account_delta' });
    seedSpend({ sessionId: sidA, costUsd: null, attribution: 'unavailable' });
    // Other session's rows must not leak into sidA's counts.
    seedSpend({ sessionId: sidB, costUsd: 1.0, attribution: 'exact' });
    seedSpend({ sessionId: sidB, costUsd: 1.0, attribution: 'exact' });

    const frames = captureFrames(sidA, () => handleGetCostSummary(sidA, 20));
    expect(frames[0].metadata.attributionCounts).toEqual({ exact: 1, account_delta: 1, unavailable: 1 });
  });

  it('recentLedger carries NULL cost_usd through as null (never 0) and preserves the account_delta label', () => {
    const sid = makeSession();
    const unavailableId = seedSpend({ sessionId: sid, costUsd: null, attribution: 'unavailable' });
    const deltaId = seedSpend({ sessionId: sid, costUsd: 4.5, attribution: 'account_delta' });

    const frames = captureFrames(sid, () => handleGetCostSummary(sid, 20));
    const ledger = frames[0].metadata.recentLedger as any[];

    const unavailableRow = ledger.find((r) => r.taskId === unavailableId);
    expect(unavailableRow.costUsd).toBeNull();
    expect(unavailableRow.costUsd).not.toBe(0);
    expect(unavailableRow.attribution).toBe('unavailable');

    const deltaRow = ledger.find((r) => r.taskId === deltaId);
    expect(deltaRow.costUsd).toBeCloseTo(4.5);
    expect(deltaRow.attribution).toBe('account_delta');
  });

  it('providerSummary $ excludes NULL-cost rows and reports unrecordedCount', () => {
    const sid = makeSession();
    seedSpend({ sessionId: sid, costUsd: 2.0, attribution: 'exact', provider: 'openai' });
    seedSpend({ sessionId: sid, costUsd: null, attribution: 'unavailable', provider: 'openai' });

    const frames = captureFrames(sid, () => handleGetCostSummary(sid, 20));
    const providerSummary = frames[0].metadata.providerSummary as any[];
    const openai = providerSummary.find((p) => p.provider === 'openai');
    expect(openai.recordedUsd).toBeCloseTo(2.0); // NULL row excluded from the $ sum
    expect(openai.unrecordedCount).toBe(1);
    expect(openai.totalCount).toBe(2);
  });

  it('cloudTaskCount counts only API_EXTERNAL receipts for THIS session', () => {
    const sidA = makeSession();
    const sidB = makeSession();
    seedReceipt({ sessionId: sidA, selectedTier: 'API_EXTERNAL' });
    seedReceipt({ sessionId: sidA, selectedTier: 'API_EXTERNAL' });
    seedReceipt({ sessionId: sidA, selectedTier: 'OLLAMA_LOCAL' }); // must not count
    seedReceipt({ sessionId: sidB, selectedTier: 'API_EXTERNAL' }); // other session, must not count

    const frames = captureFrames(sidA, () => handleGetCostSummary(sidA, 20));
    expect(frames[0].metadata.cloudTaskCount).toBe(2);
  });

  it('caps come from env: session breach names "session" when sessionTotal >= cap', () => {
    const sid = makeSession();
    process.env[SESSION_CAP] = '5.00';
    seedSpend({ sessionId: sid, costUsd: 5.0, attribution: 'exact' });

    const frames = captureFrames(sid, () => handleGetCostSummary(sid, 20));
    const meta = frames[0].metadata;
    expect(meta.sessionCap).toBe(5.0);
    expect(meta.breach).toEqual({ cap: 'session', total: 5.0, limit: 5.0, envVar: SESSION_CAP });
  });

  it('cap unset -> sessionCap is null in the frame (never undefined/0), breach is null', () => {
    const sid = makeSession();
    seedSpend({ sessionId: sid, costUsd: 1.0, attribution: 'exact' });

    const frames = captureFrames(sid, () => handleGetCostSummary(sid, 20));
    const meta = frames[0].metadata;
    expect(meta.sessionCap).toBeNull();
    expect(meta.dailyCap).toBeNull();
    expect(meta.breach).toBeNull();
  });

  it('sessionRemaining/dailyRemaining are null when no cap is set (never a fabricated 0)', () => {
    const sid = makeSession();
    const frames = captureFrames(sid, () => handleGetCostSummary(sid, 20));
    const meta = frames[0].metadata;
    expect(meta.sessionRemaining).toBeNull();
    expect(meta.dailyRemaining).toBeNull();
  });

  it('recentLimit bounds the number of ledger rows returned', () => {
    const sid = makeSession();
    for (let i = 0; i < 5; i++) seedSpend({ sessionId: sid, costUsd: 1.0, attribution: 'exact' });

    const frames = captureFrames(sid, () => handleGetCostSummary(sid, 2));
    expect((frames[0].metadata.recentLedger as any[]).length).toBe(2);
  });
});
