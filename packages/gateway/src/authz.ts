import type { ClientCommand } from '@torqclaw/contracts';

/** Persisted session role — the ONLY source of truth for authorization.
 *  Never trust a role carried on a per-frame command; it is read from the
 *  sessions table at connect time and threaded through as ctx. */
export type Role = 'operator' | 'channel' | 'node';

export type AuthzDecision = { ok: true } | { ok: false; reason: string };

export interface AuthzContext {
  /** Resolve a task's owning session id, or null if the task is unknown. */
  lookupTaskSession: (taskId: string) => string | null;
  /** The commanding connection's own (persisted) session id. */
  sessionId: string;
}

const DENY_NOT_PERMITTED: AuthzDecision = { ok: false, reason: 'action not permitted for this role' };
const DENY_NOT_OWNED: AuthzDecision = { ok: false, reason: 'task not owned by this session' };
const DENY_ROLE_MISMATCH: AuthzDecision = { ok: false, reason: 'session role mismatch' };
const ALLOW: AuthzDecision = { ok: true };

/**
 * Resume-role guard: a RESUME whose ConnectFrame role disagrees with the role
 * persisted on the session is a role-escalation attempt (e.g. a channel client
 * replaying an operator sessionId, or vice versa) and MUST be rejected — the
 * caller closes the socket (4003) and never mints a fresh session as fallback.
 *
 * Fresh sessions (resumed === false) always pass: the frame role IS the role
 * just persisted, so there is nothing to disagree with.
 *
 * Pure function — server.ts calls this verbatim on the connect path, so the
 * unit tests exercise the actual production guard, not a parallel copy.
 */
export function checkResumeRole(
  resumed: boolean,
  storedRole: string,
  frameRole: string,
): AuthzDecision {
  if (resumed && storedRole !== frameRole) return DENY_ROLE_MISMATCH;
  return ALLOW;
}

/**
 * Allow-list authorization, default DENY for anything not explicitly granted
 * to a non-operator role. Pure function, no I/O — ctx.lookupTaskSession is the
 * only side-channel, injected by the caller (server.ts) against the real DB.
 *
 * Policy:
 *   operator — every action allowed (including CANCEL_TASK on an unknown task;
 *              downstream that's a harmless no-op).
 *   channel  — SUBMIT_PROMPT: allow.
 *              MEMORY: allow only op === 'SHOW'; FORGET_SESSION denies.
 *              CANCEL_TASK: allow only if the task is owned by this session
 *              (lookupTaskSession returns a sessionId === ctx.sessionId);
 *              unknown/not-found task denies.
 *              Everything else (APPROVE_TOOL, APPROVE_SKILL, GET_SKILL_DRAFT,
 *              any future/unmapped action) — deny.
 *   node     — every action denied.
 */
export function authorize(role: Role, cmd: ClientCommand, ctx: AuthzContext): AuthzDecision {
  if (role === 'operator') return ALLOW;
  if (role === 'node') return DENY_NOT_PERMITTED;

  // role === 'channel'
  switch (cmd.action) {
    case 'SUBMIT_PROMPT':
      return ALLOW;
    case 'MEMORY':
      return cmd.op === 'SHOW' ? ALLOW : DENY_NOT_PERMITTED;
    case 'CANCEL_TASK': {
      const owner = ctx.lookupTaskSession(cmd.taskId);
      if (owner == null) return DENY_NOT_OWNED;
      return owner === ctx.sessionId ? ALLOW : DENY_NOT_OWNED;
    }
    case 'APPROVE_TOOL':
    case 'APPROVE_SKILL':
    case 'GET_SKILL_DRAFT':
      return DENY_NOT_PERMITTED;
    default:
      // Default deny for any future/unmapped action on a non-operator role.
      return DENY_NOT_PERMITTED;
  }
}
