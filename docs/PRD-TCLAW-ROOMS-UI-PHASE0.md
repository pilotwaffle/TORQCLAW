# PRD-TCLAW-ROOMS-UI-PHASE0 - Torq Rooms console reframe

**Status:** v0.6 reviewed PRD draft. Operator authorized implementation on 2026-08-24; Phase 0 OQ defaults accepted unless superseded in a later packet.
**Date:** 2026-08-23
**Branch/worktree:** `rooms-ui-phase0` at `E:\TorqClaw-worktrees\rooms-ui`
**Scope:** Console/UIX and product composition only. No gateway, contracts, kernel, channel adapter, Slack/Discord/X, or approval-authority changes are authorized by this PRD.

---

## 0. Executive Summary

Torq Rooms is the human-facing product layer for TORQCLAW's existing collaboration and governance substrate.

A Room is a durable governed workroom around one outcome: a client engagement, incident, release, research lane, audit, or internal operating problem. In Phase 0, a Room is a console projection over existing channel facts. It may show a separate current-session evidence surface, but that surface is not part of the selected Room unless the gateway provides a proven Room binding.

The product rule is deliberately simple:

> Bots may discuss, inspect, draft, and coordinate inside a Room. Anything that spends money, writes files, changes production, sends external messages, changes permissions, or deletes data remains governed by TORQCLAW approvals, budgets, and receipts.

This PRD does not build new autonomy. It makes the already-built control plane more legible while preserving the current authority model.

---

## 1. Research Basis

### 1.1 External pattern: persistent bot workrooms

Current Grok Bot materials validate the product direction but not the security model TORQCLAW should copy.

Verified public claims as of 2026-08-23:

- xAI launched Grok Bot on 2026-08-11 as always-on agents that use their own computer, work across apps, keep going, and return for approval when needed. Source: `https://x.ai/news/introducing-grok-bot`.
- Grok Bot docs describe Bots as persistent named teammates with durable state, files, browser sessions, routines, and the ability to coordinate through direct messages, threads, and group chats. Source: `https://docs.x.ai/grok-bot/overview`.
- Grok Bot docs recommend group chats when multiple Bots need one shared outcome and visible handoffs. Source: `https://docs.x.ai/grok-bot/chat-and-collaboration`.
- Grok Bot docs describe approval controls for sending, publishing, purchases, deletion, permission changes, production changes, and similar consequential actions. Source: `https://docs.x.ai/grok-bot/approvals-security-and-privacy`.
- Grok Bot docs warn that all Bots for one user share one cloud computer and separate Bots should not be treated as a security boundary. Source: `https://docs.x.ai/grok-bot/approvals-security-and-privacy`.

Conclusion: copy the persistent named teammates in shared workrooms UX pattern. Do not copy shared-computer-as-boundary architecture.

### 1.2 TORQCLAW substrate reality in this worktree

The current branch already contains more than a channel placeholder:

| Area | Current evidence | Implication |
|---|---|---|
| Control-plane positioning | `README.md` states TORQCLAW is a governed control plane for AI agents with approval, budget, and receipts. | Rooms should be positioned as governed operations, not chat novelty. |
| Channels UI | `apps/console/src/components/ChannelsPanel.tsx` exists and is mounted from `TorqTerminal.tsx` behind `NEXT_PUBLIC_COLLAB_UI`. | Phase 0 should reframe and compose this surface, not rebuild channel basics. |
| Agent management UI | `AgentsPanel.tsx` lists agents/providers/channels and creates or updates agent profiles. | Rooms mode must not use existing agent data as selected-Room truth; assigned agents render `unknown/not loaded` with navigation to Agents. |
| Channel commands | Contracts include `LIST_CHANNELS`, `GET_CHANNEL_TIMELINE`, `POST_CHANNEL_MESSAGE`, and `ACK_CHANNEL_CURSOR`. | Phase 0 Rooms mode may issue `LIST_CHANNELS` only. Timeline reads, posting, and ACK remain legacy Channels behavior unless a later gated packet adds correlated authority. |
| Agent commands | Contracts include `LIST_AGENTS`, `CREATE_AGENT`, and `UPDATE_AGENT_PROFILE`. | Rooms mode does not dispatch `LIST_AGENTS` and does not read cached `LIST_AGENTS` frames for selected-Room truth. The Control Rail renders assigned agents as `unknown/not loaded` and links to Agents. Create/edit remains in the existing Agents surface. |
| Agent channel tools | `collabAgentTools.ts` registers in-process `collab__read_channel` and `collab__post_message`. | Agents can participate as channel members under existing policy. |
| Approval projection | `approvalDelivery.ts` treats approval delivery as a projection and approval truth as separate. | Approval cards shown near Rooms must remain delivery/view artifacts, not decision truth. |
| Approval and receipt scope | Current approval and receipt queries are session/request oriented, not `channelId` oriented. | Phase 0 must not label approvals or receipts as Room-scoped without server-owned linkage. |
| PRD status | `docs/PRD-MAP.md` records Collab UI S1-S5 shipped, Agent Participation S1-S7 shipped, and multiple cross-cutting owed items. | Phase 0 must be honest about owed identity/backpressure/adapter gaps. |

Worktree caveat: `docs/PRD-MAP.md` references `SCOPE-PHASE-3-CHANNEL-PRESENCE-FABRIC.md`, but that file is absent in this worktree. This PRD treats Phase 3 adapter/channel-reach details as referenced-but-not-imported and does not depend on that absent file.

---

## 2. Objective

An operator opens TORQCLAW and sees Rooms as the primary way to understand agent work around a shared outcome:

- one Room per active channel/outcome;
- one list-backed Room navigation shell, with selected timeline content intentionally unavailable until the gateway exposes request/lifecycle correlation;
- one separate current-session evidence surface for tasks, approvals, receipts, costs, and diagnostics that are not proven Room-scoped;
- one Room activity summary that is honestly unavailable/not on wire in Phase 0, plus an explicitly global current-session queue;
- one read-only control rail showing fixed policy gap copy, links to existing global controls, and honest gaps.

The first version must feel like a governed workplace, not another chat pane, and it must not manufacture audit linkage that the gateway does not provide.

---

