/**
 * REVOKE MUST REACH CRON — zombie-schedule lifecycle.
 *
 * The defect: `revokeAgent` (packages/collab/src/store.ts) bumped auth_epoch,
 * revoked credentials, closed sessions and wrote audit -- and touched NO
 * schedule row. The FK at migration.ts's collab_agent_schedules
 * (agent_principal_id -> principals(id)) has no ON DELETE, and revoke is an
 * UPDATE anyway, so the FK is inert. There is no reaper and no sweep;
 * setScheduleState (cron.ts) is operator-manual only.
 *
 * The AUTHORITY check was never wrong. assertScheduleStillAuthorized re-reads
 * principals.status live at every wake and correctly refuses with
 * 'principal-inactive'. But refusing is not stopping: the schedule stayed
 * state='active', so findDueSchedules kept returning it and claimScheduleFire
 * kept advancing next_fire_at, burning one claim + one 'terminated' run row per
 * interval, forever, unattended. Correct refusal, absent lifecycle -- the same
 * residual shape G1R B-C2 found for archived channels.
 *
 * Everything below drives the REAL CollaborationStore.revokeAgent against the
 * REAL cron tables and the REAL cron read paths (findDueSchedules,
 * assertScheduleStillAuthorized, getSchedule) -- never a re-implementation of
 * the UPDATE under test -- and asserts on DATABASE ROWS, not return values. A
 * returned count says something was attempted; a row says it happened.
 *
 * Every assertion carries a POSITIVE CONTROL in the SAME test: a second,
 * NON-revoked agent whose schedule must still be 'active' and still due
 * afterwards. Without it "the schedule is stopped" passes equally against a
 * build that stops every schedule, and against a database in which the
 * schedule never existed.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  runCollaborationMigration,
  runAgentAutoreplyMigration,
  runAgentCronMigration,
} from '../../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../../packages/collab/src/store.js';
import {
  createSchedule,
  getSchedule,
  findDueSchedules,
  assertScheduleStillAuthorized,
} from '../../packages/collab/src/cron.js';

type Fixture = {
  sqlite: Database.Database;
  store: CollaborationStore;
  operatorCaller: CallerContext;
  channelId: string;
};

/**
 * Builds the store over a DB that has run BOTH the base collaboration
 * migration and the cron migration -- the same pair collabIdentity.ts applies
 * in production (runCollaborationMigration ... runAgentCronMigration last).
 */
function makeFixture(withCron = true): Fixture {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  if (withCron) {
    // Same pair, same order, collabIdentity.ts applies in production
    // (autoreply then cron last) -- assertScheduleStillAuthorized reads
    // collab_autoreply_stop, which the autoreply migration creates.
    runAgentAutoreplyMigration(sqlite);
    runAgentCronMigration(sqlite);
  }

  const db: BootstrapDb = {
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids('revoke-cron-fixture');

  const bootstrap = bootstrapOperator(
    { db, secretStore: new InMemorySecretStore(), clock, uuids, rng: nodeRandomSource },
    { operatorDisplayName: 'Operator', installationId: 'install-revoke-cron', schemaVersion: 1 }
  );

  const store = new CollaborationStore({
    db,
    clock,
    uuids,
    rng: nodeRandomSource,
    principalPepper: bootstrap.principalPepper,
  });

  const operatorCaller: CallerContext = { principalId: bootstrap.operatorPrincipalId, kind: 'operator' };

  const channelId = randomUUID();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Cron', 'cron', 'active', ?, 1, ?, ?)"
    )
    .run(channelId, operatorCaller.principalId, now, now);
  sqlite
    .prepare(
      "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)"
    )
    .run(channelId, operatorCaller.principalId, now);

  return { sqlite, store, operatorCaller, channelId };
}

/** Joins an agent to the fixture channel so wake-time authority can pass. */
function joinChannel(f: Fixture, agentPrincipalId: string): void {
  f.sqlite
    .prepare(
      "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)"
    )
    .run(f.channelId, agentPrincipalId, new Date().toISOString());
}

