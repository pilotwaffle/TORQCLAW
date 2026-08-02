import { describe, expect, it } from 'vitest';
import type { GatewayRequest } from '@torqclaw/contracts';
import {
  classifyProviderFailure,
  normalizeProviderFailure,
  decideTransition,
  jitterDelayMs,
  persistFirstCancel,
  validateSuccessorTuple,
  waitAbortable,
} from '../../packages/gateway/src/failover.js';
import { buildFailoverPlan, isFailoverEnabled, parseProviderChainsDocument, resolveProviderChain } from '../../packages/gateway/src/providerChains.js';
import { ResilienceEnvelopeError, admitFrontier, transitionOnce, type ResilienceClient } from '../../packages/bridge/src/hermesAttempt.js';

const request = {
  id: 'task-failover-1',
  sessionId: 'session-failover-1',
  sourceChannel: 'test',
  receivedAt: '2026-07-30T12:00:00.000Z',
  payload: {
    prompt: 'do work',
    assembledContext: 'context',
    contextSize: 7,
    requiredTools: [],
    taskType: 'COMPLEX_CODING',
    grantedTools: [],
  },
  constraints: {
    latencySensitivity: 'LOW',
    maxCost: 1.5,
    containsSensitiveData: false,
    executionMode: 'CLOUD_OK',
  },
  enrichment: {
    classifierUsed: 'DEFAULT',
    classifierConfidence: 1,
    classifierLatencyMs: 0,
    estimatedTokens: 10,
    memoryUsed: true,
  },
} as GatewayRequest;

const document = parseProviderChainsDocument({
  revision: 'rev-1',
  chains: {
    coding: {
      id: 'coding',
      providers: [
        { id: 'primary', label: 'Primary', modelId: 'model-a', apiKeyEnvName: 'HERMES_API_KEY', baseUrlEnvName: 'HERMES_BASE_URL', privacyClasses: ['standard', 'sensitive'], ceilingMicroUsd: 1000000 },
        { id: 'fallback', label: 'Fallback', modelId: 'model-b', apiKeyEnvName: 'HERMES_FALLBACK_API_KEY', baseUrlEnvName: 'HERMES_FALLBACK_BASE_URL', privacyClasses: ['standard', 'sensitive'], ceilingMicroUsd: 1000000 },
      ],
    },
  },
});

