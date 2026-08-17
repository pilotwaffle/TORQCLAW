# PRD-TCLAW-AGENT-SANDBOX-006 — Container containment for agent execution

**Status:** v0.3 — **DRAFT, pre-Gate-1 (second re-review).** Not authorized for implementation.
**Date:** 2026-08-17 · **Author:** G1D (`claude-fable-5`)
**Supersedes:** v0.2, **REJECTED at Gate 1** by fresh Opus 5 G1R with 4 blockers
(`docs/prd-reviews/G1R-OPUS-AGENT-SANDBOX-006-GATE1-V2.md`, commit `5748693`).
v0.1 was **REJECTED** with 9 blockers (`…-GATE1.md`, commit `9a9aa1c`).
**Predecessor finding:** `docs/security/agent-execution-isolation-audit.md` — established there is no sandbox today.
**Operator ruling folded in:** 2026-08-17, see §2. Nine directed corrections, P0/P1/P2.
**Landed since v0.2:** commit `72b4d36` — the N-1 fix. See §1.

---

## 0. What changed from v0.2, and the rule this document has now broken twice

**v0.1's failure.** §3 claimed eight container controls "measured on this host, not assumed." The
commands were really executed — **as hand-typed `docker run` flags**. The code that actually runs is
`engines/hermes_kernel/vendor/hermes-agent/tools/environments/docker.py`. **I measured a bench
reproduction of the artifact instead of the artifact.**

**v0.2's failure, and it is the more instructive one.** v0.2 adopted an evidence rule requiring a
`file:line` per control — and was rejected anyway, because its **two most load-bearing claims cited a
line without the branch condition enclosing it**:

- §1 claimed the gateway "already refuses **every** FRONTIER granted run" citing `dispatch.ts:262` —
  the **call** site. The **predicate** (`:494-497`) was `&& collabEnabled()`, and that flag defaults
  **off**. A real refusal, unreachable by default.
- §9 item 4 claimed "the default workspace is **tmpfs**" citing `docker.py:626` — a line that sits
  inside the `else:` of `if self._persistent:` (`:610`), where persistence defaults **True** at two
  independent points. A real tmpfs, in the branch nobody runs.

**Both errors resolved in the document's favour.** One told the operator a hole was closed when it
was open; the other told them a default-on host-execution channel was opt-in. That direction is not
a coincidence — it is what confirmation pressure looks like in a document arguing for its own thesis.

> **§3 evidence rule, v0.3 (strengthened).** A claim about runtime behaviour must cite:
> **(a)** the `file:line` that emits it; **(b)** *every* branch condition enclosing that line; and
> **(c)** the **default value** of each variable in those conditions, with its own `file:line`.
> A `file:line` proves code **exists**. Only (a)+(b)+(c) proves code **runs**.
> A row lacking any of the three is **not** a verified control and must be marked `UNVERIFIED`.
> No row may be supported by a hand-typed command.
>
> **Corollary — adversarial direction.** Check hardest when a finding resolves in this document's
> favour. Both v0.2 errors flattered it. A claim that reduces the apparent work is the claim most
> likely to have skipped step (b).

**Deliberately still `UNVERIFIED` in v0.3** (asserting them would repeat the same error):
§9 item 4's scanner path list; §9 item 7's seccomp interpreter-blocking feasibility; §6 SB3's Windows
9p/virtiofs measurement. Each is marked and **no acceptance criterion consumes any of them.**

**Formerly `UNVERIFIED`, now structurally quarantined:** §9 item 8's registry/git egress-allowlist
feasibility. G1R correctly found that marking it was **not** enough — SA-15 consumed it directly while
§9 item 8 called SB4 a precondition for SB2. It is now an explicit **SB4 deliverable ordered before
SB2 is authorised**, with SA-15 **blocked** until the spike returns (§6 SB4, §7 SA-15, §6a).

---

## 1. The problem

TorqClaw's FRONTIER engine can be granted a `terminal_power` profile including `terminal` and
`code_execution`. These dispatch **inside the vendored Hermes loop** and **never traverse
`packages/bridge`**, so bridge path scoping has **no jurisdiction** (`toolFilter.ts:60` excludes
`sourceServerId === 'hermes'`; `checkPath` runs only inside `registry.executeTool:214-220`).

**The load-bearing property is not that `TERMINAL_ENV` defaults to `local` — it is that it is
re-read on EVERY tool call** (`terminal_tool.py:1073`, `:1878-1879`). The execution backend is
**per-call mutable state**, not a deployment fact. `check_terminal_requirements()` returns `True` for
`local` unconditionally (`:2462-2463`) and `_create_environment` returns `_LocalEnvironment` as its
**first** branch (`:1237-1238`). The wrapper sets `TERMINAL_ENV` **nowhere** (zero hits across
`mcp_wrapper/`).

### 1a. The FRONTIER fence — TRUE current baseline (corrected; N-1)

**v0.2 asserted this fence "already refuses every FRONTIER granted run." That was FALSE at the time
of writing.** The predicate carried `&& collabEnabled()`, and `collabEnabled()` reads
`TORQCLAW_COLLAB_ENABLED` with **no default** (`principalBridge.ts:71-73`:
`TRUTHY.has((process.env.TORQCLAW_COLLAB_ENABLED ?? '').trim().toLowerCase())` → `false` when unset),
with no `COLLAB` line in `.env.example`. Meanwhile the legacy `APPROVE_TOOL` branch minted a granted
request and dispatched it with **no tier check**. A name-only FRONTIER grant executed, by default.

**This was fixed in code on 2026-08-17 by commit `72b4d36`, as its own slice, deliberately not
coupled to this PRD.** Verified in the working tree at the current HEAD, with the enclosing branch
read at every site:

| Site | `file:line` | Enclosing condition | Verified state |
|---|---|---|---|
| Fence predicate | `dispatch.ts:505-508` | *(none — a bare `function`)* | `diag.tier === ComputeTier.FRONTIER && (req.payload.grantedTools?.length ?? 0) > 0`. **`collabEnabled` is gone.** No flag, no env read. |
| Executor fence | `dispatch.ts:262-265` | inside `dispatchLegacy`, **before** the `isHermesAvailable()` check (`:269`) | calls `refuseFrontierGrantedRun` |
| Failover fence | `dispatch.ts:558-562` | inside the failover path, **before** `taskStore.create` and before the dynamic `failover.js` import | calls `refuseFrontierGrantedRun` |
| C2 `APPROVE_TOOL` | `server.ts:433-439` | inside `if (c2.kind === 'decided')` → `if (d.status === 'approved')`; **`decideApprovalC2` returns `legacy` when the flag is off** (`c2Broker.ts:197`) | refuses on `diag.tier === FRONTIER` before `dispatch` (`:443`) |
| **Legacy `APPROVE_TOOL`** | `server.ts:489-495` | inside `if (cmd.data.decision === 'APPROVE')` (`:474`) — **the default-configuration path** | refuses on `diag.tier === FRONTIER`, **before** the `ROUTING` emit (`:497`) and **before** `dispatch` (`:499`) |

**Regression guard:** `tests/frontier-grant-fence-unconditional.test.ts`, 8 assertions across all
three flag states (unset / `true` / `false`). The **unset** case is load-bearing: a test that only set
the flag to `true` would have passed against the broken code. The suite also pins the premise
(`collabEnabled()` is `false` when unset) so the severity analysis fails loudly if that default
changes. `72b4d36`'s message records both mutation probes executed with RED observed.

**Consequence for SB5 — v0.2 had this backwards.** v0.2 said SB5 "retires an existing fence." When
v0.2 was written, no fence was reachable by default, so SB5 would have had to **build** one. As of
`72b4d36` a fence exists and is **unconditional**. So the honest statement is neither of v0.2's:

> **SB5 does not retire the fence and does not build it. SB5 must EXTEND it** — replacing a
> blanket tier-level refusal with an **argv-scoped admission**, so that the *only* FRONTIER grants
> that execute are ones whose argv was bound at approval time. The fence's current form is
> "refuse all"; SB5's form is "refuse all except an exact-argv match." **The refusal must remain the
> default arm.** Any SB5 design in which the FRONTIER refusal becomes *conditional* on a flag,
> a config value, or an ambient property re-creates N-1 for a fourth time — the doc comment at
> `dispatch.ts:481-489` records that this exact mistake has now been made three times.

**Therefore:** the exact-action hole **is** closed today — but by `72b4d36`, **not** by anything
v0.2 described, and it was **open when v0.2 claimed it was closed.** The capability is withheld;
this PRD's job is to make granting it *provable*.

