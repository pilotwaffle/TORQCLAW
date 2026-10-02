import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  runCollaborationMigration,
  runRoomJobFoundationMigration,
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
  return { sqlite, db, store, owner };
}

describe('room-job foundation', () => {
  it('admits only the bounded room-job command shapes at the public contract boundary', () => {
    expect(ClientCommandSchema.safeParse({
      action: 'CREATE_ROOM_JOB', channelId: 'channel', brief: 'brief',
      idempotencyKey: '00000000-0000-4000-8000-000000000001',
    }).success).toBe(true);
    const stripped = ClientCommandSchema.safeParse({
      action: 'CANCEL_ROOM_JOB', channelId: 'channel', jobId: '00000000-0000-4000-8000-000000000002',
      expectedRevision: 1, idempotencyKey: '00000000-0000-4000-8000-000000000003',
      artifactBytes: 'not-a-permitted-field',
    });
    expect(stripped.success).toBe(true);
    if (stripped.success) expect('artifactBytes' in stripped.data).toBe(false);
  });

  it('adds the foundation migration to an existing collaboration ledger without losing prior events', async () => {
    const sqlite = new Database(':memory:');
    runCollaborationMigration(sqlite);
    const existing = {
      id: '00000000-0000-4000-8000-000000000001',
      channelId: '00000000-0000-4000-8000-000000000002',
      principalId: '00000000-0000-4000-8000-000000000003',
    };
    sqlite.exec(`INSERT INTO principals(id, kind, display_name, status, auth_epoch, created_at, updated_at)
      VALUES('${existing.principalId}', 'operator', 'Owner', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO collab_channels(id, owner_principal_id, name, name_key, state, channel_epoch, created_at, updated_at)
      VALUES('${existing.channelId}', '${existing.principalId}', 'Existing', 'existing', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at)
      VALUES('${existing.id}', 1, '${existing.channelId}', 1, '${existing.principalId}', 'channel_created', '{}', '2026-01-01T00:00:00.000Z');`);
    runRoomJobFoundationMigration(sqlite);
    runRoomJobFoundationMigration(sqlite);
    expect(sqlite.prepare('SELECT id, kind FROM collab_events').all()).toEqual([
      { id: existing.id, kind: 'channel_created' },
    ]);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM collab_schema_migrations
      WHERE id = '20261002_001_room_job_foundation_v1'`).get()).toEqual({ n: 1 });
    sqlite.close();
  });

  it('migrates losslessly and records an owner-created, non-worker job with constrained evidence', async () => {
    const { sqlite, store, owner } = makeFixture('room-job-created');
    const room = await store.createChannel(owner, { name: 'Client brief' }, 'channel-key');
    const created = await store.createRoomJob(owner, { channelId: room.channelId, brief: 'Northwind proposal brief' }, 'job-key');

    expect(created.job).toMatchObject({
      channelId: room.channelId, state: 'created', revision: 1, briefByteLength: 24,
      capabilities: { canCreate: true, canCancel: true },
    });
    expect('brief' in created.job).toBe(false);

    const detail = await store.getRoomJob(owner, { channelId: room.channelId, jobId: created.job.jobId });
    expect(detail.lifecycle).toEqual([expect.objectContaining({ jobSeq: 1, kind: 'created', state: 'created', revision: 1 })]);
    expect(detail.artifacts).toEqual([]);

    const event = sqlite.prepare(`SELECT kind, content_json AS contentJson FROM collab_events
      WHERE channel_id = ? AND kind = 'room_job_created'`).get(room.channelId) as { kind: string; contentJson: string };
    expect(event.kind).toBe('room_job_created');
    expect(JSON.parse(event.contentJson)).toEqual({ jobId: created.job.jobId, state: 'created', revision: 1 });
    sqlite.close();
  });

  it('replays one creation, rejects mismatched replay, and records cancellation evidence without a worker', async () => {
    const { sqlite, store, owner } = makeFixture('room-job-idempotency');
    const room = await store.createChannel(owner, { name: 'Idempotency room' }, 'channel-key');
    const first = await store.createRoomJob(owner, { channelId: room.channelId, brief: 'Brief A' }, 'job-key');
    const replay = await store.createRoomJob(owner, { channelId: room.channelId, brief: 'Brief A' }, 'job-key');
    expect(replay).toEqual(first);
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM room_jobs').get() as { n: number }).n).toBe(1);
    await expect(store.createRoomJob(owner, { channelId: room.channelId, brief: 'Brief B' }, 'job-key'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' } satisfies Partial<CollabError>);

    const cancelled = await store.cancelRoomJob(owner, {
      channelId: room.channelId, jobId: first.job.jobId, expectedRevision: 1,
    }, 'cancel-key');
    expect(cancelled).toMatchObject({ state: 'cancelled', revision: 2, capabilities: { canCancel: false } });
    const cancelReplay = await store.cancelRoomJob(owner, {
      channelId: room.channelId, jobId: first.job.jobId, expectedRevision: 1,
    }, 'cancel-key');
    expect(cancelReplay).toEqual(cancelled);
    await expect(store.cancelRoomJob(owner, {
      channelId: room.channelId, jobId: first.job.jobId, expectedRevision: 1,
    }, 'another-cancel-key')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const lifecycle = sqlite.prepare('SELECT kind, state, revision FROM room_job_events WHERE job_id = ? ORDER BY job_seq')
      .all(first.job.jobId) as Array<{ kind: string; state: string; revision: number }>;
    expect(lifecycle).toEqual([
      { kind: 'created', state: 'created', revision: 1 },
      { kind: 'cancel_requested', state: 'created', revision: 1 },
      { kind: 'cancelled', state: 'cancelled', revision: 2 },
    ]);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM collab_events WHERE channel_id = ?
      AND kind IN ('room_job_cancel_requested','room_job_cancelled')`).get(room.channelId) as { n: number }).n).toBe(2);
    sqlite.close();
  });

  it('keeps fixture-only immutable BLOB bytes hash-bound and excludes them from the detail projection', async () => {
    const { sqlite, store, owner } = makeFixture('room-job-artifact');
    const room = await store.createChannel(owner, { name: 'Artifact room' }, 'channel-key');
    const job = await store.createRoomJob(owner, { channelId: room.channelId, brief: 'Brief' }, 'job-key');
    const content = Buffer.from('fixture proposal v1', 'utf8');
    const artifact = await store.appendRoomJobFixtureArtifactForTest(owner, {
      channelId: room.channelId, jobId: job.job.jobId, artifactType: 'proposal', content,
    });
    expect(artifact).toMatchObject({
      provenanceKind: 'test_fixture', sha256: createHash('sha256').update(content).digest('hex'),
    });
    const raw = sqlite.prepare('SELECT content, sha256 FROM room_artifact_revisions WHERE artifact_id = ?')
      .get(artifact.artifactId) as { content: Buffer; sha256: string };
    expect(raw.content.equals(content)).toBe(true);
    expect(raw.sha256).toBe(artifact.sha256);
    const detail = await store.getRoomJob(owner, { channelId: room.channelId, jobId: job.job.jobId });
    expect(detail.artifacts).toEqual([artifact]);
    expect(JSON.stringify(detail)).not.toContain('fixture proposal v1');
    sqlite.close();
  });

  it('keeps hidden and non-owner job operations indistinguishable', async () => {
    const { sqlite, store, owner } = makeFixture('room-job-authz');
    const room = await store.createChannel(owner, { name: 'Private room' }, 'channel-key');
    const outsider = await store.createAgent(owner, { displayName: 'Outsider' }, 'agent-key');
    const outsiderCaller: CallerContext = { principalId: outsider.principalId, kind: 'agent' };
    const hidden = await Promise.allSettled([
      store.listRoomJobs(outsiderCaller, { channelId: room.channelId, cursor: '0', limit: 20 }),
      store.listRoomJobs(outsiderCaller, { channelId: 'no-such-room', cursor: '0', limit: 20 }),
      store.createRoomJob(outsiderCaller, { channelId: room.channelId, brief: 'x' }, 'outsider-key'),
    ]);
    for (const result of hidden) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'COLLAB_NOT_FOUND' });
    }
    sqlite.close();
  });

  it('publishes only versioned, non-sensitive room-job result envelopes from the gateway surface', async () => {
    const { sqlite, db, store, owner } = makeFixture('room-job-surface');
    const room = await store.createChannel(owner, { name: 'Surface room' }, 'channel-key');
    const surface = await import('../../packages/gateway/src/collabSurface.js');
    const { sessionBus } = await import('../../packages/gateway/src/events.js');
    const frames: Array<{ metadata?: unknown }> = [];
    const sessionId = '00000000-0000-4000-8000-000000000004';
    const unsubscribe = sessionBus.subscribe(sessionId, (event) => frames.push({ metadata: event.metadata }));
    surface.setCollabSurfaceStoreForTest(store);
    surface.setCollabSurfaceKindLookupDbForTest(db);
    try {
      expect(await surface.handleCreateRoomJob(sessionId, owner.principalId, {
        channelId: room.channelId, brief: 'Bounded brief', idempotencyKey: 'surface-create-key',
      })).toBeNull();
      const created = frames.at(-1)?.metadata as { roomJob: { version: number; kind: string; job: { jobId: string } } };
      expect(created.roomJob).toMatchObject({ version: 1, kind: 'created' });
      expect(JSON.stringify(created)).not.toContain('Bounded brief');

      expect(await surface.handleGetRoomJob(sessionId, owner.principalId, {
        channelId: room.channelId, jobId: created.roomJob.job.jobId,
      })).toBeNull();
      expect((frames.at(-1)?.metadata as { roomJob: { kind: string } }).roomJob.kind).toBe('detail');
    } finally {
      unsubscribe();
      surface.setCollabSurfaceStoreForTest(null);
      surface.setCollabSurfaceKindLookupDbForTest(null);
      sqlite.close();
    }
  });
});
