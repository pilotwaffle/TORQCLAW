import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { GatewayRequestSchema, type GatewayRequest } from '@torqclaw/contracts';
import { runPersistedDiagnosticMigrationOnce } from './persistedError.js';

const DATA_DIR = process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw');

const here = dirname(fileURLToPath(import.meta.url));
const schemaText = readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8');
const RESILIENCE_BEGIN = '-- TORQCLAW_RESILIENCE_SCHEMA_BEGIN';
const RESILIENCE_END = '-- TORQCLAW_RESILIENCE_SCHEMA_END';
const resilienceStart = schemaText.indexOf(RESILIENCE_BEGIN);
const resilienceEnd = schemaText.indexOf(RESILIENCE_END);
if (resilienceStart < 0 || resilienceEnd < resilienceStart) throw new Error('gateway schema resilience markers are invalid');
const legacySchemaText = schemaText.slice(0, resilienceStart);
const resilienceSchemaText = schemaText.slice(resilienceStart, resilienceEnd + RESILIENCE_END.length);

/**
 * CROSS-CUTTING FINDING 9 — the module-level handle was a test-isolation
 * hazard, and this is the fix.
 *
 * WHAT WAS WRONG
 * --------------
 * `export const db = new Database(...)` opened the file as an import side
 * effect, reading TORQCLAW_DATA_DIR exactly once, at whichever moment the
 * module graph happened to pull this module in. Consequences:
 *
 *   - A test could only choose its data dir by setting the env var BEFORE
 *     the first transitive import of storage.ts. That ordering is not
 *     something a test file can actually guarantee, so suites resorted to
 *     top-of-file `process.env.TORQCLAW_DATA_DIR = mkdtempSync(...)`
 *     statements above their imports.
 *   - Once opened, the handle could never be re-pointed, so two test files
 *     in one worker shared one state.db and could see each other's rows.
 *     That is the suspected root of the transient parallel-suite flakes.
 *
 * THE FIX, AND ITS ONE HARD CONSTRAINT
 * ------------------------------------
 * Opening is now LAZY (first property access) and the resolved handle can
 * be dropped and re-resolved via `resetStateDbForTest()`.
 *
 * The hard constraint is that consumers do `import { db }` and then call
 * `db.prepare(...)` AT MODULE SCOPE (approvals.ts and receipts.ts both
 * do). So `db` must remain a stable, always-valid object reference even
 * though what it points at can change. A getter export cannot do that; a
 * Proxy can. Every property access forwards to the currently-resolved
 * handle, so existing call sites are untouched and production behaviour is
 * byte-identical -- the same file, the same pragmas, the same migrations,
 * in the same order. The only difference is WHEN the open happens, and in
 * production the first access is at boot either way.
 *
 * Methods are bound to the real handle because better-sqlite3 is a native
 * addon whose methods require their true receiver -- calling them with the
 * Proxy as `this` would throw.
 */
let handle: Database.Database | null = null;

function openStateDb(): Database.Database {
  const dir = process.env.TORQCLAW_DATA_DIR || DATA_DIR;
  mkdirSync(dir, { recursive: true });
  const opened = new Database(join(dir, 'state.db'));
  opened.pragma('journal_mode = WAL');
  opened.pragma('foreign_keys = ON');

  // Feature-off compatibility: resilience projection DDL is deferred until
  // the feature-on branch explicitly calls ensureResilienceProjection().
  opened.exec(isResilienceFlagOn() ? schemaText : legacySchemaText);

  // Idempotent migration: add tasks.telemetry_json on an existing dev DB
  // without the column (PRAGMA check, not a bare ALTER that throws on
  // second boot).
  const taskCols = opened.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  if (!taskCols.some((c) => c.name === 'telemetry_json')) {
    opened.exec(`ALTER TABLE tasks ADD COLUMN telemetry_json TEXT`);
  }

  // FIX-H: enforce the at-rest diagnostic boundary for historical rows once.
  // A versioned marker avoids an O(history) scan on every gateway boot. A
  // crash before the marker is written safely reruns the idempotent
  // migration.
  runPersistedDiagnosticMigrationOnce(opened);
  return opened;
}

