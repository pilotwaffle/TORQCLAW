# TORQCLAW

Hybrid AI orchestrator: a **TypeScript control plane** (gateway, dynamic router,
universal MCP bridge, console UI) driving a **forked Hermes Python engine**
(self-improving skill loop) — combining the OpenClaw gateway paradigm with the
Hermes learning paradigm, with the weaknesses of both engineered out.

```
 [ Channels: web / slack / discord ]
          │  ws (Zod-validated frames)
          ▼
 ┌─────────────────────────────────────────────┐
 │      CONTROL PLANE (TypeScript)             │
 │  gateway :18790 → enrich → classify → route │
 └──────┬──────────────────────────┬───────────┘
        ▼ low complexity / private ▼ high complexity / research
 ┌──────────────┐          ┌─────────────────────┐
 │ LOCAL EDGE   │          │ HERMES EXEC ENGINE  │
 │ Ollama /v1   │          │ Python · MCP        │
 │ tool loop    │          │ streamable-http     │
 └──────┬───────┘          └─────────┬───────────┘
        └────────────┬───────────────┘
                     ▼
 ┌─────────────────────────────────────────────┐
 │  UNIVERSAL MCP BRIDGE                       │
 │  namespaced registry · task-filtered tools  │
 │  approval-gated writes                      │
 └─────────────────────────────────────────────┘
```

## Layout

| Path | What |
|---|---|
| `packages/contracts` | **Source of truth.** Pure Zod schemas; build emits JSON Schema for the Python engine |
| `packages/router` | Rule hierarchy: privacy → classifier confidence → tool count → cold start → heuristics |
| `packages/gateway` | Fastify WS server (`:18790`), session engine, SQLite+FTS5 memory, dispatch |
| `packages/inference` | LOCAL_EDGE Ollama tool loop (defensive parse, result caps, finalization pass) |
| `packages/bridge` | Multi-server MCP client, `server__tool` namespacing, task-based filtering, approval policy |
| `apps/console` | Next.js TORQ terminal (reconnect, seq replay, skill approval) |
| `engines/hermes_kernel` | Streamable-HTTP MCP wrapper over vendored `hermes-agent` |

## Quickstart

```bash
pnpm install
git submodule add https://github.com/NousResearch/hermes-agent engines/hermes_kernel/vendor/hermes-agent
pnpm engine:setup                 # uv sync + submodules
pnpm --filter @torqclaw/contracts build   # emit schemas (TS + Python copies)
pnpm model:setup                  # ollama create torq-local (num_ctx 8192)

# three terminals:
pnpm --filter @torqclaw/hermes-kernel dev   # engine  http://127.0.0.1:8000/mcp
pnpm --filter @torqclaw/gateway dev         # gateway ws://127.0.0.1:18790/ws
pnpm --filter @torqclaw/console dev         # console http://localhost:3000
```

## Configuration (env)

| Var | Default | |
|---|---|---|
| `TORQCLAW_DATA_DIR` | `~/.torqclaw` | state.db, credentials, skill queue |
| `TORQCLAW_PORT` / `TORQCLAW_HOST` | `18790` / `127.0.0.1` | loopback-first; never bare 0.0.0.0 |
| `TORQCLAW_GATEWAY_TOKEN` | _(unset = dev mode)_ | required in any non-loopback deployment |
| `HERMES_ENGINE_URL` / `HERMES_ENGINE_TOKEN` | `http://127.0.0.1:8000/mcp` | move to a GPU box = change config, not code |
| `OLLAMA_HOST` / `TORQCLAW_LOCAL_MODEL` | `localhost:11434` / `torq-local` | |
| `HERMES_MODEL` / `HERMES_PROVIDER` / `HERMES_API_KEY` | _(unset = stub mode)_ | real agent execution; see `mcp_wrapper/hermes_runner.py` |

## Adding tools (MCP servers)

Copy `ops/servers.example.json` to `~/.torqclaw/servers.json`. Each entry's
`id` becomes the tool namespace prefix (`filesystem__read_file`). Both `stdio`
(spawned command) and `streamable-http` (remote URL + optional bearer token)
transports are supported. `approvalPatterns` are regexes — matching tools
require a human click on LOCAL_EDGE runs; omit to use the default
write/delete/push/create/update/send/exec set. A malformed file or an
unreachable server degrades that server only, never the gateway. Update
`TOOL_ROUTING_MAP` in `packages/bridge/src/toolFilter.ts` to expose new
namespaces to the task types that need them.

## Design invariants

1. **Every frame is contract-validated** — at the WS boundary, inside the gateway
   (it parses its own output), and at the Python boundary (compiled JSON Schema).
2. **Sessions outlive sockets.** Execution publishes to a session bus; sockets
   subscribe, drop, and resume via monotonic `seq` cursors — never timestamps.
3. **Privacy beats everything** in routing; classifier uncertainty buys frontier
   capability; write-capable tools on LOCAL_EDGE pause for human approval.
4. **Skills never auto-deploy.** Drafts land in an approval queue; only an
   operator decision writes to the skills directory.
5. **Wrap, don't rewrite.** Upstream Hermes is a pinned submodule; we own only
   `mcp_wrapper/`.
