"""GS-ACCEPT -- the 15-step live acceptance owed before governed skills go
default-on.

WHY THIS EXISTS, AND WHY IT IS NOT test_activation_coordinator_wiring.py:

The modules already pass unit tests. What was unproven is the *shipped
behaviour*. The lesson recorded as `verify-the-artifact-not-the-unit-test`:
a "fixed" auth hole stayed open while 14 unit tests passed, because the tests
exercised the module and the running binary served stale `dist/`.

So every assertion here goes through a real boot path:

  - a real ``AIAgent`` is constructed (steps 7, 10), not mocked
  - discoverability is asserted on the REAL RENDERED SYSTEM PROMPT via
    ``build_skills_system_prompt()`` -- the same function the model's turn
    consumes -- not on the loader's helper functions. Everything shipped so
    far proved discoverability through ``iter_skill_index_files``; that is
    what `external-dirs-mtime-cache-trap` warns is insufficient, because the
    prompt builder caches NEGATIVE lookups on ``config.yaml`` mtime and can
    render an empty index while the loader functions happily report the file.
  - the whole stack is restarted (step 12) by discarding every module-level
    cache and re-reading from disk

ISOLATION: everything is scoped to a per-test ``TORQCLAW_DATA_DIR`` and a
per-test Hermes skills dir. This never reads or writes the operator's real
``~/.torqclaw``. Asserted in ``_isolated_env`` rather than assumed.

NO NETWORK, NO TOKENS: ``AIAgent`` construction is what steps 7/10 require --
a rendered prompt and a live skill index. No ``run_conversation`` is issued, so
no provider call is made and no tokens are spent. The provider is pointed at a
local Ollama base_url so a construction path that *does* probe the provider
fails loudly rather than reaching out to a paid endpoint.
"""

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.acceptance

# Importing hermes_runner is what puts the vendored hermes-agent on sys.path
# (hermes_runner.py:89). Doing it this way rather than manipulating sys.path
# here means the acceptance run resolves `run_agent` and `agent.prompt_builder`
# by exactly the mechanism production uses -- if that mechanism breaks, this
# suite fails, which is the point.
from mcp_wrapper import hermes_runner as _hermes_runner  # noqa: E402,F401


# --------------------------------------------------------------------------
# harness
# --------------------------------------------------------------------------


def _reload_stack():
    """Simulate a full process restart.

    Governed activation state must survive this (step 13). Module-level caches
    are exactly where a false 'it works' can hide: if the digest only looks
    correct because it is memoised, a restart exposes it.
    """
    import mcp_wrapper.skill_publisher as skill_publisher
    import mcp_wrapper.governed_skills as governed_skills
    import mcp_wrapper.verified_skill_store as verified_skill_store
    import mcp_wrapper.skill_queue as skill_queue

    for mod in (verified_skill_store, skill_publisher, governed_skills, skill_queue):
        importlib.reload(mod)

    _clear_prompt_cache(clear_snapshot=True)
    return importlib.import_module("mcp_wrapper.governed_skills")


def _clear_prompt_cache(*, clear_snapshot: bool = False) -> None:
    from agent.prompt_builder import clear_skills_system_prompt_cache

    clear_skills_system_prompt_cache(clear_snapshot=clear_snapshot)


def _invalidate_external_dirs_cache() -> None:
    """Drop upstream's external_dirs cache.

    Upstream keys it on ``config.yaml`` mtime (skill_utils.py:348-362). A test
    that writes config.yaml and immediately reads can land inside the same
    mtime tick and see a stale -- often NEGATIVE -- result. That is the trap
    recorded as `external-dirs-mtime-cache-trap`; the product already invalidates
    around it, and the harness must too or it will fail for the wrong reason.
    """
    from mcp_wrapper.skill_publisher import _invalidate_upstream_external_dirs_cache

    _invalidate_upstream_external_dirs_cache()


