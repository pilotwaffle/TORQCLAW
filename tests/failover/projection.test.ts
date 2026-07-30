import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

let storage: typeof import('../../packages/gateway/src/storage.js');
let root = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'torqclaw-failover-'));
  process.env.TORQCLAW_DATA_DIR = root;
  process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED = 'true';
  storage = await import('../../packages/gateway/src/storage.js');
});

afterAll(() => {
  storage.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('rebuildable gateway projection', () => {
  it('applies contiguous pages transactionally and rejects gaps/regressions', () => {
    storage.ensureResilienceProjection();
    const page = [
      { outboxId: 1, taskId: 't', attemptId: 'a', epoch: 0, kind: 'attempt_created', createdAtMs: 1, payload: { providerId: 'p1', planHash: 'h'.repeat(64) } },
      { outboxId: 2, taskId: 't', attemptId: 'a', epoch: 0, kind: 'dispatch_attempted', createdAtMs: 2 },
      { outboxId: 3, taskId: 't', attemptId: 'a', epoch: 0, kind: 'attempt_completed', createdAtMs: 3, payload: { outcome: 'failed', actualCostMicroUsd: null, known: false } },
    ];
    expect(storage.applyGatewayProjectionPage(page, 0, 3)).toBe(3);
    expect(storage.getProviderAttemptProjections('t')[0]).toMatchObject({ dispatch_attempted: 1, terminal_outcome: 'failed' });
    expect(() => storage.applyGatewayProjectionPage([{ ...page[0], outboxId: 5 }], 3, 5)).toThrow(/gap/);
  });

  it('rebuilds from cursor zero and produces the same attempt projection', async () => {
    const events = [
      { outboxId: 1, taskId: 'rebuild', attemptId: 'a0', epoch: 0, kind: 'attempt_created', createdAtMs: 1, payload: { providerId: 'p1', planHash: 'h'.repeat(64) } },
      { outboxId: 2, taskId: 'rebuild', attemptId: 'a0', epoch: 0, kind: 'transitioned', createdAtMs: 2, payload: { failure: { failureClass: 'retryable', code: 'connection', retryable: true } } },
      { outboxId: 3, taskId: 'rebuild', attemptId: 'a1', epoch: 1, kind: 'attempt_created', createdAtMs: 3, payload: { providerId: 'p2', planHash: 'h'.repeat(64) } },
    ];
    await storage.rebuildGatewayProjection(async (cursor) => ({ cursor: 3, highWaterMark: 3, events: cursor === 0 ? events : [] }));
    expect(storage.getProviderAttemptProjections('rebuild').map((row) => [row.epoch, row.provider_id, row.transition_decision])).toEqual([[0, 'p1', 'transitioned'], [1, 'p2', null]]);
  });
});
