import { publishOnly } from './events.js';
import { enrichCommand } from './enrich.js';
import { router } from '@torqclaw/router';
import { GatewayRequestSchema, type ClientCommand } from '@torqclaw/contracts';

/**
 * TCLAW-2D-1: the PREVIEW_ROUTE handler — a strict READ-ONLY subset of the
 * live SUBMIT_PROMPT path (server.ts): it runs the REAL enrichment and the
 * REAL router evaluation, and SKIPS every write:
 *  - NO emit('USER_PROMPT'): that persisted event feeds Tier-1 memory recall
 *    (sessions.getContextWindow selects USER_PROMPT/RESULT) — emitting it here
 *    would poison the next task's memory with un-submitted drafts. The
 *    USER_PROMPT memory write stays dispatch-path-only.
 *  - NO emit('ROUTING'/'TIER_SELECTED'): a persisted TIER_SELECTED would feed
 *    the live route chip's activeRequestId and the receipt projector.
 *  - NO taskStore.create, NO dispatch, NO cap gate, NO spend, NO approvals.
 *  - NO router.markLocalModelWarm: the warm flag is the inference adapter's.
 * Response goes via publishOnly (seq-less, non-persisted, this-session-only).
 * enrichment scalars only — NEVER assembledContext: Tier-2 FTS recall is
 * GLOBAL across sessions (sessions.ts), so recalled text must not ride a
 * preview frame; contextSize + memoryUsed suffice.
 */

type PreviewCmd = Extract<ClientCommand, { action: 'PREVIEW_ROUTE' }>;

// Single-flight latch: at most ONE preview in flight per session. A preview
// is a real local-classifier inference (GPU + up to 1500ms); the latch bounds
// occupancy from a mash-happy button and underpins the operator-only authz
// posture. Purely in-memory — persists nothing.
const inFlight = new Set<string>();

export async function handlePreviewRoute(sessionId: string, cmd: PreviewCmd): Promise<void> {
  if (inFlight.has(sessionId)) {
    // Coalesce: report the drop honestly (echoing the nonce) rather than
    // silently vanishing or queueing a second concurrent inference.
    publishOnly(sessionId, {
      message: 'Route preview dropped — another preview is in flight',
      metadata: { routePreview: true, previewOf: cmd.previewOf, dropped: 'in_flight' },
    });
    return;
  }
  inFlight.add(sessionId);
  try {
    // Adapter: enrichCommand takes the SUBMIT_PROMPT-shaped command. Built
    // explicitly (never spread cmd verbatim) so previewOf never leaks into a
    // GatewayRequest and attachmentIds is always [].
    const request = await enrichCommand(
      {
        action: 'SUBMIT_PROMPT' as const,
        prompt: cmd.prompt,
        sensitive: cmd.sensitive,
        urgent: cmd.urgent,
        attachmentIds: [],
        ...(cmd.maxCostUsd !== undefined ? { maxCostUsd: cmd.maxCostUsd } : {}),
        executionMode: cmd.executionMode,
        useMemory: cmd.useMemory,
      },
      sessionId,
      'torq-console',
    );
    GatewayRequestSchema.parse(request); // fail loud on our own contract bug
    const diagnostics = router.evaluateRequest(request); // SAME singleton the live path uses

    publishOnly(sessionId, {
      message: 'Route preview',
      metadata: {
        routePreview: true,
        previewOf: cmd.previewOf,           // echoed VERBATIM (2D-2 staleness key)
        diagnostics,                         // verbatim RouterDiagnostics — 2B helpers reuse as-is
        taskType: request.payload.taskType,
        requiredTools: request.payload.requiredTools,
        contextSize: request.payload.contextSize,
        enrichment: request.enrichment,      // scalars only: classifierUsed/confidence/latency/estimatedTokens/memoryUsed
        prompt: cmd.prompt,                  // display echo only — NOT the staleness key
      },
    });
  } finally {
    inFlight.delete(sessionId);
  }
}
