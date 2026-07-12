import { publishOnly } from './events.js';
import { getReceipt, MAX_REPLAY_BYTES, type ReceiptRow } from './receipts.js';
import { db } from './storage.js';

/**
 * TCLAW-5B-1: the safe diagnostic export redactor + GET_SAFE_EXPORT handler.
 *
 * This module is the ONLY path that emits redacted material to a client —
 * redaction runs HERE, in the gateway, never assembled client-side. The
 * whole purpose of this ticket is that secrets never leave the machine in an
 * export, so every design choice below is deliberately conservative:
 *
 *  1. ALLOWLIST PROJECTION, fail-closed: buildSafeExport copies EXPLICITLY
 *     NAMED fields out of the parsed full_receipt_json. An unknown/new key
 *     in full_receipt_json (a future field someone forgets to classify) NEVER
 *     exports — neither its key nor its value, at any nesting depth — because
 *     nothing ever does `{...parsed}`. A blocklist scrub of the whole receipt
 *     fails OPEN; this fails CLOSED.
 *  2. OMITTED WHOLESALE, no form whatsoever: taskPrompt, assembledContext,
 *     event replay (raw TOOL_CALL args, RESULT text), tool_approvals.args_json,
 *     memory/episode text, request_json free text. This module never reads
 *     tasks.request_json, never touches the events table, never reads
 *     tool_approvals.args_json. There is no "summarized" or "redacted"
 *     version of these fields in the export — they simply do not exist here.
 *  3. SCRUB SECOND, only on the retained residue: error, routerReason,
 *     routeDiagnostics.reason/.humanReason/.blockedAlternatives[].why, and the
 *     name-guarded fields (toolsCalled/blockedOn/approvals[].toolName). Only
 *     STRING values are scrubbed — typed numbers/enums/booleans in the
 *     allowlisted fields pass through untouched (the card-number pattern must
 *     never be given a chance to eat a numeric costUsd/elapsedMs field).
 *  4. CAP AFTER SCRUB (error, 2000 chars, matching dispatch.ts's sanitize
 *     precedent): capping before scrubbing can sever a secret below its
 *     pattern's minimum match length and leak an un-marked prefix.
 *  5. Scrub runs on DECODED values, recursively: for each designated string
 *     field, attempt JSON.parse; if it parses, scrub the parsed structure's
 *     string leaves recursively and re-serialize; else scrub the plain
 *     string. This defeats an escaped-JSON-in-string secret (a provider error
 *     body embedded as a JSON string inside `error`) and an escaped-unicode
 *     variant, neither of which a byte-level-only scrub would catch.
 *  6. Determinism + purity: buildSafeExport(row, approvals, REDACTOR_VERSION)
 *     is a pure function — no Date.now()/randomUUID/generatedAt anywhere in
 *     the payload, fixed key order, never mutates its inputs. Two calls with
 *     the same arguments produce byte-identical JSON.
 *  7. Fail CLOSED on throw: the never-throw wrapper (handleGetSafeExport)
 *     builds the COMPLETE safe object, then serializes it, then publishes —
 *     no incremental/partial emission. On ANY throw anywhere in that
 *     pipeline, it publishes EXACTLY the byte-exact fallback frame with no
 *     receipt-derived keys at all.
 *  8. Honest language only: the report and any prose in this module say
 *     "known secret shapes removed" — never "safe", "sanitized", or
 *     "no secrets". A regex allowlist can only ever check for KNOWN shapes;
 *     claiming more would be a lie an operator could get burned by.
 */

// ─── Redactor version ───────────────────────────────────────────────────────

/** Monotonic integer, bumped whenever SECRET_SHAPES or the scrub algorithm
 *  changes. Threaded as an explicit parameter into buildSafeExport (never
 *  read from a module-level default inside the pure function) so a
 *  version-sensitivity test can prove v1 vs v2 differ only in the version
 *  stamps, never silently drift via a captured closure. Carried in BOTH the
 *  top-level payload (`redactorVersion`) and the nested `redactionReport`. */
export const REDACTOR_VERSION = 1;

/** Export shape version (independent axis from REDACTOR_VERSION — the export
 *  JSON's field layout can change without every pattern-set bump, and vice
 *  versa). */
