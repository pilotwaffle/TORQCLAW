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
 * The principal pepper lives outside SQLite in a SecretStore (PRD Section
 * 6.1/6.3). Production now uses `FileSecretStore` (packages/collab/src/
 * secrets.ts), a file-backed persistent store under `TORQCLAW_DATA_DIR`; a
 * native OS-keyring adapter (`WindowsCredentialManagerStore`) remains a
 * deferred stub behind the same interface. Both the pepper source and the
 * credential DB handle are injectable (mirrors the `db` singleton pattern
 * in storage.ts) so tests and the built-artifact harness can wire a real,
 * working pepper + database without touching production wiring, and so
 * production fails CLOSED (AUTH_FAILED, never a crash or a silent bypass)
 * whenever no pepper has been provisioned yet.
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  verifyCredential,
  credentialLookupFromDb,
  FileSecretStore,
  runCollaborationMigration,
  runSurfaceIdentityMigration,
  runSurfaceAuditMigration,
  runAgentAutoreplyMigration,
  runAgentCronMigration,
  writeSurfaceAudit,
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
import { activateSurfaceProjection, liveSurfaceSecurity } from './surfaceSecurity.js';

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

/**
 * Production SecretStore. `FileSecretStore` is scoped to the SAME
 * `TORQCLAW_DATA_DIR` resolution `storage.ts`/`getCollabDb` already use
 * (the `DATA_DIR` import above), not a re-derived path. It reads
 * `process.env.TORQCLAW_DATA_DIR` live (via `DATA_DIR`'s own module-load
 * resolution, mirrored here) rather than caching, matching this module's
 * existing lazy-open pattern for `getCollabDb()`.
 *
 * Replaces the throwing `WindowsCredentialManagerStore` stub that
 * previously made the collab feature entirely inert in production (every
 * `.get()` call threw, every credential failed AUTH_FAILED). A native
 * keyring-backed store remains DEFERRED (see secrets.ts) and can drop in
 * here later with zero call-site changes elsewhere in this module.
 */
