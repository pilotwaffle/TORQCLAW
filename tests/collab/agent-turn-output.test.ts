import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  attachDispatchRequestId,
  claimAgentTurn,
  findStrandedAgentTurns,
  getAgentTurnOutput,
  reclaimStrandedAgentTurn,
} from '../../packages/collab/src/autoReply.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import {
  runAgentAutoreplyMigration,
  runAgentRuntimeProfileMigration,
  runCollaborationMigration,
} from '../../packages/collab/src/migration.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { CollaborationStore, type CallerContext } from '../../packages/collab/src/store.js';

function fixture() {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  runAgentAutoreplyMigration(sqlite);
  runAgentRuntimeProfileMigration(sqlite);
  const db: BootstrapDb = {
    prepare: (sql) => sqlite.prepare(sql),
    exec: (sql) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids('turn-output');
  const bootstrap = bootstrapOperator(
    { db, secretStore: new InMemorySecretStore(), clock, uuids, rng: nodeRandomSource },
    { operatorDisplayName: 'Operator', installationId: 'turn-output', schemaVersion: 1 },
  );
  const store = new CollaborationStore({
    db,
    clock,
    uuids,
    rng: nodeRandomSource,
    principalPepper: bootstrap.principalPepper,
  });
  const operator: CallerContext = { principalId: bootstrap.operatorPrincipalId, kind: 'operator' };
  return { sqlite, db, store, operator };
}

async function preparedTurn() {
  const f = fixture();
  const channel = await f.store.createChannel(f.operator, { name: 'Output room' }, 'channel');
  const agent = await f.store.createAgent(f.operator, { displayName: 'Local Agent' }, 'agent');
  await f.store.addChannelMember(
    f.operator,
    { channelId: channel.channelId, principalId: agent.principalId },
    'member',
  );
  await f.store.upsertAgentRuntimeProfile(f.operator, {
    agentPrincipalId: agent.principalId,
    providerAccountId: 'ollama-local',
    adapterId: 'ollama-local',
    modelId: 'torq-ai-v5',
    autostart: true,
    externalContextConfirmed: false,
  }, 'profile');
  const persona = await f.store.upsertAgentPersona(f.operator, {
    agentPrincipalId: agent.principalId,
    iconId: 'robot',
    systemDirectives: 'Answer directly.',
    expectedRevision: 0,
  }, 'persona', () => true);
  const trigger = await f.store.postChannelMessage(
    f.operator,
    { channelId: channel.channelId, text: 'Question' },
    'trigger',
  );
  const channelSeq = Number(trigger.cursor);
  const claim = await f.store.claimAgentTurn({
    channelId: channel.channelId,
    agentPrincipalId: agent.principalId,
    channelSeq,
    triggerEventId: trigger.eventId,
    nowIso: '2026-08-21T12:00:00.000Z',
  });
  expect(claim.status).toBe('claimed');
  if (claim.status !== 'claimed') throw new Error('claim failed');
  const dispatchRequestId = randomUUID();
  attachDispatchRequestId(f.db, {
    channelId: channel.channelId,
    agentPrincipalId: agent.principalId,
    channelSeq,
    dispatchRequestId,
  });
  return {
    ...f,
    channelId: channel.channelId,
    agentPrincipalId: agent.principalId,
    channelSeq,
    dispatchRequestId,
    personaRevision: persona.revision,
    personaEnvelope: claim.personaEnvelope,
  };
}

describe('atomic agent turn fallback output', () => {
  it('commits and binds exactly one fallback, then replays the same event', async () => {
    const f = await preparedTurn();
    const input = {
      channelId: f.channelId,
      agentPrincipalId: f.agentPrincipalId,
      channelSeq: f.channelSeq,
      dispatchRequestId: f.dispatchRequestId,
      expectedProfile: {
        providerAccountId: 'ollama-local',
        adapterId: 'ollama-local',
        modelId: 'torq-ai-v5',
        personaRevision: f.personaRevision,
      },
      personaEnvelope: f.personaEnvelope,
      text: 'The answer.',
    };
    const first = await f.store.commitAgentTurnFallbackOutput(input);
    const replay = await f.store.commitAgentTurnFallbackOutput({ ...input, text: 'Different retry text' });
    expect(first).toMatchObject({ outputKind: 'fallback', replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM collab_events
      WHERE channel_id = ? AND actor_principal_id = ? AND kind = 'message_posted'`)
      .get(f.channelId, f.agentPrincipalId)).toEqual({ n: 1 });
    expect(f.sqlite.prepare(`SELECT state, output_event_id AS outputEventId, output_kind AS outputKind
      FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
      .get(f.channelId, f.agentPrincipalId, f.channelSeq))
      .toEqual({ state: 'completed', outputEventId: first.eventId, outputKind: 'fallback' });
  });

  it('rejects missing or malformed execution envelopes without changing turn or event state', async () => {
    for (const envelope of [undefined, { version: 1, content: 'Answer directly.', personaRevision: 1, contentSha256: '0'.repeat(64) }]) {
      const f = await preparedTurn();
      const input = {
        channelId: f.channelId,
        agentPrincipalId: f.agentPrincipalId,
        channelSeq: f.channelSeq,
        dispatchRequestId: f.dispatchRequestId,
        expectedProfile: {
          providerAccountId: 'ollama-local', adapterId: 'ollama-local',
          modelId: 'torq-ai-v5', personaRevision: f.personaRevision,
        },
        personaEnvelope: envelope,
        text: 'Must not post.',
      };
      await expect(f.store.commitAgentTurnFallbackOutput(input as any))
        .rejects.toMatchObject({ code: 'COLLAB_NOT_PERMITTED' });
      expect(f.sqlite.prepare(`SELECT state, output_event_id AS outputEventId
        FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
        .get(f.channelId, f.agentPrincipalId, f.channelSeq))
        .toEqual({ state: 'dispatched', outputEventId: null });
      expect(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM collab_events
        WHERE channel_id = ? AND actor_principal_id = ? AND kind = 'message_posted'`)
        .get(f.channelId, f.agentPrincipalId)).toEqual({ n: 0 });
    }
  });

  it('replays a bound output after live runtime mutation but refuses the same mutation on a fresh turn', async () => {
    const replay = await preparedTurn();
    const input = {
      channelId: replay.channelId,
      agentPrincipalId: replay.agentPrincipalId,
      channelSeq: replay.channelSeq,
      dispatchRequestId: replay.dispatchRequestId,
      expectedProfile: {
        providerAccountId: 'ollama-local', adapterId: 'ollama-local',
        modelId: 'torq-ai-v5', personaRevision: replay.personaRevision,
      },
      personaEnvelope: replay.personaEnvelope,
      text: 'Bound before mutation.',
    };
    const first = await replay.store.commitAgentTurnFallbackOutput(input);
    await replay.store.upsertAgentRuntimeProfile(replay.operator, {
      agentPrincipalId: replay.agentPrincipalId,
      providerAccountId: 'ollama-local', adapterId: 'ollama-local',
      modelId: 'mutated-model', autostart: true, externalContextConfirmed: false,
    }, 'runtime-after-bind');
    expect(await replay.store.commitAgentTurnFallbackOutput({ ...input, text: 'Retry.' }))
      .toEqual({ ...first, replayed: true });

    const fresh = await preparedTurn();
    await fresh.store.upsertAgentRuntimeProfile(fresh.operator, {
      agentPrincipalId: fresh.agentPrincipalId,
      providerAccountId: 'ollama-local', adapterId: 'ollama-local',
      modelId: 'mutated-model', autostart: true, externalContextConfirmed: false,
    }, 'runtime-before-first-write');
    await expect(fresh.store.commitAgentTurnFallbackOutput({
      ...input,
      channelId: fresh.channelId,
      agentPrincipalId: fresh.agentPrincipalId,
      channelSeq: fresh.channelSeq,
      dispatchRequestId: fresh.dispatchRequestId,
      personaEnvelope: fresh.personaEnvelope,
    })).rejects.toMatchObject({ code: 'COLLAB_NOT_PERMITTED' });
    expect(fresh.sqlite.prepare(`SELECT state, output_event_id AS outputEventId
      FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
      .get(fresh.channelId, fresh.agentPrincipalId, fresh.channelSeq))
      .toEqual({ state: 'dispatched', outputEventId: null });
  });

  it('binds a model tool post first and makes fallback replay it without duplication', async () => {
    const f = await preparedTurn();
    const input = {
      channelId: f.channelId,
      agentPrincipalId: f.agentPrincipalId,
      channelSeq: f.channelSeq,
      dispatchRequestId: f.dispatchRequestId,
      expectedProfile: {
        providerAccountId: 'ollama-local',
        adapterId: 'ollama-local',
        modelId: 'torq-ai-v5',
        personaRevision: f.personaRevision,
      },
      personaEnvelope: f.personaEnvelope,
      text: 'Tool-authored answer.',
    };
    const tool = await f.store.commitAgentTurnToolOutput(input);
    expect(getAgentTurnOutput(f.db, {
      channelId: f.channelId,
      agentPrincipalId: f.agentPrincipalId,
      channelSeq: f.channelSeq,
      dispatchRequestId: f.dispatchRequestId,
    })).toEqual({ eventId: tool.eventId, outputKind: 'tool' });
    const fallback = await f.store.commitAgentTurnFallbackOutput({ ...input, text: 'Fallback must not post.' });
    expect(tool).toMatchObject({ outputKind: 'tool', replayed: false });
    expect(fallback).toEqual({ ...tool, replayed: true });
    expect(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM collab_events
      WHERE channel_id = ? AND actor_principal_id = ? AND kind = 'message_posted'`)
      .get(f.channelId, f.agentPrincipalId)).toEqual({ n: 1 });
  });

  it('fails closed when STOP or the exact persona snapshot changes', async () => {
    const stopped = await preparedTurn();
    stopped.sqlite.prepare(`INSERT INTO collab_autoreply_stop(
      scope, channel_id, stopped_by_principal_id, stopped_at
    ) VALUES('channel', ?, ?, ?)`)
      .run(stopped.channelId, stopped.operator.principalId, '2026-08-21T12:01:00.000Z');
    const base = {
      channelId: stopped.channelId,
      agentPrincipalId: stopped.agentPrincipalId,
      channelSeq: stopped.channelSeq,
      dispatchRequestId: stopped.dispatchRequestId,
      expectedProfile: {
        providerAccountId: 'ollama-local',
        adapterId: 'ollama-local',
        modelId: 'torq-ai-v5',
        personaRevision: stopped.personaRevision,
      },
      personaEnvelope: stopped.personaEnvelope,
      text: 'Must not post',
    };
    await expect(stopped.store.commitAgentTurnFallbackOutput(base))
      .rejects.toMatchObject({ code: 'COLLAB_NOT_PERMITTED' });

    const changed = await preparedTurn();
    await changed.store.upsertAgentPersona(changed.operator, {
      agentPrincipalId: changed.agentPrincipalId,
      iconId: 'robot',
      systemDirectives: 'Changed directions.',
      expectedRevision: changed.personaRevision,
    }, 'persona-change', () => true);
    await expect(changed.store.commitAgentTurnFallbackOutput({
      ...base,
      channelId: changed.channelId,
      agentPrincipalId: changed.agentPrincipalId,
      channelSeq: changed.channelSeq,
      dispatchRequestId: changed.dispatchRequestId,
      personaEnvelope: changed.personaEnvelope,
    })).rejects.toMatchObject({ code: 'COLLAB_NOT_PERMITTED' });
  });

  it('leases stranded recovery with dispatched-at compare-and-swap', async () => {
    const f = await preparedTurn();
    f.sqlite.prepare(`UPDATE collab_agent_turns SET dispatched_at = ?
      WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
      .run('2026-08-21T10:00:00.000Z', f.channelId, f.agentPrincipalId, f.channelSeq);
    const [stranded] = findStrandedAgentTurns(f.db, '2026-08-21T12:00:00.000Z', 30);
    expect(stranded).toBeDefined();
    const lease = reclaimStrandedAgentTurn(f.db, {
      channelId: f.channelId,
      agentPrincipalId: f.agentPrincipalId,
      channelSeq: f.channelSeq,
      nowIso: '2026-08-21T12:00:00.000Z',
      expectedDispatchedAt: stranded!.dispatchedAt,
      leaseToken: 'lease-one',
    });
    expect(lease).toEqual({ leaseToken: 'lease-one', attempt: 1 });
    expect(reclaimStrandedAgentTurn(f.db, {
      channelId: f.channelId,
      agentPrincipalId: f.agentPrincipalId,
      channelSeq: f.channelSeq,
      nowIso: '2026-08-21T12:00:01.000Z',
      expectedDispatchedAt: stranded!.dispatchedAt,
      leaseToken: 'lease-two',
    })).toBeNull();
  });

  it('returns the immutable snapshot on duplicate claim and rejects envelope mutation', async () => {
    const f = await preparedTurn();
    const duplicate = await f.store.claimAgentTurn({
      channelId: f.channelId,
      agentPrincipalId: f.agentPrincipalId,
      channelSeq: f.channelSeq,
      triggerEventId: (f.sqlite.prepare(`SELECT trigger_event_id AS id FROM collab_agent_turns
        WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
        .get(f.channelId, f.agentPrincipalId, f.channelSeq) as { id: string }).id,
      nowIso: '2026-08-21T12:02:00.000Z',
    });
    expect(duplicate).toMatchObject({ status: 'duplicate', personaEnvelope: f.personaEnvelope });
    expect(() => f.sqlite.prepare(`UPDATE collab_agent_turns SET persona_content = 'changed'
      WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
      .run(f.channelId, f.agentPrincipalId, f.channelSeq)).toThrow(/immutable/);
    expect(() => f.sqlite.prepare(`UPDATE collab_agent_turns SET
      persona_envelope_version = NULL, persona_content = NULL,
      persona_revision = NULL, persona_content_sha256 = NULL
      WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
      .run(f.channelId, f.agentPrincipalId, f.channelSeq)).toThrow(/immutable/);
  });

  it('audibly classifies and terminates an unresolved legacy null-envelope row without backfill', async () => {
    const f = await preparedTurn();
    f.sqlite.prepare(`DELETE FROM collab_agent_turns
      WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
      .run(f.channelId, f.agentPrincipalId, f.channelSeq);
    expect(claimAgentTurn(f.db, {
      channelId: f.channelId,
      agentPrincipalId: f.agentPrincipalId,
      channelSeq: f.channelSeq,
      triggerEventId: 'legacy-trigger',
      nowIso: '2026-08-21T12:00:00.000Z',
    })).toBe(true);
    const result = await f.store.claimAgentTurn({
      channelId: f.channelId,
      agentPrincipalId: f.agentPrincipalId,
      channelSeq: f.channelSeq,
      triggerEventId: 'legacy-trigger',
      nowIso: '2026-08-21T12:03:00.000Z',
    });
    expect(result.status).toBe('legacy_terminated');
    expect(f.sqlite.prepare(`SELECT state, persona_envelope_version AS version
      FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
      .get(f.channelId, f.agentPrincipalId, f.channelSeq)).toEqual({ state: 'terminated', version: null });
    expect(() => f.sqlite.prepare(`UPDATE collab_agent_turns SET
      persona_envelope_version = 1, persona_content = '', persona_revision = 0,
      persona_content_sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
      .run(f.channelId, f.agentPrincipalId, f.channelSeq)).toThrow(/immutable/);
  });

  it('rejects partial persona-envelope inserts at the schema boundary', async () => {
    const f = await preparedTurn();
    expect(() => f.sqlite.prepare(`INSERT INTO collab_agent_turns(
      channel_id, agent_principal_id, channel_seq, trigger_event_id, state,
      dispatched_at, persona_envelope_version
    ) VALUES(?, ?, ?, ?, 'dispatched', ?, 1)`)
      .run(f.channelId, f.agentPrincipalId, f.channelSeq + 1, 'partial', '2026-08-21T12:04:00.000Z'))
      .toThrow(/malformed/);
  });
});
