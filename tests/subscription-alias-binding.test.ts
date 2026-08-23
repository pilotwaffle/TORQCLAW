import { describe, expect, it } from 'vitest';
import {
  listSubscriptionRuntimeDescriptors,
  resolveSubscriptionAcpServer,
  type SubscriptionAdvertisedAlias,
} from '../packages/gateway/src/subscriptionRuntimeCatalog.js';
import {
  executeAcpSubscriptionTurn,
  probeAcpSubscriptionRuntime,
} from '../packages/gateway/src/subscriptionAcpRuntime.js';
import type { ProcessSummary, SubscriptionProcessDriver } from '../packages/gateway/src/safeSubscriptionProcess.js';

/**
 * T-6 OUTCOME (verbatim, PRD-007 Item B correction 2, re-run 2026-08-23):
 *
 * The original T-6 sentinel (`"sentinel-model-xyz"`, an arbitrary non-alias string) could never
 * appear in the adapter's `configOptions` regardless of whether isolation worked, so the test was
 * non-discriminating -- it could not tell "isolation works" from "the adapter never echoes this
 * key at all." Re-run with a sentinel that IS a value the real adapter accepts as a first-class
 * alias: `settings.json` containing `{"model":"sonnet"}`, placed in both a temp HOME/USERPROFILE's
 * `.claude/settings.json` and the spawn cwd's own `.claude/settings.json`.
 *
 * Ran live against the real spawned `claude-agent-acp` v0.64.2 binary (via
 * packages/gateway/dist/safeSubscriptionProcess.js's resolveSpawnTarget, exactly as production
 * spawns it), `initialize` + `session/new` sent, model configOption read before any pin call:
 *
 * PRODUCTION_PATH (CLAUDE_CONFIG_DIR isolated to a separate empty gateway-owned dir + explicit
 * gateway-owned spawn cwd, as buildSafeChildEnv sets for the zai profile; real ANTHROPIC_* zai env
 * pins present):
 *   {
 *     "mode": "PRODUCTION_PATH",
 *     "sentinelAlias": "sonnet",
 *     "advertisedOptionValues": ["default", "opus", "sonnet", "haiku"],
 *     "currentValueBeforePin": "opus",
 *     "pinError": null,
 *     "currentValueAfterPin": "opus"
 *   }
 *
 * NEGATIVE_CONTROL (CLAUDE_CONFIG_DIR deleted from the child env, cwd = the sentinel-bearing
 * project dir instead of the gateway-owned one; same ANTHROPIC_* env pins present):
 *   {
 *     "mode": "NEGATIVE_CONTROL",
 *     "sentinelAlias": "sonnet",
 *     "advertisedOptionValues": ["default", "opus", "sonnet", "haiku"],
 *     "currentValueBeforePin": "opus",
 *     "pinError": null,
 *     "currentValueAfterPin": "opus"
 *   }
 *
 * The negative control's `currentValueBeforePin` is IDENTICAL to the production path ("opus" in
 * both), not "sonnet". A separate sanity run confirmed the sentinel mechanism itself is valid: with
 * the ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL env pins removed entirely (no zai profile env),
 * the same `{"model":"sonnet"}` settings.json DOES win (`currentValueBeforePin: "sonnet"`) -- so
 * the adapter reads and honors that key when nothing else overrides it. This means the
 * `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_OPUS_MODEL` env-var pins, not the `CLAUDE_CONFIG_DIR`/cwd
 * isolation, are what force the served model onto `opus` -- isolation was not shown to be the
 * controlling factor by this evidence.
 *
 * T-6 therefore does NOT earn `env_bound`. `modelAttestation` stays `'endpoint_bound'` in
 * subscriptionRuntimeCatalog.ts's `ZAI_MODEL_ATTESTATION` constant: what is actually provable is
 * that traffic is pinned to the zai endpoint with the model forced by env vars for that endpoint,
 * not that the CLAUDE_CONFIG_DIR/cwd isolation is load-bearing. That isolation is retained as
 * defense in depth (it still prevents an operator-machine `~/.claude/settings.json` model override
 * from being read at all, which matters if the env pins were ever weakened), but the UI copy in
 * agentSurface.ts's `attestationNote` must keep saying "endpoint-bound," not "env-bound." Re-run
 * T-6 with a negative control that actually differs before ever flipping this to `env_bound`.
 */
describe('T-6 (documented outcome)', () => {
  it('records that endpoint_bound was earned honestly -- the negative control did not differ, so env isolation was not proven load-bearing', () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    expect(runtime.modelAttestation).toBe('endpoint_bound');
  });
});

const ok: ProcessSummary = { exitCode: 0, timedOut: false, outputLimitExceeded: false, spawnError: null };

