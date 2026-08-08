/**
 * observability.ts — Section 13 in-memory counters for the live slice.
 *
 * Bounded-label counters only (Section 12: "Metrics use bounded labels
 * only; no principal, channel, token, address, or message text labels").
 * All numbers are exposed via `snapshot()` for tests and any future
 * metrics-exporter wiring; this module never persists anything and never
 * touches SQLite.
 */

export type ConnectOutcome = 'success' | 'auth_failed' | 'role_mismatch' | 'unsupported_protocol' | 'rate_limited';

export type AuthorizationDenialClass =
  | 'operator_global'
  | 'channel_owner'
  | 'channel_visible'
  | 'cursor_owner'
  | 'subscription_owner'
  | 'channel_enumerable';

/**
 * (L2, Slice 5 debt item) Section 13's "migration/recovery/doctor outcomes"
 * metric — bounded labels only, matching the module's existing discipline.
 * `migration_applied`/`migration_noop` distinguish a fresh apply from the
 * documented re-run no-op (migration.ts); `recovery_*` cover
 * verifyRecoveryKit's outcome classes; `doctor_healthy`/`doctor_unhealthy`
 * cover doctor.ts's structured result.
 */
export type MigrationRecoveryDoctorOutcome =
  | 'migration_applied'
  | 'migration_noop'
  | 'migration_failed'
  | 'recovery_kit_verified'
  | 'recovery_kit_wrong_passphrase'
  | 'recovery_kit_wrong_installation'
  | 'recovery_kit_corrupted'
  | 'recovery_kit_invalid_format'
  | 'doctor_healthy'
  | 'doctor_unhealthy';

export interface LatencySample {
  ms: number;
}

/**
 * A minimal percentile-capable latency accumulator. Not a full histogram
 * library — sufficient for test assertions and Section 15-style
 * nearest-rank percentile reporting over an in-memory sample array.
 */
class LatencyRecorder {
  private samples: number[] = [];

  record(ms: number): void {
    this.samples.push(ms);
  }

  get count(): number {
    return this.samples.length;
  }

  /** Nearest-rank percentile (Section 15's convention), p in [0,100]. */
  percentile(p: number): number | undefined {
    if (this.samples.length === 0) return undefined;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
    return sorted[idx];
  }

  reset(): void {
    this.samples = [];
  }
}

export class CollabObservability {
  // Connect outcomes by bounded reason.
  private readonly connectOutcomes = new Map<ConnectOutcome, number>();

  // Authorization denials by command class.
  private readonly authorizationDenials = new Map<AuthorizationDenialClass, number>();

  // Active/backlog/closed subscription gauges — maintained as running
  // counts, incremented/decremented by explicit calls (not derived from a
  // registry scan) so this module has zero dependency on subscriptions.ts.
  private activeSubscriptions = 0;
  private backlogSubscriptions = 0;
  private closedSubscriptions = 0;

  // Slow-consumer closes.
  private slowConsumerCloses = 0;

  // Latency recorders.
  readonly revocationToLastWriteBoundary = new LatencyRecorder();
  readonly timelineLatency = new LatencyRecorder();
  readonly commitLatency = new LatencyRecorder();
  readonly fanoutLatency = new LatencyRecorder();

  // Queue bytes/age snapshots (most-recently-observed, per Section 13:
  // "queue bytes/age").
  private lastQueueBytesObserved = 0;
  private lastQueueAgeMsObserved = 0;

  // (L2) migration/recovery/doctor outcomes by bounded label.
  private readonly migrationRecoveryDoctorOutcomes = new Map<MigrationRecoveryDoctorOutcome, number>();

  // (L2) verified recovery-kit age (ms), most-recently-observed — Section
  // 13: "verified recovery-kit age". Set only when a kit is actually
  // verified (recordRecoveryKitVerifiedAge); undefined until then.
  private lastRecoveryKitAgeMsObserved: number | undefined;

