"""P4-1: kernel trust engine — Phase-0 canonical vectors, bundle acceptance,
artifact evaluation, persistence/clock discipline, and the seam-level fail-closed
behavior (DP-4, DP-16).

These are unit + component vectors. The end-to-end activation-path ACs (AC-1..)
live in test_remote_skills.py, which drives the real MCP tool seam.
"""

from __future__ import annotations

import base64
import json
import time

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from mcp_wrapper import skill_trust as t


# ---------------------------------------------------------------------------
# Phase-0 canonical vectors (§5.1)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        (True, b"true"),
        (False, b"false"),
        (None, b"null"),
        (0, b"0"),
        (-0, b"0"),
        (42, b"42"),
        (-7, b"-7"),
        ("", b'""'),
        ({}, b"{}"),
        ([], b"[]"),
        ({"b": 1, "a": 2}, b'{"a":2,"b":1}'),
        ([1, 2, 3], b"[1,2,3]"),
        ("héllo", b'"h\xc3\xa9llo"'),  # non-ASCII raw UTF-8, never \u
        ("\n\t", b'"\\n\\t"'),
        ("\x00", b'"\\u0000"'),
        ("☃", "\"☃\"".encode("utf-8")),  # astral-ish, raw
    ],
)
def test_canonical_vectors_positive(value, expected):
    assert t.canonicalize(value) == expected


def test_bool_before_int():
    # Python bool is an int subclass; True must be 'true', never '1' (O-11).
    assert t.canonicalize({"x": True}) == b'{"x":true}'
    assert t.canonicalize({"x": 1}) == b'{"x":1}'


def test_key_order_by_code_point():
    assert t.canonicalize({"z": 1, "a": 1, "M": 1}) == b'{"M":1,"a":1,"z":1}'


def test_nfc_nfd_distinct():
    # é as single code point vs e + combining accent are distinct bytes.
    nfc = "é"
    nfd = "é"
    assert t.canonicalize(nfc) != t.canonicalize(nfd)


@pytest.mark.parametrize("bad", [1.5, float("nan"), float("inf"), 2 ** 53, -(2 ** 53)])
def test_canonical_rejects(bad):
    with pytest.raises(t.SkillTrustError) as exc:
        t.canonicalize(bad)
    assert exc.value.reason == "invalid-schema"


def test_depth_cap():
    v = {}
    cur = v
    for _ in range(70):
        cur["n"] = {}
        cur = cur["n"]
    with pytest.raises(t.SkillTrustError):
        t.canonicalize(v)


def test_payload_too_large():
    with pytest.raises(t.SkillTrustError) as exc:
        t.canonicalize({"x": "a" * (256 * 1024)})
    assert exc.value.reason == "payload-too-large"


def test_base64url_canonical_roundtrip():
    with pytest.raises(t.SkillTrustError):
        t._decode_b64url("AA==")  # padding not allowed
    with pytest.raises(t.SkillTrustError):
        t._decode_b64url("")  # empty


def test_strict_iso_instant():
    assert t._parse_iso_ms("2026-08-12T00:00:00.000Z") > 0
    for bad in ["2026-08-12T00:00:00Z", "2026-13-01T00:00:00.000Z", "2026-08-12 00:00:00.000Z"]:
        with pytest.raises(t.SkillTrustError):
            t._parse_iso_ms(bad)


# ---------------------------------------------------------------------------
# Signing helpers for bundle/envelope fixtures (ephemeral keypairs)
# ---------------------------------------------------------------------------

ORIGIN = "https://skills.example.com"


def _sign(payload, sk):
    return base64.urlsafe_b64encode(sk.sign(t.canonicalize(payload))).rstrip(b"=").decode()


def _iso(ms):
    lt = time.gmtime(ms / 1000)
    return time.strftime("%Y-%m-%dT%H:%M:%S", lt) + f".{int(ms) % 1000:03d}Z"


def make_bundle(auth_sk, auth_kid, pub_sk, pub_kid, *, seq=1, now_ms=None,
                revocations=None, skills=None, origin=ORIGIN):
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    issued = now_ms - 1000
    payload = {
        "version": 1,
        "origin": origin,
        "sequence": seq,
        "issuedAt": _iso(issued),
        "nextUpdate": _iso(issued + 60 * 60 * 1000),
        "trustedKeys": [
            {"origin": origin, "keyId": pub_kid, "publicKey": t.public_key_spki_b64url(pub_sk.public_key())}
        ],
        "revocations": revocations or [],
        "signingKeyId": auth_kid,
    }
    if skills is not None:
        payload["skills"] = skills
    payload["signature"] = _sign(payload, auth_sk)
    return payload


def make_envelope(pub_sk, pub_kid, skill_id, digest, origin=ORIGIN):
    ident = {"digest": digest, "keyId": pub_kid, "origin": origin, "skillId": skill_id}
    return {
        "formatVersion": 1,
        "origin": origin,
        "skillId": skill_id,
        "keyId": pub_kid,
        "digest": digest,
        "manifestBytes": "",
        "skillBytes": "",
        "signature": _sign(ident, pub_sk),
    }


