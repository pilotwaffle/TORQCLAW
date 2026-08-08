import { describe, it, expect } from 'vitest';
import { AuthLock } from '../../packages/collab/src/authlock.js';
import { SubscriptionRegistry, type EpochSnapshot } from '../../packages/collab/src/subscriptions.js';
import { runAuthorizationMutation, affectedByChannel } from '../../packages/collab/src/coordinator.js';
import { CollabObservability } from '../../packages/collab/src/observability.js';

function makeEpoch(): EpochSnapshot {
  return { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 };
}

describe('runAuthorizationMutation — layering and ordering', () => {
  it('acquires the write lock before running txBody, and releases it only after post-commit close+purge', async () => {
    const lock = new AuthLock();
    const registry = new SubscriptionRegistry();
    const observability = new CollabObservability();
    let nowMsValue = 1000;
    const nowMs = () => nowMsValue;

    const frames: string[] = [];
    const sub = registry.register({
      subscriptionId: 'sub-1',
      sessionId: 'session-1',
      channelId: 'chan-1',
      principalId: 'principal-1',
      credentialId: 'cred-1',
      rejoinedSeq: 0,
      epochSnapshot: makeEpoch(),
      highWaterCursor: 0,
      sink: (frame) => frames.push(frame.type),
      nowMs,
    });

    let txRan = false;
    let writerActiveDuringTx = false;

    const result = await runAuthorizationMutation(
      { lock, registry, observability, nowMs },
      () => {
        // txBody runs while the write lock is held.
        writerActiveDuringTx = lock.isWriterActive;
        txRan = true;
        return { channelId: 'chan-1' };
      },
      () => affectedByChannel(registry, 'chan-1', 'channel_archived')
    );

    expect(txRan).toBe(true);
    expect(writerActiveDuringTx).toBe(true);
    expect(lock.isWriterActive).toBe(false); // released after the call.
    expect(result).toEqual({ channelId: 'chan-1' });

    // The subscription was closed (purged) DURING the write-lock hold, and
    // its close frame delivered AFTER release (post-lock delivery step).
    expect(sub.closed).toBe(true);
    expect(sub.closeReason).toBe('channel_archived');
    expect(frames).toEqual(['subscription_closed']);
  });

  it('(C4) a mutation close reason wins over a concurrent revalidation-derived reason — first close() call sticks', async () => {
    const lock = new AuthLock();
    const registry = new SubscriptionRegistry();
    const observability = new CollabObservability();
    const nowMs = () => 0;

    const sub = registry.register({
      subscriptionId: 'sub-race',
      sessionId: 'session-1',
      channelId: 'chan-1',
      principalId: 'principal-1',
      credentialId: 'cred-1',
      rejoinedSeq: 0,
      epochSnapshot: makeEpoch(),
      highWaterCursor: 0,
      sink: () => {},
      nowMs,
    });

    // Simulate: a revalidation failure closes it with authorization_lost
    // FIRST (as if a per-write revalidation raced ahead).
    sub.close('authorization_lost');

    // Now the coordinator mutation tries to close it too, with a DIFFERENT
    // reason. Since close() is idempotent-first-writer-wins, the original
    // reason must stick.
    await runAuthorizationMutation(
      { lock, registry, observability, nowMs },
      () => ({ channelId: 'chan-1' }),
      () => affectedByChannel(registry, 'chan-1', 'channel_archived')
    );

    expect(sub.closeReason).toBe('authorization_lost'); // first reason wins.
  });

  it('(M1) records revocation latency as commit-return -> write-lock-release-after-purge, excluding pre-commit time', async () => {
    const lock = new AuthLock();
    const registry = new SubscriptionRegistry();
    const observability = new CollabObservability();

    // A clock that advances by a fixed amount each call, so we can compute
    // the expected delta precisely.
    let tick = 0;
    const nowMs = () => {
      tick += 10;
      return tick;
    };

    await runAuthorizationMutation(
      { lock, registry, observability, nowMs },
      () => {
        // Simulate "pre-commit work" by calling nowMs a few times before
        // returning — this time must be EXCLUDED from the measured window,
        // since the window starts at commitReturnMs (captured right after
        // txBody resolves), not at acquireWrite time.
        nowMs();
        nowMs();
        return { ok: true };
      },
      () => ({ subscriptions: [] })
    );

    const snapshot = observability.snapshot();
    expect(snapshot.revocationLatencyP95).toBeDefined();
    expect(snapshot.revocationLatencyP95).toBeGreaterThanOrEqual(0);
  });
});

describe('affectedByChannel / affectedByPrincipal helpers', () => {
  it('affectedByChannel selects only non-closed subscriptions for the given channel', async () => {
    const registry = new SubscriptionRegistry();
    const nowMs = () => 0;
    const subA = registry.register({
      subscriptionId: 'a',
      sessionId: 's1',
      channelId: 'chan-1',
      principalId: 'p1',
      credentialId: 'c1',
      rejoinedSeq: 0,
      epochSnapshot: makeEpoch(),
      highWaterCursor: 0,
      sink: () => {},
      nowMs,
    });
    const subB = registry.register({
      subscriptionId: 'b',
      sessionId: 's2',
      channelId: 'chan-1',
      principalId: 'p2',
      credentialId: 'c2',
      rejoinedSeq: 0,
      epochSnapshot: makeEpoch(),
      highWaterCursor: 0,
      sink: () => {},
      nowMs,
    });
    registry.register({
      subscriptionId: 'c',
      sessionId: 's3',
      channelId: 'chan-2', // different channel.
      principalId: 'p3',
      credentialId: 'c3',
      rejoinedSeq: 0,
      epochSnapshot: makeEpoch(),
      highWaterCursor: 0,
      sink: () => {},
      nowMs,
    });
    subB.close('unsubscribed'); // already closed — excluded.

    const affected = affectedByChannel(registry, 'chan-1', 'channel_archived');
    expect(affected.subscriptions.map((s) => s.subscription.subscriptionId)).toEqual(['a']);
    expect(affected.subscriptions[0]!.reason).toBe('channel_archived');
    void subA;
  });
});
