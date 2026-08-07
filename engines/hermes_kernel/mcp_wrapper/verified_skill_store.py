"""Local, digest-addressed lifecycle for verified Hermes skills.

This module deliberately owns no remote trust policy and does not modify the
legacy ``skill_queue``.  A package is a directory containing exactly two
regular files: ``skill.json`` and ``SKILL.md``.  The raw manifest bytes and
skill bytes are bound into one SHA-256 package digest.  Approval and every
activation operation are bound to that exact digest and permission set.

The store uses immutable ``versions/<skill-id>/<digest>`` directories and an
atomic JSON state file.  A small transaction journal makes an interrupted
copy/activation recoverable on the next construction or explicit
``reconcile()`` call.
"""

from __future__ import annotations

import ctypes
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import threading
import time
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any


MAX_MANIFEST_BYTES = 64 * 1024
MAX_SKILL_BYTES = 512 * 1024
MAX_PACKAGE_BYTES = 2 * 1024 * 1024
MAX_STATE_BYTES = 2 * 1024 * 1024
MAX_ID_LENGTH = 64
MAX_NAME_LENGTH = 256
MAX_DESCRIPTION_LENGTH = 4 * 1024
MAX_SOURCE_LENGTH = 2 * 1024
MAX_ARRAY_ITEMS = 64
MAX_ARRAY_ITEM_LENGTH = 128
MAX_AUDIT_ENTRIES = 1_000

_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_SAFE_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")

_MANIFEST_KEYS = {
    "schemaVersion",
    "id",
    "version",
    "name",
    "description",
    "source",
    "files",
    "requiredCapabilities",
    "compatibleProfiles",
    "signature",
}
_REQUIRED_MANIFEST_KEYS = _MANIFEST_KEYS - {"signature"}
_SIGNATURE_KEYS = {"algorithm", "keyId", "value"}


class SkillStoreError(Exception):
    """Base class for all fail-closed store errors."""


class SkillValidationError(SkillStoreError, ValueError):
    """The package or an operation input violates a bounded contract."""


class SkillIntegrityError(SkillStoreError):
    """A previously accepted package no longer matches its digest."""


class SkillApprovalError(SkillStoreError):
    """An approval is missing, stale, or bound to different permissions."""


class SkillRecoveryError(SkillStoreError):
    """The durable state or journal cannot be reconciled safely."""


class SkillAuditCapacityError(SkillStoreError):
    """The bounded audit log is full; no historical record may be deleted.

    This is an operator-actionable capacity condition, not data corruption:
    it must never be caught by handlers that treat ``SkillRecoveryError`` as
    "state needs reconciliation" (see ``reconcile()``), because the correct
    response is to fail the governed mutation closed, not to paper over a
    journal entry as a recoverable warning.
    """


def package_digest(manifest_bytes: bytes, skill_bytes: bytes) -> str:
    """Return the exact digest bound to a package's raw two-file contents."""

    return hashlib.sha256(manifest_bytes + b"\x00" + skill_bytes).hexdigest()


def file_digest(value: bytes) -> str:
    """Return a manifest-compatible SHA-256 digest for file bytes."""

    return f"sha256:{hashlib.sha256(value).hexdigest()}"


