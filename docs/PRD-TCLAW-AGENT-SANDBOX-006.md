# PRD-TCLAW-AGENT-SANDBOX-006 — Container containment for agent execution

**Status:** v0.2 — **DRAFT, pre-Gate-1 (re-review).** Not authorized for implementation.
**Date:** 2026-08-17 · **Author:** G1D (`claude-fable-5`)
**Supersedes:** v0.1, **REJECTED at Gate 1** by fresh Opus 5 G1R with 9 blockers
(`docs/prd-reviews/G1R-OPUS-AGENT-SANDBOX-006-GATE1.md`, commit `9a9aa1c`).
**Predecessor finding:** `docs/security/agent-execution-isolation-audit.md` — established there is no sandbox today.
**Operator ruling folded in:** 2026-08-17, see §2. Nine directed corrections, P0/P1/P2.

---

## 0. What changed from v0.1, and why you should trust this version less than it reads

v0.1's §3 claimed eight container controls "measured on this host, not assumed." The commands were
really executed — **as hand-typed `docker run` flags**. The code that actually runs is
`engines/hermes_kernel/vendor/hermes-agent/tools/environments/docker.py`. **I measured a bench
reproduction of the artifact instead of the artifact.** Because §3 was the evidentiary core, every
downstream claim inherited a false premise.

**G1R's B-1 was also partly wrong, in the opposite direction.** It read parameter defaults
(`network: bool = True`) and concluded flags were absent, without reading the argv assembly. Neither
document read `_BASE_SECURITY_ARGS` (`docker.py:327-336`), where most of the hardening actually is.

**Three documents in one review cycle got the emitter wrong.** That is the strongest available
argument for the operator's principle in §2, and it sets this version's evidence rule:

> **§3 evidence rule.** Every control row cites the **`file:line` that emits it**. A row without an
> emitter citation is **not** a verified control and must be marked `UNVERIFIED`. No row may be
> supported by a hand-typed command.

**Deliberately still unverified in v0.2** (asserting them would repeat the same error):
§9 item 4's scanner path list, item 7's seccomp interpreter-blocking feasibility, item 8's
registry/git egress-allowlist feasibility. Each is marked `UNVERIFIED — must be checked before it
becomes an acceptance criterion`.

---

## 1. The problem

TorqClaw's FRONTIER engine can be granted a `terminal_power` profile including `terminal` and
`code_execution`. These dispatch **inside the vendored Hermes loop** and **never traverse
`packages/bridge`**, so bridge path scoping has **no jurisdiction** (`toolFilter.ts:60` excludes
`sourceServerId === 'hermes'`; `checkPath` runs only inside `registry.executeTool:214-220`).

**The load-bearing property is not that `TERMINAL_ENV` defaults to `local` — it is that it is
re-read on EVERY tool call** (`terminal_tool.py:1073`, `:1878`). The execution backend is **per-call
mutable state**, not a deployment fact. `check_terminal_requirements()` returns `True` for `local`
unconditionally (`:2462-2463`) and `_create_environment` returns `_LocalEnvironment` as its **first**
branch (`:1237-1238`). The wrapper sets `TERMINAL_ENV` **nowhere** (zero hits across `mcp_wrapper/`).

**Current mitigation, and why the sandbox is the unlock:** the gateway **already refuses every
FRONTIER granted run** (`dispatch.ts:262`, `frontierGrantFenced` → `refuseFrontierGrantedRun`),
precisely because "the engine's pre-tool hook grants by tool NAME and never inspects args… nothing
downstream can prove the args about to execute are the args that were approved." The fence sits
**before** the engine-availability check so an unreachable engine cannot mask it. **So the exact-action
hole is closed today by withholding the capability.** This PRD's §9 item 1 is what **retires** that
fence.

---

## 2. Controlling principle (operator ruling, 2026-08-17)

> **Every control in the G1R report was enforced by the wrong layer.** Environments, uid bits, noexec
> flags, and "I think I'm in a container" are all **ambient state the workload can influence**. Every
> fix moves enforcement to something the workload cannot reach.

