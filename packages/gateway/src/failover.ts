import { randomUUID } from 'node:crypto';
import { ComputeTier, type GatewayRequest, type RouterDiagnostics, type ResilienceNormalizedFailure, type ResilienceActiveTuple } from '@torqclaw/contracts';
import {
  admitFrontier,
  executeHermesAttempt,
  getStatus,
  pageOutbox,
  pollObservations,
  recordObservation,
  recoverAndTransitionOnce,
  requestCancel,
  signalProviderCancel,
  submitAttempt,
  transitionOnce,
  type AdmitResponse,
  type CancelResponse,
  type NormalizedObservation,
  type ProviderReference,
  type ResilienceClient,
} from '@torqclaw/bridge';
import { makeEmitter, type Emitter } from './events.js';
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

/** Central failure parser. It accepts normalized fields only and always
 * returns a safe, stable code; raw provider text is deliberately ignored. */
export function classifyProviderFailure(observation: FailureObservation): ResilienceNormalizedFailure {
  if (observation.dispatchAttempted === true) return { failureClass: 'side_effect_uncertainty', code: 'dispatch_attempted', retryable: false };
  if (observation.cancelled === true) return { failureClass: 'cancelled', code: 'operator_cancel', retryable: false };
  if (observation.timedOut === true) return { failureClass: 'retryable', code: 'pre_dispatch_timeout', retryable: true };
  const code = observation.providerCode?.toLowerCase();
  if (code === 'connection' || code === 'dns') return { failureClass: 'retryable', code, retryable: true };
  if (typeof observation.httpStatus === 'number') {
    const status = observation.httpStatus;
    if (status === 408 || status === 429) return { failureClass: 'retryable', code: `http_${status}`, retryable: true };
    if (status >= 500 && status <= 599) return { failureClass: 'retryable', code: 'http_5xx', retryable: true };
    if (status === 400 || status === 404) return { failureClass: 'configuration', code: `http_${status}`, retryable: false };
    if (status === 401 || status === 403) return { failureClass: 'authentication', code: `http_${status}`, retryable: false };
  }
  if (code === 'reservation_refused' || code === 'budget_exceeded') return { failureClass: 'budget', code, retryable: false };
  if (code === 'invalid_model' || code === 'malformed_request') return { failureClass: 'configuration', code, retryable: false };
  if (code === 'missing_credentials' || code === 'invalid_credentials') return { failureClass: 'authentication', code, retryable: false };
  if (code === 'cancel_ack_missing') return { failureClass: 'timeout', code, retryable: false };
  if (code === 'post_dispatch_orphan' || code === 'tool_disconnect') return { failureClass: 'side_effect_uncertainty', code, retryable: false };
  if (code && RETRYABLE_CODES.has(code)) return { failureClass: 'retryable', code, retryable: true };
  return { failureClass: 'terminal', code: 'unknown_failure', retryable: false };
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
  privacyEligible: boolean;
  budgetAvailable: boolean;
  circuitOpen: boolean;
  failure: ResilienceNormalizedFailure;
}

export interface TransitionDecision {
  allowed: boolean;
  trace: string[];
  reason: string;
}

/** One ordered precedence function used by both the controller and tests. */
export function decideTransition(checks: TransitionChecks): TransitionDecision {
  const trace: string[] = [];
  const check = (name: string, value: boolean, reason: string): boolean => {
    trace.push(`${name}:${value ? 'pass' : 'fail'}`);
    if (!value) return false;
    return true;
  };
  if (!check('active_exact_tuple', checks.activeExact, 'stale_tuple')) return { allowed: false, trace, reason: 'stale_tuple' };
  if (!check('pre_dispatch', !checks.dispatchAttempted, 'dispatch_attempted')) return { allowed: false, trace, reason: 'dispatch_attempted' };
  if (!check('not_cancelled', !checks.cancellationRequested, 'cancel_requested')) return { allowed: false, trace, reason: 'cancel_requested' };
  if (!check('before_deadline', checks.nowMs < checks.deadlineMs, 'deadline_expired')) return { allowed: false, trace, reason: 'deadline_expired' };
  if (!check('successor_exists', checks.successorExists, 'no_successor')) return { allowed: false, trace, reason: 'no_successor' };
  if (!check('successor_differs', checks.successorDiffers, 'same_provider')) return { allowed: false, trace, reason: 'same_provider' };
  if (!check('successor_later', checks.successorLater, 'successor_order_invalid')) return { allowed: false, trace, reason: 'successor_order_invalid' };
  if (!check('transition_limit', checks.transitionCount === 0, 'transition_limit')) return { allowed: false, trace, reason: 'transition_limit' };
  if (!check('privacy_eligible', checks.privacyEligible, 'privacy_ineligible')) return { allowed: false, trace, reason: 'privacy_ineligible' };
  if (!check('budget_available', checks.budgetAvailable, 'budget_unavailable')) return { allowed: false, trace, reason: 'budget_unavailable' };
  if (!check('circuit_closed', !checks.circuitOpen, 'circuit_open')) return { allowed: false, trace, reason: 'circuit_open' };
  if (!check('retryable_failure', checks.failure.retryable, 'failure_not_retryable')) return { allowed: false, trace, reason: 'failure_not_retryable' };
  return { allowed: true, trace, reason: 'eligible' };
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
  signal: () => Promise<void>,
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
    await signal();
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
  transitionOnce: (
    active: ResilienceActiveTuple,
    successorProviderId: string,
    failure: ResilienceNormalizedFailure,
    jitterMs: number,
    deadlineMs: number,
    planHashValue: string,
    idempotencyKey: string,
    client?: ResilienceClient,
  ) => ReturnType<typeof transitionOnce>;
  requestCancel: typeof requestCancel;
  recoverAndTransitionOnce: typeof recoverAndTransitionOnce;
  getStatus: typeof getStatus;
  pageOutbox: typeof pageOutbox;
  signalProviderCancel: typeof signalProviderCancel;
  executeHermesAttempt: typeof executeHermesAttempt;
}

