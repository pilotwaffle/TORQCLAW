"""Deterministic, offline, manifest-enforced isolated P0 matrix.

The manifest is the accounting authority. Each parameter is a meaningful
boundary case; this suite intentionally claims exactly 108 cases, not 1,000.
"""
from __future__ import annotations

import json
import hashlib
import os
import uuid
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engines" / "hermes_kernel"))

from mcp_wrapper.attempt_ledger import (  # noqa: E402
    ActiveTuple,
    AdmissionRejected,
    AttemptLedger,
    CorruptLedger,
    InvalidPlanError,
    LedgerError,
    PROVIDER_STATES,
    TaskAlreadyExists,
    UnsupportedSchemaVersion,
)

@pytest.fixture
def tmp_path():
    path = Path("E:/tmp") / f"torqclaw-p0-{os.getpid()}-{uuid.uuid4().hex}"
    path.mkdir(parents=True, exist_ok=False)
    try:
        yield path
    finally:
        for child in path.glob("*"):
            child.unlink(missing_ok=True)
        path.rmdir()


MANIFEST_PATH = Path(__file__).with_name("p0_manifest.json")
MANIFEST = json.loads(MANIFEST_PATH.read_text(encoding="utf-8-sig"))
CASES = [(category["name"], case_id)
         for category in MANIFEST["categories"]
         for case_id in category["ids"]]
CASE_IDS = [case_id for _, case_id in CASES]


def make_plan(task_id: str, *, providers=("p1", "p2"), budget=None,
              deadline=9_999_999_999_999, limit=None, ceiling=10):
    if limit is None:
        limit = len(providers) - 1
    return {
        "schemaVersion": 1,
        "taskId": task_id,
        "chainId": "deterministic-chain",
        "eligibleProviderIds": list(providers),
        "privacyClass": "normal",
        "privacyHash": "a" * 64,
        "policyHash": "b" * 64,
        "contextHash": "c" * 64,
        "grantHash": "d" * 64,
        "taskDeadlineMs": deadline,
        "attemptTimeoutMs": 1000,
        "transitionLimit": limit,
        "budgetMicroUsd": budget,
        "providerCeilings": {provider: ceiling * (index + 1)
                             for index, provider in enumerate(providers)},
        "featurePolicyRevision": "policy-1",
        "planRevision": "plan-1",
    }


def create(tmp_path, task="task", **kwargs):
    ledger = AttemptLedger(tmp_path / f"{task}.sqlite")
    attempt = ledger.create_initial(task, make_plan(task, **kwargs))
    return ledger, attempt


def failure(kind="retryable", retryable=True):
    return {"failureClass": kind, "code": "deterministic_timeout",
            "retryable": retryable}


def transition(tmp_path, task="task", **kwargs):
    ledger, first = create(tmp_path, task, **kwargs)
    second = ledger.transition_once(first, "p2", failure())
    assert second is not None
    return ledger, first, second


def tamper_plan(path: Path, edit):
    conn = sqlite3.connect(path)
    try:
        row = conn.execute("SELECT plan_json FROM tasks").fetchone()
        plan = json.loads(row[0])
        edit(plan)
        conn.execute("UPDATE tasks SET plan_json=?",
                     (json.dumps(plan, sort_keys=True, separators=(",", ":")),))
        conn.commit()
    finally:
        conn.close()


def coherent_plan_rewrite(path: Path, edit, materialized=None) -> str:
    """Rewrite every mutable task copy while leaving append-only facts untouched."""
    materialized = materialized or {}
    allowed = {"deadline_ms", "transition_limit", "budget_micro_usd"}
    assert set(materialized) <= allowed
    conn = sqlite3.connect(path)
    try:
        plan = json.loads(conn.execute("SELECT plan_json FROM tasks").fetchone()[0])
        task_id = plan["taskId"]
        edit(plan)
        encoded = json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        assignments = ["plan_json=?", "plan_hash=?"] + [f"{key}=?" for key in materialized]
        values = [encoded, digest, *materialized.values()]
        conn.execute(f"UPDATE tasks SET {','.join(assignments)} WHERE task_id=?",
                     [*values, task_id])
        conn.commit()
        return digest
    finally:
        conn.close()


def database_snapshot(path: Path) -> dict[str, list[tuple]]:
    conn = sqlite3.connect(path)
    try:
        return {
            "tasks": conn.execute("SELECT * FROM tasks ORDER BY task_id").fetchall(),
            "attempts": conn.execute("SELECT * FROM attempts ORDER BY task_id,epoch").fetchall(),
            "control": conn.execute("SELECT * FROM active_control ORDER BY task_id").fetchall(),
            "events": conn.execute("SELECT * FROM provider_events ORDER BY event_id").fetchall(),
            "outbox": conn.execute("SELECT * FROM outbox ORDER BY outbox_id").fetchall(),
            "circuits": conn.execute("SELECT * FROM circuit_failures ORDER BY failure_id").fetchall(),
        }
    finally:
        conn.close()


def assert_active_authorization_fails_closed(ledger, current, path: Path, successor="p2"):
    tampered = database_snapshot(path)
    operations = {
        "get_active": lambda: ledger.get_active(current["taskId"]),
        "append_event": lambda: ledger.append_event_if_active(current, "late"),
        "mark_dispatch": lambda: ledger.mark_dispatch_attempted(current),
        "record_cost": lambda: ledger.record_cost_if_active(current, 1),
        "mutate_state": lambda: ledger.mutate_state_if_active(current, "provider_ready"),
        "request_cancel": lambda: ledger.request_cancel_if_active(current),
        "complete": lambda: ledger.complete_if_active(current),
        "recover": lambda: ledger.recover_pre_dispatch_if_active(current),
        "transition": lambda: ledger.transition_once(current, successor, failure()),
    }
    for name, operation in operations.items():
        with pytest.raises(CorruptLedger):
            operation()
        assert database_snapshot(path) == tampered, name


def assert_active_read_transition_fail_closed(ledger, current, path: Path,
                                              successor="p2"):
    tampered = database_snapshot(path)
    with pytest.raises(CorruptLedger):
        ledger.get_active(current["taskId"])
    with pytest.raises(CorruptLedger):
        ledger.transition_once(current, successor, failure())
    assert database_snapshot(path) == tampered


def reset_terminal_rows_to_active(path: Path, task_id: str) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            "UPDATE attempts SET state='active',dispatch_attempted=0,cancel_requested=0,"
            "failure_json=NULL,closed_at_ms=NULL WHERE task_id=?",
            (task_id,),
        )
        conn.execute("UPDATE tasks SET status='running' WHERE task_id=?", (task_id,))
        conn.execute("UPDATE active_control SET status='active' WHERE task_id=?", (task_id,))
        conn.commit()
    finally:
        conn.close()


def run_crashing_child(path: Path, operation: str) -> None:
    child = r'''
import os
import sys

sys.path.insert(0, sys.argv[3])
from mcp_wrapper.attempt_ledger import AttemptLedger

path = sys.argv[1]
operation = sys.argv[2]

def plan():
    return {
        "schemaVersion": 1,
        "taskId": "task",
        "chainId": "crash-chain",
        "eligibleProviderIds": ["p1", "p2"],
        "privacyClass": "normal",
        "privacyHash": "a" * 64,
        "policyHash": "b" * 64,
        "contextHash": "c" * 64,
        "grantHash": "d" * 64,
        "taskDeadlineMs": 9_999_999_999_999,
        "attemptTimeoutMs": 1000,
        "transitionLimit": 1,
        "budgetMicroUsd": None,
        "providerCeilings": {"p1": 10, "p2": 20},
        "featurePolicyRevision": "policy-1",
        "planRevision": "plan-1",
    }

real_outbox = AttemptLedger._outbox

def crash_after_outbox(*args, **kwargs):
    real_outbox(*args, **kwargs)
    os._exit(73)

ledger = AttemptLedger(path)
AttemptLedger._outbox = staticmethod(crash_after_outbox)
if operation == "create":
    ledger.create_initial("task", plan())
else:
    active = ledger.get_active("task")
    if operation == "dispatch":
        ledger.mark_dispatch_attempted(active)
    elif operation == "transition":
        ledger.transition_once(active, "p2", {"failureClass": "retryable", "code": "crash", "retryable": True})
    elif operation == "cost":
        ledger.record_cost_if_active(active, 3)
    elif operation == "recovery":
        ledger.recover_pre_dispatch_if_active(active)
    elif operation == "completion":
        ledger.complete_if_active(active, actual_cost_micro_usd=3)
    else:
        raise AssertionError(operation)
'''
    result = subprocess.run(
        [sys.executable, "-c", child, str(path), operation,
         str(ROOT / "engines" / "hermes_kernel")],
        cwd=ROOT, capture_output=True, text=True,
    )
    assert result.returncode != 0, result.stdout + result.stderr

@pytest.mark.parametrize("category,case_id", CASES, ids=CASE_IDS)
def test_manifest_enforced_p0_case(tmp_path, request, category, case_id):
    if category == "initial_epoch_tombstone_id":
        run_initial_case(tmp_path, case_id)
    elif category == "atomic_stale_mutations":
        run_stale_case(tmp_path, case_id)
    elif category == "transition_eligibility_right":
        run_transition_case(tmp_path, case_id)
    elif category == "fixed_point_budget_cost":
        run_budget_case(tmp_path, case_id)
    elif category == "crash_recovery_boundaries":
        run_crash_case(tmp_path, case_id)
    elif category == "multi_connection_contention":
        run_contention_case(tmp_path, case_id)
    elif category == "contracts_schema_drift":
        run_contract_case(tmp_path, case_id)
    elif category == "outbox_replay_dedupe":
        run_outbox_case(tmp_path, case_id)
    elif category == "secret_free_import_absence":
        run_secret_case(tmp_path, case_id)
    elif category == "manifest_report_integrity":
        run_manifest_case(tmp_path, request, case_id)
    else:
        raise AssertionError(category)


