"""P2-1g.1: closes the run-admission TOCTOU race left open by P2-1g, and adds
the coordinator primitive a future skill-activation pipeline needs to commit
governance state without ever letting "cache invalidated" and "governance
claims active" become observable out of order.

Covers:
  - mcp_wrapper.runtime_quiescence.hermes_run_admission() -- the fence a new
    Hermes run must hold across AIAgent construction + RUNNING registration.
  - mcp_wrapper.hermes_runner.run_hermes_sync -- the real call site that
    wires the fence in.
  - mcp_wrapper.runtime_quiescence.ActivationCoordinator /
    run_activation_transaction -- the publish/invalidate/commit/verify
    sequencing primitive for Gap 2.

This ticket adds no skills.external_dirs publisher, no IPC/signalling, and
does not modify VerifiedSkillStore.activate()/rollback()/disable()/approve().
"""
from __future__ import annotations

import os
import threading
import time

import pytest

from mcp_wrapper import hermes_runner, task_store
from mcp_wrapper.runtime_quiescence import (
    ActivationCoordinator,
    SkillActivationCoordinationError,
    SkillRuntimeBusyError,
    assert_skill_runtime_quiescent,
    hermes_run_admission,
    run_activation_transaction,
    skill_mutation_transaction,
)


@pytest.fixture(autouse=True)
def _clean_running_registry():
    """RUNNING is process-global state; never let one test's fake agent leak
    into another test's admission/quiescence check."""
    hermes_runner.RUNNING.clear()
    yield
    hermes_runner.RUNNING.clear()


