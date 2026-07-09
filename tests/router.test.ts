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

  it('RULE 1b: local-intent phrasing forces LOCAL_EDGE despite low confidence', () => {
    const r = new TorqClawRouter();
    for (const prompt of [
      'can you use this data to learn from and improve the local agent',
      'train the local model on these files',
      'run this on this machine',
      'fine-tune the on-device model',
    ]) {
      const d = r.evaluateRequest(makeRequest({ prompt, classifierConfidence: 0.3 }));
      expect(d.tier, prompt).toBe(ComputeTier.LOCAL_EDGE);
      expect(d.reason, prompt).toMatch(/^LOCAL_INTENT/);
    }
  });

  it('RULE 1b does NOT trip on unrelated prompts (still routes normally)', () => {
    const r = new TorqClawRouter();
    // "localize" must not match; a normal research prompt routes to FRONTIER.
    const d = r.evaluateRequest(makeRequest({
      prompt: 'localize this app into French', taskType: 'AUTONOMOUS_RESEARCH',
    }));
    expect(d.reason).not.toMatch(/^LOCAL_INTENT/);
  });

  it("RULE 1b': local-tool intent forces LOCAL_EDGE (TradingView lives only on the bridge)", () => {
    const r = new TorqClawRouter();
    for (const prompt of [
      'use local TV and get btc price',
      'use my local tradingview to get the ETH price',
      'pull the price from the local TV chart',
      'get a quote using the local tradingview tool',
    ]) {
      const d = r.evaluateRequest(makeRequest({ prompt, classifierConfidence: 0.3 }));
      expect(d.tier, prompt).toBe(ComputeTier.LOCAL_EDGE);
      expect(d.reason, prompt).toMatch(/^LOCAL_TOOL_INTENT/);
    }
  });

  it("RULE 1b' does NOT trip on unrelated 'local' phrasing", () => {
    const r = new TorqClawRouter();
    // "local news", "local time" etc. must NOT force local — no tool keyword.
    for (const prompt of [
      'what is the local news today',
      'find a local restaurant near me',
    ]) {
      const d = r.evaluateRequest(makeRequest({ prompt, classifierConfidence: 0.9, taskType: 'AUTONOMOUS_RESEARCH' }));
      expect(d.reason, prompt).not.toMatch(/^LOCAL_TOOL_INTENT/);
    }
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

describe('PREFER_CLOUD (slow local hardware)', () => {
  const orig = process.env.TORQCLAW_PREFER_CLOUD;
  afterEach(() => {
    if (orig === undefined) delete process.env.TORQCLAW_PREFER_CLOUD;
    else process.env.TORQCLAW_PREFER_CLOUD = orig;
  });

  it('routes a confident simple task to FRONTIER when set', () => {
    process.env.TORQCLAW_PREFER_CLOUD = '1';
    const r = new TorqClawRouter();
    // ROUTINE_AUTOMATION, no tools, small context => score 0 normally local.
    const d = r.evaluateRequest(makeRequest({ taskType: 'DATA_EXTRACTION', requiredTools: ['a'] }));
    expect(d.tier).toBe(ComputeTier.FRONTIER); // score 10 >= threshold 1
    expect(d.reason).toMatch(/prefer-cloud/);
  });

  it('still keeps a trivial (score 0) task local even when set', () => {
    process.env.TORQCLAW_PREFER_CLOUD = '1';
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({ taskType: 'SUMMARIZATION', requiredTools: [], contextSize: 100 }));
    expect(d.tier).toBe(ComputeTier.LOCAL_EDGE); // score 0 < threshold 1
  });

  it('privacy still forces local even with prefer-cloud', () => {
    process.env.TORQCLAW_PREFER_CLOUD = '1';
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({ containsSensitiveData: true, taskType: 'AUTONOMOUS_RESEARCH' }));
    expect(d.tier).toBe(ComputeTier.LOCAL_EDGE);
    expect(d.reason).toMatch(/^PRIVACY_OVERRIDE/);
  });

  it('default (unset) keeps the 50 threshold', () => {
    delete process.env.TORQCLAW_PREFER_CLOUD;
    const r = new TorqClawRouter();
    const d = r.evaluateRequest(makeRequest({ taskType: 'DATA_EXTRACTION', requiredTools: ['a'] }));
    expect(d.tier).toBe(ComputeTier.LOCAL_EDGE); // score 10 < 50
  });
});

