/**
 * C1 — gateway-owned surface security projection, control-plane AUTHORITY
 * store, and immutable per-request task origin.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §2.7, §2.7.1, §2.13, §3.14 (CT-2), §4.
 *
 * OWNERSHIP (§1.2, §4)
 * --------------------
 * collab.db owns CONFIGURED identity (surfaces, credentials, requested
 * capability). state.db -- this module -- owns EFFECTIVE execution
 * capability and control-plane authority. The split is what lets the
 * dispatch/decision path authorize without a cross-WAL read: everything
 * checked at decision time lives in the same database and therefore the
 * same serialization interval (§1.4).
 *
 * WHY AUTHORITY IS A SEPARATE TABLE, NOT A COLUMN (§2.7.1, ruling AR-1)
 * ---------------------------------------------------------------------
 * `approve` is a control-plane AUTHORITY, not an execution capability. It
 * lives in `surface_authorities`, never in `surfaces.capability_json`, so
 * that "reachable only through the authority path" is structurally true
 * rather than a naming convention. A surface holding every execution
 * capability still holds no authority. One row = one grant, giving each
 * high-sensitivity grant an individually-revocable audit grain.
 *
 * FAIL-CLOSED IS THE DEFAULT EVERYWHERE (§2.7.1, §3.14)
 * -----------------------------------------------------
 * Absence, revocation, epoch mismatch, unknown surface, or a malformed
 * lookup all resolve to "no authority" / "no capability". Authority is
 * never implied by execution capability, profile, principal role, or
 * surface kind.
 */

import type Database from 'better-sqlite3';

/** Control-plane authority vocabulary. `approve` frozen; others reserved. */
export const AUTHORITIES = ['approve', 'cancel', 'delegate'] as const;
export type Authority = (typeof AUTHORITIES)[number];

/** Shipped execution capability classes (§2.7). NEVER includes `approve`. */
export const CAPABILITY_CLASSES = ['read', 'write', 'exec', 'send'] as const;
export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

export type SurfaceRole = 'operator' | 'agent' | 'automation';
export type SurfaceKind = 'desktop' | 'mobile' | 'http' | 'telegram' | 'slack' | 'automation';

const NON_OPERATOR_KINDS: ReadonlySet<string> = new Set(['telegram', 'slack', 'automation']);

export class AuthorityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthorityError';
    this.code = code;
  }
}

/**
 * Additive, idempotent migration for the C1 state.db objects (§6.2).
 * `CREATE TABLE IF NOT EXISTS` only; no existing table is altered here, so
 * there is nothing for the IF-NOT-EXISTS trap to catch — but any column
 * added to these tables AFTER first ship must use the PRAGMA-guarded
 * `addStateColumnIfMissing` helper below (storage.ts:107-111 precedent).
 */
