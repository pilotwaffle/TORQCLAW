"""Feature-gated Python authority façade for Phase 1 failover.

The ledger remains the only durable attempt authority. The task store is the
internal execution/result store keyed by the ledger attemptId; rich provider
text and telemetry are projected from it only at the polling boundary.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Mapping

from . import task_store
from .attempt_ledger import AttemptLedger, CostEvidence, LedgerError
from .contracts import validate_gateway_request

_ledger: AttemptLedger | None = None
_ledger_path: Path | None = None
_run_lock = threading.Lock()
_started_attempts: set[str] = set()

_TELEMETRY_KEYS = {"costUsd", "costSource", "inferenceLatencyMs", "iterations", "cancelled"}
_COST_SOURCES = {"exact", "account_delta", "unavailable"}
_FAILURE_SOURCES = {"engine", "gateway", "recovery"}
_FAILURE_CODES = {"connection", "dns", "http_408", "http_429", "http_5xx", "pre_dispatch_timeout"}
_ACKS = {"ACK_PRE_DISPATCH", "ACK_UNCERTAIN", "ACK_POST_DISPATCH"}


def feature_enabled() -> bool:
    return os.environ.get("TORQCLAW_PROVIDER_FAILOVER_ENABLED", "").strip().lower() in {
        "1", "true", "yes", "on",
    }


def frontier_active(payload: Mapping[str, Any] | None = None) -> bool:
    if not feature_enabled():
        return False
    if payload is None:
        return True
    for key in ("tier", "computeTier", "routeTier", "executionTier"):
        if key in payload and payload[key] != "FRONTIER":
            return False
    nested = payload.get("payload") if isinstance(payload, Mapping) else None
    if isinstance(nested, Mapping):
        return frontier_active(nested)
    return True


def ledger_path() -> Path:
    data_dir = Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw")
    return data_dir / "resilience_attempts.db"


def get_ledger() -> AttemptLedger:
    global _ledger, _ledger_path
    if not feature_enabled():
        raise LedgerError("resilience feature is disabled")
    path = ledger_path()
    if _ledger is None or _ledger_path != path:
        path.parent.mkdir(parents=True, exist_ok=True)
        _ledger = AttemptLedger(path)
        _ledger_path = path
    return _ledger


def boundary_diagnostics(after_sequence: int = 0) -> dict[str, Any]:
    """Read volatile fused-transition diagnostics without lazy initialization."""
    ledger = _ledger
    if ledger is None:
        return {"schemaVersion": 1, "available": False, "reason": "ledger_not_initialized"}
    return ledger.boundary_diagnostics(after_sequence)


def _maintenance_diagnostics_path() -> Path:
    data_dir = Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw")
    return data_dir / "resilience-maintenance.json"


def _json_safe(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _write_maintenance_diagnostics(result: Mapping[str, Any]) -> None:
    """Persist additive, secret-free shutdown metrics for the offline doctor.

    This runs only from the explicit lifespan/test shutdown path.  The doctor
    reads this snapshot; it never opens either SQLite database or triggers a
    checkpoint itself.
    """
    ledger = result.get("ledger") if isinstance(result.get("ledger"), Mapping) else {}
    task_store_result = result.get("taskStore") if isinstance(result.get("taskStore"), Mapping) else {}
    ledger_outcome = ledger.get("lastOutcome", "never")
    task_store_outcome = task_store_result.get("lastOutcome", "never")
    maintenance_by_store = {
        "ledger": bool(ledger.get("maintenanceNeeded", False)),
        "taskStore": bool(task_store_result.get("maintenanceNeeded", False)),
    }
    deferred_outcomes = {"skipped_not_drained", "busy", "error"}
    payload = {
        "schemaVersion": 1,
        "maintenanceNeeded": any(maintenance_by_store.values()),
        "maintenanceNeededByStore": maintenance_by_store,
        "lastPassiveOutcome": {
            "ledger": ledger_outcome,
            "taskStore": task_store_outcome,
        },
        "walMaintenanceDeferred": (
            any(maintenance_by_store.values()) or
            ledger_outcome in deferred_outcomes or
            task_store_outcome in deferred_outcomes
        ),
        "drained": bool(ledger.get("drained", True)),
        "ledger": _json_safe(ledger),
        "taskStore": _json_safe(task_store_result),
    }
    path = _maintenance_diagnostics_path()
    temporary = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    except (OSError, TypeError, ValueError):
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


@contextmanager
def request_scope():
    """Track the request side of the explicit shutdown drain fence."""
    ledger = _ledger
    if ledger is None:
        yield
        return
    with ledger.request_scope():
        yield


def shutdown_for_tests() -> dict[str, Any]:
    """Close resilience stores after the server has stopped accepting work."""
    global _ledger, _ledger_path
    result: dict[str, Any] = {}
    ledger = _ledger
    if ledger is not None:
        fence = ledger.drain_fence()
        result["ledger"] = ledger.checkpoint_after_drain(drained=fence["drained"])
        result["taskStore"] = task_store.checkpoint_after_drain(drained=fence["drained"])
        ledger.shutdown_for_tests(checkpoint=False)
    else:
        result["taskStore"] = task_store.checkpoint_after_drain(drained=True)
    task_store.shutdown_for_tests(checkpoint=False)
    _ledger = None
    _ledger_path = None
    with _run_lock:
        _started_attempts.clear()
    _write_maintenance_diagnostics(result)
    return result


def reset_for_tests() -> None:
    shutdown_for_tests()


def tuple_from(value: Mapping[str, Any]) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not {"taskId", "attemptId", "epoch"}.issubset(value):
        raise LedgerError("active tuple is missing or contains unapproved fields")
    return {key: value[key] for key in ("taskId", "attemptId", "epoch")}


def envelope(status: str, **fields: Any) -> dict[str, Any]:
    result = {"status": status}
    result.update(fields)
    return result


def _provider_ref(value: Mapping[str, Any]) -> dict[str, str]:
    """Normalize the bridge's reference to the Python MCP contract."""
    if not isinstance(value, Mapping):
        raise LedgerError("provider reference is invalid")
    if set(value) == {"id", "label", "modelId", "apiKeyEnvName", "baseUrlEnvName"}:
        return {
            "providerId": value["id"], "label": value["label"],
            "modelId": value["modelId"],
            "credentialEnvName": value["apiKeyEnvName"],
            "baseUrlEnvName": value["baseUrlEnvName"],
        }
    if set(value) == {"providerId", "label", "modelId", "credentialEnvName", "baseUrlEnvName"}:
        return dict(value)  # type: ignore[return-value]
    raise LedgerError("provider reference is not secret-free")


