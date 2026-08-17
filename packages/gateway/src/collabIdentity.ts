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
  runCollaborationMigration,
  runSurfaceIdentityMigration,
  runSurfaceAuditMigration,
  type SecretStore,
  type BootstrapDb,
} from '@torqclaw/collab';
import type { PrincipalBinding } from './principalBridge.js';
import type { AuthenticatedCaller } from './connectionAuth.js';
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

/**
 * S1: exported so collabSurface.ts can fetch the same principal pepper this
 * module already uses to construct its production CollaborationStore --
 * without duplicating the SecretStore selection/override logic. Returns
 * null exactly when connect-path verification would also fail closed (no
 * pepper provisioned), which callers must treat as a hard read refusal.
 */
export function getPrincipalPepper(): Buffer | undefined {
  return getSecretStore().get(PRINCIPAL_PEPPER_SECRET_NAME);
}

/**
 * Bring a freshly opened `collab.db` up to the current schema.
 *
 * WHY THIS IS HERE (G2A round 1, defect 2). `state.db` self-migrates at
 * gateway boot (`storage.ts`, and `ensureSurfaceSecuritySchema` in
 * server.ts), but `collab.db` was only ever OPENED here -- never migrated.
 * The C0 and C1 collab migrations therefore had no production caller at
 * all, and the built-artifact test had to create the tables by hand, which
 * proved the shipped artifact could not stand up its own database. A
 * migration nothing calls is not a migration.
 *
 * All THREE are wired at this one seam rather than just the C1 pair, so
 * the fix is not C1-partial: C0's `runCollaborationMigration` had the same
 * absence.
 *
 * Each is independently guarded and idempotent (its own row in
 * `collab_schema_migrations`), so this is a no-op on an already-migrated
 * database and safe to run on every open.
 *
 * Failures are swallowed by design. This runs on the CONNECT path, and a
 * migration problem must not crash the gateway or become a DoS vector: an
 * unmigrated database simply has no surface tables, so every credential
 * lookup misses and the connection fails closed with AUTH_FAILED -- the
 * same outcome as an unknown credential, revealing nothing.
 */
function migrateCollabDb(db: BootstrapDb): void {
  try {
    const handle = db as unknown as Database.Database;
    runCollaborationMigration(handle);
    runSurfaceIdentityMigration(handle);
    runSurfaceAuditMigration(handle);
  } catch {
    /* fail closed: an unmigrated DB authenticates nobody */
  }
}

/**
 * S1 (PRD-TCLAW-COLLAB-PRESENCE-UI-005): exported so the read-surface module
 * (collabSurface.ts) can share this exact migrated collab.db handle rather
 * than opening a second connection to the same file. Test overrides
 * (setCollabDbForTest) apply here identically -- there is only ever one
 * handle for this module's lifetime.
 */
export function getCollabDb(): BootstrapDb {
  if (collabDbOverride) return collabDbOverride;
  if (!defaultCollabDb) {
    const path = process.env.TORQCLAW_COLLAB_DB_PATH || join(DATA_DIR, 'collab.db');
    const opened = new Database(path) as unknown as BootstrapDb;
    // Migrate ONCE, at initialization, before the handle is ever cached or
    // used -- not on every call.
    migrateCollabDb(opened);
    defaultCollabDb = opened;
  }
  return defaultCollabDb;
}

/** Standalone read: credentialId -> principal_credentials.principal_id.
 *  Deliberately NOT folded into CredentialLookup (which returns only
 *  {secretHmac, state} by design -- credentials.ts:120-123) -- widening
 *  that shared type would ripple into every CredentialLookup consumer for a
 *  need that is specific to this one connect-path derivation. */
type PrincipalAuthority = {
  principalId: string;
  principalKind: 'operator' | 'agent';
  principalStatus: string;
};

function principalAuthorityForCredential(
  db: BootstrapDb,
  credentialId: string,
): PrincipalAuthority | null {
  const row = db
    .prepare(
      `SELECT pc.principal_id AS principalId,
              p.kind AS principalKind,
              p.status AS principalStatus
         FROM principal_credentials pc
         JOIN principals p ON p.id = pc.principal_id
        WHERE pc.id = ?`,
    )
    .get(credentialId) as PrincipalAuthority | undefined;
  return row ?? null;
}

function principalAuthorityForPrincipal(
  db: BootstrapDb,
  principalId: string,
): PrincipalAuthority | null {
  const row = db
    .prepare(
      `SELECT id AS principalId, kind AS principalKind, status AS principalStatus
         FROM principals
        WHERE id = ?`,
    )
    .get(principalId) as PrincipalAuthority | undefined;
  return row ?? null;
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
  return verifyLegacySurfaceAuthority(credential)?.binding ?? null;
}

function verifyLegacySurfaceAuthority(
  credential: string,
): { binding: PrincipalBinding; principalKind: 'operator' | 'agent' } | null {
  try {
    const pepper = getSecretStore().get(PRINCIPAL_PEPPER_SECRET_NAME);
    if (!pepper) return null;

    const db = getCollabDb();
    const lookup = credentialLookupFromDb(db);
    const result = verifyCredential(credential, pepper, lookup);
    if (!result.ok) return null;

    const authority = principalAuthorityForCredential(db, result.credentialId);
    if (!authority || authority.principalStatus !== 'active') return null;

    // surfaceId=credentialId stand-in -- see module doc comment.
    return {
      binding: { principalId: authority.principalId, surfaceId: result.credentialId },
      principalKind: authority.principalKind,
    };
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
): { caller: AuthenticatedCaller; auth: ConnectionAuthContext | null } | null {
  try {
    const pepper = getSecretStore().get(PRINCIPAL_PEPPER_SECRET_NAME);
    if (!pepper) return null;

    const collabDb = getCollabDb() as unknown as Database.Database;

    // C1 path first.
    const ctx = validatePresentingSurface(
      { collabDb, stateDb, principalPepper: pepper },
      credential,
    );
    if (ctx !== null) {
      const authority = principalAuthorityForPrincipal(collabDb as unknown as BootstrapDb, ctx.principalId);
      if (!authority || authority.principalStatus !== 'active') return null;
      const operator = authority.principalKind === 'operator' && ctx.surfaceRole === 'operator';
      const role = operator ? 'operator' : 'node';
      const authClass = operator
        ? 'operator_surface'
        : ctx.surfaceRole === 'automation'
          ? 'automation_surface'
          : 'agent_surface';
      return { caller: { binding: bindingFor(ctx), role, authClass }, auth: ctx };
    }

    // C0.1 legacy fallback (see above).
    const legacy = verifyLegacySurfaceAuthority(credential);
    if (legacy !== null) {
      const role = legacy.principalKind === 'operator' ? 'operator' : 'node';
      const authClass = legacy.principalKind === 'operator' ? 'operator_surface' : 'agent_surface';
      return { caller: { binding: legacy.binding, role, authClass }, auth: null };
    }

    return null;
  } catch {
    return null;
  }
}

export type { ConnectionAuthContext };
