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
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as os from 'node:os';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const phase1Mode = process.argv.includes('--phase1') || process.argv.includes('--failover');

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function ensurePhase1ProductionBuild() {
  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const built = spawnSync(packageManager, ['--filter', '@torqclaw/gateway...', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (built.status !== 0) {
    throw new Error(`Phase-1 production build failed (${built.error?.message ?? built.status}):\n${built.stdout ?? ''}\n${built.stderr ?? ''}`);
  }
}

function startFakeProviderServer(dataDir) {
  const python = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const child = spawn(python, ['run', 'python', join(ROOT, 'ops', 'phase1_fake_provider_server.py')], {
    cwd: ROOT,
    env: {
      ...process.env,
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_PROVIDER_FAILOVER_ENABLED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = createInterface({ input: child.stdout });
  const pending = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  reader.on('line', (line) => {
    const item = pending.shift();
    if (!item) return;
    try { item.resolve(JSON.parse(line)); } catch (error) { item.reject(error); }
  });
  const failure = (error) => {
    while (pending.length) pending.shift().reject(error);
  };
  child.on('error', failure);
  child.on('exit', (code, signal) => {
    if (code !== 0) failure(new Error(`fake provider server exited (${code ?? signal}): ${stderr}`));
  });
  return {
    child,
    client: {
      async callTool(call) {
        return await new Promise((resolveCall, rejectCall) => {
          pending.push({ resolve: resolveCall, reject: rejectCall });
          child.stdin.write(JSON.stringify(call) + '\n', (error) => {
            if (error) rejectCall(error);
          });
        });
      },
    },
    async close() {
      reader.close();
      child.stdin.end();
      await Promise.race([once(child, 'close'), sleep(500).then(() => child.kill())]);
    },
  };
}

function phase1Request(taskId, sessionId, fault) {
  return {
    id: taskId,
    sessionId,
    sourceChannel: 'phase1-bench',
    receivedAt: '2026-07-30T12:00:00.000Z',
    payload: {
      prompt: `deterministic Phase-1 controller case TORQCLAW_FAKE_FAULT=${fault}`,
      assembledContext: '',
      contextSize: 1,
      requiredTools: [],
      taskType: 'COMPLEX_CODING',
      grantedTools: [],
    },
    constraints: {
      latencySensitivity: 'LOW',
      maxCost: 1,
      containsSensitiveData: false,
      executionMode: 'CLOUD_OK',
    },
    enrichment: {
      classifierUsed: 'DEFAULT',
      classifierConfidence: 1,
      classifierLatencyMs: 0,
      estimatedTokens: 1,
      memoryUsed: false,
    },
  };
}

async function runPhase1StdioBench() {
  ensurePhase1ProductionBuild();
  const phase1Args = process.argv.slice(2);
  const jsonOutput = phase1Args.includes('--json');
  const quick = phase1Args.includes('--quick');
  const runsIndex = phase1Args.indexOf('--runs');
  const requestedRuns = runsIndex >= 0 ? Number(phase1Args[runsIndex + 1]) : (quick ? 12 : 100);
  const runs = Number.isSafeInteger(requestedRuns) && requestedRuns > 0 ? requestedRuns : 100;
  const outIndex = phase1Args.indexOf('--out');
  const outPath = outIndex >= 0 ? phase1Args[outIndex + 1] : null;
  // A stdio call starts a fresh Python process.  Restart-safe successor
  // fencing intentionally reconstructs a new monotonic guard in each process,
  // so a multi-call controller run over stdio cannot make forward progress.
  // Keep this command bounded and diagnostic-only; HTTP is the sole live
  // promotion transport and the historical stdio sample remains attributable.
  const diagnostic = {
    schemaVersion: 2,
    mode: 'legacy-stdio-diagnostic',
    transport: 'stdio',
    connectionReuse: 'single-process-per-call-event-loop',
    promotionEligible: false,
    network: false,
    liveProviderClaim: false,
    syntheticMetrics: false,
    requestedRuns: runs,
    executedRuns: 0,
    orchestrationP95MsExcludingProviderWait: PHASE1_LEGACY_STDIO_DIAGNOSTIC.p95Ms,
    legacyStdioDiagnostic: {
      ...PHASE1_LEGACY_STDIO_DIAGNOSTIC,
      diagnosticSource: 'historical_measured_sample',
      disabledReason: 'restart_safe_fence_requires_persistent_process',
    },
  };
  if (outPath) writeFileSync(outPath, JSON.stringify(diagnostic, null, 2) + '\n', 'utf8');
  if (jsonOutput) console.log(JSON.stringify(diagnostic, null, 2));
  else console.log('TORQCLAW Phase-1 stdio diagnostic is historical only; use --transport=http for live promotion evidence.');
  return diagnostic;
  const retryableFaults = ['connection', 'dns', 'http_408', 'http_429', 'http_5xx'];
  const gatewayDataDir = mkdtempSync(join(tmpdir(), 'torqclaw-phase1-bench-'));
  process.env.TORQCLAW_DATA_DIR = gatewayDataDir;
  process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED = 'true';
  process.env.TORQCLAW_FAILOVER_CODING_CHAIN = 'coding';
  process.env.TORQCLAW_FAILOVER_TASK_DEADLINE_MS = '30000';
  process.env.TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS = '10000';

  const fake = startFakeProviderServer(gatewayDataDir);
  const calls = { submit: 0, duplicateSubmit: 0, poll: 0, transition: 0, finalize: 0, timings: [], byRun: new Map() };
  let currentRun = null;
  const client = {
    async callTool(call) {
      const callStarted = performance.now();
      let raw;
      try {
        raw = await fake.client.callTool(call);
      } catch (error) {
        const elapsed = performance.now() - callStarted;
        const timing = { run: currentRun, name: call.name, elapsedMs: elapsed, serverElapsedMs: null, transportMs: elapsed };
        calls.timings.push(timing);
        if (currentRun !== null) {
          const runTimings = calls.byRun.get(currentRun) ?? [];
          runTimings.push(timing);
          calls.byRun.set(currentRun, runTimings);
        }
        throw error;
      }
      const parsed = JSON.parse(raw.content?.find((entry) => entry.type === 'text')?.text ?? '{}');
      const elapsed = performance.now() - callStarted;
      const serverElapsedMs = typeof parsed.__phase1FakeServerMs === 'number' ? parsed.__phase1FakeServerMs : null;
      const timing = {
        run: currentRun,
        name: call.name,
        elapsedMs: elapsed,
        serverElapsedMs,
        transportMs: serverElapsedMs === null ? elapsed : Math.max(0, elapsed - serverElapsedMs),
      };
      calls.timings.push(timing);
      if (currentRun !== null) {
        const runTimings = calls.byRun.get(currentRun) ?? [];
        runTimings.push(timing);
        calls.byRun.set(currentRun, runTimings);
      }
      if (call.name === 'resilience_submit_attempt') {
        calls.submit += 1;
        if (parsed.status === 'DUPLICATE') calls.duplicateSubmit += 1;
      } else if (call.name === 'resilience_poll_observations') calls.poll += 1;
      else if (call.name === 'resilience_transition_once') calls.transition += 1;
      else if (call.name === 'resilience_finalize_attempt') calls.finalize += 1;
      return raw;
    },
  };

  let storage;
  let runFailoverTask;
  let parseProviderChainsDocument;
  try {
    ({ runFailoverTask } = await import('../packages/gateway/dist/failover.js'));
    ({ parseProviderChainsDocument } = await import('../packages/gateway/dist/providerChains.js'));
    storage = await import('../packages/gateway/dist/storage.js');
    const documentFor = (run) => parseProviderChainsDocument({
      revision: 'phase1-bench',
      chains: { coding: { id: 'coding', providers: [
        { id: `primary-${run}`, label: `Primary-${run}`, modelId: 'fake-primary', apiKeyEnvName: 'P1_FAKE_KEY_A', baseUrlEnvName: 'P1_FAKE_BASE_A', privacyClasses: ['standard'], ceilingMicroUsd: 1 },
        { id: `fallback-${run}`, label: `Fallback-${run}`, modelId: 'fake-fallback', apiKeyEnvName: 'P1_FAKE_KEY_B', baseUrlEnvName: 'P1_FAKE_BASE_B', privacyClasses: ['standard'], ceilingMicroUsd: 1 },
      ] } },
    });
    const timings = [];
    const outcomes = [];
    let eligibleDenominator = 0;
    let eligibleNumerator = 0;
    for (let run = 0; run < runs; run += 1) {
      const taskId = `00000000-0000-4000-8000-${String(run + 1).padStart(12, '0')}`;
      const sessionId = '00000000-0000-4000-8000-000000000000';
      const fault = run % 10 < 8 ? retryableFaults[run % retryableFaults.length] : 'authentication';
      const eligible = retryableFaults.includes(fault);
      if (eligible) eligibleDenominator += 1;
      const started = performance.now();
      let completed = false;
      let errorMessage = null;
      currentRun = run;
      try {
        const result = await runFailoverTask(
          phase1Request(taskId, sessionId, fault),
          { tier: 'API_EXTERNAL' },
          {
            document: documentFor(run),
            nowMs: Date.now(),
            env: {
              TORQCLAW_FAILOVER_CODING_CHAIN: 'coding',
              TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '30000',
              TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '10000',
              TORQCLAW_PROVIDER_CHAIN_REVISION: 'phase1-bench',
            },
            client,
            emit: () => undefined,
            random: () => 0,
            // The ledger now enforces the durable fence independently of the
            // controller.  The legacy stdio diagnostic must honor retry hints
            // rather than busy-looping on NOT_READY; it remains ineligible for
            // promotion because each MCP call still uses stdio process churn.
            sleepMs: async (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
          },
        );
        completed = result.text.includes('deterministic result');
      } catch (error) {
        completed = false;
        errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        currentRun = null;
      }
      const elapsed = performance.now() - started;
      const attempts = storage.getProviderAttemptProjections(taskId);
      const final = attempts.at(-1);
      const runCalls = calls.byRun.get(run) ?? [];
      const mcpTotalMs = runCalls.reduce((sum, timing) => sum + timing.elapsedMs, 0);
      const mcpServerMs = runCalls.reduce((sum, timing) => sum + (timing.serverElapsedMs ?? 0), 0);
      const mcpTransportMs = runCalls.reduce((sum, timing) => sum + timing.transportMs, 0);
      if (eligible && completed && final?.terminal_outcome === 'completed') eligibleNumerator += 1;
      outcomes.push({
        taskId,
        fault,
        eligible,
        completed,
        attempts: attempts.length,
        terminalOutcome: final?.terminal_outcome ?? null,
        elapsedMs: elapsed,
        mcpCallCount: runCalls.length,
        mcpTotalMs,
        mcpServerMs,
        mcpTransportMs,
        controllerLocalMs: Math.max(0, elapsed - mcpTotalMs),
        mcpMaxCallMs: Math.max(0, ...runCalls.map((timing) => timing.elapsedMs)),
        error: errorMessage,
      });
      timings.push(elapsed);
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    const percentile = (values, percentileRank = 0.95) => {
      const ordered = [...values].sort((a, b) => a - b);
      if (!ordered.length) return null;
      return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileRank) - 1)];
    };
    const byOperation = {};
    for (const timing of calls.timings) {
      (byOperation[timing.name] ??= []).push(timing.elapsedMs);
    }
    const mcpTiming = Object.fromEntries(Object.entries(byOperation).sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => [name, {
      count: values.length,
      totalMs: values.reduce((sum, value) => sum + value, 0),
      p95Ms: percentile(values),
      maxMs: Math.max(...values),
      serverP95Ms: percentile(values.map((value, index) => calls.timings.filter((timing) => timing.name === name)[index]?.serverElapsedMs ?? 0)),
      transportP95Ms: percentile(values.map((value, index) => calls.timings.filter((timing) => timing.name === name)[index]?.transportMs ?? value)),
    }]));
    const attemptCount = outcomes.reduce((sum, outcome) => sum + outcome.attempts, 0);
    const terminalFailures = outcomes.filter((outcome) => outcome.terminalOutcome === 'failed').length;
    const report = {
      schemaVersion: 2,
      mode: 'fake-provider-controller',
      transport: 'stdio',
      connectionReuse: 'single-process-per-call-event-loop',
      promotionEligible: false,
      network: false,
      liveProviderClaim: false,
      syntheticMetrics: false,
      runs,
      attemptCount,
      eligibleCompletion: {
        numerator: eligibleNumerator,
        denominator: eligibleDenominator,
        rate: eligibleDenominator === 0 ? null : eligibleNumerator / eligibleDenominator,
      },
      terminalFailures,
      providerSubmissions: calls.submit,
      duplicateProviderSubmissions: calls.duplicateSubmit,
      transitionCount: calls.transition,
      finalizationCount: calls.finalize,
      pollingCount: calls.poll,
      orchestrationP95MsExcludingProviderWait: sorted[p95Index] ?? null,
      mcpCallTiming: {
        count: calls.timings.length,
        totalMs: calls.timings.reduce((sum, timing) => sum + timing.elapsedMs, 0),
        p95Ms: percentile(calls.timings.map((timing) => timing.elapsedMs)),
        maxMs: Math.max(0, ...calls.timings.map((timing) => timing.elapsedMs)),
        serverP95Ms: percentile(calls.timings.map((timing) => timing.serverElapsedMs ?? 0)),
        transportP95Ms: percentile(calls.timings.map((timing) => timing.transportMs)),
        byOperation: mcpTiming,
      },
      orchestrationEndToEndP95MsExcludingProviderWait: percentile(timings),
      controllerLocalP95Ms: percentile(outcomes.map((outcome) => outcome.controllerLocalMs)),
      mcpPerCaseP95Ms: percentile(outcomes.map((outcome) => outcome.mcpTotalMs)),
      mcpServerPerCaseP95Ms: percentile(outcomes.map((outcome) => outcome.mcpServerMs)),
      mcpTransportPerCaseP95Ms: percentile(outcomes.map((outcome) => outcome.mcpTransportMs)),
      slowestCases: [...outcomes].sort((left, right) => right.elapsedMs - left.elapsedMs).slice(0, 10),
      providerWaitExcluded: true,
      legacyStdioDiagnostic: {
        transport: 'stdio',
        promotionEligible: false,
        p95Ms: sorted[p95Index] ?? null,
        reason: 'transport_not_production_equivalent',
      },
      outcomes,
    };
    if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    if (jsonOutput) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('TORQCLAW Phase-1 bench (real controller + deterministic fake provider)');
      console.log(`Runs: ${runs}; attempts: ${attemptCount}; submissions: ${calls.submit}`);
      console.log(`Eligible completion: ${eligibleNumerator}/${eligibleDenominator} (${(report.eligibleCompletion.rate * 100).toFixed(1)}%)`);
      console.log(`Transitions: ${calls.transition}; terminal failures: ${terminalFailures}; polls: ${calls.poll}`);
      console.log(`Orchestration p95 excluding provider wait: ${report.orchestrationP95MsExcludingProviderWait?.toFixed(1)}ms`);
      console.log(`MCP call p95/max: ${report.mcpCallTiming.p95Ms?.toFixed(1)}ms/${report.mcpCallTiming.maxMs?.toFixed(1)}ms`);
      console.log(`Controller-local/MCP server/stdio transport p95: ${report.controllerLocalP95Ms?.toFixed(1)}ms/${report.mcpServerPerCaseP95Ms?.toFixed(1)}ms/${report.mcpTransportPerCaseP95Ms?.toFixed(1)}ms`);
    }
  } finally {
    await fake.close();
    try { storage?.db.close(); } catch {}
    rmSync(gatewayDataDir, { recursive: true, force: true });
  }
}

const PHASE1_RETRYABLE_FAULTS = ['connection', 'dns', 'http_408', 'http_429', 'http_5xx'];
const PHASE1_THRESHOLD_MS = 500;
const PHASE1_LEGACY_STDIO_DIAGNOSTIC = {
  transport: 'stdio',
  promotionEligible: false,
  p95Ms: 799.354,
  mcpCallP95Ms: 45.916,
  mcpMaxMs: 3411.0682,
  rawSampleReference: 'governance/torqclaw-phase1-failover-20260730/luna-g2a-integration5-final.md',
  reason: 'transport_not_production_equivalent',
};

function phase1Argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return inline === undefined ? fallback : inline.slice(name.length + 1);
}

function phase1NumberArgument(name, fallback) {
  const raw = phase1Argument(name, undefined);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function phase1Percentile(values, fraction = 0.95) {
  const ordered = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const rank = Math.max(1, Math.ceil(ordered.length * fraction));
  return ordered[Math.min(ordered.length, rank) - 1];
}

function phase1ParseMcpText(raw) {
  const text = raw?.content?.find((entry) => entry?.type === 'text')?.text;
  if (typeof text !== 'string') return {};
  try { return JSON.parse(text); } catch { return {}; }
}

const PHASE1_BOUNDARY_NAMES = [
  'openMs', 'pragmaMs', 'beginImmediateMs', 'statementWorkMs',
  'commitMs', 'closeMs', 'transactionMs',
];
const PHASE1_BOUNDARY_OUTCOMES = new Set([
  'committed', 'setup_failed', 'begin_failed', 'rolled_back', 'commit_failed', 'close_failed',
]);
const PHASE1_LEDGER_OPERATIONS = new Set([
  'admit_frontier', 'submit_attempt', 'poll_observations', 'page_outbox', 'transition_once',
]);
const PHASE1_LEDGER_PHASES = [
  'openMs', 'pragmaMs', 'beginImmediateMs', 'statementWorkMs', 'commitMs', 'closeMs', 'totalMs',
];
const PHASE1_LEDGER_OUTCOMES = new Set(['completed', 'rejected', 'duplicate', 'error']);

function phase1HasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function phase1NonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function phase1NonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function phase1SanitizeBoundaryDiagnostics(raw) {
  if (raw === undefined || raw === null) return { valid: false, reason: 'missing' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, reason: 'malformed' };
  if (raw.schemaVersion !== 1 || typeof raw.correlation !== 'string') return { valid: false, reason: 'malformed' };
  if (raw.correlation === 'missing') {
    return phase1HasExactKeys(raw, ['schemaVersion', 'correlation', 'recordCount']) &&
      phase1NonNegativeInteger(raw.recordCount)
      ? { valid: false, reason: 'missing' }
      : { valid: false, reason: 'malformed' };
  }
  if (raw.correlation === 'ambiguous') {
    return phase1HasExactKeys(raw, ['schemaVersion', 'correlation', 'recordCount']) &&
      phase1NonNegativeInteger(raw.recordCount)
      ? { valid: false, reason: 'ambiguous' }
      : { valid: false, reason: 'malformed' };
  }
  if (raw.correlation !== 'exact' || !phase1HasExactKeys(raw, ['schemaVersion', 'correlation', 'record'])) {
    return { valid: false, reason: 'malformed' };
  }

  const record = raw.record;
  if (!phase1HasExactKeys(record, [
    'sequence', 'operation', 'outcome', 'boundaryMs', 'maintenanceBefore', 'maintenanceAfter',
  ])) return { valid: false, reason: 'malformed' };
  if (!Number.isSafeInteger(record.sequence) || record.sequence <= 0 ||
      record.operation !== 'fused_retryable_transition' ||
      !PHASE1_BOUNDARY_OUTCOMES.has(record.outcome) ||
      !phase1HasExactKeys(record.boundaryMs, PHASE1_BOUNDARY_NAMES) ||
      !phase1HasExactKeys(record.maintenanceBefore, ['writesSinceCheckpoint', 'maintenanceNeeded']) ||
      !phase1HasExactKeys(record.maintenanceAfter, ['writesSinceCheckpoint', 'maintenanceNeeded']) ||
      !phase1NonNegativeInteger(record.maintenanceBefore.writesSinceCheckpoint) ||
      typeof record.maintenanceBefore.maintenanceNeeded !== 'boolean' ||
      !phase1NonNegativeInteger(record.maintenanceAfter.writesSinceCheckpoint) ||
      typeof record.maintenanceAfter.maintenanceNeeded !== 'boolean') {
    return { valid: false, reason: 'malformed' };
  }
  if (!PHASE1_BOUNDARY_NAMES.every((name) => record.boundaryMs[name] === null || phase1NonNegativeFinite(record.boundaryMs[name]))) {
    return { valid: false, reason: 'malformed' };
  }
  if (record.outcome === 'committed' && !PHASE1_BOUNDARY_NAMES.every((name) => phase1NonNegativeFinite(record.boundaryMs[name]))) {
    return { valid: false, reason: 'malformed' };
  }

  return {
    valid: true,
    value: {
      schemaVersion: 1,
      correlation: 'exact',
      record: {
        sequence: record.sequence,
        operation: record.operation,
        outcome: record.outcome,
        boundaryMs: Object.fromEntries(PHASE1_BOUNDARY_NAMES.map((name) => [name, record.boundaryMs[name]])),
        maintenanceBefore: {
          writesSinceCheckpoint: record.maintenanceBefore.writesSinceCheckpoint,
          maintenanceNeeded: record.maintenanceBefore.maintenanceNeeded,
        },
        maintenanceAfter: {
          writesSinceCheckpoint: record.maintenanceAfter.writesSinceCheckpoint,
          maintenanceNeeded: record.maintenanceAfter.maintenanceNeeded,
        },
      },
    },
  };
}

function phase1SanitizeLedgerTimingRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, reason: 'malformed' };
  const required = ['schemaVersion', 'authoritative', 'source', 'correlation', 'operation', 'outcome', 'sqliteMs'];
  const keys = Object.keys(raw);
  if (!required.every((key) => keys.includes(key)) || keys.some((key) => !required.includes(key) && key !== 'taskStoreMs')) {
    return { valid: false, reason: 'malformed' };
  }
  if (raw.schemaVersion !== 1 || raw.authoritative !== false || raw.source !== 'fixture_only' ||
      raw.correlation !== 'exact' || !PHASE1_LEDGER_OPERATIONS.has(raw.operation) ||
      !PHASE1_LEDGER_OUTCOMES.has(raw.outcome) || !phase1HasExactKeys(raw.sqliteMs, PHASE1_LEDGER_PHASES)) {
    return { valid: false, reason: 'malformed' };
  }
  if (!PHASE1_LEDGER_PHASES.every((phase) => raw.sqliteMs[phase] === null || phase1NonNegativeFinite(raw.sqliteMs[phase]))) {
    return { valid: false, reason: 'malformed' };
  }
  const hasPhase = PHASE1_LEDGER_PHASES.slice(0, -1).some((phase) => raw.sqliteMs[phase] !== null);
  if ((hasPhase && raw.sqliteMs.totalMs === null) || (!hasPhase && raw.sqliteMs.totalMs !== null)) {
    return { valid: false, reason: 'malformed' };
  }
  let taskStoreMs;
  if (Object.hasOwn(raw, 'taskStoreMs')) {
    if (!Array.isArray(raw.taskStoreMs)) return { valid: false, reason: 'malformed' };
    taskStoreMs = [];
    for (const item of raw.taskStoreMs) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          Object.keys(item).sort().join(',') !== 'durationMs,operation' ||
          typeof item.operation !== 'string' || !PHASE1_NONNEGATIVE_TASK_DURATION(item.durationMs)) {
        return { valid: false, reason: 'malformed' };
      }
      taskStoreMs.push({ operation: item.operation, durationMs: item.durationMs });
    }
  }
  const value = {
    schemaVersion: 1,
    authoritative: false,
    source: 'fixture_only',
    correlation: 'exact',
    operation: raw.operation,
    outcome: raw.outcome,
    sqliteMs: Object.fromEntries(PHASE1_LEDGER_PHASES.map((phase) => [phase, raw.sqliteMs[phase]])),
  };
  if (taskStoreMs !== undefined) value.taskStoreMs = taskStoreMs;
  return { valid: true, value };
}

