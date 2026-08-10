from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper import verified_skill_store as store_module  # noqa: E402
from mcp_wrapper.verified_skill_store import (  # noqa: E402
    MAX_AUDIT_ENTRIES,
    SkillApprovalError,
    SkillAuditCapacityError,
    SkillIntegrityError,
    SkillRecoveryError,
    SkillStoreError,
    SkillValidationError,
    VerifiedSkillStore,
    file_digest,
)


def write_package(
    root: Path,
    *,
    skill_id: str = "demo.skill",
    version: str = "1.0.0",
    permissions: list[str] | None = None,
    profiles: list[str] | None = None,
    source: str = "local:test",
    text: str = "Use the approved workflow.\n",
) -> Path:
    package = root / f"package-{skill_id.replace('.', '-')}-{version}"
    package.mkdir()
    skill_bytes = text.encode("utf-8")
    manifest = {
        "schemaVersion": 1,
        "id": skill_id,
        "version": version,
        "name": "Demo skill",
        "description": "A bounded test skill",
        "source": source,
        "files": {"SKILL.md": file_digest(skill_bytes)},
        "requiredCapabilities": permissions or ["read"],
        "compatibleProfiles": profiles or ["default"],
    }
    (package / "skill.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (package / "SKILL.md").write_bytes(skill_bytes)
    return package


def test_stage_review_activate_disable_and_exact_rollback(tmp_path: Path):
    store = VerifiedSkillStore(tmp_path / "store")
    first = store.stage(write_package(tmp_path, version="1.0.0"))

    review = store.review(first)
    assert review["digest"] == first["digest"]
    assert review["permissionDelta"] == {"added": ["read"], "removed": []}

    approval = store.approve(first, confirm_permission_delta=True)
    assert store.activate(first, approval)["enabled"] is True
    assert store.get_active("demo.skill")["digest"] == first["digest"]

    second = store.stage(write_package(tmp_path, version="2.0.0", text="New workflow.\n"))
    second_approval = store.approve(second)
    store.activate(second, second_approval)
    assert store.get_active("demo.skill")["digest"] == second["digest"]

    assert store.disable("demo.skill")["enabled"] is False
    assert store.get_active("demo.skill") is None
    restored = store.rollback("demo.skill", first["digest"])
    assert restored == {
        "ok": True,
        "skillId": "demo.skill",
        "digest": first["digest"],
        "enabled": True,
    }


def test_activation_requires_profile_compatibility(tmp_path: Path):
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, profiles=["workspace_write"]))
    approval = store.approve(staged, confirm_permission_delta=True)
    with pytest.raises(SkillApprovalError, match="not compatible"):
        store.activate(staged, approval, active_profile="read_only")
    assert store.activate(staged, approval, active_profile="workspace_write")["enabled"] is True


def test_remote_activation_requires_https_and_ed25519_metadata(tmp_path: Path):
    store = VerifiedSkillStore(tmp_path / "store")
    http = store.stage(write_package(tmp_path, skill_id="remote-http", source="http://example.test/skill"))
    with pytest.raises(SkillApprovalError, match="HTTPS"):
        store.activate(http, store.approve(http, confirm_permission_delta=True), active_profile="default")

    https = store.stage(write_package(tmp_path, skill_id="remote-https", source="https://example.test/skill"))
    with pytest.raises(SkillApprovalError, match="Ed25519"):
        store.activate(https, store.approve(https, confirm_permission_delta=True), active_profile="default")


def test_manifest_and_package_bounds_are_strict(tmp_path: Path):
    extra = write_package(tmp_path)
    (extra / "notes.txt").write_text("extra", encoding="utf-8")
    with pytest.raises(SkillValidationError):
        VerifiedSkillStore(tmp_path / "store").stage(extra)

    mismatch = write_package(tmp_path, skill_id="mismatch")
    (mismatch / "SKILL.md").write_text("changed", encoding="utf-8")
    with pytest.raises(SkillIntegrityError):
        VerifiedSkillStore(tmp_path / "store2").stage(mismatch)

    unknown = write_package(tmp_path, skill_id="unknown")
    manifest_path = unknown / "skill.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["unexpected"] = True
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(SkillValidationError):
        VerifiedSkillStore(tmp_path / "store3").stage(unknown)


