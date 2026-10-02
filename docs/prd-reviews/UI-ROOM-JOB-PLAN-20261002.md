# UI Room Job Integration Plan

**Date:** 2026-10-02
**Reviewed server packet:** `G1D-CODEX-ROOM-JOB-FOUNDATION-20261002.md`, SHA-256 `47E8A947B09CFC4327BDA7DA0037D11CB3571F78147F745839BF488A553A521E`
**Gate state:** the no-worker server foundation is G1R-approved. The same approval explicitly excludes a UI projection. This document is a narrow UI design supplement for a follow-on G1R packet; it authorizes no source change.

## Decision and boundary

The next UI slice should be a read-only, server-proven Room Job projection inside the existing Rooms shell. It must not represent a fixture as completed work, show a live worker, infer a task/approval/receipt relation, expose BLOB bytes, or introduce upload, download, delivery, policy, or approval controls.

The desired end-to-end experience is staged:

```text
client brief -> server-owned job -> source-backed proposal revision -> review summary
                 foundation only        later execution gate          later execution gate
```

The approved foundation covers only the first box: a Room-bound, owner-created job with append-only lifecycle evidence and test-only immutable artifact fixtures. It has no model/provider call, task dispatch, research, drafting, review, delivery, public artifact read/write, or `state.db` binding. Therefore the first UI must say **`Recorded — no live worker is wired.`** after a confirmed created job. A proposal is not editable until a later server contract creates a new immutable revision; source-backed and ready-for-review states are not available until a later execution/provenance gate.

## Exact proposed UI ownership

| File | Proposed ownership | Narrow change |
|---|---|---|
| `apps/console/src/components/ChannelsPanel.tsx` | UI lane | Keep `LegacyChannelsPanel` unchanged. In `RoomsPanel`, add a Room Job workspace slot only under an approved UI gate and only for typed job projections. Preserve current list-only Room safety, stale labels, and global links. |
| `apps/console/src/components/RoomJobWorkspace.tsx` (new) | UI lane | Render the job queue, selected lifecycle evidence, immutable artifact metadata, owner-action availability, and explicit unavailable states. Receives typed data and callbacks only; it cannot access gateway/store state. |
| `apps/console/src/components/roomJobView.ts` (new) | UI lane | Runtime envelope guards plus pure selectors. Drop malformed/duplicate/unrelated frames; dedupe by server job id/revision/event sequence; never create client-side correlations or persistence. |
| `apps/console/src/components/TorqTerminal.tsx` | UI lane | Minimal routing/props only. Rooms stays the mounted owner; do not mount task composer, approval decisions, safe export, or Channel mutation controls while the workspace is shown. |
| `apps/console/src/components/friendly.ts` | UI lane, optional | Shared status labels only if this existing module is the established status-copy location. |
| `tests/rooms-panel.test.tsx` | UI lane | Preserve legacy action trace and add Room Job mounting/isolation assertions. |
| `tests/torq-terminal-rooms.test.tsx` | UI lane | Preserve the four-flag matrix and verify navigation does not mount unrelated controls. |
| `tests/room-job-workspace.test.tsx` (new) | UI lane | Focused contract-envelope, state, evidence, failure, reconnect, keyboard and narrow-layout coverage. |

No UI-lane edit is proposed for `packages/contracts`, `packages/gateway`, `packages/collab`, shared scripts/configuration, or dependencies. Existing Tailwind tokens/utilities in `globals.css` are enough; change it only if a demonstrated token gap remains after component implementation.

## Required UI contract supplement for G1R

The approved server packet intentionally does not grant UI. Before the files above are edited, a UI supplement must freeze these exact wire details:

