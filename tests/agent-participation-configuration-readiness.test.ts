/**
 * G1D channels-agent-UX packet (2026-08-24) — Item B(ii) authz + Item C
 * (operator-only readiness roster) test obligations:
 *
 *   N-3 (companion): SET_LOCAL_AGENT_AUTOSTART inherits the exact same
 *     surface authz lattice as CREATE_AGENT/UPDATE_AGENT_PROFILE/LIST_AGENTS
 *     -- operator role + delegate authority, both surface- and store-side.
 *   Obligation 12: the AgentsPanel readiness indicator (configurationReadiness
 *     in handleListAgents) agrees with runtimeProfileAllowsAutomaticTurn
 *     across {local, subscription} x {enabled, parked} x {flag on, off} --
 *     asserted by calling the exact predicate directly, never a re-derived
 *     formula (B-5).
 *   Obligation 13: ChannelMemberEntry / listChannelMembers' returned shape
 *     is structurally byte-identical to the pre-slice shape (B-4(b) --
 *     willRespond was explicitly rejected from that type).
 *   Obligation 15: a local agent created with autostart=false, enabled over
 *     the wire via SET_LOCAL_AGENT_AUTOSTART, becomes eligible for automatic
 *     dispatch -- proven via the real store + the real gateway handler +
 *     the real runtimeProfileAllowsAutomaticTurn predicate the dispatcher
 *     itself calls before ever invoking inference (harness integration).
 *   Obligation 16: targeted gate -- a subscription agent's autostart can
 *     NEVER be flipped by this command, even when it already holds a valid
 *     external-context confirmation (the two writers must never overlap).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ClientCommandSchema } from '@torqclaw/contracts';
import { authorize, type AuthzContext } from '../packages/gateway/src/authz.js';
import { handleSetLocalAgentAutostart, handleListAgents } from '../packages/gateway/src/agentSurface.js';
import { runtimeProfileAllowsAutomaticTurn } from '../packages/gateway/src/autoReplyDispatcher.js';
import type { SubscriptionAgentProfile } from '../packages/gateway/src/subscriptionAgentRuntime.js';
import {
  runAgentAutoreplyMigration,
  runAgentRuntimeProfileMigration,
  runCollaborationMigration,
} from '../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../packages/collab/src/store.js';
import * as collabSurface from '../packages/gateway/src/collabSurface.js';

/**
 * agentSurface.ts's verifyOperator/handleSetLocalAgentAutostart/handleListAgents
 * call getStore() and getCollabDbForAutoReply() directly (not through
 * setCollabSurfaceStoreForTest's storeOverride, which the pre-existing
 * S1/S4 handler tests use for handleListChannels/handleListChannelMembers).
 * getCollabDbForAutoReply() specifically returns the module-private
 * `storeDb`, which setCollabSurfaceStoreForTest deliberately zeroes when a
 * test store override is installed (its own doc comment: "storeDb = null;
 * test callers wire kind-lookup DB access separately") -- so overriding the
 * store alone leaves getCollabDbForAutoReply() returning null and every one
 * of these three handlers' own raw-SQL identity/roster reads failing
 * closed to COLLAB_UNAVAILABLE (discovered exactly that way while building
 * this file). Directly spying on the two exported functions covers both
 * call sites; setCollabSurfaceKindLookupDbForTest (the real exported test
 * seam for this) additionally wires callerFor's principal-kind lookup, so
 * a caller's kind resolves to the fixture's actual 'operator'/'agent' row
 * instead of silently falling back to 'agent' for everyone.
 */
function wireFixtureAsCollabSurfaceStore(db: BootstrapDb, store: CollaborationStore): void {
  vi.spyOn(collabSurface, 'getStore').mockReturnValue(store);
  vi.spyOn(collabSurface, 'getCollabDbForAutoReply').mockReturnValue(db);
  collabSurface.setCollabSurfaceKindLookupDbForTest(db);
}

function unwireFixtureFromCollabSurfaceStore(): void {
  vi.restoreAllMocks();
  collabSurface.setCollabSurfaceKindLookupDbForTest(null);
}

const IDEMPOTENCY_KEY = '123e4567-e89b-42d3-a456-426614174000';

function context(options: { role?: 'operator' | 'agent'; delegate?: boolean; surface?: boolean } = {}): AuthzContext {
  return {
    sessionId: 'session',
    lookupTaskSession: () => null,
    ...(options.surface === false ? {} : {
      surface: {
        surfaceId: 'surface',
        currentRole: () => options.role ?? 'operator',
        holdsAuthority: (authority) => authority === 'delegate' && options.delegate === true,
      },
    }),
  };
}