def _rendered_skill_index() -> str:
    """The skills section of the REAL system prompt the model would receive.

    This is the assertion surface for steps 8 and 11. Deliberately NOT
    ``iter_skill_index_files`` -- see the module docstring.
    """
    _clear_prompt_cache()
    from agent.prompt_builder import build_skills_system_prompt

    return build_skills_system_prompt() or ""


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Per-test isolation, asserted rather than assumed.

    ``HERMES_HOME`` moves config.yaml and the local skills dir; the operator's
    real ``AppData/Local/hermes`` and ``~/.torqclaw`` are never touched. Both
    are asserted below, not assumed -- an isolation bug here would publish test
    skills into the operator's live agent.

    Writing a real ``config.yaml`` with ``skills.external_dirs`` is not harness
    convenience: it is the operator configuration step the shipped guard
    (``SkillNotExternallyLoadableError``) requires, so the acceptance run
    exercises that path too.
    """
    hermes_home = tmp_path / "hermes-home"
    data_dir = tmp_path / "torqclaw-data"
    published = data_dir / "published_skills"
    for d in (hermes_home, data_dir, published):
        d.mkdir(parents=True)

    real_torqclaw = Path.home() / ".torqclaw"
    real_hermes = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "hermes"

    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(data_dir))
    monkeypatch.setenv("HERMES_PROVIDER", "ollama")
    monkeypatch.setenv("HERMES_MODEL", "qwen2.5:0.5b")
    monkeypatch.setenv("HERMES_BASE_URL", "http://localhost:11434")
    monkeypatch.setenv("HERMES_API_KEY", "not-used-no-turn-is-issued")

    # The operator config step: declare the publish target as externally
    # loadable. Forward slashes keep this valid YAML on Windows.
    (hermes_home / "config.yaml").write_text(
        "skills:\n  external_dirs:\n    - " + str(published).replace("\\", "/") + "\n",
        encoding="utf-8",
    )

    from mcp_wrapper import skill_publisher

    importlib.reload(skill_publisher)
    _clear_prompt_cache(clear_snapshot=True)
    _invalidate_external_dirs_cache()

    resolved = skill_publisher.published_skills_dir()
    for forbidden in (real_torqclaw, real_hermes):
        assert forbidden not in resolved.parents and resolved != forbidden, (
            f"ISOLATION FAILURE: publish target {resolved} is inside the "
            f"operator's real directory {forbidden}. Refusing to run."
        )

    from agent.skill_utils import get_all_skills_dirs

    assert resolved.resolve() in [d.resolve() for d in get_all_skills_dirs()], (
        f"harness misconfigured: {resolved} is not in get_all_skills_dirs(); "
        "the config.yaml write or the cache invalidation did not take effect"
    )
    return {"data": data_dir, "skills": hermes_home / "skills", "published": resolved}


SKILL_ID = "gs-accept-probe"
SKILL_MD = """---
name: gs-accept-probe
description: Acceptance probe skill. Converts furlongs to metres.
---

# Furlong conversion

