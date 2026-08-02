import asyncio
import inspect
import json
import os
import time
from pathlib import Path

from mcp_wrapper import server, task_store
from mcp_wrapper import failover_runtime
from mcp_wrapper.attempt_ledger import AttemptLedger
from mcp_wrapper.hermes_runner import (
    InvalidCredentialsError,
    MalformedProviderResponseError,
    MissingCredentialsError,
    normalize_provider_failure,
)


def _contract() -> dict:
    path = Path(__file__).resolve().parents[3] / "tests" / "failover" / "fixtures" / "mcp_contract.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_finish_observation_publishes_event_and_terminal_row_atomically():
    task_id = task_store.create({"payload": {"prompt": "atomic"}})
    result = task_store.finish_observation(
        task_id,
        {"kind": "result", "failureClass": "terminal", "code": "completed", "retryable": False},
        result="done",
        telemetry={"costSource": "exact"},
    )
    assert result == {"state": "completed"}
    status = task_store.status(task_id)
    assert status["state"] == "completed"
    assert status["result"] == "done"
    assert [event["type"] for event in status["events"]] == ["OBSERVATION"]


def test_finish_observation_records_normalized_failure_with_one_event():
    task_id = task_store.create({"payload": {"prompt": "failure"}})
    task_store.finish_observation(
        task_id,
        {"kind": "failure", "failureClass": "terminal", "code": "engine_failure", "retryable": False},
    )
    status = task_store.status(task_id)
    assert status["state"] == "failed"
    assert status["error"] == "normalized_failure"
    assert status["telemetry"]["normalizedFailure"]["code"] == "engine_failure"
    assert len(status["events"]) == 1


def test_fastmcp_handlers_match_shared_contract_fixture():
    contract = _contract()["tools"]
    for name, spec in contract.items():
        handler = getattr(server, name)
        assert list(inspect.signature(handler).parameters) == spec["arguments"]


def test_public_transition_and_recovery_wrappers_reject_zero_without_mutation(
        monkeypatch, tmp_path):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    task_id = "server-zero"
    deadline = 9_000_000_000_000
    runtime_plan = _plan(task_id, deadline)
    active = ledger.create_initial(task_id, runtime_plan)
    before_status = ledger.get_status(task_id)
    before_outbox = ledger.read_outbox(task_id)

    def unexpected(*_args, **_kwargs):
        raise AssertionError("zero jitter reached ledger or task-store work")

    monkeypatch.setattr(failover_runtime, "get_ledger", unexpected)
    monkeypatch.setattr(failover_runtime, "_cost_evidence_for_fused_transition", unexpected)
    monkeypatch.setattr(task_store, "status", unexpected)
    failure = {"failureClass": "retryable", "code": "connection", "retryable": True}

    async def invoke():
        transition = await server.resilience_transition_once(
            active, "fallback", failure, 0,
        )
        recovery = await server.resilience_recover_and_transition_once(
            active, "server-zero-recovery", 0, {
                "failureClass": "retryable", "code": "pre_dispatch_timeout",
                "retryable": True,
            },
        )
        return transition, recovery

    transition, recovery = asyncio.run(invoke())
    expected = {
        "status": "REJECTED", "reason": "jitter is outside 250-750ms bounds",
    }
    assert transition == expected
    assert recovery == expected
    assert ledger.get_status(task_id) == before_status
    assert ledger.read_outbox(task_id) == before_outbox