1. Response event discriminators and typed result envelopes for `CREATE_ROOM_JOB`, `GET_ROOM_JOB`, `LIST_ROOM_JOBS`, and `CANCEL_ROOM_JOB`, including request correlation and version/schema handling. Generic errors must stay non-disclosing.
2. A job-list projection safe for UI: `jobId`, `channelId`, current state/revision, server timestamps, a server-issued pagination cursor/next boundary/completeness fact, and only approved bounded display fields. The client must not surface stored brief text unless the server explicitly authorizes and bounds it.
3. A job-detail projection safe for UI: ordered lifecycle entries with per-job sequence and constrained event facts; immutable artifact **metadata** only (id, type, revision, SHA-256, schema/version/time, allowed provenance metadata). It must contain no BLOB bytes, local path, provider/model/cost, task/approval/receipt id, prompt, source excerpt, recipient, or approval decision.
4. A server-computed capability/precondition field, or a reviewed alternative, for create/cancel presentation. UI cannot infer owner authority from the Room list role, member data, prior success, actor name, or cached state. The gateway rechecks owner and visibility on every command regardless of UI affordance.
5. Exact limits and normalization feedback for brief text (including byte count) and idempotency/retry result classes. The current foundation accepts no client attachment bytes, paths, references, upload, artifact write, preview, or download; Stage A must not render an attachment picker or a fake disabled uploader.
6. The selected-read exception to the existing Phase-0 Rooms rule. Current Rooms dispatches only `LIST_CHANNELS` and may not issue selected timeline/member reads. The supplement must authorize exactly when an authorized `LIST_ROOM_JOBS` / `GET_ROOM_JOB` request is sent, its concurrency/cancellation rules, and whether Channel events merely trigger an authorized refresh. A Channel event is discovery evidence, not permission to render detail.
7. Disconnect, timeout, stale, error, membership-removal, and list-omission semantics. No local command replay, no optimistic create/cancel, no inferred deletion/revocation, and no truth claim from an absent partial page.

## Three-surface composition

The existing Rooms composition remains recognizable:

```text
Room list | Job timeline + Room job queue | Control rail
                 + clearly separate current-session evidence
```

### Timeline

When the approved job-detail projection exists, render only server-ordered lifecycle evidence:

- `Recorded — no live worker is wired.` for confirmed `created`.
- `Cancellation requested` only while a server-returned event says so.
- `Cancelled — no task or external action is claimed stopped.` for the terminal cancelled foundation state.
- `Artifact metadata recorded` only for an authorized immutable metadata row.

Fixture output is test-only and must never appear in production as research, proposal, review, provider work, completed work, task, approval, or receipt. `working`, `waiting`, `blocked`, `stopped`, and `ready for review` are unavailable in this foundation unless a later typed, server-owned execution state supplies them. Channel lifecycle events can prompt an authorized refetch only after the supplement specifies how; their constrained payload cannot hydrate a card.

### Work queue

Place a compact **Room jobs** section above the current-session evidence section. It is sourced from `LIST_ROOM_JOBS`; the selected card is sourced from `GET_ROOM_JOB`. Do not mix it with the existing Task Stream, which remains session-scoped.

The smallest demonstrable slice is: a confirmed owner creation of bounded brief text (only if the final UI contract exposes the command), then a list/detail card showing job id or an authorized bounded summary, state/revision, timestamp, and `Recorded — no live worker is wired.` It proves a durable Room job exists without claiming it has performed work.

For later execution, source-backed proposal/review cards must display server-provided provenance and immutable revision identity. Editing creates a new authorized immutable revision; it never mutates browser state or the existing BLOB. Until that gate, use `not available under the current foundation contract`, not a placeholder editor.

### Control rail

Retain current global-surface navigation and policy gaps. A new Job controls section is conditional on the supplement:

- `Create proposal job` is available only from server-authoritative capability/precondition data; the server still enforces owner/operator-only authority.
- `Cancel job` sends expected revision and idempotency key only when the server allows it. Pending copy is `Cancellation request pending confirmation`, never `Stop`.
- Artifact metadata cards state `Preview and download unavailable under this foundation contract`; no dead button exists.
- Assigned agents, budgets, export policy, approvals, receipts, costs, and memory retain their current global/session-scoped labels and navigation. They receive no job/Room attribution without a later server-issued binding.

## Data safety and failure behaviour

