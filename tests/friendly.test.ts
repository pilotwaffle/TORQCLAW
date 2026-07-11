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
  selectLatestRoutePreview,
  isPanelSystemFrame,
  isBusyNeutralEvent,
  selectLatestApprovalList,
  formatApprovalStatus,
  formatGateFacts,
  formatApprovalTimestamp,
  toApprovalHistoryRows,
  type ReceiptLike,
  type ApprovalSummaryLike,
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

describe('selectLatestRoutePreview (TCLAW-2D-2) — pure selector feeding the route preview panel snapshot', () => {
  function previewEvent(nonce: string, overrides: Record<string, unknown> = {}): GatewayEvent {
    return ev({
      id: `id-preview-${nonce}-${Math.random()}`,
      type: 'SYSTEM',
      requestId: null,
      tier: null,
      message: 'Route preview',
      metadata: { routePreview: true, previewOf: nonce, diagnostics: { score: 1, reason: 'x', tier: 'OLLAMA_LOCAL' }, ...overrides },
    });
  }

  it('1. matches by nonce, last-wins across two matching frames', () => {
    const first = previewEvent('n1', { diagnostics: { score: 1, reason: 'first', tier: 'OLLAMA_LOCAL' } });
    const second = previewEvent('n1', { diagnostics: { score: 2, reason: 'second', tier: 'API_EXTERNAL' } });
    const events = [first, second];
    expect(selectLatestRoutePreview(events, 'n1')).toEqual(second);
  });

  it('2. ignores non-matching nonces', () => {
    const events = [previewEvent('n1'), previewEvent('n2')];
    expect(selectLatestRoutePreview(events, 'n1')).toEqual(events[0]);
    expect(selectLatestRoutePreview(events, 'n1')).not.toEqual(events[1]);
  });

  it('3. ignores SYSTEM frames without routePreview (e.g. receipt/cost-summary frames)', () => {
    const receiptFrame = ev({ type: 'SYSTEM', message: 'r', metadata: { receiptView: true } });
    const events = [receiptFrame, previewEvent('n1')];
    expect(selectLatestRoutePreview(events, 'n1')).toEqual(events[1]);
    // a receipt-shaped frame is never matched even if some previewOf-shaped key were present
    expect(selectLatestRoutePreview([receiptFrame], 'n1')).toBeNull();
  });

  it('4. returns the dropped variant as-is for a matching nonce', () => {
    const dropped = previewEvent('n1', { dropped: 'in_flight' });
    delete (dropped.metadata as any).diagnostics;
    const events = [dropped];
    expect(selectLatestRoutePreview(events, 'n1')).toEqual(dropped);
  });

  it('5. null nonce -> null', () => {
    const events = [previewEvent('n1')];
    expect(selectLatestRoutePreview(events, null)).toBeNull();
  });

  it('6. no match -> null', () => {
    const events = [previewEvent('n1')];
    expect(selectLatestRoutePreview(events, 'no-such-nonce')).toBeNull();
  });
});

