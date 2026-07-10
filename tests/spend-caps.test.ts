import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// gateway modules open the DB at import time (storage.ts) — TORQCLAW_DATA_DIR
// MUST be set before the first import. Exact pattern of
// tests/receipt-projection.test.ts / tests/sessions-memory.test.ts.
process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-spend-caps-'));

const { db } = await import('../packages/gateway/src/storage.js');
const spend = await import('../packages/gateway/src/spend.js');
const {
  resolveSessionCap, resolveDailyCap, sessionTotal, dailyTotal, evaluateCaps,
  recordSpend, recordSpendSafe, resolveBudgetWithSource,
  SESSION_CAP_ENV_VAR, DAILY_CAP_ENV_VAR,
} = spend;
const { dispatch } = await import('../packages/gateway/src/dispatch.js');
const { taskStore } = await import('../packages/gateway/src/events.js');
const { projectReceipt } = await import('../packages/gateway/src/receipts.js');
const { makeRequest } = await import('./helpers.js');

// The bridge namespace dispatch.ts itself imports (@torqclaw/bridge resolves to
// packages/bridge/dist/index.js — the SAME module singleton). Imported via the
// dist path here because the bare '@torqclaw/bridge' specifier is not resolvable
// from the tests dir under the vitest config, but the dist file is. Because it
// is the same singleton, vi.spyOn on these exports is seen at dispatch's call
// site — this is what lets the breach test below drive dispatch's REAL breach
// catch (not a hand-rolled recordSpend) and keeps CircuitBreakerError identity
// consistent so `error instanceof CircuitBreakerError` holds inside dispatch.
const bridge = await import('../packages/bridge/dist/index.js');

const SESSION_CAP = 'TORQCLAW_SESSION_CAP_USD';
const DAILY_CAP = 'TORQCLAW_DAILY_CAP_USD';

function makeSession(): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')`).run(id);
  return id;
}

function getTask(requestId: string): any {
  return db.prepare(`SELECT * FROM tasks WHERE request_id = ?`).get(requestId);
}

function getLedgerRow(taskId: string): any {
  return db.prepare(`SELECT * FROM spend_ledger WHERE task_id = ?`).get(taskId);
}

