import type { GatewayRequest } from '@torqclaw/contracts';
import { router } from '@torqclaw/router';
import { getToolsForTask, executeTool } from '@torqclaw/bridge';
import type { Emitter, ExecutionResult } from './types.js';
import { ToolApprovalRequired } from './approval.js';

/** Cancellation probe injected by the gateway (decoupled so inference never
 *  imports the gateway DB). Defaults to never-cancelled for standalone use. */
export type CancelCheck = (requestId: string) => boolean;
let isCancelled: CancelCheck = () => false;
export function setCancelCheck(fn: CancelCheck): void {
  isCancelled = fn;
}

const FINALIZE_TIMEOUT_MS = 10_000;

/** P3: cap a tool result to `max` chars keeping the HEAD (60%) and TAIL (40%),
 *  with a marker between that names the dropped span. Head-only truncation
 *  loses the useful end of a result (errors, totals, the last rows); keeping
 *  both ends preserves the parts a model most often needs. Pure + exported for
 *  unit-testing the boundary math. Returns the input unchanged when it fits. */
export function truncateHeadTail(body: string, max: number): string {
  if (body.length <= max) return body;
  const headLen = Math.floor(max * 0.6);
  const tailLen = max - headLen;
  const head = body.slice(0, headLen);
  const tail = body.slice(body.length - tailLen);
  const dropped = body.length - headLen - tailLen;
  return (
    head +
    `\n[TRUNCATED: kept first ${headLen} and last ${tailLen} of ${body.length} chars` +
    ` — ${dropped} omitted; request a narrower range]\n` +
    tail
  );
}

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
// 'torq-local' is built by `pnpm model:setup` (ops/Modelfile): llama3.1:8b
// with num_ctx 8192 baked in — the /v1 endpoint can't set num_ctx per-request.
const LOCAL_MODEL = process.env.TORQCLAW_LOCAL_MODEL || 'torq-local';

const MAX_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 6_000; // ~1.5k tokens; raw file reads must not nuke the window
const INFERENCE_TIMEOUT_MS = 120_000;

async function callOllama(messages: unknown[], tools?: unknown[], signal?: AbortSignal) {
  const res = await fetch(`${OLLAMA_HOST}/v1/chat/completions`, {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LOCAL_MODEL,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
      keep_alive: '10m',
    }),
  });
  if (!res.ok) throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Stop immediately on user cancel: one finalization pass, capped at 10s; on
 *  timeout return the honest cancelled message rather than keep thinking. */
async function finalizeCancelled(
  messages: any[], start: number, iterations: number, toolCallCount: number,
  emit: Emitter,
): Promise<ExecutionResult> {
  emit('SYSTEM', 'Stopping — wrapping up any answer so far');
  try {
    const final = await callOllama(
      [...messages, {
        role: 'user',
        content: 'Stop now. Give a brief answer from what you have, or say you were stopped.',
      }],
      undefined,
      AbortSignal.timeout(FINALIZE_TIMEOUT_MS),
    );
    return doneCancelled(
      final.choices?.[0]?.message?.content ?? '(cancelled)',
      start, iterations, toolCallCount,
    );
  } catch {
    return doneCancelled(
      '(cancelled — no further work will run; some earlier steps may have completed)',
      start, iterations, toolCallCount,
    );
  }
}