# ---------------------------------------------------------------------------
# Fakes -- same minimal shape as test_skill_nudge_suppression.py's
# _FakeAgent, extended with a controllable delay inside __init__ so tests can
# widen the admission window enough to make a race observable if the fence
# were absent or narrower than claimed.
# ---------------------------------------------------------------------------
class _SlowFakeAgent:
    """Mirrors only what run_hermes_sync touches before run_conversation.
    Subclasses override __init__/run_conversation to inject timing hooks
    (event sets/waits) so a concurrent thread has a real, deterministic
    window to attempt to interleave."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self._skill_nudge_interval = 10
        self._iters_since_skill = 999999
        self.valid_tool_names = (
            {"skill_manage", "web_search"}
            if kwargs.get("enabled_toolsets") is None
            else {"web_search"}
        )

    def get_credits_spent_micros(self):
        return 0

    def close(self):
        pass


def _payload(prompt: str = "do something") -> dict:
    return {"payload": {"prompt": prompt, "taskType": "ROUTINE_AUTOMATION", "grantedTools": []}}


def _drive_run_hermes_sync(monkeypatch, task_id: str, agent_cls) -> threading.Thread:
    """Start run_hermes_sync on a background thread using agent_cls (a
    _SlowFakeAgent subclass) as the fake AIAgent. Returns the thread (not
    yet joined)."""
    monkeypatch.setattr(hermes_runner, "AIAgent", agent_cls)
    monkeypatch.setattr(hermes_runner, "_snapshot_account_usage_usd", lambda **kw: None)
    task_store.create(_payload(), task_id=task_id)

    def target():
        try:
            hermes_runner.run_hermes_sync(task_id, _payload())
        except AttributeError:
            pass  # _SlowFakeAgent (non-completing) has no run_conversation

    thread = threading.Thread(target=target)
    return thread


# ---------------------------------------------------------------------------
# Test 1: a Hermes run starting between the quiescence check and the
# mutation must be IMPOSSIBLE. Driven through the REAL
# hermes_runner.run_hermes_sync call site (not the fence helper in
# isolation), racing it against a real skill_mutation_transaction() on
# another thread. A fake AIAgent whose __init__ sleeps widens the
# construction window enough that, WITHOUT the fence, the mutation thread
# would very likely observe RUNNING == {} while construction is still in
# flight and complete its own body before the run registers -- exactly the
# TOCTOU interleaving this ticket closes. This is the test the "remove the
# admission fence" sabotage must fail: with the fence removed,
# hermes_runner.RUNNING[task_id] = agent runs unguarded, so it can land
# either before or after (or, in principle, "during") the mutation's body
# with no ordering guarantee -- this test pins the ONE ordering that must
# always hold when the fence is present.
# ---------------------------------------------------------------------------
def test_real_run_hermes_sync_cannot_interleave_with_an_in_flight_mutation(monkeypatch):
    import mcp_wrapper.runtime_quiescence as rq

    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", lambda: None)

    mutation_holds_lock = threading.Event()
    mutation_may_release = threading.Event()
    construction_entered = threading.Event()

    class _RaceAgent(_SlowFakeAgent):
        def __init__(self, **kwargs):
            # If hermes_run_admission() correctly wraps this constructor
            # call, __init__ cannot even START running while the mutation
            # thread below holds _MUTATION_LOCK -- the `with
            # hermes_run_admission():` line in run_hermes_sync blocks
            # BEFORE calling AIAgent(...) at all. So while
            # mutation_holds_lock is set and mutation_may_release is not,
            # this line must never execute if the fence is intact.
            construction_entered.set()
            super().__init__(**kwargs)

        def run_conversation(self, *a, **kw):
            return {"final_response": "ok", "messages": []}

    task_id = "e2e-race-" + os.urandom(4).hex()
    run_thread = _drive_run_hermes_sync(monkeypatch, task_id, _RaceAgent)
    result: dict[str, bool] = {}

    def mutation_body():
        with skill_mutation_transaction():
            mutation_holds_lock.set()
            # Hold the lock for a fixed window. If the fence is intact, the
            # run thread is blocked acquiring _MUTATION_LOCK for this whole
            # window and construction_entered must stay unset throughout.
            result["interleaved"] = construction_entered.wait(timeout=0.2)
            mutation_may_release.set()

    mutation_thread = threading.Thread(target=mutation_body)
    mutation_thread.start()
    mutation_holds_lock.wait(timeout=5)
    run_thread.start()

    run_thread.join(timeout=5)
    mutation_thread.join(timeout=5)

    assert not run_thread.is_alive() and not mutation_thread.is_alive()
    assert task_id not in hermes_runner.RUNNING  # cleaned up in `finally`
    # Sanity: the run thread actually got to construct the agent at all
    # (proves this isn't a vacuously-passing test where nothing ran).
    assert construction_entered.is_set()
    assert result.get("interleaved") is False, (
        "AIAgent construction started WHILE the skill mutation held "
        "_MUTATION_LOCK -- the run-admission fence did not serialize "
        "construction against an in-flight mutation"
    )


# ---------------------------------------------------------------------------
# Test 1b: the same claim via the fence helper directly (no fake-agent
# construction delay needed) -- a faster, more targeted regression check
# once the end-to-end version above has established the real call site is
# wired correctly.
# ---------------------------------------------------------------------------
def test_run_admission_cannot_interleave_with_an_in_flight_mutation(monkeypatch):
    import mcp_wrapper.runtime_quiescence as rq

    # This test is about lock ordering between hermes_run_admission() and
    # skill_mutation_transaction(), not about cache invalidation itself, so
    # invalidation is stubbed to a no-op -- keeps the test's pass/fail
    # independent of whether the vendored agent.prompt_builder module is
    # importable in this environment.
    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", lambda: None)

    order: list[str] = []
    mutation_holds_lock = threading.Event()
    run_attempted = threading.Event()

    def mutation_body():
        with skill_mutation_transaction():
            order.append("mutation-quiescence-checked")
            mutation_holds_lock.set()
            # Give the run thread every opportunity to interleave if the
            # fence were absent or broken.
            run_attempted.wait(timeout=2)
            time.sleep(0.05)
            order.append("mutation-body-done")

    def run_admission_attempt():
        mutation_holds_lock.wait(timeout=2)
        run_attempted.set()
        with hermes_run_admission():
            order.append("run-admitted")
            hermes_runner.RUNNING["race-task"] = object()

    t_mutation = threading.Thread(target=mutation_body)
    t_run = threading.Thread(target=run_admission_attempt)

    t_mutation.start()
    t_run.start()
    t_mutation.join(timeout=5)
    t_run.join(timeout=5)

    assert not t_mutation.is_alive() and not t_run.is_alive()
    # The run's admission must be fully ordered AFTER the mutation's body
    # completes -- it cannot be observed to slip in between
    # "mutation-quiescence-checked" and "mutation-body-done".
    assert order == [
        "mutation-quiescence-checked",
        "mutation-body-done",
        "run-admitted",
    ], (
        "a Hermes run was admitted while a skill mutation held the lock -- "
        "the run-admission fence did not prevent the TOCTOU interleaving "
        f"(actual order: {order})"
    )


# ---------------------------------------------------------------------------
# Test 2: mutation active -> Hermes constructor (admission) waits, then
# proceeds only after the mutation releases the lock.
# ---------------------------------------------------------------------------
def test_admission_blocks_while_mutation_holds_lock_then_proceeds(monkeypatch):
    import mcp_wrapper.runtime_quiescence as rq

    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", lambda: None)

    events: list[str] = []
    mutation_started = threading.Event()

    def mutation_body():
        with skill_mutation_transaction():
            events.append("mutation-enter")
            mutation_started.set()
            time.sleep(0.1)
            events.append("mutation-exit")

    def admission_attempt():
        mutation_started.wait(timeout=2)
        with hermes_run_admission():
            events.append("admission-enter")

    t1 = threading.Thread(target=mutation_body)
    t2 = threading.Thread(target=admission_attempt)
    t1.start()
    t2.start()
    t1.join(timeout=5)
    t2.join(timeout=5)

    assert not t1.is_alive() and not t2.is_alive()
    assert events == ["mutation-enter", "mutation-exit", "admission-enter"], (
        "admission entered before the mutation released the lock"
    )


# ---------------------------------------------------------------------------
# Test 3: Hermes registers (admits) first -> a subsequent mutation attempt
# fails busy.
# ---------------------------------------------------------------------------
def test_mutation_fails_busy_when_run_registers_first():
    with hermes_run_admission():
        hermes_runner.RUNNING["already-running"] = object()

    # The run has released the admission lock (registration is instantaneous
    # in this direct-fence-helper test), but RUNNING still reflects it --
    # exactly hermes_runner.run_hermes_sync's real shape, where
    # run_conversation() (not under the fence) is what keeps RUNNING
    # populated for the run's actual lifetime.
    with pytest.raises(SkillRuntimeBusyError):
        assert_skill_runtime_quiescent()
    with pytest.raises(SkillRuntimeBusyError):
        with skill_mutation_transaction():
            pass  # pragma: no cover - must never execute


def test_mutation_fails_busy_when_real_run_hermes_sync_registers_first(monkeypatch):
    """Same claim, driven through the real run_hermes_sync call site rather
    than the fence helper directly -- proves the wiring in hermes_runner.py
    actually populates RUNNING before releasing admission, using a
    completing fake agent so RUNNING stays populated across run_conversation
    (real shape: RUNNING is cleared only in the `finally` after
    run_conversation returns)."""
    started = threading.Event()
    release_run_conversation = threading.Event()

    class _BlockingCompletingAgent(_SlowFakeAgent):
        def run_conversation(self, *a, **kw):
            started.set()
            release_run_conversation.wait(timeout=5)
            return {"final_response": "ok", "messages": []}

    task_id = "busy-real-" + os.urandom(4).hex()
    thread = _drive_run_hermes_sync(monkeypatch, task_id, _BlockingCompletingAgent)
    thread.start()
    assert started.wait(timeout=5), "run_hermes_sync never reached run_conversation"

    # The run is now live in RUNNING (registered inside the fence, before
    # run_conversation was ever called) and the fence has already released
    # (run_conversation itself is unfenced) -- a mutation attempted now must
    # observe it and fail busy.
    with pytest.raises(SkillRuntimeBusyError):
        assert_skill_runtime_quiescent()

    release_run_conversation.set()
    thread.join(timeout=5)
    assert task_id not in hermes_runner.RUNNING


# ---------------------------------------------------------------------------
# Test 4: cache invalidation fails after publication -> the external
# projection is restored and governed active state is unchanged.
# ---------------------------------------------------------------------------
def test_invalidation_failure_after_publish_restores_projection_and_leaves_active_state_unchanged(monkeypatch):
    import mcp_wrapper.runtime_quiescence as rq

    monkeypatch.setattr(
        rq, "invalidate_skill_prompt_cache",
        lambda: (_ for _ in ()).throw(RuntimeError("simulated cache-clear failure")),
    )

    projection = {"active_version": "v1"}
    calls: list[str] = []

    def publish():
        calls.append("publish")
        previous = dict(projection)
        projection["active_version"] = "v2"
        return previous

    def restore(previous):
        calls.append("restore")
        projection.clear()
        projection.update(previous)

    def commit():
        calls.append("commit")  # pragma: no cover - must never run
        return {"active": "v2"}

    def verify(_result):
        calls.append("verify")  # pragma: no cover - must never run

    with pytest.raises(SkillActivationCoordinationError):
        run_activation_transaction(publish=publish, restore=restore, commit=commit, verify=verify)

    assert calls == ["publish", "restore"], (
        "commit/verify must not run after invalidation fails, and restore "
        "must run exactly once"
    )
    assert projection == {"active_version": "v1"}, (
        "external projection must be restored to its pre-publish state"
    )


# ---------------------------------------------------------------------------
# Test 5: governance commit fails after cache clear -> projection is
# restored BEFORE run admission resumes (i.e. before the lock releases).
# ---------------------------------------------------------------------------
def test_commit_failure_after_cache_clear_restores_before_admission_resumes(monkeypatch):
    import mcp_wrapper.runtime_quiescence as rq

    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", lambda: None)

    projection = {"active_version": "v1"}
    order: list[str] = []
    admission_result: dict[str, str] = {}

    def publish():
        order.append("publish")
        previous = dict(projection)
        projection["active_version"] = "v2"
        return previous

    def restore(previous):
        # At the instant restore() runs, the coordinator's lock is still
        # held -- prove it by attempting a non-blocking admission from
        # ANOTHER thread and confirming it cannot proceed until restore()
        # (and the whole transaction) has returned.
        order.append("restore-start")
        time.sleep(0.05)
        projection.clear()
        projection.update(previous)
        order.append("restore-end")

    def commit():
        order.append("commit")
        raise RuntimeError("simulated governance commit failure")

    def verify(_result):
        order.append("verify")  # pragma: no cover - must never run

    def admission_probe():
        # Runs concurrently; must observe the lock as held until the
        # transaction (including restore) has fully completed.
        with hermes_run_admission():
            admission_result["order_at_admission"] = list(order)

    coordinator_thread = threading.Thread(
        target=lambda: pytest.raises(
            SkillActivationCoordinationError,
            run_activation_transaction,
            publish=publish, restore=restore, commit=commit, verify=verify,
        )
    )
    probe_thread = threading.Thread(target=admission_probe)

    coordinator_thread.start()
    time.sleep(0.01)  # let the coordinator acquire the lock first
    probe_thread.start()
    coordinator_thread.join(timeout=5)
    probe_thread.join(timeout=5)

    assert not coordinator_thread.is_alive() and not probe_thread.is_alive()
    assert order == ["publish", "commit", "restore-start", "restore-end"]
    # The admission probe must only have run AFTER restore fully completed.
    assert admission_result["order_at_admission"] == [
        "publish", "commit", "restore-start", "restore-end",
    ]
    assert projection == {"active_version": "v1"}


# ---------------------------------------------------------------------------
# Test 6: approval remains usable / is not falsely consumed when activation
# never becomes effective (commit failed -> restore ran -> no approval
# consumption claimed).
# ---------------------------------------------------------------------------
def test_approval_not_consumed_when_activation_never_becomes_effective(monkeypatch):
    import mcp_wrapper.runtime_quiescence as rq

    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", lambda: None)

    approval = {"token": "tok-1", "consumed": False}
    projection = {"active_version": "v1"}

    def publish():
        previous = dict(projection)
        projection["active_version"] = "v2"
        return previous

    def restore(previous):
        projection.clear()
        projection.update(previous)

    def commit():
        # Simulates the exact governed-state shape VerifiedSkillStore.activate
        # would produce, but the coordinator's caller is responsible for not
        # marking the approval consumed until verify() succeeds.
        raise RuntimeError("simulated commit failure before approval consumption")

    def verify(_result):
        approval["consumed"] = True  # pragma: no cover - must never run

    with pytest.raises(SkillActivationCoordinationError):
        run_activation_transaction(publish=publish, restore=restore, commit=commit, verify=verify)

    assert approval == {"token": "tok-1", "consumed": False}, (
        "approval must remain usable (not consumed) when the activation "
        "never became effective"
    )
    assert projection == {"active_version": "v1"}


def test_approval_not_consumed_when_verify_fails_after_commit(monkeypatch):
    """The same claim, but the failure is in verify() (post-commit), not
    commit() itself -- verify() is the point where the coordinator decides
    whether an already-computed commit result may be trusted. Failing here
    must still restore and must not leave the approval looking consumed."""
    import mcp_wrapper.runtime_quiescence as rq

    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", lambda: None)

    approval = {"token": "tok-2", "consumed": False}
    projection = {"active_version": "v1"}
    restored = {"flag": False}

    def publish():
        previous = dict(projection)
        projection["active_version"] = "v2"
        return previous

    def restore(previous):
        projection.clear()
        projection.update(previous)
        restored["flag"] = True

    def commit():
        return {"skillId": "demo.skill", "digest": "0" * 64}

    def verify(_result):
        raise RuntimeError("simulated post-commit verification failure")

    with pytest.raises(SkillActivationCoordinationError):
        run_activation_transaction(publish=publish, restore=restore, commit=commit, verify=verify)

    assert restored["flag"] is True
    assert approval["consumed"] is False
    assert projection == {"active_version": "v1"}


# ---------------------------------------------------------------------------
# Test 7: two simultaneous skill mutations serialize (already covered in
# test_runtime_quiescence.py for skill_mutation_transaction alone; here we
# additionally prove hermes_run_admission and skill_mutation_transaction
# share the SAME lock instance under concurrent contention from both sides
# at once -- a mutation, a run admission, and a second mutation all
# competing).
# ---------------------------------------------------------------------------
def test_two_simultaneous_mutations_and_a_run_admission_all_serialize(monkeypatch):
    import mcp_wrapper.runtime_quiescence as rq

    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", lambda: None)

    order: list[str] = []
    lock_for_counter = threading.Lock()
    concurrently_inside = {"count": 0, "max_seen": 0}

    def enter(name):
        with lock_for_counter:
            concurrently_inside["count"] += 1
            concurrently_inside["max_seen"] = max(
                concurrently_inside["max_seen"], concurrently_inside["count"]
            )
        order.append(f"{name}-enter")

    def exit_(name):
        order.append(f"{name}-exit")
        with lock_for_counter:
            concurrently_inside["count"] -= 1

    def mutation(name):
        with skill_mutation_transaction():
            enter(name)
            time.sleep(0.05)
            exit_(name)

    def admission(name):
        with hermes_run_admission():
            enter(name)
            time.sleep(0.05)
            exit_(name)

    threads = [
        threading.Thread(target=mutation, args=("mut-A",)),
        threading.Thread(target=admission, args=("run-B",)),
        threading.Thread(target=mutation, args=("mut-C",)),
    ]
    threads[0].start()
    time.sleep(0.01)
    threads[1].start()
    time.sleep(0.01)
    threads[2].start()
    for t in threads:
        t.join(timeout=5)

    assert all(not t.is_alive() for t in threads)
    assert concurrently_inside["max_seen"] == 1, (
        "a mutation and a run admission (or two mutations) executed their "
        f"critical sections concurrently -- order was: {order}"
    )
    # Fully serialized: every enter is immediately followed by its own exit.
    names = ["mut-A", "run-B", "mut-C"]
    it = iter(order)
    for _ in names:
        entered = next(it)
        exited = next(it)
        base = entered.rsplit("-", 1)[0]
        assert exited == f"{base}-exit"


# ---------------------------------------------------------------------------
# Test 8: multiple ordinary Hermes tasks still run concurrently -- the fence
# must not serialize normal operation (i.e. must not be held across
# run_conversation).
# ---------------------------------------------------------------------------
def test_multiple_ordinary_hermes_tasks_run_concurrently(monkeypatch):
    concurrently_running = {"count": 0, "max_seen": 0}
    lock = threading.Lock()

    class _ConcurrentAgent(_SlowFakeAgent):
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

    threads = []
    for i in range(3):
        task_id = f"concurrent-task-{i}-" + os.urandom(4).hex()
        thread = _drive_run_hermes_sync(monkeypatch, task_id, _ConcurrentAgent)
        threads.append(thread)

    start = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    elapsed = time.monotonic() - start

    assert all(not t.is_alive() for t in threads)
    assert concurrently_running["max_seen"] >= 2, (
        "ordinary Hermes tasks were serialized -- the run-admission fence is "
        f"held too broadly (max concurrent observed: {concurrently_running['max_seen']})"
    )
    # Three tasks each sleeping 0.1s inside run_conversation must finish in
    # well under 3 * 0.1s if they actually overlapped.
    assert elapsed < 0.25, f"tasks took {elapsed}s -- looks serialized, not concurrent"


def test_running_registration_is_inside_the_admission_fence():
    """G2A sabotage B: registration must live INSIDE hermes_run_admission().

    Every other test in this file either drives construction and registration
    together or exercises the fence helper directly, so none of them notices
    if `RUNNING[task_id] = agent` is dedented out of the `with` block. That
    escape is not a benign reordering -- it reopens the exact TOCTOU window
    this ticket exists to close:

        run: fence acquired -> agent constructed -> fence RELEASED
        mutation:                                   quiescence passes (RUNNING
                                                    still empty) -> commits
        run: RUNNING[task_id] = agent   <-- live agent, mutation already
                                            declared effective

    Reproduced live before this test existed: the mutation committed with
    RUNNING=0 while a constructed agent was one statement away from
    registering. Asserted against the source because the defect is a
    *structural* property of where the statement sits, not an observable
    behaviour of any single call.
    """
    import inspect
    import re

    source = inspect.getsource(hermes_runner.run_hermes_sync)
    lines = source.split("\n")

    fence_idx = next(
        i for i, line in enumerate(lines) if "with hermes_run_admission():" in line
    )
    reg_idx = next(
        i for i, line in enumerate(lines) if re.match(r"\s*RUNNING\[task_id\] = agent", line)
    )
    assert reg_idx > fence_idx, "RUNNING registration must follow the fence"

    fence_indent = len(lines[fence_idx]) - len(lines[fence_idx].lstrip())
    reg_indent = len(lines[reg_idx]) - len(lines[reg_idx].lstrip())
    assert reg_indent > fence_indent, (
        "RUNNING[task_id] = agent is dedented out of the hermes_run_admission() "
        "block -- a mutation can pass quiescence between construction and "
        "registration and commit while a live agent exists"
    )

    # Nothing may dedent back to the fence's own level between the two: that
    # would close the with-block early and leave registration outside it.
    for line in lines[fence_idx + 1:reg_idx]:
        if not line.strip() or line.strip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        assert indent > fence_indent, (
            f"statement dedents out of the admission fence before registration: {line!r}"
        )