function ledgerCount(taskId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM spend_ledger WHERE task_id = ?`).get(taskId) as { n: number }).n;
}

/** Insert a spend_ledger row directly (bypassing recordSpend) — used to seed
 *  running totals for cap-gate tests without needing a real dispatch. */
function seedSpend(opts: {
  sessionId: string; costUsd: number | null; attribution?: string; createdAt?: string;
}): void {
  db.prepare(
    `INSERT INTO spend_ledger (id, task_id, session_id, source_channel, provider, cost_usd, attribution, created_at)
     VALUES (@id, @task_id, @session_id, @source_channel, @provider, @cost_usd, @attribution, COALESCE(@created_at, CURRENT_TIMESTAMP))`,
  ).run({
    id: randomUUID(),
    task_id: randomUUID(),
    session_id: opts.sessionId,
    source_channel: null,
    provider: null,
    cost_usd: opts.costUsd,
    attribution: opts.attribution ?? (opts.costUsd === null ? 'unavailable' : 'reported'),
    created_at: opts.createdAt ?? null,
  });
}

// Save/restore the two cap env vars + the default-max-cost env var across
// every test in this file (dispatch/spend read them live).
let savedSession: string | undefined;
let savedDaily: string | undefined;
let savedDefault: string | undefined;
beforeEach(() => {
  savedSession = process.env[SESSION_CAP];
  savedDaily = process.env[DAILY_CAP];
  savedDefault = process.env.TORQCLAW_DEFAULT_MAX_COST;
  delete process.env[SESSION_CAP];
  delete process.env[DAILY_CAP];
  delete process.env.TORQCLAW_DEFAULT_MAX_COST;
});
afterEach(() => {
  if (savedSession === undefined) delete process.env[SESSION_CAP]; else process.env[SESSION_CAP] = savedSession;
  if (savedDaily === undefined) delete process.env[DAILY_CAP]; else process.env[DAILY_CAP] = savedDaily;
  if (savedDefault === undefined) delete process.env.TORQCLAW_DEFAULT_MAX_COST; else process.env.TORQCLAW_DEFAULT_MAX_COST = savedDefault;
});

describe('TCLAW-1A-core: env var names', () => {
  it('exports the exact env var names the refusal message must cite', () => {
    expect(SESSION_CAP_ENV_VAR).toBe(SESSION_CAP);
    expect(DAILY_CAP_ENV_VAR).toBe(DAILY_CAP);
  });
});

describe('TCLAW-1A-core: cap resolution ($0/negative/unset => unlimited)', () => {
  it('(4) $0 session cap => unlimited (undefined), never "block all"', () => {
    process.env[SESSION_CAP] = '0';
    expect(resolveSessionCap()).toBeUndefined();
  });
  it('(5) $0 daily cap => unlimited (undefined)', () => {
    process.env[DAILY_CAP] = '0';
    expect(resolveDailyCap()).toBeUndefined();
  });
  it('negative/non-numeric/unset session cap => unlimited', () => {
    expect(resolveSessionCap()).toBeUndefined(); // unset
    process.env[SESSION_CAP] = '-5';
    expect(resolveSessionCap()).toBeUndefined();
    process.env[SESSION_CAP] = 'nope';
    expect(resolveSessionCap()).toBeUndefined();
  });
  it('a finite positive value IS honored as a cap', () => {
    process.env[SESSION_CAP] = '5.00';
    expect(resolveSessionCap()).toBe(5);
    process.env[DAILY_CAP] = '25';
    expect(resolveDailyCap()).toBe(25);
  });
});

describe('TCLAW-1A-core: evaluateCaps (pure decision)', () => {
  it('(1) session cap allows a total below the limit', () => {
    expect(evaluateCaps(4.99, 0, 5.0, undefined)).toBeNull();
  });
  it('(2) session cap blocks at/above the limit', () => {
    const breach = evaluateCaps(5.0, 0, 5.0, undefined);
    expect(breach).toEqual({ cap: 'session', total: 5.0, limit: 5.0, envVar: SESSION_CAP });
  });
  it('daily cap blocks at/above the limit when session is fine', () => {
    const breach = evaluateCaps(0, 10.0, undefined, 10.0);
    expect(breach).toEqual({ cap: 'daily', total: 10.0, limit: 10.0, envVar: DAILY_CAP });
  });
  it('undefined caps never breach (unlimited)', () => {
    expect(evaluateCaps(1_000_000, 1_000_000, undefined, undefined)).toBeNull();
  });
  it('session breach takes precedence when both would breach', () => {
    const breach = evaluateCaps(5.0, 10.0, 5.0, 10.0);
    expect(breach?.cap).toBe('session');
  });
});

describe('TCLAW-1A-core: sessionTotal / dailyTotal (SUM semantics)', () => {
  it('(11) sums reported spend for a session', () => {
    const sid = randomUUID();
    seedSpend({ sessionId: sid, costUsd: 1.5 });
    seedSpend({ sessionId: sid, costUsd: 2.5 });
    expect(sessionTotal(sid)).toBe(4.0);
  });
  it('(13) unavailable (NULL cost) rows are EXCLUDED from SUM, never counted as $0', () => {
    const sid = randomUUID();
    seedSpend({ sessionId: sid, costUsd: 3.0 });
    seedSpend({ sessionId: sid, costUsd: null, attribution: 'unavailable' });
    expect(sessionTotal(sid)).toBe(3.0); // not 3.0 diluted, not treated as extra $0 rows either
  });
  it('sessionTotal is 0 (not null/NaN) for a session with no spend', () => {
    expect(sessionTotal(randomUUID())).toBe(0);
  });
  it('(3) dailyTotal sums only rows created today (UTC start-of-day window)', () => {
    const sid = randomUUID();
    seedSpend({ sessionId: sid, costUsd: 7.0 }); // created_at defaults to now
    seedSpend({
      sessionId: sid, costUsd: 999.0,
      createdAt: `${new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')}`,
    }); // 2 days ago — must be excluded
    const total = dailyTotal();
    expect(total).toBeGreaterThanOrEqual(7.0);
    expect(total).toBeLessThan(999.0); // the old row must not be included
  });
});

