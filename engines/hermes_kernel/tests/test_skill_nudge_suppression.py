"""P2-0: TORQCLAW's governed skill path must not be bypassable by upstream's
autonomous skill-creation/nudge loop, regardless of toolset configuration.

Covers mcp_wrapper.hermes_runner._suppress_skill_nudge (L1b, primary control)
and the "skills" toolset rejection in run_hermes_sync (L1, secondary control),
plus the actual upstream three-conjunct guard these controls must defeat.

Importing hermes_runner pulls the vendored agent locally (no network);
TORQCLAW_DATA_DIR is set at conftest module-top before collection."""
import os

import pytest

from mcp_wrapper import hermes_runner, task_store


# ---------------------------------------------------------------------------
# Fakes — a minimal stand-in for AIAgent that mirrors only the attributes and
# methods hermes_runner.run_hermes_sync actually touches, plus the exact
# three fields upstream's own nudge guard reads
# (turn_finalizer.py:377-379 / conversation_loop.py:518-520 /
# codex_runtime.py:277-283): _skill_nudge_interval, _iters_since_skill,
# valid_tool_names.
#
# KNOWN LIMITATION (accepted trade-off): these fakes hard-code the attribute
# name `_skill_nudge_interval` themselves, so they cannot detect an upstream
# RENAME of that field on the real AIAgent. If upstream renamed it, the real
# _suppress_skill_nudge would correctly fail closed and loudly at runtime
# (SkillNudgeSuppressionUnavailable, via the hasattr check) — but every test
# in this file would stay green, because the fake still defines the old
# name and nothing here re-derives it from the real vendored class. Closing
# this gap would require constructing a real AIAgent in CI, which needs
# provider credentials (API keys / network) this suite intentionally avoids.
# Mitigation: the docstrings/comments above pin the exact upstream line
# numbers this suite assumes, so a human/reviewer diffing against a vendor
# bump has a concrete anchor to check by hand.
# ---------------------------------------------------------------------------
class _FakeAgent:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        # Mirror agent_init.py:1230 default (nudge ON by construction,
        # same as real upstream) so suppression has something real to undo.
        self._skill_nudge_interval = 10
        self._iters_since_skill = 999999  # already past any interval
        # "*" (enabled_toolsets=None) restores skill_manage to the tool set,
        # exactly like real upstream's full default toolset.
        self.valid_tool_names = (
            {"skill_manage", "web_search"}
            if kwargs.get("enabled_toolsets") is None
            else {"web_search"}
        )

    def get_credits_spent_micros(self):
        return 0

    def close(self):
        pass


def _upstream_nudge_would_fire(agent) -> bool:
    """The EXACT three-conjunct condition from
    vendor/hermes-agent/agent/turn_finalizer.py:377-379 (identical guard also
    at conversation_loop.py:518-520 and codex_runtime.py:277-283). Tests must
    assert against this real expression, not merely against
    `_skill_nudge_interval == 0` in isolation — that alone would only prove
    our own assignment ran, not that upstream's actual gate is defeated."""
    return (
        agent._skill_nudge_interval > 0
        and agent._iters_since_skill >= agent._skill_nudge_interval
        and "skill_manage" in agent.valid_tool_names
    )


def _payload(prompt: str = "do something", task_type: str = "AUTONOMOUS_RESEARCH") -> dict:
    return {"payload": {"prompt": prompt, "taskType": task_type, "grantedTools": []}}


@pytest.fixture(autouse=True)
def _patch_agent(monkeypatch):
    """Swap the real AIAgent for the fake, and neutralize collaborators that
    would otherwise touch the real vendored plugin manager / network."""
    monkeypatch.setattr(hermes_runner, "AIAgent", _FakeAgent)
    monkeypatch.setattr(hermes_runner, "_snapshot_account_usage_usd", lambda **kw: None)
    monkeypatch.delenv("HERMES_STUB_COST_UNAVAILABLE", raising=False)
    yield


def _run(task_id: str, payload: dict):
    """Drive run_hermes_sync but stop right after agent construction/
    suppression — before it tries agent.run_conversation(), which _FakeAgent
    doesn't implement. That's fine: everything under test (L1, L1b, the
    evidence emit) happens before run_conversation is called. Let
    run_hermes_sync raise naturally when it calls agent.run_conversation
    (AttributeError, since _FakeAgent has no such method) and swallow it
    here — we only assert on state set before that point."""
    task_store.create(payload, task_id=task_id)
    try:
        hermes_runner.run_hermes_sync(task_id, payload)
    except AttributeError:
        pass


