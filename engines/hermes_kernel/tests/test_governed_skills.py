"""Phase 1: wire the governed skill pipeline to the live approval path.

Before this, `skill_queue.decide()` on APPROVE did a bare
`(skill_dir / "SKILL.md").write_text(content)` -- no digest, no manifest, no
approval binding, no audit, no rollback -- while ~2,200 lines of machinery
providing exactly those properties (VerifiedSkillStore + skill_publisher) sat
unreachable from any running program.

These tests pin the wiring itself, not the components. Each component was
already tested in isolation; that is precisely how all of it stayed orphaned.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper import hermes_runner  # noqa: E402,F401  (vendor sys.path insert)
from mcp_wrapper import governed_skills  # noqa: E402

vendored_available, vendor_import_error = hermes_runner.hermes_available()
pytestmark = pytest.mark.skipif(
    not vendored_available,
    reason=f"vendored hermes-agent unavailable: {vendor_import_error}",
)


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
    governed_skills._reset_for_test()
    yield
    governed_skills._reset_for_test()


def test_disabled_by_default_so_shipped_behaviour_is_unchanged(monkeypatch):
    """The flag must default OFF. Enabling a new write path for every existing
    deployment without opt-in would be a behaviour change smuggled in as a
    refactor."""
    monkeypatch.delenv("TORQCLAW_GOVERNED_SKILLS", raising=False)
    assert governed_skills.enabled() is False


def test_enabled_only_by_explicit_truthy_flag(monkeypatch):
    for on in ("1", "true", "TRUE", "yes", "on"):
        monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", on)
        assert governed_skills.enabled() is True, on
    for off in ("0", "false", "no", "off", "", "  "):
        monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", off)
        assert governed_skills.enabled() is False, repr(off)


def test_install_produces_a_digest_bound_audited_record(monkeypatch):
    """The whole point of the governed path: an approved skill becomes a
    digest-identified, audited artifact rather than an anonymous file write."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    result = governed_skills.install_approved_skill(
        "demo.skill", "Use the approved workflow.\n"
    )
    assert result["ok"] is True
    assert len(result["digest"]) == 64                    # sha256 hex
    int(result["digest"], 16)                             # is actually hex

    store = governed_skills._store()
    state = json.loads((Path(store.root) / "state.json").read_text(encoding="utf-8"))
    actions = [entry["action"] for entry in state["audit"]]
    assert "approved" in actions
    assert "activated" in actions


def test_installed_skill_is_discoverable_by_the_REAL_hermes_loader(monkeypatch):
    """The claim that matters. Not 'a file exists' -- that a real Hermes
    process would actually load this skill. Asserted through the upstream
    loader, which is the check the orphaned code never had applied to it."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills.install_approved_skill("loadable.skill", "Real content.\n")

    from agent.skill_utils import get_all_skills_dirs, iter_skill_index_files

    found = set()
    for skills_dir in get_all_skills_dirs():
        skills_dir = Path(skills_dir)
        if not skills_dir.is_dir():
            continue
        for skill_file in iter_skill_index_files(skills_dir, "SKILL.md"):
            found.add(Path(skill_file).parent.name)
    assert "loadable.skill" in found


def test_content_round_trips_byte_exactly(monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    body = "# Title\n\nBody with unicode: ✓ and a trailing newline.\n"
    result = governed_skills.install_approved_skill("roundtrip.skill", body)
    assert Path(result["publishedPath"], "SKILL.md").read_text(encoding="utf-8") == body


def test_rejects_a_skill_id_that_would_escape_the_skills_directory(monkeypatch):
    """Path traversal via the operator-supplied name. The legacy path did
    `SKILLS_DIR / name` with no validation at all."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    for bad in ("../escape", "a/b", "..", "", "   ", "a\\b"):
        with pytest.raises(governed_skills.GovernedSkillError):
            governed_skills.install_approved_skill(bad, "x\n")


