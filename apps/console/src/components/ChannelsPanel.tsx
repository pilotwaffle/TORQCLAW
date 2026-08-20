'use client';

// PRD-TCLAW-COLLAB-PRESENCE-UI-005 S2 + S3 + S4 + S5 — Console Channels view.
//
// Fourth nav view over the S1 wire read surface (LIST_CHANNELS /
// GET_CHANNEL_TIMELINE, packages/gateway/src/collabSurface.ts) plus S3's
// composer (POST_CHANNEL_MESSAGE), S4's hint-then-refetch freshness, and
// S5's agent co-presence roster (read-only, see the S5 doc block below).
// Flag-gated by NEXT_PUBLIC_COLLAB_UI at the TorqTerminal call site; this
// component itself assumes it is only ever mounted when the flag is on
// (mirrors ApprovalHistoryPanel/ReceiptsPanel/MemoryPanel, none of which
// re-check their own flag either).
//
// SAFETY: the ONLY sendCommand actions reachable from anywhere in this file
// are LIST_CHANNELS (mount, manual refresh), GET_CHANNEL_TIMELINE (channel
// select, "Load more", hint-triggered re-read, reconnect re-read — the wire
// pages forward only, see B-2 fix note at the button below), and
// POST_CHANNEL_MESSAGE (composer Send/retry — the ONLY addition to the
// allowlist, per §14 T-11). S5's roster adds NO new sendCommand action —
// it is a pure render-time join over data the component already receives
// (see the S5 doc block below). ChannelRow,
// props are plain data (zero function-typed fields except PendingSendRow's
// narrow onRetry) — mirrors ApprovalHistoryRow / ReplayEventRow's structural
// boundary.
//
// ── S4: HINT-THEN-REFETCH (§4 S4 / A4 / T-6) — read this before touching
// the hint effect below. ──────────────────────────────────────────────────
//
// WHERE THE HINT COMES FROM (decision, with file:line evidence): this slice
// adds NO new wire command. The hint is the publishOnly frame
// packages/gateway/src/collabSurface.ts:353-361 already emits from
// handlePostChannelMessage on every successful post
// (`metadata: { collabMessagePosted: true, channelId, eventId, cursor,
// occurredAt }`) -- S3 shipped this frame to drive its own optimistic-echo
// confirmation; S4 reuses the SAME frame as a general "channel N advanced"
// invalidation hint, decoupled from whether THIS composer has a pending
// send outstanding. That frame is seq-less and non-persisted
// (packages/gateway/src/events.ts:96-101's publishOnly), matching §4 S4's
// description exactly ("the gateway's publishOnly frames are seq-less and
// non-persisted"). It rides packages/gateway/src/events.ts's sessionBus,
// keyed by sessionId (events.ts:15 `Map<string, Set<Listener>>`), and
// sessionId is STABLE across reconnects -- the console persists it in
// sessionStorage and replays it as `sessionId` on the CONNECT frame
// (useGatewayStream.ts:35), and the gateway's session-resume path
// (packages/gateway/src/server.ts:268/273) resubscribes the SAME sessionId.
// Multiple concurrent sockets resuming the same session (two tabs, or a
// live tab plus a reconnecting one) are BOTH members of the same
// `Set<Listener>` (events.ts:19-20) and both receive the same publish --
// this is the only multi-viewer freshness path this substrate supports
// today (§11 row 20: the substrate's real per-channel pub/sub is built but
// NOT wired to the gateway; wiring it is explicitly out of this slice's
// scope). No new wire command means no new A6/T-9 matrix is owed by this
// file; collabSurface.ts's existing handler-totality coverage for
// POST_CHANNEL_MESSAGE already governs the frame this slice consumes.
//
// NO DELIVERY GUARANTEE: this file does not claim, test, or imply that a
// hint frame is guaranteed to arrive. The re-read it triggers is a
// convenience; the LIST_CHANNELS/GET_CHANNEL_TIMELINE cursor path (already
// wired, S1) is what actually recovers the contiguous truth -- on every
// channel selection AND on every detected reconnect, independent of
// whether any hint ever fires. "No-loss holds because the store is
// authoritative and channel_seq is monotonic, not because the socket
// promises delivery" (§4 S4, verbatim).
//
// COALESCING IS MANDATORY (Cycle-2 NB-3 / A4): at most ONE
// GET_CHANNEL_TIMELINE is in flight per selected channel at any time. A
// hint that arrives while a re-read is already in flight does NOT fire a
// second request -- it sets a per-channel `dirty` flag; when the in-flight
// read resolves, if dirty, exactly ONE follow-up re-read fires and the flag
// clears. N hints during one in-flight read collapse to exactly one
// follow-up, never N (see hintDirtyRef / requestTimeline below).
//
// RECONNECT: every CONNECTED frame (packages/gateway/src/server.ts's connect
// path, emitted on both fresh connect and resume; S5b may add a self-only
// metadata.principalId there) is watched by its own `id` --
// a NEW CONNECTED event id (never seen before) re-reads the selected
// channel's timeline from cursor '0', the same store-backed contiguous
// path S1 already proves.
//
// OPTIMISTIC ECHO IS FORBIDDEN (§13 S3): a posted message renders via the
// pendingSends strip (visually distinct, dashed border) until — and ONLY
// until — its server-acked eventId is found inside a REAL GET_CHANNEL_TIMELINE
// snapshot; see the confirm effect above the composer state block. Nothing
// in this file renders composer text as a persisted message before that.
//
// HONEST-STATE DISCIPLINE (ApprovalHistoryPanel pattern, copied exactly):
// null = loading (no frame ever arrived); [] = a real frame reported zero
// items. These are NEVER the same rendered state. ReceiptsPanel's `[]` init
// for its list is a KNOWN BUG there and is NOT copied here — both the
// channel list and every channel's timeline snapshot initialize to `null`.
// Write-on-present, never cleared on absence, so ring-buffer eviction of the
// frame that produced a snapshot never blanks an already-rendered view.
//
// NO-FABRICATION DISCIPLINE (§11 feasibility ledger / §2 controlling
// invariant): LIST_CHANNELS returns ONLY channelId, name, state, role,
// lastAcknowledgedCursor — no last-message preview, no member count, no
// timestamp-of-last-activity, and no numeric unread badge is derivable (the
// API never returns the channel's max seq). None of those fields are
// rendered or invented anywhere in this file.
//
// ── S5: AGENT CO-PRESENCE ROSTER (§4 S5 / A5 / A9 / T-9 n/a) — read this
// before touching selectChannelMembers / selectWorkingNow below. ──────────
//
// PRESENCE ONLY, READ-SIDE ONLY. This section adds ZERO mutation and ZERO
// new sendCommand action. The v0.1 design (mirroring task lifecycle events
// INTO collab_events) was CUT by the PRD (§4 S5) precisely because it built
// a second, uncorrectable source of task-state truth — that design does not
// exist anywhere in this file and must never be reintroduced.
//
// A6/T-9 DECLARED NOT-APPLICABLE: S5 adds no wire command (§15 build order:
// "S5 requires the gateway-side task-truth join (row 19)... this is gateway
// render-time work, not a substrate change"). Both roster sections below are
// pure client-side selectors over data ALREADY flowing into this component's
// existing `events` prop — no new ClientCommand variant, no new
// GatewayEvent field, no server change. A6/T-9's handler-totality matrix
// therefore has no new command to grade.
//
// TWO SECTIONS, TWO DISTINCT SOURCES, NEVER MERGED (A9):
//
// 1. "Working now" — selectWorkingNow(events), sourced from the SAME
//    gateway task-truth stream LivenessChip/PresenceCard already render
//    (apps/console/src/components/presence.ts's selectTurnStartMs /
//    selectLivePhase, and TorqTerminal.tsx:244's activeRequestId scan over
//    TIER_SELECTED -> RESULT|ERROR). This is the console's OWN live task —
//    packages/gateway/src/events.ts's sessionBus is keyed by sessionId
//    (events.ts:66-80/117) and every socket subscribes only its own
//    session's bus (server.ts:273), so no cross-session task registry is
//    reachable from this or any console component today (§11 row 19: "no
//    join key from principals to any task; task truth lives in the
//    gateway"). Elapsed time reuses <LiveDuration since={...}> unchanged —
//    epoch-anchored to selectTurnStartMs's earliest-timestamp anchor, so a
//    remount recomputes from the real start instead of resetting to 0:00
//    (LiveDuration.tsx:24-38 ticks off `now - since`, never a counter).
//
// 2. "Members" — selectChannelMembers(selectedSnapshot.events), sourced
//    from the member_added/member_removed timeline event kinds ALREADY
//    wired and rendered as system rows by this file (see
//    SYSTEM_EVENT_LABELS above; payload shape verified at store.ts:1100-
//    1101/:1221, {channelId, principalId, membershipEpoch}). LIST_CHANNELS
//    never returns a member list for any channel (§11 row 14: "returns
//    only channelId, name, state, role, lastAcknowledgedCursor") and no
//    listChannelMembers/getChannelMembers read command exists anywhere in
//    packages/collab/src/store.ts — so replaying the add/remove events
//    already present in the LOADED timeline page is the only wire-sourced
//    membership view available without a new command. This is a reduce,
//    not an invention: last event per principalId (by cursor/channel_seq,
//    ascending) wins, exactly mirroring how the store itself computes
//    membership_epoch transitions.
//
// HONEST INCOMPLETENESS (does not overclaim): the member replay reflects
// ONLY member_added/member_removed events inside the currently loaded
// timeline page(s) for the selected channel — a channel whose earliest
// membership event is older than the oldest loaded page will UNDERCOUNT
// until "Load more" reaches it. The panel says so explicitly (see the
// "as loaded so far" caption) rather than presenting a partial replay as a
// complete roster.
//
// S5b SELF-ONLY IDENTITY (updated; recorded, not silently assumed):
// GatewayEventSchema (packages/contracts/src/events.ts:19-29) still carries
// no THIRD-PARTY principalId/agentId field. The CONNECTED frame may now carry
// `metadata.principalId` for the CONNECTION'S OWN resolved collab principal
// only (server.ts; omitted entirely for legacy/flag-off/channel-service
// connections). That is self-disclosure, sufficient to mark "you" inside an
// already-loaded Members roster. It is NOT a cross-participant identity join:
// "Working now" still cannot be matched against OTHER principals' tasks,
// because no third-party task telemetry is on the wire. A9's "presence never
// implies membership, membership never implies presence" therefore remains
// enforced STRUCTURALLY — the two sections are independent renders with
// independent empty/loading states; the self marker never filters or gates
// either section and never fabricates membership when the self principal is
// absent from the loaded page.
//
// NO DISPATCH AFFORDANCE (A5): every roster row below is plain data with
// zero function-typed props and zero onClick/button/link — presence is
// information, never a control.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientCommand, GatewayEvent } from '@torqclaw/contracts';
import { LiveDuration } from './LiveDuration';
import { selectTurnStartMs, selectLivePhase } from './presence';

