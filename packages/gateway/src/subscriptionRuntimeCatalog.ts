import { createHash } from 'node:crypto';

export type SubscriptionProviderId =
  | 'grok-subscription'
  | 'kimi-subscription'
  | 'qwen-subscription'
  | 'zai-subscription';

export type SubscriptionPrivateEnvironmentProfileId = 'zai-anthropic-glm-5.3-v1';

/**
 * An alias a subscription adapter advertises in place of its real underlying model id. `'default'`
 * is deliberately excluded from this type: it is the adapter's ambient no-op selection, not a
 * consciously pinned identity, so it can never be accepted as an alias binding (see T-7/negative
 * tests in tests/subscription-runtime.test.ts).
 */
export type SubscriptionAdvertisedAlias = 'opus' | 'sonnet' | 'haiku';

/**
 * What the system can actually guarantee about the model that served a turn:
 * - `adapter_verbatim`: the adapter's advertised `exactModelId` IS the vendor model id (the
 *   default for every binding that carries no `advertisedAlias`).
 * - `env_bound`: the served model is pinned by an allowlisted, client-unreachable child
 *   environment (base URL + every alias forced to one vendor model) AND a live spawn of the real
 *   adapter binary was proven, via a discriminating negative control, not to escape that
 *   environment (T-6 in tests/subscription-alias-binding.test.ts).
 * - `endpoint_bound`: same env pinning, but T-6's negative control did not differ from its
 *   production path in this slice (the env-var pins dominate regardless of the CLAUDE_CONFIG_DIR/
 *   cwd isolation under test), so the binding is scoped down to what is actually provable: the
 *   endpoint the traffic goes to and the model the env vars force for that endpoint -- not that
 *   the isolation mechanism itself is load-bearing.
 *
 * Never "verified" or "attested" anywhere user-facing -- ACP does not expose the served model
 * post-turn (claude-agent-acp v0.64.2 keeps `lastAssistantModel` internal), so no stronger claim
 * would be honest.
 */
export type SubscriptionModelAttestation = 'adapter_verbatim' | 'env_bound' | 'endpoint_bound';

export interface SubscriptionModelDescriptor {
  id: string;
  label: string;
  probeRequired: boolean;
}

export interface SubscriptionRuntimeDescriptor {
  providerId: SubscriptionProviderId;
  label: string;
  authKind: 'external_cli_session';
  transport: 'acp_stdio';
  risk: 'vendor_builtin_tools_os_tcb' | 'isolated_acp_process';
  models: readonly SubscriptionModelDescriptor[];
}

interface SubscriptionAcpServerBindingBase {
  providerId: SubscriptionProviderId;
  command: string;
  args: readonly string[];
  exactModelId: string;
  timeoutMs: number;
  runtimeFingerprint: string;
  vendorBuiltInTools: boolean;
  privateEnvironmentProfileId?: SubscriptionPrivateEnvironmentProfileId;
}

/** The one alias-bearing binding: the zai `glm-5.3` server, and only that server. */
interface SubscriptionAcpServerAliasBinding extends SubscriptionAcpServerBindingBase {
  privateEnvironmentProfileId: 'zai-anthropic-glm-5.3-v1';
  advertisedAlias: SubscriptionAdvertisedAlias;
  modelAttestation: Extract<SubscriptionModelAttestation, 'env_bound' | 'endpoint_bound'>;
}

/** Every other binding: no alias, verbatim attestation, exactly as before. */
interface SubscriptionAcpServerVerbatimBinding extends SubscriptionAcpServerBindingBase {
  advertisedAlias?: undefined;
  modelAttestation?: Extract<SubscriptionModelAttestation, 'adapter_verbatim'>;
}

export type SubscriptionAcpServerBinding = SubscriptionAcpServerAliasBinding | SubscriptionAcpServerVerbatimBinding;

type Server =
  | Omit<SubscriptionAcpServerAliasBinding, 'providerId' | 'runtimeFingerprint'>
  | Omit<SubscriptionAcpServerVerbatimBinding, 'providerId' | 'runtimeFingerprint'>;
type InternalDescriptor = SubscriptionRuntimeDescriptor & { servers: Readonly<Record<string, Server>> };

function fingerprint(providerId: SubscriptionProviderId, server: Server): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1, providerId, command: server.command, args: server.args,
    exactModelId: server.exactModelId, timeoutMs: server.timeoutMs,
    vendorBuiltInTools: server.vendorBuiltInTools,
    privateEnvironmentProfileId: server.privateEnvironmentProfileId ?? null,
    // Omitted (never `?? null`) when absent so every existing non-alias binding's fingerprint
    // stays byte-identical to before this field existed -- only the zai binding's changes.
    ...(server.advertisedAlias !== undefined ? { advertisedAlias: server.advertisedAlias } : {}),
    ...(server.modelAttestation !== undefined ? { modelAttestation: server.modelAttestation } : {}),
  }), 'utf8').digest('hex');
}

