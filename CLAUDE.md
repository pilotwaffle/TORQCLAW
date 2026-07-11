## graphify

TorqClaw uses a **dual-graph** setup. Do not use the legacy vendor-dominated `graphify-out/` for product architecture answers.

| Graph | Path | When to use |
|---|---|---|
| **Product (default)** | `graphify-product/graph.json` | Architecture, dependencies, blast-radius, control-plane, contracts, gateway, bridge, console, mcp_wrapper |
| **Vendor (opt-in)** | `graphify-vendor/graph.json` | Explicit Hermes-agent *upstream* internals only |

### Controlling invariant

Product architecture conclusions must be derived from the product-scoped graph; vendored implementation details may enter only through an explicit vendor investigation.

### Agent policy (mandatory)

1. **Default graph:** always pass `--graph graphify-product/graph.json` (or set cwd tooling to that path). Never default to `graphify-out/` or `graphify-vendor/` for product questions.
2. **Fitness before trust:** run `python scripts/check_graphify_fitness.py` (or read its banner) before treating graph answers as authoritative. If FAIL or LOW fitness, say so and fall back to source / package manifests.
3. **Vocabulary expansion:** expand natural-language questions into precise repo tokens before querying (e.g. `ClientCommandSchema`, `executeHermesTask`, `submit_task`, `mcp_wrapper`) — do not query bare English like “central modules” alone.
4. **Start-node preference:** prefer nodes under `packages/`, `apps/console/`, and `engines/hermes_kernel/mcp_wrapper/`. Demote or reject hits under `engines/hermes_kernel/vendor/`.
5. **Blast radius:** prefer `graphify affected "Symbol" --graph graphify-product/graph.json` (directed reverse edges) over open BFS `query`.
6. **Package DAG:** `package.json` / `pnpm-workspace.yaml` / source imports are authoritative for “who depends on whom” at package level. The product graph may include `depends_on` package-manifest edges; do **not** claim `@torqclaw/*` AST alias resolution unless fitness/smoke proves real import edges.
7. **Cross-check:** when fitness is weak, or results look surprising, verify against source (read/grep). Do not invent confidence.
8. **Communities:** unlabeled / `Community N` placeholders are **not** meaningful navigation categories — ignore them for explanations.
9. **Inferred edges:** never present INFERRED or cross-layer “surprising” edges as confirmed architecture. Prefer EXTRACTED call/import/depends_on evidence.
10. **Ambiguous terms:** `gateway`, `Hermes`, `Schema`, `typescript` must not silently select vendor symbols in product mode. Disambiguate to TorqClaw paths first.
11. **Vendor graph:** only when the operator explicitly asks about vendored hermes-agent internals: `--graph graphify-vendor/graph.json`.
12. **Rebuild:** `python scripts/build_graphify_graphs.py` then `python scripts/check_graphify_fitness.py` and `python scripts/test_graphify_smoke.py`. Windows: ensure `graphify-product/.graphify_python` exists (the build script writes it).

### Commands

```bash
python scripts/build_graphify_graphs.py
python scripts/check_graphify_fitness.py
python scripts/test_graphify_smoke.py
graphify query "ClientCommandSchema" --graph graphify-product/graph.json
graphify affected "ClientCommand" --graph graphify-product/graph.json
graphify explain "executeHermesTask" --graph graphify-product/graph.json
```
