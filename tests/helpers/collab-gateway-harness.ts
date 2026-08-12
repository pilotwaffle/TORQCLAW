import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const GATEWAY_DIST_ENTRY = join(ROOT, 'packages', 'gateway', 'dist', 'server.js');
export const DEFAULT_BUILD_TIMEOUT_MS = 180000;
export const BUILD_LOCK_GRACE_MS = 2000;
export const BUILD_LOCK_METADATA_FILENAME = 'metadata.json';
export const DEFAULT_BUILD_LOCK_DIRECTORY = join(ROOT, '.torqclaw-collab-build-lock');
const PRELOAD = fileURLToPath(new URL('./collab-gateway-test-preload.mjs', import.meta.url));

export type BuildLockMetadata = {
  pid: number;
  ownerToken: string;
  createdAt: string;
};

type BuildCommand = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type GatewayBuildOptions = {
  testTimeoutMs?: number;
  testLockDirectory?: string;
  testReceiptPath?: string;
  testBuildCommand?: BuildCommand;
};

type BuildLockHandle = {
  directory: string;
  metadata: BuildLockMetadata;
  acquiredAtMs: number;
};

let buildPromise: Promise<void> | null = null;

function metadataPath(directory: string): string {
  return join(directory, BUILD_LOCK_METADATA_FILENAME);
}

function parseMetadata(directory: string): BuildLockMetadata | null {
  try {
    const value = JSON.parse(readFileSync(metadataPath(directory), 'utf8')) as Partial<BuildLockMetadata>;
    if (
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.ownerToken !== 'string' ||
      value.ownerToken.length < 16 ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) return null;
    return { pid: value.pid, ownerToken: value.ownerToken, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

function pidState(pid: number): 'live' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'live';
    return 'unknown';
  }
}

function lockAgeMs(directory: string): number {
  try {
    const stats = statSync(directory);
    return Math.max(0, Date.now() - Math.min(stats.birthtimeMs || stats.ctimeMs, Date.now()));
  } catch {
    return 0;
  }
}

function lockDiagnostics(directory: string, startedAtMs: number): string {
  const metadata = parseMetadata(directory);
  const elapsedMs = Date.now() - startedAtMs;
  if (!metadata) {
    return 'lockPath=' + directory + '; owner=missing-or-malformed; lockAgeMs=' + lockAgeMs(directory) + '; elapsedMs=' + elapsedMs;
  }
  return 'lockPath=' + directory + '; ownerPid=' + metadata.pid + '; ownerToken=' + metadata.ownerToken + '; createdAt=' + metadata.createdAt + '; pidState=' + pidState(metadata.pid) + '; elapsedMs=' + elapsedMs;
}

/**
 * Reclaim an abandoned lock (dead owner, or a directory with no valid
 * metadata past the grace window).
 *
 * Reclaiming is inherently racy: several workers can decide to reclaim the
 * same abandoned lock at the same instant, and on Windows the losers see
 * EPERM/ENOENT from `unlink`/`rmdir` while the winner removes it. Losing
 * that race is BENIGN -- the directory is gone either way, and the caller
 * loops back to `mkdir`, which is the single point that decides ownership.
 * Propagating the error instead would fail an entire test file for what is
 * just contention, so it is swallowed and the caller retries.
 *
 * Any genuinely undeletable lock still surfaces: the caller's next mkdir
 * keeps failing with EEXIST until the acquisition deadline, and the timeout
 * error carries full lock diagnostics.
 */
function reclaimLock(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'ENOENT' && code !== 'EBUSY') throw error;
  }
}

