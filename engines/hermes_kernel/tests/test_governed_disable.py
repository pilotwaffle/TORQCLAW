"""GS-DISABLE: disabling a governed skill must remove the published
projection, invalidate the prompt cache, and mark governance disabled
TOGETHER, through a reachable operator surface.

``VerifiedSkillStore.disable()`` had the identical defect shape GS-ACCEPT
F-1 measured in ``rollback()``: it flipped ``enabled: False`` in governed
state, never touched the published projection, and had no production caller
at all (the unenforced-claim pattern). A "disabled" skill therefore kept
being rendered into every system prompt -- worse than rollback's version of
the bug, because there is no newer version to mask it; the skill simply
keeps working.

These tests pin the end-to-end path
(``governed_skills.disable_governed_skill`` + the
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
from mcp_wrapper.verified_skill_store import VerifiedSkillStore  # noqa: E402

vendored_available, vendor_import_error = hermes_runner.hermes_available()
pytestmark = pytest.mark.skipif(
    not vendored_available,
    reason=f"vendored hermes-agent unavailable: {vendor_import_error}",
)

SID = "disableable.skill"
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


def _install(markdown: str = V1_MD) -> str:
    return governed_skills.install_approved_skill(SID, markdown)["digest"]


def _state() -> dict:
    store = governed_skills._store()
    return json.loads((Path(store.root) / "state.json").read_text(encoding="utf-8"))


def _published_body() -> str:
    return (skill_publisher.published_skills_dir() / SID / "SKILL.md").read_text(
        encoding="utf-8"
    )


def _rendered_prompt() -> str:
    """The REAL rendered skills system prompt, not iter_skill_index_files.

    The mtime-cache trap makes the loader helpers insufficient evidence:
    they can report the file while the prompt builder renders an empty
    index (or vice versa). This is the surface the model's turn consumes.
    """
    from agent.prompt_builder import (
        build_skills_system_prompt,
        clear_skills_system_prompt_cache,
    )

    clear_skills_system_prompt_cache(clear_snapshot=True)
    return build_skills_system_prompt() or ""


# ---------------------------------------------------------------------------
# The core closure: governance AND projection move together.
# ---------------------------------------------------------------------------


def test_disable_unpublishes_and_marks_governance_disabled_together():
    digest = _install()
    assert skill_publisher.is_published(SID)

    result = governed_skills.disable_governed_skill(SID)

    assert result["ok"] is True
    assert result["disabled"] is True
    assert result["published"] is False
    assert result["digest"] == digest

    # Governance: disabled, but the installed history SURVIVES -- that is
    # what makes rollback the inverse.
    state = _state()
    assert state["active"][SID]["enabled"] is False
    assert state["active"][SID]["digest"] == digest
    assert digest in state["installed"][SID], "installed history must survive"

    # THE assertion the store-only disable could never make: the bytes the
    # loader scans are GONE.
    assert not skill_publisher.is_published(SID)
    assert "disabled" in [entry["action"] for entry in state["audit"]]


def test_disabled_skill_is_absent_from_the_real_rendered_prompt():
    """The end-to-end proof: not `is_published`, but the model's index."""
    _install()
    assert SID in _rendered_prompt(), "precondition: the skill renders"

    governed_skills.disable_governed_skill(SID)

    rendered = _rendered_prompt()
    assert SID not in rendered, (
        "governed disable reported success but the skill is STILL in the "
        f"rendered system prompt -- the divergence is back. Rendered:\n{rendered[:2000]}"
    )
    assert "furlongs" not in rendered.lower()


def test_disabled_skill_is_gone_from_the_real_loader_scan():
    _install()
    governed_skills.disable_governed_skill(SID)

    from agent.skill_utils import get_all_skills_dirs, iter_skill_index_files

    found = []
    for skills_dir in map(Path, get_all_skills_dirs()):
        if skills_dir.is_dir():
            for skill_file in iter_skill_index_files(skills_dir, "SKILL.md"):
                if Path(skill_file).parent.name == SID:
                    found.append(skill_file)
    assert found == []


