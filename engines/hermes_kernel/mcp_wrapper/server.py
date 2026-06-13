"""TORQCLAW Hermes Engine — Streamable HTTP MCP server (NOT legacy SSE;
HTTP+SSE was deprecated in protocol rev 2025-03-26).

Binds 127.0.0.1 by default. When splitting onto a separate GPU box, front it
with Tailscale or set HERMES_ENGINE_TOKEN and a reverse proxy — never bare
0.0.0.0 (the OpenClaw exposed-default-port incident class)."""
import asyncio
import os

from mcp.server.fastmcp import FastMCP

from . import skill_queue, task_store
from .contracts import validate_gateway_request

mcp = FastMCP(
    "torqclaw-hermes-engine",
    host=os.environ.get("HERMES_BIND_HOST", "127.0.0.1"),
    port=int(os.environ.get("HERMES_PORT", "8000")),
)


async def run_hermes_loop(task_id: str, payload: dict) -> None:
    """Real Hermes execution via mcp_wrapper.hermes_runner (callbacks ->
    cursor events). Falls back to a labeled stub when the vendored agent
    or its provider config isn't available, so the pipeline stays testable."""
    from .hermes_runner import hermes_available, run_hermes_sync

    try:
        prompt = payload["payload"]["prompt"]
        task_type = payload["payload"]["taskType"]
        available, why = hermes_available()

        if available and os.environ.get("HERMES_MODEL"):
            task_store.emit(task_id, "SYSTEM", f"Hermes agent booted for {task_type}")
            # run_conversation is synchronous — never block the event loop.
            out = await asyncio.to_thread(run_hermes_sync, task_id, payload)
            # null cost = breaker is blind; say so once, never report 0.00.
            if out.get("telemetry", {}).get("costUsd") is None:
                task_store.emit(
                    task_id, "SYSTEM",
                    "Spend reporting unavailable for this provider — budget "
                    "cannot be enforced; the iteration cap "
                    "(HERMES_MAX_ITERATIONS) is the only guard.",
                )
            task_store.complete(task_id, out["result"], out["telemetry"])
            return

        reason = why or "HERMES_MODEL unset"
        task_store.emit(task_id, "SYSTEM", f"STUB MODE ({reason}) for {task_type}")
        from .hermes_runner import get_spend_usd

        cost = get_spend_usd(None, task_id)  # stub: HERMES_STUB_COST_* flags
        if cost is None:
            task_store.emit(
                task_id, "SYSTEM",
                "Spend reporting unavailable for this provider — budget cannot "
                "be enforced; the iteration cap (HERMES_MAX_ITERATIONS) is the "
                "only guard.",
            )
        # Configurable so e2e-budget can hold the task open across a poll.
        await asyncio.sleep(float(os.environ.get("HERMES_STUB_DELAY_S", "1")))
        if task_store.state_of(task_id) != "running":
            return  # cancelled mid-sleep (budget breaker or user cancel)
        task_store.complete(
            task_id,
            f"[stub] Hermes processed: {prompt[:120]}",
            {"engineUsed": "hermes-stub", "costUsd": cost},
        )
    except Exception as exc:  # noqa: BLE001
        task_store.fail(task_id, str(exc))


@mcp.tool()
async def submit_task(payload: dict) -> dict:
    """Validate -> persist -> spawn -> return immediately. A deep loop runs
    minutes-to-hours; an awaited MCP call would hold the stream hostage."""
    validate_gateway_request(payload)  # raises -> MCP isError, never a success string
    task_id = task_store.create(payload)
    asyncio.get_event_loop().create_task(run_hermes_loop(task_id, payload))
    return {"task_id": task_id, "state": "running"}


@mcp.tool()
async def get_task_status(task_id: str, since: int = 0) -> dict:
    """Incremental events after cursor `since` — the gateway relay pump.
    For a still-running task, injects live cost so the bridge's circuit
    breaker can act between polls (costUsd: null = unenforceable, never 0)."""
    from .hermes_runner import RUNNING, get_spend_usd

    status = task_store.status(task_id, since)
    if status.get("state") == "running":
        agent = RUNNING.get(task_id)
        # agent is None in stub mode → get_spend_usd reads HERMES_STUB_* flags.
        status.setdefault("telemetry", {})["costUsd"] = get_spend_usd(agent, task_id)
    return status


@mcp.tool()
async def cancel_task(task_id: str, reason: str = "cancelled") -> dict:
    """Interrupt a running task's agent loop and mark it failed. Idempotent on
    unknown or already-finished tasks. The single cancellation entry point."""
    from .hermes_runner import RUNNING

    state = task_store.state_of(task_id)
    if state is None:
        return {"status": "unknown", "task_id": task_id}
    if state != "running":
        return {"status": "noop", "state": state, "task_id": task_id}

    agent = RUNNING.get(task_id)
    if agent is not None:
        try:
            agent.interrupt(reason)
        except Exception as exc:  # noqa: BLE001
            task_store.emit(task_id, "SYSTEM", f"interrupt() raised: {exc}")
    task_store.emit(task_id, "SYSTEM", f"Task cancelled: {reason}")
    task_store.fail(task_id, f"CANCELLED: {reason}")
    return {"status": "cancelled", "task_id": task_id}


@mcp.tool()
async def draft_and_queue_skill(proposed_name: str, skill_markdown: str,
                                source_task_id: str | None = None) -> dict:
    """Overrides Hermes auto-deploy: drafts land in the approval queue, only
    a human decision writes to the skills directory."""
    queue_id = skill_queue.queue_skill(proposed_name, skill_markdown, source_task_id)
    if source_task_id:
        # Surfaces in the console as an approval row with allow/deny buttons.
        task_store.emit(
            source_task_id,
            "PENDING_APPROVAL",
            f"New skill drafted: {proposed_name}",
            {"queueId": queue_id, "skillName": proposed_name},
        )
    return {"status": "pending_approval", "queue_id": queue_id}


@mcp.tool()
async def decide_skill(queue_id: str, decision: str) -> dict:
    """Called by the gateway when the console operator approves/rejects."""
    return skill_queue.decide(queue_id, decision)


if __name__ == "__main__":
    # NEVER add uvicorn workers>1: the cancellation registry (hermes_runner.
    # RUNNING) and task SQLite assume one process. FastMCP runs single-process
    # uvicorn by default — keep it.
    mcp.run(transport="streamable-http")  # serves at /mcp
