## graphify

TorqClaw uses **graph profiles** (see `graphify.toml`): the default `product`
profile at `graphify-product/` covers first-party code only; the opt-in
`vendor` profile at `graphify-vendor/` covers vendored hermes-agent internals.
Never use the legacy `graphify-out/` or the vendor graph for product
architecture answers.

Rules:
- For codebase questions, first run `graphify query "<question>"` — with
  `GRAPHIFY_PROFILE=product` (set in `.claude/settings.json`) it resolves the
  product graph automatically. Use `graphify path "<A>" "<B>"` for
  relationships, `graphify explain "<concept>"` for focused concepts, and
  `graphify affected "<symbol>"` for blast radius.
- Expand questions into precise repo tokens (`ClientCommandSchema`,
  `executeHermesTask`, `submit_task`) before querying; bare English
  under-matches.
- Trust gate: `pnpm graphify:fitness` (upstream `graphify fitness --profile
  product --strict`) must be PASS before treating graph answers as
  authoritative; on FAIL/LOW fall back to source and package manifests.
- Vendored hermes-agent internals only when explicitly investigating
  upstream: `graphify query "..." --graph graphify-vendor/graph.json`.
- After modifying code, run `pnpm graphify:build:product` (AST-only, no API
  cost) to keep the product graph current.
- Community labels may be `Community N` placeholders — never navigation
  categories.
- See `.claude/skills/graphify/TORQCLAW.md` for the full agent policy; it
  wins over generic skill defaults in this repo.
