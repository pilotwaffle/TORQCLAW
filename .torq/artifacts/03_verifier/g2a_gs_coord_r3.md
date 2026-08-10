# G2A — GS-COORD, round 3

**VERDICT: APPROVED**
**`send_back_to`: none**
**`push_authorized: false`** (publication is an operator decision; G2A never authorises it)

Verifier: Opus 5 (independent; did not write the code).
Graded: worktree `E:/TorqClaw-worktrees/gs-coord`, branch `gs-coord-work`, base
`da688c0`, **UNCOMMITTED**.
Every claim below comes from an execution, an instrumented branch, or a sabotage.
Worktree md5-verified byte-identical after every mutation; final state pristine and green.

All three round-2 blockers are **CLOSED by my own independent measurement**. I found
**no new blocker**. I did find one **false comment** (non-blocking, documentation-only)
and I am recording exactly what the `commit_holder` ordering change is and is not.

---

## Independently confirmed (numbers are mine, not G1D's)

| Item | Measurement |
|---|---|
| Baseline | **302 passed, 2 skipped** (100.94s), reproduced again at the end: **302 passed, 2 skipped** |
| Diff scope | 10 modified + 1 new test file (917 lines). `git status --porcelain \| grep -v engines/hermes_kernel/` → **NONE** |
| `vendor/` | untouched, not dirty |
| Submodule pin | `bbf020e709eca4571c488ebb7cc65b1202bf5dab` — **identical** in worktree `HEAD` and `master` |
| Stray files | no `.bak/.orig/.rej/.tmp`; no `SABOTAGE`, `if False`, or leftover probe markers |
| `behavviour` typo | **0 occurrences** |
| `sabotage` grep hits | all pre-existing, legitimately-named regression tests |

### Reachability instrumentation (the round-2 technique that caught blocker A)

I patched five hit-counters into the product code and ran the **full suite once**.
This is the measurement that decides whether coverage is real:

```
30  B_RETENTION_CALLSITE
18  A_COMMIT_HOLDER_SET previous=None
 3  A_REVERT_BRANCH
 2  A_RAISE_GRPUE
 1  Q_ARM_PROJECTION_UNPROVEN
 1  Q_ARM_CACHE_UNPROVEN
 1  A_REVERT_RESULT reverted={'ok': True, 'skillId': 'verifyfail.skill',    'reverted': True}
 1  A_REVERT_RESULT reverted={'ok': True, 'skillId': 'unproven.skill',      'reverted': True}
 1  A_REVERT_RESULT reverted={'ok': True, 'skillId': 'revert-first.skill',  'reverted': True}
 6  A_COMMIT_HOLDER_SET previous={'digest': …, 'enabled': True, 'permissions': ['read']}
```

Round 2 measured **0 hits** on the `GovernanceRevertedProjectionUnprovenError` raise.
It is now **2**. Decisively: all three `revert_activation` calls return
**`reverted: True`** with a **non-`None` `previous`**. That is the precise refutation
of round 2's vacuity — governance is genuinely moved and genuinely moved back, not
"never moved and therefore trivially unchanged". Suite stayed **302 passed** while
instrumented, so the counters did not perturb behaviour.

---

## Per-blocker findings

### A — `GovernanceRevertedProjectionUnprovenError` coverage — **CLOSED**

**Sabotage:** `raise GovernanceRevertedProjectionUnprovenError(` → `raise RuntimeError(`
(exactly 1 site; asserted). Deliberately narrow — it neutralises **only** the
distinct-error contract. The revert action, the exception class, and the `skill_queue`
arm all remain intact, so a red result is attributable to the lost contract alone.
`ast.parse` OK; class still defined (1); queue arm still present (1).

**Result: 2 failed / 300 passed / 2 skipped.**

```
FAILED tests/test_activation_coordinator_wiring.py::test_verify_failure_then_projection_restore_failure_reverts_governance_first
FAILED tests/test_activation_coordinator_wiring.py::test_decide_does_not_report_retryable_pending_when_projection_unproven
```

The second failure printed the exact forbidden shape, proving the assertion bites on
real data rather than on a mock:

