"""GS-COORD: proves the REAL governed activation path actually routes
through ``ActivationCoordinator`` -- module reachability is insufficient,
per the ticket this closes. Covers every adversarial ordering edge the
ticket's "Required tests" section calls mandatory:

  - live Hermes run blocks activation; row stays pending; typed busy
    result; retry after the run ends succeeds
  - new Hermes admission cannot race mutation (covered by the existing
    P2-1g.1 ``hermes_run_admission`` suite in test_runtime_quiescence.py;
    this file adds the governed-skills-specific busy-result contract only)
  - cache invalidation failure
  - governed commit failure -> prior projection restored EXACTLY + cache
    invalidated again
  - verify failure -> same
  - replacement activation restores the exact previous skill (content, not
    just presence)
  - first-time activation failure leaves nothing published
  - restart after a failed coordinated activation cannot silently complete
    it (fresh VerifiedSkillStore construction)
  - approval remains usable after a failure where appropriate
  - successful activation is visible to a FRESH REAL Hermes loader
  - mid-transaction loader scan yields EXACTLY ONE match
  - concurrent APPROVE on the same queue item does not double-activate
  - success-side crash: digest already active+published -> retry reconciles
"""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper import hermes_runner  # noqa: E402,F401  (vendor sys.path insert)
from mcp_wrapper import governed_skills  # noqa: E402
from mcp_wrapper import skill_publisher  # noqa: E402
from mcp_wrapper import skill_queue  # noqa: E402
from mcp_wrapper.runtime_quiescence import (  # noqa: E402
    ActivationCoordinator,
    SkillActivationCoordinationError,
    SkillActivationRestoredButCacheUnprovenError,
    SkillPromptInvalidationError,
    SkillRuntimeBusyError,
)
from mcp_wrapper.verified_skill_store import VerifiedSkillStore  # noqa: E402

vendored_available, vendor_import_error = hermes_runner.hermes_available()
pytestmark = pytest.mark.skipif(
    not vendored_available,
    reason=f"vendored hermes-agent unavailable: {vendor_import_error}",
)


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """Never touch the operator's real ~/.torqclaw or ~/.hermes. Mirrors
    test_governed_skills.py's fixture exactly."""
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
    hermes_runner.RUNNING.clear()
    yield
    hermes_runner.RUNNING.clear()
    governed_skills._reset_for_test()
    skill_publisher._invalidate_upstream_external_dirs_cache()


def _real_loader_ids() -> set[str]:
    """The REAL Hermes loader's view of every discoverable skill id -- never
    a file-existence shortcut."""
    from agent.skill_utils import get_all_skills_dirs, iter_skill_index_files

    found: set[str] = set()
    for skills_dir in get_all_skills_dirs():
        skills_dir = Path(skills_dir)
        if not skills_dir.is_dir():
            continue
        for skill_file in iter_skill_index_files(skills_dir, "SKILL.md"):
            found.add(Path(skill_file).parent.name)
    return found


def _fresh_queue(monkeypatch, tmp_path):
    import importlib

    import mcp_wrapper.skill_queue as sq

    monkeypatch.setenv("HERMES_SKILLS_DIR", str(tmp_path / "legacy_skills"))
    return importlib.reload(sq)


# ---------------------------------------------------------------------------
# 1. The invariant path: decide() -> governed_skills -> ActivationCoordinator
#    actually runs (instrumented, not just "the module is importable").
# ---------------------------------------------------------------------------


