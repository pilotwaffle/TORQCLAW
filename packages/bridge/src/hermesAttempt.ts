import {
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
  'resilience_transition_once',
  'resilience_request_cancel',
  'resilience_recover_and_transition_once',
  'resilience_get_status',
  'resilience_page_outbox',
] as const);

export type ResilienceToolName = typeof RESILIENCE_TOOL_NAMES[number];

export class ResilienceEnvelopeError extends Error {
  readonly operation: ResilienceToolName;
  constructor(operation: ResilienceToolName, message: string) {
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
  status: 'SUBMITTED' | 'DUPLICATE' | 'REJECTED';
  activeTuple?: ResilienceActiveTuple;
  reason?: string;
}
export interface NormalizedObservation {
  kind: 'progress' | 'result' | 'failure' | 'cancelled' | 'timeout';
  failure?: ResilienceNormalizedFailure;
  text?: string;
  telemetry?: Record<string, unknown>;
  dispatchAttempted: boolean;
  providerId?: string;
}
export interface PollResponse {
  status: 'OBSERVATIONS' | 'TERMINAL' | 'REJECTED';
  cursor: number;
  observations: NormalizedObservation[];
  terminal?: boolean;
  reason?: string;
}
export interface RecordResponse { status: 'RECORDED' | 'DUPLICATE' | 'REJECTED'; reason?: string }
export interface TransitionResponse {
  status: 'TRANSITIONED' | 'REJECTED';
  successor?: ResilienceActiveTuple;
  successorProviderId?: string;
  reason?: string;
}
export interface CancelResponse {
  status: 'ACK_CANCELLED' | 'ACK_ALREADY_TERMINAL' | 'ACK_UNCERTAIN' | 'REJECTED';
  reason?: string;
}
export interface RecoveryResponse {
  status: 'RECOVERED' | 'TRANSITIONED' | 'TERMINAL' | 'REJECTED';
  successor?: ResilienceActiveTuple;
  reason?: string;
}
export interface StatusResponse {
  status: 'ACTIVE' | 'TERMINAL' | 'REJECTED';
  activeTuple?: ResilienceActiveTuple;
  providerId?: string;
  dispatchAttempted: boolean;
  cancellationRequested: boolean;
  taskDeadlineMs: number;
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

function objectOnly(value: unknown, operation: ResilienceToolName): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResilienceEnvelopeError(operation, 'envelope is not an object');
  }
  return value as Record<string, unknown>;
}

