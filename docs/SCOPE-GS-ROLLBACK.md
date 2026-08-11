# SCOPE — GS-ROLLBACK

**Status:** G1R PASS-WITH-CHANGES (2026-08-10, round 1) — the five required
edits are incorporated below; build authorized.
**Date:** 2026-08-10
**Predecessors:** GS-COORD (shipped, `c824bcd`), GS-ACCEPT (conditional pass,
`6a28621`/`7e2a3f1`).
**Closes:** GS-ACCEPT finding **F-1 (BLOCKING)**.
**Sequence position:** GS-COORD ✅ → GS-ACCEPT ✅(conditional) → **GS-ROLLBACK**
→ re-run GS-ACCEPT → soak → governed default-on → C1 runtime → Phase 4.

---

## 1. Problem — measured, not hypothesized

GS-ACCEPT step 11 (pinned as `xfail` in
`engines/hermes_kernel/tests/acceptance/test_gs_accept.py:322`) measured:

```
after v2  | published: v2 bad
after rb  | governed active digest == v1
after rb  | published: v2 bad          <-- diverged
```

Two defects, one lane:

1. **`VerifiedSkillStore.rollback()` (verified_skill_store.py:444) flips
   governance only.** It re-reads and re-validates the installed package,
   updates `state["active"]`, journals, audits — and never touches the
   published projection in `skills.external_dirs`. The operator sees
   "rolled back"; `build_skills_system_prompt()` keeps rendering the
   reverted content. The failure is **silent** because governance reports
   success.
2. **`store.rollback()` has no production caller.** Not `governed_skills`,
   not the gateway, not the console. `governed_skills.py:328` says the
   governed path is "rollback-capable" — the unenforced-claim pattern
   (4th recorded instance): a capability that exists as a method and is
   reachable from no operator surface.

Consequence recorded in GS-ACCEPT: governed skills stay
**default-off** (`TORQCLAW_GOVERNED_SKILLS`) until an operator can actually
undo a bad skill through a shipped surface.

## 2. Goal

An operator can roll a governed skill back to an exact previously installed
digest through a shipped surface, and after the call returns success:

- governed-active digest == target digest,
- the **published bytes on disk** hash to the target digest,
- the prompt cache has been invalidated under the same lock hold,
- a fresh `AIAgent` boot renders the target version and not the superseded
  one (GS-ACCEPT steps 9–11 pass with the `xfail` removed),
- on any failure the prior projection is restored and governance stays
  conservative, with the same unproven-state error taxonomy the install
  path already has.

## 3. Design

### 3.1 Kernel API — `governed_skills.rollback_governed_skill(skill_id, digest)`

A sibling of `install_approved_skill()` (governed_skills.py:321), running the
same four-callback `ActivationCoordinator` transaction
(runtime_quiescence.py:371). No new transactional machinery; the lane is
almost entirely composition of shipped primitives:

```
validate id + normalize digest
fail fast: state["installed"][sid][digest] must exist  (store.rollback
    already enforces this, but checking before the coordinator's lock/
    quiescence gate keeps "unknown digest" a cheap, mutation-free error)
idempotent fast path: already governed-active at target AND published
    bytes verify at target -> return {reconciledFromPriorSuccess: true}
    (mirror _already_active_and_published, governed_skills.py:260, which
    already does byte-level _verify_published_digest, not sidecar trust)

ActivationCoordinator(
  publish  = skill_publisher.publish_skill(
                 store.versions_dir / sid / digest,   # immutable installed pkg
                 digest=digest,
                 source="torqclaw:operator-rollback",
                 retain_replaced_into=retain_root),
  restore  = same ordering as install's _restore (governed_skills.py:420):
                 1) revert governance FIRST if commit landed
                    (revert_activation with the pre-commit snapshot),
                 2) restore_retained_projection,
                 3) publisher-restore failure after a landed-then-reverted
                    commit raises GovernanceRevertedProjectionUnprovenError,
  commit   = snapshot previous = raw state["active"].get(sid)  THEN
             locked_store.rollback(sid, digest); record the snapshot into
             commit_holder ONLY after rollback() returns (the GS-COORD
             round-3 lesson: a holder populated before the flip makes the
             revert assertion vacuous),
  verify   = get_active(sid).digest == digest
             AND skill_publisher.is_published(sid)
             AND _verify_published_digest(published_skills_dir()/sid,
                                          expected_digest=digest)
).run()
```

