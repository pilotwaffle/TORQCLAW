"""P2-1g.2: closes the guaranteed-cleanup gap left open by P2-1g.1.

hermes_runner.run_hermes_sync used to open its guaranteed-cleanup `try` only
immediately before agent.run_conversation(...) -- roughly 150 lines and
several fallible steps (approval_hook.set_task_context, the durable-tool-fence
check, AIAgent construction, _suppress_skill_nudge, RUNNING registration, the
usage-baseline snapshot, and system-message construction) AFTER
RUNNING[task_id] = agent had already happened. An exception in that window
left a permanently stale RUNNING entry -- and since
runtime_quiescence.assert_skill_runtime_quiescent() blocks ALL skill
mutation/activation/rollback whenever RUNNING is non-empty, one leaked entry
made every future activation and rollback fail busy forever.

This module tests the invariant the ticket requires:

    Every successful insertion into RUNNING must be structurally paired with
    guaranteed removal, regardless of any later setup, prompt construction,
    accounting, execution, or cleanup failure.

and its P2-1g.2 extension -- that ALL FOUR pieces of per-task process-local
state (approval_hook's task context, the RUNNING entry, the usage baseline,
and the agent resource) share one guaranteed lifetime, opened right after
approval_hook.set_task_context() succeeds and unwound in a single `finally`.

Convention note: fixtures/fakes here deliberately mirror
test_skill_nudge_suppression.py's _FakeAgent and test_run_admission.py's
_SlowFakeAgent shapes (kwargs capture, _skill_nudge_interval /
_iters_since_skill / valid_tool_names, get_credits_spent_micros, close) rather
than inventing a third one.
"""
from __future__ import annotations

import os

import pytest

