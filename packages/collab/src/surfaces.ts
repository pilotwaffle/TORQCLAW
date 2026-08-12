/**
 * C1 — Surface identity (PRD-TCLAW-COLLAB-GATEWAY-004 §2.2, §2.3, §2.5).
 *
 * A Surface is WHERE one Principal acts (a device/channel/automation
 * endpoint). Credentials belong to surfaces; authority belongs to the
 * principal behind them (C0 `PrincipalBinding` doc comment).
 *
 * WHY A SEPARATE MIGRATION FROM migration.ts
 * -------------------------------------------
 * `runCollaborationMigration` records `20260806_001_collaboration_v1` in
 * `collab_schema_migrations` and returns a COMPLETE NO-OP on every
 * subsequent call (migration.ts:44-50). Adding the C1 DDL to that function
 * would therefore never run on any database that already bootstrapped —
 * the IF-NOT-EXISTS trap in PRD §2.10/§6.2, stated there explicitly. C1
 * gets its own separately-recorded, independently-guarded migration so it
 * applies to legacy and fresh databases alike, and is a no-op when re-run.
 *
 * CRYPTO IS REUSED, NEVER REDEFINED (§2.3)
 * -----------------------------------------
 * Issuance/verification call `credentials.ts` verbatim: `issueCredential`
 * for the `tq1_<credentialId>_<secret>` format, `verifyCredential` for the
 * existence-oblivious two-HMAC compare. This module adds NO crypto
 * primitive of its own. The one C1 addition is the `expires_at` gate,
 * which §2.4 requires to sit on the SAME state gate that already turns
 * `state != 'active'` into AUTH_FAILED — so an expired credential costs
 * exactly the same number of HMAC operations as revoked/unknown/malformed.
 * That is why expiry is folded into the `lookup` callback's state result
 * rather than checked before/after the verify call: a pre-check would
 * return early and make expired credentials measurably cheaper, which is
 * precisely the leak the existence-oblivious design exists to prevent.
 */

import type Database from 'better-sqlite3';
import { verifyCredential, type CredentialLookup, type VerifyCredentialResult } from './credentials.js';

export const C1_SURFACES_MIGRATION_ID = '20260811_002_surface_identity_c1';

/** The six surface kinds (SI-2). A seventh is a reviewed schema change. */
export const SURFACE_KINDS = ['desktop', 'mobile', 'http', 'telegram', 'slack', 'automation'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** The operator-kind discriminator (§2.2, §2.7.1). Defaults to 'agent'. */
export const SURFACE_ROLES = ['operator', 'agent', 'automation'] as const;
export type SurfaceRole = (typeof SURFACE_ROLES)[number];

/** Kinds that can NEVER carry surface_role='operator' (§2.2 cross-CHECK, CT-2). */
export const NON_OPERATOR_KINDS: ReadonlySet<string> = new Set(['telegram', 'slack', 'automation']);

/**
 * Applies the C1 surface-identity migration. Idempotent: guarded by its own
 * row in `collab_schema_migrations`, and every object uses IF NOT EXISTS so
 * a partially-applied database converges rather than throwing.
 *
 * Strictly additive (§1.5): touches no existing table, column, row, index,
 * or trigger. `principals` is referenced by foreign key only.
 */
export function runSurfaceIdentityMigration(db: Database.Database): void {
  const applied = db
    .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
    .get(C1_SURFACES_MIGRATION_ID);
  if (applied) return;

  const tx = db.transaction(() => {
    db.exec(`
CREATE TABLE IF NOT EXISTS surfaces (
    surface_id        TEXT PRIMARY KEY,
    principal_id      TEXT NOT NULL,
    surface_kind      TEXT NOT NULL CHECK (surface_kind IN
                        ('desktop','mobile','http','telegram','slack','automation')),
    surface_role      TEXT NOT NULL DEFAULT 'agent'
                        CHECK (surface_role IN ('operator','agent','automation')),
    display_name      TEXT,
    capability_json   TEXT NOT NULL DEFAULT '[]',
    state             TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','revoked')),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at        DATETIME,
    last_seen_at      DATETIME,
    FOREIGN KEY (principal_id) REFERENCES principals(id),
    CHECK (surface_kind NOT IN ('telegram','slack','automation')
           OR surface_role != 'operator')
);
CREATE INDEX IF NOT EXISTS idx_surfaces_principal_state ON surfaces(principal_id, state);

CREATE TABLE IF NOT EXISTS surface_credentials (
    credential_id     TEXT PRIMARY KEY,
    surface_id        TEXT NOT NULL,
    secret_hmac       BLOB NOT NULL UNIQUE,
    state             TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','revoked')),
    issued_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at        DATETIME,
    revoked_at        DATETIME,
    FOREIGN KEY (surface_id) REFERENCES surfaces(surface_id)
);
CREATE INDEX IF NOT EXISTS idx_surface_credentials_surface_state
    ON surface_credentials(surface_id, state);
    `);
    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      C1_SURFACES_MIGRATION_ID,
      new Date().toISOString(),
    );
  });
  tx();
}

