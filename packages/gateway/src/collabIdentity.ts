/**
 * C0.1 — Server-derived surface-credential identity for the connect path.
 *
 * SCOPE: identity TRANSPORT only. This module answers exactly one question:
 * given a presented `tq1_...` surface credential, which principal does it
 * belong to? It does NOT touch approvals, channels, capability enforcement,
 * or any C1/C2/C3 concern, and it does NOT widen `CredentialLookup`
 * (packages/collab/src/credentials.ts:120-123) — the small `principal_id`
 * read below is a standalone query against the SAME `principal_credentials`
 * row `credentialLookupFromDb` already reads, not a change to that type.
 *
 * WHY A SEPARATE MODULE FROM principalBridge.ts
 * ----------------------------------------------
 * principalBridge.ts's `resolvePrincipalBinding` reads identity OFF THE
 * CLIENT FRAME (`frame.principalId`/`frame.surfaceId`) -- that is the exact
 * dead cast this slice removes from the production path (H-1: a client must
 * never be trusted to assert its own principal). This module instead
 * DERIVES a PrincipalBinding from a cryptographically verified credential;
 * the surface path in sessions.ts calls this and bypasses
 * resolvePrincipalBinding's frame-reading branch entirely on that path.
 *
 * surfaceId=credentialId STAND-IN (documented per G1R)
 * -----------------------------------------------------
 * C1 has not landed yet -- there is no independent "surface" concept in the
 * schema. A credential is the closest thing to a surface that exists today
 * (packages/collab principal_credentials has no surface_id column at all --
 * bootstrap.ts:639), so this slice uses the verified credentialId AS the
 * surfaceId. This is legible and harmless because assertResumeAllowed
 * (principalBridge.ts) keys authorization on principalId ONLY; surfaceId is
 * carried for future multi-surface UX (e.g. "resumed from your desktop
 * session"), never as a security boundary.
 *
 * PEPPER / DB PROVISIONING
 * -------------------------
 * The principal pepper lives outside SQLite in a SecretStore (Windows
 * Credential Manager in production; PRD Section 6.1/6.3). The real adapter
 * is a stub that throws NOT_IMPLEMENTED (packages/collab/src/secrets.ts) --
 * a known, separately-tracked gap, not something this transport slice can
 * or should paper over. Both the pepper source and the credential DB handle
 * are injectable (mirrors the `db` singleton pattern in storage.ts) so
 * tests and the built-artifact harness can wire a real, working pepper +
 * database without touching production wiring, and so production fails
 * CLOSED (AUTH_FAILED, never a crash or a silent bypass) until a real
 * SecretStore adapter lands.
 */

import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  verifyCredential,
  credentialLookupFromDb,
  WindowsCredentialManagerStore,
  type SecretStore,
  type BootstrapDb,
} from '@torqclaw/collab';
import type { PrincipalBinding } from './principalBridge.js';
import { DATA_DIR, db as stateDb } from './storage.js';
import {
  validatePresentingSurface,
  bindingFor,
  type ConnectionAuthContext,
} from './surfaceGate.js';

const PRINCIPAL_PEPPER_SECRET_NAME = 'TORQCLAW/principal-pepper';

let secretStoreOverride: SecretStore | null = null;
let collabDbOverride: BootstrapDb | null = null;
let defaultSecretStore: SecretStore | null = null;
let defaultCollabDb: BootstrapDb | null = null;

/** Test-only override of the pepper source. Production never calls this. */
export function setCollabSecretStoreForTest(store: SecretStore | null): void {
  secretStoreOverride = store;
}

/** Test-only override of the credential DB handle. Production never calls this. */
export function setCollabDbForTest(db: BootstrapDb | null): void {
  collabDbOverride = db;
}

function getSecretStore(): SecretStore {
  if (secretStoreOverride) return secretStoreOverride;
  if (!defaultSecretStore) defaultSecretStore = new WindowsCredentialManagerStore();
  return defaultSecretStore;
}

function getCollabDb(): BootstrapDb {
  if (collabDbOverride) return collabDbOverride;
  if (!defaultCollabDb) {
    const path = process.env.TORQCLAW_COLLAB_DB_PATH || join(DATA_DIR, 'collab.db');
    defaultCollabDb = new Database(path) as unknown as BootstrapDb;
  }
  return defaultCollabDb;
}

