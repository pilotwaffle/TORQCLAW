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

## Why TORQCLAW

1. **Cost circuit breakers.** A runaway agent can drain API credits fast.
   TORQCLAW reads provider-reported spend in real time; if a task breaches its
   `maxCost`, the bridge cancels the engine task and halts execution. When a
   provider can't report spend, it says so once — the iteration cap is the guard.
2. **Hybrid routing for slow-local-hardware reality.** Tasks are classified and
   routed: trivial/private → local, ambiguous/complex → cloud. On a throttled
   dGPU, `TORQCLAW_PREFER_CLOUD=1` makes cloud the default workhorse while
   privacy-marked tasks still stay on-device.
3. **Human-in-the-loop write gates on both tiers.** No write-capable tool runs —
   local *or* cloud — without an approval card. Allow once re-runs the task with
   a one-shot grant; Deny ends it cleanly.
4. **Cross-language type safety.** Zod schemas compile to JSON Schema at build
   time; the Python engine validates every inbound frame against them. Zero
   schema drift.
5. **Honest UX.** One terminal event per task; receipts from real telemetry
   only; no fabricated risk scores; the agent is hard-grounded against claiming
   tool actions it didn't perform.

## Layout

| Path | What |
|---|---|
| `packages/contracts` | **Source of truth.** Pure Zod schemas; build emits JSON Schema for the Python engine |
| `packages/router` | Rule hierarchy: privacy → classifier confidence → tool count → cold start → heuristics |
| `packages/gateway` | Fastify WS server (`:18790`), session engine, SQLite+FTS5 memory, dispatch |
| `packages/inference` | LOCAL_EDGE Ollama tool loop (defensive parse, result caps, finalization pass) |
| `packages/bridge` | Multi-server MCP client, `server__tool` namespacing, task-based filtering, approval policy |
| `packages/channel-http` | HTTP channel adapter — bridges `POST /task` to the gateway via the `role: 'channel'` seat |
| `apps/console` | Next.js TORQ terminal (reconnect, seq replay, skill approval) |
| `engines/hermes_kernel` | Streamable-HTTP MCP wrapper over vendored `hermes-agent` |

## Quickstart

```bash
git clone https://github.com/pilotwaffle/TORQCLAW.git && cd TORQCLAW
git submodule update --init --recursive          # pull pinned upstream Hermes
pnpm install
pnpm --filter @torqclaw/contracts build          # emit schemas (TS + Python copies)

# Python engine: venv + deps + the vendored agent (its deps are NOT in uv sync)
cd engines/hermes_kernel && uv sync
uv pip install -e ./vendor/hermes-agent
cd ../..

pnpm model:setup                                 # optional: ollama create torq-local
cp .env.example .env                             # then add your provider key (see Configuration)

# one command brings up engine + gateway + console (engine-first ordering):
node --env-file=.env ops/dev-up.mjs              # console at http://localhost:3000
```

A quick stub-mode smoke test (no provider key needed): `node ops/e2e.mjs`.

## Configuration (env)