describe('TCLAW-1A-core: recordSpend (idempotent, honest attribution)', () => {
  it('(11) costSource="exact" => attribution="exact", cost kept', () => {
    const taskId = randomUUID();
    const sid = randomUUID();
    recordSpend({ taskId, sessionId: sid, costUsd: 1.23, costSource: 'exact' });
    const row = getLedgerRow(taskId);
    expect(row.cost_usd).toBeCloseTo(1.23);
    expect(row.attribution).toBe('exact');
  });
  it('TCLAW-1A-attr: costSource="account_delta" => attribution="account_delta", number STILL counted in sessionTotal', () => {
    const taskId = randomUUID();
    const sid = randomUUID();
    recordSpend({ taskId, sessionId: sid, costUsd: 4.5, costSource: 'account_delta' });
    const row = getLedgerRow(taskId);
    expect(row.cost_usd).toBeCloseTo(4.5);
    expect(row.attribution).toBe('account_delta');
    // Enforcement math unchanged: an account_delta row counts in the SUM
    // exactly like any other numeric row — the tag only labels precision.
    expect(sessionTotal(sid)).toBeCloseTo(4.5);
  });
  it('(13) missing/non-number cost, or no costSource => cost_usd NULL, attribution="unavailable", never a fabricated 0', () => {
    const taskId = randomUUID();
    const sid = randomUUID();
    recordSpend({ taskId, sessionId: sid, costUsd: undefined });
    const row = getLedgerRow(taskId);
    expect(row.cost_usd).toBeNull();
    expect(row.attribution).toBe('unavailable');
    expect(sessionTotal(sid)).toBe(0); // never counted as $0-that-is-really-something
  });
  it('TCLAW-1A-attr: a real number with NO costSource is treated as unavailable (correctness-honest fallback), excluded from SUM', () => {
    const taskId = randomUUID();
    const sid = randomUUID();
    recordSpend({ taskId, sessionId: sid, costUsd: 42.0 }); // no costSource passed
    const row = getLedgerRow(taskId);
    expect(row.cost_usd).toBeNull();
    expect(row.attribution).toBe('unavailable');
    expect(sessionTotal(sid)).toBe(0);
  });
  it('(16) double recordSpend on the same task_id inserts exactly ONE row (ON CONFLICT DO NOTHING)', () => {
    const taskId = randomUUID();
    const sid = randomUUID();
    recordSpend({ taskId, sessionId: sid, costUsd: 1.0, costSource: 'exact' });
    recordSpend({ taskId, sessionId: sid, costUsd: 999.0, costSource: 'exact' }); // must NOT overwrite/duplicate
    expect(ledgerCount(taskId)).toBe(1);
    expect(getLedgerRow(taskId).cost_usd).toBeCloseTo(1.0); // first write wins, no double-count
  });
  it('recordSpendSafe never throws even if the underlying insert fails', () => {
    // Pass an impossible sessionId type scenario is hard to force without
    // dropping the table; instead prove the guarded wrapper swallows a real
    // thrown error by temporarily dropping spend_ledger.
    db.exec('DROP TABLE spend_ledger');
    try {
      expect(() => recordSpendSafe({ taskId: randomUUID(), sessionId: randomUUID(), costUsd: 1, costSource: 'exact' })).not.toThrow();
    } finally {
      const schemaPath = fileURLToPath(new URL('../packages/gateway/db/schema.sql', import.meta.url));
      db.exec(readFileSync(schemaPath, 'utf8'));
    }
  });
  it('legacy attribution="reported" seed row (pre-1A-attr) still sums correctly — enforcement is value-agnostic', () => {
    const sid = randomUUID();
    seedSpend({ sessionId: sid, costUsd: 6.0, attribution: 'reported' });
    expect(sessionTotal(sid)).toBeCloseTo(6.0);
  });
  it('cap enforcement math unchanged: an exact row and an account_delta row both count toward the SUM/cap', () => {
    const taskId1 = randomUUID();
    const taskId2 = randomUUID();
    const sid = randomUUID();
    recordSpend({ taskId: taskId1, sessionId: sid, costUsd: 1.0, costSource: 'exact' });
    recordSpend({ taskId: taskId2, sessionId: sid, costUsd: 2.0, costSource: 'account_delta' });
    expect(sessionTotal(sid)).toBeCloseTo(3.0);
    // A cap set to exactly the combined total breaches, proving both rows
    // fed the same raw SUM the cap gate checks (no netting/filtering).
    expect(evaluateCaps(sessionTotal(sid), 0, 3.0, undefined)).toEqual({
      cap: 'session', total: 3.0, limit: 3.0, envVar: SESSION_CAP_ENV_VAR,
    });
  });
});

