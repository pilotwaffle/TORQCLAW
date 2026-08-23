import type { GatewayRequest } from '@torqclaw/contracts';
import { createHash } from 'node:crypto';
import { router } from '@torqclaw/router';
import {
  getToolsForTask,
  executeTool,
  type CollabAgentTurnToolContext,
} from '@torqclaw/bridge';
import type { Emitter, ExecutionResult } from './types.js';
import { ToolApprovalRequired } from './approval.js';

/** Cancellation probe injected by the gateway (decoupled so inference never
 *  imports the gateway DB). Defaults to never-cancelled for standalone use. */
export type CancelCheck = (requestId: string) => boolean;
let isCancelled: CancelCheck = () => false;
export function setCancelCheck(fn: CancelCheck): void {
  isCancelled = fn;
}

/**
 * C2-8 / PRD §1.4 — the gateway's pre-tool-execution admission seam.
 *
 * Injected exactly like `setCancelCheck` above, and for the same reason:
 * inference must never import the gateway DB. The gateway installs the
 * real implementation at boot; standalone use keeps the permissive default
 * so this module stays independently runnable.
 *
 * The check lives HERE, immediately before the side effect, rather than at
 * task dispatch, because this is the first moment the model-generated
 * arguments actually exist -- task-level dispatch is too early to bind an
 * exact action. `{ ok: false }` means NO SIDE EFFECT MAY FOLLOW.
 */
export type ToolAdmissionCheck = (
  requestId: string,
  toolName: string,
  args: unknown,
) => { ok: true } | { ok: false; reason: string };
let admitTool: ToolAdmissionCheck = () => ({ ok: true });
export function setToolAdmissionCheck(fn: ToolAdmissionCheck): void {
  admitTool = fn;
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

function requiresNativeChat(modelId: string): boolean {
  return modelId === 'torq-ai-v5' || modelId.startsWith('torq-ai-v5:');
}

const MAX_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 6_000; // ~1.5k tokens; raw file reads must not nuke the window
const INFERENCE_TIMEOUT_MS = 120_000;
const TORQ_AI_V5_CONTEXT_TOKENS = 8_192;

async function ollamaApiError(response: Response): Promise<Error> {
  try {
    const outer = JSON.parse(await response.text()) as { error?: unknown };
    let detail: unknown = outer.error;
    if (typeof detail === 'string') {
      try {
        detail = JSON.parse(detail);
      } catch {
        detail = undefined;
      }
    }
    if (detail && typeof detail === 'object' && 'error' in detail) {
      detail = (detail as { error?: unknown }).error;
    }
    if (detail && typeof detail === 'object') {
      const parsed = detail as {
        type?: unknown;
        n_prompt_tokens?: unknown;
        n_ctx?: unknown;
      };
      if (
        parsed.type === 'exceed_context_size_error'
        && Number.isInteger(parsed.n_prompt_tokens)
        && Number.isInteger(parsed.n_ctx)
      ) {
        return new Error(
          `OLLAMA_CONTEXT_EXCEEDED required_tokens=${parsed.n_prompt_tokens} ` +
          `configured_tokens=${parsed.n_ctx}`,
        );
      }
    }
  } catch {
    // Provider bodies are untrusted and may contain prompt fragments. Never
    // persist or rethrow them; retain only the HTTP status below.
  }
  return new Error(`Ollama API error: ${response.status} ${response.statusText}`);
}

async function callOllama(
  messages: unknown[],
  tools?: unknown[],
  signal?: AbortSignal,
  toolChoice?: unknown,
  modelId = LOCAL_MODEL,
  deterministicManagedAgent = false,
) {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(INFERENCE_TIMEOUT_MS)])
    : AbortSignal.timeout(INFERENCE_TIMEOUT_MS);
  if (requiresNativeChat(modelId)) {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      signal: requestSignal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        stream: false,
        think: false,
        keep_alive: -1,
        options: {
          num_ctx: TORQ_AI_V5_CONTEXT_TOKENS,
          ...(deterministicManagedAgent ? { temperature: 0 } : {}),
        },
      }),
    });
    if (!res.ok) throw await ollamaApiError(res);
    const data = await res.json();
    return {
      choices: [{
        message: data.message ?? { role: 'assistant', content: '' },
        finish_reason: data.done_reason ?? null,
      }],
      usage: {
        prompt_tokens: data.prompt_eval_count,
        completion_tokens: data.eval_count,
        total_tokens:
          typeof data.prompt_eval_count === 'number' && typeof data.eval_count === 'number'
            ? data.prompt_eval_count + data.eval_count
            : undefined,
      },
    };
  }
  const res = await fetch(`${OLLAMA_HOST}/v1/chat/completions`, {
    method: 'POST',
    signal: requestSignal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? (toolChoice ?? 'auto') : undefined,
      keep_alive: '10m',
    }),
  });
  if (!res.ok) throw await ollamaApiError(res);
  return res.json();
}

