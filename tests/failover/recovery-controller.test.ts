import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayRequest, ResilienceActiveTuple, ResilienceImmutablePlan } from '@torqclaw/contracts';
import { getStatus, pageOutbox, recordObservation, type ResilienceClient } from '../../packages/bridge/src/hermesAttempt.js';

type Mode = 'initial' | 'successor' | 'fenced';
const RESULT_MARKER = 'TORQCLAW_RECOVERY_RESULT=';
const taskIds: Record<Mode, string> = {
  initial: '00000000-0000-4000-8000-000000000021',
  successor: '00000000-0000-4000-8000-000000000022',
  fenced: '00000000-0000-4000-8000-000000000023',
};
const sessionId = '00000000-0000-4000-8000-000000000020';
let root = '';
let storage: typeof import('../../packages/gateway/src/storage.js');
let recoverFailoverTasks: typeof import('../../packages/gateway/src/failover.js').recoverFailoverTasks;
let planHash: typeof import('../../packages/gateway/src/providerChains.js').planHash;
let authority: Record<Mode, { initial: ResilienceActiveTuple; active: ResilienceActiveTuple }>;
let client: ResilienceClient;
const calls: Array<{ name: string; arguments: Record<string, any> }> = [];

const setupScript = String.raw`
import json, sys, time
from mcp_wrapper import failover_runtime, task_store
data = json.loads(sys.argv[1])
failover_runtime.reset_for_tests()
ledger = failover_runtime.get_ledger()
result = {}
for item in data:
    admitted = ledger.admit_frontier(item["taskId"], item["plan"], item["plan"]["taskDeadlineMs"], item["plan"]["eligibleProviderIds"])
    initial = admitted["tuple"]
    active = initial
    if item["mode"] == "successor":
        recovered = ledger.recover_and_transition_once(initial, item["taskId"] + ":startup-recovery:v1", 250, {"failureClass":"retryable","code":"pre_dispatch_timeout","retryable":True})
        active = recovered["tuple"]
        submitted = ledger.submit_attempt(active, item["plan"], {
            "providerId":"fallback","label":"Fallback","modelId":"model-b",
            "credentialEnvName":"KEY_B","baseUrlEnvName":"BASE_B"
        }, item["plan"]["taskDeadlineMs"] - 1, item["taskId"] + ":" + active["attemptId"] + ":submit")
        if submitted.get("status") == "NOT_READY":
            time.sleep(submitted["retryAfterMs"] / 1000)
            submitted = ledger.submit_attempt(active, item["plan"], {
                "providerId":"fallback","label":"Fallback","modelId":"model-b",
                "credentialEnvName":"KEY_B","baseUrlEnvName":"BASE_B"
            }, item["plan"]["taskDeadlineMs"] - 1, item["taskId"] + ":" + active["attemptId"] + ":submit")
        if submitted.get("status") != "SUBMITTED":
            raise RuntimeError("successor setup did not submit")
        task_store.create({"submittedBeforeRestart": True}, task_id=active["attemptId"])
    elif item["mode"] == "fenced":
        ledger.mark_dispatch_attempted(initial)
    result[item["mode"]] = {"initial": initial, "active": active}
print("${RESULT_MARKER}" + json.dumps(result, separators=(",", ":")))
`;

const callScript = String.raw`
import asyncio, json, sys, time
from mcp_wrapper import server, task_store
call = json.loads(sys.argv[1])
if call["name"] == "resilience_poll_observations":
    attempt_id = call["arguments"]["active"]["attemptId"]
    task_store.create({"restarted": True}, task_id=attempt_id)
    task_store.complete(attempt_id, "recovered done", {"costUsd": None, "costSource": "unavailable", "dispatchAttempted": False})
result = asyncio.run(getattr(server, call["name"])(**call["arguments"]))
if call["name"] == "resilience_submit_attempt" and result.get("status") == "NOT_READY":
    time.sleep(result["retryAfterMs"] / 1000)
    result = asyncio.run(getattr(server, call["name"])(**call["arguments"]))
print("${RESULT_MARKER}" + json.dumps(result, separators=(",", ":")))
`;

