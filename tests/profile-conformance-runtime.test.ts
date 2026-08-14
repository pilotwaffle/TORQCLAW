import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILE_DEFINITIONS, type ProfileId } from '../packages/contracts/src/profile.js';
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
const DEFINITION_MUTANTS = new Set(['P1b', 'P2-capability', 'P2-side-effect']);

type ContractModule = typeof import('../packages/contracts/src/profile.js');

async function freshPolicyForMutant(mutant: string) {
  vi.resetModules();
  vi.doUnmock('@torqclaw/contracts');
  if (ACTIVE_MUTANT === mutant && DEFINITION_MUTANTS.has(mutant)) {
    const actual = await vi.importActual<ContractModule>('@torqclaw/contracts');
    const definitions = structuredClone(actual.BUILT_IN_PROFILE_DEFINITIONS);
    const expected = structuredClone(actual.BUILT_IN_PROFILE_DEFINITIONS);
    if (mutant === 'P1b') {
      definitions.read_only.allowedCapabilities.push('write');
      definitions.read_only.allowedSideEffects.push('process');
      expected.read_only.allowedCapabilities = ['read', 'write'];
      expected.read_only.allowedSideEffects = ['none', 'process'];
    } else if (mutant === 'P2-capability') {
      definitions.read_only.allowedSideEffects.push('filesystem_write');
      expected.read_only.allowedSideEffects = ['none', 'filesystem_write'];
    } else if (mutant === 'P2-side-effect') {
      definitions.workspace_write.allowedSideEffects = ['none'];
      expected.workspace_write.allowedSideEffects = ['none'];
    }
    expect(definitions, `${mutant} changes only its declared semantic delta`).toEqual(expected);
    vi.doMock('@torqclaw/contracts', () => ({
      ...actual,
      BUILT_IN_PROFILE_DEFINITIONS: definitions,
    }));
  }
  return import('../packages/bridge/src/profilePolicy.js');
}

async function withoutContractMock<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
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

// Mutation-only fresh-module cases intentionally run after every permanent
// static-module assertion. vi.resetModules() therefore cannot split the live
// registry used by the permanent executeTool checks above.
describe('mutation-only conjunct isolation', () => {
  it('P2 namespace conjunct: terminal_power denies an unreviewed write/process tool', async () => {
    await withoutContractMock(async () => {
      const policy = await freshPolicyForMutant('P2-namespace');
      const unreviewed = frozenTool('unreviewed__write', 'write', true);
      const terminal = policy.resolveEffectiveProfile('terminal_power', [unreviewed] as RegisteredTool[]);
      expect(terminal.allowedOperationIds).not.toContain(unreviewed.name);
    });
  });

  it('P2 capability conjunct: read_only denies filesystem write when every other conjunct is admitted', async () => {
    await withoutContractMock(async () => {
      const policy = await freshPolicyForMutant('P2-capability');
      const write = frozenTool('filesystem__write_file', 'write', true);
      const readOnly = policy.resolveEffectiveProfile('read_only', [write] as RegisteredTool[]);
      expect(readOnly.allowedOperationIds).not.toContain(write.name);
    });
  });

  it('P2 side-effect conjunct: workspace_write exposure changes only when filesystem effect is removed', async () => {
    await withoutContractMock(async () => {
      const policy = await freshPolicyForMutant('P2-side-effect');
      const write = frozenTool('filesystem__write_file', 'write', true);
      const workspace = policy.resolveEffectiveProfile('workspace_write', [write] as RegisteredTool[]);
      if (ACTIVE_MUTANT !== 'P2-side-effect') {
        expect(workspace.allowedOperationIds).toContain(write.name);
        return;
      }
      expect(workspace.allowedOperationIds).not.toContain(write.name);
    });
  });
});

describe('P1b control-plane and direct-execution exposure', () => {
  it('P1b control-plane exposure denies shell write under read_only', async () => {
    await withoutContractMock(async () => {
      const policy = await freshPolicyForMutant('P1b');
      const shellWrite = frozenTool('shell__write', 'write', true);
      const readOnly = policy.resolveEffectiveProfile('read_only', [shellWrite] as RegisteredTool[]);
      expect(readOnly.allowedOperationIds).not.toContain(shellWrite.name);
    });
  });

  it('P1b direct-execution denies shell write before client lookup', async () => {
    await withoutContractMock(async () => {
      const policy = await freshPolicyForMutant('P1b');
      const registryModule = await import('../packages/bridge/src/registry.js');
      const shellWrite = { ...frozenTool('shell__write', 'write', true) };
      registryModule.getRegistry().push(shellWrite);
      try {
        const readOnly = policy.resolveEffectiveProfile('read_only');
        await expect(registryModule.executeTool(shellWrite.name, {}, readOnly)).rejects
          .toThrow("outside effective profile 'read_only'");
      } finally {
        registryModule.getRegistry().splice(0, registryModule.getRegistry().length);
      }
    });
  });
});
