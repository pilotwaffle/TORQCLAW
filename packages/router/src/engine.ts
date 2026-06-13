import {
  ComputeTier,
  type GatewayRequest,
  type RouterDiagnostics,
} from '@torqclaw/contracts';

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
      };
    }

    // RULE 1a: User chose "this machine only" — a hard rule, same force as
    // the privacy override. The user's explicit choice is never overridden.
    if (req.constraints.executionMode === 'LOCAL_ONLY') {
      return {
        score: 0,
        reason: 'USER_LOCAL_ONLY: user restricted this task to the local edge.',
        tier: ComputeTier.LOCAL_EDGE,
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
      };
    }

    // RULE 1.5: Low classifier confidence -> tool prediction and complexity
    // score are both suspect. Buy capability headroom.
    if (req.enrichment.classifierConfidence < 0.5) {
      return {
        score: 75,
        reason: 'LOW_CLASSIFIER_CONFIDENCE: enrichment uncertain; buying capability headroom.',
        tier: ComputeTier.FRONTIER,
      };
    }

    // RULE 2: Tool overload cap.
    if (req.payload.requiredTools.length > 3) {
      return {
        score: 100,
        reason: 'TOOL_COUNT_OVERFLOW: >3 tools requested; elevating to frontier.',
        tier: ComputeTier.FRONTIER,
      };
    }

    // RULE 3: Cold-start mitigation.
    if (req.constraints.latencySensitivity === 'HIGH' && !this.isLocalModelWarm) {
      return {
        score: 90,
        reason: 'LATENCY_CRITICAL: local model cold (5-10s spin-up); routing to warm cloud API.',
        tier: ComputeTier.FRONTIER,
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
    return { score, reason: `HEURISTIC_EVAL: calculated score ${score}/100.${note}`, tier };
  }
}

export const router = new TorqClawRouter();
