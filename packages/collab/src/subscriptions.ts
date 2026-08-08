/**
 * subscriptions.ts — in-memory subscription registry for the Collaboration
 * Substrate live slice (Sections 5.5, 7.4, 8.1, 8.2, 8.3).
 *
 * A subscription is a purely in-memory record (never persisted — Section
 * 8.1: "Subscriptions are in-memory records containing subscription/
 * session/channel IDs, epoch snapshots, state, close reason, and queue
 * metadata"). It moves absent -> backlog -> live -> closed (Section 5.5).
 *
 * (H1) The membership epoch snapshot is the epoch of the SUBSCRIBING
 * principal's OWN `collab_members` row for the subscribed channel — never
 * any other row's epoch. This is captured once at SUBSCRIBE_CHANNEL time
 * and is what per-write revalidation (fanout.ts) compares against on every
 * delivery attempt.
 *
 * (C3) Registry insertion + the `buffering` flag + high-water capture are
 * ONE atomic step, performed by `SubscriptionRegistry.register()`, which
 * callers (store.ts's SUBSCRIBE_CHANNEL driver) MUST call while still
 * holding the sequencer mutex from the same BEGIN IMMEDIATE that computed
 * `highWaterCursor` — so any commit that happens AFTER this call, no
 * matter how soon, is guaranteed to see this subscription already present
 * in the registry and therefore gets buffered (if seq > highWater) or
 * would be visible via backlog (if seq <= highWater, which cannot happen
 * for a NEW commit since highWater was just captured as "greatest
 * committed seq so far"). This closes the "dropped highWater+1" gap: there
 * is no window between "capture highWater" and "start listening for new
 * commits" during which an event could commit and be missed by both
 * backlog (already past) and buffering (not yet registered).
 *
 * (M2) Each subscription has exactly ONE ordered FIFO delivery queue,
 * carrying BOTH channel_event frames and the terminal close frame — never
 * two separate queues/paths. This is what makes "close frame is last"
 * true by construction: whatever enqueues last is delivered last, and nothing
 * enqueues after a close frame because a closed subscription's `enqueue`
 * calls are refused (see `enqueue`'s closed check) except for the one
 * `enqueueClose` call itself.
 *
 * (M3) Each queued frame's per-frame byte length and enqueue-time are
 * captured for the slow-consumer accounting in slowconsumer.ts.
 */

// ---------------------------------------------------------------------------
// Close reasons (Section 8.1's exhaustive subscription registry)
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_CLOSE_REASONS = [
  'unsubscribed',
  'authorization_lost',
  'channel_archived',
  'channel_unarchived',
  'slow_consumer',
  'session_closed',
  'socket_closed',
] as const;

export type SubscriptionCloseReason = (typeof SUBSCRIPTION_CLOSE_REASONS)[number];

export type SubscriptionState = 'backlog' | 'live' | 'closed';

// ---------------------------------------------------------------------------
// Frame types delivered through the sink
// ---------------------------------------------------------------------------

export interface ChannelEventFrame {
  type: 'channel_event';
  protocolVersion: 2;
  subscriptionId: string;
  channelId: string;
  cursor: string; // channel_seq, unsigned base-10, never the global seq
  event: {
    id: string;
    kind: string;
    actorPrincipalId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  };
}

export interface SubscriptionCloseFrame {
  type: 'subscription_closed';
  protocolVersion: 2;
  subscriptionId: string;
  state: 'closed';
  reason: SubscriptionCloseReason;
}

export type DeliveryFrame = ChannelEventFrame | SubscriptionCloseFrame;

/**
 * A queued frame with the (M3) per-frame byte-length + enqueue-time
 * metadata slow-consumer accounting needs.
 */
export interface QueuedFrame {
  frame: DeliveryFrame;
  byteLength: number;
  enqueuedAtMs: number;
}

/**
 * The injectable sink a subscription delivers to. `write` is called once
 * per frame, in FIFO order, the instant the frame is dequeued for
 * delivery. Modeling "write initiated" (Section 8.2/M3) rather than
 * "write completed" — the sink's return value (if any) is ignored by this
 * module; real backpressure/completion coupling is OWED to Slice 5 (M3).
 */
export type DeliverySink = (frame: DeliveryFrame, meta: { byteLength: number; enqueuedAtMs: number }) => void;

// ---------------------------------------------------------------------------
// Epoch snapshot
// ---------------------------------------------------------------------------

