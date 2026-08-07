/**
 * Session bindings and BASE authorization evaluation for the Collaboration
 * Substrate (Section 8.1, and the BASE predicate from Section 4.2).
 *
 * Slice 1 scope: `collab_session_bindings` insert/close covering all eight
 * Section 8.1 close reasons, an in-memory session registry, and the BASE
 * evaluation (session open, credential active, principal active, owner
 * active for agents, session credential/principal IDs match, auth epoch
 * matches). The full authorization coordinator (read/write locks,
 * per-write revalidation, subscription close notification) lands with the
 * Live slice; this module provides the identity-layer primitives that
 * slice will build on.
 *
 * (M3) Startup order is pinned and tested: pepper checks -> gateway mode
 * determination -> orphan-binding closure ONLY when mode is healthy. A
 * wrong-machine pepper (mismatched checks) freezes the db untouched in
 * `locked_recovery`.
 */

import type { BootstrapDb, Clock } from './bootstrap.js';
import { verifyPepperCheck, principalPepperCheck, recoveryPepperCheck } from './bootstrap.js';

// ---------------------------------------------------------------------------
// Section 8.1 exhaustive close reasons
// ---------------------------------------------------------------------------

export const SESSION_CLOSE_REASONS = [
  'credential_revoked',
  'principal_suspended',
  'principal_restored',
  'principal_revoked',
  'operator_revoked',
  'slow_consumer',
  'socket_closed',
  'recovery',
] as const;

export type SessionCloseReason = (typeof SESSION_CLOSE_REASONS)[number];

// ---------------------------------------------------------------------------
// Session binding row operations
// ---------------------------------------------------------------------------

export interface SessionBindingRow {
  session_id: string;
  protocol_version: number;
  connection_role: 'operator' | 'channel';
  principal_id: string;
  credential_id: string;
  auth_epoch_snapshot: number;
  created_at: string;
  closed_at: string | null;
  close_reason: SessionCloseReason | null;
}

export interface CreateSessionParams {
  sessionId: string;
  connectionRole: 'operator' | 'channel';
  principalId: string;
  credentialId: string;
  authEpochSnapshot: number;
}

/**
 * Insert a new open session binding row. Callers (the future connect-path
 * handler) MUST create/close this atomically with the corresponding
 * gateway session, per Section 9's note that `session_id` has no foreign
 * key into the Phase 1 session table by design.
 */
