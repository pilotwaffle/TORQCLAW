/**
 * PRD cron slice -- scheduled autonomous agent turns.
 * G1R Gate-1 §2A (docs/prd-reviews/G1R-OPUS-AGENT-PARTICIPATION-007-GATE1.md).
 *
 * Reuses autoReplyDispatcher.ts's turn machinery rather than paralleling
 * it (per the build brief): the same `runDispatchAndWait` poll-the-tasks-row
 * pattern, the same profile resolution ('agent_conversation'), the same
 * FRONTIER fence reasoning, and the same "resolve by real committed
 * evidence" discipline. What differs is the TRIGGER shape (one schedule
 * names exactly one (channel, agent) pair, never a membership fan-out) and
 * the terminal state machine, which gains the THIRD state B-8 requires.
 *
 * WAKE-TIME AUTHORITY RE-EVALUATION (binding rule, G1R §2A.5(d))
 * -----------------------------------------------------------------------
 * `assertScheduleStillAuthorized` (packages/collab/src/cron.ts) is called
 * HERE, at fire time, and re-reads LIVE: channel membership state,
 * principal status, and collab_autoreply_stop (channel + global). NONE of
 * these are read from the schedule row itself -- only the ids needed to
 * look them up. A schedule created in January, firing in June, against a
 * membership revoked in March, is refused HERE, not admitted from stale
 * state. This mirrors admitToolCall's own re-read of live profile
 * delegation and auth epoch (grantAdmission.ts) for the identical reason:
 * "a revoke-then-dispatch race has one durable outcome."
 *
 * STOP COVERS CRON
 * -----------------------------------------------------------------------
 * assertScheduleStillAuthorized checks collab_autoreply_stop -- the SAME
 * table SET_AUTOREPLY_STOP writes and isAutoreplyStopped reads for
 * message-triggered auto-reply. An operator stopping a channel (or
 * globally) therefore stops scheduled turns into it too, with no separate
 * cron-specific STOP command needed, and it survives restart because
 * collab_autoreply_stop already does (S3, shipped).
 *
 * FRONTIER IS NEVER REACHABLE (G1R §2A.2, do not relax `frontierGrantFenced`)
 * -----------------------------------------------------------------------
 * A scheduled turn is forced to LOCAL_EDGE unconditionally, identical to
 * autoReplyDispatcher.ts's runAgentTurn and for the identical reason: the
 * engine's pre_tool_call hook grants by NAME only and cannot satisfy the
 * exact-action invariant. This is not "not yet implemented" -- it is
 * structurally correct and must not be "fixed" to make cron reach
 * FRONTIER.
 *
 * THE THIRD STATE (G1R B-8, binding)
 * -----------------------------------------------------------------------
 * "An unattended run whose approval is unanswered must NOT time out into a
 * silent skip OR a silent proceed. [...] must terminate in a THIRD,
 * explicitly distinguishable state -- neither success nor a bare failure."
 *
 * dispatch.ts's own gated-tool branch already produces the distinguishable
 * evidence this needs, unprompted: when a tool call hits ToolApprovalRequired,
 * the task row is written `state='completed'` with `telemetry_json =
 * {"blockedOn": "<toolName>"}` (dispatch.ts ~line 357) -- NEVER `'failed'`.
 * That is real committed-row evidence, not an inferred timeout. This
 * dispatcher reads `blockedOn` off the SAME task row runDispatchAndWait
 * already polls to completion, and resolves the schedule run to
 * 'blocked_awaiting_approval' instead of 'completed' whenever it is
 * present -- never inferring the third state from elapsed time or from an
 * emitted event, always from the actual persisted outcome of the actual
 * dispatch (§7.5 discipline: side-effect/row evidence, never a mocked
 * signal).
 *
 * B-8's TTL ruling (this slice's decision, stated and reasoned): a
 * schedule-originated approval is registered through the EXACT SAME
 * registerApprovalC2/registerApproval path a human-paced run uses (dispatch.ts
 * is not modified by this module at all -- there is no cron-specific branch
 * inside dispatch()). Its `tool_approvals` row therefore carries the SAME
 * 15-minute APPROVAL_TTL_SECONDS and will be swept to 'expired' by the
 * existing (now flag-independent, S0) sweepExpiredApprovals if nobody
 * decides it. THIS IS DELIBERATE, not an oversight: widening the TTL only
 * for schedule-originated approvals would require dispatch.ts (or
 * registerApprovalC2) to know its caller is a schedule, which is exactly
 * the kind of provenance-widening this ticket's scope explicitly excludes
 * ("do NOT add new capabilities beyond what an auto-reply turn may do").
 * The schedule run's own row is what carries the honest signal instead:
 * 'blocked_awaiting_approval' is set the MOMENT the gated call returns
 * (whether or not the approval ever gets answered before its TTL), so the
 * operator sees "this schedule needed a write and is waiting on approval"
 * immediately in collab_agent_schedule_runs, independent of whatever the
 * underlying tool_approvals row's TTL does next. If the approval later
 * expires unanswered, the schedule run row is UNCHANGED -- it already
 * recorded the honest, distinguishable outcome at fire time and does not
 * need a second write to stay honest. A future slice MAY widen the TTL for
 * schedule-originated approvals specifically; this slice does not, because
 * doing so safely requires plumbing schedule provenance through dispatch.ts
 * (a change to a security-critical shared path), which is exactly the kind
 * of change CLAUDE.md's "keep provider config changes separate" discipline
 * says must not ride inside this ticket.
 */

