from __future__ import annotations

import sqlite3
import threading

from mcp_wrapper import approval_hook, failover_runtime, task_store
from mcp_wrapper.attempt_ledger import AttemptLedger, CorruptLedger


def make_plan(task_id: str, deadline: int = 20_000_000) -> dict:
    return {
        "schemaVersion": 1,
        "taskId": task_id,
        "chainId": "tests",
        "eligibleProviderIds": ["primary", "fallback"],
        "privacyClass": "normal",
        "privacyHash": "a" * 64,
        "policyHash": "b" * 64,
        "contextHash": "c" * 64,
        "grantHash": "d" * 64,
        "taskDeadlineMs": deadline,
        "attemptTimeoutMs": 1_000,
        "transitionLimit": 1,
        "budgetMicroUsd": None,
        "providerCeilings": {"primary": 10, "fallback": 20},
        "featurePolicyRevision": "policy-1",
        "planRevision": "plan-1",
    }


def stable_ledger(path):
    return AttemptLedger(path, now_ms=lambda: 10_000_000)


def test_feature_off_does_not_create_resilience_db(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(data_dir))
    monkeypatch.delenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", raising=False)
    failover_runtime.reset_for_tests()

    assert not failover_runtime.feature_enabled()
    assert not failover_runtime.ledger_path().exists()
    assert failover_runtime.page_outbox()["status"] == "REJECTED"
    assert not failover_runtime.ledger_path().exists()

    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    assert failover_runtime.get_ledger().schema_version() == 2
    assert failover_runtime.ledger_path().exists()
    failover_runtime.reset_for_tests()


def test_admission_is_idempotent_and_observation_is_normalized(tmp_path):
    ledger = stable_ledger(tmp_path / "ledger.db")
    plan = make_plan("task")
    first = ledger.admit_frontier("task", plan, plan["taskDeadlineMs"], ["primary", "fallback"])
    again = ledger.admit_frontier("task", plan, plan["taskDeadlineMs"], ["primary", "fallback"])
    assert first["status"] == "ADMITTED"
    assert again["status"] == "EXISTING"
    assert again["tuple"] == first["tuple"]
    assert ledger.record_observation(first["tuple"], {"httpStatus": 429}, "obs-1")["status"] == "RECORDED"
    assert ledger.record_observation(first["tuple"], {"httpStatus": 429}, "obs-1")["status"] == "DUPLICATE"
    assert ledger.record_observation(first["tuple"], {"error": "secret-provider-text"}, "obs-2")["status"] == "REJECTED"


