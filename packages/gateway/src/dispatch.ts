import { ComputeTier, type GatewayRequest, type RouterDiagnostics } from '@torqclaw/contracts';
import { executeLocalEdge, ToolApprovalRequired } from '@torqclaw/inference';
import { executeHermesTask, CircuitBreakerError, isHermesAvailable } from '@torqclaw/bridge';
import { makeEmitter, taskStore } from './events.js';
import { sessions } from './sessions.js';
import { cancellations } from './cancellations.js';
import { registerApproval } from './approvals.js';
import { safeMaterializeReceipt } from './receipts.js';
import {
  resolveBudgetWithSource,
  resolveSessionCap,
  resolveDailyCap,
  sessionTotal,
  dailyTotal,
  evaluateCaps,
  recordSpendSafe,
} from './spend.js';
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
  // 404 / model-not-found almost always means a wrong base_url or model id in
  // the provider config — not a transient failure. Point at the config.
  if (s.includes('404') || s.includes('not be found') || s.includes('not found') || s.includes('model_not_found'))
    return 'Cloud provider returned 404 — the model id or base URL is likely misconfigured for this task type. Check the HERMES_* (or HERMES_CODING_* for coding tasks) provider settings. (original: ' + raw.slice(0, 120) + ')';
  if (s === 'fetch failed' || s.includes('fetch failed'))
    return 'Cloud request failed mid-run — usually a provider credit/billing limit or a dropped connection. Check your account, then retry.';
  return raw;
}

/** Budget precedence: per-request maxCost → env default → unlimited.
 *  Resolved here so the bridge sees one number and the warning fires once.
 *  Exported for unit tests (TCLAW-0D) — behavior unchanged.
 *  TCLAW-1A-core: thin wrapper over resolveBudgetWithSource (spend.ts) so
 *  budget.test.ts's precedence pins stay green untouched. */
