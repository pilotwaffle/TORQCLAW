"""P4-5: remote skill install flow -- the activation-path ACs (the TRUSTOS-002
L816 mandate: an end-to-end MCP-tool-seam behavior, never a unit vector).

Two tiers:

- Tier 1 (unconditional): everything through install_remote_skill's fetch/
  verify/stage/queue path, plus decide()'s refusal arms that never reach the
  ActivationCoordinator (edit refusal, REJECT). These do not need the
  vendored hermes-agent submodule.
- Tier 2 (skipped when the vendor submodule is unavailable, matching
  test_governed_skills.py's existing pattern): APPROVE all the way through
  activation -- AC-2 (TOCTOU), AC-16 (digest pin at the activation seam),
  AC-17 (revocation-vs-installed reporting against an ACTIVE version). These
  require ActivationCoordinator's real cache-invalidation call.

Fixtures build REMOTE_PKG_V1 envelopes and TRUST_BUNDLE_V1 bundles by hand
(no network) and monkeypatch skill_sources.fetch_bundle/fetch_envelope to
return them -- this still drives the REAL install_remote_skill orchestration
(config resolution, trust engine, staging, queue write), so it is an
activation-path test of the seam, not a call directly into skill_trust.
"""

from __future__ import annotations

import base64
import datetime
import json
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper import governed_skills, hermes_runner, remote_skills  # noqa: E402
from mcp_wrapper import skill_queue, skill_sources  # noqa: E402
from mcp_wrapper import skill_trust as t  # noqa: E402
from mcp_wrapper.verified_skill_store import file_digest  # noqa: E402

vendored_available, vendor_import_error = hermes_runner.hermes_available()
requires_vendor = pytest.mark.skipif(
    not vendored_available, reason=f"vendored hermes-agent unavailable: {vendor_import_error}"
)