describe('route explanation fields (TCLAW-2A)', () => {
  type Fixture = {
    name: string;
    ruleId: string;
    overridable: boolean;
    safetyLock: string | undefined;
    reasonPrefix: RegExp;
    build: () => ReturnType<TorqClawRouter['evaluateRequest']>;
  };

  const fixtures: Fixture[] = [
    {
      name: 'RULE 1 privacy',
      ruleId: 'PRIVACY_OVERRIDE',
      overridable: false,
      safetyLock: 'SENSITIVE_DATA',
      reasonPrefix: /^PRIVACY_OVERRIDE/,
      build: () => new TorqClawRouter().evaluateRequest(makeRequest({ containsSensitiveData: true })),
    },
    {
      name: 'RULE 1a local-only',
      ruleId: 'USER_LOCAL_ONLY',
      overridable: false,
      safetyLock: 'USER_LOCAL_ONLY',
      reasonPrefix: /^USER_LOCAL_ONLY/,
      build: () => new TorqClawRouter().evaluateRequest(makeRequest({ executionMode: 'LOCAL_ONLY' })),
    },
    {
      name: 'RULE 1b local-intent',
      ruleId: 'LOCAL_INTENT',
      overridable: false,
      safetyLock: undefined,
      reasonPrefix: /^LOCAL_INTENT/,
      // Verified against the LOCAL_INTENT regex (engine.ts:20-21): the
      // "improve.{0,30}\b(local|agent|model|...)" branch matches this prompt.
      build: () => new TorqClawRouter().evaluateRequest(makeRequest({ prompt: 'please improve the local model accuracy' })),
    },
    {
      name: "RULE 1b' local-tool",
      ruleId: 'LOCAL_TOOL_INTENT',
      overridable: false,
      safetyLock: 'LOCAL_TOOL_INTENT',
      reasonPrefix: /^LOCAL_TOOL_INTENT/,
      // Verified against the LOCAL_TOOL_INTENT regex (engine.ts:30-31): "local"
      // within 20 chars of "chart" fires.
      build: () => new TorqClawRouter().evaluateRequest(makeRequest({ prompt: 'use the local chart tool to check price' })),
    },
    {
      name: 'RULE 1.5 low-confidence',
      ruleId: 'LOW_CLASSIFIER_CONFIDENCE',
      overridable: true,
      safetyLock: undefined,
      reasonPrefix: /^LOW_CLASSIFIER_CONFIDENCE/,
      build: () => new TorqClawRouter().evaluateRequest(makeRequest({ classifierConfidence: 0.4 })),
    },
    {
      name: 'RULE 2 tool-overflow',
      ruleId: 'TOOL_COUNT_OVERFLOW',
      overridable: true,
      safetyLock: undefined,
      reasonPrefix: /^TOOL_COUNT_OVERFLOW/,
      build: () => new TorqClawRouter().evaluateRequest(makeRequest({ requiredTools: ['a', 'b', 'c', 'd'] })),
    },
    {
      name: 'RULE 3 latency',
      ruleId: 'LATENCY_CRITICAL',
      overridable: true,
      safetyLock: undefined,
      reasonPrefix: /^LATENCY_CRITICAL/,
      build: () => new TorqClawRouter(false).evaluateRequest(makeRequest({ latencySensitivity: 'HIGH' })),
    },
    {
      name: 'RULE 4 heuristic',
      ruleId: 'HEURISTIC_EVAL',
      overridable: true,
      safetyLock: undefined,
      reasonPrefix: /^HEURISTIC_EVAL/,
      build: () => new TorqClawRouter().evaluateRequest(makeRequest({ taskType: 'ROUTINE_AUTOMATION' })),
    },
  ];

  it.each(fixtures)('$name: produces the correct ruleId', ({ build, ruleId }) => {
    expect(build().ruleId).toBe(ruleId);
  });

  it.each(fixtures)('$name: humanReason is a non-empty string', ({ build }) => {
    const d = build();
    expect(typeof d.humanReason).toBe('string');
    expect(d.humanReason!.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('$name: overridable matches spec', ({ build, overridable }) => {
    expect(build().overridable).toBe(overridable);
  });

  it.each(fixtures)('$name: safetyLock matches spec', ({ build, safetyLock }) => {
    expect(build().safetyLock).toBe(safetyLock);
  });

  it.each(fixtures)('$name: blockedAlternatives has exactly one entry naming the opposite tier', ({ build }) => {
    const d = build();
    expect(d.blockedAlternatives).toHaveLength(1);
    expect(d.blockedAlternatives![0].tier).not.toBe(d.tier);
    expect(typeof d.blockedAlternatives![0].why).toBe('string');
    expect(d.blockedAlternatives![0].why.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('$name: profile stays undefined', ({ build }) => {
    expect(build().profile).toBeUndefined();
  });

  it.each(fixtures)('$name: reason is still populated with the expected prefix (preserved)', ({ build, reasonPrefix }) => {
    const d = build();
    expect(d.reason.length).toBeGreaterThan(0);
    expect(d.reason).toMatch(reasonPrefix);
  });

  it('invariant: safetyLock set implies overridable === false, and every safetyLock rule is {score:0, tier: LOCAL_EDGE}', () => {
    for (const f of fixtures) {
      const d = f.build();
      if (d.safetyLock !== undefined) {
        expect(d.overridable, f.name).toBe(false);
        expect(d.score, f.name).toBe(0);
        expect(d.tier, f.name).toBe(ComputeTier.LOCAL_EDGE);
      }
    }
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
