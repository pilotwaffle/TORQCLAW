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
  complete(requestId: string, result: string): void {
    db.prepare(
      `UPDATE tasks SET state='completed', result=?, finished_at=CURRENT_TIMESTAMP
       WHERE request_id=?`,
    ).run(result, requestId);
  },
  fail(requestId: string, error: string): void {
    db.prepare(
      `UPDATE tasks SET state='failed', error=?, finished_at=CURRENT_TIMESTAMP
       WHERE request_id=?`,
    ).run(error, requestId);
  },
};
