/**
 * T-B1 (G1D PRD-007 S7/T4 packet, 2026-08-22, finding B-6) --
 * `resolveAgentTurn`'s recovery-lease predicate.
 *
 * Two-executor restart race: executor A claims a turn and is reclaimed by
 * the boot-time recovery sweep (simulating a crash + restart) with a FRESH
 * lease token minted for executor B. Executor A -- the STALE executor,
 * unaware it has been superseded -- then finishes its in-flight work and
 * calls `resolveAgentTurn(..., 'terminated', staleLease)`. Without the B-6
 * fix, that call has no lease predicate at all and would silently flip the
 * live (executor-B-owned) row to 'terminated', discarding a still-valid
 * turn out from under the executor that actually owns it. With the fix,
 * the stale call's `AND recovery_lease_token IS ?` predicate does not
 * match the row (whose `recovery_lease_token` is now B's fresh lease), so
 * it affects 0 rows and the row is left exactly as the reclaim set it.
 * Executor B then resolves with the fresh lease and DOES succeed --
 * proving the predicate discriminates by lease rather than merely refusing
 * every resolve unconditionally.
 *
 * Driven against the REAL BUILT dist artifact (packages/collab/dist) --
 * never a hand-rolled replica -- per this repo's "verify the artifact, not
 * the unit test" discipline, matching
 * tests/agent-participation-s3.test.ts's anti-storm block exactly
 * (S-5 bidirectional watermark test, same freshCollabDb/seedChannelWithMembers
 * shape, same reclaimStrandedAgentTurn call style).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runCollaborationMigration, runAgentAutoreplyMigration } from '../packages/collab/src/index.js';
import { ensureGatewayBuild, GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';

const REPO_ROOT = join(GATEWAY_DIST_ENTRY, '..', '..', '..', '..');
const COLLAB_DIST_DIR = join(REPO_ROOT, 'packages', 'collab', 'dist');

type CollabModule = typeof import('../packages/collab/dist/index.js');

// ensureGatewayBuild() rebuilds packages/collab/dist as a dependency of the
// gateway build -- the SAME cross-process build lock
// agent-participation-s3.test.ts and agent-participation-cron.test.ts rely
// on, so a stale collab dist can never be the reason this suite is green.
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);

function nowIso(): string { return new Date().toISOString(); }

function freshCollabDb(): { db: InstanceType<typeof Database>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'torq-lease-resolve-'));
  const path = join(dir, 'collab.db');
  const db = new Database(path);
  runCollaborationMigration(db);
  runAgentAutoreplyMigration(db);
  return { db, dir };
}

function seedChannelWithAgent(db: InstanceType<typeof Database>): { channelId: string; agentId: string } {
  const ownerId = randomUUID();
  const agentId = randomUUID();
  const now = nowIso();
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(ownerId, now, now);
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'A', ?, 'active', 1, NULL, ?, ?)",
  ).run(agentId, ownerId, now, now);
  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'C', 'c-' || ?, 'active', ?, 1, ?, ?)",
  ).run(channelId, channelId, ownerId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, ownerId, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
  ).run(channelId, agentId, now);
  return { channelId, agentId };
}

describe('T-B1 -- resolveAgentTurn lease predicate on the restart-recovery race (B-6)', () => {
  let collab: CollabModule;
  beforeAll(async () => {
    collab = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'index.js')).href) as CollabModule;
  });

  it('RED/GREEN: a STALE executor cannot resolve a turn a fresh reclaim has re-leased; the fresh executor can', () => {
    const { db, dir } = freshCollabDb();
    try {
      const { channelId, agentId } = seedChannelWithAgent(db);

      // Executor A claims the turn (dispatched_at in the past, simulating a
      // process that has been running long enough to now look stranded).
      const past = new Date(Date.now() - 120_000).toISOString();
      const claimed = collab.claimAgentTurn(db, {
        channelId, agentPrincipalId: agentId, channelSeq: 1, triggerEventId: randomUUID(), nowIso: past,
      });
      expect(claimed, 'initial claim by executor A must succeed').toBe(true);

      // Boot-time recovery sweep finds it stranded and reclaims it with a
      // FRESH lease token for executor B (simulating a restart: executor A
      // no longer exists as far as the gateway process is concerned, but
      // its in-memory closure -- the async function still running -- does
      // not know that yet).
      const stranded = collab.findStrandedAgentTurns(db, nowIso(), 30);
      expect(stranded.map((t: any) => t.channelSeq)).toEqual([1]);
      const strandedTurn = stranded[0];
      const freshLease = 'executor-b-fresh-lease';
      const reclaimed = collab.reclaimStrandedAgentTurn(db, {
        channelId,
        agentPrincipalId: agentId,
        channelSeq: 1,
        nowIso: nowIso(),
        expectedDispatchedAt: strandedTurn.dispatchedAt,
        leaseToken: freshLease,
      });
      expect(reclaimed).toEqual({ leaseToken: freshLease, attempt: 1 });

      // --- THE RACE ---
      // Executor A (stale, holds no lease token at all -- it predates the
      // introduction of leases in its own execution, or simply never saw
      // the reclaim) finishes its now-superseded work and tries to resolve
      // the turn 'terminated'. It supplies a STALE lease token that does
      // NOT match what the reclaim just wrote.
      const staleLease = 'executor-a-stale-lease';

      // Sanity: prove the row's real lease is the fresh one, not the stale
      // one and not null -- otherwise this test would pass for the wrong
      // reason (a predicate that always fails, rather than one that
      // correctly discriminates).
      const liveLeaseRow = db.prepare(
        'SELECT recovery_lease_token AS leaseToken, state FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?',
      ).get(channelId, agentId, 1) as { leaseToken: string; state: string };
      expect(liveLeaseRow.leaseToken).toBe(freshLease);
      expect(liveLeaseRow.state).toBe('dispatched');

      // RED (pre-fix) / GREEN (post-fix) assertion: the stale resolve must
      // affect ZERO rows -- it must not be able to flip a row it does not
      // hold the lease for. Before the B-6 fix, resolveAgentTurn had no
      // lease predicate and no return value at all (void); this call would
      // have silently succeeded and terminated executor B's live turn.
      const staleResolveChanges = collab.resolveAgentTurn(db, {
        channelId,
        agentPrincipalId: agentId,
        channelSeq: 1,
        state: 'terminated',
        nowIso: nowIso(),
        leaseToken: staleLease,
      });
      expect(staleResolveChanges, 'a stale-lease resolve must affect 0 rows').toBe(0);

      // The row must be UNCHANGED -- still 'dispatched', still owned by the
      // fresh lease -- proving the stale call was a genuine no-op, not a
      // partial mutation.
      const afterStaleAttempt = db.prepare(
        'SELECT recovery_lease_token AS leaseToken, state, resolved_at AS resolvedAt FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?',
      ).get(channelId, agentId, 1) as { leaseToken: string; state: string; resolvedAt: string | null };
      expect(afterStaleAttempt.state, 'the live turn must still be dispatched after the stale resolve attempt').toBe('dispatched');
      expect(afterStaleAttempt.leaseToken).toBe(freshLease);
      expect(afterStaleAttempt.resolvedAt).toBeNull();

      // Executor B (fresh, holds the real lease) now resolves the SAME
      // turn and MUST succeed -- proving the predicate discriminates by
      // lease value rather than unconditionally refusing every resolve
      // (a predicate that always returned 0 would also pass the assertion
      // above for the wrong reason; this is the positive control).
      const freshResolveChanges = collab.resolveAgentTurn(db, {
        channelId,
        agentPrincipalId: agentId,
        channelSeq: 1,
        state: 'completed',
        nowIso: nowIso(),
        leaseToken: freshLease,
      });
      expect(freshResolveChanges, 'the fresh-lease resolve by the executor that actually owns the reclaim must succeed').toBe(1);

      const finalRow = db.prepare(
        'SELECT state, resolved_at AS resolvedAt FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?',
      ).get(channelId, agentId, 1) as { state: string; resolvedAt: string | null };
      expect(finalRow.state).toBe('completed');
      expect(finalRow.resolvedAt).not.toBeNull();

      // Idempotency positive control: a THIRD resolve attempt (even with
      // the correct fresh lease) against the now-terminal row must be a
      // no-op -- the pre-existing WHERE state='dispatched' guard, which
      // the B-6 predicate is additive to, not a replacement for.
      const thirdAttempt = collab.resolveAgentTurn(db, {
        channelId,
        agentPrincipalId: agentId,
        channelSeq: 1,
        state: 'terminated',
        nowIso: nowIso(),
        leaseToken: freshLease,
      });
      expect(thirdAttempt, 'a resolve against an already-terminal row must remain a no-op even with the correct lease').toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backward compatibility: omitting leaseToken entirely preserves pre-B-6 behavior (no predicate, resolves unconditionally)', () => {
    const { db, dir } = freshCollabDb();
    try {
      const { channelId, agentId } = seedChannelWithAgent(db);
      collab.claimAgentTurn(db, {
        channelId, agentPrincipalId: agentId, channelSeq: 1, triggerEventId: randomUUID(), nowIso: nowIso(),
      });
      // No leaseToken supplied at all (matches every pre-existing call site
      // this bounded fix does not touch, e.g. cron.ts and the existing S3
      // test suite's own calls) -- must behave exactly as before: resolves
      // by (channelId, agentPrincipalId, channelSeq, state='dispatched')
      // alone, and now additionally returns the changed-row count.
      const changes = collab.resolveAgentTurn(db, {
        channelId, agentPrincipalId: agentId, channelSeq: 1, state: 'no_post', nowIso: nowIso(),
      });
      expect(changes, 'omitting leaseToken must still resolve successfully (1 row)').toBe(1);
      const row = db.prepare(
        'SELECT state FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?',
      ).get(channelId, agentId, 1) as { state: string };
      expect(row.state).toBe('no_post');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