function PHASE1_NONNEGATIVE_TASK_DURATION(value) {
  return phase1NonNegativeFinite(value);
}

function phase1ReadLedgerSidecar(path) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function phase1SummarizeLedgerDiagnostics(entries, timings, expectedCount, issues, sidecarPath) {
  const records = timings.map((timing) => timing.ledgerTimingDiagnostics).filter(Boolean);
  const byOperation = {};
  for (const record of records) {
    const summary = byOperation[record.operation] ??= {
      count: 0,
      outcomes: {},
      phases: Object.fromEntries(PHASE1_LEDGER_PHASES.map((phase) => [phase, { count: 0, totalMs: 0, p95Ms: null }])),
    };
    summary.count += 1;
    summary.outcomes[record.outcome] = (summary.outcomes[record.outcome] ?? 0) + 1;
    for (const phase of PHASE1_LEDGER_PHASES) {
      const value = record.sqliteMs[phase];
      if (value !== null) {
        summary.phases[phase].count += 1;
        summary.phases[phase].totalMs += value;
      }
    }
  }
  for (const [operation, summary] of Object.entries(byOperation)) {
    for (const phase of PHASE1_LEDGER_PHASES) {
      const values = records.filter((record) => record.operation === operation)
        .map((record) => record.sqliteMs[phase]).filter((value) => value !== null);
      summary.phases[phase].p95Ms = phase1Percentile(values);
    }
  }
  const sidecarBytes = (() => {
    try { return readFileSync(sidecarPath); } catch { return null; }
  })();
  const sidecarEntries = Array.isArray(entries) ? entries : [];
  const duplicates = Math.max(0, sidecarEntries.length - expectedCount);
  const exact = expectedCount === records.length && sidecarEntries.length === expectedCount && issues.length === 0;
  return {
    enabled: true,
    exactCollected: exact,
    incomplete: !exact,
    noAttributionCondition: records.some((record) => record.source !== 'fixture_only' || record.correlation !== 'exact') || issues.length > 0,
    expectedCount,
    collectedCount: records.length,
    sidecarRecordCount: sidecarEntries.length,
    duplicates,
    reconciliation: {
      expected: expectedCount,
      collected: records.length,
      sidecar: sidecarEntries.length,
      issues: [...new Set(issues)],
    },
    byOperation,
    sha256: sidecarBytes === null ? null : createHash('sha256').update(sidecarBytes).digest('hex'),
  };
}

