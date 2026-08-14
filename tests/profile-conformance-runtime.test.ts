import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILE_DEFINITIONS, type ProfileId } from '@torqclaw/contracts';
import { checkPath, extractPaths } from '../packages/bridge/src/pathScope.js';
import {
  assertCurrentPolicy,
  isOperationAllowed,
  resolveEffectiveProfile,
} from '../packages/bridge/src/profilePolicy.js';
import { executeTool, getRegistry, type RegisteredTool } from '../packages/bridge/src/registry.js';
import { getToolsForTask, predictTools } from '../packages/bridge/src/toolFilter.js';
import { constrainTier } from '../packages/gateway/src/profileResolver.js';
import {
  SYNTHETIC_TOOLS,
  declaredAllows,
  frozenTool,
  immutableSnapshot,
  readGolden,
} from './helpers/profile-conformance.js';

let originalRegistry: RegisteredTool[];
const ACTIVE_MUTANT = process.env.TORQ_PROFILE_CONFORMANCE_MUTANT;
const RECOGNIZED_MUTANTS = new Set(['P1b', 'P2-namespace', 'P2-capability', 'P2-side-effect']);
const SOURCE_ALIAS_MUTANTS = new Set(['P1b', 'P2-capability', 'P2-side-effect']);
const SOURCE_MARKER_EXPORT = '__TORQ_PROFILE_CONFORMANCE_SOURCE_MARKER__';
const REQUIRED_POLICY_EXPORTS = [
  'BUILT_IN_PROFILE_DEFINITIONS',
  'EffectiveProfileSchema',
  'PROFILE_CONTRACT_VERSION',
  'ProfileIdSchema',
  'TOOL_REGISTRY_VERSION',
] as const;

if (ACTIVE_MUTANT && !RECOGNIZED_MUTANTS.has(ACTIVE_MUTANT)) {
  throw new Error(`Unknown TORQ_PROFILE_CONFORMANCE_MUTANT '${ACTIVE_MUTANT}'`);
}

type ContractModule = typeof import('../packages/contracts/src/profile.js');
type PolicyModule = typeof import('../packages/bridge/src/profilePolicy.js');
type RegistryModule = typeof import('../packages/bridge/src/registry.js');
type ContractAlias = Pick<ContractModule, typeof REQUIRED_POLICY_EXPORTS[number]> & {
  [SOURCE_MARKER_EXPORT]: Readonly<{ sourceProfilePath: string }>;
};

function normalizedModulePath(url: string): string {
  return fileURLToPath(url).replaceAll('\\', '/');
}

const MODULE_PATHS = Object.freeze({
  builtEntry: normalizedModulePath(new URL('../packages/contracts/dist/index.js', import.meta.url).href),
  sourceProfile: normalizedModulePath(new URL('../packages/contracts/src/profile.ts', import.meta.url).href),
  policyModule: normalizedModulePath(new URL('../packages/bridge/src/profilePolicy.ts', import.meta.url).href),
});
const SOURCE_MARKER = Object.freeze({ sourceProfilePath: MODULE_PATHS.sourceProfile });

function assertRequiredPolicyExports(module: Record<string, unknown>, label: string): void {
  for (const name of REQUIRED_POLICY_EXPORTS) {
    expect(Object.hasOwn(module, name), `${label} provides runtime export ${name}`).toBe(true);
  }
}

async function withFreshSourceContracts<T>(
  run: (modules: {
    contracts: ContractAlias;
    policy: PolicyModule;
    registry: RegistryModule;
  }) => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doUnmock('@torqclaw/contracts');
  try {
    vi.doMock('@torqclaw/contracts', async () => {
      const source = await import('../packages/contracts/src/profile.js');
      assertRequiredPolicyExports(source as unknown as Record<string, unknown>, 'fresh source profile module');
      return Object.freeze({
        BUILT_IN_PROFILE_DEFINITIONS: source.BUILT_IN_PROFILE_DEFINITIONS,
        EffectiveProfileSchema: source.EffectiveProfileSchema,
        PROFILE_CONTRACT_VERSION: source.PROFILE_CONTRACT_VERSION,
        ProfileIdSchema: source.ProfileIdSchema,
        TOOL_REGISTRY_VERSION: source.TOOL_REGISTRY_VERSION,
        [SOURCE_MARKER_EXPORT]: SOURCE_MARKER,
      });
    });
    const contracts = await import('@torqclaw/contracts') as unknown as ContractAlias;
    assertRequiredPolicyExports(contracts as unknown as Record<string, unknown>, 'source-backed package alias');
    expect(contracts[SOURCE_MARKER_EXPORT], 'source alias carries its frozen path marker').toBe(SOURCE_MARKER);
    expect(Object.isFrozen(contracts[SOURCE_MARKER_EXPORT]), 'source path marker is frozen').toBe(true);
    const policy = await import('../packages/bridge/src/profilePolicy.js');
    const registry = await import('../packages/bridge/src/registry.js');
    return await run({ contracts, policy, registry });
  } finally {
    vi.doUnmock('@torqclaw/contracts');
    vi.resetModules();
  }
}

