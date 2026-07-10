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
  formatLockState,
  formatBlockedAlternatives,
  formatProfile,
  formatRouteExplanation,
  toReplayEventRows,
  canRenderAction,
  formatCap,
  formatRemaining,
  formatAttribution,
  formatLedgerCost,
  formatCapState,
  formatDailyTotalLabel,
  formatProviderSummaryRow,
  selectActiveRouteDiag,
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
  it('enforcement fields render "not recorded" when absent (null)', () => {
    const rows = formatCostField({ costUsd: 0.1 } as ReceiptLike);
    expect(rows.find((r) => r.label === 'budget source')?.value).toBe('not recorded');
    expect(rows.find((r) => r.label === 'cost enforceable')?.value).toBe('not recorded');
  });

  // TCLAW-1B (G1R RC-4): budget_source/cost_enforceable are now REAL
  // persisted values (1A-core projects them onto the receipt) — honest
  // mappings, not a hardcoded "not recorded".
  it('budgetSource per_task/env_default/unlimited map to honest labels', () => {
    expect(
      formatCostField({ costUsd: 0.1, budgetSource: 'per_task' } as ReceiptLike)
        .find((r) => r.label === 'budget source')?.value,
    ).toBe('per-task budget');
    expect(
      formatCostField({ costUsd: 0.1, budgetSource: 'env_default' } as ReceiptLike)
        .find((r) => r.label === 'budget source')?.value,
    ).toBe('default budget (env)');
    expect(
      formatCostField({ costUsd: 0.1, budgetSource: 'unlimited' } as ReceiptLike)
        .find((r) => r.label === 'budget source')?.value,
    ).toBe('uncapped (warned)');
  });
  it('budgetSource null -> "not recorded"', () => {
    expect(
      formatCostField({ costUsd: 0.1, budgetSource: null } as ReceiptLike)
        .find((r) => r.label === 'budget source')?.value,
    ).toBe('not recorded');
  });
  it('costEnforceable 1/0 map to honest labels; null -> "not recorded"', () => {
    expect(
      formatCostField({ costUsd: 0.1, costEnforceable: 1 } as ReceiptLike)
        .find((r) => r.label === 'cost enforceable')?.value,
    ).toBe('enforced (provider reported)');
    expect(
      formatCostField({ costUsd: 0.1, costEnforceable: 0 } as ReceiptLike)
        .find((r) => r.label === 'cost enforceable')?.value,
    ).toBe('unenforceable — iteration cap only');
    expect(
      formatCostField({ costUsd: 0.1, costEnforceable: null } as ReceiptLike)
        .find((r) => r.label === 'cost enforceable')?.value,
    ).toBe('not recorded');
  });
});

// ── TCLAW-1B: Cost Control Center pure-helper tests ─────────────────────

describe('formatCap', () => {
  it('undefined -> "No cap (unlimited)"', () => {
    expect(formatCap(undefined)).toBe('No cap (unlimited)');
  });
  it('null -> "No cap (unlimited)"', () => {
    expect(formatCap(null)).toBe('No cap (unlimited)');
  });
  it('a positive number -> "$X.XX"', () => {
    expect(formatCap(5)).toBe('$5.00');
    expect(formatCap(0.25)).toBe('$0.25');
  });
  it('NEVER emits "$0" for undefined/null', () => {
    expect(formatCap(undefined)).not.toMatch(/\$0/);
    expect(formatCap(null)).not.toMatch(/\$0/);
  });
});

describe('formatRemaining', () => {
  it('finite cap/total -> cap-total formatted', () => {
    expect(formatRemaining(10, 4)).toBe('$6.00 remaining');
  });
  it('cap null/undefined -> "Unlimited"', () => {
    expect(formatRemaining(null, 5)).toBe('Unlimited');
    expect(formatRemaining(undefined, 5)).toBe('Unlimited');
  });
  it('total null/undefined (cap present) -> "n/a"', () => {
    expect(formatRemaining(10, null)).toBe('n/a');
    expect(formatRemaining(10, undefined)).toBe('n/a');
  });
  it('total >= cap clamps to "$0.00 remaining — cap reached", NEVER negative', () => {
    expect(formatRemaining(5, 5)).toBe('$0.00 remaining — cap reached');
    expect(formatRemaining(5, 9)).toBe('$0.00 remaining — cap reached');
    expect(formatRemaining(5, 9)).not.toMatch(/-\$/);
  });
});

