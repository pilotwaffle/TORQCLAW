import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ComputeTier, type GatewayEvent } from '@torqclaw/contracts';
import { getStatus, pollObservations, ResilienceEnvelopeError, type ResilienceClient } from '../packages/bridge/src/hermesAttempt.js';
import { pythonRuntime } from '../ops/python-runtime.mjs';
import { makeRequest } from './helpers.js';

vi.mock('../packages/gateway/src/failover.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/gateway/src/failover.js')>();
  return { ...actual, runFailoverTask: vi.fn().mockImplementation(async () => {
    throw new actual.FailoverTerminalError(
      { failureClass: 'terminal', code: 'approval_blocked', retryable: false },
      true, 'failed', { failover: true, blockedOn: 'write_file' },
    );
  }) };
});

const root = mkdtempSync(join(tmpdir(), 'torq-blocked-tool-'));
process.env.TORQCLAW_DATA_DIR = root;
const { db } = await import('../packages/gateway/src/storage.js');
const { taskStore, sessionBus } = await import('../packages/gateway/src/events.js');
const { dispatch } = await import('../packages/gateway/src/dispatch.js');
const mockedFailover = await import('../packages/gateway/src/failover.js');
const actualFailover = await vi.importActual<typeof import('../packages/gateway/src/failover.js')>('../packages/gateway/src/failover.js');

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function request() {
  const req = {
    ...makeRequest({ executionMode: 'CLOUD_OK', taskType: 'COMPLEX_CODING' }),
    id: randomUUID(), sessionId: randomUUID(),
  };
  db.prepare("INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')").run(req.sessionId);
  return req;
}

const document = {
  revision: 'rev-1',
  chains: { coding: { id: 'coding', providers: [
    { id: 'primary', label: 'Primary', modelId: 'model-a', apiKeyEnvName: 'KEY_A', baseUrlEnvName: 'BASE_A', privacyClasses: ['standard'], ceilingMicroUsd: 10 },
    { id: 'fallback', label: 'Fallback', modelId: 'model-b', apiKeyEnvName: 'KEY_B', baseUrlEnvName: 'BASE_B', privacyClasses: ['standard'], ceilingMicroUsd: 10 },
  ] } },
};