describe('isPanelSystemFrame / isBusyNeutralEvent (TCLAW-UIFIX-1) — subset-relationship predicates', () => {
  // Fixture builders mirroring the real emission shapes (see TorqTerminal.tsx
  // and packages/gateway/src/{preview,receipts,spend,server}.ts).
  function previewFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Route preview', metadata: { routePreview: true, previewOf: 'n1' } });
  }
  function receiptListFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Receipts', metadata: { receiptList: true, items: [] } });
  }
  function receiptViewFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Receipt', metadata: { receiptView: true, receipt: null } });
  }
  function costSummaryFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Cost summary', metadata: { costSummary: true } });
  }
  function approvalListFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Approvals listed', metadata: { approvalList: true, approvals: [] } });
  }
  function memoryShowFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Memory: 2 episode(s) this session', metadata: { memory: 'SHOW', episodes: [] } });
  }
  function memoryForgetFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Memory: forgot this session', metadata: { memory: 'FORGET_SESSION', forgotten: 2 } });
  }
  function doneReceiptFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Done', metadata: { receipt: { taskId: 't1', tier: 'API_EXTERNAL', costUsd: 0.01 } } });
  }
  function markerlessSystemFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Skill q1: APPROVE' });
  }
  function arbitrarySystemFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'x', metadata: { someUnknownKey: true } });
  }

  const nonSystemTypes: GatewayEvent['type'][] = [
    'RESULT', 'ERROR', 'CONNECTED', 'PENDING_APPROVAL', 'USER_PROMPT', 'ROUTING', 'TIER_SELECTED', 'TOOL_CALL',
  ];

  describe('isPanelSystemFrame', () => {
    it('true for each of the 5 publishOnly panel markers', () => {
      expect(isPanelSystemFrame(previewFrame())).toBe(true);
      expect(isPanelSystemFrame(receiptListFrame())).toBe(true);
      expect(isPanelSystemFrame(receiptViewFrame())).toBe(true);
      expect(isPanelSystemFrame(costSummaryFrame())).toBe(true);
      expect(isPanelSystemFrame(approvalListFrame())).toBe(true);
    });

    it('false for memory, Done-receipt, markerless SYSTEM, and non-SYSTEM types', () => {
      expect(isPanelSystemFrame(memoryShowFrame())).toBe(false);
      expect(isPanelSystemFrame(memoryForgetFrame())).toBe(false);
      expect(isPanelSystemFrame(doneReceiptFrame())).toBe(false);
      expect(isPanelSystemFrame(markerlessSystemFrame())).toBe(false);
      expect(isPanelSystemFrame(arbitrarySystemFrame())).toBe(false);
      for (const type of nonSystemTypes) {
        expect(isPanelSystemFrame(ev({ type }))).toBe(false);
      }
    });
  });

  describe('isBusyNeutralEvent', () => {
    it('true for EVERY SYSTEM fixture (all 5 panel markers, memory, Done-receipt, markerless, arbitrary-unknown-metadata)', () => {
      expect(isBusyNeutralEvent(previewFrame())).toBe(true);
      expect(isBusyNeutralEvent(receiptListFrame())).toBe(true);
      expect(isBusyNeutralEvent(receiptViewFrame())).toBe(true);
      expect(isBusyNeutralEvent(costSummaryFrame())).toBe(true);
      expect(isBusyNeutralEvent(approvalListFrame())).toBe(true);
      expect(isBusyNeutralEvent(memoryShowFrame())).toBe(true);
      expect(isBusyNeutralEvent(memoryForgetFrame())).toBe(true);
      expect(isBusyNeutralEvent(doneReceiptFrame())).toBe(true);
      expect(isBusyNeutralEvent(markerlessSystemFrame())).toBe(true);
      expect(isBusyNeutralEvent(arbitrarySystemFrame())).toBe(true);
    });

    it('false for all other event types', () => {
      for (const type of nonSystemTypes) {
        expect(isBusyNeutralEvent(ev({ type }))).toBe(false);
      }
    });
  });

  describe('subset pin (RC-4): isPanelSystemFrame(ev) === true ⟹ isBusyNeutralEvent(ev) === true, never the reverse', () => {
    it('holds across every fixture covering all frame types above', () => {
      const fixtures = [
        previewFrame(), receiptListFrame(), receiptViewFrame(), costSummaryFrame(), approvalListFrame(),
        memoryShowFrame(), memoryForgetFrame(), doneReceiptFrame(), markerlessSystemFrame(),
        arbitrarySystemFrame(),
        ...nonSystemTypes.map((type) => ev({ type })),
      ];
      for (const fixture of fixtures) {
        if (isPanelSystemFrame(fixture)) {
          expect(isBusyNeutralEvent(fixture)).toBe(true);
        }
      }
    });

    it('NEGATIVES: memory-SHOW and Done-receipt are busy-neutral AND NOT panel frames (the subset is proper, not equal)', () => {
      expect(isBusyNeutralEvent(memoryShowFrame())).toBe(true);
      expect(isPanelSystemFrame(memoryShowFrame())).toBe(false);
      expect(isBusyNeutralEvent(doneReceiptFrame())).toBe(true);
      expect(isPanelSystemFrame(doneReceiptFrame())).toBe(false);
    });
  });
});

// ── TCLAW-5A-2: H1-H4 pure-helper unit tests (BUILD-ORDER FIRST — the crux) ──

function approvalListFrame(approvals: unknown, seq?: number): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'Approvals listed', metadata: { approvalList: true, approvals }, ...(seq !== undefined ? { seq } : {}) });
}

function approvalRow(overrides: Partial<ApprovalSummaryLike> = {}): ApprovalSummaryLike {
  return {
    approvalId: 'appr-1',
    requestId: 'req-1',
    toolName: 'filesystem__write_file',
    status: 'pending',
    createdAt: '2026-01-01 00:00:00',
    decidedAt: null,
    ...overrides,
  };
}

