"""Kernel-local Ed25519 trust engine for signed remote skill sources (Phase 4).

This module is the SINGLE source of truth for the Phase-4 trust protocol. It
ports the *model* of the deleted ``packages/gateway/src/skillTrust.ts`` (661
lines, zero production importers) into the kernel, colocated with the install
authority (``VerifiedSkillStore``, ``governed_skills``) so that the process
that installs is the process that verifies (PRD R-1, RS-1, SP-7). No trust
verdict ever crosses a process boundary.

What lives here:

- ``canonicalize`` -- ``TCJSON_V1`` canonical JSON (PRD §5.1). The signing CLI
  (``scripts/skill_signing.py``) IMPORTS this function; it is never
  re-implemented (SP-4 / DP-11).
- ``SkillTrustError`` -- the one typed exception whose ``reason`` comes from the
  frozen registry (PRD §5.8). ``governed_skills.map_activation_failure`` maps
  every reason; it is never a parallel dictionary.
- ``TrustEngine`` -- bundle acceptance (§5.2), package-envelope evaluation
  (§5.3), persistence + clock discipline (§5.6). Constructor-injected into
  ``VerifiedSkillStore`` at the single production construction site
  ``governed_skills._store()`` (O-5), so an unwired seam fails closed.

Locking: the engine owns a single internal ``threading.RLock`` that is a LEAF
in the global order (``skill_queue._lock -> _MUTATION_LOCK ->
_STORE_SINGLETON_LOCK -> store._lock -> trust lock``, SP-9). It is never held
across network I/O and never held while acquiring any other lock.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
    load_der_public_key,
)


# ---------------------------------------------------------------------------
# Frozen bounds (ports of skillTrust.ts constants; PRD §5.1/§5.2)
# ---------------------------------------------------------------------------

MAX_CANONICAL_DEPTH = 64
MAX_CANONICAL_PAYLOAD_BYTES = 256 * 1024
MAX_TRUSTED_KEYS = 256
MAX_REVOCATIONS = 2048
MAX_SKILL_PINS = 2048

DEFAULT_MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000  # 24h publisher window
DEFAULT_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000  # 2 min
DEFAULT_MAX_CLOCK_ROLLBACK_MS = 5 * 60 * 1000  # 5 min restart wall regression
HARD_EXPIRY_MS = 72 * 60 * 60 * 1000  # acceptedAt + 72h outer bound (R-8)

_MAX_INT = (1 << 53) - 1
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


# ---------------------------------------------------------------------------
# The single typed exception + frozen reason registry (PRD §5.8)
# ---------------------------------------------------------------------------

#: Every reason the trust engine may raise. ``map_activation_failure`` maps
#: each of these; an out-of-registry reason maps non-retryable (O-13). Ported
#: verbatim from skillTrust.ts:142-160, plus digest-mismatch,
#: capability-unsupported, digest-not-current (O-1), trust-engine-unavailable
#: (O-5), artifact-record-missing.
TRUST_REASONS: frozenset[str] = frozenset(
    {
        "clock-unavailable",
        "clock-rollback",
        "invalid-schema",
        "payload-too-large",
        "origin-mismatch",
        "unknown-authority-key",
        "signature-invalid",
        "invalid-freshness",
        "future-issued",
        "stale",
        "sequence-not-monotonic",
        "issued-at-not-monotonic",
        "unknown-origin",
        "untrusted-key",
        "invalid-key",
        "revoked-key",
        "revoked-skill",
        "trust-not-yet-valid",
        # Kernel additions:
        "digest-mismatch",
        "capability-unsupported",
        "digest-not-current",
        "trust-engine-unavailable",
        "artifact-record-missing",
    }
)


class SkillTrustError(Exception):
    """The one typed trust failure. ``reason`` is a frozen-registry string.

    Fail-closed everywhere (RS-5): there is no warn-and-proceed arm. Every
    trust failure raises this and the governed operation is refused.
    """

    def __init__(self, reason: str, detail: str | None = None):
        self.reason = reason
        self.detail = detail
        super().__init__(f"{reason}: {detail}" if detail else reason)


# ---------------------------------------------------------------------------
# TCJSON_V1 canonical JSON (PRD §5.1; single implementation, SP-4)
# ---------------------------------------------------------------------------


def _canonicalize_value(value: Any, path: str, depth: int) -> str:
    if depth > MAX_CANONICAL_DEPTH:
        raise SkillTrustError(
            "invalid-schema", f"payload nesting exceeds {MAX_CANONICAL_DEPTH} at {path}"
        )
    if value is None:
        return "null"
    # bool BEFORE int -- Python bool is an int subclass; True must serialize as
    # ``true`` not ``1`` (O-11, PRD §5.1 rule 5). A Phase-0 vector pins this.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if abs(value) > _MAX_INT:
            raise SkillTrustError("invalid-schema", f"integer out of range at {path}")
        # ``-0`` cannot occur for a Python int; no leading zeros/exponent.
        return str(value)
    if isinstance(value, float):
        # Non-integer numbers are rejected (D-2 tightening vs the TS model).
        raise SkillTrustError("invalid-schema", f"non-integer number at {path}")
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, list):
        parts = [
            _canonicalize_value(item, f"{path}[{i}]", depth + 1)
            for i, item in enumerate(value)
        ]
        return "[" + ",".join(parts) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise SkillTrustError("invalid-schema", f"non-string key at {path}")
        # Sort by Unicode code point (Python str comparison is code-point order).
        parts = []
        for key in sorted(value):
            parts.append(f"{_json_string(key)}:{_canonicalize_value(value[key], f'{path}.{key}', depth + 1)}")
        return "{" + ",".join(parts) + "}"
    raise SkillTrustError("invalid-schema", f"unsupported value at {path}")


# JSON's mandatory two-char escapes; all other controls -> \u00XX.
_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\n": "\\n",
    "\t": "\\t",
    "\r": "\\r",
    "\b": "\\b",
    "\f": "\\f",
}


def _json_string(value: str) -> str:
    """Minimal-escape JSON string, ``ensure_ascii=False`` semantics (§5.1 rule 4).

    Matches ``JSON.stringify`` for these inputs: ``"`` and ``\\`` escaped, the
    named two-char control escapes, other controls as ``\\u00XX``, all other
    characters (including non-ASCII) raw UTF-8, never ``\\u``-escaped. No NFC/NFD
    normalization -- distinct inputs are distinct bytes.
    """
    out = ['"']
    for ch in value:
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonicalize(value: Any) -> bytes:
    """Return the ``TCJSON_V1`` canonical UTF-8 bytes of ``value`` (§5.1).

    Raises ``SkillTrustError('payload-too-large')`` above the 256 KiB bound and
    ``SkillTrustError('invalid-schema')`` for any non-serializable value.
    """
    text = _canonicalize_value(value, "$", 0)
    raw = text.encode("utf-8")
    if len(raw) > MAX_CANONICAL_PAYLOAD_BYTES:
        raise SkillTrustError("payload-too-large")
    return raw


# ---------------------------------------------------------------------------
# Primitive parsers (base64url canonical round-trip; strict ISO instant)
# ---------------------------------------------------------------------------


def _decode_b64url(value: Any) -> bytes:
    if not isinstance(value, str) or not value or not _B64URL_RE.fullmatch(value):
        raise SkillTrustError("invalid-schema", "invalid base64url")
    # Unpadded base64url -> add padding for the stdlib decoder.
    padded = value + "=" * (-len(value) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded)
    except (ValueError, Exception):  # noqa: BLE001 - defensive
        raise SkillTrustError("invalid-schema", "invalid base64url")
    if len(decoded) == 0:
        raise SkillTrustError("invalid-schema", "empty base64url")
    # Canonical round-trip: re-encode unpadded and require byte-equality.
    reencoded = base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii")
    if reencoded != value:
        raise SkillTrustError("invalid-schema", "non-canonical base64url")
    return decoded


def _parse_iso_ms(value: Any) -> int:
    """Strict ISO-8601 UTC milliseconds -> epoch ms. Round-trip stable (§5.2)."""
    if not isinstance(value, str) or not _ISO_RE.fullmatch(value):
        raise SkillTrustError("invalid-schema", "invalid timestamp")
    try:
        dt = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        raise SkillTrustError("invalid-schema", "invalid timestamp")
    epoch_ms = int(dt.timestamp() * 1000)
    # Round-trip stability rejects e.g. month 13 that strptime would refuse
    # anyway, but also guards any normalization drift.
    canon = dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
    if canon != value:
        raise SkillTrustError("invalid-schema", "non-canonical timestamp")
    return epoch_ms


def load_public_key(spki_b64url: str) -> Ed25519PublicKey:
    """Parse a DER SubjectPublicKeyInfo Ed25519 key from unpadded base64url."""
    der = _decode_b64url(spki_b64url)
    try:
        key = load_der_public_key(der)
    except Exception:  # noqa: BLE001
        raise SkillTrustError("invalid-key", "not a valid SPKI public key")
    if not isinstance(key, Ed25519PublicKey):
        raise SkillTrustError("invalid-key", "expected Ed25519 public key")
    return key


def public_key_spki_b64url(key: Ed25519PublicKey) -> str:
    der = key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    return base64.urlsafe_b64encode(der).rstrip(b"=").decode("ascii")


def verify_signature(payload: Any, encoded_signature: str, key: Ed25519PublicKey) -> bool:
    """Ed25519 verify over ``canonicalize(payload)``; signature b64url, 64 bytes."""
    try:
        signature = _decode_b64url(encoded_signature)
        if len(signature) != 64:
            return False
        key.verify(signature, canonicalize(payload))
        return True
    except (InvalidSignature, SkillTrustError):
        return False
    except Exception:  # noqa: BLE001
        return False


def _require_str(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise SkillTrustError("invalid-schema", f"invalid {name}")
    return value


def _require_exact_keys(record: Any, required: set[str], optional: set[str] = frozenset()) -> dict:
    if not isinstance(record, dict):
        raise SkillTrustError("invalid-schema", "expected object")
    keys = set(record)
    if not required <= keys or not keys <= (required | optional):
        raise SkillTrustError("invalid-schema", "unexpected or missing fields")
    return record


# ---------------------------------------------------------------------------
# Bundle & envelope parsing (§5.2 / §5.3)
# ---------------------------------------------------------------------------

_BUNDLE_KEYS = {
    "version",
    "origin",
    "sequence",
    "issuedAt",
    "nextUpdate",
    "trustedKeys",
    "revocations",
    "signingKeyId",
    "signature",
}
_BUNDLE_OPTIONAL = {"skills"}


def _parse_bundle(raw: dict) -> dict:
    """Strict-exact-keys parse of a TRUST_BUNDLE_V1 document (unverified)."""
    _require_exact_keys(raw, _BUNDLE_KEYS, _BUNDLE_OPTIONAL)
    if raw["version"] != 1:
        raise SkillTrustError("invalid-schema", "bundle version")
    origin = _require_str(raw["origin"], "origin", 512)
    _require_str(raw["signingKeyId"], "signingKeyId", 128)
    seq = raw["sequence"]
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0 or seq > _MAX_INT:
        raise SkillTrustError("invalid-schema", "invalid sequence")
    _parse_iso_ms(raw["issuedAt"])
    _parse_iso_ms(raw["nextUpdate"])
    _require_str(raw["signature"], "signature", 128)
    trusted = raw["trustedKeys"]
    revs = raw["revocations"]
    if not isinstance(trusted, list) or len(trusted) > MAX_TRUSTED_KEYS:
        raise SkillTrustError("invalid-schema", "invalid trustedKeys")
    if not isinstance(revs, list) or len(revs) > MAX_REVOCATIONS:
        raise SkillTrustError("invalid-schema", "invalid revocations")
    key_ids: set[str] = set()
    for entry in trusted:
        _require_exact_keys(entry, {"origin", "keyId", "publicKey"})
        k_origin = _require_str(entry["origin"], "key origin", 512)
        if k_origin != origin:
            raise SkillTrustError("origin-mismatch", "trustedKey origin != bundle origin")
        k_id = _require_str(entry["keyId"], "keyId", 128)
        _require_str(entry["publicKey"], "publicKey", 256)
        _decode_b64url(entry["publicKey"])
        if k_id in key_ids:
            raise SkillTrustError("invalid-schema", "duplicate trusted key")
        key_ids.add(k_id)
    for rev in revs:
        _parse_revocation(rev)
    if "skills" in raw:
        skills = raw["skills"]
        if not isinstance(skills, dict) or len(skills) > MAX_SKILL_PINS:
            raise SkillTrustError("invalid-schema", "invalid skills pin map")
        for sid, dig in skills.items():
            if not isinstance(sid, str) or not _ID_RE.fullmatch(sid):
                raise SkillTrustError("invalid-schema", "invalid pin skillId")
            if not isinstance(dig, str) or not _HEX64_RE.fullmatch(dig):
                raise SkillTrustError("invalid-schema", "invalid pin digest")
    return raw


def _parse_revocation(rev: Any) -> dict:
    if not isinstance(rev, dict) or rev.get("kind") not in ("key", "skill"):
        raise SkillTrustError("invalid-schema", "invalid revocation")
    if rev["kind"] == "key":
        _require_exact_keys(rev, {"kind", "keyId", "revokedAt"}, {"reason"})
        _require_str(rev["keyId"], "keyId", 128)
        _parse_iso_ms(rev["revokedAt"])
        if "reason" in rev:
            _require_str(rev["reason"], "reason", 256)
    else:
        _require_exact_keys(rev, {"kind", "skillId", "revokedAt"}, {"digest", "reason"})
        _require_str(rev["skillId"], "skillId", 512)
        _parse_iso_ms(rev["revokedAt"])
        if "digest" in rev:
            _require_str(rev["digest"], "digest", 512)
        if "reason" in rev:
            _require_str(rev["reason"], "reason", 256)
    return rev


def _bundle_unsigned(bundle: dict) -> dict:
    return {k: v for k, v in bundle.items() if k != "signature"}


_ENVELOPE_KEYS = {
    "formatVersion",
    "origin",
    "skillId",
    "keyId",
    "digest",
    "manifestBytes",
    "skillBytes",
    "signature",
}


def parse_envelope(raw: dict) -> dict:
    """Strict-exact-keys parse of a REMOTE_PKG_V1 envelope (§5.3)."""
    _require_exact_keys(raw, _ENVELOPE_KEYS)
    if raw["formatVersion"] != 1:
        raise SkillTrustError("invalid-schema", "envelope formatVersion")
    _require_str(raw["origin"], "origin", 512)
    sid = _require_str(raw["skillId"], "skillId", 512)
    if not _ID_RE.fullmatch(sid):
        raise SkillTrustError("invalid-schema", "skillId shape")
    _require_str(raw["keyId"], "keyId", 128)
    digest = _require_str(raw["digest"], "digest", 512)
    if not _HEX64_RE.fullmatch(digest):
        # Raw hex only; a sha256:-prefixed value is invalid-schema, never
        # silently normalized (R-3).
        raise SkillTrustError("invalid-schema", "digest must be raw lowercase hex")
    _require_str(raw["signature"], "signature", 128)
    _require_str(raw["manifestBytes"], "manifestBytes", MAX_CANONICAL_PAYLOAD_BYTES * 8)
    _require_str(raw["skillBytes"], "skillBytes", MAX_CANONICAL_PAYLOAD_BYTES * 8)
    return raw


def _envelope_signed_payload(env: dict) -> dict:
    # The signed payload is exactly {digest, keyId, origin, skillId} (§5.3).
    return {
        "digest": env["digest"],
        "keyId": env["keyId"],
        "origin": env["origin"],
        "skillId": env["skillId"],
    }


# ---------------------------------------------------------------------------
# The trust engine
# ---------------------------------------------------------------------------


def _now_ms() -> int:
    return int(time.time() * 1000)


class TrustEngine:
    """Origin-scoped Ed25519 trust state with atomic persistence and a clock.

    One instance per kernel process, constructed at ``governed_skills._store()``
    and injected into ``VerifiedSkillStore``. The lock is a global-order LEAF.
    """

    def __init__(
        self,
        trust_dir: str | os.PathLike[str],
        authorities: dict[str, list[dict]],
        *,
        now: Any = _now_ms,
        max_freshness_ms: int = DEFAULT_MAX_FRESHNESS_MS,
        max_future_skew_ms: int = DEFAULT_MAX_FUTURE_SKEW_MS,
        max_clock_rollback_ms: int = DEFAULT_MAX_CLOCK_ROLLBACK_MS,
    ):
        self._lock = threading.RLock()
        self._trust_dir = Path(trust_dir).absolute()
        self._bundles_dir = self._trust_dir / "bundles"
        self._artifacts_dir = self._trust_dir / "artifacts"
        self._clock_path = self._trust_dir / "clock.json"
        self._now = now
        self._max_freshness_ms = max_freshness_ms
        self._max_future_skew_ms = max_future_skew_ms
        self._max_clock_rollback_ms = max_clock_rollback_ms

        # authorities: {origin: [{keyId, publicKey}, ...]} from skill_sources.json.
        # {origin: {keyId: (Ed25519PublicKey, spki_b64url)}}
        self._authorities: dict[str, dict[str, tuple[Ed25519PublicKey, str]]] = {}
        for origin, entries in authorities.items():
            per: dict[str, tuple[Ed25519PublicKey, str]] = {}
            for entry in entries:
                key = load_public_key(entry["publicKey"])
                per[entry["keyId"]] = (key, entry["publicKey"])
            self._authorities[origin] = per

        # Accepted state per origin: {origin: {"bundle": dict, "acceptedAt": ms,
        #   "keys": {keyId: Ed25519PublicKey}, "revokedKeyIds": set, "pins": dict}}
        self._states: dict[str, dict[str, Any]] = {}
        self._last_observed_now_ms: int | None = None
        self._clock_rollback = False

        self._trust_dir.mkdir(parents=True, exist_ok=True)
        self._bundles_dir.mkdir(exist_ok=True)
        self._artifacts_dir.mkdir(exist_ok=True)
        self._restore()

    # -- clock discipline (§5.6) --------------------------------------------

    def _observe_clock(self) -> int | None:
        try:
            current = self._now()
        except Exception:  # noqa: BLE001
            return None
        if not isinstance(current, (int, float)) or current != current:  # NaN check
            return None
        current = int(current)
        if (
            self._last_observed_now_ms is not None
            and current < self._last_observed_now_ms - self._max_clock_rollback_ms
        ):
            self._clock_rollback = True
            self._persist_clock()
            return current
        if self._last_observed_now_ms is None or current > self._last_observed_now_ms:
            self._last_observed_now_ms = current
        return current

    # -- persistence (§5.6) -------------------------------------------------

    def _restore(self) -> None:
        # clock.json first (global evidence).
        if self._clock_path.exists():
            try:
                raw = _load_bounded_json(self._clock_path)
                if raw.get("schemaVersion") == 1:
                    lo = raw.get("lastObservedNowMs")
                    if isinstance(lo, (int, float)) and lo == lo:
                        self._last_observed_now_ms = int(lo)
                    if raw.get("clockRollbackDetected") is True:
                        self._clock_rollback = True
                else:
                    self._clock_rollback = True
            except Exception:  # noqa: BLE001
                self._clock_rollback = True
        # Each persisted bundle is re-verified against current authorities.
        if self._bundles_dir.is_dir():
            for path in sorted(self._bundles_dir.glob("*.json")):
                try:
                    stored = _load_bounded_json(path)
                    bundle = stored["bundle"]
                    accepted_at = int(stored["acceptedAt"])
                    configured_origin = stored.get("configuredOrigin")
                    # N-3: the persisted origin must equal the current
                    # configured origin for this sourceId; otherwise a config
                    # repoint would inherit another origin's accepted bundle.
                    source_id = path.stem
                    self._accept_persisted(source_id, configured_origin, bundle, accepted_at)
                except Exception:  # noqa: BLE001
                    # Corrupt/unverifiable persisted state fails closed into
                    # clock-rollback quarantine, recoverable only by a strictly
                    # newer accepted bundle.
                    self._clock_rollback = True

    def _accept_persisted(
        self, source_id: str, configured_origin: Any, bundle: dict, accepted_at: int
    ) -> None:
        parsed = _parse_bundle(bundle)
        origin = parsed["origin"]
        if configured_origin is not None and configured_origin != origin:
            raise SkillTrustError("origin-mismatch", "persisted origin != configured")
        self._verify_bundle_signature(parsed)
        self._commit_state(source_id, origin, parsed, accepted_at)

    def _persist_clock(self) -> None:
        try:
            _atomic_write_json(
                self._clock_path,
                {
                    "schemaVersion": 1,
                    "lastObservedNowMs": self._last_observed_now_ms,
                    "clockRollbackDetected": self._clock_rollback,
                },
            )
        except Exception:  # noqa: BLE001
            # Persistence failure must never turn a verified request into an
            # unverified success -- quarantine ALL origins (clock is global).
            self._clock_rollback = True

    def _persist_bundle(self, source_id: str, origin: str, bundle: dict, accepted_at: int) -> None:
        try:
            _atomic_write_json(
                self._bundles_dir / f"{source_id}.json",
                {"bundle": bundle, "acceptedAt": accepted_at, "configuredOrigin": origin},
            )
        except Exception:  # noqa: BLE001
            # bundles/<sourceId>.json persist failure quarantines THAT origin
            # only (O-16). Drop the accepted state so the next op fails closed.
            self._states.pop(origin, None)
            raise SkillTrustError("stale", "bundle persistence failed")

    # -- authority / signature helpers --------------------------------------

    def _verify_bundle_signature(self, parsed: dict) -> None:
        origin = parsed["origin"]
        signing_key_id = parsed["signingKeyId"]
        per = self._authorities.get(origin)
        if not per or signing_key_id not in per:
            # Distinguish origin-mismatch (key exists under another origin).
            for o, keys in self._authorities.items():
                if o != origin and signing_key_id in keys:
                    raise SkillTrustError("origin-mismatch")
            raise SkillTrustError("unknown-authority-key")
        key, _ = per[signing_key_id]
        if not verify_signature(_bundle_unsigned(parsed), parsed["signature"], key):
            raise SkillTrustError("signature-invalid")

    def _check_freshness(self, bundle: dict, now: int) -> None:
        issued = _parse_iso_ms(bundle["issuedAt"])
        next_update = _parse_iso_ms(bundle["nextUpdate"])
        if next_update <= issued or (next_update - issued) > self._max_freshness_ms:
            raise SkillTrustError("invalid-freshness")
        if issued > now + self._max_future_skew_ms:
            raise SkillTrustError("future-issued")
        if now > next_update:
            raise SkillTrustError("stale")
        if now < issued - self._max_future_skew_ms:
            raise SkillTrustError("trust-not-yet-valid")

    def _commit_state(self, source_id: str, origin: str, parsed: dict, accepted_at: int) -> None:
        keys: dict[str, Ed25519PublicKey] = {}
        for entry in parsed["trustedKeys"]:
            keys[entry["keyId"]] = load_public_key(entry["publicKey"])
        revoked_key_ids = {
            r["keyId"] for r in parsed["revocations"] if r["kind"] == "key"
        }
        self._states[origin] = {
            "sourceId": source_id,
            "bundle": parsed,
            "acceptedAt": accepted_at,
            "keys": keys,
            "revokedKeyIds": revoked_key_ids,
            "pins": dict(parsed.get("skills", {})),
        }

    # -- bundle acceptance (§5.2) -------------------------------------------

    def apply_bundle(self, source_id: str, expected_origin: str, bundle: Any) -> dict:
        """Verify + monotonically accept a signed bundle. Returns a decision dict.

        Fetched outside all locks; this method takes the trust lock only for the
        accept/persist critical section (SP-9). Raises ``SkillTrustError`` on
        every refusal (fail-closed), so a caller maps the reason uniformly.
        """
        with self._lock:
            now = self._observe_clock()
            if now is None:
                raise SkillTrustError("clock-unavailable")
            try:
                parsed = _parse_bundle(bundle) if isinstance(bundle, dict) else _require_exact_keys(bundle, _BUNDLE_KEYS)
            except SkillTrustError:
                raise
            if parsed["origin"] != expected_origin:
                raise SkillTrustError("origin-mismatch")
            # canonical size bound is enforced inside verify via canonicalize.
            self._verify_bundle_signature(parsed)
            self._check_freshness(parsed, now)
            prev = self._states.get(parsed["origin"])
            if prev is not None:
                if parsed["sequence"] <= prev["bundle"]["sequence"]:
                    raise SkillTrustError("sequence-not-monotonic")
                if _parse_iso_ms(parsed["issuedAt"]) <= _parse_iso_ms(prev["bundle"]["issuedAt"]):
                    raise SkillTrustError("issued-at-not-monotonic")
            accepted_at = now
            self._commit_state(source_id, parsed["origin"], parsed, accepted_at)
            self._clock_rollback = False
            self._persist_clock()
            self._persist_bundle(source_id, parsed["origin"], parsed, accepted_at)
            return {
                "accepted": True,
                "origin": parsed["origin"],
                "sequence": parsed["sequence"],
            }

    # -- freshness re-check at decision seams (§6.3) ------------------------

    def require_fresh_origin(self, origin: str) -> dict:
        """Return the accepted state for ``origin`` iff usable now.

        Fail-closed: raises on clock-rollback, unknown-origin, stale (freshness
        or acceptedAt+72h hard expiry). Reads local state only -- NO network
        (RS-4). Callable under ``_MUTATION_LOCK``.
        """
        with self._lock:
            now = self._observe_clock()
            if now is None:
                raise SkillTrustError("clock-unavailable")
            if self._clock_rollback:
                raise SkillTrustError("clock-rollback")
            state = self._states.get(origin)
            if state is None:
                raise SkillTrustError("unknown-origin")
            self._check_freshness(state["bundle"], now)
            if now > state["acceptedAt"] + HARD_EXPIRY_MS:
                raise SkillTrustError("stale")
            return state

    # -- package/artifact evaluation (§5.3 verification order) --------------

    def evaluate_artifact(
        self,
        origin: str,
        skill_id: str,
        key_id: str,
        digest: str,
        signature: str,
        required_capabilities: list[str],
    ) -> None:
        """Full trust evaluation for a remote package identity (§5.3 order).

        ``digest`` MUST already have been computed independently from the fetched
        bytes and compared to the envelope's claimed digest by the caller BEFORE
        this is invoked (R-3, digest-mismatch is the caller's arm). Here we
        evaluate freshness, key trust/revocation, signature over the identity,
        skill revocation, digest-pin, and the capability bound.

        Fail-closed: raises ``SkillTrustError`` on any refusal. Reads local
        state only.
        """
        with self._lock:
            state = self.require_fresh_origin(origin)
            keys = state["keys"]
            if key_id not in keys:
                for o, s in self._states.items():
                    if o != origin and key_id in s["keys"]:
                        raise SkillTrustError("origin-mismatch")
                raise SkillTrustError("untrusted-key")
            if key_id in state["revokedKeyIds"]:
                raise SkillTrustError("revoked-key")
            payload = {
                "digest": digest,
                "keyId": key_id,
                "origin": origin,
                "skillId": skill_id,
            }
            if not verify_signature(payload, signature, keys[key_id]):
                raise SkillTrustError("signature-invalid")
            # Skill revocation scan (digest-optional) BEFORE pin check -- so a
            # digest that is both pinned-mismatched and revoked resolves to
            # revoked-skill (F-2, §5.3).
            for rev in state["bundle"]["revocations"]:
                if rev["kind"] != "skill":
                    continue
                if rev["skillId"] != skill_id:
                    continue
                if "digest" not in rev or rev["digest"] == digest:
                    raise SkillTrustError("revoked-skill")
            # Digest pin (anti-rollback, O-1).
            pins = state["pins"]
            if skill_id in pins and pins[skill_id] != digest:
                raise SkillTrustError("digest-not-current")
            # Capability bound (R-7 pilot).
            if not set(required_capabilities) <= {"read"}:
                raise SkillTrustError("capability-unsupported")

    # -- artifact evidence persistence (§5.6) -------------------------------

    def persist_artifact_record(
        self, skill_id: str, digest: str, origin: str, key_id: str, signature: str
    ) -> None:
        """Persist the verified identity envelope so §6.3 can re-verify later."""
        if not _ID_RE.fullmatch(skill_id) or not _HEX64_RE.fullmatch(digest):
            raise SkillTrustError("invalid-schema", "artifact record identity")
        with self._lock:
            skill_dir = self._artifacts_dir / skill_id
            skill_dir.mkdir(exist_ok=True)
            _atomic_write_json(
                skill_dir / f"{digest}.json",
                {
                    "origin": origin,
                    "skillId": skill_id,
                    "keyId": key_id,
                    "digest": digest,
                    "signature": signature,
                },
            )

    def load_artifact_record(self, skill_id: str, digest: str) -> dict:
        if not _ID_RE.fullmatch(skill_id) or not _HEX64_RE.fullmatch(digest):
            raise SkillTrustError("artifact-record-missing")
        path = self._artifacts_dir / skill_id / f"{digest}.json"
        if not path.is_file():
            raise SkillTrustError("artifact-record-missing")
        try:
            record = _load_bounded_json(path)
        except Exception:  # noqa: BLE001
            raise SkillTrustError("artifact-record-missing")
        if record.get("digest") != digest or record.get("skillId") != skill_id:
            raise SkillTrustError("artifact-record-missing")
        return record

    def evaluate_installed(
        self, skill_id: str, digest: str, required_capabilities: list[str]
    ) -> None:
        """Re-verify an installed remote version at the §6.3 activation/rollback
        seam using the persisted artifact record (RS-2). Local-state only.

        The origin is read from the durable artifact record itself, so the seam
        never has to independently know which origin's state to evaluate -- a
        missing/corrupt record refuses ``artifact-record-missing`` (fail-closed).
        """
        record = self.load_artifact_record(skill_id, digest)
        self.evaluate_artifact(
            origin=record["origin"],
            skill_id=skill_id,
            key_id=record["keyId"],
            digest=digest,
            signature=record["signature"],
            required_capabilities=required_capabilities,
        )

    # -- O-2 revocation-vs-installed reporting ------------------------------

    def scan_revocations_for(self, origin: str, installed: list[dict]) -> list[dict]:
        """Given [{skillId, digest, keyId, active}], return the subset the
        origin's current bundle revokes or pins-out. Reporting only."""
        with self._lock:
            state = self._states.get(origin)
            if state is None:
                return []
            revs = state["bundle"]["revocations"]
            pins = state["pins"]
            hits: list[dict] = []
            for rec in installed:
                sid = rec["skillId"]
                dig = rec["digest"]
                kid = rec.get("keyId")
                affected = False
                if kid in state["revokedKeyIds"]:
                    affected = True
                for rev in revs:
                    if rev["kind"] != "skill" or rev["skillId"] != sid:
                        continue
                    if "digest" not in rev or rev["digest"] == dig:
                        affected = True
                if sid in pins and pins[sid] != dig:
                    affected = True
                if affected:
                    hits.append({"skillId": sid, "digest": dig, "active": rec.get("active", False)})
            return hits


# ---------------------------------------------------------------------------
# Bounded reads / atomic writes (mirror verified_skill_store discipline, O-8)
# ---------------------------------------------------------------------------

_MAX_TRUST_FILE_BYTES = 512 * 1024


def _load_bounded_json(path: Path) -> Any:
    with path.open("rb") as handle:
        raw = handle.read(_MAX_TRUST_FILE_BYTES + 1)
    if len(raw) > _MAX_TRUST_FILE_BYTES:
        raise SkillTrustError("invalid-schema", f"{path.name} exceeds byte limit")
    return json.loads(raw.decode("utf-8"))


def _atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temp.open("wb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temp, path)
    except Exception:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass
        raise


def compute_package_digest(manifest_bytes: bytes, skill_bytes: bytes) -> str:
    """Raw lowercase hex sha256(manifest + 0x00 + skill) -- matches
    ``verified_skill_store.package_digest`` (R-3). Duplicated deliberately so
    the trust engine has no import edge into the store."""
    return hashlib.sha256(manifest_bytes + b"\x00" + skill_bytes).hexdigest()