describe('Phase 1 failover core', () => {
  it.each([
    [{ providerCode: 'connection' }, 'retryable', 'connection'],
    [{ providerCode: 'dns' }, 'retryable', 'dns'],
    [{ httpStatus: 408 }, 'retryable', 'http_408'],
    [{ httpStatus: 429 }, 'retryable', 'http_429'],
    [{ httpStatus: 503 }, 'retryable', 'http_5xx'],
    [{ httpStatus: 400 }, 'configuration', 'http_400'],
    [{ httpStatus: 404 }, 'configuration', 'http_404'],
    [{ httpStatus: 401 }, 'authentication', 'http_401'],
    [{ httpStatus: 403 }, 'authentication', 'http_403'],
    [{ providerCode: 'unknown-provider-status' }, 'terminal', 'unknown'],
    [{ providerCode: 'connection', dispatchAttempted: true }, 'side_effect_uncertainty', 'dispatch_attempted'],
  ] as const)('classifies %j as %s/%s', (input, failureClass, code) => {
    expect(classifyProviderFailure(input)).toEqual({ failureClass, code, retryable: failureClass === 'retryable' });
  });

  it('dispatch uncertainty and cancellation take precedence over retryable transport', () => {
    expect(classifyProviderFailure({ timedOut: true, cancelled: true })).toMatchObject({ failureClass: 'cancelled' });
    expect(classifyProviderFailure({ providerCode: 'connection', dispatchAttempted: true })).toMatchObject({ failureClass: 'side_effect_uncertainty' });
  });

  it('builds a two-provider plan with hashes and no provider values', () => {
    const chain = resolveProviderChain(request, document, { TORQCLAW_FAILOVER_CODING_CHAIN: 'coding' });
    const plan = buildFailoverPlan(request, chain, { nowMs: 1000, env: { TORQCLAW_PROVIDER_CHAIN_REVISION: 'rev-1', TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '10000', TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '1000' } });
    expect(plan.eligibleProviderIds).toEqual(['primary', 'fallback']);
    expect(plan.transitionLimit).toBe(1);
    expect(plan.taskDeadlineMs).toBe(11000);
    expect(plan.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(plan)).not.toContain('HERMES_API_KEY');
  });

  it('defaults an attempt to sixty seconds and normalizes typed transport failures without raw text', () => {
    const chain = resolveProviderChain(request, document, { TORQCLAW_FAILOVER_CODING_CHAIN: 'coding' });
    expect(buildFailoverPlan(request, chain, { nowMs: 1_000, env: {} }).attemptTimeoutMs).toBe(60_000);
    expect(normalizeProviderFailure(Object.assign(new Error('SECRET_RAW_MARKER'), { code: 'ECONNRESET' }))).toEqual({ failureClass: 'retryable', code: 'connection', retryable: true });
    expect(normalizeProviderFailure({ response: { status: 401 }, body: 'SECRET_RAW_MARKER' })).toEqual({ failureClass: 'authentication', code: 'http_401', retryable: false });
    expect(JSON.stringify(normalizeProviderFailure({ code: 'unknown', message: 'SECRET_RAW_MARKER' }))).not.toContain('SECRET_RAW_MARKER');
  });

  it('rejects inline endpoint/credential values and non-two-provider chains', () => {
    expect(() => parseProviderChainsDocument({ revision: 'r', chains: { default: { id: 'default', providers: [{ id: 'p1', label: 'p1', modelId: 'm', apiKeyEnvName: 'KEY', baseUrlEnvName: 'URL', privacyClasses: ['standard'], ceilingMicroUsd: 1, apiKey: 'secret' }, { id: 'p2', label: 'p2', modelId: 'm', apiKeyEnvName: 'KEY2', baseUrlEnvName: 'URL2', privacyClasses: ['standard'], ceilingMicroUsd: 1 }] } } })).toThrow(/not allowed/);
    expect(() => parseProviderChainsDocument({ revision: 'r', chains: { default: { id: 'default', providers: [{ id: 'p1', label: 'p1', modelId: 'm', apiKeyEnvName: 'KEY', baseUrlEnvName: 'URL', privacyClasses: ['standard'], ceilingMicroUsd: 1 }] } } })).toThrow(/exactly two/);
  });

  it('keeps the precedence trace ordered and blocks non-eligible failures', () => {
    const failure = classifyProviderFailure({ providerCode: 'connection' });
    const allowed = decideTransition({ activeExact: true, dispatchAttempted: false, cancellationRequested: false, nowMs: 100, deadlineMs: 200, successorExists: true, successorDiffers: true, successorLater: true, transitionCount: 0, privacyEligible: true, budgetAvailable: true, circuitOpen: false, failure });
    expect(allowed.allowed).toBe(true);
    expect(allowed.trace.at(0)).toBe('active_exact_tuple:pass');
    expect(allowed.trace.at(-1)).toBe('retryable_failure:pass');
    const blocked = decideTransition({ activeExact: true, dispatchAttempted: true, cancellationRequested: false, nowMs: 100, deadlineMs: 200, successorExists: true, successorDiffers: true, successorLater: true, transitionCount: 0, privacyEligible: true, budgetAvailable: true, circuitOpen: false, failure });
    expect(blocked.reason).toBe('dispatch_attempted');
  });

  it('defers authoritative policy facts to the ledger instead of asserting them in the gateway', () => {
    const decision = decideTransition({
      activeExact: true,
      dispatchAttempted: false,
      cancellationRequested: false,
      nowMs: 100,
      deadlineMs: 200,
      successorExists: true,
      successorDiffers: true,
      successorLater: true,
      transitionCount: 0,
      failure: classifyProviderFailure({ providerCode: 'connection' }),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.authorityDeferred).toBe(true);
    expect(decision.reason).toBe('policy_authority_deferred');
    expect(decision.trace).toContain('privacy_eligible:deferred');
    expect(decision.trace).toContain('budget_available:deferred');
    expect(decision.trace).toContain('circuit_closed:deferred');
  });

  it.each([
    ['privacyEligible', { privacyEligible: false }, 'privacy_ineligible'],
    ['budgetAvailable', { budgetAvailable: false }, 'budget_unavailable'],
    ['circuitOpen', { circuitOpen: true }, 'circuit_open'],
  ] as const)('blocks an explicit authoritative %s denial', (_name, policy, reason) => {
    const decision = decideTransition({
      activeExact: true,
      dispatchAttempted: false,
      cancellationRequested: false,
      nowMs: 100,
      deadlineMs: 200,
      successorExists: true,
      successorDiffers: true,
      successorLater: true,
      transitionCount: 0,
      ...policy,
      failure: classifyProviderFailure({ providerCode: 'connection' }),
    });

    expect(decision).toMatchObject({ allowed: false, authorityDeferred: false, reason });
  });

  it('uses inclusive deterministic jitter bounds', () => {
    expect(jitterDelayMs(() => 0)).toBe(250);
    expect(jitterDelayMs(() => 0.999999)).toBe(750);
  });

  it('aborts jitter without waiting and keeps feature-off state explicit', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await waitAbortable(750, controller.signal, async () => { throw new Error('sleep must not run'); })).toBe('aborted');
    expect(isFailoverEnabled({ TORQCLAW_PROVIDER_FAILOVER_ENABLED: 'false' })).toBe(false);
  });

  it('accepts exactly one ordered successor and rejects stale/replayed tuples', () => {
    expect(validateSuccessorTuple({ taskId: 't', attemptId: 'a0', epoch: 0 }, { taskId: 't', attemptId: 'a1', epoch: 1 }, ['p1', 'p2'])).toBe(true);
    expect(validateSuccessorTuple({ taskId: 't', attemptId: 'a0', epoch: 0 }, { taskId: 't', attemptId: 'a2', epoch: 2 }, ['p1', 'p2'])).toBe(false);
    expect(validateSuccessorTuple({ taskId: 't', attemptId: 'a0', epoch: 0 }, { taskId: 't', attemptId: 'a0', epoch: 1 }, ['p1', 'p2'])).toBe(false);
  });

  it('persists cancellation before signaling transport', async () => {
    const order: string[] = [];
    const outcome = await persistFirstCancel(
      async () => { order.push('persist'); return { status: 'ACK_CANCELLED' }; },
      async () => { order.push('signal'); return 'cancelled'; },
    );
    expect(outcome).toBe('cancelled');
    expect(order).toEqual(['persist', 'signal']);
  });

  it.each([
    ['noop', 'cancelled_uncertain'],
    ['unknown', 'cancelled_uncertain'],
  ] as const)('treats provider stop %s as %s after persistence', async (signalStatus, expected) => {
    const order: string[] = [];
    expect(await persistFirstCancel(
      async () => { order.push('persist'); return { status: 'ACK_CANCELLED' }; },
      async () => { order.push('signal'); return signalStatus; },
    )).toBe(expected);
    expect(order).toEqual(['persist', 'signal']);
  });

  it('treats provider stop transport failure as cancelled_uncertain', async () => {
    expect(await persistFirstCancel(
      async () => ({ status: 'ACK_CANCELLED' }),
      async () => { throw new Error('transport lost'); },
    )).toBe('cancelled_uncertain');
  });
});

