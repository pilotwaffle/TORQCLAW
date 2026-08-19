import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const { buildLauncherConfig } = await import('../ops/launcher-config.mjs');
const { runDoctor, doctorPassed, defaultPortProbe } = await import('../ops/doctor-core.mjs');
const { parseArgs } = await import('../ops/doctor.mjs');
const { INSTALL_STEPS, runInstall } = await import('../ops/install.mjs');
const { ensureRuntimeBuild } = await import('../ops/runtime-build.mjs');
const { evaluateLiveAcceptance, buildLiveRequest, requireLiveEnvironment, runLiveAcceptance } = await import('../ops/acceptance-live.mjs');
const {
  TEST_LOG_TAIL_LIMIT,
  sanitizeInheritedEnv,
  sanitizeLogTail,
  isVerifiedTempDir,
  removeVerifiedTempDir,
  reserveLoopbackPorts,
  waitForRuntime,
} = await import('../ops/e2e-production-launch.mjs');
const { stopProcessTree } = await import('../ops/process-tree.mjs');

const productionEnv = {
  TORQCLAW_CHANNEL_SERVICE_TOKEN: 'synthetic-channel-token',
  NEXT_PUBLIC_GATEWAY_URL: 'ws://127.0.0.1:18790/ws',
  TORQCLAW_HOST: '127.0.0.1',
  HERMES_BIND_HOST: '127.0.0.1',
};

describe('G1R CI checkout', () => {
  it('fetches recursive submodules for fresh-worktree doctor preflight', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(workflow).toMatch(/- uses: actions\/checkout@v7\s+with:\s+submodules: recursive/);
  });
});

describe('G1R package entrypoints', () => {
  it('makes the doctor shortcut enforce production preflight', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(packageJson.scripts.doctor).toContain('--preflight --production');
  });
});

describe('G1R launcher configuration', () => {
  it('preserves development defaults and derives local endpoints', () => {
    const config = buildLauncherConfig({});
    expect(config.engineUrl).toBe('http://127.0.0.1:8000/mcp');
    expect(config.engineHealthUrl).toBe('http://127.0.0.1:8000/health');
    expect(config.nextPublicGatewayUrl).toBe('ws://localhost:18790/ws');
  });

  it('uses the exact production loopback console bind while preserving development localhost', () => {
    const development = buildLauncherConfig({});
    const production = buildLauncherConfig(productionEnv, { production: true });
    expect(development.consoleUrl).toBe('http://localhost:3000/');
    expect(production.consoleUrl).toBe('http://127.0.0.1:3000/');
    expect(production.consoleHealthUrl).toBe('http://127.0.0.1:3000/api/health');
    expect(production.nextPublicGatewayUrl).toBe('ws://127.0.0.1:18790/ws');
  });

  it.each(['0.0.0.0', '192.168.1.2', '::'])('rejects non-loopback %s', (host) => {
    expect(() => buildLauncherConfig({ TORQCLAW_HOST: host })).toThrow('loopback');
    expect(() => buildLauncherConfig({ HERMES_BIND_HOST: host })).toThrow('loopback');
  });

  it('rejects credential-bearing local URLs and an inexact public gateway URL', () => {
    expect(() => buildLauncherConfig({ TORQCLAW_CONSOLE_URL: 'http://user:pass@127.0.0.1:3000' })).toThrow('credentials');
    expect(() => buildLauncherConfig({ NEXT_PUBLIC_GATEWAY_URL: 'ws://127.0.0.1:18790/ws?secret=x' })).toThrow('exactly');
    expect(() => buildLauncherConfig({ NEXT_PUBLIC_GATEWAY_URL: 'ws://127.0.0.1:3001/ws' })).toThrow('exactly');
  });

  it('rejects duplicate ports, legacy production auth, and placeholder channel credentials', () => {
    expect(() => buildLauncherConfig({ TORQCLAW_PORT: '8000' })).toThrow('pairwise distinct');
    expect(() => buildLauncherConfig({ ...productionEnv, TORQCLAW_CHANNEL_SERVICE_TOKEN: 'change-me' }, { production: true }))
      .toThrow('placeholder');
    expect(() => buildLauncherConfig({ ...productionEnv, TORQCLAW_GATEWAY_TOKEN: 'credential-value' }, { production: true }))
      .toThrow(/deprecated.*production/i);
    expect(() => buildLauncherConfig({ TORQCLAW_HTTP_CHANNEL: '1' }))
      .toThrow(/requires.*TORQCLAW_CHANNEL_SERVICE_TOKEN/i);
    expect(() => buildLauncherConfig({
      TORQCLAW_HTTP_CHANNEL: '1', TORQCLAW_CHANNEL_SERVICE_TOKEN: 'change-me',
    })).toThrow(/requires.*TORQCLAW_CHANNEL_SERVICE_TOKEN/i);
  });
});

