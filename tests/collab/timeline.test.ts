import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../../packages/collab/src/store.js';

function makeStore(fixtureId = 'timeline-fixture') {
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
  return { principalId: result.principalId, caller: { principalId: result.principalId, kind: 'agent' as const } };
}

// ---------------------------------------------------------------------------
// GET_CHANNEL_TIMELINE
// ---------------------------------------------------------------------------

describe('GET_CHANNEL_TIMELINE', () => {
  it('CHANNEL_VISIBLE: archived channels remain readable for active members', async () => {
    const { store, operatorCaller } = makeStore('timeline-archived-readable');
    const channel = await store.createChannel(operatorCaller, { name: 'ArchivedReadable' }, 'idem-tar-ch');
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'before archive' }, 'idem-tar-msg');
    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-tar-archive');
    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    expect(timeline.events.length).toBe(3); // channel_created, message_posted, channel_archived
  });

  it('nextCursor is last returned cursor, or effective afterCursor when events empty', async () => {
    const { store, operatorCaller } = makeStore('timeline-empty-next');
    const channel = await store.createChannel(operatorCaller, { name: 'EmptyNext' }, 'idem-ten-ch');
    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '1', limit: 100 });
    expect(timeline.events.length).toBe(0);
    expect(timeline.nextCursor).toBe('1');
    expect(timeline.hasMore).toBe(false);
  });

  it('resuming with afterCursor: nextCursor receives no duplicate and no gap', async () => {
    const { store, operatorCaller } = makeStore('timeline-resume');
    const channel = await store.createChannel(operatorCaller, { name: 'Resume' }, 'idem-tr-ch');
    for (let i = 0; i < 5; i++) {
      await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: `m${i}` }, `idem-tr-m${i}`);
    }
    const page1 = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '0', limit: 3 });
    expect(page1.events.length).toBe(3);
    expect(page1.hasMore).toBe(true);
    const page2 = await store.getChannelTimeline(operatorCaller, {
      channelId: channel.channelId,
      afterCursor: page1.nextCursor,
      limit: 100,
    });
    const allCursors = [...page1.events, ...page2.events].map((e) => e.cursor);
    const uniqueCursors = new Set(allCursors);
    expect(uniqueCursors.size).toBe(allCursors.length); // no duplicates
    const nums = allCursors.map(Number).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBe(nums[i - 1]! + 1); // no gap
    }
  });

  it('the 100-event byte fixture: 100 message_posted events of text "a" return as one full page', async () => {
    const { store, operatorCaller } = makeStore('timeline-100-fixture');
    const channel = await store.createChannel(operatorCaller, { name: '100Events' }, 'idem-t100-ch');
    for (let i = 0; i < 100; i++) {
      await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'a' }, `idem-t100-m${i}`);
    }
    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '1', limit: 100 });
    expect(timeline.events.length).toBe(100);
    expect(timeline.hasMore).toBe(false);
    for (const e of timeline.events) {
      expect((e.payload as { text: string }).text).toBe('a');
    }
  });

  it('the frame-cut fixture: 4 maximum-size messages after the channel head fit exactly 3 in one 64 KiB frame, hasMore true', async () => {
    // PRD Section 10 pins this fixture against a channel start containing
    // ONLY the four maximum-size messages, not a channel_created event
    // sharing the frame. We isolate that by paging from afterCursor 1 (the
    // channel_created event, small, already consumed) so only the four
    // maximum-size 16,384-byte messages compete for the 64 KiB frame:
    // 3 * (16,384-payload event ~16,637 bytes) ~= 49,915 bytes fits; a 4th
    // would push to ~66,553 bytes, over the 65,536-byte limit.
    const { store, operatorCaller } = makeStore('timeline-frame-cut');
    const channel = await store.createChannel(operatorCaller, { name: 'FrameCut' }, 'idem-tfc-ch'); // channel_created @1
    const maxText = 'a'.repeat(16384);
    for (let i = 0; i < 4; i++) {
      await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: maxText }, `idem-tfc-m${i}`);
    }
    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '1', limit: 100 });
    expect(timeline.events.length).toBe(3);
    expect(timeline.hasMore).toBe(true);
  });

  it('frame-cut from the true channel start (afterCursor 0): channel_created + 3 maximum-size messages fill the frame, 4th message pushes to next page', async () => {
    const { store, operatorCaller } = makeStore('timeline-frame-cut-from-start');
    const channel = await store.createChannel(operatorCaller, { name: 'FrameCutStart' }, 'idem-tfcs-ch'); // channel_created @1
    const maxText = 'a'.repeat(16384);
    for (let i = 0; i < 4; i++) {
      await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: maxText }, `idem-tfcs-m${i}`);
    }
    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    expect(timeline.events.length).toBe(4); // channel_created + 3 messages
    expect(timeline.events[0]!.kind).toBe('channel_created');
    expect(timeline.hasMore).toBe(true);
  });

  it('the single-event byte fixture: one maximum-size 16384-byte message', async () => {
    const { store, operatorCaller } = makeStore('timeline-single-max');
    const channel = await store.createChannel(operatorCaller, { name: 'SingleMax' }, 'idem-tsm-ch');
    const maxText = 'a'.repeat(16384);
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: maxText }, 'idem-tsm-post');
    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '1', limit: 100 });
    expect(timeline.events.length).toBe(1);
    expect((timeline.events[0]!.payload as { text: string }).text.length).toBe(16384);
  });

  it('global seq never appears in any returned object (scan results)', async () => {
    const { store, operatorCaller } = makeStore('timeline-no-global-seq');
    const channel = await store.createChannel(operatorCaller, { name: 'NoGlobalSeq' }, 'idem-tngs-ch');
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'hi' }, 'idem-tngs-msg');
    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    for (const e of timeline.events) {
      expect(Object.keys(e).sort()).toEqual(['actorPrincipalId', 'cursor', 'id', 'kind', 'occurredAt', 'payload'].sort());
    }
  });

  it('COLLAB_NOT_FOUND for a non-member', async () => {
    const { store, operatorCaller } = makeStore('timeline-nonmember');
    const channel = await store.createChannel(operatorCaller, { name: 'NonMemberTimeline' }, 'idem-tnm-ch');
    const nonMember = await makeAgent(store, operatorCaller, 'NonMember', 'idem-tnm-agent');
    await expect(
      store.getChannelTimeline(nonMember.caller, { channelId: channel.channelId, afterCursor: '0', limit: 10 })
    ).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// LIST_CHANNELS
// ---------------------------------------------------------------------------

describe('LIST_CHANNELS', () => {
  it('caller own cursors only, "0" when absent', async () => {
    const { store, operatorCaller } = makeStore('list-own-cursor');
    const channel = await store.createChannel(operatorCaller, { name: 'OwnCursor' }, 'idem-loc-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-loc-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-loc-add');
    await store.ackChannelCursor(operatorCaller, { channelId: channel.channelId, cursor: '2' });
    // agent has not acked.

    const opList = await store.listChannels(operatorCaller, { afterChannelId: null, limit: 100, includeArchived: false });
    const opEntry = opList.channels.find((c) => c.channelId === channel.channelId)!;
    expect(opEntry.lastAcknowledgedCursor).toBe('2');

    const agentList = await store.listChannels(agent.caller, { afterChannelId: null, limit: 100, includeArchived: false });
    const agentEntry = agentList.channels.find((c) => c.channelId === channel.channelId)!;
    expect(agentEntry.lastAcknowledgedCursor).toBe('0'); // never another principal's cursor
  });

  it('active-membership filter: only channels where caller holds active membership', async () => {
    const { store, operatorCaller } = makeStore('list-active-filter');
    const channelA = await store.createChannel(operatorCaller, { name: 'ChanA' }, 'idem-laf-cha');
    const channelB = await store.createChannel(operatorCaller, { name: 'ChanB' }, 'idem-laf-chb');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-laf-agent');
    await store.addChannelMember(operatorCaller, { channelId: channelA.channelId, principalId: agent.principalId }, 'idem-laf-add');
    // agent is not a member of channelB.

    const agentList = await store.listChannels(agent.caller, { afterChannelId: null, limit: 100, includeArchived: false });
    const ids = agentList.channels.map((c) => c.channelId);
    expect(ids).toContain(channelA.channelId);
    expect(ids).not.toContain(channelB.channelId);
  });

  it('includeArchived: archived rows appear only when requested', async () => {
    const { store, operatorCaller } = makeStore('list-include-archived');
    const active = await store.createChannel(operatorCaller, { name: 'ActiveOne' }, 'idem-lia-ch1');
    const archived = await store.createChannel(operatorCaller, { name: 'ArchivedOne' }, 'idem-lia-ch2');
    await store.archiveChannel(operatorCaller, { channelId: archived.channelId }, 'idem-lia-archive');

    const withoutArchived = await store.listChannels(operatorCaller, { afterChannelId: null, limit: 100, includeArchived: false });
    expect(withoutArchived.channels.map((c) => c.channelId)).toContain(active.channelId);
    expect(withoutArchived.channels.map((c) => c.channelId)).not.toContain(archived.channelId);

    const withArchived = await store.listChannels(operatorCaller, { afterChannelId: null, limit: 100, includeArchived: true });
    expect(withArchived.channels.map((c) => c.channelId)).toContain(archived.channelId);
  });

  it('order by channelId ascending', async () => {
    const { store, operatorCaller } = makeStore('list-order');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const c = await store.createChannel(operatorCaller, { name: `Chan${i}` }, `idem-lo-ch${i}`);
      ids.push(c.channelId);
    }
    const list = await store.listChannels(operatorCaller, { afterChannelId: null, limit: 100, includeArchived: false });
    const sorted = [...list.channels.map((c) => c.channelId)].sort();
    expect(list.channels.map((c) => c.channelId)).toEqual(sorted);
  });

  it('the 100-channel capacity fixture: exactly 100 80-char-name channels, limit 100 -> all 100 rows, hasMore false', async () => {
    const { store, operatorCaller } = makeStore('list-capacity-100');
    for (let i = 0; i < 100; i++) {
      const suffix = String(i).padStart(4, '0');
      const name = 'X'.repeat(76) + suffix; // 80 ASCII chars exactly
      await store.createChannel(operatorCaller, { name }, `idem-lc100-${i}`);
    }
    const list = await store.listChannels(operatorCaller, { afterChannelId: null, limit: 100, includeArchived: false });
    expect(list.channels.length).toBe(100);
    expect(list.hasMore).toBe(false);
  });

  it('the 101-channel capacity fixture: 101 such channels -> 100 rows, hasMore true, nextChannelId = hundredth channel id', async () => {
    const { store, operatorCaller } = makeStore('list-capacity-101');
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      const suffix = String(i).padStart(4, '0');
      const name = 'Y'.repeat(76) + suffix;
      const c = await store.createChannel(operatorCaller, { name }, `idem-lc101-${i}`);
      ids.push(c.channelId);
    }
    const list = await store.listChannels(operatorCaller, { afterChannelId: null, limit: 100, includeArchived: false });
    expect(list.channels.length).toBe(100);
    expect(list.hasMore).toBe(true);
    const sortedIds = [...ids].sort();
    expect(list.nextChannelId).toBe(sortedIds[99]);
  });

  it('pagination token strictly advances whenever hasMore is true', async () => {
    const { store, operatorCaller } = makeStore('list-pagination-advance');
    for (let i = 0; i < 15; i++) {
      await store.createChannel(operatorCaller, { name: `Pg${i}` }, `idem-lpa-${i}`);
    }
    let after: string | null = null;
    let iterations = 0;
    const seen = new Set<string>();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page: { channels: { channelId: string }[]; nextChannelId: string | null; hasMore: boolean } =
        await store.listChannels(operatorCaller, { afterChannelId: after, limit: 5, includeArchived: false });
      for (const c of page.channels) {
        expect(seen.has(c.channelId)).toBe(false);
        seen.add(c.channelId);
      }
      if (!page.hasMore) break;
      expect(page.nextChannelId).not.toBeNull();
      if (after !== null) {
        expect(page.nextChannelId! > after).toBe(true);
      }
      after = page.nextChannelId;
      iterations++;
      expect(iterations).toBeLessThan(20); // guard against infinite loop
    }
    expect(seen.size).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// ACK_CHANNEL_CURSOR
// ---------------------------------------------------------------------------

describe('ACK_CHANNEL_CURSOR', () => {
  it('first ack on a channel (no existing row) succeeds as upsert from 0', async () => {
    const { store, operatorCaller } = makeStore('ack-first');
    const channel = await store.createChannel(operatorCaller, { name: 'AckFirst' }, 'idem-af-ch');
    const result = await store.ackChannelCursor(operatorCaller, { channelId: channel.channelId, cursor: '1' });
    expect(result.acknowledgedCursor).toBe('1');
  });

  it('L2: max(existing,submitted) computed in SQL — acking a lower value does not decrease the stored cursor', async () => {
    const { store, operatorCaller } = makeStore('ack-max');
    const channel = await store.createChannel(operatorCaller, { name: 'AckMax' }, 'idem-am-ch');
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'm' }, 'idem-am-msg'); // seq 2
    await store.ackChannelCursor(operatorCaller, { channelId: channel.channelId, cursor: '2' });
    const result = await store.ackChannelCursor(operatorCaller, { channelId: channel.channelId, cursor: '1' });
    expect(result.acknowledgedCursor).toBe('2'); // unchanged, max kept
  });

  it('CURSOR_OUT_OF_RANGE at the two-branch boundary: exceeds greatest committed channel_seq', async () => {
    const { store, operatorCaller } = makeStore('ack-out-of-range');
    const channel = await store.createChannel(operatorCaller, { name: 'AckOOR' }, 'idem-aoor-ch'); // seq 1
    await expect(store.ackChannelCursor(operatorCaller, { channelId: channel.channelId, cursor: '2' })).rejects.toMatchObject({
      code: 'CURSOR_OUT_OF_RANGE',
    });
    // Boundary itself succeeds.
    const ok = await store.ackChannelCursor(operatorCaller, { channelId: channel.channelId, cursor: '1' });
    expect(ok.acknowledgedCursor).toBe('1');
  });

  it('CURSOR_OUT_OF_RANGE re-added-at-head boundary: member re-added as the channel head can ack exactly its own event, not beyond', async () => {
    const { store, operatorCaller } = makeStore('ack-readd-head');
    const channel = await store.createChannel(operatorCaller, { name: 'AckReaddHead' }, 'idem-arh-ch'); // seq 1
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-arh-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-arh-add'); // seq 2
    await store.removeChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-arh-remove'); // seq 3
    // re-add at head: this member_added event (seq 4) is the channel's greatest committed event.
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-arh-readd'); // seq 4

    const ok = await store.ackChannelCursor(agent.caller, { channelId: channel.channelId, cursor: '4' });
    expect(ok.acknowledgedCursor).toBe('4');

    await expect(store.ackChannelCursor(agent.caller, { channelId: channel.channelId, cursor: '5' })).rejects.toMatchObject({
      code: 'CURSOR_OUT_OF_RANGE',
    });
  });

  it('CURSOR_OWNER == CHANNEL_VISIBLE: a non-member ack is denied with COLLAB_NOT_FOUND', async () => {
    const { store, operatorCaller } = makeStore('ack-nonmember');
    const channel = await store.createChannel(operatorCaller, { name: 'AckNonMember' }, 'idem-anm-ch');
    const nonMember = await makeAgent(store, operatorCaller, 'NonMember', 'idem-anm-agent');
    await expect(
      store.ackChannelCursor(nonMember.caller, { channelId: channel.channelId, cursor: '1' })
    ).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
  });

  it('ack is allowed for archived channels', async () => {
    const { store, operatorCaller } = makeStore('ack-archived');
    const channel = await store.createChannel(operatorCaller, { name: 'AckArchived' }, 'idem-aa-ch');
    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-aa-archive');
    const result = await store.ackChannelCursor(operatorCaller, { channelId: channel.channelId, cursor: '2' });
    expect(result.acknowledgedCursor).toBe('2');
  });

  it('ACK_CHANNEL_CURSOR never writes collab_mutation_results (naturally idempotent, no result row)', async () => {
    const { store, operatorCaller, sqlite } = makeStore('ack-no-result-row');
    const channel = await store.createChannel(operatorCaller, { name: 'AckNoResultRow' }, 'idem-anrr-ch');
    const before = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_mutation_results').get() as { c: number }).c;
    await store.ackChannelCursor(operatorCaller, { channelId: channel.channelId, cursor: '1' });
    const after = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_mutation_results').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});
