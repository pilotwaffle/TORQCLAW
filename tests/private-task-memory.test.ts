import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComputeTier, type GatewayEvent } from '@torqclaw/contracts';
import { makeRequest } from './helpers.js';

process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-private-memory-'));
const { db } = await import('../packages/gateway/src/storage.js');
const { sessions } = await import('../packages/gateway/src/sessions.js');
const { dispatch } = await import('../packages/gateway/src/dispatch.js');
const { sessionBus } = await import('../packages/gateway/src/events.js');
const inference = await import('../packages/inference/dist/index.js');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function runPrivateTask(sensitive: boolean) {
  vi.stubEnv('TORQCLAW_PROVIDER_FAILOVER_ENABLED', 'false');
  const execute = vi.spyOn(inference, 'executeLocalEdge').mockResolvedValue({
    text: 'PRIVATE-RESULT-MARKER', telemetry: {},
  } as never);
  const req = { ...makeRequest({ containsSensitiveData: sensitive, executionMode: 'LOCAL_ONLY' }), id: randomUUID(), sessionId: randomUUID() };
  db.prepare("INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')").run(req.sessionId);
  const events: GatewayEvent[] = [];
  const unsubscribe = sessionBus.subscribe(req.sessionId, (event) => events.push(event));
  try {
    dispatch(req, { tier: ComputeTier.LOCAL_EDGE, reason: 'PRIVACY_OVERRIDE' } as never);
    await vi.waitFor(() => expect(events.some((event) => ['RESULT', 'ERROR', 'PENDING_APPROVAL'].includes(event.type))).toBe(true));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => ['RESULT', 'ERROR', 'PENDING_APPROVAL'].includes(event.type))).toHaveLength(1);
    const result = events.find((event) => event.type === 'RESULT');
    expect(result).toBeDefined();
    return { req, result: result! };
  } finally { unsubscribe(); }
}

it('private_task_stores_no_episode', async () => {
  const { req, result } = await runPrivateTask(true);
  expect.soft(db.prepare('SELECT COUNT(*) AS n FROM task_episodes WHERE request_id = ?').get(req.id)).toEqual({ n: 0 });
  expect.soft(db.prepare('SELECT COUNT(*) AS n FROM task_search WHERE task_search MATCH ?').get('"PRIVATE-RESULT-MARKER"')).toEqual({ n: 0 });
  expect.soft(result.metadata).toMatchObject({ sensitive: true });
  expect.soft(sessions.getContextWindow(req.sessionId, 'PRIVATE')).not.toContain('PRIVATE-RESULT-MARKER');
  expect(sessions.getContextWindow(req.sessionId, 'PRIVATE', { includeSensitive: true })).toContain('PRIVATE-RESULT-MARKER');
  const task = db.prepare('SELECT telemetry_json AS telemetry FROM tasks WHERE request_id = ?').get(req.id) as { telemetry: string };
  expect(JSON.parse(task.telemetry)).not.toHaveProperty('sensitive');
});

it('non_private_task_stores_episode_and_unmarked_result', async () => {
  const { req, result } = await runPrivateTask(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM task_episodes WHERE request_id = ?').get(req.id)).toEqual({ n: 1 });
  expect(result.metadata ?? {}).not.toHaveProperty('sensitive');
});