def admit_frontier(request_id: str, immutable_plan: Mapping[str, Any], deadline_at: int,
                   provider_order: list[str]) -> dict[str, Any]:
    if not frontier_active():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        result = get_ledger().admit_frontier(request_id, immutable_plan, deadline_at, provider_order)
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))
    if "tuple" in result:
        admitted = result.pop("tuple")
        result = {**result, "activeTuple": {
            key: admitted[key] for key in ("taskId", "attemptId", "epoch")
        }}
    return result


def _start_attempt(attempt_id: str, internal_payload: dict[str, Any]) -> None:
    with _run_lock:
        if attempt_id in _started_attempts:
            return
        _started_attempts.add(attempt_id)
    from .server import run_hermes_loop
    asyncio.get_running_loop().create_task(run_hermes_loop(attempt_id, internal_payload))


def submit_attempt(payload: Mapping[str, Any], immutable_plan: Mapping[str, Any],
                   active: Mapping[str, Any], provider_ref: Mapping[str, Any],
                   attempt_deadline_ms: int,
                   idempotency_key: str | None = None) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        if not isinstance(payload, Mapping) or not isinstance(payload.get("payload"), Mapping):
            raise LedgerError("submit payload must be the complete GatewayRequest")
        validate_gateway_request(dict(payload))
        tuple_value = tuple_from(active)
        normalized_ref = _provider_ref(provider_ref)
        result = get_ledger().submit_attempt(
            tuple_value, immutable_plan, normalized_ref, attempt_deadline_ms, idempotency_key,
        )
        if result.get("status") == "SUBMITTED":
            # The controller already supplied the complete GatewayRequest.
            # Preserve it as the single outer payload and add only transport
            # metadata; adding another payload key breaks the runner contract.
            internal = dict(payload)
            internal.update({
                "immutablePlan": dict(immutable_plan),
                "activeTuple": dict(tuple_value),
                "providerRef": normalized_ref,
                "attemptDeadlineMs": attempt_deadline_ms,
            })
            task_store.create(internal, task_id=tuple_value["attemptId"])
            _start_attempt(tuple_value["attemptId"], internal)
            result = {**result, "executionState": "STARTED"}
        elif result.get("status") == "DUPLICATE":
            internal_state = task_store.state_of(tuple_value["attemptId"])
            with _run_lock:
                owned = tuple_value["attemptId"] in _started_attempts
            execution_state = (
                "TERMINAL" if internal_state in {"completed", "failed"} else
                "OWNED" if internal_state == "running" and owned else
                "ORPHANED"
            )
            result = {**result, "activeTuple": result.get("activeTuple") or dict(tuple_value),
                      "executionState": execution_state}
        return result
    except (LedgerError, KeyError, TypeError) as exc:
        return envelope("REJECTED", reason=str(exc))


