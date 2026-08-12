"""Remote skill source configuration + bounded HTTPS fetcher (Phase 4).

Two concerns, deliberately colocated because both are the kernel's outbound
edge for remote sources and neither exists anywhere else:

- Config (P4-3): parse ``$TORQCLAW_DATA_DIR/skill_sources.json`` (§5.5) with a
  strict exact-keys parser, public-keys-only, bounded. Parse failure makes
  remote sources ENTIRELY unavailable (never partial). The remote flag is read
  per-call.
- Fetch (P4-4): bounded HTTPS-only download using the ``limit+1`` idiom, no
  redirects, timeouts, entirely BEFORE the ActivationCoordinator lock (RS-4).
  No archives -- a flat JSON envelope (§5.3).

Public keys only: this repository is public and the trust model is
asymmetric-key by design. A value that parses as a private key is refused.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import urllib.request
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError

_TRUTHY = {"1", "true", "yes", "on"}
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

MAX_CONFIG_BYTES = 256 * 1024
MAX_BUNDLE_BYTES = 256 * 1024
# Envelope cap reuses MAX_PACKAGE_BYTES (2 MiB).
MAX_ENVELOPE_BYTES = 2 * 1024 * 1024
MAX_SOURCES = 16
MAX_AUTHORITY_KEYS = 8
DEFAULT_CONNECT_TIMEOUT_MS = 10000
DEFAULT_READ_TIMEOUT_MS = 30000

_CONFIG_KEYS = {"schemaVersion", "sources"}
_SOURCE_KEYS = {"origin", "baseUrl", "authorities"}
_SOURCE_OPTIONAL = {"connectTimeoutMs", "readTimeoutMs"}
_AUTHORITY_KEYS = {"keyId", "publicKey"}


class SkillRemoteConfigError(Exception):
    """skill_sources.json missing or invalid while the flag is on."""


class SkillRemoteSourceUnknown(Exception):
    """A requested sourceId is not in the config."""


class SkillRemoteFetchError(Exception):
    """Network / timeout / redirect-response / TLS failure (retryable)."""


def remote_flag_on() -> bool:
    """Read TORQCLAW_REMOTE_SKILL_SOURCES per-call (never captured at import)."""
    return os.environ.get("TORQCLAW_REMOTE_SKILL_SOURCES", "").strip().lower() in _TRUTHY


def _data_dir() -> Path:
    return Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw")


def config_path() -> Path:
    return _data_dir() / "skill_sources.json"


def trust_dir() -> Path:
    return _data_dir() / "skill_trust"


def _require_str(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise SkillRemoteConfigError(f"invalid {name}")
    return value


def _read_bounded(path: Path, limit: int) -> bytes:
    with path.open("rb") as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise SkillRemoteConfigError(f"{path.name} exceeds byte limit")
    return raw


def _looks_like_private_key(value: str) -> bool:
    # Refuse anything that parses as a private key PEM/DER (public-key-only).
    if "PRIVATE KEY" in value:
        return True
    return False


def load_config() -> dict:
    """Parse skill_sources.json strictly. Raises SkillRemoteConfigError on any
    problem so remote sources are entirely unavailable (never partial)."""
    path = config_path()
    if not path.is_file():
        raise SkillRemoteConfigError("skill_sources.json is absent")
    raw = _read_bounded(path, MAX_CONFIG_BYTES)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SkillRemoteConfigError("skill_sources.json is not valid JSON") from exc
    if not isinstance(data, dict) or set(data) != _CONFIG_KEYS:
        raise SkillRemoteConfigError("skill_sources.json unexpected fields")
    if data["schemaVersion"] != 1:
        raise SkillRemoteConfigError("skill_sources.json schemaVersion")
    sources = data["sources"]
    if not isinstance(sources, dict) or len(sources) > MAX_SOURCES:
        raise SkillRemoteConfigError("sources must be a bounded object")
    for source_id, spec in sources.items():
        if not isinstance(source_id, str) or not _ID_RE.fullmatch(source_id):
            raise SkillRemoteConfigError("invalid sourceId")
        if not isinstance(spec, dict) or not _SOURCE_KEYS <= set(spec) or not set(spec) <= (_SOURCE_KEYS | _SOURCE_OPTIONAL):
            raise SkillRemoteConfigError("source unexpected fields")
        origin = _require_str(spec["origin"], "origin", 512)
        base_url = _require_str(spec["baseUrl"], "baseUrl", 1024)
        if not origin.startswith("https://"):
            raise SkillRemoteConfigError("origin must be https")
        if not base_url.startswith("https://"):
            raise SkillRemoteConfigError("baseUrl must be https")
        if not base_url.startswith(origin):
            raise SkillRemoteConfigError("baseUrl must be within origin")
        authorities = spec["authorities"]
        if not isinstance(authorities, list) or not authorities or len(authorities) > MAX_AUTHORITY_KEYS:
            raise SkillRemoteConfigError("authorities must be a bounded non-empty list")
        for auth in authorities:
            if not isinstance(auth, dict) or set(auth) != _AUTHORITY_KEYS:
                raise SkillRemoteConfigError("authority unexpected fields")
            _require_str(auth["keyId"], "keyId", 128)
            pk = _require_str(auth["publicKey"], "publicKey", 256)
            if _looks_like_private_key(pk):
                raise SkillRemoteConfigError("private key material is forbidden")
        for opt in ("connectTimeoutMs", "readTimeoutMs"):
            if opt in spec:
                v = spec[opt]
                if isinstance(v, bool) or not isinstance(v, int) or v <= 0 or v > 600000:
                    raise SkillRemoteConfigError(f"invalid {opt}")
    return data


def resolve_source(config: dict, source_id: str) -> dict:
    sources = config["sources"]
    if source_id not in sources:
        raise SkillRemoteSourceUnknown(source_id)
    return sources[source_id]


def authorities_map(config: dict) -> dict[str, list[dict]]:
    """{origin: [{keyId, publicKey}, ...]} for TrustEngine construction."""
    result: dict[str, list[dict]] = {}
    for spec in config["sources"].values():
        origin = spec["origin"]
        result.setdefault(origin, [])
        for auth in spec["authorities"]:
            result[origin].append({"keyId": auth["keyId"], "publicKey": auth["publicKey"]})
    return result


# ---------------------------------------------------------------------------
# Bounded HTTPS fetch (P4-4): HTTPS only, no redirects, timeouts, limit+1.
# ---------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect (limit 0, R-2). A 3xx is a fetch failure."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        raise SkillRemoteFetchError(f"redirect refused ({code})")


def _fetch_bounded(url: str, limit: int, connect_ms: int, read_ms: int) -> bytes:
    if not url.startswith("https://"):
        raise SkillRemoteFetchError("HTTPS only")
    ctx = ssl.create_default_context()  # system trust, hostname verification on
    opener = urllib.request.build_opener(_NoRedirect(), urllib.request.HTTPSHandler(context=ctx))
    timeout = max(connect_ms, read_ms) / 1000.0
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with opener.open(req, timeout=timeout) as resp:
            if getattr(resp, "status", 200) >= 300:
                raise SkillRemoteFetchError(f"non-2xx ({resp.status})")
            # limit+1 idiom: read one over the cap; more than limit => refuse.
            data = resp.read(limit + 1)
    except SkillRemoteFetchError:
        raise
    except HTTPError as exc:
        raise SkillRemoteFetchError(f"http error {exc.code}") from exc
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        raise SkillRemoteFetchError(str(exc)) from exc
    if len(data) > limit:
        raise SkillRemoteFetchError("response exceeds byte limit")
    return data


def _timeouts(spec: dict) -> tuple[int, int]:
    return (
        int(spec.get("connectTimeoutMs", DEFAULT_CONNECT_TIMEOUT_MS)),
        int(spec.get("readTimeoutMs", DEFAULT_READ_TIMEOUT_MS)),
    )


def fetch_bundle(spec: dict) -> dict:
    """Fetch ``<baseUrl>/trust-bundle.json`` (bounded, no redirect)."""
    connect_ms, read_ms = _timeouts(spec)
    url = spec["baseUrl"].rstrip("/") + "/trust-bundle.json"
    raw = _fetch_bounded(url, MAX_BUNDLE_BYTES, connect_ms, read_ms)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SkillRemoteFetchError("bundle is not valid JSON") from exc


def fetch_envelope(spec: dict, skill_id: str) -> dict:
    """Fetch ``<baseUrl>/skills/<skillId>.json`` (bounded, no redirect)."""
    connect_ms, read_ms = _timeouts(spec)
    url = spec["baseUrl"].rstrip("/") + f"/skills/{skill_id}.json"
    raw = _fetch_bounded(url, MAX_ENVELOPE_BYTES, connect_ms, read_ms)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SkillRemoteFetchError("envelope is not valid JSON") from exc
