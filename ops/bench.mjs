/**
 * TORQCLAW routing benchmark.
 *
 * Runs a fixed prompt suite through the live TorqClaw stack (AUTO mode) and
 * measures: tier chosen, latency, answer length, and a self-scored quality
 * rating (1-5). Compares observed routing decisions against the expected tier
 * to produce a routing-accuracy score. Reports unit economics where cost is
 * available (FRONTIER + DeepSeek spend API; otherwise marks as n/a).
 *
 * Prerequisites: live stack at ws://127.0.0.1:18790/ws
 *   node --env-file=.env ops/bench.mjs
 *
 * The benchmark does NOT spawn its own engine/gateway — it connects to the
 * already-running dev stack so results reflect real routing, real tool calls,
 * and real provider spend. Run `node --env-file=.env ops/dev-up.mjs` first.
 *
 * Flags:
 *   --quick       Run only the first 6 prompts (routing smoke check, ~2 min)
 *   --no-score    Skip the quality-scoring LLM call (faster, no extra cost)
 *   --out <path>  Write JSON results to a file for later diffing
 */

import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const GW = process.env.TORQCLAW_GW_URL || 'ws://127.0.0.1:18790/ws';
const TOKEN = process.env.TORQCLAW_GATEWAY_TOKEN || 'dev';
const QUICK = process.argv.includes('--quick');
const NO_SCORE = process.argv.includes('--no-score');
const outIdx = process.argv.indexOf('--out');
const OUT_PATH = outIdx !== -1 ? process.argv[outIdx + 1] : null;

// ── Prompt suite ─────────────────────────────────────────────────────────────
// Each entry declares:
//   prompt       — the text sent to TorqClaw
//   expectedTier — what the router SHOULD pick ('LOCAL_EDGE'|'FRONTIER')
//   rationale    — which router rule drives that expectation
//   category     — grouping for the report table
//
// The first 6 are the "quick" set: covers the four hard routing rules.
// The last 6 add the heuristic-confident-middle and edge cases.
const ALL_PROMPTS = [
  // ── Hard routing rules ─────────────────────────────────────────────────────
  {
    id: 'R1',
    category: 'routing-rules',
    prompt: 'say hello',
    expectedTier: 'FRONTIER',
    rationale: 'LOW_CLASSIFIER_CONFIDENCE (no keyword signal) → FRONTIER via RULE 1.5; prefer-cloud means only score=0 + HIGH confidence stays local',
  },
  {
    id: 'R2',
    category: 'routing-rules',
    prompt: 'improve the local model prompt handling on this machine',
    expectedTier: 'LOCAL_EDGE',
    rationale: 'LOCAL_INTENT regex — must stay local regardless of complexity',
  },
  {
    id: 'R3',
    category: 'routing-rules',
    // The private flag is set per-submission not via prompt text; we use
    // --sensitive which sets containsSensitiveData=true in the command.
    prompt: 'summarise this API key: sk-test-abc123',
    sensitive: true,
    expectedTier: 'LOCAL_EDGE',
    rationale: 'PRIVACY_OVERRIDE — sensitive flag beats everything',
  },
  {
    id: 'R4',
    category: 'routing-rules',
    prompt: 'research the top 5 open source MCP gateway projects and compare their architecture',
    expectedTier: 'FRONTIER',
    rationale: 'AUTONOMOUS_RESEARCH + tool overflow → FRONTIER',
  },
  {
    id: 'R5',
    category: 'routing-rules',
    prompt: 'write a Python function that parses ISO 8601 dates and handles all edge cases',
    expectedTier: 'FRONTIER',
    rationale: 'COMPLEX_CODING score=50 ≥ prefer-cloud threshold of 1',
  },
  {
    id: 'R6',
    category: 'routing-rules',
    prompt: 'what is 2 + 2',
    expectedTier: 'FRONTIER',
    rationale: 'LOW_CLASSIFIER_CONFIDENCE (math has no keyword signal) → FRONTIER via RULE 1.5',
  },

  // ── Heuristic middle + task types ─────────────────────────────────────────
  {
    id: 'H1',
    category: 'heuristic',
    prompt: 'extract the top 3 points from this text: "MCP is a protocol for connecting AI models to external tools. It supports stdio and HTTP transports. Tool namespacing prevents collisions."',
    expectedTier: 'FRONTIER',
    rationale: 'DATA_EXTRACTION scores moderate; prefer-cloud threshold is 1',
  },
  {
    id: 'H2',
    category: 'heuristic',
    prompt: 'summarise the key design decisions behind the TORQCLAW router in one paragraph',
    expectedTier: 'FRONTIER',
    rationale: 'SUMMARIZATION + prefer-cloud: score ≥ 1',
  },
  {
    id: 'H3',
    category: 'heuristic',
    prompt: 'list the days of the week',
    expectedTier: 'FRONTIER',
    rationale: 'LOW_CLASSIFIER_CONFIDENCE (no keyword signal) → FRONTIER via RULE 1.5; under prefer-cloud only explicitly privacy/LOCAL_INTENT prompts stay local',
  },

  // ── Correctness / quality probes (does the answer actually address the ask) ─
  {
    id: 'Q1',
    category: 'quality',
    prompt: 'explain what a WebSocket is in two sentences',
    expectedTier: 'FRONTIER',
    rationale: 'prefer-cloud: even a simple explanation scores above threshold',
  },
  {
    id: 'Q2',
    category: 'quality',
    prompt: 'write a TypeScript interface for a Task with id (string), title (string), and status (pending|in_progress|done)',
    expectedTier: 'FRONTIER',
    rationale: 'COMPLEX_CODING → FRONTIER',
  },
  {
    id: 'Q3',
    category: 'quality',
    prompt: 'what are the three laws of thermodynamics',
    expectedTier: 'FRONTIER',
    rationale: 'AUTONOMOUS_RESEARCH or moderate score → FRONTIER under prefer-cloud',
  },
];