def run_initial_case(tmp_path, case_id):
    if case_id == "initial_tombstone_duplicate":
        ledger, _ = create(tmp_path)
        with pytest.raises(TaskAlreadyExists):
            ledger.create_initial("task", make_plan("task"))
        return
    if case_id == "initial_future_plan_rejected":
        ledger = AttemptLedger(tmp_path / "future.sqlite")
        plan = make_plan("future")
        plan["schemaVersion"] = 999
        with pytest.raises(InvalidPlanError):
            ledger.create_initial("future", plan)
        assert ledger.get_task("future") is None
        return
    if case_id == "initial_secret_free_plan":
        ledger = AttemptLedger(tmp_path / "secret.sqlite")
        plan = make_plan("secret")
        plan["credential"] = "should-never-persist"
        with pytest.raises(InvalidPlanError):
            ledger.create_initial("secret", plan)
        return
    if case_id in {"initial_expired_rejected", "initial_over_budget_rejected"}:
        task = case_id
        clock = [1000]
        ledger = AttemptLedger(tmp_path / f"{task}.sqlite", now_ms=lambda: clock[0])
        plan = make_plan(task, deadline=1000 if case_id == "initial_expired_rejected" else 2000,
                         budget=9 if case_id == "initial_over_budget_rejected" else None)
        with pytest.raises(AdmissionRejected, match="initial admission rejected"):
            ledger.create_initial(task, plan)
        rejected = ledger.get_task(task)
        assert rejected is not None and rejected["status"] == "rejected"
        assert ledger.list_attempts(task) == []
        assert ledger.read_outbox(task) == []
        conn = sqlite3.connect(tmp_path / f"{task}.sqlite")
        try:
            assert conn.execute("SELECT count(*) FROM active_control WHERE task_id=?",
                                (task,)).fetchone()[0] == 0
        finally:
            conn.close()
        with pytest.raises(TaskAlreadyExists):
            ledger.create_initial(task, plan)
        return
    ledger, attempt = create(tmp_path)
    task = ledger.get_task("task")
    assert task is not None
    if case_id == "initial_epoch_zero":
        assert attempt["epoch"] == 0 and attempt["providerId"] == "p1"
    elif case_id == "initial_internal_attempt_id":
        assert attempt["attemptId"] and "attemptId" not in task["plan"]
    elif case_id == "initial_outbox_atomic":
        events = ledger.read_outbox("task")
        assert [event["kind"] for event in events] == ["attempt_created"]
        assert events[0]["payload"] == {
            "providerId": "p1", "planHash": task["plan_hash"]
        }
    elif case_id == "initial_plan_hash_stored":
        assert len(task["plan_hash"]) == 64
        assert ledger.read_outbox("task")[0]["payload"]["planHash"] == task["plan_hash"]
    elif case_id == "initial_one_active_control":
        assert ledger.get_active("task")["attemptId"] == attempt["attemptId"]
    elif case_id == "initial_epoch_unique":
        assert [row["epoch"] for row in ledger.list_attempts("task")] == [0]
    elif case_id == "initial_nonnegative_reservation":
        assert task["reserved_micro_usd"] == 10
    else:
        raise AssertionError(case_id)


def run_stale_case(tmp_path, case_id):
    if case_id in {"expired_cost", "expired_complete"}:
        clock = [1000]
        task = case_id
        ledger = AttemptLedger(tmp_path / f"{task}.sqlite", now_ms=lambda: clock[0])
        first = ledger.create_initial(task, make_plan(task, deadline=1001))
        clock[0] = 1001
        result = (ledger.record_cost_if_active(first, 3)
                  if case_id == "expired_cost"
                  else ledger.complete_if_active(first, actual_cost_micro_usd=3))
        assert result is None
        assert ledger.get_active(task)["state"] == "active"
        assert ledger.get_task(task)["status"] == "running"
        assert [event["kind"] for event in ledger.read_outbox(task)] == ["attempt_created"]
        return
    if case_id == "expired_cancel":
        clock = [1000]
        task = "expired-cancel"
        ledger = AttemptLedger(tmp_path / f"{task}.sqlite", now_ms=lambda: clock[0])
        first = ledger.create_initial(task, make_plan(task, deadline=1001))
        clock[0] = 1001
        assert ledger.request_cancel_if_active(first) is None
        assert ledger.get_active(task)["state"] == "active"
        assert ledger.get_task(task)["status"] == "running"
        assert [event["kind"] for event in ledger.read_outbox(task)] == ["attempt_created"]
        return
    if case_id in {"provider_state_follow_on_mutation", "provider_state_follow_on_cost",
                    "provider_state_follow_on_complete"}:
        ledger, first = create(tmp_path, task=case_id)
        assert ledger.mutate_state_if_active(first, "provider_started")
        if case_id == "provider_state_follow_on_mutation":
            assert ledger.mutate_state_if_active(first, "provider_ready")
            assert ledger.get_active(case_id)["state"] == "provider_ready"
        elif case_id == "provider_state_follow_on_cost":
            assert ledger.record_cost_if_active(first, 3)
            active = ledger.get_active(case_id)
            assert active["state"] == "provider_started"
            assert active["actualCostKnown"] and active["reservedMicroUsd"] == 3
            assert ledger.get_task(case_id)["reserved_micro_usd"] == 3
        elif case_id == "provider_state_follow_on_complete":
            assert ledger.complete_if_active(first, actual_cost_micro_usd=3)
            assert ledger.get_active(case_id) is None
            assert ledger.get_task(case_id)["status"] == "completed"
            assert ledger.list_attempts(case_id)[0]["state"] == "terminal"
        if case_id == "provider_state_follow_on_mutation":
            expected_outbox = ["attempt_created", "state_mutated", "state_mutated"]
        elif case_id == "provider_state_follow_on_cost":
            expected_outbox = ["attempt_created", "state_mutated", "cost_recorded"]
        elif case_id == "provider_state_follow_on_complete":
            expected_outbox = ["attempt_created", "state_mutated", "attempt_completed"]
        else:
            raise AssertionError(case_id)
        assert [event["kind"] for event in ledger.read_outbox(case_id)] == expected_outbox
        if case_id == "provider_state_follow_on_mutation":
            path = tmp_path / f"{case_id}.sqlite"
            conn = sqlite3.connect(path)
            try:
                conn.execute("UPDATE attempts SET state='active' WHERE task_id=?",
                             (case_id,))
                conn.commit()
            finally:
                conn.close()
            assert_active_authorization_fails_closed(ledger, first, path)
        return
    if case_id == "reserved_state_fail_closed":
        reserved = {"active", "closed", "orphaned", "terminal", "cancel_requested",
                    "completed", "cancelled", "cancelled_uncertain", "failed",
                    "provider_cancelled", "provider_failed", "provider_recovering",
                    "provider_dispatching", "provider_transitioning", "provider_complete",
                    "provider_error", "provider_timeout", "provider_budget",
                    "provider_authentication", "provider_configuration",
                    "provider_uncertain", "retryable_error", "side_effect_uncertainty",
                    "recover", "recovery", "dispatch", "transition"}
        allowed = sorted(PROVIDER_STATES)
        validator = _outbox_validator()
        for state in sorted(reserved):
            raw = {"outboxId": 999, "taskId": "task", "attemptId": "attempt", "epoch": 0,
                   "createdAtMs": 1, "kind": "state_mutated",
                   "payload": {"state": state, "payload": {}}}
            assert not validator.is_valid(raw), state
        for state in allowed:
            raw = {"outboxId": 999, "taskId": "task", "attemptId": "attempt", "epoch": 0,
                   "createdAtMs": 1, "kind": "state_mutated",
                   "payload": {"state": state, "payload": {}}}
            assert validator.is_valid(raw), state
        script = r'''
import { ResilienceOutboxEventSchema } from './packages/contracts/dist/index.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const vectors = JSON.parse(input);
for (const state of vectors.forbidden) {
  const event = {
    outboxId: 999, taskId: 'task', attemptId: 'attempt', epoch: 0, createdAtMs: 1,
    kind: 'state_mutated', payload: { state, payload: {} },
  };
  if (ResilienceOutboxEventSchema.safeParse(event).success) {
    throw new Error(`${state}: forbidden state was accepted`);
  }
}
for (const state of vectors.allowed) {
  const event = {
    outboxId: 999, taskId: 'task', attemptId: 'attempt', epoch: 0, createdAtMs: 1,
    kind: 'state_mutated', payload: { state, payload: {} },
  };
  if (!ResilienceOutboxEventSchema.safeParse(event).success) {
    throw new Error(`${state}: allowed state was rejected`);
  }
}
        '''
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script], cwd=ROOT,
            input=json.dumps({"forbidden": sorted(reserved), "allowed": allowed}),
            capture_output=True, text=True,
        )
        assert result.returncode == 0, result.stdout + result.stderr

        task_id = "reserved-state-reuse"
        ledger, first = create(tmp_path, task=task_id)
        before_outbox = ledger.read_outbox(task_id)
        db_path = tmp_path / f"{task_id}.sqlite"
        conn = sqlite3.connect(db_path)
        try:
            # Every forbidden value must fail at the Python write boundary,
            # with the same untouched active row and outbox.
            for state in sorted(reserved):
                with pytest.raises(LedgerError):
                    ledger.mutate_state_if_active(first, state)
                assert ledger.get_active(task_id)["state"] == "active"
                assert ledger.read_outbox(task_id) == before_outbox

            # Reuse the same SQLite database while independently tampering
            # each state. Active authorization and transition must both fail
            # closed before any mutation is attempted.
            for state in sorted(reserved - {"active"}):
                conn.execute("UPDATE attempts SET state=? WHERE task_id=? AND epoch=0",
                             (state, task_id))
                conn.commit()
                with pytest.raises(CorruptLedger):
                    ledger.get_active(task_id)
                with pytest.raises(CorruptLedger):
                    ledger.transition_once(first, "p2", failure())
                assert ledger.read_outbox(task_id) == before_outbox
                assert conn.execute("SELECT state FROM attempts WHERE task_id=? AND epoch=0",
                                    (task_id,)).fetchone()[0] == state
                conn.execute("UPDATE attempts SET state='active' WHERE task_id=? AND epoch=0",
                             (task_id,))
                conn.commit()

            # The other mutation APIs are covered against representative
            # terminal/control/failure/timeout/auth/uncertainty values rather
            # than repeating every API for every forbidden spelling.
            representative_operations = [
                ("terminal", lambda: ledger.complete_if_active(first)),
                ("cancel_requested", lambda: ledger.mark_dispatch_attempted(first)),
                ("provider_error", lambda: ledger.append_event_if_active(first, "late")),
                ("provider_timeout", lambda: ledger.record_cost_if_active(first, 1)),
                ("provider_authentication", lambda: ledger.request_cancel_if_active(first)),
                ("side_effect_uncertainty", lambda: ledger.recover_pre_dispatch_if_active(first)),
            ]
            for state, operation in representative_operations:
                conn.execute("UPDATE attempts SET state=? WHERE task_id=? AND epoch=0",
                             (state, task_id))
                conn.commit()
                with pytest.raises(CorruptLedger):
                    operation()
                assert ledger.read_outbox(task_id) == before_outbox
                assert conn.execute("SELECT state FROM attempts WHERE task_id=? AND epoch=0",
                                    (task_id,)).fetchone()[0] == state
                conn.execute("UPDATE attempts SET state='active' WHERE task_id=? AND epoch=0",
                             (task_id,))
                conn.commit()
        finally:
            conn.close()

        # One long-lived ledger proves every allowlisted state can be written,
        # read back, and still authorize the next transition.
        allowed_task = "allowed-state-reuse"
        providers = tuple(f"p{index}" for index in range(len(allowed) + 1))
        allowed_ledger = AttemptLedger(tmp_path / f"{allowed_task}.sqlite")
        current = allowed_ledger.create_initial(
            allowed_task, make_plan(allowed_task, providers=providers,
                                    limit=len(providers) - 1),
        )
        for index, state in enumerate(allowed):
            assert allowed_ledger.mutate_state_if_active(current, state)["state"] == state
            assert allowed_ledger.get_active(allowed_task)["state"] == state
            successor = allowed_ledger.transition_once(current, providers[index + 1], failure())
            assert successor and successor["epoch"] == index + 1
            current = successor
        return
    if case_id == "post_terminal_event":
        task = "completed-reset"
        path = tmp_path / f"{task}.sqlite"
        ledger, current = create(tmp_path, task=task)
        assert ledger.complete_if_active(current)
        assert ledger.append_event_if_active(current, "late") is None
        reset_terminal_rows_to_active(path, task)
        assert_active_authorization_fails_closed(ledger, current, path)
        return
    ledger, old, current = transition(tmp_path)
    if case_id == "stale_event":
        result = ledger.append_event_if_active(old, "late", {"fact": 1})
    elif case_id == "stale_cost":
        result = ledger.record_cost_if_active(old, 1)
    elif case_id == "stale_dispatch":
        result = ledger.mark_dispatch_attempted(old)
    elif case_id == "stale_state":
        result = ledger.mutate_state_if_active(old, "provider_ready")
    elif case_id == "stale_cancel":
        result = ledger.request_cancel_if_active(old)
    elif case_id == "stale_complete":
        result = ledger.complete_if_active(old)
    elif case_id == "wrong_attempt":
        result = ledger.append_event_if_active(current | {"attemptId": "wrong"}, "late")
    elif case_id == "wrong_epoch":
        result = ledger.append_event_if_active(current | {"epoch": 99}, "late")
    elif case_id == "wrong_task":
        result = ledger.append_event_if_active(current | {"taskId": "other"}, "late")
    elif case_id == "closed_complete":
        result = ledger.complete_if_active(old)
    elif case_id == "repeated_dispatch":
        assert ledger.mark_dispatch_attempted(current)
        result = ledger.mark_dispatch_attempted(current)
    elif case_id == "post_terminal_cost":
        assert ledger.complete_if_active(current)
        result = ledger.record_cost_if_active(current, 1)
    else:
        raise AssertionError(case_id)
    assert result is None