Design points that are load-bearing:

- **`verify` must hash the published bytes against the target digest**
  (`_verify_published_digest(published_skills_dir()/sid, expected_digest=
  digest, skill_id=sid)` — the `skill_id` kwarg is required,
  skill_publisher.py:683). Precision from G1R: the control that closes F-1
  is **the publish callback existing at all** — `publish_skill` already
  re-verifies its own write (skill_publisher.py:555), so in the
  un-sabotaged flow verify's digest check is redundant. Its value is as the
  **deletion-probe tripwire**: without it, probe #1 (no-op publish) would
  leave `is_published(sid)` vacuously green with the superseded bytes still
  on disk — exactly F-1. Install's `_verify` checks only `is_published`
  (governed_skills.py:523), which is sufficient there for the same
  publish-side reason.
- **`previous` snapshot timing** follows the GS-COORD round-3 fix verbatim
  (governed_skills.py:406–417): record only after the governed flip returns,
  so `restore` can distinguish "commit never landed" from "commit landed,
  revert it".
- **`revert_activation` with no approval token.** Install's revert passes the
  approval token to un-consume it (verified_skill_store.py:400). Rollback of
  a capability-equal digest consumes no approval, so the revert passes
  `approval_token=None`. G1R confirmed every internal use tolerates `None`
  (journal JSON-safe at :390; `isinstance(..., dict)` guard at :400-402;
  reconcile's `isinstance(token, str)` at :698) — the build widens the type
  hint to `str | None` and pins the behavior with a unit test. Never a fake
  token.
- **Capability deltas stay out of scope — with one reachable edge (G1R
  finding 6).** `_build_package` fixes `requiredCapabilities` to `["read"]`
  (governed_skills.py:247), and `_current_permissions` ignores `enabled`
  (verified_skill_store.py:869-874), so any skill with an active entry —
  even disabled — rolls back with no approval. **But** a skill that is
  installed and has *no* active entry (reachable: first-time install whose
  verify failed → `revert_activation(previous=None)` deletes the active key
  at :396-397 while the installed record survives) makes
  `_current_permissions` return `()`, `added == ["read"]`, and
  `store.rollback()` raise `SkillApprovalError` (:472-476).
  `rollback_governed_skill` takes **no approval parameter** and propagates
  that error unmodified; the `rollback_skill` tool maps it to a distinct,
  non-retryable `SKILL_ROLLBACK_TARGET_NEVER_ACTIVE` result telling the
  operator to re-approve through the normal install path instead. Unit test
  pins the state. A fresh-approval flow for genuinely capability-adding
  rollbacks stays deferred until a governed skill can have capabilities
  other than `["read"]` — building it now would be untestable dead code.
- **`retain_root` naming:** install keys the per-transaction retained dir on
  `stageId`. Rollback has no stage; key on a fresh transaction uuid
  (`published_skills_retained_root() / f"rollback-{uuid4().hex}"`). Cleanup
  obligations are identical to install's (success: discard + rmtree;
  failure: restore + rmtree in `_restore`).
- **Errors propagate with the install path's exact taxonomy** so
  `skill_queue`-style callers keep their guarantees: `SkillRuntimeBusyError`
  (retryable, nothing changed), `SkillActivationCoordinationError` (clean
  restore), `SkillActivationRestoredButCacheUnprovenError` and
  `GovernanceRevertedProjectionUnprovenError` (both non-retryable,
  operator-inspect).

### 3.2 Operator surface — MCP tools in `server.py`

