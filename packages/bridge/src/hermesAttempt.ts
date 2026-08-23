import {
  GatewayRequestSchema,
  type GatewayRequest,
  ResilienceActiveTupleSchema,
  ResilienceImmutablePlanSchema,
  ResilienceNormalizedFailureSchema,
  ResilienceOutboxEventSchema,
  type ResilienceActiveTuple,
  type ResilienceImmutablePlan,
  type ResilienceNormalizedFailure,
} from '@torqclaw/contracts';
import { getClient } from './registry.js';
import type { Emitter } from './hermes.js';

/** Duplicated structurally at the bridge boundary so the bridge package never
 * imports gateway implementation code. */
export interface ProviderReference {
  id: string;
  label: string;
  modelId: string;
  apiKeyEnvName: string;
  baseUrlEnvName: string;
}

interface PythonProviderReference {
  providerId: string;
  label: string;
  modelId: string;
  credentialEnvName: string;
  baseUrlEnvName: string;
}

function pythonProviderReference(provider: ProviderReference): PythonProviderReference {
  return {
    providerId: provider.id,
    label: provider.label,
    modelId: provider.modelId,
    credentialEnvName: provider.apiKeyEnvName,
    baseUrlEnvName: provider.baseUrlEnvName,
  };
}

export const RESILIENCE_TOOL_NAMES = Object.freeze([
  'resilience_admit_frontier',
  'resilience_submit_attempt',
  'resilience_poll_observations',
  'resilience_record_observation',
  'resilience_finalize_attempt',
  'resilience_transition_once',
  'resilience_request_cancel',
  'resilience_recover_and_transition_once',
  'resilience_get_status',
  'resilience_page_outbox',
] as const);

export type ResilienceToolName = typeof RESILIENCE_TOOL_NAMES[number];

export class ResilienceEnvelopeError extends Error {
  readonly operation: ResilienceToolName | 'cancel_task' | 'attempt_timeout';
  constructor(operation: ResilienceToolName | 'cancel_task' | 'attempt_timeout', message: string) {
    super(`RESILIENCE_ENVELOPE_REJECTED:${operation}:${message}`);
    this.name = 'ResilienceEnvelopeError';
    this.operation = operation;
  }
}

export interface AdmitResponse {
  status: 'ADMITTED' | 'EXISTING' | 'REJECTED';
  activeTuple?: ResilienceActiveTuple;
  reason?: string;
}
export interface SubmitResponse {
  status: 'SUBMITTED' | 'DUPLICATE' | 'NOT_READY' | 'REJECTED';
  activeTuple?: ResilienceActiveTuple;
  executionState?: 'STARTED' | 'OWNED' | 'TERMINAL' | 'ORPHANED';
  providerSubmitNotBeforeMs?: number;
  retryAfterMs?: number;
  reason?: string;
}
export interface NormalizedObservation {
  kind: 'progress' | 'result' | 'failure' | 'cancelled' | 'timeout';
  failure?: ResilienceNormalizedFailure;
  text?: string;
  telemetry?: Record<string, unknown>;
  dispatchAttempted: boolean;
  providerId?: string;
  failureSource?: 'engine' | 'gateway' | 'recovery';
}
export interface PollResponse {
  status: 'OBSERVATIONS' | 'TERMINAL' | 'REJECTED';
  cursor: number;
  observations: NormalizedObservation[];
  terminal?: boolean;
  terminalCommitted?: boolean;
  terminalOutcome?: 'completed' | 'failed' | 'cancelled' | 'cancelled_uncertain' | 'terminal';
  reason?: string;
}
export interface RecordResponse { status: 'RECORDED' | 'DUPLICATE' | 'REJECTED'; reason?: string }
export interface FinalizeResponse {
  status: 'FINALIZED' | 'DUPLICATE' | 'REJECTED';
  outcome?: 'failed' | 'cancelled' | 'cancelled_uncertain' | 'terminal';
  reason?: string;
}
export interface TransitionResponse {
  status: 'TRANSITIONED' | 'OBSERVATION_RECORDED' | 'REJECTED';
  successor?: ResilienceActiveTuple;
  successorProviderId?: string;
  successorSubmitNotBeforeMs?: number;
  idempotentReplay?: boolean;
  reason?: string;
}
export interface CancelResponse {
  status: 'ACK_CANCELLED' | 'ACK_ALREADY_TERMINAL' | 'ACK_UNCERTAIN' | 'REJECTED';
  reason?: string;
}
export interface AttemptStopResponse {
  status: 'ACK_PRE_DISPATCH' | 'ACK_UNCERTAIN' | 'REJECTED';
  activeTuple?: ResilienceActiveTuple;
  dispatchAttempted?: boolean;
  reason?: string;
}
export interface RecoveryResponse {
  status: 'RECOVERED' | 'TRANSITIONED' | 'TERMINAL' | 'REJECTED';
  successor?: ResilienceActiveTuple;
  successorProviderId?: string;
  successorSubmitNotBeforeMs?: number;
  reason?: string;
}
export interface StatusResponse {
  status: 'ACTIVE' | 'CANCEL_PENDING' | 'TERMINAL' | 'REJECTED';
  activeTuple?: ResilienceActiveTuple;
  providerId?: string;
  dispatchAttempted: boolean;
  cancellationRequested: boolean;
  taskDeadlineMs: number;
  immutablePlan?: ResilienceImmutablePlan;
  providerOrder?: string[];
  attemptState: string;
  executionSubmitted: boolean;
  providerSubmitNotBeforeMs?: number;
  reason?: string;
}
export interface OutboxPageResponse {
  status: 'PAGE' | 'REJECTED';
  cursor: number;
  highWaterMark: number;
  events: unknown[];
  reason?: string;
}