def test_terminal_observations_use_durable_dispatch_state(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()

    completed = ledger.create_initial("completed", make_plan("completed", 9_000_000_000_000))
    ledger.authorize_tool_forward(completed, "call-1", "read_file", {"path": "a"})
    monkeypatch.setattr(task_store, "status", lambda *_: {
        "state": "completed", "result": "done", "error": None,
        "telemetry": {"dispatchAttempted": False}, "events": [],
    })
    result_page = failover_runtime.poll_observations(completed, 0, 9_000_000_000_000)
    assert result_page["observations"][0]["dispatchAttempted"] is True
    assert failover_runtime.get_status("completed")["dispatchAttempted"] is True

    failed = ledger.create_initial("failed", make_plan("failed", 9_000_000_000_000))
    ledger.authorize_tool_forward(failed, "call-1", "read_file", {"path": "b"})
    monkeypatch.setattr(task_store, "status", lambda *_: {
        "state": "failed", "result": None, "error": "engine failure",
        "telemetry": {"dispatchAttempted": False, "normalizedFailure": {
            "failureClass": "terminal", "code": "engine_failure", "retryable": False,
        }}, "events": [],
    })
    failure_page = failover_runtime.poll_observations(failed, 0, 9_000_000_000_000)
    assert failure_page["observations"][0]["dispatchAttempted"] is True
    assert failover_runtime.get_status("failed")["dispatchAttempted"] is True

    prefence = ledger.create_initial("prefence", make_plan("prefence", 9_000_000_000_000))
    monkeypatch.setattr(task_store, "status", lambda *_: {
        "state": "completed", "result": "done", "error": None,
        "telemetry": {}, "events": [],
    })
    control_page = failover_runtime.poll_observations(prefence, 0, 9_000_000_000_000)
    assert control_page["observations"][0]["dispatchAttempted"] is False


def test_running_observations_with_events_use_durable_dispatch_state(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    active = ledger.create_initial("running-events", make_plan("running-events", 9_000_000_000_000))
    assert ledger.authorize_tool_forward(active, "call-1", "read_file")["status"] == "FIRST_FENCED"
    monkeypatch.setattr(task_store, "status", lambda *_: {
        "state": "running", "events": [{"cursor": 3}, {"cursor": 4}],
    })

    page = failover_runtime.poll_observations(active, 0, 9_000_000_000_000)

    assert page["cursor"] == 4
    assert page["observations"] == [
        {"kind": "progress", "dispatchAttempted": True},
        {"kind": "progress", "dispatchAttempted": True},
    ]


def test_running_observation_synthesizes_durable_fence_without_events(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    active = ledger.create_initial("running-empty", make_plan("running-empty", 9_000_000_000_000))
    assert ledger.authorize_tool_forward(active, "call-1", "read_file")["status"] == "FIRST_FENCED"
    monkeypatch.setattr(task_store, "status", lambda *_: {"state": "running", "events": []})

    page = failover_runtime.poll_observations(active, 7, 9_000_000_000_000)

    assert page["cursor"] == 7
    assert page["observations"] == [{"kind": "progress", "dispatchAttempted": True}]


def test_running_observation_before_fence_remains_false(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    active = ledger.create_initial("running-prefence", make_plan("running-prefence", 9_000_000_000_000))
    monkeypatch.setattr(task_store, "status", lambda *_: {
        "state": "running", "events": [{"cursor": 1}],
    })

    page = failover_runtime.poll_observations(active, 0, 9_000_000_000_000)

    assert page["observations"] == [{"kind": "progress", "dispatchAttempted": False}]


def test_v1_to_v2_migration_rebuilds_authority_atomically(tmp_path):
    path = tmp_path / "ledger.db"
    ledger = stable_ledger(path)
    first = ledger.create_initial("task", make_plan("task"))
    ledger.transition_once(first, "fallback", {
        "failureClass": "retryable", "code": "connection", "retryable": True,
    })
    conn = sqlite3.connect(path)
    conn.execute("DROP INDEX circuit_transition_authority_lookup")
    conn.execute("DROP TABLE circuit_transition_authority")
    conn.execute("DROP TABLE tool_fences")
    conn.execute("DROP TABLE mutation_idempotency")
    conn.execute("UPDATE ledger_meta SET value='1' WHERE key='schema_version'")
    conn.commit()
    conn.close()

    migrated = stable_ledger(path)
    assert migrated.schema_version() == 2
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT COUNT(*) FROM circuit_transition_authority").fetchone()[0] == 1
    conn.close()


def test_v1_migration_with_existing_missing_witness_fails_closed(tmp_path):
    path = tmp_path / "ledger.db"
    ledger = stable_ledger(path)
    first = ledger.create_initial("task", make_plan("task"))
    ledger.transition_once(first, "fallback", {
        "failureClass": "retryable", "code": "connection", "retryable": True,
    })
    conn = sqlite3.connect(path)
    conn.execute("DELETE FROM circuit_transition_authority")
    conn.execute("DROP TABLE tool_fences")
    conn.execute("DROP TABLE mutation_idempotency")
    conn.execute("UPDATE ledger_meta SET value='1' WHERE key='schema_version'")
    conn.commit()
    conn.close()
    try:
        stable_ledger(path)
    except CorruptLedger:
        pass
    else:
        raise AssertionError("migration guessed a missing historical witness")
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT value FROM ledger_meta WHERE key='schema_version'").fetchone()[0] == "1"
    conn.close()


def test_fence_race_has_one_first_winner_and_no_raw_args(tmp_path):
    ledger = stable_ledger(tmp_path / "ledger.db")
    active = ledger.create_initial("task", make_plan("task", 9_000_000_000_000))
    results = []
    lock = threading.Lock()

    def fence():
        result = ledger.authorize_tool_forward(active, "call-1", "read_file", {
            "token": "must-not-persist",
        })
        with lock:
            results.append(result["status"])

    threads = [threading.Thread(target=fence) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results.count("FIRST_FENCED") == 1
    assert results.count("ALREADY_FENCED") == 7
    conn = sqlite3.connect(tmp_path / "ledger.db")
    stored = " ".join(str(row) for row in conn.execute("SELECT * FROM tool_fences"))
    conn.close()
    assert "must-not-persist" not in stored


def test_recovery_race_has_one_successor_and_cancel_is_persist_first(tmp_path):
    ledger = stable_ledger(tmp_path / "ledger.db")
    active = ledger.create_initial("task", make_plan("task"))
    results = []
    threads = [threading.Thread(
        target=lambda: results.append(ledger.recover_and_transition_once(active, "recover-1"))
    ) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert {result["status"] for result in results} == {"RECOVERED"}
    assert len(ledger.list_attempts("task")) == 2
    successor = ledger.get_active("task")
    assert successor is not None
    cancel = ledger.request_cancel(successor, "cancel-1")
    assert cancel["status"] == "ACK_CANCELLED"
    assert ledger.get_task("task")["status"] == "cancel_requested"
    page = ledger.page_outbox(limit=2)
    while page["hasMore"]:
        page = ledger.page_outbox(after_id=page["nextCursor"], limit=2)
    assert any(event["kind"] == "cancel_requested" for event in ledger.read_outbox("task"))


def test_forged_authority_witness_fails_closed(tmp_path):
    ledger = stable_ledger(tmp_path / "ledger.db")
    active = ledger.create_initial("task", make_plan("task"))
    ledger.transition_once(active, "fallback", {
        "failureClass": "retryable", "code": "connection", "retryable": True,
    })
    conn = sqlite3.connect(tmp_path / "ledger.db")
    conn.execute("UPDATE circuit_transition_authority SET witness_digest='0'" )
    conn.commit()
    conn.close()
    conn = ledger._connect()
    try:
        try:
            AttemptLedger._circuit_open(conn, "primary", 10_000_000)
        except CorruptLedger:
            pass
        else:
            raise AssertionError("forged authority witness was accepted")
    finally:
        conn.close()


def test_diagnostic_circuit_cache_can_be_deleted_without_changing_authority(tmp_path):
    path = tmp_path / "ledger.db"
    ledger = stable_ledger(path)
    first = ledger.create_initial("task", make_plan("task"))
    ledger.transition_once(first, "fallback", {
        "failureClass": "retryable", "code": "connection", "retryable": True,
    })
    conn = sqlite3.connect(path)
    conn.execute("DROP TABLE circuit_failures")
    conn.commit()
    conn.close()
    second = ledger.create_initial("task-2", make_plan("task-2"))
    assert ledger.transition_once(second, "fallback", {
        "failureClass": "retryable", "code": "connection", "retryable": True,
    })["status"] == "TRANSITIONED"


def test_circuit_open_window_is_exactly_sixty_seconds_and_uses_six_minute_reconcile(tmp_path):
    clock = [700_000]
    ledger = AttemptLedger(tmp_path / "ledger.db", now_ms=lambda: clock[0])

    def failure_task(name: str, at: int) -> None:
        clock[0] = at
        first = ledger.create_initial(name, make_plan(name, 9_000_000_000_000))
        assert ledger.transition_once(first, "fallback", {
            "failureClass": "retryable", "code": "connection", "retryable": True,
        })["status"] == "TRANSITIONED"

    # The first witness is now-359999 at the threshold and therefore outside
    # a simple now-5m scan, but it is exactly 300000ms before the third witness.
    failure_task("circuit-1", 700_000)
    failure_task("circuit-2", 850_000)
    failure_task("circuit-3", 1_000_000)

    conn = ledger._connect()
    try:
        assert AttemptLedger._circuit_open(conn, "primary", 1_059_999) is True
        assert AttemptLedger._circuit_open(conn, "primary", 1_060_000) is False
    finally:
        conn.close()


def test_approval_hook_fences_read_tools_and_blocks_stale_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    active = ledger.create_initial("task", make_plan("task", 9_000_000_000_000))
    emitted = []
    approval_hook.set_task_context(
        "task", [], lambda *event: emitted.append(event), True,
        active_tuple=active, resilience_active=True,
    )
    assert approval_hook.pre_tool_call("read_file", {}, "task", tool_call_id="call-1") is None
    stale = {**active, "epoch": 9}
    approval_hook.set_task_context(
        "stale", [], lambda *event: emitted.append(event), True,
        active_tuple=stale, resilience_active=True,
    )
    blocked = approval_hook.pre_tool_call("read_file", {}, "stale", tool_call_id="call-2")
    assert blocked["action"] == "block"
    assert emitted