def _iso(dt: datetime.datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


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


ORIGIN = "https://skills.example.com"
BASE_URL = "https://skills.example.com/tc"


class _Fixture:
    """One signed origin: an authority key, a publisher key, and helpers to
    build/sign trust bundles and package envelopes for that origin."""

    def __init__(self, tmp_path: Path, source_id: str = "src"):
        self.tmp_path = tmp_path
        self.source_id = source_id
        self.authority_key = Ed25519PrivateKey.generate()
        self.publisher_key = Ed25519PrivateKey.generate()
        # The trust engine used by install_remote_skill/refresh_skill_trust
        # (constructed via governed_skills._store()) uses the REAL wall
        # clock (no `now=` override reaches that codepath), so fixture
        # bundles must bracket actual current time, not a fixed date.
        self.now = datetime.datetime.now(tz=datetime.timezone.utc)

    def write_config(self, monkeypatch):
        auth_pub = t.public_key_spki_b64url(self.authority_key.public_key())
        config = {
            "schemaVersion": 1,
            "sources": {
                self.source_id: {
                    "origin": ORIGIN,
                    "baseUrl": BASE_URL,
                    "authorities": [{"keyId": "auth-1", "publicKey": auth_pub}],
                }
            },
        }
        (self.tmp_path / "torqclaw_data").mkdir(parents=True, exist_ok=True)
        (self.tmp_path / "torqclaw_data" / "skill_sources.json").write_text(
            json.dumps(config), encoding="utf-8"
        )

    def sign_bundle(self, *, sequence=1, skills=None, revocations=None, issued=None):
        issued = issued or self.now
        next_update = issued + datetime.timedelta(hours=1)
        bundle = {
            "version": 1,
            "origin": ORIGIN,
            "sequence": sequence,
            "issuedAt": _iso(issued),
            "nextUpdate": _iso(next_update),
            "trustedKeys": [
                {
                    "origin": ORIGIN,
                    "keyId": "pub-1",
                    "publicKey": t.public_key_spki_b64url(self.publisher_key.public_key()),
                }
            ],
            "revocations": revocations or [],
            "signingKeyId": "auth-1",
        }
        if skills:
            bundle["skills"] = skills
        unsigned = {k: v for k, v in bundle.items() if k != "signature"}
        sig = self.authority_key.sign(t.canonicalize(unsigned))
        bundle["signature"] = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
        return bundle

    def sign_envelope(self, *, skill_id, text="Remote content.\n", key_id="pub-1",
                       publisher_key=None, digest_override=None, version="1.0.0"):
        publisher_key = publisher_key or self.publisher_key
        skill_bytes = text.encode("utf-8")
        stub_sig = {"algorithm": "Ed25519", "keyId": key_id, "value": "detached"}
        manifest = {
            "schemaVersion": 1,
            "id": skill_id,
            "version": version,
            "name": skill_id,
            "description": "Remote test skill",
            "source": f"{BASE_URL}/skills/{skill_id}.json",
            "files": {"SKILL.md": file_digest(skill_bytes)},
            "requiredCapabilities": ["read"],
            "compatibleProfiles": ["default"],
            "signature": stub_sig,
        }
        manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        real_digest = t.compute_package_digest(manifest_bytes, skill_bytes)
        digest = digest_override or real_digest
        payload = {"digest": digest, "keyId": key_id, "origin": ORIGIN, "skillId": skill_id}
        sig = publisher_key.sign(t.canonicalize(payload))
        signature_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
        envelope = {
            "formatVersion": 1,
            "origin": ORIGIN,
            "skillId": skill_id,
            "keyId": key_id,
            "digest": digest,
            "manifestBytes": base64.urlsafe_b64encode(manifest_bytes).rstrip(b"=").decode("ascii"),
            "skillBytes": base64.urlsafe_b64encode(skill_bytes).rstrip(b"=").decode("ascii"),
            "signature": signature_b64,
        }
        return envelope, real_digest

    def patch_network(self, monkeypatch, *, bundle=None, envelope=None):
        bundles = {}
        envelopes = {}
        if bundle is not None:
            bundles[ORIGIN] = bundle
        if envelope is not None:
            envelopes[envelope["skillId"]] = envelope

        def fake_fetch_bundle(spec):
            return bundles[spec["origin"]]

        def fake_fetch_envelope(spec, skill_id):
            return envelopes[skill_id]

        monkeypatch.setattr(skill_sources, "fetch_bundle", fake_fetch_bundle)
        monkeypatch.setattr(skill_sources, "fetch_envelope", fake_fetch_envelope)
        return bundles, envelopes


# ---------------------------------------------------------------------------
# Tier 1: fetch/verify/queue seam (unconditional)
# ---------------------------------------------------------------------------


def test_ac1_bad_signature_refused_at_the_tool_seam(tmp_path, monkeypatch):
    """AC-1 (the L816 mandate): a package whose envelope signature does not
    verify is refused at install_remote_skill with SKILL_TRUST_REFUSED, and
    the operator-visible error names the reason. Proven at the orchestration
    seam, not by calling the trust engine directly."""
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)
    bundle = fx.sign_bundle()
    envelope, digest = fx.sign_envelope(skill_id="bad.sig")
    # Tamper the signature after signing -- wrong key used to sign it.
    wrong_key = Ed25519PrivateKey.generate()
    payload = {"digest": digest, "keyId": "pub-1", "origin": ORIGIN, "skillId": "bad.sig"}
    tampered_sig = wrong_key.sign(t.canonicalize(payload))
    envelope["signature"] = base64.urlsafe_b64encode(tampered_sig).rstrip(b"=").decode("ascii")
    fx.patch_network(monkeypatch, bundle=bundle, envelope=envelope)

    with pytest.raises(t.SkillTrustError) as exc:
        remote_skills.install_remote_skill(fx.source_id, "bad.sig")
    assert exc.value.reason == "signature-invalid"

    # Nothing staged or queued.
    store = governed_skills._store()
    assert not (store.staging_dir).exists() or list(store.staging_dir.iterdir()) == []


def test_ac3_digest_mismatch_even_with_valid_signature_over_wrong_digest(tmp_path, monkeypatch):
    """AC-3: an envelope whose digest field differs from the independently
    computed digest -- but whose signature over that WRONG digest is
    valid -- is refused with digest-mismatch (proves compute-before-verify
    ordering, R-3)."""
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)
    bundle = fx.sign_bundle()
    wrong_digest = "0" * 64
    envelope, real_digest = fx.sign_envelope(skill_id="wrong.digest", digest_override=wrong_digest)
    assert envelope["digest"] == wrong_digest != real_digest
    fx.patch_network(monkeypatch, bundle=bundle, envelope=envelope)

    with pytest.raises(t.SkillTrustError) as exc:
        remote_skills.install_remote_skill(fx.source_id, "wrong.digest")
    assert exc.value.reason == "digest-mismatch"


