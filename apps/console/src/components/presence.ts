import type { GatewayEvent } from '@torqclaw/contracts';
import { friendlyMessage } from './friendly';

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

/**
 * The live-phase anchor for the global liveness chip (redesign 2/7).
 *
 * `text` — the human phase line, derived from the NEWEST non-SYSTEM event on
 * the active request (SYSTEM frames are busy-neutral per the UI-FIX-1
 * invariant: they carry information, never work-truth). Terminal RESULT/ERROR
 * events are skipped defensively — when one lands, the caller's activeRequestId
 * clears in the same render and the chip unmounts anyway.
 *
 * `lastEventMs` — the newest event timestamp of ANY type on the request. This
 * is the stuck anchor: "no output" means the stream went quiet, SYSTEM notes
 * included — a task emitting only SYSTEM frames is still emitting.
 *
 * Both fields are facts already on the wire. The phase text is NEVER an
 * invented label: the gateway wire has no ACTION_STATUS event type, so the
 * honest phase is the freshest task event's humanized message.
 */
export interface LivePhase {
  text: string;
  lastEventMs: number;
  /** True when the freshest work-truth event is PENDING_APPROVAL — the task
   *  waits on the OPERATOR, so the chip's stuck warning must stay silent. */
  waitingOnApproval: boolean;
}

export function selectLivePhase(
  events: GatewayEvent[],
  activeRequestId: string | null,
): LivePhase | null {
  if (!activeRequestId) return null;
  let text: string | null = null;
  let waitingOnApproval = false;
  let lastEventMs: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.requestId !== activeRequestId) continue;
    const t = eventMs(ev);
    if (t !== null && (lastEventMs === null || t > lastEventMs)) lastEventMs = t;
    if (text !== null) continue; // phase found; keep scanning for the max ts
    if (ev.type === 'SYSTEM') continue;
    if (ev.type === 'RESULT' || ev.type === 'ERROR') continue;
    text = friendlyMessage(ev);
    waitingOnApproval = ev.type === 'PENDING_APPROVAL';
  }
  if (text === null || lastEventMs === null) return null;
  return { text, lastEventMs, waitingOnApproval };
}

/**
 * True when the active request's stream has been quiet for longer than the
 * stuck threshold. A task paused on approval is NEVER stuck — the bottleneck
 * is the operator, and flagging it as a kernel stall would be a lie.
 */
export function isPhaseStuck(
  phase: LivePhase | null,
  nowMs: number,
  thresholdMs: number = STALE_AFTER_MS,
): boolean {
  if (!phase || phase.waitingOnApproval) return false;
  return nowMs - phase.lastEventMs > thresholdMs;
}