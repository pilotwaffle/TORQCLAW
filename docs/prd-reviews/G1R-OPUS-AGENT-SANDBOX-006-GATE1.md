# G1R Gate-1 review — PRD-TCLAW-AGENT-SANDBOX-006 v0.1

**Seat:** G1R — independent design reviewer.
**Model:** `claude-opus-5`. The routing profile in `CLAUDE.md` §2 names **Opus 5** for G1R and I am
`claude-opus-5`, so **no substitution applies**.
**Date:** 2026-08-17 · **Branch:** `phase1-server-owned-authority` · **HEAD:** `67c02a0`
**Target:** `docs/PRD-TCLAW-AGENT-SANDBOX-006.md` (v0.1 DRAFT, pre-Gate-1), authored by G1D
(`claude-fable-5`) — the same seat that will orchestrate implementation.
**Context:** fresh thread, no authoring context. Repo is PUBLIC; no `.env` values or secrets appear
below.

---

## VERDICT: **REJECT** — 9 blockers

Not a rejection of the idea. The threat model is **correct**, the slice decomposition is sound, and
§3's measured-not-assumed discipline is genuinely better than most security PRDs in this repo. The
rejection is because **the design as written does not deliver the containment it claims**, and for a
security boundary that is the worst failure mode: it manufactures false confidence.

Three findings are individually sufficient to reject:

1. **§3's measured container profile is unreachable through the architecture §5 commits to.** I read
   the vendored Docker backend that SB2 must drive. It does not pass `--read-only`, it does not pass
   `--user` on Windows, its `/tmp` is **not** `noexec`, its network **defaults to on**, and it
   **bind-mounts host credential/skills/cache directories into the container by default**. §3
   measured `docker run` flags typed by hand at a shell; §5 promises to reach them through code that
   emits a different and materially weaker flag set. The PRD never reconciles the two.
2. **The fail-closed claim is architecturally unsound as specified** — but is *rescuable*, and the
   seam that rescues it already exists in TorqClaw-owned code. The PRD does not name it. (§3 below.)
3. **The bind-mounted workspace is an unaddressed host-execution channel.** I demonstrated it: a
   contained agent plants a `.git/hooks/post-checkout`, and it lands on the host owned by the
   operator, mode `0755`. Containment of the *process* is not containment of its *effects*.

Everything is reproducible from the evidence in §2 and §3.

---

## 1. What I reviewed

| Artifact | How |
|---|---|
| `docs/PRD-TCLAW-AGENT-SANDBOX-006.md` (185 lines) | read in full |
| `docs/security/agent-execution-isolation-audit.md` (158 lines) | read in full |
| `packages/bridge/src/pathScope.ts`, `registry.ts`, `capability.ts`, `toolFilter.ts` | read in full |
| `engines/hermes_kernel/mcp_wrapper/hermes_runner.py`, `approval_hook.py` | read (runner §240-420, hook in full) |
| `engines/hermes_kernel/vendor/hermes-agent/tools/terminal_tool.py` (2684 ln) | read the config/dispatch/requirements paths |
| `engines/hermes_kernel/vendor/hermes-agent/tools/environments/docker.py` | **read the actual `docker run` argv construction** — the artifact SB2 must drive |
| `file_tools.py`, `code_execution_tool.py`, `credential_files.py` | read the backend-routing decisions |
| `packages/gateway/src/profileResolver.ts`, `packages/contracts/src/profile.ts` | read for SB0 startup-refusal reachability |
| `docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` §6/§8 | verified the cited A6/T-9 standard **exists** |
| Live Docker (28.3.2, Linux containers, Docker Desktop/WSL2) | **6 escape experiments executed**, all `--rm`, no socket mounted, all artifacts removed |

Empirical work was run against ephemeral containers only. `docker ps -a` after my work shows **no
container I created**; the 17 pre-existing containers belong to other projects (torq-console,
torq-buzz, torq-writer) and I did not touch them. Probe directories under the session scratchpad were
deleted. No operator file was modified.

---

## 2. Obligation 1 — Is the threat model right?

### Verdict: **YES, the jurisdictional claim is correct.** Verified independently, not taken on trust.

The chain holds at every link:

- `packages/bridge/src/toolFilter.ts:60` — `t.sourceServerId !== 'hermes'` excludes Hermes tools from
  the registry surface handed to user loops.
- `packages/bridge/src/registry.ts:214-220` — `checkPath` runs **only** inside `executeTool`, which is
  reached only via `getClient(entry.sourceServerId).callTool`. A tool never in the registry never
  reaches this code.
- `hermes_runner.py:327` — `"terminal_power": ["web", "file", "terminal", "code_execution"]` enables
  the toolsets inside the vendored agent's own loop.
- `file_tools.py:604-727` and `code_execution_tool.py:592-691` — both resolve their execution backend
  from `terminal_tool._get_env_config()`, entirely inside the vendored process.

**No bridge code is on that path.** The audit's G-1 is accurate and the PRD is correctly aimed.

I also confirmed the three cheap gaps the PRD inherits, **by execution** against
`packages/bridge/dist/pathScope.js`:

```
G-4 empty write allowlist -> null            // null == ALLOW. Fail-open confirmed.
G-5 extractPaths({outputPath:'C:/evil.txt'}) -> []   // invisible to scoping. Confirmed.
lexical '..' traversal    -> denied          // this one is genuinely enforced (credit where due)
```

`pathScope.ts:44` is the fail-open: `if (allow.length === 0) return null;`. `pathScope.ts:54-57`
is the fixed key list that misses `outputPath`. Both PRD claims are true.