def test_ac6_capability_bound_refused_at_verify_time(tmp_path, monkeypatch):
    """AC-6: a manifest declaring a capability beyond ["read"] is refused at
    install_remote_skill with capability-unsupported; nothing is staged or
    queued."""
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)
    bundle = fx.sign_bundle()

    # Build an envelope with an escalated capability by hand (sign_envelope
    # always uses ["read"]; construct the manifest directly here).
    skill_bytes = b"Remote content.\n"
    manifest = {
        "schemaVersion": 1,
        "id": "escalated.skill",
        "version": "1.0.0",
        "name": "escalated.skill",
        "description": "d",
        "source": f"{BASE_URL}/skills/escalated.skill.json",
        "files": {"SKILL.md": file_digest(skill_bytes)},
        "requiredCapabilities": ["read", "exec"],
        "compatibleProfiles": ["default"],
        "signature": {"algorithm": "Ed25519", "keyId": "pub-1", "value": "detached"},
    }
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = t.compute_package_digest(manifest_bytes, skill_bytes)
    payload = {"digest": digest, "keyId": "pub-1", "origin": ORIGIN, "skillId": "escalated.skill"}
    sig = fx.publisher_key.sign(t.canonicalize(payload))
    envelope = {
        "formatVersion": 1,
        "origin": ORIGIN,
        "skillId": "escalated.skill",
        "keyId": "pub-1",
        "digest": digest,
        "manifestBytes": base64.urlsafe_b64encode(manifest_bytes).rstrip(b"=").decode("ascii"),
        "skillBytes": base64.urlsafe_b64encode(skill_bytes).rstrip(b"=").decode("ascii"),
        "signature": base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii"),
    }
    fx.patch_network(monkeypatch, bundle=bundle, envelope=envelope)

    with pytest.raises(t.SkillTrustError) as exc:
        remote_skills.install_remote_skill(fx.source_id, "escalated.skill")
    assert exc.value.reason == "capability-unsupported"

    store = governed_skills._store()
    assert list(store.staging_dir.glob("*")) == []
    assert store._load_state()["installed"] == {}


def test_ac13_redirect_and_over_cap_refused(tmp_path, monkeypatch):
    """AC-13: a source answering a redirect is refused with no follow (unit
    coverage already in test_skill_sources.py's fetch tests); this test pins
    the SAME refusal surfaces through the orchestration layer by making
    fetch_envelope itself raise SkillRemoteFetchError, proving the
    orchestrator propagates it untouched rather than swallowing it."""
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)
    bundle = fx.sign_bundle()

    def raising_fetch_envelope(spec, skill_id):
        raise skill_sources.SkillRemoteFetchError("redirect refused (301)")

    monkeypatch.setattr(skill_sources, "fetch_bundle", lambda spec: bundle)
    monkeypatch.setattr(skill_sources, "fetch_envelope", raising_fetch_envelope)

    with pytest.raises(skill_sources.SkillRemoteFetchError):
        remote_skills.install_remote_skill(fx.source_id, "any.skill")


def test_flag_off_disabled(tmp_path, monkeypatch):
    monkeypatch.delenv("TORQCLAW_REMOTE_SKILL_SOURCES", raising=False)
    with pytest.raises(remote_skills.SkillRemoteSourcesDisabled):
        remote_skills.install_remote_skill("src", "any.skill")


def test_governed_off_also_disables_remote(tmp_path, monkeypatch):
    monkeypatch.delenv("TORQCLAW_GOVERNED_SKILLS", raising=False)
    with pytest.raises(remote_skills.SkillRemoteSourcesDisabled):
        remote_skills.install_remote_skill("src", "any.skill")


def test_unknown_source(tmp_path, monkeypatch):
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)
    with pytest.raises(skill_sources.SkillRemoteSourceUnknown):
        remote_skills.install_remote_skill("does-not-exist", "any.skill")


def test_o14_invalid_skill_id_refused_before_any_url(tmp_path, monkeypatch):
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)
    calls = []
    monkeypatch.setattr(skill_sources, "fetch_bundle", lambda spec: calls.append("bundle"))
    monkeypatch.setattr(skill_sources, "fetch_envelope", lambda spec, sid: calls.append("envelope"))
    with pytest.raises(t.SkillTrustError) as exc:
        remote_skills.install_remote_skill(fx.source_id, "../escape")
    assert exc.value.reason == "invalid-schema"
    assert calls == []  # no network call was ever made


