import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  runCollaborationMigration,
  runRoomJobFoundationMigration,
  runRoomJobExecutionMigration,
} from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { CollabError, CollaborationStore, type CallerContext } from '../../packages/collab/src/store.js';
import { ClientCommandSchema } from '@torqclaw/contracts';

function makeFixture(id: string) {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  runRoomJobFoundationMigration(sqlite);
  runRoomJobExecutionMigration(sqlite);
  const db: BootstrapDb = {
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids(id);
  const bootstrap = bootstrapOperator(
    { db, clock, uuids, rng: nodeRandomSource, secretStore: new InMemorySecretStore() },
    { operatorDisplayName: 'Owner', installationId: `installation-${id}`, schemaVersion: 1 },
  );
  const store = new CollaborationStore({
    db, clock, uuids, rng: nodeRandomSource, principalPepper: bootstrap.principalPepper,
  });
  const owner: CallerContext = { principalId: bootstrap.operatorPrincipalId, kind: 'operator' };
  return { sqlite, store, owner };
}

describe('room-job execution intent', () => {
  it('admits facts/start without accepting any internal run, target, tool, or delivery fields', () => {
    const fact = ClientCommandSchema.safeParse({
      action: 'ADD_ROOM_JOB_FACTS', channelId: 'room', jobId: '00000000-0000-4000-8000-000000000001',
      facts: ['one'], idempotencyKey: '00000000-0000-4000-8000-000000000002',
      tools: ['send_email'], target: 'remote', requestId: 'spoofed',
    });
    expect(fact.success).toBe(true);
    if (fact.success) {
      expect(Object.keys(fact.data).sort()).toEqual(['action', 'channelId', 'facts', 'idempotencyKey', 'jobId']);
    }
    const start = ClientCommandSchema.safeParse({
      action: 'START_ROOM_JOB', channelId: 'room', jobId: '00000000-0000-4000-8000-000000000001',
      factIds: ['00000000-0000-4000-8000-000000000003'],
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
      modelId: 'anything', tools: [], executionMode: 'CLOUD_OK',
    });
    expect(start.success).toBe(true);
    if (start.success) {
      expect(Object.keys(start.data).sort()).toEqual(['action', 'channelId', 'factIds', 'idempotencyKey', 'jobId']);
    }
  });

  it('migrates losslessly, appends immutable facts, and produces one replay-safe draft outbox intent', async () => {
    const { sqlite, store, owner } = makeFixture('execution-intent');
    const room = await store.createChannel(owner, { name: 'Client brief' }, 'channel-key');
    const job = await store.createRoomJob(owner, { channelId: room.channelId, brief: 'Prepare a proposal' }, 'job-key');
    const facts = await store.appendRoomJobFacts(owner, {
      channelId: room.channelId, jobId: job.job.jobId, facts: ['Source one', 'Source two'],
    }, 'facts-key');
    expect(facts.facts.map((fact) => fact.ordinal)).toEqual([1, 2]);
    const first = await store.startRoomJob(owner, {
      channelId: room.channelId, jobId: job.job.jobId, factIds: facts.facts.map((fact) => fact.factId),
    }, 'start-key');
    const replay = await store.startRoomJob(owner, {
      channelId: room.channelId, jobId: job.job.jobId, factIds: facts.facts.map((fact) => fact.factId),
    }, 'start-key');
    expect(replay).toEqual(first);
    expect(sqlite.prepare(`SELECT stage, state FROM room_job_outbox WHERE attempt_id = ?`)
      .all(first.attempt.attemptId)).toEqual([{ stage: 'draft', state: 'pending' }]);
    const raw = sqlite.prepare(`SELECT content FROM room_job_fact_revisions WHERE job_id = ? ORDER BY ordinal`)
      .all(job.job.jobId) as Array<{ content: Buffer }>;
    expect(raw.map((row) => row.content.toString('utf8'))).toEqual(['Source one', 'Source two']);
    const event = sqlite.prepare(`SELECT content_json FROM collab_events WHERE kind = 'room_job_attempt_started'`)
      .get() as { content_json: string };
    expect(JSON.parse(event.content_json)).toEqual({
      attemptId: first.attempt.attemptId, jobId: job.job.jobId, revision: 1, state: 'created',
    });
    expect(JSON.stringify(event)).not.toContain('Source one');
    sqlite.close();
  });

  it('fences pending work on cancellation and denies hidden or non-owner mutations', async () => {
    const { sqlite, store, owner } = makeFixture('execution-cancel');
    const room = await store.createChannel(owner, { name: 'Private job' }, 'channel-key');
    const job = await store.createRoomJob(owner, { channelId: room.channelId, brief: 'Brief' }, 'job-key');
    const facts = await store.appendRoomJobFacts(owner, {
      channelId: room.channelId, jobId: job.job.jobId, facts: ['Fact'],
    }, 'facts-key');
    const started = await store.startRoomJob(owner, {
      channelId: room.channelId, jobId: job.job.jobId, factIds: [facts.facts[0]!.factId],
    }, 'start-key');
    await store.cancelRoomJob(owner, {
      channelId: room.channelId, jobId: job.job.jobId, expectedRevision: 1,
    }, 'cancel-key');
    expect(sqlite.prepare(`SELECT execution_generation FROM room_jobs WHERE job_id = ?`).get(job.job.jobId))
      .toEqual({ execution_generation: 2 });
    expect(sqlite.prepare(`SELECT state FROM room_job_outbox WHERE attempt_id = ?`).get(started.attempt.attemptId))
      .toEqual({ state: 'cancelled' });
    expect(sqlite.prepare(`SELECT state, terminal_reason FROM room_job_attempts WHERE attempt_id = ?`).get(started.attempt.attemptId))
      .toEqual({ state: 'cancelled', terminal_reason: 'room_job_cancelled' });
    const outsider = await store.createAgent(owner, { displayName: 'Outsider' }, 'agent-key');
    const outsiderCaller: CallerContext = { principalId: outsider.principalId, kind: 'agent' };
    await expect(store.appendRoomJobFacts(outsiderCaller, {
      channelId: room.channelId, jobId: job.job.jobId, facts: ['nope'],
    }, 'other-facts')).rejects.toMatchObject({ code: 'COLLAB_NOT_FOUND' } satisfies Partial<CollabError>);
    sqlite.close();
  });
});
