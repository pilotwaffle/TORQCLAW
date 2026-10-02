import { describe, expect, it, vi } from 'vitest';
import {
  ROOM_JOB_COMPLETION_TOKEN_CAP,
  ROOM_JOB_RESPONSE_BYTE_CAP,
  RoomJobLocalRunError,
  assertRoomJobLocalRuntimeReady,
  executeRoomJobLocal,
} from '../packages/inference/src/ollama.js';

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('server-only Room-job local runner', () => {
  const input = {
    modelId: 'torq-local:latest',
    system: 'Return JSON only.',
    quotedInput: '<brief>untrusted</brief>',
    format: {
      type: 'object', properties: { version: { type: 'integer' } }, required: ['version'], additionalProperties: false,
    },
  };

  it('serializes an explicit empty tools array, strict response format, and bounded completion option', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools: unknown; format: unknown; options: { num_predict: number } };
      expect(Object.hasOwn(body, 'tools')).toBe(true);
      expect(body.tools).toEqual([]);
      expect(body.format).toEqual(input.format);
      expect(body.options.num_predict).toBe(ROOM_JOB_COMPLETION_TOKEN_CAP);
      return responseFromChunks([new TextEncoder().encode(JSON.stringify({
        message: { content: '{"version":1}' }, eval_count: 12,
      }))]);
    });
    const result = await executeRoomJobLocal(input, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.text).toBe('{"version":1}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a provider tool response without any continuation', async () => {
    const fetchImpl = vi.fn(async () => responseFromChunks([new TextEncoder().encode(JSON.stringify({
      message: { content: '', tool_calls: [{ function: { name: 'web_search' } }] },
    }))]));
    await expect(executeRoomJobLocal(input, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ code: 'tool_attempt_refused' } satisfies Partial<RoomJobLocalRunError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts streamed bodies before buffering a response larger than the immutable artifact cap', async () => {
    const first = new Uint8Array(ROOM_JOB_RESPONSE_BYTE_CAP);
    const second = new Uint8Array([1]);
    const fetchImpl = vi.fn(async () => responseFromChunks([first, second]));
    await expect(executeRoomJobLocal(input, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ code: 'response_oversize' } satisfies Partial<RoomJobLocalRunError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses cloud-labelled models before any provider invocation', async () => {
    const fetchImpl = vi.fn();
    await expect(executeRoomJobLocal({ ...input, modelId: 'kimi-k2.6:cloud' }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({ code: 'runtime_unavailable' } satisfies Partial<RoomJobLocalRunError>);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('distinguishes an unreadable readiness transport from confirmed unavailability', async () => {
    const runtime = { host: 'http://127.0.0.1:11434', modelId: 'torq-local:latest', configurationIdentity: 'a'.repeat(64) };
    await expect(assertRoomJobLocalRuntimeReady(runtime, {
      fetchImpl: (async () => { throw new TypeError('connection refused'); }) as typeof fetch,
    })).rejects.toMatchObject({ code: 'runtime_unknown' } satisfies Partial<RoomJobLocalRunError>);
    await expect(assertRoomJobLocalRuntimeReady(runtime, {
      fetchImpl: (async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as typeof fetch,
    })).rejects.toMatchObject({ code: 'runtime_unavailable' } satisfies Partial<RoomJobLocalRunError>);
  });
});
