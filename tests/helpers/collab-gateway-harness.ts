import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// Every workspace package whose `src` feeds the gateway artifact, and whose
// `dist` the gateway loads at boot. `distIsFresh()` must speak for ALL of
// them: the mtime rule it replaced looked at exactly one file
// (packages/gateway/dist/server.js) and therefore could not see a stale or
// half-written packages/contracts/dist -- the artifact that actually killed
// the gateway child in master CI run 32215095260.
export const WATCHED_PACKAGES = ['gateway', 'collab', 'contracts', 'router', 'inference', 'bridge'] as const;
export const BUILD_RECEIPT_VERSION = 1;
export const DEFAULT_BUILD_RECEIPT_PATH = join(ROOT, '.torqclaw-build-receipt.json');

export type BuildReceipt = {
  version: number;
  sourceHash: string;
  distHash: string;
  writtenAt: string;
};

/**
 * `__reachability_probe.ts` is written INTO a watched source tree by
 * tests/reachability.test.ts and deleted moments later. Counting it as source
 * made an unrelated test's scratch file trigger a real
 * `turbo run build --force` -- which truncates and rewrites
 * packages/contracts/dist/*.js WHILE sibling vitest workers are booting the
 * gateway from those exact files. That is a write/read race on shared `dist`,
 * and it produced a red master CI run (32215095260, the gateway child dying on
 * `does not provide an export named EffectiveProfileSchema`) that went green on
 * an unchanged re-run. A test's own scratch file is never a reason to rebuild
 * the product.
 *
 * NOTE: only the reachability probe is skipped. `__freshness_control.ts` is
 * deliberately NOT skipped -- it is the positive control in
 * tests/reachability-probe-build-race.test.ts, which proves this check can
 * still return false. Skipping it would make that control vacuous.
 */
const SOURCE_SCRATCH_FILES = new Set(['__reachability_probe.ts']);

