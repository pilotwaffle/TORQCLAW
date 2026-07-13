# TORQCLAW

**TORQCLAW TrustOS** is a governed local/cloud AI agent control plane: a TypeScript gateway, router, MCP bridge, and console UI wrapped around a forked Hermes Python execution engine.

It is built around one product thesis:

```text
Local when private.
Cloud when needed.
Approval before action.
Budget before spend.
Receipts after every run.
Learning that is measurable, governed, and reversible.
```

## Program status

| Area | Status |
|---|---|
| Phase 0 — Foundation Repair | **Complete** |
| Phase 1 — Visible Trust MVP | **Complete** |
| Phase 2 — Governed Learning MVP | **Not started** |
| Current remote baseline | `origin/master` closed Phase 1 at `1fe4ce25812da2502d2268efd65f49bf833100b5` |
| Current green gate | `805/805` TypeScript tests · `75/75` Python tests · typecheck `12/12` · contracts drift OK · build `7/7` |

The local `E:\TorqClaw` checkout was last confirmed clean at the same Phase-1 closeout state before this README refresh. This README summarizes the improvements now implemented on GitHub.

## What is implemented

### Governed execution

- Hybrid routing across **LOCAL_EDGE** and **FRONTIER** tiers.
- Privacy and local-only rules override model confidence.
- Role-based command authorization for operator/channel/node seats.
- Headless channels cannot silently approve gated actions.
- Gateway-owned grants: clients cannot inject `grantedTools`.
- All terminal task outcomes flow through the governed gateway event path.

### Cost control

- Per-task budgets from console controls or `TORQCLAW_DEFAULT_MAX_COST`.
- Provider-reported spend is the enforcement source of truth.
- Budget breach cancels execution and emits a clear failure path.
- Honest fallback when spend is unavailable: the iteration cap is the guard.
- Cost summaries and receipt fields expose enforcement state without static pricing-table claims.

### Route transparency

- Route preview and structured route explanation surfaces.
- Router diagnostics are surfaced to the console and receipts.
- Local/private safety locks are visible and not silently overridden.
- Route receipts show what was selected and why.

### Approval safety

- Write-capable tools pause for approval on both tiers.
- Approval card v2 shows mechanical gate facts without inventing risk scores.
- Registry misses render honestly as `write-class (unclassified)`.
- FRONTIER engine hooks render as engine approvals without fake capability labels.
- Approval history UI reads live approval truth from `tool_approvals`, not stale receipt embeds.
- Pending history rows are display-only; the live approval card remains the only action surface.

### Receipts and replay

- Terminal tasks produce queryable receipts from real telemetry.
- Receipts avoid fabricated values and distinguish missing facts from known facts.
- Receipt replay and safe diagnostic export are separate surfaces: raw local diagnostics remain local/unredacted, while safe export uses server-side redaction.

### Safe diagnostic export

- `GET_SAFE_EXPORT` is an operator-only read command.
- Safe export is generated on demand; `run_receipts.safe_export_json` deliberately remains `NULL`.
- Unknown fields fail closed and do not export.
- Prompts, assembled context, raw event replay, raw args, raw results, and memory context are omitted wholesale.
- Retained short residue is scrubbed for known secret shapes before character caps.
- Absolute Windows, UNC, POSIX-home, and `~` paths redact to `[REDACTED:path]`.
- Approval status is read from live `tool_approvals`, not frozen receipt embeds.
- Safe export copy includes an explicit notice: known secret shapes were removed, but the export cannot guarantee that no secrets remain.

### Protocol integrity

- Zod contracts remain the TypeScript source of truth.
- JSON Schema is emitted into both the contracts package and Python wrapper schema directory.
- `pnpm contracts:check` verifies generated schema drift.
- CI gates TypeScript tests, typecheck, contracts drift, build, and Python wrapper tests.

### Graphify project profiles

Graphify project profile files are present on `master` through governed Graphify PRs and are accepted current repository state. Graphify relocation or cleanup remains a separate operator-lane item and is not part of TrustOS Phase 1.

## Architecture

