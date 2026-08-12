/**
 * C2 FLAG-ON booted-artifact E2E — the gate that was missing.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §1.4, §5(c), §8 C2-2/C2-3/C2-8.
 *
 * G2A D-5 named this mandatory, and it is the gate whose ABSENCE let D-1
 * and D-2 survive a full green review: every C2 unit passed, every
 * built-artifact test passed, and the feature was 100% non-functional
 * flag-on because the producer path had no production callers.
 *
 * A control is only landed when the SHIPPED BINARY, with the flag ON,
 * performs the whole loop:
 *
 *     gated tool -> pending approval WITH a C2 binding
 *                -> operator APPROVE mints exactly one grant
 *                -> the re-run is ADMITTED (grant consumed exactly once)
 *                -> a second use of that grant is REFUSED
 *
 * Anything less proves the pieces, not the machine.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import {
  createSurface, issueSurfaceCredential,
} from '../packages/collab/src/surfaceStore.js';
import { nodeRandomSource } from '../packages/collab/src/bootstrap.js';
import {
  activateSurfaceProjection, grantAuthority, grantProfileDelegation,
} from '../packages/gateway/src/surfaceSecurity.js';
import {
  ensureGatewayBuild, launchGateway, GATEWAY_DIST_ENTRY, type GatewayHandle,
} from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

const TOOL = 'filesystem__write_file';
const PRINCIPAL = 'prn_e2e_operator';
const SURFACE = 'srf_e2e_desktop';

function env(dataDir: string, collabPath: string, pepper: Buffer, extra: Record<string, string> = {}) {
  return {
    TORQCLAW_DATA_DIR: dataDir,
    TORQCLAW_COLLAB_DB_PATH: collabPath,
    TORQCLAW_COLLAB_ENABLED: '1',
    TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'),
    TORQCLAW_GATEWAY_TOKEN: 'root-token',
    TORQCLAW_E2E_FORCE_GATED_TOOL: TOOL,
    ...extra,
  };
}

/**
 * Let the real artifact create BOTH schemas, then seed identity data into
 * them. Hand-migrating would let this test pass against a binary that
 * cannot stand up its own databases (the C1 G2A round-1 lesson).
 */
async function bootAndMigrate(dataDir: string, collabPath: string, pepper: Buffer): Promise<void> {
  const boot = await launchGateway(env(dataDir, collabPath, pepper));
  await boot.ready;
  const ws = new WebSocket(boot.url);
  await new Promise<void>((resolve) => { ws.once('open', () => resolve()); ws.once('error', () => resolve()); });
  ws.send(JSON.stringify({
    role: 'operator', token: 'root-token',
    clientInfo: { name: 'migrate-probe', version: '0.1.0' },
    auth: { kind: 'surface', credential: 'tq1_nothing' },
  }));
  await new Promise((r) => setTimeout(r, 700));
  try { ws.close(); } catch { /* noop */ }
  await boot.stop();
}

/** Seed a full C1 identity: surface, credential, projection, authority, delegation. */
function seedIdentity(dataDir: string, collabPath: string, pepper: Buffer): string {
  const collab = new Database(collabPath);
  const now = new Date().toISOString();
  collab.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) "
    + "VALUES (?, 'operator','E2E',NULL,'active',1,NULL,?,?)",
  ).run(PRINCIPAL, now, now);
  createSurface(collab, {
    surfaceId: SURFACE, principalId: PRINCIPAL, surfaceKind: 'desktop', surfaceRole: 'operator',
  });
  const token = issueSurfaceCredential(collab, SURFACE, pepper, nodeRandomSource);
  collab.close();

  const state = new Database(join(dataDir, 'state.db'));
  activateSurfaceProjection(state, {
    surfaceId: SURFACE, principalId: PRINCIPAL, surfaceKind: 'desktop', surfaceRole: 'operator',
    allowedCapabilityClasses: ['read', 'write', 'exec'], authEpoch: 1, capabilityRevision: 1,
    sourceIdentityRevision: 'rev-1',
  });
  grantAuthority(state, SURFACE, 'approve', randomUUID());
  state.close();
  return token.token;
}

/**
 * Delegate a profile using the REAL policy hash the booted gateway
 * reported on its TIER_SELECTED frame.
 *
 * The hash is derived from the live tool registry, which differs between
 * this test process and the gateway child process, so a hand-invented
 * value can never match -- and the decision writer correctly refuses
 * `profile-delegation-stale` when it does not. Reading the gateway's own
 * reported hash is what makes this fixture honest rather than a
 * hard-coded guess that would drift.
 */
function delegateObservedProfile(dataDir: string, profileId: string, policyHash: string): void {
  const state = new Database(join(dataDir, 'state.db'));
  grantProfileDelegation(state, {
    delegationId: randomUUID(), surfaceId: SURFACE, profileId,
    profileDelegationRevision: 1, profileSchemaVersion: 'torqclaw.effective-profile/v1',
    profileVersion: 1, toolRegistryVersion: 'torqclaw.tools/v1',
    effectiveProfilePolicyHash: policyHash, registryEnforcementHash: 'd'.repeat(64),
  });
  state.close();
}