def run_transition_case(tmp_path, case_id):
    if case_id == "limit_zero":
        ledger, first = create(tmp_path, limit=0)
        assert ledger.transition_once(first, "p2", failure()) is None
        return
    if case_id == "ordered_chain":
        ledger, first = create(tmp_path, providers=("p1", "p2", "p3"))
        assert ledger.transition_once(first, "p3", failure())["epoch"] == 1
        return
    if case_id == "immutable_privacy_binding":
        task = "privacy-authority"
        path = tmp_path / f"{task}.sqlite"
        ledger, first = create(tmp_path, task=task)
        coherent_plan_rewrite(path, lambda p: p.update({"privacyHash": "e" * 64}))
        assert_active_authorization_fails_closed(ledger, first, path)
        return
    if case_id == "immutable_policy_binding":
        task = "policy-authority"
        path = tmp_path / f"{task}.sqlite"
        ledger, first = create(tmp_path, task=task)
        coherent_plan_rewrite(path, lambda p: p.update({"policyHash": "e" * 64}))
        assert_active_authorization_fails_closed(ledger, first, path)
        return
    if case_id == "provider_identity_fact_tamper_rejected":
        task = "identity-row"
        path = tmp_path / f"{task}.sqlite"
        ledger, first = create(tmp_path, task=task)
        before = database_snapshot(path)
        before_outbox = ledger.read_outbox(task)
        conn = sqlite3.connect(path)
        try:
            conn.execute("UPDATE attempts SET provider_id='p2' WHERE task_id=? AND epoch=0",
                         (task,))
            conn.commit()
        finally:
            conn.close()
        tampered = database_snapshot(path)
        assert tampered != before
        with pytest.raises(CorruptLedger):
            ledger.get_active(task)
        with pytest.raises(CorruptLedger):
            ledger.append_event_if_active(first, "late")
        with pytest.raises(CorruptLedger):
            ledger.transition_once(first, "p2", failure())
        assert database_snapshot(path) == tampered
        assert ledger.read_outbox(task) == before_outbox

        fact_vectors = {
            "identity-json-malformed": "{",
            "identity-plan-hash-missing": json.dumps(
                {"providerId": "p1"}, separators=(",", ":")),
            "identity-plan-hash-malformed": json.dumps(
                {"providerId": "p1", "planHash": "BAD"}, separators=(",", ":")),
            "identity-plan-hash-tampered": json.dumps(
                {"providerId": "p1", "planHash": "e" * 64}, separators=(",", ":")),
            "identity-plan-hash-extra": json.dumps(
                {"providerId": "p1", "planHash": "e" * 64, "extra": 1},
                separators=(",", ":")),
        }
        for fact_task, encoded_payload in fact_vectors.items():
            fact_path = tmp_path / f"{fact_task}.sqlite"
            fact_ledger, fact_first = create(tmp_path, task=fact_task)
            conn = sqlite3.connect(fact_path)
            try:
                conn.execute(
                    "UPDATE outbox SET payload_json=? "
                    "WHERE task_id=? AND kind='attempt_created'",
                    (encoded_payload, fact_task),
                )
                conn.commit()
            finally:
                conn.close()
            assert_active_authorization_fails_closed(fact_ledger, fact_first, fact_path)

        duplicate_task = "identity-duplicate"
        duplicate_path = tmp_path / f"{duplicate_task}.sqlite"
        duplicate, duplicate_first = create(tmp_path, task=duplicate_task)
        duplicate_before = database_snapshot(duplicate_path)
        duplicate_payload = duplicate.read_outbox(duplicate_task)[0]["payload"]
        conn = sqlite3.connect(duplicate_path)
        try:
            conn.execute(
                "INSERT INTO outbox(task_id,attempt_id,epoch,kind,payload_json,created_at_ms) "
                "VALUES(?,?,0,'attempt_created',?,1)",
                (duplicate_task, duplicate_first["attemptId"],
                 json.dumps(duplicate_payload, separators=(",", ":"))),
            )
            conn.commit()
        finally:
            conn.close()
        duplicate_tampered = database_snapshot(duplicate_path)
        assert duplicate_tampered != duplicate_before
        with pytest.raises(CorruptLedger):
            duplicate.get_active(duplicate_task)
        with pytest.raises(CorruptLedger):
            duplicate.transition_once(duplicate_first, "p2", failure())
        assert database_snapshot(duplicate_path) == duplicate_tampered
        return
    if case_id == "immutable_grant_binding":
        task = "grant-authority"
        path = tmp_path / f"{task}.sqlite"
        ledger, first = create(tmp_path, task=task)
        coherent_plan_rewrite(path, lambda p: p.update({"grantHash": "e" * 64}))
        assert_active_authorization_fails_closed(ledger, first, path)
        return
    if case_id == "plan_tamper_rejected":
        budget_task = "coherent-budget"
        budget_path = tmp_path / f"{budget_task}.sqlite"
        budget = AttemptLedger(budget_path)
        budget_first = budget.create_initial(
            budget_task, make_plan(budget_task, budget=29, ceiling=10),
        )
        assert budget.transition_once(budget_first, "p2", failure()) is None
        coherent_plan_rewrite(
            budget_path,
            lambda plan: plan.update({"budgetMicroUsd": 30}),
            {"budget_micro_usd": 30},
        )
        assert_active_authorization_fails_closed(budget, budget_first, budget_path)

        chain_task = "coherent-provider-chain"
        chain_path = tmp_path / f"{chain_task}.sqlite"
        chain = AttemptLedger(chain_path)
        chain_first = chain.create_initial(
            chain_task, make_plan(chain_task, providers=("p1", "p2", "p3")),
        )
        def rewrite_chain(plan):
            plan["eligibleProviderIds"] = ["p1", "replacement", "p3"]
            plan["providerCeilings"]["replacement"] = plan["providerCeilings"].pop("p2")
        coherent_plan_rewrite(chain_path, rewrite_chain)
        assert_active_authorization_fails_closed(chain, chain_first, chain_path,
                                                 successor="replacement")

        ceiling_task = "coherent-successor-ceiling"
        ceiling_path = tmp_path / f"{ceiling_task}.sqlite"
        ceiling, ceiling_first = create(tmp_path, task=ceiling_task)
        coherent_plan_rewrite(
            ceiling_path,
            lambda plan: plan["providerCeilings"].update({"p2": 1}),
        )
        assert_active_authorization_fails_closed(ceiling, ceiling_first, ceiling_path)

        vectors = (("deadline_ms", 9_999_999_999_998),
                   ("transition_limit", 0),
                   ("budget_micro_usd", 0))
        for column, value in vectors:
            task = f"tamper-{column}"
            ledger, first = create(tmp_path, task=task)
            path = tmp_path / f"{task}.sqlite"
            conn = sqlite3.connect(path)
            try:
                conn.execute(f"UPDATE tasks SET {column}=? WHERE task_id=?", (value, task))
                conn.commit()
            finally:
                conn.close()
            assert_active_authorization_fails_closed(ledger, first, path)
        return
    if case_id == "circuit_successor":
        clock = [1_000_000]
        path = tmp_path / "circuit.sqlite"
        ledger = AttemptLedger(path, now_ms=lambda: clock[0])
        for index in range(3):
            task = f"circuit-{index}"
            first = ledger.create_initial(task, make_plan(task, providers=("p1", "p2", "p3")))
            second = ledger.transition_once(first, "p2", failure())
            assert second
            assert ledger.transition_once(second, "p3", failure())
        task = "circuit-final"
        first = ledger.create_initial(task, make_plan(task, providers=("p1", "p2", "p3")))
        before = database_snapshot(path)
        assert ledger.transition_once(first, "p2", failure()) is None
        assert database_snapshot(path) == before

        # Deleting or aging the diagnostic cache cannot reopen a circuit whose
        # three recent failures remain in authoritative transition facts.
        for statement in (
            "UPDATE circuit_failures SET failed_at_ms=1 WHERE provider_id='p2'",
            "DELETE FROM circuit_failures WHERE provider_id='p2'",
        ):
            conn = sqlite3.connect(path)
            try:
                conn.execute(statement)
                conn.commit()
            finally:
                conn.close()
            cache_tampered = database_snapshot(path)
            outbox_before = ledger.read_outbox()
            assert ledger.transition_once(first, "p2", failure()) is None
            assert database_snapshot(path) == cache_tampered
            assert ledger.read_outbox() == outbox_before

        # A one-sided rewind must be reconciled before the cutoff is applied.
        # This is the exact three-to-two bypass: three recent p2 predecessor
        # failures block, but rewinding one fact alone is corruption, not expiry.
        conn = sqlite3.connect(path)
        try:
            transition_rows = conn.execute(
                "SELECT outbox_id,task_id,attempt_id,epoch,payload_json "
                "FROM outbox WHERE kind='transitioned' ORDER BY outbox_id",
            ).fetchall()
            rewound = next(
                row for row in transition_rows
                if json.loads(row[4])["predecessorProviderId"] == "p2"
            )
            materialized_created_at = conn.execute(
                "SELECT created_at_ms FROM attempts "
                "WHERE task_id=? AND attempt_id=? AND epoch=?",
                (rewound[1], rewound[2], rewound[3]),
            ).fetchone()[0]
            assert materialized_created_at == clock[0]
            conn.execute(
                "UPDATE outbox SET created_at_ms=? WHERE outbox_id=?",
                (clock[0] - 300_001, rewound[0]),
            )
            conn.commit()
        finally:
            conn.close()
        rewind_tampered = database_snapshot(path)
        rewind_outbox = ledger.read_outbox()
        with pytest.raises(CorruptLedger):
            ledger.transition_once(first, "p2", failure())
        assert database_snapshot(path) == rewind_tampered
        assert ledger.read_outbox() == rewind_outbox

        # Forged cache rows cannot close a clean circuit with no authoritative
        # p2 predecessor failures.
        forged_path = tmp_path / "forged-cache.sqlite"
        forged = AttemptLedger(forged_path, now_ms=lambda: clock[0])
        forged_first = forged.create_initial(
            "forged-target", make_plan("forged-target", providers=("p1", "p2")),
        )
        conn = sqlite3.connect(forged_path)
        try:
            conn.executemany(
                "INSERT INTO circuit_failures(provider_id,failed_at_ms) VALUES('p2',?)",
                [(clock[0],), (clock[0],), (clock[0],)],
            )
            conn.commit()
        finally:
            conn.close()
        assert forged.transition_once(forged_first, "p2", failure())

        def circuit_result(name, failure_times, target_time):
            local_clock = [failure_times[0] if failure_times else target_time]
            local_path = tmp_path / f"{name}.sqlite"
            local = AttemptLedger(local_path, now_ms=lambda: local_clock[0])
            for index, failed_at in enumerate(failure_times):
                local_clock[0] = failed_at
                seed_task = f"{name}-seed-{index}"
                seed = local.create_initial(
                    seed_task, make_plan(seed_task, providers=("p1", "p2", "p3")),
                )
                p2_attempt = local.transition_once(seed, "p2", failure())
                assert p2_attempt
                assert local.transition_once(p2_attempt, "p3", failure())
            local_clock[0] = target_time
            target_task = f"{name}-target"
            target = local.create_initial(
                target_task, make_plan(target_task, providers=("p1", "p2")),
            )
            return local.transition_once(target, "p2", failure())

        boundary_now = 2_000_000
        assert circuit_result(
            "threshold-two", [boundary_now - 1, boundary_now - 1], boundary_now,
        )
        # The three witnesses still satisfy the inclusive five-minute
        # qualification boundary, but their 60-second open interval has
        # expired by target time.
        assert circuit_result(
            "exact-five-minutes", [boundary_now - 300_000] * 3, boundary_now,
        )
        assert circuit_result(
            "older-than-five-minutes", [boundary_now - 300_001] * 3, boundary_now,
        )

        def edit_identity_payload(kind, edit):
            def tamper(conn, seed, successor):
                payload = json.loads(conn.execute(
                    "SELECT payload_json FROM outbox WHERE task_id=? AND kind=?",
                    (seed["taskId"], kind),
                ).fetchone()[0])
                edit(payload)
                conn.execute(
                    "UPDATE outbox SET payload_json=? WHERE task_id=? AND kind=?",
                    (json.dumps(payload, separators=(",", ":")), seed["taskId"], kind),
                )
            return tamper

        def update_attempt(column, expression, which):
            def tamper(conn, seed, successor):
                selected = seed if which == "predecessor" else successor
                conn.execute(
                    f"UPDATE attempts SET {column}={expression} "
                    "WHERE task_id=? AND attempt_id=? AND epoch=?",
                    (selected["taskId"], selected["attemptId"], selected["epoch"]),
                )
            return tamper

        def update_identity_time(kind, expression):
            def tamper(conn, seed, successor):
                conn.execute(
                    f"UPDATE outbox SET created_at_ms={expression} "
                    "WHERE task_id=? AND kind=?",
                    (seed["taskId"], kind),
                )
            return tamper

        def update_successor_time_pair(expression):
            fact_tamper = update_identity_time("transitioned", expression)
            row_tamper = update_attempt("created_at_ms", expression, "successor")
            def tamper(conn, seed, successor):
                fact_tamper(conn, seed, successor)
                row_tamper(conn, seed, successor)
            return tamper

        # Every recent transition identity is an integrity pair: the sole
        # identity fact and exact materialized attempt tuple must independently
        # agree on provider and creation time before circuit authorization.
        identity_tampers = (
            ("missing-predecessor-provider", edit_identity_payload(
                "transitioned", lambda payload: payload.pop("predecessorProviderId"))),
            ("transition-predecessor-provider-rewrite", edit_identity_payload(
                "transitioned", lambda payload: payload.update(
                    {"predecessorProviderId": "p3"}))),
            ("successor-fact-provider-rewrite", edit_identity_payload(
                "transitioned", lambda payload: payload.update(
                    {"successorProviderId": "p3"}))),
            ("successor-row-provider-rewrite", update_attempt(
                "provider_id", "'p3'", "successor")),
            ("successor-fact-created-at-rewrite", update_identity_time(
                "transitioned", "created_at_ms+1")),
            ("successor-fact-below-cutoff", update_identity_time(
                "transitioned", "2699999")),
            ("successor-row-created-at-rewrite", update_attempt(
                "created_at_ms", "created_at_ms+1", "successor")),
            ("successor-fact-future", update_identity_time(
                "transitioned", "9000000")),
            ("successor-row-below-cutoff", update_attempt(
                "created_at_ms", "2699999", "successor")),
            ("successor-row-future", update_attempt(
                "created_at_ms", "9000000", "successor")),
            ("successor-authority-future", update_successor_time_pair("9000000")),
            ("predecessor-fact-provider-rewrite", edit_identity_payload(
                "attempt_created", lambda payload: payload.update({"providerId": "p3"}))),
            ("predecessor-row-provider-rewrite", update_attempt(
                "provider_id", "'p3'", "predecessor")),
        )
        for suffix, tamper_identity in identity_tampers:
            corrupt_clock = [3_000_000]
            corrupt_path = tmp_path / f"circuit-{suffix}.sqlite"
            corrupt = AttemptLedger(corrupt_path, now_ms=lambda: corrupt_clock[0])
            seed_task = f"{suffix}-seed"
            seed = corrupt.create_initial(
                seed_task, make_plan(seed_task, providers=("p1", "p2")),
            )
            successor = corrupt.transition_once(seed, "p2", failure())
            assert successor
            conn = sqlite3.connect(corrupt_path)
            try:
                tamper_identity(conn, seed, successor)
                conn.commit()
            finally:
                conn.close()
            corrupt_clock[0] += 10
            target_task = f"{suffix}-target"
            target = corrupt.create_initial(
                target_task, make_plan(target_task, providers=("p1", "p2")),
            )
            tampered = database_snapshot(corrupt_path)
            outbox_before = corrupt.read_outbox()
            with pytest.raises(CorruptLedger):
                corrupt.transition_once(target, "p2", failure())
            assert database_snapshot(corrupt_path) == tampered
            assert corrupt.read_outbox() == outbox_before
        return
    ledger, first = create(tmp_path, providers=("p1", "p2", "p3"))
    if case_id == "valid_transition":
        assert ledger.mutate_state_if_active(first, "streaming")
        second = ledger.transition_once(first, "p2", failure())
        assert second and second["epoch"] == 1
    elif case_id == "nonretryable_class":
        assert ledger.transition_once(first, "p2", failure("configuration", False)) is None
    elif case_id == "retryable_flag_false":
        with pytest.raises(LedgerError):
            ledger.transition_once(first, "p2", failure("retryable", False))
    elif case_id == "unknown_successor":
        assert ledger.transition_once(first, "unknown", failure()) is None
    elif case_id == "earlier_successor":
        second = ledger.transition_once(first, "p2", failure())
        assert second
        before = ledger.read_outbox("task")
        assert ledger.transition_once(second, "p1", failure()) is None
        assert ledger.read_outbox("task") == before
    elif case_id == "same_successor":
        assert first["providerId"] == "p1"
        assert ledger.transition_once(first, "p1", failure()) is None
    elif case_id == "dispatch_barrier":
        assert ledger.mark_dispatch_attempted(first)
        assert ledger.append_event_if_active(first, "progress", {"step": 1})
        assert ledger.mutate_state_if_active(first, "streaming")
        assert ledger.record_cost_if_active(first, 3)
        active = ledger.get_active("task")
        assert active["dispatchAttempted"] and active["state"] == "streaming"
        assert ledger.transition_once(first, "p2", failure()) is None
        path = tmp_path / "task.sqlite"
        conn = sqlite3.connect(path)
        try:
            conn.execute("UPDATE attempts SET dispatch_attempted=0 WHERE task_id='task'")
            conn.commit()
        finally:
            conn.close()
        assert_active_authorization_fails_closed(ledger, first, path)

        malformed_vectors = {
            "malformed-dispatch": ("dispatch_attempted", {"extra": 1}, None),
            "malformed-cancel": ("cancel_requested", {"extra": 1}, None),
            "malformed-completion": ("attempt_completed", {"outcome": "completed"}, None),
            "malformed-recovery": ("pre_dispatch_recovered", {"extra": 1}, None),
            "malformed-state": ("state_mutated", {"state": "provider_ready"}, None),
            "tuple-mismatch-barrier": ("cancel_requested", {}, "wrong-attempt"),
        }
        for task_id, (kind, payload, attempt_override) in malformed_vectors.items():
            malformed_path = tmp_path / f"{task_id}.sqlite"
            malformed, malformed_first = create(tmp_path, task=task_id)
            conn = sqlite3.connect(malformed_path)
            try:
                conn.execute(
                    "INSERT INTO outbox(task_id,attempt_id,epoch,kind,payload_json,created_at_ms) "
                    "VALUES(?,?,0,?,?,1)",
                    (task_id, attempt_override or malformed_first["attemptId"], kind,
                     json.dumps(payload, separators=(",", ":"))),
                )
                conn.commit()
            finally:
                conn.close()
            assert_active_read_transition_fail_closed(
                malformed, malformed_first, malformed_path,
            )

        barrier_payloads = {
            "dispatch_attempted": {},
            "cancel_requested": {},
            "attempt_completed": {
                "outcome": "completed", "actualCostMicroUsd": None, "known": False,
            },
            "pre_dispatch_recovered": {},
        }
        for kind, payload in barrier_payloads.items():
            task_id = f"duplicate-{kind}"
            duplicate_path = tmp_path / f"{task_id}.sqlite"
            duplicate, duplicate_first = create(tmp_path, task=task_id)
            if kind == "dispatch_attempted":
                assert duplicate.mark_dispatch_attempted(duplicate_first)
            elif kind == "cancel_requested":
                assert duplicate.request_cancel_if_active(duplicate_first)
                reset_terminal_rows_to_active(duplicate_path, task_id)
            elif kind == "attempt_completed":
                assert duplicate.complete_if_active(duplicate_first)
                reset_terminal_rows_to_active(duplicate_path, task_id)
            else:
                assert duplicate.recover_pre_dispatch_if_active(duplicate_first)
                reset_terminal_rows_to_active(duplicate_path, task_id)
            conn = sqlite3.connect(duplicate_path)
            try:
                conn.execute(
                    "INSERT INTO outbox(task_id,attempt_id,epoch,kind,payload_json,created_at_ms) "
                    "VALUES(?,?,0,?,?,1)",
                    (task_id, duplicate_first["attemptId"], kind,
                     json.dumps(payload, separators=(",", ":"))),
                )
                conn.commit()
            finally:
                conn.close()
            assert_active_read_transition_fail_closed(
                duplicate, duplicate_first, duplicate_path,
            )
    elif case_id == "cancel_barrier":
        assert ledger.request_cancel_if_active(first)
        assert ledger.transition_once(first, "p2", failure()) is None
        path = tmp_path / "task.sqlite"
        reset_terminal_rows_to_active(path, "task")
        assert_active_authorization_fails_closed(ledger, first, path)
    elif case_id == "deadline_barrier":
        clock = [1000]
        path = tmp_path / "deadline.sqlite"
        ledger = AttemptLedger(path, now_ms=lambda: clock[0])
        first = ledger.create_initial("deadline", make_plan("deadline", deadline=1001))
        clock[0] = 1001
        assert ledger.transition_once(first, "p2", failure()) is None
    elif case_id == "right_consumed":
        second = ledger.transition_once(first, "p2", failure())
        assert second and ledger.transition_once(first, "p3", failure()) is None
    elif case_id == "exact_tuple":
        second = ledger.transition_once(ActiveTuple(first["taskId"], first["attemptId"], 0),
                                        "p2", failure())
        assert second
    elif case_id == "historical_epoch_rejected":
        second = ledger.transition_once(first, "p2", failure())
        assert second and ledger.append_event_if_active(first, "late") is None
        path = tmp_path / "task.sqlite"
        conn = sqlite3.connect(path)
        try:
            conn.execute("UPDATE attempts SET state='active' WHERE task_id='task' AND epoch=0")
            conn.commit()
        finally:
            conn.close()
        assert_active_authorization_fails_closed(ledger, second, path, successor="p3")

        for suffix in ("failure", "closed-at", "transition-failure", "late-state",
                       "historical-dispatch"):
            task_id = f"historical-{suffix}"
            history_path = tmp_path / f"{task_id}.sqlite"
            history, predecessor = create(
                tmp_path, task=task_id, providers=("p1", "p2", "p3"),
            )
            successor = history.transition_once(predecessor, "p2", failure())
            assert successor
            conn = sqlite3.connect(history_path)
            try:
                if suffix == "failure":
                    conn.execute(
                        "UPDATE attempts SET failure_json=? WHERE task_id=? AND epoch=0",
                        (json.dumps(failure() | {"code": "altered"},
                                    separators=(",", ":")), task_id),
                    )
                elif suffix == "closed-at":
                    conn.execute(
                        "UPDATE attempts SET closed_at_ms=NULL WHERE task_id=? AND epoch=0",
                        (task_id,),
                    )
                elif suffix == "transition-failure":
                    payload = json.loads(conn.execute(
                        "SELECT payload_json FROM outbox WHERE task_id=? AND kind='transitioned'",
                        (task_id,),
                    ).fetchone()[0])
                    payload["failure"]["code"] = "altered"
                    conn.execute(
                        "UPDATE outbox SET payload_json=? WHERE task_id=? AND kind='transitioned'",
                        (json.dumps(payload, separators=(",", ":")), task_id),
                    )
                elif suffix == "late-state":
                    conn.execute(
                        "INSERT INTO outbox(task_id,attempt_id,epoch,kind,payload_json,created_at_ms) "
                        "VALUES(?,?,0,'state_mutated',?,1)",
                        (task_id, predecessor["attemptId"], json.dumps(
                            {"state": "provider_ready", "payload": {}},
                            separators=(",", ":"))),
                    )
                else:
                    conn.execute(
                        "UPDATE attempts SET dispatch_attempted=1 WHERE task_id=? AND epoch=0",
                        (task_id,),
                    )
                    conn.execute(
                        "INSERT INTO outbox(task_id,attempt_id,epoch,kind,payload_json,created_at_ms) "
                        "VALUES(?,?,0,'dispatch_attempted','{}',1)",
                        (task_id, predecessor["attemptId"]),
                    )
                conn.commit()
            finally:
                conn.close()
            assert_active_read_transition_fail_closed(
                history, successor, history_path, successor="p3",
            )
    elif case_id == "circuit_successor":
        raise AssertionError("handled above")
    else:
        raise AssertionError(case_id)


