import { describe, it, expect } from 'vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import { friendlyMessage, privacyHint, lineDiff } from '../apps/console/src/components/friendly.js';

function ev(partial: Partial<GatewayEvent>): GatewayEvent {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    requestId: null,
    sessionId: '00000000-0000-0000-0000-000000000002',
    tier: null,
    type: 'SYSTEM',
    message: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as GatewayEvent;
}

describe('friendlyMessage — TIER_SELECTED reasons', () => {
  const cases: Array<[string, RegExp]> = [
    ['PRIVACY_OVERRIDE: x', /staying on this machine/i],
    ['USER_LOCAL_ONLY: x', /this machine only/i],
    ['TOOL_COUNT_OVERFLOW: x', /several tools/i],
    ['LOW_CLASSIFIER_CONFIDENCE: x', /cloud model/i],
    ['LATENCY_CRITICAL: x', /waking up|cloud/i],
  ];
  for (const [reason, expected] of cases) {
    it(`renders ${reason.split(':')[0]}`, () => {
      const out = friendlyMessage(ev({ type: 'TIER_SELECTED', message: reason, metadata: { reason } }));
      expect(out).toMatch(expected);
    });
  }

  it('low heuristic score reads as local/free; high as cloud', () => {
    expect(friendlyMessage(ev({ type: 'TIER_SELECTED', message: 'HEURISTIC_EVAL', metadata: { reason: 'HEURISTIC_EVAL', score: 20 } }))).toMatch(/locally/i);
    expect(friendlyMessage(ev({ type: 'TIER_SELECTED', message: 'HEURISTIC_EVAL', metadata: { reason: 'HEURISTIC_EVAL', score: 80 } }))).toMatch(/cloud/i);
  });
});

describe('friendlyMessage — TOOL_CALL namespace stripping', () => {
  it('strips the server namespace prefix', () => {
    expect(friendlyMessage(ev({ type: 'TOOL_CALL', message: 'Executing filesystem__read_file' })))
      .toBe('Using read file (filesystem)');
  });
  it('handles an un-namespaced tool', () => {
    expect(friendlyMessage(ev({ type: 'TOOL_CALL', message: 'Executing web_search' })))
      .toBe('Using web search');
  });
});

describe('privacyHint — true positives', () => {
  it('flags an API key', () => expect(privacyHint('here is sk-abcdef0123456789xyz')).toMatch(/api key/i));
  it('flags a GitHub token', () => expect(privacyHint('token ghp_0123456789abcdef0123')).toMatch(/github/i));
  it('flags an AWS key', () => expect(privacyHint('AKIAIOSFODNN7EXAMPLE')).toMatch(/aws/i));
  it('flags a private key block', () => expect(privacyHint('-----BEGIN RSA PRIVATE KEY-----')).toMatch(/private key/i));
  it('flags an SSN shape', () => expect(privacyHint('my ssn is 123-45-6789')).toMatch(/ssn/i));
});

describe('privacyHint — false positives must NOT trip', () => {
  it('ordinary prose is clean', () => expect(privacyHint('plan a ski trip and summarize the lesson')).toBeNull());
  it('a short hyphenated number is not an SSN', () => expect(privacyHint('order 12-34')).toBeNull());
  it('the word "task" alone is clean', () => expect(privacyHint('write a task about skiing')).toBeNull());
  it('empty string is clean', () => expect(privacyHint('')).toBeNull());
});

describe('lineDiff (P4 skill edit)', () => {
  it('identical text is all unchanged', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(d.every((r) => r.t === ' ')).toBe(true);
    expect(d.map((r) => r.line)).toEqual(['a', 'b', 'c']);
  });
  it('a changed middle line shows as remove + add', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(d.filter((r) => r.t === '-').map((r) => r.line)).toContain('b');
    expect(d.filter((r) => r.t === '+').map((r) => r.line)).toContain('B');
    // unchanged anchors survive
    expect(d.filter((r) => r.t === ' ').map((r) => r.line)).toEqual(['a', 'c']);
  });
  it('pure addition only adds', () => {
    const d = lineDiff('a', 'a\nb');
    expect(d.find((r) => r.t === '+')?.line).toBe('b');
    expect(d.some((r) => r.t === '-')).toBe(false);
  });
  it('pure deletion only removes', () => {
    const d = lineDiff('a\nb', 'a');
    expect(d.find((r) => r.t === '-')?.line).toBe('b');
    expect(d.some((r) => r.t === '+')).toBe(false);
  });
});
