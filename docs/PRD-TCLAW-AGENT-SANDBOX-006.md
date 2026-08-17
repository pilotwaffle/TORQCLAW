# PRD-TCLAW-AGENT-SANDBOX-006 — Container containment for agent execution

**Status:** v0.1 — **DRAFT, pre-Gate-1.** Not authorized for implementation; requires independent G1R review.
**Date:** 2026-08-17 · **Author:** G1D (`claude-fable-5`)
**Operator instruction:** *"i think the agents should also have a sandbox to work in if they do not, research and implement"* → then, on the deployment question: ***"we can keep docker open and running for the sandbox, i think its important"*** — the Docker dependency is **operator-authorized**.
**Predecessor finding:** `docs/security/agent-execution-isolation-audit.md` (2026-08-17) — the audit that established there is no sandbox today.
**Method note:** the container checklist in §4 is applied from the operator's `container-audit` skill (`E:\.claude\skills\container-audit\SKILL.md`), Dockerfile/runtime-posture sections.

---

## 1. The problem, in one paragraph

TorqClaw's FRONTIER engine can be granted a `terminal_power` profile whose toolset includes
`terminal` and `code_execution`. Those tools are dispatched **inside the vendored Hermes agent's
own loop** and **never traverse `packages/bridge`**, so the bridge's (good, tested) path scoping
has **no jurisdiction** over them. `TERMINAL_ENV` defaults to `"local"` — direct host execution —
and is unset in both `.env` and `.env.example`. **Consequence:** once a human approves `terminal`
once, nothing constrains where it writes, what it deletes, or what it sends over the network. The
approval is *consent, not containment*.

**This PRD supplies the containment.**

---

## 2. Controlling invariant

**No agent-executed code may touch any resource the operator did not explicitly grant it for that
task — and the grant must be enforced by the operating system, not by the agent's cooperation.**

Corollaries: (a) a logical check the agent could route around is not a boundary; (b) the sandbox
must fail **closed** — if containment cannot be established, the capability is refused, never
silently downgraded to host execution; (c) the gateway decides the sandbox policy, never the task,
the prompt, or the model.

---

## 3. Verified host capability (measured 2026-08-17, not assumed)

Docker **28.3.2**, Linux containers, `overlayfs`, 20 CPUs / 32 GiB, `SecurityOptions =
["name=seccomp,profile=builtin","name=cgroupns"]`.

Every control below was **executed and confirmed on this host** before being specified:

| Control | Flag | Measured result |
|---|---|---|
| Network isolation | `--network none` | DNS resolution fails — network genuinely absent, not filtered |
| Read-only rootfs | `--read-only` | `touch /escape.txt` → `Read-only file system` |
| Scratch space | `--tmpfs /tmp:rw,noexec,nosuid,size=64m` | writable; `noexec`/`nosuid` set |
| Workspace confinement | `-v <ws>:/workspace -w /workspace` | writes land in the workspace and **only** there |
| Non-root | `--user 65534:65534` | `uid=65534(nobody)` |
| Capabilities | `--cap-drop ALL` | accepted |
| Escalation | `--security-opt no-new-privileges:true` | `su root` → *"must be suid to work properly"* |
| Resources | `--memory 512m --cpus 1 --pids-limit 128` | accepted, enforced by cgroups |

**Windows note:** container-side paths must bypass MSYS path translation (`MSYS_NO_PATHCONV=1`)
when invoked from Git Bash. A naive invocation fails with *"the working directory
'C:/Program Files/Git/workspace' is invalid"*. The implementation must construct arguments without
relying on shell path translation.

---

## 4. Container posture (from the `container-audit` checklist)

- **Pin the image by digest, never by tag** — `FROM …@sha256:…`. A moving tag is a supply-chain
  hole in a security boundary.
- **Minimal base** — distroless or Alpine; no package manager, no `sudo`, no shells beyond what the
  toolset genuinely needs. (Note: `terminal` needs *a* shell by definition; that is the one
  justified exception and it must be scoped by the command allowlist in §6, not by removing `sh`.)
- **Non-root `USER`** baked into the image, not only supplied at run time.
- **No SUID binaries** in the final image (`chmod 4755` is a finding).
- **`.dockerignore`** must exclude `.git`, `.env`, `*.pem`, `.ssh/`, `.aws/`, `node_modules`.
- **No secrets via `--build-arg`** (they persist in layers) and none via container env vars —
  agent-run code must never see provider keys. Env passed into the sandbox is an explicit
  allowlist, defaulting to empty.
- **Resource limits are mandatory**, not advisory — missing limits are a DoS surface.
- **Image scanning in CI** (`trivy`/`grype`/`docker scout`) surfacing advisories.

---

## 5. Slices

Each slice is independently shippable, flag-gated, and reversible. **A6/T-9 apply in full to every
new wire command** (`docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` §6/§8).

### SB0 — Phase A hardening (no container; ships first, independently valuable)
Closes gaps that exist regardless of sandboxing, in the layer that *is* enforced:
- **Symlink resolution** — `pathScope.normalizePath` uses `path.resolve()`, which is **purely
  lexical**. There is **no `realpath`/`lstat`/`readlink` anywhere in `packages/bridge`** and **zero
  symlink tests**. A symlink inside an allowed directory pointing at `~/.ssh` passes every check
  today. Resolve the containing directory for creates (the target may not exist yet). **Must handle
  Windows junctions and reparse points, not only POSIX symlinks.**
