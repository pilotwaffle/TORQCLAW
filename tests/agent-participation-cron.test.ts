/**
 * CRON slice -- scheduled autonomous agent turns.
 * G1R Gate-1 §2A (docs/prd-reviews/G1R-OPUS-AGENT-PARTICIPATION-007-GATE1.md).
 *
 * Drives the REAL BUILT dist artifacts throughout (packages/collab/dist,
 * packages/gateway/dist) -- never a hand-rolled replica -- per this repo's
 * "verify the artifact, not the unit test" discipline and the build-trap
 * warning (`pnpm build --force` is run before this suite by the harness's
 * ensureGatewayBuild(), and every probe below that mutates a dist artifact
 * restores it in a finally block and proves the restore).
 *
 * Covers, each with a positive control in the SAME test so a
 * universally-broken build cannot pass:
 *   - A scheduled turn fires, posts, and the post is a COMMITTED collab_events
 *     row (not an emitted frame) -- the real end-to-end path through
 *     tickSchedules -> claimScheduleFire -> runScheduledTurn -> the SAME
 *     profile-gated bridge.executeTool call A3-c already proved.
 *   - STOP (both collab_autoreply_stop scopes) refuses a due fire at wake
 *     time, with a positive control proving the SAME schedule fires when
 *     STOP is absent.
 *   - Membership revoked between schedule creation and wake -> refused at
 *     WAKE (assertScheduleStillAuthorized), not admitted from stale
 *     schedule-row state -- proven by creating the schedule while the agent
 *     is a member, THEN removing membership, THEN ticking.
 *   - A FRONTIER-routed scheduled turn is impossible by construction: the
 *     dispatcher hardcodes diag.tier to LOCAL_EDGE unconditionally, proven
 *     by source-level assertion (mirrors autoReplyDispatcher.ts's own
 *     FRONTIER-fence comment) AND by a runtime assertion that the diag
 *     object dispatch() receives never carries FRONTIER regardless of what
 *     the router would otherwise compute for this prompt.
 *   - The third state: a scheduled turn whose tool call is gated (requires
 *     approval) resolves to 'blocked_awaiting_approval' -- never
 *     'completed', never 'terminated', never silently absent -- read from
 *     the REAL tasks.telemetry_json row dispatch.ts's existing
 *     ToolApprovalRequired branch writes, never inferred from a timeout.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runCollaborationMigration, runAgentAutoreplyMigration, runAgentCronMigration } from '../packages/collab/src/index.js';
import { ensureGatewayBuild, GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';

const REPO_ROOT = join(GATEWAY_DIST_ENTRY, '..', '..', '..', '..');
const GATEWAY_DIST_DIR = join(REPO_ROOT, 'packages', 'gateway', 'dist');
const COLLAB_DIST_DIR = join(REPO_ROOT, 'packages', 'collab', 'dist');
const BRIDGE_DIST_DIR = join(REPO_ROOT, 'packages', 'bridge', 'dist');
const CRON_DISPATCHER_SRC = join(REPO_ROOT, 'packages', 'gateway', 'src', 'cronDispatcher.ts');

beforeAll(async () => { await ensureGatewayBuild(); }, 200000);

function nowIso(): string { return new Date().toISOString(); }

type Seeded = {
  collabDbPath: string;
  operatorId: string;
  agentId: string;
  channelId: string;
};

function seedChannel(dbPath: string): Seeded {
  const db = new Database(dbPath);
  runCollaborationMigration(db);
  runAgentAutoreplyMigration(db);
  runAgentCronMigration(db);
  const operatorId = randomUUID();
  const agentId = randomUUID();
  const now = nowIso();
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(operatorId, now, now);
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'Ag', ?, 'active', 1, NULL, ?, ?)",
  ).run(agentId, operatorId, now, now);
  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Cron', 'cron', 'active', ?, 1, ?, ?)",
  ).run(channelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, operatorId, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
  ).run(channelId, agentId, now);
  db.close();
  return { collabDbPath: dbPath, operatorId, agentId, channelId };
}

function messagePostedRows(dbPath: string, channelId: string): Array<{ actorPrincipalId: string; text: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT actor_principal_id AS actorPrincipalId, content_json AS contentJson
           FROM collab_events WHERE channel_id = ? AND kind = 'message_posted' ORDER BY channel_seq ASC`,
      )
      .all(channelId) as Array<{ actorPrincipalId: string; contentJson: string }>;
    return rows.map((r) => ({ actorPrincipalId: r.actorPrincipalId, text: JSON.parse(r.contentJson).text }));
  } finally {
    db.close();
  }
}

function scheduleRunRows(dbPath: string, scheduleId: string): Array<{ fireSeq: number; state: string; refusalReason: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT fire_seq AS fireSeq, state, refusal_reason AS refusalReason
           FROM collab_agent_schedule_runs WHERE schedule_id = ? ORDER BY fire_seq ASC`,
      )
      .all(scheduleId) as Array<{ fireSeq: number; state: string; refusalReason: string | null }>;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Source-level: the FRONTIER fence is unconditional (mirrors
// autoReplyDispatcher.ts's own proven pattern for this exact claim).
// ---------------------------------------------------------------------------
describe('CRON — FRONTIER fence (structural)', () => {
  it('STRUCTURAL: runScheduledTurn hardcodes tier to OLLAMA_LOCAL, never derived from router output', () => {
    const src = readFileSync(CRON_DISPATCHER_SRC, 'utf8');
    expect(src).toContain(`tier: 'OLLAMA_LOCAL' as ComputeTier`);
    // The router's own evaluateRequest result is spread FIRST, then tier is
    // overwritten -- so even if the router computed FRONTIER for this
    // prompt, the object dispatch() receives cannot carry it. Assert the
    // spread-then-override shape, not just the literal's presence, so a
    // regression that reordered this (override-then-spread, which would let
    // the router's tier win) is caught.
    const m = src.match(/const diag: RouterDiagnostics = \{ \.\.\.router\.evaluateRequest\(request\), tier: 'OLLAMA_LOCAL' as ComputeTier \};/);
    expect(m, 'CRON REGRESSION: the FRONTIER fence pattern (spread router output, then override tier) is missing or reordered').toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Unit-level: the cron primitives against the REAL BUILT dist artifact.
// ---------------------------------------------------------------------------
describe('CRON — collab primitives (dist artifact)', () => {
  let collab: typeof import('../packages/collab/dist/index.js');
  beforeAll(async () => {
    collab = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'index.js')).href) as any;
  });

  it('claimScheduleFire: POSITIVE CONTROL first claim succeeds; a duplicate claim at the SAME expectedFireSeq is refused (idempotency)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torq-cron-claim-'));
    const dbPath = join(dir, 'collab.db');
    const seeded = seedChannel(dbPath);
    const db = new Database(dbPath);
    try {
      collab.createSchedule(db, {
        id: 'sched-1', channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
        createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null, idempotencyKey: randomUUID(), nowIso: nowIso(),
      });
      const first = collab.claimScheduleFire(db, { scheduleId: 'sched-1', expectedFireSeq: 0, intervalSeconds: 60, nowIso: nowIso() });
      expect(first, 'first claim at fireSeq 0->1 must succeed').toBe(1);

      // ATTACK: re-claim at the SAME expectedFireSeq (0) again -- the
      // schedule row has already advanced to next_fire_seq=1, so this must
      // lose the optimistic-concurrency race.
      const replay = collab.claimScheduleFire(db, { scheduleId: 'sched-1', expectedFireSeq: 0, intervalSeconds: 60, nowIso: nowIso() });
      expect(replay, 'a second claim at an already-consumed expectedFireSeq must be refused').toBeNull();

      // POSITIVE CONTROL: claiming at the NEW correct expectedFireSeq (1) succeeds.
      const second = collab.claimScheduleFire(db, { scheduleId: 'sched-1', expectedFireSeq: 1, intervalSeconds: 60, nowIso: nowIso() });
      expect(second, 'a claim at the CORRECT advanced expectedFireSeq must succeed').toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claimScheduleFire refuses when the schedule is stopped -- POSITIVE CONTROL: an active schedule claims fine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torq-cron-stopped-'));
    const dbPath = join(dir, 'collab.db');
    const seeded = seedChannel(dbPath);
    const db = new Database(dbPath);
    try {
      collab.createSchedule(db, {
        id: 'sched-a', channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
        createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null, idempotencyKey: randomUUID(), nowIso: nowIso(),
      });
      collab.setScheduleState(db, 'sched-a', 'stopped', nowIso());
      const attack = collab.claimScheduleFire(db, { scheduleId: 'sched-a', expectedFireSeq: 0, intervalSeconds: 60, nowIso: nowIso() });
      expect(attack, 'a stopped schedule must never be claimable').toBeNull();

      collab.setScheduleState(db, 'sched-a', 'active', nowIso());
      const control = collab.claimScheduleFire(db, { scheduleId: 'sched-a', expectedFireSeq: 0, intervalSeconds: 60, nowIso: nowIso() });
      expect(control, 'positive control: re-activated schedule claims fine').toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NB-4 (G2A-OPUS48-CRON.md): findStrandedScheduleRuns joins the OWNING schedule\'s promptHint, RED against the pre-fix SELECT that carried no promptHint column at all', () => {
    // RED reproduced against unfixed source: the pre-fix SELECT in
    // packages/collab/src/cron.ts had no `s.prompt_hint AS promptHint`
    // projection and no JOIN to collab_agent_schedules, so `(row as any)
    // .promptHint` was `undefined` for every stranded run -- silently
    // dropping the operator's note on exactly the turn that already failed
    // once (cronDispatcher.ts:406 previously hardcoded `null`). This test
    // pins the fixed shape: a schedule created WITH a promptHint produces a
    // stranded-run row that carries that SAME promptHint, and a schedule
    // created WITHOUT one carries null (never undefined, never a stale
    // value from a different schedule).
    const dir = mkdtempSync(join(tmpdir(), 'torq-cron-nb4-'));
    const dbPath = join(dir, 'collab.db');
    const seeded = seedChannel(dbPath);
    const db = new Database(dbPath);
    try {
      const hintedId = 'sched-hinted';
      const bareId = 'sched-bare';
      collab.createSchedule(db, {
        id: hintedId, channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
        createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: 'NB-4 operator note',
        idempotencyKey: randomUUID(), nowIso: nowIso(),
      });
      collab.createSchedule(db, {
        id: bareId, channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
        createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null,
        idempotencyKey: randomUUID(), nowIso: nowIso(),
      });

      // Manufacture a STRANDED row directly (claim + record-dispatched, then
      // backdate fired_at past the grace window) -- isolates
      // findStrandedScheduleRuns from tickSchedules/the dispatcher, per this
      // describe block's "collab primitives" scope.
      const past = new Date(Date.now() - 120_000).toISOString();
      for (const scheduleId of [hintedId, bareId]) {
        const fireSeq = collab.claimScheduleFire(db, { scheduleId, expectedFireSeq: 0, intervalSeconds: 60, nowIso: past })!;
        expect(fireSeq, `claim must succeed for ${scheduleId}`).toBe(1);
        const recorded = collab.recordScheduleRunDispatched(db, {
          scheduleId, fireSeq, channelId: seeded.channelId, agentPrincipalId: seeded.agentId, nowIso: past,
        });
        expect(recorded).toBe(true);
      }

      const stranded = collab.findStrandedScheduleRuns(db, nowIso(), 30);
      const hintedRun = stranded.find((r: any) => r.scheduleId === hintedId);
      const bareRun = stranded.find((r: any) => r.scheduleId === bareId);
      expect(hintedRun, 'the hinted schedule must be found stranded').toBeTruthy();
      expect(bareRun, 'the bare schedule must be found stranded').toBeTruthy();
      expect((hintedRun as any).promptHint, 'THE LOAD-BEARING ASSERTION: promptHint must be joined in, not dropped').toBe('NB-4 operator note');
      expect((bareRun as any).promptHint).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NB-4: recoverStrandedScheduleRuns passes the stranded run\'s OWN promptHint, never a hardcoded null (source-level pin on cronDispatcher.ts)', () => {
    // Structural pin, mirroring this file's own FRONTIER-fence structural
    // test just above: the fixed call site must read `run.promptHint`, and
    // must NOT pass a literal `null` for promptHint at that call.
    const src = readFileSync(CRON_DISPATCHER_SRC, 'utf8');
    const m = src.match(/await runScheduledTurn\(store, db, run\.scheduleId, run\.fireSeq, run\.channelId, run\.agentPrincipalId, ([^)]+)\);/);
    expect(m, 'recoverStrandedScheduleRuns\' runScheduledTurn call site not found -- was it refactored?').toBeTruthy();
    const promptHintArg = m![1].trim();
    expect(promptHintArg, 'NB-4 REGRESSION: recoverStrandedScheduleRuns must pass run.promptHint, not a hardcoded null').toBe('run.promptHint');
  });

  it('assertScheduleStillAuthorized: WAKE-TIME re-evaluation refuses on membership removal, STOP (both scopes), and inactive principal -- each with a POSITIVE CONTROL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torq-cron-wake-'));
    const dbPath = join(dir, 'collab.db');
    const seeded = seedChannel(dbPath);
    const db = new Database(dbPath);
    try {
      // POSITIVE CONTROL: fresh membership, no STOP -- authorized.
      expect(collab.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId }))
        .toEqual({ ok: true });

      // ATTACK 1: channel-scoped STOP.
      db.prepare(
        "INSERT INTO collab_autoreply_stop(scope, channel_id, stopped_by_principal_id, stopped_at) VALUES ('channel', ?, ?, ?)",
      ).run(seeded.channelId, seeded.operatorId, nowIso());
      expect(collab.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId }))
        .toEqual({ ok: false, reason: 'stop-channel' });
      db.prepare("DELETE FROM collab_autoreply_stop WHERE scope='channel'").run();
      // Restored: positive control again.
      expect(collab.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId }).ok).toBe(true);

      // ATTACK 2: global STOP.
      db.prepare(
        "INSERT INTO collab_autoreply_stop(scope, channel_id, stopped_by_principal_id, stopped_at) VALUES ('global', NULL, ?, ?)",
      ).run(seeded.operatorId, nowIso());
      expect(collab.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId }))
        .toEqual({ ok: false, reason: 'stop-global' });
      db.prepare("DELETE FROM collab_autoreply_stop WHERE scope='global'").run();
      expect(collab.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId }).ok).toBe(true);

      // ATTACK 3: membership removed (state -> 'removed') -- the WAKE-TIME
      // property under test: a schedule referencing a since-revoked
      // membership must be refused, not admitted from schedule-row state.
      db.prepare("UPDATE collab_members SET state='removed', removed_at=? WHERE channel_id=? AND principal_id=?")
        .run(nowIso(), seeded.channelId, seeded.agentId);
      expect(collab.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId }))
        .toEqual({ ok: false, reason: 'membership-inactive' });
      db.prepare("UPDATE collab_members SET state='active', removed_at=NULL WHERE channel_id=? AND principal_id=?")
        .run(seeded.channelId, seeded.agentId);
      expect(collab.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId }).ok).toBe(true);

      // ATTACK 4: principal status inactive (revoked).
      db.prepare("UPDATE principals SET status='revoked' WHERE id=?").run(seeded.agentId);
      expect(collab.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId }))
        .toEqual({ ok: false, reason: 'principal-inactive' });
      db.prepare("UPDATE principals SET status='active' WHERE id=?").run(seeded.agentId);
      expect(collab.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId }).ok).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mutation, FALSIFIED: removing the membership-state check from the BUILT dist artifact turns the wake-time refusal RED, then is restored', async () => {
    const cronDistPath = join(COLLAB_DIST_DIR, 'cron.js');
    const original = readFileSync(cronDistPath, 'utf8');
    const marker = "memberState !== 'active'";
    expect(original.includes(marker), 'expected marker to exist in built dist for the mutation to apply').toBe(true);
    const mutated = original.replace(`if (row.memberState !== 'active')`, `if (false)`);
    expect(mutated, 'the mutation must actually change the artifact text').not.toBe(original);
    writeFileSync(cronDistPath, mutated, 'utf8');
    try {
      const mutatedModule: any = await import(pathToFileURL(cronDistPath).href + '?bust=' + Date.now());
      const dir = mkdtempSync(join(tmpdir(), 'torq-cron-mut-'));
      const dbPath = join(dir, 'collab.db');
      const seeded = seedChannel(dbPath);
      const db = new Database(dbPath);
      try {
        db.prepare("UPDATE collab_members SET state='removed', removed_at=? WHERE channel_id=? AND principal_id=?")
          .run(nowIso(), seeded.channelId, seeded.agentId);
        // RED: with the membership-state check neutered, a removed agent's
        // schedule is still reported authorized.
        const result = mutatedModule.assertScheduleStillAuthorized(db, { channelId: seeded.channelId, agentPrincipalId: seeded.agentId });
        expect(result).toEqual({ ok: true });
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      writeFileSync(cronDistPath, original, 'utf8');
      expect(readFileSync(cronDistPath, 'utf8')).toBe(original);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: tickSchedules() through the REAL dispatcher, mirroring
// agent-participation-a3c.test.ts's seam discipline exactly -- only
// dispatch() is replaced; every admission/profile/tool-policy path is real.
// ---------------------------------------------------------------------------
describe('CRON — end-to-end (real dispatcher, real profile, committed rows)', () => {
  let dataDir: string;
  let seeded: Seeded;
  let collab: typeof import('../packages/collab/dist/index.js');
  let bridge: typeof import('../packages/bridge/dist/index.js');
  let collabSurface: typeof import('../packages/gateway/dist/collabSurface.js');
  let collabAgentTools: typeof import('../packages/gateway/dist/collabAgentTools.js');
  let cronDispatcher: typeof import('../packages/gateway/dist/cronDispatcher.js');
  let cronScheduleHandler: typeof import('../packages/gateway/dist/cronScheduleHandler.js');
  let events: typeof import('../packages/gateway/dist/events.js');
  let storage: typeof import('../packages/gateway/dist/storage.js');

  const PREV_ENV: Record<string, string | undefined> = {};
  function setEnv(key: string, value: string) {
    if (!(key in PREV_ENV)) PREV_ENV[key] = process.env[key];
    process.env[key] = value;
  }

  let script: string | null | 'REQUIRE_APPROVAL';
  let observedRefusals: string[] = [];

  // Extracted so the NB-1 poison-router test (below) can temporarily install
  // a CAPTURING override and then restore this exact standard one afterward
  // -- every other test in this describe block depends on this override
  // being installed, so NB-1 must put it back, not merely clear it to null.
  function installStandardDispatchOverride(): void {
    cronDispatcher.setCronDispatchForTest((req: any, _diag: any) => {
      void (async () => {
        events.taskStore.create(req, _diag);
        try {
          if (script === 'REQUIRE_APPROVAL') {
            events.taskStore.complete(req.id, '', { blockedOn: 'collab__post_message' });
            return;
          }
          if (script !== null) {
            try {
              await bridge.executeTool(
                'collab__post_message',
                { channelId: seeded.channelId, text: script },
                req.effectiveProfile,
                seeded.agentId,
              );
            } catch (toolErr: any) {
              observedRefusals.push(String(toolErr?.message ?? toolErr));
              throw toolErr;
            }
          }
          events.taskStore.complete(req.id, 'ok', {});
        } catch (err) {
          events.taskStore.fail(req.id, String((err as any)?.message ?? err));
        }
      })();
    });
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'torq-cron-e2e-'));
    const pepper = Buffer.alloc(32, 0x61);
    const collabDbPath = join(dataDir, 'collab.db');
    seeded = seedChannel(collabDbPath);

    setEnv('TORQCLAW_DATA_DIR', dataDir);
    setEnv('TORQCLAW_COLLAB_DB_PATH', collabDbPath);
    setEnv('TORQCLAW_COLLAB_ENABLED', '1');
    setEnv('TORQCLAW_COLLAB_SURFACE_COMMANDS', '1');
    setEnv('TORQCLAW_AGENT_PARTICIPATION', '1');
    setEnv('TORQCLAW_AGENT_CRON', '1');
    setEnv('TORQCLAW_COLLAB_TEST_PEPPER', pepper.toString('base64'));

    collab = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'index.js')).href) as any;
    bridge = await import(pathToFileURL(join(BRIDGE_DIST_DIR, 'index.js')).href) as any;
    collabSurface = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'collabSurface.js')).href) as any;
    collabAgentTools = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'collabAgentTools.js')).href) as any;
    cronDispatcher = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'cronDispatcher.js')).href) as any;
    cronScheduleHandler = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'cronScheduleHandler.js')).href) as any;
    events = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'events.js')).href) as any;
    storage = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'storage.js')).href) as any;

    const { setCollabSecretStoreForTest } = await import(
      pathToFileURL(join(GATEWAY_DIST_DIR, 'collabIdentity.js')).href
    ) as any;
    const { InMemorySecretStore } = collab as any;
    const secretStore = new InMemorySecretStore();
    secretStore.set('TORQCLAW/principal-pepper', pepper);
    setCollabSecretStoreForTest(secretStore);

    await bridge.connectInProcessServer(
      collabAgentTools.COLLAB_AGENT_SERVER_ID,
      collabAgentTools.buildCollabAgentMcpServer(),
      { capabilities: collabAgentTools.COLLAB_AGENT_TOOL_CAPABILITIES },
    );

    // THE SEAM: replace ONLY dispatch(), identical to A3-c's discipline.
    // 'REQUIRE_APPROVAL' simulates a gated tool call by writing the EXACT
    // task-row shape dispatch.ts's own ToolApprovalRequired branch writes
    // (state='completed', telemetry_json={"blockedOn": "..."}) -- this is
    // NOT a fabricated shortcut for the third-state test: it is the same
    // committed-row shape production writes, reproduced here because this
    // override stands in for "what a model decided to call", not for
    // dispatch.ts's own approval-branch logic (which is untouched real code
    // exercised elsewhere in this repo's C2/S0 suites).
    installStandardDispatchOverride();
  }, 60000);

  afterEach(() => {
    script = null;
    observedRefusals = [];
    const db = collabSurface.getCollabDbForAutoReply();
    if (db) {
      // Test isolation: schedules are created against the ONE beforeAll-seeded
      // channel across every test in this describe block (a fresh channel per
      // test would duplicate the expensive module/bridge setup for no benefit
      // -- these tests are already narrowly scoped to one dispatcher call
      // each). Stop every schedule this test created so a later test's
      // tickSchedules() call cannot pick up a still-due row left behind by
      // an earlier test and contaminate its post-count/run-state assertions.
      db.prepare(`UPDATE collab_agent_schedules SET state = 'stopped' WHERE channel_id = ?`).run(seeded.channelId);
      collab.clearAutoreplyStop(db, 'global', null);
      collab.clearAutoreplyStop(db, 'channel', seeded.channelId);
    }
  });

  async function waitForRunTerminal(scheduleId: string, fireSeq: number, timeoutMs = 8000): Promise<{ state: string; refusalReason: string | null }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = scheduleRunRows(seeded.collabDbPath, scheduleId);
      const row = rows.find((r) => r.fireSeq === fireSeq);
      if (row && row.state !== 'dispatched') return row;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for schedule run to resolve; rows=${JSON.stringify(rows)} observedRefusals=${JSON.stringify(observedRefusals)}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('a scheduled turn fires, posts, and the post is a COMMITTED collab_events row', async () => {
    script = 'Scheduled check-in: all clear.';
    const db = collabSurface.getCollabDbForAutoReply()!;
    const scheduleId = randomUUID();
    collab.createSchedule(db, {
      id: scheduleId, channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
      createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: 'daily check-in',
      idempotencyKey: randomUUID(),
      nowIso: new Date(Date.now() - 120_000).toISOString(), // already due
    });

    const claimed = await cronDispatcher.tickSchedules();
    expect(claimed, 'tickSchedules must claim exactly the one due schedule').toBe(1);

    const terminal = await waitForRunTerminal(scheduleId, 1);
    expect(terminal.state).toBe('completed');
    expect(observedRefusals, `must complete with zero policy refusals; got ${JSON.stringify(observedRefusals)}`).toEqual([]);

    const posts = messagePostedRows(seeded.collabDbPath, seeded.channelId);
    expect(posts.length, 'THE LOAD-BEARING ASSERTION: a real collab_events row, not an emitted frame').toBe(1);
    expect(posts[0]!.actorPrincipalId).toBe(seeded.agentId);
    expect(posts[0]!.text).toBe('Scheduled check-in: all clear.');
  }, 20000); // NOTE: this test runs first in file order and is the only one
  // that asserts an ABSOLUTE post count -- every later test below measures a
  // DELTA from its own baseline, since they share seeded.channelId across
  // the whole describe block (see afterEach's schedule-stop comment for why
  // that sharing is safe for RUN state but not for a bare event count).

  it('NB-1 (G2A-OPUS48-CRON.md): the FRONTIER fence survives a POISONED router -- behavioral, not source-text-only', async () => {
    // The shipped structural test (CRON_DISPATCHER_SRC pattern match, above)
    // pins the SOURCE TEXT but was flagged by G1R/G2A as unable to catch a
    // regression that changed the override's semantics while keeping the
    // literal string intact. This reproduces G2A's own verifier-owned probe
    // as a PERMANENT test: monkey-patch router.evaluateRequest on the SAME
    // module instance the built cronDispatcher.js imports (via the
    // pnpm-workspace-linked @torqclaw/router dist) to always return
    // tier:'FRONTIER', fire a real due schedule through tickSchedules(), and
    // capture the diag object actually reaching the dispatch() seam.
    //
    // POSITIVE CONTROL: assert the poison is live (evaluateRequest really
    // does return FRONTIER) so a router that silently ignored the patch
    // cannot make this test pass vacuously.
    const routerModule = await import(
      pathToFileURL(join(REPO_ROOT, 'packages', 'router', 'dist', 'engine.js')).href
    ) as any;
    const originalEvaluateRequest = routerModule.router.evaluateRequest;

    let observedDiagTier: string | null = null;
    cronDispatcher.setCronDispatchForTest((req: any, diag: any) => {
      observedDiagTier = diag.tier;
      void (async () => {
        events.taskStore.create(req, diag);
        events.taskStore.complete(req.id, 'ok', {});
      })();
    });

    try {
      routerModule.router.evaluateRequest = () => ({
        score: 1,
        reason: 'NB-1 poison probe',
        tier: 'FRONTIER',
      });

      // POSITIVE CONTROL: the poison is live on the exact instance cron uses.
      const poisoned = routerModule.router.evaluateRequest({} as any);
      expect(poisoned.tier, 'positive control: the router poison must be observably live').toBe('FRONTIER');

      script = null;
      const scheduleId = randomUUID();
      const db = collabSurface.getCollabDbForAutoReply()!;
      collab.createSchedule(db, {
        id: scheduleId, channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
        createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null,
        idempotencyKey: randomUUID(), nowIso: new Date(Date.now() - 120_000).toISOString(),
      });

      const claimed = await cronDispatcher.tickSchedules();
      expect(claimed, 'tickSchedules must claim the due schedule despite the poisoned router').toBe(1);

      await waitForRunTerminal(scheduleId, 1);

      expect(observedDiagTier, 'THE LOAD-BEARING ASSERTION: with the router forced to FRONTIER, the tier reaching the dispatch seam must still be OLLAMA_LOCAL -- the spread-then-override fence at cronDispatcher.ts must win').toBe('OLLAMA_LOCAL');
      expect(observedDiagTier).not.toBe('FRONTIER');
    } finally {
      routerModule.router.evaluateRequest = originalEvaluateRequest;
      // Verify the restore, not just perform it: prove the router instance
      // is byte-identical to its pre-poison behavior before this test exits,
      // so a later test in this file cannot silently inherit the poison.
      const restored = routerModule.router.evaluateRequest === originalEvaluateRequest;
      expect(restored, 'router.evaluateRequest must be restored to the original bound function').toBe(true);
      // Every OTHER test in this describe block depends on the STANDARD
      // capturing override (installed in beforeAll) being in place -- put it
      // back rather than leaving this test's tier-capturing override
      // installed, which would silently break every test that runs after
      // this one in file order.
      installStandardDispatchOverride();
    }
  }, 20000);

  it('a due schedule does NOT fire while STOPPED (channel scope) -- POSITIVE CONTROL: the SAME schedule fires once STOP is cleared', async () => {
    const baseline = messagePostedRows(seeded.collabDbPath, seeded.channelId).length;
    script = 'should not be reachable while stopped';
    const db = collabSurface.getCollabDbForAutoReply()!;
    const scheduleId = randomUUID();
    collab.createSchedule(db, {
      id: scheduleId, channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
      createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null, idempotencyKey: randomUUID(),
      nowIso: new Date(Date.now() - 120_000).toISOString(),
    });
    collab.setAutoreplyStop(db, { scope: 'channel', channelId: seeded.channelId, stoppedByPrincipalId: seeded.operatorId, nowIso: nowIso() });

    const claimedWhileStopped = await cronDispatcher.tickSchedules();
    expect(claimedWhileStopped, 'STOP must still let the fire be CLAIMED (watermark advances)').toBe(1);
    const terminal = await waitForRunTerminal(scheduleId, 1);
    expect(terminal.state, 'a STOPPED channel must refuse the wake, resolving to terminated').toBe('terminated');
    expect(terminal.refusalReason).toBe('stop-channel');
    expect(messagePostedRows(seeded.collabDbPath, seeded.channelId).length, 'zero NEW posts while stopped').toBe(baseline);

    // POSITIVE CONTROL: clear STOP, the schedule is due again next interval
    // (already past its new next_fire_at since interval=60s and we waited),
    // seed a fresh due time to keep the control deterministic and fast.
    collab.clearAutoreplyStop(db, 'channel', seeded.channelId);
    db.prepare(`UPDATE collab_agent_schedules SET next_fire_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), scheduleId);
    script = 'now reachable';
    const claimedAfterClear = await cronDispatcher.tickSchedules();
    expect(claimedAfterClear).toBe(1);
    const terminal2 = await waitForRunTerminal(scheduleId, 2);
    expect(terminal2.state, 'positive control: with STOP cleared the SAME schedule fires and completes').toBe('completed');
    expect(messagePostedRows(seeded.collabDbPath, seeded.channelId).length, 'exactly ONE new post after the control fire').toBe(baseline + 1);
  }, 20000);

  it('membership revoked between schedule creation and wake is refused AT WAKE, never admitted from stale schedule-row state', async () => {
    const baseline = messagePostedRows(seeded.collabDbPath, seeded.channelId).length;
    script = 'should never post';
    const db = collabSurface.getCollabDbForAutoReply()!;
    const scheduleId = randomUUID();
    // Created while the agent IS an active member.
    collab.createSchedule(db, {
      id: scheduleId, channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
      createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null, idempotencyKey: randomUUID(),
      nowIso: new Date(Date.now() - 120_000).toISOString(),
    });
    // Membership revoked AFTER creation, BEFORE the wake.
    db.prepare("UPDATE collab_members SET state='removed', removed_at=? WHERE channel_id=? AND principal_id=?")
      .run(nowIso(), seeded.channelId, seeded.agentId);

    const claimed = await cronDispatcher.tickSchedules();
    expect(claimed, 'the fire must still be claimed (watermark advances even on refusal)').toBe(1);
    const terminal = await waitForRunTerminal(scheduleId, 1);
    expect(terminal.state, 'a revoked membership must refuse the wake').toBe('terminated');
    expect(terminal.refusalReason).toBe('membership-inactive');
    expect(messagePostedRows(seeded.collabDbPath, seeded.channelId).length, 'zero NEW posts').toBe(baseline);

    // POSITIVE CONTROL: restore membership, the mechanism is not universally broken.
    db.prepare("UPDATE collab_members SET state='active', removed_at=NULL WHERE channel_id=? AND principal_id=?")
      .run(seeded.channelId, seeded.agentId);
    db.prepare(`UPDATE collab_agent_schedules SET next_fire_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), scheduleId);
    script = 'membership restored';
    const claimed2 = await cronDispatcher.tickSchedules();
    expect(claimed2).toBe(1);
    const terminal2 = await waitForRunTerminal(scheduleId, 2);
    expect(terminal2.state, 'positive control: restored membership fires and completes').toBe('completed');
  }, 20000);

  it('G1R B-C2: an ARCHIVED channel is refused AT WAKE with a reason -- never the silent no_post that is byte-identical to choosing silence', async () => {
    const baseline = messagePostedRows(seeded.collabDbPath, seeded.channelId).length;
    script = 'should never post';
    const db = collabSurface.getCollabDbForAutoReply()!;
    const scheduleId = randomUUID();
    collab.createSchedule(db, {
      id: scheduleId, channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
      createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null, idempotencyKey: randomUUID(),
      nowIso: new Date(Date.now() - 120_000).toISOString(),
    });
    // Archived AFTER creation, BEFORE the wake.
    db.prepare("UPDATE collab_channels SET state='archived' WHERE id=?").run(seeded.channelId);

    const claimed = await cronDispatcher.tickSchedules();
    expect(claimed, 'the fire is still claimed -- the watermark advances even on refusal').toBe(1);
    const terminal = await waitForRunTerminal(scheduleId, 1);

    // THE ASSERTION. Before the fix this recorded state='no_post',
    // refusalReason=null -- indistinguishable from the agent legitimately
    // choosing silence (A3-f) -- while the substrate had already refused the
    // write with COLLAB_CHANNEL_ARCHIVED. The gateway knew the reason and
    // recorded none of it, and nothing deactivates a schedule, so it re-fired
    // against a dead channel forever, burning a real model call each time.
    expect(
      terminal.state,
      'B-C2 REGRESSION: an archived channel resolved to the SILENT residual instead of a '
      + 'refusal. A structural inability to act must never resolve to the same state as a '
      + 'deliberate choice not to act.',
    ).toBe('terminated');
    expect(terminal.refusalReason).toBe('channel-archived');
    expect(messagePostedRows(seeded.collabDbPath, seeded.channelId).length, 'zero NEW posts').toBe(baseline);

    // POSITIVE CONTROL -- without it, every assertion above passes against a
    // build that refuses every wake for any reason.
    db.prepare("UPDATE collab_channels SET state='active' WHERE id=?").run(seeded.channelId);
    db.prepare(`UPDATE collab_agent_schedules SET next_fire_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), scheduleId);
    script = 'posting again now the channel is active';
    await cronDispatcher.tickSchedules();
    const revived = await waitForRunTerminal(scheduleId, 2);
    expect(revived.state, 'the unarchived channel must fire normally -- the refusal is specific').toBe('completed');
  }, 30000);

  it('G2A C-1: a retry with the SAME idempotencyKey does NOT mint a second schedule -- the field is load-bearing, not decorative', async () => {
    const db = collabSurface.getCollabDbForAutoReply()!;
    const key = randomUUID();
    const countSchedules = () => (db
      .prepare('SELECT COUNT(*) AS n FROM collab_agent_schedules WHERE created_by_principal_id = ?')
      .get(seeded.operatorId) as { n: number }).n;
    const before = countSchedules();

    const first = collab.createSchedule(db, {
      id: randomUUID(), channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
      createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null,
      idempotencyKey: key, nowIso: nowIso(),
    });
    expect(first.replayed).toBe(false);
    expect(countSchedules(), 'the first create must actually create').toBe(before + 1);

    // THE RETRY. A client following this repo's own retry-with-the-same-key
    // discipline -- the pattern S3 built for exactly this -- previously minted
    // a SECOND schedule here. On a schedule that means double fires, double
    // model calls and possibly double posts, INDEFINITELY and UNATTENDED. A
    // duplicated message is noise; a duplicated schedule keeps acting.
    const retry = collab.createSchedule(db, {
      id: randomUUID(), // a NEW row id, exactly as the handler mints per call
      channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
      createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null,
      idempotencyKey: key, nowIso: nowIso(),
    });
    expect(
      countSchedules(),
      'C-1 REGRESSION: a retry with the same idempotencyKey created a SECOND schedule. '
      + 'It will fire forever alongside the first, unattended.',
    ).toBe(before + 1);
    expect(retry.replayed, 'the retry must be reported as a replay, not a fresh create').toBe(true);
    expect(retry.scheduleId, 'a replay must return the ORIGINAL schedule id').toBe(first.scheduleId);

    // POSITIVE CONTROL -- a genuinely DIFFERENT key must still create, or the
    // assertions above are satisfied by a build that refuses every create.
    const other = collab.createSchedule(db, {
      id: randomUUID(), channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
      createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null,
      idempotencyKey: randomUUID(), nowIso: nowIso(),
    });
    expect(other.replayed).toBe(false);
    expect(countSchedules(), 'a different key must still create').toBe(before + 2);
  });

  it('G1R B-C1: handleCreateSchedule is TOTAL -- a store-layer failure returns a typed error, never a throw that would kill the process', async () => {
    // This gateway has NO unhandledRejection net (verified: only comments note
    // its absence), and server.ts's socket.on('message') wraps only JSON.parse
    // -- the switch carrying the cron arms is unguarded. So a throw here does
    // not fail the command, it kills the GATEWAY.
    //
    // handleCreateSchedule called assertScheduleStillAuthorized OUTSIDE its own
    // try, and was the only one of the three cron handlers that did. G1R proved
    // the asymmetry: against an unmigrated handle this threw while both
    // siblings returned COLLAB_UNAVAILABLE.
    const unmigrated = new Database(':memory:');
    runCollaborationMigration(unmigrated); // core tables ONLY -- no autoreply/cron migration
    const handle = {
      prepare: (sql: string) => unmigrated.prepare(sql),
      exec: (sql: string) => unmigrated.exec(sql),
      transaction: (fn: never) => unmigrated.transaction(fn) as never,
    } as never;

    // AWAITED deliberately: the handler is async, so a synchronous call would
    // return a pending Promise and the assertions below would inspect the
    // wrong object -- passing whether or not it rejects. Awaiting inside the
    // try is what makes a rejection observable as a throw.
    let threw: unknown = null;
    let returned: unknown = null;
    try {
      returned = await cronScheduleHandler.handleCreateSchedule(handle, seeded.operatorId, {
        channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
        intervalSeconds: 60, promptHint: null, idempotencyKey: randomUUID(),
      });
    } catch (e) { threw = e; }

    expect(
      threw,
      'B-C1 REGRESSION: handleCreateSchedule THREW. With no unhandledRejection net this '
      + 'escapes into the async socket handler and kills the gateway process -- an operator '
      + 'creating a schedule takes down the server.',
    ).toBeNull();
    expect((returned as { code?: string } | null)?.code).toBe('COLLAB_UNAVAILABLE');
    unmigrated.close();
  });

  it('THE THIRD STATE: a scheduled turn whose tool call is gated resolves to blocked_awaiting_approval -- never completed, never terminated, never silent', async () => {
    const baseline = messagePostedRows(seeded.collabDbPath, seeded.channelId).length;
    script = 'REQUIRE_APPROVAL';
    const db = collabSurface.getCollabDbForAutoReply()!;
    const scheduleId = randomUUID();
    collab.createSchedule(db, {
      id: scheduleId, channelId: seeded.channelId, agentPrincipalId: seeded.agentId,
      createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null, idempotencyKey: randomUUID(),
      nowIso: new Date(Date.now() - 120_000).toISOString(),
    });

    const claimed = await cronDispatcher.tickSchedules();
    expect(claimed).toBe(1);
    const terminal = await waitForRunTerminal(scheduleId, 1);
    expect(terminal.state, 'THE LOAD-BEARING ASSERTION: the third, explicitly distinguishable state').toBe('blocked_awaiting_approval');
    expect(terminal.state).not.toBe('completed');
    expect(terminal.state).not.toBe('terminated');
    expect(terminal.refusalReason).toBe('collab__post_message');
    // No NEW post committed -- the gated call never executed.
    expect(messagePostedRows(seeded.collabDbPath, seeded.channelId).length).toBe(baseline);
  }, 20000);

  it('CLAIM MECHANISM IS REAL: a schedule naming an agent with no live membership is claimed (watermark still advances) but then refused at wake, never silently skipped -- the structural counterpart to A3-c\'s trigger-disabled probe', async () => {
    // NB-2 (G2A-OPUS48-CRON.md): this test was previously titled
    // "FALSIFIABILITY: with dispatch() unreplaced (no override)...", which
    // overclaimed -- its own comment admits the setCronDispatchForTest
    // override stays in place throughout (removing it would hang on a real
    // Ollama call). Renamed to describe what the assertions actually prove:
    // the CLAIM mechanism is exercised for real (claimed=1, watermark
    // discipline), and a stranger agent with no membership row is refused
    // at WAKE-time authority, not admitted from a fixture that never really
    // claims anything.
    const baseline = messagePostedRows(seeded.collabDbPath, seeded.channelId).length;
    const db = collabSurface.getCollabDbForAutoReply()!;
    const scheduleId = randomUUID();
    const strangerAgent = randomUUID();
    const strangerNow = nowIso();
    db.prepare(
      "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'Stranger', ?, 'active', 1, NULL, ?, ?)",
    ).run(strangerAgent, seeded.operatorId, strangerNow, strangerNow);
    // A schedule naming an agent that was NEVER a member (bypassing
    // handleCreateSchedule's own create-time check, to isolate wake-time
    // enforcement from create-time enforcement).
    collab.createSchedule(db, {
      id: scheduleId, channelId: seeded.channelId, agentPrincipalId: strangerAgent,
      createdByPrincipalId: seeded.operatorId, intervalSeconds: 60, promptHint: null, idempotencyKey: randomUUID(),
      nowIso: new Date(Date.now() - 120_000).toISOString(),
    });
    script = 'must never post';
    const claimed = await cronDispatcher.tickSchedules();
    expect(claimed, 'the fire is still CLAIMED (watermark discipline)').toBe(1);
    const terminal = await waitForRunTerminal(scheduleId, 1);
    expect(terminal.state).toBe('terminated');
    expect(terminal.refusalReason).toBe('membership-not-found');
    expect(messagePostedRows(seeded.collabDbPath, seeded.channelId).length).toBe(baseline);
  }, 20000);
});
