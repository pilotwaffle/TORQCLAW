"""Covers mcp_wrapper.server.apply_workspace_root: the process-cwd anchor that
keeps vendored file-tool writes inside the operator-visible workspace instead
of the engine checkout. All assertions restore the original cwd — a leaked
chdir would corrupt every later test's relative-path behavior."""
import os
from pathlib import Path

import pytest

from mcp_wrapper import server


@pytest.fixture
def restore_cwd():
    original = os.getcwd()
    yield
    os.chdir(original)


def test_unset_env_is_noop(monkeypatch, restore_cwd):
    monkeypatch.delenv("TORQCLAW_WORKSPACE_ROOT", raising=False)
    before = os.getcwd()
    server.apply_workspace_root()
    assert os.getcwd() == before


def test_blank_env_is_noop(monkeypatch, restore_cwd):
    monkeypatch.setenv("TORQCLAW_WORKSPACE_ROOT", "   ")
    before = os.getcwd()
    server.apply_workspace_root()
    assert os.getcwd() == before


def test_chdirs_into_created_workspace(monkeypatch, tmp_path, restore_cwd):
    root = tmp_path / "nested" / "workspace"  # does not exist yet — must be created
    monkeypatch.setenv("TORQCLAW_WORKSPACE_ROOT", str(root))
    server.apply_workspace_root()
    assert Path(os.getcwd()).resolve() == root.resolve()
    assert root.is_dir()


def test_unusable_root_warns_and_keeps_cwd(monkeypatch, tmp_path, capsys, restore_cwd):
    before = os.getcwd()
    # A path whose parent is a regular file: mkdir must fail with OSError.
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    monkeypatch.setenv("TORQCLAW_WORKSPACE_ROOT", str(blocker / "child"))
    server.apply_workspace_root()
    assert os.getcwd() == before
    assert "TORQCLAW_WORKSPACE_ROOT unusable" in capsys.readouterr().err
