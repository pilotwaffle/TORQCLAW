"""Persistent task records and event cursors.

The task store deliberately owns one serialized connection per engine process.
It is lazy, fork-aware, WAL/FULL durable, and never performs checkpoint work
on a request path.  The ledger remains the authority for provider attempts;
this store is the internal execution/result projection.
"""
from __future__ import annotations

import json
import functools
import math
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path

DATA_DIR = Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw")
DATA_DIR.mkdir(parents=True, exist_ok=True)

_conn: sqlite3.Connection | None = None
_owner_pid: int | None = None
_lock = threading.RLock()
_CHECKPOINT_WATERMARK = 64
_writes_since_checkpoint = 0
_checkpoint_pending = False
_metrics: dict[str, object] = {
    "scheduled": 0, "completed": 0, "busy": 0, "failed": 0,
    "skipped_not_drained": 0, "last": None, "lastOutcome": "never",
}
_timings: dict[str, dict[str, float | int]] = {}
_DIAGNOSTIC_SCHEMA_VERSION = 1
_DIAGNOSTIC_STORE = "task_store"
# Fixture-only capture must retain a complete 100-case promotion run.  This
# remains default-off and bounded; the larger ring prevents false diagnostic
# truncation while preserving the no-overhead production path.
_DIAGNOSTIC_CAPACITY = 4096
_DIAGNOSTIC_OPERATIONS = frozenset({
    "create", "emit", "complete", "finish_observation", "fail",
    "state_of", "status", "checkpoint_after_drain", "shutdown_for_tests",
})
_diagnostics_enabled = False
_diagnostic_sequence = 0
_diagnostic_records: list[dict[str, object]] = []
_diagnostic_dropped_count = 0
_monotonic_ns = time.monotonic_ns


def _record_timing(name: str, elapsed_ms: float) -> None:
    if not isinstance(elapsed_ms, (int, float)) or isinstance(elapsed_ms, bool):
        return
    if not math.isfinite(float(elapsed_ms)) or elapsed_ms < 0:
        return
    metric = _timings.setdefault(name, {"count": 0, "totalMs": 0.0, "maxMs": 0.0, "lastMs": 0.0})
    metric["count"] = int(metric["count"]) + 1
    metric["totalMs"] = float(metric["totalMs"]) + float(elapsed_ms)
    metric["maxMs"] = max(float(metric["maxMs"]), float(elapsed_ms))
    metric["lastMs"] = float(elapsed_ms)


def _elapsed_ms(start_ns: int, end_ns: int) -> float | None:
    try:
        elapsed_ms = (int(end_ns) - int(start_ns)) / 1_000_000
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(elapsed_ms) or elapsed_ms < 0:
        return None
    return elapsed_ms


def set_diagnostics_enabled(enabled: bool) -> None:
    """Fixture/test-only switch; it never changes store behavior."""
    global _diagnostics_enabled
    _diagnostics_enabled = bool(enabled)


def _record_diagnostic(operation: str, elapsed_ms: float | None) -> None:
    global _diagnostic_sequence, _diagnostic_dropped_count
    if not _diagnostics_enabled or operation not in _DIAGNOSTIC_OPERATIONS or elapsed_ms is None:
        return
    if not math.isfinite(elapsed_ms) or elapsed_ms < 0:
        return
    try:
        with _lock:
            sequence = _diagnostic_sequence + 1
            _diagnostic_records.append({
                "sequence": sequence,
                "store": _DIAGNOSTIC_STORE,
                "operation": operation,
                "durationMs": elapsed_ms,
            })
            _diagnostic_sequence = sequence
            if len(_diagnostic_records) > _DIAGNOSTIC_CAPACITY:
                _diagnostic_records.pop(0)
                _diagnostic_dropped_count += 1
    except BaseException:
        # Evidence collection is never allowed to replace the operation's
        # result or exception.
        return


def _safe_record_diagnostic(operation: str, elapsed_ms: float | None) -> None:
    try:
        _record_diagnostic(operation, elapsed_ms)
    except BaseException:
        return


