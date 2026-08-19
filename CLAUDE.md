# CLAUDE.md — TORQCLAW

> This file replaces `TORQCLAW_CLAUDE.md`, which Claude Code never auto-loaded (only `CLAUDE.md` is read). The prior graphify-only `CLAUDE.md` is preserved at `CLAUDE.md.graphify-orig.bak`; its content is now the "Graphify" section below.

## 1. Repo Context

Address the operator as **King Flowers**.

TORQCLAW is a hybrid AI orchestrator:

- **TypeScript control plane** — gateway, router, MCP bridge, HTTP/channel adapters, console UI
- **Python Hermes execution engine** — vendored Hermes agent wrapped by `engines/hermes_kernel/mcp_wrapper/`
- **Local edge tier** — Ollama `/v1` tool loop for private / low-complexity / local-only tasks
- **Frontier tier** — Hermes engine for complex / research / cloud-allowed tasks
- **Universal MCP bridge** — namespaced MCP tools, task-filtered exposure, approval-gated writes

Package manager is **pnpm** with a Turbo monorepo (`apps/*`, `packages/*`, `engines/*`). Root package is `torqclaw-monorepo`.

> **Staleness check:** before starting work, verify this context against `package.json`, `pnpm-workspace.yaml`, `turbo.json`, recent commits, and live entrypoints. If this file disagrees with the code, stop and report the conflict before changing architecture-level behavior.

**This repo is not TORQ Console and is not the TORQ V5/V6 harness lane.**

### Instruction precedence

1. Direct operator instruction in the current session
2. This file
3. Global `E:\.claude\CLAUDE.md`
4. General Claude Code defaults

Global rules win where they are **more restrictive** on safety, secrets, destructive commands, untracked files, or owner-gated actions.

### Non-TORQ boundary

- Do not touch `E:\TORQ-CONSOLE`.
- Do not touch TORQ Console `torq_mmh/`.
- Do not switch into TORQ V5/V6 harness mode.
- Do not use TORQ Console live harness owner state as authority for this repo.
- Do not modify unrelated projects, global memory, or global hooks unless explicitly instructed.

---

## 2. Governing Harness

Role map (aligned to the global contract in `E:\.claude\CLAUDE.md`, operator-updated 2026-08-12):

| Role | Model | Model ID | Scope |
| --- | --- | --- | --- |
| **G1D** — planner / orchestrator / task router | Claude Fable 5 | `claude-fable-5` | Plan, scope, route |
| **G1R** — independent design reviewer | Claude Opus 5 | `claude-opus-5` | Review non-trivial design/risk before build |
| **Builder** — implementer | Claude Sonnet 5 | `claude-sonnet-5` | Bounded approved work only |
| **RB** — alternate debug worker | GLM-5.2 | (if available) | Scout, triage, debug, propose |
| **G2A** — final verifier | Claude Opus 4.8 | `claude-opus-4-8` | Audit against files, tests, build output, git state, ACs |
| **Memory-writer** | Sonnet 5 or fast model | — | `STATE.md` / `MEMORY.md` after verified progress only |

Haiku 4.5 may be used for cheap verification, checklist grading, log triage, and scope sanity checks. It is never sole final authority for risky code, merges, security, production, or architecture decisions.

> Superseded 2026-08-12: an earlier version of this file named Opus 4.7 as G1R and Opus 4.8 as task scoper. G1R is now **Opus 5**; G2A remains Opus 4.8 and audits rather than scopes. Historical gate records referencing 4.7 are not retroactively invalidated.

### Authority rules

- G1D plans, scopes, and routes. G1D does not approve its own build.
- G1R reviews non-trivial design/risk before build.
- Builder implements bounded approved work only and **cannot approve its own work**.
- GLM-5.2 may scout, triage, debug, or propose. It is never final authority.
- G2A audits after build and tests. **G2A's verdict controls final pass/fail.**
- Memory-writer records verified progress only, after G2A passes or on explicit operator authorization.
- Operator controls push, merge, release, destructive actions, production config, and every irreversible operation.