### 1b. What is NOT inside the boundary (E-6)

**`packages/bridge`'s MCP servers run ON THE HOST, OUTSIDE the sandbox.** The registry launches
stdio servers with `new StdioClientTransport({ command, args })` (`registry.ts:135`) — a host
process spawn, unconditional, with no container involvement anywhere in `packages/bridge`. A
`terminal_power` task can therefore hold host-side namespaces (e.g. `desktop_commander`) **in the
same profile** as a contained `terminal`. Containing `terminal` while a host-side desktop-automation
namespace is grantable beside it is **a boundary with a door next to it**. Bridge path scoping (§6
SB0) is the only control on that door, which is why SB0 ships despite delivering zero mitigation for
`terminal` itself.

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
   downgraded to host execution. **N-3 extends this:** fail-closed is a property of the *seam*, not
   of the *checker*. A verifier that fails closed through a seam that swallows exceptions fails open.
4. **Guards never relax on believed containment** (§9 item 3).
5. **Per-call, not per-boot:** a boot-time check is necessary but **never sufficient** for any property
   read per call.
6. **A security refusal that a feature flag can switch off is not a refusal.** *(Added in v0.3 from
   N-1 and `72b4d36`'s doc comment.)* This applies to `TORQCLAW_COLLAB_ENABLED`, and to every future
   gate placed in front of a refusal.

---

## 3. What the real backend emits (re-measured against the emitter, with enclosing branches)

Source: `engines/hermes_kernel/vendor/hermes-agent/tools/environments/docker.py`.
`_BASE_SECURITY_ARGS` = `:327-336`; `_build_security_args()` = `:355`.

**Reachability column added in v0.3.** Per the strengthened rule, a row is only a verified *control*
if its enclosing branch is entered under the shipped defaults.

| Control | Emitted? | Emitter | Enclosing branch + default | Reality |
|---|---|---|---|---|
| Drop capabilities | **YES** | `:328` | unconditional (`_BASE_SECURITY_ARGS`) | `--cap-drop ALL` |
| Re-added caps | **YES** | `:329-331` | unconditional | `DAC_OVERRIDE`, `CHOWN`, `FOWNER` re-added — **not a clean ALL-drop** |
| Privilege escalation | **YES** | `:332` | unconditional | `--security-opt no-new-privileges` |
| PID limit | **YES** | `:333` | unconditional | `--pids-limit 256` |
| `/tmp` noexec | **NO — deliberate** | `:334` | unconditional | `rw,nosuid` **exec allowed**, documented `:326`: *"needed by pip/npm builds"* |
| `/var/tmp` noexec | **YES** | `:335` | unconditional | `rw,noexec,nosuid` |
| `/run` noexec | **YES, conditional** | `:342-343` | s6-overlay image detection (`:338-341`) | `noexec` default; **`exec` variant for s6 images** (else exit 126 at `/init`) |
| Privilege-drop caps | Conditional | `:350-351` | `_build_security_args:365-367`, added only when **not** `run_as_host_user`; `docker_run_as_host_user` defaults `"false"` (`terminal_tool.py:1175`) → **added by default** | `SETUID`/`SETGID` |
| `--read-only` rootfs | **NO** | — | — | **Never emitted anywhere** (`grep -c "read-only"` → 0). G1R correct. |
| `--user` | **Conditional, never here** | `:733` | `if run_as_host_user` (`:730`); default `false` (`terminal_tool.py:1175`); and `_resolve_host_user_spec()` **returns None when `os.getuid` is absent** (`:423-426`) | **never emitted on native Windows**, and not emitted by default anywhere |
| `--network=none` | **YES, when asked** | `:573` | `if not network:` (`:572`) | the flag exists; G1R read the parameter default, not the emitter |
| Memory / CPU | **YES** | `:561`, `:563` | `if cpu > 0` / `if memory > 0`; defaults `1` and **`5120`** MB (`terminal_tool.py:1229`) | `--cpus`, `--memory` |
| `--memory-swap` | **NO** | — | — | **Never emitted.** `:562-563` emits `--memory` alone, so **swap exceeds the memory limit**. See §9 item 10 — closed as a control, not deferred. |
| Disk quota | **SILENTLY SKIPPED** | `:564-571` | `if disk > 0 and sys.platform != "darwin"` → `if self._storage_opt_supported()` **else warn** (`:568-571`) | requires overlay2-on-XFS-with-pquota; **not satisfied on Docker Desktop/WSL2** — warns and continues |
| **`/workspace` — DEFAULT** | **HOST BIND MOUNT** | **`:618-622`** | `if self._persistent:` (`:610`) → `if not bind_host_cwd and not workspace_explicitly_mounted:` (`:617`). `self._persistent = persistent_filesystem` (`:538`) ← `persistent_filesystem=persistent` (`terminal_tool.py:1251`) ← `persistent = cc.get("container_persistent", True)` (**`:1231`, default True**) ← `TERMINAL_CONTAINER_PERSISTENT` default **`"true"`** (**`:1172`**). **Two independent True defaults.** | `-v {TERMINAL_SANDBOX_DIR}/docker/{task_id}/workspace:/workspace` — **a writable host directory** |
| `/workspace` — tmpfs | **YES, non-default** | `:626` | the **`else:` at `:623`** of the same `if self._persistent:` — **entered only when persistence is explicitly disabled** | `--tmpfs /workspace:rw,exec,size=10g` |
| **`/root` — DEFAULT** | **HOST BIND MOUNT** | **`:614-616`** | `if self._persistent:` (`:610`), **unconditional within it** — not even gated on `bind_host_cwd` | `-v {sandbox}/home:/root` — **a writable host directory, on every persistent run** |
| `/home`, `/root` — tmpfs | **YES, non-default** | `:629-630` | the **`else:` at `:623`** | `rw,exec` |
| `/workspace` ← host CWD | **Conditional** | `:634-636` | `if bind_host_cwd:` — `bind_host_cwd = auto_mount_cwd and …` (`:598-603`); `auto_mount_cwd` ← `docker_mount_cwd_to_workspace` ← `TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE` default **`"false"`** (`terminal_tool.py:1075`) | off by default; **when on, binds the LIVE REPO to `/workspace`** |
| Container labels | **YES** | `:799-801` | unconditional | `hermes-agent=1`, `hermes-task-id`, `hermes-profile` |
| Orphan reaper | **YES, partial** | `:172` | `_maybe_reap_docker_orphans` (`terminal_tool.py:876`), gated `if not container_config.get("docker_orphan_reaper", True)` (`:897`, **default on**) and once-per-process (`:901`) | `filters = [label=hermes-agent=1, status=exited]` — **`status=exited` only, so live orphans are never swept** |
| Container **reuse** probe | **YES** | `:1122-1148` | `_find_reusable_container`, called under `persist_across_processes` (default **True** at two points: `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES` default `"true"` at `terminal_tool.py:1183-1185`, and `cc.get(..., True)` at `:1259`) | **A DIFFERENT MECHANISM** — see the miscitation note below |
| Credential files | **MOUNTED `:ro`** | `:648-672` | `try:` around the `credential_files` import; no opt-out flag | Host OAuth/credential files mounted into every container |
| Skills tree | **MOUNTED `:ro`** | `:675-692` | same | Host skills directory |
| Cache dirs | **MOUNTED `:ro`** | `:695-716` | same | Host documents/images/audio/screenshots |
| `docker_extra_args` | **UNVALIDATED, and LAST** | `terminal_tool.py:1096` + `docker.py:769-774`, assembled `:776-784` | unconditional; `:770-773` filters only **non-string** entries and appends every string verbatim | **`validated_extra` is concatenated LAST (`:783`), after `security_args` (`:777`)** — so a duplicate user flag **overrides a security flag**. The ordering is part of the vulnerability. |
| Docker socket | **NEVER MOUNTED** | — | — | Verified absent; `file_tools.py:292` lists it as a blocked path. **Credit — keep as explicit non-goal.** |

### 3a. Corrections carried forward and newly made

**Corrections to v0.1 §3 (retained):** the eight-row "measured" table is **withdrawn**. `--read-only`
and Windows `--user` were **false claims**. `noexec` on `/tmp` was never a backend behavior and is a
**deliberate tradeoff**, not an oversight.

**Corrections to the first G1R's B-1 (all three re-verified by the second G1R as CORRECT — retained):**
`--network=none` **is** emitted (`:573`); **labels and a reaper already exist** (`:799-801`, `:172`);
`/tmp` exec **is** a documented tradeoff (`:326`, `:334`) and `/var/tmp` **is** `noexec` (`:335`).

**Correction to v0.2 — the workspace rows (N-2).** v0.2's `/workspace` row and its §9-item-4
"SCOPE CORRECTION" were **wrong**. The default is a **host bind mount**, at `/workspace` **and**
`/root`. Both are corrected above with both branches and their reachability. **The claim "E-2 is real
but opt-in" and the recommendation "the primary fix is never enabling that mode" are DELETED** — the
mode is on by default, so that recommendation was a **no-op**.

**Correction to v0.2 — the reaper miscitation (MC-2).** v0.2 cited the reaper as `:172-178` **and**
`:1139-1142`. The `:172` half is correct and load-bearing (`status=exited` only). **`:1139-1142` is
NOT the reaper** — it is inside `_find_reusable_container` (`def` at `:1122`), the cross-process
**attach/reuse** probe. **The two have different security meaning:** the reaper is a *cleanup* path
whose gap leaves live orphans running (SB6/SA-14); the reuse probe is an *attach* path that makes
SA-6's container-sharing problem real (a new task attaching to a container a previous task's agent
wrote to). Citing one as evidence for the other conflates a hygiene failure with a cross-task
isolation failure.

