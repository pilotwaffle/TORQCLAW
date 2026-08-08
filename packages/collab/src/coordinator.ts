/**
 * coordinator.ts — Section 8.2 authorization coordinator: closes affected
 * subscriptions (and, at the session layer, sessions) synchronously under
 * the WRITE lock, immediately after the SQLite commit that changed
 * state/epoch, and BEFORE the write lock releases.
 *
 * Layering (matches the class doc on authlock.ts and G1R C2):
 *
 *   acquireWrite() [await]
 *     -> sequencerMutex.withLock(SYNC tx)      [store.ts's existing Mutex,
 *                                                unchanged, synchronous body]
 *     -> post-commit SYNC subscription-close + queue-purge  [THIS MODULE]
 *   releaseWrite()
 *
 * `runAuthorizationMutation` is the single entry point store.ts's
 * authorization-mutation drivers (SUSPEND_AGENT, REVOKE_AGENT,
 * ROTATE/REVOKE_PRINCIPAL_CREDENTIAL, REMOVE_CHANNEL_MEMBER,
 * ARCHIVE/UNARCHIVE_CHANNEL, ADD_CHANNEL_MEMBER, RESTORE_AGENT) call
 * instead of driving the AuthLock/Mutex layering by hand — it guarantees
 * the ordering above cannot be gotten wrong by a driver author.
 *
 * (C4) The close frame is enqueued to the same FIFO sink AFTER the purge
 * (`Subscription.close()` purges synchronously; the close frame is then
 * delivered by a POST-LOCK delivery step that does no revalidation) — see
 * `deliverPendingCloseFrames`, called AFTER `releaseWrite()` in
 * `runAuthorizationMutation`, exactly matching Section 8.2: "the close
 * notification frame is enqueued to a post-lock delivery step that runs
 * after the write lock is released and performs no authorization
 * revalidation, because the subscription is already terminally closed."
 *
 * (M1) Revocation-latency measurement window: SQLite-commit-return ->
 * write-lock-release-after-purge. `runAuthorizationMutation` captures
 * `commitReturnMs` the instant the sync tx callback returns and
 * `releaseMs` right before `releaseWrite()`, recording the delta —
 * excluding the post-lock close-frame delivery step, which is correctly
 * outside the measured window per Section 15's definition.
 */

import type { AuthLock } from './authlock.js';
import type { Subscription, SubscriptionCloseReason, SubscriptionRegistry } from './subscriptions.js';
import type { SessionCloseReason } from './sessions.js';
import type { CollabObservability } from './observability.js';

export interface CoordinatorDeps {
  lock: AuthLock;
  registry: SubscriptionRegistry;
  observability?: CollabObservability;
  /** Injected clock (ms), for M1 latency measurement. Defaults to Date.now. */
  nowMs?: () => number;
}

/**
 * Describes which subscriptions/sessions an authorization mutation affects,
 * decided by the caller (store.ts driver) from its own committed-state
 * knowledge (e.g. "every subscription for this principal", "every live
 * subscription on this channel"). The coordinator does not re-derive this
 * set — it only enforces where and when the closing happens.
 */
export interface AffectedSet {
  subscriptions: Array<{ subscription: Subscription; reason: SubscriptionCloseReason }>;
  /** Sessions to close are handled by the caller's own session registry; listed here only for latency/observability bookkeeping symmetry. */
  sessionCloseReasons?: SessionCloseReason[];
}

/**
 * Run an authorization-mutation body (the SQLite transaction) under the
 * write lock, then synchronously close the affected subscriptions
 * (purging their queues) BEFORE the write lock releases, then deliver
 * their close frames in a post-lock step. Returns the transaction body's
 * return value.
 *
 * `txBody` is `() => this.mutex.withLock(() => <SYNC tx>)` — the existing
 * sequencer mutex's `withLock` returns a Promise (its acquisition can
 * suspend), but the transaction CALLBACK it wraps is synchronous and
 * unchanged (no yield BEGIN IMMEDIATE..commit). Awaiting `txBody()` here
 * only ever waits on sequencer-mutex acquisition/microtask resolution,
 * never on I/O — the actual commit happens synchronously once the mutex is
 * held. `deriveAffected` runs AFTER `txBody` resolves (so it sees
 * post-commit state) but still inside the write-lock hold, and MUST be
 * synchronous (no await inside it) — this is what keeps the write lock's
 * hold-through-purge window free of any real suspension point.
 */
