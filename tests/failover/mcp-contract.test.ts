import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  admitFrontier,
  executeHermesAttempt,
  finalizeAttempt,
  recoverAndTransitionOnce,
  requestCancel,
  pageOutbox,
  pollObservations,
  signalProviderCancel,
  signalAttemptTimeout,
  getStatus,
  submitAttempt,
  transitionOnce,
  type ProviderReference,
  type ResilienceClient,
} from '../../packages/bridge/src/hermesAttempt.js';

const contract = JSON.parse(readFileSync('tests/failover/fixtures/mcp_contract.json', 'utf8')) as {
  tools: Record<string, { arguments: string[] }>;
  cancelTaskArguments: string[];
  argumentObjects: Record<string, Record<string, unknown>>;
};
const active = { taskId: 'contract-task', attemptId: 'contract-attempt', epoch: 0 } as const;
const plan = {
  schemaVersion: 1, taskId: active.taskId, chainId: 'contract', eligibleProviderIds: ['primary', 'fallback'],
  privacyClass: 'standard', privacyHash: 'a'.repeat(64), policyHash: 'b'.repeat(64),
  contextHash: 'c'.repeat(64), grantHash: 'd'.repeat(64), taskDeadlineMs: 10_000,
  attemptTimeoutMs: 1_000, transitionLimit: 1, budgetMicroUsd: null,
  providerCeilings: { primary: 1, fallback: 1 }, featurePolicyRevision: 'rev', planRevision: '1',
} as const;
const provider: ProviderReference = {
  id: 'primary', label: 'Primary', modelId: 'model', apiKeyEnvName: 'KEY', baseUrlEnvName: 'BASE',
};
const gatewayRequest = {
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  sourceChannel: 'test',
  receivedAt: '2026-07-30T12:00:00.000Z',
  payload: { prompt: 'x', assembledContext: '', contextSize: 1, requiredTools: [], taskType: 'COMPLEX_CODING', grantedTools: [] },
  constraints: { latencySensitivity: 'LOW', maxCost: 1, containsSensitiveData: false, executionMode: 'CLOUD_OK' },
  enrichment: { classifierUsed: 'DEFAULT', classifierConfidence: 1, classifierLatencyMs: 0, estimatedTokens: 1, memoryUsed: false },
};