**Correction to v0.2 — the guard-skip miscitation (MC-3).** v0.2 cited `approval.py:1595-1598`. The
skip is `:1597-1598`; `:1595-1596` are a comment. Trivial as an offset, recorded because §3's rule
makes line precision this document's own standard.

**Correction to v0.2 — the DoS arithmetic.** v0.2 SB6 said "at `--memory 512m` each." The default is
**5120 MB** (`terminal_tool.py:1229`), so the host-DoS figure understated itself **10×**. Corrected
in §6 SB6.

### 3b. The default sandbox is ONE SHARED host-bound directory

Composing two verified defaults:

- **Persistence defaults on** → `/workspace` and `/root` are host bind mounts under
  `{sandbox}/docker/{task_id}/` (`docker.py:610-622`).
- **`task_id` collapses to `'default'`** — `effective_task_id = _resolve_container_task_id(task_id)`
  (`terminal_tool.py:1885`), documented verbatim at `:1881-1884`: *"By default all subagent task_ids
  collapse back to `default` so the top-level agent and every `delegate_task` child share one
  container; only task_ids with a registered env override (RL benchmarks) get isolated sandboxes."*

**Therefore, by default, the top-level agent and every `delegate_task` child share ONE host-bound
directory pair** — `~/.hermes/sandboxes/docker/default/workspace` and `.../default/home` — **and,
via `persist_across_processes` (default True, `terminal_tool.py:1259`) plus `_find_reusable_container`
(`docker.py:1122`), one container across processes.** This is simultaneously:

- the **E-2 host-execution channel**, open by default (§5);
- the **cross-task isolation failure** SB3 exists to fix, present in a worse form than SB3's absence
  would suggest — not "no isolation yet" but "a shared mutable surface that persists across
  processes";
- and the reason `TERMINAL_SANDBOX_DIR` (`environments/base.py:87`) belongs in SA-5's channel list —
  it **relocates the bind source**.

### 3c. What survives the flag set anyway (G1R, demonstrated on this host)

Live experiments, all `--rm`, no socket mounted:

- **E-2** `/workspace/.git/hooks/post-checkout` planted from inside a container running
  `--read-only --network none --cap-drop ALL --user 65534` landed **host-side `-rwxr-xr-x` owned by
  the operator**. Next host `git checkout` / `pnpm install` / build / test **executes it as the
  operator**. **Reachability, corrected in v0.3: the host bind is the DEFAULT** (`:610` → `:618-622`,
  `:614-616`), so **E-2 is default-on.** The second G1R independently reproduced both E-2 and a
  persisting `escape -> /etc/passwd` symlink against a host-bind `/workspace` on this host.
- **E-13** `--user 65534` gave **zero** filesystem protection on a Windows bind mount: container
  **overwrote a host-created file**, mount presented `drwxrwxrwx`, host files owned by the operator.
- **E-8** `noexec` bypassed trivially: exec bit denied, but `python3 x.py` and `sh x.sh` both ran; the
  default image (`terminal_tool.py:1072`) ships both.
- **E-7** `--network none` isolation genuine; **attach any network and `host.docker.internal:8787`
  returns ConnectionRefused — host routable.** Re-confirmed by the second G1R:
  `host.docker.internal` resolves to `192.168.65.254` from a networked container.
- **E-6** *(new in v0.3, §1b)* — bridge MCP servers are **host processes** (`registry.ts:135`),
  outside any container, grantable in the same `terminal_power` profile.

---

## 4. Container posture (from the `container-audit` checklist)

Digest-pin the image (`FROM …@sha256:…`) — the default is a **moving tag**
(`terminal_tool.py:1072`, `nikolaik/python-nodejs:python3.11-nodejs20`) and `TERMINAL_DOCKER_IMAGE`
is an **unvalidated env var** (`terminal_tool.py:1144`), so the pin must be enforced **at call time**
or it is documentation. Minimal base; non-root `USER` baked in; no SUID; `.dockerignore` excluding
`.git`/`.env`/`*.pem`/`.ssh`/`.aws` **(note: this governs the IMAGE BUILD and does nothing about
`.git` inside a mounted workspace — two different exposures, and per §3b the mounted workspace is the
default)**. **No secrets via `--build-arg`, env, OR bind mount** — the mount set is a **closed
allowlist verified at container start** (§9 item 4b). Resource limits mandatory, **including
`--memory-swap`** (§9 item 10). Image scanning in CI.

---

## 5. Threat model for the workspace consumer

v0.1 never asked **who reads the workspace afterwards, and with what privilege.** That omission is
what made E-2 invisible. v0.2 asked it, then mis-scoped the answer to a non-default mode.

**Model:** container output is **untrusted input to the host toolchain.** The host runs `git`,
`pnpm`, `turbo`, `vitest`, `uv`, and an IDE indexer over any directory the sandbox wrote. Several
execute file content **by design**: `.git/hooks/*`, `package.json` lifecycle scripts,
`node_modules/.bin/*`, `vitest.config.ts`, `conftest.py`, `sitecustomize.py`, `.envrc`, `Makefile`,
`.pre-commit-config.yaml`, `.vscode/tasks.json`. **In a repo whose gates are `pnpm test` / `pnpm
build`, writing `vitest.config.ts` buys host execution at the next gate run.**

**Consequence:** confinement of the *container* is insufficient. The **egress path of data** must be
controlled too (§9 item 4). **And because §3b establishes the host bind is the default**, this is not
a hardening item for an opt-in mode — it is a live channel in the shipped configuration.

**Second consumer, easily missed:** `/root` is *also* a host bind by default (`:614-616`). Shell
history, `.bashrc`, `.profile`, `.gitconfig`, `.ssh/config`, `.npmrc` written there persist to the
host directory and are read by the **next container** that attaches — including one belonging to a
different task, since `task_id` collapses (§3b). The workspace consumer is not only the host
toolchain; it is also **the next agent**.

---

## 6. Slices

Flag-gated, independently shippable, reversible. **A6/T-9 apply in full to every new wire command**
(`docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` §6/§8).

**Stated plainly:** **SB0 hardens `packages/bridge` — the path §1 says the dangerous tools NEVER
traverse. SB0 delivers ZERO mitigation for the motivating threat.** It is independently valuable and
ships first because it is cheap and correct, and because per §1b the bridge is the *only* control on
the host-side MCP door beside the sandbox — not because it addresses `terminal`.

### 6a. Ordering (resolves the v0.2 contradiction)

v0.2 contained a genuine contradiction: §9 item 8 called SB4 **"a precondition for SB2's
adoptability"** while §6 shipped SB4 **after** SB2 and SB2a. **Resolved in favour of item 8**, which
is the load-bearing claim — if `pnpm install` fails on the first real `COMPLEX_CODING` task,
`TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` becomes permanent and the whole program is wasted.

**Authoritative order:**

