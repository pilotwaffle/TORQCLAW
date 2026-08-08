import { describe, it, expect } from 'vitest';
import { Subscription, type SubscriptionParams, type ChannelEventFrame } from '../../packages/collab/src/subscriptions.js';
import {
  checkSlowConsumer,
  checkAndCloseSlowConsumer,
  tickSlowConsumers,
  SLOW_CONSUMER_BYTE_LIMIT,
  SLOW_CONSUMER_AGE_MS,
} from '../../packages/collab/src/slowconsumer.js';

/**
 * Deterministic clock helper: a simple mutable counter closure. Tests
 * advance it explicitly — no real timers, no Date.now().
 */
function makeClock(startMs = 0) {
  let current = startMs;
  const nowMs = () => current;
  const advanceTo = (ms: number) => {
    current = ms;
  };
  return { nowMs, advanceTo };
}

function makeEvent(channelId: string, seq: number, payloadText = ''): ChannelEventFrame {
  return {
    type: 'channel_event',
    protocolVersion: 2,
    subscriptionId: 'sub-1',
    channelId,
    cursor: String(seq),
    event: {
      id: `evt-${seq}`,
      kind: 'message.created',
      actorPrincipalId: 'principal-1',
      occurredAt: '2026-08-06T00:00:00.000Z',
      payload: { seq, text: payloadText },
    },
  };
}

interface MakeSubOverrides {
  subscriptionId?: string;
  sessionId?: string;
  channelId?: string;
  principalId?: string;
  credentialId?: string;
  rejoinedSeq?: number;
  highWaterCursor?: number;
  sink?: SubscriptionParams['sink'];
  nowMs?: SubscriptionParams['nowMs'];
}

function makeSub(overrides: MakeSubOverrides = {}): {
  sub: Subscription;
  delivered: Array<{ frame: ReturnType<typeof makeEvent> | { type: string; [k: string]: unknown } }>;
} {
  const delivered: Array<{ frame: any }> = [];
  const clock = makeClock(0);
  const params: SubscriptionParams = {
    subscriptionId: overrides.subscriptionId ?? 'sub-1',
    sessionId: overrides.sessionId ?? 'session-1',
    channelId: overrides.channelId ?? 'channel-1',
    principalId: overrides.principalId ?? 'principal-1',
    credentialId: overrides.credentialId ?? 'credential-1',
    rejoinedSeq: overrides.rejoinedSeq ?? 0,
    epochSnapshot: { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 },
    highWaterCursor: overrides.highWaterCursor ?? 0,
    sink: overrides.sink ?? ((frame) => delivered.push({ frame })),
    nowMs: overrides.nowMs ?? clock.nowMs,
  };
  return { sub: new Subscription(params), delivered };
}

// ---------------------------------------------------------------------------
// checkSlowConsumer — healthy
// ---------------------------------------------------------------------------

describe('checkSlowConsumer — healthy consumer', () => {
  it('reports slow: false when queuedBytes is under the byte limit and oldest age is under the age bound', () => {
    const clock = makeClock(0);
    const { sub } = makeSub({ highWaterCursor: 0, nowMs: clock.nowMs });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1); // small, queued while backlog.

    const result = checkSlowConsumer(sub, 100);
    expect(result.slow).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.queuedBytes).toBeGreaterThan(0);
    expect(result.queuedBytes).toBeLessThan(SLOW_CONSUMER_BYTE_LIMIT);
    expect(result.oldestAgeMs).toBeLessThanOrEqual(SLOW_CONSUMER_AGE_MS);
  });
});

// ---------------------------------------------------------------------------
// Byte-bound trip
// ---------------------------------------------------------------------------

describe('checkSlowConsumer — byte-bound trip', () => {
  it('reports slow: true, reason: bytes when queuedBytes exceeds the 1 MiB limit (via backlog buffering, not live delivery)', () => {
    const clock = makeClock(0);
    // Stay in backlog (never call transitionToLive) so frames accumulate in
    // the queue instead of being delivered-then-popped.
    const { sub } = makeSub({ highWaterCursor: 0, nowMs: clock.nowMs });

    // Large payload text per frame so we cross 1,048,576 bytes without an
    // absurd number of frames. ~20KB text per frame.
    const bigText = 'x'.repeat(20_000);
    let seq = 1;
    while (sub.queuedBytes <= SLOW_CONSUMER_BYTE_LIMIT) {
      const queued = sub.deliverChannelEvent(makeEvent('channel-1', seq, bigText), seq);
      expect(queued).toBe(true);
      seq++;
      if (seq > 200) {
        throw new Error('sanity guard: too many iterations building queuedBytes');
      }
    }

    expect(sub.queuedBytes).toBeGreaterThan(SLOW_CONSUMER_BYTE_LIMIT);

    // Still within the 10s age bound.
    const result = checkSlowConsumer(sub, 500);
    expect(result.slow).toBe(true);
    expect(result.reason).toBe('bytes');
  });
});

