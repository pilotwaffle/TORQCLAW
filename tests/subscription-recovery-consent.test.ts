import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  attachDispatchRequestId,
  bootstrapOperator,
  InMemorySecretStore,
  nodeRandomSource,
  runAgentAutoreplyMigration,
  runAgentRuntimeProfileMigration,
  runCollaborationMigration,
  type BootstrapDb,
  type CallerContext,
} from '@torqclaw/collab';
import { makeRequest } from './helpers.js';

process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-subscription-recovery-'));
process.env.TORQCLAW_AGENT_PARTICIPATION = '1';
process.env.TORQCLAW_AGENT_AUTOREPLY = '1';
process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED = '1';

const sqlite = new Database(':memory:');
runCollaborationMigration(sqlite);
runAgentAutoreplyMigration(sqlite);
runAgentRuntimeProfileMigration(sqlite);
const collabDb: BootstrapDb = {
  prepare: (sql: string) => sqlite.prepare(sql),
  exec: (sql: string) => sqlite.exec(sql),
  transaction: (fn) => sqlite.transaction(fn) as never,
};
const secrets = new InMemorySecretStore();
const bootstrap = bootstrapOperator(
  {
    db: collabDb,
    secretStore: secrets,
    clock: { next: () => new Date().toISOString() },
    uuids: { next: () => randomUUID() },
    rng: nodeRandomSource,
  },
  { operatorDisplayName: 'Recovery Operator', installationId: randomUUID(), schemaVersion: 1 },
);
const identity = await import('../packages/gateway/src/collabIdentity.js');
identity.setCollabDbForTest(collabDb);
identity.setCollabSecretStoreForTest(secrets);
const surface = await import('../packages/gateway/src/collabSurface.js');
const { db: stateDb } = await import('../packages/gateway/src/storage.js');
const { taskStore } = await import('../packages/gateway/src/events.js');
const {
  recoverStrandedAgentTurns,
  setAutoReplyDispatchForTest,
} = await import('../packages/gateway/src/autoReplyDispatcher.js');
const { resolveSubscriptionAcpServer } = await import(
  '../packages/gateway/src/subscriptionRuntimeCatalog.js'
);

afterAll(() => {
  setAutoReplyDispatchForTest(null);
  identity.setCollabDbForTest(null);
  identity.setCollabSecretStoreForTest(null);
  sqlite.close();
  delete process.env.TORQCLAW_AGENT_PARTICIPATION;
  delete process.env.TORQCLAW_AGENT_AUTOREPLY;
  delete process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED;
});

