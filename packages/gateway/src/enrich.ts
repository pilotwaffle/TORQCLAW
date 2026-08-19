import { randomUUID } from 'node:crypto';
import type { ClientCommand, GatewayRequest } from '@torqclaw/contracts';
import { classifyTaskType } from './classifier.js';
import { sessions } from './sessions.js';
import { predictTools } from '@torqclaw/bridge';
import { resolveProfile } from './profileResolver.js';

// chars/4: standard cheap approximation, good enough for routing thresholds.
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export async function enrichCommand(
  cmd: Extract<ClientCommand, { action: 'SUBMIT_PROMPT' }>,
  sessionId: string,
  sourceChannel: string,
  // PRD-TCLAW-AGENT-PARTICIPATION-007 S2: gateway-derived ONLY, passed by
  // the caller (server.ts) — NEVER read from `cmd`. SUBMIT_PROMPT carries no
  // agent-identity field (contracts/commands.ts) and none may be added for a
  // client to set: the binding is established by the gateway from its own
  // state (S1's agentCollabPrincipalId, or whatever S3's dispatch-time
  // binding eventually supplies), never from task input. Nothing in this
  // repo passes this argument yet — role 'node' (the only seat an agent's
  // own connection can hold) is denied SUBMIT_PROMPT entirely (authz.ts), so
  // an agent-bound task dispatch does not exist until S3. Threaded through
  // now so the tool surface this slice builds is provably correct against
  // its stated precondition ("a task bound to agent principal P") without
  // requiring S3's trigger mechanism to exist first.
  callerCollabPrincipalId?: string,
): Promise<GatewayRequest> {
  // P4.5: useMemory=false skips recall entirely — no past context assembled.
  const useMemory = cmd.useMemory ?? true;
  const history = useMemory ? sessions.getContextWindow(sessionId, cmd.prompt) : '';
  const contextSize = estimateTokens(cmd.prompt) + estimateTokens(history);

  const cls = await classifyTaskType(cmd.prompt); // never throws
  // Resolve policy before selecting tools. The resulting snapshot is carried
  // on the gateway-owned request and is re-checked by the bridge at dispatch.
  const effectiveProfile = resolveProfile({ taskType: cls.taskType }).profile;

  return {
    id: randomUUID(),
    sessionId,
    sourceChannel,
    receivedAt: new Date().toISOString(),
    payload: {
      prompt: cmd.prompt,
      assembledContext: history || undefined,
      contextSize,
      requiredTools: predictTools(cls.taskType, effectiveProfile, callerCollabPrincipalId),
      taskType: cls.taskType,
      // Fresh request: no grants. Built explicitly (never spread from cmd) so a
      // client-injected grantedTools can never reach a GatewayRequest.
      grantedTools: [],
      // Built explicitly from this function's OWN parameter — never spread
      // from `cmd` — for the same reason grantedTools above is never spread.
      callerCollabPrincipalId,
    },
    constraints: {
      latencySensitivity: cmd.urgent ? 'HIGH' : 'LOW',
      maxCost: cmd.maxCostUsd,
      containsSensitiveData: cmd.sensitive,
      executionMode: cmd.executionMode,
    },
    enrichment: {
      classifierUsed: cls.method,
      classifierConfidence: cls.confidence,
      classifierLatencyMs: cls.latencyMs,
      estimatedTokens: contextSize,
      memoryUsed: useMemory,
    },
    effectiveProfile,
  };
}
