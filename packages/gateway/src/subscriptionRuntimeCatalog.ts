import { createHash } from 'node:crypto';

export type SubscriptionProviderId =
  | 'grok-subscription'
  | 'kimi-subscription'
  | 'qwen-subscription'
  | 'zai-subscription';

export type SubscriptionPrivateEnvironmentProfileId = 'zai-anthropic-glm-5.3-v1';

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

export interface SubscriptionAcpServerBinding {
  providerId: SubscriptionProviderId;
  command: string;
  args: readonly string[];
  exactModelId: string;
  timeoutMs: number;
  runtimeFingerprint: string;
  vendorBuiltInTools: boolean;
  privateEnvironmentProfileId?: SubscriptionPrivateEnvironmentProfileId;
}

type Server = Omit<SubscriptionAcpServerBinding, 'providerId' | 'runtimeFingerprint'>;
type InternalDescriptor = SubscriptionRuntimeDescriptor & { servers: Readonly<Record<string, Server>> };

function fingerprint(providerId: SubscriptionProviderId, server: Server): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1, providerId, command: server.command, args: server.args,
    exactModelId: server.exactModelId, timeoutMs: server.timeoutMs,
    vendorBuiltInTools: server.vendorBuiltInTools,
    privateEnvironmentProfileId: server.privateEnvironmentProfileId ?? null,
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
  });
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
