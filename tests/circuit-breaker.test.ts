import { describe, it, expect } from 'vitest';
import { evaluateSpend, CircuitBreakerError, type HeartbeatState } from '../packages/bridge/src/hermes.js';

/** TCLAW-0D — cost-breaker unit tests: the spend-evaluation decision.
 *
 *  evaluateSpend is the pure decision extracted from executeHermesTask's poll
 *  loop (the loop calls it verbatim). It decides, from PROVIDER-reported spend
 *  only, whether to (a) emit a spend heartbeat and (b) trip the breaker. It
 *  never fabricates a cost and never uses a pricing table.
 *
 *  Heartbeat cadence is tested by passing an explicit `now` and interval, so
 *  there is no reliance on real timers (non-brittle).
 */

const INTERVAL = 30_000;
const freshState = (): HeartbeatState => ({ lastHeartbeatAt: 0, lastHeartbeatCost: -1 });

describe('evaluateSpend — breaker trip (TCLAW-0D)', () => {
  it('trips when reported spend strictly exceeds the budget', () => {
    const out = evaluateSpend(9.99, 1.0, freshState(), 1_000, INTERVAL);
    expect(out.breachMessage).toBe('Budget exceeded: $9.99 of $1.00 limit');
  });

  it('does NOT trip when spend equals the budget (strict >, not >=)', () => {
    const out = evaluateSpend(1.0, 1.0, freshState(), 1_000, INTERVAL);
    expect(out.breachMessage).toBeUndefined();
  });

  it('does NOT trip when spend is under budget', () => {
    const out = evaluateSpend(0.5, 1.0, freshState(), 1_000, INTERVAL);
    expect(out.breachMessage).toBeUndefined();
  });

  it('does NOT trip when there is no budget (unlimited)', () => {
    const out = evaluateSpend(1_000_000, undefined, freshState(), 1_000, INTERVAL);
    expect(out.breachMessage).toBeUndefined();
  });

  it('trips against a $0 budget on any positive spend (explicit free-only task)', () => {
    const out = evaluateSpend(0.01, 0, freshState(), 1_000, INTERVAL);
    expect(out.breachMessage).toBe('Budget exceeded: $0.01 of $0.00 limit');
  });

  it('the breach message matches the /budget/i pattern the e2e and dispatch rely on', () => {
    // Regression guard for ops/e2e-budget.mjs (asserts /budget/i) and dispatch's
    // CircuitBreakerError → 'BUDGET:' terminal-ERROR mapping.
    const out = evaluateSpend(9.99, 1.0, freshState(), 1_000, INTERVAL);
    expect(out.breachMessage).toMatch(/budget/i);
  });
});

describe('evaluateSpend — unreportable spend (TCLAW-0D)', () => {
  it('null spend: no heartbeat, no trip, no fabricated zero', () => {
    const state = freshState();
    const out = evaluateSpend(null, 1.0, state, 1_000, INTERVAL);
    expect(out.heartbeat).toBeUndefined();
    expect(out.breachMessage).toBeUndefined();
    // state untouched — we did not record a $0 heartbeat.
    expect(state).toEqual(freshState());
  });

  it('undefined spend (telemetry.costUsd absent): breaker skipped entirely', () => {
    const out = evaluateSpend(undefined, 0.01, freshState(), 1_000, INTERVAL);
    expect(out.breachMessage).toBeUndefined();
    expect(out.heartbeat).toBeUndefined();
  });

  it('a NaN or non-number spend never trips the breaker', () => {
    expect(evaluateSpend(NaN as unknown as number, 1.0, freshState(), 1_000, INTERVAL).breachMessage)
      // NaN is typeof 'number' but NaN > budget is false, so no trip — and no fake heartbeat value either.
      .toBeUndefined();
    expect(evaluateSpend('9.99' as unknown, 1.0, freshState(), 1_000, INTERVAL).breachMessage)
      .toBeUndefined(); // a string is not a number → skipped
  });
});

describe('evaluateSpend — heartbeat cadence (TCLAW-0D)', () => {
  it('emits a heartbeat on the first reportable spend', () => {
    const out = evaluateSpend(0.5, undefined, freshState(), INTERVAL, INTERVAL);
    expect(out.heartbeat).toBe('Spend so far: $0.50');
  });

  it('suppresses a second heartbeat inside the same interval window', () => {
    const state = freshState();
    // First heartbeat at now=INTERVAL (>= interval since lastHeartbeatAt=0).
    const first = evaluateSpend(0.5, undefined, state, INTERVAL, INTERVAL);
    expect(first.heartbeat).toBe('Spend so far: $0.50');
    // A later poll only 1s on, with a higher cost, is still inside the window.
    const second = evaluateSpend(0.7, undefined, state, INTERVAL + 1_000, INTERVAL);
    expect(second.heartbeat).toBeUndefined();
  });

  it('emits again once a full interval has elapsed AND the cost changed', () => {
    const state = freshState();
    evaluateSpend(0.5, undefined, state, INTERVAL, INTERVAL);
    const later = evaluateSpend(0.9, undefined, state, INTERVAL * 2, INTERVAL);
    expect(later.heartbeat).toBe('Spend so far: $0.90');
  });

  it('does NOT re-emit when the cost is unchanged, even after the interval', () => {
    const state = freshState();
    evaluateSpend(0.5, undefined, state, INTERVAL, INTERVAL);
    const same = evaluateSpend(0.5, undefined, state, INTERVAL * 3, INTERVAL);
    expect(same.heartbeat).toBeUndefined();
  });

  it('a breach still trips even when the heartbeat is suppressed in-window', () => {
    const state = freshState();
    evaluateSpend(0.5, 1.0, state, INTERVAL, INTERVAL); // heartbeat fires, no trip
    // Immediately after, cost jumps over budget within the same window: no
    // heartbeat, but the breaker must still trip.
    const out = evaluateSpend(2.0, 1.0, state, INTERVAL + 500, INTERVAL);
    expect(out.heartbeat).toBeUndefined();
    expect(out.breachMessage).toBe('Budget exceeded: $2.00 of $1.00 limit');
  });
});

describe('CircuitBreakerError (TCLAW-0D)', () => {
  it('is an Error subclass with the right name (dispatch discriminates on this)', () => {
    const e = new CircuitBreakerError('Budget exceeded: $9.99 of $1.00 limit');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CircuitBreakerError');
    expect(e.message).toMatch(/budget/i);
  });
});
