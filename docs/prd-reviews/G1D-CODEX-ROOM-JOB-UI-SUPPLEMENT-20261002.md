# G1D — Console UI Supplement: Room Job Foundation

**Status:** PROPOSED - ready for independent G1R review; no UI implementation is authorized until that review approves this supplement.
**Date:** 2026-10-02
**Foundation authority:** `G1D-CODEX-ROOM-JOB-FOUNDATION-20261002.md`, SHA-256 `47E8A947B09CFC4327BDA7DA0037D11CB3571F78147F745839BF488A553A521E`, approved by the G1R delta re-review.
**Wire authority:** `CODEX-ROOM-JOB-WIRE-CONTRACT-20261002.md`, SHA-256 `2A8AD2F06B6F6DB00A6F1638F5805CD54F426CCF54801E129AE13CD5AE701AE8`.
**Scope:** `apps/console` and focused console tests only. No dependency, configuration, gateway, contract, collab-store, persistence, authz, dispatcher, provider, or shared-script changes.

## 1. Decision

Add a useful, server-proven Room Job projection to the existing three-surface
Rooms view only after this supplement receives G1R approval.

The foundation already grants commands for owner-created, Room-bound jobs and
authorized job reads, but it explicitly excludes a UI projection. This
supplement does not enlarge the foundation: it projects only server-returned
job list/detail, ordered lifecycle evidence, and immutable artifact metadata.

```text
Room list ---- authorized Room job list/detail ---- lifecycle/artifact metadata
                       |                                      |
                    server read                          no BLOB bytes
                       |
               create/cancel only if
             server capability is supplied
```

## 2. User outcome

An operator can understand which durable proposal jobs are recorded for a
visible Room, inspect their server-ordered foundation lifecycle evidence, and
see authorized immutable artifact metadata. When the final contract supplies
server-computed action capability, the Room owner can create or cancel a job;
the gateway remains the authority and confirms every change.

The concrete no-worker result is: submit a bounded client brief, receive a
server-confirmed job, and read **`Recorded — no live worker is wired.`** This
does not pretend the job has researched, drafted, reviewed, delivered, spent,
written a file, or produced a receipt.

## 3. Non-goals and hard invariants

This supplement does not add:

- a worker, provider/model call, task dispatch, schedule, agent management,
  research, draft/review automation, completion state, or source-backed claim;
- a task/approval/receipt/cost relation or client-side correlation by Room,
  actor, text, timestamp, or visual proximity;
- an attachment picker, client artifact bytes/path/reference, upload, BLOB
  preview, download, safe export, delivery, recipient, policy mutation, or
  Room approval decision;
- browser persistence, an offline draft/ledger, local recovery, replay, or
  an optimistic job/lifecycle state;
- a change to legacy Channels timeline, composer, member, presence, or ACK
  behaviour.

Every job list/detail/action read must be from the server-authorized Room Job
contract. Hidden, absent, revoked, and inaccessible Rooms/jobs remain
indistinguishable. Channel lifecycle events are limited discovery evidence:
they never hydrate job detail and never grant a client selected-job read.

## 4. Interface surfaces

### Room list

Keep the existing validated `LIST_CHANNELS` Room list and its current local
highlight behaviour. A highlight is navigation context, not Room/job authority.
The legacy `LegacyChannelsPanel` remains untouched.

### Timeline and work queue

Within the existing Rooms center column, render a compact **Room jobs** queue
and selected **Job timeline** only when exact, typed Room Job responses exist.
Rows contain only approved list fields. A detail card contains ordered
lifecycle evidence and artifact metadata. The current Phase-0 channel timeline
remains unavailable unless a later, separate contract changes that rule.

Foundation labels are strictly bounded:

| Server fact | UI label |
|---|---|
| `created` | `Recorded — no live worker is wired.` |
| requested-cancellation evidence | `Cancellation requested.` |
| terminal `cancelled` | `Cancelled — no task or external action is claimed stopped.` |
| fixture-only artifact metadata | Hidden from production UI; test-only fixtures are never named as research, proposal, review, provider output, or completed work. |
| metadata unavailable | `Artifact metadata unknown/not loaded.` |

No unsupported waiting, blocked, working, stopped, ready-for-review, proposal,
source, review, receipt, or completion card is rendered. There is no
future-feature placeholder screen: if the server does not expose a permitted
projection, the current useful Rooms shell remains unchanged.

### Control rail

