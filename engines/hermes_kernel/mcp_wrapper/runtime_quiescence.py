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
``hermes_runner.py`` does not import this module, and this module does not
import ``hermes_runner`` at module scope. ``hermes_runner.RUNNING`` is
imported lazily, inside :func:`assert_skill_runtime_quiescent`, exactly the
pattern already used by ``server.py`` (``from .hermes_runner import
RUNNING`` inside request handlers, not at module load). This avoids forcing
an import order between the two modules; if a future patch adds a
module-level import of this module into ``hermes_runner.py`` (e.g. to call
into activation from inside a running task), the lazy import here is what
prevents that from becoming a circular import.

Similarly, the vendored ``agent.prompt_builder`` module is only ever
imported lazily inside :func:`invalidate_skill_prompt_cache`, matching the
existing lazy-vendor-import convention in ``hermes_runner.py`` (e.g.
``from agent.account_usage import fetch_account_usage``) and
``approval_hook.py`` (``from hermes_cli.plugins import get_plugin_manager``).
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from collections.abc import Iterator

from .verified_skill_store import SkillStoreError

__all__ = [
    "SkillRuntimeBusyError",
    "SkillPromptInvalidationError",
    "assert_skill_runtime_quiescent",
    "invalidate_skill_prompt_cache",
    "skill_mutation_transaction",
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