export interface EpochSnapshot {
  /** The subscribing session's auth_epoch snapshot (BASE). */
  authEpoch: number;
  /** (H1) The subscribing principal's OWN collab_members.membership_epoch. */
  membershipEpoch: number;
  /** The channel's channel_epoch at subscribe time. */
  channelEpoch: number;
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export interface SubscriptionParams {
  subscriptionId: string;
  sessionId: string;
  channelId: string;
  principalId: string;
  credentialId: string;
  /** The caller's own rejoined_seq at subscribe time (Section 5.3 floor). */
  rejoinedSeq: number;
  epochSnapshot: EpochSnapshot;
  /** Greatest committed channel_seq visible to the caller at registration time. */
  highWaterCursor: number;
  sink: DeliverySink;
  /** Injected clock for deterministic byte/age accounting (H3/M3). */
  nowMs: () => number;
}

/**
 * A live (or backlog/closed) subscription. Owns exactly one FIFO delivery
 * queue (M2) and the epoch snapshot used for per-write revalidation
 * (fanout.ts). `state` transitions absent(never modeled)->backlog->live->
 * closed; once `closed`, `enqueue` is a no-op (frames are dropped, per C4:
 * "per-write path checks subscription.closed FIRST and drops if closed").
 */
export class Subscription {
  readonly subscriptionId: string;
  readonly sessionId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly credentialId: string;
  readonly rejoinedSeq: number;

  /** Mutable: revalidation snapshot can be re-armed only by a fresh SUBSCRIBE; this field is read-only after construction in this slice. */
  readonly epochSnapshot: EpochSnapshot;

  private _state: SubscriptionState = 'backlog';
  private _closeReason: SubscriptionCloseReason | undefined;
  private readonly queue: QueuedFrame[] = [];
  private readonly sink: DeliverySink;
  private readonly nowMs: () => number;

  /**
   * (C3) While `buffering` is true, committed events with channel_seq >
   * highWaterCursor are queued (not yet delivered) rather than delivered
   * live. Set true at construction (registration happens before backlog
   * replay completes) and flipped false by `transitionToLive`, which also
   * drains the buffer ascending with seq-dedup at the >highWater boundary.
   */
  private buffering = true;
  readonly highWaterCursor: number;
  /** Highest channel_seq delivered or buffered so far, for dedup at the live transition boundary (C3). */
  private highestSeenSeq: number;

  constructor(params: SubscriptionParams) {
    this.subscriptionId = params.subscriptionId;
    this.sessionId = params.sessionId;
    this.channelId = params.channelId;
    this.principalId = params.principalId;
    this.credentialId = params.credentialId;
    this.rejoinedSeq = params.rejoinedSeq;
    this.epochSnapshot = params.epochSnapshot;
    this.highWaterCursor = params.highWaterCursor;
    this.highestSeenSeq = params.highWaterCursor;
    this.sink = params.sink;
    this.nowMs = params.nowMs;
  }

  get state(): SubscriptionState {
    return this._state;
  }

  get closeReason(): SubscriptionCloseReason | undefined {
    return this._closeReason;
  }

  get closed(): boolean {
    return this._state === 'closed';
  }

  get isBuffering(): boolean {
    return this.buffering;
  }

  /** Total encoded bytes currently queued (undelivered). */
  get queuedBytes(): number {
    let total = 0;
    for (const q of this.queue) total += q.byteLength;
    return total;
  }

