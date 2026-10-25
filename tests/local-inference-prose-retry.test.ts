import { afterEach, expect, it, vi } from 'vitest';
import { makeRequest } from './helpers.js';

const RAW = '{"name":"web_search","parameters":{"query":"2 + 2"}}';
const REFUSAL = "I don't have the tools needed to complete that request on the local model. " +
  'Try switching to Cloud mode, or ask something the local model can answer directly.';
const RETRY = 'That was not a tool call. Answer the question directly in plain prose, without tools.';

function ollamaResponse(content: string, tool_calls: unknown[] = []): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content, tool_calls } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

async function mockBridge(name: string) {
  const executeTool = vi.fn();
  // Root tests cannot resolve the package name under pnpm; mock the same
  // built entry that the inference workspace resolves for @torqclaw/bridge.
  vi.doMock('../packages/bridge/dist/index.js', async () => {
    const actual = await vi.importActual<typeof import('../packages/bridge/dist/index.js')>('../packages/bridge/dist/index.js');
    return {
      ...actual, executeTool,
      getToolsForTask: vi.fn(async () => ({
        openAITools: [{ type: 'function', function: {
          name, description: 'test tool', parameters: { type: 'object', properties: {} },
        } }],
        resolveAlias: (alias: string) => alias,
        requiresApproval: () => false,
      })),
    };
  });
  return executeTool;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../packages/bridge/dist/index.js');
  vi.resetModules();
});

it('plain_question_raw_tool_blob_gets_one_prose_retry', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(ollamaResponse(RAW)).mockResolvedValueOnce(ollamaResponse('4'));
  vi.stubGlobal('fetch', fetchMock);
  const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
  const result = await executeLocalEdge(makeRequest({ taskType: 'SUMMARIZATION', prompt: 'what is 2 + 2' }), vi.fn());
  expect(result.text).toBe('4');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/chat\/completions$/);
  const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
  expect(body).not.toHaveProperty('tools');
  expect(body).not.toHaveProperty('tool_choice');
  expect(body.messages.at(-1)).toEqual({ role: 'user', content: RETRY });
  expect(body.messages.at(-2)).toMatchObject({ role: 'assistant', content: RAW });
  expect(result.telemetry.iterations).toBe(2);
});

it('prose_retry_is_bounded_to_one', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => ollamaResponse(RAW));
  vi.stubGlobal('fetch', fetchMock);
  const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
  const result = await executeLocalEdge(makeRequest({ taskType: 'SUMMARIZATION', prompt: 'what is 2 + 2' }), vi.fn());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.text).toBe(REFUSAL);
});

it('prose_retry_never_executes_tool_calls', async () => {
  const executeTool = await mockBridge('web_search');
  const fetchMock = vi.fn().mockResolvedValueOnce(ollamaResponse(RAW)).mockResolvedValueOnce(ollamaResponse('', [
    { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
  ]));
  vi.stubGlobal('fetch', fetchMock);
  const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
  const result = await executeLocalEdge(makeRequest({ taskType: 'SUMMARIZATION', prompt: 'what is 2 + 2' }), vi.fn());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(executeTool).not.toHaveBeenCalled();
  expect(result.text).toBe(REFUSAL);
});

it('fabricated_tool_run_still_discarded_without_retry', async () => {
  const fabricated =
    'Let me read the file:\n' +
    '```\n{"name": "filesystem__read_text_file", "parameters": {"path": "C:\\\\x\\\\tv.py"}}\n```\n' +
    'Tool output:\n```python\ndef tv_get_bars(symbol): ...\n```\n' +
    'Based on this output, we can connect to TradingView.';
  const fetchMock = vi.fn().mockResolvedValueOnce(ollamaResponse(fabricated));
  vi.stubGlobal('fetch', fetchMock);
  const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
  const emit = vi.fn();
  const result = await executeLocalEdge(makeRequest({ taskType: 'SUMMARIZATION', prompt: 'what is 2 + 2' }), emit);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith('SYSTEM', 'Discarded a fabricated tool run from the local model');
  expect(result.text).toBe('The local model started inventing tool results instead of running real ' +
    'tools, so I stopped and discarded that answer. Switch to Cloud mode for ' +
    'this task, or rephrase it so the local model can answer from its own ' +
    'knowledge without tools.');
});

it('explicit_workflow_skips_prose_retry', async () => {
  const executeTool = await mockBridge('playwright__browser_navigate');
  const fetchMock = vi.fn().mockResolvedValueOnce(ollamaResponse(RAW));
  vi.stubGlobal('fetch', fetchMock);
  const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
  const result = await executeLocalEdge(makeRequest({
    taskType: 'SUMMARIZATION', prompt: 'Use the browser to navigate to https://example.com',
  }), vi.fn());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).tool_choice).toBe('required');
  expect(executeTool).not.toHaveBeenCalled();
  expect(result.text).toBe(REFUSAL);
});

it('plain_prose_answer_unchanged_single_call', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(ollamaResponse('4'));
  vi.stubGlobal('fetch', fetchMock);
  const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
  const result = await executeLocalEdge(makeRequest({ taskType: 'SUMMARIZATION', prompt: 'what is 2 + 2' }), vi.fn());
  expect(result.text).toBe('4');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('system_prompt_contains_answer_first_rule', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(ollamaResponse('4'));
  vi.stubGlobal('fetch', fetchMock);
  const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
  await executeLocalEdge(makeRequest({ taskType: 'SUMMARIZATION', prompt: 'what is 2 + 2' }), vi.fn());
  const system = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).messages[0].content as string;
  expect(system).toContain('FIRST decide whether the request needs a tool');
  expect(system.startsWith('You are TORQCLAW running on a local model. Be concise and concrete.')).toBe(true);
  let previous = -1;
  for (const rule of [
    'FIRST decide whether the request needs a tool',
    '2. You can ONLY act through the tools listed below',
    '3. To use a tool, emit a real function call. NEVER write tool output',
    '6. NEVER write a line like "Tool output:" or "Tool result:"',
    'AVAILABLE TOOLS:',
  ]) {
    expect(system.indexOf(rule)).toBeGreaterThan(previous);
    previous = system.indexOf(rule);
  }
  expect(system).toContain('without current or externally verified data');
});
