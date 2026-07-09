import {
  ComputeTier,
  type GatewayRequest,
  type RouterDiagnostics,
  type RouterRuleId,
  type BlockedAlternative,
} from '@torqclaw/contracts';

/** Per-rule explanation metadata (TCLAW-2A). Keeps the overridable/safetyLock
 *  invariant in one place: pure explanation of a decision already made by the
 *  rules below — touching this table never changes score/reason/tier. */
const RULE_META: Record<RouterRuleId, { overridable: boolean; safetyLock?: string }> = {
  PRIVACY_OVERRIDE: { overridable: false, safetyLock: 'SENSITIVE_DATA' },
  USER_LOCAL_ONLY: { overridable: false, safetyLock: 'USER_LOCAL_ONLY' },
  LOCAL_INTENT: { overridable: false },
  LOCAL_TOOL_INTENT: { overridable: false, safetyLock: 'LOCAL_TOOL_INTENT' },
  LOW_CLASSIFIER_CONFIDENCE: { overridable: true },
  TOOL_COUNT_OVERFLOW: { overridable: true },
  LATENCY_CRITICAL: { overridable: true },
  HEURISTIC_EVAL: { overridable: true },
};

/**
 * Failure hierarchy (order is load-bearing):
 *   1. Privacy beats everything           -> LOCAL_EDGE, no exceptions
 *   1.5 Classifier uncertainty buys power -> FRONTIER (enrichment is suspect)
 *   2. Tool overload                      -> FRONTIER (small models lose
 *      coherence above ~3 tools)
 *   3. Cold-start + latency-critical      -> FRONTIER (5-10s local spin-up)
 *   4. Heuristic score for the confident middle.
 */
/** Phrases that mean "do this on/about the local agent or this machine." Such
 *  tasks must stay on the local tier — routing them to the cloud is wrong intent
 *  AND lets cloud tools touch the machine ungated. Word-boundary anchored to
 *  avoid tripping on substrings (e.g. "localize"). */
const LOCAL_INTENT =
  /\b(local agent|local model|on[- ]device|this machine|on this machine|local edge|locally|(train|fine[- ]?tune|improve|teach).{0,30}\b(local|agent|model|on[- ]device))\b/i;

/** "local <thing>" where <thing> is a local-only integration (TradingView, a
 *  desktop app, a local tool/server). These tools live ONLY on the LOCAL_EDGE
 *  bridge — the FRONTIER engine can't see them — so a prompt asking to use the
 *  "local TV" or "local tradingview" MUST route local or it silently falls back
 *  to web scraping (the live failure: "use local TV and get btc price" went to
 *  cloud and scraped Yahoo). Matches "local" within a few words of the keyword
 *  so "use my local TV", "local tradingview", "the local TV chart" all fire. */
const LOCAL_TOOL_INTENT =
  /\blocal\b.{0,20}\b(tv|trading\s*view|chart|desktop app|mcp|tool|server)\b/i;

