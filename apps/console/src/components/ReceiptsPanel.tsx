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

import { useEffect, useMemo, useState } from 'react';
import type { ClientCommand, GatewayEvent } from '@torqclaw/contracts';
import {
  field,
  formatCostField,
  formatReceiptState,
  formatRouteDiagnostics,
  toReplayEventRows,
  type ReplayEventRowData,
  type ReceiptLike,
} from './friendly';

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

  const selectRow = (taskId: string) => {
    setSelectedTaskId(taskId);
    setOpenReceipt(null); // clear stale detail while the new one loads
    setTab('detail');
    sendCommand({ action: 'GET_RECEIPT', taskId, includeEvents: true });
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
              <ReceiptDetail openReceipt={openReceipt} />
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
function ReceiptDetail({ openReceipt }: { openReceipt: OpenReceipt }) {
  const receipt = openReceipt.receipt as ReceiptLike;
  const state = formatReceiptState(receipt);
  const costRows = formatCostField(receipt);
  const routeRows = formatRouteDiagnostics(receipt.routeDiagnostics);

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
