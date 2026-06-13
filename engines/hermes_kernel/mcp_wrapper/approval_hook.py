"""Per-tool approval on the FRONTIER (cloud) tier — fork-free.

Hermes runs its own tool loop synchronously and exposes no per-tool veto in its
callbacks. But the vendored plugin system has an official pre_tool_call hook
(hermes_cli.plugins.get_pre_tool_call_block_message) whose documented purpose
includes "approval workflows": a hook returning {"action":"block","message":..}
aborts a tool BEFORE it executes. We register such a hook PROGRAMMATICALLY (no
plugin directory, no vendor edit — invariant 5 "wrap, don't rewrite" holds).

Semantics mirror the LOCAL_EDGE gate (P2): fail-fast. The first gated tool with
no grant is blocked; the engine marks the task blocked; the bridge turns that
into the single terminal PENDING_APPROVAL (invariant 7); APPROVE re-mints the
task with grantedTools incl the tool, which this hook then honors.
"""
import re
import threading

# Write-capable Hermes tools that require a human grant on FRONTIER. Mirrors the
# LOCAL_EDGE approval patterns (write/edit/move/create/append/delete) plus the
# host-affecting tools a cloud task should never run unprompted.
_GATED = re.compile(
    r"(write|edit|patch|move|create|append|delete|terminal|process|execute_code)",
    re.IGNORECASE,
)

# Per-task approval context, keyed by task_id. Set by run_hermes_sync before the
# agent runs; read by the hook (which runs in the agent's thread). A task that
# gets blocked records the (tool, args) so the engine can emit the right event.
_lock = threading.Lock()
_ctx: dict[str, dict] = {}


def set_task_context(task_id: str, granted: list[str], emit, enabled: bool) -> None:
    """Register a task's grant set + an emit(type, msg, meta) callback. enabled
    gates the whole mechanism (FRONTIER only; off in stub/local)."""
    with _lock:
        _ctx[task_id] = {
            "granted": set(granted or []),
            "emit": emit,
            "enabled": enabled,
            "blocked": None,  # set to {toolName, args} on the first block
        }


def clear_task_context(task_id: str) -> None:
    with _lock:
        _ctx.pop(task_id, None)


def was_blocked(task_id: str) -> dict | None:
    with _lock:
        c = _ctx.get(task_id)
        return c["blocked"] if c else None


def _requires_approval(tool_name: str, granted: set[str]) -> bool:
    if tool_name in granted:
        return False
    return bool(_GATED.search(tool_name or ""))


def pre_tool_call(tool_name: str, args=None, task_id: str = "", **_kw):
    """The registered hook. Returns a block directive for a gated, ungranted
    tool; None otherwise (observer-safe — unknown tasks pass through)."""
    with _lock:
        c = _ctx.get(task_id)
        if not c or not c["enabled"]:
            return None
        if not _requires_approval(tool_name, c["granted"]):
            return None
        # Record the FIRST block only — fail-fast, one approval per blocked run.
        if c["blocked"] is None:
            c["blocked"] = {"toolName": tool_name, "args": args or {}}
            emit = c["emit"]
        else:
            emit = None
    # Emit outside the lock (the emit writes to SQLite).
    if emit is not None:
        emit(
            "SYSTEM",
            f"Tool {tool_name} blocked pending approval",
            {"toolName": tool_name},
        )
    return {
        "action": "block",
        "message": (
            f"Tool '{tool_name}' requires one-time human approval and was not "
            "pre-granted. It has been blocked. STOP and report that you are "
            "waiting for approval to use this tool — do not attempt other "
            "write/terminal tools."
        ),
    }


_registered = False


def register() -> bool:
    """Append the pre_tool_call hook to the global plugin manager. Idempotent.
    Returns False if the vendored plugin system isn't importable (e.g. stub)."""
    global _registered
    if _registered:
        return True
    try:
        from hermes_cli.plugins import get_plugin_manager  # type: ignore
    except Exception:
        return False
    mgr = get_plugin_manager()
    mgr._hooks.setdefault("pre_tool_call", []).append(pre_tool_call)
    _registered = True
    return True