def test_path_containment_and_reparse_entries_fail_closed(tmp_path: Path):
    package = write_package(tmp_path, skill_id="contained")
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(package)
    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(SkillValidationError):
        store.review({"path": str(outside)})

    linked = tmp_path / "linked"
    linked.mkdir()
    try:
        os.symlink(package / "SKILL.md", linked / "SKILL.md")
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable in this environment")
    (linked / "skill.json").write_bytes((package / "skill.json").read_bytes())
    with pytest.raises(SkillValidationError):
        store.stage(linked)

    # Keep the staged artifact used so this test also proves normal staging
    # remains usable beside an unrelated rejected package.
    assert staged["skillId"] == "contained"


def test_approval_is_bound_to_exact_digest_and_permission_delta(tmp_path: Path):
    store = VerifiedSkillStore(tmp_path / "store")
    initial = store.stage(write_package(tmp_path, skill_id="bound"))
    store.activate(initial, store.approve(initial, confirm_permission_delta=True))

    elevated = store.stage(
        write_package(tmp_path, skill_id="bound", version="1.1.0", permissions=["read", "network"])
    )
    with pytest.raises(SkillApprovalError):
        store.approve(elevated)
    approval = store.approve(elevated, allow_permission_delta=True)

    # A one-byte mutation after review changes the package digest and cannot
    # reuse the approval, even though the manifest's file digest is unchanged.
    staged_skill = Path(elevated["path"]) / "SKILL.md"
    staged_skill.write_text("tampered workflow\n", encoding="utf-8")
    with pytest.raises((SkillApprovalError, SkillIntegrityError)):
        store.activate(elevated, approval)


def test_rollback_requires_exact_previously_installed_digest(tmp_path: Path):
    store = VerifiedSkillStore(tmp_path / "store")
    package = store.stage(write_package(tmp_path, skill_id="rollback"))
    store.activate(package, store.approve(package, confirm_permission_delta=True))
    with pytest.raises(SkillStoreError):
        store.rollback("rollback", "0" * 64)


def test_reconcile_discards_a_journal_whose_save_state_never_landed(tmp_path: Path):
    """RE-SPECIFIED (GS-COORD): this used to assert that reconcile()
    COMPLETED the activation after a crash inside ``_save_state`` (the
    governed commit itself never ran -- ``_save_state`` was monkeypatched to
    raise unconditionally, so state.json was never durably written). That
    was defect GS-COORD #5: ``_reconcile_transaction`` never read
    ``tx['phase']`` and unconditionally finished any retained journal,
    meaning merely CONSTRUCTING the store completed a mutation the original
    caller's ``activate()`` call had already reported as a failure via the
    raised ``RuntimeError``.

    Under the phase-aware protocol, the journal was written in phase
    ``committing`` immediately before the (raising) ``_save_state`` call, so
    ``active`` still matches the tx's recorded ``previous`` (None here) and
    the approval is still unconsumed -- recovery must discard, not complete.
    The skill must stay inactive and the approval must remain usable for an
    explicit retry."""
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="recover"))
    approval = store.approve(staged, confirm_permission_delta=True)

    def crash(_state):
        raise RuntimeError("simulated crash")

    store._save_state = crash  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        store.activate(staged, approval)

    recovered = VerifiedSkillStore(tmp_path / "store")
    assert recovered.get_active("recover") is None
    assert list((tmp_path / "store" / "transactions").glob("*.json")) == []

    # The approval survives discard and a real retry succeeds through the
    # normal path -- proving discard did not corrupt or consume it. `store`
    # (not `recovered`) still carries the crashing `_save_state` instance
    # override, so retry against the freshly constructed `recovered` handle,
    # which has the real method.
    recovered.activate(staged, approval)
    assert recovered.get_active("recover")["digest"] == staged["digest"]


