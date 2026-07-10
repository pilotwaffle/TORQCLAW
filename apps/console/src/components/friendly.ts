// Translation layer: raw pipeline vocabulary -> end-user language.
// Raw values stay available via tooltips; users should never need to
// decode enum names or router diagnostics.
import type { GatewayEvent, RouterRuleId, RouterDiagnostics } from '@torqclaw/contracts';

export const TASK_LABELS: Record<string, string> = {
  DATA_EXTRACTION: 'Extracting data',
  SUMMARIZATION: 'Summarizing',
  ROUTINE_AUTOMATION: 'Quick task',
  AUTONOMOUS_RESEARCH: 'Research task',
  COMPLEX_CODING: 'Coding task',
};

export const TYPE_LABELS: Record<string, string> = {
  CONNECTED: 'connected',
  USER_PROMPT: 'you',
  ROUTING: 'understood',
  TIER_SELECTED: 'routed',
  TOOL_CALL: 'working',
  SYSTEM: 'status',
  RESULT: 'answer',
  PENDING_APPROVAL: 'needs you',
  ERROR: 'problem',
};

export function tierLabel(tier: GatewayEvent['tier']): { text: string; hint: string } | null {
  if (tier === 'OLLAMA_LOCAL')
    return { text: 'on this machine', hint: 'Running on your local model — private, no API cost' };
  if (tier === 'API_EXTERNAL')
    return { text: 'cloud model', hint: 'Using a frontier cloud model for deeper reasoning' };
  return null;
}

/** Human rendering of an event message; falls back to the raw message. */
export function friendlyMessage(ev: GatewayEvent): string {
  const meta = (ev.metadata ?? {}) as Record<string, any>;
  switch (ev.type) {
    case 'CONNECTED':
      return meta.resumed ? 'Picked up where you left off' : 'Ready — type a task below';
    case 'ROUTING': {
      const m = ev.message.match(/Classified as (\w+)/);
      return m ? `Got it — ${(TASK_LABELS[m[1]!] ?? m[1]!).toLowerCase()}` : ev.message;
    }
    case 'TIER_SELECTED': {
      const r = String(meta.reason ?? ev.message);
      if (r.startsWith('PRIVACY_OVERRIDE')) return 'Marked private — staying on this machine';
      if (r.startsWith('USER_LOCAL_ONLY')) return 'This machine only — as you asked';
      if (r.startsWith('TOOL_COUNT_OVERFLOW')) return 'Needs several tools — using the cloud model';
      if (r.startsWith('LOW_CLASSIFIER_CONFIDENCE')) return 'Tricky to size up — using the cloud model to be safe';
      if (r.startsWith('LATENCY_CRITICAL')) return 'Local model is waking up — using the cloud for a fast answer';
      const score = Number(meta.score ?? NaN);
      if (!Number.isNaN(score))
        return score < 50
          ? 'Simple enough to run locally — free and private'
          : 'Complex task — using the cloud model';
      return ev.message;
    }
    case 'TOOL_CALL': {
      const m = ev.message.match(/Executing (?:(\w+)__)?(\w+)/);
      if (m) {
        const action = m[2]!.replace(/_/g, ' ');
        return m[1] ? `Using ${action} (${m[1]})` : `Using ${action}`;
      }
      return ev.message;
    }
    case 'PENDING_APPROVAL': {
      const m = ev.message.match(/Tool (?:(\w+)__)?(\w+)/);
      if (m) return `Wants to ${m[2]!.replace(/_/g, ' ')} — needs your OK`;
      if (ev.message.toLowerCase().includes('skill')) return 'Learned a new skill — review before it can be used';
      return ev.message;
    }
    case 'ERROR':
      return `Something went wrong: ${ev.message.replace(/^Execution failed: /, '')}`;
    default:
      return ev.message;
  }
}

/**
 * Client-side privacy SUGGESTION patterns. Rules (load-bearing — invariant 2):
 *  - This is suggest-only. A match surfaces an inline hint; it must NEVER set
 *    or clear the private flag itself, NEVER block or delay submission, and a
 *    false positive must be dismissible for the current prompt without changing
 *    the stored private-mode preference.
 *  - No automatic system may clear containsSensitiveData; automation may only
 *    suggest setting it.
 * Patterns target obvious credential/PII shapes, anchored to avoid tripping on
 * ordinary words (e.g. "ski", "ssn" inside "lesson").
 */
export const PRIVACY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, label: 'an API key' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, label: 'a GitHub token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'an AWS access key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'a private key' },
  { re: /\b\d{3}-\d{2}-\d{4}\b/, label: 'an SSN' },
  { re: /\b(?:\d[ -]?){13,16}\b/, label: 'a card number' },
];

