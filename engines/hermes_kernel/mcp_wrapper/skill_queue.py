"""Human-in-the-loop gate over Hermes' autonomous skill deployment.
Drafted skills land here as 'pending'; the console's APPROVE_SKILL command
decides them. Approved skills are written to the Hermes skills directory."""
import os
import sqlite3
import threading
import uuid
from pathlib import Path

DATA_DIR = Path(os.environ.get("TORQCLAW_DATA_DIR", Path.home() / ".torqclaw"))
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


def decide(queue_id: str, decision: str) -> dict:
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
        new_status = "approved" if decision == "APPROVE" else "rejected"
        _conn.execute(
            "UPDATE skill_queue SET status=? WHERE queue_id=?", (new_status, queue_id)
        )
        _conn.commit()

    if new_status == "approved":
        # Only an approved skill ever touches the Hermes skills directory.
        skill_dir = SKILLS_DIR / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(markdown)
    return {"ok": True, "status": new_status}
