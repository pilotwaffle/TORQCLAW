# Room Job Foundation — Wire Contract Handoff

**Date:** 2026-10-02  
**Scope:** approved no-worker `collab.db` foundation only  
**Status:** implementation contract for the pending UI-supplement review; not a grant to change the UI.

## Commands

All commands require the existing `TORQCLAW_COLLAB_ENABLED` and
`TORQCLAW_COLLAB_SURFACE_COMMANDS` gates, an operator gateway seat, and a
server-resolved collaboration principal. The gateway never accepts a principal,
owner, artifact path, artifact bytes, task, approval, receipt, recipient, or
provider field from a Room-job frame.

```ts
CREATE_ROOM_JOB { channelId, brief, idempotencyKey }
GET_ROOM_JOB    { channelId, jobId }
LIST_ROOM_JOBS  { channelId, cursor = '0', limit = 20 }
CANCEL_ROOM_JOB { channelId, jobId, expectedRevision, idempotencyKey }
```

`idempotencyKey` and `jobId` are UUIDs. `brief` is normalized by the existing
message-text validator (NFC, 1–16,384 UTF-8 bytes, rejected disallowed control
characters). A same `(principal, command, idempotencyKey, normalized body)`
replays its original result; a different body produces
`COLLAB_IDEMPOTENCY_CONFLICT`. A stale cancellation revision produces
`COLLAB_INVALID_REQUEST`. The client must not automatically retry or replay.

## Success envelopes

Each command publishes a normal `SYSTEM` event with this exact metadata shape:

```ts
{ roomJob: { version: 1, kind: 'created', idempotencyKey, job } }
{ roomJob: { version: 1, kind: 'list', channelId, jobs, nextCursor, hasMore, capabilities } }
{ roomJob: { version: 1, kind: 'detail', job } }
{ roomJob: { version: 1, kind: 'cancelled', idempotencyKey, job } }
```

The `idempotencyKey` is response correlation only for mutation confirmation.
`version` and `kind` must both match; unrelated or malformed SYSTEM events are
discarded. Errors retain the existing non-disclosing error envelopes:
`COLLAB_IDENTITY_REQUIRED`, `COLLAB_NOT_FOUND`,
`COLLAB_INVALID_REQUEST`, `COLLAB_CHANNEL_ARCHIVED`,
`COLLAB_IDEMPOTENCY_CONFLICT`, or `COLLAB_UNAVAILABLE`.

```ts
type RoomJobListEntry = {
  jobId: string;
  channelId: string;
  state: 'created' | 'cancelled';
  revision: number;
  createdAt: string;
  cancelledAt: string | null;
  briefByteLength: number; // no brief text is returned
  capabilities: { canCreate: boolean; canCancel: boolean };
};

type RoomJobDetail = RoomJobListEntry & {
  lifecycle: Array<{
    jobSeq: number;
    kind: 'created' | 'cancel_requested' | 'cancelled' | 'artifact_committed';
    state: 'created' | 'cancelled';
    revision: number;
    occurredAt: string;
  }>;
  artifacts: Array<{
    artifactId: string;
    artifactType: 'proposal' | 'decision_summary' | 'research_source' | 'independent_review';
    revision: number;
    schemaVersion: 1;
    provenanceKind: 'user_provided' | 'tool_observed' | 'model_assertion' | 'test_fixture';
    sha256: string;
    createdAt: string;
  }>;
};
```

No projection contains the brief text, BLOB content, local path, provider or
model, cost, source excerpt, task/approval/receipt identifier, recipient, or
approval decision. A `test_fixture` artifact can arise only through the
test-only store seam and is never proof of research, a proposal, independent
review, provider work, task execution, approval, receipt, or completed work.

## Capability and read rules

`canCreate` and `canCancel` are current, server-computed affordance facts only;
they are not authority grants. Every mutation rechecks active owner/operator
status inside the collaboration-store transaction. `canCancel` is false for a
terminal cancelled job. A visible non-owner may receive a detail/list only if
the future seat policy permits the call, but receives `canCreate:false` and
`canCancel:false`; hidden and nonexistent Rooms remain indistinguishable.

This packet does **not** yet authorize UI selected reads. If the UI supplement
is approved, it may send `LIST_ROOM_JOBS` only for the selected visible Room
and `GET_ROOM_JOB` only for a user-selected list job or an explicit refresh.
One request per resource should be in flight; a selection change cancels or
ignores the older response. Channel `room_job_*` events are discovery hints
only: they may request an authorized refetch, never hydrate a job card or
establish access. A disconnect, timeout, partial page, missing metadata, or
generic error leaves the last confirmed row visibly stale/unknown; it never
means deleted, revoked, cancelled, or complete, and it never causes a local
mutation replay.

## Lifecycle discovery events

The existing channel event stream may contain only these Room-job kinds:

```ts
room_job_created
room_job_cancel_requested
room_job_cancelled
room_job_artifact_committed
```

Their payload is exactly `{ jobId, state, revision }`, with artifact events
adding `{ artifactId, artifactType, sha256 }`. These events are constrained,
ordered discovery evidence only; the UI must refetch detail through the normal
authorized command before displaying any lifecycle or artifact metadata.

## Foundation limits

There is no worker, live model/provider call, task dispatch, research/draft/
review execution, editable proposal, artifact upload/preview/download, delivery,
Room-local approval, cost/budget, or task/approval/receipt linkage in this
contract. A confirmed `created` state means only: **Recorded — no live worker
is wired.** A confirmed terminal state means: **Cancelled — no task or external
action is claimed stopped.**
