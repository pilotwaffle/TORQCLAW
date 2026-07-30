import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw');
mkdirSync(DATA_DIR, { recursive: true });

export const db: Database.Database = new Database(join(DATA_DIR, 'state.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const here = dirname(fileURLToPath(import.meta.url));
const schemaText = readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8');
const RESILIENCE_BEGIN = '-- TORQCLAW_RESILIENCE_SCHEMA_BEGIN';
const RESILIENCE_END = '-- TORQCLAW_RESILIENCE_SCHEMA_END';
const resilienceStart = schemaText.indexOf(RESILIENCE_BEGIN);
const resilienceEnd = schemaText.indexOf(RESILIENCE_END);
if (resilienceStart < 0 || resilienceEnd < resilienceStart) throw new Error('gateway schema resilience markers are invalid');
const legacySchemaText = schemaText.slice(0, resilienceStart);
const resilienceSchemaText = schemaText.slice(resilienceStart, resilienceEnd + RESILIENCE_END.length);
// Feature-off compatibility: resilience projection DDL is deferred until the
// feature-on branch explicitly calls ensureResilienceProjection().
db.exec(isResilienceFlagOn() ? schemaText : legacySchemaText);

// Idempotent migration: add tasks.telemetry_json on an existing dev DB without
// the column (PRAGMA check, not a bare ALTER that throws on second boot).
const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
if (!taskCols.some((c) => c.name === 'telemetry_json')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN telemetry_json TEXT`);
}

export { DATA_DIR };

function isResilienceFlagOn(): boolean {
  return process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED?.toLowerCase() === 'true';
}

export interface GatewayProjectionEvent {
  outboxId: number;
  taskId: string;
  attemptId: string;
  epoch: number;
  kind: string;
  payload?: Record<string, unknown>;
  createdAtMs?: number;
}

export function ensureResilienceProjection(): void {
  const present = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='resilience_projection_cursor'`).get();
  if (!present) db.exec(resilienceSchemaText);
}

function cursorValue(): number {
  ensureResilienceProjection();
  const row = db.prepare(`SELECT applied_outbox_id FROM resilience_projection_cursor WHERE id = 1`).get() as { applied_outbox_id?: number } | undefined;
  const value = row?.applied_outbox_id;
  if (!Number.isSafeInteger(value)) throw new Error('RESILIENCE_PROJECTION_FAILED: cursor missing');
  return value as number;
}

function strictEvent(value: unknown): GatewayProjectionEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('RESILIENCE_PROJECTION_FAILED: event is not an object');
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.outboxId) || (raw.outboxId as number) <= 0 || typeof raw.taskId !== 'string' || typeof raw.attemptId !== 'string' || !Number.isSafeInteger(raw.epoch) || typeof raw.kind !== 'string') {
    throw new Error('RESILIENCE_PROJECTION_FAILED: event identity is invalid');
  }
  if (raw.kind === 'provider_event' && raw.payload !== undefined) {
    const payload = raw.payload as Record<string, unknown>;
    if (payload === null || typeof payload !== 'object' || typeof payload.eventKind !== 'string' || payload.payload === undefined) throw new Error('RESILIENCE_PROJECTION_FAILED: provider event is not normalized');
  }
  return { outboxId: raw.outboxId as number, taskId: raw.taskId, attemptId: raw.attemptId, epoch: raw.epoch as number, kind: raw.kind, payload: raw.payload as Record<string, unknown> | undefined, createdAtMs: typeof raw.createdAtMs === 'number' ? raw.createdAtMs : undefined };
}

