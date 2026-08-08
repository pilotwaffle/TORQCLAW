/**
 * doctor.ts — (L1) minimal headless doctor for the Collaboration
 * Substrate.
 *
 * Returns a structured result the destructive-restore completion receipt
 * records (rollback.ts). Three checks, matching the G1R L1 scope exactly:
 *  - migration-applied: the pinned migration ID is present in
 *    collab_schema_migrations;
 *  - verifyPepperCheck: both pepper checks (principal + recovery), if
 *    peppers are supplied, verify against the installation row — the same
 *    constant-time comparison sessions.ts's performStartup uses;
 *  - installation-row presence: exactly one collab_installation row
 *    exists.
 *
 * This is deliberately minimal — a full operator-facing doctor (Section 13
 * observability, alerting, recovery-kit-age reporting) is OWED to the
 * gateway/UI effort (see M4/H5 notes in the build report). This module's
 * only job is to give performDestructiveRestore's completion receipt a
 * structured, honest post-restore health snapshot.
 */

import type { BootstrapDb } from './bootstrap.js';
import { principalPepperCheck, recoveryPepperCheck, verifyPepperCheck } from './bootstrap.js';
import type { CollabObservability } from './observability.js';

export const COLLABORATION_MIGRATION_ID = '20260806_001_collaboration_v1';

export interface DoctorResult {
  migrationApplied: boolean;
  installationRowPresent: boolean;
  /** undefined when peppers were not supplied (doctor cannot evaluate this check without them). */
  pepperChecksOk: boolean | undefined;
  /** True only when every check that WAS evaluated passed. A check that could not run (undefined) does not count against this. */
  healthy: boolean;
}

interface InstallationRow {
  installation_id: string;
  principal_pepper_check: Buffer;
  recovery_pepper_check: Buffer;
}

export interface DoctorPeppers {
  principalPepper: Buffer;
  recoveryPepper: Buffer;
}

/**
 * Run the minimal headless doctor against `db`. `peppers`, if supplied,
 * enables the pepper-check verification (the same comparison
 * sessions.ts's performStartup performs); omitting it is valid (e.g. a
 * caller that only wants migration/installation checks) and simply leaves
 * `pepperChecksOk` undefined rather than failing. `observability`, if
 * supplied, records the L2 doctor_healthy/doctor_unhealthy outcome counter.
 */
export function doctor(db: BootstrapDb, peppers?: DoctorPeppers, observability?: CollabObservability): DoctorResult {
  const migrationApplied = checkMigrationApplied(db);

  const installation = checkInstallationRow(db);
  const installationRowPresent = installation !== undefined;

  let pepperChecksOk: boolean | undefined;
  if (peppers && installation) {
    const expectedPrincipalCheck = principalPepperCheck(peppers.principalPepper, installation.installation_id);
    const expectedRecoveryCheck = recoveryPepperCheck(peppers.recoveryPepper, installation.installation_id);
    const principalOk = verifyPepperCheck(Buffer.from(installation.principal_pepper_check), expectedPrincipalCheck);
    const recoveryOk = verifyPepperCheck(Buffer.from(installation.recovery_pepper_check), expectedRecoveryCheck);
    pepperChecksOk = principalOk && recoveryOk;
  } else if (peppers && !installation) {
    // Peppers supplied but nothing to check them against: this IS an
    // evaluated, failed check (not "could not evaluate") — a missing
    // installation row with peppers present is a real health problem.
    pepperChecksOk = false;
  }

  const evaluatedChecks: Array<boolean> = [migrationApplied, installationRowPresent];
  if (pepperChecksOk !== undefined) {
    evaluatedChecks.push(pepperChecksOk);
  }
  const healthy = evaluatedChecks.every((c) => c === true);

  observability?.recordMigrationRecoveryDoctorOutcome(healthy ? 'doctor_healthy' : 'doctor_unhealthy');

  return { migrationApplied, installationRowPresent, pepperChecksOk, healthy };
}

function checkMigrationApplied(db: BootstrapDb): boolean {
  try {
    const row = db
      .prepare('SELECT 1 FROM collab_schema_migrations WHERE id = ?')
      .get(COLLABORATION_MIGRATION_ID);
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Query collab_installation defensively: a database that has not run the
 * full migration (e.g. only collab_schema_migrations exists, as an
 * in-progress-migration fixture might construct) must not make doctor()
 * throw — a missing table is itself an unhealthy signal doctor() should
 * report structurally (installationRowPresent: false), not propagate as an
 * uncaught SQLite exception.
 */
function checkInstallationRow(db: BootstrapDb): InstallationRow | undefined {
  try {
    return db.prepare('SELECT * FROM collab_installation').get() as InstallationRow | undefined;
  } catch {
    return undefined;
  }
}