F-1's second half is reachability. Two new tools beside `decide_skill`
(server.py:412):

- **`rollback_skill(skill_id, digest) -> dict`** — calls
  `rollback_governed_skill`, mapping errors to the same result shapes
  `skill_queue.decide()` uses: `SKILL_RUNTIME_BUSY` (retryable),
  `SKILL_PROJECTION_UNPROVEN_AFTER_REVERT` and
  `SKILL_ACTIVATION_CACHE_UNPROVEN` (non-retryable), generic failure
  (retryable, clean slate). When `governed_skills.enabled()` is false it
  returns a plain error — rollback has no legacy-path fallback, and must
  not invent one.
- **`list_skill_versions(skill_id) -> dict`** — versions with digest **and
  `installedAt`** (G1R finding 10: `list_installed` exposes neither
  timestamps nor any other ordering signal — governed versions all carry
  the fixed version `"1.0.0"`, so bare digests are indistinguishable and
  unpickable). `installedAt` exists in the state record
  (verified_skill_store.py:929-937) and is surfaced via a new read-only
  store method (`list_installed` itself stays untouched — its raise-on-
  tamper behavior has existing callers). The new method is
  **tamper-tolerant**: a version directory that fails package validation is
  returned as `{digest, tampered: true}` and skipped as a rollback
  candidate, instead of one corrupt record killing the whole listing —
  which is exactly when rollback is most needed. The response also carries
  the current governed-active digest and the published digest so divergence
  is visible. Read-only; no quiescence requirement.

The error-shape mapping is shared with `skill_queue.decide()` by extracting
its `except` arms into one helper rather than copying them — two copies of
that taxonomy will drift. G1R finding 9: the helper must be
**parameterized** — `decide()`'s arms embed queue semantics
(`"status": "pending"` in every arm; the busy arm's `activeTasks` count and
wording) that are nonsense for a rollback with no queue row. `decide()`
passes values that keep its output **byte-identical**; `rollback_skill`
omits `status`. The `activeTasks` count is a kernel fact and stays in both.

**Scope ruling (for G1R to challenge):** the MCP tool *is* the operator
surface for this lane — it is what the gateway calls, exactly as
`decide_skill` is how console approval already reaches the kernel. Console
UI (a rollback button/version picker) is gateway/console work under the
collab-gateway sequencing rulings and is **out of scope** here; the lane is
done when the capability is reachable by the gateway, not when it is
pretty. This mirrors how GS-COORD shipped `decide_skill`-path governance
without new console chrome.

### 3.3 Recorded residues (G1R gaps G-1..G-3 — documented, not fixed here)

- **Crash window (G-1):** a crash between `publish` and `commit` leaves
  published=target vs governed=prior with no reconciler that heals it — the
  store journal for the rollback tx does not exist yet at that point and
  the coordinator keeps no durable journal. An operator **retry heals it**:
  the idempotent fast path correctly refuses (governance not yet at
  target), and the full run re-publishes + commits. Orphaned
  `published_skills_retained/rollback-*` dirs can accumulate across
  crashes. This is the **same exposure the install path already has** —
  recorded here so a GS-ACCEPT re-run doesn't "discover" it as new.
- **Lock topology (G-2):** `decide()` orders `skill_queue._lock →
  _MUTATION_LOCK`; the rollback tool takes only `_MUTATION_LOCK`; no path
  takes the inverse order — no deadlock, and same-skill install/rollback
  races serialize on `_MUTATION_LOCK`.
- **Re-enable semantic (G-3):** `store.rollback()` unconditionally writes
  `enabled: True` (verified_skill_store.py:498-502), so rolling back a
  `disable()`d skill re-enables it. Consistent with "activate one exact
  digest"; the `rollback_skill` tool docstring must say so explicitly,
  since GS-DISABLE is deferred.

### 3.4 Claim hygiene

- `governed_skills.py:328` "rollback-capable" becomes true; reword to point
  at `rollback_governed_skill`.
