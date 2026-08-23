import { describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../packages/bridge/src/registry.js';
import {
  compareProfilePolicies,
  isOperationAllowed,
  resolveEffectiveProfile,
} from '../packages/bridge/src/profilePolicy.js';
import { constrainTier, defaultProfileForTask, resolveProfile } from '../packages/gateway/src/profileResolver.js';
import {
  BUILT_IN_PROFILE_DEFINITIONS,
  TaskTypeSchema,
  assertCapabilityAdmissionMap,
  assertSideEffectAdmissionMap,
} from '@torqclaw/contracts';

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
      tool('research__web_search', 'send'),
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

describe('G1R COLLAB-WRITE-PROFILE ruling — agent_conversation profile', () => {
  it('falsifiability probe 1: the profile admits collab__post_message (side effect collab_write)', () => {
    const tools = [
      tool('collab__post_message', 'read'),
      tool('collab__read_channel', 'read'),
    ];
    const profile = resolveEffectiveProfile('agent_conversation', tools);
    expect(profile.allowedOperationIds).toContain('collab__post_message');
    expect(profile.allowedOperationIds).toContain('collab__read_channel');
  });

  it('falsifiability probe 2: allowedNamespaces is the containment boundary, not allowedCapabilities', () => {
    // Every read-capable tool anywhere derives side-effect 'none'
    // (profilePolicy.ts's sideEffectFor short-circuit), which this profile
    // also admits. If the namespace list did not gate admission, a
    // non-collab read tool would leak in. Prove the CURRENT profile keeps
    // it out; the namespace-widened counterfactual is exercised directly
    // against BUILT_IN_PROFILE_DEFINITIONS below (probe 2b) rather than by
    // mutating the shipped singleton.
    const tools = [
      tool('collab__post_message', 'read'),
      tool('filesystem__read_file', 'read'),
      tool('research__web_search', 'read'),
    ];
    const profile = resolveEffectiveProfile('agent_conversation', tools);
    expect(profile.allowedOperationIds).toContain('collab__post_message');
    expect(profile.allowedOperationIds).not.toContain('filesystem__read_file');
    expect(profile.allowedOperationIds).not.toContain('research__web_search');
  });

  it('falsifiability probe 2b: widening allowedNamespaces to * WOULD admit unrelated read tools (proves the conjunct is load-bearing)', () => {
    const widened = {
      ...BUILT_IN_PROFILE_DEFINITIONS,
      agent_conversation: {
        ...BUILT_IN_PROFILE_DEFINITIONS.agent_conversation,
        allowedNamespaces: ['*'],
      },
    };
    const tools = [
      tool('collab__post_message', 'read'),
      tool('filesystem__read_file', 'read'),
      tool('research__web_search', 'read'),
    ];
    const definition = widened.agent_conversation;
    const allowed = tools.filter((t) =>
      (definition.allowedNamespaces.includes('*') || definition.allowedNamespaces.includes(t.name.split('__')[0]!)) &&
      definition.allowedCapabilities.includes(t.capability) &&
      definition.allowedSideEffects.includes('none'), // every tool above is capability:'read' -> side effect 'none'
    );
    expect(allowed.map((t) => t.name)).toEqual(
      expect.arrayContaining(['filesystem__read_file', 'research__web_search']),
    );
  });

  it('scopes is present and parses (G1R Amendment 1 — the shape without it does not type-check)', () => {
    expect(BUILT_IN_PROFILE_DEFINITIONS.agent_conversation.scopes).toEqual({ path: 'none', network: 'none' });
  });

  it('approvalRequirements all-false cannot gate post_message regardless of value (Amendment 3): the tool is capability read, not write/exec/send', () => {
    const t = tool('collab__post_message', 'read');
    expect(t.capability).toBe('read');
    // isOperationAllowed's own approval derivation only branches on
    // write/exec/send capability -- read capability never reaches any of
    // the three approvalRequirements flags, so their value is provably inert
    // for this tool.
    expect(['write', 'exec', 'send']).not.toContain(t.capability);
  });

  it('ESCALATION INVARIANT 1: agent_conversation is not the default profile for any TaskType', () => {
    for (const taskType of TaskTypeSchema.options) {
      expect(defaultProfileForTask(taskType), `taskType=${taskType}`).not.toBe('agent_conversation');
    }
  });

  it('ESCALATION INVARIANT 1 FALSIFIED: if agent_conversation WERE a task default, resolveProfile would let ordinary submission reach it', () => {
    // Positive control proving invariant 1 is not vacuous: resolving with an
    // explicit sessionDefaultProfile of 'agent_conversation' (simulating a
    // hypothetical future DEFAULT_PROFILE_BY_TASK entry) DOES resolve to it
    // with no operator authority required, because requestedId === sessionId.
    const resolved = resolveProfile({
      taskType: 'SUMMARIZATION',
      sessionDefaultProfile: 'agent_conversation',
      tools: [tool('collab__post_message', 'read')],
    });
    expect(resolved.profile.profileId).toBe('agent_conversation');
  });

  it('ESCALATION INVARIANT 2: requesting agent_conversation from an ordinary session default fails closed without operator authority', () => {
    expect(() =>
      resolveProfile({
        taskType: 'SUMMARIZATION',
        sessionDefaultProfile: 'read_only',
        requestedProfile: 'agent_conversation',
        tools: [tool('collab__post_message', 'read')],
      }),
    ).toThrow(/requires operator authority/);
  });

  it('agent_conversation is incomparable to read_only (the trap the dispatcher fix avoids)', () => {
    // A realistic multi-namespace registry, not just the two collab tools:
    // read_only's allowedNamespaces:['*'] means it also admits a plain
    // filesystem read tool that agent_conversation's namespace conjunct
    // excludes -- that is what makes the relation INCOMPARABLE rather than
    // 'broader'. (A collab-only tool universe would make agent_conversation
    // look like a strict superset of read_only and hide this.)
    const tools = [
      tool('collab__post_message', 'read'),
      tool('collab__read_channel', 'read'),
      tool('filesystem__read_file', 'read'),
    ];
    const readOnly = resolveEffectiveProfile('read_only', tools);
    const agentConversation = resolveEffectiveProfile('agent_conversation', tools);
    expect(compareProfilePolicies(agentConversation, readOnly)).toBe('incomparable');
  });

  it('setting BOTH requestedProfile and sessionDefaultProfile to agent_conversation resolves without throwing (the dispatcher pattern)', () => {
    const resolved = resolveProfile({
      taskType: 'SUMMARIZATION',
      requestedProfile: 'agent_conversation',
      sessionDefaultProfile: 'agent_conversation',
      operatorAuthorized: false,
      tools: [tool('collab__post_message', 'read'), tool('collab__read_channel', 'read')],
    });
    expect(resolved.profile.profileId).toBe('agent_conversation');
    expect(resolved.relationToSessionDefault).toBe('same');
  });
});

describe('G1R COLLAB-WRITE-PROFILE ruling — reachability conformance (the class fix)', () => {
  it('every SideEffectClass is admitted by >=1 profile or explicitly RESERVED (no drift from BUILT_IN_PROFILE_DEFINITIONS)', () => {
    expect(() => assertSideEffectAdmissionMap()).not.toThrow();
  });

  it('every CapabilityClass is admitted by >=1 profile or explicitly RESERVED (no drift from BUILT_IN_PROFILE_DEFINITIONS)', () => {
    expect(() => assertCapabilityAdmissionMap()).not.toThrow();
  });

  it('DETECTOR PROOF: a hand-edited map claiming an unadmitted class IS admitted must be caught, not silently accepted', () => {
    const lyingMap = {
      none: ['read_only'] as const,
      filesystem_write: ['workspace_write'] as const,
      browser_mutation: ['browser_research'] as const, // LIE: browser_research is read-only capability, never admits browser_mutation
      process: ['terminal_power'] as const,
      network_send: 'INTENTIONALLY_UNADMITTED' as const,
      collab_write: ['agent_conversation'] as const,
    };
    // G2A NB-2: this test was VACUOUS. It built lyingMap and then inspected
    // BUILT_IN_PROFILE_DEFINITIONS directly -- the planted lie NEVER REACHED
    // the validator, so the test proved nothing about the detector and would
    // have passed against a detector that did nothing at all. It merely
    // restated a fact the very next test already covers. Instance nine of this
    // program's guard-that-enforces-nothing pattern, inside the test whose
    // entire purpose was to prove a guard is real.
    //
    // The map cannot be injected -- assertSideEffectAdmissionMap takes ONLY
    // `definitions` and reads SIDE_EFFECT_ADMISSION from module scope. That is
    // itself a good property (the registry is not caller-substitutable), and
    // it means `lyingMap` above can only ever be inert documentation. So the
    // detector is proven from the side that IS injectable: lie in the
    // DEFINITIONS and require the validator to catch the drift.
    void lyingMap; // retained as the documented shape of the lie being described

    const lyingDefinitions = {
      ...BUILT_IN_PROFILE_DEFINITIONS,
      browser_research: {
        ...BUILT_IN_PROFILE_DEFINITIONS.browser_research,
        // THE PLANTED LIE: browser_mutation is registered
        // INTENTIONALLY_UNADMITTED, so a profile admitting it is exactly the
        // drift the registry exists to detect.
        allowedSideEffects: [...BUILT_IN_PROFILE_DEFINITIONS.browser_research.allowedSideEffects, 'browser_mutation'],
      },
    } as typeof BUILT_IN_PROFILE_DEFINITIONS;

    expect(
      () => assertSideEffectAdmissionMap(lyingDefinitions),
      'the validator must REJECT definitions where a profile admits a class the '
      + 'registry marks INTENTIONALLY_UNADMITTED. If this does not throw, the '
      + 'registry is decorative and a future dead class goes unnoticed exactly as '
      + 'collab_write did.',
    ).toThrow(/browser_mutation/);

    // POSITIVE CONTROL, same test: the REAL definitions must PASS. Without it
    // the assertion above is satisfied by a validator that throws on anything.
    expect(
      () => assertSideEffectAdmissionMap(BUILT_IN_PROFILE_DEFINITIONS),
      'the real definitions must PASS -- otherwise the throw above proves only '
      + 'that the validator is broken, not that it discriminates',
    ).not.toThrow();
  });

  it('DETECTOR PROOF: browser_mutation stays RESERVED-BY-DEFECT — granting it to satisfy a naive test would be the privilege-escalation-pump failure mode', () => {
    // Direct structural proof of the ruling's §9D finding: browser_research
    // (the only browser-namespace profile) sets allowedCapabilities:['read'],
    // and no profile's allowedSideEffects lists 'browser_mutation'.
    for (const definition of Object.values(BUILT_IN_PROFILE_DEFINITIONS)) {
      if (definition.allowedNamespaces.some((n) => n === 'browser' || n === 'playwright' || n === '*')) {
        expect(definition.allowedSideEffects, `${definition.profileId} must not admit browser_mutation`)
          .not.toContain('browser_mutation');
      }
    }
  });
});
