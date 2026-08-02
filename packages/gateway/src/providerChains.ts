import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ResilienceImmutablePlanSchema,
  type ResilienceImmutablePlan,
  type GatewayRequest,
} from '@torqclaw/contracts';

/** Provider configuration is intentionally a reference-only shape. Values
 * such as API keys and endpoints are never accepted by this module. */
export interface ProviderDefinition {
  id: string;
  label: string;
  modelId: string;
  apiKeyEnvName: string;
  baseUrlEnvName: string;
  privacyClasses: string[];
  ceilingMicroUsd: number;
}

export interface ProviderChainDefinition {
  id: string;
  providers: ProviderDefinition[];
}

export interface ProviderChainsDocument {
  revision: string;
  chains: Record<string, ProviderChainDefinition>;
}

export interface ResolvedProviderChain extends ProviderChainDefinition {
  taskClass: string;
  revision: string;
  providers: [ProviderDefinition, ProviderDefinition];
}

export interface ProviderReference {
  id: string;
  label: string;
  modelId: string;
  apiKeyEnvName: string;
  baseUrlEnvName: string;
}

export const CHAIN_ENV_NAMES = Object.freeze({
  enabled: 'TORQCLAW_PROVIDER_FAILOVER_ENABLED',
  path: 'TORQCLAW_PROVIDER_CHAINS_PATH',
  revision: 'TORQCLAW_PROVIDER_CHAIN_REVISION',
  defaultChain: 'TORQCLAW_FAILOVER_DEFAULT_CHAIN',
  codingChain: 'TORQCLAW_FAILOVER_CODING_CHAIN',
  attemptTimeout: 'TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS',
  taskDeadline: 'TORQCLAW_FAILOVER_TASK_DEADLINE_MS',
  transitionMin: 'TORQCLAW_FAILOVER_TRANSITION_MIN_MS',
  transitionMax: 'TORQCLAW_FAILOVER_TRANSITION_MAX_MS',
  cancelAck: 'TORQCLAW_FAILOVER_CANCEL_ACK_MS',
});

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const REVISION = /^[!-~]{1,128}$/;
const TASK_CLASS = /^[A-Z][A-Z0-9_]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new Error(`FAILOVER_CONFIG_REJECTED: ${message}`);
}

function objectOnly(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name}.${key} is not allowed`);
}

function stringField(value: Record<string, unknown>, key: string, pattern: RegExp, name: string): string {
  if (typeof value[key] !== 'string' || !pattern.test(value[key])) fail(`${name}.${key} is invalid`);
  return value[key] as string;
}

function integerField(value: Record<string, unknown>, key: string, name: string): number {
  if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) fail(`${name}.${key} is invalid`);
  return value[key] as number;
}

function parseProvider(value: unknown, index: number): ProviderDefinition {
  const raw = objectOnly(value, `providers[${index}]`);
  exactKeys(raw, ['id', 'label', 'modelId', 'apiKeyEnvName', 'baseUrlEnvName', 'privacyClasses', 'ceilingMicroUsd'], `providers[${index}]`);
  const name = `providers[${index}]`;
  const privacyClasses = raw.privacyClasses;
  if (!Array.isArray(privacyClasses) || privacyClasses.length === 0 ||
      privacyClasses.some((v) => typeof v !== 'string' || !TASK_CLASS.test(v) && !['standard', 'sensitive'].includes(v))) {
    fail(`${name}.privacyClasses is invalid`);
  }
  const uniquePrivacy = [...new Set(privacyClasses as string[])];
  if (uniquePrivacy.length !== privacyClasses.length) fail(`${name}.privacyClasses must be unique`);
  return {
    id: stringField(raw, 'id', LABEL, name),
    label: stringField(raw, 'label', LABEL, name),
    modelId: stringField(raw, 'modelId', LABEL, name),
    apiKeyEnvName: stringField(raw, 'apiKeyEnvName', ENV_NAME, name),
    baseUrlEnvName: stringField(raw, 'baseUrlEnvName', ENV_NAME, name),
    privacyClasses: uniquePrivacy,
    ceilingMicroUsd: integerField(raw, 'ceilingMicroUsd', name),
  };
}

function parseChain(value: unknown, chainKey: string): ProviderChainDefinition {
  const raw = objectOnly(value, `chains.${chainKey}`);
  exactKeys(raw, ['id', 'providers'], `chains.${chainKey}`);
  const id = stringField(raw, 'id', LABEL, `chains.${chainKey}`);
  if (id !== chainKey) fail(`chains.${chainKey}.id must match its key`);
  if (!Array.isArray(raw.providers) || raw.providers.length !== 2) fail(`chains.${chainKey} must contain exactly two providers`);
  const providers = raw.providers.map(parseProvider);
  if (new Set(providers.map((provider) => provider.id)).size !== 2) fail(`chains.${chainKey} providers must be distinct`);
  return { id, providers };
}

/** Parse and validate a reference-only chain document. This is the single
 * trust boundary for provider order and environment-variable names. */
export function parseProviderChainsDocument(value: unknown): ProviderChainsDocument {
  const raw = objectOnly(value, 'providerChains');
  exactKeys(raw, ['revision', 'chains'], 'providerChains');
  const revision = stringField(raw, 'revision', REVISION, 'providerChains');
  const chainsRaw = objectOnly(raw.chains, 'providerChains.chains');
  const entries = Object.entries(chainsRaw);
  if (entries.length === 0 || entries.length > 16) fail('providerChains.chains must not be empty');
  const chains: Record<string, ProviderChainDefinition> = {};
  for (const [key, value] of entries) {
    if (!LABEL.test(key)) fail(`chain key '${key}' is invalid`);
    chains[key] = parseChain(value, key);
  }
  return { revision, chains };
}

export function loadProviderChainsDocument(env: NodeJS.ProcessEnv = process.env): ProviderChainsDocument {
  const path = env[CHAIN_ENV_NAMES.path];
  if (!path) fail(`${CHAIN_ENV_NAMES.path} is required when failover is enabled`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${CHAIN_ENV_NAMES.path} could not be read as JSON`);
  }
  const document = parseProviderChainsDocument(parsed);
  const configuredRevision = env[CHAIN_ENV_NAMES.revision];
  if (configuredRevision !== undefined && configuredRevision !== document.revision) {
    fail(`${CHAIN_ENV_NAMES.revision} does not match the chain document`);
  }
  return document;
}