def run_budget_case(tmp_path, case_id):
    if case_id in {"negative_actual_rejected", "float_actual_rejected"}:
        ledger, current = create(tmp_path, task=case_id)
        value = -1 if case_id == "negative_actual_rejected" else 1.5
        with pytest.raises(InvalidPlanError):
            ledger.record_cost_if_active(current, value)
        return
    if case_id == "negative_ceiling_rejected":
        ledger = AttemptLedger(tmp_path / "bad.sqlite")
        plan = make_plan("bad")
        plan["providerCeilings"]["p1"] = -1
        with pytest.raises(InvalidPlanError):
            ledger.create_initial("bad", plan)
        return
    if case_id == "zero_ceiling_allowed":
        ledger, first = create(tmp_path, ceiling=0, budget=0)
        assert ledger.transition_once(first, "p2", failure())
        return
    if case_id == "unlimited_budget_overflow_rejected":
        max_safe = (1 << 53) - 1
        plan = make_plan("overflow-transition", providers=("p1", "p2"), budget=None, ceiling=1)
        plan["providerCeilings"] = {"p1": max_safe, "p2": max_safe}
        ledger = AttemptLedger(tmp_path / "overflow-transition.sqlite")
        first = ledger.create_initial("overflow-transition", plan)
        before = database_snapshot(tmp_path / "overflow-transition.sqlite")
        with pytest.raises(CorruptLedger):
            ledger.transition_once(first, "p2", failure())
        assert database_snapshot(tmp_path / "overflow-transition.sqlite") == before
        assert ledger.get_active("overflow-transition")["epoch"] == 0
        assert ledger.get_task("overflow-transition")["reserved_micro_usd"] == max_safe

        def saturated_successor(task):
            path = tmp_path / f"{task}.sqlite"
            saturated = AttemptLedger(path)
            saturated_plan = make_plan(task, providers=("p1", "p2"),
                                       budget=None, ceiling=0)
            initial = saturated.create_initial(task, saturated_plan)
            assert saturated.record_cost_if_active(initial, max_safe)
            successor = saturated.transition_once(initial, "p2", failure())
            assert successor is not None
            assert saturated.get_task(task)["reserved_micro_usd"] == max_safe
            return saturated, successor, path

        cost_ledger, cost_attempt, cost_path = saturated_successor("overflow-cost")
        cost_before = database_snapshot(cost_path)
        cost_outbox_before = cost_ledger.read_outbox("overflow-cost")
        with pytest.raises(CorruptLedger):
            cost_ledger.record_cost_if_active(cost_attempt, 1)
        assert database_snapshot(cost_path) == cost_before
        assert cost_ledger.read_outbox("overflow-cost") == cost_outbox_before
        assert cost_ledger.get_active("overflow-cost")["attemptId"] == cost_attempt["attemptId"]
        assert cost_ledger.get_task("overflow-cost")["reserved_micro_usd"] == max_safe

        complete_ledger, complete_attempt, complete_path = saturated_successor("overflow-complete")
        complete_before = database_snapshot(complete_path)
        complete_outbox_before = complete_ledger.read_outbox("overflow-complete")
        with pytest.raises(CorruptLedger):
            complete_ledger.complete_if_active(complete_attempt, actual_cost_micro_usd=1)
        assert database_snapshot(complete_path) == complete_before
        assert complete_ledger.read_outbox("overflow-complete") == complete_outbox_before
        assert complete_ledger.get_active("overflow-complete")["attemptId"] == complete_attempt["attemptId"]
        assert complete_ledger.get_task("overflow-complete")["reserved_micro_usd"] == max_safe

        conn = sqlite3.connect(tmp_path / "overflow-transition.sqlite")
        try:
            task_reserved = conn.execute(
                "SELECT reserved_micro_usd FROM tasks WHERE task_id='overflow-transition'").fetchone()[0]
            attempt_values = conn.execute(
                "SELECT reserved_micro_usd,actual_cost_micro_usd FROM attempts "
                "WHERE task_id='overflow-transition'").fetchone()
        finally:
            conn.close()
        assert 0 <= task_reserved <= max_safe
        assert 0 <= attempt_values[0] <= max_safe
        assert attempt_values[1] is None
        return
    if case_id == "known_lower_cost_headroom":
        ledger, first = create(tmp_path, budget=20)
        assert ledger.record_cost_if_active(first, 0)
        assert ledger.transition_once(first, "p2", failure())
        return
    if case_id == "known_zero_cost":
        ledger, first = create(tmp_path, budget=10)
        assert ledger.record_cost_if_active(first, 0)
        assert ledger.get_task("task")["reserved_micro_usd"] == 0
        return
    if case_id == "unknown_cost_no_headroom":
        ledger, first = create(tmp_path, budget=29)
        assert ledger.record_cost_if_active(first, None)
        assert ledger.transition_once(first, "p2", failure()) is None
        return
    if case_id == "cost_fact_headroom_tamper_rejected":
        task = "cost-headroom"
        path = tmp_path / f"{task}.sqlite"
        ledger, first = create(tmp_path, task=task, budget=20)
        before = database_snapshot(path)
        before_outbox = ledger.read_outbox(task)
        conn = sqlite3.connect(path)
        try:
            conn.execute(
                "UPDATE attempts SET actual_cost_known=1,actual_cost_micro_usd=0,"
                "reserved_micro_usd=0 WHERE task_id=? AND epoch=0",
                (task,),
            )
            conn.execute("UPDATE tasks SET reserved_micro_usd=0 WHERE task_id=?", (task,))
            conn.commit()
        finally:
            conn.close()
        tampered = database_snapshot(path)
        assert tampered != before
        with pytest.raises(CorruptLedger):
            ledger.get_active(task)
        with pytest.raises(CorruptLedger):
            ledger.record_cost_if_active(first, 0)
        with pytest.raises(CorruptLedger):
            ledger.transition_once(first, "p2", failure())
        assert database_snapshot(path) == tampered
        assert ledger.read_outbox(task) == before_outbox

        unsafe_task = "cost-fact-unsafe"
        unsafe_path = tmp_path / f"{unsafe_task}.sqlite"
        unsafe, unsafe_first = create(tmp_path, task=unsafe_task)
        assert unsafe.record_cost_if_active(unsafe_first, 3)
        assert unsafe.record_cost_if_active(unsafe_first, 4)
        unsafe_before = database_snapshot(unsafe_path)
        conn = sqlite3.connect(unsafe_path)
        try:
            first_cost_id = conn.execute(
                "SELECT min(outbox_id) FROM outbox WHERE task_id=? AND kind='cost_recorded'",
                (unsafe_task,),
            ).fetchone()[0]
            conn.execute(
                "UPDATE outbox SET payload_json=? WHERE outbox_id=?",
                (json.dumps({"actualCostMicroUsd": (1 << 53), "known": True},
                            separators=(",", ":")), first_cost_id),
            )
            conn.commit()
        finally:
            conn.close()
        unsafe_tampered = database_snapshot(unsafe_path)
        assert unsafe_tampered != unsafe_before
        with pytest.raises(CorruptLedger):
            unsafe.get_active(unsafe_task)
        with pytest.raises(CorruptLedger):
            unsafe.append_event_if_active(unsafe_first, "late")
        with pytest.raises(CorruptLedger):
            unsafe.transition_once(unsafe_first, "p2", failure())
        assert database_snapshot(unsafe_path) == unsafe_tampered
        return
    if case_id == "cost_outbox_atomic":
        ledger, first = create(tmp_path, task="record-overspend", budget=10)
        assert ledger.record_cost_if_active(first, 11)
        active = ledger.get_active("record-overspend")
        assert active["actualCostMicroUsd"] == 11
        assert active["reservedMicroUsd"] == 11
        assert ledger.get_task("record-overspend")["reserved_micro_usd"] == 11
        assert ledger.transition_once(first, "p2", failure()) is None
        events = ledger.read_outbox("record-overspend")
        assert [event["kind"] for event in events] == ["attempt_created", "cost_recorded"]

        completed, completed_first = create(tmp_path, task="complete-overspend", budget=10)
        assert completed.complete_if_active(completed_first, actual_cost_micro_usd=11)
        assert completed.get_active("complete-overspend") is None
        assert completed.get_task("complete-overspend")["reserved_micro_usd"] == 11
        attempts = completed.list_attempts("complete-overspend")
        assert attempts[0]["actualCostMicroUsd"] == 11
        completed_events = completed.read_outbox("complete-overspend")
        assert [event["kind"] for event in completed_events] == ["attempt_created", "attempt_completed"]
        assert completed_events[-1]["payload"] == {
            "actualCostMicroUsd": 11, "known": True, "outcome": "completed"
        }

        known, known_first = create(tmp_path, task="complete-known-cost", budget=10)
        assert known.record_cost_if_active(known_first, 7)
        assert known.complete_if_active(known_first, actual_cost_micro_usd=None)
        known_attempt = known.list_attempts("complete-known-cost")[0]
        assert known_attempt["actualCostKnown"] is True
        assert known_attempt["actualCostMicroUsd"] == 7
        assert known_attempt["reservedMicroUsd"] == 7
        known_events = known.read_outbox("complete-known-cost")
        assert known_events[-1]["kind"] == "attempt_completed"
        assert known_events[-1]["payload"] == {
            "actualCostMicroUsd": 7, "known": True, "outcome": "completed"
        }
        return
    if case_id == "budget_exact_fit":
        budget = 30
    elif case_id == "budget_one_micro_short":
        budget = 29
    else:
        raise AssertionError(case_id)
    ledger, first = create(tmp_path, budget=budget)
    result = ledger.transition_once(first, "p2", failure())
    if case_id == "budget_exact_fit":
        assert result
    else:
        assert result is None