## 3. Product Definition

### 3.1 Room

A Room is a product-level projection over existing channel facts. Phase 0 presents channel list rows as Rooms and keeps selected timeline, membership, presence, and agent assignment unavailable/uncommitted because the current wire does not echo request/lifecycle correlation or an orderable selected-Room boundary. Task, approval, receipt, cost, memory, schedules, ACK state, and mutations remain explicitly session-scoped or legacy-channel-scoped unless a server-owned mapping proves that the item belongs to the selected channel.

Minimum Room fields:

| Field | Source in Phase 0 | Notes |
|---|---|---|
| Room id | existing `channelId` | No new room table in Phase 0. |
| Name | existing channel name | UI label may say Room; storage remains channel. |
| Objective | not currently on wire | Phase 0 may show `objective not recorded` or hide the field. Do not fabricate. |
| Owner | not committed in Phase 0 | The current member wire has no roster watermark; render `owner not recorded` or omit. Do not derive owner from uncommitted member context. |
| State | active channels from existing `LIST_CHANNELS` | Archived discovery is deferred because current list behavior excludes archived channels. |
| Members | unavailable/uncommitted in Phase 0 | Rooms mode must not dispatch `LIST_CHANNEL_MEMBERS`; render `members unknown/not loaded` or omit. Do not derive owner, summaries, diagnostics, attribution, freshness, or assigned agents. |
| Assigned agents | unavailable in Phase 0 | Always render `unknown/not loaded` with navigation to Agents. Do not derive from cached `LIST_AGENTS` data. |
| Timeline | unavailable in Phase 0 | Do not dispatch selected `GET_CHANNEL_TIMELINE` or render committed selected timeline content until a later gateway contract adds request/lifecycle correlation. |
| Session activity | existing task, approval, receipt, safe-export availability, and cost surfaces | Label as session-scoped unless proven by `channelId` or server-owned mapping. Room-owned controls may show availability and navigate to Task Stream only. |
| Room activity summary | unavailable/not on wire in Phase 0 | No selected timeline/member derivation, no new task state machine, and no schedule read in Phase 0. |
| Current-session queue | existing task, approval, receipt, safe-export availability, and cost surfaces | Global to the current session unless a server-owned Room binding exists. Room-owned controls do not export, download, retry, resume, or write files. |
| Policy/control | read-only links and visible gaps | Spend/tool/path policies are not per-Room yet; Phase 0 must disclose this. Message composer, ACK, export-policy mutation, and member/agent mutations are not Room-mode controls. |

### 3.2 Bot

In this PRD, `bot` is the user-facing word. The implementation term remains agent principal or agent profile.

Required visible fields when real data exists:

- display name;
- provider/model;
- assigned Rooms/channels;
- status: idle, working, blocked, awaiting approval, stopped, unknown, or not recorded;
- role/persona summary if available;
- external context confirmation state if applicable.

### 3.3 Run

A Run is an execution related to the operator's current work. In Phase 0 it is not a Room-owned object unless the gateway response carries `channelId` or a server-owned mapping establishes the relation.

No new run table is authorized.

### 3.4 Approval

An Approval is still decided only through the existing operator approval path. In Phase 0, approvals stay in the global/session approval surface unless a server-owned `requestId -> channelId` or equivalent mapping proves Room eligibility.

A Room must not introduce:

- message-to-approve;
- reaction-to-approve;
- channel-originated approval;
- bot-originated approval;
- approval by external adapter;
- client-side approval attribution based on prompt text, timestamp, agent identity, or selected Room.

Approval cards remain in the global/current-session surface, not the Room Timeline or Control Rail, unless a later server contract proves Room linkage. They must link back to the underlying approval id and show whether the item is Room-proven or session-scoped. Approval state must reflect gateway-confirmed state after reconnect or failed-send recovery, not a local optimistic decision.

### 3.5 Receipt

A Receipt is first-class evidence, but Phase 0 must not claim Room ownership unless linkage is proven by the gateway.

Any completed or failed session activity shown in the current-session evidence surface should expose only passive status and navigation:

- terminal state;
- model/tier;
- cost if known;
- tools called;
- approval linkage if any;
- safe-export availability text if available, with `onOpenTaskStream` navigation only;
- raw local diagnostic only when explicitly labeled local/unredacted;
- Room attribution state: proven Room-scoped, session-scoped, or not recorded.

---

## 4. Controlling Invariants

1. **A Room is not an authority boundary by itself.** Authority remains gateway policy, surface credentials, profile/tool gates, budget enforcement, and approval state.
2. **A message is data, not a command.** Room messages, mentions, labels, reactions, and timeline text must not approve, dispatch, widen grants, or alter policy.
3. **Talking is cheap; acting is governed.** Internal Room discussion may be free-form. External effects stay behind approval, budget, and receipt paths.
4. **No fabricated operations data.** If the wire does not expose an objective, unread count, member count, task linkage, cost, path scope, or receipt, the UI must say `not recorded`, `not on wire`, or omit the field.
5. **Delivery is not truth.** Approval delivery and Room timeline rendering are projections. Approval decision truth remains in gateway approval state.
6. **Adapters are not Phase 0.** Slack, Discord, X, Grok, email, and customer-facing connectors remain out of scope until identity and channel-originated approval questions are resolved.
7. **Security boundaries must be explicit.** Do not imply separate bots are isolated unless per-bot credentials, filesystem scope, tool scope, and memory scope are actually enforced.
8. **Room attribution requires server proof.** A client may attribute an item to a Room only when the gateway response carries that `channelId` or a server-owned mapping establishes `requestId -> channelId`. Agent identity, prompt text, timestamps, `sourceChannel` labels, and UI session proximity are not valid joins.
9. **Cross-stream ordering is not implied.** Channel timeline events and gateway task/session events use different ordering domains. Phase 0 must show them as separate labeled sections unless a common ordering contract exists.
10. **Hidden and nonexistent Rooms remain indistinguishable.** Authorization failures, missing channels, and inaccessible Rooms must not leak existence through UI state, cache, or diagnostics visible to ordinary operators.
11. **Phase 0 controls are conservative.** Preserve the existing channel composer and ACK behavior only in legacy Channels mode. Rooms mode is read-only for channel mutations and keeps existing navigation paths, but does not add Room-local agent management, approval, schedule, auto-reply, budget, export-policy, member, message, ACK, or emergency-stop mutations. Existing global controls remain in their established surfaces.

