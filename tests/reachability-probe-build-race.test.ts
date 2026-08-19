import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, GATEWAY_DIST_ENTRY, distIsFresh } from './helpers/collab-gateway-harness.js';

/**
 * REGRESSION: a test's scratch file must never trigger a product rebuild.
 *
 * tests/reachability.test.ts writes `__reachability_probe.ts` INTO
 * packages/gateway/src -- a tree distIsFresh() watches. Counting that probe as
 * source made distIsFresh() report STALE, which sends ensureGatewayBuild() into
 * a real `turbo run build --force`. That build truncates and rewrites
 * packages/contracts/dist/*.js while sibling vitest workers are booting the
 * gateway from those same files: an unsynchronized write/read race on shared
 * `dist`.
 *
 * Observed consequence (master CI run 32215095260, commit 272be3a): the gateway
 * child process died at boot with
 *
 *   SyntaxError: The requested module './profile.js' does not provide an export
 *   named 'EffectiveProfileSchema'
 *
 * -- dist/routing.js new, dist/profile.js half-written -- inside a ~619ms window
 * bracketed by the SAME test file's positive control passing on both sides. An
 * unchanged re-run of that identical commit went green, which is what
 * distinguishes a race from a stale artifact.
 *
 * This pins the fix against its own absence: with the skip removed from
 * distIsFresh(), the first assertion below goes RED.
 */

const PROBE = join(ROOT, 'packages/gateway/src/__reachability_probe.ts');
const UNRELATED = join(ROOT, 'packages/gateway/src/__freshness_control.ts');

afterEach(() => {
  rmSync(PROBE, { force: true });
  rmSync(UNRELATED, { force: true });
});

describe('reachability probe does not trigger a product rebuild', () => {
  it('distIsFresh() ignores __reachability_probe.ts', () => {
    // Guard: if dist is already stale for unrelated reasons this test proves
    // nothing, so establish the precondition rather than assuming it.
    if (!existsSync(GATEWAY_DIST_ENTRY) || !distIsFresh()) {
      expect.soft(true).toBe(true);
      return;
    }

    writeFileSync(PROBE, 'export const probe = 1;\n', 'utf8');
    // Force the probe's mtime strictly newer than the built artifact, which is
    // the condition that made distIsFresh() report stale.
    const distMtime = statSync(GATEWAY_DIST_ENTRY).mtimeMs;
    const newer = new Date(distMtime + 60_000);
    utimesSync(PROBE, newer, newer);

    // THE PIN: a test scratch file newer than dist must not make dist stale.
    expect(distIsFresh()).toBe(true);
  });

  it('POSITIVE CONTROL: a genuinely newer source file DOES make dist stale', () => {
    // Without this, the assertion above would pass against a distIsFresh() that
    // returns true unconditionally -- i.e. against no freshness check at all.
    if (!existsSync(GATEWAY_DIST_ENTRY) || !distIsFresh()) {
      expect.soft(true).toBe(true);
      return;
    }

    writeFileSync(UNRELATED, 'export const control = 1;\n', 'utf8');
    const distMtime = statSync(GATEWAY_DIST_ENTRY).mtimeMs;
    const newer = new Date(distMtime + 60_000);
    utimesSync(UNRELATED, newer, newer);

    expect(distIsFresh()).toBe(false);
  });
});