// Real claude-agent-acp v0.64.2 advertises exactly these 4 alias values (confirmed live by T-6
// above); this fixture must match the real adapter's option set, not an invented superset.
function aliasConfig(currentValue: string) {
  return [{
    id: 'model', category: 'model', type: 'select', currentValue,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'opus', name: 'Opus' },
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'haiku', name: 'Haiku' },
    ],
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

describe('T-7: catalog-wide alias/profile literal binding', () => {
  it('every binding carrying advertisedAlias carries the literal zai-anthropic-glm-5.3-v1 profile, and only that binding', () => {
    const descriptors = listSubscriptionRuntimeDescriptors();
    const bindings = descriptors.flatMap((descriptor) =>
      descriptor.models.map((model) => resolveSubscriptionAcpServer(descriptor.providerId, model.id)!));
    expect(bindings).toHaveLength(5); // grok, kimi, qwen x2, zai
    for (const binding of bindings) {
      if (binding.advertisedAlias !== undefined) {
        expect(binding.privateEnvironmentProfileId).toBe('zai-anthropic-glm-5.3-v1');
        expect(binding.providerId).toBe('zai-subscription');
      } else {
        expect(binding.modelAttestation).not.toBe('env_bound');
        expect(binding.modelAttestation).not.toBe('endpoint_bound');
      }
    }
    const aliasBearing = bindings.filter((binding) => binding.advertisedAlias !== undefined);
    expect(aliasBearing).toHaveLength(1);
    expect(aliasBearing[0]!.providerId).toBe('zai-subscription');
    expect(aliasBearing[0]!.advertisedAlias).toBe('opus');
  });

  it('rejects "default" as an alias at the type level (compile-time) -- runtime documentation of the invariant', () => {
    // Type-level: SubscriptionAdvertisedAlias excludes 'default'. This assignment would be a
    // compile error if uncommented, which is the actual enforcement:
    //   const notAllowed: SubscriptionAdvertisedAlias = 'default';
    const validAliases: SubscriptionAdvertisedAlias[] = ['opus', 'sonnet', 'haiku'];
    expect(validAliases).not.toContain('default');
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    expect(runtime.advertisedAlias).not.toBe('default');
  });
});

describe('T-8: fingerprint golden (non-zai bindings unchanged)', () => {
  // Captured from packages/gateway/src/subscriptionRuntimeCatalog.ts @ HEAD (before advertisedAlias/
  // modelAttestation existed), using the identical fingerprint() algorithm and server objects.
  // See PRD-007 packet B-5: no version bump, alias/attestation keys omitted (never `?? null`) when
  // absent, so every non-zai fingerprint must equal exactly this.
  const GOLDEN_FINGERPRINTS: Record<string, string> = {
    'grok-subscription:grok-build-0.1': 'b8258044c3d910e5f9caedb3af063712bb3d78ac0ee2be29e5fe012056ffe415',
    'kimi-subscription:kimi-code/k3': '823bb6e81f13e7f8cd06677e1b35ddd5d95fb6a0c38b27bc569fef07e12d56f7',
    'qwen-subscription:qwen3.8-max-preview': '211af7f7d65d48569800479c695589fcfae06098e8f654acabc29e751aa85a0d',
    'qwen-subscription:deepseek-v4-pro': '5e8f31a89ac5f98ee4c83a4e2fbc81a3bb0d9a26efcfea60b6b3d17cf11330bc',
  };

  it('matches the pre-change golden for every non-zai binding', () => {
    for (const [key, golden] of Object.entries(GOLDEN_FINGERPRINTS)) {
      const [providerId, modelId] = key.split(':') as [string, string];
      const runtime = resolveSubscriptionAcpServer(providerId, modelId)!;
      expect(runtime.runtimeFingerprint).toBe(golden);
    }
  });

  it('does not change the zai fingerprint length/shape even though its content changed', () => {
    const zai = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    expect(zai.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    // The zai binding is the one allowed to differ from any pre-change value (it was never
    // 'connected' before this slice, so no bootstrapped agent profile pins its old fingerprint).
  });
});

describe('alias acceptance is scoped to exactly one binding (negative tests)', () => {
  it('rejects an alias-shaped configOptions set (no glm-5.3) for kimi/qwen/grok bindings with ACP_MODEL_MISMATCH', async () => {
    for (const [providerId, modelId] of [
      ['kimi-subscription', 'kimi-code/k3'],
      ['qwen-subscription', 'qwen3.8-max-preview'],
      ['grok-subscription', 'grok-build-0.1'],
    ] as const) {
      const runtime = resolveSubscriptionAcpServer(providerId, modelId)!;
      const { driver } = interactiveDriver((frame, emit) => {
        if (frame.id === 'initialize') emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
        if (frame.id === 'session') emit({
          jsonrpc: '2.0', id: 'session',
          result: { sessionId: 'alias-shaped', configOptions: aliasConfig('default') },
        });
      });
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_MODEL_MISMATCH');
    }
  });

  it('readiness probe: real 4-alias configOptions set with currentValue "opus" reports connected + exactModelId glm-5.3 for zai only', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const { driver } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
      if (frame.id === 'session') emit({
        jsonrpc: '2.0', id: 'session',
        result: { sessionId: 'zai-ready', configOptions: aliasConfig('opus') },
      });
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(probeAcpSubscriptionRuntime('zai-subscription', 'glm-5.3', driver))
        .resolves.toMatchObject({ status: 'connected', exactModelId: 'glm-5.3', modelAttestation: 'endpoint_bound' });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('readiness probe: same alias-shaped config against kimi/qwen/grok never reports connected', async () => {
    for (const [providerId, modelId] of [
      ['kimi-subscription', 'kimi-code/k3'],
      ['qwen-subscription', 'qwen3.8-max-preview'],
      ['grok-subscription', 'grok-build-0.1'],
    ] as const) {
      const { driver } = interactiveDriver((frame, emit) => {
        if (frame.id === 'initialize') emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
        if (frame.id === 'session') emit({
          jsonrpc: '2.0', id: 'session',
          result: { sessionId: 'non-zai-alias-shaped', configOptions: aliasConfig('opus') },
        });
      });
      await expect(probeAcpSubscriptionRuntime(providerId, modelId, driver))
        .resolves.toMatchObject({ status: 'unavailable', exactModelId: null });
    }
  });

  it('non-alias bindings report modelAttestation adapter_verbatim on every probe outcome', async () => {
    const runtime = resolveSubscriptionAcpServer('kimi-subscription', 'kimi-code/k3')!;
    const { driver } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
      if (frame.id === 'session') emit({
        jsonrpc: '2.0', id: 'session',
        result: { sessionId: 's', configOptions: [{
          id: 'model', category: 'model', type: 'select', currentValue: runtime.exactModelId,
          options: [{ value: runtime.exactModelId, name: runtime.exactModelId }],
        }] },
      });
    });
    await expect(probeAcpSubscriptionRuntime('kimi-subscription', 'kimi-code/k3', driver))
      .resolves.toMatchObject({ status: 'connected', modelAttestation: 'adapter_verbatim' });
    // Unknown binding: no fingerprint to attest at all.
    await expect(probeAcpSubscriptionRuntime('kimi-subscription', 'unknown-model'))
      .resolves.toMatchObject({ status: 'unavailable', modelAttestation: null });
  });
});