---

## 5. Non-Scope

Phase 0 explicitly does not include:

- new gateway commands;
- new database tables;
- external channel adapters;
- Slack/Discord/X/Grok integration;
- multi-human team chat beyond what already exists;
- reaction workflows;
- mention-triggered execution;
- in-channel approval decisions;
- per-Room spend enforcement if not already backed by gateway policy;
- per-Room filesystem or MCP scope unless backed by existing profile/tool policy;
- Room-scoped receipt or approval attribution without server-owned linkage;
- unified cross-stream chronological ordering;
- archived Room discovery beyond what existing commands expose;
- auto-reply, schedule, budget, approval, emergency-stop, or agent-profile controls inside the Room shell;
- search, threads, attachments, canvases, DMs, or media;
- changing approval semantics;
- changing agent auto-reply semantics;
- changing task dispatch or model routing.

---

## 6. UX Model

Rooms should become the organizing shell for existing console surfaces.

### 6.1 Navigation

Rename the sidebar item from `Channels` to `Rooms` only when the Room shell is enabled.

Feature flag:

`NEXT_PUBLIC_ROOMS_UI=1`

Flag behavior:

- effective only when `NEXT_PUBLIC_COLLAB_UI=1`;
- flag off: existing Channels/Agents/Task Stream behavior remains unchanged;
- flag on: Rooms appears as the primary collaboration view;
- no gateway commands are sent merely because the flag exists;
- every Room command must still be issued only by mounted UI controls.

The existing `Agents` view remains available when Rooms is enabled. Rooms does not absorb agent creation or profile editing in Phase 0.

Rollout behavior:

- default off for existing operators;
- enable for one internal operator cohort first: one TORQCLAW operator running at least five real or replayed sessions across three Room types, for at least five working days;
- rollback is disabling `NEXT_PUBLIC_ROOMS_UI` with no data migration;
- support diagnostics must show both flag values and current mounted view.

Promotion criteria:

- at least 80% of dogfood review tasks answer `what happened here?`, `what needs attention?`, and `what is only session-scoped?` within 10 seconds using the Room shell;
- zero observed authority-widening dispatches from Room-owned controls;
- zero false Room attribution for approvals, receipts, costs, or runs;
- no P1 accessibility defect and no text-overlap defect at desktop or narrow viewport;
- rollback trigger: any authority-widening dispatch, false Room attribution, repeated fetch storm, or inaccessible selected-Room data leak.

Measurement method:

- manual dogfood ledger unless an already-approved telemetry mechanism exists;
- record cohort, session date, Room type, task answered, elapsed seconds, correctness, any rollback trigger, and reviewer;
- rollout owner: TORQCLAW operator/product owner;
- review date: before enabling Rooms for anyone outside the internal cohort.

### 6.2 Room Layout

Desktop layout:

```text
--------------------------------------------------------------+
| Room Header: name, state, objective, policy, sync status     |
+------------------+--------------------------+----------------+
| Room List         | Room Timeline            | Control Rail   |
| active rooms      | channel-backed messages  | agents, export |
| local filter/status | and channel system events | policy, state  |
+------------------+--------------------------+----------------+
| Current-session evidence: tasks, approvals, receipts, costs  |
| never implied to belong to the selected Room without linkage  |
+--------------------------------------------------------------+
```

Mobile/narrow layout:

- Room List becomes a switcher;
- Control Rail becomes tabs or a drawer;
- Current-session evidence remains reachable above or below the timeline, not hidden behind settings.

List and highlight states:

- no Rooms loaded, empty response, or incomplete list: show neutral copy such as `No Rooms loaded` or `Room list unavailable/incomplete`; do not claim there are no active Rooms unless a future server-owned completeness fact proves it;
- loading: preserve only local highlight and last loaded list rows with loading/disconnected/stale labeling as applicable; do not describe them as authorized selected Room details;
- cold start, reload, mode change, or persisted Room hint: do not validate or restore selected Room details. Persisted Room ids are navigation hints only and cannot authorize selected-Room reads, selected labels, or committed content;
- selected Room omitted from a list: omission alone is non-authoritative because Phase 0 has no server-owned list-completeness discriminator. Preserve only local highlight if desired and render list uncertainty as passive context. Do not enter stale, clear selected content, probe existence, or infer revocation from omission;
- positive list row: may render as one row in the global `last loaded Rooms list` after runtime row validation. It does not validate a selected Room lifecycle and does not authorize selected header details, timeline, members, presence, owner, assigned-agent, policy, or activity-summary content;
- disconnected or explicitly stale connection state: label the list as disconnected/stale if applicable. Do not issue selected-Room timeline/member reads and do not claim selected Room freshness or stale recovery;
- denial/error handling: current raw control errors are not delivered to the Room owner with scoped `channelId`, request correlation, or ordering. Phase 0 must not implement denial retirement as a production claim. Generic/unscoped errors may be shown as passive diagnostics only and must not clear, validate, or revive selected Room facts;
- completion commit rule: because current selected timeline/member responses have no request/lifecycle discriminator, Phase 0 must not commit selected timeline/member content, pagination, membership, presence, owner, or assigned-agent facts. Delayed timeline/member frames after Room switches are ignored by Rooms mode. These features require a later server-owned correlation contract and fresh Gate 1;
- local filtering only narrows the already-rendered last loaded Rooms list. It does not add server search, archived discovery, selected validation, or existence probes.

### 6.3 Room Header

Required fields:

- selected Room details unavailable under current wire;
- optional local highlight label from the visible row, clearly treated as list display, not selected authority;
- current connection/sync state;
- objective if recorded, otherwise omitted or `objective not recorded`;
- budget policy if real, otherwise `room budget not enforced yet`;
- external/export policy is `not enforced at Room scope yet` in Phase 0 unless a later correlated contract is added;

Forbidden:

- fake objective;
- fake owner;
- fake archived discovery;
- fake unread counts;
- fake spend cap;
- live delivery language unless backed by durable delivery guarantees.

