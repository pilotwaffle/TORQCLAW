'use client';

import { useEffect, useRef, useState } from 'react';
import type { GatewayEvent } from '@torqclaw/contracts';
import { useGatewayStream } from './useGatewayStream';

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'ws://localhost:18790/ws';
const GATEWAY_TOKEN = process.env.NEXT_PUBLIC_GATEWAY_TOKEN ?? '';

export default function TorqTerminal() {
  const { events, isConnected, sendCommand } = useGatewayStream(GATEWAY_URL, GATEWAY_TOKEN);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [sensitive, setSensitive] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    sendCommand({
      action: 'SUBMIT_PROMPT', prompt, sensitive, urgent: false, attachmentIds: [],
    });
    setInput('');
  };

  return (
    <section className="flex h-screen flex-col bg-[#0a0a0a] p-4 font-mono text-sm text-neutral-300">
      <header className="mb-4 flex items-center justify-between border-b border-neutral-800 pb-4">
        <div className="flex items-center gap-3">
          <span
            className={`h-2 w-2 rounded-full ${
              isConnected ? 'bg-[#E24B4A] shadow-[0_0_8px_#E24B4A]' : 'bg-neutral-600'
            }`}
            aria-label={isConnected ? 'connected' : 'disconnected'}
          />
          <h1 className="text-xs font-bold tracking-[0.3em] text-neutral-100">
            TORQCLAW <span className="text-[#E24B4A]">//</span> ORCHESTRATOR
          </h1>
        </div>
        <span className="text-[10px] uppercase tracking-widest text-neutral-500">
          {isConnected ? 'link established' : 'reconnecting'}
        </span>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto pr-2">
        {events.map((ev) => <EventRow key={ev.id} event={ev} />)}
      </div>

      <form onSubmit={submit} className="mt-4 flex items-center gap-3 border-t border-neutral-800 pt-4">
        <span className="text-[#E24B4A]">{'>'}</span>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="assign task"
          className="flex-1 bg-transparent py-1 text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          autoFocus
        />
        <label className="flex cursor-pointer items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-500">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(e) => setSensitive(e.target.checked)}
            className="accent-[#E24B4A]"
          />
          sensitive
        </label>
      </form>
    </section>
  );
}

function EventRow({ event }: { event: GatewayEvent }) {
  const isLocal = event.tier === 'OLLAMA_LOCAL';
  return (
    <article className="group flex gap-4 rounded px-2 py-1 transition-colors hover:bg-neutral-900/60">
      <time className="shrink-0 tabular-nums text-neutral-600">
        {new Date(event.timestamp).toLocaleTimeString([], { hour12: false })}
      </time>
      <div className="min-w-0 flex-1">
        {event.tier && (
          <span
            className={`mr-2 rounded border px-1.5 py-0.5 text-[10px] tracking-wide ${
              isLocal
                ? 'border-neutral-700 bg-neutral-900 text-neutral-400'
                : 'border-[#E24B4A]/40 bg-[#E24B4A]/10 text-[#E24B4A]'
            }`}
          >
            {isLocal ? 'LOCAL EDGE' : 'FRONTIER'}
          </span>
        )}
        <span
          className={`mr-2 text-[10px] font-bold ${
            event.type === 'TOOL_CALL' ? 'text-amber-400'
            : event.type === 'PENDING_APPROVAL' ? 'animate-pulse text-[#E24B4A]'
            : event.type === 'ERROR' ? 'text-[#E24B4A]'
            : 'text-neutral-600'
          }`}
        >
          [{event.type}]
        </span>
        <span className={
          event.type === 'RESULT' ? 'font-semibold text-neutral-100'
          : event.type === 'USER_PROMPT' ? 'text-neutral-200'
          : 'text-neutral-400'
        }>
          {event.message}
        </span>
      </div>
    </article>
  );
}