it('failover_blocked_tool_terminal_error_carries_blockedOn', async () => {
  vi.stubEnv('TORQCLAW_PROVIDER_FAILOVER_ENABLED', 'true');
  vi.stubEnv('TORQCLAW_FAILOVER_CODING_CHAIN', 'coding');
  const req = request();
  taskStore.create(req, { tier: ComputeTier.FRONTIER, reason: 'USER_CLOUD_OK' } as never);
  const python = pythonRuntime(process.cwd());
  const calls: Array<{ name: string; arguments: any }> = [];
  const client: ResilienceClient = {
    async callTool(call) {
      calls.push(call);
      const script = String.raw`
import asyncio, json, sys
from mcp_wrapper import server, task_store
c = json.loads(sys.argv[1])
if c["name"] == "resilience_finalize_attempt":
    a = c["arguments"]
    task_store.create({"payload": {"prompt": "stubbed blocked attempt"}}, task_id=a["active"]["attemptId"])
    task_store.fail(a["active"]["attemptId"], "normalized_failure", {
        "normalizedFailure": a["normalized_failure"],
        "costUsd": 0.0, "costSource": "exact",
    })
r = asyncio.run(getattr(server, c["name"])(**c["arguments"]))
print("S1_RESULT=" + json.dumps(r))
`;
      const run = spawnSync(python.command, [...python.argsPrefix, '-c', script, JSON.stringify(call)], {
        cwd: python.cwd, env: { ...process.env, TORQCLAW_DATA_DIR: root, TORQCLAW_PROVIDER_FAILOVER_ENABLED: '1' },
        encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      if (run.status !== 0) throw new Error(run.stderr || run.stdout);
      const line = run.stdout.split(/\r?\n/).find((value) => value.startsWith('S1_RESULT='));
      if (!line) throw new Error('Missing Python ledger response');
      return { content: [{ type: 'text', text: line.slice('S1_RESULT='.length) }] };
    },
  };
  const attempt = vi.fn(async () => ({
    text: '', telemetry: { blockedOn: 'write_file' }, dispatchAttempted: true,
    observation: { kind: 'failure' as const, dispatchAttempted: true, failureSource: 'engine' as const,
      failure: { failureClass: 'terminal' as const, code: 'approval_blocked', retryable: false as const },
      telemetry: { blockedOn: 'write_file' } },
  }));
  let error: unknown;
  try {
    await actualFailover.runFailoverTask(req, { tier: ComputeTier.FRONTIER, reason: 'USER_CLOUD_OK' } as never, {
      document, nowMs: Date.now(),
      env: { TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '120000', TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '60000' },
      client, emit: () => undefined, bridge: { executeHermesAttempt: attempt },
    });
  } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(actualFailover.FailoverTerminalError);
  expect(error).toMatchObject({ failure: { code: 'approval_blocked' }, terminalOutcome: 'failed' });
  expect.soft(error).toMatchObject({ telemetry: { blockedOn: 'write_file' } });
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(calls.find((call) => call.name === 'resilience_finalize_attempt')?.arguments).toMatchObject({
    failure_source: 'engine', terminal_outcome: 'failed',
  });
  expect(calls.some((call) => call.name.includes('transition'))).toBe(false);
  const status = await getStatus(req.id, client);
  expect(status.status).toBe('TERMINAL');
  expect(status.activeTuple).toBeUndefined();
}, 45000);

it('failover_blocked_tool_emits_terminal_error_with_blockedOn', async () => {
  vi.stubEnv('TORQCLAW_PROVIDER_FAILOVER_ENABLED', 'true');
  const req = request();
  const events: GatewayEvent[] = [];
  const unsubscribe = sessionBus.subscribe(req.sessionId, (event) => events.push(event));
  try {
    dispatch(req, { tier: ComputeTier.FRONTIER, reason: 'USER_CLOUD_OK' } as never);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'ERROR')).toBe(true));
    expect(mockedFailover.runFailoverTask).toHaveBeenCalledTimes(1);
    const terminals = events.filter((event) => ['RESULT', 'ERROR', 'PENDING_APPROVAL', 'CANCELLED'].includes(event.type));
    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe('ERROR');
    expect.soft(terminals[0].message).toMatch(/^This cloud task tried to use write_file/);
    expect.soft(terminals[0].metadata).toMatchObject({ blockedOn: 'write_file', recovery: expect.arrayContaining(['RETRY_LOCAL']), prompt: req.payload.prompt });
    expect(events.filter((event) => event.type === 'PENDING_APPROVAL')).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_approvals WHERE request_id = ?').get(req.id)).toEqual({ n: 0 });
    expect.soft(db.prepare('SELECT state, error FROM tasks WHERE request_id = ?').get(req.id)).toEqual({ state: 'failed', error: expect.stringMatching(/^BLOCKED_FRONTIER_TOOL: write_file/) });
    expect(db.prepare('SELECT result_state FROM run_receipts WHERE task_id = ?').get(req.id)).toEqual({ result_state: 'failed' });
  } finally { unsubscribe(); }
});

it('failover_observation_rejects_unapproved_blocked_tool_telemetry', async () => {
  const active = { taskId: 'task', attemptId: 'attempt', epoch: 0 };
  function client(telemetry: unknown): ResilienceClient {
    return { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({
      status: 'OBSERVATIONS', cursor: 1,
      observations: [{ kind: 'failure', dispatchAttempted: true, telemetry,
        failure: { failureClass: 'terminal', code: 'approval_blocked', retryable: false } }],
    }) }] }) };
  }
  const unknown = pollObservations(active, 0, Date.now() + 10000, client({ blockedOn: 'write_file', blockedArgs: {} }));
  await expect(unknown).rejects.toThrow(ResilienceEnvelopeError);
  await expect(unknown).rejects.toThrow('telemetry is not normalized');
  for (const blockedOn of ['', 'x'.repeat(129), 'write_file\n', 'write\u0000file', 'tool with spaces', 7, null]) {
    const invalid = pollObservations(active, 0, Date.now() + 10000, client({ blockedOn }));
    await expect(invalid).rejects.toThrow(ResilienceEnvelopeError);
    await expect.soft(invalid).rejects.toThrow('blockedOn is invalid');
  }
});
