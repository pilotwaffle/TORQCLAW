import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyCapability } from '../packages/bridge/src/capability.js';
import {
  assertCurrentPolicy,
  canonicalizePolicy,
  hashPolicyMaterial,
  resolveEffectiveProfile,
} from '../packages/bridge/src/profilePolicy.js';
import { getRegistry, type RegisteredTool } from '../packages/bridge/src/registry.js';
import { ensureApprovalBrokerSchema } from '../packages/gateway/src/approvalSchema.js';
import {
  type ContextHashInput,
  privacyContextHash,
  routingContextHash,
  securityPolicyHash,
} from '../packages/gateway/src/approvalContext.js';
import {
  ApprovalDecisionError,
  decideC2Approval,
  registerC2Approval,
} from '../packages/gateway/src/approvalWriter.js';
import {
  activateSurfaceProjection,
  ensureSurfaceSecuritySchema,
  grantAuthority,
  grantProfileDelegation,
} from '../packages/gateway/src/surfaceSecurity.js';
import { SYNTHETIC_TOOLS, frozenTool, readGolden } from './helpers/profile-conformance.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function material(profile: ReturnType<typeof resolveEffectiveProfile>): Record<string, JsonValue> {
  const { policyHash: _policyHash, ...rest } = profile;
  return rest as unknown as Record<string, JsonValue>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('AC-C2 canonical policy/hash vectors', () => {
  it('AC-C2-0 fixed checked-in UTF-8 preimage and SHA reproduce from live modules', () => {
    const fixed = readGolden().fixedPolicyVector;
    const livePreimage = canonicalizePolicy(material(resolveEffectiveProfile(
      'read_only', SYNTHETIC_TOOLS as readonly RegisteredTool[],
    )));
    expect(fixed.label).toBe('read_only-live-module-v1');
    expect(livePreimage).toBe(fixed.canonicalPreimage);
    expect(sha256(Buffer.from(fixed.canonicalPreimage, 'utf8').toString('utf8'))).toBe(fixed.expectedSha256);
    expect(hashPolicyMaterial(material(resolveEffectiveProfile(
      'read_only', SYNTHETIC_TOOLS as readonly RegisteredTool[],
    )))).toBe(fixed.expectedSha256);
  });

  it('AC-C2-1 material contains exactly the semantic keys and excludes raw definition filters', () => {
    expect(Object.keys(material(resolveEffectiveProfile('workspace_write', SYNTHETIC_TOOLS as readonly RegisteredTool[]))).sort())
      .toEqual([
        'allowedOperationIds', 'allowedTiers', 'approvalRequirements', 'capabilityClasses',
        'operationApprovals', 'operationCapabilities', 'operationSideEffects', 'profileId',
        'profileVersion', 'schemaVersion', 'scopes', 'sideEffectClasses', 'toolRegistryVersion',
      ].sort());
  });

  it('AC-C2-2 object-key reorder is stable while direct array reorder changes the hash', () => {
    expect(hashPolicyMaterial({ b: 2, a: 1 })).toBe(hashPolicyMaterial({ a: 1, b: 2 }));
    expect(hashPolicyMaterial({ ids: ['a', 'b'] })).not.toBe(hashPolicyMaterial({ ids: ['b', 'a'] }));
  });

  it('AC-C2-3 registry order is normalized', () => {
    const a = resolveEffectiveProfile('terminal_power', SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    const b = resolveEffectiveProfile('terminal_power', [...SYNTHETIC_TOOLS].reverse() as RegisteredTool[]);
    expect(a.policyHash).toBe(b.policyHash);
    expect(a).toEqual(b);
  });

  it('AC-C2-4 one copied security field changes hash while the admitted set stays identical', () => {
    const tools = SYNTHETIC_TOOLS.map((tool) => ({ ...tool })) as RegisteredTool[];
    const readToolBaseline = resolveEffectiveProfile('read_only', tools);
    const readFlagChanged = resolveEffectiveProfile('read_only', tools.map((tool) => tool.name === 'websearch__search'
      ? { ...tool, requiresApproval: true } : tool));
    expect(readFlagChanged.allowedOperationIds).toEqual(readToolBaseline.allowedOperationIds);
    expect(readFlagChanged.policyHash).not.toBe(readToolBaseline.policyHash);
  });

  it('AC-C2-5 classifier label and hasher-unit label are independently proven', () => {
    expect(classifyCapability('send_email', undefined, undefined)).toBe('send');
    expect(hashPolicyMaterial({ label: 'send' })).not.toBe(hashPolicyMaterial({ label: 'exec' }));
    expect(readGolden().fixedPolicyVector.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('AC-C2-6 add/drop allowed ID changes hash', () => {
    const baselineTools = SYNTHETIC_TOOLS as readonly RegisteredTool[];
    const baseline = resolveEffectiveProfile('read_only', baselineTools);
    const added = resolveEffectiveProfile('read_only', [...baselineTools, frozenTool('db__read_row', 'read', false)] as RegisteredTool[]);
    const dropped = resolveEffectiveProfile('read_only', baselineTools.filter((tool) => tool.name !== 'websearch__search'));
    expect(added.allowedOperationIds).toHaveLength(baseline.allowedOperationIds.length + 1);
    expect(dropped.allowedOperationIds).toHaveLength(baseline.allowedOperationIds.length - 1);
    expect(added.policyHash).not.toBe(baseline.policyHash);
    expect(dropped.policyHash).not.toBe(baseline.policyHash);
  });

  it('AC-C2-7A assertCurrentPolicy rejects a stale live policy', () => {
    const registry = getRegistry();
    const original = [...registry];
    try {
      registry.splice(0, registry.length, ...SYNTHETIC_TOOLS.map((tool) => ({ ...tool })));
      const profile = resolveEffectiveProfile('read_only');
      registry.push({ ...frozenTool('db__read_row', 'read', false) });
      expect(() => assertCurrentPolicy(profile)).toThrow(/Stale effective profile policy/);
    } finally {
      registry.splice(0, registry.length, ...original);
    }
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'packages', 'gateway', 'db', 'schema.sql'), 'utf8');
const legacySchema = schema.slice(0, schema.indexOf('-- TORQCLAW_RESILIENCE_SCHEMA_BEGIN'));
const principal = 'prn_profile_conformance';
const surface = 'srf_profile_conformance';
const profileId = 'workspace_write';
const policyHash = 'e'.repeat(64);
const registryHash = 'd'.repeat(64);
let openDb: Database.Database | undefined;

afterEach(() => {
  openDb?.close();
  openDb = undefined;
});

function createWriterHarness() {
  const db = new Database(':memory:');
  openDb = db;
  db.pragma('foreign_keys = ON');
  db.exec(legacySchema);
  ensureSurfaceSecuritySchema(db);
  ensureApprovalBrokerSchema(db);
  db.prepare("INSERT INTO sessions (id, role, client_name) VALUES ('s1','operator','profile-conformance')").run();
  db.prepare("INSERT INTO tasks (request_id,session_id,tier,router_reason,state,request_json) VALUES ('req-1','s1','LOCAL_EDGE','test','completed','{}')").run();
  activateSurfaceProjection(db, {
    surfaceId: surface,
    principalId: principal,
    surfaceKind: 'desktop',
    surfaceRole: 'operator',
    allowedCapabilityClasses: ['read', 'write'],
    authEpoch: 1,
    capabilityRevision: 1,
    sourceIdentityRevision: 'profile-conformance-v1',
  });
  grantAuthority(db, surface, 'approve', randomUUID());
  const delegationId = randomUUID();
  grantProfileDelegation(db, {
    delegationId,
    surfaceId: surface,
    profileId,
    profileDelegationRevision: 1,
    profileSchemaVersion: 'torqclaw.effective-profile/v1',
    profileVersion: 1,
    toolRegistryVersion: 'torqclaw.tools/v1',
    effectiveProfilePolicyHash: policyHash,
    registryEnforcementHash: registryHash,
  });
  return { db, delegationId };
}

function context(over: Partial<ContextHashInput> = {}): ContextHashInput {
  return {
    originPrincipalId: principal,
    originSurfaceId: surface,
    sourceRequestId: 'req-1',
    originSurfaceKind: 'desktop',
    profileId,
    toolName: 'filesystem__write_file',
    canonicalArgs: '{"path":"/tmp/x"}',
    privacyContextHash: privacyContextHash({ containsSensitiveData: false }),
    routingContextHash: routingContextHash({ executionMode: 'AUTO', selectedTier: 'OLLAMA_LOCAL', ruleId: null }),
    securityPolicyHash: securityPolicyHash({
      effectiveProfile: {
        schemaVersion: 'torqclaw.effective-profile/v1', profileId, profileVersion: 1,
        toolRegistryVersion: 'torqclaw.tools/v1', effectiveProfilePolicyHash: policyHash,
      },
      capabilityRevision: 1,
      profileDelegationRevision: 1,
      registryEnforcementHash: registryHash,
    }),
    ...over,
  };
}

describe('AC-C2-7B real approval-writer state decision path', () => {
  it('same-state control approves; changed effective-profile hash refuses profile-delegation-stale', () => {
    const { db, delegationId } = createWriterHarness();
    const register = (ctx: ContextHashInput) => {
      const approvalId = randomUUID();
      registerC2Approval(db, {
        approvalId,
        requestId: 'req-1',
        toolName: 'filesystem__write_file',
        canonicalArgs: ctx.canonicalArgs,
        originPrincipalId: principal,
        originSurfaceId: surface,
        contextInput: ctx,
        binding: {
          delegationId,
          profileDelegationRevision: 1,
          registeredProfileId: profileId,
          registeredProfileVersion: 1,
          registeredToolRegistryVersion: 'torqclaw.tools/v1',
          registeredEffectiveProfilePolicyHash: policyHash,
          registeredCapabilityRevision: 1,
          registeredRegistryEnforcementHash: registryHash,
          registeredPrivacyContextHash: ctx.privacyContextHash,
          registeredRoutingContextHash: ctx.routingContextHash,
          registeredSecurityPolicyHash: ctx.securityPolicyHash,
        },
      });
      return approvalId;
    };
    const decide = (approvalId: string, currentContext: ContextHashInput) => decideC2Approval(db, {
      approvalId,
      decision: 'APPROVE',
      decidingPrincipalId: principal,
      decidingSurfaceId: surface,
      currentContext,
      dispatchRequestId: randomUUID(),
      mintDispatchTask: (requestId) => db.prepare(
        "INSERT INTO tasks (request_id,session_id,tier,router_reason,state,request_json) VALUES (?,'s1','LOCAL_EDGE','remint','running','{}')",
      ).run(requestId),
    });

    expect(decide(register(context()), context())?.status).toBe('approved');

    const staleId = register(context());
    db.prepare(`UPDATE gateway_profile_delegations
      SET effective_profile_policy_hash=? WHERE delegation_id=?`).run('a'.repeat(64), delegationId);
    try {
      decide(staleId, context());
      throw new Error('stale delegation must refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalDecisionError);
      expect((error as ApprovalDecisionError).code).toBe('profile-delegation-stale');
    }
    expect(db.prepare('SELECT status FROM tool_approvals WHERE approval_id=?').get(staleId))
      .toEqual({ status: 'pending' });
  });
});