function fixtureArguments(name: string): Record<string, unknown> {
  const replace = (value: unknown): unknown => {
    if (value === '$plan') return plan;
    if (value === '$active') return active;
    if (value === '$gatewayRequest') return gatewayRequest;
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  return replace(contract.argumentObjects[name]) as Record<string, unknown>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

describe('shared FastMCP contract', () => {
  it('sends the exact complete argument objects from the shared fixture', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client: ResilienceClient = {
      async callTool(call) {
        calls.push(call);
        if (call.name === 'resilience_submit_attempt') return jsonResult({ status: 'SUBMITTED', activeTuple: active, executionState: 'STARTED' });
        return jsonResult({ status: 'OBSERVATIONS', cursor: 0, observations: [], terminal: false });
      },
    };
    await submitAttempt(gatewayRequest, plan, active, provider, 9_000, 'submit', client);
    await pollObservations(active, 0, 9_000, client);
    expect(calls[0]!.arguments).toEqual(fixtureArguments('resilience_submit_attempt'));
    expect(calls[1]!.arguments).toEqual(fixtureArguments('resilience_poll_observations'));
    expect(calls.flatMap((call) => Object.keys(call.arguments))).not.toContain('activeTuple');
    expect(calls.flatMap((call) => Object.keys(call.arguments))).not.toContain('attemptDeadlineMs');
  });

  it('rejects old Python response keys at the single bridge parser boundary', async () => {
    const oldKeys: ResilienceClient = {
      async callTool() {
        return jsonResult({ status: 'OK', observations: [], nextCursor: 1 });
      },
    };
    await expect(pollObservations(active, 0, 9_000, oldKeys)).rejects.toThrow('invalid poll response');
  });

  it('accepts only a marker that matches the committed terminal observation', async () => {
    await expect(pollObservations(active, 0, 9_000, {
      async callTool() {
        return jsonResult({
          status: 'TERMINAL', cursor: 1, terminal: true, terminalCommitted: true,
          terminalOutcome: 'completed', observations: [{ kind: 'result', dispatchAttempted: false, text: 'done' }],
        });
      },
    })).resolves.toMatchObject({ terminalCommitted: true, terminalOutcome: 'completed' });

    await expect(pollObservations(active, 0, 9_000, {
      async callTool() {
        return jsonResult({
          status: 'TERMINAL', cursor: 1, terminal: true, terminalCommitted: true,
          terminalOutcome: 'failed', observations: [{ kind: 'result', dispatchAttempted: false, text: 'done' }],
        });
      },
    })).rejects.toThrow('terminal marker does not match observation');

    await expect(pollObservations(active, 0, 9_000, {
      async callTool() {
        return jsonResult({ status: 'TERMINAL', cursor: 1, terminal: true, observations: [{ kind: 'result', dispatchAttempted: false, text: 'done' }] });
      },
    })).resolves.toMatchObject({ terminalCommitted: false });
  });

  it('passes successor provider, plan hash, and stable attempt id to the boundary', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client: ResilienceClient = {
      async callTool(call) {
        calls.push(call);
        return jsonResult({ status: 'TRANSITIONED', successor: { taskId: active.taskId, attemptId: 'next', epoch: 1 }, successorProviderId: 'fallback', successorSubmitNotBeforeMs: 500 });
      },
    };
    await transitionOnce(active, 'fallback', { failureClass: 'retryable', code: 'connection', retryable: true }, 250, 9_000, 'a'.repeat(64), 'transition', client);
    expect(calls[0]!.arguments).toEqual(fixtureArguments('resilience_transition_once'));

    const cancelCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await signalProviderCancel(active, 'timeout', {
      async callTool(call) {
        cancelCalls.push(call);
        return jsonResult({ status: 'noop' });
      },
    });
    expect(cancelCalls[0]!.arguments).toEqual({ task_id: active.attemptId, reason: 'timeout' });
    expect(Object.keys(cancelCalls[0]!.arguments)).toEqual(contract.cancelTaskArguments);

    const requestCancelCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await requestCancel(active, 'cancel', {
      async callTool(call) { requestCancelCalls.push(call); return jsonResult({ status: 'ACK_CANCELLED' }); },
    });
    expect(requestCancelCalls[0]!.arguments).toEqual(fixtureArguments('resilience_request_cancel'));

    const timeoutCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await expect(signalAttemptTimeout(active, {
      async callTool(call) {
        timeoutCalls.push(call);
        return jsonResult({ status: 'ACK_PRE_DISPATCH', activeTuple: active, dispatchAttempted: false });
      },
    })).resolves.toMatchObject({ status: 'ACK_PRE_DISPATCH', dispatchAttempted: false });
    expect(timeoutCalls[0]!.arguments).toEqual(fixtureArguments('attempt_timeout'));
  });

  it('rejects zero jitter before MCP and rejects zero-fence successor replies', async () => {
    const failure = { failureClass: 'retryable', code: 'connection', retryable: true } as const;
    const recoveryFailure = { failureClass: 'retryable', code: 'pre_dispatch_timeout', retryable: true } as const;
    let calls = 0;
    const mustNotCall: ResilienceClient = {
      async callTool() {
        calls += 1;
        throw new Error('zero jitter must be rejected before MCP');
      },
    };

    await expect(transitionOnce(
      active, 'fallback', failure, 0, 9_000, 'a'.repeat(64), 'zero-transition', mustNotCall,
    )).rejects.toThrow('jitter is outside the bounded range');
    await expect(recoverAndTransitionOnce(
      active, 'zero-recovery', 0, recoveryFailure, mustNotCall,
    )).rejects.toThrow('recovery jitter must be exactly 250ms');
    expect(calls).toBe(0);

    await expect(transitionOnce(
      active, 'fallback', failure, 250, 9_000, 'a'.repeat(64), 'zero-fence-transition', {
        async callTool() {
          return jsonResult({
            status: 'TRANSITIONED', successor: { taskId: active.taskId, attemptId: 'next', epoch: 1 },
            successorProviderId: 'fallback', successorSubmitNotBeforeMs: 0,
          });
        },
      },
    )).rejects.toThrow('transition response lacks a valid submit fence');
    await expect(recoverAndTransitionOnce(
      active, 'zero-fence-recovery', 250, recoveryFailure, {
        async callTool() {
          return jsonResult({
            status: 'RECOVERED', successor: { taskId: active.taskId, attemptId: 'next', epoch: 1 },
            successorProviderId: 'fallback', successorSubmitNotBeforeMs: 0,
          });
        },
      },
    )).rejects.toThrow('recovery response lacks a submit fence');
  });

  it('sends the two fused transition fields all-or-none and validates observation-only replies', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const fusedClient: ResilienceClient = {
      async callTool(call) {
        calls.push(call);
        return jsonResult({ status: 'OBSERVATION_RECORDED', observationIdempotencyKey: 'observation' });
      },
    };
    await expect(transitionOnce(
      active, 'fallback', { failureClass: 'retryable', code: 'connection', retryable: true },
      250, 9_000, 'a'.repeat(64), 'transition', fusedClient, 'gateway', 'observation',
    )).resolves.toMatchObject({ status: 'OBSERVATION_RECORDED' });
    expect(calls[0]!.arguments.failure_source).toBe('gateway');
    expect(calls[0]!.arguments.observation_idempotency_key).toBe('observation');
    await expect(transitionOnce(
      active, 'fallback', { failureClass: 'retryable', code: 'connection', retryable: true },
      250, 9_000, 'a'.repeat(64), 'transition', fusedClient, 'gateway',
    )).rejects.toThrow('fused transition fields must be supplied together');
  });

  it('accepts the persisted cancellation-pending status without accepting a malformed bit', async () => {
    await expect(getStatus(active.taskId, {
      async callTool() {
        return jsonResult({ status: 'CANCEL_PENDING', activeTuple: active, providerId: 'primary', dispatchAttempted: false, cancellationRequested: true, taskDeadlineMs: 10_000, attemptState: 'cancel_requested', executionSubmitted: true, providerSubmitNotBeforeMs: 0 });
      },
    })).resolves.toMatchObject({ status: 'CANCEL_PENDING', cancellationRequested: true });
    await expect(getStatus(active.taskId, {
      async callTool() {
        return jsonResult({ status: 'CANCEL_PENDING', activeTuple: active, providerId: 'primary', dispatchAttempted: false, cancellationRequested: false, taskDeadlineMs: 10_000, attemptState: 'cancel_requested', executionSubmitted: true, providerSubmitNotBeforeMs: 0 });
      },
    })).rejects.toThrow('cancellation-pending status lacks the cancellation bit');
  });

  it('sends the exact four-argument recovery contract', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await recoverAndTransitionOnce(active, 'contract-task:contract-attempt:0:startup-recovery:v1', 250, { failureClass: 'retryable', code: 'pre_dispatch_timeout', retryable: true }, {
      async callTool(call) {
        calls.push(call);
        return jsonResult({ status: 'TERMINAL' });
      },
    });
    expect(calls[0]!.arguments).toEqual(fixtureArguments('resilience_recover_and_transition_once'));
    expect(Object.keys(calls[0]!.arguments)).toEqual(contract.tools.resilience_recover_and_transition_once.arguments);
  });

  it('requires the normalized PAGE/cursor/highWaterMark response', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await expect(pageOutbox(0, 10, {
      async callTool(call) { calls.push(call); return jsonResult({ status: 'PAGE', cursor: 0, highWaterMark: 0, events: [] }); },
    })).resolves.toMatchObject({ status: 'PAGE', cursor: 0, highWaterMark: 0 });
    expect(calls[0]!.arguments).toEqual(fixtureArguments('resilience_page_outbox'));
  });

  it('accepts only the allowlisted additive cost-source extension on outbox facts', async () => {
    const costEvent = {
      outboxId: 1, taskId: active.taskId, attemptId: active.attemptId, epoch: 0, createdAtMs: 1,
      kind: 'cost_recorded', payload: { actualCostMicroUsd: 2, known: true, source: 'account_delta' },
    };
    await expect(pageOutbox(0, 10, {
      async callTool() { return jsonResult({ status: 'PAGE', cursor: 1, highWaterMark: 1, events: [costEvent] }); },
    })).resolves.toMatchObject({ cursor: 1, events: [costEvent] });
    await expect(pageOutbox(0, 10, {
      async callTool() { return jsonResult({ status: 'PAGE', cursor: 1, highWaterMark: 1, events: [{ ...costEvent, payload: { ...costEvent.payload, source: 'provider-prose' } }] }); },
    })).rejects.toThrow('outbox event is invalid');
  });

  it('compares record, cancel, status, and admission arguments byte-for-byte', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client: ResilienceClient = {
      async callTool(call) {
        calls.push(call);
        if (call.name === 'resilience_get_status') return jsonResult({ status: 'ACTIVE', activeTuple: active, providerId: 'primary', dispatchAttempted: false, cancellationRequested: false, taskDeadlineMs: 10_000, attemptState: 'active', executionSubmitted: false, providerSubmitNotBeforeMs: 0 });
        if (call.name === 'resilience_admit_frontier') return jsonResult({ status: 'ADMITTED', activeTuple: active });
        return jsonResult({ status: call.name === 'resilience_record_observation' ? 'RECORDED' : 'ACK_CANCELLED' });
      },
    };
    await admitFrontier(active.taskId, plan, ['primary', 'fallback'], 10_000, 'admit', client);
    await (await import('../../packages/bridge/src/hermesAttempt.js')).recordObservation(active, { kind: 'progress', dispatchAttempted: false }, 'record', client);
    await (await import('../../packages/bridge/src/hermesAttempt.js')).getStatus(active.taskId, client);
    await finalizeAttempt(active, { failureClass: 'retryable', code: 'connection', retryable: true }, 'engine', 'failed', 'finalize', {
      async callTool(call) { calls.push(call); return jsonResult({ status: 'FINALIZED', outcome: 'failed' }); },
    });
    expect(calls.find((call) => call.name === 'resilience_admit_frontier')!.arguments).toEqual({ ...fixtureArguments('resilience_admit_frontier'), request_id: active.taskId, immutable_plan: plan, deadline_at: 10_000, provider_order: ['primary', 'fallback'] });
    expect(calls.find((call) => call.name === 'resilience_record_observation')!.arguments).toEqual(fixtureArguments('resilience_record_observation'));
    expect(calls.find((call) => call.name === 'resilience_get_status')!.arguments).toEqual(fixtureArguments('resilience_get_status'));
    expect(calls.find((call) => call.name === 'resilience_finalize_attempt')!.arguments).toEqual(fixtureArguments('resilience_finalize_attempt'));
  });

  it('preserves durable dispatchAttempted on result and failure terminals', async () => {
    const result = await executeHermesAttempt(
      gatewayRequest, plan, active, provider, () => undefined,
      {
        nowMs: () => 1_000,
        sleepMs: async () => undefined,
        client: {
          async callTool(call) {
            if (call.name === 'resilience_submit_attempt') return jsonResult({ status: 'SUBMITTED', activeTuple: active, executionState: 'STARTED' });
            return jsonResult({
              status: 'TERMINAL', cursor: 1, terminal: true,
              observations: [{ kind: 'result', text: 'done', dispatchAttempted: true }],
            });
          },
        },
      },
    );
    expect(result.dispatchAttempted).toBe(true);
    expect(result.observation?.dispatchAttempted).toBe(true);

    const failure = await executeHermesAttempt(
      gatewayRequest, plan, active, provider, () => undefined,
      {
        nowMs: () => 1_000,
        sleepMs: async () => undefined,
        client: {
          async callTool(call) {
            if (call.name === 'resilience_submit_attempt') return jsonResult({ status: 'SUBMITTED', activeTuple: active, executionState: 'STARTED' });
            return jsonResult({
              status: 'TERMINAL', cursor: 1, terminal: true,
              observations: [{
                kind: 'failure', dispatchAttempted: true,
                failure: { failureClass: 'terminal', code: 'engine_failure', retryable: false },
              }],
            });
          },
        },
      },
    );
    expect(failure.dispatchAttempted).toBe(true);
    expect(failure.observation?.dispatchAttempted).toBe(true);
  });

  it('preserves a progress dispatch fence when the attempt times out', async () => {
    let now = 1_000;
    const timeout = await executeHermesAttempt(
      gatewayRequest, plan, active, provider, () => undefined,
      {
        nowMs: () => now,
        sleepMs: async () => { now = 2_000; },
        client: {
          async callTool(call) {
            if (call.name === 'resilience_submit_attempt') return jsonResult({ status: 'SUBMITTED', activeTuple: active, executionState: 'STARTED' });
            return jsonResult({
              status: 'OBSERVATIONS', cursor: 1, terminal: false,
              observations: [{ kind: 'progress', dispatchAttempted: true }],
            });
          },
        },
      },
    );

    expect(timeout.dispatchAttempted).toBe(true);
    expect(timeout.observation).toEqual({ kind: 'timeout', dispatchAttempted: true, failureSource: 'gateway' });
  });
});
