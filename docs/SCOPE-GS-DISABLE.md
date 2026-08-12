# SCOPE — GS-DISABLE

**Status:** BUILT (2026-08-11) — awaiting G2A.
**Date:** 2026-08-11
**Predecessors:** GS-COORD (shipped), GS-ACCEPT (conditional pass),
GS-ROLLBACK (shipped, `eaa6632`).
**Closes:** the disable half of GS-ACCEPT step 9, and GS-ACCEPT finding
**F-2** (empty skill body).
**Sequence position:** GS-COORD ✅ → GS-ACCEPT ✅(conditional) →
GS-ROLLBACK ✅ → **GS-DISABLE** → soak / live operation → C1 runtime →
Phase 4.

---

## 1. Problem — the same defect shape, one lane later

`VerifiedSkillStore.disable()` (verified_skill_store.py:433) was recorded as
a GS-ROLLBACK non-goal (§5 of SCOPE-GS-ROLLBACK) with the observation that
it "has the *same* defect shape" as `rollback()` did. Measured, that shape
is:

1. **Governance-only.** `disable()` flips `state["active"][sid]["enabled"]`
   to `False`, appends an audit entry, saves state — and never touches the
   published projection in `skills.external_dirs`. The operator is told the
   skill is off; `build_skills_system_prompt()` keeps rendering it into
   every turn.
2. **No production caller.** Not `governed_skills`, not the gateway, not
   the console. The 5th recorded instance of the unenforced-claim pattern.

This is strictly worse than rollback's version of the bug. A bad rollback at
least swaps one working version for another; a bad disable means the
operator believes a skill has been switched off while the model keeps
receiving and using it. There is no newer version to mask the failure.

## 2. Goal

An operator can disable a governed skill through a shipped surface, and
after the call returns success:

- governed state shows the skill disabled (`enabled: False`), with the
  installed digest history **preserved**,
- the skill is **not published** — the bytes are gone from every directory
  the real Hermes loader scans,
- the prompt cache was invalidated under the same lock hold,
- a fresh `AIAgent` boot does **not** render it,
- on any failure the retained projection is restored and governance stays
  conservative (**enabled**), with the same unproven-state error taxonomy
  install and rollback already have.

## 3. Design

### 3.1 Kernel API — `governed_skills.disable_governed_skill(skill_id)`

A sibling of `install_approved_skill()` and `rollback_governed_skill()`,
running the same four-callback `ActivationCoordinator` transaction with the
projection step pointed at removal instead of replacement:

```
validate id
fail fast: store.has_active_entry(sid) must be true  (mutation-free, before
    the coordinator's lock/quiescence gate; store.disable() raises a bare
    SkillStoreError the surface cannot distinguish from a transaction
    failure)
idempotent fast path: already disabled AND already unpublished -> return
    {reconciledFromPriorSuccess: true}, no transaction. BOTH halves are
    required -- disabled-but-published is the divergence this lane exists
    to heal, and must fall through.

ActivationCoordinator(
  publish  = skill_publisher.retain_unpublish_skill(sid,
                 retain_into=retain_root),   # NEW primitive, §3.2
  restore  = same ordering ruling as install/rollback:
                 1) revert governance FIRST if the commit landed
                    (revert_activation with the pre-commit snapshot, which
                    restores enabled: True),
                 2) restore_retained_projection,
                 3) a publisher-restore failure after a landed-then-reverted
                    commit raises GovernanceRevertedProjectionUnprovenError,
  commit   = snapshot previous = raw state["active"].get(sid)  THEN
             locked_store.disable(sid); record into commit_holder ONLY
             after disable() returns (the GS-COORD round-3 lesson),
  verify   = get_active(sid) is None
             AND raw state["active"][sid] exists with enabled falsy
             AND NOT skill_publisher.is_published(sid)
).run()
```

Design points that are load-bearing:

- **"publish" un-publishes, deliberately.** The coordinator's contract is
  "`publish` makes the desired projection state live and returns what
  `restore` needs to undo it". For a disable the desired state is *absent*
  and what restore needs is the removed directory. No coordinator change was
  required; reading the contract literally was enough.
