import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayRequest, ResilienceActiveTuple, ResilienceImmutablePlan } from '@torqclaw/contracts';
import { getStatus, recordObservation, type ResilienceClient } from '../../packages/bridge/src/hermesAttempt.js';

type CancelMode = 'unknown' | 'noop';

const RESULT_MARKER = 'TORQCLAW_TEST_RESULT=';
const taskIds: Record<CancelMode, string> = {
  unknown: '00000000-0000-4000-8000-000000000012',
  noop: '00000000-0000-4000-8000-000000000013',
};
const sessionId = '00000000-0000-4000-8000-000000000011';
const calls: string[] = [];
const cancelStatuses: Record<string, string> = {};
let root = '';
let storage: typeof import('../../packages/gateway/src/storage.js');
let recoverFailoverTasks: typeof import('../../packages/gateway/src/failover.js').recoverFailoverTasks;
let activeByMode: Record<CancelMode, ResilienceActiveTuple>;
let client: ResilienceClient;

const setupScript = String.raw`
import json, sys
from mcp_wrapper import failover_runtime
data = json.loads(sys.argv[1])
failover_runtime.reset_for_tests()
ledger = failover_runtime.get_ledger()
result = {}
for item in data:
    admitted = ledger.admit_frontier(item["taskId"], item["plan"], item["plan"]["taskDeadlineMs"], item["plan"]["eligibleProviderIds"])
    active = admitted["tuple"]
    ledger.request_cancel(active, item["taskId"] + ":persisted-cancel")
    result[item["mode"]] = active
print("${RESULT_MARKER}" + json.dumps(result, separators=(",", ":")))
`;

const callScript = String.raw`
import asyncio, json, sys
from mcp_wrapper import server, task_store
data = json.loads(sys.argv[1])
call = data["call"]
args = call["arguments"]
if call["name"] == "cancel_task" and args["task_id"] == data["noopAttemptId"]:
    task_store.create({"restart": True}, task_id=args["task_id"])
    task_store.fail(args["task_id"], "already stopped")
handler = getattr(server, call["name"])
result = asyncio.run(handler(**args))
print("${RESULT_MARKER}" + json.dumps(result, separators=(",", ":")))
`;

function pythonJson(script: string, payload: unknown): Record<string, any> {
  const run = spawnSync('uv', ['run', 'python', '-c', script, JSON.stringify(payload)], {
    cwd: join(process.cwd(), 'engines', 'hermes_kernel'),
    env: { ...process.env, TORQCLAW_DATA_DIR: root, TORQCLAW_PROVIDER_FAILOVER_ENABLED: '1' },
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`python boundary failed (${run.status}): ${run.stderr || run.stdout}`);
  const line = run.stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_MARKER));
  if (!line) throw new Error(`python boundary returned no result: ${run.stdout}`);
  return JSON.parse(line.slice(RESULT_MARKER.length)) as Record<string, any>;
}

function plan(taskId: string, deadline: number): ResilienceImmutablePlan {
  return {
    schemaVersion: 1, taskId, chainId: 'coding', eligibleProviderIds: ['primary', 'fallback'],
    privacyClass: 'standard', privacyHash: 'a'.repeat(64), policyHash: 'b'.repeat(64),
    contextHash: 'c'.repeat(64), grantHash: 'd'.repeat(64), taskDeadlineMs: deadline,
    attemptTimeoutMs: 60_000, transitionLimit: 1, budgetMicroUsd: 2,
    providerCeilings: { primary: 1, fallback: 1 }, featurePolicyRevision: 'rev-1', planRevision: '1',
  };
}

function request(taskId: string): GatewayRequest {
  return {
    id: taskId, sessionId, sourceChannel: 'test', receivedAt: '2026-07-30T12:00:00.000Z',
    payload: { prompt: 'cancel recovery', assembledContext: '', contextSize: 1, requiredTools: [], taskType: 'COMPLEX_CODING', grantedTools: [] },
    constraints: { latencySensitivity: 'LOW', maxCost: 1, containsSensitiveData: false, executionMode: 'CLOUD_OK' },
    enrichment: { classifierUsed: 'DEFAULT', classifierConfidence: 1, classifierLatencyMs: 0, estimatedTokens: 1, memoryUsed: false },
  };
}

function mcpResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'torqclaw-recovery-cancel-'));
  process.env.TORQCLAW_DATA_DIR = root;
  process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED = 'true';
  const deadline = Date.now() + 600_000;
  const plans = { unknown: plan(taskIds.unknown, deadline), noop: plan(taskIds.noop, deadline) };
  activeByMode = pythonJson(setupScript, (Object.keys(taskIds) as CancelMode[]).map((mode) => ({ mode, taskId: taskIds[mode], plan: plans[mode] }))) as Record<CancelMode, ResilienceActiveTuple>;
  storage = await import('../../packages/gateway/src/storage.js');
  ({ recoverFailoverTasks } = await import('../../packages/gateway/src/failover.js'));
  storage.db.prepare('INSERT INTO sessions (id, role) VALUES (?, ?)').run(sessionId, 'test');
  for (const mode of Object.keys(taskIds) as CancelMode[]) {
    const req = request(taskIds[mode]);
    storage.db.prepare(`INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json, result, error, telemetry_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.id, sessionId, 'API_EXTERNAL', 'test', 'cancel_requested', JSON.stringify(req), null, null, null);
    storage.recordFailoverAdmission({
      taskId: req.id, planHash: 'a'.repeat(64), chainId: 'coding', featureRevision: 'rev-1',
      activeAttemptId: activeByMode[mode].attemptId, activeEpoch: 0, deadlineMs: deadline,
      immutablePlan: plans[mode],
      providerMetadata: { primary: { modelId: 'model-a', reservedMicroUsd: 1 }, fallback: { modelId: 'model-b', reservedMicroUsd: 1 } },
    });
  }
  client = {
    async callTool(call) {
      calls.push(call.name);
      const value = pythonJson(callScript, { call, noopAttemptId: activeByMode.noop.attemptId });
      if (call.name === 'cancel_task') cancelStatuses[String(call.arguments.task_id)] = String(value.status);
      return mcpResult(value);
    },
  };
});

afterAll(() => {
  storage.db.close();
  const target = resolve(root);
  if (target.startsWith(resolve(tmpdir()))) rmSync(target, { recursive: true, force: true });
});

describe('startup cancellation recovery across gateway, bridge, and Python ledger', () => {
  it('terminalizes restart unknown/noop without fallback or a lingering active projection', async () => {
    const summary = await recoverFailoverTasks({ client });

    expect(summary).toEqual({ candidates: 2, cancelledResumed: 2, transitioned: 0, terminalized: 2, rejected: 0 });
    expect(cancelStatuses[activeByMode.unknown.attemptId]).toBe('unknown');
    expect(cancelStatuses[activeByMode.noop.attemptId]).toBe('noop');
    expect(calls).not.toContain('resilience_recover_and_transition_once');
    expect(calls).not.toContain('resilience_submit_attempt');

    for (const mode of Object.keys(taskIds) as CancelMode[]) {
      const authoritative = await getStatus(taskIds[mode], client);
      expect(authoritative.status).toBe('TERMINAL');
      expect(authoritative.activeTuple).toBeUndefined();
      expect(storage.db.prepare('SELECT state FROM tasks WHERE request_id=?').get(taskIds[mode])).toEqual({ state: 'cancelled_uncertain' });
      expect(storage.getFailoverProjection(taskIds[mode])).toMatchObject({ active_attempt_id: null, active_epoch: null, terminal_outcome: 'cancelled_uncertain' });
      expect(storage.getProviderAttemptProjections(taskIds[mode])[0]).toMatchObject({ attempt_id: activeByMode[mode].attemptId, terminal_outcome: 'cancelled_uncertain' });
      const late = await recordObservation(activeByMode[mode], { kind: 'progress', dispatchAttempted: false }, `${taskIds[mode]}:late`, client);
      expect(late.status).not.toBe('RECORDED');
    }
    expect(calls).not.toContain('resilience_recover_and_transition_once');
    expect(calls).not.toContain('resilience_submit_attempt');
  });
});
