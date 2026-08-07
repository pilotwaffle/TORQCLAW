"""P2-1g: runtime safety primitives a future skill-activation pipeline must
sequence through so a skill mutation can never become "effective" while a
live Hermes agent could still hold the superseded skill prompt.

Covers mcp_wrapper.runtime_quiescence:
  - assert_skill_runtime_quiescent() — quiescence is exactly
    hermes_runner.RUNNING being empty.
  - invalidate_skill_prompt_cache() — fail-closed wrapper around the REAL
    vendored agent.prompt_builder.clear_skills_system_prompt_cache.
  - skill_mutation_transaction() — the one process-wide lock covering both
    steps together, so two mutations cannot race through quiescence-check
    and cache-invalidation independently.

This ticket builds primitives only: nothing here publishes a skill, touches
skills.external_dirs, or changes activation.
"""
from __future__ import annotations

import threading
import time

import pytest

from mcp_wrapper import hermes_runner
from mcp_wrapper.runtime_quiescence import (
    SkillPromptInvalidationError,
    SkillRuntimeBusyError,
    assert_skill_runtime_quiescent,
    invalidate_skill_prompt_cache,
    skill_mutation_transaction,
)
from mcp_wrapper.verified_skill_store import SkillStoreError


@pytest.fixture(autouse=True)
def _clean_running_registry():
    """RUNNING is process-global state; never let one test's fake agent leak
    into another test's quiescence check."""
    hermes_runner.RUNNING.clear()
    yield
    hermes_runner.RUNNING.clear()


# ---------------------------------------------------------------------------
# 1-4: quiescence is exactly RUNNING being empty.
# ---------------------------------------------------------------------------

def test_quiescence_succeeds_with_no_active_agent():
    """Test 1: an empty RUNNING registry must not block a mutation."""
    assert hermes_runner.RUNNING == {}
    assert_skill_runtime_quiescent()  # must not raise


def test_quiescence_fails_with_one_running_agent():
    """Test 2: exactly one live entry in RUNNING must block."""
    hermes_runner.RUNNING["task-1"] = object()
    with pytest.raises(SkillRuntimeBusyError):
        assert_skill_runtime_quiescent()


def test_quiescence_fails_with_multiple_running_agents():
    """Test 3: more than one live entry must also block (not just the
    single-agent case)."""
    hermes_runner.RUNNING["task-1"] = object()
    hermes_runner.RUNNING["task-2"] = object()
    hermes_runner.RUNNING["task-3"] = object()
    with pytest.raises(SkillRuntimeBusyError):
        assert_skill_runtime_quiescent()


def test_quiescence_succeeds_again_after_last_agent_removed():
    """Test 4: quiescence is a live check, not a one-shot latch — removing
    the last RUNNING entry must let the very next attempt succeed."""
    hermes_runner.RUNNING["task-1"] = object()
    with pytest.raises(SkillRuntimeBusyError):
        assert_skill_runtime_quiescent()

    del hermes_runner.RUNNING["task-1"]
    assert_skill_runtime_quiescent()  # must not raise


def test_quiescence_ignores_websocket_or_session_state():
    """Test 5: only mcp_wrapper.hermes_runner.RUNNING counts. A stand-in for
    "session/connection state" that looks busy (e.g. an open websocket
    registry, a pending-approval session dict) must have zero influence on
    the guard — it doesn't even take such state as an argument, and an empty
    RUNNING must succeed regardless of how much unrelated session bookkeeping
    exists elsewhere in the process."""
    fake_session_state = {
        "ws-connection-1": {"status": "OPEN"},
        "ws-connection-2": {"status": "OPEN"},
        "pending_approval_sessions": ["sess-a", "sess-b", "sess-c"],
    }
    assert hermes_runner.RUNNING == {}
    # The busy-looking session state above is never touched by the guard.
    assert_skill_runtime_quiescent()  # must not raise
    assert fake_session_state  # sanity: the stand-in state itself is untouched/unused


# ---------------------------------------------------------------------------
# 6-9: cache invalidation is a fail-closed wrapper around the REAL upstream
# clear_skills_system_prompt_cache.
# ---------------------------------------------------------------------------

def test_invalidate_calls_real_upstream_function_with_clear_snapshot_false(monkeypatch):
    """Test 6: the invalidator must call the REAL upstream
    agent.prompt_builder.clear_skills_system_prompt_cache with
    clear_snapshot=False -- not a stand-in, not a different argument."""
    import agent.prompt_builder as prompt_builder  # the real vendored module

    calls: list[dict] = []
    original = prompt_builder.clear_skills_system_prompt_cache

    def recording_wrapper(*, clear_snapshot: bool = False) -> None:
        calls.append({"clear_snapshot": clear_snapshot})
        return original(clear_snapshot=clear_snapshot)

    monkeypatch.setattr(
        prompt_builder, "clear_skills_system_prompt_cache", recording_wrapper
    )

    invalidate_skill_prompt_cache()

    assert calls == [{"clear_snapshot": False}]


