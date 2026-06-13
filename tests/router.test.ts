import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TorqClawRouter } from '../packages/router/src/engine.js';
import { ComputeTier } from '@torqclaw/contracts';
import { makeRequest } from './helpers.js';

describe('router rule hierarchy', () => {
  it('RULE 1: privacy override forces LOCAL_EDGE even when score would be high', () => {
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({
      containsSensitiveData: true,
      taskType: 'COMPLEX_CODING',
      requiredTools: ['a', 'b', 'c', 'd'], // would otherwise force FRONTIER
    }));
    expect(d.tier).toBe(ComputeTier.LOCAL_EDGE);
    expect(d.reason).toMatch(/^PRIVACY_OVERRIDE/);
  });

  it('RULE 1a: USER_LOCAL_ONLY forces LOCAL_EDGE over a frontier-bound task', () => {
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({
      executionMode: 'LOCAL_ONLY',
      taskType: 'AUTONOMOUS_RESEARCH',
      requiredTools: ['a', 'b', 'c', 'd'],
    }));
    expect(d.tier).toBe(ComputeTier.LOCAL_EDGE);
    expect(d.reason).toMatch(/^USER_LOCAL_ONLY/);
  });

  it('privacy beats user-local-only ordering (both land local, privacy first)', () => {
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({ containsSensitiveData: true, executionMode: 'LOCAL_ONLY' }));
    expect(d.reason).toMatch(/^PRIVACY_OVERRIDE/);
  });

  it('RULE 1.5: low classifier confidence buys FRONTIER', () => {
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({ classifierConfidence: 0.4 }));
    expect(d.tier).toBe(ComputeTier.FRONTIER);
    expect(d.reason).toMatch(/^LOW_CLASSIFIER_CONFIDENCE/);
  });

  it('RULE 2: >3 tools overflows to FRONTIER', () => {
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({ requiredTools: ['a', 'b', 'c', 'd'] }));
    expect(d.tier).toBe(ComputeTier.FRONTIER);
    expect(d.reason).toMatch(/^TOOL_COUNT_OVERFLOW/);
  });

  it('RULE 3: latency-critical + cold model -> FRONTIER', () => {
    const r = new TorqClawRouter(false); // cold
    const d = r.evaluateRequest(makeRequest({ latencySensitivity: 'HIGH' }));
    expect(d.tier).toBe(ComputeTier.FRONTIER);
    expect(d.reason).toMatch(/^LATENCY_CRITICAL/);
  });

  it('RULE 3: latency-critical but WARM model -> heuristic (no cold penalty)', () => {
    const r = new TorqClawRouter(true); // warm
    const d = r.evaluateRequest(makeRequest({ latencySensitivity: 'HIGH' }));
    expect(d.reason).toMatch(/^HEURISTIC_EVAL/);
  });

  it('RULE 4: simple task scores low -> LOCAL_EDGE', () => {
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({ taskType: 'ROUTINE_AUTOMATION' }));
    expect(d.tier).toBe(ComputeTier.LOCAL_EDGE);
    expect(d.score).toBeLessThan(50);
  });

  it('RULE 4: research task scores >=50 -> FRONTIER', () => {
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({ taskType: 'AUTONOMOUS_RESEARCH' }));
    expect(d.tier).toBe(ComputeTier.FRONTIER);
    expect(d.score).toBeGreaterThanOrEqual(50);
  });

  it('RULE 4: large context adds to the score', () => {
    const r = new TorqClawRouter();
    const small = r.evaluateRequest(makeRequest({ contextSize: 100 }));
    const large = r.evaluateRequest(makeRequest({ contextSize: 9000 }));
    expect(large.score).toBeGreaterThan(small.score);
  });
});

describe('warm-lease expiry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flips cold again after the keep-alive lease lapses', () => {
    const r = new TorqClawRouter(false);
    r.markLocalModelWarm(1000);
    // Warm now: latency-critical no longer forces FRONTIER via RULE 3.
    expect(r.evaluateRequest(makeRequest({ latencySensitivity: 'HIGH' })).reason)
      .toMatch(/^HEURISTIC_EVAL/);
    vi.advanceTimersByTime(1001);
    // Cold again: RULE 3 fires.
    expect(r.evaluateRequest(makeRequest({ latencySensitivity: 'HIGH' })).reason)
      .toMatch(/^LATENCY_CRITICAL/);
  });
});