export function ensureSurfaceSecuritySchema(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS gateway_surface_security (
    surface_id                      TEXT PRIMARY KEY,
    principal_id                    TEXT NOT NULL,
    surface_kind                    TEXT NOT NULL CHECK (surface_kind IN
                                      ('desktop','mobile','http','telegram','slack','automation')),
    surface_role                    TEXT NOT NULL
                                      CHECK (surface_role IN ('operator','agent','automation')),
    state                           TEXT NOT NULL DEFAULT 'revoked'
                                      CHECK (state IN ('active','revoked')),
    auth_epoch                      INTEGER NOT NULL CHECK (auth_epoch > 0),
    allowed_capability_classes_json TEXT NOT NULL DEFAULT '[]',
    allowed_operation_ids_json      TEXT NOT NULL DEFAULT '[]',
    capability_revision             INTEGER NOT NULL CHECK (capability_revision > 0),
    source_identity_revision        TEXT NOT NULL,
    activated_at                    DATETIME,
    revoked_at                      DATETIME
);

CREATE TABLE IF NOT EXISTS surface_authorities (
    grant_id          TEXT PRIMARY KEY,
    surface_id        TEXT NOT NULL,
    authority         TEXT NOT NULL
                        CHECK (authority IN ('approve','cancel','delegate')),
    granted_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    auth_epoch        INTEGER NOT NULL,
    revoked_at        DATETIME,
    FOREIGN KEY (surface_id) REFERENCES gateway_surface_security(surface_id)
);
CREATE INDEX IF NOT EXISTS idx_surface_authorities_surface ON surface_authorities(surface_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_authorities_one_live
    ON surface_authorities(surface_id, authority) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS gateway_task_origins (
    request_id        TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    connection_id     TEXT NOT NULL,
    principal_id      TEXT NOT NULL,
    surface_id        TEXT NOT NULL,
    surface_kind      TEXT NOT NULL,
    credential_id     TEXT NOT NULL,
    credential_expires_at DATETIME,
    auth_epoch        INTEGER NOT NULL,
    capability_revision INTEGER NOT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gateway_task_origins_session ON gateway_task_origins(session_id);
  `);
}

/** PRAGMA-guarded ALTER for post-first-ship columns (§6.2). */
export function addStateColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  ddlType: string,
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  return true;
}

// ---------------------------------------------------------------------------
// Projection activation (grant-last) and revocation (deny-first)
// ---------------------------------------------------------------------------

export interface ActivateSurfaceParams {
  surfaceId: string;
  principalId: string;
  surfaceKind: SurfaceKind;
  surfaceRole: SurfaceRole;
  /** Effective capability classes, already intersected by the caller. */
  allowedCapabilityClasses?: readonly CapabilityClass[];
  allowedOperationIds?: readonly string[];
  authEpoch: number;
  capabilityRevision: number;
  /** Opaque revision of the collab-side configured identity this copies. */
  sourceIdentityRevision: string;
}

/**
 * Activate (or re-activate) a surface's enforcement projection.
 *
 * Grant-last (§1.4): the caller must have committed the collab-side
 * configured identity FIRST. If that commit succeeded and this one fails,
 * the surface simply cannot act — the safe direction. This function
 * performs no cross-WAL read; it trusts the caller to pass configured
 * kind/role that it validated, and re-checks the CT-2 cross-rule itself so
 * a caller bug cannot activate a channel surface as operator-role.
 */
export function activateSurfaceProjection(
  db: Database.Database,
  params: ActivateSurfaceParams,
  now: Date = new Date(),
): void {
  if (params.surfaceRole === 'operator' && NON_OPERATOR_KINDS.has(params.surfaceKind)) {
    throw new AuthorityError(
      'CHANNEL_CANNOT_BE_OPERATOR',
      `surface_kind '${params.surfaceKind}' can never be activated as operator-role (CT-2)`,
    );
  }
  if (!Number.isSafeInteger(params.authEpoch) || params.authEpoch <= 0) {
    throw new AuthorityError('INVALID_AUTH_EPOCH', 'auth_epoch must be a positive integer');
  }
  if (!Number.isSafeInteger(params.capabilityRevision) || params.capabilityRevision <= 0) {
    throw new AuthorityError('INVALID_CAPABILITY_REVISION', 'capability_revision must be a positive integer');
  }
  for (const cls of params.allowedCapabilityClasses ?? []) {
    // Checked BEFORE the generic unknown-class refusal so the one mistake
    // that would collapse the identity/capability/authority split (§1.2.1)
    // reports what it actually is, rather than hiding behind a vague
    // "unknown class". An authority token must never be storable as an
    // execution capability.
    if ((AUTHORITIES as readonly string[]).includes(cls)) {
      throw new AuthorityError('AUTHORITY_IN_CAPABILITY', `'${cls}' is a control-plane authority, not a capability`);
    }
    if (!CAPABILITY_CLASSES.includes(cls)) {
      throw new AuthorityError('INVALID_CAPABILITY_CLASS', `unknown capability class: ${cls}`);
    }
  }

  db.prepare(
    `INSERT INTO gateway_surface_security
       (surface_id, principal_id, surface_kind, surface_role, state, auth_epoch,
        allowed_capability_classes_json, allowed_operation_ids_json,
        capability_revision, source_identity_revision, activated_at, revoked_at)
     VALUES (?,?,?,?,'active',?,?,?,?,?,?,NULL)
     ON CONFLICT(surface_id) DO UPDATE SET
       principal_id=excluded.principal_id,
       surface_kind=excluded.surface_kind,
       surface_role=excluded.surface_role,
       state='active',
       auth_epoch=excluded.auth_epoch,
       allowed_capability_classes_json=excluded.allowed_capability_classes_json,
       allowed_operation_ids_json=excluded.allowed_operation_ids_json,
       capability_revision=excluded.capability_revision,
       source_identity_revision=excluded.source_identity_revision,
       activated_at=excluded.activated_at,
       revoked_at=NULL`,
  ).run(
    params.surfaceId, params.principalId, params.surfaceKind, params.surfaceRole,
    params.authEpoch,
    JSON.stringify(params.allowedCapabilityClasses ?? []),
    JSON.stringify(params.allowedOperationIds ?? []),
    params.capabilityRevision, params.sourceIdentityRevision, now.toISOString(),
  );
}

export interface LiveSurfaceSecurity {
  surfaceId: string;
  principalId: string;
  surfaceKind: SurfaceKind;
  surfaceRole: SurfaceRole;
  authEpoch: number;
  capabilityRevision: number;
  allowedCapabilityClasses: CapabilityClass[];
  allowedOperationIds: string[];
}

/**
 * Read the LIVE projection for a surface. Returns null when the surface is
 * unknown, revoked, or its stored JSON is unparseable — every one of which
 * must deny (§2.7 "a missing/stale projection denies").
 */
export function liveSurfaceSecurity(db: Database.Database, surfaceId: string): LiveSurfaceSecurity | null {
  try {
    const row = db
      .prepare(
        `SELECT surface_id AS surfaceId, principal_id AS principalId, surface_kind AS surfaceKind,
                surface_role AS surfaceRole, state, auth_epoch AS authEpoch,
                capability_revision AS capabilityRevision,
                allowed_capability_classes_json AS classesJson,
                allowed_operation_ids_json AS opsJson
           FROM gateway_surface_security WHERE surface_id = ?`,
      )
      .get(surfaceId) as
      | {
          surfaceId: string; principalId: string; surfaceKind: SurfaceKind; surfaceRole: SurfaceRole;
          state: string; authEpoch: number; capabilityRevision: number; classesJson: string; opsJson: string;
        }
      | undefined;
    if (!row || row.state !== 'active') return null;
    const classes = JSON.parse(row.classesJson) as CapabilityClass[];
    const ops = JSON.parse(row.opsJson) as string[];
    if (!Array.isArray(classes) || !Array.isArray(ops)) return null;
    return {
      surfaceId: row.surfaceId,
      principalId: row.principalId,
      surfaceKind: row.surfaceKind,
      surfaceRole: row.surfaceRole,
      authEpoch: row.authEpoch,
      capabilityRevision: row.capabilityRevision,
      allowedCapabilityClasses: classes,
      allowedOperationIds: ops,
    };
  } catch {
    return null;
  }
}

/**
 * Deny-first revocation (§1.4, §2.5): mark the projection revoked, bump the
 * auth epoch, and revoke every live authority row for the surface — all in
 * ONE state.db transaction, BEFORE the caller touches collab.db. The epoch
 * bump is what makes any authority row minted at the old epoch fail
 * `holdsAuthority`'s epoch match even if a revocation row were missed.
 */
export function revokeSurfaceProjection(
  db: Database.Database,
  surfaceId: string,
  now: Date = new Date(),
): { revoked: boolean; authoritiesRevoked: number; newAuthEpoch: number | null } {
  const tx = db.transaction(() => {
    const row = db
      .prepare('SELECT auth_epoch AS authEpoch, state FROM gateway_surface_security WHERE surface_id = ?')
      .get(surfaceId) as { authEpoch: number; state: string } | undefined;
    if (!row) return { revoked: false, authoritiesRevoked: 0, newAuthEpoch: null };

    const newEpoch = row.authEpoch + 1;
    db.prepare(
      `UPDATE gateway_surface_security
          SET state='revoked', revoked_at=?, auth_epoch=?
        WHERE surface_id=?`,
    ).run(now.toISOString(), newEpoch, surfaceId);

    const info = db
      .prepare(`UPDATE surface_authorities SET revoked_at=? WHERE surface_id=? AND revoked_at IS NULL`)
      .run(now.toISOString(), surfaceId);

    return { revoked: row.state === 'active', authoritiesRevoked: Number(info.changes), newAuthEpoch: newEpoch };
  });
  return tx() as { revoked: boolean; authoritiesRevoked: number; newAuthEpoch: number | null };
}

// ---------------------------------------------------------------------------
// Control-plane authority (§2.7.1, CT-2 §3.14)
// ---------------------------------------------------------------------------

/**
 * Grant a control-plane authority.
 *
 * CT-2 enforcement point 1 (provisioning time): `approve` is grantable ONLY
 * to a surface whose LIVE projection says `surface_role='operator'` at the
 * current epoch. The predicate is `surface_role`, never `surface_kind`
 * alone — two desktop surfaces can differ in whether they are the
 * operator's control-plane surface.
 *
 * Performs NO cross-WAL read: everything it checks is in this transaction's
 * own database, which is precisely why activation must be grant-last.
 * A live duplicate is an explicit refusal, not a silent no-op.
 */
export function grantAuthority(
  db: Database.Database,
  surfaceId: string,
  authority: Authority,
  grantId: string,
  now: Date = new Date(),
): void {
  if (!AUTHORITIES.includes(authority)) {
    throw new AuthorityError('UNKNOWN_AUTHORITY', `unknown authority token: ${authority}`);
  }
  const tx = db.transaction(() => {
    const live = liveSurfaceSecurity(db, surfaceId);
    if (!live) {
      throw new AuthorityError('NO_LIVE_PROJECTION', `surface has no live security projection: ${surfaceId}`);
    }
    if (authority === 'approve') {
      if (live.surfaceRole !== 'operator') {
        throw new AuthorityError(
          'CT2_NOT_OPERATOR_ROLE',
          `'approve' is grantable only to surface_role='operator' (CT-2); this surface is '${live.surfaceRole}'`,
        );
      }
      if (NON_OPERATOR_KINDS.has(live.surfaceKind)) {
        throw new AuthorityError(
          'CT2_CHANNEL_KIND',
          `'approve' is never grantable to channel/automation kind '${live.surfaceKind}' (CT-2)`,
        );
      }
    }
    const dup = db
      .prepare('SELECT 1 FROM surface_authorities WHERE surface_id=? AND authority=? AND revoked_at IS NULL')
      .get(surfaceId, authority);
    if (dup) {
      throw new AuthorityError('AUTHORITY_ALREADY_HELD', `surface already holds a live '${authority}' grant`);
    }
    db.prepare(
      `INSERT INTO surface_authorities (grant_id, surface_id, authority, granted_at, auth_epoch, revoked_at)
       VALUES (?,?,?,?,?,NULL)`,
    ).run(grantId, surfaceId, authority, now.toISOString(), live.authEpoch);
  });
  tx();
}

/** Revoke the one live grant. Never deletes — the audit trail persists. */
export function revokeAuthority(
  db: Database.Database,
  surfaceId: string,
  authority: Authority,
  now: Date = new Date(),
): number {
  const info = db
    .prepare(`UPDATE surface_authorities SET revoked_at=? WHERE surface_id=? AND authority=? AND revoked_at IS NULL`)
    .run(now.toISOString(), surfaceId, authority);
  return Number(info.changes);
}

/**
 * Decision-time authority read — the SINGLE seam `authz.ts` consults for
 * `APPROVE_TOOL` (§2.7.1).
 *
 * True only for a row with matching (surface_id, authority), `revoked_at IS
 * NULL`, AND an `auth_epoch` equal to the surface's CURRENT live epoch.
 * The epoch match is what makes a revoke-then-reactivate cycle unable to
 * silently resurrect an old grant. Every other outcome — absent row, epoch
 * drift, revoked/absent projection, malformed input, or any thrown error —
 * is false.
 */
export function holdsAuthority(db: Database.Database, surfaceId: string, authority: Authority): boolean {
  try {
    const live = liveSurfaceSecurity(db, surfaceId);
    if (!live) return false;
    const row = db
      .prepare(
        `SELECT 1 FROM surface_authorities
          WHERE surface_id=? AND authority=? AND revoked_at IS NULL AND auth_epoch=?`,
      )
      .get(surfaceId, authority, live.authEpoch);
    return row !== undefined;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Immutable per-request task origin (§2.13, C1-5)
// ---------------------------------------------------------------------------

export interface TaskOriginParams {
  requestId: string;
  sessionId: string;
  connectionId: string;
  principalId: string;
  surfaceId: string;
  surfaceKind: string;
  credentialId: string;
  credentialExpiresAt?: string | null;
  authEpoch: number;
  capabilityRevision: number;
}

/**
 * Capture immutable origin evidence for ONE task, keyed by `request_id`.
 *
 * Request-keyed, never session-keyed: a durable session may have many
 * concurrent connections presenting DIFFERENT valid same-principal
 * surfaces (C0 allows cross-surface resume), so a session-keyed row would
 * be last-writer-wins and would silently misattribute a task's origin.
 *
 * Every field is server-derived from the verified connection context. No
 * client may supply any of them. The row is written once and never
 * updated: a duplicate `request_id` is refused rather than overwritten,
 * which is what makes it usable as evidence.
 */
export function captureTaskOrigin(db: Database.Database, params: TaskOriginParams): void {
  try {
    db.prepare(
      `INSERT INTO gateway_task_origins
         (request_id, session_id, connection_id, principal_id, surface_id, surface_kind,
          credential_id, credential_expires_at, auth_epoch, capability_revision)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      params.requestId, params.sessionId, params.connectionId, params.principalId,
      params.surfaceId, params.surfaceKind, params.credentialId,
      params.credentialExpiresAt ?? null, params.authEpoch, params.capabilityRevision,
    );
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new AuthorityError('ORIGIN_ALREADY_CAPTURED', `task origin already recorded for request ${params.requestId}`);
    }
    throw err;
  }
}

export function taskOrigin(db: Database.Database, requestId: string): TaskOriginParams | null {
  const row = db
    .prepare(
      `SELECT request_id AS requestId, session_id AS sessionId, connection_id AS connectionId,
              principal_id AS principalId, surface_id AS surfaceId, surface_kind AS surfaceKind,
              credential_id AS credentialId, credential_expires_at AS credentialExpiresAt,
              auth_epoch AS authEpoch, capability_revision AS capabilityRevision
         FROM gateway_task_origins WHERE request_id = ?`,
    )
    .get(requestId) as TaskOriginParams | undefined;
  return row ?? null;
}
