"""Runtime safety primitives for skill mutations that must never race a live
Hermes agent.

The invariant this module exists to uphold: TORQCLAW must never report a
skill activation, rollback, or publication as effective while a running
Hermes agent can still hold the superseded skill prompt, and cache
invalidation must fail closed if TORQCLAW cannot prove it occurred.

Scope (P2-1g): runtime safety primitives only. Nothing in this module
publishes a skill, writes to ``skills.external_dirs``, or changes activation.
A future activation pipeline is expected to sequence its transaction through
:func:`skill_mutation_transaction` so that quiescence, cache invalidation,
and the mutation itself cannot be reordered or split apart.

Scope (P2-1g.1): closes the run-admission TOCTOU gap left open above.
:func:`skill_mutation_transaction` asserts ``RUNNING == {}`` on entry, but
until this ticket nothing made a *new* Hermes run's construction and
``RUNNING`` registration observe that same lock. A run could start strictly
between the quiescence check and the mutation body, or between the mutation
body and cache invalidation, and neither side would detect the other: both
behave correctly in isolation, but the invariant ("no live agent can hold a
superseded skill prompt") still breaks. :func:`hermes_run_admission` closes
this by making Hermes startup acquire the identical ``_MUTATION_LOCK`` around
construction + registration only -- never around ``run_conversation`` -- so
existing concurrent Hermes runs are not serialized for their lifetimes, only
the narrow admission window is fenced against an in-flight mutation.

Placement rationale
--------------------
This is deliberately a new module, not an addition to
``verified_skill_store.py``:

- ``verified_skill_store.VerifiedSkillStore`` owns package digests, staged
  installs, and approval bookkeeping under its own ``self._lock``. None of
  that needs to know about the live Hermes process registry.
- The quiescence authority (``hermes_runner.RUNNING``) and the cache
  invalidation authority (vendored ``agent.prompt_builder``) are both
  runtime/process concerns, orthogonal to on-disk package state. Bundling
  them into the store would force every store consumer (including tests
  that only exercise digest/approval logic and have no Hermes runtime at
  all) to reason about the live-agent registry and the vendored import path.
- Keeping this as its own module lets a future activation pipeline compose
  ``VerifiedSkillStore`` mutations *inside* this module's transaction lock
  (see ``skill_mutation_transaction``) without ``verified_skill_store.py``
  ever importing runtime state, and without this module importing package
  storage internals. Each module stays independently testable.

Import-cycle note
------------------
This module never imports ``hermes_runner`` at module scope -- only lazily,
inside :func:`assert_skill_runtime_quiescent` and (as of P2-1g.1)
:func:`hermes_run_admission`, exactly the pattern already used by
``server.py`` (``from .hermes_runner import RUNNING`` inside request
handlers, not at module load).

As of P2-1g.1, ``hermes_runner.py`` DOES import this module, at module
scope (``from . import runtime_quiescence``), to call
:func:`hermes_run_admission` before constructing ``AIAgent``. That is safe
precisely because the reverse edge never exists at module scope: this
module's only module-scope internal import is ``from .verified_skill_store
import SkillStoreError``, and ``verified_skill_store.py`` imports nothing
from this package. So the import graph is
``hermes_runner -> runtime_quiescence -> verified_skill_store``, a DAG with
no back edge -- ``runtime_quiescence`` importing ``hermes_runner`` eagerly
would create the cycle, so it doesn't, ever. The lazy imports inside the two
functions above exist so that if some *third* module someday imports
``runtime_quiescence`` before ``hermes_runner`` has finished initializing,
resolution is still deferred to call time rather than import time.

Similarly, the vendored ``agent.prompt_builder`` module is only ever
imported lazily inside :func:`invalidate_skill_prompt_cache`, matching the
existing lazy-vendor-import convention in ``hermes_runner.py`` (e.g.
``from agent.account_usage import fetch_account_usage``) and
``approval_hook.py`` (``from hermes_cli.plugins import get_plugin_manager``).

Activation coordinator (P2-1g.1)
---------------------------------
``skill_mutation_transaction`` alone is not sufficient to safely sequence a
skill *activation*. ``VerifiedSkillStore.activate()`` already does
everything -- installs the version, flips ``state["active"]``, consumes the
approval, appends the audit record, and calls ``_save_state`` -- before it
returns. A caller that wrapped it naively::

    with skill_mutation_transaction():
        store.activate(staged, approval)

would let governance claim ACTIVE, consume the approval, and write the audit
trail *before* the cache is ever invalidated on the transaction's exit. If
invalidation then fails, the store already claims the skill is active while
a live agent could still hold the superseded prompt -- exactly the outcome
this whole module exists to prevent. Moving the commit to after the
``with`` block is equally wrong: the lock has released by then, and a new
Hermes run could be admitted before governance state is actually committed.

:class:`ActivationCoordinator` (via :func:`run_activation_transaction`) is
the primitive a future activation pipeline uses instead. It takes four
callbacks -- ``publish``, ``restore``, ``commit``, ``verify`` -- and holds
ONE lock acquisition across all of::

    LOCK -> QUIESCENCE -> publish() -> invalidate cache -> commit()
         -> verify() -> UNLOCK

with ``restore()`` invoked, still under the lock, on any failure from
``invalidate cache`` onward -- so a failed cache clear or a failed
``commit()`` never leaves the external projection in its new (published)
state while governance still claims the old one, and never consumes an
approval or claims ACTIVE for a mutation that did not fully verify. This
ticket adds no caller: no ``skills.external_dirs`` publisher exists yet, and
:func:`ActivationCoordinator.run` deliberately does not call
``VerifiedSkillStore.activate()`` itself (see the class docstring) so that
``activate()`` remains untouched and usable standalone, as it is today.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

from .verified_skill_store import SkillStoreError

__all__ = [
    "SkillRuntimeBusyError",
    "SkillPromptInvalidationError",
    "SkillActivationCoordinationError",
    "assert_skill_runtime_quiescent",
    "invalidate_skill_prompt_cache",
    "skill_mutation_transaction",
    "hermes_run_admission",
    "ActivationCoordinator",
    "run_activation_transaction",
]


class SkillRuntimeBusyError(SkillStoreError):
    """A skill mutation cannot safely become effective while Hermes runs exist.

    This is an operator-facing capacity/timing condition, not corruption and
    not an activation failure: no skill state was touched. Callers must not
    auto-queue or auto-retry on this error; it is the caller's job to surface
    it plainly (e.g. "Skill change waiting for active Hermes work to finish.
    No skill state was changed.") and let the operator decide when to retry.
    """


class SkillPromptInvalidationError(SkillStoreError):
    """TORQCLAW could not prove Hermes skill-prompt invalidation succeeded.

    Raised when the vendored cache-clear entry point is missing or raises.
    There is deliberately no fallback path (no signalling, no restart, no
    disk-snapshot deletion): if invalidation cannot be proven, the mutation
    that depends on it must fail closed.
    """


class SkillActivationCoordinationError(SkillStoreError):
    """An :class:`ActivationCoordinator` transaction could not complete, and
    (when the failure occurred at or after ``publish``) restoration of the
    prior external projection was attempted before this was raised.

    This always means: the governed active state was NOT changed, no
    approval was consumed, and (if ``publish`` had already run)
    ``restore`` was called and completed under the same lock before
    admission of new Hermes runs could resume. The original underlying
    exception is chained via ``__cause__``. If ``restore`` itself also
    failed, that is re-raised directly instead (see
    :class:`ActivationCoordinator.run`) precisely because at that point
    TORQCLAW can no longer prove which projection is live, which is a more
    severe condition than an ordinary coordination failure.
    """


# One process-wide mutation lock covering quiescence assertion AND cache
# invalidation together. Two skill activations must not both observe
# RUNNING == {} and then race each other through cache invalidation; holding
# a single lock across both steps (see skill_mutation_transaction) is what
# makes that race impossible rather than merely unlikely.
_MUTATION_LOCK = threading.RLock()


def assert_skill_runtime_quiescent() -> None:
    """Raise :class:`SkillRuntimeBusyError` unless zero Hermes runs are live.

    Quiescence is defined purely as ``hermes_runner.RUNNING`` being empty.
    This is deliberately conservative and coarse: a skill directory/cache
    change modifies a global prompt-building substrate shared by every
    running agent, so there is no such thing as an individual running agent
    that is "unaffected" by it. Per-run generations/epochs that could narrow
    this are explicitly out of scope for this ticket.

    WebSocket/session/UI state is irrelevant here on purpose: only the
    actual live-agent registry counts as "running."
    """
    # Lazy import: see the module docstring's "Import-cycle note". This
    # mirrors server.py's existing `from .hermes_runner import RUNNING`
    # inside request handlers rather than importing hermes_runner at module
    # scope, so this module never participates in hermes_runner's import
    # order.
    from .hermes_runner import RUNNING

    if len(RUNNING) > 0:
        raise SkillRuntimeBusyError(
            "skill mutation blocked while Hermes tasks are running "
            f"({len(RUNNING)} active); no skill state was changed"
        )


def invalidate_skill_prompt_cache() -> None:
    """Clear the in-process Hermes skills system-prompt cache, or fail closed.

    Calls the real upstream ``agent.prompt_builder.clear_skills_system_prompt_cache``
    with ``clear_snapshot=False``. Never falls back to deleting the on-disk
    snapshot, signalling another process, or restarting Hermes: if the
    upstream entry point cannot be imported, or raises, this function raises
    a typed :class:`SkillPromptInvalidationError` instead of silently
    continuing.
    """
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache  # type: ignore
    except Exception as exc:
        raise SkillPromptInvalidationError(
            "could not import agent.prompt_builder.clear_skills_system_prompt_cache "
            "from the vendored Hermes agent; refusing to proceed without proof "
            "of cache invalidation"
        ) from exc

    try:
        clear_skills_system_prompt_cache(clear_snapshot=False)
    except Exception as exc:
        raise SkillPromptInvalidationError(
            "agent.prompt_builder.clear_skills_system_prompt_cache raised; "
            "skill-prompt invalidation could not be proven to have occurred"
        ) from exc


@contextmanager
def skill_mutation_transaction() -> Iterator[None]:
    """Hold the one process-wide skill-mutation lock across the whole
    quiescence-check-through-cache-invalidation sequence.

    This is the API a future activation pipeline must use. It enforces the
    required ordering::

        acquire lock -> assert RUNNING == {} -> [caller body: validate,
        mutate] -> invalidate -> release

    Both bookends are STRUCTURAL, not advisory:

    - Quiescence is asserted on entry, before the caller's body runs. There
      is no way to hold this lock and skip the check: a caller that enters
      the block has already passed it, and one that fails never enters.
    - Cache invalidation runs on normal exit, before the lock releases. The
      caller cannot "forget" it, and cannot defer it to post-success
      cleanup after the lock is gone.
    - If the body raises, invalidation is deliberately SKIPPED and the
      exception propagates. That is the fail-closed direction: a mutation
      that did not complete must not report a cleared cache, and the caller
      must not declare the mutation effective. A future activation pipeline
      is responsible for restoring the filesystem to its prior governed
      state on that path before reporting failure.
    - The lock is acquired once, for the whole block. There is no separate
      "just clear the cache" lock exposed anywhere, so the lock-scope
      sabotage (serializing only the cache clear) is not expressible.

    Caller shape::

        with skill_mutation_transaction():
            ... validate ...
            ... mutate package store state ...
            ... verify / commit / mark effective ...
        # quiescence already asserted on entry; cache invalidated on exit

    Do NOT call :func:`assert_skill_runtime_quiescent` or
    :func:`invalidate_skill_prompt_cache` yourself inside the block -- the
    transaction owns both. They remain public only so they can be tested
    and reasoned about independently.

    This ticket adds no caller (no publish step, no activation change): the
    context manager exists so the future P2-1 activation pipeline inherits
    an ordering it cannot bypass.
    """
    with _MUTATION_LOCK:
        assert_skill_runtime_quiescent()
        yield
        # Normal exit only: a raising body skips this on purpose (see above).
        invalidate_skill_prompt_cache()


@contextmanager
def hermes_run_admission() -> Iterator[None]:
    """Fence a new Hermes run's construction + ``RUNNING`` registration
    against an in-flight skill mutation, on the SAME ``_MUTATION_LOCK`` that
    :func:`skill_mutation_transaction` uses.

    This closes the run-admission TOCTOU gap (P2-1g.1): without this fence,
    ``hermes_runner.run_hermes_sync`` could construct an ``AIAgent`` and
    write ``RUNNING[task_id] = agent`` with zero coordination with a
    concurrent skill mutation. Both a mutation "publish -> invalidate" and a
    run's "construct -> register" are individually correct; interleaved
    without a shared lock, a run can slip into existence in the window
    between a mutation's quiescence check and its cache invalidation, and
    then hold the superseded skill prompt forever -- exactly the invariant
    :func:`skill_mutation_transaction` exists to protect.

    Caller shape (see ``hermes_runner.run_hermes_sync``)::

        with hermes_run_admission():
            agent = AIAgent(...)
            _suppress_skill_nudge(agent)
            RUNNING[task_id] = agent
        # lock already released here; run_conversation() runs OUTSIDE the
        # fence so concurrent ordinary Hermes tasks are not serialized.

    Deliberately narrow -- consequences that must hold:

    - A run that starts admission first (acquires the lock before any
      mutation attempts to) makes a LATER mutation attempt fail busy: the
      run's presence in ``RUNNING`` is committed before the lock releases,
      so ``assert_skill_runtime_quiescent()`` -- called under the same lock
      by whichever side asks for it next -- will see it.
    - A mutation in progress (already holding the lock via
      ``skill_mutation_transaction``) makes a NEW run's admission block
      until the mutation releases the lock, rather than let construction and
      registration interleave with an in-flight cache invalidation.
    - The fence covers ONLY construction + registration. It must never be
      held across ``agent.run_conversation(...)`` -- doing so would
      serialize the full lifetime of every Hermes run behind this one lock,
      collapsing "multiple concurrent Hermes runs" (each running on its own
      thread via ``asyncio.to_thread``) into one-at-a-time execution. This
      is exactly the kind of over-fencing the required test suite's
      "hold the fence across run_conversation" sabotage is designed to
      catch: it must break concurrent-task testing when applied, which
      proves this docstring's scope claim is actually enforced by the call
      site, not just asserted here.
    - ``_MUTATION_LOCK`` is an ``RLock``, so a mutation body that itself
      needed to admit a run (not a shape any current caller uses) would not
      deadlock against its own thread -- but ordinary contention between a
      run on one thread and a mutation on another still blocks correctly,
      because RLock reentrancy only waives the wait for the SAME thread that
      already holds it.
    """
    with _MUTATION_LOCK:
        yield


@dataclass(frozen=True)
class ActivationCoordinator:
    """Sequences a skill activation's external projection, cache
    invalidation, and governance commit under ONE lock hold, so that
    "cache invalidated" and "governance claims active" can never be
    observed out of order, and a failure after publication always restores
    the prior projection before any of the lock, the approval, or the
    active-state claim moves.

    This class does NOT call :func:`verified_skill_store.VerifiedSkillStore
    .activate`. Wedging that method in unchanged is explicitly out of scope
    (P2-1g.1): ``activate()`` performs governance commit, approval
    consumption, and audit as one inseparable step, with no way to run only
    the "commit" half after this coordinator's ``publish`` step. Instead,
    the caller supplies four callbacks that a future activation pipeline
    implements once the ``skills.external_dirs`` publisher exists:

    - ``publish() -> Any``: Make the new skill version live in whatever
      external projection Hermes reads from. Do the minimum needed for a
      freshly-admitted Hermes run to observe the NEW skill; nothing here may
      be assumed durable/committed yet. Its return value (e.g. a snapshot of
      what was replaced) is passed to ``restore`` if anything downstream
      fails.
    - ``restore(publish_result) -> None``: Undo exactly what ``publish``
      did, using the value ``publish`` returned. Called ONLY if a later
      step fails, and always while ``_MUTATION_LOCK`` is still held.
    - ``commit() -> Any``: Perform the governed state change -- e.g. the
      digest install, ``state["active"]`` flip, approval consumption, and
      audit append that ``VerifiedSkillStore.activate()`` bundles today.
      Runs strictly AFTER cache invalidation succeeds.
    - ``verify(commit_result) -> None``: Confirm the commit is actually
      readable/consistent (e.g. re-read governed state) before the
      transaction is allowed to report success. Raising here is treated
      exactly like a ``commit`` failure: ``restore`` still runs.

    Ordering enforced by :meth:`run`, all inside one ``_MUTATION_LOCK``
    acquisition::

        LOCK -> assert_skill_runtime_quiescent()
             -> publish()
             -> invalidate_skill_prompt_cache()
             -> commit()
             -> verify(commit_result)
             -> UNLOCK (success)

    On any exception from ``invalidate_skill_prompt_cache()`` onward::

        publish() already ran -> restore(publish_result)
             -> UNLOCK, then raise SkillActivationCoordinationError
               (original exception chained as __cause__)

    If ``publish()`` itself raises, there is nothing to restore (the
    external projection was never touched), so the lock releases
    immediately and the original exception propagates unchanged --
    ``assert_skill_runtime_quiescent`` already ran, so no Hermes run was
    ever at risk.

    If ``restore()`` itself raises, that exception is NOT swallowed or
    wrapped in ``SkillActivationCoordinationError``: it is allowed to
    propagate as-is (from inside the ``finally``-equivalent restoration
    path, chained onto the original failure) and the lock is held for the
    entire duration of that attempt -- new Hermes runs must not be admitted
    while TORQCLAW cannot prove which projection is actually live. See
    :meth:`run` for exactly how the lock's release is sequenced after
    restoration.
    """

    publish: Callable[[], Any]
    restore: Callable[[Any], None]
    commit: Callable[[], Any]
    verify: Callable[[Any], None]

    def run(self) -> Any:
        """Execute the full LOCK -> QUIESCENCE -> ... -> UNLOCK sequence.

        Returns the ``commit`` step's return value on success -- the governed
        result the caller cares about. ``verify`` runs after ``commit`` and its
        return value is deliberately discarded: it is a check, not a product.
        Raises :class:`SkillActivationCoordinationError` if any
        step from ``publish`` onward fails and restoration (when
        attempted) completed; re-raises a raw exception if ``publish``
        itself failed (nothing to restore) or if ``restore`` itself failed
        (unknown projection state -- see class docstring).
        """
        with _MUTATION_LOCK:
            assert_skill_runtime_quiescent()

            publish_result = self.publish()
            # From here on, the external projection has changed. Any
            # failure below MUST restore it before this function returns,
            # and the restoration itself must complete before the lock
            # (held for this entire `with` block) is released, so no new
            # Hermes run is admitted against an unknown/half-migrated
            # projection.
            try:
                invalidate_skill_prompt_cache()
                commit_result = self.commit()
                self.verify(commit_result)
            except Exception as exc:
                # Restoration runs BEFORE this function returns/raises, and
                # therefore before `with _MUTATION_LOCK` releases -- see
                # the class docstring's ordering guarantee. A restore()
                # failure is intentionally NOT caught here: it propagates
                # as-is (chained onto `exc` for diagnostic context), still
                # inside the lock, so the lock is only ever released once
                # either restoration has verifiably completed or the
                # caller has an unambiguous signal that it did not.
                try:
                    self.restore(publish_result)
                except Exception as restore_exc:
                    raise restore_exc from exc
                raise SkillActivationCoordinationError(
                    "skill activation could not be committed after its "
                    "external projection was published; the prior "
                    "projection was restored and no governed state was "
                    "changed"
                ) from exc
            return commit_result


def run_activation_transaction(
    *,
    publish: Callable[[], Any],
    restore: Callable[[Any], None],
    commit: Callable[[], Any],
    verify: Callable[[Any], None],
) -> Any:
    """Functional convenience wrapper: build an :class:`ActivationCoordinator`
    from four callbacks and immediately :meth:`~ActivationCoordinator.run`
    it. Prefer this for one-shot callers; construct
    :class:`ActivationCoordinator` directly when a caller wants to hold onto
    the callback bundle (e.g. to retry with the same callbacks) without
    re-threading four separate arguments.
    """
    return ActivationCoordinator(
        publish=publish, restore=restore, commit=commit, verify=verify
    ).run()