def _safe_telemetry(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, Any] = {}
    for key in _TELEMETRY_KEYS:
        candidate = value.get(key)
        if key in {"costUsd", "inferenceLatencyMs"} and isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
            result[key] = candidate
        elif key == "iterations" and isinstance(candidate, int) and not isinstance(candidate, bool):
            result[key] = candidate
        elif key == "cancelled" and isinstance(candidate, bool):
            result[key] = candidate
        elif key == "costSource" and candidate in {"exact", "account_delta", "unavailable"}:
            result[key] = candidate
    return result


def _failure(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        try:
            normalized = AttemptLedger.normalize_observation({
                "failureClass": value.get("failureClass"),
                "code": value.get("code"),
                "retryable": value.get("retryable"),
            })
            return normalized
        except LedgerError:
            pass
    return {"failureClass": "terminal", "code": "engine_failure", "retryable": False}


def _reconcile_cost_inputs(telemetry: Mapping[str, Any]) -> tuple[int | None, str]:
    """Return validated cost inputs without opening a serving transaction.

    A numeric value without an authoritative exact/account-delta source is not
    trusted as actual spend; it remains unknown and retains the reservation.
    """
    source = telemetry.get("costSource")
    source = source if isinstance(source, str) and source in _COST_SOURCES else "unavailable"
    cost = telemetry.get("costUsd")
    valid_cost = (
        not isinstance(cost, bool) and isinstance(cost, (int, float))
        and math.isfinite(float(cost)) and cost >= 0
    )
    actual_micro_usd = (
        int(round(float(cost) * 1_000_000))
        if valid_cost and source in {"exact", "account_delta"} else None
    )
    return actual_micro_usd, source


def _cost_evidence_for_fused_transition(
        active: Mapping[str, Any], failure: Mapping[str, Any],
        failure_source: str, *, strict: bool = True,
) -> CostEvidence | None:
    """Rehydrate engine evidence without opening another ledger transaction."""
    internal = task_store.status(str(tuple_from(active)["attemptId"]))
    state = internal.get("state")
    if state in {"unknown", "running"}:
        # A gateway-side transport failure can be retryable without ever
        # reaching the engine.  There is then no authoritative spend or
        # terminal observation to hydrate; preserve the historical no-cost
        # fused transition path.  Engine-originated failures must still prove
        # the terminal task-store record before they may carry cost evidence.
        if failure_source == "gateway":
            return None
        if strict:
            raise LedgerError("fused retry requires a terminal internal observation")
        return None
    telemetry = internal.get("telemetry") if isinstance(internal.get("telemetry"), Mapping) else {}
    recorded = telemetry.get("normalizedFailure")
    if not isinstance(recorded, Mapping) or _failure(recorded) != dict(failure):
        if strict:
            raise LedgerError("internal retryable failure does not match fused request")
        return None
    recorded_source = telemetry.get("failureSource")
    if recorded_source is None:
        recorded_source = "engine"
    if recorded_source != failure_source:
        if strict:
            raise LedgerError("internal failure source does not match fused request")
        return None
    actual_micro_usd, cost_source = _reconcile_cost_inputs(telemetry)
    return CostEvidence(actual_micro_usd, cost_source)


def _durable_dispatch_attempted(active: Mapping[str, Any]) -> bool:
    tuple_value = tuple_from(active)
    for attempt in get_ledger().list_attempts(tuple_value["taskId"]):
        if (attempt["attemptId"] == tuple_value["attemptId"] and
                attempt["epoch"] == tuple_value["epoch"]):
            return bool(attempt["dispatchAttempted"])
    raise LedgerError("active tuple is missing from durable ledger")


def _terminal_observation(active: Mapping[str, Any], status: Mapping[str, Any]) -> tuple[dict[str, Any], str | None]:
    telemetry = status.get("telemetry") if isinstance(status, Mapping) else {}
    normalized = _failure(telemetry.get("normalizedFailure") if isinstance(telemetry, Mapping) else None)
    dispatch_attempted = _durable_dispatch_attempted(active)
    if status.get("state") == "completed" and not telemetry.get("blockedOn"):
        observation = {"kind": "result", "dispatchAttempted": dispatch_attempted,
                       "text": status.get("result") if isinstance(status.get("result"), str) else "",
                       "telemetry": _safe_telemetry(telemetry)}
        return observation, "completed"
    if normalized["failureClass"] == "cancelled":
        return {"kind": "cancelled", "dispatchAttempted": dispatch_attempted,
                "failure": normalized, "failureSource": "engine",
                "telemetry": _safe_telemetry(telemetry)}, "cancelled"
    return {"kind": "failure", "dispatchAttempted": dispatch_attempted,
            "failure": normalized, "failureSource": "engine",
            "telemetry": _safe_telemetry(telemetry)}, (
                "failed" if normalized["failureClass"] != "side_effect_uncertainty" else "cancelled_uncertain"
            )


def poll_observations(active: Mapping[str, Any], cursor: int,
                      attempt_deadline_ms: int) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        tuple_value = tuple_from(active)
        if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
            raise LedgerError("cursor is invalid")
        get_ledger()._time_ms(attempt_deadline_ms)
        ledger = get_ledger()
        if not ledger.validate_poll_tuple(tuple_value):
            return envelope("REJECTED", reason="stale or mismatched active tuple")
        internal = task_store.status(tuple_value["attemptId"], cursor)
        if internal.get("state") == "unknown":
            return envelope("REJECTED", reason="internal attempt is missing")
        state = internal.get("state")
        if state == "running":
            events = internal.get("events", [])
            dispatch_attempted = _durable_dispatch_attempted(tuple_value)
            progress = [{"kind": "progress", "dispatchAttempted": dispatch_attempted}
                        for _event in events]
            if dispatch_attempted and not progress:
                progress = [{"kind": "progress", "dispatchAttempted": True}]
            next_cursor = max([cursor] + [int(event["cursor"]) for event in events])
            return envelope("OBSERVATIONS", cursor=next_cursor, observations=progress, terminal=False)

        telemetry = internal.get("telemetry") if isinstance(internal.get("telemetry"), Mapping) else {}
        actual_cost_micro_usd, cost_source = _reconcile_cost_inputs(telemetry)
        observation, outcome = _terminal_observation(tuple_value, internal)
        terminal_committed = False
        terminal_outcome: str | None = None
        if outcome is not None and (outcome != "failed" or observation.get("failure", {}).get("retryable") is not True):
            failure = observation.get("failure") if observation.get("kind") != "result" else None
            committed = ledger.complete_terminal_from_poll_if_active(
                tuple_value,
                outcome,
                actual_cost_micro_usd=actual_cost_micro_usd,
                cost_source=cost_source,
                normalized_failure=failure,
                failure_source=observation.get("failureSource") if failure is not None else None,
            )
            terminal_committed = bool(committed and committed.get("terminalCommitted") is True)
            terminal_outcome = str(committed.get("terminalOutcome")) if terminal_committed else None
        else:
            # Retryable evidence is deliberately held in the internal task
            # store until the fused transition authority boundary.  A second
            # serving transaction here would reintroduce the measured commit
            # tail and could leave cost detached from the transition.
            pass
        next_cursor = max([cursor] + [int(event["cursor"]) for event in internal.get("events", [])])
        return envelope(
            "TERMINAL", cursor=next_cursor, observations=[observation], terminal=True,
            terminalCommitted=terminal_committed,
            **({"terminalOutcome": terminal_outcome} if terminal_outcome is not None else {}),
        )
    except (LedgerError, KeyError, TypeError, ValueError) as exc:
        return envelope("REJECTED", reason=str(exc))


def record_observation(active: Mapping[str, Any], normalized_observation: Mapping[str, Any],
                       idempotency_key: str) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        tuple_value = tuple_from(active)
        kind = normalized_observation.get("kind") if isinstance(normalized_observation, Mapping) else None
        failure = normalized_observation.get("failure") if isinstance(normalized_observation, Mapping) else None
        failure_source = normalized_observation.get("failureSource") if isinstance(normalized_observation, Mapping) else None
        if failure_source is None and failure is not None:
            failure_source = "gateway"
        if failure_source is not None and failure_source not in _FAILURE_SOURCES:
            return envelope("REJECTED", reason="failure source is invalid")
        if kind == "cancelled":
            normalized = _failure(failure) if failure else {
                "failureClass": "cancelled", "code": "operator_cancel", "retryable": False,
            }
            if normalized == {"failureClass": "cancelled", "code": "operator_cancel", "retryable": False}:
                outcome = "cancelled"
            elif normalized == {"failureClass": "cancelled", "code": "timeout_uncertain", "retryable": False}:
                outcome = "cancelled_uncertain"
            else:
                return envelope("REJECTED", reason="cancellation terminal is invalid")
            ledger = get_ledger()
            closed = ledger.close_terminal_if_active(
                tuple_value, outcome, normalized_failure=normalized,
                failure_source=str(failure_source or "gateway"),
                idempotency_key=idempotency_key,
            )
            if closed is not None:
                if closed.get("idempotentReplay") is True:
                    return envelope("DUPLICATE", observation=normalized, outcome=outcome)
                return envelope("RECORDED", observation=normalized, outcome=outcome)
            authority = ledger.get_status(tuple_value["taskId"])
            exact_terminal = authority.get("active") is None and any(
                attempt.get("attemptId") == tuple_value["attemptId"] and
                attempt.get("epoch") == tuple_value["epoch"] and
                attempt.get("state") == "terminal"
                for attempt in authority.get("attempts", [])
            )
            return envelope("DUPLICATE" if exact_terminal else "REJECTED",
                            reason=None if exact_terminal else "stale or mismatched active tuple")
        if kind == "result":
            normalized = {"failureClass": "terminal", "code": "completed", "retryable": False}
            closed = get_ledger().close_terminal_if_active(tuple_value, "completed")
            if closed is None:
                return envelope("DUPLICATE")
        elif kind == "cancelled":
            normalized = _failure(failure) if failure else {"failureClass": "cancelled", "code": "operator_cancel", "retryable": False}
        else:
            normalized = _failure(failure)
        recorded = get_ledger().record_observation(
            tuple_value, normalized, idempotency_key,
            failure_source=str(failure_source) if failure_source is not None else None,
        )
        if normalized["failureClass"] != "retryable":
            if recorded.get("status") == "REJECTED" and get_ledger().validate_poll_tuple(tuple_value):
                return envelope("DUPLICATE")
            get_ledger().close_terminal_if_active(
                tuple_value,
                "cancelled" if normalized["failureClass"] == "cancelled" else
                "cancelled_uncertain" if normalized["failureClass"] == "side_effect_uncertainty" else
                "failed",
            )
        return recorded
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))


