# Agent execution isolation — audit and remediation plan

**Date:** 2026-08-17 · **Author:** G1D (`claude-fable-5`) · **Status:** FINDINGS — remediation not yet built
**Trigger (operator):** *"i think the agents should also have a sandbox to work in if they do not,
research and implement."*
**Method:** source audit of `packages/bridge`, `packages/inference`, `packages/gateway`,
`engines/hermes_kernel` (incl. `vendor/hermes-agent`), `ops/`, `tests/`. Load-bearing claims
re-verified directly by G1D.

---

## 0. Answer to the question

**No. Agents do not have a sandbox today.** What exists is a **logical** control system —
capability classification, name-regex approval gates, and path-string scoping — which is real,
tested, and enforced *for the tools it governs*. What does not exist is any **containment**:
no container, VM, jail, chroot, separate OS user, job object, seccomp, or `node --permission`
anywhere in TorqClaw-authored code.

The critical structural finding is a **jurisdictional gap**:

> `packages/bridge`'s path scoping governs **bridge-registered MCP tools only**. The FRONTIER
> Hermes engine's own `terminal`, `file`, and `code_execution` tools **never traverse that code
> path**, so **no filesystem scoping applies to them at all.**

---

## 1. Verified facts

### 1.1 Enforcement that is real (credit where due)

| Control | Where | Verified |
|---|---|---|
| Path scoping: `~` expansion, `..` collapse, boundary-aware `isUnder` (so `/a/bcd` is not under `/a/b`), **deny always wins** | `packages/bridge/src/pathScope.ts` | ✔ read directly |
| Enforced **before** the MCP call | `packages/bridge/src/registry.ts:215-217` (`scopeModeFor` → `checkPath`) | ✔ |
| Scope mode derived from **capability**, not `requiresApproval` (a fixed regression) | `capability.ts:39-41`, pinned by `tests/registry-scope.test.ts` | ✔ |
| Capability classifier **fails closed to write** on unknown tool names | `capability.ts` (`P4_*` sets; `'process'` deliberately excluded with a documented rationale) | ✔ read directly |
| Toolset boundary is **gateway-owned**; a task cannot widen it by claiming a task type | `hermes_runner.py:315-329` — profile wins over `_FRONTIER_TOOLSETS` | ✔ read directly |
| Approval is a **real pre-execution barrier**, both tiers | LOCAL_EDGE throws `ToolApprovalRequired` before `executeTool`; FRONTIER `pre_tool_call` returns `block` | ✔ |

### 1.2 The gaps

**G-1 — Jurisdictional gap (structural, highest severity).**
`toolFilter.ts:60` excludes `sourceServerId === 'hermes'` from bridge tool exposure, and Hermes's
own tools are dispatched inside the vendored agent's loop. They never reach `registry.executeTool`,
so `checkPath` never runs on them. **`terminal`, `write_file`, `patch`, and `code_execution` have
no path containment whatsoever.** `TORQCLAW_WORKSPACE_ROOT` only `chdir()`s for *relative* path
resolution — its own test (`test_workspace_root.py`) frames it as a cwd convenience, not a boundary.
An absolute path or `terminal("rm -rf …")` is unaffected.

**G-2 — Host execution is the default.**
`TERMINAL_ENV` defaults to `"local"` (`terminal_tool.py:1073`) and is **unset in both `.env` and
`.env.example`** (G1D-verified). The vendored code *does* support Docker/Modal/Singularity/SSH
backends — genuine isolation — but it is **opt-in, off by default, and nothing in TorqClaw asserts
it is on before granting `terminal_power`.**

**G-3 — Symlinks are not resolved.**
`normalizePath` uses `path.resolve()`, which is **purely lexical** — it never touches the
filesystem. There is **no `realpath`/`lstat`/`readlink` anywhere in `packages/bridge`**
(G1D-verified: zero matches), and **no test mentions symlinks** (zero matches in `tests/`).
A symlink inside an allowed directory pointing outside it passes every check. This affects even
the bridge tools that *are* scoped.

**G-4 — Empty allowlist means unconstrained.**
In `checkPath`, an absent/empty allowlist for a mode permits any path. Omitting `write` from a
server's `paths` config silently leaves writes unscoped. Fail-open by configuration.

**G-5 — Path extraction is heuristic.**
`extractPaths` uses `pathArgKeys` or a fixed list of common key names. A tool whose path argument
uses an unlisted key is **invisible to scoping**.

**G-6 — Grants are tool-name-scoped, not argument-scoped.**
Once `terminal` is approved within a task, *every* subsequent `terminal` call in that task proceeds
— no per-command or per-path re-approval, no command allowlist. (LOCAL_EDGE has a second
`admitTool` exact-action seam; FRONTIER has no equivalent.)

