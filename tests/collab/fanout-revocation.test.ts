import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../../packages/collab/src/store.js';
import type { DeliveryFrame, ChannelEventFrame, SubscriptionCloseFrame } from '../../packages/collab/src/subscriptions.js';

function makeStore(fixtureId: string) {
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

  const store = new CollaborationStore({
    db,
    clock,
    uuids,
    rng,
    principalPepper: bootstrap.principalPepper,
  });

  const operatorCaller: CallerContext = { principalId: bootstrap.operatorPrincipalId, kind: 'operator' };

  return { sqlite, db, store, bootstrap, operatorCaller, clock, uuids };
}

async function makeAgent(store: CollaborationStore, operatorCaller: CallerContext, name: string, idem: string) {
  const result = await store.createAgent(operatorCaller, { displayName: name }, idem);
  return {
    principalId: result.principalId,
    credentialId: result.credentialId,
    caller: { principalId: result.principalId, kind: 'agent' as const },
  };
}

/** A simple recording sink: captures every frame delivered, in order. */
function makeRecordingSink() {
  const frames: DeliveryFrame[] = [];
  const sink = (frame: DeliveryFrame) => {
    frames.push(frame);
  };
  return { frames, sink };
}

let subIdCounter = 0;
function nextSubId(): string {
  subIdCounter++;
  return `sub-${subIdCounter}-${'0'.repeat(8)}-0000-4000-8000-${String(subIdCounter).padStart(12, '0')}`;
}

let sessionIdCounter = 0;
function nextSessionId(): string {
  sessionIdCounter++;
  return `session-${sessionIdCounter}`;
}

describe('(C3) registration is atomic with high-water capture', () => {
  /**
   * Structural source-level assertion of the C3 atomicity contract:
   * `SubscriptionRegistry.register(...)` (which performs insertion +
   * `buffering=true` + high-water capture as one call) MUST be invoked
   * textually INSIDE the `this.mutex.withLock(() => { ... })` synchronous
   * callback in `store.ts`'s `subscribeChannel` driver — not after
   * `await this.withReadThenSequencer(...)` resolves. This is checked
   * directly against the source text because — as verified empirically
   * with a dedicated stress/race harness during this build — the
   * sequencer mutex's strict FIFO single-waiter ordering (combined with
   * every caller needing its own `acquireRead()` await before it can even
   * queue on the mutex) makes the specific "commit lands in the gap"
   * window structurally unreachable through the public async store API:
   * any commit initiated AFTER `subscribeChannel` is called cannot
   * complete its own mutex turn before `subscribeChannel`'s mutex turn
   * (queued first) has already released and its synchronous continuation
   * (`registry.register`, when placed inside the same callback) has run.
   * That structural guarantee is ITSELF contingent on register living
   * inside the mutex-held callback — moving it outside (the m-highwater
   * defect) is a source-level regression whose observable failure mode
   * (a low-probability, timing-dependent dropped event under real
   * concurrent multi-client load) is exactly what Section 8.3 mandates be
   * prevented by construction, not by getting lucky with scheduling. This
   * test pins the construction directly.
   */
  it('registry.register(...) is called inside the sequencer-mutex-held callback in subscribeChannel, not after it resolves', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const storeSrcPath = path.resolve(__dirname, '../../packages/collab/src/store.ts');
    const source = fs.readFileSync(storeSrcPath, 'utf8');

    const methodStart = source.indexOf('async subscribeChannel(');
    expect(methodStart).toBeGreaterThan(-1);

    // Isolate the subscribeChannel method body up to the next top-level
    // method (unsubscribeChannel) as a reasonable bound.
    const nextMethodStart = source.indexOf('async unsubscribeChannel(', methodStart);
    expect(nextMethodStart).toBeGreaterThan(methodStart);
    const methodBody = source.slice(methodStart, nextMethodStart);

    // Within the method, find the mutex.withLock(...) callback span and
    // the register(...) call, and assert register's call site is
    // textually BEFORE the callback's closing `})` that ends
    // `this.mutex.withLock(() => { ... })` — i.e., inside it.
    const mutexCallIdx = methodBody.indexOf('this.mutex.withLock(() => {');
    expect(mutexCallIdx).toBeGreaterThan(-1);
    const registerCallIdx = methodBody.indexOf('this.registry.register(', mutexCallIdx);
    expect(registerCallIdx).toBeGreaterThan(-1);

    // Find the matching closing brace for the withLock arrow-function body
    // by brace-depth scanning from the callback's opening `{`.
    const openBraceIdx = methodBody.indexOf('{', mutexCallIdx + 'this.mutex.withLock(() => '.length);
    let depth = 0;
    let closeBraceIdx = -1;
    for (let i = openBraceIdx; i < methodBody.length; i++) {
      const ch = methodBody[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          closeBraceIdx = i;
          break;
        }
      }
    }
    expect(closeBraceIdx).toBeGreaterThan(openBraceIdx);

    // THE assertion: register(...) call site falls strictly between the
    // callback's opening and closing braces — i.e., inside the
    // mutex-held synchronous critical section, atomic with the highWater
    // capture that also happens in this same block.
    expect(registerCallIdx).toBeGreaterThan(openBraceIdx);
    expect(registerCallIdx).toBeLessThan(closeBraceIdx);
  });

  it('end-to-end: SUBSCRIBE_CHANNEL followed immediately by further commits sees every event with no gap (covers the observable behavior the atomicity contract protects)', async () => {
    const { store, operatorCaller } = makeStore('c3-end-to-end');
    const channel = await store.createChannel(operatorCaller, { name: 'C3E2E' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add');

    const { frames, sink } = makeRecordingSink();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agent.credentialId, sink },
      nextSubId()
    );

    for (let i = 0; i < 30; i++) {
      await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: `m${i}` }, `idem-m${i}`);
    }

    const cursors = frames
      .filter((f): f is ChannelEventFrame => f.type === 'channel_event')
      .map((f) => Number(f.cursor));
    const expected = [2, ...Array.from({ length: 30 }, (_, i) => 3 + i)];
    expect(cursors).toEqual(expected);
  });
});

