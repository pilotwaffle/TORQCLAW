/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 follow-on — operator C1 self-heal.
 *
 * THE DEFECT: no shipped path (`bootstrapOperator`,
 * packages/collab/src/bootstrap.ts) has ever called `createSurface`, so an
 * operator's ONLY real credential (a `principal_credentials` row) never had
 * a matching C1 `surfaces` row. `resolveConnectIdentity`
 * (packages/gateway/src/collabIdentity.ts) therefore always missed the C1
 * branch for the operator and fell to the C0.1 legacy branch, which returns
 * `auth: null`. `connectionAuth` stayed null for every real operator
 * connection, and POST_CHANNEL_MESSAGE (server.ts's dispatch arm reading
 * `connectionAuth?.principalId`) was unreachable for the operator in a
 * default install -- see `tests/agent-participation-s1.test.ts`'s own
 * header comment, which documents this exact pre-existing finding.
 *
 * THE FIX (collabIdentity.ts, `ensureOperatorSurfaceProvisioned`): on a
 * legacy-path hit for an operator-kind principal, self-heal by projecting
 * the operator's EXISTING credential (same credential_id, same
 * secret_hmac -- not a new token) into the C1 `surfaces` /
 * `surface_credentials` tables and activating the state.db enforcement
 * projection, then re-running the C1 gate once on the SAME connection.
 *
 * These tests seed the operator EXACTLY the way the only shipped path
 * (`bootstrapOperator`) does -- a `principal_credentials` row and nothing
 * else, zero `surfaces` rows -- and drive the REAL BUILT gateway over a
 * real websocket, matching this program's verify-the-artifact discipline.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import {
  issueCredential,
  nodeRandomSource,
  runCollaborationMigration,
  runSurfaceIdentityMigration,
  runSurfaceAuditMigration,
} from '../packages/collab/src/index.js';
import { ensureGatewayBuild, launchGateway, type GatewayHandle } from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

type Seeded = {
  collabDbPath: string;
  issuedOperator: ReturnType<typeof issueCredential>;
  operatorId: string;
  memberChannelId: string;
  outsiderChannelId: string;
};

/**
 * Seeds EXACTLY what `bootstrapOperator` produces in production: one
 * `principals` row (kind='operator'), one `principal_credentials` row.
 * Deliberately NO `surfaces` / `surface_credentials` rows -- proving this
 * fix does not depend on some other slice having already provisioned C1
 * for the operator.
 */
function seedDb(dataDir: string, pepper: Buffer): Seeded {
  const collabDbPath = join(dataDir, 'collab.db');
  const db = new Database(collabDbPath);
  runCollaborationMigration(db);
  // Migrate C1 too so this test's OWN read helpers (operatorSurfaceRole)
  // can query `surfaces` -- the production gateway already does this at
  // getCollabDb() open time (collabIdentity.ts's migrateCollabDb), so this
  // matches what the real artifact does before any connection is served.
  runSurfaceIdentityMigration(db);
  runSurfaceAuditMigration(db);
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

  const memberChannelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Member', 'member', 'active', ?, 1, ?, ?)",
  ).run(memberChannelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(memberChannelId, operatorId, now);

  // A second operator-owned channel with NO membership row inserted for a
  // DIFFERENT, never-connecting principal -- used below as the "outsider"
  // channel for a distinct (non-member) principal. Membership doesn't apply
  // to the operator itself (owners are always visible to themselves), so
  // the outsider case here uses a fabricated non-existent channel id
  // instead (see the byte-identity assertion below).
  const outsiderChannelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Outsider', 'outsider', 'active', ?, 1, ?, ?)",
  ).run(outsiderChannelId, operatorId, now, now);
  // Deliberately do NOT insert the operator into collab_members for this
  // channel's OWNER-visibility path is irrelevant here -- store.ts grants
  // an owner_principal_id visibility regardless of collab_members, so to
  // get a real non-member refusal for the operator we instead assert
  // against a channel id that was never created at all (see postToAbsent).

  issuedOperator.secretBytes.fill(0);
  db.close();
  return { collabDbPath, issuedOperator, operatorId, memberChannelId, outsiderChannelId };
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