export const EXPORT_VERSION = 1;

// ─── SECRET_SHAPES ──────────────────────────────────────────────────────────
//
// Gateway-owned, FIXED ORDER (= report order — patternsHit is built by
// iterating this array once). Every replacement is exactly
// `[REDACTED:<label>]` — markers carry a LABEL only, never a fragment of the
// matched value (a marker containing part of a real secret would itself be a
// leak, and would risk being re-eaten by another pattern — see the
// idempotence/fixed-point test).
//
// Relationship to apps/console/src/components/friendly.ts PRIVACY_PATTERNS:
// this is a GATEWAY-OWNED SUPERSET, duplicated (not shared/imported), because
// the two sets have different jobs and different failure costs — console
// patterns are suggest-only per-keystroke UX hints (false positives must be
// dismissible, must never block submission); these are a server-side removal
// guarantee (tuned for coverage, `/g` global replace, label-only output). A
// cross-package parity test (tests/export-redaction.test.ts) imports
// PRIVACY_PATTERNS directly and asserts every console-pattern sample is also
// caught here, so this set can never silently narrow back to a subset of the
// console's — see also the cross-reference comment on PRIVACY_PATTERNS itself
// (apps/console/src/components/friendly.ts), which 5B-2 lands.
export interface SecretShape {
  label: string;
  re: RegExp;
}