export async function runAuthorizationMutation<T>(
  deps: CoordinatorDeps,
  txBody: () => Promise<T> | T,
  deriveAffected: (committedResult: T) => AffectedSet
): Promise<T> {
  const nowMs = deps.nowMs ?? Date.now;

  await deps.lock.acquireWrite();
  let commitReturnMs = 0;
  let affected: AffectedSet;
  let result: T;
  try {
    // The sequencer-mutex-guarded transaction. SQLite commit is the
    // linearization point (Section 8.2); the instant this resolves, the
    // mutation is committed (the awaited time is mutex-acquisition
    // microtask latency only — the transaction body itself runs
    // synchronously once the mutex grants).
    result = await txBody();
    commitReturnMs = nowMs();

    // (C4/M1) Synchronously, still under the write lock: derive and close
    // affected subscriptions + purge their queues. No await anywhere in
    // this block.
    affected = deriveAffected(result);
    for (const { subscription, reason } of affected.subscriptions) {
      if (subscription.closed) continue; // already closed by a prior mutation/race; first reason wins (C4).
      const wasActive = subscription.state !== 'backlog';
      subscription.close(reason); // purges the queue synchronously.
      deps.observability?.markSubscriptionClosed(wasActive);
    }
  } finally {
    const releaseMs = nowMs();
    deps.lock.releaseWrite();
    if (commitReturnMs > 0) {
      deps.observability?.recordRevocationLatency(releaseMs - commitReturnMs);
    }
  }

  // Post-lock delivery step (Section 8.2): deliver each affected
  // subscription's close frame now that the write lock is released. No
  // revalidation — the subscription is already terminally closed, and its
  // close reason is exactly what runAuthorizationMutation's caller set,
  // which WINS over any concurrent revalidation-derived reason because
  // Subscription.close() is idempotent-first-writer-wins and this call
  // happened while still holding the write lock, strictly before any
  // concurrent fanoutOne (which needs the READ lock, unavailable until
  // this write lock releases) could have raced to close the same
  // subscription with `authorization_lost`.
  for (const { subscription } of affected!.subscriptions) {
    subscription.deliverCloseFrame();
  }

  return result!;
}

/**
 * Convenience: build an AffectedSet closing every non-closed subscription
 * for a given channel with one reason (archive/unarchive).
 */
export function affectedByChannel(
  registry: SubscriptionRegistry,
  channelId: string,
  reason: SubscriptionCloseReason
): AffectedSet {
  const subs = registry.forChannel(channelId).filter((s) => !s.closed);
  return { subscriptions: subs.map((subscription) => ({ subscription, reason })) };
}

/**
 * Convenience: build an AffectedSet closing every non-closed subscription
 * owned by a given principal (suspend/revoke) or by a given
 * channel+principal pair (member removal — only that principal's
 * subscriptions on THAT channel), with one reason.
 */
export function affectedByPrincipal(
  registry: SubscriptionRegistry,
  principalId: string,
  reason: SubscriptionCloseReason,
  channelId?: string
): AffectedSet {
  const subs: Subscription[] = [];
  for (const sub of registry.allActive()) {
    if (sub.principalId !== principalId) continue;
    if (channelId !== undefined && sub.channelId !== channelId) continue;
    subs.push(sub);
  }
  return { subscriptions: subs.map((subscription) => ({ subscription, reason })) };
}

/**
 * Convenience: build an AffectedSet closing every non-closed subscription
 * bound to a given session ID (credential rotation/revocation closes the
 * bound session; any subscription that session opened must close too,
 * since it can no longer receive anything — `authorization_lost` is the
 * correct reason since the underlying session credential is gone, distinct
 * from a principal-level or channel-level state change).
 */
export function affectedBySession(
  registry: SubscriptionRegistry,
  sessionId: string,
  reason: SubscriptionCloseReason
): AffectedSet {
  const subs = registry.forSession(sessionId).filter((s) => !s.closed);
  return { subscriptions: subs.map((subscription) => ({ subscription, reason })) };
}