def test_reconcile_discards_a_journal_interrupted_during_install_copy(tmp_path: Path, monkeypatch):
    """RE-SPECIFIED (GS-COORD): this used to assert reconcile() RESUMED and
    completed an activation interrupted mid-``_install_version`` (phase
    ``prepared`` -- no governed commit was ever attempted, since the crash
    happens before the code even reaches the state-mutation block). Per the
    ticket's frozen protocol, a `prepared`-phase journal represents nothing
    committed and recovery must DISCARD it unconditionally, never resume or
    replay it. See ``test_reconcile_discards_a_journal_whose_save_state_never_landed``
    for why blind replay at constructor time is itself a hazard."""
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="recover-copy"))
    approval = store.approve(staged, confirm_permission_delta=True)
    original_install = store._install_version

    def crash_install(artifact, target):
        partial = target.parent / ".install-interrupted"
        partial.mkdir()
        (partial / "skill.json").write_bytes(artifact["manifest_bytes"])
        raise RuntimeError("simulated copy interruption")

    monkeypatch.setattr(store, "_install_version", crash_install)
    with pytest.raises(RuntimeError):
        store.activate(staged, approval)
    monkeypatch.setattr(store, "_install_version", original_install)

    recovered = VerifiedSkillStore(tmp_path / "store")
    assert recovered.get_active("recover-copy") is None
    assert list((tmp_path / "store" / "transactions").glob("*.json")) == []
    # The interrupted partial install directory is orphaned harmlessly (it
    # was never a candidate for governed state); reconcile()'s existing
    # `.install-*` sweep (independent of journal phase handling) still
    # cleans it up.
    assert not list((tmp_path / "store" / "versions" / "recover-copy").glob(".install-*"))

    # Approval remains usable for an explicit retry.
    recovered.activate(staged, approval)
    assert recovered.get_active("recover-copy")["digest"] == staged["digest"]


def test_activate_abort_during_prepared_phase_deletes_journal_immediately(
    tmp_path: Path, monkeypatch
):
    """GS-COORD round 2 (non-blocking cleanup): 'abort deletes the journal'
    per the frozen ruling -- a synchronous failure while the journal is still
    in phase 'prepared' (nothing durable happened yet) must delete the
    journal file immediately, in the SAME activate() call that raised, not
    merely leave it for a future reconcile() to clean up. This is distinct
    from test_reconcile_discards_a_journal_interrupted_during_install_copy,
    which only proves the eventual state after a fresh store construction;
    this test asserts the journal is gone WITHOUT ever constructing a second
    store."""
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="immediate-abort"))
    approval = store.approve(staged, confirm_permission_delta=True)

    def crash_install(artifact, target):
        raise RuntimeError("simulated prepared-phase abort")

    monkeypatch.setattr(store, "_install_version", crash_install)
    with pytest.raises(RuntimeError):
        store.activate(staged, approval)

    # No fresh VerifiedSkillStore construction here -- the SAME store handle
    # that raised must have already deleted its own journal.
    assert list((tmp_path / "store" / "transactions").glob("*.json")) == []


def test_reconcile_recovers_after_state_commit_before_journal_cleanup(tmp_path: Path, monkeypatch):
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="recover-cleanup"))
    approval = store.approve(staged, confirm_permission_delta=True)
    original_remove = store_module._remove_file_if_safe

    def crash_cleanup(path: Path, containment: Path):
        if path.parent == store.transactions_dir:
            raise RuntimeError("simulated cleanup crash")
        return original_remove(path, containment)

    monkeypatch.setattr(store_module, "_remove_file_if_safe", crash_cleanup)
    with pytest.raises(RuntimeError):
        store.activate(staged, approval)
    monkeypatch.setattr(store_module, "_remove_file_if_safe", original_remove)

    recovered = VerifiedSkillStore(tmp_path / "store")
    assert recovered.get_active("recover-cleanup")["digest"] == staged["digest"]
    assert list((tmp_path / "store" / "transactions").glob("*.json")) == []


