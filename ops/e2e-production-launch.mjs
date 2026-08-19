import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { buildLauncherConfig } from './launcher-config.mjs';
import { defaultPortProbe, doctorPassed, runDoctor } from './doctor-core.mjs';
import { stopProcessTree } from './process-tree.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const TEST_LOG_TAIL_LIMIT = 16 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function boundedLogTail(value, limit = TEST_LOG_TAIL_LIMIT) {
  return String(value ?? '').slice(-limit);
}

export function redactLogTail(value, secrets = []) {
  return secrets.filter(Boolean).reduce(
    (output, secret) => output.split(String(secret)).join('[REDACTED]'),
    String(value ?? ''),
  );
}

export function sanitizeLogTail(value, secrets = [], limit = TEST_LOG_TAIL_LIMIT) {
  return redactLogTail(boundedLogTail(value, limit), secrets);
}

export function formatFailureTail(stdout, stderr, secrets = []) {
  return `\nstdout tail:\n${sanitizeLogTail(stdout, secrets)}\nstderr tail:\n${sanitizeLogTail(stderr, secrets)}`;
}

export function createTailBuffer(limit = TEST_LOG_TAIL_LIMIT) {
  let value = '';
  return {
    append(chunk) { value = boundedLogTail(value + String(chunk ?? ''), limit); },
    value() { return value; },
  };
}

export function sanitizeInheritedEnv(baseEnv, {
  dataDir,
  consolePort,
  enginePort,
  gatewayPort,
} = {}) {
  const clean = Object.fromEntries(Object.entries(baseEnv ?? {}).filter(([key]) => {
    const normalizedKey = key.toUpperCase();
    return !normalizedKey.startsWith('TORQCLAW_')
      && !normalizedKey.startsWith('HERMES_')
      && !normalizedKey.startsWith('NEXT_PUBLIC_');
  }));
  Object.assign(clean, {
    TORQCLAW_ENV_FILE_PRESENT: '1',
    TORQCLAW_NO_BROWSER: '1',
    TORQCLAW_DATA_DIR: dataDir,
    // The surface-credential connect path requires the collab flag; the
    // e2e bootstraps a real operator credential into `dataDir` (below) and
    // authenticates with it, matching the production contract
    // (launcher-config.mjs's requireProductionTokens: the static shared
    // TORQCLAW_GATEWAY_TOKEN root token is FORBIDDEN in production and is
    // deliberately NOT injected here anymore).
    TORQCLAW_COLLAB_ENABLED: '1',
    NEXT_PUBLIC_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/ws`,
    TORQCLAW_HOST: '127.0.0.1',
    HERMES_BIND_HOST: '127.0.0.1',
    TORQCLAW_PORT: String(gatewayPort),
    HERMES_PORT: String(enginePort),
    TORQCLAW_CONSOLE_PORT: String(consolePort),
    HERMES_STUB_DELAY_S: '0.05',
  });
  return clean;
}

export function isVerifiedTempDir(dataDir, tempRoot = os.tmpdir()) {
  const resolved = path.resolve(String(dataDir ?? ''));
  const root = path.resolve(tempRoot);
  const name = path.basename(resolved);
  return path.dirname(resolved) === root && name.startsWith('torqclaw-g1r-') && name.length > 'torqclaw-g1r-'.length;
}

export async function removeVerifiedTempDir(dataDir, tempRoot = os.tmpdir(), rmImpl = rm) {
  if (!isVerifiedTempDir(dataDir, tempRoot)) throw new Error('refusing to remove unverified e2e temp directory');
  await rmImpl(dataDir, { recursive: true, force: true });
}

export async function waitForRuntime(config, env, child, {
  root = ROOT,
  stdoutTail = '',
  stderrTail = '',
  credential = '',
  timeoutMs = 120_000,
  sleepImpl = sleep,
  runDoctorImpl = runDoctor,
} = {}) {
  const exitNotice = child && typeof child.once === 'function'
    ? new Promise((resolve) => {
      if (child.exitCode !== null) resolve({ code: child.exitCode, signal: null });
      else child.once('exit', (code, signal) => resolve({ code, signal }));
    })
    : new Promise(() => {});
  const failure = (message) => new Error(`${message}${formatFailureTail(
    typeof stdoutTail === 'function' ? stdoutTail() : stdoutTail,
    typeof stderrTail === 'function' ? stderrTail() : stderrTail,
    [credential],
  )}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      runDoctorImpl({ mode: 'runtime', production: true, root, env }).then((records) => ({ records })),
      exitNotice.then((exit) => ({ exit })),
    ]);
    if (outcome.exit) throw failure(`production launcher exited before readiness (${outcome.exit.code ?? 'null'}/${outcome.exit.signal ?? 'none'})`);
    if (doctorPassed(outcome.records)) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      const waited = await Promise.race([
        sleepImpl(Math.min(250, remaining)).then(() => null),
        exitNotice.then((exit) => exit),
      ]);
      if (waited) throw failure(`production launcher exited before readiness (${waited.code ?? 'null'}/${waited.signal ?? 'none'})`);
    }
  }
  throw failure('production runtime did not become ready');
}

