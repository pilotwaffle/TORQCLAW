import { randomUUID } from 'node:crypto';
import { ComputeTier, ResilienceImmutablePlanSchema, type GatewayRequest, type RouterDiagnostics, type ResilienceNormalizedFailure, type ResilienceActiveTuple, type ResilienceImmutablePlan } from '@torqclaw/contracts';
import {
  admitFrontier,
  executeHermesAttempt,
  finalizeAttempt,
  getStatus,
  pageOutbox,
  pollObservations,
  recordObservation,
  recoverAndTransitionOnce,
  requestCancel,
  signalProviderCancel,
  signalAttemptTimeout,
  submitAttempt,
  transitionOnce,
  type AdmitResponse,
  type CancelResponse,
  type AttemptStopResponse,
  type NormalizedObservation,
  type ProviderReference,
  type ResilienceClient,
} from '@torqclaw/bridge';
import { makeEmitter, type Emitter } from './events.js';
import { withVerifiedTerminalReceipt } from './receipts.js';
import {
  assertFrontier,
  buildFailoverPlan,
  isFailoverEnabled,
  planHash,
  providerReference,
  resolveProviderChain,
  type PlanOptions,
  type ProviderChainsDocument,
  type ResolvedProviderChain,
} from './providerChains.js';
import type { GatewayProjectionEvent } from './storage.js';

export type FailureObservation = {
  transport?: string;
  httpStatus?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  providerCode?: string;
  dispatchAttempted?: boolean;
  error?: unknown;
};

export type FailureClass = ResilienceNormalizedFailure['failureClass'];

export class FailoverTerminalError extends Error {
  readonly failure: ResilienceNormalizedFailure;
  readonly dispatchAttempted: boolean;
  readonly terminalOutcome: 'failed' | 'cancelled' | 'cancelled_uncertain' | 'terminal';
  readonly telemetry: Record<string, unknown>;
  constructor(
    failure: ResilienceNormalizedFailure,
    dispatchAttempted: boolean,
    terminalOutcome: FailoverTerminalError['terminalOutcome'] = 'failed',
    telemetry: Record<string, unknown> = {},
  ) {
    super(`FAILOVER_${failure.code}`);
    this.name = 'FailoverTerminalError';
    this.failure = failure;
    this.dispatchAttempted = dispatchAttempted;
    this.terminalOutcome = terminalOutcome;
    this.telemetry = telemetry;
  }
}

const RETRYABLE_CODES = new Set(['connection', 'dns', 'http_408', 'http_429', 'http_5xx', 'pre_dispatch_timeout']);

/** Production-side adapter for typed transport failures. It reads only
 * machine-level names/codes/statuses and emits the frozen safe taxonomy; raw
 * exception text, headers, bodies, endpoints, and credentials are ignored. */
export function normalizeProviderFailure(error: unknown, dispatchAttempted = false): ResilienceNormalizedFailure {
  if (dispatchAttempted) return { failureClass: 'side_effect_uncertainty', code: 'dispatch_attempted', retryable: false };
  const value = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const response = value.response !== null && typeof value.response === 'object' ? value.response as Record<string, unknown> : {};
  const status = [value.status, value.statusCode, response.status].find((candidate) => typeof candidate === 'number') as number | undefined;
  const code = [value.code, value.name].find((candidate) => typeof candidate === 'string') as string | undefined;
  const normalizedCode = code?.toLowerCase();
  if (normalizedCode === 'enotfound' || normalizedCode === 'eai_again' || normalizedCode === 'dns' || normalizedCode === 'dnserror') return { failureClass: 'retryable', code: 'dns', retryable: true };
  if (normalizedCode === 'econnreset' || normalizedCode === 'econnrefused' || normalizedCode === 'etimedout' || normalizedCode === 'connection' || normalizedCode === 'connectionerror') return { failureClass: 'retryable', code: 'connection', retryable: true };
  if (status === 408 || status === 429) return { failureClass: 'retryable', code: `http_${status}`, retryable: true };
  if (typeof status === 'number' && status >= 500 && status <= 599) return { failureClass: 'retryable', code: 'http_5xx', retryable: true };
  if (status === 400 || status === 404 || normalizedCode === 'configuration') return { failureClass: 'configuration', code: status === 400 || status === 404 ? `http_${status}` : 'configuration', retryable: false };
  if (normalizedCode === 'malformed_response') return { failureClass: 'terminal', code: 'malformed_response', retryable: false };
  if (status === 401 || status === 403 || normalizedCode === 'missing_credentials' || normalizedCode === 'invalid_credentials') return { failureClass: 'authentication', code: status === 401 || status === 403 ? `http_${status}` : normalizedCode as 'missing_credentials' | 'invalid_credentials', retryable: false };
  return { failureClass: 'terminal', code: 'unknown', retryable: false };
}

/** Central failure parser. It accepts normalized fields only and always
 * returns a safe, stable code; raw provider text is deliberately ignored. */
