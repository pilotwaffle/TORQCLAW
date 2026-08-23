import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ClientCommandSchema,
  GatewayRequestSchema,
  type LocalExecutionTarget,
} from '@torqclaw/contracts';
import { makeRequest } from './helpers.js';

const TARGET: LocalExecutionTarget = {
  providerId: 'ollama-local',
  adapterId: 'ollama-local',
  modelId: 'torq-ai-v5',
};

const AGENT_PRINCIPAL_ID = 'agent-principal-1';
const TRIGGER_EVENT_ID = 'trigger-event-1';

function personaEnvelope(content: string, personaRevision: number) {
  return {
    version: 1 as const,
    content,
    personaRevision,
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

function ollamaResponse(text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: text, tool_calls: [] } }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function nativeOllamaResponse(
  text: string,
  toolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [],
): Response {
  return new Response(JSON.stringify({
    message: { role: 'assistant', content: text, tool_calls: toolCalls },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 10,
    eval_count: 2,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('@torqclaw/bridge');
  vi.resetModules();
  delete process.env.TORQCLAW_LOCAL_MODEL;
});

describe('gateway-owned local model routing', () => {
  it('accepts a strict gateway-owned directive envelope and strips websocket spoofing', () => {
    const request = makeRequest();
    request.id = '77777777-7777-4777-8777-777777777777';
    request.sessionId = '88888888-8888-4888-8888-888888888888';
    request.payload.agentPersonaEnvelope = personaEnvelope('Be a rigorous architecture reviewer.', 3);
    request.payload.callerCollabPrincipalId = AGENT_PRINCIPAL_ID;
    request.payload.agentTurnContext = {
      channelId: 'channel-1',
      channelSeq: 42,
      agentPrincipalId: AGENT_PRINCIPAL_ID,
      triggerEventId: TRIGGER_EVENT_ID,
      personaRevision: 3,
    };

    expect(GatewayRequestSchema.parse(request).payload.agentPersonaEnvelope)
      .toEqual(request.payload.agentPersonaEnvelope);
    expect(GatewayRequestSchema.parse(request).payload.agentTurnContext)
      .toEqual(request.payload.agentTurnContext);
    expect(() => GatewayRequestSchema.parse({
      ...request,
      payload: {
        ...request.payload,
        agentPersonaEnvelope: { ...request.payload.agentPersonaEnvelope, extra: true },
      },
    })).toThrow();

    const parsed = ClientCommandSchema.parse({
      action: 'SUBMIT_PROMPT',
      prompt: 'spoof persona',
      agentPersonaEnvelope: request.payload.agentPersonaEnvelope,
      agentTurnContext: request.payload.agentTurnContext,
      payload: {
        agentPersonaEnvelope: request.payload.agentPersonaEnvelope,
        agentTurnContext: request.payload.agentTurnContext,
      },
    } as unknown) as unknown as Record<string, unknown>;
    expect(parsed.agentPersonaEnvelope).toBeUndefined();
    expect(parsed.agentTurnContext).toBeUndefined();
    expect(parsed.payload).toBeUndefined();
  });

  it('sends immutable policy, persona directives, then channel content as distinct roles', async () => {
    const fetchMock = vi.fn(async () => nativeOllamaResponse('persona response'));
    vi.stubGlobal('fetch', fetchMock);
    const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
    const request = makeRequest({ taskType: 'SUMMARIZATION', prompt: 'channel question' });
    request.payload.localExecutionTarget = TARGET;
    request.payload.agentPersonaEnvelope = personaEnvelope('Answer as the local Torq architect.', 4);
    request.payload.callerCollabPrincipalId = AGENT_PRINCIPAL_ID;
    request.payload.agentTurnContext = {
      channelId: 'channel-1',
      channelSeq: 9,
      agentPrincipalId: AGENT_PRINCIPAL_ID,
      triggerEventId: TRIGGER_EVENT_ID,
      personaRevision: 4,
    };

    await executeLocalEdge(request, vi.fn());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown[];
      options: { temperature?: number };
    };

    expect(body.messages.map((message) => message.role)).toEqual(['system', 'system', 'user']);
    expect(body.messages[0]?.content).toContain('RULES:');
    expect(body.messages[1]?.content).toContain('Answer as the local Torq architect.');
    expect(body.messages[2]?.role).toBe('user');
    expect(body.messages[2]?.content).toContain('BEGIN UNTRUSTED CHANNEL CONTENT');
    expect(body.messages[2]?.content).toContain('channel question');
    expect(body.messages[2]?.content).toContain('END UNTRUSTED CHANNEL CONTENT');
    expect(body.messages[2]?.content).not.toContain('AGENT DIRECTIVES');
    expect(body.tools).toBeUndefined();
    expect(body.options.temperature).toBe(0);
  });

  it('accepts only the strict local execution target on GatewayRequest.payload', () => {
    const request = makeRequest();
    request.id = '55555555-5555-4555-8555-555555555555';
    request.sessionId = '66666666-6666-4666-8666-666666666666';
    request.payload.localExecutionTarget = TARGET;

    expect(GatewayRequestSchema.parse(request).payload.localExecutionTarget).toEqual(TARGET);
    expect(() => GatewayRequestSchema.parse({
      ...request,
      payload: {
        ...request.payload,
        localExecutionTarget: { ...TARGET, providerId: 'not-local' },
      },
    })).toThrow();
    expect(() => GatewayRequestSchema.parse({
      ...request,
      payload: {
        ...request.payload,
        localExecutionTarget: { ...TARGET, extra: true },
      },
    })).toThrow();
  });

  it('does not accept a local execution target from a websocket command', () => {
    const parsed = ClientCommandSchema.parse({
      action: 'SUBMIT_PROMPT',
      prompt: 'use another local model',
      localExecutionTarget: TARGET,
      payload: { localExecutionTarget: TARGET },
    } as unknown);

    expect((parsed as Record<string, unknown>).localExecutionTarget).toBeUndefined();
    expect((parsed as Record<string, unknown>).payload).toBeUndefined();
  });

  it('uses the selected model in the Ollama request and telemetry', async () => {
    const fetchMock = vi.fn(async () => nativeOllamaResponse('selected model response'));
    vi.stubGlobal('fetch', fetchMock);
    const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
    const request = makeRequest({ taskType: 'SUMMARIZATION' });
    request.payload.localExecutionTarget = TARGET;

    const result = await executeLocalEdge(request, vi.fn());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { model: string };

    expect(url).toBe('http://localhost:11434/api/chat');
    expect(body.model).toBe('torq-ai-v5');
    expect(body).toMatchObject({
      stream: false,
      think: false,
      keep_alive: -1,
      options: { num_ctx: 8192 },
    });
    expect(body).not.toHaveProperty('options.temperature');
    expect(result.telemetry.engineUsed).toBe('torq-ai-v5');
  });

  it('falls back to TORQCLAW_LOCAL_MODEL when no local target is bound', async () => {
    process.env.TORQCLAW_LOCAL_MODEL = 'process-default-local';
    const fetchMock = vi.fn(async () => ollamaResponse('fallback response'));
    vi.stubGlobal('fetch', fetchMock);
    const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');

    const result = await executeLocalEdge(
      makeRequest({ taskType: 'SUMMARIZATION' }),
      vi.fn(),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { model: string };

    expect(body.model).toBe('process-default-local');
    expect(result.telemetry.engineUsed).toBe('process-default-local');
  });

  it('keeps the selected model through cancellation finalization', async () => {
    const fetchMock = vi.fn(async () => nativeOllamaResponse('cancelled response'));
    vi.stubGlobal('fetch', fetchMock);
    const { executeLocalEdge, setCancelCheck } = await import('../packages/inference/src/ollama.js');
    setCancelCheck(() => true);
    const request = makeRequest({ taskType: 'SUMMARIZATION' });
    request.payload.localExecutionTarget = TARGET;

    const result = await executeLocalEdge(request, vi.fn());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { model: string };

    expect(body.model).toBe('torq-ai-v5');
    expect(result.telemetry).toMatchObject({ engineUsed: 'torq-ai-v5', cancelled: true });
    setCancelCheck(() => false);
  });

  it('normalizes native tool calls into the existing execution loop', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(nativeOllamaResponse('', [{
        function: { name: 'unknown_native_tool', arguments: {} },
      }]))
      .mockResolvedValueOnce(nativeOllamaResponse('recovered after tool error'));
    vi.stubGlobal('fetch', fetchMock);
    const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
    const request = makeRequest({ taskType: 'SUMMARIZATION' });
    request.payload.localExecutionTarget = TARGET;

    const result = await executeLocalEdge(request, vi.fn());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('recovered after tool error');
    expect(result.telemetry).toMatchObject({ engineUsed: 'torq-ai-v5', toolCallCount: 1 });
  });

  it('keeps managed tools undisclosed while forwarding the exact validated envelope in context', async () => {
    const executeTool = vi.fn(async () => [{ type: 'text', text: '{"ok":true}' }]);
    vi.doMock('@torqclaw/bridge', async () => {
      const actual = await vi.importActual<typeof import('@torqclaw/bridge')>('@torqclaw/bridge');
      return {
        ...actual,
        executeTool,
        getToolsForTask: vi.fn(async () => ({
          openAITools: [{
            type: 'function',
            function: {
              name: 'collab__post_message', description: 'post',
              parameters: { type: 'object', properties: {} },
            },
          }],
          resolveAlias: (name: string) => name,
          requiresApproval: () => false,
        })),
      };
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(nativeOllamaResponse('', [{
        function: { name: 'collab__post_message', arguments: { channelId: 'channel-1', text: 'answer' } },
      }]))
      .mockResolvedValueOnce(nativeOllamaResponse('final answer'));
    vi.stubGlobal('fetch', fetchMock);
    const { buildManagedAgentToolContext, executeLocalEdge } = await import('../packages/inference/src/ollama.js');
    const request = makeRequest({ taskType: 'SUMMARIZATION', prompt: 'managed turn' });
    request.payload.localExecutionTarget = TARGET;
    request.payload.callerCollabPrincipalId = AGENT_PRINCIPAL_ID;
    request.payload.agentPersonaEnvelope = personaEnvelope('Exact claimed persona.', 5);
    request.payload.agentTurnContext = {
      channelId: 'channel-1', channelSeq: 11, agentPrincipalId: AGENT_PRINCIPAL_ID,
      triggerEventId: TRIGGER_EVENT_ID, personaRevision: 5,
    };

    await executeLocalEdge(request, vi.fn());

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstBody.tools).toBeUndefined();
    expect(executeTool).not.toHaveBeenCalled();
    const context = buildManagedAgentToolContext(request);
    expect(context).toBeDefined();
    expect(context.personaEnvelope).toBe(request.payload.agentPersonaEnvelope);
    expect(context.personaEnvelope).toEqual(request.payload.agentPersonaEnvelope);
  });

  it('sanitizes native context overflow while preserving required and configured counts', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: JSON.stringify({
        error: {
          code: 400,
          message: 'request SECRET_CHANNEL_TEXT exceeds context',
          type: 'exceed_context_size_error',
          n_prompt_tokens: 5303,
          n_ctx: 4096,
        },
      }),
    }), {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
    const request = makeRequest({ taskType: 'SUMMARIZATION' });
    request.payload.localExecutionTarget = TARGET;

    await expect(executeLocalEdge(request, vi.fn())).rejects.toThrow(
      'OLLAMA_CONTEXT_EXCEEDED required_tokens=5303 configured_tokens=4096',
    );
    await expect(executeLocalEdge(request, vi.fn())).rejects.not.toThrow('SECRET_CHANNEL_TEXT');
  });
});
