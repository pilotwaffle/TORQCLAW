import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const {
  parseHttpUrl,
  parsePositiveInteger,
  waitForHttpReachable,
  waitForHttpReady,
  waitForHttpOk,
} = await import('../ops/readiness.mjs');
const { buildLauncherConfig } = await import('../ops/launcher-config.mjs');
const { ensureRuntimeBuild } = await import('../ops/runtime-build.mjs');
const {
  browserCommand,
  openExternalUrl,
  runStartupSequence,
  waitForChildReadiness,
} = await import('../ops/startup-sequence.mjs');

const response = (status: number, payload: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

describe('readiness configuration', () => {
  it('parses explicit and fallback positive integers', () => {
    expect(parsePositiveInteger('3100', 3000, 'port', { max: 65535 })).toBe(3100);
    expect(parsePositiveInteger(undefined, 3000, 'port', { max: 65535 })).toBe(3000);
  });

  it.each(['0', '-1', '1.5', 'not-a-number', '65536'])(
    'rejects invalid bounded integers: %s',
    (value) => {
      expect(() => parsePositiveInteger(value, 3000, 'port', { max: 65535 })).toThrow(
        'port must be an integer',
      );
    },
  );

  it('accepts only HTTP and HTTPS browser URLs', () => {
    expect(parseHttpUrl('http://localhost:3100', 'url')).toBe('http://localhost:3100/');
    expect(parseHttpUrl('https://example.test/path', 'url')).toBe('https://example.test/path');
    expect(() => parseHttpUrl('file:///C:/Windows/System32', 'url')).toThrow('HTTP or HTTPS');
    expect(() => parseHttpUrl('not a url', 'url')).toThrow('valid HTTP(S) URL');
  });

  it('keeps the local engine probe and gateway connection on the same custom port', () => {
    const config = buildLauncherConfig({ HERMES_PORT: '8100' });
    expect(config.enginePort).toBe(8100);
    expect(config.engineUrl).toBe('http://127.0.0.1:8100/mcp');
  });

  it('rejects a gateway engine URL that disagrees with the engine port', () => {
    expect(() => buildLauncherConfig({
      HERMES_PORT: '8100',
      HERMES_ENGINE_URL: 'http://127.0.0.1:8000/mcp',
    })).toThrow('configured port 8100');
  });

  it('rejects console health and browser targets with different origins', () => {
    expect(() => buildLauncherConfig({
      TORQCLAW_CONSOLE_PORT: '3100',
      TORQCLAW_CONSOLE_URL: 'http://localhost:3100',
      TORQCLAW_CONSOLE_HEALTH_URL: 'http://127.0.0.1:3100/api/health',
    })).toThrow('must share TORQCLAW_CONSOLE_URL origin');
  });

  it('rejects non-local and mismatched-port console targets', () => {
    expect(() => buildLauncherConfig({
      TORQCLAW_CONSOLE_URL: 'https://example.test',
    })).toThrow('local development stack');
    expect(() => buildLauncherConfig({
      TORQCLAW_CONSOLE_URL: 'http://localhost:3100',
    })).toThrow('configured port 3000');
  });

  it.each([
    'http://localhost:3000/api/health',
    'http://localhost:3000/?debug=1',
    'http://localhost:3000/#health',
  ])('rejects a browser target that is not the console root: %s', (consoleUrl) => {
    expect(() => buildLauncherConfig({ TORQCLAW_CONSOLE_URL: consoleUrl })).toThrow(
      'console root path (/)',
    );
  });
});

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  unref = vi.fn();
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('startup orchestration', () => {
  it('opens the browser only after engine, gateway, console health, and root readiness', async () => {
    const order: string[] = [];
    const consoleReady = deferred<{ status: string }>();
    const startup = runStartupSequence({
      launchEngine: () => { order.push('launch-engine'); return new FakeChild(); },
      waitEngine: async () => { order.push('ready-engine'); },
      launchGateway: () => { order.push('launch-gateway'); return new FakeChild(); },
      waitGateway: async () => { order.push('ready-gateway'); },
      launchConsole: () => { order.push('launch-console'); return new FakeChild(); },
      waitConsole: async () => {
        order.push('wait-console');
        return consoleReady.promise;
      },
      onReady: async () => { order.push('open-browser'); },
    });

    await vi.waitFor(() => expect(order).toContain('wait-console'));
    expect(order).not.toContain('open-browser');
    consoleReady.resolve({ status: 'ready' });
    await startup;
    expect(order).toEqual([
      'launch-engine',
      'ready-engine',
      'launch-gateway',
      'ready-gateway',
      'launch-console',
      'wait-console',
      'open-browser',
    ]);
  });

  it('does not run the browser step when a launched child exits before readiness', async () => {
    const child = new FakeChild();
    const neverReady = deferred<void>();
    const ready = waitForChildReadiness('Console', child, neverReady.promise);
    child.emit('exit', 1, null);
    await expect(ready).rejects.toThrow('Console exited before readiness');
  });

  it('keeps ready dependencies monitored until after the browser step', async () => {
    const engine = new FakeChild();
    const consoleReady = deferred<{ status: string }>();
    const onReady = vi.fn();
    const startup = runStartupSequence({
      launchEngine: () => engine,
      waitEngine: async () => {},
      launchGateway: () => new FakeChild(),
      waitGateway: async () => {},
      launchConsole: () => new FakeChild(),
      waitConsole: () => consoleReady.promise,
      onReady,
    });

    engine.emit('exit', 1, null);
    consoleReady.resolve({ status: 'ready' });
    await expect(startup).rejects.toThrow('Engine exited during startup');
    expect(onReady).not.toHaveBeenCalled();
  });

  it('uses non-shell browser commands and reports opener spawn errors', async () => {
    expect(browserCommand('win32', 'http://localhost:3000/')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'http://localhost:3000/'],
    });

    const opener = new FakeChild();
    const spawnImpl = vi.fn(() => opener);
    const opened = openExternalUrl('http://localhost:3000/?a=1&b=2', {
      platform: 'win32',
      spawnImpl,
    });
    opener.emit('spawn');
    await opened;
    expect(spawnImpl).toHaveBeenCalledWith(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', 'http://localhost:3000/?a=1&b=2'],
      expect.objectContaining({ shell: false }),
    );
    expect(opener.unref).toHaveBeenCalled();

    const failedOpener = new FakeChild();
    const failed = openExternalUrl('http://localhost:3000/', {
      platform: 'linux',
      spawnImpl: vi.fn(() => failedOpener),
    });
    failedOpener.emit('error', new Error('missing xdg-open'));
    await expect(failed).rejects.toThrow('missing xdg-open');
  });
});

describe('runtime build preflight', () => {
  it('builds the gateway and optional channel with Turbo before startup', () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0 }));
    ensureRuntimeBuild({
      root: 'C:\\Torq Claw',
      includeHttpChannel: true,
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      spawnSyncImpl,
      env: {},
    });

    expect(spawnSyncImpl).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      expect.arrayContaining([
        'run',
        'build',
        '--filter=@torqclaw/gateway...',
        '--filter=@torqclaw/channel-http...',
      ]),
      expect.objectContaining({ cwd: 'C:\\Torq Claw', shell: false }),
    );
  });

  it('fails closed when the runtime build fails', () => {
    expect(() => ensureRuntimeBuild({
      root: 'C:\\TorqClaw',
      spawnSyncImpl: vi.fn(() => ({ status: 1 })),
    })).toThrow('runtime build failed with exit code 1');
  });
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

describe('waitForHttpOk', () => {
  it('waits until the root page returns a successful response', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(response(200, {}));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(waitForHttpOk('http://127.0.0.1:3000/', {
      timeoutMs: 100,
      intervalMs: 1,
      fetchImpl,
      sleepImpl,
    })).resolves.toMatchObject({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
