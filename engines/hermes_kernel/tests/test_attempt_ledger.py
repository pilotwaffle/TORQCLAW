from __future__ import annotations

import sqlite3
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_wrapper.attempt_ledger import (  # noqa: E402
    AttemptLedger,
    InvalidPlanError,
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
        {"failureClass": "retryable", "code": "timeout", "retryable": True},
    )
    assert second["epoch"] == 1
    assert ledger.get_active("task")["attemptId"] == second["attemptId"]
    assert ledger.append_event_if_active(first, "late") is None
    assert [event["kind"] for event in ledger.read_outbox("task")] == [
        "attempt_created", "transitioned"
    ]


def test_dispatch_barrier_is_irreversible(tmp_path):
    ledger = AttemptLedger(tmp_path / "ledger.sqlite")
    first = ledger.create_initial("task", plan("task"))
    assert ledger.mark_dispatch_attempted(first)
    assert ledger.mark_dispatch_attempted(first) is None
    assert ledger.transition_once(
        first, "fallback",
        {"failureClass": "retryable", "code": "timeout", "retryable": True},
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
    assert ledger.recover_and_transition_once(first, "recovery-1")["status"] == "REJECTED"


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
        {"failureClass": "retryable", "code": "timeout", "retryable": True},
    ) is None


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
