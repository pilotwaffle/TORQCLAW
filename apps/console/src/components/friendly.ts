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
  budgetSource?: string | null;
  costUsd?: number | null;
  costEnforceable?: number | null;
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
 *  budget_source/cost_enforceable are REAL persisted values now (TCLAW-1A-core
 *  projects them onto the receipt) -> honest mappings; NULL -> "not recorded". */
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
  // budget_source: real persisted value now (1A-core). NULL -> "not recorded".
  const bs = receipt?.budgetSource;
  rows.push({
    label: 'budget source',
    value:
      bs === 'per_task' ? 'per-task budget'
      : bs === 'env_default' ? 'default budget (env)'
      : bs === 'unlimited' ? 'uncapped (warned)'
      : 'not recorded',
  });
  // cost_enforceable: 1 enforced / 0 unenforceable / NULL n/a.
  const ce = receipt?.costEnforceable;
  rows.push({
    label: 'cost enforceable',
    value:
      ce === 1 ? 'enforced (provider reported)'
      : ce === 0 ? 'unenforceable — iteration cap only'
      : 'not recorded',
  });
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

/** The route lock/override verdict — the honest THREE-state taxonomy from
 *  engine.ts RULE_META. A hard safetyLock (privacy/local guarantee) is
 *  categorically different from a rule that is merely non-overridable
 *  (LOCAL_INTENT), which is different again from an overridable router
 *  preference. Rendering these three distinctly is the point of this panel;
 *  collapsing them would either overstate LOCAL_INTENT as a safety guarantee
 *  or demote a real privacy lock to "not overridable". */
export function formatLockState(
  diag: RouterDiagnostics | null | undefined,
): { label: string; value: string } | null {
  if (!diag) return null;
  // (a) HARD safety lock — 3 rules carry a safetyLock string.
  if (diag.safetyLock) {
    return { label: 'lock state', value: `Locked — safety rule: ${diag.safetyLock}` };
  }
  // (b) FIRM, no safety lock — non-overridable WITHOUT a safetyLock (LOCAL_INTENT).
  //     Affirmative wording (G1R RC-2): NO "(not a safety lock)" — that leaks
  //     internals and reads as hedging. State what it IS.
  if (diag.overridable === false) {
    return { label: 'lock state', value: 'Fixed for this task' };
  }
  // (c) OVERRIDABLE router preference — the 4 heuristic rules. Label only; the
  //     override ACTION is out of scope for 2B.
  if (diag.overridable === true) {
    return { label: 'lock state', value: 'Router preference — can be overridden' };
  }
  // (d) both undefined -> omit (never fabricate overridable:false).
  return null;
}

/** Every blocked alternative, using the wire-tested wording. Do NOT cap at 1 —
 *  "exactly one today" is engine happenstance, not a contract; a future rule
 *  that blocks two tiers must not be silently truncated. */
export function formatBlockedAlternatives(
  diag: RouterDiagnostics | null | undefined,
): Array<{ label: string; value: string }> {
  if (!diag?.blockedAlternatives?.length) return [];
  return diag.blockedAlternatives.map((alt) => ({
    label: 'considered but not chosen',
    value: `would have used ${alt.tier}, but: ${alt.why}`,
  }));
}

/** Routing profile — NOT populated by 2A today (no writer). field() omits it
 *  when absent, so the row simply does not appear. NEVER render "default"/"not
 *  set"/"none" — that would imply a profile system exists when it does not. */
export function formatProfile(
  diag: RouterDiagnostics | null | undefined,
): { label: string; value: string } | null {
  return field('routing profile', diag?.profile);
}

/** Headline route rows: the human rule text (same chain as
 *  formatRouteDiagnostics — humanReason ?? RULE_LABELS[ruleId] ?? reason,
 *  never blank), the coded ruleId, score, and chosen tier. null diag -> the
 *  same honest "no routing record" empty state. ruleId absent -> omit that row
 *  (via field()), never synthesize a ruleId. */
export function formatRouteExplanation(
  diag: RouterDiagnostics | null | undefined,
): Array<{ label: string; value: string }> {
  if (!diag) return [{ label: 'route', value: 'no routing record' }];
  const ruleText = diag.humanReason ?? (diag.ruleId ? RULE_LABELS[diag.ruleId] : undefined) ?? diag.reason;
  const rows: Array<{ label: string; value: string }> = [];
  rows.push({ label: 'why', value: ruleText });
  const ruleIdRow = field('rule id', diag.ruleId);
  if (ruleIdRow) rows.push(ruleIdRow);
  rows.push({ label: 'score', value: String(diag.score) });
  rows.push({ label: 'tier', value: diag.tier });
  return rows;
}

// ── TCLAW-2C: live current-task route chip ──────────────────────────────

/** TCLAW-2C: the current task's route diagnostics for the live chip. Returns
 *  the metadata (as RouterDiagnostics) of the newest TIER_SELECTED whose
 *  requestId === activeRequestId, or null when activeRequestId is null OR no
 *  matching TIER_SELECTED is present in the current events window (e.g. it was
 *  evicted from the ring). PURE: no React, no side effects. This feeds the
 *  requestId-keyed snapshot write (write-on-present) — it is NOT the render
 *  source (the render reads the useState snapshot so it survives eviction). */