// ---------------------------------------------------------------------------
// Age-bound trip
// ---------------------------------------------------------------------------

describe('checkSlowConsumer — age-bound trip', () => {
  it('is not slow at exactly the 10,000ms boundary (strict >), but is slow just past it', () => {
    const clock = makeClock(0);
    const { sub } = makeSub({ highWaterCursor: 0, nowMs: clock.nowMs });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1); // enqueued at nowMs=0.

    const atBound = checkSlowConsumer(sub, SLOW_CONSUMER_AGE_MS);
    expect(atBound.slow).toBe(false);

    const pastBound = checkSlowConsumer(sub, SLOW_CONSUMER_AGE_MS + 1);
    expect(pastBound.slow).toBe(true);
    expect(pastBound.reason).toBe('age');
  });

  it('re-evaluates on each call against current nowMs — a stalled consumer with no new traffic still trips on a later tick', () => {
    const clock = makeClock(0);
    const { sub } = makeSub({ highWaterCursor: 0, nowMs: clock.nowMs });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1); // enqueued at nowMs=0. No further traffic.

    // An early tick: not yet slow.
    const earlyTick = checkSlowConsumer(sub, 100);
    expect(earlyTick.slow).toBe(false);

    // A later tick, well past the age bound, with no new enqueue in between.
    const laterTick = checkSlowConsumer(sub, 15000);
    expect(laterTick.slow).toBe(true);
    expect(laterTick.reason).toBe('age');
  });
});

// ---------------------------------------------------------------------------
// checkAndCloseSlowConsumer
// ---------------------------------------------------------------------------

