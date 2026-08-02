from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper.attempt_ledger import (  # noqa: E402
    AttemptLedger,
    CostEvidence,
    InvalidPlanError,
    LedgerError,
    TaskAlreadyExists,
)


@pytest.fixture
def tmp_path():
    path = Path("E:/tmp") / f"torqclaw-focused-{uuid.uuid4().hex}"
    path.mkdir(parents=True, exist_ok=False)
    try:
        yield path
    finally:
        for child in path.glob("*"):
            child.unlink(missing_ok=True)
        path.rmdir()


def plan(task: str, budget: int | None = None) -> dict:
    return {
        "schemaVersion": 1,
        "taskId": task,
        "chainId": "focused",
        "eligibleProviderIds": ["primary", "fallback"],
        "privacyClass": "normal",
        "privacyHash": "a" * 64,
        "policyHash": "b" * 64,
        "contextHash": "c" * 64,
        "grantHash": "d" * 64,
        "taskDeadlineMs": 9_999_999_999_999,
        "attemptTimeoutMs": 1_000,
        "transitionLimit": 1,
        "budgetMicroUsd": budget,
        "providerCeilings": {"primary": 10, "fallback": 20},
        "featurePolicyRevision": "policy-1",
        "planRevision": "plan-1",
    }


def provider_ref(provider_id: str = "fallback") -> dict:
    return {
        "providerId": provider_id, "label": "Fallback", "modelId": "model",
        "credentialEnvName": "TORQCLAW_KEY", "baseUrlEnvName": "TORQCLAW_URL",
    }


def successor_tuple(result: dict) -> dict:
    payload = result.get("tuple", result)
    return {key: payload[key] for key in ("taskId", "attemptId", "epoch")}


def authority_snapshot(ledger: AttemptLedger, task_id: str) -> dict:
    conn = sqlite3.connect(ledger.db_path)
    try:
        counts = {
            "toolFences": conn.execute(
                "SELECT COUNT(*) FROM tool_fences WHERE task_id=?", (task_id,),
            ).fetchone()[0],
            "idempotency": conn.execute(
                "SELECT COUNT(*) FROM mutation_idempotency WHERE task_id=?", (task_id,),
            ).fetchone()[0],
        }
    finally:
        conn.close()
    return {
        "active": ledger.get_active(task_id),
        "attempts": ledger.list_attempts(task_id),
        "outbox": ledger.read_outbox(task_id),
        **counts,
    }


def test_create_initial_tombstones_and_internalizes_attempt_id(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    first = ledger.create_initial("task", plan("task"))
    assert first["epoch"] == 0
    assert first["attemptId"] not in ledger.get_task("task")["plan"]
    with pytest.raises(TaskAlreadyExists):
        ledger.create_initial("task", plan("task"))


def test_transition_is_atomic_and_stale_predecessor_is_closed(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    first = ledger.create_initial("task", plan("task"))
    second = ledger.transition_once(
        first, "fallback",
        {"failureClass": "retryable", "code": "connection", "retryable": True},
    )
    assert second["epoch"] == 1
    assert ledger.get_active("task")["attemptId"] == second["attemptId"]
    assert ledger.append_event_if_active(first, "late") is None
    assert [event["kind"] for event in ledger.read_outbox("task")] == [
        "attempt_created", "transitioned"
    ]


def test_direct_legacy_zero_transition_normalizes_to_durable_250ms_fence(tmp_path):
    wall = [1_000]
    mono = [10_000_000_000]
    ledger = AttemptLedger(
        tmp_path / "legacy-transition.sqlite", now_ms=lambda: wall[0],
        monotonic_ns=lambda: mono[0],
    )
    task_plan = plan("legacy-transition")
    active = ledger.create_initial("legacy-transition", task_plan)
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}

    transitioned = ledger.transition_once(active, "fallback", failure, 0)

    assert transitioned is not None
    assert transitioned["status"] == "TRANSITIONED"
    assert transitioned["successorSubmitNotBeforeMs"] == 1_250
    successor = successor_tuple(transitioned)
    assert ledger.get_active("legacy-transition")["providerSubmitNotBeforeMs"] == 1_250
    assert ledger._fence_guards[
        ("legacy-transition", successor["attemptId"], successor["epoch"])
    ] == 10_250_000_000
    assert ledger.transition_once(active, "fallback", failure, 0) is None
    transition_events = [event for event in ledger.read_outbox("legacy-transition")
                         if event["kind"] == "transitioned"]
    assert len(transition_events) == 1
    assert "successorSubmitNotBeforeMs" not in transition_events[0]["payload"]
    conn = sqlite3.connect(tmp_path / "legacy-transition.sqlite")
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM circuit_transition_authority"
        ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT attempt_id,epoch,status FROM active_control WHERE task_id=?",
            ("legacy-transition",),
        ).fetchone() == (successor["attemptId"], 1, "active")
    finally:
        conn.close()


def test_direct_legacy_zero_recovery_normalizes_and_replays_durable_fence(tmp_path):
    path = tmp_path / "legacy-recovery.sqlite"
    wall = [1_000]
    mono = [10_000_000_000]
    ledger = AttemptLedger(
        path, now_ms=lambda: wall[0], monotonic_ns=lambda: mono[0],
    )
    active = ledger.create_initial("legacy-recovery", plan("legacy-recovery"))

    recovered = ledger.recover_and_transition_once(active, "legacy-recovery:v1", 0)
    reopened = AttemptLedger(
        path, now_ms=lambda: wall[0], monotonic_ns=lambda: 20_000_000_000,
    )
    replay = reopened.recover_and_transition_once(active, "legacy-recovery:v1", 0)

    assert replay == recovered
    assert recovered["status"] == "RECOVERED"
    assert recovered["successorSubmitNotBeforeMs"] == 1_250
    recovered_tuple = successor_tuple(recovered)
    assert reopened.get_active("legacy-recovery")["providerSubmitNotBeforeMs"] == 1_250
    assert ledger._fence_guards[
        ("legacy-recovery", recovered_tuple["attemptId"], recovered_tuple["epoch"])
    ] == 10_250_000_000
    transition_events = [event for event in reopened.read_outbox("legacy-recovery")
                         if event["kind"] == "transitioned"]
    assert len(transition_events) == 1
    assert "successorSubmitNotBeforeMs" not in transition_events[0]["payload"]
    conn = sqlite3.connect(path)
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM circuit_transition_authority"
        ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT attempt_id,epoch,status FROM active_control WHERE task_id=?",
            ("legacy-recovery",),
        ).fetchone() == (recovered_tuple["attemptId"], 1, "active")
        idempotency = conn.execute(
            "SELECT result_json FROM mutation_idempotency "
            "WHERE operation='recovery' AND idempotency_key='legacy-recovery:v1'"
        ).fetchone()
        assert idempotency is not None
        assert json.loads(idempotency[0])["successorSubmitNotBeforeMs"] == 1_250
        assert conn.execute(
            "SELECT COUNT(*) FROM mutation_idempotency "
            "WHERE operation='recovery' AND idempotency_key='legacy-recovery:v1'"
        ).fetchone()[0] == 1
    finally:
        conn.close()


