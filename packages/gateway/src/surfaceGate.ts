/**
 * C1-5 — resume surface-validity gate + connection auth context.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §2.6, §2.13, §8 C1-5.
 *
 * THE ORDERED GATE (§2.6). C1 INSERTS step 2; it removes no C0 rule.
 *
 *   1. resolvePrincipalBinding(frame)   — C0, unchanged (throws on PARTIAL)
 *   2. C1 surface validity              — THIS MODULE
 *   3. assertResumeAllowed(owner,caller)— C0, unchanged (SEC-1 lives here)
 *
 * Step 2 validates that the PRESENTING surface is itself valid: its
 * credential verifies, it owns an active surface, and that surface has a
 * live gateway security projection. It deliberately does NOT require the
 * presenting surface to be the OWNING surface — that would break SI-3.
 *
 * SI-3 (cross-surface resume) is the whole point of separating Surface
 * from Principal: Barry on his phone (a valid mobile surface) resuming his
 * desktop session (owned by a desktop surface) must still work. Step 3's
 * "principals match -> allow regardless of surface" is untouched, and the
 * ordering matters — step 2 runs BEFORE step 3, so an invalid surface is
 * refused with AUTH_FAILED before the principal comparison is ever reached.
 *
 * SI-4 (flag-off byte-identity): when `collabEnabled()` is false this
 * module is never consulted. The caller (server.ts) already guards the
 * whole surface path on `collabEnabled() && frame.auth?.kind === 'surface'`,
 * so with the flag off no C1 table is read or written, `caller` stays null,
 * and the path is byte-identical to today — including the SEC-1 hole for
 * legacy `owner == null` sessions.
 *
 * The flag is read PER-CALL via collabEnabled(), never captured at import
 * (the stale-`dist` trap, principalBridge.ts:64-73).
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { verifySurfaceToken, type VerifiedSurface } from '@torqclaw/collab';
import { collabEnabled, type PrincipalBinding } from './principalBridge.js';
import { liveSurfaceSecurity, type LiveSurfaceSecurity } from './surfaceSecurity.js';

/**
 * Server-derived, connection-scoped authorization context (§1.4, §2.13).
 *
 * Connection-scoped and never stored as one mutable session-keyed row: C0
 * allows same-principal cross-surface resume, so a single durable session
 * can have several concurrent connections presenting DIFFERENT valid
 * surfaces. Collapsing that into one session row would be last-writer-wins.
 *
 * Every field is derived here from a verified credential. No field is ever
 * read from a client frame.
 */
export interface ConnectionAuthContext {
  readonly connectionId: string;
  readonly principalId: string;
  readonly surfaceId: string;
  readonly surfaceKind: string;
  readonly surfaceRole: string;
  readonly credentialId: string;
  readonly credentialExpiresAt: string | null;
  readonly authEpoch: number;
  readonly capabilityRevision: number;
}

export interface SurfaceGateDeps {
  /** collab.db handle — configured identity truth. */
  collabDb: Database.Database;
  /** state.db handle — effective enforcement projection. */
  stateDb: Database.Database;
  principalPepper: Buffer;
  now?: () => Date;
}

/**
 * Step 2 of the §2.6 gate.
 *
 * Returns a ConnectionAuthContext on success, or null on ANY failure —
 * unknown/malformed/revoked/expired credential, revoked surface, or a
 * missing/stale gateway projection. Null is existence-oblivious at the
 * caller: server.ts turns it into the same AUTH_FAILED + close(4001) as a
 * bad root token, revealing nothing about which sub-check failed.
 *
 * Never throws. A gate that could throw would turn a malformed credential
 * into an unhandled rejection inside the WebSocket message handler — a
 * one-line DoS against every other live session (the same reasoning
 * server.ts:109-117 documents for PrincipalBindingError).
 */
export function validatePresentingSurface(
  deps: SurfaceGateDeps,
  presentedCredential: string,
): ConnectionAuthContext | null {
  // Read the flag per-call. With the flag off there is no surface identity
  // to validate and the caller must not have reached here at all.
  if (!collabEnabled()) return null;

  try {
    const now = deps.now ?? (() => new Date());

    // 2a — credential + surface validity (collab.db). Existence-oblivious:
    // constant HMAC cost across unknown/revoked/expired/malformed.
    const verified: VerifiedSurface | null = verifySurfaceToken(
      deps.collabDb, presentedCredential, deps.principalPepper, now,
    );
    if (verified === null) return null;

    // 2b — the matching LIVE gateway security projection (state.db).
    // A surface valid in configuration but absent/revoked/stale in the
    // enforcement projection denies (§2.7: "a missing/stale projection
    // denies even if the principal role would otherwise permit it").
    const live: LiveSurfaceSecurity | null = liveSurfaceSecurity(deps.stateDb, verified.surfaceId);
    if (live === null) return null;

    // The projection must describe the SAME surface identity the credential
    // proved. A divergent copy is stale enforcement state, and §3.14 is
    // explicit that observed divergence denies.
    if (live.principalId !== verified.principalId) return null;
    if (live.surfaceKind !== verified.surfaceKind) return null;
    if (live.surfaceRole !== verified.surfaceRole) return null;

    const expiresAt = deps.collabDb
      .prepare('SELECT expires_at AS expiresAt FROM surface_credentials WHERE credential_id = ?')
      .get(verified.credentialId) as { expiresAt: string | null } | undefined;

    return {
      connectionId: randomUUID(),
      principalId: verified.principalId,
      surfaceId: verified.surfaceId,
      surfaceKind: verified.surfaceKind,
      surfaceRole: verified.surfaceRole,
      credentialId: verified.credentialId,
      credentialExpiresAt: expiresAt?.expiresAt ?? null,
      authEpoch: live.authEpoch,
      capabilityRevision: live.capabilityRevision,
    };
  } catch {
    // No exception may escape the connect seam.
    return null;
  }
}

/**
 * The PrincipalBinding handed to C0's `sessions.resolve()` as `caller`.
 *
 * Derived from the verified context, never from the frame (H-1). Once C1
 * is on, `surfaceId` is a REAL surface id rather than C0.1's
 * credentialId stand-in (collabIdentity.ts documents that substitution as
 * temporary "until C1 lands"); step 3 keys authorization on principalId
 * only, so this change is invisible to the C0 rules it feeds.
 */
export function bindingFor(ctx: ConnectionAuthContext): PrincipalBinding {
  return { principalId: ctx.principalId, surfaceId: ctx.surfaceId };
}
