# G1D independent verification — GS-COORD round 2

Orchestrator spot-check before routing to G2A. **Not a substitute for G2A grading.**
Everything below was executed, not read.

## Confirmed

| Check | Result |
|---|---|
| Full Python suite | **300 passed, 2 skipped** (round 1: 290/2; master: 277/1) |
| Nine blocker/gap tests, targeted run | 9 passed |
| Worktree byte-identical after all my sabotages | yes (`diff -q` clean, 0 `SABOTAGE` markers) |

**V1 — measured, not read.** Re-ran G1R's exact probe: spied
`VerifiedSkillStore.__init__` through the real `install_approved_skill` and printed
`_MUTATION_LOCK._is_owned()` → **`[True]`**. Round 1 returned `[False]`. The
relitigating comment at old `:298-301` is gone; the `assert` guard is now
`raise RuntimeError` (`governed_skills.py:191`), so it survives `python -O`.

**V3 — ordering flipped correctly.** `revert_activation` now precedes
`restore_retained_projection`, with `GovernanceRevertedProjectionUnprovenError`
raised if the projection restore then fails.

**Governance revert IS pinned** — but by a different test than the Builder claimed.
Disabling the branch (`governed_skills.py:419`, `if False and "previous" in ...`)
against the full suite yields:

```
FAILED tests/test_activation_coordinator_wiring.py::test_verify_failure_restores_exact_prior_projection
1 failed, 299 passed, 2 skipped
```

## Discrepancy in the Builder's sabotage table — FLAG FOR G2A

The table claims that reverting item 2 to round-1 ordering fails
`test_restore_projection_failure_still_reverts_governance_first` and
`test_decide_does_not_report_retryable_pending_when_projection_unproven`.

I disabled the real `revert_activation` call and **both tests still passed**
(`2 passed, 300 deselected`). Cause: the test crashes `_save_state` on its **2nd**
call, so `commit()` itself fails and `commit_holder["previous"]` is never populated —
the `if "previous" in commit_holder:` branch is never reached on that path.

Consequently the assertion at
`test_activation_coordinator_wiring.py:429` (`active["digest"] == first["digest"]`)
passes **vacuously**: governance never advanced to V2, so it is trivially still at V1
whether or not the revert exists. Its inline comment — *"Round-1 behaviour left
governance pointing at the NEW digest here"* — is **wrong for this path**; round 1
would not have either, because commit failed before governance moved.

**Severity: LOW.** The product fix is correct and IS covered, by
`test_verify_failure_restores_exact_prior_projection`. This is a test-provenance and
comment-accuracy defect, not a live hole. But it is exactly the "test asserts
something trivially true" pattern this program exists to catch, and the Builder's
report asserted a stronger claim than the tests support — the same class of error
that produced round 1's rejection.

**Recommended (non-blocking):** correct the misleading comment at `:425-428`, and
either retarget that test at the verify-failure path (so it exercises the branch its
name describes) or rename it to say what it actually covers.

## Not re-checked

Items G1R already confirmed sound: recovery semantics, digest form, `_build_package`
determinism, absence of lock inversion, absence of a durable `activating` state,
retained-root sibling property, the four re-specified tests, and the invariant-path
test's bypass detection. G2A should sample rather than re-derive these.

## Builder's own stated gaps (carried forward)

- GS-ACCEPT (real `AIAgent` boot) not run — correctly out of scope for this round.
- `add_note()` in the double-failure chaining path requires Python 3.11+; environment
  is 3.13.12. Version-dependent detail, flagged not fixed.
- Triple-failure cascade (governance revert AND restore AND second invalidation all
  failing) not sabotage-verified; each was tested in isolation.
