import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InMemorySecretStore,
  runAgentAutoreplyMigration,
  runAgentRuntimeProfileMigration,
  runCollaborationMigration,
} from '../packages/collab/src/index.js';
import { ensureGatewayBuild, GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';

type ManagedContext = {
  channelId: string;
  agentPrincipalId: string;
  channelSeq: number;
  triggerEventId: string;
  personaRevision: number;
  dispatchRequestId: string;
  expectedProfile: {
    providerAccountId: 'ollama-local';
    adapterId: 'ollama-local';
    modelId: string;
    personaRevision: number;
  };
  personaEnvelope: {
    version: 1;
    content: string;
    personaRevision: number;
    contentSha256: string;
  };
};

const previousEnv: Record<string, string | undefined> = {};
let dataDir: string;
let sqlite: InstanceType<typeof Database>;
let operatorId: string;
let bridge: typeof import('../packages/bridge/dist/index.js');
let store: any;

function setEnv(key: string, value: string): void {
  previousEnv[key] = process.env[key];
  process.env[key] = value;
}

function agentMessageCount(channelId: string, agentPrincipalId: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM collab_events
    WHERE channel_id = ? AND actor_principal_id = ? AND kind = 'message_posted'`)
    .get(channelId, agentPrincipalId) as { n: number }).n;
}

function turnState(context: ManagedContext): { state: string; outputEventId: string | null } {
  return sqlite.prepare(`SELECT state, output_event_id AS outputEventId
    FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?`)
    .get(context.channelId, context.agentPrincipalId, context.channelSeq) as {
      state: string; outputEventId: string | null;
    };
}

async function preparedManagedTurn(): Promise<ManagedContext> {
  const operator = { principalId: operatorId, kind: 'operator' as const };
  const channel = await store.createChannel(operator, { name: `Managed ${randomUUID()}` }, randomUUID());
  const agent = await store.createAgent(operator, { displayName: 'Managed Agent' }, randomUUID());
  await store.addChannelMember(operator, {
    channelId: channel.channelId,
    principalId: agent.principalId,
  }, randomUUID());
  await store.upsertAgentRuntimeProfile(operator, {
    agentPrincipalId: agent.principalId,
    providerAccountId: 'ollama-local',
    adapterId: 'ollama-local',
    modelId: 'torq-ai-v5',
    autostart: true,
    externalContextConfirmed: false,
  }, randomUUID());
  const persona = await store.upsertAgentPersona(operator, {
    agentPrincipalId: agent.principalId,
    iconId: 'robot',
    systemDirectives: 'Answer directly.',
    expectedRevision: 0,
  }, randomUUID(), () => true);
  const trigger = await store.postChannelMessage(operator, {
    channelId: channel.channelId,
    text: 'Question',
  }, randomUUID());
  const claim = await store.claimAgentTurn({
    channelId: channel.channelId,
    agentPrincipalId: agent.principalId,
    channelSeq: Number(trigger.cursor),
    triggerEventId: trigger.eventId,
    nowIso: new Date().toISOString(),
  });
  if (claim.status !== 'claimed') throw new Error('managed turn claim failed');
  const dispatchRequestId = randomUUID();
  sqlite.prepare(`UPDATE collab_agent_turns SET dispatch_request_id = ?
    WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ? AND state = 'dispatched'`)
    .run(dispatchRequestId, channel.channelId, agent.principalId, Number(trigger.cursor));
  return {
    channelId: channel.channelId,
    agentPrincipalId: agent.principalId,
    channelSeq: Number(trigger.cursor),
    triggerEventId: trigger.eventId,
    personaRevision: persona.revision,
    dispatchRequestId,
    expectedProfile: {
      providerAccountId: 'ollama-local', adapterId: 'ollama-local',
      modelId: 'torq-ai-v5', personaRevision: persona.revision,
    },
    personaEnvelope: claim.personaEnvelope,
  };
}

beforeAll(async () => {
  await ensureGatewayBuild();
  dataDir = mkdtempSync(join(tmpdir(), 'torq-managed-envelope-'));
  const dbPath = join(dataDir, 'collab.db');
  sqlite = new Database(dbPath);
  runCollaborationMigration(sqlite);
  runAgentAutoreplyMigration(sqlite);
  runAgentRuntimeProfileMigration(sqlite);
  operatorId = randomUUID();
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO principals(
    id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at
  ) VALUES(?, 'operator', 'Operator', NULL, 'active', 1, NULL, ?, ?)`).run(operatorId, now, now);

  const pepper = Buffer.alloc(32, 0x4d);
  setEnv('TORQCLAW_DATA_DIR', dataDir);
  setEnv('TORQCLAW_COLLAB_DB_PATH', dbPath);
  setEnv('TORQCLAW_COLLAB_ENABLED', '1');
  setEnv('TORQCLAW_AGENT_PARTICIPATION', '1');

  const gatewayDist = join(GATEWAY_DIST_ENTRY, '..');
  bridge = await import(pathToFileURL(join('packages', 'bridge', 'dist', 'index.js')).href) as any;
  const collabSurface = await import(pathToFileURL(join(gatewayDist, 'collabSurface.js')).href) as any;
  const collabAgentTools = await import(pathToFileURL(join(gatewayDist, 'collabAgentTools.js')).href) as any;
  const collabIdentity = await import(pathToFileURL(join(gatewayDist, 'collabIdentity.js')).href) as any;
  const secretStore = new InMemorySecretStore();
  secretStore.set('TORQCLAW/principal-pepper', pepper);
  collabIdentity.setCollabSecretStoreForTest(secretStore);
  store = collabSurface.getStore();
  if (!store) throw new Error('collab store unavailable');
  await bridge.connectInProcessServer(
    collabAgentTools.COLLAB_AGENT_SERVER_ID,
    collabAgentTools.buildCollabAgentMcpServer(),
    { capabilities: collabAgentTools.COLLAB_AGENT_TOOL_CAPABILITIES },
  );
}, 200_000);

