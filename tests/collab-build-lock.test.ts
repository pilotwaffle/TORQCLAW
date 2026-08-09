import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BUILD_LOCK_GRACE_MS,
  BUILD_LOCK_METADATA_FILENAME,
  DEFAULT_BUILD_LOCK_DIRECTORY,
  ensureGatewayBuild,
  type BuildLockMetadata,
} from './helpers/collab-gateway-harness.js';

const testRoots: string[] = [];
const QUICK_BUILD = { command: process.execPath, args: ['-e', ''] };
const WORKER = fileURLToPath(new URL('./helpers/collab-build-lock-worker.mts', import.meta.url));

function isolatedRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  testRoots.push(root);
  return root;
}
function lockPath(root: string): string { return join(root, 'lock'); }
function metadata(pid: number, ownerToken = randomUUID()): BuildLockMetadata {
  return { pid, ownerToken, createdAt: new Date().toISOString() };
}
function writeMetadata(directory: string, value: BuildLockMetadata): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, BUILD_LOCK_METADATA_FILENAME), JSON.stringify(value), 'utf8');
}
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + path);
    await sleep(25);
  }
}
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child exit timeout')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

afterEach(() => {
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('collab gateway build-lock correction', () => {
  it('reclaims a valid dead PID immediately', async () => {
    const root = isolatedRoot('torq-lock-dead-');
    const lock = lockPath(root);
    writeMetadata(lock, metadata(2147483647));
    const started = Date.now();
    await ensureGatewayBuild({ testLockDirectory: lock, testTimeoutMs: 5000, testBuildCommand: QUICK_BUILD });
    expect(Date.now() - started).toBeLessThan(BUILD_LOCK_GRACE_MS);
    expect(existsSync(lock)).toBe(false);
  });

  it('waits for missing metadata grace, then reclaims', async () => {
    const root = isolatedRoot('torq-lock-missing-');
    const lock = lockPath(root);
    mkdirSync(lock);
    const started = Date.now();
    await ensureGatewayBuild({ testLockDirectory: lock, testTimeoutMs: 10000, testBuildCommand: QUICK_BUILD });
    expect(Date.now() - started).toBeGreaterThanOrEqual(BUILD_LOCK_GRACE_MS - 100);
    expect(existsSync(lock)).toBe(false);
  });

  it('waits for malformed metadata grace, then reclaims', async () => {
    const root = isolatedRoot('torq-lock-malformed-');
    const lock = lockPath(root);
    mkdirSync(lock);
    writeFileSync(join(lock, BUILD_LOCK_METADATA_FILENAME), '{not-json', 'utf8');
    const started = Date.now();
    await ensureGatewayBuild({ testLockDirectory: lock, testTimeoutMs: 10000, testBuildCommand: QUICK_BUILD });
    expect(Date.now() - started).toBeGreaterThanOrEqual(BUILD_LOCK_GRACE_MS - 100);
    expect(existsSync(lock)).toBe(false);
  });

  it('never reclaims a valid live owner and reports bounded diagnostics', async () => {
    const root = isolatedRoot('torq-lock-live-');
    const lock = lockPath(root);
    writeMetadata(lock, metadata(process.pid));
    await expect(ensureGatewayBuild({ testLockDirectory: lock, testTimeoutMs: 500, testBuildCommand: QUICK_BUILD }))
      .rejects.toThrow(/timeout=true.*lockPath=.*ownerPid=.*elapsedMs=/);
    expect(existsSync(lock)).toBe(true);
  });

  it('serializes two barrier-synchronized OS workers with isolated TEMP/TMP and receipts', async () => {
    const root = isolatedRoot('torq-lock-workers-');
    const barrier = join(root, 'barrier');
    const receipts = join(root, 'receipts');
    const results = join(root, 'results');
    const lock = join(root, 'isolated-lock');
    mkdirSync(barrier);
    mkdirSync(receipts);
    mkdirSync(results);
    const envBase = {
      ...process.env,
      NODE_ENV: 'test',
      TEMP: root,
      TMP: root,
      LOCK_ROOT: lock,
      BARRIER_ROOT: barrier,
      RESULT_ROOT: results,
      RECEIPT_ROOT: receipts,
    };
    const children = ['a', 'b'].map((id) => spawn(process.execPath, ['--experimental-strip-types', WORKER], {
      env: { ...envBase, WORKER_ID: id, MODE: 'build' },
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    }));
    const started = Date.now();
    await Promise.all(['a', 'b'].map((id) => waitForFile(join(barrier, id + '.ready'), 30000)));
    writeFileSync(join(barrier, 'start'), 'go', 'utf8');
    const exits = await Promise.all(children.map((child) => waitForExit(child, 240000)));
    expect(Date.now() - started).toBeLessThan(240000);
    expect(exits.every((exit) => exit.code === 0 && exit.signal === null)).toBe(true);
    const receiptA = JSON.parse(readFileSync(join(receipts, 'a.json'), 'utf8'));
    const receiptB = JSON.parse(readFileSync(join(receipts, 'b.json'), 'utf8'));
    expect(receiptA.ownerToken).not.toBe(receiptB.ownerToken);
    expect(receiptA.lockDirectory).toBe(lock);
    expect(receiptB.lockDirectory).toBe(lock);
    const aAcquire = Date.parse(receiptA.lockAcquiredAt);
    const aRelease = Date.parse(receiptA.lockReleasedAt);
    const bAcquire = Date.parse(receiptB.lockAcquiredAt);
    const bRelease = Date.parse(receiptB.lockReleasedAt);
    expect(aRelease <= bAcquire || bRelease <= aAcquire).toBe(true);
    expect(JSON.parse(readFileSync(join(results, 'a.json'), 'utf8')).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(results, 'b.json'), 'utf8')).ok).toBe(true);
    expect(existsSync(lock)).toBe(false);    expect(DEFAULT_BUILD_LOCK_DIRECTORY.startsWith(tmpdir())).toBe(false);
  }, 240000);

  it('times out only its exact build worker while an unrelated sentinel survives', async () => {
    const root = isolatedRoot('torq-lock-timeout-');
    const lock = lockPath(root);
    const resultPath = join(root, 'timeout-result.json');
    const sentinelPath = join(root, 'sentinel');
    const timeoutChild = spawn(process.execPath, ['--experimental-strip-types', WORKER], {
      env: { ...process.env, NODE_ENV: 'test', MODE: 'timeout', LOCK_ROOT: lock, RESULT_PATH: resultPath },
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    const sentinelCode = "setTimeout(() => require('node:fs').writeFileSync(" + JSON.stringify(sentinelPath) + ", 'alive'), 1000)";
    const sentinel = spawn(process.execPath, ['-e', sentinelCode], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    const timeoutExit = await waitForExit(timeoutChild, 30000);
    const sentinelExit = await waitForExit(sentinel, 30000);
    expect(timeoutExit.code).toBe(0);
    expect(sentinelExit.code).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout=true/);
    expect(existsSync(sentinelPath)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});