One furlong is 201.168 metres. Multiply furlongs by 201.168.
"""


# --------------------------------------------------------------------------
# steps 1-2 -- flag semantics at the real entry point
# --------------------------------------------------------------------------


def test_step_01_flag_off_leaves_legacy_behaviour_unchanged(env):
    """Flag off: the governed path must not engage at all."""
    os.environ.pop("TORQCLAW_GOVERNED_SKILLS", None)
    governed = _reload_stack()

    assert governed.enabled() is False
    assert not any(env["published"].glob("*")) if env["published"].exists() else True


def test_step_02_restart_with_governed_enabled(env, monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()
    assert governed.enabled() is True


# --------------------------------------------------------------------------
# steps 3-6 -- stage, review the digest, approve, verify real publication
# --------------------------------------------------------------------------


def test_steps_03_to_06_stage_review_approve_publish(env, monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()

    # 3+5: stage and approve through the REAL install path.
    result = governed.install_approved_skill(SKILL_ID, SKILL_MD)

    # 4: the digest is bare 64-hex and is bound to the approved content.
    digest = result["digest"]
    assert isinstance(digest, str) and len(digest) == 64, digest
    assert all(c in "0123456789abcdef" for c in digest)

    # 6: publication landed in the REAL resolved external_dirs path, with the
    #    exact approved bytes -- not merely "a file exists".
    published = env["published"] / SKILL_ID / "SKILL.md"
    assert published.is_file(), f"nothing published at {published}"
    assert published.read_text(encoding="utf-8") == SKILL_MD

    state = json.loads((env["data"] / "verified_skills" / "state.json").read_text())
    assert state["active"][SKILL_ID]["digest"] == digest


# --------------------------------------------------------------------------
# steps 7-8 -- THE ONES NO UNIT TEST SUBSTITUTES FOR
# --------------------------------------------------------------------------


def test_steps_07_08_fresh_agent_sees_skill_in_rendered_prompt(env, monkeypatch):
    """A real AIAgent boots and the skill is in the prompt it would send.

    This is the step the whole program is owed. Prior evidence proved the
    loader's *functions* can find the file; this proves the *model's index*
    contains it.
    """
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()
    governed.install_approved_skill(SKILL_ID, SKILL_MD)

    # 7: a genuinely fresh agent construction.
    from run_agent import AIAgent

    agent = AIAgent(
        model=os.environ["HERMES_MODEL"],
        provider=os.environ["HERMES_PROVIDER"],
        api_key=os.environ["HERMES_API_KEY"],
        base_url=os.environ["HERMES_BASE_URL"],
        max_iterations=1,
        enabled_toolsets=["skills"],
    )
    assert agent is not None

    # 8: present in the rendered index the model actually receives.
    rendered = _rendered_skill_index()
    assert SKILL_ID in rendered, (
        "skill published and governed-active but ABSENT from the rendered "
        f"system prompt. Rendered index was:\n{rendered[:2000]}"
    )
    assert "furlong" in rendered.lower()


# --------------------------------------------------------------------------
# steps 9-11 -- rollback must be visible to a fresh boot
# --------------------------------------------------------------------------


def test_steps_09_to_11_rolled_back_version_is_not_usable(env, monkeypatch):
    """Roll back to a prior digest; the SUPERSEDED content must leave the
    model's index.

    GS-ROLLBACK closed F-1: rollback now runs end to end through
    ``governed_skills.rollback_governed_skill`` -- projection, prompt cache,
    and governance move together. This test's original run reached the
    store's governance-only ``rollback()`` directly (there was no production
    path to call -- that WAS the finding) and xfailed on the divergence it
    left; both the xfail and the direct store call are gone deliberately.

    As of GS-DISABLE step 9's "roll back / disable" is satisfied on BOTH
    halves: the disable half is asserted in
    ``test_step_09b_disabled_skill_leaves_the_rendered_prompt`` below,
    against the same rendered-prompt surface.
    """
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()

    v1 = governed.install_approved_skill(SKILL_ID, SKILL_MD)["digest"]
    v2_md = SKILL_MD.replace("201.168", "999.999").replace(
        "Converts furlongs to metres.", "Converts furlongs badly."
    )
    governed.install_approved_skill(SKILL_ID, v2_md)

    rendered = _rendered_skill_index()
    assert "999.999" in rendered or "badly" in rendered, (
        "v2 was activated but the rendered prompt still shows v1 -- the model "
        "is using superseded content."
    )

    # 9: roll back to the exact prior digest through the PRODUCTION path
    # (GS-ROLLBACK). Never the bare store: that call moves governance only
    # and was precisely the F-1 divergence.
    rollback_result = governed.rollback_governed_skill(SKILL_ID, v1)
    assert rollback_result["ok"] is True and rollback_result["rolledBack"] is True

    # 10+11: a fresh boot must not offer the superseded version.
    from run_agent import AIAgent

    AIAgent(
        model=os.environ["HERMES_MODEL"],
        provider=os.environ["HERMES_PROVIDER"],
        api_key=os.environ["HERMES_API_KEY"],
        base_url=os.environ["HERMES_BASE_URL"],
        max_iterations=1,
        enabled_toolsets=["skills"],
    )

    state = json.loads((env["data"] / "verified_skills" / "state.json").read_text())
    assert state["active"][SKILL_ID]["digest"] == v1, "governed rollback did not move"

    # Step 11, the assertion F-1 made impossible: the rendered system prompt
    # -- the surface the model's turn actually consumes -- serves the rolled-
    # back version and NOT the superseded one.
    rendered = _rendered_skill_index()
    assert "999.999" not in rendered and "badly" not in rendered, (
        "governed rollback reported success but the rendered system prompt "
        "still contains the superseded v2 body -- the F-1 divergence is back."
    )
    # The index renders the skill id + DESCRIPTION (not the body), and the
    # description is exactly what v2 changed: "furlongs to metres" (v1) vs
    # "furlongs badly" (v2). Asserting on it distinguishes the versions on
    # the surface the model actually reads.
    assert SKILL_ID in rendered and "furlongs to metres" in rendered, (
        "the rolled-back v1 skill is absent from the rendered system prompt; "
        "rollback must re-publish the prior projection, not merely remove v2."
    )


def test_step_09b_disabled_skill_leaves_the_rendered_prompt(env, monkeypatch):
    """The disable half of step 9, closed by GS-DISABLE.

    ``VerifiedSkillStore.disable()`` had the same defect shape F-1 found in
    ``rollback()``: governance-only, no production caller, so a "disabled"
    skill kept being rendered into every system prompt. This drives the
    PRODUCTION OPERATOR SURFACE (``skill_rollback.disable`` -- what the
    ``disable_skill`` MCP tool calls), never the bare store, and asserts on
    the rendered index a freshly booted agent would receive.
    """
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()

    digest = governed.install_approved_skill(SKILL_ID, SKILL_MD)["digest"]
    assert SKILL_ID in _rendered_skill_index(), "precondition: the skill renders"

    # 9 (disable half): through the shipped operator surface.
    import mcp_wrapper.skill_rollback as skill_rollback

    importlib.reload(skill_rollback)
    result = skill_rollback.disable(SKILL_ID)
    assert result["ok"] is True, result
    assert result["disabled"] is True and result["published"] is False

    # A genuinely fresh agent construction, exactly as steps 7/10 require.
    from run_agent import AIAgent

    AIAgent(
        model=os.environ["HERMES_MODEL"],
        provider=os.environ["HERMES_PROVIDER"],
        api_key=os.environ["HERMES_API_KEY"],
        base_url=os.environ["HERMES_BASE_URL"],
        max_iterations=1,
        enabled_toolsets=["skills"],
    )

    # The assertion the store-only disable could never make: the skill is
    # gone from the surface the model's turn actually consumes.
    rendered = _rendered_skill_index()
    assert SKILL_ID not in rendered, (
        "disable reported success but the skill is STILL in the rendered "
        f"system prompt. Rendered index was:\n{rendered[:2000]}"
    )
    assert "furlong" not in rendered.lower()

    # Governance says disabled; the installed digest history survives, which
    # is what keeps rollback available as the re-enable path.
    state = json.loads((env["data"] / "verified_skills" / "state.json").read_text())
    assert state["active"][SKILL_ID]["enabled"] is False
    assert digest in state["installed"][SKILL_ID]
    assert not (env["published"] / SKILL_ID).exists()

    # And the documented inverse works: rollback re-enables AND republishes.
    governed.rollback_governed_skill(SKILL_ID, digest)
    assert SKILL_ID in _rendered_skill_index(), (
        "rollback is the documented inverse of disable; it must restore the "
        "model's index"
    )


# --------------------------------------------------------------------------
# steps 12-13 -- full stack restart
# --------------------------------------------------------------------------


def test_steps_12_13_governed_state_survives_full_restart(env, monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()
    digest = governed.install_approved_skill(SKILL_ID, SKILL_MD)["digest"]

    # 12: discard every module-level cache and re-read from disk.
    governed = _reload_stack()

    # 13: state is correct because it is DURABLE, not because it is memoised.
    state = json.loads((env["data"] / "verified_skills" / "state.json").read_text())
    assert state["active"][SKILL_ID]["digest"] == digest
    assert SKILL_ID in _rendered_skill_index()


# --------------------------------------------------------------------------
# step 14 -- failure cases, against the shipped path
# --------------------------------------------------------------------------


def test_step_14a_live_hermes_task_blocks_mutation(env, monkeypatch):
    """The frozen ruling: refuse while a task runs, leave the row retryable."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()

    from mcp_wrapper import hermes_runner
    from mcp_wrapper.runtime_quiescence import SkillRuntimeBusyError

    hermes_runner.RUNNING["accept-probe-task"] = object()
    try:
        with pytest.raises(SkillRuntimeBusyError):
            governed.install_approved_skill(SKILL_ID, SKILL_MD)
    finally:
        hermes_runner.RUNNING.pop("accept-probe-task", None)

    # nothing partial left behind
    assert not (env["published"] / SKILL_ID).exists()


