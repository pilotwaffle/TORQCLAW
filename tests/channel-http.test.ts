import { describe, it, expect } from 'vitest';
import { isTerminal, TERMINAL_TYPES } from '../packages/channel-http/src/gatewayClient.js';

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
