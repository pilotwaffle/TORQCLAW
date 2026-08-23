import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeSubscriptionAgentTurn, validateCanonicalBlankSubscriptionTurn } from '../packages/gateway/src/subscriptionAgentRuntime.js';
import { resolveSubscriptionAcpServer } from '../packages/gateway/src/subscriptionRuntimeCatalog.js';
import type { ProcessSummary, SubscriptionProcessDriver } from '../packages/gateway/src/safeSubscriptionProcess.js';

const ok: ProcessSummary = { exitCode: 0, timedOut: false, outputLimitExceeded: false, spawnError: null };
const persona = {
  version: 1 as const,
  content: 'Be concise.',
  personaRevision: 4,
  contentSha256: createHash('sha256').update('Be concise.').digest('hex'),
};
const turn = {
  channelId: 'channel-1', agentPrincipalId: 'agent-1', channelSeq: 1,
  triggerEventId: 'event-1', personaRevision: 4,
};

function driverFor(modelId: string): SubscriptionProcessDriver {
  const lines: string[] = [];
  return {
    async probe() { return ok; },
    async invoke() { return ok; },
    async open() {
      return {
        async writeJsonLine(line) {
          const frame = JSON.parse(line);
          if (frame.id === 'initialize') lines.push(JSON.stringify({ jsonrpc: '2.0', id: 'initialize', result: {} }));
          if (frame.id === 'session') lines.push(JSON.stringify({ jsonrpc: '2.0', id: 'session', result: {
            sessionId: 'session-1', configOptions: [{
              id: 'model', category: 'model', type: 'select', currentValue: modelId,
              options: [{ value: modelId, name: modelId }],
            }],
          } }));
          if (frame.id === 'prompt') {
            lines.push(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
            } }));
            lines.push(JSON.stringify({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } }));
          }
        },
        async readLine() { return lines.shift()!; },
        async stop() { return ok; },
      };
    },
  };
}

describe('subscription agent runtime', () => {
  it('accepts exact canonical nonblank snapshots and rejects normalization, hash, and revision mismatch', () => {
    expect(() => validateCanonicalBlankSubscriptionTurn(persona, turn)).not.toThrow();
    expect(() => validateCanonicalBlankSubscriptionTurn(undefined, turn)).toThrow('PERSONA_ENVELOPE_REFUSED');
    expect(() => validateCanonicalBlankSubscriptionTurn({ ...persona, content: ' Be concise. ' }, turn)).toThrow('PERSONA_ENVELOPE_REFUSED');
    expect(() => validateCanonicalBlankSubscriptionTurn({ ...persona, contentSha256: '0'.repeat(64) }, turn)).toThrow('PERSONA_ENVELOPE_REFUSED');
    expect(() => validateCanonicalBlankSubscriptionTurn(persona, { ...turn, personaRevision: 3 })).toThrow('PERSONA_ENVELOPE_REFUSED');
  });

  it('executes with the exact consent-bound persona envelope', async () => {
    const runtime = resolveSubscriptionAcpServer('qwen-subscription', 'qwen3.8-max-preview')!;
    await expect(executeSubscriptionAgentTurn({
      profile: {
        providerAccountId: runtime.providerId, adapterId: 'qwen-subscription:canonical',
        modelId: runtime.exactModelId, autostart: true, externalContextConfirmed: true,
        externalContextRuntimeFingerprint: runtime.runtimeFingerprint,
        externalContextExactModelId: runtime.exactModelId,
        externalContextPersonaRevision: persona.personaRevision,
        externalContextPersonaContentSha256: persona.contentSha256,
      },
      prompt: 'hello', personaEnvelope: persona, turnContext: turn,
      driver: driverFor(runtime.exactModelId),
    })).resolves.toMatchObject({ text: 'answer', modelId: runtime.exactModelId });
  });

  it('refuses stale consent before opening a process', async () => {
    let opened = false;
    const driver = driverFor('kimi-code/k3');
    const original = driver.open;
    driver.open = async (plan) => { opened = true; return original(plan); };
    await expect(executeSubscriptionAgentTurn({
      profile: {
        providerAccountId: 'kimi-subscription', adapterId: 'kimi-subscription:canonical',
        modelId: 'kimi-code/k3', autostart: true, externalContextConfirmed: true,
        externalContextRuntimeFingerprint: '0'.repeat(64), externalContextExactModelId: 'kimi-code/k3',
        externalContextPersonaRevision: persona.personaRevision,
        externalContextPersonaContentSha256: '0'.repeat(64),
      },
      prompt: 'hello', personaEnvelope: persona, turnContext: turn, driver,
    })).rejects.toThrow('RUNTIME_NOT_READY');
    expect(opened).toBe(false);
  });
});
