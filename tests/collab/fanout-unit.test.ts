import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { AuthLock } from '../../packages/collab/src/authlock.js';
import { SubscriptionRegistry, type EpochSnapshot, type DeliveryFrame } from '../../packages/collab/src/subscriptions.js';
import { fanoutOne, readRevalidationSnapshot, revalidationPasses } from '../../packages/collab/src/fanout.js';

/**
 * Unit-level fanout tests directly against a raw SQLite DB (no
 * CollaborationStore wiring) — proving fanoutOne's per-write revalidation
 * logic in isolation, including the negative "self-mutation" style probe
 * for C1 (no await between revalidation read and sink handoff).
 */
function makeDb(fixtureId: string) {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  const db: BootstrapDb = {
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const secretStore = new InMemorySecretStore();
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids(fixtureId);
  const rng = nodeRandomSource;
  const bootstrap = bootstrapOperator(
    { db, secretStore, clock, uuids, rng },
    { operatorDisplayName: 'Operator', installationId: `install-${fixtureId}`, schemaVersion: 1 }
  );
  return { sqlite, db, bootstrap, clock, uuids };
}

function insertChannel(db: BootstrapDb, id: string, ownerId: string, now: string) {
  db.prepare(
    'INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run(id, 'Chan', 'chan', 'active', ownerId, 1, now, now);
}

function insertAgent(db: BootstrapDb, id: string, ownerId: string, now: string) {
  db.prepare(
    'INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(id, 'agent', 'Agent', ownerId, 'active', 1, null, now, now);
}

function insertCredential(db: BootstrapDb, id: string, principalId: string, now: string) {
  db.prepare(
    'INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES(?,?,?,?,?,?,?)'
  ).run(id, principalId, Buffer.alloc(32), 'active', null, now, null);
}

function insertMember(db: BootstrapDb, channelId: string, principalId: string, epoch: number, now: string) {
  db.prepare(
    'INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run(channelId, principalId, 'agent', 'active', epoch, 0, now, null);
}

describe('readRevalidationSnapshot / revalidationPasses', () => {
  it('passes when everything matches the subscription epoch snapshot', () => {
    const { db, bootstrap, clock } = makeDb('reval-pass');
    const now = clock.next();
    const agentId = 'agent-1';
    const credId = 'cred-1';
    const channelId = 'chan-1';
    insertAgent(db, agentId, bootstrap.operatorPrincipalId, now);
    insertCredential(db, credId, agentId, now);
    insertChannel(db, channelId, bootstrap.operatorPrincipalId, now);
    insertMember(db, channelId, agentId, 1, now);

    const snapshot = readRevalidationSnapshot(db, channelId, agentId, credId);
    expect(snapshot).toBeDefined();

    const epoch: EpochSnapshot = { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 };
    const fakeSub = { epochSnapshot: epoch } as { epochSnapshot: EpochSnapshot };
    expect(revalidationPasses(snapshot, fakeSub as never)).toBe(true);
  });

  it('fails when the auth epoch no longer matches (principal was suspended/restored)', () => {
    const { db, bootstrap, clock } = makeDb('reval-auth-epoch');
    const now = clock.next();
    const agentId = 'agent-1';
    const credId = 'cred-1';
    const channelId = 'chan-1';
    insertAgent(db, agentId, bootstrap.operatorPrincipalId, now);
    insertCredential(db, credId, agentId, now);
    insertChannel(db, channelId, bootstrap.operatorPrincipalId, now);
    insertMember(db, channelId, agentId, 1, now);

    // Bump auth_epoch directly (simulating a suspend/restore cycle).
    db.prepare('UPDATE principals SET auth_epoch = 2 WHERE id = ?').run(agentId);

    const snapshot = readRevalidationSnapshot(db, channelId, agentId, credId);
    const epoch: EpochSnapshot = { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 }; // stale snapshot.
    const fakeSub = { epochSnapshot: epoch } as { epochSnapshot: EpochSnapshot };
    expect(revalidationPasses(snapshot, fakeSub as never)).toBe(false);
  });

  it('fails when the caller OWN membership row is no longer active (removed)', () => {
    const { db, bootstrap, clock } = makeDb('reval-membership');
    const now = clock.next();
    const agentId = 'agent-1';
    const credId = 'cred-1';
    const channelId = 'chan-1';
    insertAgent(db, agentId, bootstrap.operatorPrincipalId, now);
    insertCredential(db, credId, agentId, now);
    insertChannel(db, channelId, bootstrap.operatorPrincipalId, now);
    insertMember(db, channelId, agentId, 1, now);
    db.prepare('UPDATE collab_members SET state = ? WHERE channel_id = ? AND principal_id = ?').run(
      'removed',
      channelId,
      agentId
    );

    const snapshot = readRevalidationSnapshot(db, channelId, agentId, credId);
    const epoch: EpochSnapshot = { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 };
    const fakeSub = { epochSnapshot: epoch } as { epochSnapshot: EpochSnapshot };
    expect(revalidationPasses(snapshot, fakeSub as never)).toBe(false);
  });

  it('(H1) ignores OTHER principals membership rows entirely — only compares the caller OWN row', () => {
    const { db, bootstrap, clock } = makeDb('reval-h1-isolation');
    const now = clock.next();
    const agentA = 'agent-a';
    const agentB = 'agent-b';
    const credId = 'cred-a';
    const channelId = 'chan-1';
    insertAgent(db, agentA, bootstrap.operatorPrincipalId, now);
    insertAgent(db, agentB, bootstrap.operatorPrincipalId, now);
    insertCredential(db, credId, agentA, now);
    insertChannel(db, channelId, bootstrap.operatorPrincipalId, now);
    insertMember(db, channelId, agentA, 1, now);
    insertMember(db, channelId, agentB, 1, now);

    // Bump B's membership_epoch drastically — A's revalidation must be
    // completely unaffected.
    db.prepare('UPDATE collab_members SET membership_epoch = 99 WHERE channel_id = ? AND principal_id = ?').run(
      channelId,
      agentB
    );

    const snapshot = readRevalidationSnapshot(db, channelId, agentA, credId);
    expect(snapshot!.membershipEpoch).toBe(1); // A's own row, untouched.
    const epoch: EpochSnapshot = { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 };
    const fakeSub = { epochSnapshot: epoch } as { epochSnapshot: EpochSnapshot };
    expect(revalidationPasses(snapshot, fakeSub as never)).toBe(true);
  });
});

describe('fanoutOne — C1 critical section behavior', () => {
  it('closes a subscription with authorization_lost when revalidation fails, and delivers the close frame', async () => {
    const { db, bootstrap, clock } = makeDb('fanout-one-fail');
    const now = clock.next();
    const agentId = 'agent-1';
    const credId = 'cred-1';
    const channelId = 'chan-1';
    insertAgent(db, agentId, bootstrap.operatorPrincipalId, now);
    insertCredential(db, credId, agentId, now);
    insertChannel(db, channelId, bootstrap.operatorPrincipalId, now);
    insertMember(db, channelId, agentId, 1, now);

    const lock = new AuthLock();
    const registry = new SubscriptionRegistry();
    const frames: DeliveryFrame[] = [];
    const sub = registry.register({
      subscriptionId: 'sub-1',
      sessionId: 'session-1',
      channelId,
      principalId: agentId,
      credentialId: credId,
      rejoinedSeq: 0,
      epochSnapshot: { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 },
      highWaterCursor: 0,
      sink: (f) => frames.push(f),
      nowMs: () => 0,
    });
    sub.transitionToLive();

    // Simulate the membership row having been removed (revalidation must fail).
    db.prepare('UPDATE collab_members SET state = ? WHERE channel_id = ? AND principal_id = ?').run(
      'removed',
      channelId,
      agentId
    );

    await fanoutOne(
      { lock, registry, db },
      sub,
      {
        channelId,
        channelSeq: 5,
        eventId: 'evt-1',
        kind: 'message_posted',
        actorPrincipalId: bootstrap.operatorPrincipalId,
        occurredAt: now,
        payload: {},
      }
    );

    expect(sub.closed).toBe(true);
    expect(sub.closeReason).toBe('authorization_lost');
    expect(frames.length).toBe(1);
    expect(frames[0]!.type).toBe('subscription_closed');
  });

  it('(C4) drops immediately without touching the DB when already closed', async () => {
    const { db, bootstrap, clock } = makeDb('fanout-one-c4');
    const now = clock.next();
    const channelId = 'chan-1';
    insertChannel(db, channelId, bootstrap.operatorPrincipalId, now);

    const lock = new AuthLock();
    const registry = new SubscriptionRegistry();
    const frames: DeliveryFrame[] = [];
    const sub = registry.register({
      subscriptionId: 'sub-1',
      sessionId: 'session-1',
      channelId,
      principalId: 'nonexistent-principal', // would fail revalidation if reached.
      credentialId: 'nonexistent-cred',
      rejoinedSeq: 0,
      epochSnapshot: { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 },
      highWaterCursor: 0,
      sink: (f) => frames.push(f),
      nowMs: () => 0,
    });
    sub.close('unsubscribed');
    frames.length = 0; // clear (close() doesn't deliver frames itself).

    await fanoutOne(
      { lock, registry, db },
      sub,
      { channelId, channelSeq: 1, eventId: 'e', kind: 'message_posted', actorPrincipalId: 'x', occurredAt: now, payload: {} }
    );

    // No frame delivered (closed before fanoutOne even acquired the lock),
    // and the closeReason is untouched (still 'unsubscribed', proving no
    // DB revalidation ran and tried to overwrite it).
    expect(frames.length).toBe(0);
    expect(sub.closeReason).toBe('unsubscribed');
    expect(lock.activeReaderCount).toBe(0); // never acquired.
  });

  /**
   * THE C1 revocation-race probe, exercised as a genuine concurrent race
   * (not sequential awaits): a message is committed and its fan-out to a
   * subscription is IN FLIGHT (fanoutOne is running, holding the read
   * lock) at the exact moment a concurrent REMOVE_CHANNEL_MEMBER-style
   * write-lock acquisition is requested. Because fanoutOne's read-lock
   * hold spans the ENTIRE revalidate-then-deliver critical section with no
   * await in between (C1), the writer cannot acquire mid-flight — it must
   * wait until fanoutOne's read lock releases, by which point the frame
   * has ALREADY been delivered (correctly, since revalidation passed at
   * the time it ran). This is what "no gap" means operationally: the
   * writer is provably serialized to either fully before or fully after
   * fanoutOne's critical section, never interleaved with it.
   *
   * If an await were inserted between revalidation and the sink handoff
   * (breaking C1), the read lock would still be held (AuthLock's read
   * lock is held across the whole async fanoutOne call, since
   * releaseRead() only runs in the finally after the awaited body
   * resolves) — so this specific probe cannot observe that particular
   * regression via lock contention alone. The REAL C1 hazard the PRD
   * describes is a REMOVE that commits+purges DURING the gap and the
   * gap's own DB read becoming stale — which this test's second variant
   * (below) probes directly by mutating DB state from a separate
   * "concurrent" vantage point while fanoutOne is suspended mid-flight,
   * something only reachable if fanoutOne actually yields (awaits)
   * between its revalidation read and delivery.
   */
  it('C1 (no-await probe): a fanoutOne call started BEFORE a concurrent removal completes still delivers exactly once, and the removal is fully serialized around it (never interleaved)', async () => {
    const { db, bootstrap, clock } = makeDb('c1-serialization');
    const now = clock.next();
    const agentId = 'agent-1';
    const credId = 'cred-1';
    const channelId = 'chan-1';
    insertAgent(db, agentId, bootstrap.operatorPrincipalId, now);
    insertCredential(db, credId, agentId, now);
    insertChannel(db, channelId, bootstrap.operatorPrincipalId, now);
    insertMember(db, channelId, agentId, 1, now);

    const lock = new AuthLock();
    const registry = new SubscriptionRegistry();
    const frames: DeliveryFrame[] = [];
    const sub = registry.register({
      subscriptionId: 'sub-1',
      sessionId: 'session-1',
      channelId,
      principalId: agentId,
      credentialId: credId,
      rejoinedSeq: 0,
      epochSnapshot: { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 },
      highWaterCursor: 0,
      sink: (f) => frames.push(f),
      nowMs: () => 0,
    });
    sub.transitionToLive();

    const order: string[] = [];

    // Start fanoutOne (a "committed message" fan-out) WITHOUT awaiting it
    // yet — it begins acquiring the read lock immediately.
    const fanoutPromise = fanoutOne(
      { lock, registry, db },
      sub,
      { channelId, channelSeq: 1, eventId: 'e1', kind: 'message_posted', actorPrincipalId: agentId, occurredAt: now, payload: {} }
    ).then(() => order.push('fanout-done'));

    // "Concurrently" (same microtask turn), a write-lock acquisition
    // begins for a simulated REMOVE_CHANNEL_MEMBER.
    const writePromise = lock.acquireWrite().then(() => {
      order.push('write-acquired');
      // Simulate the removal's DB mutation + subscription close, still
      // holding the write lock.
      db.prepare('UPDATE collab_members SET state = ? WHERE channel_id = ? AND principal_id = ?').run(
        'removed',
        channelId,
        agentId
      );
      sub.close('authorization_lost');
      lock.releaseWrite();
    });

    await Promise.all([fanoutPromise, writePromise]);

    // The write acquisition can only have been granted AFTER fanoutOne's
    // read-lock hold released (which happens only after delivery, per
    // C1's no-await discipline in the unmutated source) — so fan-out
    // strictly precedes the write's DB mutation, never overlaps it.
    expect(order).toEqual(['fanout-done', 'write-acquired']);
    // Exactly one frame delivered — the message — untouched by the race.
    expect(frames.length).toBe(1);
    expect(frames[0]!.type).toBe('channel_event');
    expect(sub.closeReason).toBe('authorization_lost'); // closed AFTER by the writer.
  });

  /**
   * THE direct C1 no-await probe: proves there is no window between
   * revalidation and delivery during which an OUT-OF-BAND state change
   * (one that does not itself go through the AuthLock — e.g. a bug
   * elsewhere, or simply modeling "the world changed" at the exact
   * instant between the two statements) can cause a stale decision to be
   * delivered. We race a same-microtask-turn DB mutation directly against
   * fanoutOne's single call, with no lock involved on the mutation side at
   * all — this isolates C1's OWN internal ordering (no await between its
   * revalidation read and its sink handoff) from AuthLock's mutual
   * exclusion, which is a separate, complementary guarantee (C2).
   *
   * If C1 holds (no await between the two statements), then by the time
   * ANY other microtask (including this test's own `.then` continuation)
   * gets a turn, fanoutOne has ALREADY delivered — so a DB mutation
   * scheduled via `queueMicrotask`/`Promise.resolve().then(...)` racing
   * the SAME fanoutOne call can only ever run either fully before
   * fanoutOne starts or fully after it completes, never in the middle.
   * With the m-await mutation (an await inserted between the revalidation
   * read and delivery), the racing microtask CAN run in that gap — this
   * test detects that by checking whether the delivered frame's
   * revalidation was based on state that a same-turn racer was able to
   * mutate before delivery, which would not be possible without the
   * inserted yield point.
   */
  it('C1 (no-await probe, direct): a same-turn scheduled DB mutation cannot land inside fanoutOne revalidation-to-delivery', async () => {
    const { db, bootstrap, clock } = makeDb('c1-no-await-direct');
    const now = clock.next();
    const agentId = 'agent-1';
    const credId = 'cred-1';
    const channelId = 'chan-1';
    insertAgent(db, agentId, bootstrap.operatorPrincipalId, now);
    insertCredential(db, credId, agentId, now);
    insertChannel(db, channelId, bootstrap.operatorPrincipalId, now);
    insertMember(db, channelId, agentId, 1, now);

    const lock = new AuthLock();
    const registry = new SubscriptionRegistry();
    const frames: DeliveryFrame[] = [];
    const sub = registry.register({
      subscriptionId: 'sub-1',
      sessionId: 'session-1',
      channelId,
      principalId: agentId,
      credentialId: credId,
      rejoinedSeq: 0,
      epochSnapshot: { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 },
      highWaterCursor: 0,
      sink: (f) => frames.push(f),
      nowMs: () => 0,
    });
    sub.transitionToLive();

    let mutationRanBeforeDelivery = false;

    const fanoutPromise = fanoutOne(
      { lock, registry, db },
      sub,
      { channelId, channelSeq: 1, eventId: 'e1', kind: 'message_posted', actorPrincipalId: agentId, occurredAt: now, payload: {} }
    );

    // Scheduled in the SAME microtask turn fanoutOne started in, via a
    // single microtask hop — races directly against whatever internal
    // await structure fanoutOne has. With C1 intact (no internal await
    // between revalidation and delivery), fanoutOne's entire synchronous
    // critical section runs to completion (including the sink call) before
    // even ONE microtask hop elapses from its start, so this racer's own
    // `.then` body — which itself needs at least one microtask hop to run
    // — cannot execute before delivery. With the internal await removed
    // (m-await mutation), fanoutOne itself yields a microtask turn BEFORE
    // delivering, giving this racer's single-hop continuation a chance to
    // run first.
    const racerPromise = Promise.resolve().then(() => {
      if (frames.length === 0) {
        // Delivery has NOT happened yet — the racer got a turn inside the
        // gap. This should be impossible under C1.
        mutationRanBeforeDelivery = true;
      }
    });

    await Promise.all([fanoutPromise, racerPromise]);

    expect(mutationRanBeforeDelivery).toBe(false);
    expect(frames.length).toBe(1);
  });

  it('delivers a channel_event synchronously (write-initiated) when revalidation passes', async () => {
    const { db, bootstrap, clock } = makeDb('fanout-one-pass');
    const now = clock.next();
    const agentId = 'agent-1';
    const credId = 'cred-1';
    const channelId = 'chan-1';
    insertAgent(db, agentId, bootstrap.operatorPrincipalId, now);
    insertCredential(db, credId, agentId, now);
    insertChannel(db, channelId, bootstrap.operatorPrincipalId, now);
    insertMember(db, channelId, agentId, 1, now);

    const lock = new AuthLock();
    const registry = new SubscriptionRegistry();
    const frames: DeliveryFrame[] = [];
    const sub = registry.register({
      subscriptionId: 'sub-1',
      sessionId: 'session-1',
      channelId,
      principalId: agentId,
      credentialId: credId,
      rejoinedSeq: 0,
      epochSnapshot: { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 },
      highWaterCursor: 0,
      sink: (f) => frames.push(f),
      nowMs: () => 0,
    });
    sub.transitionToLive();

    await fanoutOne(
      { lock, registry, db },
      sub,
      { channelId, channelSeq: 1, eventId: 'e', kind: 'message_posted', actorPrincipalId: agentId, occurredAt: now, payload: { text: 'hi' } }
    );

    expect(frames.length).toBe(1);
    expect(frames[0]!.type).toBe('channel_event');
    expect(sub.closed).toBe(false);
    expect(lock.activeReaderCount).toBe(0); // released after.
  });
});

describe('(C4/M2) close frame is provably last, even with pending buffered frames at close time', () => {
  /**
   * The load-bearing "close frame is last" assertion, exercised against a
   * subscription that is STILL BUFFERING (backlog state) with undelivered
   * queued frames at the moment close() is called — the exact scenario
   * m-closeorder targets: if close() failed to purge the queue before the
   * close frame is delivered, those stale buffered frames could leak out
   * AFTER the close frame via any subsequent drain path (e.g. a buggy
   * deliverCloseFrame that also flushes the queue). This test proves the
   * purge-before-close-frame ordering holds by construction: the ONLY
   * frame the sink ever receives for this subscription is the close frame
   * itself — the two buffered channel_event frames are never delivered at
   * all, proven purged.
   */
  it('closing a subscription with pending buffered (backlog) frames purges them — the sink receives ONLY the close frame, nothing before or after', () => {
    const lock = new AuthLock();
    const registry = new SubscriptionRegistry();
    const frames: DeliveryFrame[] = [];
    const sub = registry.register({
      subscriptionId: 'sub-buffered',
      sessionId: 'session-1',
      channelId: 'chan-1',
      principalId: 'agent-1',
      credentialId: 'cred-1',
      rejoinedSeq: 0,
      epochSnapshot: { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 },
      highWaterCursor: 0,
      sink: (f) => frames.push(f),
      nowMs: () => 0,
    });
    void lock;

    // Still in 'backlog' state (transitionToLive never called) — buffer
    // two events that would otherwise be delivered once live.
    const queued1 = sub.deliverChannelEvent(
      { type: 'channel_event', protocolVersion: 2, subscriptionId: 'sub-buffered', channelId: 'chan-1', cursor: '1', event: { id: 'e1', kind: 'message_posted', actorPrincipalId: 'agent-1', occurredAt: '2026-01-01T00:00:00.000Z', payload: {} } },
      1
    );
    const queued2 = sub.deliverChannelEvent(
      { type: 'channel_event', protocolVersion: 2, subscriptionId: 'sub-buffered', channelId: 'chan-1', cursor: '2', event: { id: 'e2', kind: 'message_posted', actorPrincipalId: 'agent-1', occurredAt: '2026-01-01T00:00:00.000Z', payload: {} } },
      2
    );
    expect(queued1).toBe(true);
    expect(queued2).toBe(true);
    expect(sub.queueDepth).toBe(2);
    expect(frames.length).toBe(0); // nothing delivered yet — still buffering.

    // Close WHILE buffered content is pending.
    sub.close('channel_archived');
    expect(sub.queueDepth).toBe(0); // purged.

    // Post-lock delivery step.
    sub.deliverCloseFrame();

    // THE assertion: exactly one frame ever reached the sink for this
    // subscription, and it is the close frame — the two buffered
    // channel_event frames never leaked out, before or after.
    expect(frames.length).toBe(1);
    expect(frames[0]!.type).toBe('subscription_closed');
  });
});