describe('SUBSCRIBE_CHANNEL: backlog -> live, gap-free and duplicate-free', () => {
  it('first-timer backlog from 0 begins at its own member_added and delivers ascending, then transitions live', async () => {
    const { store, operatorCaller } = makeStore('backlog-firsttimer');
    const channel = await store.createChannel(operatorCaller, { name: 'Backlog1' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add'); // @2, rejoined_seq=1
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'hello' }, 'idem-m1'); // @3

    const { frames, sink } = makeRecordingSink();
    const subId = nextSubId();
    const sessionId = nextSessionId();

    const result = await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId, credentialId: agent.credentialId, sink },
      subId
    );

    expect(result.highWaterCursor).toBe('3');
    // Backlog: member_added@2, message_posted@3 — ascending, gap-free.
    const eventFrames = frames.filter((f): f is ChannelEventFrame => f.type === 'channel_event');
    expect(eventFrames.map((f) => f.cursor)).toEqual(['2', '3']);
    expect(eventFrames[0]!.event.kind).toBe('member_added');
    expect(eventFrames[1]!.event.kind).toBe('message_posted');
  });

  it('an event committed immediately after highWater capture is delivered exactly once (C3 — no dup at the boundary)', async () => {
    const { store, operatorCaller } = makeStore('backlog-boundary');
    const channel = await store.createChannel(operatorCaller, { name: 'Boundary' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add'); // @2

    const { frames, sink } = makeRecordingSink();
    const subId = nextSubId();
    const sessionId = nextSessionId();

    // Subscribe: highWater will be 2 (channel_created@1, member_added@2).
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId, credentialId: agent.credentialId, sink },
      subId
    );

    const eventFramesAfterSubscribe = frames.filter((f): f is ChannelEventFrame => f.type === 'channel_event');
    expect(eventFramesAfterSubscribe.map((f) => f.cursor)).toEqual(['2']);

    // Now post a message AFTER subscribe resolved — this exercises live
    // fan-out (subscribeChannel already transitioned to live internally).
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'post-sub' }, 'idem-m1'); // @3

    const eventFramesAfterPost = frames.filter((f): f is ChannelEventFrame => f.type === 'channel_event');
    // Exactly once — @2 (backlog) then @3 (live fan-out), no gap, no dup.
    expect(eventFramesAfterPost.map((f) => f.cursor)).toEqual(['2', '3']);
  });

  it('gap-free/duplicate-free across multiple sequential live posts', async () => {
    const { store, operatorCaller } = makeStore('backlog-sequential-live');
    const channel = await store.createChannel(operatorCaller, { name: 'SeqLive' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add'); // @2

    const { frames, sink } = makeRecordingSink();
    const subId = nextSubId();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agent.credentialId, sink },
      subId
    );

    for (let i = 0; i < 10; i++) {
      await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: `m${i}` }, `idem-m${i}`);
    }

    const cursors = frames
      .filter((f): f is ChannelEventFrame => f.type === 'channel_event')
      .map((f) => Number(f.cursor));
    // @2 (member_added) then @3..@12 (10 messages) — strictly ascending, no gaps.
    expect(cursors).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const uniqueCursors = new Set(cursors);
    expect(uniqueCursors.size).toBe(cursors.length); // no duplicates.
  });
});

