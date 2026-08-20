/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S5 — Live push and the missing departure
 * signal, exercised through the REAL built gateway over real websockets.
 *
 * A5-a: an operator who opened a channel (GET_CHANNEL_TIMELINE, which is the
 *       production subscription point) receives a seq-less collabMessagePosted
 *       invalidation hint when an agent co-member commits a message -- with no
 *       second operator read.
 * A5-c: after that operator socket closes, a later agent post does not throw
 *       into or terminate the gateway; the durable store still has the event
 *       and a fresh operator read recovers it.
 *
 * Registry-state A5-b is pinned directly in
 * tests/collab/subscription-session-close.test.ts (injected registry:
 * forSession(owner) is empty after closeSubscriptionsForSession).
 *
 * NO DELIVERY GUARANTEE: the live frame proven here is an invalidation hint,
 * not a delivery promise. §19 real-socket backpressure remains owed.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
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
  agentId: string;
  issuedAgent: ReturnType<typeof issueCredential>;
  channelId: string;
};

function seedDb(dataDir: string, pepper: Buffer): Seeded {
  const collabDbPath = join(dataDir, 'collab.db');
  const db = new Database(collabDbPath);
  runCollaborationMigration(db);
  const operatorId = randomUUID();
  const agentId = randomUUID();
  const credOperator = randomUUID();
  const credAgent = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(operatorId, now, now);
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'Ag', ?, 'active', 1, NULL, ?, ?)",
  ).run(agentId, operatorId, now, now);

  const issuedOperator = issueCredential(credOperator, pepper, nodeRandomSource);
  const issuedAgent = issueCredential(credAgent, pepper, nodeRandomSource);
  for (const [id, principal, issued] of [
    [credOperator, operatorId, issuedOperator],
    [credAgent, agentId, issuedAgent],
  ] as const) {
    db.prepare(
      "INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)",
    ).run(id, principal, issued.secretHmac, now);
  }

  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'S5Live', 's5live', 'active', ?, 1, ?, ?)",
  ).run(channelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, operatorId, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
  ).run(channelId, agentId, now);

  issuedOperator.secretBytes.fill(0);
  issuedAgent.secretBytes.fill(0);
  db.close();
  return { collabDbPath, operatorId, issuedOperator, agentId, issuedAgent, channelId };
}

