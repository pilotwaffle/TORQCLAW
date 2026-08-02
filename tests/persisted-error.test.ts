import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-persisted-error-'));

const { db } = await import('../packages/gateway/src/storage.js');
const { persistAndPublish, sessionBus, taskStore } = await import('../packages/gateway/src/events.js');
const { materializeReceipt, getReceipt } = await import('../packages/gateway/src/receipts.js');
const {
  PERSISTED_ERROR_MAX_CHARS,
  PERSISTED_ERROR_INPUT_MAX_CHARS,
  PERSISTED_ERROR_FAILURE_MARKER,
  PERSISTED_ERROR_SHAPES,
  PERSISTED_DIAGNOSTIC_MIGRATION_ID,
  runPersistedDiagnosticMigrationOnce,
  sanitizePersistedDiagnostics,
  sanitizePersistedError,
} = await import('../packages/gateway/src/persistedError.js');
const { SECRET_SHAPES } = await import('../packages/gateway/src/export.js');

function insertTask(error: string | null = null): { sessionId: string; taskId: string } {
  const sessionId = randomUUID();
  const taskId = randomUUID();
  db.prepare(`INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')`).run(
    sessionId,
  );
  db.prepare(
    `INSERT INTO tasks
       (request_id, session_id, tier, router_reason, state, request_json, error)
     VALUES (?, ?, 'API_EXTERNAL', 'TEST', 'running', '{}', ?)`,
  ).run(taskId, sessionId, error);
  return { sessionId, taskId };
}

