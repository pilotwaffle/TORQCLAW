# Handoff: GS-COORD → GS-ACCEPT → C1

Written 2026-08-09. Everything below was verified against source or by running
it; nothing here is inferred from a commit message.

## TL;DR for whoever picks this up

GS-COORD is **implemented and green but UNCOMMITTED**, sitting in a worktree.
It needs G2A review and an operator merge. After it merges, run GS-ACCEPT.
Do not start the C1 runtime build until GS-ACCEPT passes.

```
worktree : E:/TorqClaw-worktrees/gs-coord   (branch gs-coord-work, based on da688c0)
state    : 7 files modified + 1 new test file, ~1,674 lines, NOT committed
tests    : 290 passed, 2 skipped   (baseline on master: 277 passed, 1 skipped)
origin   : master = da688c0, everything through C0 is pushed and in sync
```

The Builder that wrote it hit a session limit mid-run, immediately after
finishing the implementation and saying "let's re-run the full suite." I ran
that suite myself: it is green. But **no G2A has been done**, and the Builder
never produced its own sabotage table or final report.

---

## Why GS-COORD exists

`governed_skills.install_approved_skill()` on master runs
`stage → approve → activate → publish` with no lock, no quiescence, no cache
invalidation, and nothing reversible. Nine defects were verified against
source before the build started:

| # | Defect | Where (on master) |
|---|---|---|
| 1 | ActivationCoordinator bypassed entirely | `governed_skills.py:163,167` |
| 2 | Ordering INVERTED — `activate()` before `publish_skill()`, so a routine publish failure leaves governance ACTIVE with the approval consumed | `governed_skills.py:163` vs `:167` |
| 3 | Publication irreversible: prior projection destroyed on success before the caller can invalidate/commit/verify | `skill_publisher.py:475-488` |
| 4 | **`.torqclaw-doomed-*` IS scanned by the real loader and sorts FIRST** | `skill_utils.py:27-44`, `:632-644` |
| 5 | `_reconcile_transaction` never reads `tx["phase"]` — any retained journal completes an aborted activation | `verified_skill_store.py:484-524` |
| 6 | Crash window: `_save_state` at `:278`, phase marker written at `:279-280` AFTER | `verified_skill_store.py` |
| 7 | `ActivationCoordinator.run()` missing second invalidation after restore; error text claims a state it hasn't achieved | `runtime_quiescence.py:442-464` |
| 8 | `rollback()` has the identical journal defect and shares the reconciler | `verified_skill_store.py:346-376` |
| 9 | `skill_queue.decide()` commits `approved` BEFORE installing; the `status != "pending"` guard then makes a failed install unretryable — draft bricked forever | `skill_queue.py:66-75` |

**Defect 4 is the one to understand.** `EXCLUDED_SKILL_DIRS` is a fixed-name
frozenset with no dot-prefix rule. Proven empirically:

```
.torqclaw-doomed-abc123/SKILL.md -> OLD     <-- loader yields this FIRST
my.skill/SKILL.md                -> NEW
```

`.` (0x2E) sorts before alphanumerics and `prompt_builder.py:1269` dedups
first-wins, so **the stale copy wins and the new skill is silently skipped**.
Today that window is microseconds. The obvious implementation of "retain the
prior projection" (a dotfile sibling inside `published_skills/`) would have
widened it to the whole transaction — a silent wrong-version-served in the
subsystem whose entire purpose is proving which version is live. Two existing
code comments assert the dot-prefix is safe; both are false.

---

## Frozen operator rulings (do not relitigate)

**FAIL-FAST WITH A RETRYABLE `pending` ROW.** No deferred activation, no
background queue, no timer, no hidden retry.

```
pending --(Hermes busy)-------> REFUSE, row stays pending
pending --(activation fails)--> restore/abort, row stays pending
pending --(fully succeeds)----> approved / approved_edited
REJECT: pending -> rejected immediately, independent of quiescence
```

The queue status must represent an **effective approval, not operator intent**.

Busy result: `{ok: false, code: "SKILL_RUNTIME_BUSY", retryable: true,
status: "pending", activeTasks: N}`.

Coordinator ordering:
```
LOCK → QUIESCENCE → retain prior OUTSIDE loadable tree → publish → invalidate
     → governed commit → verify → finalize/remove retained → UNLOCK
failure after publish:
     restore exact prior → INVALIDATE AGAIN (mandatory) → verify → delete journal → unlock
```

Retained projection lives at `$TORQCLAW_DATA_DIR/published_skills_retained/<txid>/`
— a **sibling** of `published_skills/`, never a child, same volume so restore
is `os.replace`.

Journal phase markers are written **before** the action they guard.
`prepared` → discard. `committing` → **inspect `state.json`**, never
blind-replay (a naive "complete only if state_committed" rule would REVERT
durably committed activations — worse than the bug). Abort **deletes** the
journal; the phase check is a crash-window backstop, not the mechanism.

---

## What I verified myself in the worktree

Not the Builder's claims — my own runs:

- **Full Python suite: 290 passed, 2 skipped** (6m11s).
- **Invariant-path test is real.** `test_decide_APPROVE_actually_invokes_ActivationCoordinator_run`
  spies on `ActivationCoordinator.run` itself and asserts exactly one call
  through the real `skill_queue.decide()`. I sabotaged it by bypassing the
  coordinator **while keeping the import** — the precise refactor it claims to
  catch — and **all 13 tests in the file failed**. Restored, byte-identical,
  13 passed.