@pytest.fixture
def keys():
    return {
        "auth_sk": Ed25519PrivateKey.generate(),
        "auth_kid": "authority-1",
        "pub_sk": Ed25519PrivateKey.generate(),
        "pub_kid": "publisher-1",
    }


@pytest.fixture
def engine(tmp_path, keys):
    authorities = {
        ORIGIN: [{"keyId": keys["auth_kid"], "publicKey": t.public_key_spki_b64url(keys["auth_sk"].public_key())}]
    }
    return t.TrustEngine(tmp_path / "skill_trust", authorities)


# ---------------------------------------------------------------------------
# Bundle acceptance (§5.2)
# ---------------------------------------------------------------------------


def test_accept_bundle(engine, keys):
    b = make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"])
    res = engine.apply_bundle("src", ORIGIN, b)
    assert res["accepted"] and res["sequence"] == 1


def test_bad_authority_signature_refused(engine, keys):
    b = make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"])
    b["signature"] = _sign({"tampered": True}, keys["auth_sk"])
    with pytest.raises(t.SkillTrustError) as exc:
        engine.apply_bundle("src", ORIGIN, b)
    assert exc.value.reason == "signature-invalid"


def test_monotonic_sequence(engine, keys):
    now = int(time.time() * 1000)
    b1 = make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"], seq=2, now_ms=now)
    engine.apply_bundle("src", ORIGIN, b1)
    b_replay = make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"], seq=2, now_ms=now + 5000)
    with pytest.raises(t.SkillTrustError) as exc:
        engine.apply_bundle("src", ORIGIN, b_replay)
    assert exc.value.reason == "sequence-not-monotonic"


def test_origin_mismatch(engine, keys):
    b = make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"])
    with pytest.raises(t.SkillTrustError) as exc:
        engine.apply_bundle("src", "https://other.example.com", b)
    assert exc.value.reason == "origin-mismatch"


# ---------------------------------------------------------------------------
# Artifact evaluation (§5.3 order)
# ---------------------------------------------------------------------------


def _digest():
    return "ab" * 32