```
SB0  (independent — bridge hardening; zero terminal mitigation)
SB1  (independent — gateway-owned execution policy)
[N-1 unconditional FRONTIER grant refusal — ALREADY LANDED, 72b4d36; not a slice]
SB4-spike  (registry/git egress-allowlist FEASIBILITY — a DELIVERABLE, gates SB2's authorisation)
SB6-audit  (the audit log half of SB6 — MUST precede SB2's acceptance so SA-13 has ground truth)
SB2  +  SB2a          (PEERS, both P0 — SB2a is not a predecessor of SB3, it is a peer of SB2)
      +  SB4's fetch path
SB2b (guard-relaxation removal — BLOCKED ON OQ-4 OPERATOR RULING)
SB3  (BLOCKED on SB2a AND on the Windows 9p/virtiofs measurement)
SB5  (argument-scoped grants — EXTENDS the 72b4d36 fence; see §1a)
SB6  (remainder — lifecycle, limits, reaper)
```

**Why SB2a is now a P0 peer of SB2, not a P1 predecessor of SB3 (N-2 consequence).** SB2a was ordered
as a predecessor of SB3 on the belief that E-2 was opt-in. E-2 is **default-on** (§3b). SB2 without
SB2a delivers containment of the *process* while leaving the **default host-bind egress channel wide
open** — which is precisely the "confinement of the container is insufficient" conclusion §5 reaches.
Shipping SB2 alone would produce a container that cannot reach the network and cannot escape its
namespaces, and can still drop `vitest.config.ts` into a directory the host's `pnpm test` executes.
**That is not a sandbox; it is a sandbox-shaped audit finding.**

### SB0 — bridge hardening (no container; zero mitigation for terminal/code_execution)
- **Symlink resolution** — `pathScope.normalizePath` uses `path.resolve()`, **purely lexical**; there
  is **no `realpath`/`lstat`/`readlink` in `packages/bridge`** and **zero symlink tests**. Resolve the
  containing directory for creates. **Must cover Windows junctions and reparse points.**
- **Fail-closed allowlists** — an empty `write` allowlist currently means **unconstrained**
  (`pathScope.ts:44`, `if (allow.length === 0) return null; // no allowlist for this mode =
  unconstrained` — fail-OPEN; G1R confirmed by execution against `dist/pathScope.js`). Invert to
  deny, behind a flag, with a migration note.
- **Schema-driven path extraction** — replace key-name guessing with the tool's declared JSON Schema;
  keep the heuristic as fallback and **log when it fires** (`COMMON_PATH_KEYS` `:54-57` omits
  `outputPath`; G1R confirmed `extractPaths({outputPath})` returns `[]` today — invisible to scoping).

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

**Blast radius, restated under the true baseline (B-7 / N-1).** v0.2 scoped SB1 on the belief that
granted FRONTIER runs were already refused — a belief that was false when written and true only since
`72b4d36`. SB1's rule is **still a live behaviour change**, because the `72b4d36` fence refuses only
*granted* FRONTIER runs (`grantedTools.length > 0`); an **ungranted** FRONTIER `COMPLEX_CODING` task
resolving `terminal_power` (`profileResolver.ts:14`) is unaffected by it and executes `terminal` on
the host today via the engine's own toolset. SB1 makes that profile unresolvable. **Every
`COMPLEX_CODING` task is in scope.** That is the change to stage and measure, not a formalisation of
the status quo.

### SB2 — verified containment (the containment itself)
Container launched with the §3 profile **plus the gaps closed**: `--read-only` supplied by the
wrapper, `--network=none`, `--memory-swap` equal to `--memory`, resource limits, digest verified **at
call time**, and the **mount set asserted against a closed allowlist** by parsing `docker inspect`
Mounts and refusing on any unexpected source. **Credential / skills / cache mount families disabled**
(§9 item 4b). **Persistence and the host binds it creates are disabled** — SB2 sets
`container_persistent` false *and* asserts the absence of `/workspace` and `/root` host binds in
`docker inspect`, because per §3b setting the value is a config assertion and asserting the mount is
the control. **Containment is proven per call, in the `pre_tool_call` hook**
(`mcp_wrapper/approval_hook.py:67-125` — TorqClaw-owned, registered programmatically at `:131-144`
with no vendor edit, already proven for the approval gate). **Fail closed:** cannot establish
containment → refuse. **Never** falls back to host execution.

#### SB2 — the hook body MUST be total (N-3, and this is the most important requirement in the PRD)

**The designated fail-closed seam fails OPEN today.** Verified at four sites, all in vendored code:

| Site | `file:line` | Behaviour on a raised exception |
|---|---|---|
| Hook dispatcher | `hermes_cli/plugins.py:1673-1685` | `for cb in callbacks: try: … except Exception as exc: logger.warning(...)` then `return results` — **the throw produces no block directive and the loop continues** |
| Legacy runtime helper | `agent/agent_runtime_helpers.py:1670-1683` | `try: block_message = get_pre_tool_call_block_message(...) except Exception: pass` → `block_message` stays `None` → **tool executes** |
| Tool executor (path A) | `agent/tool_executor.py:345-358` | `except Exception: block_message = None` → **tool executes** |
| Tool executor (path B) | `agent/tool_executor.py:836-849` | `except Exception: pass`, `_block_msg` stays `None` → `_execution_blocked` False → **tool executes** |

*(v0.2's reviewer identified two of these four. The two `tool_executor.py` sites are additional and
behave identically. The count is four, not two.)*

`plugins.py:1653-1654` documents the intent: *"Each callback is wrapped in its own try/except so a
misbehaving plugin cannot break the core agent loop."* **That is correct for an OBSERVER hook and
wrong for a SECURITY hook** — and SB2 makes it a security hook. `:1870-1871` doubles down: *"Invalid
or irrelevant hook return values are silently ignored."*

**The failure modes are SB2's own workload, not hypotheticals.** Verifying containment per call means
shelling out to `docker inspect` to confirm the container is alive, the digest matches, and the mount
set is the allowlist. Every one of those raises: `subprocess.TimeoutExpired` (daemon wedged),
`OSError` (daemon down / `DOCKER_HOST` unreachable), `json.JSONDecodeError` (truncated output),
`KeyError` (Docker API schema change). **In every one of those cases, as the code stands, the
exception is logged at WARNING and the terminal command executes on the host** — the exact silent
downgrade §2 corollary 3 forbids.

**Requirement, normative:**

> **SB2's `pre_tool_call` containment check MUST be TOTAL.** The entire check — every subprocess
> call, every parse, every comparison — is wrapped in the hook's own
> `try/except BaseException`, and the `except` arm **returns `{"action": "block", "message": …}`**.
> An unverifiable containment state is expressed as a **RETURNED BLOCK**, never as a raised
> exception. `BaseException`, not `Exception`, so that `KeyboardInterrupt`/`SystemExit`/timeouts
> raised as `BaseException` subclasses cannot slip the arm.
>
> **The load-bearing constraint, which belongs in the spec and not in the implementer's memory:**
> **the vendored dispatcher swallows every exception a hook raises, at four independent sites, and
> proceeds with the tool call. Therefore the hook MAY NEVER RAISE.** Raising is not "fail closed"
> here; raising is **fail open**. There is no vendored change in SB2's scope that fixes this — the
> totality has to live in TorqClaw's own hook body, which is the one place the wrapper owns.
>
> **Corollary:** the hook must also never return a malformed directive. `plugins.py:1890-1898`
> requires `result.get("action") == "block"` **and** a non-empty `str` message; anything else is
> silently ignored (`:1870-1871`). A block with an empty message is not a block.

**Proven by SA-16**, which forces the verifier to raise for real. Discharged under §8 with recorded RED.

### SB2a — workspace egress control (P0 PEER of SB2; re-scoped from default-on E-2)
Implements §5. **Copy-in / copy-out; never an RW host-workspace bind mount** (§9 item 4).

**Re-scoped in v0.3 (N-2).** v0.2 framed this as hardening an opt-in mode. Per §3b the RW host bind
is the **default**, at `/workspace` **and** `/root`, shared across every `delegate_task` child, and
persisting across processes. So SB2a's first line is not a hardening — it is **the removal of a live
default-on host-execution channel**, and it must land with SB2 or SB2 is not a containment slice.

- On exit, scan artifacts for anything **new + executable + in a path host tooling touches**; strip
  exec bits; reject out-of-tree symlinks (the second G1R reproduced a persisting
  `escape -> /etc/passwd` on this host); require explicit operator review before any host process
  consumes a sandbox workspace. **Scanner path list is `UNVERIFIED` — must be checked before it
  becomes a criterion.** SA-11 does not depend on the list: it names two concrete payloads.
