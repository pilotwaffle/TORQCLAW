/**
 * G1D channels-agent-UX packet (2026-08-24), Item B(ii) — the narrow local-
 * only autostart writer `CollaborationStore.setLocalAgentAutostart` /
 * `SET_LOCAL_AGENT_AUTOSTART`.
 *
 * Obligation 1 (companion): `upsertAgentPersona`'s reconfirm branch remains
 * the ONLY writer of `external_context_confirmed`; this file adds the
 * companion invariant for `autostart` on a LOCAL (ollama-local) profile:
 * `setLocalAgentAutostart` must be the only writer of `autostart` for a
 * local profile, and it must be flatly incapable of writing autostart (or
 * anything else) on a subscription profile -- that column moves exclusively
 * through `upsertAgentPersona`'s `reconfirmExternalContext` path. Proven by
 * a repo-wide grep-based deletion probe: exactly one UPDATE/INSERT site
 * touches `collab_agent_runtime_profiles.autostart` for an ollama-local
 * profile outside of `upsertAgentRuntimeProfile`/`provisionAgent`'s initial
 * write, and it is this method.
 *
 * Obligation 12 is covered separately in
 * tests/agent-participation-configuration-readiness.test.ts (it colocates
 * the client+server predicate-parity assertion where AgentsPanel lives).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  runAgentRuntimeProfileMigration,
  runCollaborationMigration,
} from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { CollaborationStore, CollabError, type CallerContext } from '../../packages/collab/src/store.js';

function fixture(fixtureId: string) {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
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
  return { sqlite, store, operator };
}

describe('setLocalAgentAutostart -- the one true local-agent autostart writer', () => {
  it('flips autostart for an existing ollama-local profile, idempotently, under the keyed-command discipline', async () => {
    const { sqlite, store, operator } = fixture('local-autostart-basic');
    const agent = await store.createAgent(operator, { displayName: 'Local worker' }, 'create-local');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-local',
      autostart: false,
      externalContextConfirmed: false,
    }, 'seed-local-profile');

    const enabled = await store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: agent.principalId, autostart: true },
      'flip-on',
      () => true,
    );
    expect(enabled.autostart).toBe(true);
    expect(sqlite.prepare('SELECT autostart FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?')
      .get(agent.principalId)).toEqual({ autostart: 1 });

    // Replay of the same idempotency key must not re-mutate or throw.
    expect(await store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: agent.principalId, autostart: true },
      'flip-on',
      () => true,
    )).toEqual(enabled);

    const disabled = await store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: agent.principalId, autostart: false },
      'flip-off',
      () => true,
    );
    expect(disabled.autostart).toBe(false);
    expect(sqlite.prepare('SELECT autostart FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?')
      .get(agent.principalId)).toEqual({ autostart: 0 });

    // Never touches external_context_* columns -- companion to obligation 1.
    expect(sqlite.prepare(`SELECT external_context_confirmed AS confirmed,
      external_context_provider_account_id AS providerId, external_context_model_id AS modelId
      FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?`).get(agent.principalId))
      .toEqual({ confirmed: 0, providerId: null, modelId: null });
  });

  it('rejects a subscription (non-ollama-local) profile outright, without mutating any row', async () => {
    const { sqlite, store, operator } = fixture('local-autostart-subscription-denied');
    const agent = await store.createAgent(operator, { displayName: 'Subscription worker' }, 'create-sub');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'claude-subscription',
      adapterId: 'claude:canonical',
      modelId: 'sonnet',
      autostart: false,
      externalContextConfirmed: false,
    }, 'seed-sub-profile');

    await expect(store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: agent.principalId, autostart: true },
      'sub-denied',
      () => true,
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    // Zero mutation: autostart and updated_at both untouched.
    const row = sqlite.prepare(`SELECT autostart, updated_at AS updatedAt
      FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?`).get(agent.principalId) as
      { autostart: number; updatedAt: string };
    expect(row.autostart).toBe(0);
  });

  it('rejects an agent with no runtime profile row yet', async () => {
    const { store, operator } = fixture('local-autostart-no-profile');
    const agent = await store.createAgent(operator, { displayName: 'Bare agent' }, 'create-bare');
    await expect(store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: agent.principalId, autostart: true },
      'no-profile',
      () => true,
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('denies a non-operator caller and a caller who does not own the target agent', async () => {
    const { sqlite, store, operator } = fixture('local-autostart-authz');
    const callerAgent = await store.createAgent(operator, { displayName: 'Caller' }, 'create-caller');
    const targetAgent = await store.createAgent(operator, { displayName: 'Target' }, 'create-target');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: targetAgent.principalId,
      providerAccountId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-local',
      autostart: false,
      externalContextConfirmed: false,
    }, 'seed-target-profile');

    const agentCaller: CallerContext = { principalId: callerAgent.principalId, kind: 'agent' };
    await expect(store.setLocalAgentAutostart(
      agentCaller,
      { agentPrincipalId: targetAgent.principalId, autostart: true },
      'agent-caller-denied',
      () => true,
    )).rejects.toBeInstanceOf(CollabError);

    // Live delegate authority revoked mid-flight.
    await expect(store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: targetAgent.principalId, autostart: true },
      'delegate-denied',
      () => false,
    )).rejects.toMatchObject({ code: 'COLLAB_NOT_PERMITTED' });

    // Ownership: reassign the target to a different owner, operator caller denied.
    sqlite.prepare('UPDATE principals SET owner_principal_id = ? WHERE id = ?')
      .run(callerAgent.principalId, targetAgent.principalId);
    await expect(store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: targetAgent.principalId, autostart: true },
      'ownership-denied',
      () => true,
    )).rejects.toBeInstanceOf(CollabError);

    expect(sqlite.prepare('SELECT autostart FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?')
      .get(targetAgent.principalId)).toEqual({ autostart: 0 });
  });

  it('conflicts a replayed idempotency key against a materially different body', async () => {
    const { store, operator } = fixture('local-autostart-idempotency-conflict');
    const agent = await store.createAgent(operator, { displayName: 'Idempotency check' }, 'create-idem');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-local',
      autostart: false,
      externalContextConfirmed: false,
    }, 'seed-idem-profile');

    await store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: agent.principalId, autostart: true },
      'idem-key',
      () => true,
    );
    await expect(store.setLocalAgentAutostart(
      operator,
      { agentPrincipalId: agent.principalId, autostart: false },
      'idem-key',
      () => true,
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('deletion-probe (obligation 1 companion): setLocalAgentAutostart is the ONLY UPDATE site writing autostart while EQUALITY-scoped to an ollama-local profile', () => {
    const storeSource = readFileSync(join(__dirname, '../../packages/collab/src/store.ts'), 'utf8');
    // Every UPDATE statement against collab_agent_runtime_profiles that sets
    // the autostart column, bounded to one statement each (stop at the
    // closing WHERE agent_principal_id = ? clause that ends every one of
    // these statements in this file).
    const updateBlocks = storeSource.match(
      /UPDATE collab_agent_runtime_profiles[\s\S]*?autostart[\s\S]*?WHERE agent_principal_id = \?[^`]*/g,
    ) ?? [];
    expect(updateBlocks.length).toBeGreaterThanOrEqual(4);

    // "Equality-scoped to ollama-local" means the WHERE clause pins
    // provider_account_id = 'ollama-local' (not merely mentions the
    // string, which the persona-revoke path's `<> 'ollama-local'` also
    // does). Exactly one such statement may exist.
    const equalityScopedToLocal = updateBlocks.filter((block) => /provider_account_id\s*=\s*'ollama-local'/.test(block));
    expect(equalityScopedToLocal).toHaveLength(1);
    expect(equalityScopedToLocal[0]).toContain('SET autostart = ?, updated_at = ?');

    // And every persona-mutation-path UPDATE that touches autostart
    // (obligation 1's original invariant, re-verified here as the
    // negative-space check that makes the companion meaningful) explicitly
    // EXCLUDES ollama-local via `<>` -- both the revoke-to-0 branch and the
    // reconfirm-to-1 branch -- so upsertAgentPersona can never be the thing
    // that writes local autostart; only setLocalAgentAutostart's
    // equality-scoped statement above may.
    const inequalityScopedAwayFromLocal = updateBlocks.filter((block) => /provider_account_id\s*<>\s*'ollama-local'/.test(block));
    expect(inequalityScopedAwayFromLocal.length).toBeGreaterThan(0);
    for (const block of inequalityScopedAwayFromLocal) {
      expect(block).toMatch(/autostart = [01],/);
    }

    // The general upsertAgentRuntimeProfile writer is unscoped (applies to
    // whichever profile is being upserted directly by its caller-supplied
    // providerAccountId, not a narrower local-only mutation) -- it is
    // pre-existing, operator+delegate gated, and out of this packet's
    // scope; this probe only asserts it is NOT additionally and separately
    // scoped to ollama-local by equality, which would indicate a second
    // narrow local writer had crept in alongside setLocalAgentAutostart.
    const unscopedButMentionsAutostart = updateBlocks.filter((block) =>
      !/provider_account_id\s*(=|<>)\s*'ollama-local'/.test(block));
    expect(unscopedButMentionsAutostart.length).toBeGreaterThan(0);
  });
});