export function selectActiveRouteDiag(
  events: GatewayEvent[],
  activeRequestId: string | null,
): RouterDiagnostics | null {
  if (!activeRequestId) return null;
  let diag: RouterDiagnostics | null = null;
  for (const ev of events) {
    if (ev.type === 'TIER_SELECTED' && ev.requestId === activeRequestId && ev.metadata) {
      diag = ev.metadata as RouterDiagnostics; // last-wins for this id
    }
  }
  return diag;
}

// ── TCLAW-2D-2: route preview ──────────────────────────────────────────

/** TCLAW-2D-2: the newest route-preview frame matching the latest-SENT nonce.
 *  Matches ONLY metadata.routePreview === true && metadata.previewOf === nonce
 *  (never the prompt text — preview.ts marks prompt "display echo only, NOT
 *  the staleness key"): a late frame for an older nonce is ignored even if the
 *  draft text was edited back to identical (edit-back race). Returns the
 *  dropped variant as-is (the caller branches on metadata.dropped). nonce null
 *  -> null. PURE: no React, no side effects. */
export function selectLatestRoutePreview(
  events: GatewayEvent[],
  nonce: string | null,
): GatewayEvent | null {
  if (!nonce) return null;
  let found: GatewayEvent | null = null;
  for (const ev of events) {
    const meta = (ev.metadata ?? {}) as Record<string, unknown>;
    if (ev.type === 'SYSTEM' && meta.routePreview === true && meta.previewOf === nonce) {
      found = ev; // last-wins for this nonce
    }
  }
  return found;
}

// ── TCLAW-UIFIX-1: SYSTEM-frame predicates for busy/suppression ─────────

/** The publishOnly panel-response markers: routePreview, receiptList,
 *  receiptView, costSummary, approvalList, safeExportView (TCLAW-5B-2 — all
 *  four safeExportView frame variants carry this marker, including the
 *  fail-closed one; see export.ts :662/:687/:722/:733/:741). Consumed ONLY by
 *  the EventRow suppression guard — coverage byte-identical to the inline
 *  check it replaces. CONVENTION: every new publishOnly panel response must
 *  add its marker here, or it will render as a stray (visible, benign) log
 *  row. Deliberately EXCLUDES memory frames and the Done receipt frame: those
 *  are persisted, user-facing output that must stay visible in the log (and
 *  in reconnect backlog replay). */
export function isPanelSystemFrame(ev: GatewayEvent): boolean {
  if (ev.type !== 'SYSTEM') return false;
  const m = (ev.metadata ?? {}) as Record<string, unknown>;
  return !!(m.routePreview || m.receiptList || m.receiptView || m.costSummary || m.approvalList || m.safeExportView);
}

/** TCLAW-UIFIX-1 INVARIANT (G1R-verified against every SYSTEM producer):
 *  busy-truth rides on non-SYSTEM events only. SYSTEM frames may display
 *  information (progress notes, confirmations, receipts, memory output) but
 *  never by themselves indicate active work — terminal events are emitted
 *  solely by dispatch.ts (RESULT/ERROR/PENDING_APPROVAL; CONNECTED from the
 *  connect path), and every mid-task SYSTEM note is preceded by a
 *  non-terminal task event that carries the busy-truth. Includes PERSISTED
 *  SYSTEM frames (memory, the Done receipt) — busy-neutral is about type,
 *  not persistence. A future SYSTEM frame that "should" flip busy on its own
 *  would violate this invariant: put the busy-truth on a non-SYSTEM event
 *  instead. Consumed ONLY by the busy scan. */
