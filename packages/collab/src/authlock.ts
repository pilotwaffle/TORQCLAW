/**
 * authlock.ts — the Collaboration Substrate's writer-preferring
 * authorization read/write lock (Section 8.3, G1R C2).
 *
 * THE ONE FACT THAT MUST NOT BE GOTTEN WRONG (G1R): writer-preference is a
 * GRANT-QUEUE property, not FIFO/caller ordering. Concretely: once a write
 * acquisition is PENDING (queued, not yet granted), no NEW read acquisition
 * is granted until that writer has acquired AND released the lock. This is
 * tracked via `pendingWriters` — a count of write acquisitions that have
 * been requested but not yet granted — which every read-grant decision
 * consults. FIFO (grant strictly in call order) is explicitly wrong: it
 * lets a flood of readers that arrive AFTER a writer is queued, but happen
 * to be scheduled by some fair round-robin, starve the writer just as badly
 * as naive reader-preference. The grant-queue rule is stronger than FIFO —
 * it is "no reader jumps ahead of ANY pending writer", full stop, regardless
 * of arrival order among the readers themselves.
 *
 * This is a DIFFERENT primitive than the existing synchronous single-waiter
 * `Mutex` in store.ts (the "sequencer mutex"), which is RETAINED beneath
 * this lock, unchanged, for BEGIN IMMEDIATE..commit exclusivity. Layering
 * for authorization mutations (Section 8.3, C2):
 *
 *   acquireWrite() [await]
 *     -> sequencerMutex.withLock(SYNC tx)   [the existing Mutex, synchronous
 *                                             body, no yield]
 *     -> post-commit SYNC subscription-close + queue-purge
 *   releaseWrite()
 *
 * Write subsumes read: code already holding a write acquisition may treat
 * itself as also holding read authority (no separate read call needed, and
 * none is provided — see `withWrite`). There is NO upgrade path: a call
 * site that already holds a read acquisition MUST NOT request a write
 * acquisition on the same logical hold — `acquireWrite` does not check this
 * (the lock has no notion of "current holder identity" since Node's
 * single-threaded model gives it none), so this is enforced by the caller
 * discipline documented on `store.ts`'s driver re-slotting and asserted by
 * the "no code holds read while requesting write" static/behavioral test in
 * tests/collab/authlock.test.ts.
 *
 * Acquisition is async (`await`) specifically so contention is modeled
 * deterministically via the microtask queue in tests — every grant/queue
 * decision happens synchronously inside `acquireRead`/`acquireWrite`, and
 * only the actual WAIT (when a grant cannot be made yet) suspends via a
 * pending Promise, in FIFO-among-waiters-of-the-same-class order once the
 * grant-queue rule has been satisfied. This makes the lock's behavior fully
 * reproducible under Node's single-threaded, promise-microtask scheduler:
 * there is no real parallelism to race against, only the order in which
 * `await`s resume, which this module fully controls.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthLockUpgradeError extends Error {
  readonly code = 'AUTH_LOCK_UPGRADE_FORBIDDEN' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AuthLockUpgradeError';
  }
}

// ---------------------------------------------------------------------------
// AuthLock
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: () => void;
}

/**
 * A writer-preferring reader/writer lock.
 *
 * State:
 *  - `activeReaders`: count of currently-held read acquisitions.
 *  - `writerActive`: whether a write acquisition is currently held.
 *  - `pendingWriters`: count of write acquisitions that have been
 *    REQUESTED (via `acquireWrite`) but not yet GRANTED. This is the
 *    grant-queue signal: as long as this is > 0, no new read acquisition
 *    is granted, even if the read-lock is otherwise free (no active writer,
 *    no active readers). A read acquisition already granted before a
 *    writer became pending is unaffected — it runs to its own
 *    `releaseRead()` normally; the rule only gates NEW grants.
 *  - `writerQueue` / `readerQueue`: FIFO queues of waiters within each
 *    class, used only to decide who wakes next once a grant becomes
 *    possible for that class. Ordering WITHIN a class is FIFO; ordering
 *    BETWEEN classes is governed by the grant-queue rule above, which
 *    always favors any pending writer over any waiting (or new) reader.
 */
export class AuthLock {
  private activeReaders = 0;
  private writerActive = false;
  private pendingWriters = 0;

  private readonly writerQueue: Waiter[] = [];
  private readonly readerQueue: Waiter[] = [];

  /** Number of write acquisitions requested but not yet granted. Exposed for tests/observability. */
  get pendingWriterCount(): number {
    return this.pendingWriters;
  }

  /** Number of currently-held read acquisitions. Exposed for tests/observability. */
  get activeReaderCount(): number {
    return this.activeReaders;
  }

  /** Whether a write acquisition is currently held. Exposed for tests/observability. */
  get isWriterActive(): boolean {
    return this.writerActive;
  }

  // -----------------------------------------------------------------------
  // Read acquisition
  // -----------------------------------------------------------------------

