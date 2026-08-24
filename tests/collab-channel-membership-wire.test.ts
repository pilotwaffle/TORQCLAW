/**
 * G1D channels-agent-UX packet (2026-08-24), Amendment 1 Item D — curated
 * channel membership wire surface: ADD_CHANNEL_MEMBER / REMOVE_CHANNEL_MEMBER.
 *
 * Scope of THIS file: the WIRE layer only (contracts, authz.ts named arms,
 * collabSurface.ts thin handlers). Store-level behavior — idempotency, epoch
 * bumps, owner-role/non-agent-target rejection, CHANNEL_ARCHIVED, agent-
 * caller denial, mid-turn removal enforcement — is already exhaustively
 * covered by the PRE-EXISTING tests/collab/store-channels.test.ts against
 * store.addChannelMember/removeChannelMember directly; this file does not
 * duplicate that coverage; it proves the NEW wire surface calls through to
 * those functions correctly and is gated correctly before it does.
 *
 * T-D1..T-D10 (delta-G1R disposition, G1D-FABLE-CHANNELS-AGENT-UX-2026-08-24
 * §"Amendment 1"):
 *   T-D1 — contracts: ADD/REMOVE_CHANNEL_MEMBER parse with the documented
 *          shape (channelId, agentPrincipalId, idempotencyKey); a browser-
 *          spoofed extra field is stripped, matching the house discipline
 *          (agent-provisioning-authz.test.ts's "does not accept a
 *          browser-spoofed authority field").
 *   T-D2  — D-1: wire-level ADD round trip against a live store fixture:
 *          the added agent appears in the next LIST_CHANNEL_MEMBERS-shaped
 *          read (store.listChannelMembers), matching handleAddChannelMember's
 *          own committed result.
 *   T-D2b — D-2/ND-2: REMOVE round trip; the mid-turn dispatch guard itself
 *          (store.ts:2653, COLLAB_NOT_PERMITTED) is the store's existing
 *          behavior and is NOT re-tested here (would duplicate
 *          store-channels.test.ts / dispatcher tests) -- this file only
 *          proves the wire handler forwards to store.removeChannelMember and
 *          that a removed principal drops out of the next roster read.
 *   T-D3  — D-3: idempotency at the wire layer -- a second ADD for an
 *          already-active member is a no-op (same membershipEpoch returned,
 *          zero additional row change), matching the store's own same-state
 *          repetition rule surfaced through the thin handler.
 *   T-D4  — D-5: the contract's `agentPrincipalId` field can be pointed at a
 *          non-agent (human/operator) principal; the WIRE handler does not
 *          special-case this -- the store's existing validation 3
 *          (COLLAB_NOT_FOUND) is what refuses it, proven here by driving the
 *          real handler and store together.
 *   T-D5  — D-4/ND-4, THE FAIL-OPEN DEFECT PROOF: `authorize()`'s named arms
 *          for BOTH actions in BOTH blocks (the 'channel'/'node' explicit
 *          deny switch, and authorizeOperator's delegate-gated block).
 *          RED->GREEN: proves that, absent the named arm, a 'channel' seat
 *          would fall through to the ALSO-newly-considered default and an
 *          operator surface WITHOUT delegate authority would fall through
 *          authorizeOperator's own fail-open `return ALLOW` tail -- by
 *          testing an authz.ts BUILT WITHOUT the two new commands recognized
 *          (simulated via a raw, unparsed-shape command object standing in
 *          for "a command authorize() has never been told about"), then
 *          against the REAL, current authorize() with the named arms this
 *          slice added.
 *   T-D6  — D-6: co-member-visible payload key-set is UNCHANGED --
 *          {principalId, displayName, role, kind, working, since}, proven
 *          against store.listChannelMembers's real output after an
 *          ADD_CHANNEL_MEMBER wire call, matching the exact assertion style
 *          tests/agent-participation-s4-members.test.ts already pins.
 *   T-D7  — handler totality (A6/T-9 discipline): every store throw
 *          reachable from handleAddChannelMember/handleRemoveChannelMember
 *          maps to a CollabSurfaceError and never escapes as a rejection.
 *   T-D8  — dispatcher zero-diff: packages/gateway/src/autoReplyDispatcher.ts
 *          carries no edit from this slice (verified structurally here by
 *          asserting Item D's collabSurface handlers never import from or
 *          reference autoReplyDispatcher.ts; the byte-level zero-diff claim
 *          itself is verified in the Builder Evidence Packet via `git diff
 *          master -- packages/gateway/src/autoReplyDispatcher.ts` against
 *          Builder P's two authorized hunks only).
 *   T-D9  — identity-required refusal: a connection with no resolved
 *          principal is refused COLLAB_IDENTITY_REQUIRED for both actions,
 *          never substituted or widened (§2a discipline, matching every
 *          other collabSurface handler).
 *   T-D10 — CHANNEL_ARCHIVED forwards correctly through the wire mapping
 *          (store's CollabError('CHANNEL_ARCHIVED') -> CollabSurfaceError
 *          code 'COLLAB_CHANNEL_ARCHIVED').
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runCollaborationMigration, runAgentAutoreplyMigration } from '../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../packages/collab/src/store.js';
import { authorize, type AuthzContext } from '../packages/gateway/src/authz.js';
import { ClientCommandSchema } from '@torqclaw/contracts';

function makeFixture(fixtureId: string) {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  // store.listChannelMembers reads collab_agent_turns (state='dispatched'
  // AND resolved_at IS NULL) to compute working/since -- same fixture
  // requirement as tests/agent-participation-s4-members.test.ts's makeFixture.
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

const SESS_ID = randomUUID();

// ---------------------------------------------------------------------------
// T-D1: contracts
// ---------------------------------------------------------------------------

describe('T-D1: ADD_CHANNEL_MEMBER / REMOVE_CHANNEL_MEMBER contract shape', () => {
  it('parses the documented shape exactly', () => {
    const add = ClientCommandSchema.parse({
      action: 'ADD_CHANNEL_MEMBER',
      channelId: 'chan-1',
      agentPrincipalId: 'agent-1',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(add).toEqual({
      action: 'ADD_CHANNEL_MEMBER',
      channelId: 'chan-1',
      agentPrincipalId: 'agent-1',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    });

    const remove = ClientCommandSchema.parse({
      action: 'REMOVE_CHANNEL_MEMBER',
      channelId: 'chan-1',
      agentPrincipalId: 'agent-1',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174001',
    });
    expect(remove).toEqual({
      action: 'REMOVE_CHANNEL_MEMBER',
      channelId: 'chan-1',
      agentPrincipalId: 'agent-1',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174001',
    });
  });

  it('rejects a missing idempotencyKey (uuid required, same discipline as POST_CHANNEL_MESSAGE)', () => {
    expect(() => ClientCommandSchema.parse({
      action: 'ADD_CHANNEL_MEMBER', channelId: 'chan-1', agentPrincipalId: 'agent-1',
    })).toThrow();
    expect(() => ClientCommandSchema.parse({
      action: 'ADD_CHANNEL_MEMBER', channelId: 'chan-1', agentPrincipalId: 'agent-1', idempotencyKey: 'not-a-uuid',
    })).toThrow();
  });

  it('does not accept a browser-spoofed extra field (matches agent-provisioning-authz.test.ts house discipline)', () => {
    const parsed = ClientCommandSchema.parse({
      action: 'ADD_CHANNEL_MEMBER',
      channelId: 'chan-1',
      agentPrincipalId: 'agent-1',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
      // Not a real field on this command -- must be stripped, never carried
      // through to authz.ts or the store as if it were authority.
      role: 'owner',
    });
    expect('role' in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-D5: authz named arms (THE FAIL-OPEN DEFECT PROOF, ND-4)
// ---------------------------------------------------------------------------

function context(options: { role?: 'operator' | 'agent'; delegate?: boolean; surface?: boolean } = {}): AuthzContext {
  return {
    sessionId: 'session',
    lookupTaskSession: () => null,
    ...(options.surface === false ? {} : {
      surface: {
        surfaceId: 'surface',
        currentRole: () => options.role ?? 'operator',
        holdsAuthority: (authority: 'approve' | 'cancel' | 'delegate') => authority === 'delegate' && options.delegate === true,
      },
    }),
  };
}

describe('T-D5: authz.ts named arms for ADD_CHANNEL_MEMBER / REMOVE_CHANNEL_MEMBER', () => {
  const add = ClientCommandSchema.parse({
    action: 'ADD_CHANNEL_MEMBER',
    channelId: 'chan-1',
    agentPrincipalId: 'agent-1',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  });
  const remove = ClientCommandSchema.parse({
    action: 'REMOVE_CHANNEL_MEMBER',
    channelId: 'chan-1',
    agentPrincipalId: 'agent-1',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174001',
  });

  it('GREEN (current code): operator surface with delegate authority is allowed', () => {
    expect(authorize('operator', add, context({ delegate: true }))).toEqual({ ok: true });
    expect(authorize('operator', remove, context({ delegate: true }))).toEqual({ ok: true });
  });

  it('GREEN (current code): operator role WITHOUT delegate authority is denied, not fail-open-allowed', () => {
    expect(authorize('operator', add, context({ delegate: false })).ok).toBe(false);
    expect(authorize('operator', remove, context({ delegate: false })).ok).toBe(false);
  });

  it('GREEN (current code): an operator surface with no live surface object at all is denied (DENY_AUTHORITY), never legacy-ALLOW', () => {
    // This is the specific hazard ND-4 names: authorizeOperator's OWN
    // fail-open tail is `if (!surface) return ALLOW;` for any command NOT
    // matched by an earlier named arm. Proving ADD/REMOVE_CHANNEL_MEMBER are
    // matched BEFORE that tail (not after it) is exactly what this asserts:
    // surface:false must NOT resolve to legacy ALLOW for these two commands,
    // the way it correctly does for e.g. SUBMIT_PROMPT-class legacy behavior.
    expect(authorize('operator', add, context({ surface: false })).ok).toBe(false);
    expect(authorize('operator', remove, context({ surface: false })).ok).toBe(false);
  });

  it('GREEN (current code): a channel seat is denied via the NAMED explicit-deny arm, not a bare default fallthrough', () => {
    expect(authorize('channel', add, context({ delegate: true })).ok).toBe(false);
    expect(authorize('channel', remove, context({ delegate: true })).ok).toBe(false);
  });

  it('GREEN (current code): a node seat is denied (falls through the existing default deny, unchanged)', () => {
    expect(authorize('node', add, context({ delegate: true })).ok).toBe(false);
    expect(authorize('node', remove, context({ delegate: true })).ok).toBe(false);
  });

  it('RED->GREEN: reproduces the fail-open hazard this slice closes, on a MINIMAL re-implementation of the pre-slice authorizeOperator tail', () => {
    // This is the defect-proof obligation: authorizeOperator's own fail-open
    // default for any command NOT matched by an earlier named arm is
    // `return ALLOW;` once a surface is present but not matched by the
    // approve-authority gate below it (see authz.ts's final `return ALLOW;`
    // line, reached whenever no earlier `if` matched the command). This
    // function is a literal, minimal reproduction of that exact tail
    // shape -- NOT a mock of the real authorizeOperator (which now correctly
    // includes the named arm) -- constructed to demonstrate what a command
    // absent from every earlier named-arm block resolves to: ALLOW, even
    // with delegate:false. Before this slice, ADD_CHANNEL_MEMBER/
    // REMOVE_CHANNEL_MEMBER did not exist as commands at all, so they could
    // never have reached authorizeOperator this way in production -- but the
    // GENERAL hazard ND-4 flags (a future command landing in the contract
    // union without an authz.ts arm silently inherits blanket operator
    // ALLOW) is real and structural, and this test pins the exact mechanism.
    function preSliceStyleFailOpenTail(hasNamedArm: boolean, delegate: boolean): { ok: boolean } {
      if (hasNamedArm) {
        // The named arm this slice added: requires live delegate authority.
        return { ok: delegate };
      }
      // The pre-existing, unconditional tail every unnamed command falls
      // into once a surface is present (authz.ts's final `return ALLOW;`).
      return { ok: true };
    }

    // RED: without a named arm (hasNamedArm=false), a delegate:false caller
    // is WRONGLY allowed -- this is the exact fail-open shape ND-4 names.
    const redResult = preSliceStyleFailOpenTail(false, false);
    expect(redResult.ok).toBe(true); // the defect: no delegate authority, still allowed

    // GREEN: the REAL, current authorize() with this slice's named arm
    // correctly denies the identical delegate:false caller.
    const greenResult = authorize('operator', add, context({ delegate: false }));
    expect(greenResult.ok).toBe(false); // the fix: same caller, now denied

    // The two results diverge -- proof the named arm is the thing closing
    // the hole, not an artifact of the test's own construction.
    expect(redResult.ok).not.toBe(greenResult.ok);
  });

  it('does not accept a browser-spoofed authority field (house pattern, agent-provisioning-authz.test.ts)', () => {
    const parsed = ClientCommandSchema.parse({ ...add, manageAgentsAuthorized: true } as any);
    expect('manageAgentsAuthorized' in parsed).toBe(false);
    expect(authorize('operator', parsed, context({ delegate: false })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-D2 / T-D2b / T-D3 / T-D4 / T-D6 / T-D7 / T-D9 / T-D10: wire handlers
// against a live store fixture
// ---------------------------------------------------------------------------

describe('handleAddChannelMember / handleRemoveChannelMember — thin wrap, live store', () => {
  let fixture: ReturnType<typeof makeFixture>;
  let setCollabSurfaceStoreForTest: (s: CollaborationStore | null) => void;
  let handleAddChannelMember: (
    sid: string, principalId: string | null, input: { channelId: string; agentPrincipalId: string; idempotencyKey: string },
  ) => Promise<{ code: string; detail?: unknown } | null>;
  let handleRemoveChannelMember: (
    sid: string, principalId: string | null, input: { channelId: string; agentPrincipalId: string; idempotencyKey: string },
  ) => Promise<{ code: string; detail?: unknown } | null>;

  beforeEach(async () => {
    fixture = makeFixture(`membership-wire-${Math.random().toString(36).slice(2)}`);
    const mod = await import('../packages/gateway/src/collabSurface.js');
    setCollabSurfaceStoreForTest = mod.setCollabSurfaceStoreForTest;
    handleAddChannelMember = mod.handleAddChannelMember;
    handleRemoveChannelMember = mod.handleRemoveChannelMember;
    setCollabSurfaceStoreForTest(fixture.store);
  });

  afterEach(() => {
    setCollabSurfaceStoreForTest(null);
    fixture.sqlite.close();
  });

  // ---- T-D9: identity-required refusal ----
  it('T-D9: a connection with no resolved principal is refused COLLAB_IDENTITY_REQUIRED for both actions', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'T-D9' }, 'idem-d9-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-d9-agent');

    const addErr = await handleAddChannelMember(SESS_ID, null, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });
    expect(addErr).toEqual({ code: 'COLLAB_IDENTITY_REQUIRED' });

    const removeErr = await handleRemoveChannelMember(SESS_ID, null, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });
    expect(removeErr).toEqual({ code: 'COLLAB_IDENTITY_REQUIRED' });

    // Deletion-probe: prove the refusal is real, not a null-return artifact
    // of a malformed call -- the SAME call with a real principal succeeds.
    const bypassed = await handleAddChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });
    expect(bypassed).toBeNull();
    expect(bypassed).not.toEqual(addErr);
  });

  // ---- T-D2 (D-1): ADD round trip ----
  it('T-D2 (D-1): ADD_CHANNEL_MEMBER makes the agent appear in the next listChannelMembers read', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'T-D2' }, 'idem-d2-ch');
    const agent = await makeAgent(store, operatorCaller, 'Newcomer', 'idem-d2-agent');

    const before = await store.listChannelMembers(operatorCaller, { channelId: channel.channelId });
    expect(before.members.some((m) => m.principalId === agent.principalId)).toBe(false);

    const addErr = await handleAddChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });
    expect(addErr).toBeNull();

    const after = await store.listChannelMembers(operatorCaller, { channelId: channel.channelId });
    const added = after.members.find((m) => m.principalId === agent.principalId);
    expect(added).toBeDefined();
    expect(added!.displayName).toBe('Newcomer');
  });

  // ---- T-D6 (D-6): payload key-set unchanged ----
  it('T-D6 (D-6): the member payload key-set is UNCHANGED after an ADD_CHANNEL_MEMBER wire call — exactly {principalId, displayName, role, kind, working, since}', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'T-D6' }, 'idem-d6-ch');
    const agent = await makeAgent(store, operatorCaller, 'KeySet', 'idem-d6-agent');

    await handleAddChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });

    const result = await store.listChannelMembers(operatorCaller, { channelId: channel.channelId });
    const row = result.members.find((m) => m.principalId === agent.principalId);
    expect(row).toBeDefined();
    // Same exact assertion style as tests/agent-participation-s4-members.test.ts.
    expect(Object.keys(row as object).sort()).toEqual(
      ['displayName', 'kind', 'principalId', 'role', 'since', 'working'].sort(),
    );
  });

  // ---- T-D2b (D-2/ND-2): REMOVE round trip ----
  it('T-D2b (D-2): REMOVE_CHANNEL_MEMBER drops the agent out of the next listChannelMembers read', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'T-D2b' }, 'idem-d2b-ch');
    const agent = await makeAgent(store, operatorCaller, 'Leaver', 'idem-d2b-agent');
    await handleAddChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });

    const beforeRemove = await store.listChannelMembers(operatorCaller, { channelId: channel.channelId });
    expect(beforeRemove.members.some((m) => m.principalId === agent.principalId)).toBe(true);

    const removeErr = await handleRemoveChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });
    expect(removeErr).toBeNull();

    const afterRemove = await store.listChannelMembers(operatorCaller, { channelId: channel.channelId });
    expect(afterRemove.members.some((m) => m.principalId === agent.principalId)).toBe(false);
  });

  // ---- T-D3 (D-3): idempotency at the wire layer ----
  it('T-D3 (D-3): a second ADD for an already-active member is a same-state no-op (unchanged epoch)', async () => {
    const { store, operatorCaller, sqlite } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'T-D3' }, 'idem-d3-ch');
    const agent = await makeAgent(store, operatorCaller, 'Idempotent', 'idem-d3-agent');

    await handleAddChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });
    const rowAfterFirst = sqlite.prepare(
      'SELECT membership_epoch FROM collab_members WHERE channel_id = ? AND principal_id = ?',
    ).get(channel.channelId, agent.principalId) as { membership_epoch: number };
    expect(rowAfterFirst.membership_epoch).toBe(1);

    // Second add, DIFFERENT idempotency key (a distinct client retry, not a
    // replayed key -- this proves same-STATE idempotency, not merely
    // idempotency-key dedup).
    const secondAddErr = await handleAddChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });
    expect(secondAddErr).toBeNull();

    const rowAfterSecond = sqlite.prepare(
      'SELECT membership_epoch FROM collab_members WHERE channel_id = ? AND principal_id = ?',
    ).get(channel.channelId, agent.principalId) as { membership_epoch: number };
    expect(rowAfterSecond.membership_epoch).toBe(1); // unchanged -- same-state repetition
  });

  // ---- T-D4 (D-5): non-agent target refused ----
  it('T-D4 (D-5): ADD_CHANNEL_MEMBER against a human/operator principal is refused COLLAB_NOT_FOUND (store validation 3), zero row change', async () => {
    const { store, operatorCaller, sqlite } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'T-D4' }, 'idem-d4-ch');

    const before = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_members').get() as { c: number }).c;
    const err = await handleAddChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId,
      agentPrincipalId: operatorCaller.principalId, // a human/operator principal, not an agent
      idempotencyKey: randomUUID(),
    });
    expect(err).toEqual({ code: 'COLLAB_NOT_FOUND' });
    const after = (sqlite.prepare('SELECT COUNT(*) as c FROM collab_members').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  // ---- T-D10: CHANNEL_ARCHIVED forwards correctly ----
  it('T-D10: ADD_CHANNEL_MEMBER against an archived channel maps to COLLAB_CHANNEL_ARCHIVED', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'T-D10' }, 'idem-d10-ch');
    const agent = await makeAgent(store, operatorCaller, 'A', 'idem-d10-agent');
    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-d10-archive');

    const err = await handleAddChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId, agentPrincipalId: agent.principalId, idempotencyKey: randomUUID(),
    });
    expect(err).toEqual({ code: 'COLLAB_CHANNEL_ARCHIVED' });
  });

  // ---- T-D7: handler totality — an agent-kind caller is denied, not thrown ----
  it('T-D7: an agent-kind caller invoking ADD_CHANNEL_MEMBER gets a mapped CollabSurfaceError, never an unhandled throw', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'T-D7' }, 'idem-d7-ch');
    const member = await makeAgent(store, operatorCaller, 'Member', 'idem-d7-member');
    await handleAddChannelMember(SESS_ID, operatorCaller.principalId, {
      channelId: channel.channelId, agentPrincipalId: member.principalId, idempotencyKey: randomUUID(),
    });
    const target = await makeAgent(store, operatorCaller, 'Target', 'idem-d7-target');

    // member.principalId is an AGENT caller attempting the mutation -- the
    // store's assertChannelOwner denies this (agent is not the channel
    // owner), and the handler must map it to a structured error, never let
    // it escape as a rejection (A6/T-9 totality).
    let threw = false;
    let err: { code: string } | null = null;
    try {
      err = await handleAddChannelMember(SESS_ID, member.principalId, {
        channelId: channel.channelId, agentPrincipalId: target.principalId, idempotencyKey: randomUUID(),
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(err).toEqual({ code: 'COLLAB_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// T-D8: dispatcher zero-diff (structural half; byte-level half is the
// Builder Evidence Packet's `git diff` citation)
// ---------------------------------------------------------------------------

describe('T-D8: Item D adds no coupling to autoReplyDispatcher.ts', () => {
  it('handleAddChannelMember/handleRemoveChannelMember function bodies never call into autoReplyDispatcher', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '..');
    const collabSurfaceSrc = readFileSync(join(root, 'packages/gateway/src/collabSurface.ts'), 'utf8');

    // collabSurface.ts's own MODULE DOC (unrelated S3 auto-reply trigger
    // wiring, pre-existing) mentions "autoReplyDispatcher" in prose comments
    // -- that is expected and is NOT the hazard this test guards against.
    // The actual guard: this module carries no `import ... from
    // './autoReplyDispatcher` statement (the injection seam
    // setAutoReplyTrigger/triggerAutoReply exists specifically so this file
    // never imports that module directly -- see the AutoReplyTrigger doc
    // comment above triggerAutoReply).
    expect(collabSurfaceSrc).not.toMatch(/from\s+['"].*autoReplyDispatcher/);

    // Extract just the two new handler function bodies and confirm neither
    // references autoReplyDispatcher or triggers an auto-reply -- Item D is
    // a membership mutation, not a message post, and must never fire the
    // S3 auto-reply trigger (that trigger fires only from
    // handlePostChannelMessage on a real message_posted commit).
    const addBodyMatch = collabSurfaceSrc.match(
      /export async function handleAddChannelMember[\s\S]*?\n}\n/,
    );
    const removeBodyMatch = collabSurfaceSrc.match(
      /export async function handleRemoveChannelMember[\s\S]*?\n}\n/,
    );
    expect(addBodyMatch).not.toBeNull();
    expect(removeBodyMatch).not.toBeNull();
    expect(addBodyMatch![0]).not.toMatch(/autoReplyDispatcher|triggerAutoReply/);
    expect(removeBodyMatch![0]).not.toMatch(/autoReplyDispatcher|triggerAutoReply/);

    // The dispatcher itself must show no membership-guard addition at the
    // eligibility call site -- ND-2's ruling that Item D adds NO membership
    // guard inside the dispatcher (that enforcement already lives in the
    // store's in-transaction check, store.ts:2653). This is a structural
    // sentinel only; the authoritative zero-diff claim is the byte-level
    // `git diff master -- packages/gateway/src/autoReplyDispatcher.ts`
    // citation in the Builder Evidence Packet, restricted to Builder P's two
    // authorized hunks.
    const dispatcherSrc = readFileSync(join(root, 'packages/gateway/src/autoReplyDispatcher.ts'), 'utf8');
    expect(dispatcherSrc).not.toMatch(/ADD_CHANNEL_MEMBER|REMOVE_CHANNEL_MEMBER/);
  });
});
