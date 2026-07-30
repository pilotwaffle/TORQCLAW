"""Feature-gated Python authority façade for Phase 1 failover.

The ledger remains the only durable attempt authority. The task store is the
internal execution/result store keyed by the ledger attemptId; rich provider
text and telemetry are projected from it only at the polling boundary.
"""
from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path
from typing import Any, Mapping

from . import task_store
from .attempt_ledger import AttemptLedger, LedgerError

_ledger: AttemptLedger | None = None
_ledger_path: Path | None = None
_run_lock = threading.Lock()
_started_attempts: set[str] = set()

_TELEMETRY_KEYS = {"costUsd", "costSource", "inferenceLatencyMs", "iterations", "cancelled"}
_FAILURE_CODES = {"connection", "dns", "http_408", "http_429", "http_5xx", "pre_dispatch_timeout"}


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


def reset_for_tests() -> None:
    global _ledger, _ledger_path
    _ledger = None
    _ledger_path = None
    with _run_lock:
        _started_attempts.clear()


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
        result = {**result, "activeTuple": result.pop("tuple")}
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
        tuple_value = tuple_from(active)
        normalized_ref = _provider_ref(provider_ref)
        result = get_ledger().submit_attempt(
            tuple_value, immutable_plan, normalized_ref, attempt_deadline_ms, idempotency_key,
        )
        if result.get("status") == "SUBMITTED":
            internal = {
                "payload": dict(payload),
                "immutablePlan": dict(immutable_plan),
                "activeTuple": dict(tuple_value),
                "providerRef": normalized_ref,
                "attemptDeadlineMs": attempt_deadline_ms,
            }
            task_store.create(internal, task_id=tuple_value["attemptId"])
            _start_attempt(tuple_value["attemptId"], internal)
        elif result.get("status") == "DUPLICATE":
            result = {**result, "activeTuple": result.get("activeTuple") or dict(tuple_value)}
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
        failure_class = value.get("failureClass")
        code = value.get("code")
        retryable = value.get("retryable")
        if failure_class in {"retryable", "configuration", "authentication", "budget", "side_effect_uncertainty", "timeout", "cancelled", "terminal"} and isinstance(code, str) and isinstance(retryable, bool):
            return {"failureClass": failure_class, "code": code, "retryable": retryable}
    return {"failureClass": "terminal", "code": "engine_failure", "retryable": False}


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
                "failure": normalized, "telemetry": _safe_telemetry(telemetry)}, "cancelled"
    return {"kind": "failure", "dispatchAttempted": dispatch_attempted,
            "failure": normalized, "telemetry": _safe_telemetry(telemetry)}, (
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

        observation, outcome = _terminal_observation(tuple_value, internal)
        if outcome is not None and (outcome != "failed" or observation.get("failure", {}).get("retryable") is not True):
            ledger.close_terminal_if_active(tuple_value, outcome)
        next_cursor = max([cursor] + [int(event["cursor"]) for event in internal.get("events", [])])
        return envelope("TERMINAL", cursor=next_cursor, observations=[observation], terminal=True)
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
        if kind == "result":
            normalized = {"failureClass": "terminal", "code": "completed", "retryable": False}
            closed = get_ledger().close_terminal_if_active(tuple_value, "completed")
            if closed is None:
                return envelope("DUPLICATE")
        elif kind == "cancelled":
            normalized = _failure(failure) if failure else {"failureClass": "cancelled", "code": "operator_cancel", "retryable": False}
        else:
            normalized = _failure(failure)
        recorded = get_ledger().record_observation(tuple_value, normalized, idempotency_key)
        if normalized["failureClass"] != "retryable":
            if recorded.get("status") == "REJECTED" and get_ledger().validate_poll_tuple(tuple_value):
                return envelope("DUPLICATE")
            get_ledger().close_terminal_if_active(
                tuple_value, "cancelled" if normalized["failureClass"] == "cancelled" else "failed",
            )
        return recorded
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))


def transition_once(active: Mapping[str, Any], successor_provider_id: str,
                   normalized_failure: Mapping[str, Any], jitter_ms: int = 0,
                   plan_hash: str | None = None,
                   idempotency_key: str | None = None) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
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
                                jitter_ms: int = 0,
                                normalized_failure: Mapping[str, Any] | None = None) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        result = get_ledger().recover_and_transition_once(
            tuple_from(active), recovery_id, jitter_ms, normalized_failure,
        )
        if result.get("status") == "RECOVERED":
            result = {**result, "successor": result.pop("tuple")}
        return result
    except LedgerError as exc:
        return envelope("REJECTED", reason=str(exc))


def get_status(task_id: str) -> dict[str, Any]:
    if not feature_enabled():
        return envelope("REJECTED", reason="resilience feature is disabled")
    try:
        ledger = get_ledger()
        task = ledger.get_task(task_id)
        if task is None:
            return envelope("REJECTED", reason="unknown task")
        active = ledger.get_active(task_id)
        if active is not None:
            return envelope("ACTIVE", activeTuple={k: active[k] for k in ("taskId", "attemptId", "epoch")},
                            providerId=active["providerId"], dispatchAttempted=bool(active["dispatchAttempted"]),
                            cancellationRequested=bool(active["cancelRequested"]), taskDeadlineMs=task["deadline_ms"])
        attempts = ledger.list_attempts(task_id)
        latest = attempts[-1] if attempts else {}
        return envelope("TERMINAL", dispatchAttempted=bool(latest.get("dispatchAttempted", False)),
                        cancellationRequested=bool(latest.get("cancelRequested", False)),
                        taskDeadlineMs=task["deadline_ms"])
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
