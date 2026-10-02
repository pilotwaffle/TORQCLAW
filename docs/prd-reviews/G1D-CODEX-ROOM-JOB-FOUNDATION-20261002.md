# G1D — Server-Owned Room Job Foundation

**Date:** 2026-10-02  
**Branch:** `codex/room-job-foundation`  
**Baseline:** `81924186af9c808d0404bf57213a3703f76e1df1` (clean committed main checkout baseline)  
**Status:** DRAFT — requires fresh independent G1R review before any source implementation.

## Operator-directed conservative defaults

- **Creation authority:** only the existing Room owner/operator may create a
  job in this slice. Membership alone is insufficient. The handler must use
  the server-side owner predicate; it must never accept an owner/principal id
  from the client or silently widen creation to agents or ordinary members.
- **Artifact storage:** use app-owned local durable storage only. No external
  upload, cloud object store, browser persistence, or client-provided file
  reference is in scope. Artifact reads remain server-authorized by current
  Room access; revisions are immutable. This slice performs no automatic
  retention deletion or cleanup.
- **Cancellation:** a cancellation invalidates future job/attempt authority,
  records the requested cancellation and any in-flight outcome uncertainty,
  rejects stale completion, and never promises undo. It may use an existing
  stop mechanism only where that mechanism's ownership and effect exactly
  match the job binding; otherwise it records cancellation and prevents new
  dispatch without pretending the unrelated task was stopped.
- **External delivery:** out of scope. It cannot be exposed until a later gate
  proves the existing approval path binds the exact artifact revision and
  destination/scope server-side.

## Decision and bounded outcome

Build a `collab.db`-only durable foundation for a Room-bound proposal job. A
job is owned by a server-visible collaboration Room (`channelId`) and has a
stable identifier, append-only lifecycle evidence, and bounded immutable BLOB
artifact revisions. The first user-facing projection is read-only.

This foundation has no live worker, provider/model call, task dispatch,
research/draft/review automation, external delivery, or job-completion claim.
Fixture artifact writes are test-only deterministic setup, not a model workflow
and not user-visible evidence that AI work occurred.

This packet does **not** authorize a second approval state machine, automatic
external delivery, client-only correlation, an unreviewed local blob store,
provider calls, or Room-local budgets and policy mutation.

## Product flow covered after all phases

1. The existing Room owner/operator creates one idempotent proposal job from a
   client brief.
2. The gateway persists the bounded foundation lifecycle: `created`,
   `cancel_requested`, and `cancelled`, with no asynchronous stage claim.
3. Immutable, hash-bound artifact rows can be inserted only by an internal
   deterministic fixture seam used for persistence and authorization tests.
4. Every visible job transition appends one constrained, ordered Channel event
   in the same `collab.db` transaction and relies on existing post-commit
   fanout/re-authorization.
5. A later, separately reviewed execution slice may add durable attempts,
   research/draft/review, task/approval/receipt binding, and a read-only UI
   projection. The UI must never infer those relations from Room, actor, text,
   or timestamp.

## Non-negotiable invariants

- Room membership and authorization are checked server-side on every job read
  and mutation. Hidden, nonexistent, and inaccessible Rooms remain
  indistinguishable.
- A `(creator principal, Room, idempotency key)` maps to exactly one job and
  returns that same job on a retry. Conflicting payloads are rejected; they do
  not fork another job.
- State transitions are monotonic, server-enforced, and append lifecycle
  evidence with an orderable per-job sequence and Channel sequence. No worker
  is admitted in this slice, so no asynchronous completion can race a cancel.
- Artifact revisions are immutable, content-addressed or hash-bound, and carry
  author/type/schema/version/time plus source provenance. Mutating a revision
  creates a new revision.
- Task, approval, and receipt attribution is written only from immutable
  gateway-issued identifiers. Missing facts remain `unknown/not loaded`; an
  absent or uncorrelated receipt is never reported as definitively absent.
- `tool_approvals.status` remains the single approval truth. Job tables and
  delivery projections may reference an approval but cannot approve, reject,
  grant, or execute it.