const TIMEOUT_MS = 5000;

export interface ChannelListEntry {
  channelId: string;
  name: string;
  state: 'active' | 'archived' | string;
  role: 'owner' | 'agent' | string;
  lastAcknowledgedCursor: string;
}

export interface TimelineEventEntry {
  cursor: string;
  id: string;
  kind: string;
  actorPrincipalId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

interface TimelineSnapshot {
  events: TimelineEventEntry[];
  cursor: string;
  hasMore: boolean;
}

type Phase = 'pending' | 'idle' | 'sendFailed' | 'timeout';

// ── S3: composer byte-budget math ───────────────────────────────────────
//
// VERIFIED against packages/collab/src/text.ts (direct source read,
// 2026-08-17): normalizeMessageText applies TWO INDEPENDENT byte bounds to
// the NFC-normalized form, both of which the composer must honor or it will
// let the user attempt to send text the substrate refuses (the D-1 shape --
// a client guard that looks right and admits input the downstream validator
// rejects):
//   - text.ts:122 countUtf8Bytes(nfcText) in [1, 16384]        (raw bytes)
//   - text.ts:137 countJsonEncodedBytes(nfcText) <= 16384      (JSON bytes)
// countJsonEncodedBytes (text.ts:25-31) is JSON.stringify(text) minus the
// two quote bytes -- i.e. UTF-8 bytes of the ESCAPED form. This is why a
// message of 16,384 newlines passes the raw bound (1 byte each) but fails
// the JSON bound (each \n escapes to two bytes, "\\n", = 32,768 total).
// Both counters below run on raw.normalize('NFC') FIRST (text.ts:115, BEFORE
// either bound is checked), matching the substrate exactly.
const MESSAGE_MAX_BYTES = 16384;
const MESSAGE_APPROACHING_RATIO = 0.9; // warn at 90% of either bound

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function jsonEncodedByteLength(text: string): number {
  const jsonString = JSON.stringify(text);
  return utf8ByteLength(jsonString.slice(1, -1));
}

interface MessageByteBudget {
  nfcText: string;
  rawBytes: number;
  jsonBytes: number;
  /** The tighter of the two bounds -- what actually gates "can send". */
  bindingBytes: number;
  overCap: boolean;
  approaching: boolean;
  empty: boolean;
}

/** Mirrors normalizeMessageText's bound check exactly (text.ts:110-161),
 *  client-side, on the client's own normalized copy -- this is a
 *  pre-filter/UX aid, NEVER the authoritative rejection (the substrate
 *  re-validates the exact same way server-side and is the only source of
 *  truth for what actually gets persisted). */
function computeMessageByteBudget(raw: string): MessageByteBudget {
  const nfcText = raw.normalize('NFC');
  const rawBytes = utf8ByteLength(nfcText);
  const jsonBytes = jsonEncodedByteLength(nfcText);
  const bindingBytes = Math.max(rawBytes, jsonBytes);
  return {
    nfcText,
    rawBytes,
    jsonBytes,
    bindingBytes,
    overCap: rawBytes > MESSAGE_MAX_BYTES || jsonBytes > MESSAGE_MAX_BYTES,
    approaching: bindingBytes >= MESSAGE_MAX_BYTES * MESSAGE_APPROACHING_RATIO && bindingBytes <= MESSAGE_MAX_BYTES,
    // The substrate permits empty/whitespace-only text (no trim -- text.ts
    // has NO trim step for messages); the composer's decline-to-send-empty
    // rule below is a CLIENT-SIDE choice (§13 S3), not a substrate rule --
    // stated so it is never mistaken for one.
    empty: rawBytes === 0,
  };
}

type PendingSendPhase = 'sending' | 'awaitingConfirm' | 'sendFailed' | 'timeout';

interface PendingSend {
  idempotencyKey: string;
  channelId: string;
  text: string;
  phase: PendingSendPhase;
  /** Set once a collabMessagePosted ack names this send's eventId -- the
   *  signal to trigger a re-read, NOT the signal to render as sent. */
  ackedEventId: string | null;
}

/** Scans `events` BACKWARD for the newest POST_CHANNEL_MESSAGE ack
 *  (collabSurface.ts's handlePostChannelMessage publishOnly frame) whose
 *  idempotencyKey-correlated text/channel match a pending send. The ack
 *  itself is produced ONLY after store.postChannelMessage's await resolves
 *  (i.e. after commit) -- collabSurface.ts:handlePostChannelMessage -- so
 *  seeing it is proof of commit, but it is used here ONLY to trigger a
 *  re-read (GET_CHANNEL_TIMELINE), never to render the message directly --
 *  optimistic echo is forbidden (§13 S3): a message renders exclusively via
 *  the normal timeline snapshot path, once the re-read actually returns it. */
function selectLatestPostAck(
  events: GatewayEvent[],
  channelId: string,
): { eventId: string; cursor: string; idempotencyKey: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
    if (
      meta.collabMessagePosted === true &&
      meta.channelId === channelId &&
      typeof meta.eventId === 'string' &&
      typeof meta.cursor === 'string' &&
      // G2A D-1: an ack with no key is NOT attributable to a send, and
      // stamping an unattributable ack onto every in-flight entry is what
      // let a rejected sibling be cleared as sent. Skip it rather than
      // guess -- the pending row then times out honestly.
      typeof meta.idempotencyKey === 'string'
    ) {
      return { eventId: meta.eventId, cursor: meta.cursor, idempotencyKey: meta.idempotencyKey };
    }
  }
  return null;
}

/** S4: scans `events` BACKWARD for the newest POST_CHANNEL_MESSAGE ack for
 *  `channelId`, regardless of idempotencyKey/pending-send correlation --
 *  this is the general "channel N advanced" invalidation hint (§4 S4), not
 *  the S3 self-send confirmation path (selectLatestPostAck above, which
 *  intentionally stays scoped to a matching 'sending' pendingSends entry
 *  and is NOT reused here). `eventId` is the substrate's own message_posted
 *  event id -- globally unique per post -- so it is a safe per-hint dedup
 *  key independent of who posted or which composer instance (if any) sent
 *  it. Returns null when no ack for this channel has ever been seen, which
 *  this file treats as "no hint yet", never as a reason to skip the
 *  unconditional initial/reconnect re-reads below. */
