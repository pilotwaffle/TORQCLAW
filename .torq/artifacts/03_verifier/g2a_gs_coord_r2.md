# G2A — GS-COORD, round 2

**VERDICT: REJECTED — send_back_to: builder**
**`push_authorized: false`**

Verifier: Opus 4.8 (independent; did not write the code, did not review round 1).
Graded: worktree `E:/TorqClaw-worktrees/gs-coord`, branch `gs-coord-work`, base `da688c0`, UNCOMMITTED.
Worktree md5-verified byte-identical after every sabotage; final state pristine and green.

## Independently confirmed

- **300 passed, 2 skipped** across three separate runs (master baseline 277/1).
- Diff scope: 5 source + 5 test files, 1 new test file (815 lines). Nothing outside
  `engines/hermes_kernel/`.
- `vendor/` untouched; submodule pin `bbf020e709…` identical to master's tree entry.
  No stray temp/bak/orig files, no `SABOTAGE` or `if False` markers. (The one `sabotage`
  grep hit is a legitimately-named pre-existing regression test at
  `test_verified_skill_store.py:1997`.)

## Closed by sabotage

| Item | Sabotage | Failing test |
|---|---|---|
| **V1** | removed `with _MUTATION_LOCK` (`governed_skills.py:170`) | `test_store_construction_happens_under_mutation_lock` |
| **V2** | early `raise restore_exc` (`runtime_quiescence.py:524`) | `test_second_invalidation_is_attempted_even_when_restore_raises`, `…_chains_both` |
| **G1** | removed `_verify_published_digest` (`governed_skills.py:308-312`) | `test_idempotency_check_rehashes_published_bytes_not_just_the_sidecar` |

`_store_locked()` raises `RuntimeError` (`:190-196`) and survives `python -O`.

## BLOCKERS

**A. `GovernanceRevertedProjectionUnprovenError` (`governed_skills.py:449`) has ZERO
coverage.** G2A instrumented the branch: **0 hits across all 302 tests on a green run.**
The two tests round 2's table named crash `_save_state` on call 2, so `commit()` fails,
`commit_holder["previous"]` is never set (`:490`), and the branch is unreachable.
`test_activation_coordinator_wiring.py:429` passes **vacuously**; its comment at
`:425-428` is false for that path. The reachable state — commit lands → `verify()` fails
→ governance reverts → publisher restore fails — is real and untested. **The V3 fix's
revert *action* is pinned; its *distinct-error contract* is not.**

**B. G1R gap G2 is STILL NOT CLOSED — a round-1 blocker survived round 2.** Deleting the
call site at `skill_publisher.py:497` leaves the suite green at **300 passed**
(reproduced independently by G1D). Round 2's three new tests
(`test_skill_publisher.py:656/669/680`) call the helper **standalone** — both directions
of the *helper* are covered, the *call site* is not. The sole structural defence against
defect #4 remains deletable with a green suite.

**C. `SkillActivationRestoredButCacheUnprovenError` is laundered into the forbidden
shape.** `skill_queue.py:127-129` imports only `SkillRuntimeBusyError` and
`GovernanceRevertedProjectionUnprovenError`; the cache-unproven error falls to the generic
`except Exception` (`:169`), whose comment asserts *"Nothing partial is left published or
governed-active."* Measured through the real `decide()`:
`{'ok': False, 'code': 'SKILL_ACTIVATION_FAILED', 'retryable': True, 'status': 'pending'}`
— false; the disk projection moved twice and the cache is unproven. Contradicts the error
class's own docstring (`runtime_quiescence.py:177-193`, `:431`), which says it must "never
be folded into" the ordinary shape. **Structurally identical to V3, a round-1 rejection.**

## G1D discrepancy — adjudicated as (b), escalated

G2A reproduced G1D's finding exactly, then went further by instrumenting the branch.
G1D's LOW rating **understates** it: the revert action is pinned by
`test_verify_failure_restores_exact_prior_projection`, but the distinct-error contract has
no coverage at all — `test_…_projection_unproven`'s `pytest.raises` passes via a different,
`commit_holder`-empty path.

## Non-blocking — checked

- `behavviour` typo: **fixed** (0 occurrences under `tests/`).
- `prepared`-only journal deletion: **correct as scoped** (`verified_skill_store.py:307-319`,
  mirrored `:417-423`, `:514-520`). A `committing` journal must be retained — whether
  `_save_state` landed is exactly the ambiguity `_reconcile_transaction` resolves from
  `state.json` (`:690-700`). Deleting it would reintroduce defect #5.

## Assessment

Three of five round-1 items are genuinely closed with real forcing tests, and the
recovery/locking core is sound. The residue is one consistent pattern: **the control is
correct, its coverage is not.** Because the suite cannot distinguish these controls'
presence from their absence, a merge would import three unenforced claims into a public
repo. All three are test-and-one-`except`-arm sized; none require redesign.

**Could not verify:** the `prompt_builder.py:977-987` mtime/size snapshot question
(handoff item 5) — outside this worktree's diff scope; and GS-ACCEPT, correctly out of
scope.

## Required before re-review

1. `governed_skills.py:449` — test reaching the branch via **verify-failure** plus a
   failing `restore_retained_projection`. Must fail if the branch is removed.
2. `test_activation_coordinator_wiring.py:425-428` — correct the false comment; retarget
   or rename the mis-named test.
3. `skill_publisher.py:497` — test through real `publish_skill(retain_replaced_into=…)`
   that fails when the call site is deleted. Verify by deleting it.
4. `skill_queue.py:170` — dedicated `except` arm with a distinct code and a `retryable`
   reflecting reality; reconcile the `:173-175` comment; add the forcing test.
5. Re-run the three deletion probes and **report the failing test name for each**.
6. Produce a **measured** sabotage table — do not assert coverage that deletion has not
   demonstrated.