import { randomUUID } from 'node:crypto';
import type { ComputeTier, GatewayRequest, RouterDiagnostics } from '@torqclaw/contracts';
import { router } from '@torqclaw/router';
import { predictTools } from '@torqclaw/bridge';
import {
  findDueSchedules,
  claimScheduleFire,
  recordScheduleRunDispatched,
  attachScheduleRunDispatchRequestId,
  resolveScheduleRun,
  findStrandedScheduleRuns,
  assertScheduleStillAuthorized,
  type CallerContext,
} from '@torqclaw/collab';
import { resolveProfile } from './profileResolver.js';
import { dispatch } from './dispatch.js';
import { db as stateDb } from './storage.js';
import { getStore, callerFor, agentParticipationEnabled, getCollabDbForAutoReply } from './collabSurface.js';
import { buildAnchorWindowContext } from './autoReplyContext.js';
import { agentCronEnabled } from './cronFlags.js';

/** Test-only hook, mirroring autoReplyDispatcher.ts's identical seam. */
let dispatchOverride: typeof dispatch | null = null;
export function setCronDispatchForTest(fn: typeof dispatch | null): void {
  dispatchOverride = fn;
}

function nowIso(): string {
  return new Date().toISOString();
}

function collabDbHandle(): ReturnType<typeof getCollabDbForAutoReply> {
  return getCollabDbForAutoReply();
}

/**
 * One tick of the scheduler: find every due schedule and CLAIM each one
 * (advancing its idempotency watermark unconditionally), then separately
 * re-validate wake-time authority and either dispatch a real turn or
 * resolve the run 'terminated' with the refusal reason. Called by a
 * caller-owned interval timer (server.ts) and directly by tests. Returns
 * the number of fires CLAIMED this tick -- a claimed-but-refused fire
 * still counts (the watermark advanced; the schedule will not spin hot
 * re-attempting the same due interval), so this is NOT "number of model
 * calls made this tick". Production ignores the return value.
 */
export async function tickSchedules(): Promise<number> {
  if (!agentCronEnabled()) return 0;
  const store = getStore();
  if (!store) return 0;
  const db = collabDbHandle();
  if (!db) return 0;

  const due = findDueSchedules(db, nowIso());
  let claimed = 0;
  for (const schedule of due) {
    const fireSeq = claimScheduleFire(db, {
      scheduleId: schedule.id,
      expectedFireSeq: schedule.nextFireSeq,
      intervalSeconds: schedule.intervalSeconds,
      nowIso: nowIso(),
    });
    if (fireSeq === null) continue; // lost the race, or no longer active
    // CLAIMED: the watermark has now advanced for this fire regardless of
    // what happens next (refused-at-wake counts as claimed -- the schedule
    // will not re-fire for this same interval; "claimed" tracks the
    // idempotency watermark, not "successfully dispatched a model call").
    claimed += 1;

    // WAKE-TIME AUTHORITY RE-EVALUATION -- after the claim (so the
    // watermark always advances even on refusal; a schedule must not spin
    // hot re-claiming the same due fire forever) but before any dispatch.
    const authz = assertScheduleStillAuthorized(db, {
      channelId: schedule.channelId, agentPrincipalId: schedule.agentPrincipalId,
    });
    if (!authz.ok) {
      recordScheduleRunDispatched(db, {
        scheduleId: schedule.id, fireSeq, channelId: schedule.channelId,
        agentPrincipalId: schedule.agentPrincipalId, nowIso: nowIso(),
      });
      resolveScheduleRun(db, {
        scheduleId: schedule.id, fireSeq, state: 'terminated',
        refusalReason: authz.reason, nowIso: nowIso(),
      });
      continue;
    }

    if (!recordScheduleRunDispatched(db, {
      scheduleId: schedule.id, fireSeq, channelId: schedule.channelId,
      agentPrincipalId: schedule.agentPrincipalId, nowIso: nowIso(),
    })) continue; // PK refused a duplicate (belt-and-suspenders under the watermark)

    try {
      await runScheduledTurn(store, db, schedule.id, fireSeq, schedule.channelId, schedule.agentPrincipalId, schedule.promptHint);
    } catch (err: any) {
      // Same discipline as autoReplyDispatcher.ts's dispatchOneTurn catch:
      // this gateway has NO unhandledRejection net, so a throw escaping
      // this await would kill the whole process. Caught here, one level up
      // from where the run is already resolved.
      console.error(`[gateway] scheduled turn failed unexpectedly (${err?.message ?? err})`);
    }
  }
  return claimed;
}