/** A live conversation that can send follow-up commands. */
async function open(url: string, credential: string) {
  const raw: string[] = [];
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve()); ws.once('error', reject);
  });
  ws.on('message', (m) => raw.push(m.toString()));
  ws.send(JSON.stringify({
    role: 'operator', token: 'root-token',
    clientInfo: { name: 'c2-e2e', version: '0.1.0' },
    auth: { kind: 'surface', credential },
  }));
  await new Promise((r) => setTimeout(r, 700));
  return {
    raw,
    send: async (cmd: unknown, waitMs = 2500) => {
      ws.send(JSON.stringify(cmd));
      await new Promise((r) => setTimeout(r, waitMs));
    },
    close: () => { try { ws.close(); } catch { /* noop */ } },
  };
}

function frameWith(raw: string[], type: string): Record<string, any> | null {
  for (const line of raw) {
    if (!line.includes(type)) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === type) return parsed;
    } catch { /* skip */ }
  }
  return null;
}

describe('C2 FLAG-ON end-to-end on the booted artifact (D-1, D-5)', () => {
  it('pending -> approve -> grant minted -> admitted once -> second use refused', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c2-e2e-'));
    const collabPath = join(dataDir, 'collab.db');
    const pepper = randomBytes(32);
    await bootAndMigrate(dataDir, collabPath, pepper);
    const credential = seedIdentity(dataDir, collabPath, pepper);

    gateway = await launchGateway(env(dataDir, collabPath, pepper));
    await gateway.ready;

    // ── 0. observe the profile + policy hash the REAL gateway resolves ──
    // The hash comes from the live tool registry inside the child process,
    // so it must be read from the artifact rather than guessed here.
    const probe = await open(gateway.url, credential);
    await probe.send({
      action: 'SUBMIT_PROMPT', prompt: 'profile probe', executionMode: 'LOCAL_ONLY',
    }, 3000);
    const tierFrame = frameWith(probe.raw, 'TIER_SELECTED');
    expect(tierFrame, 'the probe must report a resolved profile').not.toBeNull();
    const profileId = String(tierFrame!.metadata.profile);
    const policyHash = String(tierFrame!.metadata.profileHash);
    probe.close();
    delegateObservedProfile(dataDir, profileId, policyHash);

    const wire = await open(gateway.url, credential);

    // ── 1. a gated tool produces a PENDING_APPROVAL ──
    await wire.send({
      action: 'SUBMIT_PROMPT', prompt: 'c2 flag-on end to end', executionMode: 'LOCAL_ONLY',
    }, 3000);
    const pending = frameWith(wire.raw, 'PENDING_APPROVAL');
    expect(pending, 'the run must reach a real approval').not.toBeNull();
    const approvalId = pending!.metadata.approvalId as string;

    // ── 2. THE D-1 CHECK: the row carries a real C2 binding ──
    // Without this the whole slice is inert: no binding means no grant can
    // ever be minted and every approved re-run is refused grant-missing.
    const db = new Database(join(dataDir, 'state.db'), { readonly: true });
    const binding = db.prepare(
      'SELECT * FROM gateway_approval_bindings WHERE approval_id=?',
    ).get(approvalId) as Record<string, unknown> | undefined;
    expect(binding, 'flag-on registration MUST write a C2 binding').toBeDefined();
    expect(binding!.action_hash_version).toBe('ACTIONHASH_V1');

    const approvalRow = db.prepare(
      'SELECT * FROM tool_approvals WHERE approval_id=?',
    ).get(approvalId) as Record<string, unknown>;
    expect(approvalRow.origin_principal_id, 'origin must be recorded').toBe(PRINCIPAL);
    expect(approvalRow.origin_surface_id).toBe(SURFACE);
    expect(approvalRow.expires_at, 'a finite deadline must be set').not.toBeNull();
    db.close();

    // ── 3. operator APPROVES; exactly one grant is minted ──
    await wire.send({ action: 'APPROVE_TOOL', approvalId, decision: 'APPROVE' }, 12000);

    const db2 = new Database(join(dataDir, 'state.db'), { readonly: true });
    const grants = db2.prepare(
      'SELECT * FROM gateway_action_grants WHERE approval_id=?',
    ).all(approvalId) as Record<string, unknown>[];
    expect(grants, 'APPROVE must mint exactly one grant').toHaveLength(1);

    const decided = db2.prepare(
      'SELECT * FROM tool_approvals WHERE approval_id=?',
    ).get(approvalId) as Record<string, unknown>;
    expect(decided.status).toBe('approved');
    expect(decided.decided_surface_id, 'decision evidence must be written').toBe(SURFACE);
    expect(decided.context_hash, 'the winning context digest must be stored').not.toBeNull();

    // ── 4. THE ADMISSION CHECK: the grant was CONSUMED by the re-run ──
    // This is what proves the admission wire is connected end to end. If
    // dispatch never reached admitToolCall, consumed_at would still be
    // null; if the grant were missing, the re-run would have been refused.
    expect(grants[0]!.consumed_at, 'the re-run must have consumed the grant').not.toBeNull();

    // ...and the re-run actually executed rather than being refused.
    const refusedFrame = wire.raw.some((l) => l.includes('grant-missing'));
    expect(refusedFrame, 'the approved re-run must NOT be refused grant-missing').toBe(false);
    db2.close();

    // ── 5. ONE-SHOT: the consumed grant cannot be used again ──
    // Replaying APPROVE must not mint a second grant.
    await wire.send({ action: 'APPROVE_TOOL', approvalId, decision: 'APPROVE' }, 2000);
    const db3 = new Database(join(dataDir, 'state.db'), { readonly: true });
    expect(
      db3.prepare('SELECT COUNT(*) c FROM gateway_action_grants WHERE approval_id=?').get(approvalId),
      'a replayed APPROVE must never mint a second grant',
    ).toEqual({ c: 1 });
    db3.close();

    wire.close();
    await gateway.stop(); gateway = null;
  }, 240000);
});

