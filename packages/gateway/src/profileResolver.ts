import { ComputeTier, type TaskType, type EffectiveProfile, type ProfileId, type RouterDiagnostics } from '@torqclaw/contracts';
import {
  compareProfilePolicies,
  resolveEffectiveProfile,
  type ProfileRelation,
} from '@torqclaw/bridge';
import type { RegisteredTool } from '@torqclaw/bridge';

const DEFAULT_PROFILE_BY_TASK: Record<TaskType, ProfileId> = {
  DATA_EXTRACTION: 'read_only',
  SUMMARIZATION: 'read_only',
  ROUTINE_AUTOMATION: 'workspace_write',
  AUTONOMOUS_RESEARCH: 'browser_research',
  COMPLEX_CODING: 'terminal_power',
};

export interface ResolveProfileOptions {
  taskType: TaskType;
  requestedProfile?: ProfileId;
  sessionDefaultProfile?: ProfileId;
  operatorAuthorized?: boolean;
  tools?: readonly RegisteredTool[];
}

export interface ResolvedProfile {
  profile: EffectiveProfile;
  relationToSessionDefault: ProfileRelation;
}

/** Resolve the effective policy before task tools are predicted. Unknown or
 * unauthorized broadening fails closed; stricter requests need no approval. */
export function resolveProfile(options: ResolveProfileOptions): ResolvedProfile {
  const tools = options.tools;
  const sessionId = options.sessionDefaultProfile ?? DEFAULT_PROFILE_BY_TASK[options.taskType];
  const requestedId = options.requestedProfile ?? sessionId;
  const sessionDefault = resolveEffectiveProfile(sessionId, tools);
  const profile = resolveEffectiveProfile(requestedId, tools);
  const relationToSessionDefault = compareProfilePolicies(profile, sessionDefault);

  if (
    requestedId !== sessionId &&
    (relationToSessionDefault === 'broader' || relationToSessionDefault === 'incomparable') &&
    !options.operatorAuthorized
  ) {
    throw new Error(`Profile '${requestedId}' requires operator authority from '${sessionId}'`);
  }
  return { profile, relationToSessionDefault };
}

export function defaultProfileForTask(taskType: TaskType): ProfileId {
  return DEFAULT_PROFILE_BY_TASK[taskType];
}

export function assertResolvedProfile(
  request: { effectiveProfile?: EffectiveProfile },
): asserts request is { effectiveProfile: EffectiveProfile } {
  if (!request.effectiveProfile) {
    throw new Error('GatewayRequest is missing a gateway-resolved effective profile');
  }
}

/** Keep router heuristics inside the effective profile's allowed compute tiers. */
export function constrainTier(
  diagnostics: RouterDiagnostics,
  profile: EffectiveProfile,
): RouterDiagnostics {
  const selectedTier = diagnostics.tier === ComputeTier.LOCAL_EDGE ? 'LOCAL_EDGE' : 'FRONTIER';
  if (profile.allowedTiers.includes(selectedTier)) return diagnostics;
  const fallback = profile.allowedTiers.includes('LOCAL_EDGE') ? ComputeTier.LOCAL_EDGE : ComputeTier.FRONTIER;
  return {
    ...diagnostics,
    tier: fallback,
    reason: `PROFILE_TIER_CONSTRAINT: ${profile.profileId} permits ${profile.allowedTiers.join(', ')}; selected ${fallback}.`,
    humanReason: `The ${profile.profileId} profile does not permit the router's original tier, so the task was constrained to ${fallback}.`,
    overridable: false,
    safetyLock: 'PROFILE_TIER_CONSTRAINT',
    blockedAlternatives: [{ tier: diagnostics.tier, why: `The active profile '${profile.profileId}' does not permit this tier.` }],
  };
}
