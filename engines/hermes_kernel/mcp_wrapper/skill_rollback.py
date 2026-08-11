"""Operator surface for governed skill rollback (GS-ROLLBACK).

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
"""
from __future__ import annotations

from typing import Any


def rollback(skill_id: str, digest: str) -> dict[str, Any]:
    """Roll ``skill_id`` back to the exact installed ``digest``.

    Success re-enables a disabled skill (``store.rollback()`` writes
    ``enabled: True`` unconditionally -- there is no governed disable
    surface yet; that lane is GS-DISABLE).
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
    except governed_skills.GovernedSkillError as exc:
        # Invalid id / unknown digest: refused before any mutation.
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