def test_decide_APPROVE_actually_invokes_ActivationCoordinator_run(
    tmp_path, monkeypatch
):
    """Spy on ActivationCoordinator.run itself so this fails if a future
    refactor reroutes around the coordinator while leaving the import
    (module reachability, which the ticket explicitly calls insufficient)."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()

    calls = []
    original_run = ActivationCoordinator.run

    def spy_run(self):
        calls.append(self)
        return original_run(self)

    monkeypatch.setattr(ActivationCoordinator, "run", spy_run)

    qid = sq.queue_skill("spied.skill", "Real content.\n")
    result = sq.decide(qid, "APPROVE")

    assert result["ok"] is True
    assert len(calls) == 1, "decide() must call ActivationCoordinator.run() exactly once"
    assert "spied.skill" in _real_loader_ids()


def test_store_construction_happens_under_mutation_lock(tmp_path, monkeypatch):
    """GS-COORD round 2, item 1: VerifiedSkillStore.__init__ (which runs
    reconcile(), a mutating operation) must happen with _MUTATION_LOCK held
    -- never before the coordinator's lock acquisition, never lazily from an
    unlocked caller on the governed mutation path. G1R measured this FALSE
    against round 1 by spying __init__ through the real
    governed_skills.install_approved_skill and printing
    _MUTATION_LOCK._is_owned(). Reproduce that exact measurement here, driven
    through the real skill_queue.decide(), so a future refactor that moves
    construction back outside the lock fails this test rather than merely
    violating an unenforced docstring claim."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()  # force _STORE back to None

    from mcp_wrapper import runtime_quiescence as rq
    from mcp_wrapper.verified_skill_store import VerifiedSkillStore

    owned_at_construction = []
    original_init = VerifiedSkillStore.__init__

    def spy_init(self, *args, **kwargs):
        owned_at_construction.append(rq._MUTATION_LOCK._is_owned())
        return original_init(self, *args, **kwargs)

    monkeypatch.setattr(VerifiedSkillStore, "__init__", spy_init)

    qid = sq.queue_skill("lock-checked.skill", "Real content.\n")
    result = sq.decide(qid, "APPROVE")

    assert result["ok"] is True
    assert len(owned_at_construction) == 1, (
        "VerifiedSkillStore.__init__ must be called exactly once on this "
        "fresh-store path"
    )
    assert owned_at_construction[0] is True, (
        "VerifiedSkillStore was constructed WITHOUT _MUTATION_LOCK held -- "
        "this is the exact G1R round-1 blocker: reconcile() ran outside the "
        "coordinator's lock"
    )
    assert "lock-checked.skill" in _real_loader_ids()


# ---------------------------------------------------------------------------
# 2. Live Hermes run blocks activation; row stays pending; typed busy
#    result; retry after the run ends succeeds.
# ---------------------------------------------------------------------------


