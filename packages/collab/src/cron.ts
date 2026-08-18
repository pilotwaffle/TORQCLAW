/**
 * CRON — scheduled autonomous agent turns.
 *
 * G1R Gate-1 §2A (docs/prd-reviews/G1R-OPUS-AGENT-PARTICIPATION-007-GATE1.md)
 * ruled cron the SAME threat shape as auto-reply and strictly worse: no
 * human proximity, no natural terminator, and durable state that outlives
 * the regime it was created under. This module encodes the binding rules
 * from that ruling:
 *
 *   - A SCHEDULE IS A TRIGGER, NEVER A STORED AUTHORIZATION (§2A.5(d)).
 *     Every authority input -- membership, principal status, STOP -- is
 *     re-read here, live, at WAKE time. `assertScheduleStillAuthorized`
 *     takes no cached field from the schedule row except the ids needed to
 *     look the live state up; it never trusts a schedule-creation-time
 *     snapshot of anything.
 *   - FRONTIER is never reachable from a scheduled turn (§2A.2): the
 *     caller (cronDispatcher.ts, gateway package) forces LOCAL_EDGE
 *     exactly as autoReplyDispatcher.ts does, for the identical reason
 *     (frontierGrantFenced cannot be satisfied by a name-only grant).
 *   - An unattended run whose approval goes unanswered terminates in a
 *     THIRD, EXPLICITLY DISTINGUISHABLE state (B-8): 'blocked_awaiting_approval',
 *     never bare 'completed', never bare 'terminated' (this module's analog
 *     of collab_agent_turns' 'terminated'), and never silently absent.
 *
 * Deliberately NOT reusing resolveEligibleAgents/claimAgentTurn's
 * membership-fan-out shape: a cron wake targets exactly ONE
 * (schedule_id -> channel_id, agent_principal_id) pair chosen by an
 * operator at schedule-creation time, not "every member except the actor"
 * -- a different trigger shape from message-reply fan-out, sharing the
 * SAME underlying idempotency/STOP/wake-time-authority disciplines rather
 * than the same resolver function.
 */

export type CronDb = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

export type ScheduleState = 'active' | 'stopped';
export type ScheduleRunState = 'dispatched' | 'completed' | 'no_post' | 'terminated' | 'blocked_awaiting_approval';

export type AgentSchedule = {
  id: string;
  channelId: string;
  agentPrincipalId: string;
  createdByPrincipalId: string;
  intervalSeconds: number;
  promptHint: string | null;
  state: ScheduleState;
  nextFireSeq: number;
  nextFireAt: string;
  lastFiredAt: string | null;
};

/**
 * Create a schedule. This function performs NO authority check itself --
 * the caller (gateway command handler) is responsible for the
 * operator-only wire-command gate (authz.ts), matching the SAME division
 * of responsibility setAutoreplyStop has (store-layer function is a plain
 * write; the gateway handler is where the seat lattice is enforced). The
 * schedule's own row is inert data until a wake actually re-validates
 * everything below.
 */