- README's verified-skills section gains one line: rollback exists, is
  governed, and re-publishes; **disable/removal still does not exist** (see
  §5).

## 4. Tests

### 4.1 Unit (new file, `tests/governed_rollback` or alongside existing governed tests)

1. Happy path: install v1, install v2, rollback → governance v1, published
   bytes hash to v1, rendered prompt (via the real
   `build_skills_system_prompt()`, not `iter_skill_index_files` — the
   mtime-cache trap) shows v1 content.
2. Unknown digest → typed error, **zero mutation** (state.json and published
   dir byte-identical before/after).
3. Runtime busy → `SkillRuntimeBusyError`, zero mutation.
4. Verify-failure injection → projection restored to v2, governance stays
   v2, coordinator raises `SkillActivationCoordinationError`.
5. Commit-failure injection (rollback() raises) → `commit_holder` empty,
   restore does NOT call revert_activation, projection restored.
6. Publisher-restore-failure after landed commit →
   `GovernanceRevertedProjectionUnprovenError`.
7. Idempotent re-run: rollback to the already-active digest →
   `reconciledFromPriorSuccess`, no coordinator run.
8. `revert_activation` with `approval_token=None` does not corrupt the
   approvals table.
9. MCP-surface tests: `rollback_skill` error-shape mapping; governance-off
   returns the error, not a legacy write; `list_skill_versions` shows
   active/published divergence when seeded with one.
10. Installed-but-never-active target (G1R finding 6): seeded by a failed
    first install → `SkillApprovalError` from the store, mapped to
    `SKILL_ROLLBACK_TARGET_NEVER_ACTIVE` at the tool.
11. Tamper-tolerant listing: corrupt one version dir → listing still
    returns, corrupt entry flagged `tampered: true`.
12. Helper extraction is behavior-preserving: `decide()`'s failure shapes
    byte-identical before/after (pin with golden-dict assertions).

### 4.2 Deletion probes (the six-gate method, GS-COORD)

Each control gets a probe; **green after deletion = uncovered = not done**:

| # | Deleted control | Expected red |
|---|---|---|
| 1 | the `publish` callback's actual re-publish (make it a no-op) | happy-path published-bytes hash + acceptance step 11 |
| 2 | digest check in `verify` (drop `_verify_published_digest`) | verify-failure test seeded with divergent published bytes — seeding **must monkeypatch the publish callback** to write stale bytes and report success; `publish_skill` itself cannot produce divergence, its own post-write verification would raise first (G1R finding 5) |
| 3 | `previous` snapshot timing (record before the flip) | commit-failure test (vacuous-revert detector) |
| 4 | governance-first ordering in `restore` | publisher-restore-failure test |
| 5 | `rollback_skill` tool wiring (unregister it) | surface test + a grep-based reachability assertion |
| 6 | error-taxonomy mapping (collapse UNPROVEN into generic retryable) | shape tests for the two non-retryable codes |

### 4.3 Acceptance

Rewrite `test_steps_09_to_11_rolled_back_version_is_not_usable` to call
**the production surface** (`rollback_governed_skill`, not
`VerifiedSkillStore` directly — the current direct-store call was itself a
symptom of there being no production path), delete the `pytest.xfail`, and
assert the fresh-boot rendered prompt contains v1 and not v2. Then re-run
the full GS-ACCEPT suite; target 14/15 (F-2 remains the one xfail).

## 5. Non-goals — recorded, not smuggled

- **Disable/removal API** (the other half of GS-ACCEPT step 9: unpublish a
  skill entirely). `store.disable()` exists (verified_skill_store.py:429)
  and has the *same* defect shape (governance-only, no caller) — but
  un-publishing is a different projection operation (delete vs replace)
  with its own restore semantics. Separate lane (**GS-DISABLE**), filed in
  the memory graph; folding it in doubles the surface under review.
