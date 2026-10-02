# G1R Gate-1 Review — Server-Owned Room Job Foundation (2026-10-02)

**Verdict: REJECT — packet revision required before implementation.**

**Reviewed packet:** `G1D-CODEX-ROOM-JOB-FOUNDATION-20261002.md`, SHA-256
`2F88EFB095BCC2AF8A855494F42E67B8D28D9887F3CB267738D4FA1BBB12DE35`
(12,873 bytes; `2026-10-02T17:05:15Z`).

**Reviewed source baseline:** `81924186af9c808d0404bf57213a3703f76e1df1`
(worktree `HEAD`; merge-base with `origin/master`:
`de58d3c2799a62070608e4733511a8a29bde9e9f`). This verdict binds only those
packet bytes.

The draft correctly keeps creation owner-only, refuses external delivery, and
does not pretend that `CANCEL_TASK` cancels a Room job. It cannot be approved
because it leaves the cross-database protocol undecided, leaves immutable-byte
storage undecided, and does not require Room lifecycle evidence to use the live
Channel event stream.

## Blocking findings and narrow fixes

### F-1 — cross-store joins cannot be added as if they were atomic

Current Room authority is `collab.db`: `assertChannelOwner` checks a current,
active operator and the channel owner in the collaboration-store transaction
(`packages/collab/src/store.ts:3566-3594`); visible reads recheck active
membership (`:3596-3617`). Tasks, approvals, and receipts are in `state.db`
(`packages/gateway/src/storage.ts:62-96`). A normal SQLite transaction cannot
make a Room job plus `room_job_task_bindings` / `room_job_approval_bindings`
atomic across these files. A crash between the two writes would create an
unprovable association.

**Required packet correction:** make the first vertical slice entirely
`collab.db`-owned: `room_jobs`, append-only `room_job_events`, and artifact
revisions live behind the collaboration store. Do **not** create or expose
task/approval/receipt bindings in that slice. Defer them until a separate
packet chooses one exact recovery protocol: a durable outbox/inbox with a
deterministic replay key and orphan reconciliation, or a single authority
store. That future packet must state commit order and each crash window.

Existing `run_receipts` is a rebuildable state-db projection
(`packages/gateway/src/receipts.ts:385-405`) and its reads are session-scoped
(`:605-684`); it is not a Room evidence ledger to reuse now.

### F-2 — choose database BLOB bytes for the granted scope

The repository has no authorized Room artifact store. A local filesystem
reference plus database metadata would require unprovided defenses against
traversal, symlink/reparse-point escape, partial finalize, and DB/file
split-brain.

**Required packet correction:** store the first-slice artifact bytes in a
bounded `BLOB` column of the immutable `collab.db` revision row. Calculate the
SHA-256 over exactly those bytes and commit bytes, hash, provenance, revision,
and lifecycle event in one transaction. Do not accept a client path or add a
download endpoint. This is app-owned local durable storage, preserves current
Room authorization at every read, and avoids adding filesystem authority.

A content-addressed filesystem is deferred until it specifies server-generated
names, canonical-root and reparse-point checks, temp-file/fsync/atomic-finalize
rules, and crash reconciliation. No retention worker is granted.

### F-3 — cancellation/restart race control needs an exact durable fence

`CANCEL_TASK` is a gateway request-id command
(`packages/contracts/src/commands.ts:43-45`), session-owned for a channel seat
(`packages/gateway/src/authz.ts:98-107,184-188`), and can signal process-local
or engine work (`packages/gateway/src/server.ts:753-790`; cancellation flags in
`packages/gateway/src/cancellations.ts:1-67`). It is not a Room-job authority
and cannot supply restart safety.

**Required packet correction:** choose one bounded model.

1. The first slice is persistence/read-only plus manually invoked deterministic
   fixture writes; asynchronous stages are deferred; **or**
