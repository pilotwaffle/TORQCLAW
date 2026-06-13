import { ComputeTier, type GatewayRequest, type RouterDiagnostics } from '@torqclaw/contracts';
import { executeLocalEdge, ToolApprovalRequired } from '@torqclaw/inference';
import { executeHermesTask, CircuitBreakerError, isHermesAvailable } from '@torqclaw/bridge';
import { makeEmitter, taskStore } from './events.js';
import { sessions } from './sessions.js';
import { cancellations } from './cancellations.js';
import { registerApproval } from './approvals.js';
import { randomUUID } from 'node:crypto';

const sanitize = (msg: string) => msg.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 2_000);

/** Translate opaque transport failures into something the operator can act on.
 *  A raw "fetch failed" almost always means the provider rejected the call —
 *  most often a billing/credit limit on a long run. */
function humanizeError(raw: string, tier?: ComputeTier): string {
  const s = raw.toLowerCase();
  // Local timeout: on slow/throttled hardware the on-device model can't finish
  // in time. Tell the user plainly and point them at the cloud.
  if ((s.includes('timeout') || s.includes('aborted')) && tier === ComputeTier.LOCAL_EDGE)
    return 'The local model ran out of time — it is slow on this hardware. Try again on a cloud model.';
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

/** P2.5: build a task receipt from REAL telemetry only — every field is sourced
 *  from what was actually collected; absent fields are omitted, never invented
 *  (no "remaining risk", no fake costs). The console renders this as a footer. */
function buildReceipt(
  tier: ComputeTier, telemetry: Record<string, unknown>, req: GatewayRequest,
): Record<string, unknown> {
  const r: Record<string, unknown> = { tier };
  const cost = telemetry.costUsd;
  if (typeof cost === 'number') r.costUsd = cost;
  const elapsed = telemetry.inferenceLatencyMs;
  if (typeof elapsed === 'number') r.elapsedMs = elapsed;
  if (typeof telemetry.iterations === 'number') r.iterations = telemetry.iterations;
  if (telemetry.cancelled === true) r.cancelled = true;
  if (typeof telemetry.blockedOn === 'string') r.blockedOn = telemetry.blockedOn;
  // P4.5: what memory the model actually received — chars + the verbatim string
  // ("show context used"). Nothing builds trust in memory like showing it.
  const ctx = req.payload.assembledContext ?? '';
  r.contextChars = ctx.length;
  r.memoryUsed = req.enrichment.memoryUsed;
  if (ctx.length > 0) r.assembledContext = ctx;
  return r;
}

/** The grant-notice prepended to the re-run's assembledContext so the model
 *  knows the prior pause was only to obtain permission, not a real failure. */
function grantNotice(toolName: string): string {
  return `Note: you now have permission to use ${toolName}; a prior attempt was paused only to obtain it. Proceed.\n\n`;
}

/**
 * APPROVE re-run (P2): mint a NEW GatewayRequest from the blocked task's stored
 * request_json, identical in every way EXCEPT — new id, fresh receivedAt,
 * gateway-owned grantedTools=[tool], and the grant-notice prepended to
 * assembledContext. Constraints (private/executionMode/maxCost/latency) are
 * preserved VERBATIM, so a private task still routes local. Re-routes through
 * the router (a fresh decision on the same constraints) and dispatches as its
 * OWN task with its OWN terminal event.
 */
export function mintGrantedRequest(requestJson: string, toolName: string): GatewayRequest {
  const orig = JSON.parse(requestJson) as GatewayRequest;
  const existing = orig.payload.assembledContext ?? '';
  return {
    ...orig,
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
    payload: {
      ...orig.payload,
      grantedTools: Array.from(new Set([...(orig.payload.grantedTools ?? []), toolName])),
      assembledContext: grantNotice(toolName) + existing,
    },
    // constraints + sessionId + prompt copied verbatim by the spread above.
  };
}

/** REJECT (P2): the operator denied the tool. Per the review refinement and
 *  invariant 7, this is a degenerate task — its ONE terminal is an ERROR
 *  ("Task aborted by user: tool denied") with recovery chips. A separate task
 *  from the original blocked run (which already terminated with PENDING_APPROVAL). */
export function emitToolDenied(req: GatewayRequest, toolName: string, diag: RouterDiagnostics): void {
  const emit = makeEmitter(req.sessionId, req.id, diag.tier);
  taskStore.create(req, diag);
  taskStore.fail(req.id, `DENIED: tool ${toolName} denied by user`);
  emit('ERROR', `Task aborted by user: tool ${toolName} denied.`, {
    recovery: ['RETRY', 'COPY_DIAGNOSTIC'],
    prompt: req.payload.prompt,
  });
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
      {
        recovery: ['RETRY', 'RETRY_LOCAL'],
        prompt: req.payload.prompt,
        // Never reached the engine, so nothing ran.
        sideEffectNote: 'Nothing ran — the request never reached the cloud engine.',
      },
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
      // P2.5 receipt: a compact, honest summary from REAL telemetry only.
      // toolsUsed is reconstructed console-side from TOOL_CALL events.
      emit('SYSTEM', 'Done', { receipt: buildReceipt(diag.tier, result.telemetry, effectiveReq) });
    } catch (error: any) {
      // (A) Gated tool with no grant — NOT a failure. This is the terminal
      //     state of a blocked run. Dispatch (sole DB + terminal owner)
      //     registers the approval and emits the ONE terminal PENDING_APPROVAL.
      //     The task is DONE (completed-with-blockedOn), not failed; it writes
      //     no RESULT and skips storeEpisode, so getContextWindow (USER_PROMPT
      //     + RESULT only) can never surface the aborted attempt.
      if (error instanceof ToolApprovalRequired) {
        const approvalId = registerApproval(req.id, error.toolName, error.args);
        taskStore.complete(req.id, '', { blockedOn: error.toolName });
        emit('PENDING_APPROVAL', `Tool ${error.toolName} requires approval`, {
          approvalId,
          toolName: error.toolName,
          requestId: req.id,
          args: error.args,
        });
        return; // do NOT fall through to ERROR
      }

      const isBudget = error instanceof CircuitBreakerError;
      const reason = isBudget ? `BUDGET: ${error.message}` : String(error?.message ?? error);
      taskStore.fail(req.id, reason);
      // P3.5 recovery chips, chosen by failure site:
      //   budget  -> RETRY with a raised-budget prefill (suggestedBudget)
      //   generic -> RETRY + COPY_DIAGNOSTIC
      // Honesty: on LOCAL_EDGE with no approved write tool, no side effect can
      // have occurred — say so. Otherwise some steps may have completed.
      const noSideEffects = diag.tier === ComputeTier.LOCAL_EDGE;
      const metaOut: Record<string, unknown> = {
        prompt: req.payload.prompt,
        sideEffectNote: noSideEffects
          ? 'No changes were made — this task ran locally with no approved write tools.'
          : 'Some steps may have completed before the failure.',
      };
      const isLocalTimeout =
        diag.tier === ComputeTier.LOCAL_EDGE && /timeout|aborted/i.test(reason);
      if (isBudget) {
        metaOut.recovery = ['RETRY'];
        // Suggest doubling the breached budget so a retry has headroom.
        const cur = typeof req.constraints.maxCost === 'number' ? req.constraints.maxCost : undefined;
        if (cur !== undefined) metaOut.suggestedBudget = Math.round(cur * 2 * 100) / 100;
      } else if (isLocalTimeout) {
        // Slow local hardware: offer a one-click retry on the cloud tier.
        metaOut.recovery = ['RETRY_CLOUD', 'COPY_DIAGNOSTIC'];
      } else {
        metaOut.recovery = ['RETRY', 'COPY_DIAGNOSTIC'];
      }
      emit('ERROR', `Execution failed: ${sanitize(humanizeError(reason, diag.tier))}`, metaOut);
    } finally {
      cancellations.clear(req.id);
    }
  })();
}