/**
 * Guarded ALTER for columns added to `surfaces`/`surface_credentials`
 * AFTER their first ship (§2.10, storage.ts:107-111 precedent). Present
 * from the start so the trap it defends against — an existing DB never
 * re-running CREATE and therefore never seeing a new column — has a
 * ready, tested seam rather than being discovered later under pressure.
 * Every column it adds must be nullable.
 */
export function addSurfaceColumnIfMissing(
  db: Database.Database,
  table: 'surfaces' | 'surface_credentials',
  column: string,
  ddlType: string,
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  return true;
}

// ---------------------------------------------------------------------------
// Credential verification (C1-2) — existence-oblivious, expiry on the same gate
// ---------------------------------------------------------------------------

/** `now` is injected so tests pin the expiry boundary without sleeping. */
export type NowSource = () => Date;

/**
 * Build a `CredentialLookup` over `surface_credentials`.
 *
 * The expiry gate (§2.4) is applied HERE, by reporting an expired row as
 * `state: 'revoked'`, because `verifyCredential` performs its two HMAC
 * operations and its length-guarded compare BEFORE consulting `state`
 * (credentials.ts:223-234). Folding expiry into the returned state means
 * an expired credential traverses the identical code path — same two HMAC
 * ops, same compare, same AUTH_FAILED — as a revoked one. Checking
 * `expires_at` outside this callback would short-circuit and make expiry
 * distinguishable by cost, breaking A3's "same path as A2" requirement.
 *
 * The row is still fetched and its real `secret_hmac` still compared, so
 * an expired credential costs exactly what an active one costs.
 */
export function surfaceCredentialLookup(db: Database.Database, now: NowSource = () => new Date()): CredentialLookup {
  const stmt = db.prepare(
    'SELECT secret_hmac AS secretHmac, state, expires_at AS expiresAt FROM surface_credentials WHERE credential_id = ?',
  );
  return (credentialId: string) => {
    const row = stmt.get(credentialId) as
      | { secretHmac: Buffer; state: string; expiresAt: string | null }
      | undefined;
    if (row === undefined) return undefined;
    const expired = row.expiresAt !== null && Date.parse(row.expiresAt) <= now().getTime();
    const state: 'active' | 'revoked' = row.state === 'active' && !expired ? 'active' : 'revoked';
    return { secretHmac: row.secretHmac, state };
  };
}

export interface VerifiedSurface {
  credentialId: string;
  surfaceId: string;
  principalId: string;
  surfaceKind: SurfaceKind;
  surfaceRole: SurfaceRole;
}

/**
 * Verify a presented surface token and resolve the owning surface.
 *
 * Returns null on ANY failure — malformed token, unknown/revoked/expired
 * credential, revoked surface, or an orphaned credential whose surface row
 * is missing. Every failure is indistinguishable to the caller (the
 * connect seam turns null into the same AUTH_FAILED + close(4001) as a bad
 * root token), and no exception escapes: `verifyCredential` is already
 * total (credentials.ts:237-240) and the post-verify reads are wrapped.
 *
 * The surface-state check runs AFTER a successful credential verify, which
 * is safe for the existence-oblivious property: reaching it at all
 * requires having presented a cryptographically valid secret for a live
 * credential, so an attacker cannot use it as an oracle for credentials
 * they do not hold. A2 (revoked SURFACE, credential still known) is
 * enforced by cascading credential revocation in the same transaction
 * (§2.5), so a revoked surface's credentials fail at the constant-cost
 * gate above rather than here; this check is the belt-and-braces backstop
 * for a surface revoked without cascade (e.g. direct DB edit or an
 * interrupted cascade).
 */
export function verifySurfaceToken(
  db: Database.Database,
  presentedToken: string,
  principalPepper: Buffer,
  now: NowSource = () => new Date(),
): VerifiedSurface | null {
  let result: VerifyCredentialResult;
  try {
    result = verifyCredential(presentedToken, principalPepper, surfaceCredentialLookup(db, now));
  } catch {
    return null;
  }
  if (!result.ok) return null;

  try {
    const row = db
      .prepare(
        `SELECT c.surface_id AS surfaceId, s.principal_id AS principalId,
                s.surface_kind AS surfaceKind, s.surface_role AS surfaceRole, s.state AS surfaceState
           FROM surface_credentials c
           JOIN surfaces s ON s.surface_id = c.surface_id
          WHERE c.credential_id = ?`,
      )
      .get(result.credentialId) as
      | {
          surfaceId: string;
          principalId: string;
          surfaceKind: SurfaceKind;
          surfaceRole: SurfaceRole;
          surfaceState: string;
        }
      | undefined;
    if (row === undefined) return null;
    if (row.surfaceState !== 'active') return null;
    return {
      credentialId: result.credentialId,
      surfaceId: row.surfaceId,
      principalId: row.principalId,
      surfaceKind: row.surfaceKind,
      surfaceRole: row.surfaceRole,
    };
  } catch {
    return null;
  }
}
