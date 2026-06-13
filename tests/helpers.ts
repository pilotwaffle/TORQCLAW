import type { GatewayRequest } from '@torqclaw/contracts';

/** Minimal valid GatewayRequest; override any leaf for a specific case. */
export function makeRequest(overrides: {
  prompt?: string;
  taskType?: GatewayRequest['payload']['taskType'];
  requiredTools?: string[];
  contextSize?: number;
  classifierConfidence?: number;
  containsSensitiveData?: boolean;
  executionMode?: 'AUTO' | 'LOCAL_ONLY' | 'CLOUD_OK';
  latencySensitivity?: 'HIGH' | 'LOW';
  maxCost?: number;
} = {}): GatewayRequest {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    sessionId: '00000000-0000-0000-0000-000000000002',
    sourceChannel: 'test',
    receivedAt: '2026-01-01T00:00:00.000Z',
    payload: {
      prompt: overrides.prompt ?? 'test prompt',
      contextSize: overrides.contextSize ?? 100,
      requiredTools: overrides.requiredTools ?? [],
      taskType: overrides.taskType ?? 'ROUTINE_AUTOMATION',
    },
    constraints: {
      latencySensitivity: overrides.latencySensitivity ?? 'LOW',
      maxCost: overrides.maxCost,
      containsSensitiveData: overrides.containsSensitiveData ?? false,
      executionMode: overrides.executionMode ?? 'AUTO',
    },
    enrichment: {
      classifierUsed: 'LOCAL_LLM',
      classifierConfidence: overrides.classifierConfidence ?? 0.9,
      classifierLatencyMs: 10,
      estimatedTokens: 100,
    },
  };
}
