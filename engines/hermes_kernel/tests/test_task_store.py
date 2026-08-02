"""Covers mcp_wrapper.task_store: create/emit/status/complete/fail, cursor
semantics, and persistence-across-import."""
from mcp_wrapper import task_store


def test_create_returns_uuid_and_running_state():
    task_id = task_store.create({"payload": {"prompt": "hi"}})
    assert isinstance(task_id, str) and len(task_id) > 0
    assert task_store.state_of(task_id) == "running"


def test_unknown_task_id_state_and_status():
    assert task_store.state_of("does-not-exist") is None
    status = task_store.status("does-not-exist")
    assert status["state"] == "unknown"
    assert status["events"] == []


def test_emit_then_status_surfaces_event_with_metadata_roundtrip():
    task_id = task_store.create({"payload": {"prompt": "hi"}})
    task_store.emit(task_id, "SYSTEM", "hello", {"k": "v"})
    status = task_store.status(task_id)
    assert len(status["events"]) == 1
    ev = status["events"][0]
    assert ev["type"] == "SYSTEM"
    assert ev["message"] == "hello"
    assert ev["metadata"] == {"k": "v"}


def test_emit_metadata_none_stored_as_none():
    task_id = task_store.create({"payload": {"prompt": "hi"}})
    task_store.emit(task_id, "SYSTEM", "no metadata", None)
    status = task_store.status(task_id)
    assert status["events"][0]["metadata"] is None


def test_cursor_semantics_ascending_and_since_filter():
    task_id = task_store.create({"payload": {"prompt": "hi"}})
    task_store.emit(task_id, "SYSTEM", "first")
    task_store.emit(task_id, "SYSTEM", "second")
    status = task_store.status(task_id)
    events = status["events"]
    assert len(events) == 2
    c1, c2 = events[0]["cursor"], events[1]["cursor"]
    # cursor is a global AUTOINCREMENT shared across all tasks in the DB — do
    # NOT hardcode 1/2, just assert ascending order.
    assert c1 < c2
    assert events[0]["message"] == "first"
    assert events[1]["message"] == "second"

    since_status = task_store.status(task_id, since=c1)
    assert len(since_status["events"]) == 1
    assert since_status["events"][0]["cursor"] == c2
    assert since_status["events"][0]["message"] == "second"


def test_complete_sets_completed_state_and_telemetry_roundtrip():
    task_id = task_store.create({"payload": {"prompt": "hi"}})
    task_store.complete(task_id, "the result", {"costUsd": 1.5})
    status = task_store.status(task_id)
    assert status["state"] == "completed"
    assert status["result"] == "the result"
    assert status["telemetry"] == {"costUsd": 1.5}


def test_complete_telemetry_none_stored_as_empty_dict():
    task_id = task_store.create({"payload": {"prompt": "hi"}})
    task_store.complete(task_id, "result", None)
    status = task_store.status(task_id)
    assert status["telemetry"] == {}


def test_fail_sets_failed_state_and_error():
    task_id = task_store.create({"payload": {"prompt": "hi"}})
    task_store.fail(task_id, "boom")
    status = task_store.status(task_id)
    assert status["state"] == "failed"
    assert status["error"] == "boom"


def test_complete_on_unknown_task_id_is_noop_no_raise_no_row():
    task_store.complete("no-such-task", "result", {})
    assert task_store.state_of("no-such-task") is None


def test_fail_on_unknown_task_id_is_noop_no_raise_no_row():
    task_store.fail("no-such-task-2", "err")
    assert task_store.state_of("no-such-task-2") is None


def test_persistence_across_reimport(fresh_module):
    task_id = task_store.create({"payload": {"prompt": "persisted"}})
    task_store.emit(task_id, "SYSTEM", "before reimport")

    # Close the current connection first to avoid a Windows WAL lock, then
    # force a fresh import bound to the same TORQCLAW_DATA_DIR.
    task_store._conn.close()
    reimported = fresh_module("mcp_wrapper.task_store")

    status = reimported.status(task_id)
    assert status["state"] == "running"
    assert len(status["events"]) == 1
    assert status["events"][0]["message"] == "before reimport"