def run_crash_case(tmp_path, case_id):
    if case_id == "future_version_fail_closed":
        path = tmp_path / "future.sqlite"
        AttemptLedger(path)
        conn = sqlite3.connect(path)
        conn.execute("UPDATE ledger_meta SET value='999' WHERE key='schema_version'")
        conn.commit()
        conn.close()
        with pytest.raises(UnsupportedSchemaVersion):
            AttemptLedger(path)
        return
    if case_id == "no_down_migration":
        path = tmp_path / "old.sqlite"
        AttemptLedger(path)
        conn = sqlite3.connect(path)
        conn.execute("UPDATE ledger_meta SET value='0' WHERE key='schema_version'")
        conn.commit()
        conn.close()
        with pytest.raises(UnsupportedSchemaVersion):
            AttemptLedger(path)
        assert path.exists()
        return
    if case_id == "crash_create_rollback":
        path = tmp_path / "create-crash.sqlite"
        run_crashing_child(path, "create")
        reopened = AttemptLedger(path)
        assert reopened.get_task("task") is None
        assert reopened.list_attempts("task") == []
        assert reopened.read_outbox("task") == []
        return

    ledger, first = create(tmp_path)
    path = tmp_path / "task.sqlite"
    if case_id == "crash_dispatch_rollback":
        run_crashing_child(path, "dispatch")
        reopened = AttemptLedger(path)
        assert reopened.get_active("task")["dispatchAttempted"] is False
        assert [event["kind"] for event in reopened.read_outbox("task")] == ["attempt_created"]
    elif case_id == "crash_transition_rollback":
        run_crashing_child(path, "transition")
        reopened = AttemptLedger(path)
        assert reopened.get_active("task")["epoch"] == 0
        assert reopened.get_task("task")["transitions_used"] == 0
        assert len(reopened.list_attempts("task")) == 1
        assert [event["kind"] for event in reopened.read_outbox("task")] == ["attempt_created"]
    elif case_id == "crash_cost_rollback":
        run_crashing_child(path, "cost")
        reopened = AttemptLedger(path)
        active = reopened.get_active("task")
        assert not active["actualCostKnown"] and active["reservedMicroUsd"] == 10
        assert reopened.get_task("task")["reserved_micro_usd"] == 10
        assert [event["kind"] for event in reopened.read_outbox("task")] == ["attempt_created"]
    elif case_id == "crash_completion_rollback":
        run_crashing_child(path, "completion")
        reopened = AttemptLedger(path)
        assert reopened.get_active("task")["state"] == "active"
        assert reopened.get_task("task")["status"] == "running"
        assert reopened.list_attempts("task")[0]["state"] == "active"
        assert [event["kind"] for event in reopened.read_outbox("task")] == ["attempt_created"]
    elif case_id == "crash_recovery_outbox_rollback":
        run_crashing_child(path, "recovery")
        reopened = AttemptLedger(path)
        assert reopened.get_active("task")["state"] == "active"
        assert reopened.get_task("task")["status"] == "running"
        assert reopened.list_attempts("task")[0]["state"] == "active"
        conn = sqlite3.connect(path)
        try:
            assert conn.execute("SELECT status FROM active_control WHERE task_id='task'").fetchone()[0] == "active"
            assert conn.execute("SELECT count(*) FROM outbox WHERE task_id='task'").fetchone()[0] == 1
        finally:
            conn.close()
        assert [event["kind"] for event in reopened.read_outbox("task")] == ["attempt_created"]
    elif case_id == "pre_dispatch_orphan":
        before = ledger.read_outbox("task")
        assert ledger.recover_pre_dispatch_if_active(first | {"attemptId": "wrong"}) is None
        assert ledger.read_outbox("task") == before
        assert ledger.recover_pre_dispatch_if_active(first)["state"] == "orphaned"
        assert ledger.get_active("task") is None
        assert ledger.read_outbox("task")[-1]["kind"] == "pre_dispatch_recovered"
        reset_terminal_rows_to_active(path, "task")
        assert_active_authorization_fails_closed(ledger, first, path)
    elif case_id == "post_dispatch_terminal_uncertain":
        ledger.mark_dispatch_attempted(first)
        result = ledger.recover_pre_dispatch_if_active(first)
        assert result and result["state"] == "terminal"
        assert result["outcome"] == "cancelled_uncertain"
        assert ledger.get_active("task") is None
        assert ledger.get_task("task")["status"] == "cancelled_uncertain"
        assert ledger.list_attempts("task")[0]["state"] == "terminal"
        assert ledger.read_outbox("task")[-1]["kind"] == "attempt_completed"
        reset_terminal_rows_to_active(path, "task")
        assert_active_authorization_fails_closed(ledger, first, path)

        clock = [1000]
        expired_path = tmp_path / "expired-recovery.sqlite"
        expired = AttemptLedger(expired_path, now_ms=lambda: clock[0])
        expired_first = expired.create_initial("expired-recovery", make_plan("expired-recovery", deadline=1001))
        clock[0] = 1001
        expired_result = expired.recover_pre_dispatch_if_active(expired_first)
        assert expired_result and expired_result["outcome"] == "cancelled_uncertain"
        assert expired.get_active("expired-recovery") is None
        assert expired.get_task("expired-recovery")["status"] == "cancelled_uncertain"
        assert expired.list_attempts("expired-recovery")[0]["state"] == "terminal"
    elif case_id in {"late_orphan_event", "late_orphan_cost", "late_orphan_complete"}:
        ledger.recover_pre_dispatch_if_active(first)
        result = {
            "late_orphan_event": lambda: ledger.append_event_if_active(first, "late"),
            "late_orphan_cost": lambda: ledger.record_cost_if_active(first, 1),
            "late_orphan_complete": lambda: ledger.complete_if_active(first),
        }[case_id]()
        assert result is None
    elif case_id == "history_readable":
        ledger.transition_once(first, "p2", failure())
        assert len(AttemptLedger(path).list_attempts("task")) == 2
    else:
        raise AssertionError(case_id)

