/**
 * slowconsumer.ts — Section 7.7 / H3 slow-consumer detection and closure.
 *
 * A consumer is slow when EITHER:
 *  - queued encoded bytes > 1 MiB (1,048,576 bytes), OR
 *  - the oldest queued frame's age > 10,000 ms,
 * both evaluated against the INJECTED clock (never wall-clock — this
 * module never calls Date.now() itself). The age bound is checked on
 * every tick/delivery-attempt, not only at enqueue time, so a stalled
 * consumer that stops receiving new traffic (and therefore never
 * re-triggers an enqueue-time check) still trips once its oldest queued
 * frame crosses the age bound on the next tick.
 *
 * The sole reason/error code for this path is `slow_consumer` (or
 * `SLOW_CONSUMER` at the protocol-error-code layer) — identical close path
 * to every other subscription/session closure: registry closed + queue
 * purged + one terminal close frame. Acknowledged cursor never
 * auto-advances (this module never touches collab_cursors).
 */

import type { Subscription } from './subscriptions.js';

export const SLOW_CONSUMER_BYTE_LIMIT = 1_048_576; // 1 MiB
export const SLOW_CONSUMER_AGE_MS = 10_000; // 10 seconds

export interface SlowConsumerCheckResult {
  slow: boolean;
  reason?: 'bytes' | 'age';
  queuedBytes: number;
  oldestAgeMs: number;
}

/**
 * Evaluate whether a subscription is currently a slow consumer, against
 * the supplied `nowMs` (always the injected clock's current tick, never
 * wall-clock). Pure predicate — does not close anything; callers
 * (`checkAndCloseSlowConsumer` below, or a coordinator's periodic tick)
 * decide what to do with the result.
 */
export function checkSlowConsumer(sub: Subscription, nowMs: number): SlowConsumerCheckResult {
  const queuedBytes = sub.queuedBytes;
  const oldestAgeMs = sub.oldestQueuedAgeMs(nowMs);

  if (queuedBytes > SLOW_CONSUMER_BYTE_LIMIT) {
    return { slow: true, reason: 'bytes', queuedBytes, oldestAgeMs };
  }
  if (oldestAgeMs > SLOW_CONSUMER_AGE_MS) {
    return { slow: true, reason: 'age', queuedBytes, oldestAgeMs };
  }
  return { slow: false, queuedBytes, oldestAgeMs };
}

/**
 * Evaluate and, if slow, close the subscription with `slow_consumer` and
 * deliver its terminal close frame (identical close path to every other
 * subscription closure — Section 8.2's post-lock delivery step, no
 * revalidation). Returns the check result so callers can update
 * observability counters (a `slow_consumer` close increment) regardless of
 * outcome. This function does NOT take any lock itself — Section 7.7 slow
 * consumers are a consumer-local property (queue bytes/age), not an
 * authorization state change, so no coordinator lock is required to close
 * one; callers running this on a tick loop may call it directly.
 */
export function checkAndCloseSlowConsumer(
  sub: Subscription,
  nowMs: number,
  onClose?: (reason: 'bytes' | 'age') => void
): SlowConsumerCheckResult {
  const result = checkSlowConsumer(sub, nowMs);
  if (result.slow && !sub.closed) {
    sub.close('slow_consumer');
    sub.deliverCloseFrame();
    onClose?.(result.reason!);
  }
  return result;
}

/**
 * Run the slow-consumer check across every active subscription in a
 * registry-like iterable. Intended to be invoked on a tick (the injected
 * clock's advancement, in tests) so that a stalled consumer with no new
 * traffic still trips the age bound even though nothing else is enqueuing
 * to it.
 */
export function tickSlowConsumers(
  subs: Iterable<Subscription>,
  nowMs: number,
  onClose?: (sub: Subscription, reason: 'bytes' | 'age') => void
): number {
  let closedCount = 0;
  for (const sub of subs) {
    if (sub.closed) continue;
    const result = checkAndCloseSlowConsumer(sub, nowMs, (reason) => {
      onClose?.(sub, reason);
    });
    if (result.slow) closedCount++;
  }
  return closedCount;
}
