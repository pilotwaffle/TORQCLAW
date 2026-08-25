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

/**
 * G1D v1.1 amendment / G1R F-1,F-3 (2026-08-24) -- the newest-message-marker
 * micro-slice. These are the ONLY two literal banner strings; the repeated
 * event line inside them is always produced by the same `renderEvent`
 * function used for the RECENT window, never a parallel format string.
 */
export const NEWEST_MESSAGE_BANNER_OPEN = '--- NEWEST MESSAGE — this is the message you are responding to ---';
export const NEWEST_MESSAGE_BANNER_CLOSE = '--- END NEWEST MESSAGE ---';

/**
 * G1D N-1 (2026-08-24 channels-agent-UX packet) -- the narrow self-dedupe
 * rule. Below this length, two "replies" (e.g. "ack", "done", "on it") are
 * exempt from collapsing/suppression even if byte-identical: short
 * acknowledgements are legitimate and repeating one is not a greeting loop.
 * Reviewable, not tuned against a corpus -- the honest floor is "long enough
 * to carry content", not a statistically fit threshold.
 */
export const NEAR_DUPLICATE_MIN_LENGTH = 12;

/**
 * Reviewable similarity threshold (0..1, Jaccard over normalized word sets).
 * Deliberately conservative (high) so this only fires on genuinely
 * near-identical restatements -- the greeting-loop shape -- and never on two
 * distinct replies that merely share common words.
 */
export const NEAR_DUPLICATE_SIMILARITY_THRESHOLD = 0.82;

/**
 * Normalize text for similarity comparison: casefold, collapse whitespace,
 * strip punctuation. Deterministic, no model judgment.
 */
export function normalizeForSimilarity(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Structural (non-model) near-duplicate test shared by the window collapse
 * below and the dispatcher's duplicate-suppression guard. Short texts (under
 * NEAR_DUPLICATE_MIN_LENGTH after normalization) are NEVER considered
 * duplicates of anything -- short acknowledgments must never be suppressed
 * or collapsed (obligation 10).
 */