def _fill_audit_to_capacity(store: VerifiedSkillStore, count: int = MAX_AUDIT_ENTRIES) -> None:
    """Seed ``count`` synthetic, ordered audit records directly into state.json.

    This mirrors the exact shape ``_append_audit`` writes so a full-capacity
    audit log can be constructed without actually performing 1000 governed
    mutations through the public API.
    """

    state = store._load_state()
    state["audit"] = [
        {
            "action": "approved",
            "skillId": "seed.skill",
            "digest": "0" * 64,
            "at": index,
        }
        for index in range(count)
    ]
    store._save_state(state)


def test_audit_capacity_blocks_mutation_and_preserves_full_history(tmp_path: Path):
    """Operator conditions 1-4: 1000 records survive intact, record 1001
    fails explicitly, nothing is ever deleted, and the governed mutation
    that would have produced record 1001 does not take effect either."""

    store = VerifiedSkillStore(tmp_path / "store")
    _fill_audit_to_capacity(store)
    oldest = store._load_state()["audit"][0]
    newest = store._load_state()["audit"][-1]

    staged = store.stage(write_package(tmp_path, skill_id="capacity"))
    with pytest.raises(SkillAuditCapacityError):
        store.approve(staged, confirm_permission_delta=True)

    state = store._load_state()
    assert len(state["audit"]) == MAX_AUDIT_ENTRIES
    assert state["audit"][0] == oldest
    assert state["audit"][-1] == newest
    # The approval that would have produced audit record 1001 must not have
    # been persisted either: no governed state change without its evidence.
    assert state["approvals"] == {}
    assert store.get_active("capacity") is None


def test_audit_capacity_error_is_not_a_recovery_error(tmp_path: Path):
    """Operator condition 6: the capacity error is typed and distinguishable
    from corruption/recovery errors, so an ``except SkillRecoveryError``
    handler must not catch it."""

    store = VerifiedSkillStore(tmp_path / "store")
    _fill_audit_to_capacity(store)
    staged = store.stage(write_package(tmp_path, skill_id="capacity-type"))

    assert issubclass(SkillAuditCapacityError, SkillStoreError)
    assert not issubclass(SkillAuditCapacityError, SkillRecoveryError)
    # Must also stay outside the ValueError family: reconcile() guards its
    # transaction loop with `except (SkillStoreError, OSError, ValueError)`
    # (see verified_skill_store.py), so a capacity error that were also a
    # ValueError could be laundered into a recovery warning by any handler
    # ordered before the explicit re-raise.
    assert not issubclass(SkillAuditCapacityError, SkillValidationError)
    assert not issubclass(SkillAuditCapacityError, ValueError)
    with pytest.raises(SkillAuditCapacityError):
        try:
            store.approve(staged, confirm_permission_delta=True)
        except (SkillRecoveryError, ValueError):
            pytest.fail(
                "SkillAuditCapacityError must not be caught as "
                "SkillRecoveryError or ValueError"
            )