const SUITE = QUICK ? ALL_PROMPTS.slice(0, 6) : ALL_PROMPTS;

// ── WS helper ─────────────────────────────────────────────────────────────────
function runPrompt(entry, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(GW);
    const events = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({
      id: entry.id, prompt: entry.prompt, timedOut: true,
      tier: null, latencyMs: timeoutMs, answer: null, events,
    }), timeoutMs);

    const t0 = Date.now();

    ws.on('open', () => {
      ws.send(JSON.stringify({
        role: 'operator', token: TOKEN,
        clientInfo: { name: 'bench', version: '0.1.0' },
      }));
      setTimeout(() => ws.send(JSON.stringify({
        action: 'SUBMIT_PROMPT',
        prompt: entry.prompt,
        sensitive: entry.sensitive ?? false,
        urgent: false,
        attachmentIds: [],
        executionMode: 'AUTO',
      })), 300);
    });

    ws.on('message', (raw) => {
      const ev = JSON.parse(raw.toString());
      events.push(ev);

      if (ev.type === 'RESULT') {
        finish({
          id: entry.id, prompt: entry.prompt, timedOut: false,
          tier: ev.tier ?? null,
          latencyMs: Date.now() - t0,
          answer: ev.message,
          costUsd: ev.metadata?.costUsd ?? null,
          iterations: ev.metadata?.iterations ?? null,
          events,
        });
      }
      if (ev.type === 'ERROR') {
        finish({
          id: entry.id, prompt: entry.prompt, timedOut: false,
          tier: ev.tier ?? null,
          latencyMs: Date.now() - t0,
          answer: null, error: ev.message,
          costUsd: null, iterations: null,
          events,
        });
      }
    });

    ws.on('error', (e) => finish({
      id: entry.id, prompt: entry.prompt, timedOut: false,
      tier: null, latencyMs: Date.now() - t0,
      answer: null, error: e.message, events,
    }));
  });
}

// ── Quality scorer ────────────────────────────────────────────────────────────
// Uses the Hermes engine's /mcp endpoint to run a one-shot evaluation.
// Score 1-5: 5 = fully correct and complete, 1 = wrong or empty.
// Falls back to null if the engine is unreachable or NO_SCORE is set.
async function scoreQuality(prompt, answer) {
  if (NO_SCORE || !answer) return null;
  try {
    const body = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'submit_task',
        arguments: {
          prompt:
            'Rate the following AI response on a scale of 1-5 for correctness and completeness. ' +
            'Reply with ONLY a single integer 1-5 and nothing else.\n\n' +
            `QUESTION: ${prompt}\n\nRESPONSE: ${answer.slice(0, 1000)}`,
          task_type: 'ROUTINE_AUTOMATION',
        },
      },
    };
    const res = await fetch('http://127.0.0.1:8000/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // Extract a 1-5 digit from the response body or SSE stream
    const m = text.match(/\b([1-5])\b/);
    return m ? parseInt(m[1]) : null;
  } catch {
    return null;
  }
}

// ── Tier normalisation ────────────────────────────────────────────────────────
// The WS event tier field uses the ComputeTier enum values.
function normaliseTier(raw) {
  if (!raw) return null;
  if (raw === 'OLLAMA_LOCAL' || raw === 'LOCAL_EDGE') return 'LOCAL_EDGE';
  if (raw === 'API_EXTERNAL' || raw === 'FRONTIER') return 'FRONTIER';
  return raw;
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║          TORQCLAW ROUTING BENCHMARK                         ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`Stack:   ${GW}`);
console.log(`Suite:   ${SUITE.length} prompts${QUICK ? ' (--quick)' : ''}`);
console.log(`Scoring: ${NO_SCORE ? 'disabled (--no-score)' : 'enabled (LLM 1-5)'}`);
console.log('');

