'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GatewayEvent, ClientCommand } from '@torqclaw/contracts';
import { useGatewayStream } from './useGatewayStream';
import { friendlyMessage, tierLabel, TYPE_LABELS, privacyHint } from './friendly';

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'ws://localhost:18790/ws';
const GATEWAY_TOKEN = process.env.NEXT_PUBLIC_GATEWAY_TOKEN ?? '';

type ExecutionMode = 'AUTO' | 'LOCAL_ONLY' | 'CLOUD_OK';
// '' = no budget (falls to env default). 'free' = local-only, $0.
type BudgetChoice = '' | 'free' | '0.25' | '1' | '5' | 'custom';

const CONTROLS_KEY = 'torqclaw.controls';

interface Controls {
  budget: BudgetChoice;
  customBudget: string;
  mode: ExecutionMode;
  fast: boolean;
  privateMode: boolean;
}

const DEFAULT_CONTROLS: Controls = {
  budget: '', customBudget: '', mode: 'AUTO', fast: false, privateMode: false,
};

function loadControls(): Controls {
  if (typeof window === 'undefined') return DEFAULT_CONTROLS;
  try {
    const raw = sessionStorage.getItem(CONTROLS_KEY);
    return raw ? { ...DEFAULT_CONTROLS, ...JSON.parse(raw) } : DEFAULT_CONTROLS;
  } catch {
    return DEFAULT_CONTROLS;
  }
}