class VerifiedSkillStore:
    """Bounded local package store with staged, atomic activation."""

    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root).absolute()
        self._lock = threading.RLock()
        self.staging_dir = self.root / "staging"
        self.versions_dir = self.root / "versions"
        self.transactions_dir = self.root / "transactions"
        self.state_path = self.root / "state.json"
        self._ensure_layout()
        self.reconcile()

    def _ensure_layout(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for directory in (self.staging_dir, self.versions_dir, self.transactions_dir):
            directory.mkdir(exist_ok=True)
            _reject_reparse_components(directory)

        if not self.state_path.exists():
            _atomic_write_json(self.state_path, _empty_state())
        elif not _is_regular_file(self.state_path):
            raise SkillRecoveryError("state.json is not a regular file")

    def stage(self, package_dir: str | os.PathLike[str]) -> dict[str, Any]:
        """Validate and copy a local package into an atomic staging directory."""

        with self._lock:
            artifact = _read_package(Path(package_dir), self.root)
            stage_id = uuid.uuid4().hex
            temp_dir = self.staging_dir / f".stage-{stage_id}"
            final_dir = self.staging_dir / stage_id
            temp_dir.mkdir()
            try:
                _write_bytes_exclusive(temp_dir / "skill.json", artifact["manifest_bytes"])
                _write_bytes_exclusive(temp_dir / "SKILL.md", artifact["skill_bytes"])
                # Re-read the staged bytes before publishing the stage handle.
                staged = _read_package(temp_dir, self.root)
                if staged["digest"] != artifact["digest"]:
                    raise SkillIntegrityError("staged bytes changed during copy")
                os.replace(temp_dir, final_dir)
            except Exception:
                _remove_internal_tree(temp_dir, self.staging_dir)
                raise

            return _public_artifact(staged, stage_id=stage_id, path=final_dir)

    def review(self, staged: Mapping[str, Any] | str | os.PathLike[str]) -> dict[str, Any]:
        """Return fresh review facts, including the permission delta."""

        with self._lock:
            artifact = self._resolve_artifact(staged)
            current = self._current_permissions(artifact["manifest"]["id"])
            requested = tuple(artifact["manifest"]["requiredCapabilities"])
            added = sorted(set(requested) - set(current))
            removed = sorted(set(current) - set(requested))
            return {
                **_public_artifact(artifact),
                "permissionDelta": {"added": added, "removed": removed},
            }

    def approve(
        self,
        staged: Mapping[str, Any] | str | os.PathLike[str],
        *,
        confirm_permission_delta: bool = False,
        permission_delta_approved: bool = False,
        allow_permission_delta: bool = False,
    ) -> dict[str, Any]:
        """Create a one-use approval bound to fresh bytes and permissions.

        The three confirmation keyword spellings intentionally converge on one
        boolean so callers can use the terminology of their approval surface.
        A permission addition cannot be approved implicitly.
        """

        with self._lock:
            artifact = self._resolve_artifact(staged)
            current = self._current_permissions(artifact["manifest"]["id"])
            permissions = tuple(artifact["manifest"]["requiredCapabilities"])
            added = sorted(set(permissions) - set(current))
            removed = sorted(set(current) - set(permissions))
            explicit = bool(
                confirm_permission_delta
                or permission_delta_approved
                or allow_permission_delta
            )
            if added and not explicit:
                raise SkillApprovalError(
                    "new capabilities require explicit permission-delta approval"
                )

            state = self._load_state()
            token = secrets.token_urlsafe(24)
            state["approvals"][token] = {
                "skillId": artifact["manifest"]["id"],
                "digest": artifact["digest"],
                "permissions": list(permissions),
                "permissionDelta": {"added": added, "removed": removed},
                "permissionDeltaApproved": explicit,
                "consumed": False,
            }
            self._append_audit(state, "approved", artifact)
            self._save_state(state)
            return {
                "token": token,
                "skillId": artifact["manifest"]["id"],
                "digest": artifact["digest"],
                "permissions": list(permissions),
                "permissionDelta": {"added": added, "removed": removed},
                "permissionDeltaApproved": explicit,
            }

    def activate(
        self,
        staged: Mapping[str, Any] | str | os.PathLike[str],
        approval: Mapping[str, Any],
        *,
        active_profile: str | None = None,
    ) -> dict[str, Any]:
        """Install a staged package and atomically make its digest active."""

        with self._lock:
            state = self._load_state()
            artifact = self._resolve_artifact(staged)
            _enforce_activation_policy(artifact["manifest"], active_profile)
            self._check_approval(state, artifact, approval)
            skill_id = artifact["manifest"]["id"]
            digest = artifact["digest"]
            target_parent = self.versions_dir / skill_id
            target_dir = target_parent / digest
            _ensure_contained(self.versions_dir, target_parent)
            _ensure_contained(target_parent, target_dir)
            target_parent.mkdir(exist_ok=True)
            _reject_reparse_components(target_parent)
            previous = state["active"].get(skill_id)
            tx_id = uuid.uuid4().hex
            tx = {
                "schemaVersion": 1,
                "txId": tx_id,
                "kind": "activate",
                "skillId": skill_id,
                "digest": digest,
                "stageId": artifact.get("stageId"),
                "approvalToken": approval["token"],
                "previous": previous,
                "phase": "prepared",
            }
            tx_path = self.transactions_dir / f"{tx_id}.json"
            _atomic_write_json(tx_path, tx)
            try:
                self._install_version(artifact, target_dir)
                tx["phase"] = "version_installed"
                _atomic_write_json(tx_path, tx)

                state = self._load_state()
                self._check_approval(state, artifact, approval)
                state["installed"].setdefault(skill_id, {})[digest] = _installed_record(artifact)
                state["active"][skill_id] = {
                    "digest": digest,
                    "enabled": True,
                    "permissions": list(artifact["manifest"]["requiredCapabilities"]),
                }
                state["approvals"][approval["token"]]["consumed"] = True
                self._append_audit(state, "activated", artifact)
                self._save_state(state)
                tx["phase"] = "state_committed"
                _atomic_write_json(tx_path, tx)
            except Exception:
                # The journal is intentionally retained for constructor-time
                # reconciliation.  Do not remove a possibly recoverable write.
                raise

            _remove_file_if_safe(tx_path, self.transactions_dir)
            self._remove_stage_if_owned(artifact)
            return {
                "ok": True,
                "skillId": skill_id,
                "digest": digest,
                "enabled": True,
            }

    def disable(self, skill_id: str) -> dict[str, Any]:
        """Disable activation without deleting the installed digest history."""

        _validate_id(skill_id)
        with self._lock:
            state = self._load_state()
            active = state["active"].get(skill_id)
            if not active:
                raise SkillStoreError(f"skill is not active: {skill_id}")
            active["enabled"] = False
            artifact = self._artifact_from_installed(state, skill_id, active["digest"])
            self._append_audit(state, "disabled", artifact)
            self._save_state(state)
            return {"ok": True, "skillId": skill_id, "digest": active["digest"], "enabled": False}

    def rollback(
        self,
        skill_id: str,
        digest: str,
        approval: Mapping[str, Any] | None = None,
        *,
        active_profile: str | None = None,
    ) -> dict[str, Any]:
        """Activate one exact, previously installed digest.

        A previously installed digest carries its original approval evidence.
        If rollback would add a capability relative to the current version, a
        fresh approval is still required and is checked against the exact
        target digest.
        """

        _validate_id(skill_id)
        digest = _normalize_digest(digest)
        with self._lock:
            state = self._load_state()
            record = state["installed"].get(skill_id, {}).get(digest)
            if record is None:
                raise SkillStoreError("rollback requires an exact installed digest")
            target_dir = self.versions_dir / skill_id / digest
            _ensure_contained(self.versions_dir, target_dir)
            artifact = _read_package(target_dir, self.root, expected_id=skill_id, expected_digest=digest)
            _enforce_activation_policy(artifact["manifest"], active_profile)
            current = self._current_permissions(skill_id)
            added = sorted(set(artifact["manifest"]["requiredCapabilities"]) - set(current))
            if added:
                if approval is None:
                    raise SkillApprovalError("rollback adds capabilities; fresh approval required")
                self._check_approval(state, artifact, approval)

            # A rollback is an activation of an immutable installed directory,
            # so the same atomic state commit and recovery journal is used.
            tx_id = uuid.uuid4().hex
            tx_path = self.transactions_dir / f"{tx_id}.json"
            tx = {
                "schemaVersion": 1,
                "txId": tx_id,
                "kind": "rollback",
                "skillId": skill_id,
                "digest": digest,
                "approvalToken": approval.get("token") if approval else None,
                "previous": state["active"].get(skill_id),
                "phase": "prepared",
            }
            _atomic_write_json(tx_path, tx)
            try:
                _read_package(target_dir, self.root, expected_id=skill_id, expected_digest=digest)
                state = self._load_state()
                state["active"][skill_id] = {
                    "digest": digest,
                    "enabled": True,
                    "permissions": list(artifact["manifest"]["requiredCapabilities"]),
                }
                if approval:
                    self._check_approval(state, artifact, approval)
                    state["approvals"][approval["token"]]["consumed"] = True
                self._append_audit(state, "rolled_back", artifact)
                self._save_state(state)
                tx["phase"] = "state_committed"
                _atomic_write_json(tx_path, tx)
            except Exception:
                raise
            _remove_file_if_safe(tx_path, self.transactions_dir)
            return {"ok": True, "skillId": skill_id, "digest": digest, "enabled": True}

    def get_active(self, skill_id: str) -> dict[str, Any] | None:
        """Return active state only after validating its exact package bytes."""

        _validate_id(skill_id)
        with self._lock:
            state = self._load_state()
            active = state["active"].get(skill_id)
            if not active or not active.get("enabled"):
                return None
            active_path = self.versions_dir / skill_id / active["digest"]
            _ensure_contained(self.versions_dir, active_path)
            artifact = _read_package(
                active_path,
                self.root,
                expected_id=skill_id,
                expected_digest=active["digest"],
            )
            return {
                "skillId": skill_id,
                "digest": active["digest"],
                "enabled": True,
                "permissions": list(artifact["manifest"]["requiredCapabilities"]),
                "version": artifact["manifest"]["version"],
            }

    def list_installed(self, skill_id: str | None = None) -> list[dict[str, Any]]:
        """List validated installed records; tampered records are not returned."""

        with self._lock:
            state = self._load_state()
            ids = [skill_id] if skill_id else sorted(state["installed"])
            result: list[dict[str, Any]] = []
            for current_id in ids:
                _validate_id(current_id)
                for digest in sorted(state["installed"].get(current_id, {})):
                    installed_path = self.versions_dir / current_id / digest
                    _ensure_contained(self.versions_dir, installed_path)
                    artifact = _read_package(
                        installed_path,
                        self.root,
                        expected_id=current_id,
                        expected_digest=digest,
                    )
                    result.append(_public_artifact(artifact))
            return result

    def reconcile(self) -> dict[str, Any]:
        """Recover journaled activations and disable invalid active entries."""

        with self._lock:
            state = self._load_state()
            report: dict[str, Any] = {
                "recovered": [],
                "disabled": [],
                "discarded": [],
                "warnings": [],
            }
            for temp in self.staging_dir.glob(".stage-*"):
                _remove_internal_tree(temp, self.staging_dir)
                report["discarded"].append(temp.name)
            for temp in self.versions_dir.glob("**/.install-*"):
                _remove_internal_tree(temp, self.versions_dir)
                report["discarded"].append(temp.name)

            for tx_path in sorted(self.transactions_dir.glob("*.json")):
                tx = _load_bounded_json(tx_path, MAX_STATE_BYTES)
                if not isinstance(tx, dict) or tx.get("schemaVersion") != 1:
                    raise SkillRecoveryError(f"invalid transaction journal: {tx_path.name}")
                try:
                    recovered = self._reconcile_transaction(state, tx)
                except SkillAuditCapacityError:
                    # Not a corruption/recovery condition: do not launder it
                    # into a warning and do not let the in-place mutations
                    # _reconcile_transaction already made to ``state`` reach
                    # the unconditional _save_state below.  Fail the whole
                    # reconcile() call closed instead.
                    raise
                except (SkillStoreError, OSError, ValueError) as exc:
                    report["warnings"].append(f"{tx_path.name}: {exc}")
                    continue
                if recovered:
                    report["recovered"].append(tx["txId"])
                _remove_file_if_safe(tx_path, self.transactions_dir)

            for skill_id, active in list(state["active"].items()):
                _validate_id(skill_id)
                if not active.get("enabled"):
                    continue
                active_path = self.versions_dir / skill_id / active["digest"]
                _ensure_contained(self.versions_dir, active_path)
                try:
                    _read_package(
                        active_path,
                        self.root,
                        expected_id=skill_id,
                        expected_digest=active["digest"],
                    )
                except (SkillStoreError, OSError, ValueError) as exc:
                    active["enabled"] = False
                    report["disabled"].append(skill_id)
                    report["warnings"].append(f"{skill_id}: disabled after reconciliation: {exc}")

            self._save_state(state)
            return report

    def _reconcile_transaction(self, state: dict[str, Any], tx: Mapping[str, Any]) -> bool:
        skill_id = tx.get("skillId")
        digest = tx.get("digest")
        if not isinstance(skill_id, str) or not isinstance(digest, str):
            raise SkillRecoveryError("transaction identity is malformed")
        _validate_id(skill_id)
        _validate_digest(digest)
        artifact_path = self.versions_dir / skill_id / digest
        _ensure_contained(self.versions_dir, artifact_path)
        token = tx.get("approvalToken")
        if tx.get("kind") == "activate":
            stored_approval = state.get("approvals", {}).get(token)
            if not isinstance(stored_approval, Mapping):
                raise SkillRecoveryError("activation journal has no matching approval")
            if stored_approval.get("skillId") != skill_id or stored_approval.get("digest") != digest:
                raise SkillRecoveryError("activation journal approval binding mismatch")
        if not artifact_path.exists():
            stage_id = tx.get("stageId")
            stage_path = self.staging_dir / stage_id if isinstance(stage_id, str) else None
            if stage_path is None or not stage_path.exists():
                return False
            artifact = _read_package(stage_path, self.root, expected_id=skill_id, expected_digest=digest)
            self._install_version(artifact, artifact_path)
        artifact = _read_package(artifact_path, self.root, expected_id=skill_id, expected_digest=digest)
        if tx.get("kind") == "activate":
            stored_approval = state["approvals"][tx["approvalToken"]]
            if stored_approval.get("permissions") != list(artifact["manifest"]["requiredCapabilities"]):
                raise SkillRecoveryError("activation journal permission binding mismatch")
            if stored_approval.get("consumed") and state["active"].get(skill_id, {}).get("digest") != digest:
                raise SkillRecoveryError("consumed approval is not reflected in active state")
        state["installed"].setdefault(skill_id, {})[digest] = _installed_record(artifact)
        state["active"][skill_id] = {
            "digest": digest,
            "enabled": True,
            "permissions": list(artifact["manifest"]["requiredCapabilities"]),
        }
        if isinstance(token, str) and token in state["approvals"]:
            state["approvals"][token]["consumed"] = True
        self._append_audit(state, "recovered", artifact)
        self._save_state(state)
        return True

    def _install_version(self, artifact: Mapping[str, Any], target_dir: Path) -> None:
        _reject_reparse_components(self.versions_dir)
        target_parent = target_dir.parent
        target_parent.mkdir(exist_ok=True)
        _reject_reparse_components(target_parent)
        if target_dir.exists():
            existing = _read_package(
                target_dir,
                self.root,
                expected_id=artifact["manifest"]["id"],
                expected_digest=artifact["digest"],
            )
            if existing["digest"] != artifact["digest"]:
                raise SkillIntegrityError("digest directory contains different bytes")
            return
        temp_dir = target_parent / f".install-{uuid.uuid4().hex}"
        temp_dir.mkdir()
        try:
            _write_bytes_exclusive(temp_dir / "skill.json", artifact["manifest_bytes"])
            _write_bytes_exclusive(temp_dir / "SKILL.md", artifact["skill_bytes"])
            staged = _read_package(temp_dir, self.root)
            if staged["digest"] != artifact["digest"]:
                raise SkillIntegrityError("installed bytes failed exact digest check")
            _reject_reparse_components(target_parent)
            os.replace(temp_dir, target_dir)
        except Exception:
            _remove_internal_tree(temp_dir, target_parent)
            raise

    def _resolve_artifact(
        self, value: Mapping[str, Any] | str | os.PathLike[str]
    ) -> dict[str, Any]:
        if isinstance(value, Mapping):
            stage_id = value.get("stageId")
            path_value = value.get("path")
            if isinstance(stage_id, str):
                _validate_token(stage_id, "stageId", 128)
                path = self.staging_dir / stage_id
            elif isinstance(path_value, (str, os.PathLike)):
                path = Path(path_value)
            else:
                raise SkillValidationError("staged artifact needs stageId or path")
        else:
            path = Path(value)
        _ensure_contained(self.staging_dir, path)
        _reject_reparse_components(path)
        artifact = _read_package(path, self.root)
        if isinstance(stage_id, str):
            artifact["stageId"] = stage_id
        return artifact

    def _remove_stage_if_owned(self, artifact: Mapping[str, Any]) -> None:
        stage_id = artifact.get("stageId")
        if isinstance(stage_id, str):
            _validate_token(stage_id, "stageId", 128)
            _remove_internal_tree(self.staging_dir / stage_id, self.staging_dir)

    def _load_state(self) -> dict[str, Any]:
        state = _load_bounded_json(self.state_path, MAX_STATE_BYTES)
        if not isinstance(state, dict) or state.get("schemaVersion") != 1:
            raise SkillRecoveryError("state.json schema is invalid")
        for key in ("installed", "active", "approvals", "audit"):
            if not isinstance(state.get(key), (dict, list)):
                raise SkillRecoveryError(f"state.json field is invalid: {key}")
        if (
            not isinstance(state["installed"], dict)
            or not isinstance(state["active"], dict)
            or not isinstance(state["approvals"], dict)
            or not isinstance(state["audit"], list)
        ):
            raise SkillRecoveryError("state.json indexes are invalid")
        return state

    def _save_state(self, state: dict[str, Any]) -> None:
        if len(json.dumps(state, ensure_ascii=False).encode("utf-8")) > MAX_STATE_BYTES:
            raise SkillValidationError("state exceeds bounded size")
        _atomic_write_json(self.state_path, state)

    def _check_approval(
        self,
        state: Mapping[str, Any],
        artifact: Mapping[str, Any],
        approval: Mapping[str, Any],
    ) -> None:
        if not isinstance(approval, Mapping) or not isinstance(approval.get("token"), str):
            raise SkillApprovalError("approval token is required")
        token = approval["token"]
        _validate_token(token, "approval token", 256)
        stored = state.get("approvals", {}).get(token)
        if not isinstance(stored, Mapping) or stored.get("consumed"):
            raise SkillApprovalError("approval is unknown or already consumed")
        permissions = list(artifact["manifest"]["requiredCapabilities"])
        expected = {
            "skillId": artifact["manifest"]["id"],
            "digest": artifact["digest"],
            "permissions": permissions,
        }
        for key, value in expected.items():
            if stored.get(key) != value or approval.get(key) != value:
                raise SkillApprovalError(f"approval is not bound to {key}")
        added = stored.get("permissionDelta", {}).get("added")
        if not isinstance(added, list):
            raise SkillApprovalError("approval permission delta is malformed")
        current = self._current_permissions(artifact["manifest"]["id"])
        actual_added = sorted(set(permissions) - set(current))
        if sorted(added) != actual_added:
            raise SkillApprovalError("approval permission delta is stale")
        if actual_added and stored.get("permissionDeltaApproved") is not True:
            raise SkillApprovalError("permission delta was not explicitly approved")

    def _current_permissions(self, skill_id: str) -> tuple[str, ...]:
        state = self._load_state()
        active = state["active"].get(skill_id)
        if not active:
            return ()
        return tuple(active.get("permissions", ()))

    def _artifact_from_installed(self, state: Mapping[str, Any], skill_id: str, digest: str) -> dict[str, Any]:
        target = self.versions_dir / skill_id / digest
        _ensure_contained(self.versions_dir, target)
        return _read_package(
            target,
            self.root,
            expected_id=skill_id,
            expected_digest=digest,
        )

    def _append_audit(self, state: dict[str, Any], action: str, artifact: Mapping[str, Any]) -> None:
        audit = state.setdefault("audit", [])
        if not isinstance(audit, list):
            raise SkillRecoveryError("audit state is invalid")
        # Fail closed at capacity instead of discarding history.  This check
        # must run before the audit list (or any other part of ``state``) is
        # mutated: every caller holds a freshly loaded, not-yet-persisted
        # ``state`` dict and calls ``_save_state`` immediately after this
        # method returns, so raising here guarantees the in-memory governed
        # mutation the caller just made is discarded unsaved and no partial
        # write reaches state.json.
        if len(audit) >= MAX_AUDIT_ENTRIES:
            raise SkillAuditCapacityError(
                "verified skill audit capacity reached; "
                "no historical records were deleted"
            )
        audit.append({
            "action": action,
            "skillId": artifact["manifest"]["id"],
            "digest": artifact["digest"],
            "at": time.time_ns(),
        })


def _empty_state() -> dict[str, Any]:
    return {"schemaVersion": 1, "installed": {}, "active": {}, "approvals": {}, "audit": []}


def _public_artifact(artifact: Mapping[str, Any], *, stage_id: str | None = None, path: Path | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "skillId": artifact["manifest"]["id"],
        "version": artifact["manifest"]["version"],
        "digest": artifact["digest"],
        "permissions": list(artifact["manifest"]["requiredCapabilities"]),
        "manifest": artifact["manifest"],
    }
    if stage_id is not None:
        result["stageId"] = stage_id
    if path is not None:
        result["path"] = str(path)
    return result


def _installed_record(artifact: Mapping[str, Any]) -> dict[str, Any]:
    manifest = artifact["manifest"]
    return {
        "version": manifest["version"],
        "source": manifest["source"],
        "permissions": list(manifest["requiredCapabilities"]),
        "digest": artifact["digest"],
        "installedAt": time.time_ns(),
    }


def _read_package(
    package_dir: Path,
    _store_root: Path,
    *,
    expected_id: str | None = None,
    expected_digest: str | None = None,
) -> dict[str, Any]:
    package_dir = Path(package_dir)
    if not package_dir.is_absolute():
        package_dir = Path(os.path.abspath(package_dir))
    _reject_reparse_components(package_dir)
    if not package_dir.is_dir() or not _is_regular_dir(package_dir):
        raise SkillValidationError("package must be a regular directory")
    files: list[str] = []
    for entry in _walk_no_reparse(package_dir):
        rel = entry.relative_to(package_dir).as_posix()
        if entry.is_dir():
            raise SkillValidationError("nested package directories are not allowed")
        files.append(rel)
    if sorted(files) != ["SKILL.md", "skill.json"]:
        raise SkillValidationError("package must contain exactly skill.json and SKILL.md")
    manifest_path = package_dir / "skill.json"
    skill_path = package_dir / "SKILL.md"
    manifest_bytes = _read_bounded(manifest_path, MAX_MANIFEST_BYTES)
    skill_bytes = _read_bounded(skill_path, MAX_SKILL_BYTES)
    if len(manifest_bytes) + len(skill_bytes) > MAX_PACKAGE_BYTES:
        raise SkillValidationError("package exceeds total byte limit")
    manifest = _parse_manifest(manifest_bytes)
    actual_file_digest = file_digest(skill_bytes)
    if manifest["files"]["SKILL.md"] != actual_file_digest:
        raise SkillIntegrityError("SKILL.md digest does not match manifest")
    digest = package_digest(manifest_bytes, skill_bytes)
    if expected_id is not None and manifest["id"] != expected_id:
        raise SkillIntegrityError("manifest id does not match installed path")
    if expected_digest is not None and not hmac.compare_digest(digest, expected_digest):
        raise SkillIntegrityError("package bytes do not match exact digest")
    return {
        "manifest": manifest,
        "manifest_bytes": manifest_bytes,
        "skill_bytes": skill_bytes,
        "digest": digest,
        "path": package_dir,
    }


def _parse_manifest(raw: bytes) -> dict[str, Any]:
    try:
        text = raw.decode("utf-8")
        value = json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, SkillValidationError) as exc:
        raise SkillValidationError("skill.json is not strict UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise SkillValidationError("skill.json must be an object")
    keys = set(value)
    if keys != _REQUIRED_MANIFEST_KEYS and not keys <= _MANIFEST_KEYS:
        raise SkillValidationError("skill.json contains unknown or missing fields")
    if not _REQUIRED_MANIFEST_KEYS <= keys:
        raise SkillValidationError("skill.json is missing required fields")
    if value["schemaVersion"] != 1:
        raise SkillValidationError("unsupported skill schemaVersion")
    _validate_id(value["id"])
    if not isinstance(value["version"], str) or not _SEMVER_RE.fullmatch(value["version"]):
        raise SkillValidationError("version must be SemVer 2.0.0")
    _validate_text(value["name"], "name", MAX_NAME_LENGTH)
    _validate_text(value["description"], "description", MAX_DESCRIPTION_LENGTH)
    _validate_text(value["source"], "source", MAX_SOURCE_LENGTH)
    files = value["files"]
    if not isinstance(files, dict) or set(files) != {"SKILL.md"}:
        raise SkillValidationError("files must contain exactly SKILL.md")
    _validate_file_digest(files["SKILL.md"])
    for key in ("requiredCapabilities", "compatibleProfiles"):
        _validate_string_list(value[key], key)
    if "signature" in value:
        signature = value["signature"]
        if not isinstance(signature, dict) or set(signature) != _SIGNATURE_KEYS:
            raise SkillValidationError("signature metadata is malformed")
        _validate_text(signature["algorithm"], "signature.algorithm", 32)
        _validate_text(signature["keyId"], "signature.keyId", 256)
        _validate_text(signature["value"], "signature.value", 4096)
    return value


def _enforce_activation_policy(manifest: Mapping[str, Any], active_profile: str | None) -> None:
    """Apply profile compatibility and the remote-source fail-closed rule."""
    profiles = manifest.get("compatibleProfiles", [])
    if active_profile is not None and active_profile not in profiles:
        raise SkillApprovalError(
            f"skill is not compatible with active profile '{active_profile}'"
        )
    source = manifest.get("source")
    if isinstance(source, str) and source.startswith(("http://", "https://")):
        signature = manifest.get("signature")
        if not source.startswith("https://"):
            raise SkillApprovalError("remote skills require HTTPS")
        if not isinstance(signature, Mapping) or signature.get("algorithm") != "Ed25519":
            raise SkillApprovalError("remote skills require Ed25519 signature metadata")


def _validate_string_list(value: Any, name: str) -> None:
    if not isinstance(value, list) or not value or len(value) > MAX_ARRAY_ITEMS:
        raise SkillValidationError(f"{name} must be a bounded non-empty list")
    if len(set(value)) != len(value):
        raise SkillValidationError(f"{name} must not contain duplicates")
    for item in value:
        _validate_token(item, name, MAX_ARRAY_ITEM_LENGTH)


def _validate_id(value: Any) -> None:
    if not isinstance(value, str) or len(value) > MAX_ID_LENGTH or not _ID_RE.fullmatch(value):
        raise SkillValidationError("id is not a safe bounded skill identifier")


def _validate_digest(value: Any) -> None:
    # Package digests are raw lowercase hex because they are also directory
    # names.  Manifest file digests retain the explicit ``sha256:`` prefix.
    if not isinstance(value, str) or not (_SAFE_DIGEST_RE.fullmatch(value) or _DIGEST_RE.fullmatch(value)):
        raise SkillValidationError("package digest must be 64 lowercase hex chars")


def _normalize_digest(value: Any) -> str:
    _validate_digest(value)
    return value[7:] if value.startswith("sha256:") else value


def _validate_file_digest(value: Any) -> None:
    if not isinstance(value, str) or not _DIGEST_RE.fullmatch(value):
        raise SkillValidationError("file digest must be sha256:<64 lowercase hex chars>")


def _validate_text(value: Any, name: str, limit: int) -> None:
    if not isinstance(value, str) or not value or len(value) > limit or "\x00" in value:
        raise SkillValidationError(f"{name} is not bounded text")


def _validate_token(value: Any, name: str, limit: int) -> None:
    if not isinstance(value, str) or not value or len(value) > limit or "\x00" in value:
        raise SkillValidationError(f"{name} is not bounded text")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise SkillValidationError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_bounded(path: Path, limit: int) -> bytes:
    if not _is_regular_file(path):
        raise SkillValidationError(f"not a regular file: {path.name}")
    _reject_reparse_components(path)
    with path.open("rb") as handle:
        value = handle.read(limit + 1)
    if len(value) > limit:
        raise SkillValidationError(f"{path.name} exceeds byte limit")
    return value


def _load_bounded_json(path: Path, limit: int) -> Any:
    raw = _read_bounded(path, limit)
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, SkillValidationError) as exc:
        raise SkillRecoveryError(f"invalid JSON: {path.name}") from exc