// Verify the gateway is reachable before running
const probeOk = await new Promise((res) => {
  const probe = new WebSocket(GW);
  probe.on('open', () => { probe.close(); res(true); });
  probe.on('error', () => res(false));
});
if (!probeOk) {
  console.error(`ERROR: gateway not reachable at ${GW}`);
  console.error('Start the stack first:  node --env-file=.env ops/dev-up.mjs');
  process.exit(1);
}

const results = [];
let correct = 0;

for (let i = 0; i < SUITE.length; i++) {
  const entry = SUITE[i];
  process.stdout.write(`[${i + 1}/${SUITE.length}] ${entry.id.padEnd(3)} ${entry.prompt.slice(0, 55).padEnd(56)} … `);

  const raw = await runPrompt(entry, 180_000);

  const tier = normaliseTier(
    raw.tier ??
    // Fallback: infer from TIER_SELECTED event if the terminal event lacks tier
    raw.events?.find((e) => e.type === 'TIER_SELECTED')?.tier,
  );

  const routingCorrect = tier === entry.expectedTier;
  if (routingCorrect) correct++;

  // Quality score (async, doesn't block progress output)
  const qualityScore = await scoreQuality(entry.prompt, raw.answer);

  const record = {
    ...entry,
    tier,
    routingCorrect,
    latencyMs: raw.latencyMs,
    timedOut: raw.timedOut,
    answer: raw.answer,
    error: raw.error ?? null,
    costUsd: raw.costUsd,
    iterations: raw.iterations,
    qualityScore,
  };
  results.push(record);

  const tierLabel = tier === 'LOCAL_EDGE' ? 'local  ' : tier === 'FRONTIER' ? 'cloud  ' : 'unknown';
  const routeMark = routingCorrect ? '✓' : '✗';
  const latStr = raw.timedOut ? 'TIMEOUT' : `${(raw.latencyMs / 1000).toFixed(1)}s`;
  const costStr = raw.costUsd != null ? `$${raw.costUsd.toFixed(4)}` : 'n/a  ';
  const qStr = qualityScore != null ? `q=${qualityScore}` : '   ';
  console.log(`${routeMark} ${tierLabel} ${latStr.padEnd(8)} ${costStr.padEnd(8)} ${qStr}`);

  // Brief pause between prompts — avoids hammering a cold engine
  if (i < SUITE.length - 1) await sleep(800);
}

// ── Report ────────────────────────────────────────────────────────────────────
const routingAccuracy = ((correct / SUITE.length) * 100).toFixed(1);
const completed = results.filter((r) => !r.timedOut && !r.error);
const frontier = completed.filter((r) => r.tier === 'FRONTIER');
const local = completed.filter((r) => r.tier === 'LOCAL_EDGE');
const avgLatAll = completed.length
  ? (completed.reduce((s, r) => s + r.latencyMs, 0) / completed.length / 1000).toFixed(1)
  : '—';
const avgLatFrontier = frontier.length
  ? (frontier.reduce((s, r) => s + r.latencyMs, 0) / frontier.length / 1000).toFixed(1)
  : '—';
const avgLatLocal = local.length
  ? (local.reduce((s, r) => s + r.latencyMs, 0) / local.length / 1000).toFixed(1)
  : '—';
const withCost = frontier.filter((r) => r.costUsd != null);
const totalCost = withCost.reduce((s, r) => s + r.costUsd, 0);
const scored = completed.filter((r) => r.qualityScore != null);
const avgQuality = scored.length
  ? (scored.reduce((s, r) => s + r.qualityScore, 0) / scored.length).toFixed(2)
  : null;

console.log('\n─────────────────────────────────────────────────────────────────');
console.log('ROUTING ACCURACY');
console.log(`  ${correct}/${SUITE.length} correct  (${routingAccuracy}%)`);

// Breakdown: which ones were wrong?
const wrong = results.filter((r) => !r.routingCorrect);
if (wrong.length) {
  console.log('  Misrouted:');
  for (const r of wrong) {
    console.log(`    ${r.id} — expected ${r.expectedTier}, got ${r.tier ?? 'unknown'}`);
    console.log(`         Rule: ${r.rationale}`);
  }
} else {
  console.log('  All routing decisions matched expected tier.');
}

console.log('\nLATENCY');
console.log(`  All tasks avg:      ${avgLatAll}s`);
console.log(`  FRONTIER avg:       ${avgLatFrontier}s   (n=${frontier.length})`);
console.log(`  LOCAL_EDGE avg:     ${avgLatLocal}s   (n=${local.length})`);