async function runScheduledTurn(
  store: NonNullable<ReturnType<typeof getStore>>,
  db: NonNullable<ReturnType<typeof collabDbHandle>>,
  scheduleId: string,
  fireSeq: number,
  channelId: string,
  agentPrincipalId: string,
  promptHint: string | null,
): Promise<void> {
  const caller: CallerContext = callerFor(agentPrincipalId);

  let contextText: string;
  try {
    const ctx = await buildAnchorWindowContext(store, caller, channelId);
    contextText = ctx.text;
  } catch (err: any) {
    // Membership/visibility failure discovered while assembling context
    // (a race between the wake-time check above and this read, e.g. the
    // agent was removed in the interim) -- terminate the branch at the
    // gateway, never leave it to model judgment (mirrors S-6's handling).
    resolveScheduleRun(db, {
      scheduleId, fireSeq, state: 'terminated',
      refusalReason: err?.code === 'COLLAB_NOT_FOUND' ? 'membership-race' : 'context-assembly-failed',
      nowIso: nowIso(),
    });
    return;
  }

  const taskType = 'SUMMARIZATION' as const;
  const effectiveProfile = resolveProfile({
    taskType,
    requestedProfile: 'agent_conversation',
    sessionDefaultProfile: 'agent_conversation',
    operatorAuthorized: false,
  }).profile;
  const requiredTools = predictTools(taskType, effectiveProfile, agentPrincipalId);

  if (!requiredTools.includes('collab__post_message')) {
    resolveScheduleRun(db, {
      scheduleId, fireSeq, state: 'terminated',
      refusalReason: 'profile-cannot-post', nowIso: nowIso(),
    });
    console.error(
      `[gateway] scheduled turn cannot post: 'collab__post_message' not admitted by effective ` +
      `profile '${effectiveProfile.profileId}' -- scheduleId=${scheduleId} agentPrincipalId=` +
      `${agentPrincipalId} channelId=${channelId} fireSeq=${fireSeq}`,
    );
    return;
  }

  const hintLine = promptHint ? `\n\nSchedule note (operator-authored, not a command from any message): ${promptHint}` : '';
  const prompt =
    `You are participating in a channel conversation as agent principal ${agentPrincipalId}. ` +
    `You have been woken by a SCHEDULE, not by a new message -- there may be nothing new to say. ` +
    `Read the channel with collab__read_channel if you need more detail than the context below, ` +
    `and reply with collab__post_message ONLY if you have something useful to contribute right now. ` +
    `Staying silent (posting nothing) is a valid, expected outcome.${hintLine}\n\n${contextText}`;

  const sessionId = mintCronTurnSession(agentPrincipalId);

  const request: GatewayRequest = {
    id: randomUUID(),
    sessionId,
    sourceChannel: 'agent-cron',
    receivedAt: nowIso(),
    payload: {
      prompt,
      assembledContext: undefined,
      contextSize: Math.ceil(prompt.length / 4),
      requiredTools,
      taskType,
      grantedTools: [],
      callerCollabPrincipalId: agentPrincipalId,
    },
    constraints: {
      latencySensitivity: 'LOW',
      containsSensitiveData: false,
      executionMode: 'AUTO',
    },
    enrichment: {
      classifierUsed: 'DEFAULT',
      classifierConfidence: 1,
      classifierLatencyMs: 0,
      estimatedTokens: Math.ceil(prompt.length / 4),
      memoryUsed: false,
    },
    effectiveProfile,
  };

  // FRONTIER FENCE (G1R §2A.2, do not relax): forced to LOCAL_EDGE
  // unconditionally, identical reasoning to autoReplyDispatcher.ts.
  const diag: RouterDiagnostics = { ...router.evaluateRequest(request), tier: 'OLLAMA_LOCAL' as ComputeTier };

  attachScheduleRunDispatchRequestId(db, { scheduleId, fireSeq, dispatchRequestId: request.id });

  const taskRow = await runDispatchAndWait(request, diag);

  // THE THIRD STATE (B-8): real committed-row evidence, never inferred.
  const blockedOn = readBlockedOn(taskRow?.telemetry_json ?? null);
  if (blockedOn) {
    resolveScheduleRun(db, {
      scheduleId, fireSeq, state: 'blocked_awaiting_approval',
      refusalReason: blockedOn, nowIso: nowIso(),
    });
    return;
  }

  const postedByThisAgent = countAgentPostsSince(db, scheduleId, fireSeq, channelId, agentPrincipalId);
  if (postedByThisAgent > 0) {
    resolveScheduleRun(db, { scheduleId, fireSeq, state: 'completed', nowIso: nowIso() });
  } else {
    const stillAuthz = assertScheduleStillAuthorized(db, { channelId, agentPrincipalId });
    if (!stillAuthz.ok) {
      resolveScheduleRun(db, {
        scheduleId, fireSeq, state: 'terminated', refusalReason: stillAuthz.reason, nowIso: nowIso(),
      });
    } else {
      resolveScheduleRun(db, { scheduleId, fireSeq, state: 'no_post', nowIso: nowIso() });
    }
  }
}

