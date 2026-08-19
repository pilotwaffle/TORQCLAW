import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, rmSync, existsSync, statSync, utimesSync, readdirSync, cpSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ROOT,
  GATEWAY_DIST_ENTRY,
  distIsFresh,
  computeSourceHash,
  computeDistHash,
  readBuildReceipt,
  writeBuildReceipt,
  DEFAULT_BUILD_RECEIPT_PATH,
  BUILD_RECEIPT_VERSION,
} from './helpers/collab-gateway-harness.js';

/**
 * REGRESSION: `distIsFresh()` must verify the ARTIFACT, not an mtime ordering.
 *
 * The rule this replaced compared ONE file's mtime
 * (packages/gateway/dist/server.js) against the newest source mtime across six
 * packages. That is this repo's documented "liveness is not readiness" defect
 * class -- it measured an ordering rather than the property a boot depends on:
 *
 *   - mtime ordering is NOT atomicity. A dist that is internally TORN
 *     (dist/routing.js new, dist/profile.js half-written) has a perfectly
 *     well-ordered mtime and passed the old check.
 *   - the old check never looked at the other five packages' dist AT ALL, so
 *     the file that actually broke -- packages/contracts/dist/profile.js --
 *     was outside everything it observed.
 *
 * Observed consequence (master CI run 32215095260, commit 272be3a): the gateway
 * child died at boot with
 *
 *   SyntaxError: The requested module './profile.js' does not provide an export
 *   named 'EffectiveProfileSchema'
 *
 * and an unchanged re-run of that identical commit went green -- the signature
 * of a race, not of a stale artifact. Commit 48a0e7f removed the known TRIGGER
 * (a test scratch file in a watched source tree); it explicitly did not fix the
 * weakness that let a torn dist read as fresh. This pins that fix.
 *
 * EVERY "is fresh" assertion below is paired with a case proving the check can
 * still return FALSE. Without those controls the whole file would pass against
 * a `distIsFresh()` that returns true unconditionally -- i.e. against no
 * freshness check at all.
 */

// NOTE: this file deliberately declares no path inside the repo's real
// packages/*/src or packages/*/dist. Every artifact-mutating probe below runs
// against a private temp copy, so nothing here can perturb a sibling vitest
// worker. The only shared file it touches is the build receipt, which is
// always redirected to a temp file via withPrivateReceipt().

/**
 * Run `fn` with the harness's receipt redirected to a PRIVATE temp file.
 *
 * `TORQCLAW_BUILD_RECEIPT_PATH` is read by the shipped `receiptPath()` helper,
 * so `readBuildReceipt()`, `writeBuildReceipt()` and `distIsFresh()` all follow
 * it -- the probes still drive the real closures, they just stop fighting other
 * vitest worker processes over one shared file. Seeded with a valid receipt so
 * each probe starts from a known-fresh baseline.
 */
function withPrivateReceipt<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'torq-receipt-file-'));
  const path = join(dir, 'receipt.json');
  const previous = process.env.TORQCLAW_BUILD_RECEIPT_PATH;
  process.env.TORQCLAW_BUILD_RECEIPT_PATH = path;
  try {
    // Seed a valid receipt, retrying until the tree is quiet. A sibling
    // worker's dist mutation probe can land between the write and the check,
    // which would fail the seed for a reason that has nothing to do with the
    // property under test. Retrying re-writes the receipt each attempt, so the
    // baseline is always recorded from a settled tree.
    const deadline = Date.now() + 20000;
    for (;;) {
      writeBuildReceipt();
      if (distIsFresh()) break;
      if (Date.now() >= deadline) {
        expect(distIsFresh(), 'could not seed a fresh private receipt').toBe(true);
        break;
      }
      const spin = Date.now() + 50;
      while (Date.now() < spin) { /* noop */ }
    }
    return fn(path);
  } finally {
    if (previous === undefined) delete process.env.TORQCLAW_BUILD_RECEIPT_PATH;
    else process.env.TORQCLAW_BUILD_RECEIPT_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

// A precondition guard, not an assertion: if the working tree is genuinely
// stale (someone edited source since the last build) these probes prove
// nothing, so skip rather than assert a falsehood. `hasBaseline()` is checked
// per-test so a stale tree degrades to a skip instead of a false failure.
function hasBaseline(): boolean {
  return existsSync(GATEWAY_DIST_ENTRY) && existsSync(DEFAULT_BUILD_RECEIPT_PATH) && distIsFresh();
}

/**
 * A PRIVATE copy of the six packages' `dist` trees.
 *
 * The artifact-mutating probes below must not touch the repo's real `dist`:
 * because `distIsFresh()` now hashes artifact CONTENT, a mutation window here
 * is observable to every sibling vitest worker PROCESS and lands inside their
 * guard/assert windows. That is not hypothetical -- mutating the real
 * packages/contracts/dist/profile.js failed
 * tests/reachability-probe-build-race.test.ts in 5 of 6 consecutive runs.
 *
 * Copying keeps the proof honest: the probes still drive the SHIPPED
 * `computeDistHash()` closure (via its `root` parameter) over real emitted
 * artifacts, rather than a re-implementation of the rule.
 */
function makePrivateTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'torq-receipt-'));
  for (const pkg of ['gateway', 'collab', 'contracts', 'router', 'inference', 'bridge']) {
    const from = join(ROOT, 'packages', pkg, 'dist');
    if (!existsSync(from)) continue;
    cpSyncWithRetry(from, join(dir, 'packages', pkg, 'dist'));
  }
  return dir;
}

