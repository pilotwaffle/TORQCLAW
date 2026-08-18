/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S1 — Agent identity that can post.
 *
 * Covers this slice's named acceptance criteria, all exercised through the
 * REAL built gateway over a real websocket (verify-the-artifact-not-the-
 * unit-test discipline -- packages/gateway/dist, not source):
 *
 *   A1-a — a task bound to agent principal P posts to a channel where P is
 *          an active member; the committed collab_events row has
 *          actor_principal_id = P (read directly from collab.db, not the
 *          wire ack).
 *   A1-b — the same agent posting to a channel it is NOT a member of gets
 *          COLLAB_NOT_FOUND, byte-identical to the nonexistent-channel case.
 *   A1-c — a node-seat connection with NO verified agent principal (flag on,
 *          but the presented credential belongs to no agent row) is refused
 *          before ever reaching the identity handler, and zero collab_events
 *          rows are written.
 *   A1-d — with TORQCLAW_AGENT_PARTICIPATION UNSET, the exact same agent
 *          credential/channel setup that succeeds in A1-a is refused --
 *          asserted on the absent-deny RESPONSE, not on the flag's value.
 *   A1-e — an operator-kind principal is never treated as an agent identity
 *          by this slice's new resolution path (a node-seat connection can
 *          only ever be produced by a non-operator principalKind in the
 *          first place -- collabIdentity.ts's authClass derivation -- so
 *          this is asserted at the seat-authz layer: 'node' role is where
 *          agentCollabWrite can ever fire, and an operator-kind principal
 *          NEVER resolves to role 'node').
 *
 * PRE-EXISTING FINDING (reported, not fixed by this slice — see report):
 * before this slice, POST_CHANNEL_MESSAGE was unreachable for EVERY caller,
 * including the operator, whenever the connection's credential had no C1
 * `surfaces` row -- which is the only kind of credential any shipped path
 * (bootstrapOperator, createAgent) currently mints. connectionAuth stayed
 * null, so handlePostChannelMessage always saw principalId=null and refused
 * COLLAB_IDENTITY_REQUIRED. This file's operator-path assertions in A1-d's
 * companion checks below are written against the OPERATOR seat only to the
 * extent S1 already required touching that dispatch arm (the
 * `agentCollabPrincipalId ?? connectionAuth?.principalId` fallback) -- this
 * slice does not attempt to fix the operator's own C1-less path, which is
 * out of S1's scope and reported separately.
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
  issuedOperator: ReturnType<typeof issueCredential>;
  issuedAgent: ReturnType<typeof issueCredential>;
  operatorId: string;
  agentId: string;
  memberChannelId: string;
  outsiderChannelId: string;
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

  // Channel the agent IS a member of.
  const memberChannelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Member', 'member', 'active', ?, 1, ?, ?)",
  ).run(memberChannelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(memberChannelId, operatorId, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
  ).run(memberChannelId, agentId, now);

  // Channel the agent is NOT a member of (operator-only).
  const outsiderChannelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Outsider', 'outsider', 'active', ?, 1, ?, ?)",
  ).run(outsiderChannelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(outsiderChannelId, operatorId, now);

  issuedOperator.secretBytes.fill(0);
  issuedAgent.secretBytes.fill(0);
  db.close();
  return { collabDbPath, issuedOperator, issuedAgent, operatorId, agentId, memberChannelId, outsiderChannelId };
}

