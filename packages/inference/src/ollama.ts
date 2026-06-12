import type { GatewayRequest } from '@torqclaw/contracts';
import { router } from '@torqclaw/router';
import { getToolsForTask, executeTool } from '@torqclaw/bridge';
import type { Emitter, ExecutionResult } from './types.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
// 'torq-local' is built by `pnpm model:setup` (ops/Modelfile): llama3.1:8b
// with num_ctx 8192 baked in — the /v1 endpoint can't set num_ctx per-request.
const LOCAL_MODEL = process.env.TORQCLAW_LOCAL_MODEL || 'torq-local';

const MAX_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 6_000; // ~1.5k tokens; raw file reads must not nuke the window
const INFERENCE_TIMEOUT_MS = 120_000;

async function callOllama(messages: unknown[], tools?: unknown[]) {
  const res = await fetch(`${OLLAMA_HOST}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
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

export async function executeLocalEdge(
  req: GatewayRequest,
  emit: Emitter,
): Promise<ExecutionResult> {
  const start = performance.now();

  // Task-filtered, namespaced, alias-mapped, approval-gated toolset.
  const { openAITools, resolveAlias, requiresApproval } =
    await getToolsForTask(req.payload.taskType, 'LOCAL_EDGE');

  const messages: any[] = [
    {
      role: 'system',
      content:
        'You are TORQCLAW, an autonomous agent. Use tools when necessary. ' +
        'Be concise and concrete.\n\n' +
        (req as any).assembledContext ?? '',
    },
    { role: 'user', content: req.payload.prompt },
  ];

  let iterations = 0;
  let toolCallCount = 0;

  while (iterations < MAX_ITERATIONS) {
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

      // Approval gate: write-capable tools on LOCAL_EDGE pause for a human.
      if (requiresApproval(realName)) {
        emit('PENDING_APPROVAL', `Tool ${realName} requires approval`, { args: toolArgs });
        messages.push({
          role: 'tool', tool_call_id: toolCall.id, name: alias,
          content: 'DEFERRED: this tool requires human approval. It has been queued; continue with read-only work or finalize.',
        });
        continue;
      }

      emit('TOOL_CALL', `Executing ${realName}`, { args: toolArgs });
      try {
        const toolResult = await executeTool(realName, toolArgs);
        // FIX (b): cap result size; tell the model WHY the data ends.
        const body = JSON.stringify(toolResult);
        const content =
          body.length > MAX_TOOL_RESULT_CHARS
            ? body.slice(0, MAX_TOOL_RESULT_CHARS) +
              `\n[TRUNCATED: ${body.length} chars total — request a narrower range]`
            : body;
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