- **`/root` is in scope too**, not only `/workspace` — per §5's second consumer.
- **Host-side defense-in-depth regardless of the sandbox:** `git config core.hooksPath` → empty dir
  for automation, and `pnpm install --ignore-scripts` by default in the pipeline.

### SB2b — guard-relaxation removal (**BLOCKED ON OQ-4 OPERATOR RULING**)
**Split out of SB2 in v0.3 (N-4).** SA-8 previously sat in §7 as a criterion against SB2 while §12
listed its mechanism as an operator stop condition. **A slice carrying a criterion that cannot be
built without discharging a stop condition is not an independently shippable slice.** SB2b now
carries SA-8 alone.

Scope: remove the believed-containment early returns so guards run regardless of backend. See §9
item 3 for the verified sites and §7 SA-8 for the probe. **See OQ-4 for the four candidate mechanisms
and their costs, and §9 item 3a for the measured result of the wrapper-only option.**

> **Stated plainly, because SB2's marketing depends on it: until OQ-4 is ruled and SB2b ships,
> believed containment still disables the command guards. SB2 alone does NOT close M-3.** SB2
> proves the container is real; SB2b is what stops the *belief* that a container is real from
> switching the guards off. A shipped SB2 with SB2b outstanding must say so in its release note.

### SB3 — per-task ephemeral workspace
Named volume or fresh clone per task, discarded after. **Blocked on SB2a** — a worktree is precisely
what the host toolchain operates on, so SB3 without SB2a makes E-2 worse.
*(`.torq/worktrees/` are **dev-process artifacts from prior build sessions, not a runtime feature** —
verified: no product code creates them; the second G1R re-confirmed.)*
**Note the true starting point (§3b):** SB3 is not adding isolation to a neutral baseline. The
default is **one shared host-bound directory across the top-level agent and every `delegate_task`
child**, reattached across processes. SB3 replaces a shared mutable host surface, not nothing.
**Windows measurement owed before commitment:** Docker Desktop bind mounts traverse a 9p/virtiofs
boundary with many-small-file penalties; a per-task worktree of this monorepo is exactly that
workload. **UNVERIFIED** — measure before committing, or SB3 becomes the reason the sandbox is
switched off.

### SB4 — egress control (**precondition for SB2's authorisation**, not optional polish)
Default `--network=none`. **Deny-first destination policy** (§9 item 6c): deny `127.0.0.0/8`, `::1`,
RFC1918 (`10/8`, `172.16/12`, `192.168/16`), `169.254/16`, and `host.docker.internal` **BEFORE any
allow rule**; run the proxy on a dedicated Docker network with `host.docker.internal` neutralised.
**Dependency fetch is a separate gateway-mediated step** — egress-allowlisted to package registries
and git remotes, results **cached** — so the sandbox stays offline **and builds still run** (§9 item 8).

**SB4-spike — an explicit DELIVERABLE, ordered BEFORE SB2 is authorised (v0.3, closing the quarantine
leak).** Marking the registry/git allowlist `UNVERIFIED` did **not** quarantine it, because SA-15 —
the criterion this PRD itself calls decisive — consumes it directly. The quarantine is now
structural:

- **Deliverable:** measure on this host whether pnpm's registry set (including transitive
  `resolved` hosts and any configured mirrors) **plus** `git fetch` over HTTPS to the configured
  remotes can be expressed as a proxy allowlist, and report the resulting host set, the cache hit
  behaviour, and the failure mode when a package resolves to an unlisted host.
- **Gate:** **SB2 is not authorised for implementation until the spike returns.** If the allowlist is
  not expressible, SB2's secure default is not adoptable and the program needs a different answer
  (vendored dependency cache, pre-warmed image, or an operator ruling accepting opt-in-only).
- **SA-15 is `BLOCKED` until the spike returns** and must not be scheduled, attempted, or reported as
  discharged before then.

### SB5 — argument-scoped grants (**the FRONTIER unlock**)
Extends LOCAL_EDGE's exact-action admission seam to FRONTIER so a grant binds to **argv**, not a tool
name. **Per §1a, SB5 EXTENDS the unconditional `72b4d36` fence — it neither retires nor builds it.**
The blanket "refuse all granted FRONTIER runs" becomes "refuse all except an exact-argv match," and
**refusal must remain the default arm**; any design making the refusal conditional on a flag or an
ambient property re-creates N-1 a fourth time. Terminal command allowlist/denylist covering at
minimum the destructive verbs `capability.ts` enumerates.
**Remove the model-controlled `cross_profile: true` opt-out** in `file_tools.py`, or make overriding
it operator-only — a guard the model can switch off is not a guard.
*Note: `capability.ts` `P4_EXEC` omits `process` by documented rationale while
`approval_hook.py:23-25` **does** gate it (the `_GATED` regex includes `process`) — divergent tier
semantics this slice will collide with.*

### SB6 — observability, lifecycle, limits
- **Audit log — ships BEFORE SB2's acceptance** (§6a), so SA-13 has ground truth to compare against.
  Container id, image digest, full flag set, mount set, and argv executed. Invariant 8 requires
  receipts from real telemetry; v0.1 recorded **nothing**, so an operator could not reconstruct what
  ran.
- **Kill / timeout** — `TERMINAL_TIMEOUT` (180s) bounds a **command**; nothing bounds the
  **container**. Add a task-level deadline, `docker kill`, and an operator abort.
- **Label + TTL reaper** — labels already exist (`:799-801`) and the reaper filters `status=exited`
  only (`:172`), so **live orphans are never swept**. Sweep past TTL **or** orphaned (task record
  gone). *This was a **live condition**: four `torq-console-verify` containers ran `Up 36h`, one of
  them an unauthenticated loopback credential proxy — see §9 item 9. The operator has since stopped
  all four; the second G1R corroborated `Exited (137)`. The gap in the reaper is unchanged.*
- **Volume cleanup** — `{TERMINAL_SANDBOX_DIR}/docker/<task_id>` grows unbounded, and per §3b
  `<task_id>` is usually the single literal `default`, so it is one directory that only grows.
- **Concurrency cap** — nothing caps concurrent sandboxes. **Corrected arithmetic:** `container_memory`
  defaults to **5120 MB** (`terminal_tool.py:1229`), not 512, so N concurrent tasks is an
  **N × 5 GB host DoS** — v0.2 understated this by 10×. Four concurrent tasks exhaust 20 GB. The
  limit is per-container, not per-host. **Pick a number and enforce it host-side**; the per-container
  `--memory` flag is not a host budget.
- **Post-hoc inspection** — retained logs and a workspace diff ("what did this task change"). SB3
  discards the worktree, **destroying the evidence**.

---

## 7. Acceptance criteria

**Every criterion must be proven by executing the real path** — a real container, the real backend,
the real argv. **No criterion may be satisfied by asserting a config value or mocking the backend.**
**§8's mutation obligation applies to EVERY criterion below**, not only those with a natural RED.

