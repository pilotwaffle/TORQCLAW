/**
 * Cron's own flag, SEPARATE from TORQCLAW_AGENT_AUTOREPLY, mirroring
 * autoReplyFlags.ts's reasoning exactly: agent SPEECH (S1/S2) and
 * message-triggered AUTONOMY (S3) and SCHEDULED autonomy (cron) are three
 * independently-off capabilities. Turning cron off must never disable S3,
 * and turning S3 off must never disable cron's OWN off switch (they are
 * siblings, not a chain) -- but cron still requires agentParticipationEnabled()
 * (S1/S2's flag), which itself requires collabSurfaceCommandsEnabled() ->
 * collabEnabled(), so this can NEVER re-enable a surface any ancestor flag
 * left off. It only ever narrows further, matching the house pattern.
 */
import { agentParticipationEnabled } from './collabSurface.js';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function agentCronEnabled(): boolean {
  if (!agentParticipationEnabled()) return false;
  return TRUTHY.has((process.env.TORQCLAW_AGENT_CRON ?? '').trim().toLowerCase());
}
