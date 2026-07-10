'use client';

// TCLAW-1B: read-only Cost Control Center dashboard over the merged
// 1A-core+1A-attr spend backend. NO backend/contract change beyond the one
// additive read command (GET_COST_SUMMARY).
//
// SAFETY: this panel is STRICTLY READ-ONLY. It has no `onRetry`/`onResend*`/
// dispatch surface in its lexical scope at all — the only sendCommand actions
// reachable from here are GET_COST_SUMMARY (on mount, for reconnect) and
// (optionally) GET_RECEIPT for a read-only drill-down. There is no cap-edit,
// no run/retry-again affordance anywhere below, mirroring ReceiptsPanel's own
// two-layer defense (see friendly.ts + this file).
//
// RING-BUFFER SAFETY: GET_COST_SUMMARY responses are seq-less publishOnly
// SYSTEM frames — they enter the 1000-event ring buffer but are NOT part of
// the reconnect backlog and CAN be evicted from `events` at any time. G1R
// SC-5: the WHOLE summary object is snapshotted into ONE useState the moment
// its frame appears, so a total and a breach decision can never be read from
// two different frames — every render reads from that one snapshot, never
// from a useMemo computed directly over `events`.

import { useEffect, useMemo, useState } from 'react';
import type { ClientCommand, GatewayEvent } from '@torqclaw/contracts';
import {
  formatCap,
  formatRemaining,
  formatAttribution,
  formatLedgerCost,
  formatCapState,
  formatDailyTotalLabel,
  formatProviderSummaryRow,
} from './friendly';

interface CapBreach {
  cap: 'session' | 'daily';
  total: number;
  limit: number;
  envVar: string;
}

interface RecentLedgerRow {
  taskId: string;
  costUsd: number | null;
  attribution: string;
  provider: string | null;
  sourceChannel: string | null;
  createdAt: string;
}

interface ProviderSummaryRow {
  provider: string | null;
  recordedUsd: number;
  unrecordedCount: number;
  totalCount: number;
}

interface CostSummary {
  sessionCap: number | null;
  dailyCap: number | null;
  sessionCapEnvVar: string;
  dailyCapEnvVar: string;
  sessionTotal: number;
  dailyTotal: number;
  sessionRemaining: number | null;
  dailyRemaining: number | null;
  breach: CapBreach | null;
  attributionCounts: Record<string, number>;
  cloudTaskCount: number;
  providerSummary: ProviderSummaryRow[];
  recentLedger: RecentLedgerRow[];
}

