#!/usr/bin/env python3
"""P4-9: offline signing CLI for signed remote skill sources.

PRD-TCLAW-REMOTE-SKILL-SOURCES-005 §13. Operator-run, stdlib +
``cryptography`` only. IMPORTS ``TCJSON_V1`` (``canonicalize``) and the
schema constants from ``mcp_wrapper.skill_trust`` -- it NEVER re-implements
canonicalization (SP-4/DP-11): the engine is the single source of truth, and
a second implementation of canonical JSON is a signature-forgery seam
waiting for a divergence.

Subcommands:
  keygen       Write a private key PEM + print the public SPKI b64url.
  sign-bundle  Assemble + sign a TRUST_BUNDLE_V1 document. Enforces monotonic
               sequence/issuedAt against a previous bundle file, if given.
  sign-skill   Take skill.json + SKILL.md paths, compute the package digest
               itself, emit a REMOTE_PKG_V1 envelope.
  verify       Round-trip self-check: verify a signed bundle or envelope
               against a supplied public key.

PRIVATE KEYS NEVER IN THE REPO OR IN ENVIRONMENT VARIABLES. Key paths are
supplied at invocation (--key <path>). This CLI refuses to run against a key
file located inside the repository working tree or inside
$TORQCLAW_DATA_DIR (path containment check) -- this repository is public.

Windows storage location (PRD §13, resolves PRD-001 §17 L450): operator keys
live in an operator-owned directory adjacent to the data dir -- default
``~/.torqclaw-signing/`` (sibling of the default ``~/.torqclaw``),
deliberately OUTSIDE $TORQCLAW_DATA_DIR so data-dir backups/exports/support
bundles can never sweep private key material. NTFS ACL hardening (icacls)
is the operator's responsibility -- guidance, not enforcement.

Signing order (O-15): sign-skill writes the in-manifest signature stub
({"algorithm": "Ed25519", "keyId": "<id>", "value": "detached"}) into
skill.json BEFORE computing the package digest, then signs the digest -- the
manifest bytes are hashed WITH the stub in place. A hand-rolling publisher
who hashes first and stubs second will produce a first-attempt
digest-mismatch; this file's docstring and --help text exist so they don't.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path
from typing import Any

_KERNEL_ROOT = Path(__file__).resolve().parents[1] / "engines" / "hermes_kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: E402
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

# SP-4/DP-11: imported, never re-implemented. `canonicalize` is TCJSON_V1;
# the constants below are the same frozen bounds/schema the engine enforces,
# imported so this CLI cannot silently drift from them either.
from mcp_wrapper.skill_trust import (  # noqa: E402
    SkillTrustError,
    canonicalize,
    compute_package_digest,
    load_public_key,
    public_key_spki_b64url,
    verify_signature,
)


class SigningError(Exception):
    """A signing-CLI-specific operator error (never a trust-engine reason)."""


# ---------------------------------------------------------------------------
# Path containment (private keys never in the repo or $TORQCLAW_DATA_DIR)
# ---------------------------------------------------------------------------


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _data_dir() -> Path:
    import os

    return Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw").resolve()


def _refuse_if_inside(path: Path, forbidden_root: Path, label: str) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(forbidden_root)
    except ValueError:
        return
    raise SigningError(
        f"refusing to use a key file inside {label} ({forbidden_root}); "
        "private key material must never be reachable from a repo checkout "
        "or a $TORQCLAW_DATA_DIR backup/export -- see PRD §13 and the "
        "default ~/.torqclaw-signing/ location"
    )


def _check_key_path_containment(path: Path) -> None:
    _refuse_if_inside(path, _repo_root(), "the repository working tree")
    _refuse_if_inside(path, _data_dir(), "$TORQCLAW_DATA_DIR")


def default_signing_dir() -> Path:
    """~/.torqclaw-signing/ -- a sibling of ~/.torqclaw, deliberately
    outside $TORQCLAW_DATA_DIR (PRD §13)."""
    return Path.home() / ".torqclaw-signing"


# ---------------------------------------------------------------------------
# keygen
# ---------------------------------------------------------------------------


def cmd_keygen(args: argparse.Namespace) -> int:
    key_path = Path(args.key).resolve()
    _check_key_path_containment(key_path)
    if key_path.exists() and not args.force:
        raise SigningError(f"{key_path} already exists; pass --force to overwrite")

    private_key = Ed25519PrivateKey.generate()
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(pem)
    try:
        key_path.chmod(0o600)
    except OSError:
        pass  # best-effort on platforms without POSIX permission bits

    public_b64url = public_key_spki_b64url(private_key.public_key())
    print(f"private key written: {key_path}")
    print(f"public key (SPKI, unpadded base64url): {public_b64url}")
    return 0


def _load_private_key(key_path_str: str) -> Ed25519PrivateKey:
    key_path = Path(key_path_str).resolve()
    _check_key_path_containment(key_path)
    if not key_path.is_file():
        raise SigningError(f"key file not found: {key_path}")
    pem = key_path.read_bytes()
    key = serialization.load_pem_private_key(pem, password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise SigningError(f"{key_path} is not an Ed25519 private key")
    return key


# ---------------------------------------------------------------------------
# sign-bundle (TRUST_BUNDLE_V1, §5.2)
# ---------------------------------------------------------------------------


def _iso_ms(dt: Any) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def cmd_sign_bundle(args: argparse.Namespace) -> int:
    import datetime

    authority_key = _load_private_key(args.key)
    trusted_keys = json.loads(Path(args.trusted_keys).read_text(encoding="utf-8"))
    revocations = json.loads(Path(args.revocations).read_text(encoding="utf-8")) if args.revocations else []
    skills = json.loads(Path(args.skills).read_text(encoding="utf-8")) if args.skills else None

    now = datetime.datetime.now(tz=datetime.timezone.utc)
    next_update = now + datetime.timedelta(hours=args.freshness_hours)

    sequence = args.sequence
    if args.previous:
        prev = json.loads(Path(args.previous).read_text(encoding="utf-8"))
        if sequence <= prev["sequence"]:
            raise SigningError(
                f"--sequence {sequence} must be strictly greater than the "
                f"previous bundle's sequence {prev['sequence']} (monotonicity, §5.2)"
            )
        if _iso_ms(now) <= prev["issuedAt"]:
            raise SigningError(
                "issuedAt (now) is not strictly greater than the previous "
                "bundle's issuedAt -- wait a moment and retry"
            )

    bundle: dict[str, Any] = {
        "version": 1,
        "origin": args.origin,
        "sequence": sequence,
        "issuedAt": _iso_ms(now),
        "nextUpdate": _iso_ms(next_update),
        "trustedKeys": trusted_keys,
        "revocations": revocations,
        "signingKeyId": args.signing_key_id,
    }
    if skills is not None:
        bundle["skills"] = skills

    signature = authority_key.sign(canonicalize(bundle))
    bundle["signature"] = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")

    output = Path(args.output)
    output.write_text(json.dumps(bundle, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    print(f"signed bundle written: {output} (sequence={sequence})")
    return 0


# ---------------------------------------------------------------------------
# sign-skill (REMOTE_PKG_V1, §5.3)
# ---------------------------------------------------------------------------


def cmd_sign_skill(args: argparse.Namespace) -> int:
    publisher_key = _load_private_key(args.key)
    manifest_path = Path(args.manifest)
    skill_path = Path(args.skill_md)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # O-15: write the signature stub BEFORE computing the digest -- the
    # manifest bytes are hashed WITH the stub in place.
    manifest["signature"] = {"algorithm": "Ed25519", "keyId": args.key_id, "value": "detached"}
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    skill_bytes = skill_path.read_bytes()

    digest = compute_package_digest(manifest_bytes, skill_bytes)
    payload = {"digest": digest, "keyId": args.key_id, "origin": args.origin, "skillId": manifest["id"]}
    signature = publisher_key.sign(canonicalize(payload))
    signature_b64 = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")

    envelope = {
        "formatVersion": 1,
        "origin": args.origin,
        "skillId": manifest["id"],
        "keyId": args.key_id,
        "digest": digest,
        "manifestBytes": base64.urlsafe_b64encode(manifest_bytes).rstrip(b"=").decode("ascii"),
        "skillBytes": base64.urlsafe_b64encode(skill_bytes).rstrip(b"=").decode("ascii"),
        "signature": signature_b64,
    }

    # Also write the stubbed manifest back out, if requested, so a publisher
    # can inspect exactly what bytes were hashed (O-15 transparency).
    if args.write_manifest:
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )

    output = Path(args.output)
    output.write_text(json.dumps(envelope, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    print(f"signed envelope written: {output}")
    print(f"digest: {digest}")
    return 0


# ---------------------------------------------------------------------------
# verify (round-trip self-check)
# ---------------------------------------------------------------------------


def cmd_verify(args: argparse.Namespace) -> int:
    public_key = load_public_key(Path(args.public_key).read_text(encoding="utf-8").strip())
    document = json.loads(Path(args.document).read_text(encoding="utf-8"))

    if args.kind == "bundle":
        signature = document["signature"]
        unsigned = {k: v for k, v in document.items() if k != "signature"}
        ok = verify_signature(unsigned, signature, public_key)
    elif args.kind == "envelope":
        signature = document["signature"]
        payload = {
            "digest": document["digest"],
            "keyId": document["keyId"],
            "origin": document["origin"],
            "skillId": document["skillId"],
        }
        ok = verify_signature(payload, signature, public_key)
    else:  # pragma: no cover - argparse choices already constrain this
        raise SigningError(f"unknown --kind {args.kind!r}")

    print("VALID" if ok else "INVALID")
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# argparse wiring
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="skill_signing.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_keygen = sub.add_parser("keygen", help="Generate an Ed25519 key pair")
    p_keygen.add_argument("--key", required=True, help="Output path for the private key PEM")
    p_keygen.add_argument("--force", action="store_true", help="Overwrite an existing key file")
    p_keygen.set_defaults(func=cmd_keygen)

    p_bundle = sub.add_parser("sign-bundle", help="Assemble and sign a TRUST_BUNDLE_V1 document")
    p_bundle.add_argument("--key", required=True, help="Authority private key PEM path")
    p_bundle.add_argument("--origin", required=True, help="https:// origin this bundle governs")
    p_bundle.add_argument("--signing-key-id", required=True, help="Authority key id (must match --key)")
    p_bundle.add_argument("--sequence", required=True, type=int, help="Strictly monotonic sequence number")
    p_bundle.add_argument("--trusted-keys", required=True, help="Path to a JSON array of {origin,keyId,publicKey}")
    p_bundle.add_argument("--revocations", help="Path to a JSON array of revocation entries (default: [])")
    p_bundle.add_argument("--skills", help="Path to a JSON object of {skillId: digest} pins (optional)")
    p_bundle.add_argument("--previous", help="Path to the previously accepted bundle, for monotonicity checks")
    p_bundle.add_argument("--freshness-hours", type=float, default=1.0, help="nextUpdate = now + this many hours (<=24)")
    p_bundle.add_argument("--output", required=True, help="Output path for the signed bundle JSON")
    p_bundle.set_defaults(func=cmd_sign_bundle)

    p_skill = sub.add_parser("sign-skill", help="Sign a skill.json + SKILL.md pair into a REMOTE_PKG_V1 envelope")
    p_skill.add_argument("--key", required=True, help="Publisher private key PEM path")
    p_skill.add_argument("--key-id", required=True, help="Publisher key id (must be trusted in the origin's bundle)")
    p_skill.add_argument("--origin", required=True, help="https:// origin this skill is published under")
    p_skill.add_argument("--manifest", required=True, help="Path to skill.json")
    p_skill.add_argument("--skill-md", required=True, help="Path to SKILL.md")
    p_skill.add_argument("--write-manifest", action="store_true", help="Write the stubbed manifest back to --manifest")
    p_skill.add_argument("--output", required=True, help="Output path for the signed envelope JSON")
    p_skill.set_defaults(func=cmd_sign_skill)

    p_verify = sub.add_parser("verify", help="Round-trip verify a signed bundle or envelope")
    p_verify.add_argument("--kind", required=True, choices=["bundle", "envelope"])
    p_verify.add_argument("--document", required=True, help="Path to the signed JSON document")
    p_verify.add_argument("--public-key", required=True, help="Path to a file containing the SPKI b64url public key")
    p_verify.set_defaults(func=cmd_verify)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (SigningError, SkillTrustError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