export async function executeLocalEdge(
  req: GatewayRequest,
  emit: Emitter,
): Promise<ExecutionResult> {
  const start = performance.now();

  // Task-filtered, namespaced, alias-mapped, approval-gated toolset.
  const { openAITools, resolveAlias, requiresApproval } =
    await getToolsForTask(req.payload.taskType, 'LOCAL_EDGE');

  // Small local models improvise without hard grounding: they fabricate tool
  // output, claim capabilities they lack, and role-play. Pin them to reality —
  // the exact tools available, and an explicit ban on inventing results.
  const toolList = openAITools.length
    ? openAITools.map((t) => `- ${t.function.name}: ${t.function.description}`).join('\n')
    : '(none available for this task)';
  const context = req.payload.assembledContext;
  const messages: any[] = [
    {
      role: 'system',
      content:
        'You are TORQCLAW running on a local model. Be concise and concrete.\n\n' +
        'RULES:\n' +
        '1. You can ONLY act through the tools listed below. You have no other ' +
        'abilities — no internet, no memory, no file access except via these tools.\n' +
        '2. To use a tool, emit a real function call. NEVER write tool output, ' +
        'JSON results, status objects, or queue messages yourself — that is ' +
        'fabrication. Wait for the actual tool result.\n' +
        '3. If no tool can do what the user asks, say so plainly. Do not pretend.\n' +
        '4. Answer only from real tool results or your own knowledge — never invent data.\n\n' +
        `AVAILABLE TOOLS:\n${toolList}` +
        (context ? `\n\n${context}` : ''),
    },
    { role: 'user', content: req.payload.prompt },
  ];

  // E2E determinism seam: force a gated-tool hit so the approval loop can be
  // tested without depending on the local model's tool-choice. Honors the grant
  // exactly like a real gated tool, so the APPROVE re-run proceeds. Off unless
  // the env var is set; never active in production.
  const forced = process.env.TORQCLAW_E2E_FORCE_GATED_TOOL;
  if (forced) {
    if (!req.payload.grantedTools.includes(forced)) {
      throw new ToolApprovalRequired(forced, { e2e: true, prompt: req.payload.prompt });
    }
    emit('TOOL_CALL', `Executing ${forced}`, { granted: true });
    return done(`[e2e] executed ${forced} under grant`, start, 1, 1);
  }

  let iterations = 0;
  let toolCallCount = 0;

  while (iterations < MAX_ITERATIONS) {
    // Cancellation check #1: between iterations.
    if (isCancelled(req.id)) {
      return finalizeCancelled(messages, start, iterations, toolCallCount, emit);
    }
    iterations++;
    const result = await callOllama(messages, openAITools);
    router.markLocalModelWarm(); // feed the cold-start rule real data
    const message = result.choices?.[0]?.message;
    if (!message) throw new Error('Ollama returned an empty completion');
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return done(message.content ?? '', start, iterations, toolCallCount);
    }

    for (const toolCall of message.tool_calls) {
      // Cancellation check #2: between tool calls within an iteration. Stop
      // before firing any further tool — no side effects after stop.
      if (isCancelled(req.id)) {
        return finalizeCancelled(messages, start, iterations, toolCallCount, emit);
      }
      toolCallCount++;
      const alias = toolCall.function.name;
      const realName = resolveAlias(alias);

      // FIX (a): defensive parse — small models emit garbage JSON eventually.
      // Feed the failure back as a tool result so the model self-corrects.
      let toolArgs: unknown;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        messages.push({
          role: 'tool', tool_call_id: toolCall.id, name: alias,
          content: 'ERROR: arguments were not valid JSON. Re-emit the call with corrected JSON.',
        });
        continue;
      }

      // Approval gate (P2 fail-fast): a write-capable tool on LOCAL_EDGE needs
      // a one-time grant. If the grant isn't present, STOP the whole run by
      // throwing — dispatch catches this, registers the approval, and emits the
      // single terminal PENDING_APPROVAL (invariant 7). No further tool fires
      // (no side effects after the gate); the blocked attempt produces no RESULT
      // and is never stored to memory.
      const granted = req.payload.grantedTools.includes(realName);
      if (requiresApproval(realName) && !granted) {
        throw new ToolApprovalRequired(realName, toolArgs);
      }

      emit('TOOL_CALL', `Executing ${realName}`, { args: toolArgs });
      try {
        const toolResult = await executeTool(realName, toolArgs);
        // P3: head+tail truncation — keep the start AND end. Errors and the
        // useful tail of a result cluster at log ends; a head-only cut drops them.
        const content = truncateHeadTail(JSON.stringify(toolResult), MAX_TOOL_RESULT_CHARS);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, name: alias, content });
      } catch (err: any) {
        messages.push({
          role: 'tool', tool_call_id: toolCall.id, name: alias,
          content: `ERROR executing tool: ${err.message}`,
        });
      }
    }
  }

  // FIX (c): don't discard five iterations of real work — force finalization.
  emit('SYSTEM', 'Max tool iterations reached; forcing finalization pass');
  messages.push({
    role: 'user',
    content: 'Stop using tools. Give your best final answer from the information gathered so far.',
  });
  const final = await callOllama(messages, undefined);
  router.markLocalModelWarm();
  return done(
    final.choices?.[0]?.message?.content ?? '(no answer)',
    start, iterations + 1, toolCallCount,
  );
}

function done(
  text: string, start: number, iterations: number, toolCallCount: number,
): ExecutionResult {
  return {
    text,
    telemetry: {
      engineUsed: LOCAL_MODEL,
      iterations,
      toolCallCount,
      inferenceLatencyMs: Math.round(performance.now() - start),
    },
  };
}

function doneCancelled(
  text: string, start: number, iterations: number, toolCallCount: number,
): ExecutionResult {
  const r = done(text, start, iterations, toolCallCount);
  r.telemetry.cancelled = true;
  return r;
}