```text
 [ Console / HTTP channel / future channel adapters ]
                  │
                  ▼
 ┌─────────────────────────────────────────────┐
 │ TypeScript Control Plane                    │
 │ Fastify gateway :18790 · sessions · authz   │
 │ enrich → route → dispatch → receipts        │
 └───────────────┬─────────────────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
 ┌──────────────┐   ┌──────────────────────────┐
 │ LOCAL_EDGE   │   │ FRONTIER / Hermes Engine │
 │ Ollama /v1   │   │ Python · MCP wrapper     │
 │ tool loop    │   │ streamable-http          │
 └──────┬───────┘   └──────────┬───────────────┘
        │                      │
        └──────────┬───────────┘
                   ▼
 ┌─────────────────────────────────────────────┐
 │ Universal MCP Bridge                        │
 │ namespaced tools · capability policy        │
 │ path scope · approval-gated writes          │
 └─────────────────────────────────────────────┘
```

## Layout

| Path | What |
|---|---|
| `packages/contracts` | Zod source of truth; emits JSON Schema for TypeScript and Python consumers |
| `packages/router` | Hybrid route rule hierarchy and diagnostics |
| `packages/gateway` | Fastify gateway, sessions, authz, dispatch, receipts, approvals, safe export |
| `packages/inference` | LOCAL_EDGE Ollama-compatible tool loop |
| `packages/bridge` | MCP server registry, namespacing, tool filtering, capability/path policy |
| `packages/channel-http` | HTTP channel adapter using the `role: 'channel'` seat |
| `apps/console` | Next.js console: route preview, receipts, approvals, safe export UI |
| `engines/hermes_kernel` | Python MCP wrapper over vendored `hermes-agent` |
| `docs/TRUSTOS-BUILD-LEDGER.md` | Implementation ledger and phase closeout record |

## Quickstart

```bash
git clone https://github.com/pilotwaffle/TORQCLAW.git
cd TORQCLAW

git submodule update --init --recursive
pnpm install
pnpm --filter @torqclaw/contracts build

# Python engine: venv + deps + vendored Hermes agent dependencies
cd engines/hermes_kernel
uv sync
uv pip install -e ./vendor/hermes-agent
cd ../..

# Optional local model setup
pnpm model:setup

# Configure environment
cp .env.example .env

# Bring up engine + gateway + console
node --env-file=.env ops/dev-up.mjs
```

Console: `http://localhost:3000`  
Gateway: `127.0.0.1:18790`  
Optional HTTP channel: `127.0.0.1:18792`

A quick stub-mode smoke test with no provider key:

```bash
node ops/e2e.mjs
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `TORQCLAW_DATA_DIR` | `~/.torqclaw` | Gateway state DB, credentials, skill queue |
| `TORQCLAW_PORT` / `TORQCLAW_HOST` | `18790` / `127.0.0.1` | Loopback-first gateway binding |
| `TORQCLAW_GATEWAY_TOKEN` | unset dev mode | Required for non-loopback deployment |
| `HERMES_ENGINE_URL` / `HERMES_ENGINE_TOKEN` | `http://127.0.0.1:8000/mcp` | Python engine endpoint |
| `OLLAMA_HOST` / `TORQCLAW_LOCAL_MODEL` | `localhost:11434` / `torq-local` | LOCAL_EDGE model config |
| `HERMES_MODEL` / `HERMES_PROVIDER` / `HERMES_API_KEY` / `HERMES_BASE_URL` | unset stub mode | FRONTIER provider config |
| `HERMES_CODING_PROVIDER` / `HERMES_CODING_MODEL` / `HERMES_CODING_API_KEY` / `HERMES_CODING_BASE_URL` | optional | Per-task override for complex coding tasks |
| `TORQCLAW_PREFER_CLOUD` | unset | `1` lowers the bar for cloud routing while privacy/local-only still win |
| `TORQCLAW_DEFAULT_MAX_COST` | unset/unlimited | Fallback budget when a task sets none |
| `HERMES_MAX_ITERATIONS` | `30` | Hard cap on the Hermes loop |
| `HERMES_STUB_COST_USD` | `0.0` | Stub-mode spend value for tests |
| `HERMES_STUB_COST_UNAVAILABLE` | unset | `1` makes stub spend unavailable |

## Run controls