function stateDb(): Database.Database {
  if (handle === null) handle = openStateDb();
  return handle;
}

/**
 * TEST-ONLY: drop the resolved handle so the next access re-opens against
 * the CURRENT TORQCLAW_DATA_DIR.
 *
 * Deliberately not called by any production path -- production opens once
 * at boot and keeps it for the process lifetime, exactly as before. Closing
 * is best-effort: a handle that is already closed, or busy, must not turn
 * test teardown into a failure.
 */
export function resetStateDbForTest(): void {
  const previous = handle;
  handle = null;
  try { previous?.close(); } catch { /* teardown must not throw */ }
}

export const db: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop, receiver) {
    const real = stateDb();
    const value = Reflect.get(real as object, prop, receiver);
    // Native better-sqlite3 methods need their real receiver.
    return typeof value === 'function' ? value.bind(real) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(stateDb() as object, prop, value);
  },
  has(_target, prop) { return Reflect.has(stateDb() as object, prop); },
  getPrototypeOf() { return Reflect.getPrototypeOf(stateDb() as object); },
  ownKeys() { return Reflect.ownKeys(stateDb() as object); },
  getOwnPropertyDescriptor(_target, prop) {
    const d = Reflect.getOwnPropertyDescriptor(stateDb() as object, prop);
    // A Proxy may only report a non-configurable descriptor if the target
    // actually has one; the target here is an empty object, so force
    // configurable to keep the invariant satisfied.
    return d ? { ...d, configurable: true } : undefined;
  },
});

export { DATA_DIR };

function isResilienceFlagOn(): boolean {
  return process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED?.toLowerCase() === 'true';
}

let initialProjectionReady = false;
let initialProjectionPromise: Promise<number> | null = null;
let initialProjectionKey = `${DATA_DIR}|${isResilienceFlagOn()}`;

function projectionEnvironmentKey(): string {
  return `${process.env.TORQCLAW_DATA_DIR || DATA_DIR}|${isResilienceFlagOn()}`;
}

/** Clear only the process-local admission cache. Durable projection state is
 * never deleted or rewritten by this reset. */
export function resetInitialResilienceProjection(): void {
  initialProjectionReady = false;
  initialProjectionPromise = null;
  initialProjectionKey = projectionEnvironmentKey();
}

export async function ensureInitialResilienceProjection(
  fetchPage: (afterCursor: number, limit: number) => Promise<{ cursor: number; highWaterMark: number; events: unknown[] }>,
): Promise<number> {
  const key = projectionEnvironmentKey();
  if (key !== initialProjectionKey) {
    resetInitialResilienceProjection();
  }
  if (initialProjectionReady) return cursorValue();
  if (initialProjectionPromise) return initialProjectionPromise;
  const pending = reconcileGatewayProjection(fetchPage);
  initialProjectionPromise = pending.then(
    (cursor) => {
      initialProjectionReady = true;
      initialProjectionPromise = null;
      return cursor;
    },
    (error) => {
      resetInitialResilienceProjection();
      throw error;
    },
  );
  return initialProjectionPromise;
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

// C0 principal bridge: sessions gains principal/surface identity so a resume
// can be authorized (SEC-1). Additive and idempotent -- `sessions` is created
// with IF NOT EXISTS, so an existing dev/production DB never re-runs the
// CREATE and would otherwise never see these columns. Both are nullable:
// sessions predating the bridge have no owner and must stay resumable.
{
  const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === 'principal_id')) db.exec(`ALTER TABLE sessions ADD COLUMN principal_id TEXT`);
  if (!columns.some((c) => c.name === 'surface_id')) db.exec(`ALTER TABLE sessions ADD COLUMN surface_id TEXT`);
}

