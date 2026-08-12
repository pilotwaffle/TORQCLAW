"""Human-in-the-loop gate over Hermes' autonomous skill deployment.
Drafted skills land here as 'pending'; the console's APPROVE_SKILL command
decides them. Approved skills are written to the Hermes skills directory."""
import os
import sqlite3
import threading
import uuid
from pathlib import Path

DATA_DIR = Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw")
DATA_DIR.mkdir(parents=True, exist_ok=True)  # import order independence
SKILLS_DIR = Path(os.environ.get("HERMES_SKILLS_DIR", Path.home() / ".hermes" / "skills"))

_conn = sqlite3.connect(DATA_DIR / "hermes_tasks.db", check_same_thread=False)
_lock = threading.Lock()

_conn.executescript("""
CREATE TABLE IF NOT EXISTS skill_queue (
    queue_id TEXT PRIMARY KEY,
    proposed_name TEXT NOT NULL,
    skill_markdown TEXT NOT NULL,
    source_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
);
""")

# Phase 4 (§5.7, R-6): one additive nullable column, PRAGMA-guarded so this
# never re-runs on an existing DB (CREATE TABLE IF NOT EXISTS above never
# re-executes either -- same precedent as storage.ts:107-111 / PRD-004 §1.3,
# applied in Python). Every legacy row keeps remote_json NULL, which means
# "local row, exactly today's semantics" -- decide() branches on this column
# being non-NULL to route through the remote flow (§6.2), never on any other
# signal. Repeat-safe: a second boot against the same DB sees the column
# already present and skips the ALTER.
with _lock:
    _existing_columns = {
        row[1] for row in _conn.execute("PRAGMA table_info(skill_queue)").fetchall()
    }
    if "remote_json" not in _existing_columns:
        _conn.execute("ALTER TABLE skill_queue ADD COLUMN remote_json TEXT")
        _conn.commit()


def queue_skill(proposed_name: str, markdown: str, source_task_id: str | None = None) -> str:
    queue_id = str(uuid.uuid4())
    with _lock:
        _conn.execute(
            "INSERT INTO skill_queue (queue_id, proposed_name, skill_markdown, source_task_id) "
            "VALUES (?, ?, ?, ?)",
            (queue_id, proposed_name, markdown, source_task_id),
        )
        _conn.commit()
    return queue_id


def queue_remote_skill(
    skill_id: str,
    skill_markdown: str,
    remote_json: str,
    source_task_id: str | None = None,
) -> str:
    """P4-5 (§6.1 step 8, RS-6): insert a REMOTE pending row.

    ``remote_json`` is the caller's already-serialized
    ``{sourceId, origin, keyId, digest, stageId, verifiedAt}`` (§5.7) --
    serialization happens in ``remote_skills.py`` so this module stays a bare
    SQL surface with no JSON-shape knowledge of its own, matching how it
    already treats ``skill_markdown`` as an opaque string.

    RS-6 (single decision writer): this function writes ONLY a new `pending`
    row -- it never flips any row's status. Two concurrent calls for the same
    skill_id produce two independent pending rows (§6.1's documented benign
    race); whichever is decided second reconciles idempotently against the
    same pinned digest.
    """
    queue_id = str(uuid.uuid4())
    with _lock:
        _conn.execute(
            "INSERT INTO skill_queue (queue_id, proposed_name, skill_markdown, "
            "source_task_id, remote_json) VALUES (?, ?, ?, ?, ?)",
            (queue_id, skill_id, skill_markdown, source_task_id, remote_json),
        )
        _conn.commit()
    return queue_id


def get_draft(queue_id: str) -> dict:
    """Return a draft's full markdown — for the console to prefill its editor
    when the draft was too large to ride in the approval event metadata.

    P4-5 (§7.2, AC-18): for a remote row, also returns the trust facts
    {sourceOrigin, keyId, digest, verificationStatus} read from remote_json
    -- the decide seam the operator actually uses. Local rows return exactly
    today's shape, byte-identically (no remote_json key at all).
    """
    with _lock:
        row = _conn.execute(
            "SELECT proposed_name, skill_markdown, status, remote_json "
            "FROM skill_queue WHERE queue_id=?",
            (queue_id,),
        ).fetchone()
    if row is None:
        return {"ok": False, "error": "unknown queue_id"}
    name, markdown, status, remote_json = row
    result = {"ok": True, "proposed_name": name, "skill_markdown": markdown, "status": status}
    if remote_json is not None:
        import json

        meta = json.loads(remote_json)
        result["sourceOrigin"] = meta["origin"]
        result["keyId"] = meta["keyId"]
        result["digest"] = meta["digest"]
        result["verificationStatus"] = "verified"
    return result


