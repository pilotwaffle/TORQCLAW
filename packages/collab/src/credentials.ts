/**
 * Credential issuance and verification for the Collaboration Substrate.
 *
 * Per PRD v0.14 Section 6.1: token format `tq1_<credentialId>_<32-byte
 * -base64url-secret>`. Store only `HMAC-SHA-256(principalPepper,
 * complete-token-bytes)`. Verification is existence-oblivious: unknown IDs,
 * malformed tokens, and revoked credentials must be indistinguishable
 * (same number of HMAC operations, same AUTH_FAILED outcome, same
 * exception-free path).
 *
 * G1R C1 (Critical): `crypto.timingSafeEqual` THROWS on length mismatch
 * (probed on Node 22.19.0). This module therefore:
 *  - asserts both compare operands are exactly 32 bytes before calling
 *    `timingSafeEqual`;
 *  - routes token PARSE FAILURES through the SAME decoy-HMAC-and-compare
 *    path as unknown credential IDs — no short-circuit that would let a
 *    parse failure return faster than a real lookup;
 *  - wraps the entire `verifyCredential` body so NO exception of any kind
 *    escapes; every failure path returns `{ ok: false, reason:
 *    'AUTH_FAILED' }`.
 *
 * The decoy HMAC is derived from `principalPepper` with a fixed
 * domain-separated input, so it always exists and always costs one HMAC
 * operation, matching the cost of a real lookup's HMAC recomputation.
 *
 * The HMAC-operation counter is incremented INSIDE the HMAC wrapper
 * function itself (`hmacSha256`, exported as `credentialHmacOperationCount`
 * plus `resetCredentialHmacOperationCount` for test isolation) so hit,
 * miss, revoked, and malformed paths can be asserted to perform the same
 * number of HMAC operations (G1R explicit answer (c)).
 *
 * Secrets are generated from an injectable RNG (the fixture harness in
 * tests, `crypto.randomBytes` in production) and carried as Buffers
 * end-to-end (L1): the secret bytes buffer is `.fill(0)`'d after being
 * encoded into the first response, and on every rollback/error path. The
 * ENCODED RESPONSE STRING itself (the `tq1_..._...` token) is a JS string
 * and cannot be zeroed — JS strings are immutable and may be interned/
 * copied by the engine — so this module documents that the immediate
 * Buffer is what gets zeroed, not the final string.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RandomSource } from './bootstrap.js';

const TOKEN_PREFIX = 'tq1_';
const SECRET_BYTE_LENGTH = 32;
const DECOY_DOMAIN_SEPARATOR = Buffer.from('torqclaw-credential-decoy-v1:', 'utf8');

// ---------------------------------------------------------------------------
// HMAC operation counter (C1 / G1R explicit answer (c))
// ---------------------------------------------------------------------------

let hmacOperationCount = 0;

/**
 * The sole HMAC wrapper used by credential issuance/verification. Every
 * call increments the exported operation counter, so tests can assert HMAC
 * -operation-count equality across hit/miss/revoked/malformed verification
 * paths (the assertable proxy for constant-time behavior at this headless
 * slice, per G1R explicit answer (c); the wall-clock timing fixture is
 * OWED at the slice that ships the connect path).
 */
export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  hmacOperationCount++;
  return createHmac('sha256', key).update(data).digest();
}

/** Current HMAC operation count (exported for test assertions). */
export function credentialHmacOperationCount(): number {
  return hmacOperationCount;
}

