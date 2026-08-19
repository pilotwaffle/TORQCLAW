# G1R Gate-1 re-review — PRD-TCLAW-AGENT-SANDBOX-006 v0.2

**Seat:** G1R — independent design reviewer.
**Model / seat disclosure:** `CLAUDE.md` §2 names **Opus 5** for the G1R seat, and I am
`claude-opus-5`. **No substitution applies.** This is the named seat reviewing at its named authority.
**Date:** 2026-08-17 · **Branch:** `phase1-server-owned-authority` · **HEAD:** `57bdd4e`
**Target:** `docs/PRD-TCLAW-AGENT-SANDBOX-006.md` v0.2 (441 lines), read in full.
**Prior verdict read in full:** `docs/prd-reviews/G1R-OPUS-AGENT-SANDBOX-006-GATE1.md` (v0.1, REJECT, 9
blockers, authored by a different fresh Opus-5 G1R thread).
**Context:** fresh thread, no authoring context. Repo is PUBLIC; no `.env` values or secrets appear
below. No repo file was modified except this review.

---

## VERDICT: **REJECT** — 4 blockers

This is a **substantially better document than v0.1**, and I want that on the record before the
blockers. v0.2's §0 self-indictment is honest, its §3 emitter-citation rule is the right rule, §5's
workspace-consumer threat model is a genuine and correct addition, §6's SB2a/SB6 slices close real
omissions, and §8's extension of the mutation obligation to *every* criterion is the correct response
to this repo's recorded defect. **Seven of the prior nine blockers are genuinely closed.** Most of
§3's twenty rows verify exactly as cited, and v0.2's three corrections-of-G1R are **all three
correct** — I verified each independently and the prior verdict was wrong on each.

The rejection rests on four findings, two of which are decisive on their own:

1. **N-1 (decisive).** §1 and §9-item-1's load-bearing claim that the gateway "**already refuses every
   FRONTIER granted run**" is **FALSE in the default configuration.** `frontierGrantFenced`
   (`dispatch.ts:494-497`) is `&& collabEnabled()`, and `TORQCLAW_COLLAB_ENABLED` **defaults off**
   (`principalBridge.ts:71-72`). The legacy `APPROVE_TOOL` path (`server.ts:458-482`) mints the
   granted FRONTIER request and dispatches it with **no FRONTIER refusal**. The exact-action hole is
   **open today**, not closed. §10's "off is the current state" is wrong in the same way.
2. **N-2 (decisive).** §9 item 4's headline "**SCOPE CORRECTION**" — that the default workspace is
   tmpfs (`docker.py:626`) and the host bind is opt-in — is **FALSE**. `:626` is inside the
   `else:` of `if self._persistent:` (`:610`), and `persistent` defaults **True**
   (`terminal_tool.py:1231`, `TERMINAL_CONTAINER_PERSISTENT` default `"true"` at `:1172`). The default
   is a **host bind mount** of `~/.hermes/sandboxes/docker/<task>/workspace` → `/workspace`
   (`:614-622`). v0.2 read a line without reading its enclosing branch — **the identical error class
   §0 apologises for**, committed in the correction itself. E-2 is **default-on**, not opt-in.
3. **N-3.** SB2's designated fail-closed seam **fails OPEN**. `invoke_hook`
   (`hermes_cli/plugins.py:1673-1685`) wraps each `pre_tool_call` callback in `try/except Exception`
   and **proceeds with the tool call** on a throw; `agent_runtime_helpers.py:1681-1683` swallows it
   again. A containment verifier that raises — daemon unreachable, `docker inspect` timeout, JSON
   parse error, i.e. *precisely* SB2's failure modes — is treated as "no objection."
4. **N-4.** SA-8's inversion is specified as wrap-don't-rewrite in §9 item 3 while requiring edits to
   **vendored `approval.py` at three sites**. OQ-4 flags it and §12 lists it as a stop condition, so
   the PRD is *honest*, but SB2/SA-8 are written as shippable when they are **blocked on an
   unobtained operator ruling**. A slice gated on a stop condition is not a shippable slice.

N-1 and N-2 are **new defects in v0.2** — neither appeared in v0.1 — and both sit in the two
paragraphs v0.2 advances as its strongest verified claims. In a document whose whole thesis is
citation integrity, two miscited load-bearing claims is the finding that decides this review.

---

## 1. What I verified, and how

| Artifact | Method |
|---|---|
| `docs/PRD-TCLAW-AGENT-SANDBOX-006.md` v0.2 | read in full |
| `docs/prd-reviews/G1R-OPUS-AGENT-SANDBOX-006-GATE1.md` | read in full |
| `tools/environments/docker.py` | read `:150-209`, `:300-440`, `:540-820`, `:1120-1170`; `grep -c "read-only"` |
| `tools/terminal_tool.py` | every cited line read individually (`sed -n`), plus config resolution `:1060-1265` |
| `tools/approval.py` | all three guard-skip sites read with enclosing `def` resolved by `awk` |
| `tools/code_execution_tool.py` | `:1095-1120`, `:592-691` |
| `tools/file_tools.py` | `:288-296`, `cross_profile` sites |
| `hermes_cli/plugins.py` | `invoke_hook` `:1650-1685`, `get_pre_tool_call_block_message` `:1852-1899` |
| `agent/tool_executor.py`, `agent/agent_runtime_helpers.py` | hook fire + `skip_pre_tool_call_hook` sites |
| `mcp_wrapper/approval_hook.py`, `hermes_runner.py` | read in the cited ranges |
| `gateway/src/dispatch.ts` | `:230-285`, `:490-560` — **both** fence sites |
| `gateway/src/server.ts` | `:150-170`, `:377-492` — **both** APPROVE_TOOL paths |
| `gateway/src/c2Broker.ts` | `decideApprovalC2` `:190-240` |
| `gateway/src/principalBridge.ts` | `collabEnabled` `:71-72` |
| `gateway/src/profileResolver.ts`, `contracts/src/errors.ts`, `commands.ts` | cited ranges |
| `bridge/src/pathScope.ts`, `toolFilter.ts`, `registry.ts` | cited ranges; `grep realpath\|lstat\|readlink` → **0 hits** |
| Live Docker 28.3.2 (Desktop/WSL2) | **2 experiments**, both `--rm`, no socket mounted, artifacts deleted |