| Var | Default | |
|---|---|---|
| `TORQCLAW_DATA_DIR` | `~/.torqclaw` | state.db, credentials, skill queue |
| `TORQCLAW_PORT` / `TORQCLAW_HOST` | `18790` / `127.0.0.1` | loopback-first; never bare 0.0.0.0 |
| `TORQCLAW_GATEWAY_TOKEN` | _(unset = dev mode)_ | required in any non-loopback deployment |
| `HERMES_ENGINE_URL` / `HERMES_ENGINE_TOKEN` | `http://127.0.0.1:8000/mcp` | move to a GPU box = change config, not code |
| `OLLAMA_HOST` / `TORQCLAW_LOCAL_MODEL` | `localhost:11434` / `torq-local` | |
| `HERMES_MODEL` / `HERMES_PROVIDER` / `HERMES_API_KEY` / `HERMES_BASE_URL` | _(unset = stub mode)_ | FRONTIER provider. **Recommended default: DeepSeek v4-flash** (`provider=deepseek`, `model=deepseek-v4-flash`, `base_url=https://api.deepseek.com`) — cheapest capable workhorse. Anthropic / OpenRouter / etc. also supported. Bring your own key. |
| `HERMES_CODING_PROVIDER` / `HERMES_CODING_MODEL` / `HERMES_CODING_API_KEY` / `HERMES_CODING_BASE_URL` | _(optional)_ | Per-task override for `COMPLEX_CODING` — e.g. Kimi K2.6 (`provider=openai`, `model=kimi-k2.6`, `base_url=https://api.moonshot.ai/v1`) via the generic OpenAI-compatible client. Blank MODEL = use the default for coding too. |
| `TORQCLAW_PREFER_CLOUD` | _(unset)_ | `1` lowers the local-routing bar so the ambiguous confident-middle goes to cloud — for machines where local inference is impractically slow (throttled dGPU). Privacy / LOCAL_ONLY / LOCAL_INTENT still route local. |
| `TORQCLAW_DEFAULT_MAX_COST` | _(unset = unlimited)_ | fallback USD budget when a task sets none; a FRONTIER task with no budget logs a one-line warning |
| `HERMES_MAX_ITERATIONS` | `30` | hard cap on the agent loop; the budget guard of last resort when spend reporting is unavailable |
| `HERMES_STUB_COST_USD` | `0.0` | stub-mode reported spend (testing the breaker) |
| `HERMES_STUB_COST_UNAVAILABLE` | _(unset)_ | `1` makes stub spend report `null` (testing the unenforceable-budget path) |

## Run controls (per task)

The console's controls strip sets, per submission, what the user alone can
decide:

- **Budget** — `default` (env fallback), `Free (local only)`, `$0.25/$1/$5`, or
  a custom amount. Maps to `maxCostUsd`; the gateway enforces it from
  **provider-reported spend** (no static pricing table) and cancels on breach.
  If a provider can't report spend, the run says so once — the budget is then
  unenforceable and `HERMES_MAX_ITERATIONS` is the only guard.
- **Mode** — `Auto`, `This machine only` (`LOCAL_ONLY`, a hard router rule), or
  `Cloud allowed`. `Free (local only)` forces `LOCAL_ONLY`.
- **fast** (`urgent`) and **private** (`containsSensitiveData`, never cleared by
  any automation — only the user sets it).
- **stop** cancels a running task within ~one poll interval.

A client-side regex surfaces a *suggestion* to keep a prompt private when it
looks like it contains credentials — it never sets the flag or blocks
submission. Choices persist in `sessionStorage`.

## Stats

```bash
pnpm stats   # node ops/stats.mjs — reads ~/.torqclaw/state.db (read-only)
```

Aggregates entirely in SQL (`->>` JSON operators): tasks by tier×state,
FRONTIER cost (total/avg/max/p95 + cost per completed task), classifier method
& confidence, router-reason distribution, and product metrics — non-Auto
submission share, budget-breaker firings, user cancellations, the approval
funnel, and tool-result truncation pressure. Every section handles zero rows.

The `tasks.telemetry_json` column (cost, iterations, tools) is added by an
idempotent boot migration (`PRAGMA table_info` check), so an existing dev DB
upgrades in place. Pre-release, deleting `~/.torqclaw/state.db` to start fresh
is also fine.

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

A `"tools": [...]` allowlist registers **only** the named (un-namespaced) tools
from a server and drops the rest. Essential for big servers — a TradingView MCP
exposes 80+ tools whose full schema set would overflow the local 8K context
window; allowlisting the handful you need (e.g. `quote_get`, `symbol_info`)
keeps LOCAL_EDGE runs viable and the model focused. Omit to register everything.

> **Stateful-server gotcha:** some MCP servers report on *current state*, not a
> queried target. The TradingView `quote_get` reads whatever symbol the desktop
> chart currently shows — passing `symbol` only labels the output. To quote a
> specific instrument, allowlist `chart_set_symbol` too so the agent switches the
> chart first, then quotes. (That write tool gates for approval on LOCAL_EDGE.)

> **Tier note:** bridge-registered MCP servers feed the **LOCAL_EDGE** loop.
> The **FRONTIER** tier runs the Hermes engine's own toolsets (web/files/etc.),
> so a task that must use a bridge tool (like TradingView) should run
> `LOCAL_ONLY` (the "This machine only" mode) — otherwise prefer-cloud routes it
> to FRONTIER, which can't see the bridge server.

### Workspace path scoping (P5)