- **`verify` must check `not is_published`.** This is the control that
  closes the lane's failure shape and the deletion-probe tripwire for a
  no-op unpublish. Without it, governance would report disabled while the
  bytes kept rendering — the defect verbatim.
- **`verify` must ALSO check the raw entry still exists and is disabled.**
  `get_active()` returns `None` both for a disabled entry and for a missing
  one, so `None` alone would pass vacuously if the entry were deleted
  instead of flipped. Installed history surviving is what keeps rollback
  available as the re-enable path.
- **Conservative direction for a disable is ENABLED.** Install/rollback
  revert to "the prior digest"; here the prior state is enabled-and-
  published. That is the safer failure direction for the same reason as
  always: enabled-and-published is a coherent pre-call state an operator can
  retry from, whereas disabled-but-possibly-published is precisely the
  silent divergence.
- **`revert_activation` with no approval token.** A disable consumes no
  approval, so `approval_token=None` — never a fake token. `previous` is
  provably non-None on that branch (commit_holder is only populated after
  `disable()` returned, and `disable()` raises without an active entry).
- **`retain_root` naming:** keyed on a fresh transaction uuid
  (`published_skills_retained_root() / f"disable-{uuid4().hex}"`), matching
  rollback's scheme. Cleanup obligations identical.

### 3.2 New publisher primitive — `retain_unpublish_skill`

`unpublish_skill` *deletes* the projection (retire-then-`_remove_tree`), so
a verify failure would have nothing to restore and the skill would stay gone
despite governance being reverted — the divergence mirrored onto the removal
side. `retain_unpublish_skill(skill_id, *, retain_into)` instead moves the
projection OUT of the loadable tree in one `os.replace` and returns its
`retainedPath`, with retention semantics identical to `publish_skill`'s
`retain_replaced_into` branch and for the identical reason: dot-prefixed
directories are **not** excluded by upstream's `EXCLUDED_SKILL_DIRS`, and
`.` sorts before alphanumerics, so a retained copy left inside the tree
would win prompt_builder's first-wins dedup and keep rendering.

The inverse-membership gate (`_assert_retention_root_outside_loadable_tree`)
runs BEFORE the projection is touched, so a refused call never unpublishes.
Idempotent: unpublishing what is not published returns
`{removed: False, retainedPath: None}`.

### 3.3 Operator surface