function applyEvent(tx: any, event: GatewayProjectionEvent): void {
  const payload = event.payload ?? {};
  if (event.kind === 'attempt_created') {
    if (typeof payload.providerId !== 'string') throw new Error('RESILIENCE_PROJECTION_FAILED: attempt provider missing');
    tx.prepare(`
      INSERT INTO provider_attempt_projection (task_id, epoch, attempt_id, provider_id, started_at_ms)
      VALUES (@taskId, @epoch, @attemptId, @providerId, @startedAtMs)
      ON CONFLICT(task_id, epoch) DO UPDATE SET attempt_id=excluded.attempt_id, provider_id=excluded.provider_id
    `).run({ taskId: event.taskId, epoch: event.epoch, attemptId: event.attemptId, providerId: payload.providerId, startedAtMs: event.createdAtMs ?? null });
  } else if (event.kind === 'dispatch_attempted') {
    tx.prepare(`UPDATE provider_attempt_projection SET dispatch_attempted=1 WHERE task_id=? AND epoch=?`).run(event.taskId, event.epoch);
  } else if (event.kind === 'cost_recorded') {
    tx.prepare(`UPDATE provider_attempt_projection SET actual_micro_usd=?, cost_known=? WHERE task_id=? AND epoch=?`).run(
      typeof payload.actualCostMicroUsd === 'number' ? payload.actualCostMicroUsd : null,
      payload.known === true ? 1 : 0, event.taskId, event.epoch,
    );
  } else if (event.kind === 'attempt_completed') {
    tx.prepare(`UPDATE provider_attempt_projection SET ended_at_ms=?, terminal_outcome=?, actual_micro_usd=?, cost_known=? WHERE task_id=? AND epoch=?`).run(
      event.createdAtMs ?? null, typeof payload.outcome === 'string' ? payload.outcome : 'terminal',
      typeof payload.actualCostMicroUsd === 'number' ? payload.actualCostMicroUsd : null,
      payload.known === true ? 1 : 0, event.taskId, event.epoch,
    );
  } else if (event.kind === 'transitioned') {
    const failure = payload.failure as Record<string, unknown> | undefined;
    const predecessor = payload.predecessor as Record<string, unknown> | undefined;
    const predecessorEpoch = typeof predecessor?.epoch === 'number' ? predecessor.epoch : event.epoch;
    tx.prepare(`UPDATE provider_attempt_projection SET transition_decision='transitioned', failure_class=?, failure_code=?, ended_at_ms=? WHERE task_id=? AND epoch=?`).run(
      typeof failure?.failureClass === 'string' ? failure.failureClass : null,
      typeof failure?.code === 'string' ? failure.code : null,
      event.createdAtMs ?? null, event.taskId, predecessorEpoch,
    );
    if (typeof payload.successorProviderId === 'string') {
      tx.prepare(`
        INSERT INTO provider_attempt_projection (task_id, epoch, attempt_id, provider_id, started_at_ms)
        VALUES (@taskId, @epoch, @attemptId, @providerId, @startedAtMs)
        ON CONFLICT(task_id, epoch) DO UPDATE SET attempt_id=excluded.attempt_id, provider_id=excluded.provider_id
      `).run({
        taskId: event.taskId, epoch: event.epoch, attemptId: event.attemptId,
        providerId: payload.successorProviderId, startedAtMs: event.createdAtMs ?? null,
      });
      tx.prepare(`UPDATE failover_task_projection SET active_attempt_id=?, active_epoch=? WHERE task_id=?`).run(
        event.attemptId, event.epoch, event.taskId,
      );
    }
  } else if (event.kind === 'cancel_requested') {
    tx.prepare(`UPDATE failover_task_projection SET cancellation_requested_at_ms=? WHERE task_id=?`).run(event.createdAtMs ?? null, event.taskId);
  } else if (event.kind === 'pre_dispatch_recovered') {
    tx.prepare(`UPDATE provider_attempt_projection SET terminal_outcome='orphaned', ended_at_ms=? WHERE task_id=? AND epoch=?`).run(event.createdAtMs ?? null, event.taskId, event.epoch);
  } else if (event.kind !== 'state_mutated' && event.kind !== 'provider_event') {
    throw new Error(`RESILIENCE_PROJECTION_FAILED: unsupported outbox kind ${event.kind}`);
  }
}

