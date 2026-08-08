"""Governed skill installation -- the wiring between the live approval path
and the verified skill lifecycle.

WHY THIS MODULE EXISTS
----------------------
``skill_queue.decide()`` on APPROVE wrote the skill straight to disk::

    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(content)

No digest, no manifest, no approval binding, no audit trail, no rollback, and
no validation of the operator-supplied name (so ``../escape`` was a valid
"skill id"). Meanwhile ``VerifiedSkillStore`` (998 lines) and
``skill_publisher`` (557 lines) provided exactly those properties and were
reachable from no running program -- the repo's recurring defect: strong code
wired to nothing, passing its own unit tests the whole time.

This module is the missing seam. It bridges the impedance mismatch between
what the approval surface has (a name and raw markdown) and what the governed
store requires (a two-file package with a manifest), then runs the real
lifecycle: stage -> approve -> activate -> publish.

FLAG DEFAULT IS OFF, DELIBERATELY
---------------------------------
``TORQCLAW_GOVERNED_SKILLS`` defaults to disabled. Turning a new write path on
for every existing deployment without opt-in would be a behaviour change
smuggled in as a refactor. With the flag off, ``skill_queue`` keeps its
current behaviour byte for byte.

WHAT THIS DOES NOT DO
---------------------
It does not invoke ``ActivationCoordinator``/quiescence. Those guard against
mutating skills while an agent run is in flight, and wiring them is a separate
step with its own failure modes (see ``runtime_quiescence.py``). Publication
here is the same operation the operator already triggers by clicking approve.
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .verified_skill_store import VerifiedSkillStore, file_digest


class GovernedSkillError(Exception):
    """A skill could not be installed through the governed pipeline."""


#: A skill id must be a single safe path segment. The legacy path did
#: ``SKILLS_DIR / name`` with no validation, so "../escape" wrote outside the
#: skills tree entirely.
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

_TRUTHY = {"1", "true", "yes", "on"}

_STORE: VerifiedSkillStore | None = None


def enabled() -> bool:
    """Whether the governed pipeline handles skill approval.

    Defaults to False so existing deployments keep their current behaviour
    until an operator opts in.
    """
    return os.environ.get("TORQCLAW_GOVERNED_SKILLS", "").strip().lower() in _TRUTHY


def _data_dir() -> Path:
    return Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw")


def _store() -> VerifiedSkillStore:
    """Process-wide store handle, resolved lazily.

    Resolved on first use rather than at import so tests (and an operator
    changing TORQCLAW_DATA_DIR) are not captured by import order -- the same
    trap that made the external-dirs cache bite in P2-1a.
    """
    global _STORE
    if _STORE is None:
        _STORE = VerifiedSkillStore(_data_dir() / "verified_skills")
    return _STORE


def _reset_for_test() -> None:
    """Drop the cached store handle. Test-only."""
    global _STORE
    _STORE = None


def _validate_id(skill_id: str) -> str:
    candidate = (skill_id or "").strip()
    if not _SAFE_ID.match(candidate):
        raise GovernedSkillError(
            f"invalid skill id {skill_id!r}: must be a single path segment of "
            "letters, digits, dot, underscore or hyphen (max 128 chars)"
        )
    if candidate in {".", ".."}:
        raise GovernedSkillError(f"invalid skill id {skill_id!r}")
    return candidate


def _build_package(root: Path, skill_id: str, markdown: str) -> Path:
    """Materialise the two-file package shape the store requires.

    The approval surface has a name and markdown; the store needs a manifest
    with a content digest. Building it here keeps that translation in one
    place instead of spreading manifest knowledge across callers.
    """
    package = root / "package"
    package.mkdir(parents=True)
    skill_bytes = markdown.encode("utf-8")
    manifest = {
        "schemaVersion": 1,
        "id": skill_id,
        "version": "1.0.0",
        "name": skill_id,
        "description": f"Operator-approved skill {skill_id}",
        "source": "torqclaw:operator-approval",
        "files": {"SKILL.md": file_digest(skill_bytes)},
        "requiredCapabilities": ["read"],
        "compatibleProfiles": ["default"],
    }
    import json

    (package / "skill.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (package / "SKILL.md").write_bytes(skill_bytes)
    return package


def install_approved_skill(skill_id: str, markdown: str) -> dict[str, Any]:
    """Install an operator-approved skill through the governed lifecycle.

    stage -> approve -> activate -> publish. Each step is the real
    ``VerifiedSkillStore`` / ``skill_publisher`` implementation, so the result
    is digest-bound, audited, rollback-capable, and -- critically -- verified
    discoverable by the actual Hermes loader rather than merely written to a
    directory we hope is the right one.

    Raises ``GovernedSkillError`` on an invalid id; propagates the store's own
    typed errors otherwise. Nothing is published if any step fails.
    """
    from . import skill_publisher

    sid = _validate_id(skill_id)
    store = _store()

    workspace = Path(tempfile.mkdtemp(prefix=".torqclaw-governed-", dir=_data_dir()))
    try:
        package = _build_package(workspace, sid, markdown)
        staged = store.stage(package)
        # confirm_permission_delta: the operator already approved this skill on
        # the console. The capability set is fixed at ["read"] by _build_package,
        # so there is no hidden escalation being waved through here.
        approval = store.approve(staged, confirm_permission_delta=True)
        store.activate(staged, approval)

        digest = staged["digest"]
        installed_dir = store.versions_dir / sid / digest
        published = skill_publisher.publish_skill(
            installed_dir, digest=digest, source="torqclaw:operator-approval"
        )
        return {
            "ok": True,
            "skillId": sid,
            "digest": digest,
            "publishedPath": published["path"],
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