- **Fail-closed allowlists** — an empty `write` allowlist currently means *unconstrained*. Invert to
  deny, behind a flag, with a migration note: this is a behavior change for existing configs.
- **Schema-driven path extraction** — replace key-name guessing with the MCP tool's declared JSON
  Schema; keep the heuristic as a fallback and **log when it fires**.
- **Startup refusal** — if a profile granting `terminal`/`code_execution` is reachable while no
  sandbox is configured, **refuse to start** unless `TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` is set
  explicitly. Fail closed and loudly.
- Tests for every item, including the symlink escape that passes today.

### SB1 — Sandbox policy in the effective profile (gateway-owned)
The profile gains a sandbox requirement; `terminal_power` requires containment. The policy is
**gateway-owned and task-immutable** — same discipline as the existing toolset boundary
(`hermes_runner.py:315-329`, where the profile beats task-type heuristics). No prompt, model
output, or task field may weaken it.

### SB2 — Container execution backend (the containment itself)
The wrapper launches agent tool execution in a container with the §3 profile: `--network none`,
`--read-only`, `noexec`/`nosuid` tmpfs, workspace-only bind mount, non-root, `--cap-drop ALL`,
`--security-opt no-new-privileges:true`, memory/CPU/pids limits, digest-pinned image.
**Fail closed:** if the container cannot be created, the task is refused with an honest terminal
error — **never** falls back to host execution. **Verified at task start**, not trusted from config.

### SB3 — Per-task ephemeral workspace
A git worktree or copy per task, bind-mounted as the only writable path, discarded after. A task
cannot corrupt the operator's tree, and concurrent tasks cannot collide.
*(Note: `.torq/worktrees/` are **dev-process artifacts from prior build sessions, not a runtime
feature** — no product code creates them.)*

### SB4 — Egress control
Default `--network none`. When a task genuinely needs the web, attach a network with a
**default-deny allowlist** enforced at the container boundary — the only place it can actually be
enforced. Web-search/extract route through an allowlisted proxy rather than raw egress.

### SB5 — Grant scoping (closes the "consent is not containment" gap)
- Extend LOCAL_EDGE's exact-action admission seam to FRONTIER so a grant binds to **arguments**,
  not merely a tool name.
- A **command allowlist/denylist** for `terminal` — at minimum deny the destructive verbs
  `capability.ts` already enumerates.
- **Remove the model-controlled `cross_profile: true` opt-out** in `file_tools.py`, or make
  overriding it operator-only. A guard the model can switch off is not a guard.

---

## 6. Acceptance criteria

- **SA-1 (SB0):** a symlink inside an allowed directory pointing outside it is **denied**; proven by
  a test that fails against today's code. Windows junctions covered.
- **SA-2 (SB0):** an empty write allowlist denies; the startup refusal fires when `terminal_power`
  is reachable unsandboxed.
- **SA-3 (SB2):** with the sandbox on, a task that attempts to write outside the workspace, read
  `~/.ssh`, or reach the network **fails**, and the failure is proven by executing a real container,
  not by asserting a config value.
- **SA-4 (SB2):** if Docker is unavailable, `terminal_power` is **refused** — proven by a test that
  simulates the failure. No silent host fallback.
- **SA-5 (SB1):** no prompt, task field, or model output can widen the sandbox policy.
- **SA-6 (SB3):** two concurrent tasks cannot observe or corrupt each other's workspace.
- **SA-7 (SB5):** a grant for `terminal` does not authorize an arbitrary second command; the
  `cross_profile` self-opt-out is gone.
- **Gate:** full suite green; reachability green; **A6/T-9 for every new wire command**; no existing
  test weakened.

## 7. Required tests

- **TS-1** symlink escape (currently passes — must fail after SB0). **TS-2** empty-allowlist deny.
- **TS-3** startup refusal. **TS-4** live container escape attempts: workspace write ✔, outside
  write ✘, `~/.ssh` read ✘, network ✘ — all executed against a real container.
- **TS-5** Docker-unavailable → refusal, never fallback. **TS-6** policy immutability under a
  hostile prompt. **TS-7** concurrent-task isolation. **TS-8** argument-scoped grants.
- **Falsifiability obligation** (§8 T-9 standard): each guard reverted → RED with recorded output →
  restored → GREEN.

## 8. Rollback

Each slice is flag-gated and separately revertable. **Turning the sandbox off is a capability
decision, not a convenience**: with it off, `terminal_power` must become ungrantable rather than
silently reverting to host execution. That asymmetry is the point — the same discipline as
PRD-005 §9's prohibition on using `TORQCLAW_COLLAB_ENABLED=0` as a rollback.

## 9. Open questions for the operator

1. **Image choice** — build a TorqClaw-specific sandbox image (pinned, minimal, auditable) or pin an
   upstream one? Recommend the former for a security boundary.
2. **Docker lifecycle** — operator says Docker stays running. Should the gateway *verify* Docker
   health at startup and refuse `terminal_power` if absent (recommended), or degrade the profile?
3. **Egress** — is any default-allow egress wanted for research tasks, or is allowlist-only correct
   from the start? (Recommend allowlist-only; loosening later is easy, tightening later breaks
   workflows.)
4. **Vendored boundary** — SB2 touches the Hermes wrapper. Confirm this stays "wrap, don't rewrite."

## 10. Operator stop conditions

Any change to the vendored Hermes engine beyond the wrapper; enabling the sandbox in a deployment;
push/merge/release of any slice; anything that would make `terminal_power` grantable without
verified containment.