### 6.4 Room Timeline

The Room Timeline is intentionally unavailable in Phase 0 Rooms mode. The current `GET_CHANNEL_TIMELINE` response proves `channelId` but not request/lifecycle applicability across switch, A-B-A, reselection, stale, or pagination boundaries, so Rooms mode must not dispatch selected timeline reads or render committed selected timeline content.

A later gated slice may restore the Room Timeline only after the gateway echoes a server-owned request/lifecycle discriminator and orderable boundary. At that point, the timeline may include:

- human channel messages;
- agent channel messages;
- committed system channel events;
- scheduled-turn notices only if already on the channel wire.

Every timeline item must carry or expose a source label:

| Label | Meaning |
|---|---|
| `message` | committed collab timeline event |
| `system` | gateway/collab system event committed to the channel timeline |
| `local diagnostic` | explicitly local/unredacted support data, never normal timeline content |

No timeline item may be rendered as if it is a committed Room message in Phase 0.

### 6.5 Room Activity Summary and Current-Session Evidence

The Room Activity Summary is present but unavailable/not on wire in Phase 0. The separate Current-session evidence surface answers what needs attention in the operator's current session. It is not a Room queue, even when displayed on the same screen.

Room Activity Summary buckets:

- Scheduled: `not on wire` in Phase 0. Do not dispatch `LIST_SCHEDULES`.
- Blocked: `not on wire` in Phase 0.
- Complete: `not on wire` in Phase 0.

Current-session evidence buckets:

- Active: running tasks or agent turns, marked Room-proven only with server linkage.
- Awaiting approval: pending tool/spend/destructive approvals, global/session-scoped unless proven Room-linked.
- Blocked: failed runs needing retry, missing credentials, offline provider, or policy denial. Retry/resume actions remain in the established Task Stream surface after navigation, not in Room-owned controls.
- Complete: terminal runs with receipt links or honest absence states.

Phase 0 must not derive Room Activity Summary buckets from timeline, member, presence, global agent, approval, receipt, cost, or task caches. The implementation must not pass acceptance by silently omitting the entire Room Activity Summary. A single interleaved chronological feed is deferred until the gateway exposes a common ordering and attribution contract.

### 6.6 Control Rail

The Control Rail answers: who is present, which channel facts are recorded, and which global governance surfaces apply.

Sections:

- Agents: `unknown/not loaded` plus navigation to Agents. Do not derive assigned agents or working-now state from cached `LIST_AGENTS`, member, presence, task, or receipt data.
- Export policy: `not enforced at Room scope yet` or omitted; do not render raw policy enum values.
- Room state: connection, synchronization, attribution, and availability state.
- Existing global surfaces: links to Agents, Approvals, Receipts, Cost, and Memory without copying their authority into a Room.

The Phase 0 Control Rail and Room shell are read-only in Rooms mode. They must not add, relocate, or inherit composer, ACK, auto-reply, schedule, budget, approval, emergency-stop, member, export-policy, or agent-profile mutations. Legacy Channels mode keeps its existing controls when Rooms is disabled.

The Control Rail must separate:

- assigned agents: `unknown/not loaded`;
- currently working agents: unavailable/not shown as selected-Room facts;
- agents merely mentioned in text: ignored for selected-Room truth.

---

## 7. Required Product Copy Rules

Use `Room` for the product surface.

Use `channel` only when referring to storage/protocol internals, debug output, or existing command names.

Preferred phrases:

- `Room`
- `assigned agents`
- `working now`
- `awaiting approval`
- `receipt`
- `session-scoped`
- `Room attribution not recorded`
- `not recorded`
- `not on wire`
- `not enforced at Room scope yet`

Forbidden or restricted phrases:

- `secure Room` unless a specific security boundary is named;
- `isolated bot` unless per-bot isolation is actually enforced;
- `live delivered` unless delivery guarantee exists;
- `approved in chat`;
- `Room budget enforced` unless gateway enforces per-Room budget;
- `Room receipt` unless server linkage proves Room attribution;
- `Room approval` unless server linkage proves Room attribution;
- `member count` or numeric unread count unless source data exists;
- `Room work` for current-session activity unless server linkage proves Room attribution.

---

## 7.1 Rooms-Mode Command Boundary

Rooms mode is a passive/read-only shell over selected channel facts. Because the rebased `ChannelsPanel.tsx` currently exposes composer, ACK, membership, and export-policy mutations, the implementation must make the Rooms/Channels distinction explicit instead of inheriting controls accidentally.

### 7.1.1 Existing Wire Discriminator Ledger

Phase 0 must use only the existing wire facts below. Missing discriminator means unavailable or uncommitted display, not a client substitute.

| Slice | Existing server field | Phase 0 use |
|---|---|---|
| List success / absence | success envelope: `GatewayEvent.type === 'SYSTEM'`, `metadata.collabChannels === true`, and `Array.isArray(metadata.channels)`; no completeness/high-water mark | Valid only for rows present. Omission or empty list is non-authoritative; show neutral incomplete/unavailable copy only. |
| Positive Room identity | matching `channelId` in a successful list row | May render only as a row in the non-authoritative last loaded Rooms list. It does not validate a selected Room lifecycle or authorize selected timeline, member, presence, owner, assigned-agent, activity-summary, or policy content. |
| Stale-boundary recovery | no guaranteed persisted `seq` on collab `publishOnly` frames; event `seq` is usable only if present on both boundary and candidate frame and numerically greater | Phase 0 makes no stale-recovery claim for selected Room details. On disconnect/stale, label the whole list as stale/disconnected and keep selected detail content unavailable. Do not use client epochs, frame ids, request maps, or arrival order. |
| Timeline content | success envelope exists: `GatewayEvent.type === 'SYSTEM'`, `metadata.collabTimeline === true`, matching `metadata.channelId`, `Array.isArray(metadata.events)`, decimal-string `metadata.cursor`, and boolean `metadata.hasMore`; but it lacks request/lifecycle correlation | Rooms mode must not dispatch selected `GET_CHANNEL_TIMELINE`, render committed selected timeline content, or paginate. Timeline remains legacy Channels-only until a later backend contract adds correlation. |
| Membership content | success envelope exists: `GatewayEvent.type === 'SYSTEM'`, `metadata.collabMembers === true`, matching `metadata.channelId`, and `Array.isArray(metadata.members)`; no response-level roster watermark or lifecycle correlation | Rooms mode must not dispatch `LIST_CHANNEL_MEMBERS` or render/derive selected member, owner, summary, diagnostic, freshness, attribution, presence, or assigned-agent facts. |
| Agent membership cache | `LIST_AGENTS` can publish channel memberships in a global, unsequenced frame | Rooms mode must ignore it for selected-Room truth. Assigned agents always render `unknown/not loaded` with navigation to Agents. |
| Denial / failure | control-error envelope exists as raw `{ type: 'ERROR', code, detail }`, but `useGatewayStream` currently logs/drops it and existing details are not reliably structured by `channelId` | Rooms mode must not claim production denial retirement. Generic/unscoped errors are passive diagnostics only and cannot clear, validate, or revive selected Room facts. |