| ID | Slice | Criterion | Anti-assertion requirement |
|---|---|---|---|
| SA-1 | SB0 | Symlink inside an allowed dir pointing outside is **denied**; Windows junctions covered | Test must **fail against today's code** (no `realpath`/`lstat`/`readlink` in `packages/bridge/src`; zero symlink tests — RED is real) |
| SA-2 | SB0 | Empty write allowlist **denies**; heuristic path-extraction fallback **logs** | Prove `{outputPath}` is now visible to scoping (`COMMON_PATH_KEYS:54-57` omits it today; `pathScope.ts:44` is the fail-open) |
| SA-3 | SB2 | Contained task cannot write outside the workspace, read `~/.ssh`, or reach the network | **Real container executed**, not a config assertion |
| SA-4 | SB2 | Docker unavailable → `terminal_power` **refused** | Run against the **real backend** with docker genuinely unreachable (e.g. dead `DOCKER_HOST`); assert **no `_LocalEnvironment` was constructed** (on the class, not an error string) — `terminal_tool.py:1237-1238` is its first branch |
| SA-5 | SB1 | Policy cannot be widened | **Enumerate the CHANNELS, one probe each.** A universal negative over an infinite space is **not** a criterion. **Full list — see below.** |
| SA-6 | SB3 | Two concurrent tasks cannot observe or corrupt each other | Assert **two DISTINCT container IDs**, and **pin `persist_across_processes=false` + non-collapsing `task_id`** — today `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES` defaults **true** (`:1183-1185`, `:1259`) and subagent task_ids collapse to `'default'` (`:1881-1885`), so **concurrent tasks share one container** and `_find_reusable_container` (`docker.py:1122`) reattaches one across processes |
| SA-7 | SB5 | A grant for `terminal` does not authorize a different argv; `cross_profile` self-opt-out gone | Replay the approved hash against a **different** argv and observe refusal. **Also assert the default arm is still refusal with no argv match** — an SB5 that only proves the allow path re-opens N-1 |
| **SA-8** | **SB2b** | **Guards never relax on believed containment** | Force `env_type` to a container value with **no container present**; assert guards **still run** at **both live sites** — `check_all_command_guards` (`approval.py:1273`, skip `:1283`) and `check_execute_code_guard` (`:1570`, skip `:1597-1598`). *(`check_dangerous_command`, `:1037`/skip `:1052`, has **no production caller** — see §9 item 3 — so it is asserted for completeness, not as a live path.)* **BLOCKED ON OQ-4.** |
| SA-9 | SB2 | **The mount set contains NO host bind for `/workspace` or `/root`, and no credential, skills, or cache path** | **Real container**; enumerate `docker inspect` Mounts and assert the closed allowlist. **Disambiguated in v0.3 (AC-2):** host binds are **REFUSED, not expected**. Per §3b they are the *default*, so this criterion **must fail against today's configuration** — that is its RED. SB2 changes the default (SB2a's copy-in/copy-out); SA-9 asserts the change took effect at the container, not in config |
| SA-10 | SB4 | Contained task cannot reach the gateway, Hermes (`:8000`), or Ollama (`:11434`) **with a network attached** | **Real container on the egress network** — `--network=none` does not exercise this |
| SA-11 | SB2a | Sandbox-written artifacts cannot obtain host execution | Plant `.git/hooks/post-checkout` **and** `vitest.config.ts` **and** an out-of-tree symlink; assert all three are neutralised before any host tool runs. Depends on no `UNVERIFIED` list — three named payloads |
| SA-12 | SB1 | Gateway binds loopback only | **Regression guard** — `server.ts:159` already defaults `127.0.0.1`; this pins it |
| SA-13 | SB6 | Every container run is reconstructable from the audit log **and the log matches reality** | **Revised in v0.3 (AC-3):** asserting the record's *shape* is satisfiable by a faithful log of a **wrong** configuration. Required instead: for a real run, **compare the audit record's flag set and mount set field-by-field against the actual `docker inspect` output of the container it describes**, and fail on any divergence. RED: emit one flag into the log that was not passed to `docker run`, and observe the comparison fail. This tests the run, not the logger |
| SA-14 | SB6 | Orphaned/expired containers are swept **while running** | Existing reaper filters `status=exited` (`docker.py:172`) — assert a **live** orphan is reaped |
| **SA-15** | **SB4** | `pnpm install` and `git fetch` **succeed** in the secure default configuration | The adoption criterion — **if this fails, the control gets switched off and the work is wasted.** **`BLOCKED` until the SB4-spike returns** (§6 SB4). Must not be scheduled or reported before then |
| **SA-16** | **SB2** | **A containment verifier that FAILS is a BLOCK, never a permit** | **New in v0.3 (N-3).** Force the verifier to raise **for real** — monkeypatch the `docker inspect` subprocess call to throw, **or** point `DOCKER_HOST` at a dead endpoint so the inspect genuinely fails. Assert (i) the tool **did not execute**, and (ii) **no `_LocalEnvironment` was constructed** (on the class). Run it against **each of the four swallow sites** in §6 SB2's table, since each reaches the hook by a different caller. RED is guaranteed: today the throw is logged at WARNING (`plugins.py:1678-1684`) and the tool runs |

### SA-5 — the full channel list (AC-1)

SA-5's entire value is that the list is **closed**. v0.2's list was incomplete. Each channel gets its
own probe:

| Channel | Mechanism | Why it widens the boundary |
|---|---|---|
| Prompt | model-controlled text | — |
| Task field | request payload | — |
| Model output | tool args | — |
| MCP tool args | bridge call | — |
| Per-task override registry | `terminal_tool.py:952` `register_task_env_overrides` | bypasses global config |
| `TERMINAL_DOCKER_EXTRA_ARGS` | `terminal_tool.py:1096` → `docker.py:769-774`, appended **last** (`:783`) | **overrides security flags by ordering** |
| `TERMINAL_DOCKER_VOLUMES` | `docker_volumes` (`terminal_tool.py:1173`) | arbitrary host mounts |
| `TERMINAL_DOCKER_ENV` | `docker_env` (`:1174`) | env injection into the container |
| `TERMINAL_DOCKER_FORWARD_ENV` | `docker_forward_env` | **forwards host env, incl. secrets, into the container** |
| **`TERMINAL_CONTAINER_PERSISTENT`** | `:1172` → `docker.py:610` | **the single most security-relevant of the set — flips `/workspace` and `/root` between tmpfs and HOST BIND MOUNTS.** Default `"true"` = host binds |
| **`TERMINAL_SANDBOX_DIR`** | `environments/base.py:87` → `docker.py:611` | **relocates the bind SOURCE** — points the host bind anywhere on disk |
| **`TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE`** | `terminal_tool.py:1075` → `:1254` → `docker.py:598-603`, `:634-636` | **turns on E-2 against the LIVE REPO** rather than the sandbox dir |
| **`TERMINAL_DOCKER_IMAGE`** | `terminal_tool.py:1144` | **image substitution** — defeats the digest pin unless enforced at call time |
| **`TERMINAL_DOCKER_RUN_AS_HOST_USER`** | `terminal_tool.py:1175` → `docker.py:730-733` | changes uid semantics and suppresses the `SETUID`/`SETGID` privilege-drop caps (`:365-367`) |
| `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES` | `:1183-1185` → `:1259` → `docker.py:1122` | **cross-process container reattachment** |
| `TERMINAL_ENV` | `:1073`, `:1878-1879` | the backend itself, **re-read per call** |

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

**Added in v0.3, from `72b4d36`'s build record — a mutation that does not apply is not a probe.** An
earlier N-1 probe attempt reported GREEN because the mutation was applied by a script that never ran
(`python3` absent on this host), so the "restored" code was never actually broken. **A recorded RED
must be traceable to a verified change in the file under test** — re-read the file after mutating it,
or use a structured edit whose failure is loud. A green that follows a no-op mutation is worse than
no probe: it manufactures false confidence with a paper trail.

---

## 9. Operator ruling — the nine directed corrections (+ one added in v0.3)

**Operator caveat, load-bearing:** *"my assessment — I haven't audited the code this session, so treat
each fix as design guidance, not a patch."* Each item was therefore checked against the emitter **and
its enclosing branch** before being written here; **findings that changed an item are marked.**

### P0 — ship regardless of the sandbox

**1. Approval card shows the resolved command, not the tool name.**
Payload = post-expansion **argv** + cwd + network destinations. **Bind approval to an argument hash:
one approval = one argv.** Default-**DENY** classes (not "ask"): pipe-to-shell, base64-decode-then-exec,
and any command whose network targets are outside the task's declared egress list; override only via a
separate, deliberately harder flow.

**→ VERIFIED (transport):** `ToolApprovalRequired` **already carries `args`**
(`contracts/src/errors.ts:15`, ctor `:17-22`) and `APPROVE_TOOL` deliberately carries **no tool name**
so a client cannot widen a grant (`commands.ts:33-40`). **Transport is not the gap** — argv
*resolution*, *hash binding*, and *rendering* are.

**→ CORRECTED IN v0.3 (N-1).** v0.2 concluded from this that item 1 "is the UNLOCK for FRONTIER
`terminal`, not a hardening item," on the premise that `dispatch.ts:262` already refused every
FRONTIER granted run. **That premise was false when v0.2 was written** — the predicate carried
`&& collabEnabled()`, default off (§1a). The refusal became unconditional only with `72b4d36`.
**Restated:** item 1 is **both**. It is a hardening item on LOCAL_EDGE, where grants execute today.
And it is the unlock for FRONTIER, where the `72b4d36` fence now refuses *all* granted runs and SB5
**extends** that refusal into an argv-scoped admission (§1a). What it is **not** is a retirement of a
fence — that framing was an artifact of the false premise.

**2. `TERMINAL_ENV` → per-call policy in the gateway.** Capability set fixed at dispatch, read from
the task record; env vars advisory only. **PRD rule, verbatim: "ambient environment is never a
security boundary."** → SB1.