describe('TCLAW-FIX-H persisted diagnostic boundary', () => {
  it('keeps the persistence pattern set in exact parity with safe export', () => {
    const shape = (entry: { label: string; re: RegExp }) => ({
      label: entry.label,
      source: entry.re.source,
      flags: entry.re.flags,
    });
    expect(PERSISTED_ERROR_SHAPES.map(shape)).toEqual(SECRET_SHAPES.map(shape));
  });

  it('scrubs recursively decoded errors before task or receipt persistence', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const nested = JSON.stringify({ provider: JSON.stringify({ detail: secret }) });
    const { taskId } = insertTask();

    taskStore.fail(taskId, nested, { costUsd: null });
    const task = db.prepare(`SELECT error FROM tasks WHERE request_id = ?`).get(taskId) as {
      error: string;
    };
    expect(task.error).not.toContain(secret);
    expect(task.error).toContain('[REDACTED:api-key]');

    materializeReceipt(taskId);
    const receipt = JSON.parse(getReceipt(taskId)!.full_receipt_json) as { error: string };
    expect(receipt.error).toBe(task.error);
    expect(receipt.error).not.toContain(secret);
  });

  it('scrubs before applying the persistence length cap', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const sanitized = sanitizePersistedError(`${'x'.repeat(1_990)} ${secret} trailing`);
    expect(sanitized.length).toBeLessThanOrEqual(PERSISTED_ERROR_MAX_CHARS);
    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain('[REDACT');
  });

  it('fails closed on deeply nested escaped JSON instead of returning encoded secret bytes', () => {
    const encodedSecret = '\\u0073\\u006b\\u002dFAKE00000000000000000000000000';
    const nested = `${'['.repeat(80)}"${encodedSecret}"${']'.repeat(80)}`;
    expect(sanitizePersistedError(nested)).toBe(PERSISTED_ERROR_FAILURE_MARKER);
  });

  it('scrubs a plain secret-shaped JSON property name', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const sanitized = sanitizePersistedError(JSON.stringify({ [secret]: 'detail' }));
    expect(sanitized).not.toContain(secret);
    expect(JSON.parse(sanitized)).toEqual({ '[REDACTED:api-key]': 'detail' });
  });

  it('fails closed when redacting a secret-shaped key would collide', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const raw = JSON.stringify({ [secret]: 'one', '[REDACTED:api-key]': 'two' });
    expect(sanitizePersistedError(raw)).toBe(PERSISTED_ERROR_FAILURE_MARKER);
  });

  it('scrubs a Unicode-escaped secret-shaped JSON property name after decoding', () => {
    const escapedKey = String.raw`\u0073\u006b\u002dFAKE00000000000000000000000000`;
    const sanitized = sanitizePersistedError(`{"${escapedKey}":"detail"}`);
    expect(sanitized).not.toContain(escapedKey);
    expect(JSON.parse(sanitized)).toEqual({ '[REDACTED:api-key]': 'detail' });
  });

  it('fails closed when a JSON key retains a second reversible escape layer', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const encoded = [...secret]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('');
    const attack = JSON.stringify({ [encoded]: 'detail' });
    expect(sanitizePersistedError(attack)).toBe(PERSISTED_ERROR_FAILURE_MARKER);
  });

  it('fails closed on JavaScript code-point escape syntax left in a JSON key', () => {
    for (const encoded of [
      String.raw`\u{73}k-FAKE00000000000000000000000000`,
      String.raw`\u{00000073}k-FAKE00000000000000000000000000`,
    ]) {
      expect(sanitizePersistedError(JSON.stringify({ [encoded]: 'detail' }))).toBe(
        PERSISTED_ERROR_FAILURE_MARKER,
      );
    }
  });

  it('fails closed on malformed JSON containing a reversible Unicode-escaped secret key', () => {
    const escapedKey = String.raw`\u0073\u006b\u002dFAKE00000000000000000000000000`;
    const truncated = `{"${escapedKey}":"detail"`;
    expect(sanitizePersistedError(truncated)).toBe(PERSISTED_ERROR_FAILURE_MARKER);
  });

  it('fails closed before parsing an oversized diagnostic', () => {
    const oversized = `prefix ${'x'.repeat(PERSISTED_ERROR_INPUT_MAX_CHARS)} sk-FAKE00000000000000000000000000`;
    expect(sanitizePersistedError(oversized)).toBe(PERSISTED_ERROR_FAILURE_MARKER);
  });

  it('uses the same boundary for persisted and live ERROR events', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const { sessionId, taskId } = insertTask();
    const frames: Array<{ message: string }> = [];
    const unsubscribe = sessionBus.subscribe(sessionId, (event) => frames.push(event));
    const eventId = randomUUID();

    persistAndPublish({
      id: eventId,
      sessionId,
      requestId: taskId,
      tier: null,
      type: 'ERROR',
      message: `provider leaked ${secret} at C:\\Users\\operator\\secrets.txt`,
      timestamp: new Date().toISOString(),
    });
    unsubscribe();

    const stored = db.prepare(`SELECT message FROM events WHERE id = ?`).get(eventId) as {
      message: string;
    };
    expect(stored.message).not.toContain(secret);
    expect(stored.message).toContain('[REDACTED:api-key]');
    expect(stored.message).toContain('[REDACTED:path]');
    expect(frames).toHaveLength(1);
    expect(frames[0].message).toBe(stored.message);
  });

  it('fails nested-escaped keys closed across task, stored event, and live event boundaries', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const encoded = [...secret]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('');
    const attack = JSON.stringify({ [encoded]: 'detail' });
    const { sessionId, taskId } = insertTask();
    taskStore.fail(taskId, attack);

    const frames: Array<{ message: string }> = [];
    const unsubscribe = sessionBus.subscribe(sessionId, (event) => frames.push(event));
    const eventId = randomUUID();
    persistAndPublish({
      id: eventId,
      sessionId,
      requestId: taskId,
      tier: null,
      type: 'ERROR',
      message: attack,
      timestamp: new Date().toISOString(),
    });
    unsubscribe();

    expect((db.prepare(`SELECT error FROM tasks WHERE request_id = ?`).get(taskId) as {
      error: string;
    }).error).toBe(PERSISTED_ERROR_FAILURE_MARKER);
    expect((db.prepare(`SELECT message FROM events WHERE id = ?`).get(eventId) as {
      message: string;
    }).message).toBe(PERSISTED_ERROR_FAILURE_MARKER);
    expect(frames[0].message).toBe(PERSISTED_ERROR_FAILURE_MARKER);
  });

  it('fails a leading-zero code-point key closed across task and event boundaries', () => {
    const encoded = String.raw`\u{00000073}k-FAKE00000000000000000000000000`;
    const attack = JSON.stringify({ [encoded]: 'detail' });
    const { sessionId, taskId } = insertTask();
    taskStore.fail(taskId, attack);
    const frames: Array<{ message: string }> = [];
    const unsubscribe = sessionBus.subscribe(sessionId, (event) => frames.push(event));
    const eventId = randomUUID();
    persistAndPublish({
      id: eventId,
      sessionId,
      requestId: taskId,
      tier: null,
      type: 'ERROR',
      message: attack,
      timestamp: new Date().toISOString(),
    });
    unsubscribe();

    expect((db.prepare(`SELECT error FROM tasks WHERE request_id = ?`).get(taskId) as {
      error: string;
    }).error).toBe(PERSISTED_ERROR_FAILURE_MARKER);
    expect((db.prepare(`SELECT message FROM events WHERE id = ?`).get(eventId) as {
      message: string;
    }).message).toBe(PERSISTED_ERROR_FAILURE_MARKER);
    expect(frames[0].message).toBe(PERSISTED_ERROR_FAILURE_MARKER);
  });

  it('handles the maximum slash-only input in linear time', () => {
    const slashOnly = '\\'.repeat(PERSISTED_ERROR_INPUT_MAX_CHARS);
    const started = performance.now();
    sanitizePersistedError(slashOnly);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('migrates historical task, ERROR event, and receipt errors idempotently', () => {
    const secret = 'ghp_FAKE0000000000000000000000';
    const { sessionId, taskId } = insertTask(`provider leaked ${secret}`);
    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO events (id, session_id, request_id, tier, type, message)
       VALUES (?, ?, ?, NULL, 'ERROR', ?)`,
    ).run(eventId, sessionId, taskId, `event leaked ${secret}`);
    db.prepare(
      `INSERT INTO run_receipts
         (id, task_id, session_id, full_receipt_json, projection_version)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(randomUUID(), taskId, sessionId, JSON.stringify({ taskId, error: secret }));

    expect(sanitizePersistedDiagnostics(db)).toEqual({
      tasksUpdated: 1,
      eventsUpdated: 1,
      receiptsUpdated: 1,
      malformedReceiptsQuarantined: 0,
    });

    const task = db.prepare(`SELECT error FROM tasks WHERE request_id = ?`).get(taskId) as {
      error: string;
    };
    const receipt = JSON.parse(getReceipt(taskId)!.full_receipt_json) as { error: string };
    const event = db.prepare(`SELECT message FROM events WHERE id = ?`).get(eventId) as {
      message: string;
    };
    expect(task.error).toBe('provider leaked [REDACTED:github-token]');
    expect(event.message).toBe('event leaked [REDACTED:github-token]');
    expect(receipt.error).toBe('[REDACTED:github-token]');
    expect(sanitizePersistedDiagnostics(db)).toEqual({
      tasksUpdated: 0,
      eventsUpdated: 0,
      receiptsUpdated: 0,
      malformedReceiptsQuarantined: 0,
    });
  });

  it('migrates nested-escaped key attacks across all historical diagnostic copies', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const encoded = [...secret]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('');
    const attack = JSON.stringify({ [encoded]: 'detail' });
    const { sessionId, taskId } = insertTask(attack);
    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO events (id, session_id, request_id, tier, type, message)
       VALUES (?, ?, ?, NULL, 'ERROR', ?)`,
    ).run(eventId, sessionId, taskId, attack);
    db.prepare(
      `INSERT INTO run_receipts
         (id, task_id, session_id, full_receipt_json, projection_version)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(randomUUID(), taskId, sessionId, JSON.stringify({ taskId, error: attack }));

    expect(sanitizePersistedDiagnostics(db)).toEqual({
      tasksUpdated: 1,
      eventsUpdated: 1,
      receiptsUpdated: 1,
      malformedReceiptsQuarantined: 0,
    });
    expect((db.prepare(`SELECT error FROM tasks WHERE request_id = ?`).get(taskId) as {
      error: string;
    }).error).toBe(PERSISTED_ERROR_FAILURE_MARKER);
    expect((db.prepare(`SELECT message FROM events WHERE id = ?`).get(eventId) as {
      message: string;
    }).message).toBe(PERSISTED_ERROR_FAILURE_MARKER);
    expect(JSON.parse(getReceipt(taskId)!.full_receipt_json).error).toBe(
      PERSISTED_ERROR_FAILURE_MARKER,
    );
  });

  it('canonicalizes duplicate receipt error members so shadowed secrets leave storage', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const cases = [
      { finalJson: 'null', expected: null },
      { finalJson: '"benign"', expected: 'benign' },
    ];
    const taskIds: string[] = [];
    for (const testCase of cases) {
      const { sessionId, taskId } = insertTask();
      taskIds.push(taskId);
      const duplicateJson =
        `{"taskId":"${taskId}","error":"${secret}","error":${testCase.finalJson}}`;
      db.prepare(
        `INSERT INTO run_receipts
           (id, task_id, session_id, full_receipt_json, projection_version)
         VALUES (?, ?, ?, ?, 1)`,
      ).run(randomUUID(), taskId, sessionId, duplicateJson);
    }

    expect(sanitizePersistedDiagnostics(db).receiptsUpdated).toBe(2);
    for (let index = 0; index < taskIds.length; index += 1) {
      const stored = getReceipt(taskIds[index]!)!.full_receipt_json;
      expect(stored).not.toContain(secret);
      expect(JSON.parse(stored).error).toBe(cases[index]!.expected);
      expect((stored.match(/"error":/g) ?? [])).toHaveLength(1);
    }
  });

  it('processes more than one migration batch without skipping rows', () => {
    const sessionId = randomUUID();
    const secret = 'sk-FAKE00000000000000000000000000';
    db.prepare(`INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')`).run(
      sessionId,
    );
    const insert = db.prepare(
      `INSERT INTO tasks
         (request_id, session_id, tier, router_reason, state, request_json, error)
       VALUES (?, ?, 'API_EXTERNAL', 'TEST', 'failed', '{}', ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 300; index += 1) {
        insert.run(randomUUID(), sessionId, `batch ${index}: ${secret}`);
      }
    })();

    const result = sanitizePersistedDiagnostics(db);
    expect(result.tasksUpdated).toBe(300);
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM tasks WHERE session_id = ? AND error LIKE '%sk-FAKE%'`,
    ).get(sessionId) as { count: number }).count).toBe(0);
  });

  it('quarantines malformed derived receipt blobs for a safe rebuild', () => {
    const { sessionId, taskId } = insertTask();
    db.prepare(
      `INSERT INTO run_receipts
         (id, task_id, session_id, full_receipt_json, projection_version)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(randomUUID(), taskId, sessionId, '{malformed-secret-bearing-json');

    expect(sanitizePersistedDiagnostics(db).malformedReceiptsQuarantined).toBe(1);
    const row = getReceipt(taskId)!;
    expect(row.projection_version).toBe(0);
    expect(row.full_receipt_json).not.toContain('malformed-secret-bearing-json');
    expect(JSON.parse(row.full_receipt_json)).toEqual({
      taskId,
      receiptUnavailable: {
        reason: 'malformed_cache_quarantined',
        rebuildRequired: true,
      },
      error: '[REDACTED:malformed-receipt-cache]',
    });
  });

  it('quarantines a receipt whose error field violates the string-or-null schema', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const { sessionId, taskId } = insertTask();
    db.prepare(
      `INSERT INTO run_receipts
         (id, task_id, session_id, full_receipt_json, projection_version)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(
      randomUUID(),
      taskId,
      sessionId,
      JSON.stringify({ taskId, error: { message: `provider leaked ${secret}` } }),
    );

    expect(sanitizePersistedDiagnostics(db).malformedReceiptsQuarantined).toBe(1);
    const row = getReceipt(taskId)!;
    expect(row.projection_version).toBe(0);
    expect(row.full_receipt_json).not.toContain(secret);
  });

  it('quarantines a valid but over-deep receipt without aborting migration', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const { sessionId, taskId } = insertTask();
    const deepReceipt =
      `{"taskId":"${taskId}","error":"${secret}","deep":` +
      '['.repeat(5_000) + '"leaf"' + ']'.repeat(5_000) + '}';
    db.prepare(
      `INSERT INTO run_receipts
         (id, task_id, session_id, full_receipt_json, projection_version)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(randomUUID(), taskId, sessionId, deepReceipt);

    expect(sanitizePersistedDiagnostics(db).malformedReceiptsQuarantined).toBe(1);
    const row = getReceipt(taskId)!;
    expect(row.projection_version).toBe(0);
    expect(row.full_receipt_json).not.toContain(secret);
    expect(JSON.parse(row.full_receipt_json).receiptUnavailable.rebuildRequired).toBe(true);
  });

  it('quarantines an oversized receipt before parsing it in a startup transaction', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const { sessionId, taskId } = insertTask();
    const oversized = JSON.stringify({
      taskId,
      error: secret,
      padding: 'x'.repeat(PERSISTED_ERROR_INPUT_MAX_CHARS),
    });
    db.prepare(
      `INSERT INTO run_receipts
         (id, task_id, session_id, full_receipt_json, projection_version)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(randomUUID(), taskId, sessionId, oversized);

    expect(sanitizePersistedDiagnostics(db).malformedReceiptsQuarantined).toBe(1);
    const row = getReceipt(taskId)!;
    expect(row.projection_version).toBe(0);
    expect(row.full_receipt_json.length).toBeLessThan(PERSISTED_ERROR_INPUT_MAX_CHARS);
    expect(row.full_receipt_json).not.toContain(secret);
  });

  it('quarantines an under-size receipt that exceeds the independent node budget', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const { sessionId, taskId } = insertTask();
    const tooManyNodes = JSON.stringify({
      taskId,
      error: secret,
      values: Array.from({ length: 10_001 }, () => 0),
    });
    expect(tooManyNodes.length).toBeLessThan(PERSISTED_ERROR_INPUT_MAX_CHARS);
    db.prepare(
      `INSERT INTO run_receipts
         (id, task_id, session_id, full_receipt_json, projection_version)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(randomUUID(), taskId, sessionId, tooManyNodes);

    expect(sanitizePersistedDiagnostics(db).malformedReceiptsQuarantined).toBe(1);
    const row = getReceipt(taskId)!;
    expect(row.projection_version).toBe(0);
    expect(row.full_receipt_json).not.toContain(secret);
  });

  it('does not record the one-time marker when migration fails', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE tasks (request_id TEXT PRIMARY KEY, error TEXT);
      CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT, message TEXT);
      CREATE TABLE run_receipts (
        task_id TEXT PRIMARY KEY,
        full_receipt_json TEXT,
        projection_version INTEGER,
        updated_at TEXT
      );
      INSERT INTO tasks VALUES ('task-1', 'sk-FAKE00000000000000000000000000');
      CREATE TRIGGER reject_task_migration BEFORE UPDATE ON tasks
      BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;
    `);

    expect(() => runPersistedDiagnosticMigrationOnce(database)).toThrow('forced migration failure');
    expect((database.prepare(
      `SELECT COUNT(*) AS count FROM gateway_migrations WHERE id = ?`,
    ).get(PERSISTED_DIAGNOSTIC_MIGRATION_ID) as { count: number }).count).toBe(0);

    database.exec(`DROP TRIGGER reject_task_migration`);
    const retried = runPersistedDiagnosticMigrationOnce(database);
    expect(retried.applied).toBe(true);
    expect((database.prepare(`SELECT error FROM tasks WHERE request_id = 'task-1'`).get() as {
      error: string;
    }).error).toBe('[REDACTED:api-key]');
    expect((database.prepare(
      `SELECT COUNT(*) AS count FROM gateway_migrations WHERE id = ?`,
    ).get(PERSISTED_DIAGNOSTIC_MIGRATION_ID) as { count: number }).count).toBe(1);
    expect(runPersistedDiagnosticMigrationOnce(database)).toEqual({ applied: false, result: null });
    database.close();
  });

  it('records the one-time startup migration marker', () => {
    expect(db.prepare(
      `SELECT id FROM gateway_migrations WHERE id = ?`,
    ).get(PERSISTED_DIAGNOSTIC_MIGRATION_ID)).toEqual({ id: PERSISTED_DIAGNOSTIC_MIGRATION_ID });
    expect(runPersistedDiagnosticMigrationOnce(db)).toEqual({ applied: false, result: null });
  });
});