// Entries are path-qualified (relative to the package root, forward-slashed so
// the receipt is stable across platforms) because a bare basename cannot
// distinguish packages/gateway/src/a/x.ts from .../b/x.ts -- and a rename
// between the two must invalidate the receipt.
function hashTree(dir: string, relative: string, match: RegExp, skip: (name: string) => boolean, into: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (skip(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    const rel = relative ? relative + '/' + name : name;
    if (st.isDirectory()) hashTree(full, rel, match, skip, into);
    else if (match.test(name)) into.push(rel + ' ' + createHash('sha256').update(readFileSync(full)).digest('hex'));
  }
}

/**
 * Content hash over every watched SOURCE file across all six packages.
 *
 * Content, not mtime: mtime ordering answers "was A touched after B", which is
 * not the question. The question is "was this dist produced from exactly these
 * sources" -- and only content can answer that.
 */
// `root` defaults to the repo and exists so a test can run this EXACT function
// over a private copy of the package tree instead of mutating shared `dist`.
// Because `distIsFresh()` now hashes artifact CONTENT, a probe that rewrote a
// real `dist` file would be visible to every sibling vitest worker process and
// would surface as THEIR regression -- measured at a 5-in-6 failure rate
// against tests/reachability-probe-build-race.test.ts before this parameter
// existed. The proof stays honest: it drives the shipped closure, not a copy
// of the rule.
export function computeSourceHash(root: string = ROOT): string {
  const parts: string[] = [];
  for (const pkg of WATCHED_PACKAGES) {
    const dir = join(root, 'packages', pkg, 'src');
    if (!existsSync(dir)) continue;
    parts.push('#' + pkg);
    hashTree(
      dir,
      '',
      /\.(ts|tsx|json)$/,
      (name) => name === 'node_modules' || name === 'dist' || name === '.turbo' || SOURCE_SCRATCH_FILES.has(name),
      parts,
    );
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Content hash over every emitted `.js` file in all six packages' `dist`.
 *
 * This is the half the old rule never had. Hashing the CONTENT of each emitted
 * module is what makes a TORN dist visible: a half-written
 * packages/contracts/dist/profile.js hashes differently from the one the build
 * produced, even though nobody's mtime looks out of order.
 */
export function computeDistHash(root: string = ROOT): string {
  const parts: string[] = [];
  for (const pkg of WATCHED_PACKAGES) {
    const dir = join(root, 'packages', pkg, 'dist');
    // A missing dist is not "nothing to hash" -- it is a package that cannot
    // be booted. Record it distinctly so the receipt cannot match.
    if (!existsSync(dir)) { parts.push('#' + pkg + ' MISSING'); continue; }
    parts.push('#' + pkg);
    hashTree(dir, '', /\.js$/, (name) => name === 'node_modules' || name === '.turbo', parts);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function receiptPath(): string {
  return process.env.TORQCLAW_BUILD_RECEIPT_PATH || DEFAULT_BUILD_RECEIPT_PATH;
}

/**
 * Write the receipt ATOMICALLY: a sibling worker calling `distIsFresh()` must
 * never observe a half-written receipt. `renameSync` within the same directory
 * is atomic on both NTFS and POSIX, so readers see either the old receipt or
 * the new one -- never a torn one. (Writing the receipt in place would
 * reproduce, in the freshness check itself, the exact torn-file failure this
 * change exists to detect.)
 */
export function writeBuildReceipt(path: string = receiptPath()): BuildReceipt {
  const receipt: BuildReceipt = {
    version: BUILD_RECEIPT_VERSION,
    sourceHash: computeSourceHash(),
    distHash: computeDistHash(),
    writtenAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  const staging = path + '.' + process.pid + '.' + randomUUID() + '.tmp';
  writeFileSync(staging, JSON.stringify(receipt), 'utf8');
  try {
    renameSync(staging, path);
  } catch (error) {
    try { rmSync(staging, { force: true }); } catch { /* noop */ }
    throw error;
  }
  return receipt;
}

export function readBuildReceipt(path: string = receiptPath()): BuildReceipt | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildReceipt>;
    if (
      value.version !== BUILD_RECEIPT_VERSION ||
      typeof value.sourceHash !== 'string' || value.sourceHash.length !== 64 ||
      typeof value.distHash !== 'string' || value.distHash.length !== 64
    ) return null;
    return {
      version: value.version,
      sourceHash: value.sourceHash,
      distHash: value.distHash,
      writtenAt: typeof value.writtenAt === 'string' ? value.writtenAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * True when the artifacts on disk are exactly the ones a build produced from
 * exactly the sources now present -- i.e. a rebuild would be a no-op.
 *
 * WHY THIS EXISTS: the default build command runs turbo with `--force`, and
 * vitest runs each test FILE in its own worker process. With many files
 * calling `ensureGatewayBuild()`, the cross-process lock serialises many
 * full forced rebuilds; at ~45s each that blows the 180s acquisition
 * deadline and fails files for pure contention rather than for anything
 * about the code under test.
 *
 * WHY IT IS A RECEIPT AND NOT AN MTIME COMPARISON: the previous rule compared
 * ONE file's mtime (packages/gateway/dist/server.js) against the newest source
 * mtime. That is this repo's documented "liveness is not readiness" defect
 * class -- it measured an ordering, not the property that matters:
 *
 *   - mtime ordering is not atomicity. A dist that is internally TORN
 *     (dist/routing.js new, dist/profile.js half-written) has a perfectly
 *     well-ordered mtime and passed the old check. That exact state killed the
 *     gateway child at boot in master CI run 32215095260 on commit 272be3a,
 *     and an unchanged re-run went green -- the signature of a race, not of a
 *     stale artifact.
 *   - it never looked at the other five packages' dist AT ALL. The file that
 *     actually broke (packages/contracts/dist/profile.js) was outside
 *     everything the check observed.
 *
 * The receipt closes both: it pins the CONTENT of every source file and the
 * CONTENT of every emitted `.js` across all six packages, so "fresh" means
 * "these artifacts were built from these sources and nothing has touched them
 * since" -- which is the property the boot actually depends on.
 *
 * Checking freshness BEFORE taking the lock lets the first worker build once
 * and the rest proceed immediately. This does NOT weaken the built-artifact
 * proof: the artifact is still built from current source by whichever worker
 * finds it stale.
 */
// Exported ONLY so tests/reachability-probe-build-race.test.ts and
// tests/build-receipt-freshness.test.ts can drive this exact function rather
// than a re-implementation of it. A copy of the rule already contains the fix;
// the shipped closure is what has to be pinned.
export function distIsFresh(): boolean {
  try {
    // The gateway entry must exist regardless of what any receipt claims:
    // this is the file launchGateway() spawns.
    if (!existsSync(GATEWAY_DIST_ENTRY)) return false;
    const receipt = readBuildReceipt();
    // Missing or unparseable receipt => not fresh => build. Never guess.
    if (!receipt) return false;
    if (receipt.sourceHash !== computeSourceHash()) return false;
    if (receipt.distHash !== computeDistHash()) return false;
    return true;
  } catch {
    // Never guess: if freshness cannot be established, build.
    return false;
  }
}

/**
 * "Must I run a rebuild right now?" -- deliberately NARROWER than
 * `distIsFresh()`.
 *
 * `distIsFresh()` answers "are these artifacts exactly what a build produced
 * from exactly these sources", and its callers depend on that strict contract.
 * But the only condition that JUSTIFIES rebuilding is that the SOURCES have
 * moved. A dist-only mismatch is far more likely to be a sibling worker's
 * mutation probe mid-flight (agent-participation-cron, agent-participation-s3
 * and collab-c1-built-artifact each rewrite one dist file and restore it in a
 * `finally`), and rebuilding then is actively destructive: `--force` rewrites
 * every packages/*\/dist file while other workers are booting the gateway from
 * them.
 *
 * Fail-closed is preserved: a missing receipt, an unreadable one, a missing
 * gateway entry, or any source change all return true and build.
 */
function rebuildRequired(): boolean {
  try {
    if (!existsSync(GATEWAY_DIST_ENTRY)) return true;
    const receipt = readBuildReceipt();
    if (!receipt) return true;
    return receipt.sourceHash !== computeSourceHash();
  } catch {
    return true;
  }
}

export async function ensureGatewayBuild(options: GatewayBuildOptions = {}): Promise<void> {
  const useSharedDefaultBuild = !options.testTimeoutMs && !options.testLockDirectory && !options.testReceiptPath && !options.testBuildCommand;
  // Fast path for the shared default build only. A test that supplies its
  // own build command/lock/receipt is testing the LOCK ITSELF and must keep
  // running the real acquire/build/release sequence.
  if (useSharedDefaultBuild && !rebuildRequired()) return;
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
      // DOUBLE-CHECK UNDER THE LOCK. The freshness test before the lock is an
      // optimisation, not a decision: N workers can all observe "stale" in the
      // same instant, all queue here, and -- without this re-check -- each run
      // its own `turbo run build --force` in turn. Every one of those rebuilds
      // truncates and rewrites the shared packages/*/dist WHILE sibling workers
      // are booting the gateway from those exact files, which is precisely the
      // write/read race that produced the red CI run this change exists to
      // prevent. Observed here: a full-suite run rebuilt dist ~2 minutes after
      // a valid receipt was written, and a gateway child died on
      // `does not provide an export named 'ClientCommandSchema'`.
      //
      // Re-reading the receipt now is cheap (~20ms) and collapses the queue:
      // the first worker builds, and every worker behind it sees the receipt
      // the winner just wrote and skips its redundant rebuild.
      //
      // What justifies a REBUILD is specifically that the SOURCES no longer
      // match what produced the artifacts. A dist-only mismatch does not:
      // several suites here (agent-participation-cron, agent-participation-s3,
      // collab-c1-built-artifact) deliberately rewrite one file under
      // packages/*/dist for the duration of a mutation probe and restore it in
      // a `finally` -- and collab-c1 holds its mutation across an entire
      // gateway launch. Rebuilding in that window is the WORST possible
      // response: `turbo run build --force` truncates and rewrites all of
      // packages/*/dist while sibling workers are booting the gateway from
      // those files, which is the very write/read race this change exists to
      // stop. Measured directly: a dist watcher during a full-suite run logged
      // the three expected probe mutations and then packages/router/dist/
      // engine.js changing -- a file NO test touches, i.e. a real rebuild
      // firing because a sibling's probe made dist look stale.
      //
      // So: if the receipt's sourceHash still matches the tree and the gateway
      // entry is present, another worker's transient probe is the only thing
      // that can be different, and rebuilding would destroy more than it fixes.
      // A genuine source change still fails this test and still builds, which
      // is the fail-closed direction. `distIsFresh()` keeps the strict
      // source-AND-dist contract for its callers; this is deliberately the
      // narrower question "must I rebuild right now".
      if (!rebuildRequired()) {
        releaseBuildLock(handle);
        return;
      }
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
      // Record what this build produced, so sibling workers can verify
      // freshness by CONTENT instead of by mtime ordering. Written after the
      // lock is released and after dist is fully on disk, so the hashes
      // describe a settled tree. A failure to write the receipt must not fail
      // the build: the only consequence is that the next worker rebuilds --
      // the fail-closed direction.
      try { writeBuildReceipt(); } catch { /* fail-closed: next caller rebuilds */ }
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

export async function launchGateway(
  env: Record<string, string>,
  useTestPreload = true,
  additionalNodeOptions?: string,
): Promise<GatewayHandle> {
  const port = await reservePort();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, TORQCLAW_PORT: String(port), TORQCLAW_HOST: '127.0.0.1' };
  delete childEnv.NODE_OPTIONS;
  // Hermetic: this harness boots the gateway to test IDENTITY/connect semantics,
  // not failover. An ambient TORQCLAW_PROVIDER_FAILOVER_ENABLED=true would
  // otherwise route every booted gateway through the failover path and couple
  // these tests to failover behaviour. Default it OFF unless a caller
  // explicitly opts in via `env` (mirrors how spend-caps / skill-queue tests
  // pin their own flags rather than inheriting the operator env).
  if (!('TORQCLAW_PROVIDER_FAILOVER_ENABLED' in env)) {
    delete childEnv.TORQCLAW_PROVIDER_FAILOVER_ENABLED;
  }
  if (useTestPreload) {
    childEnv.NODE_ENV = 'test';
    childEnv.NODE_OPTIONS = '--import=' + pathToFileURL(PRELOAD).href;
  }
  if (additionalNodeOptions) {
    childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, additionalNodeOptions].filter(Boolean).join(' ');
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
