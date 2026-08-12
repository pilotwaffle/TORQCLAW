"""Operator surface for governed skill rollback (GS-ROLLBACK) and disable
(GS-DISABLE).

GS-ACCEPT finding F-1: ``VerifiedSkillStore.rollback()`` existed with no
production caller -- the unenforced-claim pattern -- and moved governance
without re-publishing the prior projection, so a "rolled back" skill kept
being served to the model. The kernel half of the fix is
``governed_skills.rollback_governed_skill`` (projection + cache + governance
move together through ``ActivationCoordinator``); this module is the
reachability half: the dict-shaped, never-raising functions the MCP server
exposes to the gateway, mirroring how ``skill_queue.decide()`` is the
reachable surface for install.

Deliberately queue-free: a rollback has no ``skill_queue`` row, so results
here never carry the queue's ``"status"`` field
(``governed_skills.map_activation_failure`` omits it when
``queue_status=None``).

There is NO legacy fallback. When governance is off, rollback refuses --
the legacy path has no digests, so "roll back to a digest" is meaningless
there and silently writing files would repeat the exact defect class the
governed path exists to close.

GS-DISABLE adds :func:`disable`, closing the other half of GS-ACCEPT step 9
("roll back / disable"). ``VerifiedSkillStore.disable()`` had the identical
defect shape F-1 found in ``rollback()``: governance-only, no production
caller, so a "disabled" skill kept being rendered into every system prompt.
The kernel half is ``governed_skills.disable_governed_skill``; this module
is again the reachability half.
"""
from __future__ import annotations

from typing import Any


def rollback(skill_id: str, digest: str) -> dict[str, Any]:
    """Roll ``skill_id`` back to the exact installed ``digest``.

    Success re-enables a disabled skill (``store.rollback()`` writes
    ``enabled: True`` unconditionally). As of GS-DISABLE that is not an
    accident to be documented around but the DESIGNED inverse of
    :func:`disable`: re-enabling is a digest-bound rollback to the version
    the operator wants back, so there is deliberately no separate enable
    surface that would have to guess a digest.
    """
    from . import governed_skills

    if not governed_skills.enabled():
        return {
            "ok": False,
            "code": "GOVERNED_SKILLS_DISABLED",
            "retryable": False,
            "error": (
                "Governed skills are disabled (TORQCLAW_GOVERNED_SKILLS is "
                "not set). Rollback only exists for governed, digest-bound "
                "skills; the legacy path has no versions to roll back to."
            ),
        }

    from .verified_skill_store import SkillApprovalError

    try:
        return governed_skills.rollback_governed_skill(skill_id, digest)
    except governed_skills.GovernanceRevertedProjectionUnprovenError as exc:
        # MUST precede the GovernedSkillError arm below: this class EXTENDS
        # GovernedSkillError, and the coordinator propagates restore-callback
        # failures UNWRAPPED -- G2A round 1 reproduced the subclass being
        # swallowed by the invalid-target arm, machine-labelling the one
        # failure state that requires an operator to inspect disk before
        # retrying as a bad argument. Routed through the shared mapper so
        # the surface emits the same non-retryable
        # SKILL_PROJECTION_UNPROVEN_AFTER_REVERT code decide() does.
        return governed_skills.map_activation_failure(exc, queue_status=None)
    except governed_skills.GovernedSkillError as exc:
        # Invalid id / unknown digest: refused before any mutation. This arm
        # can only see the kernel's PRE-coordinator refusals -- a verify
        # failure's GovernedSkillError arrives wrapped in
        # SkillActivationCoordinationError and lands in the generic mapper
        # arm; the restore-path subclass is caught above.
        return {
            "ok": False,
            "code": "SKILL_ROLLBACK_INVALID_TARGET",
            "retryable": False,
            "error": str(exc),
        }
    except SkillApprovalError as exc:
        # The installed-but-never-active edge (G1R finding 6): the store
        # would demand a fresh approval even for the baseline ["read"]
        # capability. Mapped to its own code so the operator gets the real
        # remedy (re-approve through the install path) instead of a
        # misleading generic activation failure. Must precede the generic
        # mapper, whose catch-all arm would report it retryable.
        return {
            "ok": False,
            "code": "SKILL_ROLLBACK_TARGET_NEVER_ACTIVE",
            "retryable": False,
            "error": str(exc),
        }
    except Exception as exc:
        return governed_skills.map_activation_failure(exc, queue_status=None)


def disable(skill_id: str) -> dict[str, Any]:
    """Disable ``skill_id``: unpublish it and mark governance disabled, so a
    fresh agent boot no longer renders it (GS-DISABLE).

    Same dict shapes and error taxonomy as :func:`rollback` -- governed-only
    (no legacy fallback: the legacy path has no governed state to disable
    and silently deleting an operator's files would be a worse defect than
    refusing), never raising, and queue-free (no ``status`` key, because a
    disable has no ``skill_queue`` row).

    The inverse is :func:`rollback`, not a separate enable: rolling back to
    an exact digest re-enables and re-publishes it in one digest-bound
    transaction.
    """
    from . import governed_skills

    if not governed_skills.enabled():
        return {
            "ok": False,
            "code": "GOVERNED_SKILLS_DISABLED",
            "retryable": False,
            "error": (
                "Governed skills are disabled (TORQCLAW_GOVERNED_SKILLS is "
                "not set). Disable only exists for governed skills; the "
                "legacy path has no governed state to disable."
            ),
        }

    try:
        return governed_skills.disable_governed_skill(skill_id)
    except governed_skills.GovernanceRevertedProjectionUnprovenError as exc:
        # MUST precede the GovernedSkillError arm: this class EXTENDS
        # GovernedSkillError and the coordinator propagates restore-callback
        # failures UNWRAPPED, so an invalid-target arm placed first would
        # swallow it and machine-label the one must-inspect-disk failure as
        # a bad argument. That was GS-ROLLBACK's G2A round-1 BLOCKING
        # defect; the same ordering trap is reproduced verbatim here, and
        # is pinned by a surface-level test rather than a kernel one.
        return governed_skills.map_activation_failure(exc, queue_status=None)
    except governed_skills.GovernedSkillError as exc:
        # Invalid id / no governed-active entry: refused before any
        # mutation. Distinct code from rollback's because the operator
        # remedy differs -- there is nothing to disable, versus a bad
        # rollback digest.
        return {
            "ok": False,
            "code": "SKILL_DISABLE_INVALID_TARGET",
            "retryable": False,
            "error": str(exc),
        }
    except Exception as exc:
        return governed_skills.map_activation_failure(exc, queue_status=None)


def list_versions(skill_id: str) -> dict[str, Any]:
    """List rollback candidates for ``skill_id``: every installed version
    with ``installedAt`` and a ``tampered`` flag, plus the governed-active
    and published digests so divergence is visible. Read-only; available
    even while governance is off (the response carries
    ``governedSkillsEnabled`` so a console can grey out the rollback
    action).
    """
    from . import governed_skills

    try:
        return governed_skills.list_governed_versions(skill_id)
    except governed_skills.GovernedSkillError as exc:
        return {"ok": False, "error": str(exc)}
