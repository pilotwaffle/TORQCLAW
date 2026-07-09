"""Shared pytest fixtures for the hermes_kernel test suite.

IMPORTANT: env vars are set at MODULE TOP (not inside a fixture) so they are
live before pytest collects sibling test modules that do top-level
`import mcp_wrapper.*` (task_store/skill_queue open SQLite connections and
mkdir their data dirs at import time, keyed off these vars).
"""
import importlib
import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module-top env setup — must run before ANY mcp_wrapper.* import anywhere in
# the test session (including sibling test modules collected after this one).
# ---------------------------------------------------------------------------
_SESSION_TMP = Path(tempfile.mkdtemp(prefix="torqclaw-pytest-"))

_DATA_DIR = _SESSION_TMP / "data"
_SKILLS_DIR = _SESSION_TMP / "skills"
_DATA_DIR.mkdir(parents=True, exist_ok=True)
_SKILLS_DIR.mkdir(parents=True, exist_ok=True)

# Never "" — task_store/skill_queue use `os.environ.get(...) or default`, so an
# empty string would silently fall through to the real ~/.torqclaw / ~/.hermes
# dirs and pollute the operator's actual data.
os.environ["TORQCLAW_DATA_DIR"] = str(_DATA_DIR)
os.environ["HERMES_SKILLS_DIR"] = str(_SKILLS_DIR)

# Defensive: ambient env (operator's shell, CI secrets, etc.) must never flip a
# test into the real provider path. Pop before any hermes_runner import.
os.environ.pop("HERMES_MODEL", None)
os.environ.pop("HERMES_STUB_COST_USD", None)
os.environ.pop("HERMES_STUB_COST_UNAVAILABLE", None)


@pytest.fixture
def fresh_module():
    """Return a function that force-reimports a module under the CURRENT env.
    Use for tests that need a clean binding (e.g. DATA_DIR baked in at import).
    """

    def _reimport(name: str):
        sys.modules.pop(name, None)
        return importlib.import_module(name)

    return _reimport


@pytest.fixture(scope="session", autouse=True)
def _close_task_store_conn_at_session_end():
    """Windows WAL (-wal/-shm) sidecar files hold an OS-level lock on the
    sqlite3 connection until it's closed; the session temp dir teardown would
    otherwise raise PermissionError on Windows. Close defensively at the very
    end of the session."""
    yield
    try:
        from mcp_wrapper import task_store

        task_store._conn.close()
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _reset_module_globals():
    """Per-test isolation for module-global mutable state in modules that may
    already be imported by a prior test in the same session. Each guarded with
    try/except since the module may not be imported at all in a given test."""
    yield
    try:
        from mcp_wrapper import approval_hook

        approval_hook._ctx.clear()
        approval_hook._registered = False
    except Exception:
        pass
    try:
        from mcp_wrapper import hermes_runner

        hermes_runner._USAGE_BASELINE.clear()
        hermes_runner._usage_cache.update(value=None, at=0.0)
    except Exception:
        pass