def test_reinstalling_the_same_name_with_new_content_supersedes_it(monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    first = governed_skills.install_approved_skill("versioned.skill", "v1\n")
    second = governed_skills.install_approved_skill("versioned.skill", "v2\n")
    assert first["digest"] != second["digest"]
    assert Path(second["publishedPath"], "SKILL.md").read_text(encoding="utf-8") == "v2\n"


def test_idempotency_check_rehashes_published_bytes_not_just_the_sidecar(monkeypatch):
    """GS-COORD round 2, item 4: _already_active_and_published must not trust
    the provenance sidecar's claimed digest alone. G1R's exact probe:
    activate real content, then tamper with the published SKILL.md bytes
    out-of-band while leaving the (now-stale) sidecar claiming a match. A
    retry with the same (skill_id, markdown) pair must NOT report
    reconciledFromPriorSuccess -- that would serve the tampered bytes as if
    they were a verified prior success. It must instead fall through to a
    real (re-)activation attempt, which republishes the correct content."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    first = governed_skills.install_approved_skill("tamper.skill", "GOOD\n")
    assert first["ok"] is True

    published_path = Path(first["publishedPath"], "SKILL.md")
    assert published_path.read_text(encoding="utf-8") == "GOOD\n"

    # Tamper: overwrite the published bytes out-of-band. The provenance
    # sidecar (.torqclaw-provenance.json) is left untouched, so it still
    # claims the ORIGINAL digest -- exactly the "sidecar lies" scenario.
    published_path.write_text("EVIL\n", encoding="utf-8")

    retried = governed_skills.install_approved_skill("tamper.skill", "GOOD\n")

    assert retried.get("reconciledFromPriorSuccess") is not True, (
        "must not reconcile against corrupted published bytes just because "
        "the provenance sidecar still claims the correct digest"
    )
    assert retried["ok"] is True
    # A real (re-)activation must have run and restored the correct bytes.
    assert published_path.read_text(encoding="utf-8") == "GOOD\n"


def test_failure_leaves_nothing_published(monkeypatch):
    """Fail closed: a mid-install failure must not leave a partially governed
    skill that Hermes could load."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    published_root = Path(os.environ["TORQCLAW_DATA_DIR"]) / "published_skills"

    import mcp_wrapper.skill_publisher as sp
    real = sp.publish_skill

    def boom(*a, **k):
        raise RuntimeError("injected publish failure")

    monkeypatch.setattr(sp, "publish_skill", boom)
    with pytest.raises(Exception):
        governed_skills.install_approved_skill("doomed.skill", "x\n")
    monkeypatch.setattr(sp, "publish_skill", real)

    assert not (published_root / "doomed.skill").exists()
    leftovers = list(published_root.glob(".torqclaw-*")) if published_root.exists() else []
    assert leftovers == []


# ---------------------------------------------------------------------------
# The wiring itself: skill_queue.decide() must route through the governed
# pipeline when the flag is on, and keep legacy behaviour when it is off.
# Testing governed_skills alone is exactly how the old code stayed orphaned.
# ---------------------------------------------------------------------------

def _fresh_queue(monkeypatch, tmp_path):
    """skill_queue opens its SQLite connection at import; re-import it against
    the isolated TORQCLAW_DATA_DIR this test set up."""
    import importlib
    import mcp_wrapper.skill_queue as sq
    monkeypatch.setenv("HERMES_SKILLS_DIR", str(tmp_path / "legacy_skills"))
    return importlib.reload(sq)


def test_decide_APPROVE_uses_the_governed_path_when_enabled(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()

    qid = sq.queue_skill("wired.skill", "Governed content.\n")
    result = sq.decide(qid, "APPROVE")

    assert result["ok"] is True
    assert result.get("governed") is True
    assert len(result["digest"]) == 64

    # The real loader must see it -- not just "a file exists somewhere".
    from agent.skill_utils import get_all_skills_dirs, iter_skill_index_files
    found = set()
    for d in get_all_skills_dirs():
        d = Path(d)
        if not d.is_dir():
            continue
        for f in iter_skill_index_files(d, "SKILL.md"):
            found.add(Path(f).parent.name)
    assert "wired.skill" in found


def test_decide_APPROVE_keeps_legacy_behaviour_when_flag_is_off(tmp_path, monkeypatch):
    """Default-off must be genuinely unchanged, not merely 'also works'."""
    monkeypatch.delenv("TORQCLAW_GOVERNED_SKILLS", raising=False)
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()

    qid = sq.queue_skill("legacy.skill", "Legacy content.\n")
    result = sq.decide(qid, "APPROVE")

    assert result == {"ok": True, "status": "approved"}      # exact legacy shape
    assert "governed" not in result
    legacy_file = tmp_path / "legacy_skills" / "legacy.skill" / "SKILL.md"
    assert legacy_file.read_text(encoding="utf-8") == "Legacy content.\n"


def test_decide_REJECT_writes_nothing_under_either_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()

    qid = sq.queue_skill("rejected.skill", "Never installed.\n")
    result = sq.decide(qid, "REJECT")

    assert result["ok"] is True and result["status"] == "rejected"
    assert "governed" not in result
    published = Path(os.environ["TORQCLAW_DATA_DIR"]) / "published_skills" / "rejected.skill"
    assert not published.exists()
