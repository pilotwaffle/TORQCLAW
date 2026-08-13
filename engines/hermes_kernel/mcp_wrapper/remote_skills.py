"""P4-5: remote skill install flow -- the MCP tool seam for signed remote
skill sources (§6.1 ``install_remote_skill``, §6.5 ``refresh_skill_trust``).

Every step here runs BEFORE any queue write and OUTSIDE the coordinator's
``_MUTATION_LOCK`` (R-2/RS-4/SP-3): config resolution, trust-bundle refresh,
envelope fetch, and cryptographic verification are all local computation or
network I/O that must never happen while holding the lock that fences Hermes
run admission (``runtime_quiescence.hermes_run_admission``).

This module is the orchestrator: it calls ``skill_sources`` (config +
bounded fetch), ``skill_trust`` (the ``TrustEngine`` -- verification order
per §5.3), ``governed_skills._store()`` (staging), and ``skill_queue``
(the pending-row write). It owns no cryptography and no fetch bounds of its
own -- both live in the modules that already own them (SP-4/SP-7 discipline
extended to this orchestration layer).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import governed_skills, skill_queue, skill_sources
from .skill_trust import SkillTrustError, TrustEngine, compute_package_digest


def _get_trust_evaluator() -> TrustEngine:
    """Return the process singleton's trust evaluator, fail-closed if unwired
    (O-5) -- mirrors the exact fail-closed contract ``_enforce_activation_
    policy`` applies at the store's own policy seam, so a caller reaching
    this module without a constructed evaluator gets the same typed refusal
    it would have gotten at activation time, just earlier."""
    store = governed_skills._store()
    evaluator = getattr(store, "_trust_evaluator", None)
    if evaluator is None:
        raise SkillTrustError("trust-engine-unavailable")
    return evaluator


def _gate() -> None:
    """§6.1 step 1: TORQCLAW_REMOTE_SKILL_SOURCES truthy AND governed_skills
    enabled -- else SKILL_REMOTE_SOURCES_DISABLED. Read per-call (never
    captured at import), matching the flag's `_TRUTHY` discipline."""
    if not skill_sources.remote_flag_on() or not governed_skills.enabled():
        raise SkillRemoteSourcesDisabled()


class SkillRemoteSourcesDisabled(Exception):
    """TORQCLAW_REMOTE_SKILL_SOURCES is off (or governed skills is off)."""


def _ensure_bundle_fresh(engine: TrustEngine, source_id: str, spec: dict) -> None:
    """§6.1 step 4 / R-8 refresh-on-use: if the origin's persisted bundle is
    missing or outside its window, fetch trust-bundle.json and accept it.
    Still stale/refused afterward => the typed refusal propagates as-is."""
    origin = spec["origin"]
    try:
        engine.require_fresh_origin(origin)
        return  # already fresh -- no fetch needed
    except SkillTrustError:
        pass
    bundle = skill_sources.fetch_bundle(spec)
    engine.apply_bundle(source_id, origin, bundle)
    # Re-check after accepting -- if the freshly accepted bundle is STILL
    # not usable (e.g. clock-rollback quarantine), the SkillTrustError from
    # this call is the one that propagates to the caller.
    engine.require_fresh_origin(origin)