export class TorqClawRouter {
  private isLocalModelWarm: boolean;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initialWarmState = false) {
    this.isLocalModelWarm = initialWarmState;
  }

  /** Called by the inference adapter after every successful local completion.
   *  Mirrors Ollama's keep_alive: flips cold again when the lease lapses. */
  public markLocalModelWarm(keepAliveMs = 10 * 60 * 1000): void {
    this.isLocalModelWarm = true;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => { this.isLocalModelWarm = false; }, keepAliveMs);
    this.warmTimer.unref?.();
  }

  public evaluateRequest(req: GatewayRequest): RouterDiagnostics {
    // RULE 1: Hard privacy override. Regulated data never leaves the box.
    if (req.constraints.containsSensitiveData) {
      return {
        score: 0,
        reason: 'PRIVACY_OVERRIDE: regulated data detected; forcing local edge.',
        tier: ComputeTier.LOCAL_EDGE,
        ruleId: 'PRIVACY_OVERRIDE',
        humanReason: 'This request contains sensitive data, so it must be handled on your local machine and never sent to the cloud.',
        blockedAlternatives: [{ tier: ComputeTier.FRONTIER, why: 'Sensitive data must never leave this machine.' }],
        ...RULE_META.PRIVACY_OVERRIDE,
      };
    }

    // RULE 1a: User chose "this machine only" — a hard rule, same force as
    // the privacy override. The user's explicit choice is never overridden.
    if (req.constraints.executionMode === 'LOCAL_ONLY') {
      return {
        score: 0,
        reason: 'USER_LOCAL_ONLY: user restricted this task to the local edge.',
        tier: ComputeTier.LOCAL_EDGE,
        ruleId: 'USER_LOCAL_ONLY',
        humanReason: 'You explicitly restricted this task to run locally only, so the router honors that choice.',
        blockedAlternatives: [{ tier: ComputeTier.FRONTIER, why: 'The user explicitly restricted this task to the local edge.' }],
        ...RULE_META.USER_LOCAL_ONLY,
      };
    }

    // RULE 1b: Local-intent override. A task ABOUT the local agent / on-device
    // work / training-or-improving the local model belongs ON the local tier —
    // sending it to the cloud is both wrong and a safety leak (it would run
    // cloud tools against the machine). Beats the low-confidence bounce below,
    // which otherwise sends these ambiguous prompts to FRONTIER.
    if (LOCAL_INTENT.test(req.payload.prompt)) {
      return {
        score: 0,
        reason: 'LOCAL_INTENT: task targets the local agent/machine; keeping it local.',
        tier: ComputeTier.LOCAL_EDGE,
        ruleId: 'LOCAL_INTENT',
        humanReason: 'You asked for this to run on your machine, so it stays local.',
        blockedAlternatives: [{ tier: ComputeTier.FRONTIER, why: 'The prompt targets the local agent/machine; the cloud is the wrong tier for this intent.' }],
        ...RULE_META.LOCAL_INTENT,
      };
    }

    // RULE 1b': Local-TOOL intent. "use local TV / local tradingview / local
    // tool" names an integration that lives only on the LOCAL_EDGE bridge; the
    // FRONTIER engine can't reach it, so it must route local (else it silently
    // web-scrapes a substitute). Same force as LOCAL_INTENT, beats the bounce.
    if (LOCAL_TOOL_INTENT.test(req.payload.prompt)) {
      return {
        score: 0,
        reason: 'LOCAL_TOOL_INTENT: prompt names a local-only tool/integration; keeping it local.',
        tier: ComputeTier.LOCAL_EDGE,
        ruleId: 'LOCAL_TOOL_INTENT',
        humanReason: 'This uses a tool that only exists on your local machine, so the cloud can\'t run it.',
        blockedAlternatives: [{ tier: ComputeTier.FRONTIER, why: 'The named tool/integration lives only on the local edge bridge; the frontier engine cannot reach it.' }],
        ...RULE_META.LOCAL_TOOL_INTENT,
      };
    }

    // RULE 1.5: Low classifier confidence -> tool prediction and complexity
    // score are both suspect. Buy capability headroom.
    if (req.enrichment.classifierConfidence < 0.5) {
      return {
        score: 75,
        reason: 'LOW_CLASSIFIER_CONFIDENCE: enrichment uncertain; buying capability headroom.',
        tier: ComputeTier.FRONTIER,
        ruleId: 'LOW_CLASSIFIER_CONFIDENCE',
        humanReason: 'The classifier was not confident about this request, so the router bought extra capability headroom by using the cloud.',
        blockedAlternatives: [{ tier: ComputeTier.LOCAL_EDGE, why: 'With low classifier confidence, the tool prediction and complexity score are both suspect — local capability may not be enough.' }],
        ...RULE_META.LOW_CLASSIFIER_CONFIDENCE,
      };
    }

    // RULE 2: Tool overload cap.
    if (req.payload.requiredTools.length > 3) {
      return {
        score: 100,
        reason: 'TOOL_COUNT_OVERFLOW: >3 tools requested; elevating to frontier.',
        tier: ComputeTier.FRONTIER,
        ruleId: 'TOOL_COUNT_OVERFLOW',
        humanReason: 'This request needs more than 3 tools, and small local models lose coherence past that point, so it was elevated to the cloud.',
        blockedAlternatives: [{ tier: ComputeTier.LOCAL_EDGE, why: 'Small local models lose coherence past ~3 tools.' }],
        ...RULE_META.TOOL_COUNT_OVERFLOW,
      };
    }

    // RULE 3: Cold-start mitigation.
    if (req.constraints.latencySensitivity === 'HIGH' && !this.isLocalModelWarm) {
      return {
        score: 90,
        reason: 'LATENCY_CRITICAL: local model cold (5-10s spin-up); routing to warm cloud API.',
        tier: ComputeTier.FRONTIER,
        ruleId: 'LATENCY_CRITICAL',
        humanReason: 'This request is latency-sensitive and the local model is cold (5-10s spin-up), so the router used the already-warm cloud API instead.',
        blockedAlternatives: [{ tier: ComputeTier.LOCAL_EDGE, why: 'The local model is cold and needs a 5-10s spin-up, which is too slow for a latency-critical request.' }],
        ...RULE_META.LATENCY_CRITICAL,
      };
    }

    // RULE 4: Heuristic scoring for the confident middle.
    let score = 0;
    if (
      req.payload.taskType === 'AUTONOMOUS_RESEARCH' ||
      req.payload.taskType === 'COMPLEX_CODING'
    ) {
      score += 50;
    }
    if (req.payload.contextSize > 8192) score += 40; // matches ops/Modelfile num_ctx
    score += req.payload.requiredTools.length * 10;

    // PREFER_CLOUD: on hardware where local inference is impractically slow
    // (e.g. a firmware-throttled dGPU at ~2 tok/s), the cloud is the right
    // default workhorse. Privacy / LOCAL_ONLY / LOCAL_INTENT already routed
    // local ABOVE this rule, so the privacy guarantee is untouched — this only
    // shifts the AMBIGUOUS confident-middle toward cloud. Threshold drops from
    // 50 to 1, so only a genuinely trivial task (score 0) still runs local.
    const preferCloud = process.env.TORQCLAW_PREFER_CLOUD === '1';
    const threshold = preferCloud ? 1 : 50;
    const tier = score >= threshold ? ComputeTier.FRONTIER : ComputeTier.LOCAL_EDGE;
    const note = preferCloud ? ' (prefer-cloud: slow local hardware)' : '';
    const preferCloudNote = preferCloud
      ? ' The prefer-cloud bias is active because local hardware is too slow, which lowers the bar for routing to the cloud.'
      : '';
    const humanReason = `The task scored ${score}/100 against a threshold of ${threshold}, so it was routed to ${
      tier === ComputeTier.FRONTIER ? 'the cloud' : 'the local edge'
    }.${preferCloudNote}`;
    const blockedAlternatives: BlockedAlternative[] = tier === ComputeTier.FRONTIER
      ? [{ tier: ComputeTier.LOCAL_EDGE, why: `The heuristic score (${score}/100) met or exceeded the ${threshold} threshold for cloud routing.` }]
      : [{ tier: ComputeTier.FRONTIER, why: `The heuristic score (${score}/100) stayed below the ${threshold} threshold for cloud routing.` }];
    return {
      score,
      reason: `HEURISTIC_EVAL: calculated score ${score}/100.${note}`,
      tier,
      ruleId: 'HEURISTIC_EVAL',
      humanReason,
      blockedAlternatives,
      ...RULE_META.HEURISTIC_EVAL,
    };
  }
}

export const router = new TorqClawRouter();
