/**
 * C1 — Surface provisioning, credential issuance, and revocation cascade
 * (PRD-TCLAW-COLLAB-GATEWAY-004 §2.2, §2.3, §2.5, §2.8, §2.9).
 *
 * This is the collab-side WRITE path for C1. It owns configured identity
 * truth; the gateway owns effective execution/control-plane authority
 * (§1.2, §4). Nothing here reads or writes `state.db`.
 *
 * AUDIT (C1-6): C1 mutations write to `collab_surface_audit`, a NEW table,
 * rather than `collab_audit`. `collab_audit.kind` carries a DDL CHECK
 * enumerating only the C0 bootstrap/credential/agent kinds
 * (migration.ts:174-179); adding C1 kinds would mean REPLACING that CHECK
 * — a destructive rebuild of a shipped table, forbidden by §1.5. A new
 * additive table with its own CHECK preserves both the constraint and the
 * strictly-additive baseline boundary. Rows are secret-free by
 * construction: this module never writes a token, a secret buffer, or a
 * `secret_hmac` into an audit payload (§2.9).
 *
 * SECRET LIFECYCLE (L1, §2.3): `issueSurfaceCredential` returns the
 * plaintext token ONCE. The raw secret Buffer is zeroed before this
 * function returns — on the success path and on every throw — so the only
 * durable representation is the HMAC. The token STRING cannot be zeroed
 * (JS strings are immutable); the caller is responsible for not persisting
 * it, and this module documents that boundary rather than pretending to
 * enforce it.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from './canonical.js';
import { issueCredential } from './credentials.js';
import type { RandomSource } from './bootstrap.js';
import {
  NON_OPERATOR_KINDS,
  SURFACE_KINDS,
  SURFACE_ROLES,
  type SurfaceKind,
  type SurfaceRole,
} from './surfaces.js';

export const C1_AUDIT_MIGRATION_ID = '20260811_003_surface_audit_c1';

export type SurfaceAuditKind =
  | 'surface_created'
  | 'surface_revoked'
  | 'surface_credential_issued'
  | 'surface_credential_revoked'
  | 'surface_credential_expired';

/** Additive audit table for C1 mutations. Idempotent; see module doc. */
export function runSurfaceAuditMigration(db: Database.Database): void {
  const applied = db
    .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
    .get(C1_AUDIT_MIGRATION_ID);
  if (applied) return;

  const tx = db.transaction(() => {
    db.exec(`
CREATE TABLE IF NOT EXISTS collab_surface_audit (
    seq               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind              TEXT NOT NULL CHECK (kind IN (
                        'surface_created','surface_revoked',
                        'surface_credential_issued','surface_credential_revoked',
                        'surface_credential_expired')),
    principal_id      TEXT,
    surface_id        TEXT,
    credential_id     TEXT,
    content_json      TEXT NOT NULL,
    created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collab_surface_audit_kind_created
    ON collab_surface_audit(kind, created_at);
    `);
    db.prepare('INSERT INTO collab_schema_migrations(id, applied_at) VALUES(?, ?)').run(
      C1_AUDIT_MIGRATION_ID,
      new Date().toISOString(),
    );
  });
  tx();
}

export class SurfaceProvisioningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SurfaceProvisioningError';
    this.code = code;
  }
}

/**
 * Keys that may never appear in an audit payload. Enforced at write time
 * (not merely by convention) because "secret-free audit" is a C1-6
 * acceptance criterion, and a convention that is only documented is the
 * exact class of unenforced claim this repo keeps re-learning.
 */
const FORBIDDEN_AUDIT_KEYS = new Set([
  'token', 'secret', 'secretBytes', 'secretHmac', 'secret_hmac',
  'credential', 'plaintext', 'pepper', 'args', 'ciphertext',
]);

function assertSecretFree(payload: Record<string, unknown>): void {
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Buffer.isBuffer(value)) {
      throw new SurfaceProvisioningError('AUDIT_SECRET_LEAK', 'audit payload contains raw bytes');
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_AUDIT_KEYS.has(key)) {
        throw new SurfaceProvisioningError('AUDIT_SECRET_LEAK', `audit payload contains forbidden key: ${key}`);
      }
      walk(child, depth + 1);
    }
  };
  walk(payload, 0);
}

export function writeSurfaceAudit(
  db: Database.Database,
  kind: SurfaceAuditKind,
  ids: { principalId?: string | null; surfaceId?: string | null; credentialId?: string | null },
  payload: Record<string, unknown>,
  now: Date = new Date(),
): void {
  assertSecretFree(payload);
  db.prepare(
    `INSERT INTO collab_surface_audit(kind, principal_id, surface_id, credential_id, content_json, created_at)
     VALUES(?,?,?,?,?,?)`,
  ).run(
    kind,
    ids.principalId ?? null,
    ids.surfaceId ?? null,
    ids.credentialId ?? null,
    canonicalJson(payload),
    now.toISOString(),
  );
}