def finalize_attempt(active: Mapping[str, Any], normalized_failure: Mapping[str, Any],
                     failure_source: str, terminal_outcome: str,
                     idempotency_key: str) -> dict[str, Any]:
    """Atomically record the observed safe cause and close exact authority.

    A controller decision that cannot transition is not a new provider
    failure. The original class/code/source is therefore retained while the
    independent terminal outcome closes the attempt/task/control tuple once.
    """
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        tuple_value = tuple_from(active)
        normalized = _failure(normalized_failure)
        if failure_source not in _FAILURE_SOURCES:
            return envelope("REJECTED", reason="failure source is invalid")
        if terminal_outcome not in {"failed", "cancelled", "cancelled_uncertain", "terminal"}:
            return envelope("REJECTED", reason="terminal outcome is invalid")
        if terminal_outcome == "cancelled" and normalized != {
                "failureClass": "cancelled", "code": "operator_cancel", "retryable": False}:
            return envelope("REJECTED", reason="confirmed cancellation failure is invalid")
        if terminal_outcome == "cancelled_uncertain" and normalized["failureClass"] not in {
                "cancelled", "side_effect_uncertainty"}:
            return envelope("REJECTED", reason="uncertain cancellation failure is invalid")
        closed = get_ledger().close_terminal_if_active(
            tuple_value, terminal_outcome, normalized_failure=normalized,
            failure_source=failure_source, idempotency_key=idempotency_key,
            cost_evidence=_cost_evidence_for_fused_transition(
                active, normalized, failure_source, strict=failure_source == "engine",
            ),
        )
        if closed is not None:
            if closed.get("idempotentReplay") is True:
                return envelope("DUPLICATE", outcome=terminal_outcome)
            return envelope("FINALIZED", activeTuple=dict(tuple_value),
                            outcome=terminal_outcome,
                            normalizedFailure=normalized,
                            failureSource=failure_source)
        authority = get_ledger().get_status(tuple_value["taskId"])
        exact_terminal = authority.get("active") is None and any(
            attempt.get("attemptId") == tuple_value["attemptId"] and
            attempt.get("epoch") == tuple_value["epoch"] and
            attempt.get("state") == "terminal"
            for attempt in authority.get("attempts", [])
        )
        return envelope("DUPLICATE" if exact_terminal else "REJECTED",
                        reason=None if exact_terminal else "stale or mismatched active tuple")
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))


