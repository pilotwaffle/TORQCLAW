/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S3's own flag, SEPARATE from S1/S2's
 * TORQCLAW_AGENT_PARTICIPATION (§4 S3: "A separate flag so agent SPEECH
 * (S1/S2, human-triggered) can ship and soak without agent AUTONOMY (S3).
 * Turning S3 off must never disable S1/S2.").
 *
 * Additionally requires agentParticipationEnabled() (S1/S2's flag), which
 * itself requires collabSurfaceCommandsEnabled() -> collabEnabled() -- so
 * this can NEVER re-enable a surface any ancestor flag left off. It only
 * ever narrows further, matching the house pattern every flag in this
 * program already establishes.
 */
import { agentParticipationEnabled } from './collabSurface.js';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function agentAutoreplyEnabled(): boolean {
  if (!agentParticipationEnabled()) return false;
  return TRUTHY.has((process.env.TORQCLAW_AGENT_AUTOREPLY ?? '').trim().toLowerCase());
}