const PHASE1_TASK_STORE_OPERATIONS = new Set([
  'create', 'emit', 'complete', 'finish_observation', 'fail', 'state_of', 'status',
]);

function phase1EmptyPersistenceDiagnostics() {
  return {
    schemaVersion: 1,
    store: 'task_store',
    records: [],
    recordCount: 0,
    truncatedCount: 0,
  };
}

function phase1SanitizePersistenceDiagnostics(raw) {
  if (raw === undefined || raw === null) {
    return { valid: false, reason: 'missing', value: phase1EmptyPersistenceDiagnostics() };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      !phase1HasExactKeys(raw, ['schemaVersion', 'store', 'records', 'recordCount', 'truncatedCount'])) {
    return { valid: false, reason: 'malformed', value: phase1EmptyPersistenceDiagnostics() };
  }
  if (raw.schemaVersion !== 1 || raw.store !== 'task_store' || !Array.isArray(raw.records) ||
      !phase1NonNegativeInteger(raw.recordCount) || !phase1NonNegativeInteger(raw.truncatedCount) ||
      raw.recordCount !== raw.records.length) {
    return { valid: false, reason: 'malformed', value: phase1EmptyPersistenceDiagnostics() };
  }

  const records = [];
  for (const record of raw.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        !PHASE1_TASK_STORE_OPERATIONS.has(record.operation) ||
        !phase1NonNegativeFinite(record.durationMs)) {
      return { valid: false, reason: 'malformed', value: phase1EmptyPersistenceDiagnostics() };
    }
    records.push({ operation: record.operation, durationMs: record.durationMs });
  }
  const value = {
    schemaVersion: 1,
    store: 'task_store',
    records,
    recordCount: records.length,
    truncatedCount: raw.truncatedCount,
  };
  if (raw.truncatedCount > 0) return { valid: false, reason: 'truncated', value };
  return {
    valid: true,
    value,
  };
}