/** Reads the schedule row straight from the DB -- never from a return value. */
function scheduleRow(
  f: Fixture,
  scheduleId: string
): { state: string; agentPrincipalId: string; updatedAt: string } | undefined {
  return f.sqlite
    .prepare(
      'SELECT state, agent_principal_id AS agentPrincipalId, updated_at AS updatedAt FROM collab_agent_schedules WHERE id = ?'
    )
    .get(scheduleId) as { state: string; agentPrincipalId: string; updatedAt: string } | undefined;
}

describe('REVOKE_AGENT stops that agent’s schedules', () => {
  it('DB ROW: the revoked agent’s schedule is state=stopped, and the untouched agent’s is still active (positive control)', async () => {
    const f = makeFixture();

    const victim = await f.store.createAgent(f.operatorCaller, { displayName: 'Victim' }, 'idem-victim');
    const bystander = await f.store.createAgent(f.operatorCaller, { displayName: 'Bystander' }, 'idem-bystander');
    joinChannel(f, victim.principalId);
    joinChannel(f, bystander.principalId);

    const past = new Date(Date.now() - 3_600_000).toISOString();
    const victimScheduleId = randomUUID();
    const bystanderScheduleId = randomUUID();
    createSchedule(f.sqlite, {
      id: victimScheduleId,
      channelId: f.channelId,
      agentPrincipalId: victim.principalId,
      createdByPrincipalId: f.operatorCaller.principalId,
      intervalSeconds: 60,
      promptHint: null,
      idempotencyKey: randomUUID(),
      nowIso: past,
    });
    createSchedule(f.sqlite, {
      id: bystanderScheduleId,
      channelId: f.channelId,
      agentPrincipalId: bystander.principalId,
      createdByPrincipalId: f.operatorCaller.principalId,
      intervalSeconds: 60,
      promptHint: null,
      idempotencyKey: randomUUID(),
      nowIso: past,
    });

    // Baseline: BOTH rows are genuinely 'active' before the revoke. Without
    // this, "stopped afterwards" would also pass against a DB where the row
    // was never active in the first place.
    expect(scheduleRow(f, victimScheduleId)?.state).toBe('active');
    expect(scheduleRow(f, bystanderScheduleId)?.state).toBe('active');

    await f.store.revokeAgent(f.operatorCaller, { principalId: victim.principalId }, 'idem-revoke-victim');

    // THE ASSERTION: the row, not the result object.
    expect(scheduleRow(f, victimScheduleId)?.state).toBe('stopped');

    // POSITIVE CONTROL: a build that stopped everything fails here.
    expect(scheduleRow(f, bystanderScheduleId)?.state).toBe('active');

    // Read back through cron.ts's OWN reader too, so the fix is proven against
    // the accessor production actually uses, not only against raw SQL.
    expect(getSchedule(f.sqlite, victimScheduleId)?.state).toBe('stopped');
    expect(getSchedule(f.sqlite, bystanderScheduleId)?.state).toBe('active');
  });

  it('the stopped schedule no longer appears in findDueSchedules, while the control still does', async () => {
    const f = makeFixture();
    const victim = await f.store.createAgent(f.operatorCaller, { displayName: 'Victim2' }, 'idem-v2');
    const bystander = await f.store.createAgent(f.operatorCaller, { displayName: 'Bystander2' }, 'idem-b2');
    joinChannel(f, victim.principalId);
    joinChannel(f, bystander.principalId);

    const past = new Date(Date.now() - 3_600_000).toISOString();
    const victimScheduleId = randomUUID();
    const bystanderScheduleId = randomUUID();
    for (const [id, agentPrincipalId] of [
      [victimScheduleId, victim.principalId],
      [bystanderScheduleId, bystander.principalId],
    ] as const) {
      createSchedule(f.sqlite, {
        id,
        channelId: f.channelId,
        agentPrincipalId,
        createdByPrincipalId: f.operatorCaller.principalId,
        intervalSeconds: 60,
        promptHint: null,
        idempotencyKey: randomUUID(),
        nowIso: past,
      });
    }

    const now = new Date().toISOString();
    const dueBefore = findDueSchedules(f.sqlite, now).map((s) => s.id);
    expect(dueBefore).toContain(victimScheduleId);
    expect(dueBefore).toContain(bystanderScheduleId);

    await f.store.revokeAgent(f.operatorCaller, { principalId: victim.principalId }, 'idem-revoke-v2');

    // THIS is the burn the defect caused: a due schedule that can only ever
    // resolve 'terminated', re-claimed every interval, forever.
    const dueAfter = findDueSchedules(f.sqlite, now).map((s) => s.id);
    expect(dueAfter).not.toContain(victimScheduleId);
    // POSITIVE CONTROL: the tick is not simply dead.
    expect(dueAfter).toContain(bystanderScheduleId);

    // And the authority check is STILL correct and STILL the outer fence --
    // the lifecycle fix does not replace it. If a stopped schedule were ever
    // reactivated, wake-time authority still refuses the revoked principal.
    const authz = assertScheduleStillAuthorized(f.sqlite, {
      channelId: f.channelId,
      agentPrincipalId: victim.principalId,
    });
    expect(authz).toEqual({ ok: false, reason: 'principal-inactive' });
    expect(
      assertScheduleStillAuthorized(f.sqlite, {
        channelId: f.channelId,
        agentPrincipalId: bystander.principalId,
      })
    ).toEqual({ ok: true });
  });

  it('an already-stopped schedule is not re-touched, and the audit row carries stoppedScheduleCount', async () => {
    const f = makeFixture();
    const victim = await f.store.createAgent(f.operatorCaller, { displayName: 'Victim3' }, 'idem-v3');
    joinChannel(f, victim.principalId);

    const past = new Date(Date.now() - 3_600_000).toISOString();
    const activeId = randomUUID();
    const alreadyStoppedId = randomUUID();
    for (const id of [activeId, alreadyStoppedId]) {
      createSchedule(f.sqlite, {
        id,
        channelId: f.channelId,
        agentPrincipalId: victim.principalId,
        createdByPrincipalId: f.operatorCaller.principalId,
        intervalSeconds: 60,
        promptHint: null,
        idempotencyKey: randomUUID(),
        nowIso: past,
      });
    }
    // Operator had already stopped one by hand.
    f.sqlite
      .prepare("UPDATE collab_agent_schedules SET state = 'stopped', updated_at = ? WHERE id = ?")
      .run(past, alreadyStoppedId);
    const stoppedUpdatedAtBefore = scheduleRow(f, alreadyStoppedId)?.updatedAt;

    await f.store.revokeAgent(f.operatorCaller, { principalId: victim.principalId }, 'idem-revoke-v3');

    expect(scheduleRow(f, activeId)?.state).toBe('stopped');
    expect(scheduleRow(f, alreadyStoppedId)?.state).toBe('stopped');
    // WHERE state='active' means the already-stopped row keeps its original
    // updated_at -- the count reports schedules this revoke actually stopped.
    expect(scheduleRow(f, alreadyStoppedId)?.updatedAt).toBe(stoppedUpdatedAtBefore);

    const audit = f.sqlite
      .prepare("SELECT content_json AS contentJson FROM collab_audit WHERE kind = 'agent_revoked' ORDER BY seq DESC")
      .get() as { contentJson: string } | undefined;
    expect(audit, 'revoke must still write its agent_revoked audit row').toBeTruthy();
    const content = JSON.parse(audit!.contentJson) as Record<string, unknown>;
    expect(content.principalId).toBe(victim.principalId);
    // Existing fields preserved -- the audit SHAPE was extended, not replaced.
    expect(content.revokedCredentialCount).toBe(1);
    expect(content.stoppedScheduleCount).toBe(1);
  });

  it('revoke still succeeds on a collab DB that predates the cron migration', async () => {
    // CollaborationStore is constructible against a DB that has only run
    // runCollaborationMigration (tests/collab/store-identity.test.ts does
    // exactly that), and collabIdentity.ts applies the cron migration as a
    // separate later step. Revoking an agent must not become a hard failure
    // just because collab_agent_schedules does not exist yet.
    const f = makeFixture(false);
    expect(
      f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collab_agent_schedules'").get()
    ).toBeUndefined();

    const agent = await f.store.createAgent(f.operatorCaller, { displayName: 'NoCron' }, 'idem-nocron');
    const result = await f.store.revokeAgent(f.operatorCaller, { principalId: agent.principalId }, 'idem-revoke-nocron');
    expect(result.status).toBe('revoked');

    const row = f.sqlite.prepare('SELECT status FROM principals WHERE id = ?').get(agent.principalId) as {
      status: string;
    };
    expect(row.status).toBe('revoked');
    const audit = f.sqlite
      .prepare("SELECT content_json AS contentJson FROM collab_audit WHERE kind = 'agent_revoked' ORDER BY seq DESC")
      .get() as { contentJson: string };
    expect((JSON.parse(audit.contentJson) as Record<string, unknown>).stoppedScheduleCount).toBe(0);
  });
});

