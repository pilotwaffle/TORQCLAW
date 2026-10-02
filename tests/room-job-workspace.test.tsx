// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import { parseRoomJobEnvelope, visibleRoomJobDetail } from '../apps/console/src/components/roomJobView.js';

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
        job: { ...job, lifecycle: [{ jobSeq: 1, kind: 'not-a-kind', state: 'created', revision: 1, occurredAt: 'now' }], artifacts: [] },
      },
    }))).toBeNull();
  });

  it('filters test-only fixture artifacts and their matching lifecycle revision', () => {
    const visible = visibleRoomJobDetail({
      ...job,
      lifecycle: [
        { jobSeq: 1, kind: 'created', state: 'created', revision: 1, occurredAt: 'first' },
        { jobSeq: 2, kind: 'artifact_committed', state: 'created', revision: 2, occurredAt: 'fixture' },
      ],
      artifacts: [{
        artifactId: '00000000-0000-4000-8000-000000000012', artifactType: 'proposal', revision: 2,
        schemaVersion: 1, provenanceKind: 'test_fixture', sha256: 'abc', createdAt: 'fixture',
      }],
    });
    expect(visible.artifacts).toEqual([]);
    expect(visible.lifecycle).toEqual([{ jobSeq: 1, kind: 'created', state: 'created', revision: 1, occurredAt: 'first' }]);
  });
});