### Did the audit MISS a second path with the same property? **Yes — three.**

**M-1 — `_get_env_config()` is re-read on EVERY tool call, from process env.**
`terminal_tool.py:1073` and `:1878` — `_get_env_config()` is called *inside* `terminal_tool()` per
invocation, not once at startup. Any code in the engine process that can mutate `os.environ` between
calls changes the execution backend mid-task. A startup-time assertion (SB0's "startup refusal")
therefore proves **nothing about the state at call time**. The audit frames `TERMINAL_ENV` as a
static deployment fact; it is dynamic per-call state. This directly undermines SB0's A-4 and SA-2.

**M-2 — `TERMINAL_DOCKER_EXTRA_ARGS` is unvalidated `docker run` argv injection.**
`terminal_tool.py:1096` parses it as JSON; `docker.py:767-772` appends every string entry to the
`docker run` command line with **no allowlist and no rejection of dangerous flags**. Anything that
can set this env var can append `--privileged`, `-v /:/host`, `--cap-add ALL`, `--network host`, or
`--pid host` and dissolve the entire boundary from inside the "sandbox" configuration. The PRD's §4
env-allowlist bullet governs env passed *into* the container; it says nothing about env that
configures *the container itself*. This is a same-property second path the audit missed.

**M-3 — `code_execution_tool.py:1114` branches on `env_type != "local"`.**
The guard `check_execute_code_guard(code, env_type)` (`:1097-1105`) takes `env_type` as an input,
i.e. the *safety* checks weaken when a container is believed present. If containment is believed but
absent (see M-1, and Blocker 2), this is a strictly worse posture than no sandbox: the host-execution
guards relax on the strength of containment that is not there. **The sandbox actively removes a
control when it mis-detects itself.**

---

## 3. Obligation 3 — The fail-closed claim (the most likely place to be unsound)

### Verdict: **Unsound as written — but rescuable. The PRD promises a guarantee at a layer that cannot deliver it, and does not name the layer that can.**

I traced this in full because the brief correctly flags it as the highest-risk claim.

**What the PRD promises** (§2 corollary (b), §5 SB2, SA-4, §8): if containment cannot be established,
the capability is REFUSED, never silently downgraded to host execution.

**What the architecture allows.** SB2 must work through vendored code under "wrap, don't rewrite"
(§9 OQ-4). Following the real control flow:

- `terminal_tool.py:1237-1238` — `if env_type == "local": return _LocalEnvironment(...)`. Host
  execution is the *first branch* and is unconditional.
- `terminal_tool.py:2462-2463` — `check_terminal_requirements()` returns `True` for `local`
  **unconditionally, without checking anything**. A "requirements check" that cannot fail for the
  dangerous mode is not a gate.
- `terminal_tool.py:1878` — the backend is chosen from env **per call**.

Good news, stated fairly: the docker branch (`:1240-1260`) does **not** silently fall back to local —
`_ensure_docker_available()` (`docker.py:556`) raises. So *if* `TERMINAL_ENV=docker` is genuinely in
effect at call time, a Docker outage produces an error rather than host execution. That much of §5
SB2 is achievable.

**The unsound part is the premise, not the fallback.** Everything above depends on
`TERMINAL_ENV=docker` being true *at each call*. TorqClaw currently **never sets it** — I grepped the
entire `mcp_wrapper/`: **zero** occurrences of `TERMINAL_ENV` or `os.environ[...]` assignment. So
today the wrapper has no control over the backend at all, and per M-1 a startup check cannot
establish a per-call property. A design whose enforcement is "we will set an env var the vendored
code re-reads on every call, and check it once at boot" is **not fail-closed** — it is
fail-closed-on-average.

**The seam that actually works, which the PRD does not name.**
`engines/hermes_kernel/mcp_wrapper/approval_hook.py` already registers a **`pre_tool_call` hook**
into the vendored plugin manager (`approval_hook.py:131-144`), programmatically, with no vendor edit
— the file's own docstring says *"no plugin directory, no vendor edit — invariant 5 'wrap, don't
rewrite' holds."* That hook:

- runs **inside the agent's thread, immediately before each tool executes** (`:67`),
- can **`{"action":"block"}`** any call (`:117-125`),
- is TorqClaw-owned code in `mcp_wrapper/`, not vendored,
- and is already proven in production for the approval gate.

This is a genuine, per-call, wrapper-level enforcement point. Fail-closed **is** enforceable here —
verify containment *at the hook, per call*, and block when it is not established. That converts an
unenforceable boot-time claim into a real one, at the only layer with per-call authority, without
touching vendored code. The PRD's own architectural constraint does not prevent the guarantee; the
PRD simply specified it at the wrong layer.

---

## 4. Obligation 2 — Escape-vector enumeration

Every experiment below was **executed on this host** (Docker 28.3.2, Linux containers via Docker
Desktop/WSL2), `--rm`, no socket mounted, artifacts removed.

### E-1 — Docker socket: **NOT a hole. Correctly out of scope.**
`grep` across `vendor/hermes-agent/tools/` and `mcp_wrapper/`: the socket is never mounted. It appears
only in `file_tools.py:292` `_SENSITIVE_EXACT_PATHS = {"/var/run/docker.sock", "/run/docker.sock"}` —
i.e. as a *blocked* path. **Credit to the design.** Should be stated as an explicit non-goal so a
future `TERMINAL_DOCKER_VOLUMES` entry cannot reintroduce it silently (see Blocker 4).

### E-2 — Bind-mounted workspace as host-execution channel: **UNADDRESSED HOLE. Demonstrated.**
Executed as `--user 65534 --cap-drop ALL --read-only --network none`:
```
mkdir -p /workspace/.git/hooks
printf '#!/bin/sh\necho HOST_HOOK_EXECUTED\n' > /workspace/.git/hooks/post-checkout
chmod +x  /workspace/.git/hooks/post-checkout   -> GIT HOOK PLANTED
```
Host-side, immediately after:
```
-rwxr-xr-x 1 Barry 197121 24 Aug 17 00:49 payload.sh
#!/bin/sh
echo HOST_HOOK_EXECUTED        <- the planted hook, on the host, mode 0755, owned by the operator
```
The container is confined; **its output is not**. The next host-side `git checkout`, `npm install`
(lifecycle scripts), `pnpm build`, IDE index, test run, or `pre-commit` executes attacker-authored
content **as the operator, outside the container**. SB3's per-task worktree makes this *worse*, not
better: a worktree is a directory the host toolchain is specifically expected to operate on. The PRD
never asks *who reads the workspace afterwards and with what privilege* — the brief's exact question,
and the design has no answer. **This is the single most important gap.**

### E-3 — Symlinks inside the bind mount pointing out: **UNADDRESSED HOLE. Demonstrated.**
```
ln -s /etc/passwd /workspace/escape_link   -> SYMLINK CREATED
host: lrwxrwxrwx 1 Barry 197121 11 escape_link -> /etc/passwd
```
The symlink persists on the host with a host-interpreted target. SB0 hardens `packages/bridge`
against symlinks — but E-2/E-3 are created **inside the container by the Hermes toolset**, which by
the PRD's own thesis never traverses the bridge. **SB0's symlink fix does not cover the symlinks the
sandbox itself enables.** The PRD treats symlink resolution as an SB0 concern; it is also an SB2/SB3
concern, and the document does not connect them.

### E-4 — `.git` hooks the HOST later executes: **UNADDRESSED.** Covered by E-2; called out separately
because §4's `.dockerignore` bullet excludes `.git` from the *image*, which does nothing about `.git`
inside the *bind-mounted workspace*. The PRD may have conflated the two.

### E-5 — Files the host toolchain auto-executes: **UNADDRESSED.** Beyond `.git/hooks`: `package.json`
(`preinstall`/`postinstall`), `.vscode/tasks.json`, `conftest.py` (auto-imported by pytest),
`sitecustomize.py`, `.envrc`, `Makefile`, `vitest.config.ts`, `.pre-commit-config.yaml`. In a repo
whose gates are `pnpm test` / `pnpm build`, a contained agent that can write `vitest.config.ts` or a
`postinstall` script obtains host execution at the next gate run. No mitigation is proposed.

### E-6 — MCP servers running OUTSIDE the container: **UNADDRESSED, and structurally awkward.**
Bridge MCP servers are host processes (`registry.ts:123-135`, stdio/HTTP). The sandbox contains the
*Hermes* toolset but the same task can drive host-side MCP tools — including `desktop_commander`,
which `terminal_power` explicitly allows (`profile.ts:100`). Containing `terminal` while leaving a
host-side desktop-automation namespace grantable in the same profile is a boundary with a door next
to it. The PRD never states which side of the boundary bridge MCP servers are on.

### E-7 — Gateway reachable if egress is later allowlisted (SB4): **UNADDRESSED HOLE. Demonstrated.**
With `--network none` the isolation is genuine — I confirmed both DNS and raw IP fail:
```
1.1.1.1:53 -> OSError: [Errno 101] Network unreachable
host.docker.internal:8787 -> socket.gaierror
```
But SB4 proposes attaching a network with an allowlist. With **any** network attached:
```
host.docker.internal:8787 -> ConnectionRefusedError   <- host REACHED; port merely closed
1.1.1.1:53                -> REACHABLE
```
`ConnectionRefused` (not `gaierror`) proves the host is routable the moment egress exists. On Docker
Desktop, `host.docker.internal` is injected automatically. So SB4's "default-deny allowlist" must
deny the **host itself** — the gateway, the Hermes engine on `127.0.0.1:8000`, Ollama on `11434`, and
the whole RFC1918 space — not merely filter public destinations. An allowlist naively written as
"permit `pypi.org`, `registry.npmjs.org`" leaves the loopback-adjacent host wide open, and the
gateway is the component that *issues the grants*. SB4 as written would let a contained agent reach
the authority that contains it.

### E-8 — tmpfs `noexec` bypass via interpreters: **UNADDRESSED HOLE. Demonstrated.**
```
/tmp/x.sh (chmod +x)        -> sh: /tmp/x.sh: Permission denied     <- noexec works for exec()
python3 /tmp/y.py           -> PWNED_VIA_PYTHON_INTERPRETER         <- bypassed
sh /tmp/x.sh                -> PWNED_VIA_EXEC_BIT                   <- bypassed
```
§3 lists `noexec`/`nosuid` as a *measured control*. Against an adversary with `terminal_power` in an
image that by §4's own admission **must contain a shell**, and whose default image
(`nikolaik/python-nodejs`, `terminal_tool.py:1072`) ships Python **and** Node, `noexec` stops
approximately nothing. Listing it as a control without this caveat is the "reads rigorous, enforces
little" pattern. It is worth keeping as defence-in-depth; it must not be counted as containment.

### E-9 — Resource-limit evasion: **PARTIALLY ADDRESSED.** `--pids-limit`/`--memory`/`--cpus` are real
(cgroups). But `docker.py:564-571` shows `--storage-opt` disk limits are **silently skipped** unless
overlay2-on-XFS-with-pquota — logged as a warning and ignored. On Docker Desktop/WSL2 this is not
satisfied, so **there is no disk quota**. §4 says "resource limits are mandatory, not advisory"; the
backend demotes one of them to advisory on this exact host. Additionally, `--memory` without
`--memory-swap` permits swap usage beyond the limit.

### E-10 — Image supply chain: **PARTIALLY ADDRESSED.** §4's digest pinning and CI scanning are correct
and I endorse them. Gap: the *default* image is a **moving tag** (`terminal_tool.py:1072`,
`nikolaik/python-nodejs:python3.11-nodejs20`) and `TERMINAL_DOCKER_IMAGE` is an unvalidated env var —
so unless SB2 *enforces* the digest at call time, the pin is a documentation claim. Also missing:
who rebuilds the pinned image when a CVE lands, and does a stale pin fail closed or run forever?

### E-11 — `TERMINAL_DOCKER_EXTRA_ARGS` argv injection: **UNADDRESSED HOLE.** See M-2 above. This is a
config-to-`docker run` injection that voids every §3 flag. It deserves its own denial, not silence.

### E-12 — Host credential/skills/cache bind mounts: **UNADDRESSED HOLE — and it inverts §4.**
`docker.py:641-716` mounts, **by default, with no opt-out flag**:
- `get_credential_file_mounts()` — host credential files (OAuth tokens etc.) → `:ro`
- `get_skills_directory_mount()` — the host skills tree → `:ro`
- `get_cache_directory_mounts()` — host documents/images/audio/screenshots caches → `:ro`

`:ro` prevents *modification*; it does nothing about **reading and exfiltrating**. §4 states "agent-run
code must never see provider keys… env passed into the sandbox is an explicit allowlist, defaulting
to empty" — but the backend SB2 will drive mounts host credentials into the container **through the
filesystem**, entirely bypassing the env allowlist. The PRD's stated control and the actual code
point in opposite directions. Combined with SB4 egress, this is a direct exfiltration path. This
alone justifies rejection.

### E-13 — Windows `--user 65534` does not protect bind mounts: **UNADDRESSED. Demonstrated.** See §6.

### E-14 — Container reuse across tasks defeats SB3: **UNADDRESSED.**
`terminal_tool.py:1183-1185` — `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES` **defaults to `true`**, and
`:1881-1885` collapses subagent `task_id`s to `"default"` so *"the top-level agent and every
delegate_task child share one container."* SB3 promises "concurrent tasks cannot collide"; the
backend's default behaviour is **deliberate container sharing**, and persistence *across processes*
means state survives task boundaries. SA-6 cannot pass without overriding a vendored default the PRD
never mentions.

---

## 5. Obligation 4 — Slice ordering and SB0

### Is SB0 independently valuable and shippable first? **Mostly yes — with one item misplaced.**

Genuinely independent and valuable: symlink resolution, fail-closed allowlists, schema-driven path
extraction. All three fix live defects in `packages/bridge`, which is enforced today, and I confirmed
two of them by execution (§2). Shipping them first is correct.

**Misplaced:** the **startup refusal** is specified as SB0 but its correctness depends on SB1/SB2
(what "sandbox is configured" *means* is defined by SB1's policy and SB2's verification). Shipping a
refusal before the thing it checks exists means it must check a proxy — `TERMINAL_ENV` — which per
M-1 is a per-call value that a boot-time check cannot establish. **SB0's startup refusal depends on a
later slice.** The PRD's claim that every SB0 item is independent is false for this one.

**Also incomplete:** SB0 hardens `packages/bridge` — a path the PRD's own §1 says the dangerous tools
**never traverse**. That is worth doing, but the PRD should be explicit that SB0 delivers **zero**
mitigation for the `terminal`/`code_execution` threat that motivates the document. As written a
reader may reasonably conclude SB0 partially closes G-1. It does not close any of it.

### Is the startup refusal correctly specified? **No — underspecified, and it will brick every default dev setup.**

*"if a profile granting `terminal`/`code_execution` is reachable while no sandbox is configured,
refuse to start"* — "reachable" is never defined. I resolved it against the code:

`packages/gateway/src/profileResolver.ts:9-15`:
```ts
const DEFAULT_PROFILE_BY_TASK: Record<TaskType, ProfileId> = {
  ...
  COMPLEX_CODING: 'terminal_power',
};
```

`terminal_power` is the **default profile for `COMPLEX_CODING`**, requiring no operator action, no
config, no opt-in. Under any reading of "reachable," it is reachable in **every** deployment,
including a fresh clone. So:

- **It fires spuriously and bricks every dev setup on day one** — a gateway that refuses to start out
  of the box. Every operator will immediately set `TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` and never
  unset it. The control becomes a one-time speed bump that trains operators to disable it, which is
  strictly worse than no control: it produces a documented, permanent opt-out flag in every
  environment.
- **And it can fail to fire when it should** — because per M-1 `TERMINAL_ENV` is re-read per call, a
  boot check that passes proves nothing about call-time state.

Both failure directions at once. This is the item most likely to be shipped, sworn to, and hollow.

---

## 6. Obligation 7 — Windows reality

**`--user 65534` provides NO filesystem protection on Windows bind mounts. Demonstrated.**
```
uid=65534(nobody) gid=65534(nobody)
write new file to bind mount         -> WRITE OK
overwrite HOST-created file          -> OVERWRITE OK
ls -la /workspace                    -> drwxrwxrwx  1 root root  .
chmod +x /workspace/payload.sh       -> -rwxr-xr-x  (succeeded)
```
Docker Desktop's WSL2/9p translation layer presents bind mounts as `0777` with no meaningful uid
mapping. `--user 65534` gives a convincing `id` output and **zero** protection over the one writable
path that matters. Host-side, every file the container wrote is owned by `Barry` (the operator) —
so §3's "Non-root ✔ `uid=65534(nobody)`" is a **measured-but-misleading** result: it measured the
uid, not the protection. This is exactly the class of check that reads rigorous and enforces nothing,
and it is the kind of thing §3's otherwise-commendable methodology was supposed to catch.

**MSYS path translation:** §3's note is correct and well-observed. `MSYS_NO_PATHCONV=1` was required
in my own probes. Credit — this is real operational knowledge.

**Bind-mount performance:** not measured by the PRD. Docker Desktop bind mounts to Windows drives
(`E:\`) traverse a 9p/virtiofs boundary with well-known large penalties on many-small-file workloads
— `node_modules`, `.git`, `pnpm install`, `vitest`. **SB3 (per-task worktree, bind-mounted) is the
worst case for this**: a fresh worktree of this monorepo is exactly a many-small-file workload, and
SB3 proposes creating one *per task*. The PRD asserts SB3 is viable without a single measurement,
which is out of step with §3's own "measured, not assumed" standard. My assessment (**opinion**,
un-measured): SB3 will be slow enough on Windows to become the reason the sandbox gets switched off.
It needs a measurement before it is committed to.

---

## 7. Obligation 6 — What does the sandbox break?

The PRD does not have a compatibility story. **This is the risk that gets the control switched off**,
which the brief correctly identifies as the worst outcome.

With `--network none` + workspace-only mount, the following **stop working**:

| Legitimate work | Why it breaks |
|---|---|
| `pip install`, `npm/pnpm install` | no network. `COMPLEX_CODING` → `terminal_power` is *the coding profile*; installing deps is its most common action |
| `git fetch/push/clone` | no network, and no credentials (correctly, but nothing replaces them) |
| Reading files outside the workspace | monorepo work routinely needs a sibling package, `~/.torqclaw/servers.json`, a global config |
| Host toolchain expectations | image has Python/Node; **not** `pnpm`, `uv`, `turbo`, project-pinned versions, or the operator's `PATH` |
| `pnpm build` / `pnpm test` | needs the monorepo's installed `node_modules`, `turbo`, and the contracts build |
| Anything reading `.env` | correctly denied — but tasks that legitimately need a non-secret env var have no mechanism |

There is no migration path, no "sandboxed vs unsandboxed" task classification, no offline dependency
cache, no way for the operator to grant an extra read-only mount for a task. §9 OQ-3 asks about egress
but frames it as a policy preference, not a compatibility blocker. **Prediction (opinion, high
confidence):** shipped as specified, the first real `COMPLEX_CODING` task fails on `pnpm install`, and
`TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` becomes permanent within a day.

---

## 8. Obligation 5 — Are the acceptance criteria falsifiable?

The repo has a recorded failure mode here, and PRD-005 §9b line 390 records that **this same author's
prior amendment was G1R-REJECTED** for a falsifiability clause citing a standard that did not exist.

**Good news first, and it is real:** the A6/T-9 citation in this PRD **checks out**. I verified
`docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md:175` (A6) and `:273-300` (T-9) exist and carry a
self-contained, artifact-producing standard. The §7 falsifiability obligation ("each guard reverted →
RED with recorded output → restored → GREEN") is a genuine mutation-testing requirement. **That
lesson was learned.** Credit.

Per-criterion audit:

| ID | Falsifiable? | Assessment |
|---|---|---|
| **SA-1** | **Yes — strongest in the doc.** "proven by a test that fails against today's code" is a mutation probe with a defined RED state. Model criterion. |
| **SA-2** | **Partly.** Empty-allowlist half is mechanically checkable. Startup-refusal half is **not**: "reachable" is undefined (§5 above), so a builder can satisfy it by any convenient reading. |
| **SA-3** | **Yes — well written.** "proven by executing a real container, not by asserting a config value" is precisely the right standard and directly answers the repo's config-value-testing defect. |
| **SA-4** | **Partly.** "a test that simulates the failure" — a *simulated* Docker outage (mock/monkeypatch) proves the wrapper's error path, not that the real backend cannot fall back. Given `terminal_tool.py:1237` returns `_LocalEnvironment` as its first branch, the mock will pass while the real risk (per §3) is unproven. **Satisfiable by assertion.** |
| **SA-5** | **No — untestable as written.** "no prompt, task field, or model output can widen the sandbox policy" is a universal negative over an infinite input space. TS-6 reduces it to "a hostile prompt," singular. A builder writes one prompt, it fails to widen, criterion satisfied — while M-2's `TERMINAL_DOCKER_EXTRA_ARGS` widens everything through a channel no prompt test touches. |
| **SA-6** | **No — will pass vacuously or fail confusingly.** Requires overriding `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES` and the `task_id`→`"default"` collapse (E-14), neither mentioned. Against default backend behaviour, two concurrent tasks **share one container**. |
| **SA-7** | **Partly.** The `cross_profile` half is binary and checkable (good). "does not authorize an arbitrary second command" is undefined — no allowlist grammar is specified, so "arbitrary" is the builder's to define. |
| **Gate line** | **Yes.** "full suite green; reachability green; A6/T-9; no existing test weakened" is concrete and matches repo practice. |

**TS-1..TS-8:** TS-1/TS-4 are excellent (TS-4 names four executed outcomes). TS-2/TS-3/TS-8 inherit
their parents' definitional gaps. TS-5 inherits SA-4's simulation weakness. TS-7 inherits SA-6's
vacuity. **TS-6 is the weakest**: a single hostile prompt cannot establish a universal negative.

**Nothing here reproduces the prior rejection's exact defect** — the cited standard exists this time.
The weakness is different and milder: several criteria are **undefined rather than uncited**. Fixable
by definition, not by re-architecture.

---

## 9. Obligation 8 — What is missing entirely

- **M-A — Audit logging of what the sandbox did.** Invariant 8 ("receipts from real telemetry only")
  is a repo invariant. Nothing in the PRD records the container id, image digest, flag set, mounts,
  or commands executed. After an incident the operator cannot reconstruct what ran.
- **M-B — Kill/timeout path for a runaway container.** `TERMINAL_TIMEOUT` (180s) bounds a *command*.
  Nothing bounds the container. No `docker kill`, no task-level deadline, no operator abort.
- **M-C — Lifecycle and cleanup.** `docker.py` has an orphan reaper, but per `terminal_tool.py:1190`
  it is *conservative* (Exited-only, ≥2× idle window, profile-scoped). **This host currently has 4
  containers "Up 36 hours"** — leaked containers are demonstrably a live condition on this machine,
  not a theoretical concern. No volume cleanup for `~/.hermes/sandboxes/<task_id>` either, which
  grows without bound.
- **M-D — Concurrency limits.** Nothing caps concurrent sandboxes. With `--memory 512m` each, N
  concurrent tasks is an N×512MB host DoS — the resource limit is per-container, not per-host.
- **M-E — Approval ↔ sandbox interaction.** **The most important omission in this section.** The
  approval card names a *tool*, not a *command* (`approval_hook.py:106` stores `{toolName, args}` but
  the PRD never requires surfacing args). SB5 promises argument-scoped grants; the PRD never says the
  human is shown **what will actually run**, or **that it will run contained**. An operator approving
  "terminal" today cannot tell `ls` from `curl … | sh`. §1's "consent, not containment" insight
  applies to consent's *content* too, and the PRD only fixes the containment half.
- **M-F — Post-hoc inspection.** No way to inspect a finished sandbox run: no retained logs, no
  workspace diff, no "what did this task change" view. SB3 discards the worktree, destroying the
  evidence.
- **M-G — Egress must deny the host.** Per E-7, the allowlist must deny loopback/RFC1918/
  `host.docker.internal`. Not stated anywhere.
- **M-H — Who reads the workspace afterwards.** Per E-2. The PRD has no threat model for the
  *consumer* of sandbox output.

---

## 10. BLOCKERS

Each has a concrete suggested fix.

---

**B-1 — §3's measured profile is unreachable through the backend §5 must drive.**
*Evidence:* §3 measures hand-typed `docker run` flags. `environments/docker.py` — the code SB2 will
actually invoke — emits a different set: `grep -c "read-only" docker.py` → **0** (no `--read-only`);
`--user` only when `run_as_host_user=True` (`:730-734`) and `_resolve_host_user_spec()` returns
`None` on Windows (`:415-430`), so **never on this host**; `/tmp` is `rw,nosuid` **without `noexec`**
(`:334`); `network: bool = True` **defaults to on** (`:528`). Four of the eight §3 controls are not
delivered by the implementation path.
*Why blocking:* §3 is the PRD's evidentiary core. If its profile is unreachable, every downstream
claim inherits a false premise.
*Suggested fix:* Add a §3b table mapping **each §3 control → the exact mechanism that delivers it in
`environments/docker.py`**, with `file:line`. For each control the backend does not provide, choose
and record one of: (a) supply it via a validated `docker_extra_args` allowlist owned by the wrapper;
(b) drop the claim from §3; or (c) escalate as an explicit "wrap, don't rewrite" exception for
operator ruling under §10. Re-measure §3 by invoking **the real backend**, not a hand-typed
`docker run`.

---

**B-2 — Fail-closed is specified at a layer that cannot enforce it.**
*Evidence:* §3 above. `_get_env_config()` re-reads env per call (`terminal_tool.py:1073`, `:1878`);
`check_terminal_requirements()` returns `True` for `local` unconditionally (`:2462`);
`_create_environment` returns `_LocalEnvironment` as its first branch (`:1237`); the wrapper sets
`TERMINAL_ENV` nowhere (zero grep hits in `mcp_wrapper/`).
*Why blocking:* it is the PRD's central safety promise (§2 corollary (b)).
*Suggested fix:* Move enforcement into the **existing `pre_tool_call` hook** in
`mcp_wrapper/approval_hook.py:67-125` — TorqClaw-owned, per-call, already proven, and already
"wrap, don't rewrite" compliant per its own docstring. Specify: for any tool matching
`terminal|execute_code|write|patch|move|create|append|delete`, the hook **verifies containment for
this call** (backend is a container, container is alive, image digest matches the pin, flag set
matches policy) and returns `{"action":"block"}` otherwise. Add: *"a boot-time check is necessary but
never sufficient; `TERMINAL_ENV` is per-call state."*

---

**B-3 — The bind-mounted workspace is an unaddressed host-execution channel.**
*Evidence:* E-2/E-3/E-4/E-5, demonstrated — planted `.git/hooks/post-checkout` landed on the host
mode `0755` owned by the operator; a symlink to `/etc/passwd` persisted host-side.
*Why blocking:* it defeats the purpose. The agent is contained; its payload is not.
*Suggested fix:* Add a slice **SB2a — workspace egress review**, ordered *before* SB3. Minimum: (i)
on container exit, scan the workspace for `.git/hooks/*`, `*.sh|*.ps1|*.bat` with an exec bit,
symlinks whose target resolves outside the workspace, and auto-executed config
(`package.json` scripts, `conftest.py`, `sitecustomize.py`, `.envrc`, `Makefile`, `vitest.config.ts`,
`.pre-commit-config.yaml`); (ii) strip exec bits and reject out-of-tree symlinks; (iii) require
explicit operator review before any host process consumes a sandbox workspace; (iv) never run host
`git`/`pnpm`/`npm` inside a sandbox-written tree without that review. Add §11 "Threat model for the
workspace consumer" answering *who reads this afterwards, with what privilege*.

---

**B-4 — Host credential/skills/cache directories are bind-mounted into the container by default,
inverting §4's stated control.**
*Evidence:* `environments/docker.py:641-716` mounts `get_credential_file_mounts()`,
`get_skills_directory_mount()`, `get_cache_directory_mounts()` by default, no opt-out. `:ro` blocks
modification, not reading.
*Why blocking:* §4 promises agent code never sees provider keys and that env is allowlist-empty; the
backend delivers credentials through the **filesystem**, bypassing the env allowlist entirely.
Combined with SB4 egress, a direct exfiltration path.
*Suggested fix:* SB2 must **explicitly disable all three mount families** and assert their absence at
container start (parse `docker inspect` `Mounts` and refuse if any unexpected source appears).
Broaden §4's bullet from "no secrets via env" to **"no secrets via env *or bind mount*; the mount set
is a closed allowlist verified at start."** Add an acceptance criterion: a task inside the sandbox
cannot read any host credential path, proven by executing a real container.

---

**B-5 — `TERMINAL_DOCKER_EXTRA_ARGS` is unvalidated `docker run` argv injection.**
*Evidence:* `terminal_tool.py:1096` parses it; `environments/docker.py:767-772` appends every string
to the argv with no validation.
*Why blocking:* voids every §3 flag (`--privileged`, `-v /:/host`, `--network host`, `--pid host`)
through a channel no acceptance criterion tests. SA-5's "no task field can widen the policy" is false
while this exists.
*Suggested fix:* SB1 must treat the **entire container flag set as gateway-owned**. Specify a
wrapper-side **allowlist** of permissible extra args (default: empty) and have SB2 refuse to start if
`TERMINAL_DOCKER_EXTRA_ARGS`, `TERMINAL_DOCKER_VOLUMES`, `TERMINAL_DOCKER_ENV`, or
`TERMINAL_DOCKER_FORWARD_ENV` are set to anything outside it. Extend SA-5 to name **env-var widening**
alongside prompt/task/model widening.

---

**B-6 — `--user 65534` provides no protection on Windows bind mounts; §3 measured the uid, not the
protection.**
*Evidence:* §6, demonstrated — `id` reports `nobody`, yet the container wrote new files, **overwrote a
host-created file**, and set exec bits; mount presents as `drwxrwxrwx`; host-side files are owned by
the operator.
*Why blocking:* §3 presents this as a verified control on the target platform. It is not one.
*Suggested fix:* Replace the §3 row with the measured truth and its scope: *"`--user 65534` confines
in-container UID only; on Windows/WSL2 bind mounts it confers no filesystem protection — the mount is
`0777` and host files are owned by the invoking user."* Then state what actually bounds workspace
damage on Windows: SB3's ephemeral per-task worktree plus B-3's egress review. If §3 keeps a
"Non-root" row, its measured result must be the **permission** outcome, not the `id` output.

---

**B-7 — The SB0 startup refusal fires on every default install and cannot establish the property it
checks.**
*Evidence:* §5 — `profileResolver.ts:14` makes `terminal_power` the default profile for
`COMPLEX_CODING`, so it is "reachable" in every deployment including a fresh clone; and per M-1 a
boot-time `TERMINAL_ENV` check cannot establish a per-call value.
*Why blocking:* both failure directions at once — spurious brick, plus a false pass. It trains every
operator to set the permanent opt-out.
*Suggested fix:* (i) **Define "reachable"** precisely, e.g. *"a profile whose `allowedCapabilities`
include `exec` is resolvable for some task type given the current `DEFAULT_PROFILE_BY_TASK` and
session default."* (ii) **Do not refuse to start.** Refuse at **grant time**: the gateway declines to
resolve `terminal_power` (falling back to `workspace_write`, which is *narrower*, so
`resolveProfile`'s existing broadening check is untroubled) and emits a loud SYSTEM event. The
process still boots; every other capability still works; only the uncontained capability is
withheld. That is fail-closed **without** a bricked dev setup or a permanent opt-out flag. (iii) Keep
`TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` as an explicit per-session escape, logged on every use.
(iv) Move this item from SB0 to SB1, since its definition depends on SB1's policy.

---

**B-8 — SB4's egress allowlist does not deny the host, so a contained agent could reach the gateway
that contains it.**
*Evidence:* E-7, demonstrated — with any network attached, `host.docker.internal:8787` returns
`ConnectionRefused` (host routable) and `1.1.1.1:53` is reachable. Docker Desktop injects
`host.docker.internal` automatically.
*Why blocking:* the gateway is the component that issues grants and owns the sandbox policy. Reaching
it from inside the sandbox is a privilege-escalation path, and SB4 as written permits it.
*Suggested fix:* Specify SB4's allowlist as **destination-address-denying first**: deny
`127.0.0.0/8`, `::1`, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), `169.254/16`, and
`host.docker.internal` **before** any allow rule; run the proxy on a dedicated Docker network with
`--add-host host.docker.internal:127.0.0.1` neutralised; and add an acceptance criterion that a
contained task cannot reach the gateway or the Hermes engine, **proven by executing a real
container** (mirroring SA-3's standard).

---

**B-9 — Three acceptance criteria are satisfiable by assertion (SA-4, SA-5, SA-6).**
*Evidence:* §8. SA-4's "simulates the failure" passes with a mock while the real fallback branch
(`terminal_tool.py:1237`) is untested. SA-5 is a universal negative reduced by TS-6 to one prompt.
SA-6 contradicts backend defaults (`TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES=true`, `task_id`
collapse to `"default"`).
*Why blocking:* this repo's recorded recurring defect is the unenforced claim, and the same author's
prior amendment was rejected for it (PRD-005 §9b line 390).
*Suggested fix:*
- **SA-4:** require the Docker-unavailable test to run against the **real backend** with docker
  genuinely unreachable (e.g. `DOCKER_HOST` pointed at a dead endpoint), asserting the task is
  REFUSED and that **no `_LocalEnvironment` was constructed** (assert on the instantiated class, not
  the error string).
- **SA-5:** enumerate the widening **channels** rather than asserting a universal negative — prompt,
  task field, model output, **env var (B-5)**, per-task override registry
  (`terminal_tool.py:952`), and MCP tool args — and require one probe per channel.
- **SA-6:** require the test to assert **two distinct container IDs** for two concurrent tasks, and
  explicitly pin the `persist_across_processes=false` / non-collapsing `task_id` configuration that
  makes it true.
- Extend §7's mutation obligation ("guard reverted → RED → restored → GREEN") to **every** SA, not
  just those with a natural RED.

---

## 11. Non-blocking notes

1. **Credit where due, and it is substantial.** §3's measure-don't-assume method, the MSYS
   observation, the correct A6/T-9 citation, SA-3's "real container, not a config value," SB5's
   `cross_profile` removal, and §8's refusal to treat the off-switch as a rollback are all genuinely
   good and above this repo's average. My rejection is about the gap between §3's bench measurements
   and the code path §5 must drive — not about rigor of intent.
2. §1 says `TERMINAL_ENV` "defaults to `local`" — accurate (`terminal_tool.py:1073`), but the
   important property is that it is **re-read per call**, which changes what enforcement must look
   like. Worth stating in §1.
3. §4's `.dockerignore` bullet governs the image build; it does not affect `.git` inside the
   bind-mounted workspace (E-4). Two different `.git` exposures — worth disambiguating.
4. §5 SB3's parenthetical about `.torq/worktrees/` being dev artifacts is correct and I verified no
   product code creates them. Good defensive note; keep it.
5. §9 OQ-1: I agree with the recommendation (build a TorqClaw-specific pinned image). Add: who
   rebuilds on CVE, and does a stale digest fail closed?
6. `capability.ts` `P4_EXEC` omits `'process'` with a documented rationale, yet `approval_hook.py:23`
   **does** gate `process`. Divergent tier semantics — not this PRD's problem, but SB5's
   "extend LOCAL_EDGE's seam to FRONTIER" will collide with it.
7. `--memory` without `--memory-swap` allows swap beyond the limit; and disk quota is silently
   skipped on this host (`docker.py:564-571`). Consider `--memory-swap` equal to `--memory`.
8. Consider a `--security-opt seccomp=<profile>` row. The host reports a builtin seccomp profile
   (§3), but the PRD never pins it, and `docker.py` never passes one.
9. SB3 on Windows needs a **measurement** before commitment (§6). A per-task `git worktree` of this
   monorepo across the WSL2 boundary may be slow enough to sink adoption.
10. Consider stating explicitly that **bridge MCP servers run on the host and are outside the
    sandbox** (E-6), so the boundary's shape is not left to inference.

---

## 12. Final verdict

# REJECT

**Fix B-1 through B-9, then re-submit for Gate-1.**

The threat model is right and the slicing is sound — this document is worth revising rather than
restarting. But as v0.1 it would ship a boundary with at least four demonstrated ways through it
(host-execution via the workspace, host credentials bind-mounted in, argv injection via
`TERMINAL_DOCKER_EXTRA_ARGS`, and a gateway reachable the moment egress is enabled), while §3's
measured-control table would tell the operator all eight controls were verified on this host. Four of
those eight are not delivered by the code path the PRD commits to.

That combination — real measurements, taken at the wrong layer, presented as coverage — is precisely
the "reads rigorous, contains one unaddressed escape vector" failure the brief warns about. Here it is
not one vector; it is four demonstrated and several more unaddressed.

The good news is that none of the nine blockers requires abandoning the design. B-2's fix already
exists in TorqClaw-owned code (`approval_hook.py`'s `pre_tool_call` seam), and the rest are
specification work — reconciling §3 with the real backend, denying the host in SB4, defining
"reachable," and tightening three criteria. This can be a strong PRD in one revision.

---

*Reviewed by G1R (`claude-opus-5`), 2026-08-17. No files modified except this review. No commits, no
push. All Docker experiments used `--rm`; no Docker socket was mounted; all probe artifacts removed;
no operator files or containers touched.*
