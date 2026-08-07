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


def test_reconcile_recovers_after_version_install_before_state_commit(tmp_path: Path):
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="recover"))
    approval = store.approve(staged, confirm_permission_delta=True)

    def crash(_state):
        raise RuntimeError("simulated crash")

    store._save_state = crash  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        store.activate(staged, approval)

    recovered = VerifiedSkillStore(tmp_path / "store")
    assert recovered.get_active("recover")["digest"] == staged["digest"]
    assert list((tmp_path / "store" / "transactions").glob("*.json")) == []


def test_reconcile_resumes_when_install_copy_interrupted(tmp_path: Path, monkeypatch):
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
    assert recovered.get_active("recover-copy")["digest"] == staged["digest"]
    assert not list((tmp_path / "store" / "versions" / "recover-copy").glob(".install-*"))


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


def test_audit_capacity_guard_is_not_bypassed_by_recovery(tmp_path: Path, monkeypatch):
    """Operator condition 7: the recovery path (``recovered`` audit action,
    reached via reconcile()) must not bypass the capacity guard, and must
    not silently launder the capacity error into a reconcile() warning
    while leaving the in-progress transaction's state mutations persisted."""

    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="capacity-recover"))
    approval = store.approve(staged, confirm_permission_delta=True)

    def crash(_state):
        raise RuntimeError("simulated crash before state_committed")

    monkeypatch.setattr(store, "_save_state", crash)
    with pytest.raises(RuntimeError):
        store.activate(staged, approval)
    monkeypatch.undo()

    # The activation is now only durable as a pending transaction journal;
    # saturate the audit log so the eventual recovery-time _append_audit
    # ("recovered") call hits capacity.
    _fill_audit_to_capacity(store)
    assert list((tmp_path / "store" / "transactions").glob("*.json"))

    with pytest.raises(SkillAuditCapacityError):
        VerifiedSkillStore(tmp_path / "store")

    # The journal must still be present (not consumed by a swallowed error)
    # and the skill must still not be active, because reconcile() must not
    # have reached its final _save_state with the partially-applied mutation.
    assert list((tmp_path / "store" / "transactions").glob("*.json"))
    state_on_disk = json.loads((tmp_path / "store" / "state.json").read_text(encoding="utf-8"))
    assert "capacity-recover" not in state_on_disk["active"]
    assert len(state_on_disk["audit"]) == MAX_AUDIT_ENTRIES


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