describe('pre-prompt re-check (revalidation) fails closed before any commit', () => {
  it('throws ACP_MODEL_MISMATCH and never sends session/prompt when the config drifted after pin but before the re-check', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const { driver, writes } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
      if (frame.id === 'session') emit({
        jsonrpc: '2.0', id: 'session',
        // Already pinned to 'opus' at session time, so pinExactModel sends nothing here.
        result: { sessionId: 'drift-session', configOptions: aliasConfig('opus') },
      });
      if (frame.id === 'preprompt-check') {
        // Simulates config drifting back to 'default' between pin and prompt (e.g. an operator
        // action or adapter default reset) -- the re-check must catch this and fail closed.
        emit({ jsonrpc: '2.0', id: 'preprompt-check', result: { configOptions: aliasConfig('default') } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'must-not-send', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_MODEL_MISMATCH');
      expect(writes.some((frame) => frame.method === 'session/prompt')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('runs the same fail-closed re-check for a non-alias binding', async () => {
    const runtime = resolveSubscriptionAcpServer('kimi-subscription', 'kimi-code/k3')!;
    const { driver, writes } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') emit({ jsonrpc: '2.0', id: 'initialize', result: {} });
      if (frame.id === 'session') emit({
        jsonrpc: '2.0', id: 'session',
        result: { sessionId: 's', configOptions: [{
          id: 'model', category: 'model', type: 'select', currentValue: runtime.exactModelId,
          options: [{ value: runtime.exactModelId, name: runtime.exactModelId }],
        }] },
      });
      if (frame.id === 'preprompt-check') {
        emit({ jsonrpc: '2.0', id: 'preprompt-check', result: { configOptions: [{
          id: 'model', category: 'model', type: 'select', currentValue: 'drifted-away',
          options: [{ value: runtime.exactModelId, name: runtime.exactModelId }],
        }] } });
      }
    });
    await expect(executeAcpSubscriptionTurn({
      providerId: runtime.providerId, modelId: runtime.exactModelId,
      runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'must-not-send', cwd: 'C:\\safe', driver,
    })).rejects.toThrow('ACP_MODEL_MISMATCH');
    expect(writes.some((frame) => frame.method === 'session/prompt')).toBe(false);
  });
});
