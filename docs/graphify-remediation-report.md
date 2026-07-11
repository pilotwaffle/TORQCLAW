# Graphify dual-graph remediation report (P0/P1)

**Date:** 2026-07-11  
**Branch:** ticket/tclaw-5a-1-approval-read (local work; not merged by this task)  
**Scope:** Graphify configuration, graph generation, validation, agent policy only. No product runtime behavior changes.

## Controlling invariant

Product architecture conclusions must be derived from a product-scoped graph; vendored implementation details may enter only through an explicit vendor investigation.

## Before / after

| Metric | Before (`graphify-out/`) | After product (`graphify-product/`) | After vendor (`graphify-vendor/`) |
|---|---|---|---|
| Nodes | **124,459** | **1,505** | **92,028** |
| Vendor nodes | **121,507 (97.63%)** | **0 (0.0%)** | essentially all (vendor tree only) |
| First-party share | ~1.2% | **91.6%** | n/a |
| Cross-package edges | **4** (AST-only among packages/*) | **17** (11 package-manifest `depends_on` + AST) | n/a |
| Graph size | **177.38 MB** | **1.228 MB** | **129.9 MB** |
| Directed | no (legacy undirected/cluster-only) | **yes** | **yes** |
| Community labels | all `Community N` | all `Community N` (placeholders) | placeholders |
| Product load latency | multi-second / noisy queries 15–30s | **~6 ms** JSON load | ~480–530 ms load |

## Commands executed

```bash
# Baseline (legacy)
python -c "… graphify-out/graph.json …"   # 124459 nodes, 97.63% vendor

# Corpus policy
# created .graphifyignore

# Dual build (directed, force write, workspace package-manifest edges on product)
python scripts/build_graphify_graphs.py
# product: 149 code files → 1505 nodes, 1841 edges, 2.96s
# vendor:  3270 code files → 92028 nodes, 177791 edges, 156s

# Gates
python scripts/check_graphify_fitness.py   # PASS
python scripts/test_graphify_smoke.py       # ALL PASSED

# Sample product queries
graphify query "ClientCommandSchema" --graph graphify-product/graph.json --budget 800
graphify affected "ClientCommand" --graph graphify-product/graph.json
```

## Fitness banner (product)

```text
Graph fitness: 1,505 nodes | 0.0% vendor | 91.6% first-party |
17 cross-package edges | 0.0% communities labeled | PRODUCT GRAPH: PASS
```

### Gate results

| Gate | Result |
|---|---|
| vendor node count == 0 | PASS |
| first-party % ≥ 80 | PASS (91.6%) |
| cross-package edges > 4 | PASS (17) |
| required roots represented | PASS (packages, apps/console, mcp_wrapper, ops, tests) |
| interpreter `graphify-product/.graphify_python` | PASS |

## Smoke tests

All required assertions passed:

1. `ClientCommand` → `packages/contracts/src/commands.ts`
2. `ClientCommandSchema` present with first-party consumers / `useGatewayStream`
3. `@torqclaw/contracts` → `pkg:@torqclaw/contracts` @ `packages/contracts/package.json`
4. Product graph has **0** vendor path nodes
5. Vendor graph loads and is large (~92k nodes) when investigated explicitly
6. Product graph is **directed**; reverse-affected helper works for `ClientCommandSchema`
7. Ambiguous terms (`gateway`, `Hermes`, `Schema`, `typescript`) hit product-only paths only (no vendor paths in product graph)

## Artifacts added

| Path | Role |
|---|---|
| `.graphifyignore` | Exclude vendor + deps + generated graph dirs from product scans |
| `scripts/build_graphify_graphs.py` | Dual directed build + package-manifest inject + `.graphify_python` |
| `scripts/check_graphify_fitness.py` | Deterministic PASS/FAIL fitness |
| `scripts/test_graphify_smoke.py` | Architectural smoke tests |
| `graphify-product/` | Default product graph (gitignored) |
| `graphify-vendor/` | Opt-in vendor graph (gitignored) |
| `Claude.md` / `CLAUDE.md` | Agent dual-graph policy |
| `.claude/skills/graphify/TORQCLAW.md` | Skill overlay |
| `.claude/CLAUDE.md` | Points at dual-graph policy |
| `package.json` scripts | `graphify:build`, `graphify:check`, `graphify:smoke` |

## What was intentionally *not* claimed fixed

### Monorepo TypeScript alias resolution

`@torqclaw/*` **import paths in source are still not fully resolved into file-level AST call/import edges** by Graphify. Cross-package connectivity in the product graph is improved primarily by:

- honest **package.json `depends_on`** edges between `pkg:@torqclaw/*` nodes (11 edges), plus
- whatever AST edges already existed across package file trees.

Do **not** treat the graph as a complete import graph for TypeScript workspace packages.

### CLI `affected` relation set

`graphify affected "ClientCommand"` returned “No affected nodes found” because the CLI reverse-walks a fixed relation set (`calls`, `imports`, …) and `ClientCommand` is mostly linked via structural `contains` / same-file edges. The smoke suite’s directed reverse walk still finds neighbors for related symbols. Prefer vocabulary-expanded queries and source cross-checks for blast radius until AST edges densify.

### Community labels

Still placeholders (`Community N`). Policy forbids treating them as navigation categories. Optional later: `graphify label` with an LLM backend.

### Legacy `graphify-out/`

Still present on disk (~177 MB, vendor-dominated). **Do not use for product answers.** Prefer `graphify-product/`. Safe to delete locally after operators rely on the dual setup; not removed automatically by this task.

### Docs in product graph

Product build is **code-only** (AST). Markdown PRDs/docs are not mixed into the product graph (avoids quality degradation). Read docs via normal file tools when needed.

## Rebuild / Windows notes

```bash
python scripts/build_graphify_graphs.py   # writes graphify-product/.graphify_python
python scripts/check_graphify_fitness.py
python scripts/test_graphify_smoke.py
```

Interpreter file content example: `E:\Python\python.exe` (machine-specific).

## Gate reviews

See conversation final response for Gate 1 (architecture) and Gate 2 (implementation fidelity).