/** Explicit local-device requests need a real tool call, even when the small
 * local model tries to answer with prose or invented code. Keep this narrow:
 * ordinary prompts remain model-selected, while an unmistakable browser or
 * terminal workflow gets a deterministic first-tool sequence. */
export function requestedLocalToolSequence(prompt: string, available: string[]): string[] {
  const p = prompt.toLowerCase();
  const hasBrowser = /\b(browser|playwright)\b/.test(p);
  const hasTerminal = /\b(terminal|powershell|command prompt|shell)\b/.test(p);
  const wantsNavigation = /\b(navigate|open|go to|visit)\b/.test(p) && /https?:\/\//.test(p);
  const wantsSnapshot = /\b(snapshot|page title|accessibility|inspect the page|read the page)\b/.test(p);
  const sequence: string[] = [];
  if (hasBrowser && wantsNavigation) sequence.push('playwright__browser_navigate');
  if (hasBrowser && wantsSnapshot) sequence.push('playwright__browser_snapshot');
  if (hasTerminal && /\b(run|execute|use|in)\b/.test(p)) sequence.push('desktop_commander__start_process');
  return sequence.filter((name) => available.includes(name));
}

/** Stop immediately on user cancel: one finalization pass, capped at 10s; on
 *  timeout return the honest cancelled message rather than keep thinking. */
async function finalizeCancelled(
  messages: any[], start: number, iterations: number, toolCallCount: number,
  emit: Emitter, modelId: string, deterministicManagedAgent: boolean,
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
      undefined,
      modelId,
      deterministicManagedAgent,
    );
    return doneCancelled(
      final.choices?.[0]?.message?.content ?? '(cancelled)',
      start, iterations, toolCallCount, modelId,
    );
  } catch {
    return doneCancelled(
      '(cancelled — no further work will run; some earlier steps may have completed)',
      start, iterations, toolCallCount, modelId,
    );
  }
}

/** Returns true when a model response looks like a raw tool-call JSON blob
 *  rather than a real answer — e.g. `{"name":"web_search","parameters":{…}}`.
 *  We check the trimmed content starts with `{` and contains a `"name"` key
 *  paired with a `"parameters"` or `"arguments"` key. Conservative: would
 *  rather miss an edge case than mangle a valid JSON answer. */
export function looksLikeRawToolCall(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{')) return false;
  try {
    const obj = JSON.parse(t);
    return (
      typeof obj === 'object' && obj !== null &&
      typeof obj.name === 'string' &&
      ('parameters' in obj || 'arguments' in obj)
    );
  } catch {
    return false;
  }
}

/** Detects FABRICATED tool execution woven into a prose answer — the dangerous
 *  failure mode where a small local model writes its own fake "Tool output:"
 *  blocks and embedded tool-call JSON, narrating a tool run that never happened.
 *  (Seen live: a model invented an entire fake codebase + fake file contents.)
 *
 *  This is stricter than looksLikeRawToolCall (which only catches a response
 *  that IS a single tool-call blob): here we look for the tell-tale pair of
 *  (a) a fenced or inline tool-call object with name+parameters/arguments AND
 *  (b) a fabricated-output marker. Requiring BOTH keeps false positives low —
 *  a genuine answer that merely mentions JSON won't trip it. Returns true only
 *  when the model is clearly role-playing tool execution. */
export function looksLikeFabricatedToolRun(text: string): boolean {
  // (a) an embedded tool-call object: "name":"x" ... "parameters"|"arguments"
  const hasEmbeddedCall =
    /"name"\s*:\s*"[^"]+"/.test(text) &&
    /"(?:parameters|arguments)"\s*:/.test(text);
  if (!hasEmbeddedCall) return false;
  // (b) a fabricated tool-output / result marker the model wrote itself
  const hasFakeOutput =
    /\bTool output\s*:/i.test(text) ||
    /\bTool result\s*:/i.test(text) ||
    /```[a-z]*\s*\n[\s\S]*?```[\s\S]*"(?:parameters|arguments)"/.test(text);
  return hasFakeOutput;
}