describe('TCLAW-1A-attr: breach path preserves cost + label (anti-regression for correction A)', () => {
  // NOTE (teeth scope): this first test is a UNIT test of recordSpend's
  // tag->attribution mapping ONLY. It calls recordSpend directly with a
  // hardcoded costSource, so it does NOT exercise — and cannot fail on a
  // regression of — dispatch.ts's breach-path threading (the isBudget catch
  // reading CircuitBreakerError.lastCostSource and passing it to
  // recordSpendSafe). The DISPATCH-LEVEL teeth for that end-to-end path live
  // in the next test, which drives a real breach through dispatch().
  it('recordSpend unit: costSource="exact" on a breach-shaped call maps to attribution="exact", cost NON-NULL (not unavailable), counted in SUM', () => {
    const taskId = randomUUID();
    const sid = randomUUID();
    // Shape mirrors what dispatch's breach recordSpendSafe passes: costUsd from
    // CircuitBreakerError.lastCostUsd, costSource from lastCostSource. This only
    // proves recordSpend's own mapping — the wiring that FEEDS these values is
    // asserted by the dispatch-level test below.
    recordSpend({
      taskId, sessionId: sid,
      costUsd: 9.99,
      costSource: 'exact',
    });
    const row = getLedgerRow(taskId);
    expect(row.cost_usd).toBeCloseTo(9.99);
    expect(row.cost_usd).not.toBeNull();
    expect(row.attribution).toBe('exact');
    expect(row.attribution).not.toBe('unavailable');
    // The breach cost must count toward enforcement, exactly like a normal
    // SUCCESS row — a breach must not let its own cost escape the cap SUM.
    expect(sessionTotal(sid)).toBeCloseTo(9.99);
  });

  it('recordSpend unit: costSource="account_delta" maps to attribution="account_delta", not unavailable', () => {
    const taskId = randomUUID();
    const sid = randomUUID();
    recordSpend({ taskId, sessionId: sid, costUsd: 5.5, costSource: 'account_delta' });
    const row = getLedgerRow(taskId);
    expect(row.cost_usd).toBeCloseTo(5.5);
    expect(row.attribution).toBe('account_delta');
  });

  // ── THE LOAD-BEARING DISPATCH-LEVEL TEETH ─────────────────────────────────
  // This drives a REAL budget breach through dispatch(): a stubbed bridge
  // throws a real CircuitBreakerError (carrying lastCostUsd + lastCostSource,
  // exactly as hermes.ts's breach throw does), dispatch's isBudget catch runs
  // against the real temp DB, and we assert the spend_ledger row for the
  // breached task is cost_usd NON-NULL with the label from lastCostSource.
  //
  // TEETH: if dispatch.ts's breach recordSpendSafe stops passing
  // costSource (i.e. threads costSource: undefined), the row becomes
  // attribution='unavailable' / cost_usd NULL and THIS TEST FAILS — closing
  // the gap the direct-recordSpend unit test above could not cover. Proven by
  // sabotaging dispatch.ts and observing the red (see the ticket's teeth-check).
  //
  // The spy targets the SAME bridge module singleton dispatch imports (see the
  // top-of-file `bridge` import note), so both isHermesAvailable() and
  // executeHermesTask() are overridden at dispatch's own call site, and the
  // thrown CircuitBreakerError keeps the identity dispatch's `instanceof` needs.
  it('LOAD-BEARING (dispatch-level): a real budget breach through dispatch() records a NON-NULL spend_ledger row labeled from CircuitBreakerError.lastCostSource — NOT unavailable/NULL', async () => {
    const sid = makeSession();
    const reqId = randomUUID();

    // Force the FRONTIER path into the async IIFE (past the FRONTIER-unavailable
    // early-out) and make the engine poll "breach": executeHermesTask throws a
    // real CircuitBreakerError with a reported cost + its provenance tag, just
    // like the live mid-run breaker does at hermes.ts's breach throw.
    const availSpy = vi.spyOn(bridge, 'isHermesAvailable').mockReturnValue(true);
    const execSpy = vi
      .spyOn(bridge, 'executeHermesTask')
      .mockRejectedValue(
        new bridge.CircuitBreakerError('Budget exceeded: $9.99 of $1.00 limit', 9.99, 'exact'),
      );
    try {
      const req = { ...makeRequest({ taskType: 'AUTONOMOUS_RESEARCH' }), id: reqId, sessionId: sid };
      // No cap set (SESSION/DAILY cap envs are cleared in beforeEach) so the cap
      // GATE does not fire — the ONLY terminal is the mid-run BUDGET breach.
      dispatch(req as any, { score: 10, reason: 'test', tier: 'API_EXTERNAL' as any });

      // dispatch's execution is a fire-and-forget async IIFE — poll for the
      // ledger row the breach catch writes.
      let row: any;
      for (let i = 0; i < 100; i++) {
        row = getLedgerRow(reqId);
        if (row) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      // The task ended as a BUDGET breach (proves the isBudget catch ran, not
      // some other failure path).
      expect(getTask(reqId).error).toMatch(/^BUDGET:/);

      // THE ASSERTION WITH TEETH: the breach cost is preserved NON-NULL with
      // the label threaded from lastCostSource. If dispatch stops threading
      // costSource, this row is attribution='unavailable' / cost_usd NULL and
      // every line below fails.
      expect(row).toBeTruthy();
      expect(row.cost_usd).not.toBeNull();
      expect(row.cost_usd).toBeCloseTo(9.99);
      expect(row.attribution).toBe('exact');
      expect(row.attribution).not.toBe('unavailable');
      // And the preserved breach cost counts toward the cap SUM (correction A).
      expect(sessionTotal(sid)).toBeCloseTo(9.99);
    } finally {
      execSpy.mockRestore();
      availSpy.mockRestore();
    }
  });

  it('dispatch-level: a breach whose lastCostSource is "account_delta" is labeled account_delta end-to-end (still non-null, still counted)', async () => {
    const sid = makeSession();
    const reqId = randomUUID();
    const availSpy = vi.spyOn(bridge, 'isHermesAvailable').mockReturnValue(true);
    const execSpy = vi
      .spyOn(bridge, 'executeHermesTask')
      .mockRejectedValue(
        new bridge.CircuitBreakerError('Budget exceeded: $5.50 of $1.00 limit', 5.5, 'account_delta'),
      );
    try {
      const req = { ...makeRequest({ taskType: 'AUTONOMOUS_RESEARCH' }), id: reqId, sessionId: sid };
      dispatch(req as any, { score: 10, reason: 'test', tier: 'API_EXTERNAL' as any });
      let row: any;
      for (let i = 0; i < 100; i++) {
        row = getLedgerRow(reqId);
        if (row) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(row).toBeTruthy();
      expect(row.cost_usd).toBeCloseTo(5.5);
      expect(row.attribution).toBe('account_delta');
      expect(sessionTotal(sid)).toBeCloseTo(5.5);
    } finally {
      execSpy.mockRestore();
      availSpy.mockRestore();
    }
  });

  it('CircuitBreakerError carries lastCostSource alongside lastCostUsd (bridge-side wiring)', async () => {
    const { CircuitBreakerError } = await import('../packages/bridge/src/hermes.js');
    const e = new CircuitBreakerError('Budget exceeded: $9.99 of $1.00 limit', 9.99, 'exact');
    expect(e.lastCostUsd).toBe(9.99);
    expect(e.lastCostSource).toBe('exact');
  });

  it('CircuitBreakerError.lastCostSource is undefined (not fabricated) when no source was ever reported', async () => {
    const { CircuitBreakerError } = await import('../packages/bridge/src/hermes.js');
    const e = new CircuitBreakerError('Budget exceeded: $0.00 of $0.00 limit');
    expect(e.lastCostUsd).toBeUndefined();
    expect(e.lastCostSource).toBeUndefined();
  });
});

describe('TCLAW-1A-core: resolveBudgetWithSource', () => {
  it('per-request maxCost => source=per_task', () => {
    const out = resolveBudgetWithSource(makeRequest({ maxCost: 0.5 }));
    expect(out).toEqual({ budget: 0.5, source: 'per_task' });
  });
  it('env default => source=env_default', () => {
    process.env.TORQCLAW_DEFAULT_MAX_COST = '2.00';
    const out = resolveBudgetWithSource(makeRequest({}));
    expect(out).toEqual({ budget: 2.0, source: 'env_default' });
  });
  it('neither set => source=unlimited, budget undefined', () => {
    const out = resolveBudgetWithSource(makeRequest({}));
    expect(out).toEqual({ budget: undefined, source: 'unlimited' });
  });
});

describe('TCLAW-1A-core: cap GATE via dispatch() — FRONTIER-only, before spend', () => {
  it('(2) session cap blocks a FRONTIER task BEFORE any execute call: one terminal ERROR, metadata.kind=CAP_EXCEEDED, no ledger row', async () => {
    const sid = makeSession();
    process.env[SESSION_CAP] = '1.00';
    seedSpend({ sessionId: sid, costUsd: 1.00 }); // already at the cap

    const req = { ...makeRequest({ taskType: 'AUTONOMOUS_RESEARCH' }), id: randomUUID(), sessionId: sid };
    const events: any[] = [];
    const unsub = (await import('../packages/gateway/src/events.js')).sessionBus.subscribe(sid, (e) => events.push(e));

    dispatch(req as any, { score: 10, reason: 'test', tier: 'API_EXTERNAL' as any });
    // dispatch's cap gate runs SYNCHRONOUSLY before the async IIFE — no await needed.
    unsub();

    const task = getTask(req.id);
    expect(task.state).toBe('failed');
    expect(task.error).toMatch(/^CAP_EXCEEDED: session/);

    const errorEvents = events.filter((e) => e.type === 'ERROR');
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].metadata.kind).toBe('CAP_EXCEEDED');
    expect(errorEvents[0].metadata.cap).toBe('session');
    expect(errorEvents[0].metadata.recovery).toEqual(['RETRY_LOCAL', 'COPY_DIAGNOSTIC']);

    // No provider call was made => no NEW ledger row for this refused task.
    expect(getLedgerRow(req.id)).toBeUndefined();

    // A receipt was still materialized for the refused (auditable) task.
    const receipt = projectReceipt(req.id);
    expect(receipt).toBeTruthy();
    expect(receipt!.result_state).toBe('failed');
  });

  it('(1) below the cap: FRONTIER task is NOT gated (falls through past the gate to normal dispatch)', async () => {
    const sid = makeSession();
    process.env[SESSION_CAP] = '100.00';
    seedSpend({ sessionId: sid, costUsd: 1.00 }); // well under the $100 cap

    const req = { ...makeRequest({ taskType: 'AUTONOMOUS_RESEARCH' }), id: randomUUID(), sessionId: sid };
    dispatch(req as any, { score: 10, reason: 'test', tier: 'API_EXTERNAL' as any });

    const task = getTask(req.id);
    // Not immediately failed by the cap gate (state is 'running' — the async
    // IIFE will go on to try the hermes bridge, which is not stubbed here and
    // will itself eventually fail/timeout out of band; the key assertion is
    // that the CAP gate specifically did not fire).
    expect(task.error === null || !/^CAP_EXCEEDED/.test(task.error)).toBe(true);
  });

  it('(14) LOCAL_EDGE is never gated by any cap, regardless of session total', async () => {
    const sid = makeSession();
    process.env[SESSION_CAP] = '0.01'; // effectively zero headroom
    seedSpend({ sessionId: sid, costUsd: 1000 }); // way over

    const req = { ...makeRequest({ taskType: 'SUMMARIZATION' }), id: randomUUID(), sessionId: sid };
    const events: any[] = [];
    const unsub = (await import('../packages/gateway/src/events.js')).sessionBus.subscribe(sid, (e) => events.push(e));
    dispatch(req as any, { score: 1, reason: 'local', tier: 'OLLAMA_LOCAL' as any });
    unsub();

    const task = getTask(req.id);
    expect(task.error === null || !/^CAP_EXCEEDED/.test(task.error ?? '')).toBe(true);
    // No CAP_EXCEEDED ERROR was emitted synchronously for the local task.
    expect(events.some((e) => e.metadata?.kind === 'CAP_EXCEEDED')).toBe(false);
  });

  it('(17) refusal message cites the exact env var name; daily breach message notes the UTC reset', async () => {
    const sid = makeSession();
    process.env[DAILY_CAP] = '2.00';
    seedSpend({ sessionId: sid, costUsd: 2.00 });

    const req = { ...makeRequest({ taskType: 'AUTONOMOUS_RESEARCH' }), id: randomUUID(), sessionId: sid };
    const events: any[] = [];
    const unsub = (await import('../packages/gateway/src/events.js')).sessionBus.subscribe(sid, (e) => events.push(e));
    dispatch(req as any, { score: 10, reason: 'test', tier: 'API_EXTERNAL' as any });
    unsub();

    const errorEvent = events.find((e) => e.type === 'ERROR');
    expect(errorEvent.message).toContain(DAILY_CAP);
    expect(errorEvent.message).toMatch(/00:00 UTC/);
    expect(errorEvent.message).toMatch(/conservative/i);
  });

  it('(7) a retry (new task_id) re-checks the cap and the running SUM catches accumulation', async () => {
    const sid = makeSession();
    process.env[SESSION_CAP] = '2.00';
    seedSpend({ sessionId: sid, costUsd: 1.5 }); // under cap so far

    const req1 = { ...makeRequest({ taskType: 'AUTONOMOUS_RESEARCH' }), id: randomUUID(), sessionId: sid };
    dispatch(req1 as any, { score: 10, reason: 'test', tier: 'API_EXTERNAL' as any });
    expect(getTask(req1.id).error === null || !/^CAP_EXCEEDED/.test(getTask(req1.id).error)).toBe(true);

    // Simulate that task's own spend landing in the ledger (as recordSpend would
    // from a real SUCCESS terminal, which always carries a costSource).
    recordSpend({ taskId: req1.id, sessionId: sid, costUsd: 0.75, costSource: 'exact' }); // total now 2.25 >= 2.00

    const req2 = { ...makeRequest({ taskType: 'AUTONOMOUS_RESEARCH' }), id: randomUUID(), sessionId: sid };
    dispatch(req2 as any, { score: 10, reason: 'test', tier: 'API_EXTERNAL' as any });
    expect(getTask(req2.id).error).toMatch(/^CAP_EXCEEDED: session/);
  });
});

