import { describe, expect, it, vi } from 'vitest';

const { waitForHttpReachable, waitForHttpReady } = await import('../ops/readiness.mjs');

const response = (status: number, payload: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

describe('waitForHttpReady', () => {
  it('returns only after the expected service reports ready', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(503, { service: 'torqclaw-console', status: 'starting' }))
      .mockResolvedValueOnce(response(200, { service: 'other-service', status: 'ready' }))
      .mockResolvedValueOnce(response(200, { service: 'torqclaw-console', status: 'ready' }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(waitForHttpReady('http://127.0.0.1:3000/api/health', {
      expectedService: 'torqclaw-console',
      timeoutMs: 100,
      intervalMs: 1,
      fetchImpl,
      sleepImpl,
    })).resolves.toEqual({ service: 'torqclaw-console', status: 'ready' });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a wrong service even when the port returns HTTP 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, { service: 'unrelated-app', status: 'ready' }),
    );

    await expect(waitForHttpReady('http://127.0.0.1:3000/api/health', {
      expectedService: 'torqclaw-console',
      timeoutMs: 5,
      intervalMs: 1,
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('unexpected service');
  });

  it('rejects a service that is reachable but not ready', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, { service: 'torqclaw-console', status: 'starting' }),
    );

    await expect(waitForHttpReady('http://127.0.0.1:3000/api/health', {
      expectedService: 'torqclaw-console',
      timeoutMs: 5,
      intervalMs: 1,
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('status "starting"');
  });

  it('times out when the console never responds', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection refused'));

    await expect(waitForHttpReady('http://127.0.0.1:3000/api/health', {
      expectedService: 'torqclaw-console',
      timeoutMs: 5,
      intervalMs: 1,
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('Timed out waiting');
  });
});

describe('waitForHttpReachable', () => {
  it('treats any HTTP response as a listening service, including a 404', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(response(404, {}));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(waitForHttpReachable('http://127.0.0.1:18790/', {
      timeoutMs: 100,
      intervalMs: 1,
      fetchImpl,
      sleepImpl,
    })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it('times out when the service never binds its port', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection refused'));

    await expect(waitForHttpReachable('http://127.0.0.1:18790/', {
      timeoutMs: 5,
      intervalMs: 1,
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('Timed out waiting');
  });
});
