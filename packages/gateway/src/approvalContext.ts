/**
 * C2-5 — the frozen canonical digests: `CTXHASH_V1` and `ACTIONHASH_V1`.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §3.1, §3.4.1, §3.4.2, §8 C2-5.
 *
 * WHY A LENGTH-PREFIX-FRAMED BYTE STREAM AND NOT JSON
 * ---------------------------------------------------
 * Freezing the ten semantic fields is necessary but NOT sufficient for the
 * PRD's "independently reproducible" bar: two implementations must produce
 * identical BYTES from the same ten values. Hashing a JSON object would
 * leave key order, whitespace, and number formatting as unpinned second
 * variables. Hashing a plain concatenation would let field boundaries be
 * forged -- ("ab","c") and ("a","bc") would collide.
 *
 * So the input is a versioned, length-prefix-framed stream:
 *
 *     "CTXHASH_V1" || U32BE(len(f1)) || f1 || ... || U32BE(len(f10)) || f10
 *
 * The version tag is INSIDE the hashed bytes, so CTXHASH_V1 and a future
 * CTXHASH_V2 can never collide. Lengths are UTF-8 BYTE lengths, not JS
 * string lengths -- the difference is exactly the non-ASCII case the frozen
 * vectors exercise ('é' is 2 bytes, 1 char).
 *
 * PRESENCE VS EMPTINESS (the injectivity clause, §3.4.1)
 * ------------------------------------------------------
 * All ten fields are REQUIRED and non-null. An explicitly present empty
 * string legitimately encodes as U32BE(0), but ABSENCE is never mapped to
 * it -- absence refuses instead. Collapsing the two would break
 * injectivity, which is the whole reason the framing exists.
 *
 * THESE VECTORS ARE THE CONTRACT
 * ------------------------------
 * The PRD freezes five vectors (ACTIONHASH_V1, the CTXHASH framing-only
 * vector, and the three inner digests plus their end-to-end CTXHASH). This
 * implementation reproduces all five byte-for-byte; the tests assert them
 * against the literal PRD values rather than against whatever this code
 * happens to compute.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '@torqclaw/collab';

export const CTXHASH_VERSION = 'CTXHASH_V1';
export const ACTIONHASH_VERSION = 'ACTIONHASH_V1';

/** Versioned gateway source constants that feed the inner digests (§3.4.1). */
export const APPROVAL_REDACTION_POLICY_VERSION = 'torqclaw.redaction/v1';
export const ROUTER_POLICY_VERSION = 'torqclaw.router/v1';

export class ApprovalContextError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApprovalContextError';
    this.code = code;
  }
}

/** U32BE length prefix. Values above 0xffffffff are rejected (§3.4.1). */
function u32be(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) {
    throw new ApprovalContextError('FIELD_TOO_LONG', `field length ${n} is out of U32BE range`);
  }
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/**
 * The frozen framing primitive shared by both digests.
 *
 * `fields` must be present strings. `null`/`undefined` refuse rather than
 * encoding as empty -- see the presence-vs-emptiness note above.
 */
export function frameFields(versionTag: string, fields: ReadonlyArray<string>): Buffer {
  const parts: Buffer[] = [Buffer.from(versionTag, 'utf8')];
  for (let i = 0; i < fields.length; i += 1) {
    const value = fields[i];
    if (typeof value !== 'string') {
      throw new ApprovalContextError(
        'MISSING_FIELD',
        `${versionTag} field ${i + 1} is absent; every field is required and non-null`,
      );
    }
    const bytes = Buffer.from(value, 'utf8');
    parts.push(u32be(bytes.length), bytes);
  }
  return Buffer.concat(parts);
}

