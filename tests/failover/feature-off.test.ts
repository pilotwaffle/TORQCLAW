import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root = '';
let storage: typeof import('../../packages/gateway/src/storage.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'torqclaw-feature-off-'));
  process.env.TORQCLAW_DATA_DIR = root;
  process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED = 'false';
  storage = await import('../../packages/gateway/src/storage.js');
});

afterAll(() => {
  storage.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('feature-off golden boundary', () => {
  it('does not create resilience projection tables during legacy DB initialization', () => {
    const rows = storage.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('resilience_projection_cursor','provider_attempt_projection','failover_task_projection')`).all();
    expect(rows).toEqual([]);
  });
});