describe('bridge envelope and tuple bindings', () => {
  it('propagates the exact tuple and rejects malformed envelopes', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client: ResilienceClient = {
      async callTool(args) {
        calls.push(args);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'ADMITTED', activeTuple: { taskId: 't', attemptId: 'a', epoch: 0 } }) }] };
      },
    };
    const tuple = { taskId: 't', attemptId: 'a', epoch: 0 } as const;
    const chain = resolveProviderChain(request, document, { TORQCLAW_FAILOVER_CODING_CHAIN: 'coding' });
    const plan = buildFailoverPlan({ ...request, id: 't' }, chain, { nowMs: 0, env: { TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '1000', TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '100' } });
    const result = await admitFrontier('t', plan, ['p1', 'p2'], 1000, 'idempotency', client);
    expect(result.activeTuple).toEqual(tuple);
    expect(calls[0]?.arguments.request_id).toBe('t');
    await expect(transitionOnce(tuple, 'p2', { failureClass: 'retryable', code: 'connection', retryable: true }, 250, 1000, 'a'.repeat(64), 'i', {
      async callTool() { return { content: [{ type: 'text', text: '{"status":"TRANSITIONED","successor":{"taskId":"t","attemptId":"a2","epoch":1},"successorProviderId":"p2","successorSubmitNotBeforeMs":500}' }] }; },
    })).resolves.toMatchObject({ status: 'TRANSITIONED', successor: { taskId: 't', epoch: 1 } });
    await expect(admitFrontier('t', plan, ['p1', 'p2'], 1000, 'idempotency', {
      async callTool() { return { content: [{ type: 'text', text: '{"status":"ADMITTED","activeTuple":{"taskId":"t"}}' }] }; },
    })).rejects.toBeInstanceOf(ResilienceEnvelopeError);
  });
});
