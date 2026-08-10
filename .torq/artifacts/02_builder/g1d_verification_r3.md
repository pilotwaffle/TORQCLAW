# G1D independent verification — GS-COORD round 3

Orchestrator spot-check before routing to G2A. **Not a substitute for G2A grading.**
Everything below was executed, not read. Probe harness:
`scratchpad/probe_r3.sh` (six operator-mandated gates enforced as hard aborts).

## Verdict: all three round-2 blockers CLOSED by measurement

For the first time in three rounds, the Builder's sabotage table matches my
independent measurement exactly. Rounds 1 and 2 both asserted coverage that
deletion disproved.

| Probe | Control deleted | Result | Failing test |
|---|---|---|---|
| **A** | `raise GovernanceRevertedProjectionUnprovenError(` → `raise RuntimeError(` | **CAUGHT** 2 failed / 300 passed | `test_verify_failure_then_projection_restore_failure_reverts_governance_first`, `test_decide_does_not_report_retryable_pending_when_projection_unproven` |
| **B** | `_assert_retention_root_outside_loadable_tree(retain_root)` **call site** | **CAUGHT** 1 failed / 301 passed | `test_publish_skill_rejects_retain_root_inside_loadable_tree_via_real_call` |
| **C** | dedicated `except SkillActivationRestoredButCacheUnprovenError` arm | **CAUGHT** 1 failed / 301 passed | `test_decide_reports_distinct_code_when_cache_unproven_after_restore` |

Probe A was deliberately narrowed from round 2's: it neutralises only the
**distinct-error contract**, leaving the revert **action** intact (already pinned
by `test_verify_failure_restores_exact_prior_projection`). Conflating the two is
what G2A escalated my round-2 LOW rating over. The contract now has its own
coverage.

## Gate results

| Gate | Requirement | Result |
|---|---|---|
| G1 | mutation applied exactly once, asserted | ok on all three (1 raise site / 1 call site / 1 arm) |
| G2 | baseline green and ≥ 302 | **302 passed, 2 skipped** |
| G3 | nonzero pytest exit after deletion | rc=1 on all three |
| G4 | specific failing test named | all three, extracted from `FAILED` lines |
| G5 | restore even on abort | `trap restore_all EXIT INT TERM` |
| G6 | byte-exact restore **asserted** + green final | md5 compared per file; final **302 == baseline 302** |

Probe C additionally cleared two attribution gates before its suite ran — an
`ast.parse` check and a `pytest --collect-only` gate — so its red run is
attributable to a lost exception contract, not a syntax or collection break.
The mutation also asserts `except Exception` still exists, proving fall-through
to the generic handler rather than assuming it. `assert_caught` distinguishes
CLOSED / OPEN / **INVALID** (red without a named test), so a structural break
could not have banked as a caught deletion.

One gate fired for real on the first run: `BASE_PASSED` parsed empty and G2
aborted before any probe. The abort was correct behaviour — an unattributable
baseline must not be probed against. Fixed the extractor (`grep -oE` rather than
`sed`), raised `BASELINE_MIN` to 302, re-ran clean.

## Root cause — verified independently, and it is a product fix

The Builder's diagnosis is correct and load-bearing. Round 2 set
`commit_holder["previous"]` **before** `locked_store.activate(...)`, so
`"previous" in commit_holder` was true even when `activate()` raised. `_restore`
then called `revert_activation` on a commit that never landed; it reads fresh
state, sees the digest was never moved, and no-ops. That is why
`active["digest"] == first["digest"]` passed **vacuously** and why G2A measured
**0 branch hits across 302 tests**.

Confirmed in source: `previous` is now held as a local and assigned to
`commit_holder` at `governed_skills.py:512`, **after** `activate()` returns
(`:502` comment states the invariant). The dict now faithfully proxies
"commit landed."

This is a change to the commit path, not test-only work — flagged for G2A as
requiring product-level scrutiny, not just coverage scrutiny.

## Error-shape semantics — checked against the frozen ruling

`skill_queue.py` now returns three distinct shapes:

- `SKILL_PROJECTION_UNPROVEN_AFTER_REVERT` — `retryable: False` (`:167-168`)
- `SKILL_ACTIVATION_CACHE_UNPROVEN` — `retryable: False` (`:195-196`)
- `SKILL_ACTIVATION_FAILED` — `retryable: True` (`:216`), the genuine clean slate

The generic handler's comment (`:200-212`) now explicitly carves out both
unproven errors, naming each and stating the coordinator's restore path did NOT
reach a provable slate. The overclaim G2A rejected — *"Nothing partial is left
published or governed-active"* asserted unconditionally — is gone. Queue status
represents an **effective** approval, per the frozen ruling.

## Scope

10 modified + 1 new test file (917 lines, up from 815). Nothing outside
`engines/hermes_kernel/`. `vendor/` untouched. Worktree byte-identical after all
three probes; final suite green at the baseline count.

## Carried forward for G2A

- The `commit_holder` ordering change is a **product** change introduced in a
  round whose brief was coverage. It deserves the same adversarial treatment as
  a new mechanism.
- Builder did not re-run V1/V2/G1 sabotages (correctly — out of brief, and its
  edits do not touch `verified_skill_store.py` or the locking/journal code).
- Builder's own carried gap: the `commit_holder` claim is verified by reading
  the code path, **not** deletion-probed independently. I did not probe it
  either. It is the mechanism A and B now depend on.
- `add_note()` double-failure chaining requires Python 3.11+ (env is 3.13.12).
- Triple-failure cascade still not sabotage-verified; each tested in isolation.
- GS-ACCEPT correctly out of scope.
- `prompt_builder.py:977-987` mtime/size question remains outside diff scope.
