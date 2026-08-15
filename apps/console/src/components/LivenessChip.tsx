'use client';

import { GlyphSpinner } from './GlyphSpinner';
import { LiveDuration } from './LiveDuration';

/**
 * Global liveness chip (redesign 2/7) — the persistent header indicator for
 * the in-flight task.
 *
 *  - Phase text: the freshest kernel event's humanized message (the gateway
 *    wire has no ACTION_STATUS event type — the phase IS the latest task
 *    event, never an invented label).
 *  - Spinner: GlyphSpinner (kernel primitive, locally ported).
 *  - Elapsed: LiveDuration anchored to the SAME turnStartMs the in-stream
 *    presence block renders — one epoch, two readers, they never disagree.
 *  - Stuck: no task output for 30s+ flips to the amber warning state —
 *    never shimmer forever silently. Amber, not red: stuck is a warning,
 *    and red is reserved for destructive/error.
 *  - Tagged with the active turn id prefix for debuggability.
 *  - Clicking scrolls the stream to the running task.
 */
export function LivenessChip({
  phase,
  stuck,
  turnStartMs,
  turnId,
  onScrollToTask,
}: {
  phase: string;
  stuck: boolean;
  turnStartMs: number | null;
  turnId: string;
  onScrollToTask: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onScrollToTask}
      title={
        stuck
          ? 'no kernel output for 30s+ — click to inspect the task'
          : 'click to scroll to the running task'
      }
      className={`flex min-w-0 items-center gap-2 rounded border px-2 py-1 text-[11px] transition-colors ${
        stuck
          ? 'border-torque/60 bg-torque/10 text-torque'
          : 'border-edge text-muted hover:border-torque/40'
      }`}
    >
      {stuck ? (
        <span aria-hidden className="text-torque">
          ▲
        </span>
      ) : (
        <GlyphSpinner ariaLabel="task running" className="text-torque" />
      )}
      <span className="max-w-[42ch] truncate">
        {stuck ? `no output for 30s+ · ${phase}` : phase}
      </span>
      <LiveDuration since={turnStartMs} className="tabular-nums text-faint" />
      <span className="whitespace-nowrap text-faint">turn {turnId.slice(0, 8)}</span>
    </button>
  );
}