**Mandate, verbatim:** *"consent must see the command; containment must be proven, not assumed;
enforcement lives in the gateway, not in flags the workload can influence."*

**Corollaries:**
1. **Ambient environment is never a security boundary.** Not env vars, not uid, not `/proc/1/cgroup`,
   not the presence or absence of a network route.
2. **A control that is safe only because of an ambient property of the current environment is not a
   control.** *(Operator, 2026-08-17, on the loopback proxy: "it needs to be fixed as if it had
   internet access.")* "No internet on this host" is ambient state exactly like `TERMINAL_ENV`.
   **Every control in this PRD is specified as if the host were internet-reachable and the agent
   hostile.**
3. **Fail closed:** if containment cannot be *proven*, the capability is **refused** — never silently
   downgraded to host execution.
4. **Guards never relax on believed containment** (§9 item 3).
5. **Per-call, not per-boot:** a boot-time check is necessary but **never sufficient** for any property
   read per call.

---

## 3. What the real backend emits (re-measured against the emitter)

Source: `engines/hermes_kernel/vendor/hermes-agent/tools/environments/docker.py`.
`_BASE_SECURITY_ARGS` = `:327-336`; `_build_security_args()` = `:355`.

| Control | Emitted? | Emitter | Reality |
|---|---|---|---|
| Drop capabilities | **YES** | `:328` | `--cap-drop ALL` |
| Re-added caps | **YES** | `:329-331` | `DAC_OVERRIDE`, `CHOWN`, `FOWNER` re-added — **not a clean ALL-drop**; documented as needed for file ownership |
| Privilege escalation | **YES** | `:332` | `--security-opt no-new-privileges` |
| PID limit | **YES** | `:333` | `--pids-limit 256` |
| `/tmp` noexec | **NO — deliberate** | `:334` | `rw,nosuid` **exec allowed**, documented: *"needed by pip/npm builds"* |
| `/var/tmp` noexec | **YES** | `:335` | `rw,noexec,nosuid` |
| `/run` noexec | **YES, conditional** | `:342-343` | `noexec` default; **`exec` variant for s6-overlay images** (else exit 126 at `/init`) |
| Privilege-drop caps | Conditional | `:350-351` | `SETUID`/`SETGID` added **only when not `--user`** |
| `--read-only` rootfs | **NO** | — | **Never emitted anywhere.** G1R correct. |
| `--user` | **Conditional** | `:733` | Only when `run_as_host_user=True`; `_resolve_host_user_spec()` **returns None on Windows** (`:415-430`) → **never on this host** |
| `--network=none` | **YES, when asked** | `:573` | `if not network:` — the flag exists; G1R read the parameter default, not the emitter |
| Memory / CPU | **YES** | `:561-563` | `--cpus`, `--memory` |
| Disk quota | **SILENTLY SKIPPED** | `:564-571` | Requires overlay2-on-XFS-with-pquota; **not satisfied on Docker Desktop/WSL2** — warns and continues |
| Default `/workspace` | **tmpfs** | `:626` | `--tmpfs /workspace:rw,exec,size=10g` — **host bind only under `bind_host_cwd` or explicit user config** (`:635-640`) |
| `/home`, `/root` | tmpfs | `:629-630` | `rw,exec` |
| Container labels | **YES** | `:799-801` | `hermes-agent=1`, `hermes-task-id`, `hermes-profile` |
| Orphan reaper | **YES, partial** | `:172-178`, `:1139-1142` | Filters on those labels — **`status=exited` only**, so live orphans are never swept |
| Credential files | **MOUNTED `:ro`** | `:648-672` | Host OAuth/credential files mounted into every container |
| Skills tree | **MOUNTED `:ro`** | `:675-692` | Host skills directory |
| Cache dirs | **MOUNTED `:ro`** | `:695-716` | Host documents/images/audio/screenshots |
| `docker_extra_args` | **UNVALIDATED** | `terminal_tool.py:1096` + `docker.py:767-772` | Arbitrary strings appended to `docker run` |
| Docker socket | **NEVER MOUNTED** | — | Verified absent; `file_tools.py:292` lists it as a blocked path. **Credit — keep as explicit non-goal.** |

**Corrections to v0.1 §3:** the eight-row "measured" table is **withdrawn**. `--read-only` and
Windows `--user` were **false claims**. `noexec` on `/tmp` was never a backend behavior and is a
**deliberate tradeoff**, not an oversight.

**Corrections to G1R B-1:** `--network=none` **is** emitted; tmpfs `noexec` is **documented
judgment**, not absence; **labels and a reaper already exist**.

### 3a. What survives the flag set anyway (G1R, demonstrated on this host)

Live experiments, all `--rm`, no socket mounted:

- **E-2** `/workspace/.git/hooks/post-checkout` planted from inside a container running
  `--read-only --network none --cap-drop ALL --user 65534` landed **host-side `-rwxr-xr-x` owned by
  the operator**. Next host `git checkout` / `pnpm install` / build / test **executes it as the
  operator**. *Scope correction: reachable only when the host workspace is bind-mounted, which is
  **not** the default (`:626`) — so the fix is largely "never enable that mode," see §9 item 4.*
- **E-13** `--user 65534` gave **zero** filesystem protection on a Windows bind mount: container
  **overwrote a host-created file**, mount presented `drwxrwxrwx`, host files owned by the operator.
- **E-8** `noexec` bypassed trivially: exec bit denied, but `python3 x.py` and `sh x.sh` both ran; the
  default image (`terminal_tool.py:1072`) ships both.
- **E-7** `--network none` isolation genuine; **attach any network and `host.docker.internal:8787`
  returns ConnectionRefused — host routable.**

---

## 4. Container posture (from the `container-audit` checklist)

Digest-pin the image (`FROM …@sha256:…`) — the default is a **moving tag**
(`terminal_tool.py:1072`, `nikolaik/python-nodejs:python3.11-nodejs20`) and `TERMINAL_DOCKER_IMAGE`
is an **unvalidated env var**, so the pin must be enforced **at call time** or it is documentation.
Minimal base; non-root `USER` baked in; no SUID; `.dockerignore` excluding `.git`/`.env`/`*.pem`/
`.ssh`/`.aws` **(note: this governs the IMAGE BUILD and does nothing about `.git` inside a mounted
workspace — two different exposures)**. **No secrets via `--build-arg`, env, OR bind mount** — the
mount set is a **closed allowlist verified at container start** (§9 item 4b). Resource limits
mandatory. Image scanning in CI.

---

## 5. Threat model for the workspace consumer (new in v0.2)

v0.1 never asked **who reads the workspace afterwards, and with what privilege.** That omission is
what made E-2 invisible.

**Model:** container output is **untrusted input to the host toolchain.** The host runs `git`,
`pnpm`, `turbo`, `vitest`, `uv`, and an IDE indexer over any directory the sandbox wrote. Several
execute file content **by design**: `.git/hooks/*`, `package.json` lifecycle scripts,
`node_modules/.bin/*`, `vitest.config.ts`, `conftest.py`, `sitecustomize.py`, `.envrc`, `Makefile`,
`.pre-commit-config.yaml`, `.vscode/tasks.json`. **In a repo whose gates are `pnpm test` / `pnpm
build`, writing `vitest.config.ts` buys host execution at the next gate run.**

**Consequence:** confinement of the *container* is insufficient. The **egress path of data** must be
controlled too (§9 item 4).

---

## 6. Slices

Flag-gated, independently shippable, reversible. **A6/T-9 apply in full to every new wire command**
(`docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` §6/§8).

**Ordering change from v0.1:** the startup refusal **moves out of SB0** into SB1 (its correctness
depends on SB1's policy, and per §2 corollary 5 a boot check cannot establish a per-call property).

**Stated plainly:** **SB0 hardens `packages/bridge` — the path §1 says the dangerous tools NEVER
traverse. SB0 delivers ZERO mitigation for the motivating threat.** It is independently valuable and
ships first because it is cheap and correct, not because it addresses `terminal`.

### SB0 — bridge hardening (no container; zero mitigation for terminal/code_execution)
- **Symlink resolution** — `pathScope.normalizePath` uses `path.resolve()`, **purely lexical**; there
  is **no `realpath`/`lstat`/`readlink` in `packages/bridge`** and **zero symlink tests**. Resolve the
  containing directory for creates. **Must cover Windows junctions and reparse points.**
- **Fail-closed allowlists** — an empty `write` allowlist currently means **unconstrained**
  (fail-OPEN; G1R confirmed by execution against `dist/pathScope.js`). Invert to deny, behind a flag,
  with a migration note.
- **Schema-driven path extraction** — replace key-name guessing with the tool's declared JSON Schema;
  keep the heuristic as fallback and **log when it fires** (G1R confirmed `extractPaths({outputPath})`
  returns `[]` today — invisible to scoping).

### SB1 — gateway-owned execution policy (replaces "TERMINAL_ENV enforcement")
Capability set is **fixed at dispatch** and read from the **task record** in gateway state — never
from process env. Env vars become **advisory metadata**. The policy is **task-immutable**, the same
discipline as the existing toolset boundary (`hermes_runner.py:315-329`, profile beats task-type
heuristics). **The ENTIRE container flag set is gateway-owned** (§9 item 5). Grant-time refusal, not
boot-time: the gateway **declines to resolve `terminal_power`** and falls back to `workspace_write`
(narrower, so `resolveProfile`'s broadening check is untroubled), emitting a loud SYSTEM event.
`TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` remains an explicit **per-session** escape, logged on every
use. **Define "reachable":** *a profile whose `allowedCapabilities` include `exec` is resolvable for
some task type given the current `DEFAULT_PROFILE_BY_TASK` and session default.*

### SB2 — verified containment (the containment itself)
Container launched with the §3 profile **plus the gaps closed**: `--read-only` supplied by the
wrapper, `--network=none`, resource limits, digest verified **at call time**, and the **mount set
asserted against a closed allowlist** by parsing `docker inspect` Mounts and refusing on any
unexpected source. **Credential / skills / cache mount families disabled** (§9 item 4b).
**Containment is proven per call, in the `pre_tool_call` hook** (`mcp_wrapper/approval_hook.py:67-125`
— TorqClaw-owned, already proven for the approval gate, already wrap-don't-rewrite compliant).
**Fail closed:** cannot establish containment → refuse. **Never** falls back to host execution.

### SB2a — workspace egress review (NEW; ordered BEFORE SB3)
Implements §5. **Copy-in / copy-out; never an RW host-workspace bind mount** (§9 item 4). On exit,
scan artifacts for anything **new + executable + in a path host tooling touches**; strip exec bits;
reject out-of-tree symlinks; require explicit operator review before any host process consumes a
sandbox workspace. **Host-side defense-in-depth regardless of the sandbox:**
`git config core.hooksPath` → empty dir for automation, and `pnpm install --ignore-scripts` by
default in the pipeline.

### SB3 — per-task ephemeral workspace
Named volume or fresh clone per task, discarded after. **Blocked on SB2a** — a worktree is precisely
what the host toolchain operates on, so SB3 without SB2a makes E-2 worse.
*(`.torq/worktrees/` are **dev-process artifacts from prior build sessions, not a runtime feature** —
verified: no product code creates them.)*
**Windows measurement owed before commitment:** Docker Desktop bind mounts traverse a 9p/virtiofs
boundary with many-small-file penalties; a per-task worktree of this monorepo is exactly that
workload. **UNVERIFIED** — measure before committing, or SB3 becomes the reason the sandbox is
switched off.

### SB4 — egress control (**precondition for SB2 being adoptable**, not optional polish)
Default `--network=none`. **Deny-first destination policy** (§9 item 6c): deny `127.0.0.0/8`, `::1`,
RFC1918 (`10/8`, `172.16/12`, `192.168/16`), `169.254/16`, and `host.docker.internal` **BEFORE any
allow rule**; run the proxy on a dedicated Docker network with `host.docker.internal` neutralised.
**Dependency fetch is a separate gateway-mediated step** — egress-allowlisted to package registries
and git remotes, results **cached** — so the sandbox stays offline **and builds still run** (§9 item 8).

### SB5 — argument-scoped grants (**the FRONTIER unlock**)
Extends LOCAL_EDGE's exact-action admission seam to FRONTIER so a grant binds to **argv**, not a tool
name. **This is what retires the `frontierGrantFenced` refusal at `dispatch.ts:262`.** Terminal
command allowlist/denylist covering at minimum the destructive verbs `capability.ts` enumerates.
**Remove the model-controlled `cross_profile: true` opt-out** in `file_tools.py`, or make overriding
it operator-only — a guard the model can switch off is not a guard.
*Note: `capability.ts` `P4_EXEC` omits `process` by documented rationale while
`approval_hook.py:23` **does** gate it — divergent tier semantics this slice will collide with.*

### SB6 — observability, lifecycle, limits (NEW; closes v0.1's silent omissions)
- **Audit log** — container id, image digest, full flag set, mount set, and argv executed. Invariant 8
  requires receipts from real telemetry; v0.1 recorded **nothing**, so an operator could not
  reconstruct what ran.
- **Kill / timeout** — `TERMINAL_TIMEOUT` (180s) bounds a **command**; nothing bounds the
  **container**. Add a task-level deadline, `docker kill`, and an operator abort.
- **Label + TTL reaper** — labels already exist (`:799-801`) and the reaper is `status=exited` only
  (`:172-178`), so **live orphans are never swept**. Sweep past TTL **or** orphaned (task record
  gone). *This is a **live condition**: four `torq-console-verify` containers ran `Up 36h`, one of
  them an unauthenticated loopback credential proxy — see §9 item 9.*
- **Volume cleanup** — `~/.hermes/sandboxes/<task_id>` grows unbounded.
- **Concurrency cap** — nothing caps concurrent sandboxes; at `--memory 512m` each, N tasks is an
  N×512MB **host DoS**. The limit is per-container, not per-host.
- **Post-hoc inspection** — retained logs and a workspace diff ("what did this task change"). SB3
  discards the worktree, **destroying the evidence**.

---

## 7. Acceptance criteria

**Every criterion must be proven by executing the real path** — a real container, the real backend,
the real argv. **No criterion may be satisfied by asserting a config value or mocking the backend.**
**§8's mutation obligation applies to EVERY criterion below**, not only those with a natural RED.

| ID | Slice | Criterion | Anti-assertion requirement |
|---|---|---|---|
| SA-1 | SB0 | Symlink inside an allowed dir pointing outside is **denied**; Windows junctions covered | Test must **fail against today's code** |
| SA-2 | SB0 | Empty write allowlist **denies**; heuristic path-extraction fallback **logs** | Prove `{outputPath}` is now visible to scoping |
| SA-3 | SB2 | Contained task cannot write outside the workspace, read `~/.ssh`, or reach the network | **Real container executed**, not a config assertion |
| SA-4 | SB2 | Docker unavailable → `terminal_power` **refused** | Run against the **real backend** with docker genuinely unreachable (e.g. dead `DOCKER_HOST`); assert **no `_LocalEnvironment` was constructed** (on the class, not an error string) — `terminal_tool.py:1237` is its first branch |
| SA-5 | SB1 | Policy cannot be widened | **Enumerate the CHANNELS, one probe each** — prompt, task field, model output, **env var** (`TERMINAL_DOCKER_EXTRA_ARGS`/`_VOLUMES`/`_ENV`/`_FORWARD_ENV`), per-task override registry (`terminal_tool.py:952`), MCP tool args. A universal negative over an infinite space is **not** a criterion |
| SA-6 | SB3 | Two concurrent tasks cannot observe or corrupt each other | Assert **two DISTINCT container IDs**, and **pin `persist_across_processes=false` + non-collapsing task_id** — today `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES` defaults **true** (`:1183-1185`) and subagent task_ids collapse to `'default'` (`:1881-1885`), so **concurrent tasks share one container** |
| SA-7 | SB5 | A grant for `terminal` does not authorize a different argv; `cross_profile` self-opt-out gone | Replay the approved hash against a **different** argv and observe refusal |
| SA-8 | SB2 | **Guards never relax on believed containment** | Force `env_type` to a container value with **no container present**; assert guards **still run** at all three sites (`approval.py:1595-1598`, `check_all_command_guards`, `check_dangerous_command`) |
| SA-9 | SB2 | No host credential, skills, or cache path is readable inside the sandbox | **Real container**; enumerate `docker inspect` Mounts and assert the closed allowlist |
| SA-10 | SB4 | Contained task cannot reach the gateway, Hermes (`:8000`), or Ollama (`:11434`) **with a network attached** | **Real container on the egress network** — `--network=none` does not exercise this |
| SA-11 | SB2a | Sandbox-written artifacts cannot obtain host execution | Plant `.git/hooks/post-checkout` **and** `vitest.config.ts`; assert both are neutralised before any host tool runs |
| SA-12 | SB1 | Gateway binds loopback only | **Regression guard** — `server.ts:159` already defaults `127.0.0.1`; this pins it |
| SA-13 | SB6 | Every container run is reconstructable from the audit log | Assert id + digest + flags + mounts + argv all present |
| SA-14 | SB6 | Orphaned/expired containers are swept **while running** | Existing reaper is `status=exited` only — assert a **live** orphan is reaped |
| SA-15 | SB4 | `pnpm install` and `git fetch` **succeed** in the secure default configuration | The adoption criterion — **if this fails, the control gets switched off and the work is wasted** |

**Gate:** full suite green; reachability green; A6/T-9 for every new wire command; no existing test
weakened.

---

## 8. Falsifiability obligation

Per PRD-005 §8 T-9: for **every** acceptance criterion, revert the guard → observe **RED with the
output recorded in the evidence** → restore → **GREEN**. **A probe reported without its RED output is
not a discharged probe.**

**Why this is stated in full:** v0.1's SA-4/SA-5/SA-6 were **satisfiable by assertion** — this repo's
recorded recurring defect ([[unenforced-claim-pattern]]), reproduced by this document's own author
after a prior amendment was G1R-rejected for exactly it. The obligation is extended to **every**
criterion specifically because the author has demonstrated the failure mode twice.

---

## 9. Operator ruling — the nine directed corrections

**Operator caveat, load-bearing:** *"my assessment — I haven't audited the code this session, so treat
each fix as design guidance, not a patch."* Each item was therefore checked against the emitter before
being written here; **findings that changed an item are marked.**

### P0 — ship regardless of the sandbox

**1. Approval card shows the resolved command, not the tool name.**
Payload = post-expansion **argv** + cwd + network destinations. **Bind approval to an argument hash:
one approval = one argv.** Default-**DENY** classes (not "ask"): pipe-to-shell, base64-decode-then-exec,
and any command whose network targets are outside the task's declared egress list; override only via a
separate, deliberately harder flow.
**→ VERIFIED, AND IT CHANGES THE ITEM'S ROLE:** `ToolApprovalRequired` **already carries `args`**
(`contracts/src/errors.ts:13-22`) and `APPROVE_TOOL` deliberately carries **no tool name** so a client
cannot widen a grant (`commands.ts:33-40`). **Transport is not the gap** — argv *resolution*, *hash
binding*, and *rendering* are. And because `dispatch.ts:262` currently **refuses FRONTIER granted runs
outright** for want of exactly this proof, **item 1 is the UNLOCK for FRONTIER `terminal`, not a
hardening item** — it is the same work as SB5.

**2. `TERMINAL_ENV` → per-call policy in the gateway.** Capability set fixed at dispatch, read from
the task record; env vars advisory only. **PRD rule, verbatim: "ambient environment is never a
security boundary."** → SB1.

**3. Kill the containment relaxation — guards always apply.**
**Operator chose the inversion over a token scheme, and I agree:** the host-guard path and the sandbox
path are the **same code**; containment changes only **where** execution happens, never **whether**
guards apply. This makes M-3 **unrepresentable** rather than defended.
**→ VERIFIED, AND WORSE THAN REPORTED: three sites, not one.** `approval.py:1595-1598` is an
**unconditional early return** on a *believed string* —
`if env_type in {"docker","singularity","modal","daytona","vercel_sandbox"}: return {"approved": True}`
— and its own comment states the same skip exists in **`check_all_command_guards`** and
**`check_dangerous_command`**. `env_type` is the per-call `_get_env_config()` read, so **a believed
string disables the guard**. A token scheme would have had to protect all three forever; the inversion
deletes them. → SA-8.

### P1 — sandbox topology

**4. Bind mount → copy-in / copy-out, never an RW host workspace.** (a) tarball in to a named volume
or fresh clone; artifacts out **through a scanner**; host toolchain treats exposed workspaces as
untrusted until scanned. (b) **The mount set is a closed allowlist** — credential, skills and cache
families **disabled** and their absence asserted at start (`docker.py:648-716` mounts all three `:ro`
by default; `:ro` blocks modification but **not exfiltration**, inverting §4's "never see provider
keys" via the filesystem rather than env).
**→ SCOPE CORRECTION:** the default workspace is **tmpfs** (`:626`), not a host bind — the host bind
occurs only under `bind_host_cwd` or explicit user config (`:635-640`). So E-2 is **real but opt-in**,
and the primary fix is **never enabling that mode** plus SB2a's scanner. **Scanner path list is
`UNVERIFIED` — must be checked before it becomes a criterion.** → SB2a, SA-9, SA-11.

**5. Stop claiming uid protection on Windows.** Docker Desktop's gRPC-FUSE/9p layer ignores POSIX uid
semantics; container writes land as the host user; the flag is **decorative** there. **The writability
boundary is mount topology (ro mounts, named volumes), never uid.** If uid separation genuinely
matters, the sandbox must live **in WSL2 on a Linux filesystem with a distinct user**, not a Windows
bind mount. **Windows is a distinct threat model** in this PRD. → §3 rows corrected; §5.

**6. Gateway unreachable from the sandbox** — else the thing seeking approval can reach the thing
granting it (**consent forgery**). (a) gateway binds host-loopback only, never the docker bridge;
(b) gateway **rejects any request bearing sandbox-session identity as an untrusted input channel,
never as operator consent**; (c) egress via a gateway-controlled allowlist proxy with the gateway's
own address denied.
**→ VERIFIED: (a) is ALREADY SATISFIED** — `server.ts:159` defaults `HOST` to `127.0.0.1`,
`.env.example:7` sets it. So (a) becomes a **regression guard** (SA-12), not new work. **(b) and (c)
remain unbuilt.** → SB4, SA-10.

**7. Cut tmpfs `noexec` from the control list.** It blocks `execve` of a file and does nothing against
`python3 x.py` / `sh x.sh` / `node x.js`, and the default image ships all three.
**→ VERIFIED, WITH A CORRECTION TO G1R:** the backend's `/tmp` exec is a **deliberate documented
tradeoff** (`:334`, *"needed by pip/npm builds"*), not an oversight — and `/var/tmp` **is** `noexec`
(`:335`). So the item is right for a **different reason** than G1R gave: `noexec` is not absent, it is
**ineffective** where it exists. **Be honest in the PRD that execution control is not implemented —
the real controls are mounts + network + approval content.** Seccomp interpreter-blocking is
**UNVERIFIED** and must not become a criterion until checked.

### P2 — operational

**8. Make the secure mode the working mode.** With `--network=none` + workspace-only mount,
`pnpm install`, `git fetch` and the host toolchain **all stop working** — and `profileResolver.ts:9-15`
makes `terminal_power` the **default for COMPLEX_CODING**, i.e. the coding profile's most common
action. **Fix: dependency fetch becomes a separate gateway-mediated step**, egress-allowlisted to
registries and git remotes with results **cached**, so the sandbox stays offline **and builds still
run**. **This makes SB4 a precondition for SB2's adoptability.** Feasibility of the registry/git
allowlist is **UNVERIFIED**. → SA-15. *G1R's high-confidence prediction, which I share: shipped
without this, the first real coding task fails and `TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` becomes
permanent within a day — **a control that gets switched off is worth less than no control.***

**9. Container lifecycle ownership.** Label with task ID + creation time; reap past TTL **or**
orphaned. → SB6, SA-14.
**Live evidence, and the reason this is not theoretical:** four orphaned `torq-console-verify:*`
containers ran `Up ~45h` from a single 2026-08-15 17:52 run. One (`torq-live-e2e-anthropic`) served an
**unauthenticated loopback proxy** (`proxy_secret_required: false`) to a configured Anthropic
credential on `127.0.0.1:8899`.
**Scope, corrected by the operator:** loopback-only on a host with **no internet path** — **not an
exposure, no rotation indicated.** **But the operator's ruling is that it must be fixed as if the host
were internet-reachable**, which is §2 corollary 2: *"no internet on this host" is ambient state, and a
control that is safe only because of it is not a control.* Two fixes follow — the TTL reaper here, and
**`proxy_secret_required` defaulting to `true` with startup refusal if unset** so the insecure mode
requires an **explicit act rather than an omission**.
**JURISDICTION:** that default lives in the **TORQ-CONSOLE** image, and `CLAUDE.md:34` forbids this
lane from touching `E:\TORQ-CONSOLE`. **Specified here, not fixed here** — it needs either an operator
change in that repo or an explicitly authorized session rooted there. *(Operator stopped all four
containers; reversible via `docker start`.)*

---

## 10. Rollback

Each slice flag-gated and separately revertable. **Turning the sandbox off is a capability decision,
not a convenience:** with it off, `terminal_power` must become **ungrantable** rather than silently
reverting to host execution — the same discipline as PRD-005 §9's prohibition on using
`TORQCLAW_COLLAB_ENABLED=0` as a rollback. Note the asymmetry with §9 item 1: **today FRONTIER grants
are already refused** (`dispatch.ts:262`), so "off" is the current state and this PRD's job is to make
"on" *provable*.

## 11. Open questions

1. **Image** — build a TorqClaw-specific pinned minimal image (recommended for a security boundary) or
   pin an upstream one? **Who rebuilds on CVE, and does a stale digest fail closed or run forever?**
2. **Docker lifecycle** — operator says Docker stays running. Verify health at startup **and per call**
   (recommended) and refuse `terminal_power` when absent?
3. **Egress** — allowlist-only from the start (recommended; loosening later is easy, tightening later
   breaks workflows)?
4. **Vendored boundary** — SB2 touches the Hermes wrapper. Confirm this stays **wrap, don't rewrite**;
   §9 item 3's inversion touches `approval.py`, which is **vendored** — this needs an explicit ruling.
5. **WSL2 relocation** — does §9 item 5's "sandbox in WSL2 with a distinct Linux user" get adopted, or
   is Windows accepted as a weaker threat model with mount topology as the only boundary?
6. **`--memory-swap`** — set equal to `--memory`? Without it, swap exceeds the limit. And seccomp:
   the host reports a builtin profile but the backend never pins one.

## 12. Operator stop conditions

Any change to vendored Hermes beyond the wrapper (**including §9 item 3's `approval.py` inversion —
see OQ-4**); enabling the sandbox in a deployment; push/merge/release of any slice; anything that would
make `terminal_power` grantable without **verified** containment.