function pythonJson(script: string, payload: unknown): Record<string, any> {
  const run = spawnSync('uv', ['run', 'python', '-c', script, JSON.stringify(payload)], {
    cwd: join(process.cwd(), 'engines', 'hermes_kernel'),
    env: { ...process.env, TORQCLAW_DATA_DIR: root, TORQCLAW_PROVIDER_FAILOVER_ENABLED: '1', HERMES_STUB_DELAY_S: '60' },
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`python recovery boundary failed: ${run.stderr || run.stdout}`);
  const line = run.stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_MARKER));
  if (!line) throw new Error(`python recovery boundary returned no result: ${run.stdout}`);
  return JSON.parse(line.slice(RESULT_MARKER.length)) as Record<string, any>;
}

function plan(taskId: string, deadline: number): ResilienceImmutablePlan {
  return {
    schemaVersion: 1, taskId, chainId: 'coding', eligibleProviderIds: ['primary', 'fallback'],
    privacyClass: 'standard', privacyHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), contextHash: 'c'.repeat(64), grantHash: 'd'.repeat(64),
    taskDeadlineMs: deadline, attemptTimeoutMs: 60_000, transitionLimit: 1, budgetMicroUsd: 2,
    providerCeilings: { primary: 1, fallback: 1 }, featurePolicyRevision: 'rev-1', planRevision: '1',
  };
}

function request(taskId: string): GatewayRequest {
  return {
    id: taskId, sessionId, sourceChannel: 'test', receivedAt: '2026-07-30T12:00:00.000Z',
    payload: { prompt: 'restart recovery', assembledContext: '', contextSize: 1, requiredTools: [], taskType: 'COMPLEX_CODING', grantedTools: [] },
    constraints: { latencySensitivity: 'LOW', maxCost: 1, containsSensitiveData: false, executionMode: 'CLOUD_OK' },
    enrichment: { classifierUsed: 'DEFAULT', classifierConfidence: 1, classifierLatencyMs: 0, estimatedTokens: 1, memoryUsed: false },
  };
}

const document = {
  revision: 'rev-1',
  chains: { coding: { id: 'coding', providers: [
    { id: 'primary', label: 'Primary', modelId: 'model-a', apiKeyEnvName: 'KEY_A', baseUrlEnvName: 'BASE_A', privacyClasses: ['standard'], ceilingMicroUsd: 1 },
    { id: 'fallback', label: 'Fallback', modelId: 'model-b', apiKeyEnvName: 'KEY_B', baseUrlEnvName: 'BASE_B', privacyClasses: ['standard'], ceilingMicroUsd: 1 },
  ] } },
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'torqclaw-recovery-controller-'));
  process.env.TORQCLAW_DATA_DIR = root;
  process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED = 'true';
  process.env.TORQCLAW_FAILOVER_CODING_CHAIN = 'coding';
  const deadline = Date.now() + 600_000;
  const plans = Object.fromEntries((Object.keys(taskIds) as Mode[]).map((mode) => [mode, plan(taskIds[mode], deadline)])) as Record<Mode, ResilienceImmutablePlan>;
  authority = pythonJson(setupScript, (Object.keys(taskIds) as Mode[]).map((mode) => ({ mode, taskId: taskIds[mode], plan: plans[mode] }))) as typeof authority;
  storage = await import('../../packages/gateway/src/storage.js');
  ({ recoverFailoverTasks } = await import('../../packages/gateway/src/failover.js'));
  ({ planHash } = await import('../../packages/gateway/src/providerChains.js'));
  storage.db.prepare('INSERT INTO sessions (id, role) VALUES (?, ?)').run(sessionId, 'test');
  for (const mode of Object.keys(taskIds) as Mode[]) {
    const req = request(taskIds[mode]);
    storage.db.prepare(`INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json) VALUES (?, ?, ?, ?, ?, ?)`).run(req.id, sessionId, 'API_EXTERNAL', 'test', 'running', JSON.stringify(req));
    storage.recordFailoverAdmission({
      taskId: req.id, planHash: planHash(plans[mode]), chainId: 'coding', featureRevision: 'rev-1',
      activeAttemptId: authority[mode].initial.attemptId, activeEpoch: 0, deadlineMs: deadline, immutablePlan: plans[mode],
      providerMetadata: { primary: { modelId: 'model-a', reservedMicroUsd: 1 }, fallback: { modelId: 'model-b', reservedMicroUsd: 1 } },
    });
  }
  client = {
    async callTool(call) {
      calls.push({ name: call.name, arguments: call.arguments as Record<string, any> });
      const value = pythonJson(callScript, call);
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    },
  };
  await storage.reconcileGatewayProjection(async (afterCursor, limit) => pageOutbox(afterCursor, limit, client));
});