**Docker hygiene.** I created exactly two ephemeral `alpine:latest` containers, both `--rm`, both
exited. `docker ps -a` after my work shows **no container I created**. The 17 pre-existing containers
(torq-buzz, torq-writer, torq-console-verify) were **not** started, stopped, or removed by me — I only
listed them. My probe directory under the session scratchpad was deleted and its absence confirmed.
No `.git` in the repo was touched; the repo working tree is unchanged apart from this new file.

**Incidental corroboration of §9 item 9:** the four `torq-console-verify:*` containers now read
`Exited (137) 18 minutes ago`, consistent with v0.2's note that the operator stopped all four. The
"live orphan" condition SB6 cites was real; it is currently discharged.

---

## 2. §3 row-by-row citation audit

**Rule applied:** v0.2's own — a row's cited `file:line` must *emit* the claim. I checked every row in
both directions (v0.2 wrong, or v0.2's correction-of-G1R wrong).

### Rows that verify exactly as cited — 17 of 20

| Row | Cite | Verified |
|---|---|---|
| Drop capabilities | `:328` | ✔ `"--cap-drop", "ALL"` |
| Re-added caps | `:329-331` | ✔ `DAC_OVERRIDE`, `CHOWN`, `FOWNER` — and the "not a clean ALL-drop" characterisation is fair |
| no-new-privileges | `:332` | ✔ |
| PID limit | `:333` | ✔ `--pids-limit 256` |
| `/tmp` noexec **NO — deliberate** | `:334` | ✔ `"/tmp:rw,nosuid,size=512m"`; comment `:326` reads *"/tmp is size-limited and nosuid but allows exec (needed by pip/npm builds)"* — the "deliberate documented tradeoff" claim is **exactly right** |
| `/var/tmp` noexec | `:335` | ✔ `noexec` present |
| `/run` conditional | `:342-343` | ✔ `_RUN_TMPFS_NOEXEC` / `_RUN_TMPFS_EXEC`, s6 rationale documented `:338-341` |
| Privilege-drop caps | `:350-351` | ✔ `_PRIVDROP_CAP_ARGS`; `_build_security_args:365-367` adds them only when **not** `run_as_host_user` |
| `--read-only` **NO** | — | ✔ `grep -c "read-only" docker.py` → **0**. G1R correct, as v0.2 concedes |
| `--user` conditional | `:733` | ✔ `user_args = ["--user", user_spec]` under `if run_as_host_user` `:730`; `_resolve_host_user_spec` returns `None` when `os.getuid` is absent (`:423-426`) → never on native Windows |
| `--network=none` | `:573` | ✔ `if not network: resource_args.append("--network=none")` at `:572-573`. **G1R's B-1 was wrong here and v0.2's correction is right.** |
| Memory / CPU | `:561-563` | ✔ `--cpus` `:561`, `--memory` `:563` |
| Disk quota silently skipped | `:564-571` | ✔ `_storage_opt_supported()` else-branch warns and continues |
| `/home`, `/root` tmpfs | `:629-630` | ✔ `rw,exec` — **but see N-2: also in the non-default `else` branch** |
| Container labels | `:799-801` | ✔ `hermes-agent=1`, `hermes-task-id`, `hermes-profile`. **G1R omitted these; v0.2's correction is right.** |
| Credential / skills / cache mounts `:ro` | `:648-672`, `:675-692`, `:695-716` | ✔ all three families, all `:ro`, no opt-out flag |
| `docker_extra_args` UNVALIDATED | `terminal_tool.py:1096` + `docker.py:767-772` | ✔ `_parse_env_var("TERMINAL_DOCKER_EXTRA_ARGS", ...)`; `:769-774` filters only *non-string* entries and appends every string verbatim at `:783` |
| Docker socket NEVER MOUNTED | — | ✔ `grep docker.sock` across `tools/` → only `file_tools.py:292` `_SENSITIVE_EXACT_PATHS` (a **blocked** path) and a comment. Correct as an explicit non-goal |

### Miscited rows — 3

**MC-1 — Default `/workspace` = tmpfs, cite `:626`. WRONG (this is N-2).**
`:626` emits `--tmpfs /workspace:rw,exec,size=10g`, but it is inside `else:` at `:623`, whose `if` is
`if self._persistent:` at `:610`. `self._persistent = persistent_filesystem` (`:538`), passed as
`persistent_filesystem=persistent` (`terminal_tool.py:1251`), where
`persistent = cc.get("container_persistent", True)` (`:1231`) and the config key resolves from
`TERMINAL_CONTAINER_PERSISTENT` defaulting to `"true"` (`:1172`). **Default = the `if` branch**, which
emits `-v {sandbox}/workspace:/workspace` (`:618-622`) and `-v {sandbox}/home:/root` (`:614-616`) —
**host bind mounts**. The tmpfs row describes a non-default mode.

**MC-2 — Orphan reaper, cite `:172-178` **and** `:1139-1142`. Half wrong.**
`:172` is correct and is the load-bearing half: `filters = ["--filter", "label=hermes-agent=1",
"--filter", "status=exited"]` — the `status=exited`-only claim is **verified**, and so is "live
orphans are never swept." But `:1139-1142` is **not the reaper**; it is `_find_reusable_container`
(`def` at `:1122`), the cross-process **reuse** probe. Two different mechanisms with different
security meaning: the reuse probe is what makes SA-6's container-sharing problem real, and citing it
as reaper evidence conflates a cleanup path with an attach path.

**MC-3 — §9 item 3, cite `approval.py:1595-1598`. Off by two, and the cite understates itself.**
The skip is at `:1597-1598`; `:1595-1596` are the docstring tail. Trivial as a line offset — I record
it only because §3's rule makes line precision the document's own standard. The *substance* is
verified and, as v0.2 says, **worse than G1R reported**: three unconditional early returns on a
believed string, in the three functions v0.2 names —
`check_dangerous_command` (`def :1037`, skip `:1052`), `check_all_command_guards` (`def :1273`, skip
`:1283`), `check_execute_code_guard` (`def :1570`, skip `:1597`). The `:1596` comment itself says
*"matches the container skip in check_all_command_guards / check_dangerous_command."* **All three
exist. v0.2's count is right.**

### §9 claim audit

| Claim | Verdict |
|---|---|
| `errors.ts:13-22` — `ToolApprovalRequired` already carries `args` | ✔ `readonly args: unknown` `:15`, ctor `:17-22` |
| `commands.ts:33-40` — `APPROVE_TOOL` carries no tool name | ✔ comment `:34-36` states it explicitly; schema is `approvalId` + `decision` only |
| `server.ts:159` — `HOST` defaults `127.0.0.1` | ✔ `const HOST = process.env.TORQCLAW_HOST \|\| '127.0.0.1'`. Item 6(a) correctly demoted to a regression guard |
| `profileResolver.ts:9-15` — `terminal_power` default for `COMPLEX_CODING` | ✔ `:14` |
| `terminal_tool.py:1073`, `:1878` — per-call env read | ✔ both |
| `:2462-2463` — `check_terminal_requirements` returns True for `local` | ✔ |
| `:1237-1238` — `_LocalEnvironment` first branch | ✔ |
| `:1183-1185` — `PERSIST_ACROSS_PROCESSES` default true | ✔ |
| `:1881-1885` — subagent task_ids collapse to `default` | ✔ comment `:1882-1884` says so verbatim |
| `:952` — per-task override registry | ✔ `register_task_env_overrides` |
| `:1072` — moving default image tag | ✔ `nikolaik/python-nodejs:python3.11-nodejs20` |
| `approval_hook.py:23` — gates `process` | ✔ `_GATED` regex includes `process`; `capability.ts` `P4_EXEC` divergence stands |
| `mcp_wrapper` sets `TERMINAL_ENV` nowhere | ✔ zero hits |
| **`dispatch.ts:262` refuses every FRONTIER granted run** | ✘ **FALSE — see N-1** |

---

## 3. BLOCKERS

---

### N-1 — "The gateway already refuses every FRONTIER granted run" is false by default; §1, §9-item-1 and §10 all rest on it

*Cited as:* `dispatch.ts:262`, `frontierGrantFenced` → `refuseFrontierGrantedRun`. §1 concludes **"the
exact-action hole is closed today by withholding the capability."** §10 concludes **"today FRONTIER
grants are already refused, so 'off' is the current state."** §9 item 1 concludes the fence is what
SB5 **retires**.

*What the code says.* `:262` does call the fence — but the predicate is

```
dispatch.ts:494-497
function frontierGrantFenced(req, diag): boolean {
  return diag.tier === ComputeTier.FRONTIER
    && collabEnabled()                                    // <-- default FALSE
    && (req.payload.grantedTools?.length ?? 0) > 0;
}
```

`principalBridge.ts:71-72` — `collabEnabled()` reads `TORQCLAW_COLLAB_ENABLED`, documented at `:2` as
**"default off"**, and `.env.example` contains no `COLLAB` line at all. With the flag unset the fence
returns `false` at both call sites (`:262` legacy, `:548` failover).

*And the "second fence" does not cover it either.* The FRONTIER refusal in `APPROVE_TOOL`
(`server.ts:433-439`) is inside the **C2 branch**, reached only when `decideApprovalC2` returns
`decided` — and `c2Broker.ts:197` is `if (!collabEnabled()) return { kind: 'legacy' };`. The **legacy**
branch (`server.ts:458-482`, the default path) does:

```
const decided = decideApproval(...);
if (decision === 'APPROVE') {
  const reqB = mintGrantedRequest(decided.requestJson, decided.toolName);   // :473
  ... dispatch(reqB, diag);                                                 // :481
}
```

no tier check, no refusal. `dispatch.ts:113` puts the tool into `grantedTools`;
`hermes_runner.py:437` reads `grantedTools`; `approval_hook.py:61-63` returns `False` (no approval
needed) for any tool in `granted` — **a name-only grant, honoured, on FRONTIER, today.**

*Why blocking.* Three separate consequences, each independently serious:
- **The security posture is misstated.** §1 tells the operator the exact-action hole is closed. It is
  open in the default configuration. That is the unenforced-claim defect in its purest form: a
  document asserting a control that only fires behind an off-by-default flag.
- **SB5's role inverts.** SB5 is described as *retiring* an existing refusal — a net loosening
  gated on new proof. In reality SB5 must **first build a refusal that does not yet exist by
  default**, then bind it to argv. That is a different, larger slice with a different risk profile,
  and "argument-hash binding is the unlock" is not the right frame for it.
- **§10's rollback story collapses.** "Off is the current state" is the justification for treating
  the sandbox as purely additive. If granted FRONTIER runs already execute, then shipping SB1's
  ungrantable-`terminal_power` rule is a **behaviour change on a live path**, not a formalisation of
  the status quo.

*Suggested fix.* (i) Correct §1, §9 item 1, and §10 to state the fence's real scope: *"refused only
when `TORQCLAW_COLLAB_ENABLED` is on; in the default configuration a granted FRONTIER run executes
under a name-only grant via the legacy `APPROVE_TOOL` path (`server.ts:458-482`)."* (ii) Add a **P0
slice ahead of SB5**: make the FRONTIER granted-run refusal **unconditional** — remove
`collabEnabled()` from `frontierGrantFenced`, and add the tier refusal to the legacy `APPROVE_TOOL`
branch. That is small, flag-free, and closes a live hole today. (iii) Add an acceptance criterion
executing the real path with **`TORQCLAW_COLLAB_ENABLED` unset**: `APPROVE_TOOL` on a FRONTIER task
must terminate in refusal and **no engine call**. Assert on the absence of the engine call, not on an
error string.

---

### N-2 — The §9-item-4 "SCOPE CORRECTION" is itself wrong: the default workspace IS a host bind mount, so E-2 is default-on and SB2a is scoped to the wrong mode

*Cited as:* "the default workspace is **tmpfs** (`:626`), not a host bind — the host bind occurs only
under `bind_host_cwd` or explicit user config (`:635-640`). So E-2 is **real but opt-in**, and the
primary fix is **never enabling that mode** plus SB2a's scanner." §3's `/workspace` row and §6 SB0's
"SB0 delivers ZERO mitigation" framing both inherit this.

*What the code says.*

```
docker.py:610   if self._persistent:
     :611          sandbox = get_sandbox_dir() / "docker" / task_id
     :612-616      self._home_dir = .../home ; makedirs ; -v {home}:/root
     :617-622      if not bind_host_cwd and not workspace_explicitly_mounted:
                       self._workspace_dir = .../workspace ; makedirs
                       -v {workspace}:/workspace          <-- HOST BIND, the default
     :623        else:
     :624-627      --tmpfs /workspace:rw,exec,size=10g    <-- cited row, NON-default
```

`self._persistent = persistent_filesystem` (`:538`) ← `persistent_filesystem=persistent`
(`terminal_tool.py:1251`) ← `persistent = cc.get("container_persistent", True)` (`:1231`) ←
`TERMINAL_CONTAINER_PERSISTENT` default `"true"` (`:1172`). **Two independent `True` defaults.** The
tmpfs row is unreachable unless an operator explicitly turns persistence off.

*Independently reproduced (this host, Docker 28.3.2, `--rm`, no socket).* Against a host-bind
`/workspace` under `--cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --network=none`:

```
in-container:  mkdir -p /workspace/.git/hooks; write post-checkout; chmod +x; ln -s /etc/passwd escape
host-side:     -rwxr-xr-x 1 Barry 197121 25 ... .git/hooks/post-checkout
               lrwxrwxrwx 1 Barry 197121 11 ... escape -> /etc/passwd
```

Executable host-side, owned by the operator; symlink persisted with a host-interpreted target. E-2 and
E-3 both reproduce **in the default mode**.

*Why blocking.* This is the review's most consequential error because it **downgrades the severity of
the finding that v0.1 was rejected over**. §5 correctly identifies the workspace consumer as the
threat, then §9 item 4 tells the reader the exposure is opt-in and "the primary fix is never enabling
that mode" — a fix that is a no-op, because the mode is on. Concretely:
- **SB2a is mis-scoped.** Its stated first fix — *"Copy-in / copy-out; never an RW host-workspace bind
  mount"* — is correct and now **mandatory in the default path**, not a hardening of an opt-in mode.
  Its priority relative to SB2 changes.
- **SB3 is worse than described.** SB3's per-task workspace already exists in degraded form: the
  default `~/.hermes/sandboxes/docker/<task_id>` bind, with `task_id` collapsing to `'default'`
  (`terminal_tool.py:1881-1885`). So the default is **one shared host-bound directory across the
  top-level agent and every `delegate_task` child** — the worst of both, and unstated.
- **The mount-allowlist assertion in SB2/SA-9 must expect `/workspace` and `/root` as host binds**, or
  it will refuse on the default configuration and the control gets switched off (§9 item 8's own
  failure mode).
- **§3's "Corrections to G1R B-1" overreaches.** G1R never claimed tmpfs; but v0.2's replacement
  characterisation is wrong in the operator's favour, which is the direction that matters.

*Suggested fix.* (i) Replace the §3 `/workspace` row with both branches and their reachability:
*"default (`container_persistent=True`, `:610`) → host bind `~/.hermes/sandboxes/docker/<task>/workspace`
(`:618-622`); tmpfs (`:626`) only when persistence is explicitly disabled."* Same for `/home`,
`/root`. (ii) Delete "E-2 is real but opt-in" and "the primary fix is never enabling that mode."
(iii) Re-derive SB2a's scope and ordering from default-on E-2 — it is arguably a **P0** peer of SB2,
not a P1 predecessor of SB3. (iv) Add `TERMINAL_CONTAINER_PERSISTENT` and `TERMINAL_SANDBOX_DIR` to
SA-5's channel list (see NB-3).

---

### N-3 — SB2's designated fail-closed seam fails OPEN on a throwing verifier

*Cited as:* SB2 — *"Containment is proven per call, in the `pre_tool_call` hook
(`mcp_wrapper/approval_hook.py:67-125` — TorqClaw-owned, already proven for the approval gate, already
wrap-don't-rewrite compliant). **Fail closed:** cannot establish containment → refuse."*

*The seam is real.* I verified it: `approval_hook.register()` appends to
`mgr._hooks["pre_tool_call"]` with no vendor edit (`:131-144`); the hook fires before dispatch in both
paths (`tool_executor.py:346-357`, `agent_runtime_helpers.py:1667-1683`), including for
`delegate_task`; `{"action":"block"}` is honoured (`plugins.py:1890-1898`). The prior G1R's B-2 fix was
correctly identified and v0.2 correctly adopted it. **Credit.**

*What the code does with a failure.*

```
plugins.py:1673-1685      for cb in callbacks:
                              try:  ret = cb(**kwargs)
                              except Exception as exc:
                                  logger.warning("Hook '%s' callback %s raised: %s", ...)
                          return results          # <-- exception -> no block directive
agent_runtime_helpers.py:1670-1683
                          try:  block_message = get_pre_tool_call_block_message(...)
                          except Exception:  pass  # <-- swallowed again
                          if block_message is not None: ...   # else: EXECUTE
```

Docstring at `plugins.py:1653-1654`: *"Each callback is wrapped in its own try/except so a misbehaving
plugin cannot break the core agent loop."* That is the right design for an **observer** hook and the
wrong one for a **security** hook — and SB2 makes it a security hook. `:1870-1871` doubles down:
*"Invalid or irrelevant hook return values are silently ignored."*

The failure modes are not hypothetical; they are SB2's own workload. Verifying containment per call
means shelling out to `docker inspect` to check the container is alive, the digest matches, and the
mount set is the allowlist. Every one of those can raise — `subprocess.TimeoutExpired`, `OSError` when
the daemon is down, `json.JSONDecodeError` on truncated output, `KeyError` on a schema change. In each
case the hook raises, the exception is logged at WARNING, and **the terminal command executes on the
host.** That is the exact silent-downgrade-to-host-execution §2 corollary 3 forbids.

*Why blocking.* SB2 is the containment slice and this is its enforcement point. A fail-closed claim
whose seam fails open is the unenforced claim at the architectural level, and it would be
**invisible to SA-3/SA-4/SA-9 as written** — those exercise the *deny* path with a working verifier,
never the verifier's own failure. This is the one blocker the PRD had no way to find by reading its own
citations, and the one most likely to survive into a "verified" implementation.

*Suggested fix.* Specify the hook body as **total**: wrap the entire containment check in the hook's
own `try/except BaseException` and **return `{"action":"block"}` from the except arm**, so an
unverifiable containment state is expressed as a *returned block* rather than a raised exception. Add
an acceptance criterion — **SA-16** — that executes the real path with the verifier forced to raise
(monkeypatch the `docker inspect` call to throw; or point `DOCKER_HOST` at a dead endpoint so the
inspect genuinely fails) and asserts **the tool did not execute** and no `_LocalEnvironment` was
constructed. Discharge it under §8 with recorded RED. Also state in SB2 that the vendored dispatcher's
`except Exception: pass` means **the hook may never raise** — that constraint is load-bearing and
belongs in the spec, not in the implementer's memory.

---

### N-4 — SA-8's inversion requires vendored edits at three sites; the PRD ships it as a slice while §12 lists it as a stop condition

*The design call is right.* I agree with the operator and with v0.2 that the **inversion beats the
token scheme**. A token ("prove you are contained") must be unforgeable, transported to three call
sites, and kept correct forever across upstream churn; deleting the skips makes M-3
**unrepresentable**, which is strictly stronger. The reasoning in §9 item 3 is sound and the
three-site count is verified.

*The implementability problem.* Those three sites are in
`engines/hermes_kernel/vendor/hermes-agent/tools/approval.py` — **vendored**. §9 item 3 says the
inversion "deletes them." There is no wrapper seam that can: the skips are early returns *inside* the
guard functions, and their callers (`terminal_tool`, `code_execution_tool.py:1105`) call them
positionally with `env_type`. The realistic options are all consequential: (a) edit vendored
`approval.py` (breaks invariant 10's pin and needs an operator exception); (b) monkeypatch the three
functions from `mcp_wrapper/` at import time (wrap-don't-rewrite in letter, silently broken by any
upstream signature change, and untestable against the vendored test suite); (c) always pass
`env_type="local"` to the guards regardless of the real backend — which **works, is wrapper-only, and
is not mentioned**; or (d) carry a patch series against the submodule.

*Why blocking.* Not because the PRD hides it — **it does not.** OQ-4 flags it explicitly and §12 lists
"§9 item 3's `approval.py` inversion" as a stop condition. That honesty is genuine and I credit it.
It is blocking because of what the document does *around* the flag: SA-8 sits in §7 as a criterion
against **SB2**, SB2 is the slice the whole PRD is built to ship, and §6 presents SB2 as
"independently shippable." A slice carrying a criterion that cannot be built without discharging a
stop condition is **not independently shippable**, and Gate 1 approving it would authorise
implementation of something whose central mechanism is blocked on an unobtained ruling.

*Suggested fix.* (i) Split SA-8 out of SB2 into its own slice — **SB2b — guard-relaxation removal** —
explicitly marked `BLOCKED ON OQ-4 OPERATOR RULING`, so SB2 can ship without it and the dependency is
structural rather than a footnote. (ii) Enumerate the four mechanisms above in OQ-4 with their costs,
so the operator rules on a concrete choice rather than a principle. **Note that option (c) — the
wrapper always passing `env_type="local"` into the guard functions — appears to achieve the inversion
with no vendored edit at all**, and if it holds it dissolves the stop condition entirely; it deserves
a measurement before the operator is asked to authorise a vendor exception. (iii) State plainly that
**until OQ-4 is ruled, believed-containment still disables all three guards**, so SB2 shipped alone
does not close M-3.

---

## 4. Prior blockers — closed vs not

### Genuinely closed — 7 of 9

- **B-1 (§3 unreachable profile).** ✔ **Closed, and well.** §3 is rebuilt against the emitter with
  20 rows and per-row citations; 17 verify exactly. The withdrawal of the eight-row bench table and
  the §0 admission ("I measured a bench reproduction of the artifact instead of the artifact") is the
  right response. MC-1/MC-2 are new errors within the fix, not a failure to attempt it.
- **B-2 (fail-closed at the wrong layer).** ✔ **Closed as specified.** SB2 moves enforcement to the
  `pre_tool_call` hook, per call, wrapper-owned — verified to be a real seam that fires before
  dispatch on every path including `delegate_task`. §2 corollary 5 ("per-call, not per-boot") states
  the underlying rule. N-3 is a defect *in* the adopted fix, not a re-opening of B-2.
- **B-3 (bind-mounted workspace = host execution).** ✔ **Closed in structure.** §5 is a real threat
  model naming the auto-executing files (`.git/hooks`, `vitest.config.ts`, `conftest.py`,
  `sitecustomize.py`, `.envrc`, `Makefile`, `node_modules/.bin`) and the correct consequence
  ("container output is untrusted input to the host toolchain"); SB2a exists, is ordered before SB3,
  and adds host-side defence-in-depth (`core.hooksPath`, `--ignore-scripts`). SA-11 requires planting
  **both** a hook and `vitest.config.ts`. N-2 mis-scopes the severity but does not undo the fix.
- **B-4 (credential/skills/cache mounts).** ✔ **Closed.** All three families verified mounted `:ro`
  by default with no opt-out (`:648-716`); §9 item 4b disables all three, asserts absence at start via
  `docker inspect` Mounts against a closed allowlist, and §4 is broadened to "no secrets via
  `--build-arg`, env, **OR bind mount**." The `:ro`-blocks-modification-not-exfiltration distinction
  is stated. SA-9 requires a real container.
- **B-6 (Windows uid).** ✔ **Closed, cleanly.** §3's `--user` row records the conditional and the
  Windows `None` return; §9 item 5 states the governing rule — *"the writability boundary is mount
  topology (ro mounts, named volumes), never uid"* — and names Windows a distinct threat model.
  OQ-5 escalates WSL2 relocation. `_resolve_host_user_spec:423-426` verified.
- **B-8 (egress must deny the host).** ✔ **Closed as specification.** SB4 is deny-first with the
  full list (`127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  `host.docker.internal`) **before** any allow rule, on a dedicated network. SA-10 requires a real
  container **with a network attached** and explicitly notes `--network=none` does not exercise it —
  the right insight. I re-confirmed the premise: from a networked container
  `host.docker.internal` resolves to `192.168.65.254` and is routable.
- **B-9 (assertable criteria).** ✔ **Largely closed** — the strongest single improvement in v0.2.
  SA-4 now demands the real backend, a genuinely dead `DOCKER_HOST`, and an assertion on the
  *constructed class* rather than an error string. SA-5 enumerates channels instead of asserting a
  universal negative. SA-6 pins `persist_across_processes=false` **and** the non-collapsing
  `task_id`, both verified as real vendored defaults. §7's header forbids config assertions and
  mocked backends; §8 extends the mutation obligation to **every** criterion with *"a probe reported
  without its RED output is not a discharged probe."* See §5 below for the two residual leaks.

### Not closed — 2 of 9

- **B-5 (`TERMINAL_DOCKER_EXTRA_ARGS` argv injection).** ⚠ **Partly closed; specified but not
  mechanised.** §3 marks the row `UNVALIDATED` with both cites verified, SB1 says "the ENTIRE
  container flag set is gateway-owned," and SA-5 probes the env channel. What is missing is B-5's
  actual fix: a **wrapper-side allowlist of permissible extra args, default empty, with SB2 refusing
  to start when any of the four `TERMINAL_DOCKER_*` vars is set outside it.** "Gateway-owned" is a
  property; the allowlist is the mechanism that makes it true, and the mechanism is where this repo's
  claims usually die. Also unaddressed: `docker.py:783` appends `validated_extra` **last**, after
  `security_args`, so a later flag can override an earlier one — the ordering is part of the
  vulnerability and belongs in the spec. **Non-blocking on its own** given SA-5's channel probe, but
  record it as owed.
- **B-7 (startup refusal).** ✔ **Closed on the design**, ⚠ **broken by N-1 on the premise.** The
  grant-time refusal replaces the boot refusal, "reachable" is defined precisely, the
  `workspace_write` fallback correctly exploits `resolveProfile`'s broadening check (narrower target),
  the escape hatch is per-session and logged, and the item moved SB0→SB1 as B-7(iv) required.
  Everything B-7 asked for is present. But SB1's refusal was scoped on the belief that granted
  FRONTIER runs are *already* refused; per N-1 they are not, so SB1's rule is a **live behaviour
  change** and its blast radius (every `COMPLEX_CODING` task, `profileResolver.ts:14`) needs restating
  under the true baseline.

---

## 5. Assertable-criteria audit — can SA-N pass without executing the real path?

Applying v0.1's SA-4/5/6 failure test to all fifteen.

| ID | Assertable without the real path? | Note |
|---|---|---|
| SA-1 | **No** | "must fail against today's code" is a mutation probe with a defined RED. Verified there is **no** `realpath`/`lstat`/`readlink` anywhere in `packages/bridge/src` and zero symlink tests, so RED is real. Windows junctions named. Model criterion. |
| SA-2 | **No** | `pathScope.ts:45` `if (allow.length === 0) return null` is the fail-open; `COMMON_PATH_KEYS` `:55-58` omits `outputPath`. Both RED states verified by reading. |
| SA-3 | **No** | "real container executed, not a config assertion." |
| SA-4 | **No** | Real backend + dead `DOCKER_HOST` + assert on the constructed class. `terminal_tool.py:1237` verified as the first branch. Correctly fixed. |
| SA-5 | **Partly — see AC-1** | Channel enumeration is right in form, incomplete in list. |
| SA-6 | **No** | Two distinct container IDs, with both vendored defaults pinned. Both verified real. |
| SA-7 | **No** | Replay an approved hash against different argv, observe refusal. |
| SA-8 | **No, but unbuildable** | The probe (force `env_type` to a container value with no container present, assert guards still run at all three sites) is excellent and the three sites are verified. Blocked by N-4. |
| SA-9 | **No** | Real container + enumerate `docker inspect` Mounts against the allowlist. **But see AC-2** — the allowlist must expect the default host binds per N-2, or this criterion is written against a configuration nobody runs. |
| SA-10 | **No** | Real container **on the egress network**; the `--network=none` caveat is the key insight. |
| SA-11 | **No** | Plant both payloads, assert both neutralised. |
| SA-12 | **No** | Honest self-labelling as a regression guard; `server.ts:159` verified. |
| SA-13 | **Partly — see AC-3** | "assert id + digest + flags + mounts + argv all present" is satisfiable by asserting the **log record's shape**. A log that faithfully records a *wrong* flag set passes. |
| SA-14 | **No** | "assert a **live** orphan is reaped" — RED is guaranteed by `docker.py:172`'s `status=exited`. Strong. |
| SA-15 | **No** | `pnpm install` / `git fetch` genuinely succeeding is unfakeable. The correct adoption criterion. |

### Residual leaks (non-blocking, but fix before build)

**AC-1 — SA-5's channel list is incomplete.** It names `TERMINAL_DOCKER_EXTRA_ARGS`, `_VOLUMES`,
`_ENV`, `_FORWARD_ENV`, the per-task override registry, prompt, task field, model output, MCP args. A
full enumeration of `TERMINAL_*` in `terminal_tool.py` yields three more that widen the boundary:
- **`TERMINAL_CONTAINER_PERSISTENT`** — flips tmpfs `/workspace` to a **host bind** (`:1172` → `:610`).
  Per N-2 this is the single most security-relevant of the set.
- **`TERMINAL_SANDBOX_DIR`** — relocates the bind **source** (`get_sandbox_dir`, `docker.py:578`).
- **`TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE`** — `auto_mount_cwd` (`:1075` → `:1254` → `:598-603`),
  which turns on E-2 against the **live repo** rather than the sandbox dir.
Also `TERMINAL_DOCKER_IMAGE` (image substitution) and `TERMINAL_DOCKER_RUN_AS_HOST_USER`. Add all of
them, one probe each; SA-5's whole value is that the list is closed.

**AC-2 — SA-9's allowlist must be derived from the corrected default.** Per N-2 the default mount set
includes host binds for `/workspace` and `/root`. Either SB2 changes the default (copy-in/copy-out per
SB2a, which is the right answer) **and** SA-9 asserts their absence, or SA-9 must expect them. As
currently written against v0.2's wrong premise, it is ambiguous which — and that ambiguity is exactly
how a criterion becomes the builder's to define.

**AC-3 — SA-13 should assert against ground truth, not shape.** Require the audit record's flag set
and mount set to be compared to the **actual** `docker inspect` output of the container it describes,
so a faithful log of a wrong configuration fails. Otherwise SA-13 tests the logger, not the run.

---

## 6. The three deliberately-UNVERIFIED items — is marking them enough?

Marking them is **the right call and a genuine improvement** — refusing to assert what was not checked
is the direct lesson of §0. Two of three are safely quarantined; one is not.

| Item | Quarantined? | Assessment |
|---|---|---|
| §9 item 4 — SB2a **scanner path list** | **Yes** | Explicitly *"must be checked before it becomes a criterion."* SA-11 does not depend on the list: it names two concrete payloads (`.git/hooks/post-checkout`, `vitest.config.ts`) and requires both neutralised. A criterion over two named files needs no exhaustive list. Clean. |
| §9 item 7 — **seccomp interpreter blocking** | **Yes** | Explicitly *"must not become a criterion until checked,"* and §9 item 7 concedes the honest conclusion: *"execution control is not implemented — the real controls are mounts + network + approval content."* No SA depends on it. It appears only in OQ-6, where an open question belongs. I confirmed `grep -c seccomp docker.py` → **0**, so the backend pins nothing. Correctly handled. |
| §9 item 8 — **registry/git egress allowlist feasibility** | **NO** | **SA-15 depends on it directly.** SA-15 is *"`pnpm install` and `git fetch` **succeed** in the secure default configuration"* and is labelled *"the adoption criterion — if this fails, the control gets switched off and the work is wasted."* Its only stated mechanism is item 8's gateway-mediated egress-allowlisted fetch — whose feasibility is `UNVERIFIED`. So the criterion the PRD itself calls decisive rests on an unverified mechanism, and §9 item 8 simultaneously declares SB4 *"a precondition for SB2's adoptability."* |

*Fix for the third:* make the feasibility spike an explicit **deliverable of SB4, ordered before SB2
is authorised** — measure whether pnpm's registry set (plus `git fetch` over HTTPS to the configured
remotes) can be allowlisted through a proxy on this host — and state that SA-15 is **blocked** until
it returns. Marking a dependency UNVERIFIED does not quarantine it when a criterion consumes it; the
quarantine has to be structural.

---

## 7. Slice ordering — is v0.2 shippable in the stated sequence?

**Mostly coherent, with one real contradiction and one consequence of N-2.**

*What is right, and it is most of it.* SB0's honesty is exemplary — *"SB0 hardens `packages/bridge` —
the path §1 says the dangerous tools NEVER traverse. SB0 delivers ZERO mitigation for the motivating
threat"* — and it is verified true (`toolFilter.ts:60` excludes `sourceServerId === 'hermes'`;
`checkPath` runs only inside `registry.executeTool:214-220`). It ships first because it is cheap and
correct, and that is stated as the reason. The startup-refusal move SB0→SB1 is correct on both
grounds v0.2 gives (§2 corollary 5, and dependence on SB1's policy). SB2a-before-SB3 is right, and the
rationale — *"a worktree is precisely what the host toolchain operates on, so SB3 without SB2a makes
E-2 worse"* — is exactly the point. SB3's Windows 9p/virtiofs measurement is properly marked
`UNVERIFIED` with the adoption consequence spelled out. SB6 is a genuine addition.

**The contradiction.** §9 item 8 states *"this makes SB4 a precondition for SB2's adoptability"* while
§6 orders SB4 **after** SB2 and SB2a. Both cannot hold. If SB2 ships with `--network=none` and no
gateway-mediated dependency fetch, then per §9 item 8's own prediction — which the prior G1R made at
high confidence and v0.2 endorses — the first real `COMPLEX_CODING` task fails on `pnpm install` and
`TORQCLAW_ALLOW_UNSANDBOXED_TERMINAL=1` becomes permanent. **The PRD identifies its own adoption
failure mode and then schedules the fix after the thing that triggers it.** Either SB4's
dependency-fetch path lands with or before SB2, or SB2 must ship explicitly **operator-opt-in only**
with SA-15 deferred and that limitation stated in SB2's own text. Resolve it in the document, not at
build time.

**The N-2 consequence.** SB2a is ordered as a P1 predecessor of SB3 on the belief that E-2 is opt-in.
With E-2 default-on, SB2a's copy-in/copy-out becomes a **peer of SB2** — SB2 without it delivers
containment of the process while leaving the default host-bind egress channel open, which is precisely
the "confinement of the container is insufficient" conclusion §5 reaches. Re-derive the ordering from
the corrected premise.

**Dependency summary as it should read:** SB0 (independent) → SB1 (independent, but see N-1 re: its
true baseline) → **new P0 unconditional FRONTIER grant refusal** → SB2 **+** SB2a (peers) with SB4's
fetch path → SB2b (guard inversion, blocked on OQ-4) → SB3 (blocked on SB2a **and** a Windows
measurement) → SB5 → SB6 (can land anytime; the audit log should precede SB2's acceptance so SA-13 has
something to assert against).

---

## 8. §9 item 9's jurisdiction call — is specify-don't-fix right?

**Yes. This is handled correctly and I would not change it.**

`CLAUDE.md:34` is unambiguous ("Do not touch `E:\TORQ-CONSOLE`"), the `proxy_secret_required` default
lives in that image, and §9 item 9 says so explicitly: *"**Specified here, not fixed here** — it needs
either an operator change in that repo or an explicitly authorized session rooted there."* That is the
right disposition of a cross-jurisdiction finding: the analysis travels, the edit does not. Three
things make it more than a disclaimer:

- **The PRD is honest that the fix is not delivered.** The words "not fixed here" appear in the item.
  A reader cannot come away believing this document closes it.
- **The specification is actionable in the other lane** — `proxy_secret_required` defaults to `true`
  with startup refusal if unset, i.e. *"the insecure mode requires an explicit act rather than an
  omission,"* which is the same fail-closed shape as the rest of the PRD. Whoever picks it up needs no
  further design.
- **The severity is scoped without being minimised.** It records the operator's ruling that
  loopback-only on a host with no internet path is **not an exposure and needs no rotation**, then
  correctly refuses to let that settle the design question, citing §2 corollary 2: *"no internet on
  this host" is ambient state, and a control that is safe only because of it is not a control.* That
  is the right distinction between **incident response** (nothing to do) and **design** (fix it as if
  the host were reachable), and getting it right in a public repo without overstating a credential
  exposure is careful work.

The part that **is** in this lane — the TTL/orphan reaper — is correctly retained as SB6 with SA-14,
and the reaper gap is verified (`docker.py:172` filters `status=exited`, so a live orphan is never
swept). I independently corroborated the live condition's aftermath: the four `torq-console-verify:*`
containers now show `Exited (137) 18 minutes ago`, consistent with the operator having stopped them.

One refinement, non-blocking: add a **cross-lane tracking line** (an issue reference or a named owner)
so "specified, not fixed" has a place to be discharged. Otherwise the finding lives only inside a PRD
about a different subject, and the pattern this repo's memory records is that unowned findings do not
get fixed.

---

## 9. Non-blocking notes

1. **The §0 self-indictment is the best thing in this document.** *"I measured a bench reproduction of
   the artifact instead of the artifact"* plus the §3 evidence rule plus a named list of what is
   deliberately unverified is the correct response to a rejection, and it is rare. N-1 and N-2 are
   failures to *execute* that rule, not failures to adopt it. The rule is right; hold it.
2. **v0.2's three corrections-of-G1R are all three correct.** `--network=none` **is** emitted
   (`:573`); labels and a reaper **do** exist (`:799-801`, `:172`); `/tmp` exec **is** a documented
   tradeoff (`:326`, `:334`). The prior verdict read parameter defaults where it should have read
   argv assembly. Recording that a reviewer was wrong, with citations, is correct behaviour by the
   reviewed party and should not be discouraged.
3. **`--memory-swap` (OQ-6) is still only an open question.** `docker.py:562-563` emits `--memory`
   alone; swap therefore exceeds the limit. Cheap to close — one flag.
4. **SB6's concurrency cap deserves a number.** "Nothing caps concurrent sandboxes… N×512MB host DoS"
   is correct but unquantified. Note that `docker.py` receives `memory` from
   `container_memory` defaulting to **5120** MB (`terminal_tool.py:1229`), not 512 — so the DoS
   arithmetic in §6 SB6 understates itself by 10×. Worth correcting for its own sake.
5. **`skip_pre_tool_call_hook=True` appears at three vendored call sites**
   (`tool_executor.py:1207`, `:1249`, `agent_runtime_helpers.py:1823`). I checked all three: they are
   **benign** — the hook already fired in the enclosing layer and the flag prevents double-firing. No
   bypass. Recording it so a future reviewer does not have to re-derive it, and so an implementer does
   not "fix" it.
6. **`capability.ts` `P4_EXEC` vs `approval_hook.py:23-27`** — the `process` divergence is carried
   forward in SB5's note. Verified: the `_GATED` regex includes `process`. Keep the note; SB5 will
   hit it.
7. **The bridge MCP servers' side of the boundary is still unstated** (prior non-blocking note 10).
   `terminal_power` allows host-side namespaces including `desktop_commander`; containing `terminal`
   while a host-side desktop-automation namespace is grantable in the same profile is a boundary with
   a door beside it. One sentence in §5 would close the inference gap.
8. **`docker.py:783` argument ordering.** `validated_extra` is appended **after** `security_args`, so
   a user-supplied duplicate flag wins. Relevant to B-5's residue; worth one line in §3's
   `docker_extra_args` row.
9. **§6 SB3's `.torq/worktrees/` parenthetical is correct** and I re-confirmed no product code creates
   them. Keep it.
10. **§8 is the right standard and should be quoted into the build brief verbatim.** *"A probe
    reported without its RED output is not a discharged probe"* is the sentence that would have caught
    v0.1's SA-4/5/6, and it will only work if the implementer is held to the recorded output.

---

## 10. Final verdict

# REJECT

**Fix N-1 through N-4 (plus AC-1/AC-2/AC-3 and the §7 ordering contradiction), then re-submit for
Gate-1.** Seven of the prior nine blockers are genuinely closed and the two that are not (B-5's
mechanism, B-7's baseline) are small. This is one revision away, and it is a much shorter revision
than the last one.

The reason it cannot pass as v0.2 is narrow and specific. This document's central methodological claim
is that **every control row is verified against the emitter, and an uncited row is not a control.**
That rule is correct and I applied it: 17 of 20 rows verify exactly, and all three of v0.2's
corrections to the prior reviewer are right. But the two claims the document leans on hardest — "the
gateway already refuses every FRONTIER granted run" and "the default workspace is tmpfs, so E-2 is
opt-in" — are **both false**, and both fail in the *same way §0 apologises for*: a line was read
without its enclosing condition. `dispatch.ts:262` does call the fence, but `:496` gates it on a
flag that is off by default. `docker.py:626` does emit a tmpfs `/workspace`, but it sits in an `else`
whose `if` is true by default.

The direction of both errors is what makes them blocking rather than editorial. Both understate live
exposure: one tells the operator a closed hole is closed when it is open, the other tells them a
default-on host-execution channel is opt-in. And each is load-bearing for a slice — N-1 inverts SB5's
role from "retire a fence" to "build one," N-2 moves SB2a from P1 polish to a P0 peer of the
containment slice itself. Approving on the strength of a citation rule that the document's own two most
important citations fail would be approving the pattern this repo's memory names as its recurring
defect, in the review whose explicit job was to catch it.

N-3 is the finding no amount of citation checking would have surfaced, and the one I would most want
carried into the build regardless of what happens to this document: **SB2's chosen fail-closed seam
fails open.** `plugins.py:1678` logs a throwing hook at WARNING and executes the tool. The seam is
still the right seam — the prior G1R was right to name it and v0.2 was right to adopt it — but a
containment verifier there must express failure as a **returned block**, never as a raised exception,
and SA-16 must prove it by making the verifier throw for real.

None of this requires abandoning the design. The threat model is right, §5 is a real contribution, the
slicing is sound once SB4's fetch path and SB2a are reordered, and the acceptance criteria are now
mostly unfakeable — SA-1, SA-4, SA-6, SA-10, SA-14 and SA-15 are genuinely good criteria that would
each catch a real regression. Correct the two miscitations, make the hook total, split the vendored
edit into its own blocked slice, and this is a document I would approve.

---

*Reviewed by G1R (`claude-opus-5`) — the seat `CLAUDE.md` §2 names for G1R, so no substitution
applies. 2026-08-17, branch `phase1-server-owned-authority`, HEAD `57bdd4e`. No repo file modified
except this review. No commits, no push. Two Docker experiments, both `--rm`, no socket mounted, both
exited and auto-removed; no pre-existing container started, stopped, or removed; all probe artifacts
deleted and their absence confirmed. No `.env` values or secrets appear above.*
