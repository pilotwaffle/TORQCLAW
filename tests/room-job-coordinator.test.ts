import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  runCollaborationMigration, runRoomJobExecutionArtifactBindingMigration, runRoomJobExecutionMigration, runRoomJobFoundationMigration,
} from '../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../packages/collab/src/store.js';
import { runRoomJobStage } from '../packages/gateway/src/roomJobExecution.js';

function fixture() {
  const collab = new Database(':memory:');
  runCollaborationMigration(collab);
  runRoomJobFoundationMigration(collab);
  runRoomJobExecutionMigration(collab);
  runRoomJobExecutionArtifactBindingMigration(collab);
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
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
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
    collab.close();
    state.close();
  });
});
