import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { doctor, COLLABORATION_MIGRATION_ID } from '../../packages/collab/src/doctor.js';
import { CollabObservability } from '../../packages/collab/src/observability.js';

function makeEnv(fixtureId: string) {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  const db: BootstrapDb = {
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const secretStore = new InMemorySecretStore();
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids(fixtureId);
  const rng = nodeRandomSource;
  const bootstrap = bootstrapOperator(
    { db, secretStore, clock, uuids, rng },
    { operatorDisplayName: 'Operator', installationId: `install-${fixtureId}`, schemaVersion: 1 }
  );
  return { sqlite, db, clock, bootstrap };
}

describe('doctor() — (L1) minimal headless doctor', () => {
  it('reports migrationApplied true and installationRowPresent true for a fully bootstrapped fixture', () => {
    const { db } = makeEnv('doctor-healthy');
    const result = doctor(db);
    expect(result.migrationApplied).toBe(true);
    expect(result.installationRowPresent).toBe(true);
    expect(result.pepperChecksOk).toBeUndefined(); // no peppers supplied
    expect(result.healthy).toBe(true);
  });

  it('verifies pepper checks correctly when peppers are supplied', () => {
    const { db, bootstrap } = makeEnv('doctor-peppers-ok');
    const result = doctor(db, { principalPepper: bootstrap.principalPepper, recoveryPepper: bootstrap.recoveryPepper });
    expect(result.pepperChecksOk).toBe(true);
    expect(result.healthy).toBe(true);
  });

  it('reports pepperChecksOk false and healthy false for a wrong-machine pepper', () => {
    const { db } = makeEnv('doctor-wrong-pepper');
    const wrongPrincipalPepper = Buffer.alloc(32, 0xff);
    const wrongRecoveryPepper = Buffer.alloc(32, 0xee);
    const result = doctor(db, { principalPepper: wrongPrincipalPepper, recoveryPepper: wrongRecoveryPepper });
    expect(result.pepperChecksOk).toBe(false);
    expect(result.healthy).toBe(false);
  });

  it('reports migrationApplied false when the migration id is absent', () => {
    const sqlite = new Database(':memory:');
    // Deliberately do NOT run the migration.
    sqlite.exec('CREATE TABLE collab_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const db: BootstrapDb = {
      prepare: (sql: string) => sqlite.prepare(sql),
      exec: (sql: string) => sqlite.exec(sql),
      transaction: (fn) => sqlite.transaction(fn) as never,
    };
    const result = doctor(db);
    expect(result.migrationApplied).toBe(false);
    expect(result.healthy).toBe(false);
  });

  it('reports installationRowPresent false when collab_installation is empty', () => {
    const sqlite = new Database(':memory:');
    runCollaborationMigration(sqlite);
    const db: BootstrapDb = {
      prepare: (sql: string) => sqlite.prepare(sql),
      exec: (sql: string) => sqlite.exec(sql),
      transaction: (fn) => sqlite.transaction(fn) as never,
    };
    const result = doctor(db);
    expect(result.migrationApplied).toBe(true);
    expect(result.installationRowPresent).toBe(false);
    expect(result.healthy).toBe(false);
  });

  it('records the correct migrationId constant matches the migration module', () => {
    expect(COLLABORATION_MIGRATION_ID).toBe('20260806_001_collaboration_v1');
  });

  it('(L2) records a doctor_healthy/doctor_unhealthy observability outcome when an observability instance is supplied', () => {
    const { db, bootstrap } = makeEnv('doctor-observability');
    const observability = new CollabObservability();
    doctor(db, { principalPepper: bootstrap.principalPepper, recoveryPepper: bootstrap.recoveryPepper }, observability);
    const snapshot = observability.snapshot();
    expect(snapshot.migrationRecoveryDoctorOutcomes['doctor_healthy']).toBe(1);
  });

  it('doctor() does not require an observability instance (optional, no throw)', () => {
    const { db } = makeEnv('doctor-no-observability');
    expect(() => doctor(db)).not.toThrow();
  });
});

describe('CollabObservability — (L2) migration/recovery/doctor outcomes + recovery-kit age', () => {
  it('accumulates counts per bounded outcome label', () => {
    const obs = new CollabObservability();
    obs.recordMigrationRecoveryDoctorOutcome('migration_applied');
    obs.recordMigrationRecoveryDoctorOutcome('recovery_kit_verified');
    obs.recordMigrationRecoveryDoctorOutcome('recovery_kit_verified');
    obs.recordMigrationRecoveryDoctorOutcome('doctor_healthy');

    const snapshot = obs.snapshot();
    expect(snapshot.migrationRecoveryDoctorOutcomes).toEqual({
      migration_applied: 1,
      recovery_kit_verified: 2,
      doctor_healthy: 1,
    });
  });

  it('records the most-recently-observed verified recovery-kit age', () => {
    const obs = new CollabObservability();
    expect(obs.snapshot().lastRecoveryKitAgeMsObserved).toBeUndefined();
    obs.recordRecoveryKitVerifiedAge(3600_000);
    expect(obs.snapshot().lastRecoveryKitAgeMsObserved).toBe(3600_000);
    obs.recordRecoveryKitVerifiedAge(7200_000);
    expect(obs.snapshot().lastRecoveryKitAgeMsObserved).toBe(7200_000);
  });
});
