import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  AGENT_RUNTIME_PROFILE_MIGRATION_ID,
  runAgentRuntimeProfileMigration,
  runCollaborationMigration,
} from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { CollaborationStore, CollabError, type CallerContext } from '../../packages/collab/src/store.js';

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function consent(modelId: string) {
  return {
    externalContextRuntimeFingerprint: 'a'.repeat(64),
    externalContextExactModelId: modelId,
    externalContextPersonaRevision: 0,
    externalContextPersonaContentSha256: EMPTY_HASH,
  };
}

function fixture() {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  runAgentRuntimeProfileMigration(sqlite);
  const db: BootstrapDb = {
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids('runtime-profile');
  const bootstrap = bootstrapOperator(
    { db, secretStore: new InMemorySecretStore(), clock, uuids, rng: nodeRandomSource },
    { operatorDisplayName: 'Operator', installationId: 'runtime-profile-install', schemaVersion: 1 },
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

describe('agent runtime profiles', () => {
  it('applies an idempotent additive migration with no credential columns', () => {
    const { sqlite } = fixture();
    runAgentRuntimeProfileMigration(sqlite);

    const columns = sqlite.prepare('PRAGMA table_info(collab_agent_runtime_profiles)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'agent_principal_id',
      'provider_account_id',
      'adapter_id',
      'model_id',
      'autostart',
      'created_at',
      'updated_at',
      'external_context_confirmed',
      'external_context_provider_account_id',
      'external_context_model_id',
      'external_context_runtime_fingerprint',
      'external_context_exact_model_id',
      'external_context_persona_revision',
      'external_context_persona_content_sha256',
    ]);
    expect(columns.map((column) => column.name).join(' ')).not.toMatch(/secret|token|credential|cookie/i);
    const ledgerCount = sqlite
      .prepare('SELECT COUNT(*) AS count FROM collab_schema_migrations WHERE id = ?')
      .get(AGENT_RUNTIME_PROFILE_MIGRATION_ID) as { count: number };
    expect(ledgerCount.count).toBe(1);
    const personaColumns = sqlite.prepare('PRAGMA table_info(collab_agent_personas)').all() as Array<{ name: string }>;
    expect(personaColumns.map((column) => column.name)).toContain('revision');
  });

  it('uses persona revision CAS and revokes external consent when directives change', async () => {
    const { sqlite, store, operator } = fixture();
    const agent = await store.createAgent(operator, { displayName: 'Reviewer' }, 'persona-agent');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'claude-subscription',
      adapterId: 'claude:canonical',
      modelId: 'sonnet',
      autostart: true,
      externalContextConfirmed: true,
      ...consent('sonnet'),
    }, 'persona-runtime');
    const first = await store.upsertAgentPersona(operator, {
      agentPrincipalId: agent.principalId,
      iconId: 'code',
      systemDirectives: 'Review carefully.\nCite evidence.\t',
      expectedRevision: 0,
    }, 'persona-first', () => true);
    expect(first.revision).toBe(1);
    expect(sqlite.prepare(`SELECT external_context_confirmed AS confirmed,
      external_context_provider_account_id AS providerId,
      external_context_model_id AS modelId
      FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?`).get(agent.principalId))
      .toEqual({ confirmed: 0, providerId: null, modelId: null });

    const second = await store.upsertAgentPersona(operator, {
      agentPrincipalId: agent.principalId,
      iconId: 'shield',
      systemDirectives: first.systemDirectives,
      expectedRevision: 1,
    }, 'persona-second', () => true);
    expect(second.revision).toBe(2);
    await expect(store.upsertAgentPersona(operator, {
      agentPrincipalId: agent.principalId,
      iconId: 'target',
      systemDirectives: 'Stale overwrite',
      expectedRevision: 1,
    }, 'persona-stale', () => true)).rejects.toMatchObject({ code: 'PERSONA_REVISION_CONFLICT' });
    await expect(store.upsertAgentPersona(operator, {
      agentPrincipalId: agent.principalId,
      iconId: 'target',
      systemDirectives: 'unsafe\u202Etext',
      expectedRevision: 2,
    }, 'persona-unsafe', () => true)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('atomically derives exact persona consent on explicit reconsent and replays before live recheck', async () => {
    const { sqlite, store, operator } = fixture();
    const agent = await store.createAgent(operator, { displayName: 'External reviewer' }, 'reconsent-agent');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'qwen-subscription',
      adapterId: 'qwen-subscription:canonical',
      modelId: 'qwen3.8-max-preview',
      autostart: false,
      externalContextConfirmed: false,
    }, 'reconsent-runtime');
    const body = {
      agentPrincipalId: agent.principalId,
      iconId: 'search' as const,
      systemDirectives: 'Use primary evidence.',
      expectedRevision: 0,
      reconfirmExternalContext: true,
      externalContextRuntimeFingerprint: 'b'.repeat(64),
      externalContextExactModelId: 'qwen3.8-max-preview',
    };
    const first = await store.upsertAgentPersona(operator, body, 'reconsent-persona', () => true);
    expect(first.revision).toBe(1);
    expect(sqlite.prepare(`SELECT autostart,
      external_context_confirmed AS confirmed,
      external_context_persona_revision AS personaRevision,
      external_context_persona_content_sha256 AS personaHash
      FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?`).get(agent.principalId)).toEqual({
      autostart: 1,
      confirmed: 1,
      personaRevision: 1,
      personaHash: createHash('sha256').update(body.systemDirectives).digest('hex'),
    });

    sqlite.prepare(`UPDATE collab_agent_runtime_profiles
      SET external_context_runtime_fingerprint = ? WHERE agent_principal_id = ?`)
      .run('c'.repeat(64), agent.principalId);
    expect(await store.upsertAgentPersona(operator, body, 'reconsent-persona', () => true)).toEqual(first);
    expect(sqlite.prepare(`SELECT external_context_runtime_fingerprint AS fingerprint
      FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?`).get(agent.principalId))
      .toEqual({ fingerprint: 'c'.repeat(64) });
    await expect(store.upsertAgentPersona(operator, body, 'reconsent-fresh', () => true))
      .rejects.toMatchObject({ code: 'PERSONA_REVISION_CONFLICT' });
  });

  it('upserts and reads an owned agent profile while preserving normalized, secret-free data', async () => {
    const { sqlite, store, operator } = fixture();
    const agent = await store.createAgent(operator, { displayName: 'Builder' }, 'create-builder');
    const result = await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: `  ${agent.principalId}  `,
      providerAccountId: '  claude-subscription  ',
      adapterId: ' acp-claude ',
      modelId: ' claude-opus-4-1 ',
      autostart: true,
      externalContextConfirmed: true,
      ...consent('claude-opus-4-1'),
    }, 'profile-1');

    expect(result).toMatchObject({
      agentPrincipalId: agent.principalId,
      providerAccountId: 'claude-subscription',
      adapterId: 'acp-claude',
      modelId: 'claude-opus-4-1',
      autostart: true,
      externalContextConfirmed: true,
      ...consent('claude-opus-4-1'),
    });
    expect(await store.getAgentRuntimeProfile(operator, { agentPrincipalId: agent.principalId })).toEqual(result);
    const storedReceipt = sqlite
      .prepare("SELECT result_json FROM collab_mutation_results WHERE command = 'UPSERT_AGENT_RUNTIME_PROFILE'")
      .get() as { result_json: string };
    expect(storedReceipt.result_json).not.toMatch(/secret|token|credential|cookie/i);
  });

  it('replays the same key without rewriting and conflicts on a changed body', async () => {
    const { store, operator } = fixture();
    const agent = await store.createAgent(operator, { displayName: 'Planner' }, 'create-planner');
    const body = {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'codex-subscription',
      adapterId: 'acp-codex',
      modelId: 'gpt-5.6',
      autostart: false,
      externalContextConfirmed: false,
    };
    const first = await store.upsertAgentRuntimeProfile(operator, body, 'profile-replay');
    expect(await store.upsertAgentRuntimeProfile(operator, body, 'profile-replay')).toEqual(first);
    await expect(store.upsertAgentRuntimeProfile(
      operator,
      { ...body, modelId: 'gpt-5.6-luna' },
      'profile-replay',
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('denies agent callers and non-owned targets without changing profile rows', async () => {
    const { sqlite, store, operator } = fixture();
    const callerAgent = await store.createAgent(operator, { displayName: 'Caller' }, 'create-caller');
    const targetAgent = await store.createAgent(operator, { displayName: 'Target' }, 'create-target');
    const agentCaller: CallerContext = { principalId: callerAgent.principalId, kind: 'agent' };
    const body = {
      agentPrincipalId: targetAgent.principalId,
      providerAccountId: 'local',
      adapterId: 'ollama',
      modelId: 'torq-local',
      autostart: false,
      externalContextConfirmed: false,
    };

    await expect(store.upsertAgentRuntimeProfile(agentCaller, body, 'agent-denied')).rejects.toBeInstanceOf(CollabError);
    sqlite.prepare('UPDATE principals SET owner_principal_id = ? WHERE id = ?')
      .run(callerAgent.principalId, targetAgent.principalId);
    await expect(store.upsertAgentRuntimeProfile(operator, body, 'owner-denied')).rejects.toMatchObject({
      code: 'COLLAB_NOT_PERMITTED',
    });
    const count = sqlite.prepare('SELECT COUNT(*) AS count FROM collab_agent_runtime_profiles').get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('rejects an operator principal as an agent target', async () => {
    const { store, operator } = fixture();
    await expect(store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: operator.principalId,
      providerAccountId: 'local',
      adapterId: 'ollama',
      modelId: 'torq-local',
      autostart: false,
      externalContextConfirmed: false,
    }, 'operator-target')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('fails closed on external autostart without provider/model-bound confirmation', async () => {
    const { store, operator } = fixture();
    const agent = await store.createAgent(operator, { displayName: 'External' }, 'create-external');
    await expect(store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'claude-subscription',
      adapterId: 'claude:canonical',
      modelId: 'sonnet',
      autostart: true,
      externalContextConfirmed: false,
    }, 'external-unconfirmed')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('clears the durable acknowledgement when provider/model selection changes', async () => {
    const { sqlite, store, operator } = fixture();
    const agent = await store.createAgent(operator, { displayName: 'Bound' }, 'create-bound');
    await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'claude-subscription',
      adapterId: 'claude:canonical',
      modelId: 'sonnet',
      autostart: true,
      externalContextConfirmed: true,
      ...consent('sonnet'),
    }, 'bound-first');
    const changed = await store.upsertAgentRuntimeProfile(operator, {
      agentPrincipalId: agent.principalId,
      providerAccountId: 'codex-subscription',
      adapterId: 'codex:canonical',
      modelId: 'gpt-5.6-luna',
      autostart: false,
      externalContextConfirmed: false,
    }, 'bound-changed');
    expect(changed.externalContextConfirmed).toBe(false);
    expect(sqlite.prepare(`SELECT external_context_provider_account_id AS providerId,
      external_context_model_id AS modelId FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?`)
      .get(agent.principalId)).toEqual({ providerId: null, modelId: null });
  });

  it('provisions suspended/autostart-off and activates atomically only after memberships succeed', async () => {
    const { sqlite, store, operator } = fixture();
    const channel = await store.createChannel(operator, { name: 'Atomic room' }, 'atomic-channel');
    sqlite.exec(`
      CREATE TRIGGER assert_profile_principal_suspended
      BEFORE INSERT ON collab_agent_runtime_profiles
      WHEN (SELECT status FROM principals WHERE id = NEW.agent_principal_id) <> 'suspended'
        OR NEW.autostart <> 0
      BEGIN SELECT RAISE(ABORT, 'agent must begin suspended with autostart disabled'); END;
      CREATE TRIGGER assert_membership_principal_suspended
      BEFORE INSERT ON collab_members
      WHEN NEW.role = 'agent'
        AND (SELECT status FROM principals WHERE id = NEW.principal_id) <> 'suspended'
      BEGIN SELECT RAISE(ABORT, 'agent membership must be staged while suspended'); END;
    `);
    const result = await store.provisionAgent(operator, {
      displayName: 'Atomic Worker',
      providerAccountId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-local',
      autostart: true,
      externalContextConfirmed: false,
      channelIds: [channel.channelId],
    }, 'atomic-agent', () => true);
    expect(result).toMatchObject({ status: 'active', autostart: true });
    expect(sqlite.prepare('SELECT status FROM principals WHERE id = ?').get(result.agentPrincipalId))
      .toEqual({ status: 'active' });
    expect(sqlite.prepare('SELECT autostart FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?')
      .get(result.agentPrincipalId)).toEqual({ autostart: 1 });
  });

  it('rolls back every provisioning row on membership failure and denies revoked live authority', async () => {
    const { sqlite, store, operator } = fixture();
    let authorityChecks = 0;
    await expect(store.provisionAgent(operator, {
      displayName: 'Denied Worker',
      providerAccountId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-local',
      autostart: false,
      externalContextConfirmed: false,
      channelIds: [],
    }, 'denied-agent', () => { authorityChecks += 1; return false; }))
      .rejects.toMatchObject({ code: 'COLLAB_NOT_PERMITTED' });
    expect(authorityChecks).toBe(1);

    await expect(store.provisionAgent(operator, {
      displayName: 'Rollback Worker',
      providerAccountId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-local',
      autostart: true,
      externalContextConfirmed: false,
      channelIds: ['missing-channel'],
    }, 'rollback-agent', () => true)).rejects.toBeInstanceOf(CollabError);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM principals WHERE display_name IN ('Denied Worker','Rollback Worker')")
      .get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM collab_agent_runtime_profiles').get())
      .toEqual({ count: 0 });
  });
});