export function isBusyNeutralEvent(ev: GatewayEvent): boolean {
  return ev.type === 'SYSTEM';
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

// ── TCLAW-1B: Cost Control Center pure helpers ──────────────────────────
// All pure (no React, no DOM, no side effects), unit-tested in
// tests/friendly.test.ts. Return DATA (strings/objects), never JSX. Every
// helper honors the no-fabrication contract: a NULL/undefined cap or cost
// NEVER renders as "$0"/"$0.00" — only a real, persisted 0 renders as such.

/** formatCap — a cap value for display. NEVER "$0" for undefined/null (an
 *  absent cap is UNLIMITED, not a zero-dollar cap). */
export function formatCap(cap: number | null | undefined): string {
  if (cap === null || cap === undefined) return 'No cap (unlimited)';
  return `$${cap.toFixed(2)}`;
}

/** formatRemaining — headroom left under a cap. cap null/undefined ->
 *  "Unlimited"; total null/undefined -> "n/a" (nothing to subtract from);
 *  otherwise clamps at $0.00 — NEVER negative (a breach reads as "cap
 *  reached", not as a negative number). */
export function formatRemaining(
  cap: number | null | undefined,
  total: number | null | undefined,
): string {
  if (cap === null || cap === undefined) return 'Unlimited';
  if (total === null || total === undefined) return 'n/a';
  const remaining = cap - total;
  if (remaining <= 0) return '$0.00 remaining — cap reached';
  return `$${remaining.toFixed(2)} remaining`;
}

/** formatAttribution — the 3-way ledger provenance tag as a display label +
 *  optional tooltip + an `estimated` flag the caller can use to render a
 *  badge. 'account_delta' is ALWAYS labeled estimated/account-level/
 *  conservative — it is never shown as an exact per-task charge (invariant 6),
 *  though it is still counted in every total (this helper does not filter
 *  anything — it only formats a label). */
export function formatAttribution(
  attribution: string,
): { label: string; tooltip?: string; estimated: boolean } {
  if (attribution === 'exact') return { label: 'recorded', estimated: false };
  if (attribution === 'account_delta') {
    return {
      label: 'estimated · account-level · conservative',
      estimated: true,
      tooltip:
        'Account-wide usage delta, not a per-task charge — counted conservatively so caps trigger sooner, never later. May over-count under concurrency.',
    };
  }
  return { label: 'not recorded', estimated: false };
}

/** formatLedgerCost — one recent-ledger row's cost string. attribution
 *  'unavailable' OR a null costUsd -> "not recorded" (NEVER "$0.00", even if
 *  a stray number were somehow present); otherwise "$X.XX". The caller
 *  appends the estimated badge (via formatAttribution) for account_delta
 *  rows separately — this helper only formats the dollar figure. */
export function formatLedgerCost(costUsd: number | null, attribution: string): string {
  if (attribution === 'unavailable' || costUsd === null) return 'not recorded';
  return `$${costUsd.toFixed(2)}`;
}

/** formatCapState — the backend's CapBreach decision as one display string.
 *  null -> "within budget"; otherwise names WHICH cap breached plus the real
 *  total/limit/envVar the backend computed — invents no threshold of its
 *  own. */
export function formatCapState(
  breach: { cap: 'session' | 'daily'; total: number; limit: number; envVar: string } | null,
): string {
  if (!breach) return 'within budget';
  return `${breach.cap} cap reached — $${breach.total.toFixed(2)} of $${breach.limit.toFixed(2)} (${breach.envVar})`;
}

/** formatDailyTotalLabel — the daily total is a CROSS-SESSION, UTC-day
 *  aggregate (invariant 7) — never "this session today". A constant/helper
 *  so it is unit-testable and every render site uses identical wording. */
export function formatDailyTotalLabel(): string {
  return 'all sessions (UTC day)';
}

/** formatProviderSummaryRow — one per-provider spend summary row. provider
 *  null -> "unknown/local"; recorded uses ONLY recordedUsd (already excludes
 *  NULL-cost rows server-side); a non-zero unrecordedCount surfaces as an
 *  honest caveat instead of silently folding into the dollar figure. */
export function formatProviderSummaryRow(row: {
  provider: string | null;
  recordedUsd: number;
  unrecordedCount: number;
  totalCount: number;
}): { provider: string; recorded: string; caveat: string | null } {
  return {
    provider: row.provider ?? 'unknown/local',
    recorded: `$${row.recordedUsd.toFixed(2)}`,
    caveat: row.unrecordedCount > 0 ? `(${row.unrecordedCount} unrecorded)` : null,
  };
}

// ── TCLAW-5A-2: Approval history panel + Card v2 pure helpers ──────────
// All pure (no React, no DOM, no side effects), unit-tested in
// tests/friendly.test.ts. Return DATA, never JSX. See TCLAW-5A-2 builder
// spec + annexes for the honesty-fork rationale behind each guard below.

/** The session-scoped tool-approval-history row shape returned by
 *  LIST_APPROVALS (packages/gateway/src/approvals.ts ApprovalSummary) —
 *  distinct from ReceiptLike.approvals (a different, receipt-scoped shape). */
export interface ApprovalSummaryLike {
  approvalId: string;
  requestId: string;
  toolName: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
}

/** selectLatestApprovalList — last-wins backward scan over events for the
 *  newest valid approvalList frame (mirrors selectLatestRoutePreview's
 *  forward-scan-with-last-wins shape, but no nonce exists for this frame —
 *  see invariant 9/RC-3: soundness here depends on every LIST_APPROVALS
 *  request this console emits being parameter-identical, not on frame
 *  correlation). A frame with the marker but a malformed (non-array)
 *  `approvals` field is SKIPPED, not treated as a match — an older valid
 *  frame further back in the scan is still returned. PURE: no React, no
 *  side effects. */
export function selectLatestApprovalList(
  events: GatewayEvent[],
): ApprovalSummaryLike[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type !== 'SYSTEM') continue;
    const meta = (ev.metadata ?? {}) as Record<string, unknown>;
    if (meta.approvalList === true && Array.isArray(meta.approvals)) {
      return meta.approvals as ApprovalSummaryLike[];
    }
  }
  return null;
}

/** formatApprovalStatus — exact-match display mapping. Any value outside the
 *  three known statuses renders VERBATIM in neutral styling — never
 *  default-mapped to "denied"/"pending", never crash on a non-string. This is
 *  presentation-only: the raw value is untouched in the data (available via
 *  the row's title tooltip at the render layer). */
export function formatApprovalStatus(raw: unknown): { text: string; tone: 'pending' | 'approved' | 'denied' | 'unknown' } {
  if (raw === 'pending') return { text: 'pending', tone: 'pending' };
  if (raw === 'approved') return { text: 'approved', tone: 'approved' };
  if (raw === 'rejected') return { text: 'denied', tone: 'denied' };
  // Unknown/non-string raw value -> verbatim passthrough, never crash.
  return { text: String(raw), tone: 'unknown' };
}

