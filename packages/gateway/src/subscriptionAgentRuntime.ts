import { createHash } from 'node:crypto';
import type { AgentPersonaEnvelope, AgentTurnContext } from '@torqclaw/contracts';
import { executeAcpSubscriptionTurn, type AcpLiveAdmission } from './subscriptionAcpRuntime.js';
import type { SubscriptionProcessDriver } from './safeSubscriptionProcess.js';

export interface SubscriptionAgentProfile {
  providerAccountId: string;
  adapterId: string;
  modelId: string;
  autostart: boolean;
  externalContextConfirmed?: boolean;
  externalContextRuntimeFingerprint?: string | null;
  externalContextExactModelId?: string | null;
  externalContextPersonaRevision?: number | null;
  externalContextPersonaContentSha256?: string | null;
}

export type SubscriptionRuntimeFailureCode =
  | 'INVALID_PROFILE' | 'RUNTIME_NOT_READY' | 'SPAWN_FAILED' | 'CANCELLED'
  | 'TERMINATION_UNCONFIRMED' | 'TIMED_OUT' | 'OUTPUT_LIMIT' | 'PROVIDER_FAILED'
  | 'UNSAFE_OUTPUT' | 'EMPTY_RESULT' | 'PERSONA_ENVELOPE_REFUSED' | 'MODEL_MISMATCH';

export class SubscriptionRuntimeError extends Error {
  constructor(readonly code: SubscriptionRuntimeFailureCode) { super(code); }
}

export async function executeSubscriptionAgentTurn(input: {
  profile: SubscriptionAgentProfile;
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  personaEnvelope?: AgentPersonaEnvelope;
  turnContext?: AgentTurnContext;
  admit?: AcpLiveAdmission;
  driver?: SubscriptionProcessDriver;
}): Promise<{
  text: string;
  providerId: string;
  modelId: string;
  runtimeFingerprint: string;
  ignoredKinds: Record<string, number>;
}> {
  validateCanonicalBlankSubscriptionTurn(input.personaEnvelope, input.turnContext);
  if (!input.profile.autostart || !input.profile.externalContextConfirmed
    || !input.profile.externalContextRuntimeFingerprint
    || input.profile.externalContextExactModelId !== input.profile.modelId
    || input.profile.externalContextPersonaRevision !== input.personaEnvelope!.personaRevision
    || input.profile.externalContextPersonaContentSha256 !== input.personaEnvelope!.contentSha256) {
    throw new SubscriptionRuntimeError('RUNTIME_NOT_READY');
  }
  if (input.signal?.aborted) throw new SubscriptionRuntimeError('CANCELLED');
  try {
    const result = await executeAcpSubscriptionTurn({
      providerId: input.profile.providerAccountId,
      modelId: input.profile.modelId,
      runtimeFingerprint: input.profile.externalContextRuntimeFingerprint,
      prompt: input.prompt,
      cwd: input.cwd ?? process.env.TEMP ?? process.env.TMP ?? process.cwd(),
      signal: input.signal,
      admit: input.admit,
      driver: input.driver,
    });
    return {
      text: result.text,
      providerId: input.profile.providerAccountId,
      modelId: result.exactModelId,
      runtimeFingerprint: result.runtimeFingerprint,
      ignoredKinds: result.ignoredKinds,
    };
  } catch (error) {
    const code = String((error as Error)?.message ?? error);
    if (code === 'CANCELLED') throw new SubscriptionRuntimeError('CANCELLED');
    if (code === 'TERMINATION_UNCONFIRMED') {
      throw new SubscriptionRuntimeError('TERMINATION_UNCONFIRMED');
    }
    if (code === 'TIMED_OUT') throw new SubscriptionRuntimeError('TIMED_OUT');
    if (code === 'UNSAFE_OUTPUT') throw new SubscriptionRuntimeError('UNSAFE_OUTPUT');
    if (code === 'ACP_MODEL_MISMATCH') throw new SubscriptionRuntimeError('MODEL_MISMATCH');
    if (code.includes('BINDING') || code.includes('ADMISSION')) {
      throw new SubscriptionRuntimeError('RUNTIME_NOT_READY');
    }
    throw new SubscriptionRuntimeError('PROVIDER_FAILED');
  }
}

export function validateCanonicalBlankSubscriptionTurn(
  envelope: AgentPersonaEnvelope | undefined,
  turn: AgentTurnContext | undefined,
): void {
  const forbidden = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
  if (!envelope || !turn || envelope.version !== 1
    || envelope.content !== envelope.content.normalize('NFC').trim()
    || envelope.content.length > 4_000 || forbidden.test(envelope.content)
    || !Number.isSafeInteger(envelope.personaRevision) || envelope.personaRevision < 0
    || (envelope.content === '' && envelope.personaRevision !== 0)
    || turn.personaRevision !== envelope.personaRevision
    || envelope.contentSha256 !== createHash('sha256').update(envelope.content, 'utf8').digest('hex')
    || !turn.channelId.trim() || !turn.agentPrincipalId.trim()
    || !turn.triggerEventId.trim() || !Number.isSafeInteger(turn.channelSeq) || turn.channelSeq <= 0) {
    throw new SubscriptionRuntimeError('PERSONA_ENVELOPE_REFUSED');
  }
}