const BASE_ENV = (dataDir: string, seeded: Seeded, pepper: Buffer) => ({
  TORQCLAW_DATA_DIR: dataDir,
  TORQCLAW_COLLAB_DB_PATH: seeded.collabDbPath,
  TORQCLAW_COLLAB_ENABLED: '1',
  TORQCLAW_COLLAB_SURFACE_COMMANDS: '1',
  TORQCLAW_AGENT_PARTICIPATION: '1',
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

function messageCount(collabDbPath: string, channelId: string): number {
  const db = new Database(collabDbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM collab_events WHERE channel_id = ? AND kind = 'message_posted'")
      .get(channelId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S5 — live push + departure', () => {
  it('A5-a: a subscribed co-member socket receives a collabMessagePosted hint for an agent commit without a manual refresh', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s5-a5a-'));
    const pepper = Buffer.alloc(32, 0x5a);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway(BASE_ENV(dataDir, seeded, pepper));
    await gateway.ready;

    const operator = await openWire(gateway.url, {
      expectedRole: 'operator',
      clientInfo: { name: 's5-operator', version: '0.1.0' },
      auth: { kind: 'surface', credential: seeded.issuedOperator.token },
    });
    operator.send({ action: 'GET_CHANNEL_TIMELINE', channelId: seeded.channelId, cursor: '0', limit: 50 });
    await operator.waitFor((frame) => frame?.metadata?.collabTimeline === true && frame?.metadata?.channelId === seeded.channelId);

    const agent = await openWire(gateway.url, {
      expectedRole: 'node',
      clientInfo: { name: 's5-agent', version: '0.1.0' },
      auth: { kind: 'surface', credential: seeded.issuedAgent.token },
    });
    const text = 's5 live push ' + randomUUID();
    agent.send({ action: 'POST_CHANNEL_MESSAGE', channelId: seeded.channelId, text, idempotencyKey: randomUUID() });
    const agentAck = await agent.waitFor((frame) => frame?.metadata?.collabMessagePosted === true && frame?.metadata?.channelId === seeded.channelId);
    expect(agentAck?.metadata?.eventId).toEqual(expect.any(String));

    // The load-bearing assertion: THIS frame arrives on the operator socket
    // without the operator sending another GET_CHANNEL_TIMELINE.
    const hint = await operator.waitFor(
      (frame) => frame?.metadata?.collabMessagePosted === true &&
        frame?.metadata?.channelId === seeded.channelId &&
        frame?.metadata?.eventId === agentAck.metadata.eventId,
    );
    expect(hint?.type).toBe('SYSTEM');
    expect(hint?.seq, 'publishOnly hints must stay seq-less and non-persisted').toBeUndefined();

    await agent.close();
    await operator.close();
  }, 30000);

  it('A5-c: fan-out after the subscribed socket closed does not throw into or terminate the gateway; store truth is recovered by a fresh read', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s5-a5c-'));
    const pepper = Buffer.alloc(32, 0x5c);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway(BASE_ENV(dataDir, seeded, pepper));
    await gateway.ready;

    const operator = await openWire(gateway.url, {
      expectedRole: 'operator',
      clientInfo: { name: 's5-operator-close', version: '0.1.0' },
      auth: { kind: 'surface', credential: seeded.issuedOperator.token },
    });
    operator.send({ action: 'GET_CHANNEL_TIMELINE', channelId: seeded.channelId, cursor: '0', limit: 50 });
    await operator.waitFor((frame) => frame?.metadata?.collabTimeline === true && frame?.metadata?.channelId === seeded.channelId);
    await operator.close();
    await sleep(150); // let the close-path deregistration run before the post

    const agent = await openWire(gateway.url, {
      expectedRole: 'node',
      clientInfo: { name: 's5-agent-close', version: '0.1.0' },
      auth: { kind: 'surface', credential: seeded.issuedAgent.token },
    });
    const before = messageCount(seeded.collabDbPath, seeded.channelId);
    agent.send({ action: 'POST_CHANNEL_MESSAGE', channelId: seeded.channelId, text: 'after close ' + randomUUID(), idempotencyKey: randomUUID() });
    const agentAck = await agent.waitFor((frame) => frame?.metadata?.collabMessagePosted === true && frame?.metadata?.channelId === seeded.channelId);
    expect(agentAck?.metadata?.eventId).toEqual(expect.any(String));
    expect(agent.frames.find((frame) => frame?.type === 'ERROR'), 'agent post after subscriber close must not fail').toBeUndefined();
    expect(messageCount(seeded.collabDbPath, seeded.channelId)).toBe(before + 1);
    expect(gateway.child.exitCode, 'gateway process must still be alive after fan-out past a closed socket').toBeNull();

    const freshOperator = await openWire(gateway.url, {
      expectedRole: 'operator',
      clientInfo: { name: 's5-operator-fresh', version: '0.1.0' },
      auth: { kind: 'surface', credential: seeded.issuedOperator.token },
    });
    freshOperator.send({ action: 'GET_CHANNEL_TIMELINE', channelId: seeded.channelId, cursor: '0', limit: 50 });
    const timeline = await freshOperator.waitFor((frame) => frame?.metadata?.collabTimeline === true && frame?.metadata?.channelId === seeded.channelId);
    const texts = (timeline.metadata.events as Array<{ payload?: { text?: unknown } }>).map((event) => event.payload?.text);
    expect(texts.some((value) => typeof value === 'string' && value.startsWith('after close '))).toBe(true);

    await agent.close();
    await freshOperator.close();
  }, 30000);

  it('S5 structural: a socket closing DURING subscribe cannot leak the registration, and concurrent reads cannot duplicate it', () => {
    // Source-level pin for the review finding: the close path must key on
    // "a subscription was ATTEMPTED" (collabLiveAttempted), not on the map
    // that onRegistered only fills after subscribeChannel resolves; and
    // onRegistered must re-check socketClosed after the await.
    const src = readFileSync(
      fileURLToPath(new URL('../packages/gateway/src/server.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('let socketClosed = false;');
    expect(src).toContain('let collabLiveAttempted = false;');
    expect(src).toContain('const collabLiveInFlight = new Set<string>();');
    expect(src).toContain('!collabLiveInFlight.has(timelineChannelId)');

    const closeIdx = src.indexOf("socket.on('close'");
    expect(closeIdx).toBeGreaterThan(-1);
    expect(src.indexOf('socketClosed = true;', closeIdx)).toBeGreaterThan(closeIdx);
    expect(src.indexOf('closeCollabLiveSubscriptions();', closeIdx)).toBeGreaterThan(closeIdx);

    const onRegisteredIdx = src.indexOf('onRegistered: (subscriptionId: string) =>');
    expect(onRegisteredIdx).toBeGreaterThan(-1);
    expect(src.indexOf('if (socketClosed)', onRegisteredIdx)).toBeGreaterThan(onRegisteredIdx);
  });
});