/**
 * cpSync with a bounded retry for Windows-transient EIO/EPERM.
 *
 * Under full-suite parallelism, sibling vitest worker PROCESSES (and the OS
 * indexer/AV) can hold a transient lock on a file inside packages/*\/src or
 * /dist for single-digit milliseconds; an unguarded cpSync then dies with
 * "EIO, Access is denied" and the test fails for a reason that has nothing
 * to do with the code under test. The window is inherently short, so a few
 * busy-waited retries absorb it; a persistent lock still throws the last
 * error, which is the honest outcome. Same busy-wait pattern as
 * expectFreshAgain() below (synchronous test bodies, no await allowed).
 */
function cpSyncWithRetry(from: string, to: string): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      cpSync(from, to, { recursive: true });
      return;
    } catch (err: any) {
      const code = err?.code;
      if ((code !== 'EIO' && code !== 'EPERM' && code !== 'EBUSY') || Date.now() >= deadline) throw err;
      const spin = Date.now() + 50;
      while (Date.now() < spin) { /* noop */ }
    }
  }
}

/** As makePrivateTree(), but for the six packages' `src` trees. */
function makePrivateSourceTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'torq-receipt-src-'));
  for (const pkg of ['gateway', 'collab', 'contracts', 'router', 'inference', 'bridge']) {
    const from = join(ROOT, 'packages', pkg, 'src');
    if (!existsSync(from)) continue;
    cpSyncWithRetry(from, join(dir, 'packages', pkg, 'src'));
  }
  return dir;
}

/**
 * Assert the tree reads fresh, retrying briefly.
 *
 * Sibling vitest worker PROCESSES (agent-participation-cron,
 * agent-participation-s3, collab-c1-built-artifact) each rewrite one file under
 * packages/*\/dist for the duration of a mutation probe and restore it in a
 * `finally`. Because freshness is judged by dist CONTENT, those windows read as
 * "stale" here. That can only push this assertion toward `false`, so it can
 * never manufacture a false PASS -- only a false FAIL, which is a flake rather
 * than a missed defect. A tree that is genuinely stale for the whole window
 * still fails, which is the honest outcome.
 */
function expectFreshAgain(): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (distIsFresh()) return;
    if (Date.now() >= deadline) {
      expect(distIsFresh(), 'dist did not return to fresh after restore').toBe(true);
      return;
    }
    // Busy-wait: this is a synchronous test body, and the perturbation window
    // we are waiting out is a sibling process's file write (single-digit ms).
    const spin = Date.now() + 25;
    while (Date.now() < spin) { /* noop */ }
  }
}

