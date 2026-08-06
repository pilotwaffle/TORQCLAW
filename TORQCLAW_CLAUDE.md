# CLAUDE.md — TORQCLAW

## Project Identity

Address the operator as **King Flowers**.

TORQCLAW is a hybrid AI orchestrator with:

- TypeScript control plane: gateway, router, MCP bridge, HTTP/channel adapters, console UI
- Python Hermes execution engine: vendored Hermes agent wrapped by `engines/hermes_kernel/mcp_wrapper/`
- Local edge tier: Ollama `/v1` tool loop for private/low-complexity/local-only tasks
- Frontier tier: Hermes engine for complex/research/cloud-allowed tasks
- Universal MCP bridge: namespaced MCP tools, task-filtered exposure, approval-gated writes

This repository is **not** TORQ Console and is **not** the TORQ V5/V6 harness lane.

## Instruction Precedence

Apply instructions in this order:

1. Direct operator instruction in the current session
2. Repo-local `CLAUDE.md` in this repository
3. Global `E:\.claude\CLAUDE.md`
4. General Claude Code defaults

If global instructions conflict with this file while working inside TORQCLAW, this repo-local file controls unless the global rule is more restrictive on safety, secrets, destructive commands, untracked files, or owner-gated actions.

Before making changes, report:

1. Which instruction files were found
2. Which instruction file controls this task
3. Current directory
4. Branch and HEAD
5. `git status --short`
6. Whether the task is read-only, bounded implementation, review, or owner-gated

## Non-TORQ Boundary

When working in this repo:

- Do not touch `E:\TORQ-CONSOLE`.
- Do not touch TORQ Console `torq_mmh/`.
- Do not switch into TORQ V5/V6 harness mode.
- Do not use TORQ Console live harness owner state as authority for this repo.
- Do not modify unrelated projects, global memory, or global hooks unless explicitly instructed.

TORQCLAW has its own repo-local authority and safety rules.

## Temporary Model-Role Contract

Until Fable 5 access is restored, use this model routing:

- **G1D / planner / orchestrator:** Opus 4.8
- **G1R / independent reviewer:** Opus 4.7
- **Builder / implementer:** Haiku 4.5 (operator-assigned 2026-08-06; previously Sonnet 5)
- **RB / alternate debug worker:** GLM-5.2, if configured and available
- **G2A / final auditor:** Opus 4.8
- **Memory-writer:** Sonnet 5 or fast model, limited to approved memory/state files

After Fable 5 access returns, Fable 5 may resume as G1D / top-level planner if the operator explicitly enables it.

Authority rules:

- G1D plans, scopes, and routes.
- G1R reviews non-trivial design/risk before build.
- Builder implements bounded approved work only.
- GLM-5.2 may scout, triage, debug, or propose; it is not final authority.
- G2A audits after build and tests.
- Memory-writer records verified progress only after G2A passes or operator explicitly authorizes.
- Builder cannot approve its own work.
- G2A verdict controls final pass/fail.
- Operator controls push, merge, release, destructive actions, production config, and irreversible operations.

## Repository Architecture

High-level structure:

| Path | Purpose |
|---|---|
| `packages/contracts` | Zod contract source of truth; emits JSON Schema for Python |
| `packages/router` | Routing rules: privacy, classifier confidence, tool count, cold start, heuristics |
| `packages/gateway` | Fastify websocket gateway, session engine, memory, dispatch |
| `packages/inference` | LOCAL_EDGE Ollama tool loop |
| `packages/bridge` | MCP registry, namespaced tools, task filtering, approval policy |
| `packages/channel-http` | HTTP channel adapter for `POST /task` |
| `apps/console` | Next.js terminal console |
| `engines/hermes_kernel` | Streamable-HTTP MCP wrapper over vendored `hermes-agent` |
| `ops` | Dev startup, stats, e2e, server examples |
| `tests` | Repo-level tests |

Architecture rules:

- `packages/contracts` is the contract source of truth.
- Do not hand-edit generated JSON Schema copies unless the repo explicitly requires it.
- If Zod contracts change, run the contracts build.
- Python boundary behavior must stay aligned with emitted schemas.
- Wrap Hermes through `mcp_wrapper/`; do not rewrite vendored Hermes internals unless explicitly authorized.
- Keep LOCAL_EDGE and FRONTIER behavior distinct.
- Bridge-registered MCP tools feed LOCAL_EDGE; FRONTIER uses the Hermes engine’s own toolsets.
- A task requiring a bridge-only tool should remain LOCAL_ONLY / this-machine-only.