2. Each durable stage claim has a unique `attemptId` and fencing revision.
   Completion may append a current artifact/event only when both still match
   the current job row. Cancellation atomically advances the fencing revision,
   records `cancel_requested` plus `not_started` / `unknown` / observed
   side-effect status, and prevents further claim. A losing completion may be
   recorded as stale attempt evidence but cannot alter current state/artifact.

The same correction must define request hashing of normalized brief bytes and
the uniqueness tuple `(creatorPrincipalId, channelId, idempotencyKey)`. Same key
and payload replay the original result; a payload mismatch is deterministic;
restart recovery claims an attempt at most once and never infers completion
from a missing callback, timestamp, actor, or text.

### F-4 — use real Channel evidence; do not create a Room-only UI correlation

The collaboration substrate already persists ordered `collab_events` and fans
committed events only after transaction commit (`packages/collab/src/fanout.ts:
150-169,235-252`). Fanout revalidates authorization before delivery
(`:194-230`). The draft promises a read-only projection but does not require
job transitions to participate in this Channel path.

**Required packet correction:** every externally visible job transition must
append one constrained Channel event in the same `collab.db` transaction, then
use existing post-commit fanout. Event payload may contain only job id,
state/revision, and non-sensitive artifact identity/hash. It must never contain
brief text, artifact bytes, task prompt, provider data, approval arguments, or
receipt contents. Job detail/list remains separately authorized; a timeline
event is evidence/discovery, not access to a job.

## Required authority, truth, and immutable-evidence rulings

- Create and cancel call `assertChannelOwner` (or a reviewed equivalent) in
  the same store transaction as their write. No client principal/owner field.
- Every detail/list read calls `assertChannelVisible`; absent, hidden, and
  revoked membership stay indistinguishable. Membership removal between event
  commit and delivery must receive no frame through existing revalidation.
- The revision must state what an in-flight fixture/attempt does if the creator
  is revoked or the Room is archived. Minimum safe rule: no later claim or
  disclosure relies on cached authority; never claim external work stopped;
  record observed/unknown effect honestly.
- Artifact revisions and job events are insert-only evidence. Mutable job state
  is only a checked current-state pointer. Provenance distinguishes
  `user_provided`, `tool_observed`, and `model_assertion`; a model citation is
  never retrieval proof.
- `tool_approvals.status` remains the sole approval truth. The only decision
  command carries `approvalId` and decision, not tool/action
  (`packages/contracts/src/commands.ts:34-41`), and the gateway loads the tool
  server-side (`packages/gateway/src/server.ts:687-727`). No Room terminal may
  be styled as a delivery approval/receipt. Exact revision + destination/scope
  binding remains a later delivery gate.

## Acceptance obligations for a revised packet

1. Zod schema, emitted-schema drift, exhaustive handler dispatch, and a booted
   built-gateway test. New wire commands contain no caller identity, path,
   provider, recipient, approval decision, or client artifact bytes.
2. Owner create/cancel succeeds; member/agent/non-owner operator fail. Two
   visible Rooms plus absent/hidden/removed Room prove no cross-Room read,
   list, event, or diagnostic oracle. Remove a member during fanout and prove
   no job frame is delivered; reconnect rechecks authorization.
3. Concurrent same-key creates make one job; mismatched payload fails; stale
   revisions and invalid transitions fail. Cancellation versus completion has
   exactly one state winner and immutable, ordered evidence.
4. BLOB byte-cap, hash mismatch, invalid provenance/type/schema, duplicate
   revision, and mutation attempts fail. Restart preserves byte/hash identity.
   Negative tests prove no accepted artifact path, traversal, symlink, or raw
   download exists in this slice.
5. Restart between create, claim, artifact commit, and cancel cannot duplicate
   a revision or dispatch a cancelled attempt. A delayed/repeated old attempt
   cannot change current state. No provider call, external delivery, tool
   approval decision, receipt fabrication, budget mutation, or cleanup occurs.
6. Each visible transition has one ordered `collab_events` row and post-commit
   Channel frame; UI detail/list use only authorized job reads and never infer a
   task/receipt/approval relation from Room, actor, text, or timestamp.
