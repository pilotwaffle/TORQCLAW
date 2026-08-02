import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComputeTier } from '@torqclaw/contracts';
import type { GatewayRequest } from '@torqclaw/contracts';
import { getStatus, pageOutbox, type ResilienceClient } from '../../packages/bridge/src/hermesAttempt.js';

let root = '';
let runFailoverTask: typeof import('../../packages/gateway/src/failover.js').runFailoverTask;
const RESULT_MARKER = 'TORQCLAW_TIMEOUT_RESULT=';

const callScript = String.raw`
import asyncio, json, sys
from mcp_wrapper import failover_runtime, server
data = json.loads(sys.argv[1])
call = data["call"]
if call["name"] == "attempt_timeout":
    failover_runtime._stop_signal = lambda task_id, timeout_ms: {"status": data["ack"]}
result = asyncio.run(getattr(server, call["name"])(**call["arguments"]))
print("${RESULT_MARKER}" + json.dumps(result, separators=(",", ":")))
`;

function pythonClient(ack: 'ACK_PRE_DISPATCH' | 'ACK_UNCERTAIN', calls: string[]): ResilienceClient {
  return {
    async callTool(call) {
      calls.push(call.name);
      const run = spawnSync('uv', ['run', 'python', '-c', callScript, JSON.stringify({ call, ack })], {
        cwd: join(process.cwd(), 'engines', 'hermes_kernel'),
        env: { ...process.env, TORQCLAW_DATA_DIR: root, TORQCLAW_PROVIDER_FAILOVER_ENABLED: '1' },
        encoding: 'utf8',
      });
      if (run.status !== 0) throw new Error(`python timeout boundary failed: ${run.stderr || run.stdout}`);
      const line = run.stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_MARKER));
      if (!line) throw new Error(`python timeout boundary returned no result: ${run.stdout}`);
      return { content: [{ type: 'text', text: line.slice(RESULT_MARKER.length) }] };
    },
  };
}

const request = {
  id: 'timeout-controller-task',
  sessionId: 'timeout-controller-session',
  sourceChannel: 'test',
  receivedAt: '2026-07-30T12:00:00.000Z',
  payload: { prompt: 'timeout', assembledContext: '', contextSize: 1, requiredTools: [], taskType: 'COMPLEX_CODING', grantedTools: [] },
  constraints: { latencySensitivity: 'LOW', maxCost: 1, containsSensitiveData: false, executionMode: 'CLOUD_OK' },
  enrichment: { classifierUsed: 'DEFAULT', classifierConfidence: 1, classifierLatencyMs: 0, estimatedTokens: 1, memoryUsed: false },
} as GatewayRequest;

const document = {
  revision: 'rev-1',
  chains: {
    coding: {
      id: 'coding',
      providers: [
        { id: 'primary', label: 'Primary', modelId: 'model-a', apiKeyEnvName: 'KEY_A', baseUrlEnvName: 'BASE_A', privacyClasses: ['standard'], ceilingMicroUsd: 10 },
        { id: 'fallback', label: 'Fallback', modelId: 'model-b', apiKeyEnvName: 'KEY_B', baseUrlEnvName: 'BASE_B', privacyClasses: ['standard'], ceilingMicroUsd: 10 },
      ],
    },
  },
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'torqclaw-timeout-controller-'));
  process.env.TORQCLAW_DATA_DIR = root;
  process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED = 'true';
  process.env.TORQCLAW_FAILOVER_CODING_CHAIN = 'coding';
  ({ runFailoverTask } = await import('../../packages/gateway/src/failover.js'));
});

afterAll(async () => {
  const storage = await import('../../packages/gateway/src/storage.js');
  storage.db.close();
  const target = resolve(root);
  if (target.startsWith(resolve(tmpdir()))) rmSync(target, { recursive: true, force: true });
});