def _is_regular_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(os.lstat(path).st_mode) and not _is_reparse_point(path)
    except FileNotFoundError:
        return False


def _is_regular_dir(path: Path) -> bool:
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode) and not _is_reparse_point(path)
    except FileNotFoundError:
        return False


def _walk_no_reparse(root: Path):
    try:
        entries = list(os.scandir(root))
    except OSError as exc:
        raise SkillValidationError(f"cannot enumerate package: {root}") from exc
    for entry in entries:
        path = Path(entry.path)
        _reject_reparse_components(path)
        try:
            mode = os.lstat(path).st_mode
        except OSError as exc:
            raise SkillValidationError(f"cannot inspect package entry: {entry.name}") from exc
        if stat.S_ISDIR(mode):
            yield path
            yield from _walk_no_reparse(path)
        elif stat.S_ISREG(mode):
            yield path
        else:
            raise SkillValidationError(f"package entry is not regular: {entry.name}")


def _is_reparse_point(path: Path) -> bool:
    try:
        if stat.S_ISLNK(os.lstat(path).st_mode):
            return True
    except FileNotFoundError:
        return False
    if os.name != "nt":
        return False
    try:
        get_attributes = ctypes.windll.kernel32.GetFileAttributesW
        get_attributes.argtypes = [ctypes.c_wchar_p]
        get_attributes.restype = ctypes.c_uint32
        attributes = get_attributes(str(path))
        return attributes != 0xFFFFFFFF and bool(attributes & 0x0400)  # FILE_ATTRIBUTE_REPARSE_POINT
    except (AttributeError, OSError):
        return False