  /** Age in ms of the oldest queued (undelivered) frame, or 0 if empty. */
  oldestQueuedAgeMs(nowMs: number): number {
    if (this.queue.length === 0) return 0;
    return nowMs - this.queue[0]!.enqueuedAtMs;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Deliver (write-initiate) a channel_event frame for a committed event
   * whose channel_seq is `seq`. Behavior depends on subscription state:
   *  - closed: dropped (C4).
   *  - buffering (backlog not yet drained to live): if seq > highWater,
   *    queue it (do not deliver yet) for the eventual transitionToLive
   *    drain; if seq <= highWater, this is a duplicate of what backlog
   *    already covers/will cover — dropped (should not happen from a live
   *    fan-out call site, since fan-out only calls this for freshly
   *    committed seq values, which are always > highWater at subscribe
   *    time by construction, but the guard is defensive).
   *  - live: delivered immediately (enqueue + sink write in the same
   *    synchronous step — the actual write-initiation happens in
   *    fanout.ts's critical section, which calls this method).
   * Returns true if the frame was queued/delivered, false if dropped.
   */
  deliverChannelEvent(frame: ChannelEventFrame, seq: number): boolean {
    if (this._state === 'closed') {
      return false;
    }
    // Dedup applies uniformly regardless of state: `highestSeenSeq` starts
    // at `highWaterCursor` (everything <= highWater is covered by backlog
    // replay, delivered separately via deliverBacklogEvent) and is bumped
    // to `seq` the FIRST time a seq > highestSeenSeq is queued/delivered
    // here — so a second call with the SAME seq while still buffering
    // (e.g. a duplicate fan-out invocation racing backlog registration)
    // is caught by this check too, not only post-live-transition. This
    // fixes a prior gap where the guard was skipped entirely during
    // 'backlog' state, allowing the same seq to be queued twice.
    if (seq <= this.highestSeenSeq) {
      return false;
    }
    if (this.buffering) {
      this.highestSeenSeq = seq;
      this.pushFrame(frame);
      return true;
    }
    this.highestSeenSeq = seq;
    this.pushFrame(frame);
    this.deliverNow(frame);
    return true;
  }

  /**
   * Deliver ONE backlog frame directly via the sink, bypassing the
   * buffering/dedup guard in `deliverChannelEvent` (which treats any
   * seq <= highWaterCursor as "already covered by backlog" and drops it —
   * correct for fan-out/buffer calls, wrong for backlog replay itself,
   * which is what actually delivers those seqs). Backlog replay
   * (store.ts's SUBSCRIBE_CHANNEL driver) calls this once per row, in
   * ascending order, for max(afterCursor,rejoinedSeq) < seq <= highWater,
   * OUTSIDE the locks (Section 8.3). Does not touch `highestSeenSeq` or
   * `buffering` — those already treat everything <= highWaterCursor as
   * covered by construction (`highestSeenSeq` starts at `highWaterCursor`),
   * so this is purely a delivery action, not a state transition. No-op
   * (returns false) if already closed.
   */
  deliverBacklogEvent(frame: ChannelEventFrame): boolean {
    if (this._state === 'closed') {
      return false;
    }
    const byteLength = estimateFrameBytes(frame);
    const enqueuedAtMs = this.nowMs();
    this.sink(frame, { byteLength, enqueuedAtMs });
    return true;
  }

  /**
   * (C3) Transition backlog -> live: drain the buffer ascending with
   * dedup on seq > highWater (already enforced by highestSeenSeq
   * tracking), delivering each buffered frame via the sink, then flips
   * `buffering` false and `state` to `live`. MUST be called under the
   * sequencer mutex (store.ts's SUBSCRIBE_CHANNEL driver, after backlog
   * replay completes) so no commit can slip between "drain buffer" and
   * "start delivering live" — the whole drain-then-flip is one
   * synchronous step from this method's perspective (there is no await
   * inside it), matching the PRD's "transition-to-live under the mutex".
   */
  transitionToLive(): void {
    if (this._state === 'closed') {
      return;
    }
    // Buffer already holds frames in the order they were pushed, which is
    // ascending seq order since deliverChannelEvent is called in commit
    // order by fan-out. Deliver each once (already deduped at push time).
    for (const q of this.queue) {
      this.sink(q.frame, { byteLength: q.byteLength, enqueuedAtMs: q.enqueuedAtMs });
    }
    this.buffering = false;
    this._state = 'live';
  }

  /**
   * Terminal close. Purges the queue (Section 8.2: "purges its queue")
   * BEFORE the close frame is appended (M2/C4: the close frame is always
   * the last frame — purge-then-append makes this true by construction,
   * since nothing else can enqueue after `_state` becomes 'closed' except
   * this one call). A mutation's registry reason WINS over a concurrent
   * revalidation-derived reason (C4): calling `close` a second time is a
   * no-op (idempotent), so whichever reason wins the race to call `close`
   * first is the one that sticks.
   */
  close(reason: SubscriptionCloseReason): void {
    if (this._state === 'closed') {
      return; // idempotent: first close reason wins.
    }
    this._state = 'closed';
    this._closeReason = reason;
    // Purge unsent queue.
    this.queue.length = 0;
  }

  /**
   * Post-lock delivery step (Section 8.2): enqueue and deliver the
   * terminal close frame. MUST be called only after `close()` has already
   * been called (so `closeReason` is set) and MUST perform no
   * authorization revalidation — the subscription is already terminally
   * closed. This is the ONLY path allowed to append to the queue/sink
   * after `state` is 'closed'.
   */
  deliverCloseFrame(): void {
    if (this._closeReason === undefined) {
      throw new Error('deliverCloseFrame called before close(): no close reason set');
    }
    const frame: SubscriptionCloseFrame = {
      type: 'subscription_closed',
      protocolVersion: 2,
      subscriptionId: this.subscriptionId,
      state: 'closed',
      reason: this._closeReason,
    };
    // Deliver directly via the sink — bypass the queue entirely since the
    // queue was just purged and closed subscriptions never accept new
    // queue entries. This is the one frame that reaches the sink AFTER
    // state === 'closed'.
    const byteLength = estimateFrameBytes(frame);
    this.sink(frame, { byteLength, enqueuedAtMs: this.nowMs() });
  }

  private pushFrame(frame: DeliveryFrame): void {
    const byteLength = estimateFrameBytes(frame);
    this.queue.push({ frame, byteLength, enqueuedAtMs: this.nowMs() });
  }

  private deliverNow(frame: DeliveryFrame): void {
    // "Delivered" in this in-process model means write-initiation: pop the
    // just-pushed frame's metadata and hand off to the sink synchronously.
    const q = this.queue[this.queue.length - 1]!;
    this.queue.pop();
    this.sink(frame, { byteLength: q.byteLength, enqueuedAtMs: q.enqueuedAtMs });
  }
}

function estimateFrameBytes(frame: DeliveryFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).length;
}

// ---------------------------------------------------------------------------
// SubscriptionRegistry
// ---------------------------------------------------------------------------

/**
 * In-memory registry of all subscriptions, keyed by subscriptionId and
 * indexed by channelId for fan-out lookup. (C3) `register()` is the
 * atomic insertion + high-water-capture step; callers MUST invoke it while
 * still holding the sequencer mutex that computed `highWaterCursor`.
 */
export class SubscriptionRegistry {
  private readonly byId = new Map<string, Subscription>();
  private readonly byChannel = new Map<string, Set<string>>();
  private readonly bySession = new Map<string, Set<string>>();