async function acquireBuildLock(directory: string, deadlineMs: number): Promise<BuildLockHandle> {
  mkdirSync(dirname(directory), { recursive: true });
  const startedAtMs = Date.now();
  for (;;) {
    if (Date.now() >= deadlineMs) {
      throw new Error('Gateway build lock timeout=true; status=n/a; signal=n/a; ' + lockDiagnostics(directory, startedAtMs));
    }
    try {
      mkdirSync(directory);
      const metadata: BuildLockMetadata = {
        pid: process.pid,
        ownerToken: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      try {
        writeFileSync(metadataPath(directory), JSON.stringify(metadata), { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        let cleanupError: unknown = null;
        try { rmSync(directory, { recursive: true, force: true }); } catch (cleanup) { cleanupError = cleanup; }
        // Same cross-process race as above: another worker can be removing
        // this directory between our mkdir and our metadata write. That is
        // contention, not corruption -- retry rather than failing the whole
        // test file. Any other cause still throws with full diagnostics.
        const raceCode = (error as NodeJS.ErrnoException).code;
        if (raceCode === 'EPERM' || raceCode === 'ENOENT') {
          const remainingMs = Math.max(1, deadlineMs - Date.now());
          await sleep(Math.min(50, remainingMs));
          continue;
        }
        const detail = cleanupError ? '; cleanupError=' + String(cleanupError) : '';
        throw new Error('Build lock metadata creation failed; path=' + directory + '; cleanup attempted for newly-created directory' + detail + '; cause=' + String(error));
      }
      return { directory, metadata, acquiredAtMs: Date.now() };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows reports EPERM (not EEXIST) when a concurrent worker is
      // creating or removing this same directory at that instant, and the
      // gateway build lock is contended across vitest's per-file worker
      // PROCESSES, where the in-process `buildPromise` cache cannot help.
      // Treating EPERM as "someone else holds it, retry" is correct on both
      // platforms: the only way past this loop remains actually creating the
      // directory, so no two workers can believe they hold the lock.
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      const metadata = parseMetadata(directory);
      if (metadata && pidState(metadata.pid) === 'dead') {
        reclaimLock(directory);
        continue;
      }
      if (!metadata && lockAgeMs(directory) >= BUILD_LOCK_GRACE_MS) {
        reclaimLock(directory);
        continue;
      }
      const remainingMs = Math.max(1, deadlineMs - Date.now());
      await sleep(Math.min(50, remainingMs));
    }
  }
}

function releaseBuildLock(handle: BuildLockHandle): number {
  const current = parseMetadata(handle.directory);
  if (!current || current.ownerToken !== handle.metadata.ownerToken) {
    throw new Error('Build lock cleanup failed: owner token mismatch; ' + lockDiagnostics(handle.directory, handle.acquiredAtMs));
  }
  const releasedAtMs = Date.now();
  try {
    rmSync(handle.directory, { recursive: true, force: true });
  } catch (error) {
    throw new Error('Build lock cleanup failed: owner token matched but removal failed; path=' + handle.directory + '; cause=' + String(error));
  }
  return releasedAtMs;
}

function defaultBuildCommand(): BuildCommand {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('../../node_modules/turbo/bin/turbo', import.meta.url)), 'run', 'build', '--filter=@torqclaw/gateway...', '--force'],
    cwd: ROOT,
  };
}

function writeReceipt(path: string, handle: BuildLockHandle, buildStartedAtMs: number, buildFinishedAtMs: number, releasedAtMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    pid: handle.metadata.pid,
    ownerToken: handle.metadata.ownerToken,
    lockDirectory: handle.directory,
    lockAcquiredAt: new Date(handle.acquiredAtMs).toISOString(),
    buildStartedAt: new Date(buildStartedAtMs).toISOString(),
    buildFinishedAt: new Date(buildFinishedAtMs).toISOString(),
    lockReleasedAt: new Date(releasedAtMs).toISOString(),
  }), { encoding: 'utf8', flag: 'wx' });
}

async function runGatewayBuild(options: GatewayBuildOptions, deadlineMs: number, handle: BuildLockHandle): Promise<void> {
  const remainingMs = Math.max(1, deadlineMs - Date.now());
  const command = options.testBuildCommand ?? defaultBuildCommand();
  const result = spawnSync(command.command, command.args, {
    cwd: command.cwd ?? ROOT,
    env: command.env,
    stdio: options.testBuildCommand ? 'ignore' : 'inherit',
    windowsHide: true,
    shell: false,
    timeout: remainingMs,
    killSignal: 'SIGTERM',
  });
  const errorCode = result.error ? (result.error as NodeJS.ErrnoException).code ?? String(result.error) : 'none';
  const timedOut = errorCode === 'ETIMEDOUT' || (result.status === null && Date.now() >= deadlineMs);
  if (timedOut || result.error || result.status !== 0 || result.signal) {
    throw new Error('Gateway build failed; timeout=' + timedOut + '; status=' + String(result.status) + '; signal=' + String(result.signal) + '; spawnError=' + errorCode + '; ' + lockDiagnostics(handle.directory, handle.acquiredAtMs));
  }
}