describe('SET_LOCAL_AGENT_AUTOSTART authorization (N-3 companion)', () => {
  const command = ClientCommandSchema.parse({
    action: 'SET_LOCAL_AGENT_AUTOSTART',
    agentPrincipalId: IDEMPOTENCY_KEY,
    autostart: true,
    idempotencyKey: IDEMPOTENCY_KEY,
  });

  it('requires a live operator-role surface with delegate authority, mirroring CREATE_AGENT/UPDATE_AGENT_PROFILE exactly', () => {
    expect(authorize('operator', command, context({ surface: false })).ok).toBe(false);
    expect(authorize('operator', command, context({ role: 'agent', delegate: true })).ok).toBe(false);
    expect(authorize('operator', command, context({ delegate: false })).ok).toBe(false);
    expect(authorize('operator', command, context({ delegate: true }))).toEqual({ ok: true });
  });

  it('denies the channel and node seat classes outright', () => {
    expect(authorize('channel', command, context({ delegate: true })).ok).toBe(false);
    expect(authorize('node', command, context({ delegate: true })).ok).toBe(false);
  });

  it('rechecks authority at the store-side writer boundary (surface bypass proof)', async () => {
    const refusal = await handleSetLocalAgentAutostart(null, command, () => false);
    expect(refusal).toEqual({ status: 'error', errorCode: 'identity_required' });
  });
});

function fixture(fixtureId: string) {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  runAgentAutoreplyMigration(sqlite);
  runAgentRuntimeProfileMigration(sqlite);
  const db: BootstrapDb = {
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids(fixtureId);
  const bootstrap = bootstrapOperator(
    { db, secretStore: new InMemorySecretStore(), clock, uuids, rng: nodeRandomSource },
    { operatorDisplayName: 'Operator', installationId: `install-${fixtureId}`, schemaVersion: 1 },
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

function localProfile(autostart: boolean): SubscriptionAgentProfile {
  return { providerAccountId: 'ollama-local', adapterId: 'ollama-local', modelId: 'torq-local', autostart };
}

function subscriptionProfile(autostart: boolean, externalContextConfirmed: boolean): SubscriptionAgentProfile {
  return {
    providerAccountId: 'claude-subscription',
    adapterId: 'claude:canonical',
    modelId: 'sonnet',
    autostart,
    externalContextConfirmed,
  };
}

describe('obligation 12 -- readiness predicate parity across the full matrix', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    unwireFixtureFromCollabSurfaceStore();
  });

  it('local x autostart-on is always live regardless of the subscription-execution flag', () => {
    vi.stubEnv('TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED', '1');
    expect(runtimeProfileAllowsAutomaticTurn(localProfile(true))).toBe(true);
    vi.stubEnv('TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED', '0');
    expect(runtimeProfileAllowsAutomaticTurn(localProfile(true))).toBe(true);
  });

  it('local x autostart-off is always parked regardless of the subscription-execution flag', () => {
    vi.stubEnv('TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED', '1');
    expect(runtimeProfileAllowsAutomaticTurn(localProfile(false))).toBe(false);
    vi.stubEnv('TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED', '0');
    expect(runtimeProfileAllowsAutomaticTurn(localProfile(false))).toBe(false);
  });

  it('subscription x autostart-on x confirmed is live ONLY when the execution flag is on', () => {
    vi.stubEnv('TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED', '1');
    expect(runtimeProfileAllowsAutomaticTurn(subscriptionProfile(true, true))).toBe(true);
    vi.stubEnv('TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED', '0');
    expect(runtimeProfileAllowsAutomaticTurn(subscriptionProfile(true, true))).toBe(false);
  });

  it('subscription x autostart-on x unconfirmed is always parked (the stale-binding refusal, obligation 4)', () => {
    vi.stubEnv('TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED', '1');
    expect(runtimeProfileAllowsAutomaticTurn(subscriptionProfile(true, false))).toBe(false);
  });

  it('subscription x autostart-off is always parked regardless of confirmation or flag', () => {
    vi.stubEnv('TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED', '1');
    expect(runtimeProfileAllowsAutomaticTurn(subscriptionProfile(false, true))).toBe(false);
    expect(runtimeProfileAllowsAutomaticTurn(subscriptionProfile(false, false))).toBe(false);
  });

  it('a null profile (no runtime row yet) is always parked', () => {
    expect(runtimeProfileAllowsAutomaticTurn(null)).toBe(false);
  });

  it('handleListAgents.configurationReadiness is derived by calling the SAME exported predicate -- never a parallel formula', async () => {
    const { db, store, operator } = fixture('readiness-parity-handler');
    wireFixtureAsCollabSurfaceStore(db, store);
    const localAgent = await store.createAgent(operator, { displayName: 'Local' }, 'create-local-readiness');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: localAgent.principalId,
      providerAccountId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-local',
      autostart: true,
      externalContextConfirmed: false,
    }, 'seed-local-readiness');

    const parkedSubAgent = await store.createAgent(operator, { displayName: 'Parked sub' }, 'create-parked-sub');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: parkedSubAgent.principalId,
      providerAccountId: 'claude-subscription',
      adapterId: 'claude:canonical',
      modelId: 'sonnet',
      autostart: false,
      externalContextConfirmed: false,
    }, 'seed-parked-sub');

    const publishSpy = vi.spyOn(collabSurface, 'publishCollabSurface');
    const outcome = await handleListAgents(
      IDEMPOTENCY_KEY,
      operator.principalId,
      50,
      () => true,
    );
    expect(outcome).toBeNull();

    const published = publishSpy.mock.calls.find(([, , metadata]) => (metadata as { collabAgents?: boolean }).collabAgents);
    expect(published).toBeDefined();
    const agents = (published![2] as { agents: Array<{ principalId: string; configurationReadiness: 'live' | 'parked' }> }).agents;
    const localEntry = agents.find((a) => a.principalId === localAgent.principalId);
    const parkedEntry = agents.find((a) => a.principalId === parkedSubAgent.principalId);
    expect(localEntry?.configurationReadiness).toBe('live');
    expect(parkedEntry?.configurationReadiness).toBe('parked');

    // Never a parallel formula: re-derive both independently via the same
    // exported predicate the handler itself calls, and require agreement.
    const localProfileFromStore = await store.getAgentRuntimeProfile(operator, { agentPrincipalId: localAgent.principalId });
    const parkedProfileFromStore = await store.getAgentRuntimeProfile(operator, { agentPrincipalId: parkedSubAgent.principalId });
    expect(runtimeProfileAllowsAutomaticTurn(localProfileFromStore as unknown as SubscriptionAgentProfile))
      .toBe(localEntry?.configurationReadiness === 'live');
    expect(runtimeProfileAllowsAutomaticTurn(parkedProfileFromStore as unknown as SubscriptionAgentProfile))
      .toBe(parkedEntry?.configurationReadiness === 'live');
  });
});

