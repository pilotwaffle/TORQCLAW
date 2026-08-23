import { z } from 'zod';
import { EffectiveProfileSchema } from './profile.js';

export const TaskTypeSchema = z.enum([
  'DATA_EXTRACTION',
  'SUMMARIZATION',
  'ROUTINE_AUTOMATION',
  'AUTONOMOUS_RESEARCH',
  'COMPLEX_CODING',
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const AgentReachChannelSchema = z.enum([
  'github', 'twitter', 'youtube', 'reddit', 'facebook', 'instagram',
  'bilibili', 'xiaohongshu', 'linkedin', 'xiaoyuzhou', 'v2ex', 'xueqiu',
  'rss', 'exa_search', 'web',
]);
export type AgentReachChannel = z.infer<typeof AgentReachChannelSchema>;

export const AgentReachRoutingSchema = z.object({
  requestedChannels: z.array(AgentReachChannelSchema),
  localChannels: z.array(AgentReachChannelSchema),
  frontierChannels: z.array(AgentReachChannelSchema),
  localSatisfies: z.boolean(),
  frontierSatisfies: z.boolean(),
  writeIntent: z.boolean(),
});
export type AgentReachRouting = z.infer<typeof AgentReachRoutingSchema>;

export const SubscriptionProviderIdSchema = z.enum([
  'grok-subscription',
  'kimi-subscription',
  'qwen-subscription',
  'zai-subscription',
]);
export type SubscriptionProviderId = z.infer<typeof SubscriptionProviderIdSchema>;

/**
 * A resolved subscription runtime binding. This object is gateway-owned: it
 * is assembled from the authenticated agent runtime profile and is never a
 * field on ClientCommand or copied from websocket input. `confirmed: true`
 * records that the gateway completed the profile/readiness checks before the
 * router may select an external subscription provider.
 */
export const SubscriptionExecutionTargetSchema = z.object({
  providerId: SubscriptionProviderIdSchema,
  providerAccountId: z.string().trim().min(1).max(200),
  adapterId: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(200),
  exactModelId: z.string().trim().min(1).max(200),
  runtimeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  personaRevision: z.number().int().nonnegative(),
  personaContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
}).strict();
export type SubscriptionExecutionTarget = z.infer<typeof SubscriptionExecutionTargetSchema>;

/**
 * A resolved local runtime binding. Like the subscription target above, this
 * is gateway-owned and must never be copied from a ClientCommand/websocket
 * frame. Its absence preserves the process-wide TORQCLAW_LOCAL_MODEL default.
 */
export const LocalExecutionTargetSchema = z.object({
  providerId: z.literal('ollama-local'),
  adapterId: z.literal('ollama-local'),
  modelId: z.string().trim().min(1).max(200),
}).strict();
export type LocalExecutionTarget = z.infer<typeof LocalExecutionTargetSchema>;

const PERSONA_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Immutable gateway-minted persona snapshot for one managed-agent turn. */
export const AgentPersonaEnvelopeSchema = z.object({
  version: z.literal(1),
  content: z.string().max(4_000).refine(
    (value) => value === value.normalize('NFC').trim() && !PERSONA_FORBIDDEN.test(value),
    'persona content must be canonical NFC-trimmed text without control or bidi characters',
  ),
  personaRevision: z.number().int().nonnegative(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, ctx) => {
  if (value.content === '' && value.personaRevision !== 0) {
    ctx.addIssue({ code: 'custom', path: ['personaRevision'], message: 'blank persona revision must be zero' });
  }
});
export type AgentPersonaEnvelope = z.infer<typeof AgentPersonaEnvelopeSchema>;

/** Gateway-owned identity for one managed-agent channel turn. It is carried
 * only as internal tool-call metadata; no field is exposed to the model's
 * tool schema or accepted from ClientCommand. */
export const AgentTurnContextSchema = z.object({
  channelId: z.string().trim().min(1).max(200),
  agentPrincipalId: z.string().trim().min(1).max(200),
  channelSeq: z.number().int().positive(),
  triggerEventId: z.string().trim().min(1).max(200),
  personaRevision: z.number().int().nonnegative(),
  recoveryLeaseToken: z.uuid().optional(),
}).strict();
export type AgentTurnContext = z.infer<typeof AgentTurnContextSchema>;

export enum ComputeTier {
  LOCAL_EDGE = 'OLLAMA_LOCAL',
  FRONTIER = 'API_EXTERNAL',
}
export const ComputeTierSchema = z.enum(ComputeTier);

export const EnrichmentMetaSchema = z.object({
  classifierUsed: z.enum(['LOCAL_LLM', 'KEYWORD_FALLBACK', 'DEFAULT']),
  classifierConfidence: z.number().min(0).max(1),
  classifierLatencyMs: z.number(),
  estimatedTokens: z.number(),
  // P4.5: whether tiered memory was assembled for this task (useMemory toggle).
  memoryUsed: z.boolean().default(true),
  agentReach: AgentReachRoutingSchema.optional(),
});

/** The fully-enriched internal request. Built ONLY by the gateway. */
export const GatewayRequestSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  sourceChannel: z.string(),
  receivedAt: z.iso.datetime(),
  payload: z.object({
    prompt: z.string(),
    /** Tiered memory (recent turns + FTS5 recall) assembled by the gateway. */
    assembledContext: z.string().optional(),
    contextSize: z.number(),
    requiredTools: z.array(z.string()),
    taskType: TaskTypeSchema,
    /** One-time tool grants (P2). GATEWAY-OWNED ONLY — never on a client
     *  command; set solely by the APPROVE_TOOL re-mint. default([]) so fresh
     *  requests carry [] and the gate fires on the first attempt. */
    grantedTools: z.array(z.string()).default([]),
    /** PRD-TCLAW-AGENT-PARTICIPATION-007 S2: the collab principal id this
     *  task is bound to execute AS, when the task was dispatched on behalf
     *  of an agent principal (S1's `agentCollabPrincipalId`). GATEWAY-OWNED
     *  ONLY — never present on a ClientCommand and never spread from one; a
     *  ClientCommand schema (SUBMIT_PROMPT et al.) carries no field this
     *  could be read from, so there is nothing on the wire for a client to
     *  set it from (mirrors grantedTools' "never spread from cmd"
     *  discipline). Absent/undefined means "no bound agent identity" — the
     *  collab__* MCP tools then refuse COLLAB_IDENTITY_REQUIRED, never
     *  falling back to the operator or synthesizing a principal (§2a).
     *  Nothing in this repo sets this field yet; S1 binds identity only at
     *  the connection layer for POST_CHANNEL_MESSAGE, and the dispatch-time
     *  binding for a task (the mechanism S3's auto-reply loop will use) is
     *  intentionally out of S2's scope. S2 builds and proves the tool
     *  surface against this field as a precondition. */
    callerCollabPrincipalId: z.string().optional(),
    /** Gateway-owned resolved subscription binding. Never accepted from a
     *  ClientCommand/websocket frame. Privacy and local-only routing locks
     *  still take precedence over this external execution intent. */
    subscriptionExecutionTarget: SubscriptionExecutionTargetSchema.optional(),
    /** Gateway-owned local agent runtime binding. Ordinary local requests
     *  omit this and continue to use TORQCLAW_LOCAL_MODEL. */
    localExecutionTarget: LocalExecutionTargetSchema.optional(),
    /** Exact persona snapshot minted and persisted by the claim transaction. */
    agentPersonaEnvelope: AgentPersonaEnvelopeSchema.optional(),
    /** Gateway-owned managed-turn identity. Never copied from client input
     * and never rendered into model-visible tool arguments. */
    agentTurnContext: AgentTurnContextSchema.optional(),
  }),
  constraints: z.object({
    latencySensitivity: z.enum(['HIGH', 'LOW']),
    maxCost: z.number().optional(),
    containsSensitiveData: z.boolean(),
    // Carried verbatim so request_json captures exactly what the user chose;
    // pnpm stats reads user-forced vs router-chosen routing from here.
    executionMode: z.enum(['AUTO', 'LOCAL_ONLY', 'CLOUD_OK']).default('AUTO'),
  }),
  enrichment: EnrichmentMetaSchema,
  /** Gateway-owned, versioned policy resolved before tool prediction. */
  effectiveProfile: EffectiveProfileSchema.optional(),
});
export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;

export const RouterRuleIdSchema = z.enum([
  'PRIVACY_OVERRIDE',
  'USER_LOCAL_ONLY',
  'LOCAL_INTENT',
  'LOCAL_TOOL_INTENT',
  'AGENT_REACH_LOCAL',
  'AGENT_REACH_FRONTIER',
  'AGENT_SUBSCRIPTION_PROVIDER',
  'LOW_CLASSIFIER_CONFIDENCE',
  'TOOL_COUNT_OVERFLOW',
  'LATENCY_CRITICAL',
  'HEURISTIC_EVAL',
]);
export type RouterRuleId = z.infer<typeof RouterRuleIdSchema>;

export const BlockedAlternativeSchema = z.object({
  tier: ComputeTierSchema,
  why: z.string(),
});
export type BlockedAlternative = z.infer<typeof BlockedAlternativeSchema>;

// New consumers should key off `ruleId` (a stable enum) rather than parsing
// the `reason` string's prefix — the prefix is preserved for back-compat only.
export const RouterDiagnosticsSchema = z.object({
  score: z.number(),
  reason: z.string(),
  tier: ComputeTierSchema,
  ruleId: RouterRuleIdSchema.optional(),
  humanReason: z.string().optional(),
  blockedAlternatives: z.array(BlockedAlternativeSchema).optional(),
  overridable: z.boolean().optional(),
  safetyLock: z.string().optional(),
  profile: z.string().optional(),
  profileVersion: z.number().int().positive().optional(),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type RouterDiagnostics = z.infer<typeof RouterDiagnosticsSchema>;
