"""Persistent loopback Streamable HTTP fixture for Phase-1 promotion evidence.

The fixture imports the production FastMCP handlers and AttemptLedger, then
replaces only the provider start callback with the deterministic fake used by
the legacy diagnostic.  It deliberately owns one process, one event loop, one
MCP HTTP session, and one SQLite data directory for the lifetime of a bench.
"""
from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import re
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engines" / "hermes_kernel"))


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
SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
LEDGER_TOOL_OPERATIONS = {
    "resilience_admit_frontier": "admit_frontier",
    "resilience_submit_attempt": "submit_attempt",
    "resilience_poll_observations": "poll_observations",
    "resilience_page_outbox": "page_outbox",
    "resilience_transition_once": "transition_once",
}


async def _complete_fake_attempt(attempt_id: str, internal_payload: dict) -> None:
    """Complete one fake provider attempt asynchronously and deterministically."""
    from mcp_wrapper import task_store

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


def fake_start(attempt_id: str, internal_payload: dict) -> None:
    """Schedule fake provider work exactly as production starts an attempt.

    The production runtime returns from ``resilience_submit_attempt`` after
    scheduling the provider task.  Running the fixture's task-store writes
    inline made the MCP handler benchmark the fake provider itself instead of
    the orchestration boundary, and could serialize the handler behind SQLite
    work.  Keep the fake deterministic, but preserve the production launch
    boundary so the controller observes completion through polling.
    """
    asyncio.get_running_loop().create_task(
        _complete_fake_attempt(attempt_id, internal_payload),
    )