export function classifyProviderFailure(observation: FailureObservation): ResilienceNormalizedFailure {
  if (observation.dispatchAttempted === true) return { failureClass: 'side_effect_uncertainty', code: 'dispatch_attempted', retryable: false };
  if (observation.cancelled === true) return { failureClass: 'cancelled', code: 'operator_cancel', retryable: false };
  if (observation.timedOut === true) return { failureClass: 'retryable', code: 'pre_dispatch_timeout', retryable: true };
  if (observation.error !== undefined) return normalizeProviderFailure(observation.error, observation.dispatchAttempted ?? false);
  const code = observation.providerCode?.toLowerCase();
  if (code === 'connection' || code === 'dns') return { failureClass: 'retryable', code, retryable: true };
  if (typeof observation.httpStatus === 'number') {
    const status = observation.httpStatus;
    if (status === 408 || status === 429) return { failureClass: 'retryable', code: `http_${status}`, retryable: true };
    if (status >= 500 && status <= 599) return { failureClass: 'retryable', code: 'http_5xx', retryable: true };
    if (status === 400 || status === 404) return { failureClass: 'configuration', code: `http_${status}`, retryable: false };
    if (status === 401 || status === 403) return { failureClass: 'authentication', code: `http_${status}`, retryable: false };
  }
  if (code === 'reservation_refused' || code === 'budget_exceeded') return { failureClass: 'budget', code: 'budget_exceeded', retryable: false };
  if (code === 'invalid_model' || code === 'malformed_request' || code === 'configuration') return { failureClass: 'configuration', code: 'configuration', retryable: false };
  if (code === 'missing_credentials' || code === 'invalid_credentials') return { failureClass: 'authentication', code, retryable: false };
  if (code === 'cancel_ack_missing' || code === 'attempt_timeout') return { failureClass: 'timeout', code: 'attempt_timeout', retryable: false };
  if (code === 'post_dispatch_orphan' || code === 'tool_disconnect') return { failureClass: 'side_effect_uncertainty', code: 'dispatch_attempted', retryable: false };
  if (code && RETRYABLE_CODES.has(code)) return { failureClass: 'retryable', code, retryable: true };
  return { failureClass: 'terminal', code: 'unknown', retryable: false };
}

export interface TransitionChecks {
  activeExact: boolean;
  dispatchAttempted: boolean;
  cancellationRequested: boolean;
  nowMs: number;
  deadlineMs: number;
  successorExists: boolean;
  successorDiffers: boolean;
  successorLater: boolean;
  transitionCount: number;
  /**
   * These policy facts are optional because the gateway is not their
   * authority.  An omitted value is recorded as deferred and the fused
   * ledger transition remains the final decision.
   */
  privacyEligible?: boolean;
  budgetAvailable?: boolean;
  circuitOpen?: boolean;
  failure: ResilienceNormalizedFailure;
}

export interface TransitionDecision {
  allowed: boolean;
  /** True when the ledger must still authorize policy facts. */
  authorityDeferred: boolean;
  trace: string[];
  reason: string;
}

/** One ordered precedence function used by both the controller and tests. */
export function decideTransition(checks: TransitionChecks): TransitionDecision {
  const trace: string[] = [];
  let authorityDeferred = false;
  const check = (name: string, value: boolean | undefined, reason: string): boolean => {
    if (value === undefined) {
      authorityDeferred = true;
      trace.push(`${name}:deferred`);
      return true;
    }
    trace.push(`${name}:${value ? 'pass' : 'fail'}`);
    if (!value) return false;
    return true;
  };
  const denied = (reason: string): TransitionDecision => ({ allowed: false, authorityDeferred: false, trace, reason });
  if (!check('active_exact_tuple', checks.activeExact, 'stale_tuple')) return denied('stale_tuple');
  if (!check('pre_dispatch', !checks.dispatchAttempted, 'dispatch_attempted')) return denied('dispatch_attempted');
  if (!check('not_cancelled', !checks.cancellationRequested, 'cancel_requested')) return denied('cancel_requested');
  if (!check('before_deadline', checks.nowMs < checks.deadlineMs, 'deadline_expired')) return denied('deadline_expired');
  if (!check('successor_exists', checks.successorExists, 'no_successor')) return denied('no_successor');
  if (!check('successor_differs', checks.successorDiffers, 'same_provider')) return denied('same_provider');
  if (!check('successor_later', checks.successorLater, 'successor_order_invalid')) return denied('successor_order_invalid');
  if (!check('transition_limit', checks.transitionCount === 0, 'transition_limit')) return denied('transition_limit');
  if (!check('privacy_eligible', checks.privacyEligible, 'privacy_ineligible')) return denied('privacy_ineligible');
  if (!check('budget_available', checks.budgetAvailable, 'budget_unavailable')) return denied('budget_unavailable');
  if (!check('circuit_closed', checks.circuitOpen === undefined ? undefined : !checks.circuitOpen, 'circuit_open')) return denied('circuit_open');
  if (!check('retryable_failure', checks.failure.retryable, 'failure_not_retryable')) return denied('failure_not_retryable');
  if (authorityDeferred) return { allowed: false, authorityDeferred: true, trace, reason: 'policy_authority_deferred' };
  return { allowed: true, authorityDeferred: false, trace, reason: 'eligible' };
}

export function jitterDelayMs(random = Math.random): number {
  const value = random();
  if (!Number.isFinite(value)) return 250;
  return Math.min(750, Math.max(250, 250 + Math.floor(Math.max(0, Math.min(0.999999999, value)) * 501)));
}

export function validateSuccessorTuple(
  predecessor: ResilienceActiveTuple,
  successor: ResilienceActiveTuple,
  orderedProviderIds: readonly string[],
): boolean {
  return successor.taskId === predecessor.taskId &&
    successor.epoch === predecessor.epoch + 1 &&
    successor.attemptId !== predecessor.attemptId &&
    successor.epoch >= 0 && successor.epoch < orderedProviderIds.length;
}