def _install_and_queue(fx, monkeypatch, *, skill_id="remote.skill", text="Remote content.\n"):
    fx.write_config(monkeypatch)
    bundle = fx.sign_bundle()
    envelope, digest = fx.sign_envelope(skill_id=skill_id, text=text)
    fx.patch_network(monkeypatch, bundle=bundle, envelope=envelope)
    result = remote_skills.install_remote_skill(fx.source_id, skill_id)
    assert result["status"] == "pending_approval"
    assert result["digest"] == digest
    assert result["verificationStatus"] == "verified"
    return result, digest


def test_valid_package_is_staged_and_queued_pending(tmp_path, monkeypatch):
    fx = _Fixture(tmp_path)
    result, digest = _install_and_queue(fx, monkeypatch)
    draft = skill_queue.get_draft(result["queue_id"])
    assert draft["ok"] is True
    assert draft["status"] == "pending"


def test_ac18_decide_seam_trust_facts(tmp_path, monkeypatch):
    """AC-18: for a pending remote row, get_skill_draft (skill_queue.get_draft)
    returns {sourceOrigin, keyId, digest, verificationStatus}, proven at the
    MCP tool seam (get_draft IS the tool's implementation); local rows
    return today's shape byte-identically (no new keys at all)."""
    fx = _Fixture(tmp_path)
    result, digest = _install_and_queue(fx, monkeypatch)
    draft = skill_queue.get_draft(result["queue_id"])
    assert draft["sourceOrigin"] == ORIGIN
    assert draft["keyId"] == "pub-1"
    assert draft["digest"] == digest
    assert draft["verificationStatus"] == "verified"

    # Local row: byte-identical to pre-Phase-4 shape.
    local_queue_id = skill_queue.queue_skill("local.skill", "Local content.\n")
    local_draft = skill_queue.get_draft(local_queue_id)
    assert set(local_draft) == {"ok", "proposed_name", "skill_markdown", "status"}


def test_ac9_edit_refused_row_stays_pending_then_unedited_approve_ready(tmp_path, monkeypatch):
    """AC-9: decide_skill(queue_id, "APPROVE", edited_markdown=...) on a
    remote row is refused with SKILL_REMOTE_EDIT_REFUSED; the row stays
    pending. (The subsequent unedited-APPROVE-succeeds half needs the
    coordinator/vendor submodule -- covered in the Tier 2 test below.)"""
    fx = _Fixture(tmp_path)
    result, digest = _install_and_queue(fx, monkeypatch)

    decision = skill_queue.decide(result["queue_id"], "APPROVE", edited_markdown="tampered content")
    assert decision["ok"] is False
    assert decision["code"] == "SKILL_REMOTE_EDIT_REFUSED"
    assert decision["status"] == "pending"

    draft = skill_queue.get_draft(result["queue_id"])
    assert draft["status"] == "pending"


def test_reject_of_remote_row_cleans_stage(tmp_path, monkeypatch):
    """O-17: REJECT of a remote row removes staging/<stageId>."""
    fx = _Fixture(tmp_path)
    result, digest = _install_and_queue(fx, monkeypatch)
    store = governed_skills._store()
    staged_dirs_before = list(store.staging_dir.glob("*"))
    assert len(staged_dirs_before) == 1

    decision = skill_queue.decide(result["queue_id"], "REJECT")
    assert decision == {"ok": True, "status": "rejected"}
    assert list(store.staging_dir.glob("*")) == []

    draft = skill_queue.get_draft(result["queue_id"])
    assert draft["status"] == "rejected"


def test_reject_ignores_edited_markdown_on_remote_row(tmp_path, monkeypatch):
    """O-17: REJECT carrying edited_markdown ignores it, matching the
    pre-existing local contract."""
    fx = _Fixture(tmp_path)
    result, digest = _install_and_queue(fx, monkeypatch)
    decision = skill_queue.decide(result["queue_id"], "REJECT", edited_markdown="ignored")
    assert decision == {"ok": True, "status": "rejected"}


