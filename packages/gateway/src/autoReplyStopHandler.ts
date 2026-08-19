/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S3 — SET_AUTOREPLY_STOP handler body.
 *
 * A6(b)/T-9 totality: total, no store throw may escape (same discipline as
 * collabSurface.ts's own handlers -- there is no enclosing try/catch around
 * the dispatch switch in server.ts's async socket.on('message') handler).
 */
import { setAutoreplyStop, clearAutoreplyStop, isAutoreplyStopped, type AutoreplyDb } from '@torqclaw/collab';
import { publishOnly } from './events.js';

export type AutoReplyStopError = { code: 'COLLAB_INVALID_REQUEST' | 'COLLAB_UNAVAILABLE'; detail?: unknown };

export async function handleSetAutoreplyStop(
  sessionId: string,
  operatorPrincipalId: string | null,
  db: AutoreplyDb | null,
  params: { stop: boolean; scope: 'global' | 'channel'; channelId?: string },
): Promise<AutoReplyStopError | null> {
  // T-9 part 2 residue: the (scope, channelId) combination that cannot be
  // expressed inside the discriminatedUnion (commands.ts's comment on this
  // command explains why) is validated here instead.
  const channelRequired = params.scope === 'channel';
  const channelPresent = params.channelId !== undefined;
  if (channelRequired !== channelPresent) {
    return {
      code: 'COLLAB_INVALID_REQUEST',
      detail: 'channelId is required for scope="channel" and forbidden for scope="global"',
    };
  }
  if (operatorPrincipalId === null) {
    // The operator seat always has a resolved connectionAuth principal on a
    // C1-provisioned install; a legacy/C1-less connection has none. Rather
    // than refuse with COLLAB_IDENTITY_REQUIRED (a collab-substrate-specific
    // code that would be a strange thing for an operator's own control
    // command to surface), STOP falls back to recording the ROOT operator
    // seat itself as the actor when no resolved collab principal is
    // available -- this command is authz-gated to the operator SEAT
    // already (authz.ts), so the seat itself is a legitimate actor of
    // record. A synthetic id is never used for anything requiring
    // membership/authority evaluation (it never reaches assertChannelVisible
    // or any per-agent decision) -- it is purely an audit-trail label on the
    // collab_autoreply_stop row.
    operatorPrincipalId = 'operator-seat';
  }
  if (!db) return { code: 'COLLAB_UNAVAILABLE' };
  try {
    if (params.stop) {
      setAutoreplyStop(db, {
        scope: params.scope,
        channelId: params.scope === 'channel' ? params.channelId! : null,
        stoppedByPrincipalId: operatorPrincipalId,
        nowIso: new Date().toISOString(),
      });
    } else {
      clearAutoreplyStop(db, params.scope, params.scope === 'channel' ? params.channelId! : null);
    }
    const nowStopped = params.scope === 'channel'
      ? isAutoreplyStopped(db, params.channelId!)
      : isAutoreplyStopped(db, '__global_probe__');
    publishOnly(sessionId, {
      message: params.stop ? 'Agent auto-reply stopped' : 'Agent auto-reply resumed',
      metadata: {
        autoreplyStop: true, scope: params.scope, channelId: params.channelId ?? null,
        stopped: params.stop, effectiveStopped: nowStopped,
      },
    });
    return null;
  } catch {
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}