## Core Invariants

Preserve these invariants:

1. Every external frame is contract-validated.
2. Sessions outlive sockets and resume by monotonic `seq` cursors, not timestamps.
3. Privacy beats everything in routing.
4. Classifier uncertainty can route to frontier capability.
5. Write-capable tools require human approval on both LOCAL_EDGE and FRONTIER.
6. Skills never auto-deploy.
7. One terminal event per task.
8. Receipts must come from real telemetry only.
9. Do not fabricate risk scores, tool results, spend, logs, or completion state.
10. Upstream Hermes stays pinned; TORQCLAW owns wrappers and integration code.

## Safety Rules

Mandatory everywhere in this repo:

- Never expose secrets, API keys, provider keys, `.env` values, tokens, credentials, signing files, or private config.
- Never commit `.env`, credential files, local state DBs, generated secrets, or provider keys.
- Do not log or persist secrets into memory, `STATE.md`, `MEMORY.md`, issues, commits, or comments.
- Do not run destructive commands unless explicitly approved.
- Do not delete, reset, clean, move, or overwrite untracked or unknown operator files.
- If the working tree has user-owned edits, stop and report before touching related files.
- Do not claim a command ran unless it actually ran.
- Do not claim tests passed unless exact output is available.
- Never remove or weaken tests to make a build pass.
- Do not add paid services, analytics, tracking, cloud dependencies, or external APIs unless explicitly approved.
- Do not change gateway binding from loopback-first behavior without explicit approval.
- Do not deploy, publish, release, push, or merge unless explicitly approved.

## Shell Editing Safety

Text-file edits must use structured patching (Claude Code `Edit`/`Write` tools or equivalent), never shell regex replacement pipelines.

- PowerShell `-replace` in a double-quoted string expands `$1`/`$2` as (empty) shell variables before the regex engine runs, silently deleting matched content. If PowerShell regex replacement is unavoidable, use single-quoted replacement strings (`'$1'`) or `` `$1 `` escaping.
- The same class of bug applies to `sed`/`awk` with unquoted `$` in double-quoted Bash strings.
- Never bulk-edit an untracked file with shell replacement; there is no recovery path. Confirm the file is committed first, or take a copy.
- This rule exists because a PowerShell `$1` expansion destroyed portions of an untracked PRD on 2026-08-06 (recovered from an in-context copy).

## Cost and Routing Safety

TORQCLAW is designed to prevent runaway cost and unsafe routing.

Rules:

- Preserve provider-reported spend handling.
- If provider spend is unavailable, report that budget enforcement is limited and rely on `HERMES_MAX_ITERATIONS`.
- Do not invent static provider pricing as enforcement truth.
- Do not silently remove or bypass `maxCostUsd` behavior.
- `TORQCLAW_PREFER_CLOUD=1` may bias ambiguous work cloudward, but privacy / LOCAL_ONLY / LOCAL_INTENT must still route local.
- `containsSensitiveData` is user-controlled and must not be cleared by automation.
- Local/private tasks must not be silently routed to FRONTIER.

## Tool Approval Rules

Write-capable tools require approval on both tiers.

Preserve:

- LOCAL_EDGE approval path through `ToolApprovalRequired`.
- FRONTIER approval path through Hermes `pre_tool_call` hook.
- Shared dispatch path for `PENDING_APPROVAL`.
- One-shot `grantedTools` behavior.
- Constraint preservation when retrying after approval.
- Deny ends cleanly.
- Blocked attempts must not write `RESULT` or poison memory.
- Client input must not be able to inject `grantedTools`.

Do not make any write-capable tool auto-run because it is “probably safe.”

## MCP Server Rules

When adding or modifying MCP servers:

1. Use `ops/servers.example.json` as the template.
2. Copy local runtime config to `~/.torqclaw/servers.json`.
3. Keep server IDs stable because they become namespace prefixes.
4. Prefer allowlists for large MCP servers.
5. Update `packages/bridge/src/toolFilter.ts` when exposing a namespace to task types.
6. Use `approvalPatterns` for write/delete/push/create/update/send/exec style tools.
7. A malformed or unreachable server must degrade only that server, never the gateway.
8. Preserve workspace path scoping and deny-list behavior.
9. Deny rules always win.

Stateful MCP warning:

- Some MCP tools operate on current external app state rather than a requested target.
- Do not assume arguments fully control the external app.
- For TradingView-like tools, switch the chart/symbol first if quoting a specific instrument.

## Workspace Path Scoping

Preserve path-scope enforcement in the bridge before tool execution:

- Expand `~`.
- Collapse `..`.
- Resolve path-like arguments.
- Apply `deny` before allow rules.
- Enforce write scope for write-capable tools.
- Enforce read scope for read tools.
- Return tool errors plus SYSTEM events on denied paths.
- Treat bridge path scoping as defense in depth alongside MCP server sandboxing.

## Development Setup

Common setup:

```bash
git submodule update --init --recursive
pnpm install
pnpm --filter @torqclaw/contracts build