**G-7 — Model-controlled soft guard.**
`file_tools.py` has a `_check_cross_profile_path` **warning** that the model itself can opt out of
by passing `cross_profile: true`. Advisory text, not a deny.

**G-8 — No egress control, no resource quota.**
No network allowlist/proxy anywhere. Local terminal/code-execution has a wall-clock timeout but
**no CPU/memory/disk limit**. The spend circuit-breaker bounds *dollars*, not *actions*.

**G-9 — Untested.**
No test asserts that FRONTIER's own toolset is confined to any root, that `TERMINAL_ENV` defaults
safely, or that an approved `terminal_power` grant cannot escape the workspace. **Path containment
for the Hermes toolset is not a guaranteed property of this system.**

### 1.3 Bottom line

With `terminal_power` approved once, a FRONTIER agent writing outside the workspace, deleting
files, or exfiltrating over HTTPS would be stopped by **nothing in this codebase**. The only real
barrier is the **one-shot, name-based human approval** — which is a meaningful barrier, but it is
consent, not containment, and it does not scope *what* the granted tool may then touch.

---

## 2. Why this matters more now

Every slice of PRD-005 increases the number of agents co-present with an operator in a shared room.
The PRD's §2(b)/§12a rulings correctly keep the *channel* off the authority path — but they say
nothing about what an agent may do **once it is legitimately running a task**. That is this
document's scope, and it is a different axis from the approve ruling.

---

## 3. Remediation — proposed, in dependency order

Each phase is independently shippable, flag-gated, and reversible. **Nothing here is built yet.**

### Phase A — Close the cheap gaps (no architecture change)
- **A-1 Symlink resolution (G-3).** Resolve with `realpath` before `checkPath`, on the *containing
  directory* for creates (the target may not exist yet). Deny when resolution escapes the scope.
  Must handle Windows junctions/reparse points, not just POSIX symlinks.
- **A-2 Fail-closed scoping (G-4).** Make an empty write allowlist mean *deny*, not *allow*, behind
  a flag with a migration note — this is a behavior change for existing configs.
- **A-3 Schema-driven path extraction (G-5).** Derive path args from the MCP tool's declared JSON
  Schema instead of key-name guessing; keep the heuristic as a fallback and **log** when it fires.
- **A-4 Startup assertion (G-2).** If a profile granting `terminal`/`code_execution` is reachable
  and `TERMINAL_ENV=local`, **refuse to start** — or require an explicit
  `TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` acknowledgement. Fail-closed and loudly.
- **A-5 Tests for all of the above (G-9)** — including the symlink-escape case that currently passes.

### Phase B — Real containment for FRONTIER (closes G-1, G-2)
The vendored engine already supports container backends; TorqClaw must **own the decision** rather
than inherit an env-var default.
- **B-1** Gateway-owned sandbox policy in the effective profile: `terminal_power` requires a
  container backend; the wrapper **verifies** it at task start and refuses otherwise.
- **B-2** Bind-mount only the workspace; no host root, no credential paths.
- **B-3** Resource limits (CPU/memory/disk/pids) via the backend (G-8).
- **B-4** Default-deny **egress** with an allowlist, enforced at the container boundary where it
  can actually be enforced (G-8).
- **B-5** Per-task ephemeral workspace — a git worktree or copy, discarded after, so a task cannot
  corrupt the operator's tree. *(Note: `.torq/worktrees/` are **dev-process artifacts from prior
  build sessions, not a runtime feature** — G1D verified no product code creates them.)*

### Phase C — Tighten the grant model (G-6, G-7)
- **C-1** Extend LOCAL_EDGE's exact-action admission seam to FRONTIER, so a grant binds to
  arguments, not just a tool name.
- **C-2** Command allowlist/denylist for `terminal` — at minimum deny the destructive verbs the
  capability classifier already knows.
- **C-3** Remove the model-controlled `cross_profile` opt-out, or make overriding it operator-only.

### Sequencing recommendation
**Phase A first** — it is small, additive, testable, and closes a live symlink bypass in the layer
that *is* enforced. **Phase B is the actual sandbox** and is the larger effort; it should be its own
PRD through the full governed chain, because it changes the deployment contract (operators would
need Docker) and touches the vendored boundary.

---

## 4. Scope boundary for PRD-005

This is **not** PRD-005 work. PRD-005 is a read/co-presence surface and its slices add no execution
capability. This audit is recorded here so the sandbox effort can be scoped separately and not
silently absorbed into a UI slice. **Recommended: a dedicated PRD (`PRD-TCLAW-AGENT-SANDBOX-006`)
for Phase B, with Phase A landing as a bounded hardening change beforehand.**