Retain current global navigation and gap copy. Add a Job controls subsection
using the wire's authoritative `capabilities.canCreate` and
`capabilities.canCancel` fields:

- `Create proposal job` accepts bounded plain brief text and a UI-generated
  UUID idempotency key. Its local byte feedback is advisory; final validation,
  normalization, ownership, and idempotency are server-owned.
- `Cancel job` is an explicit destructive action, sends current server revision
  plus a UUID idempotency key, and reads `Cancellation request pending
  confirmation` until a typed response arrives. It never calls `CANCEL_TASK`,
  uses the word Stop, or claims any external effect.
- Metadata cards have no preview/download action. They state no byte read is
  exposed by this foundation contract only when the card itself is rendered.

Capabilities are a current server affordance, not authority; every mutation
still rechecks owner/operator status in the collaboration-store transaction.
The UI does not derive ownership from a Room list role, member data, actor name,
or a previous successful command.

## 5. Exact console file ownership

| File | Change |
|---|---|
| `apps/console/src/components/ChannelsPanel.tsx` | Rooms-only composition seam. Preserve the legacy branch and existing Rooms list safety. Mount the job workspace only after a Room row is locally highlighted and an approved job read flow is available. |
| `apps/console/src/components/RoomJobWorkspace.tsx` (new) | Presentational queue/detail/timeline/control-rail subsection. Typed props only; no direct store/gateway access. |
| `apps/console/src/components/roomJobView.ts` (new) | Runtime guards and pure selectors for typed job envelopes. Reject malformed/duplicate/unrelated data; key lifecycle rows by server job id/revision/event sequence. |
| `apps/console/src/components/TorqTerminal.tsx` | Prop/routing plumbing only. Keep Rooms as owner and keep task composer, task recovery, approval decisions, safe export, and Channel mutation controls unmounted while Rooms is active. |
| `apps/console/src/components/friendly.ts` (optional) | Central status-copy mapping only if required by existing convention. |
| `tests/rooms-panel.test.tsx` | Legacy preservation, Room-only command trace, cross-Room hostile-envelope, and stale/reconnect coverage. |
| `tests/torq-terminal-rooms.test.tsx` | Existing flag matrix plus Rooms navigation/control ownership. |
| `tests/room-job-workspace.test.tsx` (new) | Job projection parsing, lifecycle labels, capability, immutable metadata, error/reconnect, and keyboard/narrow-layout tests. |

No new dependency, feature flag, CSS framework, shared configuration, or server
file is allocated. Existing Rooms flags remain the rollback path.

## 6. Bound wire contract and UI interpretation

The following dependencies are resolved by the bound wire handoff. This
supplement makes the listed UI interpretation mandatory.

1. **Success envelopes and correlation.** A valid `SYSTEM` result has
   `metadata.roomJob.version === 1` and one of `created`, `list`, `detail`, or
   `cancelled` kinds. Mutation responses include the idempotency key and are
   correlated only to the pending local mutation with that key. A list response
   carries `channelId`; a detail response carries `job.channelId` and
   `job.jobId`. Unrelated/malformed frames are discarded. Existing generic
   errors are non-disclosing and must not alter displayed job facts.
2. **Safe projections.** List entries expose only job/channel id, state,
   revision, timestamps, `briefByteLength`, and capabilities. Detail adds
   ordered `jobSeq` lifecycle facts plus artifact metadata
   `(id,type,revision,schemaVersion,provenanceKind,sha256,createdAt)`. No brief
   text, BLOB, path, source excerpt, provider/model, cost, task, approval,
   receipt, recipient, or decision is present or rendered.
3. **Pagination and freshness.** `LIST_ROOM_JOBS` accepts cursor `0` or an
   unsigned server cursor and limit 1-100, returns `nextCursor` and `hasMore`.
   Empty/partial pages are interpreted only by those values. The UI keeps one
   request in flight per selected Room or job; selection change cancels or
   ignores an older response. Create/cancel responses contain a list entry, not
   a full lifecycle, so a selected card refreshes its detail only through an
   authorized `GET_ROOM_JOB`.
4. **Brief and idempotency.** The server uses the existing message-text
   validator: NFC normalization, 1-16,384 UTF-8 bytes, and rejected disallowed
   control characters. The command schema's character cap is only a coarse
   gate. The UI may show advisory UTF-8 byte feedback, generates UUID keys, and
   never auto-retries/replays; same normalized command body/key replays while a
   different body/key gives `COLLAB_IDEMPOTENCY_CONFLICT`.