Runtime row schema for the Rooms list:

- accept a row only when `channelId`, `name`, and `state` are non-empty strings;
- permitted rendered fields are `name` and `state`; `channelId` is an internal React key/control identifier and may appear only in local diagnostics when explicitly labelled as a list row id;
- `role`, `lastAcknowledgedCursor`, and `externalExportPolicy` must not render as selected-Room authority in Rooms mode;
- `externalExportPolicy` must render as `not enforced at Room scope yet` or be omitted in Rooms mode;
- malformed rows are excluded from the Rooms list and may increment a local diagnostics count only;
- if a `channelId` appears more than once in one parsed list frame, all rows for that `channelId` are excluded from the Rooms list and diagnostics may report `duplicate Room row suppressed`;
- if every row is malformed/suppressed, render `Room list unavailable/incomplete`, not an empty/no-active-Room claim.

When `NEXT_PUBLIC_ROOMS_UI=1`, the Room shell may dispatch only these existing command actions from Room-owned controls:

- `LIST_CHANNELS`

Global chrome and destination panels are outside the Room-owned trace boundary. Room-owned evidence remains passive. Receipt, approval, cost, memory, task, and agent commands may begin only after a typed navigation callback commits the destination state and the destination surface owns the control.

Rooms mode must not dispatch these actions from Room-owned controls:

- `ADD_CHANNEL_MEMBER`
- `REMOVE_CHANNEL_MEMBER`
- `SET_CHANNEL_EXTERNAL_EXPORT_POLICY`
- `SET_LOCAL_AGENT_AUTOSTART`
- `CREATE_AGENT`
- `UPDATE_AGENT_PROFILE`
- `LIST_SCHEDULES`
- `CREATE_SCHEDULE`
- `SET_SCHEDULE_STATE`
- `POST_CHANNEL_MESSAGE`
- `ACK_CHANNEL_CURSOR`
- `GET_CHANNEL_TIMELINE`
- `LIST_CHANNEL_MEMBERS`

Flag-off legacy Channels behavior must preserve the current post-rebase controls, including `LIST_AGENTS`, add/remove member controls, the existing export-policy toggle, composer behavior, and ACK behavior. The Builder must introduce an explicit mode prop or equivalent branch so Rooms mode conditionally does not render or bind those controls while legacy Channels mode remains exact. Tests must assert DOM absence, handler absence, and dispatch allowlists separately for flag-on Rooms and flag-off Channels.

---

## 7.2 Component Ownership and Slice Dependencies

`TorqTerminal.tsx` owns global navigation and the established session surfaces. `ChannelsPanel.tsx` owns the channel/Room list, selected timeline, roster display, and Room-local projection. In legacy Channels mode it also owns the existing composer and ACK behavior. Rooms Phase 0 must not duplicate existing panels, create competing query owners, or expose composer/ACK controls in Rooms mode.

Required component contract:

- `TorqTerminal.tsx` decides whether the collaboration view is labelled Channels or Rooms based on flags.
- `TorqTerminal.tsx` keeps Approvals, Receipts, Cost, Memory, Task Stream, and Agents as established global surfaces.
- `ChannelsPanel.tsx` may receive a mode prop such as `mode="channels" | "rooms"` and must branch controls from that prop.
- In Rooms mode, `ChannelsPanel.tsx` must use one reducer or equivalent transactional owner for the parsed last loaded Rooms list, suppressed row diagnostics, local highlighted row id, and stale/disconnected list labeling. Legacy session/cursor keys or any future persisted selection are navigation hints only and must not validate selected Room details.
- Room links to global surfaces are navigation affordances only; they do not copy the global surface's command ownership into the Room Control Rail.
- `TorqTerminal.tsx` must pass typed navigation callbacks into the Room shell for every global destination the Room shell links to: Agents, Approvals, Receipts, Cost, Memory, and Task Stream.
- Required callback targets: `onOpenAgents` commits `setView('agents')`; `onOpenApprovals` commits `setView('approvals')`; `onOpenReceipts` commits `setReceiptsOpen(true)`; `onOpenCost` commits `setCostOpen(true)`; `onOpenMemory` commits `setView('memory')`; `onOpenTaskStream` commits `setView('tasks')`.
- If a destination is implemented as an overlay or detail panel rather than a sidebar view, the callback contract must name the exact target state it opens; Room-owned controls may call the callback but must not dispatch that surface's data command directly.
- Ordering boundary: `ChannelsPanel.tsx` emits only the typed navigation callback. `TorqTerminal.tsx` commits the target state. Only the mounted destination surface may initiate its existing reads after it owns the view/overlay state. Tests must attribute dispatch origin, not merely allow action names.
- Each Room global-surface link must have a test proving it opens the existing surface and does not dispatch a Room-owned command.
- `ChannelsPanel.tsx` must not issue duplicate global reads already owned by another mounted panel merely to populate the Room rail.
- R1 must land before R2-R5. R2/R3 may build on the Room mode prop. R4 and R5 must not duplicate global panel state; they may link to the global surfaces or show session-scoped summaries derived from already-provided `events`.

---

## 8. Phase 0 Slices

Each slice must be reversible and feature-flagged where behavior changes.

### R0 - PRD and design audit

Deliverables:

- this PRD;
- source ledger of fields that are real vs unavailable;
- no code changes.

Acceptance:

- PRD cites current worktree evidence;
- PRD states non-scope and authority invariants;
- PRD has completed Sol/Terra review loop before implementation begins.

### R1 - Navigation and naming

Goal: introduce Rooms as the product label without changing backend behavior.

Allowed changes:

- sidebar label `Channels` -> `Rooms` behind `NEXT_PUBLIC_ROOMS_UI` when `NEXT_PUBLIC_COLLAB_UI=1`;
- header copy inside existing Channels view;
- no command changes.

Acceptance:

- flag off preserves exact existing labels and behavior;
- `NEXT_PUBLIC_ROOMS_UI=1` with `NEXT_PUBLIC_COLLAB_UI` off shows no Rooms entry;
- flag on dispatches no new action compared to entering Channels today;
- tests assert no new authority/control appears.

### R2 - Room header and status band

Goal: show local list context and honest unavailable selected-Room details without implying selected-Room authority.

Fields:

- highlighted row name/state only when it comes from a validated visible list row, labelled as list display if needed;
- sync/stale state;
- export policy `not enforced at Room scope yet` or omitted;
- objective if available, otherwise honest absence;
- Room budget/policy absence if not enforced;
- owner is not committed from member data in Phase 0; render `owner not recorded` or omit.

Acceptance:

- every rendered field maps to a real source;
- missing objective/budget/policy does not render as a fake default;
- archived state is not promised unless existing commands expose archived channels;
- owner is not inferred from the caller's channel-list role or uncommitted member context.

### R3 - Room timeline composition

Goal: make selected Room timeline unavailability explicit.

Rules:

- Rooms mode does not dispatch `GET_CHANNEL_TIMELINE`;
- no selected timeline item renders as committed Room content in Phase 0;
- task cards, approvals, receipts, and costs do not enter the Room timeline unless server linkage proves Room attribution;
- no pending composer messages appear in Rooms mode because Rooms mode exposes no composer;
- the timeline area renders unavailable/not on wire copy and may link to legacy Channels only if that does not dispatch a Room-owned command.

Acceptance:

- delayed responses for Room A never render in Room B and never render as selected Room content in Rooms mode;
- switching Rooms does not acknowledge, mutate, or refetch the previous Room unexpectedly;
- channel authorization failures do not clear, validate, or revive selected Room content in Rooms mode because raw errors are not scoped/ordered production inputs;
- no session-scoped item is labelled Room-scoped without proven linkage.
- legacy Channels mode still preserves existing composer and ACK behavior when `NEXT_PUBLIC_ROOMS_UI=0`.

### R4 - Current-session evidence and Room activity summary

Goal: give operators a clearly global scan surface for active/blocked/approval/completed current-session work without false Room attribution, plus a fixed Room Activity Summary unavailable/not-on-wire surface.

Acceptance:

- Room Activity Summary exists as a labelled surface even when it says `not on wire`;
- Room Activity Summary renders an explicit `not on wire`/unavailable state and does not derive from selected timeline, member, presence, global agent, approval, receipt, cost, or task caches;
- R4 must not dispatch `LIST_SCHEDULES` or any new queue/schedule command;
- pending approvals appear as session-scoped unless gateway linkage proves Room attribution;
- running tasks appear in Active with epoch-anchored elapsed and attribution state;
- completed/failed runs show receipt or safe-export availability only in the separate current-session evidence surface when available and navigate to Task Stream for existing actions;
- unknown scheduled state is not fabricated;
- empty bucket states are distinguishable from loading and unavailable states.

### R5 - Control Rail

Goal: expose Room governance signals without implying unenforced policy or introducing a new mutation surface.

Acceptance:

- assigned agents always render `unknown/not loaded` with navigation to Agents; Rooms mode does not dispatch `LIST_AGENTS` and does not read cached `LIST_AGENTS` frames for selected-Room truth;
- working-now state is not shown as a selected-Room fact in Phase 0;
- any budget, approvals, receipts, or memory information shown in the rail is a link to its established global surface and is not mislabeled as Room-enforced state;
- no auto-reply, schedule, budget, approval, emergency-stop, create-agent, or update-agent control appears in the Room shell;
- no composer, ACK, member mutation, or export-policy mutation control appears in the Room shell;
- no safe-export, download, retry, resume, file-write, or external-effect handler appears in the Room shell;
- no dead buttons.

### R6 - Verification, diagnostics, and copy audit

Goal: prove the Room shell did not widen authority or mislead operators.

Required checks:

- click-everything test: dispatched actions are a subset of the expected existing action allowlist for each view;
- baseline action ledger lists the exact existing actions reachable from Rooms, their source component, and the user control that can dispatch each one;
- global-surface navigation callbacks open the existing surfaces without dispatching Room-owned commands;
- all four flag combinations for `NEXT_PUBLIC_COLLAB_UI` and `NEXT_PUBLIC_ROOMS_UI`;
- delayed timeline/member frames for Room A after switching to Room B are ignored by Rooms mode and never render as selected Room content;
- membership revocation and selected Room removal do not produce fabricated selected-member/owner/agent facts; list omission remains passive uncertainty;
- disconnect/stale state while the Room view is mounted: the Room remains mounted, the last list-backed selected row is labelled stale/disconnected, and Room-owned selected-Room timeline/member reads remain unavailable;
- reconnect may refresh the channel list; selected Room details remain unavailable either way, and list uncertainty is shown without existence/revocation claims;
- proof that Rooms mode does not dispatch `GET_CHANNEL_TIMELINE`, `LIST_CHANNEL_MEMBERS`, or `ACK_CHANNEL_CURSOR`;
- no forbidden phrases from section 7;
- no red color except errors/destructive actions per `TORQCLAW_UI_SPEC.md`;
- no fake counters: numeric unread, member count, Room spend cap, objective;
- accessibility pass for keyboard navigation through Room list, timeline, activity summary, current-session evidence, and rail;
- if mobile tabs are used, active tab uses correct selected semantics and every tab has an accessible name;
- if a drawer is used, focus is trapped while open, Escape closes it, and focus returns to the invoking control;
- loading, error, unavailable, and stale states have text announcements and are not conveyed by color alone;
- contrast for status text and controls meets WCAG AA for normal text where applicable;
- support diagnostics expose flag state, selected Room id if list-backed, last list command/result class, stale/sync state, Rooms-mode timeline/member/ACK-disabled state, and attribution state for session items.

