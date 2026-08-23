import { runAgentRuntimeProfileMigration } from '@torqclaw/collab';
import {
  listSubscriptionRuntimeDescriptors,
  resolveSubscriptionAcpServer,
} from './subscriptionRuntimeCatalog.js';
import { probeAcpSubscriptionRuntime } from './subscriptionAcpRuntime.js';
import { agentAutoreplyEnabled } from './autoReplyFlags.js';
import {
  callerFor,
  COLLAB_IDENTITY_REQUIRED,
  getCollabDbForAutoReply,
  getStore,
  publishCollabSurface,
  type CollabSurfaceError,
  agentParticipationEnabled,
} from './collabSurface.js';

type AgentProviderStatus = 'connected' | 'available' | 'missing' | 'unavailable';

interface AgentProvider {
  id: string;
  label: string;
  authKind: 'none' | 'external_cli_session';
  status: AgentProviderStatus;
  executionReady: boolean;
  models: Array<{ id: string; label: string; executionReady: boolean; note: string }>;
  note: string;
}

export interface LocalAgentRuntimeReadiness {
  status: AgentProviderStatus;
  executionReady: boolean;
  note: string;
  installedModelIds: string[];
}

const DEFAULT_LOCAL_AGENT_MODELS = ['torq-local', 'torq-ai-v5'] as const;

export function configuredLocalAgentModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.TORQCLAW_LOCAL_AGENT_MODELS;
  const candidates = configured === undefined
    ? [...DEFAULT_LOCAL_AGENT_MODELS]
    : configured.split(',');
  return [...new Set(candidates
    .map((modelId) => modelId.normalize('NFC').trim())
    .filter((modelId) => modelId.length > 0 && modelId.length <= 200 && !/[\u0000-\u001f\u007f]/.test(modelId)))];
}

function installedModelMatches(configuredId: string, installedId: string): boolean {
  return installedId === configuredId
    || installedId === `${configuredId}:latest`
    || configuredId === `${installedId}:latest`;
}

