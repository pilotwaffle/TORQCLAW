import { randomUUID } from 'node:crypto';
import type { ClientCommand, GatewayRequest } from '@torqclaw/contracts';
import { classifyTaskType } from './classifier.js';
import { sessions } from './sessions.js';
import { predictTools } from '@torqclaw/bridge';

// chars/4: standard cheap approximation, good enough for routing thresholds.
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export async function enrichCommand(
  cmd: Extract<ClientCommand, { action: 'SUBMIT_PROMPT' }>,
  sessionId: string,
  sourceChannel: string,
): Promise<GatewayRequest> {
  // P4.5: useMemory=false skips recall entirely — no past context assembled.
  const useMemory = cmd.useMemory ?? true;
  const history = useMemory ? sessions.getContextWindow(sessionId, cmd.prompt) : '';
  const contextSize = estimateTokens(cmd.prompt) + estimateTokens(history);

  const cls = await classifyTaskType(cmd.prompt); // never throws

  return {
    id: randomUUID(),
    sessionId,
    sourceChannel,
    receivedAt: new Date().toISOString(),
    payload: {
      prompt: cmd.prompt,
      assembledContext: history || undefined,
      contextSize,
      requiredTools: predictTools(cls.taskType),
      taskType: cls.taskType,
      // Fresh request: no grants. Built explicitly (never spread from cmd) so a
      // client-injected grantedTools can never reach a GatewayRequest.
      grantedTools: [],
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
  };
}