afterAll(() => {
  sqlite?.close();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('managed in-process tool persona envelope', () => {
  it.each([
    ['missing envelope', (value: ManagedContext) => { delete (value as Partial<ManagedContext>).personaEnvelope; }],
    ['wrong version', (value: ManagedContext) => { (value.personaEnvelope as { version: number }).version = 2; }],
    ['wrong hash', (value: ManagedContext) => { value.personaEnvelope.contentSha256 = '0'.repeat(64); }],
    ['wrong envelope revision', (value: ManagedContext) => { value.personaEnvelope.personaRevision += 1; }],
    ['wrong profile revision', (value: ManagedContext) => { value.expectedProfile.personaRevision += 1; }],
    ['wrong principal', (value: ManagedContext) => { value.agentPrincipalId = randomUUID(); }],
    ['wrong channel', (value: ManagedContext) => { value.channelId = randomUUID(); }],
    ['blank trigger id', (value: ManagedContext) => { value.triggerEventId = ''; }],
  ])('refuses %s on a fresh dispatched turn without downgrade or writes', async (_name, tamper) => {
    const claimed = await preparedManagedTurn();
    const metadata = structuredClone(claimed);
    tamper(metadata);
    await expect(bridge.executeTool(
      'collab__post_message',
      { channelId: claimed.channelId, text: 'Must not downgrade.' },
      undefined,
      claimed.agentPrincipalId,
      metadata as any,
    )).rejects.toThrow('COLLAB_AGENT_TURN_CONTEXT_INVALID');
    expect(agentMessageCount(claimed.channelId, claimed.agentPrincipalId)).toBe(0);
    expect(turnState(claimed)).toEqual({ state: 'dispatched', outputEventId: null });
  });

  it('preserves absent metadata as unmanaged and commits valid managed metadata once', async () => {
    const unmanaged = await preparedManagedTurn();
    await bridge.executeTool(
      'collab__post_message',
      { channelId: unmanaged.channelId, text: 'Unmanaged post.' },
      undefined,
      unmanaged.agentPrincipalId,
    );
    expect(agentMessageCount(unmanaged.channelId, unmanaged.agentPrincipalId)).toBe(1);
    expect(turnState(unmanaged)).toEqual({ state: 'dispatched', outputEventId: null });

    const managed = await preparedManagedTurn();
    await bridge.executeTool(
      'collab__post_message',
      { channelId: managed.channelId, text: 'Managed post.' },
      undefined,
      managed.agentPrincipalId,
      managed,
    );
    expect(agentMessageCount(managed.channelId, managed.agentPrincipalId)).toBe(1);
    expect(turnState(managed)).toMatchObject({ state: 'completed' });
  });

  it('replays after a live runtime mutation but refuses that mutation before a fresh write', async () => {
    const operator = { principalId: operatorId, kind: 'operator' as const };
    const replay = await preparedManagedTurn();
    const first = await bridge.executeTool(
      'collab__post_message',
      { channelId: replay.channelId, text: 'Bound output.' },
      undefined,
      replay.agentPrincipalId,
      replay,
    );
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: replay.agentPrincipalId,
      providerAccountId: 'ollama-local', adapterId: 'ollama-local',
      modelId: 'changed-after-bind', autostart: true, externalContextConfirmed: false,
    }, randomUUID());
    const replayed = await bridge.executeTool(
      'collab__post_message',
      { channelId: replay.channelId, text: 'Retry text.' },
      undefined,
      replay.agentPrincipalId,
      replay,
    ) as Array<{ text: string }>;
    const firstResult = JSON.parse((first as Array<{ text: string }>)[0]!.text);
    const replayResult = JSON.parse(replayed[0]!.text);
    expect(replayResult).toEqual({ ...firstResult, replayed: true });
    expect(agentMessageCount(replay.channelId, replay.agentPrincipalId)).toBe(1);

    const fresh = await preparedManagedTurn();
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: fresh.agentPrincipalId,
      providerAccountId: 'ollama-local', adapterId: 'ollama-local',
      modelId: 'changed-before-write', autostart: true, externalContextConfirmed: false,
    }, randomUUID());
    await expect(bridge.executeTool(
      'collab__post_message',
      { channelId: fresh.channelId, text: 'Must be refused.' },
      undefined,
      fresh.agentPrincipalId,
      fresh,
    )).rejects.toThrow('COLLAB_UNAVAILABLE');
    expect(agentMessageCount(fresh.channelId, fresh.agentPrincipalId)).toBe(0);
    expect(turnState(fresh)).toEqual({ state: 'dispatched', outputEventId: null });
  });
});