/** One target path entry as rendered on the gate card: full path always
 *  carried (for the title tooltip); displayText is middle-truncated at 64
 *  chars (tail-preserved — filenames matter) when the raw path is longer. */
export interface GateTargetDisplay {
  full: string;
  displayText: string;
}

function truncateTarget(path: string): GateTargetDisplay {
  if (path.length <= 64) return { full: path, displayText: path };
  return { full: path, displayText: `${path.slice(0, 32)}…${path.slice(-31)}` };
}

/** The plain-data render model for the Card v2 gate block. null means
 *  "render no gate section at all" — the caller (ToolPermissionCard) must
 *  branch on this null to distinguish HONESTY FORK 1 (absent gate key) from
 *  HONESTY FORK 2 (malformed gate) from a genuine variant. See
 *  formatGateFacts below for exactly when each is produced. */
export interface GateFactsDisplay {
  /** 'hit' = registry capability hit (write-class-capability or
   *  approval-pattern rule); 'miss' = gate present but no capability/rule;
   *  'frontier' = engine-approval-hook rule (never a capability). */
  variant: 'hit' | 'miss' | 'frontier';
  /** Capability class row text — ONLY present for 'hit' (verbatim registry
   *  value, e.g. 'write'/'exec'/'send'/'read'). 'miss' uses the literal
   *  "write-class (unclassified)" string as its OWN row content below
   *  (classRow), not this field, to keep the two conceptually distinct at
   *  the type level (a hit's class is a real fact; a miss's copy is a fixed
   *  literal, never "capability" data). */
  classRow: { text: string; title?: string } | null;
  /** "why gated" row — a friendly re-spacing of the rule id, raw id in
   *  title. Present for 'hit' and 'frontier'; null for 'miss'. */
  whyGated: { text: string; title: string } | null;
  /** sourceServerId row — present only for 'hit' when the field exists. */
  server: string | null;
  /** Targets are ALWAYS present on any gate-present card (all 3 variants). */
  targets: {
    items: GateTargetDisplay[];
    /** true when raw targets was non-array/absent (garbage) -> displayed as
     *  "none detected" identically to a genuine empty array; RC-2 guard. */
    isArray: boolean;
  };
  /** Caption text under the gate block. Keyed on targetsSource ===
   *  'path-heuristic' -> the fixed heuristic sentence; ANY other raw value
   *  (RC-6) -> `targets source: <raw>` — never the heuristic sentence for an
   *  unrecognized source. */
  targetsCaption: string;
}

/** formatGateFacts — the single honesty-fork gate for Card v2.
 *
 *  Caller contract (HONESTY FORK 1): the caller must check
 *  `!('gate' in meta)` BEFORE calling this function and render nothing in
 *  that case — an absent gate key means the registry was never consulted
 *  for this (pre-5A-1) event, which is categorically different from this
 *  function returning null.
 *
 *  HONESTY FORK 2 (G1R RC-1): this function's OWN first responsibility is to
 *  treat a non-object gate (null, or any primitive — a defensive guard
 *  against garbage on the wire) as ABSENT, i.e. return null here too. This
 *  must NEVER throw (a bare `gate.something` on null crashes and blanks the
 *  live decision card) and must NEVER fabricate the miss copy on garbage.
 *
 *  HONESTY FORK 3: detection order matters and is intentionally NOT a
 *  `!capability` check alone:
 *    1. rule === 'engine-approval-hook' -> 'frontier' (wins even if a
 *       capability field is ALSO present on an adversarial dual-signal
 *       gate — frontier is never a registry miss, and the registry is never
 *       attributed a frontier block).
 *    2. capability present (any string, including 'read') -> 'hit'.
 *    3. else -> 'miss' (gate present, no capability, no frontier rule). */
export function formatGateFacts(gate: unknown): GateFactsDisplay | null {
  if (typeof gate !== 'object' || gate === null) return null; // RC-1: absent, never miss.
  const g = gate as Record<string, unknown>;

  const rawTargets = g.targets;
  const isArray = Array.isArray(rawTargets);
  const items: GateTargetDisplay[] = isArray
    ? (rawTargets as unknown[]).filter((t): t is string => typeof t === 'string').map(truncateTarget)
    : [];

  const targetsSource = g.targetsSource;
  const targetsCaption =
    targetsSource === 'path-heuristic'
      ? '"may touch" is a path heuristic over the proposed arguments — not verified.'
      : `targets source: ${String(targetsSource)}`;

  const targets = { items, isArray };

  // FORK 3, step 1: frontier wins even on a dual-signal adversarial gate.
  if (g.rule === 'engine-approval-hook') {
    return {
      variant: 'frontier',
      classRow: null, // never "write-class (unclassified)" here — not a registry statement.
      whyGated: { text: 'engine approval hook (frontier tier)', title: 'rule: engine-approval-hook' },
      server: null,
      targets,
      targetsCaption,
    };
  }

  // FORK 3, step 2: a genuine registry hit — capability present (even 'read').
  if (typeof g.capability === 'string') {
    const rule = g.rule;
    const whyText =
      rule === 'write-class-capability' ? 'write-class capability'
      : rule === 'approval-pattern' ? 'matched an approval pattern'
      : typeof rule === 'string' ? rule // unknown future rule id -> raw, no invented translation
      : 'unknown';
    return {
      variant: 'hit',
      classRow: { text: g.capability, title: typeof rule === 'string' ? `rule: ${rule}` : undefined },
      whyGated: { text: whyText, title: typeof rule === 'string' ? `rule: ${rule}` : 'rule: unknown' },
      server: typeof g.sourceServerId === 'string' ? g.sourceServerId : null,
      targets,
      targetsCaption,
    };
  }

  // FORK 3, step 3: registry miss — gate present, no capability, no frontier rule.
  return {
    variant: 'miss',
    classRow: { text: 'write-class (unclassified)', title: 'no registry entry for this tool' },
    whyGated: null,
    server: null,
    targets,
    targetsCaption,
  };
}

