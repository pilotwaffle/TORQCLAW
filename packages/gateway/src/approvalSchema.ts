/**
 * C2-1 — strictly additive approval-broker migration.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §1.5, §3.1, §6.2, §10.3 (STATE_DB_MAP_V4).
 *
 * WHAT THIS IS ALLOWED TO DO, AND NOTHING ELSE
 * --------------------------------------------
 * `tool_approvals` shipped at the frozen baseline and is CANONICAL for
 * approval state. Revision 4 of the PRD exists specifically because an
 * earlier revision proposed rebuilding it; that was rejected. So this
 * module may only:
 *
 *   1. add exactly SIX nullable columns to `tool_approvals`, each guarded by
 *      `PRAGMA table_info` (storage.ts:107-111 precedent), and
 *   2. add exactly ONE index, `idx_tool_approvals_status_expires`, and
 *   3. `CREATE TABLE IF NOT EXISTS` the three additive C2 sidecars.
 *
 * It must NOT rebuild the table, backfill, rewrite history, change rowids,
 * add a default or a constraint to an existing column, or move approval
 * truth into a sidecar. Legacy rows stay valid and NULL in all six
 * additions -- which is exactly why every addition is nullable with no
 * DEFAULT: a DEFAULT would rewrite the meaning of every historical row.
 *
 * THE IF-NOT-EXISTS TRAP (§6.2, called out because it has bitten before)
 * ----------------------------------------------------------------------
 * An existing DB never re-runs `CREATE TABLE IF NOT EXISTS`, so editing a
 * CREATE never adds a column to a live database. Every post-first-ship
 * column MUST be a guarded ALTER. That is why the six columns below go
 * through `addStateColumnIfMissing` rather than being edited into
 * schema.sql's `tool_approvals` DDL.
 *
 * WHY `status` GAINS 'expired' WITHOUT A DDL CHANGE (§3.1, CT-3)
 * --------------------------------------------------------------
 * The shipped table declares `status TEXT NOT NULL DEFAULT 'pending'` with
 * NO CHECK constraint, so writing 'expired' needs no table rebuild. The
 * absence of a DDL CHECK is precisely why the state machine has exactly ONE
 * centralized writer (M-1/M-2, approvalWriter.ts) and why that writer is
 * pinned by mutation tests instead of by the schema.
 */

import type Database from 'better-sqlite3';
import { addStateColumnIfMissing } from './surfaceSecurity.js';

/**
 * The six nullable additions to canonical `tool_approvals` (§3.1).
 *
 * Exported as data, not inlined, so the migration test can assert the count
 * and names are EXACTLY these six -- a seventh column added without review
 * turns that test red rather than sliding in silently.
 */
export const TOOL_APPROVAL_C2_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['origin_principal_id', 'TEXT'],
  ['origin_surface_id', 'TEXT'],
  ['decided_principal_id', 'TEXT'],
  ['decided_surface_id', 'TEXT'],
  ['expires_at', 'DATETIME'],
  ['context_hash', 'TEXT'],
];

/**
 * Additive C2 state.db migration. Idempotent: a repeat run adds nothing and
 * changes nothing, which is what makes an interrupted migration safe to
 * simply re-run.
 */
