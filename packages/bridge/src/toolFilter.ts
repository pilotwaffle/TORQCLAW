import type { EffectiveProfile, TaskType } from '@torqclaw/contracts';
import { getRegistry, type RegisteredTool } from './registry.js';
import { isOperationAllowed } from './profilePolicy.js';

/** Task -> tool prefix allowlist. Defeats schema bloat: with 10+ servers the
 *  full registry is 40-100KB of schemas — fatal for an 8k local window.
 *
 *  PRD-TCLAW-AGENT-PARTICIPATION-007 S2 (G1R Gate-1 §1.4 item 5): the
 *  `collab__` prefix is added EXPLICITLY here for every task type -- a
 *  namespace absent from this map is silently invisible to the model
 *  (no else-branch below), so omission would be a real deny, not an
 *  oversight-safe default. The map alone is NOT the security boundary,
 *  though: `getToolsForTask` additionally omits `collab__` entries whenever
 *  the task carries no bound collab principal (see its own doc comment) --
 *  a human-triggered task with no agent identity never sees these tools
 *  regardless of task type, so widening this list to every task type does
 *  not widen who can actually reach the tools. (N-3, noted not fixed: this
 *  can push a task's requiredTools count past router's
 *  TOOL_COUNT_OVERFLOW threshold and re-route it to FRONTIER -- measured in
 *  this slice's own tests, not silently absorbed.) */
const TOOL_ROUTING_MAP: Record<TaskType, string[]> = {
  DATA_EXTRACTION: ['db__', 'filesystem__', 'tradingview__', 'collab__'],
  SUMMARIZATION: ['filesystem__', 'collab__'],
  ROUTINE_AUTOMATION: ['filesystem__', 'scheduler__', 'tradingview__', 'desktop_commander__', 'playwright__', 'collab__'],
  COMPLEX_CODING: ['filesystem__', 'github__', 'sandbox__', 'desktop_commander__', 'playwright__', 'collab__'],
  AUTONOMOUS_RESEARCH: ['websearch__', 'filesystem__', 'tradingview__', 'playwright__', 'collab__'],
};

/** S2: the bridge server id the in-process collab tools register under
 *  (collabAgentTools.ts's COLLAB_AGENT_SERVER_ID, duplicated here as a
 *  literal so toolFilter.ts does not need a dependency on gateway code --
 *  bridge is a lower layer than gateway; see registry.ts's layering note).
 *  A source-level test pins that this literal matches the gateway-side
 *  constant, so the two cannot drift silently. */
const COLLAB_TOOL_SERVER_ID = 'collab';

export function predictTools(
  taskType: TaskType,
  profile?: EffectiveProfile,
  callerCollabPrincipalId?: string,
): string[] {
  const prefixes = TOOL_ROUTING_MAP[taskType] ?? [];
  return getRegistry()
    .filter(
      (t) =>
        prefixes.some((p) => t.name.startsWith(p)) &&
        // S2: collab__ tools are meaningless (and a wasted context-window
        // slot) for a task with no bound agent identity -- every call would
        // refuse COLLAB_IDENTITY_REQUIRED regardless of arguments. Gating
        // here, not just at execution time, keeps requiredTools (which
        // feeds the router's tool-count heuristic) honest about what a
        // human-triggered task can actually use.
        (t.sourceServerId !== COLLAB_TOOL_SERVER_ID || callerCollabPrincipalId !== undefined) &&
        (!profile || isOperationAllowed(profile, t)),
    )
    .map((t) => t.name);
}

/** OpenAI caps function names at 64 chars; namespaced MCP names can exceed it.
 *  Maintain a truncated-alias map instead of assuming pass-through. */
function buildAliases(tools: RegisteredTool[]) {
  const toAlias = new Map<string, string>();
  const fromAlias = new Map<string, string>();
  for (const t of tools) {
    let alias = t.name.length <= 64 ? t.name : t.name.slice(0, 56) + '_' + hash8(t.name);
    toAlias.set(t.name, alias);
    fromAlias.set(alias, t.name);
  }
  return { toAlias, fromAlias };
}

function hash8(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 7);
}

export async function getToolsForTask(
  taskType: TaskType,
  tier: 'LOCAL_EDGE' | 'FRONTIER',
  profile?: EffectiveProfile,
  callerCollabPrincipalId?: string,
) {
  if (profile && !profile.allowedTiers.includes(tier)) {
    return {
      openAITools: [],
      resolveAlias: (alias: string) => alias,
      requiresApproval: (_realName: string) => false,
    };
  }
  const prefixes = TOOL_ROUTING_MAP[taskType] ?? [];
  const filtered = getRegistry().filter(
    (t) =>
      t.sourceServerId !== 'hermes' && // engine meta-tools never go to user loops
      (prefixes.some((p) => t.name.startsWith(p)) || t.name.startsWith('core_meta__')) &&
      // S2: same identity gate as predictTools above -- a task with no bound
      // agent principal never sees a collab__ tool in its RENDERED list,
      // asserted per §7.5 against this exact array, not the config table.
      (t.sourceServerId !== COLLAB_TOOL_SERVER_ID || callerCollabPrincipalId !== undefined) &&
      (!profile || isOperationAllowed(profile, t)),
  );
  const { toAlias, fromAlias } = buildAliases(filtered);
  const approvalSet = new Set(filtered.filter((t) => t.requiresApproval).map((t) => t.name));

  return {
    openAITools: filtered.map((t) => ({
      type: 'function' as const,
      function: {
        name: toAlias.get(t.name)!,
        description: t.description,
        parameters: t.inputSchema,
      },
    })),
    resolveAlias: (alias: string) => fromAlias.get(alias) ?? alias,
    requiresApproval: (realName: string) =>
      tier === 'LOCAL_EDGE' && approvalSet.has(realName),
  };
}
