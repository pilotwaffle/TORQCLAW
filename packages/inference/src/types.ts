import type { GatewayEventType } from '@torqclaw/contracts';

/** Adapters report through an emitter, never a socket. */
export type Emitter = (type: GatewayEventType, message: string, metadata?: unknown) => void;

export interface ExecutionResult {
  text: string;
  telemetry: {
    engineUsed: string;
    iterations: number;
    toolCallCount: number;
    inferenceLatencyMs: number;
    cancelled?: boolean;
    costUsd?: number | null;
  };
}