export function createSessionBinding(db: BootstrapDb, clock: Clock, params: CreateSessionParams): void {
  const now = clock.next();
  db.prepare(
    'INSERT INTO collab_session_bindings(session_id, protocol_version, connection_role, principal_id, credential_id, auth_epoch_snapshot, created_at, closed_at, close_reason) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(params.sessionId, 2, params.connectionRole, params.principalId, params.credentialId, params.authEpochSnapshot, now, null, null);
}

/**
 * Close a session binding with the given close reason. No-op (returns
 * false) if the session is already closed or does not exist.
 */
export function closeSessionBinding(
  db: BootstrapDb,
  clock: Clock,
  sessionId: string,
  closeReason: SessionCloseReason
): boolean {
  const now = clock.next();
  const result = db
    .prepare('UPDATE collab_session_bindings SET closed_at = ?, close_reason = ? WHERE session_id = ? AND closed_at IS NULL')
    .run(now, closeReason, sessionId) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

export function getSessionBinding(db: BootstrapDb, sessionId: string): SessionBindingRow | undefined {
  return db.prepare('SELECT * FROM collab_session_bindings WHERE session_id = ?').get(sessionId) as
    | SessionBindingRow
    | undefined;
}

// ---------------------------------------------------------------------------
// In-memory session registry
// ---------------------------------------------------------------------------

/**
 * In-memory record of a live session, mirroring (a subset of) the durable
 * `collab_session_bindings` row for fast BASE checks without a DB round
 * trip on every command. The durable row remains the source of truth for
 * close reasons and audit; this registry is a cache the gateway process
 * rebuilds on startup (Section 9: startup closes orphan bindings with no
 * live gateway session).
 */
export interface RegisteredSession {
  sessionId: string;
  connectionRole: 'operator' | 'channel';
  principalId: string;
  credentialId: string;
  authEpochSnapshot: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, RegisteredSession>();

  register(session: RegisteredSession): void {
    this.sessions.set(session.sessionId, session);
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get(sessionId: string): RegisteredSession | undefined {
    return this.sessions.get(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }
}

// ---------------------------------------------------------------------------
// BASE predicate evaluation (Section 4.2)
// ---------------------------------------------------------------------------

interface PrincipalStatusRow {
  id: string;
  kind: 'operator' | 'agent';
  owner_principal_id: string | null;
  status: 'active' | 'suspended' | 'revoked';
  auth_epoch: number;
}

interface CredentialStatusRow {
  id: string;
  principal_id: string;
  state: 'active' | 'revoked';
}

export type BaseEvaluationResult =
  | { ok: true }
  | { ok: false; reason: 'SESSION_INVALID' | 'ROLE_PRINCIPAL_MISMATCH' };

/**
 * Evaluate the BASE predicate for a registered session against current DB
 * state:
 *  - session open (closed_at IS NULL in the durable row);
 *  - credential active;
 *  - principal active;
 *  - owner active for an agent (the agent's owner_principal_id principal
 *    must also be active);
 *  - session credential/principal IDs match the durable row;
 *  - auth epoch matches the current principal's auth_epoch.
 *
 * Returns SESSION_INVALID for any structural mismatch (session closed/
 * missing, epoch stale, credential/principal not found or inactive, owner
 * inactive) and ROLE_PRINCIPAL_MISMATCH is reserved for a connect-time
 * role/kind mismatch (evaluated by the connect handler, not here — BASE
 * itself does not re-check role, since role is bound at connect and
 * cannot change within a session).
 */
export function evaluateBase(db: BootstrapDb, sessionId: string): BaseEvaluationResult {
  const binding = getSessionBinding(db, sessionId);
  if (!binding || binding.closed_at !== null) {
    return { ok: false, reason: 'SESSION_INVALID' };
  }

  const credential = db.prepare('SELECT id, principal_id, state FROM principal_credentials WHERE id = ?').get(
    binding.credential_id
  ) as CredentialStatusRow | undefined;
  if (!credential || credential.state !== 'active' || credential.principal_id !== binding.principal_id) {
    return { ok: false, reason: 'SESSION_INVALID' };
  }

  const principal = db
    .prepare('SELECT id, kind, owner_principal_id, status, auth_epoch FROM principals WHERE id = ?')
    .get(binding.principal_id) as PrincipalStatusRow | undefined;
  if (!principal || principal.status !== 'active') {
    return { ok: false, reason: 'SESSION_INVALID' };
  }

  if (principal.auth_epoch !== binding.auth_epoch_snapshot) {
    return { ok: false, reason: 'SESSION_INVALID' };
  }

  if (principal.kind === 'agent') {
    if (!principal.owner_principal_id) {
      return { ok: false, reason: 'SESSION_INVALID' };
    }
    const owner = db.prepare('SELECT status FROM principals WHERE id = ?').get(principal.owner_principal_id) as
      | { status: string }
      | undefined;
    if (!owner || owner.status !== 'active') {
      return { ok: false, reason: 'SESSION_INVALID' };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// (M3) Startup order: pepper checks -> gateway mode -> orphan closure
// ---------------------------------------------------------------------------

export type GatewayMode = 'uninitialized' | 'healthy' | 'locked_recovery' | 'migration';

export interface StartupResult {
  mode: GatewayMode;
  orphanBindingsClosed: number;
}

interface InstallationRow {
  installation_id: string;
  principal_pepper_check: Buffer;
  recovery_pepper_check: Buffer;
}

/**
 * Determine gateway mode and perform orphan-binding closure, in the pinned
 * order (M3):
 *   1. recompute and compare both pepper checks (constant-time);
 *   2. determine gateway mode from that result (and from whether an
 *      operator row / collab_installation row exists at all);
 *   3. close orphan bindings (a binding with null closed_at whose
 *      sessionId is not in `liveGatewaySessionIds`) ONLY when mode is
 *      healthy.
 *
 * A wrong-machine pepper (mismatched checks) freezes the db untouched:
 * mode becomes `locked_recovery` and orphan closure is skipped entirely —
 * no row in collab_session_bindings is touched.
 */
export function performStartup(
  db: BootstrapDb,
  clock: Clock,
  principalPepper: Buffer | undefined,
  recoveryPepper: Buffer | undefined,
  liveGatewaySessionIds: ReadonlySet<string>
): StartupResult {
  const installation = db.prepare('SELECT * FROM collab_installation').get() as InstallationRow | undefined;

  if (!installation) {
    // No bootstrap record: uninitialized, nothing to check or close.
    return { mode: 'uninitialized', orphanBindingsClosed: 0 };
  }

  // Step 1: pepper checks, FIRST, before any mode decision or DB mutation.
  let pepperChecksOk = false;
  if (principalPepper && recoveryPepper) {
    const expectedPrincipalCheck = principalPepperCheck(principalPepper, installation.installation_id);
    const expectedRecoveryCheck = recoveryPepperCheck(recoveryPepper, installation.installation_id);
    const principalOk = verifyPepperCheck(
      Buffer.from(installation.principal_pepper_check),
      expectedPrincipalCheck
    );
    const recoveryOk = verifyPepperCheck(Buffer.from(installation.recovery_pepper_check), expectedRecoveryCheck);
    pepperChecksOk = principalOk && recoveryOk;
  }

  // Step 2: mode determination.
  if (!pepperChecksOk) {
    // Missing or mismatched checks (including a wrong-machine restore):
    // locked_recovery, db left untouched — orphan closure is skipped.
    return { mode: 'locked_recovery', orphanBindingsClosed: 0 };
  }

  const operator = db.prepare("SELECT status FROM principals WHERE kind = 'operator'").get() as
    | { status: string }
    | undefined;
  if (!operator || operator.status !== 'active') {
    return { mode: 'locked_recovery', orphanBindingsClosed: 0 };
  }

  const mode: GatewayMode = 'healthy';

  // Step 3: orphan-binding closure ONLY when mode is healthy.
  const openBindings = db
    .prepare('SELECT session_id FROM collab_session_bindings WHERE closed_at IS NULL')
    .all() as Array<{ session_id: string }>;
  let closedCount = 0;
  const now = clock.next();
  for (const b of openBindings) {
    if (!liveGatewaySessionIds.has(b.session_id)) {
      db.prepare(
        'UPDATE collab_session_bindings SET closed_at = ?, close_reason = ? WHERE session_id = ? AND closed_at IS NULL'
      ).run(now, 'socket_closed', b.session_id);
      closedCount++;
    }
  }

  return { mode, orphanBindingsClosed: closedCount };
}