cd engines/hermes_kernel
uv sync
uv pip install -e ./vendor/hermes-agent
cd ../..

pnpm model:setup
cp .env.example .env
node --env-file=.env ops/dev-up.mjs
```

Stub-mode smoke test:

```bash
node ops/e2e.mjs
```

Stats:

```bash
pnpm stats
```

## Build and Test Discipline

Before changing code:

1. Inspect `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `vitest.config.ts`, and local package scripts.
2. Prefer the narrowest relevant test first.
3. Run broader tests before claiming completion.
4. If tests cannot run, state why and what evidence was used instead.

Common commands:

```bash
pnpm --filter @torqclaw/contracts build
node ops/e2e.mjs
pnpm stats
pnpm test
```

Do not assume `pnpm test` exists or is the right command; verify scripts first.

## Change Scoping

Use this discipline:

- Make the smallest correct change.
- Touch only files required for the current task.
- Keep generated contract artifacts separate from source changes when possible.
- Keep docs-only changes separate from runtime behavior changes.
- Keep provider config changes separate from router/gateway/bridge logic changes.
- Keep Hermes wrapper changes separate from vendored upstream changes.
- Do not mix refactor, feature, config, and test repair in one uncontrolled change.
- If a file already has unrelated owner edits, stop and ask before editing it.

## Review Gates

Use this routing:

### Light task

Examples: README typo, comment cleanup, small docs update.

- Sonnet may implement.
- Fast verifier may check.
- Opus review optional unless behavior/safety changes.

### Standard task

Examples: router rule change, bridge filter change, package script change, console UI fix.

- Opus 4.8 plans or scopes.
- Sonnet implements.
- Independent verifier checks files/tests.
- Opus review required if behavior changes routing, approval, cost, or security.

### High-risk task

Examples: approval gates, secrets, routing privacy, cloud/frontier dispatch, cost enforcement, provider config, Hermes wrapper behavior, MCP write permissions, path scoping.

- Opus 4.8 scopes.
- Opus 4.7 independently reviews plan.
- Sonnet implements only bounded approved changes.
- Opus 4.8 audits before acceptance.
- Operator approves commit/push/release.

## GLM-5.2 Role

GLM-5.2 may be used as:

- alternate worker
- long-context repo scout
- test/log triage
- bug isolation
- refactor proposal generator
- docs/test draft generator
- second opinion on Sonnet output

GLM-5.2 must not be sole final authority for:

- merges
- releases
- deployment
- security-sensitive changes
- approval-gate changes
- cost-enforcement changes
- privacy-routing changes
- MCP write-permission changes
- irreversible file operations
- architecture approval

Any GLM-produced code touching routing, approval gates, cost enforcement, secrets, production config, or path scoping must be reviewed by Opus 4.8.

## Memory and State

Use project-local memory/state only if present or explicitly requested.

Possible files:

- `STATE.md`
- `MEMORY.md`
- `.claude/agent-state.json`
- `.torqclaw/` local runtime data, if present

Rules:

- Do not store secrets.
- Do not store raw logs unless explicitly requested and scrubbed.
- Do not mark work complete without tests/evidence.
- Memory-writer updates state only after verified progress or explicit operator instruction.
- Keep state entries concise: date, branch, change, tests, verifier result, next action.

## Startup Continuity Scan

At the start of each Claude Code session in this repo, report:

1. Current directory
2. Instruction files found and controlling file
3. Git branch and HEAD
4. `git status --short`
5. Whether submodules are initialized
6. Package manager and workspace files found
7. Relevant package scripts
8. Python engine environment status if touching `engines/hermes_kernel`
9. `.env` presence without revealing values
10. MCP server config presence without revealing secrets
11. Current task authority
12. Safest next action

Do not edit until the current task is bounded.

## Required Output Format

Lead with the result.

Then provide:

1. Outcome
2. Files changed
3. Tests/checks run
4. What passed
5. What failed or could not be verified
6. Evidence used
7. Risks or limitations
8. Recommended next step
9. Whether owner approval is needed before commit/push/release

Never bury failures. Never say something is complete if it is only partially verified.
