import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function runBench(args: string[], outputPath: string): Promise<Record<string, any>> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ['ops/bench.mjs', '--phase1', ...args, '--json', '--out', outputPath], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', rejectResult);
    child.once('close', (code) => {
      if (code !== 0) {
        rejectResult(new Error(`bench exited ${code}: ${stdout}\n${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(readFileSync(outputPath, 'utf8')));
      } catch (error) {
        rejectResult(new Error(`bench report was not valid JSON: ${error}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function runBenchExpectingFailure(args: string[], outputPath: string): Promise<{ code: number | null; report: Record<string, any> }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ['ops/bench.mjs', '--phase1', ...args, '--json', '--out', outputPath], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', rejectResult);
    child.once('close', (code) => {
      try {
        resolveResult({ code, report: JSON.parse(readFileSync(outputPath, 'utf8')) });
      } catch (error) {
        rejectResult(new Error(`failed benchmark report was not valid JSON: ${error}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function runDiagnosticsSelfTest(): Promise<Record<string, any>> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(process.execPath, ['ops/bench.mjs', '--phase1-diagnostics-self-test'], { cwd: ROOT, env: { ...process.env } }, (error, stdout, stderr) => {
      if (error) {
        rejectResult(new Error(`diagnostics self-test failed: ${error}\n${stdout}\n${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout));
      } catch (parseError) {
        rejectResult(new Error(`diagnostics self-test was not valid JSON: ${parseError}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function runPersistenceDiagnosticsProbe(): Promise<Record<string, any>> {
  const script = String.raw`
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, r'E:\TorqClaw-agent\engines\hermes_kernel')
from mcp_wrapper.attempt_ledger import AttemptLedger

def finite_nonnegative(value):
    return value is None or (isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 and value != float('inf'))

with tempfile.TemporaryDirectory() as td:
    ledger = AttemptLedger(Path(td) / 'attempts.sqlite')
    before = ledger.boundary_diagnostics()
    with ledger._tx(operation='fused_retryable_transition') as conn:
        result = conn.execute('SELECT 1').fetchone()[0]
    after = ledger.boundary_diagnostics(before['lastSequence'])
    record = after['records'][0]
    boundary = record['boundaryMs']
    ledger.set_diagnostics_enabled(False)
    disabled_before = ledger.boundary_diagnostics()['lastSequence']
    with ledger._tx(operation='fused_retryable_transition') as conn:
        disabled_result = conn.execute('SELECT 1').fetchone()[0]
    disabled_after = ledger.boundary_diagnostics()['lastSequence']
    original_append = ledger._append_boundary_record
    ledger._append_boundary_record = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('diagnostic recorder failure'))
    with ledger._tx(operation='fused_retryable_transition') as conn:
        recorder_safe_result = conn.execute('SELECT 1').fetchone()[0]
    try:
        with ledger._tx(operation='fused_retryable_transition'):
            raise ValueError('operation exception must survive')
    except ValueError:
        recorder_safe_exception = True
    else:
        recorder_safe_exception = False
    ledger._append_boundary_record = original_append

    snapshot_keys = set(after.keys())
    record_keys = set(record.keys())
    forbidden = ('task', 'attempt', 'provider', 'model', 'payload', 'prompt', 'result', 'error', 'sql', 'path', 'env', 'credential', 'exception')
    serialized = json.dumps(after, sort_keys=True).lower()
    no_forbidden = 'secret-prompt' not in serialized and 'operation exception' not in serialized and not any(
        token in key.lower() for key in after for token in ('taskid', 'attemptid', 'providerid', 'modelid', 'payload', 'prompt', 'result', 'error', 'sql', 'path', 'env', 'credential', 'exception')
    )
    phase_names = {'openMs', 'pragmaMs', 'beginImmediateMs', 'statementWorkMs', 'commitMs', 'closeMs', 'transactionMs'}

    import os
    os.environ['TORQCLAW_DATA_DIR'] = str(Path(td) / 'task-store')
    from mcp_wrapper import task_store
    task_store.set_diagnostics_enabled(True)
    task_store.create({'prompt': 'secret-prompt'}, task_id='secret-task')
    enabled_status = task_store.status('secret-task')
    task_snapshot = task_store.diagnostic_snapshot()
    task_store.set_diagnostics_enabled(False)
    disabled_status = task_store.status('secret-task')
    task_disabled_sequence = task_store.diagnostic_snapshot()['lastSequence']
    original_task_recorder = task_store._record_diagnostic
    task_store._record_diagnostic = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('diagnostic recorder failure'))
    recorder_safe_task = task_store.state_of('missing-task') is None
    task_store._record_diagnostic = original_task_recorder
    task_store.set_diagnostics_enabled(True)
    task_sequence_before_capacity = task_store.diagnostic_snapshot()['lastSequence']
    for _ in range(task_store._DIAGNOSTIC_CAPACITY + 8):
        original_task_recorder('emit', 1.0)
    task_capacity_snapshot = task_store.diagnostic_snapshot()
    task_store.shutdown_for_tests()

    print(json.dumps({
        'ledgerSchemaKeys': sorted(snapshot_keys),
        'ledgerRecordKeys': sorted(record_keys),
        'ledgerStore': after['store'],
        'ledgerOperation': record['operation'],
        'ledgerCorrelation': 'exact' if len(after['records']) == 1 else 'ambiguous',
        'ledgerDropCount': after['droppedCount'],
        'ledgerFirstSequence': after['firstSequence'],
        'ledgerLastSequence': after['lastSequence'],
        'ledgerPhaseNames': sorted(boundary),
        'ledgerDurationsFinite': all(finite_nonnegative(value) for value in boundary.values()),
        'redacted': no_forbidden,
        'functionalResultEquivalent': result == disabled_result == recorder_safe_result,
        'functionalStatusEquivalent': enabled_status == disabled_status,
        'ledgerDiagnosticDisabledSequenceUnchanged': disabled_before == disabled_after,
        'taskDiagnosticDisabledSequenceUnchanged': task_disabled_sequence == task_sequence_before_capacity,
        'recorderFailurePreservedException': recorder_safe_exception,
        'recorderFailurePreservedTaskResult': recorder_safe_task,
        'taskStoreSchemaKeys': sorted(task_snapshot.keys()),
        'taskStoreDropCountBeforeCap': task_snapshot['droppedCount'],
        'taskStoreDropCountAfterCap': task_capacity_snapshot['droppedCount'],
        'taskStoreFinite': all(finite_nonnegative(record['durationMs']) for record in task_snapshot['records']),
        'taskStoreAllowed': all(record['store'] == 'task_store' and record['operation'] in task_store._DIAGNOSTIC_OPERATIONS for record in task_snapshot['records']),
    }, separators=(',', ':')))
`;
  return new Promise((resolveResult, rejectResult) => {
    execFile('python', ['-c', script], { cwd: ROOT, env: { ...process.env } }, (error, stdout, stderr) => {
      if (error) {
        rejectResult(new Error(`diagnostics probe failed: ${error}\n${stdout}\n${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout));
      } catch (parseError) {
        rejectResult(new Error(`diagnostics probe was not valid JSON: ${parseError}\n${stdout}\n${stderr}`));
      }
    });
  });
}

describe('Phase-1 persistent HTTP promotion instrumentation', () => {
  it('uses one MCP session, records real end-to-end cases, and preserves stdio as diagnostic-only', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'torqclaw-phase1-performance-test-'));
    const httpReportPath = join(outputRoot, 'http.json');
    const stdioReportPath = join(outputRoot, 'stdio.json');
    try {
      const http = await runBench([
        '--transport=http', '--runs', '12', '--warmup', '2', '--repetitions', '1', '--host-control=record',
        '--task-store-diagnostics=capture',
      ], httpReportPath);

      expect(http.schemaVersion).toBe(2);
      expect(http.transport).toBe('streamable-http');
      expect(http.fixture).toBe('persistent-loopback-fake-engine');
      expect(http.taskStoreDiagnostics).toBe('capture');
      expect(http.connectionReuse).toBe('single-session');
      expect(http.sessionCount).toBe(1);
      expect(http.listToolsBeforeWarmup).toBe(true);
      expect(http.network).toBe(false);
      expect(http.liveProviderClaim).toBe(false);
      expect(http.syntheticMetrics).toBe(false);
      expect(http.promotion.providerWaitExcludedMs).toBe(0);
      expect(http.promotion.policyJitterIncluded).toBe(true);
      expect(http.promotion.thresholdMetric).toBe(
        'core_orchestration_ms_excluding_explicit_provider_wait_and_policy_jitter',
      );
      expect(http.providerWaitAccountingProbe).toMatchObject({
        requestedProviderWaitMs: 200,
        sidecarRecordCount: 1,
        passed: true,
      });
      expect(http.providerWaitAccountingProbe.rawElapsedMs).toBeGreaterThanOrEqual(http.providerWaitAccountingProbe.sidecarDurationMs);
      expect(http.providerWaitAccountingProbe.promotionElapsedMs).toBeCloseTo(
        http.providerWaitAccountingProbe.rawElapsedMs - http.providerWaitAccountingProbe.sidecarDurationMs,
        6,
      );

      const block = http.repetitions[0];
      expect(block.valid).toBe(true);
      expect(block.countConsistent).toBe(true);
      expect(block.counts).toEqual({
        cases: 12, eligible: 10, eligibleCompleted: 10,
        attempts: 22, submissions: 22, transitions: 10,
        terminalFailures: 2, duplicateSubmissions: 0,
      });
      expect(block.cases).toHaveLength(12);
      expect(new Set(block.cases.map((item: any) => item.taskId)).size).toBe(12);
      expect(block.rawPromotionValuesMs).toHaveLength(12);
      expect(block.thresholdPromotionValuesMs).toHaveLength(12);
      expect(block.thresholdP95Ms).toEqual(expect.any(Number));
      expect(block.policyJitterMs).toBeGreaterThan(0);
      expect(block.providerWaitExcludedMs).toBe(0);
      expect(block.operationCounts).toMatchObject({
        resilience_admit_frontier: 12,
        resilience_submit_attempt: 22,
        resilience_poll_observations: 22,
        resilience_transition_once: 10,
      });
      expect(block.operationCounts.resilience_record_observation ?? 0).toBe(0);
      expect(block.mcpCallTiming.byOperation.resilience_submit_attempt.serverHandlerP95Ms).toEqual(expect.any(Number));
      expect(block.mcpCallTiming.byOperation.resilience_submit_attempt.transportP95Ms).toEqual(expect.any(Number));
      expect(block.cases.every((item: any) => item.terminalState && item.reconciled)).toBe(true);
      expect(block.cases.every((item: any) => item.explicitProviderWaitMs === 0)).toBe(true);
      const assertPersistenceDiagnostics = (operation: any) => {
        const diagnostics = operation.persistenceDiagnostics;
        expect(Object.keys(diagnostics).sort()).toEqual([
          'recordCount', 'records', 'schemaVersion', 'store', 'truncatedCount',
        ]);
        expect(diagnostics.schemaVersion).toBe(1);
        expect(diagnostics.store).toBe('task_store');
        expect(diagnostics.recordCount).toBe(diagnostics.records.length);
        expect(diagnostics.truncatedCount).toBe(0);
        expect(diagnostics.records.every((record: any) => Object.keys(record).sort().join(',') === 'durationMs,operation')).toBe(true);
        expect(diagnostics.records.every((record: any) =>
          ['create', 'emit', 'complete', 'finish_observation', 'fail', 'state_of', 'status'].includes(record.operation) &&
          Number.isFinite(record.durationMs) && record.durationMs >= 0,
        )).toBe(true);
        expect(diagnostics.records.reduce((sum: number, record: any) => sum + record.durationMs, 0))
          .toBeLessThanOrEqual(operation.serverHandlerMs + 1e-9);
        expect(JSON.stringify(diagnostics)).not.toMatch(/__phase1PersistenceDiagnostics|taskId|attemptId|sequence|payload|sql|path|error|env/i);
        if (operation.name === 'resilience_admit_frontier') expect(diagnostics.records).toEqual([]);
        if (operation.name === 'resilience_submit_attempt') {
          // Provider execution is scheduled after submit returns, matching
          // production. The submit handler owns only task creation; event and
          // terminal writes are intentionally not attributed to this window.
          expect(diagnostics.records.map((record: any) => record.operation)).toEqual(['create']);
        }
        if (operation.name === 'resilience_poll_observations' || operation.name === 'resilience_transition_once') {
          expect(diagnostics.records.map((record: any) => record.operation)).toEqual(['status']);
        }
      };
      for (const item of [...http.warmup, ...block.cases]) {
        expect(item.mcpOperations.length).toBeGreaterThan(0);
        for (const operation of item.mcpOperations) assertPersistenceDiagnostics(operation);
      }
      for (const item of block.cases) {
        expect(item.promotionElapsedMs).toBeCloseTo(
          item.rawElapsedMs - item.explicitProviderWaitMs, 6,
        );
        expect(item.thresholdElapsedMs).toBeCloseTo(
          item.promotionElapsedMs - item.policyJitterMs, 6,
        );
      }

      const transitionOperations = block.cases.flatMap((item: any) =>
        item.mcpOperations.filter((operation: any) => operation.name === 'resilience_transition_once'));
      expect(transitionOperations).toHaveLength(10);
      for (const operation of transitionOperations) {
        expect(operation.serverHandlerMs).toEqual(expect.any(Number));
        expect(operation.transportMs).toEqual(expect.any(Number));
        const diagnostics = operation.boundaryDiagnostics;
        expect(diagnostics).toMatchObject({ schemaVersion: 1, correlation: 'exact' });
        expect(diagnostics.record.outcome).toBe('committed');
        expect(Object.keys(diagnostics.record.boundaryMs).sort()).toEqual([
          'beginImmediateMs', 'closeMs', 'commitMs', 'openMs', 'pragmaMs', 'statementWorkMs', 'transactionMs',
        ]);
        for (const value of Object.values(diagnostics.record.boundaryMs)) {
          expect(value).toEqual(expect.any(Number));
          expect(Number.isFinite(value as number)).toBe(true);
          expect(value as number).toBeGreaterThanOrEqual(0);
        }
        expect(Object.keys(diagnostics.record.maintenanceBefore).sort()).toEqual([
          'maintenanceNeeded', 'writesSinceCheckpoint',
        ]);
        expect(Object.keys(diagnostics.record.maintenanceAfter).sort()).toEqual([
          'maintenanceNeeded', 'writesSinceCheckpoint',
        ]);
        const serialized = JSON.stringify(diagnostics);
        expect(serialized).not.toMatch(/task|attempt|provider|plan|database|sql|prompt|exception|reason|environment|timestamp/i);
      }

      const stdio = await runBench(['--transport=stdio', '--runs', '12'], stdioReportPath);
      expect(stdio.transport).toBe('stdio');
      expect(stdio.connectionReuse).toBe('single-process-per-call-event-loop');
      expect(stdio.promotionEligible).toBe(false);
      expect(stdio.orchestrationP95MsExcludingProviderWait).toEqual(expect.any(Number));
      expect(stdio.legacyStdioDiagnostic.promotionEligible).toBe(false);
      expect(stdio.legacyStdioDiagnostic.reason).toBe('transport_not_production_equivalent');
      expect(stdio.legacyStdioDiagnostic.p95Ms).toEqual(stdio.orchestrationP95MsExcludingProviderWait);

      const recomputedP95 = [...block.rawPromotionValuesMs].sort((a: number, b: number) => a - b)[Math.ceil(block.rawPromotionValuesMs.length * 0.95) - 1];
      expect(recomputedP95).toBe(block.p95Ms);
      expect(block.rawPromotionValuesMs.every((value: number) => Number.isFinite(value) && value >= 0)).toBe(true);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }, 240_000);

  it('keeps off and record modes snapshot-free while preserving the benchmark cases', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'torqclaw-phase1-diagnostic-modes-test-'));
    try {
      for (const mode of ['off', 'record']) {
        const reportPath = join(outputRoot, `${mode}.json`);
        const report = await runBench([
          '--transport=http', '--runs', '1', '--warmup', '0', '--repetitions', '1', '--host-control=record',
          `--task-store-diagnostics=${mode}`,
        ], reportPath);
        expect(report.taskStoreDiagnostics).toBe(mode);
        expect(report.repetitions[0].valid).toBe(true);
        expect(report.repetitions[0].countConsistent).toBe(true);
        for (const item of report.repetitions[0].cases) {
          for (const operation of item.mcpOperations) {
            expect(operation.persistenceDiagnostics).toBeNull();
          }
        }
      }
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }, 240_000);

  it('rejects missing, malformed, negative, unsupported, and truncated diagnostics', async () => {
    const selfTest = await runDiagnosticsSelfTest();
    expect(selfTest.cases).toEqual({
      missing: 'missing',
      malformedCount: 'malformed',
      malformedDuration: 'malformed',
      malformedOperation: 'malformed',
      truncated: 'truncated',
      zeroRecord: {
        valid: true,
        value: { schemaVersion: 1, store: 'task_store', records: [], recordCount: 0, truncatedCount: 0 },
      },
    });
    expect(selfTest.valid).toEqual({
      schemaVersion: 1,
      store: 'task_store',
      records: [{ operation: 'emit', durationMs: 1.25 }],
      recordCount: 1,
      truncatedCount: 0,
    });
  });

  it('invalidates a report when the real task-store diagnostic buffer rolls over', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'torqclaw-phase1-rollover-test-'));
    const reportPath = join(outputRoot, 'rollover.json');
    try {
      const result = await runBenchExpectingFailure([
        '--transport=http', '--runs', '1', '--warmup', '260', '--repetitions', '1', '--host-control=record',
        '--task-store-diagnostics=capture', '--task-store-diagnostics-capacity=128',
      ], reportPath);
      expect(result.code).not.toBe(0);
      expect(result.report.ok).toBe(false);
      expect(result.report.promotionEligible).toBe(false);
      expect(result.report.fatalReasons).toContain('persistence_diagnostics_truncated');
      expect(result.report.warmup.some((item: any) => item.mcpOperations.some((operation: any) =>
        operation.persistenceDiagnostics?.truncatedCount > 0 || operation.persistenceDiagnostics === undefined,
      ))).toBe(true);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }, 240_000);

  it('keeps persistence diagnostics bounded, redacted, correlated, and non-authoritative', async () => {
    const probe = await runPersistenceDiagnosticsProbe();
    expect(probe.ledgerSchemaKeys).toEqual([
      'available', 'capacity', 'droppedCount', 'droppedRecords', 'firstAvailableSequence', 'firstSequence',
      'lastSequence', 'records', 'schemaVersion', 'store',
    ]);
    expect(probe.ledgerRecordKeys).toEqual([
      'boundaryMs', 'maintenanceAfter', 'maintenanceBefore', 'operation', 'outcome', 'sequence',
    ]);
    expect(probe.ledgerStore).toBe('attempt_ledger');
    expect(probe.ledgerOperation).toBe('fused_retryable_transition');
    expect(probe.ledgerCorrelation).toBe('exact');
    expect(probe.ledgerDropCount).toBe(0);
    expect(probe.ledgerFirstSequence).toBe(probe.ledgerLastSequence);
    expect(probe.ledgerPhaseNames).toEqual([
      'beginImmediateMs', 'closeMs', 'commitMs', 'openMs', 'pragmaMs', 'statementWorkMs', 'transactionMs',
    ]);
    expect(probe.ledgerDurationsFinite).toBe(true);
    expect(probe.redacted).toBe(true);
    expect(probe.functionalResultEquivalent).toBe(true);
    expect(probe.functionalStatusEquivalent).toBe(true);
    expect(probe.ledgerDiagnosticDisabledSequenceUnchanged).toBe(true);
    expect(probe.taskDiagnosticDisabledSequenceUnchanged).toBe(true);
    expect(probe.recorderFailurePreservedException).toBe(true);
    expect(probe.recorderFailurePreservedTaskResult).toBe(true);
    expect(probe.taskStoreSchemaKeys).toEqual([
      'available', 'capacity', 'droppedCount', 'firstSequence', 'lastSequence', 'records', 'schemaVersion', 'store',
    ]);
    expect(probe.taskStoreDropCountBeforeCap).toBe(0);
    expect(probe.taskStoreDropCountAfterCap).toBeGreaterThan(0);
    expect(probe.taskStoreFinite).toBe(true);
    expect(probe.taskStoreAllowed).toBe(true);
  });

  it('captures the bounded ledger packet with exact five-operation correlation', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'torqclaw-phase1-ledger-schema-test-'));
    const reportPath = join(outputRoot, 'ledger.json');
    try {
      const report = await runBench([
        '--transport=http', '--runs', '1', '--warmup', '0', '--repetitions', '1', '--host-control=record',
        '--ledger-diagnostics=capture',
      ], reportPath);
      const diagnostics = report.ledgerDiagnostics;
      expect(diagnostics).toMatchObject({
        enabled: true,
        exactCollected: true,
        incomplete: false,
        noAttributionCondition: false,
        duplicates: 0,
      });
      expect(diagnostics.reconciliation.collected).toBe(diagnostics.reconciliation.expected);
      expect(diagnostics.reconciliation.sidecar).toBe(diagnostics.reconciliation.expected);
      expect(diagnostics.reconciliation.issues).toEqual([]);
      expect(Object.keys(diagnostics.byOperation).sort()).toEqual([
        'admit_frontier', 'page_outbox', 'poll_observations', 'submit_attempt', 'transition_once',
      ]);
      expect(report.pageOutboxProbe.name).toBe('resilience_page_outbox');
      expect(report.repetitions[0].operationCounts.resilience_page_outbox ?? 0).toBe(0);
      expect(report.repetitions[0].valid).toBe(true);
      expect(report.ok).toBe(true);

      const caseOperations = report.repetitions[0].cases.flatMap((item: any) => item.mcpOperations);
      const records = caseOperations.map((operation: any) => operation.ledgerTimingDiagnostics).filter(Boolean);
      expect(records.length + 1).toBe(diagnostics.collectedCount);
      for (const record of records) {
        expect(Object.keys(record).sort()).toEqual([
          'authoritative', 'correlation', 'operation', 'outcome', 'schemaVersion', 'source', 'sqliteMs',
        ]);
        expect(record.schemaVersion).toBe(1);
        expect(record.authoritative).toBe(false);
        expect(record.source).toBe('fixture_only');
        expect(record.correlation).toBe('exact');
        expect(['admit_frontier', 'submit_attempt', 'poll_observations', 'transition_once', 'page_outbox']).toContain(record.operation);
        expect(['completed', 'rejected', 'duplicate', 'error']).toContain(record.outcome);
        expect(Object.keys(record.sqliteMs).sort()).toEqual([
          'beginImmediateMs', 'closeMs', 'commitMs', 'openMs', 'pragmaMs', 'statementWorkMs', 'totalMs',
        ]);
        for (const value of Object.values(record.sqliteMs)) {
          expect(value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)).toBe(true);
        }
        expect(JSON.stringify(record)).not.toMatch(/taskId|attemptId|payload|["']sql["']|path|env|credential|exception/i);
      }
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }, 240_000);
});
