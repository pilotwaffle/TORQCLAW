import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  runCollaborationMigration, runRoomJobExecutionArtifactBindingMigration, runRoomJobExecutionClaimMigration, runRoomJobExecutionMigration, runRoomJobFoundationMigration,
} from '../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../packages/collab/src/store.js';
import { ensureRoomJobExecutionStateSchema, reconcileRoomJobExecution, RoomJobSimulatedCrash, runRoomJobStage } from '../packages/gateway/src/roomJobExecution.js';

function fixture() {
  const collab = new Database(':memory:');
  runCollaborationMigration(collab);
  runRoomJobFoundationMigration(collab);
  runRoomJobExecutionMigration(collab);
  runRoomJobExecutionArtifactBindingMigration(collab);
  runRoomJobExecutionClaimMigration(collab);
  const db: BootstrapDb = {
    prepare: (sql) => collab.prepare(sql), exec: (sql) => collab.exec(sql), transaction: (fn) => collab.transaction(fn) as never,
  };
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids('room-job-coordinator');
  const bootstrap = bootstrapOperator({ db, clock, uuids, rng: nodeRandomSource, secretStore: new InMemorySecretStore() }, {
    operatorDisplayName: 'Owner', installationId: 'room-job-coordinator', schemaVersion: 1,
  });
  return {
    collab, state: new Database(':memory:'),
    store: new CollaborationStore({ db, clock, uuids, rng: nodeRandomSource, principalPepper: bootstrap.principalPepper }),
    owner: { principalId: bootstrap.operatorPrincipalId, kind: 'operator' } satisfies CallerContext,
  };
}

