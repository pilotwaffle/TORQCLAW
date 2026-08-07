import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { CollaborationStore, CollabError, type CallerContext } from '../../packages/collab/src/store.js';
import { nameKey } from '../../packages/collab/src/fold.js';

function makeStore(fixtureId = 'channels-fixture') {
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
// CREATE_CHANNEL
// ---------------------------------------------------------------------------

describe('CREATE_CHANNEL', () => {
  it('OPERATOR_GLOBAL: creates channel + owner membership + channel_created@1 in one transaction', async () => {
    const { store, operatorCaller, sqlite } = makeStore('create-1');
    const result = await store.createChannel(operatorCaller, { name: 'General' }, 'idem-c1');
    expect(result.name).toBe('General');

    const channelRow = sqlite.prepare('SELECT * FROM collab_channels WHERE id = ?').get(result.channelId) as {
      owner_principal_id: string;
      state: string;
    };
    expect(channelRow.state).toBe('active');
    expect(channelRow.owner_principal_id).toBe(operatorCaller.principalId);

    const memberRow = sqlite
      .prepare('SELECT * FROM collab_members WHERE channel_id = ? AND principal_id = ?')
      .get(result.channelId, operatorCaller.principalId) as { role: string; rejoined_seq: number; state: string };
    expect(memberRow.role).toBe('owner');
    expect(memberRow.rejoined_seq).toBe(0);
    expect(memberRow.state).toBe('active');

    const eventRow = sqlite
      .prepare('SELECT * FROM collab_events WHERE channel_id = ? AND channel_seq = 1')
      .get(result.channelId) as { kind: string };
    expect(eventRow.kind).toBe('channel_created');
  });

  it('L1: normalizes name (NFC+trim) BEFORE hashing and persisting', async () => {
    const { store, operatorCaller, sqlite } = makeStore('create-l1');
    const decomposed = 'Team ' + 'e' + '́' + ' Room'; // "Team é Room" decomposed
    const result = await store.createChannel(operatorCaller, { name: `  ${decomposed}  ` }, 'idem-l1');
    const expectedNfc = decomposed.normalize('NFC');
    expect(result.name).toBe(expectedNfc);

    const row = sqlite.prepare('SELECT name FROM collab_channels WHERE id = ?').get(result.channelId) as {
      name: string;
    };
    expect(row.name).toBe(expectedNfc);
  });

  it('CHANNEL_NAME_CONFLICT via the active-name_key unique index for exact duplicate names', async () => {
    const { store, operatorCaller } = makeStore('create-conflict');
    await store.createChannel(operatorCaller, { name: 'Dup' }, 'idem-d1');
    await expect(store.createChannel(operatorCaller, { name: 'Dup' }, 'idem-d2')).rejects.toMatchObject({
      code: 'CHANNEL_NAME_CONFLICT',
    });
  });

  it('Strasse-form name_key conflict at create: U+00DF vs "SS"', async () => {
    const { store, operatorCaller } = makeStore('create-strasse');
    await store.createChannel(operatorCaller, { name: 'Straße' }, 'idem-s1');
    await expect(store.createChannel(operatorCaller, { name: 'STRASSE' }, 'idem-s2')).rejects.toMatchObject({
      code: 'CHANNEL_NAME_CONFLICT',
    });
    // sanity: nameKey folds both to the same key
    expect(nameKey('Straße'.normalize('NFC'))).toBe(nameKey('STRASSE'.normalize('NFC')));
  });

  it('a non-operator (agent) caller is denied with zero row changes (COLLAB_NOT_PERMITTED)', async () => {
    const { store, operatorCaller, sqlite } = makeStore('create-nonop');
    const agent = await makeAgent(store, operatorCaller, 'Attacker', 'idem-setup');
    const before = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_channels').get() as { c: number }).c;
    await expect(store.createChannel(agent.caller, { name: 'Should Fail' }, 'idem-deny')).rejects.toThrow(CollabError);
    const after = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_channels').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// ADD_CHANNEL_MEMBER / REMOVE_CHANNEL_MEMBER
// ---------------------------------------------------------------------------

describe('ADD_CHANNEL_MEMBER', () => {
  it('validation 3: target must be kind agent, owned by the channel operator, role agent', async () => {
    const { store, operatorCaller } = makeStore('add-v3');
    const channel = await store.createChannel(operatorCaller, { name: 'V3' }, 'idem-v3-ch');
    const agent = await makeAgent(store, operatorCaller, 'Member', 'idem-v3-agent');
    const result = await store.addChannelMember(
      operatorCaller,
      { channelId: channel.channelId, principalId: agent.principalId },
      'idem-v3-add'
    );
    expect(result.membershipEpoch).toBe(1);
  });

  it('H1: rejoined_seq = MAX(channel_seq) captured BEFORE the member_added INSERT — worked example from PRD 5.3', async () => {
    const { store, operatorCaller, sqlite } = makeStore('add-h1');
    const channel = await store.createChannel(operatorCaller, { name: 'Worked' }, 'idem-h1-ch'); // channel_created @1
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-h1-agent');
    await store.addChannelMember(
      operatorCaller,
      { channelId: channel.channelId, principalId: agent.principalId },
      'idem-h1-add'
    ); // member_added @2, rejoined_seq=1

    const memberRow = sqlite
      .prepare('SELECT rejoined_seq FROM collab_members WHERE channel_id = ? AND principal_id = ?')
      .get(channel.channelId, agent.principalId) as { rejoined_seq: number };
    expect(memberRow.rejoined_seq).toBe(1);

    const eventRow = sqlite
      .prepare('SELECT channel_seq FROM collab_events WHERE channel_id = ? AND kind = ?')
      .get(channel.channelId, 'member_added') as { channel_seq: number };
    expect(eventRow.channel_seq).toBe(2);
  });

  it('M1: adding member B does not change member A row epoch (per-row isolation)', async () => {
    const { store, operatorCaller, sqlite } = makeStore('add-m1');
    const channel = await store.createChannel(operatorCaller, { name: 'M1' }, 'idem-m1-ch');
    const a = await makeAgent(store, operatorCaller, 'A', 'idem-m1-a');
    const b = await makeAgent(store, operatorCaller, 'B', 'idem-m1-b');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: a.principalId }, 'idem-m1-add-a');

    const aEpochBefore = (
      sqlite
        .prepare('SELECT membership_epoch FROM collab_members WHERE channel_id = ? AND principal_id = ?')
        .get(channel.channelId, a.principalId) as { membership_epoch: number }
    ).membership_epoch;

    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: b.principalId }, 'idem-m1-add-b');

    const aEpochAfter = (
      sqlite
        .prepare('SELECT membership_epoch FROM collab_members WHERE channel_id = ? AND principal_id = ?')
        .get(channel.channelId, a.principalId) as { membership_epoch: number }
    ).membership_epoch;

    expect(aEpochAfter).toBe(aEpochBefore);
  });

  it('owner-role insert is rejected: adding the owner as a member is COLLAB_NOT_FOUND', async () => {
    const { store, operatorCaller } = makeStore('add-owner');
    const channel = await store.createChannel(operatorCaller, { name: 'OwnerAdd' }, 'idem-owner-ch');
    await expect(
      store.addChannelMember(
        operatorCaller,
        { channelId: channel.channelId, principalId: operatorCaller.principalId },
        'idem-owner-add'
      )
    ).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
  });

  it('CHANNEL_ARCHIVED for archived channel', async () => {
    const { store, operatorCaller } = makeStore('add-archived');
    const channel = await store.createChannel(operatorCaller, { name: 'ArchAdd' }, 'idem-aa-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-aa-agent');
    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-aa-archive');
    await expect(
      store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-aa-add')
    ).rejects.toMatchObject({ code: 'CHANNEL_ARCHIVED' });
  });

  it('an agent invoking ADD_CHANNEL_MEMBER against member and non-member channels gets COLLAB_NOT_FOUND, zero row changes', async () => {
    const { store, operatorCaller, sqlite } = makeStore('add-agent-denied');
    const channel = await store.createChannel(operatorCaller, { name: 'AgentDenied' }, 'idem-ad-ch');
    const member = await makeAgent(store, operatorCaller, 'Member', 'idem-ad-member');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: member.principalId }, 'idem-ad-add');
    const target = await makeAgent(store, operatorCaller, 'Target', 'idem-ad-target');

    const before = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_members').get() as { c: number }).c;
    await expect(
      store.addChannelMember(member.caller, { channelId: channel.channelId, principalId: target.principalId }, 'idem-ad-fail')
    ).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
    const after = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_members').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe('REMOVE_CHANNEL_MEMBER', () => {
  it('validation 4: owner membership cannot be removed', async () => {
    const { store, operatorCaller } = makeStore('remove-owner');
    const channel = await store.createChannel(operatorCaller, { name: 'RemoveOwner' }, 'idem-ro-ch');
    await expect(
      store.removeChannelMember(
        operatorCaller,
        { channelId: channel.channelId, principalId: operatorCaller.principalId },
        'idem-ro-remove'
      )
    ).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
  });

  it('removes an active member and bumps that row epoch only', async () => {
    const { store, operatorCaller } = makeStore('remove-basic');
    const channel = await store.createChannel(operatorCaller, { name: 'RemoveBasic' }, 'idem-rb-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-rb-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-rb-add');
    const result = await store.removeChannelMember(
      operatorCaller,
      { channelId: channel.channelId, principalId: agent.principalId },
      'idem-rb-remove'
    );
    expect(result.membershipEpoch).toBe(2);
  });

  it('CHANNEL_ARCHIVED for archived channel', async () => {
    const { store, operatorCaller } = makeStore('remove-archived');
    const channel = await store.createChannel(operatorCaller, { name: 'RemoveArch' }, 'idem-ra-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-ra-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-ra-add');
    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-ra-archive');
    await expect(
      store.removeChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-ra-remove')
    ).rejects.toMatchObject({ code: 'CHANNEL_ARCHIVED' });
  });

  it('an agent invoking REMOVE_CHANNEL_MEMBER gets COLLAB_NOT_FOUND, zero row changes', async () => {
    const { store, operatorCaller, sqlite } = makeStore('remove-agent-denied');
    const channel = await store.createChannel(operatorCaller, { name: 'RemoveAgentDenied' }, 'idem-rad-ch');
    const member = await makeAgent(store, operatorCaller, 'Member', 'idem-rad-member');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: member.principalId }, 'idem-rad-add');

    const before = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_members').get() as { c: number }).c;
    await expect(
      store.removeChannelMember(member.caller, { channelId: channel.channelId, principalId: member.principalId }, 'idem-rad-fail')
    ).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
    const after = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_members').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// ARCHIVE_CHANNEL / UNARCHIVE_CHANNEL
// ---------------------------------------------------------------------------

describe('ARCHIVE_CHANNEL / UNARCHIVE_CHANNEL', () => {
  it('same-state archive/unarchive is a success no-op: no epoch bump, no event', async () => {
    const { store, operatorCaller, sqlite } = makeStore('same-state');
    const channel = await store.createChannel(operatorCaller, { name: 'SameState' }, 'idem-ss-ch');

    // Unarchiving an already-active channel is a no-op.
    const eventCountBefore = (
      sqlite.prepare('SELECT COUNT(*) as c FROM collab_events WHERE channel_id = ?').get(channel.channelId) as {
        c: number;
      }
    ).c;
    const unarchiveNoop = await store.unarchiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-ss-noop1');
    expect(unarchiveNoop.state).toBe('active');
    expect(unarchiveNoop.channelEpoch).toBe(1);
    const eventCountAfterNoop = (
      sqlite.prepare('SELECT COUNT(*) as c FROM collab_events WHERE channel_id = ?').get(channel.channelId) as {
        c: number;
      }
    ).c;
    expect(eventCountAfterNoop).toBe(eventCountBefore);

    // Archive, then archiving again is a no-op.
    const archived = await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-ss-archive');
    expect(archived.channelEpoch).toBe(2);
    const archiveNoop = await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-ss-noop2');
    expect(archiveNoop.state).toBe('archived');
    expect(archiveNoop.channelEpoch).toBe(2); // unchanged
  });

  it('effective archive increments channel_epoch and emits channel_archived', async () => {
    const { store, operatorCaller, sqlite } = makeStore('archive-effective');
    const channel = await store.createChannel(operatorCaller, { name: 'ArchiveEff' }, 'idem-ae-ch');
    const result = await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-ae-archive');
    expect(result.state).toBe('archived');
    expect(result.channelEpoch).toBe(2);

    const event = sqlite
      .prepare('SELECT kind FROM collab_events WHERE channel_id = ? ORDER BY channel_seq DESC LIMIT 1')
      .get(channel.channelId) as { kind: string };
    expect(event.kind).toBe('channel_archived');
  });

  it('M2: UNARCHIVE recomputes name_key; on conflict, rolls back leaving archived, no epoch bump, CHANNEL_NAME_CONFLICT', async () => {
    const { store, operatorCaller, sqlite } = makeStore('m2-conflict');
    const toArchive = await store.createChannel(operatorCaller, { name: 'Conflicting' }, 'idem-m2-ch1');
    await store.archiveChannel(operatorCaller, { channelId: toArchive.channelId }, 'idem-m2-archive');
    // A second active channel claims the same name after the first is archived.
    await store.createChannel(operatorCaller, { name: 'Conflicting' }, 'idem-m2-ch2');

    const before = sqlite.prepare('SELECT state, channel_epoch, name_key FROM collab_channels WHERE id = ?').get(
      toArchive.channelId
    ) as { state: string; channel_epoch: number; name_key: string };

    await expect(
      store.unarchiveChannel(operatorCaller, { channelId: toArchive.channelId }, 'idem-m2-unarchive')
    ).rejects.toMatchObject({ code: 'CHANNEL_NAME_CONFLICT' });

    const after = sqlite.prepare('SELECT state, channel_epoch, name_key FROM collab_channels WHERE id = ?').get(
      toArchive.channelId
    ) as { state: string; channel_epoch: number; name_key: string };
    expect(after.state).toBe('archived');
    expect(after.channel_epoch).toBe(before.channel_epoch);
    expect(after.name_key).toBe(before.name_key);
  });

  it('Strasse-form name_key conflict at unarchive', async () => {
    const { store, operatorCaller } = makeStore('unarchive-strasse');
    const toArchive = await store.createChannel(operatorCaller, { name: 'Straße' }, 'idem-us-ch1');
    await store.archiveChannel(operatorCaller, { channelId: toArchive.channelId }, 'idem-us-archive');
    await store.createChannel(operatorCaller, { name: 'STRASSE' }, 'idem-us-ch2');

    await expect(
      store.unarchiveChannel(operatorCaller, { channelId: toArchive.channelId }, 'idem-us-unarchive')
    ).rejects.toMatchObject({ code: 'CHANNEL_NAME_CONFLICT' });
  });

  it('unarchive succeeds and increments channel_epoch when no conflict', async () => {
    const { store, operatorCaller } = makeStore('unarchive-ok');
    const channel = await store.createChannel(operatorCaller, { name: 'UnarchiveOk' }, 'idem-uo-ch');
    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-uo-archive');
    const result = await store.unarchiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-uo-unarchive');
    expect(result.state).toBe('active');
    expect(result.channelEpoch).toBe(3);
  });

  it('an agent invoking ARCHIVE_CHANNEL / UNARCHIVE_CHANNEL against member and non-member channels gets COLLAB_NOT_FOUND', async () => {
    const { store, operatorCaller } = makeStore('archive-agent-denied');
    const memberChannel = await store.createChannel(operatorCaller, { name: 'MemberChan' }, 'idem-aad-ch1');
    const nonMemberChannel = await store.createChannel(operatorCaller, { name: 'NonMemberChan' }, 'idem-aad-ch2');
    const agent = await makeAgent(store, operatorCaller, 'Agent', 'idem-aad-agent');
    await store.addChannelMember(operatorCaller, { channelId: memberChannel.channelId, principalId: agent.principalId }, 'idem-aad-add');

    await expect(
      store.archiveChannel(agent.caller, { channelId: memberChannel.channelId }, 'idem-aad-fail1')
    ).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
    await expect(
      store.archiveChannel(agent.caller, { channelId: nonMemberChannel.channelId }, 'idem-aad-fail2')
    ).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
    await expect(
      store.unarchiveChannel(agent.caller, { channelId: memberChannel.channelId }, 'idem-aad-fail3')
    ).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// POST_CHANNEL_MESSAGE
// ---------------------------------------------------------------------------

describe('POST_CHANNEL_MESSAGE', () => {
  it('posts a message_posted event at the next channel_seq', async () => {
    const { store, operatorCaller, sqlite } = makeStore('post-basic');
    const channel = await store.createChannel(operatorCaller, { name: 'PostBasic' }, 'idem-pb-ch');
    const result = await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'hello' }, 'idem-pb-post');
    expect(result.cursor).toBe('2'); // channel_created@1, message@2

    const row = sqlite.prepare('SELECT kind, channel_seq FROM collab_events WHERE id = ?').get(result.eventId) as {
      kind: string;
      channel_seq: number;
    };
    expect(row.kind).toBe('message_posted');
    expect(row.channel_seq).toBe(2);
  });

  it('L1: normalizes text (NFC) BEFORE hashing/persisting', async () => {
    const { store, operatorCaller, sqlite } = makeStore('post-l1');
    const channel = await store.createChannel(operatorCaller, { name: 'PostL1' }, 'idem-pl1-ch');
    const decomposed = 'e' + '́'; // decomposed é
    const result = await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: decomposed }, 'idem-pl1-post');
    const row = sqlite.prepare('SELECT content_json FROM collab_events WHERE id = ?').get(result.eventId) as {
      content_json: string;
    };
    const payload = JSON.parse(row.content_json) as { text: string };
    expect(payload.text).toBe(decomposed.normalize('NFC'));
  });

  it('M3: evaluation order — predicate passes then active-channel check; authorized member posting to archived channel gets CHANNEL_ARCHIVED', async () => {
    const { store, operatorCaller } = makeStore('post-m3-archived');
    const channel = await store.createChannel(operatorCaller, { name: 'PostM3Archived' }, 'idem-m3a-ch');
    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-m3a-archive');
    await expect(
      store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'hi' }, 'idem-m3a-post')
    ).rejects.toMatchObject({ code: 'CHANNEL_ARCHIVED' });
  });

  it('M3 compound denial: non-member posting to an archived channel = COLLAB_NOT_FOUND byte-identical to non-member/active-hidden', async () => {
    const { store, operatorCaller } = makeStore('post-m3-compound');
    const archivedChannel = await store.createChannel(operatorCaller, { name: 'ArchivedNonMember' }, 'idem-m3c-ch1');
    await store.archiveChannel(operatorCaller, { channelId: archivedChannel.channelId }, 'idem-m3c-archive');
    const activeChannel = await store.createChannel(operatorCaller, { name: 'ActiveNonMember' }, 'idem-m3c-ch2');
    const nonMember = await makeAgent(store, operatorCaller, 'NonMember', 'idem-m3c-agent');

    let errArchived: unknown;
    let errActive: unknown;
    let errAbsent: unknown;
    try {
      await store.postChannelMessage(nonMember.caller, { channelId: archivedChannel.channelId, text: 'x' }, 'idem-m3c-1');
    } catch (e) {
      errArchived = e;
    }
    try {
      await store.postChannelMessage(nonMember.caller, { channelId: activeChannel.channelId, text: 'x' }, 'idem-m3c-2');
    } catch (e) {
      errActive = e;
    }
    try {
      await store.postChannelMessage(
        nonMember.caller,
        { channelId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', text: 'x' },
        'idem-m3c-3'
      );
    } catch (e) {
      errAbsent = e;
    }

    const dump = (e: unknown) => ({ code: (e as CollabError).code, message: (e as CollabError).message });
    expect(dump(errArchived)).toEqual({ code: 'COLLAB_NOT_FOUND', message: 'Request could not be completed' });
    expect(dump(errActive)).toEqual(dump(errArchived));
    expect(dump(errAbsent)).toEqual(dump(errArchived));
  });

  it('message boundary fixtures reuse the Slice 0 text bounds: 16384 bytes ok, 16385 rejected', async () => {
    const { store, operatorCaller } = makeStore('post-bounds');
    const channel = await store.createChannel(operatorCaller, { name: 'PostBounds' }, 'idem-pbnd-ch');
    const maxText = 'a'.repeat(16384);
    const ok = await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: maxText }, 'idem-pbnd-ok');
    expect(ok.cursor).toBe('2');

    const overText = 'a'.repeat(16385);
    await expect(
      store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: overText }, 'idem-pbnd-over')
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('C3: step-3 INVALID_REQUEST (oversize) fires before step-6 auth — byte-identical whether channel is absent, hidden, or visible', async () => {
    const { store, operatorCaller } = makeStore('post-invalid-precedence');
    const channel = await store.createChannel(operatorCaller, { name: 'InvalidPrecedence' }, 'idem-ip-ch');
    const overText = 'a'.repeat(16385);

    let errVisible: unknown;
    let errAbsent: unknown;
    try {
      await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: overText }, 'idem-ip-1');
    } catch (e) {
      errVisible = e;
    }
    try {
      await store.postChannelMessage(
        operatorCaller,
        { channelId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', text: overText },
        'idem-ip-2'
      );
    } catch (e) {
      errAbsent = e;
    }
    const dump = (e: unknown) => ({ code: (e as CollabError).code, message: (e as CollabError).message });
    expect(dump(errVisible).code).toBe('INVALID_REQUEST');
    expect(dump(errVisible)).toEqual(dump(errAbsent));
  });
});