def append_sidecar(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")
        handle.flush()


def install_server_timing_envelope(
        mcp, *, task_store_diagnostics: str = "off",
        ledger_timing_diagnostics: str = "off", ledger_sidecar: Path | None = None,
) -> None:
    """Attach fixture-only handler timing to tool results.

    FastMCP keeps registered tools in a ToolManager.  Wrapping the registered
    callbacks after import leaves production source untouched while allowing
    the parent to separate handler and HTTP-client timing honestly.
    """
    from mcp_wrapper import failover_runtime, task_store

    capture_task_store_diagnostics = task_store_diagnostics == "capture"
    capture_ledger_timing = ledger_timing_diagnostics == "capture"

    def persistence_window(before: dict | None, reader, after_sequence: int) -> dict | None:
        """Return a fixture-only task-store delta for the benchmark seam."""
        if not isinstance(before, dict):
            return None
        try:
            after = reader(after_sequence)
            if not isinstance(after, dict) or after.get("available") is not True:
                return None
            records = after.get("records")
            if not isinstance(records, list):
                return None
            before_dropped = before.get("droppedCount")
            after_dropped = after.get("droppedCount")
            if (
                isinstance(before_dropped, bool) or not isinstance(before_dropped, int) or before_dropped < 0 or
                isinstance(after_dropped, bool) or not isinstance(after_dropped, int) or after_dropped < before_dropped
            ):
                return None
            return {
                "schemaVersion": 1,
                "store": "task_store",
                "records": records,
                "recordCount": len(records),
                # Report the absolute ring-loss count. A prior drop means the
                # diagnostic stream is already incomplete even when this
                # individual operation caused no additional drop.
                "truncatedCount": after_dropped,
            }
        except BaseException:
            return None

    def ledger_window(before: dict | None, reader, after_sequence: int,
                      expected_operation: str, task_store_window: dict | None) -> None:
        if not capture_ledger_timing or ledger_sidecar is None:
            return
        envelope = {
            "type": "ledger_timing",
            "operation": expected_operation,
            "correlation": "missing",
            "record": None,
            "recordCount": 0,
            "truncatedCount": 0,
        }
        try:
            if not isinstance(before, dict):
                append_sidecar(ledger_sidecar, envelope)
                return
            after = reader(after_sequence)
            records = after.get("records") if isinstance(after, dict) else None
            before_dropped = before.get("droppedCount")
            after_dropped = after.get("droppedCount") if isinstance(after, dict) else None
            if not isinstance(records, list) or any(not isinstance(item, dict) for item in records):
                append_sidecar(ledger_sidecar, envelope)
                return
            if (
                isinstance(before_dropped, bool) or not isinstance(before_dropped, int) or before_dropped < 0 or
                isinstance(after_dropped, bool) or not isinstance(after_dropped, int) or after_dropped < before_dropped
            ):
                append_sidecar(ledger_sidecar, envelope)
                return
            envelope["recordCount"] = len(records)
            envelope["truncatedCount"] = after_dropped - before_dropped
            if len(records) == 1 and envelope["truncatedCount"] == 0:
                record = dict(records[0])
                if record.get("operation") == expected_operation and task_store_window is not None:
                    task_records = [
                        {
                            "operation": item["operation"],
                            "durationMs": item["durationMs"],
                        }
                        for item in task_store_window.get("records", [])
                        if isinstance(item, dict) and isinstance(item.get("operation"), str)
                        and isinstance(item.get("durationMs"), (int, float))
                        and not isinstance(item.get("durationMs"), bool)
                    ]
                    if task_records:
                        record["taskStoreMs"] = task_records
                if record.get("operation") == expected_operation:
                    envelope["correlation"] = "exact"
                    envelope["record"] = record
            elif envelope["truncatedCount"] > 0:
                envelope["correlation"] = "truncated"
            else:
                envelope["correlation"] = "ambiguous"
        except BaseException:
            pass
        append_sidecar(ledger_sidecar, envelope)

    for tool in mcp._tool_manager._tools.values():  # noqa: SLF001 - fixture seam
        original = tool.fn
        tool_name = getattr(tool, "name", "")

        async def measured(*args, _original=original, _tool_name=tool_name, **kwargs):
            started = time.perf_counter()
            boundary_before = None
            boundary_after_sequence = 0
            task_store_before = None
            task_store_after_sequence = 0
            ledger_before = None
            ledger_after_sequence = 0
            expected_operation = LEDGER_TOOL_OPERATIONS.get(_tool_name)
            if _tool_name == "resilience_transition_once":
                boundary_before = failover_runtime.boundary_diagnostics()
                if (
                    isinstance(boundary_before, dict) and
                    boundary_before.get("available") is True and
                    isinstance(boundary_before.get("lastSequence"), int) and
                    not isinstance(boundary_before.get("lastSequence"), bool) and
                    boundary_before["lastSequence"] >= 0
                ):
                    boundary_after_sequence = boundary_before["lastSequence"]
            if capture_task_store_diagnostics:
                try:
                    task_store_before = task_store.diagnostic_snapshot()
                    if (
                        isinstance(task_store_before, dict) and
                        isinstance(task_store_before.get("lastSequence"), int) and
                        not isinstance(task_store_before.get("lastSequence"), bool) and
                        task_store_before["lastSequence"] >= 0
                    ):
                        task_store_after_sequence = task_store_before["lastSequence"]
                except BaseException:
                    task_store_before = None
            if capture_ledger_timing and expected_operation is not None:
                try:
                    ledger = failover_runtime.get_ledger()
                    ledger_before = ledger.diagnostic_snapshot()
                    if (
                        isinstance(ledger_before, dict) and
                        isinstance(ledger_before.get("lastSequence"), int) and
                        not isinstance(ledger_before.get("lastSequence"), bool) and
                        ledger_before["lastSequence"] >= 0
                    ):
                        ledger_after_sequence = ledger_before["lastSequence"]
                except BaseException:
                    ledger_before = None
            try:
                result = _original(*args, **kwargs)
                if inspect.isawaitable(result):
                    result = await result
            finally:
                task_store_window = None
                if capture_task_store_diagnostics:
                    try:
                        task_store_window = persistence_window(
                            task_store_before,
                            task_store.diagnostic_snapshot,
                            task_store_after_sequence,
                        )
                    except BaseException:
                        task_store_window = None
                if expected_operation is not None:
                    try:
                        ledger = failover_runtime._ledger  # noqa: SLF001 - fixture seam
                        reader = ledger.diagnostic_snapshot if ledger is not None else lambda _: None
                        ledger_window(
                            ledger_before, reader, ledger_after_sequence,
                            expected_operation, task_store_window,
                        )
                    except BaseException:
                        pass
            if _tool_name == "resilience_transition_once" and isinstance(result, dict):
                boundary_after = failover_runtime.boundary_diagnostics(boundary_after_sequence)
                records = (
                    boundary_after.get("records", [])
                    if isinstance(boundary_after, dict) and boundary_after.get("available") is True
                    else []
                )
                if (
                    len(records) == 1 and isinstance(records[0], dict) and
                    records[0].get("operation") == "fused_retryable_transition"
                ):
                    result = {
                        **result,
                        "__phase1BoundaryDiagnostics": {
                            "schemaVersion": 1,
                            "correlation": "exact",
                            "record": records[0],
                        },
                    }
                elif len(records) == 0:
                    result = {
                        **result,
                        "__phase1BoundaryDiagnostics": {
                            "schemaVersion": 1,
                            "correlation": "missing",
                            "recordCount": 0,
                        },
                    }
                else:
                    result = {
                        **result,
                        "__phase1BoundaryDiagnostics": {
                            "schemaVersion": 1,
                            "correlation": "ambiguous",
                            "recordCount": len(records),
                        },
                    }
            if capture_task_store_diagnostics:
                try:
                    task_store_window = persistence_window(task_store_before, task_store.diagnostic_snapshot, task_store_after_sequence)
                    if isinstance(result, dict) and task_store_window is not None:
                        result = {
                            **result,
                            "__phase1PersistenceDiagnostics": task_store_window,
                        }
                except BaseException:
                    pass
            elapsed_ms = (time.perf_counter() - started) * 1000
            if isinstance(result, dict):
                return {**result, "__phase1FakeServerMs": elapsed_ms}
            return result

        tool.fn = measured


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--task-store-diagnostics", choices=("off", "record", "capture"), default="off")
    parser.add_argument("--task-store-diagnostics-capacity", type=int, default=None)
    parser.add_argument("--ledger-timing-diagnostics", choices=("off", "capture"), default="off")
    parser.add_argument("--ledger-sidecar", type=Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.host != "127.0.0.1":
        raise SystemExit("phase1 HTTP fixture is loopback-only")
    if not (1 <= args.port <= 65535):
        raise SystemExit("invalid loopback port")

    # These must be set before importing mcp_wrapper.server: task_store and
    # FastMCP bind their database and listener at module import time.
    os.environ["HERMES_BIND_HOST"] = args.host
    os.environ["HERMES_PORT"] = str(args.port)
    os.environ["TORQCLAW_DATA_DIR"] = str(args.data_dir)
    os.environ["TORQCLAW_PROVIDER_FAILOVER_ENABLED"] = "1"

    from mcp_wrapper import task_store

    if args.task_store_diagnostics_capacity is not None:
        if not 1 <= args.task_store_diagnostics_capacity <= 4096:
            raise SystemExit("task-store diagnostic capacity is outside the fixture bound")
        # Fixture-only test seam; production task-store capacity is unchanged.
        task_store._DIAGNOSTIC_CAPACITY = args.task_store_diagnostics_capacity  # noqa: SLF001
    task_store.set_diagnostics_enabled(args.task_store_diagnostics != "off")
    from mcp_wrapper import failover_runtime, server  # noqa: E402

    failover_runtime.reset_for_tests()
    if args.ledger_timing_diagnostics == "capture":
        failover_runtime.get_ledger().set_timing_diagnostics_enabled(True)
    failover_runtime._start_attempt = fake_start

    @server.mcp.tool()
    async def phase1_provider_wait_probe(task_id: str, attempt_id: str, provider_wait_ms: int = 0) -> dict:
        """Test-only accounting probe; never called by the promotion suite."""
        if not SAFE_ID.fullmatch(task_id) or not SAFE_ID.fullmatch(attempt_id):
            raise ValueError("probe identifiers are invalid")
        if not isinstance(provider_wait_ms, int) or provider_wait_ms < 0 or provider_wait_ms > 10_000:
            raise ValueError("provider_wait_ms is outside the probe bound")
        started = time.perf_counter() * 1000
        await asyncio.sleep(provider_wait_ms / 1000)
        ended = time.perf_counter() * 1000
        record = {
            "taskId": task_id,
            "attemptId": attempt_id,
            "providerWaitMs": provider_wait_ms,
            "startMonotonicMs": started,
            "endMonotonicMs": ended,
            "durationMs": ended - started,
        }
        append_sidecar(args.sidecar, record)
        return {"status": "PROBED", "providerWaitMs": provider_wait_ms, "durationMs": record["durationMs"]}

    install_server_timing_envelope(
        server.mcp,
        task_store_diagnostics=args.task_store_diagnostics,
        ledger_timing_diagnostics=args.ledger_timing_diagnostics,
        ledger_sidecar=args.ledger_sidecar,
    )
    # One process/one worker is intentional: the ledger and Hermes runtime are
    # process-local and the benchmark's reuse claim depends on this boundary.
    server.mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