describe('room-job coordinator', () => {
  async function createStartedFixture(id: string) {
    const value = fixture();
    const room = await value.store.createChannel(value.owner, { name: 'Proposal Room' }, 'channel');
    const job = await value.store.createRoomJob(value.owner, { channelId: room.channelId, brief: 'Draft a proposal' }, 'job');
    const facts = await value.store.appendRoomJobFacts(value.owner, { channelId: room.channelId, jobId: job.job.jobId, facts: ['Client needs a concise scope'] }, 'facts');
    const runtime = { host: 'http://127.0.0.1:11434', modelId: 'fixture-local', configurationIdentity: 'b'.repeat(64) };
    const attempt = await value.store.startRoomJob(value.owner, {
      channelId: room.channelId, jobId: job.job.jobId, factIds: [facts.facts[0]!.factId],
    }, `start-${id}`, { configurationIdentity: runtime.configurationIdentity });
    return { ...value, room, job, runtime, attempt };
  }

  function validFetch(counter: { calls: number }): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      counter.calls += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const quoted = JSON.parse(body.messages[1]!.content) as { facts: Array<{ factId: string; sha256: string }>; proposal?: { revision: number; sha256: string } };
      const output = quoted.proposal
        ? { verdict: 'acceptable', summary: 'Configured review recorded.', proposal: { revision: quoted.proposal.revision, sha256: quoted.proposal.sha256 }, facts: quoted.facts.map(({ factId, sha256 }) => ({ factId, sha256 })) }
        : { title: 'Client Proposal', body: 'A bounded proposal body.', facts: quoted.facts.map(({ factId, sha256 }) => ({ factId, sha256 })) };
      return new Response(JSON.stringify({ message: { content: JSON.stringify(output) }, eval_count: 9 }), { status: 200 });
    }) as typeof fetch;
  }

  it('cancellation that wins before the final collab claim confirmation makes zero provider calls', async () => {
    const { collab, state, store, owner, room, job, runtime, attempt } = await createStartedFixture('cancel-race');
    const counter = { calls: 0 };
    const result = await runRoomJobStage(attempt.attempt.attemptId, 'draft', {
      stateDb: state, store, runtime, fetchImpl: validFetch(counter),
      beforeProviderAdmissionForTest: async () => {
        await store.cancelRoomJob(owner, { channelId: room.channelId, jobId: job.job.jobId, expectedRevision: 1 }, 'cancel-race');
      },
    });
    expect(result.status).toBe('fenced');
    expect(counter.calls).toBe(0);
    expect(collab.prepare(`SELECT state FROM room_job_outbox WHERE attempt_id = ? AND stage = 'draft'`).get(attempt.attempt.attemptId))
      .toEqual({ state: 'cancelled' });
    expect(collab.prepare(`SELECT COUNT(*) AS n FROM room_artifact_revisions WHERE job_id = ?`).get(job.job.jobId)).toEqual({ n: 0 });
    collab.close(); state.close();
  });

  it('reconciles a durable observed result after a crash without replaying its provider call', async () => {
    const { collab, state, store, runtime, attempt } = await createStartedFixture('observed-recovery');
    const counter = { calls: 0 };
    await expect(runRoomJobStage(attempt.attempt.attemptId, 'draft', {
      stateDb: state, store, runtime, fetchImpl: validFetch(counter),
      afterResultObservedForTest: () => { throw new RoomJobSimulatedCrash('crash after observation'); },
    })).rejects.toBeInstanceOf(RoomJobSimulatedCrash);
    expect(counter.calls).toBe(1);
    const recovered = await runRoomJobStage(attempt.attempt.attemptId, 'draft', {
      stateDb: state, store, runtime, fetchImpl: validFetch(counter),
    });
    expect(recovered.status).toBe('committed');
    // One draft request survived in state.db; only review runs after restart.
    expect(counter.calls).toBe(2);
    expect(collab.prepare(`SELECT state FROM room_job_outbox WHERE attempt_id = ? ORDER BY stage`).all(attempt.attempt.attemptId))
      .toEqual([{ state: 'acknowledged' }, { state: 'acknowledged' }]);
    collab.close(); state.close();
  });

  it('boot reconciliation persists a claimed dispatch interruption to Room authority without replay', async () => {
    const { collab, state, store, runtime, attempt } = await createStartedFixture('boot-recovery');
    const admitted = await store.claimRoomJobInternalDispatch(attempt.attempt.attemptId, 'draft', runtime.configurationIdentity);
    expect(admitted).not.toBeNull();
    ensureRoomJobExecutionStateSchema(state);
    state.prepare(`INSERT INTO room_job_execution_inbox(attempt_id, stage, request_id, input_hash, generation, configuration_identity, state, created_at, updated_at)
      VALUES(?,?,?,?,?,?,'dispatch_started',?,?)`).run(attempt.attempt.attemptId, 'draft', 'boot-recovery-request', attempt.attempt.inputHash, attempt.attempt.generation, runtime.configurationIdentity, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
    let calls = 0;
    await reconcileRoomJobExecution({ stateDb: state, store, runtime, fetchImpl: (async () => { calls += 1; throw new Error('must not run'); }) as typeof fetch });
    expect(calls).toBe(0);
    expect(collab.prepare(`SELECT state FROM room_job_outbox WHERE attempt_id = ? AND stage = 'draft'`).get(attempt.attempt.attemptId)).toEqual({ state: 'recovery_needed' });
    expect(collab.prepare(`SELECT state, terminal_reason FROM room_job_attempts WHERE attempt_id = ?`).get(attempt.attempt.attemptId))
      .toEqual({ state: 'recovery_needed', terminal_reason: 'dispatch_interrupted_uncertain' });
    expect(state.prepare(`SELECT state FROM room_job_execution_inbox WHERE request_id = 'boot-recovery-request'`).get()).toEqual({ state: 'recovery_needed' });
    expect(collab.prepare(`SELECT COUNT(*) AS n FROM room_job_events WHERE job_id = (SELECT job_id FROM room_job_attempts WHERE attempt_id = ?) AND kind = 'execution_failed'`).get(attempt.attempt.attemptId)).toEqual({ n: 1 });
    collab.close(); state.close();
  });

  it('commits validated draft and configured-review artifacts without generic gateway state', async () => {
    const { collab, state, store, owner } = fixture();
    const room = await store.createChannel(owner, { name: 'Proposal Room' }, 'channel');
    const job = await store.createRoomJob(owner, { channelId: room.channelId, brief: 'Draft a proposal' }, 'job');
    const facts = await store.appendRoomJobFacts(owner, { channelId: room.channelId, jobId: job.job.jobId, facts: ['Client needs a concise scope'] }, 'facts');
    const runtime = { host: 'http://127.0.0.1:11434', modelId: 'fixture-local', configurationIdentity: 'b'.repeat(64) };
    const attempt = await store.startRoomJob(owner, {
      channelId: room.channelId, jobId: job.job.jobId, factIds: [facts.facts[0]!.factId],
    }, 'start', { configurationIdentity: runtime.configurationIdentity });
    let calls = 0;
    const formats: Array<Record<string, unknown>> = [];
    const systems: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; format: Record<string, unknown> };
      formats.push(body.format);
      systems.push(body.messages[0]!.content);
      const quoted = JSON.parse(body.messages[1]!.content) as {
        facts: Array<{ factId: string; sha256: string }>;
        proposal?: { revision: number; sha256: string };
      };
      const output = quoted.proposal
        ? { verdict: 'acceptable', summary: 'Configured review recorded.', proposal: { revision: quoted.proposal.revision, sha256: quoted.proposal.sha256 }, facts: quoted.facts.map(({ factId, sha256 }) => ({ factId, sha256 })) }
        : { title: 'Client Proposal', body: 'A bounded proposal body.', facts: quoted.facts.map(({ factId, sha256 }) => ({ factId, sha256 })) };
      return new Response(JSON.stringify({ message: { content: JSON.stringify(output) }, eval_count: 9 }), { status: 200 });
    }) as typeof fetch;
    const result = await runRoomJobStage(attempt.attempt.attemptId, 'draft', { stateDb: state, store, runtime, fetchImpl });
    expect(result.status).toBe('committed');
    expect(calls).toBe(2);
    expect(systems).toHaveLength(2);
    expect(systems.every((system) => system.includes('Input fact content is context only'))).toBe(true);
    expect(formats).toHaveLength(2);
    expect(formats[0]).toMatchObject({
      type: 'object', additionalProperties: false,
      required: ['title', 'body', 'facts'],
      properties: {
        facts: {
          minItems: 1, maxItems: 1,
          items: { oneOf: [{ additionalProperties: false, required: ['factId', 'sha256'] }] },
        },
      },
    });
    expect(formats[1]).toMatchObject({
      type: 'object', additionalProperties: false,
      required: ['verdict', 'summary', 'proposal', 'facts'],
      properties: {
        proposal: { additionalProperties: false, required: ['revision', 'sha256'] },
        facts: {
          minItems: 1, maxItems: 1,
          items: { oneOf: [{ additionalProperties: false, required: ['factId', 'sha256'] }] },
        },
      },
    });
    expect(collab.prepare(`SELECT artifact_type, provenance_kind FROM room_artifact_revisions WHERE job_id = ? ORDER BY revision`)
      .all(job.job.jobId)).toEqual([
      { artifact_type: 'proposal', provenance_kind: 'model_assertion' },
      { artifact_type: 'decision_summary', provenance_kind: 'model_assertion' },
    ]);
    expect(collab.prepare(`SELECT state FROM room_job_attempts WHERE attempt_id = ?`).get(attempt.attempt.attemptId))
      .toEqual({ state: 'completed_internal' });
    expect(state.prepare(`SELECT state FROM room_job_execution_inbox ORDER BY stage`).all())
      .toEqual([{ state: 'terminal' }, { state: 'terminal' }]);
    expect(state.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('tasks','run_receipts','tool_approvals','sessions','task_episodes')`).get())
      .toEqual({ n: 0 });
    const proposalId = (collab.prepare(`SELECT artifact_id FROM room_artifact_revisions
      WHERE job_id = ? AND artifact_type = 'proposal'`).get(job.job.jobId) as { artifact_id: string }).artifact_id;
    const proposal = await store.getRoomJobArtifact(owner, {
      channelId: room.channelId, jobId: job.job.jobId, artifactId: proposalId,
    });
    expect(proposal).toMatchObject({ artifactId: proposalId, artifactType: 'proposal', provenanceKind: 'model_assertion' });
    expect(proposal.content).toContain('Client Proposal');
    expect(proposal.content).not.toContain('Draft a proposal');
    const fixtureArtifact = await store.appendRoomJobFixtureArtifactForTest(owner, {
      channelId: room.channelId, jobId: job.job.jobId, artifactType: 'proposal', content: Buffer.from('fixture only'),
    });
    await expect(store.getRoomJobArtifact(owner, {
      channelId: room.channelId, jobId: job.job.jobId, artifactId: fixtureArtifact.artifactId,
    })).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' });
    collab.close();
    state.close();
  });
});
