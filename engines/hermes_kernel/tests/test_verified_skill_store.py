from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper import verified_skill_store as store_module  # noqa: E402
from mcp_wrapper.verified_skill_store import (  # noqa: E402
    SkillApprovalError,
    SkillIntegrityError,
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
