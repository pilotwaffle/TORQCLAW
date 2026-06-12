# hermes_kernel

Thin MCP wrapper (Streamable HTTP) around the vendored Hermes agent.

## Setup
```bash
# vendor upstream — wrap, don't rewrite; rebase instead of drift
git submodule add https://github.com/NousResearch/hermes-agent vendor/hermes-agent
uv sync
# emit contract schemas into mcp_wrapper/schemas/
pnpm --filter @torqclaw/contracts build
uv run python -m mcp_wrapper.server   # http://127.0.0.1:8000/mcp
```

The only Python we own is `mcp_wrapper/`. Upstream lives untouched in
`vendor/hermes-agent` (gitignored; pinned via the submodule ref).