def transition_once(active: Mapping[str, Any], successor_provider_id: str,
                   normalized_failure: Mapping[str, Any], jitter_ms: int = 250,
                   plan_hash: str | None = None,
                   idempotency_key: str | None = None,
                   failure_source: str | None = None,
                   observation_idempotency_key: str | None = None) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    if (isinstance(jitter_ms, bool) or not isinstance(jitter_ms, int) or
            not 250 <= jitter_ms <= 750):
        return envelope("REJECTED", reason="jitter is outside 250-750ms bounds")
    try:
        fused = failure_source is not None or observation_idempotency_key is not None
        if fused and (failure_source is None or observation_idempotency_key is None or
                      plan_hash is None or idempotency_key is None):
            return envelope("REJECTED", reason="fused transition fields must be supplied together")
        if fused:
            cost_evidence = _cost_evidence_for_fused_transition(
                active, _failure(normalized_failure), str(failure_source),
            )
            result = get_ledger().record_retryable_observation_and_transition_once(
                tuple_from(active), successor_provider_id, normalized_failure,
                str(failure_source), jitter_ms, str(plan_hash),
                str(observation_idempotency_key), str(idempotency_key),
                cost_evidence=cost_evidence,
            )
        else:
            result = get_ledger().transition_once_result(
                tuple_from(active), successor_provider_id, normalized_failure, jitter_ms,
                plan_hash, idempotency_key,
            )
        if result.get("status") == "TRANSITIONED":
            result = {**result, "successor": {
                "taskId": result.pop("taskId"), "attemptId": result.pop("attemptId"),
                "epoch": result.pop("epoch"),
            }, "successorProviderId": result.get("providerId")}
        return result
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))


