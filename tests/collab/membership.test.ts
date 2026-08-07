import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../../packages/collab/src/store.js';

function makeStore(fixtureId = 'membership-fixture') {
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

describe('Re-add truncation: PRD 5.3 worked example, pinned exact sequence numbers', () => {
  it('added@2 (rejoined_seq 1) reads 3-4; removed@5; 6-8 commit; re-added@9 (rejoined_seq 8) reaches only 9+', async () => {
    const { store, operatorCaller } = makeStore('readd-truncation');
    const channel = await store.createChannel(operatorCaller, { name: 'Truncation' }, 'idem-rt-ch'); // channel_created @1
    const a = await makeAgent(store, operatorCaller, 'A', 'idem-rt-a');

    // added@2, rejoined_seq=1
    const added = await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: a.principalId }, 'idem-rt-add');
    expect(added.membershipEpoch).toBe(1);

    // messages @3, @4 — A can read these.
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'msg-3' }, 'idem-rt-m3');
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'msg-4' }, 'idem-rt-m4');

    // removed@5
    await store.removeChannelMember(operatorCaller, { channelId: channel.channelId, principalId: a.principalId }, 'idem-rt-remove');

    // 6,7,8 commit while A is removed.
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'msg-6' }, 'idem-rt-m6');
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'msg-7' }, 'idem-rt-m7');
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'msg-8' }, 'idem-rt-m8');

    // re-added@9, rejoined_seq should become 8 (MAX(channel_seq) before insert = 8).
    // membership_epoch is a per-row counter incremented on every EFFECTIVE
    // transition of this (channel_id,principal_id) row: add=1, remove=2,
    // re-add=3 (not pinned by the PRD worked example itself, which only
    // pins rejoined_seq/channel_seq; epoch monotonicity is what's checked).
    const readded = await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: a.principalId }, 'idem-rt-readd');
    expect(readded.membershipEpoch).toBe(3);
    expect(readded.membershipEpoch).toBeGreaterThan(added.membershipEpoch);

    // Timeline from afterCursor 0: A reaches only 9+, own member_added first.
    const timeline = await store.getChannelTimeline(a.caller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    expect(timeline.events.map((e) => e.cursor)).toEqual(['9']);
    expect(timeline.events[0]!.kind).toBe('member_added');

    // 2-4 and 6-8 unreachable via timeline even with an explicit low afterCursor.
    const timelineFromZeroExplicit = await store.getChannelTimeline(a.caller, {
      channelId: channel.channelId,
      afterCursor: '0',
      limit: 100,
    });
    for (const e of timelineFromZeroExplicit.events) {
      expect(Number(e.cursor)).toBeGreaterThanOrEqual(9);
    }
  });

  it('first-time member timeline from afterCursor 0 begins at its own member_added event', async () => {
    const { store, operatorCaller } = makeStore('first-time-member');
    const channel = await store.createChannel(operatorCaller, { name: 'FirstTime' }, 'idem-ftm-ch'); // @1
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'before member joins' }, 'idem-ftm-msg'); // @2
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-ftm-agent');
    const added = await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-ftm-add'); // @3, rejoined_seq=2
    expect(added.membershipEpoch).toBe(1);

    const timeline = await store.getChannelTimeline(agent.caller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    expect(timeline.events[0]!.cursor).toBe('3');
    expect(timeline.events[0]!.kind).toBe('member_added');
    expect(timeline.events.length).toBe(1);
  });

  it('cursor rows survive archive and unarchive unchanged', async () => {
    const { store, operatorCaller, sqlite } = makeStore('cursor-survives-archive');
    const channel = await store.createChannel(operatorCaller, { name: 'CursorSurvive' }, 'idem-csa-ch');
    await store.ackChannelCursor(operatorCaller, { channelId: channel.channelId, cursor: '1' });

    const before = sqlite
      .prepare('SELECT acknowledged_seq FROM collab_cursors WHERE channel_id = ? AND principal_id = ?')
      .get(channel.channelId, operatorCaller.principalId) as { acknowledged_seq: number };

    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-csa-archive');
    await store.unarchiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-csa-unarchive');

    const after = sqlite
      .prepare('SELECT acknowledged_seq FROM collab_cursors WHERE channel_id = ? AND principal_id = ?')
      .get(channel.channelId, operatorCaller.principalId) as { acknowledged_seq: number };
    expect(after.acknowledged_seq).toBe(before.acknowledged_seq);
  });
});

describe('membership_epoch per-row isolation (M1) — extended cases', () => {
  it('remove of member A does not change member B row epoch', async () => {
    const { store, operatorCaller, sqlite } = makeStore('m1-remove-isolation');
    const channel = await store.createChannel(operatorCaller, { name: 'M1Remove' }, 'idem-m1r-ch');
    const a = await makeAgent(store, operatorCaller, 'A', 'idem-m1r-a');
    const b = await makeAgent(store, operatorCaller, 'B', 'idem-m1r-b');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: a.principalId }, 'idem-m1r-add-a');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: b.principalId }, 'idem-m1r-add-b');

    const bEpochBefore = (
      sqlite
        .prepare('SELECT membership_epoch FROM collab_members WHERE channel_id = ? AND principal_id = ?')
        .get(channel.channelId, b.principalId) as { membership_epoch: number }
    ).membership_epoch;

    await store.removeChannelMember(operatorCaller, { channelId: channel.channelId, principalId: a.principalId }, 'idem-m1r-remove-a');

    const bEpochAfter = (
      sqlite
        .prepare('SELECT membership_epoch FROM collab_members WHERE channel_id = ? AND principal_id = ?')
        .get(channel.channelId, b.principalId) as { membership_epoch: number }
    ).membership_epoch;

    expect(bEpochAfter).toBe(bEpochBefore);
  });

  it('subscription-survival precondition: A remains a valid active member row while B is added (no field on A changes except what A itself triggers)', async () => {
    const { store, operatorCaller, sqlite } = makeStore('m1-subscription-survival');
    const channel = await store.createChannel(operatorCaller, { name: 'SubSurvival' }, 'idem-m1s-ch');
    const a = await makeAgent(store, operatorCaller, 'A', 'idem-m1s-a');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: a.principalId }, 'idem-m1s-add-a');

    const aRowBefore = sqlite
      .prepare('SELECT * FROM collab_members WHERE channel_id = ? AND principal_id = ?')
      .get(channel.channelId, a.principalId);

    const b = await makeAgent(store, operatorCaller, 'B', 'idem-m1s-b');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: b.principalId }, 'idem-m1s-add-b');

    const aRowAfter = sqlite
      .prepare('SELECT * FROM collab_members WHERE channel_id = ? AND principal_id = ?')
      .get(channel.channelId, a.principalId);

    expect(aRowAfter).toEqual(aRowBefore);

    // A can see B's member_added event delivered in sequence via timeline.
    const timeline = await store.getChannelTimeline(a.caller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    const kinds = timeline.events.map((e) => e.kind);
    expect(kinds).toContain('member_added');
    expect(timeline.events.some((e) => (e.payload as { principalId?: string }).principalId === b.principalId)).toBe(true);
  });
});