async function withFreshBuiltContracts<T>(
  run: (modules: {
    contracts: Record<string, unknown>;
    policy: PolicyModule;
    registry: RegistryModule;
  }) => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doUnmock('@torqclaw/contracts');
  try {
    const contracts = await import('@torqclaw/contracts') as unknown as Record<string, unknown>;
    assertRequiredPolicyExports(contracts, 'fresh built contracts package');
    expect(Object.hasOwn(contracts, SOURCE_MARKER_EXPORT), 'fresh built package has no source marker').toBe(false);
    const policy = await import('../packages/bridge/src/profilePolicy.js');
    const registry = await import('../packages/bridge/src/registry.js');
    return await run({ contracts, policy, registry });
  } finally {
    vi.doUnmock('@torqclaw/contracts');
    vi.resetModules();
  }
}

beforeEach(() => {
  originalRegistry = [...getRegistry()];
  getRegistry().splice(0, getRegistry().length, ...SYNTHETIC_TOOLS.map((tool) => ({ ...tool })));
});

afterEach(() => {
  getRegistry().splice(0, getRegistry().length, ...originalRegistry);
});

describe('AC-3/AC-4 conjunctive profile admission', () => {
  it('all built-ins match an immutable independently-derived exposure matrix', () => {
    const tools = immutableSnapshot(SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    for (const [profileId, definition] of Object.entries(readGolden().profiles) as [ProfileId, typeof BUILT_IN_PROFILE_DEFINITIONS[ProfileId]][]) {
      const profile = resolveEffectiveProfile(profileId, tools as readonly RegisteredTool[]);
      const expected = tools.filter((tool) => declaredAllows(definition, tool)).map((tool) => tool.name).sort();
      expect(profile.allowedOperationIds, profileId).toEqual(expected);
      for (const tool of tools) expect(isOperationAllowed(profile, tool as RegisteredTool), `${profileId}:${tool.name}`)
        .toBe(expected.includes(tool.name));
    }
  });

  it('a namespace match cannot bypass a capability mismatch', () => {
    const workspace = resolveEffectiveProfile('workspace_write', SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    expect(workspace.allowedOperationIds).toContain('filesystem__write_file');
    expect(workspace.allowedOperationIds).not.toContain('shell__run_command');
    const browser = resolveEffectiveProfile('browser_research', SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    expect(browser.allowedOperationIds).toContain('browser__snapshot');
    expect(browser.allowedOperationIds).not.toContain('browser__click');
    expect(browser.allowedOperationIds).not.toContain('playwright__fill');
  });

  it('matching namespace and capability still require the derived effect', () => {
    const terminal = resolveEffectiveProfile('terminal_power', SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    expect(terminal.allowedOperationIds).toContain('terminal__set_option');
    const workspace = resolveEffectiveProfile('workspace_write', SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    expect(workspace.allowedOperationIds).toContain('filesystem__write_file');
    expect(workspace.allowedOperationIds).not.toContain('unknown__frobnicate');
    expect(workspace.allowedOperationIds).not.toContain('browser__click');
  });

  it('is invariant to registry order and hashes the same immutable snapshot', () => {
    for (const id of Object.keys(BUILT_IN_PROFILE_DEFINITIONS) as ProfileId[]) {
      expect(resolveEffectiveProfile(id, SYNTHETIC_TOOLS as readonly RegisteredTool[]))
        .toEqual(resolveEffectiveProfile(id, [...SYNTHETIC_TOOLS].reverse() as RegisteredTool[]));
    }
  });

  it('task-prefix routing intersects with profile membership', () => {
    const workspace = resolveEffectiveProfile('workspace_write');
    expect(predictTools('ROUTINE_AUTOMATION', workspace)).toEqual([
      'filesystem__read_file', 'filesystem__write_file',
    ]);
    const browser = resolveEffectiveProfile('browser_research');
    expect(predictTools('AUTONOMOUS_RESEARCH', browser)).toEqual([
      'playwright__snapshot', 'websearch__search',
    ]);
  });
});

describe('AC-5 execution-time rechecks and denial boundaries', () => {
  it('an admitted member reaches the actual no-client boundary', async () => {
    const profile = resolveEffectiveProfile('read_only');
    await expect(executeTool('websearch__search', {}, profile)).rejects
      .toThrow("No MCP client connected for server 'websearch'");
  });

  it('denied, unknown, and non-member calls stop before client lookup with explicit reasons', async () => {
    const profile = resolveEffectiveProfile('read_only');
    await expect(executeTool('filesystem__write_file', {}, profile)).rejects
      .toThrow("outside effective profile 'read_only'");
    await expect(executeTool('missing__tool', {}, profile)).rejects.toThrow("Unknown tool 'missing__tool'");
    const forged = { ...profile, allowedOperationIds: [...profile.allowedOperationIds, 'filesystem__write_file'] };
    await expect(executeTool('filesystem__write_file', {}, forged)).rejects
      .toThrow("outside effective profile 'read_only'");
  });

  it('rejects stale live registry/policy by re-resolution before execution', async () => {
    const profile = resolveEffectiveProfile('read_only');
    getRegistry().push({ ...frozenTool('websearch__new_read', 'read', false) });
    expect(() => assertCurrentPolicy(profile)).toThrow("Stale effective profile policy 'read_only'");
    await expect(executeTool('websearch__search', {}, profile)).rejects
      .toThrow("Stale effective profile policy 'read_only'");
  });
});

describe('AC-6 tier constraint and filtering', () => {
  it('rewrites read_only FRONTIER to LOCAL_EDGE with a non-overridable safety lock', () => {
    const profile = resolveEffectiveProfile('read_only');
    const result = constrainTier({ score: 0.99, tier: 'FRONTIER', reason: 'model heuristic' }, profile);
    expect(result.tier).toBe('OLLAMA_LOCAL');
    expect(result.safetyLock).toBe('PROFILE_TIER_CONSTRAINT');
    expect(result.overridable).toBe(false);
    expect(result.reason).toContain('read_only');
    expect(result.blockedAlternatives).toEqual([{ tier: 'FRONTIER', why: "The active profile 'read_only' does not permit this tier." }]);
  });

  it('returns an empty tool offer for a disallowed tier rather than a request error', async () => {
    const profile = resolveEffectiveProfile('read_only');
    const offer = await getToolsForTask('DATA_EXTRACTION', 'FRONTIER', profile);
    expect(offer.openAITools).toEqual([]);
    expect(offer.resolveAlias('anything')).toBe('anything');
    expect(offer.requiresApproval('anything')).toBe(false);
  });
});

describe('AC-7 path semantics (no arbitrary shell/process containment claim)', () => {
  const anchor = process.platform === 'win32' ? 'C:\\' : '/';
  const allowed = join(anchor, 'torq-profile-allowed');
  const outside = join(anchor, 'torq-profile-outside', 'x.txt');
  const blocked = join(allowed, 'blocked', 'x.txt');

  it('covers all seven required extraction/enforcement cases', async () => {
    const readOnly = resolveEffectiveProfile('read_only');
    await expect(executeTool('filesystem__read_file', { path: outside }, readOnly)).rejects
      .toThrow("does not permit filesystem paths"); // extracted + none

    const noScope = { ...frozenTool('filesystem__no_scope', 'write', true) };
    getRegistry().push(noScope);
    const workspaceNoScope = resolveEffectiveProfile('workspace_write');
    await expect(executeTool(noScope.name, { path: outside }, workspaceNoScope)).rejects
      .toThrow('has no configured path scope'); // non-none + missing scope

    expect(checkPath(outside, { write: [] }, 'write')).toBeNull(); // empty is unconstrained
    expect(checkPath(blocked, { write: [], deny: [join(allowed, 'blocked')] }, 'write')).toMatch(/blocked path/); // unless deny
    expect(checkPath(blocked, { write: [allowed], deny: [join(allowed, 'blocked')] }, 'write')).toMatch(/blocked path/); // deny precedence
    expect(extractPaths({ path: outside, filename: blocked }).sort()).toEqual([blocked, outside].sort()); // no common path key skipped
    expect(extractPaths({ artifactLocation: outside })).toEqual([]); // nonstandard without hint missed
    expect(extractPaths({ artifactLocation: outside }, ['artifactLocation'])).toEqual([outside]); // hint checked
  });
});

describe('contract-module provenance controls', () => {
  it('source-backed policy is semantically equivalent for all four profiles and records normalized paths', async () => {
    const tools = immutableSnapshot(SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    const ids = Object.keys(BUILT_IN_PROFILE_DEFINITIONS) as ProfileId[];
    const builtPolicies = Object.fromEntries(ids.map((id) => [id, resolveEffectiveProfile(id, tools)]));
    const builtContracts = await import('@torqclaw/contracts');
    assertRequiredPolicyExports(builtContracts as unknown as Record<string, unknown>, 'built contracts package');

    await withFreshSourceContracts(async ({ contracts, policy }) => {
      expect(contracts.BUILT_IN_PROFILE_DEFINITIONS, 'source and built definitions have the same four-profile snapshot')
        .toEqual(BUILT_IN_PROFILE_DEFINITIONS);
      const sourcePolicies = Object.fromEntries(ids.map((id) => [id, policy.resolveEffectiveProfile(id, tools)]));
      expect(sourcePolicies, 'source-backed and built policies are semantically equal for all four profiles')
        .toEqual(builtPolicies);
    });

    expect(Object.values(MODULE_PATHS).every((path) => !path.includes('\\')), 'module paths are normalized').toBe(true);
    expect(MODULE_PATHS.builtEntry.endsWith('/packages/contracts/dist/index.js')).toBe(true);
    expect(MODULE_PATHS.sourceProfile.endsWith('/packages/contracts/src/profile.ts')).toBe(true);
    expect(MODULE_PATHS.policyModule.endsWith('/packages/bridge/src/profilePolicy.ts')).toBe(true);
    console.log(`PROFILE_CONFORMANCE_MODULE_PATHS ${JSON.stringify(MODULE_PATHS)}`);
  });

  it('source alias cleanup restores marker-free built-package behavior', async () => {
    await withFreshSourceContracts(async ({ contracts }) => {
      expect(Object.hasOwn(contracts, SOURCE_MARKER_EXPORT)).toBe(true);
    });
    await withFreshBuiltContracts(async ({ contracts, policy }) => {
      expect(Object.hasOwn(contracts, SOURCE_MARKER_EXPORT), 'source provenance marker does not leak').toBe(false);
      expect(policy.resolveEffectiveProfile('read_only', SYNTHETIC_TOOLS as readonly RegisteredTool[]))
        .toEqual(resolveEffectiveProfile('read_only', SYNTHETIC_TOOLS as readonly RegisteredTool[]));
    });
  });
});

// Mutation-only fresh-module cases intentionally run after every permanent
// static-module assertion. The package alias is redirected only under the
// three definition-mutant environments, and cleanup always unsets that mock.
describe('mutation-only conjunct isolation', () => {
  it('P2 namespace conjunct: terminal_power denies an unreviewed write/process tool', () => {
    const unreviewed = frozenTool('unreviewed__write', 'write', true);
    const terminal = resolveEffectiveProfile('terminal_power', [unreviewed] as RegisteredTool[]);
    expect(
      terminal.allowedOperationIds,
      'P2_NAMESPACE_DENIAL: terminal_power must exclude unreviewed__write',
    ).not.toContain(unreviewed.name);
  });

  it('P2 capability conjunct: read_only denies filesystem write when every other conjunct is admitted', async () => {
    if (ACTIVE_MUTANT !== 'P2-capability') {
      const write = frozenTool('filesystem__write_file', 'write', true);
      expect(resolveEffectiveProfile('read_only', [write] as RegisteredTool[]).allowedOperationIds).not.toContain(write.name);
      return;
    }
    expect(SOURCE_ALIAS_MUTANTS.has(ACTIVE_MUTANT)).toBe(true);
    await withFreshSourceContracts(async ({ contracts, policy }) => {
      const write = frozenTool('filesystem__write_file', 'write', true);
      const readOnly = policy.resolveEffectiveProfile('read_only', [write] as RegisteredTool[]);
      const setupActive = contracts.BUILT_IN_PROFILE_DEFINITIONS.read_only.allowedSideEffects.includes('filesystem_write');
      expect(
        readOnly.allowedOperationIds,
        setupActive
          ? 'P2_CAPABILITY_DENIAL: read_only capability gate must exclude filesystem__write_file'
          : 'P2_CAPABILITY_BASELINE: unmodified read_only must exclude filesystem__write_file',
      ).not.toContain(write.name);
    });
  });

  it('P2 side-effect conjunct: workspace_write denies filesystem write when only its effect is disallowed', async () => {
    if (ACTIVE_MUTANT !== 'P2-side-effect') {
      const write = frozenTool('filesystem__write_file', 'write', true);
      expect(resolveEffectiveProfile('workspace_write', [write] as RegisteredTool[]).allowedOperationIds).toContain(write.name);
      return;
    }
    expect(SOURCE_ALIAS_MUTANTS.has(ACTIVE_MUTANT)).toBe(true);
    await withFreshSourceContracts(async ({ contracts, policy }) => {
      const write = frozenTool('filesystem__write_file', 'write', true);
      const workspace = policy.resolveEffectiveProfile('workspace_write', [write] as RegisteredTool[]);
      const setupActive = !contracts.BUILT_IN_PROFILE_DEFINITIONS.workspace_write.allowedSideEffects.includes('filesystem_write');
      if (!setupActive) {
        expect(
          workspace.allowedOperationIds,
          'P2_SIDE_EFFECT_BASELINE: unmodified workspace_write must include filesystem__write_file',
        ).toContain(write.name);
        return;
      }
      expect(
        workspace.allowedOperationIds,
        'P2_SIDE_EFFECT_DENIAL: workspace_write effect gate must exclude filesystem__write_file',
      ).not.toContain(write.name);
    });
  });
});

describe('P1b control-plane and direct-execution exposure', () => {
  it('P1b control-plane exposure denies shell write under read_only', async () => {
    const assertDenied = (policy: PolicyModule): void => {
      const shellWrite = frozenTool('shell__write', 'write', true);
      const readOnly = policy.resolveEffectiveProfile('read_only', [shellWrite] as RegisteredTool[]);
      expect(
        readOnly.allowedOperationIds,
        'P1B_CONTROL_DENIAL: read_only control plane must exclude shell__write',
      ).not.toContain(shellWrite.name);
    };
    if (ACTIVE_MUTANT === 'P1b') {
      expect(SOURCE_ALIAS_MUTANTS.has(ACTIVE_MUTANT)).toBe(true);
      await withFreshSourceContracts(async ({ policy }) => assertDenied(policy));
    } else {
      assertDenied({ resolveEffectiveProfile } as PolicyModule);
    }
  });

  it('P1b direct-execution denies shell write before client lookup', async () => {
    const assertDenied = async (policy: PolicyModule, registry: RegistryModule): Promise<void> => {
      const snapshot = [...registry.getRegistry()];
      const shellWrite = { ...frozenTool('shell__write', 'write', true) };
      registry.getRegistry().push(shellWrite);
      try {
        const readOnly = policy.resolveEffectiveProfile('read_only');
        let actualBoundary = 'NO_ERROR';
        try {
          await registry.executeTool(shellWrite.name, {}, readOnly);
        } catch (error) {
          actualBoundary = String(error);
        }
        expect(
          actualBoundary,
          'P1B_DIRECT_DENIAL: read_only execution must stop before shell client lookup',
        ).toContain("outside effective profile 'read_only'");
      } finally {
        registry.getRegistry().splice(0, registry.getRegistry().length, ...snapshot);
      }
    };
    if (ACTIVE_MUTANT === 'P1b') {
      expect(SOURCE_ALIAS_MUTANTS.has(ACTIVE_MUTANT)).toBe(true);
      await withFreshSourceContracts(async ({ policy, registry }) => assertDenied(policy, registry));
    } else {
      await withFreshBuiltContracts(async ({ policy, registry }) => assertDenied(policy, registry));
    }
  });
});