describe('H1: selectLatestApprovalList', () => {
  it('newest-valid-wins across multiple frames', () => {
    const frameA = approvalListFrame([approvalRow({ approvalId: 'a' })]);
    const frameB = approvalListFrame([approvalRow({ approvalId: 'b' })]);
    const result = selectLatestApprovalList([frameA, frameB]);
    expect(result).toEqual([approvalRow({ approvalId: 'b' })]);
  });

  it('Array.isArray rejection: malformed frame is SKIPPED, older good frame still returned', () => {
    const good = approvalListFrame([approvalRow({ approvalId: 'good' })]);
    const malformed = ev({ type: 'SYSTEM', metadata: { approvalList: true, approvals: 'nope' } });
    const result = selectLatestApprovalList([good, malformed]);
    expect(result).toEqual([approvalRow({ approvalId: 'good' })]);
  });

  it('none present -> null', () => {
    expect(selectLatestApprovalList([ev({ type: 'SYSTEM', metadata: {} })])).toBeNull();
    expect(selectLatestApprovalList([])).toBeNull();
  });

  it('non-SYSTEM type carrying the marker is ignored', () => {
    const fake = ev({ type: 'RESULT', metadata: { approvalList: true, approvals: [approvalRow()] } });
    expect(selectLatestApprovalList([fake])).toBeNull();
  });
});

describe('H2: formatApprovalStatus', () => {
  it('rejected -> denied', () => {
    expect(formatApprovalStatus('rejected')).toEqual({ text: 'denied', tone: 'denied' });
  });
  it('pending -> pending', () => {
    expect(formatApprovalStatus('pending')).toEqual({ text: 'pending', tone: 'pending' });
  });
  it('approved -> approved', () => {
    expect(formatApprovalStatus('approved')).toEqual({ text: 'approved', tone: 'approved' });
  });
  it('unknown string -> raw passthrough, never defaulted', () => {
    expect(formatApprovalStatus('expired')).toEqual({ text: 'expired', tone: 'unknown' });
  });
  it('non-string -> defensive String() coercion, no crash', () => {
    expect(formatApprovalStatus(42)).toEqual({ text: '42', tone: 'unknown' });
    expect(formatApprovalStatus(null)).toEqual({ text: 'null', tone: 'unknown' });
    expect(formatApprovalStatus(undefined)).toEqual({ text: 'undefined', tone: 'unknown' });
  });
});