/**
 * True when `dist` is already at least as new as every source file that
 * feeds it, i.e. a rebuild would be a no-op.
 *
 * WHY THIS EXISTS: the default build command runs turbo with `--force`, and
 * vitest runs each test FILE in its own worker process. With six files
 * calling `ensureGatewayBuild()`, the cross-process lock serialises six
 * full forced rebuilds; at ~45s each that blows the 180s acquisition
 * deadline and fails files for pure contention rather than for anything
 * about the code under test.
 *
 * Checking freshness BEFORE taking the lock lets the first worker build
 * once and the rest proceed immediately. This does NOT weaken the
 * built-artifact proof: the artifact is still built from current source by
 * whichever worker finds it stale, and every later worker has verified that
 * no source file is newer than what it is about to boot. A stale `dist` is
 * exactly what this check refuses to accept.
 */
function distIsFresh(): boolean {
  try {
    const distStat = statSync(GATEWAY_DIST_ENTRY);
    const newestSource = (dir: string): number => {
      let newest = 0;
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) newest = Math.max(newest, newestSource(full));
        else if (/\.(ts|tsx|json)$/.test(name)) newest = Math.max(newest, st.mtimeMs);
      }
      return newest;
    };
    // The gateway's own sources plus every workspace package it imports.
    let newest = 0;
    for (const pkg of ['gateway', 'collab', 'contracts', 'router', 'inference', 'bridge']) {
      const dir = join(ROOT, 'packages', pkg, 'src');
      if (existsSync(dir)) newest = Math.max(newest, newestSource(dir));
    }
    return newest > 0 && distStat.mtimeMs >= newest;
  } catch {
    // Never guess: if freshness cannot be established, build.
    return false;
  }
}

export async function ensureGatewayBuild(options: GatewayBuildOptions = {}): Promise<void> {
  const useSharedDefaultBuild = !options.testTimeoutMs && !options.testLockDirectory && !options.testReceiptPath && !options.testBuildCommand;
  // Fast path for the shared default build only. A test that supplies its
  // own build command/lock/receipt is testing the LOCK ITSELF and must keep
  // running the real acquire/build/release sequence.
  if (useSharedDefaultBuild && distIsFresh()) return;
  if (!useSharedDefaultBuild) {
    const timeoutMs = options.testTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const deadlineMs = Date.now() + timeoutMs;
    const lockDirectory = options.testLockDirectory ?? DEFAULT_BUILD_LOCK_DIRECTORY;
    const handle = await acquireBuildLock(lockDirectory, deadlineMs);
    let buildError: unknown = null;
    let buildStartedAtMs = Date.now();
    let buildFinishedAtMs = buildStartedAtMs;
    let releasedAtMs = buildFinishedAtMs;
    try {
      buildStartedAtMs = Date.now();
      await runGatewayBuild(options, deadlineMs, handle);
      buildFinishedAtMs = Date.now();
    } catch (error) {
      buildError = error;
      buildFinishedAtMs = Date.now();
    }
    try {
      releasedAtMs = releaseBuildLock(handle);
    } catch (cleanupError) {
      if (buildError) throw new Error(String(buildError) + '; ' + String(cleanupError));
      throw cleanupError;
    }
    if (buildError) throw buildError;
    if (options.testReceiptPath) writeReceipt(options.testReceiptPath, handle, buildStartedAtMs, buildFinishedAtMs, releasedAtMs);
    return;
  }
  if (!buildPromise) {
    buildPromise = (async () => {
      const timeoutMs = options.testTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
      const deadlineMs = Date.now() + timeoutMs;
      const lockDirectory = options.testLockDirectory ?? DEFAULT_BUILD_LOCK_DIRECTORY;
      const handle = await acquireBuildLock(lockDirectory, deadlineMs);
      let buildError: unknown = null;
      let buildStartedAtMs = Date.now();
      let buildFinishedAtMs = buildStartedAtMs;
      let releasedAtMs = buildFinishedAtMs;
      try {
        buildStartedAtMs = Date.now();
        await runGatewayBuild(options, deadlineMs, handle);
        buildFinishedAtMs = Date.now();
      } catch (error) {
        buildError = error;
        buildFinishedAtMs = Date.now();
      }
      try {
        releasedAtMs = releaseBuildLock(handle);
      } catch (cleanupError) {
        if (buildError) throw new Error(String(buildError) + '; ' + String(cleanupError));
        throw cleanupError;
      }
      if (buildError) throw buildError;
      if (options.testReceiptPath) writeReceipt(options.testReceiptPath, handle, buildStartedAtMs, buildFinishedAtMs, releasedAtMs);
    })();
  }
  try {
    await buildPromise;
  } catch (error) {
    buildPromise = null;
    throw error;
  }
}

