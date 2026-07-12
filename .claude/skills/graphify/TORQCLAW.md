# TorqClaw graphify overlay — profile policy (wins over generic SKILL.md defaults)

This repo uses upstream **graph profiles** (`graphify.toml`, requires
Torq-graphify feature/project-graph-profiles). Two graphs:

| Profile | Path | Use |
|---|---|---|
| `product` (default) | `graphify-product/graph.json` | Architecture, dependencies, blast radius: packages/*, apps/console, mcp_wrapper |
| `vendor` (opt-in) | `graphify-vendor/graph.json` | Vendored hermes-agent upstream internals ONLY |

## Mandatory rules

1. `GRAPHIFY_PROFILE=product` is set in `.claude/settings.json`; plain
   `graphify query/path/explain/affected` therefore resolve the product graph.
   Never point product questions at `graphify-vendor/` or legacy `graphify-out/`.
2. **Fitness before trust:** `pnpm graphify:fitness` (=`graphify fitness
   --profile product --strict`) must be PASS. On FAIL/LOW, say so and fall
   back to reading source / package manifests.
3. Expand natural-language questions into precise repo tokens
   (`ClientCommandSchema`, `executeHermesTask`, `submit_task`, `mcp_wrapper`)
   before querying.
4. Prefer start nodes under `packages/`, `apps/console/`,
   `engines/hermes_kernel/mcp_wrapper/`. Reject hits under
   `engines/hermes_kernel/vendor/` in product mode — ambiguous names
   (`gateway`, `Hermes`, `Schema`) must disambiguate to TorqClaw paths first.
5. Blast radius: `graphify affected "<Symbol>"` (directed reverse edges) over
   open-ended query BFS.
6. `package.json` / `pnpm-workspace.yaml` / source imports stay authoritative
   for package-level "who depends on whom".
7. Placeholder `Community N` labels are not navigation categories.
8. Never present INFERRED edges as confirmed architecture; prefer EXTRACTED
   call/import evidence.
9. Vendor investigations (explicit operator ask only):
   `graphify query "..." --graph graphify-vendor/graph.json`.
10. Rebuild + validate: `pnpm graphify:build:product`, then
    `pnpm graphify:fitness` and `pnpm graphify:smoke`. Vendor rebuild:
    `pnpm graphify:build:vendor`.

## Corpus scoping (v1 upstream limitation, documented)

Product-build exclusion of `engines/hermes_kernel/vendor/` is enforced by
`.graphifyignore` (read on every scan); `graphify.toml`'s profile `exclude`
documents the same intent. The vendor graph is built by passing the vendor
directory as the scan root with `GRAPHIFY_PROFILE=vendor` — profile `include`
patterns are not scan-wired upstream yet.
