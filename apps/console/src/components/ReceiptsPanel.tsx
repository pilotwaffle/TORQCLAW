'use client';

// TCLAW-4B-2: read-only receipt list/detail/replay panel over the merged
// 4B-1 LIST_RECEIPTS/GET_RECEIPT backend. NO backend/contract change.
//
// SAFETY (see friendly.ts + TorqTerminal.tsx for the rest of the two-layer
// defense): the REPLAY tab renders through ReplayEventRow, a component
// defined in this file that takes ONLY plain data (ReplayEventRowData) and
// has no `sendCommand` / onDecide*/onRetry/onResend*/onGetDraft in its
// lexical scope. A replayed ERROR row can never dispatch SUBMIT_PROMPT (no
// server idempotency guard exists for that path) because there is no
// callback reachable from the replay render tree at all — not because a
// prop was set to a no-op.
//
// RING-BUFFER SAFETY: LIST_RECEIPTS/GET_RECEIPT responses are seq-less
// publishOnly SYSTEM frames — they enter the 1000-event ring buffer but are
// NOT part of the reconnect backlog and CAN be evicted from `events` at any
// time. The list and the open receipt are therefore snapshotted into
// useState the moment their frame appears; every render reads from that
// state, never from a useMemo computed directly over `events`.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientCommand, GatewayEvent } from '@torqclaw/contracts';
import {
  field,
  formatCostField,
  formatReceiptState,
  formatRouteExplanation,
  formatLockState,
  formatBlockedAlternatives,
  formatProfile,
  toReplayEventRows,
  selectSafeExportViewByTaskId,
  renderSafeExportMarkdown,
  type ReplayEventRowData,
  type ReceiptLike,
  type SafeExportFrameLike,
} from './friendly';

// TCLAW-5B-2: bounded-pending/refresh-timeout register (mirrors
// ApprovalHistoryPanel.tsx's TIMEOUT_MS/phase discipline exactly — same
// constant value, same 2D-2 timer rules: sendFailed never arms the timer,
// frame arrival clears it, timer cleared on unmount/row-switch).
const SAFE_EXPORT_TIMEOUT_MS = 5000;
type SafeExportPhase = 'idle' | 'pending' | 'ready' | 'sendFailed' | 'timeout';

