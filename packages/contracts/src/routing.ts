import { z } from 'zod';

export const TaskTypeSchema = z.enum([
  'DATA_EXTRACTION',
  'SUMMARIZATION',
  'ROUTINE_AUTOMATION',
  'AUTONOMOUS_RESEARCH',
  'COMPLEX_CODING',
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

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
});
export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;

export const RouterRuleIdSchema = z.enum([
  'PRIVACY_OVERRIDE',
  'USER_LOCAL_ONLY',
  'LOCAL_INTENT',
  'LOCAL_TOOL_INTENT',
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
});
export type RouterDiagnostics = z.infer<typeof RouterDiagnosticsSchema>;