function getSecretStore(): SecretStore {
  if (secretStoreOverride) return secretStoreOverride;
  if (!defaultSecretStore) defaultSecretStore = new FileSecretStore(DATA_DIR);
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
    // PRD-TCLAW-AGENT-PARTICIPATION-007 S3: the auto-reply watermark + STOP
    // tables. A separate, explicitly-invoked call here (NOT cascaded inside
    // runCollaborationMigration itself) for the same reason C1's two calls
    // above are separate: tests/auth-v2-phase2a.test.ts's
    // assertShippedCollabLedger deliberately fails closed on any
    // "unexpected" extra row in collab_schema_migrations beyond its own
    // known two-row ledger, so this table's migration id must not appear
    // until AFTER whatever inspects that ledger has already run -- exactly
    // how C1's own migrations already coexist with that check today.
    runAgentAutoreplyMigration(handle);
    // CRON: additive, same "runs last" discipline as S3's own migration
    // immediately above and for the identical reason -- it must not appear
    // in collab_schema_migrations until AFTER assertShippedCollabLedger's
    // exactly-two-row check (inside runSurfaceIdentityMigration, earlier in
    // this sequence) has already run.
    runAgentCronMigration(handle);
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
 * S3 (CO-1): exported so collabSurface.ts's `callerFor` never hardcodes a
 * `CallerContext.kind` literal for a write path. Per the PRD's frozen
 * "CallerContext.kind source" ruling (Cycle-3 NB-3): the substrate reads
 * `principals.kind` from its OWN DB for every security-relevant check
 * (assertOperatorCaller/assertChannelOwner -- store.ts:1966-2023) and never
 * trusts `caller.kind` (grep-verified: `caller.kind` is read nowhere in
 * store.ts) -- so `kind` on the CallerContext handed to the store is
 * advisory plumbing, never an authorization input. Hardcoding it wrong is
 * therefore not a live privilege-escalation bug for POST_CHANNEL_MESSAGE
 * (assertChannelVisible ignores it entirely), but a CallerContext that
 * *claims* `kind: 'operator'` for an agent principal is still a dishonest
 * value living exactly where a future security-relevant read of it would
 * silently inherit the lie -- the same "looks right, isn't" shape as D-1.
 * Reuses the SAME query `resolveConnectIdentity` already runs
 * (principalAuthorityForPrincipal, this module) rather than adding a
 * second lookup path.
 *
 * Returns null on any lookup failure (unknown principal, closed/errored
 * handle) -- callers MUST treat null as "kind unknown" and fail closed
 * (never default to 'operator'), matching this module's house posture of
 * never throwing across a connect-adjacent seam.
 */
export function getPrincipalKind(db: BootstrapDb, principalId: string): 'operator' | 'agent' | null {
  try {
    return principalAuthorityForPrincipal(db, principalId)?.principalKind ?? null;
  } catch {
    return null;
  }
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
 * S1 (PRD-TCLAW-AGENT-PARTICIPATION-007 follow-on) — self-heal the missing
 * C1 `surfaces` row for an OPERATOR-kind principal authenticated through
 * the C0.1 legacy path.
 *
 * ROOT CAUSE THIS FIXES: no shipped path (`bootstrapOperator`,
 * packages/collab/src/bootstrap.ts) has ever called `createSurface`, so an
 * operator's `principal_credentials` row has never had a matching C1
 * `surfaces` row. `resolveConnectIdentity` therefore always missed the C1
 * branch for the operator and returned `auth: null`, which left
 * `connectionAuth` permanently null for the ONLY credential any shipped
 * path mints for an operator -- POST_CHANNEL_MESSAGE read
 * `connectionAuth?.principalId` and always saw null, and (separately,
 * reported not fixed here) C2 approval registration's `taskOrigin`/
 * `liveProfileDelegation` evidence chain (c2Broker.ts:69-75) was
 * unreachable for the operator for the same reason.
 *
 * WHY THIS PROJECTS THE EXISTING CREDENTIAL RATHER THAN MINTING A NEW ONE:
 * `issueSurfaceCredential` (surfaceStore.ts) always mints a brand-new
 * `tq1_...` token -- there is no API to bind an already-distributed token
 * to a surface. Minting a second, different credential the operator does
 * not hold and has no way to receive would fix nothing (the operator would
 * keep presenting their ORIGINAL token, which would still miss). Instead
 * this inserts a `surfaces` row and a `surface_credentials` row keyed by
 * the operator's EXISTING `principal_credentials.id` and its EXISTING
 * `secret_hmac` -- not a re-derivation, the identical stored bytes. Because
 * `verifyCredential` (credentials.ts) recomputes the presented token's HMAC
 * from the token bytes themselves and compares against whatever `secretHmac`
 * the lookup returns, the operator's one physical token now verifies
 * successfully against EITHER table under the identical pepper -- this is
 * not principal synthesis (§2a): the subject is the same already-verified
 * principal, projected into the table C1 checks, not a new or substituted
 * identity.
 *
 * NEVER RUNS FOR AN AGENT. `createAgent`-minted credentials are S1's
 * concern (agentCollabPrincipalId in server.ts) and are deliberately left
 * on the C0.1 legacy path unchanged -- widening surface auto-provisioning
 * to agents was never scoped or reviewed here.
 *
 * Idempotent and fail-open-to-legacy: a duplicate surface/credential (this
 * function already ran for this principal on an earlier connect) is caught
 * and treated as already-provisioned, not an error. ANY failure here
 * (missing schema, closed handle, constraint violation from concurrent
 * connects) is swallowed and the caller falls back to the untouched C0.1
 * legacy path -- this function may only ever WIDEN what the operator can
 * reach relative to today's shipped (broken) behaviour, never narrow or
 * crash the connect seam.
 */
function ensureOperatorSurfaceProvisioned(
  collabDb: Database.Database,
  legacyCredentialId: string,
  operatorPrincipalId: string,
): void {
  try {
    // G1R B-SH-1: "already provisioned" means ALL THREE writes across BOTH
    // databases -- the surfaces row, its surface_credentials link (atomic
    // together inside tx() below), and the state.db enforcement projection
    // (activateSurfaceProjection, which necessarily runs OUTSIDE that
    // transaction because it targets a different database).
    //
    // The original guard read only the first. A crash, throw, or closed
    // handle between the tx() commit and the projection left collab.db
    // provisioned and state.db empty -- and on every later connect
    // validatePresentingSurface returned null (no projection), control fell
    // to the legacy branch, and THIS GUARD saw the orphan row and returned
    // without re-attempting the projection. The operator was bricked
    // PERMANENTLY by the very routine that exists to un-brick them. G1R
    // reproduced it twice on the real booted gateway: COLLAB_IDENTITY_REQUIRED,
    // zero committed messages, surfacesRows=1, stateProjections=0.
    //
    // So: resolve the EXISTING surface only when its credential link is also
    // active, and treat a missing projection as work still to do rather than
    // as done. Re-running activateSurfaceProjection for an existing surface_id
    // is idempotent by construction (INSERT ... ON CONFLICT(surface_id) DO
    // UPDATE), and carrying the same surface_role means the role-change epoch
    // bump is not triggered.
    const already = collabDb
      .prepare(
        `SELECT s.surface_id AS surfaceId
           FROM surfaces s
           JOIN surface_credentials sc ON sc.surface_id = s.surface_id
          WHERE s.principal_id = ? AND s.surface_role = ?
            AND s.state = 'active' AND sc.state = 'active'`,
      )
      .get(operatorPrincipalId, 'operator') as { surfaceId: string } | undefined;

    if (already) {
      if (liveSurfaceSecurity(stateDb, already.surfaceId) !== null) return; // fully provisioned
      // Collab side is intact but the state.db projection is missing -- the
      // partial-write state. Repair it rather than returning.
      activateSurfaceProjection(stateDb, {
        surfaceId: already.surfaceId,
        principalId: operatorPrincipalId,
        surfaceKind: 'desktop',
        surfaceRole: 'operator',
        // G1R ruling: [] is the schema's own declared default and the
        // fail-closed value. See the note at the fresh-provision call below.
        allowedCapabilityClasses: [],
        authEpoch: 1,
        capabilityRevision: 1,
        sourceIdentityRevision: already.surfaceId,
      });
      return;
    }

    const credRow = collabDb
      .prepare('SELECT secret_hmac AS secretHmac FROM principal_credentials WHERE id = ? AND principal_id = ?')
      .get(legacyCredentialId, operatorPrincipalId) as { secretHmac: Buffer } | undefined;
    if (!credRow) return; // nothing to project

    const surfaceId = randomUUID();
    const now = new Date();

    const tx = collabDb.transaction(() => {
      collabDb
        .prepare('SELECT 1 FROM surfaces WHERE surface_id = ?')
        .get(surfaceId); // uniqueness is enforced by the INSERTs below; this read is a no-op guard
      collabDb
        .prepare(
          `INSERT INTO surfaces
             (surface_id, principal_id, surface_kind, surface_role, display_name,
              capability_json, state, created_at)
           VALUES (?,?,?,?,?,?,'active',?)`,
        )
        .run(surfaceId, operatorPrincipalId, 'desktop', 'operator', 'Legacy operator surface', '[]', now.toISOString());
      collabDb
        .prepare(
          `INSERT INTO surface_credentials
             (credential_id, surface_id, secret_hmac, state, issued_at, expires_at)
           VALUES (?,?,?,'active',?,NULL)`,
        )
        .run(legacyCredentialId, surfaceId, credRow.secretHmac, now.toISOString());
      writeSurfaceAudit(
        collabDb,
        'surface_created',
        { principalId: operatorPrincipalId, surfaceId, credentialId: legacyCredentialId },
        { surfaceKind: 'desktop', surfaceRole: 'operator', selfHealed: true, reason: 'legacy-operator-c1-backfill' },
        now,
      );
    });
    tx();

    // Grant-last (§1.4): activate the state.db enforcement projection only
    // after the collab-side identity row committed. authEpoch/
    // capabilityRevision start at 1 -- this is a fresh surface, not a
    // re-activation, so there is no prior epoch to respect.
    activateSurfaceProjection(stateDb, {
      surfaceId,
      principalId: operatorPrincipalId,
      surfaceKind: 'desktop',
      surfaceRole: 'operator',
      // G1R ruling on the builder's flagged judgment call. The original value
      // was ['read','write','exec','send'], justified as "preserving the
      // operator's prior unconditional legacy authority" -- but that rationale
      // is wrong on the facts: the operator had NO surface row at all, which
      // IS the defect being fixed. There is nothing to preserve. Choosing the
      // MAXIMUM for a field that never had a value is a decision, not a
      // continuation.
      //
      // The field is currently stored and projected but consulted by NO
      // authorization gate anywhere in packages/gateway/src, so this changes
      // no live behavior today. It is a LATENT WIDENING: the moment any slice
      // adds an allowedCapabilityClasses check, every self-healed operator
      // surface would silently arrive pre-authorized for 'exec' -- the
      // highest-consequence class -- via a connect-path auto-provisioner no
      // human reviewed for that install.
      //
      // [] is the schema's own declared default (allowed_capability_classes_json
      // TEXT NOT NULL DEFAULT '[]') and the fail-closed value, matching this
      // repo's stated posture ("UNKNOWN NEVER MEANS READ", capability.ts).
      // Widening later is trivial and safe (ON CONFLICT DO UPDATE); narrowing
      // later, after installs have accumulated exec-bearing rows, is not.
      // Take the reversible direction.
      allowedCapabilityClasses: [],
      authEpoch: 1,
      capabilityRevision: 1,
      sourceIdentityRevision: surfaceId,
    });
  } catch {
    // Fail closed to the pre-existing legacy path -- never let a
    // provisioning race or schema hiccup escape the connect seam.
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
      // Self-heal (see ensureOperatorSurfaceProvisioned doc comment): the
      // ONLY shipped path that mints an operator credential
      // (bootstrapOperator) never provisions a matching C1 `surfaces` row,
      // so every operator permanently missed the C1 branch above and
      // connectionAuth stayed null for the operator's one real credential.
      // Runs ONLY for principalKind === 'operator' -- agent credentials are
      // untouched and keep taking the unchanged legacy branch below.
      if (legacy.principalKind === 'operator') {
        ensureOperatorSurfaceProvisioned(collabDb, legacy.binding.surfaceId, legacy.binding.principalId);
        // Re-run the C1 gate ONCE on this same connection now that
        // provisioning (if it happened) has committed. A provisioning
        // failure (schema hiccup, race) leaves this a no-op and ctx2 stays
        // null, which falls through to the untouched legacy return below --
        // fail-closed, never worse than pre-fix behaviour.
        const ctx2 = validatePresentingSurface(
          { collabDb, stateDb, principalPepper: pepper },
          credential,
        );
        if (ctx2 !== null) {
          const authority2 = principalAuthorityForPrincipal(collabDb as unknown as BootstrapDb, ctx2.principalId);
          if (authority2 && authority2.principalStatus === 'active') {
            const operator2 = authority2.principalKind === 'operator' && ctx2.surfaceRole === 'operator';
            const role2 = operator2 ? 'operator' : 'node';
            const authClass2 = operator2
              ? 'operator_surface'
              : ctx2.surfaceRole === 'automation'
                ? 'automation_surface'
                : 'agent_surface';
            return { caller: { binding: bindingFor(ctx2), role: role2, authClass: authClass2 }, auth: ctx2 };
          }
        }
      }
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