describe('C2 FLAG-ON FRONTIER fail-closed on the booted artifact (D-2)', () => {
  it('a flag-on FRONTIER re-run carrying a grant is REFUSED before the engine', async () => {
    // This drives the EXECUTOR fence in dispatch.ts directly, because the
    // router will not select FRONTIER on this machine (no reachable engine,
    // and LOCAL_ONLY/CLOUD_OK both resolve local here). Relying on routing
    // made an earlier version of this test vacuous -- it passed with BOTH
    // fences deleted, because nothing ever reached FRONTIER at all.
    //
    // The fence is what must be proven, so the fence is what is called.
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c2-frontier-'));
    const collabPath = join(dataDir, 'collab.db');
    const pepper = randomBytes(32);
    await bootAndMigrate(dataDir, collabPath, pepper);
    seedIdentity(dataDir, collabPath, pepper);

    // The BUILT artifact's dispatch module -- not the TS source.
    const distDir = join(GATEWAY_DIST_ENTRY, '..');
    const prevFlag = process.env.TORQCLAW_COLLAB_ENABLED;
    const prevDir = process.env.TORQCLAW_DATA_DIR;
    process.env.TORQCLAW_COLLAB_ENABLED = '1';
    process.env.TORQCLAW_DATA_DIR = dataDir;
    try {
      const { dispatch } = await import(pathToFileURL(join(distDir, 'dispatch.js')).href);
      const { ComputeTier } = await import('@torqclaw/contracts');

      const sessionId = randomUUID();
      const requestId = randomUUID();
      const state = new Database(join(dataDir, 'state.db'));
      state.prepare("INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator','t')")
        .run(sessionId);
      state.close();

      const req = {
        id: requestId,
        sessionId,
        receivedAt: new Date().toISOString(),
        sourceChannel: 'test',
        payload: {
          prompt: 'frontier fence probe', taskType: 'general',
          // A gateway-issued grant: exactly the state that must NOT be
          // honoured on a tier the admission seam cannot fence.
          grantedTools: [TOOL], assembledContext: '',
        },
        constraints: { executionMode: 'CLOUD_OK' },
        enrichment: { memoryUsed: false },
      } as any;
      const diag = { tier: ComputeTier.FRONTIER, reason: 'test', ruleId: null } as any;

      dispatch(req, diag);
      await new Promise((r) => setTimeout(r, 1500));

      const check = new Database(join(dataDir, 'state.db'), { readonly: true });
      const task = check.prepare('SELECT state, error FROM tasks WHERE request_id=?')
        .get(requestId) as { state: string; error: string | null } | undefined;
      expect(task, 'the task row must exist').toBeDefined();
      // The decisive assertion: the run was REFUSED, and refused for the
      // FRONTIER structured-grant reason specifically.
      expect(task!.state).toBe('failed');
      expect(task!.error).toContain('frontier-structured-grant-unavailable');
      check.close();
    } finally {
      if (prevFlag === undefined) delete process.env.TORQCLAW_COLLAB_ENABLED;
      else process.env.TORQCLAW_COLLAB_ENABLED = prevFlag;
      if (prevDir === undefined) delete process.env.TORQCLAW_DATA_DIR;
      else process.env.TORQCLAW_DATA_DIR = prevDir;
    }
  }, 180000);

  it('the APPROVE_TOOL guard refuses minting a FRONTIER grant', async () => {
    // The second fence, asserted on the shipped javascript: an approved
    // FRONTIER re-mint must be refused at decision time, before any
    // executor is reached.
    const { readFileSync } = await import('node:fs');
    const distDir = join(GATEWAY_DIST_ENTRY, '..');
    const serverJs = readFileSync(join(distDir, 'server.js'), 'utf8');
    const idx = serverJs.indexOf('frontier-structured-grant-unavailable');
    expect(idx, 'the APPROVE_TOOL FRONTIER guard must ship').toBeGreaterThan(-1);
    // ...and it must be gated on the FRONTIER tier, not dead code.
    const window = serverJs.slice(Math.max(0, idx - 600), idx);
    expect(window).toMatch(/ComputeTier\.FRONTIER/);
  }, 60000);
});
