/**
 * rollback.ts — Section 11 rollout/rollback for the Collaboration
 * Substrate, headless subset (Slice 5 / G1R scope).
 *
 * Two entry points:
 *
 *  - `performNormalRollback`: NON-destructive. Stops new v2 activity by
 *    closing every live subscription and session binding, disables the
 *    collaboration feature flags, and RETAINS every additive table
 *    untouched (Section 11: "retain additive tables, and restart Phase 1
 *    behavior"). Proves retention by (a) checking every collab_ prefixed
 *    table plus principals/principal_credentials still exists, and (b)
 *    checksumming a caller-supplied Phase-1 fixture row set before and
 *    after, asserting byte-identity (M3).
 *
 *  - `performDestructiveRestore`: LAST-RESORT, data-destroying. Five
 *    ordered preconditions gate the single destructive action; any failure
 *    aborts with the live DB byte-unchanged (checksummed proof, not just
 *    "we didn't call restore"). A TWO-PHASE receipt (C1) — INTENT written
 *    before the first destructive byte, COMPLETION written after — closes
 *    the crash-window gap the G1R review flagged. The confirmation string
 *    and backup-ID checksum are both exact-match, no normalization (C2).
 *
 * Everything here is pure/injectable: {db, registry, sessionRegistry,
 * clock, doctor, gatewayLiveness, backupTaker, receiptSink}. No real
 * socket, no operator UI — this is the headless rehearsal/logic layer the
 * gateway/UI slice will drive.
 */

import { createHash } from 'node:crypto';
import type { BootstrapDb, Clock } from './bootstrap.js';
import type { SubscriptionRegistry } from './subscriptions.js';
import { SESSION_CLOSE_REASONS, type SessionCloseReason } from './sessions.js';
import type { DoctorResult } from './doctor.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * The exhaustive set of feature flags Section 11 defines. All default
 * false; `performNormalRollback` sets every one to false unconditionally.
 */
export interface CollabFeatureFlags {
  TORQCLAW_COLLAB_IDENTITY: boolean;
  TORQCLAW_COLLAB_CHANNELS: boolean;
  TORQCLAW_COLLAB_LIVE: boolean;
  TORQCLAW_COLLAB_UI: boolean;
}

/**
 * (H1) A NAMED injected liveness probe. Rollback code may only ASSERT this
 * injected state — it never causes shutdown itself. A stub that always
 * returns 'down' would make the destructive-restore gate meaningless; the
 * refuse-when-live / proceed-when-down tests exist specifically to prove
 * this probe is load-bearing.
 */
export interface GatewayLivenessProbe {
  /** Returns the gateway's current liveness. MUST reflect real injected state, never a constant. */
  check(): 'up' | 'down';
}

/** A single full-state backup, identified and checksummed. */
export interface BackupRecord {
  backupId: string;
  /** SHA-256 hex checksum of the backup's full-state bytes, as recorded by the manifest / backupTaker. */
  checksum: string;
  takenAt: string;
}

/**
 * Takes a NEW full-state backup of the live database, returning its record.
 * (C2) The success of this call — including its checksum — is itself a
 * precondition of destructive restore proceeding; it must run BEFORE the
 * destructive write, never after/concurrently.
 */
export interface BackupTaker {
  takeFullStateBackup(): Promise<BackupRecord> | BackupRecord;
}

/**
 * The pre-migration backup manifest: the operator-selected backupId must
 * match this recorded checksum, not merely exist on disk (C2).
 */
export interface PreMigrationManifest {
  backupId: string;
  checksum: string;
}

/**
 * Secret-free durable external receipt sink (C1: two-phase). `writeIntent`
 * MUST be durable and MUST complete before the first destructive byte;
 * `writeCompletion` runs after restore + doctor. Both receipts are
 * checked/asserted to contain no secret material by the caller building
 * their payloads (this module never includes credential/pepper/token bytes
 * in any receipt field).
 */