```
{'ok': False, 'code': 'SKILL_ACTIVATION_FAILED', 'retryable': True, 'status': 'pending',
 'error': "skill 'unproven.skill': governed-active state was reverted to digest
           '3b8605f5…', but restoring the prior published projection then failed;
           TORQCLAW cannot prove what is currently published on disk for this skill id"}
```

Note the error text: governance **was** reverted to a real prior digest. Combined with
the `reverted: True` instrumentation, the round-2 vacuity is gone.

### B — retention-root call site (`skill_publisher.py:497`) — **CLOSED**

This is the round-1 blocker that survived round 2, so I probed it exactly as the
defect is shaped: **delete the call site, keep the helper**.

**Sabotage:** removed the single line `_assert_retention_root_outside_loadable_tree(retain_root)`
(count asserted == 1). Helper definition still present (1). `ast.parse` OK.

**Result: 1 failed / 301 passed / 2 skipped.**

```
FAILED tests/test_skill_publisher.py::test_publish_skill_rejects_retain_root_inside_loadable_tree_via_real_call
        E  Failed: DID NOT RAISE SkillPublicationError
```

The new test drives **real `publish_skill(retain_replaced_into=…)`**, not the helper
standalone. The call site is no longer deletable with a green suite.

### C — `SkillActivationRestoredButCacheUnprovenError` laundering — **CLOSED**

**Sabotage:** I did *not* delete the arm (that risks banking a syntax/collection break
as a caught deletion). I made it **unreachable while keeping its body**: rebound
`except SkillActivationRestoredButCacheUnprovenError` to a locally-defined
`_G2AUnreachable(Exception)` that nothing raises.

Attribution gates cleared before running: `ast.parse` OK; `pytest --collect-only` →
**304 tests collected** (unchanged); generic `except Exception as exc:` still present (1);
`SKILL_ACTIVATION_CACHE_UNPROVEN` literal still present (1). So the red run is
attributable to a lost exception contract and to fall-through into the generic handler.

**Result: 1 failed / 301 passed / 2 skipped.**

```
FAILED tests/test_activation_coordinator_wiring.py::test_decide_reports_distinct_code_when_cache_unproven_after_restore
        E  AssertionError: assert 'SKILL_ACTIVATION_FAILED' == 'SKILL_ACTIVATION_CACHE_UNPROVEN'
```

---

## The `commit_holder` ordering change — my finding

This was the item I was told to treat as a new mechanism. I probed it four ways.

**It is correct, and it is the right change. It is also NOT enforced by the suite, and
one code comment asserts otherwise.**

### Probe D — revert the product change (the probe nobody ran)

I restored round 2's ordering exactly: assignment moved back to *before* `activate()`,
post-`activate()` assignment removed.

**Result: 302 passed, 2 skipped — FULLY GREEN.**

So the ordering change is **deletable with a green suite**. Targeted re-run of the two
tests the code comment names:

```
tests/…::test_verify_failure_then_projection_restore_failure_reverts_governance_first  PASSED
tests/…::test_decide_does_not_report_retryable_pending_when_projection_unproven        PASSED
```

**This falsifies a written claim in the tree.** `test_activation_coordinator_wiring.py:468-470`
states the branch is deletion-probed *"(or reverting the `_commit` ordering fix above)
makes these two tests fail"*. Reverting the ordering fix makes **neither** test fail.
That parenthetical is false — it is the round-3 instance of the repo's
unenforced-claim pattern, and I am recording it as such.

### Why this is nonetheless not a blocker

I built a live differential harness (temporary test file, since deleted) that ran the
identical scenario under **both** orderings and printed real end state.

*Commit (`activate()`) failure, with a prior version live:*

| | round 3 (current) | round 2 (reverted) |
|---|---|---|
| `revert_activation` called | **no** (`[]`) | yes, `reverted: **False**` (no-op) |
| governed-active digest | V1 | V1 |
| published `SKILL.md` | `'V1 CONTENT\n'` | `'V1 CONTENT\n'` |
| `decide()` result | `SKILL_ACTIVATION_FAILED / retryable True` | identical |

*Verify failure, with a prior version live:*

