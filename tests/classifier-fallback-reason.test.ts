import { afterEach, expect, it, vi } from 'vitest';
import { classifyTaskType } from '../packages/gateway/src/classifier.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function pendingFetch() {
  return vi.fn((_url, init: RequestInit) => new Promise((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
  }));
}

it('classifier_timeout_reports_fallback_reason_timeout', async () => {
  vi.stubEnv('TORQCLAW_CLASSIFIER_TIMEOUT_MS', '250');
  vi.stubGlobal('fetch', pendingFetch());
  const cls = await classifyTaskType('summarize this text');
  expect(cls.fallbackReason).toBe('timeout');
  expect(cls.method).not.toBe('LOCAL_LLM');
  expect(cls.latencyMs).toBeGreaterThanOrEqual(200);
});

it('classifier_unreachable_reports_unreachable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
  const cls = await classifyTaskType('what is 2 + 2');
  expect(cls.fallbackReason).toBe('unreachable');
  expect(cls.method).toBe('DEFAULT');
});

it('classifier_bad_schema_reports_bad_response', async () => {
  for (const response of [
    new Response('x', { status: 500 }),
    new Response(JSON.stringify({ message: { content: '{"taskType":"NOT_A_TYPE","confidence":0.9}' } })),
    new Response('{}'),
  ]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const cls = await classifyTaskType('summarize this text');
    expect.soft(cls.fallbackReason).toBe('bad_response');
    expect(cls.method).not.toBe('LOCAL_LLM');
  }
});

it('classifier_timeout_env_floor_250ms', async () => {
  const mod = await import('../packages/gateway/src/classifier.js');
  const timeoutFn = (mod as unknown as Record<string, unknown>).classifierTimeoutMs;
  expect(timeoutFn).toEqual(expect.any(Function));
  if (typeof timeoutFn !== 'function') return;
  for (const [value, expected] of [
    ['10', 250], [undefined, 1500], ['', 1500], ['abc', 1500], ['3000', 3000],
  ] as const) {
    vi.stubEnv('TORQCLAW_CLASSIFIER_TIMEOUT_MS', value);
    expect(timeoutFn()).toBe(expected);
  }
  vi.stubEnv('TORQCLAW_CLASSIFIER_TIMEOUT_MS', '10');
  vi.stubGlobal('fetch', pendingFetch());
  const cls = await classifyTaskType('summarize this text');
  expect(cls.fallbackReason).toBe('timeout');
  expect(cls.latencyMs).toBeGreaterThanOrEqual(200);
});

it('classifier_local_llm_has_no_fallback_reason', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    message: { content: '{"taskType":"SUMMARIZATION","confidence":0.9}' },
  }))));
  const cls = await classifyTaskType('summarize this text');
  expect(cls.method).toBe('LOCAL_LLM');
  expect(cls.fallbackReason).toBeUndefined();
  expect(cls.taskType).toBe('SUMMARIZATION');
});