def test_audit_capacity_raise_does_not_mutate_the_audit_in_memory(tmp_path: Path):
    """The guard must reject BEFORE touching ``audit``, not merely raise.

    Every other capacity test asserts on state reloaded from disk, so an
    implementation that mutated the in-memory list and *then* raised would
    pass all of them -- e.g. ``audit.pop(0)`` followed by a raise destroys the
    oldest record while still failing closed. Today that cannot reach disk
    (reconcile()'s explicit re-raise blocks the only unconditional save), but
    nothing else pins it, so a future edit could reintroduce silent history
    loss undetected. Assert directly on the list object handed to
    ``_append_audit``.
    """

    store = VerifiedSkillStore(tmp_path / "store")
    _fill_audit_to_capacity(store)

    state = store._load_state()
    audit = state["audit"]
    before = json.dumps(audit, sort_keys=True)
    assert len(audit) == MAX_AUDIT_ENTRIES

    staged = store.stage(write_package(tmp_path, skill_id="capacity-no-mutate"))
    artifact = {
        "manifest": {"id": staged["skillId"]},
        "digest": staged["digest"],
    }
    with pytest.raises(SkillAuditCapacityError):
        store._append_audit(state, "approved", artifact)

    assert len(audit) == MAX_AUDIT_ENTRIES, "audit was mutated on the raising path"
    assert json.dumps(audit, sort_keys=True) == before, (
        "audit contents changed on the raising path -- the capacity check must "
        "run before any mutation of the list"
    )


def test_audit_capacity_survives_restart_unchanged(tmp_path: Path):
    """Operator condition 5: restart preserves the full existing audit; the
    persisted state is byte-for-byte unaffected by a rejected mutation."""

    store = VerifiedSkillStore(tmp_path / "store")
    _fill_audit_to_capacity(store)
    before = (tmp_path / "store" / "state.json").read_bytes()

    staged = store.stage(write_package(tmp_path, skill_id="capacity-restart"))
    with pytest.raises(SkillAuditCapacityError):
        store.approve(staged, confirm_permission_delta=True)

    after_failed_mutation = (tmp_path / "store" / "state.json").read_bytes()
    assert after_failed_mutation == before

    restarted = VerifiedSkillStore(tmp_path / "store")
    restarted_state = restarted._load_state()
    assert len(restarted_state["audit"]) == MAX_AUDIT_ENTRIES
    assert restarted_state["audit"][0]["at"] == 0
    assert restarted_state["audit"][-1]["at"] == MAX_AUDIT_ENTRIES - 1


def test_audit_capacity_blocks_activation_and_disable_and_rollback(tmp_path: Path):
    """Operator condition 4, exercised across the other mutation entry
    points besides approve(): an activation, a disable, and a rollback must
    each fail closed at capacity, leaving active/installed state untouched."""

    store = VerifiedSkillStore(tmp_path / "store")
    # Perform one real activation *before* the audit log is saturated so
    # there is governed state whose "unchanged-ness" can be asserted below.
    first = store.stage(write_package(tmp_path, skill_id="capacity-ops", version="1.0.0"))
    store.activate(first, store.approve(first, confirm_permission_delta=True))
    active_before = store.get_active("capacity-ops")

    second = store.stage(
        write_package(tmp_path, skill_id="capacity-ops", version="2.0.0", text="v2\n")
    )
    second_approval = store.approve(second)

    _fill_audit_to_capacity(store)

    # activate() must fail closed and must not change the active digest.
    with pytest.raises(SkillAuditCapacityError):
        store.activate(second, second_approval)
    assert store.get_active("capacity-ops") == active_before

    # disable() must fail closed and must not flip enabled to False.
    with pytest.raises(SkillAuditCapacityError):
        store.disable("capacity-ops")
    assert store.get_active("capacity-ops") == active_before

    # rollback() must fail closed; since rollback targets the currently
    # active exact digest here, "unchanged" is directly observable.
    with pytest.raises(SkillAuditCapacityError):
        store.rollback("capacity-ops", active_before["digest"])
    assert store.get_active("capacity-ops") == active_before