- **F-2** (empty-skill lower bound) — its own `xfail` stands.
- Capability-adding rollback approvals (§3.1).
- Console UI (§3.2 scope ruling).
- Any change to `activate()`, the journal protocol, or `reconcile()`.

## 6. Gates and authority

- **G1R** (this doc) before any build. **G2A** after build — verification
  authority only, never publication authority.
- Build on a branch (`gs-rollback-work`), rebase onto master before merge,
  run `git diff --diff-filter=D --name-only master gs-rollback-work` before
  merging, check test **names** not counts.
- Merge and push each require explicit operator approval.
- Unit gate must stay green (303 passed / 1 skipped baseline) and
  `pnpm reachability` must stay PASS.
- GS-ACCEPT re-run is part of this lane's definition of done; soak and
  default-on remain operator decisions after it.

## 7. Estimate

GS-COORD-shaped but smaller: the coordinator, publisher retain/restore, and
error taxonomy all exist. ~200 lines of product code (one function + two
tools + one shared error-mapper), ~400 lines of tests. The unbounded tail is
the same as always: what the deletion probes find.

## 8. Build record (2026-08-10)

Build commit `56c1964` on `gs-rollback-work`; G2A round-1 fixes follow it.

### Deletion probes — all six RED, then restored

| # | Deleted control | Result |
|---|---|---|
| 1 | `_publish` made a no-op reporting success | **RED** — 10 failures; the verify digest tripwire caught it everywhere including the happy path |
| 2 | `_verify_published_digest` dropped from `verify` | **RED** — `test_verify_catches_a_publish_that_lied_about_the_bytes`: DID NOT RAISE |
| 3 | `commit_holder["previous"]` recorded before the governed flip | **RED** — `test_commit_failure_restores_projection_without_a_governed_revert` (vacuous-revert detector) |
| 4 | Restore ordering inverted (projection before governance) | **RED** — raw `OSError` escaped instead of `GovernanceRevertedProjectionUnprovenError` |
| 5 | `rollback_skill` tool unregistered | **RED** — `test_rollback_tools_are_registered_on_the_server` |
| 6 | Failure taxonomy collapsed to generic retryable | **RED** — golden-shape mapper test |

### G2A round 1 — REJECT, one BLOCKING defect (fixed)

`GovernanceRevertedProjectionUnprovenError` **extends** `GovernedSkillError`
and propagates UNWRAPPED out of the coordinator's restore path, so
`skill_rollback.rollback`'s invalid-target arm (placed first) swallowed it
and mislabelled the one must-inspect-disk state as
`SKILL_ROLLBACK_INVALID_TARGET`. G2A reproduced it live through the shipped
surface. Root cause of the test gap: every failure-taxonomy assertion
stopped at the kernel or the bare mapper — probe 6 tested the wrong layer.
Fix: the subclass arm now precedes and routes through the shared mapper;
`test_surface_reports_unproven_projection_not_invalid_target` drives the
exception through the surface and pins the returned dict.

Ride-alongs fixed: `skill_queue.py` comment named a nonexistent enforcement
point (test lives in `test_governed_rollback.py`, not `test_skill_queue.py`);
README §Verified-skills gained the GS-ROLLBACK paragraph promised in §3.4
(including the re-enable semantic and the still-missing disable surface);
the round-1 commit message's unit-gate count said 324 — the correct count on
that tree is **325 passed / 1 skipped / 10 deselected** (G2A re-derived it).

G2A NOTEs recorded, deliberately not fixed in this lane: `list_versions`
dies on a hand-corrupted `state.json` with non-dict records (tamper
tolerance is scoped to version *directories*); the idempotent fast path
reads outside `_MUTATION_LOCK` (pre-existing, shared with install);
`publish_skill` can raise after mutating the projection with the coordinator
treating it as nothing-to-restore (pre-existing, shared with install);
acceptance's `_rendered_skill_index` clears the prompt cache itself, so
step 11 proves projection movement, not cache invalidation (covered at unit
level).
