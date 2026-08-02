import { describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../packages/bridge/src/registry.js';
import {
  compareProfilePolicies,
  isOperationAllowed,
  resolveEffectiveProfile,
} from '../packages/bridge/src/profilePolicy.js';
import { constrainTier, resolveProfile } from '../packages/gateway/src/profileResolver.js';

function tool(
  name: string,
  capability: RegisteredTool['capability'],
  requiresApproval = capability !== 'read',
): RegisteredTool {
  const parts = name.split('__');
  const sourceServerId = parts[0] ?? '';
  const rawName = parts[1] ?? name;
  return {
    name,
    rawName,
    sourceServerId,
    description: name,
    inputSchema: {},
    capability,
    requiresApproval,
  };
}

describe('Slice B effective profile policy', () => {
  it('hashes the same policy deterministically despite registry order', () => {
    const tools = [
      tool('filesystem__read_file', 'read'),
      tool('filesystem__write_file', 'write'),
    ];

    const first = resolveEffectiveProfile('workspace_write', tools);
    const second = resolveEffectiveProfile('workspace_write', [...tools].reverse());

    expect(second).toEqual(first);
    expect(first.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('covers every capability class without allowing a broader class through', () => {
    const tools = [
      tool('filesystem__read_file', 'read'),
      tool('filesystem__write_file', 'write'),
      tool('terminal__run', 'exec'),
      tool('websearch__search', 'send'),
    ];
    const readOnly = resolveEffectiveProfile('read_only', tools);
    const workspace = resolveEffectiveProfile('workspace_write', tools);
    const terminal = resolveEffectiveProfile('terminal_power', tools);

    expect(isOperationAllowed(readOnly, tools[0]!)).toBe(true);
    expect(isOperationAllowed(readOnly, tools[1]!)).toBe(false);
    expect(isOperationAllowed(readOnly, tools[2]!)).toBe(false);
    expect(isOperationAllowed(readOnly, tools[3]!)).toBe(false);

    expect(isOperationAllowed(workspace, tools[0]!)).toBe(true);
    expect(isOperationAllowed(workspace, tools[1]!)).toBe(true);
    expect(isOperationAllowed(workspace, tools[2]!)).toBe(false);
    expect(isOperationAllowed(workspace, tools[3]!)).toBe(false);

    expect(isOperationAllowed(terminal, tools[2]!)).toBe(true);
    expect(isOperationAllowed(terminal, tools[1]!)).toBe(false);
    expect(isOperationAllowed(terminal, tools[3]!)).toBe(false);
  });

  it('rejects browser mutation and namespace confusion', () => {
    const tools = [
      tool('playwright__snapshot', 'read'),
      tool('playwright__submit_form', 'write'),
      tool('filesystem__read_file', 'read'),
    ];
    const browser = resolveEffectiveProfile('browser_research', tools);

    expect(isOperationAllowed(browser, tools[0]!)).toBe(true);
    expect(isOperationAllowed(browser, tools[1]!)).toBe(false);
    expect(isOperationAllowed(browser, tools[2]!)).toBe(false);
  });

  it('allows a proven stricter request and requires authority for broadening', () => {
    const tools = [
      tool('filesystem__read_file', 'read'),
      tool('filesystem__write_file', 'write'),
    ];
    const readOnly = resolveEffectiveProfile('read_only', tools);
    const workspace = resolveEffectiveProfile('workspace_write', tools);

    expect(compareProfilePolicies(readOnly, workspace)).toBe('stricter');
    expect(compareProfilePolicies(workspace, readOnly)).toBe('broader');

    expect(() =>
      resolveProfile({
        taskType: 'DATA_EXTRACTION',
        sessionDefaultProfile: 'read_only',
        requestedProfile: 'workspace_write',
        tools,
      }),
    ).toThrow(/requires operator authority/);

    expect(
      resolveProfile({
        taskType: 'DATA_EXTRACTION',
        sessionDefaultProfile: 'read_only',
        requestedProfile: 'workspace_write',
        operatorAuthorized: true,
        tools,
      }).profile.profileId,
    ).toBe('workspace_write');

    expect(
      resolveProfile({
        taskType: 'ROUTINE_AUTOMATION',
        sessionDefaultProfile: 'workspace_write',
        requestedProfile: 'read_only',
        tools,
      }).relationToSessionDefault,
    ).toBe('stricter');
  });

  it('fails closed for incomparable profile families', () => {
    const tools = [
      tool('filesystem__read_file', 'read'),
      tool('playwright__snapshot', 'read'),
    ];

    expect(() =>
      resolveProfile({
        taskType: 'DATA_EXTRACTION',
        sessionDefaultProfile: 'workspace_write',
        requestedProfile: 'browser_research',
        tools,
      }),
    ).toThrow(/requires operator authority/);
  });

  it('constrains router tier when a profile cannot use the selected tier', () => {
    const profile = resolveEffectiveProfile('read_only', []);
    const constrained = constrainTier({
      score: 100,
      reason: 'heuristic',
      tier: 'FRONTIER',
    }, profile);
    expect(constrained.tier).toBe('OLLAMA_LOCAL');
    expect(constrained.safetyLock).toBe('PROFILE_TIER_CONSTRAINT');
  });
});