def test_recovery_of_a_never_committed_transaction_discards_and_does_not_touch_audit(
    tmp_path: Path, monkeypatch
):
    """RE-SPECIFIED (GS-COORD): under the phase-aware journal protocol,
    ``_reconcile_transaction`` never itself performs a governed mutation --
    it only CONFIRMS an already-landed commit or DISCARDS one that never
    landed (see ``activate()``/``_reconcile_transaction`` docstrings). A
    journal whose ``_save_state`` call raised (so state.json was never
    written) is, by construction, indistinguishable from one that crashed
    before ``_save_state`` was ever entered: both leave ``active`` matching
    the journal's recorded ``previous`` value and the approval unconsumed.
    Recovery must discard such a journal outright rather than replay the
    mutation -- replaying at constructor time would mean an operator's
    ``VerifiedSkillStore(...)`` call could non-deterministically fail (e.g.
    on audit capacity, exactly the old defect this test used to pin) for a
    mutation the caller never asked to retry.

    The old version of this test asserted the OPPOSITE: that reconcile()
    replayed the mutation and could hit the audit-capacity guard during
    recovery. That was exactly defect GS-COORD #5/#6 (``_reconcile_transaction``
    unconditionally completing any retained journal regardless of whether it
    had ever reached ``_save_state``). The re-specified behaviour below is
    the correct one: recovery is inert on an unlanded journal, and a retry
    goes through the normal ``activate()`` path (which still enforces the
    capacity guard exactly as it always did -- proven at the end of this
    test)."""

    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="capacity-recover"))
    approval = store.approve(staged, confirm_permission_delta=True)

    def crash(_state):
        raise RuntimeError("simulated crash before state_committed")

    monkeypatch.setattr(store, "_save_state", crash)
    with pytest.raises(RuntimeError):
        store.activate(staged, approval)
    monkeypatch.undo()

    # The activation is now only durable as a `committing`-phase transaction
    # journal that never reached _save_state. Saturate the audit log to
    # prove recovery does NOT attempt (and therefore cannot fail on) any
    # audit append of its own.
    _fill_audit_to_capacity(store)
    assert list((tmp_path / "store" / "transactions").glob("*.json"))

    # Construction must succeed: recovery discards the unlanded journal
    # instead of replaying it.
    recovered_store = VerifiedSkillStore(tmp_path / "store")
    assert list((tmp_path / "store" / "transactions").glob("*.json")) == []
    state_on_disk = json.loads((tmp_path / "store" / "state.json").read_text(encoding="utf-8"))
    assert "capacity-recover" not in state_on_disk["active"]
    assert len(state_on_disk["audit"]) == MAX_AUDIT_ENTRIES  # untouched by recovery

    # The approval must remain usable for an explicit retry -- discard must
    # not have consumed it. That explicit retry still hits the ordinary
    # capacity guard, proving the guard was never bypassed, merely not
    # invoked *during recovery itself*.
    with pytest.raises(SkillAuditCapacityError):
        recovered_store.activate(staged, approval)


def test_sabotage_regression_del_truncation_reintroduces_silent_history_loss(tmp_path: Path):
    """A regression guard that fails if ``_append_audit`` ever goes back to
    silently truncating the oldest records instead of failing closed.

    This test is written to match the exact old defect: truncating the
    audit list to the newest ``MAX_AUDIT_ENTRIES`` entries instead of
    raising.  It is intentionally independent of the other capacity tests
    so that reverting the fix trips this one specifically.
    """

    store = VerifiedSkillStore(tmp_path / "store")
    _fill_audit_to_capacity(store)
    oldest = store._load_state()["audit"][0]

    staged = store.stage(write_package(tmp_path, skill_id="sabotage"))
    with pytest.raises(SkillAuditCapacityError):
        store.approve(staged, confirm_permission_delta=True)

    state = store._load_state()
    assert len(state["audit"]) == MAX_AUDIT_ENTRIES, (
        "audit entry count changed at capacity boundary; the bounded "
        "truncation regression silently drops/adds records here"
    )
    assert state["audit"][0] == oldest, (
        "the oldest audit record was displaced; this is exactly what "
        "`del audit[:-MAX_AUDIT_ENTRIES]` does after an append"
    )