def run_contention_case(tmp_path, case_id):
    path = tmp_path / f"{case_id}.sqlite"
    seed = AttemptLedger(path)
    first = seed.create_initial("task", make_plan("task"))
    if case_id == "duplicate_create_race":
        def create_again(_):
            try:
                return AttemptLedger(path).create_initial("task", make_plan("task"))
            except TaskAlreadyExists:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(create_again, range(2)))
        assert results == [None, None]
    elif case_id == "transition_race_single_winner":
        def go(_):
            return AttemptLedger(path).transition_once(first, "p2", failure())
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(go, range(2)))
        assert sum(result is not None for result in results) == 1
    elif case_id == "stale_writer_rejected":
        AttemptLedger(path).transition_once(first, "p2", failure())
        assert AttemptLedger(path).append_event_if_active(first, "late") is None
    elif case_id == "two_readers_same_active":
        with ThreadPoolExecutor(max_workers=2) as pool:
            values = list(pool.map(lambda _: AttemptLedger(path).get_active("task"), range(2)))
        assert values[0]["attemptId"] == values[1]["attemptId"]
    elif case_id == "two_dispatchers_one_mark":
        def mark(_):
            return AttemptLedger(path).mark_dispatch_attempted(first)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(mark, range(2)))
        assert sum(result is not None for result in results) == 1
    elif case_id == "two_cost_writers_atomic":
        def cost(value):
            return AttemptLedger(path).record_cost_if_active(first, value)
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(cost, (3, 4)))
        active = AttemptLedger(path).get_active("task")
        assert active["actualCostKnown"] and active["reservedMicroUsd"] in {3, 4}
    elif case_id == "subprocess_reopen":
        code = (
            "import sys; sys.path.insert(0, r'engineÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹s/hermes_kernel'); "
            "from mcp_wrapper.attempt_ledger import AttemptLedger, IMMUTABLE_PLAN_SCHEMA_VERSION; "
            "print(f'{AttemptLedger(sys.argv[1]).schema_version()}:{IMMUTABLE_PLAN_SCHEMA_VERSION}')"
        ).replace("engineÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹s", "engines")
        result = subprocess.run([sys.executable, "-c", code, str(path)],
                                capture_output=True, text=True, check=True)
        assert result.stdout.strip() == "2:1"
    elif case_id == "wal_enabled":
        conn = sqlite3.connect(path)
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        conn.close()
    else:
        raise AssertionError(case_id)


