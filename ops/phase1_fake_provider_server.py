"""Offline MCP subprocess seam for the Phase-1 controller evidence.

The MCP handlers and AttemptLedger remain production code.  Only the provider
execution callback is replaced with a deterministic fake so the controller can
be exercised without credentials, network access, or a live provider.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engines" / "hermes_kernel"))

from mcp_wrapper import failover_runtime, server, task_store  # noqa: E402


RETRYABLE = {
    "connection": {"failureClass": "retryable", "code": "connection", "retryable": True},
    "dns": {"failureClass": "retryable", "code": "dns", "retryable": True},
    "http_408": {"failureClass": "retryable", "code": "http_408", "retryable": True},
    "http_429": {"failureClass": "retryable", "code": "http_429", "retryable": True},
    "http_5xx": {"failureClass": "retryable", "code": "http_5xx", "retryable": True},
}
TERMINAL = {
    "authentication": {"failureClass": "authentication", "code": "http_401", "retryable": False},
}


def fake_start(attempt_id: str, internal_payload: dict) -> None:
    """Complete one fake provider attempt synchronously and deterministically."""
    provider = internal_payload["providerRef"]["providerId"]
    prompt = internal_payload["payload"]["prompt"]
    marker = "TORQCLAW_FAKE_FAULT="
    fault = prompt.split(marker, 1)[1].split(" ", 1)[0] if marker in prompt else "success"
    task_store.emit(attempt_id, "SYSTEM", f"Fake provider started ({provider})")
    if provider.startswith("primary") and fault in RETRYABLE:
        task_store.fail(attempt_id, "normalized_failure", {
            "normalizedFailure": RETRYABLE[fault],
            "costUsd": None,
            "costSource": "unavailable",
        })
        return
    if provider.startswith("primary") and fault in TERMINAL:
        task_store.fail(attempt_id, "normalized_failure", {
            "normalizedFailure": TERMINAL[fault],
            "costUsd": None,
            "costSource": "unavailable",
        })
        return
    task_store.complete(attempt_id, f"[fake-provider:{provider}] deterministic result", {
        "costUsd": None,
        "costSource": "unavailable",
        "iterations": 1,
        "dispatchAttempted": False,
    })


failover_runtime.reset_for_tests()
failover_runtime._start_attempt = fake_start


async def dispatch(name: str, arguments: dict) -> dict:
    started = time.perf_counter()
    operation = getattr(server, name)
    result = operation(**arguments)
    if asyncio.iscoroutine(result):
        result = await result
    if isinstance(result, dict):
        result = {**result, "__phase1FakeServerMs": (time.perf_counter() - started) * 1000}
    return {"content": [{"type": "text", "text": json.dumps(result, separators=(",", ":"))}]}


for line in sys.stdin:
    if not line.strip():
        continue
    try:
        call = json.loads(line)
        response = asyncio.run(dispatch(call["name"], call.get("arguments", {})))
    except Exception as exc:  # noqa: BLE001 - report the MCP-shaped failure to the bridge
        response = {"isError": True, "content": [{"type": "text", "text": str(exc)}]}
    print(json.dumps(response, separators=(",", ":")), flush=True)
