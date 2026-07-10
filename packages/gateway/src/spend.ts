import { randomUUID } from 'node:crypto';
import { db } from './storage.js';
import { ComputeTier, type GatewayRequest } from '@torqclaw/contracts';

/**
 * TCLAW-1A-core: session/daily spend-cap enforcement + the spend ledger.
 *
 * THE HARD INVARIANT: budget enforcement happens BEFORE spend. This module
 * supplies the cap gate dispatch.ts evaluates immediately after
 * taskStore.create and before any provider call (FRONTIER-only — LOCAL_EDGE
 * is never evaluated, never charged: routing stays orthogonal to caps).
 *
 * Caps are ENV/operator-only by design (G1R correction B): there is
 * deliberately NO BudgetPolicy field on any client-facing contract here. A
 * channel/node client cannot raise a session/daily cap — only lower its own
 * per-task exposure via constraints.maxCost (unchanged, untouched by this
 * file). Do not add a client-settable cap path in this module.
 *
 * Enforcement truth: provider-reported spend only (mirrors evaluateSpend in
 * packages/bridge/src/hermes.ts) — never a fabricated/estimated cost. A row
 * with cost_usd=NULL (attribution='unavailable') is EXCLUDED by SQL SUM, so
 * unreportable spend is never counted as $0 (which would wrongly relax caps).
 *
 * Concurrency: totals are intentionally conservative — no netting, `>=`
 * against the raw sum — an over-count blocks a new task SOONER, never later.
 */

// ── Cap resolution (env-only; mirrors resolveBudget's finite-and->0 rule) ──

export const SESSION_CAP_ENV_VAR = 'TORQCLAW_SESSION_CAP_USD';
export const DAILY_CAP_ENV_VAR = 'TORQCLAW_DAILY_CAP_USD';

/** A cap value is honored ONLY when finite and > 0. $0, negative, unset, or
 *  non-numeric all resolve to undefined => UNLIMITED (never "block all"). */
