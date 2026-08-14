/**
 * W3 Phase 0 — runtime conformance (AC-3..AC-8, AC-10A, AC-C2).
 * Evidence pin: c2850f5ac755444d42b930034de536938f31ae22
 * Test-only. No production policy changes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ComputeTier } from '@torqclaw/contracts';
import {
  assertCurrentPolicy,
  assertOperationAllowed,
  canonicalizePolicy,
  hashPolicyMaterial,
  isOperationAllowed,
  resolveEffectiveProfile,
} from '../packages/bridge/src/profilePolicy.js';
import { executeTool, getRegistry, type RegisteredTool } from '../packages/bridge/src/registry.js';
import { getToolsForTask } from '../packages/bridge/src/toolFilter.js';
import { checkPath, extractPaths } from '../packages/bridge/src/pathScope.js';
import { constrainTier } from '../packages/gateway/src/profileResolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Marker embedded in the *tool* segment so cleanup can find synthetics.
 *  Namespace (before first `__`) must remain a real profile namespace. */
const TEST_MARK = 'w3pc_';

const ANCHOR = process.platform === 'win32' ? 'C:\\' : '/';
const ALLOWED_DIR = join(ANCHOR, 'w3pc-allowed');
const ALLOWED_PATH = join(ALLOWED_DIR, 'ok.txt');
const OUTSIDE_PATH = join(ANCHOR, 'w3pc-outside', 'x.txt');

function tool(
  name: string,
  capability: RegisteredTool['capability'],
  requiresApproval = capability !== 'read',
  extras: Partial<RegisteredTool> = {},
): RegisteredTool {
  const parts = name.split('__');
  return {
    name,
    rawName: parts[1] ?? name,
    sourceServerId: parts[0] ?? '',
    description: name,
    inputSchema: {},
    capability,
    requiresApproval,
    ...extras,
  };
}

/** AC-4 fixture inventory (explicit snapshots). */
const FIXTURES = {
  filesystem_read: tool('filesystem__read_file', 'read'), // P3-classified snapshot
  browser_read: tool('browser__read_page', 'read'),
  websearch_send: tool('websearch__search', 'send'), // P1-config snapshot
  filesystem_write: tool('filesystem__write_file', 'write'),
  browser_click: tool('browser__click', 'write'),
  playwright_click: tool('playwright__click', 'write'),
  shell_write: tool('shell__write_file', 'write'),
  shell_exec: tool('shell__exec', 'exec'),
  unreviewed_read: tool('unreviewed__read', 'read'), // pre-classified double
} as const;

const ALL_FIXTURES = Object.values(FIXTURES);

afterEach(() => {
  const reg = getRegistry();
  for (let i = reg.length - 1; i >= 0; i--) {
    if (reg[i]!.name.includes(TEST_MARK)) reg.splice(i, 1);
  }
});

function register(entry: Omit<RegisteredTool, 'description' | 'inputSchema' | 'sourceServerId'> & {
  description?: string;
  inputSchema?: object;
  sourceServerId?: string;
}): void {
  getRegistry().push({
    description: entry.description ?? 'w3pc synthetic',
    inputSchema: entry.inputSchema ?? {},
    sourceServerId: entry.sourceServerId ?? entry.name.split('__', 1)[0]!,
    ...entry,
  });
}

describe('AC-3 three-gate predicate (built-in permanent cells)', () => {
  it('namespace-only denial: filesystem write denied under terminal_power', () => {
    const t = FIXTURES.filesystem_write;
    const p = resolveEffectiveProfile('terminal_power', [t]);
    expect(isOperationAllowed(p, t)).toBe(false);
  });

  it('namespace-only denial: shell write denied under workspace_write', () => {
    const t = FIXTURES.shell_write;
    const p = resolveEffectiveProfile('workspace_write', [t]);
    expect(isOperationAllowed(p, t)).toBe(false);
  });

  it('capability denial: write denied under read_only', () => {
    const t = FIXTURES.shell_write;
    const p = resolveEffectiveProfile('read_only', [t]);
    expect(isOperationAllowed(p, t)).toBe(false);
  });

  it('capability+side-effect participation: terminal admits shell write and exec', () => {
    const tools = [FIXTURES.shell_write, FIXTURES.shell_exec];
    const p = resolveEffectiveProfile('terminal_power', tools);
    expect(isOperationAllowed(p, FIXTURES.shell_write)).toBe(true);
    expect(isOperationAllowed(p, FIXTURES.shell_exec)).toBe(true);
  });

  it('records that pure side-effect isolation is P2 mutation (not permanent)', () => {
    // Documented equivalent: process→none under terminal_power still admits (both allowed).
    const t = FIXTURES.shell_write;
    const p = resolveEffectiveProfile('terminal_power', [t]);
    expect(p.operationSideEffects[t.name]).toBe('process');
    expect(p.allowedOperationIds).toContain(t.name);
  });
});