7. Run narrow tests, then `pnpm typecheck`, `pnpm test`, `pnpm build`,
   `pnpm --filter @torqclaw/contracts check`, and relevant `pnpm reachability`.
   Include a control-bypass test that leaves an authorization import in place
   but fails when the actual predicate is bypassed.

## Path to approve

Revise the packet to select the collab-db BLOB first slice, defer all
cross-`state.db` joins and delivery, select the no-worker or durable-fenced
worker model, and emit constrained lifecycle evidence through live Channels.
Those changes are sufficient for a safe, bounded first vertical slice; they do
not add an approval plane, external action, or new credential grant. Re-review
must bind to the revised packet's new hash.

---

# G1R Delta Re-review — revised collab-db-only packet (2026-10-02)

**Verdict: APPROVE.**

**Reviewed revised packet:** `G1D-CODEX-ROOM-JOB-FOUNDATION-20261002.md`,
SHA-256 `47E8A947B09CFC4327BDA7DA0037D11CB3571F78147F745839BF488A553A521E`
(14,009 bytes; `2026-10-02T17:12:57Z`).

**Source baseline rechecked:** `81924186af9c808d0404bf57213a3703f76e1df1`.
This delta supersedes the preceding REJECT only for the revised packet hash;
the first review remains correct for its earlier bytes.

## Disposition of prior blockers

- **F-1 resolved.** The granted foundation puts jobs, job events, and artifact
  revisions in `collab.db` behind the collaboration store, and explicitly
  creates no `state.db` task/approval/receipt joins. This matches the actual
  split: Room authority is checked by `assertChannelOwner`
  (`packages/collab/src/store.ts:3566-3594`) and `assertChannelVisible`
  (`:3596-3617`), while gateway state is opened separately in
  `packages/gateway/src/storage.ts:62-96`.
- **F-2 resolved.** Artifact content is now a bounded immutable BLOB with a
  SHA-256 over exactly stored bytes, committed with metadata and lifecycle
  evidence. There is no public byte/path/upload/download interface, so no new
  traversal, symlink/reparse-point, or DB/file consistency authority exists.
- **F-3 resolved.** There is no live worker, provider/model call, task
  dispatch, or completion claim. `CANCEL_ROOM_JOB` explicitly cannot invoke
  the session/request-owned `CANCEL_TASK` path
  (`packages/contracts/src/commands.ts:43-45`; `packages/gateway/src/server.ts:
  753-790`). The later worker and cross-store recovery protocol are separately
  gated.
- **F-4 resolved.** Every visible lifecycle mutation now appends a constrained
  Channel event in the same collaboration transaction and uses existing
  post-commit fanout. This uses the real ordered Channel path
  (`packages/collab/src/fanout.ts:150-169,194-252`), whose per-delivery
  revalidation protects membership revocation.

## Approval boundaries and implementation checks

This approval grants only the stated no-worker foundation. It does not grant a
task, provider/model call, research/draft/review workflow, task/approval/receipt
link, filesystem artifact API, UI projection, retention worker, delivery, or
new credential/approval authority.

The builder must make these two already-bounded details explicit in code/tests:

1. The deterministic artifact fixture is test-only and unreachable from a
   booted production command path. A built-artifact reachability/negative test
   must prove no client frame can invoke it and no event presents it as completed
   AI work.
2. With no worker, cancellation must have one deterministic terminal rule:
   after the expected-revision compare-and-swap succeeds, the job is
   `cancelled` (with requested-cancellation evidence), and a replay returns the
   original idempotent result. The implementation must not leave a permanently
   pending `cancel_requested` state or emit contradictory terminal events.

All revised packet acceptance tests remain required, including owner-only
mutation, current-membership reads, removal-before-fanout, idempotency/payload
mismatch, BLOB/hash/provenance immutability, restart behavior, event ordering,
and booted-artifact verification. Contract change discipline and the repository
test gates apply before any implementation is accepted.