The console controls are user-owned and per submission:

- **Budget** — default/env fallback, free local-only, fixed amounts, or custom `maxCostUsd`.
- **Mode** — Auto, This machine only (`LOCAL_ONLY`), or Cloud allowed.
- **Private** — sets `containsSensitiveData`; automation must not clear it.
- **Fast/urgent** — latency hint for routing.
- **Stop** — cancels a running task through the gateway.

A credential-looking prompt may trigger a client-side suggestion to mark private. It never silently flips the flag and never blocks submission.

## Tool approvals

A write-capable tool never runs without operator approval.

- LOCAL_EDGE raises `ToolApprovalRequired` before executing an ungranted gated tool.
- FRONTIER blocks through the Hermes `pre_tool_call` hook and returns through the same gateway approval path.
- `APPROVE_TOOL` carries only `approvalId` and decision; the gateway reads the tool and args from its own database.
- Allow once re-mints a gateway-owned one-shot grant.
- Deny ends with a terminal error and does not store memory.
- Approval history is read-only and display-only; history rows cannot approve.

## Safe diagnostic export

Safe export is designed for support/debugging without pretending to solve all data-leak risk.

- Request via `GET_SAFE_EXPORT` from an operator seat.
- Export is generated on demand from allowed receipt/task/approval facts.
- Server redaction removes known secret shapes and absolute path shapes.
- The UI displays the redaction report before copy.
- Copy JSON uses the server SafeExport object exactly.
- Copy Markdown is a pure projection of that object with GitHub-paste escaping.
- Raw local diagnostics remain available only as explicitly labeled local/unredacted diagnostics.

## Channels

The console is the primary operator client. `packages/channel-http` is the first non-console adapter and connects as `role: 'channel'`.

```bash
TORQCLAW_HTTP_CHANNEL=1 node --env-file=.env ops/dev-up.mjs

curl -s localhost:18792/task -H 'content-type: application/json' \
  -d '{"prompt":"research MCP gateway namespacing and compare the options"}'
```

A task that needs interactive approval returns a pending-approval response honestly; a headless channel cannot click the approval card.

## Adding MCP servers

Copy `ops/servers.example.json` to `~/.torqclaw/servers.json`.

Each server entry supports:

- `id` for namespace prefixing, such as `filesystem__read_file`.
- `stdio` or `streamable-http` transport.
- optional `tools` allowlist to keep large servers focused.
- capability/approval policy.
- `pathArgKeys` and path scopes for read/write/deny enforcement.

Path-like arguments are resolved before policy matching. `deny` always wins.

## Verification

Run the current gate:

```bash
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm build
cd engines/hermes_kernel
uv run pytest
```

Current Phase-1 closeout gate:

```text
805/805 TypeScript tests
75/75 Python tests
typecheck 12/12
contracts drift OK
build 7/7
```

## Design invariants

1. **No hidden authority.** Client requests cannot inject grants, scopes, approvals, or internal authorization.
2. **Privacy beats routing confidence.** Private/local-only tasks stay local.
3. **Budget before spend.** Cloud tasks carry an explicit budget story.
4. **Approval before write.** Write-class tools pause on both tiers.
5. **Receipts from evidence.** Receipts and exports are built from recorded facts; absent facts are not invented.
6. **Safe export is honest.** It removes known secret shapes but never claims total safety.
7. **Protocol drift fails fast.** Generated schemas are checked against source of truth.
8. **Wrap, do not rewrite Hermes.** Upstream Hermes remains vendored; TORQCLAW owns `mcp_wrapper/`.
9. **Governed phases.** Phase 2 is not started until explicitly scoped and approved.

## Roadmap

Completed:

- Phase 0 — Foundation Repair.
- Phase 1 — Visible Trust MVP.

Not started:

- Phase 2 — Governed Learning MVP.

Filed non-blocking residuals:

- `TCLAW-FIX-G` — refresh/re-project receipt approval embeds after approval decision.
- `TCLAW-FIX-H` — at-rest sanitization for persisted `tasks.error` / `full_receipt_json.error`.
- `TCLAW-GRAPHIFY-CLEANUP` — Graphify cleanup/relocation operator lane.