export function ensureApprovalBrokerSchema(db: Database.Database): void {
  // ── 1. The six guarded nullable columns on the EXISTING physical table ──
  for (const [name, type] of TOOL_APPROVAL_C2_COLUMNS) {
    addStateColumnIfMissing(db, 'tool_approvals', name, type);
  }

  // ── 2. The one declared index (§3.1, §6.10) ──
  // Serves the centralized writer's two hot predicates: the expiry sweep
  // (`status='pending' AND expires_at<=now`) and the decision-eligibility
  // read. Declared in the PRD's map as the ONLY new approval index.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_approvals_status_expires
             ON tool_approvals(status, expires_at)`);

  // ── 3. The additive C2 sidecars ──
  //
  // NOTE ON FOREIGN KEYS: the PRD's DDL declares FKs to `tasks`,
  // `gateway_task_origins`, `gateway_profile_delegations` and
  // `surface_authorities`. They are reproduced verbatim below. All four
  // targets live in state.db -- there is deliberately NO cross-database FK
  // (§10.3 `cross_database_fk: forbidden`), because collab.db is a separate
  // SQLite file with its own WAL and SQLite cannot enforce across them.
  db.exec(`
-- Immutable registration facts only. Carries NO status and NO decision
-- fields: approval STATE lives on canonical tool_approvals and nowhere
-- else (§6.5 -- a second approval state machine FAILS review).
CREATE TABLE IF NOT EXISTS gateway_approval_bindings (
    approval_id       TEXT PRIMARY KEY,
    request_id        TEXT NOT NULL,
    action_hash_version TEXT NOT NULL CHECK (action_hash_version = 'ACTIONHASH_V1'),
    action_hash       TEXT NOT NULL,
    canonical_args_hash TEXT NOT NULL,
    registration_context_hash TEXT NOT NULL,
    delegation_id    TEXT NOT NULL,
    profile_delegation_revision INTEGER NOT NULL,
    registered_profile_id TEXT NOT NULL,
    registered_profile_version INTEGER NOT NULL,
    registered_tool_registry_version TEXT NOT NULL,
    registered_effective_profile_policy_hash TEXT NOT NULL,
    registered_capability_revision INTEGER NOT NULL,
    registered_registry_enforcement_hash TEXT NOT NULL,
    registered_privacy_context_hash TEXT NOT NULL,
    registered_routing_context_hash TEXT NOT NULL,
    registered_security_policy_hash TEXT NOT NULL,
    registered_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id),
    FOREIGN KEY (request_id) REFERENCES tasks(request_id),
    FOREIGN KEY (delegation_id) REFERENCES gateway_profile_delegations(delegation_id)
);

-- One exact-action, one-shot grant, created ONLY by the winning APPROVE
-- transaction (§1.4). The approval_id UNIQUE constraint is the structural
-- one-shot guarantee: one approval can never mint two grants, so a replayed
-- APPROVE cannot produce a second consumable side-effect licence.
-- dispatch_request_id UNIQUE is the same guarantee on the other end --
-- the server-minted dispatch task is single-use and referential.
CREATE TABLE IF NOT EXISTS gateway_action_grants (
    grant_id          TEXT PRIMARY KEY,
    approval_id       TEXT NOT NULL UNIQUE,
    source_request_id TEXT NOT NULL,
    dispatch_request_id TEXT NOT NULL UNIQUE,
    tool_name         TEXT NOT NULL,
    action_hash       TEXT NOT NULL,
    context_hash      TEXT NOT NULL,
    origin_surface_id TEXT NOT NULL,
    deciding_surface_id TEXT NOT NULL,
    origin_auth_epoch INTEGER NOT NULL,
    deciding_auth_epoch INTEGER NOT NULL,
    origin_capability_revision INTEGER NOT NULL,
    delegation_id    TEXT NOT NULL,
    profile_delegation_revision INTEGER NOT NULL,
    deciding_authority_grant_id TEXT NOT NULL,
    effective_profile_policy_hash TEXT NOT NULL,
    registry_enforcement_hash TEXT NOT NULL,
    expires_at        DATETIME NOT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    consumed_at       DATETIME,
    revoked_at        DATETIME,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id),
    FOREIGN KEY (delegation_id) REFERENCES gateway_profile_delegations(delegation_id),
    FOREIGN KEY (deciding_authority_grant_id) REFERENCES surface_authorities(grant_id)
);
CREATE INDEX IF NOT EXISTS idx_gateway_action_grants_dispatch
    ON gateway_action_grants(dispatch_request_id);

-- C2: durable delivery PROJECTION. NOT approval truth. Rebuildable from
-- tool_approvals (+ routing). Droppable -- modeled on run_receipts
-- (schema.sql §9). A row here NEVER authorizes or represents a decision,
-- which is what makes property 5 structural: the delivery writer has no
-- code route to tool_approvals.status.
--
-- Unlike tool_approvals, this table is NEW, so it CAN carry its state CHECK
-- from first ship -- and does (§3.1 closing note).
CREATE TABLE IF NOT EXISTS approval_deliveries (
    id                TEXT PRIMARY KEY,
    approval_id       TEXT NOT NULL,
    target_surface_id TEXT NOT NULL,
    delivery_state    TEXT NOT NULL DEFAULT 'pending'
                        CHECK (delivery_state IN ('pending','delivered','acked','failed')),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id)
);
CREATE INDEX IF NOT EXISTS idx_approval_deliveries_approval ON approval_deliveries(approval_id);
CREATE INDEX IF NOT EXISTS idx_approval_deliveries_target_state
    ON approval_deliveries(target_surface_id, delivery_state);
  `);
}