export async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('OS did not allocate a gateway port');
  return port;
}

export type GatewayHandle = {
  child: ChildProcess;
  url: string;
  ready: Promise<void>;
  stderr: () => string;
  stop: () => Promise<void>;
};

export async function launchGateway(env: Record<string, string>, useTestPreload = true): Promise<GatewayHandle> {
  const port = await reservePort();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, TORQCLAW_PORT: String(port), TORQCLAW_HOST: '127.0.0.1' };
  delete childEnv.NODE_OPTIONS;
  if (useTestPreload) {
    childEnv.NODE_ENV = 'test';
    childEnv.NODE_OPTIONS = '--import=' + pathToFileURL(PRELOAD).href;
  }
  const child = spawn(process.execPath, [GATEWAY_DIST_ENTRY], {
    cwd: join(ROOT, 'packages', 'gateway'), env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout?.resume();
  const url = 'ws://127.0.0.1:' + port + '/ws';
  const ready = waitForWs(url, child).catch((error) => {
    throw new Error(String(error) + '\nGateway stderr:\n' + stderr);
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  };
  return { child, url, ready, stderr: () => stderr, stop };
}

async function waitForWs(url: string, child: ChildProcess, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('gateway exited before readiness (code=' + child.exitCode + ', signal=' + child.signalCode + ')');
    }
    if (Date.now() >= deadline) throw new Error('gateway readiness timed out at ' + url);
    const ok = await new Promise<boolean>((resolve) => {
      const probe = new WebSocket(url);
      const timer = setTimeout(() => { try { probe.terminate(); } catch { /* noop */ } resolve(false); }, 750);
      const done = (value: boolean) => { clearTimeout(timer); try { probe.close(); } catch { /* noop */ } resolve(value); };
      probe.once('open', () => done(true));
      probe.once('error', () => done(false));
    });
    if (ok) return;
    await sleep(150);
  }
}

export type WireResult = {
  ws: WebSocket;
  rawMessages: string[];
  frames: any[];
  close: { code: number; reason: string } | null;
};

export function connectAndCollect(url: string, connectFrame: unknown, timeoutMs = 10000): Promise<WireResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const rawMessages: string[] = [];
    const frames: any[] = [];
    let settled = false;
    let quietTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => finishError(new Error('timed out waiting for gateway wire result')), timeoutMs);
    const finish = (close: { code: number; reason: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (quietTimer) clearTimeout(quietTimer);
      resolve({ ws, rawMessages, frames, close });
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (quietTimer) clearTimeout(quietTimer);
      try { ws.terminate(); } catch { /* noop */ }
      reject(error);
    };
    ws.once('open', () => ws.send(JSON.stringify(connectFrame)));
    ws.on('message', (raw) => {
      const value = raw.toString();
      rawMessages.push(value);
      try { frames.push(JSON.parse(value)); } catch { finishError(new Error('invalid gateway JSON: ' + value)); return; }
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(null), 350);
    });
    ws.once('close', (code, reason) => finish({ code, reason: reason.toString() }));
    ws.once('error', (error) => { if (!settled) finishError(error instanceof Error ? error : new Error(String(error))); });
  });
}

export function lastFrame(result: WireResult): any {
  return result.frames[result.frames.length - 1];
}
export async function closeWire(result: WireResult): Promise<void> {
  if (result.ws.readyState === WebSocket.OPEN || result.ws.readyState === WebSocket.CONNECTING) {
    result.ws.close();
    await sleep(50);
  }
}