/** Reads the self-healed C1 surface row directly -- proof that
 *  `ensureOperatorSurfaceProvisioned` actually ran and committed, not just
 *  that posting happened to work for some other reason. */
function operatorSurfaceRole(collabDbPath: string, operatorId: string): string | null {
  const db = new Database(collabDbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT surface_role AS role FROM surfaces WHERE principal_id = ? AND state = 'active'")
      .get(operatorId) as { role: string } | undefined;
    return row?.role ?? null;
  } finally {
    db.close();
  }
}

/** Reads the state.db gateway_surface_security projection directly -- proof
 *  that `connectionAuth` is genuinely backed by a LIVE C1 projection (the
 *  exact table `liveSurfaceSecurity`/`validatePresentingSurface` read),
 *  not merely that the collab-side surfaces row exists. */
function liveSurfaceProjectionCount(stateDbPath: string, operatorId: string): number {
  const db = new Database(stateDbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM gateway_surface_security WHERE principal_id = ? AND surface_role = 'operator' AND state = 'active'")
      .get(operatorId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

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

describe('operator C1 self-heal (POST_CHANNEL_MESSAGE reachable for the ONLY credential bootstrapOperator mints)', () => {
  it('POSITIVE CONTROL: the operator, seeded with ONLY a principal_credentials row (no surfaces row), posts successfully to a channel it owns', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-opheal-pos-'));
    const pepper = Buffer.alloc(32, 0x61);
    const seeded = seedDb(dataDir, pepper);

    // Confirm the precondition this whole test exists to falsify: NO C1
    // surface row for the operator before the gateway ever runs.
    expect(operatorSurfaceRole(seeded.collabDbPath, seeded.operatorId)).toBeNull();

    gateway = await launchGateway(BASE_ENV(dataDir, seeded, pepper));
    await gateway.ready;

    const text = 'hello from the operator ' + randomUUID();
    const connectFrame = { expectedRole: 'operator', clientInfo: { name: 'op-console', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedOperator.token } };
    const postFrame = { action: 'POST_CHANNEL_MESSAGE', channelId: seeded.memberChannelId, text, idempotencyKey: randomUUID() };

    const frames = await wsRoundtrip(gateway.url, [connectFrame, postFrame]);
    expect(frames[0].type).toBe('CONNECTED');
    const errorFrame = frames.find((f) => f.type === 'ERROR');
    expect(errorFrame, 'expected no ERROR frame; got ' + JSON.stringify(frames)).toBeUndefined();

    const actor = actorForMessageText(seeded.collabDbPath, seeded.memberChannelId, text);
    expect(actor, 'the committed collab_events row must attribute the message to the operator principal').toBe(seeded.operatorId);

    // Proof the self-heal actually ran and committed a REAL C1 surface, not
    // that posting succeeded through some unrelated path.
    expect(operatorSurfaceRole(seeded.collabDbPath, seeded.operatorId)).toBe('operator');
    expect(liveSurfaceProjectionCount(join(dataDir, 'state.db'), seeded.operatorId)).toBe(1);
  }, 30000);

  it('the operator still gets byte-identical COLLAB_NOT_FOUND for a channel that does not exist (refusal survives the fix)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-opheal-notfound-'));
    const pepper = Buffer.alloc(32, 0x62);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway(BASE_ENV(dataDir, seeded, pepper));
    await gateway.ready;

    const absentChannelId = 'no-such-channel-' + randomUUID();
    const connectFrame = { expectedRole: 'operator', clientInfo: { name: 'op-console-nf', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedOperator.token } };
    const postToAbsent = { action: 'POST_CHANNEL_MESSAGE', channelId: absentChannelId, text: 'nope', idempotencyKey: randomUUID() };

    const frames = await wsRoundtrip(gateway.url, [connectFrame, postToAbsent]);
    const errFrame = frames.find((f) => f.type === 'ERROR');
    expect(errFrame?.code).toBe('COLLAB_NOT_FOUND');

    // Deletion-probe: zero rows committed anywhere for the refused post.
    expect(countMessageEvents(seeded.collabDbPath, absentChannelId)).toBe(0);
  }, 30000);

  it('byte-identity (T-2): a DIFFERENT never-a-member principal posting to a real channel gets the SAME COLLAB_NOT_FOUND payload shape as the nonexistent-channel case', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-opheal-t2-'));
    const pepper = Buffer.alloc(32, 0x63);
    const seeded = seedDb(dataDir, pepper);

    // A second, non-operator (agent-kind) principal -- schema enforces AT
    // MOST ONE operator-kind principal per installation
    // (principals_single_operator, migration.ts:70-71), so the outsider
    // here is agent-kind, exactly like a real second identity a fresh
    // install could actually contain. It has its own principal_credentials
    // row and is never added as a member of anything.
    const db = new Database(seeded.collabDbPath);
    const outsiderId = randomUUID();
    const credOutsider = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'Outsider Agent', ?, 'active', 1, NULL, ?, ?)",
    ).run(outsiderId, seeded.operatorId, now, now);
    const issuedOutsider = issueCredential(credOutsider, pepper, nodeRandomSource);
    db.prepare(
      "INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)",
    ).run(credOutsider, outsiderId, issuedOutsider.secretHmac, now);
    issuedOutsider.secretBytes.fill(0);
    db.close();

    gateway = await launchGateway({ ...BASE_ENV(dataDir, seeded, pepper), TORQCLAW_AGENT_PARTICIPATION: '1' });
    await gateway.ready;

    // Case A: the outsider posts to the operator's real, owned channel (visible-but-not-a-member).
    const connectOutsider = { expectedRole: 'node', clientInfo: { name: 'outsider-agent', version: '0.1.0' }, auth: { kind: 'surface', credential: issuedOutsider.token } };
    const postToReal = { action: 'POST_CHANNEL_MESSAGE', channelId: seeded.memberChannelId, text: 'nope-real', idempotencyKey: randomUUID() };
    const framesReal = await wsRoundtrip(gateway.url, [connectOutsider, postToReal]);
    const errReal = framesReal.find((f) => f.type === 'ERROR');
    expect(errReal?.code).toBe('COLLAB_NOT_FOUND');

    // Case B: the outsider posts to a channel id that never existed.
    const connectOutsider2 = { expectedRole: 'node', clientInfo: { name: 'outsider-agent-2', version: '0.1.0' }, auth: { kind: 'surface', credential: issuedOutsider.token } };
    const postToAbsent = { action: 'POST_CHANNEL_MESSAGE', channelId: 'no-such-channel-' + randomUUID(), text: 'nope-absent', idempotencyKey: randomUUID() };
    const framesAbsent = await wsRoundtrip(gateway.url, [connectOutsider2, postToAbsent]);
    const errAbsent = framesAbsent.find((f) => f.type === 'ERROR');
    expect(errAbsent?.code).toBe('COLLAB_NOT_FOUND');

    expect(JSON.stringify(errReal)).toBe(JSON.stringify(errAbsent));
    expect(countMessageEvents(seeded.collabDbPath, seeded.memberChannelId)).toBe(0);
  }, 30000);

  // ── G1R B-SH-1: the partial-write brick ────────────────────────────────
  //
  // A complete provision is THREE writes across TWO databases: the surfaces
  // row + its surface_credentials link (atomic inside tx()), and the state.db
  // enforcement projection (activateSurfaceProjection), which necessarily runs
  // OUTSIDE that transaction because it targets a different database.
  //
  // The original idempotence guard read ONLY the surfaces row. A crash between
  // the tx() commit and the projection left collab.db provisioned and state.db
  // empty -- and on every later connect validatePresentingSurface returned null
  // (no projection), control fell to the legacy branch, and the guard saw the
  // orphan row and RETURNED WITHOUT RETRYING. The operator was bricked
  // PERMANENTLY by the routine that exists to un-brick them.
  //
  // G1R reproduced this twice on the real booted gateway before the fix.
  // Simulated here by running the FIRST connect to completion, then deleting
  // only the state.db projection -- byte-exactly the state a crash leaves.
  //
  // Asserts the message COMMITS (an event row), not merely that no ERROR frame
  // arrived: a frame-only assertion is the vacuous shape this program has hit
  // seven times.
  it('B-SH-1: a partial provision (collab rows present, state.db projection MISSING) is REPAIRED on the next connect, not permanently bricked', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-opheal-partial-'));
    const pepper = Buffer.alloc(32, 0x63);
    const seeded = seedDb(dataDir, pepper);
    const stateDbPath = join(dataDir, 'state.db');

    // First connect: provisions fully.
    gateway = await launchGateway(BASE_ENV(dataDir, seeded, pepper));
    await gateway.ready;
    const warm = { expectedRole: 'operator', clientInfo: { name: 'op-warm', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedOperator.token } };
    await wsRoundtrip(gateway.url, [warm]);
    expect(operatorSurfaceRole(seeded.collabDbPath, seeded.operatorId)).toBe('operator');
    expect(liveSurfaceProjectionCount(stateDbPath, seeded.operatorId)).toBe(1);
    await gateway.stop();

    // Simulate the crash window: collab.db keeps its rows, state.db loses the
    // projection. This is exactly what dying between write 2 and write 3 leaves.
    const sdb = new Database(stateDbPath);
    sdb.prepare("DELETE FROM gateway_surface_security WHERE principal_id = ? AND surface_role = 'operator'").run(seeded.operatorId);
    sdb.close();
    expect(operatorSurfaceRole(seeded.collabDbPath, seeded.operatorId)).toBe('operator'); // orphan survives
    expect(liveSurfaceProjectionCount(stateDbPath, seeded.operatorId)).toBe(0); // projection gone

    // Next connect must REPAIR rather than return early on the orphan row.
    gateway = await launchGateway(BASE_ENV(dataDir, seeded, pepper));
    await gateway.ready;
    const text = 'post after partial-provision repair ' + randomUUID();
    const connectFrame = { expectedRole: 'operator', clientInfo: { name: 'op-repair', version: '0.1.0' }, auth: { kind: 'surface', credential: seeded.issuedOperator.token } };
    const postFrame = { action: 'POST_CHANNEL_MESSAGE', channelId: seeded.memberChannelId, text, idempotencyKey: randomUUID() };
    const frames = await wsRoundtrip(gateway.url, [connectFrame, postFrame]);

    const errorFrame = frames.find((f) => f.type === 'ERROR');
    expect(
      errorFrame,
      'B-SH-1 REGRESSION: the operator is bricked by a partial provision. The '
      + 'idempotence guard saw the orphan surfaces row and returned without '
      + 're-running activateSurfaceProjection, so connectionAuth stays null '
      + 'FOREVER. Got: ' + JSON.stringify(frames),
    ).toBeUndefined();

    // THE LOAD-BEARING ASSERTION: the message actually committed.
    expect(
      actorForMessageText(seeded.collabDbPath, seeded.memberChannelId, text),
      'the repaired connect must COMMIT the message, not merely avoid an ERROR frame',
    ).toBe(seeded.operatorId);

    // And the projection is genuinely restored.
    expect(liveSurfaceProjectionCount(stateDbPath, seeded.operatorId)).toBe(1);
  }, 45000);
});
