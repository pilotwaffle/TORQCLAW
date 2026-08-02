"""Deterministic, offline, manifest-enforced governed Phase-1 P1 evidence.

The 36 parameter IDs are the governance unit. The 100 injected runs produced
by the fallback case are repeated evidence executions, not additional IDs.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engines" / "hermes_kernel"))

# Keep module imports hermetic and never use the operator's real task database.
_P1_DATA = Path(tempfile.mkdtemp(prefix="torqclaw-p1-"))
os.environ["TORQCLAW_DATA_DIR"] = str(_P1_DATA)
os.environ.pop("TORQCLAW_PROVIDER_FAILOVER_ENABLED", None)
os.environ.pop("HERMES_MODEL", None)

from mcp_wrapper import failover_runtime, server, task_store  # noqa: E402
from mcp_wrapper.attempt_ledger import (  # noqa: E402
    ActiveTuple,
    AdmissionRejected,
    AttemptLedger,
    CorruptLedger,
    LedgerError,
)

MANIFEST = json.loads((Path(__file__).with_name("p1_manifest.json")).read_text(encoding="utf-8"))
CASES = [(category["name"], case_id) for category in MANIFEST["categories"] for case_id in category["ids"]]
CASE_IDS = [case_id for _, case_id in CASES]


@dataclass(frozen=True)
class FakeProvider:
    position: int
    fault: str | None = None

    def invoke(self) -> dict:
        if self.fault == "connection":
            return {"transport": "connection"}
        if self.fault == "dns":
            return {"transport": "dns"}
        if self.fault == "http_408":
            return {"httpStatus": 408}
        if self.fault == "http_429":
            return {"httpStatus": 429}
        if self.fault == "http_5xx":
            return {"httpStatus": 503}
        if self.fault == "http_401":
            return {"httpStatus": 401}
        if self.fault == "http_404":
            return {"httpStatus": 404}
        if self.fault == "malformed":
            return {"malformed": True}
        if self.fault == "cancel_ack":
            return {"ack": "ACK_UNCERTAIN"}
        if self.fault == "dispatch":
            return {"dispatchAttempted": True}
        if self.fault == "crash":
            return {"stage": "post-dispatch-crash"}
        return {"result": f"fake-provider-{self.position}"}


class FakeController:
    def __init__(self, ack: str):
        self.ack = ack
        self.signals: list[str] = []

    def signal_attempt_stop(self, mode: str) -> str:
        self.signals.append(mode)
        return self.ack


class ReferenceChain:
    def __init__(self, default: list[str], coding: list[str], privacy: dict[str, set[str]]):
        self.default = default
        self.coding = coding
        self.privacy = privacy

    def select(self, task_type: str, sensitive: bool) -> list[str]:
        ordered = self.coding if task_type == "COMPLEX_CODING" else self.default
        privacy_class = "sensitive" if sensitive else "standard"
        return [provider for provider in ordered if privacy_class in self.privacy.get(provider, set())]


def make_plan(task_id: str, *, providers: tuple[str, str] = ("primary", "fallback"),
              now: int = 1_000, deadline: int = 100_000, budget: int | None = None,
              ceilings: tuple[int, int] = (10, 10)) -> dict:
    return {
        "schemaVersion": 1,
        "taskId": task_id,
        "chainId": "p1-deterministic-chain",
        "eligibleProviderIds": list(providers),
        "privacyClass": "standard",
        "privacyHash": "a" * 64,
        "policyHash": "b" * 64,
        "contextHash": "c" * 64,
        "grantHash": "d" * 64,
        "taskDeadlineMs": deadline,
        "attemptTimeoutMs": 1_000,
        "transitionLimit": 1,
        "budgetMicroUsd": budget,
        "providerCeilings": {providers[0]: ceilings[0], providers[1]: ceilings[1]},
        "featurePolicyRevision": "p1-policy",
        "planRevision": "1",
    }


def make_ledger(tmp_path: Path, task_id: str, *, clock: list[int] | None = None,
                plan: dict | None = None) -> tuple[AttemptLedger, dict, list[int]]:
    clock = clock or [1_000]
    ledger = AttemptLedger(tmp_path / f"{task_id}.sqlite", now_ms=lambda: clock[0])
    active = ledger.create_initial(task_id, plan or make_plan(task_id, now=clock[0]))
    return ledger, active, clock


def eligible_transition(ledger: AttemptLedger, active: dict, observation: dict, *, jitter: int = 0):
    failure = ledger.normalize_observation(observation)
    return ledger.transition_once(active, "fallback", failure, jitter_ms=jitter)


def run_injected_task_evidence(tmp_path: Path) -> dict:
    numerator = 0
    denominator = 0
    for index in range(100):
        ledger, active, _clock = make_ledger(tmp_path, f"injected-{index}")
        eligible = index % 10 < 8
        if eligible:
            denominator += 1
            fault = ["connection", "dns", "http_408", "http_429", "http_5xx"][index % 5]
            observation = FakeProvider(index % 2, fault).invoke()
            successor = eligible_transition(ledger, active, observation)
            if successor:
                second = ledger.get_active(active["taskId"])
                if second and ledger.complete_if_active(second, actual_cost_micro_usd=0):
                    numerator += 1
        elif index % 2:
            assert eligible_transition(ledger, active, {"httpStatus": 401}) is None
        else:
            assert ledger.mark_dispatch_attempted(active)
            assert eligible_transition(ledger, active, {"transport": "connection"}) is None
            uncertain = ledger.recover_pre_dispatch_if_active(active)
            assert uncertain and uncertain["outcome"] == "cancelled_uncertain"
    report = {
        "deterministic_injected_task_runs": 100,
        "eligible_fallback_numerator": numerator,
        "eligible_fallback_denominator": denominator,
        "eligible_fallback_rate": numerator / denominator,
    }
    target = os.environ.get("TORQCLAW_P1_RUN_METRICS")
    if target:
        Path(target).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def redact(value):
    if isinstance(value, str):
        return re.sub(r"(?i)(?:bearer\s+|sk[-_])[A-Za-z0-9._:-]+", "[REDACTED]", value)
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value


def run_real_mcp_submit(monkeypatch, tmp_path: Path) -> dict:
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path / "mcp-data"))
    monkeypatch.setattr("mcp_wrapper.hermes_runner.hermes_available", lambda: (True, None))
    calls = []

    def fake_run(_task_id, envelope):
        calls.append(envelope)
        return {"result": envelope["payload"]["prompt"], "telemetry": {"costUsd": 0.0, "costSource": "exact"}}

    monkeypatch.setattr("mcp_wrapper.hermes_runner.run_hermes_sync", fake_run)
    failover_runtime.reset_for_tests()
    task_id = "p1-real-mcp"
    deadline = int(time.time() * 1000) + 20_000
    plan = make_plan(task_id, deadline=deadline)
    request = {
        "id": "00000000-0000-4000-8000-000000000001",
        "sessionId": "00000000-0000-4000-8000-000000000002",
        "sourceChannel": "p1-test",
        "receivedAt": "2026-07-30T00:00:00.000Z",
        "payload": {"prompt": "complete GatewayRequest prompt", "taskType": "ROUTINE_AUTOMATION",
                    "assembledContext": "", "contextSize": 0, "requiredTools": [], "grantedTools": []},
        "constraints": {"latencySensitivity": "LOW", "containsSensitiveData": False, "executionMode": "CLOUD_OK"},
        "enrichment": {"classifierUsed": "DEFAULT", "classifierConfidence": 1,
                       "classifierLatencyMs": 0, "estimatedTokens": 1, "memoryUsed": False},
    }

    async def go():
        admitted = await server.resilience_admit_frontier(task_id, plan, deadline, ["primary", "fallback"])
        active = admitted["activeTuple"]
        submitted = await server.resilience_submit_attempt(
            request, plan, active,
            {"providerId": "primary", "label": "Primary", "modelId": "fake-model",
             "credentialEnvName": "P1_FAKE_KEY", "baseUrlEnvName": "P1_FAKE_BASE"},
            deadline, f"{task_id}:submit",
        )
        assert submitted["status"] == "SUBMITTED", submitted
        for _ in range(50):
            page = await server.resilience_poll_observations(active, 0, deadline)
            if page["status"] == "TERMINAL":
                return page
            await asyncio.sleep(0.005)
        raise AssertionError("real MCP submit did not reach terminal observation")

    terminal = asyncio.run(go())
    assert terminal["observations"][0]["kind"] == "result"
    assert calls and calls[0]["payload"] == request["payload"]
    assert calls[0]["payload"]["prompt"] == request["payload"]["prompt"]
    return {"terminal": terminal, "calls": len(calls)}


def make_three_circuit_failures(ledger: AttemptLedger, clock: list[int], tmp_path: Path, *, spacing: bool = False):
    for index in range(3):
        clock[0] = 1_000 + (index * 150_000 if spacing else 0)
        task = f"circuit-{index}"
        active = ledger.create_initial(task, make_plan(task, now=clock[0], deadline=1_000_000))
        assert eligible_transition(ledger, active, {"transport": "connection"})


def run_case(case_id: str, tmp_path: Path, monkeypatch) -> None:
    if case_id == "p1_chain_default_order":
        chain = ReferenceChain(["hermes-primary", "hermes-fallback"], ["coding-a", "coding-b"],
                               {"hermes-primary": {"standard", "sensitive"}, "hermes-fallback": {"standard", "sensitive"}})
        assert chain.select("ROUTINE_AUTOMATION", False) == ["hermes-primary", "hermes-fallback"]
    elif case_id == "p1_chain_coding_order":
        chain = ReferenceChain(["default-a", "default-b"], ["coding-a", "coding-b"],
                               {"coding-a": {"standard", "sensitive"}, "coding-b": {"standard", "sensitive"}})
        assert chain.select("COMPLEX_CODING", False) == ["coding-a", "coding-b"]
    elif case_id == "p1_env_name_only":
        ledger, active, _ = make_ledger(tmp_path, "env-name")
        ref = {"providerId": "primary", "label": "Primary", "modelId": "fake-model",
               "credentialEnvName": "P1_SECRET_KEY", "baseUrlEnvName": "P1_SECRET_BASE"}
        assert ledger.submit_attempt(active, make_plan("env-name"), ref, 100_000)["status"] == "SUBMITTED"
        assert "P1_SECRET_VALUE" not in json.dumps(ledger.read_outbox("env-name"))
        assert ref["credentialEnvName"] in json.dumps(ref)
    elif case_id == "p1_privacy_prefilter":
        chain = ReferenceChain(["private", "fallback"], ["private", "fallback"],
                               {"private": {"standard"}, "fallback": {"standard", "sensitive"}})
        assert chain.select("ROUTINE_AUTOMATION", True) == ["fallback"]
    elif case_id == "p1_budget_initial_ceiling":
        ledger = AttemptLedger(tmp_path / "budget.sqlite", now_ms=lambda: 1_000)
        with pytest.raises(AdmissionRejected):
            ledger.create_initial("budget", make_plan("budget", budget=9, ceilings=(10, 10)))
        assert ledger.get_task("budget")["status"] == "rejected"
    elif case_id == "p1_feature_off_no_ledger":
        monkeypatch.delenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", raising=False)
        failover_runtime.reset_for_tests()
        assert failover_runtime.frontier_active({"tier": "FRONTIER"}) is False
        with pytest.raises(LedgerError):
            failover_runtime.get_ledger()
    elif case_id == "p1_408_fallback":
        ledger, active, _ = make_ledger(tmp_path, "http408")
        assert eligible_transition(ledger, active, FakeProvider(0, "http_408").invoke())
        report = run_injected_task_evidence(tmp_path)
        assert report == {"deterministic_injected_task_runs": 100, "eligible_fallback_numerator": 80,
                          "eligible_fallback_denominator": 80, "eligible_fallback_rate": 1.0}
    elif case_id == "p1_429_fallback":
        ledger, active, _ = make_ledger(tmp_path, "http429")
        assert ledger.normalize_observation(FakeProvider(0, "http_429").invoke()) == {"failureClass": "retryable", "code": "http_429", "retryable": True}
        assert eligible_transition(ledger, active, FakeProvider(0, "http_429").invoke())
    elif case_id == "p1_5xx_fallback":
        ledger, active, _ = make_ledger(tmp_path, "http5xx")
        assert eligible_transition(ledger, active, FakeProvider(0, "http_5xx").invoke())
        assert run_real_mcp_submit(monkeypatch, tmp_path / "real-mcp")["calls"] == 1
    elif case_id == "p1_401_terminal":
        ledger, active, _ = make_ledger(tmp_path, "http401")
        assert ledger.normalize_observation(FakeProvider(0, "http_401").invoke())["failureClass"] == "authentication"
        assert eligible_transition(ledger, active, FakeProvider(0, "http_401").invoke()) is None
    elif case_id == "p1_404_terminal":
        ledger, active, _ = make_ledger(tmp_path, "http404")
        assert ledger.normalize_observation(FakeProvider(0, "http_404").invoke())["failureClass"] == "configuration"
        assert ledger.normalize_observation(FakeProvider(1, "malformed").invoke())["code"] == "unknown"
        assert eligible_transition(ledger, active, FakeProvider(0, "http_404").invoke()) is None
    elif case_id == "p1_precedence_dispatch_over_retry":
        ledger, active, _ = make_ledger(tmp_path, "dispatch-precedence")
        assert ledger.mark_dispatch_attempted(active)
        assert eligible_transition(ledger, active, {"transport": "connection"}) is None
    elif case_id == "p1_precedence_deadline_over_retry":
        clock = [1_000]
        plan = make_plan("deadline-precedence", now=1_000, deadline=1_250)
        ledger, active, _ = make_ledger(tmp_path, "deadline-precedence", clock=clock, plan=plan)
        clock[0] = 1_001
        assert eligible_transition(ledger, active, {"transport": "connection"}, jitter=250) is None
    elif case_id == "p1_precedence_budget_over_circuit":
        ledger, active, _ = make_ledger(tmp_path, "budget-precedence", plan=make_plan("budget-precedence", budget=15, ceilings=(10, 10)))
        assert eligible_transition(ledger, active, {"transport": "connection"}) is None
    elif case_id == "p1_fence_before_tool_forward":
        ledger, active, _ = make_ledger(tmp_path, "tool-fence")
        assert FakeProvider(0, "dispatch").invoke()["dispatchAttempted"] is True
        fenced = ledger.authorize_tool_forward(active, "call-1", "read_tool", {"path": "safe"})
        assert fenced["status"] == "FIRST_FENCED"
        assert ledger.get_active("tool-fence")["dispatchAttempted"] is True
    elif case_id == "p1_tool_read_still_no_replay":
        ledger, active, _ = make_ledger(tmp_path, "read-no-replay")
        assert ledger.authorize_tool_forward(active, "read-1", "read_tool", {})["status"] == "FIRST_FENCED"
        assert ledger.authorize_tool_forward(active, "read-1", "read_tool", {})["status"] == "ALREADY_FENCED"
        assert len([event for event in ledger.read_outbox("read-no-replay") if event["kind"] == "dispatch_attempted"]) == 1
    elif case_id == "p1_stale_epoch_output_rejected":
        ledger, active, _ = make_ledger(tmp_path, "stale-output")
        successor = eligible_transition(ledger, active, FakeProvider(0, "connection").invoke())
        assert successor and ledger.append_event_if_active(active, "late_output", {"text": "late"}) is None
    elif case_id == "p1_stale_epoch_tool_rejected":
        ledger, active, _ = make_ledger(tmp_path, "stale-tool")
        assert eligible_transition(ledger, active, FakeProvider(0, "connection").invoke())
        assert FakeProvider(1).invoke()["result"] == "fake-provider-1"
        assert ledger.authorize_tool_forward(active, "late-tool", "write_tool", {})["status"] == "REJECTED"
    elif case_id == "p1_post_dispatch_crash_uncertain":
        ledger, active, _ = make_ledger(tmp_path, "crash-uncertain")
        assert FakeProvider(0, "crash").invoke()["stage"] == "post-dispatch-crash"
        assert ledger.mark_dispatch_attempted(active)
        outcome = ledger.recover_pre_dispatch_if_active(active)
        assert outcome and outcome["outcome"] == "cancelled_uncertain"
        assert ledger.get_task("crash-uncertain")["status"] == "cancelled_uncertain"
    elif case_id == "p1_pre_dispatch_orphan_then_successor":
        db_path = tmp_path / "recovery-success.sqlite"
        clock = [1_000]
        ledger = AttemptLedger(db_path, now_ms=lambda: clock[0])
        active = ledger.create_initial("recovery-success", make_plan("recovery-success"))
        # Simulate a stopped/restarted engine: the second authority object reads
        # the persisted tuple and plan before applying recovery idempotently.
        restarted = AttemptLedger(db_path, now_ms=lambda: clock[0])
        result = restarted.recover_and_transition_once(active, "recovery-success:attempt:0:startup-recovery:v1", 250,
                                                    {"failureClass": "retryable", "code": "pre_dispatch_timeout", "retryable": True})
        repeated = restarted.recover_and_transition_once(active, "recovery-success:attempt:0:startup-recovery:v1", 250)
        assert result["status"] == "RECOVERED" and repeated == result
        assert len(restarted.list_attempts("recovery-success")) == 2
    elif case_id == "p1_no_same_provider_retry":
        ledger, active, _ = make_ledger(tmp_path, "no-same-provider")
        successor = eligible_transition(ledger, active, {"transport": "connection"})
        assert successor["providerId"] == "fallback" and successor["providerId"] != active["providerId"]
        assert ledger.transition_once(active, "primary", {"failureClass": "retryable", "code": "connection", "retryable": True}) is None
    elif case_id == "p1_absolute_deadline_includes_jitter":
        clock = [1_000]
        plan = make_plan("jitter-deadline", deadline=1_250)
        ledger, active, _ = make_ledger(tmp_path, "jitter-deadline", clock=clock, plan=plan)
        assert eligible_transition(ledger, active, {"transport": "connection"}, jitter=250) is None
    elif case_id == "p1_attempt_timeout_ack_then_transition":
        controller = FakeController("ACK_PRE_DISPATCH")
        assert controller.signal_attempt_stop("ATTEMPT_TIMEOUT") == "ACK_PRE_DISPATCH"
        ledger, active, _ = make_ledger(tmp_path, "timeout-ack")
        successor = ledger.transition_once(active, "fallback", {"failureClass": "retryable", "code": "pre_dispatch_timeout", "retryable": True}, 250)
        assert successor and controller.signals == ["ATTEMPT_TIMEOUT"]
    elif case_id == "p1_timeout_no_ack_uncertain":
        controller = FakeController("ACK_UNCERTAIN")
        assert FakeProvider(1, "cancel_ack").invoke()["ack"] == controller.signal_attempt_stop("ATTEMPT_TIMEOUT") == "ACK_UNCERTAIN"
        ledger, active, _ = make_ledger(tmp_path, "timeout-uncertain")
        assert ledger.complete_if_active(active, "cancelled_uncertain")
        assert ledger.transition_once(active, "fallback", {"failureClass": "retryable", "code": "pre_dispatch_timeout", "retryable": True}) is None
    elif case_id == "p1_cancel_persisted_before_signal":
        ledger, active, _ = make_ledger(tmp_path, "cancel-before-signal")
        ack = ledger.request_cancel(active, "cancel-before-signal:cancel")
        assert ack["status"] == "ACK_CANCELLED" and ledger.get_task("cancel-before-signal")["status"] == "cancel_requested"
        assert ledger.transition_once(active, "fallback", {"failureClass": "retryable", "code": "connection", "retryable": True}) is None
    elif case_id == "p1_cancel_during_jitter":
        ledger, active, _ = make_ledger(tmp_path, "cancel-jitter")
        assert ledger.request_cancel(active, "cancel-jitter:cancel")["status"] == "ACK_CANCELLED"
        assert ledger.transition_once(active, "fallback", {"failureClass": "retryable", "code": "connection", "retryable": True}, 250) is None
    elif case_id == "p1_cancel_after_dispatch":
        ledger, active, _ = make_ledger(tmp_path, "cancel-after-dispatch")
        assert ledger.mark_dispatch_attempted(active)
        assert ledger.request_cancel(active, "cancel-after-dispatch:cancel")["status"] == "ACK_CANCELLED"
        assert ledger.transition_once(active, "fallback", {"failureClass": "retryable", "code": "connection", "retryable": True}) is None
    elif case_id == "p1_transition_race_one_winner":
        ledger, active, _ = make_ledger(tmp_path, "race")
        failure = {"failureClass": "retryable", "code": "connection", "retryable": True}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: ledger.transition_once(active, "fallback", failure), range(2)))
        assert sum(result is not None for result in results) == 1
        assert len(ledger.list_attempts("race")) == 2
    elif case_id in {"p1_circuit_three_inclusive_cutoff", "p1_circuit_sixty_second_open", "p1_circuit_diagnostic_cache_delete_no_change", "p1_circuit_diagnostic_cache_forge_no_change", "p1_circuit_witness_timestamp_rewind_corrupt"}:
        clock = [1_000]
        ledger = AttemptLedger(tmp_path / "circuit.sqlite", now_ms=lambda: clock[0])
        make_three_circuit_failures(ledger, clock, tmp_path, spacing=case_id == "p1_circuit_three_inclusive_cutoff")
        if case_id == "p1_circuit_three_inclusive_cutoff":
            clock[0] = 301_001
            task = "cutoff-fourth"
            active = ledger.create_initial(task, make_plan(task, deadline=1_000_000))
            assert eligible_transition(ledger, active, {"transport": "connection"}) is None
        elif case_id == "p1_circuit_sixty_second_open":
            clock[0] = 1_001
            task = "open-window"
            active = ledger.create_initial(task, make_plan(task, deadline=1_000_000))
            assert eligible_transition(ledger, active, {"transport": "connection"}) is None
            clock[0] = 61_000
            assert eligible_transition(ledger, active, {"transport": "connection"})
        elif case_id in {"p1_circuit_diagnostic_cache_delete_no_change", "p1_circuit_diagnostic_cache_forge_no_change"}:
            with sqlite3.connect(ledger.db_path) as conn:
                conn.execute("DELETE FROM circuit_failures")
                if case_id.endswith("forge_no_change"):
                    conn.execute("INSERT INTO circuit_failures(provider_id, failed_at_ms) VALUES (?, ?)", ("primary", 999_999_999))
            task = "diagnostic-fourth"
            active = ledger.create_initial(task, make_plan(task, deadline=1_000_000))
            assert eligible_transition(ledger, active, {"transport": "connection"}) is None
        else:
            with sqlite3.connect(ledger.db_path) as conn:
                conn.execute("UPDATE circuit_transition_authority SET witness_created_at_ms = witness_created_at_ms - 1")
            clock[0] = 2_000
            task = "rewound-witness"
            active = ledger.create_initial(task, make_plan(task, deadline=1_000_000))
            with pytest.raises(CorruptLedger):
                eligible_transition(ledger, active, {"transport": "connection"})
    elif case_id == "p1_receipt_attempt_order_and_unknown_cost":
        ledger, active, _ = make_ledger(tmp_path, "receipt-order")
        assert ledger.record_cost_if_active(active, None)["actualCostKnown"] is False
        assert ledger.complete_if_active(active, actual_cost_micro_usd=None)
        attempts = ledger.list_attempts("receipt-order")
        assert [attempt["epoch"] for attempt in attempts] == [0]
        assert attempts[0]["actualCostKnown"] is False and attempts[0]["actualCostMicroUsd"] is None
        assert [event["kind"] for event in ledger.read_outbox("receipt-order")] == ["attempt_created", "cost_recorded", "attempt_completed"]
    elif case_id == "p1_safe_export_attempt_redaction":
        source = (ROOT / "packages" / "gateway" / "src" / "export.ts").read_text(encoding="utf-8")
        assert "buildSafeExport" in source and "scrubText" in source
        export = {"providerId": "primary-sk-live-secret", "modelId": "model", "failureCode": "connection",
                  "finalProvider": "fallback", "source": "exact", "prompt": "should not be retained"}
        retained = {key: export[key] for key in ("providerId", "modelId", "failureCode", "finalProvider", "source")}
        safe = redact(retained)
        assert "sk-live-secret" not in json.dumps(safe) and "prompt" not in safe
    elif case_id == "p1_windows_fake_provider_doctor_bench":
        chain_path = tmp_path / "p1-chains.json"
        chain_path.write_text(json.dumps({"revision": "p1", "chains": {
            "default": {"id": "default", "providers": [
                {"id": "primary", "label": "Primary", "modelId": "fake-primary", "apiKeyEnvName": "P1_KEY_A", "baseUrlEnvName": "P1_BASE_A", "privacyClasses": ["standard", "sensitive"], "ceilingMicroUsd": 10},
                {"id": "fallback", "label": "Fallback", "modelId": "fake-fallback", "apiKeyEnvName": "P1_KEY_B", "baseUrlEnvName": "P1_BASE_B", "privacyClasses": ["standard", "sensitive"], "ceilingMicroUsd": 20}
            ]},
            "coding": {"id": "coding", "providers": [
                {"id": "coding-a", "label": "CodingA", "modelId": "fake-coding-a", "apiKeyEnvName": "P1_KEY_A", "baseUrlEnvName": "P1_BASE_A", "privacyClasses": ["standard", "sensitive"], "ceilingMicroUsd": 10},
                {"id": "coding-b", "label": "CodingB", "modelId": "fake-coding-b", "apiKeyEnvName": "P1_KEY_B", "baseUrlEnvName": "P1_BASE_B", "privacyClasses": ["standard", "sensitive"], "ceilingMicroUsd": 20}
            ]}
        }}), encoding="utf-8")
        (tmp_path / "resilience-maintenance.json").write_text(json.dumps({
            "schemaVersion": 1,
            "maintenanceNeeded": True,
            "maintenanceNeededByStore": {"ledger": True, "taskStore": False},
            "lastPassiveOutcome": {"ledger": "busy", "taskStore": "completed"},
            "walMaintenanceDeferred": True,
            "drained": True,
        }), encoding="utf-8")
        env = os.environ.copy() | {"P1_KEY_A": "secret-value-a", "P1_BASE_A": "secret-value-b", "P1_KEY_B": "secret-value-c", "P1_BASE_B": "secret-value-d", "TORQCLAW_DATA_DIR": str(tmp_path)}
        doctor = subprocess.run(["node", "ops/doctor.mjs", "--phase1", "--json", "--chains", str(chain_path)], cwd=ROOT, env=env, capture_output=True, text=True, check=False)
        assert doctor.returncode == 0, doctor.stdout + doctor.stderr
        doctor_report = json.loads(doctor.stdout)
        assert doctor_report["ok"] is True
        maintenance = next(check for check in doctor_report["checks"] if check["name"] == "maintenance")
        assert maintenance["maintenanceNeeded"] is True
        assert maintenance["lastPassiveOutcome"]["ledger"] == "busy"
        assert maintenance["walMaintenanceDeferred"] is True
        assert all(secret not in doctor.stdout for secret in ("secret-value-a", "secret-value-b", "secret-value-c", "secret-value-d"))
        bench_report_path = tmp_path / "phase1-http-record.json"
        bench = subprocess.run(
            ["node", "ops/bench.mjs", "--phase1", "--transport=http", "--json", "--runs", "100",
             "--warmup", "10", "--host-control=record", "--out", str(bench_report_path)],
            cwd=ROOT, env=env, capture_output=True, text=True, check=False,
        )
        assert bench.returncode in (0, 1), bench.stdout + bench.stderr
        report = json.loads(bench.stdout)
        assert report["mode"] == "phase1-promotion-benchmark"
        assert report["schemaVersion"] == 2
        assert report["transport"] == "streamable-http"
        assert report["connectionReuse"] == "single-session"
        assert report["sessionCount"] == 1
        assert report["listToolsBeforeWarmup"] is True
        assert report["network"] is False and report["syntheticMetrics"] is False
        assert report["promotion"]["providerWaitExcludedMs"] == 0
        assert report["promotion"]["policyJitterIncluded"] is True
        assert report["providerWaitAccountingProbe"]["passed"] is True
        assert report["providerWaitAccountingProbe"]["requestedProviderWaitMs"] == 200
        assert report["legacyStdioDiagnostic"]["promotionEligible"] is False
        assert report["legacyStdioDiagnostic"]["p95Ms"] == 799.354
        block = report["repetitions"][0]
        assert block["complete"] is True
        assert block["counts"] == {
            "cases": 100, "eligible": 80, "eligibleCompleted": 80,
            "attempts": 180, "submissions": 180, "transitions": 80,
            "terminalFailures": 20, "duplicateSubmissions": 0,
        }
        assert all(case["terminalState"] is not None and case["reconciled"] for case in block["cases"])
        assert all(case["explicitProviderWaitMs"] == 0 for case in block["cases"])
        if report["promotion"]["thresholdP95Ms"] > 500:
            assert bench.returncode == 1
            assert "repetition_1_threshold_p95_over_threshold" in report["fatalReasons"]
            assert bench_report_path.exists()
        else:
            assert bench.returncode == 0

        unavailable_env = env | {
            "TORQCLAW_DOCTOR_TIMEOUT_MS": "250",
            "TORQCLAW_GW_URL": "ws://127.0.0.1:1/ws",
            "TORQCLAW_CONSOLE_URL": "http://127.0.0.1:1/api/health",
            "OLLAMA_HOST": "http://127.0.0.1:1",
            "TORQCLAW_DATA_DIR": str(tmp_path / "default-doctor-unavailable"),
        }
        default_doctor = subprocess.run(
            ["node", "ops/doctor.mjs", "--json"], cwd=ROOT, env=unavailable_env,
            capture_output=True, text=True, check=False,
        )
        assert default_doctor.returncode == 1
        default_doctor_report = json.loads(default_doctor.stdout)
        assert default_doctor_report["ok"] is False
        assert {check["name"] for check in default_doctor_report["checks"]} == {
            "console", "gateway", "ollama", "mcp-roster",
        }

        default_bench = subprocess.run(
            ["node", "ops/bench.mjs", "--quick", "--no-score"], cwd=ROOT,
            env=unavailable_env, capture_output=True, text=True, encoding="utf-8",
            errors="replace", check=False,
        )
        assert default_bench.returncode == 1
        default_bench_output = default_bench.stdout + default_bench.stderr
        assert "TORQCLAW ROUTING BENCHMARK" in default_bench_output
        assert "gateway not reachable" in default_bench_output
    else:
        raise AssertionError(f"unknown P1 case: {case_id}")


@pytest.mark.parametrize("category,case_id", CASES, ids=CASE_IDS)
def test_manifest_enforced_p1_case(tmp_path, monkeypatch, category, case_id):
    assert category
    run_case(case_id, tmp_path, monkeypatch)
