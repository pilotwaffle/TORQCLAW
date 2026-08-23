/**
 * fanout.ts — per-write revalidation + delivery fan-out (Sections 8.2, 8.3,
 * G1R C1/H1/H4).
 *
 * (C1) THE load-bearing critical section: for each committed
 * message_posted (or channel lifecycle event), for each live subscription
 * whose caller passes the seq filter, `fanoutOne` performs:
 *
 *   1. acquire the READ lock                       [await]
 *   2. revalidate BASE + own-row membership + all three epoch snapshots
 *      -- all synchronous DB reads, no await --
 *   3. if not closed, initiate the sink write        -- synchronous --
 *   4. release the READ lock                          [after step 3]
 *
 * Steps 2-3 run in ONE synchronous execution with NO `await` between the
 * revalidation read and the sink handoff — this is what makes it
 * impossible for a REMOVE_CHANNEL_MEMBER (or any other write-lock
 * mutation) to commit+purge in the gap between "we decided this write is
 * authorized" and "we told the sink to send it": there IS no gap, because
 * nothing yields the event loop between those two lines. The read lock
 * itself is what keeps a concurrent authorization mutation (which needs
 * the WRITE lock) from even starting its commit until every in-flight
 * per-write revalidation using the READ lock has released.
 *
 * (H4) The seq filter (channel_seq > subscription.rejoinedSeq) and the
 * per-write BASE/epoch revalidation are BOTH required and independent:
 * the filter selects CANDIDATES (which subscriptions might care about this
 * event at all), and revalidation AUTHORIZES each write (whether this
 * specific subscription may still receive anything right now). A
 * subscription can pass the filter and still fail revalidation (e.g. its
 * own membership was removed after it subscribed but before this event's
 * fan-out ran).
 *
 * (C4) Per-write path checks `subscription.closed` FIRST, before touching
 * the database at all, and drops immediately if closed — this is cheap and
 * avoids doing revalidation work for a subscription a mutation has already
 * terminally closed (and whose queue has already been purged).
 *
 * On revalidation failure, the subscription is closed with
 * `authorization_lost` — via the SAME synchronous critical section (still
 * under the read lock), so the close is visible to any other check before
 * the lock releases.
 */

import type { AuthLock } from './authlock.js';
import type { Subscription, ChannelEventFrame, CollabPresenceFrame, SubscriptionRegistry } from './subscriptions.js';
import type { BootstrapDb } from './bootstrap.js';
import type { CollabObservability } from './observability.js';

// ---------------------------------------------------------------------------
// Revalidation
// ---------------------------------------------------------------------------

export interface RevalidationRowsSnapshot {
  authEpoch: number;
  membershipEpoch: number;
  membershipActive: boolean;
  channelEpoch: number;
  channelState: 'active' | 'archived';
  principalActive: boolean;
  credentialActive: boolean;
  ownerActive: boolean;
}

/**
 * Read the current authoritative state needed for a per-write revalidation
 * decision, scoped ENTIRELY to the subscribing principal's OWN rows (H1) —
 * never any other principal's membership row, matching Section 8.2's
 * "comparing the subscription's membership epoch snapshot only against the
 * caller's own membership row, so membership mutations affecting other
 * principals never invalidate it".
 */
export function readRevalidationSnapshot(
  db: BootstrapDb,
  channelId: string,
  principalId: string,
  credentialId: string
): RevalidationRowsSnapshot | undefined {
  const principal = db
    .prepare('SELECT status, auth_epoch, kind, owner_principal_id FROM principals WHERE id = ?')
    .get(principalId) as
    | { status: string; auth_epoch: number; kind: string; owner_principal_id: string | null }
    | undefined;
  if (!principal) return undefined;

  const credential = db.prepare('SELECT state FROM principal_credentials WHERE id = ?').get(credentialId) as
    | { state: string }
    | undefined;
  if (!credential) return undefined;

  let ownerActive = true;
  if (principal.kind === 'agent') {
    if (!principal.owner_principal_id) {
      ownerActive = false;
    } else {
      const owner = db.prepare('SELECT status FROM principals WHERE id = ?').get(principal.owner_principal_id) as
        | { status: string }
        | undefined;
      ownerActive = !!owner && owner.status === 'active';
    }
  }

  const channel = db.prepare('SELECT state, channel_epoch FROM collab_channels WHERE id = ?').get(channelId) as
    | { state: 'active' | 'archived'; channel_epoch: number }
    | undefined;
  if (!channel) return undefined;

  const member = db
    .prepare('SELECT state, membership_epoch FROM collab_members WHERE channel_id = ? AND principal_id = ?')
    .get(channelId, principalId) as { state: 'active' | 'removed'; membership_epoch: number } | undefined;

  return {
    authEpoch: principal.auth_epoch,
    membershipEpoch: member?.membership_epoch ?? -1,
    membershipActive: member?.state === 'active',
    channelEpoch: channel.channel_epoch,
    channelState: channel.state,
    principalActive: principal.status === 'active',
    credentialActive: credential.state === 'active',
    ownerActive,
  };
}