export async function executeLocalEdge(
  req: GatewayRequest,
  emit: Emitter,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  const start = performance.now();
  const personaContent = validateManagedPersonaEnvelope(req);
  const modelId = req.payload.localExecutionTarget?.modelId ?? LOCAL_MODEL;
  const deterministicManagedAgent = Boolean(
    req.payload.agentTurnContext,
  );
  const finish = (
    text: string, startedAt: number, iterations: number, toolCallCount: number,
  ): ExecutionResult => done(text, startedAt, iterations, toolCallCount, modelId);

  // Task-filtered, namespaced, alias-mapped, approval-gated toolset.
  // S2: callerCollabPrincipalId gates collab__* tool visibility — omitted
  // (undefined) for a task with no bound agent identity, which is every
  // task dispatched by this repo today.
  const discoveredTools = await getToolsForTask(
    req.payload.taskType, 'LOCAL_EDGE', req.effectiveProfile, req.payload.callerCollabPrincipalId,
  );
  const { resolveAlias, requiresApproval } = discoveredTools;
  const openAITools = req.payload.agentTurnContext ? [] : discoveredTools.openAITools;
  const requestedTools = requestedLocalToolSequence(
    req.payload.prompt,
    openAITools.map((t) => t.function.name),
  );

  // Small local models improvise without hard grounding: they fabricate tool
  // output, claim capabilities they lack, and role-play. Pin them to reality —
  // the exact tools available, and an explicit ban on inventing results.
  const toolList = openAITools.length
    ? openAITools.map((t) => `- ${t.function.name}: ${t.function.description}`).join('\n')
    : '(none available for this task)';
  const context = req.payload.assembledContext;
  const agentDirectives = personaContent;
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
        '4. Answer only from real tool results or your own knowledge — never invent data.\n' +
        '5. NEVER write a line like "Tool output:" or "Tool result:" followed by ' +
        'made-up content, and never quote file contents, code, or data you have ' +
        'not actually received from a real tool result. If you have not received ' +
        'a tool result, you do not know what it would say.\n\n' +
        (requestedTools.length
          ? `6. This request requires real tool calls in this order: ${requestedTools.join(' -> ')}. Do not answer until they run.\n\n`
          : '') +
        `AVAILABLE TOOLS:\n${toolList}` +
        (context ? `\n\n${context}` : ''),
    },
    ...(agentDirectives ? [{
      role: 'system',
      content:
        'SUBORDINATE AGENT PERSONA (operator-authored):\n' +
        'These instructions are subordinate only to the immutable TORQCLAW rules above.\n' +
        `--- AGENT DIRECTIVES ---\n${agentDirectives}\n--- END AGENT DIRECTIVES ---`,
    }] : []),
    { role: 'user', content: `--- BEGIN UNTRUSTED CHANNEL CONTENT ---\n${req.payload.prompt}\n--- END UNTRUSTED CHANNEL CONTENT ---` },
  ];

  // E2E determinism seam: force a gated-tool hit so the approval loop can be
  // tested without depending on the local model's tool-choice. Honors the grant
  // exactly like a real gated tool, so the APPROVE re-run proceeds. Off unless
  // the env var is set; never active in production.
  const forced = process.env.TORQCLAW_E2E_FORCE_GATED_TOOL;
  if (forced) {
    const forcedArgs = { e2e: true, prompt: req.payload.prompt };
    if (!req.payload.grantedTools.includes(forced)) {
      throw new ToolApprovalRequired(forced, forcedArgs);
    }
    // "Honors the grant exactly like a real gated tool" MUST include the
    // admission seam, or this seam is a hole rather than a mirror: an E2E
    // built on it would report success while the real admission wire was
    // broken or absent (G2A D-5 -- that is precisely how D-1 and D-2
    // survived). The forced path now takes the same admitTool decision the
    // real tool-call loop takes below.
    const admission = admitTool(req.id, forced, forcedArgs);
    if (!admission.ok) {
      emit('TOOL_CALL', `Refused ${forced}`, { granted: true, refused: admission.reason });
      return finish(
        `[e2e] refused ${forced}: ${admission.reason}`, start, 1, 0,
      );
    }
    emit('TOOL_CALL', `Executing ${forced}`, { granted: true });
    return finish(`[e2e] executed ${forced} under grant`, start, 1, 1);
  }

  let iterations = 0;
  let toolCallCount = 0;

  while (iterations < MAX_ITERATIONS) {
    // Cancellation check #1: between iterations.
    if (isCancelled(req.id)) {
      return finalizeCancelled(
        messages, start, iterations, toolCallCount, emit, modelId, deterministicManagedAgent,
      );
    }
    iterations++;
    const nextRequested = requestedTools[toolCallCount];
    const forcedAlias = nextRequested
      ? openAITools.find((t) => t.function.name === nextRequested)?.function.name
      : undefined;
    // For an explicit device workflow, expose only the required next tool and
    // use Ollama's portable `required` mode. Some local OpenAI-compatible
    // servers ignore a named tool_choice when many tools are present, while
    // `required` is reliable with a one-tool set.
    const toolsForCall = forcedAlias
      ? openAITools.filter((t) => t.function.name === forcedAlias)
      : openAITools;
    const result = await callOllama(
      messages,
      toolsForCall,
      signal,
      forcedAlias ? 'required' : undefined,
      modelId,
      deterministicManagedAgent,
    );
    router.markLocalModelWarm(); // feed the cold-start rule real data
    const message = result.choices?.[0]?.message;
    if (!message) throw new Error('Ollama returned an empty completion');
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      // Guard: small models sometimes emit a raw JSON tool-call blob as prose
      // instead of firing the tool (e.g. `{"name":"web_search","parameters":{…}}`).
      // If the only content looks like a stray tool call, replace it with an
      // honest fallback rather than returning fabricated JSON to the user.
      const content = message.content ?? '';
      if (looksLikeRawToolCall(content)) {
        return finish(
          "I don't have the tools needed to complete that request on the local model. " +
          'Try switching to Cloud mode, or ask something the local model can answer directly.',
          start, iterations, toolCallCount,
        );
      }
      // Stronger guard: the model narrated FAKE tool execution (invented
      // "Tool output:" blocks + embedded tool-call JSON) instead of really
      // calling a tool. Returning that would show the user fabricated results
      // dressed up as real ones — worse than an honest refusal. Replace it.
      if (looksLikeFabricatedToolRun(content)) {
        emit('SYSTEM', 'Discarded a fabricated tool run from the local model');
        return finish(
          'The local model started inventing tool results instead of running real ' +
          'tools, so I stopped and discarded that answer. Switch to Cloud mode for ' +
          'this task, or rephrase it so the local model can answer from its own ' +
          'knowledge without tools.',
          start, iterations, toolCallCount,
        );
      }
      // Some local models emit a Python-style tool object as prose on a
      // granted rerun (for example, `False` instead of JSON `false`). For an
      // explicit workflow, give the model one bounded corrective turn rather
      // than treating that text as a completed command.
      if (forcedAlias && toolCallCount < requestedTools.length) {
        messages.push({
          role: 'user',
          content: `You did not emit a function call. Emit the real ${forcedAlias} function call now; do not write JSON, Python, or explanatory prose.`,
        });
        continue;
      }
      return finish(content, start, iterations, toolCallCount);
    }

    for (const toolCall of message.tool_calls) {
      // Cancellation check #2: between tool calls within an iteration. Stop
      // before firing any further tool — no side effects after stop.
      if (isCancelled(req.id)) {
        return finalizeCancelled(
          messages, start, iterations, toolCallCount, emit, modelId, deterministicManagedAgent,
        );
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

      // C2-8 / §1.4: the actual pre-tool-execution seam. Under the flag,
      // a granted tool must ALSO present one unconsumed exact-action grant
      // matching THESE arguments, validated and consumed in the same
      // state.db serialization interval. Legacy `grantedTools` membership
      // alone never authorizes external work once C2 is on.
      //
      // Reported back to the model as a tool error rather than thrown: a
      // refusal here means this call did not happen, which is exactly what
      // the model needs to know, and throwing would abort a run that may
      // still have legitimate non-gated work to finish.
      if (granted && requiresApproval(realName)) {
        const admission = admitTool(req.id, realName, toolArgs);
        if (!admission.ok) {
          messages.push({
            role: 'tool', tool_call_id: toolCall.id, name: alias,
            content: `ERROR: tool call refused (${admission.reason}). No action was taken.`,
          });
          continue;
        }
      }

      emit('TOOL_CALL', `Executing ${realName}`, { args: toolArgs });
      try {
        // PRD-TCLAW-AGENT-PARTICIPATION-007 S2: threaded ONLY from
        // req.payload.callerCollabPrincipalId — a gateway-owned field no
        // ClientCommand can populate (contracts/routing.ts) — never from
        // toolArgs (model output). A task with no bound agent identity
        // passes undefined here, and executeTool omits the _meta key
        // entirely in that case (byte-identical to pre-S2 behavior).
        const toolResult = await executeTool(
          realName,
          toolArgs,
          req.effectiveProfile,
          req.payload.callerCollabPrincipalId,
          buildManagedAgentToolContext(req),
        );
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
  const final = await callOllama(
    messages, undefined, signal, undefined, modelId, deterministicManagedAgent,
  );
  router.markLocalModelWarm();
  return finish(
    final.choices?.[0]?.message?.content ?? '(no answer)',
    start, iterations + 1, toolCallCount,
  );
}

export function validateManagedPersonaEnvelope(req: GatewayRequest): string | undefined {
  const turn = req.payload.agentTurnContext;
  const envelope = req.payload.agentPersonaEnvelope;
  if (!turn && !envelope) return undefined;
  if (!turn || !envelope || envelope.version !== 1
    || envelope.content !== envelope.content.normalize('NFC').trim()
    || envelope.content.length > 4_000
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(envelope.content)
    || !Number.isInteger(envelope.personaRevision) || envelope.personaRevision < 0
    || envelope.personaRevision !== turn.personaRevision
    || turn.agentPrincipalId !== req.payload.callerCollabPrincipalId
    || createHash('sha256').update(envelope.content, 'utf8').digest('hex') !== envelope.contentSha256
    || (envelope.content === '' && envelope.personaRevision !== 0)) {
    throw new Error('MANAGED_AGENT_PERSONA_ENVELOPE_REFUSED');
  }
  return envelope.content || undefined;
}

export function buildManagedAgentToolContext(
  req: GatewayRequest,
): CollabAgentTurnToolContext | undefined {
  const turn = req.payload.agentTurnContext;
  const target = req.payload.localExecutionTarget;
  if (!turn || !target) return undefined;
  return {
    ...turn,
    dispatchRequestId: req.id,
    expectedProfile: {
      providerAccountId: target.providerId,
      adapterId: target.adapterId,
      modelId: target.modelId,
      personaRevision: turn.personaRevision,
    },
    personaEnvelope: req.payload.agentPersonaEnvelope!,
  };
}

function done(
  text: string, start: number, iterations: number, toolCallCount: number,
  modelId = LOCAL_MODEL,
): ExecutionResult {
  return {
    text,
    telemetry: {
      engineUsed: modelId,
      iterations,
      toolCallCount,
      inferenceLatencyMs: Math.round(performance.now() - start),
    },
  };
}

function doneCancelled(
  text: string, start: number, iterations: number, toolCallCount: number,
  modelId = LOCAL_MODEL,
): ExecutionResult {
  const r = done(text, start, iterations, toolCallCount, modelId);
  r.telemetry.cancelled = true;
  return r;
}
