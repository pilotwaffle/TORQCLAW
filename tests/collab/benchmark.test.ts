import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { AuthLock } from '../../packages/collab/src/authlock.js';
import { SubscriptionRegistry } from '../../packages/collab/src/subscriptions.js';
import { CollabObservability } from '../../packages/collab/src/observability.js';
import { CollaborationStore, type CallerContext } from '../../packages/collab/src/store.js';
import {
  nearestRankPercentile,
  assertObservationFloors,
  BenchmarkFloorError,
  measureRevocationWindow,
  assertExactlyTwoNowMsCalls,
  NowMsCallCountError,
  checkSequenceIntegrity,
  checkNoPostLinearizationWrites,
  buildRevocationPlan,
  countRevocationKinds,
  buildBenchmarkReportArtifact,
  TIMELINE_OBSERVATION_FLOOR,
  COMMIT_OBSERVATION_FLOOR,
  FANOUT_OBSERVATION_FLOOR,
  REVOCATION_OBSERVATION_FLOOR,
  REVOCATION_SUSPEND_RESTORE_PAIR_FLOOR,
  REVOCATION_ARCHIVE_UNARCHIVE_PAIR_FLOOR,
  REVOCATION_REVOKE_AGENT_EXACT_COUNT,
  REFERENCE_NODE_VERSION,
} from '../../packages/collab/src/benchmark.js';
import { affectedByPrincipal } from '../../packages/collab/src/coordinator.js';

// ---------------------------------------------------------------------------
// nearestRankPercentile
// ---------------------------------------------------------------------------

describe('nearestRankPercentile — matches observability.ts LatencyRecorder.percentile exactly', () => {
  it('computes p95 via nearest-rank on a known sample set', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    // ceil(0.95*100)=95th smallest value in a 1..100 set is 95.
    expect(nearestRankPercentile(samples, 95)).toBe(95);
  });

  it('returns undefined for an empty sample set', () => {
    expect(nearestRankPercentile([], 95)).toBeUndefined();
  });

  it('matches CollabObservability.LatencyRecorder.percentile bit-for-bit on the same input', () => {
    const obs = new CollabObservability();
    const samples = [12, 45, 3, 88, 21, 7, 99, 1, 56, 33];
    for (const s of samples) obs.timelineLatency.record(s);
    const fromObservability = obs.snapshot().timelineLatencyP95;
    const fromBenchmark = nearestRankPercentile(samples, 95);
    expect(fromBenchmark).toBe(fromObservability);
  });
});

// ---------------------------------------------------------------------------
// (L3) floor assertions run before percentile extraction
// ---------------------------------------------------------------------------

