import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configuredLocalAgentModels,
  listAgentProviders,
  probeLocalAgentRuntime,
} from '../packages/gateway/src/agentSurface.js';
import { setSubscriptionProcessDriverForTest } from '../packages/gateway/src/subscriptionAcpRuntime.js';
import type {
  ProcessSummary,
  SubscriptionProcessDriver,
} from '../packages/gateway/src/safeSubscriptionProcess.js';

const processOk: ProcessSummary = {
  exitCode: 0, timedOut: false, outputLimitExceeded: false, spawnError: null,
};

/**
 * `zaiAliasAdvertised` mirrors the real adapter shape (packet B-3/B-4): claude-agent-acp never
 * advertises the vendor model id `glm-5.3` literally, only its own alias set
 * (`[default, opus, claude-fable-5[1m], sonnet, haiku]`). `true` means the alias set is present
 * (so probing can pin `opus`, which the zai binding's `advertisedAlias` requires); `false` means
 * the adapter advertised something unrelated, so no acceptable alias exists and the probe must
 * fail closed exactly as it would for a genuinely wrong adapter.
 */
function readinessDriver(zaiAliasAdvertised: boolean): SubscriptionProcessDriver {
  return {
    async probe() { return processOk; },
    async invoke() { return processOk; },
    async open(plan) {
      const lines: string[] = [];
      const readers: Array<(line: string) => void> = [];
      const emit = (frame: unknown) => {
        const line = JSON.stringify(frame);
        const reader = readers.shift();
        if (reader) reader(line); else lines.push(line);
      };
      const isZai = plan.command === 'claude-agent-acp';
      const expectedModel = plan.command === 'grok' ? 'grok-build-0.1'
        : plan.command === 'kimi' ? 'kimi-code/k3'
          : isZai ? undefined
            : plan.args.at(-1) ?? 'unknown';
      const zaiConfigOptions = () => zaiAliasAdvertised
        ? [{
          id: 'model', category: 'model', type: 'select', currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' }, { value: 'opus', name: 'Opus' },
            { value: 'claude-fable-5[1m]', name: 'Fable 5 (1M)' },
            { value: 'sonnet', name: 'Sonnet' }, { value: 'haiku', name: 'Haiku' },
          ],
        }]
        : [{
          id: 'model', category: 'model', type: 'select', currentValue: 'wrong-model',
          options: [{ value: 'wrong-model', name: 'Wrong model' }],
        }];
      return {
        async writeJsonLine(line) {
          const frame = JSON.parse(line) as { id?: string; params?: { value?: string } };
          if (frame.id === 'initialize') {
            emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
          } else if (frame.id === 'session') {
            emit({
              jsonrpc: '2.0', id: 'session', result: {
                sessionId: 'readiness-session',
                configOptions: isZai ? zaiConfigOptions() : [{
                  id: 'model', category: 'model', type: 'select', currentValue: expectedModel,
                  options: [{ value: expectedModel, name: expectedModel }],
                }],
              },
            });
          } else if (frame.id === 'model' && isZai) {
            const pinned = frame.params?.value ?? 'default';
            emit({
              jsonrpc: '2.0', id: 'model', result: {
                configOptions: [{
                  id: 'model', category: 'model', type: 'select', currentValue: pinned,
                  options: zaiConfigOptions()[0]!.options,
                }],
              },
            });
          }
        },
        async readLine() {
          return lines.shift() ?? new Promise<string>((resolve) => readers.push(resolve));
        },
        async stop() { return processOk; },
      };
    },
  };
}

afterEach(() => setSubscriptionProcessDriverForTest(null));

describe('local agent provider readiness', () => {
  it('keeps GLM unavailable until its exact probe connects, then makes it create-ready without changing other models', async () => {
    const savedKey = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      setSubscriptionProcessDriverForTest(readinessDriver(false));
      const before = await listAgentProviders();
      expect(before.find((provider) => provider.id === 'zai-subscription')).toMatchObject({
        status: 'unavailable', executionReady: false,
        models: [{ id: 'glm-5.3', executionReady: false }],
      });
      expect(before.find((provider) => provider.id === 'kimi-subscription')).toMatchObject({
        status: 'connected', executionReady: true,
        models: [{ id: 'kimi-code/k3', executionReady: true }],
      });

      setSubscriptionProcessDriverForTest(readinessDriver(true));
      const after = await listAgentProviders();
      expect(after.find((provider) => provider.id === 'zai-subscription')).toMatchObject({
        status: 'connected', executionReady: true,
        models: [{ id: 'glm-5.3', executionReady: true }],
      });
    } finally {
      if (savedKey === undefined) delete process.env.GLM_API_KEY;
      else process.env.GLM_API_KEY = savedKey;
    }
  });

  it('fails closed when participation or autoreply is disabled without probing Ollama', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await probeLocalAgentRuntime({
      fetchImpl,
      participationEnabled: () => false,
      autoreplyEnabled: () => true,
    })).toMatchObject({ status: 'unavailable', executionReady: false });
    expect(await probeLocalAgentRuntime({
      fetchImpl,
      participationEnabled: () => true,
      autoreplyEnabled: () => false,
    })).toMatchObject({ status: 'unavailable', executionReady: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports ready only after a successful Ollama health response', async () => {
    const enabled = { participationEnabled: () => true, autoreplyEnabled: () => true };
    expect(await probeLocalAgentRuntime({
      ...enabled,
      env: {
        OLLAMA_HOST: 'http://ollama.test/',
        TORQCLAW_LOCAL_AGENT_MODELS: 'torq-local, torq-ai-v5, not-installed',
      },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        models: [{ name: 'torq-ai-v5:latest' }, { model: 'unlisted-model:latest' }],
      }), { status: 200 })),
    })).toMatchObject({
      status: 'connected',
      executionReady: true,
      installedModelIds: ['torq-ai-v5'],
    });
    expect(await probeLocalAgentRuntime({
      ...enabled,
      fetchImpl: vi.fn(async () => new Response('', { status: 503 })),
    })).toMatchObject({ status: 'unavailable', executionReady: false });
  });

  it('uses a bounded default allowlist and fails closed when none are installed', async () => {
    expect(configuredLocalAgentModels({})).toEqual(['torq-local', 'torq-ai-v5']);
    expect(configuredLocalAgentModels({
      TORQCLAW_LOCAL_AGENT_MODELS: ' torq-ai-v5,torq-ai-v5,\u0000bad, ',
    })).toEqual(['torq-ai-v5']);
    expect(await probeLocalAgentRuntime({
      participationEnabled: () => true,
      autoreplyEnabled: () => true,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        models: [{ name: 'other-model:latest' }],
      }), { status: 200 })),
    })).toMatchObject({ status: 'connected', executionReady: false, installedModelIds: [] });
  });
});