export async function persistFirstCancel(
  persist: () => Promise<CancelResponse>,
  signal: () => Promise<unknown>,
): Promise<'cancelled' | 'cancelled_uncertain' | 'noop'> {
  let persisted: CancelResponse;
  try {
    persisted = await persist();
  } catch {
    return 'cancelled_uncertain';
  }
  if (persisted.status === 'ACK_UNCERTAIN' || persisted.status === 'REJECTED') return 'cancelled_uncertain';
  if (persisted.status === 'ACK_ALREADY_TERMINAL') return 'noop';
  try {
    const acknowledged = await signal();
    if (acknowledged !== 'cancelled') return 'cancelled_uncertain';
  } catch {
    return 'cancelled_uncertain';
  }
  return 'cancelled';
}

export function withinMs<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('FAILOVER_CANCEL_ACK_TIMEOUT')), timeoutMs);
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function waitAbortable(
  delayMs: number,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<'elapsed' | 'aborted'> {
  if (signal.aborted) return 'aborted';
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await new Promise<'elapsed' | 'aborted'>((resolve) => {
    const done = (result: 'elapsed' | 'aborted') => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => done('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(delayMs).then(() => done('elapsed'), () => done('aborted'));
  });
}

export interface FailoverBridge {
  admitFrontier: typeof admitFrontier;
  submitAttempt: typeof submitAttempt;
  pollObservations: typeof pollObservations;
  recordObservation: typeof recordObservation;
  finalizeAttempt: typeof finalizeAttempt;
  transitionOnce: (
    active: ResilienceActiveTuple,
    successorProviderId: string,
    failure: ResilienceNormalizedFailure,
    jitterMs: number,
    deadlineMs: number,
    planHashValue: string,
    idempotencyKey: string,
    client?: ResilienceClient,
    failureSource?: FailureSource,
    observationIdempotencyKey?: string,
  ) => ReturnType<typeof transitionOnce>;
  requestCancel: typeof requestCancel;
  recoverAndTransitionOnce: typeof recoverAndTransitionOnce;
  getStatus: typeof getStatus;
  pageOutbox: typeof pageOutbox;
  signalProviderCancel: typeof signalProviderCancel;
  signalAttemptTimeout: typeof signalAttemptTimeout;
  executeHermesAttempt: typeof executeHermesAttempt;
}

const defaultBridge: FailoverBridge = {
  admitFrontier, submitAttempt, pollObservations, recordObservation, finalizeAttempt,
  requestCancel, recoverAndTransitionOnce, getStatus, pageOutbox, signalProviderCancel, signalAttemptTimeout,
  executeHermesAttempt,
  transitionOnce: transitionOnce as unknown as FailoverBridge['transitionOnce'],
};

interface ActiveRun {
  requestId: string;
  active: ResilienceActiveTuple;
  controller: AbortController;
  cancelPromise?: Promise<'cancelled' | 'cancelled_uncertain' | 'noop'>;
  plan: ReturnType<typeof buildFailoverPlan>;
  chain: ResolvedProviderChain;
  bridge: FailoverBridge;
  client?: ResilienceClient;
  providerSubmitNotBeforeMs?: number;
}

const activeRuns = new Map<string, ActiveRun>();

function providerAt(chain: ResolvedProviderChain, active: ResilienceActiveTuple): ProviderReference {
  const provider = chain.providers[active.epoch];
  if (!provider) throw new FailoverTerminalError({ failureClass: 'terminal', code: 'tuple_order_invalid', retryable: false }, false, 'terminal');
  return providerReference(provider);
}

function safeObservationFailure(observation: NormalizedObservation): ResilienceNormalizedFailure {
  if (observation.failure) return observation.failure;
  return classifyProviderFailure({ dispatchAttempted: observation.dispatchAttempted, timedOut: observation.kind === 'timeout', cancelled: observation.kind === 'cancelled' });
}

type FailureSource = NonNullable<NormalizedObservation['failureSource']>;

function observationFailureSource(observation: NormalizedObservation): FailureSource {
  return observation.failureSource ?? 'gateway';
}

function terminalOutcomeFor(failure: ResilienceNormalizedFailure): 'failed' | 'cancelled' | 'cancelled_uncertain' {
  if (failure.failureClass === 'side_effect_uncertainty' || failure.code === 'timeout_uncertain') return 'cancelled_uncertain';
  if (failure.failureClass === 'cancelled') return 'cancelled';
  return 'failed';
}

async function finalizeExact(
  bridge: FailoverBridge,
  active: ResilienceActiveTuple,
  failure: ResilienceNormalizedFailure,
  failureSource: FailureSource,
  terminalOutcome: 'failed' | 'cancelled' | 'cancelled_uncertain' | 'terminal',
  idempotencyKey: string,
  client?: ResilienceClient,
): Promise<void> {
  const finalized = await bridge.finalizeAttempt(
    active, failure, failureSource, terminalOutcome, idempotencyKey, client,
  );
  if (finalized.status !== 'FINALIZED' && finalized.status !== 'DUPLICATE') {
    throw new Error(`FAILOVER_AUTHORITY_FINALIZE_REJECTED:${finalized.reason ?? 'unknown'}`);
  }
}

export interface RunFailoverOptions extends PlanOptions {
  document?: ProviderChainsDocument;
  bridge?: Partial<FailoverBridge>;
  emit?: Emitter;
  client?: ResilienceClient;
  random?: () => number;
  signal?: AbortSignal;
  sleepMs?: (ms: number) => Promise<void>;
}

export async function runFailoverTask(
  req: GatewayRequest,
  diag: RouterDiagnostics,
  options: RunFailoverOptions = {},
): Promise<{ text: string; telemetry: Record<string, unknown> }> {
  assertFrontier(diag.tier);
  if (!isFailoverEnabled()) throw new Error('FAILOVER_DISABLED');
  const projection = await import('./storage.js');
  projection.ensureResilienceProjection();
  const chain = resolveProviderChain(req, options.document);
  const plan = buildFailoverPlan(req, chain, options);
  const clockMs = () => options.nowMs ?? Date.now();
  const bridge = { ...defaultBridge, ...(options.bridge ?? {}) };
  await projection.ensureInitialResilienceProjection(async (afterCursor, limit) => bridge.pageOutbox(afterCursor, limit, options.client));
  const emit = withVerifiedTerminalReceipt(
    req.id,
    options.emit ?? makeEmitter(req.sessionId, req.id, ComputeTier.FRONTIER),
  );
  const admitted: AdmitResponse = await bridge.admitFrontier(req.id, plan, plan.eligibleProviderIds, plan.taskDeadlineMs, `${req.id}:admit`, options.client);
  if (!admitted.activeTuple || (admitted.status !== 'ADMITTED' && admitted.status !== 'EXISTING')) {
    throw new FailoverTerminalError({ failureClass: 'terminal', code: 'admission_rejected', retryable: false }, false, 'terminal');
  }
  projection.recordFailoverAdmission({
    taskId: req.id,
    planHash: planHash(plan),
    chainId: chain.id,
    featureRevision: plan.featurePolicyRevision,
    activeAttemptId: admitted.activeTuple.attemptId,
    activeEpoch: admitted.activeTuple.epoch,
    deadlineMs: plan.taskDeadlineMs,
    immutablePlan: plan,
    providerMetadata: Object.fromEntries(chain.providers.map((provider) => [provider.id, { modelId: provider.modelId, reservedMicroUsd: plan.providerCeilings[provider.id] ?? provider.ceilingMicroUsd }])),
  });
  const controller = new AbortController();
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  projection.recordFailoverAttempt({ taskId: req.id, active: admitted.activeTuple, provider: providerAt(chain, admitted.activeTuple), reservedMicroUsd: plan.providerCeilings[providerAt(chain, admitted.activeTuple).id] ?? null });
  const run: ActiveRun = { requestId: req.id, active: admitted.activeTuple, controller, plan, chain, bridge, client: options.client, providerSubmitNotBeforeMs: 0 };
  activeRuns.set(req.id, run);
  let transitionCount = 0;
  try {
    for (;;) {
      if (clockMs() >= plan.taskDeadlineMs) {
        const failure = { failureClass: 'retryable', code: 'pre_dispatch_timeout', retryable: true } as const;
        await finalizeExact(bridge, run.active, failure, 'gateway', 'failed', `${req.id}:${run.active.attemptId}:deadline-finalize`, options.client);
        throw new FailoverTerminalError(failure, false, 'failed', { failover: true, deadlineExpired: true });
      }
      let attempt;
      try {
        attempt = await bridge.executeHermesAttempt(req, plan, run.active, providerAt(chain, run.active), emit, {
          client: options.client,
          signal: controller.signal,
          nowMs: clockMs,
          sleepMs: options.sleepMs,
          providerSubmitNotBeforeMs: run.providerSubmitNotBeforeMs,
        });
      } catch (error) {
        attempt = {
          text: '', telemetry: {}, dispatchAttempted: false,
          observation: { kind: 'failure' as const, dispatchAttempted: false, failure: normalizeProviderFailure(error), failureSource: 'gateway' as const },
        };
      }
      const observation: NormalizedObservation = attempt.observation ?? { kind: 'result', dispatchAttempted: attempt.dispatchAttempted, text: attempt.text, telemetry: attempt.telemetry };
      const failure = safeObservationFailure(observation);
      const failureSource = observationFailureSource(observation);

      if (observation.kind === 'cancelled' && controller.signal.aborted) {
        const cancellation = run.cancelPromise ? await run.cancelPromise : 'cancelled_uncertain';
        const cancellationFailure = cancellation === 'cancelled'
          ? { failureClass: 'cancelled', code: 'operator_cancel', retryable: false } as const
          : { failureClass: 'cancelled', code: 'timeout_uncertain', retryable: false } as const;
        if (!run.cancelPromise && cancellation !== 'noop') {
          await finalizeExact(bridge, run.active, cancellationFailure, 'gateway', 'cancelled_uncertain', `${req.id}:${run.active.attemptId}:abort-finalize`, options.client);
        }
        throw new FailoverTerminalError(cancellationFailure, attempt.dispatchAttempted, cancellation === 'cancelled' ? 'cancelled' : 'cancelled_uncertain', { failover: true });
      }
      if (failure.code === 'pre_dispatch_timeout') {
        const stop: AttemptStopResponse = await withinMs(bridge.signalAttemptTimeout(run.active, options.client), 2_000).catch((): AttemptStopResponse => ({ status: 'ACK_UNCERTAIN' }));
        if (stop.status !== 'ACK_PRE_DISPATCH' || stop.dispatchAttempted !== false || !stop.activeTuple || stop.activeTuple.taskId !== run.active.taskId || stop.activeTuple.attemptId !== run.active.attemptId || stop.activeTuple.epoch !== run.active.epoch || attempt.dispatchAttempted) {
          const uncertain = { failureClass: 'cancelled', code: 'timeout_uncertain', retryable: false } as const;
          await finalizeExact(bridge, run.active, uncertain, 'gateway', 'cancelled_uncertain', `${req.id}:${run.active.attemptId}:timeout-uncertain`, options.client);
          throw new FailoverTerminalError(uncertain, attempt.dispatchAttempted, 'cancelled_uncertain', { failover: true });
        }
      }
      if (observation.kind === 'result') {
        // A terminal poll marker is the proof that the engine already
        // committed the durable completion.  Without the exact marker keep
        // the legacy record RPC and fail closed on its response.
        if (attempt.terminalCommitted !== true || attempt.terminalOutcome !== 'completed') {
          await bridge.recordObservation(run.active, observation, `${req.id}:${run.active.attemptId}:observation`, options.client);
        }
        return { text: observation.text ?? attempt.text, telemetry: { ...(observation.telemetry ?? attempt.telemetry), failoverEnabled: true, planHash: planHash(plan), providerAttempts: undefined } };
      }
      if (!failure.retryable) {
        const terminalOutcome = terminalOutcomeFor(failure);
        if (attempt.terminalCommitted !== true || attempt.terminalOutcome !== terminalOutcome) {
          await finalizeExact(bridge, run.active, failure, failureSource, terminalOutcome, `${req.id}:${run.active.attemptId}:terminal-finalize`, options.client);
        }
        throw new FailoverTerminalError(failure, attempt.dispatchAttempted, terminalOutcome, { failover: true });
      }
      const successorExists = transitionCount === 0 && run.active.epoch + 1 < chain.providers.length;
      const successorProviderId = successorExists ? chain.providers[run.active.epoch + 1]!.id : '';
      const decision = decideTransition({
        activeExact: true,
        dispatchAttempted: attempt.dispatchAttempted,
        cancellationRequested: controller.signal.aborted,
         nowMs: clockMs(),
        deadlineMs: plan.taskDeadlineMs,
        successorExists,
        successorDiffers: successorExists && chain.providers[run.active.epoch + 1]!.id !== chain.providers[run.active.epoch]!.id,
        successorLater: successorExists,
        transitionCount,
        // Privacy, budget, and circuit state are authoritative in the
        // ledger.  Do not make an unverified gateway assertion here.
        failure,
      });
      if (!decision.allowed && !decision.authorityDeferred) {
        await finalizeExact(bridge, run.active, failure, failureSource, 'failed', `${req.id}:${run.active.attemptId}:transition-denied-finalize`, options.client);
        throw new FailoverTerminalError(failure, attempt.dispatchAttempted, 'failed', { failover: true, transitionDecision: decision.reason });
      }
      const delay = jitterDelayMs(options.random);
      if (clockMs() + delay >= plan.taskDeadlineMs) {
        await finalizeExact(bridge, run.active, failure, failureSource, 'failed', `${req.id}:${run.active.attemptId}:jitter-deadline-finalize`, options.client);
        throw new FailoverTerminalError(failure, attempt.dispatchAttempted, 'failed', { failover: true, transitionDelayMs: delay });
      }
      const observationIdempotencyKey = `${req.id}:${run.active.attemptId}:observation`;
      const transitionIdempotencyKey = `${req.id}:${run.active.attemptId}:transition`;
      let transitioned;
      if (failure.code === 'pre_dispatch_timeout') {
        // Pre-dispatch timeout has a distinct ACK/recovery path and retains
        // the legacy transition call; it has no provider observation fact.
        transitioned = await bridge.transitionOnce(
          run.active, successorProviderId, failure, delay, plan.taskDeadlineMs,
          planHash(plan), transitionIdempotencyKey, options.client,
        );
      } else {
        try {
          transitioned = await bridge.transitionOnce(
            run.active, successorProviderId, failure, delay, plan.taskDeadlineMs,
            planHash(plan), transitionIdempotencyKey, options.client,
            failureSource, observationIdempotencyKey,
          );
        } catch (firstError) {
          // The fused authority call may have committed before its response
          // was lost. Retry the exact same two keys; never fall back to
          // separate observation/transition RPCs or submit another attempt.
          try {
            transitioned = await bridge.transitionOnce(
              run.active, successorProviderId, failure, delay, plan.taskDeadlineMs,
              planHash(plan), transitionIdempotencyKey, options.client,
              failureSource, observationIdempotencyKey,
            );
          } catch {
            throw firstError;
          }
        }
      }
      if (transitioned.status === 'OBSERVATION_RECORDED') {
        await finalizeExact(bridge, run.active, failure, failureSource, 'failed', `${req.id}:${run.active.attemptId}:observation-only-finalize`, options.client);
        throw new FailoverTerminalError(failure, attempt.dispatchAttempted, 'failed', { failover: true, transitionDecision: 'observation_recorded' });
      }
      if (transitioned.status !== 'TRANSITIONED' || !transitioned.successor) {
        await finalizeExact(bridge, run.active, failure, failureSource, 'failed', `${req.id}:${run.active.attemptId}:ledger-rejected-finalize`, options.client);
        throw new FailoverTerminalError(failure, attempt.dispatchAttempted, 'failed', { failover: true, transitionDecision: transitioned.reason ?? 'ledger_rejected' });
      }
      if (transitioned.successorProviderId !== successorProviderId) {
        throw new FailoverTerminalError({ failureClass: 'terminal', code: 'successor_provider_invalid', retryable: false }, false, 'terminal');
      }
      if (!validateSuccessorTuple(run.active, transitioned.successor, plan.eligibleProviderIds)) {
        throw new FailoverTerminalError({ failureClass: 'terminal', code: 'successor_tuple_invalid', retryable: false }, false, 'terminal');
      }
      run.active = transitioned.successor;
      run.providerSubmitNotBeforeMs = transitioned.successorSubmitNotBeforeMs;
      transitionCount += 1;
      projection.recordFailoverAttempt({ taskId: req.id, active: run.active, provider: providerAt(chain, run.active), reservedMicroUsd: plan.providerCeilings[providerAt(chain, run.active).id] ?? null });
      const remainingFenceMs = Math.max(0, (run.providerSubmitNotBeforeMs ?? clockMs()) - clockMs());
      const delayResult = await waitAbortable(remainingFenceMs, controller.signal, options.sleepMs);
      if (delayResult !== 'elapsed') {
        const cancellation = run.cancelPromise ? await run.cancelPromise : 'cancelled_uncertain';
        const cancellationFailure = cancellation === 'cancelled'
          ? { failureClass: 'cancelled', code: 'operator_cancel', retryable: false } as const
          : { failureClass: 'cancelled', code: 'timeout_uncertain', retryable: false } as const;
        if (!run.cancelPromise) await finalizeExact(bridge, run.active, cancellationFailure, 'gateway', 'cancelled_uncertain', `${req.id}:${run.active.attemptId}:jitter-abort-finalize`, options.client);
        throw new FailoverTerminalError(cancellationFailure, false, cancellation === 'cancelled' ? 'cancelled' : 'cancelled_uncertain', { failover: true, transitionDelayMs: delay });
      }
    }
  } finally {
    // Receipt materialization must never read a stale gateway projection. A
    // reconciliation failure propagates and dispatch fails closed.
    try {
      await projection.reconcileGatewayProjection(async (afterCursor, limit) => bridge.pageOutbox(afterCursor, limit, options.client));
    } catch (error) {
      projection.resetInitialResilienceProjection();
      throw error;
    }
    activeRuns.delete(req.id);
  }
}

/** Cancellation is a gateway command path. The durable ledger cancellation is
 * always attempted before the provider transport signal. */
async function cancelAndFinalize(
  bridge: FailoverBridge,
  active: ResilienceActiveTuple,
  requestId: string,
  reasonText: string,
  client?: ResilienceClient,
): Promise<'cancelled' | 'cancelled_uncertain' | 'noop'> {
  const result = await persistFirstCancel(
    () => withinMs(bridge.requestCancel(active, `${requestId}:cancel`, client), 2_000),
    () => withinMs(bridge.signalProviderCancel(active, reasonText, client), 2_000),
  );
  if (result === 'noop') return result;
  const failure = result === 'cancelled'
    ? { failureClass: 'cancelled', code: 'operator_cancel', retryable: false } as const
    : { failureClass: 'cancelled', code: 'timeout_uncertain', retryable: false } as const;
  await finalizeExact(
    bridge, active, failure, 'gateway', result,
    `${requestId}:${active.attemptId}:operator-cancel-finalize`, client,
  );
  const projection = await import('./storage.js');
  await projection.reconcileGatewayProjection(async (afterCursor, limit) => bridge.pageOutbox(afterCursor, limit, client));
  return result;
}

export async function cancelFailoverTask(requestId: string, reasonText: string = 'USER_CANCELLED'): Promise<'cancelled' | 'cancelled_uncertain' | 'noop'> {
  const run = activeRuns.get(requestId);
  if (!run) {
    try {
      const status = await withinMs(defaultBridge.getStatus(requestId), 2_000);
      if (!status.activeTuple) return 'noop';
      return cancelAndFinalize(defaultBridge, status.activeTuple, requestId, reasonText);
    } catch {
      return 'noop';
    }
  }
  if (run.cancelPromise) return run.cancelPromise;
  run.cancelPromise = (async () => {
    run.controller.abort();
    return cancelAndFinalize(run.bridge, run.active, requestId, reasonText, run.client);
  })();
  return run.cancelPromise;
}

export async function recoverFailoverTask(taskId: string, active: ResilienceActiveTuple, options: { bridge?: Partial<FailoverBridge>; client?: ResilienceClient } = {}): Promise<unknown> {
  const bridge = { ...defaultBridge, ...(options.bridge ?? {}) };
  return bridge.recoverAndTransitionOnce(active, `${taskId}:${active.attemptId}:${active.epoch}:startup-recovery:v1`, 250, { failureClass: 'retryable', code: 'pre_dispatch_timeout', retryable: true }, options.client);
}

export interface RecoverySummary {
  candidates: number;
  cancelledResumed: number;
  transitioned: number;
  terminalized: number;
  rejected: number;
}

function equalOrdered(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return !!left && left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Startup controller. Gateway projections only nominate candidates; the
 * ledger status and its frozen plan remain the authority for every action. */
export async function recoverFailoverTasks(options: {
  bridge?: Partial<FailoverBridge>;
  client?: ResilienceClient;
  document?: ProviderChainsDocument;
  nowMs?: () => number;
} = {}): Promise<RecoverySummary> {
  const projection = await import('./storage.js');
  const bridge = { ...defaultBridge, ...(options.bridge ?? {}) };
  // Recovery never trusts the process-local admission cache.  A restart or
  // stale projection must be reconciled before candidates are even read.
  await projection.reconcileGatewayProjection(async (afterCursor, limit) => bridge.pageOutbox(afterCursor, limit, options.client));
  const candidates = projection.listFailoverRecoveryCandidates();
  const summary: RecoverySummary = { candidates: candidates.length, cancelledResumed: 0, transitioned: 0, terminalized: 0, rejected: 0 };

  const resumeAttempt = async (
    candidate: typeof candidates[number], active: ResilienceActiveTuple,
    storedPlan: ResilienceImmutablePlan, chain: ResolvedProviderChain,
    providerSubmitNotBeforeMs: number = 0,
  ): Promise<void> => {
    const provider = chain.providers[active.epoch];
    if (!provider) throw new Error('FAILOVER_RECOVERY_PROVIDER_MISSING');
    projection.recordFailoverAttempt({ taskId: candidate.taskId, active, provider: providerReference(provider), reservedMicroUsd: storedPlan.providerCeilings[provider.id] ?? null });
    const controller = new AbortController();
    const run: ActiveRun = { requestId: candidate.taskId, active, controller, plan: storedPlan, chain, bridge, client: options.client, providerSubmitNotBeforeMs };
    activeRuns.set(candidate.taskId, run);
    const emit = withVerifiedTerminalReceipt(
      candidate.taskId,
      makeEmitter(candidate.request.sessionId, candidate.taskId, ComputeTier.FRONTIER),
    );
    try {
      const attempt = await bridge.executeHermesAttempt(candidate.request, storedPlan, active, providerReference(provider), emit, { client: options.client, signal: controller.signal, providerSubmitNotBeforeMs: run.providerSubmitNotBeforeMs });
      let observation: NormalizedObservation = attempt.observation ?? { kind: 'result' as const, dispatchAttempted: attempt.dispatchAttempted, text: attempt.text, telemetry: attempt.telemetry };
      let failure = safeObservationFailure(observation);
      if (failure.code === 'pre_dispatch_timeout') {
        const stop = await withinMs(bridge.signalAttemptTimeout(active, options.client), 2_000).catch((): AttemptStopResponse => ({ status: 'ACK_UNCERTAIN' }));
        const acknowledged = stop.status === 'ACK_PRE_DISPATCH' && stop.dispatchAttempted === false && !!stop.activeTuple
          && stop.activeTuple.taskId === active.taskId && stop.activeTuple.attemptId === active.attemptId
          && stop.activeTuple.epoch === active.epoch && !attempt.dispatchAttempted;
        observation = acknowledged
          ? { kind: 'failure', dispatchAttempted: false, failure, failureSource: observationFailureSource(observation) }
          : { kind: 'cancelled', dispatchAttempted: attempt.dispatchAttempted, failure: { failureClass: 'cancelled', code: 'timeout_uncertain', retryable: false }, failureSource: 'recovery' };
      }
      failure = safeObservationFailure(observation);
      if (observation.kind === 'result') {
        if (attempt.terminalCommitted !== true || attempt.terminalOutcome !== 'completed') {
          const recorded = await bridge.recordObservation(active, observation, `${candidate.taskId}:${active.attemptId}:startup-resumed-terminal`, options.client);
          if (recorded.status !== 'RECORDED' && recorded.status !== 'DUPLICATE') throw new Error('FAILOVER_RECOVERY_TERMINAL_REJECTED');
        }
      } else {
        const outcome = terminalOutcomeFor(failure);
        if (attempt.terminalCommitted !== true || attempt.terminalOutcome !== outcome) {
          await finalizeExact(
            bridge, active, failure, observationFailureSource(observation), outcome,
            `${candidate.taskId}:${active.attemptId}:startup-resumed-terminal`, options.client,
          );
        }
      }
      const terminal = await bridge.getStatus(candidate.taskId, options.client);
      if (terminal.status !== 'TERMINAL' || terminal.activeTuple !== undefined) throw new Error('FAILOVER_RECOVERY_NOT_TERMINAL');
      await projection.reconcileGatewayProjection(async (afterCursor, limit) => bridge.pageOutbox(afterCursor, limit, options.client));
      const projected = projection.getFailoverProjection(candidate.taskId);
      if (projected?.active_attempt_id !== null || projected?.active_epoch !== null || typeof projected?.terminal_outcome !== 'string') {
        throw new Error('FAILOVER_RECOVERY_PROJECTION_STALE');
      }
      if (observation.kind === 'result') emit('RESULT', observation.text ?? attempt.text, {
        ...(observation.telemetry ?? attempt.telemetry ?? {}),
        failoverEnabled: true,
        recovered: true,
      });
      else emit('ERROR', `Execution failed: failover ${failure.code}.`, { failoverEnabled: true, recovered: true, normalizedFailure: failure, terminalOutcome: projected.terminal_outcome });
      summary.terminalized += 1;
    } finally {
      activeRuns.delete(candidate.taskId);
    }
  };

  for (const candidate of candidates) {
    const status = await bridge.getStatus(candidate.taskId, options.client).catch(() => undefined);
    if (!status || !['ACTIVE', 'CANCEL_PENDING'].includes(status.status) || !status.activeTuple) continue;
    if (status.cancellationRequested) {
      const active = status.activeTuple;
      let signalStatus: 'cancelled' | 'noop' | 'unknown' = 'unknown';
      try {
        signalStatus = await bridge.signalProviderCancel(active, 'USER_CANCELLED', options.client);
      } catch {
        // A restart commonly loses the in-memory provider task. The persisted
        // ledger cancellation must still close, but without a real transport
        // acknowledgement its outcome is necessarily uncertain.
      }
      const confirmed = signalStatus === 'cancelled';
      const outcome = confirmed ? 'cancelled' : 'cancelled_uncertain';
      const cancelFailure = confirmed
        ? { failureClass: 'cancelled', code: 'operator_cancel', retryable: false } as const
        : { failureClass: 'cancelled', code: 'timeout_uncertain', retryable: false } as const;
      await finalizeExact(
        bridge, active, cancelFailure, 'recovery', outcome,
        `${candidate.taskId}:${active.attemptId}:${active.epoch}:startup-cancel-close:v1`, options.client,
      );
      const terminal = await bridge.getStatus(candidate.taskId, options.client);
      if (terminal.status !== 'TERMINAL' || terminal.activeTuple !== undefined) {
        throw new Error('FAILOVER_CANCEL_RECOVERY_NOT_TERMINAL');
      }
      await projection.reconcileGatewayProjection(async (afterCursor, limit) => bridge.pageOutbox(afterCursor, limit, options.client));
      const projected = projection.getFailoverProjection(candidate.taskId);
      if (projected?.active_attempt_id !== null || projected?.active_epoch !== null || projected?.terminal_outcome !== outcome) {
        throw new Error('FAILOVER_CANCEL_RECOVERY_PROJECTION_STALE');
      }
      summary.cancelledResumed += 1;
      summary.terminalized += 1;
      continue;
    }

    const nowMs = options.nowMs?.() ?? Date.now();
    const active = status.activeTuple;
    if (status.dispatchAttempted || nowMs >= status.taskDeadlineMs) {
      const recoveryId = `${candidate.taskId}:${active.attemptId}:${active.epoch}:startup-uncertain:v1`;
      const terminalized = await bridge.recoverAndTransitionOnce(active, recoveryId, 250, { failureClass: 'retryable', code: 'pre_dispatch_timeout', retryable: true }, options.client).catch(() => undefined);
      if (terminalized?.status !== 'TERMINAL') {
        summary.rejected += 1;
        continue;
      }
      const terminal = await bridge.getStatus(candidate.taskId, options.client).catch(() => undefined);
      if (!terminal || terminal.status !== 'TERMINAL' || terminal.activeTuple !== undefined) throw new Error('FAILOVER_RECOVERY_UNCERTAIN_NOT_TERMINAL');
      await projection.reconcileGatewayProjection(async (afterCursor, limit) => bridge.pageOutbox(afterCursor, limit, options.client));
      const projected = projection.getFailoverProjection(candidate.taskId);
      if (projected?.active_attempt_id !== null || projected?.active_epoch !== null || projected?.terminal_outcome !== 'cancelled_uncertain') {
        throw new Error('FAILOVER_RECOVERY_UNCERTAIN_PROJECTION_STALE');
      }
      summary.terminalized += 1;
      continue;
    }

    const rawPlan = typeof candidate.projection.immutable_plan_json === 'string' ? candidate.projection.immutable_plan_json : '';
    let storedPlan: ResilienceImmutablePlan;
    try {
      const parsed = ResilienceImmutablePlanSchema.safeParse(JSON.parse(rawPlan));
      if (!parsed.success || !status.immutablePlan || planHash(parsed.data) !== candidate.projection.plan_hash || planHash(status.immutablePlan) !== candidate.projection.plan_hash) {
        summary.rejected += 1;
        continue;
      }
      storedPlan = status.immutablePlan;
    } catch {
      summary.rejected += 1;
      continue;
    }

    let chain: ResolvedProviderChain;
    try {
      chain = resolveProviderChain(candidate.request, options.document);
    } catch {
      summary.rejected += 1;
      continue;
    }
    const featureRevision = String(candidate.projection.feature_revision ?? '');
    if (chain.id !== candidate.projection.chain_id || chain.revision !== featureRevision || storedPlan.chainId !== chain.id || !equalOrdered(storedPlan.eligibleProviderIds, chain.providers.map((provider) => provider.id)) || (status.providerOrder !== undefined && !equalOrdered(status.providerOrder, storedPlan.eligibleProviderIds)) || storedPlan.taskDeadlineMs !== status.taskDeadlineMs) {
      summary.rejected += 1;
      continue;
    }

    if (status.executionSubmitted || active.epoch > 0) {
      await resumeAttempt(candidate, active, storedPlan, chain, status.providerSubmitNotBeforeMs ?? 0);
      continue;
    }

    const recoveryId = `${candidate.taskId}:${active.attemptId}:${active.epoch}:startup-recovery:v1`;
    const recovered = await bridge.recoverAndTransitionOnce(active, recoveryId, 250, { failureClass: 'retryable', code: 'pre_dispatch_timeout', retryable: true }, options.client).catch(() => undefined);
    if (!recovered || (recovered.status !== 'RECOVERED' && recovered.status !== 'TRANSITIONED') || !recovered.successor) {
      if (recovered?.status === 'TERMINAL') summary.terminalized += 1;
      else summary.rejected += 1;
      continue;
    }
    const successor = recovered.successor;
    if (!validateSuccessorTuple(active, successor, storedPlan.eligibleProviderIds)) {
      summary.rejected += 1;
      continue;
    }
    const successorProvider = chain.providers[successor.epoch];
    if (!successorProvider || (recovered.successorProviderId !== undefined && recovered.successorProviderId !== successorProvider.id)) {
      summary.rejected += 1;
      continue;
    }
    summary.transitioned += 1;
    await resumeAttempt(candidate, successor, storedPlan, chain, recovered.successorSubmitNotBeforeMs ?? 0);
  }
  return summary;
}

export function failoverTaskIsActive(requestId: string): boolean {
  return activeRuns.has(requestId);
}

export function isFailoverRequestEnabled(diag: RouterDiagnostics): boolean {
  return diag.tier === ComputeTier.FRONTIER && isFailoverEnabled();
}

export type { GatewayProjectionEvent };
