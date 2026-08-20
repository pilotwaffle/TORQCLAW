import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../../packages/collab/src/store.js';
import { SubscriptionRegistry, type DeliveryFrame } from '../../packages/collab/src/subscriptions.js';

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
  const registry = new SubscriptionRegistry();

  const bootstrap = bootstrapOperator(
    { db, secretStore, clock, uuids, rng: nodeRandomSource },
    { operatorDisplayName: 'Operator', installationId: `install-${fixtureId}`, schemaVersion: 1 }
  );

  const store = new CollaborationStore({
    db,
    clock,
    uuids,
    rng: nodeRandomSource,
    principalPepper: bootstrap.principalPepper,
    registry,
  });

  const operatorCaller: CallerContext = { principalId: bootstrap.operatorPrincipalId, kind: 'operator' };
  return { store, operatorCaller, registry };
}

async function makeAgent(store: CollaborationStore, operatorCaller: CallerContext, name: string, idem: string) {
  const result = await store.createAgent(operatorCaller, { displayName: name }, idem);
  return {
    principalId: result.principalId,
    credentialId: result.credentialId,
    caller: { principalId: result.principalId, kind: 'agent' as const },
  };
}

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
  return `sub-close-${subIdCounter}-${'0'.repeat(8)}-0000-4000-8000-${String(subIdCounter).padStart(12, '0')}`;
}

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S5 — socket-close deregistration', () => {
  it('closeSubscriptionsForSession closes, terminally frames, and REMOVES every subscription owned by that connection; later commits fan out to nobody', async () => {
    const { store, operatorCaller, registry } = makeStore('s5-session-close');
    const channelA = await store.createChannel(operatorCaller, { name: 'S5CloseA' }, 'idem-ch-a');
    const channelB = await store.createChannel(operatorCaller, { name: 'S5CloseB' }, 'idem-ch-b');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-agent');
    await store.addChannelMember(operatorCaller, { channelId: channelA.channelId, principalId: agent.principalId }, 'idem-add-a');
    await store.addChannelMember(operatorCaller, { channelId: channelB.channelId, principalId: agent.principalId }, 'idem-add-b');

    const ownerSessionId = 'conn-owner-1';
    const { frames, sink } = makeRecordingSink();
    await store.subscribeChannel(
      agent.caller,
      { channelId: channelA.channelId, afterCursor: '0', sessionId: ownerSessionId, credentialId: agent.credentialId, sink },
      nextSubId(),
    );
    await store.subscribeChannel(
      agent.caller,
      { channelId: channelB.channelId, afterCursor: '0', sessionId: ownerSessionId, credentialId: agent.credentialId, sink },
      nextSubId(),
    );
    expect(registry.forSession(ownerSessionId)).toHaveLength(2);

    // Prove live fan-out reaches the sink BEFORE close (positive control).
    const beforeLive = frames.length;
    await store.postChannelMessage(operatorCaller, { channelId: channelA.channelId, text: 'live-before-close' }, 'idem-live-before');
    expect(frames.length).toBeGreaterThan(beforeLive);

    const closed = await store.closeSubscriptionsForSession(ownerSessionId, 'socket_closed');
    expect(closed).toBe(2);
    expect(registry.forSession(ownerSessionId)).toEqual([]);
    expect(registry.all()).toEqual([]);

    const closeFrames = frames.filter((f) => f.type === 'subscription_closed');
    expect(closeFrames).toHaveLength(2);
    expect(closeFrames.every((f) => f.reason === 'socket_closed')).toBe(true);

    // The departure-gap assertion: after socket close, a committed message must
    // not be delivered to the dead connection's sink at all.
    const afterClose = frames.length;
    await store.postChannelMessage(operatorCaller, { channelId: channelA.channelId, text: 'after-close-a' }, 'idem-after-a');
    await store.postChannelMessage(operatorCaller, { channelId: channelB.channelId, text: 'after-close-b' }, 'idem-after-b');
    expect(frames.length).toBe(afterClose);

    // Idempotent: a second close for the same owner is a no-op, not an error.
    await expect(store.closeSubscriptionsForSession(ownerSessionId, 'socket_closed')).resolves.toBe(0);
    expect(registry.forSession(ownerSessionId)).toEqual([]);
  });
});