export function looksLikeNearDuplicateOfOwnRecent(candidate: string, recent: string): boolean {
  const a = normalizeForSimilarity(candidate);
  const b = normalizeForSimilarity(recent);
  if (a.length < NEAR_DUPLICATE_MIN_LENGTH || b.length < NEAR_DUPLICATE_MIN_LENGTH) return false;
  if (a === b) return true;
  const wordsA = new Set(a.split(' ').filter(Boolean));
  const wordsB = new Set(b.split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection += 1;
  const union = wordsA.size + wordsB.size - intersection;
  const similarity = union === 0 ? 0 : intersection / union;
  return similarity >= NEAR_DUPLICATE_SIMILARITY_THRESHOLD;
}

export type AnchorWindowResult = {
  /** The rendered, model-facing text block. */
  text: string;
  /** Message-only external context with no channel, actor, or event identifiers. */
  subscriptionText: string;
  anchorCount: number;
  windowCount: number;
  elided: number;
  totalKnown: number;
};

/**
 * G1D N-1, respecified by G1R Gate-1 REQUIRED CORRECTION (a) (channels-live-
 * defects packet, 2026-08-24): collapse a MUTUALLY NEAR-IDENTICAL RUN of
 * `selfPrincipalId`'s own `message_posted` events down to the most recent
 * one, replacing the collapsed prefix of the run with a single synthetic
 * elision marker in place -- but the per-actor "last kept self-post"
 * reference now SURVIVES interleaving: another actor's message, or a
 * non-message event, no longer resets it. Only a self-message that is NOT a
 * near-duplicate of the surviving reference starts a fresh reference. This
 * is what makes the collapse fire on the REAL live shape (operator and
 * agent strictly alternate) rather than only on artificially-consecutive
 * self-posts, which the original (pre-correction) run-reset-on-interleaving
 * behavior never encountered live (G1D's D-B finding).
 *
 * Still never touches a distinct self-reply (obligation 6b, "the amputation
 * test"): two long, distinct self-authored messages -- with anything at all
 * in between -- are never collapsed into each other, because the predicate
 * (`looksLikeNearDuplicateOfOwnRecent`) is unchanged and still compares
 * against the immediately preceding KEPT candidate only, never a first-of-
 * run or window-wide comparison (G1R F-2: a window-wide order-blind Jaccard
 * collapse would silently destroy a genuine decision reversal -- explicitly
 * rejected).
 *
 * "Mutually near-identical" (not "identical to the very first kept
 * reference") means the reference only advances while each next self-
 * message is a near-duplicate of the immediately preceding KEPT candidate --
 * a conservative choice that never drifts across a topic change one
 * near-duplicate pair at a time.
 */
function collapseSelfRuns<T extends TimelineEventObject>(
  events: T[],
  selfPrincipalId: string,
): Array<T | { elisionOf: T; collapsedCount: number }> {
  const out: Array<T | { elisionOf: T; collapsedCount: number }> = [];
  // Index into `out` of the current per-actor "last kept self-post"
  // reference. Unlike the pre-correction version, this is NEVER reset by an
  // intervening other-actor message or non-message event -- only by pushing
  // a genuinely new (non-collapsed) self-message, which becomes the new
  // reference at its own position in `out`.
  let lastSelfIndex = -1;
  for (const ev of events) {
    const isSelfMessage = ev.kind === 'message_posted'
      && ev.actorPrincipalId === selfPrincipalId
      && typeof ev.payload.text === 'string';
    if (isSelfMessage && lastSelfIndex !== -1) {
      const prevEntry = out[lastSelfIndex]!;
      const prevText = 'elisionOf' in prevEntry
        ? (prevEntry.elisionOf as T).payload.text as string
        : (prevEntry as T).payload.text as string;
      if (looksLikeNearDuplicateOfOwnRecent(ev.payload.text as string, prevText)) {
        // Extend the reference: THIS (more recent) event becomes the kept
        // representative, tallying how many were collapsed under it. G2A
        // B-1 fix: the elision entry must render at ITS OWN (current, most
        // recent) position, not in place at the OLD reference's slot --
        // once the reference survives interleaving, the old slot can be
        // arbitrarily far back, and writing in place there would render a
        // non-monotonic cursor order (the agent's newest reply appearing to
        // precede operator messages it was actually posted after). Remove
        // the stale entry and push the new one at the end, preserving
        // event order otherwise (D-B / G1R delta (iii)).
        const priorCollapsed = 'elisionOf' in prevEntry ? prevEntry.collapsedCount : 0;
        out.splice(lastSelfIndex, 1);
        out.push({ elisionOf: ev, collapsedCount: priorCollapsed + 1 });
        lastSelfIndex = out.length - 1;
        continue;
      }
    }
    // Not a collapse: push this event as-is. If it is a self-message, it
    // becomes the new "last kept self-post" reference; any OTHER event
    // (another actor's message, or a non-message event) is pushed through
    // untouched and leaves the existing reference exactly where it was --
    // this is the correction: interleaving no longer erases the reference.
    out.push(ev);
    if (isSelfMessage) lastSelfIndex = out.length - 1;
  }
  return out;
}

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
 *
 * `selfPrincipalId`, when supplied, additionally collapses mutually
 * near-identical runs of THAT principal's own prior replies (see
 * collapseSelfRuns above) -- optional and additive: omitted (the cron path,
 * cronDispatcher.ts, calls this with no selfPrincipalId), behavior is
 * byte-identical to before this parameter existed.
 *
 * `triggerChannelSeq`, when supplied, identifies the event that AUTHORIZED
 * this turn (the dispatcher's claimed `channelSeq`, autoReplyDispatcher.ts's
 * `claimed.identity.channelSeq`) -- G1D v1.1 amendment / G1R F-1. If an event
 * in the RECENT window has `Number(ev.cursor) === triggerChannelSeq`, is kind
 * `message_posted`, and is NOT self-authored (`actorPrincipalId !==
 * selfPrincipalId`), a labeled NEWEST MESSAGE section repeating that event
 * (rendered by the SAME `renderEvent` used for the window, never a parallel
 * format string) is appended after the RECENT block. On ANY miss -- cursor
 * absent from the window, not a message_posted, self-authored, or the
 * trigger having fallen out of the window under load (R-8, disclosed
 * residual) -- the section is OMITTED ENTIRELY. There is no
 * newest-message fallback of any kind: "use the newest message_posted
 * instead" was the exact defect this amendment withdrew (G1R F-1), because a
 * fresh timeline read at assembly time is a second, racing source of turn
 * identity. Omitted (undefined) is byte-identical to before this parameter
 * existed -- the cron path (cronDispatcher.ts) passes none.
 */