- **Inverse membership assertion fires both ways:**
  ```
  sibling retained root      : ACCEPTED (correct)
  dotfile-inside-published   : REJECTED (correct) -> SkillPublicationError
  ```
  The exact trap from defect 4 is now structurally refused.
- Second invalidation after restore present (`runtime_quiescence.py:508`).
- `committing` phase written before `_save_state`; three journal sites
  (`:277/:381/:471`) so `rollback()` is covered, not just `activate()`.

All 13 required adversarial cases exist as named tests: busy-blocks, exact
active-task count, invalidation failure, commit failure with exact-content
restore, verify failure, first-time failure leaves nothing published, restart
cannot silently complete, approval reusable, fresh-real-loader visibility,
mid-transaction scan yields exactly one match, concurrent approve, and
success-side crash reconciliation.

---

## What is NOT done

1. **G2A review.** Nobody has adversarially graded this. The Builder never
   produced its sabotage table or final report — it died mid-run. My spot
   checks above are not a substitute for a full G2A pass.
2. **Not committed, not pushed.** Uncommitted in the worktree.
3. **The Builder's own choices are unreviewed** — in particular which
   idempotency approach it took for the success-side crash (deterministic
   digest recognition vs. `queueId` in the provenance sidecar), and whether
   `file_digest()`'s `"sha256:<hex>"` form vs. the bare-64-hex form is handled
   correctly at every boundary. **Check this**: P2-1a tests assert
   `len(digest) == 64` while `file_digest()` returns the prefixed form.
4. **Re-specified tests need review.** `test_verified_skill_store.py` (+107
   lines) and `test_run_admission.py` (+82) were modified. Some existing cases
   asserted recovery from a `prepared` journal — behavior deliberately removed.
   Confirm each change was re-specified deliberately, not weakened to pass.
5. **Unverified, flagged by G1R:** whether the on-disk snapshot manifest
   (`prompt_builder.py:977-987`) detects a restore via mtime/size. This
   changes the severity of defect 7.
6. **GS-ACCEPT not run.** 15 steps, needs a real `AIAgent` boot.

---

## Sequence from here

```
1. G2A on the gs-coord worktree      <-- NEXT
2. Operator merge gate → commit → push
3. GS-ACCEPT (15 steps, real AIAgent)
4. Governed-skills soak → default-on
5. C1 surface identity RUNTIME build
```

C1 PRD/design may proceed in parallel. **Do not start the C1 runtime build
until GS-ACCEPT passes** — no new runtime surface on an unvalidated foundation.

### GS-ACCEPT, verbatim

1. Start with the flag off; verify legacy behavior unchanged.
2. Restart with governed skills enabled.
3. Generate/stage an actual skill.
4. Review the exact digest.
5. Approve.
6. Verify publication lands in the real Hermes `external_dirs` path.
7. Start a fresh Hermes task.
8. Prove the skill is present in the model's usable skill index.
9. Roll back / disable it.
10. Start another fresh task.
11. Prove the removed version is no longer usable.
12. Restart the entire stack.
13. Prove governed active state remains correct.
14. Failure cases: live task blocks mutation · cache-clear failure · audit full
    · malformed skill · digest changed after approval.
15. Only then consider promotion.

Steps 7–8 and 10–11 are the ones no unit test substitutes for: they need a real
`AIAgent` boot and a rendered system prompt. Everything shipped so far proves
discoverability through the loader's *functions*, never through a live model turn.

Promotion path after it passes: `v0.x` opt-in → soak → default ON next release
→ legacy behind an explicit compatibility flag.

---

## Environment traps that will cost you an hour each

- **`git submodule update` leaves `vendor/hermes-agent` EMPTY** and a plain
  clone takes 25+ min or fails. Copy the working checkout instead:
  `cp -r /e/TorqClaw/engines/hermes_kernel/vendor/hermes-agent/. <wt>/engines/hermes_kernel/vendor/hermes-agent/`
  then **delete the copied `.git` FILE** — it is a `gitdir:` pointer that breaks
  every git command in the worktree with "not a git repository". Then
  `uv pip install -e ./vendor/hermes-agent`.
- **The Bash tool's cwd drifts into the vendored submodule**, whose git repo is
  upstream Nous, not TorqClaw. Always `git -C /e/TorqClaw`.
- **`tsc` can exit 0 without emitting** (incremental cache). A stale `dist/`
  once let a "fixed" auth hole stay wide open while 14 unit tests passed. For
  any control that must hold at runtime, **boot the real binary**.
- **`tests/collab/harness.test.ts`** asserts 1,000,000 UUIDs in under 30s;
  this machine takes ~48s under load, passes when idle. Correctness (zero
  duplicates) passes. Pre-existing from Slice 0 — not a regression.
- **`tests/collab/fanout-unit.test.ts`** C1 probe is load-sensitive the same
  way. Re-run isolated before calling either a regression.

## Uncommitted work in the MAIN tree that is NOT GS-COORD

`E:\TorqClaw` has modifications from a different lane (C0.1 surface credential
verification): `server.ts`, `sessions.ts`, `commands.ts`, `ConnectFrame.json`,
`collabIdentity.ts`, plus `ops/reachability.mjs` and `tests/reachability.test.ts`
edits that removed `packages/collab` from DORMANT. That work is not mine and not
covered by this handoff — do not conflate it with GS-COORD.

## Standing principle this program produced

> **Reachability proves code is live. Invariant-path tests prove the correct
> control is live on the correct operation.**

`pnpm reachability` (CI, `ops/reachability.mjs`) enforces the first. It cannot
prove the activation path uses the coordinator — that is what
`test_activation_coordinator_wiring.py` is for. Every future governance control
needs both.
