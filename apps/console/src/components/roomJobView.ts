import type { GatewayEvent } from '@torqclaw/contracts';

export type RoomJobState = 'created' | 'cancelled';
export type RoomJobLifecycleKind = 'created' | 'cancel_requested' | 'cancelled' | 'artifact_committed';
export type RoomArtifactType = 'proposal' | 'decision_summary' | 'research_source' | 'independent_review';
export type RoomArtifactProvenance = 'user_provided' | 'tool_observed' | 'model_assertion' | 'test_fixture';

export interface RoomJobCapabilities {
  canCreate: boolean;
  canCancel: boolean;
}

export interface RoomJobListEntry {
  jobId: string;
  channelId: string;
  state: RoomJobState;
  revision: number;
  createdAt: string;
  cancelledAt: string | null;
  briefByteLength: number;
  capabilities: RoomJobCapabilities;
}

export interface RoomJobLifecycleEntry {
  jobSeq: number;
  kind: RoomJobLifecycleKind;
  state: RoomJobState;
  revision: number;
  occurredAt: string;
}

export interface RoomJobArtifactMetadata {
  artifactId: string;
  artifactType: RoomArtifactType;
  revision: number;
  schemaVersion: 1;
  provenanceKind: RoomArtifactProvenance;
  sha256: string;
  createdAt: string;
}

export interface RoomJobDetail extends RoomJobListEntry {
  lifecycle: RoomJobLifecycleEntry[];
  artifacts: RoomJobArtifactMetadata[];
}

export type RoomJobEnvelope =
  | { kind: 'created' | 'cancelled'; idempotencyKey: string; job: RoomJobListEntry }
  | { kind: 'list'; channelId: string; jobs: RoomJobListEntry[]; nextCursor: string; hasMore: boolean; capabilities: Pick<RoomJobCapabilities, 'canCreate'> }
  | { kind: 'detail'; job: RoomJobDetail };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const UNSIGNED_CURSOR = /^(0|[1-9][0-9]*)$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function cursor(value: unknown): value is string {
  return typeof value === 'string' && UNSIGNED_CURSOR.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function roomJobState(value: unknown): value is RoomJobState {
  return value === 'created' || value === 'cancelled';
}

function capabilities(value: unknown, includeCancel: boolean): RoomJobCapabilities | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.canCreate !== 'boolean') return null;
  if (includeCancel && typeof candidate.canCancel !== 'boolean') return null;
  return { canCreate: candidate.canCreate, canCancel: candidate.canCancel === true };
}

export function parseRoomJobListEntry(value: unknown): RoomJobListEntry | null {
  const candidate = record(value);
  if (!candidate || !uuid(candidate.jobId) || !nonEmptyString(candidate.channelId) ||
      !roomJobState(candidate.state) || !positiveInteger(candidate.revision) ||
      !timestamp(candidate.createdAt) ||
      !(candidate.cancelledAt === null || timestamp(candidate.cancelledAt)) ||
      !Number.isSafeInteger(candidate.briefByteLength) || (candidate.briefByteLength as number) < 1 || (candidate.briefByteLength as number) > 16384) return null;
  const parsedCapabilities = capabilities(candidate.capabilities, true);
  if (!parsedCapabilities) return null;
  if ((candidate.state === 'created' && candidate.cancelledAt !== null) ||
      (candidate.state === 'cancelled' && candidate.cancelledAt === null) ||
      (candidate.state === 'cancelled' && parsedCapabilities.canCancel)) return null;
  return {
    jobId: candidate.jobId,
    channelId: candidate.channelId,
    state: candidate.state,
    revision: candidate.revision,
    createdAt: candidate.createdAt,
    cancelledAt: candidate.cancelledAt,
    briefByteLength: candidate.briefByteLength as number,
    capabilities: parsedCapabilities,
  };
}

function parseLifecycle(value: unknown): RoomJobLifecycleEntry | null {
  const candidate = record(value);
  if (!candidate || !positiveInteger(candidate.jobSeq) ||
      !['created', 'cancel_requested', 'cancelled', 'artifact_committed'].includes(candidate.kind as string) ||
      !roomJobState(candidate.state) || !positiveInteger(candidate.revision) || !timestamp(candidate.occurredAt)) return null;
  if ((candidate.kind === 'cancelled' && candidate.state !== 'cancelled') ||
      (candidate.kind !== 'cancelled' && candidate.state !== 'created')) return null;
  return {
    jobSeq: candidate.jobSeq,
    kind: candidate.kind as RoomJobLifecycleKind,
    state: candidate.state,
    revision: candidate.revision,
    occurredAt: candidate.occurredAt,
  };
}