export interface ResilienceClient {
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

type BridgeOperation = ResilienceToolName | 'cancel_task' | 'attempt_timeout';

function objectOnly(value: unknown, operation: BridgeOperation): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResilienceEnvelopeError(operation, 'envelope is not an object');
  }
  return value as Record<string, unknown>;
}

function tuple(value: unknown, operation: BridgeOperation): ResilienceActiveTuple {
  const result = ResilienceActiveTupleSchema.safeParse(value);
  if (!result.success) throw new ResilienceEnvelopeError(operation, 'active tuple is invalid');
  return result.data;
}

function status(value: Record<string, unknown>, operation: ResilienceToolName): string {
  if (typeof value.status !== 'string') throw new ResilienceEnvelopeError(operation, 'status is missing');
  return value.status;
}

function reason(value: Record<string, unknown>): string | undefined {
  return typeof value.reason === 'string' && value.reason.length <= 256 ? value.reason : undefined;
}

function parseMcpResult(raw: unknown, operation: BridgeOperation): Record<string, unknown> {
  const result = raw as { isError?: unknown; content?: unknown };
  if (result?.isError === true) throw new ResilienceEnvelopeError(operation, 'MCP reported an error');
  const content = Array.isArray(result?.content) ? result.content : null;
  const text = content?.find((entry) => {
    const item = entry as Record<string, unknown>;
    return item && item.type === 'text' && typeof item.text === 'string';
  }) as Record<string, unknown> | undefined;
  if (!text || typeof text.text !== 'string') throw new ResilienceEnvelopeError(operation, 'JSON text content is missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    throw new ResilienceEnvelopeError(operation, 'JSON content is malformed');
  }
  return objectOnly(parsed, operation);
}

function normalizeObservation(value: unknown, operation: ResilienceToolName): NormalizedObservation {
  const raw = objectOnly(value, operation);
  const allowed = ['kind', 'failure', 'text', 'telemetry', 'dispatchAttempted', 'providerId', 'failureSource'];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new ResilienceEnvelopeError(operation, 'observation contains an unapproved field');
  if (!['progress', 'result', 'failure', 'cancelled', 'timeout'].includes(String(raw.kind))) {
    throw new ResilienceEnvelopeError(operation, 'observation kind is invalid');
  }
  if (typeof raw.dispatchAttempted !== 'boolean') throw new ResilienceEnvelopeError(operation, 'dispatchAttempted is missing');
  const out: NormalizedObservation = {
    kind: raw.kind as NormalizedObservation['kind'],
    dispatchAttempted: raw.dispatchAttempted,
  };
  if (raw.failure !== undefined) {
    const parsed = ResilienceNormalizedFailureSchema.safeParse(raw.failure);
    if (!parsed.success) throw new ResilienceEnvelopeError(operation, 'failure is not normalized');
    out.failure = parsed.data;
  }
  if (raw.text !== undefined) {
    if (typeof raw.text !== 'string' || raw.text.length > 2_000) throw new ResilienceEnvelopeError(operation, 'result text is invalid');
    out.text = raw.text;
  }
  if (raw.telemetry !== undefined) {
    if (raw.telemetry === null || typeof raw.telemetry !== 'object' || Array.isArray(raw.telemetry)) throw new ResilienceEnvelopeError(operation, 'telemetry is invalid');
    const telemetry = raw.telemetry as Record<string, unknown>;
    const allowedTelemetry = ['costUsd', 'costSource', 'inferenceLatencyMs', 'iterations', 'cancelled', 'engineUsed'];
    if (Object.keys(telemetry).some((key) => !allowedTelemetry.includes(key))) throw new ResilienceEnvelopeError(operation, 'telemetry is not normalized');
    if (telemetry.costUsd !== undefined && typeof telemetry.costUsd !== 'number') throw new ResilienceEnvelopeError(operation, 'costUsd is invalid');
    if (telemetry.costSource !== undefined && !['exact', 'account_delta', 'unavailable'].includes(String(telemetry.costSource))) throw new ResilienceEnvelopeError(operation, 'costSource is invalid');
    if (telemetry.inferenceLatencyMs !== undefined && typeof telemetry.inferenceLatencyMs !== 'number') throw new ResilienceEnvelopeError(operation, 'latency is invalid');
    if (telemetry.iterations !== undefined && !Number.isSafeInteger(telemetry.iterations)) throw new ResilienceEnvelopeError(operation, 'iterations is invalid');
    if (telemetry.cancelled !== undefined && typeof telemetry.cancelled !== 'boolean') throw new ResilienceEnvelopeError(operation, 'cancelled is invalid');
    if (telemetry.engineUsed !== undefined && (typeof telemetry.engineUsed !== 'string' || telemetry.engineUsed.length === 0 || telemetry.engineUsed.length > 128)) throw new ResilienceEnvelopeError(operation, 'engineUsed is invalid');
    out.telemetry = { ...telemetry };
  }
  if (raw.providerId !== undefined) {
    if (typeof raw.providerId !== 'string' || raw.providerId.length > 128) throw new ResilienceEnvelopeError(operation, 'providerId is invalid');
    out.providerId = raw.providerId;
  }
  if (raw.failureSource !== undefined) {
    if (!['engine', 'gateway', 'recovery'].includes(String(raw.failureSource))) throw new ResilienceEnvelopeError(operation, 'failureSource is invalid');
    out.failureSource = raw.failureSource as NormalizedObservation['failureSource'];
  }
  return out;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safePositiveRetryHint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 750;
}

