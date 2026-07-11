#!/usr/bin/env python3
"""Deterministic fitness check for the TorqClaw product Graphify graph.

Exit 0 on PASS, 1 on FAIL (gate failure), 2 on missing graph / setup error.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GRAPH = ROOT / "graphify-product" / "graph.json"
DEFAULT_LABELS = ROOT / "graphify-product" / ".graphify_labels.json"
DEFAULT_INTERPRETER = ROOT / "graphify-product" / ".graphify_python"

PRODUCT_ROOT_PREFIXES = (
    "packages/",
    "apps/console/",
    "engines/hermes_kernel/mcp_wrapper/",
    "ops/",
    "tests/",
)

VENDOR_MARKERS = (
    "engines/hermes_kernel/vendor/",
    "vendor/hermes-agent/",
)


def _norm(p: str | None) -> str:
    if not p:
        return ""
    return p.replace("\\", "/").lstrip("./")


def _is_vendor(sf: str) -> bool:
    s = _norm(sf)
    return any(m in s for m in VENDOR_MARKERS)


def _is_first_party(sf: str) -> bool:
    s = _norm(sf)
    if not s or _is_vendor(s):
        return False
    if s.startswith(PRODUCT_ROOT_PREFIXES):
        return True
    # Package manifest package: nodes, scripts, root config still first-party
    if s.startswith(("packages/", "apps/", "engines/hermes_kernel/mcp_wrapper", "ops/", "tests/", "scripts/")):
        return True
    if s.endswith("package.json") and not _is_vendor(s):
        return True
    # Workspace package nodes use packages/*/package.json
    return False


def _top_segment_key(sf: str) -> str | None:
    """Return a package/app key for cross-package edge counting."""
    s = _norm(sf)
    if s.startswith("packages/") and "/" in s[len("packages/") :]:
        return "packages/" + s.split("/")[1]
    if s.startswith("apps/") and "/" in s[len("apps/") :]:
        return "apps/" + s.split("/")[1]
    if s.startswith("engines/hermes_kernel/mcp_wrapper"):
        return "engines/hermes_kernel/mcp_wrapper"
    if s.startswith("pkg:"):
        return s  # package node id used as source_file sometimes via label path
    return None


def analyze(graph_path: Path, labels_path: Path, interpreter_path: Path) -> dict:
    if not graph_path.is_file():
        return {
            "ok": False,
            "fatal": f"missing product graph: {graph_path}",
            "banner": f"Graph fitness: MISSING graph at {graph_path} | PRODUCT GRAPH: FAIL",
        }

    data = json.loads(graph_path.read_text(encoding="utf-8"))
    nodes = data.get("nodes") or []
    links = data.get("links") or data.get("edges") or []
    total = len(nodes)
    size_mb = graph_path.stat().st_size / 1e6

    id_to = {n.get("id"): n for n in nodes if n.get("id")}

    vendor_n = 0
    first_party_n = 0
    root_hits = {p: 0 for p in PRODUCT_ROOT_PREFIXES}
    for n in nodes:
        sf = _norm(n.get("source_file") or "")
        label = n.get("label") or ""
        # package nodes from inject use source_file = packages/x/package.json
        if _is_vendor(sf):
            vendor_n += 1
        elif _is_first_party(sf) or (isinstance(n.get("id"), str) and str(n["id"]).startswith("pkg:@torqclaw/")):
            first_party_n += 1
        for prefix in PRODUCT_ROOT_PREFIXES:
            if sf.startswith(prefix) or (prefix.rstrip("/") in sf):
                root_hits[prefix] += 1
        # package inject covers packages/* via package.json even if AST sparse
        if isinstance(n.get("id"), str) and n["id"].startswith("pkg:@torqclaw/"):
            root_hits["packages/"] = root_hits.get("packages/", 0) + 1

    # Community labels
    labeled_pct = 0.0
    labels_note = "labels unavailable"
    if labels_path.is_file():
        labels = json.loads(labels_path.read_text(encoding="utf-8"))
        if labels:
            real = sum(
                1
                for v in labels.values()
                if v and not str(v).startswith("Community ")
            )
            labeled_pct = 100.0 * real / len(labels)
            labels_note = f"{labeled_pct:.1f}% communities labeled"
        else:
            labels_note = "labels empty"
    else:
        labels_note = "labels unavailable"

    # Cross-package edges (different package/app keys on endpoints)
    cross = 0
    for e in links:
        s = id_to.get(e.get("source"), {})
        t = id_to.get(e.get("target"), {})
        # package manifest edges
        if (e.get("relation") == "depends_on") or (e.get("context") == "package_manifest"):
            cross += 1
            continue
        sk = _top_segment_key(s.get("source_file") or "")
        tk = _top_segment_key(t.get("source_file") or "")
        # also use pkg: ids
        sid, tid = e.get("source"), e.get("target")
        if isinstance(sid, str) and sid.startswith("pkg:") and isinstance(tid, str) and tid.startswith("pkg:") and sid != tid:
            cross += 1
            continue
        if sk and tk and sk != tk:
            cross += 1

    vendor_pct = (100.0 * vendor_n / total) if total else 0.0
    first_pct = (100.0 * first_party_n / total) if total else 0.0
    interpreter_ok = interpreter_path.is_file() and bool(
        interpreter_path.read_text(encoding="utf-8").strip()
    )
    directed = bool(data.get("directed"))

    failures: list[str] = []
    if vendor_n != 0:
        failures.append(f"vendor node count == 0 required, got {vendor_n}")
    if first_pct < 80.0:
        failures.append(f"first-party node percentage >= 80% required, got {first_pct:.1f}%")
    if cross <= 4:
        failures.append(f"cross-package edge count > 4 required, got {cross}")
    missing_roots = [p for p, c in root_hits.items() if c == 0]
    if missing_roots:
        failures.append(f"required product roots not represented: {missing_roots}")
    if not interpreter_ok:
        failures.append(f"missing Graphify interpreter reference: {interpreter_path}")
    if total == 0:
        failures.append("graph has zero nodes")

    ok = not failures
    banner = (
        f"Graph fitness: {total:,} nodes | {vendor_pct:.1f}% vendor | "
        f"{first_pct:.1f}% first-party | {cross} cross-package edges | "
        f"{labels_note} | PRODUCT GRAPH: {'PASS' if ok else 'FAIL'}"
    )

    return {
        "ok": ok,
        "banner": banner,
        "total_nodes": total,
        "first_party_nodes": first_party_n,
        "vendor_nodes": vendor_n,
        "vendor_percentage": round(vendor_pct, 2),
        "first_party_percentage": round(first_pct, 2),
        "labeled_community_percentage": round(labeled_pct, 2),
        "cross_package_edges": cross,
        "graph_size_mb": round(size_mb, 3),
        "graph_path": str(graph_path),
        "interpreter_path": str(interpreter_path),
        "interpreter_ok": interpreter_ok,
        "directed": directed,
        "root_hits": root_hits,
        "failures": failures,
        "warnings": (
            []
            if labeled_pct > 0
            else [
                "Community labels are placeholders (Community N); do not use them as navigation categories."
            ]
        ),
    }


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    graph_path = DEFAULT_GRAPH
    labels_path = DEFAULT_LABELS
    interpreter_path = DEFAULT_INTERPRETER
    i = 0
    while i < len(argv):
        if argv[i] == "--graph" and i + 1 < len(argv):
            graph_path = Path(argv[i + 1])
            i += 2
        elif argv[i] == "--labels" and i + 1 < len(argv):
            labels_path = Path(argv[i + 1])
            i += 2
        elif argv[i] == "--interpreter" and i + 1 < len(argv):
            interpreter_path = Path(argv[i + 1])
            i += 2
        elif argv[i] in ("-h", "--help"):
            print(
                "Usage: check_graphify_fitness.py [--graph PATH] "
                "[--labels PATH] [--interpreter PATH]"
            )
            return 0
        else:
            print(f"unknown arg: {argv[i]}", file=sys.stderr)
            return 2

    result = analyze(graph_path, labels_path, interpreter_path)
    print(result["banner"])
    if result.get("fatal"):
        print(f"FATAL: {result['fatal']}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {k: v for k, v in result.items() if k != "banner"},
            indent=2,
        )
    )
    if result.get("warnings"):
        for w in result["warnings"]:
            print(f"WARNING: {w}")
    if not result["ok"]:
        print("FAILURES:", file=sys.stderr)
        for f in result["failures"]:
            print(f"  - {f}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