/** Mint a REAL operator credential into the throwaway dataDir via the
 *  production bootstrap script (ops/bootstrap-operator.mjs), then read it
 *  back from the single-use token file it writes. This is the production
 *  auth contract exercised for real: per-principal surface credential +
 *  FileSecretStore pepper, never a static shared root token (forbidden in
 *  production by launcher-config.mjs's requireProductionTokens). */
function bootstrapOperatorCredential(root, env, dataDir) {
  const result = spawnSync(process.execPath, ['ops/bootstrap-operator.mjs', '--display-name', 'E2E Operator'], {
    cwd: root, env, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`operator bootstrap failed (exit ${result.status}): ${String(result.stderr ?? '').slice(-2048)}`);
  }
  const tokenFile = path.join(dataDir, 'operator-credential.token');
  const credential = readFileSync(tokenFile, 'utf8').trim();
  if (!credential) throw new Error('operator bootstrap produced no credential file');
  // The bootstrap script tells the operator to delete this single-use file
  // once the token is copied; the e2e has consumed it into memory, so delete
  // it now rather than leaving a live credential on disk (the whole dataDir
  // is removed at the end regardless).
  rmSync(tokenFile, { force: true });
  return credential;
}

async function exerciseGateway(config, credential) {
  const socket = new WebSocket(config.nextPublicGatewayUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('production websocket timed out')), 30_000);
    let connected = false;
    let requestId = null;
    let result = null;
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    socket.on('open', () => socket.send(JSON.stringify({
      expectedRole: 'operator',
      clientInfo: { name: 'torqclaw-production-e2e', version: '1.0.0' },
      auth: { kind: 'surface', credential },
    })));
    socket.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { fail('production e2e received malformed event'); return; }
      if (settled) return;
      if (event.type === 'ERROR' || event.type === 'PENDING_APPROVAL') {
        fail(`production e2e received ${event.type}`);
        return;
      }
      if (event.type === 'CONNECTED') {
        if (connected) return fail('production e2e received multiple CONNECTED events');
        connected = true;
        socket.send(JSON.stringify({
          action: 'SUBMIT_PROMPT',
          prompt: 'Research MCP gateway tool namespacing and compare the options.',
          sensitive: false, urgent: false, attachmentIds: [],
          useMemory: false, executionMode: 'CLOUD_OK', maxCostUsd: 0.25,
        }));
        return;
      }
      if (event.type === 'TIER_SELECTED') {
        if (event.tier !== 'API_EXTERNAL' || !event.requestId) return fail('production e2e route was not correlated FRONTIER');
        if (requestId && event.requestId !== requestId) return fail('production e2e received unrelated route');
        requestId = event.requestId;
        return;
      }
      if (event.type === 'RESULT') {
        if (!requestId || event.requestId !== requestId || event.tier !== 'API_EXTERNAL' || !String(event.message ?? '').trim()) {
          return fail('production e2e RESULT correlation failed');
        }
        if (result) return fail('production e2e received multiple RESULT terminals');
        result = event;
        return;
      }
      if (event.type === 'SYSTEM' && event.metadata?.receipt) {
        if (!result) return fail('production e2e receipt arrived before RESULT');
        if (event.requestId !== requestId || event.metadata.receipt.taskId !== requestId) {
          return fail('production e2e receipt correlation failed');
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
    socket.on('error', () => fail('production websocket failed'));
    socket.on('close', () => { if (!settled) fail('production websocket closed before receipt'); });
  }).finally(() => { try { socket.close(); } catch { /* already closed */ } });
}