**3. Kill the containment relaxation — guards always apply.**
**Operator chose the inversion over a token scheme, and I agree:** the host-guard path and the sandbox
path are the **same code**; containment changes only **where** execution happens, never **whether**
guards apply. This makes M-3 **unrepresentable** rather than defended.

**→ VERIFIED, three sites, of which TWO are live.** All in vendored
`engines/hermes_kernel/vendor/hermes-agent/tools/approval.py`:

| Function | `def` | Skip | Skip set | Live caller? |
|---|---|---|---|---|
| `check_all_command_guards` | `:1273` | `:1283-1284` | `{"docker","singularity","modal","daytona"}` | **YES** — `terminal_tool.py:262` (via `_check_all_guards`), called at `:2053` |
| `check_execute_code_guard` | `:1570` | `:1597-1598` | `{"docker","singularity","modal","daytona","vercel_sandbox"}` | **YES** — `code_execution_tool.py:1104-1105` |
| `check_dangerous_command` | `:1037` | `:1052-1053` | `{"docker","singularity","modal","daytona"}` | **NO** — a repo-wide grep finds only vendored **tests** (`tests/tools/test_yolo_mode.py`, `test_hardline_blocklist.py`, `test_cron_approval_mode.py`) and a docstring mention in `thread_context.py:10`. Its production role was consolidated into `check_all_command_guards` |

Each skip is an **unconditional early return** on a *believed string* — e.g.
`if env_type in {"docker","singularity","modal","daytona"}: return {"approved": True, "message": None}`.
`env_type` is the per-call `_get_env_config()["env_type"]` read (`terminal_tool.py:1879`,
`code_execution_tool.py:1098`), so **a believed string disables the guard**. The `:1595-1596` comment
confirms the pattern is intentional and cross-referenced. **Two notes v0.2 and the reviews both
missed:** (i) the skip sets **differ** — only `check_execute_code_guard` includes `vercel_sandbox`,
so the three sites are not literally the same predicate; (ii) `check_dangerous_command` is dead code
in the current pin, which reduces the live surface from three sites to **two**. That materially
lowers the cost of every OQ-4 option. → **SB2b**, SA-8.

**3a. The wrapper-only option (c) — INVESTIGATED, and it DOES NOT WORK. (N-4)**

G1R proposed measuring, before asking for a vendor exception, whether the wrapper could simply
**pass `env_type='local'` to the guards** — achieving the inversion with no vendored edit. **I
investigated it. It does not hold, for a structural reason, and the finding is negative:**

At **both** live call sites, `env_type` is **one local variable that drives BOTH the guard call AND
the execution dispatch**:

```
terminal_tool.py:1879   env_type = config["env_type"]        # ONE variable
              :2025         env_type=env_type,               # -> _create_environment (the BACKEND)
              :2053     approval = _check_all_guards(command, env_type)   # -> the GUARD

code_execution_tool.py:1098  env_type = _get_env_config()["env_type"]     # ONE variable
                      :1105  _guard = check_execute_code_guard(code, env_type)   # -> the GUARD
                      :1114  if env_type != "local": return _execute_remote(...) # -> the BACKEND
```

There is **no wrapper-reachable seam that sets the guard's `env_type` without also setting the
backend's.** The only wrapper-owned levers are:

- **`TERMINAL_ENV`** — read by `_get_env_config()` (`terminal_tool.py:1073`) into that same single
  variable. Setting it to `local` makes the guards run **and makes execution local** — i.e. it turns
  the sandbox off. That is the opposite of the goal.
- **Monkeypatching `tools.approval.check_*`** — this is option (b), not option (c). It also binds
  unevenly: `terminal_tool.py:255-257` imports `check_all_command_guards` at **module scope** into
  the alias `_check_all_guards_impl`, so patching `tools.approval` **after** `terminal_tool` is
  imported does **not** affect it; `code_execution_tool.py:1104` imports **inside the function**, so
  it **is** late-bound and would pick the patch up. A wrapper attempting (b) must patch
  `terminal_tool._check_all_guards_impl` *and* `tools.approval.check_execute_code_guard`, and must
  do so before or after import respectively — **two different patch targets with two different
  timing requirements**, silently broken by any upstream refactor of either import style.

**Conclusion, stated against my own interest:** option (c) is **not available**, so it does **not**
dissolve the stop condition, and the operator still has to rule on OQ-4. I record this as a negative
result because the alternative — reporting the cheap option as viable without tracing the variable —
is exactly the error class §0 exists to prevent, and it would have resolved in this document's favour.
**The consolation is (ii) above:** with `check_dangerous_command` dead, every OQ-4 option now costs
**two** site edits, not three.

### P1 — sandbox topology

**4. Bind mount → copy-in / copy-out, never an RW host workspace.** (a) tarball in to a named volume
or fresh clone; artifacts out **through a scanner**; host toolchain treats exposed workspaces as
untrusted until scanned. (b) **The mount set is a closed allowlist** — credential, skills and cache
families **disabled** and their absence asserted at start (`docker.py:648-716` mounts all three `:ro`
by default; `:ro` blocks modification but **not exfiltration**, inverting §4's "never see provider
keys" via the filesystem rather than env).

**→ v0.2's "SCOPE CORRECTION" IS WITHDRAWN — IT WAS WRONG (N-2).** v0.2 asserted "the default
workspace is **tmpfs** (`:626`)… so E-2 is **real but opt-in**, and the primary fix is **never
enabling that mode**." Every part of that is wrong:

- `:626` sits inside the **`else:` at `:623`**, whose `if` is `if self._persistent:` at `:610`.
- Persistence defaults **True** at two independent points: `container_persistent` default `True`
  (`terminal_tool.py:1231`) and `TERMINAL_CONTAINER_PERSISTENT` default `"true"` (`:1172`).
- The default branch emits `-v {sandbox}/workspace:/workspace` (`:618-622`) **and**
  `-v {sandbox}/home:/root` (`:614-616`) — **two host bind mounts**.
- Per §3b, `task_id` collapses to `'default'` (`terminal_tool.py:1881-1885`), so the default is **ONE
  SHARED host-bound directory across the top-level agent and every `delegate_task` child**,
  reattachable across processes.

**Therefore: E-2 is DEFAULT-ON.** "Never enable that mode" was a **no-op recommendation** — the mode
is on. **SB2a is re-derived as a P0 PEER of SB2** (§6a), not a P1 predecessor of SB3, and its
copy-in/copy-out is mandatory in the default path rather than a hardening of an opt-in one.
**Scanner path list remains `UNVERIFIED`** — SA-11 depends on three named payloads, not the list.
→ SB2, SB2a, SA-9, SA-11.

**5. Stop claiming uid protection on Windows.** Docker Desktop's gRPC-FUSE/9p layer ignores POSIX uid
semantics; container writes land as the host user; the flag is **decorative** there. **The writability
boundary is mount topology (ro mounts, named volumes), never uid.** If uid separation genuinely
matters, the sandbox must live **in WSL2 on a Linux filesystem with a distinct user**, not a Windows
bind mount. **Windows is a distinct threat model** in this PRD. → §3 rows corrected; §5.
*Reinforced by N-2: the default topology is a Windows host bind, which is exactly the configuration
where uid provides nothing.*

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
**→ VERIFIED, WITH A CORRECTION TO THE FIRST G1R (the second G1R re-verified this correction as
right):** the backend's `/tmp` exec is a **deliberate documented tradeoff** (`:334`, comment `:326`:
*"needed by pip/npm builds"*), not an oversight — and `/var/tmp` **is** `noexec` (`:335`). So the item
is right for a **different reason** than G1R gave: `noexec` is not absent, it is **ineffective** where
it exists. **Be honest in the PRD that execution control is not implemented — the real controls are
mounts + network + approval content.** Seccomp interpreter-blocking is **UNVERIFIED**
(`grep -c seccomp docker.py` → 0, so the backend pins nothing) and must not become a criterion until
checked. No SA depends on it; it appears only in OQ-6.

### P2 — operational

**8. Make the secure mode the working mode.** With `--network=none` + workspace-only mount,
`pnpm install`, `git fetch` and the host toolchain **all stop working** — and `profileResolver.ts:14`
makes `terminal_power` the **default for COMPLEX_CODING**, i.e. the coding profile's most common
action. **Fix: dependency fetch becomes a separate gateway-mediated step**, egress-allowlisted to
registries and git remotes with results **cached**, so the sandbox stays offline **and builds still
run**. **This makes SB4 a precondition for SB2's adoptability.**

