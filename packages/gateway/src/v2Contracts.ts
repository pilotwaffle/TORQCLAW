import { z } from 'zod';

// Phase 1-only inert gateway-local V2 contracts; no production imports.

export const V2_HELLO_MAX_BYTES = 16_384;
export const V2_CONTROL_MAX_BYTES = 16_384;
export const V2_PROMPT_MAX_BYTES = 212_992;
export const V2_SKILL_DECISION_MAX_BYTES = 655_360;

export const V2_IDENTIFIER_MAX_BYTES = 256;
export const V2_CLIENT_INFO_MAX_BYTES = 128;
export const V2_PREVIEW_OF_MAX_BYTES = 512;
export const V2_ATTACHMENT_COUNT_MAX = 64;

function utf8Bounded(maxBytes: number, minLength = 0) {
  return z.string().min(minLength).superRefine((value, ctx) => {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      ctx.addIssue({ code: 'too_big', maximum: maxBytes, inclusive: true, origin: 'string' });
    }
  });
}

const identifier = utf8Bounded(V2_IDENTIFIER_MAX_BYTES, 1);
const clientInfoText = utf8Bounded(V2_CLIENT_INFO_MAX_BYTES, 1);
const taskId = z.uuid();

export const V2HelloSchema = z.object({
  protocolVersion: z.literal(2),
  expectedRole: z.enum(['operator', 'channel', 'node']),
  clientInfo: z.object({
    name: clientInfoText,
    version: clientInfoText,
  }).strict(),
}).strict();

const submitPrompt = z.object({
  action: z.literal('SUBMIT_PROMPT'),
  prompt: z.string().min(1).max(32_000),
  sensitive: z.boolean().default(false),
  urgent: z.boolean().default(false),
  attachmentIds: z.array(identifier).max(V2_ATTACHMENT_COUNT_MAX).default([]),
  maxCostUsd: z.number().min(0).max(100).optional(),
  executionMode: z.enum(['AUTO', 'LOCAL_ONLY', 'CLOUD_OK']).default('AUTO'),
  useMemory: z.boolean().default(true),
}).strict();

const approveSkill = z.object({
  action: z.literal('APPROVE_SKILL'),
  queueId: identifier,
  decision: z.enum(['APPROVE', 'REJECT']),
  editedMarkdown: z.string().max(100_000).optional(),
}).strict();

const getSkillDraft = z.object({
  action: z.literal('GET_SKILL_DRAFT'),
  queueId: identifier,
}).strict();

const approveTool = z.object({
  action: z.literal('APPROVE_TOOL'),
  approvalId: identifier,
  decision: z.enum(['APPROVE', 'REJECT']),
}).strict();

const cancelTask = z.object({
  action: z.literal('CANCEL_TASK'),
  taskId,
}).strict();

const memory = z.object({
  action: z.literal('MEMORY'),
  op: z.enum(['SHOW', 'FORGET_SESSION']),
}).strict();

const listReceipts = z.object({
  action: z.literal('LIST_RECEIPTS'),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

const getReceipt = z.object({
  action: z.literal('GET_RECEIPT'),
  taskId,
  includeEvents: z.boolean().default(false),
}).strict();

const getCostSummary = z.object({
  action: z.literal('GET_COST_SUMMARY'),
  recentLimit: z.number().int().min(1).max(100).default(20),
}).strict();

const previewRoute = z.object({
  action: z.literal('PREVIEW_ROUTE'),
  previewOf: utf8Bounded(V2_PREVIEW_OF_MAX_BYTES, 1),
  prompt: z.string().min(1).max(32_000),
  sensitive: z.boolean().default(false),
  urgent: z.boolean().default(false),
  maxCostUsd: z.number().min(0).max(100).optional(),
  executionMode: z.enum(['AUTO', 'LOCAL_ONLY', 'CLOUD_OK']).default('AUTO'),
  useMemory: z.boolean().default(true),
}).strict();

const listApprovals = z.object({
  action: z.literal('LIST_APPROVALS'),
  limit: z.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
}).strict();

const safeExport = z.object({
  action: z.literal('GET_SAFE_EXPORT'),
  taskId,
}).strict();

export const V2PromptOrPreviewSchema = z.discriminatedUnion('action', [submitPrompt, previewRoute]);
export const V2SkillDecisionSchema = approveSkill;
export const V2ControlCommandSchema = z.discriminatedUnion('action', [
  getSkillDraft,
  approveTool,
  cancelTask,
  memory,
  listReceipts,
  getReceipt,
  getCostSummary,
  listApprovals,
  safeExport,
]);

export const V2ClientCommandSchema = z.discriminatedUnion('action', [
  submitPrompt,
  approveSkill,
  getSkillDraft,
  approveTool,
  cancelTask,
  memory,
  listReceipts,
  getReceipt,
  getCostSummary,
  previewRoute,
  listApprovals,
  safeExport,
]);

export type V2Hello = z.infer<typeof V2HelloSchema>;
export type V2PromptOrPreview = z.infer<typeof V2PromptOrPreviewSchema>;
export type V2SkillDecision = z.infer<typeof V2SkillDecisionSchema>;
export type V2ControlCommand = z.infer<typeof V2ControlCommandSchema>;
export type V2ClientCommand = z.infer<typeof V2ClientCommandSchema>;