// ---------------------------------------------------------------------------
// C1-1 — surface creation
// ---------------------------------------------------------------------------

export interface CreateSurfaceParams {
  surfaceId: string;
  principalId: string;
  surfaceKind: SurfaceKind;
  /** Defaults to 'agent' — fail-closed: a mis-provisioned surface is never operator-kind. */
  surfaceRole?: SurfaceRole;
  displayName?: string | null;
  /** Execution capability request. Defaults to '[]' (deny-all, §2.7). */
  capabilities?: readonly string[];
}

/**
 * Create a surface. Ownership is immutable (§2.8): re-parenting is not
 * offered as an operation at all, so there is no code path that could
 * perform one. A duplicate `surface_id` is an explicit refusal rather
 * than an upsert — silently rebinding an existing surface to a new
 * principal would break SI-1.
 *
 * The kind/role cross-rule is checked HERE as well as by the DDL CHECK.
 * §2.2 is explicit that the constraint is "a backstop, not the only
 * guard": provisioning must refuse legibly, with a code the operator can
 * act on, rather than surfacing a raw SQLite CHECK violation.
 */
export function createSurface(
  db: Database.Database,
  params: CreateSurfaceParams,
  now: Date = new Date(),
): void {
  const role: SurfaceRole = params.surfaceRole ?? 'agent';

  if (!SURFACE_KINDS.includes(params.surfaceKind)) {
    throw new SurfaceProvisioningError('INVALID_SURFACE_KIND', `unknown surface kind: ${params.surfaceKind}`);
  }
  if (!SURFACE_ROLES.includes(role)) {
    throw new SurfaceProvisioningError('INVALID_SURFACE_ROLE', `unknown surface role: ${role}`);
  }
  if (role === 'operator' && NON_OPERATOR_KINDS.has(params.surfaceKind)) {
    throw new SurfaceProvisioningError(
      'CHANNEL_CANNOT_BE_OPERATOR',
      `surface_kind '${params.surfaceKind}' can never carry surface_role 'operator' (CT-2)`,
    );
  }

  const capabilityJson = JSON.stringify(params.capabilities ?? []);

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT 1 FROM surfaces WHERE surface_id = ?').get(params.surfaceId);
    if (existing) {
      throw new SurfaceProvisioningError('SURFACE_EXISTS', `surface already exists: ${params.surfaceId}`);
    }
    const owner = db.prepare('SELECT 1 FROM principals WHERE id = ?').get(params.principalId);
    if (!owner) {
      throw new SurfaceProvisioningError('UNKNOWN_PRINCIPAL', `no such principal: ${params.principalId}`);
    }
    db.prepare(
      `INSERT INTO surfaces
         (surface_id, principal_id, surface_kind, surface_role, display_name,
          capability_json, state, created_at)
       VALUES (?,?,?,?,?,?,'active',?)`,
    ).run(
      params.surfaceId, params.principalId, params.surfaceKind, role,
      params.displayName ?? null, capabilityJson, now.toISOString(),
    );
    writeSurfaceAudit(
      db, 'surface_created',
      { principalId: params.principalId, surfaceId: params.surfaceId },
      { surfaceKind: params.surfaceKind, surfaceRole: role, capabilityCount: (params.capabilities ?? []).length },
      now,
    );
  });
  tx();
}

// ---------------------------------------------------------------------------
// C1-2 — credential issuance
// ---------------------------------------------------------------------------

export interface IssuedSurfaceCredential {
  credentialId: string;
  /** Plaintext token. Shown ONCE; never persisted by this module. */
  token: string;
}

/**
 * Issue a credential for a surface. The secret Buffer is zeroed in a
 * `finally` so it is cleared on the commit path AND on any rollback —
 * the L1 discipline `issueCredential`'s doc comment delegates to callers.
 *
 * A duplicate `secret_hmac` (astronomically unlikely, but structurally
 * possible and pinned by a negative test per §2.3) surfaces as a typed
 * refusal rather than a raw SQLite UNIQUE error.
 */
