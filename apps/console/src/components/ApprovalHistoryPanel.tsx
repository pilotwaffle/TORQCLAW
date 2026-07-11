'use client';

// TCLAW-5A-2: read-only tool-approval history panel over the 5A-1
// LIST_APPROVALS backend. NO backend/contract change beyond the existing
// additive read command.
//
// SAFETY: this panel is STRICTLY READ-ONLY. It has no onDecideTool/setDecided
// or any other dispatch surface in its lexical scope — the ONLY sendCommand
// action reachable from anywhere in this file is LIST_APPROVALS (mount,
// manual refresh, and the staleness re-query). ApprovalHistoryRow is a
// MODULE-SCOPE component (its lexical scope contains no `sendCommand`) whose
// props type (ApprovalHistoryRowData, friendly.ts) has ZERO function-typed
// fields — mirrors ReplayEventRow's structural boundary (ReceiptsPanel.tsx
// :343-361). The live ToolPermissionCard in TorqTerminal.tsx remains the SOLE
// approval surface; pending rows here are display-only.
//
// RING-BUFFER SAFETY: LIST_APPROVALS responses are seq-less publishOnly
// SYSTEM frames — they enter the 1000-event ring buffer but are NOT part of
// the reconnect backlog and CAN be evicted from `events` at any time. G1R
// SC-1: the snapshot is initialized to `null`, NEVER `[]` — ReceiptsPanel.tsx
// :88 initializes its list to `[]` and conflates loading with empty ("No
// receipts yet." shows before the first frame ever lands); that is a known
// bug there, NOT a pattern to copy here. null = loading (no frame yet ever
// received); [] = a real empty snapshot (a frame WITH zero approvals landed).
// The whole array is snapshotted the moment a valid frame appears
// (write-on-present, NEVER cleared on absence) and every render reads ONLY
// that snapshot, never a useMemo computed directly over `events`.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientCommand, GatewayEvent } from '@torqclaw/contracts';
import {
  selectLatestApprovalList,
  toApprovalHistoryRows,
  type ApprovalSummaryLike,
  type ApprovalHistoryRowData,
} from './friendly';

const TIMEOUT_MS = 5000;

