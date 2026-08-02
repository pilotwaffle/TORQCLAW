import type Database from 'better-sqlite3';
import {
  KNOWN_SECRET_FAILURE_MARKER,
  KNOWN_SECRET_INPUT_MAX_CHARS,
  KNOWN_SECRET_MAX_DEPTH,
  KNOWN_SECRET_MAX_NODES,
  KNOWN_SECRET_SHAPES,
  assertBoundedJsonValue,
  redactKnownSecretText,
} from './knownSecretShapes.js';

export const PERSISTED_ERROR_MAX_CHARS = 2_000;
export const PERSISTED_ERROR_INPUT_MAX_CHARS = KNOWN_SECRET_INPUT_MAX_CHARS;
export const PERSISTED_ERROR_MAX_DEPTH = KNOWN_SECRET_MAX_DEPTH;
export const PERSISTED_ERROR_MAX_NODES = KNOWN_SECRET_MAX_NODES;
export const PERSISTED_ERROR_FAILURE_MARKER = KNOWN_SECRET_FAILURE_MARKER;
export const PERSISTED_DIAGNOSTIC_MIGRATION_ID = '2026-08-01-persisted-error-v2';

/**
 * Persistence has a stricter threat model than the live console: provider and
 * tool errors are untrusted and can contain credentials or local paths. Keep
 * this list aligned with the safe-export redactor; the parity test makes drift
 * fail CI instead of silently weakening the at-rest boundary.
 */
export const PERSISTED_ERROR_SHAPES = KNOWN_SECRET_SHAPES;

/**
 * Scrub first and cap second so truncation cannot create an unmatched secret
 * prefix. Parsed diagnostics that exceed traversal limits fail closed to one
 * fixed marker; they never fall back to reversible encoded bytes.
 */
export function sanitizePersistedError(error: string): string {
  return redactKnownSecretText(error).slice(0, PERSISTED_ERROR_MAX_CHARS);
}

export interface PersistedDiagnosticMigrationResult {
  tasksUpdated: number;
  eventsUpdated: number;
  receiptsUpdated: number;
  malformedReceiptsQuarantined: number;
}

/**
 * Idempotent startup migration for rows written before the persistence fence.
 * Rows are selected and conditionally updated inside bounded IMMEDIATE
 * transactions. The old value in each UPDATE prevents a stale batch from
 * overwriting a newer value written by another connection between batches.
 * Malformed derived receipts are replaced with a non-secret quarantine marker
 * and projection_version=0 so the receipt rebuild command can restore them.
 */