---

## 9. Acceptance Criteria

### A1 - No authority widening

With `NEXT_PUBLIC_ROOMS_UI=1`, Room-owned controls are passive/read-only and cannot post messages, ACK cursors, mutate membership, mutate export policy, manage agents, change schedules, make approval decisions, spend budget, or send external messages. Legacy Channels controls remain available only when Rooms mode is disabled.

Evidence required:

- dispatched command allowlist test;
- static grep for new `action:` literals if no new commands are intended;
- explicit list of all commands reachable from Room UI controls.

### A2 - Honest Room projection

Every Room field has a named source or renders as absent.

Evidence required:

- test fixture omitting objective, budget, receipt, policy, owner, and count fields;
- DOM contains no fabricated fallback values except approved phrases like `not recorded`, `not on wire`, `unknown/not loaded`, or `not enforced at Room scope yet`. For receipt absence specifically, Phase 0 must use `receipt state unknown/not loaded` unless a future correlated/as-of receipt contract proves definitive absence.

### A3 - Approval integrity

Room-owned approval summaries are navigation aids only. The only decision path remains the existing global approval surface, and Room attribution requires server proof.

Evidence required:

- clicking timeline text, mentions, labels, and non-approval controls cannot dispatch approval decisions;
- Room-owned approval summaries do not render approval/reject buttons and cannot dispatch approval decisions;
- approval/reject buttons appear only after navigation opens the established global approval surface;
- denial/approval updates reflect gateway-confirmed state after failed-send and reconnect, not local optimistic mutation;
- no session-scoped approval is labelled Room-scoped without `channelId` or server-owned `requestId -> channelId` linkage.

### A4 - Receipt traceability

Every terminal activity shown in current-session evidence shows a path to its receipt or an honest current-wire unknown state. Phase 0 must not claim definitive receipt absence from an uncorrelated `receipt:null` frame.

Evidence required:

- completed activity with receipt -> passive availability/link-to-existing-surface visible;
- failed activity with safe export -> passive availability text and Task Stream navigation visible, with no Room-owned export/download handler;
- terminal activity without loaded/proven receipt -> `receipt state unknown/not loaded` or equivalent, not `receipt not recorded` and not a broken link; definitive `receipt not recorded` is deferred until a correlated/as-of receipt contract is authorized;
- no receipt is labelled Room-scoped without server-owned linkage.

### A5 - Activity and evidence usefulness

The Room Activity Summary plus Current-session evidence surface must let the operator answer within 10 seconds:

- what Room-backed activity is recorded, if any;
- what current-session work is running;
- what current-session work is awaiting approval;
- what current-session work failed;
- what current-session work completed;
- what lacks evidence;
- which items are Room-proven vs session-scoped.

Evidence required:

- fixture with at least one Room-backed activity item or an explicit `not on wire` Room Activity Summary state;
- fixture with at least one item in each available current-session bucket;
- empty bucket states are distinguishable from loading states;
- no bucket appears when its source data is entirely unavailable unless explicitly labeled unavailable.

### A6 - Responsive UIX

Room list, timeline, Room Activity Summary, current-session evidence, and rail remain usable at desktop and mobile widths.

Evidence required:

- Playwright or equivalent screenshot review at desktop and narrow viewport if implementation reaches UI;
- no text overlap;
- no card-in-card nesting;
- controls remain keyboard reachable;
- tab or drawer controls have accessible names and selected/open state semantics;
- drawer focus is trapped while open and returns to the opener on close;
- status, loading, stale, unavailable, and error states are announced with text and not color alone;
- contrast review covers non-error status colors and action controls.

### A7 - Cross-Room isolation

A selected Room cannot leak, mutate, acknowledge, or display selected content from another Room. In Rooms mode there are no Room-owned write, timeline, member, selected-detail, or ACK controls. Local row highlight is not authority. List omission alone is non-authoritative and does not change selected details because selected details are unavailable in Phase 0.

Evidence required:

- delayed timeline/member frames for Room A never render in Room B and never render as selected Room content in Phase 0;
- selected-Room timeline, member, presence, assigned-agent, and denial commits are not implemented in Phase 0. Generic or unscoped errors are non-authoritative and cannot clear, validate, or revive selected Room content;
- cold start, reload, mode change, or persisted selection hints cannot validate, read, or repopulate selected Room details;
- selected timeline/member content never commits in Phase 0; no timeline/member watermark is tracked or compared;
- stale/disconnected labeling applies to the list surface only; no denial retirement is claimed without a future typed control-result stream;
- revocation is not reflected from current Rooms-mode wire evidence; bounded omission is not revocation evidence;
- selected Room omission from a list is passive uncertainty only; because Phase 0 has no server-owned list-completeness discriminator, omission cannot enter stale, clear data, disable reads, or infer hidden/nonexistent/revoked state;
- disconnected or explicitly stale connection state labels the list as stale/disconnected, keeps selected timeline/member/detail reads unavailable, and does not claim selected freshness on reconnect;
- matching scoped denial retirement is deferred until a later typed, ordered control-result stream exists;
- no uncommitted member/timeline context is shown in Rooms mode;
- switching Rooms does not acknowledge, mutate, or refetch the previous Room unexpectedly;
- hidden and nonexistent channels remain indistinguishable to the client;
- no session-scoped approval or receipt is labelled Room-scoped without proven linkage.

### A8 - Performance and supportability

The Room shell must not make the existing console feel heavier or harder to debug.

Evidence required:

- first render uses existing loading states and does not block the Room list on a selected timeline response;
- each Room selection issues no selected `GET_CHANNEL_TIMELINE` or `LIST_CHANNEL_MEMBERS` request in Rooms mode;
- Room switch does not trigger timeline/member fetch storms;
- support diagnostics include feature flags, selected Room id when list-backed, last list command/result class, stale/sync state, and attribution state;
- rollback by disabling `NEXT_PUBLIC_ROOMS_UI` restores the current Channels path with no migration.
- dogfood promotion/rollback evidence is recorded per section 6.1 before broader rollout.

