import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(() => {
  originalRegistry = [...getRegistry()];
  getRegistry().splice(0, getRegistry().length, ...SYNTHETIC_TOOLS.map((tool) => ({ ...tool })));
});

afterEach(() => {
  getRegistry().splice(0, getRegistry().length, ...originalRegistry);
});

describe('AC-3/AC-4 conjunctive profile admission', () => {
  it('P2 namespace conjunct: all built-ins match an immutable independently-derived exposure matrix', () => {
    const tools = immutableSnapshot(SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    for (const [profileId, definition] of Object.entries(readGolden().profiles) as [ProfileId, typeof BUILT_IN_PROFILE_DEFINITIONS[ProfileId]][]) {
      const profile = resolveEffectiveProfile(profileId, tools as readonly RegisteredTool[]);
      const expected = tools.filter((tool) => declaredAllows(definition, tool)).map((tool) => tool.name).sort();
      expect(profile.allowedOperationIds, profileId).toEqual(expected);
      for (const tool of tools) expect(isOperationAllowed(profile, tool as RegisteredTool), `${profileId}:${tool.name}`)
        .toBe(expected.includes(tool.name));
    }
  });

  it('P2 capability conjunct: a namespace match cannot bypass a capability mismatch', () => {
    const workspace = resolveEffectiveProfile('workspace_write', SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    expect(workspace.allowedOperationIds).toContain('filesystem__write_file');
    expect(workspace.allowedOperationIds).not.toContain('shell__run_command');
    const browser = resolveEffectiveProfile('browser_research', SYNTHETIC_TOOLS as readonly RegisteredTool[]);
    expect(browser.allowedOperationIds).toContain('browser__snapshot');
    expect(browser.allowedOperationIds).not.toContain('browser__click');
    expect(browser.allowedOperationIds).not.toContain('playwright__fill');
  });

  it('P2 side-effect conjunct: matching namespace and capability still require the derived effect', () => {
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
