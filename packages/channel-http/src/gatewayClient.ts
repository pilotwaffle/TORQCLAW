import WebSocket from 'ws';
import type { GatewayEvent } from '@torqclaw/contracts';

/** The three events the gateway emits exactly once per task (invariant 7).
 *  A channel adapter waits for whichever lands and relays it back. */
export const TERMINAL_TYPES = new Set(['RESULT', 'ERROR', 'PENDING_APPROVAL']);

export function isTerminal(ev: { type?: string }): boolean {
  return typeof ev.type === 'string' && TERMINAL_TYPES.has(ev.type);
}

export interface SubmitOptions {
  /** ws://host:port/ws of the gateway. */
  url: string;
  /** Gateway auth token (TORQCLAW_GATEWAY_TOKEN; '' / 'dev' in loopback dev). */
  token: string;
  /** Resume an existing TorqClaw session; omit to start a fresh one. A channel
   *  maps its own conversation key (Slack thread, REST session header) to this
   *  so multi-turn context survives across requests. */
  sessionId?: string;
  /** Identifies this adapter in the session row + audit log. */
  clientName?: string;
  /** Per-request ceiling; a slow live FRONTIER run can take minutes. */
  timeoutMs?: number;
}

export interface SubmitPayload {
  prompt: string;
  sensitive?: boolean;
  urgent?: boolean;
  executionMode?: 'AUTO' | 'LOCAL_ONLY' | 'CLOUD_OK';
  maxCostUsd?: number;
  useMemory?: boolean;
}

export interface SubmitResult {
  /** The terminal event (RESULT | ERROR | PENDING_APPROVAL). */
  terminal: GatewayEvent;
  /** The session this ran under — return it so the caller can resume. */
  sessionId: string;
  /** Every event observed, in order (for verbose/debug responses). */
  events: GatewayEvent[];
  /** True if we returned because the timeout fired, not a terminal event. */
  timedOut: boolean;
}

/**
 * Bridge one external message through the full TorqClaw pipeline:
 *   connect as role:'channel' → SUBMIT_PROMPT → wait for the single terminal
 *   event → resolve. This is the reusable core every channel adapter shares;
 *   the HTTP/Slack/Discord layer only translates its own surface to/from this.
 *
 * Never throws on protocol errors — it resolves with timedOut:true or an
 * ERROR terminal so the calling channel can always answer its user.
 */
export function submitToGateway(
  opts: SubmitOptions,
  payload: SubmitPayload,
): Promise<SubmitResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return new Promise((resolve) => {
    const ws = new WebSocket(opts.url);
    const events: GatewayEvent[] = [];
    let sessionId = opts.sessionId ?? '';
    let settled = false;

    const finish = (terminal: GatewayEvent | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve({
        terminal: terminal ?? synthTimeout(sessionId),
        sessionId,
        events,
        timedOut,
      });
    };

    const timer = setTimeout(() => finish(null, true), timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        role: 'channel',
        token: opts.token,
        sessionId: opts.sessionId, // undefined = create
        clientInfo: { name: opts.clientName ?? 'channel-http', version: '0.1.0' },
      }));
      // The gateway answers the connect frame with CONNECTED carrying the
      // resolved sessionId; we submit only after we've seen it, so a fresh
      // session is captured for the response. (Sent on first message handler.)
    });

    ws.on('message', (raw: Buffer) => {
      let ev: GatewayEvent;
      try {
        ev = JSON.parse(raw.toString());
      } catch {
        return; // gateway never sends non-JSON; ignore defensively
      }

      // Capture the session id from CONNECTED, then submit the prompt.
      if (ev.type === 'CONNECTED') {
        sessionId = ev.sessionId ?? sessionId;
        ws.send(JSON.stringify({
          action: 'SUBMIT_PROMPT',
          prompt: payload.prompt,
          sensitive: payload.sensitive ?? false,
          urgent: payload.urgent ?? false,
          attachmentIds: [],
          executionMode: payload.executionMode ?? 'AUTO',
          ...(payload.maxCostUsd !== undefined ? { maxCostUsd: payload.maxCostUsd } : {}),
          useMemory: payload.useMemory ?? true,
        }));
        return;
      }

      // The auth/schema errors the gateway sends before a task exists carry a
      // `code` and no `type` — surface them as a terminal error immediately.
      if ((ev as any).code && !ev.type) {
        return finish(
          { ...stubEvent(sessionId), type: 'ERROR', message: `gateway: ${(ev as any).code}` },
          false,
        );
      }

      events.push(ev);
      if (isTerminal(ev)) finish(ev, false);
    });

    ws.on('error', (e: Error) => {
      finish(
        { ...stubEvent(sessionId), type: 'ERROR', message: `connection: ${e.message}` },
        false,
      );
    });
  });
}

function stubEvent(sessionId: string): GatewayEvent {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    requestId: null,
    sessionId: sessionId || '00000000-0000-0000-0000-000000000000',
    tier: null,
    type: 'ERROR',
    message: '',
    timestamp: new Date().toISOString(),
  };
}

function synthTimeout(sessionId: string): GatewayEvent {
  return {
    ...stubEvent(sessionId),
    type: 'ERROR',
    message: 'Timed out waiting for a result from the gateway.',
  };
}