# ---------------------------------------------------------------------------
# 1. Configuration-independent suppression — normal allowlist AND "*".
# ---------------------------------------------------------------------------
def test_suppression_applies_under_normal_allowlist(monkeypatch):
    monkeypatch.delenv("HERMES_FRONTIER_TOOLSETS", raising=False)
    task_id = "suppress-normal-" + os.urandom(4).hex()
    _run(task_id, _payload())

    # _FakeAgent has no run_conversation, so RUNNING is populated and then the
    # AttributeError propagates up through the try/finally, which pops it.
    # Assert via the emitted SYSTEM event instead, which is written BEFORE
    # RUNNING registration and is not undone by the finally block.
    status = task_store.status(task_id)
    events = [e for e in status["events"] if "Skill nudge suppressed" in e["message"]]
    assert len(events) == 1
    assert events[0]["metadata"]["skillNudgeIntervalAfterSuppression"] == 0
    assert events[0]["metadata"]["toolsetWildcardOverride"] is False


def test_suppression_applies_under_wildcard_toolset_override(monkeypatch):
    """THE regression case that matters most: HERMES_FRONTIER_TOOLSETS="*"
    resolves enabled_toolsets to None (upstream's full default, "skills"
    restored — see hermes_runner._frontier_enabled_toolsets). L1 (the
    allowlist assertion) cannot see anything to reject here. Only L1b
    (_suppress_skill_nudge, unconditional) can hold, and this proves it
    does."""
    monkeypatch.setenv("HERMES_FRONTIER_TOOLSETS", "*")
    task_id = "suppress-wildcard-" + os.urandom(4).hex()
    _run(task_id, _payload())

    status = task_store.status(task_id)
    events = [e for e in status["events"] if "Skill nudge suppressed" in e["message"]]
    assert len(events) == 1
    assert events[0]["metadata"]["skillNudgeIntervalAfterSuppression"] == 0
    # Proves this is exactly the wildcard branch, not merely toolsets=None
    # via some other unrelated path.
    assert events[0]["metadata"]["toolsetWildcardOverride"] is True


# ---------------------------------------------------------------------------
# 2. The actual upstream three-conjunct guard cannot all be true afterward.
# ---------------------------------------------------------------------------
def test_upstream_three_conjunct_guard_defeated_normal_allowlist(monkeypatch):
    monkeypatch.delenv("HERMES_FRONTIER_TOOLSETS", raising=False)
    captured = {}

    class _CapturingAgent(_FakeAgent):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            captured["agent"] = self

    monkeypatch.setattr(hermes_runner, "AIAgent", _CapturingAgent)
    task_id = "guard-normal-" + os.urandom(4).hex()
    _run(task_id, _payload())

    agent = captured["agent"]
    # Sanity: iters_since_skill and valid_tool_names alone would have fired
    # the nudge pre-suppression (proves the fixture is a real regression test,
    # not a vacuous one).
    assert agent._iters_since_skill >= 10
    # The real upstream expression, not a restatement of our own assignment.
    assert _upstream_nudge_would_fire(agent) is False
    assert agent._skill_nudge_interval == 0


def test_upstream_three_conjunct_guard_defeated_wildcard_toolset(monkeypatch):
    """Same assertion, but with valid_tool_names actually containing
    "skill_manage" (the wildcard/enabled_toolsets=None case) — i.e. conjuncts
    2 and 3 are BOTH true on their own, and only conjunct 1 being forced to 0
    keeps the overall guard false."""
    monkeypatch.setenv("HERMES_FRONTIER_TOOLSETS", "*")
    captured = {}

    class _CapturingAgent(_FakeAgent):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            captured["agent"] = self

    monkeypatch.setattr(hermes_runner, "AIAgent", _CapturingAgent)
    task_id = "guard-wildcard-" + os.urandom(4).hex()
    _run(task_id, _payload())

    agent = captured["agent"]
    assert "skill_manage" in agent.valid_tool_names  # conjunct 3 true
    assert agent._iters_since_skill >= 10  # conjunct 2 true (relative to default 10)
    assert _upstream_nudge_would_fire(agent) is False  # yet overall guard is false
    assert agent._skill_nudge_interval == 0


# ---------------------------------------------------------------------------
# 3. Fail-closed when the control itself becomes unavailable.
# ---------------------------------------------------------------------------
def test_fail_closed_when_attribute_missing_entirely():
    class _NoNudgeAttrAgent:
        def __init__(self, **kwargs):
            pass

    with pytest.raises(hermes_runner.SkillNudgeSuppressionUnavailable):
        hermes_runner._suppress_skill_nudge(_NoNudgeAttrAgent())


