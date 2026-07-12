"""Read-only smoke test for Graphify-generated dual graph profiles.

TorqClaw-specific consumer fixture. This script validates two networkx
node-link JSON graphs produced by Graphify:

  * graphify-product/graph.json - first-party TorqClaw graph. Must NOT
    contain any vendored hermes-agent nodes.
  * graphify-vendor/graph.json  - vendored hermes-agent graph (scanned
    from engines/hermes_kernel/vendor/hermes-agent). Optional; if
    absent, vendor checks are skipped and the script still exits 0 as
    long as product checks pass.

Symbols such as "executeHermesTask", "ClientCommandSchema", and
"submit_task" are expected to appear in the PRODUCT graph because they
are TorqClaw's own gateway/bridge/contract code that calls into or
wraps the vendored hermes-agent engine. They belong here, not upstream
in hermes-agent.

This script does not modify any files, does not touch the network, and
does not run builds. It only reads JSON and prints ASCII results.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
PRODUCT_GRAPH = REPO_ROOT / "graphify-product" / "graph.json"
VENDOR_GRAPH = REPO_ROOT / "graphify-vendor" / "graph.json"

REQUIRED_PRODUCT_PREFIXES = (
    "packages/gateway/",
    "packages/contracts/",
    "apps/console/",
    "engines/hermes_kernel/mcp_wrapper/",
)
REQUIRED_SYMBOLS = ("executehermestask", "clientcommandschema", "submit_task")
VENDOR_FORBIDDEN_PREFIXES = (
    "packages/gateway/",
    "packages/contracts/",
    "packages/bridge/",
)

failures: list[str] = []


def norm(path: str) -> str:
    """Normalize backslashes to forward slashes for comparison."""
    return path.replace("\\", "/")


def load_graph(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def check(label: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"OK {label}")
    else:
        msg = f"FAIL {label}" + (f" - {detail}" if detail else "")
        print(msg)
        failures.append(label)


def node_source(node: dict[str, Any]) -> str:
    return norm(str(node.get("source_file", "")))


def run_product_checks(graph: dict[str, Any]) -> dict[str, str]:
    nodes = graph.get("nodes", [])
    check(">= 500 nodes (product)", len(nodes) >= 500, f"got {len(nodes)}")

    vendor_leak = [n for n in nodes if node_source(n).startswith(
        "engines/hermes_kernel/vendor/")]
    examples = [node_source(n) for n in vendor_leak[:3]]
    check("zero vendor nodes in product graph", len(vendor_leak) == 0,
          f"count={len(vendor_leak)} examples={examples}")

    for prefix in REQUIRED_PRODUCT_PREFIXES:
        found = any(node_source(n).startswith(prefix) for n in nodes)
        check(f"has node under {prefix}", found)

    id_to_source = {str(n.get("id")): node_source(n) for n in nodes}
    for symbol in REQUIRED_SYMBOLS:
        found = any(
            symbol in str(n.get("id", "")).lower()
            or symbol in str(n.get("label", "")).lower()
            for n in nodes
        )
        check(f"has symbol containing '{symbol}'", found)

    # Upstream v1 limitation (Torq-graphify#1): profile `directed = true`
    # parses but `graphify update` builds are undirected. Accepted and tracked
    # as an upstream follow-up; a MISSING flag would still be a failure
    # (unreadable graph provenance), False is a known-state note.
    directed = graph.get("directed")
    check("directed flag present (product)", isinstance(directed, bool),
          f"got {directed!r}")
    if directed is False:
        print("NOTE directed=False: upstream v1 `update` builds undirected "
              "graphs (profile.directed not yet build-wired) - accepted")

    cross_package = False
    for link in graph.get("links", []):
        src = id_to_source.get(str(link.get("source", "")), "")
        tgt = id_to_source.get(str(link.get("target", "")), "")
        if not src or not tgt:
            continue
        src_top = src.split("/", 1)[0]
        tgt_top = tgt.split("/", 1)[0]
        if src_top and tgt_top and src_top != tgt_top:
            cross_package = True
            break
    check(">= 1 cross-package edge", cross_package)

    return id_to_source


def run_vendor_checks(graph: dict[str, Any]) -> None:
    nodes = graph.get("nodes", [])
    check(">= 5000 nodes (vendor)", len(nodes) >= 5000, f"got {len(nodes)}")

    has_gateway = any("gateway/" in node_source(n) for n in nodes)
    has_cli_or_apps = any(
        "hermes_cli/" in node_source(n) or "apps/" in node_source(n)
        for n in nodes
    )
    check("has recognizable hermes structure (gateway/)", has_gateway)
    check("has recognizable hermes structure (hermes_cli/ or apps/)",
          has_cli_or_apps)

    leaks = [n for n in nodes if any(
        node_source(n).startswith(p) for p in VENDOR_FORBIDDEN_PREFIXES)]
    examples = [node_source(n) for n in leaks[:3]]
    check("zero first-party leakage into vendor graph", len(leaks) == 0,
          f"count={len(leaks)} examples={examples}")


def main() -> int:
    product = load_graph(PRODUCT_GRAPH)
    if product is None:
        print(f"FAIL product graph missing or unparseable: {PRODUCT_GRAPH}")
        return 1

    run_product_checks(product)

    vendor = load_graph(VENDOR_GRAPH)
    if vendor is None:
        print(f"SKIP vendor checks - not found: {VENDOR_GRAPH}")
    else:
        run_vendor_checks(vendor)

    if failures:
        print(f"=== SMOKE FAILURES: {len(failures)} ===")
        return 1

    print("=== ALL SMOKE TESTS PASSED ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