export function ensureResilienceProjection(): void {
  const present = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='resilience_projection_cursor'`).get();
  if (!present) db.exec(resilienceSchemaText);
  const columns = db.prepare(`PRAGMA table_info(failover_task_projection)`).all() as { name: string }[];
  if (!columns.some((column) => column.name === 'immutable_plan_json')) db.exec(`ALTER TABLE failover_task_projection ADD COLUMN immutable_plan_json TEXT NOT NULL DEFAULT '{}'`);
  if (!columns.some((column) => column.name === 'provider_metadata_json')) db.exec(`ALTER TABLE failover_task_projection ADD COLUMN provider_metadata_json TEXT NOT NULL DEFAULT '{}'`);
  const attemptColumns = db.prepare(`PRAGMA table_info(provider_attempt_projection)`).all() as { name: string }[];
  if (!attemptColumns.some((column) => column.name === 'failure_source')) db.exec(`ALTER TABLE provider_attempt_projection ADD COLUMN failure_source TEXT`);
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

function costPayload(payload: Record<string, unknown>, kind: string): { actual: number | null; known: boolean; source: string | null } {
  const expected = kind === 'cost_recorded'
    ? ['actualCostMicroUsd', 'known']
    : ['outcome', 'actualCostMicroUsd', 'known'];
  const keys = Object.keys(payload).sort();
  const baseKeys = [...expected].sort();
  const extendedKeys = [...expected, 'source'].sort();
  if (JSON.stringify(keys) !== JSON.stringify(baseKeys) && JSON.stringify(keys) !== JSON.stringify(extendedKeys)) {
    throw new Error('RESILIENCE_PROJECTION_FAILED: cost payload shape is invalid');
  }
  if (typeof payload.known !== 'boolean') throw new Error('RESILIENCE_PROJECTION_FAILED: cost known flag is invalid');
  const actual = payload.actualCostMicroUsd;
  if (actual !== null && (!Number.isSafeInteger(actual) || (actual as number) < 0)) throw new Error('RESILIENCE_PROJECTION_FAILED: cost amount is invalid');
  if (!payload.known && actual !== null) throw new Error('RESILIENCE_PROJECTION_FAILED: unknown cost has an amount');
  const source = payload.source;
  if (source !== undefined && (typeof source !== 'string' || !['exact', 'account_delta', 'unavailable'].includes(source))) {
    throw new Error('RESILIENCE_PROJECTION_FAILED: cost source is invalid');
  }
  if (source !== undefined && !payload.known && source !== 'unavailable') {
    throw new Error('RESILIENCE_PROJECTION_FAILED: unknown cost source must be unavailable');
  }
  return { actual: actual as number | null, known: payload.known, source: (source as string | undefined) ?? null };
}

function applyEvent(tx: any, event: GatewayProjectionEvent): void {
  const payload = event.payload ?? {};
  if (event.kind === 'attempt_created') {
    if (typeof payload.providerId !== 'string') throw new Error('RESILIENCE_PROJECTION_FAILED: attempt provider missing');
    const admission = tx.prepare(`SELECT provider_metadata_json FROM failover_task_projection WHERE task_id=?`).get(event.taskId) as { provider_metadata_json?: string } | undefined;
    let metadata: { modelId?: string; reservedMicroUsd?: number } = {};
    try {
      const all = admission?.provider_metadata_json ? JSON.parse(admission.provider_metadata_json) as Record<string, { modelId?: string; reservedMicroUsd?: number }> : {};
      metadata = all[payload.providerId] ?? {};
    } catch {
      metadata = {};
    }
    tx.prepare(`
      INSERT INTO provider_attempt_projection (task_id, epoch, attempt_id, provider_id, model_id, started_at_ms, reserved_micro_usd)
      VALUES (@taskId, @epoch, @attemptId, @providerId, @modelId, @startedAtMs, @reservedMicroUsd)
      ON CONFLICT(task_id, epoch) DO UPDATE SET attempt_id=excluded.attempt_id, provider_id=excluded.provider_id,
        model_id=COALESCE(excluded.model_id, provider_attempt_projection.model_id),
        reserved_micro_usd=COALESCE(excluded.reserved_micro_usd, provider_attempt_projection.reserved_micro_usd)
    `).run({ taskId: event.taskId, epoch: event.epoch, attemptId: event.attemptId, providerId: payload.providerId, modelId: typeof payload.modelId === 'string' ? payload.modelId : metadata.modelId ?? null, reservedMicroUsd: typeof payload.reservedMicroUsd === 'number' ? payload.reservedMicroUsd : metadata.reservedMicroUsd ?? null, startedAtMs: event.createdAtMs ?? null });
  } else if (event.kind === 'dispatch_attempted') {
    tx.prepare(`UPDATE provider_attempt_projection SET dispatch_attempted=1 WHERE task_id=? AND epoch=?`).run(event.taskId, event.epoch);
  } else if (event.kind === 'cost_recorded') {
    const cost = costPayload(payload, event.kind);
    tx.prepare(`UPDATE provider_attempt_projection SET actual_micro_usd=?, cost_known=?, cost_source=? WHERE task_id=? AND epoch=?`).run(
      cost.actual, cost.known ? 1 : 0, cost.source ?? 'unavailable', event.taskId, event.epoch,
    );
  } else if (event.kind === 'attempt_completed') {
    const cost = costPayload(payload, event.kind);
    const outcome = typeof payload.outcome === 'string' ? payload.outcome : 'terminal';
    tx.prepare(`UPDATE provider_attempt_projection SET ended_at_ms=?, terminal_outcome=?, actual_micro_usd=?, cost_known=?, cost_source=COALESCE(?, provider_attempt_projection.cost_source, 'unavailable') WHERE task_id=? AND epoch=?`).run(
      event.createdAtMs ?? null, outcome,
      cost.actual, cost.known ? 1 : 0, cost.source ?? null, event.taskId, event.epoch,
    );
    tx.prepare(`UPDATE failover_task_projection SET terminal_outcome=?, final_provider_id=?, active_attempt_id=NULL, active_epoch=NULL WHERE task_id=?`).run(
      outcome,
      tx.prepare(`SELECT provider_id FROM provider_attempt_projection WHERE task_id=? AND epoch=?`).get(event.taskId, event.epoch)?.provider_id ?? null,
      event.taskId,
    );
    const taskState = outcome === 'completed' ? 'completed'
      : outcome === 'cancelled' || outcome === 'cancelled_uncertain' ? outcome : 'failed';
    tx.prepare(`UPDATE tasks SET state=?, finished_at=CURRENT_TIMESTAMP WHERE request_id=? AND state IN ('running','cancel_requested')`).run(taskState, event.taskId);
  } else if (event.kind === 'transitioned') {
    const failure = payload.failure as Record<string, unknown> | undefined;
    const predecessor = payload.predecessor as Record<string, unknown> | undefined;
    const predecessorEpoch = typeof predecessor?.epoch === 'number' ? predecessor.epoch : event.epoch;
    tx.prepare(`UPDATE provider_attempt_projection SET transition_decision='transitioned', failure_class=?, failure_code=?, failure_source=COALESCE(failure_source,'gateway'), ended_at_ms=?, cost_known=COALESCE(cost_known,0), cost_source=COALESCE(cost_source,'unavailable') WHERE task_id=? AND epoch=?`).run(
      typeof failure?.failureClass === 'string' ? failure.failureClass : null,
      typeof failure?.code === 'string' ? failure.code : null,
      event.createdAtMs ?? null, event.taskId, predecessorEpoch,
    );
    if (typeof payload.successorProviderId === 'string') {
      const admission = tx.prepare(`SELECT provider_metadata_json FROM failover_task_projection WHERE task_id=?`).get(event.taskId) as { provider_metadata_json?: string } | undefined;
      let metadata: { modelId?: string; reservedMicroUsd?: number } = {};
      try {
        const all = admission?.provider_metadata_json ? JSON.parse(admission.provider_metadata_json) as Record<string, { modelId?: string; reservedMicroUsd?: number }> : {};
        metadata = all[payload.successorProviderId] ?? {};
      } catch {
        metadata = {};
      }
      tx.prepare(`
        INSERT INTO provider_attempt_projection (task_id, epoch, attempt_id, provider_id, model_id, reserved_micro_usd, started_at_ms)
        VALUES (@taskId, @epoch, @attemptId, @providerId, @modelId, @reservedMicroUsd, @startedAtMs)
        ON CONFLICT(task_id, epoch) DO UPDATE SET attempt_id=excluded.attempt_id, provider_id=excluded.provider_id,
          model_id=COALESCE(excluded.model_id, provider_attempt_projection.model_id),
          reserved_micro_usd=COALESCE(excluded.reserved_micro_usd, provider_attempt_projection.reserved_micro_usd)
      `).run({
        taskId: event.taskId, epoch: event.epoch, attemptId: event.attemptId,
        providerId: payload.successorProviderId, modelId: metadata.modelId ?? null, reservedMicroUsd: metadata.reservedMicroUsd ?? null, startedAtMs: event.createdAtMs ?? null,
      });
      tx.prepare(`UPDATE failover_task_projection SET active_attempt_id=?, active_epoch=? WHERE task_id=?`).run(
        event.attemptId, event.epoch, event.taskId,
      );
    }
  } else if (event.kind === 'cancel_requested') {
    tx.prepare(`UPDATE failover_task_projection SET cancellation_requested_at_ms=? WHERE task_id=?`).run(event.createdAtMs ?? null, event.taskId);
  } else if (event.kind === 'pre_dispatch_recovered') {
    tx.prepare(`UPDATE provider_attempt_projection SET terminal_outcome='orphaned', transition_decision='recovered', failure_source='recovery', ended_at_ms=? WHERE task_id=? AND epoch=?`).run(event.createdAtMs ?? null, event.taskId, event.epoch);
  } else if (event.kind === 'state_mutated' && payload.state === 'cancel_requested') {
    tx.prepare(`UPDATE failover_task_projection SET cancellation_requested_at_ms=? WHERE task_id=?`).run(event.createdAtMs ?? null, event.taskId);
  } else if (event.kind === 'provider_event') {
    const normalized = payload.payload as Record<string, unknown> | undefined;
    const source = payload.source;
    if (normalized && typeof normalized.failureClass === 'string' && typeof normalized.code === 'string') {
      if (!['engine', 'gateway', 'recovery'].includes(String(source))) throw new Error('RESILIENCE_PROJECTION_FAILED: failure source is invalid');
      tx.prepare(`UPDATE provider_attempt_projection SET failure_class=?, failure_code=?, failure_source=? WHERE task_id=? AND epoch=?`).run(
        normalized.failureClass, normalized.code, source, event.taskId, event.epoch,
      );
    }
  } else if (event.kind !== 'state_mutated') {
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
  try {
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
  } catch (error) {
    resetInitialResilienceProjection();
    throw error;
  }
}

export async function rebuildGatewayProjection(
  fetchPage: (afterCursor: number, limit: number) => Promise<{ cursor: number; highWaterMark: number; events: unknown[] }>,
): Promise<number> {
  ensureResilienceProjection();
  const transaction = db.transaction(() => {
    db.prepare(`DELETE FROM provider_attempt_projection`).run();
    db.prepare(`UPDATE resilience_projection_cursor SET applied_outbox_id=0, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run();
  });
  transaction();
  return reconcileGatewayProjection(fetchPage);
}