- Cancellation is idempotent and prevents a later foundation mutation from
  claiming execution. It does not rewrite existing artifacts or claim to stop,
  undo, approve, receipt, or otherwise affect an external action.
- No Room action can send a customer-facing message, write a file outside the
  existing tool path, or make paid/live provider calls without the existing
  policy, budget, and approval mechanisms.

## Proposed server contract and persistence seam

This is the design target for G1R; names remain subject to review.

### Commands and reads

- `CREATE_ROOM_JOB { channelId, brief, idempotencyKey }` creates or replays a
  job. `brief` is bounded, plain data, and must not be treated as an instruction
  to grant authority.
- `GET_ROOM_JOB { channelId, jobId }` returns one authorized, versioned job
  projection with its ordered lifecycle entries and immutable artifact metadata.
- `LIST_ROOM_JOBS { channelId, cursor, limit }` returns only caller-visible
  jobs with a server-issued cursor and a list-completeness/next-boundary field.
- `CANCEL_ROOM_JOB { channelId, jobId, expectedRevision, idempotencyKey }` is
  an explicit server transition. It cannot call `CANCEL_TASK` or claim to stop
  any work because this foundation has no worker or task binding.

There is no public artifact upload/write/download/delivery command. The initial
artifact BLOB writes are an internal deterministic fixture seam for tests only;
no client artifact bytes, path, provider, recipient, or approval decision is
accepted on the wire.

### Durable model

- `room_jobs`: immutable Room binding, creator principal, normalized brief
  hash, current revision/state, creation/cancellation timestamps, and the
  `(creatorPrincipalId, channelId, idempotencyKey)` uniqueness constraint.
- `room_job_events`: append-only per-job lifecycle sequence with a constrained
  event vocabulary and causation identifiers.
- `room_artifact_revisions`: immutable job-owned bounded BLOB bytes, SHA-256
  over exactly those bytes, revision number, artifact type (`proposal`,
  `decision_summary`, `research_source`, `independent_review`), and structured
  provenance. Bytes, hash, revision, and lifecycle evidence commit together.

All three tables live in `collab.db` behind the collaboration store. Migration
is additive, transactional, idempotent, and invoked by the booted artifact. No
cross-`state.db` task/approval/receipt binding, filesystem metadata, UI
persistence, Web Locks, IndexedDB ledger, prompt text parsing, or timestamp
join substitute is permitted.

### Channel lifecycle evidence

Each externally visible job mutation appends one constrained `collab_events`
row in the same collaboration-store transaction and uses the existing
post-commit fanout path. The allowed event kinds are
`room_job_created`, `room_job_cancel_requested`, `room_job_cancelled`, and
`room_job_artifact_committed`. Each payload is exactly the non-sensitive job
identity and lifecycle facts needed for discovery: `jobId`, `state`,
`revision`, and, for an artifact event only, `artifactId`, `artifactType`, and
`sha256`. It contains no brief text, artifact BLOB, source excerpt, task
prompt/id, provider/model/cost, approval argument/id, receipt content, client
path, or recipient.

The event is evidence/discovery only. It is not a job-detail read, does not
grant access to the job, and does not create a client correlation rule. Every
job detail/list/artifact metadata read re-runs the existing `assertChannelVisible`
check; membership removal before delivery is handled by the current fanout
revalidation.

## Existing-seam check and open design conflicts

The defaults above were checked against the 2026-10-02 baseline source:

- `packages/collab/src/store.ts` already supplies a server-side
  `assertChannelOwner` predicate. It supports the owner/operator-only creation
  default. The final handler must use this predicate (or a reviewed equivalent)
  in the same write boundary as the job mutation.
- `CANCEL_TASK` is currently authorized by gateway session/task ownership, not
  by a Room-job binding. It must not be called as if it cancelled a Room job.
  A later implementation needs an explicit server-owned job-to-task binding and
  a reviewed cancellation rule before it can affect an in-flight task.
- Room ownership/membership is stored in `collab.db`; gateway tasks, approvals,
  and receipts are stored in `state.db`. This foundation resolves that split by
  making jobs, job events, and artifact bytes entirely `collab.db`-owned. It
  creates or exposes no cross-store joins. A later execution packet must choose
  and prove an outbox/inbox replay protocol or a single authority store before
  task/approval/receipt linkage exists.
