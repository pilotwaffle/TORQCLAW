import { z } from 'zod';
import { ComputeTierSchema } from './routing.js';

export const GatewayEventTypeSchema = z.enum([
  'SYSTEM',
  'CONNECTED',
  'USER_PROMPT',
  'ROUTING',
  'TIER_SELECTED',
  'TOOL_CALL',
  'RESULT',
  'PENDING_APPROVAL',
  'ERROR',
]);
export type GatewayEventType = z.infer<typeof GatewayEventTypeSchema>;

/** Every frame the gateway pushes. seq is the replay cursor (monotonic,
 *  assigned by SQLite AUTOINCREMENT — never by wall clock). */
export const GatewayEventSchema = z.object({
  seq: z.number().int().nonnegative().optional(), // assigned on persist
  id: z.uuid(),
  requestId: z.string().nullable(),
  sessionId: z.uuid(),
  tier: ComputeTierSchema.nullable(),
  type: GatewayEventTypeSchema,
  message: z.string(),
  metadata: z.unknown().optional(),
  timestamp: z.iso.datetime(),
});
export type GatewayEvent = z.infer<typeof GatewayEventSchema>;
