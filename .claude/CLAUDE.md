# graphify
- **graphify** (`.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
- **TorqClaw dual-graph policy** (`.claude/skills/graphify/TORQCLAW.md` + root `Claude.md` / `CLAUDE.md`) — **wins over** generic skill defaults for this repo.
- Default graph: `graphify-product/graph.json`. Vendor opt-in: `graphify-vendor/graph.json`. Do **not** use legacy `graphify-out/` for product architecture.
- Before trusting graph answers: `python scripts/check_graphify_fitness.py`. Rebuild: `python scripts/build_graphify_graphs.py`.
When the user types `/graphify`, use the installed graphify skill **and** TorqClaw overlay before doing anything else.