/**
 * GUARD — the creator case is safe ONLY because of principals_single_operator.
 *
 * A revoked CREATOR's schedules deliberately continue: authority derives from
 * the AGENT's live membership and status (exactly what
 * assertScheduleStillAuthorized reads), never from whoever created the
 * schedule. That is defensible TODAY only because the schema permits exactly
 * one operator (migration.ts's partial unique index) and all three principal
 * status writers route through getAgentTargetOrThrow, which throws
 * INVALID_REQUEST for a non-agent -- so the creator cannot normally be revoked
 * at all.
 *
 * If a future multi-operator migration lands, that reasoning silently
 * evaporates and creator-revocation becomes a real hole. This test must fail
 * LOUDLY at that moment rather than let it open unnoticed. It asserts the
 * index BEHAVIORALLY (a second operator INSERT is rejected), not merely that
 * a DDL string is present, so dropping enforcement while keeping the name is
 * also caught.
 */
describe('GUARD: single-operator invariant underwrites creator-revocation safety', () => {
  it('principals_single_operator exists, is UNIQUE+partial, and actually refuses a second operator', () => {
    const f = makeFixture();

    const index = f.sqlite
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'principals_single_operator'")
      .get() as { name: string; sql: string } | undefined;
    expect(
      index,
      'GUARD FAILED: principals_single_operator is gone. A revoked creator’s schedules are deliberately left running because only ONE operator can exist and getAgentTargetOrThrow refuses to revoke them. Without this index that reasoning no longer holds -- revokeAgent must be re-examined for creator-owned schedules before this guard is relaxed.'
    ).toBeTruthy();
    expect(index!.sql).toMatch(/UNIQUE INDEX/i);
    expect(index!.sql).toMatch(/WHERE\s+kind\s*=\s*'operator'/i);

    const list = f.sqlite.prepare('PRAGMA index_list(principals)').all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const entry = list.find((r) => r.name === 'principals_single_operator');
    expect(entry?.unique).toBe(1);
    expect(entry?.partial).toBe(1);

    // BEHAVIORAL: the index is enforcing, not merely present.
    const now = new Date().toISOString();
    expect(() =>
      f.sqlite
        .prepare(
          "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Second Operator', NULL, 'active', 1, NULL, ?, ?)"
        )
        .run(randomUUID(), now, now)
    ).toThrow(/UNIQUE constraint failed/i);

    // POSITIVE CONTROL: the INSERT shape itself is valid -- the rejection above
    // is the operator uniqueness rule, not a broken statement.
    const operatorId = (f.sqlite.prepare("SELECT id FROM principals WHERE kind = 'operator'").get() as { id: string })
      .id;
    expect(() =>
      f.sqlite
        .prepare(
          "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'An Agent', ?, 'active', 1, NULL, ?, ?)"
        )
        .run(randomUUID(), operatorId, now, now)
    ).not.toThrow();
  });

  it('getAgentTargetOrThrow still refuses to revoke the operator (the second half of the creator argument)', async () => {
    const f = makeFixture();
    await expect(
      f.store.revokeAgent(f.operatorCaller, { principalId: f.operatorCaller.principalId }, 'idem-revoke-op')
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