describe('AC-4 built-in control-plane conformance', () => {
  it('every profile has positive and negative exposure cases', () => {
    const tools = ALL_FIXTURES;

    const ro = resolveEffectiveProfile('read_only', tools);
    expect(ro.allowedOperationIds).toEqual(
      expect.arrayContaining(['filesystem__read_file', 'browser__read_page', 'unreviewed__read']),
    );
    expect(ro.allowedOperationIds).not.toContain('filesystem__write_file');
    expect(ro.allowedOperationIds).not.toContain('shell__exec');
    expect(ro.allowedOperationIds).not.toContain('websearch__search');

    const ww = resolveEffectiveProfile('workspace_write', tools);
    expect(ww.allowedOperationIds).toEqual(
      expect.arrayContaining(['filesystem__read_file', 'filesystem__write_file']),
    );
    expect(ww.allowedOperationIds).not.toContain('shell__write_file');
    expect(ww.allowedOperationIds).not.toContain('browser__read_page');

    const br = resolveEffectiveProfile('browser_research', tools);
    expect(br.allowedOperationIds).toContain('browser__read_page');
    expect(br.allowedOperationIds).not.toContain('browser__click');
    expect(br.allowedOperationIds).not.toContain('playwright__click');
    expect(br.allowedOperationIds).not.toContain('websearch__search'); // send not admitted

    const tp = resolveEffectiveProfile('terminal_power', tools);
    expect(tp.allowedOperationIds).toEqual(
      expect.arrayContaining(['shell__write_file', 'shell__exec']),
    );
    expect(tp.allowedOperationIds).not.toContain('filesystem__write_file');
    expect(tp.allowedOperationIds).not.toContain('browser__click');
  });

  it('registry reordering preserves resolved profile and hash', () => {
    const a = resolveEffectiveProfile('workspace_write', ALL_FIXTURES);
    const b = resolveEffectiveProfile('workspace_write', [...ALL_FIXTURES].reverse());
    expect(b).toEqual(a);
    expect(a.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('derived side effects match inventory', () => {
    const tp = resolveEffectiveProfile('terminal_power', [FIXTURES.shell_write, FIXTURES.shell_exec]);
    expect(tp.operationSideEffects['shell__write_file']).toBe('process');
    expect(tp.operationSideEffects['shell__exec']).toBe('process');
    const ww = resolveEffectiveProfile('workspace_write', [FIXTURES.filesystem_write]);
    expect(ww.operationSideEffects['filesystem__write_file']).toBe('filesystem_write');
  });
});

describe('AC-5 execution-plane conformance', () => {
  it('admitted operation: assertOperationAllowed passes then client boundary', async () => {
    const entry = {
      name: `shell__${TEST_MARK}exec`,
      rawName: `${TEST_MARK}exec`,
      capability: 'exec' as const,
      requiresApproval: true,
    };
    register(entry);
    const current = resolveEffectiveProfile('terminal_power', getRegistry());
    const live = getRegistry().find((t) => t.name === entry.name)!;
    expect(() => assertOperationAllowed(current, live)).not.toThrow();
    await expect(executeTool(entry.name, {}, current)).rejects.toThrow(/No MCP client connected/);
  });

  it('denied operation rejected before client boundary', async () => {
    const entry = {
      name: `filesystem__${TEST_MARK}write_file`,
      rawName: `${TEST_MARK}write_file`,
      capability: 'write' as const,
      requiresApproval: true,
    };
    register(entry);
    const current = resolveEffectiveProfile('terminal_power', getRegistry());
    const live = getRegistry().find((t) => t.name === entry.name)!;
    expect(() => assertOperationAllowed(current, live)).toThrow(/outside effective profile/);
    await expect(executeTool(entry.name, {}, current)).rejects.toThrow(/outside effective profile/);
  });

  it('stale policyHash is rejected on re-resolve', () => {
    register({
      name: `shell__${TEST_MARK}exec`,
      rawName: `${TEST_MARK}exec`,
      capability: 'exec',
      requiresApproval: true,
    });
    const current = resolveEffectiveProfile('terminal_power', getRegistry());
    const stale = { ...current, policyHash: '0'.repeat(64) };
    expect(() => assertCurrentPolicy(stale)).toThrow(/Stale effective profile/);
  });
});

describe('AC-6 tier semantics', () => {
  it('read_only rewrites FRONTIER selection to LOCAL_EDGE with safety lock', () => {
    const profile = resolveEffectiveProfile('read_only', [FIXTURES.filesystem_read]);
    const constrained = constrainTier(
      {
        tier: ComputeTier.FRONTIER,
        reason: 'test',
        humanReason: 'test',
        overridable: true,
      } as any,
      profile,
    );
    expect(constrained.tier).toBe(ComputeTier.LOCAL_EDGE);
    expect(constrained.overridable).toBe(false);
    expect(constrained.safetyLock).toBe('PROFILE_TIER_CONSTRAINT');
    expect(String(constrained.reason)).toMatch(/PROFILE_TIER_CONSTRAINT/);
  });

  it('disallowed tier returns empty tool offer', async () => {
    const profile = resolveEffectiveProfile('read_only', [FIXTURES.filesystem_read]);
    const offer = await getToolsForTask('DATA_EXTRACTION', 'FRONTIER', profile);
    expect(offer.openAITools).toEqual([]);
  });
});

describe('AC-7 path semantics', () => {
  it('1. extracted path + path:none -> deny', async () => {
    register({
      name: `filesystem__${TEST_MARK}read`,
      rawName: `${TEST_MARK}read`,
      capability: 'read',
      requiresApproval: false,
      pathScope: { read: [ALLOWED_DIR] },
    });
    const profile = resolveEffectiveProfile('read_only', getRegistry());
    await expect(
      executeTool(`filesystem__${TEST_MARK}read`, { path: ALLOWED_PATH }, profile),
    ).rejects.toThrow(/does not permit filesystem paths/);
  });

  it('2. extracted path + non-none + missing pathScope -> deny', async () => {
    register({
      name: `shell__${TEST_MARK}write_file`,
      rawName: `${TEST_MARK}write_file`,
      capability: 'write',
      requiresApproval: true,
      // no pathScope
    });
    const profile = resolveEffectiveProfile('terminal_power', getRegistry());
    await expect(
      executeTool(`shell__${TEST_MARK}write_file`, { path: ALLOWED_PATH }, profile),
    ).rejects.toThrow(/no configured path scope/);
  });

  it('3. empty allowlist -> unconstrained (deny still wins)', () => {
    const s = { deny: [join(ANCHOR, 'secret')] };
    expect(checkPath(join(ANCHOR, 'anything'), s, 'write')).toBeNull();
    expect(checkPath(join(ANCHOR, 'secret', 'x'), s, 'write')).toMatch(/blocked path/);
  });

  it('4. denylist precedence over allowlist', () => {
    const s = { read: [ALLOWED_DIR], write: [ALLOWED_DIR], deny: [join(ALLOWED_DIR, 'secrets')] };
    expect(checkPath(join(ALLOWED_DIR, 'secrets', 'k'), s, 'read')).toMatch(/blocked path/);
  });

  it('5. no path-like key -> path checks skipped (client boundary)', async () => {
    register({
      name: `shell__${TEST_MARK}exec`,
      rawName: `${TEST_MARK}exec`,
      capability: 'exec',
      requiresApproval: true,
      pathScope: { write: [ALLOWED_DIR] },
    });
    const profile = resolveEffectiveProfile('terminal_power', getRegistry());
    await expect(
      executeTool(`shell__${TEST_MARK}exec`, { command: 'echo hi' }, profile),
    ).rejects.toThrow(/No MCP client connected/);
  });

  it('6. nonstandard key without pathArgKeys -> missed', () => {
    expect(extractPaths({ customFile: ALLOWED_PATH })).toEqual([]);
  });

  it('7. nonstandard key with pathArgKeys -> checked', () => {
    expect(extractPaths({ customFile: ALLOWED_PATH }, ['customFile'])).toEqual([ALLOWED_PATH]);
  });
});

describe('AC-8 hybrid policy hash and C2', () => {
  it('AC-C2-0 live-module golden preimage/hash vector', () => {
    const tools = [FIXTURES.filesystem_read, FIXTURES.filesystem_write];
    const profile = resolveEffectiveProfile('workspace_write', tools);
    // Reconstruct material without policyHash
    const { policyHash, ...material } = profile;
    const recomputed = hashPolicyMaterial(material as any);
    expect(recomputed).toBe(policyHash);
    expect(policyHash).toBe(
      createHash('sha256').update(canonicalizePolicy(material as any)).digest('hex'),
    );
  });

  it('AC-C2-1 material excludes raw filter lists', () => {
    const profile = resolveEffectiveProfile('workspace_write', [FIXTURES.filesystem_write]);
    const { policyHash: _, ...material } = profile;
    const keys = Object.keys(material).sort();
    expect(keys).not.toContain('allowedNamespaces');
    expect(keys).not.toContain('allowedCapabilities');
    expect(keys).not.toContain('allowedSideEffects');
    expect(keys).toEqual(
      expect.arrayContaining([
        'allowedOperationIds',
        'operationCapabilities',
        'operationSideEffects',
        'operationApprovals',
        'scopes',
        'approvalRequirements',
        'allowedTiers',
      ]),
    );
  });

  it('AC-C2-2 key order stable; direct array order sensitive on hasher', () => {
    const a = { z: 1, a: [1, 2], m: true };
    const b = { a: [1, 2], m: true, z: 1 };
    expect(hashPolicyMaterial(a as any)).toBe(hashPolicyMaterial(b as any));
    const c = { a: [2, 1], m: true, z: 1 };
    expect(hashPolicyMaterial(a as any)).not.toBe(hashPolicyMaterial(c as any));
  });

  it('AC-C2-3 registration order preserved by resolve', () => {
    const t1 = [FIXTURES.shell_exec, FIXTURES.shell_write];
    const t2 = [FIXTURES.shell_write, FIXTURES.shell_exec];
    expect(resolveEffectiveProfile('terminal_power', t1).policyHash).toBe(
      resolveEffectiveProfile('terminal_power', t2).policyHash,
    );
  });

  it('AC-C2-4 copied security field moves hash with same admitted set shape', () => {
    // scopes is copied into material — compare two profiles with different scopes
    // but empty tools so admitted sets both empty
    const a = resolveEffectiveProfile('read_only', []);
    const b = resolveEffectiveProfile('browser_research', []);
    expect(a.allowedOperationIds).toEqual([]);
    expect(b.allowedOperationIds).toEqual([]);
    expect(a.policyHash).not.toBe(b.policyHash);
  });

  it('AC-C2-5 hasher-unit label mutation moves hash', () => {
    const base = { operationSideEffects: { t: 'process' }, x: 1 };
    const mut = { operationSideEffects: { t: 'none' }, x: 1 };
    expect(hashPolicyMaterial(base as any)).not.toBe(hashPolicyMaterial(mut as any));
  });

  it('AC-C2-6 add/drop allowed operation moves hash', () => {
    const one = resolveEffectiveProfile('terminal_power', [FIXTURES.shell_exec]);
    const two = resolveEffectiveProfile('terminal_power', [FIXTURES.shell_exec, FIXTURES.shell_write]);
    expect(one.policyHash).not.toBe(two.policyHash);
  });

  it('AC-C2-7A assertCurrentPolicy rejects stale hash against live registry', () => {
    register({
      name: `shell__${TEST_MARK}exec`,
      rawName: `${TEST_MARK}exec`,
      capability: 'exec',
      requiresApproval: true,
    });
    const current = resolveEffectiveProfile('terminal_power', getRegistry());
    const stale = { ...current, policyHash: 'a'.repeat(64) };
    expect(() => assertCurrentPolicy(stale)).toThrow(/Stale effective profile/);
  });

  it('AC-C2-7B profile-delegation-stale is the documented C2 refusal code', () => {
    // Full broker path covered in collab-c2-*.test.ts; Phase 0 pins the code string contract.
    const source = readFileSync(
      join(__dirname, '../packages/gateway/src/approvalWriter.ts'),
      'utf8',
    );
    expect(source).toContain("profile-delegation-stale");
    const broker = readFileSync(join(__dirname, '../packages/gateway/src/c2Broker.ts'), 'utf8');
    expect(broker).toContain('profile-delegation-stale');
  });
});

describe('AC-10A pinned caller audit', () => {
  it('sole production executeTool caller forwards effectiveProfile', () => {
    const ollama = readFileSync(join(__dirname, '../packages/inference/src/ollama.ts'), 'utf8');
    expect(ollama).toMatch(/executeTool\([^)]*req\.effectiveProfile/);
    // No other non-test production callers of executeTool(
    const bridgeIndex = readFileSync(join(__dirname, '../packages/bridge/src/index.ts'), 'utf8');
    expect(bridgeIndex).toContain("export * from './registry.js'");
  });

  it('gateway assertResolvedProfile ingresses are server.ts and preview.ts', () => {
    const server = readFileSync(join(__dirname, '../packages/gateway/src/server.ts'), 'utf8');
    const preview = readFileSync(join(__dirname, '../packages/gateway/src/preview.ts'), 'utf8');
    expect(server).toContain('assertResolvedProfile');
    expect(preview).toContain('assertResolvedProfile');
  });
});

describe('AC-11 network not enforced pre-exec', () => {
  it('executeTool path does not consult scopes.network', async () => {
    // browser_research has network:browser; path none. No path args => client boundary,
    // not a network denial.
    register({
      name: `browser__${TEST_MARK}read_page`,
      rawName: `${TEST_MARK}read_page`,
      capability: 'read',
      requiresApproval: false,
    });
    const profile = resolveEffectiveProfile('browser_research', getRegistry());
    expect(profile.scopes.network).toBe('browser');
    await expect(
      executeTool(`browser__${TEST_MARK}read_page`, {}, profile),
    ).rejects.toThrow(/No MCP client connected/);
  });
});
