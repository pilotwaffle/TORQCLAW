"""Bounded, offline Phase-1 restart/crash evidence harness.

The harness deliberately uses only the existing AttemptLedger authority APIs.
The seed worker commits its durable state and exits with ``os._exit`` so the
recovery worker is a fresh process, not an in-process reset.  No provider is
configured or invoked.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ENGINE_ROOT = ROOT / "engines" / "hermes_kernel"
SCENARIOS = ("pre_dispatch_orphan", "post_dispatch_uncertainty")
DEFAULT_TIMEOUT_SECONDS = 10
MAX_TIMEOUT_SECONDS = 30


def _plan(task_id: str, now_ms: int) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "taskId": task_id,
        "chainId": "phase1-restart-evidence",
        "eligibleProviderIds": ["primary", "fallback"],
        "privacyClass": "standard",
        "privacyHash": "a" * 64,
        "policyHash": "b" * 64,
        "contextHash": "c" * 64,
        "grantHash": "d" * 64,
        "taskDeadlineMs": now_ms + 60_000,
        "attemptTimeoutMs": 1_000,
        "transitionLimit": 1,
        "budgetMicroUsd": None,
        "providerCeilings": {"primary": 1, "fallback": 1},
        "featurePolicyRevision": "phase1-restart-evidence",
        "planRevision": "1",
    }


def _load_ledger(path: Path):
    sys.path.insert(0, str(ENGINE_ROOT))
    from mcp_wrapper.attempt_ledger import AttemptLedger

    return AttemptLedger(path)


def _worker_seed(db_path: Path, task_id: str, scenario: str) -> None:
    ledger = _load_ledger(db_path)
    active = ledger.create_initial(task_id, _plan(task_id, int(time.time() * 1000)))
    if scenario == "post_dispatch_uncertainty":
        if ledger.mark_dispatch_attempted(active) is None:
            raise RuntimeError("durable dispatch fence was not recorded")
    # create_initial/mark_dispatch_attempted commit before returning.  Exiting
    # without cleanup is intentional: this is the crash boundary under test.
    os._exit(0)


def _worker_recover(db_path: Path, task_id: str) -> None:
    ledger = _load_ledger(db_path)
    active = ledger.get_active(task_id)
    if active is None:
        raise RuntimeError("restart could not find the persisted active tuple")

    recovery = ledger.recover_pre_dispatch_if_active(active)
    task = ledger.get_task(task_id)
    attempts = ledger.list_attempts(task_id)
    events = ledger.read_outbox(task_id)
    report = {
        "activeBeforeRecovery": active,
        "activeAfterRecovery": ledger.get_active(task_id),
        "recovery": recovery,
        "taskStatus": task["status"] if task else None,
        "attempts": [
            {
                "attemptId": attempt["attemptId"],
                "epoch": attempt["epoch"],
                "state": attempt["state"],
                "dispatchAttempted": attempt["dispatchAttempted"],
            }
            for attempt in attempts
        ],
        "outboxKinds": [event["kind"] for event in events],
        "outbox": [
            {"kind": event["kind"], "payload": event["payload"]}
            for event in events
        ],
    }
    print(json.dumps(report, sort_keys=True))
    ledger.shutdown_for_tests()


def _run_worker(workdir: Path, phase: str, scenario: str, task_id: str,
                timeout_seconds: int) -> subprocess.CompletedProcess[str]:
    db_path = workdir / f"{scenario}.sqlite"
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        [str(ENGINE_ROOT), env.get("PYTHONPATH", "")]
    ).rstrip(os.pathsep)
    return subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--worker-phase", phase,
         "--scenario", scenario, "--task-id", task_id, "--db-path", str(db_path)],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )


def run_scenario(workdir: Path, scenario: str, timeout_seconds: int) -> dict[str, Any]:
    task_id = f"phase1-restart-{scenario}"
    seed = _run_worker(workdir, "seed", scenario, task_id, timeout_seconds)
    if seed.returncode != 0:
        raise RuntimeError(
            f"seed worker failed ({seed.returncode}): {seed.stderr[-2_000:]}"
        )

    recovery = _run_worker(workdir, "recover", scenario, task_id, timeout_seconds)
    if recovery.returncode != 0:
        raise RuntimeError(
            f"recovery worker failed ({recovery.returncode}): {recovery.stderr[-2_000:]}"
        )
    lines = [line for line in recovery.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError(f"recovery worker emitted {len(lines)} JSON lines")
    evidence = json.loads(lines[0])
    return {
        "scenario": scenario,
        "seedExitCode": seed.returncode,
        "recoveryExitCode": recovery.returncode,
        "evidence": evidence,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=(*SCENARIOS, "all"), required=True)
    parser.add_argument("--workdir", type=Path)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--worker-phase", choices=("seed", "recover"))
    parser.add_argument("--task-id")
    parser.add_argument("--db-path", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if not 1 <= args.timeout_seconds <= MAX_TIMEOUT_SECONDS:
        raise SystemExit(f"--timeout-seconds must be between 1 and {MAX_TIMEOUT_SECONDS}")

    if args.worker_phase:
        if args.db_path is None or args.task_id is None:
            raise SystemExit("worker mode requires --db-path and --task-id")
        if args.worker_phase == "seed":
            _worker_seed(args.db_path, args.task_id, args.scenario)
        _worker_recover(args.db_path, args.task_id)
        return 0

    if args.workdir is None:
        raise SystemExit("harness mode requires --workdir")
    args.workdir.mkdir(parents=True, exist_ok=True)
    scenarios = SCENARIOS if args.scenario == "all" else (args.scenario,)
    report = {
        "bounded": True,
        "maxScenarios": len(SCENARIOS),
        "timeoutSeconds": args.timeout_seconds,
        "scenarios": [run_scenario(args.workdir, scenario, args.timeout_seconds)
                       for scenario in scenarios],
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