function sha256Hex(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Argument validation (§3.1) — what may become a C2 registration at all
// ---------------------------------------------------------------------------

/**
 * A new flag-on C2 registration requires a PRESENT, acyclic, plain JSON
 * object; a no-argument tool supplies `{}`.
 *
 * Everything else is refused BEFORE any pending row exists: null, undefined,
 * root arrays/scalars, sparse arrays, non-plain objects, cycles, functions,
 * symbols, bigint, non-finite numbers. The refusal is deliberately early --
 * a row that cannot be canonicalized could never be matched at the
 * pre-execution seam, so admitting one would create an approval that can
 * only ever fail to execute.
 *
 * Returns the exact UTF-8 canonical bytes to persist. The gateway hashes
 * THESE bytes; the regenerated actual call independently canonicalizes and
 * must match.
 */
export function validateAndCanonicalizeArgs(args: unknown): string {
  if (args === null || args === undefined) {
    throw new ApprovalContextError('ARGS_ABSENT', 'args must be a present plain object; a no-argument tool supplies {}');
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ApprovalContextError('ARGS_NOT_PLAIN_OBJECT', 'args must be a plain JSON object at the root');
  }
  const proto = Object.getPrototypeOf(args);
  if (proto !== Object.prototype && proto !== null) {
    throw new ApprovalContextError('ARGS_NOT_PLAIN_OBJECT', 'args root must be a plain object');
  }
  assertAcyclicPlain(args, new Set<object>());
  try {
    return canonicalJson(args);
  } catch (err) {
    throw new ApprovalContextError('ARGS_NOT_CANONICALIZABLE', `args are not canonicalizable: ${String(err)}`);
  }
}

function assertAcyclicPlain(value: unknown, seen: Set<object>): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new ApprovalContextError('ARGS_NON_FINITE', 'non-finite numbers are not representable in JSON');
    }
    return;
  }
  if (t === 'undefined') throw new ApprovalContextError('ARGS_UNDEFINED_MEMBER', 'undefined is not a JSON value');
  if (t === 'function') throw new ApprovalContextError('ARGS_FUNCTION', 'functions are not JSON values');
  if (t === 'symbol') throw new ApprovalContextError('ARGS_SYMBOL', 'symbols are not JSON values');
  if (t === 'bigint') throw new ApprovalContextError('ARGS_BIGINT', 'bigint is not a JSON value');
  if (t !== 'object') throw new ApprovalContextError('ARGS_UNSUPPORTED', `unsupported value type: ${t}`);

  const obj = value as object;
  if (seen.has(obj)) throw new ApprovalContextError('ARGS_CYCLIC', 'args contain a cycle');
  seen.add(obj);

  if (Array.isArray(obj)) {
    // A sparse array would canonicalize its holes into nulls, silently
    // changing meaning between registration and the regenerated call.
    for (let i = 0; i < obj.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(obj, i)) {
        throw new ApprovalContextError('ARGS_SPARSE_ARRAY', 'sparse arrays are not permitted');
      }
      assertAcyclicPlain((obj as unknown[])[i], seen);
    }
  } else {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new ApprovalContextError('ARGS_NOT_PLAIN_OBJECT', 'nested non-plain objects are not permitted');
    }
    for (const key of Object.keys(obj)) {
      assertAcyclicPlain((obj as Record<string, unknown>)[key], seen);
    }
  }
  seen.delete(obj);
}

// ---------------------------------------------------------------------------
// ACTIONHASH_V1 (§3.1)
// ---------------------------------------------------------------------------

/**
 * SHA-256 over the ASCII version tag followed by three required
 * U32BE-length-prefixed UTF-8 fields, in order: the exact stored
 * `request_id`, the exact NAMESPACED `tool_name`, and the exact canonical
 * arg bytes.
 *
 * `canonicalArgs` is the ALREADY-canonical string (what registration
 * persisted). It is deliberately not re-serialized here: re-serializing
 * would make this function's output depend on a second canonicalization
 * pass rather than on the stored bytes.
 *
 * Using the re-minted dispatch id instead of the source request id, or the
 * raw tool name instead of the namespaced one, changes the digest -- both
 * are named mutation tests.
 */
export function actionHash(requestId: string, toolName: string, canonicalArgs: string): string {
  return sha256Hex(frameFields(ACTIONHASH_VERSION, [requestId, toolName, canonicalArgs]));
}

// ---------------------------------------------------------------------------
// The three inner digests (§3.4.1)
// ---------------------------------------------------------------------------

export interface PrivacyContextInput {
  containsSensitiveData: boolean;
}

export function privacyContextHash(input: PrivacyContextInput): string {
  return sha256Hex(Buffer.from(canonicalJson({
    schemaVersion: 'torqclaw.approval-privacy/v1',
    containsSensitiveData: input.containsSensitiveData,
    redactionPolicyRevision: APPROVAL_REDACTION_POLICY_VERSION,
  }), 'utf8'));
}

