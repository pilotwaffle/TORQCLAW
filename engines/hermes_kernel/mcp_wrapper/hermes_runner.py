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
import re
import sys
import time
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

# Throttle the provider usage API. get_spend_usd runs on EVERY bridge poll
# (~2s); the providers' usage endpoints rate-limit (429), so cache the snapshot
# and only refresh past this interval. Between refreshes the breaker reuses the
# last value — a worst-case ~20s lag before it sees fresh spend, acceptable.
_USAGE_MIN_INTERVAL_S = float(os.environ.get("HERMES_USAGE_POLL_S", "20"))
_usage_cache: dict[str, float | None] = {"value": None, "at": 0.0}


def _snapshot_account_usage_usd(*, force: bool = False) -> float | None:
    """Account-level total spend in USD from the provider, or None if the
    provider/credentials don't expose it. Account-level, so concurrent tasks
    share attribution — acceptable for single-operator v1.

    Throttled to _USAGE_MIN_INTERVAL_S to avoid 429s; pass force=True to bypass
    the cache (used once at task start to set the baseline)."""
    now = time.monotonic()
    if not force and (now - _usage_cache["at"]) < _USAGE_MIN_INTERVAL_S:
        return _usage_cache["value"]

    try:
        from agent.account_usage import fetch_account_usage  # type: ignore
    except Exception:
        _usage_cache.update(value=None, at=now)
        return None
    snap = fetch_account_usage(
        os.environ.get("HERMES_PROVIDER"),
        base_url=os.environ.get("HERMES_BASE_URL") or None,
        api_key=os.environ.get("HERMES_API_KEY") or None,
    )
    value: float | None = None
    if snap is not None:
        # OpenRouter snapshot carries "API key usage: $X.XX total" in details.
        import re
        for detail in getattr(snap, "details", ()) or ():
            m = re.search(r"usage:\s*\$([0-9]+(?:\.[0-9]+)?)\s*total", str(detail))
            if m:
                try:
                    value = float(m.group(1))
                except ValueError:
                    value = None
                break
    _usage_cache.update(value=value, at=now)
    return value


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


# FRONTIER toolset allowlist by task type. Hermes runs its OWN tools on the
# cloud tier — outside TorqClaw's approval gate and workspace sandbox — and it
# has no per-tool veto callback (notify-only). So we constrain at the TOOLSET
# boundary, the only safe lever the vendored API gives us:
#   - Research / summarize / extract: WEB ONLY. No terminal, no code exec, no
#     filesystem. A cloud research task has no business running shell commands
#     on the host (the leak surfaced in testing: web lookups silently spawned
#     terminal/execute_code/read_file ungated).
#   - Coding: web + files + terminal + code — genuinely needs them; opt-in.
# Override per deployment with HERMES_FRONTIER_TOOLSETS (comma list) or set it to
# "*" to restore upstream's full default (NOT recommended on a shared machine).
_FRONTIER_TOOLSETS = {
    "AUTONOMOUS_RESEARCH": ["web"],
    "SUMMARIZATION": ["web"],
    "DATA_EXTRACTION": ["web"],
    "ROUTINE_AUTOMATION": ["web"],
    "COMPLEX_CODING": ["web", "files", "terminal", "code_execution"],
}


# Intent signals that a task needs to touch the filesystem even when the
# classifier labeled it research/summarize/extract. Without this, "write a file"
# lands in a web-only toolset and can NEVER succeed (it has no write_file). The
# `files` toolset IS approval-gated (P6 pre_tool_call hook), so granting it stays
# safe — a write still requires the human's Allow once.
_FILE_INTENT = re.compile(
    r"\b(write|save|create|append|edit|update|delete|read|open)\b.{0,40}\b(file|notes?|\.txt|\.md|\.json|\.csv|workspace|document)",
    re.IGNORECASE,
)


def _frontier_enabled_toolsets(task_type: str, prompt: str = "") -> list[str] | None:
    """The toolset allowlist for a FRONTIER task. None = upstream default (only
    when the operator explicitly sets HERMES_FRONTIER_TOOLSETS='*')."""
    override = os.environ.get("HERMES_FRONTIER_TOOLSETS")
    if override:
        if override.strip() == "*":
            return None  # upstream default — full toolset
        return [t.strip() for t in override.split(",") if t.strip()]
    base = list(_FRONTIER_TOOLSETS.get(task_type, ["web"]))
    # File-intent override: add the (gated) files toolset so the task can act.
    if _FILE_INTENT.search(prompt or "") and "files" not in base:
        base.append("files")
    return base


