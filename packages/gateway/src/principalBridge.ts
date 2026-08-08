/**
 * C0 — Principal Identity Bridge (TORQCLAW_COLLAB_ENABLED, default off).
 *
 * WHAT THIS SOLVES
 * ----------------
 * `sessions.resolve()` returns any session whose id is known:
 *
 *     const row = db.prepare('SELECT id, role FROM sessions WHERE id = ?')...
 *     if (row) return { sessionId, resumed: true, role: row.role };
 *
 * There is no check that the caller resuming the session is the party that
 * created it. A session id is therefore a bearer token for someone else's
 * session, across channels (SEC-1). The gateway `sessions` table carries only
 * `role` and `client_name` -- there is no identity to check against.
 *
 * `packages/collab` already has the missing half: principals, credentials,
 * auth epochs, revocation, and a store that is unusually careful about
 * authorization mechanics. This module is the bridge between them.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not replace gateway sessions with `collab_session_bindings`. The
 * gateway's sessions already provide durable socket-independent identity and
 * monotonic event replay; swapping that out now would add migration risk with
 * no user-visible gain. The two models may converge later. Here, collab
 * supplies IDENTITY and the gateway remains the EXECUTION AUTHORITY.
 *
 * WHY THE FLAG DEFAULTS OFF EVEN THOUGH THIS CLOSES A HOLE
 * --------------------------------------------------------
 * Enabling a new subsystem and changing security behaviour are separate
 * decisions. Bundling them would make the rollout un-revertable: turning the
 * flag off to back out an integration problem would silently also reopen the
 * hole, and nobody would notice which change caused what. With the flag off,
 * behaviour is byte-identical to today -- including the existing hole. The
 * fix ships the moment an operator opts in.
 */

/** A caller's identity: which principal, acting through which surface. */
export interface PrincipalBinding {
  principalId: string;
  /**
   * Surfaces are how one principal appears on many clients (desktop, mobile,
   * telegram, slack, http, automation) without each device becoming a
   * separate "user". Credentials belong to surfaces; authority belongs to the
   * principal behind them.
   */
  surfaceId: string;
}

export class PrincipalBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrincipalBindingError';
  }
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Identifiers must be single safe tokens -- they end up in SQL, logs, and
 *  audit records, and a permissive shape here becomes an injection surface
 *  three layers away. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Whether the collab substrate is active.
 *
 * Read per-call rather than captured at import: a module-level constant would
 * freeze the value at import time and make the flag untestable without
 * reloading the module -- the same trap that hid the stale-`dist` auth bug.
 */
export function collabEnabled(): boolean {
  return TRUTHY.has((process.env.TORQCLAW_COLLAB_ENABLED ?? '').trim().toLowerCase());
}

function validId(value: unknown, field: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!SAFE_ID.test(s)) {
    throw new PrincipalBindingError(
      `invalid ${field}: must be 1-128 chars of letters, digits, dot, underscore, colon or hyphen`,
    );
  }
  return s;
}

/**
 * Extract the caller's identity from a ConnectFrame.
 *
 * Returns null when the substrate is off, or when the frame carries no
 * identity at all (the pre-bridge flow, which must keep working). Throws on a
 * PARTIAL or malformed claim -- a half-formed identity is a bug or an attack,
 * never something to silently normalise.
 */
export function resolvePrincipalBinding(
  frame: { principalId?: unknown; surfaceId?: unknown },
): PrincipalBinding | null {
  if (!collabEnabled()) return null;

  const hasPrincipal = frame?.principalId != null && frame.principalId !== '';
  const hasSurface = frame?.surfaceId != null && frame.surfaceId !== '';
  if (!hasPrincipal && !hasSurface) return null;

  if (hasPrincipal && !hasSurface) {
    throw new PrincipalBindingError(
      'principalId supplied without surfaceId; credentials belong to a surface, ' +
      'so a principal claim with no surface is an incomplete identity',
    );
  }
  if (hasSurface && !hasPrincipal) {
    throw new PrincipalBindingError('surfaceId supplied without principalId');
  }

  return {
    principalId: validId(frame.principalId, 'principalId'),
    surfaceId: validId(frame.surfaceId, 'surfaceId'),
  };
}

/**
 * Authorize a session resume.
 *
 * `owner` is the binding recorded when the session was created; `caller` is
 * the binding presented now. Either may be null.
 *
 * Rules, in order:
 *   - owner null            -> allow. Legacy session from before the bridge;
 *                              refusing would lock users out of live sessions
 *                              on flag-flip. A migration concern, not a
 *                              security decision.
 *   - caller null, owner set-> refuse. Otherwise presenting no credentials at
 *                              all is the cheapest way past the check.
 *   - principals differ     -> refuse. This is SEC-1.
 *   - principals match      -> allow, regardless of surface. Barry on his
 *                              phone resuming his desktop session is the
 *                              point of separating Surface from Principal.
 */
export function assertResumeAllowed(
  owner: PrincipalBinding | null,
  caller: PrincipalBinding | null,
): void {
  if (owner == null) return;

  if (caller == null) {
    throw new PrincipalBindingError(
      'this session is bound to a principal; resuming it requires presenting that identity',
    );
  }

  if (owner.principalId !== caller.principalId) {
    throw new PrincipalBindingError(
      'session belongs to a different principal; a session id is not a bearer token',
    );
  }
}