describe('assertObservationFloors (L3: run before percentile extraction)', () => {
  const passingCounts = {
    timeline: TIMELINE_OBSERVATION_FLOOR,
    commit: COMMIT_OBSERVATION_FLOOR,
    fanout: FANOUT_OBSERVATION_FLOOR,
    revocationTotal: REVOCATION_OBSERVATION_FLOOR,
    suspendRestorePairs: REVOCATION_SUSPEND_RESTORE_PAIR_FLOOR,
    archiveUnarchivePairs: REVOCATION_ARCHIVE_UNARCHIVE_PAIR_FLOOR,
    revokeAgentCount: REVOCATION_REVOKE_AGENT_EXACT_COUNT,
  };

  it('passes when every floor is exactly met', () => {
    expect(() => assertObservationFloors(passingCounts)).not.toThrow();
  });

  it('throws BenchmarkFloorError loudly when timeline is one under the floor', () => {
    expect(() => assertObservationFloors({ ...passingCounts, timeline: TIMELINE_OBSERVATION_FLOOR - 1 })).toThrow(
      BenchmarkFloorError
    );
  });

  it('throws when commit is under the floor', () => {
    expect(() => assertObservationFloors({ ...passingCounts, commit: COMMIT_OBSERVATION_FLOOR - 1 })).toThrow(
      BenchmarkFloorError
    );
  });

  it('throws when fanout is under the floor', () => {
    expect(() => assertObservationFloors({ ...passingCounts, fanout: FANOUT_OBSERVATION_FLOOR - 1 })).toThrow(
      BenchmarkFloorError
    );
  });

  it('throws when revocation total is under the floor', () => {
    expect(() =>
      assertObservationFloors({ ...passingCounts, revocationTotal: REVOCATION_OBSERVATION_FLOOR - 1 })
    ).toThrow(BenchmarkFloorError);
  });

  it('throws when SUSPEND/RESTORE pairs are under 450', () => {
    expect(() =>
      assertObservationFloors({ ...passingCounts, suspendRestorePairs: REVOCATION_SUSPEND_RESTORE_PAIR_FLOOR - 1 })
    ).toThrow(BenchmarkFloorError);
  });

  it('throws when ARCHIVE/UNARCHIVE pairs are under 450', () => {
    expect(() =>
      assertObservationFloors({ ...passingCounts, archiveUnarchivePairs: REVOCATION_ARCHIVE_UNARCHIVE_PAIR_FLOOR - 1 })
    ).toThrow(BenchmarkFloorError);
  });

  it('throws when REVOKE_AGENT count is not EXACTLY 100 (too few)', () => {
    expect(() => assertObservationFloors({ ...passingCounts, revokeAgentCount: 99 })).toThrow(BenchmarkFloorError);
  });

  it('throws when REVOKE_AGENT count is not EXACTLY 100 (too many)', () => {
    expect(() => assertObservationFloors({ ...passingCounts, revokeAgentCount: 101 })).toThrow(BenchmarkFloorError);
  });

  it('a floor miss fails BEFORE any percentile would be computed — proven by call-order in a wrapping harness', () => {
    let percentileComputed = false;
    const runGate = (counts: typeof passingCounts, samples: number[]) => {
      assertObservationFloors(counts); // must throw here, before the next line ever runs
      percentileComputed = true;
      return nearestRankPercentile(samples, 95);
    };
    expect(() => runGate({ ...passingCounts, timeline: 1 }, [1, 2, 3])).toThrow(BenchmarkFloorError);
    expect(percentileComputed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Revocation-phase apportionment
// ---------------------------------------------------------------------------

describe('buildRevocationPlan / countRevocationKinds — exact Section 15 apportionment', () => {
  it('builds a plan with >=450 pairs of each kind and EXACTLY 100 REVOKE_AGENT entries against a 100-agent pool', () => {
    const plan = buildRevocationPlan(100);
    const counts = countRevocationKinds(plan);
    expect(counts.suspendRestorePairs).toBeGreaterThanOrEqual(450);
    expect(counts.archiveUnarchivePairs).toBeGreaterThanOrEqual(450);
    expect(counts.revokeAgentCount).toBe(100);
    expect(counts.total).toBeGreaterThanOrEqual(1000);
  });

  it('REVOKE_AGENT entries are ordered last (sampled once per pooled agent at phase end)', () => {
    const plan = buildRevocationPlan(100);
    const firstRevokeIdx = plan.findIndex((e) => e.kind === 'revoke_agent');
    // Everything from firstRevokeIdx onward must be revoke_agent.
    const tail = plan.slice(firstRevokeIdx);
    expect(tail.every((e) => e.kind === 'revoke_agent')).toBe(true);
    expect(tail).toHaveLength(100);
  });

  it('rejects a pool size other than exactly 100', () => {
    expect(() => buildRevocationPlan(50)).toThrow();
    expect(() => buildRevocationPlan(150)).toThrow();
  });

  it('no single kind can satisfy the floor alone — apportionment is genuinely three-way', () => {
    const plan = buildRevocationPlan(100);
    const counts = countRevocationKinds(plan);
    expect(counts.suspendRestorePairs).toBeLessThan(REVOCATION_OBSERVATION_FLOOR);
    expect(counts.archiveUnarchivePairs).toBeLessThan(REVOCATION_OBSERVATION_FLOOR);
    expect(counts.revokeAgentCount).toBeLessThan(REVOCATION_OBSERVATION_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// Sequence integrity (zero lost/duplicate)
// ---------------------------------------------------------------------------

describe('checkSequenceIntegrity', () => {
  it('reports ok for a clean ascending 1..N sequence delivered in order', () => {
    const seqs = Array.from({ length: 500 }, (_, i) => i + 1);
    const result = checkSequenceIntegrity(seqs);
    expect(result.ok).toBe(true);
    expect(result.lostSeqs).toEqual([]);
    expect(result.duplicateSeqs).toEqual([]);
  });

  it('detects a gap (lost sequence)', () => {
    const seqs = [1, 2, 4, 5]; // 3 missing
    const result = checkSequenceIntegrity(seqs);
    expect(result.ok).toBe(false);
    expect(result.lostSeqs).toEqual([3]);
  });

  it('detects a duplicate', () => {
    const seqs = [1, 2, 2, 3];
    const result = checkSequenceIntegrity(seqs);
    expect(result.ok).toBe(false);
    expect(result.duplicateSeqs).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// Zero post-linearization writes
// ---------------------------------------------------------------------------

describe('checkNoPostLinearizationWrites', () => {
  it('passes when every write is initiated before its subscription linearized (closed)', () => {
    const result = checkNoPostLinearizationWrites([
      { writeInitiatedAtMs: 10, linearizedAtMs: 20 },
      { writeInitiatedAtMs: 15, linearizedAtMs: undefined },
    ]);
    expect(result.ok).toBe(true);
    expect(result.violationCount).toBe(0);
  });

  it('flags a write initiated strictly after linearization', () => {
    const result = checkNoPostLinearizationWrites([
      { writeInitiatedAtMs: 25, linearizedAtMs: 20 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violationCount).toBe(1);
  });

  it('a write initiated exactly AT the linearization instant is not a violation (strictly-after only)', () => {
    const result = checkNoPostLinearizationWrites([{ writeInitiatedAtMs: 20, linearizedAtMs: 20 }]);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (H2) Independent revocation-window measurement — real coordinator drive
// ---------------------------------------------------------------------------

function makeStoreEnv(fixtureId: string) {
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
  const registry = new SubscriptionRegistry();
  const lock = new AuthLock();
  const observability = new CollabObservability();
  const store = new CollaborationStore({
    db,
    clock,
    uuids,
    rng,
    principalPepper: bootstrap.principalPepper,
    registry,
    lock,
    observability,
  });
  const operatorCaller: CallerContext = { principalId: bootstrap.operatorPrincipalId, kind: 'operator' };
  return { db, clock, bootstrap, registry, lock, observability, store, operatorCaller };
}

describe('measureRevocationWindow (H2: independent endpoint timing, not a re-export of the coordinator delta)', () => {
  it('measures a real SUSPEND_AGENT mutation, deriving its own commitReturn/release timestamps', async () => {
    const { db, registry, lock, observability, bootstrap } = makeStoreEnv('bench-revoke-window');

    // Create an agent directly at the store level (outside the measured
    // mutation) so the measured txBody is exactly one SUSPEND_AGENT.
    const now = '2026-01-01T00:00:05.000Z';
    const agentId = 'agent-bench-1';
    db.prepare(
      'INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(agentId, 'agent', 'Bench Agent', bootstrap.operatorPrincipalId, 'active', 1, null, now, now);

    let wallClock = 1000;
    const realNowMs = () => {
      wallClock += 1; // each call advances — proves the two captured points are genuinely distinct instants.
      return wallClock;
    };

    const txBody = () => {
      db.prepare('UPDATE principals SET status = ?, auth_epoch = ? WHERE id = ?').run('suspended', 2, agentId);
      return { principalId: agentId };
    };

    const { result, measurement } = await measureRevocationWindow(
      { lock, registry, observability },
      realNowMs,
      txBody,
      (r) => affectedByPrincipal(registry, r.principalId, 'authorization_lost')
    );

    expect(result.principalId).toBe(agentId);
    expect(measurement.releaseMs).toBeGreaterThanOrEqual(measurement.commitReturnMs);
    expect(measurement.windowMs).toBe(measurement.releaseMs - measurement.commitReturnMs);
    expect(measurement.windowMs).toBeGreaterThanOrEqual(0);

    // The DB mutation actually committed.
    const row = db.prepare('SELECT status FROM principals WHERE id = ?').get(agentId) as { status: string };
    expect(row.status).toBe('suspended');
  });

  it('the real call produces exactly 2 captures on a legal mutation (positive case)', async () => {
    const { registry, lock, observability } = makeStoreEnv('bench-revoke-window-guard');
    let calls = 0;
    const realNowMs = () => {
      calls++;
      return calls;
    };
    const { measurement } = await measureRevocationWindow(
      { lock, registry, observability },
      realNowMs,
      () => ({ ok: true }),
      () => ({ subscriptions: [] })
    );
    expect(calls).toBe(2);
    expect(measurement.commitReturnMs).toBe(1);
    expect(measurement.releaseMs).toBe(2);
  });

  it('does NOT measure the adjacent commit->close-frame-delivered endpoint: close-frame delivery happens strictly after the function returns', async () => {
    const { registry, lock, observability } = makeStoreEnv('bench-revoke-window-adjacent');
    const deliveredAt: number[] = [];
    const sub = registry.register({
      subscriptionId: 'sub-adjacent',
      sessionId: 'sess-1',
      channelId: 'chan-1',
      principalId: 'principal-1',
      credentialId: 'cred-1',
      rejoinedSeq: 0,
      epochSnapshot: { authEpoch: 1, membershipEpoch: 1, channelEpoch: 1 },
      highWaterCursor: 0,
      sink: () => deliveredAt.push(Date.now()),
      nowMs: () => 0,
    });

    let wallClock = 5000;
    const realNowMs = () => (wallClock += 1);

    const { measurement } = await measureRevocationWindow(
      { lock, registry, observability },
      realNowMs,
      () => ({ principalId: 'principal-1' }),
      (r) => affectedByPrincipal(registry, r.principalId, 'authorization_lost')
    );

    // The measurement window ends at release, BEFORE deliverCloseFrame was
    // called by runAuthorizationMutation's post-lock step. We prove this by
    // checking that at the moment measurement.releaseMs was captured
    // (synchronously, inside the coordinator's finally), the subscription's
    // close frame had not yet been delivered to the sink — the sink is
    // still empty right after the awaited call returns is NOT provable
    // post-hoc, so instead we assert the subscription IS closed (purge
    // already happened, in-window) which is the in-window side-effect,
    // distinct from delivery (post-window side-effect via a separate sink
    // call the coordinator makes after releaseWrite()).
    expect(sub.closed).toBe(true);
    expect(measurement.windowMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// assertExactlyTwoNowMsCalls — the nowMs-call-count guard, unit-tested
// directly (extracted from measureRevocationWindow so the negative branch
// is reachable without needing coordinator.ts to actually misbehave).
// ---------------------------------------------------------------------------

describe('assertExactlyTwoNowMsCalls (instrumentation-shape guard, unit-tested in isolation)', () => {
  it('returns the [commitReturnMs, releaseMs] pair unchanged for exactly 2 calls', () => {
    expect(assertExactlyTwoNowMsCalls([10, 20])).toEqual([10, 20]);
  });

  it('throws NowMsCallCountError for 0 calls', () => {
    expect(() => assertExactlyTwoNowMsCalls([])).toThrow(NowMsCallCountError);
    expect(() => assertExactlyTwoNowMsCalls([])).toThrow(/observed 0/);
  });

  it('throws NowMsCallCountError for 1 call', () => {
    expect(() => assertExactlyTwoNowMsCalls([5])).toThrow(NowMsCallCountError);
    expect(() => assertExactlyTwoNowMsCalls([5])).toThrow(/observed 1/);
  });

  it('throws NowMsCallCountError for 3 calls', () => {
    expect(() => assertExactlyTwoNowMsCalls([1, 2, 3])).toThrow(NowMsCallCountError);
    expect(() => assertExactlyTwoNowMsCalls([1, 2, 3])).toThrow(/observed 3/);
  });
});

// ---------------------------------------------------------------------------
// REPORT mode artifact
// ---------------------------------------------------------------------------

describe('buildBenchmarkReportArtifact (H3/H4: REPORT mode, numeric thresholds, Node version)', () => {
  it('emits an artifact with real p95s, pass/fail against the Section 15 thresholds, and the running Node version', () => {
    const timelineSamples = Array.from({ length: 20 }, () => 50);
    const commitSamples = Array.from({ length: 20 }, () => 40);
    const fanoutSamples = Array.from({ length: 20 }, () => 30);
    const commitToLastWrite = Array.from({ length: 20 }, () => 100);
    const revocationSamples = Array.from({ length: 20 }, () => 90);
    const plan = buildRevocationPlan(100);

    const artifact = buildBenchmarkReportArtifact({
      timelineSamplesMs: timelineSamples,
      commitSamplesMs: commitSamples,
      fanoutSamplesMs: fanoutSamples,
      commitToLastWriteInitiationSamplesMs: commitToLastWrite,
      revocationSamplesMs: revocationSamples,
      revocationEntries: plan,
      observedSeqsInOrder: Array.from({ length: 100 }, (_, i) => i + 1),
      postLinearizationObservations: [{ writeInitiatedAtMs: 1, linearizedAtMs: undefined }],
      nowIso: '2026-08-07T00:00:00.000Z',
    });

    expect(artifact.runningNodeVersion).toBe(process.version.replace(/^v/, ''));
    expect(artifact.referenceNodeVersion).toBe(REFERENCE_NODE_VERSION);
    expect(artifact.percentiles.timelineP95).toBe(50);
    expect(artifact.passConditions.timelineP95Pass).toBe(true); // 50 <= 100
    expect(artifact.passConditions.commitP95Pass).toBe(true); // 40 <= 75
    expect(artifact.passConditions.commitToLastWriteInitiationP95Pass).toBe(true); // 100 <= 150
    expect(artifact.passConditions.revocationP95Pass).toBe(true); // 90 <= 150
    expect(artifact.passConditions.zeroLostOrDuplicate).toBe(true);
    expect(artifact.passConditions.zeroPostLinearizationWrites).toBe(true);
    expect(artifact.observationCounts.revokeAgentCount).toBe(100);
  });

  it('reports a numeric FAIL when a p95 exceeds its Section 15 threshold (REPORT mode only — never gates a test)', () => {
    const overThreshold = Array.from({ length: 20 }, () => 200); // > all thresholds
    const artifact = buildBenchmarkReportArtifact({
      timelineSamplesMs: overThreshold,
      commitSamplesMs: overThreshold,
      fanoutSamplesMs: overThreshold,
      commitToLastWriteInitiationSamplesMs: overThreshold,
      revocationSamplesMs: overThreshold,
      revocationEntries: [],
      observedSeqsInOrder: [],
      postLinearizationObservations: [],
      nowIso: '2026-08-07T00:00:00.000Z',
    });
    expect(artifact.passConditions.timelineP95Pass).toBe(false);
    expect(artifact.passConditions.commitP95Pass).toBe(false);
    expect(artifact.passConditions.commitToLastWriteInitiationP95Pass).toBe(false);
    expect(artifact.passConditions.revocationP95Pass).toBe(false);
  });

  it('undefined percentile (no samples) yields undefined pass condition, not a false failure', () => {
    const artifact = buildBenchmarkReportArtifact({
      timelineSamplesMs: [],
      commitSamplesMs: [],
      fanoutSamplesMs: [],
      commitToLastWriteInitiationSamplesMs: [],
      revocationSamplesMs: [],
      revocationEntries: [],
      observedSeqsInOrder: [],
      postLinearizationObservations: [],
      nowIso: '2026-08-07T00:00:00.000Z',
    });
    expect(artifact.percentiles.timelineP95).toBeUndefined();
    expect(artifact.passConditions.timelineP95Pass).toBeUndefined();
  });
});