def run_contract_case(tmp_path, case_id):
    known = {"typescript_plan_schema", "typescript_tuple_schema", "typescript_failure_schema",
             "typescript_outbox_schema", "generated_ts_schema", "generated_python_schema",
             "schema_names_match", "schema_json_parseable", "strict_extra_plan", "hash_shape"}
    if case_id not in known:
        raise AssertionError(case_id)
    ts_dir = ROOT / "packages" / "contracts" / "generated"
    py_dir = ROOT / "engines" / "hermes_kernel" / "mcp_wrapper" / "schemas"
    names = {"ClientCommand.json", "ConnectFrame.json", "GatewayEvent.json",
             "GatewayRequest.json", "ResilienceActiveTuple.json",
             "ResilienceImmutablePlan.json", "ResilienceNormalizedFailure.json",
             "ResilienceOutboxEvent.json"}
    if case_id in {"generated_ts_schema", "generated_python_schema", "schema_names_match"}:
        directory = ts_dir if case_id == "generated_ts_schema" else py_dir
        assert {path.name for path in directory.glob("*.json")} >= names
        if case_id == "schema_names_match":
            assert {path.name for path in ts_dir.glob("*.json")} == {path.name for path in py_dir.glob("*.json")}
    elif case_id == "schema_json_parseable":
        for directory in (ts_dir, py_dir):
            for path in directory.glob("*.json"):
                json.loads(path.read_text(encoding="utf-8-sig"))
        from jsonschema import Draft202012Validator
        schema = json.loads((ts_dir / "ResilienceOutboxEvent.json").read_text(encoding="utf-8-sig"))
        validator = Draft202012Validator(schema)
        base = {"outboxId": 1, "taskId": "task", "attemptId": "attempt", "epoch": 0,
                "createdAtMs": 1,
                "kind": "provider_event", "payload": {"eventKind": "progress", "payload": {}}}
        raw = json.loads(json.dumps(base))
        raw["payload"]["payload"]["message"] = "raw provider error"
        assert not validator.is_valid(raw)
        safe = json.loads(json.dumps(base))
        safe["payload"]["payload"]["message"] = {"sha256": "a" * 64, "length": 17}
        assert validator.is_valid(safe)
    elif case_id == "strict_extra_plan":
        plan = make_plan("strict")
        plan["credentials"] = "reject"
        with pytest.raises(InvalidPlanError):
            AttemptLedger(tmp_path / "strict.sqlite").create_initial("strict", plan)
    elif case_id == "hash_shape":
        plan = make_plan("hash")
        plan["privacyHash"] = "short"
        with pytest.raises(InvalidPlanError):
            AttemptLedger(tmp_path / "hash.sqlite").create_initial("hash", plan)
    elif case_id in {"typescript_plan_schema", "typescript_tuple_schema",
                      "typescript_failure_schema", "typescript_outbox_schema"}:
        source = (ROOT / "packages" / "contracts" / "src" / "resilience.ts").read_text()
        expected = {
            "typescript_plan_schema": "ResilienceImmutablePlanSchema",
            "typescript_tuple_schema": "ResilienceActiveTupleSchema",
            "typescript_failure_schema": "ResilienceNormalizedFailureSchema",
            "typescript_outbox_schema": "ResilienceOutboxEventSchema",
        }[case_id]
        assert expected in source
    else:
        raise AssertionError(case_id)


def run_outbox_case(tmp_path, case_id):
    ledger, first = create(tmp_path)
    if case_id == "initial_outbox_order":
        assert [e["kind"] for e in ledger.read_outbox("task")] == ["attempt_created"]
    elif case_id == "transition_outbox_order":
        ledger.transition_once(first, "p2", failure())
        assert [e["kind"] for e in ledger.read_outbox("task")] == ["attempt_created", "transitioned"]
    elif case_id == "event_outbox_order":
        secret = "provider error: bearer super-secret"
        ledger.append_event_if_active(first, "progress", {"step": 1, "message": secret,
                                                             "detail": "raw detail"})
        conn = sqlite3.connect(tmp_path / "task.sqlite")
        try:
            raw_rows = [row[0] + row[1] for row in conn.execute(
                "SELECT payload_json, event_kind FROM provider_events")]
            raw_rows += [row[0] + row[1] for row in conn.execute(
                "SELECT payload_json, kind FROM outbox")]
        finally:
            conn.close()
        assert all(secret not in raw for raw in raw_rows)
        event = ledger.read_outbox("task")[-1]
        assert event["kind"] == "provider_event"
        assert event["payload"]["payload"]["message"]["length"] == len(secret)
        assert len(event["payload"]["payload"]["message"]["sha256"]) == 64
    elif case_id == "cost_outbox_order":
        ledger.record_cost_if_active(first, 2)
        assert ledger.read_outbox("task")[-1]["kind"] == "cost_recorded"
    elif case_id == "dedupe_replay":
        seen = []
        assert ledger.project_outbox(seen.append) == 1
        assert ledger.project_outbox(seen.append) == 0
        assert len(seen) == 1
    elif case_id == "projection_rebuild":
        ledger.append_event_if_active(first, "progress", {"step": 1})
        facts = [event["kind"] for event in ledger.read_outbox("task")]
        assert facts == ["attempt_created", "provider_event"]
    else:
        raise AssertionError(case_id)


def run_secret_case(tmp_path, case_id):
    if case_id == "no_credential_plan_rows":
        ledger = AttemptLedger(tmp_path / "secret.sqlite")
        plan = make_plan("secret")
        plan["apiKeyEnv"] = "NOT_A_CREDENTIAL_VALUE"
        with pytest.raises(InvalidPlanError):
            ledger.create_initial("secret", plan)
    elif case_id == "no_raw_error_failure":
        ledger, first = create(tmp_path)
        secret = "raw provider exception with credential=super-secret"
        with pytest.raises(LedgerError):
            ledger.append_event_if_active(first, "progress", {"apiKey": secret})
        ledger.append_event_if_active(first, "progress", {"message": secret})
        with pytest.raises(LedgerError):
            ledger.append_event_if_active(first, "raw message")
        with pytest.raises(LedgerError):
            ledger.transition_once(first, "p2", {"failureClass": "retryable",
                                                "code": "raw error message", "retryable": True})
        conn = sqlite3.connect(tmp_path / "task.sqlite")
        try:
            raw = "".join(row[0] for row in conn.execute("SELECT payload_json FROM provider_events"))
            raw += "".join(row[0] for row in conn.execute("SELECT payload_json FROM outbox"))
        finally:
            conn.close()
        assert secret not in raw
        event = ledger.read_outbox("task")[-1]
        assert event["payload"]["payload"]["message"]["length"] == len(secret)
    elif case_id == "import_has_no_io":
        source = (ROOT / "engines" / "hermes_kernel" / "mcp_wrapper" /
                  "attempt_ledger.py").read_text()
        assert "AttemptLedger(" not in source.split("class AttemptLedger", 1)[0]
    elif case_id == "deterministic_fake_fixture":
        raw = "provider output: deterministic fake error with secret=do-not-persist"
        payload = {"message": raw, "nested": [raw, {"step": 1}]}
        ledgers = []
        for index in range(2):
            ledger = AttemptLedger(tmp_path / f"fixture-{index}.sqlite")
            first = ledger.create_initial("fixture", make_plan("fixture"))
            assert ledger.append_event_if_active(first, "progress", payload)
            conn = sqlite3.connect(tmp_path / f"fixture-{index}.sqlite")
            try:
                persisted = [row[0] for row in conn.execute(
                    "SELECT payload_json FROM provider_events WHERE task_id='fixture'")]
                outboxed = [row[0] for row in conn.execute(
                    "SELECT payload_json FROM outbox WHERE task_id='fixture' AND kind='provider_event'")]
            finally:
                conn.close()
            ledgers.append((persisted, outboxed))
        assert ledgers[0] == ledgers[1]
        assert raw not in json.dumps(ledgers, sort_keys=True)
    else:
        raise AssertionError(case_id)


def run_manifest_case(tmp_path, request, case_id):
    state = getattr(request.config, "_torqclaw_p0", None)
    assert state is not None
    if case_id == "declared_count_108":
        assert state["manifest_pairs"] == CASES
        assert len(state["manifest_pairs"]) == MANIFEST["declared"] == 108
    elif case_id == "unique_case_ids":
        assert len(state["collected_pairs"]) == len(set(state["collected_pairs"]))
        assert len(state["items"]) == len(set(state["items"]))
    elif case_id == "all_cases_executed":
        assert state["collected_pairs"] == state["manifest_pairs"]
        assert len(state["items"]) == 108
    elif case_id == "no_skips_or_duplicates":
        assert all(not item.get_closest_marker("skip") and
                   not item.get_closest_marker("skipif") and
                   not item.get_closest_marker("xfail")
                   for item in request.session.items
                   if str(item.fspath).endswith("test_p0_resilience.py"))
        assert len(state["collected_pairs"]) == 108
        assert len(set(state["collected_pairs"])) == 108
        assert "1,000" in MANIFEST["claim"]
    else:
        raise AssertionError(case_id)


def _outbox_validator():
    return _outbox_validators()[0]


def _outbox_validators():
    from jsonschema import Draft202012Validator

    paths = [
        ROOT / "packages" / "contracts" / "generated" / "ResilienceOutboxEvent.json",
        ROOT / "engines" / "hermes_kernel" / "mcp_wrapper" / "schemas" /
        "ResilienceOutboxEvent.json",
    ]
    return [Draft202012Validator(json.loads(path.read_text(encoding="utf-8-sig")))
            for path in paths]


def test_actual_python_outbox_variants_validate_generated_schema(tmp_path):
    """Every read_outbox variant must satisfy the checked-in external contract."""
    validators = _outbox_validators()
    validator = validators[0]
    providers = ("deepseek/deepseek-v4-flash", "qwen/qwen3-max")

    def collect(name, operation):
        ledger = AttemptLedger(tmp_path / f"{name}.sqlite")
        first = ledger.create_initial(name, make_plan(name, providers=providers))
        operation(ledger, first)
        produced = ledger.read_outbox(name)
        created = produced[0]
        task = ledger.get_task(name)
        assert created["kind"] == "attempt_created"
        assert set(created["payload"]) == {"providerId", "planHash"}
        assert created["payload"]["planHash"] == task["plan_hash"]
        assert created["payload"]["planHash"] == hashlib.sha256(
            json.dumps(task["plan"], sort_keys=True, separators=(",", ":"),
                       ensure_ascii=True).encode()
        ).hexdigest()
        return produced

    events = []
    events += collect("created", lambda _ledger, _first: None)
    events += collect("provider-event", lambda ledger, first:
                      ledger.append_event_if_active(first, "progress", {"step": 1}))
    events += collect("dispatch", lambda ledger, first: ledger.mark_dispatch_attempted(first))
    events += collect("cost", lambda ledger, first: ledger.record_cost_if_active(first, 3))
    events += collect("state", lambda ledger, first:
                      ledger.mutate_state_if_active(first, "provider_ready"))
    events += collect("cancel", lambda ledger, first: ledger.request_cancel_if_active(first))
    events += collect("complete", lambda ledger, first:
                      ledger.complete_if_active(first, actual_cost_micro_usd=3))
    events += collect("recovery", lambda ledger, first:
                      ledger.recover_pre_dispatch_if_active(first))

    transitioned = AttemptLedger(tmp_path / "transition.sqlite")
    first = transitioned.create_initial("transition", make_plan("transition", providers=providers))
    assert transitioned.transition_once(
        first, providers[1], failure()
    ) is not None
    transition_events = transitioned.read_outbox("transition")
    events += transition_events

    transition_event = next(
        event for event in transition_events if event["kind"] == "transitioned"
    )
    assert set(transition_event["payload"]) == {
        "predecessor", "predecessorProviderId", "successorProviderId", "failure",
    }
    assert transition_event["payload"]["predecessorProviderId"] == providers[0]

    assert {event["kind"] for event in events} == {
        "attempt_created", "provider_event", "dispatch_attempted", "cost_recorded",
        "state_mutated", "cancel_requested", "attempt_completed", "transitioned",
        "pre_dispatch_recovered",
    }
    for event in events:
        for generated_validator in validators:
            errors = sorted(generated_validator.iter_errors(event),
                            key=lambda error: list(error.path))
            assert not errors, f"{event['kind']} rejected: {errors[0].message}"
        assert event["createdAtMs"] > 0

    created_event = next(event for event in events if event["kind"] == "attempt_created")
    structurally_invalid_outbox = []
    for payload in (
        {"providerId": created_event["payload"]["providerId"]},
        {"providerId": created_event["payload"]["providerId"], "planHash": "BAD"},
        {**created_event["payload"], "extra": 1},
    ):
        candidate = json.loads(json.dumps(created_event))
        candidate["payload"] = payload
        structurally_invalid_outbox.append(candidate)
        assert all(not generated_validator.is_valid(candidate)
                   for generated_validator in validators)

    for payload in (
        {
            key: value for key, value in transition_event["payload"].items()
            if key != "predecessorProviderId"
        },
        {**transition_event["payload"], "predecessorProviderId": "bad provider"},
    ):
        candidate = json.loads(json.dumps(transition_event))
        candidate["payload"] = payload
        structurally_invalid_outbox.append(candidate)
        assert all(not generated_validator.is_valid(candidate)
                   for generated_validator in validators)

    script = r'''
import { ResilienceOutboxEventSchema } from './packages/contracts/dist/index.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const vectors = JSON.parse(input);
for (const event of vectors.valid) {
  const result = ResilienceOutboxEventSchema.safeParse(event);
  if (!result.success) throw new Error(`${event.kind}: ${result.error.message}`);
}
for (const event of vectors.invalid) {
  if (ResilienceOutboxEventSchema.safeParse(event).success) {
    throw new Error('invalid outbox event was accepted');
  }
}
    '''
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script], cwd=ROOT,
        input=json.dumps({"valid": events, "invalid": structurally_invalid_outbox}),
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr

    for key in ("ERROR", "Authorization"):
        raw = {
            "outboxId": 999, "taskId": "task", "attemptId": "attempt", "epoch": 0,
            "createdAtMs": 1, "kind": "provider_event",
            "payload": {"eventKind": "progress", "payload": {key: {"sha256": "a" * 64, "length": 1}}},
        }
        assert not validator.is_valid(raw)
    guarded = AttemptLedger(tmp_path / "uppercase-keys.sqlite")
    first = guarded.create_initial("uppercase-keys", make_plan("uppercase-keys"))
    for key in ("ERROR", "Authorization"):
        with pytest.raises(LedgerError):
            guarded.append_event_if_active(first, "progress", {key: "blocked"})
    for state in ("active", "closed", "provider_cancelled", "provider_failed",
                  "provider_recovering", "provider_dispatching", "provider_transitioning"):
        raw = {
            "outboxId": 1000, "taskId": "task", "attemptId": "attempt", "epoch": 0,
            "createdAtMs": 1, "kind": "state_mutated",
            "payload": {"state": state, "payload": {}},
        }
        assert not validator.is_valid(raw)


