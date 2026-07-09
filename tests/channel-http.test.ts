import { describe, it, expect } from 'vitest';
import { isTerminal, TERMINAL_TYPES, resolveGatewayToken } from '../packages/channel-http/src/gatewayClient.js';

describe('channel-http terminal-event detection', () => {
  it('treats the three invariant-7 terminal types as terminal', () => {
    expect(isTerminal({ type: 'RESULT' })).toBe(true);
    expect(isTerminal({ type: 'ERROR' })).toBe(true);
    expect(isTerminal({ type: 'PENDING_APPROVAL' })).toBe(true);
  });

  it('does NOT treat intermediate events as terminal', () => {
    for (const t of ['SYSTEM', 'CONNECTED', 'USER_PROMPT', 'ROUTING', 'TIER_SELECTED', 'TOOL_CALL']) {
      expect(isTerminal({ type: t })).toBe(false);
    }
  });

  it('is safe on a missing or non-string type', () => {
    expect(isTerminal({})).toBe(false);
    expect(isTerminal({ type: undefined })).toBe(false);
    expect(isTerminal({ type: 123 as unknown as string })).toBe(false);
  });

  it('TERMINAL_TYPES is exactly the three single-emission events', () => {
    expect([...TERMINAL_TYPES].sort()).toEqual(['ERROR', 'PENDING_APPROVAL', 'RESULT']);
  });
});

describe('resolveGatewayToken — upstream token hygiene (TCLAW-0F)', () => {
  it('uses a configured TORQCLAW_GATEWAY_TOKEN verbatim', () => {
    expect(resolveGatewayToken({ TORQCLAW_GATEWAY_TOKEN: 's3cret-token' })).toBe('s3cret-token');
  });

  it('unset token resolves to empty string, NOT the literal "dev"', () => {
    // The whole point of TCLAW-0F: no hardcoded guessable default upstream token.
    const resolved = resolveGatewayToken({});
    expect(resolved).toBe('');
    expect(resolved).not.toBe('dev');
  });

  it('an empty-string env value stays empty (not coerced to a literal)', () => {
    expect(resolveGatewayToken({ TORQCLAW_GATEWAY_TOKEN: '' })).toBe('');
  });

  it('never emits a hardcoded guessable token by default across unset/empty inputs', () => {
    for (const env of [{}, { TORQCLAW_GATEWAY_TOKEN: '' }, { TORQCLAW_GATEWAY_TOKEN: undefined }]) {
      const t = resolveGatewayToken(env as NodeJS.ProcessEnv);
      expect(t).toBe('');
      expect(['dev', 'default', 'token', 'changeme']).not.toContain(t);
    }
  });
});