def _decide_remote(
    queue_id: str,
    skill_id: str,
    markdown: str,
    remote_json: str,
    decision: str,
    edited_markdown: str | None,
) -> dict:
    """P4-5 (§6.2): decide a REMOTE row. Called with ``_lock`` already held,
    matching the local path's concurrency discipline (a concurrent decide()
    on the same queue_id still observes ``status != "pending"`` after this
    returns and is rejected by the caller's guard).

    - APPROVE + edited_markdown: refused BEFORE any state change
      (SKILL_REMOTE_EDIT_REFUSED, O-17) -- the signature covers exact bytes
      (R-3); an edit would change the digest and sever the signature. The
      row stays pending. Scoped to APPROVE only: REJECT carrying
      edited_markdown ignores it, matching the pre-existing local contract
      that edited_markdown is ignored on REJECT.
    - REJECT: unconditional pending -> rejected, plus staging cleanup
      (O-17) -- the fetched bytes are no longer needed. The
      skill_trust/artifacts/ record MAY remain; it is evidence, not
      authority.
    - APPROVE (no edit): routes to governed_skills.install_remote_staged,
      the remote analog of install_approved_skill. Row flips to approved
      ONLY after success -- the same GS-COORD ordering as the local path.
    """
    import json

    meta = json.loads(remote_json)

    if decision == "APPROVE" and edited_markdown is not None:
        return {
            "ok": False,
            "code": "SKILL_REMOTE_EDIT_REFUSED",
            "retryable": False,
            "status": "pending",
            "error": (
                "edited_markdown is refused for a remote (signed) skill: the "
                "signature covers exact bytes, and an edit would change the "
                "digest and sever it. Approve unedited, or reject and "
                "re-install from source with different content."
            ),
        }

    if decision != "APPROVE":
        _conn.execute(
            "UPDATE skill_queue SET status=? WHERE queue_id=?", ("rejected", queue_id)
        )
        _conn.commit()
        from . import governed_skills

        governed_skills.discard_remote_stage(meta.get("stageId"))
        return {"ok": True, "status": "rejected"}

    from . import governed_skills

    try:
        installed = governed_skills.install_remote_staged(
            skill_id=skill_id, skill_markdown=markdown, remote_meta=meta
        )
    except Exception as exc:  # noqa: BLE001 - mapped uniformly below
        return governed_skills.map_activation_failure(exc, queue_status="pending")

    _conn.execute(
        "UPDATE skill_queue SET status=? WHERE queue_id=?", ("approved", queue_id)
    )
    _conn.commit()
    result = {
        "ok": True,
        "status": "approved",
        "governed": True,
        "remote": True,
        "digest": installed["digest"],
        "path": installed["publishedPath"],
        "origin": meta["origin"],
        "keyId": meta["keyId"],
    }
    if installed.get("reconciledFromPriorSuccess"):
        result["reconciledFromPriorSuccess"] = True
    return result