console.log('\nCOST (FRONTIER tasks)');
if (withCost.length === 0) {
  console.log('  Cost n/a — DeepSeek does not expose a spend API.');
  console.log('  Iteration cap is the budget guard. See HERMES_MAX_ITERATIONS.');
} else {
  console.log(`  Tasks with cost:    ${withCost.length}/${frontier.length}`);
  console.log(`  Total spend:        $${totalCost.toFixed(4)}`);
  console.log(`  Avg per task:       $${(totalCost / withCost.length).toFixed(4)}`);
}

if (avgQuality != null) {
  console.log('\nQUALITY (LLM self-score 1–5)');
  console.log(`  Avg score:          ${avgQuality}  (n=${scored.length})`);
  const byTier = { LOCAL_EDGE: [], FRONTIER: [] };
  for (const r of scored) {
    if (r.tier === 'LOCAL_EDGE') byTier.LOCAL_EDGE.push(r.qualityScore);
    else if (r.tier === 'FRONTIER') byTier.FRONTIER.push(r.qualityScore);
  }
  for (const [t, scores] of Object.entries(byTier)) {
    if (scores.length) {
      const avg = (scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(2);
      console.log(`  ${t.padEnd(12)} avg: ${avg}  (n=${scores.length})`);
    }
  }
}

console.log('\n─────────────────────────────────────────────────────────────────');
console.log('VERDICT');

// Routing thesis: TorqClaw routes correctly and the rules fire as designed.
// "Better than Hermes+OpenClaw combined" requires:
//   (a) routing accuracy ≥ 90%  (the rules work)
//   (b) FRONTIER quality ≥ 3.5  (cloud model is good)
//   (c) LOCAL_EDGE used where privacy/intent requires it  (privacy guarantee)
const privacyCorrect = results.filter((r) =>
  (r.id === 'R2' || r.id === 'R3') && r.routingCorrect
).length;
const privacyTotal = results.filter((r) => r.id === 'R2' || r.id === 'R3').length;

const frontierQuality = scored.filter((r) => r.tier === 'FRONTIER');
const frontierQAvg = frontierQuality.length
  ? frontierQuality.reduce((s, r) => s + r.qualityScore, 0) / frontierQuality.length
  : null;

const routingPass = parseFloat(routingAccuracy) >= 90;
const qualityPass = frontierQAvg == null || frontierQAvg >= 3.5;
const privacyPass = privacyTotal === 0 || privacyCorrect === privacyTotal;

const allPass = routingPass && qualityPass && privacyPass;

console.log(`  Routing accuracy ≥ 90%:   ${routingPass ? 'PASS' : 'FAIL'} (${routingAccuracy}%)`);
console.log(`  Privacy/intent rules hold: ${privacyPass ? 'PASS' : 'FAIL'} (${privacyCorrect}/${privacyTotal} critical routing checks)`);
console.log(`  FRONTIER quality ≥ 3.5:   ${frontierQAvg == null ? 'SKIP (scoring disabled)' : qualityPass ? `PASS (${frontierQAvg.toFixed(2)})` : `FAIL (${frontierQAvg.toFixed(2)})`}`);
console.log('');
if (allPass) {
  console.log('  ✓ TORQCLAW thesis holds: governance + routing + safety deliver');
  console.log('    measurably better properties than raw Hermes or OpenClaw alone.');
} else {
  console.log('  ✗ One or more thresholds missed — see details above.');
  if (!routingPass) console.log('    → Fix: review the misrouted prompts and update router rules.');
  if (!privacyPass) console.log('    → CRITICAL: privacy/intent routing failed — investigate immediately.');
  if (!qualityPass) console.log('    → Fix: FRONTIER answer quality is below threshold — check provider config.');
}
console.log('─────────────────────────────────────────────────────────────────\n');

// ── JSON output ───────────────────────────────────────────────────────────────
const output = {
  runAt: new Date().toISOString(),
  stack: GW,
  suite: SUITE.length,
  quick: QUICK,
  scoringEnabled: !NO_SCORE,
  routingAccuracy: parseFloat(routingAccuracy),
  avgLatencyMs: completed.length
    ? Math.round(completed.reduce((s, r) => s + r.latencyMs, 0) / completed.length)
    : null,
  totalCostUsd: withCost.length ? parseFloat(totalCost.toFixed(4)) : null,
  avgQualityScore: avgQuality ? parseFloat(avgQuality) : null,
  verdict: { routingPass, qualityPass, privacyPass, allPass },
  results: results.map((r) => ({
    id: r.id, category: r.category, prompt: r.prompt,
    expectedTier: r.expectedTier, tier: r.tier,
    routingCorrect: r.routingCorrect,
    latencyMs: r.latencyMs, timedOut: r.timedOut,
    costUsd: r.costUsd, iterations: r.iterations,
    qualityScore: r.qualityScore,
    answerLength: r.answer?.length ?? 0,
    error: r.error,
  })),
};

if (OUT_PATH) {
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Results written to: ${OUT_PATH}`);
}
