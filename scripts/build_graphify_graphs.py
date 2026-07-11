#!/usr/bin/env python3
"""Build TorqClaw dual Graphify graphs: product (default) + vendor (opt-in).

Product graph: first-party control plane only (vendor excluded via .graphifyignore).
Vendor graph: engines/hermes_kernel/vendor/hermes-agent only.

Uses directed graphs so blast-radius / import questions retain direction.
Does not modify product runtime code.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRODUCT_DIR = ROOT / "graphify-product"
VENDOR_DIR = ROOT / "graphify-vendor"
VENDOR_SRC = ROOT / "engines" / "hermes_kernel" / "vendor" / "hermes-agent"


def _write_interpreter(out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    py_path = out_dir / ".graphify_python"
    py_path.write_text(sys.executable, encoding="utf-8")
    return py_path


def _ensure_graphify() -> None:
    try:
        import graphify  # noqa: F401
    except ImportError:
        print(
            "error: graphify is not installed in this Python.\n"
            f"  interpreter: {sys.executable}\n"
            "  install: pip install graphifyy   OR   uv tool install graphifyy",
            file=sys.stderr,
        )
        sys.exit(2)


def _inject_workspace_package_edges(extraction: dict, root: Path) -> dict:
    """Add honest package-manifest nodes/edges from package.json workspace deps.

    This does NOT claim to resolve TypeScript `@torqclaw/*` import aliases in AST.
    It adds package-level depends_on edges from declared package.json dependencies
    so package-DAG questions have real graph structure.
    """
    nodes = list(extraction.get("nodes", []))
    edges = list(extraction.get("edges", []))
    seen_ids = {n.get("id") for n in nodes if n.get("id")}

    package_jsons = list((root / "packages").glob("*/package.json"))
    console_pkg = root / "apps" / "console" / "package.json"
    if console_pkg.exists():
        package_jsons.append(console_pkg)

    pkg_meta: list[tuple[str, Path, dict]] = []
    for pj in package_jsons:
        try:
            data = json.loads(pj.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        name = data.get("name")
        if not isinstance(name, str) or not name:
            continue
        rel = pj.relative_to(root).as_posix()
        pkg_meta.append((name, pj, data))
        nid = f"pkg:{name}"
        if nid not in seen_ids:
            nodes.append(
                {
                    "id": nid,
                    "label": name,
                    "source_file": rel,
                    "source_location": f"{rel}:1",
                    "type": "package",
                    "confidence": "EXTRACTED",
                }
            )
            seen_ids.add(nid)

    name_to_id = {name: f"pkg:{name}" for name, _, _ in pkg_meta}
    for name, pj, data in pkg_meta:
        rel = pj.relative_to(root).as_posix()
        deps = {}
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            block = data.get(section) or {}
            if isinstance(block, dict):
                deps.update(block)
        for dep_name, spec in deps.items():
            if not isinstance(dep_name, str):
                continue
            # Only wire workspace / first-party package names we know.
            if dep_name not in name_to_id:
                continue
            if not (
                isinstance(spec, str)
                and (spec.startswith("workspace:") or dep_name.startswith("@torqclaw/"))
            ):
                # Still allow plain @torqclaw/* if listed without workspace: protocol
                if not dep_name.startswith("@torqclaw/"):
                    continue
            edges.append(
                {
                    "source": name_to_id[name],
                    "target": name_to_id[dep_name],
                    "relation": "depends_on",
                    "confidence": "EXTRACTED",
                    "source_file": rel,
                    "source_location": f"{rel}:1",
                    "context": "package_manifest",
                }
            )

    extraction = dict(extraction)
    extraction["nodes"] = nodes
    extraction["edges"] = edges
    return extraction


def _build_one(
    *,
    label: str,
    scan_root: Path,
    out_dir: Path,
    inject_workspace: bool,
    extra_excludes: list[str] | None = None,
) -> dict:
    from graphify.detect import detect
    from graphify.extract import extract
    from graphify.build import build
    from graphify.cluster import cluster
    from graphify.export import to_json
    from graphify.analyze import god_nodes

    _write_interpreter(out_dir)
    t0 = time.perf_counter()
    print(f"[{label}] scanning {scan_root} ...")
    detection = detect(
        scan_root,
        extra_excludes=extra_excludes,
        cache_root=out_dir,
    )
    # detect() already returns concrete file paths (not directories).
    code_paths: list[Path] = []
    seen: set[str] = set()
    for f in detection.get("files", {}).get("code", []):
        p = Path(f)
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen:
            continue
        seen.add(key)
        if p.is_file():
            code_paths.append(p)
    print(f"[{label}] AST extract on {len(code_paths)} code files ...")
    if not code_paths:
        print(f"error: [{label}] no code files found under {scan_root}", file=sys.stderr)
        sys.exit(1)

    ast = extract(code_paths, cache_root=out_dir)
    if inject_workspace:
        ast = _inject_workspace_package_edges(ast, ROOT)

    print(f"[{label}] building directed graph ...")
    G = build([ast], directed=True, dedup=True, root=scan_root)
    if G.number_of_nodes() == 0:
        print(f"error: [{label}] empty graph", file=sys.stderr)
        sys.exit(1)

    communities = cluster(G)
    try:
        gods = god_nodes(G)
    except Exception:
        gods = []

    graph_path = out_dir / "graph.json"
    # force=True bypasses shrink protection (product graph is intentionally smaller)
    wrote = to_json(G, communities, str(graph_path), force=True)
    if not wrote:
        print(f"error: [{label}] to_json refused to write {graph_path}", file=sys.stderr)
        sys.exit(1)

    analysis = {
        "communities": {str(k): v for k, v in communities.items()},
        "gods": gods,
        "profile": label,
        "directed": True,
        "scan_root": str(scan_root),
        "code_files": len(code_paths),
        "built_with": "scripts/build_graphify_graphs.py",
    }
    (out_dir / ".graphify_analysis.json").write_text(
        json.dumps(analysis, indent=2), encoding="utf-8"
    )
    # Labels remain placeholders until `graphify label` is run; do not fake them.
    labels = {str(k): f"Community {k}" for k in communities}
    (out_dir / ".graphify_labels.json").write_text(
        json.dumps(labels), encoding="utf-8"
    )
    (out_dir / ".graphify_root").write_text(str(scan_root.resolve()), encoding="utf-8")

    elapsed = time.perf_counter() - t0
    size_mb = graph_path.stat().st_size / 1e6
    meta = {
        "label": label,
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": len(communities),
        "size_mb": round(size_mb, 3),
        "seconds": round(elapsed, 2),
        "graph_path": str(graph_path),
        "directed": True,
    }
    (out_dir / "BUILD_META.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(
        f"[{label}] wrote {graph_path} — {meta['nodes']} nodes, "
        f"{meta['edges']} edges, {meta['communities']} communities, "
        f"{meta['size_mb']} MB in {meta['seconds']}s"
    )
    return meta


def main() -> int:
    os.chdir(ROOT)
    _ensure_graphify()

    # Product: monorepo root; .graphifyignore drops vendor + dist + graph dirs.
    product_meta = _build_one(
        label="product",
        scan_root=ROOT,
        out_dir=PRODUCT_DIR,
        inject_workspace=True,
    )

    if not VENDOR_SRC.is_dir():
        print(
            f"[vendor] SKIP — vendor tree missing at {VENDOR_SRC} "
            "(submodule not initialized). Product graph still built.",
            file=sys.stderr,
        )
        vendor_meta = {"label": "vendor", "skipped": True}
    else:
        vendor_meta = _build_one(
            label="vendor",
            scan_root=VENDOR_SRC,
            out_dir=VENDOR_DIR,
            inject_workspace=False,
        )

    summary = {"product": product_meta, "vendor": vendor_meta}
    (PRODUCT_DIR / "DUAL_BUILD_SUMMARY.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