def decide(queue_id: str, decision: str, edited_markdown: str | None = None) -> dict:
    """Decide a queued skill. P4: APPROVE may carry edited_markdown to write
    instead of the draft (status 'approved_edited'); a plain APPROVE writes the
    draft as-is. edited_markdown is ignored on REJECT.

    GS-COORD ordering (frozen operator ruling): the queue status must
    represent an EFFECTIVE approval, not operator intent.

        pending --(REJECT)--------------> rejected              (unconditional)
        pending --(Hermes busy)---------> REFUSE, row stays pending
        pending --(activation fails)----> restore/abort, row stays pending
        pending --(activation succeeds)-> approved / approved_edited

    So under the governed path, the queue row is flipped to
    approved/approved_edited ONLY AFTER ``governed_skills.install_approved_skill``
    has returned success -- never before. This is the fix for the defect
    where the row used to flip BEFORE installing (see the old comment this
    replaces): a failed install used to leave the row permanently
    unretryable (the ``status != "pending"`` guard below rejects any second
    decide() on the same id) with the approval already "consumed" from the
    queue's point of view and nothing ever installed.

    REJECT is unchanged: pending -> rejected immediately, independent of
    quiescence or governance -- rejecting never touches Hermes state.

    The legacy path (``TORQCLAW_GOVERNED_SKILLS`` unset/falsy) is preserved
    byte-for-byte: the flip-then-write ordering and exact return shapes are
    untouched, so every existing legacy-path caller/test keeps working
    exactly as before.
    """
    with _lock:
        row = _conn.execute(
            "SELECT proposed_name, skill_markdown, status, remote_json "
            "FROM skill_queue WHERE queue_id=?",
            (queue_id,),
        ).fetchone()
        if row is None:
            return {"ok": False, "error": "unknown queue_id"}
        name, markdown, status, remote_json = row
        if status != "pending":
            return {"ok": False, "error": f"already {status}"}

        # P4-5 (§6.2): a row with remote_json is a REMOTE row -- the signed
        # package flow, distinct from every branch below it.
        if remote_json is not None:
            return _decide_remote(queue_id, name, markdown, remote_json, decision, edited_markdown)

        if decision != "APPROVE":
            _conn.execute(
                "UPDATE skill_queue SET status=? WHERE queue_id=?", ("rejected", queue_id)
            )
            _conn.commit()
            return {"ok": True, "status": "rejected"}

        new_status = "approved_edited" if edited_markdown is not None else "approved"
        content = edited_markdown if new_status == "approved_edited" else markdown

        # Governed path (opt-in via TORQCLAW_GOVERNED_SKILLS): stage -> approve
        # -> ActivationCoordinator (retain -> publish -> invalidate -> activate
        # -> verify) through VerifiedSkillStore + skill_publisher, producing a
        # digest-bound, audited, rollback-capable artifact whose
        # discoverability is verified against the real Hermes loader.
        #
        # The legacy branch below is a bare write: no digest, no manifest, no
        # audit, and no validation of `name` (so "../escape" writes outside the
        # skills tree). It remains the default so enabling governance stays an
        # explicit operator decision rather than a behaviour change shipped as
        # a refactor.
        from . import governed_skills

        if governed_skills.enabled():
            # The whole install attempt happens WHILE STILL HOLDING `_lock`
            # (the frozen concurrency ruling: serialize the decision attempt
            # through the existing skill-queue lock). The row is not flipped
            # to approved/approved_edited until AFTER install succeeds, so a
            # concurrent decide() on the very same queue_id from another
            # thread still observes `status == "pending"` and is correctly
            # rejected by the guard above -- it cannot race a second
            # activation attempt in.
            try:
                installed = governed_skills.install_approved_skill(name, content)
            except Exception as exc:
                # The full operator-facing failure taxonomy (busy / the two
                # non-retryable UNPROVEN codes / generic retryable) lives in
                # governed_skills.map_activation_failure -- ONE mapping,
                # shared with the rollback surface (skill_rollback.py) so
                # the shapes cannot drift, with each arm's full rationale on
                # that function and the exception classes themselves.
                # queue_status="pending" keeps every failure result here
                # byte-identical to the pre-extraction shapes (pinned by
                # test_governed_rollback's golden-shape test of the mapper,
                # plus the decide()-level BUSY/CACHE_UNPROVEN pins in
                # test_activation_coordinator_wiring): the row genuinely
                # stays pending on every failure arm.
                return governed_skills.map_activation_failure(
                    exc, queue_status="pending"
                )

            _conn.execute(
                "UPDATE skill_queue SET status=? WHERE queue_id=?", (new_status, queue_id)
            )
            _conn.commit()
            result = {
                "ok": True,
                "status": new_status,
                "governed": True,
                "digest": installed["digest"],
                "path": installed["publishedPath"],
            }
            if installed.get("reconciledFromPriorSuccess"):
                # Success-side crash reconciliation (GS-COORD): this exact
                # digest was already governed-active and published from a
                # prior attempt whose success the queue never recorded. The
                # row is flipped to approved here for the first time, but no
                # second activation occurred -- surface that distinction so
                # a caller can tell "just activated" from "recovered a
                # previously-landed activation" without re-deriving it.
                result["reconciledFromPriorSuccess"] = True
            return result

        # Legacy path: exact original ordering and shape (flip first, then
        # bare write) -- untouched so the default-off behaviour is unchanged.
        _conn.execute(
            "UPDATE skill_queue SET status=? WHERE queue_id=?", (new_status, queue_id)
        )
        _conn.commit()
        skill_dir = SKILLS_DIR / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(content)
        return {"ok": True, "status": new_status}
