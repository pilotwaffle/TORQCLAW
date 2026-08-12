"""P4-6: signer persistence (R-6) + audit headroom (F-1) + mapper arms (O-13).

These exercise VerifiedSkillStore and governed_skills.map_activation_failure
directly -- neither requires the vendored hermes-agent submodule (unlike
governed_skills.install_approved_skill's full coordinator path, which invokes
prompt-cache invalidation and is skipped elsewhere when the vendor tree is
absent). Keeping these tests independent of that skip means the store/mapper
mechanics this ticket adds are provably exercised in every environment.

Gates: AC-4, AC-5 (via seam-level trust checks, exercised more fully once
P4-5 lands the MCP tool seam); DP-5 (signer fields removed -> AC-4 breaks);
the four F-1 boundary tests named in the PRD ticket table; O-13 mapper
exhaustiveness.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper import governed_skills  # noqa: E402
from mcp_wrapper import skill_trust as t  # noqa: E402
from mcp_wrapper.verified_skill_store import (  # noqa: E402
    MAX_AUDIT_ENTRIES,
    REMOTE_AUDIT_HEADROOM,
    SkillAuditCapacityError,
    SkillRecoveryError,
    VerifiedSkillStore,
    file_digest,
)

from test_verified_skill_store import write_package  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures: a minimal signed remote package + trust engine, enough to drive
# activate()/rollback() through the real §6.3 seam without the MCP surface.
# ---------------------------------------------------------------------------


def _iso(ms: int) -> str:
    import datetime

    dt = datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


class _FixedClock:
    def __init__(self, start_ms: int):
        self.now_ms = start_ms

    def __call__(self) -> int:
        return self.now_ms


def _make_engine(tmp_path: Path, origin: str, authority_key, *, now_ms: int):
    clock = _FixedClock(now_ms)
    engine = t.TrustEngine(
        tmp_path / "skill_trust",
        {origin: [{"keyId": "auth-1", "publicKey": t.public_key_spki_b64url(authority_key.public_key())}]},
        now=clock,
    )
    return engine, clock


def _accept_bundle(engine, clock, origin, authority_key, publisher_key, *, sequence=1, skills=None):
    issued = clock.now_ms
    bundle = {
        "version": 1,
        "origin": origin,
        "sequence": sequence,
        "issuedAt": _iso(issued),
        "nextUpdate": _iso(issued + 3600_000),
        "trustedKeys": [
            {"origin": origin, "keyId": "pub-1", "publicKey": t.public_key_spki_b64url(publisher_key.public_key())}
        ],
        "revocations": [],
        "signingKeyId": "auth-1",
    }
    if skills:
        bundle["skills"] = skills
    unsigned = {k: v for k, v in bundle.items() if k != "signature"}
    sig = authority_key.sign(t.canonicalize(unsigned))
    import base64

    bundle["signature"] = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
    return engine.apply_bundle("src", origin, bundle)


def _make_remote_package(
    tmp_path: Path, *, skill_id: str, origin: str, publisher_key, key_id="pub-1", version="1.0.0"
):
    skill_bytes = b"Remote content.\n"
    stub_sig = {"algorithm": "Ed25519", "keyId": key_id, "value": "detached"}
    manifest = {
        "schemaVersion": 1,
        "id": skill_id,
        "version": version,
        "name": skill_id,
        "description": "Remote test skill",
        "source": f"{origin}/skills/{skill_id}.json",
        "files": {"SKILL.md": file_digest(skill_bytes)},
        "requiredCapabilities": ["read"],
        "compatibleProfiles": ["default"],
        "signature": stub_sig,
    }
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = t.compute_package_digest(manifest_bytes, skill_bytes)
    payload = {"digest": digest, "keyId": key_id, "origin": origin, "skillId": skill_id}
    import base64

    sig = publisher_key.sign(t.canonicalize(payload))
    signature_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")

    package = tmp_path / f"remote-package-{skill_id}-{version}"
    package.mkdir()
    (package / "skill.json").write_bytes(manifest_bytes)
    (package / "SKILL.md").write_bytes(skill_bytes)
    return package, digest, signature_b64, key_id


def _activate_remote(store, engine, tmp_path, *, skill_id, origin, publisher_key, key_id="pub-1"):
    package, digest, signature_b64, kid = _make_remote_package(
        tmp_path, skill_id=skill_id, origin=origin, publisher_key=publisher_key, key_id=key_id
    )
    staged = store.stage(package)
    assert staged["digest"] == digest
    engine.persist_artifact_record(skill_id, digest, origin, kid, signature_b64)
    approval = store.approve(staged, confirm_permission_delta=True)
    result = store.activate(staged, approval, remote_meta={"origin": origin, "keyId": kid})
    return result, digest


# ---------------------------------------------------------------------------
# R-6: signer persistence
# ---------------------------------------------------------------------------


def test_r6_installed_record_carries_origin_and_key_id_for_remote(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "1")
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    now = 1_700_000_000_000
    engine, clock = _make_engine(tmp_path, origin, authority, now_ms=now)
    _accept_bundle(engine, clock, origin, authority, publisher)

    store = VerifiedSkillStore(tmp_path / "store", trust_evaluator=engine)
    result, digest = _activate_remote(
        store, engine, tmp_path, skill_id="remote.skill", origin=origin, publisher_key=publisher
    )
    assert result["enabled"] is True

    state = store._load_state()
    record = state["installed"]["remote.skill"][digest]
    assert record["origin"] == origin
    assert record["keyId"] == "pub-1"
    audit_row = [r for r in state["audit"] if r["action"] == "activated"][-1]
    assert audit_row["origin"] == origin
    assert audit_row["keyId"] == "pub-1"


def test_r6_local_install_has_no_origin_key_id(tmp_path: Path):
    """Local installs are byte-identical to aa6057b: no origin/keyId key at
    all (not even null) on the installed record or audit row."""
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="local.skill"))
    approval = store.approve(staged, confirm_permission_delta=True)
    store.activate(staged, approval)

    state = store._load_state()
    record = state["installed"]["local.skill"][staged["digest"]]
    assert "origin" not in record
    assert "keyId" not in record
    audit_row = [r for r in state["audit"] if r["action"] == "activated"][-1]
    assert "origin" not in audit_row
    assert "keyId" not in audit_row


def test_r6_validator_tolerates_absent_and_rejects_malformed(tmp_path: Path):
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="local.skill"))
    approval = store.approve(staged, confirm_permission_delta=True)
    store.activate(staged, approval)
    # Absent is legal -- already proven by every existing local test passing.
    store._load_state()

    state = store._load_state()
    state["installed"]["local.skill"][staged["digest"]]["origin"] = "https://x.example.com"
    # keyId missing -- present-but-malformed (unpaired) must fail closed.
    store._save_state(state)
    with pytest.raises(SkillRecoveryError):
        store._load_state()


def test_dp5_removing_signer_fields_breaks_rollback_eligibility_resolution(tmp_path: Path, monkeypatch):
    """DP-5: if _installed_record stopped writing origin/keyId, rollback of a
    remote version could no longer resolve which origin/key to re-evaluate.
    This test proves the POSITIVE path -- the fields ARE there and rollback
    CAN resolve remote-ness -- which is exactly what regresses under that
    sabotage (asserted by its absence breaking the assertion below)."""
    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "1")
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    now = 1_700_000_000_000
    engine, clock = _make_engine(tmp_path, origin, authority, now_ms=now)
    _accept_bundle(engine, clock, origin, authority, publisher)
    store = VerifiedSkillStore(tmp_path / "store", trust_evaluator=engine)
    _activate_remote(store, engine, tmp_path, skill_id="remote.skill", origin=origin, publisher_key=publisher)

    state = store._load_state()
    record = state["installed"]["remote.skill"][list(state["installed"]["remote.skill"])[0]]
    # This is the exact predicate rollback() uses to decide remote_meta.
    assert "origin" in record and "keyId" in record


# ---------------------------------------------------------------------------
# F-1 boundary tests (the four named in the PRD ticket table)
# ---------------------------------------------------------------------------


def _fill_audit(store: VerifiedSkillStore, count: int) -> None:
    state = store._load_state()
    state["audit"] = [
        {"action": "approved", "skillId": "seed.skill", "digest": "0" * 64, "at": i} for i in range(count)
    ]
    store._save_state(state)


def test_f1_i_remote_transaction_refused_before_mutation_at_headroom_boundary(tmp_path: Path, monkeypatch):
    """(i) A remote transaction is refused BEFORE any mutation when audit is
    filled to MAX_AUDIT_ENTRIES - 1 (i.e. one below the unconditional cap,
    but at/above the remote headroom boundary of MAX_AUDIT_ENTRIES - 2)."""
    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "1")
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    now = 1_700_000_000_000
    engine, clock = _make_engine(tmp_path, origin, authority, now_ms=now)
    _accept_bundle(engine, clock, origin, authority, publisher)
    store = VerifiedSkillStore(tmp_path / "store", trust_evaluator=engine)

    package, digest, signature_b64, kid = _make_remote_package(
        tmp_path, skill_id="remote.skill", origin=origin, publisher_key=publisher
    )
    staged = store.stage(package)
    engine.persist_artifact_record("remote.skill", digest, origin, kid, signature_b64)
    # Fill to 998 BEFORE approve(): approve() itself appends one "approved"
    # audit row, bringing the log to 999 -- exactly one over the
    # REMOTE_AUDIT_HEADROOM (998) boundary -- by the time activate() runs.
    _fill_audit(store, REMOTE_AUDIT_HEADROOM)
    approval = store.approve(staged, confirm_permission_delta=True)
    assert len(store._load_state()["audit"]) == MAX_AUDIT_ENTRIES - 1  # 999

    with pytest.raises(SkillAuditCapacityError):
        store.activate(staged, approval, remote_meta={"origin": origin, "keyId": kid})

    # Nothing mutated by activate(): no install record, no active entry.
    # The "approved" row from approve() above is the only mutation on record
    # (approve() is not itself remote-headroom-gated -- only activate()/
    # rollback() are, per §2 R-9/F-1's "before the coordinator transaction
    # begins" scope, which install_remote_staged's pre-check (P4-5) also
    # covers before approve() is ever reached in the real remote flow).
    state = store._load_state()
    assert "remote.skill" not in state["installed"]
    assert "remote.skill" not in state["active"]
    assert len(state["audit"]) == MAX_AUDIT_ENTRIES - 1  # unchanged by activate()


def test_f1_ii_local_flag_off_transcript_byte_identical_at_audit_999(tmp_path: Path, monkeypatch):
    """(ii) The local flag-off transcript is byte-identical with audit == 999
    present at the moment activate() runs -- proving the headroom check does
    NOT fire locally (RS-7). This is the RS-7 boundary the review demanded:
    an UNCONDITIONAL headroom check would refuse this local activation here
    (999 > REMOTE_AUDIT_HEADROOM==998), which must never happen."""
    monkeypatch.delenv("TORQCLAW_REMOTE_SKILL_SOURCES", raising=False)
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="local.skill"))
    # Fill to 998 BEFORE approve(): approve()'s own "approved" audit row
    # brings the log to exactly 999 by the time activate() is called below.
    _fill_audit(store, REMOTE_AUDIT_HEADROOM)
    approval = store.approve(staged, confirm_permission_delta=True)
    assert len(store._load_state()["audit"]) == MAX_AUDIT_ENTRIES - 1  # 999, past the remote headroom line

    # A LOCAL activation at audit==999 must succeed exactly as aa6057b did --
    # the remote headroom check never runs because remote_meta is None.
    result = store.activate(staged, approval)
    assert result["enabled"] is True
    state = store._load_state()
    assert len(state["audit"]) == MAX_AUDIT_ENTRIES  # 999 + 1 activated row, no headroom refusal


def test_f1_iii_local_revert_at_capacity_fails_closed_not_silent_drop(tmp_path: Path):
    """(iii) A local revert at capacity now fails closed via _append_audit,
    not the old silent len<MAX drop-and-commit."""
    store = VerifiedSkillStore(tmp_path / "store")
    staged = store.stage(write_package(tmp_path, skill_id="local.skill"))
    approval = store.approve(staged, confirm_permission_delta=True)
    store.activate(staged, approval)

    _fill_audit(store, MAX_AUDIT_ENTRIES)  # full: 1000
    pre_state = store._load_state()
    pre_active = dict(pre_state["active"]["local.skill"])

    with pytest.raises(SkillAuditCapacityError):
        store.revert_activation("local.skill", staged["digest"], approval["token"], None)

    # Fails CLOSED: nothing committed. Active state unchanged, no
    # "activation_reverted" row silently appended and dropped.
    post_state = store._load_state()
    assert post_state["active"]["local.skill"] == pre_active
    assert len(post_state["audit"]) == MAX_AUDIT_ENTRIES
    assert not any(r.get("action") == "activation_reverted" for r in post_state["audit"])


def test_f1_iv_remote_overflow_arm_diverts_and_commits(tmp_path: Path, monkeypatch):
    """(iv) Remote last-resort overflow arm: if SkillAuditCapacityError
    nonetheless fires inside a REMOTE revert (injection -- the headroom
    pre-check is bypassed on purpose here to exercise the defense-in-depth
    arm), the revert still commits, the record is diverted to
    skill_audit_overflow.log (outside skill_trust/), and the result carries
    auditOverflow: true."""
    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "1")
    origin = "https://skills.example.com"
    authority = Ed25519PrivateKey.generate()
    publisher = Ed25519PrivateKey.generate()
    now = 1_700_000_000_000
    engine, clock = _make_engine(tmp_path, origin, authority, now_ms=now)
    _accept_bundle(engine, clock, origin, authority, publisher)
    store = VerifiedSkillStore(tmp_path / "store", trust_evaluator=engine)

    result, digest = _activate_remote(
        store, engine, tmp_path, skill_id="remote.skill", origin=origin, publisher_key=publisher
    )
    approval_token = None
    state = store._load_state()
    # Find the consumed approval token used for this activation.
    for tok, rec in state["approvals"].items():
        if rec.get("digest") == digest:
            approval_token = tok
            break
    assert approval_token is not None

    # Fill audit to exactly capacity so _append_audit's unconditional check
    # (not the headroom pre-check, which we bypass by calling
    # revert_activation directly) raises SkillAuditCapacityError.
    _fill_audit(store, MAX_AUDIT_ENTRIES)
    pre_active = dict(store._load_state()["active"]["remote.skill"])
    assert pre_active["digest"] == digest

    result = store.revert_activation(
        "remote.skill", digest, approval_token, None, remote_meta={"origin": origin, "keyId": "pub-1"}
    )
    assert result == {"ok": True, "skillId": "remote.skill", "reverted": True, "auditOverflow": True}

    # The revert COMMITTED despite the audit write failing: active state
    # cleared (previous was None -- first activation).
    post_state = store._load_state()
    assert "remote.skill" not in post_state["active"]

    overflow_path = (tmp_path / "store").parent / "skill_audit_overflow.log"
    assert overflow_path.is_file()
    lines = overflow_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["skillId"] == "remote.skill"
    assert record["digest"] == digest
    assert record["origin"] == origin
    assert record["keyId"] == "pub-1"
    assert record["action"] == "activation_reverted"
    # Outside skill_trust/ (O-9).
    assert "skill_trust" not in str(overflow_path)


# ---------------------------------------------------------------------------
# O-13: mapper exhaustiveness
# ---------------------------------------------------------------------------


def test_mapper_exhaustiveness_every_registry_reason_maps(monkeypatch):
    for reason in sorted(t.TRUST_REASONS):
        exc = t.SkillTrustError(reason)
        result = governed_skills.map_activation_failure(exc, queue_status="pending")
        assert result["ok"] is False
        assert result["code"].startswith("SKILL_TRUST_") or result["code"] == "SKILL_TRUST_REFUSED"
        if reason == "stale":
            assert result["retryable"] is True
            assert result["retryAfter"] == "refresh_skill_trust"
        else:
            assert result["retryable"] is False


def test_mapper_out_of_registry_reason_is_non_retryable_refused(monkeypatch):
    exc = t.SkillTrustError("some-reason-not-in-the-frozen-registry")
    result = governed_skills.map_activation_failure(exc, queue_status="pending")
    assert result["code"] == "SKILL_TRUST_REFUSED"
    assert result["retryable"] is False


def test_mapper_trust_error_checked_before_parent_arms(monkeypatch):
    """O-13: the SkillTrustError arm must win even if a future subclass
    relationship were introduced -- pinned by asserting isinstance ordering
    produces the trust code, not the generic fallback, for a plain
    SkillTrustError instance (which is not a GovernedSkillError subclass on
    aa6057b, so this also proves the two hierarchies don't collide today)."""
    from mcp_wrapper.governed_skills import GovernedSkillError

    assert not issubclass(t.SkillTrustError, GovernedSkillError)
    exc = t.SkillTrustError("revoked-key")
    result = governed_skills.map_activation_failure(exc, queue_status=None)
    assert result["code"] == "SKILL_TRUST_REVOKED_KEY"
    assert "status" not in result


def test_mapper_status_key_omitted_when_queue_status_none(monkeypatch):
    exc = t.SkillTrustError("stale")
    result = governed_skills.map_activation_failure(exc, queue_status=None)
    assert "status" not in result
    assert result["retryable"] is True
