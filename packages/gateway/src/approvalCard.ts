/**
 * C2-6 — the bounded/redacted approval-card contract (property 8).
 * PRD-TCLAW-COLLAB-GATEWAY-004 §3.3 prop 8, §3.10, §6.9, §8 C2-6.
 *
 * THE HOLE THIS CLOSES (operator ruling 2026-08-11, §3.1)
 * -------------------------------------------------------
 * The shipped pre-C2 path emits the model's RAW proposed arguments in
 * PENDING_APPROVAL event metadata (`dispatch.ts`, `args: error.args`).
 * That frame goes to the wire AND into the persisted event log. The
 * operator's at-rest retention ruling explicitly did NOT waive this: "raw
 * args never on wire/log" remains a mandatory built-artifact gate.
 *
 * So this module produces the ONLY representation of proposed arguments
 * that may leave the gateway: a bounded, redacted, allowlist-shaped
 * summary. The raw bytes stay in `tool_approvals.args_json` for audit and
 * are never emitted.
 *
 * ALLOWLIST, NOT BLOCKLIST (export.ts discipline, reused deliberately)
 * --------------------------------------------------------------------
 * The card names the keys it will show and derives a TYPE-ONLY descriptor
 * for their values. It never does `{...args}`. An unknown or newly-added
 * argument key therefore cannot leak by default -- it is summarized by
 * shape (`"<string, 42 chars>"`), never by content. A blocklist scrub of
 * the whole object would fail OPEN on the first key nobody classified;
 * this fails CLOSED.
 *
 * Values that ARE shown (short scalars from allowlisted keys) still go
 * through `redactKnownSecretText`, so a token pasted into a path argument
 * is removed rather than displayed.
 *
 * HONEST LANGUAGE ONLY (§3.10)
 * -----------------------------
 * The wording is "known secret shapes removed" -- never "safe",
 * "sanitized", or "no secrets". A regex allowlist can only ever check for
 * KNOWN shapes; claiming more would be a lie an operator could get burned
 * by. This mirrors export.ts's rule verbatim.
 */

import { redactKnownSecretText } from './knownSecretShapes.js';

/** Bump when the card's shape or redaction discipline changes. */
export const APPROVAL_CARD_VERSION = 1;

/** Hard caps. A card is a decision aid, not a payload channel. */
export const MAX_SUMMARIZED_KEYS = 24;
export const MAX_VALUE_CHARS = 120;
export const MAX_LABEL_CHARS = 200;

/**
 * Argument keys whose (short, scalar) values are meaningful on a decision
 * card -- overwhelmingly the "what does this act on" keys. Everything else
 * is described by type and size only.
 *
 * This list is intentionally conservative. Adding a key here is a decision
 * to SHOW its value to whoever can see the card, so it is reviewed.
 */
const VALUE_VISIBLE_KEYS: ReadonlySet<string> = new Set([
  'path', 'paths', 'file', 'files', 'filename', 'dir', 'directory',
  'url', 'uri', 'host', 'command', 'cmd', 'query', 'pattern', 'name',
]);

export interface ApprovalCardArgSummary {
  key: string;
  /** A type/shape descriptor, always present. */
  type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
  /** Redacted, capped value -- ONLY for allowlisted keys with scalars. */
  value?: string;
  /** Size hint for values that are never shown (chars, items, or keys). */
  size?: number;
  /** True when the value was withheld by policy rather than absent. */
  withheld?: boolean;
}

export interface ApprovalCard {
  cardVersion: number;
  approvalId: string;
  requestId: string;
  toolName: string;
  status: string;
  createdAt: string;
  /** Server-authoritative deadline + clock, so a client never guesses TTL. */
  expiresAt: string | null;
  serverNow: string;
  /** Server-derived; a client must never compute its own permission. */
  canApprove: boolean;
  canReject: boolean;
  /** Populated when canApprove/canReject are false. Textual, never a colour. */
  unavailableReason: string | null;
  /** Human-readable, redacted action label (accessible name, §6.9). */
  actionLabel: string;
  /** Bounded, redacted per-key summaries. NEVER the raw args. */
  argSummaries: ApprovalCardArgSummary[];
  /** True when args were truncated to MAX_SUMMARIZED_KEYS. */
  argsTruncated: boolean;
  /** One-shot scope statement (property 11). */
  grantScope: 'one-shot';
  /** Honest redaction wording (§3.10). */
  redactionNote: string;
}

export const REDACTION_NOTE = 'known secret shapes removed; this is not a guarantee of absence';

