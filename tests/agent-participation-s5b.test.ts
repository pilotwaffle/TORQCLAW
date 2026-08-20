/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S5b — self-only principalId on the
 * CONNECTED frame, exercised through the REAL built gateway over real
 * websockets (verify-the-artifact-not-the-unit-test discipline --
 * packages/gateway/dist, not source).
 *
 * S5b pins the §1.3 self-disclosure rule adopted from the G1R/VERIFY
 * analysis: the CONNECTED frame may carry THE CONNECTION'S OWN resolved
 * collab principalId and nothing else. A subject is always entitled to its
 * own identity, so this is self-disclosure, never a third-party roster/
 * telemetry join.
 *
 *   S5b-a — an operator surface credential connect yields a CONNECTED frame
 *           whose metadata carries sessionId, resumed, and
 *           principalId === the seeded operator principal (via
 *           connectionAuth?.principalId after the C1 self-heal).
 *   S5b-b — an agent surface credential connect under
 *           TORQCLAW_AGENT_PARTICIPATION=1 yields
 *           principalId === the seeded agent principal (via
 *           agentCollabPrincipalId).
 *   S5b-c — a legacy/flag-off connect (TORQCLAW_COLLAB_ENABLED '0', legacy
 *           root token path) yields a CONNECTED metadata object with NO
 *           principalId key AT ALL -- never null, never synthesized --
 *           preserving the pre-S5b byte-identity discipline (H-2).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { issueCredential, nodeRandomSource, runCollaborationMigration } from '../packages/collab/src/index.js';
import { ensureGatewayBuild, launchGateway, connectAndCollect, type GatewayHandle } from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

type Seeded = {
  collabDbPath: string;
  operatorId: string;
  issuedOperator: ReturnType<typeof issueCredential>;
  agentId: string;
  issuedAgent: ReturnType<typeof issueCredential>;
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

  issuedOperator.secretBytes.fill(0);
  issuedAgent.secretBytes.fill(0);
  db.close();
  return { collabDbPath, operatorId, issuedOperator, agentId, issuedAgent };
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

function connectedFrame(frames: any[]): any {
  const frame = frames.find((f) => f?.type === 'CONNECTED');
  expect(frame, 'expected a CONNECTED frame; got ' + JSON.stringify(frames)).toBeDefined();
  return frame;
}

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S5b — self-only principalId on CONNECTED', () => {
  it('S5b-a: an operator surface credential connect yields CONNECTED metadata with sessionId, resumed, and principalId === the operator principal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s5b-op-'));
    const pepper = Buffer.alloc(32, 0x5b);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway(BASE_ENV(dataDir, seeded, pepper));
    await gateway.ready;

    const result = await connectAndCollect(gateway.url, {
      expectedRole: 'operator',
      clientInfo: { name: 's5b-operator', version: '0.1.0' },
      auth: { kind: 'surface', credential: seeded.issuedOperator.token },
    });
    const connected = connectedFrame(result.frames);
    expect(connected.metadata?.sessionId).toEqual(expect.any(String));
    expect(connected.metadata?.resumed).toBe(false);
    expect(connected.metadata?.principalId).toBe(seeded.operatorId);
    expect(connected.metadata?.principalId).not.toBe(seeded.agentId);
  }, 30000);

  it('S5b-b: an agent surface credential connect under TORQCLAW_AGENT_PARTICIPATION=1 yields CONNECTED metadata principalId === the agent principal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s5b-agent-'));
    const pepper = Buffer.alloc(32, 0x5d);
    const seeded = seedDb(dataDir, pepper);
    gateway = await launchGateway({ ...BASE_ENV(dataDir, seeded, pepper), TORQCLAW_AGENT_PARTICIPATION: '1' });
    await gateway.ready;

    const result = await connectAndCollect(gateway.url, {
      expectedRole: 'node',
      clientInfo: { name: 's5b-agent', version: '0.1.0' },
      auth: { kind: 'surface', credential: seeded.issuedAgent.token },
    });
    const connected = connectedFrame(result.frames);
    expect(connected.metadata?.sessionId).toEqual(expect.any(String));
    expect(connected.metadata?.resumed).toBe(false);
    expect(connected.metadata?.principalId).toBe(seeded.agentId);
    expect(connected.metadata?.principalId).not.toBe(seeded.operatorId);
  }, 30000);

  it('S5b-c: a legacy/flag-off connect (TORQCLAW_COLLAB_ENABLED=0, legacy root token) yields CONNECTED metadata with NO principalId key at all', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s5b-legacy-'));
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_COLLAB_ENABLED: '0',
      // The test preload (collab-gateway-test-preload.mjs) unconditionally
      // requires a 32-byte pepper even when the collab flag is off; the
      // value is inert here because collabEnabled() is false.
      TORQCLAW_COLLAB_TEST_PEPPER: Buffer.alloc(32, 0x5e).toString('base64'),
      TORQCLAW_GATEWAY_TOKEN: 'root-token',
      TORQCLAW_CHANNEL_SERVICE_TOKEN: 'unused-cst',
    });
    await gateway.ready;

    const result = await connectAndCollect(gateway.url, {
      role: 'operator',
      token: 'root-token',
      clientInfo: { name: 's5b-legacy', version: '0.1.0' },
    });
    const connected = connectedFrame(result.frames);
    expect(connected.metadata?.sessionId).toEqual(expect.any(String));
    expect(connected.metadata?.resumed).toBe(false);
    // Byte-identity discipline: the field is OMITTED, never null, never
    // synthesized -- a key presence check, not a value check.
    expect('principalId' in (connected.metadata ?? {})).toBe(false);
  }, 30000);
});
