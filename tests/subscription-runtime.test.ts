import { describe, expect, it } from 'vitest';
import {
  listSubscriptionRuntimeDescriptors,
  resolveSubscriptionAcpServer,
  validateSubscriptionProviderModel,
} from '../packages/gateway/src/subscriptionRuntimeCatalog.js';
import {
  executeAcpSubscriptionTurn,
  parseStrictAcpFrame,
  probeAcpSubscriptionRuntime,
} from '../packages/gateway/src/subscriptionAcpRuntime.js';
import {
  buildSafeChildEnv,
  type ProcessSummary,
  type SubscriptionProcessDriver,
} from '../packages/gateway/src/safeSubscriptionProcess.js';

const ok: ProcessSummary = { exitCode: 0, timedOut: false, outputLimitExceeded: false, spawnError: null };

function modelConfig(modelId: string, currentValue = modelId) {
  return [{
    id: 'model', category: 'model', type: 'select', currentValue,
    options: [{ value: modelId, name: modelId }],
  }];
}

function interactiveDriver(
  onWrite: (frame: Record<string, any>, emit: (frame: unknown) => void) => void,
  summary: ProcessSummary = ok,
): { driver: SubscriptionProcessDriver; writes: Record<string, any>[] } {
  const writes: Record<string, any>[] = [];
  const lines: string[] = [];
  const readers: Array<(line: string) => void> = [];
  const emit = (frame: unknown) => {
    const line = JSON.stringify(frame);
    const reader = readers.shift();
    if (reader) reader(line); else lines.push(line);
  };
  return {
    writes,
    driver: {
      async probe() { return ok; },
      async invoke() { return ok; },
      async open() {
        return {
          async writeJsonLine(line) {
            const frame = JSON.parse(line);
            writes.push(frame);
            onWrite(frame, emit);
          },
          async readLine() {
            return lines.shift() ?? new Promise<string>((resolve) => readers.push(resolve));
          },
          async stop() { return summary; },
        };
      },
    },
  };
}

