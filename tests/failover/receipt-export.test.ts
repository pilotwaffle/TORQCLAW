import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { pythonRuntime } from '../../ops/python-runtime.mjs';

let buildSafeExport: typeof import('../../packages/gateway/src/export.js').buildSafeExport;
let FAILOVER_EXPORT_VERSION: typeof import('../../packages/gateway/src/export.js').FAILOVER_EXPORT_VERSION;
let REDACTOR_VERSION: typeof import('../../packages/gateway/src/export.js').REDACTOR_VERSION;
let storage: typeof import('../../packages/gateway/src/storage.js');
let receipts: typeof import('../../packages/gateway/src/receipts.js');
let root = '';
let closeDb: (() => void) | undefined;
let fakeProvider: ReturnType<typeof spawn> | undefined;
const PYTHON = pythonRuntime(process.cwd());
const fakePending: Array<{ resolve: (value: any) => void; reject: (error: unknown) => void }> = [];
const fakeOutbox: any[] = [];

function fakeCall(name: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolveCall, rejectCall) => {
    fakePending.push({ resolve: resolveCall, reject: rejectCall });
    fakeProvider?.stdin?.write(JSON.stringify({ name, arguments: args }) + '\n', (error) => {
      if (error) rejectCall(error);
    });
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'torqclaw-export-'));
  process.env.TORQCLAW_DATA_DIR = root;
  process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED = 'true';
  const exported = await import('../../packages/gateway/src/export.js');
  storage = await import('../../packages/gateway/src/storage.js');
  receipts = await import('../../packages/gateway/src/receipts.js');
  closeDb = () => storage.db.close();
  buildSafeExport = exported.buildSafeExport;
  FAILOVER_EXPORT_VERSION = exported.FAILOVER_EXPORT_VERSION;
  REDACTOR_VERSION = exported.REDACTOR_VERSION;
  fakeProvider = spawn(PYTHON.command, [
    ...PYTHON.argsPrefix, join(process.cwd(), 'ops', 'phase1_fake_provider_server.py'),
  ], {
    cwd: PYTHON.cwd,
    env: { ...process.env, TORQCLAW_DATA_DIR: root, TORQCLAW_PROVIDER_FAILOVER_ENABLED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = createInterface({ input: fakeProvider.stdout! });
  reader.on('line', (line) => {
    const pending = fakePending.shift();
    if (!pending) return;
    try { pending.resolve(JSON.parse(line)); } catch (error) { pending.reject(error); }
  });
  fakeProvider.on('error', (error) => {
    while (fakePending.length) fakePending.shift()!.reject(error);
  });
});

afterAll(async () => {
  fakeProvider?.stdin?.end();
  if (fakeProvider) await once(fakeProvider, 'close');
  closeDb?.();
  rmSync(root, { recursive: true, force: true });
});

const receipt = {
  id: 'r', task_id: 't', session_id: 's', source_channel: 'test', selected_tier: 'API_EXTERNAL', route_diagnostics_json: null,
  budget_limit: null, budget_source: null, cost_usd: null, cost_enforceable: 0, elapsed_ms: null, iterations: null,
  tools_called_json: '[]', cancelled: 0, blocked_on: null, memory_used: null, context_chars: null, result_state: 'failed',
  safe_export_json: null, projection_version: 2, full_receipt_json: JSON.stringify({
    taskId: 't', sessionId: 's', failoverEnabled: true, finalProviderId: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz123456', terminalUncertainty: false,
    providerAttempts: [{ epoch: 0, attemptId: 'a0', providerId: 'Bearer sk-abcdefghijklmnopqrstuvwxyz123456', modelId: 'ghp_abcdefghijklmnopqrstuvwxyz123456', startedAtMs: 1, endedAtMs: 2, normalizedFailure: { failureClass: 'retryable', code: 'connection' }, dispatchAttempted: false, transitionDecision: 'transitioned', terminalOutcome: 'failed', cost: { reservedMicroUsd: null, actualMicroUsd: 0, known: true, source: 'exact' } }],
  }), evidence_start_seq: null, evidence_end_seq: null,
} as never;

describe('receipt/export v2', () => {
  it('exports ordered normalized attempts and omits prompt/tool args/endpoints/errors', () => {
    const exported = buildSafeExport(receipt, [], REDACTOR_VERSION);
    expect(exported.exportVersion).toBe(FAILOVER_EXPORT_VERSION);
    expect(exported.providerAttempts).toHaveLength(1);
    const json = JSON.stringify(exported);
    expect(json).not.toContain('prompt');
    expect(json).not.toContain('toolArgs');
    expect(json).not.toContain('endpoint');
    expect(json).not.toContain('rawError');
    expect(json).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(json).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(exported.finalProviderId).toMatch(/REDACTED/);
    expect(exported.providerAttempts?.[0]?.cost).toEqual({ reservedMicroUsd: null, actualMicroUsd: 0, known: true, source: 'exact' });
  });

  it('reconstructs real Python-ledger outbox through projection, receipt, and safe export', async () => {
    const taskId = '00000000-0000-4000-8000-000000000099';
    const sessionId = '00000000-0000-4000-8000-000000000009';
    storage.ensureResilienceProjection();
    storage.db.prepare('INSERT INTO sessions (id, role) VALUES (?, ?)').run(sessionId, 'test');
    storage.db.prepare(`INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json, result, error, telemetry_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      taskId, sessionId, 'API_EXTERNAL', 'test', 'running', JSON.stringify({
        id: taskId, sessionId, sourceChannel: 'test', receivedAt: '2026-07-30T00:00:00Z',
        payload: { prompt: 'must not export sk-live-abcdefghijklmnopqrstuvwxyz123456 TORQCLAW_FAKE_FAULT=connection', assembledContext: '', contextSize: 1, requiredTools: [], taskType: 'COMPLEX_CODING', grantedTools: [] },
        constraints: { latencySensitivity: 'LOW', maxCost: 100, containsSensitiveData: false, executionMode: 'CLOUD_OK' },
        enrichment: { classifierUsed: 'DEFAULT', classifierConfidence: 1, classifierLatencyMs: 0, estimatedTokens: 1, memoryUsed: false },
      }), null, null, JSON.stringify({ failoverEnabled: true, costUsd: null, costSource: 'unavailable' }),
    );
    storage.db.prepare(`INSERT INTO events (id, session_id, request_id, tier, type, message, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      '00000000-0000-4000-8000-000000000191', sessionId, taskId, 'API_EXTERNAL', 'TIER_SELECTED',
      'frontier', JSON.stringify({ score: 10, tier: 'API_EXTERNAL', reason: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz123456' }),
    );

    const now = Date.now();
    const plan = {
      schemaVersion: 1, taskId, chainId: 'coding', eligibleProviderIds: ['primary', 'fallback'],
      privacyClass: 'standard', privacyHash: 'a'.repeat(64), policyHash: 'b'.repeat(64),
      contextHash: 'c'.repeat(64), grantHash: 'd'.repeat(64), taskDeadlineMs: now + 60_000,
      attemptTimeoutMs: 1_000, transitionLimit: 1, budgetMicroUsd: 100_000_000,
      providerCeilings: { primary: 7, fallback: 9 }, featurePolicyRevision: 'rev-1', planRevision: '1',
    } as any;
    const { planHash } = await import('../../packages/gateway/src/providerChains.js');
    const { admitFrontier, submitAttempt, pollObservations, recordObservation, transitionOnce, pageOutbox } =
      await import('../../packages/bridge/src/hermesAttempt.js');
    const client = { callTool: (call: { name: string; arguments: Record<string, unknown> }) => fakeCall(call.name, call.arguments) };
    const provider = (id: 'primary' | 'fallback') => ({
      id, label: id === 'primary' ? 'Primary' : 'Fallback', modelId: id === 'primary' ? 'fake-primary-model' : 'fake-fallback-model',
      apiKeyEnvName: id === 'primary' ? 'KEY_A' : 'KEY_B', baseUrlEnvName: id === 'primary' ? 'BASE_A' : 'BASE_B',
    });
    const request = {
      id: taskId, sessionId, sourceChannel: 'test', receivedAt: '2026-07-30T00:00:00.000Z',
      payload: { prompt: 'must not export sk-live-abcdefghijklmnopqrstuvwxyz123456 TORQCLAW_FAKE_FAULT=connection', assembledContext: '', contextSize: 1, requiredTools: [], taskType: 'COMPLEX_CODING', grantedTools: [] },
      constraints: { latencySensitivity: 'LOW', maxCost: 100, containsSensitiveData: false, executionMode: 'CLOUD_OK' },
      enrichment: { classifierUsed: 'DEFAULT', classifierConfidence: 1, classifierLatencyMs: 0, estimatedTokens: 1, memoryUsed: false },
    } as any;
    const admission = await admitFrontier(taskId, plan, ['primary', 'fallback'], plan.taskDeadlineMs, `${taskId}:admit`, client);
    expect(admission.status).toBe('ADMITTED');
    const first = admission.activeTuple!;
    storage.recordFailoverAdmission({
      taskId, planHash: planHash(plan), chainId: 'coding', featureRevision: 'rev-1',
      activeAttemptId: first.attemptId, activeEpoch: 0, deadlineMs: plan.taskDeadlineMs, immutablePlan: plan,
      providerMetadata: {
        primary: { modelId: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz123456', reservedMicroUsd: 7 },
        fallback: { modelId: 'sk-live-abcdefghijklmnopqrstuvwxyz123456', reservedMicroUsd: 9 },
      },
    });

    const firstSubmit = await submitAttempt(request, plan, first, provider('primary'), plan.taskDeadlineMs, `${taskId}:a0:submit`, client);
    if (firstSubmit.status !== 'SUBMITTED') throw new Error(`first submit rejected: ${JSON.stringify(firstSubmit)}`);
    const firstPage = await pollObservations(first, 0, plan.taskDeadlineMs, client);
    expect(firstPage.observations[0]).toMatchObject({ kind: 'failure', failure: { code: 'connection', failureClass: 'retryable' } });
    expect((await recordObservation(first, firstPage.observations[0]!, `${taskId}:a0:observation`, client)).status).toBe('RECORDED');
    const transitioned = await transitionOnce(first, 'fallback', firstPage.observations[0]!.failure!, 250, plan.taskDeadlineMs, planHash(plan), `${taskId}:a0:transition`, client);
    expect(transitioned.status).toBe('TRANSITIONED');
    const second = transitioned.successor!;
    let secondSubmit = await submitAttempt(request, plan, second, provider('fallback'), plan.taskDeadlineMs, `${taskId}:a1:submit`, client);
    for (let attempt = 0; secondSubmit.status === 'NOT_READY' && attempt < 10; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, secondSubmit.retryAfterMs ?? 1));
      secondSubmit = await submitAttempt(request, plan, second, provider('fallback'), plan.taskDeadlineMs, `${taskId}:a1:submit`, client);
    }
    expect(secondSubmit.status).toBe('SUBMITTED');
    const secondPage = await pollObservations(second, 0, plan.taskDeadlineMs, client);
    expect(secondPage.observations[0]).toMatchObject({ kind: 'result', dispatchAttempted: false });
    await recordObservation(second, secondPage.observations[0]!, `${taskId}:a1:observation`, client);

    await storage.reconcileGatewayProjection(async (afterCursor, limit) => {
      const page = await pageOutbox(afterCursor, limit, client);
      fakeOutbox.push(...page.events);
      return page;
    });
    expect(fakeOutbox.length).toBeGreaterThan(0);
    expect(fakeOutbox.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'attempt_created', 'state_mutated', 'provider_event', 'transitioned', 'cost_recorded', 'attempt_completed',
    ]));

    receipts.materializeReceipt(taskId);
    const row = receipts.getReceipt(taskId)!;
    expect(storage.getFailoverProjection(taskId)).toMatchObject({ active_attempt_id: null, terminal_outcome: 'completed' });
    const full = JSON.parse(row.full_receipt_json) as { providerAttempts: Array<{ epoch: number; cost: Record<string, unknown>; providerId: string; transitionDecision: string | null; terminalOutcome: string | null }>; finalProviderId: string };
    expect(full.providerAttempts.map((attempt) => [attempt.epoch, attempt.cost])).toEqual([
      [0, { reservedMicroUsd: 7, actualMicroUsd: null, known: false, source: 'unavailable' }],
      [1, { reservedMicroUsd: 9, actualMicroUsd: null, known: false, source: 'unavailable' }],
    ]);
    expect(full.providerAttempts.map((attempt) => [attempt.transitionDecision, attempt.terminalOutcome])).toEqual([
      ['transitioned', null], [null, 'completed'],
    ]);
    expect(full.finalProviderId).toBe('fallback');
    const safe = buildSafeExport(row, [], REDACTOR_VERSION);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz123456');
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(serialized).not.toContain('must not export');
    expect(safe.providerAttempts?.[0]?.cost).toEqual({ reservedMicroUsd: 7, actualMicroUsd: null, known: false, source: 'unavailable' });
    expect(safe.providerAttempts?.[1]?.cost).toEqual({ reservedMicroUsd: 9, actualMicroUsd: null, known: false, source: 'unavailable' });
  }, 15_000);
});
