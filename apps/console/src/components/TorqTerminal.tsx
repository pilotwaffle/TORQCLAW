'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GatewayEvent } from '@torqclaw/contracts';
import { useGatewayStream } from './useGatewayStream';
import { friendlyMessage, tierLabel, TYPE_LABELS } from './friendly';

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'ws://localhost:18790/ws';
const GATEWAY_TOKEN = process.env.NEXT_PUBLIC_GATEWAY_TOKEN ?? '';

export default function TorqTerminal() {
  const { events, isConnected, sendCommand } = useGatewayStream(GATEWAY_URL, GATEWAY_TOKEN);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [decided, setDecided] = useState<Record<string, 'APPROVE' | 'REJECT'>>({});

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [events]);

  const busy = useMemo(() => {
    const last = events[events.length - 1];
    return !!last && !['RESULT', 'ERROR', 'CONNECTED', 'PENDING_APPROVAL'].includes(last.type);
  }, [events]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    sendCommand({ action: 'SUBMIT_PROMPT', prompt, sensitive, urgent: false, attachmentIds: [] });
    setInput('');
  };

  const decide = (queueId: string, decision: 'APPROVE' | 'REJECT') => {
    sendCommand({ action: 'APPROVE_SKILL', queueId, decision });
    setDecided((d) => ({ ...d, [queueId]: decision }));
  };

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
            machine, complex ones go to a cloud model automatically.
          </p>
        )}
        {events.map((ev) => (
          <EventRow key={ev.id} event={ev} decided={decided} onDecide={decide} />
        ))}
        {busy && (
          <p className="px-2 py-1 text-neutral-500">
            <span className="inline-block animate-pulse">working…</span>
          </p>
        )}
      </div>

      <form onSubmit={submit} className="mt-4 flex items-center gap-3 border-t border-neutral-800 pt-4">
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
        <label
          className="flex cursor-pointer items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-500"
          title="Private tasks never leave this machine — no cloud APIs, no exceptions"
        >
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(e) => setSensitive(e.target.checked)}
            className="accent-[#E24B4A]"
          />
          private
        </label>
      </form>
    </section>
  );
}

function EventRow({
  event, decided, onDecide,
}: {
  event: GatewayEvent;
  decided: Record<string, 'APPROVE' | 'REJECT'>;
  onDecide: (queueId: string, decision: 'APPROVE' | 'REJECT') => void;
}) {
  const tier = tierLabel(event.tier);
  const meta = (event.metadata ?? {}) as Record<string, any>;
  const queueId: string | undefined = meta.queueId ?? meta.queue_id;
  const decision = queueId ? decided[queueId] : undefined;
  const isUser = event.type === 'USER_PROMPT';

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

        {event.type === 'PENDING_APPROVAL' && queueId && !decision && (
          <span className="ml-3 inline-flex gap-2 align-middle">
            <button
              onClick={() => onDecide(queueId, 'APPROVE')}
              className="rounded border border-[#E24B4A]/50 px-2 py-0.5 text-[10px] text-[#E24B4A] transition-colors hover:bg-[#E24B4A]/15"
            >
              allow
            </button>
            <button
              onClick={() => onDecide(queueId, 'REJECT')}
              className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400 transition-colors hover:bg-neutral-800"
            >
              deny
            </button>
          </span>
        )}
        {decision && (
          <span className="ml-3 text-[10px] text-neutral-500">
            {decision === 'APPROVE' ? '✓ allowed' : '✕ denied'}
          </span>
        )}
      </div>
    </article>
  );
}