**→ ORDERING CONTRADICTION RESOLVED IN v0.3.** v0.2 asserted this precondition here while §6 shipped
SB4 **after** SB2 and SB2a. **Both could not hold.** Resolved in favour of this item: **the SB4-spike
is a deliverable that gates SB2's authorisation, and SB4's fetch path lands with SB2** (§6a).
**→ QUARANTINE LEAK CLOSED.** Marking the registry/git allowlist `UNVERIFIED` did not quarantine it,
because SA-15 consumes it directly. **SA-15 is now explicitly `BLOCKED` until the SB4-spike returns**
(§6 SB4, §7 SA-15). *G1R's high-confidence prediction, which I share: shipped without this, the first
real coding task fails and `TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` becomes permanent within a day —
**a control that gets switched off is worth less than no control.***

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
containers; the second G1R corroborated `Exited (137)`; reversible via `docker start`.)*

**→ CROSS-LANE TRACKING OWNER (added in v0.3).** G1R credited this disposition as correct and honest,
with one refinement: *"specified, not fixed"* needs somewhere to be discharged, because this repo's
recorded pattern is that **unowned findings do not get fixed**. Therefore:

> **Owner:** the **operator (King Flowers)**, as the only party with authority in both lanes.
> **Tracking artifact:** this section is the record of origin;
> `docs/security/agent-execution-isolation-audit.md` carries a cross-reference line to it so the
> finding is discoverable from the security-audit index rather than only from a PRD about a different
> subject.
> **Discharge condition:** either (i) `proxy_secret_required` defaults `true` with startup refusal in
> the TORQ-CONSOLE image, or (ii) an explicit operator ruling that the default is accepted as-is with
> the reasoning recorded. **Neither this PRD nor any slice in it may be marked complete on the basis
> that this item was specified.** The lane boundary limits the edit, not the accountability.

### Added in v0.3

**10. `--memory-swap` — close it, do not defer it.**
`docker.py:562-563` emits `--memory` alone; `grep` finds **no `--memory-swap` anywhere in
`docker.py`**. Docker's default is `--memory-swap = 2 × --memory`, so a container nominally capped at
5120 MB may consume **10240 MB** of memory+swap. Combined with the corrected concurrency arithmetic
(§6 SB6: 5120 MB default, not 512), the host-DoS exposure is **20× what v0.2 stated**.
**This is one flag.** SB2 emits `--memory-swap` equal to `--memory`. **Removed from OQ-6** — an open
question is for a decision that has a real trade-off, and this one does not.

---

## 10. Rollback

Each slice flag-gated and separately revertable. **Turning the sandbox off is a capability decision,
not a convenience:** with it off, `terminal_power` must become **ungrantable** rather than silently
reverting to host execution — the same discipline as PRD-005 §9's prohibition on using
`TORQCLAW_COLLAB_ENABLED=0` as a rollback.

**Baseline corrected in v0.3 (N-1).** v0.2 said *"today FRONTIER grants are already refused… so 'off'
is the current state."* **That was false when written** — the refusal was gated on
`collabEnabled()`, default off, and the legacy `APPROVE_TOOL` path dispatched with no tier check.
**It is true now, but only because of `72b4d36`, and only for granted runs.** The precise baseline:

| Path | State at HEAD | Basis |
|---|---|---|
| FRONTIER run carrying `grantedTools` | **REFUSED, unconditionally** | `dispatch.ts:505-508` (no flag), fences at `:262`, `:558`; `server.ts:433`, `:489` |
| FRONTIER run with **no** grant, resolving `terminal_power` | **EXECUTES on the host** | `profileResolver.ts:14`; the engine's own toolset, not `grantedTools` |
| LOCAL_EDGE granted run | **EXECUTES**, name-scoped | unchanged |

So "off" is the current state **for granted FRONTIER runs only**. **SB1's ungrantable-`terminal_power`
rule is a live behaviour change** on the second row, which covers every `COMPLEX_CODING` task — not a
formalisation of the status quo. Stage and measure it accordingly (§6 SB1).

**Rollback of `72b4d36` is out of scope for this PRD.** It landed as its own slice with its own
regression guard, and reverting it would re-open N-1. If SB5 ever needs to relax it, that relaxation
is SB5's argv-scoped admission (§1a) — **never** a revert to a flag-gated predicate.

## 11. Open questions

1. **Image** — build a TorqClaw-specific pinned minimal image (recommended for a security boundary) or
   pin an upstream one? **Who rebuilds on CVE, and does a stale digest fail closed or run forever?**
2. **Docker lifecycle** — operator says Docker stays running. Verify health at startup **and per call**
   (recommended) and refuse `terminal_power` when absent? *(Note the interaction with N-3: a health
   check that raises must return a block, not propagate.)*
3. **Egress** — allowlist-only from the start (recommended; loosening later is easy, tightening later
   breaks workflows)?
4. **Vendored boundary — REQUIRES AN OPERATOR RULING; SB2b is BLOCKED on it.** SB2 touches the Hermes
   wrapper only (confirm this stays **wrap, don't rewrite** — verified achievable: `approval_hook.py`
   registers programmatically at `:131-144` with no vendor edit). **§9 item 3's guard inversion is
   different**: it touches vendored `approval.py` at **two live sites** (`check_all_command_guards`
   `:1283-1284`, `check_execute_code_guard` `:1597-1598`; `check_dangerous_command` `:1052-1053` is
   dead code — §9 item 3). **The four mechanisms, with costs:**

   | # | Mechanism | Cost | Risk |
   |---|---|---|---|
   | (a) | **Edit vendored `approval.py`** — delete the two live early returns | Smallest edit (2 sites, ~4 lines). Immediate, testable against the vendored suite | **Breaks invariant 10's upstream pin.** Needs an explicit operator exception. Every submodule bump must re-apply or re-verify it |
   | (b) | **Monkeypatch from `mcp_wrapper/` at import time** | No vendored file changes; wrap-don't-rewrite **in letter** | **Two different patch targets with two different timing requirements** (§9 item 3a): `terminal_tool._check_all_guards_impl` is bound at module import; `tools.approval.check_execute_code_guard` is late-bound. Silently broken by any upstream change to either import style, and **untestable against the vendored test suite**, which imports the real functions |
   | (c) | **Wrapper passes `env_type='local'` to the guards** | Would be the cheapest — no vendored edit, no patching | **INVESTIGATED AND RULED OUT (§9 item 3a).** `env_type` is one variable driving both the guard call and the backend dispatch at both call sites; there is no seam that separates them. Forcing `local` for the guard forces `local` execution. **Not available.** |
   | (d) | **Carry a patch series against the submodule** | Explicit, reviewable, survives bumps as a rebase | Ongoing maintenance cost; a failed rebase after an upstream refactor is a **silent** loss of the control unless a test pins it. Mitigated by making SA-8 a permanent gate |

   **Recommendation, for the operator to accept or reject:** **(a) with (d)'s discipline** — edit the
   two sites, and pin them with SA-8 so a submodule bump that reverts the edit turns the suite RED.
   (b) trades a visible exception for an invisible one, which §0's whole thesis argues against.
   **Until this is ruled, SB2b does not start and believed containment still disables both live
   guards (§6 SB2b).**
5. **WSL2 relocation** — does §9 item 5's "sandbox in WSL2 with a distinct Linux user" get adopted, or
   is Windows accepted as a weaker threat model with mount topology as the only boundary?
6. **Seccomp** — the host reports a builtin profile but the backend never pins one
   (`grep -c seccomp docker.py` → 0). Pin one? **Interpreter-blocking via seccomp is `UNVERIFIED`
   and must not become a criterion until checked.** *(`--memory-swap` was removed from this question
   in v0.3 — it is now a required SB2 flag, §9 item 10.)*

## 12. Operator stop conditions

- Any change to vendored Hermes beyond the wrapper — **including §9 item 3's `approval.py` inversion,
  which is now isolated in SB2b and BLOCKED ON OQ-4.** *(SB2 itself is wrapper-only and does not
  trip this: `approval_hook.py:131-144` registers programmatically.)*
- **Authorising SB2 before the SB4-spike returns** (§6 SB4) — SB2's adoptability rests on it.
- Enabling the sandbox in a deployment.
- Push/merge/release of any slice.
- Anything that would make `terminal_power` grantable without **verified** containment.
- **Any change that makes the FRONTIER granted-run refusal conditional again** — on a flag, a config
  value, or an ambient property. `72b4d36` closed that hole after the same mistake was made three
  times (`dispatch.ts:481-489`); a fourth is a stop condition, not a review finding.