def test_task_store_lifecycle_metrics_and_runtime_diagnostics(monkeypatch, tmp_path):
    task_store.shutdown_for_tests(checkpoint=False)
    task_id = task_store.create({"payload": {"prompt": "maintenance"}})
    conn = task_store._conn
    assert conn is not None
    assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert conn.execute("PRAGMA synchronous").fetchone()[0] == 1
    assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 10000
    assert conn.execute("PRAGMA wal_autocheckpoint").fetchone()[0] == 0

    for index in range(64):
        task_store.emit(task_id, "SYSTEM", f"event-{index}")
    metrics = task_store.maintenance_metrics()
    assert metrics["maintenanceNeeded"] is True
    assert metrics["writesSinceCheckpoint"] >= 64
    assert task_store.checkpoint_after_drain(drained=False)["status"] == "SKIPPED_NOT_DRAINED"
    assert task_store.status(task_id)["state"] == "running"
    checkpoint = task_store.checkpoint_after_drain(drained=True)
    assert checkpoint["status"] in {"COMPLETED", "BUSY"}
    task_store.shutdown_for_tests(checkpoint=False)
    assert task_store._conn is None

    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    ledger.create_initial("diagnostics", _plan("diagnostics", 9_000_000_000_000))
    result = failover_runtime.shutdown_for_tests()
    assert result["ledger"]["status"] in {"COMPLETED", "BUSY"}
    diagnostics = json.loads((tmp_path / "resilience-maintenance.json").read_text(encoding="utf-8"))
    assert diagnostics["schemaVersion"] == 1
    assert isinstance(diagnostics["maintenanceNeeded"], bool)
    assert set(diagnostics["lastPassiveOutcome"]) == {"ledger", "taskStore"}
    assert isinstance(diagnostics["walMaintenanceDeferred"], bool)


def test_real_attempt_timeout_handler_returns_ack_without_operator_cancel(monkeypatch, tmp_path):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    ledger = failover_runtime.get_ledger()
    active = ledger.create_initial("handler-timeout", _plan("handler-timeout", 9_000_000_000_000))
    seen = []
    monkeypatch.setattr(
        failover_runtime, "_stop_signal",
        lambda task_id, timeout_ms: (seen.append((task_id, timeout_ms)) or {"status": "ACK_PRE_DISPATCH"}),
    )

    result = asyncio.run(server.attempt_timeout(active, 2_000))

    assert result == {
        "status": "ACK_PRE_DISPATCH",
        "activeTuple": {key: active[key] for key in ("taskId", "attemptId", "epoch")},
        "dispatchAttempted": False,
    }
    assert seen == [(active["attemptId"], 2_000)]
    assert len(ledger.list_attempts("handler-timeout")) == 1
    assert ledger.get_task("handler-timeout")["status"] == "running"
    assert not any(event["kind"] == "cancel_requested" for event in ledger.read_outbox("handler-timeout"))


def _plan(task_id: str, deadline: int) -> dict:
    return {
        "schemaVersion": 1, "taskId": task_id, "chainId": "e2e",
        "eligibleProviderIds": ["primary", "fallback"], "privacyClass": "standard",
        "privacyHash": "a" * 64, "policyHash": "b" * 64, "contextHash": "c" * 64,
        "grantHash": "d" * 64, "taskDeadlineMs": deadline, "attemptTimeoutMs": 1_000,
        "transitionLimit": 1, "budgetMicroUsd": None,
        "providerCeilings": {"primary": 1, "fallback": 1},
        "featurePolicyRevision": "rev", "planRevision": "1",
    }


def _payload(prompt: str) -> dict:
    return {"prompt": prompt, "taskType": "ROUTINE_AUTOMATION", "assembledContext": "", "grantedTools": []}


def _gateway_request(task_id: str, prompt: str) -> dict:
    return {
        "id": "00000000-0000-0000-0000-000000000000",
        "sessionId": "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "sourceChannel": "test",
        "receivedAt": "2026-07-30T00:00:00Z",
        "payload": {**_payload(prompt), "contextSize": 1, "requiredTools": []},
        "constraints": {"latencySensitivity": "LOW", "containsSensitiveData": False, "executionMode": "CLOUD_OK"},
        "enrichment": {
            "classifierUsed": "DEFAULT", "classifierConfidence": 1,
            "classifierLatencyMs": 0, "estimatedTokens": 1, "memoryUsed": False,
        },
    }


def _provider(provider_id: str) -> dict:
    return {
        "providerId": provider_id, "label": provider_id.title(), "modelId": "stub-model",
        "credentialEnvName": "STUB_KEY", "baseUrlEnvName": "STUB_BASE",
    }


class _TestClock:
    def __init__(self):
        self.wall_ms = int(time.time() * 1000)
        self.mono_ns = time.monotonic_ns()

    def now_ms(self) -> int:
        return self.wall_ms

    def monotonic_ns(self) -> int:
        return self.mono_ns

    def advance(self, milliseconds: int) -> None:
        assert milliseconds >= 0
        self.wall_ms += milliseconds
        self.mono_ns += milliseconds * 1_000_000