def request_cancel(active: Mapping[str, Any], cancel_id: str) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        return get_ledger().request_cancel(tuple_from(active), cancel_id)
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))


def recover_and_transition_once(active: Mapping[str, Any], recovery_id: str,
                                jitter_ms: int = 250,
                                normalized_failure: Mapping[str, Any] | None = None) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    if (isinstance(jitter_ms, bool) or not isinstance(jitter_ms, int) or
            not 250 <= jitter_ms <= 750):
        return envelope("REJECTED", reason="jitter is outside 250-750ms bounds")
    try:
        result = get_ledger().recover_and_transition_once(
            tuple_from(active), recovery_id, jitter_ms, normalized_failure,
        )
        if result.get("status") == "RECOVERED":
            result = {**result, "successor": result.pop("tuple")}
        return result
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))


def _authoritative_active(active: Mapping[str, Any]) -> dict[str, Any] | None:
    expected = tuple_from(active)
    status = get_ledger().get_status(expected["taskId"])
    candidate = status.get("active")
    if not isinstance(candidate, Mapping):
        return None
    if tuple_from(candidate) != expected:
        return None
    return dict(candidate)


def _stop_signal(task_id: str, timeout_ms: int) -> dict[str, Any]:
    from .hermes_runner import stop_attempt
    return stop_attempt(task_id, timeout_ms)


def _bounded_stop_ack(task_id: str, stop_transport, timeout_ms: int) -> str:
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 1 <= timeout_ms <= 2_000:
        return "ACK_UNCERTAIN"
    transport = stop_transport or _stop_signal
    result_box: list[Any] = []

    def invoke() -> None:
        try:
            result_box.append(transport(task_id, timeout_ms))
        except Exception:  # transport and adapter errors are uncertain
            result_box.append(None)

    worker = threading.Thread(target=invoke, daemon=True)
    worker.start()
    worker.join(timeout_ms / 1000)
    result = result_box[0] if result_box else None
    if isinstance(result, Mapping) and result.get("status") in _ACKS:
        return str(result["status"])
    return "ACK_UNCERTAIN"