def test_disable_success_leaves_no_retained_projection_behind():
    _install()
    governed_skills.disable_governed_skill(SID)
    retained_root = skill_publisher.published_skills_retained_root()
    leftovers = list(retained_root.glob("disable-*")) if retained_root.is_dir() else []
    assert leftovers == []


def test_get_active_returns_none_for_a_disabled_skill():
    _install()
    governed_skills.disable_governed_skill(SID)
    assert governed_skills._store().get_active(SID) is None
    # ...but the entry still EXISTS, which is what keeps rollback eligible.
    assert governed_skills._store().has_active_entry(SID) is True


# ---------------------------------------------------------------------------
# The inverse: re-enable via rollback (there is deliberately no enable API).
# ---------------------------------------------------------------------------


def test_rollback_is_the_inverse_of_disable_round_trip():
    """Disable, then roll back to the same digest: re-enabled AND
    re-published. This is why GS-DISABLE ships no second enable path."""
    digest = _install()
    governed_skills.disable_governed_skill(SID)
    assert not skill_publisher.is_published(SID)
    assert SID not in _rendered_prompt()

    result = governed_skills.rollback_governed_skill(SID, digest)

    assert result["ok"] is True and result["rolledBack"] is True
    assert _state()["active"][SID] == {
        "digest": digest,
        "enabled": True,
        "permissions": ["read"],
    }
    assert _published_body() == V1_MD
    assert SID in _rendered_prompt(), "the round trip must restore the model's index"


def test_disable_then_rollback_to_an_older_digest_republishes_that_one():
    v1 = _install(V1_MD)
    _install(V2_MD)
    governed_skills.disable_governed_skill(SID)

    governed_skills.rollback_governed_skill(SID, v1)

    assert _published_body() == V1_MD
    assert _state()["active"][SID]["enabled"] is True


# ---------------------------------------------------------------------------
# Refusals are mutation-free.
# ---------------------------------------------------------------------------


def test_unknown_skill_is_refused_with_zero_mutation():
    _install()
    store = governed_skills._store()
    state_before = (Path(store.root) / "state.json").read_bytes()
    body_before = _published_body()

    with pytest.raises(governed_skills.GovernedSkillError):
        governed_skills.disable_governed_skill("never.installed")

    assert (Path(store.root) / "state.json").read_bytes() == state_before
    assert _published_body() == body_before


def test_malformed_id_is_refused_with_zero_mutation():
    _install()
    store = governed_skills._store()
    state_before = (Path(store.root) / "state.json").read_bytes()

    for bad in ("../escape", "has space", "", "a" * 300):
        with pytest.raises(governed_skills.GovernedSkillError):
            governed_skills.disable_governed_skill(bad)

    assert (Path(store.root) / "state.json").read_bytes() == state_before
    assert skill_publisher.is_published(SID)


