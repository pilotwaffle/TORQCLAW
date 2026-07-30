import asyncio
import inspect
import json
import os
import time
from pathlib import Path

from mcp_wrapper import server, task_store
from mcp_wrapper import failover_runtime


def _contract() -> dict:
    path = Path(__file__).resolve().parents[3] / "tests" / "failover" / "fixtures" / "mcp_contract.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_fastmcp_handlers_match_shared_contract_fixture():
    contract = _contract()["tools"]
    for name, spec in contract.items():
        handler = getattr(server, name)
        assert list(inspect.signature(handler).parameters) == spec["arguments"]


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


def _provider(provider_id: str) -> dict:
    return {
        "providerId": provider_id, "label": provider_id.title(), "modelId": "stub-model",
        "credentialEnvName": "STUB_KEY", "baseUrlEnvName": "STUB_BASE",
    }


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
        submitted = await server.resilience_submit_attempt(_payload("complete me"), plan, active, _provider("primary"), deadline, task_id + ":submit")
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
        await server.resilience_submit_attempt(_payload("retry me"), retry_plan, first, _provider("primary"), retry_deadline, retry_id + ":submit-0")
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
        await server.resilience_record_observation(first, failure, retry_id + ":observation-0")
        transitioned = await server.resilience_transition_once(
            first, "fallback", failure["failure"], 250,
            failover_runtime.get_ledger()._plan_hash(retry_plan), retry_id + ":transition",
        )
        second = transitioned["successor"]
        monkeypatch.delenv("TORQCLAW_E2E_STUB_FAILURE", raising=False)
        await server.resilience_submit_attempt(_payload("retry me"), retry_plan, second, _provider("fallback"), retry_deadline, retry_id + ":submit-1")
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
    assert "refusing stub response" in status["error"]
    assert "STUB MODE" not in " ".join(event["message"] for event in status["events"])


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