describe('trusted subscription ACP catalog and protocol', () => {
  it('publishes command-free immutable descriptors with fixed vendor argv', () => {
    const descriptors = listSubscriptionRuntimeDescriptors();
    expect(descriptors.map((entry) => entry.providerId)).toEqual([
      'grok-subscription', 'kimi-subscription', 'qwen-subscription', 'zai-subscription',
    ]);
    expect(JSON.stringify(descriptors)).not.toMatch(/command|args|endpoint|fingerprint|env|glm-5\.2/i);
    const grok = resolveSubscriptionAcpServer('grok-subscription', 'grok-build-0.1')!;
    const kimi = resolveSubscriptionAcpServer('kimi-subscription', 'kimi-code/k3')!;
    const qwen = resolveSubscriptionAcpServer('qwen-subscription', 'qwen3.8-max-preview')!;
    const deepseek = resolveSubscriptionAcpServer('qwen-subscription', 'deepseek-v4-pro')!;
    expect([grok.command, grok.args]).toEqual(['grok', ['agent', '--always-approve', 'stdio']]);
    expect([kimi.command, kimi.args]).toEqual(['kimi', ['acp']]);
    expect([qwen.command, qwen.args]).toEqual(['qwen', ['--acp', '-m', 'qwen3.8-max-preview']]);
    expect([deepseek.command, deepseek.args, deepseek.timeoutMs])
      .toEqual(['qwen', ['--acp', '-m', 'deepseek-v4-pro'], 90_000]);
    expect(grok.vendorBuiltInTools).toBe(true);
    expect(Object.isFrozen(grok)).toBe(true);
  });

  it('publishes Z.ai readiness while keeping its private route profile browser-redacted and fingerprint-bound', () => {
    expect(validateSubscriptionProviderModel('qwen-subscription', 'glm-5.3'))
      .toEqual({ ok: false, code: 'UNSUPPORTED_MODEL' });
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    expect([runtime.command, runtime.args, runtime.exactModelId, runtime.timeoutMs])
      .toEqual(['claude-agent-acp', [], 'glm-5.3', 120_000]);
    expect(runtime.privateEnvironmentProfileId).toBe('zai-anthropic-glm-5.3-v1');
    expect(runtime.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const publicZai = listSubscriptionRuntimeDescriptors().find((entry) => entry.providerId === 'zai-subscription');
    expect(JSON.stringify(publicZai)).not.toMatch(/claude-agent-acp|anthropic|route|profile|endpoint|fingerprint|env/i);
    expect(validateSubscriptionProviderModel('zai-subscription', 'glm-5.3'))
      .toEqual({ ok: false, code: 'MODEL_PROBE_REQUIRED' });
    expect(validateSubscriptionProviderModel('zai-subscription', 'glm-5.3', { probeSatisfied: false }))
      .toEqual({ ok: false, code: 'MODEL_PROBE_REQUIRED' });
    expect(validateSubscriptionProviderModel('zai-subscription', 'glm-5.3', { probeSatisfied: true }))
      .toMatchObject({ ok: true, model: { id: 'glm-5.3', probeRequired: true } });
    expect(validateSubscriptionProviderModel('kimi-subscription', 'kimi-code/k3'))
      .toMatchObject({ ok: true, model: { id: 'kimi-code/k3', probeRequired: false } });
  });

  it.each([
    'not-json',
    JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'fs/read_text_file', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { token: 'secret-value' } }),
  ])('rejects malformed, reverse-request, and secret frames', (frame) => {
    expect(() => parseStrictAcpFrame(frame)).toThrow(/ACP_/);
  });

  it('probes sequentially with no prompt, context, MCP server, or client tool', async () => {
    const { driver, writes } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
      if (frame.id === 'session') emit({
        jsonrpc: '2.0', id: 'session',
        result: { sessionId: 'probe-session', configOptions: modelConfig('kimi-code/k3') },
      });
    });
    await expect(probeAcpSubscriptionRuntime('kimi-subscription', 'kimi-code/k3', driver))
      .resolves.toMatchObject({ status: 'connected', exactModelId: 'kimi-code/k3' });
    expect(writes.map((frame) => frame.method)).toEqual(['initialize', 'session/new']);
    expect(writes[1]?.params).toEqual(expect.objectContaining({ mcpServers: [] }));
    expect(JSON.stringify(writes)).not.toMatch(/session\/prompt|context|tools/i);
  });

  it('uses returned sessionId, pins the advertised model, streams chunks, and requires end_turn', async () => {
    const runtime = resolveSubscriptionAcpServer('qwen-subscription', 'deepseek-v4-pro')!;
    const stages: string[] = [];
    const { driver, writes } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
      if (frame.id === 'session') emit({
        jsonrpc: '2.0', id: 'session',
        result: { sessionId: 'server-session', configOptions: modelConfig(runtime.exactModelId, 'other') },
      });
      if (frame.id === 'model') emit({
        jsonrpc: '2.0', id: 'model',
        result: { configOptions: modelConfig(runtime.exactModelId) },
      });
      if (frame.id === 'prompt') {
        emit({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'server-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ans' } },
        } });
        emit({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'server-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wer' } },
        } });
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    await expect(executeAcpSubscriptionTurn({
      providerId: runtime.providerId,
      modelId: runtime.exactModelId,
      runtimeFingerprint: runtime.runtimeFingerprint,
      prompt: 'hello', cwd: 'C:\\safe', driver,
      admit(stage) { stages.push(stage); return true; },
    })).resolves.toMatchObject({ text: 'answer', exactModelId: runtime.exactModelId });
    expect(stages).toEqual(['spawn', 'session', 'model', 'preprompt']);
    expect(writes.find((frame) => frame.id === 'model')?.params).toMatchObject({
      sessionId: 'server-session', value: runtime.exactModelId,
    });
    expect(writes.find((frame) => frame.id === 'prompt')?.params.sessionId).toBe('server-session');
  });

  it('rejects wrong-session chunks and non-successful stop reasons', async () => {
    const runtime = resolveSubscriptionAcpServer('kimi-subscription', 'kimi-code/k3')!;
    const { driver } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
      if (frame.id === 'session') emit({ jsonrpc: '2.0', id: 'session', result: {
        sessionId: 's', configOptions: modelConfig(runtime.exactModelId),
      } });
      if (frame.id === 'prompt') emit({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
      } });
    });
    await expect(executeAcpSubscriptionTurn({
      providerId: runtime.providerId, modelId: runtime.exactModelId,
      runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hello', cwd: 'C:\\safe', driver,
    })).rejects.toThrow('ACP_UNSAFE_FRAME');
  });

  it('passes no credential environment variables to child processes', () => {
    expect(buildSafeChildEnv({ PATH: 'bin', USERPROFILE: 'profile', OPENAI_API_KEY: 'secret' }))
      .toEqual({ PATH: 'bin', USERPROFILE: 'profile' });
  });

  it('maps only the gateway GLM key into the fixed Z.ai child route and model aliases', () => {
    expect(buildSafeChildEnv({
      PATH: 'bin', GLM_API_KEY: 'glm-secret', OPENAI_API_KEY: 'other',
      ANTHROPIC_AUTH_TOKEN: 'spoofed', ANTHROPIC_BASE_URL: 'https://evil.invalid',
    }, 'zai-anthropic-glm-5.3-v1')).toEqual({
      PATH: 'bin',
      ANTHROPIC_AUTH_TOKEN: 'glm-secret',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
    });
  });

  it('fails Z.ai readiness before spawn when the gateway key is missing', async () => {
    const saved = process.env.GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    let opens = 0;
    const driver = interactiveDriver(() => {}).driver;
    const guarded: SubscriptionProcessDriver = { ...driver, async open(plan) { opens += 1; return driver.open(plan); } };
    try {
      await expect(probeAcpSubscriptionRuntime('zai-subscription', 'glm-5.3', guarded))
        .resolves.toMatchObject({ status: 'unavailable', exactModelId: null });
      expect(opens).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it.each([
    ['auth failure', { jsonrpc: '2.0', id: 'initialize', error: { code: 401, message: 'unauthorized' } }],
    ['model mismatch', { jsonrpc: '2.0', id: 'initialize', result: {} }],
  ])('fails Z.ai readiness on %s without sending a prompt', async (_case, initializeFrame) => {
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    const { driver, writes } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') emit(initializeFrame);
      if (frame.id === 'session') emit({
        jsonrpc: '2.0', id: 'session', result: {
          sessionId: 'zai', configOptions: modelConfig('other-model'),
        },
      });
    });
    try {
      await expect(probeAcpSubscriptionRuntime('zai-subscription', 'glm-5.3', driver))
        .resolves.toMatchObject({ status: 'unavailable', exactModelId: null });
      expect(writes.some((frame) => frame.method === 'session/prompt')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('passes the private Z.ai profile into ACP open and preserves cancellation before prompt', async () => {
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const controller = new AbortController();
    let openedProfile: string | undefined;
    const { driver, writes } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') {
        controller.abort();
        emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
      }
    }, { ...ok, exitCode: null, cancelled: true });
    const guarded: SubscriptionProcessDriver = {
      ...driver,
      async open(plan) {
        openedProfile = plan.privateEnvironmentProfileId;
        const connection = await driver.open(plan);
        return {
          ...connection,
          async readLine() {
            if (plan.signal?.aborted) throw new Error('CANCELLED');
            return connection.readLine();
          },
        };
      },
    };
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'must-not-send', cwd: 'C:\\safe',
        signal: controller.signal, driver: guarded,
      })).rejects.toThrow('CANCELLED');
      expect(openedProfile).toBe('zai-anthropic-glm-5.3-v1');
      expect(writes.some((frame) => frame.method === 'session/prompt')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('does not let an abort be preempted by a process error', async () => {
    const runtime = resolveSubscriptionAcpServer('kimi-subscription', 'kimi-code/k3')!;
    const controller = new AbortController();
    const driver: SubscriptionProcessDriver = {
      async probe() { return ok; },
      async invoke() { return ok; },
      async open(plan) {
        return {
          async writeJsonLine() { controller.abort(); },
          async readLine() {
            if (plan.signal?.aborted) throw new Error('CANCELLED');
            return new Promise<string>((_, reject) => {
              plan.signal?.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true });
            });
          },
          async stop() { return { ...ok, exitCode: null, cancelled: true }; },
        };
      },
    };
    const execution = executeAcpSubscriptionTurn({
      providerId: runtime.providerId, modelId: runtime.exactModelId,
      runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hello', cwd: 'C:\\safe',
      signal: controller.signal, driver,
    });
    await expect(execution).rejects.toThrow('CANCELLED');
  });
});
