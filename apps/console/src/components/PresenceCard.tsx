'use client';

import { LiveDuration } from './LiveDuration';

/**
 * Current-task presence card — honest presence for the ONE agent the console
 * watches (the gateway is a single execution authority; there is no roster
 * here to populate). All values are display-only facts already on the wire:
 * tier, lock, anchored elapsed, and budget remaining from the latest
 * costSummary frame. Rendered only while `busy`, so it never pretends an
 * idle console has an active task.
 */
export default function PresenceCard({
  tier,
  lock,
  turnStartMs,
  budgetRemaining,
}: {
  tier: string | null;
  lock: string | null;
  turnStartMs: number | null;
  budgetRemaining: number | null;
}) {
  const hasMeta = tier !== null || lock !== null || budgetRemaining !== null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10px] text-neutral-500">
      {turnStartMs !== null && (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1 w-1 rounded-full bg-torque" aria-hidden />
          <LiveDuration since={turnStartMs} />
        </span>
      )}
      {hasMeta && (
        <>
          {tier && (
            <span>
              tier: <span className="text-neutral-300">{tier}</span>
            </span>
          )}
          {lock && (
            <span>
              lock: <span className="text-neutral-300">{lock}</span>
            </span>
          )}
          {budgetRemaining !== null && (
            <span>
              budget left:{' '}
              <span className="text-neutral-300">
                ${budgetRemaining.toFixed(2)}
              </span>
            </span>
          )}
        </>
      )}
    </div>
  );
}