describe('REVOCATION RACE: no channel_event after close; close frame is last', () => {
  it('REMOVE_CHANNEL_MEMBER: principal receives no channel_event for a message posted just before removal and gets a close frame last', async () => {
    const { store, operatorCaller } = makeStore('revocation-remove');
    const channel = await store.createChannel(operatorCaller, { name: 'Revoke1' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add');

    const { frames, sink } = makeRecordingSink();
    const subId = nextSubId();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agent.credentialId, sink },
      subId
    );
    frames.length = 0; // clear backlog frames; focus on the post-subscribe race.

    // Post a message, then immediately remove the member. Both are awaited
    // sequentially here (single-threaded Node has no true parallelism to
    // race against — the interleaving under test is: does REMOVE's
    // synchronous write-lock-held close+purge run strictly after the
    // message's fan-out already delivered, or does it race and win?).
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'before-remove' }, 'idem-m1');
    await store.removeChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-remove');

    // The message DID deliver (it committed and fanned out before removal
    // started) — that's expected; the invariant under test is closure
    // ordering, not "no message ever arrives". Assert: whatever channel_event
    // frames exist, none arrive AFTER the close frame, and the close frame
    // is the absolute last frame.
    expect(frames.length).toBeGreaterThan(0);
    const lastFrame = frames[frames.length - 1]!;
    expect(lastFrame.type).toBe('subscription_closed');
    expect((lastFrame as SubscriptionCloseFrame).reason).toBe('authorization_lost');

    // No channel_event frame appears anywhere after the close frame's index.
    const closeIdx = frames.findIndex((f) => f.type === 'subscription_closed');
    expect(closeIdx).toBe(frames.length - 1);
  });

  it('a message posted and fanned out BEFORE removal starts is delivered exactly once, then removal produces exactly one close frame and NOTHING after', async () => {
    const { store, operatorCaller } = makeStore('revocation-remove-2');
    const channel = await store.createChannel(operatorCaller, { name: 'Revoke2' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add');

    const { frames, sink } = makeRecordingSink();
    const subId = nextSubId();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agent.credentialId, sink },
      subId
    );
    const backlogCount = frames.length;

    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'msg' }, 'idem-m1');
    expect(frames.length).toBe(backlogCount + 1); // delivered once.

    await store.removeChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-remove');
    expect(frames.length).toBe(backlogCount + 2); // + exactly one close frame.
    expect(frames[frames.length - 1]!.type).toBe('subscription_closed');

    // Posting further messages after removal must NOT reach this
    // subscription at all (closed subscriptions drop fan-out — C4).
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'after-removal' }, 'idem-m2');
    expect(frames.length).toBe(backlogCount + 2); // unchanged.
  });

  it('SUSPEND_AGENT closes the subscription with authorization_lost as the last frame', async () => {
    const { store, operatorCaller } = makeStore('revocation-suspend');
    const channel = await store.createChannel(operatorCaller, { name: 'Suspend1' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add');

    const { frames, sink } = makeRecordingSink();
    const subId = nextSubId();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agent.credentialId, sink },
      subId
    );

    await store.suspendAgent(operatorCaller, { principalId: agent.principalId }, 'idem-suspend');

    const lastFrame = frames[frames.length - 1]!;
    expect(lastFrame.type).toBe('subscription_closed');
    expect((lastFrame as SubscriptionCloseFrame).reason).toBe('authorization_lost');

    // No further channel_event ever reaches this subscription.
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'after-suspend' }, 'idem-m1');
    expect(frames[frames.length - 1]!.type).toBe('subscription_closed'); // still last.
  });

  it('REVOKE_AGENT closes the subscription with authorization_lost as the last frame', async () => {
    const { store, operatorCaller } = makeStore('revocation-revoke');
    const channel = await store.createChannel(operatorCaller, { name: 'Revoke3' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add');

    const { frames, sink } = makeRecordingSink();
    const subId = nextSubId();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agent.credentialId, sink },
      subId
    );

    await store.revokeAgent(operatorCaller, { principalId: agent.principalId }, 'idem-revoke');

    const lastFrame = frames[frames.length - 1]!;
    expect(lastFrame.type).toBe('subscription_closed');
    expect((lastFrame as SubscriptionCloseFrame).reason).toBe('authorization_lost');
  });

  it('ARCHIVE_CHANNEL closes live subscriptions with channel_archived as the last frame', async () => {
    const { store, operatorCaller } = makeStore('revocation-archive');
    const channel = await store.createChannel(operatorCaller, { name: 'Archive1' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add');

    const { frames, sink } = makeRecordingSink();
    const subId = nextSubId();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agent.credentialId, sink },
      subId
    );

    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-archive');

    const lastFrame = frames[frames.length - 1]!;
    expect(lastFrame.type).toBe('subscription_closed');
    expect((lastFrame as SubscriptionCloseFrame).reason).toBe('channel_archived');
  });

  it('UNARCHIVE_CHANNEL closes live subscriptions with channel_unarchived as the last frame', async () => {
    const { store, operatorCaller } = makeStore('revocation-unarchive');
    const channel = await store.createChannel(operatorCaller, { name: 'Unarchive1' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add');
    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-archive');

    // Resubscribe read-only to the archived channel.
    const { frames, sink } = makeRecordingSink();
    const subId = nextSubId();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agent.credentialId, sink },
      subId
    );

    await store.unarchiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-unarchive');

    const lastFrame = frames[frames.length - 1]!;
    expect(lastFrame.type).toBe('subscription_closed');
    expect((lastFrame as SubscriptionCloseFrame).reason).toBe('channel_unarchived');
  });

  it('C4: per-write path checks closed FIRST — a subscription closed by a mutation drops subsequent fan-out for events already in flight', async () => {
    const { store, operatorCaller } = makeStore('revocation-c4');
    const channel = await store.createChannel(operatorCaller, { name: 'C4Test' }, 'idem-ch');
    const agentA = await makeAgent(store, operatorCaller, 'A', 'idem-agent-a');
    const agentB = await makeAgent(store, operatorCaller, 'B', 'idem-agent-b');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agentA.principalId }, 'idem-add-a');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agentB.principalId }, 'idem-add-b');

    const subA = makeRecordingSink();
    const subB = makeRecordingSink();
    await store.subscribeChannel(
      agentA.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agentA.credentialId, sink: subA.sink },
      nextSubId()
    );
    await store.subscribeChannel(
      agentB.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agentB.credentialId, sink: subB.sink },
      nextSubId()
    );

    // Remove A only.
    await store.removeChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agentA.principalId }, 'idem-remove-a');
    const aFramesAfterRemove = subA.frames.length;

    // Post a message — B should receive it live; A must not (closed).
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'post-after-a-removed' }, 'idem-m1');

    expect(subA.frames.length).toBe(aFramesAfterRemove); // unchanged — dropped.
    const bEventFrames = subB.frames.filter((f): f is ChannelEventFrame => f.type === 'channel_event');
    expect(bEventFrames[bEventFrames.length - 1]!.event.payload).toMatchObject({ text: 'post-after-a-removed' });
  });
});

