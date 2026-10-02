import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CollaborationStore, RoomJobInternalRun } from '@torqclaw/collab';
import {
  executeRoomJobLocal,
  type RoomJobLocalRunDeps,
  type RoomJobLocalRuntime,
} from '@torqclaw/inference';
import {
  canonicalRoomJobArtifact,
  RoomJobArtifactValidationError,
  validateRoomJobProposal,
  validateRoomJobReview,
} from './roomJobArtifactValidators.js';

export type RoomJobStage = 'draft' | 'review';
type InboxState = 'admitted' | 'dispatch_started' | 'result_observed' | 'recovery_needed' | 'refused' | 'terminal';

export function ensureRoomJobExecutionStateSchema(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS room_job_execution_inbox (
  attempt_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('draft','review')),
  request_id TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
  generation INTEGER NOT NULL CHECK(generation > 0),
  configuration_identity TEXT NOT NULL CHECK(length(configuration_identity) = 64),
  state TEXT NOT NULL CHECK(state IN ('admitted','dispatch_started','result_observed','recovery_needed','refused','terminal')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(attempt_id, stage)
);
CREATE TABLE IF NOT EXISTS room_job_execution_observations (
  request_id TEXT PRIMARY KEY REFERENCES room_job_execution_inbox(request_id),
  kind TEXT NOT NULL CHECK(kind IN ('success','failure','late_result_discarded')),
  code TEXT,
  content BLOB NOT NULL CHECK(length(content) <= 65536),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS room_job_execution_inbox_state ON room_job_execution_inbox(state, updated_at);
  `);
}

function now(): string { return new Date().toISOString(); }
function boundedFailure(error: unknown): Buffer {
  const code = error instanceof Error ? error.name : 'RoomJobExecutionFailure';
  return Buffer.from(JSON.stringify({ code }), 'utf8');
}

function promptFor(run: RoomJobInternalRun): { system: string; quotedInput: string } {
  const facts = run.facts.map((fact) => ({ factId: fact.factId, sha256: fact.sha256, content: fact.content.toString('utf8') }));
  if (run.stage === 'draft') {
    return {
      system: 'Return JSON only. Draft a proposal from the quoted brief and supplied facts. Do not call tools. Exact schema: {"title":string,"body":string,"facts":[{"factId":string,"sha256":string}]}. Include every supplied fact exactly once.',
      quotedInput: JSON.stringify({ brief: run.brief, facts }),
    };
  }
  return {
    system: 'Return JSON only. Perform a configured review of the quoted immutable proposal. Do not call tools. This is configured review, not independent verification. Exact schema: {"verdict":"acceptable"|"revise","summary":string,"proposal":{"revision":number,"sha256":string},"facts":[{"factId":string,"sha256":string}]}. Include every supplied fact exactly once.',
    quotedInput: JSON.stringify({ proposal: {
      revision: run.proposal!.revision, sha256: run.proposal!.sha256, content: run.proposal!.content.toString('utf8'),
    }, facts }),
  };
}

export interface RunRoomJobStageDeps extends Pick<RoomJobLocalRunDeps, 'fetchImpl' | 'now' | 'timeoutMsForTest'> {
  stateDb: Database.Database;
  store: CollaborationStore;
  runtime: RoomJobLocalRuntime;
  requestId?: () => string;
  /** Test-only pause before the final collab claim confirmation. */
  beforeProviderAdmissionForTest?: () => void | Promise<void>;
  /** Test-only crash seam after a durable response observation. */
  afterResultObservedForTest?: () => void;
}

/** Test-only crash sentinel; production never constructs this class. */
export class RoomJobSimulatedCrash extends Error {}

async function commitObservedArtifact(
  run: RoomJobInternalRun,
  stage: RoomJobStage,
  requestId: string,
  outputText: string,
  deps: RunRoomJobStageDeps,
): Promise<boolean> {
  const facts = run.facts.map((fact) => ({ factId: fact.factId, sha256: fact.sha256 }));
  const artifact = stage === 'draft'
    ? canonicalRoomJobArtifact(validateRoomJobProposal(outputText, facts))
    : canonicalRoomJobArtifact(validateRoomJobReview(outputText, facts, {
      revision: run.proposal!.revision, sha256: run.proposal!.sha256,
    }));
  return Boolean(await deps.store.commitRoomJobInternalArtifact({
    attemptId: run.attemptId, stage, requestId, generation: run.generation, inputHash: run.inputHash,
    configurationIdentity: run.configurationIdentity, content: artifact,
    provenance: {
      version: 1, attemptId: run.attemptId, stage, requestId, inputHash: run.inputHash,
      configurationIdentity: run.configurationIdentity, validator: 'room-job-artifact-validator-v1',
      ...(stage === 'review' ? { reviewKind: 'configured_review' } : {}),
    },
  }));
}

/**
 * One durable stage reconciliation. It has no GatewayRequest, dispatch,
 * task-store, receipt, approval, session, or event-bus dependency.
 */
export async function runRoomJobStage(
  attemptId: string,
  stage: RoomJobStage,
  deps: RunRoomJobStageDeps,
): Promise<{ status: 'committed' | 'fenced' | 'recovery_needed' | 'failed'; requestId?: string }> {
  ensureRoomJobExecutionStateSchema(deps.stateDb);
  const existing = deps.stateDb.prepare(`SELECT request_id, state FROM room_job_execution_inbox
    WHERE attempt_id = ? AND stage = ?`).get(attemptId, stage) as { request_id: string; state: InboxState } | undefined;
  const initial = await deps.store.getRoomJobInternalRun(attemptId, stage, {
    allowClaimed: existing?.state === 'dispatch_started' || existing?.state === 'result_observed',
  });
  if (!initial || initial.configurationIdentity !== deps.runtime.configurationIdentity) return { status: 'fenced' };
  if (existing) {
    if (existing.state === 'dispatch_started') {
      await deps.store.recordRoomJobInternalRecoveryNeeded({
        attemptId, stage, generation: initial.generation, inputHash: initial.inputHash,
      });
      deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'recovery_needed', updated_at = ?
        WHERE attempt_id = ? AND stage = ? AND state = 'dispatch_started'`).run(now(), attemptId, stage);
      return { status: 'recovery_needed', requestId: existing.request_id };
    }
    if (existing.state === 'result_observed') {
      const observed = deps.stateDb.prepare(`SELECT kind, content FROM room_job_execution_observations WHERE request_id = ?`)
        .get(existing.request_id) as { kind: string; content: Buffer } | undefined;
      const admitted = await deps.store.getRoomJobInternalRun(attemptId, stage, { allowClaimed: true });
      if (!admitted || !observed || observed.kind !== 'success') {
        const acknowledged = await deps.store.hasRoomJobInternalTerminalAck(attemptId, stage);
        deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'terminal', updated_at = ? WHERE request_id = ?`)
          .run(now(), existing.request_id);
        return { status: acknowledged ? 'committed' : 'fenced', requestId: existing.request_id };
      }
      try {
        const committed = await commitObservedArtifact(admitted, stage, existing.request_id, observed.content.toString('utf8'), deps);
        deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'terminal', updated_at = ? WHERE request_id = ?`)
          .run(now(), existing.request_id);
        if (!committed) return { status: 'fenced', requestId: existing.request_id };
        if (stage === 'draft') return runRoomJobStage(attemptId, 'review', deps);
        return { status: 'committed', requestId: existing.request_id };
      } catch (error) {
        // The result was already durably observed. Preserve the normal
        // redacted terminal record, but retain the original error as the
        // cause for server-side diagnostics and deterministic test seams.
        await deps.store.recordRoomJobInternalFailure({
          attemptId, stage, generation: admitted.generation, inputHash: admitted.inputHash,
          reason: error instanceof RoomJobArtifactValidationError ? 'validation_failed' : 'stage_failed',
        });
        deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'terminal', updated_at = ? WHERE request_id = ?`)
          .run(now(), existing.request_id);
        return { status: 'failed', requestId: existing.request_id };
      }
    }
    if (existing.state !== 'admitted') {
      return { status: existing.state === 'terminal' ? 'committed' : 'fenced', requestId: existing.request_id };
    }
  }
  const requestId = existing?.request_id ?? (deps.requestId ?? randomUUID)();
  if (!existing) {
    const admittedAt = now();
    deps.stateDb.prepare(`INSERT INTO room_job_execution_inbox(
      attempt_id, stage, request_id, input_hash, generation, configuration_identity, state, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,'admitted',?,?)`).run(
      initial.attemptId, stage, requestId, initial.inputHash, initial.generation, initial.configurationIdentity, admittedAt, admittedAt,
    );
  }
  // The collab transaction, not state.db, owns the irreversible provider claim.
  const admitted = await deps.store.claimRoomJobInternalDispatch(attemptId, stage, deps.runtime.configurationIdentity);
  if (!admitted || admitted.configurationIdentity !== deps.runtime.configurationIdentity) {
    deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'refused', updated_at = ?
      WHERE request_id = ? AND state = 'admitted'`).run(now(), requestId);
    return { status: 'fenced', requestId };
  }
  const claimed = deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'dispatch_started', updated_at = ?
    WHERE request_id = ? AND state = 'admitted'`).run(now(), requestId);
  if (claimed.changes !== 1) return { status: 'recovery_needed', requestId };
  try {
    await deps.beforeProviderAdmissionForTest?.();
    if (!await deps.store.confirmRoomJobInternalDispatchClaim(
      attemptId, stage, admitted.generation, admitted.configurationIdentity,
    )) {
      deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'refused', updated_at = ?
        WHERE request_id = ? AND state = 'dispatch_started'`).run(now(), requestId);
      return { status: 'fenced', requestId };
    }
    const prompt = promptFor(admitted);
    const result = await executeRoomJobLocal({ modelId: deps.runtime.modelId, ...prompt }, {
      fetchImpl: deps.fetchImpl, now: deps.now, host: deps.runtime.host,
      timeoutMsForTest: deps.timeoutMsForTest,
    });
    const output = Buffer.from(result.text, 'utf8');
    const observedAt = now();
    deps.stateDb.prepare(`INSERT INTO room_job_execution_observations(
      request_id, kind, code, content, content_sha256, created_at
    ) VALUES(?, 'success', NULL, ?, ?, ?)`).run(
      requestId, output, createHash('sha256').update(output).digest('hex'), observedAt,
    );
    deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'result_observed', updated_at = ?
      WHERE request_id = ? AND state = 'dispatch_started'`).run(observedAt, requestId);
    deps.afterResultObservedForTest?.();
    const committed = await commitObservedArtifact(admitted, stage, requestId, result.text, deps);
    if (!committed) {
      deps.stateDb.prepare(`UPDATE room_job_execution_observations SET kind = 'late_result_discarded' WHERE request_id = ?`).run(requestId);
      deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'terminal', updated_at = ? WHERE request_id = ?`).run(now(), requestId);
      return { status: 'fenced', requestId };
    }
    deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'terminal', updated_at = ? WHERE request_id = ?`).run(now(), requestId);
    if (stage === 'draft') return runRoomJobStage(attemptId, 'review', deps);
    return { status: 'committed', requestId };
  } catch (error) {
    if (error instanceof RoomJobSimulatedCrash) throw error;
    const evidence = boundedFailure(error);
    const observedAt = now();
    deps.stateDb.prepare(`INSERT OR IGNORE INTO room_job_execution_observations(
      request_id, kind, code, content, content_sha256, created_at
    ) VALUES(?, 'failure', ?, ?, ?, ?)`).run(
      requestId, error instanceof RoomJobArtifactValidationError ? 'validation_failed' : 'stage_failed',
      evidence, createHash('sha256').update(evidence).digest('hex'), observedAt,
    );
    deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'terminal', updated_at = ?
      WHERE request_id = ? AND state IN ('dispatch_started','result_observed')`).run(observedAt, requestId);
    deps.stateDb.prepare(`UPDATE room_job_execution_observations SET code = ? WHERE request_id = ? AND kind = 'success'`)
      .run(error instanceof RoomJobArtifactValidationError ? 'validation_failed' : 'stage_failed', requestId);
    await deps.store.recordRoomJobInternalFailure({
      attemptId, stage, generation: admitted.generation, inputHash: admitted.inputHash,
      reason: error instanceof RoomJobArtifactValidationError ? 'validation_failed' : 'stage_failed',
    });
    return { status: 'failed', requestId };
  }
}

/** Bounded restart reconciliation. It never replays a dispatch_started row. */
export async function reconcileRoomJobExecution(deps: RunRoomJobStageDeps, limit = 20): Promise<void> {
  for (const pending of await deps.store.listPendingRoomJobInternalRuns(limit)) {
    await runRoomJobStage(pending.attemptId, pending.stage, deps);
  }
  ensureRoomJobExecutionStateSchema(deps.stateDb);
  const stranded = deps.stateDb.prepare(`SELECT attempt_id, stage FROM room_job_execution_inbox
    WHERE state = 'dispatch_started' ORDER BY updated_at ASC LIMIT ?`).all(limit) as Array<{ attempt_id: string; stage: RoomJobStage }>;
  for (const row of stranded) {
    deps.stateDb.prepare(`UPDATE room_job_execution_inbox SET state = 'recovery_needed', updated_at = ?
      WHERE attempt_id = ? AND stage = ? AND state = 'dispatch_started'`).run(now(), row.attempt_id, row.stage);
  }
}