describe('checkAndCloseSlowConsumer', () => {
  it('when slow, closes the subscription with slow_consumer, delivers exactly one close frame, and invokes onClose with the correct reason', () => {
    const clock = makeClock(0);
    const { sub, delivered } = makeSub({ subscriptionId: 'sub-close-1', highWaterCursor: 0, nowMs: clock.nowMs });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1); // enqueued at nowMs=0.

    let onCloseReason: 'bytes' | 'age' | undefined;
    const result = checkAndCloseSlowConsumer(sub, SLOW_CONSUMER_AGE_MS + 1, (reason) => {
      onCloseReason = reason;
    });

    expect(result.slow).toBe(true);
    expect(result.reason).toBe('age');
    expect(sub.closed).toBe(true);
    expect(sub.closeReason).toBe('slow_consumer');
    expect(onCloseReason).toBe('age');

    expect(delivered.length).toBe(1);
    const frame = delivered[0]!.frame;
    expect(frame.type).toBe('subscription_closed');
    expect(frame.reason).toBe('slow_consumer');
  });

  it('when NOT slow, does not close the subscription and does not call onClose', () => {
    const clock = makeClock(0);
    const { sub, delivered } = makeSub({ highWaterCursor: 0, nowMs: clock.nowMs });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1);

    let onCloseCalled = false;
    const result = checkAndCloseSlowConsumer(sub, 100, () => {
      onCloseCalled = true;
    });

    expect(result.slow).toBe(false);
    expect(sub.closed).toBe(false);
    expect(onCloseCalled).toBe(false);
    expect(delivered.length).toBe(0);
  });

  it('on an already-closed subscription, is an idempotent no-op: does not double-close and does not call the sink again', () => {
    const clock = makeClock(0);
    let sinkCallCount = 0;
    const { sub } = makeSub({
      highWaterCursor: 0,
      nowMs: clock.nowMs,
      sink: () => {
        sinkCallCount++;
      },
    });
    sub.close('unsubscribed'); // force-close manually first.
    expect(sinkCallCount).toBe(0); // close() itself doesn't call the sink.

    const result = checkAndCloseSlowConsumer(sub, 999999, () => {
      throw new Error('onClose must not be called for an already-closed subscription');
    });

    expect(sub.closed).toBe(true);
    expect(sub.closeReason).toBe('unsubscribed'); // unchanged — not overwritten to slow_consumer.
    expect(sinkCallCount).toBe(0); // checkAndCloseSlowConsumer never called the sink.
    // The predicate result may still report "slow" (it's a pure check), but
    // no closing side effect happened because sub.closed was already true.
    expect(result).toBeDefined();
  });

  it('closeReason is always exactly "slow_consumer" regardless of whether bytes or age tripped it', () => {
    // Bytes path.
    const clockBytes = makeClock(0);
    const { sub: subBytes } = makeSub({ subscriptionId: 'sub-bytes', highWaterCursor: 0, nowMs: clockBytes.nowMs });
    const bigText = 'x'.repeat(20_000);
    let seq = 1;
    while (subBytes.queuedBytes <= SLOW_CONSUMER_BYTE_LIMIT) {
      subBytes.deliverChannelEvent(makeEvent('channel-1', seq, bigText), seq);
      seq++;
      if (seq > 200) throw new Error('sanity guard');
    }
    checkAndCloseSlowConsumer(subBytes, 500);
    expect(subBytes.closeReason).toBe('slow_consumer');

    // Age path.
    const clockAge = makeClock(0);
    const { sub: subAge } = makeSub({ subscriptionId: 'sub-age', highWaterCursor: 0, nowMs: clockAge.nowMs });
    subAge.deliverChannelEvent(makeEvent('channel-1', 1), 1);
    checkAndCloseSlowConsumer(subAge, SLOW_CONSUMER_AGE_MS + 1);
    expect(subAge.closeReason).toBe('slow_consumer');

    expect(subBytes.closeReason).toBe(subAge.closeReason);
  });

  it('closing for slow_consumer touches only state/closeReason/queue — rejoinedSeq is unchanged', () => {
    const clock = makeClock(0);
    const { sub } = makeSub({ highWaterCursor: 0, rejoinedSeq: 42, nowMs: clock.nowMs });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1);

    const rejoinedSeqBefore = sub.rejoinedSeq;
    checkAndCloseSlowConsumer(sub, SLOW_CONSUMER_AGE_MS + 1);
    expect(sub.rejoinedSeq).toBe(rejoinedSeqBefore);
    expect(sub.rejoinedSeq).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// tickSlowConsumers
// ---------------------------------------------------------------------------

describe('tickSlowConsumers', () => {
  it('closes only the subscriptions that trip (bytes or age), skips healthy and already-closed ones, and fires onClose once per newly-closed subscription with the correct reason', () => {
    const clock = makeClock(0);

    // Healthy: small queue, young age. Use its own clock so its frame is
    // enqueued just before the tick, keeping its age well under the bound
    // regardless of the shared tick time used for the other subscriptions.
    const healthyClock = makeClock(0);
    const { sub: healthy } = makeSub({ subscriptionId: 'sub-healthy', highWaterCursor: 0, nowMs: healthyClock.nowMs });
    healthyClock.advanceTo(SLOW_CONSUMER_AGE_MS - 10);
    healthy.deliverChannelEvent(makeEvent('channel-1', 1), 1);

    // Bytes-trip: large buffered queue.
    const { sub: bytesSub } = makeSub({ subscriptionId: 'sub-bytes', highWaterCursor: 0, nowMs: clock.nowMs });
    const bigText = 'x'.repeat(20_000);
    let seq = 1;
    while (bytesSub.queuedBytes <= SLOW_CONSUMER_BYTE_LIMIT) {
      bytesSub.deliverChannelEvent(makeEvent('channel-1', seq, bigText), seq);
      seq++;
      if (seq > 200) throw new Error('sanity guard');
    }

    // Age-trip: one old buffered frame, enqueued at nowMs=0.
    const { sub: ageSub } = makeSub({ subscriptionId: 'sub-age', highWaterCursor: 0, nowMs: clock.nowMs });
    ageSub.deliverChannelEvent(makeEvent('channel-1', 1), 1);

    // Already closed before the tick.
    const { sub: alreadyClosed } = makeSub({ subscriptionId: 'sub-already-closed', highWaterCursor: 0, nowMs: clock.nowMs });
    alreadyClosed.close('unsubscribed');

    const subs = [healthy, bytesSub, ageSub, alreadyClosed];

    const onCloseCalls: Array<{ subscriptionId: string; reason: 'bytes' | 'age' }> = [];
    const tickNowMs = SLOW_CONSUMER_AGE_MS + 1; // past the age bound; healthy's queue is small so it stays healthy.
    const closedCount = tickSlowConsumers(subs, tickNowMs, (sub, reason) => {
      onCloseCalls.push({ subscriptionId: sub.subscriptionId, reason });
    });

    expect(closedCount).toBe(2); // bytesSub + ageSub, not healthy, not alreadyClosed.
    expect(healthy.closed).toBe(false);
    expect(bytesSub.closed).toBe(true);
    expect(bytesSub.closeReason).toBe('slow_consumer');
    expect(ageSub.closed).toBe(true);
    expect(ageSub.closeReason).toBe('slow_consumer');
    // Already-closed subscription's original reason must be untouched.
    expect(alreadyClosed.closeReason).toBe('unsubscribed');

    expect(onCloseCalls.length).toBe(2);
    const bytesCall = onCloseCalls.find((c) => c.subscriptionId === 'sub-bytes');
    const ageCall = onCloseCalls.find((c) => c.subscriptionId === 'sub-age');
    expect(bytesCall?.reason).toBe('bytes');
    expect(ageCall?.reason).toBe('age');
  });
});