async function call(
  operation: ResilienceToolName,
  args: Record<string, unknown>,
  client: ResilienceClient = getClient('hermes') as unknown as ResilienceClient,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: operation, arguments: args });
  return parseMcpResult(result, operation);
}

export async function admitFrontier(
  requestId: string,
  plan: ResilienceImmutablePlan,
  providerOrder: string[],
  deadlineMs: number,
  idempotencyKey: string,
  client?: ResilienceClient,
): Promise<AdmitResponse> {
  const validatedPlan = ResilienceImmutablePlanSchema.safeParse(plan);
  if (!validatedPlan.success || providerOrder.length !== 2 || new Set(providerOrder).size !== providerOrder.length) throw new ResilienceEnvelopeError('resilience_admit_frontier', 'plan or provider order is invalid');
  const raw = await call('resilience_admit_frontier', { request_id: requestId, immutable_plan: plan, deadline_at: deadlineMs, provider_order: providerOrder }, client);
  const current = status(raw, 'resilience_admit_frontier');
  if (!['ADMITTED', 'EXISTING', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_admit_frontier', 'unknown status');
  if (current !== 'REJECTED' && raw.activeTuple === undefined) throw new ResilienceEnvelopeError('resilience_admit_frontier', 'active tuple is missing');
  return { status: current as AdmitResponse['status'], activeTuple: raw.activeTuple === undefined ? undefined : tuple(raw.activeTuple, 'resilience_admit_frontier'), reason: reason(raw) };
}

export async function submitAttempt(
  payload: GatewayRequest,
  plan: ResilienceImmutablePlan,
  active: ResilienceActiveTuple,
  providerRef: ProviderReference,
  attemptDeadlineMs: number,
  idempotencyKey: string,
  client?: ResilienceClient,
): Promise<SubmitResponse> {
  if (!GatewayRequestSchema.safeParse(payload).success) throw new ResilienceEnvelopeError('resilience_submit_attempt', 'payload is not a complete GatewayRequest');
  const raw = await call('resilience_submit_attempt', {
    payload, immutable_plan: plan, active,
    provider_ref: pythonProviderReference(providerRef),
    attempt_deadline_ms: attemptDeadlineMs, idempotency_key: idempotencyKey,
  }, client);
  const current = status(raw, 'resilience_submit_attempt');
  if (!['SUBMITTED', 'DUPLICATE', 'NOT_READY', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_submit_attempt', 'invalid submit response');
  if (current === 'NOT_READY') {
    if (raw.activeTuple === undefined || !safeNonNegativeInteger(raw.providerSubmitNotBeforeMs) ||
        !safePositiveRetryHint(raw.retryAfterMs) || raw.executionState !== undefined) {
      throw new ResilienceEnvelopeError('resilience_submit_attempt', 'invalid submit fence response');
    }
    return {
      status: 'NOT_READY', activeTuple: tuple(raw.activeTuple, 'resilience_submit_attempt'),
      providerSubmitNotBeforeMs: raw.providerSubmitNotBeforeMs,
      retryAfterMs: raw.retryAfterMs, reason: reason(raw),
    };
  }
  if (current !== 'REJECTED' && raw.activeTuple === undefined) throw new ResilienceEnvelopeError('resilience_submit_attempt', 'active tuple is missing');
  if (current !== 'REJECTED' && !['STARTED', 'OWNED', 'TERMINAL', 'ORPHANED'].includes(String(raw.executionState))) throw new ResilienceEnvelopeError('resilience_submit_attempt', 'execution ownership is missing');
  return { status: current as SubmitResponse['status'], activeTuple: raw.activeTuple === undefined ? undefined : tuple(raw.activeTuple, 'resilience_submit_attempt'), executionState: raw.executionState as SubmitResponse['executionState'], reason: reason(raw) };
}

export async function pollObservations(
  active: ResilienceActiveTuple,
  cursor: number,
  attemptDeadlineMs: number,
  client?: ResilienceClient,
): Promise<PollResponse> {
  const raw = await call('resilience_poll_observations', { active, cursor, attempt_deadline_ms: attemptDeadlineMs }, client);
  const current = status(raw, 'resilience_poll_observations');
  if (!['OBSERVATIONS', 'TERMINAL', 'REJECTED'].includes(current) || !Number.isSafeInteger(raw.cursor) || !Array.isArray(raw.observations)) throw new ResilienceEnvelopeError('resilience_poll_observations', 'invalid poll response');
  if (raw.terminalCommitted !== undefined && typeof raw.terminalCommitted !== 'boolean') throw new ResilienceEnvelopeError('resilience_poll_observations', 'terminal marker is invalid');
  const terminalOutcomeValues = ['completed', 'failed', 'cancelled', 'cancelled_uncertain', 'terminal'] as const;
  if (raw.terminalOutcome !== undefined && (typeof raw.terminalOutcome !== 'string' || !terminalOutcomeValues.includes(raw.terminalOutcome as typeof terminalOutcomeValues[number]))) {
    throw new ResilienceEnvelopeError('resilience_poll_observations', 'terminal outcome marker is invalid');
  }
  const observations = raw.observations.map((entry) => normalizeObservation(entry, 'resilience_poll_observations'));
  const terminalCommitted = raw.terminalCommitted === true;
  if (terminalCommitted) {
    if (current !== 'TERMINAL' || raw.terminal !== true || observations.length !== 1 || raw.terminalOutcome === undefined) {
      throw new ResilienceEnvelopeError('resilience_poll_observations', 'terminal marker lacks a committed terminal observation');
    }
    const observation = observations[0]!;
    const expectedOutcome = observation.kind === 'result'
      ? 'completed'
      : observation.kind === 'cancelled'
        ? (observation.failure?.code === 'timeout_uncertain' ? 'cancelled_uncertain' : 'cancelled')
        : observation.kind === 'failure' && observation.failure?.failureClass === 'side_effect_uncertainty'
          ? 'cancelled_uncertain'
          : 'failed';
    if (raw.terminalOutcome !== expectedOutcome) throw new ResilienceEnvelopeError('resilience_poll_observations', 'terminal marker does not match observation');
  } else if (raw.terminalOutcome !== undefined) {
    throw new ResilienceEnvelopeError('resilience_poll_observations', 'uncommitted poll has a terminal outcome');
  }
  return { status: current as PollResponse['status'], cursor: raw.cursor as number, observations, terminal: raw.terminal === true, terminalCommitted, ...(terminalCommitted ? { terminalOutcome: raw.terminalOutcome as PollResponse['terminalOutcome'] } : {}), reason: reason(raw) };
}

export async function recordObservation(
  active: ResilienceActiveTuple,
  observation: NormalizedObservation,
  idempotencyKey: string,
  client?: ResilienceClient,
): Promise<RecordResponse> {
  const raw = await call('resilience_record_observation', { active, normalized_observation: observation, idempotency_key: idempotencyKey }, client);
  const current = status(raw, 'resilience_record_observation');
  if (!['RECORDED', 'DUPLICATE', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_record_observation', 'unknown status');
  return { status: current as RecordResponse['status'], reason: reason(raw) };
}

export async function transitionOnce(
  active: ResilienceActiveTuple,
  successorProviderId: string,
  failure: ResilienceNormalizedFailure,
  jitterMs: number,
  deadlineMs: number,
  planHashValue: string,
  idempotencyKey: string,
  client?: ResilienceClient,
  failureSource?: NormalizedObservation['failureSource'],
  observationIdempotencyKey?: string,
): Promise<TransitionResponse> {
  if (!Number.isSafeInteger(jitterMs) || jitterMs < 250 || jitterMs > 750) throw new ResilienceEnvelopeError('resilience_transition_once', 'jitter is outside the bounded range');
  const validated = ResilienceNormalizedFailureSchema.safeParse(failure);
  if (!validated.success) throw new ResilienceEnvelopeError('resilience_transition_once', 'failure is not normalized');
  const hasFailureSource = failureSource !== undefined;
  const hasObservationKey = observationIdempotencyKey !== undefined;
  if (hasFailureSource !== hasObservationKey || (hasFailureSource && !['engine', 'gateway', 'recovery'].includes(String(failureSource)))) {
    throw new ResilienceEnvelopeError('resilience_transition_once', 'fused transition fields must be supplied together');
  }
  if (hasObservationKey && (!observationIdempotencyKey || observationIdempotencyKey === idempotencyKey)) {
    throw new ResilienceEnvelopeError('resilience_transition_once', 'fused idempotency keys must be non-empty and distinct');
  }
  const args: Record<string, unknown> = {
    active, successor_provider_id: successorProviderId, normalized_failure: validated.data,
    jitter_ms: jitterMs, plan_hash: planHashValue, idempotency_key: idempotencyKey,
  };
  if (hasFailureSource) {
    args.failure_source = failureSource;
    args.observation_idempotency_key = observationIdempotencyKey;
  }
  const raw = await call('resilience_transition_once', {
    ...args,
  }, client);
  const current = status(raw, 'resilience_transition_once');
  if (!['TRANSITIONED', 'OBSERVATION_RECORDED', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_transition_once', 'unknown status');
  const successor = raw.successor === undefined ? undefined : tuple(raw.successor, 'resilience_transition_once');
  const successorProvider = typeof raw.successorProviderId === 'string' ? raw.successorProviderId : undefined;
  if (current === 'TRANSITIONED' && (!successor || successorProvider === undefined)) {
    throw new ResilienceEnvelopeError('resilience_transition_once', 'transition response lacks an exact successor');
  }
  if (current === 'TRANSITIONED') {
    if (!safeNonNegativeInteger(raw.successorSubmitNotBeforeMs) || raw.successorSubmitNotBeforeMs === 0 || raw.successorSubmitNotBeforeMs >= deadlineMs) {
      throw new ResilienceEnvelopeError('resilience_transition_once', 'transition response lacks a valid submit fence');
    }
  } else if (raw.successorSubmitNotBeforeMs !== undefined) {
    throw new ResilienceEnvelopeError('resilience_transition_once', 'non-transition response contains a submit fence');
  }
  if (current === 'OBSERVATION_RECORDED' && successor !== undefined) {
    throw new ResilienceEnvelopeError('resilience_transition_once', 'observation-only response contains a successor');
  }
  if (raw.idempotentReplay !== undefined && typeof raw.idempotentReplay !== 'boolean') {
    throw new ResilienceEnvelopeError('resilience_transition_once', 'replay marker is invalid');
  }
  return { status: current as TransitionResponse['status'], successor, successorProviderId: successorProvider, successorSubmitNotBeforeMs: current === 'TRANSITIONED' ? raw.successorSubmitNotBeforeMs : undefined, idempotentReplay: raw.idempotentReplay as boolean | undefined, reason: reason(raw) };
}

export async function requestCancel(
  active: ResilienceActiveTuple,
  cancelId: string,
  client?: ResilienceClient,
): Promise<CancelResponse> {
  const raw = await call('resilience_request_cancel', { active, cancel_id: cancelId }, client);
  const current = status(raw, 'resilience_request_cancel');
  if (!['ACK_CANCELLED', 'ACK_ALREADY_TERMINAL', 'ACK_UNCERTAIN', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_request_cancel', 'unknown status');
  return { status: current as CancelResponse['status'], reason: reason(raw) };
}

export async function recoverAndTransitionOnce(
  active: ResilienceActiveTuple,
  recoveryId: string,
  jitterMs: number,
  normalizedFailure: ResilienceNormalizedFailure,
  client?: ResilienceClient,
): Promise<RecoveryResponse> {
  if (!Number.isSafeInteger(jitterMs) || jitterMs !== 250) throw new ResilienceEnvelopeError('resilience_recover_and_transition_once', 'recovery jitter must be exactly 250ms');
  const validated = ResilienceNormalizedFailureSchema.safeParse(normalizedFailure);
  if (!validated.success || validated.data.code !== 'pre_dispatch_timeout') throw new ResilienceEnvelopeError('resilience_recover_and_transition_once', 'recovery failure is invalid');
  const raw = await call('resilience_recover_and_transition_once', { active, recovery_id: recoveryId, jitter_ms: jitterMs, normalized_failure: validated.data }, client);
  const current = status(raw, 'resilience_recover_and_transition_once');
  if (!['RECOVERED', 'TRANSITIONED', 'TERMINAL', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_recover_and_transition_once', 'unknown status');
  if (current === 'RECOVERED' || current === 'TRANSITIONED') {
    if (!safeNonNegativeInteger(raw.successorSubmitNotBeforeMs) || raw.successorSubmitNotBeforeMs === 0) throw new ResilienceEnvelopeError('resilience_recover_and_transition_once', 'recovery response lacks a submit fence');
  } else if (raw.successorSubmitNotBeforeMs !== undefined) {
    throw new ResilienceEnvelopeError('resilience_recover_and_transition_once', 'terminal recovery response contains a submit fence');
  }
  return { status: current as RecoveryResponse['status'], successor: raw.successor === undefined ? undefined : tuple(raw.successor, 'resilience_recover_and_transition_once'), successorProviderId: typeof raw.successorProviderId === 'string' ? raw.successorProviderId : undefined, successorSubmitNotBeforeMs: current === 'RECOVERED' || current === 'TRANSITIONED' ? raw.successorSubmitNotBeforeMs : undefined, reason: reason(raw) };
}

export async function finalizeAttempt(
  active: ResilienceActiveTuple,
  failure: ResilienceNormalizedFailure,
  failureSource: 'engine' | 'gateway' | 'recovery',
  terminalOutcome: 'failed' | 'cancelled' | 'cancelled_uncertain' | 'terminal',
  idempotencyKey: string,
  client?: ResilienceClient,
): Promise<FinalizeResponse> {
  const validated = ResilienceNormalizedFailureSchema.safeParse(failure);
  if (!validated.success) throw new ResilienceEnvelopeError('resilience_finalize_attempt', 'failure is not normalized');
  const raw = await call('resilience_finalize_attempt', {
    active, normalized_failure: validated.data, failure_source: failureSource,
    terminal_outcome: terminalOutcome, idempotency_key: idempotencyKey,
  }, client);
  const current = status(raw, 'resilience_finalize_attempt');
  if (!['FINALIZED', 'DUPLICATE', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_finalize_attempt', 'unknown status');
  return { status: current as FinalizeResponse['status'], outcome: typeof raw.outcome === 'string' ? raw.outcome as FinalizeResponse['outcome'] : undefined, reason: reason(raw) };
}

export async function getStatus(taskId: string, client?: ResilienceClient): Promise<StatusResponse> {
  const raw = await call('resilience_get_status', { task_id: taskId }, client);
  const current = status(raw, 'resilience_get_status');
  if (!['ACTIVE', 'CANCEL_PENDING', 'TERMINAL', 'REJECTED'].includes(current) || typeof raw.dispatchAttempted !== 'boolean' || typeof raw.cancellationRequested !== 'boolean' || !Number.isSafeInteger(raw.taskDeadlineMs) || typeof raw.attemptState !== 'string' || typeof raw.executionSubmitted !== 'boolean' || (raw.providerSubmitNotBeforeMs !== undefined && !safeNonNegativeInteger(raw.providerSubmitNotBeforeMs))) throw new ResilienceEnvelopeError('resilience_get_status', 'invalid status response');
  if ((current === 'ACTIVE' || current === 'CANCEL_PENDING') && raw.activeTuple === undefined) throw new ResilienceEnvelopeError('resilience_get_status', 'active tuple is missing');
  if ((current === 'ACTIVE' || current === 'CANCEL_PENDING') && raw.providerSubmitNotBeforeMs === undefined) throw new ResilienceEnvelopeError('resilience_get_status', 'active submit fence is missing');
  if (current === 'CANCEL_PENDING' && raw.cancellationRequested !== true) throw new ResilienceEnvelopeError('resilience_get_status', 'cancellation-pending status lacks the cancellation bit');
  const immutablePlan = raw.immutablePlan === undefined ? undefined : ResilienceImmutablePlanSchema.parse(raw.immutablePlan);
  const providerOrder = raw.providerOrder === undefined ? undefined : Array.isArray(raw.providerOrder) && raw.providerOrder.every((value) => typeof value === 'string') ? raw.providerOrder as string[] : (() => { throw new ResilienceEnvelopeError('resilience_get_status', 'provider order is invalid'); })();
  return { status: current as StatusResponse['status'], activeTuple: raw.activeTuple === undefined ? undefined : tuple(raw.activeTuple, 'resilience_get_status'), providerId: typeof raw.providerId === 'string' ? raw.providerId : undefined, dispatchAttempted: raw.dispatchAttempted, cancellationRequested: raw.cancellationRequested, taskDeadlineMs: raw.taskDeadlineMs as number, immutablePlan, providerOrder, attemptState: raw.attemptState, executionSubmitted: raw.executionSubmitted, providerSubmitNotBeforeMs: safeNonNegativeInteger(raw.providerSubmitNotBeforeMs) ? raw.providerSubmitNotBeforeMs : undefined, reason: reason(raw) };
}

export async function pageOutbox(afterCursor: number, limit: number, client?: ResilienceClient): Promise<OutboxPageResponse> {
  const raw = await call('resilience_page_outbox', { after_cursor: afterCursor, limit }, client);
  const current = status(raw, 'resilience_page_outbox');
  if (current !== 'PAGE' || !Number.isSafeInteger(raw.cursor) || !Number.isSafeInteger(raw.highWaterMark) || !Array.isArray(raw.events)) throw new ResilienceEnvelopeError('resilience_page_outbox', 'invalid outbox page');
  const events = raw.events.map((event) => {
    const parsed = ResilienceOutboxEventSchema.safeParse(event);
    if (!parsed.success) {
      // Phase-1 provenance is additive and allowlisted at this bridge seam.
      // The checked-in P0 contract remains unchanged; cost facts and provider
      // observations may carry one of the three safe source labels.
      const candidate = event !== null && typeof event === 'object' && !Array.isArray(event)
        ? event as Record<string, unknown>
        : null;
      const payload = candidate?.payload !== null && typeof candidate?.payload === 'object' && !Array.isArray(candidate.payload)
        ? candidate.payload as Record<string, unknown>
        : null;
      const kind = String(candidate?.kind);
      const hasTransitionFence = payload !== null && Object.prototype.hasOwnProperty.call(payload, 'successorSubmitNotBeforeMs');
      if (kind === 'transitioned' && hasTransitionFence &&
          safeNonNegativeInteger(payload?.successorSubmitNotBeforeMs)) {
        const withoutFence = { ...candidate, payload: { ...payload } };
        delete (withoutFence.payload as Record<string, unknown>).successorSubmitNotBeforeMs;
        const base = ResilienceOutboxEventSchema.safeParse(withoutFence);
        if (!base.success) throw new ResilienceEnvelopeError('resilience_page_outbox', 'outbox transition provenance is invalid');
        return event as never;
      }
      const source = payload?.source;
      const validSource = typeof source === 'string' && ['exact', 'account_delta', 'unavailable', 'engine', 'gateway', 'recovery'].includes(source);
      const validCostSource = ['exact', 'account_delta', 'unavailable'].includes(String(source));
      const validProviderSource = ['engine', 'gateway', 'recovery'].includes(String(source));
      const normalizedFailure = payload?.payload !== null && typeof payload?.payload === 'object' && !Array.isArray(payload.payload)
        ? payload.payload as Record<string, unknown>
        : null;
      const failureClasses = ['retryable', 'configuration', 'authentication', 'budget', 'side_effect_uncertainty', 'timeout', 'cancelled', 'terminal'];
      const validNormalizedFailure = normalizedFailure !== null
        && Object.keys(normalizedFailure).length === 3
        && typeof normalizedFailure.failureClass === 'string'
        && failureClasses.includes(normalizedFailure.failureClass)
        && typeof normalizedFailure.code === 'string'
        && /^[a-z][a-z0-9_]{0,63}$/.test(normalizedFailure.code)
        && typeof normalizedFailure.retryable === 'boolean'
        && normalizedFailure.retryable === (normalizedFailure.failureClass === 'retryable');
      const validProviderEvent = kind === 'provider_event'
        && payload?.eventKind === 'observation'
        && validNormalizedFailure
        && validProviderSource;
      const validCostEvent = ['cost_recorded', 'attempt_completed'].includes(kind)
        && validCostSource
        && (payload?.known !== false || source === 'unavailable');
      if (!candidate || !payload || !validSource || (!validProviderEvent && !validCostEvent)) {
        throw new ResilienceEnvelopeError('resilience_page_outbox', 'outbox event is invalid');
      }
      if (validProviderEvent) return event as never;
      const withoutSource = { ...candidate, payload: { ...payload } };
      delete (withoutSource.payload as Record<string, unknown>).source;
      const base = ResilienceOutboxEventSchema.safeParse(withoutSource);
      if (!base.success) throw new ResilienceEnvelopeError('resilience_page_outbox', 'outbox cost provenance is invalid');
      return event as never;
    }
    return parsed.data;
  });
  return { status: 'PAGE', cursor: raw.cursor as number, highWaterMark: raw.highWaterMark as number, events, reason: reason(raw) };
}

/** Persist-first bridge cancellation signal. The caller must invoke
 * requestCancel before this transport cancellation function. */
export type ProviderCancelSignalStatus = 'cancelled' | 'noop' | 'unknown';

export async function signalProviderCancel(active: ResilienceActiveTuple, reasonText: string, client?: ResilienceClient): Promise<ProviderCancelSignalStatus> {
  const c = client ?? (getClient('hermes') as unknown as ResilienceClient);
  const result = await c.callTool({ name: 'cancel_task', arguments: { task_id: active.attemptId, reason: reasonText } });
  const raw = parseMcpResult(result, 'cancel_task');
  const current = String(raw.status);
  if (!['cancelled', 'noop', 'unknown'].includes(current)) throw new ResilienceEnvelopeError('cancel_task', 'operator cancellation response is invalid');
  return current as ProviderCancelSignalStatus;
}

/** Attempt timeout uses a distinct Hermes stop transport, never operator
 * cancellation, and returns only the typed stop acknowledgement. */
export async function signalAttemptTimeout(active: ResilienceActiveTuple, client?: ResilienceClient): Promise<AttemptStopResponse> {
  const c = client ?? (getClient('hermes') as unknown as ResilienceClient);
  const result = await c.callTool({ name: 'attempt_timeout', arguments: { active, timeout_ms: 2_000 } });
  const raw = parseMcpResult(result, 'attempt_timeout');
  if (!['ACK_PRE_DISPATCH', 'ACK_UNCERTAIN', 'REJECTED'].includes(String(raw.status))) throw new ResilienceEnvelopeError('attempt_timeout', 'attempt-timeout acknowledgement is invalid');
  if (raw.status === 'ACK_PRE_DISPATCH') {
    if (raw.activeTuple === undefined || raw.dispatchAttempted !== false) throw new ResilienceEnvelopeError('attempt_timeout', 'pre-dispatch acknowledgement lacks the durable fence check');
    return { status: 'ACK_PRE_DISPATCH', activeTuple: tuple(raw.activeTuple, 'attempt_timeout'), dispatchAttempted: false, reason: reason(raw) };
  }
  return { status: raw.status as AttemptStopResponse['status'], reason: reason(raw) };
}

export interface AttemptResult {
  text: string;
  telemetry: Record<string, unknown>;
  observation?: NormalizedObservation;
  dispatchAttempted: boolean;
  cancelled?: boolean;
  terminalCommitted?: boolean;
  terminalOutcome?: PollResponse['terminalOutcome'];
}

/** One bounded provider attempt. The bridge relays only normalized
 * observations; it never selects a successor or edits the immutable plan. */
export async function executeHermesAttempt(
  payload: GatewayRequest,
  plan: ResilienceImmutablePlan,
  active: ResilienceActiveTuple,
  providerRef: ProviderReference,
  emit: Emitter,
  options: { nowMs?: () => number; sleepMs?: (ms: number) => Promise<void>; client?: ResilienceClient; signal?: AbortSignal; providerSubmitNotBeforeMs?: number } = {},
): Promise<AttemptResult> {
  const now = options.nowMs ?? Date.now;
  const sleep = options.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attemptDeadlineMs = Math.min(plan.taskDeadlineMs, now() + plan.attemptTimeoutMs);
  if (now() >= attemptDeadlineMs) return { text: '', telemetry: {}, dispatchAttempted: false, observation: { kind: 'timeout', dispatchAttempted: false, failureSource: 'gateway' } };
  const withDeadline = async <T>(operation: Promise<T>): Promise<T | undefined> => {
    const remaining = Math.max(0, attemptDeadlineMs - now());
    if (remaining <= 0) return undefined;
    return await new Promise<T | undefined>((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), remaining);
      const onAbort = () => { clearTimeout(timer); resolve(undefined); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      operation.then((value) => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); resolve(value); }, (error) => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); reject(error); });
    });
  };
  const pollIntervalMs = 25;
  let pollCount = 0;
  const telemetry = (extra: Record<string, unknown> = {}) => ({ failover: true, pollCount, pollIntervalMs, ...extra });
  const waitPollInterval = async (ms: number): Promise<boolean> => {
    if (options.signal?.aborted) return false;
    if (!options.signal) {
      await sleep(ms);
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        options.signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(false);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      void sleep(ms).then(() => finish(true), () => finish(false));
    });
  };
  const waitForSubmitFence = async (): Promise<boolean> => {
    const fence = options.providerSubmitNotBeforeMs;
    if (fence === undefined) return true;
    if (!safeNonNegativeInteger(fence)) return false;
    if (fence === 0) return true;
    if (fence >= attemptDeadlineMs) return false;
    while (now() < fence) {
      const remaining = fence - now();
      if (!(await waitPollInterval(Math.max(1, Math.min(50, remaining))))) return false;
    }
    return !options.signal?.aborted;
  };
  let submitted: SubmitResponse | undefined;
  for (;;) {
    if (!(await waitForSubmitFence())) {
      return { text: '', telemetry: telemetry(), dispatchAttempted: false, observation: { kind: options.signal?.aborted ? 'cancelled' : 'timeout', dispatchAttempted: false, failureSource: 'gateway' } };
    }
    submitted = await withDeadline(submitAttempt(payload, plan, active, providerRef, attemptDeadlineMs, `${active.taskId}:${active.attemptId}:submit`, options.client));
    if (!submitted) break;
    if (submitted.status !== 'NOT_READY') break;
    if (!(await waitPollInterval(submitted.retryAfterMs ?? 1))) {
      return { text: '', telemetry: telemetry(), dispatchAttempted: false, observation: { kind: options.signal?.aborted ? 'cancelled' : 'timeout', dispatchAttempted: false, failureSource: 'gateway' } };
    }
  }
  if (!submitted) return { text: '', telemetry: telemetry(), dispatchAttempted: false, observation: { kind: 'timeout', dispatchAttempted: false, failureSource: 'gateway' } };
  if (submitted.status === 'REJECTED') return { text: '', telemetry: telemetry(), dispatchAttempted: false, observation: { kind: 'failure', dispatchAttempted: false, failure: { failureClass: 'terminal', code: 'unknown', retryable: false }, failureSource: 'gateway' } };
  if (submitted.executionState === 'ORPHANED') return { text: '', telemetry: telemetry(), dispatchAttempted: true, observation: { kind: 'failure', dispatchAttempted: true, failure: { failureClass: 'side_effect_uncertainty', code: 'dispatch_attempted', retryable: false }, failureSource: 'recovery' } };
  emit('SYSTEM', `Hermes resilience attempt started (${providerRef.label})`, { attemptId: active.attemptId, epoch: active.epoch, providerId: providerRef.id });
  let cursor = 0;
  let dispatchAttempted = false;
  for (;;) {
    if (options.signal?.aborted) {
      return { text: '', telemetry: telemetry({ cancelled: true }), dispatchAttempted, observation: { kind: 'cancelled', dispatchAttempted, failureSource: 'gateway' } };
    }
    if (now() >= attemptDeadlineMs) {
      return { text: '', telemetry: telemetry(), dispatchAttempted, observation: { kind: 'timeout', dispatchAttempted, failureSource: 'gateway' } };
    }
    pollCount += 1;
    const page = await withDeadline(pollObservations(active, cursor, attemptDeadlineMs, options.client));
    if (!page) return { text: '', telemetry: telemetry(), dispatchAttempted, observation: { kind: options.signal?.aborted ? 'cancelled' : 'timeout', dispatchAttempted, failureSource: 'gateway' } };
    if (page.status === 'REJECTED') return { text: '', telemetry: telemetry(), dispatchAttempted, observation: { kind: 'failure', dispatchAttempted, failure: { failureClass: 'terminal', code: 'unknown', retryable: false }, failureSource: 'gateway' } };
    cursor = page.cursor;
    for (const observation of page.observations) {
      dispatchAttempted ||= observation.dispatchAttempted;
      if (observation.kind === 'progress') continue;
      if (observation.kind === 'result') return { text: observation.text ?? '', telemetry: { ...telemetry(), ...(observation.telemetry ?? {}) }, dispatchAttempted, observation, terminalCommitted: page.terminalCommitted, terminalOutcome: page.terminalOutcome };
      if (observation.kind === 'cancelled') return { text: '', telemetry: { ...telemetry(), ...(observation.telemetry ?? {}), cancelled: true }, dispatchAttempted, observation, cancelled: true, terminalCommitted: page.terminalCommitted, terminalOutcome: page.terminalOutcome };
      return { text: '', telemetry: { ...telemetry(), ...(observation.telemetry ?? {}) }, dispatchAttempted, observation, terminalCommitted: page.terminalCommitted, terminalOutcome: page.terminalOutcome };
    }
    if (page.terminal) return { text: '', telemetry: telemetry(), dispatchAttempted, observation: { kind: 'failure', dispatchAttempted, failure: { failureClass: 'terminal', code: 'unknown', retryable: false }, failureSource: 'engine' } };
    const remaining = Math.max(0, attemptDeadlineMs - now());
    if (remaining <= 0 || !(await waitPollInterval(Math.min(pollIntervalMs, remaining)))) {
      return { text: '', telemetry: telemetry(), dispatchAttempted, observation: { kind: options.signal?.aborted ? 'cancelled' : 'timeout', dispatchAttempted, failureSource: 'gateway' } };
    }
  }
}