export function resolveBudget(req: GatewayRequest): number | undefined {
  return resolveBudgetWithSource(req).budget;
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
  safeMaterializeReceipt(req.id);
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
  // TCLAW-1A-core: also capture `source` (per_task/env_default/unlimited) so
  // it can be threaded onto the persisted telemetry for the receipt projector
  // (receipts.ts budget_source), replacing the previously-hardcoded null.
  const { budget, source: budgetSource } = resolveBudgetWithSource(req);
  const effectiveReq: GatewayRequest =
    budget === undefined
      ? req
      : { ...req, constraints: { ...req.constraints, maxCost: budget } };
  if (budget === undefined && diag.tier === ComputeTier.FRONTIER) {
    emit('SYSTEM', 'No budget set — this cloud task runs without a spend cap.');
  }

  taskStore.create(effectiveReq, diag); // persist BEFORE executing

  // TCLAW-1A-core CAP GATE — THE HARD INVARIANT: enforcement happens BEFORE
  // spend. FRONTIER-only (LOCAL_EDGE is never evaluated, never blocked —
  // caps are strictly orthogonal to routing). Runs immediately after
  // taskStore.create (so a refused task still gets a persisted, auditable
  // row + receipt) and BEFORE the FRONTIER-unavailable check / async IIFE
  // below, so a refused task never reaches executeHermesTask — zero partial
  // spend, no provider call made. Session/daily caps are ENV-only
  // (resolveSessionCap/resolveDailyCap read TORQCLAW_SESSION_CAP_USD /
  // TORQCLAW_DAILY_CAP_USD) — there is deliberately no client-settable cap
  // path here (G1R correction B).
  if (diag.tier === ComputeTier.FRONTIER) {
    const breach = evaluateCaps(
      sessionTotal(req.sessionId),
      dailyTotal(),
      resolveSessionCap(),
      resolveDailyCap(),
    );
    if (breach) {
      const resetNote = breach.cap === 'daily' ? ', resets at 00:00 UTC' : '';
      const reason =
        `CAP_EXCEEDED: ${breach.cap} cap $${breach.total.toFixed(2)} of $${breach.limit.toFixed(2)} ` +
        `(env ${breach.envVar}${resetNote})`;
      taskStore.fail(req.id, reason);
      emit(
        'ERROR',
        `Cloud spend cap reached: the ${breach.cap} cap is $${breach.total.toFixed(2)} of ` +
          `$${breach.limit.toFixed(2)} (env ${breach.envVar})${resetNote}. ` +
          `Totals may be conservative under concurrency. ` +
          `Resend with "This machine only" to run for free, right now, on this device.`,
        {
          kind: 'CAP_EXCEEDED',
          cap: breach.cap,
          total: breach.total,
          limit: breach.limit,
          envVar: breach.envVar,
          recovery: ['RETRY_LOCAL', 'COPY_DIAGNOSTIC'],
          prompt: req.payload.prompt,
          sideEffectNote: 'Nothing ran — the request never reached the cloud engine.',
        },
      );
      safeMaterializeReceipt(req.id);
      cancellations.clear(req.id);
      return; // no provider call was made => $0 partial spend, no ledger row
    }
  }

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
    safeMaterializeReceipt(req.id);
    cancellations.clear(req.id);
    return;
  }

  void (async () => {
    try {
      const result =
        diag.tier === ComputeTier.LOCAL_EDGE
          ? await executeLocalEdge(effectiveReq, emit)
          : await executeHermesTask(effectiveReq, emit);

      // TCLAW-1A-core: thread budgetSource onto the persisted telemetry so
      // the receipt projector (receipts.ts) can read a real budget_source
      // instead of the previously-hardcoded null. Real telemetry is spread
      // first so this never overwrites an actual collected field.
      const telemetryWithSource = { ...(result.telemetry ?? {}), budgetSource };
      taskStore.complete(req.id, result.text, telemetryWithSource);
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
      // TCLAW-4A: materialize the persisted run_receipts projection. MUST be
      // the guarded wrapper — its own try/catch — so a projector throw can
      // NEVER be caught by the outer catch below, which would flip this
      // already-completed task into a failure and emit a phantom ERROR.
      safeMaterializeReceipt(req.id);
      // TCLAW-1A-core: record spend at the SUCCESS terminal, FRONTIER-only —
      // LOCAL_EDGE never touches the ledger (free, never charged, never
      // clutters the cap total). Guarded (own try/catch): a ledger-write
      // throw must never break the already-completed terminal path.
      if (diag.tier === ComputeTier.FRONTIER) {
        // costSource only ever exists on the Hermes (FRONTIER) telemetry
        // shape (Record<string, unknown>) — ExecutionResult's LOCAL_EDGE
        // telemetry type has no such field (LOCAL_EDGE is never charged, so
        // it never has a cost provenance to report). This branch is itself
        // gated on tier === FRONTIER, so result.telemetry here is always the
        // Hermes shape at runtime; the cast only widens the *type* so the
        // read typechecks against the ExecutionResult|HermesResult union.
        const telemetry = result.telemetry as Record<string, unknown> | undefined;
        recordSpendSafe({
          taskId: req.id,
          sessionId: req.sessionId,
          sourceChannel: req.sourceChannel,
          costUsd: typeof telemetry?.costUsd === 'number' ? telemetry.costUsd : undefined,
          costSource: typeof telemetry?.costSource === 'string' ? telemetry.costSource : undefined,
        });
      }
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
        safeMaterializeReceipt(req.id);
        return; // do NOT fall through to ERROR
      }

      const isBudget = error instanceof CircuitBreakerError;
      const reason = isBudget ? `BUDGET: ${error.message}` : String(error?.message ?? error);
      // G1R correction A (part 1+2): a BREACHED task must not persist zero
      // telemetry. CircuitBreakerError carries the last-known provider-
      // reported costUsd (hermes.ts) — thread it through taskStore.fail's
      // new optional telemetry param so the breach cost is never silently
      // lost. Non-budget failures with no cost signal pass no telemetry
      // (unchanged behavior — nothing to record).
      const breachCostUsd = isBudget ? (error as CircuitBreakerError).lastCostUsd : undefined;
      // TCLAW-1A-attr: the breach cost's provenance tag, threaded alongside
      // breachCostUsd. Without this, a breach row would reach recordSpend
      // with a real number but no costSource and get mapped to 'unavailable'
      // (cost_usd NULL) — silently regressing correction A, which exists
      // specifically to preserve this number. A breach with a real cost must
      // record that cost WITH its label, never become unavailable/NULL.
      const breachCostSource = isBudget ? (error as CircuitBreakerError).lastCostSource : undefined;
      taskStore.fail(
        req.id, reason,
        isBudget ? { budgetSource, costUsd: breachCostUsd, costSource: breachCostSource } : undefined,
      );
      // TCLAW-1A-core: record the breach's spend in the ledger, FRONTIER-only.
      // A budget breach only ever occurs on a FRONTIER task (the breaker is
      // hermes-only), but the tier check mirrors the SUCCESS terminal's
      // discipline exactly. Non-breach failures with no cost signal are
      // intentionally NOT recorded here — a FRONTIER task that failed before
      // any spend was reported has no cost to log (never fabricate 0);
      // recording only fires when there is a genuine cost signal (the
      // breach's lastCostUsd).
      if (isBudget && diag.tier === ComputeTier.FRONTIER) {
        recordSpendSafe({
          taskId: req.id,
          sessionId: req.sessionId,
          sourceChannel: req.sourceChannel,
          costUsd: breachCostUsd,
          costSource: breachCostSource,
        });
      }
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
      safeMaterializeReceipt(req.id);
    } finally {
      cancellations.clear(req.id);
    }
  })();
}