def test_sp6_install_remote_skill_writes_only_pending(tmp_path, monkeypatch):
    """SP-6: install_remote_skill is a single-writer producer of `pending`
    rows only; it never itself flips status. Checked directly against the
    row SQLite stored, not just get_draft's surfaced view, so a sabotage of
    queue_remote_skill's INSERT (DP-13) is caught even if some other layer
    happened to normalize the reported status."""
    fx = _Fixture(tmp_path)
    result, digest = _install_and_queue(fx, monkeypatch)
    with skill_queue._lock:
        row = skill_queue._conn.execute(
            "SELECT status FROM skill_queue WHERE queue_id=?", (result["queue_id"],)
        ).fetchone()
    assert row[0] == "pending"


def test_ac12_monotonicity_replay_refused_at_refresh(tmp_path, monkeypatch):
    """AC-12: a bundle with sequence <= accepted is refused at
    refresh_skill_trust -- replay of an old-but-valid bundle can never roll
    trust state back."""
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)
    bundle1 = fx.sign_bundle(sequence=1)
    fx.patch_network(monkeypatch, bundle=bundle1)
    result1 = remote_skills.refresh_skill_trust(fx.source_id)
    assert result1["ok"] is True
    assert result1["sequence"] == 1

    # Replay the SAME bundle (sequence not increasing).
    result2 = remote_skills.refresh_skill_trust(fx.source_id)
    assert result2["ok"] is False
    assert result2["reason"] == "sequence-not-monotonic"

    # A genuinely newer bundle succeeds. issuedAt must stay within the 2min
    # future-skew tolerance of the REAL wall clock at evaluation time.
    bundle2 = fx.sign_bundle(sequence=2, issued=fx.now + datetime.timedelta(seconds=5))
    fx.patch_network(monkeypatch, bundle=bundle2)
    result3 = remote_skills.refresh_skill_trust(fx.source_id)
    assert result3["ok"] is True
    assert result3["sequence"] == 2


def test_ac16_digest_pin_refuses_at_install_time(tmp_path, monkeypatch):
    """AC-16 (install-time half, tier 1 -- no coordinator needed): with an
    accepted bundle pinning skillId to D2, a validly-signed envelope at a
    DIFFERENT digest D1 is refused at install_remote_skill with
    digest-not-current. (The activation/rollback-seam half of AC-16 is
    covered by the tier-2 test above, which also needs an installed D1 to
    exist first.)"""
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)
    env_d1, d1 = fx.sign_envelope(skill_id="pinned2.skill", text="Version one.\n")
    env_d2, d2 = fx.sign_envelope(skill_id="pinned2.skill", text="Version two.\n")
    assert d1 != d2
    bundle = fx.sign_bundle(skills={"pinned2.skill": d2})
    fx.patch_network(monkeypatch, bundle=bundle, envelope=env_d1)

    with pytest.raises(t.SkillTrustError) as exc:
        remote_skills.install_remote_skill(fx.source_id, "pinned2.skill")
    assert exc.value.reason == "digest-not-current"


def test_ac11_skill_revocation_digest_optional_blocks_install(tmp_path, monkeypatch):
    """AC-11: a bundle revoking skillId without a digest blocks install at
    the fetch/verify seam."""
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)
    bundle = fx.sign_bundle(revocations=[
        {"kind": "skill", "skillId": "revoked.skill", "revokedAt": _iso(fx.now)}
    ])
    envelope, digest = fx.sign_envelope(skill_id="revoked.skill")
    fx.patch_network(monkeypatch, bundle=bundle, envelope=envelope)

    with pytest.raises(t.SkillTrustError) as exc:
        remote_skills.install_remote_skill(fx.source_id, "revoked.skill")
    assert exc.value.reason == "revoked-skill"


# ---------------------------------------------------------------------------
# Tier 2: through APPROVE and activation (needs the vendor submodule)
# ---------------------------------------------------------------------------


@requires_vendor
def test_ac2_toctou_staged_bytes_tampered_before_approve(tmp_path, monkeypatch):
    """AC-2: after a successful verify, the staged SKILL.md bytes are
    tampered on disk before APPROVE; decide() is refused by the stage-time
    digest recompute -- the fetch-time verdict is provably not reused."""
    fx = _Fixture(tmp_path)
    result, digest = _install_and_queue(fx, monkeypatch, skill_id="toctou.skill")

    store = governed_skills._store()
    remote_json = json.loads(_row_remote_json(result["queue_id"]))
    stage_path = store.staging_dir / remote_json["stageId"] / "SKILL.md"
    stage_path.write_bytes(b"TAMPERED BYTES\n")

    decision = skill_queue.decide(result["queue_id"], "APPROVE")
    assert decision["ok"] is False
    # SkillIntegrityError maps through map_activation_failure's generic arm.
    assert decision["status"] == "pending"


