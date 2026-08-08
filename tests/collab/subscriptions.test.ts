import { describe, it, expect } from 'vitest';
import {
  Subscription,
  SubscriptionRegistry,
  type ChannelEventFrame,
  type DeliveryFrame,
  type SubscriptionParams,
} from '../../packages/collab/src/subscriptions.js';

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

function makeEvent(channelId: string, seq: number): ChannelEventFrame {
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
      payload: { seq },
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
  delivered: Array<{ frame: DeliveryFrame; meta: { byteLength: number; enqueuedAtMs: number } }>;
} {
  const delivered: Array<{ frame: DeliveryFrame; meta: { byteLength: number; enqueuedAtMs: number } }> = [];
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
    sink: overrides.sink ?? ((frame, meta) => delivered.push({ frame, meta })),
    nowMs: overrides.nowMs ?? clock.nowMs,
  };
  return { sub: new Subscription(params), delivered };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('Subscription — construction', () => {
  it('starts in state backlog, isBuffering=true, closed=false', () => {
    const { sub } = makeSub();
    expect(sub.state).toBe('backlog');
    expect(sub.isBuffering).toBe(true);
    expect(sub.closed).toBe(false);
    expect(sub.closeReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deliverChannelEvent during backlog
// ---------------------------------------------------------------------------

describe('Subscription — deliverChannelEvent during backlog', () => {
  it('drops (does not queue) events with seq <= highWaterCursor', () => {
    const { sub, delivered } = makeSub({ highWaterCursor: 5 });
    const result = sub.deliverChannelEvent(makeEvent('channel-1', 3), 3);
    expect(result).toBe(false);
    expect(sub.queueDepth).toBe(0);
    expect(delivered.length).toBe(0);
  });

  it('drops an event with seq exactly == highWaterCursor', () => {
    const { sub, delivered } = makeSub({ highWaterCursor: 5 });
    const result = sub.deliverChannelEvent(makeEvent('channel-1', 5), 5);
    expect(result).toBe(false);
    expect(sub.queueDepth).toBe(0);
    expect(delivered.length).toBe(0);
  });

  it('queues (does not call sink) events with seq > highWaterCursor, returns true', () => {
    const { sub, delivered } = makeSub({ highWaterCursor: 5 });
    const result = sub.deliverChannelEvent(makeEvent('channel-1', 6), 6);
    expect(result).toBe(true);
    expect(sub.queueDepth).toBe(1);
    expect(delivered.length).toBe(0);

    const result2 = sub.deliverChannelEvent(makeEvent('channel-1', 7), 7);
    expect(result2).toBe(true);
    expect(sub.queueDepth).toBe(2);
    expect(delivered.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// transitionToLive
// ---------------------------------------------------------------------------

describe('Subscription — transitionToLive', () => {
  it('drains the buffered queue in ascending enqueue order via the sink, exactly once each, then flips state to live and isBuffering to false', () => {
    const { sub, delivered } = makeSub({ highWaterCursor: 0 });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1);
    sub.deliverChannelEvent(makeEvent('channel-1', 2), 2);
    sub.deliverChannelEvent(makeEvent('channel-1', 3), 3);
    expect(delivered.length).toBe(0);

    sub.transitionToLive();

    expect(sub.state).toBe('live');
    expect(sub.isBuffering).toBe(false);
    expect(delivered.length).toBe(3);
    const seqs = delivered.map((d) => (d.frame as ChannelEventFrame).event.payload.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('transitioning an empty backlog to live delivers nothing and still flips state', () => {
    const { sub, delivered } = makeSub({ highWaterCursor: 0 });
    sub.transitionToLive();
    expect(sub.state).toBe('live');
    expect(sub.isBuffering).toBe(false);
    expect(delivered.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe('Subscription — dedup', () => {
  it('a seq that was part of the backlog buffer is not re-delivered when replayed again after going live', () => {
    const { sub, delivered } = makeSub({ highWaterCursor: 0 });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1);
    sub.transitionToLive();
    expect(delivered.length).toBe(1);

    // Re-delivering the same seq after live must be dropped (dedup).
    const result = sub.deliverChannelEvent(makeEvent('channel-1', 1), 1);
    expect(result).toBe(false);
    expect(delivered.length).toBe(1); // sink not called again.
  });

  it('a fresh live-path seq delivered twice is only delivered once', () => {
    const { sub, delivered } = makeSub({ highWaterCursor: 0 });
    sub.transitionToLive();

    const first = sub.deliverChannelEvent(makeEvent('channel-1', 10), 10);
    expect(first).toBe(true);
    expect(delivered.length).toBe(1);

    const second = sub.deliverChannelEvent(makeEvent('channel-1', 10), 10);
    expect(second).toBe(false);
    expect(delivered.length).toBe(1); // sink not called again.
  });
});

// ---------------------------------------------------------------------------
// Live delivery
// ---------------------------------------------------------------------------

describe('Subscription — live delivery', () => {
  it('once live, deliverChannelEvent with a new seq calls the sink synchronously before returning', () => {
    let sinkCalled = false;
    const { sub } = makeSub({
      highWaterCursor: 0,
      sink: () => {
        sinkCalled = true;
      },
    });
    sub.transitionToLive();
    expect(sinkCalled).toBe(false);

    const result = sub.deliverChannelEvent(makeEvent('channel-1', 1), 1);

    // Assert synchronously, immediately after the call returns.
    expect(sinkCalled).toBe(true);
    expect(result).toBe(true);
  });

  it('live-delivered frames do not accumulate in the queue (delivered then popped)', () => {
    const { sub } = makeSub({ highWaterCursor: 0 });
    sub.transitionToLive();
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1);
    expect(sub.queueDepth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe('Subscription — close', () => {
  it('sets state to closed, closed getter true, closeReason matches, and purges the queue', () => {
    const { sub } = makeSub({ highWaterCursor: 0 });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1);
    sub.deliverChannelEvent(makeEvent('channel-1', 2), 2);
    expect(sub.queueDepth).toBe(2);

    sub.close('channel_archived');

    expect(sub.state).toBe('closed');
    expect(sub.closed).toBe(true);
    expect(sub.closeReason).toBe('channel_archived');
    expect(sub.queueDepth).toBe(0);
  });

  it('is idempotent: first close reason wins over a subsequent close() call', () => {
    const { sub } = makeSub();
    sub.close('channel_archived');
    sub.close('authorization_lost');
    expect(sub.closeReason).toBe('channel_archived');
    expect(sub.state).toBe('closed');
  });

  it('after close(), deliverChannelEvent returns false and does not call the sink, regardless of seq', () => {
    const { sub, delivered } = makeSub({ highWaterCursor: 0 });
    sub.close('unsubscribed');

    const result = sub.deliverChannelEvent(makeEvent('channel-1', 999), 999);
    expect(result).toBe(false);
    expect(delivered.length).toBe(0);
    expect(sub.queueDepth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deliverCloseFrame
// ---------------------------------------------------------------------------

describe('Subscription — deliverCloseFrame', () => {
  it('after close(), invokes the sink exactly once with a subscription_closed frame matching state/reason/subscriptionId, bypassing the queue', () => {
    const { sub, delivered } = makeSub({ subscriptionId: 'sub-42', highWaterCursor: 0 });
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1); // queued while buffering.
    sub.close('session_closed'); // purges the queue.
    expect(sub.queueDepth).toBe(0);

    sub.deliverCloseFrame();

    expect(delivered.length).toBe(1);
    const closeDelivery = delivered[0]!;
    const frame = closeDelivery.frame;
    expect(frame.type).toBe('subscription_closed');
    if (frame.type === 'subscription_closed') {
      expect(frame.state).toBe('closed');
      expect(frame.reason).toBe('session_closed');
      expect(frame.subscriptionId).toBe('sub-42');
    }
    // Queue remains empty — the close frame bypassed it entirely.
    expect(sub.queueDepth).toBe(0);
  });

  it('throws when called before close()', () => {
    const { sub } = makeSub();
    expect(() => sub.deliverCloseFrame()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// queuedBytes / oldestQueuedAgeMs
// ---------------------------------------------------------------------------

describe('Subscription — queuedBytes and oldestQueuedAgeMs', () => {
  it('queuedBytes sums per-frame byte lengths; oldestQueuedAgeMs reflects nowMs - first-enqueue-time', () => {
    const clock = makeClock(0);
    const { sub } = makeSub({ highWaterCursor: 0, nowMs: clock.nowMs });

    clock.advanceTo(100);
    sub.deliverChannelEvent(makeEvent('channel-1', 1), 1); // enqueued at 100.

    clock.advanceTo(250);
    sub.deliverChannelEvent(makeEvent('channel-1', 2), 2); // enqueued at 250.

    expect(sub.queuedBytes).toBeGreaterThan(0);

    const laterNowMs = 500;
    expect(sub.oldestQueuedAgeMs(laterNowMs)).toBe(laterNowMs - 100);
  });

  it('oldestQueuedAgeMs returns 0 when the queue is empty', () => {
    const { sub } = makeSub();
    expect(sub.oldestQueuedAgeMs(12345)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SubscriptionRegistry
// ---------------------------------------------------------------------------

describe('SubscriptionRegistry', () => {
  function registerSub(
    registry: SubscriptionRegistry,
    overrides: MakeSubOverrides = {}
  ): Subscription {
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
      sink: overrides.sink ?? (() => {}),
      nowMs: overrides.nowMs ?? clock.nowMs,
    };
    return registry.register(params);
  }

  it('register() returns a Subscription retrievable via get(subscriptionId)', () => {
    const registry = new SubscriptionRegistry();
    const sub = registerSub(registry, { subscriptionId: 'sub-a' });
    expect(registry.get('sub-a')).toBe(sub);
  });

  it('get() returns undefined for an unknown id', () => {
    const registry = new SubscriptionRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('forChannel(channelId) returns only subscriptions registered for that channel', () => {
    const registry = new SubscriptionRegistry();
    const a = registerSub(registry, { subscriptionId: 'sub-a', channelId: 'channel-x' });
    const b = registerSub(registry, { subscriptionId: 'sub-b', channelId: 'channel-x' });
    const c = registerSub(registry, { subscriptionId: 'sub-c', channelId: 'channel-y' });

    const forX = registry.forChannel('channel-x');
    expect(forX.length).toBe(2);
    expect(forX).toEqual(expect.arrayContaining([a, b]));
    expect(forX).not.toEqual(expect.arrayContaining([c]));

    const forY = registry.forChannel('channel-y');
    expect(forY).toEqual([c]);

    expect(registry.forChannel('channel-nonexistent')).toEqual([]);
  });

  it('forSession(sessionId) returns only subscriptions owned by that session', () => {
    const registry = new SubscriptionRegistry();
    const a = registerSub(registry, { subscriptionId: 'sub-a', sessionId: 'session-x' });
    const b = registerSub(registry, { subscriptionId: 'sub-b', sessionId: 'session-y' });
    const c = registerSub(registry, { subscriptionId: 'sub-c', sessionId: 'session-x' });

    const forX = registry.forSession('session-x');
    expect(forX.length).toBe(2);
    expect(forX).toEqual(expect.arrayContaining([a, c]));

    const forY = registry.forSession('session-y');
    expect(forY).toEqual([b]);
  });

  it('allActive() excludes closed subscriptions', () => {
    const registry = new SubscriptionRegistry();
    const a = registerSub(registry, { subscriptionId: 'sub-a' });
    const b = registerSub(registry, { subscriptionId: 'sub-b' });
    const c = registerSub(registry, { subscriptionId: 'sub-c' });
    b.close('unsubscribed');

    const active = registry.allActive();
    expect(active.length).toBe(2);
    expect(active).toEqual(expect.arrayContaining([a, c]));
    expect(active).not.toEqual(expect.arrayContaining([b]));
  });

  it('all() includes closed subscriptions', () => {
    const registry = new SubscriptionRegistry();
    const a = registerSub(registry, { subscriptionId: 'sub-a' });
    const b = registerSub(registry, { subscriptionId: 'sub-b' });
    b.close('unsubscribed');

    const all = registry.all();
    expect(all.length).toBe(2);
    expect(all).toEqual(expect.arrayContaining([a, b]));
  });

  it('remove(subscriptionId) removes it from get(), forChannel(), and forSession() lookups', () => {
    const registry = new SubscriptionRegistry();
    registerSub(registry, { subscriptionId: 'sub-a', channelId: 'channel-x', sessionId: 'session-x' });

    expect(registry.get('sub-a')).toBeDefined();
    expect(registry.forChannel('channel-x').length).toBe(1);
    expect(registry.forSession('session-x').length).toBe(1);

    registry.remove('sub-a');

    expect(registry.get('sub-a')).toBeUndefined();
    expect(registry.forChannel('channel-x')).toEqual([]);
    expect(registry.forSession('session-x')).toEqual([]);
  });
});
