"""Focused process-restart evidence for the Phase-1 ledger recovery fence."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "ops" / "phase1_restart_evidence.py"
ENGINE_ROOT = ROOT / "engines" / "hermes_kernel"


def _run_harness(tmp_path: Path, scenario: str) -> dict:
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        [str(ENGINE_ROOT), env.get("PYTHONPATH", "")]
    ).rstrip(os.pathsep)
    completed = subprocess.run(
        [sys.executable, str(HARNESS), "--scenario", scenario,
         "--workdir", str(tmp_path), "--timeout-seconds", "10"],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=25,
        check=False,
    )
    assert completed.returncode == 0, (
        f"harness failed ({completed.returncode})\nstdout={completed.stdout}\n"
        f"stderr={completed.stderr}"
    )
    return json.loads(completed.stdout)


def _single_evidence(report: dict) -> dict:
    assert report["bounded"] is True
    assert report["maxScenarios"] == 2
    assert len(report["scenarios"]) == 1
    scenario = report["scenarios"][0]
    assert scenario["seedExitCode"] == 0
    assert scenario["recoveryExitCode"] == 0
    return scenario["evidence"]


def test_pre_dispatch_crash_is_recovered_as_orphan(tmp_path: Path):
    evidence = _single_evidence(_run_harness(tmp_path, "pre_dispatch_orphan"))

    assert evidence["activeBeforeRecovery"]["epoch"] == 0
    assert evidence["activeAfterRecovery"] is None
    assert evidence["recovery"]["state"] == "orphaned"
    assert evidence["taskStatus"] == "orphaned"
    assert evidence["attempts"] == [{
        "attemptId": evidence["activeBeforeRecovery"]["attemptId"],
        "epoch": 0,
        "state": "orphaned",
        "dispatchAttempted": 0,
    }]
    assert evidence["outboxKinds"].count("pre_dispatch_recovered") == 1
    assert "attempt_completed" not in evidence["outboxKinds"]
    assert {event["kind"] for event in evidence["outbox"]} == {
        "attempt_created", "pre_dispatch_recovered",
    }


def test_post_dispatch_crash_closes_terminal_uncertainty(tmp_path: Path):
    evidence = _single_evidence(_run_harness(tmp_path, "post_dispatch_uncertainty"))

    assert evidence["activeBeforeRecovery"]["epoch"] == 0
    assert evidence["activeBeforeRecovery"]["dispatchAttempted"] == 1
    assert evidence["activeAfterRecovery"] is None
    assert evidence["recovery"] == {
        "attemptId": evidence["activeBeforeRecovery"]["attemptId"],
        "epoch": 0,
        "outcome": "cancelled_uncertain",
        "state": "terminal",
        "taskId": evidence["activeBeforeRecovery"]["taskId"],
    }
    assert evidence["taskStatus"] == "cancelled_uncertain"
    assert evidence["attempts"] == [{
        "attemptId": evidence["activeBeforeRecovery"]["attemptId"],
        "epoch": 0,
        "state": "terminal",
        "dispatchAttempted": 1,
    }]
    assert evidence["outboxKinds"].count("dispatch_attempted") == 1
    assert evidence["outboxKinds"].count("attempt_completed") == 1
    assert "pre_dispatch_recovered" not in evidence["outboxKinds"]
    completion = [event for event in evidence["outbox"]
                  if event["kind"] == "attempt_completed"]
    assert completion[0]["payload"]["outcome"] == "cancelled_uncertain"


@pytest.mark.parametrize("scenario", ["pre_dispatch_orphan", "post_dispatch_uncertainty"])
def test_all_mode_runs_only_the_bounded_phase1_scenarios(tmp_path: Path, scenario: str):
    report = _run_harness(tmp_path / scenario, "all")
    assert report["timeoutSeconds"] == 10
    assert [item["scenario"] for item in report["scenarios"]] == [
        "pre_dispatch_orphan", "post_dispatch_uncertainty",
    ]