describe('TCLAW-1A-core: (6) client cannot raise caps — no BudgetPolicy path exists', () => {
  it('GatewayRequestSchema/constraints carries no session/daily cap field — only maxCost (a per-task ceiling)', async () => {
    const { GatewayRequestSchema } = await import('../packages/contracts/src/index.js');
    // Structural proof: parse a full, schema-valid request with an attempted
    // cap-raising field bolted onto constraints, and confirm zod strips it
    // (the schema declares no such key at all) — a client cannot smuggle a
    // session/daily cap through constraints. Built directly (not via
    // helpers.makeRequest, whose fixture id/sessionId predate the schema's
    // current strict-uuid validation) so this test exercises the REAL schema.
    const req = {
      id: randomUUID(),
      sessionId: randomUUID(),
      sourceChannel: 'test',
      receivedAt: new Date().toISOString(),
      payload: {
        prompt: 'x', contextSize: 10, requiredTools: [], taskType: 'ROUTINE_AUTOMATION', grantedTools: [],
      },
      constraints: {
        latencySensitivity: 'LOW', maxCost: 5, containsSensitiveData: false, executionMode: 'AUTO',
        sessionCapUsd: 999999, // attempted cap-raise
        dailyCapUsd: 999999,
      },
      enrichment: {
        classifierUsed: 'LOCAL_LLM', classifierConfidence: 0.9, classifierLatencyMs: 10,
        estimatedTokens: 10, memoryUsed: true,
      },
    } as any;
    const parsed = GatewayRequestSchema.parse(req);
    expect((parsed.constraints as any).sessionCapUsd).toBeUndefined();
    expect((parsed.constraints as any).dailyCapUsd).toBeUndefined();
    // Only maxCost (which can only LOWER a task's own exposure) survives.
    expect(parsed.constraints.maxCost).toBe(5);
  });

  it('spend.ts has no BudgetPolicy import/type/field (static proof caps are env-only, not client-settable)', async () => {
    const srcPath = fileURLToPath(new URL('../packages/gateway/src/spend.ts', import.meta.url));
    const src = readFileSync(srcPath, 'utf8');
    // Prose in the doc comments explains that BudgetPolicy is DELIBERATELY
    // absent (mentions the word), but there must be no actual import, type
    // reference, or usage of a BudgetPolicy symbol anywhere in the module.
    expect(src).not.toMatch(/import\s*\{[^}]*BudgetPolicy/);
    expect(src).not.toMatch(/:\s*BudgetPolicy\b/);
    expect(src).not.toMatch(/req\.constraints\.\w*[Cc]ap\w*/); // no client constraints field read as a cap
    // Caps are resolved purely from process.env in this module.
    expect(src).toMatch(/resolveEnvCap|process\.env/);
  });
});

