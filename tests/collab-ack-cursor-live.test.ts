/**
 * PRD-TCLAW-COLLAB-PRESENCE-UI-005 S6 — A7, the live half: an acknowledged
 * channel cursor survives socket reconnect AND a full gateway restart, and
 * acking an older cursor never moves the stored cursor backwards -- exercised
 * through the REAL built gateway over real websockets, with the cursor read
 * back through the S1 LIST_CHANNELS surface (lastAcknowledgedCursor).
 *
 * Handler-level T-1/T-2/CURSOR_OUT_OF_RANGE coverage lives in
 * tests/collab-ack-channel-cursor.test.ts; this file exists because only a
 * real process restart proves durability across the gateway boundary.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { issueCredential, nodeRandomSource, runCollaborationMigration } from '../packages/collab/src/index.js';
import { ensureGatewayBuild, launchGateway, type GatewayHandle } from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

type Seeded = {
  collabDbPath: string;
  operatorId: string;
  issuedOperator: ReturnType<typeof issueCredential>;
  channelId: string;
};

function seedDb(dataDir: string, pepper: Buffer): Seeded {
  const collabDbPath = join(dataDir, 'collab.db');
  const db = new Database(collabDbPath);
  runCollaborationMigration(db);
  const operatorId = randomUUID();
  const credOperator = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(operatorId, now, now);

  const issuedOperator = issueCredential(credOperator, pepper, nodeRandomSource);
  db.prepare(
    "INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)",
  ).run(credOperator, operatorId, issuedOperator.secretHmac, now);

  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'S6Ack', 's6ack', 'active', ?, 1, ?, ?)",
  ).run(channelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, operatorId, now);

  issuedOperator.secretBytes.fill(0);
  db.close();
  return { collabDbPath, operatorId, issuedOperator, channelId };
}

const BASE_ENV = (dataDir: string, seeded: Seeded, pepper: Buffer) => ({
  TORQCLAW_DATA_DIR: dataDir,
  TORQCLAW_COLLAB_DB_PATH: seeded.collabDbPath,
  TORQCLAW_COLLAB_ENABLED: '1',
  TORQCLAW_COLLAB_SURFACE_COMMANDS: '1',
  TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'),
  TORQCLAW_GATEWAY_TOKEN: 'unused',
  TORQCLAW_CHANNEL_SERVICE_TOKEN: 'unused-cst',
});

type Wire = {
  ws: WebSocket;
  frames: any[];
  send: (frame: unknown) => void;
  waitFor: (pred: (frame: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: () => Promise<void>;
};

function openWire(url: string, connectFrame: unknown, timeoutMs = 10000): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: any[] = [];
    const listeners = new Set<(frame: any) => void>();
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* noop */ }
      reject(new Error('openWire timeout; frames=' + JSON.stringify(frames)));
    }, timeoutMs);

    const waitFor = (pred: (frame: any) => boolean, waitMs = 8000): Promise<any> => {
      const existing = frames.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveWait, rejectWait) => {
        const waitTimer = setTimeout(() => {
          listeners.delete(listener);
          rejectWait(new Error('waitFor timeout; frames=' + JSON.stringify(frames)));
        }, waitMs);
        const listener = (frame: any) => {
          if (!pred(frame)) return;
          clearTimeout(waitTimer);
          listeners.delete(listener);
          resolveWait(frame);
        };
        listeners.add(listener);
      });
    };

    ws.once('open', () => ws.send(JSON.stringify(connectFrame)));
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      for (const listener of Array.from(listeners)) listener(frame);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    waitFor((frame) => frame?.type === 'CONNECTED', timeoutMs)
      .then(() => {
        clearTimeout(timer);
        resolve({
          ws,
          frames,
          send: (frame: unknown) => ws.send(JSON.stringify(frame)),
          waitFor,
          close: async () => {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              const closed = new Promise<void>((resolveClose) => ws.once('close', () => resolveClose()));
              ws.close();
              await closed;
            }
          },
        });
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function lastAckedCursor(listFrame: any, channelId: string): string | undefined {
  const channels = listFrame?.metadata?.channels as Array<{ channelId: string; lastAcknowledgedCursor?: string }> | undefined;
  return channels?.find((c) => c.channelId === channelId)?.lastAcknowledgedCursor;
}

describe('PRD-TCLAW-COLLAB-PRESENCE-UI-005 S6 — A7: ack durability across reconnect and gateway restart', () => {
  it('an ack persists across reconnect and a full gateway restart, and an older ack never moves the cursor backwards', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s6-a7-'));
    const pepper = Buffer.alloc(32, 0xa7);
    const seeded = seedDb(dataDir, pepper);
    const env = BASE_ENV(dataDir, seeded, pepper);
    const connectFrame = {
      expectedRole: 'operator',
      clientInfo: { name: 's6-operator', version: '0.1.0' },
      auth: { kind: 'surface', credential: seeded.issuedOperator.token },
    };

    gateway = await launchGateway(env);
    await gateway.ready;

    const operator = await openWire(gateway.url, connectFrame);

    // Commit one message so there is a real cursor to acknowledge (@1).
    operator.send({ action: 'POST_CHANNEL_MESSAGE', channelId: seeded.channelId, text: 's6 ack target ' + randomUUID(), idempotencyKey: randomUUID() });
    const posted = await operator.waitFor((frame) => frame?.metadata?.collabMessagePosted === true && frame?.metadata?.channelId === seeded.channelId);
    const cursor = posted.metadata.cursor as string;
    expect(cursor).toBe('1');

    // Ack it.
    operator.send({ action: 'ACK_CHANNEL_CURSOR', channelId: seeded.channelId, cursor });
    const acked = await operator.waitFor((frame) => frame?.metadata?.collabCursorAcked === true && frame?.metadata?.channelId === seeded.channelId);
    expect(acked?.type).toBe('SYSTEM');
    expect(acked?.metadata?.acknowledgedCursor).toBe('1');

    // Monotonic over the wire: acking an OLDER cursor is a no-op (L2).
    operator.send({ action: 'ACK_CHANNEL_CURSOR', channelId: seeded.channelId, cursor: '0' });
    const ackedOlder = await operator.waitFor(
      (frame) => frame?.metadata?.collabCursorAcked === true && frame?.metadata?.channelId === seeded.channelId && frame !== acked,
    );
    expect(ackedOlder?.metadata?.acknowledgedCursor).toBe('1');

    // Visible through the S1 read surface.
    operator.send({ action: 'LIST_CHANNELS', limit: 20 });
    const listed = await operator.waitFor((frame) => frame?.metadata?.collabChannels === true);
    expect(lastAckedCursor(listed, seeded.channelId)).toBe('1');

    // Reconnect: a fresh socket on the SAME gateway still sees the ack.
    await operator.close();
    const reconnected = await openWire(gateway.url, connectFrame);
    reconnected.send({ action: 'LIST_CHANNELS', limit: 20 });
    const listedAfterReconnect = await reconnected.waitFor((frame) => frame?.metadata?.collabChannels === true);
    expect(lastAckedCursor(listedAfterReconnect, seeded.channelId)).toBe('1');
    await reconnected.close();

    // Full gateway RESTART: new process, same data dir -- the ack survives.
    await gateway.stop();
    gateway = null;
    gateway = await launchGateway(env);
    await gateway.ready;

    const afterRestart = await openWire(gateway.url, connectFrame);
    afterRestart.send({ action: 'LIST_CHANNELS', limit: 20 });
    const listedAfterRestart = await afterRestart.waitFor((frame) => frame?.metadata?.collabChannels === true);
    expect(lastAckedCursor(listedAfterRestart, seeded.channelId)).toBe('1');
    await afterRestart.close();
  }, 60000);

  it('a connection with no resolved collab principal gets COLLAB_IDENTITY_REQUIRED over the wire (T-1 live)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s6-t1-'));
    const pepper = Buffer.alloc(32, 0x71);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway(BASE_ENV(dataDir, seeded, pepper));
    await gateway.ready;

    // Legacy root-token auth resolves no collab principal -> the handler's
    // T-1 refusal, not a substrate call.
    const legacy = await openWire(gateway.url, {
      expectedRole: 'operator',
      clientInfo: { name: 's6-legacy', version: '0.1.0' },
      token: 'unused',
    });
    legacy.send({ action: 'ACK_CHANNEL_CURSOR', channelId: seeded.channelId, cursor: '0' });
    const err = await legacy.waitFor((frame) => frame?.type === 'ERROR');
    expect(err?.code).toBe('COLLAB_IDENTITY_REQUIRED');
    await legacy.close();
  }, 30000);
});
