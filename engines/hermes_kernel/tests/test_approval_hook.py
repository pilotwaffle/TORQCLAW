"""Covers mcp_wrapper.approval_hook: the per-tool FRONTIER approval gate.
NEVER import hermes_runner here — this module must be testable in isolation
from the vendored agent."""
import re

import pytest

from mcp_wrapper import approval_hook


# ---------------------------------------------------------------------------
# _GATED regex vocabulary (mirrors the actual source:
# r"(write|edit|patch|move|create|append|delete|terminal|process|execute_code)")
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "tool_name",
    [
        "write_file",
        "edit_file",
        "apply_patch",
        "move_file",
        "create_dir",
        "append",
        "delete",
        "run_terminal",
        "kill_process",
        "execute_code",
    ],
)
def test_gated_regex_matches_write_capable_tools(tool_name):
    assert approval_hook._GATED.search(tool_name)


@pytest.mark.parametrize("tool_name", ["read_file", "web_search", "quote_get"])
def test_gated_regex_does_not_match_read_only_tools(tool_name):
    assert not approval_hook._GATED.search(tool_name)


# ---------------------------------------------------------------------------
# _requires_approval
# ---------------------------------------------------------------------------
def test_requires_approval_true_for_gated_tool_no_grant():
    assert approval_hook._requires_approval("write_file", set()) is True


def test_requires_approval_false_when_granted():
    assert approval_hook._requires_approval("write_file", {"write_file"}) is False


def test_requires_approval_false_for_non_gated_tool():
    assert approval_hook._requires_approval("read_file", set()) is False


# ---------------------------------------------------------------------------
# pre_tool_call hook decision flow
# ---------------------------------------------------------------------------
def test_hook_blocks_gated_tool_first_time_and_records_block():
    tid = "task-block-1"
    events = []
    approval_hook.set_task_context(
        tid, granted=[], emit=lambda *a: events.append(a), enabled=True
    )
    result = approval_hook.pre_tool_call("write_file", args={"path": "x"}, task_id=tid)
    assert result["action"] == "block"
    blocked = approval_hook.was_blocked(tid)
    assert blocked == {"toolName": "write_file", "args": {"path": "x"}}
    assert len(events) == 1


def test_hook_second_gated_call_same_task_still_blocks_but_first_block_only():
    tid = "task-block-2"
    events = []
    approval_hook.set_task_context(
        tid, granted=[], emit=lambda *a: events.append(a), enabled=True
    )
    first = approval_hook.pre_tool_call("write_file", args={"a": 1}, task_id=tid)
    second = approval_hook.pre_tool_call("delete", args={"b": 2}, task_id=tid)
    assert first["action"] == "block"
    assert second["action"] == "block"
    # First-block-only: was_blocked still reflects the FIRST blocked tool, and
    # no additional emit fired for the second gated call.
    blocked = approval_hook.was_blocked(tid)
    assert blocked == {"toolName": "write_file", "args": {"a": 1}}
    assert len(events) == 1


def test_hook_granted_tool_returns_none():
    tid = "task-granted-1"
    events = []
    approval_hook.set_task_context(
        tid, granted=["write_file"], emit=lambda *a: events.append(a), enabled=True
    )
    result = approval_hook.pre_tool_call("write_file", args={}, task_id=tid)
    assert result is None
    assert approval_hook.was_blocked(tid) is None
    assert events == []


def test_hook_disabled_returns_none():
    tid = "task-disabled-1"
    events = []
    approval_hook.set_task_context(
        tid, granted=[], emit=lambda *a: events.append(a), enabled=False
    )
    result = approval_hook.pre_tool_call("write_file", args={}, task_id=tid)
    assert result is None
    assert approval_hook.was_blocked(tid) is None
    assert events == []


def test_hook_unknown_task_returns_none():
    result = approval_hook.pre_tool_call("write_file", args={}, task_id="never-registered")
    assert result is None


def test_hook_non_gated_tool_returns_none():
    tid = "task-nongated-1"
    events = []
    approval_hook.set_task_context(
        tid, granted=[], emit=lambda *a: events.append(a), enabled=True
    )
    result = approval_hook.pre_tool_call("web_search", args={}, task_id=tid)
    assert result is None
    assert approval_hook.was_blocked(tid) is None
    assert events == []


# ---------------------------------------------------------------------------
# OPTIONAL: register() — only kept because it's clean (a small stub module).
# ---------------------------------------------------------------------------
def test_register_appends_hook_and_is_idempotent(monkeypatch):
    import sys
    import types

    approval_hook._registered = False

    hooks: dict = {}

    class _FakePluginManager:
        def __init__(self):
            self._hooks = hooks

    fake_mgr = _FakePluginManager()

    stub = types.ModuleType("hermes_cli.plugins")
    stub.get_plugin_manager = lambda: fake_mgr
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins", stub)
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))

    first = approval_hook.register()
    assert first is True
    assert approval_hook.pre_tool_call in hooks.get("pre_tool_call", [])

    # Idempotent: calling again does not append a second time and still True.
    count_before = len(hooks["pre_tool_call"])
    second = approval_hook.register()
    assert second is True
    assert len(hooks["pre_tool_call"]) == count_before