export default function ApprovalHistoryPanel({
  events,
  sendCommand,
  onClose,
  decidedCount,
}: {
  events: GatewayEvent[];
  sendCommand: (command: ClientCommand) => boolean;
  onClose: () => void;
  /** TCLAW-5A-2 G1R RC-4: a MONOTONIC NUMBER (Object.keys(decided).length at
   *  the TorqTerminal call site), never the `decided` map object itself — a
   *  map's per-render identity would change on every render regardless of
   *  content and loop this effect forever. This panel receives no
   *  setDecided/onDecideTool at all, so it structurally cannot write
   *  approval state; that absence is what makes "re-query on this number
   *  changing" safe from feedback loops (a write-then-reactive-re-query
   *  cycle needs a write path, which does not exist here). */
  decidedCount: number;
}) {
  // last-wins over metadata.approvalList frames in the (evictable) live ring.
  const latestApprovalList = useMemo(() => selectLatestApprovalList(events), [events]);

  // SNAPSHOT into ONE useState the moment a frame appears (G1R SC-1):
  // null = loading (never received a frame); [] = a genuine empty result.
  // Write-on-present, NEVER cleared on absence — malformed/absent frames
  // must never clobber a previously good snapshot.
  const [approvals, setApprovals] = useState<ApprovalSummaryLike[] | null>(null);
  useEffect(() => {
    if (latestApprovalList) setApprovals(latestApprovalList);
  }, [latestApprovalList]);

  // ── bounded-pending / refresh-timeout state machine (2D-2 register) ─────
  type Phase = 'pending' | 'idle' | 'sendFailed' | 'timeout';
  const [phase, setPhase] = useState<Phase>('pending');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const request = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // invariant 11 (load-bearing): ALWAYS this exact shape. LIST_APPROVALS
    // response frames carry no query echo/nonce, and this frame is
    // publishOnly on the SESSION BUS (all tabs, not just this component) —
    // last-wins consumption is sound ONLY because every request any
    // subscriber can emit is parameter-identical, so any response frame is a
    // valid answer to any outstanding request. Do NOT add a filter/limit UI
    // without re-deriving this soundness argument first.
    const sent = sendCommand({ action: 'LIST_APPROVALS', limit: 20 });
    if (!sent) { setPhase('sendFailed'); return; } // 2D-2 rule: never arms the timer
    setPhase('pending');
    timer.current = setTimeout(() => {
      setPhase((p) => (p === 'pending' ? 'timeout' : p));
    }, TIMEOUT_MS);
  };

  // Mount-dispatch (also covers reconnect: a fresh LIST_APPROVALS repopulates
  // state even if the prior frame was evicted from the ring before mount).
  useEffect(() => {
    request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any snapshot landing clears the pending timer and returns to idle.
  useEffect(() => {
    if (latestApprovalList) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setPhase('idle');
    }
  }, [latestApprovalList]);

  // Clear the timer on unmount.
  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  // TCLAW-5A-2 G1R RC-4: staleness re-query. Re-sends LIST_APPROVALS when
  // decidedCount changes (a live decision may have been made on the terminal
  // card while this panel is open) — rides the SAME bounded-pending/refresh
  // path as a manual refresh, never a silent extra dispatch outside it.
  // Keyed on the NUMBER, not the map: skip the very first render (mount
  // already dispatches once) via the ref guard below.
  const prevDecidedCount = useRef<number | null>(null);
  useEffect(() => {
    if (prevDecidedCount.current === null) { prevDecidedCount.current = decidedCount; return; }
    if (decidedCount !== prevDecidedCount.current) {
      prevDecidedCount.current = decidedCount;
      request();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decidedCount]);

  const refresh = () => request();

  const rows = approvals ? toApprovalHistoryRows(approvals) : null;
  const isRefreshing = phase === 'pending' && approvals !== null;

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[#0a0a0a]/98 text-sm text-neutral-300">
      <div className="flex items-center justify-between border-b border-neutral-800 p-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">Approval History</h2>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing}
            className="text-neutral-500 hover:text-neutral-200 disabled:opacity-50"
          >
            {isRefreshing ? 'refreshing…' : 'refresh'}
          </button>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200" aria-label="Close approvals panel">
            close
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* S1: loading — no snapshot ever received yet. */}
        {approvals === null && phase === 'pending' && <p className="text-neutral-600">Loading…</p>}

        {/* S2: send-failed. */}
        {approvals === null && phase === 'sendFailed' && (
          <p className="text-neutral-500">
            couldn&apos;t request the approval list — connection may be reconnecting; try again{' '}
            <button type="button" onClick={refresh} className="underline hover:text-neutral-300">
              try again
            </button>
          </p>
        )}

        {/* S3: timeout, no data ever received. */}
        {approvals === null && phase === 'timeout' && (
          <p className="text-neutral-500">No response — refresh to try again.</p>
        )}

        {/* S4-S7: a snapshot exists. */}
        {rows && (
          <>
            {phase === 'timeout' && (
              <p className="mb-2 text-amber-400">Refresh didn&apos;t return — showing the last list received.</p>
            )}
            {rows.length === 0 ? (
              <p className="text-neutral-600">No tool approval requests in this session yet.</p>
            ) : (
              <ul className="space-y-1">
                {rows.map((row) => (
                  <ApprovalHistoryRow key={row.key} row={row} />
                ))}
              </ul>
            )}
            {rows.length === 20 && (
              <p className="mt-2 text-[10px] text-neutral-600">Showing the 20 most recent.</p>
            )}
            <div className="mt-4 space-y-0.5 text-[10px] text-neutral-600">
              <p>Tool approvals only — skill approvals are not shown in this history.</p>
              <p>Read-only. Pending requests are decided from their card in the terminal, not from this list.</p>
              <p>Statuses are as of the last refresh.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * STRUCTURAL SAFETY BOUNDARY — read this before touching this component.
 *
 * ApprovalHistoryRow is a MODULE-SCOPE component: it is not nested inside
 * ApprovalHistoryPanel, so ApprovalHistoryPanel's `sendCommand` is not in its
 * lexical scope at all — there is nothing to re-wire even if a future edit
 * tried to add a handler. Its props type, ApprovalHistoryRowData
 * (friendly.ts), has ZERO function-typed fields: this component receives
 * ONLY plain data and renders toolName/status/timestamps/requestId text.
 * There is no onClick, no button, no link, no role="button"/tabIndex
 * anywhere in this tree, for ANY row — including a `pending` row, which is
 * display-only exactly like an `approved`/`rejected` row. The live
 * ToolPermissionCard (TorqTerminal.tsx) remains the ONLY place a tool
 * approval can be decided from.
 */
function ApprovalHistoryRow({ row }: { row: ApprovalHistoryRowData }) {
  const toneClass =
    row.status.tone === 'pending' ? 'text-amber-400'
    : row.status.tone === 'denied' ? 'text-[#E24B4A]'
    : row.status.tone === 'approved' ? 'text-neutral-300'
    : 'text-neutral-500';

  return (
    <li className="rounded border border-neutral-800 px-2 py-1 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <span className="min-w-0 truncate font-mono text-neutral-300" title={row.toolName}>
          {row.toolName}
        </span>
        <span className={toneClass} title={row.status.raw}>{row.status.text}</span>
      </div>
      <div className="text-[10px] text-neutral-600">
        requested {row.requestedAt}
        {row.decidedAt !== null && <> · decided {row.decidedAt}</>}
      </div>
      <div className="truncate font-mono text-[10px] text-neutral-700" title={row.requestId}>
        request {row.requestId}
      </div>
    </li>
  );
}
