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
  waitingOnApproval = false,
  turnStartMs,
  turnId,
  onScrollToTask,
}: {
  phase: string;
  stuck: boolean;
  /** §5 exception: a task paused on a pending approval is never stuck — the
   *  chip says so in the normal state instead. */
  waitingOnApproval?: boolean;
  turnStartMs: number | null;
  turnId: string;
  onScrollToTask: () => void;
}) {
  // §5: bold status keyword — torque while working, --bad once genuinely
  // stuck (red is allowed here: 30s of kernel silence IS an error signal).
  const keyword = stuck
    ? 'no output for 30s+'
    : waitingOnApproval
      ? 'waiting on your approval'
      : 'working';
  const body = waitingOnApproval && !stuck ? null : phase;
  return (
    <button
      type="button"
      onClick={onScrollToTask}
      title={
        stuck
          ? 'no kernel output for 30s+ — click to inspect the task'
          : 'click to scroll to the running task'
      }
      className={`flex min-w-0 max-w-[380px] items-center gap-2 rounded-md border bg-panel-2 px-2.5 py-1 transition-colors ${
        stuck ? 'border-bad/45' : 'border-torque/35 hover:border-torque hover:bg-torque/[.14]'
      }`}
    >
      <GlyphSpinner ariaLabel="task running" className={stuck ? 'text-bad' : 'text-torque'} />
      <span className="min-w-0 truncate text-[10.5px] tracking-[0.04em] text-muted">
        <b className={`font-semibold ${stuck ? 'text-bad' : 'text-torque'}`}>{keyword}</b>
        {body ? ` · ${body}` : ''}
      </span>
      <LiveDuration since={turnStartMs} className="shrink-0 text-[10px] tabular-nums text-faint" />
      <span className="shrink-0 whitespace-nowrap border-l border-border-strong pl-2 text-[8px] uppercase tracking-[0.14em] text-mem">
        turn {turnId.slice(0, 8)}
      </span>
    </button>
  );
}