export function createSchedule(
  db: CronDb,
  params: {
    id: string; channelId: string; agentPrincipalId: string; createdByPrincipalId: string;
    intervalSeconds: number; promptHint: string | null; nowIso: string;
  },
): void {
  const nextFireAt = new Date(Date.parse(params.nowIso) + params.intervalSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO collab_agent_schedules
       (id, channel_id, agent_principal_id, created_by_principal_id, interval_seconds,
        prompt_hint, state, next_fire_seq, next_fire_at, last_fired_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, NULL, ?, ?)`,
  ).run(
    params.id, params.channelId, params.agentPrincipalId, params.createdByPrincipalId,
    params.intervalSeconds, params.promptHint, nextFireAt, params.nowIso, params.nowIso,
  );
}

/** Operator-visible halt for one schedule. Distinct from collab_autoreply_stop
 *  (which this module ALSO consults at fire time, §"STOP covers cron"
 *  below) -- this is the per-schedule on/off switch; that is the
 *  channel/global auto-reply kill switch that must reach cron too. */
export function setScheduleState(db: CronDb, scheduleId: string, state: ScheduleState, nowIso: string): boolean {
  const info = db
    .prepare(`UPDATE collab_agent_schedules SET state = ?, updated_at = ? WHERE id = ?`)
    .run(state, nowIso, scheduleId) as { changes: number | bigint };
  return Number(info.changes) === 1;
}

export function getSchedule(db: CronDb, scheduleId: string): AgentSchedule | null {
  const row = db
    .prepare(
      `SELECT id, channel_id AS channelId, agent_principal_id AS agentPrincipalId,
              created_by_principal_id AS createdByPrincipalId, interval_seconds AS intervalSeconds,
              prompt_hint AS promptHint, state, next_fire_seq AS nextFireSeq,
              next_fire_at AS nextFireAt, last_fired_at AS lastFiredAt
         FROM collab_agent_schedules WHERE id = ?`,
    )
    .get(scheduleId) as AgentSchedule | undefined;
  return row ?? null;
}

export function listSchedulesForChannel(db: CronDb, channelId: string): AgentSchedule[] {
  return db
    .prepare(
      `SELECT id, channel_id AS channelId, agent_principal_id AS agentPrincipalId,
              created_by_principal_id AS createdByPrincipalId, interval_seconds AS intervalSeconds,
              prompt_hint AS promptHint, state, next_fire_seq AS nextFireSeq,
              next_fire_at AS nextFireAt, last_fired_at AS lastFiredAt
         FROM collab_agent_schedules WHERE channel_id = ? ORDER BY created_at ASC`,
    )
    .all(channelId) as AgentSchedule[];
}

/**
 * Find every schedule due to fire: state='active' AND next_fire_at <= now.
 * Pure read -- claiming happens separately (claimScheduleFire) so a caller
 * can re-check STOP/authority between finding and claiming without a races
 * window any wider than the claim's own atomic UPDATE.
 */
export function findDueSchedules(db: CronDb, nowIso: string): AgentSchedule[] {
  return db
    .prepare(
      `SELECT id, channel_id AS channelId, agent_principal_id AS agentPrincipalId,
              created_by_principal_id AS createdByPrincipalId, interval_seconds AS intervalSeconds,
              prompt_hint AS promptHint, state, next_fire_seq AS nextFireSeq,
              next_fire_at AS nextFireAt, last_fired_at AS lastFiredAt
         FROM collab_agent_schedules WHERE state = 'active' AND next_fire_at <= ?
         ORDER BY next_fire_at ASC`,
    )
    .all(nowIso) as AgentSchedule[];
}

/**
 * Claim one fire attempt for a schedule: atomically advance next_fire_seq
 * and next_fire_at (idempotency watermark, same discipline as
 * claimAgentTurn's PRIMARY KEY), then insert the run row. The
 * schedule-row UPDATE's WHERE clause pins BOTH the expected next_fire_seq
 * AND state='active' -- so a schedule stopped or already advanced by a
 * concurrent claim (e.g. a boot-recovery sweep racing the live ticker)
 * fails this UPDATE (0 rows changed) and the caller must not proceed to
 * insert a run row. This is the SAME optimistic-concurrency shape
 * admitToolCall's consume-UPDATE and reclaimStrandedAgentTurn use.
 *
 * Returns the claimed fire_seq, or null if the claim lost the race
 * (already advanced) or the schedule is not active.
 */
export function claimScheduleFire(
  db: CronDb,
  params: { scheduleId: string; expectedFireSeq: number; intervalSeconds: number; nowIso: string },
): number | null {
  const fireSeq = params.expectedFireSeq + 1;
  const nextFireAt = new Date(Date.parse(params.nowIso) + params.intervalSeconds * 1000).toISOString();
  const info = db
    .prepare(
      `UPDATE collab_agent_schedules
          SET next_fire_seq = ?, next_fire_at = ?, last_fired_at = ?, updated_at = ?
        WHERE id = ? AND state = 'active' AND next_fire_seq = ?`,
    )
    .run(fireSeq, nextFireAt, params.nowIso, params.nowIso, params.scheduleId, params.expectedFireSeq) as
    { changes: number | bigint };
  if (Number(info.changes) !== 1) return null;
  return fireSeq;
}

/** Insert the 'dispatched' run row for a claimed fire. PRIMARY KEY
 *  (schedule_id, fire_seq) refuses a duplicate insert -- belt-and-suspenders
 *  under claimScheduleFire's own watermark UPDATE, matching
 *  collab_agent_turns' PK-as-idempotency pattern. */
export function recordScheduleRunDispatched(
  db: CronDb,
  params: { scheduleId: string; fireSeq: number; channelId: string; agentPrincipalId: string; nowIso: string },
): boolean {
  try {
    db.prepare(
      `INSERT INTO collab_agent_schedule_runs
         (schedule_id, fire_seq, channel_id, agent_principal_id, state, dispatch_request_id, refusal_reason, fired_at, resolved_at)
       VALUES (?, ?, ?, ?, 'dispatched', NULL, NULL, ?, NULL)`,
    ).run(params.scheduleId, params.fireSeq, params.channelId, params.agentPrincipalId, params.nowIso);
    return true;
  } catch {
    return false;
  }
}

export function attachScheduleRunDispatchRequestId(
  db: CronDb,
  params: { scheduleId: string; fireSeq: number; dispatchRequestId: string },
): void {
  db.prepare(
    `UPDATE collab_agent_schedule_runs SET dispatch_request_id = ?
      WHERE schedule_id = ? AND fire_seq = ? AND state = 'dispatched'`,
  ).run(params.dispatchRequestId, params.scheduleId, params.fireSeq);
}

/**
 * Resolve a claimed fire to its terminal state. Idempotent by
 * WHERE state='dispatched' (never overwrites a terminal state), matching
 * resolveAgentTurn exactly. `refusalReason` is set only for
 * 'terminated'/'blocked_awaiting_approval' -- an operator-facing string
 * naming WHY the branch ended (never a model-visible detail; same T-2
 * discipline autoReplyDispatcher.ts's §5A assertion follows).
 */
export function resolveScheduleRun(
  db: CronDb,
  params: {
    scheduleId: string; fireSeq: number; state: Exclude<ScheduleRunState, 'dispatched'>;
    refusalReason?: string; nowIso: string;
  },
): void {
  db.prepare(
    `UPDATE collab_agent_schedule_runs SET state = ?, refusal_reason = ?, resolved_at = ?
      WHERE schedule_id = ? AND fire_seq = ? AND state = 'dispatched'`,
  ).run(params.state, params.refusalReason ?? null, params.nowIso, params.scheduleId, params.fireSeq);
}

export type StrandedScheduleRun = {
  scheduleId: string; fireSeq: number; channelId: string; agentPrincipalId: string;
  dispatchRequestId: string | null;
};

/** Boot recovery: find every run still 'dispatched' past graceSeconds.
 *  Mirrors findStrandedAgentTurns exactly -- an explicit sweep over a
 *  durable row, never an inference from silence. */
export function findStrandedScheduleRuns(db: CronDb, nowIso: string, graceSeconds: number): StrandedScheduleRun[] {
  const cutoff = new Date(Date.parse(nowIso) - graceSeconds * 1000).toISOString();
  return db
    .prepare(
      `SELECT schedule_id AS scheduleId, fire_seq AS fireSeq, channel_id AS channelId,
              agent_principal_id AS agentPrincipalId, dispatch_request_id AS dispatchRequestId
         FROM collab_agent_schedule_runs WHERE state = 'dispatched' AND fired_at <= ?`,
    )
    .all(cutoff) as StrandedScheduleRun[];
}

/**
 * WAKE-TIME AUTHORITY RE-EVALUATION (G1R §2A.5(d), the binding rule).
 *
 * Re-reads, live, from the SAME ground truth resolveEligibleAgents and
 * admitToolCall already trust -- never a byte of the schedule row itself
 * beyond the ids needed to look this up:
 *   - collab_members: the agent must have an ACTIVE membership row in the
 *     schedule's channel RIGHT NOW. A schedule created while the agent was
 *     a member, then the agent removed, then the schedule fires: refused
 *     here, not admitted from stale state.
 *   - principals: the agent principal itself must be status='active'
 *     (mirrors principalAuthorityForCredential's requirement).
 *   - collab_autoreply_stop: STOP coverage for cron (see module doc) --
 *     a channel-scoped OR global STOP refuses the wake exactly as it
 *     refuses a message-triggered auto-reply turn, via the SAME table.
 *
 * Returns a refusal reason (never throws) so the caller can resolve the
 * run to 'terminated' with a precise, operator-facing explanation, exactly
 * as S-6's membership-removal handling does for auto-reply.
 */
export function assertScheduleStillAuthorized(
  db: CronDb,
  params: { channelId: string; agentPrincipalId: string },
): { ok: true } | { ok: false; reason: string } {
  const globalStop = db.prepare(`SELECT 1 FROM collab_autoreply_stop WHERE scope = 'global'`).get();
  if (globalStop) return { ok: false, reason: 'stop-global' };
  const channelStop = db
    .prepare(`SELECT 1 FROM collab_autoreply_stop WHERE scope = 'channel' AND channel_id = ?`)
    .get(params.channelId);
  if (channelStop) return { ok: false, reason: 'stop-channel' };

  const row = db
    .prepare(
      `SELECT m.state AS memberState, p.status AS principalStatus, p.kind AS principalKind
         FROM collab_members m
         JOIN principals p ON p.id = m.principal_id
        WHERE m.channel_id = ? AND m.principal_id = ?`,
    )
    .get(params.channelId, params.agentPrincipalId) as
    { memberState: string; principalStatus: string; principalKind: string } | undefined;
  if (!row) return { ok: false, reason: 'membership-not-found' };
  if (row.memberState !== 'active') return { ok: false, reason: 'membership-inactive' };
  if (row.principalKind !== 'agent') return { ok: false, reason: 'principal-not-agent' };
  if (row.principalStatus !== 'active') return { ok: false, reason: 'principal-inactive' };
  return { ok: true };
}