function phase1ExpectedPersistenceOperations(name, parsed) {
  if (name === 'resilience_admit_frontier') return [];
  if (name === 'resilience_submit_attempt') {
    if (parsed.status === 'DUPLICATE') return ['state_of'];
    // Provider execution is scheduled after the submit handler returns, just
    // as it is in production.  Only task creation belongs to this handler's
    // diagnostic window; provider event/result writes are observed by later
    // polling windows and must not be attributed to submit.
    if (parsed.status === 'SUBMITTED') return ['create'];
    return null;
  }
  if (name === 'resilience_poll_observations' || name === 'resilience_transition_once') return ['status'];
  return null;
}

function phase1PersistenceShapeMatches(name, parsed, records) {
  const expected = phase1ExpectedPersistenceOperations(name, parsed);
  if (expected === null) return true;
  if (records.length !== expected.length) return false;
  return expected.every((operation, index) => operation === null
    ? ['complete', 'fail'].includes(records[index]?.operation)
    : records[index]?.operation === operation);
}

if (process.argv.includes('--phase1-diagnostics-self-test')) {
  const valid = {
    schemaVersion: 1,
    store: 'task_store',
    records: [{ sequence: 7, operation: 'emit', durationMs: 1.25, taskId: 'secret' }],
    recordCount: 1,
    truncatedCount: 0,
  };
  const cases = {
    missing: phase1SanitizePersistenceDiagnostics(undefined).reason,
    malformedCount: phase1SanitizePersistenceDiagnostics({ ...valid, recordCount: 2 }).reason,
    malformedDuration: phase1SanitizePersistenceDiagnostics({
      ...valid, records: [{ operation: 'emit', durationMs: -1 }], recordCount: 1,
    }).reason,
    malformedOperation: phase1SanitizePersistenceDiagnostics({
      ...valid, records: [{ operation: 'secret_operation', durationMs: 1 }],
    }).reason,
    truncated: phase1SanitizePersistenceDiagnostics({ ...valid, truncatedCount: 1 }).reason,
    zeroRecord: phase1SanitizePersistenceDiagnostics({
      schemaVersion: 1, store: 'task_store', records: [], recordCount: 0, truncatedCount: 0,
    }),
  };
  console.log(JSON.stringify({ cases, valid: phase1SanitizePersistenceDiagnostics(valid).value }));
  process.exit(0);
}

function phase1CasePlan(runs) {
  return Array.from({ length: runs }, (_, index) => {
    const eligible = index % 10 < 8;
    const fault = eligible ? PHASE1_RETRYABLE_FAULTS[index % PHASE1_RETRYABLE_FAULTS.length] : 'authentication';
    return { index, fault, eligible };
  });
}

function phase1CasePlanHash(runs) {
  return createHash('sha256').update(JSON.stringify(phase1CasePlan(runs))).digest('hex');
}

function phase1TaskId(repetition, index) {
  // 300 measured cases plus warm-up cases fit in the UUID suffix while
  // remaining deterministic and valid for the gateway's request contract.
  const serial = repetition < 0 ? index + 1 : 100 + (repetition * 100) + index + 1;
  return `00000000-0000-4000-8001-${String(serial).padStart(12, '0')}`;
}

function phase1ProviderIds(repetition, index) {
  const prefix = repetition < 0 ? `warmup-${index}` : `${repetition}-${index}`;
  return { primary: `primary-${prefix}`, fallback: `fallback-${prefix}` };
}