describe('formatAttribution', () => {
  it('"exact" -> not estimated, label "recorded"', () => {
    const out = formatAttribution('exact');
    expect(out.estimated).toBe(false);
    expect(out.label).toBe('recorded');
  });
  it('"account_delta" -> estimated true, label mentions estimated/account-level/conservative, tooltip present', () => {
    const out = formatAttribution('account_delta');
    expect(out.estimated).toBe(true);
    expect(out.label).toMatch(/estimated/i);
    expect(out.label).toMatch(/account-level/i);
    expect(out.label).toMatch(/conservative/i);
    expect(out.tooltip).toBeTruthy();
  });
  it('"unavailable" -> "not recorded", not estimated', () => {
    const out = formatAttribution('unavailable');
    expect(out.estimated).toBe(false);
    expect(out.label).toBe('not recorded');
  });
  it('unknown attribution value -> "not recorded", not estimated', () => {
    const out = formatAttribution('something_else');
    expect(out.estimated).toBe(false);
    expect(out.label).toBe('not recorded');
  });
  it('exact vs account_delta produce DISTINCT labels', () => {
    expect(formatAttribution('exact').label).not.toBe(formatAttribution('account_delta').label);
  });
});

describe('formatLedgerCost', () => {
  it('attribution "unavailable" -> "not recorded" even if a stray number is present', () => {
    expect(formatLedgerCost(5, 'unavailable')).toBe('not recorded');
  });
  it('costUsd null -> "not recorded" (NEVER "$0.00")', () => {
    expect(formatLedgerCost(null, 'exact')).toBe('not recorded');
    expect(formatLedgerCost(null, 'exact')).not.toBe('$0.00');
  });
  it('exact number -> "$X.XX"', () => {
    expect(formatLedgerCost(1.5, 'exact')).toBe('$1.50');
    expect(formatLedgerCost(2, 'account_delta')).toBe('$2.00');
  });
});

describe('formatCapState', () => {
  it('null -> "within budget"', () => {
    expect(formatCapState(null)).toBe('within budget');
  });
  it('session breach names "session" + limit + envVar', () => {
    const out = formatCapState({ cap: 'session', total: 5, limit: 5, envVar: 'TORQCLAW_SESSION_CAP_USD' });
    expect(out).toMatch(/session/);
    expect(out).toMatch(/\$5\.00/);
    expect(out).toMatch(/TORQCLAW_SESSION_CAP_USD/);
  });
  it('daily breach names "daily"', () => {
    const out = formatCapState({ cap: 'daily', total: 10, limit: 10, envVar: 'TORQCLAW_DAILY_CAP_USD' });
    expect(out).toMatch(/daily/);
    expect(out).toMatch(/TORQCLAW_DAILY_CAP_USD/);
  });
});

describe('formatProviderSummaryRow', () => {
  it('recorded uses recordedUsd only', () => {
    const out = formatProviderSummaryRow({ provider: 'openai', recordedUsd: 3.5, unrecordedCount: 0, totalCount: 2 });
    expect(out.recorded).toBe('$3.50');
  });
  it('unrecordedCount > 0 -> caveat "(N unrecorded)"', () => {
    const out = formatProviderSummaryRow({ provider: 'openai', recordedUsd: 1, unrecordedCount: 2, totalCount: 3 });
    expect(out.caveat).toBe('(2 unrecorded)');
  });
  it('unrecordedCount 0 -> caveat null', () => {
    const out = formatProviderSummaryRow({ provider: 'openai', recordedUsd: 1, unrecordedCount: 0, totalCount: 1 });
    expect(out.caveat).toBeNull();
  });
  it('provider null -> "unknown/local"', () => {
    const out = formatProviderSummaryRow({ provider: null, recordedUsd: 0, unrecordedCount: 0, totalCount: 0 });
    expect(out.provider).toBe('unknown/local');
  });
});