describe('G1R doctor core', () => {
  const fsImpl = { existsSync: vi.fn(() => true) };
  const successfulSpawn = vi.fn(() => ({ status: 0 }));

  it('returns stable records, uses injected probes, and never reports token values', async () => {
    const env = { ...productionEnv };
    const records = await runDoctor({
      mode: 'preflight', production: true, root: 'R', env, fsImpl,
      spawnImpl: successfulSpawn, nodeVersion: '22.1.0',
      envFilePresent: true, portProbe: vi.fn(async () => true),
    });
    expect(doctorPassed(records)).toBe(true);
    expect(records.every((entry) => Object.keys(entry).sort().join(',') === 'id,message,severity,status')).toBe(true);
    expect(JSON.stringify(records)).not.toContain('synthetic-matching-token');
  });

  it('makes live Hermes import fatal and reports production port failures', async () => {
    const records = await runDoctor({
      mode: 'preflight', production: true, liveRequested: true, root: 'R',
      env: { ...productionEnv, HERMES_MODEL: 'model' }, fsImpl,
      spawnImpl: vi.fn(() => ({ status: 1 })), nodeVersion: '20.9.0', envFilePresent: true,
      portProbe: vi.fn(async () => false),
    });
    expect(records.find((entry) => entry.id === 'preflight.hermes-import')?.status).toBe('fail');
    expect(records.find((entry) => entry.id === 'preflight.port-gateway')?.status).toBe('fail');
  });

  it('requires the live provider and key without exposing their values', async () => {
    const records = await runDoctor({
      mode: 'preflight', production: true, liveRequested: true, root: 'R',
      env: { ...productionEnv, HERMES_MODEL: 'model', HERMES_PROVIDER: '', HERMES_API_KEY: '' },
      fsImpl, spawnImpl: successfulSpawn, nodeVersion: '22.1.0', envFilePresent: true,
      portProbe: vi.fn(async () => true),
    });
    expect(records.find((entry) => entry.id === 'preflight.hermes-provider')).toMatchObject({ status: 'fail', message: 'Live Hermes provider is required' });
    expect(records.find((entry) => entry.id === 'preflight.hermes-api-key')).toMatchObject({ status: 'fail', message: 'Live Hermes API key is required' });
    expect(JSON.stringify(records)).not.toContain('HERMES_API_KEY=');
  });

  it('rejects uninitialized submodules and partial JavaScript installs', async () => {
    const partialFs = { existsSync: vi.fn((target: string) => {
      const normalized = target.replaceAll('\\', '/');
      return !normalized.endsWith('run_agent.py') && !normalized.endsWith('node_modules/turbo/bin/turbo');
    }) };
    const records = await runDoctor({
      mode: 'preflight', root: 'R', env: {}, fsImpl: partialFs, spawnImpl: successfulSpawn,
      nodeVersion: '22.1.0', envFilePresent: false,
    });
    expect(records.find((entry) => entry.id === 'preflight.submodule')?.status).toBe('fail');
    expect(records.find((entry) => entry.id === 'preflight.js-install')?.status).toBe('fail');
  });

  it('runtime requires exact health payloads and root readiness', async () => {
    const config = buildLauncherConfig(productionEnv, { production: true });
    const responses: Record<string, unknown> = {
      [config.engineUrl.replace('/mcp', '/health')]: {
        service: 'torqclaw-hermes-engine', status: 'ready', mode: 'stub', modelConfigured: false, hermesAvailable: true, extra: 'wrong',
      },
      [config.gatewayHealthUrl]: { service: 'torqclaw-gateway', status: 'ready' },
      [config.consoleHealthUrl]: { service: 'torqclaw-console', status: 'ready' },
      [config.consoleUrl]: '<html>',
    };
    const fetchImpl = vi.fn(async (url: string) => ({ ok: true, json: async () => responses[url] }));
    const records = await runDoctor({ mode: 'runtime', production: true, env: productionEnv, root: 'R', fetchImpl });
    expect(doctorPassed(records)).toBe(false);
    expect(records.find((entry) => entry.id === 'runtime.engine-health')?.status).toBe('fail');
    expect(records.find((entry) => entry.id === 'runtime.gateway-health')?.status).toBe('pass');
    expect(records.find((entry) => entry.id === 'runtime.console-root')?.status).toBe('pass');
  });

  it('runtime rejects configured models that report stub or unavailable health', async () => {
    const env = { ...productionEnv, HERMES_MODEL: 'model', HERMES_PROVIDER: 'provider', HERMES_API_KEY: 'key' };
    const config = buildLauncherConfig(env, { production: true });
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url === config.engineHealthUrl
        ? { service: 'torqclaw-hermes-engine', status: 'ready', mode: 'stub', modelConfigured: true, hermesAvailable: false }
        : url === config.gatewayHealthUrl
          ? { service: 'torqclaw-gateway', status: 'ready' }
          : url === config.consoleHealthUrl
            ? { service: 'torqclaw-console', status: 'ready' }
            : '<html>',
    }));
    const records = await runDoctor({ mode: 'runtime', production: true, env, root: 'R', fetchImpl });
    expect(records.find((entry) => entry.id === 'runtime.engine-health')?.status).toBe('fail');
  });

  it('enforces mutually exclusive CLI modes and json modifier', () => {
    expect(parseArgs(['--preflight', '--json', '--production'])).toEqual({ mode: 'preflight', json: true, production: true, liveRequested: false });
    expect(() => parseArgs(['--preflight', '--runtime'])).toThrow('exactly one');
    expect(() => parseArgs([])).toThrow('exactly one');
  });
});

