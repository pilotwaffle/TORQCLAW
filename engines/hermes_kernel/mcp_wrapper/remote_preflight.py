"""Doctor conditional preflight for remote skill sources (P4-3, R-5, N-4).

Invoked as ``python -m mcp_wrapper.remote_preflight`` by ``ops/doctor-core.mjs``
ONLY when ``TORQCLAW_REMOTE_SKILL_SOURCES`` is truthy. Exit 0 = pass; any
non-zero = a red ``preflight.remote-skill-sources`` record on the doctor side.

Checks, all fail-closed:
  1. ``skill_sources.json`` parses under the strict §5.5 parser.
  2. Every configured authority ``publicKey`` parses as a valid Ed25519 SPKI
     public key (N-4).
  3. ``$TORQCLAW_DATA_DIR/skill_trust/`` is writable.
"""

from __future__ import annotations

import sys
import uuid


def main() -> int:
    from . import skill_sources
    from .skill_trust import load_public_key, SkillTrustError

    try:
        config = skill_sources.load_config()
    except Exception as exc:  # noqa: BLE001
        print(f"skill_sources.json invalid: {exc}", file=sys.stderr)
        return 1

    # N-4: every authority publicKey must parse as a valid Ed25519 SPKI key.
    for source_id, spec in config["sources"].items():
        for auth in spec["authorities"]:
            try:
                load_public_key(auth["publicKey"])
            except SkillTrustError as exc:
                print(
                    f"authority key {source_id}/{auth['keyId']} invalid: {exc}",
                    file=sys.stderr,
                )
                return 1

    # Trust store writability.
    trust_dir = skill_sources.trust_dir()
    try:
        trust_dir.mkdir(parents=True, exist_ok=True)
        probe = trust_dir / f".preflight-{uuid.uuid4().hex}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except Exception as exc:  # noqa: BLE001
        print(f"skill_trust/ not writable: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