function capped(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Redact-then-cap a single display string. Exported because the gate facts
 * on the PENDING_APPROVAL frame (`targets`, lifted verbatim out of the
 * proposed args) are raw argument content and must cross the boundary
 * under exactly this discipline.
 */
export function redactCardText(value: string): string {
  return capped(redactKnownSecretText(value), MAX_VALUE_CHARS);
}

/**
 * Summarize ONE argument value.
 *
 * The cap runs AFTER redaction, never before: capping first could sever a
 * secret below its pattern's minimum match length and emit an un-marked
 * prefix. This is the same ordering rule export.ts documents.
 */
function summarizeValue(key: string, value: unknown): ApprovalCardArgSummary {
  if (value === null) return { key, type: 'null' };

  if (Array.isArray(value)) {
    return { key, type: 'array', size: value.length, withheld: true };
  }
  if (typeof value === 'object') {
    return { key, type: 'object', size: Object.keys(value as object).length, withheld: true };
  }
  // THE ALLOWLIST GATE RUNS FIRST, FOR EVERY PRIMITIVE TYPE.
  //
  // An earlier version tested `typeof value === 'boolean' | 'number'`
  // BEFORE this gate and stringified those unconditionally, so
  // `{ account: 4111111111111111, pin: 123456 }` crossed the wire and
  // entered the persisted event log verbatim. That was a hole in this
  // module's own fail-closed contract, opened by the tacit assumption that
  // "a number cannot be a secret" -- but card numbers, PINs, account ids
  // and numeric tokens are exactly that.
  //
  // The allowlist now decides WHETHER a value is shown; the primitive type
  // only decides how an already-allowed value is rendered.
  const type: ApprovalCardArgSummary['type'] =
    typeof value === 'boolean' ? 'boolean'
      : typeof value === 'number' ? 'number'
        : 'string';
  const str = String(value);
  if (!VALUE_VISIBLE_KEYS.has(key)) {
    // Not allowlisted: report shape only. The fail-closed default that
    // makes an unclassified new key harmless, whatever its type.
    return { key, type, size: str.length, withheld: true };
  }
  return { key, type, value: capped(redactKnownSecretText(str), MAX_VALUE_CHARS) };
}

/**
 * Build the bounded/redacted summaries from the PERSISTED canonical args
 * string. Malformed or non-object stored args produce an empty summary
 * list rather than throwing -- a card that cannot render must still render
 * the decision, and the authorization path never depends on this view.
 */
export function summarizeArgs(canonicalArgs: string): {
  summaries: ApprovalCardArgSummary[]; truncated: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalArgs);
  } catch {
    return { summaries: [], truncated: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { summaries: [], truncated: false };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  const shown = entries.slice(0, MAX_SUMMARIZED_KEYS);
  return {
    summaries: shown.map(([k, v]) => summarizeValue(k, v)),
    truncated: entries.length > shown.length,
  };
}

/**
 * A short, redacted, human-readable action label -- the accessible name a
 * screen reader announces (§6.9). Redaction must not erase the action's
 * meaningful name, so the TOOL name is always present.
 */
export function buildActionLabel(toolName: string, summaries: ApprovalCardArgSummary[]): string {
  const target = summaries.find((s) => s.value !== undefined && VALUE_VISIBLE_KEYS.has(s.key));
  const label = target ? `${toolName} → ${target.value}` : toolName;
  return capped(label, MAX_LABEL_CHARS);
}

export interface BuildCardParams {
  approvalId: string;
  requestId: string;
  toolName: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  serverNow: string;
  canApprove: boolean;
  canReject: boolean;
  unavailableReason?: string | null;
  /** The persisted canonical args string. */
  canonicalArgs: string;
}

/**
 * The ONLY sanctioned representation of an approval for a client surface.
 *
 * Pure and deterministic: no Date.now(), no randomUUID, no mutation of
 * inputs. Two calls with the same arguments produce identical output,
 * which is what lets a delivery projection be rebuilt without drift.
 */
export function buildApprovalCard(params: BuildCardParams): ApprovalCard {
  const { summaries, truncated } = summarizeArgs(params.canonicalArgs);
  return {
    cardVersion: APPROVAL_CARD_VERSION,
    approvalId: params.approvalId,
    requestId: params.requestId,
    toolName: params.toolName,
    status: params.status,
    createdAt: params.createdAt,
    expiresAt: params.expiresAt,
    serverNow: params.serverNow,
    canApprove: params.canApprove,
    canReject: params.canReject,
    unavailableReason: params.unavailableReason ?? null,
    actionLabel: buildActionLabel(params.toolName, summaries),
    argSummaries: summaries,
    argsTruncated: truncated,
    grantScope: 'one-shot',
    redactionNote: REDACTION_NOTE,
  };
}