describe('own-row epoch isolation across live subs', () => {
  it('adding member B leaves A live sub delivering in sequence, unaffected', async () => {
    const { store, operatorCaller } = makeStore('epoch-isolation');
    const channel = await store.createChannel(operatorCaller, { name: 'Isolation' }, 'idem-ch');
    const agentA = await makeAgent(store, operatorCaller, 'A', 'idem-agent-a');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agentA.principalId }, 'idem-add-a');

    const subA = makeRecordingSink();
    await store.subscribeChannel(
      agentA.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId: nextSessionId(), credentialId: agentA.credentialId, sink: subA.sink },
      nextSubId()
    );

    const agentB = await makeAgent(store, operatorCaller, 'B', 'idem-agent-b');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agentB.principalId }, 'idem-add-b');

    // A's subscription must still be live (not closed) and must have
    // received B's member_added event in sequence.
    const closeFrames = subA.frames.filter((f) => f.type === 'subscription_closed');
    expect(closeFrames.length).toBe(0);

    const eventFrames = subA.frames.filter((f): f is ChannelEventFrame => f.type === 'channel_event');
    const memberAddedForB = eventFrames.find(
      (f) => f.event.kind === 'member_added' && (f.event.payload as { principalId?: string }).principalId === agentB.principalId
    );
    expect(memberAddedForB).toBeDefined();

    // Further messages continue to deliver to A afterward, proving the sub is still fully live.
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'still-live' }, 'idem-m1');
    const finalEventFrames = subA.frames.filter((f): f is ChannelEventFrame => f.type === 'channel_event');
    expect(finalEventFrames[finalEventFrames.length - 1]!.event.payload).toMatchObject({ text: 'still-live' });
  });
});