def _reject_reparse_components(path: Path) -> None:
    absolute = Path(os.path.abspath(path))
    current = absolute
    existing: list[Path] = []
    while True:
        existing.append(current)
        if current.parent == current:
            break
        current = current.parent
    for component in reversed(existing):
        if component.exists() and _is_reparse_point(component):
            raise SkillValidationError(f"symlink/reparse path rejected: {component}")


def _ensure_contained(base: Path, candidate: Path) -> None:
    base_abs = Path(os.path.abspath(base))
    candidate_abs = Path(os.path.abspath(candidate))
    try:
        candidate_abs.relative_to(base_abs)
    except ValueError as exc:
        raise SkillValidationError("path escapes configured containment root") from exc


def _write_bytes_exclusive(path: Path, value: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def _atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _reject_reparse_components(path.parent)
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    _write_bytes_exclusive(temp, raw)
    try:
        os.replace(temp, path)
    except Exception:
        _remove_file_if_safe(temp, path.parent)
        raise


def _remove_file_if_safe(path: Path, containment: Path) -> None:
    _ensure_contained(containment, path)
    _reject_reparse_components(path)
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _remove_internal_tree(path: Path, containment: Path) -> None:
    _ensure_contained(containment, path)
    if not path.exists():
        return
    _reject_reparse_components(path)
    if path.is_dir():
        for child in path.iterdir():
            _remove_internal_tree(child, containment)
        path.rmdir()
    else:
        _remove_file_if_safe(path, containment)
