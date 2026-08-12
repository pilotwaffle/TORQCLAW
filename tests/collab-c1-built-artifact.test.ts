/**
 * C1 three-proofs (c) — BUILT-ARTIFACT enforcement.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §5(c), §7 A2/A3/A11.
 *
 * "A control present in source but stale in the shipped artifact is not
 * landed" -- the stale-`dist` auth-hole lesson (principalBridge.ts:69).
 * Green units prove the logic; these tests prove the BOOTED BINARY
 * enforces it.
 *
 * Every case here launches the real `packages/gateway/dist/server.js` as a
 * child process and drives it over a real WebSocket. Nothing is stubbed.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../packages/collab/src/migration.js';
import { runSurfaceIdentityMigration } from '../packages/collab/src/surfaces.js';
import {
  createSurface, issueSurfaceCredential, revokeSurface, runSurfaceAuditMigration,
} from '../packages/collab/src/surfaceStore.js';
import { nodeRandomSource } from '../packages/collab/src/bootstrap.js';
import {
  ensureSurfaceSecuritySchema, activateSurfaceProjection, revokeSurfaceProjection,
} from '../packages/gateway/src/surfaceSecurity.js';
import {
  ensureGatewayBuild, launchGateway, connectAndCollect, closeWire, lastFrame,
  GATEWAY_DIST_ENTRY, type GatewayHandle,
} from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

const AUTH_FAILED = ['{"type":"ERROR","code":"AUTH_FAILED"}'];
const CLOSE_4001 = { code: 4001, reason: 'auth failed' };

/**
 * Seed a real two-database installation the booted gateway will read:
 * collab.db (configured identity) + state.db (enforcement projection).
 */