def _install_test_clock(monkeypatch) -> _TestClock:
    clock = _TestClock()
    ledger_type = failover_runtime.AttemptLedger

    class DeterministicAttemptLedger(ledger_type):
        def __init__(self, path):
            super().__init__(path, now_ms=clock.now_ms, monotonic_ns=clock.monotonic_ns)

    monkeypatch.setattr(failover_runtime, "AttemptLedger", DeterministicAttemptLedger)
    return clock


def _advance_past_submit_fence(clock: _TestClock, transition: dict) -> None:
    fence = transition["successorSubmitNotBeforeMs"]
    clock.advance(fence - clock.now_ms() + 1)


def test_real_handler_boundary_stub_completion_and_one_successor(monkeypatch, tmp_path):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.setenv("HERMES_STUB_DELAY_S", "0.01")
    monkeypatch.delenv("TORQCLAW_E2E_STUB_FAILURE", raising=False)
    monkeypatch.setattr("mcp_wrapper.hermes_runner.hermes_available", lambda: (True, None))
    monkeypatch.setattr(
        "mcp_wrapper.hermes_runner.run_hermes_sync",
        lambda task_id, payload: (
            (_ for _ in ()).throw(RuntimeError(os.environ["TORQCLAW_E2E_STUB_FAILURE"].split(":", 1)[1]))
            if os.environ.get("TORQCLAW_E2E_STUB_FAILURE", "").startswith(
                str(payload.get("providerRef", {}).get("providerId", "")) + ":"
            ) else {
                "result": f"[fake-hermes] {payload['payload']['prompt']}",
                "telemetry": {"engineUsed": "hermes:fake", "costUsd": 0.0, "costSource": "exact"},
            }
        ),
    )
    clock = _install_test_clock(monkeypatch)
    failover_runtime.reset_for_tests()
    starts = []
    original = server.run_hermes_loop

    async def counted(task_id, payload):
        starts.append(task_id)
        await original(task_id, payload)

    monkeypatch.setattr(server, "run_hermes_loop", counted)

    async def run_once():
        task_id = "server-e2e-" + str(time.time_ns())
        deadline = int(time.time() * 1000) + 20_000
        plan = _plan(task_id, deadline)
        admitted = await server.resilience_admit_frontier(task_id, plan, deadline, ["primary", "fallback"])
        active = admitted["activeTuple"]
        submitted = await server.resilience_submit_attempt(_gateway_request(task_id, "complete me"), plan, active, _provider("primary"), deadline, task_id + ":submit")
        assert submitted["status"] == "SUBMITTED"
        terminal = None
        for _ in range(100):
            page = await server.resilience_poll_observations(active, 0, deadline)
            if page["status"] == "TERMINAL":
                terminal = page
                break
            await asyncio.sleep(0.01)
        assert terminal is not None
        assert terminal["observations"][0]["kind"] == "result"
        assert terminal["observations"][0]["text"].strip()
        assert terminal["terminalCommitted"] is True
        assert terminal["terminalOutcome"] == "completed"
        outbox = await server.resilience_page_outbox(0, 100)
        status = await server.resilience_get_status(task_id)
        assert status["status"] == "TERMINAL"
        assert len(starts) == 1
        assert "complete me" not in json.dumps(outbox)

        retry_id = "server-retry-" + str(time.time_ns())
        retry_deadline = int(time.time() * 1000) + 20_000
        retry_plan = _plan(retry_id, retry_deadline)
        admitted_retry = await server.resilience_admit_frontier(retry_id, retry_plan, retry_deadline, ["primary", "fallback"])
        first = admitted_retry["activeTuple"]
        monkeypatch.setenv("TORQCLAW_E2E_STUB_FAILURE", "primary:connection")
        await server.resilience_submit_attempt(_gateway_request(retry_id, "retry me"), retry_plan, first, _provider("primary"), retry_deadline, retry_id + ":submit-0")
        failure_page = None
        for _ in range(100):
            candidate = await server.resilience_poll_observations(first, 0, retry_deadline)
            if candidate["status"] == "TERMINAL":
                failure_page = candidate
                break
            await asyncio.sleep(0.01)
        assert failure_page is not None
        failure = failure_page["observations"][0]
        assert failure["failure"] == {"failureClass": "retryable", "code": "connection", "retryable": True}
        assert failure_page["terminalCommitted"] is False
        await server.resilience_record_observation(first, failure, retry_id + ":observation-0")
        transitioned = await server.resilience_transition_once(
            first, "fallback", failure["failure"], 250,
            failover_runtime.get_ledger()._plan_hash(retry_plan), retry_id + ":transition",
        )
        second = transitioned["successor"]
        monkeypatch.delenv("TORQCLAW_E2E_STUB_FAILURE", raising=False)
        not_ready = await server.resilience_submit_attempt(
            _gateway_request(retry_id, "retry me"), retry_plan, second,
            _provider("fallback"), retry_deadline, retry_id + ":submit-1",
        )
        assert not_ready["status"] == "NOT_READY"
        assert len(starts) == 2
        _advance_past_submit_fence(clock, transitioned)
        submitted_retry = await server.resilience_submit_attempt(
            _gateway_request(retry_id, "retry me"), retry_plan, second,
            _provider("fallback"), retry_deadline, retry_id + ":submit-1",
        )
        assert submitted_retry["status"] == "SUBMITTED"
        result_page = None
        for _ in range(100):
            candidate = await server.resilience_poll_observations(second, 0, retry_deadline)
            if candidate["status"] == "TERMINAL":
                result_page = candidate
                break
            await asyncio.sleep(0.01)
        assert result_page is not None
        assert result_page["observations"][0]["kind"] == "result"
        assert result_page["observations"][0]["text"].strip()
        assert result_page["terminalCommitted"] is True
        assert result_page["terminalOutcome"] == "completed"
        assert len(failover_runtime.get_ledger().list_attempts(retry_id)) == 2
        assert (await server.resilience_get_status(retry_id))["status"] == "TERMINAL"
        assert len(starts) == 3

    asyncio.run(run_once())