function parseArtifact(value: unknown): RoomJobArtifactMetadata | null {
  const candidate = record(value);
  if (!candidate || !uuid(candidate.artifactId) ||
      !['proposal', 'decision_summary', 'research_source', 'independent_review'].includes(candidate.artifactType as string) ||
      !positiveInteger(candidate.revision) || candidate.schemaVersion !== 1 ||
      !['user_provided', 'tool_observed', 'model_assertion', 'test_fixture'].includes(candidate.provenanceKind as string) ||
      !(typeof candidate.sha256 === 'string' && SHA256.test(candidate.sha256)) || !timestamp(candidate.createdAt)) return null;
  return {
    artifactId: candidate.artifactId,
    artifactType: candidate.artifactType as RoomArtifactType,
    revision: candidate.revision,
    schemaVersion: 1,
    provenanceKind: candidate.provenanceKind as RoomArtifactProvenance,
    sha256: candidate.sha256,
    createdAt: candidate.createdAt,
  };
}

export function parseRoomJobEnvelope(event: GatewayEvent): RoomJobEnvelope | null {
  if (event.type !== 'SYSTEM') return null;
  const metadata = record(event.metadata);
  const roomJob = record(metadata?.roomJob);
  if (!roomJob || roomJob.version !== 1 || typeof roomJob.kind !== 'string') return null;

  if (roomJob.kind === 'created' || roomJob.kind === 'cancelled') {
    const job = parseRoomJobListEntry(roomJob.job);
    return job && uuid(roomJob.idempotencyKey)
      ? { kind: roomJob.kind, idempotencyKey: roomJob.idempotencyKey, job }
      : null;
  }
  if (roomJob.kind === 'list') {
    if (!nonEmptyString(roomJob.channelId) || !Array.isArray(roomJob.jobs) ||
        !cursor(roomJob.nextCursor) || typeof roomJob.hasMore !== 'boolean') return null;
    const listCapabilities = capabilities(roomJob.capabilities, false);
    const jobs = roomJob.jobs.map(parseRoomJobListEntry);
    if (!listCapabilities || jobs.some((job) => job === null)) return null;
    const uniqueIds = new Set<string>();
    for (const job of jobs as RoomJobListEntry[]) {
      if (job.channelId !== roomJob.channelId || uniqueIds.has(job.jobId)) return null;
      uniqueIds.add(job.jobId);
    }
    return { kind: 'list', channelId: roomJob.channelId, jobs: jobs as RoomJobListEntry[], nextCursor: roomJob.nextCursor, hasMore: roomJob.hasMore, capabilities: { canCreate: listCapabilities.canCreate } };
  }
  if (roomJob.kind === 'detail') {
    const job = parseRoomJobListEntry(roomJob.job);
    const detail = record(roomJob.job);
    if (!job || !detail || !Array.isArray(detail.lifecycle) || !Array.isArray(detail.artifacts)) return null;
    const lifecycle = detail.lifecycle.map(parseLifecycle);
    const artifacts = detail.artifacts.map(parseArtifact);
    if (lifecycle.some((entry) => entry === null) || artifacts.some((artifact) => artifact === null)) return null;
    const sequence = new Set<number>();
    const artifactIds = new Set<string>();
    let previousSequence = 0;
    for (const entry of lifecycle as RoomJobLifecycleEntry[]) {
      if (sequence.has(entry.jobSeq) || entry.jobSeq <= previousSequence) return null;
      sequence.add(entry.jobSeq);
      previousSequence = entry.jobSeq;
    }
    for (const artifact of artifacts as RoomJobArtifactMetadata[]) {
      if (artifactIds.has(artifact.artifactId)) return null;
      artifactIds.add(artifact.artifactId);
    }
    return { kind: 'detail', job: { ...job, lifecycle: lifecycle as RoomJobLifecycleEntry[], artifacts: artifacts as RoomJobArtifactMetadata[] } };
  }
  return null;
}

export function visibleRoomJobDetail(detail: RoomJobDetail): RoomJobDetail {
  const fixtureRevisions = new Set(detail.artifacts
    .filter((artifact) => artifact.provenanceKind === 'test_fixture')
    .map((artifact) => artifact.revision));
  return {
    ...detail,
    artifacts: detail.artifacts.filter((artifact) => artifact.provenanceKind !== 'test_fixture'),
    lifecycle: detail.lifecycle.filter((entry) => !(entry.kind === 'artifact_committed' && fixtureRevisions.has(entry.revision))),
  };
}