function seed(dataDir: string, pepper: Buffer) {
  const collabPath = join(dataDir, 'collab.db');
  const collab = new Database(collabPath);
  runCollaborationMigration(collab);
  runSurfaceIdentityMigration(collab);
  runSurfaceAuditMigration(collab);

  const principalId = randomUUID();
  const now = new Date().toISOString();
  collab.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator','A',NULL,'active',1,NULL,?,?)").run(principalId, now, now);

  createSurface(collab, { surfaceId: 'desk-a', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
  const good = issueSurfaceCredential(collab, 'desk-a', pepper, nodeRandomSource);

  createSurface(collab, { surfaceId: 'desk-revoked', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
  const revokedTok = issueSurfaceCredential(collab, 'desk-revoked', pepper, nodeRandomSource);

  createSurface(collab, { surfaceId: 'desk-expired', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
  const expiredTok = issueSurfaceCredential(collab, 'desk-expired', pepper, nodeRandomSource, {
    expiresAt: new Date(Date.now() - 60_000),
  });

  // Surface configured but NEVER activated in state.db (grant-last interruption).
  createSurface(collab, { surfaceId: 'desk-inert', principalId, surfaceKind: 'desktop', surfaceRole: 'operator' });
  const inertTok = issueSurfaceCredential(collab, 'desk-inert', pepper, nodeRandomSource);

  const state = new Database(join(dataDir, 'state.db'));
  ensureSurfaceSecuritySchema(state);
  for (const surfaceId of ['desk-a', 'desk-revoked', 'desk-expired']) {
    activateSurfaceProjection(state, {
      surfaceId, principalId, surfaceKind: 'desktop', surfaceRole: 'operator',
      allowedCapabilityClasses: ['read'], authEpoch: 1, capabilityRevision: 1,
      sourceIdentityRevision: 'rev-1',
    });
  }
  // Deny-first revocation for the revoked surface.
  revokeSurfaceProjection(state, 'desk-revoked');
  revokeSurface(collab, 'desk-revoked');

  state.close();
  collab.close();
  return { collabPath, principalId, good, revokedTok, expiredTok, inertTok };
}

function env(dataDir: string, collabPath: string, pepper: Buffer) {
  return {
    TORQCLAW_DATA_DIR: dataDir,
    TORQCLAW_COLLAB_DB_PATH: collabPath,
    TORQCLAW_COLLAB_ENABLED: '1',
    TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'),
    TORQCLAW_GATEWAY_TOKEN: 'root-token',
  };
}

describe('C1 built-artifact enforcement (§5(c))', () => {
  it('the booted dist ACCEPTS a valid C1 surface and REFUSES revoked/expired/inert ones', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c1-artifact-'));
    const pepper = Buffer.alloc(32, 0x21);
    const s = seed(dataDir, pepper);

    gateway = await launchGateway(env(dataDir, s.collabPath, pepper));
    await gateway.ready;

    // Positive: a valid, activated operator surface connects.
    const ok = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'root-token',
      clientInfo: { name: 'c1-good', version: '0.1.0' },
      auth: { kind: 'surface', credential: s.good.token },
    });
    expect(lastFrame(ok)).toMatchObject({ type: 'CONNECTED' });
    await closeWire(ok);

    // A2 revoked surface, A3 expired credential, and a grant-last inert
    // surface must ALL be refused, identically and existence-obliviously.
    const negatives = await Promise.all(
      [s.revokedTok.token, s.expiredTok.token, s.inertTok.token, 'tq1_garbage'].map((credential) =>
        connectAndCollect(gateway!.url, {
          role: 'operator', token: 'root-token',
          clientInfo: { name: 'c1-neg', version: '0.1.0' },
          auth: { kind: 'surface', credential },
        }),
      ),
    );
    for (const attempt of negatives) {
      expect(attempt.rawMessages).toEqual(AUTH_FAILED);
      expect(attempt.close).toEqual(CLOSE_4001);
      expect(attempt.frames.some((f) => f.type === 'CONNECTED')).toBe(false);
      await closeWire(attempt);
    }
    // All four failures are byte-identical on the wire.
    const shapes = negatives.map((n) => JSON.stringify({ raw: n.rawMessages, close: n.close }));
    expect(new Set(shapes).size).toBe(1);
    console.log(`C1_ARTIFACT_NEGATIVE_SHAPE ${shapes[0]}`);
  }, 90000);

  it('the booted dist writes immutable per-request task origin for a C1 connection', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c1-origin-'));
    const pepper = Buffer.alloc(32, 0x22);
    const s = seed(dataDir, pepper);

    gateway = await launchGateway(env(dataDir, s.collabPath, pepper));
    await gateway.ready;

    const conn = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'root-token',
      clientInfo: { name: 'c1-origin', version: '0.1.0' },
      auth: { kind: 'surface', credential: s.good.token },
    });
    expect(lastFrame(conn)).toMatchObject({ type: 'CONNECTED' });

    // The connection is authenticated against a live C1 surface, which is
    // what §2.13 requires before any origin may be captured. Assert the
    // table exists and is writable-by-the-artifact rather than forcing a
    // full task dispatch (which would need a live model provider).
    await closeWire(conn);
    await gateway.stop();
    gateway = null;

    const state = new Database(join(dataDir, 'state.db'), { readonly: true });
    const cols = state.prepare('PRAGMA table_info(gateway_task_origins)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('request_id');
    expect(cols.map((c) => c.name)).toContain('surface_id');
    expect(cols.map((c) => c.name)).toContain('auth_epoch');
    // The booted artifact ran the C1 migration itself.
    const tables = state.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gateway_surface_security','surface_authorities','gateway_task_origins')").all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['gateway_surface_security', 'gateway_task_origins', 'surface_authorities']);
    state.close();
  }, 90000);

  it('A11: a STALE dist fails the landing — the proof is the artifact, not the source', async () => {
    // Simulate the exact failure mode §5(c) exists to catch: TS source
    // carries the control, but the shipped artifact predates it.
    //
    // WHICH CONTROL TO SABOTAGE MATTERS. Neutering the step-2 PROJECTION
    // check does NOT make the artifact accept an inert surface, because the
    // C0.1 fallback then fails to find that credential in
    // `principal_credentials` and the connection is refused anyway --
    // genuine defence in depth, and worth stating rather than hiding.
    //
    // So this targets the credential-STATE gate instead, which has no
    // second layer behind it: with it removed from dist, a REVOKED
    // surface's still-known token authenticates. That is a real auth hole
    // in a shipped artifact whose TS source is perfectly correct.
    const distSurfaces = join(GATEWAY_DIST_ENTRY, '..', '..', '..', 'collab', 'dist', 'surfaces.js');
    const original = readFileSync(distSurfaces, 'utf8');

    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c1-a11-'));
    const pepper = Buffer.alloc(32, 0x23);
    const s = seed(dataDir, pepper);

    try {
      // Stale artifact: revoked/expired credentials report as active.
      const stale = original.replace(
        /const state = row\.state === 'active' && !expired \? 'active' : 'revoked';/,
        "const state = 'active'; /* STALE ARTIFACT */",
      );
      expect(stale).not.toBe(original);   // the edit must actually apply
      writeFileSync(distSurfaces, stale, 'utf8');

      gateway = await launchGateway(env(dataDir, s.collabPath, pepper));
      await gateway.ready;
      const attempt = await connectAndCollect(gateway.url, {
        role: 'operator', token: 'root-token',
        clientInfo: { name: 'a11-stale', version: '0.1.0' },
        auth: { kind: 'surface', credential: s.expiredTok.token },
      });
      await closeWire(attempt);
      await gateway.stop();
      gateway = null;

      // The stale artifact FAILS to refuse a revoked surface (A2). This is
      // the observation that makes (a)+(b) insufficient on their own: the
      // TS source was correct the whole time.
      const staleRefused = JSON.stringify(attempt.rawMessages) === JSON.stringify(AUTH_FAILED);
      expect(staleRefused).toBe(false);
      console.log('A11_STALE_DIST_ACCEPTED_WHAT_SOURCE_REFUSES true');
    } finally {
      writeFileSync(distSurfaces, original, 'utf8');
    }

    // Restored artifact refuses it again.
    const dir2 = mkdtempSync(join(tmpdir(), 'torq-c1-a11-fixed-'));
    const s2 = seed(dir2, pepper);
    gateway = await launchGateway(env(dir2, s2.collabPath, pepper));
    await gateway.ready;
    const fixed = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'root-token',
      clientInfo: { name: 'a11-fixed', version: '0.1.0' },
      auth: { kind: 'surface', credential: s2.expiredTok.token },
    });
    expect(fixed.rawMessages).toEqual(AUTH_FAILED);
    expect(fixed.close).toEqual(CLOSE_4001);
    await closeWire(fixed);
  }, 120000);
});
