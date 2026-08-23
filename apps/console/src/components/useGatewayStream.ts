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

export type GatewayControlError = {
  type: 'ERROR';
  code: string;
  detail?: unknown;
};

export function classifyGatewayFrame(raw: unknown):
  | { kind: 'event'; event: GatewayEvent }
  | { kind: 'control-error'; error: GatewayControlError; disconnect: false }
  | { kind: 'invalid'; error: unknown } {
  if (
    typeof raw === 'object' && raw !== null &&
    (raw as Record<string, unknown>).type === 'ERROR' &&
    typeof (raw as Record<string, unknown>).code === 'string'
  ) {
    const frame = raw as Record<string, unknown>;
    return {
      kind: 'control-error',
      disconnect: false,
      error: {
        type: 'ERROR',
        code: frame.code as string,
        ...(frame.detail === undefined ? {} : { detail: frame.detail }),
      },
    };
  }

  const parsed = GatewayEventSchema.safeParse(raw);
  return parsed.success
    ? { kind: 'event', event: parsed.data }
    : { kind: 'invalid', error: parsed.error };
}

export function buildSurfaceConnectFrame(
  credential: string,
  sessionId?: string,
  lastSeenSeq: number | null = null,
) {
  return {
    expectedRole: 'operator' as const,
    auth: { kind: 'surface' as const, credential },
    sessionId,
    lastSeenSeq,
    clientInfo: { name: 'torq-console', version: '0.1.0' },
  };
}

export function useGatewayStream(url: string, credential: string) {
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const closedByUser = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // First frame: authenticate + resume the durable session.
      ws.send(
        JSON.stringify(buildSurfaceConnectFrame(
          credential,
          sessionStorage.getItem(SESSION_KEY) ?? undefined,
          Number(sessionStorage.getItem(CURSOR_KEY)) || null,
        )),
      );
    };

    ws.onmessage = (e) => {
      let raw: unknown;
      try { raw = JSON.parse(e.data); } catch { return; }
      const parsed = classifyGatewayFrame(raw);
      if (parsed.kind === 'control-error') {
        console.warn('Gateway command rejected', parsed.error.code, parsed.error.detail);
        return;
      }
      if (parsed.kind === 'invalid') {
        console.warn('Schema-invalid frame dropped', parsed.error);
        return;
      }
      const ev = parsed.event;
      if (ev.type === 'CONNECTED' && (ev.metadata as any)?.sessionId) {
        attemptRef.current = 0;
        setIsConnected(true);
        sessionStorage.setItem(SESSION_KEY, (ev.metadata as any).sessionId);
      }
      if (ev.seq != null) sessionStorage.setItem(CURSOR_KEY, String(ev.seq));
      setEvents((prev) => {
        // The gateway can re-emit an event on session resume/replay; a
        // duplicate id would collide as a React key downstream and double-
        // render the row. Skip ids already present in the ring.
        if (prev.some((p) => p.id === ev.id)) return prev;
        return [...prev.slice(-(MAX_EVENTS - 1)), ev];
      });
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (closedByUser.current) return;
      // Exponential backoff reconnect — an enterprise console that dies
      // permanently on a gateway restart isn't one. Tracked in a ref so a
      // user-triggered reconnect() can cancel a pending backoff timer.
      const delay = Math.min(1_000 * 2 ** attemptRef.current, 30_000);
      attemptRef.current++;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }, [url, credential]);

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

  // Human-triggerable immediate reconnect, surfaced by the staleness badge.
  // A dead/stale WS is the ONE case the user can act on from the UI, so pure
  // display with no affordance would be a dead end. Resets the backoff so the
  // retry fires immediately instead of waiting out the exponential delay.
  const reconnect = useCallback(() => {
    closedByUser.current = false;
    attemptRef.current = 0;
    // Cancel any pending backoff auto-reconnect so it cannot fire a second
    // connect() in parallel with the one below.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const ws = wsRef.current;
    if (ws) {
      // Detach EVERY handler, not just onclose: a zombie socket still in
      // CONNECTING could otherwise complete its handshake later, fire onopen
      // (re-authenticating) and onmessage (appending into the same events
      // ring) and duplicate the event stream alongside the fresh socket.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed / CONNECTING — closing is not guaranteed safe */
      }
    }
    wsRef.current = null;
    connect();
  }, [connect]);

  // Returns true if the command was actually sent. A dropped send (socket not
  // OPEN, or schema-invalid command) returns false instead of failing silently
  // so callers — notably the stop button — can tell the user it didn't land.
  const sendCommand = useCallback((command: ClientCommand): boolean => {
    let validated: ClientCommand;
    try {
      validated = ClientCommandSchema.parse(command); // client obeys contracts too
    } catch (err) {
      console.error('sendCommand: invalid command dropped', err);
      return false;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(validated));
      return true;
    }
    console.warn('sendCommand: socket not open, command dropped', validated.action);
    return false;
  }, []);

  return { events, isConnected, sendCommand, reconnect };
}