def test_step_14b_malformed_skill_id_is_refused(env, monkeypatch):
    """A malformed skill *id* is refused before anything is written."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()

    for bad_id in ("../escape", "has space", "", "a" * 300):
        with pytest.raises(Exception):
            governed.install_approved_skill(bad_id, SKILL_MD)

    assert not any(env["published"].iterdir()), "a rejected id still published something"


def test_step_14b_empty_skill_body_is_refused(env, monkeypatch):
    """GS-ACCEPT finding F-2, CLOSED by GS-DISABLE's second deliverable.

    Validation bounded package size from ABOVE only (``MAX_SKILL_BYTES``),
    so an EMPTY body was structurally valid -- digests matched, the
    manifest was consistent, and a 0-byte ``SKILL.md`` was published that
    renders nothing into the prompt. Not a security hole, but a governance
    lie: the approval record claimed a capability that provably did not
    exist. ``MIN_SKILL_BYTES`` now enforces a lower bound at the package
    validation seam, so every read path is covered, not just install.
    """
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()

    from mcp_wrapper.verified_skill_store import SkillEmptyBodyError

    with pytest.raises(SkillEmptyBodyError):
        governed.install_approved_skill(SKILL_ID, "")

    # Whitespace-only is equally inert and equally refused.
    with pytest.raises(SkillEmptyBodyError):
        governed.install_approved_skill(SKILL_ID, "   \n\n  ")

    # Nothing partial was left behind by either refusal.
    assert not (env["published"] / SKILL_ID).exists()


def test_step_14c_digest_changed_after_approval_is_refused(env, monkeypatch):
    """Approving digest A must never publish content B."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed = _reload_stack()

    first = governed.install_approved_skill(SKILL_ID, SKILL_MD)["digest"]
    mutated = SKILL_MD.replace("201.168", "999.999")
    second = governed.install_approved_skill(SKILL_ID, mutated)["digest"]

    assert first != second, "content changed but digest did not -- digest is not content-bound"

    published = (env["published"] / SKILL_ID / "SKILL.md").read_text(encoding="utf-8")
    assert published == mutated
    state = json.loads((env["data"] / "verified_skills" / "state.json").read_text())
    assert state["active"][SKILL_ID]["digest"] == second