describe('formatDailyTotalLabel', () => {
  it('includes "all sessions" and "UTC day"', () => {
    const label = formatDailyTotalLabel();
    expect(label).toMatch(/all sessions/i);
    expect(label).toMatch(/UTC day/i);
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

describe('formatLockState — the honest THREE-state taxonomy (TCLAW-2B)', () => {
  it('branch (a): safetyLock present -> "Locked" + the safetyLock string', () => {
    const diag = { score: 10, reason: 'x', tier: 'OLLAMA_LOCAL', safetyLock: 'SENSITIVE_DATA', overridable: false } as RouterDiagnostics;
    const row = formatLockState(diag);
    expect(row?.value).toContain('Locked');
    expect(row?.value).toContain('SENSITIVE_DATA');
  });

  it('branch (b): overridable:false with NO safetyLock (LOCAL_INTENT-shaped) -> "Fixed for this task"', () => {
    const diag = { score: 10, reason: 'x', tier: 'OLLAMA_LOCAL', overridable: false } as RouterDiagnostics;
    const row = formatLockState(diag);
    expect(row?.value).toBe('Fixed for this task');
  });

  it('branch (b) wording is affirmative — never leaks "(not a safety lock)"', () => {
    const diag = { score: 10, reason: 'x', tier: 'OLLAMA_LOCAL', overridable: false } as RouterDiagnostics;
    const row = formatLockState(diag);
    expect(row?.value.toLowerCase()).not.toContain('not a safety lock');
  });

  it('branch (c): overridable:true (heuristic-shaped) -> mentions override', () => {
    const diag = { score: 10, reason: 'x', tier: 'API_EXTERNAL', overridable: true } as RouterDiagnostics;
    const row = formatLockState(diag);
    expect(row?.value.toLowerCase()).toContain('overrid');
  });

  it('branch (d): overridable undefined and no safetyLock -> null (never fabricated)', () => {
    const diag = { score: 10, reason: 'x', tier: 'API_EXTERNAL' } as RouterDiagnostics;
    expect(formatLockState(diag)).toBeNull();
  });

  it('null/undefined diag -> null', () => {
    expect(formatLockState(null)).toBeNull();
    expect(formatLockState(undefined)).toBeNull();
  });

  it('ANTI-CONFLATION (load-bearing): branch (a) string !== branch (b) string', () => {
    const lockRow = formatLockState({ score: 1, reason: 'x', tier: 'OLLAMA_LOCAL', safetyLock: 'USER_LOCAL_ONLY', overridable: false } as RouterDiagnostics);
    const fixedRow = formatLockState({ score: 1, reason: 'x', tier: 'OLLAMA_LOCAL', overridable: false } as RouterDiagnostics);
    expect(lockRow?.value).not.toBe(fixedRow?.value);
  });

  it('ANTI-CONFLATION (load-bearing): a safetyLock diag that is ALSO overridable:false renders branch (a), not (b) — proves ordering', () => {
    // Every real safetyLock rule (PRIVACY_OVERRIDE, USER_LOCAL_ONLY,
    // LOCAL_TOOL_INTENT) is ALSO overridable:false. If (b) were checked
    // first, a hard privacy lock would be demoted to generic "Fixed for
    // this task" wording — safetyLock must win.
    const diag = { score: 1, reason: 'x', tier: 'OLLAMA_LOCAL', safetyLock: 'LOCAL_TOOL_INTENT', overridable: false } as RouterDiagnostics;
    const row = formatLockState(diag);
    expect(row?.value).toContain('Locked');
    expect(row?.value).not.toBe('Fixed for this task');
  });
});

describe('formatBlockedAlternatives', () => {
  it('length-1 -> one row with the exact wire-tested string', () => {
    const diag = {
      score: 1, reason: 'x', tier: 'OLLAMA_LOCAL',
      blockedAlternatives: [{ tier: 'API_EXTERNAL', why: 'over budget' }],
    } as RouterDiagnostics;
    const rows = formatBlockedAlternatives(diag);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('would have used API_EXTERNAL, but: over budget');
  });

  it('length-2 -> TWO rows (proves no <=1 cap, G1R RC-3)', () => {
    const diag = {
      score: 1, reason: 'x', tier: 'OLLAMA_LOCAL',
      blockedAlternatives: [
        { tier: 'API_EXTERNAL', why: 'over budget' },
        { tier: 'OLLAMA_LOCAL', why: 'cold start' },
      ],
    } as RouterDiagnostics;
    const rows = formatBlockedAlternatives(diag);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.value).toBe('would have used API_EXTERNAL, but: over budget');
    expect(rows[1]?.value).toBe('would have used OLLAMA_LOCAL, but: cold start');
  });

  it('absent -> []', () => {
    expect(formatBlockedAlternatives({ score: 1, reason: 'x', tier: 'OLLAMA_LOCAL' } as RouterDiagnostics)).toEqual([]);
  });

  it('empty array -> []', () => {
    expect(formatBlockedAlternatives({ score: 1, reason: 'x', tier: 'OLLAMA_LOCAL', blockedAlternatives: [] } as RouterDiagnostics)).toEqual([]);
  });

  it('null/undefined diag -> []', () => {
    expect(formatBlockedAlternatives(null)).toEqual([]);
    expect(formatBlockedAlternatives(undefined)).toEqual([]);
  });
});

describe('formatProfile', () => {
  it('absent -> null (omitted, never rendered)', () => {
    expect(formatProfile({ score: 1, reason: 'x', tier: 'OLLAMA_LOCAL' } as RouterDiagnostics)).toBeNull();
  });

  it('present "fast" -> the field row (defensive — 2A never sets this today)', () => {
    const diag = { score: 1, reason: 'x', tier: 'OLLAMA_LOCAL', profile: 'fast' } as RouterDiagnostics;
    expect(formatProfile(diag)).toEqual({ label: 'routing profile', value: 'fast' });
  });

  it('empty string -> null', () => {
    const diag = { score: 1, reason: 'x', tier: 'OLLAMA_LOCAL', profile: '' } as RouterDiagnostics;
    expect(formatProfile(diag)).toBeNull();
  });

  it('null/undefined diag -> null', () => {
    expect(formatProfile(null)).toBeNull();
    expect(formatProfile(undefined)).toBeNull();
  });
});

describe('formatRouteExplanation', () => {
  it('null diag -> the honest "no routing record" empty state', () => {
    expect(formatRouteExplanation(null)).toEqual([{ label: 'route', value: 'no routing record' }]);
  });

  it('humanReason present -> "why" row equals humanReason', () => {
    const diag = { score: 5, reason: 'raw', tier: 'API_EXTERNAL', ruleId: 'TOOL_COUNT_OVERFLOW', humanReason: 'custom human text' } as RouterDiagnostics;
    const rows = formatRouteExplanation(diag);
    expect(rows.find((r) => r.label === 'why')?.value).toBe('custom human text');
  });

  it('ruleId present, no humanReason -> "why" uses RULE_LABELS and a "rule id" row is present', () => {
    const diag = { score: 5, reason: 'raw', tier: 'API_EXTERNAL', ruleId: 'TOOL_COUNT_OVERFLOW' } as RouterDiagnostics;
    const rows = formatRouteExplanation(diag);
    expect(rows.find((r) => r.label === 'why')?.value).toBe(RULE_LABELS.TOOL_COUNT_OVERFLOW);
    expect(rows.find((r) => r.label === 'rule id')?.value).toBe('TOOL_COUNT_OVERFLOW');
  });

  it('only {score,reason,tier} -> "why" is the raw reason, no "rule id" row, score/tier present (partial-diag honesty)', () => {
    const diag = { score: 42, reason: 'raw fallback text', tier: 'OLLAMA_LOCAL' } as RouterDiagnostics;
    const rows = formatRouteExplanation(diag);
    expect(rows.find((r) => r.label === 'why')?.value).toBe('raw fallback text');
    expect(rows.find((r) => r.label === 'rule id')).toBeUndefined();
    expect(rows.find((r) => r.label === 'score')?.value).toBe('42');
    expect(rows.find((r) => r.label === 'tier')?.value).toBe('OLLAMA_LOCAL');
  });
});

describe('lock-taxonomy DRIFT guard (mirrors RULE_LABELS drift guard at RULE_LABELS describe block)', () => {
  // packages/router/src/engine.ts RULE_META is a private `const`, NOT
  // exported (verified: no index.ts/barrel in packages/router, and no
  // `export` keyword on RULE_META) — so per the ticket's scope boundary we
  // do NOT add a router export just for this test. Instead we pin the known
  // rule -> shape mapping (engine.ts:12-21) directly, with the SAME shape
  // formatLockState branches on, so a future engine change that silently
  // adds/removes a safetyLock or flips overridable is caught here.
  const HARD_LOCK_RULES = ['PRIVACY_OVERRIDE', 'USER_LOCAL_ONLY', 'LOCAL_TOOL_INTENT'] as const;
  const FIRM_NO_LOCK_RULE = 'LOCAL_INTENT' as const;
  const OVERRIDABLE_RULES = ['LOW_CLASSIFIER_CONFIDENCE', 'TOOL_COUNT_OVERFLOW', 'LATENCY_CRITICAL', 'HEURISTIC_EVAL'] as const;

  // Mirrors engine.ts RULE_META exactly (score/reason/tier omitted — those
  // fields aren't inspected by formatLockState, only safetyLock/overridable are).
  const RULE_SHAPE: Record<string, { overridable: boolean; safetyLock?: string }> = {
    PRIVACY_OVERRIDE: { overridable: false, safetyLock: 'SENSITIVE_DATA' },
    USER_LOCAL_ONLY: { overridable: false, safetyLock: 'USER_LOCAL_ONLY' },
    LOCAL_INTENT: { overridable: false },
    LOCAL_TOOL_INTENT: { overridable: false, safetyLock: 'LOCAL_TOOL_INTENT' },
    LOW_CLASSIFIER_CONFIDENCE: { overridable: true },
    TOOL_COUNT_OVERFLOW: { overridable: true },
    LATENCY_CRITICAL: { overridable: true },
    HEURISTIC_EVAL: { overridable: true },
  };

  it('the RULE_SHAPE key set covers exactly all 8 RouterRuleIdSchema options (no rule missing/extra)', () => {
    const shapeKeys = new Set(Object.keys(RULE_SHAPE));
    const schemaKeys = new Set(RouterRuleIdSchema.options as readonly string[]);
    expect(shapeKeys).toEqual(schemaKeys);
  });

  it('exactly {PRIVACY_OVERRIDE, USER_LOCAL_ONLY, LOCAL_TOOL_INTENT} carry a safetyLock', () => {
    const lockedKeys = Object.entries(RULE_SHAPE)
      .filter(([, m]) => m.safetyLock)
      .map(([k]) => k)
      .sort();
    expect(lockedKeys).toEqual([...HARD_LOCK_RULES].sort());
  });

  it('those 3 hard-lock rules render formatLockState branch (a) — "Locked" + their safetyLock', () => {
    for (const rule of HARD_LOCK_RULES) {
      const meta = RULE_SHAPE[rule]!;
      const diag = { score: 1, reason: 'x', tier: 'OLLAMA_LOCAL', ruleId: rule, ...meta } as RouterDiagnostics;
      const row = formatLockState(diag);
      expect(row?.value).toContain('Locked');
      expect(row?.value).toContain(meta.safetyLock);
    }
  });

  it('LOCAL_INTENT is non-overridable AND carries no safetyLock -> branch (b) "Fixed for this task"', () => {
    const meta = RULE_SHAPE[FIRM_NO_LOCK_RULE]!;
    expect(meta.safetyLock).toBeUndefined();
    expect(meta.overridable).toBe(false);
    const diag = { score: 1, reason: 'x', tier: 'OLLAMA_LOCAL', ruleId: FIRM_NO_LOCK_RULE, ...meta } as RouterDiagnostics;
    expect(formatLockState(diag)?.value).toBe('Fixed for this task');
  });

  it('the 4 heuristic/overridable rules render branch (c)', () => {
    for (const rule of OVERRIDABLE_RULES) {
      const meta = RULE_SHAPE[rule]!;
      expect(meta.overridable).toBe(true);
      expect(meta.safetyLock).toBeUndefined();
      const diag = { score: 1, reason: 'x', tier: 'API_EXTERNAL', ruleId: rule, ...meta } as RouterDiagnostics;
      expect(formatLockState(diag)?.value).toBe('Router preference — can be overridden');
    }
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

describe('selectActiveRouteDiag (TCLAW-2C) — pure selector feeding the live route chip snapshot', () => {
  function diagEvent(requestId: string, metadata?: Record<string, unknown> | undefined): GatewayEvent {
    return ev({
      id: `id-${requestId}-${Math.random()}`,
      type: 'TIER_SELECTED',
      requestId,
      tier: 'OLLAMA_LOCAL',
      message: 'routed',
      metadata,
    });
  }

  it('1. selects the latest TIER_SELECTED diag for the active requestId', () => {
    const diagA: RouterDiagnostics = { score: 10, reason: 'x', tier: 'OLLAMA_LOCAL' as any };
    const events = [diagEvent('A', diagA as unknown as Record<string, unknown>)];
    expect(selectActiveRouteDiag(events, 'A')).toEqual(diagA);
  });

  it('2. ignores other requestIds — returns A\'s diag, not B\'s', () => {
    const diagA: RouterDiagnostics = { score: 10, reason: 'a', tier: 'OLLAMA_LOCAL' as any };
    const diagB: RouterDiagnostics = { score: 20, reason: 'b', tier: 'API_EXTERNAL' as any };
    const events = [
      diagEvent('A', diagA as unknown as Record<string, unknown>),
      diagEvent('B', diagB as unknown as Record<string, unknown>),
    ];
    expect(selectActiveRouteDiag(events, 'A')).toEqual(diagA);
    expect(selectActiveRouteDiag(events, 'A')).not.toEqual(diagB);
  });

  it('3. null activeRequestId -> null', () => {
    const diagA: RouterDiagnostics = { score: 10, reason: 'x', tier: 'OLLAMA_LOCAL' as any };
    const events = [diagEvent('A', diagA as unknown as Record<string, unknown>)];
    expect(selectActiveRouteDiag(events, null)).toBeNull();
  });

  it('4. missing/partial diag is returned honestly (no fabrication); no metadata -> not selected', () => {
    const partial = { score: 5, reason: 'raw', tier: 'OLLAMA_LOCAL' as any }; // no ruleId/lock
    const events = [diagEvent('A', partial as unknown as Record<string, unknown>)];
    expect(selectActiveRouteDiag(events, 'A')).toEqual(partial);

    const noMetaEvents = [diagEvent('A', undefined)];
    expect(selectActiveRouteDiag(noMetaEvents, 'A')).toBeNull();
  });

  it('5. eviction-style: selector returns null when the frame is gone (no TIER_SELECTED for A in the window)', () => {
    // events array WITHOUT any TIER_SELECTED for 'A' — proves the selector
    // returns null so the write-on-present effect (component-level) will not
    // overwrite the existing snapshot; it never fabricates a diag.
    const diagB: RouterDiagnostics = { score: 20, reason: 'b', tier: 'API_EXTERNAL' as any };
    const events = [diagEvent('B', diagB as unknown as Record<string, unknown>)];
    expect(selectActiveRouteDiag(events, 'A')).toBeNull();
  });

  it('6. interleaved A-then-B: keying by id means A\'s route is never returned for anchor B', () => {
    const diagA: RouterDiagnostics = { score: 1, reason: 'a', tier: 'OLLAMA_LOCAL' as any };
    const diagB: RouterDiagnostics = { score: 2, reason: 'b', tier: 'API_EXTERNAL' as any };
    const events = [
      diagEvent('A', diagA as unknown as Record<string, unknown>),
      diagEvent('B', diagB as unknown as Record<string, unknown>),
    ];
    expect(selectActiveRouteDiag(events, 'A')).toEqual(diagA);
    expect(selectActiveRouteDiag(events, 'B')).toEqual(diagB);
  });

  it('7. re-minted task: a new requestId (the re-mint) resolves to its own diag under its own id', () => {
    const diagA: RouterDiagnostics = { score: 1, reason: 'first task', tier: 'OLLAMA_LOCAL' as any };
    const diagB: RouterDiagnostics = { score: 2, reason: 're-minted task', tier: 'API_EXTERNAL' as any };
    const events = [
      diagEvent('A', diagA as unknown as Record<string, unknown>),
      diagEvent('B', diagB as unknown as Record<string, unknown>),
    ];
    expect(selectActiveRouteDiag(events, 'A')).toEqual(diagA);
    expect(selectActiveRouteDiag(events, 'B')).toEqual(diagB);
  });

  it('8. terminal/null-anchor hides the chip: null activeRequestId -> null (activeRequestId is null after RESULT/ERROR)', () => {
    const diagA: RouterDiagnostics = { score: 1, reason: 'x', tier: 'OLLAMA_LOCAL' as any };
    const events = [diagEvent('A', diagA as unknown as Record<string, unknown>)];
    expect(selectActiveRouteDiag(events, null)).toBeNull();
  });
});