/** Translate the budget/mode controls into the SUBMIT_PROMPT fields. */
function buildSubmit(prompt: string, c: Controls): Extract<ClientCommand, { action: 'SUBMIT_PROMPT' }> {
  // "Free (local only)" forces LOCAL_ONLY; otherwise mode is the user's pick.
  const mode: ExecutionMode = c.budget === 'free' ? 'LOCAL_ONLY' : c.mode;
  let maxCostUsd: number | undefined;
  if (c.budget === 'custom') {
    const n = Number(c.customBudget);
    if (Number.isFinite(n) && n > 0) maxCostUsd = n;
  } else if (c.budget !== '' && c.budget !== 'free') {
    maxCostUsd = Number(c.budget);
  }
  return {
    action: 'SUBMIT_PROMPT',
    prompt,
    sensitive: c.privateMode,
    urgent: c.fast,
    attachmentIds: [],
    executionMode: mode,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
}

export default function TorqTerminal() {
  const { events, isConnected, sendCommand } = useGatewayStream(GATEWAY_URL, GATEWAY_TOKEN);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [debouncedInput, setDebouncedInput] = useState('');
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [decided, setDecided] = useState<Record<string, 'APPROVE' | 'REJECT'>>({});

  // Load persisted controls after mount (sessionStorage is client-only).
  useEffect(() => { setControls(loadControls()); }, []);
  useEffect(() => {
    try { sessionStorage.setItem(CONTROLS_KEY, JSON.stringify(controls)); } catch { /* quota */ }
  }, [controls]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [events]);

  // Track the active request id from the last TIER_SELECTED so cancel/resend
  // can target it. Reset on a terminal event.
  const activeRequestId = useMemo(() => {
    let id: string | null = null;
    for (const ev of events) {
      if (ev.type === 'TIER_SELECTED' && ev.requestId) id = ev.requestId;
      if ((ev.type === 'RESULT' || ev.type === 'ERROR') && ev.requestId === id) id = null;
    }
    return id;
  }, [events]);

  const busy = useMemo(() => {
    const last = events[events.length - 1];
    return !!last && !['RESULT', 'ERROR', 'CONNECTED', 'PENDING_APPROVAL'].includes(last.type);
  }, [events]);

  // Privacy SUGGESTION (suggest-only — never sets the flag, never blocks).
  // Debounced 500ms so the regex pass never runs on the keystroke hot path,
  // keeping typing smooth even at the 32K-char prompt ceiling.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedInput(input), 500);
    return () => clearTimeout(t);
  }, [input]);
  const hint = useMemo(
    () => (controls.privateMode ? null : privacyHint(debouncedInput)),
    [debouncedInput, controls.privateMode],
  );
  useEffect(() => { setHintDismissed(false); }, [debouncedInput]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    sendCommand(buildSubmit(prompt, controls));
    setInput('');
  };

  const resendLocal = (prompt: string) => {
    sendCommand(buildSubmit(prompt, { ...controls, mode: 'LOCAL_ONLY', budget: controls.budget === '' ? 'free' : controls.budget }));
  };

  const stop = () => {
    if (activeRequestId) sendCommand({ action: 'CANCEL_TASK', taskId: activeRequestId });
  };

  const decideSkill = (queueId: string, decision: 'APPROVE' | 'REJECT') => {
    sendCommand({ action: 'APPROVE_SKILL', queueId, decision });
    setDecided((d) => ({ ...d, [queueId]: decision }));
  };

  const decideTool = (approvalId: string, decision: 'APPROVE' | 'REJECT') => {
    sendCommand({ action: 'APPROVE_TOOL', approvalId, decision });
    setDecided((d) => ({ ...d, [approvalId]: decision }));
  };

  const set = <K extends keyof Controls>(k: K, v: Controls[K]) =>
    setControls((c) => ({ ...c, [k]: v }));

  return (
    <section className="flex h-screen flex-col bg-[#0a0a0a] p-4 font-mono text-sm text-neutral-300">
      <header className="mb-4 flex items-center justify-between border-b border-neutral-800 pb-4">
        <div className="flex items-center gap-3">
          <span
            className={`h-2 w-2 rounded-full ${isConnected ? 'bg-[#E24B4A]' : 'animate-pulse bg-neutral-600'}`}
            aria-hidden
          />
          <h1 className="text-xs font-bold tracking-[0.3em] text-neutral-100">
            TORQCLAW <span className="text-[#E24B4A]">//</span> ORCHESTRATOR
          </h1>
        </div>
        <span className="text-[10px] uppercase tracking-widest text-neutral-500">
          {isConnected ? 'connected' : 'reconnecting — your work is safe'}
        </span>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto pr-2" aria-live="polite">
        {events.length === 0 && (
          <p className="pt-8 text-center text-neutral-600">
            Nothing yet. Type what you need below — simple tasks run free on this
            machine, complex ones go to a cloud model automatically. Set a budget
            or keep a task local with the controls under the box.
          </p>
        )}
        {events.map((ev) => (
          <EventRow key={ev.id} event={ev} decided={decided} onDecideSkill={decideSkill} onDecideTool={decideTool} onResendLocal={resendLocal} />
        ))}
        {busy && (
          <p className="flex items-center gap-3 px-2 py-1 text-neutral-500">
            <span className="inline-block animate-pulse">working…</span>
            <Elapsed />
            <button
              onClick={stop}
              className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] uppercase tracking-widest text-neutral-400 transition-colors hover:border-[#E24B4A]/60 hover:text-[#E24B4A]"
            >
              stop
            </button>
          </p>
        )}
      </div>

      {hint && !hintDismissed && (
        <div className="mt-3 flex items-center gap-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          <span>This looks like it may contain {hint} — keep it on this machine?</span>
          <button
            onClick={() => set('privateMode', true)}
            className="rounded border border-amber-400/50 px-2 py-0.5 text-amber-200 hover:bg-amber-400/15"
          >
            keep private
          </button>
          <button
            onClick={() => setHintDismissed(true)}
            className="text-amber-400/60 hover:text-amber-300"
          >
            dismiss
          </button>
        </div>
      )}

      <form onSubmit={submit} className="mt-4 border-t border-neutral-800 pt-4">
        <div className="flex items-center gap-3">
          <span className="text-[#E24B4A]" aria-hidden>{'>'}</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What do you need done?"
            aria-label="Describe your task"
            className="flex-1 bg-transparent py-1 text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
            autoFocus
          />
        </div>

        {/* Run controls: budget, where it runs, speed, privacy. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] uppercase tracking-widest text-neutral-500">
          <label className="flex items-center gap-1.5" title="Cap what a cloud task may spend">
            budget
            <select
              value={controls.budget}
              onChange={(e) => set('budget', e.target.value as BudgetChoice)}
              className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-neutral-300"
            >
              <option value="">default</option>
              <option value="free">Free (local only)</option>
              <option value="0.25">$0.25</option>
              <option value="1">$1</option>
              <option value="5">$5</option>
              <option value="custom">custom</option>
            </select>
          </label>
          {controls.budget === 'custom' && (
            <input
              type="number" min="0" max="100" step="0.25"
              value={controls.customBudget}
              onChange={(e) => set('customBudget', e.target.value)}
              placeholder="USD"
              aria-label="Custom budget in USD"
              className="w-16 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-neutral-300"
            />
          )}
          <label className="flex items-center gap-1.5" title="Where this task may run">
            mode
            <select
              value={controls.budget === 'free' ? 'LOCAL_ONLY' : controls.mode}
              disabled={controls.budget === 'free'}
              onChange={(e) => set('mode', e.target.value as ExecutionMode)}
              className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-neutral-300 disabled:opacity-50"
            >
              <option value="AUTO">Auto</option>
              <option value="LOCAL_ONLY">This machine only</option>
              <option value="CLOUD_OK">Cloud allowed</option>
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5" title="Prefer a fast answer">
            <input type="checkbox" checked={controls.fast} onChange={(e) => set('fast', e.target.checked)} className="accent-[#E24B4A]" />
            fast
          </label>
          <label className="flex cursor-pointer items-center gap-1.5" title="Private tasks never leave this machine — no cloud APIs, no exceptions">
            <input type="checkbox" checked={controls.privateMode} onChange={(e) => set('privateMode', e.target.checked)} className="accent-[#E24B4A]" />
            private
          </label>
        </div>
      </form>
    </section>
  );
}

/** Elapsed-time ticker on the working indicator (lifecycle clarity). */
function Elapsed() {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setS((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular-nums text-neutral-600">{s}s</span>;
}

function EventRow({
  event, decided, onDecideSkill, onDecideTool, onResendLocal,
}: {
  event: GatewayEvent;
  decided: Record<string, 'APPROVE' | 'REJECT'>;
  onDecideSkill: (queueId: string, decision: 'APPROVE' | 'REJECT') => void;
  onDecideTool: (approvalId: string, decision: 'APPROVE' | 'REJECT') => void;
  onResendLocal: (prompt: string) => void;
}) {
  const tier = tierLabel(event.tier);
  const meta = (event.metadata ?? {}) as Record<string, any>;
  // Two kinds of PENDING_APPROVAL: skill (queueId) and tool (approvalId).
  const queueId: string | undefined = meta.queueId ?? meta.queue_id;
  const approvalId: string | undefined = meta.approvalId ?? meta.approval_id;
  const cardId = approvalId ?? queueId; // the id this row decides under
  const decision = cardId ? decided[cardId] : undefined;
  const isToolApproval = event.type === 'PENDING_APPROVAL' && !!approvalId;
  const isUser = event.type === 'USER_PROMPT';
  const recovery: string[] = Array.isArray(meta.recovery) ? meta.recovery : [];

  return (
    <article
      className={`group flex gap-4 rounded px-2 py-1 transition-colors hover:bg-neutral-900/60 ${
        event.type === 'PENDING_APPROVAL' && !decision ? 'bg-[#E24B4A]/5' : ''
      }`}
      title={`${event.type}${meta.reason ? ` — ${meta.reason}` : ''}`}
    >
      <time className="shrink-0 tabular-nums text-neutral-600">
        {new Date(event.timestamp).toLocaleTimeString([], { hour12: false })}
      </time>
      <div className="min-w-0 flex-1">
        {tier && (
          <span
            title={tier.hint}
            className={`mr-2 rounded border px-1.5 py-0.5 text-[10px] tracking-wide ${
              event.tier === 'OLLAMA_LOCAL'
                ? 'border-neutral-700 bg-neutral-900 text-neutral-400'
                : 'border-[#E24B4A]/40 bg-[#E24B4A]/10 text-[#E24B4A]'
            }`}
          >
            {tier.text}
          </span>
        )}
        <span
          className={`mr-2 text-[10px] font-bold ${
            event.type === 'TOOL_CALL' ? 'text-amber-400'
            : event.type === 'PENDING_APPROVAL' && !decision ? 'animate-pulse text-[#E24B4A]'
            : event.type === 'ERROR' ? 'text-[#E24B4A]'
            : isUser ? 'text-neutral-300'
            : 'text-neutral-600'
          }`}
        >
          [{TYPE_LABELS[event.type] ?? event.type.toLowerCase()}]
        </span>
        <span className={
          event.type === 'RESULT' ? 'font-semibold text-neutral-100'
          : isUser ? 'text-neutral-200'
          : 'text-neutral-400'
        }>
          {friendlyMessage(event)}
        </span>

        {/* Skill approval — compact allow/deny (existing path, unchanged). */}
        {event.type === 'PENDING_APPROVAL' && queueId && !approvalId && !decision && (
          <span className="ml-3 inline-flex gap-2 align-middle">
            <button
              onClick={() => onDecideSkill(queueId, 'APPROVE')}
              className="rounded border border-[#E24B4A]/50 px-2 py-0.5 text-[10px] text-[#E24B4A] transition-colors hover:bg-[#E24B4A]/15"
            >
              allow
            </button>
            <button
              onClick={() => onDecideSkill(queueId, 'REJECT')}
              className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400 transition-colors hover:bg-neutral-800"
            >
              deny
            </button>
          </span>
        )}

        {/* Tool approval — expanded permission card (P2). */}
        {isToolApproval && approvalId && !decision && (
          <ToolPermissionCard
            toolName={String(meta.toolName ?? meta.tool_name ?? '')}
            args={meta.args}
            onAllow={() => onDecideTool(approvalId, 'APPROVE')}
            onDeny={() => onDecideTool(approvalId, 'REJECT')}
          />
        )}

        {decision && (
          <span className="ml-3 text-[10px] text-neutral-500">
            {decision === 'APPROVE' ? '✓ allowed once' : '✕ denied'}
          </span>
        )}

        {/* Failure recovery: one-click resend on this machine. */}
        {event.type === 'ERROR' && recovery.includes('RETRY_LOCAL') && meta.prompt && (
          <button
            onClick={() => onResendLocal(String(meta.prompt))}
            className="ml-3 rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-[#E24B4A]/60 hover:text-[#E24B4A]"
          >
            run on this machine
          </button>
        )}
      </div>
    </article>
  );
}

/** P2 tool-approval card: shows ONLY facts the system knows (action, exact tool
 *  name, args, one-time scope). No risk scores or invented assessments
 *  (invariant 6). Allow once -> APPROVE_TOOL re-runs the task with the grant. */
function ToolPermissionCard({
  toolName, args, onAllow, onDeny,
}: {
  toolName: string;
  args: unknown;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Friendly verb: take the segment after the last "__", underscores -> spaces.
  // Use lastIndexOf (not a \w+ regex) so hyphenated/dotted MCP names survive.
  const friendly = (toolName.includes('__')
    ? toolName.slice(toolName.lastIndexOf('__') + 2)
    : toolName
  ).replace(/_/g, ' ');

  const pretty = useMemo(() => {
    try { return JSON.stringify(args ?? {}, null, 2); }
    catch { return String(args); }
  }, [args]);
  const TRUNC = 500;
  const isLong = pretty.length > TRUNC;
  const shown = expanded || !isLong ? pretty : pretty.slice(0, TRUNC) + '\n…';

  return (
    <div className="ml-2 mt-2 max-w-2xl rounded border border-[#E24B4A]/40 bg-[#E24B4A]/5 p-3">
      <p className="text-neutral-200">
        This task wants to <span className="font-semibold text-neutral-100">{friendly}</span> to finish.
      </p>
      <dl className="mt-2 space-y-1 text-[11px]">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 uppercase tracking-widest text-neutral-500">tool</dt>
          <dd className="font-mono text-neutral-300">{toolName || '(unknown)'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 uppercase tracking-widest text-neutral-500">scope</dt>
          <dd className="text-neutral-400">One-time — applies to a single re-run</dd>
        </div>
      </dl>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-[11px] text-neutral-400">
        {shown}
      </pre>
      {isLong && (
        <button onClick={() => setExpanded((v) => !v)} className="mt-1 text-[10px] text-neutral-500 hover:text-neutral-300">
          {expanded ? 'show less' : `show all (${pretty.length} chars)`}
        </button>
      )}
      <div className="mt-3 flex gap-2">
        <button onClick={onAllow} className="rounded border border-[#E24B4A]/50 px-3 py-1 text-[11px] text-[#E24B4A] hover:bg-[#E24B4A]/15">
          Allow once
        </button>
        <button onClick={onDeny} className="rounded border border-neutral-700 px-3 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800">
          Deny
        </button>
      </div>
    </div>
  );
}
