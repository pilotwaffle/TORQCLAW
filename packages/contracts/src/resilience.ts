import { z } from 'zod';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const SAFE_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const portableCaseInsensitive = (pattern: string): string => pattern.replace(/[A-Za-z]/g, (char) => `[${char.toLowerCase()}${char.toUpperCase()}]`);
const PROVIDER_FORBIDDEN = [
  'credential', 'secret', 'password', 'token', 'cookie', 'authorization',
  'api[_-]?key', 'provider[_-]?error', 'headers',
].map(portableCaseInsensitive).join('|');
const KEY_FORBIDDEN = [
  'credential', 'secret', 'password', 'token', 'cookie', 'authorization',
  'apikey', 'rawerror', 'errorbody', 'providererror', 'headers', 'error',
].map(portableCaseInsensitive).join('|');
const PROVIDER_ID = new RegExp(`^(?!.*(?:${PROVIDER_FORBIDDEN}))[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`);
const SAFE_KEY = new RegExp(`^(?!.*(?:${KEY_FORBIDDEN}))[A-Za-z][A-Za-z0-9_.-]{0,63}$`);
const FORBIDDEN_KEY_PARTS = ['credential', 'secret', 'password', 'token', 'cookie',
  'authorization', 'apikey', 'rawerror', 'errorbody', 'providererror', 'headers', 'error'];

export const MicroUsdSchema = z.number().int().nonnegative().max(MAX_SAFE_INTEGER);
export type MicroUsd = z.infer<typeof MicroUsdSchema>;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TaskIdSchema = z.string().regex(/^[!-~]{1,256}$/);
const AttemptIdSchema = z.string().regex(/^[!-~]{1,128}$/);
const BoundedTextSchema = z.string().regex(/^[!-~]{1,128}$/);
const RevisionSchema = BoundedTextSchema;
const SafeTokenSchema = z.string().regex(SAFE_TOKEN);
export const PROVIDER_STATE_VERSION = 1 as const;
export const PROVIDER_STATES = [
  'provider_ready', 'provider_started', 'queued', 'starting', 'connecting',
  'thinking', 'processing', 'streaming', 'receiving', 'waiting', 'progress',
] as const;
export const ProviderStateSchema = z.enum(PROVIDER_STATES);
export type ProviderState = z.infer<typeof ProviderStateSchema>;
export const ProviderIdSchema = z.string().regex(PROVIDER_ID);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
const SafeKeySchema = z.string().regex(SAFE_KEY);
const SafeIntegerSchema = z.number().int().min(-MAX_SAFE_INTEGER).max(MAX_SAFE_INTEGER);

function rejectSensitiveKeys(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const key of Object.keys(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    if (FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part))) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'sensitive payload key is not allowed' });
    }
  }
}

const SafeHashEnvelopeSchema = z.object({
  sha256: HashSchema,
  length: z.number().int().nonnegative().max(16_384),
}).strict();

// Caller/provider strings are represented only by this non-reversible envelope.
const SafePayloadValueSchema: z.ZodTypeAny = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  SafeIntegerSchema,
  SafeHashEnvelopeSchema,
  z.array(SafePayloadValueSchema).max(256),
  z.record(SafeKeySchema, SafePayloadValueSchema).superRefine(rejectSensitiveKeys),
]));
const SafePayloadSchema = z.record(SafeKeySchema, SafePayloadValueSchema)
  .superRefine(rejectSensitiveKeys);

type SafePayload = z.infer<typeof SafePayloadSchema>;

export const ResilienceImmutablePlanSchema = z.object({
  schemaVersion: z.literal(1), taskId: TaskIdSchema,
  chainId: BoundedTextSchema,
  eligibleProviderIds: z.array(ProviderIdSchema).min(1).max(64),
  privacyClass: BoundedTextSchema, privacyHash: HashSchema,
  policyHash: HashSchema, contextHash: HashSchema, grantHash: HashSchema,
  taskDeadlineMs: z.number().int().positive().max(MAX_SAFE_INTEGER),
  attemptTimeoutMs: z.number().int().positive().max(MAX_SAFE_INTEGER),
  transitionLimit: z.number().int().nonnegative().max(64),
  budgetMicroUsd: MicroUsdSchema.nullable(),
  providerCeilings: z.record(ProviderIdSchema, MicroUsdSchema),
  featurePolicyRevision: RevisionSchema, planRevision: RevisionSchema,
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.eligibleProviderIds).size !== plan.eligibleProviderIds.length) {
    ctx.addIssue({ code: 'custom', path: ['eligibleProviderIds'], message: 'provider IDs must be unique' });
  }
  for (const id of plan.eligibleProviderIds) if (!(id in plan.providerCeilings)) {
    ctx.addIssue({ code: 'custom', path: ['providerCeilings'], message: `missing ceiling for ${id}` });
  }
  if (plan.transitionLimit > plan.eligibleProviderIds.length - 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['transitionLimit'],
      message: 'transitionLimit exceeds provider chain',
    });
  }
});
export type ResilienceImmutablePlan = z.infer<typeof ResilienceImmutablePlanSchema>;

export const ResilienceActiveTupleSchema = z.object({
  taskId: TaskIdSchema, attemptId: AttemptIdSchema,
  epoch: z.number().int().nonnegative().max(MAX_SAFE_INTEGER),
}).strict();
export type ResilienceActiveTuple = z.infer<typeof ResilienceActiveTupleSchema>;

