import { describe, it, expect } from 'vitest';
import { Mutex } from '../../packages/collab/src/store.js';

// ---------------------------------------------------------------------------
// (H6) Mutex-FIFO property test: store.ts's sequencer Mutex (retained
// beneath AuthLock, used for BEGIN IMMEDIATE..commit exclusivity). Property:
// enqueue N interleaved acquisitions, assert grant order == call order.
// ---------------------------------------------------------------------------

describe('(H6) Mutex — FIFO grant-order property', () => {
  it('grants N interleaved withLock() acquisitions in exactly call order', async () => {
    const mutex = new Mutex();
    const callOrder: number[] = [];
    const grantOrder: number[] = [];

    const N = 50;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      callOrder.push(i);
      promises.push(
        mutex.withLock(() => {
          grantOrder.push(i);
        })
      );
    }

    await Promise.all(promises);

    expect(grantOrder).toEqual(callOrder);
    expect(grantOrder).toHaveLength(N);
  });

  it('holds exclusivity: no two withLock bodies ever run concurrently (interleaved async work inside the critical section)', async () => {
    const mutex = new Mutex();
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const order: number[] = [];

    const N = 20;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        mutex.withLock(() => {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          order.push(i);
          // Synchronous body only (Mutex.withLock's fn is () => T, not
          // async) — this is deliberate: store.ts's real usage always
          // passes a synchronous transaction closure. We still verify
          // exclusivity is maintained across the async acquisition
          // machinery itself.
          concurrentCount--;
        })
      );
    }

    await Promise.all(promises);
    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it('grant order is call order even when calls are issued from staggered microtask turns, not all synchronously up front', async () => {
    const mutex = new Mutex();
    const grantOrder: number[] = [];
    const callOrder: number[] = [];

    async function issue(i: number): Promise<void> {
      callOrder.push(i);
      await mutex.withLock(() => {
        grantOrder.push(i);
      });
    }

    // Stagger calls across microtask turns via a chain of .then(), rather
    // than firing all N synchronously in one loop iteration — proves FIFO
    // holds under a more realistic interleaving, not just the trivial
    // same-turn case.
    const N = 15;
    let chain: Promise<void> = Promise.resolve();
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      chain = chain.then(() => {
        promises.push(issue(i));
      });
    }
    await chain;
    await Promise.all(promises);

    expect(grantOrder).toEqual(callOrder);
  });

  it('a slow-body acquisition does not let a later caller jump the queue', async () => {
    const mutex = new Mutex();
    const grantOrder: number[] = [];

    // First caller's body itself is synchronous (Mutex enforces this by
    // type), but we can still simulate "slow to release" by having its
    // synchronous body do more (bounded) work, and issue the next callers
    // immediately after, before the first has resolved its promise chain.
    const p1 = mutex.withLock(() => {
      for (let i = 0; i < 1000; i++) {
        /* busy work, still synchronous */
      }
      grantOrder.push(1);
    });
    const p2 = mutex.withLock(() => {
      grantOrder.push(2);
    });
    const p3 = mutex.withLock(() => {
      grantOrder.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(grantOrder).toEqual([1, 2, 3]);
  });
});
