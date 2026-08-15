'use client';

import { useEffect, useState } from 'react';

/**
 * m:ss rendering of an elapsed second count. Pure function of the count so
 * every reader of the same anchor renders the identical string (the global
 * liveness chip and the per-task elapsed must never disagree).
 */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Elapsed-time ticker anchored to a REAL start timestamp (epoch ms), never a
 * mount counter. Each tick recomputes `now - since`, so the displayed value
 * is a pure function of `since`: a mid-task remount (component unmount/re-
 * mount, a stale-`dist` reload, a Fast Refresh) jumps to wall-clock instead
 * of resetting to 0:00.
 *
 * When `since` is null (no active turn to anchor to) the render is `0:00`.
 */
export function LiveDuration({
  since,
  className = 'tabular-nums text-neutral-600',
}: {
  since: number | null;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds =
    since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
  return <span className={className}>{formatElapsed(seconds)}</span>;
}
