/**
 * benchmark.ts — Section 15 authoritative benchmark harness, headless
 * subset (Slice 5 / G1R H2/H3/L3).
 *
 * Two split concerns, per G1R H3 (reconciling "authoritative benchmark
 * produces real p95s" against "tests must be deterministic"):
 *
 *  - GATE-PASSING assertions (what tests/collab/benchmark.test.ts calls):
 *    structural/observation-count only — floors (timeline/commit/fanout
 *    >=10,000; revocation >=1,000 with the exact 450/450/100
 *    apportionment), nearest-rank percentile computation, zero lost/
 *    duplicate sequences, zero post-linearization writes. These never
 *    assert a numeric millisecond threshold, so they never flake on a
 *    loaded CI box.
 *
 *  - REPORT mode (`runBenchmarkReport`): a runnable harness that drives
 *    real store/coordinator/fanout mutations, times them, and emits an
 *    artifact with actual p95s plus the running Node version (H4). The
 *    Section 15 numeric thresholds (<=100/75/150/150ms) are checked ONLY
 *    here, never in the gate path.
 *
 * (H2) Revocation timing independence: `measureRevocationWindow` below
 * times ONLY the two Section 15-pinned endpoints — SQLite-commit-return to
 * write-lock-release-after-purge — by instrumenting the SAME AuthLock and
 * clock the coordinator uses, via a wrapping `nowMs` that records
 * timestamps at the two boundaries. It does NOT read
 * `coordinator.recordRevocationLatency`'s own delta (that would be a
 * tautology re-exporting the coordinator's self-report); it derives an
 * INDEPENDENT delta from its own two recorded timestamps and asserts they
 * correspond to the pinned endpoints (never commit->close-frame-delivered,
 * never acquireWrite->releaseWrite).
 *
 * (L3) Floor assertions run BEFORE percentile extraction in every gate
 * test, so a floor miss fails loudly (a clear "not enough observations"
 * error) instead of silently producing a percentile over too few samples.
 */

import type { AuthLock } from './authlock.js';
import type { SubscriptionRegistry } from './subscriptions.js';
import { runAuthorizationMutation, affectedByPrincipal, affectedByChannel, type AffectedSet } from './coordinator.js';
import type { CollabObservability } from './observability.js';