function resolveEnvCap(envVar: string): number | undefined {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function resolveSessionCap(): number | undefined {
  return resolveEnvCap(SESSION_CAP_ENV_VAR);
}

export function resolveDailyCap(): number | undefined {
  return resolveEnvCap(DAILY_CAP_ENV_VAR);
}

// ── Running totals (conservative: SUM skips NULL cost_usd rows) ───────────

const selectSessionTotal = db.prepare(
  `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend_ledger WHERE session_id = ?`,
);

/** Sum of recorded spend for one session. Rows with cost_usd IS NULL
 *  (attribution='unavailable') are skipped by SUM — unavailable spend is
 *  never counted as $0. */
export function sessionTotal(sessionId: string): number {
  const row = selectSessionTotal.get(sessionId) as { total: number };
  return row.total;
}

const selectDailyTotal = db.prepare(
  `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend_ledger
   WHERE created_at >= datetime('now', 'start of day')`,
);

/** Sum of recorded spend since the start of the current UTC day. All DB
 *  timestamps (CURRENT_TIMESTAMP) are UTC, so the window is UTC by
 *  construction — matches every other timestamp in the DB; no TZ config
 *  surface exists today. */
export function dailyTotal(): number {
  const row = selectDailyTotal.get() as { total: number };
  return row.total;
}

// ── Cap evaluation ──────────────────────────────────────────────────────

export interface CapBreach {
  cap: 'session' | 'daily';
  total: number;
  limit: number;
  envVar: string;
}

/** Pure decision: session cap is checked first (a session breach is the more
 *  specific/actionable signal), then daily. Breach when cap!==undefined &&
 *  total >= cap — checked against the raw, possibly-conservative sum; an
 *  over-count blocks SOONER, never later. No netting. */
export function evaluateCaps(
  sessionTotalUsd: number,
  dailyTotalUsd: number,
  sessionCap: number | undefined,
  dailyCap: number | undefined,
): CapBreach | null {
  if (sessionCap !== undefined && sessionTotalUsd >= sessionCap) {
    return { cap: 'session', total: sessionTotalUsd, limit: sessionCap, envVar: SESSION_CAP_ENV_VAR };
  }
  if (dailyCap !== undefined && dailyTotalUsd >= dailyCap) {
    return { cap: 'daily', total: dailyTotalUsd, limit: dailyCap, envVar: DAILY_CAP_ENV_VAR };
  }
  return null;
}

// ── Budget source (promoted from dispatch's resolveBudget) ────────────────

export type BudgetSource = 'per_task' | 'env_default' | 'unlimited';

export const DEFAULT_MAX_COST_ENV_VAR = 'TORQCLAW_DEFAULT_MAX_COST';

/** Promotes resolveBudget's branch logic to also report which branch won, so
 *  the receipt projector can read a real budget_source instead of a
 *  hardcoded null. Number semantics are UNCHANGED — dispatch.ts's
 *  resolveBudget stays a thin wrapper around `.budget` so budget.test.ts's
 *  precedence pins stay green untouched. */
export function resolveBudgetWithSource(
  req: GatewayRequest,
): { budget: number | undefined; source: BudgetSource } {
  if (typeof req.constraints.maxCost === 'number') {
    return { budget: req.constraints.maxCost, source: 'per_task' };
  }
  const env = Number(process.env[DEFAULT_MAX_COST_ENV_VAR]);
  if (Number.isFinite(env) && env > 0) {
    return { budget: env, source: 'env_default' };
  }
  return { budget: undefined, source: 'unlimited' };
}

// ── recordSpend: guarded, idempotent ledger write ──────────────────────────

export interface RecordSpendInput {
  taskId: string;
  sessionId: string;
  sourceChannel?: string | null;
  provider?: string | null;
  costUsd?: number;
  /** TCLAW-1A-attr: provenance tag for costUsd — 'exact' (per-task credits),
   *  'account_delta' (account-wide usage delta, conservative under
   *  concurrency), or 'unavailable'/absent (no trustworthy number). Drives
   *  the 3-way ledger attribution below; does NOT change cap/SUM math. */
  costSource?: string;
}

const insertSpend = db.prepare(
  `INSERT INTO spend_ledger (id, task_id, session_id, source_channel, provider, cost_usd, attribution)
   VALUES (@id, @task_id, @session_id, @source_channel, @provider, @cost_usd, @attribution)
   ON CONFLICT(task_id) DO NOTHING`,
);

/** Records one terminal FRONTIER task's spend into the ledger. Tier-gating
 *  (skip for LOCAL_EDGE) is the CALL SITE's responsibility — this function
 *  always writes when called.
 *
 *  TCLAW-1A-attr: attribution is now a 3-way LABEL taken from the costSource
 *  tag (NOT a number-vs-null derivation):
 *  - costSource === 'exact'         => attribution='exact' (per-task credits,
 *    trustworthy); the reported number is kept and counted in every SUM.
 *  - costSource === 'account_delta' => attribution='account_delta'
 *    (account-wide usage delta, conservative under concurrent tasks); the
 *    reported number is STILL kept and STILL counted in every SUM — this tag
 *    only LABELS the row as imprecise, it never nets/dedups/filters it out of
 *    cap enforcement (PRD Risk 6 — over-count must block sooner, not later).
 *  - costSource undefined/'unavailable'/anything else => attribution=
 *    'unavailable', cost_usd forced NULL — NEVER a fabricated 0 (mirrors
 *    evaluateSpend's no-fabrication rule). A number arriving with no
 *    costSource is treated as unavailable on purpose: we can't claim a
 *    precision we didn't capture. The only real-number callers after this
 *    ticket (SUCCESS telemetry spread, and the BREACH path via
 *    CircuitBreakerError.lastCostSource) both carry a costSource, so this
 *    fallback should not fire for genuine spend in practice.
 *  - Idempotent: ON CONFLICT(task_id) DO NOTHING — a double-fired terminal
 *    path (mirrors safeMaterializeReceipt's own discipline) can never
 *    double-count the same task.
 *  - Guarded: wrapped in its own try/catch by the CALLER contract below
 *    (recordSpendSafe) — a ledger write must never break the terminal path. */
export function recordSpend(input: RecordSpendInput): void {
  const src = input.costSource;
  const attribution =
    src === 'exact' ? 'exact'
    : src === 'account_delta' ? 'account_delta'
    : 'unavailable';
  const costUsd =
    attribution === 'unavailable' ? null
    : (typeof input.costUsd === 'number' ? input.costUsd : null);
  insertSpend.run({
    id: randomUUID(),
    task_id: input.taskId,
    session_id: input.sessionId,
    source_channel: input.sourceChannel ?? null,
    provider: input.provider ?? null,
    cost_usd: costUsd,
    attribution,
  });
}

/** The ONLY form dispatch.ts may call. Mirrors safeMaterializeReceipt's
 *  discipline exactly: a ledger-write throw must NEVER be able to flip an
 *  already-terminal task or block the terminal-emission path. */
export function recordSpendSafe(input: RecordSpendInput): void {
  try {
    recordSpend(input);
  } catch (e) {
    console.error(`[spend] ledger write failed for ${input.taskId}`, e);
  }
}

/** Re-exported for call sites that only need to gate on tier without
 *  importing @torqclaw/contracts directly (keeps dispatch.ts's import list
 *  unchanged in shape). */
export { ComputeTier };