const defaultBridge: FailoverBridge = {
  admitFrontier, submitAttempt, pollObservations, recordObservation,
  requestCancel, recoverAndTransitionOnce, getStatus, pageOutbox, signalProviderCancel,
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

export interface RunFailoverOptions extends PlanOptions {
  document?: ProviderChainsDocument;
  bridge?: Partial<FailoverBridge>;
  emit?: Emitter;
  client?: ResilienceClient;
  random?: () => number;
  signal?: AbortSignal;
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
  const bridge = { ...defaultBridge, ...(options.bridge ?? {}) };
  await projection.reconcileGatewayProjection(async (afterCursor, limit) => bridge.pageOutbox(afterCursor, limit, options.client));
  const emit = options.emit ?? makeEmitter(req.sessionId, req.id, ComputeTier.FRONTIER);
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
  });
  const controller = new AbortController();
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  const run: ActiveRun = { requestId: req.id, active: admitted.activeTuple, controller, plan, chain, bridge };
  activeRuns.set(req.id, run);
  let transitionCount = 0;
  try {
    for (;;) {
      if (Date.now() >= plan.taskDeadlineMs) {
        throw new FailoverTerminalError({ failureClass: 'retryable', code: 'pre_dispatch_timeout', retryable: true }, false, 'failed', { failover: true, deadlineExpired: true });
      }
      const attempt = await bridge.executeHermesAttempt(req, plan, run.active, providerAt(chain, run.active), emit, { client: options.client });
      const observation = attempt.observation ?? { kind: 'result', dispatchAttempted: attempt.dispatchAttempted, text: attempt.text, telemetry: attempt.telemetry };
      await bridge.recordObservation(run.active, observation, `${req.id}:${run.active.attemptId}:observation`, options.client);
      if (observation.kind === 'result') {
        return { text: observation.text ?? attempt.text, telemetry: { ...(observation.telemetry ?? attempt.telemetry), failoverEnabled: true, planHash: planHash(plan), providerAttempts: undefined } };
      }
      const failure = safeObservationFailure(observation);
      if (failure.code === 'pre_dispatch_timeout') {
        const cancel = await withinMs(bridge.requestCancel(run.active, `${req.id}:${run.active.attemptId}:timeout`, options.client), 2_000).catch((): CancelResponse => ({ status: 'ACK_UNCERTAIN' }));
        if (cancel.status === 'ACK_UNCERTAIN' || cancel.status === 'REJECTED') {
          throw new FailoverTerminalError({ failureClass: 'timeout', code: 'cancel_ack_missing', retryable: false }, attempt.dispatchAttempted, 'cancelled_uncertain', { failover: true });
        }
        try {
          await bridge.signalProviderCancel(run.active, 'ATTEMPT_TIMEOUT', options.client);
        } catch {
          throw new FailoverTerminalError({ failureClass: 'timeout', code: 'cancel_ack_missing', retryable: false }, attempt.dispatchAttempted, 'cancelled_uncertain', { failover: true });
        }
      }
      const successorExists = transitionCount === 0 && run.active.epoch + 1 < chain.providers.length;
      const successorProviderId = successorExists ? chain.providers[run.active.epoch + 1]!.id : '';
      const decision = decideTransition({
        activeExact: true,
        dispatchAttempted: attempt.dispatchAttempted,
        cancellationRequested: controller.signal.aborted,
        nowMs: Date.now(),
        deadlineMs: plan.taskDeadlineMs,
        successorExists,
        successorDiffers: successorExists && chain.providers[run.active.epoch + 1]!.id !== chain.providers[run.active.epoch]!.id,
        successorLater: successorExists,
        transitionCount,
        privacyEligible: successorExists,
        budgetAvailable: successorExists,
        circuitOpen: false,
        failure,
      });
      if (!decision.allowed) throw new FailoverTerminalError(failure, attempt.dispatchAttempted, failure.failureClass === 'cancelled' ? 'cancelled' : failure.failureClass === 'side_effect_uncertainty' ? 'cancelled_uncertain' : 'failed', { failover: true, transitionDecision: decision.reason });
      const delay = jitterDelayMs(options.random);
      if (Date.now() + delay >= plan.taskDeadlineMs || (await waitAbortable(delay, controller.signal)) === 'aborted') {
        throw new FailoverTerminalError({ failureClass: 'timeout', code: 'cancel_ack_missing', retryable: false }, attempt.dispatchAttempted, controller.signal.aborted ? 'cancelled' : 'failed', { failover: true, transitionDelayMs: delay });
      }
      const transitioned = await bridge.transitionOnce(
        run.active, successorProviderId, failure, delay, plan.taskDeadlineMs,
        planHash(plan), `${req.id}:${run.active.attemptId}:transition`, options.client,
      );
      if (transitioned.status !== 'TRANSITIONED' || !transitioned.successor) throw new FailoverTerminalError(failure, attempt.dispatchAttempted, 'failed', { failover: true, transitionDecision: 'ledger_rejected' });
      if (transitioned.successorProviderId !== successorProviderId) {
        throw new FailoverTerminalError({ failureClass: 'terminal', code: 'successor_provider_invalid', retryable: false }, false, 'terminal');
      }
      if (!validateSuccessorTuple(run.active, transitioned.successor, plan.eligibleProviderIds)) {
        throw new FailoverTerminalError({ failureClass: 'terminal', code: 'successor_tuple_invalid', retryable: false }, false, 'terminal');
      }
      run.active = transitioned.successor;
      transitionCount += 1;
    }
  } finally {
    // Receipt materialization must never read a stale gateway projection. A
    // reconciliation failure propagates and dispatch fails closed.
    await projection.reconcileGatewayProjection(async (afterCursor, limit) => bridge.pageOutbox(afterCursor, limit, options.client));
    activeRuns.delete(req.id);
  }
}