describe('H3: formatGateFacts — the Card v2 honesty-fork crux', () => {
  it('undefined -> null (caller renders nothing)', () => {
    expect(formatGateFacts(undefined)).toBeNull();
  });

  it('RC-1: gate null -> null, never miss, never throws', () => {
    expect(() => formatGateFacts(null)).not.toThrow();
    expect(formatGateFacts(null)).toBeNull();
  });

  it('RC-1: gate as a primitive string -> null, never miss', () => {
    expect(formatGateFacts('x')).toBeNull();
  });

  it('RC-1: gate as a primitive number -> null, never miss', () => {
    expect(formatGateFacts(42)).toBeNull();
  });

  it('miss signature (targets/targetsSource only, no capability, no rule) -> exact unclassified row', () => {
    const out = formatGateFacts({ targets: ['/tmp/x'], targetsSource: 'path-heuristic' });
    expect(out).not.toBeNull();
    expect(out!.variant).toBe('miss');
    expect(out!.classRow).toEqual({ text: 'write-class (unclassified)', title: 'no registry entry for this tool' });
    expect(out!.whyGated).toBeNull();
    expect(out!.server).toBeNull();
  });

  it('engine-approval-hook -> frontier: engine rows, NO capability, NO unclassified, even with a dual-signal adversarial gate', () => {
    const out = formatGateFacts({
      targets: [], targetsSource: 'path-heuristic',
      rule: 'engine-approval-hook',
      capability: 'write', sourceServerId: 'fs', // adversarial: capability ALSO present
    });
    expect(out).not.toBeNull();
    expect(out!.variant).toBe('frontier');
    expect(out!.classRow).toBeNull();
    expect(out!.whyGated).toEqual({ text: 'engine approval hook (frontier tier)', title: 'rule: engine-approval-hook' });
    expect(out!.server).toBeNull();
    expect(JSON.stringify(out!.whyGated)).not.toMatch(/unclassified/);
  });

  it('hit variant B: write-class-capability -> capability verbatim (incl. "read"), server row, why-gated line', () => {
    const out = formatGateFacts({
      targets: ['/tmp/x'], targetsSource: 'path-heuristic',
      capability: 'read', sourceServerId: 'fs', rule: 'write-class-capability',
    });
    expect(out!.variant).toBe('hit');
    expect(out!.classRow!.text).toBe('read');
    expect(out!.whyGated).toEqual({ text: 'write-class capability', title: 'rule: write-class-capability' });
    expect(out!.server).toBe('fs');
  });

  it('hit variant C: approval-pattern -> "matched an approval pattern"', () => {
    const out = formatGateFacts({
      targets: [], targetsSource: 'path-heuristic',
      capability: 'exec', sourceServerId: 'shell', rule: 'approval-pattern',
    });
    expect(out!.variant).toBe('hit');
    expect(out!.whyGated).toEqual({ text: 'matched an approval pattern', title: 'rule: approval-pattern' });
  });

  it('hit with an unknown future rule id -> raw rule id, no invented translation', () => {
    const out = formatGateFacts({
      targets: [], targetsSource: 'path-heuristic',
      capability: 'send', rule: 'some-future-rule',
    });
    expect(out!.whyGated!.text).toBe('some-future-rule');
  });

  it('targets label row: RC-2 non-array targets -> defensive empty items, isArray:false, no crash', () => {
    const out = formatGateFacts({ targets: 'nope', targetsSource: 'path-heuristic' });
    expect(() => formatGateFacts({ targets: 'nope', targetsSource: 'path-heuristic' })).not.toThrow();
    expect(out!.targets.isArray).toBe(false);
    expect(out!.targets.items).toEqual([]);
  });

  it('targets: [] -> isArray true, empty items (caller renders "none detected")', () => {
    const out = formatGateFacts({ targets: [], targetsSource: 'path-heuristic' });
    expect(out!.targets.isArray).toBe(true);
    expect(out!.targets.items).toEqual([]);
  });

  it('RC-6: unknown targetsSource -> "targets source: <raw>", never the heuristic sentence', () => {
    const out = formatGateFacts({ targets: [], targetsSource: 'some-other-source' });
    expect(out!.targetsCaption).toBe('targets source: some-other-source');
    expect(out!.targetsCaption).not.toMatch(/path heuristic/);
  });

  it('long target path (>64 chars) middle-truncates, tail preserved, full path retained', () => {
    const long = '/very/long/path/' + 'x'.repeat(80) + '/file.txt';
    const out = formatGateFacts({ targets: [long], targetsSource: 'path-heuristic' });
    const item = out!.targets.items[0]!;
    expect(item.full).toBe(long);
    expect(item.displayText.length).toBeLessThan(long.length);
    expect(item.displayText.endsWith(long.slice(-31))).toBe(true);
  });
});

describe('H4: ApprovalHistoryRowData mapper (toApprovalHistoryRows)', () => {
  it('mapper output has zero function-typed values (no dispatch surface)', () => {
    const rows = toApprovalHistoryRows([approvalRow(), approvalRow({ status: 'rejected', decidedAt: '2026-01-01 00:05:00' })]);
    for (const row of rows) {
      for (const v of Object.values(row)) {
        expect(typeof v).not.toBe('function');
      }
      // nested status object too
      for (const v of Object.values(row.status)) {
        expect(typeof v).not.toBe('function');
      }
    }
  });

  it('missing/non-string toolName -> "(unknown)", no crash', () => {
    const rows = toApprovalHistoryRows([approvalRow({ toolName: undefined as unknown as string })]);
    expect(rows[0]!.toolName).toBe('(unknown)');
  });

  it('status mapping flows through formatApprovalStatus, raw preserved', () => {
    const rows = toApprovalHistoryRows([approvalRow({ status: 'rejected' })]);
    expect(rows[0]!.status).toEqual({ text: 'denied', tone: 'denied', raw: 'rejected' });
  });

  it('decidedAt null stays null (no placeholder); non-null gets formatted', () => {
    const rows = toApprovalHistoryRows([
      approvalRow({ decidedAt: null }),
      approvalRow({ approvalId: 'a2', decidedAt: '2026-01-01 00:05:00' }),
    ]);
    expect(rows[0]!.decidedAt).toBeNull();
    expect(rows[1]!.decidedAt).toBe('2026-01-01 00:05:00 UTC');
  });
});

describe('formatApprovalTimestamp', () => {
  it('SQLite shape -> verbatim + " UTC"', () => {
    expect(formatApprovalTimestamp('2026-01-01 00:00:00')).toBe('2026-01-01 00:00:00 UTC');
  });
  it('non-matching shape -> verbatim, no suffix', () => {
    expect(formatApprovalTimestamp('2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(formatApprovalTimestamp('garbage')).toBe('garbage');
  });
});