def _provider_config(task_type: str) -> dict:
    """Pick the provider/model/key/base for this task. COMPLEX_CODING uses the
    HERMES_CODING_* override when set (e.g. Kimi K2.7 Code — long context +
    agentic coding); everything else uses the default HERMES_* (DeepSeek)."""
    if task_type == "COMPLEX_CODING" and os.environ.get("HERMES_CODING_MODEL"):
        return {
            "model": os.environ.get("HERMES_CODING_MODEL", ""),
            "provider": os.environ.get("HERMES_CODING_PROVIDER"),
            "api_key": os.environ.get("HERMES_CODING_API_KEY"),
            "base_url": os.environ.get("HERMES_CODING_BASE_URL"),
        }
    return {
        "model": os.environ.get("HERMES_MODEL", ""),
        "provider": os.environ.get("HERMES_PROVIDER"),
        "api_key": os.environ.get("HERMES_API_KEY"),
        "base_url": os.environ.get("HERMES_BASE_URL"),
    }


def run_hermes_sync(task_id: str, payload: dict) -> dict:
    """BLOCKING — call via asyncio.to_thread. Returns {result, telemetry}."""
    req = payload["payload"]
    prompt: str = req["prompt"]
    context: str | None = req.get("assembledContext")
    task_type: str = req.get("taskType", "ROUTINE_AUTOMATION")
    granted: list[str] = req.get("grantedTools", []) or []

    pconf = _provider_config(task_type)
    task_store.emit(task_id, "SYSTEM", f"Model: {pconf['provider']}/{pconf['model']}")

    enabled = _frontier_enabled_toolsets(task_type, prompt)
    task_store.emit(
        task_id, "SYSTEM",
        f"Cloud tools enabled: {', '.join(enabled) if enabled else 'all (override)'}",
    )

    # Per-tool approval gate on the cloud tier (fork-free, via the vendored
    # pre_tool_call plugin hook). A write-capable Hermes tool without a grant is
    # BLOCKED before it runs; the task ends as blocked and the bridge turns that
    # into the single terminal PENDING_APPROVAL (invariant 7). Enabled only when
    # the hook actually registered against the vendored plugin system.
    from . import approval_hook
    gate_on = approval_hook.register()
    approval_hook.set_task_context(
        task_id,
        granted=granted,
        emit=lambda t, m, meta=None: task_store.emit(task_id, t, m, meta),
        enabled=gate_on,
    )

    agent = AIAgent(
        # Provider config is env-driven + per-task (coding override). Hermes
        # supports many backends; see _provider_config.
        model=pconf["model"],
        provider=pconf["provider"],
        api_key=pconf["api_key"],
        base_url=pconf["base_url"],
        max_iterations=int(os.environ.get("HERMES_MAX_ITERATIONS", "30")),
        # Per-task toolset allowlist — keeps cloud research off the host shell.
        enabled_toolsets=enabled,
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
    _USAGE_BASELINE[task_id] = _snapshot_account_usage_usd(force=True)
    # Anti-fabrication grounding: the model claimed to have analyzed files a tool
    # had just reported missing (the "8,290 examples" incident). Pin it to real
    # tool results. Prepend to the gateway-assembled context so it survives.
    grounding = (
        "GROUNDING RULES (absolute — violating these is a critical failure):\n"
        "1. NEVER claim to have performed a tool action you did not actually "
        "perform. Do not say 'written', 'created', 'saved', 'file written to "
        "...', or show file contents as if written, unless a REAL write_file/"
        "patch tool call returned success. Narrating a fake action is forbidden.\n"
        "2. To write/read a file you MUST emit the actual tool call and wait for "
        "its result. If you have no such tool available, say exactly: 'I don't "
        "have a file tool available for this task' — do NOT pretend, and do NOT "
        "dump the would-be file contents as a substitute.\n"
        "3. Only state facts from a real tool result or your own knowledge. "
        "NEVER invent file contents, statistics, counts, datasets, or analysis. "
        "Specifically: do not invent details about the user, their data, or "
        "training-example counts you did not read from a tool.\n"
        "4. If a tool reports missing/error/empty, report that plainly and stop. "
        "A truthful failure beats a confident fabrication.\n\n"
    )
    system_message = grounding + (context or "")
    try:
        result = agent.run_conversation(
            prompt,
            system_message=system_message,  # grounding + gateway tiered memory
            task_id=task_id,
        )
        # If the approval hook blocked a tool, this run is BLOCKED, not done —
        # surface blockedOn so run_hermes_loop emits the terminal PENDING_APPROVAL
        # instead of completing with a (likely fabricated-around-the-block) answer.
        blocked = approval_hook.was_blocked(task_id)
        telemetry = {
            "engineUsed": f"hermes:{pconf['model'] or 'default'}",
            "messageCount": len(result.get("messages", [])),
            "costUsd": get_spend_usd(agent, task_id),
        }
        if blocked:
            telemetry["blockedOn"] = blocked["toolName"]
            telemetry["blockedArgs"] = blocked["args"]
        return {"result": result.get("final_response", ""), "telemetry": telemetry}
    finally:
        approval_hook.clear_task_context(task_id)
        RUNNING.pop(task_id, None)
        _USAGE_BASELINE.pop(task_id, None)
        try:
            agent.close()
        except Exception:
            pass