export interface ReceiptSink {
  writeIntent(receipt: RestoreIntentReceipt): Promise<void> | void;
  writeCompletion(receipt: RestoreCompletionReceipt): Promise<void> | void;
}

export interface RestoreIntentReceipt {
  kind: 'restore_intent';
  backupIds: { selected: string; freshPreRestore: string };
  boundary: RestoreBoundary;
  typedConfirmation: string;
  preRestoreChecksum: string;
  timestamp: string;
  operatorAck: string;
}

export interface RestoreCompletionReceipt {
  kind: 'restore_completion';
  backupIds: { selected: string; freshPreRestore: string };
  boundary: RestoreBoundary;
  postRestoreChecksum: string;
  doctor: DoctorResult;
  timestamp: string;
}

/** The exact time/data-loss boundary (Section 11: "display of the exact time/data-loss boundary"). */
export interface RestoreBoundary {
  /** The pre-migration backup's captured-at timestamp — everything after this instant is discarded. */
  restoredToTimestamp: string;
  /** The instant destructive restore ran, i.e. the end of the discarded interval. */
  discardedThroughTimestamp: string;
}

export interface RollbackEnv {
  db: BootstrapDb;
  registry: SubscriptionRegistry;
  clock: Clock;
}

// ---------------------------------------------------------------------------
// Checksum helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex checksum over a canonical byte representation of a row set.
 * Callers supply the exact rows they want pinned (e.g. a Phase-1 fixture's
 * seed rows) as plain objects; this function orders keys deterministically
 * (via JSON.stringify of an array of [sortedEntries] tuples) so the same
 * logical row set always checksums identically regardless of property
 * insertion order.
 */
