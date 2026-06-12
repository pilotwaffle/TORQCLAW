'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GatewayEventSchema,
  ClientCommandSchema,
  type GatewayEvent,
  type ClientCommand,
} from '@torqclaw/contracts';

const MAX_EVENTS = 1_000; // ring buffer: a 24/7 console must not leak memory
const SESSION_KEY = 'torqclaw.sessionId';
const CURSOR_KEY = 'torqclaw.lastSeenSeq';

export function useGatewayStream(url: string, token: string) {
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const closedByUser = useRef(false);

  const connect = useCallback(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      setIsConnected(true);
      // First frame: authenticate + resume the durable session.
      ws.send(
        JSON.stringify({
          role: 'operator',
          token,
          sessionId: sessionStorage.getItem(SESSION_KEY) ?? undefined,
          lastSeenSeq: Number(sessionStorage.getItem(CURSOR_KEY)) || null,
          clientInfo: { name: 'torq-console', version: '0.1.0' },
        }),
      );
    };

    ws.onmessage = (e) => {
      let raw: unknown;
      try { raw = JSON.parse(e.data); } catch { return; }
      const parsed = GatewayEventSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn('Schema-invalid frame dropped', parsed.error);
        return;
      }
      const ev = parsed.data;
      if (ev.type === 'CONNECTED' && (ev.metadata as any)?.sessionId) {
        sessionStorage.setItem(SESSION_KEY, (ev.metadata as any).sessionId);
      }
      if (ev.seq != null) sessionStorage.setItem(CURSOR_KEY, String(ev.seq));
      setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), ev]);
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (closedByUser.current) return;
      // Exponential backoff reconnect — an enterprise console that dies
      // permanently on a gateway restart isn't one.
      const delay = Math.min(1_000 * 2 ** attemptRef.current, 30_000);
      attemptRef.current++;
      setTimeout(connect, delay);
    };
  }, [url, token]);

  useEffect(() => {
    closedByUser.current = false;
    connect();
    return () => {
      closedByUser.current = true;
      const ws = wsRef.current;
      if (!ws) return;
      // Strict-mode guard: close() while CONNECTING throws.
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.onopen = () => ws.close();
    };
  }, [connect]);

  const sendCommand = useCallback((command: ClientCommand) => {
    const validated = ClientCommandSchema.parse(command); // client obeys contracts too
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(validated));
  }, []);

  return { events, isConnected, sendCommand };
}