describe('G1R portable install and fresh production build', () => {
  it('runs install commands in exact order with shell:false and stops immediately', () => {
    const calls: any[] = [];
    runInstall({
      root: 'R', engineDir: 'R/engines/hermes_kernel', platform: 'linux', env: { SAFE: '1' },
      spawnSyncImpl: (command: string, args: string[], options: any) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });
    expect(calls.map((call) => [call.command, ...call.args])).toEqual(INSTALL_STEPS.map((step) => [step.command, ...step.args]));
    expect(calls.every((call) => call.options.shell === false && call.options.env.SAFE === '1')).toBe(true);

    const failed: any[] = [];
    expect(() => runInstall({
      root: 'R', engineDir: 'R/engine', spawnSyncImpl: (command: string, args: string[]) => {
        failed.push([command, ...args]);
        return { status: failed.length === 3 ? 1 : 0 };
      },
    })).toThrow('install step failed');
    expect(failed).toHaveLength(3);
  });

  it('uses ComSpec for Windows pnpm without shell:true or secret interpolation', () => {
    const calls: any[] = [];
    runInstall({
      root: 'C:\\Portable Repo', engineDir: 'C:\\Portable Repo\\engines\\hermes_kernel', platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', SECRET: 'never-include' },
      spawnSyncImpl: (command: string, args: string[], options: any) => {
        calls.push({ command, args, options }); return { status: 0 };
      },
    });
    expect(calls[1].command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(calls[1].args).toEqual(['/d', '/s', '/c', 'pnpm.cmd install --frozen-lockfile']);
    expect(calls[1].options.shell).toBe(false);
    expect(JSON.stringify(calls.map(({ command, args }) => ({ command, args })))).not.toContain('never-include');
    expect(calls[0].command).toBe('git');
    expect(calls[3].command).toBe('uv');
  });

  it('sanitizes inherited TORQCLAW/HERMES/NEXT_PUBLIC state and isolates test data', () => {
    const userDataPath = 'C:\\Users\\operator\\.torqclaw';
    const dataDir = 'C:\\Windows\\Temp\\torqclaw-g1r-test';
    const env = sanitizeInheritedEnv({
      PATH: 'system-path', USERPROFILE: 'C:\\Users\\operator',
      TORQCLAW_DATA_DIR: userDataPath, HERMES_MODEL: 'user-model', NEXT_PUBLIC_GATEWAY_TOKEN: 'user-token',
    }, { dataDir, consolePort: 3001, enginePort: 8001, gatewayPort: 18791 });
    expect(env.PATH).toBe('system-path');
    expect(env.USERPROFILE).toBe('C:\\Users\\operator');
    expect(env.TORQCLAW_DATA_DIR).toBe(dataDir);
    expect(env.HERMES_MODEL).toBeUndefined();
    // The static shared root token is FORBIDDEN in production
    // (launcher-config.mjs's requireProductionTokens) and must NOT be
    // injected -- the e2e authenticates with a bootstrapped surface
    // credential instead. The collab flag IS injected so that
    // credential's connect path is consulted at all.
    expect(env.TORQCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.NEXT_PUBLIC_GATEWAY_TOKEN).toBeUndefined();
    expect(env.TORQCLAW_COLLAB_ENABLED).toBe('1');
    expect(JSON.stringify(env)).not.toContain(userDataPath);
    expect(isVerifiedTempDir(join('C:\\Windows\\Temp', 'torqclaw-g1r-test'), 'C:\\Windows\\Temp')).toBe(true);
    expect(isVerifiedTempDir(userDataPath, 'C:\\Windows\\Temp')).toBe(false);
  });

  it('removes mixed-case inherited keys across every protected namespace', () => {
    const inheritedKeys = [
      'tOrQcLaW_aMbIeNt',
      'hErMeS_mOdEl',
      'HeRmEs_PrOvIdEr',
      'hermes_Api_Key',
      'nExT_pUbLiC_aMbIeNt',
    ];
    const env = sanitizeInheritedEnv({
      PATH: process.env.PATH ?? '',
      [inheritedKeys[0]]: 'ambient-torqclaw',
      [inheritedKeys[1]]: 'ambient-model',
      [inheritedKeys[2]]: 'ambient-provider',
      [inheritedKeys[3]]: 'ambient-api-key',
      [inheritedKeys[4]]: 'ambient-public',
    }, { dataDir: 'isolated-data', token: 'synthetic-token', consolePort: 3001, enginePort: 8001, gatewayPort: 18791 });
    const sanitizedKeys = Object.keys(env).map((key) => key.toUpperCase());

    for (const inheritedKey of inheritedKeys) {
      expect(sanitizedKeys).not.toContain(inheritedKey.toUpperCase());
    }
  });

  it.runIf(process.platform === 'win32')('prevents uppercase Hermes lookups from recovering mixed-case ambient values in a child process', () => {
    const env = sanitizeInheritedEnv({
      ...process.env,
      hErMeS_mOdEl: 'ambient-model',
      HeRmEs_PrOvIdEr: 'ambient-provider',
      hermes_Api_Key: 'ambient-api-key',
    }, { dataDir: 'isolated-data', token: 'synthetic-token', consolePort: 3001, enginePort: 8001, gatewayPort: 18791 });
    const probe = spawnSync(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify([process.env.HERMES_MODEL ?? null, process.env.HERMES_PROVIDER ?? null, process.env.HERMES_API_KEY ?? null]))',
    ], { env, encoding: 'utf8', shell: false });

    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual([null, null, null]);
  });

  it('removes only a verified generated temp directory', async () => {
    let removed: string | undefined;
    await removeVerifiedTempDir(join('C:\\Windows\\Temp', 'torqclaw-g1r-test'), 'C:\\Windows\\Temp', async (target) => {
      removed = target;
    });
    expect(removed).toBe(join('C:\\Windows\\Temp', 'torqclaw-g1r-test'));
    await expect(removeVerifiedTempDir('C:\\Users\\operator\\.torqclaw', 'C:\\Windows\\Temp', async () => {})).rejects.toThrow('unverified');
  });

  it('resolves the default port probe after its listener close callback', async () => {
    await expect(defaultPortProbe(0, '127.0.0.1')).resolves.toBe(true);
  });

  it('bounds and redacts child log tails', () => {
    const token = 'synthetic-token';
    const tail = sanitizeLogTail(`${'x'.repeat(TEST_LOG_TAIL_LIMIT + 100)}${token}`, [token]);
    expect(tail.length).toBeLessThanOrEqual(TEST_LOG_TAIL_LIMIT);
    expect(tail).not.toContain(token);
    expect(tail).toContain('[REDACTED]');
  });

  it('fails readiness immediately on child exit and includes only sanitized bounded tails', async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const pending = waitForRuntime({}, {}, child, {
      root: 'C:\\Portable Repo', timeoutMs: 10_000,
      stdoutTail: `token=synthetic-token`, stderrTail: 'engine failed', credential: 'synthetic-token',
      runDoctorImpl: async () => [{ id: 'runtime.fake', severity: 'error', status: 'fail', message: 'not ready' }],
    });
    setTimeout(() => { child.exitCode = 17; child.emit('exit', 17, null); }, 0);
    let error: unknown;
    try { await pending; } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/exited before readiness/);
    expect(String(error)).not.toContain('synthetic-token');
  });

  it('wires the bootstrapped credential, never a static token, into the e2e wait/exercise calls', () => {
    const source = readFileSync(new URL('../ops/e2e-production-launch.mjs', import.meta.url), 'utf8');
    // The production contract (launcher-config.mjs requireProductionTokens):
    // the legacy shared root token is FORBIDDEN in production, so the e2e
    // must bootstrap a real operator credential and pass THAT as the
    // redaction secret and the websocket auth -- never an injected env token.
    expect(source).toContain('bootstrapOperatorCredential(root, env, dataDir)');
    expect(source).toContain("auth: { kind: 'surface', credential }");
    expect(source).not.toContain('TORQCLAW_GATEWAY_TOKEN: token');
    expect(source).not.toContain('NEXT_PUBLIC_GATEWAY_TOKEN: token');
  });

  it('reserves distinct OS-assigned loopback ports instead of assuming common app ports are free', async () => {
    const reservation = await reserveLoopbackPorts(3);
    expect(new Set(reservation.ports).size).toBe(3);
    expect(reservation.ports.every((port: number) => port > 0)).toBe(true);
    expect(await defaultPortProbe(reservation.ports[0], '127.0.0.1')).toBe(false);
    await reservation.release();
    expect(await defaultPortProbe(reservation.ports[0], '127.0.0.1')).toBe(true);
  });

  it('stops only the requested process tree with the exact Windows command or POSIX group fallback', async () => {
    const windowsCalls: any[] = [];
    const windowsStopped = await stopProcessTree(4321, {
      platform: 'win32',
      spawnSyncImpl: (command: string, args: string[], options: any) => { windowsCalls.push({ command, args, options }); return { status: 0 }; },
      isAlive: () => false,
    });
    expect(windowsStopped).toBe(true);
    expect(windowsCalls[0]).toMatchObject({ command: 'taskkill.exe', args: ['/pid', '4321', '/t', '/f'], options: { shell: false } });

    const kills: any[] = [];
    const posixStopped = await stopProcessTree(99, {
      platform: 'linux',
      killImpl: (pid: number, signal: string) => { kills.push([pid, signal]); if (pid === -99) throw new Error('no group'); },
      isAlive: () => false,
    });
    expect(posixStopped).toBe(true);
    expect(kills).toEqual([[-99, 'SIGTERM'], [99, 'SIGTERM']]);
  });

  it('uses location-derived wrappers and loads .env before production doctor, without mutating env', () => {
    const cmd = readFileSync(new URL('../ops/start-torqclaw.cmd', import.meta.url), 'utf8');
    const sh = readFileSync(new URL('../ops/start-torqclaw.sh', import.meta.url), 'utf8');
    expect(cmd).toContain('%~dp0..');
    expect(cmd).toContain('node --env-file=.env ops\\doctor.mjs --preflight --production');
    expect(cmd).not.toContain('E:\\TorqClaw');
    expect(sh).toContain('pwd -P');
    expect(sh).toContain('node --env-file=.env ops/doctor.mjs --preflight --production');
    expect(sh).not.toContain('E:/TorqClaw');
    expect(readFileSync(new URL('../ops/dev-up.mjs', import.meta.url), 'utf8')).not.toContain('process.env.HERMES_ENGINE_URL =');
  });

  it('adds console and force only when requested', () => {
    const calls: any[] = [];
    ensureRuntimeBuild({ root: 'R', includeConsole: true, force: true, nodeExecutable: 'node', spawnSyncImpl: (_cmd: string, args: string[]) => {
      calls.push(args); return { status: 0 };
    } });
    expect(calls[0].join(' ')).toContain('@torqclaw/console...');
    expect(calls[0]).toContain('--force');
  });
});