describe('gateway controller timeout boundary', () => {
  it('uses one acknowledged pre-dispatch stop and one successor without operator cancellation', async () => {
    const active = { taskId: request.id, attemptId: 'attempt-0', epoch: 0 } as const;
    const successor = { taskId: request.id, attemptId: 'attempt-1', epoch: 1 } as const;
    const calls: string[] = [];
    const bridge = {
      admitFrontier: async () => { calls.push('admit'); return { status: 'ADMITTED' as const, activeTuple: active }; },
      pageOutbox: async () => ({ status: 'PAGE' as const, cursor: 0, highWaterMark: 0, events: [] }),
      executeHermesAttempt: async (_payload: unknown, _plan: unknown, tuple: typeof active) => {
        calls.push(`execute:${tuple.epoch}`);
        return tuple.epoch === 0
          ? { text: '', telemetry: {}, dispatchAttempted: false, observation: { kind: 'timeout' as const, dispatchAttempted: false } }
          : { text: 'done', telemetry: {}, dispatchAttempted: false, observation: { kind: 'result' as const, dispatchAttempted: false, text: 'done' } };
      },
      recordObservation: async () => { calls.push('record'); return { status: 'RECORDED' as const }; },
      signalAttemptTimeout: async () => { calls.push('attempt-timeout-stop'); return { status: 'ACK_PRE_DISPATCH' as const, activeTuple: active, dispatchAttempted: false }; },
      requestCancel: async () => { calls.push('operator-cancel'); return { status: 'ACK_CANCELLED' as const }; },
      signalProviderCancel: async () => { calls.push('provider-cancel'); },
      transitionOnce: async () => { calls.push('transition'); return { status: 'TRANSITIONED' as const, successor, successorProviderId: 'fallback' }; },
    };

    const result = await runFailoverTask(request, { tier: ComputeTier.FRONTIER } as never, { document, nowMs: 1_000, env: { TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '10000', TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '1000' }, bridge: bridge as never, emit: () => undefined, random: () => 0 });
    expect(result.text).toBe('done');
    expect(calls).toEqual(['admit', 'execute:0', 'attempt-timeout-stop', 'transition', 'execute:1', 'record']);
    expect(calls).not.toContain('operator-cancel');
    expect(calls).not.toContain('provider-cancel');
  });

  it('elides post-poll record RPC only when the terminal marker is exact', async () => {
    const task = { ...request, id: 'timeout-controller-marked-result', sessionId: 'timeout-controller-marked-session' };
    const active = { taskId: task.id, attemptId: 'marked-attempt', epoch: 0 } as const;
    let recordCalls = 0;
    const result = await runFailoverTask(task, { tier: ComputeTier.FRONTIER } as never, {
      document, nowMs: 1_000,
      env: { TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '10000', TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '1000' },
      bridge: {
        admitFrontier: async () => ({ status: 'ADMITTED' as const, activeTuple: active }),
        pageOutbox: async () => ({ status: 'PAGE' as const, cursor: 0, highWaterMark: 0, events: [] }),
        executeHermesAttempt: async () => ({
          text: 'done', telemetry: {}, dispatchAttempted: false,
          observation: { kind: 'result' as const, dispatchAttempted: false, text: 'done' },
          terminalCommitted: true as const, terminalOutcome: 'completed' as const,
        }),
        recordObservation: async () => {
          recordCalls += 1;
          return { status: 'RECORDED' as const };
        },
      } as never,
      emit: () => undefined,
    });
    expect(result.text).toBe('done');
    expect(recordCalls).toBe(0);
  });

  it('elides post-poll finalize RPC for an exactly marked non-retryable failure', async () => {
    const task = { ...request, id: 'timeout-controller-marked-failure', sessionId: 'timeout-controller-marked-failure-session' };
    const active = { taskId: task.id, attemptId: 'marked-failure-attempt', epoch: 0 } as const;
    let finalizeCalls = 0;
    await expect(runFailoverTask(task, { tier: ComputeTier.FRONTIER } as never, {
      document, nowMs: 1_000,
      env: { TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '10000', TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '1000' },
      bridge: {
        admitFrontier: async () => ({ status: 'ADMITTED' as const, activeTuple: active }),
        pageOutbox: async () => ({ status: 'PAGE' as const, cursor: 0, highWaterMark: 0, events: [] }),
        executeHermesAttempt: async () => ({
          text: '', telemetry: {}, dispatchAttempted: false,
          observation: {
            kind: 'failure' as const, dispatchAttempted: false, failureSource: 'engine' as const,
            failure: { failureClass: 'terminal' as const, code: 'engine_failure', retryable: false as const },
          },
          terminalCommitted: true as const, terminalOutcome: 'failed' as const,
        }),
        finalizeAttempt: async () => {
          finalizeCalls += 1;
          return { status: 'FINALIZED' as const };
        },
      } as never,
      emit: () => undefined,
    })).rejects.toMatchObject({ terminalOutcome: 'failed' });
    expect(finalizeCalls).toBe(0);
  });

  it('uses the real Python ACK before recording timeout and creates exactly one successor', async () => {
    const realRequest = { ...request, id: '00000000-0000-4000-8000-000000000014', sessionId: '00000000-0000-4000-8000-000000000015' };
    const calls: string[] = [];
    const client = pythonClient('ACK_PRE_DISPATCH', calls);
    const result = await runFailoverTask(realRequest, { tier: ComputeTier.FRONTIER } as never, {
      document, nowMs: Date.now(), env: { TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '120000', TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '60000' },
      client, emit: () => undefined, random: () => 0,
      bridge: {
        executeHermesAttempt: async (_payload, _plan, active) => active.epoch === 0
          ? { text: '', telemetry: {}, dispatchAttempted: false, observation: { kind: 'timeout' as const, dispatchAttempted: false } }
          : { text: 'done', telemetry: {}, dispatchAttempted: false, observation: { kind: 'result' as const, dispatchAttempted: false, text: 'done' } },
      },
    });

    expect(result.text).toBe('done');
    expect(calls.indexOf('attempt_timeout')).toBeLessThan(calls.indexOf('resilience_transition_once'));
    expect(calls).not.toContain('cancel_task');
    const status = await getStatus(realRequest.id, client);
    expect(status.status).toBe('TERMINAL');
    const page = await pageOutbox(0, 100, client);
    expect(page.events.filter((event: any) => event.kind === 'transitioned')).toHaveLength(1);
    expect(page.events.filter((event: any) => event.kind === 'attempt_completed')).toHaveLength(1);
    expect(page.events.some((event: any) => event.kind === 'cancel_requested')).toBe(false);
  }, 30_000);

  it('terminalizes a real uncertain timeout without a successor or operator cancellation', async () => {
    const realRequest = { ...request, id: '00000000-0000-4000-8000-000000000016', sessionId: '00000000-0000-4000-8000-000000000017' };
    const calls: string[] = [];
    const client = pythonClient('ACK_UNCERTAIN', calls);
    await expect(runFailoverTask(realRequest, { tier: ComputeTier.FRONTIER } as never, {
      document, nowMs: Date.now(), env: { TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '120000', TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '60000' },
      client, emit: () => undefined, random: () => 0,
      bridge: { executeHermesAttempt: async () => ({ text: '', telemetry: {}, dispatchAttempted: false, observation: { kind: 'timeout' as const, dispatchAttempted: false } }) },
    })).rejects.toMatchObject({ terminalOutcome: 'cancelled_uncertain' });
    expect(calls).not.toContain('cancel_task');
    const status = await getStatus(realRequest.id, client);
    expect(status.status).toBe('TERMINAL');
    const page = await pageOutbox(0, 100, client);
    const taskEvents = page.events.filter((event: any) => event.taskId === realRequest.id);
    expect(taskEvents.filter((event: any) => event.kind === 'transitioned')).toHaveLength(0);
    expect(taskEvents.filter((event: any) => event.kind === 'attempt_completed')).toHaveLength(1);
    expect((taskEvents.find((event: any) => event.kind === 'attempt_completed') as any).payload.outcome).toBe('cancelled_uncertain');
  }, 30_000);

  it('terminal-closes a fallback retryable failure when no successor exists', async () => {
    const realRequest = { ...request, id: '00000000-0000-4000-8000-000000000018', sessionId: '00000000-0000-4000-8000-000000000019' };
    const calls: string[] = [];
    const client = pythonClient('ACK_PRE_DISPATCH', calls);
    await expect(runFailoverTask(realRequest, { tier: ComputeTier.FRONTIER } as never, {
      document, nowMs: Date.now(), env: { TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '120000', TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '60000' },
      client, emit: () => undefined, random: () => 0, sleepMs: async () => undefined,
      bridge: { executeHermesAttempt: async (_payload, _plan, active) => ({
        text: '', telemetry: {}, dispatchAttempted: false,
        observation: { kind: 'failure' as const, dispatchAttempted: false, failureSource: 'gateway' as const,
          failure: active.epoch === 0
            ? { failureClass: 'retryable' as const, code: 'connection', retryable: true as const }
            : { failureClass: 'retryable' as const, code: 'http_5xx', retryable: true as const } },
      }) },
    })).rejects.toMatchObject({ failure: { failureClass: 'retryable', code: 'http_5xx' }, terminalOutcome: 'failed' });
    expect((await getStatus(realRequest.id, client)).status).toBe('TERMINAL');
    const events = (await pageOutbox(0, 100, client)).events.filter((event: any) => event.taskId === realRequest.id);
    expect(events.filter((event: any) => event.kind === 'transitioned')).toHaveLength(1);
    expect(events.filter((event: any) => event.kind === 'attempt_completed')).toHaveLength(1);
    expect(events.filter((event: any) => event.kind === 'provider_event').at(-1)?.payload).toMatchObject({ payload: { failureClass: 'retryable', code: 'http_5xx' }, source: 'gateway' });
  }, 30_000);

  it('terminal-closes epoch zero when the authoritative budget rejects transition', async () => {
    const realRequest = { ...request, id: '00000000-0000-4000-8000-000000000024', sessionId: '00000000-0000-4000-8000-000000000025', constraints: { ...request.constraints, maxCost: 0.000005 } };
    const budgetDocument = { revision: 'rev-1', chains: { coding: { id: 'coding', providers: [
      { ...document.chains.coding.providers[0], ceilingMicroUsd: 1 },
      { ...document.chains.coding.providers[1], ceilingMicroUsd: 10 },
    ] } } };
    const client = pythonClient('ACK_PRE_DISPATCH', []);
    await expect(runFailoverTask(realRequest, { tier: ComputeTier.FRONTIER } as never, {
      document: budgetDocument, nowMs: Date.now(), client, emit: () => undefined, random: () => 0, sleepMs: async () => undefined,
      bridge: { executeHermesAttempt: async () => ({ text: '', telemetry: {}, dispatchAttempted: false, observation: { kind: 'failure' as const, dispatchAttempted: false, failureSource: 'gateway' as const, failure: { failureClass: 'retryable' as const, code: 'connection', retryable: true as const } } }) },
    })).rejects.toMatchObject({ failure: { code: 'connection' }, terminalOutcome: 'failed' });
    expect((await getStatus(realRequest.id, client)).status).toBe('TERMINAL');
    const events = (await pageOutbox(0, 100, client)).events.filter((event: any) => event.taskId === realRequest.id);
    expect(events.filter((event: any) => event.kind === 'transitioned')).toHaveLength(0);
    expect(events.filter((event: any) => event.kind === 'attempt_completed')).toHaveLength(1);
  }, 30_000);
});
