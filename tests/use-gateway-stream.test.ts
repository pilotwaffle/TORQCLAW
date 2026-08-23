import { describe, expect, it } from 'vitest';
import {
  buildSurfaceConnectFrame,
  classifyGatewayFrame,
} from '../apps/console/src/components/useGatewayStream.js';

describe('console gateway wire protocol', () => {
  it('uses surface authentication and never sends the legacy token field', () => {
    const frame = buildSurfaceConnectFrame(
      'tq1_example',
      'f3f09de4-3e61-4ef2-bdad-37dc61e65d58',
      7,
    );

    expect(frame).toMatchObject({
      expectedRole: 'operator',
      auth: { kind: 'surface', credential: 'tq1_example' },
      sessionId: 'f3f09de4-3e61-4ef2-bdad-37dc61e65d58',
      lastSeenSeq: 7,
    });
    expect(frame).not.toHaveProperty('token');
  });

  it('separates direct gateway ERROR controls from durable events', () => {
    expect(classifyGatewayFrame({
      type: 'ERROR',
      code: 'AUTH_FAILED',
      detail: { reason: 'bad credential' },
    })).toEqual({
      kind: 'control-error',
      disconnect: false,
      error: {
        type: 'ERROR',
        code: 'AUTH_FAILED',
        detail: { reason: 'bad credential' },
      },
    });
  });

  it('keeps malformed non-control frames out of the event stream', () => {
    expect(classifyGatewayFrame({ type: 'RESULT' }).kind).toBe('invalid');
  });
});