  recordConnectOutcome(outcome: ConnectOutcome): void {
    this.connectOutcomes.set(outcome, (this.connectOutcomes.get(outcome) ?? 0) + 1);
  }

  /** (L2) Record one migration/recovery/doctor outcome occurrence. */
  recordMigrationRecoveryDoctorOutcome(outcome: MigrationRecoveryDoctorOutcome): void {
    this.migrationRecoveryDoctorOutcomes.set(outcome, (this.migrationRecoveryDoctorOutcomes.get(outcome) ?? 0) + 1);
  }

  /** (L2) Record the age (ms, verifiedAt - kitCreatedAt) of a just-verified recovery kit. */
  recordRecoveryKitVerifiedAge(ageMs: number): void {
    this.lastRecoveryKitAgeMsObserved = ageMs;
  }

  recordAuthorizationDenial(cls: AuthorizationDenialClass): void {
    this.authorizationDenials.set(cls, (this.authorizationDenials.get(cls) ?? 0) + 1);
  }

  markSubscriptionBacklog(): void {
    this.backlogSubscriptions++;
  }

  markSubscriptionLive(): void {
    if (this.backlogSubscriptions > 0) this.backlogSubscriptions--;
    this.activeSubscriptions++;
  }

  markSubscriptionClosed(wasActive: boolean): void {
    if (wasActive) {
      if (this.activeSubscriptions > 0) this.activeSubscriptions--;
    } else {
      if (this.backlogSubscriptions > 0) this.backlogSubscriptions--;
    }
    this.closedSubscriptions++;
  }

  recordSlowConsumerClose(): void {
    this.slowConsumerCloses++;
  }

  observeQueue(bytes: number, ageMs: number): void {
    this.lastQueueBytesObserved = bytes;
    this.lastQueueAgeMsObserved = ageMs;
  }

  /**
   * (M1) Record a revocation-to-last-write-boundary latency sample,
   * measured SQLite-commit-return -> write-lock-release-after-purge,
   * excluding pre-commit writes. Callers compute the delta themselves
   * (coordinator.ts) using the injected clock; this method only records.
   */
  recordRevocationLatency(ms: number): void {
    this.revocationToLastWriteBoundary.record(ms);
  }

  snapshot(): {
    connectOutcomes: Record<string, number>;
    authorizationDenials: Record<string, number>;
    subscriptions: { active: number; backlog: number; closed: number };
    slowConsumerCloses: number;
    lastQueueBytesObserved: number;
    lastQueueAgeMsObserved: number;
    revocationLatencyP95: number | undefined;
    timelineLatencyP95: number | undefined;
    commitLatencyP95: number | undefined;
    fanoutLatencyP95: number | undefined;
    migrationRecoveryDoctorOutcomes: Record<string, number>;
    lastRecoveryKitAgeMsObserved: number | undefined;
  } {
    return {
      connectOutcomes: Object.fromEntries(this.connectOutcomes),
      authorizationDenials: Object.fromEntries(this.authorizationDenials),
      subscriptions: {
        active: this.activeSubscriptions,
        backlog: this.backlogSubscriptions,
        closed: this.closedSubscriptions,
      },
      slowConsumerCloses: this.slowConsumerCloses,
      lastQueueBytesObserved: this.lastQueueBytesObserved,
      lastQueueAgeMsObserved: this.lastQueueAgeMsObserved,
      revocationLatencyP95: this.revocationToLastWriteBoundary.percentile(95),
      timelineLatencyP95: this.timelineLatency.percentile(95),
      commitLatencyP95: this.commitLatency.percentile(95),
      fanoutLatencyP95: this.fanoutLatency.percentile(95),
      migrationRecoveryDoctorOutcomes: Object.fromEntries(this.migrationRecoveryDoctorOutcomes),
      lastRecoveryKitAgeMsObserved: this.lastRecoveryKitAgeMsObserved,
    };
  }
}