describe('obligation 13 -- ChannelMemberEntry stays structurally unmodified (B-4(b))', () => {
  it('listChannelMembers-facing member shape is exactly the six pre-slice keys, no willRespond field', async () => {
    const { store, operator } = fixture('member-shape-probe');
    const channel = await store.createChannel(operator, { name: 'shape-probe' }, 'create-shape-channel');
    const members = await store.listChannelMembers(operator, { channelId: channel.channelId });
    for (const member of members.members) {
      expect(Object.keys(member).sort()).toEqual(
        ['displayName', 'kind', 'principalId', 'role', 'since', 'working'].sort(),
      );
      expect('willRespond' in member).toBe(false);
      expect('configurationReadiness' in member).toBe(false);
      expect('autostart' in member).toBe(false);
    }
  });
});

describe('obligation 15 -- local agent post-creation enablement reaches dispatch eligibility', () => {
  afterEach(() => {
    unwireFixtureFromCollabSurfaceStore();
  });

  it('an autostart=false local agent is parked, then SET_LOCAL_AGENT_AUTOSTART flips it to dispatch-eligible over the real handler + store', async () => {
    const { sqlite, db, store, operator } = fixture('enable-then-dispatch');
    const agent = await store.createAgent(operator, { displayName: 'Newly created' }, 'create-new-local');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-local',
      autostart: false,
      externalContextConfirmed: false,
    }, 'seed-new-local');

    const profileBefore = await store.getAgentRuntimeProfile(operator, { agentPrincipalId: agent.principalId });
    expect(runtimeProfileAllowsAutomaticTurn(profileBefore as unknown as SubscriptionAgentProfile)).toBe(false);

    wireFixtureAsCollabSurfaceStore(db, store);
    const outcome = await handleSetLocalAgentAutostart(
      operator.principalId,
      { agentPrincipalId: agent.principalId, autostart: true, idempotencyKey: 'enable-for-dispatch' },
      () => true,
    );
    expect(outcome.status).toBe('success');

    const profileAfter = await store.getAgentRuntimeProfile(operator, { agentPrincipalId: agent.principalId });
    expect(runtimeProfileAllowsAutomaticTurn(profileAfter as unknown as SubscriptionAgentProfile)).toBe(true);
    expect(sqlite.prepare('SELECT autostart FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?')
      .get(agent.principalId)).toEqual({ autostart: 1 });
  });
});

describe('obligation 16 -- targeted gate: SET_LOCAL_AGENT_AUTOSTART can never move a subscription profile, confirmed or not', () => {
  it('a confirmed subscription profile is rejected exactly like an unconfirmed one', async () => {
    const { sqlite, store, operator } = fixture('subscription-never-writable');
    const agent = await store.createAgent(operator, { displayName: 'Confirmed subscription' }, 'create-confirmed-sub');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'claude-subscription',
      adapterId: 'claude:canonical',
      modelId: 'sonnet',
      autostart: true,
      externalContextConfirmed: true,
      externalContextRuntimeFingerprint: 'a'.repeat(64),
      externalContextExactModelId: 'sonnet',
      externalContextPersonaRevision: 0,
      externalContextPersonaContentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    }, 'seed-confirmed-sub');

    await expect(store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: agent.principalId, autostart: false },
      'confirmed-sub-denied',
      () => true,
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const row = sqlite.prepare(`SELECT autostart, external_context_confirmed AS confirmed
      FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?`).get(agent.principalId);
    expect(row).toEqual({ autostart: 1, confirmed: 1 });
  });
});