@pytest.mark.parametrize("authority", ["submit", "dispatch", "tool"])
def test_zero_normalized_successor_requires_both_clocks_for_every_authority(
        tmp_path, authority):
    wall = [1_000]
    mono = [10_000_000_000]
    task_id = f"zero-authority-{authority}"
    ledger = AttemptLedger(
        tmp_path / f"{task_id}.sqlite", now_ms=lambda: wall[0],
        monotonic_ns=lambda: mono[0],
    )
    task_plan = plan(task_id)
    active = ledger.create_initial(task_id, task_plan)
    transitioned = ledger.transition_once(active, "fallback", {
        "failureClass": "retryable", "code": "connection", "retryable": True,
    }, 0)
    successor = successor_tuple(transitioned)
    assert transitioned["successorSubmitNotBeforeMs"] == 1_250
    baseline = authority_snapshot(ledger, task_id)

    def invoke():
        if authority == "submit":
            return ledger.submit_attempt(
                successor, task_plan, provider_ref(), 9_999_999_999_000,
                f"{task_id}:submit",
            )
        if authority == "dispatch":
            return ledger.mark_dispatch_attempted(successor)
        return ledger.authorize_tool_forward(
            successor, f"{task_id}:tool", "read_file", {"path": "safe.txt"},
        )

    assert invoke()["status"] == "NOT_READY"
    assert authority_snapshot(ledger, task_id) == baseline

    wall[0] = 1_250
    assert invoke()["status"] == "NOT_READY"
    assert authority_snapshot(ledger, task_id) == baseline

    wall[0] = 1_000
    mono[0] += 250_000_000
    assert invoke()["status"] == "NOT_READY"
    assert authority_snapshot(ledger, task_id) == baseline

    wall[0] = 1_250
    authorized = invoke()
    if authority == "submit":
        assert authorized["status"] == "SUBMITTED"
        assert invoke()["status"] == "DUPLICATE"
    elif authority == "dispatch":
        assert authorized["dispatchAttempted"] is True
        assert invoke() is None
    else:
        assert authorized["status"] == "FIRST_FENCED"
        assert invoke()["status"] == "ALREADY_FENCED"


def test_zero_normalized_successor_rebuilds_monotonic_guard_after_restart(tmp_path):
    path = tmp_path / "zero-restart.sqlite"
    creation_wall = [1_000]
    creation_mono = [10_000_000_000]
    creator = AttemptLedger(
        path, now_ms=lambda: creation_wall[0],
        monotonic_ns=lambda: creation_mono[0],
    )
    active = creator.create_initial("zero-restart", plan("zero-restart"))
    transitioned = creator.transition_once(active, "fallback", {
        "failureClass": "retryable", "code": "connection", "retryable": True,
    }, 0)
    successor = successor_tuple(transitioned)
    assert transitioned["successorSubmitNotBeforeMs"] == 1_250

    restart_wall = [1_250]
    restart_mono = [20_000_000_000]
    restarted = AttemptLedger(
        path, now_ms=lambda: restart_wall[0],
        monotonic_ns=lambda: restart_mono[0],
    )
    baseline = authority_snapshot(restarted, "zero-restart")
    first = restarted.mark_dispatch_attempted(successor)
    assert first["status"] == "NOT_READY"
    assert authority_snapshot(restarted, "zero-restart") == baseline
    assert restarted._fence_guards[
        ("zero-restart", successor["attemptId"], successor["epoch"])
    ] == 20_250_000_000

    restart_mono[0] += 250_000_000
    assert restarted.mark_dispatch_attempted(successor)["dispatchAttempted"] is True


@pytest.mark.parametrize("jitter_ms", [True, 0.5, -1, 1, 249, 751, 10**20])
def test_direct_transition_and_recovery_reject_invalid_jitter_without_writes(
        tmp_path, jitter_ms):
    ledger = AttemptLedger(tmp_path / f"invalid-{uuid.uuid4().hex}.sqlite")
    active = ledger.create_initial("invalid", plan("invalid"))
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    before = ledger.read_outbox("invalid")

    assert ledger.transition_once(active, "fallback", failure, jitter_ms) is None
    assert ledger.recover_and_transition_once(
        active, "invalid-recovery", jitter_ms,
    )["status"] == "REJECTED"
    assert ledger.get_active("invalid")["epoch"] == 0
    assert ledger.read_outbox("invalid") == before


@pytest.mark.parametrize("jitter_ms", [250, 750])
def test_direct_transition_and_recovery_retain_bounded_jitter(tmp_path, jitter_ms):
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    transition_ledger = AttemptLedger(
        tmp_path / f"bounded-transition-{jitter_ms}.sqlite", now_ms=lambda: 1_000,
    )
    transition_active = transition_ledger.create_initial(
        f"bounded-transition-{jitter_ms}", plan(f"bounded-transition-{jitter_ms}"),
    )
    transitioned = transition_ledger.transition_once(
        transition_active, "fallback", failure, jitter_ms,
    )
    assert transitioned["successorSubmitNotBeforeMs"] == 1_000 + jitter_ms

    recovery_ledger = AttemptLedger(
        tmp_path / f"bounded-recovery-{jitter_ms}.sqlite", now_ms=lambda: 1_000,
    )
    recovery_active = recovery_ledger.create_initial(
        f"bounded-recovery-{jitter_ms}", plan(f"bounded-recovery-{jitter_ms}"),
    )
    recovered = recovery_ledger.recover_and_transition_once(
        recovery_active, f"bounded-recovery-{jitter_ms}:v1", jitter_ms,
    )
    assert recovered["successorSubmitNotBeforeMs"] == 1_000 + jitter_ms