def diagnostic_snapshot(after_sequence: int = 0) -> dict[str, object]:
    """Return the bounded, volatile task-store timing buffer."""
    if isinstance(after_sequence, bool) or not isinstance(after_sequence, int):
        raise TypeError("after_sequence must be a non-boolean integer")
    if after_sequence < 0:
        raise ValueError("after_sequence must be non-negative")
    with _lock:
        records = [
            dict(record) for record in _diagnostic_records
            if int(record["sequence"]) > after_sequence
        ]
        return {
            "schemaVersion": _DIAGNOSTIC_SCHEMA_VERSION,
            "available": True,
            "store": _DIAGNOSTIC_STORE,
            "capacity": _DIAGNOSTIC_CAPACITY,
            "droppedCount": _diagnostic_dropped_count,
            "firstSequence": _diagnostic_records[0]["sequence"] if _diagnostic_records else None,
            "lastSequence": _diagnostic_sequence,
            "records": records,
        }


diagnostics = diagnostic_snapshot


def _note_successful_write() -> None:
    global _writes_since_checkpoint, _checkpoint_pending
    _writes_since_checkpoint += 1
    if _writes_since_checkpoint >= _CHECKPOINT_WATERMARK:
        _checkpoint_pending = True


def _maintenance_fields() -> dict[str, object]:
    return {
        "writesSinceCheckpoint": _writes_since_checkpoint,
        "pending": _checkpoint_pending,
        "maintenanceNeeded": _checkpoint_pending or _writes_since_checkpoint >= _CHECKPOINT_WATERMARK,
    }


def _db_path() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR / "hermes_tasks.db"


def _open_connection(*, bootstrap: bool) -> sqlite3.Connection:
    opened = _monotonic_ns()
    conn = sqlite3.connect(_db_path(), check_same_thread=False, timeout=10, isolation_level=None)
    _record_timing("open", _elapsed_ms(opened, _monotonic_ns()) or 0.0)
    pragma_started = _monotonic_ns()
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    # The attempt ledger is the durable authority and remains FULL-sync.
    # This database is only the internal execution/result projection. In WAL
    # mode NORMAL preserves atomicity, consistency, and isolation while
    # avoiding a full filesystem sync for every small projection commit;
    # projection state can be reconstructed from the ledger after a power-loss
    # rollback. Application-crash durability is retained by SQLite in WAL.
    conn.execute("PRAGMA synchronous=NORMAL")
    if bootstrap:
        mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0]).lower()
        if mode != "wal":
            mode = str(conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]).lower()
        if mode != "wal":
            conn.close()
            raise sqlite3.OperationalError("task-store WAL bootstrap did not return wal")
    conn.execute("PRAGMA wal_autocheckpoint=0")
    _record_timing("pragma", _elapsed_ms(pragma_started, _monotonic_ns()) or 0.0)
    if bootstrap:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.executescript("""
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
            conn.commit()
        except Exception:
            conn.rollback()
            conn.close()
            raise
    return conn


def _reset_after_fork() -> None:
    """Drop inherited references without touching the parent's connection."""
    global _conn, _owner_pid, _lock, _writes_since_checkpoint, _checkpoint_pending
    global _diagnostic_sequence, _diagnostic_records, _diagnostic_dropped_count
    _conn = None
    _owner_pid = None
    _lock = threading.RLock()
    _writes_since_checkpoint = 0
    _checkpoint_pending = False
    _diagnostic_sequence = 0
    _diagnostic_records = []
    _diagnostic_dropped_count = 0


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_after_fork)


def _connection_locked() -> sqlite3.Connection:
    global _conn, _owner_pid, _lock
    pid = os.getpid()
    if _owner_pid != pid:
        # The at-fork hook handles normal POSIX forks.  The explicit PID guard
        # also covers direct construction and platforms using spawn.
        _conn = None
        _owner_pid = pid
        _lock = threading.RLock()
    if _conn is not None:
        try:
            _conn.execute("SELECT 1")
            return _conn
        except sqlite3.Error:
            try:
                _conn.close()
            except sqlite3.Error:
                pass
            _conn = None
    _conn = _open_connection(bootstrap=True)
    _owner_pid = pid
    return _conn


