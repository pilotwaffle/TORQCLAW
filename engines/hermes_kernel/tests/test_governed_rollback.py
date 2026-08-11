"""GS-ROLLBACK: governed rollback must move the published projection, the
prompt cache, and governance TOGETHER, through a reachable operator surface.

GS-ACCEPT F-1 measured the shipped behaviour: ``store.rollback()`` moved
governance to the prior digest while the published projection -- the bytes
the real Hermes prompt builder renders -- kept serving the reverted content,
and nothing in production called ``rollback()`` at all (the unenforced-claim
pattern). These tests pin the end-to-end path
(``governed_skills.rollback_governed_skill`` +
``skill_rollback``/``server.py`` surface) and every restore/verify control
it composes, so a deletion probe against any one control goes red.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper import hermes_runner  # noqa: E402,F401  (vendor sys.path insert)
from mcp_wrapper import governed_skills, skill_publisher, skill_rollback  # noqa: E402
from mcp_wrapper.runtime_quiescence import (  # noqa: E402
    SkillActivationCoordinationError,
    SkillRuntimeBusyError,
)
from mcp_wrapper.verified_skill_store import (  # noqa: E402
    SkillApprovalError,
    VerifiedSkillStore,
)

vendored_available, vendor_import_error = hermes_runner.hermes_available()
pytestmark = pytest.mark.skipif(
    not vendored_available,
    reason=f"vendored hermes-agent unavailable: {vendor_import_error}",
)

SID = "rollbackable.skill"
V1_MD = "# v1\n\nConverts furlongs to metres: factor 201.168.\n"
V2_MD = "# v2\n\nConverts furlongs badly: factor 999.999.\n"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """Never touch the operator's real ~/.torqclaw or ~/.hermes."""
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path / "torqclaw_data"))
    hermes_home = tmp_path / "hermes_home"
    (hermes_home / "skills").mkdir(parents=True, exist_ok=True)
    published = tmp_path / "torqclaw_data" / "published_skills"
    (hermes_home / "config.yaml").write_text(
        "skills:\n  external_dirs:\n    - " + published.as_posix() + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()
    hermes_runner.RUNNING.clear()
    yield
    hermes_runner.RUNNING.clear()
    governed_skills._reset_for_test()


def _install_two_versions() -> tuple[str, str]:
    v1 = governed_skills.install_approved_skill(SID, V1_MD)["digest"]
    v2 = governed_skills.install_approved_skill(SID, V2_MD)["digest"]
    return v1, v2


def _state() -> dict:
    store = governed_skills._store()
    return json.loads((Path(store.root) / "state.json").read_text(encoding="utf-8"))


def _published_body() -> str:
    return (skill_publisher.published_skills_dir() / SID / "SKILL.md").read_text(
        encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# The core F-1 closure: governance AND projection move together.
# ---------------------------------------------------------------------------


def test_rollback_moves_governance_and_published_bytes_together():
    v1, v2 = _install_two_versions()
    assert _published_body() == V2_MD

    result = governed_skills.rollback_governed_skill(SID, v1)

    assert result["ok"] is True and result["rolledBack"] is True
    assert _state()["active"][SID]["digest"] == v1
    # THE assertion F-1 existed to make fail: the bytes the loader scans.
    assert _published_body() == V1_MD
    actions = [entry["action"] for entry in _state()["audit"]]
    assert "rolled_back" in actions


def test_rolled_back_version_is_discoverable_by_the_real_loader():
    v1, _ = _install_two_versions()
    governed_skills.rollback_governed_skill(SID, v1)

    from agent.skill_utils import get_all_skills_dirs, iter_skill_index_files

    bodies = []
    for skills_dir in map(Path, get_all_skills_dirs()):
        if skills_dir.is_dir():
            for skill_file in iter_skill_index_files(skills_dir, "SKILL.md"):
                if Path(skill_file).parent.name == SID:
                    bodies.append(Path(skill_file).read_text(encoding="utf-8"))
    assert bodies == [V1_MD]


def test_rollback_success_leaves_no_retained_projection_behind():
    v1, _ = _install_two_versions()
    governed_skills.rollback_governed_skill(SID, v1)
    retained_root = skill_publisher.published_skills_retained_root()
    leftovers = [p for p in retained_root.glob("rollback-*")] if retained_root.is_dir() else []
    assert leftovers == []


def test_rollback_reenables_a_disabled_skill():
    """store.rollback() writes enabled: True unconditionally; GS-DISABLE is a
    separate lane, so this semantic must hold and stay documented."""
    v1, _ = _install_two_versions()
    governed_skills._store().disable(SID)
    governed_skills.rollback_governed_skill(SID, v1)
    assert _state()["active"][SID] == {
        "digest": v1,
        "enabled": True,
        "permissions": ["read"],
    }


def test_rollback_accepts_a_sha256_prefixed_digest():
    v1, _ = _install_two_versions()
    result = governed_skills.rollback_governed_skill(SID, f"sha256:{v1}")
    assert result["digest"] == v1


# ---------------------------------------------------------------------------
# Refusals are mutation-free.
# ---------------------------------------------------------------------------


def test_unknown_digest_is_refused_with_zero_mutation():
    _install_two_versions()
    store = governed_skills._store()
    state_before = (Path(store.root) / "state.json").read_bytes()
    body_before = _published_body()

    with pytest.raises(governed_skills.GovernedSkillError):
        governed_skills.rollback_governed_skill(SID, "0" * 64)

    assert (Path(store.root) / "state.json").read_bytes() == state_before
    assert _published_body() == body_before


def test_busy_runtime_blocks_rollback_with_zero_mutation():
    v1, _ = _install_two_versions()
    store = governed_skills._store()
    state_before = (Path(store.root) / "state.json").read_bytes()

    hermes_runner.RUNNING["live-task"] = object()
    try:
        with pytest.raises(SkillRuntimeBusyError):
            governed_skills.rollback_governed_skill(SID, v1)
    finally:
        hermes_runner.RUNNING.pop("live-task", None)

    assert (Path(store.root) / "state.json").read_bytes() == state_before
    assert _published_body() == V2_MD


def test_installed_but_never_active_target_raises_approval_error():
    """G1R finding 6: a failed first install reverts with previous=None,
    deleting the active entry while the installed record survives.
    ``_current_permissions`` then returns (), so the store would demand a
    fresh approval for the baseline ["read"] -- the kernel refuses fast with
    an accurate error instead."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(skill_publisher, "is_published", lambda skill_id: False)
        with pytest.raises(Exception):
            governed_skills.install_approved_skill(SID, V1_MD)

    state = _state()
    assert SID not in state["active"], "precondition: never governed-active"
    installed = list(state["installed"].get(SID, {}))
    assert installed, "precondition: the installed record survived"

    with pytest.raises(SkillApprovalError):
        governed_skills.rollback_governed_skill(SID, installed[0])

    surface = skill_rollback.rollback(SID, installed[0])
    assert surface == {
        "ok": False,
        "code": "SKILL_ROLLBACK_TARGET_NEVER_ACTIVE",
        "retryable": False,
        "error": surface["error"],
    }
    assert "never been governed-active" in surface["error"]


# ---------------------------------------------------------------------------
# Failure-path restore semantics (the GS-COORD ordering rulings, re-pinned
# for the rollback transaction).
# ---------------------------------------------------------------------------


def test_verify_failure_restores_projection_and_governance():
    v1, v2 = _install_two_versions()

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(skill_publisher, "is_published", lambda skill_id: False)
        with pytest.raises(SkillActivationCoordinationError):
            governed_skills.rollback_governed_skill(SID, v1)

    assert _state()["active"][SID]["digest"] == v2
    assert _published_body() == V2_MD


def test_verify_catches_a_publish_that_lied_about_the_bytes(monkeypatch):
    """The digest check in verify exists for exactly this sabotage: a publish
    step that reports success while the published bytes are NOT the rollback
    target. publish_skill's own post-write verification makes this impossible
    to seed honestly (it would raise first), so the seeding bypasses it --
    which is also why this control's deletion probe needs this test: without
    the digest check, is_published() alone would wave the divergence through
    and re-create F-1."""
    v1, v2 = _install_two_versions()
    real_publish = skill_publisher.publish_skill

    def _lying_publish(package_dir, *, digest, source, retain_replaced_into):
        # Re-publish the CURRENT (v2) bytes while claiming the rollback
        # target digest succeeded.
        v2_dir = governed_skills._store().versions_dir / SID / v2
        result = real_publish(
            v2_dir, digest=v2, source=source, retain_replaced_into=retain_replaced_into
        )
        return {**result, "digest": digest}

    monkeypatch.setattr(skill_publisher, "publish_skill", _lying_publish)

    with pytest.raises(SkillActivationCoordinationError):
        governed_skills.rollback_governed_skill(SID, v1)

    assert _state()["active"][SID]["digest"] == v2
    assert _published_body() == V2_MD


def test_commit_failure_restores_projection_without_a_governed_revert(monkeypatch):
    """commit_holder must only reflect a commit that actually LANDED (the
    GS-COORD round-3 vacuous-revert lesson): if store.rollback() itself
    raises, restore must not call revert_activation at all."""
    v1, v2 = _install_two_versions()

    revert_calls: list = []
    original_revert = VerifiedSkillStore.revert_activation

    def _recording_revert(self, *args, **kwargs):
        revert_calls.append(args)
        return original_revert(self, *args, **kwargs)

    def _raising_rollback(self, *args, **kwargs):
        raise RuntimeError("injected commit failure")

    monkeypatch.setattr(VerifiedSkillStore, "revert_activation", _recording_revert)
    monkeypatch.setattr(VerifiedSkillStore, "rollback", _raising_rollback)

    with pytest.raises(SkillActivationCoordinationError):
        governed_skills.rollback_governed_skill(SID, v1)

    assert revert_calls == [], "commit never landed; nothing governed to revert"
    assert _state()["active"][SID]["digest"] == v2
    assert _published_body() == V2_MD


def test_publisher_restore_failure_after_landed_commit_is_reported_unproven(
    monkeypatch,
):
    """Governance is reverted FIRST (conservative); if the projection restore
    then fails, the caller must get the distinct unproven-projection error,
    never a generic retryable shape -- and the None approval token used by
    the revert must not corrupt the approvals table."""
    v1, v2 = _install_two_versions()
    approvals_before = _state()["approvals"]

    monkeypatch.setattr(skill_publisher, "is_published", lambda skill_id: False)

    def _raising_restore(*, skill_id, retained_path):
        raise OSError("injected projection-restore failure")

    monkeypatch.setattr(
        skill_publisher, "restore_retained_projection", _raising_restore
    )

    with pytest.raises(governed_skills.GovernanceRevertedProjectionUnprovenError):
        governed_skills.rollback_governed_skill(SID, v1)

    state = _state()
    assert state["active"][SID]["digest"] == v2, "governance must stay conservative"
    assert state["approvals"] == approvals_before, (
        "revert_activation(approval_token=None) corrupted the approvals table"
    )


# ---------------------------------------------------------------------------
# Idempotency.
# ---------------------------------------------------------------------------


def test_rollback_to_the_already_active_digest_runs_no_transaction(monkeypatch):
    v1, v2 = _install_two_versions()

    class _MustNotRun:
        def __init__(self, **kwargs):
            raise AssertionError("coordinator must not run for an idempotent rollback")

    monkeypatch.setattr(governed_skills, "ActivationCoordinator", _MustNotRun)
    result = governed_skills.rollback_governed_skill(SID, v2)
    assert result["reconciledFromPriorSuccess"] is True
    assert result["digest"] == v2


def test_retry_after_divergence_heals_rather_than_short_circuits():
    """The exact F-1 aftermath state (governed at target, published bytes
    still the superseded version) must NOT satisfy the idempotent fast path:
    a retry has to re-run the full transaction and heal the projection."""
    v1, v2 = _install_two_versions()
    store = governed_skills._store()
    # Manufacture the divergence with the shipped defect itself: the bare
    # store rollback that moves governance only.
    store.rollback(SID, v1)
    assert _state()["active"][SID]["digest"] == v1
    assert _published_body() == V2_MD, "precondition: diverged"

    result = governed_skills.rollback_governed_skill(SID, v1)
    assert result.get("reconciledFromPriorSuccess") is None
    assert result["rolledBack"] is True
    assert _published_body() == V1_MD, "the retry healed the projection"


# ---------------------------------------------------------------------------
# Operator surface shapes.
# ---------------------------------------------------------------------------


def test_surface_refuses_when_governance_is_disabled(monkeypatch, tmp_path):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "")
    result = skill_rollback.rollback(SID, "0" * 64)
    assert result["ok"] is False
    assert result["code"] == "GOVERNED_SKILLS_DISABLED"
    assert not (tmp_path / "torqclaw_data" / "published_skills" / SID).exists()


def test_surface_success_and_invalid_target_shapes():
    v1, _ = _install_two_versions()

    ok = skill_rollback.rollback(SID, v1)
    assert ok["ok"] is True and ok["rolledBack"] is True

    bad = skill_rollback.rollback(SID, "not-a-digest")
    assert bad["ok"] is False
    assert bad["code"] == "SKILL_ROLLBACK_INVALID_TARGET"
    assert bad["retryable"] is False

    unknown = skill_rollback.rollback(SID, "0" * 64)
    assert unknown["code"] == "SKILL_ROLLBACK_INVALID_TARGET"


def test_surface_failure_shapes_omit_the_queue_status_field(monkeypatch):
    """A rollback has no skill_queue row; emitting status:'pending' would be
    a queue-row claim about a row that does not exist."""
    v1, _ = _install_two_versions()
    hermes_runner.RUNNING["live-task"] = object()
    try:
        busy = skill_rollback.rollback(SID, v1)
    finally:
        hermes_runner.RUNNING.pop("live-task", None)
    assert busy["code"] == "SKILL_RUNTIME_BUSY"
    assert busy["retryable"] is True
    assert "status" not in busy
    assert busy["activeTasks"] == 1


def test_map_activation_failure_reproduces_decide_shapes_byte_identically():
    """The extraction of decide()'s except arms is behaviour-preserving:
    golden shapes copied verbatim from the pre-extraction skill_queue.decide,
    compared via json.dumps so key ORDER is pinned too."""
    hermes_runner.RUNNING.clear()
    hermes_runner.RUNNING["t1"] = object()
    hermes_runner.RUNNING["t2"] = object()
    try:
        busy = governed_skills.map_activation_failure(
            SkillRuntimeBusyError("x"), queue_status="pending"
        )
    finally:
        hermes_runner.RUNNING.clear()
    assert json.dumps(busy) == json.dumps(
        {
            "ok": False,
            "code": "SKILL_RUNTIME_BUSY",
            "retryable": True,
            "status": "pending",
            "activeTasks": 2,
            "error": (
                "Skill activation is blocked while 2 Hermes task(s) are "
                "running. No skill state changed. Retry when those tasks "
                "finish."
            ),
        }
    )

    from mcp_wrapper.runtime_quiescence import (
        SkillActivationRestoredButCacheUnprovenError,
    )

    cases = [
        (
            governed_skills.GovernanceRevertedProjectionUnprovenError("p"),
            "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT",
            False,
        ),
        (
            SkillActivationRestoredButCacheUnprovenError("c"),
            "SKILL_ACTIVATION_CACHE_UNPROVEN",
            False,
        ),
        (RuntimeError("g"), "SKILL_ACTIVATION_FAILED", True),
    ]
    for exc, code, retryable in cases:
        assert json.dumps(
            governed_skills.map_activation_failure(exc, queue_status="pending")
        ) == json.dumps(
            {
                "ok": False,
                "code": code,
                "retryable": retryable,
                "status": "pending",
                "error": str(exc),
            }
        ), code


# ---------------------------------------------------------------------------
# Version listing.
# ---------------------------------------------------------------------------


def test_list_versions_is_tamper_tolerant_and_shows_divergence():
    v1, v2 = _install_two_versions()
    store = governed_skills._store()

    # Corrupt v1's immutable package out-of-band.
    v1_skill = store.versions_dir / SID / v1 / "SKILL.md"
    v1_skill.write_text(V1_MD + "tampered\n", encoding="utf-8")

    listing = skill_rollback.list_versions(SID)
    assert listing["ok"] is True
    by_digest = {entry["digest"]: entry for entry in listing["versions"]}
    assert by_digest[v1]["tampered"] is True
    assert by_digest[v2]["tampered"] is False
    assert all(entry["installedAt"] for entry in listing["versions"])
    assert listing["activeDigest"] == v2
    assert listing["publishedDigest"] == v2
    assert listing["publishedVerified"] is True
    assert listing["governedSkillsEnabled"] is True


def test_list_versions_orders_newest_first():
    v1, v2 = _install_two_versions()
    listing = skill_rollback.list_versions(SID)
    digests = [entry["digest"] for entry in listing["versions"]]
    assert digests == [v2, v1]


def test_list_versions_rejects_a_bad_id_with_an_error_shape():
    result = skill_rollback.list_versions("../escape")
    assert result["ok"] is False and "invalid skill id" in result["error"]


# ---------------------------------------------------------------------------
# Reachability: the tools are actually registered on the MCP server.
# ---------------------------------------------------------------------------


def test_rollback_tools_are_registered_on_the_server():
    """F-1's second half was reachability -- a capability with no production
    caller. If these tools fall off the server, that defect is back."""
    import asyncio

    from mcp_wrapper import server

    assert callable(server.rollback_skill)
    assert callable(server.list_skill_versions)
    tool_names = {tool.name for tool in asyncio.run(server.mcp.list_tools())}
    assert {"rollback_skill", "list_skill_versions"} <= tool_names