/** Returns a hint label if the text looks like it carries credentials/PII,
 *  else null. Pure + synchronous so it can run on every keystroke cheaply. */
export function privacyHint(text: string): string | null {
  for (const { re, label } of PRIVACY_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/** P4: minimal line-level diff (LCS) — added/removed/unchanged rows. No
 *  dependency; enough to review a SKILL.md edit. Pure, exported for testing. */
export function lineDiff(a: string, b: string): Array<{ t: '+' | '-' | ' '; line: string }> {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const W = m + 1;
  const dp = new Int32Array((n + 1) * (m + 1));
  const g = (k: number): number => dp[k] as number; // Int32Array never holds undefined
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * W + j] = A[i] === B[j]
        ? g((i + 1) * W + (j + 1)) + 1
        : Math.max(g((i + 1) * W + j), g(i * W + (j + 1)));
  const out: Array<{ t: '+' | '-' | ' '; line: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', line: A[i] ?? '' }); i++; j++; }
    else if (g((i + 1) * W + j) >= g(i * W + (j + 1))) { out.push({ t: '-', line: A[i] ?? '' }); i++; }
    else { out.push({ t: '+', line: B[j] ?? '' }); j++; }
  }
  while (i < n) out.push({ t: '-', line: A[i++] ?? '' });
  while (j < m) out.push({ t: '+', line: B[j++] ?? '' });
  return out;
}

// ── TCLAW-4B-2: receipt-panel pure helpers ──────────────────────────────
// All 7 below are pure (no React, no DOM, no side effects) and unit-tested
// in tests/friendly.test.ts. They return DATA (strings/objects), never JSX.

/** A minimal shape for whatever the receipt panel considers "the full
 *  receipt" — matches the GET_RECEIPT full_receipt_json fields the panel
 *  actually reads (see packages/gateway/src/receipts.ts:207-228). Kept as
 *  `any`-tolerant fields (all optional/nullable) since the panel receives
 *  this as untyped SYSTEM-event metadata over the wire, not a typed contract. */
export interface ReceiptLike {
  taskId?: string;
  sessionId?: string;
  sourceChannel?: string | null;
  selectedTier?: string | null;
  routerReason?: string | null;
  state?: string | null;
  resultState?: string | null;
  routeDiagnostics?: RouterDiagnostics | null;
  budgetLimit?: number | null;
  costUsd?: number | null;
  elapsedMs?: number | null;
  iterations?: number | null;
  cancelled?: boolean | number | null;
  blockedOn?: string | null;
  memoryUsed?: boolean | null;
  contextChars?: number | null;
  toolsCalled?: string[];
  approvals?: Array<{ status: string; toolName: string; decidedAt: string | null }>;
  evidence?: { startSeq: number | null; endSeq: number | null };
  error?: string | null;
}

/** 1. field(label, value) — null/undefined/'' omit the field entirely; a
 *  real 0 or false is rendered (absence must never be confused with a
 *  fabricated falsy value). */
export function field(label: string, value: unknown): { label: string; value: string } | null {
  if (value === null || value === undefined || value === '') return null;
  return { label, value: String(value) };
}

/** 2. RULE_LABELS — all 8 RouterRuleIdSchema values. Wording is reused from
 *  friendlyMessage's TIER_SELECTED reason-prefix branches so a live event
 *  and its later receipt replay describe the routing decision identically. */
export const RULE_LABELS: Record<RouterRuleId, string> = {
  PRIVACY_OVERRIDE: 'Marked private — stayed on this machine',
  USER_LOCAL_ONLY: 'This machine only — as requested',
  LOCAL_INTENT: 'Recognized as a local-machine task',
  LOCAL_TOOL_INTENT: 'Needed a tool available only on this machine',
  LOW_CLASSIFIER_CONFIDENCE: 'Tricky to size up — used the cloud model to be safe',
  TOOL_COUNT_OVERFLOW: 'Needed several tools — used the cloud model',
  LATENCY_CRITICAL: 'Local model was waking up — used the cloud for a fast answer',
  HEURISTIC_EVAL: 'Routed by complexity score',
};

/** 3. formatReceiptState — a friendly label for the receipt's terminal
 *  state. null state -> "unknown"; resultState==='blocked' takes priority;
 *  cancelled/blockedOn are surfaced as extra badges alongside the label. */
export function formatReceiptState(receipt: ReceiptLike | null): {
  label: string;
  cancelled?: boolean;
  blockedOn?: string;
} {
  if (!receipt || receipt.resultState == null) return { label: 'unknown' };
  const { resultState, cancelled, blockedOn } = receipt;
  const base =
    resultState === 'blocked' ? 'Blocked'
    : resultState === 'completed' ? 'Completed'
    : resultState === 'failed' ? 'Failed'
    : resultState === 'cancelled' ? 'Cancelled'
    : resultState;
  const out: { label: string; cancelled?: boolean; blockedOn?: string } = { label: base };
  if (cancelled === true || cancelled === 1) out.cancelled = true;
  if (typeof blockedOn === 'string' && blockedOn) out.blockedOn = blockedOn;
  return out;
}

/** 4. formatCostField — returns the field rows the panel renders for cost.
 *  costUsd is a real number -> "$X.XX"; null -> "not recorded" (NEVER
 *  "$0.00" — absence of telemetry must never read as a free run).
 *  budget_source/cost_enforceable are always null in v1 -> "not recorded". */
export function formatCostField(
  receipt: ReceiptLike | null,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const cost = receipt?.costUsd;
  rows.push({
    label: 'cost',
    value: typeof cost === 'number' ? `$${cost.toFixed(2)}` : 'not recorded',
  });
  if (typeof receipt?.budgetLimit === 'number') {
    rows.push({ label: 'budget', value: `budget $${receipt.budgetLimit}` });
  }
  // budget_source / cost_enforceable are never persisted in v1 (always null
  // — see receipts.ts:203-205) so these are unconditionally "not recorded".
  rows.push({ label: 'budget source', value: 'not recorded' });
  rows.push({ label: 'cost enforceable', value: 'not recorded' });
  return rows;
}

/** 5. formatRouteDiagnostics — turns a RouterDiagnostics (or null) into the
 *  rows the panel renders. rule text prefers humanReason, then RULE_LABELS
 *  by ruleId, then the raw reason string — never a blank rule row. */
export function formatRouteDiagnostics(
  diag: RouterDiagnostics | null | undefined,
): Array<{ label: string; value: string }> {
  if (!diag) return [{ label: 'route', value: 'no routing record' }];
  const rows: Array<{ label: string; value: string }> = [];
  const rule = diag.humanReason ?? (diag.ruleId ? RULE_LABELS[diag.ruleId] : undefined) ?? diag.reason;
  rows.push({ label: 'rule', value: rule });
  rows.push({ label: 'score', value: String(diag.score) });
  rows.push({ label: 'tier', value: diag.tier });
  if (diag.blockedAlternatives && diag.blockedAlternatives.length > 0) {
    for (const alt of diag.blockedAlternatives) {
      rows.push({ label: 'blocked alternative', value: `would have used ${alt.tier}, but: ${alt.why}` });
    }
  }
  if (diag.safetyLock) rows.push({ label: 'safety lock', value: diag.safetyLock });
  if (diag.overridable !== undefined) rows.push({ label: 'overridable', value: String(diag.overridable) });
  return rows;
}

/** Plain data row a replay-only event renders — NO callbacks, NO dispatch
 *  surface of any kind. This is the type-level half of the structural
 *  boundary: even if a future edit tried to add a handler field here, the
 *  ReplayEventRow consumer (see ReceiptsPanel.tsx) still only destructures
 *  these fields, and nothing here is ever a function. */
export interface ReplayEventRowData {
  key: string;
  type: GatewayEvent['type'];
  message: string;
  tier: { text: string; hint: string } | null;
  timestamp: string;
  raw: GatewayEvent;
}

/** 6. toReplayEventRows — GatewayEvent[] -> plain data rows, in seq order,
 *  for the read-only replay view. Pure transform: returns DATA, never
 *  JSX-with-callbacks, and carries no readOnly flag to thread through since
 *  there is nothing dispatchable in the output at all. */
export function toReplayEventRows(events: GatewayEvent[]): ReplayEventRowData[] {
  const sorted = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return sorted.map((ev) => ({
    key: ev.id,
    type: ev.type,
    message: friendlyMessage(ev),
    tier: tierLabel(ev.tier),
    timestamp: ev.timestamp,
    raw: ev,
  }));
}

/** 7. canRenderAction — the live-path affordance guard. Reserved for
 *  per-event-type gating later; today it is simply !readOnly. The replay
 *  safety guarantee does NOT depend on this alone — it depends on
 *  ReplayEventRow having no callback in lexical scope (see ReceiptsPanel.tsx). */
export function canRenderAction(_event: GatewayEvent, readOnly: boolean): boolean {
  return !readOnly;
}
