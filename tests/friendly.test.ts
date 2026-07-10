import { describe, it, expect } from 'vitest';
import type { GatewayEvent, RouterDiagnostics } from '@torqclaw/contracts';
import { RouterRuleIdSchema } from '@torqclaw/contracts';
import {
  friendlyMessage,
  privacyHint,
  lineDiff,
  field,
  RULE_LABELS,
  formatReceiptState,
  formatCostField,
  formatRouteDiagnostics,
  toReplayEventRows,
  canRenderAction,
  type ReceiptLike,
} from '../apps/console/src/components/friendly.js';

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

// ── TCLAW-4B-2: receipt-panel pure helpers ──────────────────────────────

describe('field', () => {
  it('null/undefined/empty-string are omitted', () => {
    expect(field('x', null)).toBeNull();
    expect(field('x', undefined)).toBeNull();
    expect(field('x', '')).toBeNull();
  });
  it('a real 0 is rendered, not treated as absent', () => {
    expect(field('count', 0)).toEqual({ label: 'count', value: '0' });
  });
  it('a real false is rendered, not treated as absent', () => {
    expect(field('flag', false)).toEqual({ label: 'flag', value: 'false' });
  });
  it('numbers and strings render as-is (stringified)', () => {
    expect(field('n', 42)).toEqual({ label: 'n', value: '42' });
    expect(field('s', 'hello')).toEqual({ label: 's', value: 'hello' });
  });
});

describe('RULE_LABELS', () => {
  it('every key has a non-empty string label', () => {
    for (const key of Object.keys(RULE_LABELS)) {
      expect(typeof RULE_LABELS[key as keyof typeof RULE_LABELS]).toBe('string');
      expect(RULE_LABELS[key as keyof typeof RULE_LABELS].length).toBeGreaterThan(0);
    }
  });
  it('the key set is exactly RouterRuleIdSchema.options (drift guard)', () => {
    const labelKeys = new Set(Object.keys(RULE_LABELS));
    const schemaKeys = new Set(RouterRuleIdSchema.options as readonly string[]);
    expect(labelKeys).toEqual(schemaKeys);
  });
});

describe('formatReceiptState', () => {
  it('null receipt -> unknown', () => {
    expect(formatReceiptState(null)).toEqual({ label: 'unknown' });
  });
  it('null resultState -> unknown', () => {
    expect(formatReceiptState({ resultState: null } as ReceiptLike)).toEqual({ label: 'unknown' });
  });
  it('completed', () => {
    expect(formatReceiptState({ resultState: 'completed' } as ReceiptLike).label).toBe('Completed');
  });
  it('failed', () => {
    expect(formatReceiptState({ resultState: 'failed' } as ReceiptLike).label).toBe('Failed');
  });
  it('blocked surfaces blockedOn', () => {
    const out = formatReceiptState({ resultState: 'blocked', blockedOn: 'tool_approval' } as ReceiptLike);
    expect(out.label).toBe('Blocked');
    expect(out.blockedOn).toBe('tool_approval');
  });
  it('cancelled surfaces as a badge (0|1|bool tolerant)', () => {
    expect(formatReceiptState({ resultState: 'cancelled', cancelled: true } as ReceiptLike).cancelled).toBe(true);
    expect(formatReceiptState({ resultState: 'cancelled', cancelled: 1 } as ReceiptLike).cancelled).toBe(true);
  });
});

describe('formatCostField', () => {
  it('a real costUsd number renders as $X.XX', () => {
    const rows = formatCostField({ costUsd: 1.5 } as ReceiptLike);
    expect(rows.find((r) => r.label === 'cost')?.value).toBe('$1.50');
  });
  it('null costUsd renders "not recorded", NEVER "$0.00"', () => {
    const rows = formatCostField({ costUsd: null } as ReceiptLike);
    const costRow = rows.find((r) => r.label === 'cost');
    expect(costRow?.value).toBe('not recorded');
    expect(costRow?.value).not.toBe('$0.00');
  });
  it('null receipt renders "not recorded" for cost', () => {
    const rows = formatCostField(null);
    expect(rows.find((r) => r.label === 'cost')?.value).toBe('not recorded');
  });
  it('budgetLimit present renders a budget row', () => {
    const rows = formatCostField({ costUsd: 0.1, budgetLimit: 5 } as ReceiptLike);
    expect(rows.find((r) => r.label === 'budget')?.value).toBe('budget $5');
  });
  it('budgetLimit absent omits the budget row', () => {
    const rows = formatCostField({ costUsd: 0.1 } as ReceiptLike);
    expect(rows.find((r) => r.label === 'budget')).toBeUndefined();
  });
  it('enforcement fields are always "not recorded" (null in v1)', () => {
    const rows = formatCostField({ costUsd: 0.1 } as ReceiptLike);
    expect(rows.find((r) => r.label === 'budget source')?.value).toBe('not recorded');
    expect(rows.find((r) => r.label === 'cost enforceable')?.value).toBe('not recorded');
  });
});