export function sanitizePersistedDiagnostics(
  database: Database.Database,
): PersistedDiagnosticMigrationResult {
  const batchSize = 250;
  const selectTasks = database.prepare(
    `SELECT rowid AS cursor, request_id, error
       FROM tasks
      WHERE rowid > ? AND error IS NOT NULL
      ORDER BY rowid ASC LIMIT ?`,
  );
  const selectEvents = database.prepare(
    `SELECT seq AS cursor, seq, message
       FROM events
      WHERE seq > ? AND type = 'ERROR'
      ORDER BY seq ASC LIMIT ?`,
  );
  const selectReceipts = database.prepare(
    `SELECT rowid AS cursor, task_id, full_receipt_json
       FROM run_receipts
      WHERE rowid > ? AND full_receipt_json IS NOT NULL
      ORDER BY rowid ASC LIMIT ?`,
  );

  const updateTask = database.prepare(
    `UPDATE tasks SET error = ? WHERE request_id = ? AND error = ?`,
  );
  const updateEvent = database.prepare(
    `UPDATE events SET message = ? WHERE seq = ? AND message = ?`,
  );
  const updateReceipt = database.prepare(
    `UPDATE run_receipts
        SET full_receipt_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND full_receipt_json = ?`,
  );
  const quarantineReceipt = database.prepare(
    `UPDATE run_receipts
        SET full_receipt_json = ?, projection_version = 0, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND full_receipt_json = ?`,
  );

  const result: PersistedDiagnosticMigrationResult = {
    tasksUpdated: 0,
    eventsUpdated: 0,
    receiptsUpdated: 0,
    malformedReceiptsQuarantined: 0,
  };

  function requireSingleChange(changes: number, surface: string): number {
    if (changes !== 1) {
      throw new Error(`persisted diagnostic migration conflict on ${surface}`);
    }
    return changes;
  }

  function runBatches<T extends { cursor: number }>(
    select: Database.Statement<[number, number]>,
    visit: (row: T) => void,
  ): void {
    let cursor = 0;
    while (true) {
      const rows = database.transaction(() => {
        const batch = select.all(cursor, batchSize) as T[];
        for (const row of batch) visit(row);
        return batch;
      }).immediate();
      if (rows.length === 0) return;
      cursor = rows[rows.length - 1]!.cursor;
    }
  }

  runBatches<{ cursor: number; request_id: string; error: string }>(selectTasks, (row) => {
    const sanitized = sanitizePersistedError(row.error);
    if (sanitized !== row.error) {
      result.tasksUpdated += requireSingleChange(
        updateTask.run(sanitized, row.request_id, row.error).changes,
        `task ${row.request_id}`,
      );
    }
  });

  runBatches<{ cursor: number; seq: number; message: string }>(selectEvents, (row) => {
    const sanitized = sanitizePersistedError(row.message);
    if (sanitized !== row.message) {
      result.eventsUpdated += requireSingleChange(
        updateEvent.run(sanitized, row.seq, row.message).changes,
        `event ${row.seq}`,
      );
    }
  });

  runBatches<{ cursor: number; task_id: string; full_receipt_json: string }>(
    selectReceipts,
    (row) => {
      let nextReceipt: string | null = null;
      let quarantine = false;
      try {
        if (row.full_receipt_json.length > PERSISTED_ERROR_INPUT_MAX_CHARS) {
          throw new Error('receipt cache exceeds migration input limit');
        }
        const parsed = JSON.parse(row.full_receipt_json) as unknown;
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
          throw new Error('receipt cache is not an object');
        }
        assertBoundedJsonValue(parsed);
        const receipt = parsed as Record<string, unknown>;
        if (
          receipt.error !== undefined &&
          receipt.error !== null &&
          typeof receipt.error !== 'string'
        ) {
          throw new Error('receipt cache error is not a string or null');
        }
        let canonicalReceipt = receipt;
        if (typeof receipt.error === 'string') {
          const sanitized = sanitizePersistedError(receipt.error);
          if (sanitized !== receipt.error) {
            canonicalReceipt = { ...receipt, error: sanitized };
          }
        }
        // Canonicalize every valid legacy receipt, even when its parsed error
        // is already benign. JSON permits duplicate object members; parsing
        // keeps only the last value, while earlier secret-bearing bytes would
        // otherwise remain in the DB/backups forever.
        const canonicalJson = JSON.stringify(canonicalReceipt);
        if (canonicalJson !== row.full_receipt_json) nextReceipt = canonicalJson;
      } catch {
        quarantine = true;
      }

      if (quarantine) {
        const marker = JSON.stringify({
          taskId: row.task_id,
          receiptUnavailable: {
            reason: 'malformed_cache_quarantined',
            rebuildRequired: true,
          },
          error: '[REDACTED:malformed-receipt-cache]',
        });
        result.malformedReceiptsQuarantined += requireSingleChange(
          quarantineReceipt.run(marker, row.task_id, row.full_receipt_json).changes,
          `receipt ${row.task_id}`,
        );
        return;
      }

      if (nextReceipt !== null) {
        result.receiptsUpdated += requireSingleChange(
          updateReceipt.run(nextReceipt, row.task_id, row.full_receipt_json).changes,
          `receipt ${row.task_id}`,
        );
      }
    },
  );

  return result;
}

export interface PersistedDiagnosticMigrationRun {
  applied: boolean;
  result: PersistedDiagnosticMigrationResult | null;
}

/** Production one-time wrapper. The marker is written only after every batch
 *  succeeds; a conflict or DB failure throws and leaves the migration pending
 *  for a clean retry on the next startup. */
export function runPersistedDiagnosticMigrationOnce(
  database: Database.Database,
): PersistedDiagnosticMigrationRun {
  database.exec(`
    CREATE TABLE IF NOT EXISTS gateway_migrations (
      id TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = database.prepare(
    `SELECT 1 FROM gateway_migrations WHERE id = ?`,
  ).get(PERSISTED_DIAGNOSTIC_MIGRATION_ID);
  if (applied) return { applied: false, result: null };

  const result = sanitizePersistedDiagnostics(database);
  // A racing current-version gateway may have completed the same idempotent
  // migration first. Either way, this marker is reached only after success.
  database.prepare(`INSERT OR IGNORE INTO gateway_migrations (id) VALUES (?)`).run(
    PERSISTED_DIAGNOSTIC_MIGRATION_ID,
  );
  return { applied: true, result };
}