5. **Capabilities.** `capabilities.canCreate` is provided at list level;
   entries/details also provide `canCreate` and `canCancel`. `canCancel` is
   false for terminal cancelled jobs. These are presentation affordances only;
   create/cancel always undergo current server owner checks.
6. **Selected reads, discovery, and reconnect.** This supplement requests the
   G1R-selected-read exception: send `LIST_ROOM_JOBS` only for the local
   selected visible Room and `GET_ROOM_JOB` only after a user selects a listed
   job or explicitly refreshes it. A `room_job_*` Channel event is an ordered
   discovery hint that may cause that authorized refresh, never a detail
   hydrate/access grant. Disconnect, timeout, missing metadata, generic error,
   or partial page keeps last confirmed data visibly stale/unknown; it never
   mutates, replays, deletes, revokes, cancels, or completes a job locally.
7. **Fixture isolation.** Artifact bytes are never on the wire. Test seams are
   unreachable through production commands and have `provenanceKind:
   'test_fixture'`. The UI drops every fixture artifact and its matching
   `artifact_committed` lifecycle entry (same revision), rather than displaying
   it as research/proposal/review/provider/completed work.

The sole remaining interface authority decision is G1R approval of the
selected-read exception and these console allocations; no backend or contract
change is requested by this supplement.

## 7. State and rendering rules

| Situation | Required behaviour |
|---|---|
| Room list absent or incomplete | Keep existing neutral Rooms state; do not send a job read. |
| Typed job list/detail loading | Announce loading; retain only contract-permitted last confirmed rows with text stale state. |
| Create/cancel send failure or timeout | Show `Request not confirmed. Refresh from the gateway.` and make no local job/state change. |
| Unrelated/generic error | Passive non-disclosing diagnostic; do not mutate the selected job. |
| Reconnect | Preserve the shell; use the section-6 authorized refresh policy; never replay writes. |
| Row omitted from a list | Use only the final completeness boundary; absence from a partial list never means deleted, hidden, or cancelled. |

Use text announcements in addition to colour. At desktop preserve the existing
list / flexible center / rail grid; at narrow width stack context, queue,
timeline, global evidence, and rail without hiding current-session evidence.
Keep all controls keyboard accessible and use red only for cancellation/error.

## 8. Acceptance and verification

1. Legacy Channels is byte-for-byte behaviourally unchanged when Rooms is off;
   current Rooms remains `LIST_CHANNELS` only until this supplement is shipped.
2. A created foundation job never renders worker, research, proposal, review,
   task, approval, receipt, cost, provider, or completion claims.
3. Two visible Rooms and inaccessible/nonexistent Room fixtures prove no
   cross-Room job/event/artifact leak. Hostile task/approval/receipt/timeline/
   agent frames never hydrate a Room Job view.
4. Malformed, duplicate, delayed, stale, unrelated, and generic error frames
   cannot mutate job selection/evidence. A reconnect does not replay create or
   cancel.
5. Create/cancel controls exist only after server capability is defined;
   idempotent replay and stale-revision results never duplicate/optimistically
   mutate UI state.
6. Artifact rendering is immutable metadata only, with no attachment/upload/
   preview/download/delivery/safe-export/retry/resume/file-write control.
7. Desktop/narrow keyboard tests cover list, queue, timeline, rail, and global
   evidence with no colour-only state or text overlap.

Run focused UI tests after each atomic UI build, then allow the parent to
serialize shared validation while the builder is installing:

```text
pnpm test -- tests/room-job-workspace.test.tsx tests/rooms-panel.test.tsx tests/torq-terminal-rooms.test.tsx
pnpm typecheck
pnpm --filter @torqclaw/contracts check
pnpm build
pnpm test -- tests/room-job-workspace.test.tsx tests/rooms-panel.test.tsx tests/torq-terminal-rooms.test.tsx
pnpm test
pnpm reachability  # when available and relevant
```

## 9. Stress-test verdict

**Verdict: GREEN LIGHT for independent G1R review.** The implemented wire
contract supplies a non-leaking typed projection, server-computed affordances,
and explicit selected-read/freshness rules. The riskiest assumption is that the
new selected-read exception will preserve the existing Rooms isolation boundary;
the cheap test is a fixture-backed UI with hostile envelopes and cross-Room
action-trace assertions.

**Next action:** G1R independently approves or rejects this bound supplement;
only an approval authorizes the listed console source allocation.
