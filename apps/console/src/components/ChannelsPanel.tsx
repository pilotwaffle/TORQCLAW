'use client';

// PRD-TCLAW-COLLAB-PRESENCE-UI-005 S2 + S3 — Console Channels view.
//
// Fourth nav view over the S1 wire read surface (LIST_CHANNELS /
// GET_CHANNEL_TIMELINE, packages/gateway/src/collabSurface.ts) plus S3's
// composer (POST_CHANNEL_MESSAGE). No presence/roster, no live delivery —
// those are S4/S5. Flag-gated by NEXT_PUBLIC_COLLAB_UI at the TorqTerminal
// call site; this component itself assumes it is only ever mounted when the
// flag is on (mirrors ApprovalHistoryPanel/ReceiptsPanel/MemoryPanel, none of
// which re-check their own flag either).
//
// SAFETY: the ONLY sendCommand actions reachable from anywhere in this file
// are LIST_CHANNELS (mount, manual refresh), GET_CHANNEL_TIMELINE (channel
// select, "Load more", post-ack-triggered re-read — the wire pages forward
// only, see B-2 fix note at the button below), and POST_CHANNEL_MESSAGE
// (composer Send/retry — the ONLY addition to the allowlist, per §14 T-11).
// No roster/presence (S5), no live delivery (S4). ChannelRow, TimelineEventRow,
// and PendingSendRow are MODULE-SCOPE components whose props are plain data
// (zero function-typed fields except PendingSendRow's narrow onRetry) —
// mirrors ApprovalHistoryRow / ReplayEventRow's structural boundary.
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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientCommand, GatewayEvent } from '@torqclaw/contracts';

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
): { eventId: string; cursor: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
    if (
      meta.collabMessagePosted === true &&
      meta.channelId === channelId &&
      typeof meta.eventId === 'string' &&
      typeof meta.cursor === 'string'
    ) {
      return { eventId: meta.eventId, cursor: meta.cursor };
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

  const requestTimeline = (channelId: string, cursor: string) => {
    if (timelineTimer.current) { clearTimeout(timelineTimer.current); timelineTimer.current = null; }
    const sent = sendCommand({
      action: 'GET_CHANNEL_TIMELINE',
      channelId,
      cursor: safeCursor(cursor),
      limit: 50,
    });
    if (!sent) { setTimelinePhase('sendFailed'); return; } // never arms the timer
    setTimelinePhase('pending');
    timelineTimer.current = setTimeout(() => {
      setTimelinePhase((p) => (p === 'pending' ? 'timeout' : p));
    }, TIMEOUT_MS);
  };

  useEffect(() => {
    if (!selectedChannelId) return;
    const found = timelineByChannelId[selectedChannelId];
    if (found) {
      if (timelineTimer.current) { clearTimeout(timelineTimer.current); timelineTimer.current = null; }
      setTimelinePhase('idle');
    }
  }, [selectedChannelId, timelineByChannelId]);

  useEffect(() => {
    return () => { if (timelineTimer.current) clearTimeout(timelineTimer.current); };
  }, []);

  const selectChannel = (channelId: string) => {
    setSelectedChannelId(channelId);
    // Fresh load from cursor '0' — clear any prior accumulated snapshot for
    // this channel so the merge logic above starts clean instead of folding
    // a from-scratch page onto stale history from an earlier selection.
    setTimelineSnapshots((prev) => ({ ...prev, [channelId]: null }));
    if (timelineTimer.current) { clearTimeout(timelineTimer.current); timelineTimer.current = null; }
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
    const hasSendingForChannel = pendingSends.some(
      (p) => p.channelId === selectedChannelId && (p.phase === 'sending' || p.phase === 'awaitingConfirm'),
    );
    if (!hasSendingForChannel) return;
    requestedAckEventIds.current.add(ack.eventId);
    setPendingSends((prev) =>
      prev.map((entry) =>
        entry.channelId === selectedChannelId && entry.phase === 'sending'
          ? { ...entry, phase: 'awaitingConfirm', ackedEventId: ack.eventId }
          : entry,
      ),
    );
    // Re-read from the snapshot's current cursor (or '0' if none yet) --
    // the coalesced-refetch pattern S4 specifies; here driven by the ack
    // hint rather than a live-delivery hint, same mechanism.
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