export interface RoutingContextInput {
  executionMode: string;
  selectedTier: string;
  /** Explicit null when the router reports no rule -- never omitted. */
  ruleId: string | null;
}

export function routingContextHash(input: RoutingContextInput): string {
  return sha256Hex(Buffer.from(canonicalJson({
    schemaVersion: 'torqclaw.approval-routing/v1',
    executionMode: input.executionMode,
    selectedTier: input.selectedTier,
    ruleId: input.ruleId ?? null,
    routerPolicyRevision: ROUTER_POLICY_VERSION,
  }), 'utf8'));
}

export interface SecurityPolicyInput {
  effectiveProfile: {
    schemaVersion: string;
    profileId: string;
    profileVersion: number;
    toolRegistryVersion: string;
    /** Byte-identical copy of the source-owned EffectiveProfile.policyHash. */
    effectiveProfilePolicyHash: string;
  };
  capabilityRevision: number;
  profileDelegationRevision: number;
  registryEnforcementHash: string;
}

export function securityPolicyHash(input: SecurityPolicyInput): string {
  return sha256Hex(Buffer.from(canonicalJson({
    schemaVersion: 'torqclaw.approval-policy/v1',
    effectiveProfile: {
      schemaVersion: input.effectiveProfile.schemaVersion,
      profileId: input.effectiveProfile.profileId,
      profileVersion: input.effectiveProfile.profileVersion,
      toolRegistryVersion: input.effectiveProfile.toolRegistryVersion,
      effectiveProfilePolicyHash: input.effectiveProfile.effectiveProfilePolicyHash,
    },
    capabilityRevision: input.capabilityRevision,
    profileDelegationRevision: input.profileDelegationRevision,
    registryEnforcementHash: input.registryEnforcementHash,
  }), 'utf8'));
}

// ---------------------------------------------------------------------------
// CTXHASH_V1 (§3.4.1)
// ---------------------------------------------------------------------------

/**
 * The ten canonical inputs, in the PRD's pinned order. The ORDER IS THE
 * NUMBERED LIST -- not sorted, not re-ordered.
 *
 * Fields 1-4, 6 and 7 are immutable registration facts. Fields 5, 8, 9 and
 * 10 are re-resolved from CURRENT policy/delegation state at decision time,
 * which is exactly what makes registration->decision drift detectable.
 *
 * Free-text prompt is deliberately EXCLUDED.
 */
export interface ContextHashInput {
  /** 1. principal identity */
  originPrincipalId: string;
  /** 2. surface identity */
  originSurfaceId: string;
  /** 3. the ORIGINAL blocked request id, never the minted dispatch id */
  sourceRequestId: string;
  /** 4. server-derived task origin (surface kind), not client sourceChannel */
  originSurfaceKind: string;
  /** 5. resolved execution profile id */
  profileId: string;
  /** 6. exact canonical namespaced tool name */
  toolName: string;
  /** 7. the exact persisted canonicalJson(args) bytes */
  canonicalArgs: string;
  /** 8. lowercase privacy_context_hash */
  privacyContextHash: string;
  /** 9. lowercase routing_context_hash */
  routingContextHash: string;
  /** 10. lowercase security_policy_hash */
  securityPolicyHash: string;
}

/** The exact field order, exported so tests can assert it independently. */
export function contextHashFields(input: ContextHashInput): string[] {
  return [
    input.originPrincipalId,
    input.originSurfaceId,
    input.sourceRequestId,
    input.originSurfaceKind,
    input.profileId,
    input.toolName,
    input.canonicalArgs,
    input.privacyContextHash,
    input.routingContextHash,
    input.securityPolicyHash,
  ];
}

/**
 * `CTXHASH_V1` — lowercase hex SHA-256 over the framed ten-field stream.
 *
 * Missing source evidence REFUSES (throws) rather than hashing a
 * placeholder: a digest computed over a fabricated value would compare
 * equal to another fabrication and silently authorize drift.
 */
export function contextHash(input: ContextHashInput): string {
  return sha256Hex(frameFields(CTXHASH_VERSION, contextHashFields(input)));
}
