import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-preview-reason-'));
process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
const { db } = await import('../packages/gateway/src/storage.js');
const { handlePreviewRoute } = await import('../packages/gateway/src/preview.js');
const { sessionBus } = await import('../packages/gateway/src/events.js');

it('preview_frame_carries_classifier_method_reason_latency', async () => {
  const sid = randomUUID();
  db.prepare("INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')").run(sid);
  const snapshot = () => ['events', 'tasks', 'tool_approvals', 'spend_ledger', 'run_receipts']
    .map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  const frames: any[] = [];
  const unsubscribe = sessionBus.subscribe(sid, (frame) => frames.push(frame));
  try {
    await handlePreviewRoute(sid, {
      action: 'PREVIEW_ROUTE', previewOf: 'n1', prompt: 'summarize this text',
      sensitive: false, urgent: false, executionMode: 'AUTO', useMemory: true,
    });
  } finally { unsubscribe(); }
  expect(frames).toHaveLength(1);
  const meta = frames[0].metadata;
  expect(meta.classifierFallbackReason).toBe('unreachable');
  expect(meta.enrichment.classifierUsed).toBe('KEYWORD_FALLBACK');
  expect(Number.isFinite(meta.enrichment.classifierLatencyMs)).toBe(true);
  expect(meta.enrichment.classifierLatencyMs).toBeGreaterThanOrEqual(0);
  expect(meta).not.toHaveProperty('assembledContext');
  expect(meta).not.toHaveProperty('payload');
  expect(meta.enrichment).not.toHaveProperty('fallbackReason');
  expect(snapshot()).toEqual(before);
});