| | round 3 | round 2 |
|---|---|---|
| `revert_activation` | called, `reverted: **True**` | called, `reverted: **True**` |
| governed-active digest | V1 | V1 |
| published `SKILL.md` | `'V1 CONTENT\n'` | `'V1 CONTENT\n'` |

**The externally observable end state is identical under both orderings.** Round 2's
ordering was not a correctness defect in the product — it was a *test-vacuity* defect.
Its extra `revert_activation` call is a genuine no-op (`reverted: False`), because
`revert_activation` re-reads fresh state and declines to move a digest that was never
flipped. The round-3 ordering removes a pointless call and, critically, makes
`commit_holder` a faithful "did the commit land" proxy so tests can no longer pass
vacuously. That is a real improvement in *provability*, correctly flagged by G1D as a
product change — but it does not change product behaviour, which is why nothing fails
when it is reverted.

### The four operator questions, answered by measurement

1. **Can a commit land durably yet `commit_holder["previous"]` be absent — losing the
   revert?** No. AST analysis of `_commit` shows exactly **zero intervening statements**
   between `result = locked_store.activate(...)` (stmt idx 2) and
   `commit_holder['previous'] = previous` (stmt idx 3). The window is a single
   `STORE_SUBSCR` on an already-materialised local into an already-existing dict: no
   I/O, no user code, no allocation that can raise, no `await`, no callback. A crash
   there (SIGKILL / power loss) takes the whole process down, so no in-process revert
   would run under *either* ordering — and that case is exactly what the
   journal/`reconcile()` path exists to resolve. No reachable in-process gap.
2. **Is `previous` still read at the correct moment (before the flip)?** Yes, measured:
   `previous = locked_store._load_state()["active"].get(sid)` is stmt idx **1**, strictly
   **before** `activate()` at idx 2. Only the *assignment* moved; the *read* did not.
   Instrumentation confirms the captured values are real prior records
   (`{'digest': …, 'enabled': True, 'permissions': ['read']}`), not `None`, on the six
   replacement activations.
3. **Does the no-longer-taken revert on commit failure leave anything unreverted that
   round 2's over-eager revert cleaned up?** No — see the table above. Round 2's call
   returned `reverted: False` and mutated nothing. Nothing was being cleaned up, so
   nothing is now left behind. Governed-active and published bytes are V1 in both.
4. **Does the reconcile/journal path still resolve the same ambiguity?**
   `verified_skill_store.py:690-700` is untouched by the ordering change and still
   branches on `kind == "revert_activation"`, checking the landed and did-not-land
   shapes as mirror images against `state.json` rather than assuming either. Round-1's
   "recovery semantics are correct" finding is undisturbed; the ordering change lives
   entirely in `governed_skills._commit` and never writes a journal itself.

---

## Hunt for the new vacuous assertion

Rounds 1, 2 and 3 each shipped a test that passed for the wrong reason, so I assumed
round 3 did too and went looking.

**I did not find one.** What I checked, and how:

- **The three new tests are non-vacuous.** Instrumentation proves each drives its branch
  with real state: `reverted: True`, non-`None` `previous`, and the queue arms hit once
  each. A `pytest.raises` passing via a different path — round 2's exact failure — is
  ruled out because the raise counter went 0 → 2 and the revert counter shows real
  digest movement.
- **The `retryable` assertions are not tautological.** Probe C shows
  `test_decide_reports_distinct_code_when_cache_unproven_after_restore` flips to
  `SKILL_ACTIVATION_FAILED` the moment the arm is unreachable, so it is reading a real
  dispatch outcome.
- **No exception-arm shadowing** (a plausible way to fake distinct codes). Verified MRO:
  `GovernanceRevertedProjectionUnprovenError` ← `GovernedSkillError`;
  `SkillActivationRestoredButCacheUnprovenError` ← `SkillStoreError`;
  `SkillRuntimeBusyError` ← `SkillStoreError`. All `issubclass` cross-checks between the
  three are **False** — the arms are disjoint, so ordering cannot silently capture.
- **The one thing that *is* over-claimed is a comment, not a test** — the falsified
  ordering parenthetical above. The tests themselves assert only what they can prove.

---

