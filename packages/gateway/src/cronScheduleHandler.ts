/**
 * CRON slice -- CREATE_SCHEDULE / SET_SCHEDULE_STATE / LIST_SCHEDULES
 * handler bodies. A6(b)/T-9 totality: total, no store throw may escape
 * (same discipline as autoReplyStopHandler.ts / collabSurface.ts).
 *
 * Deliberately does NOT check channel membership or agent identity itself
 * beyond "the row exists in this channel" for LIST -- CREATE_SCHEDULE names
 * an agentPrincipalId that must ALREADY be an active member of channelId
 * (an operator can only schedule an agent it has already added to the
 * room), so this handler verifies that at CREATE time using the same
 * ground truth cron.ts's own wake-time check reads. This is NOT a
 * substitute for wake-time re-evaluation -- it only prevents creating a
 * schedule that could never legally fire; the schedule's actual authority
 * to fire is re-derived independently every time it wakes (cron.ts's
 * assertScheduleStillAuthorized), never trusted from this moment.
 */
import { randomUUID } from 'node:crypto';
import {
  createSchedule, setScheduleState, listSchedulesForChannel, assertScheduleStillAuthorized,
  type CronDb,
} from '@torqclaw/collab';
import { publishOnly } from './events.js';

export type CronScheduleError = { code: 'COLLAB_INVALID_REQUEST' | 'COLLAB_UNAVAILABLE' | 'COLLAB_NOT_FOUND'; detail?: unknown };

export async function handleCreateSchedule(
  sessionId: string,
  operatorPrincipalId: string | null,
  db: CronDb | null,
  params: { channelId: string; agentPrincipalId: string; intervalSeconds: number; promptHint?: string; idempotencyKey: string },
): Promise<CronScheduleError | null> {
  if (!db) return { code: 'COLLAB_UNAVAILABLE' };
  if (operatorPrincipalId === null) {
    // Same fallback SET_AUTOREPLY_STOP uses: audit-trail label only, never
    // consulted for authorization (this command is already authz-gated to
    // the operator seat).
    operatorPrincipalId = 'operator-seat';
  }
  // The agent must be a REAL, currently active member of THIS channel right
  // now -- an operator cannot schedule a principal that isn't in the room.
  // This is a create-time sanity check, not the authority check itself
  // (that happens independently at every wake).
  // G1R B-C1: this call USED TO SIT OUTSIDE the try below, and it is the only
  // one of the three cron handlers that did. Its first statement selects from
  // collab_autoreply_stop, so a partially-applied or lock-interrupted migration
  // makes it THROW -- and migrateCollabDb (collabIdentity.ts) swallows every
  // migration error in a bare catch{} while still returning a usable handle, so
  // that state is reachable in production, not hypothetical.
  //
  // From there the SqliteError escapes into server.ts's async
  // socket.on('message') handler, whose only try wraps JSON.parse -- the
  // switch containing the cron arms is unguarded -- and THIS GATEWAY HAS NO
  // unhandledRejection NET. The process dies. An operator trying to CREATE a
  // schedule takes down the gateway.
  //
  // G1R proved the asymmetry by execution: against an unmigrated handle this
  // handler THREW while handleSetScheduleState and handleListSchedules both
  // returned COLLAB_UNAVAILABLE, because their store calls sit inside their
  // try. Moved inside so all three are total.
  try {
    const authz = assertScheduleStillAuthorized(db, { channelId: params.channelId, agentPrincipalId: params.agentPrincipalId });
    if (!authz.ok) {
      return { code: 'COLLAB_NOT_FOUND', detail: authz.reason };
    }
    createSchedule(db, {
      id: randomUUID(),
      channelId: params.channelId,
      agentPrincipalId: params.agentPrincipalId,
      createdByPrincipalId: operatorPrincipalId,
      intervalSeconds: params.intervalSeconds,
      promptHint: params.promptHint ?? null,
      // G2A C-1: previously accepted in this signature and DROPPED here, so a
      // retry with the same key minted a second schedule that fired forever
      // alongside the first.
      idempotencyKey: params.idempotencyKey,
      nowIso: new Date().toISOString(),
    });
    publishOnly(sessionId, {
      message: 'Schedule created',
      metadata: { schedule: true, channelId: params.channelId, agentPrincipalId: params.agentPrincipalId, intervalSeconds: params.intervalSeconds },
    });
    return null;
  } catch {
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}

export async function handleSetScheduleState(
  sessionId: string,
  db: CronDb | null,
  params: { scheduleId: string; state: 'active' | 'stopped' },
): Promise<CronScheduleError | null> {
  if (!db) return { code: 'COLLAB_UNAVAILABLE' };
  try {
    const changed = setScheduleState(db, params.scheduleId, params.state, new Date().toISOString());
    if (!changed) return { code: 'COLLAB_NOT_FOUND' };
    publishOnly(sessionId, {
      message: params.state === 'stopped' ? 'Schedule stopped' : 'Schedule resumed',
      metadata: { schedule: true, scheduleId: params.scheduleId, state: params.state },
    });
    return null;
  } catch {
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}

export async function handleListSchedules(
  sessionId: string,
  db: CronDb | null,
  channelId: string,
): Promise<CronScheduleError | null> {
  if (!db) return { code: 'COLLAB_UNAVAILABLE' };
  try {
    const schedules = listSchedulesForChannel(db, channelId);
    publishOnly(sessionId, { message: 'Schedules', metadata: { schedules, channelId } });
    return null;
  } catch {
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}