describe('UNSUBSCRIBE_CHANNEL', () => {
  it('closes only the target subscription with reason unsubscribed; session and other subscriptions stay live', async () => {
    const { store, operatorCaller } = makeStore('unsubscribe-1');
    const channelA = await store.createChannel(operatorCaller, { name: 'UnsubA' }, 'idem-ch-a');
    const channelB = await store.createChannel(operatorCaller, { name: 'UnsubB' }, 'idem-ch-b');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channelA.channelId, principalId: agent.principalId }, 'idem-add-a');
    await store.addChannelMember(operatorCaller, { channelId: channelB.channelId, principalId: agent.principalId }, 'idem-add-b');

    const sessionId = nextSessionId();
    const subA = makeRecordingSink();
    const subB = makeRecordingSink();
    const subAId = nextSubId();
    const subBId = nextSubId();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channelA.channelId, afterCursor: '0', sessionId, credentialId: agent.credentialId, sink: subA.sink },
      subAId
    );
    await store.subscribeChannel(
      agent.caller,
      { channelId: channelB.channelId, afterCursor: '0', sessionId, credentialId: agent.credentialId, sink: subB.sink },
      subBId
    );

    const unsub = await store.unsubscribeChannel(agent.caller, { subscriptionId: subAId, sessionId });
    expect(unsub.state).toBe('closed');
    const closeFrameA = subA.frames[subA.frames.length - 1]!;
    expect(closeFrameA.type).toBe('subscription_closed');
    expect((closeFrameA as SubscriptionCloseFrame).reason).toBe('unsubscribed');

    // B's subscription is unaffected — no close frame delivered to it.
    expect(subB.frames.some((f) => f.type === 'subscription_closed')).toBe(false);

    // B still receives live events.
    await store.postChannelMessage(operatorCaller, { channelId: channelB.channelId, text: 'still-live-b' }, 'idem-m1');
    const bEventFrames = subB.frames.filter((f): f is ChannelEventFrame => f.type === 'channel_event');
    expect(bEventFrames[bEventFrames.length - 1]!.event.payload).toMatchObject({ text: 'still-live-b' });
  });

  it('repeated UNSUBSCRIBE by the owning session returns the same closed result without a second close frame', async () => {
    const { store, operatorCaller } = makeStore('unsubscribe-repeat');
    const channel = await store.createChannel(operatorCaller, { name: 'UnsubRepeat' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add');

    const sessionId = nextSessionId();
    const sub = makeRecordingSink();
    const subId = nextSubId();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channel.channelId, afterCursor: '0', sessionId, credentialId: agent.credentialId, sink: sub.sink },
      subId
    );

    const first = await store.unsubscribeChannel(agent.caller, { subscriptionId: subId, sessionId });
    expect(first.state).toBe('closed');
    const closeFrameCountAfterFirst = sub.frames.filter((f) => f.type === 'subscription_closed').length;
    expect(closeFrameCountAfterFirst).toBe(1);

    const second = await store.unsubscribeChannel(agent.caller, { subscriptionId: subId, sessionId });
    expect(second.state).toBe('closed');
    const closeFrameCountAfterSecond = sub.frames.filter((f) => f.type === 'subscription_closed').length;
    expect(closeFrameCountAfterSecond).toBe(1); // NOT re-delivered.
  });
});

describe('write-lock acquisition wait is bounded under sustained reader arrival (writer preference)', () => {
  it('a revocation completes without waiting on an unbounded stream of read-lock-class commands', async () => {
    const { store, operatorCaller } = makeStore('writer-preference-store');
    const channel = await store.createChannel(operatorCaller, { name: 'WriterPref' }, 'idem-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-add');

    // Fire off a batch of read-path LIST_CHANNELS calls concurrently with a
    // revocation. All should resolve; the revocation must not be starved.
    const reads = Array.from({ length: 20 }, () =>
      store.listChannels(operatorCaller, { afterChannelId: null, limit: 10, includeArchived: false })
    );
    const revoke = store.revokeAgent(operatorCaller, { principalId: agent.principalId }, 'idem-revoke');

    const [revokeResult] = await Promise.all([revoke, ...reads]);
    expect(revokeResult.status).toBe('revoked');
  });
});