export const SECRET_SHAPES: SecretShape[] = [
  // Extends dispatch.ts:28's Bearer-only sanitize (that regex protects a
  // different, narrower surface — the live ERROR terminal message — and
  // stays as-is; this is the export's own, broader pass).
  { label: 'bearer-token', re: /\bBearer\s+\S+/gi },
  // OpenAI-style AND Anthropic (`sk-ant-...`) keys share the `sk-` prefix.
  { label: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  // Superset of the console's ghp_-only pattern: covers every GitHub PAT
  // prefix (personal/oauth/user-to-server/server-to-server/refresh: ghp_,
  // gho_, ghu_, ghs_, ghr_).
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // The WHOLE PEM block, not just the header line — a private key's body
  // carries the actual secret material.
  {
    label: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  // High-precision 3-segment JWT shape (header.payload.signature, each
  // segment base64url of meaningful length) — chosen to avoid firing on
  // arbitrary short base64-looking tokens.
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { label: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // [G1R RC-5] NARROWED for false-positive safety: machine-generated error
  // text routinely carries 13-digit epoch-millis timestamps and long
  // sequential/id runs, which the console's FP-tolerant suggest-only pattern
  // (`\b(?:\d[ -]?){13,16}\b`) would happily eat as a "card number". A real
  // card number in a machine-generated diagnostic error is vanishingly rare;
  // an epoch timestamp or seq-id run is common. So the export's DESTRUCTIVE
  // scrub pattern requires actual card-like STRUCTURE:
  //   - separated groups: \d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4} (the visually
  //     grouped form humans/systems actually paste), OR
  //   - a contiguous 15 or 16 digit run (Amex/Visa/MC lengths) — but NOT 13
  //     or 14 digits, which is exactly where epoch-millis (13 digits) and
  //     many sequence/id shapes live. This deliberately does NOT match plain
  //     13-digit runs (excluded by construction) — see tests/export-
  //     redaction.test.ts's FP-negative corpus (13-digit epoch, long seq
  //     runs survive unmangled) and positive corpus (both card shapes still
  //     caught).
  { label: 'card-number', re: /\b(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}|\d{15,16})\b/g },
  // [G1R RC-2] Path rule, broadened + blessed: NO absolute path of any of the
  // three common shapes may survive, all mapped to the SAME single label
  // (label-replacement, not basename-only — the whole path is the leak, not
  // just the username segment). Relative basenames (src/foo.ts, foo.py) are
  // deliberately NOT touched by any of these three patterns (negative-pinned
  // in tests/export-redaction.test.ts) because none of them can match without
  // a drive letter, a leading `\\`, or one of the anchored home-dir prefixes.
  //   - bare-drive: `C:\...`, `E:\...` (Windows drive-letter absolute paths)
  { label: 'path', re: /\b[A-Za-z]:\\[^\s"']*/g },
  //   - UNC: `\\HOST\share\...`
  { label: 'path', re: /\\\\[^\s"']+/g },
  //   - POSIX home / tilde: /home/u/..., /Users/u/..., /root/..., ~/...
  { label: 'path', re: /(?:\/home\/|\/Users\/|\/root\/|~\/)[^\s"']*/g },
];

const REPLACEMENT = (label: string) => `[REDACTED:${label}]`;

// ─── scrubText: the recursive-decode scrub ─────────────────────────────────

/** Counts of replacement operations ACTUALLY PERFORMED, keyed by label.
 *  This is the ONLY source of truth for redactionReport.patternsHit — counts
 *  are accumulated here as matches are replaced, never derived by scanning
 *  output for `[REDACTED:...]` markers afterward (which a spoofed input
 *  pre-seeded with a fake marker could inflate). */
export type PatternHits = Map<string, number>;

function newHits(): PatternHits {
  return new Map();
}

function addHit(hits: PatternHits, label: string, n: number): void {
  if (n <= 0) return;
  hits.set(label, (hits.get(label) ?? 0) + n);
}

/** Apply every SECRET_SHAPES pattern to a single plain string, replacing
 *  matches with their label marker and recording counts into `hits`. Each
 *  pattern's global regex is applied fresh (regex objects with /g carry
 *  lastIndex state, so `re.exec`/`.test` reuse across calls would be a bug —
 *  we only ever use `.replace`, which resets its own scan per call, but we
 *  still never share a single RegExp instance's mutable state across two
 *  concurrent scrubs by constructing patterns as module-level constants used
 *  ONLY via String.prototype.replace, which is safe for /g regexes called
 *  sequentially like this). Pure: returns a new string, never mutates `s`. */
function applyPatternsToString(s: string, hits: PatternHits): string {
  let out = s;
  for (const { label, re } of SECRET_SHAPES) {
    // Fresh RegExp per call to guarantee no cross-call lastIndex leakage,
    // regardless of how this function is invoked (recursion, multiple
    // fields, repeated test runs against the same module-level pattern).
    const fresh = new RegExp(re.source, re.flags);
    let count = 0;
    out = out.replace(fresh, () => {
      count += 1;
      return REPLACEMENT(label);
    });
    addHit(hits, label, count);
  }
  return out;
}

/** Recursively scrub every string leaf in an arbitrary parsed JSON value
 *  (object/array/string/number/boolean/null), leaving non-string leaves
 *  (numbers/booleans/null) completely untouched — this is what keeps a
 *  numeric field that happens to parse out of a JSON-in-string blob (e.g. an
 *  embedded `{"code": 1518000000000}`) from ever being handed to the
 *  card-number pattern as a STRING. Returns a new structure; never mutates
 *  the input (buildSafeExport's purity depends on this all the way down). */
function scrubJsonValue(value: unknown, hits: PatternHits): unknown {
  if (typeof value === 'string') {
    // [G1R RC-1] Recursive decode: if this string itself parses as JSON
    // (a provider error body embedded as a JSON string, or an escaped-unicode
    // variant that JSON.parse un-escapes), scrub the DECODED structure's
    // string leaves and re-serialize — never scrub only the outer serialized
    // bytes, which would miss a secret hiding one level deeper inside an
    // escaped inner JSON string, or hiding behind a `\uXXXX` escape that only
    // JSON.parse (not a raw regex over the bytes) would decode.
    try {
      const inner = JSON.parse(value);
      // Only recurse if this actually decoded to something structured or at
      // least a different string — a bare scalar like `"5"` parses as the
      // number 5, which we still want scrubbed as an (empty) no-op rather
      // than accidentally treated as a number; re-stringifying keeps the
      // field a string as the schema expects.
      const scrubbedInner = scrubJsonValue(inner, hits);
      return JSON.stringify(scrubbedInner);
    } catch {
      // Not JSON — scrub as a plain string.
      return applyPatternsToString(value, hits);
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubJsonValue(v, hits));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubJsonValue(v, hits);
    }
    return out;
  }
  // number / boolean / null / undefined: pass through untouched. Typed
  // numeric/enum/boolean fields are NEVER handed to a string pattern.
  return value;
}

/** Public entry point: scrub ONE designated free-text string field.
 *  Recursive-decode (see scrubJsonValue) — attempts JSON.parse first; if it
 *  parses, scrubs the decoded structure's string leaves and re-serializes;
 *  else scrubs the plain string directly. Idempotent: scrubText(scrubText(s))
 *  === scrubText(s), because a marker `[REDACTED:<label>]` never itself
 *  matches any SECRET_SHAPES pattern (no pattern requires 13+ contiguous
 *  digits without separators appearing in a marker string, no `Bearer `
 *  prefix, no `sk-` prefix, etc. — pinned by the fixed-point test in
 *  tests/export-redaction.test.ts, which runs every marker literal against
 *  every pattern). Pure: never mutates `s`; returns a new string plus the
 *  hits recorded into the caller-supplied map (so a single buildSafeExport
 *  call can accumulate hits across many fields into one report). */
export function scrubText(s: string, hits: PatternHits): string {
  try {
    const parsed = JSON.parse(s);
    const scrubbed = scrubJsonValue(parsed, hits);
    return JSON.stringify(scrubbed);
  } catch {
    return applyPatternsToString(s, hits);
  }
}

/** Cap AFTER scrub — never before. Capping first can sever a secret below
 *  its pattern's minimum match length (e.g. an `sk-` key needs 16+ trailing
 *  chars to match) and leak an un-marked prefix with no marker anywhere in
 *  the output. This function assumes `s` has ALREADY been scrubbed. */
function capAfterScrub(s: string, maxChars: number): string {
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

const ERROR_MAX_CHARS = 2000; // matches dispatch.ts:28's sanitize precedent

// ─── Name-guard ─────────────────────────────────────────────────────────────

/** parseToolName (receipts.ts:100-116) falls back to the RAW EVENT MESSAGE
 *  verbatim when a TOOL_CALL message doesn't start with `Executing `, so
 *  toolsCalled entries (and, by the same construction, blockedOn and
 *  approvals[].toolName, which are also tool-name-shaped strings sourced from
 *  the same kind of upstream data) are NOT structurally guaranteed to be bare
 *  tool names — they can be arbitrary free text. An entry matching this
 *  shape passes verbatim; anything else becomes the fixed marker
 *  `[REDACTED:unparsed-tool-entry]`, which is itself counted in the report
 *  (a name-guard rejection is real redactor activity, just like a pattern
 *  hit) under the `unparsed-tool-entry` label. */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNPARSED_TOOL_LABEL = 'unparsed-tool-entry';
const UNPARSED_TOOL_MARKER = REPLACEMENT(UNPARSED_TOOL_LABEL);

function guardToolName(name: string | null, hits: PatternHits): string | null {
  if (name === null) return null;
  if (TOOL_NAME_RE.test(name)) return name;
  addHit(hits, UNPARSED_TOOL_LABEL, 1);
  return UNPARSED_TOOL_MARKER;
}

// ─── errorClass ─────────────────────────────────────────────────────────────

/** [G1R SC-3] The stable, machine-safe error-classification prefixes that
 *  dispatch.ts writes verbatim at the front of certain failure reasons
 *  (dispatch.ts: `BUDGET: ${...}`, `CAP_EXCEEDED: ${...}`,
 *  `DENIED: tool ... denied by user`, `FRONTIER_UNAVAILABLE: ...`). These
 *  four prefixes are themselves safe — they carry no secret material by
 *  construction — so they're exported as their OWN verbatim field
 *  (`errorClass`), independent of the scrubbed+capped `error` residue. Order
 *  matters only for output determinism, not matching priority (the prefixes
 *  are mutually exclusive by construction). */
const ERROR_CLASS_PREFIXES = ['BUDGET:', 'CAP_EXCEEDED:', 'DENIED:', 'FRONTIER_UNAVAILABLE:'] as const;
export type ErrorClass = (typeof ERROR_CLASS_PREFIXES)[number] | null;

function classifyError(error: string | null): ErrorClass {
  if (error === null) return null;
  for (const prefix of ERROR_CLASS_PREFIXES) {
    if (error.startsWith(prefix)) return prefix;
  }
  return null;
}

// ─── LIVE approvals (never the frozen full_receipt_json.approvals embed) ───

/** [G1R ruling 5 / decisive]: full_receipt_json.approvals is a PROJECTION-TIME
 *  SNAPSHOT — receipts materialize at the PENDING_APPROVAL terminal (before
 *  any decision is made) and are never re-projected afterward (see the FILED
 *  TCLAW-FIX-G obligation), so the embed can read 'pending' forever even
 *  after a real decideApproval. A support diagnostic showing a stale
 *  'pending' when the tool was actually approved/rejected is a DATA LIE.
 *  This query re-reads tool_approvals directly at export time — the exact
 *  `selectApprovals` shape receipts.ts's projector itself uses (SELECT
 *  status, tool_name, decided_at ... WHERE request_id = ?), so the live read
 *  is provably the same query the projector runs, just executed fresh. */
const selectLiveApprovals = db.prepare(
  `SELECT status, tool_name, decided_at FROM tool_approvals WHERE request_id = ?`,
);

interface LiveApprovalRow {
  status: string;
  tool_name: string;
  decided_at: string | null;
}

export interface SafeExportApproval {
  toolName: string | null;
  status: string;
  decidedAt: string | null;
}

/** SELECT-only. Returns the CURRENT tool_approvals rows for this task,
 *  name-guarded, in the export's approval shape. Deliberately excludes
 *  args_json (never read here at all — approvals.ts's own LIST_APPROVALS
 *  precedent already excludes it from summaries). */
export function selectLiveApprovalsForExport(taskId: string, hits: PatternHits): SafeExportApproval[] {
  const rows = selectLiveApprovals.all(taskId) as LiveApprovalRow[];
  return rows.map((r) => ({
    toolName: guardToolName(r.tool_name, hits),
    status: r.status,
    decidedAt: r.decided_at,
  }));
}

// ─── Export shape ───────────────────────────────────────────────────────────

export interface SafeExportRoute {
  tier: string | null;
  ruleId: string | null;
  score: number | null;
  overridable: boolean | null;
  safetyLock: string | null;
  profile: string | null;
  reason: string | null;
  humanReason: string | null;
  blockedAlternatives: Array<{ tier: string | null; why: string | null }> | null;
  routerReason: string | null;
}

export interface SafeExportCost {
  budgetLimit: number | null;
  budgetSource: string | null;
  costUsd: number | null;
  costSource: string | null;
  costEnforceable: number | null;
}

export interface SafeExportExecution {
  elapsedMs: number | null;
  iterations: number | null;
  memoryUsed: boolean | null;
  contextChars: number | null;
}

export interface SafeExportEvidence {
  startSeq: number | null;
  endSeq: number | null;
}

/** Static, truthful list of fields this export NEVER carries in any form.
 *  This is NOT computed from anything — it is a fixed declaration of the
 *  omission contract itself, so it can never drift silently (a change here
 *  is a deliberate, reviewable edit, not a derived value that could rot). */
const FIELDS_OMITTED = [
  'taskPrompt',
  'assembledContext',
  'events',
  'toolCallArgs',
  'results',
  'approvalArgs',
] as const;

const HONESTY_NOTICE =
  'Known secret shapes removed. This export does not and cannot claim to contain no secrets.';

export interface RedactionReport {
  redactorVersion: number;
  patternsHit: Record<string, number>;
  fieldsOmitted: readonly string[];
  notice: string;
}

export interface SafeExport {
  torqclawSafeExport: true;
  exportVersion: number;
  redactorVersion: number;
  projectionVersion: number | null;
  taskId: string;
  sessionId: string | null;
  sourceChannel: string | null;
  selectedTier: string | null;
  state: string | null;
  resultState: string | null;
  cancelled: boolean | null;
  blockedOn: string | null;
  route: SafeExportRoute;
  cost: SafeExportCost;
  execution: SafeExportExecution;
  toolsCalled: string[];
  approvals: SafeExportApproval[];
  evidence: SafeExportEvidence;
  errorClass: ErrorClass;
  error: string | null;
  redactionReport: RedactionReport;
}

/** Shape of the parsed full_receipt_json this module reads FROM. Mirrors the
 *  `fullReceipt` object receipts.ts:233-257 builds — but note this is an
 *  ALLOWLIST read: every field consumed below is named explicitly; nothing
 *  here ever does `{...parsed}` or iterates parsed's own keys. An unknown
 *  key on the real parsed object (including a maliciously/accidentally
 *  injected one, top-level or nested inside routeDiagnostics) is simply never
 *  looked at, so it can never reach the output — this is what "fail-closed"
 *  means operationally: the projection walks a fixed list of paths, not the
 *  object's own enumerable keys. */
interface ParsedFullReceipt {
  taskId?: unknown;
  sessionId?: unknown;
  sourceChannel?: unknown;
  selectedTier?: unknown;
  routerReason?: unknown;
  state?: unknown;
  resultState?: unknown;
  routeDiagnostics?: {
    score?: unknown;
    reason?: unknown;
    tier?: unknown;
    ruleId?: unknown;
    humanReason?: unknown;
    blockedAlternatives?: unknown;
    overridable?: unknown;
    safetyLock?: unknown;
    profile?: unknown;
  } | null;
  budgetLimit?: unknown;
  budgetSource?: unknown;
  costUsd?: unknown;
  costSource?: unknown;
  costEnforceable?: unknown;
  elapsedMs?: unknown;
  iterations?: unknown;
  cancelled?: unknown;
  blockedOn?: unknown;
  memoryUsed?: unknown;
  contextChars?: unknown;
  toolsCalled?: unknown;
  evidence?: { startSeq?: unknown; endSeq?: unknown } | null;
  error?: unknown;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
function asBooleanOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Scrub a possibly-absent string field (route diagnostic reasons and
 *  similar). Absent (non-string) input stays null — no fabrication. Hits
 *  accumulate into the shared `hits` map. */
function scrubOptionalString(v: unknown, hits: PatternHits): string | null {
  if (typeof v !== 'string') return null;
  return scrubText(v, hits);
}

/** Allowlist-project blockedAlternatives: only `{tier, why}` per entry, `why`
 *  scrubbed. A non-array or malformed entry yields an empty list rather than
 *  fabricating placeholder entries — absent structure is represented as
 *  "nothing to report", never invented. */
function projectBlockedAlternatives(
  v: unknown,
  hits: PatternHits,
): Array<{ tier: string | null; why: string | null }> | null {
  if (!Array.isArray(v)) return null;
  return v.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      tier: asStringOrNull(e.tier),
      why: scrubOptionalString(e.why, hits),
    };
  });
}

/** Allowlist-project toolsCalled: each entry name-guarded. A non-array input
 *  (should never happen given the projector's own typing, but the allowlist
 *  discipline treats even the receipt row as untrusted input) yields []. */
function projectToolsCalled(v: unknown, hits: PatternHits): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((entry) => (typeof entry === 'string' ? entry : String(entry)))
    .map((entry) => guardToolName(entry, hits))
    .filter((entry): entry is string => entry !== null);
}

/**
 * buildSafeExport — PURE function, the heart of the redactor.
 *
 * (row, liveApprovals, redactorVersion) -> SafeExport. Never throws on
 * malformed input by design intent (every accessor above degrades to
 * null/[]  rather than throwing) — the ONLY realistic throw source is a
 * pathological regex/JSON edge case, which the caller (handleGetSafeExport)
 * wraps in the fail-closed try/catch regardless, per invariant 9.
 *
 * PURITY: never mutates `row` or `liveApprovals` (every derived value is
 * freshly constructed); never reads Date.now()/Math.random()/any global
 * mutable state; the ONLY inputs that influence the output are the three
 * parameters. Two calls with byte-identical arguments produce byte-identical
 * JSON.stringify output — this is what makes the export a computed-on-demand
 * projection rather than something that needs to be cached for consistency.
 */
export function buildSafeExport(
  row: ReceiptRow,
  liveApprovals: SafeExportApproval[],
  redactorVersion: number,
): SafeExport {
  const hits: PatternHits = newHits();

  let parsed: ParsedFullReceipt = {};
  try {
    parsed = JSON.parse(row.full_receipt_json) as ParsedFullReceipt;
  } catch {
    parsed = {};
  }

  const rd = parsed.routeDiagnostics ?? null;

  const route: SafeExportRoute = {
    tier: asStringOrNull(rd?.tier),
    ruleId: asStringOrNull(rd?.ruleId),
    score: asNumberOrNull(rd?.score),
    overridable: asBooleanOrNull(rd?.overridable),
    safetyLock: asStringOrNull(rd?.safetyLock),
    profile: asStringOrNull(rd?.profile),
    reason: scrubOptionalString(rd?.reason, hits),
    humanReason: scrubOptionalString(rd?.humanReason, hits),
    blockedAlternatives: projectBlockedAlternatives(rd?.blockedAlternatives, hits),
    routerReason: scrubOptionalString(parsed.routerReason, hits),
  };

  const cost: SafeExportCost = {
    budgetLimit: asNumberOrNull(parsed.budgetLimit),
    budgetSource: asStringOrNull(parsed.budgetSource),
    costUsd: asNumberOrNull(parsed.costUsd),
    costSource: asStringOrNull(parsed.costSource),
    costEnforceable: asNumberOrNull(parsed.costEnforceable),
  };

  const execution: SafeExportExecution = {
    elapsedMs: asNumberOrNull(parsed.elapsedMs),
    iterations: asNumberOrNull(parsed.iterations),
    memoryUsed: asBooleanOrNull(parsed.memoryUsed),
    contextChars: asNumberOrNull(parsed.contextChars),
  };

  const evidence: SafeExportEvidence = {
    startSeq: asNumberOrNull(parsed.evidence?.startSeq),
    endSeq: asNumberOrNull(parsed.evidence?.endSeq),
  };

  const rawError = asStringOrNull(parsed.error);
  const errorClass = classifyError(rawError);
  // SCRUB FIRST, THEN CAP — never the other order. Capping before scrubbing
  // can sever a secret mid-token so its truncated prefix no longer meets a
  // pattern's minimum length and slips through with no marker.
  const scrubbedError = rawError === null ? null : scrubText(rawError, hits);
  const error = scrubbedError === null ? null : capAfterScrub(scrubbedError, ERROR_MAX_CHARS);

  // NOTE: blockedOn and toolsCalled are computed BEFORE the patternsHit
  // snapshot below (not inline in the return object literal) — every call
  // that can record a hit into `hits` MUST run before patternsHit is read
  // out of it, or a name-guard/pattern hit from one of these two fields
  // would silently vanish from the report while still being applied to the
  // actual output (a report-undercounts-itself bug, not a security leak, but
  // a dishonesty bug the honest-language invariant forbids just the same).
  const blockedOn = guardToolName(asStringOrNull(parsed.blockedOn) ?? row.blocked_on ?? null, hits);
  const toolsCalled = projectToolsCalled(parsed.toolsCalled, hits);

  const patternsHit: Record<string, number> = {};
  // Fixed order = SECRET_SHAPES iteration order (plus the name-guard label,
  // appended last) — never Object.keys/Map insertion-order-of-first-hit,
  // which would vary by which field happened to be scrubbed first.
  const orderedLabels = [...new Set(SECRET_SHAPES.map((p) => p.label)), UNPARSED_TOOL_LABEL];
  for (const label of orderedLabels) {
    const n = hits.get(label);
    if (n && n > 0) patternsHit[label] = n;
  }

  return {
    torqclawSafeExport: true,
    exportVersion: EXPORT_VERSION,
    redactorVersion,
    projectionVersion: typeof row.projection_version === 'number' ? row.projection_version : null,
    taskId: row.task_id,
    sessionId: row.session_id ?? null,
    sourceChannel: asStringOrNull(parsed.sourceChannel) ?? row.source_channel ?? null,
    selectedTier: asStringOrNull(parsed.selectedTier) ?? row.selected_tier ?? null,
    state: asStringOrNull(parsed.state),
    resultState: asStringOrNull(parsed.resultState) ?? row.result_state ?? null,
    cancelled: asBooleanOrNull(parsed.cancelled),
    blockedOn,
    route,
    cost,
    execution,
    toolsCalled,
    approvals: liveApprovals,
    evidence,
    errorClass,
    error,
    redactionReport: {
      redactorVersion,
      patternsHit,
      fieldsOmitted: FIELDS_OMITTED,
      notice: HONESTY_NOTICE,
    },
  };
}

// ─── Fail-closed fallback frame ─────────────────────────────────────────────

/** The EXACT frame published on any throw anywhere in the build/serialize
 *  pipeline. Byte-exact key set, no receipt-derived keys whatsoever — this is
 *  the worst-case output, and it must never carry even a fragment of the
 *  receipt it failed to redact. */
function fallbackFrame(taskId: string): { safeExportView: true; taskId: string; safeExport: null; error: 'export_failed' } {
  return { safeExportView: true, taskId, safeExport: null, error: 'export_failed' };
}

// ─── Handler (server.ts delegates verbatim) ────────────────────────────────
//
// House handler-comment discipline (receipts.ts:472-488 template): server.ts's
// /ws command switch delegates GET_SAFE_EXPORT here verbatim — there is NO
// parallel copy of this logic anywhere. Zero writes: this handler only SELECTs
// (getReceipt, selectLiveApprovalsForExport) and publishOnly (which never
// INSERTs) — nothing here can dispatch, decide an approval, or mutate
// tasks/events/tool_approvals/run_receipts. safe_export_json is NEVER written
// by this path (no UPDATE, no lazy-fill) — it stays exactly what
// projectReceipt already put there (always NULL) forever; this handler
// doesn't even know that column exists. tests/export-redaction.test.ts proves
// row counts and full-table dumps are byte-identical before/after driving
// this handler.
export function handleGetSafeExport(sessionId: string, taskId: string): void {
  const row = getReceipt(taskId);

  // OWNERSHIP CHECK — identical shape to handleGetReceipt (receipts.ts:535-
  // 547): a foreign taskId (row exists, different session) MUST produce the
  // exact same frame as an absent taskId. No existence oracle.
  if (!row || row.session_id !== sessionId) {
    publishOnly(sessionId, {
      message: 'No receipt for this task',
      metadata: { safeExportView: true, taskId, safeExport: null },
    });
    return;
  }

  try {
    // Live approvals are read INSIDE the try, as part of "the complete safe
    // object" this function builds before ever publishing anything — a throw
    // here must fall into the same fail-closed fallback as a throw inside
    // buildSafeExport itself.
    const hitsForApprovals: PatternHits = newHits(); // name-guard hits folded into buildSafeExport's own count via re-guarding is unnecessary; approvals are guarded once, here.
    const liveApprovals = selectLiveApprovalsForExport(taskId, hitsForApprovals);

    const safeExport = buildSafeExport(row, liveApprovals, REDACTOR_VERSION);

    // Fold any name-guard hits recorded while reading live approvals into the
    // report, so a guarded approval toolName is honestly counted too. Done by
    // merging BEFORE serialization — still "build complete object, then
    // serialize, then publish".
    for (const [label, n] of hitsForApprovals) {
      safeExport.redactionReport.patternsHit[label] =
        (safeExport.redactionReport.patternsHit[label] ?? 0) + n;
    }

    const serialized = JSON.stringify(safeExport);
    const byteLength = Buffer.byteLength(serialized, 'utf8');

    if (byteLength > MAX_REPLAY_BYTES) {
      // OVERSIZE GUARD: all-or-marker, reusing the exact MAX_REPLAY_BYTES
      // constant and never-truncate discipline as GET_RECEIPT's includeEvents
      // guard (receipts.ts:574-583) — a silently-truncated export would be a
      // data lie, and JSON must always parse.
      publishOnly(sessionId, {
        message: 'Safe export',
        metadata: {
          safeExportView: true,
          taskId,
          safeExport: null,
          exportOmitted: { reason: 'too_large' },
        },
      });
      return;
    }

    publishOnly(sessionId, {
      message: 'Safe export',
      metadata: { safeExportView: true, taskId, safeExport },
    });
  } catch {
    // FAIL CLOSED: never publish a partial/unredacted payload. This catch
    // wraps the ENTIRE build-serialize-size-check pipeline (invariant 9) —
    // not just the serialize step — so a throw at ANY point in that pipeline
    // (a pathological regex, a JSON.stringify failure, anything) lands here,
    // never mid-flight with half a payload already sent.
    publishOnly(sessionId, { message: 'Safe export failed', metadata: fallbackFrame(taskId) });
  }
}