export async function probeLocalAgentRuntime(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  participationEnabled?: () => boolean;
  autoreplyEnabled?: () => boolean;
} = {}): Promise<LocalAgentRuntimeReadiness> {
  const participationEnabled = options.participationEnabled ?? agentParticipationEnabled;
  const autoreplyEnabled = options.autoreplyEnabled ?? agentAutoreplyEnabled;
  if (!participationEnabled() || !autoreplyEnabled()) {
    return {
      status: 'unavailable',
      executionReady: false,
      note: 'Local agent execution requires collaboration participation and automatic replies to be enabled.',
      installedModelIds: [],
    };
  }
  const host = (options.env ?? process.env).OLLAMA_HOST || 'http://localhost:11434';
  try {
    const response = await (options.fetchImpl ?? fetch)(`${host.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) throw new Error(`Ollama health returned ${response.status}`);
    const payload = await response.json() as { models?: Array<{ name?: unknown; model?: unknown }> };
    const installedIds = (Array.isArray(payload.models) ? payload.models : [])
      .flatMap((model) => [model.name, model.model])
      .filter((modelId): modelId is string => typeof modelId === 'string');
    const installedModelIds = configuredLocalAgentModels(options.env ?? process.env)
      .filter((configuredId) => installedIds.some((installedId) => installedModelMatches(configuredId, installedId)));
    return {
      status: 'connected',
      executionReady: installedModelIds.length > 0,
      note: installedModelIds.length > 0
        ? `Ollama is reachable with ${installedModelIds.length} allowlisted local agent model(s) installed.`
        : 'Ollama is reachable, but none of the allowlisted local agent models are installed.',
      installedModelIds,
    };
  } catch {
    return {
      status: 'unavailable',
      executionReady: false,
      note: 'Ollama is not reachable at the configured OLLAMA_HOST.',
      installedModelIds: [],
    };
  }
}

export async function listAgentProviders(): Promise<AgentProvider[]> {
  const descriptors = listSubscriptionRuntimeDescriptors();
  const [probes, localReadiness] = await Promise.all([
    Promise.all(descriptors.flatMap((descriptor) => descriptor.models.map((model) =>
      probeAcpSubscriptionRuntime(descriptor.providerId, model.id)))),
    probeLocalAgentRuntime(),
  ]);
  const probeByModel = new Map(probes.map((probe) => [`${probe.providerId}:${probe.modelId}`, probe]));
  const exactSubscriptionProbePassed = (providerId: string, modelId: string): boolean => {
    const probe = probeByModel.get(`${providerId}:${modelId}`);
    const runtime = resolveSubscriptionAcpServer(providerId, modelId);
    return Boolean(runtime
      && probe?.status === 'connected'
      && probe.exactModelId === runtime.exactModelId
      && probe.runtimeFingerprint === runtime.runtimeFingerprint);
  };
  const localModels = configuredLocalAgentModels();
  const installedLocalModels = new Set(localReadiness.installedModelIds);
  const local: AgentProvider =
    {
      id: 'ollama-local',
      label: 'Ollama local',
      authKind: 'none',
      status: localReadiness.status,
      executionReady: localModels.some((modelId) => installedLocalModels.has(modelId)),
      models: localModels.map((modelId) => ({
        id: modelId,
        label: modelId,
        executionReady: installedLocalModels.has(modelId),
        note: installedLocalModels.has(modelId)
          ? 'Installed in Ollama and allowlisted for local agent execution.'
          : 'Allowlisted, but not currently installed in Ollama.',
      })),
      note: localReadiness.note,
    };
  const subscriptions: AgentProvider[] = descriptors.map((descriptor) => ({
    id: descriptor.providerId,
    label: descriptor.label,
    authKind: descriptor.authKind,
    status: descriptor.models.some((model) =>
      exactSubscriptionProbePassed(descriptor.providerId, model.id))
      ? 'connected' : 'unavailable',
    executionReady: descriptor.models.some((model) =>
      exactSubscriptionProbePassed(descriptor.providerId, model.id)),
    models: descriptor.models.map((model) => {
      const ready = exactSubscriptionProbePassed(descriptor.providerId, model.id);
      return {
        id: model.id,
        label: model.probeRequired ? `${model.label} (probe required)` : model.label,
        executionReady: ready,
        note: model.probeRequired && !ready
          ? 'Requires a successful exact ACP model and runtime fingerprint probe.'
          : descriptor.risk === 'vendor_builtin_tools_os_tcb'
            ? 'Requires operator acceptance: Grok retains vendor built-in tools and trusts the vendor CLI/OS.'
            : ready ? 'Exact ACP model and runtime fingerprint verified.' : 'Exact ACP metadata probe has not passed.',
      };
    }),
    note: descriptor.risk === 'vendor_builtin_tools_os_tcb'
      ? 'Grok ACP is not tool-free: vendor built-in tools and the CLI/OS are trusted after operator consent.'
      : 'ACP readiness requires an exact model report and immutable runtime fingerprint.',
  }));
  return [local, ...subscriptions];
}

function verifyOperator(principalId: string | null): CollabSurfaceError | null {
  if (principalId === null) return COLLAB_IDENTITY_REQUIRED;
  const db = getCollabDbForAutoReply();
  if (!db) return { code: 'COLLAB_UNAVAILABLE' };
  try {
    runAgentRuntimeProfileMigration(
      db as unknown as Parameters<typeof runAgentRuntimeProfileMigration>[0],
    );
    const row = db.prepare('SELECT kind, status FROM principals WHERE id = ? LIMIT 1').get(principalId) as
      | { kind?: string; status?: string }
      | undefined;
    return row?.kind === 'operator' && row.status === 'active'
      ? null
      : COLLAB_IDENTITY_REQUIRED;
  } catch {
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}

export async function handleListAgentProviders(
  sessionId: string,
  principalId: string | null,
): Promise<CollabSurfaceError | null> {
  const identityError = verifyOperator(principalId);
  if (identityError) return identityError;
  try {
    publishCollabSurface(sessionId, 'Agent providers listed', {
      agentProviders: true,
      providers: await listAgentProviders(),
    });
    return null;
  } catch {
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}

export async function handleListAgents(
  sessionId: string,
  principalId: string | null,
  limit: number,
  hasLiveManageAgentsAuthority: () => boolean,
): Promise<CollabSurfaceError | null> {
  const identityError = verifyOperator(principalId);
  if (identityError || principalId === null) return identityError ?? COLLAB_IDENTITY_REQUIRED;
  if (!hasLiveManageAgentsAuthority()) {
    return { code: 'COLLAB_INVALID_REQUEST', detail: 'Live delegate authority is required to list agent directives' };
  }
  const db = getCollabDbForAutoReply();
  if (!db) return { code: 'COLLAB_UNAVAILABLE' };
  try {
    const rows = db.prepare(
      `SELECT id AS principalId, display_name AS displayName, status, created_at AS createdAt
         FROM principals
        WHERE kind = 'agent' AND owner_principal_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    ).all(principalId, limit) as Array<{
      principalId: string;
      displayName: string;
      status: string;
      createdAt: string;
    }>;
    const localModel = process.env.TORQCLAW_LOCAL_MODEL || 'torq-local';
    const store = getStore();
    if (!store) return { code: 'COLLAB_UNAVAILABLE' };
    const agents = await Promise.all(rows.map(async (row) => {
      const profile = await store.getAgentRuntimeProfile(callerFor(principalId), {
        agentPrincipalId: row.principalId,
      });
      const persona = db.prepare(
        `SELECT icon_id AS iconId, system_directives AS systemDirectives, revision AS personaRevision
           FROM collab_agent_personas WHERE agent_principal_id = ?`,
      ).get(row.principalId) as {
        iconId: string;
        systemDirectives: string;
        personaRevision: number;
      } | undefined;
      return {
        ...row,
        providerId: profile?.providerAccountId ?? 'ollama-local',
        modelId: profile?.modelId ?? localModel,
        autostart: profile?.autostart ?? false,
        externalContextConfirmed: profile?.externalContextConfirmed ?? false,
        iconId: persona?.iconId ?? 'robot',
        systemDirectives: persona?.systemDirectives ?? '',
        personaRevision: persona?.personaRevision ?? 0,
        channels: db.prepare(
          `SELECT c.id AS channelId, c.name AS channelName
             FROM collab_members m
             JOIN collab_channels c ON c.id = m.channel_id
            WHERE m.principal_id = ? AND m.state = 'active' AND c.state = 'active'
            ORDER BY c.name ASC, c.id ASC`,
        ).all(row.principalId),
      };
    }));
    if (!hasLiveManageAgentsAuthority()) {
      return { code: 'COLLAB_INVALID_REQUEST', detail: 'Live delegate authority expired while listing agent directives' };
    }
    publishCollabSurface(sessionId, 'Agents listed', { collabAgents: true, agents });
    return null;
  } catch {
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}

export async function handleUpdateAgentProfile(
  principalId: string | null,
  input: {
    agentPrincipalId: string;
    iconId: 'robot' | 'brain' | 'shield' | 'search' | 'code' | 'spark' | 'bolt' | 'target';
    systemDirectives: string;
    expectedRevision: number;
    reconfirmExternalContext: boolean;
    idempotencyKey: string;
  },
  hasLiveManageAgentsAuthority: () => boolean,
): Promise<AgentMutationOutcome> {
  const identityError = verifyOperator(principalId);
  if (identityError || principalId === null) return mutationError(identityError ?? COLLAB_IDENTITY_REQUIRED);
  const store = getStore();
  if (!store) return { status: 'error', errorCode: 'unavailable' };
  try {
    let externalContextRuntimeFingerprint: string | null = null;
    let externalContextExactModelId: string | null = null;
    if (input.reconfirmExternalContext) {
      const profile = await store.getAgentRuntimeProfile(callerFor(principalId), {
        agentPrincipalId: input.agentPrincipalId,
      });
      const runtime = profile && profile.providerAccountId !== 'ollama-local'
        ? resolveSubscriptionAcpServer(profile.providerAccountId, profile.modelId)
        : null;
      if (!profile || !runtime || runtime.exactModelId !== profile.modelId) {
        return { status: 'error', errorCode: 'invalid_request' };
      }
      externalContextRuntimeFingerprint = runtime.runtimeFingerprint;
      externalContextExactModelId = runtime.exactModelId;
    }
    const updated = await store.upsertAgentPersona(
      callerFor(principalId),
      { ...input, externalContextRuntimeFingerprint, externalContextExactModelId },
      input.idempotencyKey,
      hasLiveManageAgentsAuthority,
    );
    return { status: 'success', agent: updated };
  } catch (error: any) {
    if (error?.code === 'PERSONA_REVISION_CONFLICT') {
      return { status: 'conflict', conflict: 'revision' };
    }
    if (error?.code === 'INVALID_REQUEST') {
      return { status: 'error', errorCode: 'invalid_request' };
    }
    if (error?.code === 'IDEMPOTENCY_CONFLICT') {
      return { status: 'conflict', conflict: 'idempotency' };
    }
    if (error?.code === 'COLLAB_NOT_PERMITTED') {
      return { status: 'error', errorCode: 'not_permitted' };
    }
    return { status: 'error', errorCode: 'unavailable' };
  }
}

export async function handleCreateAgent(
  principalId: string | null,
  input: {
    displayName: string;
    providerId: string;
    modelId: string;
    autostart: boolean;
    externalContextConfirmed: boolean;
    channelIds: string[];
    idempotencyKey: string;
  },
  hasLiveManageAgentsAuthority: () => boolean,
): Promise<AgentMutationOutcome> {
  const identityError = verifyOperator(principalId);
  if (identityError || principalId === null) return mutationError(identityError ?? COLLAB_IDENTITY_REQUIRED);
  const store = getStore();
  if (!store) return { status: 'error', errorCode: 'unavailable' };
  try {
    const providers = await listAgentProviders();
    const provider = providers.find((candidate) => candidate.id === input.providerId);
    if (!provider) {
      return { status: 'error', errorCode: 'invalid_request' };
    }
    const model = provider.models.find((candidate) => candidate.id === input.modelId);
    if (!model) {
      return { status: 'error', errorCode: 'invalid_request' };
    }
    if (!provider.executionReady || !model.executionReady) {
      return { status: 'error', errorCode: 'invalid_request' };
    }
    if (provider.authKind === 'external_cli_session'
      && (input.autostart || input.externalContextConfirmed)) {
      return { status: 'error', errorCode: 'invalid_request' };
    }
    const runtimeBinding = input.providerId === 'ollama-local'
      ? null : resolveSubscriptionAcpServer(input.providerId, input.modelId);
    if (input.providerId !== 'ollama-local' && !runtimeBinding) {
      return { status: 'error', errorCode: 'invalid_request' };
    }
    try {
      const created = await store.provisionAgent(callerFor(principalId), {
        displayName: input.displayName,
        providerAccountId: input.providerId,
        adapterId: input.providerId === 'ollama-local' ? 'ollama-local' : `${input.providerId}:canonical`,
        modelId: input.modelId,
        autostart: input.autostart,
        externalContextConfirmed: input.externalContextConfirmed,
        externalContextRuntimeFingerprint: null,
        externalContextExactModelId: null,
        externalContextPersonaRevision: null,
        externalContextPersonaContentSha256: null,
        channelIds: input.channelIds,
      }, input.idempotencyKey, hasLiveManageAgentsAuthority);
      return {
        status: 'success',
        agent: {
          principalId: created.agentPrincipalId,
          displayName: created.displayName,
          providerId: created.providerAccountId,
          modelId: created.modelId,
          externalContextConfirmed: created.externalContextConfirmed,
        },
        membershipResults: created.membershipResults,
      };
    } catch (provisioningError: any) {
      if (provisioningError?.code === 'IDEMPOTENCY_CONFLICT') {
        return { status: 'conflict', conflict: 'idempotency' };
      }
      if (provisioningError?.code === 'COLLAB_NOT_PERMITTED') {
        return { status: 'error', errorCode: 'not_permitted' };
      }
      if (provisioningError?.code === 'INVALID_REQUEST') {
        return { status: 'error', errorCode: 'invalid_request' };
      }
      return {
        status: 'error',
        errorCode: 'provisioning_failed',
        membershipResults: [...new Set(input.channelIds)].map((channelId) => ({
          channelId,
          ok: false,
        })),
      };
    }
  } catch (error: any) {
    if (error?.code === 'INVALID_REQUEST') {
      return { status: 'error', errorCode: 'invalid_request' };
    }
    if (error?.code === 'IDEMPOTENCY_CONFLICT') {
      return { status: 'conflict', conflict: 'idempotency' };
    }
    return { status: 'error', errorCode: 'unavailable' };
  }
}

export type AgentMutationErrorCode =
  | 'identity_required'
  | 'invalid_request'
  | 'not_enabled'
  | 'not_permitted'
  | 'provisioning_failed'
  | 'unavailable';

export type AgentMutationOutcome =
  | { status: 'success'; agent: unknown; membershipResults?: unknown[] }
  | { status: 'conflict'; conflict: 'revision' | 'idempotency' }
  | { status: 'error'; errorCode: AgentMutationErrorCode; membershipResults?: unknown[] };

export type AgentMutationReporting = {
  operation: 'create' | 'update';
  idempotencyKey: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function extractAgentMutationReporting(raw: unknown): AgentMutationReporting | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  const operation = frame.action === 'CREATE_AGENT'
    ? 'create'
    : frame.action === 'UPDATE_AGENT_PROFILE' ? 'update' : null;
  if (operation === null) return null;
  return {
    operation,
    idempotencyKey: typeof frame.idempotencyKey === 'string' && UUID_PATTERN.test(frame.idempotencyKey)
      ? frame.idempotencyKey
      : null,
  };
}

const AGENT_MUTATION_ERROR_MESSAGES = {
  identity_required: 'Operator identity is required.',
  invalid_request: 'The agent request is invalid.',
  not_enabled: 'Agent management is not enabled.',
  not_permitted: 'Live delegate authority is required for agent management.',
  provisioning_failed: 'Agent provisioning failed; no changes were committed.',
  unavailable: 'Agent management is temporarily unavailable.',
} as const;

const AGENT_MUTATION_CONFLICT_MESSAGES = {
  revision: 'Agent profile changed; reload it before saving.',
  idempotency: 'This mutation key was already used for a different request.',
} as const;

export function normalizeAgentMutationTerminalResult(
  reporting: AgentMutationReporting,
  outcome: AgentMutationOutcome,
): Record<string, unknown> {
  const base = {
    agentMutationTerminal: true,
    operation: reporting.operation,
    idempotencyKey: reporting.idempotencyKey,
    status: outcome.status,
  };
  if (outcome.status === 'success') {
    return {
      ...base,
      message: reporting.operation === 'create' ? 'Agent created.' : 'Agent profile updated.',
      agent: outcome.agent,
      ...(outcome.membershipResults ? { membershipResults: outcome.membershipResults } : {}),
    };
  }
  if (outcome.status === 'conflict') {
    return { ...base, conflict: outcome.conflict, message: AGENT_MUTATION_CONFLICT_MESSAGES[outcome.conflict] };
  }
  return {
    ...base,
    errorCode: outcome.errorCode,
    message: AGENT_MUTATION_ERROR_MESSAGES[outcome.errorCode],
    ...(outcome.membershipResults ? { membershipResults: outcome.membershipResults } : {}),
  };
}

function mutationError(error: CollabSurfaceError): AgentMutationOutcome {
  if (error.code === 'COLLAB_IDENTITY_REQUIRED') return { status: 'error', errorCode: 'identity_required' };
  if (error.code === 'COLLAB_INVALID_REQUEST') return { status: 'error', errorCode: 'invalid_request' };
  return { status: 'error', errorCode: 'unavailable' };
}
