import { beforeAll, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureGatewayBuild, launchGateway, connectAndCollect, closeWire } from './helpers/collab-gateway-harness.js';

beforeAll(async () => { await ensureGatewayBuild(); }, 200000);

it('submit_prompt_marks_user_prompt_sensitive_and_leaves_non_private_null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'torq-private-prompt-'));
  const gateway = await launchGateway({
    TORQCLAW_DATA_DIR: root,
    TORQCLAW_GATEWAY_TOKEN: 'root-token',
    TORQCLAW_COLLAB_ENABLED: 'false',
    TORQCLAW_COLLAB_TEST_PEPPER: Buffer.alloc(32, 7).toString('base64'),
    OLLAMA_BASE_URL: 'http://127.0.0.1:1',
    HERMES_ENGINE_URL: 'http://127.0.0.1:1/mcp',
  });
  let wire: Awaited<ReturnType<typeof connectAndCollect>> | undefined;
  let db: Database.Database | undefined;
  try {
    await gateway.ready;
    wire = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'root-token', clientInfo: { name: 'private-prompt-test', version: '1' },
    });
    expect(wire.frames.some((frame) => frame.sessionId)).toBe(true);
    db = new Database(join(root, 'state.db'), { readonly: true });
    for (const sensitive of [true, false]) {
      const prompt = sensitive ? 'private-user-prompt-marker' : 'public-user-prompt-marker';
      wire.ws.send(JSON.stringify({ action: 'SUBMIT_PROMPT', prompt, sensitive, executionMode: 'LOCAL_ONLY' }));
      await expect.poll(() => db!.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'USER_PROMPT' AND message = ?").get(prompt)).toEqual({ n: 1 });
    }
    expect.soft(db.prepare("SELECT json_extract(metadata, '$.sensitive') AS sensitive FROM events WHERE type = 'USER_PROMPT' AND message = ?").get('private-user-prompt-marker')).toEqual({ sensitive: 1 });
    expect(db.prepare("SELECT metadata FROM events WHERE type = 'USER_PROMPT' AND message = ?").get('public-user-prompt-marker')).toEqual({ metadata: null });
  } finally {
    db?.close();
    if (wire) await closeWire(wire);
    await gateway.stop();
  }
}, 30000);
