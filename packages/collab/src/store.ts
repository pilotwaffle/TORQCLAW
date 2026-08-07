/**
 * CollaborationStore identity layer for the Collaboration Substrate.
 *
 * Implements the Slice 1 identity commands: CREATE_AGENT,
 * CREATE_PRINCIPAL_CREDENTIAL, SUSPEND_AGENT, RESTORE_AGENT, REVOKE_AGENT,
 * ROTATE_PRINCIPAL_CREDENTIAL, REVOKE_PRINCIPAL_CREDENTIAL.
 *
 * Every command runs the Section 8.3 atomic protocol:
 *   1. in-process mutex -> BEGIN IMMEDIATE
 *   2. in-transaction predicate revalidation
 *   3. (principal_id,command,idempotency_key) lookup
 *   4. same-hash replay -> return stored redacted result (no mutation)
 *   5. different-hash replay -> IDEMPOTENCY_CONFLICT (rollback)
 *   6. otherwise: mutation + redacted result row, same transaction
 *   7. commit BEFORE one-time secret handoff.
 *
 * (F8) Mutex scope, precisely: `Mutex.withLock`'s `fn` callback IS
 * `runKeyedCommand`'s body, so the mutex is actually held from step 1
 * through the moment `runKeyedCommand` returns its plaintext result to the
 * caller of `createAgent`/etc — i.e. the plaintext `result` value is
 * constructed and returned to the *caller* WHILE the mutex is still held,
 * not released exactly "at commit". This is deliberate and safe: every
 * step from commit through that return is synchronous in-process work with
 * NO socket I/O and no `await` (the DB commit itself, `JSON.parse` of a
 * replay row, and zeroing `pendingSecretBytes` in the `finally`) — there is
 * no fan-out, no network write, and no yield point where another task
 * could observe or extend the critical section. What Section 8.3 step 7
 * actually requires — commit strictly BEFORE any one-time secret HANDOFF
 * (i.e. before the plaintext ever reaches a socket/transport boundary) —
 * still holds unconditionally: handoff to the network happens at the
 * protocol/frame layer, outside this store entirely, and always occurs
 * after `withLock`'s promise resolves, which is always after commit.
 *
 * (H1/F2) request_hash = SHA-256 over canonicalJson of the
 * POST-NORMALIZATION POST-TRIM body — the exact bytes persisted, not the
 * raw request body. The STORE itself performs this normalization (NFC then
 * trim, via text.ts's normalizeName) for every free-text field BEFORE
 * computing request_hash and BEFORE persisting — CREATE_AGENT's
 * displayName is normalized at the top of createAgent(), so the hash
 * always covers exactly the bytes that get written to `principals`, no
 * matter what whitespace/NFC-decomposed variant of the same logical name a
 * caller sends under the same idempotency key.
 * (H3) same-state fresh-key rule applies to suspend-on-suspended,
 * restore-on-active, AND revoke-on-revoked: each commits a new success
 * result recording current state with no epoch increment, no session
 * closure, no audit row.
 * (L2) LAST_OPERATOR_CREDENTIAL guard counts ACTIVE operator credentials
 * INSIDE the transaction after BEGIN IMMEDIATE.
 * Section 9 validations 1, 7, 9 (e-3): every write verifies the invoking
 * principal is the operator at storage level; violations roll back with
 * ZERO row changes.
 * (e-2) audit rows for ALL credential commands (credential_created,
 * credential_revoked) and agent_suspended/agent_restored/agent_revoked —
 * secret-free.
 * (M1) a secret_hmac UNIQUE violation is caught and surfaced as a typed
 * internal invariant error, never an uncaught SQLite exception.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { issueCredential, type CredentialLookup } from './credentials.js';
import { normalizeName } from './text.js';
import type { RandomSource, Clock, UuidSource, BootstrapDb } from './bootstrap.js';

// ---------------------------------------------------------------------------
// Errors / result codes (Section 7.4 / 7.6 subset relevant to Slice 1)
// ---------------------------------------------------------------------------

export type CollabErrorCode =
  | 'PRINCIPAL_NOT_FOUND'
  | 'CREDENTIAL_NOT_FOUND'
  | 'INVALID_PRINCIPAL_STATE'
  | 'INVALID_PRINCIPAL_TRANSITION'
  | 'INVALID_REQUEST'
  | 'LAST_OPERATOR_CREDENTIAL'
  | 'IDEMPOTENCY_CONFLICT'
  | 'COLLAB_NOT_PERMITTED';

export class CollabError extends Error {
  readonly code: CollabErrorCode;
  constructor(code: CollabErrorCode, message: string) {
    super(message);
    this.name = 'CollabError';
    this.code = code;
  }
}

/**
 * (M1) Thrown when a secret_hmac UNIQUE constraint violation is detected —
 * an injected-RNG collision on the credential secret. This is an internal
 * invariant failure (astronomically unlikely with a real CSPRNG; only
 * reachable in tests with a deliberately reused harness RNG state), not a
 * client-facing protocol error.
 */
