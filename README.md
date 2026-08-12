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
| Resilient extensibility (PRD-TCLAW-RESILIENT-EXTENSIBILITY-001) | **Partially landed** — see [Resilient extensibility](#resilient-extensibility-partially-landed) |
| Current master | `e3ae332` (PR #37), CI green |
| Verified gate on `e3ae332` | `991/991` TypeScript tests across 43 files · `186` passed / `1` skipped Python engine tests · typecheck `12/12` · contracts drift OK (8 schemas, 2 dirs) · build `7/7` |

Gate figures above were reproduced from a clean checkout of `e3ae332`, not copied from a pre-merge worktree.

The portable launcher derives every path from its own location; it does not require a particular drive, checkout name, or current working directory.

## What is implemented

### Governed execution

- Hybrid routing across **LOCAL_EDGE** and **FRONTIER** tiers.
- Privacy and local-only rules override model confidence.
- Role-based command authorization for operator/channel/node seats.
- Headless channels cannot silently approve gated actions.
- Gateway-owned grants: clients cannot inject `grantedTools`.
- All terminal task outcomes flow through the governed gateway event path.
- Every task binds to one named execution profile before dispatch; out-of-profile tools are never offered to the model.
- Optional provider failover retries retryable provider failures without replaying tool calls or side effects.

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

## Resilient extensibility (partially landed)

`docs/PRD-TCLAW-RESILIENT-EXTENSIBILITY-001.md` scopes three slices. Their real
state on `master` differs per slice, and the distinction matters before relying
on any of them.

### Provider failover — landed, opt-in, default off

Deterministic provider chains with side-effect-safe retry. A task that fails on
a retryable provider error can complete on a healthy fallback; failover never
replays a tool call or an external side effect, and never switches providers
after an irreversible side effect in the same task. Each attempt, transition
reason, elapsed time, and cost provenance is recorded on the receipt.

Failover stays off unless `TORQCLAW_PROVIDER_FAILOVER_ENABLED=true` **and**
`TORQCLAW_PROVIDER_CHAINS_PATH` points at a valid chain file. Invalid
configuration fails closed with `FAILOVER_CONFIG_REJECTED` rather than silently
running unprotected. None of these variables are in `.env.example`; they are
deliberately explicit opt-in.

| Variable | Notes |
|---|---|
| `TORQCLAW_PROVIDER_FAILOVER_ENABLED` | Must be exactly `true` to enable |
| `TORQCLAW_PROVIDER_CHAINS_PATH` | Required when enabled; chain definition file |
| `TORQCLAW_PROVIDER_CHAIN_REVISION` | Chain revision stamp |
| `TORQCLAW_FAILOVER_DEFAULT_CHAIN` / `TORQCLAW_FAILOVER_CODING_CHAIN` | Chain selection by task class |
| `TORQCLAW_FAILOVER_ATTEMPT_TIMEOUT_MS` / `TORQCLAW_FAILOVER_TASK_DEADLINE_MS` | Per-attempt and whole-task bounds |
| `TORQCLAW_FAILOVER_TRANSITION_MIN_MS` / `TORQCLAW_FAILOVER_TRANSITION_MAX_MS` | Transition backoff bounds |
| `TORQCLAW_FAILOVER_CANCEL_ACK_MS` | Cancellation acknowledgement bound |

### Execution profiles — landed and always on

Every task resolves to exactly one named profile before dispatch, visible in
route preview and on the receipt. A tool outside the active profile is never
sent to the model and cannot execute through the bridge. Requesting a *broader*
profile than the session default requires operator authority; requesting a
stricter one does not. Unknown or unauthorized broadening fails closed.

| Profile | Capabilities | Tiers | Path / network | Approval required |
|---|---|---|---|---|
| `read_only` | read | LOCAL_EDGE | none / none | — |
| `workspace_write` | read, write | LOCAL_EDGE, FRONTIER | workspace / none | write |
| `browser_research` | read | LOCAL_EDGE, FRONTIER | none / browser | — |
| `terminal_power` | read, write, exec | LOCAL_EDGE, FRONTIER | configured / configured | write, exec |

Default profile by task type: `DATA_EXTRACTION` and `SUMMARIZATION` →
`read_only`; `ROUTINE_AUTOMATION` → `workspace_write`; `AUTONOMOUS_RESEARCH` →
`browser_research`; `COMPLEX_CODING` → `terminal_power`.

### Verified skills — wired, gated, default off

`engines/hermes_kernel/mcp_wrapper/verified_skill_store.py` implements atomic
staging, digest-bound approval, activation, rollback, and journal recovery. As
of GS-COORD it **is** reachable at runtime: the live
`skill_queue.decide()` → `governed_skills.install_approved_skill()` path drives
it through `ActivationCoordinator`, under
`LOCK → quiescence → publish → invalidate → commit → verify → unlock` with
restore-before-unlock. Activation is transactional — on failure the prior
projection is restored, the new digest is not active, the approval is not
falsely consumed, and no retained journal can later complete it silently.

As of GS-ROLLBACK, rollback is also end-to-end: the
`rollback_skill` MCP tool → `governed_skills.rollback_governed_skill()` path
runs the same coordinator transaction, re-publishing the target version's
bytes and verifying their digest — never governance alone (the GS-ACCEPT F-1
divergence).

As of GS-DISABLE, disable is end-to-end too: the `disable_skill` MCP tool →
`governed_skills.disable_governed_skill()` path runs the same coordinator
transaction with the projection step reversed — it retains and removes the
published projection, invalidates the prompt cache, commits
`store.disable()`, then verifies the skill is both governed-disabled and
**no longer published**. The store-only `disable()` had the identical
governance/projection divergence F-1 found in `rollback()`: it reported
"off" while the model kept receiving the skill in every rendered system
prompt. Installed digest history survives a disable, and **rollback is the
designed inverse** — re-enabling means rolling back to the exact digest you
want, so there is deliberately no separate enable surface that would have to
guess one. Empty and whitespace-only skill bodies are now refused at the
package-validation seam (`MIN_SKILL_BYTES`), closing GS-ACCEPT finding F-2.

**Operator ruling 2026-08-11: governed skills are ON for this deployment**
(`TORQCLAW_GOVERNED_SKILLS=1` in the operator's user environment). The
prerequisite evidence existed: GS-ACCEPT booted a real agent against the
shipped binary (receipt: 8 passed / 2 xfailed at `83690f3`), its blocking
finding was closed by GS-ROLLBACK, and the acceptance suite re-ran green on
the merged tree. The operator collapsed the separate soak window into live
operation — governed mode IS the soak, monitored in use, with flag-off as
the immediate rollback. The flag itself still defaults off in code: a fresh
deployment must still opt in explicitly.

Skills reach the queue by operator paste and digest-bound review. **Remote skill
distribution is not implemented**: no downloader, no HTTPS bounds, no pinned
upgrades, no revocation refresh. `skill.json` accepts optional Ed25519 signature
metadata and the store validates its *shape only* — it performs no cryptographic
verification, and signatures are not required.

Ed25519 origin trust bundles live in `packages/gateway/src/skillTrust.ts`. That
module is **dormant by declaration** — 662 lines with no consumer until remote
sources exist, recorded in `ops/reachability.mjs` and enforced by
`pnpm reachability`, which fails CI on any substantial module that is neither
reachable nor explicitly declared. Nothing in TORQCLAW verifies a skill
signature today.

Two further caveats recorded with the checkpoint: Phase-1 failover evidence
rests on a deterministic loopback/fake-provider fixture rather than a live
two-provider pilot, and canonical signing uses a bounded deterministic JSON
canonicalizer without RFC 8785 interoperability vectors.

## Graphify project profiles

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
| `packages/gateway` | Fastify gateway, sessions, authz, dispatch, receipts, approvals, safe export, profile resolution, provider failover |
| `packages/inference` | LOCAL_EDGE Ollama-compatible tool loop |
| `packages/bridge` | MCP server registry, namespacing, tool filtering, capability/path/profile policy |
| `packages/channel-http` | HTTP channel adapter using the `role: 'channel'` seat |
| `apps/console` | Next.js console: route preview, receipts, approvals, safe export UI, `/api/health` |
| `engines/hermes_kernel` | Python MCP wrapper over vendored `hermes-agent`; attempt ledger, failover runtime, verified skill store |
| `ops/` | Portable install/start wrappers, doctor, readiness, e2e and live-acceptance harnesses |
| `docs/TRUSTOS-BUILD-LEDGER.md` | Implementation ledger and phase closeout record |
| `docs/PRD-TCLAW-RESILIENT-EXTENSIBILITY-001.md` | Failover / profiles / verified-skills program spec |

## Quickstart

```bash
git clone https://github.com/pilotwaffle/TORQCLAW.git
cd TORQCLAW
ops/install-torqclaw.cmd       # Windows
# or: sh ops/install-torqclaw.sh
copy .env.example .env         # Windows; use cp on POSIX
```

The install wrappers run the submodule, frozen pnpm, contracts build, `uv sync --locked`, vendored Hermes editable install, and Hermes import checks. They never create or overwrite `.env`.

Before production start, replace both `TORQCLAW_GATEWAY_TOKEN=change-me` and `NEXT_PUBLIC_GATEWAY_TOKEN=change-me` with the same non-placeholder value.

Before starting, run `node --env-file=.env ops/doctor.mjs --preflight --production` (or `pnpm doctor`). Start the portable production path with `ops/start-torqclaw.cmd`, `sh ops/start-torqclaw.sh`, or `pnpm start`. The wrappers can be launched from any current directory and keep the stack on loopback.

Console: `http://127.0.0.1:3000`  
Gateway: `127.0.0.1:18790`  
Engine health: `127.0.0.1:8000/health`

For a real provider acceptance run, configure non-placeholder matching gateway tokens plus `HERMES_MODEL`, `HERMES_PROVIDER`, and `HERMES_API_KEY`, start the stack, then run:

```bash
node --env-file=.env ops/doctor.mjs --runtime --production
pnpm acceptance:live
```

Live acceptance is deliberately not part of public CI and never succeeds by skipping, stubbing, or accepting a pending/error result. Public CI uses a synthetic-token, stub-mode production-launch e2e instead.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `TORQCLAW_DATA_DIR` | `~/.torqclaw` | Gateway state DB, credentials, skill queue |
| `TORQCLAW_PORT` / `TORQCLAW_HOST` | `18790` / `127.0.0.1` | Loopback-first gateway binding |
| `TORQCLAW_CONSOLE_PORT` / `HERMES_BIND_HOST` | `3000` / `127.0.0.1` | Portable console and engine ports/hosts |
| `TORQCLAW_GATEWAY_TOKEN` | unset dev mode | Required for non-loopback deployment |
| `HERMES_ENGINE_URL` / `HERMES_ENGINE_TOKEN` | `http://127.0.0.1:8000/mcp` | Python engine MCP endpoint; local URLs cannot carry credentials |
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

Current gate, reproduced from a clean checkout of `e3ae332`:

```text
991/991 TypeScript tests across 43 files
186 passed / 1 skipped Python engine tests
typecheck 12/12
contracts drift OK — 8 schemas in 2 checked-in dirs
build 7/7
```

The Python figure is CI's gate: `uv run pytest` from `engines/hermes_kernel`.
The `tests/resilience/` suite at the repository root is a separate
manifest-driven harness and is not part of that count.

On a cold checkout the `tests/failover/*` cases spawn real engine subprocesses
and can exceed the 15s per-test timeout while the Python environment is still
being resolved. This presents as roughly a dozen failing files on a first run
and clears on a warm re-run. Let `uv sync` finish before treating a failover
timeout as a real regression.

Historical Phase-1 closeout gate, for reference only — `805/805` TypeScript and
`75/75` Python tests at commit `f5fbee7`.

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
- Portable production runtime, doctor/readiness gating, and live-provider acceptance harness.
- `TCLAW-FIX-G` — resolved 2026-08-01: decision-time cache refresh plus authoritative live-approval overlay in `GET_RECEIPT`.
- `TCLAW-FIX-H` — resolved 2026-08-01: shared bounded diagnostic redaction boundary plus versioned legacy-row migration/quarantine.

In progress:

- Resilient extensibility — provider failover and execution profiles landed; verified skills not integrated. See the section above for per-slice status and exit criteria.

Not started:

- Phase 2 — Governed Learning MVP.

Filed non-blocking residuals:

- `TCLAW-GRAPHIFY-CLEANUP` — Graphify cleanup/relocation operator lane.