/**
 * Decide pass/fail for a subscription's snapshot against fresh
 * authoritative rows. A failure closes with `authorization_lost` when the
 * caller's OWN membership row is no longer active, or its membership
 * epoch, the channel epoch, or the auth epoch no longer matches the
 * snapshot (Section 8.2). BASE failures (principal/credential/owner
 * inactive) also fail — they are subsumed by "auth epoch no longer
 * matches" in legal flows (any effective transition that would flip these
 * also increments an epoch this snapshot pins), but are checked directly
 * here for defensive totality against any future path that mutates status
 * without bumping the epoch.
 */
export function revalidationPasses(snapshot: RevalidationRowsSnapshot | undefined, sub: Subscription): boolean {
  if (!snapshot) return false;
  if (!snapshot.principalActive || !snapshot.credentialActive || !snapshot.ownerActive) return false;
  if (snapshot.authEpoch !== sub.epochSnapshot.authEpoch) return false;
  if (!snapshot.membershipActive) return false;
  if (snapshot.membershipEpoch !== sub.epochSnapshot.membershipEpoch) return false;
  if (snapshot.channelEpoch !== sub.epochSnapshot.channelEpoch) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

export interface CommittedChannelEvent {
  channelId: string;
  channelSeq: number;
  eventId: string;
  kind: string;
  actorPrincipalId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface FanoutDeps {
  lock: AuthLock;
  registry: SubscriptionRegistry;
  db: BootstrapDb;
  observability?: CollabObservability;
  /** Injected clock (ms) for latency accounting; defaults to Date.now if omitted. */
  nowMs?: () => number;
}

function toFrame(ev: CommittedChannelEvent, subscriptionId: string): ChannelEventFrame {
  return {
    type: 'channel_event',
    protocolVersion: 2,
    subscriptionId,
    channelId: ev.channelId,
    cursor: String(ev.channelSeq),
    event: {
      id: ev.eventId,
      kind: ev.kind,
      actorPrincipalId: ev.actorPrincipalId,
      occurredAt: ev.occurredAt,
      payload: ev.payload,
    },
  };
}

/**
 * (C1) Per-write delivery for ONE subscription. Acquires the read lock,
 * revalidates, initiates the write (or closes on failure) — all within one
 * call, with the read lock held only across this single write, never
 * across more than one (Section 8.3: "the read lock is acquired and
 * released per socket write and is never held across more than one
 * write").
 */
export async function fanoutOne(deps: FanoutDeps, sub: Subscription, ev: CommittedChannelEvent): Promise<void> {
  // (C4) Closed check FIRST, before touching the lock or the DB at all.
  if (sub.closed) {
    return;
  }

  await deps.lock.acquireRead();
  try {
    // (C1) Everything from here to the sink handoff is synchronous — no
    // await anywhere in this block. This is the entire point of C1: a
    // concurrent write-lock mutation cannot interleave with this decision.
    if (sub.closed) {
      // Closed by a mutation while we were awaiting the read lock grant.
      return;
    }

    const snapshot = readRevalidationSnapshot(deps.db, ev.channelId, sub.principalId, sub.credentialId);
    if (!revalidationPasses(snapshot, sub)) {
      const wasActive = sub.state !== 'backlog';
      sub.close('authorization_lost');
      deps.observability?.markSubscriptionClosed(wasActive);
      // Close-frame delivery is a POST-LOCK step per Section 8.2 ("close
      // notification is exempt from the per-write read-lock rule" — but
      // note this is a per-write revalidation failure, not a coordinator
      // mutation; delivering the close frame here, still inside the
      // synchronous block but conceptually after the authorization
      // decision, matches "the close frame is the last frame ever sent
      // for that subscription" since nothing else can enqueue after
      // sub.close() flips state to closed).
      sub.deliverCloseFrame();
      return;
    }

    const frame = toFrame(ev, sub.subscriptionId);
    sub.deliverChannelEvent(frame, ev.channelSeq);
  } finally {
    deps.lock.releaseRead();
  }
}

/**
 * Fan a committed event out to every candidate subscription on its
 * channel. (H4) The seq filter — `channel_seq > subscription.rejoinedSeq`
 * — selects candidates ONLY; it is applied here, before `fanoutOne` is
 * even called, so subscriptions outside the caller's membership interval
 * never enter the per-write revalidation path for this event at all.
 * Delivery order across subscriptions is unspecified (each is an
 * independent per-write critical section); ORDER WITHIN one subscription's
 * queue is always commit order, because fan-out itself is invoked once per
 * committed event, in commit order, by the caller (store.ts's
 * POST_CHANNEL_MESSAGE / channel-lifecycle driver).
 */
export async function fanoutToChannel(deps: FanoutDeps, ev: CommittedChannelEvent): Promise<void> {
  const candidates = deps.registry.forChannel(ev.channelId).filter((sub) => {
    if (sub.closed) return false;
    // (H4) seq filter: candidate selection only.
    return ev.channelSeq > sub.rejoinedSeq;
  });

  const start = deps.nowMs ? deps.nowMs() : Date.now();
  for (const sub of candidates) {
    await fanoutOne(deps, sub, ev);
  }
  if (deps.observability) {
    const elapsed = (deps.nowMs ? deps.nowMs() : Date.now()) - start;
    deps.observability.fanoutLatency.record(elapsed);
  }
}

// ---------------------------------------------------------------------------
// Presence fan-out (PRD-007 S4, OQ-2 GRANTED 2026-08-23; G1R B-2 binding spec)
// ---------------------------------------------------------------------------

/**
 * A committed collab_agent_turns state transition (claim or resolve) --
 * NOT a CommittedChannelEvent: there is no collab_events row, no
 * channel_seq, nothing to persist. `working`/`since` are read from the
 * COMMITTED row by the caller (claimAgentTurn / commitAgentTurnOutput's
 * post-commit seam) and handed here verbatim; this module never re-derives
 * them and never queries collab_agent_turns itself.
 */
export interface CommittedAgentPresence {
  channelId: string;
  principalId: string;
  working: boolean;
  since: string | null;
}

function toPresenceFrame(ev: CommittedAgentPresence, subscriptionId: string): CollabPresenceFrame {
  return {
    type: 'collab_presence',
    protocolVersion: 2,
    subscriptionId,
    channelId: ev.channelId,
    principalId: ev.principalId,
    working: ev.working,
    since: ev.since,
  };
}

/**
 * (G1R B-2) Per-subscription presence delivery for ONE candidate. Runs the
 * EXACT SAME synchronous critical section as fanoutOne: acquire the read
 * lock, revalidate (readRevalidationSnapshot + revalidationPasses) with NO
 * await between the read and the sink handoff, close with
 * 'authorization_lost' and deliver nothing on failure, else hand the frame
 * to the sink. This is deliberately duplicated rather than shared with
 * fanoutOne's body because the two frame constructions differ (channel_seq
 * dedup/backlog-queue semantics apply to ChannelEventFrame only -- a
 * presence frame is never queued, never deduped by seq, and bypasses
 * Subscription's queue entirely via a direct sink call, matching
 * deliverCloseFrame's post-lock-decision delivery style rather than
 * deliverChannelEvent's buffering/dedup path).
 */
export async function fanoutPresenceOne(
  deps: FanoutDeps,
  sub: Subscription,
  ev: CommittedAgentPresence,
): Promise<void> {
  // (C4-equivalent) Closed check FIRST, before touching the lock or the DB.
  if (sub.closed) {
    return;
  }

  await deps.lock.acquireRead();
  try {
    // (C1-equivalent) Everything from here to the sink handoff is
    // synchronous -- no await anywhere in this block.
    if (sub.closed) {
      return;
    }

    const snapshot = readRevalidationSnapshot(deps.db, ev.channelId, sub.principalId, sub.credentialId);
    if (!revalidationPasses(snapshot, sub)) {
      const wasActive = sub.state !== 'backlog';
      sub.close('authorization_lost');
      deps.observability?.markSubscriptionClosed(wasActive);
      sub.deliverCloseFrame();
      return;
    }

    const frame = toPresenceFrame(ev, sub.subscriptionId);
    // Presence frames are never queued/deduped -- deliver directly via the
    // subscription's sink, matching deliverCloseFrame's direct-sink style.
    // Never synthesizes a channel_seq: there is no cursor for this frame.
    sub.deliverPresence(frame);
  } finally {
    deps.lock.releaseRead();
  }
}

/**
 * Fan a committed agent-turn presence transition out to EVERY candidate
 * subscription on the channel -- (G1R B-2) selected via
 * `registry.forChannel` with NO channel_seq/rejoinedSeq filter (unlike
 * fanoutToChannel's H4 filter): presence has no cursor, so there is no
 * "candidates that might care about this seq" narrowing to apply. Every
 * live-or-backlog subscription on the channel is a candidate; per-write
 * revalidation (fanoutPresenceOne) is still the sole authorization gate.
 */
export async function fanoutPresenceToChannel(deps: FanoutDeps, ev: CommittedAgentPresence): Promise<void> {
  const candidates = deps.registry.forChannel(ev.channelId).filter((sub) => !sub.closed);

  const start = deps.nowMs ? deps.nowMs() : Date.now();
  for (const sub of candidates) {
    await fanoutPresenceOne(deps, sub, ev);
  }
  if (deps.observability) {
    const elapsed = (deps.nowMs ? deps.nowMs() : Date.now()) - start;
    deps.observability.fanoutLatency.record(elapsed);
  }
}
