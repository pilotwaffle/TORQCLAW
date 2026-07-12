# graphify
- **graphify** (`.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
- **TorqClaw profile policy** (`graphify.toml` + `.claude/skills/graphify/TORQCLAW.md` + root `CLAUDE.md`) — **wins over** generic skill defaults for this repo.
- Default profile: `product` -> `graphify-product/graph.json` (via `GRAPHIFY_PROFILE` in `.claude/settings.json`). Vendor opt-in: `graphify-vendor/graph.json`. Do **not** use legacy `graphify-out/`.
- Trust gate before relying on graph answers: `pnpm graphify:fitness` must be PASS.
When the user types `/graphify`, use the installed graphify skill **and** the TorqClaw profile policy before doing anything else.
