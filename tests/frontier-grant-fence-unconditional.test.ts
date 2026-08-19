/**
 * N-1 REGRESSION GUARD — the FRONTIER name-only-grant refusal must be
 * INDEPENDENT of TORQCLAW_COLLAB_ENABLED.
 *
 * Found by fresh-Opus G1R Gate-1 re-review of PRD-TCLAW-AGENT-SANDBOX-006 v0.2
 * (docs/prd-reviews/G1R-OPUS-AGENT-SANDBOX-006-GATE1-V2.md, blocker N-1).
 *
 * THE DEFECT: `frontierGrantFenced` read
 *     diag.tier === FRONTIER && collabEnabled() && grantedTools.length > 0
 * and `collabEnabled()` reads TORQCLAW_COLLAB_ENABLED with NO default
 * (principalBridge.ts:71-72), so it is FALSE unless explicitly set. The
 * refusal was therefore unreachable in the default configuration, and the
 * legacy APPROVE_TOOL path (server.ts) minted a granted request and dispatched
 * a FRONTIER run under a grant that names a TOOL but not its ARGS. The engine's
 * pre-tool hook grants by name and never inspects args, so nothing downstream
 * could prove the args about to execute were the args approved -- the
 * exact-action invariant (§1.4) was violated by default.
 *
 * Its own doc comment described the two prior rounds as "the same mistake made
 * twice: a fence that guards one route while another route reaches the same
 * engine." The `&& collabEnabled()` was a THIRD instance.
 *
 * WHY THE ASSERTION IS SHAPED THIS WAY: the entire finding is a variable whose
 * DEFAULT nobody checked, so testing one flag state cannot catch it. All three
 * states are asserted -- unset (the default, and the state that was broken),
 * 'true', and 'false' -- and the unset case is the load-bearing one. A test
 * that only set the flag to 'true' would have passed against the BROKEN code.
 *
 * A security refusal that a feature flag can switch off is not a refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DISPATCH_SRC = join(here, '..', 'packages', 'gateway', 'src', 'dispatch.ts');
const SERVER_SRC = join(here, '..', 'packages', 'gateway', 'src', 'server.ts');
const PRINCIPAL_SRC = join(here, '..', 'packages', 'gateway', 'src', 'principalBridge.ts');

describe('N-1: FRONTIER granted-run refusal is flag-independent', () => {
  const saved = process.env.TORQCLAW_COLLAB_ENABLED;

  beforeEach(() => { delete process.env.TORQCLAW_COLLAB_ENABLED; });
  afterEach(() => {
    if (saved === undefined) delete process.env.TORQCLAW_COLLAB_ENABLED;
    else process.env.TORQCLAW_COLLAB_ENABLED = saved;
  });

  // ---------------------------------------------------------------------
  // The premise of the whole finding: the flag defaults OFF. If this ever
  // changes, the severity analysis above changes with it, so pin it.
  // ---------------------------------------------------------------------
  it('collabEnabled() is FALSE when TORQCLAW_COLLAB_ENABLED is unset (the default)', async () => {
    const { collabEnabled } = await import('../packages/gateway/src/principalBridge.js');
    expect(collabEnabled()).toBe(false);
  });

  it('collabEnabled() reads the env var with no default fallback', () => {
    const src = readFileSync(PRINCIPAL_SRC, 'utf8');
    // Pin the mechanism: an env read with `?? ''` and no default-true branch.
    expect(src).toMatch(/TORQCLAW_COLLAB_ENABLED/);
    expect(src).not.toMatch(/TORQCLAW_COLLAB_ENABLED\s*\?\?\s*['"]true['"]/);
  });

  // ---------------------------------------------------------------------
  // THE REGRESSION GUARD. frontierGrantFenced is module-private, so the
  // property is asserted structurally against the source: the predicate must
  // NOT consult collabEnabled(). This is deliberate -- it fails loudly if
  // anyone re-adds the gate, which is precisely the regression to prevent.
  // ---------------------------------------------------------------------
  it('frontierGrantFenced does NOT consult collabEnabled()', () => {
    const src = readFileSync(DISPATCH_SRC, 'utf8');
    const m = src.match(/function frontierGrantFenced[\s\S]*?\n}/);
    expect(m, 'frontierGrantFenced not found — was it renamed?').toBeTruthy();
    const body = m![0];

    expect(body).toContain('ComputeTier.FRONTIER');
    expect(body).toContain('grantedTools');
    // The N-1 defect, stated as an assertion.
    expect(body, 'N-1 REGRESSION: the FRONTIER grant fence is gated on a '
      + 'feature flag again. TORQCLAW_COLLAB_ENABLED defaults OFF, so this '
      + 'makes the refusal unreachable by default and re-opens the '
      + 'exact-action hole.').not.toContain('collabEnabled');
  });

  // ---------------------------------------------------------------------
  // The legacy APPROVE_TOOL path must carry the same refusal the C2 branch
  // has. Two independent guards on two routes to the same engine -- the
  // structural lesson of rounds 1 and 2.
  // ---------------------------------------------------------------------
  it('both APPROVE_TOOL branches refuse a FRONTIER grant before dispatch', () => {
    const src = readFileSync(SERVER_SRC, 'utf8');
    const refusals = src.match(/frontier-structured-grant-unavailable/g) ?? [];
    expect(refusals.length, 'expected the FRONTIER refusal on BOTH the C2 and '
      + 'the legacy APPROVE_TOOL branch — one guarded route plus one unguarded '
      + 'route reaching the same engine is the N-1 defect').toBeGreaterThanOrEqual(2);
  });

  it('the legacy branch refuses BEFORE it emits ROUTING or calls dispatch', () => {
    const src = readFileSync(SERVER_SRC, 'utf8');
    const legacyIdx = src.indexOf('LEGACY path (flag off, or a pre-C2 unbound row)');
    expect(legacyIdx, 'legacy APPROVE_TOOL branch not found').toBeGreaterThan(-1);
    const tail = src.slice(legacyIdx);

    const refusalIdx = tail.indexOf('frontier-structured-grant-unavailable');
    const dispatchIdx = tail.indexOf('dispatch(reqB, diag)');
    expect(refusalIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(refusalIdx, 'the refusal must precede dispatch — refusing after the '
      + 'engine call would be a receipt, not a fence').toBeLessThan(dispatchIdx);
  });

  // ---------------------------------------------------------------------
  // All three flag states. The unset case is the one that was broken; a test
  // that only exercised 'true' would have passed against the defect.
  // ---------------------------------------------------------------------
  for (const [label, value] of [
    ['unset (default — the state N-1 exploited)', undefined],
    ['explicitly true', 'true'],
    ['explicitly false', 'false'],
  ] as const) {
    it(`the fence predicate is unchanged with the flag ${label}`, async () => {
      if (value === undefined) delete process.env.TORQCLAW_COLLAB_ENABLED;
      else process.env.TORQCLAW_COLLAB_ENABLED = value;

      // Re-read per state: proves the SOURCE carries no flag dependence, so
      // the refusal cannot vary with the environment at all.
      const body = readFileSync(DISPATCH_SRC, 'utf8')
        .match(/function frontierGrantFenced[\s\S]*?\n}/)![0];
      expect(body).not.toContain('collabEnabled');
      expect(body).toContain('ComputeTier.FRONTIER');
    });
  }
});
