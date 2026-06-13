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


# Live agent registry: lets cancel_task reach the AIAgent.interrupt() of a
# running task from another MCP request. Single-process only (see server.py).
RUNNING: dict[str, "AIAgent"] = {}

# Per-task account-usage baseline for the provider-delta cost fallback.
_USAGE_BASELINE: dict[str, float | None] = {}


def _snapshot_account_usage_usd() -> float | None:
    """Account-level total spend in USD from the provider, or None if the
    provider/credentials don't expose it. Account-level, so concurrent tasks
    share attribution — acceptable for single-operator v1."""
    try:
        from agent.account_usage import fetch_account_usage  # type: ignore
    except Exception:
        return None
    snap = fetch_account_usage(
        os.environ.get("HERMES_PROVIDER"),
        base_url=os.environ.get("HERMES_BASE_URL") or None,
        api_key=os.environ.get("HERMES_API_KEY") or None,
    )
    if snap is None:
        return None
    # OpenRouter snapshot carries "API key usage: $X.XX total" in details.
    import re
    for detail in getattr(snap, "details", ()) or ():
        m = re.search(r"usage:\s*\$([0-9]+(?:\.[0-9]+)?)\s*total", str(detail))
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                return None
    return None


def get_spend_usd(agent, task_id: str) -> float | None:
    """USD spent so far on this task. Source chain (verified vs vendored src):
      1. agent.get_credits_spent_micros()/1e6 — Nous portal; micros ARE USD.
      2. delta of account_usage total (OpenRouter/Anthropic) since task start.
      3. None — caller MUST surface that the budget is unenforceable, never 0.
    Stub mode returns HERMES_STUB_COST_USD if set, else 0.0 (stub IS free)."""
    if agent is None:  # stub mode
        if os.environ.get("HERMES_STUB_COST_UNAVAILABLE") == "1":
            return None
        return float(os.environ.get("HERMES_STUB_COST_USD", "0.0"))

    try:
        micros = agent.get_credits_spent_micros()
    except Exception:
        micros = None
    if micros is not None:
        return float(micros) / 1_000_000.0

    current = _snapshot_account_usage_usd()
    baseline = _USAGE_BASELINE.get(task_id)
    if current is not None and baseline is not None:
        return max(0.0, current - baseline)
    return None


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
    # Register BEFORE run so cancel_task can interrupt; baseline the usage
    # delta source in case credits-micros is unavailable for this provider.
    RUNNING[task_id] = agent
    _USAGE_BASELINE[task_id] = _snapshot_account_usage_usd()
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
                "costUsd": get_spend_usd(agent, task_id),
            },
        }
    finally:
        RUNNING.pop(task_id, None)
        _USAGE_BASELINE.pop(task_id, None)
        try:
            agent.close()
        except Exception:
            pass