def test_direct_zero_compatibility_requires_exact_legacy_shapes(tmp_path):
    ledger = AttemptLedger(tmp_path / "legacy-shape.sqlite")
    active = ledger.create_initial("legacy-shape", plan("legacy-shape"))
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    plan_hash = ledger._plan_hash(plan("legacy-shape"))

    assert ledger.transition_once(active, "fallback", failure, 0, plan_hash) is None
    assert ledger.transition_once(
        active, "fallback", failure, 0, None, "transition-key",
    ) is None
    assert ledger.recover_and_transition_once(
        active, "explicit-failure", 0, failure,
    )["status"] == "REJECTED"
    assert ledger.recover_and_transition_once(
        active, "explicit-successor", 0, successor_provider_id="fallback",
    )["status"] == "REJECTED"
    assert ledger.get_active("legacy-shape")["epoch"] == 0
    assert [event["kind"] for event in ledger.read_outbox("legacy-shape")] == [
        "attempt_created"
    ]


def test_fused_transition_remains_strictly_nonzero(tmp_path):
    ledger = AttemptLedger(tmp_path / "fused-zero.sqlite")
    active = ledger.create_initial("fused-zero", plan("fused-zero"))
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    before = ledger.read_outbox("fused-zero")
    result = ledger.record_retryable_observation_and_transition_once(
        active, "fallback", failure, "gateway", 0,
        ledger._plan_hash(plan("fused-zero")), "fused-zero-observation",
        "fused-zero-transition",
    )
    assert result == {
        "status": "REJECTED", "reason": "jitter is outside 250-750ms bounds",
    }
    assert ledger.read_outbox("fused-zero") == before


def test_legacy_zero_preserves_barriers_circuit_and_corruption_fail_closed(tmp_path):
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}

    dispatch = AttemptLedger(tmp_path / "zero-dispatch.sqlite")
    dispatch_active = dispatch.create_initial("zero-dispatch", plan("zero-dispatch"))
    assert dispatch.mark_dispatch_attempted(dispatch_active)
    assert dispatch.transition_once(dispatch_active, "fallback", failure, 0) is None

    cancelled = AttemptLedger(tmp_path / "zero-cancelled.sqlite")
    cancelled_active = cancelled.create_initial("zero-cancelled", plan("zero-cancelled"))
    assert cancelled.request_cancel(cancelled_active, "cancel-zero")["status"] == "ACK_CANCELLED"
    assert cancelled.transition_once(cancelled_active, "fallback", failure, 0) is None

    wall = [1_000]
    expired = AttemptLedger(tmp_path / "zero-expired.sqlite", now_ms=lambda: wall[0])
    expired_plan = plan("zero-expired")
    expired_plan["taskDeadlineMs"] = 1_250
    expired_active = expired.create_initial("zero-expired", expired_plan)
    assert expired.transition_once(expired_active, "fallback", failure, 0) is None
    assert [event["kind"] for event in expired.read_outbox("zero-expired")] == [
        "attempt_created"
    ]

    order = AttemptLedger(tmp_path / "zero-order.sqlite")
    order_active = order.create_initial("zero-order", plan("zero-order"))
    assert order.transition_once(order_active, "primary", failure, 0) is None

    budget = AttemptLedger(tmp_path / "zero-budget.sqlite")
    budget_active = budget.create_initial("zero-budget", plan("zero-budget", budget=29))
    assert budget.transition_once(budget_active, "fallback", failure, 0) is None

    circuit = AttemptLedger(
        tmp_path / "zero-circuit.sqlite", now_ms=lambda: 10_000_000,
    )
    for index in range(3):
        task_id = f"zero-circuit-{index}"
        active = circuit.create_initial(task_id, plan(task_id))
        transitioned = circuit.transition_once(active, "fallback", failure, 0)
        assert transitioned["status"] == "TRANSITIONED"
        assert transitioned["successorSubmitNotBeforeMs"] == 10_000_250
    blocked_active = circuit.create_initial("zero-circuit-blocked", plan("zero-circuit-blocked"))
    assert circuit.transition_once(blocked_active, "fallback", failure, 0) is None

    conn = sqlite3.connect(tmp_path / "zero-circuit.sqlite")
    try:
        conn.execute(
            "UPDATE circuit_transition_authority SET witness_digest='corrupt' "
            "WHERE transition_outbox_id=(SELECT MIN(transition_outbox_id) "
            "FROM circuit_transition_authority)"
        )
        conn.commit()
    finally:
        conn.close()
    corrupt_active = circuit.create_initial("zero-corrupt", plan("zero-corrupt"))
    with pytest.raises(LedgerError):
        circuit.transition_once(corrupt_active, "fallback", failure, 0)


def test_circuit_authority_scope_uses_one_bounded_provider_lookup(tmp_path):
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    providers = ["primary", *[f"provider-{index}" for index in range(63)]]

    def wide_plan(task_id: str) -> dict:
        result = plan(task_id)
        result["eligibleProviderIds"] = providers
        result["providerCeilings"] = {provider: 10 for provider in providers}
        return result

    ledger = AttemptLedger(tmp_path / "wide-circuit.sqlite", now_ms=lambda: 10_000_000)
    for index in range(3):
        task_id = f"wide-circuit-{index}"
        active = ledger.create_initial(task_id, wide_plan(task_id))
        transitioned = ledger.transition_once(active, "provider-0", failure, 0)
        assert transitioned is not None

    conn = sqlite3.connect(ledger.db_path)
    conn.row_factory = sqlite3.Row
    statements: list[str] = []
    conn.set_trace_callback(statements.append)
    try:
        assert AttemptLedger._circuit_open(
            conn, "primary", 10_000_000, providers,
        ) is True
    finally:
        conn.close()

    authority_lookups = [
        statement for statement in statements
        if "FROM circuit_transition_authority" in statement
    ]
    assert len(authority_lookups) == 1
    assert " IN (" in authority_lookups[0]


