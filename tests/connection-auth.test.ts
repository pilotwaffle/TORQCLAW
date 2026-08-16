import { describe, expect, it } from 'vitest';
import {
  assertedRoleMatches,
  authenticateConnection,
  assertProductionLegacyTokenDisabled,
  type AuthenticatedCaller,
} from '../packages/gateway/src/connectionAuth.js';

const clientInfo = { name: 'phase1-test', version: '1' };
const operatorSurface: AuthenticatedCaller = {
  authClass: 'operator_surface', role: 'operator',
  binding: { principalId: 'operator-1', surfaceId: 'desktop-1' },
};
const agentSurface: AuthenticatedCaller = {
  authClass: 'agent_surface', role: 'node',
  binding: { principalId: 'agent-1', surfaceId: 'agent-surface-1' },
};

function deps(overrides: Partial<Parameters<typeof authenticateConnection>[1]> = {}) {
  return {
    legacyGatewayToken: 'legacy-secret',
    channelServiceToken: 'channel-secret',
    production: false,
    allowTokenlessLegacy: false,
    resolveSurface: (credential: string) => credential === 'operator'
      ? operatorSurface
      : credential === 'agent'
        ? agentSurface
        : null,
    ...overrides,
  };
}

describe('Phase 1 server-owned connection authority', () => {
  it('binds an agent credential to node and rejects an operator assertion', () => {
    const frame = {
      role: 'operator' as const, clientInfo,
      auth: { kind: 'surface' as const, credential: 'agent' },
    };
    const caller = authenticateConnection(frame, deps());
    expect(caller?.role).toBe('node');
    expect(assertedRoleMatches(frame, caller!.role)).toBe(false);
  });

  it('binds a channel credential to channel and rejects an operator assertion', () => {
    const frame = {
      expectedRole: 'operator' as const, clientInfo,
      auth: { kind: 'channel_service' as const, credential: 'channel-secret' },
    };
    const caller = authenticateConnection(frame, deps());
    expect(caller).toMatchObject({
      authClass: 'channel_service', role: 'channel',
      binding: { principalId: 'service:channel-http', surfaceId: 'service:channel-http' },
    });
    expect(assertedRoleMatches(frame, caller!.role)).toBe(false);
  });

  it('accepts a legitimate operator surface without trusting a role field', () => {
    const frame = {
      clientInfo,
      auth: { kind: 'surface' as const, credential: 'operator' },
    };
    const caller = authenticateConnection(frame, deps());
    expect(caller).toEqual(operatorSurface);
    expect(assertedRoleMatches(frame, caller!.role)).toBe(true);
  });

  it('legacy gateway token has one fixed development role and is rejected in production', () => {
    const operatorRequest = { role: 'operator' as const, token: 'legacy-secret', clientInfo };
    const development = authenticateConnection(operatorRequest, deps());
    expect(development).toMatchObject({ authClass: 'legacy_gateway', role: 'operator' });
    expect(assertedRoleMatches(operatorRequest, development!.role)).toBe(true);
    expect(authenticateConnection(operatorRequest, deps({ production: true }))).toBeNull();

    // The same credential cannot select a second role through frame.role.
    const channelRequest = { ...operatorRequest, role: 'channel' as const };
    const fixed = authenticateConnection(channelRequest, deps());
    expect(fixed).toMatchObject({ authClass: 'legacy_gateway', role: 'operator' });
    expect(assertedRoleMatches(channelRequest, fixed!.role)).toBe(false);
    expect(authenticateConnection(
      { role: 'operator', clientInfo },
      deps({ legacyGatewayToken: '' }),
    )).toBeNull();
    expect(authenticateConnection(
      { role: 'operator', clientInfo },
      deps({ legacyGatewayToken: '', allowTokenlessLegacy: true }),
    )).toMatchObject({ authClass: 'legacy_gateway', role: 'operator' });
  });

  it('production startup rejects TORQCLAW_GATEWAY_TOKEN without echoing it', () => {
    const env = { NODE_ENV: 'production', TORQCLAW_GATEWAY_TOKEN: 'do-not-echo' };
    expect(() => assertProductionLegacyTokenDisabled(env)).toThrow(/deprecated.*production/i);
    try {
      assertProductionLegacyTokenDisabled(env);
    } catch (error) {
      expect(String(error)).not.toContain('do-not-echo');
    }
    expect(() => assertProductionLegacyTokenDisabled({ NODE_ENV: 'production' })).not.toThrow();
  });
});