def test_installed_but_never_active_skill_cannot_be_disabled():
    """A first-time install whose verify failed reverts with previous=None,
    deleting the active entry while the installed record survives. There is
    nothing to disable -- and the error must say so, not report a
    transaction failure."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(skill_publisher, "is_published", lambda skill_id: False)
        with pytest.raises(Exception):
            governed_skills.install_approved_skill(SID, V1_MD)

    state = _state()
    assert SID not in state["active"], "precondition: never governed-active"
    assert state["installed"].get(SID), "precondition: the installed record survived"

    with pytest.raises(governed_skills.GovernedSkillError) as excinfo:
        governed_skills.disable_governed_skill(SID)
    assert "no governed-active entry" in str(excinfo.value)


def test_busy_runtime_blocks_disable_with_zero_mutation():
    _install()
    store = governed_skills._store()
    state_before = (Path(store.root) / "state.json").read_bytes()

    hermes_runner.RUNNING["live-task"] = object()
    try:
        with pytest.raises(SkillRuntimeBusyError):
            governed_skills.disable_governed_skill(SID)
    finally:
        hermes_runner.RUNNING.pop("live-task", None)

    assert (Path(store.root) / "state.json").read_bytes() == state_before
    assert _published_body() == V1_MD, "a busy refusal must not unpublish anything"


# ---------------------------------------------------------------------------
# Failure-path restore semantics (the GS-COORD ordering rulings, re-pinned
# for the disable transaction).
# ---------------------------------------------------------------------------


def test_verify_failure_restores_projection_and_governance():
    """If verify fails after the governed disable landed, BOTH halves must
    go back: governance re-enabled and the projection re-published."""
    _install()

    # Make verify fail on its last check by claiming the skill is still
    # published after the unpublish genuinely removed it.
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(skill_publisher, "is_published", lambda skill_id: True)
        with pytest.raises(SkillActivationCoordinationError):
            governed_skills.disable_governed_skill(SID)

    assert _state()["active"][SID]["enabled"] is True, "governance must be re-enabled"
    assert _published_body() == V1_MD, "the projection must be restored"
    assert SID in _rendered_prompt()


def test_verify_catches_a_no_op_unpublish_that_reported_success():
    """The deletion-probe tripwire for control #1: a publish callback that
    reports success while the projection is STILL published must be caught
    by verify. Without the is_published check in verify, governance would
    say disabled while the model kept receiving the skill -- the exact
    defect this lane closes."""
    _install()

    def _noop_unpublish(skill_id, *, retain_into):
        # Exactly what a control DELETED from the publish callback would
        # report: "nothing was published, nothing retained" -- the honest
        # shape of a no-op -- while the projection is in fact still live.
        # Nothing here contradicts itself, which is what makes it the
        # realistic sabotage rather than a self-defeating fake.
        return {
            "ok": True,
            "skillId": skill_id,
            "removed": False,
            "retainedPath": None,
        }

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(skill_publisher, "retain_unpublish_skill", _noop_unpublish)
        with pytest.raises(SkillActivationCoordinationError):
            governed_skills.disable_governed_skill(SID)

    # Governance is conservative (re-enabled). The projection state after
    # the restore is "nothing retained -> restore to not-published", which
    # is coherent; the load-bearing assertion is that the transaction was
    # REFUSED rather than reporting a disable while the bytes stayed live.
    assert _state()["active"][SID]["enabled"] is True
    # And the state this control exists to make impossible never occurs:
    # governance disabled while the projection is still rendering.
    assert not (
        _state()["active"][SID]["enabled"] is False
        and skill_publisher.is_published(SID)
    ), "disabled-but-published: the divergence this lane closes"


def test_commit_failure_restores_projection_without_a_governed_revert(monkeypatch):
    """commit_holder must only reflect a commit that actually LANDED (the
    GS-COORD round-3 vacuous-revert lesson): if store.disable() itself
    raises, restore must not call revert_activation at all -- otherwise any
    'governance was reverted' assertion passes vacuously because governance
    was never moved."""
    _install()

    revert_calls: list = []
    original_revert = VerifiedSkillStore.revert_activation

    def _recording_revert(self, *args, **kwargs):
        revert_calls.append(args)
        return original_revert(self, *args, **kwargs)

    def _raising_disable(self, *args, **kwargs):
        raise RuntimeError("injected commit failure")

    monkeypatch.setattr(VerifiedSkillStore, "revert_activation", _recording_revert)
    monkeypatch.setattr(VerifiedSkillStore, "disable", _raising_disable)

    with pytest.raises(SkillActivationCoordinationError):
        governed_skills.disable_governed_skill(SID)

    assert revert_calls == [], "commit never landed; nothing governed to revert"
    assert _state()["active"][SID]["enabled"] is True
    assert _published_body() == V1_MD, "the retained projection must be restored"


def test_publisher_restore_failure_after_landed_commit_is_reported_unproven(
    monkeypatch,
):
    """Governance is reverted FIRST (conservative -- back to ENABLED); if
    the projection restore then fails, the caller must get the distinct
    unproven-projection error, never a generic retryable shape. The None
    approval token used by the revert must not corrupt the approvals
    table."""
    _install()
    approvals_before = _state()["approvals"]

    # Force verify to fail so the restore path runs at all.
    monkeypatch.setattr(skill_publisher, "is_published", lambda skill_id: True)

    def _raising_restore(*, skill_id, retained_path):
        raise OSError("injected projection-restore failure")

    monkeypatch.setattr(skill_publisher, "restore_retained_projection", _raising_restore)

    with pytest.raises(governed_skills.GovernanceRevertedProjectionUnprovenError):
        governed_skills.disable_governed_skill(SID)

    state = _state()
    assert state["active"][SID]["enabled"] is True, (
        "governance must stay CONSERVATIVE -- enabled, not disabled: a "
        "disabled-but-possibly-published skill is the silent divergence"
    )
    assert state["approvals"] == approvals_before, (
        "revert_activation(approval_token=None) corrupted the approvals table"
    )


def test_surface_reports_unproven_projection_not_invalid_target(monkeypatch):
    """The GS-ROLLBACK G2A round-1 BLOCKING defect, re-pinned at the SURFACE
    for this lane: GovernanceRevertedProjectionUnprovenError EXTENDS
    GovernedSkillError and propagates UNWRAPPED out of the coordinator's
    restore path, so an invalid-target arm placed first swallows it and
    machine-labels the one must-inspect-disk failure as a bad argument.

    Every other failure-taxonomy test here stops at the kernel; this one
    drives the exception through skill_rollback.disable and asserts on the
    returned dict -- the OUTERMOST surface an operator calls. That is the
    G2A lesson: pin taxonomies where they are consumed, not where they are
    raised."""
    _install()

    monkeypatch.setattr(skill_publisher, "is_published", lambda skill_id: True)

    def _raising_restore(*, skill_id, retained_path):
        raise OSError("injected projection-restore failure")

    monkeypatch.setattr(skill_publisher, "restore_retained_projection", _raising_restore)

    result = skill_rollback.disable(SID)

    assert result["ok"] is False
    assert result["code"] == "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT"
    assert result["retryable"] is False
    assert "status" not in result
    assert _state()["active"][SID]["enabled"] is True


# ---------------------------------------------------------------------------
# Idempotency.
# ---------------------------------------------------------------------------


def test_disabling_an_already_disabled_skill_is_a_reconciled_no_op(monkeypatch):
    _install()
    governed_skills.disable_governed_skill(SID)

    class _MustNotRun:
        def __init__(self, **kwargs):
            raise AssertionError("coordinator must not run for an idempotent disable")

    monkeypatch.setattr(governed_skills, "ActivationCoordinator", _MustNotRun)
    result = governed_skills.disable_governed_skill(SID)

    assert result["ok"] is True
    assert result["reconciledFromPriorSuccess"] is True
    assert result["disabled"] is True
    assert not skill_publisher.is_published(SID)


def test_disabled_but_still_published_is_healed_not_short_circuited():
    """The exact divergence this lane exists to fix (governance says
    disabled, the bytes are still being rendered) must NOT satisfy the
    idempotent fast path: a call has to run the full transaction and remove
    the projection."""
    _install()
    # Manufacture the divergence with the shipped defect itself: the bare
    # store disable that moves governance only.
    governed_skills._store().disable(SID)
    assert _state()["active"][SID]["enabled"] is False
    assert skill_publisher.is_published(SID), "precondition: diverged"
    assert SID in _rendered_prompt(), "precondition: still rendered despite 'disabled'"

    result = governed_skills.disable_governed_skill(SID)

    assert result.get("reconciledFromPriorSuccess") is None
    assert not skill_publisher.is_published(SID), "the call healed the projection"
    assert SID not in _rendered_prompt()


def test_enabled_but_unpublished_is_healed_not_short_circuited():
    """The mirror divergence: governance enabled, nothing published. The
    fast path requires BOTH halves, so this runs the full transaction and
    lands on a coherent disabled+unpublished state."""
    _install()
    skill_publisher.unpublish_skill(SID)
    assert _state()["active"][SID]["enabled"] is True
    assert not skill_publisher.is_published(SID), "precondition: diverged"

    result = governed_skills.disable_governed_skill(SID)

    assert result.get("reconciledFromPriorSuccess") is None
    assert result["disabled"] is True
    assert _state()["active"][SID]["enabled"] is False
    assert not skill_publisher.is_published(SID)


# ---------------------------------------------------------------------------
# Operator surface shapes.
# ---------------------------------------------------------------------------


def test_surface_refuses_when_governance_is_disabled(monkeypatch, tmp_path):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "")
    result = skill_rollback.disable(SID)
    assert result["ok"] is False
    assert result["code"] == "GOVERNED_SKILLS_DISABLED"
    assert result["retryable"] is False


def test_surface_success_and_invalid_target_shapes():
    _install()

    ok = skill_rollback.disable(SID)
    assert ok["ok"] is True and ok["disabled"] is True and ok["published"] is False

    unknown = skill_rollback.disable("never.installed")
    assert unknown["ok"] is False
    assert unknown["code"] == "SKILL_DISABLE_INVALID_TARGET"
    assert unknown["retryable"] is False

    bad_id = skill_rollback.disable("../escape")
    assert bad_id["code"] == "SKILL_DISABLE_INVALID_TARGET"
    assert "invalid skill id" in bad_id["error"]


def test_surface_failure_shapes_omit_the_queue_status_field():
    """A disable has no skill_queue row; emitting status:'pending' would be
    a queue-row claim about a row that does not exist."""
    _install()
    hermes_runner.RUNNING["live-task"] = object()
    try:
        busy = skill_rollback.disable(SID)
    finally:
        hermes_runner.RUNNING.pop("live-task", None)
    assert busy["code"] == "SKILL_RUNTIME_BUSY"
    assert busy["retryable"] is True
    assert "status" not in busy
    assert busy["activeTasks"] == 1


# ---------------------------------------------------------------------------
# Version listing reflects disabled state.
# ---------------------------------------------------------------------------


def test_list_versions_shows_disabled_state_distinctly_from_never_active():
    """get_active() filters on the enabled flag, so a disabled skill and a
    never-active one both surface activeDigest=None. After this lane those
    two states have different remedies, so they must be distinguishable."""
    digest = _install()
    before = skill_rollback.list_versions(SID)
    assert before["disabled"] is False
    assert before["activeDigest"] == digest
    assert before["disabledDigest"] is None

    governed_skills.disable_governed_skill(SID)

    after = skill_rollback.list_versions(SID)
    assert after["ok"] is True
    assert after["disabled"] is True
    assert after["activeDigest"] is None, "get_active filters disabled entries"
    assert after["disabledDigest"] == digest, (
        "the operator needs the digest to roll back to in order to re-enable"
    )
    # The installed version is still listed as a rollback candidate.
    assert [entry["digest"] for entry in after["versions"]] == [digest]
    # Nothing is published any more, so there is no published digest.
    assert after["publishedDigest"] is None
    assert after["publishedVerified"] is False


def test_list_versions_disabled_is_false_for_a_never_active_skill():
    result = skill_rollback.list_versions("never.installed")
    assert result["ok"] is True
    assert result["disabled"] is False
    assert result["disabledDigest"] is None
    assert result["activeDigest"] is None


# ---------------------------------------------------------------------------
# Publisher primitive: retention must leave the loadable tree.
# ---------------------------------------------------------------------------


def test_retain_unpublish_moves_the_projection_out_of_the_loadable_tree():
    _install()
    retain_root = skill_publisher.published_skills_retained_root() / "probe"

    result = skill_publisher.retain_unpublish_skill(SID, retain_into=retain_root)

    assert result["removed"] is True
    retained = Path(result["retainedPath"])
    assert retained.is_dir()
    assert (retained / "SKILL.md").read_text(encoding="utf-8") == V1_MD
    assert not skill_publisher.is_published(SID)

    # The retained copy must NOT sit anywhere the real loader scans --
    # dot-prefixed names are not excluded upstream and sort first, so a
    # retained copy left inside the tree would keep winning the dedup.
    from agent.skill_utils import get_all_skills_dirs

    for skills_dir in map(Path, get_all_skills_dirs()):
        assert skills_dir.resolve() not in retained.resolve().parents
    assert SID not in _rendered_prompt()


def test_retain_unpublish_of_an_unpublished_skill_is_a_no_op():
    result = skill_publisher.retain_unpublish_skill(
        "nothing.here",
        retain_into=skill_publisher.published_skills_retained_root() / "probe",
    )
    assert result == {
        "ok": True,
        "skillId": "nothing.here",
        "removed": False,
        "retainedPath": None,
    }


def test_retain_unpublish_refuses_a_retention_root_inside_the_loadable_tree():
    """The inverse-membership gate must run BEFORE the projection is
    touched, or a refused call would still have unpublished the skill."""
    _install()
    inside = skill_publisher.published_skills_dir() / "retained-inside"

    with pytest.raises(skill_publisher.SkillPublicationError):
        skill_publisher.retain_unpublish_skill(SID, retain_into=inside)

    assert skill_publisher.is_published(SID), "a refused retention must not unpublish"


# ---------------------------------------------------------------------------
# Reachability: the tool is actually registered on the MCP server.
# ---------------------------------------------------------------------------


def test_disable_tool_is_registered_on_the_server():
    """The other half of the unenforced-claim defect is reachability -- a
    capability with no production caller. If this tool falls off the
    server, the defect is back regardless of how green the kernel tests
    are."""
    import asyncio

    from mcp_wrapper import server

    assert callable(server.disable_skill)
    tool_names = {tool.name for tool in asyncio.run(server.mcp.list_tools())}
    assert "disable_skill" in tool_names


# ---------------------------------------------------------------------------
# F-2: empty skill bodies are refused.
# ---------------------------------------------------------------------------


def test_empty_skill_body_is_refused_at_the_validation_seam():
    """GS-ACCEPT F-2: validation bounded SKILL.md from above only, so an
    empty body published as a 0-byte file that renders nothing -- an
    approval recording a capability that provably did not exist."""
    from mcp_wrapper.verified_skill_store import SkillEmptyBodyError

    with pytest.raises(SkillEmptyBodyError):
        governed_skills.install_approved_skill(SID, "")

    assert not skill_publisher.is_published(SID)
    assert SID not in _state()["active"]


def test_whitespace_only_skill_body_is_refused():
    """A body of nothing but newlines/spaces is equally inert, so the bound
    is 'at least one non-whitespace byte', not 'len > 0'."""
    from mcp_wrapper.verified_skill_store import SkillEmptyBodyError

    for blank in ("   ", "\n\n\n", "\t \r\n"):
        with pytest.raises(SkillEmptyBodyError):
            governed_skills.install_approved_skill(SID, blank)

    assert not skill_publisher.is_published(SID)


def test_empty_body_error_is_a_validation_error_subclass():
    """Typed separately for an actionable operator message, but still a
    SkillValidationError so every existing fail-closed handler keeps
    working unchanged."""
    from mcp_wrapper.verified_skill_store import (
        SkillEmptyBodyError,
        SkillValidationError,
    )

    assert issubclass(SkillEmptyBodyError, SkillValidationError)


def test_publisher_independently_refuses_an_empty_body():
    """skill_publisher validates packages independently of the store (it
    deliberately does not import the store's private validator), so the
    lower bound must be enforced on both sides or publication is a bypass
    seam."""
    import json as _json

    from mcp_wrapper.verified_skill_store import file_digest, package_digest

    package = Path(skill_publisher.published_skills_dir()).parent / "empty-pkg"
    package.mkdir(parents=True, exist_ok=True)
    skill_bytes = b""
    manifest = {
        "schemaVersion": 1,
        "id": SID,
        "version": "1.0.0",
        "name": SID,
        "description": "empty body probe",
        "source": "local:test",
        "files": {"SKILL.md": file_digest(skill_bytes)},
        "requiredCapabilities": ["read"],
        "compatibleProfiles": ["default"],
    }
    manifest_bytes = _json.dumps(
        manifest, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    (package / "skill.json").write_bytes(manifest_bytes)
    (package / "SKILL.md").write_bytes(skill_bytes)

    with pytest.raises(skill_publisher.SkillPackageShapeError):
        skill_publisher.publish_skill(
            package, digest=package_digest(manifest_bytes, skill_bytes)
        )


def test_legacy_pre_f2_empty_body_skill_can_still_be_disabled(tmp_path):
    """G2A GS-DISABLE finding 3 regression: MIN_SKILL_BYTES is retroactive,
    and disable()'s audit-artifact read used to re-validate the installed
    package -- making a legacy (pre-F-2) empty-body skill UNDISABLEABLE.
    The one skill an operator most needs to turn off was the one skill
    disable refused, and reconcile() could then flip governance off while
    the projection kept rendering: the exact divergence this lane closes.
    Legacy state is fabricated directly on disk because the modern pipeline
    correctly refuses to create it."""
    import shutil
    import time

    from mcp_wrapper.verified_skill_store import package_digest

    store = governed_skills._store()

    workspace = tmp_path / "legacy-package"
    package = governed_skills._build_package(workspace, SID, "")
    manifest_bytes = (package / "skill.json").read_bytes()
    digest = package_digest(manifest_bytes, b"")

    version_dir = store.versions_dir / SID / digest
    version_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(package, version_dir)

    state_path = Path(store.root) / "state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["installed"].setdefault(SID, {})[digest] = {
        "version": "1.0.0",
        "source": "torqclaw:operator-approval",
        "permissions": ["read"],
        "digest": digest,
        "installedAt": time.time_ns(),
    }
    state["active"][SID] = {"digest": digest, "enabled": True, "permissions": ["read"]}
    state_path.write_text(json.dumps(state), encoding="utf-8")

    published_dir = skill_publisher.published_skills_dir() / SID
    published_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(package / "skill.json", published_dir / "skill.json")
    shutil.copy(package / "SKILL.md", published_dir / "SKILL.md")
    (published_dir / skill_publisher.PROVENANCE_FILENAME).write_text(
        json.dumps({
            "schemaVersion": 1,
            "skillId": SID,
            "digest": digest,
            "publishedAt": time.time_ns(),
            "source": "torqclaw:operator-approval",
        }),
        encoding="utf-8",
    )
    assert skill_publisher.is_published(SID), "precondition: legacy skill published"

    result = skill_rollback.disable(SID)

    assert result["ok"] is True, f"legacy empty-body skill must be disableable: {result}"
    assert not skill_publisher.is_published(SID)
    final = _state()
    assert final["active"][SID]["enabled"] is False
    disabled_entries = [e for e in final["audit"] if e["action"] == "disabled"]
    assert disabled_entries, "disable must still be audited (degraded record)"
    assert disabled_entries[-1]["skillId"] == SID
    assert disabled_entries[-1]["digest"] == digest