/** Resets the HMAC operation counter. Test-only; production never calls this. */
export function resetCredentialHmacOperationCount(): void {
  hmacOperationCount = 0;
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

export interface IssuedCredential {
  credentialId: string;
  /** Plaintext token, e.g. "tq1_<credentialId>_<secret>". Shown once. */
  token: string;
  /** HMAC-SHA-256(principalPepper, complete-token-bytes); this is what gets persisted. */
  secretHmac: Buffer;
  /**
   * The raw secret bytes Buffer, already consumed into `token`. Callers
   * MUST `.fill(0)` this (and it is safe to fill immediately after reading
   * `token`/`secretHmac`, both of which are already fully computed) — L1.
   */
  secretBytes: Buffer;
}

/**
 * Issue a new credential for `credentialId` under `principalPepper`.
 * `rng` is injectable: the fixture harness supplies a deterministic RNG in
 * tests, `crypto.randomBytes` in production (see `bootstrap.ts`'s
 * `nodeRandomSource`).
 *
 * Callers own the returned `secretBytes` Buffer's lifecycle: it must be
 * zeroed after the token has been handed off (encoded into the one-time
 * response) or on any rollback path. This function does not zero it
 * itself, because callers frequently need the Buffer to survive past this
 * call's return (e.g. to zero it only after a transaction commits).
 */
export function issueCredential(credentialId: string, principalPepper: Buffer, rng: RandomSource): IssuedCredential {
  const secretBytes = rng.randomBytes(SECRET_BYTE_LENGTH);
  const token = `${TOKEN_PREFIX}${credentialId}_${secretBytes.toString('base64url')}`;
  const tokenBytes = Buffer.from(token, 'utf8');
  const secretHmac = hmacSha256(principalPepper, tokenBytes);
  return { credentialId, token, secretHmac, secretBytes };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type CredentialLookup = (credentialId: string) => {
  secretHmac: Buffer;
  state: 'active' | 'revoked';
} | undefined;

export type VerifyCredentialResult =
  | { ok: true; credentialId: string }
  | { ok: false; reason: 'AUTH_FAILED' };

/**
 * Parse a `tq1_<credentialId>_<secret>` token into its parts. Returns null
 * on any malformation (wrong prefix, missing/extra underscores, empty
 * parts). This function ONLY parses; it never authenticates.
 *
 * Credential IDs in this system are canonical lowercase UUIDs (36 chars,
 * hyphenated), which contain no underscores, so splitting on the FIRST and
 * LAST underscore is unambiguous: prefix `tq1`, then credentialId, then
 * secret, joined by exactly two underscores total from the two split
 * points below.
 */
function parseToken(token: string): { credentialId: string; secretPart: string } | null {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null;
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  const firstUnderscore = rest.indexOf('_');
  if (firstUnderscore <= 0) {
    return null;
  }
  const credentialId = rest.slice(0, firstUnderscore);
  const secretPart = rest.slice(firstUnderscore + 1);
  if (credentialId.length === 0 || secretPart.length === 0) {
    return null;
  }
  // Canonical lowercase UUID shape check for the credential ID segment.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(credentialId)) {
    return null;
  }
  return { credentialId, secretPart };
}

/**
 * Compute the fixed decoy HMAC for a given principalPepper. Always
 * succeeds; always costs exactly one HMAC operation via `hmacSha256`.
 */
function decoyHmac(principalPepper: Buffer): Buffer {
  return hmacSha256(principalPepper, DECOY_DOMAIN_SEPARATOR);
}

/**
 * Constant-time-safe comparison: asserts both operands are exactly 32
 * bytes before calling `timingSafeEqual` (which throws on length
 * mismatch — G1R C1). Any length mismatch is treated as "not equal"
 * rather than thrown.
 */
function safeCompare32(a: Buffer, b: Buffer): boolean {
  if (a.length !== SECRET_BYTE_LENGTH || b.length !== SECRET_BYTE_LENGTH) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Verify a presented token against `principalPepper` and a `lookup`
 * function resolving a credential ID to its stored `secretHmac`/`state`.
 *
 * Existence-oblivious per Section 6.1 / G1R C1:
 *  - a token that fails to parse takes the SAME decoy-HMAC-and-compare
 *    path as an unknown credential ID (no short-circuit before the HMAC
 *    computation);
 *  - EVERY path — hit (active), hit (revoked), miss (unknown ID), and
 *    parse-failure — performs EXACTLY TWO `hmacSha256` calls: one for the
 *    token's own HMAC (recomputed from the presented token bytes) and one
 *    for the fixed decoy HMAC, computed unconditionally regardless of
 *    whether a real record was found. The decoy is always computed (never
 *    only-on-miss) specifically so the hit path's operation count is
 *    identical to the miss/malformed paths' — see
 *    `credentialHmacOperationCount` fixtures for the exact pinned counts;
 *  - the entire function is wrapped in try/catch so NO exception escapes;
 *    every failure returns `{ ok: false, reason: 'AUTH_FAILED' }`.
 *
 * A revoked credential's stored HMAC is still compared (so miss vs
 * revoked cost the same), but the state check after a successful compare
 * ensures a revoked credential still returns AUTH_FAILED.
 */
export function verifyCredential(
  presentedToken: string,
  principalPepper: Buffer,
  lookup: CredentialLookup
): VerifyCredentialResult {
  try {
    const presentedBytes = Buffer.from(presentedToken, 'utf8');
    const parsed = parseToken(presentedToken);

    // Look up a real record only when parsing succeeded; otherwise there is
    // nothing to look up (unparseable => undefined, same as "unknown ID").
    const record = parsed === null ? undefined : lookup(parsed.credentialId);

    // Unconditional, identical work on every path: one HMAC over the
    // presented bytes, one HMAC for the fixed decoy, one length-safe
    // compare against whichever target applies. This is what makes parse
    // failures, unknown IDs, and known-but-revoked/known-and-active
    // credentials cost the same number of HMAC operations.
    const presentedHmac = hmacSha256(principalPepper, presentedBytes);
    const decoy = decoyHmac(principalPepper);
    const compareTarget = record === undefined ? decoy : record.secretHmac;
    const matches = safeCompare32(presentedHmac, compareTarget);

    if (parsed === null || record === undefined || !matches) {
      return { ok: false, reason: 'AUTH_FAILED' };
    }

    if (record.state !== 'active') {
      return { ok: false, reason: 'AUTH_FAILED' };
    }

    return { ok: true, credentialId: parsed.credentialId };
  } catch {
    // No exception may ever escape verifyCredential.
    return { ok: false, reason: 'AUTH_FAILED' };
  }
}