def install_remote_skill(
    source_id: str, skill_id: str, source_task_id: str | None = None
) -> dict[str, Any]:
    """§6.1: fetch, verify, stage, and queue a signed remote skill.

    Every step before the queue write is outside all locks (R-2/RS-4).
    Returns ``{status: "pending_approval", queue_id, digest, origin, keyId,
    verificationStatus: "verified"}`` on success. Raises typed exceptions on
    every refusal arm (SkillRemoteSourcesDisabled, SkillRemoteConfigError,
    SkillRemoteSourceUnknown, SkillRemoteFetchError, SkillTrustError) --
    the MCP tool wrapper in server.py maps these to the operator-facing
    shape via ``governed_skills.map_activation_failure``.
    """
    # Step 1: gate.
    _gate()

    # Step 2 (O-14): validate skill_id BEFORE any URL is constructed and
    # before any artifacts/<skillId>/ path is formed.
    from .verified_skill_store import _ID_RE

    if not isinstance(skill_id, str) or not _ID_RE.fullmatch(skill_id):
        raise SkillTrustError("invalid-schema", "invalid skillId")

    # Step 3: config.
    config = skill_sources.load_config()
    spec = skill_sources.resolve_source(config, source_id)
    origin = spec["origin"]

    engine = _get_trust_evaluator()

    # Step 4: trust refresh (fetch-time freshness, R-8).
    _ensure_bundle_fresh(engine, source_id, spec)

    # Step 5: fetch envelope + verify (§5.3 order).
    raw_envelope = skill_sources.fetch_envelope(spec, skill_id)
    from .skill_trust import parse_envelope

    envelope = parse_envelope(raw_envelope)
    if envelope["origin"] != origin:
        raise SkillTrustError("origin-mismatch", "envelope origin != configured source origin")
    if envelope["skillId"] != skill_id:
        raise SkillTrustError("invalid-schema", "envelope skillId != requested skillId")

    from .skill_trust import decode_b64url

    manifest_bytes = decode_b64url(envelope["manifestBytes"])
    skill_bytes = decode_b64url(envelope["skillBytes"])

    # Compute the digest independently from the decoded bytes BEFORE any
    # signature evaluation (R-3) -- compare to the envelope's claimed digest.
    computed_digest = compute_package_digest(manifest_bytes, skill_bytes)
    if computed_digest != envelope["digest"]:
        raise SkillTrustError("digest-mismatch")

    manifest = json.loads(manifest_bytes.decode("utf-8"))
    required_capabilities = list(manifest.get("requiredCapabilities", []))

    # Full trust evaluation: freshness, key trust/revocation, signature,
    # skill revocation, digest-pin, capability bound (§5.3 order, R-7).
    engine.evaluate_artifact(
        origin=origin,
        skill_id=skill_id,
        key_id=envelope["keyId"],
        digest=computed_digest,
        signature=envelope["signature"],
        required_capabilities=required_capabilities,
    )

    # Manifest cross-checks (§5.3): source == fetch URL, id == envelope
    # skillId, in-manifest signature.keyId == envelope keyId.
    fetch_url = spec["baseUrl"].rstrip("/") + f"/skills/{skill_id}.json"
    if manifest.get("source") != fetch_url:
        raise SkillTrustError("invalid-schema", "manifest source != fetch URL")
    if manifest.get("id") != skill_id:
        raise SkillTrustError("invalid-schema", "manifest id != envelope skillId")
    manifest_sig = manifest.get("signature")
    if not isinstance(manifest_sig, dict) or manifest_sig.get("keyId") != envelope["keyId"]:
        raise SkillTrustError("invalid-schema", "manifest signature.keyId != envelope keyId")
    if manifest_sig.get("algorithm") != "Ed25519":
        raise SkillTrustError("invalid-schema", "manifest signature.algorithm must be Ed25519")

    # Step 6: persist the verified signature envelope (§5.6 artifacts/).
    engine.persist_artifact_record(
        skill_id, computed_digest, origin, envelope["keyId"], envelope["signature"]
    )

    # Step 7: stage. The store recomputes and re-validates everything.
    import tempfile

    store = governed_skills._store()
    workspace = Path(tempfile.mkdtemp(prefix=".torqclaw-remote-", dir=governed_skills._data_dir()))
    try:
        package_dir = workspace / "package"
        package_dir.mkdir()
        (package_dir / "skill.json").write_bytes(manifest_bytes)
        (package_dir / "SKILL.md").write_bytes(skill_bytes)
        staged = store.stage(package_dir)
    finally:
        import shutil

        shutil.rmtree(workspace, ignore_errors=True)

    if staged["digest"] != computed_digest:
        from .verified_skill_store import SkillIntegrityError

        raise SkillIntegrityError("staged bytes changed during copy")

    # Step 8: queue a pending row.
    remote_json = json.dumps(
        {
            "sourceId": source_id,
            "origin": origin,
            "keyId": envelope["keyId"],
            "digest": computed_digest,
            "stageId": staged["stageId"],
            "verifiedAt": _now_iso(),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    queue_id = skill_queue.queue_remote_skill(
        skill_id, skill_bytes.decode("utf-8"), remote_json, source_task_id
    )

    # Step 9: surface a PENDING_APPROVAL event when a source_task_id was
    # supplied, exactly like draft_and_queue_skill (server.py:398-408) --
    # same <=8KB ride-along rule, with R-10(b) trust facts added to meta.
    if source_task_id:
        from . import task_store

        meta: dict[str, Any] = {
            "queueId": queue_id,
            "skillName": skill_id,
            "sourceOrigin": origin,
            "keyId": envelope["keyId"],
            "digest": computed_digest,
            "verificationStatus": "verified",
        }
        skill_markdown = skill_bytes.decode("utf-8")
        if len(skill_markdown) <= 8192:
            meta["skillMarkdown"] = skill_markdown
        task_store.emit(
            source_task_id, "PENDING_APPROVAL",
            f"New remote skill drafted: {skill_id}", meta,
        )

    return {
        "status": "pending_approval",
        "queue_id": queue_id,
        "digest": computed_digest,
        "origin": origin,
        "keyId": envelope["keyId"],
        "verificationStatus": "verified",
    }


def _now_iso() -> str:
    import datetime

    now = datetime.datetime.now(tz=datetime.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def refresh_skill_trust(source_id: str) -> dict[str, Any]:
    """§6.5: fetch + acceptance of the origin's bundle on demand, outside all
    locks. The retry remedy for SKILL_TRUST_STALE and the recovery vehicle
    for quarantine. The only network path besides the envelope fetch;
    neither ever runs under _MUTATION_LOCK (RS-4/SP-3).

    O-2 (normative): after accepting, scans installed/active records against
    the new bundle's key/skill revocations and digest pins, and RETURNS the
    matches -- reporting only (RS-6): this never auto-disables or mutates
    governed state.
    """
    _gate()

    config = skill_sources.load_config()
    spec = skill_sources.resolve_source(config, source_id)
    origin = spec["origin"]
    engine = _get_trust_evaluator()

    bundle = skill_sources.fetch_bundle(spec)
    try:
        decision = engine.apply_bundle(source_id, origin, bundle)
    except SkillTrustError as exc:
        return {"ok": False, "origin": origin, "reason": exc.reason}

    # G-4 (PRD §18): snapshot installed/active state under store._lock, then
    # release it before any trust-lock work -- never iterate live store
    # state while doing trust-engine work (SP-9 leaf-lock discipline).
    store = governed_skills._store()
    installed_snapshot: list[dict[str, Any]] = []
    with store._lock:
        state = store._load_state()
        active_digests = {sid: rec.get("digest") for sid, rec in state["active"].items()}
        for sid, digests in state["installed"].items():
            for digest, rec in digests.items():
                if not isinstance(rec, dict) or rec.get("origin") != origin:
                    continue
                installed_snapshot.append(
                    {
                        "skillId": sid,
                        "digest": digest,
                        "keyId": rec.get("keyId"),
                        "active": active_digests.get(sid) == digest,
                    }
                )

    hits = engine.scan_revocations_for(origin, installed_snapshot)

    return {
        "ok": True,
        "origin": origin,
        "sequence": decision["sequence"],
        "decision": "accepted",
        "revocationsAffectingInstalled": hits,
    }