describe('subscription restart recovery consent binding', () => {
  it('commits unchanged completed output once and refuses every changed live binding without replay', async () => {
    const store = surface.getStore();
    expect(store).not.toBeNull();
    if (!store) throw new Error('store unavailable');
    const operator: CallerContext = {
      principalId: bootstrap.operatorPrincipalId,
      kind: 'operator',
    };
    const runtime = resolveSubscriptionAcpServer('kimi-subscription', 'kimi-code/k3');
    expect(runtime).not.toBeNull();
    if (!runtime) throw new Error('runtime unavailable');
    const adapterId = 'kimi-subscription:canonical';
    const dispatchReplay = vi.fn();
    setAutoReplyDispatchForTest(dispatchReplay);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const cases = ['unchanged', 'policy', 'fingerprint', 'model', 'personaRevision', 'personaHash'] as const;
    const prepared: Array<{
      kind: typeof cases[number];
      agentPrincipalId: string;
      channelId: string;
      channelSeq: number;
      requestId: string;
    }> = [];

    for (const kind of cases) {
      const channel = await store.createChannel(operator, { name: `Recovery ${kind}` }, `channel-${kind}`);
      expect(channel.externalExportPolicy).toBe('local_only');
      const agent = await store.createAgent(operator, { displayName: `Agent ${kind}` }, `agent-${kind}`);
      await store.addChannelMember(
        operator,
        { channelId: channel.channelId, principalId: agent.principalId },
        `member-${kind}`,
      );
      const policyKey = `policy-${kind}`;
      const policy = await store.setChannelExternalExportPolicy(operator, {
        channelId: channel.channelId,
        externalExportPolicy: 'operator_confirmed_non_sensitive',
      }, policyKey);
      expect(policy.externalExportPolicy).toBe('operator_confirmed_non_sensitive');
      if (kind === 'unchanged') {
        await expect(store.setChannelExternalExportPolicy(operator, {
          channelId: channel.channelId,
          externalExportPolicy: 'operator_confirmed_non_sensitive',
        }, policyKey)).resolves.toEqual(policy);
        await expect(store.setChannelExternalExportPolicy({
          principalId: agent.principalId,
          kind: 'agent',
        }, {
          channelId: channel.channelId,
          externalExportPolicy: 'local_only',
        }, 'agent-policy-denied')).rejects.toThrow();
      }
      await store.upsertAgentRuntimeProfile(operator, {
        agentPrincipalId: agent.principalId,
        providerAccountId: runtime.providerId,
        adapterId,
        modelId: runtime.exactModelId,
        autostart: true,
        externalContextConfirmed: true,
        externalContextRuntimeFingerprint: runtime.runtimeFingerprint,
        externalContextExactModelId: runtime.exactModelId,
        externalContextPersonaRevision: 0,
        externalContextPersonaContentSha256:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }, `profile-${kind}`);
      const trigger = await store.postChannelMessage(
        operator,
        { channelId: channel.channelId, text: `Question ${kind}` },
        `trigger-${kind}`,
      );
      const channelSeq = Number(trigger.cursor);
      const claim = await store.claimAgentTurn({
        channelId: channel.channelId,
        agentPrincipalId: agent.principalId,
        channelSeq,
        triggerEventId: trigger.eventId,
        nowIso: '2026-01-01T00:00:00.000Z',
      });
      expect(claim.status).toBe('claimed');
      if (claim.status !== 'claimed') throw new Error('turn claim failed');
      const requestId = randomUUID();
      attachDispatchRequestId(collabDb, {
        channelId: channel.channelId,
        agentPrincipalId: agent.principalId,
        channelSeq,
        dispatchRequestId: requestId,
      });
      const request = makeRequest({ taskType: 'SUMMARIZATION' });
      request.id = requestId;
      request.sessionId = randomUUID();
      request.payload.callerCollabPrincipalId = agent.principalId;
      request.payload.agentPersonaEnvelope = claim.personaEnvelope;
      request.payload.agentTurnContext = {
        channelId: channel.channelId,
        agentPrincipalId: agent.principalId,
        channelSeq,
        triggerEventId: trigger.eventId,
        personaRevision: claim.personaEnvelope.personaRevision,
      };
      request.payload.subscriptionExecutionTarget = {
        providerId: runtime.providerId,
        providerAccountId: runtime.providerId,
        adapterId,
        modelId: runtime.exactModelId,
        confirmed: true,
        runtimeFingerprint: runtime.runtimeFingerprint,
        exactModelId: runtime.exactModelId,
        personaRevision: claim.personaEnvelope.personaRevision,
        personaContentSha256: claim.personaEnvelope.contentSha256,
      };
      stateDb.prepare(
        `INSERT INTO sessions (id, role, client_name, principal_id, surface_id)
         VALUES (?, 'node', 'subscription-recovery-test', ?, NULL)`,
      ).run(request.sessionId, agent.principalId);
      taskStore.create(request, { tier: 'FRONTIER_CLOUD', reason: 'USER_PREFERENCE' } as never);
      taskStore.complete(requestId, `Recovered ${kind}`, {
        subscription: true,
        providerId: runtime.providerId,
        modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint,
        cancelled: false,
      });
      prepared.push({
        kind,
        agentPrincipalId: agent.principalId,
        channelId: channel.channelId,
        channelSeq,
        requestId,
      });
    }

    for (const item of prepared) {
      if (item.kind === 'policy') {
        sqlite.prepare(`UPDATE collab_channels SET external_export_policy = 'local_only' WHERE id = ?`)
          .run(item.channelId);
      } else if (item.kind === 'fingerprint') {
        sqlite.prepare(`UPDATE collab_agent_runtime_profiles
          SET external_context_runtime_fingerprint = ? WHERE agent_principal_id = ?`)
          .run('b'.repeat(64), item.agentPrincipalId);
      } else if (item.kind === 'model') {
        sqlite.prepare(`UPDATE collab_agent_runtime_profiles
          SET model_id = ?, external_context_model_id = ?, external_context_exact_model_id = ?
          WHERE agent_principal_id = ?`)
          .run('changed-model', 'changed-model', 'changed-model', item.agentPrincipalId);
      } else if (item.kind === 'personaRevision') {
        sqlite.prepare(`UPDATE collab_agent_runtime_profiles
          SET external_context_persona_revision = 1 WHERE agent_principal_id = ?`)
          .run(item.agentPrincipalId);
      } else if (item.kind === 'personaHash') {
        sqlite.prepare(`UPDATE collab_agent_runtime_profiles
          SET external_context_persona_content_sha256 = ? WHERE agent_principal_id = ?`)
          .run('c'.repeat(64), item.agentPrincipalId);
      }
    }

    await expect(recoverStrandedAgentTurns(0)).resolves.toBe(1);
    await expect(recoverStrandedAgentTurns(0)).resolves.toBe(0);
    expect(dispatchReplay).not.toHaveBeenCalled();
    expect((sqlite.prepare(`SELECT COUNT(*) AS count FROM collab_channel_export_policy_audit`)
      .get() as { count: number }).count).toBe(cases.length);

    for (const item of prepared) {
      const turn = sqlite.prepare(`SELECT state FROM collab_agent_turns
        WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
        .get(item.channelId, item.agentPrincipalId, item.channelSeq) as { state: string };
      const posts = sqlite.prepare(`SELECT COUNT(*) AS count FROM collab_events
        WHERE channel_id = ? AND actor_principal_id = ? AND kind = 'message_posted'`)
        .get(item.channelId, item.agentPrincipalId) as { count: number };
      expect(turn.state).toBe(item.kind === 'unchanged' ? 'completed' : 'terminated');
      expect(posts.count).toBe(item.kind === 'unchanged' ? 1 : 0);
      expect((stateDb.prepare('SELECT state FROM tasks WHERE request_id = ?').get(item.requestId) as {
        state: string;
      }).state).toBe('completed');
    }
  });
});
