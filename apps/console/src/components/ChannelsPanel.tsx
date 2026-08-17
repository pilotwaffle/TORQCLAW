'use client';

// PRD-TCLAW-COLLAB-PRESENCE-UI-005 S2 — Console Channels view (read-only).
//
// Fourth nav view over the S1 wire read surface (LIST_CHANNELS /
// GET_CHANNEL_TIMELINE, packages/gateway/src/collabSurface.ts). Read-only in
// this slice: NO posting, NO presence/roster, NO live delivery — those are
// S3/S4/S5. Flag-gated by NEXT_PUBLIC_COLLAB_UI at the TorqTerminal call
// site; this component itself assumes it is only ever mounted when the flag
// is on (mirrors ApprovalHistoryPanel/ReceiptsPanel/MemoryPanel, none of
// which re-check their own flag either).
//
// SAFETY: this panel is STRICTLY READ-ONLY. The only sendCommand actions
// reachable from anywhere in this file are LIST_CHANNELS (mount, manual
// refresh) and GET_CHANNEL_TIMELINE (channel select, "Load more" — the wire
// pages forward only, see B-2 fix note at the button below). There is
// no composer, no posting affordance (not even a disabled one — S3), no
// roster/presence (S5). ChannelRow and TimelineEventRow are MODULE-SCOPE
// components whose props are plain data (zero function-typed fields) —
// mirrors ApprovalHistoryRow / ReplayEventRow's structural boundary.
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

      {/* TIMELINE */}
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
          </>
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
