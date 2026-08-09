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

describe('C0.1 H-1 - client identity is ignored', () => {
  it('binds a raw frame claiming A to the verified credential principal B', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-h1-'));
    const path = join(dataDir, 'collab.db');
    const db = new Database(path);
    runCollaborationMigration(db);
    const a = randomUUID();
    const b = randomUUID();
    const ca = randomUUID();
    const cb = randomUUID();
    const pepper = Buffer.alloc(32, 0x42);
    const now = new Date().toISOString();
    for (const [id, kind, owner] of [[a, 'operator', null], [b, 'agent', a]] as const) {
      db.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 1, NULL, ?, ?)").run(id, kind, id, owner, now, now);
    }
    const issuedA = issueCredential(ca, pepper, nodeRandomSource);
    const issuedB = issueCredential(cb, pepper, nodeRandomSource);
    db.prepare("INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)").run(ca, a, issuedA.secretHmac, now);
    db.prepare("INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)").run(cb, b, issuedB.secretHmac, now);
    issuedA.secretBytes.fill(0);
    issuedB.secretBytes.fill(0);
    db.close();

    gateway = await launchGateway({ TORQCLAW_DATA_DIR: dataDir, TORQCLAW_COLLAB_DB_PATH: path, TORQCLAW_COLLAB_ENABLED: '1', TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'), TORQCLAW_GATEWAY_TOKEN: 'unused' });
    await gateway.ready;
    const created = await connectAndCollect(gateway.url, { role: 'operator', token: 'x', clientInfo: { name: 'h1-A', version: '0.1.0' }, auth: { kind: 'surface', credential: issuedA.token } });
    const sessionId = lastFrame(created).metadata.sessionId;
    await closeWire(created);
    const attempt = await connectAndCollect(gateway.url, { role: 'operator', token: 'x', sessionId, clientInfo: { name: 'h1-B-claiming-A', version: '0.1.0' }, auth: { kind: 'surface', credential: issuedB.token }, principalId: a, surfaceId: ca });
    expect(attempt.rawMessages).toEqual(['{"type":"ERROR","code":"AUTH_FAILED"}']);
    expect(attempt.close).toEqual({ code: 4001, reason: 'auth failed' });
    expect(attempt.frames.some((frame) => frame.type === 'CONNECTED')).toBe(false);
  }, 45000);
});
