"""Covers mcp_wrapper.hermes_runner: cost/spend helpers + pure config helpers.

Importing hermes_runner pulls the vendored agent locally (~5s heavy import,
NO network) and opens SQLite via task_store at import time — TORQCLAW_DATA_DIR
must already be set (conftest sets it at module top before collection).
HERMES_MODEL is left unset throughout this module (conftest pops it)."""
from mcp_wrapper import hermes_runner


# ---------------------------------------------------------------------------
# get_spend_usd — stub mode (agent is None)
# ---------------------------------------------------------------------------
def test_get_spend_usd_stub_no_env_defaults_zero(monkeypatch):
    monkeypatch.delenv("HERMES_STUB_COST_USD", raising=False)
    monkeypatch.delenv("HERMES_STUB_COST_UNAVAILABLE", raising=False)
    assert hermes_runner.get_spend_usd(None, "t1") == 0.0


def test_get_spend_usd_stub_cost_env(monkeypatch):
    monkeypatch.delenv("HERMES_STUB_COST_UNAVAILABLE", raising=False)
    monkeypatch.setenv("HERMES_STUB_COST_USD", "1.25")
    assert hermes_runner.get_spend_usd(None, "t1") == 1.25


def test_get_spend_usd_stub_unavailable_wins_over_cost(monkeypatch):
    """UNAVAILABLE takes precedence even when COST_USD is ALSO set."""
    monkeypatch.setenv("HERMES_STUB_COST_USD", "1.25")
    monkeypatch.setenv("HERMES_STUB_COST_UNAVAILABLE", "1")
    assert hermes_runner.get_spend_usd(None, "t1") is None


# ---------------------------------------------------------------------------
# get_spend_usd — real-agent path (fake agent objects, no network)
# ---------------------------------------------------------------------------
class _AgentWithMicros:
    def get_credits_spent_micros(self):
        return 2_000_000


class _AgentRaisesOnMicros:
    def get_credits_spent_micros(self):
        raise RuntimeError("no micros here")


def test_get_spend_usd_agent_credits_micros():
    agent = _AgentWithMicros()
    assert hermes_runner.get_spend_usd(agent, "t2") == 2.0


def test_get_spend_usd_agent_raises_falls_through_to_usage_delta(monkeypatch):
    agent = _AgentRaisesOnMicros()
    monkeypatch.setattr(hermes_runner, "_snapshot_account_usage_usd", lambda **kw: 5.0)
    hermes_runner._USAGE_BASELINE["t3"] = 2.0
    assert hermes_runner.get_spend_usd(agent, "t3") == 3.0


def test_get_spend_usd_usage_delta_clips_at_zero(monkeypatch):
    agent = _AgentRaisesOnMicros()
    monkeypatch.setattr(hermes_runner, "_snapshot_account_usage_usd", lambda **kw: 1.0)
    hermes_runner._USAGE_BASELINE["t4"] = 10.0
    assert hermes_runner.get_spend_usd(agent, "t4") == 0.0


def test_get_spend_usd_usage_delta_none_when_current_none(monkeypatch):
    agent = _AgentRaisesOnMicros()
    monkeypatch.setattr(hermes_runner, "_snapshot_account_usage_usd", lambda **kw: None)
    hermes_runner._USAGE_BASELINE["t5"] = 1.0
    assert hermes_runner.get_spend_usd(agent, "t5") is None


def test_get_spend_usd_usage_delta_none_when_baseline_missing(monkeypatch):
    agent = _AgentRaisesOnMicros()
    monkeypatch.setattr(hermes_runner, "_snapshot_account_usage_usd", lambda **kw: 5.0)
    hermes_runner._USAGE_BASELINE.pop("t6", None)
    assert hermes_runner.get_spend_usd(agent, "t6") is None


# ---------------------------------------------------------------------------
# _frontier_enabled_toolsets
# ---------------------------------------------------------------------------
def test_frontier_toolsets_default_research():
    assert hermes_runner._frontier_enabled_toolsets("AUTONOMOUS_RESEARCH") == ["web"]


def test_frontier_toolsets_default_complex_coding():
    assert hermes_runner._frontier_enabled_toolsets("COMPLEX_CODING") == [
        "web",
        "files",
        "terminal",
        "code_execution",
    ]


def test_frontier_toolsets_unknown_task_type_defaults_web():
    assert hermes_runner._frontier_enabled_toolsets("UNKNOWN_TYPE") == ["web"]


def test_frontier_toolsets_star_override_returns_none(monkeypatch):
    monkeypatch.setenv("HERMES_FRONTIER_TOOLSETS", "*")
    assert hermes_runner._frontier_enabled_toolsets("AUTONOMOUS_RESEARCH") is None


def test_frontier_toolsets_comma_override(monkeypatch):
    monkeypatch.setenv("HERMES_FRONTIER_TOOLSETS", "web, files")
    assert hermes_runner._frontier_enabled_toolsets("AUTONOMOUS_RESEARCH") == ["web", "files"]


def test_frontier_toolsets_file_intent_prompt_adds_files(monkeypatch):
    monkeypatch.delenv("HERMES_FRONTIER_TOOLSETS", raising=False)
    result = hermes_runner._frontier_enabled_toolsets(
        "AUTONOMOUS_RESEARCH", "please write a file called notes.md"
    )
    assert result == ["web", "files"]


# ---------------------------------------------------------------------------
# _provider_config
# ---------------------------------------------------------------------------
def test_provider_config_default(monkeypatch):
    monkeypatch.delenv("HERMES_CODING_MODEL", raising=False)
    monkeypatch.setenv("HERMES_MODEL", "deepseek-default")
    cfg = hermes_runner._provider_config("SUMMARIZATION")
    assert cfg["model"] == "deepseek-default"


def test_provider_config_complex_coding_with_override(monkeypatch):
    monkeypatch.setenv("HERMES_CODING_MODEL", "kimi-k2.7-code")
    monkeypatch.setenv("HERMES_CODING_PROVIDER", "moonshot")
    cfg = hermes_runner._provider_config("COMPLEX_CODING")
    assert cfg["model"] == "kimi-k2.7-code"
    assert cfg["provider"] == "moonshot"


def test_provider_config_complex_coding_without_override_falls_back_default(monkeypatch):
    monkeypatch.delenv("HERMES_CODING_MODEL", raising=False)
    monkeypatch.setenv("HERMES_MODEL", "deepseek-default")
    cfg = hermes_runner._provider_config("COMPLEX_CODING")
    assert cfg["model"] == "deepseek-default"


# ---------------------------------------------------------------------------
# _clip
# ---------------------------------------------------------------------------
def test_clip_short_string_unchanged():
    assert hermes_runner._clip("short") == "short"


def test_clip_long_string_truncated_with_suffix():
    s = "x" * 600
    clipped = hermes_runner._clip(s, n=500)
    assert clipped.startswith("x" * 500)
    assert clipped.endswith("[+100]")


# ---------------------------------------------------------------------------
# hermes_available — TUPLE SHAPE ONLY (G1R OQ2 mandatory). NEVER assert the
# boolean value: True locally (vendor present), False in CI (vendor absent).
# ---------------------------------------------------------------------------
def test_hermes_available_tuple_shape_only():
    ok, msg = hermes_runner.hermes_available()
    assert isinstance(ok, bool)
    assert msg is None or isinstance(msg, str)
