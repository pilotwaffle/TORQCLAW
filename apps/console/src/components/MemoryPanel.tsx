'use client';

// PRD-UI-1 §8: Memory view — a read-only two-column grid over the REAL
// episode list the gateway returns for MEMORY SHOW ({taskType, summary,
// timestamp}; sessions.ts showEpisodes, newest first, 50 max).
//
// SAFETY: strictly read-only — the ONLY sendCommand action reachable from
// this file is {action:'MEMORY', op:'SHOW'} (mount, manual refresh). No
// forget/decide/dispatch surface exists here; 'forget session' stays on the
// composer's secondary row.
//
// RING-BUFFER SAFETY (ApprovalHistoryPanel pattern, G1R SC-1): snapshot is
// null until a frame EVER lands (loading), [] only for a genuine empty
// result; write-on-present, never cleared on absence; mount-dispatch covers
// reconnect after eviction.
//
// KERNEL GAPS (named, not faked): no relevance weights and no all-time
// episode count ride the wire — the mockup's 'w 0.92' badges and '1,284
// episodes' subtitle are omitted until the kernel exposes them.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientCommand, GatewayEvent } from '@torqclaw/contracts';

interface EpisodeLike {
  taskType: string;
  summary: string;
  timestamp: string;
}

const TIMEOUT_MS = 5000;

export default function MemoryPanel({
  events,
  sendCommand,
  onClose,
}: {
  events: GatewayEvent[];
  sendCommand: (command: ClientCommand) => boolean;
  onClose: () => void;
}) {
  // last-wins over metadata.memory==='SHOW' frames in the (evictable) ring.
  const latest = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
      if (meta.memory === 'SHOW' && Array.isArray(meta.episodes)) {
        return meta.episodes as EpisodeLike[];
      }
    }
    return null;
  }, [events]);

  const [episodes, setEpisodes] = useState<EpisodeLike[] | null>(null);
  useEffect(() => {
    if (latest) setEpisodes(latest);
  }, [latest]);

  type Phase = 'pending' | 'idle' | 'sendFailed' | 'timeout';
  const [phase, setPhase] = useState<Phase>('pending');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const request = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const sent = sendCommand({ action: 'MEMORY', op: 'SHOW' });
    if (!sent) { setPhase('sendFailed'); return; }
    setPhase('pending');
    timer.current = setTimeout(() => {
      setPhase((p) => (p === 'pending' ? 'timeout' : p));
    }, TIMEOUT_MS);
  };

  useEffect(() => {
    request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (latest) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setPhase('idle');
    }
  }, [latest]);

  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  const isRefreshing = phase === 'pending' && episodes !== null;

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-bg/98 text-[13px] leading-[1.6] text-muted">
      <div className="flex items-center justify-between border-b border-edge p-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted">
          Memory
          {episodes !== null && (
            <span className="ml-2 font-normal normal-case tracking-[0.06em] text-faint">
              {episodes.length} episode{episodes.length === 1 ? '' : 's'} this session
            </span>
          )}
        </h2>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={request}
            disabled={isRefreshing}
            className="text-faint hover:text-ink disabled:opacity-50"
          >
            {isRefreshing ? 'refreshing…' : 'refresh'}
          </button>
          <button onClick={onClose} className="text-faint hover:text-ink" aria-label="Close memory view">
            close
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {episodes === null && phase === 'pending' && <p className="text-faint/75">Loading…</p>}
        {episodes === null && phase === 'sendFailed' && (
          <p className="text-faint">
            couldn&apos;t request memory — connection may be reconnecting;{' '}
            <button type="button" onClick={request} className="underline hover:text-muted">
              try again
            </button>
          </p>
        )}
        {episodes === null && phase === 'timeout' && (
          <p className="text-faint">No response — refresh to try again.</p>
        )}

        {episodes !== null && (
          <>
            {phase === 'timeout' && (
              <p className="mb-2 text-torque">Refresh didn&apos;t return — showing the last list received.</p>
            )}
            {episodes.length === 0 ? (
              <div className="mx-auto max-w-[860px] rounded-[10px] border border-dashed border-border-strong px-6 py-8 text-center">
                <p className="text-[20px] opacity-60" aria-hidden>▣</p>
                <p className="mt-2 text-[12px] text-muted">No episodes remembered yet</p>
                <p className="mx-auto mt-1 max-w-[44ch] text-[10.5px] leading-[1.7] tracking-[0.04em] text-faint">
                  Completed tasks are summarized into episodes and recalled automatically
                  when a later task looks related.
                </p>
              </div>
            ) : (
              <div className="mx-auto grid max-w-[860px] grid-cols-1 gap-3 min-[700px]:grid-cols-2">
                {episodes.map((ep, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-edge bg-panel px-4 py-3.5 transition-colors hover:border-mem/40"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-mem">
                        {ep.taskType || 'episode'}
                      </span>
                      <span className="ml-auto text-[9.5px] tabular-nums text-faint" title={ep.timestamp}>
                        {ep.timestamp}
                      </span>
                    </div>
                    <p className="mt-1.5 font-reading text-[12.5px] leading-[1.65] text-muted">
                      {ep.summary}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <p className="mx-auto mt-4 max-w-[860px] text-[10px] text-faint/75">
              Episodes are as of the last refresh. Recall happens automatically when relevant —
              relevance weights are not exposed by the kernel, so none are shown.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