/** formatApprovalTimestamp — SQLite `YYYY-MM-DD HH:MM:SS` strings rendered
 *  VERBATIM with a literal " UTC" suffix ONLY on exact shape match; any other
 *  shape renders verbatim with NO suffix (never assert UTC about a shape that
 *  was not verified). NEVER `new Date(...)` on these — that parses as LOCAL
 *  time (no T/Z), a silent timezone lie. */
export function formatApprovalTimestamp(raw: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw} UTC` : raw;
}

/** Plain-data row shape for the approval-history panel — mirrors
 *  ReplayEventRowData's structural-inertness contract EXACTLY: zero
 *  function-typed fields, so even a future edit cannot add a callback here
 *  without changing the type (and the type is what ApprovalHistoryRow
 *  destructures). */
export interface ApprovalHistoryRowData {
  key: string;
  toolName: string;
  status: { text: string; tone: 'pending' | 'approved' | 'denied' | 'unknown'; raw: string };
  requestedAt: string;
  decidedAt: string | null;
  requestId: string;
}

/** toApprovalHistoryRows — ApprovalSummaryLike[] -> plain data rows, in
 *  backend order (NO client re-sort — the backend's ORDER BY is a fact).
 *  Missing/non-string toolName -> "(unknown)" (existing house convention,
 *  mirrors TorqTerminal ToolPermissionCard's `toolName || '(unknown)'`),
 *  never invents a name or crashes on a malformed row. */
export function toApprovalHistoryRows(approvals: ApprovalSummaryLike[]): ApprovalHistoryRowData[] {
  return approvals.map((a, i) => {
    const rawStatus = a?.status;
    const toolName = typeof a?.toolName === 'string' && a.toolName ? a.toolName : '(unknown)';
    return {
      key: typeof a?.approvalId === 'string' ? a.approvalId : `row-${i}`,
      toolName,
      status: { ...formatApprovalStatus(rawStatus), raw: String(rawStatus) },
      requestedAt: formatApprovalTimestamp(String(a?.createdAt)),
      decidedAt: a?.decidedAt === null || a?.decidedAt === undefined ? null : formatApprovalTimestamp(String(a.decidedAt)),
      requestId: typeof a?.requestId === 'string' ? a.requestId : '',
    };
  });
}

// ── TCLAW-5B-2: Safe-export pure helpers ────────────────────────────────
// All pure (no React, no DOM, no side effects), unit-tested in
// tests/friendly.test.ts. Return DATA (strings/objects), never JSX. Every
// helper honors the no-fabrication contract. THE CARDINAL RULE (this
// ticket's whole reason for existing): the clipboard must receive EXACTLY
// the server's redacted payload — copy JSON = JSON.stringify(safeExport,
// null, 2) of the frame's metadata.safeExport object BY REFERENCE, never a
// re-assembled/reshaped object; copy Markdown =
// renderSafeExportMarkdown(safeExport). Nothing below ever reads events,
// the raw receipt, or any other in-scope state — see packages/gateway/src/
// export.ts for the server-side redactor this consumes (read-only from the
// console's side; ZERO backend changes in this ticket).

/** The shape this console reads off a `metadata.safeExport` object — mirrors
 *  packages/gateway/src/export.ts's exported `SafeExport` interface field-
 *  for-field (kept as a LOCAL, `any`-tolerant mirror rather than a cross-
 *  package import, matching ReceiptLike's existing precedent: the console
 *  receives this as untyped SYSTEM-event metadata over the wire, not a typed
 *  contract import). `torqclawSafeExport: true` is the load-bearing first
 *  key — a malformed object lacking it is never a valid SafeExport (see
 *  selectSafeExportViewByTaskId's malformed-skip guard, G1R SC-4). */
export interface SafeExportLike {
  torqclawSafeExport: true;
  exportVersion?: number | null;
  redactorVersion?: number | null;
  projectionVersion?: number | null;
  taskId?: string | null;
  sessionId?: string | null;
  sourceChannel?: string | null;
  selectedTier?: string | null;
  state?: string | null;
  resultState?: string | null;
  cancelled?: boolean | null;
  blockedOn?: string | null;
  route?: {
    tier?: string | null;
    ruleId?: string | null;
    score?: number | null;
    overridable?: boolean | null;
    safetyLock?: string | null;
    profile?: string | null;
    reason?: string | null;
    humanReason?: string | null;
    blockedAlternatives?: Array<{ tier?: string | null; why?: string | null }> | null;
    routerReason?: string | null;
  } | null;
  cost?: {
    budgetLimit?: number | null;
    budgetSource?: string | null;
    costUsd?: number | null;
    costSource?: string | null;
    costEnforceable?: number | null;
  } | null;
  execution?: {
    elapsedMs?: number | null;
    iterations?: number | null;
    memoryUsed?: boolean | null;
    contextChars?: number | null;
  } | null;
  toolsCalled?: string[] | null;
  approvals?: Array<{ toolName?: string | null; status?: string | null; decidedAt?: string | null }> | null;
  evidence?: { startSeq?: number | null; endSeq?: number | null } | null;
  errorClass?: string | null;
  error?: string | null;
  redactionReport?: {
    redactorVersion?: number | null;
    patternsHit?: Record<string, number> | null;
    fieldsOmitted?: readonly string[] | null;
    notice?: string | null;
  } | null;
}

/** One collected safeExportView frame, keyed shape mirroring OpenReceipt
 *  (ReceiptsPanel.tsx) — the four variants are distinguished by KEY
 *  PRESENCE, never by message text: `error` present -> export_failed;
 *  `exportOmitted` present -> too_large; bare `safeExport: null` (neither
 *  key present) -> not-found; `safeExport` object -> ready. */
export interface SafeExportFrameLike {
  taskId: string;
  safeExport: SafeExportLike | null;
  exportOmitted?: { reason: string } | null;
  error?: string | null;
}

/** selectSafeExportViewByTaskId — mirrors ReceiptsPanel.tsx's
 *  receiptViewByTaskId recipe verbatim (:104-130): keyed by
 *  metadata.taskId, NOT last-wins-across-all-tasks, so switching rows never
 *  clobbers a still-loading selection with a stale frame for a different
 *  task. Match: ev.type==='SYSTEM' && meta.safeExportView===true &&
 *  typeof meta.taskId==='string'.
 *
 *  [G1R SC-4] a `meta.safeExport` that is a non-null object LACKING
 *  `torqclawSafeExport: true` is malformed (garbage on the wire, or a future
 *  shape drift) -> the frame is SKIPPED entirely (never clobbers an existing
 *  keyed entry with a bad one, and never renders under the honest "ready"
 *  branch with a payload that isn't really a SafeExport). A bare `null`
 *  safeExport is untouched by this guard (null is a valid not-found/other
 *  signal, not a malformed object).
 *
 *  Soundness of keyed last-wins without a nonce: every GET_SAFE_EXPORT any
 *  subscriber can emit for a given taskId is parameter-identical ({taskId}
 *  only), and buildSafeExport is pure over an immutable receipt row — two
 *  frames for the same taskId can differ only in live-approval freshness,
 *  where newer is strictly better, so last-wins per key is a valid answer to
 *  any outstanding request (a still-in-ring frame from an earlier click may
 *  satisfy a new click instantly; the fresh request is still sent and its
 *  newer frame overwrites when it lands). PURE: no React, no side effects. */
export function selectSafeExportViewByTaskId(
  events: GatewayEvent[],
): Record<string, SafeExportFrameLike> {
  const map: Record<string, SafeExportFrameLike> = {};
  for (const ev of events) {
    if (ev.type !== 'SYSTEM') continue;
    const meta = (ev.metadata ?? {}) as Record<string, unknown>;
    if (meta.safeExportView !== true || typeof meta.taskId !== 'string') continue;
    const rawSafeExport = meta.safeExport;
    // [G1R SC-4] malformed non-null object missing the load-bearing marker
    // key -> skip this frame entirely (never clobber a good prior entry).
    if (
      rawSafeExport !== null &&
      rawSafeExport !== undefined &&
      (typeof rawSafeExport !== 'object' || (rawSafeExport as Record<string, unknown>).torqclawSafeExport !== true)
    ) {
      continue;
    }
    map[meta.taskId] = {
      taskId: meta.taskId,
      safeExport: (rawSafeExport ?? null) as SafeExportLike | null,
      exportOmitted: (meta.exportOmitted ?? null) as { reason: string } | null,
      error: typeof meta.error === 'string' ? meta.error : null,
    };
  }
  return map;
}

/** escInline(s) — for table cells, list items, and prose interpolations.
 *  ORDER MATTERS (G1R RC-3 + Q6), exactly:
 *   1. backslash FIRST (\ -> \\) — otherwise a value ending in `\` would
 *      neutralize the very escape appended next (e.g. `x\` + `|` -> `x\\|`
 *      not the intended `x\|`).
 *   2. each of ` * _ [ ] < > | backslash-escaped.
 *   3. all newlines (\r\n|\r|\n) -> a single space (a newline in a table
 *      cell/list item breaks the row and lets the next line start fresh
 *      block syntax — heading/list/fence markers only bite at line start, so
 *      killing embedded newlines kills that vector).
 *  Never used for multi-line free text — see fenceBlock for that. */
