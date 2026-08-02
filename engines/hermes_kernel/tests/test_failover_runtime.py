from __future__ import annotations

import inspect
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
    assert failover_runtime.get_ledger().schema_version() == 3
    assert failover_runtime.ledger_path().exists()
    failover_runtime.reset_for_tests()


def test_runtime_transition_and_recovery_reject_zero_before_any_helper_or_write(
        tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    runtime_plan = make_plan("runtime-zero", 9_000_000_000_000)
    active = ledger.create_initial("runtime-zero", runtime_plan)
    before_status = ledger.get_status("runtime-zero")
    before_outbox = ledger.read_outbox("runtime-zero")

    def unexpected(*_args, **_kwargs):
        raise AssertionError("zero jitter reached a runtime helper")

    monkeypatch.setattr(failover_runtime, "tuple_from", unexpected)
    monkeypatch.setattr(failover_runtime, "get_ledger", unexpected)
    monkeypatch.setattr(failover_runtime, "_cost_evidence_for_fused_transition", unexpected)
    monkeypatch.setattr(task_store, "status", unexpected)
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}

    unfused = failover_runtime.transition_once(active, "fallback", failure, 0)
    fused = failover_runtime.transition_once(
        active, "fallback", failure, 0, ledger._plan_hash(runtime_plan),
        "runtime-zero-transition", "engine", "runtime-zero-observation",
    )
    recovery = failover_runtime.recover_and_transition_once(
        active, "runtime-zero-recovery", 0,
    )

    expected = {
        "status": "REJECTED", "reason": "jitter is outside 250-750ms bounds",
    }
    assert unfused == expected
    assert fused == expected
    assert recovery == expected
    assert ledger.get_status("runtime-zero") == before_status
    assert ledger.read_outbox("runtime-zero") == before_outbox
    assert inspect.signature(failover_runtime.transition_once).parameters[
        "jitter_ms"
    ].default == 250
    assert inspect.signature(failover_runtime.recover_and_transition_once).parameters[
        "jitter_ms"
    ].default == 250


