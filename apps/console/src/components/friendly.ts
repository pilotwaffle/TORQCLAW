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

/** The publishOnly panel-response markers. Consumed ONLY by the EventRow
 *  suppression guard — coverage byte-identical to the inline check it
 *  replaces. CONVENTION: every new publishOnly panel response must add its
 *  marker here, or it will render as a stray (visible, benign) log row.
 *  Deliberately EXCLUDES memory frames and the Done receipt frame: those are
 *  persisted, user-facing output that must stay visible in the log (and in
 *  reconnect backlog replay). */
export function isPanelSystemFrame(ev: GatewayEvent): boolean {
  if (ev.type !== 'SYSTEM') return false;
  const m = (ev.metadata ?? {}) as Record<string, unknown>;
  return !!(m.routePreview || m.receiptList || m.receiptView || m.costSummary || m.approvalList);
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