def test_dispatch_barrier_is_irreversible(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    first = ledger.create_initial("task", plan("task"))
    assert ledger.mark_dispatch_attempted(first)
    assert ledger.mark_dispatch_attempted(first) is None
    assert ledger.transition_once(
        first, "fallback",
        {"failureClass": "retryable", "code": "connection", "retryable": True},
    ) is None


def test_distinct_tool_fences_survive_dispatch_barrier_without_transition(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    first = ledger.create_initial("task", plan("task"))

    assert ledger.authorize_tool_forward(first, "call-1", "read_file", {"path": "a"})["status"] == "FIRST_FENCED"
    second = ledger.authorize_tool_forward(first, "call-2", "read_file", {"path": "b"})
    assert second["status"] == "FENCED"
    assert ledger.get_active("task")["dispatchAttempted"] is True
    assert ledger.list_attempts("task")[0]["dispatchAttempted"] is True

    conn = sqlite3.connect(tmp_path / "ledger.sqlite")
    assert conn.execute("SELECT COUNT(*) FROM tool_fences").fetchone()[0] == 2
    conn.close()
    dispatch_events = [event for event in ledger.read_outbox("task")
                       if event["kind"] == "dispatch_attempted"]
    assert len(dispatch_events) == 1

    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    assert ledger.transition_once(first, "fallback", failure) is None
    assert ledger.recover_and_transition_once(first, "recovery-1")["status"] == "TERMINAL"


def test_tool_fence_reuse_and_inactive_tuple_reject_without_new_facts(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    active = ledger.create_initial("task", plan("task"))
    assert ledger.authorize_tool_forward(active, "call-1", "read_file", {"path": "a"})["status"] == "FIRST_FENCED"
    assert ledger.authorize_tool_forward(active, "call-1", "read_file", {"path": "a"})["status"] == "ALREADY_FENCED"
    assert ledger.authorize_tool_forward(active, "call-1", "read_file", {"path": "b"})["status"] == "REJECTED"

    cancelled = ledger.create_initial("cancelled", plan("cancelled"))
    assert ledger.request_cancel(cancelled, "cancel-1")["status"] == "ACK_CANCELLED"
    assert ledger.authorize_tool_forward(cancelled, "cancelled-call", "read_file")["status"] == "REJECTED"

    clock = [10_000]
    expiring = AttemptLedger(tmp_path / "expiry.sqlite", now_ms=lambda: clock[0])
    expiry_plan = plan("expired")
    expiry_plan["taskDeadlineMs"] = 20_000
    expired = expiring.create_initial("expired", expiry_plan)
    clock[0] = 20_000
    assert expiring.authorize_tool_forward(expired, "expired-call", "read_file")["status"] == "REJECTED"

    stale = ledger.create_initial("stale", plan("stale"))
    assert ledger.transition_once(stale, "fallback", {
        "failureClass": "retryable", "code": "connection", "retryable": True,
    })["status"] == "TRANSITIONED"
    assert ledger.authorize_tool_forward(stale, "stale-call", "read_file")["status"] == "REJECTED"

    conn = sqlite3.connect(tmp_path / "ledger.sqlite")
    assert conn.execute("SELECT COUNT(*) FROM tool_fences WHERE task_id IN ('cancelled','stale')").fetchone()[0] == 0
    conn.close()
    assert not [event for event in ledger.read_outbox("cancelled") if event["kind"] == "dispatch_attempted"]
    assert not [event for event in ledger.read_outbox("stale") if event["kind"] == "dispatch_attempted"]
    assert not [event for event in expiring.read_outbox("expired") if event["kind"] == "dispatch_attempted"]


def test_unknown_cost_keeps_full_reservation(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    first = ledger.create_initial("task", plan("task", budget=29))
    assert ledger.record_cost_if_active(first, None)
    assert ledger.transition_once(
        first, "fallback",
        {"failureClass": "retryable", "code": "connection", "retryable": True},
    ) is None


def test_authoritative_cost_source_survives_cost_and_completion_facts(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    first = ledger.create_initial("source", plan("source"))

    assert ledger.record_cost_if_active(first, 7, "account_delta")
    assert ledger.complete_if_active(first, cost_source="account_delta")

    events = ledger.read_outbox("source")
    assert events[-2]["payload"] == {
        "actualCostMicroUsd": 7, "known": True, "source": "account_delta",
    }
    assert events[-1]["payload"] == {
        "outcome": "completed", "actualCostMicroUsd": 7,
        "known": True, "source": "account_delta",
    }


def test_outbox_projection_deduplicates_by_outbox_id(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    ledger.create_initial("task", plan("task"))
    projected: list[int] = []
    assert ledger.project_outbox(lambda event: projected.append(event["outboxId"])) == 1
    assert ledger.project_outbox(lambda event: projected.append(event["outboxId"])) == 0
    assert len(projected) == 1


def test_plan_rejects_credentials_and_negative_micro_usd(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    with pytest.raises(InvalidPlanError):
        bad = plan("secret")
        bad["apiKey"] = "never-store"
        ledger.create_initial("secret", bad)
    with pytest.raises(InvalidPlanError):
        bad = plan("negative")
        bad["providerCeilings"]["primary"] = -1
        ledger.create_initial("negative", bad)


def test_wal_bootstrap_is_once_and_hot_connections_keep_full_and_disable_auto_checkpoint(tmp_path):
    path = tmp_path / "wal-bootstrap.sqlite"
    ledger = AttemptLedger(path)
    ledger.wait_for_maintenance()

    conn = ledger._connect()
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert conn.execute("PRAGMA synchronous").fetchone()[0] == 2  # FULL
        assert conn.execute("PRAGMA wal_autocheckpoint").fetchone()[0] == 0
    finally:
        conn.close()

    source = Path(__file__).resolve().parents[1] / "mcp_wrapper" / "attempt_ledger.py"
    text = source.read_text(encoding="utf-8")
    assert text.count("PRAGMA journal_mode=WAL") == 1
    assert text.count("PRAGMA wal_checkpoint(PASSIVE)") == 1
    assert "wal_checkpoint(FULL)" not in text
    assert "wal_checkpoint(RESTART)" not in text
    assert "wal_checkpoint(TRUNCATE)" not in text


def test_non_wal_existing_database_is_converted_before_schema_work(tmp_path):
    path = tmp_path / "delete-mode.sqlite"
    conn = sqlite3.connect(path)
    assert conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0].lower() == "delete"
    conn.close()

    ledger = AttemptLedger(path)
    assert ledger.schema_version() == 3
    conn = sqlite3.connect(path)
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        conn.close()


def test_checkpoint_is_watermarked_diagnostic_only_until_explicit_drain(tmp_path):
    ledger = AttemptLedger(tmp_path / "checkpoint.sqlite")
    baseline = ledger.maintenance_metrics()
    active = ledger.create_initial("checkpoint", plan("checkpoint"))
    for index in range(62):
        assert ledger.append_event_if_active(active, "progress", {"n": index}) is not None
    before = ledger.maintenance_metrics()
    assert before["scheduled"] == baseline["scheduled"]

    assert ledger.append_event_if_active(active, "progress", {"n": 62}) is not None
    pending = ledger.maintenance_metrics()
    assert pending["maintenanceNeeded"] is True
    assert pending["scheduled"] == baseline["scheduled"] == 0
    assert pending["inflight"] is False
    assert ledger.wait_for_maintenance()["scheduled"] == 0
    after = ledger.checkpoint_after_drain()
    assert after["status"] in {"COMPLETED", "BUSY"}
    assert after["scheduled"] == 1
    assert ledger.maintenance_metrics()["inflight"] is False


def test_checkpoint_skips_until_request_and_transaction_drain(tmp_path):
    ledger = AttemptLedger(tmp_path / "checkpoint-idle.sqlite")
    active = ledger.create_initial("checkpoint-idle", plan("checkpoint-idle"))
    for index in range(64):
        assert ledger.append_event_if_active(active, "progress", {"n": index}) is not None

    with ledger.request_scope():
        held = ledger.checkpoint_after_drain()
        assert held["status"] == "SKIPPED_NOT_DRAINED"
        assert ledger.maintenance_metrics()["scheduled"] == 0

    with ledger._tx():
        held = ledger.checkpoint_after_drain()
        assert held["status"] == "SKIPPED_NOT_DRAINED"
        assert ledger.maintenance_metrics()["activeTransactions"] == 1

    released = ledger.checkpoint_after_drain()
    assert released["status"] in {"COMPLETED", "BUSY"}
    closed = ledger.shutdown_for_tests(checkpoint=False)
    assert closed["scheduled"] == 1
    assert ledger.shutdown_for_tests(checkpoint=False)["status"] == "CLOSED"


def test_fused_retry_observation_transition_is_atomic_and_idempotent(tmp_path):
    ledger = AttemptLedger(tmp_path / "fused.sqlite")
    active = ledger.create_initial("fused", plan("fused"))
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    plan_hash = ledger._plan_hash(plan("fused"))

    first = ledger.record_retryable_observation_and_transition_once(
        active, "fallback", failure, "gateway", 250, plan_hash,
        "fused-observation", "fused-transition",
    )
    assert first["status"] == "TRANSITIONED"
    kinds = [event["kind"] for event in ledger.read_outbox("fused")]
    assert kinds == ["attempt_created", "provider_event", "transitioned"]
    conn = sqlite3.connect(tmp_path / "fused.sqlite")
    try:
        assert conn.execute("SELECT COUNT(*) FROM circuit_transition_authority").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM mutation_idempotency").fetchone()[0] == 2
    finally:
        conn.close()

    replay = ledger.record_retryable_observation_and_transition_once(
        active, "fallback", failure, "gateway", 250, plan_hash,
        "fused-observation", "fused-transition",
    )
    assert replay["status"] == "TRANSITIONED"
    assert replay["idempotentReplay"] is True
    assert len(ledger.read_outbox("fused")) == 3


def test_v2_migrates_to_v3_without_fabricating_fences(tmp_path):
    path = tmp_path / "v2.sqlite"
    ledger = AttemptLedger(path)
    active = ledger.create_initial("v2", plan("v2"))
    ledger.shutdown_for_tests(checkpoint=False)
    conn = sqlite3.connect(path)
    try:
        conn.execute("ALTER TABLE attempts DROP COLUMN provider_submit_not_before_ms")
        conn.execute("UPDATE ledger_meta SET value='2' WHERE key='schema_version'")
        conn.commit()
    finally:
        conn.close()

    migrated = AttemptLedger(path)
    assert migrated.schema_version() == 3
    assert migrated.get_active("v2")["providerSubmitNotBeforeMs"] == 0
    assert active["epoch"] == 0


def test_fused_retry_coalesces_one_cost_fact_before_observation_and_transition(tmp_path):
    ledger = AttemptLedger(tmp_path / "fused-cost.sqlite")
    active = ledger.create_initial("fused-cost", plan("fused-cost"))
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    result = ledger.record_retryable_observation_and_transition_once(
        active, "fallback", failure, "engine", 250,
        ledger._plan_hash(plan("fused-cost")), "cost-observation", "cost-transition",
        cost_evidence=CostEvidence(7, "exact"),
    )
    assert result["status"] == "TRANSITIONED"
    assert result["successorSubmitNotBeforeMs"] > active.get("providerSubmitNotBeforeMs", 0)
    assert [event["kind"] for event in ledger.read_outbox("fused-cost")] == [
        "attempt_created", "cost_recorded", "provider_event", "transitioned",
    ]
    assert ledger.get_task("fused-cost")["reserved_micro_usd"] == 27
    assert sum(event["kind"] == "cost_recorded" for event in ledger.read_outbox("fused-cost")) == 1


def test_fenced_submit_is_not_ready_without_mutating_dispatch_or_outbox(tmp_path):
    wall = [1_000]
    mono = [10_000_000_000]
    ledger = AttemptLedger(
        tmp_path / "fence.sqlite", now_ms=lambda: wall[0],
        monotonic_ns=lambda: mono[0],
    )
    active = ledger.create_initial("fence", plan("fence"))
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    transitioned = ledger.transition_once(
        active, "fallback", failure, 250, ledger._plan_hash(plan("fence")), "fence-transition",
    )
    successor = transitioned | {"taskId": transitioned.pop("taskId")}
    successor_tuple = {"taskId": "fence", "attemptId": transitioned["attemptId"], "epoch": 1}
    provider_ref = {
        "providerId": "fallback", "label": "Fallback", "modelId": "model",
        "credentialEnvName": "TORQCLAW_KEY", "baseUrlEnvName": "TORQCLAW_URL",
    }
    before = ledger.read_outbox("fence")
    not_ready = ledger.submit_attempt(
        successor_tuple, plan("fence"), provider_ref, 9_999_999_999_000, "fence-submit",
    )
    assert not_ready["status"] == "NOT_READY"
    assert not_ready["activeTuple"] == successor_tuple
    assert ledger.get_active("fence")["dispatchAttempted"] is False
    assert ledger.read_outbox("fence") == before

    wall[0] += 250
    assert ledger.submit_attempt(
        successor_tuple, plan("fence"), provider_ref, 9_999_999_999_000, "fence-submit",
    )["status"] == "NOT_READY"
    mono[0] += 250_000_000
    submitted = ledger.submit_attempt(
        successor_tuple, plan("fence"), provider_ref, 9_999_999_999_000, "fence-submit",
    )
    assert submitted["status"] == "SUBMITTED"
    assert ledger.get_active("fence")["state"] == "provider_started"


def test_fused_retry_rolls_back_observation_and_transition_boundaries(tmp_path, monkeypatch):
    ledger = AttemptLedger(tmp_path / "fused-crash.sqlite")
    active = ledger.create_initial("fused-crash", plan("fused-crash"))
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    plan_hash = ledger._plan_hash(plan("fused-crash"))
    original = AttemptLedger._outbox
    calls = {"count": 0}

    def fail_transition(conn, task_id, attempt_id, epoch, kind, payload, now):
        calls["count"] += 1
        if calls["count"] == 2:
            raise sqlite3.OperationalError("injected transition boundary crash")
        return original(conn, task_id, attempt_id, epoch, kind, payload, now)

    monkeypatch.setattr(AttemptLedger, "_outbox", staticmethod(fail_transition))
    with pytest.raises(sqlite3.OperationalError):
        ledger.record_retryable_observation_and_transition_once(
            active, "fallback", failure, "gateway", 250, plan_hash,
            "crash-observation", "crash-transition",
        )
    assert ledger.get_status("fused-crash")["active"]["epoch"] == 0
    assert [event["kind"] for event in ledger.read_outbox("fused-crash")] == ["attempt_created"]
    conn = sqlite3.connect(tmp_path / "fused-crash.sqlite")
    try:
        assert conn.execute("SELECT COUNT(*) FROM mutation_idempotency").fetchone()[0] == 0
    finally:
        conn.close()


def test_fused_partial_observation_completes_once_and_transition_without_observation_fails_closed(tmp_path):
    ledger = AttemptLedger(tmp_path / "fused-partial.sqlite")
    active = ledger.create_initial("fused-partial", plan("fused-partial"))
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    plan_hash = ledger._plan_hash(plan("fused-partial"))
    recorded = ledger.record_observation(active, failure, "partial-observation", "gateway")
    assert recorded["status"] == "RECORDED"
    completed = ledger.record_retryable_observation_and_transition_once(
        active, "fallback", failure, "gateway", 250, plan_hash,
        "partial-observation", "partial-transition",
    )
    assert completed["status"] == "TRANSITIONED"
    assert [event["kind"] for event in ledger.read_outbox("fused-partial")] == [
        "attempt_created", "provider_event", "transitioned"
    ]

    orphan = AttemptLedger(tmp_path / "fused-orphan.sqlite")
    orphan_active = orphan.create_initial("fused-orphan", plan("fused-orphan"))
    orphan_hash = orphan._plan_hash(plan("fused-orphan"))
    assert orphan.transition_once(orphan_active, "fallback", failure, 250, orphan_hash, "orphan-transition")
    rejected = orphan.record_retryable_observation_and_transition_once(
        orphan_active, "fallback", failure, "gateway", 250, orphan_hash,
        "orphan-observation", "orphan-transition",
    )
    assert rejected["status"] == "REJECTED"
    assert [event["kind"] for event in orphan.read_outbox("fused-orphan")] == [
        "attempt_created", "transitioned"
    ]


def test_terminal_poll_completion_is_atomic_and_idempotent(tmp_path):
    ledger = AttemptLedger(tmp_path / "terminal-poll.sqlite")
    active = ledger.create_initial("terminal-poll", plan("terminal-poll"))
    failure = {"failureClass": "terminal", "code": "engine_failure", "retryable": False}

    committed = ledger.complete_terminal_from_poll_if_active(
        active, "failed", actual_cost_micro_usd=7, cost_source="exact",
        normalized_failure=failure, failure_source="engine",
    )
    assert committed is not None
    assert committed["terminalCommitted"] is True
    assert committed["terminalOutcome"] == "failed"
    assert ledger.get_status("terminal-poll")["active"] is None
    assert [event["kind"] for event in ledger.read_outbox("terminal-poll")] == [
        "attempt_created", "cost_recorded", "provider_event", "attempt_completed",
    ]

    replay = ledger.complete_terminal_from_poll_if_active(
        active, "failed", actual_cost_micro_usd=7, cost_source="exact",
        normalized_failure=failure, failure_source="engine",
    )
    assert replay is not None and replay["terminalCommitted"] is True
    assert len(ledger.read_outbox("terminal-poll")) == 4


def test_retryable_poll_cannot_cross_terminal_coalescing_boundary(tmp_path):
    ledger = AttemptLedger(tmp_path / "retryable-poll.sqlite")
    active = ledger.create_initial("retryable-poll", plan("retryable-poll"))
    with pytest.raises(LedgerError):
        ledger.complete_terminal_from_poll_if_active(
            active, "failed", normalized_failure={
                "failureClass": "retryable", "code": "connection", "retryable": True,
            }, failure_source="engine",
        )
    assert ledger.get_status("retryable-poll")["active"] is not None
    assert [event["kind"] for event in ledger.read_outbox("retryable-poll")] == ["attempt_created"]


def test_terminal_poll_rolls_back_cost_and_failure_when_completion_boundary_fails(tmp_path, monkeypatch):
    ledger = AttemptLedger(tmp_path / "terminal-crash.sqlite")
    active = ledger.create_initial("terminal-crash", plan("terminal-crash"))
    original = AttemptLedger._outbox
    calls = {"count": 0}

    def flaky(conn, task_id, attempt_id, epoch, kind, payload, now):
        calls["count"] += 1
        if calls["count"] == 2:
            raise sqlite3.OperationalError("injected terminal boundary crash")
        return original(conn, task_id, attempt_id, epoch, kind, payload, now)

    monkeypatch.setattr(AttemptLedger, "_outbox", staticmethod(flaky))
    with pytest.raises(sqlite3.OperationalError):
        ledger.complete_terminal_from_poll_if_active(
            active, "failed", actual_cost_micro_usd=7, cost_source="exact",
            normalized_failure={"failureClass": "terminal", "code": "engine_failure", "retryable": False},
            failure_source="engine",
        )
    assert ledger.get_status("terminal-crash")["active"] is not None
    assert [event["kind"] for event in ledger.read_outbox("terminal-crash")] == ["attempt_created"]


def _fused_inputs(ledger: AttemptLedger, task_id: str):
    active = ledger.create_initial(task_id, plan(task_id))
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
    return active, failure, ledger._plan_hash(plan(task_id))


def test_fused_boundary_diagnostics_are_exact_and_authority_neutral(tmp_path):
    ledger = AttemptLedger(tmp_path / "fused-boundary.sqlite")
    active, failure, plan_hash = _fused_inputs(ledger, "fused-boundary")

    result = ledger.record_retryable_observation_and_transition_once(
        active, "fallback", failure, "gateway", 250, plan_hash,
        "boundary-observation", "boundary-transition",
    )

    assert result["status"] == "TRANSITIONED"
    diagnostics = ledger.boundary_diagnostics()
    assert diagnostics["schemaVersion"] == 1
    assert diagnostics["available"] is True
    assert diagnostics["capacity"] == 512
    assert diagnostics["firstAvailableSequence"] == 1
    assert diagnostics["lastSequence"] == 1
    assert diagnostics["droppedRecords"] == 0
    assert len(diagnostics["records"]) == 1
    record = diagnostics["records"][0]
    assert set(record) == {
        "sequence", "operation", "outcome", "boundaryMs",
        "maintenanceBefore", "maintenanceAfter",
    }
    assert record["sequence"] == 1
    assert record["operation"] == "fused_retryable_transition"
    assert record["outcome"] == "committed"
    assert set(record["boundaryMs"]) == {
        "openMs", "pragmaMs", "beginImmediateMs", "statementWorkMs",
        "commitMs", "closeMs", "transactionMs",
    }
    assert all(
        isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
        for value in record["boundaryMs"].values()
    )
    assert set(record["maintenanceBefore"]) == {"writesSinceCheckpoint", "maintenanceNeeded"}
    assert set(record["maintenanceAfter"]) == {"writesSinceCheckpoint", "maintenanceNeeded"}
    assert "boundary-observation" not in json.dumps(record)
    assert "boundary-transition" not in json.dumps(record)

    sliced = ledger.boundary_diagnostics(after_sequence=0)
    assert sliced["records"] == diagnostics["records"]
    assert ledger.boundary_diagnostics(after_sequence=1)["records"] == []
    assert ledger.get_status("fused-boundary")["active"]["epoch"] == 1
    assert [event["kind"] for event in ledger.read_outbox("fused-boundary")] == [
        "attempt_created", "provider_event", "transitioned",
    ]


class _FaultConnection:
    def __init__(self, connection, mode):
        self._connection = connection
        self._mode = mode

    def execute(self, sql, *args):
        normalized = str(sql).strip().upper()
        if (
            (self._mode == "begin" and normalized == "BEGIN IMMEDIATE") or
            (self._mode == "statement" and normalized.startswith("INSERT INTO OUTBOX")) or
            (self._mode == "commit" and normalized == "COMMIT")
        ):
            raise sqlite3.OperationalError(f"injected {self._mode} boundary failure")
        return self._connection.execute(sql, *args)

    def close(self):
        self._connection.close()
        if self._mode == "close":
            raise sqlite3.OperationalError("injected close boundary failure")

    def __getattr__(self, name):
        return getattr(self._connection, name)


@pytest.mark.parametrize("mode,expected", [
    ("setup", "setup_failed"),
    ("begin", "begin_failed"),
    ("statement", "rolled_back"),
    ("commit", "commit_failed"),
    ("close", "close_failed"),
])
def test_fused_boundary_failure_outcomes_are_categorical(tmp_path, monkeypatch, mode, expected):
    ledger = AttemptLedger(tmp_path / f"fused-{mode}.sqlite")
    active, failure, plan_hash = _fused_inputs(ledger, f"fused-{mode}")
    original_connect = ledger._connect

    if mode == "setup":
        def failing_connect(*, boundary=None):
            raise sqlite3.OperationalError("injected setup boundary failure")
        monkeypatch.setattr(ledger, "_connect", failing_connect)
    else:
        def wrapped_connect(*, boundary=None):
            return _FaultConnection(original_connect(boundary=boundary), mode)
        monkeypatch.setattr(ledger, "_connect", wrapped_connect)

    with pytest.raises(sqlite3.OperationalError):
        ledger.record_retryable_observation_and_transition_once(
            active, "fallback", failure, "gateway", 250, plan_hash,
            f"{mode}-observation", f"{mode}-transition",
        )

    record = ledger.boundary_diagnostics()["records"][-1]
    assert record["operation"] == "fused_retryable_transition"
    assert record["outcome"] == expected
    assert set(record["boundaryMs"]) == {
        "openMs", "pragmaMs", "beginImmediateMs", "statementWorkMs",
        "commitMs", "closeMs", "transactionMs",
    }
    assert isinstance(record["boundaryMs"]["transactionMs"], (int, float))
    assert "injected" not in json.dumps(record)


def test_boundary_diagnostics_is_read_only_and_does_not_open_sqlite(tmp_path, monkeypatch):
    ledger = AttemptLedger(tmp_path / "boundary-read-only.sqlite")
    original_connect = sqlite3.connect

    def forbidden_connect(*args, **kwargs):
        raise AssertionError("boundary_diagnostics opened SQLite")

    monkeypatch.setattr(sqlite3, "connect", forbidden_connect)
    empty = ledger.boundary_diagnostics()
    assert empty["available"] is True
    assert empty["records"] == []
    assert empty["lastSequence"] == 0
    monkeypatch.setattr(sqlite3, "connect", original_connect)


def test_boundary_ring_retains_order_and_reports_eviction(tmp_path):
    ledger = AttemptLedger(tmp_path / "boundary-ring.sqlite")
    total = 513
    for index in range(total):
        task_id = f"ring-{index}"
        ring_plan = plan(task_id)
        ring_plan["eligibleProviderIds"] = [f"primary-{index}", f"fallback-{index}"]
        ring_plan["providerCeilings"] = {f"primary-{index}": 10, f"fallback-{index}": 20}
        active = ledger.create_initial(task_id, ring_plan)
        failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
        plan_hash = ledger._plan_hash(ring_plan)
        result = ledger.record_retryable_observation_and_transition_once(
            active, f"fallback-{index}", failure, "gateway", 250, plan_hash,
            f"ring-observation-{index}", f"ring-transition-{index}",
        )
        assert result["status"] == "TRANSITIONED"

    diagnostics = ledger.boundary_diagnostics()
    assert diagnostics["capacity"] == 512
    assert diagnostics["firstAvailableSequence"] == 2
    assert diagnostics["lastSequence"] == total
    assert diagnostics["droppedRecords"] == 1
    records = diagnostics["records"]
    assert len(records) == 512
    assert [record["sequence"] for record in records] == list(range(2, total + 1))
    assert ledger.boundary_diagnostics(after_sequence=total - 1)["records"] == [records[-1]]
    assert ledger.boundary_diagnostics(after_sequence=total)["records"] == []


@pytest.mark.skipif(not hasattr(os, "fork"), reason="os.fork is unavailable on this platform")
def test_inherited_ledger_boundary_reader_refuses_forked_process(tmp_path):
    ledger = AttemptLedger(tmp_path / "boundary-fork.sqlite")
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        try:
            payload = json.dumps(ledger.boundary_diagnostics()).encode("utf-8")
            os.write(write_fd, payload)
        finally:
            os.close(write_fd)
            os._exit(0)
    os.close(write_fd)
    try:
        payload = os.read(read_fd, 4096)
        _, status = os.waitpid(pid, 0)
    finally:
        os.close(read_fd)
    assert os.waitstatus_to_exitcode(status) == 0
    assert json.loads(payload) == {
        "schemaVersion": 1, "available": False, "reason": "process_boundary",
    }


def test_logical_timing_diagnostics_are_default_off_and_cover_exact_operations(tmp_path):
    disabled = AttemptLedger(tmp_path / "timing-disabled.sqlite")
    assert disabled.logical_timing_diagnostics()["records"] == []

    ledger = AttemptLedger(
        tmp_path / "timing-enabled.sqlite", timing_diagnostics_enabled=True,
    )
    request = "timing-task"
    admitted = ledger.admit_frontier(request, plan(request), 9_999_999_999_999, ["primary", "fallback"])
    assert admitted["status"] == "ADMITTED"
    active = admitted["tuple"]
    assert ledger.submit_attempt(
        active, plan(request), provider_ref("primary"), 9_999_999_999_999,
    )["status"] == "SUBMITTED"
    assert ledger.poll_observations(request)["status"] == "OK"
    assert ledger.page_outbox()["status"] == "OK"
    assert ledger.transition_once(
        active, "fallback", {"failureClass": "retryable", "code": "connection", "retryable": True},
    ) is not None

    diagnostics = ledger.logical_timing_diagnostics()
    records = diagnostics["records"]
    assert [record["operation"] for record in records] == [
        "admit_frontier", "submit_attempt", "poll_observations", "page_outbox", "transition_once",
    ]
    assert all(record["schemaVersion"] == 1 for record in records)
    assert all(record["authoritative"] is False for record in records)
    assert all(record["source"] == "fixture_only" for record in records)
    assert all(record["correlation"] == "exact" for record in records)
    assert all(record["outcome"] in {"completed", "rejected", "duplicate", "error"} for record in records)
    phases = {"openMs", "pragmaMs", "beginImmediateMs", "statementWorkMs", "commitMs", "closeMs", "totalMs"}
    assert all(set(record["sqliteMs"]) == phases for record in records)
    assert all(
        value is None or isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
        for record in records for value in record["sqliteMs"].values()
    )
    serialized = json.dumps(diagnostics, sort_keys=True).lower()
    assert not any(token in serialized for token in ("timing-task", "attemptid", "payload", "path", "env", "credential", "exception"))


def test_logical_timing_diagnostics_are_bounded_and_recorder_failure_is_safe(tmp_path, monkeypatch):
    ledger = AttemptLedger(
        tmp_path / "timing-bounded.sqlite", timing_diagnostics_enabled=True,
    )
    record = {
        "schemaVersion": 1, "authoritative": False,
        "source": "fixture_only", "correlation": "exact",
        "operation": "page_outbox", "outcome": "completed",
        "sqliteMs": {phase: 0.0 for phase in (
            "openMs", "pragmaMs", "beginImmediateMs", "statementWorkMs",
            "commitMs", "closeMs", "totalMs",
        )},
    }
    for _ in range(4104):
        ledger._safe_append_logical_record(record)
    bounded = ledger.logical_timing_diagnostics()
    assert bounded["capacity"] == 4096
    assert len(bounded["records"]) == 4096
    assert bounded["droppedCount"] == 8

    monkeypatch.setattr(
        ledger, "_append_logical_record",
        lambda record: (_ for _ in ()).throw(RuntimeError("recorder failure")),
    )
    assert ledger.page_outbox()["status"] == "OK"
