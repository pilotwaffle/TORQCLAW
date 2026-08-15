import type { GatewayEvent } from '@torqclaw/contracts';

/**
 * Presence / liveness helpers for the terminal. Everything here is PURE (no
 * React) so it is unit-testable in the node environment — the console derives
 * all liveness and staleness from facts already on the wire (GatewayEvent
 * timestamps + costSummary frames), never from a mount counter or a guessed
 * clock anchor.
 */

/**
 * How quiet (in ms) the gateway stream can be before the terminal calls its
 * view of the world stale. Mirrors the "stuck-state" threshold: a healthy idle
 * console emits nothing by design, so staleness is only meaningful while a
 * task should be producing events (see TorqTerminal's `showStaleWarning`).
 */
export const STALE_AFTER_MS = 30_000;

/** Epoch ms of an event's timestamp, or null when it is missing/parsing-fails. */
export function eventMs(ev: GatewayEvent): number | null {
  const t = Date.parse(ev.timestamp);
  return Number.isNaN(t) ? null : t;
}

/**
 * Epoch ms of the newest event's timestamp. Null only when there are no
 * events. This is the "last synced" anchor — the console is push-based, so
 * this is derived state from data already in memory; there is nothing to
 * refetch.
 */
export function selectLastSyncedMs(events: GatewayEvent[]): number | null {
  let latest: number | null = null;
  for (const ev of events) {
    const t = eventMs(ev);
    if (t === null) continue;
    if (latest === null || t > latest) latest = t;
  }
  return latest;
}

/**
 * True when the newest event is older than `thresholdMs` relative to `nowMs`.
 * Null (never synced) is NOT stale — an empty console is not "out of date".
 */
export function isStale(
  lastSyncedMs: number | null,
  nowMs: number,
  thresholdMs: number = STALE_AFTER_MS,
): boolean {
  return lastSyncedMs !== null && nowMs - lastSyncedMs > thresholdMs;
}

/**
 * Epoch ms of the ACTIVE turn's start, or null when there is no active turn.
 *
 * Anchored to the earliest event carrying `activeRequestId`. The anchor is a
 * property of the task — NOT of the console mount — so a mid-task remount (or
 * the live-affordance test's unmount/re-mount) never resets the elapsed clock
 * to zero; the LiveDuration renders `now - startSince`, a pure function of
 * this anchor.
 */
export function selectTurnStartMs(
  events: GatewayEvent[],
  activeRequestId: string | null,
): number | null {
  if (!activeRequestId) return null;
  let start: number | null = null;
  for (const ev of events) {
    if (ev.requestId !== activeRequestId) continue;
    const t = eventMs(ev);
    if (t === null) continue;
    if (start === null || t < start) start = t;
  }
  return start;
}

/**
 * Latest live costSummary frame's metadata (the same frame source CostPanel
 * reads), or null when none has arrived in the (evictable) live ring. The
 * presence card reads this display-only — it never writes a cap or fetches.
 */
export function selectCostSummaryMeta(
  events: GatewayEvent[],
): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const meta = (events[i]!.metadata ?? {}) as Record<string, unknown>;
    if (meta.costSummary === true) return meta;
  }
  return null;
}