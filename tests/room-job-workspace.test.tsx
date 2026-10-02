// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import { RoomJobExecutionWorkspace } from '../apps/console/src/components/RoomJobWorkspace.js';
import type { RoomJobArtifactContent, RoomJobExecutionDetail } from '../apps/console/src/components/roomJobView.js';
import { isCurrentRoomJobArtifact, parseRoomJobEnvelope, parseRoomJobExecutionEnvelope, visibleRoomJobDetail } from '../apps/console/src/components/roomJobView.js';

function event(metadata: unknown): GatewayEvent {
  return {
    id: 'room-job-event', requestId: null, sessionId: 'session', tier: null,
    type: 'SYSTEM', message: '', timestamp: '2026-10-02T00:00:00.000Z', metadata,
  } as GatewayEvent;
}

const job = {
  jobId: '00000000-0000-4000-8000-000000000011', channelId: 'room-a', state: 'created', revision: 2,
  createdAt: '2026-10-02T00:00:00.000Z', cancelledAt: null, briefByteLength: 12,
  capabilities: { canCreate: true, canCancel: true },
};
const iso = '2026-10-02T00:00:00.000Z';
const sha256 = 'a'.repeat(64);
const helloSha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Room Job UI runtime boundary', () => {
  it('accepts only the typed v1 list envelope and strips unapproved fields', () => {
    const parsed = parseRoomJobEnvelope(event({ roomJob: {
      version: 1, kind: 'list', channelId: 'room-a', nextCursor: '2', hasMore: false,
      capabilities: { canCreate: true, ownerId: 'must-not-render' },
      jobs: [{ ...job, brief: 'must-not-render', provider: 'must-not-render' }],
    } }));
    expect(parsed).toEqual({
      kind: 'list', channelId: 'room-a', nextCursor: '2', hasMore: false,
      capabilities: { canCreate: true }, jobs: [job],
    });
  });

  it('rejects malformed, cross-room, and unversioned envelopes', () => {
    expect(parseRoomJobEnvelope(event({ roomJob: { version: 2, kind: 'list', channelId: 'room-a', jobs: [], nextCursor: '0', hasMore: false, capabilities: { canCreate: true } } }))).toBeNull();
    expect(parseRoomJobEnvelope(event({ roomJob: { version: 1, kind: 'list', channelId: 'room-a', jobs: [{ ...job, channelId: 'room-b' }], nextCursor: '0', hasMore: false, capabilities: { canCreate: true } } }))).toBeNull();
    expect(parseRoomJobEnvelope(event({
      roomJob: {
        version: 1,
        kind: 'detail',
        job: { ...job, lifecycle: [{ jobSeq: 1, kind: 'not-a-kind', state: 'created', revision: 1, occurredAt: iso }], artifacts: [] },
      },
    }))).toBeNull();
  });

  it('filters test-only fixture artifacts and their matching lifecycle revision', () => {
    const visible = visibleRoomJobDetail({
      ...job,
      lifecycle: [
        { jobSeq: 1, kind: 'created', state: 'created', revision: 1, occurredAt: iso },
        { jobSeq: 2, kind: 'artifact_committed', state: 'created', revision: 2, occurredAt: iso },
      ],
      artifacts: [{
        artifactId: '00000000-0000-4000-8000-000000000012', artifactType: 'proposal', revision: 2,
        schemaVersion: 1, provenanceKind: 'test_fixture', sha256, createdAt: iso,
      }],
    });
    expect(visible.artifacts).toEqual([]);
    expect(visible.lifecycle).toEqual([{ jobSeq: 1, kind: 'created', state: 'created', revision: 1, occurredAt: iso }]);
  });

  it('fails closed on hostile IDs, timestamps, cursors, bounds, order, and duplicate artifact metadata', () => {
    const detail = {
      ...job,
      lifecycle: [
        { jobSeq: 2, kind: 'created', state: 'created', revision: 1, occurredAt: iso },
        { jobSeq: 1, kind: 'artifact_committed', state: 'created', revision: 1, occurredAt: iso },
      ],
      artifacts: [
        { artifactId: '00000000-0000-4000-8000-000000000012', artifactType: 'proposal', revision: 1, schemaVersion: 1, provenanceKind: 'user_provided', sha256, createdAt: iso },
        { artifactId: '00000000-0000-4000-8000-000000000012', artifactType: 'proposal', revision: 2, schemaVersion: 1, provenanceKind: 'user_provided', sha256, createdAt: iso },
      ],
    };
    expect(parseRoomJobEnvelope(event({ roomJob: { version: 1, kind: 'detail', job: detail } }))).toBeNull();
    expect(parseRoomJobEnvelope(event({ roomJob: { version: 1, kind: 'list', channelId: 'room-a', jobs: [{ ...job, jobId: 'not-a-uuid' }], nextCursor: '0', hasMore: false, capabilities: { canCreate: true } } }))).toBeNull();
    expect(parseRoomJobEnvelope(event({ roomJob: { version: 1, kind: 'list', channelId: 'room-a', jobs: [{ ...job, createdAt: 'not-a-time' }], nextCursor: '0', hasMore: false, capabilities: { canCreate: true } } }))).toBeNull();
    expect(parseRoomJobEnvelope(event({ roomJob: { version: 1, kind: 'list', channelId: 'room-a', jobs: [{ ...job, briefByteLength: 16385 }], nextCursor: 'not-a-cursor', hasMore: false, capabilities: { canCreate: true } } }))).toBeNull();
    expect(parseRoomJobEnvelope(event({ roomJob: { version: 1, kind: 'detail', job: { ...job, lifecycle: [], artifacts: [{ artifactId: '00000000-0000-4000-8000-000000000012', artifactType: 'proposal', revision: 1, schemaVersion: 1, provenanceKind: 'user_provided', sha256: 'bad', createdAt: iso }] } } }))).toBeNull();
  });

  it('keeps default v1 parsing separate from opt-in execution_v2 detail', () => {
    const v2 = event({ roomJob: {
      version: 2, kind: 'execution_detail', channelId: 'room-a',
      job: {
        ...job,
        lifecycle: [{ jobSeq: 1, kind: 'attempt_started', state: 'created', revision: 2, occurredAt: iso }],
        artifacts: [],
      },
      execution: {
        observedAt: iso,
        capabilities: { canAddFacts: true, canStart: true, runtime: 'ready' },
        facts: [{ factId: '00000000-0000-4000-8000-000000000013', ordinal: 1, sha256, createdAt: iso }],
        latestAttempt: { state: 'queued', terminalCode: null, updatedAt: iso },
      },
    } });
    expect(parseRoomJobEnvelope(v2)).toBeNull();
    expect(parseRoomJobExecutionEnvelope(v2)).toEqual({
      kind: 'execution_detail',
      detail: {
        channelId: 'room-a',
        job: { ...job, lifecycle: [{ jobSeq: 1, kind: 'attempt_started', state: 'created', revision: 2, occurredAt: iso }], artifacts: [] },
        execution: {
          observedAt: iso,
          capabilities: { canAddFacts: true, canStart: true, runtime: 'ready' },
          facts: [{ factId: '00000000-0000-4000-8000-000000000013', ordinal: 1, sha256, createdAt: iso }],
          latestAttempt: { state: 'queued', terminalCode: null, updatedAt: iso },
        },
      },
    });
  });

  it('fails closed for unsafe v2 capabilities, fact order, terminal codes, and artifact contexts', () => {
    const execution = {
      version: 2, kind: 'execution_detail', channelId: 'room-a',
      job: { ...job, lifecycle: [], artifacts: [] },
      execution: { observedAt: iso, capabilities: { canAddFacts: true, canStart: true, runtime: 'unknown' }, latestAttempt: null },
    };
    expect(parseRoomJobExecutionEnvelope(event({ roomJob: execution }))).toBeNull();
    expect(parseRoomJobExecutionEnvelope(event({ roomJob: {
      ...execution,
      execution: { ...execution.execution, capabilities: { canAddFacts: true, canStart: false, runtime: 'ready' }, latestAttempt: { state: 'validation_failed', terminalCode: 'raw failure text', updatedAt: iso } },
    } }))).toBeNull();

    const detail = parseRoomJobExecutionEnvelope(event({ roomJob: {
      ...execution,
      job: { ...execution.job, artifacts: [{ artifactId: '00000000-0000-4000-8000-000000000012', artifactType: 'proposal', revision: 2, schemaVersion: 1, provenanceKind: 'model_assertion', sha256, createdAt: iso }] },
      execution: { ...execution.execution, capabilities: { canAddFacts: false, canStart: false, runtime: 'unknown' } },
    } }));
    if (detail?.kind !== 'execution_detail') throw new Error('expected parsed execution detail');
    const artifact = parseRoomJobExecutionEnvelope(event({ roomJob: {
      version: 2, kind: 'artifact', channelId: 'room-a', jobId: job.jobId,
      artifact: { artifactId: '00000000-0000-4000-8000-000000000012', artifactType: 'proposal', revision: 2, schemaVersion: 1, provenanceKind: 'model_assertion', sha256, createdAt: iso, content: '{"title":"safe"}' },
    } }));
    if (artifact?.kind !== 'artifact') throw new Error('expected parsed artifact');
    expect(isCurrentRoomJobArtifact(detail.detail, artifact.artifact)).toBe(true);
    expect(isCurrentRoomJobArtifact(detail.detail, { ...artifact.artifact, jobId: '00000000-0000-4000-8000-000000000099' })).toBe(false);
    expect(parseRoomJobExecutionEnvelope(event({ roomJob: {
      version: 2, kind: 'artifact', channelId: 'room-a', jobId: job.jobId,
      artifact: { ...artifact.artifact, provenanceKind: 'test_fixture' },
    } }))).toBeNull();
  });

  it('shows locally usable output only after its selected artifact hash verifies', async () => {
    const bytesFor = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16))).buffer;
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => bytesFor(helloSha256)) } });
    const execution: RoomJobExecutionDetail = {
      channelId: 'room-a',
      job: {
        ...job,
        lifecycle: [],
        artifacts: [{ artifactId: '00000000-0000-4000-8000-000000000012', artifactType: 'proposal', revision: 2, schemaVersion: 1, provenanceKind: 'model_assertion', sha256: helloSha256, createdAt: iso }],
      },
      execution: { observedAt: iso, capabilities: { canAddFacts: false, canStart: false, runtime: 'unknown' }, latestAttempt: null },
    };
    const artifact: RoomJobArtifactContent = {
      channelId: 'room-a', jobId: job.jobId,
      artifactId: '00000000-0000-4000-8000-000000000012', artifactType: 'proposal', revision: 2,
      schemaVersion: 1, provenanceKind: 'model_assertion', sha256: helloSha256, createdAt: iso, content: 'hello',
    };
    const actions = { onAddFacts: vi.fn(), onStart: vi.fn(), onReadArtifact: vi.fn(), onRefresh: vi.fn() };
    const rendered = render(<RoomJobExecutionWorkspace detail={execution} artifact={artifact} actions={actions} />);
    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Copy locally' })).toBeInTheDocument();
    rendered.rerender(<RoomJobExecutionWorkspace detail={execution} artifact={{ ...artifact, sha256: 'b'.repeat(64) }} actions={actions} />);
    await waitFor(() => expect(screen.getByText('Validated output could not be verified and is not shown.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Copy locally' })).not.toBeInTheDocument();
  });
});