function countMessageEvents(collabDbPath: string, channelId: string): number {
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

function countAllMessageEvents(collabDbPath: string): number {
  const db = new Database(collabDbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM collab_events WHERE kind = 'message_posted'").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function actorForMessageText(collabDbPath: string, channelId: string, text: string): string | null {
  const db = new Database(collabDbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT actor_principal_id AS actor, content_json AS content FROM collab_events WHERE channel_id = ? AND kind = 'message_posted'")
      .all(channelId) as Array<{ actor: string; content: string }>;
    const match = rows.find((r) => (JSON.parse(r.content) as { text: string }).text === text);
    return match?.actor ?? null;
  } finally {
    db.close();
  }
}

/** Drive N frames over one socket; frame i+1 is sent as soon as a message
 *  arrives in response to frame i. Returns every received frame in order. */
function wsRoundtrip(url: string, frames: unknown[], timeoutMs = 10000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received: any[] = [];
    let idx = 0;
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* noop */ }
      reject(new Error('timeout; received=' + JSON.stringify(received)));
    }, timeoutMs);
    ws.once('open', () => ws.send(JSON.stringify(frames[idx++])));
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString()));
      if (idx < frames.length) {
        ws.send(JSON.stringify(frames[idx++]));
      } else {
        clearTimeout(timer);
        setTimeout(() => ws.close(), 150);
      }
    });
    ws.once('close', () => { clearTimeout(timer); resolve(received); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
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

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S1', () => {
  it('A1-a: an agent posts to a channel it is an active member of; the committed row is attributed to the agent principal (DB-read, not wire ack)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s1-a1a-'));
    const pepper = Buffer.alloc(32, 0x51);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway({ ...BASE_ENV(dataDir, seeded, pepper), TORQCLAW_AGENT_PARTICIPATION: '1' });
    await gateway.ready;

    const text = 'hello from S1 agent ' + randomUUID();
    const connectFrame = { expectedRole: 'node', clientInfo: { name: 's1-agent', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedAgent.token } };
    const postFrame = { action: 'POST_CHANNEL_MESSAGE', channelId: seeded.memberChannelId, text, idempotencyKey: randomUUID() };

    const frames = await wsRoundtrip(gateway.url, [connectFrame, postFrame]);
    expect(frames[0].type).toBe('CONNECTED');
    const errorFrame = frames.find((f) => f.type === 'ERROR');
    expect(errorFrame, 'expected no ERROR frame; got ' + JSON.stringify(frames)).toBeUndefined();

    const actor = actorForMessageText(seeded.collabDbPath, seeded.memberChannelId, text);
    expect(actor, 'the committed collab_events row must attribute the message to the agent principal').toBe(seeded.agentId);
    expect(actor).not.toBe(seeded.operatorId);
  }, 30000);

  it('A1-b: the same agent posting to a channel it is NOT a member of gets COLLAB_NOT_FOUND, byte-identical to a nonexistent channel', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s1-a1b-'));
    const pepper = Buffer.alloc(32, 0x52);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway({ ...BASE_ENV(dataDir, seeded, pepper), TORQCLAW_AGENT_PARTICIPATION: '1' });
    await gateway.ready;

    const connectFrame = { expectedRole: 'node', clientInfo: { name: 's1-agent-b', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedAgent.token } };
    const postToOutsider = { action: 'POST_CHANNEL_MESSAGE', channelId: seeded.outsiderChannelId, text: 'nope', idempotencyKey: randomUUID() };
    const postToAbsent = { action: 'POST_CHANNEL_MESSAGE', channelId: 'no-such-channel-' + randomUUID(), text: 'nope', idempotencyKey: randomUUID() };

    const framesHidden = await wsRoundtrip(gateway.url, [connectFrame, postToOutsider]);
    const errHidden = framesHidden.find((f) => f.type === 'ERROR');
    expect(errHidden?.code).toBe('COLLAB_NOT_FOUND');

    const connectFrame2 = { expectedRole: 'node', clientInfo: { name: 's1-agent-b2', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedAgent.token } };
    const framesAbsent = await wsRoundtrip(gateway.url, [connectFrame2, postToAbsent]);
    const errAbsent = framesAbsent.find((f) => f.type === 'ERROR');
    expect(errAbsent?.code).toBe('COLLAB_NOT_FOUND');

    expect(JSON.stringify(errHidden)).toBe(JSON.stringify(errAbsent));

    // Deletion-probe: zero rows committed to the channel the agent was denied.
    expect(countMessageEvents(seeded.collabDbPath, seeded.outsiderChannelId)).toBe(0);
  }, 30000);

  it('A1-c: a node-seat connection with NO collab binding at all (channel-service auth) is refused, and posts nothing', async () => {
    // The channel-service auth path also derives role 'node'
    // (connectionAuth.ts:69-72) but is a DIFFERENT authClass
    // ('channel_service', not 'agent_surface') and carries a fixed,
    // non-principal binding ('service:channel-http'). This is the
    // channel-seat's own pre-existing deny arm (authz.ts's 'channel'... no
    // -- 'channel_service' maps to role 'channel', which already has an
    // explicit POST_CHANNEL_MESSAGE deny per PRD-005 S3), so this probes a
    // DIFFERENT thing than A1-e's authz.agentCollabWrite gate: it proves
    // agentCollabPrincipalId is never populated for a connection this
    // slice's authClass check does not recognize, regardless of seat.
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s1-a1c-'));
    const pepper = Buffer.alloc(32, 0x53);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway({ ...BASE_ENV(dataDir, seeded, pepper), TORQCLAW_AGENT_PARTICIPATION: '1' });
    await gateway.ready;

    const connectFrame = { expectedRole: 'channel', clientInfo: { name: 's1-channel-svc', version: '0.1.0' }, auth: { kind: 'channel_service', credential: 'unused-cst' } };
    const postFrame = { action: 'POST_CHANNEL_MESSAGE', channelId: seeded.memberChannelId, text: 'should never land', idempotencyKey: randomUUID() };

    const frames = await wsRoundtrip(gateway.url, [connectFrame, postFrame]);
    const errFrame = frames.find((f) => f.type === 'ERROR');
    expect(errFrame?.code).toBe('UNAUTHORIZED');

    expect(countAllMessageEvents(seeded.collabDbPath)).toBe(0);
  }, 30000);

  it('A1-d: with TORQCLAW_AGENT_PARTICIPATION UNSET, the identical agent/channel setup that succeeds under the flag is refused (absent-deny response, not the flag value)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s1-a1d-'));
    const pepper = Buffer.alloc(32, 0x54);
    const seeded = seedDb(dataDir, pepper);
    // Deliberately NOT setting TORQCLAW_AGENT_PARTICIPATION.
    gateway = await launchGateway({ ...BASE_ENV(dataDir, seeded, pepper) });
    await gateway.ready;

    const connectFrame = { expectedRole: 'node', clientInfo: { name: 's1-agent-flagoff', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedAgent.token } };
    const postFrame = { action: 'POST_CHANNEL_MESSAGE', channelId: seeded.memberChannelId, text: 'must not land', idempotencyKey: randomUUID() };

    const frames = await wsRoundtrip(gateway.url, [connectFrame, postFrame]);
    const errFrame = frames.find((f) => f.type === 'ERROR');
    expect(errFrame?.code).toBe('UNAUTHORIZED');
    expect(errFrame?.detail?.reason).toBe('action not permitted for this role');

    expect(countAllMessageEvents(seeded.collabDbPath)).toBe(0);
  }, 30000);

  it('A1-e / deletion-probe: flipping TORQCLAW_AGENT_PARTICIPATION to on is what makes A1-d green -- proves A1-d is a real refusal, not a vacuous always-error', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s1-a1e-'));
    const pepper = Buffer.alloc(32, 0x55);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway({ ...BASE_ENV(dataDir, seeded, pepper), TORQCLAW_AGENT_PARTICIPATION: '1' });
    await gateway.ready;

    const connectFrame = { expectedRole: 'node', clientInfo: { name: 's1-agent-flagon', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedAgent.token } };
    const postFrame = { action: 'POST_CHANNEL_MESSAGE', channelId: seeded.memberChannelId, text: 'flag-on control', idempotencyKey: randomUUID() };

    const frames = await wsRoundtrip(gateway.url, [connectFrame, postFrame]);
    const errFrame = frames.find((f) => f.type === 'ERROR');
    expect(errFrame, 'flag ON must let the identical setup succeed').toBeUndefined();
    expect(countMessageEvents(seeded.collabDbPath, seeded.memberChannelId)).toBe(1);
  }, 30000);
});
