import { describe, it, expect, vi } from 'vitest';

// B-1 deferred hermes connection (failover boot-recovery gap).
//
// The bridge connects the hermes engine once at boot. When the engine is
// unreachable it retries in the background and exposes onHermesReady so the
// gateway can defer failover recovery until the engine is actually reachable —
// instead of skipping recovery permanently until the next gateway restart.
//
// Imported via the dist path (same singleton the gateway resolves), matching
// the pattern documented at the top of tests/spend-caps.test.ts.
const bridge = await import('../packages/bridge/dist/index.js');

describe('B-1: deferred hermes connection contract', () => {
  it('isHermesAvailable is false when no engine is connected', () => {
    expect(bridge.isHermesAvailable()).toBe(false);
  });

  it('onHermesReady DEFERS (queues, does not fire synchronously) while the engine is unavailable', () => {
    const cb = vi.fn();
    bridge.onHermesReady(cb);
    // With no connected engine the callback must be held back, not invoked —
    // recovery must not run against an unreachable outbox.
    expect(cb).not.toHaveBeenCalled();
  });

  it('onHermesReady accepts multiple waiters without throwing', () => {
    expect(() => {
      bridge.onHermesReady(() => {});
      bridge.onHermesReady(async () => {});
    }).not.toThrow();
  });
});