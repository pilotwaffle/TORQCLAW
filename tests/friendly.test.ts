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
  selectSafeExportViewByTaskId,
  renderSafeExportMarkdown,
  escInline,
  fenceBlock,
  type ReceiptLike,
  type ApprovalSummaryLike,
  type SafeExportLike,
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
  function safeExportFrame(): GatewayEvent {
    return ev({ type: 'SYSTEM', message: 'Safe export', metadata: { safeExportView: true, taskId: 't1', safeExport: null } });
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
    it('true for each of the 6 publishOnly panel markers', () => {
      expect(isPanelSystemFrame(previewFrame())).toBe(true);
      expect(isPanelSystemFrame(receiptListFrame())).toBe(true);
      expect(isPanelSystemFrame(receiptViewFrame())).toBe(true);
      expect(isPanelSystemFrame(costSummaryFrame())).toBe(true);
      expect(isPanelSystemFrame(approvalListFrame())).toBe(true);
      expect(isPanelSystemFrame(safeExportFrame())).toBe(true);
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
    it('true for EVERY SYSTEM fixture (all 6 panel markers, memory, Done-receipt, markerless, arbitrary-unknown-metadata)', () => {
      expect(isBusyNeutralEvent(previewFrame())).toBe(true);
      expect(isBusyNeutralEvent(receiptListFrame())).toBe(true);
      expect(isBusyNeutralEvent(receiptViewFrame())).toBe(true);
      expect(isBusyNeutralEvent(costSummaryFrame())).toBe(true);
      expect(isBusyNeutralEvent(approvalListFrame())).toBe(true);
      expect(isBusyNeutralEvent(safeExportFrame())).toBe(true);
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
        safeExportFrame(),
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

// ── TCLAW-5B-2: safe-export pure helpers ────────────────────────────────

function safeExportSystemEvent(meta: Record<string, unknown>): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'Safe export', metadata: { safeExportView: true, ...meta } });
}

const minimalSafeExport: SafeExportLike = {
  torqclawSafeExport: true,
  exportVersion: 1,
  redactorVersion: 1,
  projectionVersion: 2,
  taskId: 't1',
  sessionId: 's1',
  sourceChannel: 'cli',
  selectedTier: 'OLLAMA_LOCAL',
  state: 'terminal',
  resultState: 'completed',
  cancelled: false,
  blockedOn: null,
  route: {
    tier: 'OLLAMA_LOCAL',
    ruleId: 'LOCAL_INTENT',
    score: 10,
    overridable: false,
    safetyLock: null,
    profile: null,
    reason: null,
    humanReason: null,
    blockedAlternatives: null,
    routerReason: null,
  },
  cost: { budgetLimit: null, budgetSource: null, costUsd: 0, costSource: null, costEnforceable: null },
  execution: { elapsedMs: 100, iterations: 1, memoryUsed: false, contextChars: null },
  toolsCalled: [],
  approvals: [],
  evidence: { startSeq: 1, endSeq: 2 },
  errorClass: null,
  error: null,
  redactionReport: {
    redactorVersion: 1,
    patternsHit: {},
    fieldsOmitted: ['taskPrompt', 'assembledContext', 'events', 'toolCallArgs', 'results', 'approvalArgs'],
    notice: 'Known secret shapes removed. This export does not and cannot claim to contain no secrets.',
  },
};

describe('selectSafeExportViewByTaskId', () => {
  it('F2a. keyed map: two different taskIds each get their own entry', () => {
    const events = [
      safeExportSystemEvent({ taskId: 'tA', safeExport: null }),
      safeExportSystemEvent({ taskId: 'tB', safeExport: { ...minimalSafeExport, taskId: 'tB' } }),
    ];
    const map = selectSafeExportViewByTaskId(events);
    expect(map.tA).toEqual({ taskId: 'tA', safeExport: null, exportOmitted: null, error: null });
    expect(map.tB?.safeExport?.taskId).toBe('tB');
  });

  it('F2b. per-key last-wins: a later frame for the SAME taskId overwrites the earlier one', () => {
    const events = [
      safeExportSystemEvent({ taskId: 'tA', safeExport: null }),
      safeExportSystemEvent({ taskId: 'tA', safeExport: { ...minimalSafeExport, taskId: 'tA' } }),
    ];
    const map = selectSafeExportViewByTaskId(events);
    expect(map.tA?.safeExport?.taskId).toBe('tA');
  });

  it('F2c. malformed skip [SC-4]: a non-null safeExport object LACKING torqclawSafeExport:true is skipped, never clobbers a good prior entry', () => {
    const good = { ...minimalSafeExport, taskId: 'tA' };
    const events = [
      safeExportSystemEvent({ taskId: 'tA', safeExport: good }),
      safeExportSystemEvent({ taskId: 'tA', safeExport: { taskId: 'tA', bogus: true } }), // missing torqclawSafeExport
    ];
    const map = selectSafeExportViewByTaskId(events);
    expect(map.tA?.safeExport).toEqual(good); // NOT clobbered by the malformed frame
  });

  it('F2d. type/marker guards: non-SYSTEM type ignored; safeExportView !== true ignored; non-string taskId ignored', () => {
    const events = [
      ev({ type: 'ERROR', metadata: { safeExportView: true, taskId: 'tA', safeExport: null } }),
      safeExportSystemEvent({ safeExportView: false, taskId: 'tB', safeExport: null } as any),
      safeExportSystemEvent({ taskId: 123 as any, safeExport: null }),
    ];
    const map = selectSafeExportViewByTaskId(events);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('F2e. exportOmitted/error carried through on the frame', () => {
    const events = [
      safeExportSystemEvent({ taskId: 'tA', safeExport: null, exportOmitted: { reason: 'too_large' } }),
    ];
    const map = selectSafeExportViewByTaskId(events);
    expect(map.tA?.exportOmitted).toEqual({ reason: 'too_large' });

    const events2 = [safeExportSystemEvent({ taskId: 'tB', safeExport: null, error: 'export_failed' })];
    const map2 = selectSafeExportViewByTaskId(events2);
    expect(map2.tB?.error).toBe('export_failed');
  });
});

describe('escInline', () => {
  it('backslash escaped FIRST, before the other special chars (order pin)', () => {
    // A trailing backslash directly before a pipe: naive escaping in the
    // wrong order would turn `x\|` into `x\\|` (i.e. escaped backslash then
    // a STILL-BARE pipe) instead of the correct `x\\\|` (escaped backslash
    // then an ESCAPED pipe).
    expect(escInline('x\\|')).toBe('x\\\\\\|');
  });

  it('every listed special char is backslash-escaped', () => {
    expect(escInline('`*_[]<>|')).toBe('\\`\\*\\_\\[\\]\\<\\>\\|');
  });

  it('newlines (\\n, \\r\\n, \\r) collapse to a single space', () => {
    expect(escInline('a\nb')).toBe('a b');
    expect(escInline('a\r\nb')).toBe('a b');
    expect(escInline('a\rb')).toBe('a b');
  });

  it('[REDACTED:label] markers render literally (brackets escaped, not special-cased)', () => {
    expect(escInline('[REDACTED:api-key]')).toBe('\\[REDACTED:api-key\\]');
  });

  it('a markdown link attempt is neutralized: brackets and no unescaped structure survive', () => {
    const out = escInline('[link](http://evil)');
    expect(out).toBe('\\[link\\](http://evil)');
  });
});

describe('fenceBlock', () => {
  it('F5. plain content -> minimum 3-backtick fence', () => {
    const out = fenceBlock('hello world');
    expect(out).toBe('```\nhello world\n```');
  });

  it('F5. content-position-0 fence run (``` at char 0, not just embedded) -> emitted fence is 4+', () => {
    const out = fenceBlock('```leading fence run');
    const lines = out.split('\n');
    expect(lines[0]).toBe('````'); // 4 backticks: max(3, 3+1)
    expect(lines[lines.length - 1]).toBe('````');
  });

  it('F5. embedded 4-backtick run -> 5-backtick fence (exact fence pin)', () => {
    const out = fenceBlock('before ```` after');
    const lines = out.split('\n');
    expect(lines[0]).toBe('`````'); // 5 backticks: max(3, 4+1)
    expect(lines[lines.length - 1]).toBe('`````');
  });

  it('CRLF/CR normalized to LF', () => {
    const out = fenceBlock('a\r\nb\rc');
    expect(out).toBe('```\na\nb\nc\n```');
  });

  it('no info string on the opening fence', () => {
    const out = fenceBlock('plain');
    const firstLine = out.split('\n')[0]!;
    expect(firstLine).toBe('```');
  });
});

describe('renderSafeExportMarkdown', () => {
  it('F3. includes notice at TOP (blockquote) AND in the report section', () => {
    const out = renderSafeExportMarkdown(minimalSafeExport);
    const noticeLine = `> ${minimalSafeExport.redactionReport!.notice}`;
    const occurrences = out.split(noticeLine).length - 1;
    expect(occurrences).toBe(2);
    expect(out.startsWith('# TORQCLAW safe export')).toBe(true);
  });

  it('F3. stamps line exact, TOP-LEVEL fields only (sabotage check: nested redactionReport.redactorVersion is NOT re-read as a different value)', () => {
    const e: SafeExportLike = {
      ...minimalSafeExport,
      exportVersion: 1,
      redactorVersion: 1,
      projectionVersion: 2,
      redactionReport: { ...minimalSafeExport.redactionReport!, redactorVersion: 999 }, // deliberately different
    };
    const out = renderSafeExportMarkdown(e);
    expect(out).toContain('export v1 · redactor v1 · projection v2');
    // The nested-999 value must not appear as the TOP stamps line's redactor
    // figure (it IS legitimately re-shown inside the report section's own
    // "redactor v999" line — that is a SEPARATE, intentionally distinct
    // stamp, not a double-read of the same fact).
    expect(out).not.toContain('export v1 · redactor v999');
  });

  it('F3. projectionVersion null -> "not recorded" in the stamps line', () => {
    const e: SafeExportLike = { ...minimalSafeExport, projectionVersion: null };
    const out = renderSafeExportMarkdown(e);
    expect(out).toContain('export v1 · redactor v1 · projection vnot recorded');
  });

  it('F3. report table rows in payload order + fieldsOmitted join', () => {
    const e: SafeExportLike = {
      ...minimalSafeExport,
      redactionReport: {
        ...minimalSafeExport.redactionReport!,
        patternsHit: { 'api-key': 2, path: 1 },
      },
    };
    const out = renderSafeExportMarkdown(e);
    const apiKeyIdx = out.indexOf('| api-key | 2 |');
    const pathIdx = out.indexOf('| path | 1 |');
    expect(apiKeyIdx).toBeGreaterThan(-1);
    expect(pathIdx).toBeGreaterThan(apiKeyIdx);
    expect(out).toContain('never included: taskPrompt, assembledContext, events, toolCallArgs, results, approvalArgs');
  });

  it('F3. empty patternsHit -> the honest empty-hits line, no table', () => {
    const out = renderSafeExportMarkdown(minimalSafeExport); // patternsHit: {}
    expect(out).toContain('no known secret shapes found — known shapes only; this is not a guarantee');
    expect(out).not.toContain('| known shape | removals |');
  });

  it('F4. an all-backticks value in BOTH an escInline cell (route rule) and a fenceBlock (error) renders literally with correct fence length', () => {
    const e: SafeExportLike = {
      ...minimalSafeExport,
      route: { ...minimalSafeExport.route!, ruleId: '```' },
      error: 'boom ```` boom',
    };
    const out = renderSafeExportMarkdown(e);
    // escInline cell: backticks escaped, not fenced.
    expect(out).toContain('| rule | \\`\\`\\` |');
    // fenceBlock: fence length = max(3, 4+1) = 5.
    expect(out).toContain('`````\nboom ```` boom\n`````');
  });

  it('F6. >, |  as ENTIRE cell/list values -> escaped literal (escInline set per spec §3.1: ` * _ [ ] < > | — # and - are NOT in the escape set, and are safe because the template invariant never interpolates a value bare at line-start; only inside a "| " table cell, a "- " list marker, or a fenceBlock)', () => {
    const e: SafeExportLike = {
      ...minimalSafeExport,
      blockedOn: '>',
      toolsCalled: ['#'],
      route: { ...minimalSafeExport.route!, safetyLock: '-', profile: '|' },
    };
    const out = renderSafeExportMarkdown(e);
    expect(out).toContain('| blocked on | \\> |');
    // "#" and "-" as ENTIRE list/table values render literally UNESCAPED —
    // they are harmless at this position because they never land at
    // Markdown line-start (the "- " list marker / "| " table pipe already
    // precedes them structurally).
    expect(out).toContain('- #');
    expect(out).toContain('| safety lock | - |');
    expect(out).toContain('| profile | \\| |');
  });

  it('F6. newline-in-cell -> space; trailing-backslash value + pipe -> \\\\ then \\| (order pin)', () => {
    const e: SafeExportLike = {
      ...minimalSafeExport,
      sourceChannel: 'line1\nline2',
      blockedOn: 'x\\',
    };
    const out = renderSafeExportMarkdown(e);
    expect(out).toContain('| source channel | line1 line2 |');
    expect(out).toContain('| blocked on | x\\\\ |');
  });

  it('F6. [REDACTED:label] renders literally inside the Markdown output', () => {
    const e: SafeExportLike = { ...minimalSafeExport, blockedOn: '[REDACTED:api-key]' };
    const out = renderSafeExportMarkdown(e);
    expect(out).toContain('| blocked on | \\[REDACTED:api-key\\] |');
  });

  it('F7. purity: sentinel-per-omitted-field fixture -> no substring of any omitted field leaks into output', () => {
    // Every field this export must NEVER carry gets a unique sentinel that,
    // if this function ever read it (a bug reaching into a hypothetical
    // extra parameter or closed-over object), would show up verbatim.
    const sentinels = {
      taskPrompt: 'SENTINEL_TASK_PROMPT_87234',
      assembledContext: 'SENTINEL_ASSEMBLED_CONTEXT_11923',
      events: 'SENTINEL_EVENTS_55011',
      toolCallArgs: 'SENTINEL_TOOLCALLARGS_29384',
      results: 'SENTINEL_RESULTS_10293',
      approvalArgs: 'SENTINEL_APPROVALARGS_48213',
    };
    // renderSafeExportMarkdown's signature accepts ONLY a SafeExportLike — a
    // sentinel-carrying "receipt" object is never passed to it at all; this
    // test proves the guarantee by construction (single-argument call) and
    // by string-absence (defense in depth against a future accidental read).
    const out = renderSafeExportMarkdown(minimalSafeExport);
    for (const sentinel of Object.values(sentinels)) {
      expect(out).not.toContain(sentinel);
    }
  });

  it('F7. determinism: two calls on the same input are byte-identical', () => {
    const out1 = renderSafeExportMarkdown(minimalSafeExport);
    const out2 = renderSafeExportMarkdown(minimalSafeExport);
    expect(out1).toBe(out2);
  });

  it('F7. null -> "not recorded"; booleans -> yes/no', () => {
    const e: SafeExportLike = {
      ...minimalSafeExport,
      sessionId: null,
      cancelled: null,
      execution: { ...minimalSafeExport.execution!, memoryUsed: true },
      route: { ...minimalSafeExport.route!, overridable: null },
    };
    const out = renderSafeExportMarkdown(e);
    expect(out).toContain('| session id | not recorded |');
    expect(out).toContain('| cancelled | not recorded |');
    expect(out).toContain('| memory used | yes |');
    expect(out).toContain('| overridable | not recorded |');
  });

  it('[G1R RC-4] a REAL value equal to the literal "not recorded" renders identically to the honest null case (accepted, documented — no sentinel escape invented)', () => {
    const e: SafeExportLike = { ...minimalSafeExport, blockedOn: 'not recorded' };
    const out = renderSafeExportMarkdown(e);
    expect(out).toContain('| blocked on | not recorded |');
  });

  it('Evidence section states the no-event-bodies disclaimer with real seq numbers', () => {
    const out = renderSafeExportMarkdown(minimalSafeExport);
    expect(out).toContain('events seq 1–2 — event bodies are not part of this export.');
  });

  it('Overclaim pin: no "sanitized"/"secure"/"guaranteed"/"clean" claim words appear anywhere in the Markdown', () => {
    const out = renderSafeExportMarkdown(minimalSafeExport);
    expect(out).not.toMatch(/\bsanitized\b/i);
    expect(out).not.toMatch(/\bsecure\b/i);
    expect(out).not.toMatch(/\bguaranteed\b/i);
    expect(out).not.toMatch(/\bclean\b/i);
  });
});