def _connection() -> sqlite3.Connection:
    with _lock:
        return _connection_locked()


def create(payload: dict, task_id: str | None = None) -> str:
    """Create an internal task idempotently."""
    task_id = task_id or str(uuid.uuid4())
    with _lock:
        conn = _connection_locked()
        inserted = conn.execute(
            "INSERT OR IGNORE INTO tasks (task_id, payload) VALUES (?, ?)",
            (task_id, json.dumps(payload)),
        ).rowcount
        conn.commit()
        if inserted == 1:
            _note_successful_write()
    return task_id


def emit(task_id: str, type_: str, message: str, metadata: dict | None = None) -> None:
    with _lock:
        conn = _connection_locked()
        conn.execute(
            "INSERT INTO task_events (task_id, type, message, metadata) VALUES (?, ?, ?, ?)",
            (task_id, type_, message, json.dumps(metadata) if metadata else None),
        )
        conn.commit()
        _note_successful_write()


def complete(task_id: str, result: str, telemetry: dict | None = None) -> None:
    with _lock:
        conn = _connection_locked()
        changed = conn.execute(
            "UPDATE tasks SET state='completed', result=?, telemetry=? WHERE task_id=?",
            (result, json.dumps(telemetry or {}), task_id),
        ).rowcount
        conn.commit()
        if changed == 1:
            _note_successful_write()


def finish_observation(task_id: str, observation: dict, *, result: str = "",
                       telemetry: dict | None = None) -> dict:
    """Atomically publish the final observation and terminal task state."""
    if not isinstance(observation, dict):
        raise TypeError("observation must be a dict")
    code = observation.get("code")
    kind = observation.get("kind")
    if not isinstance(kind, str):
        kind = "result" if code == "completed" else "failure"
    is_success = kind == "result" or code == "completed"
    state = "completed" if is_success else "failed"
    error = None if is_success else "normalized_failure"
    safe_telemetry = dict(telemetry or {})
    if not is_success:
        safe_telemetry.setdefault("normalizedFailure", {
            key: observation.get(key)
            for key in ("failureClass", "code", "retryable")
            if key in observation
        })
    with _lock:
        conn = _connection_locked()
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = conn.execute(
                "SELECT state FROM tasks WHERE task_id=?", (task_id,)
            ).fetchone()
            if current is None:
                conn.rollback()
                return {"state": "unknown"}
            if current[0] != "running":
                conn.rollback()
                return {"state": current[0]}
            conn.execute(
                "INSERT INTO task_events (task_id, type, message, metadata) VALUES (?, ?, ?, ?)",
                (task_id, "OBSERVATION", "Provider observation recorded",
                 json.dumps({"kind": kind})),
            )
            conn.execute(
                "UPDATE tasks SET state=?, result=?, error=?, telemetry=? WHERE task_id=?",
                (state, result if is_success else None, error,
                 json.dumps(safe_telemetry), task_id),
            )
            conn.commit()
            _note_successful_write()
        except Exception:
            conn.rollback()
            raise
    return {"state": state}


def fail(task_id: str, error: str, telemetry: dict | None = None) -> None:
    with _lock:
        conn = _connection_locked()
        changed = conn.execute(
            "UPDATE tasks SET state='failed', error=?, telemetry=? WHERE task_id=?",
            (error, json.dumps(telemetry or {}), task_id),
        ).rowcount
        conn.commit()
        if changed == 1:
            _note_successful_write()


def state_of(task_id: str) -> str | None:
    with _lock:
        row = _connection_locked().execute(
            "SELECT state FROM tasks WHERE task_id=?", (task_id,)
        ).fetchone()
    return row[0] if row else None


