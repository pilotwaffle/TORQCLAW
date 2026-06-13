import { ComputeTier, type GatewayRequest, type RouterDiagnostics } from '@torqclaw/contracts';
import { executeLocalEdge } from '@torqclaw/inference';
import { executeHermesTask, CircuitBreakerError, isHermesAvailable } from '@torqclaw/bridge';
import { makeEmitter, taskStore } from './events.js';
import { sessions } from './sessions.js';
import { cancellations } from './cancellations.js';

const sanitize = (msg: string) => msg.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 2_000);

/** Translate opaque transport failures into something the operator can act on.
 *  A raw "fetch failed" almost always means the provider rejected the call —
 *  most often a billing/credit limit on a long run. */
function humanizeError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('payment') || s.includes('credit') || s.includes('insufficient') || s.includes('billing'))
    return 'Cloud provider rejected the request — check your account credit/billing. (original: ' + raw.slice(0, 120) + ')';
  if (s.includes('429') || s.includes('rate limit'))
    return 'Cloud provider rate-limited the request — wait a moment and retry.';
  if (s === 'fetch failed' || s.includes('fetch failed'))
    return 'Cloud request failed mid-run — usually a provider credit/billing limit or a dropped connection. Check your account, then retry.';
  return raw;
}

/** Budget precedence: per-request maxCost → env default → unlimited.
 *  Resolved here so the bridge sees one number and the warning fires once. */
function resolveBudget(req: GatewayRequest): number | undefined {
  if (typeof req.constraints.maxCost === 'number') return req.constraints.maxCost;
  const env = Number(process.env.TORQCLAW_DEFAULT_MAX_COST);
  return Number.isFinite(env) && env > 0 ? env : undefined;
}

/** Fire-and-forget: the WS handler returns immediately; execution reports to
 *  the session bus, so sockets can drop and reconnect mid-task freely.
 *
 *  Invariant 7: this is the SINGLE terminal emission point. Execution layers
 *  THROW typed errors; only the catch/complete here emits RESULT or ERROR. */
export function dispatch(req: GatewayRequest, diag: RouterDiagnostics): void {
  const emit = makeEmitter(req.sessionId, req.id, diag.tier);

  // Apply resolved budget so the bridge enforces it; warn once when a FRONTIER
  // task runs unlimited (real money, no breaker).
  const budget = resolveBudget(req);
  const effectiveReq: GatewayRequest =
    budget === undefined
      ? req
      : { ...req, constraints: { ...req.constraints, maxCost: budget } };
  if (budget === undefined && diag.tier === ComputeTier.FRONTIER) {
    emit('SYSTEM', 'No budget set — this cloud task runs without a spend cap.');
  }

  taskStore.create(effectiveReq, diag); // persist BEFORE executing

  // Graceful frontier degradation: don't throw a bare error if the engine
  // never connected — tell the user plainly and offer a local re-run.
  if (diag.tier === ComputeTier.FRONTIER && !isHermesAvailable()) {
    taskStore.fail(req.id, 'FRONTIER_UNAVAILABLE: hermes engine unreachable');
    emit(
      'ERROR',
      'Cloud engine is unreachable. Retry, or resend with "This machine only".',
      { recovery: ['RETRY', 'RETRY_LOCAL'], prompt: req.payload.prompt },
    );
    cancellations.clear(req.id);
    return;
  }

  void (async () => {
    try {
      const result =
        diag.tier === ComputeTier.LOCAL_EDGE
          ? await executeLocalEdge(effectiveReq, emit)
          : await executeHermesTask(effectiveReq, emit);

      taskStore.complete(req.id, result.text, result.telemetry);
      // Cancelled tasks (and budget-broken ones) must not poison memory.
      if (!result.telemetry?.cancelled) {
        sessions.storeEpisode(
          req.id, req.sessionId, req.payload.taskType, req.payload.prompt, result.text,
        );
      }
      emit('RESULT', result.text, result.telemetry);
    } catch (error: any) {
      const reason =
        error instanceof CircuitBreakerError
          ? `BUDGET: ${error.message}`
          : String(error?.message ?? error);
      taskStore.fail(req.id, reason);
      // Recovery chips: generic failures offer retry + copy-diagnostic.
      emit('ERROR', `Execution failed: ${sanitize(humanizeError(reason))}`, {
        recovery: ['RETRY', 'COPY_DIAGNOSTIC'],
        prompt: req.payload.prompt,
      });
    } finally {
      cancellations.clear(req.id);
    }
  })();
}
