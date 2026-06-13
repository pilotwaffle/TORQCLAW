import { describe, it, expect } from 'vitest';
import {
  ClientCommandSchema,
  GatewayRequestSchema,
} from '@torqclaw/contracts';

describe('P2 grantedTools is gateway-owned (client cannot inject)', () => {
  it('a client SUBMIT_PROMPT carrying grantedTools is stripped, never carried', () => {
    const parsed = ClientCommandSchema.parse({
      action: 'SUBMIT_PROMPT',
      prompt: 'do a thing',
      // hostile client tries to pre-authorize a destructive tool
      grantedTools: ['filesystem__delete_everything'],
    } as any);
    // Zod strips unknown keys on plain objects — grantedTools must not survive.
    expect((parsed as any).grantedTools).toBeUndefined();
  });

  it('APPROVE_TOOL carries no tool name (grant is read server-side)', () => {
    const parsed = ClientCommandSchema.parse({
      action: 'APPROVE_TOOL',
      approvalId: 'abc-123',
      decision: 'APPROVE',
    });
    expect(parsed.action).toBe('APPROVE_TOOL');
    expect((parsed as any).toolName).toBeUndefined();
    expect((parsed as any).grantedTools).toBeUndefined();
  });

  it('GatewayRequest.payload.grantedTools defaults to [] when omitted', () => {
    const req = GatewayRequestSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      sourceChannel: 'test',
      receivedAt: '2026-01-01T00:00:00.000Z',
      payload: {
        prompt: 'p', contextSize: 1, requiredTools: [], taskType: 'SUMMARIZATION',
      },
      constraints: { latencySensitivity: 'LOW', containsSensitiveData: false },
      enrichment: {
        classifierUsed: 'LOCAL_LLM', classifierConfidence: 0.9,
        classifierLatencyMs: 1, estimatedTokens: 1,
      },
    });
    expect(req.payload.grantedTools).toEqual([]);
  });

  it('GatewayRequest carries an explicit grant verbatim', () => {
    const req = GatewayRequestSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      sourceChannel: 'test',
      receivedAt: '2026-01-01T00:00:00.000Z',
      payload: {
        prompt: 'p', contextSize: 1, requiredTools: [], taskType: 'SUMMARIZATION',
        grantedTools: ['filesystem__write_file'],
      },
      constraints: { latencySensitivity: 'LOW', containsSensitiveData: false },
      enrichment: {
        classifierUsed: 'LOCAL_LLM', classifierConfidence: 0.9,
        classifierLatencyMs: 1, estimatedTokens: 1,
      },
    });
    expect(req.payload.grantedTools).toEqual(['filesystem__write_file']);
  });
});
