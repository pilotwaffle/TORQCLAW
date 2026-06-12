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
    """Integration point with the vendored submodule (vendor/hermes-agent).
    v1 stub proves the transport + cursor plumbing end-to-end."""
    try:
        prompt = payload["payload"]["prompt"]
        task_type = payload["payload"]["taskType"]
        task_store.emit(task_id, "SYSTEM", f"Hermes loop booted for {task_type}")

        # --- Replace with the real loop: ---
        # import sys; sys.path.insert(0, str(Path(__file__).parents[1] / "vendor" / "hermes-agent"))
        # from hermes_agent import Agent
        # result = await Agent(...).execute(prompt, on_event=lambda t, m: task_store.emit(task_id, t, m))
        await asyncio.sleep(1)
        result = f"[stub] Hermes processed: {prompt[:120]}"
        # ------------------------------------

        task_store.complete(task_id, result, {"engineUsed": "hermes-stub"})
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
    """Incremental events after cursor `since` — the gateway relay pump."""
    return task_store.status(task_id, since)


@mcp.tool()
async def draft_and_queue_skill(proposed_name: str, skill_markdown: str,
                                source_task_id: str | None = None) -> dict:
    """Overrides Hermes auto-deploy: drafts land in the approval queue, only
    a human decision writes to the skills directory."""
    queue_id = skill_queue.queue_skill(proposed_name, skill_markdown, source_task_id)
    return {"status": "pending_approval", "queue_id": queue_id}


@mcp.tool()
async def decide_skill(queue_id: str, decision: str) -> dict:
    """Called by the gateway when the console operator approves/rejects."""
    return skill_queue.decide(queue_id, decision)


if __name__ == "__main__":
    mcp.run(transport="streamable-http")  # serves at /mcp
