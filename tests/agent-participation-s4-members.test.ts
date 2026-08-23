/**
 * PRD-007 S4-Members — LIST_CHANNEL_MEMBERS (G1D resolution table item B-1)
 * + the S4 "working now" presence overlay (OQ-2, GRANTED 2026-08-23; see
 * tests/agent-participation-s4-presence.test.ts for the live-push-specific
 * T-1/T-2/T-10 coverage). This file's assertions were updated in place once
 * the overlay was built: every member row now carries `working`/`since`
 * always, derived at read time from collab_agent_turns
 * (state='dispatched' AND resolved_at IS NULL), never persisted, never
 * client-supplied.
 *
 * Covers:
 *   T-3  — a non-member caller and a caller naming a nonexistent channelId
 *          both throw the substrate's byte-identical COLLAB_NOT_FOUND, end
 *          to end through the gateway handler (assertChannelVisible is the
 *          only predicate involved on either path).
 *   T-4  — a seeded principal NOT a member of the channel, WITH a seeded
 *          dispatched (unresolved) collab_agent_turns row for it, is absent
 *          from the response; the seeded rows are independently asserted to
 *          exist (exclusion proven, not vacuous). Every returned member
 *          object's key set is asserted to be EXACTLY
 *          {principalId, displayName, role, kind, working, since} -- no
 *          extra field.
 *   COLLAB_IDENTITY_REQUIRED — a NULL-principal connection is refused.
 *   Seat lattice — a `channel` seat is denied at authz outright.
 *   T-9  — a full LIST_CHANNEL_MEMBERS lifecycle writes ZERO rows to
 *          collab_events (reuses the tests/collab-presence-a5-zero-writes.js
 *          production-handle-counting method).
 *   T-10 — a booted-gateway round trip: real gateway process, real wire
 *          frames, real WebSocket.
 *   T-5  — structural: neither autoReplyDispatcher.ts nor
 *          collabAgentTools.ts imports/reaches listChannelMembers (grep-
 *          based, stated as such).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runCollaborationMigration, runAgentAutoreplyMigration } from '../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../packages/collab/src/harness.js';
import { CollaborationStore, CollabError, type CallerContext } from '../packages/collab/src/store.js';
import { authorize, type AuthzContext } from '../packages/gateway/src/authz.js';
import { issueCredential } from '../packages/collab/src/index.js';
import { ensureGatewayBuild, launchGateway, type GatewayHandle } from './helpers/collab-gateway-harness.js';
import WebSocket from 'ws';

function nowIso(): string { return new Date().toISOString(); }

function makeFixture(fixtureId: string) {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  runAgentAutoreplyMigration(sqlite);
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

async function makeAgent(store: CollaborationStore, operatorCaller: CallerContext, name: string, idem: string) {
  const result = await store.createAgent(operatorCaller, { displayName: name }, idem);
  return { principalId: result.principalId, caller: { principalId: result.principalId, kind: 'agent' as const } };
}

/** Directly inserts a NON-member agent principal plus a seeded, unresolved
 *  ('dispatched') collab_agent_turns row for it against `channelId` -- the
 *  T-4 exclusion fixture. Returns the principalId so the test can assert
 *  BOTH that the row exists (anti-vacuity) AND that it is absent from
 *  LIST_CHANNEL_MEMBERS' response. */
function seedNonMemberWithDispatchedTurn(
  db: InstanceType<typeof Database>,
  opts: { channelId: string; ownerPrincipalId: string },
): string {
  const principalId = randomUUID();
  const now = nowIso();
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'Non-member agent', ?, 'active', 1, NULL, ?, ?)",
  ).run(principalId, opts.ownerPrincipalId, now, now);
  // Deliberately NOT inserted into collab_members -- membership absence is
  // the point of this fixture.
  db.prepare(
    `INSERT INTO collab_agent_turns(channel_id, agent_principal_id, channel_seq, trigger_event_id, state, dispatch_request_id, dispatched_at, resolved_at)
     VALUES (?, ?, 1, ?, 'dispatched', ?, ?, NULL)`,
  ).run(opts.channelId, principalId, randomUUID(), randomUUID(), now);
  return principalId;
}

function collabEventsCount(sqlite: InstanceType<typeof Database>): number {
  return (sqlite.prepare('SELECT COUNT(*) as n FROM collab_events').get() as { n: number }).n;
}