interface ReceiptSummary {
  taskId: string;
  sourceChannel: string | null;
  selectedTier: string | null;
  costUsd: number | null;
  elapsedMs: number | null;
  resultState: string | null;
  cancelled: number | null;
  blockedOn: string | null;
  evidenceStartSeq: number | null;
  evidenceEndSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

interface EventsOmitted {
  reason: string;
  eventCount: number;
  evidenceStartSeq: number | null;
  evidenceEndSeq: number | null;
}

interface OpenReceipt {
  taskId: string;
  receipt: ReceiptLike | null;
  projectionVersion?: number;
  taskPrompt: string | null;
  events?: GatewayEvent[] | null;
  eventsOmitted?: EventsOmitted;
}

export default function ReceiptsPanel({
  events,
  sendCommand,
  onClose,
}: {
  events: GatewayEvent[];
  sendCommand: (command: ClientCommand) => boolean;
  onClose: () => void;
}) {
  // ── LIST collection ───────────────────────────────────────────────────
  // last-wins over metadata.receiptList frames in the (evictable) live ring.
  const latestReceiptList = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
      if (meta.receiptList && Array.isArray(meta.receipts)) return meta.receipts as ReceiptSummary[];
    }
    return null;
  }, [events]);

  // SNAPSHOT into state the moment a frame appears — survives eviction.
  const [receiptList, setReceiptList] = useState<ReceiptSummary[]>([]);
  useEffect(() => {
    if (latestReceiptList) setReceiptList(latestReceiptList);
  }, [latestReceiptList]);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [tab, setTab] = useState<'detail' | 'replay'>('detail');

  // On mount/open, (re-)request the list — this also covers reconnect,
  // since a fresh LIST_RECEIPTS repopulates state even if the prior list
  // frame was evicted from the ring before this mount.
  useEffect(() => {
    sendCommand({ action: 'LIST_RECEIPTS', limit: 20 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── DETAIL collection ──────────────────────────────────────────────────
  // Keyed by metadata.taskId (not last-wins across all tasks) so switching
  // rows doesn't clobber a still-loading selection with a stale frame.
  const receiptViewByTaskId = useMemo(() => {
    const map: Record<string, OpenReceipt> = {};
    for (const ev of events) {
      const meta = (ev.metadata ?? {}) as Record<string, any>;
      if (!meta.receiptView || typeof meta.taskId !== 'string') continue;
      map[meta.taskId] = {
        taskId: meta.taskId,
        receipt: meta.receipt ?? null,
        projectionVersion: meta.projectionVersion,
        taskPrompt: meta.taskPrompt ?? null,
        events: meta.events,
        eventsOmitted: meta.eventsOmitted,
      };
    }
    return map;
  }, [events]);

  // SNAPSHOT the selected task's frame into state — survives eviction.
  const [openReceipt, setOpenReceipt] = useState<OpenReceipt | null>(null);
  useEffect(() => {
    if (!selectedTaskId) return;
    const found = receiptViewByTaskId[selectedTaskId];
    if (found) setOpenReceipt(found);
  }, [selectedTaskId, receiptViewByTaskId]);

  // ── TCLAW-5B-2: Safe-export collection + snapshot + phase machine ──────
  // Keyed collection mirroring receiptViewByTaskId verbatim (see
  // friendly.ts's selectSafeExportViewByTaskId doc comment for the full
  // soundness argument). SNAPSHOT-ON-PRESENT (null init = never received —
  // NOT this file's []-init conflation elsewhere; ApprovalHistoryPanel
  // discipline), keyed per-taskId so a frame for task B never renders under
  // task A.
  const safeExportViewByTaskId = useMemo(() => selectSafeExportViewByTaskId(events), [events]);
  const [safeExportByTaskId, setSafeExportByTaskId] = useState<Record<string, SafeExportFrameLike>>({});
  useEffect(() => {
    if (!selectedTaskId) return;
    const found = safeExportViewByTaskId[selectedTaskId];
    if (found) {
      setSafeExportByTaskId((prev) => ({ ...prev, [selectedTaskId]: found }));
    }
  }, [selectedTaskId, safeExportViewByTaskId]);

  const [safeExportPhase, setSafeExportPhase] = useState<SafeExportPhase>('idle');
  const safeExportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // [G1R SC-1] true while a FRESH request is in flight over an already-
  // rendered (possibly stale-but-valid) snapshot — e.g. a still-in-ring
  // frame from an earlier click satisfies the new click instantly (pending
  // resolves to ready in one render via safeExportByTaskId already having an
  // entry), but the fresh GET_SAFE_EXPORT is still sent and its newer frame
  // overwrites when it lands. This never lies about the snapshot's
  // freshness (approvals-freshness only) — it only signals a fetch is
  // outstanding.
  const [safeExportRefreshing, setSafeExportRefreshing] = useState(false);

  const requestSafeExport = (taskId: string) => {
    if (safeExportTimer.current) { clearTimeout(safeExportTimer.current); safeExportTimer.current = null; }
    const alreadyHasSnapshot = !!safeExportByTaskId[taskId];
    const sent = sendCommand({ action: 'GET_SAFE_EXPORT', taskId });
    if (!sent) {
      setSafeExportPhase('sendFailed'); // 2D-2 rule: never arms the timer
      return;
    }
    setSafeExportRefreshing(alreadyHasSnapshot);
    setSafeExportPhase('pending');
    safeExportTimer.current = setTimeout(() => {
      setSafeExportPhase((p) => (p === 'pending' ? 'timeout' : p));
    }, SAFE_EXPORT_TIMEOUT_MS);
  };

  // Any snapshot landing for the selected task clears the pending timer,
  // resolves to ready, and clears the refreshing indicator.
  useEffect(() => {
    if (!selectedTaskId) return;
    const found = safeExportViewByTaskId[selectedTaskId];
    if (found) {
      if (safeExportTimer.current) { clearTimeout(safeExportTimer.current); safeExportTimer.current = null; }
      setSafeExportPhase('ready');
      setSafeExportRefreshing(false);
    }
  }, [selectedTaskId, safeExportViewByTaskId]);

  // Clear the timer on unmount.
  useEffect(() => {
    return () => {
      if (safeExportTimer.current) clearTimeout(safeExportTimer.current);
    };
  }, []);

  const selectRow = (taskId: string) => {
    setSelectedTaskId(taskId);
    setOpenReceipt(null); // clear stale detail while the new one loads
    setTab('detail');
    sendCommand({ action: 'GET_RECEIPT', taskId, includeEvents: true });
    // Row switch clears the safe-export snapshot + resets phase to idle
    // (G1R invariant 5 / spec §1.4) — a still-fetching or previously-ready
    // safe export for the prior task must never bleed into the new row.
    if (safeExportTimer.current) { clearTimeout(safeExportTimer.current); safeExportTimer.current = null; }
    setSafeExportPhase('idle');
    setSafeExportRefreshing(false);
  };

  return (
    <div className="absolute inset-0 z-20 flex bg-[#0a0a0a]/98 text-sm text-neutral-300">
      {/* LIST */}
      <div className="w-72 shrink-0 overflow-y-auto border-r border-neutral-800 p-3">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">Receipts</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200" aria-label="Close receipts panel">
            close
          </button>
        </div>
        {receiptList.length === 0 && (
          <p className="text-[11px] text-neutral-600">No receipts yet.</p>
        )}
        <ul className="space-y-1">
          {receiptList.map((r) => (
            <li key={r.taskId}>
              <button
                onClick={() => selectRow(r.taskId)}
                className={`w-full rounded border px-2 py-1 text-left text-[11px] transition-colors ${
                  selectedTaskId === r.taskId
                    ? 'border-[#E24B4A]/50 bg-[#E24B4A]/10 text-neutral-100'
                    : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'
                }`}
              >
                <div className="truncate font-mono text-[10px] text-neutral-500">{r.taskId}</div>
                <div className="flex flex-wrap gap-x-2 text-neutral-400">
                  <span>{r.resultState ?? 'unknown'}</span>
                  <span>{typeof r.costUsd === 'number' ? `$${r.costUsd.toFixed(2)}` : 'cost n/a'}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* DETAIL / REPLAY */}
      <div className="flex-1 overflow-y-auto p-4">
        {!selectedTaskId && (
          <p className="text-neutral-600">Select a receipt from the list.</p>
        )}
        {selectedTaskId && !openReceipt && (
          <p className="text-neutral-600">Loading…</p>
        )}
        {selectedTaskId && openReceipt && openReceipt.receipt === null && (
          <p className="text-neutral-500">No receipt for this task</p>
        )}
        {selectedTaskId && openReceipt && openReceipt.receipt && (
          <>
            <div className="mb-3 flex gap-4 border-b border-neutral-800 text-[11px] uppercase tracking-widest">
              <button
                onClick={() => setTab('detail')}
                className={tab === 'detail' ? 'border-b-2 border-[#E24B4A] pb-2 text-neutral-100' : 'pb-2 text-neutral-500'}
              >
                Detail
              </button>
              <button
                onClick={() => setTab('replay')}
                className={tab === 'replay' ? 'border-b-2 border-[#E24B4A] pb-2 text-neutral-100' : 'pb-2 text-neutral-500'}
              >
                Replay
              </button>
            </div>
            {tab === 'detail' ? (
              <ReceiptDetail
                openReceipt={openReceipt}
                safeExportFrame={selectedTaskId ? (safeExportByTaskId[selectedTaskId] ?? null) : null}
                safeExportPhase={safeExportPhase}
                safeExportRefreshing={safeExportRefreshing}
                onGetSafeExport={() => selectedTaskId && requestSafeExport(selectedTaskId)}
              />
            ) : (
              <ReceiptReplay openReceipt={openReceipt} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Read-only detail render — identity, state, cost, execution stats, tools,
 *  approvals (as facts, never actionable), route diagnostics, evidence, error.
 *  Every value goes through field()/the format helpers — no fabrication. */
function ReceiptDetail({
  openReceipt,
  safeExportFrame,
  safeExportPhase,
  safeExportRefreshing,
  onGetSafeExport,
}: {
  openReceipt: OpenReceipt;
  safeExportFrame: SafeExportFrameLike | null;
  safeExportPhase: SafeExportPhase;
  safeExportRefreshing: boolean;
  // NARROW callback — never raw sendCommand (ReplayEventRow boundary
  // discipline, :343-361 / spec invariant 16). ReceiptDetail cannot dispatch
  // anything beyond "prepare/retry the safe export for the currently open
  // task", which is exactly what this one callback expresses.
  onGetSafeExport: () => void;
}) {
  const receipt = openReceipt.receipt as ReceiptLike;
  const state = formatReceiptState(receipt);
  const costRows = formatCostField(receipt);
  // Enriched "Route diagnostics" composition (TCLAW-2B): the honest
  // three-state lock taxonomy (formatLockState), ALL blocked alternatives
  // (no cap), and the routing profile (omitted when absent — 2A never
  // populates it) are composed alongside the rule/score/tier headline.
  // formatRouteDiagnostics (friendly.ts) is intentionally left exported with
  // its existing tests green as a regression guard, even though this panel
  // now composes the richer per-concern helpers directly.
  const routeRows = [
    ...formatRouteExplanation(receipt.routeDiagnostics),
    formatLockState(receipt.routeDiagnostics),
    ...formatBlockedAlternatives(receipt.routeDiagnostics),
    formatProfile(receipt.routeDiagnostics),
  ].filter((r): r is { label: string; value: string } => r !== null);

  const identityRows = [
    field('task id', receipt.taskId),
    field('session id', receipt.sessionId),
    field('source channel', receipt.sourceChannel),
    field('prompt', openReceipt.taskPrompt), // SIBLING key — never receipt.prompt
    field('projection version', openReceipt.projectionVersion),
  ].filter((r): r is { label: string; value: string } => r !== null);

  const execRows = [
    field('elapsed', typeof receipt.elapsedMs === 'number' ? `${(receipt.elapsedMs / 1000).toFixed(1)}s` : null),
    field('iterations', receipt.iterations),
    field('memory used', receipt.memoryUsed),
    field('context chars', receipt.contextChars),
  ].filter((r): r is { label: string; value: string } => r !== null);

  return (
    <div className="space-y-5">
      <Section title="Identity">
        <Rows rows={identityRows} />
      </Section>

      <Section title="State">
        <p className="text-neutral-200">
          {state.label}
          {state.cancelled && <span className="ml-2 text-[10px] text-amber-400">cancelled</span>}
          {state.blockedOn && <span className="ml-2 text-[10px] text-amber-400">paused for {state.blockedOn}</span>}
        </p>
        {field('error', receipt.error) && (
          <p className="mt-1 text-[#E24B4A]">{receipt.error}</p>
        )}
      </Section>

      <Section title="Cost">
        <Rows rows={costRows} />
      </Section>

      <Section title="Execution">
        <Rows rows={execRows} />
      </Section>

      <Section title="Tools called">
        {receipt.toolsCalled && receipt.toolsCalled.length > 0 ? (
          <ul className="list-inside list-disc text-neutral-400">
            {receipt.toolsCalled.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        ) : (
          <p className="text-neutral-600">none</p>
        )}
      </Section>

      <Section title="Approvals">
        {receipt.approvals && receipt.approvals.length > 0 ? (
          <ul className="space-y-1 text-neutral-400">
            {receipt.approvals.map((a, i) => (
              <li key={i}>
                {a.toolName} — {a.status}
                {a.decidedAt ? ` (${a.decidedAt})` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-neutral-600">none</p>
        )}
      </Section>

      <Section title="Route diagnostics">
        <Rows rows={routeRows} />
      </Section>

      <Section title="Evidence">
        <Rows
          rows={[
            field('start seq', receipt.evidence?.startSeq),
            field('end seq', receipt.evidence?.endSeq),
          ].filter((r): r is { label: string; value: string } => r !== null)}
        />
      </Section>

      <SafeExportSection
        frame={safeExportFrame}
        phase={safeExportPhase}
        refreshing={safeExportRefreshing}
        onGetSafeExport={onGetSafeExport}
      />
    </div>
  );
}

/**
 * TCLAW-5B-2: Safe-export section — LAST section of ReceiptDetail (spec
 * §1.1: every section above is the receipt's facts; this one is an action on
 * those facts, and being last means an operator who reaches the copy
 * buttons has scrolled past the whole receipt).
 *
 * THE CARDINAL RULE lives here: copy JSON writes
 * JSON.stringify(frame.safeExport, null, 2) where frame.safeExport is the
 * server frame's metadata.safeExport object BY REFERENCE — never a
 * re-assembled/reshaped object. copy Markdown writes
 * renderSafeExportMarkdown(frame.safeExport). Neither ever reads
 * openReceipt/events/anything else in this file's scope, even though the raw
 * receipt sits right next to this component (the R1 hazard the risk
 * register calls out by name).
 */
function SafeExportSection({
  frame,
  phase,
  refreshing,
  onGetSafeExport,
}: {
  frame: SafeExportFrameLike | null;
  phase: SafeExportPhase;
  refreshing: boolean;
  onGetSafeExport: () => void;
}) {
  const [copied, setCopied] = useState<'json' | 'markdown' | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const flashCopied = (which: 'json' | 'markdown') => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    setCopied(which);
    copiedTimer.current = setTimeout(() => setCopied(null), 2000);
  };

  // Clipboard writes are synchronous-from-state inside the click handler —
  // no async gap, no gesture problem (spec invariant 9/10). clipboard
  // absent/rejected -> honest failure, NEVER a fabricated "copied" flash.
  const copyJson = () => {
    const safeExport = frame?.safeExport;
    if (!safeExport) return;
    const text = JSON.stringify(safeExport, null, 2);
    const p = navigator.clipboard?.writeText(text);
    if (!p) return; // clipboard API absent — honest no-op, no fabricated flash
    p.then(() => flashCopied('json')).catch(() => {});
  };
  const copyMarkdown = () => {
    const safeExport = frame?.safeExport;
    if (!safeExport) return;
    const text = renderSafeExportMarkdown(safeExport);
    const p = navigator.clipboard?.writeText(text);
    if (!p) return;
    p.then(() => flashCopied('markdown')).catch(() => {});
  };

  return (
    <Section title="Safe export">
      <p className="mb-2 text-[10px] text-neutral-600">
        built on the gateway from the receipt only — prompt, context, event replay, and tool arguments are never included
      </p>

      {/* [G1R SC-1] `refreshing` means a FRESH request is in flight over an
          already-rendered snapshot (a still-in-ring frame satisfied an
          earlier click instantly; phase may be 'pending' again while the
          newer request is outstanding) — render the EXISTING ready content
          plus a "refreshing…" note rather than blanking out to a spinner
          button. This never lies about freshness (approvals-freshness only)
          and never hides a report the operator already has. */}
      {phase === 'idle' && !frame && (
        <button
          onClick={onGetSafeExport}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 transition-colors hover:border-neutral-500"
        >
          prepare safe export
        </button>
      )}

      {phase === 'pending' && !frame && (
        <button
          disabled
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-500 opacity-60"
        >
          preparing…
        </button>
      )}

      {phase === 'sendFailed' && !frame && (
        <p className="text-neutral-500">
          couldn&apos;t request the safe export — connection may be reconnecting;{' '}
          <button type="button" onClick={onGetSafeExport} className="underline hover:text-neutral-300">
            try again
          </button>
        </p>
      )}

      {phase === 'timeout' && !frame && (
        <p className="text-neutral-500">
          No response — <button type="button" onClick={onGetSafeExport} className="underline hover:text-neutral-300">try again.</button>
        </p>
      )}

      {frame && (
        <>
          {/* export_failed frame (error present) — NO raw fallback, no receipt
              fields, no copy affordance anywhere in this section. */}
          {frame.error && (
            <p className="text-[#E24B4A]">
              safe export failed on the gateway — nothing to copy. This panel never falls back to raw data.{' '}
              <button type="button" onClick={onGetSafeExport} className="underline hover:text-neutral-300">
                try again
              </button>
            </p>
          )}

          {/* too_large frame (exportOmitted present, no error) — amber, no
              truncation offer: a truncated export would be a data lie. */}
          {!frame.error && frame.exportOmitted && (
            <p className="text-amber-400">export exceeds the frame size limit — not available</p>
          )}

          {/* not-found frame — bare safeExport:null, neither error nor
              exportOmitted present. Oracle-free: says nothing about whether
              the task exists. */}
          {!frame.error && !frame.exportOmitted && !frame.safeExport && (
            <p className="text-neutral-500">No receipt for this task — nothing to export.</p>
          )}

          {/* Ready frame — the redaction report renders ABOVE the copy
              buttons (spec §2 / G1R Q4): the operator cannot reach the share
              affordance without the report being on screen. */}
          {!frame.error && !frame.exportOmitted && frame.safeExport && (
            <>
              {refreshing && (
                <p className="mb-1 text-[10px] text-neutral-600">refreshing…</p>
              )}
              <RedactionReportBlock safeExport={frame.safeExport} />
              <div className="mt-2 flex gap-2">
                <button
                  onClick={copyJson}
                  className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 transition-colors hover:border-neutral-500"
                >
                  {copied === 'json' ? 'copied' : 'copy JSON'}
                </button>
                <button
                  onClick={copyMarkdown}
                  className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 transition-colors hover:border-neutral-500"
                >
                  {copied === 'markdown' ? 'copied' : 'copy Markdown'}
                </button>
                <button
                  type="button"
                  onClick={onGetSafeExport}
                  className="text-[11px] text-neutral-500 underline hover:text-neutral-300"
                  title="re-request the safe export — a live approval may have changed since this was prepared"
                >
                  refresh
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Section>
  );
}

/** The redaction-report display (spec §2): version stamps line, patternsHit
 *  rows "{n} removed" in payload order, empty-hits honest line, "never
 *  included" row from fieldsOmitted (joined verbatim), notice footer FROM
 *  THE PAYLOAD — never hard-coded client-side. No success iconography
 *  anywhere (no green, no checkmark). */
function RedactionReportBlock({ safeExport }: { safeExport: NonNullable<SafeExportFrameLike['safeExport']> }) {
  const report = safeExport.redactionReport;
  const patternsHit = report?.patternsHit ?? {};
  const hitEntries = Object.entries(patternsHit);
  const fieldsOmitted = report?.fieldsOmitted ?? [];

  return (
    <div className="rounded border border-neutral-800 px-3 py-2">
      <h4 className="mb-1.5 text-[10px] uppercase text-neutral-500">Redaction report</h4>
      <p className="mb-1.5 text-[10px] text-neutral-600">
        export v{safeExport.exportVersion ?? 'not recorded'} · redactor v{safeExport.redactorVersion ?? 'not recorded'} · projection v
        {safeExport.projectionVersion ?? 'not recorded'}
      </p>
      {hitEntries.length > 0 ? (
        <dl className="space-y-1 text-[12px]">
          {hitEntries.map(([label, count]) => (
            <div key={label} className="flex gap-2">
              <dt className="w-40 shrink-0 text-neutral-500">{label}</dt>
              <dd className="text-neutral-300">{count} removed</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-neutral-500">no known secret shapes found — known shapes only; this is not a guarantee</p>
      )}
      <div className="mt-1.5 flex gap-2 text-[12px]">
        <span className="w-40 shrink-0 text-neutral-500">never included</span>
        <span className="text-neutral-300">{fieldsOmitted.join(', ')}</span>
      </div>
      <p className="mt-1.5 text-[10px] text-neutral-500">{report?.notice ?? ''}</p>
    </div>
  );
}

/** Read-only replay render. OVERSIZE/absent-events markers are rendered
 *  here (never partial/blank); otherwise every row goes through
 *  ReplayEventRow, which has zero dispatch surface. */
function ReceiptReplay({ openReceipt }: { openReceipt: OpenReceipt }) {
  if (openReceipt.events === null || openReceipt.events === undefined) {
    if (openReceipt.eventsOmitted) {
      const o = openReceipt.eventsOmitted;
      return (
        <p className="text-amber-400">
          Replay too large to load (seq {o.evidenceStartSeq}–{o.evidenceEndSeq}, {o.eventCount} events)
        </p>
      );
    }
    return <p className="text-neutral-600">no replay available</p>;
  }

  const rows = toReplayEventRows(openReceipt.events);
  const approvalsByTool = new Map((openReceipt.receipt?.approvals ?? []).map((a) => [a.toolName, a]));

  return (
    <div className="space-y-1">
      {rows.map((row) => (
        <ReplayEventRow key={row.key} row={row} approvalsByTool={approvalsByTool} />
      ))}
    </div>
  );
}

/**
 * STRUCTURAL SAFETY BOUNDARY — read this before touching this component.
 *
 * ReplayEventRow renders type/message/tier/timestamp ONLY, from plain data
 * (ReplayEventRowData). It receives no `sendCommand`, and none of
 * onDecideSkill/onDecideTool/onResendLocal/onResendCloud/onRetry/
 * onCopyDiagnostic/onGetDraft are parameters, closed-over variables, or
 * otherwise reachable from this function's scope. There is no approval
 * card, no recovery chip, and no tool card rendered here — historical
 * PENDING_APPROVAL/ERROR rows are inert text plus (for approvals) whatever
 * decided status the receipt itself recorded.
 *
 * This is intentionally a SEPARATE component from the live EventRow in
 * TorqTerminal.tsx, not that component reused with readOnly props: passing
 * no-op callbacks into EventRow would still leave the live callbacks
 * reachable in EventRow's own lexical scope for a future edit to re-wire.
 * Here, there is nothing to re-wire — the props type itself has no
 * function-typed field for a dispatchable action.
 */
function ReplayEventRow({
  row,
  approvalsByTool,
}: {
  row: ReplayEventRowData;
  approvalsByTool: Map<string, { status: string; toolName: string; decidedAt: string | null }>;
}) {
  const meta = (row.raw.metadata ?? {}) as Record<string, any>;
  const toolName: string | undefined = meta.toolName ?? meta.tool_name;
  const decidedApproval = toolName ? approvalsByTool.get(toolName) : undefined;

  return (
    <article className="flex gap-4 rounded px-2 py-1 opacity-90">
      <time className="shrink-0 tabular-nums text-neutral-600">
        {new Date(row.timestamp).toLocaleTimeString([], { hour12: false })}
      </time>
      <div className="min-w-0 flex-1">
        {row.tier && (
          <span
            title={row.tier.hint}
            className="mr-2 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] tracking-wide text-neutral-400"
          >
            {row.tier.text}
          </span>
        )}
        <span className="mr-2 text-[10px] font-bold text-neutral-600">[{row.type.toLowerCase()}]</span>
        <span className="text-neutral-500">{row.message}</span>
        {row.type === 'PENDING_APPROVAL' && (
          <span className="ml-3 text-[10px] text-neutral-600">
            (historical{decidedApproval ? ` — ${decidedApproval.status}` : ''})
          </span>
        )}
        {row.type === 'ERROR' && (
          <span className="ml-3 text-[10px] text-neutral-600">(historical — replay only, no retry)</span>
        )}
      </div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-neutral-500">{title}</h3>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<{ label: string; value: string }> }) {
  if (rows.length === 0) return <p className="text-neutral-600">not recorded</p>;
  return (
    <dl className="space-y-1 text-[12px]">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <dt className="w-32 shrink-0 text-neutral-500">{r.label}</dt>
          <dd className="text-neutral-300">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
