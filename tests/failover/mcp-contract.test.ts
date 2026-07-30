import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  admitFrontier,
  executeHermesAttempt,
  pageOutbox,
  pollObservations,
  signalProviderCancel,
  submitAttempt,
  transitionOnce,
  type ProviderReference,
  type ResilienceClient,
} from '../../packages/bridge/src/hermesAttempt.js';

const contract = JSON.parse(readFileSync('tests/failover/fixtures/mcp_contract.json', 'utf8')) as {
  tools: Record<string, { arguments: string[] }>;
  cancelTaskArguments: string[];
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

function jsonResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

describe('shared FastMCP contract', () => {
  it('sends exactly the snake_case submit and poll arguments', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client: ResilienceClient = {
      async callTool(call) {
        calls.push(call);
        if (call.name === 'resilience_submit_attempt') return jsonResult({ status: 'SUBMITTED', activeTuple: active });
        return jsonResult({ status: 'OBSERVATIONS', cursor: 0, observations: [], terminal: false });
      },
    };
    await submitAttempt({ prompt: 'x' }, plan, active, provider, 9_000, 'submit', client);
    await pollObservations(active, 0, 9_000, client);
    expect(Object.keys(calls[0]!.arguments)).toEqual(contract.tools.resilience_submit_attempt.arguments);
    expect(Object.keys(calls[1]!.arguments)).toEqual(contract.tools.resilience_poll_observations.arguments);
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

  it('passes successor provider, plan hash, and stable attempt id to the boundary', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client: ResilienceClient = {
      async callTool(call) {
        calls.push(call);
        return jsonResult({ status: 'TRANSITIONED', successor: { taskId: active.taskId, attemptId: 'next', epoch: 1 }, successorProviderId: 'fallback' });
      },
    };
    await transitionOnce(active, 'fallback', { failureClass: 'retryable', code: 'connection', retryable: true }, 250, 9_000, 'a'.repeat(64), 'transition', client);
    expect(calls[0]!.arguments.successor_provider_id).toBe('fallback');
    expect(calls[0]!.arguments.plan_hash).toBe('a'.repeat(64));
    expect(Object.keys(calls[0]!.arguments)).toEqual(contract.tools.resilience_transition_once.arguments);

    const cancelCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await signalProviderCancel(active, 'timeout', {
      async callTool(call) {
        cancelCalls.push(call);
        return jsonResult({ status: 'noop' });
      },
    });
    expect(cancelCalls[0]!.arguments).toEqual({ task_id: active.attemptId, reason: 'timeout' });
    expect(Object.keys(cancelCalls[0]!.arguments)).toEqual(contract.cancelTaskArguments);
  });

  it('requires the normalized PAGE/cursor/highWaterMark response', async () => {
    await expect(pageOutbox(0, 10, {
      async callTool() { return jsonResult({ status: 'PAGE', cursor: 0, highWaterMark: 0, events: [] }); },
    })).resolves.toMatchObject({ status: 'PAGE', cursor: 0, highWaterMark: 0 });
  });

  it('preserves durable dispatchAttempted on result and failure terminals', async () => {
    const result = await executeHermesAttempt(
      { prompt: 'result' }, plan, active, provider, () => undefined,
      {
        nowMs: () => 1_000,
        sleepMs: async () => undefined,
        client: {
          async callTool(call) {
            if (call.name === 'resilience_submit_attempt') return jsonResult({ status: 'SUBMITTED', activeTuple: active });
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
      { prompt: 'failure' }, plan, active, provider, () => undefined,
      {
        nowMs: () => 1_000,
        sleepMs: async () => undefined,
        client: {
          async callTool(call) {
            if (call.name === 'resilience_submit_attempt') return jsonResult({ status: 'SUBMITTED', activeTuple: active });
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
      { prompt: 'timeout after fence' }, plan, active, provider, () => undefined,
      {
        nowMs: () => now,
        sleepMs: async () => { now = 2_000; },
        client: {
          async callTool(call) {
            if (call.name === 'resilience_submit_attempt') return jsonResult({ status: 'SUBMITTED', activeTuple: active });
            return jsonResult({
              status: 'OBSERVATIONS', cursor: 1, terminal: false,
              observations: [{ kind: 'progress', dispatchAttempted: true }],
            });
          },
        },
      },
    );

    expect(timeout.dispatchAttempted).toBe(true);
    expect(timeout.observation).toEqual({ kind: 'timeout', dispatchAttempted: true });
  });
});