- Local artifact bytes are bounded BLOBs in the immutable `collab.db` revision
  row, not filesystem references. The server calculates SHA-256 over the exact
  stored bytes and commits bytes, hash, provenance, revision, and constrained
  lifecycle event together. No client path, traversal, symlink, reparse point,
  raw download, or retention worker exists in this slice.
- Existing `APPROVE_TOOL` intentionally carries only `approvalId` and a
  decision; the tool/action is server-read. This preserves decision integrity,
  but the baseline does not by itself prove that a future delivery approval
  binds artifact revision plus destination/scope. Delivery remains deferred.

## Delivery and source-provenance boundary

The foundation can record research-source metadata only after the gateway
obtains it through an authorized task. The record must distinguish user-provided
source, tool-observed source, and model assertion. It must retain the retrieval
time, canonical URL or opaque source identifier, title when available, and a
bounded excerpt/hash where retention policy permits. A model-generated citation
is not proof that a source was retrieved.

The first implementation uses fixtures and deterministic test adapters; it does
not call paid or external providers, and does not represent fixture output as
research, drafting, review, execution, or completed customer work. A later
delivery slice must bind the exact immutable artifact revision and
recipient/scope into the existing tool approval context, then materialize a
normal receipt from real telemetry only.

## Tests required before UI integration

1. Contract validation and generated-schema drift for every new command/event.
2. Two visible Rooms and one inaccessible/nonexistent Room: no cross-Room read,
   write, list, receipt, approval, or diagnostic disclosure.
3. Same idempotency key replays one job; payload mismatch, duplicate concurrent
   create, cancellation retry, and stale expected revision are deterministic.
4. Valid and invalid foundation lifecycle transitions are deterministic;
   cancellation has no in-flight execution claim because no worker exists.
5. Artifact revision immutability, hash/provenance validation, retention
   failure, and no unscoped file write or download handler.
6. Restart preserves one job and immutable BLOB/hash identity; no stale or
   repeated foundation request duplicates a revision or a lifecycle event.
7. Fixture BLOB output is labeled test-only and never presented as research,
   draft, review, provider, task, approval, receipt, or completed work.
8. Each visible transition has one constrained ordered `collab_events` row and
   existing post-commit Channel fanout; member removal before fanout prevents
   delivery and reconnect rechecks visibility.
9. Booted-artifact migration and authorization tests run against built gateway
   output, not only imported source helpers.

## Implementation phases after G1R approval

1. **Collab-db foundation:** schemas, additive `collab.db` migration, command
   handler totality, owner-only authorization, idempotent job/event model,
   immutable bounded BLOB revisions, and Channel lifecycle events.
2. **Foundation verification:** restart, authorization, byte/hash/provenance,
   ordering/fanout, cancellation, built-artifact, and control-bypass tests.
3. **Separately gated execution:** durable attempt fencing/cancellation and a
   cross-store task/approval/receipt recovery protocol, or a single authority
   store. No implementation is implied by this packet.
4. **Separately gated workflow and UI:** fixture-labelled deterministic stages
   first, then authorized research/draft/review and a read-only projection only
   when the server can prove their Room binding.
5. **Separate future delivery gate:** exact-action existing-tool approval,
   recipient/scope binding, real receipt telemetry, and explicit operator
   authorization.

## Review questions for G1R

1. Does the proposed use of the existing server-side Room-owner predicate
   preserve the operator-only creation default on every handler path?
2. Does the bounded `collab.db` BLOB design cover the granted local-storage
   scope without adding an unreviewed file/download/cleanup authority?
3. Do the constrained Channel events expose only job id/state/revision and
   non-sensitive artifact identity/hash while preserving fanout revalidation?
4. Is the no-worker foundation boundary explicit enough that cancellation never
   claims an in-flight task or external action was stopped?
5. Are task/approval/receipt links and delivery clearly deferred to their own
   recovery-protocol and exact-action approval gates?

## Seat accounting

- G1D author: Codex (GPT-5).
- Token usage: unavailable in this execution environment.
- Provider cost: unavailable.
