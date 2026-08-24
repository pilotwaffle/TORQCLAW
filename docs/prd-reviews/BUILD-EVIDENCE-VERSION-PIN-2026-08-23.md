# Build Evidence — G2A Correction 1: T-6 adapter version pin platform-honesty

## Objective

Make the T-6 adapter-version-pin test platform-honest (fail only when a claim of `endpoint_bound` cannot be backed up), eliminating the standing red CI on non-win32 runners.

## Scope

Single file: `tests/subscription-alias-binding.test.ts`. No source files touched. No git index/staging operations performed (per instruction — the index is pre-staged for a pending commit owned by the coordinator).

## Controlling invariant

A test must never silently pass when it cannot prove what it claims, and must never fail when the reason is "this platform structurally cannot run this check" rather than "the property under test is false." Preserved by construction: the new `decideAdapterPinOutcome` pure function has exactly three outputs (`fail-missing`, `assert-version`, `skip`), and every skip path emits an explicit, non-empty reason string via `ctx.skip(reason)` — there is no code path that returns/exits without either asserting, hard-failing, or emitting a named skip reason.

## What changed

`tests/subscription-alias-binding.test.ts`, inside `describe('T-6 adapter version pin (packet Item C-3)', ...)`:

1. Added a pure, test-file-local decision function `decideAdapterPinOutcome({ platform, resolvable, optIn })` returning `'fail-missing' | 'assert-version' | 'skip'`, implementing the four required semantics:
   - **Path 1** (`TORQCLAW_ACP_ADAPTER_PIN === '1'`): if not resolvable → `fail-missing` (hard fail, any platform, including linux — the pin claim must be provable or the test fails loud, never skips). If resolvable → `assert-version` (version mismatch still hard-fails via the caller's `expect(...).toBe(PINNED_VERSION)`).
   - **Path 2** (no opt-in, resolvable): `assert-version` — real assertion runs when the adapter is actually resolvable (win32 + global install present).
   - **Path 3/4** (no opt-in, not resolvable): `skip` — covers both "adapter genuinely absent on win32" and "resolver structurally cannot work on non-win32" uniformly; the caller supplies a platform-specific reason string to `ctx.skip(...)`.
2. Rewired the main test (`'the installed @agentclientprotocol/claude-agent-acp is exactly the version...'`) to read the real `process.env.TORQCLAW_ACP_ADAPTER_PIN`, call the real `resolveInstalledAdapterVersion()` (unchanged — still walks the real `resolveSpawnTarget` resolver, no invented second resolution mechanism), feed both plus real `process.platform` into `decideAdapterPinOutcome`, and branch: `expect.fail(...)` on `fail-missing`, `ctx.skip(reason)` on `skip` (test signature now takes `(ctx)` per Vitest 2.1.9's context-skip mechanism — confirmed available, `ctx.skip()` throws internally and Vitest reports the test as skipped with the given note, never a silent pass), or the pre-existing `expect(installedVersion).toBe(PINNED_VERSION)` assertion on `assert-version`.
3. Added a nested `describe('decideAdapterPinOutcome (pure decision function, all four paths pinned)', ...)` with 6 sub-tests driving the pure helper directly with injected `{platform, resolvable, optIn}`, covering all four required paths plus the opt-in/linux edge case, plus one RED-reproduction test that drives the collapsed pre-fix two-branch logic shape directly to prove the original defect.

No changes to `resolveSpawnTarget`, `resolveInstalledAdapterVersion`, or any source file — the helper and its wiring are entirely test-file-local, per the packet's explicit instruction ("extract a small pure helper in the test file for that (test-file-local, no src changes)").

## Files changed

- `E:\TorqClaw\tests\subscription-alias-binding.test.ts` (117 insertions, 10 deletions)
- `E:\TorqClaw\build-evidence.md` (this file, new)

## Tests added/changed

- Changed: the T-6 adapter-version-pin test's body (platform/opt-in-aware branching; signature now `(ctx)`).
- Added: 6 new `it(...)` cases under the new nested `describe`, exercising all four decision paths plus a RED reproduction of the pre-fix defect.
- Net test count in file: 12 → 19 (7 new `it` blocks; the `resolveInstalledAdapterVersion` function itself and its `PINNED_VERSION`/`OPT_IN_ENV` constants are unchanged/additive).

## Commands + actual results

1. `npx vitest run tests/subscription-alias-binding.test.ts` (baseline, before edit):
   ```
   ✓ tests/subscription-alias-binding.test.ts (12 tests) 25ms
   Test Files  1 passed (1)
        Tests  12 passed (12)
   ```

2. `npx vitest run tests/subscription-alias-binding.test.ts` (after edit):
   ```
   ✓ tests/subscription-alias-binding.test.ts (19 tests) 20ms
   Test Files  1 passed (1)
        Tests  19 passed (19)
   ```

3. `npx vitest run tests/subscription-alias-binding.test.ts --reporter=verbose` (after edit): all 19 individual test names printed with `✓`, zero `↓`/skip markers — confirmed the main T-6 test executed **path 2 for real** (adapter is resolvable + matches `0.64.2` on this win32 dev machine), not a skip. All 6 new pure-function sub-tests plus the RED-reproduction test passed.

4. `TORQCLAW_ACP_ADAPTER_PIN=1 npx vitest run tests/subscription-alias-binding.test.ts --reporter=verbose`: same 19/19 pass — confirmed **path 1 for real** (opt-in set, adapter resolvable, version matches → `assert-version` executes and passes on this machine).

5. Linux-equivalent proof (node one-liner driving the decision helper's exact logic, per the packet's requirement):
   ```
   platform=linux optIn=absent  -> skip          (expected: skip)
   platform=linux optIn=1       -> fail-missing  (expected: fail-missing)
   ```

6. RED reproduction (node one-liner driving the **pre-fix** collapsed two-branch logic — `installedVersion === null ? fail : assert` — with `resolvable:false`, simulating what `resolveSpawnTarget` unconditionally returns on any non-win32 platform per `safeSubscriptionProcess.ts:376`):
   ```
   RED (pre-fix, simulated linux CI): {"outcome":"FAIL","message":"Could not resolve the installed adapter version -- expect.fail() called"}
   ```
   This is the exact standing-red-CI shape the G2A defect report describes, reproduced by executing the pre-fix logic with the same `resolvable:false` fact GitHub CI (ubuntu-latest) would actually have.

7. `pnpm --filter @torqclaw/gateway typecheck`:
   ```
   > @torqclaw/gateway@0.1.0 typecheck
   > tsc --noEmit
   ```
   Exited cleanly, no errors emitted.

8. `git status --short tests/subscription-alias-binding.test.ts` / `git diff --stat`: confirmed only the one target file is modified (117 insertions, 10 deletions). No other file touched. No git add/reset/checkout/stash/commit executed at any point (per instruction — index left as pre-staged).

## Runtime/browser/a11y evidence

Not applicable — this is a Node/Vitest unit-test-only change with no UI, browser, or runtime server surface.

## Known limitations

- This machine (win32, adapter globally installed at `0.64.2`) can only exercise paths 1 and 2 for real; paths 3 and 4 (skip cases) are proven only via the extracted pure `decideAdapterPinOutcome` helper and the RED-reproduction test, not by an actual non-win32 CI run. This is intrinsic to the defect (the resolver cannot work on non-win32) and is exactly what the packet's four-path/pure-helper design accounts for.
- The `ctx.skip(reason)` live-skip branch in the main test is not exercised on this machine (adapter is present, so the main test always takes path 1 or path 2 here). Its correctness rests on: (a) Vitest 2.1.9's documented `ctx.skip(note)` API, and (b) the `decideAdapterPinOutcome` unit coverage of the `'skip'` return value. I did not find a way to force the real main test onto the skip branch without faking `resolveSpawnTarget`'s behavior, which would require touching source (out of scope) or monkeypatching module internals (would not reflect real resolver behavior). Flagging this as an assumption, not a verified live-skip execution.

## Deviations from the packet

None. All four required semantics implemented; pure helper is test-file-local; RED reproduction and Linux-equivalent proof both produced and quoted above; typecheck run as scoped (`@torqclaw/gateway` only, per instruction).

## Status

READY_FOR_INDEPENDENT_VERIFICATION