def test_python_and_generated_schema_share_boundary_vectors(tmp_path):
    """Maxima and cross-field invariants are rejected consistently at both boundaries."""
    from jsonschema import Draft202012Validator

    plan_schema = json.loads((ROOT / "packages" / "contracts" / "generated" /
                              "ResilienceImmutablePlan.json").read_text(encoding="utf-8-sig"))
    validator = Draft202012Validator(plan_schema)
    max_safe = (1 << 53) - 1

    accepted = make_plan("t" * 256, providers=("deepseek/deepseek-v4-flash",))
    accepted["chainId"] = "c" * 128
    accepted["privacyClass"] = "p" * 128
    accepted["featurePolicyRevision"] = "f" * 128
    accepted["planRevision"] = "r" * 128
    accepted["taskDeadlineMs"] = max_safe
    accepted["attemptTimeoutMs"] = max_safe
    accepted["budgetMicroUsd"] = max_safe
    accepted["providerCeilings"]["deepseek/deepseek-v4-flash"] = max_safe
    assert validator.is_valid(accepted)
    AttemptLedger(tmp_path / "accepted.sqlite").create_initial("t" * 256, accepted)

    max_provider = "p" + "x" * 127
    max_provider_plan = make_plan("provider-max", providers=(max_provider,))
    assert validator.is_valid(max_provider_plan)
    AttemptLedger(tmp_path / "provider-max.sqlite").create_initial("provider-max", max_provider_plan)

    for provider in ("API-KEY", "Provider-Error"):
        invalid_provider = make_plan("provider-security", providers=(provider,))
        assert not validator.is_valid(invalid_provider)
        with pytest.raises(InvalidPlanError):
            AttemptLedger(tmp_path / f"{provider}.sqlite").create_initial("provider-security", invalid_provider)

    astral_task = make_plan("😀" * 200)
    assert not validator.is_valid(astral_task)
    with pytest.raises(InvalidPlanError):
        AttemptLedger(tmp_path / "astral-task.sqlite").create_initial("😀" * 200, astral_task)
    astral_chain = make_plan("astral-chain")
    astral_chain["chainId"] = "😀" * 100
    assert not validator.is_valid(astral_chain)
    with pytest.raises(InvalidPlanError):
        AttemptLedger(tmp_path / "astral-chain.sqlite").create_initial("astral-chain", astral_chain)

    vectors = [
        ("taskId", "t" * 257, "t" * 257),
        ("chainId", "c" * 129, "task-chain-overflow"),
        ("privacyClass", "p" * 129, "task-privacy-overflow"),
        ("featurePolicyRevision", "f" * 129, "task-feature-revision-overflow"),
        ("planRevision", "r" * 129, "task-revision-overflow"),
        ("taskDeadlineMs", max_safe + 1, "task-deadline-overflow"),
        ("attemptTimeoutMs", max_safe + 1, "task-timeout-overflow"),
        ("budgetMicroUsd", max_safe + 1, "task-budget-overflow"),
    ]
    for field, value, task_id in vectors:
        invalid = make_plan(task_id)
        invalid[field] = value
        assert not validator.is_valid(invalid), field
        with pytest.raises(InvalidPlanError):
            AttemptLedger(tmp_path / f"{field}.sqlite").create_initial(task_id, invalid)

    duplicate = make_plan("duplicate", providers=("p1", "p1"))
    assert not validator.is_valid(duplicate)
    with pytest.raises(InvalidPlanError):
        AttemptLedger(tmp_path / "duplicate.sqlite").create_initial("duplicate", duplicate)

    excessive_transition = make_plan("excessive", providers=("p1", "p2"), limit=2)
    assert not validator.is_valid(excessive_transition)
    with pytest.raises(InvalidPlanError):
        AttemptLedger(tmp_path / "excessive.sqlite").create_initial("excessive", excessive_transition)

    missing_ceiling = make_plan("missing-ceiling")
    del missing_ceiling["providerCeilings"]["p2"]
    # Dynamic key coverage is intentionally carried by the explicit parity
    # metadata and enforced by the Python/Zod validators.
    assert plan_schema["x-torqclaw-refinements"]["providerCeilingsCoverEligibleProviderIds"]
    with pytest.raises(InvalidPlanError):
        AttemptLedger(tmp_path / "missing-ceiling.sqlite").create_initial("missing-ceiling", missing_ceiling)

    bad_provider = make_plan("bad-provider", providers=("deepseek/deepseek-v4-flash", "bad provider"))
    assert not validator.is_valid(bad_provider)
    with pytest.raises(InvalidPlanError):
        AttemptLedger(tmp_path / "bad-provider.sqlite").create_initial("bad-provider", bad_provider)

    credential_provider = make_plan("credential-provider", providers=("api-key",))
    assert not validator.is_valid(credential_provider)
    with pytest.raises(InvalidPlanError):
        AttemptLedger(tmp_path / "credential-provider.sqlite").create_initial("credential-provider", credential_provider)

    too_long_provider = make_plan("provider-overflow", providers=("p" + "x" * 128,))
    assert not validator.is_valid(too_long_provider)
    with pytest.raises(InvalidPlanError):
        AttemptLedger(tmp_path / "provider-overflow.sqlite").create_initial("provider-overflow", too_long_provider)

    assert AttemptLedger._tuple({"taskId": "t" * 256, "attemptId": "a" * 128, "epoch": max_safe})
    with pytest.raises(LedgerError):
        AttemptLedger._tuple({"taskId": "t", "attemptId": "a" * 129, "epoch": 0})
    with pytest.raises(LedgerError):
        AttemptLedger._tuple({"taskId": "t", "attemptId": "a", "epoch": max_safe + 1})


def test_built_zod_schema_enforces_plan_parity_vectors():
    """Execute the built Zod schema, not only its JSON Schema projection."""
    max_safe = (1 << 53) - 1
    accepted = make_plan("t" * 256, providers=("deepseek/deepseek-v4-flash",))
    accepted.update({
        "chainId": "c" * 128,
        "privacyClass": "p" * 128,
        "featurePolicyRevision": "f" * 128,
        "planRevision": "r" * 128,
        "taskDeadlineMs": max_safe,
        "attemptTimeoutMs": max_safe,
        "budgetMicroUsd": max_safe,
    })
    accepted["providerCeilings"]["deepseek/deepseek-v4-flash"] = max_safe

    duplicate = make_plan("zod-duplicate", providers=("p1", "p1"))
    missing_ceiling = make_plan("zod-missing-ceiling")
    del missing_ceiling["providerCeilings"]["p2"]
    excessive_transition = make_plan("zod-excessive", providers=("p1", "p2"), limit=2)
    bad_provider = make_plan("zod-bad-provider", providers=("bad provider",))
    security_provider = make_plan("zod-security-provider", providers=("API-KEY",))
    astral_task = make_plan("😀" * 200)
    astral_chain = make_plan("zod-astral-chain")
    astral_chain["chainId"] = "😀" * 100
    astral_revision = make_plan("zod-astral-revision")
    astral_revision["planRevision"] = "😀" * 100
    vectors = [
        {"name": "accepted_maxima", "plan": accepted, "expected": True},
        {"name": "duplicate_providers", "plan": duplicate, "expected": False},
        {"name": "missing_ceiling", "plan": missing_ceiling, "expected": False},
        {"name": "excessive_transition", "plan": excessive_transition, "expected": False},
        {"name": "bad_provider", "plan": bad_provider, "expected": False},
        {"name": "security_provider", "plan": security_provider, "expected": False},
        {"name": "astral_task", "plan": astral_task, "expected": False},
        {"name": "astral_chain", "plan": astral_chain, "expected": False},
        {"name": "astral_revision", "plan": astral_revision, "expected": False},
    ]
    script = r'''
import { ResilienceImmutablePlanSchema, ResilienceOutboxEventSchema } from './packages/contracts/dist/index.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const vectors = JSON.parse(input);
for (const vector of vectors) {
  const actual = ResilienceImmutablePlanSchema.safeParse(vector.plan).success;
  if (actual !== vector.expected) {
    throw new Error(`${vector.name}: expected ${vector.expected}, got ${actual}`);
  }
}
for (const key of ['ERROR', 'Authorization']) {
  const event = {
    outboxId: 999, taskId: 'task', attemptId: 'attempt', epoch: 0, createdAtMs: 1,
    kind: 'provider_event',
    payload: { eventKind: 'progress', payload: { [key]: { sha256: 'a'.repeat(64), length: 1 } } },
  };
  if (ResilienceOutboxEventSchema.safeParse(event).success) {
    throw new Error(`${key}: uppercase sensitive key was accepted`);
  }
}
for (const state of ['active', 'closed', 'provider_cancelled', 'provider_failed',
  'provider_recovering', 'provider_dispatching', 'provider_transitioning']) {
  const event = {
    outboxId: 1000, taskId: 'task', attemptId: 'attempt', epoch: 0, createdAtMs: 1,
    kind: 'state_mutated', payload: { state, payload: {} },
  };
  if (ResilienceOutboxEventSchema.safeParse(event).success) {
    throw new Error(`${state}: control-like state was accepted`);
  }
}
    '''
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script], cwd=ROOT, input=json.dumps(vectors),
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
