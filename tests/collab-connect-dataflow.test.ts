import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { issueCredential, nodeRandomSource, runCollaborationMigration } from '../packages/collab/src/index.js';
import { ensureGatewayBuild, launchGateway, connectAndCollect, closeWire, lastFrame, type GatewayHandle } from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

function seedBoundDatabase(dataDir: string, pepper: Buffer) {
  const collabDbPath = join(dataDir, 'collab.db');
  const db = new Database(collabDbPath);
  runCollaborationMigration(db);
  const principalA = randomUUID();
  const principalB = randomUUID();
  const credA = randomUUID();
  const credB = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'A', NULL, 'active', 1, NULL, ?, ?)").run(principalA, now, now);
  db.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'B', ?, 'active', 1, NULL, ?, ?)").run(principalB, principalA, now, now);
  const issuedA = issueCredential(credA, pepper, nodeRandomSource);
  const issuedB = issueCredential(credB, pepper, nodeRandomSource);
  for (const [id, principal, issued] of [[credA, principalA, issuedA], [credB, principalB, issuedB]] as const) {
    db.prepare("INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)").run(id, principal, issued.secretHmac, now);
  }
  issuedA.secretBytes.fill(0);
  issuedB.secretBytes.fill(0);
  db.close();
  return { collabDbPath, issuedA, issuedB };
}

describe('C0.1 connect data flow', () => {
  it('derives the binding from credentials and refuses B resuming A without fallback', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c01-dataflow-'));
    const pepper = Buffer.alloc(32, 0x22);
    const seeded = seedBoundDatabase(dataDir, pepper);
    gateway = await launchGateway({ TORQCLAW_DATA_DIR: dataDir, TORQCLAW_COLLAB_DB_PATH: seeded.collabDbPath, TORQCLAW_COLLAB_ENABLED: '1', TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'), TORQCLAW_GATEWAY_TOKEN: 'unused-in-this-test' });
    await gateway.ready;
    const created = await connectAndCollect(gateway.url, { role: 'operator', token: 'irrelevant', clientInfo: { name: 'dataflow-A', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedA.token } });
    expect(lastFrame(created).type).toBe('CONNECTED');
    const sessionId = lastFrame(created).metadata.sessionId;
    await closeWire(created);
    const cross = await connectAndCollect(gateway.url, { role: 'operator', token: 'irrelevant', sessionId, clientInfo: { name: 'dataflow-B', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedB.token } });
    expect(cross.rawMessages).toEqual(['{"type":"ERROR","code":"AUTH_FAILED"}']);
    expect(cross.close).toEqual({ code: 4001, reason: 'auth failed' });
    expect(cross.frames.some((frame) => frame.type === 'CONNECTED')).toBe(false);
    expect(cross.frames.some((frame) => frame.metadata?.sessionId && frame.metadata.sessionId !== sessionId)).toBe(false);
    const recovered = await connectAndCollect(gateway.url, { role: 'operator', token: 'irrelevant', sessionId, clientInfo: { name: 'dataflow-A-again', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedA.token } });
    expect(lastFrame(recovered)).toMatchObject({ type: 'CONNECTED', metadata: { resumed: true, sessionId } });
    await closeWire(recovered);
  }, 45000);
});