export function recordFailoverAdmission(input: { taskId: string; planHash: string; chainId: string; featureRevision: string; activeAttemptId: string; activeEpoch: number; deadlineMs: number; immutablePlan: Record<string, unknown>; providerMetadata: Record<string, { modelId: string; reservedMicroUsd: number }> }): void {
  ensureResilienceProjection();
  db.prepare(`INSERT INTO failover_task_projection (task_id, plan_hash, chain_id, feature_revision, active_attempt_id, active_epoch, deadline_ms, immutable_plan_json, provider_metadata_json) VALUES (@taskId,@planHash,@chainId,@featureRevision,@activeAttemptId,@activeEpoch,@deadlineMs,@immutablePlanJson,@providerMetadataJson) ON CONFLICT(task_id) DO UPDATE SET active_attempt_id=excluded.active_attempt_id, active_epoch=excluded.active_epoch, immutable_plan_json=excluded.immutable_plan_json, provider_metadata_json=excluded.provider_metadata_json`).run({ ...input, immutablePlanJson: JSON.stringify(input.immutablePlan), providerMetadataJson: JSON.stringify(input.providerMetadata) });
  recordFailoverAttempt({ taskId: input.taskId, active: { taskId: input.taskId, attemptId: input.activeAttemptId, epoch: input.activeEpoch }, provider: { id: Object.keys(input.providerMetadata)[input.activeEpoch] ?? '', modelId: input.providerMetadata[Object.keys(input.providerMetadata)[input.activeEpoch] ?? '']?.modelId ?? '' }, reservedMicroUsd: input.providerMetadata[Object.keys(input.providerMetadata)[input.activeEpoch] ?? '']?.reservedMicroUsd ?? null });
}