/** Cancellation is a gateway command path. The durable ledger cancellation is
 * always attempted before the provider transport signal. */
export async function cancelFailoverTask(requestId: string, reasonText: string = 'USER_CANCELLED'): Promise<'cancelled' | 'cancelled_uncertain' | 'noop'> {
  const run = activeRuns.get(requestId);
  if (!run) {
    try {
      const status = await withinMs(defaultBridge.getStatus(requestId), 2_000);
      if (!status.activeTuple) return 'noop';
      return persistFirstCancel(
        () => withinMs(defaultBridge.requestCancel(status.activeTuple!, `${requestId}:cancel`, undefined), 2_000),
        () => defaultBridge.signalProviderCancel(status.activeTuple!, reasonText, undefined),
      );
    } catch {
      return 'noop';
    }
  }
  if (run.cancelPromise) return run.cancelPromise;
  run.cancelPromise = (async () => {
    run.controller.abort();
    return persistFirstCancel(
      () => withinMs(run.bridge.requestCancel(run.active, `${requestId}:cancel`, undefined), 2_000),
      () => run.bridge.signalProviderCancel(run.active, reasonText, undefined),
    );
  })();
  return run.cancelPromise;
}

export async function recoverFailoverTask(taskId: string, active: ResilienceActiveTuple, options: { bridge?: Partial<FailoverBridge>; deadlineMs: number } ): Promise<unknown> {
  const bridge = { ...defaultBridge, ...(options.bridge ?? {}) };
  return bridge.recoverAndTransitionOnce(active, `${taskId}:recovery`, 250, options.deadlineMs);
}

export function failoverTaskIsActive(requestId: string): boolean {
  return activeRuns.has(requestId);
}

export function isFailoverRequestEnabled(diag: RouterDiagnostics): boolean {
  return diag.tier === ComputeTier.FRONTIER && isFailoverEnabled();
}

export type { GatewayProjectionEvent };