- **`skill_rollback.disable(skill_id) -> dict`** — same dict shapes and
  never-raising contract as `rollback`. Governed-only (no legacy fallback:
  the legacy path has no governed state to disable, and silently deleting an
  operator's files would be a worse defect than refusing). Queue-free, so no
  `status` key. New code `SKILL_DISABLE_INVALID_TARGET` for the
  pre-mutation refusals, distinct from rollback's because the operator
  remedy differs.
- **`disable_skill(skill_id)` MCP tool** in `server.py`.
- **`list_skill_versions` reflects disabled state.** `get_active()` filters
  on the enabled flag, so a disabled skill and a never-active one both
  surfaced `activeDigest: None` — indistinguishable, and after this lane
  those two states have completely different remedies (roll back to
  re-enable, versus re-approve through install). Added `disabled` and
  `disabledDigest`, read from the raw entry.

**The arm-ordering trap is reproduced verbatim here.**
`GovernanceRevertedProjectionUnprovenError` extends `GovernedSkillError` and
propagates UNWRAPPED out of the coordinator's restore path, so an
invalid-target arm placed first swallows it — GS-ROLLBACK's G2A round-1
BLOCKING defect. `disable`'s subclass arm precedes and routes through the
shared `map_activation_failure`, and the pin is a **surface-level** test
(`test_surface_reports_unproven_projection_not_invalid_target`), not a
kernel one. That is the G2A lesson applied prospectively rather than after a
rejection: pin taxonomies at the surface the operator calls.

### 3.4 Re-enable is rollback, by design

`rollback_governed_skill` already re-enables (`store.rollback()` writes
`enabled: True` unconditionally) AND re-publishes an exact digest through
this same transaction. GS-DISABLE therefore ships **no** second enable path.
A separate enable would either duplicate that function or — worse —
re-enable governance while guessing which digest to republish. The
previously-documented "rolling back a disabled skill re-enables it" is
promoted from an accident-to-document-around to the designed inverse, and
pinned by a round-trip test.

## 4. Deliverable 2 — F-2, the empty skill body

Package validation bounded `SKILL.md` from ABOVE only (`MAX_SKILL_BYTES`),
so an empty body was structurally valid — digests matched, the manifest was
consistent, and a 0-byte `SKILL.md` was published that renders nothing. Not
a security hole, but a governance lie: the approval record claims a
capability that provably does not exist.

Fix: `MIN_SKILL_BYTES` enforced in `verified_skill_store._read_package` —
the **validation seam**, not the install caller, so every read path (stage,
activate, rollback, get_active, list_installed, reconcile) is covered rather
than the one caller that exists today. A rule placed at a single call site
is the unenforced-claim pattern in miniature. Typed as
`SkillEmptyBodyError(SkillValidationError)` — a subclass, so every existing
fail-closed handler keeps working unchanged, but typed separately so a
surface can say "your skill body is empty" instead of "package is invalid".

The bound is "at least one non-whitespace byte", not `len > 0`: a body of
nothing but newlines is equally inert. `skill_publisher._read_source_package`
gets the matching check, because that module validates packages
independently of the store (it deliberately does not import the store's
private validator) and would otherwise be a bypass seam.

**Nothing depended on empty bodies** — checked across the test suites; every
package helper writes non-empty content, and the only empty-body call site
was the F-2 xfail itself.

## 5. Tests

New file `engines/hermes_kernel/tests/test_governed_disable.py`, **32
tests**, mirroring `test_governed_rollback.py`'s structure:

- Core closure: governance + projection move together; absent from the REAL
  rendered system prompt (`build_skills_system_prompt`, not
  `iter_skill_index_files` — the mtime-cache trap); gone from the real
  loader scan; no retained projection left behind.
- Re-enable round trip via rollback, including rolling back to an older
  digest after a disable.
- Zero-mutation refusals: unknown skill, malformed ids, installed-but-never-
  active, busy runtime.
- Failure paths: verify-failure restore; no-op-unpublish caught by verify;
  commit-failure with **no** vacuous revert; publisher-restore failure after
  a landed commit reported unproven; the unproven shape asserted at the
  OUTERMOST surface.
- Idempotency: already-disabled no-op; disabled-but-published healed;
  enabled-but-unpublished healed.
- Surface shapes: governance-off refusal, success/invalid-target, no
  `status` key.
- `list_versions` disabled-vs-never-active distinction.
- Publisher primitive: retention leaves the loadable tree; no-op on
  unpublished; refuses a retention root inside the tree without unpublishing.
- Reachability: `disable_skill` registered on the MCP server.
- F-2: empty and whitespace-only refused; subclass relationship; publisher
  refuses independently.

Acceptance (`test_gs_accept.py`):
- new `test_step_09b_disabled_skill_leaves_the_rendered_prompt` drives the
  **production surface** (`skill_rollback.disable`), boots a real `AIAgent`,
  and asserts the rendered index no longer contains the skill — then that
  rollback restores it.
- step 9's stale scope note ("the governed path exposes no disable/removal
  API") removed; both halves are now satisfied.
- the F-2 `xfail(strict=True)` flipped to a hard test.

## 6. Deletion probes — all six RED, then restored

The six-gate method. Green after deletion = uncovered = not done.

| # | Deleted control | Result |
|---|---|---|
| 1 | `_publish` made a no-op reporting success (nothing unpublished) | **RED** — 13 failures, including the rendered-prompt and loader-scan assertions |
| 2 | `not is_published` check dropped from `verify` | **RED** — 4 failures: verify-failure restore, no-op-unpublish tripwire, unproven-projection (kernel + surface) |
| 3 | `commit_holder["previous"]` recorded BEFORE the governed flip | **RED** — `test_commit_failure_restores_projection_without_a_governed_revert` (the vacuous-revert detector) |
| 4 | Restore ordering/taxonomy control removed (projection restore no longer wrapped, governance-first guarantee dropped) | **RED** — 2 failures; the surface test showed the taxonomy degrading to generic retryable `SKILL_ACTIVATION_FAILED` |
| 5 | `disable_skill` tool unregistered (`@mcp.tool()` removed) | **RED** — `test_disable_tool_is_registered_on_the_server` |
| 6 | Failure taxonomy collapsed (subclass arm no longer catches) | **RED** — surface test caught `SKILL_DISABLE_INVALID_TARGET` in place of `SKILL_PROJECTION_UNPROVEN_AFTER_REVERT` — the G2A round-1 defect shape reproduced and caught at the right layer |

Working tree verified free of probe residue afterwards (`grep -c PROBE` = 0
across `mcp_wrapper/`).

## 7. Gates

- **Unit:** `uv run pytest -q` from `engines/hermes_kernel` →
  **358 passed / 1 skipped** (baseline 326 passed / 1 skipped; +32, all
  additions, nothing removed or weakened).
- **Acceptance:** `uv run pytest tests/acceptance -m acceptance -q` →
  **11 passed / 0 xfailed** (was 10 passed / 1 xfailed; the F-2 xfail
  became a pass and step 9b was added).

## 8. Non-goals — recorded, not smuggled

- **A separate enable surface** (§3.4) — rollback is the inverse, by design.
- **Deleting a governed skill's installed history.** Disable preserves it;
  a true purge is a different operation with different audit obligations.
- **Console UI.** The MCP tool is the operator surface for this lane, the
  same scope ruling GS-ROLLBACK made.
- **Bulk / multi-skill disable.**
- Any change to `activate()`, the journal protocol, or `reconcile()`.

## 9. Residues carried forward

The crash-window (G-1) and idempotent-fast-path-reads-outside-the-lock
exposures GS-ROLLBACK recorded apply identically here — the disable
transaction shares the coordinator and the same fast-path shape. Recorded so
a G2A or a GS-ACCEPT re-run does not "discover" them as new.

One disable-specific note: a crash between the unpublish and the governed
commit leaves the skill unpublished while governance still says enabled. A
retry heals it (the fast path correctly refuses — governance is not yet
disabled — and the full run re-runs the transaction, whose unpublish is
idempotent). This is the mirror of rollback's G-1 and is covered by
`test_enabled_but_unpublished_is_healed_not_short_circuited`.

## 10. G2A round 1 (2026-08-11) — APPROVE-WITH-NOTES, one defect fixed

The disable transaction survived every attack (inverted publish contract,
conservative-enabled failure direction, lock/idempotency, taxonomy arm
ordering, probe reproduction, merge-simulated 225-check PRD gate: exactly
neutral). The one real defect was in F-2's blast radius onto a path this
lane did not touch:

**Finding 3 (fixed same day): F-2 retroactivity made a legacy empty-body
skill UNDISABLEABLE.** `MIN_SKILL_BYTES` lives in `_read_package`, and
`store.disable()` called `_artifact_from_installed` purely to build its
audit record — so a pre-F-2 empty-body skill (legal when installed) failed
validation inside `disable()` itself, with `retryable: true` advertising a
retry that could never succeed, rollback equally refused, and `reconcile()`
able to flip governance off while the projection kept rendering — the exact
divergence this lane closes. Fix: the audit-artifact read is now
fault-tolerant (degraded audit record on `SkillStoreError`); disable never
depends on the package validating, because an invalid package is precisely
when disable matters most. Regression:
`test_legacy_pre_f2_empty_body_skill_can_still_be_disabled` fabricates the
legacy state directly on disk and drives the production surface. Severity
was confirmed MINOR for this deployment: the live store held no governed
skills at fix time (checked empirically).

Other read paths degrade acceptably and are deliberately unchanged:
`list_versions` flags `tampered: true`, listings keep working, `reconcile`
tolerates; `get_active`/`list_installed`/`rollback` raise on such a package
by design (fail-closed reads), with disable as the always-available remedy.
