import { type GatewayRequest, type GatewayEventType, ToolApprovalRequired } from '@torqclaw/contracts';
import { getClient } from './registry.js';

type Emitter = (type: GatewayEventType, message: string, metadata?: unknown) => void;

const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 30_000; // SYSTEM spend heartbeat cadence (max)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown when reported spend crosses the task budget. Only dispatch's single
 *  catch path turns this into the terminal ERROR event (invariant 7) — the
 *  bridge never emits RESULT/ERROR itself.
 *
 *  G1R correction A: carries the last-known provider-reported costUsd (the
 *  same number evaluateSpend just tripped on) so a BREACHED task's spend
 *  reaches taskStore.fail's telemetry and the spend ledger instead of
 *  recording zero. Optional/backward-compatible — undefined when no cost was
 *  ever reported (never fabricate a number that wasn't there).
 *
 *  TCLAW-1A-attr (G1R OQ3-b): also carries lastCostSource, the costSource tag
 *  ('exact'|'account_delta'|'unavailable') paired with lastCostUsd at the
 *  moment of breach. Without this, a breached task's real cost would arrive
 *  at recordSpend with no costSource and get mapped to 'unavailable' (NULL,
 *  excluded from the cap SUM) — regressing correction A, which deliberately
 *  preserved the number. Mirrors lastCostUsd: optional, never fabricated. */
export class CircuitBreakerError extends Error {
  readonly lastCostUsd?: number;
  readonly lastCostSource?: string;
  constructor(message: string, lastCostUsd?: number, lastCostSource?: string) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.lastCostUsd = lastCostUsd;
    this.lastCostSource = lastCostSource;
  }
}

/** Rolling heartbeat state for one task's poll loop. */
export interface HeartbeatState {
  lastHeartbeatAt: number;
  lastHeartbeatCost: number;
}

/** Pure spend-evaluation decision, extracted from the poll loop so it is unit
 *  testable (TCLAW-0D). The loop calls this verbatim — production path == tested
 *  unit; there is no parallel copy.
 *
 *  Enforcement is from PROVIDER-reported spend only, never a pricing table:
 *   - costUsd not a number (null/undefined = unreportable): return no signal at
 *     all. The engine already warned once; we must NOT fabricate a $0 spend, so
 *     `state` is left untouched and neither a heartbeat nor a trip is produced.
 *   - a heartbeat is emitted at most once per HEARTBEAT_INTERVAL_MS and only
 *     when the reported cost actually changed since the last heartbeat.
 *   - the breaker trips (breachMessage set) when a budget is set and reported
 *     spend strictly exceeds it.
 *
 *  Mutates `state` in place when it emits a heartbeat (mirrors the loop's prior
 *  inline bookkeeping). Returns the strings the caller should act on. */
export function evaluateSpend(
  costUsd: unknown,
  budget: number | undefined,
  state: HeartbeatState,
  now: number,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): { heartbeat?: string; breachMessage?: string } {
  // Unreportable spend: no heartbeat, no trip, no fabricated zero.
  if (typeof costUsd !== 'number') return {};

  const out: { heartbeat?: string; breachMessage?: string } = {};

  if (costUsd !== state.lastHeartbeatCost && now - state.lastHeartbeatAt >= intervalMs) {
    out.heartbeat = `Spend so far: $${costUsd.toFixed(2)}`;
    state.lastHeartbeatAt = now;
    state.lastHeartbeatCost = costUsd;
  }

  if (budget !== undefined && costUsd > budget) {
    out.breachMessage = `Budget exceeded: $${costUsd.toFixed(2)} of $${budget.toFixed(2)} limit`;
  }

  return out;
}

/** request_id → engine task_id, so a CANCEL_TASK arriving on a different
 *  socket can reach the right engine task. Cleared when the poll loop ends. */
const engineTaskByRequest = new Map<string, string>();

function parseToolResult(result: any): any {
  const text = (result.content as any[])?.find((c) => c.type === 'text')?.text;
  return text ? JSON.parse(text) : {};
}

export interface HermesResult {
  text: string;
  telemetry: Record<string, unknown>;
}

/** submit_task / get_task_status — never an awaited hour-long MCP call.
 *  Incremental events relay into the same session stream the UI watches. */
