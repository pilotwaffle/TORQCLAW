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

function seed(dataDir: string, pepper: Buffer) {
  const path = join(dataDir, 'collab.db');
  const db = new Database(path);
  runCollaborationMigration(db);
  const a = randomUUID();
  const b = randomUUID();
  const ca = randomUUID();
  const cb = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'A', NULL, 'active', 1, NULL, ?, ?)").run(a, now, now);
  db.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'B', ?, 'active', 1, NULL, ?, ?)").run(b, a, now, now);
  const issuedA = issueCredential(ca, pepper, nodeRandomSource);
  const issuedB = issueCredential(cb, pepper, nodeRandomSource);
  db.prepare("INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)").run(ca, a, issuedA.secretHmac, now);
  db.prepare("INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)").run(cb, b, issuedB.secretHmac, now);
  issuedA.secretBytes.fill(0);
  issuedB.secretBytes.fill(0);
  db.close();
  return { path, issuedA, issuedB };
}

describe('C0.1 built artifact boot and rollback proofs', () => {
  it('without the preload, the production binary ignores TORQCLAW_COLLAB_TEST_PEPPER and fails closed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c01-no-preload-'));
    const pepper = Buffer.alloc(32, 0x11);
    const seeded = seed(dataDir, pepper);
    gateway = await launchGateway({ TORQCLAW_DATA_DIR: dataDir, TORQCLAW_COLLAB_DB_PATH: seeded.path, TORQCLAW_COLLAB_ENABLED: '1', TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'), TORQCLAW_GATEWAY_TOKEN: 'unused' }, false);
    await gateway.ready;
    const result = await connectAndCollect(gateway.url, { role: 'operator', token: 'x', clientInfo: { name: 'no-preload', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedA.token } });
    expect(result.rawMessages).toEqual(['{"type":"ERROR","code":"AUTH_FAILED"}']);
    expect(result.close).toEqual({ code: 4001, reason: 'auth failed' });
  }, 45000);

  it('proves AC8: invalid root, invalid surface, and valid B cross-resume have identical wire failures', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c01-ac8-'));
    const pepper = Buffer.alloc(32, 0x33);
    const seeded = seed(dataDir, pepper);
    gateway = await launchGateway({ TORQCLAW_DATA_DIR: dataDir, TORQCLAW_COLLAB_DB_PATH: seeded.path, TORQCLAW_COLLAB_ENABLED: '1', TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'), TORQCLAW_GATEWAY_TOKEN: 'root-token' });
    await gateway.ready;
    const created = await connectAndCollect(gateway.url, { role: 'operator', token: 'root-token', clientInfo: { name: 'ac8-A', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedA.token } });
    const sessionId = lastFrame(created).metadata.sessionId;
    await closeWire(created);
    const attempts = await Promise.all([
      connectAndCollect(gateway.url, { role: 'operator', token: 'bad-root', sessionId, clientInfo: { name: 'ac8-root', version: '0.1.0' } }),
      connectAndCollect(gateway.url, { role: 'operator', token: 'root-token', sessionId, clientInfo: { name: 'ac8-surface', version: '0.1.0' }, auth: { kind: 'surface', credential: 'invalid-surface' } }),
      connectAndCollect(gateway.url, { role: 'operator', token: 'root-token', sessionId, clientInfo: { name: 'ac8-B', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedB.token } }),
    ]);
    const triples = attempts.map((attempt) => ({ rawErrorJson: attempt.rawMessages, close: attempt.close }));
    expect(triples[1]).toEqual(triples[0]);
    expect(triples[2]).toEqual(triples[0]);
    expect(triples[0]).toEqual({ rawErrorJson: ['{"type":"ERROR","code":"AUTH_FAILED"}'], close: { code: 4001, reason: 'auth failed' } });
    for (const attempt of attempts) { expect(attempt.frames.some((frame) => frame.type === 'CONNECTED')).toBe(false); await closeWire(attempt); }
    console.log(`AC8_RAW_WIRE_TRIPLES ${JSON.stringify(triples)}`);
  }, 45000);

  it('proves AC9 rollback: bound session stranded when the flag is turned off, legacy unbound remains compatible', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c01-ac9-'));
    const pepper = Buffer.alloc(32, 0x44);
    const seeded = seed(dataDir, pepper);
    gateway = await launchGateway({ TORQCLAW_DATA_DIR: dataDir, TORQCLAW_COLLAB_DB_PATH: seeded.path, TORQCLAW_COLLAB_ENABLED: '1', TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'), TORQCLAW_GATEWAY_TOKEN: '' });
    await gateway.ready;
    const bound = await connectAndCollect(gateway.url, { role: 'operator', token: 'x', clientInfo: { name: 'ac9-bound', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedA.token } });
    const boundSessionId = lastFrame(bound).metadata.sessionId;
    await closeWire(bound);
    await gateway.stop();
    gateway = await launchGateway({ TORQCLAW_DATA_DIR: dataDir, TORQCLAW_COLLAB_DB_PATH: seeded.path, TORQCLAW_COLLAB_ENABLED: '0', TORQCLAW_GATEWAY_TOKEN: '' }, false);
    await gateway.ready;
    const stranded = await connectAndCollect(gateway.url, { role: 'operator', token: 'anything', sessionId: boundSessionId, clientInfo: { name: 'ac9-legacy-client', version: '0.1.0' } });
    expect(stranded.rawMessages).toEqual(['{"type":"ERROR","code":"AUTH_FAILED"}']);
    expect(stranded.close).toEqual({ code: 4001, reason: 'auth failed' });
    const legacyCreated = await connectAndCollect(gateway.url, { role: 'operator', token: 'anything', clientInfo: { name: 'legacy-compatible', version: '0.1.0' } });
    const legacySessionId = lastFrame(legacyCreated).metadata.sessionId;
    await closeWire(legacyCreated);
    const legacyResumed = await connectAndCollect(gateway.url, { role: 'operator', token: 'anything', sessionId: legacySessionId, clientInfo: { name: 'legacy-compatible', version: '0.1.0' } });
    expect(lastFrame(legacyResumed)).toMatchObject({ type: 'CONNECTED', metadata: { resumed: true, sessionId: legacySessionId } });
    await closeWire(legacyResumed);
    // Legacy unbound sessions remain compatible; bound sessions may be stranded by rollback.
  }, 60000);
});