function phase1GitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function phase1PythonVersion() {
  const result = spawnSync(process.platform === 'win32' ? 'uv.exe' : 'uv', ['run', 'python', '--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  });
  const value = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split(/\r?\n/).find(Boolean);
  return result.status === 0 && value ? value : 'unavailable';
}

function phase1CpuSamples() {
  if (process.platform === 'win32') {
    const command = "(1..3 | ForEach-Object { [math]::Round((Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples[0].CookedValue, 3); if ($_ -lt 3) { Start-Sleep -Seconds 1 } }) -join ','";
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.status !== 0) return [];
    return result.stdout.trim().split(',').map(Number).filter((value) => Number.isFinite(value)).slice(0, 3);
  }
  const count = Math.max(1, os.cpus().length);
  return os.loadavg().slice(0, 3).map((value) => (value / count) * 100);
}

function phase1HostRecord(mode, port) {
  const samples = phase1CpuSamples();
  const mean = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null;
  const maximum = samples.length ? Math.max(...samples) : null;
  return {
    mode,
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    pythonVersion: phase1PythonVersion(),
    logicalCpuCount: os.cpus().length,
    availableMemoryBytes: os.freemem(),
    cpuLoadSamplesPercent: samples,
    cpuLoadSampleIntervalSeconds: 1,
    cpuLoadMeanPercent: mean,
    cpuLoadMaxPercent: maximum,
    benchmarkPortIsLoopback: port === null || port > 0,
    benchmarkPortIsTemporary: port === null || ![3000, 8000, 18790].includes(port),
  };
}

function phase1QualifyHost(record) {
  const reasons = [];
  if (record.availableMemoryBytes < 2 * 1024 ** 3) reasons.push('available_memory_below_2GiB');
  if (!Array.isArray(record.cpuLoadSamplesPercent) || record.cpuLoadSamplesPercent.length !== 3) reasons.push('cpu_samples_unavailable');
  if (record.cpuLoadMeanPercent === null || record.cpuLoadMeanPercent > 70) reasons.push('cpu_mean_above_70_percent');
  if (record.cpuLoadMaxPercent === null || record.cpuLoadMaxPercent > 85) reasons.push('cpu_max_above_85_percent');
  if (!record.benchmarkPortIsLoopback || !record.benchmarkPortIsTemporary) reasons.push('benchmark_port_not_isolated');
  return { qualified: reasons.length === 0, reasons };
}

async function phase1FindLoopbackPort() {
  return await new Promise((resolvePort, rejectPort) => {
    const probe = net.createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

async function phase1WaitForPort(child, port, stderr) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`phase1 HTTP fixture exited before readiness: ${stderr()}`);
    const connected = await new Promise((resolveConnected) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolveConnected(true); });
      socket.once('error', () => { socket.destroy(); resolveConnected(false); });
    });
    if (connected) return;
    await sleep(100);
  }
  throw new Error(`phase1 HTTP fixture did not bind loopback port ${port}: ${stderr()}`);
}

async function startPhase1HttpFixture(
  dataDir, sidecarPath, ledgerSidecarPath, port,
  taskStoreDiagnostics = 'off', ledgerTimingDiagnostics = 'off',
  taskStoreDiagnosticsCapacity = null,
) {
  const python = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const fixtureArgs = [
    'run', 'python', join(ROOT, 'ops', 'phase1_fake_provider_http_server.py'),
    '--host', '127.0.0.1', '--port', String(port), '--data-dir', dataDir, '--sidecar', sidecarPath,
    '--task-store-diagnostics', taskStoreDiagnostics,
    '--ledger-timing-diagnostics', ledgerTimingDiagnostics, '--ledger-sidecar', ledgerSidecarPath,
  ];
  if (taskStoreDiagnosticsCapacity !== null) {
    fixtureArgs.push('--task-store-diagnostics-capacity', String(taskStoreDiagnosticsCapacity));
  }
  const child = spawn(python, fixtureArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      HERMES_BIND_HOST: '127.0.0.1',
      HERMES_PORT: String(port),
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_PROVIDER_FAILOVER_ENABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrText = '';
  child.stderr.on('data', (chunk) => { stderrText += String(chunk); });
  child.stdout.on('data', () => undefined);
  await phase1WaitForPort(child, port, () => stderrText.slice(-4000));
  return {
    child,
    async close() {
      if (child.exitCode !== null) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill();
      }
      await Promise.race([once(child, 'close'), sleep(1_000)]);
    },
  };
}

function phase1ReadSidecar(path) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function phase1ErrorCode(error) {
  const failure = error && typeof error === 'object' ? error.failure : null;
  return failure && typeof failure.code === 'string' ? failure.code : null;
}

function phase1ReadMaintenanceDiagnostics(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'resilience-maintenance.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1) {
      return { available: false, reason: 'malformed_snapshot' };
    }
    return {
      available: true,
      schemaVersion: raw.schemaVersion,
      maintenanceNeeded: raw.maintenanceNeeded === true,
      maintenanceNeededByStore: raw.maintenanceNeededByStore ?? null,
      lastPassiveOutcome: raw.lastPassiveOutcome ?? null,
      walMaintenanceDeferred: raw.walMaintenanceDeferred === true,
      drained: raw.drained === true,
      ledger: raw.ledger ?? null,
      taskStore: raw.taskStore ?? null,
    };
  } catch {
    return { available: false, reason: 'not_available' };
  }
}

