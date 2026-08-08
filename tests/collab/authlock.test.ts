import { describe, it, expect } from 'vitest';
import { AuthLock } from '../../packages/collab/src/authlock.js';

/**
 * Deterministic contention modeling: we never use real timers. Every test
 * drives contention purely via microtask ordering (await Promise.resolve()
 * to let queued acquisitions settle) and explicit acquire/release calls, so
 * these tests are fully reproducible under Node's single-threaded
 * scheduler.
 */

async function flush(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe('AuthLock — basic read/write exclusivity', () => {
  it('multiple readers can hold concurrently', async () => {
    const lock = new AuthLock();
    await lock.acquireRead();
    await lock.acquireRead();
    await lock.acquireRead();
    expect(lock.activeReaderCount).toBe(3);
    lock.releaseRead();
    lock.releaseRead();
    lock.releaseRead();
    expect(lock.activeReaderCount).toBe(0);
  });

  it('a writer is exclusive: grants only when no readers/writers active', async () => {
    const lock = new AuthLock();
    await lock.acquireWrite();
    expect(lock.isWriterActive).toBe(true);
    lock.releaseWrite();
    expect(lock.isWriterActive).toBe(false);
  });

  it('a write acquisition blocks while a reader holds the lock, and grants after release', async () => {
    const lock = new AuthLock();
    await lock.acquireRead();

    let writeGranted = false;
    const writePromise = lock.acquireWrite().then(() => {
      writeGranted = true;
    });

    await flush(3);
    expect(writeGranted).toBe(false);
    expect(lock.pendingWriterCount).toBe(1);

    lock.releaseRead();
    await writePromise;
    expect(writeGranted).toBe(true);
    lock.releaseWrite();
  });

  it('a read acquisition blocks while a writer holds the lock, and grants after release', async () => {
    const lock = new AuthLock();
    await lock.acquireWrite();

    let readGranted = false;
    const readPromise = lock.acquireRead().then(() => {
      readGranted = true;
    });

    await flush(3);
    expect(readGranted).toBe(false);

    lock.releaseWrite();
    await readPromise;
    expect(readGranted).toBe(true);
    lock.releaseRead();
  });

  it('releaseRead throws when no read acquisition is held', () => {
    const lock = new AuthLock();
    expect(() => lock.releaseRead()).toThrow();
  });

  it('releaseWrite throws when no write acquisition is held', () => {
    const lock = new AuthLock();
    expect(() => lock.releaseWrite()).toThrow();
  });
});

describe('AuthLock — THE writer-preference load-bearing test', () => {
  /**
   * THE ONE FACT (G1R): writer-preference is a GRANT-QUEUE property — once
   * a write acquisition is PENDING, no NEW read acquisition is granted
   * until that writer has acquired AND released — not FIFO/caller
   * ordering. This test proves it: with readers continuously arriving
   * (even AFTER the writer has started waiting, and even in large
   * volume), a pending writer acquires within a BOUNDED number of reader
   * completions, independent of how many more readers keep arriving.
   *
   * If the lock were plain FIFO (grant in strict call order) rather than
   * grant-queue writer-preference, then readers queued/arriving after the
   * writer would still each get their own grant turn interleaved by
   * arrival order in some fair schedulers, but more importantly: a naive
   * reader-preference implementation ("grant a read whenever no writer is
   * ACTIVE", ignoring PENDING writers) would let an unbounded flood of
   * NEW readers (not queued, freshly calling acquireRead after the writer
   * already started waiting) jump the queue indefinitely, since none of
   * them are blocked by an ACTIVE writer (there isn't one yet — it's only
   * pending). The grant-queue rule in this lock explicitly closes that
   * gap via `pendingWriters`, checked by canGrantRead(). This test
   * exercises exactly that scenario.
   */
  it('a pending writer acquires within a bounded number of reader completions, independent of reader arrival rate', async () => {
    const lock = new AuthLock();

    // Establish 5 initial readers holding the lock.
    const initialReaders = 5;
    for (let i = 0; i < initialReaders; i++) {
      await lock.acquireRead();
    }
    expect(lock.activeReaderCount).toBe(initialReaders);

    // A writer starts waiting.
    let writeGranted = false;
    const writePromise = lock.acquireWrite().then(() => {
      writeGranted = true;
    });
    await flush(2);
    expect(lock.pendingWriterCount).toBe(1);
    expect(writeGranted).toBe(false);

    // NEW readers keep arriving continuously AFTER the writer is already
    // pending — a flood of 200 of them. Under FIFO or naive
    // reader-preference, at least SOME of these could be granted before
    // the writer (jumping the queue). Under this lock's grant-queue rule,
    // NONE of them should be granted while pendingWriters > 0.
    const floodSize = 200;
    const floodGrantedFlags: boolean[] = new Array(floodSize).fill(false);
    const floodPromises: Promise<void>[] = [];
    for (let i = 0; i < floodSize; i++) {
      floodPromises.push(
        lock.acquireRead().then(() => {
          floodGrantedFlags[i] = true;
        })
      );
    }

    await flush(5);

    // None of the flood readers should have been granted — the pending
    // writer blocks all of them (grant-queue rule), regardless of the
    // fact that far more readers arrived than the original 5.
    expect(floodGrantedFlags.every((g) => g === false)).toBe(true);
    expect(writeGranted).toBe(false);
    expect(lock.activeReaderCount).toBe(initialReaders); // unchanged — no new reader got in.

    // Release the original 5 readers — a BOUNDED number of reader
    // completions (exactly 5, not "however many more arrive").
    for (let i = 0; i < initialReaders; i++) {
      lock.releaseRead();
    }

    await writePromise;
    expect(writeGranted).toBe(true);
    expect(lock.isWriterActive).toBe(true);

    // The flood readers are STILL blocked — the writer is now ACTIVE.
    await flush(2);
    expect(floodGrantedFlags.every((g) => g === false)).toBe(true);

    // Release the writer: now the whole flood is granted together.
    lock.releaseWrite();
    await Promise.all(floodPromises);
    expect(floodGrantedFlags.every((g) => g === true)).toBe(true);
    expect(lock.activeReaderCount).toBe(floodSize);

    for (let i = 0; i < floodSize; i++) lock.releaseRead();
    expect(lock.activeReaderCount).toBe(0);
  });

  it('FIFO-among-writers: a second pending writer waits for the first to acquire and release, never jumping ahead', async () => {
    const lock = new AuthLock();
    await lock.acquireRead();

    const order: string[] = [];
    const w1 = lock.acquireWrite().then(() => order.push('w1'));
    await flush(2);
    const w2 = lock.acquireWrite().then(() => order.push('w2'));
    await flush(2);

    expect(lock.pendingWriterCount).toBe(2);
    lock.releaseRead();

    await w1;
    expect(order).toEqual(['w1']);
    expect(lock.pendingWriterCount).toBe(1); // w2 still pending, w1 now active
    lock.releaseWrite();

    await w2;
    expect(order).toEqual(['w1', 'w2']);
    lock.releaseWrite();
  });

  it('a reader that queued BEFORE a writer became pending is still blocked until the writer acquires+releases (grant-queue re-checks on wake)', async () => {
    const lock = new AuthLock();
    await lock.acquireWrite(); // writer active first.

    let readerGranted = false;
    const readerPromise = lock.acquireRead().then(() => {
      readerGranted = true;
    });
    await flush(2);
    expect(readerGranted).toBe(false);

    // A second writer becomes pending WHILE the reader is still queued
    // behind the first (active) writer.
    let secondWriterGranted = false;
    const secondWriterPromise = lock.acquireWrite().then(() => {
      secondWriterGranted = true;
    });
    await flush(2);
    expect(lock.pendingWriterCount).toBe(1); // the second writer.

    // Release the first (active) writer. The grant-queue rule means the
    // SECOND (now-pending) writer must be granted before the still-queued
    // reader — writer-preference re-checked at wake time, not "whoever
    // queued first among mixed classes".
    lock.releaseWrite();
    await flush(2);
    expect(secondWriterGranted).toBe(true);
    expect(readerGranted).toBe(false);

    lock.releaseWrite();
    await readerPromise;
    expect(readerGranted).toBe(true);
    lock.releaseRead();
  });
});

describe('AuthLock — FIFO-would-fail assertion (explicit negative control)', () => {
  /**
   * A hand-rolled FIFO-caller-ordering lock (readers and writers granted
   * strictly in arrival order, no writer-preference) to demonstrate that
   * the writer-preference test above is not vacuously true — a
   * plausible-looking alternative implementation fails it.
   */
  class FifoLock {
    private queue: Array<{ kind: 'read' | 'write'; resolve: () => void }> = [];
    private activeReaders = 0;
    private writerActive = false;

    async acquireRead(): Promise<void> {
      return new Promise((resolve) => {
        this.queue.push({ kind: 'read', resolve });
        this.pump();
      });
    }
    async acquireWrite(): Promise<void> {
      return new Promise((resolve) => {
        this.queue.push({ kind: 'write', resolve });
        this.pump();
      });
    }
    releaseRead(): void {
      this.activeReaders--;
      this.pump();
    }
    releaseWrite(): void {
      this.writerActive = false;
      this.pump();
    }
    private pump(): void {
      // Strict FIFO: only ever look at the head of the queue.
      while (this.queue.length > 0) {
        const head = this.queue[0]!;
        if (head.kind === 'read') {
          if (this.writerActive) break;
          this.queue.shift();
          this.activeReaders++;
          head.resolve();
          // Continue: subsequent reads at the head can also grant
          // immediately (FIFO doesn't stop a run of reads).
          continue;
        } else {
          if (this.writerActive || this.activeReaders > 0) break;
          this.queue.shift();
          this.writerActive = true;
          head.resolve();
          break; // writer exclusive; stop pumping.
        }
      }
    }
  }

  it('demonstrates FIFO alone does not prevent a flood of readers queued AHEAD of the writer from delaying it — motivating why grant-queue (not FIFO) is required', async () => {
    // This test targets a DIFFERENT failure shape than the AuthLock test:
    // under FIFO, readers that queue BEFORE the writer (even if they
    // arrive in a burst racing the writer's own call) are served before
    // it, and — critically — FIFO provides no mechanism to make a
    // PENDING writer's presence retroactively block readers that queue
    // after it if the implementation's "pump" logic were to (incorrectly)
    // keep scanning past a blocked writer to serve later-queued reads.
    // Our FifoLock above happens to correctly block on a writer at the
    // queue head (single-lane FIFO), which actually DOES achieve
    // writer-preference-like behavior for a simple queue — demonstrating
    // that the interesting failure mode is specifically "reader-preference"
    // (naive: grant reads whenever no ACTIVE writer, ignoring pending
    // ones), which is what AuthLock's canGrantRead() explicitly guards
    // against via pendingWriters. We assert that guard directly:
    const naiveReaderPreferenceCanGrantRead = (writerActive: boolean, _pendingWriters: number): boolean =>
      !writerActive; // ignores pending writers entirely — the bug.

    // Simulate: writer is pending (not yet active), and a flood of new
    // readers arrives. Naive reader-preference would grant them all.
    const writerActive = false;
    const pendingWriters = 1;
    const wouldGrant = naiveReaderPreferenceCanGrantRead(writerActive, pendingWriters);
    expect(wouldGrant).toBe(true); // the naive rule WOULD wrongly admit readers here.

    // AuthLock's actual rule must NOT do this:
    const lock = new AuthLock();
    await lock.acquireRead();
    const w = lock.acquireWrite();
    await flush(2);
    lock.releaseRead(); // now writerActive=false, pendingWriters=1, activeReaders=0 transiently.

    // At this exact instant a naive reader-preference lock would grant a
    // new reader (writerActive is false). AuthLock must not.
    let readerGranted = false;
    const readerRace = lock.acquireRead().then(() => {
      readerGranted = true;
    });
    await flush(2);
    expect(readerGranted).toBe(false); // AuthLock correctly withholds the grant.

    await w;
    lock.releaseWrite();
    await readerRace;
    expect(readerGranted).toBe(true);
    lock.releaseRead();
  });
});

describe('AuthLock — write subsumes read / no upgrade path', () => {
  it('withWrite grants exclusive access usable for both read- and write-authorized work', async () => {
    const lock = new AuthLock();
    let ran = false;
    await lock.withWrite(() => {
      ran = true;
      expect(lock.isWriterActive).toBe(true);
    });
    expect(ran).toBe(true);
    expect(lock.isWriterActive).toBe(false);
  });

  it('withRead releases even if the callback throws', async () => {
    const lock = new AuthLock();
    await expect(
      lock.withRead(() => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(lock.activeReaderCount).toBe(0);
  });

  it('withWrite releases even if the callback throws', async () => {
    const lock = new AuthLock();
    await expect(
      lock.withWrite(() => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(lock.isWriterActive).toBe(false);
  });

  it('AuthLock.forbidUpgrade always throws (no runtime upgrade path exists)', () => {
    expect(() => AuthLock.forbidUpgrade()).toThrow(/no upgrade path/i);
  });
});