  /** (C3) Atomic registration step: insert + buffering=true + highWater capture, all synchronous. */
  register(params: SubscriptionParams): Subscription {
    const sub = new Subscription(params);
    this.byId.set(sub.subscriptionId, sub);
    let channelSet = this.byChannel.get(sub.channelId);
    if (!channelSet) {
      channelSet = new Set();
      this.byChannel.set(sub.channelId, channelSet);
    }
    channelSet.add(sub.subscriptionId);

    let sessionSet = this.bySession.get(sub.sessionId);
    if (!sessionSet) {
      sessionSet = new Set();
      this.bySession.set(sub.sessionId, sessionSet);
    }
    sessionSet.add(sub.subscriptionId);

    return sub;
  }

  get(subscriptionId: string): Subscription | undefined {
    return this.byId.get(subscriptionId);
  }

  /** All subscriptions (live, backlog, or closed-but-not-yet-reaped) for a channel. */
  forChannel(channelId: string): Subscription[] {
    const ids = this.byChannel.get(channelId);
    if (!ids) return [];
    const out: Subscription[] = [];
    for (const id of ids) {
      const sub = this.byId.get(id);
      if (sub) out.push(sub);
    }
    return out;
  }

  /** All subscriptions owned by a session. */
  forSession(sessionId: string): Subscription[] {
    const ids = this.bySession.get(sessionId);
    if (!ids) return [];
    const out: Subscription[] = [];
    for (const id of ids) {
      const sub = this.byId.get(id);
      if (sub) out.push(sub);
    }
    return out;
  }

  /** All currently non-closed subscriptions (live or backlog), across all channels. */
  allActive(): Subscription[] {
    const out: Subscription[] = [];
    for (const sub of this.byId.values()) {
      if (!sub.closed) out.push(sub);
    }
    return out;
  }

  /** All subscriptions, closed or not — for observability counters. */
  all(): Subscription[] {
    return Array.from(this.byId.values());
  }

  /**
   * Remove a subscription entirely from the registry (index cleanup). Call
   * only after its close frame has been delivered; a permanently gone
   * subscription is no longer addressable by UNSUBSCRIBE or fan-out. This
   * slice does not require reaping for correctness (closed subscriptions
   * are simply skipped by fan-out and their close() is idempotent), so
   * callers may choose not to call this — it exists for long-running
   * process memory hygiene.
   */
  remove(subscriptionId: string): void {
    const sub = this.byId.get(subscriptionId);
    if (!sub) return;
    this.byId.delete(subscriptionId);
    this.byChannel.get(sub.channelId)?.delete(subscriptionId);
    this.bySession.get(sub.sessionId)?.delete(subscriptionId);
  }
}