export async function buildAnchorWindowContext(
  store: CollaborationStore,
  caller: CallerContext,
  channelId: string,
  selfPrincipalId?: string,
  triggerChannelSeq?: number,
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

  // N-1: collapse self-runs BEFORE rendering, independently within the
  // anchor and the window (each is rendered as its own labeled block; a run
  // never spans the elided gap between them).
  const anchorCollapsed = selfPrincipalId ? collapseSelfRuns(anchor, selfPrincipalId) : anchor;
  const windowCollapsed = selfPrincipalId ? collapseSelfRuns(nonOverlapping, selfPrincipalId) : nonOverlapping;

  const isElisionEntry = (
    entry: TimelineEventObject | { elisionOf: TimelineEventObject; collapsedCount: number },
  ): entry is { elisionOf: TimelineEventObject; collapsedCount: number } => 'elisionOf' in entry;

  const renderEvent = (
    entry: TimelineEventObject | { elisionOf: TimelineEventObject; collapsedCount: number },
  ): string => {
    if (isElisionEntry(entry)) {
      const ev = entry.elisionOf;
      const text = typeof ev.payload.text === 'string' ? ev.payload.text : JSON.stringify(ev.payload);
      return `[#${ev.cursor}] ${ev.actorPrincipalId} posted ${entry.collapsedCount} earlier repl${entry.collapsedCount === 1 ? 'y' : 'ies'} — elided (most recent shown): ${text}`;
    }
    const kind = entry.kind;
    const text = kind === 'message_posted' && typeof entry.payload.text === 'string'
      ? entry.payload.text
      : JSON.stringify(entry.payload);
    return `[#${entry.cursor}] ${entry.actorPrincipalId} (${kind}): ${text}`;
  };

  const anchorLines = anchorCollapsed.map(renderEvent);
  const windowLines = windowCollapsed.map(renderEvent);

  const renderSubscriptionMessage = (
    entry: TimelineEventObject | { elisionOf: TimelineEventObject; collapsedCount: number },
  ): string | null => {
    if (isElisionEntry(entry)) {
      // Actor-blind (obligation 7): subscriptionText never carries channel,
      // actor, or event identifiers, so the marker names only the count.
      return `[${entry.collapsedCount} earlier repl${entry.collapsedCount === 1 ? 'y' : 'ies'} omitted]`;
    }
    return entry.kind === 'message_posted' && typeof entry.payload.text === 'string'
      ? entry.payload.text
      : null;
  };
  const anchorMessages = anchorCollapsed.map(renderSubscriptionMessage).filter((text): text is string => text !== null);
  const windowMessages = windowCollapsed.map(renderSubscriptionMessage).filter((text): text is string => text !== null);

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

  // G1D v1.1 amendment / G1R F-1,F-3,F-4 (2026-08-24): the newest-message
  // marker. Gated strictly on `triggerChannelSeq !== undefined` -- the cron
  // path (cronDispatcher.ts) passes none, so this section is automatically
  // absent there (obligation 8 / F-4). The trigger event is looked up among
  // the RECENT window's own RAW (pre-collapse) events -- `nonOverlapping`,
  // not `windowCollapsed` -- because the window's collapse pass
  // (collapseSelfRuns) only ever folds SELF-authored runs, and any event
  // this marker is allowed to name is, by construction, non-self-authored;
  // so a genuine match is always still present, unelided, in
  // `nonOverlapping`. Fail closed on every miss: cursor not found in the
  // RECENT window (including "fell out of the window", R-8), not a
  // `message_posted`, or self-authored -- OMIT THE SECTION ENTIRELY, no
  // fallback of any kind (this is what the withdrawn "use the newest
  // message_posted" branch would have been).
  if (triggerChannelSeq !== undefined) {
    const triggerEvent = nonOverlapping.find((ev) => Number(ev.cursor) === triggerChannelSeq);
    if (
      triggerEvent
      && triggerEvent.kind === 'message_posted'
      && triggerEvent.actorPrincipalId !== selfPrincipalId
    ) {
      parts.push('');
      parts.push(NEWEST_MESSAGE_BANNER_OPEN);
      parts.push(renderEvent(triggerEvent));
      parts.push(NEWEST_MESSAGE_BANNER_CLOSE);
    }
  }

  const subscriptionParts: string[] = [];
  if (anchorMessages.length > 0) subscriptionParts.push(...anchorMessages);
  if (elided > 0) subscriptionParts.push(`[PARTIAL CONTEXT: ${elided} earlier event(s) omitted]`);
  if (windowMessages.length > 0) subscriptionParts.push(...windowMessages);

  return {
    text: parts.join('\n'),
    subscriptionText: subscriptionParts.join('\n'),
    anchorCount: anchorLines.length,
    windowCount: windowLines.length,
    elided,
    totalKnown: anchorLastSeq > tailFirstSeq ? anchorLastSeq : Math.max(anchorLastSeq, tailFirstSeq + nonOverlapping.length - 1),
  };
}