export async function reserveLoopbackPorts(count = 3, createServerImpl = createServer) {
  const servers = [];
  const ports = [];
  const release = async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })));
  };
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServerImpl();
      servers.push(server);
      const port = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
          server.removeListener('error', reject);
          const address = server.address();
          if (!address || typeof address === 'string') reject(new Error('failed to reserve a loopback test port'));
          else resolve(address.port);
        });
      });
      ports.push(port);
    }
    return { ports, release };
  } catch (error) {
    await release();
    throw error;
  }
}

async function verifyPortsReleased(config, sleepImpl) {
  for (const [port, host] of [[config.enginePort, config.engineHost], [config.gatewayPort, config.gatewayHost], [config.consolePort, '127.0.0.1']]) {
    let released = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      released = await defaultPortProbe(port, host);
      if (released) break;
      await sleepImpl(250);
    }
    if (!released) throw new Error('production port was not released');
  }
}

export async function runProductionE2E({
  root = ROOT,
  baseEnv = process.env,
  spawnImpl = spawn,
  sleepImpl = sleep,
  mkdtempImpl = mkdtemp,
  rmImpl = rm,
  tempRoot = os.tmpdir(),
} = {}) {
  let dataDir;
  let child;
  let config;
  let stopped = false;
  let stdoutTail;
  let stderrTail;
  let portReservation;
  try {
    dataDir = await mkdtempImpl(path.join(tempRoot, 'torqclaw-g1r-'));
    portReservation = await reserveLoopbackPorts(3);
    const [consolePort, enginePort, gatewayPort] = portReservation.ports;
    const env = sanitizeInheritedEnv(baseEnv, {
      dataDir, consolePort, enginePort, gatewayPort,
    });
    config = buildLauncherConfig(env, { production: true });
    const credential = bootstrapOperatorCredential(root, env, dataDir);
    stdoutTail = createTailBuffer();
    stderrTail = createTailBuffer();
    await portReservation.release();
    portReservation = undefined;
    child = spawnImpl(process.execPath, ['ops/dev-up.mjs', '--production'], {
      cwd: root, env, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stdout?.on('data', (chunk) => stdoutTail.append(chunk));
    child.stderr?.on('data', (chunk) => stderrTail.append(chunk));
    await waitForRuntime(config, env, child, {
      root, stdoutTail: () => stdoutTail.value(), stderrTail: () => stderrTail.value(), credential, sleepImpl,
    });
    await exerciseGateway(config, credential);
  } finally {
    let processStopped = !child?.pid;
    let portsReleased = !config;
    let cleanupError;
    if (portReservation) {
      try { await portReservation.release(); } catch (error) { cleanupError = error; }
    }
    try {
      if (child?.pid && !stopped) {
        stopped = await stopProcessTree(child.pid, {
          platform: process.platform,
          timeoutMs: 15_000,
          isAlive: () => child.exitCode === null,
        });
      }
      processStopped = stopped || !child?.pid;
      if (!processStopped) throw new Error('production launcher process tree did not stop');
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (config) await verifyPortsReleased(config, sleepImpl);
      portsReleased = true;
    } catch (error) {
      cleanupError ??= error;
    }
    if (dataDir && processStopped && portsReleased) {
      try { await removeVerifiedTempDir(dataDir, tempRoot, rmImpl); } catch (error) { cleanupError ??= error; }
    } else if (dataDir) {
      cleanupError ??= new Error('refusing to remove test data before process and ports stop');
    }
    if (cleanupError) throw cleanupError;
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runProductionE2E();
    process.stdout.write('PRODUCTION E2E PASS\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'production e2e failed'}\n`);
    process.exitCode = 1;
  }
}