def test_fail_closed_when_assignment_does_not_stick():
    class _ReadOnlyNudgeAgent:
        def __init__(self, **kwargs):
            object.__setattr__(self, "_frozen_interval", 10)

        @property
        def _skill_nudge_interval(self):
            return self._frozen_interval

        @_skill_nudge_interval.setter
        def _skill_nudge_interval(self, value):
            pass  # silently swallows the write — simulates upstream renaming semantics

    with pytest.raises(hermes_runner.SkillNudgeSuppressionUnavailable):
        hermes_runner._suppress_skill_nudge(_ReadOnlyNudgeAgent())


def test_run_hermes_sync_fails_task_closed_when_suppression_unavailable(monkeypatch):
    """End-to-end: if _suppress_skill_nudge can't verify suppression,
    run_hermes_sync must not proceed to run_conversation at all — the task
    must surface the failure, not swallow it and continue with an agent whose
    skill-nudge state is unverified."""
    class _NoNudgeAttrAgent:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def close(self):
            pass

    monkeypatch.setattr(hermes_runner, "AIAgent", _NoNudgeAttrAgent)
    monkeypatch.delenv("HERMES_FRONTIER_TOOLSETS", raising=False)
    task_id = "fail-closed-e2e-" + os.urandom(4).hex()
    task_store.create(_payload(), task_id=task_id)

    with pytest.raises(hermes_runner.SkillNudgeSuppressionUnavailable):
        hermes_runner.run_hermes_sync(task_id, _payload())

    # Must not still be registered as RUNNING after the failure.
    assert task_id not in hermes_runner.RUNNING


# ---------------------------------------------------------------------------
# 4. No collateral damage — L1 does not fire on the normal allowlist, and a
#    normal (non-skills) run reaches run_conversation successfully.
# ---------------------------------------------------------------------------
def test_l1_does_not_reject_normal_non_skills_allowlist(monkeypatch):
    """The secondary control (L1) must not be a trigger-happy false-positive
    machine: ordinary toolsets (no "skills" present) must sail through."""
    monkeypatch.delenv("HERMES_FRONTIER_TOOLSETS", raising=False)

    class _CompletingAgent(_FakeAgent):
        def run_conversation(self, *a, **kw):
            return {"final_response": "ok", "messages": []}

    monkeypatch.setattr(hermes_runner, "AIAgent", _CompletingAgent)
    task_id = "no-collateral-" + os.urandom(4).hex()
    task_store.create(_payload(), task_id=task_id)

    result = hermes_runner.run_hermes_sync(task_id, _payload())

    assert result["result"] == "ok"
    assert task_id not in hermes_runner.RUNNING  # cleaned up in finally


def test_l1_rejects_explicit_skills_in_allowlist(monkeypatch):
    """If an operator ever explicitly lists "skills" via
    HERMES_FRONTIER_TOOLSETS (a comma list, not "*"), L1 must reject it
    before agent construction — belt-and-suspenders alongside L1b."""
    monkeypatch.setenv("HERMES_FRONTIER_TOOLSETS", "web, skills")
    task_id = "l1-explicit-reject-" + os.urandom(4).hex()
    task_store.create(_payload(), task_id=task_id)

    with pytest.raises(RuntimeError, match="skill toolset must not reach the agent constructor"):
        hermes_runner.run_hermes_sync(task_id, _payload())