// ---------------------------------------------------------------------------
// COLLAB_NOT_FOUND indistinguishability (C3) across all denial causes
// ---------------------------------------------------------------------------

describe('COLLAB_NOT_FOUND byte-identical across denial causes (C3)', () => {
  it('absent, hidden (non-member active), archived-hidden, non-member, and owner-only-by-non-owner all dump identically', async () => {
    const { store, operatorCaller } = makeStore('not-found-dump');
    const hiddenActive = await store.createChannel(operatorCaller, { name: 'HiddenActive' }, 'idem-nfd-ch1');
    const hiddenArchived = await store.createChannel(operatorCaller, { name: 'HiddenArchived' }, 'idem-nfd-ch2');
    await store.archiveChannel(operatorCaller, { channelId: hiddenArchived.channelId }, 'idem-nfd-archive');
    const memberChannel = await store.createChannel(operatorCaller, { name: 'MemberChannel' }, 'idem-nfd-ch3');

    const nonMember = await makeAgent(store, operatorCaller, 'NonMember', 'idem-nfd-nonmember');
    const member = await makeAgent(store, operatorCaller, 'Member', 'idem-nfd-member');
    await store.addChannelMember(operatorCaller, { channelId: memberChannel.channelId, principalId: member.principalId }, 'idem-nfd-add');

    const dump = (e: unknown) => ({
      code: (e as CollabError).code,
      message: (e as CollabError).message,
    });

    const catchErr = async (p: Promise<unknown>) => {
      try {
        await p;
        throw new Error('expected rejection');
      } catch (e) {
        return e;
      }
    };

    const eAbsent = await catchErr(
      store.getChannelTimeline(nonMember.caller, { channelId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', afterCursor: '0', limit: 10 })
    );
    const eHiddenActive = await catchErr(
      store.getChannelTimeline(nonMember.caller, { channelId: hiddenActive.channelId, afterCursor: '0', limit: 10 })
    );
    const eHiddenArchived = await catchErr(
      store.getChannelTimeline(nonMember.caller, { channelId: hiddenArchived.channelId, afterCursor: '0', limit: 10 })
    );
    const eNonMember = await catchErr(
      store.getChannelTimeline(nonMember.caller, { channelId: memberChannel.channelId, afterCursor: '0', limit: 10 })
    );
    const eOwnerOnlyByNonOwner = await catchErr(
      store.archiveChannel(member.caller, { channelId: memberChannel.channelId }, 'idem-nfd-ownercmd')
    );

    const all = [eAbsent, eHiddenActive, eHiddenArchived, eNonMember, eOwnerOnlyByNonOwner].map(dump);
    for (const d of all) {
      expect(d).toEqual({ code: 'COLLAB_NOT_FOUND', message: 'Request could not be completed' });
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata visibility: count derivable, content is not (Section 7.4)
// ---------------------------------------------------------------------------

describe('metadata visibility: a current member can derive event COUNT but no removal-window CONTENT', () => {
  it('cursor arithmetic reveals count of events during a removal window, but timeline never returns their content', async () => {
    const { store, operatorCaller } = makeStore('metadata-visibility');
    const channel = await store.createChannel(operatorCaller, { name: 'MetaVis' }, 'idem-mv-ch'); // seq 1
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-mv-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-mv-add'); // seq 2, rejoined_seq=1

    await store.removeChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-mv-remove'); // seq 3
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'secret during removal' }, 'idem-mv-secret'); // seq 4
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-mv-readd'); // seq 5, rejoined_seq=4

    const timeline = await store.getChannelTimeline(agent.caller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    // Content: only re-added member_added@5 onward is visible, no earlier content.
    expect(timeline.events.map((e) => e.cursor)).toEqual(['5']);
    for (const e of timeline.events) {
      expect(JSON.stringify(e)).not.toMatch(/secret during removal/);
    }
  });
});
