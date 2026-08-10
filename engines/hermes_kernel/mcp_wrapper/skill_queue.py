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


def get_draft(queue_id: str) -> dict:
    """Return a draft's full markdown — for the console to prefill its editor
    when the draft was too large to ride in the approval event metadata."""
    with _lock:
        row = _conn.execute(
            "SELECT proposed_name, skill_markdown, status FROM skill_queue WHERE queue_id=?",
            (queue_id,),
        ).fetchone()
    if row is None:
        return {"ok": False, "error": "unknown queue_id"}
    name, markdown, status = row
    return {"ok": True, "proposed_name": name, "skill_markdown": markdown, "status": status}


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
            "SELECT proposed_name, skill_markdown, status FROM skill_queue WHERE queue_id=?",
            (queue_id,),
        ).fetchone()
        if row is None:
            return {"ok": False, "error": "unknown queue_id"}
        name, markdown, status = row
        if status != "pending":
            return {"ok": False, "error": f"already {status}"}

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
            from .runtime_quiescence import (
                SkillActivationRestoredButCacheUnprovenError,
                SkillRuntimeBusyError,
            )
            from .governed_skills import GovernanceRevertedProjectionUnprovenError

            try:
                installed = governed_skills.install_approved_skill(name, content)
            except SkillRuntimeBusyError:
                from .hermes_runner import RUNNING

                active_tasks = len(RUNNING)
                return {
                    "ok": False,
                    "code": "SKILL_RUNTIME_BUSY",
                    "retryable": True,
                    "status": "pending",
                    "activeTasks": active_tasks,
                    "error": (
                        f"Skill activation is blocked while {active_tasks} "
                        "Hermes task(s) are running. No skill state changed. "
                        "Retry when those tasks finish."
                    ),
                }
            except GovernanceRevertedProjectionUnprovenError as exc:
                # Deliberately DISTINCT from the generic activation-failure
                # result below: this is the one activation-failure shape
                # where TORQCLAW cannot claim "nothing partial is left
                # published or governed-active" (see this function's own
                # docstring). Governance was reverted (conservative -- it
                # points at the prior digest again), but the published
                # projection restore then also failed, so the actual bytes
                # on disk for this skill id are unproven. `retryable: true`
                # is deliberately omitted here: a blind automated retry is
                # not obviously safe until an operator has looked at what is
                # actually published on disk, unlike the ordinary
                # activation-failure case below where the coordinator's own
                # restore path guarantees a clean slate.
                return {
                    "ok": False,
                    "code": "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT",
                    "retryable": False,
                    "status": "pending",
                    "error": str(exc),
                }
            except SkillActivationRestoredButCacheUnprovenError as exc:
                # Deliberately DISTINCT from the generic activation-failure
                # shape below: that shape's docstring (and this function's
                # own, above) promises "nothing partial is left published or
                # governed-active -- the coordinator's own restore path
                # guarantees that." This exception means that guarantee does
                # NOT hold: the coordinator's own docstring
                # (runtime_quiescence.py's SkillActivationRestoredButCacheUnprovenError,
                # and ActivationCoordinator.run) states the on-disk external
                # projection was changed TWICE (publish, then restore) even
                # though governed state was never committed, and the
                # mandatory post-restore cache invalidation could not be
                # proven -- an in-process Hermes agent may still be serving a
                # stale prompt reflecting either the failed new version or an
                # unprovably-stale view of the restored one. Folding this
                # into SKILL_ACTIVATION_FAILED/retryable would silently
                # promise a clean slate that was never achieved. `retryable`
                # is False here for the same reason it is False for
                # SKILL_PROJECTION_UNPROVEN_AFTER_REVERT: a blind automated
                # retry is not obviously safe until an operator has confirmed
                # the actual cache/projection state.
                return {
                    "ok": False,
                    "code": "SKILL_ACTIVATION_CACHE_UNPROVEN",
                    "retryable": False,
                    "status": "pending",
                    "error": str(exc),
                }
            except Exception as exc:
                # Any other activation failure (publication error, governed
                # commit failure, coordination/verification failure, ...):
                # the row stays pending and is retryable. Nothing partial is
                # left published or governed-active -- the coordinator's own
                # restore path guarantees that -- so a retry re-attempts the
                # exact same (skill_id, markdown) pair from a clean slate.
                # NOTE: this guarantee specifically does NOT extend to a
                # SkillActivationRestoredButCacheUnprovenError (handled in
                # its own arm above) or a GovernanceRevertedProjectionUnprovenError
                # (handled above that) -- both are raised precisely because
                # the coordinator's restore path did NOT reach a clean,
                # provable slate.
                return {
                    "ok": False,
                    "code": "SKILL_ACTIVATION_FAILED",
                    "retryable": True,
                    "status": "pending",
                    "error": str(exc),
                }

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
