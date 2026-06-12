"""Persistent task records + incremental event cursors (mirrors the gateway's
seq convention). A task row exists BEFORE the loop starts: a crash leaves a
resumable record, never a ghost."""
import json
import os
import sqlite3
import threading
import uuid
from pathlib import Path

DATA_DIR = Path(os.environ.get("TORQCLAW_DATA_DIR", Path.home() / ".torqclaw"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

_conn = sqlite3.connect(DATA_DIR / "hermes_tasks.db", check_same_thread=False)
_conn.execute("PRAGMA journal_mode = WAL")
_lock = threading.Lock()

_conn.executescript("""
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'running',
    payload TEXT NOT NULL,
    result TEXT,
    error TEXT,
    telemetry TEXT
);
CREATE TABLE IF NOT EXISTS task_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, cursor);
""")


def create(payload: dict) -> str:
    task_id = str(uuid.uuid4())
    with _lock:
        _conn.execute(
            "INSERT INTO tasks (task_id, payload) VALUES (?, ?)",
            (task_id, json.dumps(payload)),
        )
        _conn.commit()
    return task_id


def emit(task_id: str, type_: str, message: str, metadata: dict | None = None) -> None:
    with _lock:
        _conn.execute(
            "INSERT INTO task_events (task_id, type, message, metadata) VALUES (?, ?, ?, ?)",
            (task_id, type_, message, json.dumps(metadata) if metadata else None),
        )
        _conn.commit()


def complete(task_id: str, result: str, telemetry: dict | None = None) -> None:
    with _lock:
        _conn.execute(
            "UPDATE tasks SET state='completed', result=?, telemetry=? WHERE task_id=?",
            (result, json.dumps(telemetry or {}), task_id),
        )
        _conn.commit()


def fail(task_id: str, error: str) -> None:
    with _lock:
        _conn.execute(
            "UPDATE tasks SET state='failed', error=? WHERE task_id=?", (error, task_id)
        )
        _conn.commit()


def status(task_id: str, since: int = 0) -> dict:
    with _lock:
        row = _conn.execute(
            "SELECT state, result, error, telemetry FROM tasks WHERE task_id=?",
            (task_id,),
        ).fetchone()
        events = _conn.execute(
            "SELECT cursor, type, message, metadata FROM task_events "
            "WHERE task_id=? AND cursor > ? ORDER BY cursor ASC",
            (task_id, since),
        ).fetchall()
    if row is None:
        return {"state": "unknown", "events": []}
    state, result, error, telemetry = row
    return {
        "state": state,
        "result": result,
        "error": error,
        "telemetry": json.loads(telemetry) if telemetry else {},
        "events": [
            {
                "cursor": c,
                "type": t,
                "message": m,
                "metadata": json.loads(md) if md else None,
            }
            for (c, t, m, md) in events
        ],
    }