export function resolveProviderChain(
  req: GatewayRequest,
  document: ProviderChainsDocument = loadProviderChainsDocument(),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderChain {
  const taskClass = req.payload.taskType;
  const configuredName = taskClass === 'COMPLEX_CODING'
    ? env[CHAIN_ENV_NAMES.codingChain]
    : env[CHAIN_ENV_NAMES.defaultChain];
  const chainName = configuredName || (taskClass === 'COMPLEX_CODING' ? 'coding' : 'default');
  const chain = document.chains[chainName];
  if (!chain) fail(`no chain configured for ${taskClass}`);
  const privacyClass = req.constraints.containsSensitiveData ? 'sensitive' : 'standard';
  const eligible = chain.providers.filter((provider) => provider.privacyClasses.includes(privacyClass));
  if (eligible.length !== 2) fail(`privacy policy leaves fewer than two eligible providers for ${taskClass}`);
  const first = eligible[0];
  const second = eligible[1];
  if (!first || !second) fail('privacy policy leaves fewer than two eligible providers');
  if (first.id === second.id) fail('eligible provider order is not distinct');
  return { ...chain, taskClass, revision: document.revision, providers: [first, second] };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export function providerReference(provider: ProviderDefinition): ProviderReference {
  return {
    id: provider.id,
    label: provider.label,
    modelId: provider.modelId,
    apiKeyEnvName: provider.apiKeyEnvName,
    baseUrlEnvName: provider.baseUrlEnvName,
  };
}

function positiveEnvMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

export interface PlanOptions {
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Build the frozen, secret-free plan. The provider chain is already filtered
 * for privacy; this function never reads provider environment-variable values. */
export function buildFailoverPlan(
  req: GatewayRequest,
  chain: ResolvedProviderChain,
  options: PlanOptions = {},
): ResilienceImmutablePlan {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('nowMs is invalid');
  const attemptTimeoutMs = positiveEnvMs(env, CHAIN_ENV_NAMES.attemptTimeout, 60_000);
  const taskDeadlineMs = positiveEnvMs(env, CHAIN_ENV_NAMES.taskDeadline, 120_000);
  const deadline = nowMs + taskDeadlineMs;
  if (!Number.isSafeInteger(deadline) || deadline <= nowMs) fail('task deadline overflow');
  const privacyClass = req.constraints.containsSensitiveData ? 'sensitive' : 'standard';
  const context = req.payload.assembledContext ?? '';
  const budgetMicroUsd = req.constraints.maxCost === undefined
    ? null
    : Math.round(req.constraints.maxCost * 1_000_000);
  if (budgetMicroUsd !== null && (!Number.isSafeInteger(budgetMicroUsd) || budgetMicroUsd < 0)) fail('maxCost cannot be represented in micro-USD');
  const plan = {
    schemaVersion: 1 as const,
    taskId: req.id,
    chainId: chain.id,
    eligibleProviderIds: chain.providers.map((provider) => provider.id),
    privacyClass,
    privacyHash: sha256({ privacyClass }),
    policyHash: sha256({ requiredTools: [...req.payload.requiredTools].sort(), constraints: req.constraints }),
    contextHash: sha256({ prompt: req.payload.prompt, context }),
    grantHash: sha256([...(req.payload.grantedTools ?? [])].sort()),
    taskDeadlineMs: deadline,
    attemptTimeoutMs,
    transitionLimit: 1,
    budgetMicroUsd,
    providerCeilings: Object.fromEntries(chain.providers.map((provider) => [provider.id, provider.ceilingMicroUsd])),
    featurePolicyRevision: env[CHAIN_ENV_NAMES.revision] ?? chain.revision,
    planRevision: '1',
  } satisfies ResilienceImmutablePlan;
  const result = ResilienceImmutablePlanSchema.safeParse(plan);
  if (!result.success) fail(`immutable plan rejected: ${result.error.message}`);
  return result.data;
}

export function planHash(plan: ResilienceImmutablePlan): string {
  return sha256(plan);
}

export function isFailoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CHAIN_ENV_NAMES.enabled]?.toLowerCase() === 'true';
}

export function assertFrontier(tier: string): void {
  if (tier !== 'API_EXTERNAL') fail('resilience is FRONTIER-only');
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}
