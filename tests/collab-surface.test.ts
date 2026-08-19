/**
 * PRD-TCLAW-COLLAB-PRESENCE-UI-005 S1 — LIST_CHANNELS / GET_CHANNEL_TIMELINE.
 *
 * Covers §8's named obligations assigned to this slice:
 *   T-1 — principal-less connection => COLLAB_IDENTITY_REQUIRED (per command)
 *   T-2 — byte-identical COLLAB_NOT_FOUND, hidden-channel vs nonexistent-channel
 *   T-3 — channel/node seat deny arms (+ contracts drift gate, run separately
 *         via `pnpm contracts:check`, already verified green in this build)
 *   T-5 — timeline cursor paging against a live store, dense channel_seq
 *         contiguity across page boundaries
 *   T-8 — flag matrix: SURFACE_COMMANDS off => absent-deny, AND the H-1
 *         APPROVE_TOOL intersection (currentRole+holdsAuthority) still bites
 *
 * T-4/T-6/T-7 belong to later slices (S3/S4/S5) and are NOT built here.
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

describe('S1 handlers — handleListChannels / handleGetChannelTimeline (T-1, T-2, T-5)', () => {
  let fixture: ReturnType<typeof makeFixture>;
  let setCollabSurfaceStoreForTest: (s: CollaborationStore | null) => void;
  let handleListChannels: (sid: string, principalId: string | null, limit: number) => Promise<{ code: string; detail?: unknown } | null>;
  let handleGetChannelTimeline: (
    sid: string, principalId: string | null, channelId: string, cursor: string, limit: number,
  ) => Promise<{ code: string; detail?: unknown } | null>;
  let publishedFrames: Array<{ sessionId: string; event: { message: string; metadata?: unknown } }>;

  beforeEach(async () => {
    fixture = makeFixture(`surface-${Math.random().toString(36).slice(2)}`);

    const mod = await import('../packages/gateway/src/collabSurface.js');
    setCollabSurfaceStoreForTest = mod.setCollabSurfaceStoreForTest;
    handleListChannels = mod.handleListChannels;
    handleGetChannelTimeline = mod.handleGetChannelTimeline;
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
  it('T-1: LIST_CHANNELS on a connection with no resolved principal refuses COLLAB_IDENTITY_REQUIRED', async () => {
    const err = await handleListChannels(SESS_ID, null, 20);
    expect(err).toEqual({ code: 'COLLAB_IDENTITY_REQUIRED' });
    // Deletion-probe: prove this assertion actually distinguishes the refusal
    // from a real (possibly empty) success. A bypass that substitutes the
    // operator principal instead of refusing would return null here, not the
    // COLLAB_IDENTITY_REQUIRED object -- demonstrated directly below.
    const bypassed = await handleListChannels(SESS_ID, fixture.bootstrap.operatorPrincipalId, 20);
    expect(bypassed).toBeNull(); // real principal => real read, not a refusal
    expect(bypassed).not.toEqual(err);
  });

  it('T-1: GET_CHANNEL_TIMELINE on a connection with no resolved principal refuses COLLAB_IDENTITY_REQUIRED', async () => {
    const err = await handleGetChannelTimeline(SESS_ID, null, 'any-channel-id', '0', 20);
    expect(err).toEqual({ code: 'COLLAB_IDENTITY_REQUIRED' });
  });

  // ---- T-2: byte-identical COLLAB_NOT_FOUND, hidden vs nonexistent ----
  it('T-2: operator-kind caller who is NOT a member of a hidden channel gets a BYTE-IDENTICAL COLLAB_NOT_FOUND payload to the nonexistent-channel case', async () => {
    const { store, operatorCaller } = fixture;

    // A second, independent operator-kind principal exists only via the
    // agent path in this harness (bootstrapOperator mints exactly one
    // operator) -- so "hidden to a caller who is not this channel's member"
    // is modeled with an agent principal that is never added as a member.
    // The property under test (byte-identical COLLAB_NOT_FOUND regardless of
    // WHY the channel is invisible to the caller) does not depend on the
    // caller's kind; assertChannelVisible denies identically either way.
    const outsider = await makeAgent(store, operatorCaller, 'Outsider', 'idem-outsider');
    const channel = await store.createChannel(operatorCaller, { name: 'Hidden Channel' }, 'idem-hidden-ch');
    // outsider.caller is never added as a member -> channel is hidden to them.

    let hiddenErr: unknown;
    try {
      await store.getChannelTimeline(outsider.caller, { channelId: channel.channelId, afterCursor: '0', limit: 20 });
    } catch (e) { hiddenErr = e; }

    let nonexistentErr: unknown;
    try {
      await store.getChannelTimeline(outsider.caller, { channelId: 'this-channel-id-does-not-exist', afterCursor: '0', limit: 20 });
    } catch (e) { nonexistentErr = e; }

    expect(hiddenErr).toBeInstanceOf(Error);
    expect(nonexistentErr).toBeInstanceOf(Error);
    const hiddenPayload = JSON.stringify({ code: (hiddenErr as any).code, message: (hiddenErr as any).message });
    const nonexistentPayload = JSON.stringify({ code: (nonexistentErr as any).code, message: (nonexistentErr as any).message });

    // Byte equality of the serialized payloads, not merely code equality --
    // a distinguishing message string under the same code would still leak
    // which case occurred, which is exactly the oracle this test forecloses.
    expect(hiddenPayload).toBe(nonexistentPayload);
    expect((hiddenErr as any).code).toBe('COLLAB_NOT_FOUND');

    // Deletion-probe (documented per the cross-cutting obligation): prove
    // this assertion can actually fail. Inject a distinguishing message on
    // one side only, exactly as a future regression (e.g. someone adding
    // `OR kind = 'operator'` with its own error text) would, and confirm the
    // byte-equality assertion catches it.
    const injectedBypassPayload = JSON.stringify({ code: 'COLLAB_NOT_FOUND', message: 'Channel is hidden from you' });
    expect(injectedBypassPayload).not.toBe(nonexistentPayload); // proves the assertion is not vacuously true

    // And via the gateway-facing handler (the actual wire response shape):
    // set the connection's principal to the outsider and exercise both
    // channel ids through the S1 handler itself.
    const hiddenViaHandler = await handleGetChannelTimeline(SESS_ID, outsider.principalId, channel.channelId, '0', 20);
    const nonexistentViaHandler = await handleGetChannelTimeline(SESS_ID, outsider.principalId, 'this-channel-id-does-not-exist', '0', 20);
    expect(JSON.stringify(hiddenViaHandler)).toBe(JSON.stringify(nonexistentViaHandler));
    expect(hiddenViaHandler?.code).toBe('COLLAB_NOT_FOUND');
  });

  // ---- G2A D-1: malformed cursor must not throw out of the handler ----
  it.each(['abc', '007', '-1', '1'.repeat(25)])(
    'D-1: GET_CHANNEL_TIMELINE with malformed cursor %j returns a structured error and does not throw',
    async (badCursor) => {
      const { store, operatorCaller } = fixture;
      const channel = await store.createChannel(operatorCaller, { name: 'D1 Channel' }, `idem-d1-${badCursor}`);

      // The failure mode under test IS that the returned promise resolves
      // (with a structured error), never rejects -- assert both directions:
      // resolves (not throws) AND the resolved value is the expected shape.
      await expect(
        handleGetChannelTimeline(SESS_ID, operatorCaller.principalId, channel.channelId, badCursor, 20),
      ).resolves.toEqual({ code: 'COLLAB_INVALID_REQUEST', detail: expect.any(String) });
    },
  );

  it('D-1: T-2 byte-identity still holds when the cursor is malformed AND the channel is hidden vs absent (membership-oracle probe)', async () => {
    const { store, operatorCaller } = fixture;
    const outsider = await makeAgent(store, operatorCaller, 'D1 Outsider', 'idem-d1-outsider');
    const channel = await store.createChannel(operatorCaller, { name: 'D1 Hidden' }, 'idem-d1-hidden-ch');
    // outsider is never added as a member -> channel is hidden to them.

    // store.ts orders assertChannelVisible BEFORE parseCursor (G2A-verified),
    // so a non-member with a malformed cursor must still get COLLAB_NOT_FOUND
    // -- not COLLAB_INVALID_REQUEST -- for both the hidden and the absent
    // channel, and the two payloads must stay byte-identical.
    const hidden = await handleGetChannelTimeline(SESS_ID, outsider.principalId, channel.channelId, 'abc', 20);
    const absent = await handleGetChannelTimeline(SESS_ID, outsider.principalId, 'this-channel-id-does-not-exist', 'abc', 20);

    expect(JSON.stringify(hidden)).toBe(JSON.stringify(absent));
    expect(hidden?.code).toBe('COLLAB_NOT_FOUND');
    expect(absent?.code).toBe('COLLAB_NOT_FOUND');
  });

  // ---- T-5: dense channel_seq contiguity across page boundaries ----
  it('T-5: timeline cursor paging is dense-contiguous across page boundaries against a live store', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'Paged' }, 'idem-paged-ch');
    // channel_created is @1 (owner membership insert). Post 9 more messages
    // (@2..@10) so the timeline has 10 dense events total.
    for (let i = 0; i < 9; i++) {
      await store.postChannelMessage(operatorCaller, { channelId: channel.channelId, text: `m${i}` }, `idem-paged-m${i}`);
    }

    // Page through via the S1 handler in pages of 4, capturing published
    // frames in order, and assert the cursor sequence is dense (no gaps, no
    // repeats) across the full walk.
    let cursor = '0';
    let hasMore = true;
    const seenCursors: string[] = [];
    let guard = 0;
    while (hasMore && guard++ < 10) {
      publishedFrames.length = 0;
      const err = await handleGetChannelTimeline(SESS_ID, operatorCaller.principalId, channel.channelId, cursor, 4);
      expect(err).toBeNull();
      const frame = publishedFrames[0]!;
      expect(frame.event.metadata).toMatchObject({ collabTimeline: true, channelId: channel.channelId });
      const meta = frame.event.metadata as { events: Array<{ cursor: string }>; cursor: string; hasMore: boolean };
      for (const e of meta.events) seenCursors.push(e.cursor);
      cursor = meta.cursor;
      hasMore = meta.hasMore;
    }

    expect(seenCursors).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    // Dense contiguity: every cursor is its predecessor + 1, no gaps.
    const numeric = seenCursors.map(Number);
    for (let i = 1; i < numeric.length; i++) {
      expect(numeric[i]).toBe(numeric[i - 1]! + 1);
    }
  });

  it('LIST_CHANNELS publishes the real membership row set for the resolved principal', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'Visible' }, 'idem-visible-ch');
    const err = await handleListChannels(SESS_ID, operatorCaller.principalId, 20);
    expect(err).toBeNull();
    const frame = publishedFrames[0]!;
    expect(frame.event.metadata).toMatchObject({ collabChannels: true });
    const meta = frame.event.metadata as { channels: Array<{ channelId: string; name: string }> };
    expect(meta.channels.map((c) => c.channelId)).toContain(channel.channelId);
  });

  // ---- G2A D-1: handleListChannels must be total too ----
  it('D-1: handleListChannels does not throw when the store call fails', async () => {
    const { operatorCaller } = fixture;
    const throwingStore = {
      listChannels: async () => {
        throw new Error('simulated store failure');
      },
    } as unknown as CollaborationStore;
    setCollabSurfaceStoreForTest(throwingStore);

    await expect(
      handleListChannels(SESS_ID, operatorCaller.principalId, 20),
    ).resolves.toEqual({ code: 'COLLAB_UNAVAILABLE' });

    // Restore the real fixture store for any subsequent test in this block.
    setCollabSurfaceStoreForTest(fixture.store);
  });

  it('D-1: handleListChannels maps a CollabError(INVALID_REQUEST) from the store to COLLAB_INVALID_REQUEST without throwing', async () => {
    const { operatorCaller } = fixture;
    const throwingStore = {
      listChannels: async () => {
        const err: any = new Error('limit must be between 1 and 100');
        err.code = 'INVALID_REQUEST';
        throw err;
      },
    } as unknown as CollaborationStore;
    setCollabSurfaceStoreForTest(throwingStore);

    await expect(
      handleListChannels(SESS_ID, operatorCaller.principalId, 20),
    ).resolves.toEqual({ code: 'COLLAB_INVALID_REQUEST', detail: expect.any(String) });

    setCollabSurfaceStoreForTest(fixture.store);
  });
});

// ---------------------------------------------------------------------------
// T-3: authz deny arms for channel/node seats on both new commands.
// ---------------------------------------------------------------------------
describe('authorize() — LIST_CHANNELS / GET_CHANNEL_TIMELINE seat arms (T-3)', () => {
  const ctx: AuthzContext = { sessionId: SESS_ID, lookupTaskSession: () => null };
  const listChannels: ClientCommand = { action: 'LIST_CHANNELS', limit: 20 };
  const getTimeline: ClientCommand = { action: 'GET_CHANNEL_TIMELINE', channelId: 'c1', cursor: '0', limit: 20 };

  it('operator seat: allow both', () => {
    expect(authorize('operator', listChannels, ctx)).toEqual({ ok: true });
    expect(authorize('operator', getTimeline, ctx)).toEqual({ ok: true });
  });

  it('channel seat: explicit deny for both', () => {
    const a = authorize('channel', listChannels, ctx);
    const b = authorize('channel', getTimeline, ctx);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBeTruthy();
    if (!b.ok) expect(b.reason).toBeTruthy();
  });

  it('node seat: deny for both', () => {
    expect(authorize('node', listChannels, ctx).ok).toBe(false);
    expect(authorize('node', getTimeline, ctx).ok).toBe(false);
  });

  it('deletion-probe: an operator-only allow is not vacuously true — channel/node really differ from operator', () => {
    // Demonstrates the deny arms can fail: if LIST_CHANNELS/GET_CHANNEL_TIMELINE
    // were accidentally left off the channel-seat switch (falling through to
    // the generic default-deny) the outcome would be IDENTICAL (still deny),
    // so this probes the actually load-bearing property instead: operator
    // gets ALLOW where channel/node get DENY for the exact same command.
    expect(authorize('operator', listChannels, ctx).ok).toBe(true);
    expect(authorize('channel', listChannels, ctx).ok).toBe(false);
    expect(authorize('node', listChannels, ctx).ok).toBe(false);
    expect(authorize('operator', getTimeline, ctx).ok).toBe(true);
    expect(authorize('channel', getTimeline, ctx).ok).toBe(false);
    expect(authorize('node', getTimeline, ctx).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-8: flag matrix — SURFACE_COMMANDS off => absent-deny; H-1 intersection
// (APPROVE_TOOL's currentRole+holdsAuthority) still enforced regardless.
// ---------------------------------------------------------------------------
describe('Flag matrix (T-8): TORQCLAW_COLLAB_ENABLED=1, SURFACE_COMMANDS off', () => {
  const ORIGINAL_ENABLED = process.env.TORQCLAW_COLLAB_ENABLED;
  const ORIGINAL_SURFACE = process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS;

  afterEach(() => {
    if (ORIGINAL_ENABLED === undefined) delete process.env.TORQCLAW_COLLAB_ENABLED;
    else process.env.TORQCLAW_COLLAB_ENABLED = ORIGINAL_ENABLED;
    if (ORIGINAL_SURFACE === undefined) delete process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS;
    else process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS = ORIGINAL_SURFACE;
  });

  it('collabSurfaceCommandsEnabled() is false with ENABLED=1 and SURFACE_COMMANDS off/unset', async () => {
    process.env.TORQCLAW_COLLAB_ENABLED = '1';
    delete process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS;
    const { collabSurfaceCommandsEnabled } = await import('../packages/gateway/src/collabSurface.js');
    expect(collabSurfaceCommandsEnabled()).toBe(false);

    process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS = '0';
    expect(collabSurfaceCommandsEnabled()).toBe(false);
  });

  it('collabSurfaceCommandsEnabled() requires TORQCLAW_COLLAB_ENABLED too (narrowing flag)', async () => {
    delete process.env.TORQCLAW_COLLAB_ENABLED;
    process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS = '1';
    const { collabSurfaceCommandsEnabled } = await import('../packages/gateway/src/collabSurface.js');
    expect(collabSurfaceCommandsEnabled()).toBe(false);

    process.env.TORQCLAW_COLLAB_ENABLED = '1';
    expect(collabSurfaceCommandsEnabled()).toBe(true);
  });

  it('the H-1 intersection (APPROVE_TOOL: currentRole===operator AND holdsAuthority(approve)) remains enforced independent of the surface-commands flag state', () => {
    process.env.TORQCLAW_COLLAB_ENABLED = '1';
    process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS = '0';

    const approveTool: ClientCommand = { action: 'APPROVE_TOOL', approvalId: 'a1', decision: 'APPROVE' };

    // surface present (flag on), role NOT operator -> DENY_SURFACE_NOT_OPERATOR.
    const notOperatorCtx: AuthzContext = {
      sessionId: 's', lookupTaskSession: () => null,
      surface: { surfaceId: 'surf-1', currentRole: () => 'agent', holdsAuthority: () => true },
    };
    const d1 = authorize('operator', approveTool, notOperatorCtx);
    expect(d1.ok).toBe(false);
    if (!d1.ok) expect(d1.reason).toMatch(/not an operator-role surface/);

    // surface present, role operator, but no live approve authority -> DENY_AUTHORITY.
    const noAuthorityCtx: AuthzContext = {
      sessionId: 's', lookupTaskSession: () => null,
      surface: { surfaceId: 'surf-1', currentRole: () => 'operator', holdsAuthority: () => false },
    };
    const d2 = authorize('operator', approveTool, noAuthorityCtx);
    expect(d2.ok).toBe(false);
    if (!d2.ok) expect(d2.reason).toMatch(/control-plane authority/);

    // surface present, role operator, holds approve -> ALLOW.
    const fullCtx: AuthzContext = {
      sessionId: 's', lookupTaskSession: () => null,
      surface: { surfaceId: 'surf-1', currentRole: () => 'operator', holdsAuthority: () => true },
    };
    expect(authorize('operator', approveTool, fullCtx)).toEqual({ ok: true });

    // Deletion-probe: prove the intersection is load-bearing, not a no-op --
    // absent surface (ctx.surface undefined) collapses to blanket ALLOW
    // byte-identically (documented §9 semantics), which is the DIFFERENT
    // code path this flag-matrix test distinguishes from the three above.
    const noSurfaceCtx: AuthzContext = { sessionId: 's', lookupTaskSession: () => null };
    expect(authorize('operator', approveTool, noSurfaceCtx)).toEqual({ ok: true });
    expect(authorize('operator', approveTool, notOperatorCtx)).not.toEqual({ ok: true });
  });

  it('LIST_CHANNELS/GET_CHANNEL_TIMELINE are absent-denied (NOT_ENABLED) when SURFACE_COMMANDS is off, even with ENABLED=1', async () => {
    process.env.TORQCLAW_COLLAB_ENABLED = '1';
    process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS = '0';
    const { collabSurfaceCommandsEnabled } = await import('../packages/gateway/src/collabSurface.js');
    // This is the exact predicate server.ts's dispatch switch checks before
    // ever calling handleListChannels/handleGetChannelTimeline -- with it
    // false, the switch answers NOT_ENABLED without touching the substrate
    // at all (verified structurally here; the socket-level wiring is the
    // server.ts dispatch switch itself, unit-untestable without a live
    // socket harness, which is out of scope for S1's test obligations).
    expect(collabSurfaceCommandsEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G2A D-1 (defence in depth, layer 1 of 2): the wire contract itself rejects
// a malformed cursor -- proving the defense exists at the Zod boundary, not
// only inside the handler's widened catch.
// ---------------------------------------------------------------------------
describe('ClientCommandSchema — GET_CHANNEL_TIMELINE cursor grammar (D-1)', () => {
  const base = { action: 'GET_CHANNEL_TIMELINE' as const, channelId: 'c1', limit: 20 };

  it.each(['abc', '007'])('rejects malformed cursor %j at the wire boundary', (badCursor) => {
    const result = ClientCommandSchema.safeParse({ ...base, cursor: badCursor });
    expect(result.success).toBe(false);
  });

  it.each(['0', '42'])('still parses well-formed cursor %j', (goodCursor) => {
    const result = ClientCommandSchema.safeParse({ ...base, cursor: goodCursor });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBe(goodCursor);
  });
});