export function issueSurfaceCredential(
  db: Database.Database,
  surfaceId: string,
  principalPepper: Buffer,
  rng: RandomSource,
  options: { expiresAt?: Date | null; credentialId?: string } = {},
  now: Date = new Date(),
): IssuedSurfaceCredential {
  const credentialId = options.credentialId ?? randomUUID();
  const issued = issueCredential(credentialId, principalPepper, rng);

  try {
    const tx = db.transaction(() => {
      const surface = db
        .prepare('SELECT principal_id AS principalId, state FROM surfaces WHERE surface_id = ?')
        .get(surfaceId) as { principalId: string; state: string } | undefined;
      if (!surface) {
        throw new SurfaceProvisioningError('UNKNOWN_SURFACE', `no such surface: ${surfaceId}`);
      }
      if (surface.state !== 'active') {
        throw new SurfaceProvisioningError('SURFACE_REVOKED', `surface is revoked: ${surfaceId}`);
      }
      try {
        db.prepare(
          `INSERT INTO surface_credentials
             (credential_id, surface_id, secret_hmac, state, issued_at, expires_at)
           VALUES (?,?,?,'active',?,?)`,
        ).run(
          credentialId, surfaceId, issued.secretHmac, now.toISOString(),
          options.expiresAt ? options.expiresAt.toISOString() : null,
        );
      } catch (err) {
        const message = String(err);
        if (message.includes('UNIQUE')) {
          throw new SurfaceProvisioningError('CREDENTIAL_COLLISION', 'credential id or secret hmac already exists');
        }
        throw err;
      }
      writeSurfaceAudit(
        db, 'surface_credential_issued',
        { principalId: surface.principalId, surfaceId, credentialId },
        { expiresAt: options.expiresAt ? options.expiresAt.toISOString() : null },
        now,
      );
    });
    tx();
    return { credentialId, token: issued.token };
  } finally {
    // L1: zero on success AND on every throw.
    issued.secretBytes.fill(0);
  }
}

// ---------------------------------------------------------------------------
// C1-3 — revocation cascade
// ---------------------------------------------------------------------------

/**
 * Revoke ONE credential without touching its surface.
 * Returns the number of rows actually transitioned (0 if already revoked),
 * so a replay is observably a no-op rather than a silent success.
 */
export function revokeSurfaceCredential(
  db: Database.Database,
  credentialId: string,
  now: Date = new Date(),
): number {
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT c.surface_id AS surfaceId, s.principal_id AS principalId
           FROM surface_credentials c LEFT JOIN surfaces s ON s.surface_id = c.surface_id
          WHERE c.credential_id = ?`,
      )
      .get(credentialId) as { surfaceId: string; principalId: string | null } | undefined;
    if (!row) return 0;
    const info = db
      .prepare(
        `UPDATE surface_credentials SET state='revoked', revoked_at=?
          WHERE credential_id=? AND state='active'`,
      )
      .run(now.toISOString(), credentialId);
    if (Number(info.changes) > 0) {
      writeSurfaceAudit(
        db, 'surface_credential_revoked',
        { principalId: row.principalId, surfaceId: row.surfaceId, credentialId },
        {}, now,
      );
    }
    return Number(info.changes);
  });
  return tx() as number;
}

export interface RevokeSurfaceResult {
  surfaceRevoked: boolean;
  credentialsRevoked: number;
}

/**
 * REVOKE_SURFACE, collab side (§2.5): mark the surface revoked and cascade
 * every live credential to revoked IN ONE TRANSACTION. Cascading is what
 * makes A2 (revoked surface reconnects with a still-known token) fail at
 * the constant-cost credential gate rather than at a later, cheaper check.
 *
 * ORDERING ACROSS DATABASES IS THE CALLER'S JOB. §2.5/§1.4 require
 * deny-first: the gateway `state.db` deny/epoch bump must COMMIT BEFORE
 * this collab-side write runs. This function deliberately performs no
 * cross-WAL read or write, so it cannot silently violate that ordering;
 * the coordinator (`gateway/src/surfaceRevocation.ts`) sequences the two.
 * If this second commit fails, the gateway remains denied — the safe
 * direction — and recovery may finish only this bookkeeping.
 */
export function revokeSurface(
  db: Database.Database,
  surfaceId: string,
  now: Date = new Date(),
): RevokeSurfaceResult {
  const tx = db.transaction(() => {
    const surface = db
      .prepare('SELECT principal_id AS principalId, state FROM surfaces WHERE surface_id = ?')
      .get(surfaceId) as { principalId: string; state: string } | undefined;
    if (!surface) return { surfaceRevoked: false, credentialsRevoked: 0 };

    const surfaceInfo = db
      .prepare(`UPDATE surfaces SET state='revoked', revoked_at=? WHERE surface_id=? AND state='active'`)
      .run(now.toISOString(), surfaceId);

    const credInfo = db
      .prepare(
        `UPDATE surface_credentials SET state='revoked', revoked_at=?
          WHERE surface_id=? AND state='active'`,
      )
      .run(now.toISOString(), surfaceId);

    const surfaceRevoked = Number(surfaceInfo.changes) > 0;
    const credentialsRevoked = Number(credInfo.changes);
    if (surfaceRevoked || credentialsRevoked > 0) {
      writeSurfaceAudit(
        db, 'surface_revoked',
        { principalId: surface.principalId, surfaceId },
        { surfaceRevoked, credentialsRevoked }, now,
      );
    }
    return { surfaceRevoked, credentialsRevoked };
  });
  return tx() as RevokeSurfaceResult;
}