describe('TCLAW-1A-core: (9)(10)(12) breached task cost lands in ledger + telemetry_json', () => {
  it('taskStore.fail persists telemetry_json when passed (backward compatible: omitted => NULL)', () => {
    const sid = makeSession();
    const requestId = randomUUID();
    db.prepare(
      `INSERT INTO tasks (request_id, session_id, tier, router_reason, request_json) VALUES (?, ?, 'API_EXTERNAL', 'x', '{}')`,
    ).run(requestId, sid);

    taskStore.fail(requestId, 'BUDGET: breached', { budgetSource: 'env_default', costUsd: 4.56 });
    const row = getTask(requestId);
    expect(row.state).toBe('failed');
    expect(JSON.parse(row.telemetry_json)).toEqual({ budgetSource: 'env_default', costUsd: 4.56 });
  });

  it('taskStore.fail with no telemetry arg writes NULL (unchanged legacy behavior)', () => {
    const sid = makeSession();
    const requestId = randomUUID();
    db.prepare(
      `INSERT INTO tasks (request_id, session_id, tier, router_reason, request_json) VALUES (?, ?, 'OLLAMA_LOCAL', 'x', '{}')`,
    ).run(requestId, sid);
    taskStore.fail(requestId, 'DENIED: tool x denied by user');
    expect(getTask(requestId).telemetry_json).toBeNull();
  });

  it('a CircuitBreakerError carries lastCostUsd through to dispatch (hermes.ts + dispatch.ts wiring)', async () => {
    const { CircuitBreakerError } = await import('../packages/bridge/src/hermes.js');
    const e = new CircuitBreakerError('Budget exceeded: $9.99 of $1.00 limit', 9.99);
    expect(e.lastCostUsd).toBe(9.99);
    expect(e).toBeInstanceOf(Error);
  });

  it('CircuitBreakerError.lastCostUsd is undefined (not fabricated 0) when no cost was ever reported', async () => {
    const { CircuitBreakerError } = await import('../packages/bridge/src/hermes.js');
    const e = new CircuitBreakerError('Budget exceeded: $0.00 of $0.00 limit');
    expect(e.lastCostUsd).toBeUndefined();
  });
});

describe('TCLAW-1A-core: (8) replay is read-only — no spend/dispatch path', () => {
  it('receipts.ts read-only handlers do not import spend.ts (structural proof LIST/GET never records spend)', async () => {
    const path = fileURLToPath(new URL('../packages/gateway/src/receipts.ts', import.meta.url));
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/from '\.\/spend\.js'/);
    expect(src).not.toMatch(/recordSpend/);
  });
});

describe('TCLAW-1A-core: (15) projector fills budget_source + cost_enforceable from source data', () => {
  it('FRONTIER success with reported cost + budgetSource => 1 / per_task', () => {
    const sid = makeSession();
    const requestId = randomUUID();
    db.prepare(
      `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json, telemetry_json)
       VALUES (?, ?, 'API_EXTERNAL', 'x', 'completed', '{}', ?)`,
    ).run(requestId, sid, JSON.stringify({ costUsd: 0.42, budgetSource: 'per_task' }));
    const row = projectReceipt(requestId)!;
    expect(row.budget_source).toBe('per_task');
    expect(row.cost_enforceable).toBe(1);
  });
});