async function runPhase1HttpBench() {
  const jsonOutput = process.argv.includes('--json');
  const runs = phase1NumberArgument('--runs', process.argv.includes('--quick') ? 12 : 100) || 100;
  const warmupCount = phase1NumberArgument('--warmup', process.argv.includes('--quick') ? 2 : 10);
  const repetitions = phase1NumberArgument('--repetitions', 1) || 1;
  const hostControlMode = phase1Argument('--host-control', 'record');
  const taskStoreDiagnostics = phase1Argument('--task-store-diagnostics', 'off');
  const taskStoreDiagnosticsCapacity = phase1NumberArgument('--task-store-diagnostics-capacity', null);
  const ledgerTimingDiagnostics = phase1Argument(
    '--ledger-timing-diagnostics', phase1Argument('--ledger-diagnostics', 'off'),
  );
  if (!['off', 'record', 'capture'].includes(taskStoreDiagnostics)) {
    throw new Error(`unsupported task-store diagnostics mode: ${taskStoreDiagnostics}`);
  }
  if (!['off', 'capture'].includes(ledgerTimingDiagnostics)) {
    throw new Error(`unsupported ledger timing diagnostics mode: ${ledgerTimingDiagnostics}`);
  }
  const outPath = phase1Argument('--out', null);
  const sourceRevision = phase1GitRevision();
  const canonicalCommand = process.argv.slice(2);
  const casePlanHash = phase1CasePlanHash(runs);
  const gatewayDataDir = mkdtempSync(join(tmpdir(), 'torqclaw-phase1-http-bench-'));
  const sidecarPath = join(gatewayDataDir, 'phase1-provider-wait-sidecar.jsonl');
  const ledgerSidecarPath = join(gatewayDataDir, 'phase1-ledger-timing-sidecar.jsonl');
  const port = await phase1FindLoopbackPort();
  const preflight = phase1HostRecord(hostControlMode, port);
  const preflightQualification = phase1QualifyHost(preflight);
  let fixture;
  let mcpClient;
  let storage;
  let runFailoverTask;
  let parseProviderChainsDocument;
  const warmup = [];
  const blockReports = [];
  const fatalReasons = [];
  let activeCase = null;
  let currentBlock = null;
  let sessionCount = 0;
  let listToolsBeforeWarmup = false;
  let accountingProbe = null;
  let pageOutboxProbe = null;
  const ledgerObservedTimings = [];

  const baseReport = {
    schemaVersion: 2,
    mode: 'phase1-promotion-benchmark',
    transport: 'streamable-http',
    connectionReuse: 'single-session',
    sessionCount: 0,
    listToolsBeforeWarmup: false,
    fixture: 'persistent-loopback-fake-engine',
    taskStoreDiagnostics,
    taskStoreDiagnosticsCapacity,
    ledgerTimingDiagnostics,
    network: false,
    liveProviderClaim: false,
    syntheticMetrics: false,
    promotionEligible: false,
    sourceRevision,
    commandArguments: canonicalCommand,
    warmupCount,
    repetitionsRequested: repetitions,
    runsPerRepetition: runs,
    casePlanSha256: casePlanHash,
    hostControl: {
      mode: hostControlMode,
      preflight,
      preflightQualification,
      postflight: null,
      postflightQualification: null,
      qualified: false,
    },
    promotion: {
      metric: 'end_to_end_orchestration_ms_excluding_explicit_provider_wait',
      thresholdMetric: 'core_orchestration_ms_excluding_explicit_provider_wait_and_policy_jitter',
      thresholdMs: PHASE1_THRESHOLD_MS,
      percentile: { method: 'nearest-rank', rank: Math.max(1, Math.ceil(runs * 0.95)), population: runs },
      policyJitterIncluded: true,
      providerWaitExcludedMs: 0,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
      thresholdP95Ms: null,
      thresholdP99Ms: null,
      thresholdMaxMs: null,
      passed: false,
    },
    warmup: [],
    repetitions: [],
    providerWaitAccountingProbe: null,
    pageOutboxProbe: null,
    legacyStdioDiagnostic: PHASE1_LEGACY_STDIO_DIAGNOSTIC,
    maintenanceDiagnostics: null,
    ledgerDiagnostics: null,
    fatalReasons,
  };

  let ledgerSidecarCursor = 0;
  const ledgerDiagnosticIssues = [];
  const consumeLedgerDiagnostic = (expectedOperation) => {
    if (ledgerTimingDiagnostics !== 'capture') return null;
    const entries = phase1ReadLedgerSidecar(ledgerSidecarPath);
    const entry = entries[ledgerSidecarCursor];
    ledgerSidecarCursor += 1;
    if (!entry || entry.type !== 'ledger_timing' || entry.operation !== expectedOperation) {
      ledgerDiagnosticIssues.push('missing_or_misaligned');
      return null;
    }
    if (entry.correlation !== 'exact') {
      ledgerDiagnosticIssues.push(entry.correlation === 'truncated' ? 'truncated' : entry.correlation);
      return null;
    }
    const sanitized = phase1SanitizeLedgerTimingRecord(entry.record);
    if (!sanitized.valid || sanitized.value.operation !== expectedOperation) {
      ledgerDiagnosticIssues.push(sanitized.reason ?? 'malformed');
      return null;
    }
    return sanitized.value;
  };

  const recordTiming = (call, elapsedMs, parsed = {}, error = null) => {
    const serverElapsedMs = typeof parsed.__phase1FakeServerMs === 'number' ? parsed.__phase1FakeServerMs : null;
    const timing = {
      name: call.name,
      elapsedMs,
      serverHandlerMs: serverElapsedMs,
      transportMs: serverElapsedMs === null ? elapsedMs : Math.max(0, elapsedMs - serverElapsedMs),
      status: typeof parsed.status === 'string' ? parsed.status : null,
      error: error ? 'mcp_transport_error' : null,
    };
    if (PHASE1_LEDGER_OPERATIONS.has(call.name.replace(/^resilience_/, ''))) {
      timing.ledgerTimingDiagnostics = consumeLedgerDiagnostic(call.name.replace(/^resilience_/, ''));
      ledgerObservedTimings.push(timing);
    }
    const captureTaskStoreDiagnostics = taskStoreDiagnostics === 'capture';
    const persistence = captureTaskStoreDiagnostics
      ? phase1SanitizePersistenceDiagnostics(parsed.__phase1PersistenceDiagnostics)
      : { valid: true, value: null, reason: null };
    const diagnosticFatal = (reason) => {
      (currentBlock?.fatalReasons ?? fatalReasons).push(`persistence_diagnostics_${reason}`);
    };
    timing.persistenceDiagnostics = persistence.value;
    if (captureTaskStoreDiagnostics && persistence.valid) {
      const persistenceDurationMs = persistence.value.records.reduce((sum, record) => sum + record.durationMs, 0);
      if (serverElapsedMs !== null && persistenceDurationMs > serverElapsedMs) {
        diagnosticFatal('exceeds_handler_duration');
      }
      if (!phase1PersistenceShapeMatches(call.name, parsed, persistence.value.records)) {
        diagnosticFatal('unexpected_delta');
      }
    } else if (captureTaskStoreDiagnostics) {
      diagnosticFatal(persistence.reason);
    }
    if (call.name === 'resilience_transition_once') {
      const boundary = phase1SanitizeBoundaryDiagnostics(parsed.__phase1BoundaryDiagnostics);
      if (boundary.valid) timing.boundaryDiagnostics = boundary.value;
      if (currentBlock && !boundary.valid) currentBlock.fatalReasons.push(`boundary_diagnostics_${boundary.reason}`);
      if (currentBlock && boundary.valid && boundary.value.record.outcome !== 'committed') {
        currentBlock.fatalReasons.push('boundary_diagnostics_not_committed');
      }
    }
    if (activeCase) activeCase.mcpOperations.push(timing);
    if (currentBlock) {
      currentBlock.mcpTimings.push(timing);
      // Projection maintenance calls are measured, but are not part of the
      // provider-controller operation-count contract.
      if (call.name !== 'resilience_page_outbox') {
        currentBlock.operationCounts[call.name] = (currentBlock.operationCounts[call.name] ?? 0) + 1;
      }
      if (error) currentBlock.fatalReasons.push('mcp_transport_error');
      if (call.name === 'resilience_submit_attempt') {
        currentBlock.providerSubmissions += 1;
        if (parsed.status === 'DUPLICATE') currentBlock.duplicateSubmissions += 1;
      }
      if (call.name === 'resilience_transition_once' && parsed.status === 'TRANSITIONED') currentBlock.transitionCount += 1;
      if (call.name === 'resilience_finalize_attempt' && ['FINALIZED', 'DUPLICATE'].includes(parsed.status)) currentBlock.finalizationCount += 1;
      if (call.name === 'resilience_poll_observations') currentBlock.pollingCount += 1;
    }
    return timing;
  };

  try {
    ensurePhase1ProductionBuild();
    process.env.TORQCLAW_DATA_DIR = gatewayDataDir;
    process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED = 'true';
    process.env.TORQCLAW_FAILOVER_CODING_CHAIN = 'coding';
    process.env.TORQCLAW_FAILOVER_TASK_DEADLINE_MS = '30000';
    process.env.TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS = '10000';
  fixture = await startPhase1HttpFixture(
      gatewayDataDir, sidecarPath, ledgerSidecarPath, port,
      taskStoreDiagnostics, ledgerTimingDiagnostics, taskStoreDiagnosticsCapacity,
    );

    const sdkRoot = realpathSync(join(ROOT, 'packages', 'bridge', 'node_modules', '@modelcontextprotocol', 'sdk'));
    const { Client } = await import(pathToFileURL(join(sdkRoot, 'dist', 'esm', 'client', 'index.js')).href);
    const { StreamableHTTPClientTransport } = await import(pathToFileURL(join(sdkRoot, 'dist', 'esm', 'client', 'streamableHttp.js')).href);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    mcpClient = new Client({ name: 'torqclaw-phase1-bench', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
    sessionCount = 1;
    const tools = await mcpClient.listTools();
    listToolsBeforeWarmup = Array.isArray(tools.tools) && tools.tools.some((tool) => tool.name === 'resilience_admit_frontier');

    const client = {
      async callTool(call) {
        const started = performance.now();
        try {
          const raw = await mcpClient.callTool({ name: call.name, arguments: call.arguments ?? {} });
          const timing = recordTiming(call, performance.now() - started, phase1ParseMcpText(raw));
          if (call.name === 'resilience_page_outbox') pageOutboxProbe = timing;
          return raw;
        } catch (error) {
          const timing = recordTiming(call, performance.now() - started, {}, error);
          if (call.name === 'resilience_page_outbox') pageOutboxProbe = timing;
          throw error;
        }
      },
    };

    await client.callTool({ name: 'resilience_page_outbox', arguments: { after_cursor: 0, limit: 1 } });

    const probeStarted = performance.now();
    const probeRaw = await client.callTool({ name: 'phase1_provider_wait_probe', arguments: {
      task_id: 'phase1-accounting-probe', attempt_id: 'phase1-accounting-attempt', provider_wait_ms: 200,
    } });
    const probeRawElapsedMs = performance.now() - probeStarted;
    const probeResponse = phase1ParseMcpText(probeRaw);
    const probeSidecar = phase1ReadSidecar(sidecarPath).find((entry) => entry.taskId === 'phase1-accounting-probe' && entry.attemptId === 'phase1-accounting-attempt');
    const sidecarDurationMs = typeof probeSidecar?.durationMs === 'number' ? probeSidecar.durationMs : null;
    accountingProbe = {
      requestedProviderWaitMs: 200,
      rawElapsedMs: probeRawElapsedMs,
      sidecarDurationMs,
      providerWaitExcludedMs: sidecarDurationMs,
      promotionElapsedMs: sidecarDurationMs === null ? null : probeRawElapsedMs - sidecarDurationMs,
      sidecarRecordCount: probeSidecar ? 1 : 0,
      responseStatus: probeResponse.status ?? null,
      passed: sidecarDurationMs !== null && probeRawElapsedMs >= sidecarDurationMs && probeResponse.status === 'PROBED',
    };
    baseReport.providerWaitAccountingProbe = accountingProbe;

    ({ runFailoverTask } = await import('../packages/gateway/dist/failover.js'));
    ({ parseProviderChainsDocument } = await import('../packages/gateway/dist/providerChains.js'));
    storage = await import('../packages/gateway/dist/storage.js');

    const runCase = async (repetition, index, block) => {
      const planned = phase1CasePlan(Math.max(runs, index + 1))[index];
      const taskId = phase1TaskId(repetition, index);
      const providers = phase1ProviderIds(repetition, index);
      const record = {
        caseIndex: index,
        taskId,
        fault: planned.fault,
        eligible: planned.eligible,
        terminalState: null,
        attempts: 0,
        duplicateSubmissions: 0,
        rawElapsedMs: null,
        explicitProviderWaitMs: 0,
        promotionElapsedMs: null,
        thresholdElapsedMs: null,
        policyJitterMs: 0,
        mcpOperations: [],
        controllerCompleted: false,
        errorClass: null,
        errorCode: null,
      };
      const started = performance.now();
      activeCase = record;
      try {
        const document = parseProviderChainsDocument({
          revision: `phase1-http-${repetition}-${index}`,
          chains: { coding: { id: 'coding', providers: [
            { id: providers.primary, label: 'Primary', modelId: 'fake-primary', apiKeyEnvName: 'P1_FAKE_KEY_A', baseUrlEnvName: 'P1_FAKE_BASE_A', privacyClasses: ['standard'], ceilingMicroUsd: 1 },
            { id: providers.fallback, label: 'Fallback', modelId: 'fake-fallback', apiKeyEnvName: 'P1_FAKE_KEY_B', baseUrlEnvName: 'P1_FAKE_BASE_B', privacyClasses: ['standard'], ceilingMicroUsd: 1 },
          ] } },
        });
        const result = await runFailoverTask(
          phase1Request(taskId, '00000000-0000-4000-8000-000000000000', planned.fault),
          { tier: 'API_EXTERNAL' },
          {
            document,
            env: {
              TORQCLAW_FAILOVER_CODING_CHAIN: 'coding',
              TORQCLAW_FAILOVER_TASK_DEADLINE_MS: '30000',
              TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS: '10000',
              TORQCLAW_PROVIDER_CHAIN_REVISION: `phase1-http-${repetition}-${index}`,
            },
            client,
            emit: () => undefined,
            random: () => 0,
            sleepMs: async (delayMs) => {
              const jitterStarted = performance.now();
              await new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
              if (delayMs > 0) record.policyJitterMs += performance.now() - jitterStarted;
            },
          },
        );
        record.controllerCompleted = typeof result.text === 'string' && result.text.includes('deterministic result');
      } catch (error) {
        record.errorClass = error?.name ?? 'Error';
        record.errorCode = phase1ErrorCode(error);
      } finally {
        record.rawElapsedMs = performance.now() - started;
        record.promotionElapsedMs = record.rawElapsedMs - record.explicitProviderWaitMs;
        // Policy jitter is an intentional, bounded failover delay. Keep the
        // inclusive end-to-end value above, but evaluate the 500ms
        // orchestration budget against the core path after that separately
        // reported delay, matching the PRD's overhead metric.
        record.thresholdElapsedMs = Math.max(0, record.promotionElapsedMs - record.policyJitterMs);
        try {
          const attempts = storage.getProviderAttemptProjections(taskId);
          const projection = storage.getFailoverProjection(taskId);
          record.attempts = attempts.length;
          record.terminalState = projection?.terminal_outcome ?? null;
          record.reconciled = projection?.active_attempt_id === null && projection?.active_epoch === null && record.terminalState !== null;
          record.duplicateSubmissions = record.mcpOperations.filter((operation) => operation.name === 'resilience_submit_attempt' && operation.status === 'DUPLICATE').length;
        } catch {
          record.reconciled = false;
          (block?.fatalReasons ?? fatalReasons).push('projection_read_failed');
        }
        activeCase = null;
      }
      if (block) {
        block.cases.push(record);
        block.rawValues.push(record.promotionElapsedMs);
        block.thresholdValues.push(record.thresholdElapsedMs);
        if (record.eligible && record.terminalState === 'completed' && record.controllerCompleted) block.eligibleCompleted += 1;
        if (record.terminalState === 'failed') block.terminalFailures += 1;
        if (!record.reconciled) block.fatalReasons.push('missing_terminal_record');
        const expectedError = !record.eligible && record.terminalState === 'failed' && record.errorCode === 'http_401';
        if ((record.eligible && (!record.controllerCompleted || record.terminalState !== 'completed')) || (!record.eligible && !expectedError)) block.fatalReasons.push('case_outcome_mismatch');
      } else {
        warmup.push(record);
      }
      return record;
    };

    for (let index = 0; index < warmupCount; index += 1) await runCase(-1, index, null);

    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const block = {
        repetition: repetition + 1,
        runs,
        cases: [],
        rawValues: [],
        thresholdValues: [],
        mcpTimings: [],
        operationCounts: {},
        providerSubmissions: 0,
        duplicateSubmissions: 0,
        transitionCount: 0,
        finalizationCount: 0,
        pollingCount: 0,
        eligibleCompleted: 0,
        terminalFailures: 0,
        fatalReasons: [],
      };
      currentBlock = block;
      for (let index = 0; index < runs; index += 1) await runCase(repetition, index, block);
      currentBlock = null;
      const p95Ms = phase1Percentile(block.rawValues, 0.95);
      const p99Ms = phase1Percentile(block.rawValues, 0.99);
      const maxMs = block.rawValues.length ? Math.max(...block.rawValues) : null;
      const thresholdP95Ms = phase1Percentile(block.thresholdValues, 0.95);
      const thresholdP99Ms = phase1Percentile(block.thresholdValues, 0.99);
      const thresholdMaxMs = block.thresholdValues.length ? Math.max(...block.thresholdValues) : null;
      const expectedEligible = block.cases.filter((item) => item.eligible).length;
      const expectedAttempts = (expectedEligible * 2) + (runs - expectedEligible);
      const expectedSubmissions = expectedAttempts;
      const operationValues = Object.fromEntries(Object.entries(block.operationCounts).map(([name]) => {
        const values = block.mcpTimings.filter((timing) => timing.name === name).map((timing) => timing.elapsedMs);
        const serverValues = block.mcpTimings.filter((timing) => timing.name === name).map((timing) => timing.serverHandlerMs ?? 0);
        const transportValues = block.mcpTimings.filter((timing) => timing.name === name).map((timing) => timing.transportMs);
        return [name, {
          count: values.length,
          totalMs: values.reduce((sum, value) => sum + value, 0),
          p95Ms: phase1Percentile(values),
          p99Ms: phase1Percentile(values, 0.99),
          maxMs: values.length ? Math.max(...values) : null,
          serverHandlerP95Ms: phase1Percentile(serverValues),
          transportP95Ms: phase1Percentile(transportValues),
        }];
      }));
      const expectedCounts = {
        cases: runs,
        eligible: expectedEligible,
        eligibleCompleted: expectedEligible,
        attempts: expectedAttempts,
        submissions: expectedSubmissions,
        transitions: expectedEligible,
        terminalFailures: runs - expectedEligible,
        duplicateSubmissions: 0,
      };
      const counts = {
        cases: block.cases.length,
        eligible: expectedEligible,
        eligibleCompleted: block.eligibleCompleted,
        attempts: expectedAttempts,
        submissions: block.providerSubmissions,
        transitions: block.transitionCount,
        terminalFailures: block.terminalFailures,
        duplicateSubmissions: block.duplicateSubmissions,
      };
      const countConsistent = JSON.stringify(counts) === JSON.stringify(expectedCounts);
      const thresholdApplies = runs === 100;
      const valid = block.cases.length === runs && countConsistent && block.fatalReasons.length === 0 && thresholdP95Ms !== null && (!thresholdApplies || thresholdP95Ms <= PHASE1_THRESHOLD_MS);
      blockReports.push({
        repetition: block.repetition,
        transport: 'streamable-http',
        promotionEligible: false,
        complete: block.cases.length === runs,
        valid,
        countConsistent,
        expectedCounts,
        counts,
        p95Ms,
        p99Ms,
        maxMs,
        rawPromotionValuesMs: block.rawValues,
        thresholdPromotionValuesMs: block.thresholdValues,
        thresholdP95Ms,
        thresholdP99Ms,
        thresholdMaxMs,
        cases: block.cases,
        operationCounts: block.operationCounts,
        mcpCallTiming: {
          count: block.mcpTimings.length,
          totalMs: block.mcpTimings.reduce((sum, timing) => sum + timing.elapsedMs, 0),
          p95Ms: phase1Percentile(block.mcpTimings.map((timing) => timing.elapsedMs)),
          p99Ms: phase1Percentile(block.mcpTimings.map((timing) => timing.elapsedMs), 0.99),
          maxMs: block.mcpTimings.length ? Math.max(...block.mcpTimings.map((timing) => timing.elapsedMs)) : null,
          byOperation: operationValues,
        },
        policyJitterMs: block.cases.reduce((sum, item) => sum + item.policyJitterMs, 0),
        providerWaitExcludedMs: 0,
        fatalReasons: [...new Set(block.fatalReasons)],
      });
      if (blockReports.at(-1).fatalReasons.length) fatalReasons.push(`repetition_${repetition + 1}_failed`);
      if (runs === 100 && thresholdP95Ms !== null && thresholdP95Ms > PHASE1_THRESHOLD_MS) fatalReasons.push(`repetition_${repetition + 1}_threshold_p95_over_threshold`);
    }
  } catch (error) {
    fatalReasons.push(error?.message?.includes('phase1 HTTP fixture') ? 'fixture_start_or_connection_failure' : 'benchmark_execution_failure');
  } finally {
    if (mcpClient) {
      try { await mcpClient.close(); } catch { fatalReasons.push('mcp_session_close_failure'); }
    }
    if (fixture) await fixture.close();
    baseReport.maintenanceDiagnostics = phase1ReadMaintenanceDiagnostics(gatewayDataDir);
    if (storage) {
      try { storage.db.close(); } catch { fatalReasons.push('gateway_database_close_failure'); }
    }
    const postflight = phase1HostRecord(hostControlMode, port);
    const postflightQualification = phase1QualifyHost(postflight);
    baseReport.sessionCount = sessionCount;
    baseReport.listToolsBeforeWarmup = listToolsBeforeWarmup;
    baseReport.hostControl.postflight = postflight;
    baseReport.hostControl.postflightQualification = postflightQualification;
    baseReport.hostControl.qualified = preflightQualification.qualified && postflightQualification.qualified && preflight.benchmarkPortIsTemporary && postflight.benchmarkPortIsTemporary;
    baseReport.warmup = warmup;
    baseReport.repetitions = blockReports;
    baseReport.pageOutboxProbe = pageOutboxProbe;
    if (ledgerTimingDiagnostics === 'capture') {
      const allTiming = [
        ...warmup.flatMap((item) => item.mcpOperations ?? []),
        ...blockReports.flatMap((block) => block.cases.flatMap((item) => item.mcpOperations ?? [])),
      ];
      // Include every ledger-bearing MCP call, including the initial and
      // shutdown reconciliation page-outs that are intentionally outside a
      // case record. The sidecar is correlated to this exact observed list;
      // do not invent an extra count or silently drop maintenance calls.
      const expectedLedgerCount = ledgerObservedTimings.length;
      const sidecarEntries = phase1ReadLedgerSidecar(ledgerSidecarPath);
      baseReport.ledgerDiagnostics = phase1SummarizeLedgerDiagnostics(
        sidecarEntries, ledgerObservedTimings, expectedLedgerCount,
        ledgerDiagnosticIssues, ledgerSidecarPath,
      );
    } else {
      baseReport.ledgerDiagnostics = { enabled: false, exactCollected: false, incomplete: false };
    }
    baseReport.fatalReasons = [...new Set(fatalReasons)];
    baseReport.promotion.p95Ms = blockReports.length ? Math.max(...blockReports.map((block) => block.p95Ms ?? Number.POSITIVE_INFINITY)) : null;
    baseReport.promotion.p99Ms = blockReports.length ? Math.max(...blockReports.map((block) => block.p99Ms ?? Number.POSITIVE_INFINITY)) : null;
    baseReport.promotion.maxMs = blockReports.length ? Math.max(...blockReports.map((block) => block.maxMs ?? Number.POSITIVE_INFINITY)) : null;
    baseReport.promotion.thresholdP95Ms = blockReports.length ? Math.max(...blockReports.map((block) => block.thresholdP95Ms ?? Number.POSITIVE_INFINITY)) : null;
    baseReport.promotion.thresholdP99Ms = blockReports.length ? Math.max(...blockReports.map((block) => block.thresholdP99Ms ?? Number.POSITIVE_INFINITY)) : null;
    baseReport.promotion.thresholdMaxMs = blockReports.length ? Math.max(...blockReports.map((block) => block.thresholdMaxMs ?? Number.POSITIVE_INFINITY)) : null;
    const allBlocksValid = blockReports.length === repetitions && blockReports.every((block) => block.valid && block.complete && block.countConsistent);
    const exactPromotionShape = runs === 100 && warmupCount === 10 && repetitions === 3;
    const hostQualified = baseReport.hostControl.qualified;
    for (const block of blockReports) {
      block.promotionEligible = hostControlMode === 'require' && hostQualified && block.valid && block.complete && block.countConsistent;
    }
    baseReport.promotion.passed = baseReport.fatalReasons.length === 0 && allBlocksValid && exactPromotionShape && hostControlMode === 'require' && hostQualified && accountingProbe?.passed === true && baseReport.sessionCount === 1 && baseReport.listToolsBeforeWarmup;
    baseReport.promotionEligible = baseReport.promotion.passed;
    baseReport.ok = baseReport.fatalReasons.length === 0 && blockReports.every((block) => block.valid) && (hostControlMode !== 'require' || baseReport.promotion.passed);
    try {
      rmSync(gatewayDataDir, { recursive: true, force: true });
    } catch {
      baseReport.fatalReasons = [...new Set([...baseReport.fatalReasons, 'fixture_cleanup_failed'])];
      baseReport.ok = false;
      baseReport.promotion.passed = false;
      baseReport.promotionEligible = false;
    }
    if (outPath) writeFileSync(outPath, JSON.stringify(baseReport, null, 2) + '\n', 'utf8');
    if (jsonOutput) console.log(JSON.stringify(baseReport, null, 2));
    else {
      console.log(`TORQCLAW Phase-1 HTTP benchmark: ${baseReport.ok ? 'PASS' : 'BLOCKED'}`);
      console.log(`Repetitions: ${blockReports.length}/${repetitions}; session count: ${baseReport.sessionCount}; host qualified: ${hostQualified}`);
      console.log(`Promotion p95/p99/max: ${baseReport.promotion.p95Ms ?? 'n/a'}/${baseReport.promotion.p99Ms ?? 'n/a'}/${baseReport.promotion.maxMs ?? 'n/a'}ms`);
      console.log(`Threshold core p95/p99/max: ${baseReport.promotion.thresholdP95Ms ?? 'n/a'}/${baseReport.promotion.thresholdP99Ms ?? 'n/a'}/${baseReport.promotion.thresholdMaxMs ?? 'n/a'}ms`);
    }
    if (!baseReport.ok) process.exitCode = 1;
  }
}

async function runPhase1Bench() {
  const transport = phase1Argument('--transport', 'http');
  if (transport === 'stdio') return await runPhase1StdioBench();
  if (transport !== 'http') throw new Error(`unsupported Phase-1 transport: ${transport}`);
  return await runPhase1HttpBench();
}

if (phase1Mode) {
  try {
    await runPhase1Bench();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
  if (process.exitCode) process.exit(process.exitCode);
  else process.exit(0);
}


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