export function applyGatewayProjectionPage(events: unknown[], expectedCursor: number, pageCursor: number): number {
  ensureResilienceProjection();
  const current = cursorValue();
  if (current !== expectedCursor) throw new Error('RESILIENCE_PROJECTION_FAILED: cursor regression');
  const parsed = events.map(strictEvent);
  if (parsed.length === 0) {
    if (pageCursor !== current) throw new Error('RESILIENCE_PROJECTION_FAILED: outbox gap');
    return current;
  }
  for (let i = 0; i < parsed.length; i += 1) {
    if (parsed[i]!.outboxId !== current + i + 1) throw new Error('RESILIENCE_PROJECTION_FAILED: outbox gap or duplicate');
  }
  if (parsed[parsed.length - 1]!.outboxId !== pageCursor) throw new Error('RESILIENCE_PROJECTION_FAILED: page cursor mismatch');
  const transaction = db.transaction((rows: GatewayProjectionEvent[]) => {
    for (const event of rows) applyEvent(db, event);
    db.prepare(`UPDATE resilience_projection_cursor SET applied_outbox_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(pageCursor);
  });
  transaction(parsed);
  return pageCursor;
}

export async function reconcileGatewayProjection(
  fetchPage: (afterCursor: number, limit: number) => Promise<{ cursor: number; highWaterMark: number; events: unknown[] }>,
): Promise<number> {
  ensureResilienceProjection();
  let cursor = cursorValue();
  for (;;) {
    const page = await fetchPage(cursor, 256);
    if (!Number.isSafeInteger(page.cursor) || !Number.isSafeInteger(page.highWaterMark) || page.cursor < cursor || page.highWaterMark < page.cursor) throw new Error('RESILIENCE_PROJECTION_FAILED: invalid outbox cursor');
    if (page.events.length === 0) {
      if (page.highWaterMark !== cursor) throw new Error('RESILIENCE_PROJECTION_FAILED: outbox gap');
      return cursor;
    }
    cursor = applyGatewayProjectionPage(page.events, cursor, page.cursor);
    if (cursor >= page.highWaterMark) return cursor;
  }
}

export async function rebuildGatewayProjection(
  fetchPage: (afterCursor: number, limit: number) => Promise<{ cursor: number; highWaterMark: number; events: unknown[] }>,
): Promise<number> {
  ensureResilienceProjection();
  const transaction = db.transaction(() => {
    db.prepare(`DELETE FROM provider_attempt_projection`).run();
    db.prepare(`DELETE FROM failover_task_projection`).run();
    db.prepare(`UPDATE resilience_projection_cursor SET applied_outbox_id=0, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run();
  });
  transaction();
  return reconcileGatewayProjection(fetchPage);
}

export function recordFailoverAdmission(input: { taskId: string; planHash: string; chainId: string; featureRevision: string; activeAttemptId: string; activeEpoch: number; deadlineMs: number }): void {
  ensureResilienceProjection();
  db.prepare(`INSERT INTO failover_task_projection (task_id, plan_hash, chain_id, feature_revision, active_attempt_id, active_epoch, deadline_ms) VALUES (@taskId,@planHash,@chainId,@featureRevision,@activeAttemptId,@activeEpoch,@deadlineMs) ON CONFLICT(task_id) DO UPDATE SET active_attempt_id=excluded.active_attempt_id, active_epoch=excluded.active_epoch`).run(input);
}

export interface ProviderAttemptProjectionRow {
  task_id: string; epoch: number; attempt_id: string; provider_id: string; model_id: string | null;
  started_at_ms: number | null; ended_at_ms: number | null; failure_class: string | null; failure_code: string | null;
  dispatch_attempted: number; terminal_outcome: string | null; reserved_micro_usd: number | null;
  actual_micro_usd: number | null; cost_known: number | null; cost_source: string | null; transition_decision: string | null;
}

export function getProviderAttemptProjections(taskId: string): ProviderAttemptProjectionRow[] {
  ensureResilienceProjection();
  return db.prepare(`SELECT * FROM provider_attempt_projection WHERE task_id=? ORDER BY epoch ASC`).all(taskId) as ProviderAttemptProjectionRow[];
}

export function getFailoverProjection(taskId: string): Record<string, unknown> | null {
  ensureResilienceProjection();
  return (db.prepare(`SELECT * FROM failover_task_projection WHERE task_id=?`).get(taskId) as Record<string, unknown> | undefined) ?? null;
}
