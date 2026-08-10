# G1R — GS-COORD, round 1

**VERDICT: REJECTED — send_back_to: builder**

Reviewer: Opus 4.7 (independent; did not write the code).
Reviewed: worktree `E:/TorqClaw-worktrees/gs-coord`, branch `gs-coord-work`, base `da688c0`.
Worktree restored byte-exact after review; all reviewer sabotages reverted.

## Result summary

Eight of nine defects **CONFIRMED FIXED**, each verified by execution or sabotage rather
than by reading. Defect #4 is **PARTIAL** — mechanism correct, zero test coverage.

Three **BLOCKERS** found that the Builder's own suite does not catch, plus two
correctness gaps.

## Blockers

**V1 — store constructed (and `reconcile()` run) OUTSIDE `_MUTATION_LOCK`.**
`governed_skills.py:302`. Measured: spied `VerifiedSkillStore.__init__` through the real
`install_approved_skill`, printed `_MUTATION_LOCK._is_owned()` → `[False]`. Violates the
frozen ruling *and* the module's own docstring (`:43-47`), which claims construction is
"EAGERLY INSIDE the coordinator's lock acquisition, not before it." The comment at
`:298-301` relitigates a frozen ruling in a code comment. The guard at `:165` is an
`assert` — stripped under `python -O` — and only fires after `:302` already won.
This is the unenforced-claim pattern: a documented invariant with no enforcement.

**V2 — the mandatory second invalidation is skipped when `restore()` itself raises.**
`runtime_quiescence.py:497-500`: `raise restore_exc from exc` bypasses `:508`. The first
invalidation already succeeded, so the cache holds the failed new version while disk is
in an unknown state, and the lock releases with no re-invalidation attempted. The
docstring calls this intentional; the frozen ruling says "mandatory" with no carve-out.
**If a carve-out is genuinely warranted that is an architect decision, not a code
comment.**

**V3 — `_restore` abandons the governed revert when the publisher restore fails.**
`governed_skills.py:347-373`. `restore_retained_projection` (`:348`) precedes
`revert_activation` (`:370-372`); if the former raises, the latter never runs. Measured
through the real `skill_queue.decide()`:

```
DECIDE RESULT   : {'ok': False, 'code': 'SKILL_ACTIVATION_FAILED',
                   'retryable': True, 'status': 'pending', ...}
QUEUE ROW STATUS: pending
GOVERNED ACTIVE : V2          <-- new version
PUBLISHED BYTES : V2          <-- new version
```

`skill_queue.py:151-152` explicitly claims "Nothing partial is left published or
governed-active." It is. **This is the ticket's own core failure mode restated one layer
up**, and the follow-on retry hits `_already_active_and_published` and launders it into
`{ok: True, reconciledFromPriorSuccess: True}`.

## Correctness gaps

**G1 — `_already_active_and_published` trusts the provenance sidecar and never re-hashes
published bytes.** `governed_skills.py:258-261`. Probe: activate `"GOOD\n"`, overwrite the
published `SKILL.md` with `"EVIL\n"`, retry → `reconciledFromPriorSuccess: True` with
corrupted bytes live. `skill_publisher._verify_published_digest` (`:683-703`) already does
the right thing and is simply not called. One-line fix.

**G2 — `_assert_retention_root_outside_loadable_tree` has ZERO coverage.** Deleting the
call at `skill_publisher.py:497` leaves 25 tests passing. The sole structural defence
against defect #4 is deletable with a green suite. ~8 lines to close.

## Verified sound (do not re-litigate)

- **Recovery semantics are correct.** `prepared` → unconditional discard; `committing` →
  inspects `state.json`, confirming what durable state already says. It never calls
  `_save_state` itself and makes no mutation on any path, so it **cannot** revert a
  durably committed activation nor complete an aborted one. The naive
  "complete-only-if-state_committed" trap was NOT implemented. Four state shapes exercised
  live, including rollback in both directions with `approvalToken=None`.
- **Digest form — no mismatch; the handoff's flag was a false alarm.** `package_digest()`
  → bare 64-hex (directory names, `state["active"]`, publisher `digest=` arg, provenance,
  queue return). `file_digest()` → `"sha256:<hex>"`, used only for
  `manifest["files"]["SKILL.md"]`. The two never cross. P2-1a's `len == 64` assertions are
  consistent.
- **`_build_package` is deterministic in the CURRENT code** — literal `"1.0.0"`, pure
  derivation from `skill_id`, pure hash, no `time`/`uuid`/`random`. The idempotency
  precondition holds.
- **No lock inversion.** `verified_skill_store.py` contains neither `_MUTATION_LOCK` nor
  `runtime_quiescence`. 8 concurrent installs: 0 hung, 0 errors.
- **No durable `activating` state** was introduced.
- **Retained root is a true sibling** of `published_skills/`.
- **Re-specified tests are clean — the section most likely to hide cheating.** All four
  changed assertions invert *toward* the frozen ruling, carry a written rationale naming
  the defect number, and **add** assertions rather than removing them. The audit-capacity
  guard is still pinned via `pytest.raises` on a later `activate()`.
- **The invariant-path test genuinely detects bypass.** Independently reproduced: inlining
  the four callbacks while keeping the import fails 6 of 13.

## Required changes

1. `governed_skills.py:302` — construct the store under `_MUTATION_LOCK` (RLock, so the
   coordinator's later acquisition re-enters). Delete the `:298-301` comment. Replace the
   `assert` at `:165` with a real raise.
2. `governed_skills.py:347-372` — make the governed revert unconditional relative to the
   publisher restore, and revert governance FIRST (conservative-on-failure). If the
   publisher restore still fails, raise a distinct "governance-reverted-but-projection-
   unproven" error rather than a bare `RuntimeError` that `skill_queue.py:147` swallows
   into a `retryable: true, pending` lie. Add the forcing test.
3. `runtime_quiescence.py:497-500` — attempt the second invalidation even when `restore()`
   raises, or escalate the carve-out to the architect.
4. `governed_skills.py:258-261` — call `_verify_published_digest` inside the `try`. Add
   the tampered-bytes test.
5. `skill_publisher.py:497` — add a both-directions test for the retention-root assertion.

Non-blocking: `behavviour` typo in `test_verified_skill_store.py`; the `except: raise`
no-ops at `verified_skill_store.py:306-309`, `:405-406`, `:494-495` — the ruling's stated
"abort deletes the journal" mechanism is not implemented, only its outcome.