def test_busy_hermes_run_blocks_activation_row_stays_pending_typed_result(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()

    qid = sq.queue_skill("busy.skill", "Blocked content.\n")

    hermes_runner.RUNNING["fake-task-1"] = object()
    hermes_runner.RUNNING["fake-task-2"] = object()
    try:
        result = sq.decide(qid, "APPROVE")
    finally:
        pass

    assert result["ok"] is False
    assert result["code"] == "SKILL_RUNTIME_BUSY"
    assert result["retryable"] is True
    assert result["status"] == "pending"
    assert result["activeTasks"] == 2

    # The row must genuinely still be pending -- a second decide() on this id
    # must NOT be rejected by the "already <status>" guard.
    draft = sq.get_draft(qid)
    assert draft["status"] == "pending"

    # Nothing was published or governed-active.
    assert "busy.skill" not in _real_loader_ids()
    assert not skill_publisher.is_published("busy.skill")

    # Retry after the run ends succeeds.
    hermes_runner.RUNNING.clear()
    retried = sq.decide(qid, "APPROVE")
    assert retried["ok"] is True
    assert retried["governed"] is True
    assert "busy.skill" in _real_loader_ids()


def test_busy_result_reflects_exact_active_task_count():
    """activeTasks must be the real, current count -- not a hardcoded 1."""
    governed_skills._reset_for_test()
    hermes_runner.RUNNING["t1"] = object()
    hermes_runner.RUNNING["t2"] = object()
    hermes_runner.RUNNING["t3"] = object()
    with pytest.raises(SkillRuntimeBusyError) as excinfo:
        governed_skills.install_approved_skill("whatever.skill", "x\n")
    assert "3" in str(excinfo.value)


# ---------------------------------------------------------------------------
# 3. Cache invalidation failure -> restore + second invalidation attempted.
# ---------------------------------------------------------------------------


def test_cache_invalidation_failure_restores_and_leaves_nothing_published(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()

    import mcp_wrapper.runtime_quiescence as rq

    calls = {"n": 0}
    real_invalidate = rq.invalidate_skill_prompt_cache

    def flaky_invalidate():
        calls["n"] += 1
        if calls["n"] == 1:
            raise SkillPromptInvalidationError("simulated first invalidation failure")
        return real_invalidate()

    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", flaky_invalidate)
    # governed_skills imports ActivationCoordinator directly but the
    # coordinator's `run()` calls the module-level function by name inside
    # runtime_quiescence, so patching it there is sufficient -- verified by
    # the assertion below that the flaky path was actually exercised.

    with pytest.raises(SkillActivationCoordinationError):
        governed_skills.install_approved_skill("firsttime.skill", "content\n")

    assert calls["n"] >= 1
    assert "firsttime.skill" not in _real_loader_ids()
    assert not skill_publisher.is_published("firsttime.skill")
    # No stray retained/doomed directories left behind.
    retained_root = skill_publisher.published_skills_retained_root()
    if retained_root.exists():
        assert list(retained_root.iterdir()) == []
    published_root = skill_publisher.published_skills_dir()
    if published_root.exists():
        assert list(published_root.glob(".torqclaw-*")) == []


# ---------------------------------------------------------------------------
# 3b. GS-COORD round 3, item D: SkillActivationRestoredButCacheUnprovenError
#     must NOT be laundered into skill_queue.decide()'s ordinary
#     {code: SKILL_ACTIVATION_FAILED, retryable: True, status: "pending"}
#     shape. Round 2 imported only SkillRuntimeBusyError and
#     GovernanceRevertedProjectionUnprovenError in skill_queue.py, so this
#     error fell to the generic `except Exception` whose own comment
#     falsely asserted "nothing partial is left published or
#     governed-active -- the coordinator's own restore path guarantees
#     that." Measured (round 2) through the real decide(): that shape came
#     back even though the disk projection had moved twice (publish, then
#     restore) and the cache was unproven -- structurally identical to V3,
#     a round-1 blocker. Deletion-probed: removing the dedicated
#     `except SkillActivationRestoredButCacheUnprovenError` arm in
#     skill_queue.py makes this test fail.
# ---------------------------------------------------------------------------


def test_decide_reports_distinct_code_when_cache_unproven_after_restore(
    tmp_path, monkeypatch
):
    """Force BOTH the first invalidation (right after publish()) and the
    mandatory second one (right after restore()) to fail, through the real
    skill_queue.decide() -> governed_skills.install_approved_skill ->
    ActivationCoordinator chain. The external projection genuinely moved
    twice (nothing was ever published before this attempt, so restore()
    removes what publish() just wrote) while governed state was never
    committed (commit() never runs on this path) -- decide() must surface a
    code distinct from the ordinary retryable/pending activation-failure
    shape, since that shape's own docstring promise ("nothing partial is
    left published or governed-active") does not hold for an unproven
    cache."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()

    import mcp_wrapper.runtime_quiescence as rq

    invalidate_calls = {"n": 0}

    def always_fail_invalidate():
        invalidate_calls["n"] += 1
        raise SkillPromptInvalidationError(
            f"simulated invalidation failure #{invalidate_calls['n']}"
        )

    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", always_fail_invalidate)

    qid = sq.queue_skill("cache-unproven.skill", "content\n")
    result = sq.decide(qid, "APPROVE")

    # Both invalidation attempts were exercised (the failure path this test
    # targets requires both to fail).
    assert invalidate_calls["n"] == 2

    assert result["ok"] is False
    assert result["code"] == "SKILL_ACTIVATION_CACHE_UNPROVEN"
    # This is not the ordinary retryable/pending shape: a blind automated
    # retry is not obviously safe until an operator has confirmed actual
    # cache/projection state.
    assert result["retryable"] is False
    assert result["status"] == "pending"
    assert result["code"] != "SKILL_ACTIVATION_FAILED"

    # The row must genuinely still be pending -- retryable by an operator
    # after manual inspection, not permanently bricked.
    draft = sq.get_draft(qid)
    assert draft["status"] == "pending"

    # Nothing was left published (restore() undid the first-time publish).
    assert "cache-unproven.skill" not in _real_loader_ids()
    assert not skill_publisher.is_published("cache-unproven.skill")


# ---------------------------------------------------------------------------
# 4. Governed commit failure -> prior projection restored EXACTLY (content,
#    not just presence) + cache invalidated again.
# ---------------------------------------------------------------------------


def test_commit_failure_restores_exact_prior_content_and_reinvalidates(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()

    # First, a real successful activation so there is a genuine prior
    # version to restore.
    first = governed_skills.install_approved_skill("replace.skill", "VERSION ONE\n")
    assert first["ok"] is True
    prior_path = Path(first["publishedPath"])
    prior_bytes = (prior_path / "SKILL.md").read_bytes()
    prior_manifest_bytes = (prior_path / "skill.json").read_bytes()

    import mcp_wrapper.runtime_quiescence as rq

    invalidate_calls = []
    real_invalidate = rq.invalidate_skill_prompt_cache

    def counting_invalidate():
        invalidate_calls.append(1)
        return real_invalidate()

    monkeypatch.setattr(rq, "invalidate_skill_prompt_cache", counting_invalidate)

    # Force the governed commit (store.activate, called inside _commit) to
    # fail by making the store's _save_state raise -- a real commit failure,
    # not a stand-in. _save_state is also called once by approve() before
    # the coordinator even starts, so only the SECOND call (activate()'s,
    # inside the coordinator's commit() step) must fail.
    store = governed_skills._store()
    original_save_state = store._save_state
    save_state_calls = {"n": 0}

    def crash_second_save_state(state):
        save_state_calls["n"] += 1
        if save_state_calls["n"] >= 2:
            raise RuntimeError("simulated governed commit failure")
        return original_save_state(state)

    monkeypatch.setattr(store, "_save_state", crash_second_save_state)

    with pytest.raises(SkillActivationCoordinationError):
        governed_skills.install_approved_skill("replace.skill", "VERSION TWO\n")

    monkeypatch.setattr(store, "_save_state", original_save_state)

    # Exactly two invalidations: one right after publish(), one more after
    # restore() -- the mandatory second invalidation this ticket adds.
    assert len(invalidate_calls) == 2

    # The restored projection must be byte-identical to the original,
    # content included -- not merely "a directory exists at that path".
    restored_path = Path(skill_publisher.published_skills_dir()) / "replace.skill"
    assert restored_path.is_dir()
    assert (restored_path / "SKILL.md").read_bytes() == prior_bytes
    assert (restored_path / "skill.json").read_bytes() == prior_manifest_bytes

    # Governed active state must still show the ORIGINAL digest.
    active = store.get_active("replace.skill")
    assert active["digest"] == first["digest"]

    # The real loader must see exactly the restored (original) content.
    assert "replace.skill" in _real_loader_ids()
    for skills_dir_path in _iter_real_skill_dirs():
        candidate = skills_dir_path / "replace.skill" / "SKILL.md"
        if candidate.is_file():
            assert candidate.read_bytes() == prior_bytes

    # No leftover retained directory.
    retained_root = skill_publisher.published_skills_retained_root()
    if retained_root.exists():
        assert list(retained_root.iterdir()) == []


def _iter_real_skill_dirs():
    from agent.skill_utils import get_all_skills_dirs

    for d in get_all_skills_dirs():
        d = Path(d)
        if d.is_dir():
            yield d


# ---------------------------------------------------------------------------
# 4b. GS-COORD round 3, items A/B: GovernanceRevertedProjectionUnprovenError
#     must be reached through a genuine VERIFY failure (governed commit
#     landed for real, active state actually flipped to the new digest, THEN
#     verify() catches a real discrepancy and triggers restore), not a
#     COMMIT failure. G2A measured 0 hits on this branch across all 302 round
#     -2 tests: the two tests this replaces both forced `activate()` itself
#     to raise (via `_save_state` crashing on its second call, which is
#     `activate()`'s OWN `_save_state` call, so `activate()` never returns).
#     With commit() failing outright, `commit_holder["previous"]` was
#     written to (round 2's bug: it was recorded BEFORE calling `activate()`,
#     see the `_commit` fix above), so `revert_activation` ran against a
#     digest that was never actually made active -- it read fresh state
#     showing the OLD digest still active and silently no-op'd
#     (`reverted: False`). The assertion `active["digest"] == first["digest"]`
#     therefore passed VACUOUSLY: governance was simply never moved, not
#     genuinely reverted, so the assertion is unchanged whether the
#     branch/fix exists at all.
#
#     The reachable state (per the round-3 ticket) is: commit lands for real
#     -> verify() fails -> governance reverts -> publisher restore ALSO
#     fails. This is forced below by letting the SECOND install's activate()
#     succeed completely (so `state["active"]` genuinely flips to the new
#     digest and `commit_holder["previous"]` is genuinely populated), then
#     making `skill_publisher.is_published` report False for this skill id
#     during `_verify` (the same technique
#     `test_verify_failure_restores_exact_prior_projection` above already
#     uses to force a real, reachable verify failure), and ALSO making
#     `restore_retained_projection` raise. Deletion-probed (G1D and G2A
#     independently, round 3): neutralising the
#     `raise GovernanceRevertedProjectionUnprovenError` in `_restore`'s
#     publisher-restore-failure branch makes these two tests fail.
#
#     NOT claimed: reverting the `_commit` ordering fix above does NOT fail
#     any test -- measured green at 302 by G2A in round 3. That ordering is
#     unenforced by the suite, and deliberately so: a differential harness
#     under both orderings showed the externally observable end state is
#     IDENTICAL, because round 2's extra `revert_activation` call was a
#     genuine no-op (`reverted: False`) against a commit that never landed.
#     Round 2's ordering was a test-vacuity defect, not a correctness defect;
#     the round-3 fix buys provability, not behaviour. Do not add a test that
#     pins the ordering by asserting an end state -- it would pass under both
#     and be exactly the vacuous assertion this file exists to avoid.
# ---------------------------------------------------------------------------


def test_verify_failure_then_projection_restore_failure_reverts_governance_first(
    tmp_path, monkeypatch
):
    """Force a genuine post-commit VERIFY failure (governed commit for real
    landed at the new digest) whose restore() callback then also fails to
    restore the published projection. Confirm, through the real
    governed_skills.install_approved_skill: governed-active is back at the
    PRIOR digest (the governed revert is unconditional relative to the
    publisher restore and runs first), and the coordinator surfaces the
    distinct GovernanceRevertedProjectionUnprovenError rather than an
    ordinary SkillActivationCoordinationError."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()

    first = governed_skills.install_approved_skill(
        "revert-first.skill", "VERSION ONE\n"
    )
    assert first["ok"] is True

    # Force is_published() to report False for exactly this skill id during
    # the coordinator's _verify step -- a real, reachable verify failure
    # (activate() itself succeeds and genuinely flips governed-active to the
    # new digest first).
    original_is_published = skill_publisher.is_published

    def flaky_is_published(skill_id):
        if skill_id == "revert-first.skill":
            return False
        return original_is_published(skill_id)

    monkeypatch.setattr(skill_publisher, "is_published", flaky_is_published)

    original_restore_projection = skill_publisher.restore_retained_projection

    def boom_restore_projection(*args, **kwargs):
        raise OSError("simulated publisher restore failure")

    monkeypatch.setattr(
        skill_publisher, "restore_retained_projection", boom_restore_projection
    )

    from mcp_wrapper.governed_skills import GovernanceRevertedProjectionUnprovenError

    with pytest.raises(GovernanceRevertedProjectionUnprovenError):
        governed_skills.install_approved_skill("revert-first.skill", "VERSION TWO\n")

    monkeypatch.setattr(skill_publisher, "is_published", original_is_published)
    monkeypatch.setattr(
        skill_publisher, "restore_retained_projection", original_restore_projection
    )

    # Governance MUST already be back at the prior digest even though the
    # publisher restore failed -- this is the "revert governance first,
    # unconditionally" fix, now reached via a commit that genuinely landed.
    store = governed_skills._store()
    active = store.get_active("revert-first.skill")
    assert active is not None
    assert active["digest"] == first["digest"], (
        "governed-active must be reverted to the prior digest even when "
        "the publisher restore fails afterward"
    )


def test_decide_does_not_report_retryable_pending_when_projection_unproven(
    tmp_path, monkeypatch
):
    """The ticket's exact required probe, through the real
    skill_queue.decide(): when restore_retained_projection() fails after a
    genuine VERIFY failure (not a commit failure -- see the module comment
    above for why that distinction is load-bearing), the queue result must
    NOT be the ordinary {retryable: true, status: "pending"} shape -- that
    shape's docstring claims 'nothing partial is left published or
    governed-active', which is false here. Round-1 laundered this into a
    bare RuntimeError caught by skill_queue's generic `except Exception`,
    producing exactly the forbidden shape."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()

    qid1 = sq.queue_skill("unproven.skill", "VERSION ONE\n")
    first = sq.decide(qid1, "APPROVE")
    assert first["ok"] is True
    first_digest = first["digest"]

    original_is_published = skill_publisher.is_published

    def flaky_is_published(skill_id):
        if skill_id == "unproven.skill":
            return False
        return original_is_published(skill_id)

    monkeypatch.setattr(skill_publisher, "is_published", flaky_is_published)

    original_restore_projection = skill_publisher.restore_retained_projection

    def boom_restore_projection(*args, **kwargs):
        raise OSError("simulated publisher restore failure")

    monkeypatch.setattr(
        skill_publisher, "restore_retained_projection", boom_restore_projection
    )

    qid2 = sq.queue_skill("unproven.skill", "VERSION TWO\n")
    result = sq.decide(qid2, "APPROVE")

    monkeypatch.setattr(skill_publisher, "is_published", original_is_published)
    monkeypatch.setattr(
        skill_publisher, "restore_retained_projection", original_restore_projection
    )

    assert result["ok"] is False
    # The forbidden shape from the review: retryable True + status pending
    # while the projection is unproven and governance was reverted mid-way.
    assert not (result.get("retryable") is True and result.get("status") == "pending"), (
        f"decide() reported the ordinary retryable-pending shape while the "
        f"published projection is unproven: {result}"
    )
    assert result["code"] == "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT"

    # Governance itself must be conservative (back at the first digest).
    store = governed_skills._store()
    active = store.get_active("unproven.skill")
    assert active is not None
    assert active["digest"] == first_digest


# ---------------------------------------------------------------------------
# 5. verify() failure -> same restore + reinvalidate guarantee.
# ---------------------------------------------------------------------------


def test_verify_failure_restores_exact_prior_projection(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()

    first = governed_skills.install_approved_skill("verifyfail.skill", "GOOD VERSION\n")
    prior_bytes = Path(first["publishedPath"], "SKILL.md").read_bytes()

    import mcp_wrapper.governed_skills as gs

    # Force is_published() to report False -- simulating a verify() step
    # that catches a real discrepancy. `_already_active_and_published`'s
    # idempotency short-circuit never calls is_published for this skill
    # (the digest differs, so it fails the `active digest == this digest`
    # check first), so the very first call for "verifyfail.skill" is
    # genuinely the coordinator's `_verify` step -- flip it directly rather
    # than counting calls.
    original_is_published = skill_publisher.is_published

    def flaky_is_published(skill_id):
        if skill_id == "verifyfail.skill":
            return False
        return original_is_published(skill_id)

    monkeypatch.setattr(skill_publisher, "is_published", flaky_is_published)

    with pytest.raises(SkillActivationCoordinationError):
        gs.install_approved_skill("verifyfail.skill", "BAD VERSION\n")

    monkeypatch.setattr(skill_publisher, "is_published", original_is_published)

    store = gs._store()
    active = store.get_active("verifyfail.skill")
    assert active["digest"] == first["digest"]
    restored_bytes = Path(first["publishedPath"], "SKILL.md").read_bytes()
    assert restored_bytes == prior_bytes


# ---------------------------------------------------------------------------
# 6. First-time activation failure leaves NOTHING published.
# ---------------------------------------------------------------------------


def test_first_time_activation_failure_leaves_nothing_published(monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()

    store = governed_skills._store()
    original_save_state = store._save_state
    # _save_state is called once by approve() before the coordinator even
    # starts; only the SECOND call (activate()'s, inside the coordinator's
    # commit() step) must fail, or this never reaches the coordinator at all.
    calls = {"n": 0}

    def crash_second_save_state(state):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise RuntimeError("boom")
        return original_save_state(state)

    monkeypatch.setattr(store, "_save_state", crash_second_save_state)

    with pytest.raises(SkillActivationCoordinationError):
        governed_skills.install_approved_skill("neverexisted.skill", "x\n")

    monkeypatch.setattr(store, "_save_state", original_save_state)

    assert "neverexisted.skill" not in _real_loader_ids()
    assert not skill_publisher.is_published("neverexisted.skill")
    assert store.get_active("neverexisted.skill") is None
    published_root = skill_publisher.published_skills_dir()
    if published_root.exists():
        assert not (published_root / "neverexisted.skill").exists()


# ---------------------------------------------------------------------------
# 7. Restart after a failed coordinated activation CANNOT silently complete
#    it -- construct a FRESH VerifiedSkillStore and assert.
# ---------------------------------------------------------------------------


def test_restart_after_failed_activation_does_not_silently_complete(monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()

    store = governed_skills._store()
    original_save_state = store._save_state
    calls = {"n": 0}

    def crash_second_save_state(state):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise RuntimeError("boom")
        return original_save_state(state)

    monkeypatch.setattr(store, "_save_state", crash_second_save_state)
    with pytest.raises(SkillActivationCoordinationError):
        governed_skills.install_approved_skill("restart-check.skill", "x\n")

    # Simulate a process restart: construct a completely fresh store handle
    # against the same on-disk root, independent of the module-level
    # singleton (which still holds the crashing monkeypatch).
    fresh = VerifiedSkillStore(store.root)
    assert fresh.get_active("restart-check.skill") is None
    assert list(fresh.transactions_dir.glob("*.json")) == []


# ---------------------------------------------------------------------------
# 8. Approval remains usable after a failure where appropriate.
# ---------------------------------------------------------------------------


def test_approval_remains_usable_after_publish_failure(tmp_path, monkeypatch):
    """A failure in publish() (before any governed commit happens) must not
    consume anything -- the whole coordinator transaction never started, so
    an explicit retry with a fresh install_approved_skill call for the exact
    same content must succeed."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()

    real_publish = skill_publisher.publish_skill
    call_count = {"n": 0}

    def flaky_publish(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("simulated publish failure")
        return real_publish(*args, **kwargs)

    monkeypatch.setattr(skill_publisher, "publish_skill", flaky_publish)

    with pytest.raises(Exception):
        governed_skills.install_approved_skill("retry-me.skill", "content\n")

    # Retry (a fresh install_approved_skill call, exactly what skill_queue's
    # pending-row retry does) succeeds.
    result = governed_skills.install_approved_skill("retry-me.skill", "content\n")
    assert result["ok"] is True
    assert "retry-me.skill" in _real_loader_ids()


# ---------------------------------------------------------------------------
# 9. Successful activation is visible to a FRESH REAL Hermes loader.
# ---------------------------------------------------------------------------


def test_success_visible_to_fresh_real_loader_never_file_existence_only(monkeypatch):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()

    result = governed_skills.install_approved_skill("fresh-loader.skill", "Body.\n")
    assert result["ok"] is True

    # A totally fresh call into the real upstream index scan.
    from agent.skill_utils import get_all_skills_dirs, iter_skill_index_files

    matches = []
    for d in get_all_skills_dirs():
        d = Path(d)
        if d.is_dir():
            matches.extend(iter_skill_index_files(d, "SKILL.md"))
    matching_ids = [Path(m).parent.name for m in matches if Path(m).parent.name == "fresh-loader.skill"]
    assert len(matching_ids) == 1


# ---------------------------------------------------------------------------
# 10. Mid-transaction loader scan yields EXACTLY ONE match for the skill.
# ---------------------------------------------------------------------------


def test_mid_transaction_loader_scan_yields_exactly_one_match(tmp_path, monkeypatch):
    """This is what makes finding #4 (the stale .torqclaw-doomed-* winner)
    durable against future refactors: at every point where the real loader
    could observe the published tree, including WHILE a replacement
    transaction is in flight (captured via a publish() spy that scans
    before returning), there is exactly one SKILL.md for this skill id --
    never zero, never two."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    governed_skills._reset_for_test()

    first = governed_skills.install_approved_skill("onematch.skill", "v1\n")
    assert first["ok"] is True

    from agent.skill_utils import get_all_skills_dirs, iter_skill_index_files

    def scan_count() -> int:
        count = 0
        for d in get_all_skills_dirs():
            d = Path(d)
            if not d.is_dir():
                continue
            for f in iter_skill_index_files(d, "SKILL.md"):
                if Path(f).parent.name == "onematch.skill":
                    count += 1
        return count

    assert scan_count() == 1

    real_publish = skill_publisher.publish_skill
    observed_counts = []

    def spying_publish(*args, **kwargs):
        result = real_publish(*args, **kwargs)
        # Immediately after publish() (new version live, retained copy
        # parked OUTSIDE the loadable tree), the real loader must see
        # exactly one match -- never the new AND a stale retained copy.
        observed_counts.append(scan_count())
        return result

    monkeypatch.setattr(skill_publisher, "publish_skill", spying_publish)

    second = governed_skills.install_approved_skill("onematch.skill", "v2\n")
    assert second["ok"] is True
    assert observed_counts == [1]
    assert scan_count() == 1
    assert Path(second["publishedPath"], "SKILL.md").read_text(encoding="utf-8") == "v2\n"


# ---------------------------------------------------------------------------
# 11. Concurrent APPROVE on the same queue item does not double-activate.
# ---------------------------------------------------------------------------


def test_concurrent_approve_on_same_queue_item_does_not_double_activate(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()

    qid = sq.queue_skill("racy.skill", "Racy content.\n")

    results = []
    results_lock = threading.Lock()

    def attempt():
        result = sq.decide(qid, "APPROVE")
        with results_lock:
            results.append(result)

    threads = [threading.Thread(target=attempt) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    successes = [r for r in results if r.get("ok") and r.get("governed")]
    already = [r for r in results if not r.get("ok") and "already" in str(r.get("error", ""))]

    assert len(successes) == 1, f"expected exactly one successful activation, got {results}"
    assert len(already) == len(threads) - 1

    # Exactly one governed-active digest, exactly one published copy.
    store = governed_skills._store()
    assert store.get_active("racy.skill") is not None
    matches = [p for p in _real_loader_ids() if p == "racy.skill"]
    assert len(matches) == 1


# ---------------------------------------------------------------------------
# 12. Success-side crash: digest already active+published -> retry
#     reconciles the row instead of re-activating.
# ---------------------------------------------------------------------------


def test_success_side_crash_retry_reconciles_instead_of_reactivating(
    tmp_path, monkeypatch
):
    """Simulates: activation fully committed and published, but the process
    died before skill_queue recorded 'approved' (row still 'pending').
    A retry with the exact same (skill_id, markdown) must NOT create a
    second, divergent activation -- it must recognise the digest is already
    active+published and reconcile cleanly."""
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    sq = _fresh_queue(monkeypatch, tmp_path)
    governed_skills._reset_for_test()

    qid = sq.queue_skill("crash-recover.skill", "Idempotent content.\n")

    # First call succeeds for real.
    first = sq.decide(qid, "APPROVE")
    assert first["ok"] is True
    first_digest = first["digest"]

    # Simulate the row never having been flipped (the "process died before
    # recording success" case) by resetting it back to pending directly.
    with sq._lock:
        sq._conn.execute(
            "UPDATE skill_queue SET status='pending' WHERE queue_id=?", (qid,)
        )
        sq._conn.commit()

    # Spy on the store's activate() to prove the retry does NOT call it again.
    store = governed_skills._store()
    activate_calls = []
    original_activate = store.activate

    def spying_activate(*args, **kwargs):
        activate_calls.append(1)
        return original_activate(*args, **kwargs)

    monkeypatch.setattr(store, "activate", spying_activate)

    retried = sq.decide(qid, "APPROVE")
    assert retried["ok"] is True
    assert retried["digest"] == first_digest
    assert retried.get("reconciledFromPriorSuccess") is True
    assert activate_calls == [], "retry must not re-activate an already-landed digest"

    draft = sq.get_draft(qid)
    assert draft["status"] == "approved"