def attempt_timeout(active: Mapping[str, Any], timeout_id: str | None = None,
                    jitter_ms: int = 250, timeout_ms: int = 2_000,
                    stop_transport=None) -> dict[str, Any]:
    """Stop one attempt without persisting operator cancellation.

    The exact tuple and dispatch fence are re-read after the bounded stop
    acknowledgement. The gateway remains the sole transition owner; an
    ACK_PRE_DISPATCH result is only a stop acknowledgement and never performs
    a ledger transition here.
    """
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        expected = tuple_from(active)
        current = _authoritative_active(expected)
        if current is None:
            return envelope("ACK_UNCERTAIN", outcome="cancelled_uncertain")
        if current.get("controlStatus") == "cancel_requested" or current.get("cancelRequested"):
            return envelope("ACK_UNCERTAIN", outcome="cancel_pending")
        ack = _bounded_stop_ack(expected["attemptId"], stop_transport, timeout_ms)
        reread = _authoritative_active(expected)
        if reread is None:
            return envelope(ack if ack != "ACK_PRE_DISPATCH" else "ACK_UNCERTAIN",
                            outcome="cancelled_uncertain")
        if reread.get("dispatchAttempted") or ack in {"ACK_POST_DISPATCH", "ACK_UNCERTAIN"}:
            closed = get_ledger().close_terminal_if_active(expected, "cancelled_uncertain")
            return envelope("ACK_UNCERTAIN", outcome="cancelled_uncertain", closed=closed is not None)
        if ack != "ACK_PRE_DISPATCH":
            closed = get_ledger().close_terminal_if_active(expected, "cancelled_uncertain")
            return envelope("ACK_UNCERTAIN", outcome="cancelled_uncertain", closed=closed is not None)

        # This is the only successful timeout acknowledgement. The controller
        # must re-run its full precedence checks and call transition_once once.
        return envelope("ACK_PRE_DISPATCH", activeTuple=expected,
                        dispatchAttempted=False)
    except (LedgerError, KeyError, TypeError, ValueError):
        return envelope("ACK_UNCERTAIN", outcome="cancelled_uncertain")


def get_status(task_id: str) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        ledger = get_ledger()
        authority = ledger.get_status(task_id)
        if authority.get("status") == "UNKNOWN":
            return envelope("REJECTED", reason="unknown task")
        active = authority.get("active")
        if active is not None:
            return envelope("CANCEL_PENDING" if authority.get("cancellationPending") else "ACTIVE",
                            activeTuple={k: active[k] for k in ("taskId", "attemptId", "epoch")},
                            providerId=active["providerId"], dispatchAttempted=bool(active["dispatchAttempted"]),
                            cancellationRequested=bool(active["cancelRequested"]),
                            attemptState=active["state"],
                            executionSubmitted=active["state"] != "active",
                            providerSubmitNotBeforeMs=active["providerSubmitNotBeforeMs"],
                            immutablePlan=authority["immutablePlan"],
                            taskState=authority["taskState"], taskDeadlineMs=authority["deadlineMs"])
        attempts = authority.get("attempts") or []
        latest = attempts[-1] if attempts else {}
        return envelope("TERMINAL", dispatchAttempted=bool(latest.get("dispatchAttempted", False)),
                        cancellationRequested=bool(latest.get("cancelRequested", False)),
                        attemptState=latest.get("state", "terminal"), executionSubmitted=False,
                        providerSubmitNotBeforeMs=latest.get("providerSubmitNotBeforeMs", 0),
                        immutablePlan=authority["immutablePlan"], taskState=authority["taskState"],
                        taskDeadlineMs=authority["deadlineMs"])
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))


def page_outbox(after_cursor: int = 0, limit: int = 100) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        page = get_ledger().page_outbox(after_cursor, limit)
        return envelope("PAGE", cursor=page["nextCursor"], highWaterMark=page["highWaterMark"], events=page["events"])
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))


def authorize_tool_forward(active: Mapping[str, Any], tool_call_id: str,
                           tool_name: str = "", args: Mapping[str, Any] | None = None) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        return get_ledger().authorize_tool_forward(tuple_from(active), tool_call_id, tool_name, args)
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))