## Frozen error-shape ruling — verified

Extracted statically from the AST of `skill_queue.py`, and confirmed reached at runtime
by instrumentation:

| line | code | `retryable` | `status` | ruling |
|---|---|---|---|---|
| 139 | `SKILL_RUNTIME_BUSY` | `True` | `pending` | correct (nothing changed) |
| 165 | `SKILL_PROJECTION_UNPROVEN_AFTER_REVERT` | **`False`** | `pending` | **matches** |
| 193 | `SKILL_ACTIVATION_CACHE_UNPROVEN` | **`False`** | `pending` | **matches** |
| 213 | `SKILL_ACTIVATION_FAILED` | **`True`** | `pending` | genuine clean slate only |

Queue status represents an **effective** approval, not operator intent: both unproven
shapes leave the row `pending` (operator-recoverable, not bricked) while refusing
`retryable`, so no automation retries over an unprovable disk state. The round-2
overclaim — *"Nothing partial is left published or governed-active"* asserted
unconditionally at the generic handler — is gone; the comment at `:200-212` now names
both unproven errors and explicitly carves them out. That carve-out is accurate against
the measured shapes.

---

## Non-blocking observations

1. **False comment, `test_activation_coordinator_wiring.py:468-470.`** *"(or reverting
   the `_commit` ordering fix above) makes these two tests fail"* — measured false; both
   pass. Recommend deleting the parenthetical, or adding a test that actually pins the
   ordering (e.g. assert `revert_activation` is **not** called on a commit-failure path,
   which *would* fail under round-2 ordering — see my differential table). Documentation
   defect only: the code is correct and the other three deletion claims in that comment
   block are true. Not merge-blocking, but it is the same unenforced-claim pattern this
   repo keeps reproducing, so it should not be left to calcify.
2. **The ordering change is unenforced.** Deletable with a green suite (probe D). I am
   not treating this as a blocker because I measured that it has no externally
   observable behavioural effect — it is a provability fix, not a behaviour fix, and a
   regression would be caught by the vacuity it was introduced to prevent. Worth one
   cheap test if the team wants the invariant pinned.
3. **Triple-failure cascade** (verify fails → governance revert fails → publisher restore
   fails) still not exercised; each is tested in isolation. Pre-existing, carried from
   G1D.
4. `add_note()` double-failure chaining requires Python ≥3.11; env is 3.13.12. Fine here,
   worth noting if the floor ever moves.
5. The one `sabotage` grep hit outside the new work is the pre-existing, legitimately
   named `test_sabotage_regression_del_truncation_reintroduces_silent_history_loss`.

---

## Could not verify

- **GS-ACCEPT** (live `AIAgent` boot) — correctly out of scope; nothing here substitutes
  for it. The suite proves the coordinator's contracts, not a real Hermes runtime.
- **`prompt_builder.py:977-987`** mtime/size snapshot question — out of this worktree's
  diff scope, unchanged from rounds 1-2.
- **True crash-during-window durability** (SIGKILL between `activate()` returning and the
  assignment) — reasoned to be unreachable in-process by AST/bytecode analysis and
  delegated to the journal/reconcile path, but I did not kill a process mid-transaction
  to prove the recovery end-to-end. This is the one place my confidence is analytical
  rather than executed.

---

## Assessment

Round 3 is the first round whose evidence matches its claims. The three blockers are
closed by my own sabotages with named failing tests, the reachability instrumentation
that exposed round 2's vacuum now reads non-zero with genuine `reverted: True` state
movement, the error shapes match the frozen ruling both statically and at runtime, and
scope is clean — nothing outside `engines/hermes_kernel/`, vendor untouched, submodule
pin identical to master.

The `commit_holder` ordering change deserved the scrutiny it was flagged for, and it
survives it: the read still happens before the flip, the assignment window is
provably empty, and the reconcile path is untouched. Its one flaw is a comment that
claims more enforcement than exists — a documentation defect, not a correctness one,
and I verified the underlying behaviour by differential execution rather than accepting
either the comment or the Builder's reading of it.

I looked for a fourth vacuous assertion on the assumption one existed. It does not.

**APPROVED.** Publication remains an operator decision.