def test_invalidate_fails_closed_when_upstream_function_missing(monkeypatch):
    """Test 7: if agent.prompt_builder no longer exposes
    clear_skills_system_prompt_cache (upstream rename/removal), the
    invalidator must raise the typed fail-closed error, never silently
    proceed as if the cache had been cleared."""
    import agent.prompt_builder as prompt_builder

    monkeypatch.delattr(prompt_builder, "clear_skills_system_prompt_cache")

    with pytest.raises(SkillPromptInvalidationError):
        invalidate_skill_prompt_cache()


def test_invalidate_fails_closed_when_upstream_function_raises(monkeypatch):
    """Test 8: if the real upstream function is reachable but raises (lock
    contention, internal error, whatever), that must surface as the typed
    fail-closed error, not propagate as the raw upstream exception and not
    be swallowed."""
    import agent.prompt_builder as prompt_builder

    def boom(*, clear_snapshot: bool = False) -> None:
        raise RuntimeError("simulated upstream cache-clear failure")

    monkeypatch.setattr(prompt_builder, "clear_skills_system_prompt_cache", boom)

    with pytest.raises(SkillPromptInvalidationError):
        invalidate_skill_prompt_cache()


def test_invalidate_never_falls_back_to_disk_snapshot_deletion(monkeypatch):
    """Test 9: on either failure mode (missing function, raising function),
    the invalidator must not fall back to deleting the on-disk snapshot
    (i.e. it must never call the real function with clear_snapshot=True as
    a substitute recovery path)."""
    import agent.prompt_builder as prompt_builder

    calls: list[dict] = []
    original = prompt_builder.clear_skills_system_prompt_cache

    def recording_wrapper(*, clear_snapshot: bool = False) -> None:
        calls.append({"clear_snapshot": clear_snapshot})
        return original(clear_snapshot=clear_snapshot)

    # Case A: function raises -- confirm no subsequent clear_snapshot=True
    # fallback call is made.
    def boom(*, clear_snapshot: bool = False) -> None:
        calls.append({"clear_snapshot": clear_snapshot, "raised": True})
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(prompt_builder, "clear_skills_system_prompt_cache", boom)
    with pytest.raises(SkillPromptInvalidationError):
        invalidate_skill_prompt_cache()
    assert calls == [{"clear_snapshot": False, "raised": True}]
    assert all(not c.get("clear_snapshot") for c in calls), (
        "invalidator must never fall back to clear_snapshot=True"
    )

    # Case B: function missing -- confirm zero calls of any kind occur.
    calls.clear()
    monkeypatch.delattr(prompt_builder, "clear_skills_system_prompt_cache")
    with pytest.raises(SkillPromptInvalidationError):
        invalidate_skill_prompt_cache()
    assert calls == []

    # Restore and prove the happy path still calls with clear_snapshot=False
    # exactly, i.e. this test didn't just get lucky on the failure paths.
    # (monkeypatch.setattr after monkeypatch.delattr on the same attribute
    # cannot re-track the attribute for teardown, so restore directly.)
    setattr(prompt_builder, "clear_skills_system_prompt_cache", recording_wrapper)
    invalidate_skill_prompt_cache()
    assert calls == [{"clear_snapshot": False}]
    setattr(prompt_builder, "clear_skills_system_prompt_cache", original)


# ---------------------------------------------------------------------------
# 10: no vendor modification.
# ---------------------------------------------------------------------------