afterAll(() => {
  storage.db.close();
  const target = resolve(root);
  if (target.startsWith(resolve(tmpdir()))) rmSync(target, { recursive: true, force: true });
});

describe('real startup recovery controller', () => {
  it('polls recovered/new successors to one terminal and closes post-fence as uncertain', async () => {
    const summary = await recoverFailoverTasks({ client, document });
    expect(summary).toEqual({ candidates: 3, cancelledResumed: 0, transitioned: 1, terminalized: 3, rejected: 0 });

    const recoverCalls = calls.filter((call) => call.name === 'resilience_recover_and_transition_once');
    expect(recoverCalls.map((call) => call.arguments.active.taskId).sort()).toEqual([taskIds.fenced, taskIds.initial].sort());
    const submits = calls.filter((call) => call.name === 'resilience_submit_attempt');
    expect(submits.map((call) => call.arguments.active.taskId).sort()).toEqual([taskIds.initial, taskIds.successor].sort());
    expect(calls.filter((call) => call.name === 'resilience_poll_observations')).toHaveLength(1);

    for (const mode of ['initial'] as const) {
      expect((await getStatus(taskIds[mode], client)).status).toBe('TERMINAL');
      expect(storage.db.prepare('SELECT state FROM tasks WHERE request_id=?').get(taskIds[mode])).toEqual({ state: 'completed' });
      expect(storage.getFailoverProjection(taskIds[mode])).toMatchObject({ active_attempt_id: null, active_epoch: null, terminal_outcome: 'completed' });
      expect(storage.db.prepare("SELECT COUNT(*) AS count FROM events WHERE request_id=? AND type='RESULT'").get(taskIds[mode])).toEqual({ count: 1 });
      const resultEvent = storage.db.prepare("SELECT metadata FROM events WHERE request_id=? AND type='RESULT'").get(taskIds[mode]) as { metadata: string };
      expect(JSON.parse(resultEvent.metadata)).toMatchObject({ costSource: 'unavailable', failoverEnabled: true, recovered: true });
    }

    expect((await getStatus(taskIds.successor, client)).status).toBe('TERMINAL');
    expect(storage.db.prepare('SELECT state FROM tasks WHERE request_id=?').get(taskIds.successor)).toEqual({ state: 'cancelled_uncertain' });
    expect(storage.getFailoverProjection(taskIds.successor)).toMatchObject({ active_attempt_id: null, active_epoch: null, terminal_outcome: 'cancelled_uncertain' });
    expect(storage.getProviderAttemptProjections(taskIds.successor)).toHaveLength(2);
    expect(storage.getProviderAttemptProjections(taskIds.successor)[1]).toMatchObject({ terminal_outcome: 'cancelled_uncertain', failure_class: 'side_effect_uncertainty', failure_code: 'dispatch_attempted', failure_source: 'recovery' });
    expect(storage.db.prepare("SELECT COUNT(*) AS count FROM events WHERE request_id=? AND type='RESULT'").get(taskIds.successor)).toEqual({ count: 0 });

    expect((await getStatus(taskIds.fenced, client)).status).toBe('TERMINAL');
    expect(storage.db.prepare('SELECT state FROM tasks WHERE request_id=?').get(taskIds.fenced)).toEqual({ state: 'cancelled_uncertain' });
    expect(storage.getFailoverProjection(taskIds.fenced)).toMatchObject({ active_attempt_id: null, active_epoch: null, terminal_outcome: 'cancelled_uncertain' });
    expect(storage.getProviderAttemptProjections(taskIds.fenced)[0]).toMatchObject({ dispatch_attempted: 1, reserved_micro_usd: 1, actual_micro_usd: null, terminal_outcome: 'cancelled_uncertain' });
    const late = await recordObservation(authority.fenced.initial, { kind: 'progress', dispatchAttempted: true }, `${taskIds.fenced}:late`, client);
    expect(late.status).not.toBe('RECORDED');

    const beforeReplay = calls.length;
    expect(await recoverFailoverTasks({ client, document })).toEqual({ candidates: 0, cancelledResumed: 0, transitioned: 0, terminalized: 0, rejected: 0 });
    expect(calls.slice(beforeReplay).some((call) => call.name === 'resilience_submit_attempt')).toBe(false);
  }, 30_000);
});