def status(task_id: str, since: int = 0) -> dict:
    with _lock:
        conn = _connection_locked()
        row = conn.execute(
            "SELECT state, result, error, telemetry FROM tasks WHERE task_id=?",
            (task_id,),
        ).fetchone()
        events = conn.execute(
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
                "cursor": cursor,
                "type": type_,
                "message": message,
                "metadata": json.loads(metadata) if metadata else None,
            }
            for (cursor, type_, message, metadata) in events
        ],
    }


def checkpoint_after_drain(*, drained: bool = False) -> dict[str, object]:
    """Checkpoint only from a verified shutdown fence."""
    global _metrics, _writes_since_checkpoint, _checkpoint_pending
    with _lock:
        if not drained:
            _metrics["skipped_not_drained"] = int(_metrics["skipped_not_drained"]) + 1
            _metrics["lastOutcome"] = "skipped_not_drained"
            return {**_metrics, **_maintenance_fields(), "status": "SKIPPED_NOT_DRAINED"}
        _metrics["scheduled"] = int(_metrics["scheduled"]) + 1
        conn: sqlite3.Connection | None = None
        try:
            # This handle is separate from the serving connection and is
            # opened only after the caller proves the drain fence.
            conn = _open_connection(bootstrap=False)
            raw = conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
            if raw is None or len(raw) != 3:
                raise sqlite3.DatabaseError("PASSIVE checkpoint returned an invalid result")
            result = (int(raw[0]), int(raw[1]), int(raw[2]))
            _metrics["last"] = result
            if result[0] == 0:
                _metrics["completed"] = int(_metrics["completed"]) + 1
                _metrics["lastOutcome"] = "completed"
                _writes_since_checkpoint = 0
                _checkpoint_pending = False
                status_text = "COMPLETED"
            else:
                _metrics["busy"] = int(_metrics["busy"]) + 1
                _metrics["lastOutcome"] = "busy"
                status_text = "BUSY"
            return {**_metrics, **_maintenance_fields(), "status": status_text}
        except (sqlite3.Error, ValueError, TypeError) as exc:
            _metrics["failed"] = int(_metrics["failed"]) + 1
            _metrics["last"] = None
            _metrics["lastOutcome"] = "error"
            return {**_metrics, **_maintenance_fields(), "status": "ERROR"}
        finally:
            if conn is not None:
                close_started = _monotonic_ns()
                conn.close()
                _record_timing("maintenanceClose", _elapsed_ms(close_started, _monotonic_ns()) or 0.0)


def maintenance_metrics() -> dict[str, object]:
    with _lock:
        connected = _conn is not None
        return {
            **_metrics,
            "writesSinceCheckpoint": _writes_since_checkpoint,
            "pending": _checkpoint_pending,
            "maintenanceNeeded": _checkpoint_pending or _writes_since_checkpoint >= _CHECKPOINT_WATERMARK,
            "connected": connected,
            "inflight": False,
            "timings": {name: dict(values) for name, values in _timings.items()},
        }


def shutdown_for_tests(*, checkpoint: bool = False, drained: bool = True) -> dict[str, object]:
    """Close the process-owned serving handle; safe to call repeatedly."""
    global _conn, _owner_pid
    result = checkpoint_after_drain(drained=drained) if checkpoint else maintenance_metrics()
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            finally:
                _conn = None
        _owner_pid = None
    return result


def _instrument_diagnostic_operation(operation: str, function):
    @functools.wraps(function)
    def measured(*args, **kwargs):
        started = _monotonic_ns()
        try:
            return function(*args, **kwargs)
        finally:
            _safe_record_diagnostic(operation, _elapsed_ms(started, _monotonic_ns()))
    return measured


for _diagnostic_operation in _DIAGNOSTIC_OPERATIONS:
    _diagnostic_function = globals().get(_diagnostic_operation)
    if _diagnostic_function is not None:
        globals()[_diagnostic_operation] = _instrument_diagnostic_operation(
            _diagnostic_operation, _diagnostic_function,
        )


close = shutdown_for_tests