def test_evaluate_artifact_allows(engine, keys):
    engine.apply_bundle("src", ORIGIN, make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"]))
    d = _digest()
    env = make_envelope(keys["pub_sk"], keys["pub_kid"], "foo", d)
    engine.evaluate_artifact(ORIGIN, "foo", keys["pub_kid"], d, env["signature"], ["read"])  # no raise


def test_evaluate_bad_signature(engine, keys):
    engine.apply_bundle("src", ORIGIN, make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"]))
    d = _digest()
    env = make_envelope(keys["pub_sk"], keys["pub_kid"], "foo", d)
    with pytest.raises(t.SkillTrustError) as exc:
        engine.evaluate_artifact(ORIGIN, "foo", keys["pub_kid"], "cd" * 32, env["signature"], ["read"])
    assert exc.value.reason == "signature-invalid"


def test_revoked_key(engine, keys):
    engine.apply_bundle("src", ORIGIN, make_bundle(
        keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"],
        revocations=[{"kind": "key", "keyId": keys["pub_kid"], "revokedAt": _iso(int(time.time() * 1000))}],
    ))
    d = _digest()
    env = make_envelope(keys["pub_sk"], keys["pub_kid"], "foo", d)
    with pytest.raises(t.SkillTrustError) as exc:
        engine.evaluate_artifact(ORIGIN, "foo", keys["pub_kid"], d, env["signature"], ["read"])
    assert exc.value.reason == "revoked-key"


def test_revoked_skill_digest_optional(engine, keys):
    engine.apply_bundle("src", ORIGIN, make_bundle(
        keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"],
        revocations=[{"kind": "skill", "skillId": "foo", "revokedAt": _iso(int(time.time() * 1000))}],
    ))
    d = _digest()
    env = make_envelope(keys["pub_sk"], keys["pub_kid"], "foo", d)
    with pytest.raises(t.SkillTrustError) as exc:
        engine.evaluate_artifact(ORIGIN, "foo", keys["pub_kid"], d, env["signature"], ["read"])
    assert exc.value.reason == "revoked-skill"


def test_capability_bound(engine, keys):
    engine.apply_bundle("src", ORIGIN, make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"]))
    d = _digest()
    env = make_envelope(keys["pub_sk"], keys["pub_kid"], "foo", d)
    with pytest.raises(t.SkillTrustError) as exc:
        engine.evaluate_artifact(ORIGIN, "foo", keys["pub_kid"], d, env["signature"], ["read", "exec"])
    assert exc.value.reason == "capability-unsupported"


def test_digest_pin(engine, keys):
    d1 = "ab" * 32
    d2 = "cd" * 32
    engine.apply_bundle("src", ORIGIN, make_bundle(
        keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"], skills={"foo": d2},
    ))
    env = make_envelope(keys["pub_sk"], keys["pub_kid"], "foo", d1)
    with pytest.raises(t.SkillTrustError) as exc:
        engine.evaluate_artifact(ORIGIN, "foo", keys["pub_kid"], d1, env["signature"], ["read"])
    assert exc.value.reason == "digest-not-current"


def test_revocation_wins_over_pin(engine, keys):
    # F-2: pinned-mismatched AND revoked resolves to revoked-skill.
    d1 = "ab" * 32
    d2 = "cd" * 32
    engine.apply_bundle("src", ORIGIN, make_bundle(
        keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"],
        skills={"foo": d2},
        revocations=[{"kind": "skill", "skillId": "foo", "revokedAt": _iso(int(time.time() * 1000))}],
    ))
    env = make_envelope(keys["pub_sk"], keys["pub_kid"], "foo", d1)
    with pytest.raises(t.SkillTrustError) as exc:
        engine.evaluate_artifact(ORIGIN, "foo", keys["pub_kid"], d1, env["signature"], ["read"])
    assert exc.value.reason == "revoked-skill"


# ---------------------------------------------------------------------------
# Clock discipline + persistence (§5.6)
# ---------------------------------------------------------------------------


def test_clock_rollback_quarantine(tmp_path, keys):
    now = [int(time.time() * 1000)]
    authorities = {ORIGIN: [{"keyId": keys["auth_kid"], "publicKey": t.public_key_spki_b64url(keys["auth_sk"].public_key())}]}
    eng = t.TrustEngine(tmp_path / "st", authorities, now=lambda: now[0])
    eng.apply_bundle("src", ORIGIN, make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"], now_ms=now[0]))
    # regress the clock beyond 5 min
    now[0] -= 6 * 60 * 1000
    with pytest.raises(t.SkillTrustError) as exc:
        eng.require_fresh_origin(ORIGIN)
    assert exc.value.reason == "clock-rollback"


def test_persistence_reverify_on_load(tmp_path, keys):
    authorities = {ORIGIN: [{"keyId": keys["auth_kid"], "publicKey": t.public_key_spki_b64url(keys["auth_sk"].public_key())}]}
    eng = t.TrustEngine(tmp_path / "st", authorities)
    now = int(time.time() * 1000)
    eng.apply_bundle("src", ORIGIN, make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"], now_ms=now))
    # New engine over the same dir re-verifies the persisted bundle.
    eng2 = t.TrustEngine(tmp_path / "st", authorities)
    state = eng2.require_fresh_origin(ORIGIN)
    assert state["bundle"]["origin"] == ORIGIN


def test_artifact_record_roundtrip(engine, keys):
    engine.apply_bundle("src", ORIGIN, make_bundle(keys["auth_sk"], keys["auth_kid"], keys["pub_sk"], keys["pub_kid"]))
    d = _digest()
    env = make_envelope(keys["pub_sk"], keys["pub_kid"], "foo", d)
    engine.persist_artifact_record("foo", d, ORIGIN, keys["pub_kid"], env["signature"])
    engine.evaluate_installed("foo", d, ["read"])  # loads record, no raise


def test_missing_artifact_record(engine):
    with pytest.raises(t.SkillTrustError) as exc:
        engine.evaluate_installed("foo", _digest(), ["read"])
    assert exc.value.reason == "artifact-record-missing"


# ---------------------------------------------------------------------------
# DP-16: fail-closed-when-unwired at the store seam (O-5)
# ---------------------------------------------------------------------------


def test_dp16_store_without_evaluator_refuses_remote(monkeypatch):
    from mcp_wrapper import verified_skill_store as vss

    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "1")
    manifest = {
        "id": "foo",
        "source": "https://skills.example.com",
        "signature": {"algorithm": "Ed25519", "keyId": "k", "value": "detached"},
        "requiredCapabilities": ["read"],
        "compatibleProfiles": ["default"],
    }
    # No evaluator attached, flag on, remote manifest => trust-engine-unavailable.
    with pytest.raises(t.SkillTrustError) as exc:
        vss._enforce_activation_policy(manifest, None, trust_evaluator=None, digest="ab" * 32)
    assert exc.value.reason == "trust-engine-unavailable"


def test_dp16_local_manifest_never_touches_trust(monkeypatch):
    from mcp_wrapper import verified_skill_store as vss

    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "1")
    manifest = {
        "id": "foo",
        "source": "torqclaw:operator-approval",
        "requiredCapabilities": ["read"],
        "compatibleProfiles": ["default"],
    }
    # Local manifest: no trust arm even with flag on and no evaluator.
    vss._enforce_activation_policy(manifest, None, trust_evaluator=None, digest=None)


def test_dp16_flag_off_skips_trust(monkeypatch):
    from mcp_wrapper import verified_skill_store as vss

    monkeypatch.delenv("TORQCLAW_REMOTE_SKILL_SOURCES", raising=False)
    manifest = {
        "id": "foo",
        "source": "https://skills.example.com",
        "signature": {"algorithm": "Ed25519", "keyId": "k", "value": "detached"},
        "requiredCapabilities": ["read"],
        "compatibleProfiles": ["default"],
    }
    # Flag off: remote manifest passes the trust hook (disposition b).
    vss._enforce_activation_policy(manifest, None, trust_evaluator=None, digest="ab" * 32)
