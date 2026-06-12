import { z } from 'zod';

/** Dumb client, smart server: the ONLY judgment calls the client makes
 *  are things only the user can know. */
export const ClientCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('SUBMIT_PROMPT'),
    prompt: z.string().min(1).max(32_000),
    sensitive: z.boolean().default(false),
    urgent: z.boolean().default(false),
    attachmentIds: z.array(z.string()).default([]),
  }),
  z.object({
    action: z.literal('APPROVE_SKILL'),
    queueId: z.string(),
    decision: z.enum(['APPROVE', 'REJECT']),
  }),
  z.object({
    action: z.literal('CANCEL_TASK'),
    taskId: z.uuid(),
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

/** First frame on every connection — no anonymous sockets.
 *  sessionId present = resume; absent = create. Sessions outlive sockets. */
export const ConnectFrameSchema = z.object({
  role: z.enum(['operator', 'channel', 'node']),
  token: z.string(),
  sessionId: z.uuid().optional(),
  clientInfo: z.object({ name: z.string(), version: z.string() }),
});
export type ConnectFrame = z.infer<typeof ConnectFrameSchema>;