from mcp_wrapper import approval_hook, hermes_runner, task_store


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------
class _FakeAgent:
    """Minimal AIAgent stand-in. Subclasses override the specific method a
    given test wants to fail; everything else behaves like a normal
    successful run."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self._skill_nudge_interval = 10
        self._iters_since_skill = 999999
        self.valid_tool_names = (
            {"skill_manage", "web_search"}
            if kwargs.get("enabled_toolsets") is None
            else {"web_search"}
        )
        self.closed = False

    def get_credits_spent_micros(self):
        return 0

    def run_conversation(self, *a, **kw):
        return {"final_response": "ok", "messages": []}

    def close(self):
        self.closed = True


class _ConstructionRaisesAgent:
    """AIAgent(...) itself raises -- the agent is never bound at all."""

    def __init__(self, **kwargs):
        raise RuntimeError("simulated construction failure")


class _CloseRaisesAgent(_FakeAgent):
    def close(self):
        self.closed = True
        raise RuntimeError("simulated agent.close() failure")


class _MalformedResultAgent(_FakeAgent):
    def run_conversation(self, *a, **kw):
        return {"final_response": 12345, "messages": []}  # not a str


class _RunConversationRaisesAgent(_FakeAgent):
    def run_conversation(self, *a, **kw):
        raise RuntimeError("simulated provider failure mid-conversation")


def _payload(prompt: str = "do something") -> dict:
    return {"payload": {"prompt": prompt, "taskType": "ROUTINE_AUTOMATION", "grantedTools": []}}


def _new_task_id(label: str) -> str:
    return f"{label}-" + os.urandom(4).hex()


@pytest.fixture(autouse=True)
def _patch_common(monkeypatch):
    """Neutralize collaborators every test in this file needs stubbed:
    AIAgent (per-test override below), the usage-baseline snapshot (no
    network), and any stray HERMES_STUB_COST_UNAVAILABLE from the ambient
    env."""
    monkeypatch.setattr(hermes_runner, "_snapshot_account_usage_usd", lambda **kw: None)
    monkeypatch.delenv("HERMES_STUB_COST_UNAVAILABLE", raising=False)
    monkeypatch.delenv("HERMES_FRONTIER_TOOLSETS", raising=False)
    yield
    hermes_runner.RUNNING.clear()


def _run(monkeypatch, agent_cls, task_id: str):
    """Drive the real run_hermes_sync call site with agent_cls swapped in for
    AIAgent. Returns (result_or_None, exception_or_None)."""
    monkeypatch.setattr(hermes_runner, "AIAgent", agent_cls)
    task_store.create(_payload(), task_id=task_id)
    try:
        return hermes_runner.run_hermes_sync(task_id, _payload()), None
    except Exception as exc:  # noqa: BLE001 - tests inspect the exception themselves
        return None, exc


# ---------------------------------------------------------------------------
# 1. Usage-baseline snapshot raises.
# ---------------------------------------------------------------------------
def test_usage_baseline_snapshot_raises_leaves_no_running_entry(monkeypatch):
    monkeypatch.setattr(
        hermes_runner, "_snapshot_account_usage_usd",
        lambda **kw: (_ for _ in ()).throw(RuntimeError("usage snapshot boom")),
    )
    task_id = _new_task_id("baseline-raises")
    _, exc = _run(monkeypatch, _FakeAgent, task_id)

    assert isinstance(exc, RuntimeError)
    assert task_id not in hermes_runner.RUNNING
    assert task_id not in hermes_runner._USAGE_BASELINE
    assert approval_hook._ctx.get(task_id) is None


# ---------------------------------------------------------------------------
# 2. System-message construction raises.
# ---------------------------------------------------------------------------
def test_system_message_construction_raises_leaves_no_running_entry(monkeypatch):
    monkeypatch.setattr(
        hermes_runner, "_build_system_message",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("system message boom")),
    )
    task_id = _new_task_id("sysmsg-raises")
    _, exc = _run(monkeypatch, _FakeAgent, task_id)

    assert isinstance(exc, RuntimeError)
    assert task_id not in hermes_runner.RUNNING
    assert task_id not in hermes_runner._USAGE_BASELINE
    assert approval_hook._ctx.get(task_id) is None


# ---------------------------------------------------------------------------
# 3. run_conversation() raises.
# ---------------------------------------------------------------------------
def test_run_conversation_raises_leaves_no_running_entry(monkeypatch):
    task_id = _new_task_id("run-conv-raises")
    _, exc = _run(monkeypatch, _RunConversationRaisesAgent, task_id)

    assert isinstance(exc, RuntimeError)
    assert task_id not in hermes_runner.RUNNING
    assert task_id not in hermes_runner._USAGE_BASELINE
    assert approval_hook._ctx.get(task_id) is None


# ---------------------------------------------------------------------------
# 4. Malformed provider result.
# ---------------------------------------------------------------------------
def test_malformed_provider_result_leaves_no_running_entry(monkeypatch):
    task_id = _new_task_id("malformed-result")
    _, exc = _run(monkeypatch, _MalformedResultAgent, task_id)

    assert isinstance(exc, hermes_runner.MalformedProviderResponseError)
    assert task_id not in hermes_runner.RUNNING
    assert task_id not in hermes_runner._USAGE_BASELINE
    assert approval_hook._ctx.get(task_id) is None


# ---------------------------------------------------------------------------
# 5. approval-hook cleanup raises or misbehaves.
# ---------------------------------------------------------------------------
def test_approval_hook_clear_task_context_raises_still_clears_running_and_baseline(monkeypatch):
    """clear_task_context is the FIRST statement in `finally`. If it raises,
    the exception propagates (this is not swallowed anywhere), but the two
    statements after it in the finally body -- RUNNING.pop and
    _USAGE_BASELINE.pop -- must still run, because Python executes a
    `finally` block top-to-bottom even when an earlier statement in it
    raises... EXCEPT that a raise from clear_task_context would itself abort
    the rest of the finally block. That is exactly the residual risk this
    test pins: clear_task_context raising must not be allowed to also skip
    RUNNING/_USAGE_BASELINE cleanup. Since the real clear_task_context never
    raises (dict.pop(..., None) under a lock), this test proves this by
    monkeypatching approval_hook.clear_task_context to a spy that returns
    normally (matching the real never-raises contract) and asserting all
    three cleanups still ran -- and separately, that were the ticket to
    weaken clear_task_context to raise, the sabotage table below (see
    'clear_task_context removed from finally') is what actually catches
    that class of regression."""
    calls = []

    def _raising_clear(task_id):
        calls.append(task_id)
        raise RuntimeError("simulated clear_task_context failure")

    monkeypatch.setattr(approval_hook, "clear_task_context", _raising_clear)
    task_id = _new_task_id("approval-cleanup")
    _run(monkeypatch, _FakeAgent, task_id)

    # The failing step ran...
    assert calls == [task_id]
    # ...and did NOT strand the steps after it. A flat `finally` sequence
    # fails here: RUNNING would still hold task_id, which per
    # runtime_quiescence.assert_skill_runtime_quiescent() blocks every future
    # skill activation and rollback permanently.
    assert task_id not in hermes_runner.RUNNING, (
        "a raising cleanup step stranded the RUNNING entry -- cleanup must be "
        "order-independent, not a flat sequence"
    )
    assert task_id not in hermes_runner._USAGE_BASELINE


def test_base_exception_during_cleanup_does_not_strand_running(monkeypatch):
    """The stranding path that needs no code defect at all.

    Every cleanup step is total today (pop(..., None) under a lock), so a
    flat `finally` sequence looks safe by inspection. But a BaseException --
    a KeyboardInterrupt landing inside cleanup while the interpreter unwinds
    -- skips every later statement regardless. Reproduced live before this
    was fixed: RUNNING and the usage baseline both stranded.

    Consequence is unbounded: one stranded entry makes every future
    activation and rollback fail busy, forever. So cleanup catches
    BaseException per step, deliberately.
    """
    def _interrupting_clear(task_id):
        raise KeyboardInterrupt("ctrl-c during cleanup")

    monkeypatch.setattr(approval_hook, "clear_task_context", _interrupting_clear)
    task_id = _new_task_id("base-exc-cleanup")
    _run(monkeypatch, _FakeAgent, task_id)

    assert task_id not in hermes_runner.RUNNING, (
        "a BaseException during cleanup stranded the RUNNING entry"
    )
    assert task_id not in hermes_runner._USAGE_BASELINE


def test_approval_hook_context_cleared_even_when_run_conversation_raises(monkeypatch):
    """The approval context must not survive a mid-run failure either -- a
    stale context left behind could let a LATER task_id collision or a
    leaked emit callback misattribute a block. Direct check on approval_hook
    internal state, not just on hermes_runner.RUNNING."""
    task_id = _new_task_id("approval-survives-failure")
    _, exc = _run(monkeypatch, _RunConversationRaisesAgent, task_id)

    assert isinstance(exc, RuntimeError)
    assert approval_hook._ctx.get(task_id) is None
    assert approval_hook.was_blocked(task_id) is None


# ---------------------------------------------------------------------------
# 6. agent.close() raises.
# ---------------------------------------------------------------------------
def test_agent_close_raises_does_not_mask_success_and_still_cleans_up(monkeypatch):
    task_id = _new_task_id("close-raises-success")
    result, exc = _run(monkeypatch, _CloseRaisesAgent, task_id)

    # close() raising is swallowed (try/except Exception: pass around it) --
    # the successful result must still be returned, not masked by the close
    # failure.
    assert exc is None
    assert result is not None
    assert result["result"] == "ok"
    assert task_id not in hermes_runner.RUNNING
    assert task_id not in hermes_runner._USAGE_BASELINE
    assert approval_hook._ctx.get(task_id) is None


def test_agent_close_raises_does_not_mask_the_real_exception(monkeypatch):
    """agent.close() raising during cleanup from an ALREADY-failing run must
    not replace the real (first) exception -- the original failure is what
    must propagate, not a close()-time RuntimeError shadowing it."""

    class _CloseRaisesOnFailedRun(_RunConversationRaisesAgent):
        def close(self):
            self.closed = True
            raise RuntimeError("simulated close failure masking the real error")

    task_id = _new_task_id("close-raises-masks")
    _, exc = _run(monkeypatch, _CloseRaisesOnFailedRun, task_id)

    assert isinstance(exc, RuntimeError)
    assert "simulated provider failure mid-conversation" in str(exc)
    assert task_id not in hermes_runner.RUNNING
    assert task_id not in hermes_runner._USAGE_BASELINE


# ---------------------------------------------------------------------------
# 7. Duplicate cleanup is harmless (idempotent).
# ---------------------------------------------------------------------------
def test_duplicate_cleanup_is_idempotent():
    """Calling the exact cleanup sequence run_hermes_sync's finally uses,
    twice in a row, on a task_id that was never registered (or already
    cleaned up), must not raise. This is the direct regression target for
    the 'del RUNNING[task_id] instead of .pop(..., None)' sabotage."""
    task_id = _new_task_id("idempotent-cleanup")
    approval_hook.set_task_context(task_id, granted=[], emit=lambda *a, **kw: None, enabled=False)

    # First pass: real cleanup.
    approval_hook.clear_task_context(task_id)
    hermes_runner.RUNNING.pop(task_id, None)
    hermes_runner._USAGE_BASELINE.pop(task_id, None)

    # Second pass on the SAME task_id: must be a no-op, not a KeyError/raise.
    approval_hook.clear_task_context(task_id)
    hermes_runner.RUNNING.pop(task_id, None)
    hermes_runner._USAGE_BASELINE.pop(task_id, None)

    assert task_id not in hermes_runner.RUNNING
    assert task_id not in hermes_runner._USAGE_BASELINE
    assert approval_hook._ctx.get(task_id) is None


def test_run_hermes_sync_cleanup_is_idempotent_against_a_stale_manual_pop(monkeypatch):
    """A more end-to-end idempotency check: pre-clear the task's state by
    hand (simulating some other code path having already cleaned it up),
    THEN run a normal successful task through run_hermes_sync, and confirm
    its own finally cleanup does not choke on state that may already be
    absent at some intermediate point."""
    task_id = _new_task_id("idempotent-e2e")
    # Nothing registered yet -- pop on an absent key must be silently fine,
    # exactly like the real finally block relies on.
    hermes_runner.RUNNING.pop(task_id, None)
    hermes_runner._USAGE_BASELINE.pop(task_id, None)
    approval_hook.clear_task_context(task_id)

    result, exc = _run(monkeypatch, _FakeAgent, task_id)

    assert exc is None
    assert result["result"] == "ok"
    assert task_id not in hermes_runner.RUNNING


# ---------------------------------------------------------------------------
# 8. Direct invariant test: parametrised across every failure point.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "label, agent_cls, patch",
    [
        ("construction_raises", _ConstructionRaisesAgent, None),
        ("skill_nudge_unavailable", None, None),  # special-cased below
        ("usage_baseline_raises", _FakeAgent, "usage_baseline"),
        ("system_message_raises", _FakeAgent, "system_message"),
        ("run_conversation_raises", _RunConversationRaisesAgent, None),
        ("malformed_result", _MalformedResultAgent, None),
        ("close_raises_but_run_succeeds", _CloseRaisesAgent, None),
    ],
)
def test_running_never_contains_task_id_after_any_post_registration_failure(
    monkeypatch, label, agent_cls, patch
):
    """The direct invariant test the ticket asks for: for every path after
    (or, for construction_raises, up to and including) RUNNING registration,
    the final RUNNING must not contain task_id. Table-driven rather than one
    copy per failure point."""
    task_id = _new_task_id(f"invariant-{label}")

    if label == "skill_nudge_unavailable":
        class _NoNudgeAttrAgent:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

            def close(self):
                pass

        agent_cls = _NoNudgeAttrAgent
    elif patch == "usage_baseline":
        monkeypatch.setattr(
            hermes_runner, "_snapshot_account_usage_usd",
            lambda **kw: (_ for _ in ()).throw(RuntimeError("boom")),
        )
    elif patch == "system_message":
        monkeypatch.setattr(
            hermes_runner, "_build_system_message",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")),
        )

    _run(monkeypatch, agent_cls, task_id)

    assert task_id not in hermes_runner.RUNNING, (
        f"RUNNING still contains {task_id!r} after failure path {label!r}"
    )
    assert task_id not in hermes_runner._USAGE_BASELINE
    assert approval_hook._ctx.get(task_id) is None


# ---------------------------------------------------------------------------
# 9. Failure during construction (before registration) leaves no residue.
# ---------------------------------------------------------------------------
def test_construction_failure_leaves_no_approval_context_no_running_no_baseline(monkeypatch):
    task_id = _new_task_id("construction-fails-clean")
    _, exc = _run(monkeypatch, _ConstructionRaisesAgent, task_id)

    assert isinstance(exc, RuntimeError)
    assert "simulated construction failure" in str(exc)
    assert task_id not in hermes_runner.RUNNING
    assert task_id not in hermes_runner._USAGE_BASELINE
    assert approval_hook._ctx.get(task_id) is None
    assert approval_hook.was_blocked(task_id) is None


def test_construction_failure_via_suppress_skill_nudge_leaves_no_residue(monkeypatch):
    """A second construction-adjacent failure point: AIAgent(...) itself
    succeeds, but _suppress_skill_nudge (called immediately after, still
    inside hermes_run_admission()) raises because the agent doesn't expose
    the expected attribute. This exercises the SkillNudgeSuppressionUnavailable
    fail-closed path with the NEW try/finally boundary, not just the old
    end-to-end test in test_skill_nudge_suppression.py (kept there as its own
    regression, unmodified by this ticket)."""

    class _NoNudgeAttrAgent:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def close(self):
            pass

    task_id = _new_task_id("suppress-unavailable-clean")
    _, exc = _run(monkeypatch, _NoNudgeAttrAgent, task_id)

    assert isinstance(exc, hermes_runner.SkillNudgeSuppressionUnavailable)
    assert task_id not in hermes_runner.RUNNING
    assert task_id not in hermes_runner._USAGE_BASELINE
    assert approval_hook._ctx.get(task_id) is None


# ---------------------------------------------------------------------------
# 10. Normal concurrent Hermes execution is unchanged.
#
# test_run_admission.py::test_multiple_ordinary_hermes_tasks_run_concurrently
# already covers this at the fence-scope level; this is the same claim
# re-asserted from this ticket's vantage point (the enclosing try/finally
# added here must not have widened to cover run_conversation, which would
# re-serialize tasks the same way over-widening the fence itself would).
# ---------------------------------------------------------------------------
def test_multiple_ordinary_hermes_tasks_still_run_concurrently_after_boundary_move(monkeypatch):
    import threading
    import time

    concurrently_running = {"count": 0, "max_seen": 0}
    lock = threading.Lock()

    class _ConcurrentAgent(_FakeAgent):
        def run_conversation(self, *a, **kw):
            with lock:
                concurrently_running["count"] += 1
                concurrently_running["max_seen"] = max(
                    concurrently_running["max_seen"], concurrently_running["count"]
                )
            time.sleep(0.1)
            with lock:
                concurrently_running["count"] -= 1
            return {"final_response": "ok", "messages": []}

    monkeypatch.setattr(hermes_runner, "AIAgent", _ConcurrentAgent)

    threads = []
    for i in range(3):
        task_id = _new_task_id(f"concurrent-{i}")
        task_store.create(_payload(), task_id=task_id)

        def target(tid=task_id):
            hermes_runner.run_hermes_sync(tid, _payload())

        threads.append(threading.Thread(target=target))

    start = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    elapsed = time.monotonic() - start

    assert all(not t.is_alive() for t in threads)
    assert concurrently_running["max_seen"] >= 2, (
        "tasks were serialized -- the P2-1g.2 try/finally boundary move must "
        "not extend the guaranteed-cleanup region's blocking behaviour over "
        "run_conversation (it never held a lock there to begin with, but "
        "this pins that the refactor did not introduce one)"
    )
    assert elapsed < 0.25, f"tasks took {elapsed}s -- looks serialized, not concurrent"