export function recordFailoverAttempt(input: { taskId: string; active: { taskId: string; attemptId: string; epoch: number }; provider: { id: string; modelId: string }; reservedMicroUsd: number | null }): void {
  ensureResilienceProjection();
  db.prepare(`INSERT INTO provider_attempt_projection (task_id, epoch, attempt_id, provider_id, model_id, reserved_micro_usd) VALUES (@taskId,@epoch,@attemptId,@providerId,@modelId,@reservedMicroUsd) ON CONFLICT(task_id,epoch) DO UPDATE SET attempt_id=excluded.attempt_id, provider_id=excluded.provider_id, model_id=excluded.model_id, reserved_micro_usd=excluded.reserved_micro_usd`).run({ taskId: input.taskId, epoch: input.active.epoch, attemptId: input.active.attemptId, providerId: input.provider.id, modelId: input.provider.modelId, reservedMicroUsd: input.reservedMicroUsd });
}

export interface FailoverRecoveryCandidate {
  taskId: string;
  request: GatewayRequest;
  projection: Record<string, unknown>;
}

export function listFailoverRecoveryCandidates(): FailoverRecoveryCandidate[] {
  ensureResilienceProjection();
  const rows = db.prepare(`SELECT t.request_id, t.request_json, f.* FROM tasks t JOIN failover_task_projection f ON f.task_id=t.request_id WHERE t.state IN ('running','cancel_requested')`).all() as Array<{ request_id: string; request_json: string; [key: string]: unknown }>;
  const candidates: FailoverRecoveryCandidate[] = [];
  for (const row of rows) {
    try {
      const parsed = GatewayRequestSchema.safeParse(JSON.parse(row.request_json));
      if (parsed.success) candidates.push({ taskId: row.request_id, request: parsed.data, projection: row });
    } catch {
      // Invalid persisted candidates are ignored; the ledger remains authority.
    }
  }
  return candidates;
}

export interface ProviderAttemptProjectionRow {
  task_id: string; epoch: number; attempt_id: string; provider_id: string; model_id: string | null;
  started_at_ms: number | null; ended_at_ms: number | null; failure_class: string | null; failure_code: string | null; failure_source: string | null;
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
