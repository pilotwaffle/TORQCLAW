import { randomUUID } from 'node:crypto';
import { db } from './storage.js';
import {
  GatewayEventSchema,
  type GatewayEvent,
  type GatewayEventType,
  type ComputeTier,
  type GatewayRequest,
  type RouterDiagnostics,
} from '@torqclaw/contracts';

/** Sockets subscribe per-session; execution never holds a socket reference. */
type Listener = (event: GatewayEvent) => void;
const subscribers = new Map<string, Set<Listener>>();

export const sessionBus = {
  subscribe(sessionId: string, fn: Listener): () => void {
    if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
    subscribers.get(sessionId)!.add(fn);
    return () => subscribers.get(sessionId)?.delete(fn);
  },
  publish(sessionId: string, event: GatewayEvent): void {
    subscribers.get(sessionId)?.forEach((fn) => {
      try { fn(event); } catch { /* one bad socket never blocks the bus */ }
    });
  },
};

const insertEvent = db.prepare(
  `INSERT INTO events (id, session_id, request_id, tier, type, message, metadata)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

export function persistAndPublish(event: Omit<GatewayEvent, 'seq'>): GatewayEvent {
  const validated = GatewayEventSchema.parse(event); // gateway obeys its own contract
  const info = insertEvent.run(
    validated.id, validated.sessionId, validated.requestId, validated.tier,
    validated.type, validated.message,
    validated.metadata === undefined ? null : JSON.stringify(validated.metadata),
  );
  const withSeq: GatewayEvent = { ...validated, seq: Number(info.lastInsertRowid) };
  sessionBus.publish(validated.sessionId, withSeq);
  return withSeq;
}

/**
 * TCLAW-4B: the ONLY non-persisted emission path. Validates against
 * GatewayEventSchema (the gateway obeys its own contract even for transient
 * frames) then publishes DIRECTLY to sessionBus — no INSERT into events, no
 * seq assignment. Publishes only to the given session's own subscribers
 * (i.e. the commanding connection's session), never broadcast.
 *
 * Used solely for receipt-read responses (LIST_RECEIPTS/GET_RECEIPT) so that
 * derived/rehydrated data — which already lives durably in run_receipts and
 * the source event log — never gets a second, redundant home in the events
 * table, and never re-enters the reconnect backlog (getEventLogSince).
 *
 * The built event OMITS seq entirely (GatewayEventSchema.seq is .optional()).
 * This is deliberate, not incidental: the console's cursor guard
 * (useGatewayStream) only advances its resume cursor when an incoming event
 * carries a non-null seq, so a seq-less event can never rewind or corrupt a
 * client's reconnect position.
 */
export function publishOnly(
  sessionId: string,
  event: { message: string; metadata?: unknown },
): void {
  const built: Omit<GatewayEvent, 'seq'> = {
    id: randomUUID(),
    requestId: null,
    sessionId,
    tier: null,
    type: 'SYSTEM',
    message: event.message,
    metadata: event.metadata,
    timestamp: new Date().toISOString(),
  };
  const validated = GatewayEventSchema.parse(built); // gateway obeys its own contract
  sessionBus.publish(sessionId, validated as GatewayEvent);
}

export type Emitter = (type: GatewayEventType, message: string, metadata?: unknown) => void;

export function makeEmitter(
  sessionId: string, requestId: string | null, tier: ComputeTier | null,
): Emitter {
  return (type, message, metadata) =>
    persistAndPublish({
      id: randomUUID(), requestId, sessionId, tier, type, message, metadata,
      timestamp: new Date().toISOString(),
    });
}

/** Task rows are created BEFORE execution starts: a crash leaves a resumable
 *  record, never a ghost. */
export const taskStore = {
  create(req: GatewayRequest, diag: RouterDiagnostics): void {
    db.prepare(
      `INSERT INTO tasks (request_id, session_id, tier, router_reason, request_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(req.id, req.sessionId, diag.tier, diag.reason, JSON.stringify(req));
  },
  complete(requestId: string, result: string, telemetry?: unknown): void {
    // telemetry_json is added by the P1 migration; until then it's ignored.
    db.prepare(
      `UPDATE tasks SET state='completed', result=?, telemetry_json=?,
                        finished_at=CURRENT_TIMESTAMP
       WHERE request_id=?`,
    ).run(result, telemetry === undefined ? null : JSON.stringify(telemetry), requestId);
  },
  /** G1R correction A: a failed/breached task must not persist zero
   *  telemetry. `telemetry` is optional and backward-compatible — omitting it
   *  (the DENIED / FRONTIER_UNAVAILABLE call sites) writes NULL exactly as
   *  before. The budget-breach path passes the last-known telemetry
   *  (including costUsd from CircuitBreakerError.lastCostUsd) so the ledger
   *  and the receipt projector can see the breach's real cost instead of a
   *  silent gap. */
  fail(requestId: string, error: string, telemetry?: unknown): void {
    db.prepare(
      `UPDATE tasks SET state='failed', error=?, telemetry_json=?, finished_at=CURRENT_TIMESTAMP
       WHERE request_id=?`,
    ).run(error, telemetry === undefined ? null : JSON.stringify(telemetry), requestId);
  },
};