export function escInline(s: string): string {
  let out = s.replace(/\\/g, '\\\\');
  out = out.replace(/[`*_[\]<>|]/g, (c) => `\\${c}`);
  out = out.replace(/\r\n|\r|\n/g, ' ');
  return out;
}

/** fenceBlock(s) — for multi-line free text (scrubbed residue: error, route
 *  reason/humanReason/routerReason). No character escaping inside (it would
 *  corrupt the value); breakout is prevented STRUCTURALLY:
 *   1. normalize CRLF/CR -> LF.
 *   2. n = longest run of consecutive backticks anywhere in the (normalized)
 *      content.
 *   3. fence length = max(3, n + 1) backticks.
 *   4. return fence + '\n' + content + '\n' + fence. No info string (an
 *      attacker-influenced first line of free text can't be mistaken for
 *      one, and `error` is not JSON).
 *  CommonMark closes a fence only with a run at least as long as the
 *  opener, so a fence strictly longer than any backtick run inside the
 *  content is unbreakable by construction. */
export function fenceBlock(s: string): string {
  const normalized = s.replace(/\r\n|\r/g, '\n');
  const runs = normalized.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fenceLen = Math.max(3, longest + 1);
  const fence = '`'.repeat(fenceLen);
  return `${fence}\n${normalized}\n${fence}`;
}

/** null/undefined -> "not recorded" (Rows house string); booleans ->
 *  yes/no. [G1R RC-4] a REAL payload value that happens to equal the literal
 *  string "not recorded" renders identically to a true null — this is
 *  accepted (rendering it is not false; it is indistinguishable from the
 *  honest case by construction) rather than inventing a sentinel escape,
 *  which would be new, undocumented behavior for a hypothetical collision. */
function mdOrNotRecorded(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? 'not recorded' : escInline(v);
}
function mdYesNo(v: boolean | null | undefined): string {
  return v === null || v === undefined ? 'not recorded' : v ? 'yes' : 'no';
}
function mdNum(v: number | null | undefined): string {
  return v === null || v === undefined ? 'not recorded' : String(v);
}

/**
 * renderSafeExportMarkdown — PURE, module-scope. Signature: (e:
 * SafeExportLike) => string. Input is ONLY the SafeExport object — no
 * events, no receipt, no closures, no second parameter, no import from
 * gateway. Deterministic: no Date.now()/Math.random()/module-mutable state;
 * two calls on equal input are byte-identical. Output contains no substring
 * of any omitted-field content (taskPrompt/assembledContext/events/
 * toolCallArgs/results/approvalArgs) because this function never reads
 * anything but the fields the SafeExport type itself declares.
 *
 * TEMPLATE INVARIANT (load-bearing, G1R RC-3 — a future field-adder MUST
 * honor this or route the new field through one of the two escaping
 * helpers): no payload string is EVER interpolated at Markdown line-start
 * outside of (a) a table cell after a `| ` pipe, (b) a `"- "` list-item
 * marker, or (c) inside a fenceBlock. Every free-text residue field (error,
 * route.reason, route.humanReason, route.routerReason) goes through
 * fenceBlock ONLY; every short/constrained-ish value goes through escInline
 * in a table cell or list item. Version stamps and taskId/sessionId etc. are
 * escInline'd defensively even though they are contract-shaped, as defense
 * in depth against future contract drift (R5/E19 mirror at the Markdown
 * layer).
 *
 * Version stamps [G1R RC-2 + SC-3]: read TOP-LEVEL exportVersion/
 * redactorVersion/projectionVersion ONLY — the nested
 * redactionReport.redactorVersion is a SEPARATE, intentionally-not-reread
 * stamp inside the report section (dropped from the top stamps line per
 * RC-2/SC-3: reading it a second time there would double-report the same
 * fact under a different label, which is confusing, not more honest).
 */
export function renderSafeExportMarkdown(e: SafeExportLike): string {
  const notice = e.redactionReport?.notice ?? '';
  const lines: string[] = [];

  lines.push('# TORQCLAW safe export');
  lines.push('');
  lines.push(`> ${escInline(notice)}`);
  lines.push('');
  lines.push(
    `export v${mdNum(e.exportVersion)} · redactor v${mdNum(e.redactorVersion)} · projection v${mdNum(e.projectionVersion)}`,
  );
  lines.push('');

  // ── Task ────────────────────────────────────────────────────────────
  lines.push('## Task');
  lines.push('');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  lines.push(`| task id | ${mdOrNotRecorded(e.taskId)} |`);
  lines.push(`| session id | ${mdOrNotRecorded(e.sessionId)} |`);
  lines.push(`| source channel | ${mdOrNotRecorded(e.sourceChannel)} |`);
  lines.push(`| selected tier | ${mdOrNotRecorded(e.selectedTier)} |`);
  lines.push(`| state | ${mdOrNotRecorded(e.state)} |`);
  lines.push(`| result state | ${mdOrNotRecorded(e.resultState)} |`);
  lines.push(`| cancelled | ${mdYesNo(e.cancelled)} |`);
  lines.push(`| blocked on | ${mdOrNotRecorded(e.blockedOn)} |`);
  lines.push('');

  // ── Route ───────────────────────────────────────────────────────────
  const route = e.route ?? null;
  lines.push('## Route');
  lines.push('');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  lines.push(`| tier | ${mdOrNotRecorded(route?.tier)} |`);
  lines.push(`| rule | ${mdOrNotRecorded(route?.ruleId)} |`);
  lines.push(`| score | ${mdNum(route?.score)} |`);
  lines.push(`| overridable | ${mdYesNo(route?.overridable)} |`);
  lines.push(`| safety lock | ${mdOrNotRecorded(route?.safetyLock)} |`);
  lines.push(`| profile | ${mdOrNotRecorded(route?.profile)} |`);
  lines.push('');

  if (route?.reason != null) {
    lines.push('reason:');
    lines.push('');
    lines.push(fenceBlock(route.reason));
    lines.push('');
  }
  if (route?.humanReason != null) {
    lines.push('human reason:');
    lines.push('');
    lines.push(fenceBlock(route.humanReason));
    lines.push('');
  }
  if (route?.routerReason != null) {
    lines.push('router reason:');
    lines.push('');
    lines.push(fenceBlock(route.routerReason));
    lines.push('');
  }
  if (route?.blockedAlternatives && route.blockedAlternatives.length > 0) {
    lines.push('blocked alternatives:');
    lines.push('');
    for (const alt of route.blockedAlternatives) {
      lines.push(`- ${mdOrNotRecorded(alt.tier)} — ${mdOrNotRecorded(alt.why)}`);
    }
    lines.push('');
  }

  // ── Cost ────────────────────────────────────────────────────────────
  const cost = e.cost ?? null;
  lines.push('## Cost');
  lines.push('');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  lines.push(`| budget limit | ${mdNum(cost?.budgetLimit)} |`);
  lines.push(`| budget source | ${mdOrNotRecorded(cost?.budgetSource)} |`);
  lines.push(`| cost usd | ${mdNum(cost?.costUsd)} |`);
  lines.push(`| cost source | ${mdOrNotRecorded(cost?.costSource)} |`);
  lines.push(`| cost enforceable | ${mdNum(cost?.costEnforceable)} |`);
  lines.push('');

  // ── Execution ───────────────────────────────────────────────────────
  const execution = e.execution ?? null;
  lines.push('## Execution');
  lines.push('');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  lines.push(`| elapsed ms | ${mdNum(execution?.elapsedMs)} |`);
  lines.push(`| iterations | ${mdNum(execution?.iterations)} |`);
  lines.push(`| memory used | ${mdYesNo(execution?.memoryUsed)} |`);
  lines.push(`| context chars | ${mdNum(execution?.contextChars)} |`);
  lines.push('');

  // ── Tools called ────────────────────────────────────────────────────
  lines.push('## Tools called');
  lines.push('');
  if (e.toolsCalled && e.toolsCalled.length > 0) {
    for (const name of e.toolsCalled) lines.push(`- ${escInline(name)}`);
  } else {
    lines.push('none');
  }
  lines.push('');

  // ── Approvals ───────────────────────────────────────────────────────
  lines.push('## Approvals');
  lines.push('');
  if (e.approvals && e.approvals.length > 0) {
    lines.push('| tool | status | decided at |');
    lines.push('| --- | --- | --- |');
    for (const a of e.approvals) {
      lines.push(`| ${mdOrNotRecorded(a.toolName)} | ${mdOrNotRecorded(a.status)} | ${mdOrNotRecorded(a.decidedAt)} |`);
    }
  } else {
    lines.push('none');
  }
  lines.push('');

  // ── Evidence ────────────────────────────────────────────────────────
  lines.push('## Evidence');
  lines.push('');
  const startSeq = e.evidence?.startSeq;
  const endSeq = e.evidence?.endSeq;
  lines.push(
    `events seq ${startSeq === null || startSeq === undefined ? 'not recorded' : startSeq}–${
      endSeq === null || endSeq === undefined ? 'not recorded' : endSeq
    } — event bodies are not part of this export.`,
  );
  lines.push('');

  // ── Error ───────────────────────────────────────────────────────────
  lines.push('## Error');
  lines.push('');
  lines.push(`error class: ${e.errorClass ? escInline(e.errorClass) : 'none'}`);
  lines.push('');
  if (e.error != null) {
    lines.push(fenceBlock(e.error));
  } else {
    lines.push('none recorded');
  }
  lines.push('');

  // ── Redaction report ────────────────────────────────────────────────
  lines.push('## Redaction report');
  lines.push('');
  lines.push(`redactor v${mdNum(e.redactionReport?.redactorVersion)}`);
  lines.push('');
  const patternsHit = e.redactionReport?.patternsHit ?? {};
  const hitEntries = Object.entries(patternsHit);
  if (hitEntries.length > 0) {
    lines.push('| known shape | removals |');
    lines.push('| --- | --- |');
    for (const [label, count] of hitEntries) {
      lines.push(`| ${escInline(label)} | ${count} |`);
    }
  } else {
    lines.push('no known secret shapes found — known shapes only; this is not a guarantee');
  }
  lines.push('');
  const fieldsOmitted = e.redactionReport?.fieldsOmitted ?? [];
  lines.push(`never included: ${fieldsOmitted.map((f) => escInline(f)).join(', ')}`);
  lines.push('');
  lines.push(`> ${escInline(notice)}`);

  return lines.join('\n');
}
