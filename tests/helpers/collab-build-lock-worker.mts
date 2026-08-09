import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ensureGatewayBuild } from './collab-gateway-harness.ts';

const id = process.env.WORKER_ID ?? 'worker';
const mode = process.env.MODE ?? 'build';
const barrier = process.env.BARRIER_ROOT;
const lockRoot = process.env.LOCK_ROOT;
const receiptRoot = process.env.RECEIPT_ROOT;
const resultRoot = process.env.RESULT_ROOT;
const resultPath = process.env.RESULT_PATH ?? (resultRoot && join(resultRoot, id + '.json'));

async function waitForStart(): Promise<void> {
  if (!barrier) throw new Error('BARRIER_ROOT missing');
  mkdirSync(barrier, { recursive: true });
  writeFileSync(join(barrier, id + '.ready'), 'ready', 'utf8');
  const deadline = Date.now() + 30000;
  while (!existsSync(join(barrier, 'start'))) {
    if (Date.now() >= deadline) throw new Error('barrier timeout');
    await sleep(25);
  }
}

async function main(): Promise<void> {
  if (!lockRoot) throw new Error('LOCK_ROOT missing');
  if (mode === 'build') await waitForStart();
  const options = mode === 'timeout'
    ? {
        testLockDirectory: lockRoot,
        testTimeoutMs: 500,
        testBuildCommand: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] },
      }
    : {
        testLockDirectory: lockRoot,
        testReceiptPath: receiptRoot && join(receiptRoot, id + '.json'),
        testBuildCommand: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 500)'] },
      };
  try {
    await ensureGatewayBuild(options);
    if (resultPath) writeFileSync(resultPath, JSON.stringify({ ok: true }), 'utf8');
  } catch (error) {
    if (resultPath) writeFileSync(resultPath, JSON.stringify({ ok: false, error: String(error) }), 'utf8');
    if (mode !== 'timeout') process.exitCode = 1;
  }
}

await main();