### Review gates by risk

| Tier | Examples | Path |
| --- | --- | --- |
| **Light** | README typo, comment cleanup, small docs update | Sonnet implements · fast verifier checks · G1R optional unless behavior/safety changes |
| **Standard** | Router rule, bridge filter, package script, console UI fix | G1D scopes · Sonnet implements · independent verifier checks files/tests · G1R required if routing/approval/cost/security behavior changes |
| **High-risk** | Approval gates, secrets, routing privacy, cloud/frontier dispatch, cost enforcement, provider config, Hermes wrapper behavior, MCP write permissions, path scoping | G1D scopes · **G1R independently reviews the plan** · Sonnet implements bounded approved changes only · **G2A audits before acceptance** · operator approves commit/push/release |

Any GLM-produced code touching routing, approval gates, cost enforcement, secrets, production config, or path scoping must be reviewed by Opus 4.8.

---

## 3. Key Files

| Path | Purpose |
| --- | --- |
| `packages/contracts` | Zod contract **source of truth**; emits JSON Schema for Python |
| `packages/router` | Routing rules: privacy, classifier confidence, tool count, cold start, heuristics |
| `packages/gateway` | Fastify websocket gateway, session engine, memory, dispatch |
| `packages/inference` | LOCAL_EDGE Ollama tool loop |
| `packages/bridge` | MCP registry, namespaced tools, task filtering, approval policy |
| `packages/channel-http` | HTTP channel adapter for `POST /task` |
| `packages/collab` | Collaboration layer |
| `apps/console` | Next.js terminal console |
| `engines/hermes_kernel` | Streamable-HTTP MCP wrapper over vendored `hermes-agent` |
| `ops` | Dev startup, doctor, stats, e2e, acceptance, server examples |
| `tests` | Repo-level tests |
| `STATE.md` | Single-file program state |

### Architecture rules

- `packages/contracts` is the contract source of truth.
- Do not hand-edit generated JSON Schema copies unless the repo explicitly requires it.
- If Zod contracts change, run the contracts build.
- Python boundary behavior must stay aligned with emitted schemas.
- Wrap Hermes through `mcp_wrapper/`; do not rewrite vendored Hermes internals unless explicitly authorized.
- Keep LOCAL_EDGE and FRONTIER behavior distinct.
- Bridge-registered MCP tools feed LOCAL_EDGE; FRONTIER uses the Hermes engine's own toolsets.
- A task requiring a bridge-only tool should remain LOCAL_ONLY / this-machine-only.

---

## 4. Mandatory Rules

### Core invariants — preserve all ten

1. Every external frame is contract-validated.
2. Sessions outlive sockets and resume by monotonic `seq` cursors, not timestamps.
3. Privacy beats everything in routing.
4. Classifier uncertainty can route to frontier capability.
5. Write-capable tools require human approval on **both** LOCAL_EDGE and FRONTIER.
6. Skills never auto-deploy.
7. One terminal event per task.
8. Receipts must come from real telemetry only.
9. Do not fabricate risk scores, tool results, spend, logs, or completion state.
10. Upstream Hermes stays pinned; TORQCLAW owns wrappers and integration code.

### Cost and routing safety

- Preserve provider-reported spend handling.
- If provider spend is unavailable, report that budget enforcement is limited and rely on `HERMES_MAX_ITERATIONS`.
- Do not invent static provider pricing as enforcement truth.
- Do not silently remove or bypass `maxCostUsd` behavior.
- `TORQCLAW_PREFER_CLOUD=1` may bias ambiguous work cloudward, but privacy / LOCAL_ONLY / LOCAL_INTENT must still route local.
- `containsSensitiveData` is user-controlled and must not be cleared by automation.
- Local/private tasks must not be silently routed to FRONTIER.

### Tool approval

Write-capable tools require approval on both tiers. Preserve:

- LOCAL_EDGE approval path through `ToolApprovalRequired`
- FRONTIER approval path through Hermes `pre_tool_call` hook
- Shared dispatch path for `PENDING_APPROVAL`
- One-shot `grantedTools` behavior
- Constraint preservation when retrying after approval
- Deny ends cleanly
- Blocked attempts must not write `RESULT` or poison memory
- Client input must not be able to inject `grantedTools`

Do not make any write-capable tool auto-run because it is "probably safe."

### MCP servers

1. Use `ops/servers.example.json` as the template.
2. Copy local runtime config to `~/.torqclaw/servers.json`.
3. Keep server IDs stable — they become namespace prefixes.
4. Prefer allowlists for large MCP servers.
5. Update `packages/bridge/src/toolFilter.ts` when exposing a namespace to task types.
6. Use `approvalPatterns` for write/delete/push/create/update/send/exec style tools.
7. A malformed or unreachable server must degrade only that server, never the gateway.
8. Preserve workspace path scoping and deny-list behavior.
9. **Deny rules always win.**

**Stateful MCP warning:** some MCP tools operate on current external app state rather than a requested target. Do not assume arguments fully control the external app. For TradingView-like tools, switch the chart/symbol first if quoting a specific instrument.

### Workspace path scoping

Preserve path-scope enforcement in the bridge before tool execution: expand `~` · collapse `..` · resolve path-like arguments · apply `deny` before allow rules · enforce write scope for write-capable tools · enforce read scope for read tools · return tool errors plus SYSTEM events on denied paths. Treat bridge path scoping as defense in depth alongside MCP server sandboxing.

### Change scoping

- Make the smallest correct change; touch only files the task requires.
- Keep generated contract artifacts separate from source changes where possible.
- Keep docs-only changes separate from runtime behavior changes.
- Keep provider config changes separate from router/gateway/bridge logic changes.
- Keep Hermes wrapper changes separate from vendored upstream changes.
- Do not mix refactor, feature, config, and test repair in one uncontrolled change.
- If a file already has unrelated owner edits, stop and ask before editing it.

### Shell editing safety

Text-file edits must use structured patching (`Edit`/`Write`), **never** shell regex replacement pipelines.

- PowerShell `-replace` in a double-quoted string expands `$1`/`$2` as empty shell variables before the regex engine runs, silently deleting matched content. If unavoidable, use single-quoted replacement strings (`'$1'`) or `` `$1 `` escaping.
- The same bug class applies to `sed`/`awk` with unquoted `$` inside double-quoted Bash strings.
- Never bulk-edit an untracked file with shell replacement — there is no recovery path. Confirm the file is committed first, or take a copy.
- This rule exists because a PowerShell `$1` expansion destroyed portions of an untracked PRD on 2026-08-06 (recovered from an in-context copy).

---

## 5. Test Commands

Verify scripts before running — do not assume a command exists.

**Setup:**

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

**Test and verify:**

```bash
pnpm test                                  # vitest run
pnpm typecheck                             # turbo run typecheck
pnpm lint                                  # turbo run lint
pnpm build                                 # turbo run build
pnpm --filter @torqclaw/contracts check    # contract check
pnpm reachability                          # ops/reachability.mjs
node ops/e2e.mjs                           # stub-mode smoke test
pnpm stats                                 # ops/stats.mjs
pnpm doctor                                # preflight + production check
```

Discipline: inspect `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `vitest.config.ts`, and local package scripts first. Run the narrowest relevant test, then broaden before claiming completion. If tests cannot run, state why and what evidence was used instead.

---

## 6. Security

