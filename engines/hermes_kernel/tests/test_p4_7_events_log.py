"""P4-7: trust operational log (§5.6 events.log, rotation) + O-9 overflow
log wiring check.

Gates: SP-8 (trust events never enter state.json audit[]) / DP-7 (routing
trust events into audit[] must turn SP-8's pin red).
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper import skill_trust as t  # noqa: E402


def _iso_now_ms(ms: int) -> str:
    import datetime

    dt = datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


class _Clock:
    def __init__(self, start_ms: int):
        self.now_ms = start_ms

    def __call__(self) -> int:
        return self.now_ms


def _engine(tmp_path: Path, origin: str, authority_key, *, now_ms: int):
    clock = _Clock(now_ms)
    engine = t.TrustEngine(
        tmp_path / "skill_trust",
        {origin: [{"keyId": "auth-1", "publicKey": t.public_key_spki_b64url(authority_key.public_key())}]},
        now=clock,
    )
    return engine, clock


def _sign_bundle(engine, clock, origin, authority_key, publisher_key, *, sequence=1):
    issued = clock.now_ms
    bundle = {
        "version": 1,
        "origin": origin,
        "sequence": sequence,
        "issuedAt": _iso_now_ms(issued),
        "nextUpdate": _iso_now_ms(issued + 3600_000),
        "trustedKeys": [
            {"origin": origin, "keyId": "pub-1", "publicKey": t.public_key_spki_b64url(publisher_key.public_key())}
        ],
        "revocations": [],
        "signingKeyId": "auth-1",
    }
    unsigned = {k: v for k, v in bundle.items() if k != "signature"}
    sig = authority_key.sign(t.canonicalize(unsigned))
    bundle["signature"] = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
    return bundle


def _read_events(tmp_path: Path) -> list[dict]:
    path = tmp_path / "skill_trust" / "events.log"
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    return [json.loads(line) for line in lines if line]


def test_bundle_acceptance_and_refusal_logged(tmp_path: Path):
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    engine, clock = _engine(tmp_path, origin, authority, now_ms=1_700_000_000_000)

    bundle = _sign_bundle(engine, clock, origin, authority, publisher)
    engine.apply_bundle("src", origin, bundle)

    events = _read_events(tmp_path)
    kinds = [e["kind"] for e in events]
    assert "bundle_accepted" in kinds

    # Replaying the same bundle is a refusal -- also logged.
    with pytest.raises(t.SkillTrustError):
        engine.apply_bundle("src", origin, bundle)
    events = _read_events(tmp_path)
    refusals = [e for e in events if e["kind"] == "bundle_refused"]
    assert len(refusals) == 1
    assert refusals[0]["reason"] == "sequence-not-monotonic"


def test_artifact_verdicts_logged(tmp_path: Path):
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    engine, clock = _engine(tmp_path, origin, authority, now_ms=1_700_000_000_000)
    bundle = _sign_bundle(engine, clock, origin, authority, publisher)
    engine.apply_bundle("src", origin, bundle)

    digest = "a" * 64
    payload = {"digest": digest, "keyId": "pub-1", "origin": origin, "skillId": "sk1"}
    sig = publisher.sign(t.canonicalize(payload))
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")

    engine.evaluate_artifact(
        origin=origin, skill_id="sk1", key_id="pub-1", digest=digest,
        signature=sig_b64, required_capabilities=["read"],
    )
    events = _read_events(tmp_path)
    assert any(e["kind"] == "artifact_verified" and e["skillId"] == "sk1" for e in events)

    # A refusal (wrong capability) is logged too.
    with pytest.raises(t.SkillTrustError):
        engine.evaluate_artifact(
            origin=origin, skill_id="sk1", key_id="pub-1", digest=digest,
            signature=sig_b64, required_capabilities=["read", "exec"],
        )
    events = _read_events(tmp_path)
    refusals = [e for e in events if e["kind"] == "artifact_refused"]
    assert len(refusals) == 1
    assert refusals[0]["reason"] == "capability-unsupported"


def test_quarantine_entry_and_exit_logged(tmp_path: Path):
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    engine, clock = _engine(tmp_path, origin, authority, now_ms=1_700_000_000_000)
    bundle = _sign_bundle(engine, clock, origin, authority, publisher, sequence=1)
    engine.apply_bundle("src", origin, bundle)

    # Regress the clock by more than 5 minutes to trigger quarantine.
    clock.now_ms -= 10 * 60_000
    with pytest.raises(t.SkillTrustError):
        engine.require_fresh_origin(origin)

    events = _read_events(tmp_path)
    assert any(e["kind"] == "clock_rollback_quarantine_entered" for e in events)

    # Recovery: a strictly newer signed bundle, with the clock repaired.
    clock.now_ms += 10 * 60_000 + 1000
    bundle2 = _sign_bundle(engine, clock, origin, authority, publisher, sequence=2)
    engine.apply_bundle("src", origin, bundle2)

    events = _read_events(tmp_path)
    assert any(e["kind"] == "clock_rollback_quarantine_cleared" for e in events)


def test_revocation_report_logged_only_when_non_empty(tmp_path: Path):
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    engine, clock = _engine(tmp_path, origin, authority, now_ms=1_700_000_000_000)
    bundle = _sign_bundle(engine, clock, origin, authority, publisher)
    engine.apply_bundle("src", origin, bundle)

    # No revocations -- scan returns empty and does NOT log a report event.
    hits = engine.scan_revocations_for(origin, [{"skillId": "sk1", "digest": "a" * 64, "keyId": "pub-1", "active": True}])
    assert hits == []
    events = _read_events(tmp_path)
    assert not any(e["kind"] == "revocations_affecting_installed" for e in events)


def test_events_log_rotation(tmp_path: Path, monkeypatch):
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    engine, clock = _engine(tmp_path, origin, authority, now_ms=1_700_000_000_000)

    events_path = tmp_path / "skill_trust" / "events.log"
    events_path.parent.mkdir(parents=True, exist_ok=True)
    # Pre-fill the log past the 1 MiB rotation threshold.
    events_path.write_bytes(b"x" * (1024 * 1024 + 1))

    engine._log_event("synthetic_test_event", foo="bar")

    assert events_path.with_name("events.log.1").exists()
    assert events_path.with_name("events.log.1").stat().st_size >= 1024 * 1024
    # The new log has only the fresh event.
    fresh = _read_events(tmp_path)
    assert len(fresh) == 1
    assert fresh[0]["kind"] == "synthetic_test_event"


def test_events_log_rotation_retains_only_four_archives(tmp_path: Path):
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    engine, clock = _engine(tmp_path, origin, authority, now_ms=1_700_000_000_000)

    trust_dir = tmp_path / "skill_trust"
    events_path = trust_dir / "events.log"
    # Seed four archives with recognizable markers plus a full-size current log.
    for i in range(1, 5):
        (trust_dir / f"events.log.{i}").write_text(f"marker-{i}\n", encoding="utf-8")
    events_path.write_bytes(b"x" * (1024 * 1024 + 1))

    engine._log_event("rotate_again")

    # marker-4 (oldest) is gone; marker-1..3 shifted to .2..4.
    assert (trust_dir / "events.log.4").read_text(encoding="utf-8") == "marker-3\n"
    assert (trust_dir / "events.log.3").read_text(encoding="utf-8") == "marker-2\n"
    assert (trust_dir / "events.log.2").read_text(encoding="utf-8") == "marker-1\n"
    assert (trust_dir / "events.log.1").stat().st_size >= 1024 * 1024


def test_sp8_dp7_trust_events_never_enter_state_json_audit(tmp_path: Path, monkeypatch):
    """SP-8/DP-7: a refresh/verify storm must never change state.json's
    audit[] length -- trust events go ONLY to events.log."""
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path / "torqclaw_data"))
    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "1")
    from mcp_wrapper.verified_skill_store import VerifiedSkillStore

    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    engine, clock = _engine(tmp_path, origin, authority, now_ms=1_700_000_000_000)
    store = VerifiedSkillStore(tmp_path / "store", trust_evaluator=engine)
    audit_len_before = len(store._load_state()["audit"])

    # A "storm": many bundle accept/refuse and artifact verify/refuse calls.
    bundle = _sign_bundle(engine, clock, origin, authority, publisher, sequence=1)
    engine.apply_bundle("src", origin, bundle)
    for seq in range(2, 12):
        clock.now_ms += 1000
        b = _sign_bundle(engine, clock, origin, authority, publisher, sequence=seq)
        engine.apply_bundle("src", origin, b)
    for _ in range(10):
        with pytest.raises(t.SkillTrustError):
            engine.evaluate_artifact(
                origin=origin, skill_id="sk1", key_id="unknown-key", digest="a" * 64,
                signature="x", required_capabilities=["read"],
            )

    audit_len_after = len(store._load_state()["audit"])
    assert audit_len_after == audit_len_before  # UNCHANGED (SP-8)
    events = _read_events(tmp_path)
    assert len(events) >= 20  # the storm WAS recorded, just not in state.json
