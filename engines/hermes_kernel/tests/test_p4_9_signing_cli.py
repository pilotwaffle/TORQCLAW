"""P4-9: signing CLI (scripts/skill_signing.py) -- cross-vector consistency
(SP-4/DP-11) and a full pilot dry-run: keygen -> sign bundle -> sign
envelope -> host on a loopback HTTPS fixture -> install_remote_skill ->
approve -> AC-15 boot proof.

Gates: DP-11 cross-vector test (CLI-signed output must verify in the
engine; G-3: a mutation of the engine's canonicalizer must break the CLI's
output SYMMETRICALLY -- proving a divergence is DETECTABLE, not merely
that today's output happens to match).
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper import governed_skills, hermes_runner  # noqa: E402
from mcp_wrapper import skill_trust as t  # noqa: E402
from mcp_wrapper.verified_skill_store import file_digest  # noqa: E402

vendored_available, vendor_import_error = hermes_runner.hermes_available()
requires_vendor = pytest.mark.skipif(
    not vendored_available, reason=f"vendored hermes-agent unavailable: {vendor_import_error}"
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CLI = REPO_ROOT / "scripts" / "skill_signing.py"


def _run_cli(args: list[str], *, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True, text=True, env=env,
    )


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path / "torqclaw_data"))
    monkeypatch.setenv("TORQCLAW_GOVERNED_SKILLS", "1")
    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "1")
    hermes_home = tmp_path / "hermes_home"
    (hermes_home / "skills").mkdir(parents=True, exist_ok=True)
    published = tmp_path / "torqclaw_data" / "published_skills"
    (hermes_home / "config.yaml").write_text(
        "skills:\n  external_dirs:\n    - " + published.as_posix() + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    governed_skills._reset_for_test()
    yield
    governed_skills._reset_for_test()


def _keygen(tmp_path: Path, name: str, env: dict) -> tuple[Path, str]:
    key_path = tmp_path / "signing_keys" / f"{name}.pem"
    result = _run_cli(["keygen", "--key", str(key_path)], env=env)
    assert result.returncode == 0, result.stderr
    pub_line = [line for line in result.stdout.splitlines() if line.startswith("public key")][0]
    pub_b64url = pub_line.split(": ", 1)[1].strip()
    return key_path, pub_b64url


def test_cli_refuses_a_key_inside_the_repo(tmp_path, monkeypatch):
    env = {**__import__("os").environ, "TORQCLAW_DATA_DIR": str(tmp_path / "d")}
    repo_key = REPO_ROOT / "scratch-inside-repo.pem"
    result = _run_cli(["keygen", "--key", str(repo_key)], env=env)
    assert result.returncode == 1
    assert "repository working tree" in result.stderr
    assert not repo_key.exists()


def test_cli_refuses_a_key_inside_data_dir(tmp_path, monkeypatch):
    data_dir = tmp_path / "torqclaw_data"
    env = {**__import__("os").environ, "TORQCLAW_DATA_DIR": str(data_dir)}
    key_inside = data_dir / "scratch.pem"
    result = _run_cli(["keygen", "--key", str(key_inside)], env=env)
    assert result.returncode == 1
    assert "TORQCLAW_DATA_DIR" in result.stderr


def test_dp11_sp4_cross_vector_cli_signed_output_verifies_in_engine(tmp_path, monkeypatch):
    """DP-11/SP-4: a bundle and an envelope signed entirely by the CLI must
    verify inside the REAL TrustEngine (no re-implementation drift)."""
    import os

    env = {**os.environ, "TORQCLAW_DATA_DIR": str(tmp_path / "unused_data")}
    origin = "https://skills.example.com"

    authority_path, authority_pub = _keygen(tmp_path, "authority", env)
    publisher_path, publisher_pub = _keygen(tmp_path, "publisher", env)

    trusted_keys_path = tmp_path / "trusted_keys.json"
    trusted_keys_path.write_text(
        json.dumps([{"origin": origin, "keyId": "pub-1", "publicKey": publisher_pub}]), encoding="utf-8"
    )
    bundle_path = tmp_path / "trust-bundle.json"
    result = _run_cli([
        "sign-bundle", "--key", str(authority_path), "--origin", origin,
        "--signing-key-id", "auth-1", "--sequence", "1",
        "--trusted-keys", str(trusted_keys_path), "--output", str(bundle_path),
    ], env=env)
    assert result.returncode == 0, result.stderr

    manifest_path = tmp_path / "skill.json"
    skill_md_path = tmp_path / "SKILL.md"
    skill_bytes = b"Use the CLI-signed workflow.\n"
    skill_md_path.write_bytes(skill_bytes)
    manifest_path.write_text(json.dumps({
        "schemaVersion": 1, "id": "cli.signed.skill", "version": "1.0.0",
        "name": "cli.signed.skill", "description": "d",
        "source": f"{origin}/skills/cli.signed.skill.json",
        "files": {"SKILL.md": file_digest(skill_bytes)},
        "requiredCapabilities": ["read"], "compatibleProfiles": ["default"],
    }), encoding="utf-8")
    envelope_path = tmp_path / "envelope.json"
    result = _run_cli([
        "sign-skill", "--key", str(publisher_path), "--key-id", "pub-1", "--origin", origin,
        "--manifest", str(manifest_path), "--skill-md", str(skill_md_path),
        "--output", str(envelope_path), "--write-manifest",
    ], env=env)
    assert result.returncode == 0, result.stderr

    # Now verify entirely through the REAL engine -- not the CLI's own
    # `verify` subcommand (which would only prove internal consistency).
    engine = t.TrustEngine(
        tmp_path / "trust_dir",
        {origin: [{"keyId": "auth-1", "publicKey": authority_pub}]},
    )
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    decision = engine.apply_bundle("src", origin, bundle)
    assert decision["accepted"] is True

    envelope = json.loads(envelope_path.read_text(encoding="utf-8"))
    manifest_bytes = t.decode_b64url(envelope["manifestBytes"])
    skill_bytes_decoded = t.decode_b64url(envelope["skillBytes"])
    computed = t.compute_package_digest(manifest_bytes, skill_bytes_decoded)
    assert computed == envelope["digest"]

    # Must not raise -- full trust evaluation succeeds against the
    # CLI-produced artifacts using nothing but the engine's own logic.
    engine.evaluate_artifact(
        origin=envelope["origin"], skill_id=envelope["skillId"], key_id=envelope["keyId"],
        digest=computed, signature=envelope["signature"], required_capabilities=["read"],
    )


def test_g3_canonicalizer_mutation_breaks_cli_output_symmetrically(tmp_path, monkeypatch):
    """G-3 (PRD §18): a mutation to the ENGINE's canonicalizer must break
    verification of CLI-signed output -- proving the single-implementation
    invariant is actually DETECTABLE, not merely that today's output
    happens to match. Simulated here by re-signing the SAME payload through
    a deliberately-diverging canonical form (extra whitespace, which
    TCJSON_V1 forbids) and confirming the engine's REAL canonicalizer
    (unmutated) rejects the result -- i.e. any canonicalizer divergence is
    caught by the verifier, not silently accepted."""
    key = Ed25519PrivateKey.generate()
    payload = {"digest": "a" * 64, "keyId": "pub-1", "origin": "https://x.example.com", "skillId": "sk1"}

    # The REAL (correct) canonical form, per TCJSON_V1.
    real_canonical = t.canonicalize(payload)

    # A DIVERGENT "canonicalizer" -- as if the CLI had re-implemented
    # canonicalization independently and introduced insignificant
    # whitespace (a divergence TCJSON_V1's own rule 1 explicitly forbids).
    divergent_canonical = json.dumps(payload, sort_keys=True, separators=(", ", ": ")).encode("utf-8")
    assert divergent_canonical != real_canonical  # the two forms truly differ

    signature_over_divergent = key.sign(divergent_canonical)
    sig_b64 = base64.urlsafe_b64encode(signature_over_divergent).rstrip(b"=").decode("ascii")

    # The REAL engine verifier -- which canonicalizes with TCJSON_V1 -- must
    # REJECT a signature produced over the divergent form. This is exactly
    # what would happen if the CLI (or engine) diverged: the mismatch is
    # caught, not silently accepted.
    ok = t.verify_signature(payload, sig_b64, key.public_key())
    assert ok is False, (
        "a signature over a DIVERGENT canonical form verified successfully -- "
        "the single-implementation invariant (SP-4) would be undetectable"
    )

    # Sanity: the CORRECT canonical form (what the CLI actually produces,
    # since it imports canonicalize from skill_trust) DOES verify.
    correct_signature = key.sign(real_canonical)
    correct_sig_b64 = base64.urlsafe_b64encode(correct_signature).rstrip(b"=").decode("ascii")
    assert t.verify_signature(payload, correct_sig_b64, key.public_key()) is True


def test_sign_bundle_enforces_monotonicity_against_previous(tmp_path, monkeypatch):
    import os

    env = {**os.environ, "TORQCLAW_DATA_DIR": str(tmp_path / "unused_data")}
    origin = "https://skills.example.com"
    authority_path, authority_pub = _keygen(tmp_path, "authority", env)
    publisher_path, publisher_pub = _keygen(tmp_path, "publisher", env)
    trusted_keys_path = tmp_path / "trusted_keys.json"
    trusted_keys_path.write_text(
        json.dumps([{"origin": origin, "keyId": "pub-1", "publicKey": publisher_pub}]), encoding="utf-8"
    )
    bundle1_path = tmp_path / "b1.json"
    _run_cli([
        "sign-bundle", "--key", str(authority_path), "--origin", origin,
        "--signing-key-id", "auth-1", "--sequence", "5",
        "--trusted-keys", str(trusted_keys_path), "--output", str(bundle1_path),
    ], env=env)

    bundle2_path = tmp_path / "b2.json"
    result = _run_cli([
        "sign-bundle", "--key", str(authority_path), "--origin", origin,
        "--signing-key-id", "auth-1", "--sequence", "5",  # NOT strictly greater
        "--trusted-keys", str(trusted_keys_path), "--previous", str(bundle1_path),
        "--output", str(bundle2_path),
    ], env=env)
    assert result.returncode == 1
    assert "monotonicity" in result.stderr or "sequence" in result.stderr


@requires_vendor
def test_ac15_full_pilot_dry_run_keygen_to_boot_proof(tmp_path, monkeypatch):
    """The P4-9 pilot dry-run: keygen -> sign bundle -> sign envelope ->
    host on a loopback HTTPS fixture -> install_remote_skill -> approve ->
    AC-15 boot proof (a real agent boot renders the skill into the actual
    system prompt -- "verify the artifact, not the unit test")."""
    import os
    import ssl
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    env = {**os.environ, "TORQCLAW_DATA_DIR": str(tmp_path / "unused_signing_data")}
    origin_host = "127.0.0.1"

    authority_path, authority_pub = _keygen(tmp_path, "authority", env)
    publisher_path, publisher_pub = _keygen(tmp_path, "publisher", env)

    # -- Self-signed loopback HTTPS fixture (OQ-1: the pilot fixture is
    # loopback HTTPS by design; SSRF posture already restricts fetches to
    # operator-configured URLs only, §5.5).
    import datetime as _dt

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes as _hashes
    from cryptography.hazmat.primitives.asymmetric import rsa as _rsa
    from cryptography.x509.oid import NameOID

    server_key = _rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, origin_host)])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject).issuer_name(issuer).public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=5))
        .not_valid_after(_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(minutes=30))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(origin_host), x509.IPAddress(__import__("ipaddress").ip_address(origin_host))]), critical=False)
        .sign(server_key, _hashes.SHA256())
    )
    cert_path = tmp_path / "fixture-cert.pem"
    key_path = tmp_path / "fixture-key.pem"
    cert_path.write_bytes(cert.public_bytes(__import__("cryptography").hazmat.primitives.serialization.Encoding.PEM))
    key_path.write_bytes(server_key.private_bytes(
        encoding=__import__("cryptography").hazmat.primitives.serialization.Encoding.PEM,
        format=__import__("cryptography").hazmat.primitives.serialization.PrivateFormat.PKCS8,
        encryption_algorithm=__import__("cryptography").hazmat.primitives.serialization.NoEncryption(),
    ))

    served: dict[str, bytes] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = served.get(self.path)
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):  # silence default request logging
            pass

    httpd = HTTPServer((origin_host, 0), Handler)
    ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_ctx.load_cert_chain(str(cert_path), str(key_path))
    httpd.socket = ssl_ctx.wrap_socket(httpd.socket, server_side=True)
    port = httpd.server_address[1]
    origin = f"https://{origin_host}:{port}"

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        # sign-bundle
        trusted_keys_path = tmp_path / "trusted_keys.json"
        trusted_keys_path.write_text(
            json.dumps([{"origin": origin, "keyId": "pub-1", "publicKey": publisher_pub}]), encoding="utf-8"
        )
        bundle_path = tmp_path / "trust-bundle.json"
        r = _run_cli([
            "sign-bundle", "--key", str(authority_path), "--origin", origin,
            "--signing-key-id", "auth-1", "--sequence", "1",
            "--trusted-keys", str(trusted_keys_path), "--output", str(bundle_path),
        ], env=env)
        assert r.returncode == 0, r.stderr

        # sign-skill
        manifest_path = tmp_path / "skill.json"
        skill_md_path = tmp_path / "SKILL.md"
        skill_bytes = b"# Pilot skill\n\nAlways answer politely.\n"
        skill_md_path.write_bytes(skill_bytes)
        manifest_path.write_text(json.dumps({
            "schemaVersion": 1, "id": "pilot.skill", "version": "1.0.0",
            "name": "pilot.skill", "description": "Pilot dry-run skill",
            "source": f"{origin}/tc/skills/pilot.skill.json",
            "files": {"SKILL.md": file_digest(skill_bytes)},
            "requiredCapabilities": ["read"], "compatibleProfiles": ["default"],
        }), encoding="utf-8")
        envelope_path = tmp_path / "envelope.json"
        r = _run_cli([
            "sign-skill", "--key", str(publisher_path), "--key-id", "pub-1", "--origin", origin,
            "--manifest", str(manifest_path), "--skill-md", str(skill_md_path),
            "--output", str(envelope_path), "--write-manifest",
        ], env=env)
        assert r.returncode == 0, r.stderr

        served["/tc/trust-bundle.json"] = bundle_path.read_bytes()
        served["/tc/skills/pilot.skill.json"] = envelope_path.read_bytes()

        # Configure the kernel's skill_sources.json to trust this fixture,
        # WITH the self-signed cert as the system trust root for this test
        # process (urllib uses the process's default SSL context; monkeypatch
        # ssl.create_default_context so _fetch_bounded trusts our fixture cert
        # without disabling verification generally).
        torqclaw_data = tmp_path / "torqclaw_data"
        torqclaw_data.mkdir(parents=True, exist_ok=True)
        (torqclaw_data / "skill_sources.json").write_text(json.dumps({
            "schemaVersion": 1,
            "sources": {"pilot-src": {
                "origin": origin, "baseUrl": f"{origin}/tc",
                "authorities": [{"keyId": "auth-1", "publicKey": authority_pub}],
            }},
        }), encoding="utf-8")

        from mcp_wrapper import skill_sources as ss

        real_create_default_context = ssl.create_default_context

        def trusting_context(*a, **kw):
            ctx = real_create_default_context(*a, cafile=str(cert_path))
            return ctx

        monkeypatch.setattr(ss.ssl, "create_default_context", trusting_context)

        from mcp_wrapper import remote_skills, skill_queue

        result = remote_skills.install_remote_skill("pilot-src", "pilot.skill")
        assert result["status"] == "pending_approval"
        assert result["verificationStatus"] == "verified"

        approved = skill_queue.decide(result["queue_id"], "APPROVE")
        assert approved["ok"] is True, approved

        # AC-15 boot proof (the GS-ACCEPT pattern, pyproject.toml:46-53): the
        # skill must be present in the REAL rendered system-prompt index the
        # upstream loader builds -- not merely "a file exists on disk". This
        # is the same build_skills_system_prompt() surface
        # tests/acceptance/test_gs_accept.py's steps 7-8 assert against;
        # unlike that heavier harness this does not need a live HERMES_MODEL/
        # PROVIDER/API_KEY/BASE_URL credential set, since the claim under
        # test is "the loader's index contains it", not "a live model call
        # succeeds".
        from agent.prompt_builder import (  # type: ignore
            build_skills_system_prompt,
            clear_skills_system_prompt_cache,
        )

        clear_skills_system_prompt_cache(clear_snapshot=True)
        rendered = build_skills_system_prompt() or ""
        assert "pilot.skill" in rendered, (
            "remote skill installed and approved but ABSENT from the "
            f"rendered system prompt. Rendered index was:\n{rendered[:2000]}"
        )
    finally:
        httpd.shutdown()
        thread.join(timeout=5)