function selectLatestHintEventId(events: GatewayEvent[], channelId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
    if (meta.collabMessagePosted === true && meta.channelId === channelId && typeof meta.eventId === 'string') {
      return meta.eventId;
    }
  }
  return null;
}

/** S4 reconnect signal: scans `events` for the newest CONNECTED frame's id
 *  (packages/gateway/src/server.ts's connect path, emitted on BOTH fresh connect
 *  and session resume -- `resolved.resumed` distinguishes them but this
 *  file treats both alike, since either one means the socket was re-armed
 *  and any hint that fired while it was down was, by construction, never
 *  seen). A fresh CONNECTED id (never seen before) triggers a from-cursor-
 *  '0' re-read of the selected channel -- store-backed contiguous recovery,
 *  independent of whether any hint frame arrived around the disconnect. */
function selectLatestConnectedId(events: GatewayEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'CONNECTED') return events[i]!.id;
  }
  return null;
}

/** S5b self-disclosure: scans BACKWARD for the newest CONNECTED frame's
 *  self-only `metadata.principalId` (server.ts emits it only for the
 *  connection's OWN resolved collab principal; legacy/flag-off/channel-service
 *  connections omit the field entirely). Returns null when absent — never a
 *  synthesized or third-party principal. */
function selectSelfPrincipalId(events: GatewayEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type !== 'CONNECTED') continue;
    const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
    if (typeof meta.principalId === 'string' && meta.principalId.length > 0) {
      return meta.principalId;
    }
  }
  return null;
}

/** Scans `events` BACKWARD for the newest LIST_CHANNELS response frame,
 *  validating shape. Malformed frames (channels not an array) are skipped —
 *  never crash, never treated as a valid (possibly empty) snapshot. */
function selectLatestChannelList(events: GatewayEvent[]): ChannelListEntry[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
    if (meta.collabChannels === true && Array.isArray(meta.channels)) {
      return meta.channels as ChannelListEntry[];
    }
  }
  return null;
}

/** Scans `events` BACKWARD for the newest GET_CHANNEL_TIMELINE response frame
 *  matching `channelId`, validating shape. */
function selectLatestTimeline(events: GatewayEvent[], channelId: string): TimelineSnapshot | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
    if (
      meta.collabTimeline === true &&
      meta.channelId === channelId &&
      Array.isArray(meta.events) &&
      typeof meta.cursor === 'string' &&
      typeof meta.hasMore === 'boolean'
    ) {
      return { events: meta.events as TimelineEventEntry[], cursor: meta.cursor, hasMore: meta.hasMore };
    }
  }
  return null;
}

/** S4: the GatewayEvent.id of the newest GET_CHANNEL_TIMELINE response frame
 *  for `channelId`, or null. Used ONLY to distinguish "a genuinely NEW
 *  response frame landed" from "the same already-seen frame is still the
 *  newest one in `events`" -- selectLatestTimeline's return is a freshly
 *  allocated object on every call (new reference each render even when the
 *  underlying frame hasn't changed), so a reference/value comparison on ITS
 *  output cannot detect "nothing new arrived"; the frame's own stable
 *  GatewayEvent.id can. This is what makes the in-flight/coalescing guard
 *  correct: without it, the flag-clearing effect would fire on every render
 *  where a timeline frame merely still exists (which is EVERY render once
 *  one has ever landed), permanently defeating coalescing. */
function selectLatestTimelineFrameId(events: GatewayEvent[], channelId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
    if (
      meta.collabTimeline === true &&
      meta.channelId === channelId &&
      Array.isArray(meta.events) &&
      typeof meta.cursor === 'string' &&
      typeof meta.hasMore === 'boolean'
    ) {
      return events[i]!.id;
    }
  }
  return null;
}

// ── S5: roster selectors (§4 S5 / A5 / A9) ─────────────────────────────────
// See the S5 module-doc block above for the full source/authority rationale.

/** A single "member" row derived from replaying member_added/member_removed
 *  timeline events. `since` is that principal's own membership-change
 *  timestamp (their most recent add/remove), never a mount-time value. */
export interface ChannelMemberEntry {
  principalId: string;
  role: 'owner' | 'agent' | string;
  since: string;
}

/** Replays member_added/member_removed events from the (possibly partial —
 *  see the S5 doc block's HONEST INCOMPLETENESS note) loaded timeline page
 *  for one channel into a current-membership view. Reduces by principalId,
 *  keeping the LATEST event (highest numeric cursor, i.e. channel_seq) per
 *  principal — mirrors the store's own membership_epoch transition, which is
 *  exactly what makes "latest wins" correct here rather than an invented
 *  rule: an add followed by a later remove for the same principal nets to
 *  removed, and vice versa. Returns [] (not null) when the timeline is
 *  loaded but carries no membership events yet — the caller distinguishes
 *  "no timeline loaded" (null selectedSnapshot) from "loaded, zero members
 *  seen so far" ([]) using the SAME null-vs-empty discipline as the rest of
 *  this file.
 *
 *  `role` is NOT on member_added/member_removed's payload (only
 *  {channelId, principalId, membershipEpoch} — store.ts:1100-1101/:1221), so
 *  it is never fabricated here: every derived row's role is the literal
 *  string 'member' (an event-kind fact, not a role claim) unless the caller
 *  layers in LIST_CHANNELS' own role field for a principal that happens to
 *  be the connected caller (S1's ChannelListEntry.role) — this function
 *  itself makes no such claim and always returns 'member'. */
export function selectChannelMembers(events: TimelineEventEntry[]): ChannelMemberEntry[] {
  const latestByPrincipal = new Map<string, TimelineEventEntry>();
  for (const ev of events) {
    if (ev.kind !== 'member_added' && ev.kind !== 'member_removed') continue;
    const principalId = ev.payload?.principalId;
    if (typeof principalId !== 'string' || principalId.length === 0) continue;
    const prior = latestByPrincipal.get(principalId);
    if (!prior || Number(ev.cursor) >= Number(prior.cursor)) {
      latestByPrincipal.set(principalId, ev);
    }
  }
  const members: ChannelMemberEntry[] = [];
  for (const [principalId, ev] of latestByPrincipal) {
    if (ev.kind !== 'member_added') continue; // latest event was a removal
    members.push({ principalId, role: 'member', since: ev.occurredAt });
  }
  return members.sort((a, b) => a.principalId.localeCompare(b.principalId));
}

/** The console's OWN currently-running task, if any — the "working now"
 *  overlay's only data source (see the S5 doc block: no cross-session task
 *  registry is reachable from this component). Mirrors
 *  TorqTerminal.tsx:244-251's activeRequestId scan EXACTLY (same TIER_
 *  SELECTED -> RESULT|ERROR state machine) rather than importing it, since
 *  that scan is a local const inside TorqTerminal's function body, not an
 *  exported selector — duplicated here at module scope so this file stays
 *  independently testable without mounting TorqTerminal. `turnStartMs` and
 *  `phaseText` are the same selectTurnStartMs/selectLivePhase every other
 *  liveness surface (LivenessChip, PresenceCard) already renders — one
 *  epoch, every reader agrees. */
export interface WorkingNowEntry {
  requestId: string;
  turnStartMs: number | null;
  phaseText: string | null;
}

export function selectWorkingNow(events: GatewayEvent[]): WorkingNowEntry | null {
  let requestId: string | null = null;
  for (const ev of events) {
    if (ev.type === 'TIER_SELECTED' && ev.requestId) requestId = ev.requestId;
    if ((ev.type === 'RESULT' || ev.type === 'ERROR') && ev.requestId === requestId) requestId = null;
  }
  if (!requestId) return null;
  const turnStartMs = selectTurnStartMs(events, requestId);
  const phase = selectLivePhase(events, requestId);
  return { requestId, turnStartMs, phaseText: phase?.text ?? null };
}

/** Grammar the wire actually accepts (packages/contracts/src/commands.ts):
 *  cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).default('0'). Never send
 *  anything else — a malformed cursor is refused at the wire boundary. */
const CURSOR_GRAMMAR = /^(0|[1-9][0-9]*)$/;
function safeCursor(cursor: string | undefined | null): string {
  return cursor && CURSOR_GRAMMAR.test(cursor) ? cursor : '0';
}