def test_fresh_import_defaults_diagnostics_off(fresh_module):
    task_store.shutdown_for_tests()
    reimported = fresh_module("mcp_wrapper.task_store")

    assert reimported._diagnostics_enabled is False
    task_id = reimported.create({"payload": {"prompt": "default-off"}})
    reimported.emit(task_id, "SYSTEM", "not captured")
    snapshot = reimported.diagnostic_snapshot()
    assert snapshot["lastSequence"] == 0
    assert snapshot["records"] == []
    reimported.shutdown_for_tests()


def test_explicit_enable_disable_preserves_behavior_and_controls_records(monkeypatch, tmp_path, fresh_module):
    task_store.shutdown_for_tests()
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    module = fresh_module("mcp_wrapper.task_store")

    def run_case(task_id):
        module.create({"payload": {"prompt": "same-behavior"}}, task_id=task_id)
        module.emit(task_id, "SYSTEM", "hello", {"k": "v"})
        module.complete(task_id, "result", {"costUsd": 1.5})
        status = module.status(task_id)
        return {
            "state": status["state"],
            "result": status["result"],
            "error": status["error"],
            "telemetry": status["telemetry"],
            "events": [
                {key: event[key] for key in ("type", "message", "metadata")}
                for event in status["events"]
            ],
        }

    module.set_diagnostics_enabled(False)
    disabled = run_case("disabled-case")
    disabled_sequence = module.diagnostic_snapshot()["lastSequence"]
    module.set_diagnostics_enabled(True)
    enabled = run_case("enabled-case")
    enabled_snapshot = module.diagnostic_snapshot()
    assert disabled == enabled
    assert enabled_snapshot["lastSequence"] > disabled_sequence
    module.set_diagnostics_enabled(False)
    before = module.diagnostic_snapshot()["lastSequence"]
    assert module.state_of("missing-after-disable") is None
    assert module.diagnostic_snapshot()["lastSequence"] == before
    module.shutdown_for_tests()


def test_recorder_failure_does_not_change_task_result(monkeypatch, tmp_path, fresh_module):
    task_store.shutdown_for_tests()
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    module = fresh_module("mcp_wrapper.task_store")
    module.set_diagnostics_enabled(True)
    original = module._record_diagnostic
    monkeypatch.setattr(
        module,
        "_record_diagnostic",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("recorder failed")),
    )

    task_id = module.create({"payload": {"prompt": "recorder-safe"}}, task_id="recorder-safe")
    module.complete(task_id, "result", {"costUsd": 1.5})
    assert module.status(task_id) == {
        "state": "completed",
        "result": "result",
        "error": None,
        "telemetry": {"costUsd": 1.5},
        "events": [],
    }
    assert module.state_of("missing") is None
    module._record_diagnostic = original
    module.shutdown_for_tests()


def test_capture_snapshot_schema_is_bounded_and_redacted(monkeypatch, tmp_path, fresh_module):
    task_store.shutdown_for_tests()
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    module = fresh_module("mcp_wrapper.task_store")
    module.set_diagnostics_enabled(True)
    task_id = module.create({"payload": {"prompt": "secret-prompt"}}, task_id="capture-case")
    module.emit(task_id, "SYSTEM", "captured")

    snapshot = module.diagnostic_snapshot()
    assert set(snapshot) == {
        "schemaVersion", "available", "store", "capacity", "droppedCount",
        "firstSequence", "lastSequence", "records",
    }
    assert snapshot["schemaVersion"] == 1
    assert snapshot["available"] is True
    assert snapshot["store"] == "task_store"
    assert snapshot["records"]
    assert all(set(record) == {"sequence", "store", "operation", "durationMs"} for record in snapshot["records"])
    assert all(record["store"] == "task_store" and record["durationMs"] >= 0 for record in snapshot["records"])
    assert "secret-prompt" not in str(snapshot)
    module.shutdown_for_tests()