export default function CostPanel({
  events,
  sendCommand,
  onClose,
}: {
  events: GatewayEvent[];
  sendCommand: (command: ClientCommand) => boolean;
  onClose: () => void;
}) {
  // last-wins over metadata.costSummary frames in the (evictable) live ring.
  const latestSummary = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const meta = (events[i]!.metadata ?? {}) as Record<string, any>;
      if (meta.costSummary === true) return meta as unknown as CostSummary;
    }
    return null;
  }, [events]);

  // SNAPSHOT the WHOLE summary object into ONE useState (G1R SC-5) — a total
  // and a breach can never come from different frames, and this snapshot
  // survives eviction from the ring buffer.
  const [summary, setSummary] = useState<CostSummary | null>(null);
  useEffect(() => {
    if (latestSummary) setSummary(latestSummary);
  }, [latestSummary]);

  // On mount, (re-)request the summary — this also covers reconnect, since a
  // fresh GET_COST_SUMMARY repopulates state even if the prior frame was
  // evicted from the ring before this mount.
  useEffect(() => {
    sendCommand({ action: 'GET_COST_SUMMARY', recentLimit: 20 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[#0a0a0a]/98 text-sm text-neutral-300">
      <div className="flex items-center justify-between border-b border-neutral-800 p-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">Cost Control Center</h2>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200" aria-label="Close cost panel">
          close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {!summary && <p className="text-neutral-600">Loading…</p>}
        {summary && <CostSummaryView summary={summary} />}
      </div>
    </div>
  );
}

/** Read-only summary render. Every value goes through the format helpers —
 *  no fabrication, no dispatchable affordance anywhere in this tree. */
function CostSummaryView({ summary }: { summary: CostSummary }) {
  const breach = summary.breach;

  return (
    <div className="space-y-5">
      <Section title="Caps">
        <dl className="space-y-1 text-[12px]">
          <Row label="session cap" value={formatCap(summary.sessionCap)} />
          <Row label="session cap env var" value={summary.sessionCapEnvVar} />
          <Row label="daily cap" value={formatCap(summary.dailyCap)} />
          <Row label="daily cap env var" value={summary.dailyCapEnvVar} />
          <p className="pt-1 text-[10px] text-neutral-600">Daily cap resets 00:00 UTC.</p>
        </dl>
      </Section>

      <Section title="Totals">
        <dl className="space-y-1 text-[12px]">
          <Row label="session total" value={`$${summary.sessionTotal.toFixed(2)}`} />
          <Row label={`daily total — ${formatDailyTotalLabel()}`} value={`$${summary.dailyTotal.toFixed(2)}`} />
        </dl>
      </Section>

      <Section title="Remaining">
        <dl className="space-y-1 text-[12px]">
          <Row label="session" value={formatRemaining(summary.sessionCap, summary.sessionTotal)} />
          <Row label="daily" value={formatRemaining(summary.dailyCap, summary.dailyTotal)} />
        </dl>
      </Section>

      <Section title="Cap state">
        <p className={breach ? 'text-[#E24B4A]' : 'text-neutral-300'}>{formatCapState(breach)}</p>
        {breach && (
          <p className="mt-1 text-[10px] text-neutral-500">
            Raise the cap by setting {breach.envVar} — operator action outside this app.
            {breach.cap === 'daily' && ' Daily caps reset 00:00 UTC.'}
          </p>
        )}
      </Section>

      <Section title="Attribution counts (this session)">
        <dl className="space-y-1 text-[12px]">
          {(['exact', 'account_delta', 'unavailable'] as const).map((key) => {
            const n = summary.attributionCounts[key] ?? 0;
            const fmt = formatAttribution(key);
            return <Row key={key} label={fmt.label} value={String(n)} title={fmt.tooltip} />;
          })}
        </dl>
      </Section>

      <Section title="Cloud tasks (this session)">
        <p className="text-neutral-300">{summary.cloudTaskCount}</p>
      </Section>

      <Section title="Provider summary">
        {summary.providerSummary.length === 0 ? (
          <p className="text-neutral-600">none</p>
        ) : (
          <dl className="space-y-1 text-[12px]">
            {summary.providerSummary.map((row, i) => {
              const fmt = formatProviderSummaryRow(row);
              return (
                <div key={i} className="flex gap-2">
                  <dt className="w-32 shrink-0 text-neutral-500">{fmt.provider}</dt>
                  <dd className="text-neutral-300">
                    {fmt.recorded}
                    {fmt.caveat && <span className="ml-2 text-[10px] text-amber-400">{fmt.caveat}</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </Section>

      <Section title="Recent ledger">
        {summary.recentLedger.length === 0 ? (
          <p className="text-neutral-600">none</p>
        ) : (
          <ul className="space-y-1">
            {summary.recentLedger.map((row) => (
              <LedgerRow key={row.taskId} row={row} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** One recent-ledger row — plain data render, NO callbacks in scope. */
function LedgerRow({ row }: { row: RecentLedgerRow }) {
  const attr = formatAttribution(row.attribution);
  const cost = formatLedgerCost(row.costUsd, row.attribution);
  return (
    <li className="rounded border border-neutral-800 px-2 py-1 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="font-mono text-neutral-500">{row.taskId}</span>
        <span className="text-neutral-300">{cost}</span>
        <span className={attr.estimated ? 'text-amber-400' : 'text-neutral-500'} title={attr.tooltip}>
          {attr.label}
        </span>
        <span className="text-neutral-600">{row.provider ?? 'unknown/local'}</span>
        <span className="text-neutral-700">{row.createdAt}</span>
      </div>
    </li>
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

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex gap-2" title={title}>
      <dt className="w-40 shrink-0 text-neutral-500">{label}</dt>
      <dd className="text-neutral-300">{value}</dd>
    </div>
  );
}