A server entry may declare a filesystem scope, enforced in the bridge **before**
a tool runs:

```json
"pathArgKeys": ["path", "paths", "source", "destination"],
"paths": {
  "read":  ["/path/to/workspace"],
  "write": ["/path/to/workspace"],
  "deny":  ["~/.ssh", "~/.aws", "~/.config", ".env"]
}
```

Every path-like argument (keys from `pathArgKeys`, else common defaults) is
**resolved** — `~` expanded, `..` collapsed — before matching, so
`/work/../etc/passwd` or `~/.ssh/../.ssh/id_rsa` cannot slip past a rule. `deny`
always wins; an empty `read`/`write` list means that mode is unconstrained;
write-capable tools check `write`, others `read`. A denied path becomes a tool
error fed back to the model plus a SYSTEM event.

This is **defense in depth alongside** the MCP server's own sandboxing (e.g. the
filesystem server's allowed-dirs args) — both layers apply; either can deny.

## Tool approval (both tiers)

A write-capable tool never runs without a human OK — on **either** tier, via one
shared path:

- **LOCAL_EDGE:** the Ollama loop throws `ToolApprovalRequired` at a gated,
  ungranted tool.
- **FRONTIER:** the Hermes engine blocks the tool via its own `pre_tool_call`
  plugin hook (registered programmatically from `mcp_wrapper/approval_hook.py` —
  no vendor fork); the bridge then throws the same error.

Either way, **dispatch** (the single terminal-emission point) registers the
approval and emits one terminal `PENDING_APPROVAL`. The console renders a
permission card (exact tool, args, one-time scope). **Allow once** mints a new
request carrying a gateway-owned `grantedTools=[tool]` — constraints preserved
verbatim, a grant-notice prepended to the context — and re-dispatches; the tool
then runs. **Deny** ends with a terminal `ERROR`. The blocked attempt writes no
`RESULT` and is never stored to memory, so it can't poison future context.

`grantedTools` lives only on the internal `GatewayRequest` — a client
`SUBMIT_PROMPT` cannot inject it.

## Channels

The console is one client. The `ConnectFrame` contract reserves three roles —
`operator` (the console), `channel` (an external surface like HTTP/Slack/
Discord), and `node` (a future compute peer) — so any number of surfaces can
drive the same gateway, sessions, routing, and safety gates.

The first non-console channel ships in `packages/channel-http`: a plain HTTP
adapter. It connects to the gateway as `role: 'channel'`, submits the prompt,
waits for the single terminal event (invariant 7), and returns it as JSON.

```bash
TORQCLAW_HTTP_CHANNEL=1 node --env-file=.env ops/dev-up.mjs   # adds :18792

curl -s localhost:18792/task -H 'content-type: application/json' \
  -d '{"prompt":"research MCP gateway namespacing and compare the options"}'
# → {"ok":true,"tier":"cloud","answer":"…","sessionId":"…"}
```

Pass `sessionId` back on the next call to keep multi-turn context; set
`executionMode`/`sensitive`/`maxCostUsd` exactly like the console controls. A
task that needs interactive tool approval returns `202 pending_approval` —
a headless channel can't click a permission card, so it says so honestly rather
than pretending the tool ran. Front-door auth via `CHANNEL_HTTP_TOKEN` (Bearer);
the adapter's own gateway auth is the separate `TORQCLAW_GATEWAY_TOKEN`.

`packages/channel-http/src/gatewayClient.ts` is the reusable bridge core — a
Slack or Discord adapter swaps only the transport layer and keeps the same
connect → submit → await-terminal logic.

## Design invariants

1. **Every frame is contract-validated** — at the WS boundary, inside the gateway
   (it parses its own output), and at the Python boundary (compiled JSON Schema).
2. **Sessions outlive sockets.** Execution publishes to a session bus; sockets
   subscribe, drop, and resume via monotonic `seq` cursors — never timestamps.
3. **Privacy beats everything** in routing; classifier uncertainty buys frontier
   capability; write-capable tools pause for human approval on **both** tiers.
4. **Skills never auto-deploy.** Drafts land in an approval queue; only an
   operator decision writes to the skills directory.
5. **Wrap, don't rewrite.** Upstream Hermes is a pinned submodule; we own only
   `mcp_wrapper/`.