export async function executeHermesTask(
  req: GatewayRequest,
  emit: Emitter,
): Promise<HermesResult> {
  const client = getClient('hermes');
  const startedAt = Date.now(); // for the P2.5 receipt's elapsedMs

  const submit = parseToolResult(
    await client.callTool({ name: 'submit_task', arguments: { payload: req } }),
  );
  const taskId: string = submit.task_id;
  engineTaskByRequest.set(req.id, taskId);
  emit('SYSTEM', `Hermes kernel accepted task ${taskId}`);

  // maxCost is the only user-set budget here; precedence resolution lives in
  // dispatch (constraint → env default → unlimited).
  const budget = req.constraints.maxCost;
  const heartbeat: HeartbeatState = { lastHeartbeatAt: 0, lastHeartbeatCost: -1 };

  let cursor = 0;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const status = parseToolResult(
      await client.callTool({
        name: 'get_task_status',
        arguments: { task_id: taskId, since: cursor },
      }),
    );

    for (const ev of status.events ?? []) {
      // Suppress the engine's raw PENDING_APPROVAL: it lacks the gateway-side
      // approvalId. Dispatch emits the real terminal PENDING_APPROVAL after we
      // throw ToolApprovalRequired below (the P2 single-emission-point path).
      if (ev.type === 'PENDING_APPROVAL' && (ev.metadata?.toolName || ev.metadata?.tool_name)) {
        cursor = ev.cursor ?? cursor;
        continue;
      }
      emit(ev.type ?? 'SYSTEM', ev.message ?? '', ev.metadata);
      cursor = ev.cursor ?? cursor;
    }

    // Circuit breaker: enforce from PROVIDER-reported spend, no pricing table.
    // costUsd null = unenforceable (engine already warned once); the pure
    // evaluateSpend returns no signal in that case (no fabricated $0).
    const { heartbeat: spendMsg, breachMessage } = evaluateSpend(
      status.telemetry?.costUsd, budget, heartbeat, Date.now(),
    );
    if (spendMsg) emit('SYSTEM', spendMsg);
    if (breachMessage) {
      await client.callTool({
        name: 'cancel_task',
        arguments: { task_id: taskId, reason: 'BUDGET_EXCEEDED' },
      });
      throw new CircuitBreakerError(
        breachMessage,
        typeof status.telemetry?.costUsd === 'number' ? status.telemetry.costUsd : undefined,
        typeof status.telemetry?.costSource === 'string' ? status.telemetry.costSource : undefined,
      );
    }

    // FRONTIER per-tool approval: the engine blocked a gated tool. Throw so
    // dispatch registers the approval + emits the ONE terminal PENDING_APPROVAL
    // (same path as LOCAL_EDGE; invariant 7). Honors the grant on the re-run.
    if (status.state === 'completed' && status.telemetry?.blockedOn) {
      engineTaskByRequest.delete(req.id);
      throw new ToolApprovalRequired(
        String(status.telemetry.blockedOn),
        status.telemetry.blockedArgs ?? {},
      );
    }

    if (status.state === 'completed') {
      engineTaskByRequest.delete(req.id);
      return {
        text: status.result ?? '',
        telemetry: { ...(status.telemetry ?? {}), inferenceLatencyMs: Date.now() - startedAt },
      };
    }
    if (status.state === 'failed') {
      engineTaskByRequest.delete(req.id);
      throw new Error(status.error ?? 'Hermes task failed');
    }
  }
}

export async function approveSkill(
  queueId: string,
  decision: 'APPROVE' | 'REJECT',
  editedMarkdown?: string,
) {
  const client = getClient('hermes');
  const args: Record<string, unknown> = { queue_id: queueId, decision };
  if (decision === 'APPROVE' && editedMarkdown !== undefined) {
    args.edited_markdown = editedMarkdown;
  }
  await client.callTool({ name: 'decide_skill', arguments: args });
}

/** P4: fetch a skill draft's full markdown for the console editor. */
export async function getSkillDraft(queueId: string): Promise<{ skillMarkdown?: string; proposedName?: string }> {
  const client = getClient('hermes');
  const out = parseToolResult(
    await client.callTool({ name: 'get_skill_draft', arguments: { queue_id: queueId } }),
  );
  return { skillMarkdown: out.skill_markdown, proposedName: out.proposed_name };
}

/** Cancel a running FRONTIER task by gateway request_id. Resolves the engine
 *  task_id the bridge recorded at submit time. Returns false if the request
 *  isn't a tracked FRONTIER task (already finished, or LOCAL_EDGE). */
export async function cancelHermesTask(requestId: string, reason: string): Promise<boolean> {
  const engineTaskId = engineTaskByRequest.get(requestId);
  if (!engineTaskId) return false;
  const client = getClient('hermes');
  await client.callTool({
    name: 'cancel_task',
    arguments: { task_id: engineTaskId, reason },
  });
  return true;
}
