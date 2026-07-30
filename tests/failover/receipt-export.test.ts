import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

let buildSafeExport: typeof import('../../packages/gateway/src/export.js').buildSafeExport;
let FAILOVER_EXPORT_VERSION: typeof import('../../packages/gateway/src/export.js').FAILOVER_EXPORT_VERSION;
let REDACTOR_VERSION: typeof import('../../packages/gateway/src/export.js').REDACTOR_VERSION;
let root = '';
let closeDb: (() => void) | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'torqclaw-export-'));
  process.env.TORQCLAW_DATA_DIR = root;
  const exported = await import('../../packages/gateway/src/export.js');
  const storage = await import('../../packages/gateway/src/storage.js');
  closeDb = () => storage.db.close();
  buildSafeExport = exported.buildSafeExport;
  FAILOVER_EXPORT_VERSION = exported.FAILOVER_EXPORT_VERSION;
  REDACTOR_VERSION = exported.REDACTOR_VERSION;
});

afterAll(() => {
  closeDb?.();
  rmSync(root, { recursive: true, force: true });
});

const receipt = {
  id: 'r', task_id: 't', session_id: 's', source_channel: 'test', selected_tier: 'API_EXTERNAL', route_diagnostics_json: null,
  budget_limit: null, budget_source: null, cost_usd: null, cost_enforceable: 0, elapsed_ms: null, iterations: null,
  tools_called_json: '[]', cancelled: 0, blocked_on: null, memory_used: null, context_chars: null, result_state: 'failed',
  safe_export_json: null, projection_version: 2, full_receipt_json: JSON.stringify({
    taskId: 't', sessionId: 's', failoverEnabled: true, finalProviderId: 'p2', terminalUncertainty: false,
    providerAttempts: [{ epoch: 0, attemptId: 'a0', providerId: 'p1', modelId: 'm1', startedAtMs: 1, endedAtMs: 2, normalizedFailure: { failureClass: 'retryable', code: 'connection' }, dispatchAttempted: false, transitionDecision: 'transitioned', terminalOutcome: 'failed', cost: { reservedMicroUsd: 1, actualMicroUsd: null, known: false, source: null } }],
  }), evidence_start_seq: null, evidence_end_seq: null,
} as never;

describe('receipt/export v2', () => {
  it('exports ordered normalized attempts and omits prompt/tool args/endpoints/errors', () => {
    const exported = buildSafeExport(receipt, [], REDACTOR_VERSION);
    expect(exported.exportVersion).toBe(FAILOVER_EXPORT_VERSION);
    expect(exported.providerAttempts).toHaveLength(1);
    const json = JSON.stringify(exported);
    expect(json).not.toContain('prompt');
    expect(json).not.toContain('toolArgs');
    expect(json).not.toContain('endpoint');
    expect(json).not.toContain('rawError');
  });
});
