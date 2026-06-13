"""Real Hermes wiring: maps GatewayRequest -> AIAgent, hijacks the agent's
first-class callbacks into task_store cursor events.

Upstream API (verified against vendor/hermes-agent @ shallow HEAD):
  - run_agent.AIAgent(**kwargs)  — constructor forwards to agent.agent_init
  - agent.run_conversation(user_message, system_message=..., task_id=...)
      -> {"final_response": str, "messages": [...]}   (SYNCHRONOUS)
  - callbacks: tool_start_callback(call_id, name, args)
               tool_complete_callback(call_id, name, args, result)
               status_callback(kind, msg)
"""
import os
import sys
from pathlib import Path

from . import task_store

VENDOR = Path(__file__).parents[1] / "vendor" / "hermes-agent"

_import_error: str | None = None
AIAgent = None
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))
    try:
        from run_agent import AIAgent  # type: ignore  # noqa: E402
    except Exception as exc:  # missing lazy deps, etc.
        _import_error = f"{type(exc).__name__}: {exc}"
else:
    _import_error = f"vendor dir missing: {VENDOR}"


def hermes_available() -> tuple[bool, str | None]:
    return AIAgent is not None, _import_error


def _clip(obj, n: int = 500) -> str:
    s = str(obj)
    return s if len(s) <= n else s[:n] + f"…[+{len(s) - n}]"


def run_hermes_sync(task_id: str, payload: dict) -> dict:
    """BLOCKING — call via asyncio.to_thread. Returns {result, telemetry}."""
    req = payload["payload"]
    prompt: str = req["prompt"]
    context: str | None = req.get("assembledContext")

    agent = AIAgent(
        # Provider config is env-driven; Hermes supports many backends.
        model=os.environ.get("HERMES_MODEL", ""),
        provider=os.environ.get("HERMES_PROVIDER"),
        api_key=os.environ.get("HERMES_API_KEY"),
        base_url=os.environ.get("HERMES_BASE_URL"),
        max_iterations=int(os.environ.get("HERMES_MAX_ITERATIONS", "30")),
        # TORQCLAW's router owns orchestration; Hermes sub-agents run outside
        # our callback hijack, so delegation burns budget invisibly.
        disabled_toolsets=[
            t.strip()
            for t in os.environ.get("HERMES_DISABLED_TOOLSETS", "delegation").split(",")
            if t.strip()
        ] or None,
        # TORQCLAW owns memory (FTS5 layer) and context files; batch_runner
        # uses the same isolation flags for programmatic runs.
        skip_memory=True,
        skip_context_files=True,
        save_trajectories=False,
        quiet_mode=True,
        session_id=task_id,
        # ── The hijack: first-class callbacks -> cursor events ──
        tool_start_callback=lambda cid, name, args: task_store.emit(
            task_id, "TOOL_CALL", f"Executing {name}", {"call_id": cid, "args": _clip(args)},
        ),
        tool_complete_callback=lambda cid, name, args, result: task_store.emit(
            task_id, "SYSTEM", f"Tool {name} completed", {"call_id": cid, "result": _clip(result)},
        ),
        status_callback=lambda kind, msg: task_store.emit(
            task_id, "SYSTEM", f"[{kind}] {_clip(msg, 300)}",
        ),
    )
    try:
        result = agent.run_conversation(
            prompt,
            system_message=context,  # gateway-assembled tiered memory
            task_id=task_id,
        )
        return {
            "result": result.get("final_response", ""),
            "telemetry": {
                "engineUsed": f"hermes:{os.environ.get('HERMES_MODEL', 'default')}",
                "messageCount": len(result.get("messages", [])),
            },
        }
    finally:
        try:
            agent.close()
        except Exception:
            pass
