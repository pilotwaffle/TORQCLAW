import { describe, it, expect } from 'vitest';
import { isTerminal, TERMINAL_TYPES, resolveGatewayToken } from '../packages/channel-http/src/gatewayClient.js';
import { assertFrontDoorSafe, frontDoorOk } from '../packages/channel-http/src/server.js';

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
  it('uses only the dedicated channel service token', () => {
    expect(resolveGatewayToken({ TORQCLAW_CHANNEL_SERVICE_TOKEN: 'channel-token' })).toBe('channel-token');
    expect(resolveGatewayToken({ TORQCLAW_GATEWAY_TOKEN: 'legacy-token' })).toBe('');
  });

  it('unset token resolves to empty string, NOT the literal "dev"', () => {
    // The whole point of TCLAW-0F: no hardcoded guessable default upstream token.
    const resolved = resolveGatewayToken({});
    expect(resolved).toBe('');
    expect(resolved).not.toBe('dev');
  });

  it('an empty-string env value stays empty (not coerced to a literal)', () => {
    expect(resolveGatewayToken({ TORQCLAW_CHANNEL_SERVICE_TOKEN: '' })).toBe('');
  });

  it('never emits a hardcoded guessable token by default across unset/empty inputs', () => {
    for (const env of [{}, { TORQCLAW_CHANNEL_SERVICE_TOKEN: '' }, { TORQCLAW_CHANNEL_SERVICE_TOKEN: undefined }]) {
      const t = resolveGatewayToken(env as NodeJS.ProcessEnv);
      expect(t).toBe('');
      expect(['dev', 'default', 'token', 'changeme']).not.toContain(t);
    }
  });
});

describe('channel-http front-door auth binding (TCLAW-CH-AUTH)', () => {
  // The defect this pins: frontDoorOk() returned `true` for EVERY caller when
  // CHANNEL_HTTP_TOKEN was unset, and the only mitigation was a log line. That
  // is tolerable bound to loopback and unsafe bound to a routable interface --
  // but nothing in the module coupled those two facts, so a deploy that set
  // CHANNEL_HTTP_HOST=0.0.0.0 and forgot the token silently exposed an
  // unauthenticated front door onto the gateway.
  //
  // The repo's own convention (ops/launcher-config.mjs requireLoopbackHost /
  // requireProductionTokens) is to THROW rather than warn. assertFrontDoorSafe
  // applies that convention here.

  it('accepts an unset token when bound to loopback (dev mode preserved)', () => {
    expect(() => assertFrontDoorSafe({ host: '127.0.0.1', token: '' })).not.toThrow();
    expect(() => assertFrontDoorSafe({ host: 'localhost', token: '' })).not.toThrow();
    expect(() => assertFrontDoorSafe({ host: '::1', token: '' })).not.toThrow();
  });

  it('REFUSES to boot on a routable bind with no token', () => {
    expect(() => assertFrontDoorSafe({ host: '0.0.0.0', token: '' })).toThrow(/CHANNEL_HTTP_TOKEN/);
    expect(() => assertFrontDoorSafe({ host: '::', token: '' })).toThrow(/CHANNEL_HTTP_TOKEN/);
    expect(() => assertFrontDoorSafe({ host: '10.0.0.5', token: '' })).toThrow(/CHANNEL_HTTP_TOKEN/);
    expect(() => assertFrontDoorSafe({ host: '192.168.1.20', token: '' })).toThrow(/CHANNEL_HTTP_TOKEN/);
  });

  it('allows a routable bind once a real token is set', () => {
    expect(() => assertFrontDoorSafe({ host: '0.0.0.0', token: 's3cret' })).not.toThrow();
  });

  it('rejects placeholder tokens, which are worse than none (false confidence)', () => {
    for (const weak of ['dev', 'DEV', 'changeme', 'placeholder', 'token', 'secret']) {
      expect(() => assertFrontDoorSafe({ host: '0.0.0.0', token: weak })).toThrow(/placeholder/i);
    }
  });

  it('treats whitespace-only as unset rather than as a token', () => {
    expect(() => assertFrontDoorSafe({ host: '0.0.0.0', token: '   ' })).toThrow(/CHANNEL_HTTP_TOKEN/);
  });

  it('frontDoorOk still rejects a wrong token and accepts the right one', () => {
    expect(frontDoorOk('Bearer right', 'right')).toBe(true);
    expect(frontDoorOk('Bearer wrong', 'right')).toBe(false);
    expect(frontDoorOk(undefined, 'right')).toBe(false);
    // Unset token keeps the documented loopback-dev behaviour: open door.
    // Safety comes from assertFrontDoorSafe refusing that combination off-loopback.
    expect(frontDoorOk(undefined, '')).toBe(true);
  });
});