describe('formatRouteDiagnostics', () => {
  it('null routeDiagnostics -> single "no routing record" row', () => {
    const rows = formatRouteDiagnostics(null);
    expect(rows).toEqual([{ label: 'route', value: 'no routing record' }]);
  });
  it('known ruleId uses RULE_LABELS when no humanReason', () => {
    const diag: RouterDiagnostics = { score: 10, reason: 'TOOL_COUNT_OVERFLOW: raw', tier: 'API_EXTERNAL' as any, ruleId: 'TOOL_COUNT_OVERFLOW' };
    const rows = formatRouteDiagnostics(diag);
    expect(rows.find((r) => r.label === 'rule')?.value).toBe(RULE_LABELS.TOOL_COUNT_OVERFLOW);
  });
  it('humanReason wins over RULE_LABELS when present', () => {
    const diag: RouterDiagnostics = { score: 10, reason: 'raw', tier: 'API_EXTERNAL' as any, ruleId: 'TOOL_COUNT_OVERFLOW', humanReason: 'custom human text' };
    const rows = formatRouteDiagnostics(diag);
    expect(rows.find((r) => r.label === 'rule')?.value).toBe('custom human text');
  });
  it('absent/unknown ruleId falls back to the raw reason string', () => {
    const diag: RouterDiagnostics = { score: 10, reason: 'raw fallback text', tier: 'OLLAMA_LOCAL' as any };
    const rows = formatRouteDiagnostics(diag);
    expect(rows.find((r) => r.label === 'rule')?.value).toBe('raw fallback text');
  });
  it('blockedAlternatives render as "would have used X, but: why"', () => {
    const diag: RouterDiagnostics = {
      score: 10, reason: 'x', tier: 'OLLAMA_LOCAL' as any,
      blockedAlternatives: [{ tier: 'API_EXTERNAL' as any, why: 'over budget' }],
    };
    const rows = formatRouteDiagnostics(diag);
    expect(rows.find((r) => r.label === 'blocked alternative')?.value).toBe('would have used API_EXTERNAL, but: over budget');
  });
});

describe('toReplayEventRows', () => {
  function mkEvent(seq: number, type: GatewayEvent['type'] = 'SYSTEM'): GatewayEvent {
    return {
      seq,
      id: `id-${seq}`,
      requestId: null,
      sessionId: '00000000-0000-0000-0000-000000000002',
      tier: null,
      type,
      message: `msg-${seq}`,
      timestamp: '2026-01-01T00:00:00.000Z',
    } as GatewayEvent;
  }

  it('preserves seq order even when input is out of order', () => {
    const input = [mkEvent(3), mkEvent(1), mkEvent(2)];
    const rows = toReplayEventRows(input);
    expect(rows.map((r) => r.raw.seq)).toEqual([1, 2, 3]);
  });

  it('returns data rows with no callback/dispatch fields', () => {
    const input = [mkEvent(1, 'PENDING_APPROVAL'), mkEvent(2, 'ERROR')];
    const rows = toReplayEventRows(input);
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        expect(typeof v).not.toBe('function');
        expect(k).not.toMatch(/^onDecide/);
        expect(k).not.toMatch(/^onRetry/);
        expect(k).not.toMatch(/^onResend/);
        expect(k).not.toMatch(/^onGetDraft/);
        expect(k).not.toBe('sendCommand');
      }
      // raw is the original GatewayEvent (data), not a dispatch handle.
      expect(typeof row.raw).toBe('object');
    }
  });
});

describe('canRenderAction — the load-bearing safety matrix', () => {
  function mkEvent(type: GatewayEvent['type'], metadata?: Record<string, unknown>): GatewayEvent {
    return {
      id: 'id-1',
      requestId: null,
      sessionId: '00000000-0000-0000-0000-000000000002',
      tier: null,
      type,
      message: 'x',
      timestamp: '2026-01-01T00:00:00.000Z',
      metadata,
    } as GatewayEvent;
  }

  const skillApproval = mkEvent('PENDING_APPROVAL', { queueId: 'q1' });
  const toolApproval = mkEvent('PENDING_APPROVAL', { approvalId: 'a1' });
  const errorRecovery = mkEvent('ERROR', { recovery: ['RETRY'], prompt: 'do it' });
  const controlEvent = mkEvent('SYSTEM', { receiptList: true });
  const benignSystem = mkEvent('SYSTEM', {});

  it('readOnly=true -> false for every actionable/benign event', () => {
    expect(canRenderAction(skillApproval, true)).toBe(false);
    expect(canRenderAction(toolApproval, true)).toBe(false);
    expect(canRenderAction(errorRecovery, true)).toBe(false);
    expect(canRenderAction(controlEvent, true)).toBe(false);
    expect(canRenderAction(benignSystem, true)).toBe(false);
  });

  it('readOnly=false -> true for every actionable/benign event (live path unchanged)', () => {
    expect(canRenderAction(skillApproval, false)).toBe(true);
    expect(canRenderAction(toolApproval, false)).toBe(true);
    expect(canRenderAction(errorRecovery, false)).toBe(true);
    expect(canRenderAction(controlEvent, false)).toBe(true);
    expect(canRenderAction(benignSystem, false)).toBe(true);
  });
});