describe('G1R live acceptance oracle', () => {
  const events = (result: any = {}) => [
    { type: 'CONNECTED', requestId: null },
    { type: 'ROUTING', requestId: 'req-1' },
    { type: 'TIER_SELECTED', requestId: 'req-1', tier: 'API_EXTERNAL' },
    { type: 'RESULT', requestId: 'req-1', tier: 'API_EXTERNAL', message: 'TORQCLAW_LIVE_OK', metadata: { engineUsed: 'hermes:model-x' }, ...result },
  ];

  it('accepts only one correlated authenticated-shaped live result', () => {
    expect(evaluateLiveAcceptance(events(), { expectedModel: 'model-x' }).ok).toBe(true);
    expect(buildLiveRequest()).toMatchObject({
      prompt: 'Reply with exactly TORQCLAW_LIVE_OK. Do not call tools.',
      useMemory: false,
      executionMode: 'CLOUD_OK',
      maxCostUsd: 0.25,
    });
  });

  it('rejects missing live credentials before constructing production config', async () => {
    expect(() => requireLiveEnvironment({ HERMES_MODEL: 'model' })).toThrow('HERMES_PROVIDER');
    await expect(runLiveAcceptance({ env: { HERMES_MODEL: 'model' } })).rejects.toThrow('HERMES_PROVIDER');
  });

  it('rejects status-only, timeout-shaped, and unrelated terminal streams', () => {
    expect(evaluateLiveAcceptance(events().slice(0, 3), { expectedModel: 'model-x' }).ok).toBe(false);
    expect(evaluateLiveAcceptance([{ type: 'CONNECTED' }, { type: 'SYSTEM', message: 'still running' }], { expectedModel: 'model-x' }).ok).toBe(false);
    expect(evaluateLiveAcceptance([
      ...events().slice(0, 3),
      { type: 'RESULT', requestId: 'other', tier: 'API_EXTERNAL', message: 'wrong', metadata: { engineUsed: 'hermes:model-x' } },
    ], { expectedModel: 'model-x' }).ok).toBe(false);
  });

  it.each([
    ['local tier', { tier: 'OLLAMA_LOCAL' }],
    ['stub engine', { metadata: { engineUsed: 'hermes-stub' } }],
    ['empty result', { message: '' }],
    ['wrong non-empty result', { message: 'wrong but nonempty' }],
    ['whitespace-wrapped sentinel', { message: ' TORQCLAW_LIVE_OK ' }],
    ['wrong request', { requestId: 'req-2' }],
    ['missing engine', { metadata: {} }],
  ])('rejects %s', (_label, change) => {
    expect(evaluateLiveAcceptance(events(change), { expectedModel: 'model-x' }).ok).toBe(false);
  });

  it.each([
    [{ type: 'ERROR', requestId: 'req-1' }],
    [{ type: 'PENDING_APPROVAL', requestId: 'req-1' }],
    [{ type: 'TIER_SELECTED', requestId: 'other', tier: 'API_EXTERNAL' }],
    [{ type: 'TIER_SELECTED', requestId: 'req-1', tier: 'OLLAMA_LOCAL' }],
  ])('rejects wrong/error/pending/unrelated events', (badEvent) => {
    expect(evaluateLiveAcceptance([...events().slice(0, 2), badEvent, ...events().slice(2)], { expectedModel: 'model-x' }).ok).toBe(false);
  });
});
