import { describe, expect, it } from 'vitest';
import { cancellations } from '../packages/gateway/src/cancellations.js';

describe('subscription cancellation termination tracking', () => {
  it('does not resolve CANCEL_TASK until tracked termination is confirmed', async () => {
    const requestId = 'tracked-confirmed';
    const tracked = cancellations.beginTerminationTracking(requestId);
    let resolved = false;
    const waiting = cancellations.requestAndWait(requestId).then((result) => {
      resolved = true;
      return result;
    });
    await Promise.resolve();
    expect(tracked.signal.aborted).toBe(true);
    expect(resolved).toBe(false);
    tracked.complete(true);
    await expect(waiting).resolves.toEqual({ tracked: true, confirmed: true });
    cancellations.clear(requestId);
  });

  it('reports an explicitly unconfirmed process-tree termination', async () => {
    const requestId = 'tracked-unconfirmed';
    const tracked = cancellations.beginTerminationTracking(requestId);
    const waiting = cancellations.requestAndWait(requestId);
    tracked.complete(false);
    await expect(waiting).resolves.toEqual({ tracked: true, confirmed: false });
    cancellations.clear(requestId);
  });

  it('returns immediately when no subscription process was tracked', async () => {
    const requestId = 'not-tracked';
    await expect(cancellations.requestAndWait(requestId))
      .resolves.toEqual({ tracked: false, confirmed: true });
    cancellations.clear(requestId);
  });
});