export function checksumRowSet(rows: ReadonlyArray<Record<string, unknown>>): string {
  const normalized = rows.map((row) => {
    const sortedKeys = Object.keys(row).sort();
    return sortedKeys.map((k) => [k, row[k]]);
  });
  const bytes = Buffer.from(JSON.stringify(normalized), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * SHA-256 hex checksum over an arbitrary byte buffer (used for whole-DB /
 * whole-backup checksums where the caller has raw bytes, e.g. a snapshot
 * file or an in-memory serialization).
 */
export function checksumBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// performNormalRollback (Section 11, non-destructive)
// ---------------------------------------------------------------------------

const ALL_COLLAB_TABLES = [
  'principals',
  'principal_credentials',
  'collab_channels',
  'collab_members',
  'collab_events',
  'collab_cursors',
  'collab_mutation_results',
  'collab_session_bindings',
  'collab_audit',
  'collab_installation',
  'collab_schema_migrations',
] as const;

export interface NormalRollbackFixtureRowSet {
  /** A caller-supplied set of table -> row-selector queries whose byte-identity must be proven before/after rollback. */
  describe(): ReadonlyArray<{ table: string; rows: ReadonlyArray<Record<string, unknown>> }>;
}

export interface NormalRollbackResult {
  closedSubscriptionCount: number;
  closedSessionBindingCount: number;
  flagsAfter: CollabFeatureFlags;
  /** (M3) Every collab_* + principals + principal_credentials table still present after rollback. */
  tablesRetained: boolean;
  missingTables: string[];
  /** (M3) Phase-1 fixture row-set checksum, captured before rollback ran. */
  fixtureChecksumBefore: string;
  /** (M3) Same fixture row-set, re-read and checksummed after rollback ran. */
  fixtureChecksumAfter: string;
  fixtureByteIdentical: boolean;
}

/**
 * Perform the Section 11 non-destructive normal rollback:
 *  1. (M2) close every active subscription in the registry with reason
 *     'socket_closed', delivering its close frame (the terminal frame per
 *     subscriptions.ts's construction).
 *  2. (M2) close every open session binding durably: closed_at + a
 *     'socket_closed' close_reason — the exact shape performStartup's
 *     orphan-closure uses in sessions.ts, so a subsequent healthy startup
 *     sees these sessions as already closed, not as orphans to reap again.
 *  3. Disable every collaboration flag (caller-supplied flags object; every
 *     field is forced false, regardless of its input value).
 *  4. RETAIN all additive tables — verified structurally (SELECT 1 FROM
 *     each) and verified against a caller-supplied Phase-1 fixture row set,
 *     checksummed before and after for byte-identity.
 *
 * This function never drops or truncates a table and never issues a DDL
 * statement. It is safe to call multiple times (idempotent: an
 * already-closed subscription/session is skipped without error).
 */
export function performNormalRollback(
  env: RollbackEnv,
  flags: CollabFeatureFlags,
  fixture: NormalRollbackFixtureRowSet
): NormalRollbackResult {
  const fixtureChecksumBefore = checksumFixture(env.db, fixture);

  // Step 1 (M2): close every active subscription, socket_closed, deliver
  // its close frame as the terminal frame — mirrors coordinator.ts's
  // post-commit-close + post-lock-deliver split, but driven directly since
  // rollback is not itself an authorization mutation (no write-lock
  // acquisition needed: this is a full-stop drain, not a per-command
  // revalidated close).
  let closedSubscriptionCount = 0;
  for (const sub of env.registry.allActive()) {
    if (sub.closed) continue;
    sub.close('socket_closed');
    sub.deliverCloseFrame();
    closedSubscriptionCount++;
  }

  // Step 2 (M2): close every open session binding durably, matching
  // performStartup's orphan-closure shape exactly (closed_at + close_reason
  // 'socket_closed').
  const closedSessionBindingCount = closeAllOpenSessionBindings(env.db, env.clock);

  // Step 3: disable every flag unconditionally.
  const flagsAfter: CollabFeatureFlags = {
    TORQCLAW_COLLAB_IDENTITY: false,
    TORQCLAW_COLLAB_CHANNELS: false,
    TORQCLAW_COLLAB_LIVE: false,
    TORQCLAW_COLLAB_UI: false,
  };
  void flags; // caller's input flags are intentionally ignored — rollback always forces all-off.

  // Step 4: retention proof.
  const missingTables: string[] = [];
  for (const table of ALL_COLLAB_TABLES) {
    if (!tableExists(env.db, table)) {
      missingTables.push(table);
    }
  }
  const tablesRetained = missingTables.length === 0;

  const fixtureChecksumAfter = checksumFixture(env.db, fixture);
  const fixtureByteIdentical = fixtureChecksumBefore === fixtureChecksumAfter;

  return {
    closedSubscriptionCount,
    closedSessionBindingCount,
    flagsAfter,
    tablesRetained,
    missingTables,
    fixtureChecksumBefore,
    fixtureChecksumAfter,
    fixtureByteIdentical,
  };
}

function checksumFixture(db: BootstrapDb, fixture: NormalRollbackFixtureRowSet): string {
  const described = fixture.describe();
  // Re-read each described table's rows fresh from the DB by primary-key-ish
  // natural identity is the caller's job (the fixture's `describe()` is
  // called both before and after rollback, and is expected to re-query the
  // db itself for "after" — see tests/collab/rollback.test.ts for the exact
  // fixture shape). Here we simply checksum whatever rows describe()
  // returned this call.
  const flattened: Record<string, unknown>[] = [];
  for (const { table, rows } of described) {
    for (const row of rows) {
      flattened.push({ __table: table, ...row });
    }
  }
  return checksumRowSet(flattened);
}

function tableExists(db: BootstrapDb, table: string): boolean {
  try {
    db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Close every currently-open collab_session_bindings row with the exact
 * same shape performStartup's orphan-closure uses (sessions.ts): closed_at
 * = now, close_reason = 'socket_closed'.
 */
function closeAllOpenSessionBindings(db: BootstrapDb, clock: Clock): number {
  const now = clock.next();
  const openBindings = db
    .prepare('SELECT session_id FROM collab_session_bindings WHERE closed_at IS NULL')
    .all() as Array<{ session_id: string }>;
  const reason: SessionCloseReason = 'socket_closed';
  if (!SESSION_CLOSE_REASONS.includes(reason)) {
    // Defensive totality; SESSION_CLOSE_REASONS is a compile-time constant
    // that always includes 'socket_closed', so this branch is unreachable.
    throw new Error('socket_closed is not a valid SessionCloseReason');
  }
  for (const b of openBindings) {
    db.prepare(
      'UPDATE collab_session_bindings SET closed_at = ?, close_reason = ? WHERE session_id = ? AND closed_at IS NULL'
    ).run(now, reason, b.session_id);
  }
  return openBindings.length;
}

// ---------------------------------------------------------------------------
// performDestructiveRestore (Section 11, last-resort, data-destroying)
// ---------------------------------------------------------------------------

/** The exact, byte-required confirmation string (C2). No trim/case-fold/NFC anywhere in this module. */
export const RESTORE_CONFIRMATION_STRING = 'RESTORE PRE-MIGRATION BACKUP AND DISCARD LATER DATA';

export type DestructiveRestorePreconditionFailure =
  | 'GATEWAY_LIVE'
  | 'CONFIRMATION_MISMATCH'
  | 'BACKUP_CHECKSUM_MISMATCH'
  | 'FRESH_BACKUP_FAILED'
  | 'GATEWAY_LIVE_TOCTOU';

export interface DestructiveRestoreInput {
  /** Raw, unmodified caller-supplied confirmation string. Compared with exact raw-byte ===, nothing else. */
  confirmation: string;
  /** Operator-selected backup ID to restore. */
  selectedBackupId: string;
  operatorAck: string;
}

export interface DestructiveRestoreDeps extends RollbackEnv {
  doctor: () => DoctorResult;
  gatewayLiveness: GatewayLivenessProbe;
  backupTaker: BackupTaker;
  receiptSink: ReceiptSink;
  /** The recorded pre-migration backup manifest (C2: checksum, not mere existence). */
  preMigrationManifest: PreMigrationManifest;
  /**
   * Performs the actual destructive restore of `selectedBackupId` onto the
   * live database, returning the post-restore full-state checksum. Called
   * ONLY after every precondition has passed and the INTENT receipt has
   * already been durably written. This is the single "first destructive
   * byte" action — everything before it in this module is read-only or
   * additive (the fresh backup is additive: it does not touch the live DB).
   */
  applyRestore: (selectedBackupId: string) => Promise<string> | string;
  /**
   * Look up a backup's checksum by ID, for validating `selectedBackupId`
   * against `preMigrationManifest` (C2: checksum-based, not existence-based
   * — a backup that exists but doesn't match the manifest's checksum is
   * rejected).
   */
  lookupBackupChecksum: (backupId: string) => string | undefined;
  /** The pre-migration backup's own captured-at timestamp, for the boundary display. */
  preMigrationBackupTimestamp: string;
}

export type DestructiveRestoreResult =
  | {
      ok: true;
      boundary: RestoreBoundary;
      freshBackup: BackupRecord;
      postRestoreChecksum: string;
      doctor: DoctorResult;
    }
  | {
      ok: false;
      failedPrecondition: DestructiveRestorePreconditionFailure;
      message: string;
    };

/**
 * Perform the Section 11 / G1R C1+C2 destructive pre-migration restore.
 *
 * Preconditions, evaluated STRICTLY IN ORDER, each aborting with the live
 * DB byte-unchanged (no write of any kind — not even a receipt — happens
 * before precondition (iv) completes successfully):
 *
 *  (i)   gatewayLiveness().check() must report 'down' — H1: a NAMED
 *        injected probe, refuse-when-live.
 *  (ii)  input.confirmation === RESTORE_CONFIRMATION_STRING, exact raw-byte
 *        equality — C2: no trim, no case-fold, no NFC.
 *  (iii) input.selectedBackupId's checksum (via lookupBackupChecksum) must
 *        equal preMigrationManifest.checksum for preMigrationManifest's own
 *        backupId — C2: checksum-validated, not mere existence. (The
 *        selected backup ID is also asserted to equal the manifest's
 *        pinned backupId, since a manifest names exactly one pre-migration
 *        backup.)
 *  (iv)  a NEW current full-state backup is taken via backupTaker; its
 *        success (and a non-empty checksum) is itself a precondition.
 *  (v)   the exact time/data-loss boundary is computed.
 *
 * Then, in strict order: (C1) write the durable INTENT receipt BEFORE the
 * first destructive byte; RE-ASSERT gatewayLiveness() down immediately
 * before the destructive write (no TOCTOU, precondition (i) re-run, not
 * cached); perform the restore; run doctor; write the COMPLETION receipt.
 */
export async function performDestructiveRestore(
  deps: DestructiveRestoreDeps,
  input: DestructiveRestoreInput
): Promise<DestructiveRestoreResult> {
  // (i) gateway liveness — refuse when live.
  if (deps.gatewayLiveness.check() !== 'down') {
    return {
      ok: false,
      failedPrecondition: 'GATEWAY_LIVE',
      message: 'Destructive restore refused: gateway liveness probe reports the gateway is not down.',
    };
  }

  // (ii) exact raw-byte confirmation string equality. No normalization of
  // any kind — a Buffer-level comparison so no JS string-level coercion
  // (e.g. implicit NFC normalization some environments perform) can sneak
  // in; this is stricter than `===` alone.
  const confirmationBytes = Buffer.from(input.confirmation, 'utf8');
  const expectedBytes = Buffer.from(RESTORE_CONFIRMATION_STRING, 'utf8');
  if (!confirmationBytes.equals(expectedBytes)) {
    return {
      ok: false,
      failedPrecondition: 'CONFIRMATION_MISMATCH',
      message: 'Destructive restore refused: confirmation string does not exactly match the required literal.',
    };
  }

  // (iii) backup ID validated by CHECKSUM against the recorded pre-migration
  // manifest, not mere existence.
  if (input.selectedBackupId !== deps.preMigrationManifest.backupId) {
    return {
      ok: false,
      failedPrecondition: 'BACKUP_CHECKSUM_MISMATCH',
      message: `Destructive restore refused: selected backup ID does not match the recorded pre-migration manifest's backup ID.`,
    };
  }
  const selectedChecksum = deps.lookupBackupChecksum(input.selectedBackupId);
  if (selectedChecksum === undefined || selectedChecksum !== deps.preMigrationManifest.checksum) {
    return {
      ok: false,
      failedPrecondition: 'BACKUP_CHECKSUM_MISMATCH',
      message: 'Destructive restore refused: selected backup checksum does not match the recorded pre-migration manifest.',
    };
  }

  // (iv) a NEW current full-state backup, taken FIRST, success+checksum a
  // precondition of proceeding. This backup is additive (does not touch the
  // live DB), so taking it does not itself count as "the first destructive
  // byte" — it runs strictly before that, and its own failure aborts with
  // the live DB still byte-unchanged.
  let freshBackup: BackupRecord;
  try {
    freshBackup = await deps.backupTaker.takeFullStateBackup();
  } catch (err) {
    return {
      ok: false,
      failedPrecondition: 'FRESH_BACKUP_FAILED',
      message: `Destructive restore refused: fresh full-state backup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!freshBackup || !freshBackup.checksum || freshBackup.checksum.length === 0) {
    return {
      ok: false,
      failedPrecondition: 'FRESH_BACKUP_FAILED',
      message: 'Destructive restore refused: fresh full-state backup did not produce a valid checksum.',
    };
  }

  // (v) the exact time/data-loss boundary.
  const nowIso = deps.clock.next();
  const boundary: RestoreBoundary = {
    restoredToTimestamp: deps.preMigrationBackupTimestamp,
    discardedThroughTimestamp: nowIso,
  };

  // All preconditions passed. Compute the pre-restore DB checksum for the
  // intent receipt (proves what state existed the instant before
  // destruction, independent of the fresh backup's own checksum).
  const preRestoreChecksum = checksumLiveDb(deps.db);

  // (C1) TWO-PHASE RECEIPT, phase 1: durable INTENT receipt, written BEFORE
  // the first destructive byte. Secret-free by construction — none of these
  // fields ever carry credential/pepper/token material.
  const intentReceipt: RestoreIntentReceipt = {
    kind: 'restore_intent',
    backupIds: { selected: input.selectedBackupId, freshPreRestore: freshBackup.backupId },
    boundary,
    typedConfirmation: input.confirmation,
    preRestoreChecksum,
    timestamp: nowIso,
    operatorAck: input.operatorAck,
  };
  await deps.receiptSink.writeIntent(intentReceipt);

  // Re-assert gateway liveness DOWN immediately before the destructive
  // write — no TOCTOU. This is a FRESH call to the probe, not a reuse of
  // the earlier (i) result, so any state change between (i) and now is
  // caught.
  if (deps.gatewayLiveness.check() !== 'down') {
    return {
      ok: false,
      failedPrecondition: 'GATEWAY_LIVE_TOCTOU',
      message: 'Destructive restore aborted: gateway liveness probe reports live on the immediate pre-destruction re-check.',
    };
  }

  // The single destructive action. Everything above this line is read-only
  // or additive (the fresh backup) plus one durable receipt write.
  const postRestoreChecksum = await deps.applyRestore(input.selectedBackupId);

  const doctorResult = deps.doctor();

  // (C1) TWO-PHASE RECEIPT, phase 2: COMPLETION receipt, written after
  // restore + doctor.
  const completionReceipt: RestoreCompletionReceipt = {
    kind: 'restore_completion',
    backupIds: { selected: input.selectedBackupId, freshPreRestore: freshBackup.backupId },
    boundary,
    postRestoreChecksum,
    doctor: doctorResult,
    timestamp: deps.clock.next(),
  };
  await deps.receiptSink.writeCompletion(completionReceipt);

  return {
    ok: true,
    boundary,
    freshBackup,
    postRestoreChecksum,
    doctor: doctorResult,
  };
}

/**
 * Compute a whole-live-DB checksum for the pre-restore receipt field. Reads
 * every row of every collab_ prefixed table plus principals/
 * principal_credentials (in a pinned table+column order) and checksums the
 * concatenation. This is the
 * "byte-unchanged" proof primitive tests use directly to assert
 * precondition failures leave the DB untouched.
 */
export function checksumLiveDb(db: BootstrapDb): string {
  const hash = createHash('sha256');
  for (const table of ALL_COLLAB_TABLES) {
    let rows: unknown[];
    try {
      rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    } catch {
      rows = [];
    }
    hash.update(table);
    hash.update(canonicalRowsBytes(rows));
  }
  return hash.digest('hex');
}

function canonicalRowsBytes(rows: unknown[]): Buffer {
  const normalized = rows.map((row) => {
    if (row === null || typeof row !== 'object') return row;
    const obj = row as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    return sortedKeys.map((k) => {
      const v = obj[k];
      // Buffers (BLOB columns) need explicit hex encoding — JSON.stringify
      // on a Buffer emits its {type:'Buffer',data:[...]} form, which is
      // fine for checksum stability but verbose; hex is more compact and
      // equally stable.
      if (Buffer.isBuffer(v)) return [k, v.toString('hex')];
      return [k, v];
    });
  });
  return Buffer.from(JSON.stringify(normalized), 'utf8');
}
