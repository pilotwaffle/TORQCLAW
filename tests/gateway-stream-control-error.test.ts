import { it, expect } from 'vitest';
import { GatewayEventSchema } from '@torqclaw/contracts';
import * as gateway from '../apps/console/src/components/useGatewayStream.js';
const sid = 'f3f09de4-3e61-4ef2-bdad-37dc61e65d58';
const id = '6388425e-c76d-44aa-bca5-0879d657c51d';
const iso = '2026-10-24T00:00:00.000Z';
it('control_error_event_shape', () => {
  const detail = { action: 'SUBMIT_PROMPT', reason: 'x' };
  const event = gateway.buildControlErrorEvent({ type: 'ERROR', code: 'UNAUTHORIZED', detail }, sid, iso, id);
  expect(GatewayEventSchema.parse(event)).toEqual(event);
  expect(event).toEqual({ id, sessionId: sid, timestamp: iso, requestId: null, tier: null, type: 'ERROR',
    message: 'Gateway rejected the command (UNAUTHORIZED): ' + JSON.stringify(detail),
    metadata: { gatewayControlError: true, code: 'UNAUTHORIZED', detail } });
  expect(event).not.toHaveProperty('seq');
  const build = (detail?: unknown) => gateway.buildControlErrorEvent({ type: 'ERROR', code: 'X', detail }, sid, iso, id);
  expect(build('reason').message).toBe('Gateway rejected the command (X): reason');
  expect(build().message).toBe('Gateway rejected the command (X)');
  expect(build().metadata).not.toHaveProperty('detail');
  expect(build({ text: 'x'.repeat(400) }).message).toBe('Gateway rejected the command (X): ' + JSON.stringify({ text: 'x'.repeat(400) }).slice(0, 300));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(build(cyclic).message).toContain('[unserializable detail]');
  expect(build({ toJSON: () => undefined }).message).toContain('[unserializable detail]');
  expect(() => gateway.buildControlErrorEvent({ type: 'ERROR', code: 'X' }, 'invalid', iso, id)).toThrow();
  expect(() => gateway.buildControlErrorEvent({ type: 'ERROR', code: 'X' }, sid, iso, 'invalid')).toThrow();
});
it('classify_gateway_frame_unchanged', () => {
  expect(gateway.classifyGatewayFrame({ type: 'ERROR', code: 'X' })).toEqual({
    kind: 'control-error', disconnect: false, error: { type: 'ERROR', code: 'X' },
  });
  const event = { id, sessionId: sid, timestamp: iso, requestId: null, tier: null, type: 'RESULT', message: 'done', seq: 7 };
  expect(gateway.classifyGatewayFrame(event)).toEqual({ kind: 'event', event });
});
