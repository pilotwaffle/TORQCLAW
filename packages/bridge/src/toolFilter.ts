import type { TaskType } from '@torqclaw/contracts';
import { getRegistry, type RegisteredTool } from './registry.js';

/** Task -> tool prefix allowlist. Defeats schema bloat: with 10+ servers the
 *  full registry is 40-100KB of schemas — fatal for an 8k local window. */
const TOOL_ROUTING_MAP: Record<TaskType, string[]> = {
  DATA_EXTRACTION: ['db__', 'filesystem__'],
  SUMMARIZATION: ['filesystem__'],
  ROUTINE_AUTOMATION: ['filesystem__', 'scheduler__'],
  COMPLEX_CODING: ['filesystem__', 'github__', 'sandbox__'],
  AUTONOMOUS_RESEARCH: ['websearch__', 'filesystem__'],
};

export function predictTools(taskType: TaskType): string[] {
  const prefixes = TOOL_ROUTING_MAP[taskType] ?? [];
  return getRegistry()
    .filter((t) => prefixes.some((p) => t.name.startsWith(p)))
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

export async function getToolsForTask(taskType: TaskType, tier: 'LOCAL_EDGE' | 'FRONTIER') {
  const prefixes = TOOL_ROUTING_MAP[taskType] ?? [];
  const filtered = getRegistry().filter(
    (t) =>
      t.sourceServerId !== 'hermes' && // engine meta-tools never go to user loops
      (prefixes.some((p) => t.name.startsWith(p)) || t.name.startsWith('core_meta__')),
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
