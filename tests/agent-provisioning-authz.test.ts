import { describe, expect, it } from 'vitest';
import { ClientCommandSchema } from '@torqclaw/contracts';
import { authorize, type AuthzContext } from '../packages/gateway/src/authz.js';
import { handleCreateAgent } from '../packages/gateway/src/agentSurface.js';

const command = ClientCommandSchema.parse({
  action: 'CREATE_AGENT',
  displayName: 'Worker',
  providerId: 'ollama-local',
  modelId: 'torq-local',
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
});

function context(options: { role?: 'operator' | 'agent'; delegate?: boolean; surface?: boolean } = {}): AuthzContext {
  return {
    sessionId: 'session',
    lookupTaskSession: () => null,
    ...(options.surface === false ? {} : {
      surface: {
        surfaceId: 'surface',
        currentRole: () => options.role ?? 'operator',
        holdsAuthority: (authority) => authority === 'delegate' && options.delegate === true,
      },
    }),
  };
}

describe('agent provisioning authority', () => {
  it('requires a live operator-role surface with delegate authority', () => {
    expect(authorize('operator', command, context({ surface: false })).ok).toBe(false);
    expect(authorize('operator', command, context({ role: 'agent', delegate: true })).ok).toBe(false);
    expect(authorize('operator', command, context({ delegate: false })).ok).toBe(false);
    expect(authorize('operator', command, context({ delegate: true }))).toEqual({ ok: true });
  });

  it('does not accept a browser-spoofed authority field', () => {
    const parsed = ClientCommandSchema.parse({ ...command, manageAgentsAuthorized: true });
    expect('manageAgentsAuthorized' in parsed).toBe(false);
    expect(authorize('operator', parsed, context({ delegate: false })).ok).toBe(false);
  });

  it('rechecks authority at the writer boundary before resolving identity or writing', async () => {
    const refusal = await handleCreateAgent(null, command, () => false);
    expect(refusal).toEqual({ status: 'error', errorCode: 'identity_required' });
  });

  it('requires delegate authority for listing and updating agent directives', () => {
    const list = ClientCommandSchema.parse({ action: 'LIST_AGENTS' });
    const update = ClientCommandSchema.parse({
      action: 'UPDATE_AGENT_PROFILE',
      agentPrincipalId: '123e4567-e89b-42d3-a456-426614174000',
      iconId: 'robot',
      systemDirectives: 'Be concise',
      expectedRevision: 1,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(authorize('operator', list, context({ delegate: false })).ok).toBe(false);
    expect(authorize('operator', update, context({ delegate: false })).ok).toBe(false);
    expect(authorize('operator', list, context({ delegate: true }))).toEqual({ ok: true });
    expect(authorize('operator', update, context({ delegate: true }))).toEqual({ ok: true });
  });
});