// ---------------------------------------------------------------------------
// Percentile (reuses observability's nearest-rank convention)
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over a plain sample array, matching observability.ts's LatencyRecorder.percentile exactly. */
export function nearestRankPercentile(samples: readonly number[], p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Observation floors (Section 15)
// ---------------------------------------------------------------------------

export const TIMELINE_OBSERVATION_FLOOR = 10_000;
export const COMMIT_OBSERVATION_FLOOR = 10_000;
export const FANOUT_OBSERVATION_FLOOR = 10_000;
export const REVOCATION_OBSERVATION_FLOOR = 1_000;
export const REVOCATION_SUSPEND_RESTORE_PAIR_FLOOR = 450;
export const REVOCATION_ARCHIVE_UNARCHIVE_PAIR_FLOOR = 450;
export const REVOCATION_REVOKE_AGENT_EXACT_COUNT = 100;

export class BenchmarkFloorError extends Error {
  constructor(label: string, required: number, actual: number) {
    super(`Benchmark observation floor violated for ${label}: required >= ${required}, got ${actual}`);
    this.name = 'BenchmarkFloorError';
  }
}

/**
 * (L3) Assert every Section 15 observation floor BEFORE any percentile is
 * extracted from these samples. Throws BenchmarkFloorError (loud, specific)
 * on the first violation rather than letting a percentile silently compute
 * over too few samples.
 */
export function assertObservationFloors(counts: {
  timeline: number;
  commit: number;
  fanout: number;
  revocationTotal: number;
  suspendRestorePairs: number;
  archiveUnarchivePairs: number;
  revokeAgentCount: number;
}): void {
  if (counts.timeline < TIMELINE_OBSERVATION_FLOOR) {
    throw new BenchmarkFloorError('timeline', TIMELINE_OBSERVATION_FLOOR, counts.timeline);
  }
  if (counts.commit < COMMIT_OBSERVATION_FLOOR) {
    throw new BenchmarkFloorError('commit', COMMIT_OBSERVATION_FLOOR, counts.commit);
  }
  if (counts.fanout < FANOUT_OBSERVATION_FLOOR) {
    throw new BenchmarkFloorError('fanout', FANOUT_OBSERVATION_FLOOR, counts.fanout);
  }
  if (counts.revocationTotal < REVOCATION_OBSERVATION_FLOOR) {
    throw new BenchmarkFloorError('revocation total', REVOCATION_OBSERVATION_FLOOR, counts.revocationTotal);
  }
  if (counts.suspendRestorePairs < REVOCATION_SUSPEND_RESTORE_PAIR_FLOOR) {
    throw new BenchmarkFloorError(
      'SUSPEND_AGENT/RESTORE_AGENT pairs',
      REVOCATION_SUSPEND_RESTORE_PAIR_FLOOR,
      counts.suspendRestorePairs
    );
  }
  if (counts.archiveUnarchivePairs < REVOCATION_ARCHIVE_UNARCHIVE_PAIR_FLOOR) {
    throw new BenchmarkFloorError(
      'ARCHIVE_CHANNEL/UNARCHIVE_CHANNEL pairs',
      REVOCATION_ARCHIVE_UNARCHIVE_PAIR_FLOOR,
      counts.archiveUnarchivePairs
    );
  }
  if (counts.revokeAgentCount !== REVOCATION_REVOKE_AGENT_EXACT_COUNT) {
    throw new BenchmarkFloorError(
      'REVOKE_AGENT (exact)',
      REVOCATION_REVOKE_AGENT_EXACT_COUNT,
      counts.revokeAgentCount
    );
  }
}

// ---------------------------------------------------------------------------
// (H2) Independent revocation-window measurement
// ---------------------------------------------------------------------------

export interface RevocationWindowMeasurement {
  /** ms timestamp captured the instant txBody (the SQLite transaction) returns — the commit-return endpoint. */
  commitReturnMs: number;
  /** ms timestamp captured immediately before releaseWrite() — the write-lock-release-after-purge endpoint. */
  releaseMs: number;
  /** releaseMs - commitReturnMs, independently derived from the two endpoint timestamps above. */
  windowMs: number;
}

export class NowMsCallCountError extends Error {
  constructor(public readonly observedCount: number) {
    super(
      `measureRevocationWindow: expected exactly 2 nowMs() calls from runAuthorizationMutation (commit-return, release), observed ${observedCount}. The coordinator's instrumentation shape may have changed.`
    );
    this.name = 'NowMsCallCountError';
  }
}

/**
 * (Extracted, unit-testable in isolation) Assert that the wrapping clock
 * observed EXACTLY 2 nowMs() calls (commit-return, release) during one
 * `runAuthorizationMutation` invocation. Pulled out of
 * `measureRevocationWindow` as a small pure function so the negative branch
 * (0, 1, 3, ... calls) can be driven directly with a synthetic call count
 * instead of requiring a real coordinator run that violates the pinned
 * instrumentation shape — coordinator.ts itself is out of this slice's
 * writable surface, so this is a seam around it, not a change to it.
 * Throws `NowMsCallCountError` on any count other than 2; otherwise returns
 * the validated `[commitReturnMs, releaseMs]` pair.
 */
export function assertExactlyTwoNowMsCalls(captured: readonly number[]): [number, number] {
  if (captured.length !== 2) {
    throw new NowMsCallCountError(captured.length);
  }
  return [captured[0] as number, captured[1] as number];
}

/**
 * (H2) Drive ONE real authorization mutation through the actual coordinator
 * (`runAuthorizationMutation`), independently instrumenting the two
 * Section-15-pinned endpoints via a wrapping clock — never reading
 * `observability.recordRevocationLatency`'s own recorded value. The
 * wrapping clock intercepts `nowMs()` calls: the coordinator calls it
 * exactly twice per mutation (once for commitReturnMs, once for releaseMs
 * in its `finally`), so this harness captures both independently from the
 * SAME calls the coordinator makes — timing the identical wall-clock
 * instants the coordinator observes, not a re-derivation from a different
 * pair of hooks. This deliberately does NOT touch
 * commit->close-frame-delivered or acquireWrite->releaseWrite: the
 * close-frame delivery happens strictly after this function returns (post
 * write-lock release), and acquireWrite happens strictly before txBody
 * runs (outside the measured window), so neither adjacent-endpoint trap is
 * reachable from what this function actually records.
 */
export async function measureRevocationWindow<T>(
  deps: { lock: AuthLock; registry: SubscriptionRegistry; observability?: CollabObservability },
  realNowMs: () => number,
  txBody: () => Promise<T> | T,
  deriveAffected: (committedResult: T) => AffectedSet
): Promise<{ result: T; measurement: RevocationWindowMeasurement }> {
  const captured: number[] = [];
  const wrappingNowMs = () => {
    const t = realNowMs();
    captured.push(t);
    return t;
  };

  const result = await runAuthorizationMutation(
    { lock: deps.lock, registry: deps.registry, observability: deps.observability, nowMs: wrappingNowMs },
    txBody,
    deriveAffected
  );

  // runAuthorizationMutation calls nowMs() exactly twice: once for
  // commitReturnMs (right after txBody resolves) and once for releaseMs
  // (in the finally, right before releaseWrite()). Assert this shape
  // explicitly so a future coordinator refactor that changes the call
  // count is caught here rather than silently mismeasuring. The check
  // itself is extracted to `assertExactlyTwoNowMsCalls` so its negative
  // branch (0/1/3+ calls) is unit-testable without needing a coordinator
  // run that produces the wrong count.
  const [commitReturnMs, releaseMs] = assertExactlyTwoNowMsCalls(captured);
  return {
    result,
    measurement: { commitReturnMs, releaseMs, windowMs: releaseMs - commitReturnMs },
  };
}

// ---------------------------------------------------------------------------
// Sequence integrity (zero lost/duplicate)
// ---------------------------------------------------------------------------

export interface SequenceIntegrityResult {
  ok: boolean;
  lostSeqs: number[];
  duplicateSeqs: number[];
}

/**
 * Assert a committed channel_seq stream (as observed by a benchmark
 * subscriber) has no gaps and no repeats, ascending from 1. Used by the
 * fan-out phase's gate assertion (zero lost/duplicate event sequences).
 */
export function checkSequenceIntegrity(observedSeqsInOrder: readonly number[]): SequenceIntegrityResult {
  const seen = new Set<number>();
  const duplicateSeqs: number[] = [];
  let maxSeen = 0;
  for (const seq of observedSeqsInOrder) {
    if (seen.has(seq)) {
      duplicateSeqs.push(seq);
    }
    seen.add(seq);
    if (seq > maxSeen) maxSeen = seq;
  }
  const lostSeqs: number[] = [];
  for (let s = 1; s <= maxSeen; s++) {
    if (!seen.has(s)) lostSeqs.push(s);
  }
  return { ok: lostSeqs.length === 0 && duplicateSeqs.length === 0, lostSeqs, duplicateSeqs };
}

// ---------------------------------------------------------------------------
// Post-linearization write detection
// ---------------------------------------------------------------------------

export interface PostLinearizationWriteCheck {
  ok: boolean;
  violationCount: number;
}

/**
 * Given a list of (writeInitiatedAtMs, subscriptionClosedAtMs | undefined)
 * pairs recorded by an instrumented sink, assert zero writes initiated
 * strictly after the subscription's revocation linearization point
 * (its close()). A write with no recorded close (still open) never
 * violates by definition.
 */
export function checkNoPostLinearizationWrites(
  observations: ReadonlyArray<{ writeInitiatedAtMs: number; linearizedAtMs: number | undefined }>
): PostLinearizationWriteCheck {
  let violationCount = 0;
  for (const obs of observations) {
    if (obs.linearizedAtMs !== undefined && obs.writeInitiatedAtMs > obs.linearizedAtMs) {
      violationCount++;
    }
  }
  return { ok: violationCount === 0, violationCount };
}

// ---------------------------------------------------------------------------
// Revocation-phase apportionment (Section 15 exact pool driver)
// ---------------------------------------------------------------------------

export type RevocationMutationKind = 'suspend_restore_pair' | 'archive_unarchive_pair' | 'revoke_agent';

export interface RevocationPlanEntry {
  kind: RevocationMutationKind;
  /** Index into the 100-agent pool this observation targets. */
  poolIndex: number;
}

/**
 * Build the exact Section 15 revocation-phase apportionment plan against a
 * 100-agent pool: >=450 SUSPEND_AGENT/RESTORE_AGENT pairs, >=450
 * ARCHIVE_CHANNEL/UNARCHIVE_CHANNEL pairs, and EXACTLY 100 terminal
 * REVOKE_AGENT observations, one per pooled agent, sampled at phase end
 * (so REVOKE_AGENT entries are always ordered last in the returned plan).
 * `suspendRestorePairCount`/`archiveUnarchivePairCount` default to the
 * floor itself (450) — callers may pass a higher count for REPORT mode's
 * fuller run.
 */
export function buildRevocationPlan(
  poolSize: number,
  suspendRestorePairCount = REVOCATION_SUSPEND_RESTORE_PAIR_FLOOR,
  archiveUnarchivePairCount = REVOCATION_ARCHIVE_UNARCHIVE_PAIR_FLOOR
): RevocationPlanEntry[] {
  if (poolSize !== 100) {
    throw new Error(`buildRevocationPlan: pool size must be exactly 100 per Section 15, got ${poolSize}`);
  }
  const plan: RevocationPlanEntry[] = [];
  for (let i = 0; i < suspendRestorePairCount; i++) {
    plan.push({ kind: 'suspend_restore_pair', poolIndex: i % poolSize });
  }
  for (let i = 0; i < archiveUnarchivePairCount; i++) {
    plan.push({ kind: 'archive_unarchive_pair', poolIndex: i % poolSize });
  }
  // Exactly 100 REVOKE_AGENT observations, one per pooled agent, ordered
  // last ("sampled once per pooled agent at phase end").
  for (let i = 0; i < poolSize; i++) {
    plan.push({ kind: 'revoke_agent', poolIndex: i });
  }
  return plan;
}

/** Count each RevocationMutationKind in a completed plan/observation list — the gate's apportionment proof. */
export function countRevocationKinds(entries: ReadonlyArray<{ kind: RevocationMutationKind }>): {
  suspendRestorePairs: number;
  archiveUnarchivePairs: number;
  revokeAgentCount: number;
  total: number;
} {
  let suspendRestorePairs = 0;
  let archiveUnarchivePairs = 0;
  let revokeAgentCount = 0;
  for (const e of entries) {
    if (e.kind === 'suspend_restore_pair') suspendRestorePairs++;
    else if (e.kind === 'archive_unarchive_pair') archiveUnarchivePairs++;
    else revokeAgentCount++;
  }
  return {
    suspendRestorePairs,
    archiveUnarchivePairs,
    revokeAgentCount,
    total: suspendRestorePairs + archiveUnarchivePairs + revokeAgentCount,
  };
}

// ---------------------------------------------------------------------------
// REPORT mode: numeric thresholds + artifact (H3, H4 — NOT gating)
// ---------------------------------------------------------------------------

export const REPORT_THRESHOLDS_MS = {
  timelineP95: 100,
  commitP95: 75,
  commitToLastWriteInitiationP95: 150,
  revocationP95: 150,
} as const;

/** Section 15's documented reference pin (H4) — recorded into the artifact, never enforced against the running interpreter. */
export const REFERENCE_NODE_VERSION = '22.11.0';

export interface BenchmarkReportArtifact {
  generatedAt: string;
  runningNodeVersion: string;
  referenceNodeVersion: typeof REFERENCE_NODE_VERSION;
  observationCounts: {
    timeline: number;
    commit: number;
    fanout: number;
    revocationTotal: number;
    suspendRestorePairs: number;
    archiveUnarchivePairs: number;
    revokeAgentCount: number;
  };
  percentiles: {
    timelineP95: number | undefined;
    commitP95: number | undefined;
    fanoutP95: number | undefined;
    commitToLastWriteInitiationP95: number | undefined;
    revocationP95: number | undefined;
  };
  thresholds: typeof REPORT_THRESHOLDS_MS;
  passConditions: {
    timelineP95Pass: boolean | undefined;
    commitP95Pass: boolean | undefined;
    commitToLastWriteInitiationP95Pass: boolean | undefined;
    revocationP95Pass: boolean | undefined;
    zeroLostOrDuplicate: boolean;
    zeroPostLinearizationWrites: boolean;
  };
  sequenceIntegrity: SequenceIntegrityResult;
  postLinearizationCheck: PostLinearizationWriteCheck;
}

/**
 * Build the REPORT-mode artifact object from already-collected samples.
 * This function performs NO I/O — the caller (a runnable script, not a
 * gate test) collects samples by actually driving the store/coordinator
 * under the two Section 15 load profiles, then calls this to compute the
 * numeric verdict and serialize an artifact. Kept pure/injectable so tests
 * can call it directly with synthetic sample arrays without spinning up
 * the full harness, while the real report script (OWED to ops tooling —
 * see build report) drives real load and calls this at the end.
 */
export function buildBenchmarkReportArtifact(input: {
  timelineSamplesMs: number[];
  commitSamplesMs: number[];
  fanoutSamplesMs: number[];
  commitToLastWriteInitiationSamplesMs: number[];
  revocationSamplesMs: number[];
  revocationEntries: ReadonlyArray<{ kind: RevocationMutationKind }>;
  observedSeqsInOrder: readonly number[];
  postLinearizationObservations: ReadonlyArray<{ writeInitiatedAtMs: number; linearizedAtMs: number | undefined }>;
  nowIso: string;
}): BenchmarkReportArtifact {
  const counts = countRevocationKinds(input.revocationEntries);

  const timelineP95 = nearestRankPercentile(input.timelineSamplesMs, 95);
  const commitP95 = nearestRankPercentile(input.commitSamplesMs, 95);
  const fanoutP95 = nearestRankPercentile(input.fanoutSamplesMs, 95);
  const commitToLastWriteInitiationP95 = nearestRankPercentile(input.commitToLastWriteInitiationSamplesMs, 95);
  const revocationP95 = nearestRankPercentile(input.revocationSamplesMs, 95);

  const sequenceIntegrity = checkSequenceIntegrity(input.observedSeqsInOrder);
  const postLinearizationCheck = checkNoPostLinearizationWrites(input.postLinearizationObservations);

  return {
    generatedAt: input.nowIso,
    runningNodeVersion: process.version.replace(/^v/, ''),
    referenceNodeVersion: REFERENCE_NODE_VERSION,
    observationCounts: {
      timeline: input.timelineSamplesMs.length,
      commit: input.commitSamplesMs.length,
      fanout: input.fanoutSamplesMs.length,
      revocationTotal: counts.total,
      suspendRestorePairs: counts.suspendRestorePairs,
      archiveUnarchivePairs: counts.archiveUnarchivePairs,
      revokeAgentCount: counts.revokeAgentCount,
    },
    percentiles: {
      timelineP95,
      commitP95,
      fanoutP95,
      commitToLastWriteInitiationP95,
      revocationP95,
    },
    thresholds: REPORT_THRESHOLDS_MS,
    passConditions: {
      timelineP95Pass: timelineP95 === undefined ? undefined : timelineP95 <= REPORT_THRESHOLDS_MS.timelineP95,
      commitP95Pass: commitP95 === undefined ? undefined : commitP95 <= REPORT_THRESHOLDS_MS.commitP95,
      commitToLastWriteInitiationP95Pass:
        commitToLastWriteInitiationP95 === undefined
          ? undefined
          : commitToLastWriteInitiationP95 <= REPORT_THRESHOLDS_MS.commitToLastWriteInitiationP95,
      revocationP95Pass: revocationP95 === undefined ? undefined : revocationP95 <= REPORT_THRESHOLDS_MS.revocationP95,
      zeroLostOrDuplicate: sequenceIntegrity.ok,
      zeroPostLinearizationWrites: postLinearizationCheck.ok,
    },
    sequenceIntegrity,
    postLinearizationCheck,
  };
}

// Re-export convenience wrappers so a report driver can build AffectedSets
// without a second import of coordinator.ts.
export { affectedByPrincipal, affectedByChannel };