| Situation | Required UI | Never infer |
|---|---|---|
| Room list unavailable | Existing neutral Room-list unavailable state; no job read. | That no Room/job exists. |
| Job list/detail loading | Textual loading state; retain only explicitly safe last-confirmed rows with stale label. | That a missing row is deleted/hidden/revoked. |
| Create/cancel send failure or timeout | `Request not confirmed. Refresh from the gateway.` | A locally created or cancelled job; automatic retry/replay. |
| Generic/unrelated error | Passive non-disclosing diagnostic, no job-state mutation. | Room/job existence, denial, owner, or state. |
| Reconnect | Preserve shell; perform only supplement-authorized refreshes. | Missed completion or a need to replay mutations. |
| Artifact metadata missing | `Artifact metadata unknown/not loaded.` | No artifact/proposal/review exists. |

No job id, cursor, brief, attachment, draft, artifact bytes, recovery state, or correlation is persisted in browser storage. A local highlight is navigation only, not authorization.

## Layout and accessibility

At 1120px and wider, retain the current 260px list / flexible center / 280px control-rail layout. At 760–1119px, keep list plus center and move the rail below. Below 760px, use the list as the switcher and stack context, queue, timeline, global evidence, then control rail. Do not hide global evidence behind settings. Use hairline-separated sections rather than card-in-card nesting, existing design tokens, textual status announcements, keyboard-reachable controls, and correct selected/pressed semantics. Red remains reserved for error/destructive cancellation.

## Acceptance scenarios

1. With Rooms disabled, legacy Channels remains unchanged, including timeline/composer/membership/ACK behaviour. With Rooms enabled but before the UI supplement, the exact Room action trace remains `LIST_CHANNELS` only.
2. A foundation `created` job says no worker is wired; it shows no spinner, provider/model, source, proposal, review, task, approval, receipt, cost, or completion claim.
3. Two visible Rooms and one inaccessible/nonexistent Room prove that delayed job/event/artifact-looking frames from A cannot render in B; cached global task/approval/receipt/agent/timeline frames are discarded.
4. Owner-only create/cancel relies on server capability and server enforcement. Idempotent replay does not duplicate a UI row; payload mismatch/stale revision produces typed non-disclosing feedback without local state mutation.
5. Artifact cards are immutable metadata only. Stage A contains no upload, preview, download, delivery, safe-export, retry, resume, or file-write control.
6. Current-session Task Stream, Approvals, and Receipts remain separately labelled and reachable; no job/Room badge is created from visual proximity or client joins.
7. Disconnect/reconnect preserves the Room shell but neither replays writes nor infers cancellation/completion.
8. Desktop and narrow keyboard review reaches list, job queue, timeline, rail, and global evidence with no overlap or color-only state.

## Verification sequence

After every atomic UI build, rerun the focused tests after the build, then let the parent serialize full validation while the server builder is installing:

```text
pnpm test -- tests/room-job-workspace.test.tsx tests/rooms-panel.test.tsx tests/torq-terminal-rooms.test.tsx
pnpm typecheck
pnpm --filter @torqclaw/contracts check
pnpm build
pnpm test -- tests/room-job-workspace.test.tsx tests/rooms-panel.test.tsx tests/torq-terminal-rooms.test.tsx
pnpm test
pnpm reachability  # when available and relevant
```

Treat the known `collab-build-lock` and cold-start failover tests as isolated reruns before calling them regressions.

## Planning stress test

**Verdict: RESHAPE.** The foundation is safe for durable evidence, but a UI projection must be separately gated because it needs exact response/capability/read semantics and it can otherwise silently violate the existing Phase-0 selected-read boundary.

The riskiest assumption is that a job projection can be added without creating a client-side Room correlation or leaking hidden Room state. The cheap test after UI-gate approval is a fixture-backed read-only card using the exact final schemas, hostile unrelated envelopes, action-trace assertions, and desktop/narrow keyboard review; reject it if the card needs inferred ownership, execution, provenance, or receipt data.

**Next action:** submit the seven contract/UI details above as a narrow G1R UI supplement; only then allocate the proposed console files.
