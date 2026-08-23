import { describe, expect, it } from 'vitest';
import {
  extractAgentMutationReporting,
  normalizeAgentMutationTerminalResult,
} from '../packages/gateway/src/agentSurface.js';

const KEY = '123e4567-e89b-42d3-a456-426614174000';

describe('agent mutation terminal results', () => {
  it('extracts exact mutation actions and preserves only a UUID-valid raw key', () => {
    expect(extractAgentMutationReporting({ action: 'CREATE_AGENT', idempotencyKey: KEY }))
      .toEqual({ operation: 'create', idempotencyKey: KEY });
    expect(extractAgentMutationReporting({ action: 'UPDATE_AGENT_PROFILE', idempotencyKey: 'spoof' }))
      .toEqual({ operation: 'update', idempotencyKey: null });
    expect(extractAgentMutationReporting({ action: 'create_agent', idempotencyKey: KEY })).toBeNull();
    expect(extractAgentMutationReporting({ action: 'LIST_AGENTS', idempotencyKey: KEY })).toBeNull();
  });

  it('normalizes only success, revision/idempotency conflicts, and allowlisted errors', () => {
    const reporting = { operation: 'update' as const, idempotencyKey: KEY };
    expect(normalizeAgentMutationTerminalResult(reporting, {
      status: 'success', agent: { principalId: 'agent-1' },
    })).toMatchObject({
      agentMutationTerminal: true, operation: 'update', idempotencyKey: KEY,
      status: 'success', message: 'Agent profile updated.',
    });
    expect(normalizeAgentMutationTerminalResult(reporting, {
      status: 'conflict', conflict: 'revision',
    })).toMatchObject({ status: 'conflict', conflict: 'revision' });
    expect(normalizeAgentMutationTerminalResult(reporting, {
      status: 'conflict', conflict: 'idempotency',
    })).toMatchObject({ status: 'conflict', conflict: 'idempotency' });
    expect(normalizeAgentMutationTerminalResult(reporting, {
      status: 'error', errorCode: 'unavailable',
    })).toMatchObject({
      status: 'error', errorCode: 'unavailable',
      message: 'Agent management is temporarily unavailable.',
    });
  });
});
