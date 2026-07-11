# TorqClaw Graphify overlay (read with SKILL.md)

This repository overrides the default single-graph assumptions.

## Dual graph

| Profile | Graph path | Default? |
|---|---|---|
| product | `graphify-product/graph.json` | **YES** |
| vendor | `graphify-vendor/graph.json` | no — opt-in only |
| legacy | `graphify-out/graph.json` | **do not use** for product answers (vendor-dominated) |

## Before any query/path/explain/affected

1. Prefer `--graph graphify-product/graph.json`.
2. Run or read `python scripts/check_graphify_fitness.py` banner.
3. Expand the user question into precise vocabulary (`ClientCommandSchema`, `executeHermesTask`, …).
4. Prefer start nodes under `packages/`, `apps/console/`, `engines/hermes_kernel/mcp_wrapper/`.
5. For blast radius use `graphify affected`, not open BFS.
6. Package DAG: trust package.json / imports; do not invent monorepo alias edges.
7. If fitness FAIL: say the graph is unfit; answer from source.

## Rebuild

```bash
python scripts/build_graphify_graphs.py
python scripts/check_graphify_fitness.py
python scripts/test_graphify_smoke.py
```

Full generic skill remains in `SKILL.md`; this file wins on path defaults and fitness policy for TorqClaw.