/** occurredAt formatting — VERIFIED shape (2026-08-17, direct source read):
 *  packages/gateway/src/collabSurface.ts:91 constructs the read-path store
 *  with `clock: { next: () => new Date().toISOString() }`; getChannelTimeline
 *  (packages/collab/src/store.ts:1833) sets TimelineEventObject.occurredAt
 *  from `row.created_at`, which is the SAME clock.next() value stamped at
 *  insert time (store.ts:1460/1473). So occurredAt is ISO-8601
 *  (e.g. "2026-08-16T23:55:12.345Z"), NOT the space-separated SQLite
 *  `YYYY-MM-DD HH:MM:SS` shape ApprovalHistoryPanel's timestamps use — this
 *  is a DIFFERENT source (collab_events.created_at, not run_receipts /
 *  tool_approvals columns), so formatApprovalTimestamp does not apply here.
 *  An ISO string WITH a T/Z is safe to parse with `new Date(...)` — the
 *  local-time footgun is specific to zone-less space-separated strings.
 *  Guarded so "Invalid Date" can never reach the DOM: an unparseable value
 *  renders verbatim instead. */
function formatOccurredAt(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return String(raw);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw; // never render "Invalid Date"
  return d.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

/** author label — the wire's TimelineEventObject carries actorPrincipalId
 *  only, never a display name (§11 row 5: message_posted payload is exactly
 *  {channelId, text}). Rendering a truncated id follows the existing
 *  LivenessChip `turn {id.slice(0,8)}` house convention rather than
 *  inventing a name the wire never sent. */
function authorLabel(actorPrincipalId: string): string {
  return typeof actorPrincipalId === 'string' && actorPrincipalId.length > 0
    ? actorPrincipalId.slice(0, 8)
    : '(unknown)';
}

/** Message body text — payload.text per the substrate contract
 *  (postChannelMessage / message_posted). Any other/absent shape renders an
 *  honest placeholder rather than inventing text. Callers MUST gate on
 *  `event.kind === 'message_posted'` before calling this — see B-1 fix
 *  below: a future kind that happens to carry a string `text` field must
 *  NOT be silently rendered as a chat message. */
function messageText(payload: Record<string, unknown>): string {
  return typeof payload?.text === 'string' ? payload.text : '(no text)';
}

/** System-event kind labels — cosmetic only, never data. The wire's six
 *  known kinds (packages/collab/src/migration.ts:117-118):
 *  channel_created, member_added, member_removed, message_posted,
 *  channel_archived, channel_unarchived. Only message_posted renders as a
 *  chat message; the rest render as a distinct system-event row using ONLY
 *  fields verified present on that kind's payload (packages/collab/src/
 *  store.ts: channel_created {channelId,name} :992-993; member_added/
 *  member_removed {channelId,principalId,membershipEpoch} :1100-1101/:1221;
 *  channel_archived/channel_unarchived {channelId,channelEpoch} :1323-1324/
 *  :1406-1407). An unknown/future kind degrades honestly: kind label only,
 *  never "(no text)", never a crash. */
const SYSTEM_EVENT_LABELS: Record<string, string> = {
  channel_created: 'channel created',
  member_added: 'member added',
  member_removed: 'member removed',
  channel_archived: 'channel archived',
  channel_unarchived: 'channel unarchived',
};

/** Renders ONLY fields verified present on that specific kind's payload —
 *  never a synthesized sentence containing data the payload doesn't carry.
 *  Falls back to nothing extra for kinds without a payload-derived detail
 *  (channel_archived/channel_unarchived carry only channelEpoch, which is
 *  bookkeeping, not user-facing detail; the kind label alone is honest). */
function systemEventDetail(kind: string, payload: Record<string, unknown>): string | null {
  if (kind === 'channel_created' && typeof payload?.name === 'string') {
    return payload.name;
  }
  if (
    (kind === 'member_added' || kind === 'member_removed') &&
    typeof payload?.principalId === 'string' &&
    payload.principalId.length > 0
  ) {
    return payload.principalId.slice(0, 8);
  }
  return null;
}

export default function ChannelsPanel({
  events,
  sendCommand,
  onClose,
}: {
  events: GatewayEvent[];
  sendCommand: (command: ClientCommand) => boolean;
  onClose: () => void;
}) {
  // ── Channel list ──────────────────────────────────────────────────────
  const latestChannelList = useMemo(() => selectLatestChannelList(events), [events]);
  const [channels, setChannels] = useState<ChannelListEntry[] | null>(null);
  useEffect(() => {
    if (latestChannelList) setChannels(latestChannelList);
  }, [latestChannelList]);

  const [listPhase, setListPhase] = useState<Phase>('pending');
  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestList = () => {
    if (listTimer.current) { clearTimeout(listTimer.current); listTimer.current = null; }
    const sent = sendCommand({ action: 'LIST_CHANNELS', limit: 50 });
    if (!sent) { setListPhase('sendFailed'); return; } // never arms the timer
    setListPhase('pending');
    listTimer.current = setTimeout(() => {
      setListPhase((p) => (p === 'pending' ? 'timeout' : p));
    }, TIMEOUT_MS);
  };

  useEffect(() => {
    requestList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (latestChannelList) {
      if (listTimer.current) { clearTimeout(listTimer.current); listTimer.current = null; }
      setListPhase('idle');
    }
  }, [latestChannelList]);

  useEffect(() => {
    return () => { if (listTimer.current) clearTimeout(listTimer.current); };
  }, []);

  // ── Selected channel + timeline ─────────────────────────────────────────
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  // Keyed by channelId (ReceiptsPanel keyed-detail approach) but with the
  // null-initialized snapshot rule (never []-init — G1R SC-1 discipline).
  const timelineByChannelId = useMemo(() => {
    const map: Record<string, TimelineSnapshot> = {};
    if (!selectedChannelId) return map;
    const found = selectLatestTimeline(events, selectedChannelId);
    if (found) map[selectedChannelId] = found;
    return map;
  }, [events, selectedChannelId]);

  // B-2 FIX: the wire pages FORWARD (older -> newer): store.ts:1813 is
  // `WHERE channel_seq > ? ORDER BY channel_seq ASC`, and nextCursor
  // (store.ts:1849) is the LAST (newest) event of the page. A newly arrived
  // frame is therefore a page of events NEWER than what's already held, and
  // must be MERGED (deduped by event.id, kept ascending by channel_seq),
  // never used to replace the whole snapshot — replacing drops every prior
  // page the operator was reading.
  const [timelineSnapshots, setTimelineSnapshots] = useState<Record<string, TimelineSnapshot | null>>({});
  useEffect(() => {
    if (!selectedChannelId) return;
    const found = timelineByChannelId[selectedChannelId];
    if (!found) return;
    setTimelineSnapshots((prev) => {
      const existing = prev[selectedChannelId];
      if (!existing) {
        // First frame for this channel selection: nothing to merge with.
        return { ...prev, [selectedChannelId]: found };
      }
      const byId = new Map<string, TimelineEventEntry>();
      for (const e of existing.events) byId.set(e.id, e);
      for (const e of found.events) byId.set(e.id, e);
      const merged = Array.from(byId.values()).sort(
        (a, b) => Number(a.cursor) - Number(b.cursor)
      );
      return {
        ...prev,
        [selectedChannelId]: { events: merged, cursor: found.cursor, hasMore: found.hasMore },
      };
    });
  }, [selectedChannelId, timelineByChannelId]);

  const [timelinePhase, setTimelinePhase] = useState<Phase>('idle');
  const timelineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── S4: coalescing state (§4 S4 / Cycle-2 NB-3 / A4) ────────────────────
  //
  // At most one GET_CHANNEL_TIMELINE re-read is ever "in flight" for the
  // selected channel from this file's own bookkeeping perspective. A hint
  // (or reconnect signal) that arrives while `refetchInFlightRef` is true
  // for that channel does NOT send a second request -- it sets
  // `refetchDirtyRef` for that channel instead. When the in-flight read's
  // response frame lands (the existing timelinePhase-\>'idle' transition
  // below), if dirty, exactly ONE follow-up fires and both flags reset.
  // This is a `Record<channelId, boolean>`, not a single boolean, purely so
  // switching the selected channel mid-flight cannot cross-contaminate a
  // different channel's coalescing state -- in practice only the currently
  // selected channel's entry is ever touched, since hints for a
  // non-selected channel are never read (selectLatestHintEventId is always
  // called with the CURRENT selectedChannelId).
  const refetchInFlightRef = useRef<Record<string, boolean>>({});
  const refetchDirtyRef = useRef<Record<string, boolean>>({});
  const lastHintEventIdRef = useRef<Record<string, string>>({});
  const lastConnectedIdRef = useRef<string | null>(null);
  // Tracks the GatewayEvent.id of the last GET_CHANNEL_TIMELINE response
  // frame this component has already reacted to, per channel. Required
  // because `timelineByChannelId[selectedChannelId]` is TRUTHY on every
  // render once any response has ever landed (selectLatestTimeline just
  // re-finds the same newest frame each time) -- without this, the
  // in-flight-clearing effect below would fire on every render regardless
  // of whether a NEW response actually arrived, permanently defeating
  // coalescing (a hint arriving on any render would see `in flight = false`
  // and fire its own request every time). See selectLatestTimelineFrameId's
  // doc comment for the full explanation.
  const lastTimelineFrameIdRef = useRef<Record<string, string>>({});

  const requestTimeline = (channelId: string, cursor: string) => {
    if (timelineTimer.current) { clearTimeout(timelineTimer.current); timelineTimer.current = null; }
    refetchInFlightRef.current[channelId] = true;
    const sent = sendCommand({
      action: 'GET_CHANNEL_TIMELINE',
      channelId,
      cursor: safeCursor(cursor),
      limit: 50,
    });
    if (!sent) {
      // Send failure is terminal for THIS attempt -- never arms the timer,
      // and never leaves the channel permanently marked in-flight (a stuck
      // `true` here would silently swallow every future hint for this
      // channel, since the coalescing guard below checks it before firing).
      setTimelinePhase('sendFailed');
      refetchInFlightRef.current[channelId] = false;
      return;
    }
    setTimelinePhase('pending');
    timelineTimer.current = setTimeout(() => {
      setTimelinePhase((p) => {
        if (p !== 'pending') return p;
        // A request that times out is also no longer "in flight" from the
        // coalescing guard's perspective -- an operator or reconnect hint
        // that arrives after this must be able to trigger a fresh attempt
        // rather than being coalesced into a response that will never come.
        refetchInFlightRef.current[channelId] = false;
        return 'timeout';
      });
    }, TIMEOUT_MS);
  };

  useEffect(() => {
    if (!selectedChannelId) return;
    const found = timelineByChannelId[selectedChannelId];
    if (found) {
      if (timelineTimer.current) { clearTimeout(timelineTimer.current); timelineTimer.current = null; }
      setTimelinePhase('idle');

      // S4: only treat this as "the in-flight read resolved" when the
      // underlying response FRAME is genuinely new -- see
      // lastTimelineFrameIdRef's doc comment. Without this guard, this
      // branch runs on EVERY render once any timeline frame has ever
      // landed (found is truthy forever after), clearing the in-flight
      // flag unconditionally and defeating coalescing entirely.
      const frameId = selectLatestTimelineFrameId(events, selectedChannelId);
      const isNewFrame = frameId !== null && lastTimelineFrameIdRef.current[selectedChannelId] !== frameId;
      if (isNewFrame) {
        lastTimelineFrameIdRef.current[selectedChannelId] = frameId;
        // The in-flight read (whichever triggered it -- select, "Load
        // more", a hint, or a reconnect) has now resolved. If a hint
        // arrived WHILE it was in flight, `refetchDirtyRef` was set
        // instead of firing a second request (the coalescing guard in the
        // hint/reconnect effects below); fire the single owed follow-up
        // now and clear both flags. If nothing arrived, just clear the
        // in-flight flag so the NEXT hint can fire normally.
        refetchInFlightRef.current[selectedChannelId] = false;
        if (refetchDirtyRef.current[selectedChannelId]) {
          refetchDirtyRef.current[selectedChannelId] = false;
          requestTimeline(selectedChannelId, found.cursor);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId, timelineByChannelId, events]);

  useEffect(() => {
    return () => { if (timelineTimer.current) clearTimeout(timelineTimer.current); };
  }, []);

  // ── S4: hint-triggered coalesced re-read ────────────────────────────────
  //
  // Fires on ANY collabMessagePosted ack for the selected channel -- not
  // just this composer's own in-flight sends (that narrower correlation is
  // selectLatestPostAck / the pendingSends-confirm effect below, UNCHANGED
  // by this slice). "channel N advanced" is read here as "the newest
  // message_posted eventId for this channel differs from the last one this
  // effect reacted to" -- eventId is the substrate's own per-post id,
  // globally unique, so it is immune to two DIFFERENT posts racing the same
  // idempotencyKey namespace (they never share one).
  //
  // NO DELIVERY GUARANTEE: this effect is a convenience trigger only. If the
  // hint frame never arrives (dropped connection, coalesced into the
  // in-flight guard elsewhere, or simply never emitted because this session
  // wasn't subscribed when it fired), the channel-select and reconnect
  // re-reads below are what actually recover the contiguous truth -- this
  // effect is never the ONLY path to a correct render.
  useEffect(() => {
    if (!selectedChannelId) return;
    const hintEventId = selectLatestHintEventId(events, selectedChannelId);
    if (!hintEventId) return;
    if (lastHintEventIdRef.current[selectedChannelId] === hintEventId) return; // not a NEW hint
    lastHintEventIdRef.current[selectedChannelId] = hintEventId;

    if (refetchInFlightRef.current[selectedChannelId]) {
      // COALESCING (mandatory, §4 S4 / Cycle-2 NB-3): a re-read is already
      // in flight for this channel. Mark dirty for exactly ONE follow-up
      // instead of firing a second request -- see the timelinePhase-\>'idle'
      // effect above, which is what actually sends that follow-up once the
      // in-flight read resolves. N hints arriving here while in-flight all
      // set the SAME boolean, so they collapse to exactly one follow-up.
      refetchDirtyRef.current[selectedChannelId] = true;
      return;
    }
    const snap = timelineSnapshots[selectedChannelId];
    requestTimeline(selectedChannelId, snap?.cursor ?? '0');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, selectedChannelId]);

  // ── S4: reconnect-triggered re-read (A4 "disconnect, or reconnect") ─────
  //
  // A NEW CONNECTED frame id (fresh connect OR resume -- both treated
  // alike, see selectLatestConnectedId's doc) re-reads the selected
  // channel's timeline from cursor '0': whatever hints did or didn't arrive
  // while the socket was down, this is the store-backed recovery that does
  // not depend on any of them having been seen. Routed through the SAME
  // coalescing guard as the hint effect above -- a reconnect landing while
  // an unrelated re-read is already in flight marks dirty rather than
  // double-firing.
  useEffect(() => {
    if (!selectedChannelId) return;
    const connectedId = selectLatestConnectedId(events);
    if (!connectedId) return;
    if (lastConnectedIdRef.current === connectedId) return; // not a NEW connect/resume
    lastConnectedIdRef.current = connectedId;

    if (refetchInFlightRef.current[selectedChannelId]) {
      refetchDirtyRef.current[selectedChannelId] = true;
      return;
    }
    requestTimeline(selectedChannelId, '0');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, selectedChannelId]);

  const selectChannel = (channelId: string) => {
    setSelectedChannelId(channelId);
    // Fresh load from cursor '0' — clear any prior accumulated snapshot for
    // this channel so the merge logic above starts clean instead of folding
    // a from-scratch page onto stale history from an earlier selection.
    setTimelineSnapshots((prev) => ({ ...prev, [channelId]: null }));
    if (timelineTimer.current) { clearTimeout(timelineTimer.current); timelineTimer.current = null; }
    // S4: a stale in-flight/dirty/last-frame flag from a PRIOR selection of
    // this same channelId must not leak into this fresh load and cause a
    // spurious extra re-read (or, symmetrically, a missed "resolved"
    // detection) once this request resolves.
    refetchInFlightRef.current[channelId] = false;
    refetchDirtyRef.current[channelId] = false;
    delete lastTimelineFrameIdRef.current[channelId];
    setTimelinePhase('pending');
    requestTimeline(channelId, '0');
  };

  const loadOlder = () => {
    if (!selectedChannelId) return;
    const snap = timelineSnapshots[selectedChannelId];
    if (!snap || !snap.hasMore) return;
    requestTimeline(selectedChannelId, snap.cursor);
  };

  const selectedSnapshot = selectedChannelId ? (timelineSnapshots[selectedChannelId] ?? null) : null;
  const isListRefreshing = listPhase === 'pending' && channels !== null;
  const isTimelineRefreshing = timelinePhase === 'pending' && selectedSnapshot !== null;

  // ── S5: roster (§4 S5 / A5 / A9) — see the module-doc block above. Two
  // independent selectors, two independent sources, never merged. Members
  // is null (not []) exactly when no timeline has loaded yet for the
  // selected channel, matching this file's null=loading/[]=real-empty rule.
  const channelMembers = useMemo(
    () => (selectedSnapshot ? selectChannelMembers(selectedSnapshot.events) : null),
    [selectedSnapshot],
  );
  const workingNow = useMemo(() => selectWorkingNow(events), [events]);
  // S5b: the console's OWN principal, self-disclosed on its own CONNECTED
  // frame. Used only to mark "you" inside the already-loaded member roster;
  // never to infer anyone else's presence or membership.
  const selfPrincipalId = useMemo(() => selectSelfPrincipalId(events), [events]);

  // ── S3: composer (human posting) ────────────────────────────────────────
  //
  // OPTIMISTIC ECHO IS FORBIDDEN (§13 S3): a pendingSends entry NEVER renders
  // as a normal timeline row. It renders in a visually distinct "sending…"
  // strip below the composer until the entry is cleared, which happens ONLY
  // once the confirmed eventId is found inside a REAL timeline snapshot
  // (selectedSnapshot.events, populated exclusively by GET_CHANNEL_TIMELINE
  // responses) -- never on the POST ack alone.
  const [draftText, setDraftText] = useState('');
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  const [composerIdempotencyKey, setComposerIdempotencyKey] = useState<string | null>(null);

  const budget = useMemo(() => computeMessageByteBudget(draftText), [draftText]);

  // A fresh idempotency key is minted once per DRAFT, not once per send
  // attempt: a retry after a dropped socket must reuse the SAME key (B-3) so
  // it cannot commit a duplicate immortal message_posted event, while a NEW
  // message (different text) always gets a NEW key -- never derived from the
  // text itself, which would silently collapse two legitimate identical
  // messages into one idempotency slot.
  useEffect(() => {
    if (composerIdempotencyKey === null) setComposerIdempotencyKey(crypto.randomUUID());
  }, [composerIdempotencyKey]);

  const resetComposer = () => {
    setDraftText('');
    setComposerIdempotencyKey(crypto.randomUUID()); // NEW message => NEW key
  };

  const sendMessage = () => {
    if (!selectedChannelId) return;
    if (budget.empty || budget.overCap) return; // client-side decline, not a substrate rule
    const key = composerIdempotencyKey ?? crypto.randomUUID();
    const channelId = selectedChannelId;
    const text = budget.nfcText;

    const sent = sendCommand({ action: 'POST_CHANNEL_MESSAGE', channelId, text, idempotencyKey: key });
    if (!sent) {
      // Send failure is explicit (§13 S3): surfaced in the pending strip,
      // never a silent drop. The draft text and idempotency key are BOTH
      // preserved so "retry" reuses the exact same key (B-3), not a new one.
      setPendingSends((prev) => [
        ...prev.filter((p) => p.idempotencyKey !== key),
        { idempotencyKey: key, channelId, text, phase: 'sendFailed', ackedEventId: null },
      ]);
      return;
    }

    setPendingSends((prev) => [
      ...prev.filter((p) => p.idempotencyKey !== key),
      { idempotencyKey: key, channelId, text, phase: 'sending', ackedEventId: null },
    ]);
    // Clear the draft immediately (the pending strip carries the in-flight
    // text) so the composer is ready for the next message; the idempotency
    // key rotates to a fresh one for whatever the user types next.
    resetComposer();
  };

  const retrySend = (p: PendingSend) => {
    if (p.channelId !== selectedChannelId) return;
    // Reuses p.idempotencyKey UNCHANGED (B-3) -- this is precisely what a
    // client-supplied canonical UUID is for: a retry of the SAME logical
    // message must not mint a second immortal event.
    const sent = sendCommand({
      action: 'POST_CHANNEL_MESSAGE',
      channelId: p.channelId,
      text: p.text,
      idempotencyKey: p.idempotencyKey,
    });
    setPendingSends((prev) =>
      prev.map((entry) =>
        entry.idempotencyKey === p.idempotencyKey
          ? { ...entry, phase: sent ? 'sending' : 'sendFailed' }
          : entry,
      ),
    );
  };

  // Timeout sweep: a 'sending' entry that never receives a post ack within
  // TIMEOUT_MS surfaces as 'timeout' (never silently stays "sending…"
  // forever) -- same discipline as the list/timeline phase timers above.
  const pendingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    for (const p of pendingSends) {
      if (p.phase === 'sending' && !pendingTimers.current[p.idempotencyKey]) {
        pendingTimers.current[p.idempotencyKey] = setTimeout(() => {
          setPendingSends((prev) =>
            prev.map((entry) =>
              entry.idempotencyKey === p.idempotencyKey && entry.phase === 'sending'
                ? { ...entry, phase: 'timeout' }
                : entry,
            ),
          );
        }, TIMEOUT_MS);
      }
    }
    // Clear timers for entries no longer pending (acked/removed).
    for (const key of Object.keys(pendingTimers.current)) {
      if (!pendingSends.some((p) => p.idempotencyKey === key && p.phase === 'sending')) {
        clearTimeout(pendingTimers.current[key]!);
        delete pendingTimers.current[key];
      }
    }
  }, [pendingSends]);
  useEffect(() => {
    return () => { for (const t of Object.values(pendingTimers.current)) clearTimeout(t); };
  }, []);

  // Post-ack -> trigger a re-read (never a direct render). Watches the
  // latest collabMessagePosted ack for the selected channel; when a
  // 'sending' entry's channel matches and no re-read for that ack has been
  // requested yet, fire GET_CHANNEL_TIMELINE from the CURRENT known cursor
  // so the confirmed message arrives through the ordinary timeline path.
  const requestedAckEventIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedChannelId) return;
    const ack = selectLatestPostAck(events, selectedChannelId);
    if (!ack) return;
    if (requestedAckEventIds.current.has(ack.eventId)) return;
    // G2A D-1: correlate the ack to the ONE send it acks, by idempotencyKey.
    // Previously this matched on channelId + phase==='sending', so with two
    // sends in flight on one channel the surviving ack stamped BOTH -- and
    // the rejected sibling was then cleared by the confirm effect as though
    // it had committed. Silent drop, forbidden in those words by §13 S3/A8.
    // Realistic trigger (G2A): paste a control char like \x07 -- the
    // composer checks byte bounds only, the contract admits it, the
    // substrate rejects it, and the ERROR frame never reaches the console
    // (CO-S3-1). The user loses the draft with no failure state.
    const acked = pendingSends.find(
      (p) => p.idempotencyKey === ack.idempotencyKey && p.channelId === selectedChannelId,
    );
    if (!acked || acked.phase !== 'sending') return;
    requestedAckEventIds.current.add(ack.eventId);
    setPendingSends((prev) =>
      prev.map((entry) =>
        entry.idempotencyKey === ack.idempotencyKey && entry.phase === 'sending'
          ? { ...entry, phase: 'awaitingConfirm', ackedEventId: ack.eventId }
          : entry,
      ),
    );
    // G1R V-1: this comment used to claim "the coalesced-refetch pattern S4
    // specifies... same mechanism" while SKIPPING the mechanism -- it called
    // requestTimeline unconditionally. One collabMessagePosted ack for the
    // operator's OWN send satisfies BOTH selectLatestPostAck (key-correlated)
    // and selectLatestHintEventId (key-agnostic by design), and both effects
    // carry [events, selectedChannelId] in their deps, so a single ack frame
    // ran both in the same commit. They keep SEPARATE dedup ledgers
    // (lastHintEventIdRef vs requestedAckEventIds) so neither suppressed the
    // other: the hint effect armed in-flight, this one ignored it and fired a
    // second concurrent read at the same cursor. Measured 1 extra read PER
    // ACK, unbounded (1,2,3,4 for four sends) -- and the busy-channel burst is
    // exactly the case §4 S4's coalescing clause exists to prevent
    // ("so a busy channel cannot thundering-herd the store", verbatim).
    //
    // Secondary harm the guard also closes: two concurrent reads shared ONE
    // timelineTimer ref, which requestTimeline clears and re-arms
    // unconditionally -- so the second read's timer overwrote the first's and
    // a genuinely hung first read had its timeout silently disarmed, masking
    // a real timeout behind a stale-but-plausible state.
    if (refetchInFlightRef.current[selectedChannelId]) {
      refetchDirtyRef.current[selectedChannelId] = true;
      return;
    }
    const snap = timelineSnapshots[selectedChannelId];
    requestTimeline(selectedChannelId, snap?.cursor ?? '0');
  }, [events, selectedChannelId, pendingSends, timelineSnapshots]);

  // Clear a pendingSends entry ONLY once its acked eventId is found inside
  // the REAL timeline snapshot -- the sole "rendered as sent" trigger. This
  // is the structural enforcement of "optimistic echo is forbidden": nothing
  // upstream of this effect ever removes a pending entry.
  useEffect(() => {
    if (!selectedChannelId) return;
    const snap = timelineSnapshots[selectedChannelId];
    if (!snap) return;
    const confirmedIds = new Set(snap.events.map((e) => e.id));
    setPendingSends((prev) =>
      prev.filter((p) => !(p.channelId === selectedChannelId && p.ackedEventId && confirmedIds.has(p.ackedEventId))),
    );
  }, [selectedChannelId, timelineSnapshots]);

  const channelPendingSends = selectedChannelId
    ? pendingSends.filter((p) => p.channelId === selectedChannelId)
    : [];

  return (
    <div className="absolute inset-0 z-20 flex bg-bg/98 text-[13px] leading-[1.6] text-muted">
      {/* CHANNEL LIST */}
      <div className="w-72 shrink-0 overflow-y-auto border-r border-edge p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted">Channels</h2>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={requestList}
              disabled={isListRefreshing}
              className="text-[10px] text-faint hover:text-ink disabled:opacity-50"
            >
              {isListRefreshing ? 'refreshing…' : 'refresh'}
            </button>
            <button onClick={onClose} className="text-faint hover:text-ink" aria-label="Close channels panel">
              close
            </button>
          </div>
        </div>

        {/* S1: loading — no snapshot ever received yet. */}
        {channels === null && listPhase === 'pending' && <p className="text-faint/75">Loading…</p>}

        {/* S2: send-failed. */}
        {channels === null && listPhase === 'sendFailed' && (
          <p className="text-faint">
            couldn&apos;t request the channel list — connection may be reconnecting;{' '}
            <button type="button" onClick={requestList} className="underline hover:text-muted">
              try again
            </button>
          </p>
        )}

        {/* S3: timeout, no data ever received. */}
        {channels === null && listPhase === 'timeout' && (
          <p className="text-faint">No response — refresh to try again.</p>
        )}

        {channels && (
          <>
            {listPhase === 'timeout' && (
              <p className="mb-2 text-torque">Refresh didn&apos;t return — showing the last list received.</p>
            )}
            {channels.length === 0 ? (
              <div className="rounded-[10px] border border-dashed border-border-strong px-6 py-8 text-center">
                <p className="text-[20px] opacity-60" aria-hidden>◌</p>
                <p className="mt-2 text-[12px] text-muted">No channels yet</p>
                <p className="mx-auto mt-1 max-w-[44ch] text-[10.5px] leading-[1.7] tracking-[0.04em] text-faint">
                  Channels you&apos;re a member of will show up here.
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {channels.map((c) => (
                  <ChannelRow
                    key={c.channelId}
                    channel={c}
                    active={selectedChannelId === c.channelId}
                    onSelect={selectChannel}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* TIMELINE + COMPOSER */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4">
          {!selectedChannelId && <p className="text-faint/75">Select a channel from the list.</p>}

          {selectedChannelId && (
            <>
              {/* S5: roster — two separately-labeled sections, two distinct
                  sources (A9). NO dispatch affordance anywhere in this
                  block: RosterSection's props are plain data, zero
                  function-typed fields, zero buttons/links/onClick. */}
              <RosterSection members={channelMembers} workingNow={workingNow} selfPrincipalId={selfPrincipalId} />

              {/* Timeline honest states, same four-phase shape as the list. */}
              {selectedSnapshot === null && timelinePhase === 'pending' && <p className="text-faint/75">Loading…</p>}
              {selectedSnapshot === null && timelinePhase === 'sendFailed' && (
                <p className="text-faint">
                  couldn&apos;t request the channel timeline — connection may be reconnecting;{' '}
                  <button
                    type="button"
                    onClick={() => selectedChannelId && requestTimeline(selectedChannelId, '0')}
                    className="underline hover:text-muted"
                  >
                    try again
                  </button>
                </p>
              )}
              {selectedSnapshot === null && timelinePhase === 'timeout' && (
                <p className="text-faint">No response — refresh to try again.</p>
              )}

              {selectedSnapshot && (
                <>
                  {timelinePhase === 'timeout' && (
                    <p className="mb-2 text-torque">Refresh didn&apos;t return — showing the last timeline received.</p>
                  )}
                  {selectedSnapshot.events.length === 0 ? (
                    <div className="rounded-[10px] border border-dashed border-border-strong px-6 py-8 text-center">
                      <p className="text-[20px] opacity-60" aria-hidden>◌</p>
                      <p className="mt-2 text-[12px] text-muted">No messages yet</p>
                      <p className="mx-auto mt-1 max-w-[44ch] text-[10.5px] leading-[1.7] tracking-[0.04em] text-faint">
                        This channel has no timeline events yet.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {selectedSnapshot.events.map((ev) => (
                        <TimelineEventRow key={ev.id} event={ev} />
                      ))}
                    </ul>
                  )}
                  {/* "Load more" is an EXPLICIT control (§11 row 13 / §13 S2):
                      the 64 KiB frame cut means a short page does NOT imply the
                      end of history — hasMore is the only honest signal.
                      B-2 FIX: the wire pages FORWARD only (channel_seq
                      ascending, store.ts:1813) — there is no backward-paging
                      capability. The control fetches events NEWER than what's
                      held and the results ACCUMULATE (see the merge effect
                      above), so it is labelled "Load more" rather than
                      "Load older" — the previous label described a direction
                      the wire cannot page in. */}
                  {selectedSnapshot.hasMore && (
                    <button
                      type="button"
                      onClick={loadOlder}
                      disabled={isTimelineRefreshing}
                      className="mt-3 rounded border border-border-strong px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-faint disabled:opacity-50"
                    >
                      {isTimelineRefreshing ? 'loading…' : 'Load more'}
                    </button>
                  )}
                </>
              )}

              {/* S3: pending-sends strip. NEVER a normal timeline row -- a
                  distinct visual container so a "sending…"/"failed" entry can
                  never be mistaken for a persisted message. Cleared ONLY by
                  the confirm effect above (real re-read match), never by
                  time or by receiving the post ack. Rendered REGARDLESS of
                  timeline load state (outside the `selectedSnapshot &&`
                  gate) -- a message can be composed and sent before the
                  channel's timeline has ever successfully loaded, or while a
                  timeline refresh has failed; the composer's own state must
                  not depend on the read path's success. */}
              {channelPendingSends.length > 0 && (
                <ul className="mt-3 space-y-1.5" aria-label="Pending messages">
                  {channelPendingSends.map((p) => (
                    <PendingSendRow key={p.idempotencyKey} pending={p} onRetry={retrySend} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* S3: composer. Only rendered with a channel selected -- posting
            with no selected channel is not offered as an affordance. */}
        {selectedChannelId && (
          <div className="shrink-0 border-t border-edge p-3">
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder="Message this channel…"
              rows={2}
              className="w-full resize-none rounded border border-border-strong bg-transparent px-2 py-1.5 text-[12px] text-ink placeholder:text-faint focus:border-torque/40 focus:outline-none"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              {/* Live byte budget against the REAL cap (§13 S3) — counts
                  BYTES, not string.length, on the NFC-normalized form,
                  against the tighter of the two independent bounds
                  (text.ts:122 raw / text.ts:137 JSON-encoded). */}
              <span
                className={`text-[10px] ${
                  budget.overCap ? 'text-bad' : budget.approaching ? 'text-torque' : 'text-faint'
                }`}
              >
                {budget.bindingBytes.toLocaleString()} / {MESSAGE_MAX_BYTES.toLocaleString()} bytes
                {budget.overCap && ' — over limit'}
              </span>
              <button
                type="button"
                onClick={sendMessage}
                disabled={budget.empty || budget.overCap}
                className="rounded border border-border-strong px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-faint disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * STRUCTURAL SAFETY BOUNDARY — read this before touching this component.
 *
 * PendingSendRow renders a send-in-flight entry ONLY -- it is visually
 * distinct from TimelineEventRow (dashed border, "sending…"/"didn't
 * send"/"no response" labels) precisely so it can never be mistaken for a
 * persisted message (optimistic echo is forbidden, §13 S3). Its only
 * dispatch surface is onRetry, which re-sends the SAME idempotencyKey
 * (B-3) -- never a new one.
 */
function PendingSendRow({
  pending,
  onRetry,
}: {
  pending: PendingSend;
  onRetry: (p: PendingSend) => void;
}) {
  const label =
    pending.phase === 'sending' || pending.phase === 'awaitingConfirm'
      ? 'sending…'
      : pending.phase === 'sendFailed'
        ? "didn't send"
        : 'no response — retry';
  return (
    <li className="rounded border border-dashed border-border-strong px-2 py-1.5 text-[12px]">
      <div className="flex items-center justify-between gap-2 text-[10px] text-faint">
        <span>{label}</span>
        {(pending.phase === 'sendFailed' || pending.phase === 'timeout') && (
          <button
            type="button"
            onClick={() => onRetry(pending)}
            className="underline hover:text-muted"
          >
            retry
          </button>
        )}
      </div>
      <p className="mt-0.5 font-reading text-[13px] leading-[1.6] text-faint">{pending.text}</p>
    </li>
  );
}

/**
 * S5 — agent co-presence roster (§4 S5 / A5 / A9). STRUCTURAL SAFETY
 * BOUNDARY: every prop here is plain data — no sendCommand, no callback of
 * any kind in scope, zero buttons/links/onClick anywhere in this component.
 * Presence is information, never a control (A5's "no roster row carries any
 * dispatch affordance").
 *
 * Two sections, two distinct sources, rendered independently — see the
 * module-doc S5 block at the top of this file for the full source
 * rationale. `members === null` means no timeline has loaded yet for the
 * selected channel (the section renders nothing, matching the timeline's
 * own null=loading convention — there is no separate loading affordance
 * here because the member data rides the SAME frame the timeline already
 * shows a Loading state for). `members === []` is the real-empty case: a
 * timeline loaded but no member_added event has been seen in it yet.
 * `workingNow === null` means the console has no active task right now.
 */
function RosterSection({
  members,
  workingNow,
  selfPrincipalId,
}: {
  members: ChannelMemberEntry[] | null;
  workingNow: WorkingNowEntry | null;
  selfPrincipalId: string | null;
}) {
  if (members === null && workingNow === null) return null;
  return (
    <div className="mb-4 space-y-3 border-b border-edge pb-3">
      <div>
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted">Members</h3>
        {members === null ? null : members.length === 0 ? (
          <p className="mt-1 text-[10.5px] text-faint/75">No members seen yet.</p>
        ) : (
          <>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {members.map((m) => (
                <li
                  key={m.principalId}
                  className="rounded border border-border-strong px-1.5 py-0.5 text-[10px] text-muted"
                  // G1R NB-2: `since` was computed and rendered NOWHERE. It is
                  // that principal's own membership-change timestamp (real
                  // data, correctly derived), so surface it rather than delete
                  // it -- the tooltip already carries the full principal id and
                  // is the honest place for a detail this dense chip cannot
                  // show inline. formatOccurredAt keeps "Invalid Date" out of
                  // the DOM for a malformed or absent value (T-10). S5b adds
                  // "you" ONLY when the self-disclosed CONNECTED principalId
                  // exactly matches this already-loaded member row.
                  title={`${m.principalId} · member since ${formatOccurredAt(m.since)}${m.principalId === selfPrincipalId ? ' · you' : ''}`}
                >
                  {m.principalId.slice(0, 8)}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[9px] text-faint/60">as loaded so far — earlier pages may add more</p>
            {selfPrincipalId && members.some((m) => m.principalId === selfPrincipalId) && (
              <p className="mt-1 text-[9px] text-faint/60">you: {selfPrincipalId.slice(0, 8)}</p>
            )}
          </>
        )}
      </div>
      <div>
        {/* G1R ruling (c) / G2A C-S5-2: the label must not claim more than one
            session can know. S5b now lets CONNECTED carry the connection's OWN
            principalId (self-disclosure only; server.ts omits it when no collab
            principal resolved), but GatewayEventSchema still carries no
            third-party principal/telemetry field and sessionBus is keyed by
            sessionId with each socket subscribed only to its own
            (events.ts:17-28) -- so this section can ONLY ever render the
            VIEWER'S OWN task, never another principal's. "Working now" read as
            a roster of everyone; it is a roster of one. A real cross-participant
            roster remains blocked on the OQ-2 entitlement ruling. */}
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted">
          This console&apos;s task
        </h3>
        {/* The empty state previously read "Nothing running right now.",
            asserting SYSTEM-WIDE idleness -- a claim this console cannot make,
            since it sees only its own session. Scoped to what is knowable. */}
        {workingNow === null ? (
          <p className="mt-1 text-[10.5px] text-faint/75">
            Nothing running in this console.
          </p>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full bg-torque" aria-hidden />
              <LiveDuration since={workingNow.turnStartMs} />
            </span>
            {workingNow.phaseText && <span className="min-w-0 truncate text-faint">{workingNow.phaseText}</span>}
            <span className="text-[9px] uppercase tracking-wide text-faint/70">
              turn {workingNow.requestId.slice(0, 8)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * STRUCTURAL SAFETY BOUNDARY — read this before touching this component.
 *
 * ChannelRow is a MODULE-SCOPE component. Its props are plain data plus a
 * single narrow onSelect(channelId: string) callback — never raw
 * sendCommand, never any dispatch beyond "select this channel to view its
 * timeline" (which is itself only a read, GET_CHANNEL_TIMELINE). No
 * last-message preview, no member count, no activity timestamp is rendered
 * — LIST_CHANNELS does not return them (§11 row 14 / T-12).
 */
function ChannelRow({
  channel,
  active,
  onSelect,
}: {
  channel: ChannelListEntry;
  active: boolean;
  onSelect: (channelId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(channel.channelId)}
        className={`w-full rounded border px-2 py-1 text-left text-[11px] transition-colors ${
          active
            ? 'border-torque/25 bg-torque/[.14] text-torque'
            : 'border-edge text-muted hover:border-border-strong'
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="min-w-0 truncate text-ink" title={channel.name}>{channel.name}</span>
          {channel.state === 'archived' && (
            <span className="rounded border border-border-strong px-1 py-0 text-[9px] uppercase tracking-wide text-faint">
              archived
            </span>
          )}
          <span className="rounded border border-border-strong px-1 py-0 text-[9px] uppercase tracking-wide text-faint">
            {channel.role}
          </span>
        </div>
      </button>
    </li>
  );
}

/**
 * STRUCTURAL SAFETY BOUNDARY — read this before touching this component.
 *
 * TimelineEventRow renders plain data ONLY (TimelineEventEntry) — no
 * sendCommand, no callback of any kind in scope. Message bodies use Inter
 * (font-reading) per §13 S2/§4 S2; all other chrome stays mono (the
 * surrounding file's default font).
 *
 * B-1 FIX: getChannelTimeline returns EVERY event kind, not just messages
 * (packages/collab/src/migration.ts:117-118 defines six). Only
 * `message_posted` renders as a chat message. The other five kinds — and
 * any future/unknown kind — render as a visually distinct system-event row
 * in mono chrome (never font-reading, never through messageText), labelled
 * with the kind, using only fields verified present on that kind's payload
 * (see systemEventDetail). This is what stops a membership/channel-lifecycle
 * event from rendering as a content-free "(no text)" chat bubble.
 */
function TimelineEventRow({ event }: { event: TimelineEventEntry }) {
  const isMessage = event.kind === 'message_posted';
  return (
    <li className="rounded border border-edge px-2 py-1.5 text-[12px]">
      <div className="flex flex-wrap items-center justify-between gap-x-2 text-[10px] text-faint">
        <span className="font-mono" title={event.actorPrincipalId}>{authorLabel(event.actorPrincipalId)}</span>
        <span>{formatOccurredAt(event.occurredAt)}</span>
      </div>
      {isMessage ? (
        <p className="mt-0.5 font-reading text-[13px] leading-[1.6] text-ink">{messageText(event.payload)}</p>
      ) : (
        <p className="mt-0.5 font-mono text-[11px] leading-[1.6] text-faint">
          <span className="uppercase tracking-wide">{SYSTEM_EVENT_LABELS[event.kind] ?? event.kind}</span>
          {systemEventDetail(event.kind, event.payload) !== null && (
            <span> — {systemEventDetail(event.kind, event.payload)}</span>
          )}
        </p>
      )}
    </li>
  );
}
