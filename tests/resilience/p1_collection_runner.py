"""Executable collection/integrity runner for the governed P1 matrix.

Usage: python tests/resilience/p1_collection_runner.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from collections import Counter
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_FILE = Path(__file__).with_name("test_p1_resilience.py").resolve()
MANIFEST_FILE = Path(__file__).with_name("p1_manifest.json")


def manifest_ids() -> list[str]:
    raw = json.loads(MANIFEST_FILE.read_text(encoding="utf-8-sig"))
    return [case_id for category in raw["categories"] for case_id in category["ids"]]


class IntegrityPlugin:
    def __init__(self, expected: list[str]):
        self.expected = expected
        self.items: dict[str, str] = {}
        self.collected: list[str] = []
        self.outcomes: dict[str, str] = {}
        self.skipped: dict[str, str] = {}
        self.unknown: list[str] = []

    @staticmethod
    def _is_p1(item: pytest.Item) -> bool:
        return Path(str(item.fspath)).resolve() == TEST_FILE and item.name.startswith(
            "test_manifest_enforced_p1_case"
        )

    def pytest_collection_modifyitems(self, session: pytest.Session, config: pytest.Config,
                                      items: list[pytest.Item]) -> None:
        for item in items:
            if not self._is_p1(item):
                continue
            callspec = getattr(item, "callspec", None)
            case_id = getattr(callspec, "params", {}).get("case_id") if callspec else None
            if not isinstance(case_id, str):
                raise pytest.UsageError(f"P1 item has no case_id: {item.nodeid}")
            self.collected.append(case_id)
            self.items[item.nodeid] = case_id
            if case_id not in self.expected:
                self.unknown.append(case_id)
            if item.get_closest_marker("skip") or item.get_closest_marker("skipif"):
                self.skipped[item.nodeid] = "skip marker present"
            if item.get_closest_marker("xfail"):
                self.skipped[item.nodeid] = "xfail marker present"
        counts = Counter(self.collected)
        missing = sorted(set(self.expected) - set(self.collected))
        duplicate = sorted(case_id for case_id, count in counts.items() if count > 1)
        if len(self.collected) != len(self.expected) or missing or duplicate or self.unknown or self.skipped:
            raise pytest.UsageError(
                "P1 collection mismatch: "
                f"declared={len(self.expected)} collected={len(self.collected)} "
                f"missing={missing} duplicate={duplicate} unknown={sorted(set(self.unknown))} "
                f"skipped={sorted(self.skipped)}"
            )

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        case_id = self.items.get(report.nodeid)
        if case_id and report.when == "call":
            self.outcomes[case_id] = report.outcome

    def pytest_sessionfinish(self, session: pytest.Session, exitstatus: int) -> None:
        missing_call = sorted(set(self.expected) - set(self.outcomes))
        if missing_call:
            session.exitstatus = pytest.ExitCode.TESTS_FAILED
        report = {
            "declared": len(self.expected),
            "collected": len(self.collected),
            "executed": len(self.outcomes),
            "passed": sum(value == "passed" for value in self.outcomes.values()),
            "failed": sum(value == "failed" for value in self.outcomes.values()),
            "skipped": len(self.skipped),
            "missingCallPhase": missing_call,
            "duplicateIds": sorted(case_id for case_id, count in Counter(self.collected).items() if count > 1),
            "unknownIds": sorted(set(self.unknown)),
            "unique_governed_p1_fault_ids": len(set(self.expected)),
        }
        target = Path(os.environ.get(
            "TORQCLAW_P1_REPORT",
            str(Path(tempfile.gettempdir()) / f"torqclaw-p1-report-{os.getpid()}.json"),
        ))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    expected = manifest_ids()
    if len(expected) != 36 or len(set(expected)) != 36:
        raise SystemExit("P1 manifest must contain exactly 36 unique IDs")
    os.environ.setdefault("TORQCLAW_P1_REPORT", str(Path(tempfile.gettempdir()) / "torqclaw-p1-report.json"))
    os.environ.setdefault("TORQCLAW_P1_RUN_METRICS", str(Path(tempfile.gettempdir()) / "torqclaw-p1-run-metrics.json"))
    return int(pytest.main([str(TEST_FILE), "-q", "--noconftest"], plugins=[IntegrityPlugin(expected)]))


if __name__ == "__main__":
    sys.exit(main())