describe('PRD-007 S4-Members — listChannelMembers (store-level, T-3/T-4/T-9)', () => {
  let fixture: ReturnType<typeof makeFixture>;

  beforeEach(() => {
    fixture = makeFixture(`s4members-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    fixture.sqlite.close();
  });

  it('T-3: a non-member caller and a caller naming a nonexistent channelId both throw the SAME CollabError (code AND message byte-identical)', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'general' }, 'idem-chan-1');
    const { caller: outsiderCaller } = await makeAgent(store, operatorCaller, 'Outsider', 'idem-outsider');

    let nonMemberError: CollabError | null = null;
    try {
      await store.listChannelMembers(outsiderCaller, { channelId: channel.channelId });
    } catch (err) {
      nonMemberError = err as CollabError;
    }
    expect(nonMemberError).toBeInstanceOf(CollabError);
    expect(nonMemberError!.code).toBe('COLLAB_NOT_FOUND');

    let nonexistentError: CollabError | null = null;
    try {
      await store.listChannelMembers(outsiderCaller, { channelId: 'channel-does-not-exist' });
    } catch (err) {
      nonexistentError = err as CollabError;
    }
    expect(nonexistentError).toBeInstanceOf(CollabError);
    expect(nonexistentError!.code).toBe('COLLAB_NOT_FOUND');

    // Byte-identical: same code AND same message string across both denial
    // causes -- a hidden channel must not become distinguishable from an
    // absent one through any difference in the thrown error.
    expect(nonMemberError!.message).toBe(nonexistentError!.message);
  });

  it('T-4: a non-member with a seeded DISPATCHED (unresolved) collab_agent_turns row is absent from the response; the seeded rows are proven to exist first (anti-vacuity)', async () => {
    const { store, operatorCaller, db, bootstrap } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'general' }, 'idem-chan-2');
    const { principalId: memberAgentId, caller: memberAgentCaller } =
      await makeAgent(store, operatorCaller, 'Member agent', 'idem-member-agent');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: memberAgentId }, 'idem-add-member');

    const nonMemberId = seedNonMemberWithDispatchedTurn(
      db as unknown as InstanceType<typeof Database>,
      { channelId: channel.channelId, ownerPrincipalId: bootstrap.operatorPrincipalId },
    );

    // Anti-vacuity: the seeded principal and its dispatched turn really
    // exist in this DB before we assert their absence from the roster.
    const principalRow = (db as unknown as InstanceType<typeof Database>)
      .prepare('SELECT id FROM principals WHERE id = ?').get(nonMemberId);
    expect(principalRow, 'seeded non-member principal must exist').toBeTruthy();
    const turnRow = (db as unknown as InstanceType<typeof Database>)
      .prepare("SELECT state FROM collab_agent_turns WHERE agent_principal_id = ? AND channel_id = ?")
      .get(nonMemberId, channel.channelId) as { state: string } | undefined;
    expect(turnRow?.state, 'seeded dispatched turn must exist').toBe('dispatched');

    const result = await store.listChannelMembers(memberAgentCaller, { channelId: channel.channelId });

    const returnedIds = result.members.map((m) => m.principalId);
    expect(returnedIds).toContain(bootstrap.operatorPrincipalId);
    expect(returnedIds).toContain(memberAgentId);
    expect(
      returnedIds,
      'a non-member with an unresolved dispatched turn must NOT appear in the roster -- presence never implies membership, and this command never reads collab_agent_turns at all',
    ).not.toContain(nonMemberId);

    // Key-set equality: EXACTLY {principalId, displayName, role, kind,
    // working, since} on every returned member (PRD-007 S4 presence
    // overlay, OQ-2 GRANTED 2026-08-23) -- no taskId, prompt, tier, tool,
    // cost, spend, provider, model, or any other extra field.
    for (const m of result.members) {
      expect(Object.keys(m).sort()).toEqual(
        ['displayName', 'kind', 'principalId', 'role', 'since', 'working'].sort(),
      );
    }
    const owner = result.members.find((m) => m.principalId === bootstrap.operatorPrincipalId)!;
    expect(owner.role).toBe('owner');
    expect(owner.kind).toBe('human');
    // A human/owner row can never have a collab_agent_turns row (those are
    // keyed to agent principals only) -- always false/null by construction.
    expect(owner.working).toBe(false);
    expect(owner.since).toBeNull();
    const agentMember = result.members.find((m) => m.principalId === memberAgentId)!;
    expect(agentMember.role).toBe('agent');
    expect(agentMember.kind).toBe('agent');
    // The member agent has no dispatched turn seeded in this fixture --
    // not working, even though it IS an agent (working is turn-derived,
    // never role-derived).
    expect(agentMember.working).toBe(false);
    expect(agentMember.since).toBeNull();
  });

  it('T-9: a full LIST_CHANNEL_MEMBERS lifecycle writes ZERO rows to collab_events', async () => {
    const { store, operatorCaller, sqlite } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'general' }, 'idem-chan-3');
    const before = collabEventsCount(sqlite);

    await store.listChannelMembers(operatorCaller, { channelId: channel.channelId });
    await store.listChannelMembers(operatorCaller, { channelId: channel.channelId });

    const after = collabEventsCount(sqlite);
    expect(
      after,
      'LIST_CHANNEL_MEMBERS is presence/membership READ-ONLY -- it must never write to collab_events',
    ).toBe(before);
  });
});

describe('PRD-007 S4-Members — authz (seat lattice, §2a)', () => {
  function ctxFor(sessionId: string): AuthzContext {
    return { sessionId, lookupTaskSession: () => null };
  }

  it('operator seat: allowed', () => {
    const decision = authorize('operator', { action: 'LIST_CHANNEL_MEMBERS', channelId: 'c1' } as any, ctxFor('s1'));
    expect(decision.ok).toBe(true);
  });

  it('channel seat: explicit deny (transport identity, not a collab surface credential holder)', () => {
    const decision = authorize('channel', { action: 'LIST_CHANNEL_MEMBERS', channelId: 'c1' } as any, ctxFor('s1'));
    expect(decision.ok).toBe(false);
  });

  it('node seat: denied (no agentCollabWrite-style widening exists for this read command)', () => {
    const decision = authorize('node', { action: 'LIST_CHANNEL_MEMBERS', channelId: 'c1' } as any, ctxFor('s1'));
    expect(decision.ok).toBe(false);
  });
});

describe('PRD-007 S4-Members — gateway handler (handleListChannelMembers)', () => {
  let fixture: ReturnType<typeof makeFixture>;
  let setCollabSurfaceStoreForTest: (s: CollaborationStore | null) => void;
  let handleListChannelMembers: (
    sid: string, principalId: string | null, channelId: string,
  ) => Promise<{ code: string; detail?: unknown } | null>;
  let publishedFrames: Array<{ message: string; metadata?: any }>;
  const SESS_ID = randomUUID();

  beforeEach(async () => {
    fixture = makeFixture(`s4members-handler-${Math.random().toString(36).slice(2)}`);
    const mod = await import('../packages/gateway/src/collabSurface.js');
    setCollabSurfaceStoreForTest = mod.setCollabSurfaceStoreForTest;
    handleListChannelMembers = mod.handleListChannelMembers;
    setCollabSurfaceStoreForTest(fixture.store);

    publishedFrames = [];
    const { sessionBus } = await import('../packages/gateway/src/events.js');
    sessionBus.subscribe(SESS_ID, (event) => {
      publishedFrames.push({ message: event.message, metadata: event.metadata });
    });
  });

  afterEach(() => {
    setCollabSurfaceStoreForTest(null);
    fixture.sqlite.close();
  });

  it('NULL principal => COLLAB_IDENTITY_REQUIRED, never substituted or widened', async () => {
    const channel = await fixture.store.createChannel(fixture.operatorCaller, { name: 'general' }, 'idem-null');
    const err = await handleListChannelMembers(SESS_ID, null, channel.channelId);
    expect(err).toEqual({ code: 'COLLAB_IDENTITY_REQUIRED' });
    expect(publishedFrames.length).toBe(0);
  });

  it('happy path: publishes a collabMembers metadata frame with channelId + members', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'general' }, 'idem-happy');
    const err = await handleListChannelMembers(SESS_ID, operatorCaller.principalId, channel.channelId);
    expect(err).toBeNull();
    const frame = publishedFrames.find((f) => f.metadata?.collabMembers === true);
    expect(frame).toBeTruthy();
    expect(frame!.metadata.channelId).toBe(channel.channelId);
    expect(Array.isArray(frame!.metadata.members)).toBe(true);
    expect(frame!.metadata.members[0]).toEqual({
      principalId: operatorCaller.principalId,
      displayName: 'Operator',
      role: 'owner',
      kind: 'human',
      working: false,
      since: null,
    });
  });

  it('T-3 (handler level): non-member and nonexistent channelId both surface the SAME COLLAB_NOT_FOUND shape', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'general' }, 'idem-t3h');
    const { caller: outsider } = await makeAgent(store, operatorCaller, 'Outsider', 'idem-outsider-h');

    const nonMemberErr = await handleListChannelMembers(SESS_ID, outsider.principalId, channel.channelId);
    const nonexistentErr = await handleListChannelMembers(SESS_ID, outsider.principalId, 'nope-does-not-exist');

    expect(nonMemberErr?.code).toBe('COLLAB_NOT_FOUND');
    expect(nonexistentErr?.code).toBe('COLLAB_NOT_FOUND');
    expect(nonMemberErr?.detail).toBe(nonexistentErr?.detail);
  });
});

describe('PRD-007 S4-Members — T-5 structural: no dispatch-side reachability', () => {
  it('neither autoReplyDispatcher.ts nor collabAgentTools.ts imports/reaches listChannelMembers (grep-based; stated, not an AST reachability proof)', () => {
    const dispatcherSrc = readFileSync(
      new URL('../packages/gateway/src/autoReplyDispatcher.ts', import.meta.url),
      'utf8',
    );
    const toolsSrc = readFileSync(
      new URL('../packages/gateway/src/collabAgentTools.ts', import.meta.url),
      'utf8',
    );
    expect(dispatcherSrc).not.toMatch(/listChannelMembers/);
    expect(dispatcherSrc).not.toMatch(/handleListChannelMembers/);
    expect(toolsSrc).not.toMatch(/listChannelMembers/);
    expect(toolsSrc).not.toMatch(/handleListChannelMembers/);
  });

  /**
   * Builder G deviation 1 fix (T-4 / G1R N-3): autoReplyDispatcher.ts now
   * fires EXACTLY ONE new call it did not make before -- a TRIGGER, not a
   * read -- to store.pushPresenceForResolvedTurn after every resolveAgentTurn
   * resolution. This test pins that the widening is bounded to exactly that
   * one trigger call, and that the dispatcher still never reads or branches
   * on `working`, `since`, or listChannelMembers/handleListChannelMembers
   * (the two matches already asserted absent above) anywhere in its own
   * source. A structural comment claiming a guard the code does not perform
   * is this program's own recorded recurring defect (see this file's
   * `resolveAgentTurn` wrapper doc comment) -- so this is a grep-based
   * assertion on the actual source text, not a restatement of intent.
   */
  it('the dispatcher\'s only new presence-related surface is the single pushPresenceForResolvedTurn TRIGGER call; no working/since read is added', () => {
    const dispatcherSrc = readFileSync(
      new URL('../packages/gateway/src/autoReplyDispatcher.ts', import.meta.url),
      'utf8',
    );
    const triggerCalls = dispatcherSrc.match(/\.pushPresenceForResolvedTurn\(/g) ?? [];
    expect(
      triggerCalls.length,
      `expected exactly one pushPresenceForResolvedTurn call site; found ${triggerCalls.length}`,
    ).toBe(1);
    // The dispatcher must never itself read the working/since presence
    // fields -- pushPresenceForResolvedTurn re-reads committed truth INSIDE
    // the store, never trusting a dispatcher-computed value. Strip block +
    // line comments first so this checks actual CODE, not doc-comment prose
    // that merely DESCRIBES the guarantee (as this very file's wrapper
    // comment does, in words, immediately above its implementation).
    const codeOnly = dispatcherSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(codeOnly).not.toMatch(/\bworking\b/);
    expect(codeOnly).not.toMatch(/\.since\b/);
    expect(codeOnly).not.toMatch(/listChannelMembers/);
    expect(codeOnly).not.toMatch(/handleListChannelMembers/);
  });
});

describe('PRD-007 S4-Members — T-10 booted-gateway round trip', () => {
  let gateway: GatewayHandle | null = null;

  beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
  afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });
  afterAll(async () => { if (gateway) { await (gateway as GatewayHandle).stop(); gateway = null; } });

  type WireSeed = {
    collabDbPath: string;
    operatorId: string;
    issuedOperator: ReturnType<typeof issueCredential>;
    channelId: string;
  };

  function seedWireDb(dataDir: string, pepper: Buffer): WireSeed {
    const collabDbPath = join(dataDir, 'collab.db');
    const db = new Database(collabDbPath);
    runCollaborationMigration(db);
    const operatorId = randomUUID();
    const credOperator = randomUUID();
    const now = nowIso();

    db.prepare(
      "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Operator', NULL, 'active', 1, NULL, ?, ?)",
    ).run(operatorId, now, now);

    const issuedOperator = issueCredential(credOperator, pepper, nodeRandomSource);
    db.prepare(
      "INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)",
    ).run(credOperator, operatorId, issuedOperator.secretHmac, now);

    const channelId = randomUUID();
    db.prepare(
      "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'general', 'general', 'active', ?, 1, ?, ?)",
    ).run(channelId, operatorId, now, now);
    db.prepare(
      "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
    ).run(channelId, operatorId, now);

    issuedOperator.secretBytes.fill(0);
    db.close();
    return { collabDbPath, operatorId, issuedOperator, channelId };
  }

  function wsRoundtrip(url: string, frames: unknown[], timeoutMs = 10000): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const received: any[] = [];
      let idx = 0;
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* noop */ }
        reject(new Error('timeout; received=' + JSON.stringify(received)));
      }, timeoutMs);
      ws.once('open', () => ws.send(JSON.stringify(frames[idx++])));
      ws.on('message', (raw) => {
        received.push(JSON.parse(raw.toString()));
        if (idx < frames.length) {
          ws.send(JSON.stringify(frames[idx++]));
        } else {
          clearTimeout(timer);
          setTimeout(() => ws.close(), 150);
        }
      });
      ws.once('close', () => { clearTimeout(timer); resolve(received); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  const WIRE_BASE_ENV = (dataDir: string, seed: WireSeed, pepper: Buffer) => ({
    TORQCLAW_DATA_DIR: dataDir,
    TORQCLAW_COLLAB_DB_PATH: seed.collabDbPath,
    TORQCLAW_COLLAB_ENABLED: '1',
    TORQCLAW_COLLAB_SURFACE_COMMANDS: '1',
    TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'),
    TORQCLAW_GATEWAY_TOKEN: 'unused',
    TORQCLAW_CHANNEL_SERVICE_TOKEN: 'unused-cst',
  });

  it('a real booted gateway serves LIST_CHANNEL_MEMBERS over the real wire, returning the seeded operator as owner/human', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s4members-wire-'));
    const pepper = Buffer.alloc(32, 0x51);
    const seed = seedWireDb(dataDir, pepper);
    gateway = await launchGateway(WIRE_BASE_ENV(dataDir, seed, pepper));
    await gateway.ready;

    const connectOperator = {
      expectedRole: 'operator',
      clientInfo: { name: 's4-members-wire', version: '0.1.0' },
      auth: { kind: 'surface', credential: seed.issuedOperator.token },
    };
    const listMembers = { action: 'LIST_CHANNEL_MEMBERS', channelId: seed.channelId };

    const frames = await wsRoundtrip(gateway.url, [connectOperator, listMembers]);
    const errorFrame = frames.find((f) => f.type === 'ERROR');
    expect(errorFrame, 'LIST_CHANNEL_MEMBERS must succeed for the operator seat; got ' + JSON.stringify(frames)).toBeUndefined();

    const membersFrame = frames.find((f) => f.metadata?.collabMembers === true);
    expect(membersFrame, 'expected a collabMembers response frame; got ' + JSON.stringify(frames)).toBeTruthy();
    expect(membersFrame.metadata.channelId).toBe(seed.channelId);
    expect(membersFrame.metadata.members).toEqual([
      {
        principalId: seed.operatorId,
        displayName: 'Operator',
        role: 'owner',
        kind: 'human',
        working: false,
        since: null,
      },
    ]);
  }, 30000);

  it('a channel (non-operator) seat is denied LIST_CHANNEL_MEMBERS outright (authz, seat lattice)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s4members-wire-deny-'));
    const pepper = Buffer.alloc(32, 0x52);
    const seed = seedWireDb(dataDir, pepper);
    gateway = await launchGateway(WIRE_BASE_ENV(dataDir, seed, pepper));
    await gateway.ready;

    const connectChannel = {
      expectedRole: 'channel',
      clientInfo: { name: 's4-members-wire-chan', version: '0.1.0' },
      auth: { kind: 'channel_service', credential: 'unused-cst' },
    };
    const listMembers = { action: 'LIST_CHANNEL_MEMBERS', channelId: seed.channelId };
    const frames = await wsRoundtrip(gateway.url, [connectChannel, listMembers]);
    const errorFrame = frames.find((f) => f.type === 'ERROR');
    expect(errorFrame?.code).toBe('UNAUTHORIZED');
  }, 30000);
});
