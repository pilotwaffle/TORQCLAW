"""Collection and outcome accounting for the isolated 108-case P0 matrix."""
from __future__ import annotations

import json
import os
import tempfile
from collections import Counter
from pathlib import Path

import pytest

_MANIFEST = Path(__file__).with_name("p0_manifest.json")
_P0_FILE = Path(__file__).with_name("test_p0_resilience.py").resolve()


def _manifest_pairs() -> list[tuple[str, str]]:
    manifest = json.loads(_MANIFEST.read_text(encoding="utf-8-sig"))
    return [(category["name"], case_id)
            for category in manifest["categories"]
            for case_id in category["ids"]]


def _p0_item(item: pytest.Item) -> bool:
    return Path(str(item.fspath)).resolve() == _P0_FILE and item.name.startswith(
        "test_manifest_enforced_p0_case"
    )


def pytest_collection_modifyitems(session: pytest.Session, config: pytest.Config,
                                   items: list[pytest.Item]) -> None:
    manifest_pairs = _manifest_pairs()
    p0_items = [item for item in items if _p0_item(item)]
    # This plugin is shared by the resilience directory, but its manifest
    # invariant belongs only to the P0 module.  Running the P1 module with the
    # normal pytest discovery path must not look like a missing P0 collection.
    if not p0_items:
        return
    collected_pairs: list[tuple[str, str]] = []
    for item in p0_items:
        callspec = getattr(item, "callspec", None)
        params = getattr(callspec, "params", {}) if callspec is not None else {}
        pair = (params.get("category"), params.get("case_id"))
        collected_pairs.append(pair)
        if item.get_closest_marker("skip") or item.get_closest_marker("skipif"):
            raise pytest.UsageError(f"P0 case is skipped: {item.nodeid}")
        if item.get_closest_marker("xfail"):
            raise pytest.UsageError(f"P0 case is xfailed: {item.nodeid}")

    collected_counts = Counter(collected_pairs)
    duplicate_pairs = sorted(pair for pair, count in collected_counts.items() if count > 1)
    manifest_counts = Counter(manifest_pairs)
    missing = sorted(set(manifest_pairs) - set(collected_pairs))
    extra = sorted(set(collected_pairs) - set(manifest_pairs))
    if (len(p0_items) != len(manifest_pairs) or duplicate_pairs or missing or extra or
            len({item.nodeid for item in p0_items}) != len(p0_items)):
        raise pytest.UsageError(
            "P0 collection mismatch: "
            f"declared={len(manifest_pairs)} collected={len(p0_items)} "
            f"missing={missing} extra={extra} duplicate={duplicate_pairs}"
        )

    config._torqclaw_p0 = {
        "manifest_pairs": manifest_pairs,
        "collected_pairs": collected_pairs,
        "items": {item.nodeid: pair for item, pair in zip(p0_items, collected_pairs)},
        "outcomes": {},
        "reports": {},
    }


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo):
    outcome = yield
    report = outcome.get_result()
    state = getattr(item.config, "_torqclaw_p0", None)
    if state is None or item.nodeid not in state["items"]:
        return
    state["reports"].setdefault(item.nodeid, {})[report.when] = report.outcome
    if report.when == "call":
        state["outcomes"][item.nodeid] = report.outcome


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    state = getattr(session.config, "_torqclaw_p0", None)
    if state is None:
        return
    nodeids = list(state["items"])
    outcomes = state["outcomes"]
    passed = sum(outcomes.get(nodeid) == "passed" for nodeid in nodeids)
    skipped = sum(outcomes.get(nodeid) == "skipped" for nodeid in nodeids)
    missing_call = [nodeid for nodeid in nodeids if nodeid not in outcomes]
    failed = sum(outcomes.get(nodeid) == "failed" for nodeid in nodeids) + len(missing_call)
    observed_counts = Counter(state["collected_pairs"])
    repeated = sorted(
        f"{category}:{case_id}"
        for (category, case_id), count in observed_counts.items()
        if count > 1
    )
    report = {
        "declared": len(state["manifest_pairs"]),
        "collected": len(nodeids),
        "executed": passed + failed + skipped,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "duplicate": sum(count - 1 for count in observed_counts.values() if count > 1),
        "repetition": {"runs": 1, "repeatedCaseIds": repeated},
        "missingCallPhase": missing_call,
    }
    target = os.environ.get(
        "TORQCLAW_P0_REPORT",
        str(Path(tempfile.gettempdir()) / f"torqclaw-p0-report-{os.getpid()}.json"),
    )
    report_path = Path(target)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n",
                           encoding="utf-8-sig")