function tuple(value: unknown, operation: ResilienceToolName): ResilienceActiveTuple {
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

function parseMcpResult(raw: unknown, operation: ResilienceToolName): Record<string, unknown> {
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
  const allowed = ['kind', 'failure', 'text', 'telemetry', 'dispatchAttempted', 'providerId'];
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
    const allowedTelemetry = ['costUsd', 'costSource', 'inferenceLatencyMs', 'iterations', 'cancelled'];
    if (Object.keys(telemetry).some((key) => !allowedTelemetry.includes(key))) throw new ResilienceEnvelopeError(operation, 'telemetry is not normalized');
    if (telemetry.costUsd !== undefined && typeof telemetry.costUsd !== 'number') throw new ResilienceEnvelopeError(operation, 'costUsd is invalid');
    if (telemetry.costSource !== undefined && !['exact', 'account_delta', 'unavailable'].includes(String(telemetry.costSource))) throw new ResilienceEnvelopeError(operation, 'costSource is invalid');
    if (telemetry.inferenceLatencyMs !== undefined && typeof telemetry.inferenceLatencyMs !== 'number') throw new ResilienceEnvelopeError(operation, 'latency is invalid');
    if (telemetry.iterations !== undefined && !Number.isSafeInteger(telemetry.iterations)) throw new ResilienceEnvelopeError(operation, 'iterations is invalid');
    if (telemetry.cancelled !== undefined && typeof telemetry.cancelled !== 'boolean') throw new ResilienceEnvelopeError(operation, 'cancelled is invalid');
    out.telemetry = { ...telemetry };
  }
  if (raw.providerId !== undefined) {
    if (typeof raw.providerId !== 'string' || raw.providerId.length > 128) throw new ResilienceEnvelopeError(operation, 'providerId is invalid');
    out.providerId = raw.providerId;
  }
  return out;
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
  payload: unknown,
  plan: ResilienceImmutablePlan,
  active: ResilienceActiveTuple,
  providerRef: ProviderReference,
  attemptDeadlineMs: number,
  idempotencyKey: string,
  client?: ResilienceClient,
): Promise<SubmitResponse> {
  const raw = await call('resilience_submit_attempt', {
    payload, immutable_plan: plan, active,
    provider_ref: pythonProviderReference(providerRef),
    attempt_deadline_ms: attemptDeadlineMs, idempotency_key: idempotencyKey,
  }, client);
  const current = status(raw, 'resilience_submit_attempt');
  if (!['SUBMITTED', 'DUPLICATE', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_submit_attempt', 'invalid submit response');
  if (current !== 'REJECTED' && raw.activeTuple === undefined) throw new ResilienceEnvelopeError('resilience_submit_attempt', 'active tuple is missing');
  return { status: current as SubmitResponse['status'], activeTuple: raw.activeTuple === undefined ? undefined : tuple(raw.activeTuple, 'resilience_submit_attempt'), reason: reason(raw) };
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
  return { status: current as PollResponse['status'], cursor: raw.cursor as number, observations: raw.observations.map((entry) => normalizeObservation(entry, 'resilience_poll_observations')), terminal: raw.terminal === true, reason: reason(raw) };
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
): Promise<TransitionResponse> {
  if (!Number.isSafeInteger(jitterMs) || jitterMs < 250 || jitterMs > 750) throw new ResilienceEnvelopeError('resilience_transition_once', 'jitter is outside the bounded range');
  const validated = ResilienceNormalizedFailureSchema.safeParse(failure);
  if (!validated.success) throw new ResilienceEnvelopeError('resilience_transition_once', 'failure is not normalized');
  const raw = await call('resilience_transition_once', {
    active, successor_provider_id: successorProviderId, normalized_failure: validated.data,
    jitter_ms: jitterMs, plan_hash: planHashValue, idempotency_key: idempotencyKey,
  }, client);
  const current = status(raw, 'resilience_transition_once');
  if (!['TRANSITIONED', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_transition_once', 'unknown status');
  return { status: current as TransitionResponse['status'], successor: raw.successor === undefined ? undefined : tuple(raw.successor, 'resilience_transition_once'), successorProviderId: typeof raw.successorProviderId === 'string' ? raw.successorProviderId : undefined, reason: reason(raw) };
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
  deadlineMs: number,
  client?: ResilienceClient,
): Promise<RecoveryResponse> {
  const raw = await call('resilience_recover_and_transition_once', { active, recovery_id: recoveryId, jitter_ms: jitterMs }, client);
  const current = status(raw, 'resilience_recover_and_transition_once');
  if (!['RECOVERED', 'TRANSITIONED', 'TERMINAL', 'REJECTED'].includes(current)) throw new ResilienceEnvelopeError('resilience_recover_and_transition_once', 'unknown status');
  return { status: current as RecoveryResponse['status'], successor: raw.successor === undefined ? undefined : tuple(raw.successor, 'resilience_recover_and_transition_once'), reason: reason(raw) };
}

export async function getStatus(taskId: string, client?: ResilienceClient): Promise<StatusResponse> {
  const raw = await call('resilience_get_status', { task_id: taskId }, client);
  const current = status(raw, 'resilience_get_status');
  if (!['ACTIVE', 'TERMINAL', 'REJECTED'].includes(current) || typeof raw.dispatchAttempted !== 'boolean' || typeof raw.cancellationRequested !== 'boolean' || !Number.isSafeInteger(raw.taskDeadlineMs)) throw new ResilienceEnvelopeError('resilience_get_status', 'invalid status response');
  return { status: current as StatusResponse['status'], activeTuple: raw.activeTuple === undefined ? undefined : tuple(raw.activeTuple, 'resilience_get_status'), providerId: typeof raw.providerId === 'string' ? raw.providerId : undefined, dispatchAttempted: raw.dispatchAttempted, cancellationRequested: raw.cancellationRequested, taskDeadlineMs: raw.taskDeadlineMs as number, reason: reason(raw) };
}

export async function pageOutbox(afterCursor: number, limit: number, client?: ResilienceClient): Promise<OutboxPageResponse> {
  const raw = await call('resilience_page_outbox', { after_cursor: afterCursor, limit }, client);
  const current = status(raw, 'resilience_page_outbox');
  if (current !== 'PAGE' || !Number.isSafeInteger(raw.cursor) || !Number.isSafeInteger(raw.highWaterMark) || !Array.isArray(raw.events)) throw new ResilienceEnvelopeError('resilience_page_outbox', 'invalid outbox page');
  const events = raw.events.map((event) => {
    const parsed = ResilienceOutboxEventSchema.safeParse(event);
    if (!parsed.success) throw new ResilienceEnvelopeError('resilience_page_outbox', 'outbox event is invalid');
    return parsed.data;
  });
  return { status: 'PAGE', cursor: raw.cursor as number, highWaterMark: raw.highWaterMark as number, events, reason: reason(raw) };
}

/** Persist-first bridge cancellation signal. The caller must invoke
 * requestCancel before this transport cancellation function. */
export async function signalProviderCancel(active: ResilienceActiveTuple, reasonText: string, client?: ResilienceClient): Promise<void> {
  const c = client ?? (getClient('hermes') as unknown as ResilienceClient);
  const result = await c.callTool({ name: 'cancel_task', arguments: { task_id: active.attemptId, reason: reasonText } });
  parseMcpResult(result, 'resilience_request_cancel');
}

export interface AttemptResult {
  text: string;
  telemetry: Record<string, unknown>;
  observation?: NormalizedObservation;
  dispatchAttempted: boolean;
  cancelled?: boolean;
}

/** One bounded provider attempt. The bridge relays only normalized
 * observations; it never selects a successor or edits the immutable plan. */
export async function executeHermesAttempt(
  payload: unknown,
  plan: ResilienceImmutablePlan,
  active: ResilienceActiveTuple,
  providerRef: ProviderReference,
  emit: Emitter,
  options: { nowMs?: () => number; sleepMs?: (ms: number) => Promise<void>; client?: ResilienceClient } = {},
): Promise<AttemptResult> {
  const now = options.nowMs ?? Date.now;
  const sleep = options.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attemptDeadlineMs = Math.min(plan.taskDeadlineMs, now() + plan.attemptTimeoutMs);
  if (now() >= attemptDeadlineMs) throw new Error('FAILOVER_ATTEMPT_DEADLINE');
  const withDeadline = async <T>(operation: Promise<T>): Promise<T | undefined> => {
    const remaining = Math.max(0, attemptDeadlineMs - now());
    if (remaining <= 0) return undefined;
    return await new Promise<T | undefined>((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), remaining);
      operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  };
  const submitted = await withDeadline(submitAttempt(payload, plan, active, providerRef, attemptDeadlineMs, `${active.taskId}:${active.attemptId}:submit`, options.client));
  if (!submitted) return { text: '', telemetry: { failover: true }, dispatchAttempted: false, observation: { kind: 'timeout', dispatchAttempted: false } };
  emit('SYSTEM', `Hermes resilience attempt started (${providerRef.label})`, { attemptId: active.attemptId, epoch: active.epoch, providerId: providerRef.id });
  let cursor = 0;
  let dispatchAttempted = false;
  for (;;) {
    if (now() >= attemptDeadlineMs) {
      return { text: '', telemetry: { failover: true }, dispatchAttempted, observation: { kind: 'timeout', dispatchAttempted } };
    }
    const page = await withDeadline(pollObservations(active, cursor, attemptDeadlineMs, options.client));
    if (!page) return { text: '', telemetry: { failover: true }, dispatchAttempted, observation: { kind: 'timeout', dispatchAttempted } };
    cursor = page.cursor;
    for (const observation of page.observations) {
      dispatchAttempted ||= observation.dispatchAttempted;
      if (observation.kind === 'progress') continue;
      if (observation.kind === 'result') return { text: observation.text ?? '', telemetry: observation.telemetry ?? {}, dispatchAttempted, observation };
      if (observation.kind === 'cancelled') return { text: '', telemetry: { ...(observation.telemetry ?? {}), cancelled: true }, dispatchAttempted, observation, cancelled: true };
      return { text: '', telemetry: observation.telemetry ?? {}, dispatchAttempted, observation };
    }
    if (page.terminal) return { text: '', telemetry: { failover: true }, dispatchAttempted, observation: { kind: 'failure', dispatchAttempted } };
    await sleep(0);
  }
}