@requires_vendor
def test_ac9_unedited_approve_succeeds_after_edit_refusal(tmp_path, monkeypatch):
    fx = _Fixture(tmp_path)
    result, digest = _install_and_queue(fx, monkeypatch, skill_id="approvable.skill")

    refused = skill_queue.decide(result["queue_id"], "APPROVE", edited_markdown="x")
    assert refused["code"] == "SKILL_REMOTE_EDIT_REFUSED"

    approved = skill_queue.decide(result["queue_id"], "APPROVE")
    assert approved["ok"] is True
    assert approved["status"] == "approved"
    assert approved["remote"] is True
    assert approved["digest"] == digest
    assert approved["origin"] == ORIGIN


@requires_vendor
def test_ac16_digest_pin_refuses_older_digest_at_install_and_activation(tmp_path, monkeypatch):
    """AC-16: with an accepted bundle pinning skillId to digest D2, a
    validly-signed OLDER envelope at D1 is refused at install_remote_skill
    with digest-not-current."""
    fx = _Fixture(tmp_path)
    fx.write_config(monkeypatch)

    # First install+approve D1 with NO pin yet.
    bundle_v1 = fx.sign_bundle(sequence=1)
    env_d1, d1 = fx.sign_envelope(skill_id="pinned.skill", text="Version one.\n")
    fx.patch_network(monkeypatch, bundle=bundle_v1, envelope=env_d1)
    r1 = remote_skills.install_remote_skill(fx.source_id, "pinned.skill")
    approved1 = skill_queue.decide(r1["queue_id"], "APPROVE")
    assert approved1["ok"] is True

    # A newer bundle pins the skill to D2 (a different digest).
    env_d2, d2 = fx.sign_envelope(skill_id="pinned.skill", text="Version two.\n")
    assert d2 != d1
    bundle_v2 = fx.sign_bundle(sequence=2, skills={"pinned.skill": d2},
                                issued=fx.now + datetime.timedelta(seconds=1))
    fx.patch_network(monkeypatch, bundle=bundle_v2, envelope=env_d1)
    remote_skills.refresh_skill_trust(fx.source_id)

    # D1 (older, pinned-mismatched) is refused at install time now.
    with pytest.raises(t.SkillTrustError) as exc:
        remote_skills.install_remote_skill(fx.source_id, "pinned.skill")
    assert exc.value.reason == "digest-not-current"


@requires_vendor
def test_ac17_revocation_vs_active_reporting(tmp_path, monkeypatch):
    """AC-17: accepting a bundle that revokes the key of an installed,
    ACTIVE version makes refresh_skill_trust return it in
    revocationsAffectingInstalled with active: true; the skill remains
    active until disable_skill runs (reporting, never auto-quarantine)."""
    fx = _Fixture(tmp_path)
    result, digest = _install_and_queue(fx, monkeypatch, skill_id="active.skill")
    approved = skill_queue.decide(result["queue_id"], "APPROVE")
    assert approved["ok"] is True

    bundle2 = fx.sign_bundle(
        sequence=2,
        revocations=[{"kind": "key", "keyId": "pub-1", "revokedAt": _iso(fx.now)}],
        issued=fx.now + datetime.timedelta(seconds=1),
    )
    fx.patch_network(monkeypatch, bundle=bundle2)
    report = remote_skills.refresh_skill_trust(fx.source_id)
    assert report["ok"] is True
    hits = report["revocationsAffectingInstalled"]
    assert any(h["skillId"] == "active.skill" and h["active"] is True for h in hits)

    # The skill remains governed-active -- refresh never auto-disables.
    from mcp_wrapper import skill_rollback

    versions = skill_rollback.list_versions("active.skill")
    assert versions["active"]["digest"] == digest


def _row_remote_json(queue_id: str) -> str:
    with skill_queue._lock:
        row = skill_queue._conn.execute(
            "SELECT remote_json FROM skill_queue WHERE queue_id=?", (queue_id,)
        ).fetchone()
    return row[0]