type TaskRow = { state: string; telemetry_json: string | null };

async function runDispatchAndWait(req: GatewayRequest, diag: RouterDiagnostics): Promise<TaskRow | undefined> {
  const fn = dispatchOverride ?? dispatch;
  fn(req, diag);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const row = stateDb.prepare('SELECT state, telemetry_json FROM tasks WHERE request_id = ?').get(req.id) as
      | TaskRow
      | undefined;
    if (row && row.state !== 'running') return row;
    if (Date.now() >= deadline) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readBlockedOn(telemetryJson: string | null): string | null {
  if (!telemetryJson) return null;
  try {
    const parsed = JSON.parse(telemetryJson) as { blockedOn?: unknown };
    return typeof parsed.blockedOn === 'string' && parsed.blockedOn.length > 0 ? parsed.blockedOn : null;
  } catch {
    return null;
  }
}

function countAgentPostsSince(
  db: NonNullable<ReturnType<typeof collabDbHandle>>,
  scheduleId: string,
  fireSeq: number,
  channelId: string,
  agentPrincipalId: string,
): number {
  // "Since" here means "committed after THIS fire was claimed" -- read by
  // wall-clock ordering against this run row's own fired_at (channel_seq is
  // the substrate's own ordering, not the schedule's, so it cannot anchor
  // this the way autoReplyDispatcher.ts's channel_seq comparison does).
  // Keyed on (scheduleId, fireSeq) -- never on (channelId, agentPrincipalId)
  // alone -- because more than one schedule can legitimately target the
  // same (channel, agent) pair.
  const runRow = db
    .prepare(`SELECT fired_at FROM collab_agent_schedule_runs WHERE schedule_id = ? AND fire_seq = ?`)
    .get(scheduleId, fireSeq) as { fired_at: string } | undefined;
  if (!runRow) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM collab_events
        WHERE channel_id = ? AND actor_principal_id = ? AND kind = 'message_posted' AND created_at >= ?`,
    )
    .get(channelId, agentPrincipalId, runRow.fired_at) as { n: number };
  return row.n;
}

function mintCronTurnSession(agentPrincipalId: string): string {
  const sessionId = randomUUID();
  stateDb.prepare(
    'INSERT INTO sessions (id, role, client_name, principal_id, surface_id) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, 'node', 'agent-cron', agentPrincipalId, null);
  return sessionId;
}

/**
 * Boot-time recovery sweep, mirroring autoReplyDispatcher.ts's
 * recoverStrandedAgentTurns exactly: a schedule run left 'dispatched' by a
 * crash between claim and resolution is RE-DISPATCHED, never silently
 * dropped and never left indistinguishable from a legitimate 'no_post'.
 */
export async function recoverStrandedScheduleRuns(graceSeconds = 30): Promise<number> {
  const db = collabDbHandle();
  if (!db) return 0;
  const store = getStore();
  if (!store) return 0;
  const stranded = findStrandedScheduleRuns(db, nowIso(), graceSeconds);
  let recovered = 0;
  for (const run of stranded) {
    // Re-run wake-time authority for the recovered run too -- a crash must
    // not become a bypass of the same check a normal fire would have had.
    const authz = assertScheduleStillAuthorized(db, {
      channelId: run.channelId, agentPrincipalId: run.agentPrincipalId,
    });
    if (!authz.ok) {
      resolveScheduleRun(db, {
        scheduleId: run.scheduleId, fireSeq: run.fireSeq, state: 'terminated',
        refusalReason: authz.reason, nowIso: nowIso(),
      });
      continue;
    }
    recovered += 1;
    try {
      // NB-4 (G2A-OPUS48-CRON.md): pass the recovered run's OWN promptHint
      // (now joined into findStrandedScheduleRuns) rather than `null` --
      // a recovered run must not silently drop the operator's note on
      // exactly the turn that already failed once.
      await runScheduledTurn(store, db, run.scheduleId, run.fireSeq, run.channelId, run.agentPrincipalId, run.promptHint);
    } catch (err: any) {
      console.error(`[gateway] recovered scheduled turn failed unexpectedly (${err?.message ?? err})`);
    }
  }
  return recovered;
}