export class CredentialHmacCollisionError extends Error {
  readonly code = 'CREDENTIAL_HMAC_COLLISION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CredentialHmacCollisionError';
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PrincipalRow {
  id: string;
  kind: 'operator' | 'agent';
  display_name: string;
  owner_principal_id: string | null;
  status: 'active' | 'suspended' | 'revoked';
  auth_epoch: number;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CredentialRow {
  id: string;
  principal_id: string;
  secret_hmac: Buffer;
  state: 'active' | 'revoked';
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

// ---------------------------------------------------------------------------
// Command result shapes (Section 7.4)
// ---------------------------------------------------------------------------

export type CredentialProducingResult =
  | { principalId: string; credentialId: string; credential: string; credentialAvailable: true }
  | { principalId: string; credentialId: string; credentialAvailable: false };

export type RotateCredentialResult =
  | (CredentialProducingResult & { replacedCredentialId: string });

export interface AgentLifecycleResult {
  principalId: string;
  status: 'active' | 'suspended' | 'revoked';
  authEpoch: number;
}

export interface RevokeAgentResult extends AgentLifecycleResult {
  revokedCredentialCount: number;
}

export interface RevokeCredentialResult {
  credentialId: string;
  revokedAt: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface CollaborationStoreEnv {
  db: BootstrapDb;
  clock: Clock;
  uuids: UuidSource;
  rng: RandomSource;
  principalPepper: Buffer;
}

/** Minimal caller identity, established by the (not-yet-built) session layer. */
export interface CallerContext {
  principalId: string;
  kind: 'operator' | 'agent';
}

/**
 * Simple in-process mutex (Section 8.3's "sequencer mutex" for this
 * headless slice — full lock-class partitioning across read/write
 * authorization locks lands with the Live slice; Slice 1 needs only the
 * exclusivity guarantee for BEGIN IMMEDIATE ordering). Since Node.js is
 * single-threaded, a promise chain is a correct, simple mutex.
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async withLock<T>(fn: () => T): Promise<T> {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const previous = this.tail;
    this.tail = this.tail.then(() => wait);
    await previous;
    try {
      return fn();
    } finally {
      release();
    }
  }
}

export class CollaborationStore {
  private readonly env: CollaborationStoreEnv;
  private readonly mutex = new Mutex();

  /**
   * (F1) Holds the currently-live, not-yet-zeroed credential secret Buffer
   * for the command in flight, if any. Set the instant `issueCredentialRow`
   * allocates the secret — BEFORE the INSERT, BEFORE the mutation-result
   * row, BEFORE commit — so that a `finally` block wrapped around the
   * entire transaction closure in `runKeyedCommand` can zero it
   * unconditionally, regardless of WHERE between allocation and commit a
   * throw occurs (a later `clock.next()` call, the mutation-result INSERT,
   * even a hypothetical failure inside `fn` after allocation). Cleared
   * (set back to `undefined`) immediately after zeroing so a subsequent
   * command in the same store instance starts from a clean slate.
   */
  private pendingSecretBytes: Buffer | undefined;

  constructor(env: CollaborationStoreEnv) {
    this.env = env;
  }

  // -------------------------------------------------------------------
  // Public commands
  // -------------------------------------------------------------------

  async createAgent(
    caller: CallerContext,
    body: { displayName: string },
    idempotencyKey: string
  ): Promise<CredentialProducingResult> {
    // (F2) The store itself normalizes displayName — NFC then trim, via the
    // same normalizeName used by the frame/command layer — BEFORE computing
    // request_hash and BEFORE persisting, so the hash and the persisted
    // bytes are always the exact same normalized form regardless of what
    // whitespace/NFC-decomposed variant the caller passed in. This makes
    // normalization idempotent-safe at the store boundary rather than
    // relying on every caller to have already normalized.
    const normalized = normalizeName(body.displayName);
    if ('error' in normalized) {
      throw new CollabError('INVALID_REQUEST', normalized.message);
    }
    const normalizedBody = { displayName: normalized.name };

    return this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'CREATE_AGENT',
        idempotencyKey,
        normalizedBody,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
        const operator = this.getOperatorOrThrow(tx);

        const agentId = this.env.uuids.next();
        const now = this.env.clock.next();
        tx
          .prepare(
            'INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
          )
          .run(agentId, 'agent', normalizedBody.displayName, operator.id, 'active', 1, null, now, now);

        const cred = this.issueCredentialRow(tx, agentId, now);
        this.insertAudit(tx, 'credential_created', caller.principalId, agentId, {
          principalId: agentId,
          credentialId: cred.credentialId,
        });

        const result: CredentialProducingResult = {
          principalId: agentId,
          credentialId: cred.credentialId,
          credential: cred.token,
          credentialAvailable: true,
        };
        const redacted: CredentialProducingResult = {
          principalId: agentId,
          credentialId: cred.credentialId,
          credentialAvailable: false,
        };
        return { result, redacted, secretBytes: cred.secretBytes };
      })
    );
  }

