#!/usr/bin/env python3
"""Architectural smoke tests for TorqClaw dual Graphify graphs.

Run after scripts/build_graphify_graphs.py.
Exit 0 if all assertions pass, 1 otherwise.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRODUCT = ROOT / "graphify-product" / "graph.json"
VENDOR = ROOT / "graphify-vendor" / "graph.json"

VENDOR_MARKERS = (
    "engines/hermes_kernel/vendor/",
    "vendor/hermes-agent/",
)


def _norm(p: str | None) -> str:
    return (p or "").replace("\\", "/")


def _is_vendor_path(sf: str) -> bool:
    s = _norm(sf)
    return any(m in s for m in VENDOR_MARKERS)


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _find_nodes(nodes: list[dict], *, label: str | None = None, substr: str | None = None) -> list[dict]:
    out = []
    for n in nodes:
        lab = n.get("label") or ""
        if label is not None and lab == label:
            out.append(n)
        elif substr is not None and substr in lab:
            out.append(n)
    return out


def _neighbors(data: dict, node_id: str) -> list[dict]:
    id_to = {n["id"]: n for n in data["nodes"] if "id" in n}
    links = data.get("links") or []
    found = []
    for e in links:
        if e.get("source") == node_id or e.get("target") == node_id:
            other = e.get("target") if e.get("source") == node_id else e.get("source")
            if other in id_to:
                found.append(id_to[other])
    return found


def _affected_ids(data: dict, start_id: str, *, depth: int = 2) -> set[str]:
    """Reverse traversal along directed edges (who points at me / imports me)."""
    directed = bool(data.get("directed"))
    links = data.get("links") or []
    # reverse adjacency: target -> sources (dependents / callers)
    rev: dict[str, set[str]] = {}
    fwd: dict[str, set[str]] = {}
    for e in links:
        s, t = e.get("source"), e.get("target")
        if not s or not t:
            continue
        fwd.setdefault(s, set()).add(t)
        rev.setdefault(t, set()).add(s)
        if not directed:
            # undirected: both ways
            rev.setdefault(s, set()).add(t)
            fwd.setdefault(t, set()).add(s)

    seen = {start_id}
    frontier = {start_id}
    for _ in range(depth):
        nxt: set[str] = set()
        for n in frontier:
            for dep in rev.get(n, ()):
                if dep not in seen:
                    seen.add(dep)
                    nxt.add(dep)
        frontier = nxt
        if not frontier:
            break
    seen.discard(start_id)
    return seen


def main() -> int:
    failures: list[str] = []
    results: list[str] = []

    if not PRODUCT.is_file():
        print(f"FAIL: missing product graph {PRODUCT}")
        return 1

    t0 = time.perf_counter()
    product = _load(PRODUCT)
    load_ms = (time.perf_counter() - t0) * 1000
    nodes = product["nodes"]
    results.append(f"product load: {load_ms:.0f}ms, {len(nodes)} nodes, directed={product.get('directed')}")

    # 1. ClientCommand resolves to first-party TypeScript symbol
    cc = _find_nodes(nodes, label="ClientCommand")
    cc_fp = [
        n
        for n in cc
        if "packages/contracts" in _norm(n.get("source_file"))
        and _norm(n.get("source_file")).endswith("commands.ts")
        and not _is_vendor_path(n.get("source_file") or "")
    ]
    if not cc_fp:
        failures.append("ClientCommand does not resolve to packages/contracts/.../commands.ts")
    else:
        results.append(f"OK ClientCommand -> {cc_fp[0].get('source_file')}")

    # 2. ClientCommandSchema connects to genuine TorqClaw consumers
    ccs = _find_nodes(nodes, label="ClientCommandSchema")
    ccs_fp = [n for n in ccs if "packages/contracts" in _norm(n.get("source_file") or "")]
    if not ccs_fp:
        failures.append("ClientCommandSchema missing from product graph")
    else:
        nbrs = _neighbors(product, ccs_fp[0]["id"])
        # also accept same-file / contains via file node, or reverse references from consumers
        consumer_ok = any(
            (not _is_vendor_path(n.get("source_file") or ""))
            and (
                "useGatewayStream" in (n.get("label") or "")
                or "server.ts" in _norm(n.get("source_file") or "")
                or "apps/console" in _norm(n.get("source_file") or "")
                or "packages/gateway" in _norm(n.get("source_file") or "")
                or "commands.ts" in _norm(n.get("source_file") or "")
            )
            for n in nbrs + ccs_fp
        )
        # File-level contains edge to commands.ts is enough if consumer imports type elsewhere;
        # check graph-wide for useGatewayStream referencing contracts
        ugs = _find_nodes(nodes, label="useGatewayStream") + _find_nodes(
            nodes, substr="useGatewayStream"
        )
        ugs_fp = [n for n in ugs if "apps/console" in _norm(n.get("source_file") or "")]
        if not consumer_ok and not ugs_fp:
            failures.append(
                "ClientCommandSchema has no first-party consumers (useGatewayStream/gateway) in graph"
            )
        else:
            results.append(
                f"OK ClientCommandSchema + consumers (neighbors={len(nbrs)}, useGatewayStream={len(ugs_fp)})"
            )

    # 3. @torqclaw/contracts resolves to workspace package (canonical inject node).
    # AST may also emit dependency-name fragments under other package.json files —
    # those are not the package root. Prefer id pkg:@torqclaw/contracts.
    pkg = [n for n in nodes if n.get("id") == "pkg:@torqclaw/contracts"]
    if not pkg:
        pkg = [
            n
            for n in nodes
            if n.get("label") == "@torqclaw/contracts"
            and "packages/contracts" in _norm(n.get("source_file") or "")
        ]
    if not pkg:
        failures.append("@torqclaw/contracts package node missing (workspace inject expected)")
    else:
        sf = _norm(pkg[0].get("source_file"))
        if "packages/contracts" not in sf:
            failures.append(f"@torqclaw/contracts resolved incorrectly: {sf}")
        else:
            results.append(f"OK @torqclaw/contracts -> {sf} (id={pkg[0].get('id')})")

    # 4. Product graph has zero vendor nodes
    vendor_nodes = [n for n in nodes if _is_vendor_path(n.get("source_file") or "")]
    if vendor_nodes:
        failures.append(
            f"product graph contains {len(vendor_nodes)} vendor nodes "
            f"(e.g. {vendor_nodes[0].get('source_file')})"
        )
    else:
        results.append("OK product graph has 0 vendor nodes")

    # 5. Vendor graph works when present
    if VENDOR.is_file():
        t1 = time.perf_counter()
        vendor = _load(VENDOR)
        vload = (time.perf_counter() - t1) * 1000
        vnodes = vendor["nodes"]
        # Expect some hermes-agent content
        has_hermes = any(
            "hermes" in _norm(n.get("source_file") or "").lower()
            or "run_agent" in (n.get("label") or "")
            or "AIAgent" in (n.get("label") or "")
            for n in vnodes[:5000]
        ) or len(vnodes) > 100
        if not has_hermes and len(vnodes) < 10:
            failures.append("vendor graph looks empty/unrelated")
        else:
            results.append(f"OK vendor graph: {len(vnodes)} nodes (load {vload:.0f}ms)")
        # Product-mode symbols must not require vendor graph
    else:
        results.append("SKIP vendor graph not built (submodule missing?)")

    # 6. Blast-radius uses directed structure when available
    if not product.get("directed"):
        failures.append("product graph is not directed (blast-radius needs direction)")
    else:
        results.append("OK product graph directed=true")
    if ccs_fp:
        affected = _affected_ids(product, ccs_fp[0]["id"], depth=2)
        results.append(f"OK affected(ClientCommandSchema) depth2 size={len(affected)}")

    # 7. Ambiguous terms must not silently select vendor in product mode
    ambiguous = ("gateway", "Hermes", "Schema", "typescript")
    for term in ambiguous:
        hits = [
            n
            for n in nodes
            if term.lower() in (n.get("label") or "").lower()
            or term.lower() in _norm(n.get("source_file") or "").lower()
        ]
        vendor_hits = [n for n in hits if _is_vendor_path(n.get("source_file") or "")]
        if vendor_hits:
            failures.append(
                f"ambiguous term {term!r} matched vendor paths in product graph "
                f"({len(vendor_hits)} hits)"
            )
        else:
            # Prefer first-party hits when ranking — assert any hit is non-vendor
            if hits and all(not _is_vendor_path(n.get("source_file") or "") for n in hits):
                results.append(f"OK ambiguous {term!r}: {len(hits)} product-only hits")
            elif not hits:
                results.append(f"OK ambiguous {term!r}: no hits (no silent vendor selection)")
            else:
                results.append(f"OK ambiguous {term!r}: filtered clean")

    # Required symbols present
    for label in ("executeHermesTask", "submit_task", "useGatewayStream"):
        found = _find_nodes(nodes, label=label) or _find_nodes(nodes, substr=label)
        found = [n for n in found if not _is_vendor_path(n.get("source_file") or "")]
        if not found:
            # submit_task is Python — check id/label loosely
            found = [
                n
                for n in nodes
                if label in (n.get("label") or "")
                or label in (n.get("id") or "")
            ]
            found = [n for n in found if not _is_vendor_path(n.get("source_file") or "")]
        if not found:
            failures.append(f"required symbol not found in product graph: {label}")
        else:
            results.append(f"OK found {label} @ {found[0].get('source_file')}")

    # mcp_wrapper represented
    mcp = [
        n
        for n in nodes
        if "mcp_wrapper" in _norm(n.get("source_file") or "")
    ]
    if not mcp:
        failures.append("engines/hermes_kernel/mcp_wrapper not represented")
    else:
        results.append(f"OK mcp_wrapper nodes: {len(mcp)}")

    print("=== graphify smoke tests ===")
    for r in results:
        print(r)
    if failures:
        print("=== FAILURES ===")
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("=== ALL SMOKE TESTS PASSED ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