def test_provider_ref_model_is_live_without_global_model(monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setattr("mcp_wrapper.hermes_runner.hermes_available", lambda: (True, None))
    calls = []

    def fake_run(task_id, payload):
        calls.append((task_id, payload))
        return {"result": "real provider result", "telemetry": {"costUsd": 0.0, "costSource": "exact"}}

    monkeypatch.setattr("mcp_wrapper.hermes_runner.run_hermes_sync", fake_run)
    task_id = "provider-ref-live-" + str(time.time_ns())
    payload = {
        "payload": _payload("live provider"),
        "activeTuple": {"taskId": task_id, "attemptId": "attempt", "epoch": 0},
        "providerRef": _provider("primary"),
    }
    task_store.create(payload, task_id=task_id)

    asyncio.run(server.run_hermes_loop(task_id, payload))

    assert len(calls) == 1
    assert calls[0][1]["providerRef"] == payload["providerRef"]
    assert task_store.status(task_id)["result"] == "real provider result"
    assert task_store.status(task_id)["telemetry"].get("engineUsed") != "hermes-stub"


def test_provider_ref_model_fails_closed_when_hermes_unavailable(monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setattr(
        "mcp_wrapper.hermes_runner.hermes_available",
        lambda: (False, "ModuleNotFoundError: no Hermes"),
    )
    task_id = "provider-ref-unavailable-" + str(time.time_ns())
    payload = {
        "payload": _payload("must not stub"),
        "activeTuple": {"taskId": task_id, "attemptId": "attempt", "epoch": 0},
        "providerRef": _provider("primary"),
    }
    task_store.create(payload, task_id=task_id)

    asyncio.run(server.run_hermes_loop(task_id, payload))

    status = task_store.status(task_id)
    assert status["state"] == "failed"
    assert status["result"] is None
    assert status["error"] == "normalized_failure"
    assert status["telemetry"]["normalizedFailure"] == {
        "failureClass": "terminal", "code": "engine_failure", "retryable": False,
    }


def test_submit_duplicate_reports_owned_then_orphaned_without_restart(monkeypatch, tmp_path):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    failover_runtime.reset_for_tests()
    task_id = "submit-ownership"
    plan = _plan(task_id, 9_000_000_000_000)
    active = failover_runtime.get_ledger().create_initial(task_id, plan)
    starts = []

    def fake_start(attempt_id, payload):
        starts.append(attempt_id)
        failover_runtime._started_attempts.add(attempt_id)

    monkeypatch.setattr(failover_runtime, "_start_attempt", fake_start)
    first = failover_runtime.submit_attempt(
        _gateway_request(task_id, "ownership"), plan, active, _provider("primary"),
        8_000_000_000_000, f"{task_id}:submit",
    )
    owned = failover_runtime.submit_attempt(
        _gateway_request(task_id, "ownership"), plan, active, _provider("primary"),
        8_000_000_000_000, f"{task_id}:submit",
    )
    assert first["executionState"] == "STARTED"
    assert owned["status"] == "DUPLICATE" and owned["executionState"] == "OWNED"
    assert starts == [active["attemptId"]]

    failover_runtime.reset_for_tests()
    orphaned = failover_runtime.submit_attempt(
        _gateway_request(task_id, "ownership"), plan, active, _provider("primary"),
        8_000_000_000_000, f"{task_id}:submit",
    )
    assert orphaned["status"] == "DUPLICATE"
    assert orphaned["executionState"] == "ORPHANED"
    assert starts == [active["attemptId"]]


def test_no_provider_ref_without_global_model_keeps_stub_path(monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.delenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", raising=False)
    monkeypatch.setattr(
        "mcp_wrapper.hermes_runner.hermes_available",
        lambda: (False, "ModuleNotFoundError: no Hermes"),
    )
    monkeypatch.setenv("HERMES_STUB_DELAY_S", "0")
    task_id = "ordinary-stub-" + str(time.time_ns())
    payload = {"payload": _payload("ordinary stub")}
    task_store.create(payload, task_id=task_id)

    asyncio.run(server.run_hermes_loop(task_id, payload))

    status = task_store.status(task_id)
    assert status["state"] == "completed"
    assert status["telemetry"]["engineUsed"] == "hermes-stub"


def test_configured_live_mode_never_returns_stub_on_unavailable_hermes(monkeypatch):
    monkeypatch.setenv("HERMES_MODEL", "configured-model")
    monkeypatch.setattr(
        "mcp_wrapper.hermes_runner.hermes_available",
        lambda: (False, "ModuleNotFoundError: No module named 'requests'"),
    )

    payload = {
        "payload": {
            "prompt": "hello TC",
            "taskType": "ROUTINE_AUTOMATION",
        }
    }
    task_id = task_store.create(payload)

    asyncio.run(server.run_hermes_loop(task_id, payload))

    status = task_store.status(task_id)
    assert status["state"] == "failed"
    assert status["result"] is None
    assert "refusing stub response" in status["error"]
    assert any(event["type"] == "ERROR" for event in status["events"])


def test_provider_failure_adapter_is_typed_safe_and_exhaustive():
    class DnsFailure(Exception):
        pass

    class HttpFailure(Exception):
        def __init__(self, status_code):
            self.response = type("Response", (), {"status_code": status_code})()

    cases = [
        (ConnectionError("raw provider secret"), ("retryable", "connection", True)),
        (DnsFailure("https://secret.example"), ("retryable", "dns", True)),
        (HttpFailure(408), ("retryable", "http_408", True)),
        (HttpFailure(429), ("retryable", "http_429", True)),
        (HttpFailure(503), ("retryable", "http_5xx", True)),
        (HttpFailure(400), ("configuration", "http_400", False)),
        (HttpFailure(404), ("configuration", "http_404", False)),
        (HttpFailure(401), ("authentication", "http_401", False)),
        (HttpFailure(403), ("authentication", "http_403", False)),
        (MissingCredentialsError("TOKEN=secret"), ("authentication", "missing_credentials", False)),
        (InvalidCredentialsError("Authorization: secret"), ("authentication", "invalid_credentials", False)),
        (MalformedProviderResponseError("body contains secret"), ("terminal", "malformed_response", False)),
        (RuntimeError("provider prose and token"), ("terminal", "unknown", False)),
    ]
    for error, (failure_class, code, retryable) in cases:
        failure = normalize_provider_failure(error)
        assert failure == {"failureClass": failure_class, "code": code, "retryable": retryable}
        assert "secret" not in json.dumps(failure).lower()


def test_real_resilience_submit_preserves_complete_request_without_double_wrap(monkeypatch, tmp_path):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    monkeypatch.setattr("mcp_wrapper.hermes_runner.hermes_available", lambda: (True, None))
    seen = []

    def fake_run(task_id, envelope):
        seen.append(envelope)
        return {"result": envelope["payload"]["prompt"], "telemetry": {"costUsd": 0.0, "costSource": "exact"}}

    monkeypatch.setattr("mcp_wrapper.hermes_runner.run_hermes_sync", fake_run)
    failover_runtime.reset_for_tests()
    task_id = "full-request-" + str(time.time_ns())
    deadline = int(time.time() * 1000) + 20_000
    plan = _plan(task_id, deadline)
    request = _gateway_request(task_id, "one complete request")

    async def run_once():
        admitted = await server.resilience_admit_frontier(task_id, plan, deadline, ["primary", "fallback"])
        submitted = await server.resilience_submit_attempt(
            request, plan, admitted["activeTuple"], _provider("primary"), deadline, task_id + ":submit",
        )
        assert submitted["status"] == "SUBMITTED"
        for _ in range(100):
            page = await server.resilience_poll_observations(admitted["activeTuple"], 0, deadline)
            if page["status"] == "TERMINAL":
                return
            await asyncio.sleep(0.01)
        raise AssertionError("runner did not reach a terminal observation")

    asyncio.run(run_once())
    assert len(seen) == 1
    assert seen[0]["payload"] == request["payload"]
    assert "payload" not in seen[0]["payload"]
    assert seen[0]["providerRef"]["providerId"] == "primary"


def test_real_submit_connection_failure_uses_one_eligible_successor(monkeypatch, tmp_path):
    monkeypatch.setenv("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "1")
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    monkeypatch.setattr("mcp_wrapper.hermes_runner.hermes_available", lambda: (True, None))
    calls = []

    def fake_run(task_id, envelope):
        calls.append(envelope["providerRef"]["providerId"])
        if calls[-1] == "primary":
            raise ConnectionError("provider endpoint and token must not escape")
        return {"result": "fallback result", "telemetry": {"costUsd": 0.0, "costSource": "exact"}}

    monkeypatch.setattr("mcp_wrapper.hermes_runner.run_hermes_sync", fake_run)
    clock = _install_test_clock(monkeypatch)
    failover_runtime.reset_for_tests()
    task_id = "connection-fallback-" + str(time.time_ns())
    deadline = int(time.time() * 1000) + 20_000
    plan = _plan(task_id, deadline)
    request = _gateway_request(task_id, "connection fallback")

    async def run_once():
        admitted = await server.resilience_admit_frontier(task_id, plan, deadline, ["primary", "fallback"])
        first = admitted["activeTuple"]
        await server.resilience_submit_attempt(request, plan, first, _provider("primary"), deadline, task_id + ":submit-0")
        terminal = None
        for _ in range(100):
            page = await server.resilience_poll_observations(first, 0, deadline)
            if page["status"] == "TERMINAL":
                terminal = page["observations"][0]
                break
            await asyncio.sleep(0.01)
        assert terminal["failure"] == {"failureClass": "retryable", "code": "connection", "retryable": True}
        await server.resilience_record_observation(first, terminal, task_id + ":observation")
        transitioned = await server.resilience_transition_once(
            first, "fallback", terminal["failure"], 250,
            failover_runtime.get_ledger()._plan_hash(plan), task_id + ":transition",
        )
        assert transitioned["status"] == "TRANSITIONED"
        second = transitioned["successor"]
        not_ready = await server.resilience_submit_attempt(
            request, plan, second, _provider("fallback"), deadline, task_id + ":submit-1",
        )
        assert not_ready["status"] == "NOT_READY"
        assert calls == ["primary"]
        _advance_past_submit_fence(clock, transitioned)
        submitted_retry = await server.resilience_submit_attempt(
            request, plan, second, _provider("fallback"), deadline, task_id + ":submit-1",
        )
        assert submitted_retry["status"] == "SUBMITTED"
        for _ in range(100):
            page = await server.resilience_poll_observations(second, 0, deadline)
            if page["status"] == "TERMINAL":
                return
            await asyncio.sleep(0.01)
        raise AssertionError("fallback did not reach a terminal observation")

    asyncio.run(run_once())
    assert calls == ["primary", "fallback"]
