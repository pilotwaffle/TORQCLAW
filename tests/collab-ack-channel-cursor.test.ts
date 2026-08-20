/**
 * PRD-TCLAW-COLLAB-PRESENCE-UI-005 S6 — ACK_CHANNEL_CURSOR (gateway half).
 *
 * Covers the S6 obligations assigned to the gateway:
 *   T-1 — principal-less connection => COLLAB_IDENTITY_REQUIRED
 *   T-2 — byte-identical COLLAB_NOT_FOUND, hidden-channel vs nonexistent-channel
 *   T-3 — seat arms: operator allow, channel/node explicit deny, and NO
 *         agentCollabWrite widening for the node seat (read state is the 005
 *         operator surface's subject, never an agent's)
 *   A7 (in-process half) — an ack is durable in the store and monotonic:
 *         acking an older cursor never moves lastAcknowledgedCursor backwards
 *         (the live reconnect + gateway-restart half lives in
 *         tests/collab-ack-cursor-live.test.ts)
 *   CURSOR_OUT_OF_RANGE — structured COLLAB_INVALID_REQUEST refusal, no throw
 *   D-1  — malformed cursor rejected at the Zod wire boundary, and a store
 *         failure maps to generic COLLAB_UNAVAILABLE without leaking detail
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../packages/collab/src/store.js';
import { authorize, type AuthzContext } from '../packages/gateway/src/authz.js';
import { ClientCommandSchema, type ClientCommand } from '@torqclaw/contracts';

function makeFixture(fixtureId: string) {
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
    { operatorDisplayName: 'Operator', installationId: `install-${fixtureId}`, schemaVersion: 1 },
  );

  const store = new CollaborationStore({
    db, clock, uuids, rng, principalPepper: bootstrap.principalPepper,
  });

  const operatorCaller: CallerContext = { principalId: bootstrap.operatorPrincipalId, kind: 'operator' };
  return { sqlite, db, store, bootstrap, operatorCaller };
}

const SESS_ID = randomUUID();

async function makeAgent(store: CollaborationStore, operatorCaller: CallerContext, name: string, idem: string) {
  const result = await store.createAgent(operatorCaller, { displayName: name }, idem);
  return { principalId: result.principalId, caller: { principalId: result.principalId, kind: 'agent' as const } };
}

describe('S6 handler — handleAckChannelCursor (T-1, T-2, A7 in-process, CURSOR_OUT_OF_RANGE)', () => {
  let fixture: ReturnType<typeof makeFixture>;
  let setCollabSurfaceStoreForTest: (s: CollaborationStore | null) => void;
  let handleAckChannelCursor: (
    sid: string, principalId: string | null, channelId: string, cursor: string,
  ) => Promise<{ code: string; detail?: unknown } | null>;
  let publishedFrames: Array<{ sessionId: string; event: { message: string; metadata?: unknown } }>;

  beforeEach(async () => {
    fixture = makeFixture(`ack-${Math.random().toString(36).slice(2)}`);

    const mod = await import('../packages/gateway/src/collabSurface.js');
    setCollabSurfaceStoreForTest = mod.setCollabSurfaceStoreForTest;
    handleAckChannelCursor = mod.handleAckChannelCursor;
    setCollabSurfaceStoreForTest(fixture.store);

    // publishOnly writes through the real sessionBus; capture via subscribe
    // rather than mocking events.ts, so this exercises the real production path.
    publishedFrames = [];
    const { sessionBus } = await import('../packages/gateway/src/events.js');
    sessionBus.subscribe(SESS_ID, (event) => {
      publishedFrames.push({ sessionId: SESS_ID, event: { message: event.message, metadata: event.metadata } });
    });
  });

  afterEach(() => {
    setCollabSurfaceStoreForTest(null);
    fixture.sqlite.close();
  });

  // ---- T-1: principal-less connection => COLLAB_IDENTITY_REQUIRED ----
  it('T-1: ACK_CHANNEL_CURSOR on a connection with no resolved principal refuses COLLAB_IDENTITY_REQUIRED', async () => {
    const err = await handleAckChannelCursor(SESS_ID, null, 'any-channel-id', '0');
    expect(err).toEqual({ code: 'COLLAB_IDENTITY_REQUIRED' });
    // Deletion-probe: a real principal does NOT get the refusal (a bypass that
    // substituted a principal instead of refusing would return null here too,
    // so the two calls must be distinguishable).
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'T1 Channel' }, 'idem-t1-ch');
    const real = await handleAckChannelCursor(SESS_ID, operatorCaller.principalId, channel.channelId, '0');
    expect(real).toBeNull();
    expect(real).not.toEqual(err);
  });

  // ---- T-2: byte-identical COLLAB_NOT_FOUND, hidden vs nonexistent ----
  it('T-2: acking a hidden (non-member) channel is BYTE-IDENTICAL to acking a nonexistent channel', async () => {
    const { store, operatorCaller } = fixture;
    const outsider = await makeAgent(store, operatorCaller, 'Ack Outsider', 'idem-ack-outsider');
    const channel = await store.createChannel(operatorCaller, { name: 'Ack Hidden' }, 'idem-ack-hidden-ch');
    // outsider.caller is never added as a member -> channel is hidden to them.

    const hidden = await handleAckChannelCursor(SESS_ID, outsider.principalId, channel.channelId, '0');
    const nonexistent = await handleAckChannelCursor(SESS_ID, outsider.principalId, 'this-channel-id-does-not-exist', '0');

    expect(JSON.stringify(hidden)).toBe(JSON.stringify(nonexistent));
    expect(hidden?.code).toBe('COLLAB_NOT_FOUND');

    // Deletion-probe: prove the byte-equality assertion is not vacuously true.
    const injected = JSON.stringify({ code: 'COLLAB_NOT_FOUND', detail: 'Channel is hidden from you' });
    expect(injected).not.toBe(JSON.stringify(nonexistent));
  });

  // ---- Success + A7 (in-process half): durable, monotonic ----
  it('A7 (in-process): an acknowledged cursor is durable in the store and acking an older cursor never moves backwards', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'Ack Durable' }, 'idem-ack-durable-ch');
    // channel_created is @1. Post one more message (@2).
    await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: 'm1' }, 'idem-ack-m1');

    publishedFrames.length = 0;
    const ack2 = await handleAckChannelCursor(SESS_ID, operatorCaller.principalId, channel.channelId, '2');
    expect(ack2).toBeNull();
    expect(publishedFrames[0]!.event.metadata).toEqual({
      collabCursorAcked: true,
      channelId: channel.channelId,
      acknowledgedCursor: '2',
    });

    // Durable: LIST_CHANNELS (the S1 read surface) reports the acked cursor.
    const listed = await store.listChannels(operatorCaller, { afterChannelId: null, limit: 20, includeArchived: false });
    const row = listed.channels.find((c) => c.channelId === channel.channelId)!;
    expect(row.lastAcknowledgedCursor).toBe('2');

    // Monotonic (L2): acking an older cursor is a no-op, never a regression --
    // the returned acknowledgedCursor AND the stored row both stay at '2'.
    publishedFrames.length = 0;
    const ack0 = await handleAckChannelCursor(SESS_ID, operatorCaller.principalId, channel.channelId, '0');
    expect(ack0).toBeNull();
    expect(publishedFrames[0]!.event.metadata).toMatchObject({ acknowledgedCursor: '2' });
    const listedAfter = await store.listChannels(operatorCaller, { afterChannelId: null, limit: 20, includeArchived: false });
    expect(listedAfter.channels.find((c) => c.channelId === channel.channelId)!.lastAcknowledgedCursor).toBe('2');

    // Re-acking the same cursor is idempotent (naturally-idempotent path).
    const ack2Again = await handleAckChannelCursor(SESS_ID, operatorCaller.principalId, channel.channelId, '2');
    expect(ack2Again).toBeNull();
  });

  // ---- CURSOR_OUT_OF_RANGE: structured refusal, no throw ----
  it('CURSOR_OUT_OF_RANGE: acking beyond the caller-visible bound returns COLLAB_INVALID_REQUEST and does not throw', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'Ack OOR' }, 'idem-ack-oor-ch');
    // Only channel_created (@1) exists; cursor '5' exceeds the bound.

    await expect(
      handleAckChannelCursor(SESS_ID, operatorCaller.principalId, channel.channelId, '5'),
    ).resolves.toEqual({ code: 'COLLAB_INVALID_REQUEST', detail: expect.any(String) });

    // The failed ack must NOT have written any cursor row.
    const listed = await store.listChannels(operatorCaller, { afterChannelId: null, limit: 20, includeArchived: false });
    expect(listed.channels.find((c) => c.channelId === channel.channelId)!.lastAcknowledgedCursor).toBe('0');
  });

  // ---- Totality: unexpected store failure => generic COLLAB_UNAVAILABLE ----
  it('D-1: handleAckChannelCursor maps an unexpected store failure to COLLAB_UNAVAILABLE without throwing or leaking detail', async () => {
    const { operatorCaller } = fixture;
    const throwingStore = {
      ackChannelCursor: async () => {
        throw new Error('simulated store failure with internal detail');
      },
    } as unknown as CollaborationStore;
    setCollabSurfaceStoreForTest(throwingStore);

    await expect(
      handleAckChannelCursor(SESS_ID, operatorCaller.principalId, 'any-channel-id', '0'),
    ).resolves.toEqual({ code: 'COLLAB_UNAVAILABLE' });

    setCollabSurfaceStoreForTest(fixture.store);
  });
});

// ---------------------------------------------------------------------------
// T-3: authz seat arms for ACK_CHANNEL_CURSOR.
// ---------------------------------------------------------------------------
describe('authorize() — ACK_CHANNEL_CURSOR seat arms (T-3)', () => {
  const ctx: AuthzContext = { sessionId: SESS_ID, lookupTaskSession: () => null };
  const ack: ClientCommand = { action: 'ACK_CHANNEL_CURSOR', channelId: 'c1', cursor: '0' };

  it('operator seat: allow', () => {
    expect(authorize('operator', ack, ctx)).toEqual({ ok: true });
  });

  it('channel seat: explicit deny', () => {
    const d = authorize('channel', ack, ctx);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBeTruthy();
  });

  it('node seat: deny, and agentCollabWrite does NOT widen to ACK_CHANNEL_CURSOR', () => {
    expect(authorize('node', ack, ctx).ok).toBe(false);
    // The 007 S1 widening is scoped to POST_CHANNEL_MESSAGE only; read state
    // is the 005 operator surface's subject. With agentCollabWrite true the
    // node seat must STILL deny this command.
    expect(authorize('node', ack, { ...ctx, agentCollabWrite: true }).ok).toBe(false);
    // Deletion-probe: the same ctx genuinely allows POST_CHANNEL_MESSAGE, so
    // the deny above is a real per-command distinction, not a dead flag.
    const post: ClientCommand = { action: 'POST_CHANNEL_MESSAGE', channelId: 'c1', text: 'hi', idempotencyKey: 'k1' };
    expect(authorize('node', post, { ...ctx, agentCollabWrite: true }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wire boundary: the contract rejects a malformed cursor before dispatch.
// ---------------------------------------------------------------------------
describe('ClientCommandSchema — ACK_CHANNEL_CURSOR cursor grammar', () => {
  const base = { action: 'ACK_CHANNEL_CURSOR' as const, channelId: 'c1' };

  it.each(['abc', '007', '-1', '1.5', ''])('rejects malformed cursor %j at the wire boundary', (badCursor) => {
    const result = ClientCommandSchema.safeParse({ ...base, cursor: badCursor });
    expect(result.success).toBe(false);
  });

  it.each(['0', '42'])('still parses well-formed cursor %j', (goodCursor) => {
    const result = ClientCommandSchema.safeParse({ ...base, cursor: goodCursor });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ action: 'ACK_CHANNEL_CURSOR', cursor: goodCursor });
  });
});
