import { describe, expect, it } from 'vitest';
import {
  ClientCommandSchema,
  ComputeTier,
  GatewayRequestSchema,
  type GatewayRequest,
  type SubscriptionExecutionTarget,
} from '@torqclaw/contracts';
import { TorqClawRouter } from '../packages/router/src/engine.js';
import { RULE_LABELS } from '../apps/console/src/components/friendly.js';
import { makeRequest } from './helpers.js';

const TARGET: SubscriptionExecutionTarget = {
  providerId: 'qwen-subscription',
  providerAccountId: 'qwen-subscription',
  adapterId: 'qwen-subscription:canonical',
  modelId: 'qwen3.8-max-preview',
  exactModelId: 'qwen3.8-max-preview',
  runtimeFingerprint: 'a'.repeat(64),
  personaRevision: 0,
  personaContentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  confirmed: true,
};

function withTarget(overrides: Parameters<typeof makeRequest>[0] = {}): GatewayRequest {
  const request = makeRequest(overrides);
  request.id = '33333333-3333-4333-8333-333333333333';
  request.sessionId = '44444444-4444-4444-8444-444444444444';
  request.payload.subscriptionExecutionTarget = TARGET;
  return request;
}

describe('gateway-owned subscription routing policy', () => {
  it('accepts a strict confirmed execution target only on GatewayRequest.payload', () => {
    const parsed = GatewayRequestSchema.parse(withTarget());
    expect(parsed.payload.subscriptionExecutionTarget).toEqual(TARGET);
    expect(() => GatewayRequestSchema.parse({
      ...withTarget(),
      payload: {
        ...withTarget().payload,
        subscriptionExecutionTarget: { ...TARGET, confirmed: false },
      },
    })).toThrow();
  });

  it('does not accept a subscription target from a ClientCommand/websocket frame', () => {
    const parsed = ClientCommandSchema.parse({
      action: 'SUBMIT_PROMPT',
      prompt: 'run this through my subscription agent',
      subscriptionExecutionTarget: TARGET,
      payload: { subscriptionExecutionTarget: TARGET },
    } as unknown);
    expect((parsed as Record<string, unknown>).subscriptionExecutionTarget).toBeUndefined();
    expect((parsed as Record<string, unknown>).payload).toBeUndefined();
  });

  it('requires explicit external-context consent for subscription autostart', () => {
    const base = {
      action: 'CREATE_AGENT',
      displayName: 'Qwen worker',
      providerId: 'qwen-subscription',
      modelId: 'qwen3.8-max-preview',
      autostart: true,
      channelIds: [],
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    };
    expect(() => ClientCommandSchema.parse(base)).toThrow(/external context confirmation/i);
    expect(ClientCommandSchema.parse({ ...base, externalContextConfirmed: true }))
      .toMatchObject({ externalContextConfirmed: true });
  });

  it('defaults external-context consent false without blocking local autostart', () => {
    const parsed = ClientCommandSchema.parse({
      action: 'CREATE_AGENT',
      displayName: 'Local worker',
      providerId: 'ollama-local',
      modelId: 'torq-local',
      autostart: true,
      channelIds: [],
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    });
    expect(parsed).toMatchObject({ externalContextConfirmed: false });
  });

  it('routes confirmed, non-sensitive subscription intent through the frontier boundary', () => {
    const decision = new TorqClawRouter().evaluateRequest(withTarget());
    expect(decision.tier).toBe(ComputeTier.FRONTIER);
    expect(decision.ruleId).toBe('AGENT_SUBSCRIPTION_PROVIDER');
    expect(decision.overridable).toBe(false);
  });

  it('keeps sensitive subscription-bound content local before provider selection', () => {
    const decision = new TorqClawRouter().evaluateRequest(withTarget({ containsSensitiveData: true }));
    expect(decision.tier).toBe(ComputeTier.LOCAL_EDGE);
    expect(decision.ruleId).toBe('PRIVACY_OVERRIDE');
  });

  it('honors LOCAL_ONLY before provider selection', () => {
    const decision = new TorqClawRouter().evaluateRequest(withTarget({ executionMode: 'LOCAL_ONLY' }));
    expect(decision.tier).toBe(ComputeTier.LOCAL_EDGE);
    expect(decision.ruleId).toBe('USER_LOCAL_ONLY');
  });

  it('honors explicit local-machine intent before provider selection', () => {
    const decision = new TorqClawRouter().evaluateRequest(withTarget({ prompt: 'run this on this machine' }));
    expect(decision.tier).toBe(ComputeTier.LOCAL_EDGE);
    expect(decision.ruleId).toBe('LOCAL_INTENT');
  });

  it('has a console label for the stable routing reason', () => {
    expect(RULE_LABELS.AGENT_SUBSCRIPTION_PROVIDER).toMatch(/subscription/i);
  });
});