def test_boundary_diagnostics_adapter_is_lazy_then_delegates(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", raising=False)
    failover_runtime.reset_for_tests()

    assert failover_runtime.boundary_diagnostics() == {
        "schemaVersion": 1, "available": False, "reason": "ledger_not_initialized",
    }
    assert not failover_runtime.ledger_path().exists()

    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    ledger = failover_runtime.get_ledger()
    runtime_plan = make_plan("runtime-boundary", 9_000_000_000_000)
    active = ledger.create_initial("runtime-boundary", runtime_plan)
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    plan_hash = ledger._plan_hash(runtime_plan)
    result = ledger.record_retryable_observation_and_transition_once(
        active, "fallback", failure, "gateway", 250, plan_hash,
        "runtime-boundary-observation", "runtime-boundary-transition",
    )
    assert result["status"] == "TRANSITIONED"
    assert failover_runtime.boundary_diagnostics() == ledger.boundary_diagnostics()
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
    assert result_page["terminalCommitted"] is True
    assert result_page["terminalOutcome"] == "completed"
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
    assert failure_page["terminalCommitted"] is True
    assert failure_page["terminalOutcome"] == "failed"
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
    conn.execute("ALTER TABLE attempts DROP COLUMN provider_submit_not_before_ms")
    conn.execute("UPDATE ledger_meta SET value='1' WHERE key='schema_version'")
    conn.commit()
    conn.close()

    migrated = stable_ledger(path)
    assert migrated.schema_version() == 3
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
    conn.execute("ALTER TABLE attempts DROP COLUMN provider_submit_not_before_ms")
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


def test_circuit_decision_uses_only_provider_window_prefix_index(tmp_path):
    ledger = stable_ledger(tmp_path / "ledger.db")
    active = ledger.create_initial("bounded-circuit", make_plan("bounded-circuit"))
    assert ledger.transition_once(active, "fallback", {
        "failureClass": "retryable", "code": "connection", "retryable": True,
    })
    conn = ledger._connect()
    statements = []
    try:
        conn.set_trace_callback(statements.append)
        AttemptLedger._circuit_open(conn, "primary", 10_000_000)
        conn.set_trace_callback(None)
        plan = conn.execute(
            "EXPLAIN QUERY PLAN SELECT * FROM circuit_transition_authority "
            "WHERE predecessor_provider_id=? AND witness_created_at_ms>=? "
            "ORDER BY witness_created_at_ms,transition_outbox_id",
            ("primary", 9_640_000),
        ).fetchall()
    finally:
        conn.close()

    authority_scans = [statement for statement in statements
                       if "FROM circuit_transition_authority" in statement]
    assert len(authority_scans) == 1
    assert "predecessor_provider_id IN (" in authority_scans[0]
    assert "witness_created_at_ms>=" in authority_scans[0]
    assert "LEFT JOIN" not in authority_scans[0]
    assert any("circuit_transition_authority_lookup" in str(row[3]) for row in plan)

    # The production transition path checks only the bounded immutable chain,
    # issuing one provider-prefix/window query for the eligible scope. It never
    # scans unrelated provider history.
    conn = ledger._connect()
    production_statements = []
    try:
        conn.set_trace_callback(production_statements.append)
        AttemptLedger._circuit_open(
            conn, "primary", 10_000_000, ["primary", "fallback"])
        conn.set_trace_callback(None)
    finally:
        conn.close()
    production_queries = [statement for statement in production_statements
                          if "FROM circuit_transition_authority" in statement]
    assert len(production_queries) == 1
    assert all("predecessor_provider_id IN (" in statement and
               "witness_created_at_ms>=" in statement and
               "LEFT JOIN" not in statement for statement in production_queries)
    assert all("unrelated-provider" not in statement for statement in production_queries)


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


def test_attempt_timeout_ack_pre_dispatch_is_stop_only_then_gateway_transition_is_once(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    active = ledger.create_initial("timeout-pre", make_plan("timeout-pre", 9_000_000_000_000))

    result = failover_runtime.attempt_timeout(
        active, "timeout-pre:stop", stop_transport=lambda task_id, timeout_ms: {"status": "ACK_PRE_DISPATCH"},
    )

    assert result["status"] == "ACK_PRE_DISPATCH"
    assert result["activeTuple"] == {key: active[key] for key in ("taskId", "attemptId", "epoch")}
    assert result["dispatchAttempted"] is False
    assert len(ledger.list_attempts("timeout-pre")) == 1
    transitioned = ledger.transition_once(
        active, "fallback",
        {"failureClass": "retryable", "code": "pre_dispatch_timeout", "retryable": True},
        250, idempotency_key="timeout-pre:transition",
    )
    assert transitioned and transitioned["epoch"] == 1
    assert all(not attempt["cancelRequested"] for attempt in ledger.list_attempts("timeout-pre"))


def test_attempt_timeout_missing_ack_closes_uncertain_and_rejects_late_fence(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    active = ledger.create_initial("timeout-uncertain", make_plan("timeout-uncertain", 9_000_000_000_000))

    result = failover_runtime.attempt_timeout(
        active, "timeout-uncertain:stop", stop_transport=lambda task_id, timeout_ms: {"status": "ACK_UNCERTAIN"},
    )

    assert result == {"status": "ACK_UNCERTAIN", "outcome": "cancelled_uncertain", "closed": True}
    assert len(ledger.list_attempts("timeout-uncertain")) == 1
    assert ledger.get_task("timeout-uncertain")["status"] == "cancelled_uncertain"
    assert ledger.authorize_tool_forward(active, "late-call", "read_file")["status"] == "REJECTED"


def test_attempt_timeout_fence_races_never_transition(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()

    before = ledger.create_initial("timeout-fence-before", make_plan("timeout-fence-before", 9_000_000_000_000))
    assert ledger.authorize_tool_forward(before, "call-before", "read_file")["status"] == "FIRST_FENCED"
    result_before = failover_runtime.attempt_timeout(
        before, "timeout-fence-before:stop", stop_transport=lambda task_id, timeout_ms: {"status": "ACK_PRE_DISPATCH"},
    )
    assert result_before["status"] == "ACK_UNCERTAIN"
    assert len(ledger.list_attempts("timeout-fence-before")) == 1

    after = ledger.create_initial("timeout-fence-after", make_plan("timeout-fence-after", 9_000_000_000_000))

    def fence_then_ack(task_id, timeout_ms):
        assert ledger.authorize_tool_forward(after, "call-after", "read_file")["status"] == "FIRST_FENCED"
        return {"status": "ACK_PRE_DISPATCH"}

    result_after = failover_runtime.attempt_timeout(after, "timeout-fence-after:stop", stop_transport=fence_then_ack)
    assert result_after["status"] == "ACK_UNCERTAIN"
    assert len(ledger.list_attempts("timeout-fence-after")) == 1


def test_operator_cancel_remains_persist_first_and_timeout_does_not_transition(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    active = ledger.create_initial("operator-cancel", make_plan("operator-cancel", 9_000_000_000_000))
    assert ledger.request_cancel(active, "operator-cancel:cancel")["status"] == "ACK_CANCELLED"
    status = failover_runtime.get_status("operator-cancel")
    assert status["status"] == "CANCEL_PENDING"
    result = failover_runtime.attempt_timeout(
        active, "operator-cancel:timeout", stop_transport=lambda task_id, timeout_ms: {"status": "ACK_PRE_DISPATCH"},
    )
    assert result == {"status": "ACK_UNCERTAIN", "outcome": "cancel_pending"}
    assert len(ledger.list_attempts("operator-cancel")) == 1


def test_cancel_pending_terminal_observation_closes_exact_ledger_authority(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    cases = (
        ("cancel-confirmed", {"failureClass": "cancelled", "code": "operator_cancel", "retryable": False}, "cancelled"),
        ("cancel-unknown", {"failureClass": "cancelled", "code": "timeout_uncertain", "retryable": False}, "cancelled_uncertain"),
    )

    for task_id, failure, outcome in cases:
        active = ledger.create_initial(task_id, make_plan(task_id, 9_000_000_000_000))
        assert ledger.request_cancel(active, f"{task_id}:request")["status"] == "ACK_CANCELLED"

        closed = failover_runtime.record_observation(
            active,
            {"kind": "cancelled", "dispatchAttempted": False, "failure": failure},
            f"{task_id}:startup-close",
        )

        assert closed["status"] == "RECORDED"
        assert closed["outcome"] == outcome
        assert failover_runtime.get_status(task_id)["status"] == "TERMINAL"
        assert ledger.get_task(task_id)["status"] == outcome
        completions = [event for event in ledger.read_outbox(task_id) if event["kind"] == "attempt_completed"]
        assert completions[-1]["payload"]["outcome"] == outcome
        assert failover_runtime.record_observation(
            active,
            {"kind": "cancelled", "dispatchAttempted": False, "failure": failure},
            f"{task_id}:startup-close",
        )["status"] == "DUPLICATE"


def test_recovery_post_fence_materializes_uncertain_and_recovery_id_is_idempotent(tmp_path):
    ledger = stable_ledger(tmp_path / "ledger.db")
    active = ledger.create_initial("recovery-fenced", make_plan("recovery-fenced"))
    assert ledger.mark_dispatch_attempted(active)

    first = ledger.recover_and_transition_once(active, "recovery-fenced:v1")
    second = ledger.recover_and_transition_once(active, "recovery-fenced:v1")

    assert first == second
    assert first["status"] == "TERMINAL"
    assert first["outcome"] == "cancelled_uncertain"
    assert len(ledger.list_attempts("recovery-fenced")) == 1
    assert ledger.get_task("recovery-fenced")["status"] == "cancelled_uncertain"


def test_terminal_poll_reconciles_authoritative_actual_cost_and_preserves_source(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    active = ledger.create_initial("cost-reconcile", make_plan("cost-reconcile", 9_000_000_000_000))
    monkeypatch.setattr(task_store, "status", lambda *_: {
        "state": "completed", "result": "done", "error": None,
        "telemetry": {"costUsd": 0.000012, "costSource": "exact"}, "events": [],
    })

    page = failover_runtime.poll_observations(active, 0, 9_000_000_000_000)

    assert page["status"] == "TERMINAL"
    attempt = ledger.list_attempts("cost-reconcile")[0]
    assert attempt["actualCostKnown"] is True
    assert attempt["actualCostMicroUsd"] == 12
    assert attempt["reservedMicroUsd"] == 12
    events = ledger.read_outbox("cost-reconcile")
    assert events[-2]["kind"] == "cost_recorded"
    assert events[-2]["payload"] == {"actualCostMicroUsd": 12, "known": True, "source": "exact"}
    assert events[-1]["payload"]["source"] == "exact"
