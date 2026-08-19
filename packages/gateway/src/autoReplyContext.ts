/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S3 (G1R Gate-1 N-1, required S3
 * criterion, non-blocking at Gate 1) — ANCHOR + WINDOW context assembly.
 *
 * Cursor paging (store.ts's getChannelTimeline, limit in [1,100]) makes an
 * auto-turn's context FIT inside a bounded page; it does not make it
 * USEFUL. At turn 200 an agent reading only the last 50 events sees the
 * tail of a conversation whose premise was set at event 3 -- and the
 * human's authorizing message is the FIRST thing to fall off a tail-only
 * read. Two correctness failures follow: premise loss (agents converge on
 * something contradicting the human's original instruction) and
 * loop-by-amnesia (A and B re-derive the same exchange because neither can
 * see they already had it).
 *
 * G1R's explicit instruction: reuse ollama.ts's truncateHeadTail
 * head+tail-with-marker discipline rather than inventing a new pattern.
 * This module is the channel-timeline analogue: always include the
 * channel's first N events (containing the human's authorizing message)
 * plus the most recent M, with the elision EXPLICITLY MARKED so the model
 * knows the record is partial -- never a silent truncation.
 */

import type { CollaborationStore, CallerContext, TimelineEventObject } from '@torqclaw/collab';

export const ANCHOR_EVENT_COUNT = 10;
export const WINDOW_EVENT_COUNT = 40;

export type AnchorWindowResult = {
  /** The rendered, model-facing text block. */
  text: string;
  anchorCount: number;
  windowCount: number;
  elided: number;
  totalKnown: number;
};

/**
 * Fetch the channel's first ANCHOR_EVENT_COUNT events (cursor "0" forward)
 * and its most recent WINDOW_EVENT_COUNT events (walked backward via
 * repeated forward pages, since getChannelTimeline is forward-only by
 * design), then render both with an explicit elision marker between them
 * when they do not already overlap/adjoin.
 *
 * Two store calls, exactly as G1R's ruling states this needs no new
 * substrate primitive -- getChannelTimeline already exists and is reused
 * verbatim, twice.
 */
export async function buildAnchorWindowContext(
  store: CollaborationStore,
  caller: CallerContext,
  channelId: string,
): Promise<AnchorWindowResult> {
  const anchorPage = await store.getChannelTimeline(caller, {
    channelId,
    afterCursor: '0',
    limit: ANCHOR_EVENT_COUNT,
  });
  const anchor = anchorPage.events;

  // Walk forward from the anchor's end to find the tail window. We do not
  // know the total count in advance, so page forward accumulating a
  // ring-buffer-like tail of the last WINDOW_EVENT_COUNT events. Bounded:
  // each page is up to 100 events (store's own max), and this loop only
  // continues while hasMore is true, so it terminates with the substrate's
  // own event count, never runs unbounded.
  let cursor = anchor.length > 0 ? anchor[anchor.length - 1]!.cursor : '0';
  let hasMore = anchorPage.hasMore;
  const tailBuffer: TimelineEventObject[] = [];
  const PAGE = 100;
  // Safety valve: cap total pages walked so a pathologically long channel
  // cannot make one auto-turn's context assembly walk forever. 10,000
  // pages * 100 events/page = 1,000,000 events is far beyond any channel
  // this program will see in practice; this is a defensive bound, not a
  // tuned one.
  let pagesWalked = 0;
  const MAX_PAGES = 10_000;
  while (hasMore && pagesWalked < MAX_PAGES) {
    const page = await store.getChannelTimeline(caller, { channelId, afterCursor: cursor, limit: PAGE });
    for (const ev of page.events) {
      tailBuffer.push(ev);
      if (tailBuffer.length > WINDOW_EVENT_COUNT) tailBuffer.shift();
    }
    if (page.events.length > 0) cursor = page.events[page.events.length - 1]!.cursor;
    hasMore = page.hasMore;
    pagesWalked += 1;
  }

  // Determine overlap: if the tail window's first event's cursor is <= the
  // anchor's last event's cursor (or the tail is simply the continuation of
  // a short channel), there is no gap and no marker is needed. Compare by
  // numeric cursor (channel_seq is a dense monotonic integer stringified).
  const anchorLastSeq = anchor.length > 0 ? Number(anchor[anchor.length - 1]!.cursor) : 0;
  const tailFirstSeq = tailBuffer.length > 0 ? Number(tailBuffer[0]!.cursor) : anchorLastSeq;
  const nonOverlapping = tailBuffer.filter((ev) => Number(ev.cursor) > anchorLastSeq);
  const elided = Math.max(0, tailFirstSeq - anchorLastSeq - 1);

  const renderEvent = (ev: TimelineEventObject): string => {
    const kind = ev.kind;
    const text = kind === 'message_posted' && typeof ev.payload.text === 'string'
      ? ev.payload.text
      : JSON.stringify(ev.payload);
    return `[#${ev.cursor}] ${ev.actorPrincipalId} (${kind}): ${text}`;
  };

  const anchorLines = anchor.map(renderEvent);
  const windowLines = nonOverlapping.map(renderEvent);

  const parts: string[] = [];
  if (anchorLines.length > 0) {
    parts.push(`--- CHANNEL START (first ${anchorLines.length} event(s), including the authorizing instruction) ---`);
    parts.push(...anchorLines);
  }
  if (elided > 0) {
    parts.push(`[ELIDED: ${elided} event(s) omitted between the channel start and the recent window below — this record is PARTIAL]`);
  } else if (anchorLines.length > 0 && windowLines.length > 0) {
    parts.push('--- (channel continues without a gap) ---');
  }
  if (windowLines.length > 0) {
    parts.push(`--- RECENT (last ${windowLines.length} event(s)) ---`);
    parts.push(...windowLines);
  }

  return {
    text: parts.join('\n'),
    anchorCount: anchorLines.length,
    windowCount: windowLines.length,
    elided,
    totalKnown: anchorLastSeq > tailFirstSeq ? anchorLastSeq : Math.max(anchorLastSeq, tailFirstSeq + nonOverlapping.length - 1),
  };
}
