# VERIFICATION — T-TCLAW-LOCAL-LANE-01-S2

## Pin / branch / commit

Pin: `fb42108`. Branch: `fix/tclaw-local-lane-01-slice-2`.
Commit SHA: resolve the containing commit with `git log -1 --format=%H -- docs/VERIFICATION-TCLAW-LOCAL-LANE-01-S2.md`.
Exact final SHA: external `E:/TORQ-CONSOLE-t3runner-s2/.torq/v5/artifacts/02_build/build_result.md` (see evidence-format interpretation below).

## Defect and fix

The manual preview previously raced the automatic estimate by sending a second PREVIEW_ROUTE into the gateway single-flight latch.
The new branch adopts an armed pending or resolved estimate, resolves an existing frame immediately, and lets dropped estimates fall through to a fresh send.
The estimate effect now disarms the old nonce whenever a replacement send fails, preventing adoption for stale controls.

## Tests added

| Test | Class | Pin | Fixed |
|---|---|---|---|
| `simulate_adopts_in_flight_estimate_without_second_command` | DEFECT | FAIL | PASS |
| `simulate_sends_when_no_estimate_armed` | PRESERVATION | PASS | PASS |
| `simulate_after_draft_change_sends_fresh_command` | DEFECT | FAIL | PASS |
| `simulate_resends_when_armed_estimate_was_dropped` | DEFECT | FAIL | PASS |
| `simulate_after_controls_change_with_failed_reestimate_sends_fresh` | PRESERVATION | PASS | PASS |

Red at pin: `pnpm vitest run tests/torq-terminal-simulate-adopt.test.tsx`, exit 1.
```text
Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)
   Duration  1.81s (transform 236ms, setup 0ms, collect 608ms, tests 348ms, environment 617ms, prepare 70ms)
```

All three failures were `expected [ …(2) ] to have a length of 1 but got 2`, at lines 123, 193 and 260; the two preservation tests passed.

## Baseline and final commands

All commands run in `E:/TORQCLAW-lane01-s2`. Complete verbatim logs are in the external harness `02_build/s2-evidence/`.

### baseline-test

`pnpm test` — exit 1.

```text
Tasks:    6 successful, 6 total
Cached:    0 cached, 6 total
 Test Files  1 failed | 199 passed (200)
      Tests  1 failed | 2768 passed | 1 skipped (2770)
   Duration  301.29s (transform 4.50s, setup 0ms, collect 38.18s, tests 497.37s, environment 19.33s, prepare 15.20s)
```

### baseline-auth-rerun

`pnpm vitest run tests/auth-v2-phase2a.test.ts` — exit 0.

```text
Test Files  1 passed (1)
      Tests  24 passed (24)
   Duration  2.29s (transform 132ms, setup 0ms, collect 184ms, tests 1.86s, environment 0ms, prepare 68ms)
```

### baseline-typecheck

`pnpm typecheck` — exit 0.

```text
Tasks:    14 successful, 14 total
Cached:    14 cached, 14 total
```

### red-at-pin

`pnpm vitest run tests/torq-terminal-simulate-adopt.test.tsx` — exit 1.

```text
Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)
   Duration  1.81s (transform 236ms, setup 0ms, collect 608ms, tests 348ms, environment 617ms, prepare 70ms)
```

### focused-new

`pnpm vitest run tests/torq-terminal-simulate-adopt.test.tsx` — exit 0.

```text
Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  1.90s (transform 242ms, setup 0ms, collect 627ms, tests 426ms, environment 608ms, prepare 69ms)
```

### preview-cost

`pnpm vitest run tests/torq-terminal-preview.test.tsx tests/torq-terminal-cost.test.tsx` — exit 0.

```text
Test Files  2 passed (2)
      Tests  24 passed (24)
   Duration  2.24s (transform 267ms, setup 0ms, collect 1.28s, tests 911ms, environment 1.38s, prepare 148ms)
```

### console-batch

`pnpm vitest run tests/torq-terminal-*.test.tsx tests/cost-panel.test.tsx` — exit 0.

```text
Test Files  1 passed (1)
      Tests  9 passed (9)
   Duration  1.41s (transform 73ms, setup 0ms, collect 380ms, tests 98ms, environment 663ms, prepare 79ms)
```

### console-batch-expanded

`$testFiles = @(Get-ChildItem tests/torq-terminal-*.test.tsx | ForEach-Object { $_.FullName }); pnpm vitest run @testFiles tests/cost-panel.test.tsx` — exit 0.

```text
Test Files  19 passed (19)
      Tests  153 passed (153)
   Duration  17.34s (transform 612ms, setup 0ms, collect 8.39s, tests 6.28s, environment 13.47s, prepare 1.49s)
```

### final-test

`pnpm test` — exit 0.

```text
Test Files  201 passed (201)
      Tests  2774 passed | 1 skipped (2775)
   Duration  267.86s (transform 4.21s, setup 0ms, collect 36.44s, tests 433.85s, environment 18.80s, prepare 14.87s)
```

### final-typecheck

`pnpm typecheck` — exit 0.

```text
Tasks:    14 successful, 14 total
Cached:    14 cached, 14 total
```

### final-build

`pnpm build` — exit 0.

```text
Tasks:    8 successful, 8 total
Cached:    7 cached, 8 total
```

### contracts-check

`pnpm --filter @torqclaw/contracts check` — exit 0.

