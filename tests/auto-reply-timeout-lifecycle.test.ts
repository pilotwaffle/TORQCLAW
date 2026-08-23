import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRequest } from './helpers.js';

process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-autoreply-timeout-'));

const { db } = await import('../packages/gateway/src/storage.js');
const { taskStore } = await import('../packages/gateway/src/events.js');
const { safeMaterializeReceipt } = await import('../packages/gateway/src/receipts.js');
const { cancellations } = await import('../packages/gateway/src/cancellations.js');
const {
  runDispatchAndWait,
  setAutoReplyDispatchForTest,
} = await import('../packages/gateway/src/autoReplyDispatcher.js');

afterEach(() => {
  setAutoReplyDispatchForTest(null);
});

describe('agent autoreply timeout lifecycle', () => {
  it('aborts a slow local task and observes terminal state plus receipt before returning', async () => {
    const request = makeRequest({ taskType: 'SUMMARIZATION' });
    request.id = randomUUID();
    request.sessionId = randomUUID();
    request.payload.localExecutionTarget = {
      providerId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-ai-v5',
    };
    db.prepare(
      `INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'autoreply-timeout-test')`,
    ).run(request.sessionId);

    let abortObserved = false;
    setAutoReplyDispatchForTest((req, diag) => {
      taskStore.create(req, diag);
      const termination = cancellations.beginTerminationTracking(req.id);
      termination.signal.addEventListener('abort', () => {
        abortObserved = true;
        taskStore.fail(req.id, 'TEST_LOCAL_ABORTED', { cancelled: true });
        safeMaterializeReceipt(req.id);
        termination.complete(true);
      }, { once: true });
    });

    const row = await runDispatchAndWait(request, {
      tier: 'OLLAMA_LOCAL',
      reason: 'DEFAULT_LOCAL',
    } as any, {
      deadlineMs: 5,
      pollMs: 1,
      cancelTerminalMs: 100,
      receiptWaitMs: 100,
    });

    expect(abortObserved).toBe(true);
    expect(row?.state).toBe('failed');
    expect((db.prepare('SELECT state FROM tasks WHERE request_id = ?').get(request.id) as { state: string }).state)
      .toBe('failed');
    expect(db.prepare('SELECT 1 FROM run_receipts WHERE task_id = ?').get(request.id)).toBeDefined();
    cancellations.clear(request.id);
  });
});