- Never expose secrets, API keys, provider keys, `.env` values, tokens, credentials, signing files, or private config.
- Never commit `.env`, credential files, local state DBs, generated secrets, or provider keys.
- Do not log or persist secrets into memory, `STATE.md`, `MEMORY.md`, issues, commits, or comments.
- Do not change gateway binding from loopback-first behavior without explicit approval.
- Do not add paid services, analytics, tracking, cloud dependencies, or external APIs unless explicitly approved.
- Do not run destructive commands unless explicitly approved.
- Do not delete, reset, clean, move, or overwrite untracked or unknown operator files. **Report them only.**
- If the working tree has user-owned edits, stop and report before touching related files.
- Do not claim a command ran unless it actually ran.
- Do not claim tests passed unless exact output is available.
- Never remove or weaken tests to make a build pass.
- Do not deploy, publish, release, push, or merge unless explicitly approved.

---

## 7. Verification Requirements

Before reporting completion:

- Run the narrowest relevant test first, then the broader group when the change could affect more than one area.
- Check for regressions in routing, approval gates, cost enforcement, privacy behavior, session resume, and receipts.
- Review the diff for accidental edits.
- Confirm every completion claim against actual file diffs, command output, logs, or tests.

**Pre-merge deletion audit (learned 2026-08-09, GS-COORD):** before merging a long-lived branch, verify it is rebased onto the current base. An unrebased merge deleted 4,769 lines including whole test files. Check `git diff --stat` against the target branch and confirm the deletion count is zero or explained.

---

## 8. State and Memory

Files: `STATE.md` · `MEMORY.md` (if present) · `.claude/agent-state.json` (if present) · `.torqclaw/` local runtime data.

- `STATE.md` is updated only after meaningful progress with tests plus independent verifier passing.
- Do not store secrets. Do not store raw logs unless explicitly requested and scrubbed.
- Do not mark work complete without tests/evidence.
- Memory-writer updates state only after verified progress or explicit operator instruction.
- Keep entries concise: date, branch, change, tests, verifier result, next action.

### Startup continuity scan

At session start in this repo, report:

1. Current directory
2. Instruction files found and which controls
3. Git branch and HEAD
4. `git status --short`
5. Whether submodules are initialized
6. Package manager and workspace files found
7. Relevant package scripts
8. Python engine environment status if touching `engines/hermes_kernel`
9. `.env` presence — **without revealing values**
10. MCP server config presence — **without revealing secrets**
11. Current task authority
12. Safest next action

Do not edit until the task is bounded.

---

## 9. Graphify

TorqClaw uses **graph profiles** (see `graphify.toml`): the default `product` profile at `graphify-product/` covers first-party code only; the opt-in `vendor` profile at `graphify-vendor/` covers vendored hermes-agent internals. **Never** use the legacy `graphify-out/` or the vendor graph for product architecture answers.

- For codebase questions, first run `graphify query "<question>"` — with `GRAPHIFY_PROFILE=product` (set in `.claude/settings.json`) it resolves the product graph automatically. Use `graphify path "<A>" "<B>"` for relationships, `graphify explain "<concept>"` for focused concepts, and `graphify affected "<symbol>"` for blast radius.
- Expand questions into precise repo tokens (`ClientCommandSchema`, `executeHermesTask`, `submit_task`) before querying; bare English under-matches.
- **Trust gate:** `pnpm graphify:fitness` must be PASS before treating graph answers as authoritative. On FAIL/LOW, fall back to source and package manifests.
- Vendored hermes-agent internals only when explicitly investigating upstream: `graphify query "..." --graph graphify-vendor/graph.json`.
- After modifying code, run `pnpm graphify:build:product` (AST-only, no API cost) to keep the product graph current.
- Community labels may be `Community N` placeholders — never navigation categories.
- `.claude/skills/graphify/TORQCLAW.md` holds the full agent policy and **wins over generic skill defaults** in this repo.

When the operator types `/graphify`, use the installed graphify skill **and** the TorqClaw profile policy before doing anything else.

---

## 10. Required Output Format

Lead with the result. Then:

1. Outcome
2. Files changed
3. Tests/checks run
4. What passed
5. What failed or could not be verified
6. Evidence used
7. Risks or limitations
8. Recommended next step
9. Whether owner approval is needed before commit / push / release

Never bury failures. Never say something is complete if it is only partially verified.