### A9 - Conservative control surface

Rooms preserves the legacy collaboration surface by leaving legacy Channels behavior intact when Rooms is disabled, while Rooms mode itself remains a read-only product shell rather than a governance control plane.

Evidence required:

- Room-shell controls are limited to Rooms list refresh/navigation, local row highlighting, global-surface navigation callbacks, and read-only/unavailable labels;
- agent creation/profile editing, approvals, budgets, schedules, auto-reply, and emergency stop remain reachable only through their existing global surfaces;
- message composer, ACK, member mutation, and export-policy mutation remain reachable only through legacy Channels mode or a later gated packet with server-correlated authority;
- no Room UI action can infer, create, or mutate a `requestId -> channelId` linkage.

### A10 - Privacy-preserving observability

Phase 0 supportability must not turn Room content into a new telemetry stream.

Evidence required:

- no new analytics event includes Room message bodies, task prompts, assembled context, tool arguments, receipts, or raw diagnostics;
- support diagnostics remain local/operator-visible and respect the authorization rule for selected Room id;
- rollout evidence may use aggregated view/error/rollback counts only if an existing approved telemetry mechanism already supports them; otherwise dogfood evidence is recorded manually.

---

## 10. Open Questions

Decision owner: the TORQCLAW operator/product owner. The Phase 0 defaults below are accepted for the authorized implementation unless superseded by a later gated packet.

OQ-1. Should Phase 0 introduce a persisted Room objective, or should objective wait for a backend Room metadata table?

Default for Phase 0: do not persist objective. Render existing data only.

OQ-2. Should Room-level budget be enforced now, or should UI disclose that current budgets are per task/session?

Default for Phase 0: disclose per-task/session only. Do not claim Room enforcement.

OQ-3. Should the Room shell absorb AgentsPanel, or link to it as a separate management view?

Default for Phase 0: render assigned agents as `unknown/not loaded` and working agents as unavailable/not shown; provide typed navigation to Agents. Keep full create/edit management in Agents until a later slice adds correlated Room-scoped agent authority.

OQ-4. Should external channel adapters be mentioned in the UI?

Default for Phase 0: no. External adapters are not the product proof and carry unresolved identity/security work.

OQ-5. What should the feature flag be called?

Proposed: `NEXT_PUBLIC_ROOMS_UI` for console-only UIX. It is effective only when `NEXT_PUBLIC_COLLAB_UI=1`; it does not replace the existing collab gate.

OQ-6. When should true Room-scoped approvals/receipts ship?

Default for Phase 0: defer. A later PRD should define a gateway-owned attribution contract before any UI labels approvals, receipts, or costs as Room-owned.

OQ-7. Should a later phase introduce Room-local governance controls after server read models exist?

Default for Phase 0: no. A later PRD must separately define command authority, persisted state reads, audit receipts, rollback, and per-control approval behavior before moving any global control into a Room.

---

## 11. Risks

| Risk | Why it matters | Control |
|---|---|---|
| UI implies governance that backend does not enforce | Operators may trust fake Room policy. | Render absence plainly; no Room budget/path/tool claims without backend enforcement. |
| Room timeline blurs chat and execution truth | Chat history could be mistaken for receipts. | Keep channel timeline and session activity separate until server ordering/linkage exists. |
| Inline approvals become perceived chat approvals | Violates frozen authority model. | Room-owned summaries navigate to the established global approval surface only; approval controls remain there and attribution requires server proof. |
| Phase 0 accidentally starts Phase 3 adapters | Reopens unresolved external identity/channel-originated approval problems. | Non-scope and no adapter code. |
| Agent presence leaks beyond entitlement | Working state can reveal execution activity. | Do not render selected-Room working-agent or presence facts in Phase 0; defer any side channel to a later correlated contract. |
| Rooms rename breaks tests/docs | Existing code uses channel terminology. | Product label only; keep command/storage names unchanged. |
| Archived Rooms are falsely discoverable | Existing list behavior may exclude archived channels. | Limit Phase 0 to active Rooms unless current commands expose archived state. |
| Stop state is misleading after reconnect | Mutation result is not the same as durable read state. | Omit persisted state or label connection-local unless a read command exists. |
| Current-session evidence is mistaken for selected-Room work | Screen proximity can look like an attribution claim. | Use a separate labeled surface, never a Room badge, and retain attribution state on every session item. |
| Room shell becomes a shadow administration plane | Relocating controls can change authority perception and test surface. | Keep the Phase 0 Control Rail read-only and link to established global controls. |

---

## 12. Implementation Notes for Future Builder

Likely files if this PRD is later approved:

- `apps/console/src/components/TorqTerminal.tsx`
- `apps/console/src/components/ChannelsPanel.tsx`
- `apps/console/src/components/AgentsPanel.tsx`
- `apps/console/src/components/friendly.ts`
- existing console tests for channels, agents, terminal task cards, receipts, and approvals

Do not touch without explicit implementation authorization:

- `packages/contracts/src/commands.ts`
- `packages/gateway/src/server.ts`
- `packages/gateway/src/authz.ts`
- `packages/gateway/src/collabSurface.ts`
- `packages/gateway/src/approvalDelivery.ts`
- `packages/collab/src/*`
- `engines/hermes_kernel/*`

---

## 13. Gate Checklist

Before any implementation:

- [x] Operator accepts or revises OQ defaults.
- [x] Sol review completed.
- [x] Main-agent revision completed after Sol review.
- [x] Terra review completed.
- [x] Final main-agent revision completed after Terra review.
- [ ] PRD-MAP update planned separately if the operator wants docs index changes.

Before merge of any future implementation:

- [ ] Feature flag off equals current behavior.
- [ ] No new gateway/contract command unless a new PRD revision authorizes it.
- [ ] No authority widening.
- [ ] No fabricated Room metadata.
- [ ] No false Room attribution for approvals, receipts, costs, or runs.
- [ ] No external adapter work.
- [ ] Tests cover click-dispatch allowlist and cross-Room isolation.
- [ ] Visual verification covers desktop and narrow viewport.