  /**
   * Acquire a shared read acquisition. Grants immediately iff there is no
   * active writer AND no pending writer (grant-queue rule). Otherwise
   * queues behind existing waiters of its class and resolves once a grant
   * becomes possible — re-checking the same rule at wake time, so a reader
   * woken by a writer's release does not jump ahead of a NEWER pending
   * writer that queued while it was waiting.
   */
  async acquireRead(): Promise<void> {
    if (this.canGrantRead()) {
      this.activeReaders++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.readerQueue.push({ resolve });
    });
    // On wake, the releaser already incremented activeReaders on our
    // behalf (see wakeWaiters) — this keeps grant and count-increment
    // atomic from the perspective of any interleaving await.
  }

  releaseRead(): void {
    if (this.activeReaders <= 0) {
      throw new Error('AuthLock.releaseRead called with no active read acquisition held');
    }
    this.activeReaders--;
    this.wakeWaiters();
  }

  // -----------------------------------------------------------------------
  // Write acquisition
  // -----------------------------------------------------------------------

  /**
   * Acquire the exclusive write acquisition. The instant this is called,
   * `pendingWriters` increments — even before the grant — because the
   * grant-queue rule's entire purpose is to block NEW read grants from the
   * moment a writer starts waiting, not from the moment it succeeds.
   * Grants immediately iff there is no active writer and no active
   * readers; otherwise queues FIFO among other writers.
   */
  async acquireWrite(): Promise<void> {
    this.pendingWriters++;
    if (this.canGrantWrite()) {
      this.pendingWriters--;
      this.writerActive = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.writerQueue.push({ resolve });
    });
    // On wake, the releaser already decremented pendingWriters and set
    // writerActive = true on our behalf (see wakeWaiters).
  }

  releaseWrite(): void {
    if (!this.writerActive) {
      throw new Error('AuthLock.releaseWrite called with no active write acquisition held');
    }
    this.writerActive = false;
    this.wakeWaiters();
  }

  // -----------------------------------------------------------------------
  // Upgrade prohibition
  // -----------------------------------------------------------------------

  /**
   * Explicit assertion helper: code holding a read acquisition MUST NOT
   * call this while still holding it and expect to acquire write on the
   * same logical operation. There is no runtime holder-tracking (Node has
   * no per-fiber identity to key off of), so this throws unconditionally —
   * it exists purely as a documented, greppable call site that a reviewer
   * or static check can use to prove no driver path calls acquireWrite
   * while a read acquisition from the SAME command is outstanding. Driver
   * code in store.ts must never call this; it is exercised only by the
   * negative test proving the discipline is documented and enforced by
   * code review / the L1 static-assertion test, not by runtime state.
   */
  static forbidUpgrade(): never {
    throw new AuthLockUpgradeError(
      'No upgrade path exists from a held read acquisition to a write acquisition. ' +
        'Release the read acquisition and call acquireWrite() fresh, or restructure the ' +
        'driver so read and write needs are never interleaved within one command.'
    );
  }

  // -----------------------------------------------------------------------
  // withRead / withWrite helpers
  // -----------------------------------------------------------------------

  async withRead<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquireRead();
    try {
      return await fn();
    } finally {
      this.releaseRead();
    }
  }

  async withWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquireWrite();
    try {
      return await fn();
    } finally {
      this.releaseWrite();
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private canGrantRead(): boolean {
    // Grant-queue rule: a read acquisition is grantable iff no writer is
    // active AND no writer is pending. This is the load-bearing check —
    // NOT "no writer active" alone (that would be plain reader-preference-
    // safe-but-not-writer-preferring), and NOT FIFO position among a mixed
    // queue (that would let readers queued behind a writer still be
    // "next" by arrival order once the writer resolves, which is fine —
    // but would ALSO let brand-new readers that never queued at all cut
    // in front of a still-pending writer, which is the bug this rule
    // forbids).
    return !this.writerActive && this.pendingWriters === 0;
  }

  private canGrantWrite(): boolean {
    return !this.writerActive && this.activeReaders === 0;
  }

  /**
   * Called after every release. Wakes as many waiters as the grant-queue
   * rule currently allows, in this strict priority order:
   *   1. If a write acquisition can be granted (no active writer, no
   *      active readers) and a writer is waiting, grant exactly one writer
   *      (write is exclusive — never more than one).
   *   2. Otherwise, if no writer is pending (grant-queue rule) and no
   *      writer is active, grant EVERY currently-waiting reader (shared
   *      reads can all proceed together).
   * This ordering is what makes writer-preference a grant-queue property:
   * a writer waiting in `writerQueue` is checked BEFORE any reader in
   * `readerQueue`, regardless of how long the readers have been waiting or
   * how many of them there are.
   */
  private wakeWaiters(): void {
    // Priority 1: a pending writer, if the write acquisition is free.
    if (this.canGrantWrite() && this.writerQueue.length > 0) {
      const waiter = this.writerQueue.shift()!;
      this.pendingWriters--;
      this.writerActive = true;
      waiter.resolve();
      return; // write is exclusive; do not also wake readers this round.
    }

    // Priority 2: readers, only if no writer is active or pending.
    if (this.canGrantRead()) {
      while (this.readerQueue.length > 0) {
        const waiter = this.readerQueue.shift()!;
        this.activeReaders++;
        waiter.resolve();
      }
    }
  }
}