def test_no_vendor_modification():
    """Test 10: this ticket must not have edited anything under vendor/.
    Verified two ways: (a) the real upstream function is importable and
    unwrapped by our code (no monkeypatch active in this test), and (b) a
    git-tracked-files check that no path under the hermes-agent submodule
    shows as modified relative to its pinned commit."""
    import inspect

    import agent.prompt_builder as prompt_builder

    # (a) the function TORQCLAW calls is the real, un-modified upstream
    # symbol -- if vendor/ had been edited to add a TORQCLAW-specific hook,
    # this signature check (keyword-only clear_snapshot) is a cheap tripwire.
    sig = inspect.signature(prompt_builder.clear_skills_system_prompt_cache)
    params = sig.parameters
    assert "clear_snapshot" in params
    assert params["clear_snapshot"].kind == inspect.Parameter.KEYWORD_ONLY

    # (b) the submodule working tree must be clean -- git diff against the
    # pinned commit should show nothing. Runs from the repo root two levels
    # above this test file's mcp_wrapper package (engines/hermes_kernel/..).
    import subprocess
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[3]
    vendor_dir = repo_root / "engines" / "hermes_kernel" / "vendor" / "hermes-agent"
    if not vendor_dir.exists():
        pytest.skip("vendor/hermes-agent not checked out in this environment")
    # Ask the SUPERPROJECT about the submodule rather than running `git status`
    # inside the vendor dir. G2A found the latter is a false positive: when the
    # vendor tree is not itself a git root, git walks UP and reports the
    # superproject's own uncommitted changes -- i.e. the ticket under test --
    # as "vendor was modified". Proven by isolation: the old form failed with
    # ANY dirty file anywhere in the tree.
    result = subprocess.run(
        ["git", "submodule", "status", "--",
         "engines/hermes_kernel/vendor/hermes-agent"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"git submodule status failed: {result.stderr}"
    status_line = result.stdout.rstrip()
    assert status_line, "vendor/hermes-agent is not registered as a submodule"
    if status_line.startswith("-"):
        # Not an initialised submodule here (e.g. a tree restored from the
        # object store). The pin cannot be compared, so skip rather than
        # assert a green we did not actually verify.
        pytest.skip("vendor/hermes-agent is not an initialised submodule here")
    assert not status_line.startswith(("+", "U")), (
        f"vendor/hermes-agent moved off its pinned commit or is conflicted, "
        f"which this ticket must not do:\n{status_line}"
    )


# ---------------------------------------------------------------------------
# 11: concurrent mutation attempts serialize on one lock.
# ---------------------------------------------------------------------------

def test_concurrent_mutation_attempts_serialize_on_one_lock():
    """Test 11: two threads entering skill_mutation_transaction() concurrently
    must never execute their critical sections overlapping in time. This
    proves there is exactly one process-wide lock and both callers actually
    contend on it (not two independent locks that happen not to collide)."""
    order: list[str] = []
    concurrently_inside = {"count": 0, "max_seen": 0}
    lock_for_counter = threading.Lock()

    def critical_section(name: str) -> None:
        with lock_for_counter:
            concurrently_inside["count"] += 1
            concurrently_inside["max_seen"] = max(
                concurrently_inside["max_seen"], concurrently_inside["count"]
            )
        order.append(f"{name}-enter")
        time.sleep(0.05)  # widen the window so a race would actually be observed
        order.append(f"{name}-exit")
        with lock_for_counter:
            concurrently_inside["count"] -= 1

    def worker(name: str) -> None:
        with skill_mutation_transaction():
            critical_section(name)

    t1 = threading.Thread(target=worker, args=("A",))
    t2 = threading.Thread(target=worker, args=("B",))
    t1.start()
    time.sleep(0.01)  # ensure t1 acquires first
    t2.start()
    t1.join(timeout=5)
    t2.join(timeout=5)

    assert not t1.is_alive() and not t2.is_alive()
    # At no point were both critical sections active simultaneously.
    assert concurrently_inside["max_seen"] == 1
    # And the two are fully ordered: one's exit precedes the other's enter.
    assert order in (
        ["A-enter", "A-exit", "B-enter", "B-exit"],
        ["B-enter", "B-exit", "A-enter", "A-exit"],
    )


def test_transaction_lock_covers_quiescence_and_invalidation_together(monkeypatch):
    """Test 11 (continued): the SAME lock instance guards both
    assert_skill_runtime_quiescent() and invalidate_skill_prompt_cache() when
    used inside skill_mutation_transaction(), i.e. a caller cannot observe
    quiescence, release, and only then race another caller into cache
    invalidation. Demonstrated by holding the transaction open across both
    calls from one thread while a second thread blocks on entry until the
    first fully exits."""
    import agent.prompt_builder as prompt_builder

    monkeypatch.setattr(
        prompt_builder,
        "clear_skills_system_prompt_cache",
        lambda *, clear_snapshot=False: None,
    )

    events: list[str] = []
    second_thread_entered = threading.Event()

    def first():
        with skill_mutation_transaction():
            assert_skill_runtime_quiescent()
            events.append("first-quiescence-checked")
            time.sleep(0.05)
            invalidate_skill_prompt_cache()
            events.append("first-invalidated")
            # second thread must still be blocked right now
            assert not second_thread_entered.is_set()

    def second():
        with skill_mutation_transaction():
            second_thread_entered.set()
            events.append("second-entered")

    t1 = threading.Thread(target=first)
    t2 = threading.Thread(target=second)
    t1.start()
    time.sleep(0.01)
    t2.start()
    t1.join(timeout=5)
    t2.join(timeout=5)

    assert events == [
        "first-quiescence-checked",
        "first-invalidated",
        "second-entered",
    ]


# ---------------------------------------------------------------------------
# 12: a busy failure mutates neither RUNNING nor any supplied state object.
# ---------------------------------------------------------------------------

def test_busy_failure_mutates_neither_running_nor_supplied_state():
    """Test 12 (P2-1h lesson carried forward): assert on the in-memory
    objects after a failed mutation, not only on reloaded disk state. A
    guard that mutated RUNNING (e.g. popped a "stale" entry) or mutated a
    caller-supplied state object before raising would pass a disk-only
    check but fail this one."""
    fake_agent = object()
    hermes_runner.RUNNING["busy-task"] = fake_agent
    running_snapshot_before = dict(hermes_runner.RUNNING)

    # A representative "supplied state object" a future activation call
    # would pass alongside the quiescence check -- e.g. a mutation request
    # or draft state dict. The guard function takes no such argument today,
    # but the invariant under test is that failure has zero side effects on
    # anything reachable from the caller, so we mutate-check both RUNNING
    # itself and an independent object a caller might hold.
    supplied_state = {"skillId": "demo.skill", "digest": "0" * 64, "mutated": False}
    supplied_state_snapshot = dict(supplied_state)

    with pytest.raises(SkillRuntimeBusyError):
        assert_skill_runtime_quiescent()

    assert hermes_runner.RUNNING == running_snapshot_before
    assert hermes_runner.RUNNING["busy-task"] is fake_agent
    assert supplied_state == supplied_state_snapshot


def test_transaction_asserts_quiescence_on_entry_caller_cannot_skip_it(monkeypatch):
    """G2A finding (a): the transaction must ENFORCE the ordering, not merely
    recommend it.

    An earlier shape only held the lock and yielded, leaving the quiescence
    assertion to caller convention. That was demonstrably bypassable: a
    caller could acquire the transaction with a live Hermes run, never call
    assert_skill_runtime_quiescent(), mutate, and 'commit' -- violating the
    invariant that no mutation is effective while an agent can still hold a
    superseded skill prompt. Mutual exclusion is not ordering.

    The body below never calls the guard itself. It must still be
    unreachable while RUNNING is non-empty.
    """
    hermes_runner.RUNNING["live-task"] = object()
    entered = False

    with pytest.raises(SkillRuntimeBusyError):
        with skill_mutation_transaction():
            entered = True  # pragma: no cover - must never execute

    assert entered is False, (
        "transaction body ran with a live Hermes run: quiescence is advisory "
        "again, not enforced on entry"
    )


def test_transaction_invalidates_cache_on_normal_exit(monkeypatch):
    """The exit bookend: invalidation must run before the lock releases, so a
    caller cannot defer it to post-success cleanup or forget it entirely."""
    import agent.prompt_builder as prompt_builder  # the real vendored module

    calls: list[dict] = []
    monkeypatch.setattr(
        prompt_builder,
        "clear_skills_system_prompt_cache",
        lambda **kw: calls.append(kw),
    )

    with skill_mutation_transaction():
        assert calls == [], "invalidation must run on exit, not on entry"

    assert calls == [{"clear_snapshot": False}]


def test_transaction_skips_invalidation_when_body_raises(monkeypatch):
    """Fail-closed direction: a body that raises must NOT report a cleared
    cache. The mutation did not complete, so the caller must not declare it
    effective, and a future pipeline is responsible for restoring prior
    governed state on this path."""
    import agent.prompt_builder as prompt_builder  # the real vendored module

    calls: list[dict] = []
    monkeypatch.setattr(
        prompt_builder,
        "clear_skills_system_prompt_cache",
        lambda **kw: calls.append(kw),
    )

    class _BodyFailed(RuntimeError):
        pass

    with pytest.raises(_BodyFailed):
        with skill_mutation_transaction():
            raise _BodyFailed("mutation failed mid-flight")

    assert calls == [], "invalidation ran despite a failed mutation body"


def test_busy_error_is_typed_and_outside_recovery_and_valueerror_families():
    """SkillRuntimeBusyError and SkillPromptInvalidationError both subclass
    SkillStoreError but must stay outside the SkillRecoveryError/ValueError
    families, matching the precedent set by SkillAuditCapacityError: a busy
    condition or an unproven cache clear is not "state needs reconciliation"
    and must not be laundered into a recovery warning by any handler that
    catches SkillRecoveryError or ValueError before a more specific type."""
    from mcp_wrapper.verified_skill_store import SkillRecoveryError, SkillValidationError

    for exc_type in (SkillRuntimeBusyError, SkillPromptInvalidationError):
        assert issubclass(exc_type, SkillStoreError)
        assert not issubclass(exc_type, SkillRecoveryError)
        assert not issubclass(exc_type, SkillValidationError)
        assert not issubclass(exc_type, ValueError)