/** Standalone read: credentialId -> principal_credentials.principal_id.
 *  Deliberately NOT folded into CredentialLookup (which returns only
 *  {secretHmac, state} by design -- credentials.ts:120-123) -- widening
 *  that shared type would ripple into every CredentialLookup consumer for a
 *  need that is specific to this one connect-path derivation. */
function principalIdForCredential(db: BootstrapDb, credentialId: string): string | null {
  const row = db
    .prepare('SELECT principal_id FROM principal_credentials WHERE id = ?')
    .get(credentialId) as { principal_id: string } | undefined;
  return row ? row.principal_id : null;
}

/**
 * Verify a presented surface credential and derive its PrincipalBinding.
 *
 * Returns null on ANY failure -- bad token, unknown/revoked credential,
 * missing pepper, missing/unreachable collab DB, or an orphaned credential
 * row with no matching principal_id. Every failure is deliberately
 * indistinguishable to the caller (M-1: the connect seam turns a null into
 * the SAME AUTH_FAILED + socket.close(4001) as a bad root token; this
 * function itself never throws and never reveals which sub-check failed).
 */
export function verifySurfaceCredential(credential: string): PrincipalBinding | null {
  try {
    const pepper = getSecretStore().get(PRINCIPAL_PEPPER_SECRET_NAME);
    if (!pepper) return null;

    const db = getCollabDb();
    const lookup = credentialLookupFromDb(db);
    const result = verifyCredential(credential, pepper, lookup);
    if (!result.ok) return null;

    const principalId = principalIdForCredential(db, result.credentialId);
    if (!principalId) return null;

    // surfaceId=credentialId stand-in -- see module doc comment.
    return { principalId, surfaceId: result.credentialId };
  } catch {
    // No exception may ever escape to the connect seam -- same posture as
    // verifyCredential itself (credentials.ts:237-240).
    return null;
  }
}

/**
 * C1-5 — resolve the connect-path identity, preferring a REAL C1 surface.
 *
 * This is the seam server.ts calls. It runs step 2 of the §2.6 ordered
 * gate (`validatePresentingSurface`) against the C1 `surfaces` /
 * `surface_credentials` tables. On success the caller gets a
 * `ConnectionAuthContext` — server-derived, connection-scoped, carrying
 * the auth epoch and capability revision that later seams recheck.
 *
 * WHY THE C0.1 FALLBACK REMAINS
 * ------------------------------
 * C0.1 credentials live in `principal_credentials` and predate the
 * `surfaces` table entirely. An installation that authenticated fine
 * yesterday must keep authenticating today: C1 is additive (§1.5), so a
 * credential with no C1 surface row falls back to the C0.1 derivation with
 * its documented `surfaceId = credentialId` stand-in. That path yields no
 * ConnectionAuthContext, because there is no surface projection to derive
 * one from — which is correct: such a connection holds no C1 capability
 * or authority, and every C1 check it meets denies fail-closed.
 *
 * Order matters: the C1 path is tried FIRST so a surface that has been
 * properly provisioned is never silently downgraded to the weaker legacy
 * derivation.
 *
 * Returns null on total failure, which the caller renders as the same
 * AUTH_FAILED + close(4001) as a bad root token (M-1).
 */
export function resolveConnectIdentity(
  credential: string,
): { binding: PrincipalBinding; auth: ConnectionAuthContext | null } | null {
  try {
    const pepper = getSecretStore().get(PRINCIPAL_PEPPER_SECRET_NAME);
    if (!pepper) return null;

    const collabDb = getCollabDb() as unknown as Database.Database;

    // C1 path first.
    const ctx = validatePresentingSurface(
      { collabDb, stateDb, principalPepper: pepper },
      credential,
    );
    if (ctx !== null) return { binding: bindingFor(ctx), auth: ctx };

    // C0.1 legacy fallback (see above).
    const legacy = verifySurfaceCredential(credential);
    if (legacy !== null) return { binding: legacy, auth: null };

    return null;
  } catch {
    return null;
  }
}

export type { ConnectionAuthContext };