function freezeDescriptor(value: InternalDescriptor): InternalDescriptor {
  for (const model of value.models) Object.freeze(model);
  Object.freeze(value.models);
  for (const server of Object.values(value.servers)) {
    Object.freeze(server.args);
    Object.freeze(server);
  }
  Object.freeze(value.servers);
  return Object.freeze(value);
}

/**
 * The zai binding's earned attestation level.
 *
 * T-6 (tests/subscription-alias-binding.test.ts) was re-run live against the real spawned
 * claude-agent-acp v0.64.2 binary with a DISCRIMINATING sentinel -- `{"model":"sonnet"}`, a value
 * that is actually in the adapter's own advertised alias set, not an arbitrary non-alias string
 * that could never appear in `configOptions` regardless of whether isolation works. Result
 * (2026-08-23, packet correction 2):
 *   - PRODUCTION_PATH (CLAUDE_CONFIG_DIR isolated + gateway-owned cwd): currentValueBeforePin =
 *     'opus' (the ANTHROPIC_MODEL/ANTHROPIC_DEFAULT_OPUS_MODEL env pins win).
 *   - NEGATIVE_CONTROL (no CLAUDE_CONFIG_DIR, cwd = the sentinel dir, same env pins present):
 *     currentValueBeforePin is ALSO 'opus' -- identical to the production path.
 * The negative control does not differ from the production path, so `CLAUDE_CONFIG_DIR`/cwd
 * isolation is NOT what this evidence shows is controlling the served model -- the ANTHROPIC_*
 * env-var pins are (confirmed separately: with those env pins absent, the same sentinel DOES win,
 * proving the adapter reads settings.json when nothing else overrides it). `env_bound` is
 * therefore not earned by this evidence. This stays 'endpoint_bound': what is actually provable
 * is that traffic is pinned to the zai endpoint (ANTHROPIC_BASE_URL) with the model forced by
 * env vars for that endpoint, not that the isolation mechanism was proven to matter. The
 * CLAUDE_CONFIG_DIR/cwd isolation is retained anyway as defense in depth (see
 * safeSubscriptionProcess.ts), but must not be described as the proven control in the UI/readiness
 * surface -- see subscriptionAcpRuntime.ts and agentSurface.ts's `attestationNote`. Re-run T-6
 * before ever flipping this to 'env_bound'; it requires a negative control that actually differs.
 */
const ZAI_MODEL_ATTESTATION: Extract<SubscriptionModelAttestation, 'env_bound' | 'endpoint_bound'> = 'endpoint_bound';