  async createPrincipalCredential(
    caller: CallerContext,
    body: { principalId: string },
    idempotencyKey: string
  ): Promise<CredentialProducingResult> {
    return this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'CREATE_PRINCIPAL_CREDENTIAL',
        idempotencyKey,
        body,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
        const target = this.getPrincipalOrThrow(tx, body.principalId);
        if (target.status !== 'active') {
          throw new CollabError('INVALID_PRINCIPAL_STATE', `Principal ${target.id} is not active`);
        }

        const now = this.env.clock.next();
        const cred = this.issueCredentialRow(tx, target.id, now);
        this.insertAudit(tx, 'credential_created', caller.principalId, target.id, {
          principalId: target.id,
          credentialId: cred.credentialId,
        });

        const result: CredentialProducingResult = {
          principalId: target.id,
          credentialId: cred.credentialId,
          credential: cred.token,
          credentialAvailable: true,
        };
        const redacted: CredentialProducingResult = {
          principalId: target.id,
          credentialId: cred.credentialId,
          credentialAvailable: false,
        };
        return { result, redacted, secretBytes: cred.secretBytes };
      })
    );
  }

  async suspendAgent(
    caller: CallerContext,
    body: { principalId: string },
    idempotencyKey: string
  ): Promise<AgentLifecycleResult> {
    return this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'SUSPEND_AGENT',
        idempotencyKey,
        body,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
        const target = this.getAgentTargetOrThrow(tx, body.principalId);

        if (target.status === 'suspended') {
          // (H3) same-state fresh-key rule: no epoch increment, no session
          // closure, no audit row — just a fresh success result recording
          // current state.
          return {
            result: { principalId: target.id, status: 'suspended', authEpoch: target.auth_epoch },
            redacted: { principalId: target.id, status: 'suspended', authEpoch: target.auth_epoch },
          };
        }
        if (target.status !== 'active') {
          throw new CollabError('INVALID_PRINCIPAL_TRANSITION', `Cannot suspend principal in state ${target.status}`);
        }

        const now = this.env.clock.next();
        const newEpoch = target.auth_epoch + 1;
        tx
          .prepare('UPDATE principals SET status = ?, auth_epoch = ?, updated_at = ? WHERE id = ?')
          .run('suspended', newEpoch, now, target.id);

        // Section 5.2: suspend closes all sessions/subscriptions with
        // principal_suspended. Slice 1 has no live session registry yet
        // (that lands with sessions.ts / the Live slice's socket layer);
        // collab_session_bindings rows (if any exist from a prior slice)
        // are closed here at the storage level so the invariant holds for
        // whatever session rows exist by the time this runs.
        this.closeSessionsForPrincipal(tx, target.id, 'principal_suspended', now);

        this.insertAudit(tx, 'agent_suspended', caller.principalId, target.id, {
          principalId: target.id,
          authEpoch: newEpoch,
        });

        const result: AgentLifecycleResult = { principalId: target.id, status: 'suspended', authEpoch: newEpoch };
        return { result, redacted: result };
      })
    );
  }

  async restoreAgent(
    caller: CallerContext,
    body: { principalId: string },
    idempotencyKey: string
  ): Promise<AgentLifecycleResult> {
    return this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'RESTORE_AGENT',
        idempotencyKey,
        body,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
        const target = this.getAgentTargetOrThrow(tx, body.principalId);

        if (target.status === 'active') {
          // (H3) same-state fresh-key rule.
          return {
            result: { principalId: target.id, status: 'active', authEpoch: target.auth_epoch },
            redacted: { principalId: target.id, status: 'active', authEpoch: target.auth_epoch },
          };
        }
        if (target.status !== 'suspended') {
          throw new CollabError('INVALID_PRINCIPAL_TRANSITION', `Cannot restore principal in state ${target.status}`);
        }

        const now = this.env.clock.next();
        const newEpoch = target.auth_epoch + 1;
        tx
          .prepare('UPDATE principals SET status = ?, auth_epoch = ?, updated_at = ? WHERE id = ?')
          .run('active', newEpoch, now, target.id);

        // Section 5.2: an effective restore closes any session bound to
        // the principal (defensive totality — legal flows produce zero
        // such sessions because suspension already closed them and a
        // suspended principal fails BASE) with reason principal_restored.
        this.closeSessionsForPrincipal(tx, target.id, 'principal_restored', now);

        this.insertAudit(tx, 'agent_restored', caller.principalId, target.id, {
          principalId: target.id,
          authEpoch: newEpoch,
        });

        const result: AgentLifecycleResult = { principalId: target.id, status: 'active', authEpoch: newEpoch };
        return { result, redacted: result };
      })
    );
  }

  async revokeAgent(
    caller: CallerContext,
    body: { principalId: string },
    idempotencyKey: string
  ): Promise<RevokeAgentResult> {
    return this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'REVOKE_AGENT',
        idempotencyKey,
        body,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
        const target = this.getAgentTargetOrThrow(tx, body.principalId);

        if (target.status === 'revoked') {
          // (H3) same-state fresh-key rule, extended to REVOKE per G1R H3:
          // no epoch increment, no session closure, no audit row;
          // revokedCredentialCount pinned to 0 on the repeat.
          const result: RevokeAgentResult = {
            principalId: target.id,
            status: 'revoked',
            authEpoch: target.auth_epoch,
            revokedCredentialCount: 0,
          };
          return { result, redacted: result };
        }

        const now = this.env.clock.next();
        const newEpoch = target.auth_epoch + 1;
        tx
          .prepare('UPDATE principals SET status = ?, auth_epoch = ?, revoked_at = ?, updated_at = ? WHERE id = ?')
          .run('revoked', newEpoch, now, now, target.id);

        // Revoke also revokes every agent credential (terminal revoke
        // differs from single-credential revoke).
        const activeCreds = tx
          .prepare('SELECT id FROM principal_credentials WHERE principal_id = ? AND state = ?')
          .all(target.id, 'active') as Array<{ id: string }>;
        for (const c of activeCreds) {
          tx
            .prepare('UPDATE principal_credentials SET state = ?, revoked_at = ? WHERE id = ?')
            .run('revoked', now, c.id);
        }

        this.closeSessionsForPrincipal(tx, target.id, 'principal_revoked', now);

        this.insertAudit(tx, 'agent_revoked', caller.principalId, target.id, {
          principalId: target.id,
          authEpoch: newEpoch,
          revokedCredentialCount: activeCreds.length,
        });

        const result: RevokeAgentResult = {
          principalId: target.id,
          status: 'revoked',
          authEpoch: newEpoch,
          revokedCredentialCount: activeCreds.length,
        };
        return { result, redacted: result };
      })
    );
  }

  async rotatePrincipalCredential(
    caller: CallerContext,
    body: { principalId: string; replaceCredentialId: string },
    idempotencyKey: string
  ): Promise<RotateCredentialResult> {
    return this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'ROTATE_PRINCIPAL_CREDENTIAL',
        idempotencyKey,
        body,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
        const target = this.getPrincipalOrThrow(tx, body.principalId);

        const replaced = tx
          .prepare('SELECT * FROM principal_credentials WHERE id = ?')
          .get(body.replaceCredentialId) as CredentialRow | undefined;
        if (!replaced || replaced.principal_id !== target.id || replaced.state !== 'active') {
          throw new CollabError(
            'CREDENTIAL_NOT_FOUND',
            `Credential ${body.replaceCredentialId} is unknown, not active, or not owned by ${target.id}`
          );
        }

        // (L2) LAST_OPERATOR_CREDENTIAL guard for ROTATE when
        // replaceCredentialId is the operator's only active credential —
        // counted INSIDE the transaction after BEGIN IMMEDIATE.
        if (target.kind === 'operator') {
          const activeCount = this.countActiveCredentials(tx, target.id);
          if (activeCount <= 1) {
            throw new CollabError(
              'LAST_OPERATOR_CREDENTIAL',
              'Cannot rotate the operator\'s only active credential without mutation'
            );
          }
        }

        const now = this.env.clock.next();
        const cred = this.issueCredentialRow(tx, target.id, now);

        tx
          .prepare('UPDATE principal_credentials SET state = ?, revoked_at = ? WHERE id = ?')
          .run('revoked', now, replaced.id);

        this.closeSessionsForCredential(tx, replaced.id, 'credential_revoked', now);

        this.insertAudit(tx, 'credential_created', caller.principalId, target.id, {
          principalId: target.id,
          credentialId: cred.credentialId,
        });
        this.insertAudit(tx, 'credential_revoked', caller.principalId, target.id, {
          principalId: target.id,
          credentialId: replaced.id,
        });

        const result: RotateCredentialResult = {
          principalId: target.id,
          credentialId: cred.credentialId,
          credential: cred.token,
          credentialAvailable: true,
          replacedCredentialId: replaced.id,
        };
        const redacted: RotateCredentialResult = {
          principalId: target.id,
          credentialId: cred.credentialId,
          credentialAvailable: false,
          replacedCredentialId: replaced.id,
        };
        return { result, redacted, secretBytes: cred.secretBytes };
      })
    );
  }

  async revokePrincipalCredential(
    caller: CallerContext,
    body: { credentialId: string },
    idempotencyKey: string
  ): Promise<RevokeCredentialResult> {
    return this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'REVOKE_PRINCIPAL_CREDENTIAL',
        idempotencyKey,
        body,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
        const cred = tx.prepare('SELECT * FROM principal_credentials WHERE id = ?').get(body.credentialId) as
          | CredentialRow
          | undefined;
        if (!cred) {
          throw new CollabError('CREDENTIAL_NOT_FOUND', `Credential ${body.credentialId} not found`);
        }

        const owner = this.getPrincipalOrThrow(tx, cred.principal_id);

        if (cred.state === 'revoked') {
          // "returns the original revocation result for an already-revoked
          // one" — a fresh success result reflecting current state, no
          // further mutation.
          const result: RevokeCredentialResult = {
            credentialId: cred.id,
            revokedAt: cred.revoked_at ?? this.env.clock.next(),
          };
          return { result, redacted: result };
        }

        // (L2) LAST_OPERATOR_CREDENTIAL guard for REVOKE, counted inside
        // the transaction after BEGIN IMMEDIATE.
        if (owner.kind === 'operator') {
          const activeCount = this.countActiveCredentials(tx, owner.id);
          if (activeCount <= 1) {
            throw new CollabError(
              'LAST_OPERATOR_CREDENTIAL',
              'Cannot revoke the operator\'s final active credential without mutation'
            );
          }
        }

        const now = this.env.clock.next();
        tx.prepare('UPDATE principal_credentials SET state = ?, revoked_at = ? WHERE id = ?').run(
          'revoked',
          now,
          cred.id
        );

        this.closeSessionsForCredential(tx, cred.id, 'credential_revoked', now);

        this.insertAudit(tx, 'credential_revoked', caller.principalId, owner.id, {
          principalId: owner.id,
          credentialId: cred.id,
        });

        const result: RevokeCredentialResult = { credentialId: cred.id, revokedAt: now };
        return { result, redacted: result };
      })
    );
  }

  // -------------------------------------------------------------------
  // Direct storage-level negative-fixture surface (Section 9 validations)
  // -------------------------------------------------------------------

  /**
   * Exposes the raw db handle for direct storage-level negative fixtures
   * (Section 9's mandate: "Direct storage-level negative fixtures invoke
   * every CollaborationStore write method with ... forged owner
   * memberships ... and prove zero rows change"). Tests use this to
   * attempt writes bypassing the command layer's own guards and assert
   * the DB-level CHECKs/validations still hold.
   */
  get rawDb(): BootstrapDb {
    return this.env.db;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private issueCredentialRow(
    tx: BootstrapDb,
    principalId: string,
    now: string
  ): { credentialId: string; token: string; secretBytes: Buffer } {
    const credentialId = this.env.uuids.next();
    const issued = issueCredential(credentialId, this.env.principalPepper, this.env.rng);

    // (F1) Capture the secret Buffer reference AT ALLOCATION, before the
    // INSERT below can throw, and before returning control to `fn`/the
    // transaction closure/the post-`fn` mutation-result INSERT/commit. From
    // this point on, `runKeyedCommand`'s outer try/finally owns zeroing
    // this exact Buffer on every exit path — success, IDEMPOTENCY_CONFLICT,
    // predicate denial (not reachable after this line), UNIQUE-violation
    // rethrow, or any later throw (e.g. a throwing clock).
    this.pendingSecretBytes = issued.secretBytes;

    try {
      tx
        .prepare(
          'INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES(?,?,?,?,?,?,?)'
        )
        .run(credentialId, principalId, issued.secretHmac, 'active', null, now, null);
    } catch (err) {
      // (F1) Do NOT fill(0) here: `this.pendingSecretBytes` already holds
      // this exact Buffer, and `runKeyedCommand`'s outer try/finally is the
      // single source of truth for zeroing it, on this path and every
      // other. Zeroing here too would be harmless (fill(0) is idempotent)
      // but would split the "who zeroes this" responsibility across two
      // places, which is exactly the bug this fix removes.
      //
      // (M1): a secret_hmac UNIQUE violation is a typed internal invariant
      // error, not an uncaught SQLite exception. better-sqlite3 raises a
      // generic Error whose `.message` contains the SQLite constraint
      // description; we detect the UNIQUE-on-secret_hmac case by message
      // content since better-sqlite3 does not expose a typed error class
      // for this in the injected BootstrapDb interface.
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed.*secret_hmac/i.test(message)) {
        throw new CredentialHmacCollisionError(
          `secret_hmac collision detected for credential ${credentialId}: ${message}`
        );
      }
      throw err;
    }

    return { credentialId, token: issued.token, secretBytes: issued.secretBytes };
  }

  private countActiveCredentials(tx: BootstrapDb, principalId: string): number {
    const row = tx
      .prepare('SELECT COUNT(*) as c FROM principal_credentials WHERE principal_id = ? AND state = ?')
      .get(principalId, 'active') as { c: number };
    return row.c;
  }

  private getPrincipalOrThrow(tx: BootstrapDb, principalId: string): PrincipalRow {
    const row = tx.prepare('SELECT * FROM principals WHERE id = ?').get(principalId) as PrincipalRow | undefined;
    if (!row) {
      throw new CollabError('PRINCIPAL_NOT_FOUND', `Principal ${principalId} not found`);
    }
    return row;
  }

  private getAgentTargetOrThrow(tx: BootstrapDb, principalId: string): PrincipalRow {
    const row = this.getPrincipalOrThrow(tx, principalId);
    if (row.kind !== 'agent') {
      // Section 7.4: SUSPEND_AGENT/RESTORE_AGENT/REVOKE_AGENT return
      // INVALID_REQUEST when principalId names the operator.
      throw new CollabError('INVALID_REQUEST', `${principalId} is not an agent principal`);
    }
    return row;
  }

  private getOperatorOrThrow(tx: BootstrapDb): PrincipalRow {
    const row = tx.prepare("SELECT * FROM principals WHERE kind = 'operator'").get() as PrincipalRow | undefined;
    if (!row) {
      throw new CollabError('PRINCIPAL_NOT_FOUND', 'No operator principal exists');
    }
    return row;
  }

  /**
   * Section 9 validations 1/9 (e-3): storage-level backstop. Every write
   * verifies the invoking principal is the operator (kind operator) and
   * active; a mismatch rolls back with ZERO row changes by throwing before
   * any mutation statement runs (the caller's already-open BEGIN IMMEDIATE
   * transaction is rolled back around this throw).
   */
  private assertOperatorCaller(tx: BootstrapDb, caller: CallerContext): void {
    const row = tx.prepare('SELECT * FROM principals WHERE id = ?').get(caller.principalId) as
      | PrincipalRow
      | undefined;
    if (!row || row.kind !== 'operator' || row.status !== 'active') {
      throw new CollabError(
        'COLLAB_NOT_PERMITTED',
        'Only the active operator principal, connected with role operator, may invoke this command'
      );
    }
  }

  private insertAudit(
    tx: BootstrapDb,
    kind: string,
    actorPrincipalId: string,
    subjectPrincipalId: string,
    content: Record<string, unknown>
  ): void {
    const now = this.env.clock.next();
    tx
      .prepare(
        'INSERT INTO collab_audit(kind, actor_principal_id, subject_principal_id, content_json, created_at) VALUES(?,?,?,?,?)'
      )
      .run(kind, actorPrincipalId, subjectPrincipalId, canonicalJson(content), now);
  }

  private closeSessionsForPrincipal(
    tx: BootstrapDb,
    principalId: string,
    closeReason: string,
    now: string
  ): number {
    const openSessions = tx
      .prepare('SELECT session_id FROM collab_session_bindings WHERE principal_id = ? AND closed_at IS NULL')
      .all(principalId) as Array<{ session_id: string }>;
    for (const s of openSessions) {
      tx
        .prepare('UPDATE collab_session_bindings SET closed_at = ?, close_reason = ? WHERE session_id = ?')
        .run(now, closeReason, s.session_id);
    }
    return openSessions.length;
  }

  private closeSessionsForCredential(
    tx: BootstrapDb,
    credentialId: string,
    closeReason: string,
    now: string
  ): number {
    const openSessions = tx
      .prepare('SELECT session_id FROM collab_session_bindings WHERE credential_id = ? AND closed_at IS NULL')
      .all(credentialId) as Array<{ session_id: string }>;
    for (const s of openSessions) {
      tx
        .prepare('UPDATE collab_session_bindings SET closed_at = ?, close_reason = ? WHERE session_id = ?')
        .run(now, closeReason, s.session_id);
    }
    return openSessions.length;
  }

  /**
   * The Section 8.3 atomic protocol driver.
   *
   * `predicate` runs FIRST inside the transaction (step 2: revalidate the
   * command predicate) — for every Slice 1 command this is
   * `assertOperatorCaller`, since all seven Slice 1 commands are
   * OPERATOR_GLOBAL. It must throw a CollabError to deny.
   *
   * The idempotency lookup (steps 3-5) then runs, followed by `fn` (step
   * 6: perform the mutation) only when no stored result was returned.
   * `fn` must throw a CollabError (or let one propagate) for any
   * command-specific denial (e.g. PRINCIPAL_NOT_FOUND); this wrapper turns
   * any throw into a clean ROLLBACK.
   *
   * On success, `fn` returns `{ result, redacted, secretBytes? }`: `result`
   * is the full first-response shape (with plaintext secret if
   * applicable), `redacted` is what gets persisted to
   * `collab_mutation_results.result_json`, and `secretBytes` (if present)
   * is zeroed AFTER commit (step 7: commit BEFORE one-time secret
   * handoff), on both the success and error paths.
   *
   * (F1) Zeroing discipline: `fn`'s mutation logic (specifically
   * `issueCredentialRow`, when a command issues a credential) sets
   * `this.pendingSecretBytes` to the live secret Buffer THE INSTANT it is
   * allocated — before the credential INSERT, before this method's own
   * mutation-result INSERT, before commit. The `try/finally` below wraps
   * the ENTIRE transaction invocation (`tx()`), so `this.pendingSecretBytes`
   * is zeroed on every exit from `tx()` — normal return (success or
   * same-hash replay, where it is simply `undefined` and the fill is a
   * no-op), a thrown `IDEMPOTENCY_CONFLICT`, a thrown command-specific
   * CollabError from `fn`, a thrown UNIQUE-violation from the credential
   * INSERT, or a throw from ANYTHING that runs after allocation but before
   * `tx()` returns — including the `this.env.clock.next()` call and the
   * `collab_mutation_results` INSERT that both run after `fn()` in this
   * method. This closes the exact gap the G2A audit found: previously the
   * secret Buffer reference was only captured in a local variable AFTER
   * `fn()` returned successfully, so a throw between allocation and that
   * point left the Buffer un-zeroed on the heap. Capturing at allocation
   * time on `this` and zeroing in `finally` makes zeroing unconditional.
   */
  private runKeyedCommand<TResult>(
    principalId: string,
    command: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
    predicate: (tx: BootstrapDb) => void,
    fn: (tx: BootstrapDb) => { result: TResult; redacted: unknown; secretBytes?: Buffer }
  ): TResult {
    // (H1/F2): hash the POST-NORMALIZATION POST-TRIM body. Every public
    // command method normalizes its own free-text fields (e.g.
    // createAgent's displayName via normalizeName) before calling this
    // method, so `body` here is already the exact persisted-form bytes,
    // and canonicalJson(body) is the exact hash input, matching what gets
    // persisted (bound to canonicalJson specifically, not JSON.stringify,
    // so key order never perturbs the hash — see the permuted-key-order
    // replay fixture).
    const requestHash = createHash('sha256').update(canonicalJson(body)).digest();

    let finalResult: TResult;

    const tx = this.env.db.transaction(() => {
      // Step 2: revalidate the command predicate INSIDE the transaction,
      // before the idempotency lookup (steps 3-5).
      predicate(this.env.db);

      const existing = this.env.db
        .prepare(
          'SELECT request_hash, result_json FROM collab_mutation_results WHERE principal_id = ? AND command = ? AND idempotency_key = ?'
        )
        .get(principalId, command, idempotencyKey) as { request_hash: Buffer; result_json: string } | undefined;

      if (existing) {
        const existingHashBuf = Buffer.from(existing.request_hash);
        if (existingHashBuf.equals(requestHash)) {
          finalResult = JSON.parse(existing.result_json) as TResult;
          return;
        }
        throw new CollabError('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different request body');
      }

      // (F1) `fn` may call `issueCredentialRow`, which sets
      // `this.pendingSecretBytes` at allocation — before this line
      // returns. Nothing here re-reads `secretBytes` off the return value
      // for zeroing purposes; the outer `finally` is the sole zeroer.
      const { result, redacted } = fn(this.env.db);

      const now = this.env.clock.next();
      this.env.db
        .prepare(
          'INSERT INTO collab_mutation_results(principal_id, command, idempotency_key, request_hash, result_json, created_at) VALUES(?,?,?,?,?,?)'
        )
        .run(principalId, command, idempotencyKey, requestHash, JSON.stringify(redacted), now);

      finalResult = result;
    });

    try {
      tx();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return finalResult!;
    } finally {
      // (F1) Unconditional zero-and-clear: covers the success path (step 7
      // semantics — commit already happened above, by the time we reach
      // here, before this one-time zero) AND every throw path, including
      // throws that occur after credential allocation but before this
      // try/finally's `tx()` call returns.
      if (this.pendingSecretBytes) {
        this.pendingSecretBytes.fill(0);
        this.pendingSecretBytes = undefined;
      }
    }
  }
}

/** A CredentialLookup adapter backed by a live BootstrapDb, for connect-path verification (used by future slices / tests). */
export function credentialLookupFromDb(db: BootstrapDb): CredentialLookup {
  return (credentialId: string) => {
    const row = db.prepare('SELECT secret_hmac, state FROM principal_credentials WHERE id = ?').get(credentialId) as
      | { secret_hmac: Buffer; state: 'active' | 'revoked' }
      | undefined;
    if (!row) return undefined;
    return { secretHmac: Buffer.from(row.secret_hmac), state: row.state };
  };
}