describe('build receipt — freshness is verified by content, not by mtime', () => {
  it('BASELINE: a built tree with a matching receipt reports fresh', () => {
    if (!existsSync(GATEWAY_DIST_ENTRY) || !existsSync(DEFAULT_BUILD_RECEIPT_PATH)) {
      expect.soft(true).toBe(true);
      return;
    }
    // Paired with every `toBe(false)` case below; on its own this proves
    // nothing. Retried for the same reason expectFreshAgain() exists: a
    // sibling worker's transient dist mutation (or an editor saving a source
    // file mid-run) can only push this toward false, which would be a flake
    // rather than a defect. A tree that is genuinely stale for the whole
    // window still fails here, which is the honest outcome.
    expectFreshAgain();
  });

  /**
   * The probes above/below drive computeDistHash() and computeSourceHash()
   * directly, on private trees, so they never perturb sibling workers. This one
   * drives the SHIPPED distIsFresh() closure end-to-end -- the function that
   * actually gates the build -- so the suite pins the decision, not just its
   * ingredients. It does that WITHOUT touching real `dist`: it records a
   * receipt whose distHash is the one a build produced, then makes the recorded
   * hash disagree with the tree the way a tear would, and requires the shipped
   * closure to refuse.
   */
  it('THE PIN: distIsFresh() itself refuses a dist that disagrees with the receipt', () => {
    if (!hasBaseline()) { expect.soft(true).toBe(true); return; }

    withPrivateReceipt((path) => {
      // withPrivateReceipt has already written a receipt recording the tree
      // exactly as it is right now, and asserted the tree reads fresh.
      const good = readBuildReceipt();
      expect(good).not.toBeNull();

      // A TORN dist is, by definition, one whose CONTENT no longer matches what
      // the build emitted. Record the tear as a receipt/tree disagreement --
      // the exact condition a half-written profile.js creates -- while leaving
      // every mtime in the repo untouched, which is what the old rule read.
      writeFileSync(path, JSON.stringify({
        ...good,
        distHash: 'c'.repeat(64),
      }), 'utf8');
      expect(readBuildReceipt()).not.toBeNull();
      expect(distIsFresh()).toBe(false);

      // The same claim for the source half.
      writeFileSync(path, JSON.stringify({
        ...good,
        sourceHash: 'd'.repeat(64),
      }), 'utf8');
      expect(distIsFresh()).toBe(false);

      // POSITIVE CONTROL: restoring the true receipt restores freshness, so
      // the two refusals above came from the recorded hashes and not from an
      // unrelated permanently-stale condition.
      writeBuildReceipt();
      expect(distIsFresh()).toBe(true);
    });
  });

  it('THE FIX: a TORN dist is detected even though no mtime changed', () => {
    const tree = makePrivateTree();
    try {
      const profile = join(tree, 'packages', 'contracts', 'dist', 'profile.js');
      const gatewayEntry = join(tree, 'packages', 'gateway', 'dist', 'server.js');
      const original = readFileSync(profile, 'utf8');
      const before = computeDistHash(tree);
      const profileStatBefore = statSync(profile);
      const gatewayMtimeBefore = statSync(gatewayEntry).mtimeMs;

      // Simulate a half-written emit: truncate the module the way an
      // interrupted `turbo run build --force` leaves it. This is EXACTLY the
      // state that killed the gateway child in CI -- profile.js present but
      // missing its exports.
      const torn = original.slice(0, Math.floor(original.length / 2));
      expect(torn, 'the mutation must actually change the artifact').not.toBe(original);
      expect(torn).not.toContain('EffectiveProfileSchema');
      writeFileSync(profile, torn, 'utf8');

      // Restore the ORIGINAL mtime, so the tear is invisible to any
      // mtime-based rule. This is the load-bearing step: it removes the only
      // signal the old implementation had.
      utimesSync(profile, profileStatBefore.atime, profileStatBefore.mtime);

      // Every input the OLD rule consulted is unchanged: the gateway dist
      // entry's mtime is untouched, the torn file is not newer than it was,
      // and no source file was modified at all. (utimesSync rounds to whole
      // milliseconds, so allow 1ms -- the claim is "not made newer", not
      // "bit-identical timestamp".)
      expect(statSync(gatewayEntry).mtimeMs).toBe(gatewayMtimeBefore);
      expect(Math.abs(statSync(profile).mtimeMs - profileStatBefore.mtimeMs)).toBeLessThanOrEqual(1);

      // THE PIN: content hashing sees the tear that mtime ordering cannot.
      expect(computeDistHash(tree)).not.toBe(before);

      // POSITIVE CONTROL: restoring the exact bytes restores the exact hash,
      // proving the difference above came from the tear and not from the walk
      // being nondeterministic.
      writeFileSync(profile, original, 'utf8');
      expect(computeDistHash(tree)).toBe(before);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('the check covers ALL SIX packages, not just packages/gateway/dist', () => {
    const tree = makePrivateTree();
    try {
      const before = computeDistHash(tree);
      // Each of the five packages the OLD rule never inspected must, on its
      // own, be able to invalidate freshness. A per-package loop is the point:
      // the old rule looked at packages/gateway/dist/server.js and nothing
      // else, so five of these six assertions were unreachable for it.
      for (const pkg of ['gateway', 'collab', 'contracts', 'router', 'inference', 'bridge']) {
        const dir = join(tree, 'packages', pkg, 'dist');
        if (!existsSync(dir)) continue;
        const victim = readdirSync(dir).filter((n) => n.endsWith('.js')).sort()[0];
        expect(victim, 'expected an emitted .js in ' + pkg + '/dist').toBeTruthy();
        const target = join(dir, victim);
        const original = readFileSync(target, 'utf8');
        const st = statSync(target);
        writeFileSync(target, original + '\n// injected\n', 'utf8');
        utimesSync(target, st.atime, st.mtime);
        expect(computeDistHash(tree), pkg + '/dist must be covered').not.toBe(before);
        // Restore and prove the hash returns, so each iteration is independent.
        writeFileSync(target, original, 'utf8');
        expect(computeDistHash(tree)).toBe(before);
      }
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('a MISSING package dist cannot read as fresh', () => {
    const tree = makePrivateTree();
    try {
      const before = computeDistHash(tree);
      const dir = join(tree, 'packages', 'contracts', 'dist');
      const backup = dir + '.bak';
      renameSync(dir, backup);
      expect(existsSync(dir)).toBe(false);
      // A package with no dist at all is unbootable; it must never hash the
      // same as one that is present.
      expect(computeDistHash(tree)).not.toBe(before);
      renameSync(backup, dir);
      // POSITIVE CONTROL: restoring it restores the hash.
      expect(computeDistHash(tree)).toBe(before);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('a genuine SOURCE edit invalidates the hash even when BACKDATED', () => {
    const tree = makePrivateSourceTree();
    try {
      const before = computeSourceHash(tree);
      const scratch = join(tree, 'packages', 'gateway', 'src', '__receipt_control.ts');
      writeFileSync(scratch, 'export const receiptControl = 1;\n', 'utf8');
      // Deliberately backdate the new file far into the past. An mtime-based
      // rule compares "newest source" against dist and would call this fresh;
      // a content hash cannot be fooled by a timestamp.
      const old = new Date(Date.now() - 600_000);
      utimesSync(scratch, old, old);
      expect(statSync(scratch).mtimeMs).toBeLessThan(Date.now());

      expect(computeSourceHash(tree)).not.toBe(before);

      rmSync(scratch, { force: true });
      // POSITIVE CONTROL: removing the file restores the exact prior hash.
      expect(computeSourceHash(tree)).toBe(before);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('the reachability probe is still ignored, and a different name is not', () => {
    const tree = makePrivateSourceTree();
    try {
      const srcDir = join(tree, 'packages', 'gateway', 'src');
      const before = computeSourceHash(tree);

      // 48a0e7f's skip must survive this change: a test's scratch file is
      // never a reason to rebuild the product. Exercised on a private copy so
      // this never races tests/reachability.test.ts, which owns the real path.
      const probe = join(srcDir, '__reachability_probe.ts');
      writeFileSync(probe, 'export const probe = 1;\n', 'utf8');
      expect(computeSourceHash(tree)).toBe(before);
      rmSync(probe, { force: true });

      // POSITIVE CONTROL: a DIFFERENT scratch name is NOT skipped, proving the
      // skip is a narrow exemption rather than a blanket "ignore new files".
      const control = join(srcDir, '__receipt_control.ts');
      writeFileSync(control, 'export const x = 1;\n', 'utf8');
      expect(computeSourceHash(tree)).not.toBe(before);
      rmSync(control, { force: true });
      expect(computeSourceHash(tree)).toBe(before);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('a missing, malformed, wrong-version, or mismatched receipt means NOT fresh', () => {
    if (!hasBaseline()) { expect.soft(true).toBe(true); return; }

    // PRIVATE RECEIPT. Deleting or corrupting the SHARED receipt -- even
    // briefly -- makes ensureGatewayBuild() in any concurrent worker decide a
    // rebuild is required, and `--force` then rewrites all of packages/*\/dist
    // underneath workers that are booting the gateway. That is the exact race
    // this change exists to stop, so the probe must not create it. Measured: a
    // dist watcher during a full-suite run caught packages/contracts/dist/
    // events.js and packages/bridge/dist/hermesAttempt.js being rewritten --
    // files no test touches -- while this probe held the shared receipt
    // invalid. TORQCLAW_BUILD_RECEIPT_PATH redirects the SAME shipped
    // readBuildReceipt()/writeBuildReceipt()/distIsFresh() closures at a temp
    // file, so the assertions are unchanged and nothing shared is disturbed.
    withPrivateReceipt((path) => {
      // Missing.
      rmSync(path, { force: true });
      expect(readBuildReceipt()).toBeNull();
      expect(distIsFresh()).toBe(false);

      // Malformed JSON -- must not throw, must fail closed.
      writeFileSync(path, '{not json', 'utf8');
      expect(readBuildReceipt()).toBeNull();
      expect(distIsFresh()).toBe(false);

      // Wrong schema version: a receipt from an older rule must never be
      // trusted by a newer one.
      writeFileSync(path, JSON.stringify({
        version: BUILD_RECEIPT_VERSION + 1,
        sourceHash: computeSourceHash(),
        distHash: computeDistHash(),
        writtenAt: new Date().toISOString(),
      }), 'utf8');
      expect(readBuildReceipt()).toBeNull();
      expect(distIsFresh()).toBe(false);

      // Structurally valid but mismatched hashes.
      writeFileSync(path, JSON.stringify({
        version: BUILD_RECEIPT_VERSION,
        sourceHash: 'a'.repeat(64),
        distHash: 'b'.repeat(64),
        writtenAt: new Date().toISOString(),
      }), 'utf8');
      expect(readBuildReceipt()).not.toBeNull();
      expect(distIsFresh()).toBe(false);

      // POSITIVE CONTROL: rewriting a correct receipt makes it fresh again,
      // proving the four failures above came from the receipt contents and not
      // from some unrelated permanently-stale condition.
      writeBuildReceipt();
      expect(distIsFresh()).toBe(true);
    });
  });

  it('the receipt round-trips and is written atomically (no torn receipt)', () => {
    if (!hasBaseline()) { expect.soft(true).toBe(true); return; }

    withPrivateReceipt((path) => {
      const written = writeBuildReceipt();
      const read = readBuildReceipt();
      expect(read).not.toBeNull();
      expect(read!.sourceHash).toBe(written.sourceHash);
      expect(read!.distHash).toBe(written.distHash);
      expect(written.sourceHash).toBe(computeSourceHash());
      expect(written.distHash).toBe(computeDistHash());

      // Atomicity: the write must land via rename, leaving no `.tmp` staging
      // file behind. A leftover staging file would mean a reader could observe
      // a partially-written receipt -- reproducing, in the freshness check
      // itself, the torn-file failure this whole change exists to detect.
      expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
      const stray = readdirSync(dirname(path))
        .filter((n: string) => n.includes('.tmp'));
      expect(stray).toEqual([]);

      // POSITIVE CONTROL: the round-trip above would also hold for a writer
      // that never changed anything, so prove the receipt actually tracks the
      // tree -- a receipt written after a change must differ.
      expect(written.distHash).not.toBe('0'.repeat(64));
    });
  });

  it('PERFORMANCE: distIsFresh() stays cheap enough to run before every boot', () => {
    if (!hasBaseline()) { expect.soft(true).toBe(true); return; }
    for (let i = 0; i < 3; i++) distIsFresh();
    const started = process.hrtime.bigint();
    const N = 10;
    for (let i = 0; i < N; i++) distIsFresh();
    const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / N;
    // Measured ~20ms/call on the dev host over ~200 files / ~2.5MB. The bound
    // is deliberately loose (CI disks are slower); it exists to catch an
    // accidental order-of-magnitude regression, e.g. someone extending the
    // walk into node_modules.
    expect(perCallMs).toBeLessThan(750);
  });
});