export const ResilienceFailureClassSchema = z.enum(['retryable','configuration','authentication','budget','side_effect_uncertainty','timeout','cancelled','terminal']);
export const ResilienceNormalizedFailureSchema = z.object({
  failureClass: ResilienceFailureClassSchema, code: SafeTokenSchema, retryable: z.boolean(),
}).strict().superRefine((failure, ctx) => {
  if (failure.retryable !== (failure.failureClass === 'retryable')) ctx.addIssue({ code: 'custom', path: ['retryable'], message: 'retryability is derived from failureClass' });
});
export type ResilienceNormalizedFailure = z.infer<typeof ResilienceNormalizedFailureSchema>;

const OutboxBase = {
  outboxId: z.number().int().positive().max(MAX_SAFE_INTEGER),
  taskId: TaskIdSchema,
  attemptId: AttemptIdSchema,
  epoch: z.number().int().nonnegative().max(MAX_SAFE_INTEGER),
  createdAtMs: z.number().int().positive().max(MAX_SAFE_INTEGER),
};
const EmptyPayloadSchema = z.object({}).strict();
const CostPayloadSchema = z.object({
  actualCostMicroUsd: MicroUsdSchema.nullable(), known: z.boolean(),
}).strict();
const CompletionPayloadSchema = z.object({
  outcome: z.enum(['completed', 'cancelled', 'cancelled_uncertain', 'failed', 'terminal']),
  actualCostMicroUsd: MicroUsdSchema.nullable(), known: z.boolean(),
}).strict();
const TransitionPayloadSchema = z.object({
  predecessor: ResilienceActiveTupleSchema,
  predecessorProviderId: ProviderIdSchema,
  successorProviderId: ProviderIdSchema,
  failure: ResilienceNormalizedFailureSchema,
}).strict();

const outboxVariant = <T extends z.ZodTypeAny>(kind: string, payload: T) =>
  z.object({ ...OutboxBase, kind: z.literal(kind), payload }).strict();

export const ResilienceOutboxKindSchema = z.enum([
  'attempt_created', 'provider_event', 'dispatch_attempted', 'cost_recorded',
  'state_mutated', 'cancel_requested', 'attempt_completed', 'transitioned',
  'pre_dispatch_recovered',
]);
export const ResilienceOutboxEventSchema = z.discriminatedUnion('kind', [
  outboxVariant('attempt_created', z.object({
    providerId: ProviderIdSchema,
    planHash: HashSchema,
  }).strict()),
  outboxVariant('provider_event', z.object({ eventKind: SafeTokenSchema, payload: SafePayloadSchema }).strict()),
  outboxVariant('dispatch_attempted', EmptyPayloadSchema),
  outboxVariant('cost_recorded', CostPayloadSchema),
  outboxVariant('state_mutated', z.object({ state: ProviderStateSchema, payload: SafePayloadSchema }).strict()),
  outboxVariant('cancel_requested', EmptyPayloadSchema),
  outboxVariant('attempt_completed', CompletionPayloadSchema),
  outboxVariant('transitioned', TransitionPayloadSchema),
  outboxVariant('pre_dispatch_recovered', EmptyPayloadSchema),
]);
export type ResilienceOutboxEvent = z.infer<typeof ResilienceOutboxEventSchema>;

export const ImmutablePlanSchema = ResilienceImmutablePlanSchema;
export const ActiveTupleSchema = ResilienceActiveTupleSchema;
export const NormalizedFailureSchema = ResilienceNormalizedFailureSchema;
export const OutboxEventSchema = ResilienceOutboxEventSchema;

/**
 * Refinements that JSON Schema cannot derive from Zod's cross-field checks.
 * The emitter adds standard `uniqueItems`/count conditionals and carries this
 * explicit metadata for consumers that validate plans outside TypeScript.
 * Provider-ceiling coverage is dynamic (array values must be object keys), so
 * it requires the companion parity check in the consuming runtime.
 */
export const ResiliencePlanJsonSchemaRefinements = Object.freeze({
  uniqueEligibleProviderIds: true,
  providerCeilingsCoverEligibleProviderIds: true,
  transitionLimitAtMostProviderCountMinusOne: true,
});

type JsonSchemaObject = Record<string, unknown>;

export function augmentResilienceImmutablePlanJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const properties = (schema.properties ?? {}) as JsonSchemaObject;
  const providerIds = (properties.eligibleProviderIds ?? {}) as JsonSchemaObject;
  const providerCeilings = (properties.providerCeilings ?? {}) as JsonSchemaObject;
  const allOf = Array.isArray(schema.allOf) ? [...schema.allOf] : [];
  for (let count = 1; count <= 64; count += 1) {
    allOf.push({
      if: {
        required: ['eligibleProviderIds'],
        properties: { eligibleProviderIds: { minItems: count, maxItems: count } },
      },
      then: { properties: { transitionLimit: { maximum: count - 1 } } },
    });
  }
  return {
    ...schema,
    properties: {
      ...properties,
      eligibleProviderIds: { ...providerIds, uniqueItems: true },
      providerCeilings: { ...providerCeilings, minProperties: 1 },
    },
    allOf,
    'x-torqclaw-refinements': ResiliencePlanJsonSchemaRefinements,
  };
}