const DESCRIPTORS: readonly InternalDescriptor[] = Object.freeze([
  freezeDescriptor({
    providerId: 'grok-subscription',
    label: 'Grok subscription',
    authKind: 'external_cli_session',
    transport: 'acp_stdio',
    risk: 'vendor_builtin_tools_os_tcb',
    models: [{ id: 'grok-build-0.1', label: 'Grok Build 0.1', probeRequired: false }],
    servers: {
      'grok-build-0.1': {
        command: 'grok', args: ['agent', '--always-approve', 'stdio'],
        exactModelId: 'grok-build-0.1', timeoutMs: 120_000, vendorBuiltInTools: true,
      },
    },
  }),
  freezeDescriptor({
    providerId: 'kimi-subscription',
    label: 'Kimi subscription',
    authKind: 'external_cli_session',
    transport: 'acp_stdio',
    risk: 'isolated_acp_process',
    models: [{ id: 'kimi-code/k3', label: 'Kimi K3', probeRequired: false }],
    servers: {
      'kimi-code/k3': {
        command: 'kimi', args: ['acp'], exactModelId: 'kimi-code/k3',
        timeoutMs: 120_000, vendorBuiltInTools: false,
      },
    },
  }),
  freezeDescriptor({
    providerId: 'qwen-subscription',
    label: 'Qwen subscription',
    authKind: 'external_cli_session',
    transport: 'acp_stdio',
    risk: 'isolated_acp_process',
    models: [
      { id: 'qwen3.8-max-preview', label: 'Qwen 3.8 Max Preview', probeRequired: false },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro via Qwen', probeRequired: false },
    ],
    servers: {
      'qwen3.8-max-preview': {
        command: 'qwen', args: ['--acp', '-m', 'qwen3.8-max-preview'],
        exactModelId: 'qwen3.8-max-preview', timeoutMs: 120_000, vendorBuiltInTools: false,
      },
      'deepseek-v4-pro': {
        command: 'qwen', args: ['--acp', '-m', 'deepseek-v4-pro'],
        exactModelId: 'deepseek-v4-pro', timeoutMs: 90_000, vendorBuiltInTools: false,
      },
    },
  }),
  freezeDescriptor({
    providerId: 'zai-subscription',
    label: 'Z.ai subscription',
    authKind: 'external_cli_session',
    transport: 'acp_stdio',
    risk: 'isolated_acp_process',
    models: [{ id: 'glm-5.3', label: 'GLM 5.3', probeRequired: true }],
    servers: {
      'glm-5.3': {
        command: 'claude-agent-acp', args: [], exactModelId: 'glm-5.3',
        timeoutMs: 120_000, vendorBuiltInTools: false,
        privateEnvironmentProfileId: 'zai-anthropic-glm-5.3-v1',
        advertisedAlias: 'opus',
        // T-6 (tests/subscription-alias-binding.test.ts) spawns the real claude-agent-acp binary
        // under this profile with a discriminating sentinel (settings.json {"model":"sonnet"} --
        // a value actually in the adapter's own alias set) in both HOME/USERPROFILE and cwd, and
        // asserts the pin to 'opus' succeeds. See the ZAI_MODEL_ATTESTATION comment above for the
        // full production-vs-negative-control result and which attestation level it earned; do
        // not hand-flip this without re-running T-6 against the current adapter binary.
        modelAttestation: ZAI_MODEL_ATTESTATION,
      },
    },
  }),
]);

export function listSubscriptionRuntimeDescriptors(): SubscriptionRuntimeDescriptor[] {
  return DESCRIPTORS.map(({ servers: _servers, ...descriptor }) => ({
    ...descriptor,
    models: descriptor.models.map((model) => ({ ...model })),
  }));
}

export function resolveSubscriptionAcpServer(providerId: string, modelId: string): SubscriptionAcpServerBinding | null {
  const provider = DESCRIPTORS.find((candidate) => candidate.providerId === providerId);
  const model = provider?.models.find((candidate) => candidate.id === modelId);
  const server = provider?.servers[modelId];
  if (!provider || !model || !server) return null;
  return Object.freeze({
    providerId: provider.providerId,
    command: server.command,
    args: Object.freeze([...server.args]),
    exactModelId: server.exactModelId,
    timeoutMs: server.timeoutMs,
    runtimeFingerprint: fingerprint(provider.providerId, server),
    vendorBuiltInTools: server.vendorBuiltInTools,
    ...(server.privateEnvironmentProfileId
      ? { privateEnvironmentProfileId: server.privateEnvironmentProfileId }
      : {}),
    ...(server.advertisedAlias !== undefined ? { advertisedAlias: server.advertisedAlias } : {}),
    ...(server.modelAttestation !== undefined ? { modelAttestation: server.modelAttestation } : {}),
  } as SubscriptionAcpServerBinding);
}

export type ProviderModelValidation =
  | {
      ok: true;
      provider: SubscriptionRuntimeDescriptor;
      model: SubscriptionModelDescriptor;
      runtime: SubscriptionAcpServerBinding;
    }
  | { ok: false; code: 'UNKNOWN_PROVIDER' | 'UNSUPPORTED_MODEL' | 'MODEL_PROBE_REQUIRED' };

export function validateSubscriptionProviderModel(
  providerId: string,
  modelId: string,
  options: { probeSatisfied?: boolean } = {},
): ProviderModelValidation {
  const provider = DESCRIPTORS.find((candidate) => candidate.providerId === providerId);
  if (!provider) return { ok: false, code: 'UNKNOWN_PROVIDER' };
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (!model) return { ok: false, code: 'UNSUPPORTED_MODEL' };
  if (options.probeSatisfied === false || (model.probeRequired && options.probeSatisfied !== true)) {
    return { ok: false, code: 'MODEL_PROBE_REQUIRED' };
  }
  const runtime = resolveSubscriptionAcpServer(providerId, modelId);
  if (!runtime) return { ok: false, code: 'MODEL_PROBE_REQUIRED' };
  const { servers: _servers, ...publicProvider } = provider;
  return {
    ok: true,
    provider: { ...publicProvider, models: provider.models.map((candidate) => ({ ...candidate })) },
    model: { ...model },
    runtime,
  };
}