```text
> @torqclaw/contracts@0.1.0 check E:\TORQCLAW-lane01-s2\packages\contracts
> node --experimental-strip-types scripts/check-schemas.ts

[contracts:check] OK — 8 schemas match source of truth in 2 checked-in dirs.
```

### reachability

`pnpm reachability` — exit 0.

```text
[reachability] 145 modules reachable from 6 entry points

Dormant by declaration (3 files):
  - packages/collab/src/authIdentityMigration.ts  (1 file(s), 346 lines)
      AUTH-005 Phase 2A Gate 1: offline collab migration only; standalone CLI entrypoint.
  - packages/gateway/src/authIdentityMigration.ts  (1 file(s), 274 lines)
      AUTH-005 Phase 2A Gate 1: offline state migration only; standalone CLI entrypoint.
  - packages/gateway/src/authReconciliationDiagnostic.ts  (1 file(s), 280 lines)
      AUTH-005 Phase 2A Gate 1: non-authoritative offline evidence only; standalone CLI entrypoint.

PASS: every substantial module is reachable or declared dormant.
```

## Scope

The only removed component line is:

```text
-    if (sent) setEstimateNonce(nonce); // a dropped send never arms a lookup
```

Component diff: 27 insertions, 1 deletion. The draft test differs only in the fifth test-name suffix (`_fresh_command` → `_fresh`).

`git diff fb42108 HEAD --stat` (final tree; rechecked after the evidence-only amendment):

```text
apps/console/src/components/TorqTerminal.tsx |  28 ++-
 docs/VERIFICATION-TCLAW-LOCAL-LANE-01-S2.md  | 227 +++++++++++++++++++
 tests/torq-terminal-simulate-adopt.test.tsx  | 320 +++++++++++++++++++++++++++
 3 files changed, 574 insertions(+), 1 deletion(-)
```

Empty-diff checks: `git diff fb42108 HEAD -- tests/torq-terminal-preview.test.tsx tests/torq-terminal-cost.test.tsx packages engines vendor` must print nothing; final output is retained in the external harness.

## Not pushed

`git rev-list --count fb42108..HEAD`, `git branch -r --contains HEAD`, remote slice-2 branch count and clean status are recorded after commit in the external build_result.md. No upstream is configured.

Observed outputs (rechecked after the evidence-only amendment): commit count `1`; containing remote refs: no output; remote slice-2 branch count `0`; `git status --short`: no output.

```text
1
0
```

## Deviations and evidence interpretation

- PowerShell passes the spec's wildcard literally to Vitest; that command ran only cost-panel (9 tests). The explicit-path equivalent then ran all 19 intended files / 153 tests. Both outputs are retained.
- Baseline full suite had one auth CLI failure (2768 passed, 1 failed, 1 skipped). The isolated auth file passed 24/24. It is classified as a transient baseline failure; its precise cause was not established. The final full suite result is recorded independently below.
- A committed document cannot contain its own final commit hash without changing that hash. This document identifies its containing commit with `git log -1 --format=%H -- docs/VERIFICATION-TCLAW-LOCAL-LANE-01-S2.md`; the exact final SHA and final scope/no-push outputs are recorded in the external harness build_result.md. This is an evidence-format interpretation of AC5, not a product change.
- Read-only instruction/pin checks preceded the first baseline test command; no product changes preceded the baseline. No test logic, existing test, or approved implementation block was changed.

## Known limitations

- Root tests/ is transformed and executed by Vitest, but is outside the console tsc project. The component is covered by typecheck.
- D-2: a failed re-estimate after controls change now clears the estimate chip, rather than showing the previous controls' estimate.
- crypto.randomUUID assumes a secure browser context; this is pre-existing and unchanged.
- No live stack/browser/provider check was performed. The operator runbook remains unfilled. Independent G2A acceptance is pending.
- Local remote-tracking refs are the no-push proof requested by the spec; no push or upstream-setting command was run.

## OPERATOR TO FILL — live check

1. Restart the stack; type a prompt; wait for the estimate chip; click "simulate route" once → panel shows a result, not a drop. Result: ____
2. Type again; click immediately → still one result. Result: ____
3. Amendment-1 path: type; click BEFORE the chip appears; wait for the result; click again on the same text → expected: the panel shows "previewing…" then a result (a second PREVIEW_ROUTE was sent), never a stuck drop message. Result: ____

## PR #70 review follow-up

The original G2A approval applies to `49537f7d468c535ed1c214e44496d197db86ee2d`. After publication, GitHub review found a draft/control debounce race and the lost-frame timeout gap also noted by G2A. The operator authorized push and merge after the historical one-commit/no-push evidence above was recorded.

The follow-up records the prompt sent with the armed estimate and checks it against the current input before adopting. When an adopted estimate times out, only that estimate nonce is disarmed; retry can send a fresh preview. Existing successful-result and pending-repeat-click behavior remains covered by the original tests.

Added regression cases:
- `simulate_uses_current_draft_after_control_change_during_debounce`
- `simulate_retries_with_fresh_nonce_after_adopted_estimate_timeout`

Both failed on the original component (5 passed / 2 failed) and passed after the fix. The combined adoption, preview, and cost test files pass 31 tests. `pnpm typecheck`, `pnpm build`, `pnpm --filter @torqclaw/contracts check`, and `pnpm reachability` all exit 0. These follow-up edits have not received a fresh independent G2A approval; no live browser/stack validation was performed.