# ---------------------------------------------------------------------------
# 5. Adversarial invariant test, exactly as specified: wildcard toolsets +
#    upstream skill capability "available" + a task that would normally
#    trigger the nudge -> no autonomous skill becomes active, no unreviewed
#    skill reaches the Hermes-loadable skills tree, TORQCLAW records/surfaces
#    suppression.
# ---------------------------------------------------------------------------
def test_adversarial_wildcard_toolsets_no_autonomous_skill_activates(monkeypatch, tmp_path):
    """This test protects the CLAIM (the invariant in the ticket), not merely
    today's implementation: it asserts on the real upstream guard expression,
    on the Hermes-loadable skills directory being untouched, and on the
    suppression evidence event — not on any TORQCLAW-internal shortcut."""
    monkeypatch.setenv("HERMES_FRONTIER_TOOLSETS", "*")
    skills_dir = tmp_path / "hermes-skills"
    skills_dir.mkdir()
    monkeypatch.setenv("HERMES_SKILLS_DIR", str(skills_dir))

    captured = {}

    class _AdversarialAgent(_FakeAgent):
        """Simulates the worst case: skill_manage available, iteration count
        already past the interval — i.e. upstream's nudge WOULD fire on the
        next turn boundary if conjunct 1 weren't neutralized."""

        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            assert "skill_manage" in self.valid_tool_names  # upstream skill capability available
            captured["agent"] = self

        def run_conversation(self, *a, **kw):
            # If, hypothetically, upstream's guard fired here, it would call
            # skill_manager_tool.py's create/write path, which writes into
            # HERMES_SKILLS_DIR and calls clear_skills_system_prompt_cache to
            # make it live next turn. We assert below that nothing wrote here.
            return {"final_response": "task completed", "messages": []}

    monkeypatch.setattr(hermes_runner, "AIAgent", _AdversarialAgent)
    task_id = "adversarial-" + os.urandom(4).hex()
    task_store.create(_payload(task_type="COMPLEX_CODING"), task_id=task_id)

    result = hermes_runner.run_hermes_sync(task_id, _payload(task_type="COMPLEX_CODING"))

    agent = captured["agent"]
    # No autonomous skill becomes active: the real upstream guard is false.
    assert _upstream_nudge_would_fire(agent) is False
    assert agent._skill_nudge_interval == 0

    # No unreviewed skill reaches the Hermes-loadable skills tree.
    assert list(skills_dir.iterdir()) == []

    # TORQCLAW records/surfaces suppression.
    status = task_store.status(task_id)
    events = [e for e in status["events"] if "Skill nudge suppressed" in e["message"]]
    assert len(events) == 1
    assert events[0]["metadata"]["toolsetWildcardOverride"] is True
    assert events[0]["metadata"]["skillNudgeIntervalAfterSuppression"] == 0

    assert result["result"] == "task completed"


# ---------------------------------------------------------------------------
# 6. G2A NOTE 1 — regression-test the skip_memory=True dependency.
#
# skip_memory=True is set in hermes_runner.py for an unrelated reason
# ("TORQCLAW owns memory (FTS5 layer)"), but it is ALSO load-bearing for the
# P2-0 invariant this whole file protects. The chain:
#   - vendor/hermes-agent agent/background_review.py:470-475 builds its
#     review-thread tool whitelist from a HARD-CODED
#     enabled_toolsets=["memory", "skills"] — independent of TORQCLAW's own
#     allowlist. If that whitelist is ever installed, it grants skill_manage
#     regardless of what "enabled" resolved to in run_hermes_sync.
#   - That review fork is only reachable via agent._spawn_background_review,
#     gated at agent/turn_finalizer.py:393 on
#     (_should_review_memory or _should_review_skills).
#   - _should_review_skills is always False here because
#     _suppress_skill_nudge (P2-0 L1b) zeroes _skill_nudge_interval.
#   - _should_review_memory requires agent._memory_store to be truthy
#     (agent/turn_context.py:209-213) — and agent._memory_store is never
#     populated because hermes_runner.py passes skip_memory=True.
# So today, skip_memory=True keeps _should_review_memory permanently False,
# which keeps the background-review fork (and its independent "skills"
# grant) unreachable. If someone later flips skip_memory to False — e.g.
# "just enable memory, what's the harm" — without realizing this coupling,
# a memory nudge could spawn a review fork that inherits "skills" and holds
# a whitelist permitting skill_manage, reopening the exact bypass path P2-0
# closed. This test pins skip_memory=True in the AIAgent(...) kwargs so that
# flipping it trips CI instead of silently reopening the invariant.
# ---------------------------------------------------------------------------
def test_skip_memory_is_p2_0_invariant_dependency(monkeypatch):
    """skip_memory=True must be passed to AIAgent(...). This is not merely a
    "TORQCLAW owns memory" preference — see the module-level comment above
    and the matching note at hermes_runner.py's skip_memory=True call site.
    Flipping this to False would let _should_review_memory go true
    (turn_context.py:209-213), which can spawn upstream's background-review
    fork (turn_finalizer.py:393) carrying its own hard-coded
    enabled_toolsets=["memory", "skills"] whitelist
    (background_review.py:470-475) — independent of, and bypassing,
    TORQCLAW's allowlist and the skill-nudge suppression this file tests."""
    monkeypatch.delenv("HERMES_FRONTIER_TOOLSETS", raising=False)
    captured = {}

    class _CapturingAgent(_FakeAgent):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            captured["agent"] = self

    monkeypatch.setattr(hermes_runner, "AIAgent", _CapturingAgent)
    task_id = "skip-memory-invariant-" + os.urandom(4).hex()
    _run(task_id, _payload())

    agent = captured["agent"]
    assert agent.kwargs.get("skip_memory") is True
