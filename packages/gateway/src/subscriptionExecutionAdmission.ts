import type { GatewayRequest } from '@torqclaw/contracts';
import { getCollabDbForAutoReply } from './collabSurface.js';

const ENABLED = new Set(['1', 'true', 'yes', 'on']);
const DISABLED = new Set(['0', 'false', 'no', 'off']);

export function subscriptionAgentExecutionEnabled(): boolean {
  const value = (process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED ?? '').trim().toLowerCase();
  if (value === '') return true;
  if (ENABLED.has(value)) return true;
  if (DISABLED.has(value)) return false;
  return false;
}

type SubscriptionTarget = NonNullable<GatewayRequest['payload']['subscriptionExecutionTarget']>;

export type SubscriptionExecutionAdmission =
  | { ok: true }
  | { ok: false; code: 'FEATURE_DISABLED' | 'IDENTITY_MISSING' | 'LIVE_PROFILE_MISMATCH' };

/**
 * Re-read mutable authority immediately before provider spawn. The persisted
 * request is evidence of the original decision, not continuing authority.
 */
export function admitLiveSubscriptionExecution(
  req: GatewayRequest,
  target: SubscriptionTarget,
): SubscriptionExecutionAdmission {
  if (!subscriptionAgentExecutionEnabled()) return { ok: false, code: 'FEATURE_DISABLED' };
  const principalId = req.payload.callerCollabPrincipalId;
  if (!principalId) return { ok: false, code: 'IDENTITY_MISSING' };
  const db = getCollabDbForAutoReply();
  if (!db) return { ok: false, code: 'IDENTITY_MISSING' };
  const row = db.prepare(
    `SELECT p.status,
            rp.provider_account_id AS providerAccountId,
            rp.adapter_id AS adapterId,
            rp.model_id AS modelId,
            rp.autostart,
            rp.external_context_confirmed AS externalContextConfirmed,
            rp.external_context_provider_account_id AS externalContextProviderAccountId,
            rp.external_context_model_id AS externalContextModelId
            ,rp.external_context_runtime_fingerprint AS externalContextRuntimeFingerprint
            ,rp.external_context_exact_model_id AS externalContextExactModelId
            ,rp.external_context_persona_revision AS externalContextPersonaRevision
            ,rp.external_context_persona_content_sha256 AS externalContextPersonaContentSha256
       FROM principals p
       LEFT JOIN collab_agent_runtime_profiles rp ON rp.agent_principal_id = p.id
      WHERE p.id = ?`,
  ).get(principalId) as {
    status: string;
    providerAccountId: string | null;
    adapterId: string | null;
    modelId: string | null;
    autostart: number | null;
    externalContextConfirmed: number | null;
    externalContextProviderAccountId: string | null;
    externalContextModelId: string | null;
    externalContextRuntimeFingerprint: string | null;
    externalContextExactModelId: string | null;
    externalContextPersonaRevision: number | null;
    externalContextPersonaContentSha256: string | null;
  } | undefined;
  const exactMatch = row?.status === 'active'
    && row.providerAccountId === target.providerAccountId
    && target.providerId === target.providerAccountId
    && row.adapterId === target.adapterId
    && row.modelId === target.modelId
    && row.autostart === 1
    && target.confirmed === true
    && row.externalContextConfirmed === 1
    && row.externalContextProviderAccountId === target.providerAccountId
    && row.externalContextModelId === target.modelId
    && row.externalContextRuntimeFingerprint === target.runtimeFingerprint
    && row.externalContextExactModelId === target.exactModelId
    && row.externalContextPersonaRevision === target.personaRevision
    && row.externalContextPersonaContentSha256 === target.personaContentSha256;
  if (!exactMatch) return { ok: false, code: 'LIVE_PROFILE_MISMATCH' };
  const turn = req.payload.agentTurnContext;
  if (!turn || turn.agentPrincipalId !== principalId || turn.personaRevision !== target.personaRevision) {
    return { ok: false, code: 'LIVE_PROFILE_MISMATCH' };
  }
  const live = db.prepare(
    `SELECT c.state AS channelState, c.external_export_policy AS externalExportPolicy,
            m.state AS memberState,
            t.state AS turnState, t.dispatch_request_id AS dispatchRequestId,
            t.recovery_lease_token AS recoveryLeaseToken,
            EXISTS(
              SELECT 1 FROM collab_autoreply_stop s
               WHERE s.scope = 'global' OR (s.scope = 'channel' AND s.channel_id = c.id)
            ) AS stopped
       FROM collab_channels c
       JOIN collab_members m ON m.channel_id = c.id AND m.principal_id = ?
       JOIN collab_agent_turns t
         ON t.channel_id = c.id AND t.agent_principal_id = m.principal_id AND t.channel_seq = ?
      WHERE c.id = ?`,
  ).get(principalId, turn.channelSeq, turn.channelId) as {
    channelState: string;
    externalExportPolicy: string;
    memberState: string;
    turnState: string;
    dispatchRequestId: string | null;
    recoveryLeaseToken: string | null;
    stopped: number;
  } | undefined;
  const lease = turn.recoveryLeaseToken?.trim() || null;
  return live?.channelState === 'active'
    && live.externalExportPolicy === 'operator_confirmed_non_sensitive'
    && live.memberState === 'active'
    && live.turnState === 'dispatched'
    && live.dispatchRequestId === req.id
    && live.recoveryLeaseToken === lease
    && live.stopped === 0
    ? { ok: true }
    : { ok: false, code: 'LIVE_PROFILE_MISMATCH' };
}
