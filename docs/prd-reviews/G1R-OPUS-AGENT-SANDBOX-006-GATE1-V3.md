# G1R Gate-1 third review — PRD-TCLAW-AGENT-SANDBOX-006 v0.3

**Seat:** G1R — independent design reviewer.
**Model / seat disclosure:** `CLAUDE.md` §2 names **Opus 5** for the G1R seat, and I am
`claude-opus-5`. **No substitution applies.** This is the named seat reviewing at its named authority.
**Date:** 2026-08-17 · **Branch:** `phase1-server-owned-authority` · **HEAD:** `1776938`
**Target:** `docs/PRD-TCLAW-AGENT-SANDBOX-006.md` v0.3 (909 lines, commit `36e89bf`), read in full.
**Prior verdicts read in full:** `…-GATE1.md` (v0.1, REJECT, 9 blockers) and `…-GATE1-V2.md` (v0.2,
REJECT, 4 blockers N-1..N-4), both authored by different fresh Opus-5 G1R threads.
**Context:** fresh thread, no authoring context. Repo is PUBLIC; no `.env` values or secrets appear
below. No repo file was modified except this review.

---

## VERDICT: **APPROVE_WITH_CONDITIONS** — 0 blockers, 1 must-fix-before-build correction

**The evidence rule was executed, not merely restated.** That was the primary question this review was
convened to answer, and the answer is unambiguous. I sampled **21 claims** across §1a, §3, §3b, §6,
§7 and §9 — reading the cited line, then walking outward through **every** enclosing branch and
**every** variable default — and **all 21 reachability chains hold**. I checked in both directions,
weighting hardest the claims that would flatter the document. I found **no** claim whose reachability
fails in either direction.

The four v0.2 blockers are **all genuinely closed**, and three of them are closed by findings that
resolve **against** the document's own interest:

- **N-4** — the wrapper-only escape from the vendored edit **does not exist**, and v0.3 says so,
  costing itself the dissolution of a stop condition. I verified the structural reason independently.
- **N-2** — v0.2's "SCOPE CORRECTION" is withdrawn as wrong; the default **is** a host bind at both
  `/workspace` and `/root`, promoting SB2a from P1 polish to a P0 peer and enlarging the program.
- **N-1** — the fence fix is verified from **source**, not from `72b4d36`'s commit message, and the
  consequence drawn (SB5 must **extend** the fence) is the harder of the three available framings.

The single condition is narrow and is **not** an evidence-rule failure: **§9 item 9 asserts in the
present tense that `docs/security/agent-execution-isolation-audit.md` "carries a cross-reference
line" to the cross-lane finding. It does not.** That file has no `proxy_secret_required` reference,
no `torq-console` reference, and is unmodified since `ccc94b9`. This is the unenforced-claim pattern
in miniature — an accountability mechanism described as existing when it is unwritten — and it is the
one place in v0.3 where a statement about the world outruns the world. It is a **one-line fix**, not a
redesign, which is why it conditions rather than blocks.

---

## 1. What I verified, and how

| Artifact | Method |
|---|---|
| `docs/PRD-TCLAW-AGENT-SANDBOX-006.md` v0.3 | read in full (909 lines, two passes) |
| `…-GATE1.md` (v0.1) / `…-GATE1-V2.md` (v0.2) | both read in full |
| `gateway/src/dispatch.ts` | `:250-275`, `:475-520`, `:550-570` — all three fence sites + the predicate body |
| `gateway/src/server.ts` | `:415-505` — **both** APPROVE_TOOL branches read in full; `:155-163` |
| `gateway/src/c2Broker.ts`, `principalBridge.ts`, `profileResolver.ts` | `collabEnabled` call graph; `resolveProfile` broadening check read in full |
| `tests/frontier-grant-fence-unconditional.test.ts` | test-case enumeration |
| `tools/environments/docker.py` | `:165-182`, `:325-370`, `:555-640`, `:645-720`, `:728-736`, `:765-805`, `:1118-1150`; `grep -c` for `read-only`, `seccomp`, `memory-swap` |
| `tools/terminal_tool.py` | `:253-266`, `:894-905`, `:945-985`, `:1070-1080`, `:1165-1190`, `:1225-1265`, `:1875-1890` |
| `tools/approval.py` | all three guard sites read with enclosing `def` and skip set |
| `tools/code_execution_tool.py` | `:1093-1120` |
| `hermes_cli/plugins.py`, `agent/tool_executor.py`, `agent/agent_runtime_helpers.py` | **all four** swallow sites + the block-directive validator |
| `mcp_wrapper/approval_hook.py` | `_GATED` regex, `register()` |
| `bridge/src/pathScope.ts`, `toolFilter.ts`, `registry.ts` | cited ranges; `grep realpath\|lstat\|readlink` → **0 hits** |
| `docs/security/agent-execution-isolation-audit.md` | read for the claimed cross-reference — **absent** |
| Live Docker 28.3.2 | **3 experiments**, all `--rm`, no socket mounted, artifacts deleted |

**Docker hygiene.** I created exactly three ephemeral `alpine:latest` containers, all `--rm`, all
auto-removed. `docker ps -a` before and after my work shows **16 containers**, identical — none of
them mine. The pre-existing containers (torq-buzz, torq-writer, torq-console-verify, torq-live-e2e)
were **not** started, stopped, or removed by me; I only listed them. The four `torq-console-verify:*`
containers now read `Exited (137) 8 hours ago`, consistent with §9 item 9's note. My probe directory
under the session scratchpad was deleted and its absence confirmed. The repo working tree is
unchanged apart from this new file.

---

## 2. Did v0.3 EXECUTE its own evidence rule? — the primary question

**Yes.** Both prior failures were failures to *execute* an adopted rule, so restatement proves
nothing. I therefore treated every sampled claim as guilty: read the cited line, then walked outward
through each enclosing `if`, then resolved each variable in those conditions to its default with its
own `file:line`.

### 2a. The 21-claim reachability sample

| # | Claim | Cited at | Reachability walked | Holds? |
|---|---|---|---|---|
| 1 | `frontierGrantFenced` no longer consults `collabEnabled()` | `dispatch.ts:505-508` | bare `function`, no enclosing branch; body is `tier === FRONTIER && grantedTools.length > 0`. `grep collabEnabled dispatch.ts` → only the **import** and the **doc comment** | ✔ |
| 2 | Executor fence precedes the availability check | `dispatch.ts:262-265` | inside `dispatchLegacy`; `isHermesAvailable()` check sits at `:269`, **after** | ✔ |
| 3 | Failover fence precedes `taskStore.create` and the dynamic import | `dispatch.ts:558-562` | verified: fence → `taskStore.create` → `await import('./failover.js')` in that order | ✔ |
| 4 | Legacy `APPROVE_TOOL` refuses FRONTIER before ROUTING and dispatch | `server.ts:489-495` | inside `if (cmd.data.decision === 'APPROVE')`; the refusal `break`s **before** `reqEmit('ROUTING'…)` and **before** `dispatch(reqB, diag)`. This is the default path (`c2Broker.ts:197` returns `legacy` when the flag is off) | ✔ |
| 5 | C2 `APPROVE_TOOL` refuses FRONTIER before dispatch | `server.ts:433-439` | inside `if (c2.kind === 'decided')` → `if (d.status === 'approved')`; refusal `break`s before `dispatch` | ✔ |
| 6 | `/root` host bind is **unconditional within** the persistent branch | `docker.py:614-616` | `if self._persistent:` (`:610`) → `-v {home}:/root` at `:614-616` with **no inner `if`**. The `bind_host_cwd` gate at `:617` applies only to `/workspace`. **v0.3's new claim is exactly right** | ✔ |
| 7 | `/workspace` host bind is the default | `docker.py:618-622` | `:610` true → `:617` `if not bind_host_cwd and not workspace_explicitly_mounted:` — `bind_host_cwd` requires `auto_mount_cwd`, default `"false"` (`terminal_tool.py:1075`); `workspace_explicitly_mounted` requires user config. Both false by default → branch entered | ✔ |
| 8 | Persistence defaults True at **two** independent points | `terminal_tool.py:1231`, `:1172` | `persistent = cc.get("container_persistent", True)` at `:1231`; `os.getenv("TERMINAL_CONTAINER_PERSISTENT", "true")` at `:1172`. Both read individually | ✔ |
| 9 | tmpfs `/workspace` is the **non-default** arm | `docker.py:626` | sits in the `else:` at `:623` of `if self._persistent:` `:610` | ✔ |
| 10 | `task_id` collapses to `'default'` | `terminal_tool.py:1881-1885` | `effective_task_id = _resolve_container_task_id(task_id)` at `:1885`; the comment at `:1881-1884` states the collapse verbatim | ✔ |
| 11 | `persist_across_processes` defaults True at two points | `terminal_tool.py:1183-1185`, `:1259` | both read; `:1259` is `cc.get("docker_persist_across_processes", True)` | ✔ |
| 12 | `container_memory` defaults **5120** MB, not 512 | `terminal_tool.py:1229` | `memory = cc.get("container_memory", 5120)`; the env default is `_parse_env_var("TERMINAL_CONTAINER_MEMORY", "5120")` at `:1085` and the fallback `5120` at `:1089`. **Three** consistent 5120s | ✔ |
| 13 | `--memory-swap` is never emitted | — | `grep -c "memory-swap" docker.py` → **0**; `:562-563` emits `--memory` alone | ✔ |
| 14 | `--read-only` never emitted | — | `grep -c "read-only" docker.py` → **0** | ✔ |
| 15 | Privilege-drop caps added **by default** | `docker.py:365-367`; `terminal_tool.py:1175` | `_build_security_args` returns `args + _PRIVDROP_CAP_ARGS` when **not** `run_as_host_user`; `TERMINAL_DOCKER_RUN_AS_HOST_USER` defaults `"false"` → added | ✔ |
| 16 | `--user` never emitted on native Windows | `docker.py:733`, `:423-426` | `if run_as_host_user:` (`:730`, default false) **and** `_resolve_host_user_spec` returns `None` when `os.getuid` is absent | ✔ |
| 17 | `docker_extra_args` appended **last**, after `security_args` | `docker.py:776-784` | `all_run_args = security_args + user_args + writable_args + resource_args + volume_args + env_args + validated_extra`. `validated_extra` is last (`:783`); `:770-773` filters only non-strings. Comment `:768` even says *"Appended last so they can override defaults if needed"* | ✔ |
| 18 | Orphan reaper filters `status=exited` only, default on | `docker.py:172`; `terminal_tool.py:897` | filters verified verbatim; gate is `if not container_config.get("docker_orphan_reaper", True): return` → default on | ✔ |
| 19 | Reuse probe is a **different mechanism** from the reaper | `docker.py:1122` | `_find_reusable_container` `def` at `:1122`; filters on `hermes-task-id` + `hermes-profile` and returns `(id, state)`. Distinct from `:172`'s global exited-sweep. v0.3's MC-2 correction is right | ✔ |
| 20 | `pathScope.ts:44` is the fail-open; `COMMON_PATH_KEYS:54-57` omits `outputPath` | `pathScope.ts:44`, `:54-57` | `if (allow.length === 0) return null; // …unconstrained` at exactly `:44`; the key array spans exactly `:54-57` and omits `outputPath`. **Both line numbers exact** | ✔ |
| 21 | Credential / skills / cache families all mounted `:ro`, no opt-out flag | `docker.py:648-716` | all three loops read; each appends `…:ro`; the only guard is a `try:` whose `except` merely logs at DEBUG | ✔ |

**21 of 21 hold.** No cite was off even by a line offset — including the ones v0.2 got wrong by two
(`approval.py:1597-1598`, self-corrected in §3a as MC-3).

### 2b. I attacked the flattering claims hardest, per v0.3's own corollary

Three claims would have **reduced** the document's apparent work if true. All three survived:

- **"`collabEnabled` is gone"** (row 1) — the flattering reading is that the hole is closed. I did not
  accept the doc comment: I grepped `collabEnabled` across `dispatch.ts` and confirmed the only
  surviving occurrences are the `import` at `:19` and the historical note at `:494`. The predicate
  body is two clauses.
- **"the legacy path now refuses"** (row 4) — this is the branch v0.2 got wrong. I read the whole
  `APPROVE_TOOL` handler rather than the cited line, confirming the refusal is inside the
  default-configuration arm and precedes both the emit and the dispatch.
- **"`check_dangerous_command` is dead, so two sites not three"** (§3 below) — the flattering
  direction is *fewer* sites to edit. Verified anyway; it holds.

---

## 3. The six directed claims — each resolves as v0.3 states

### 3.1 N-4: the wrapper-only option does NOT work — **CONFIRMED, and the reasoning is exactly right**

This was the finding most worth attacking, because if a wrapper-only path existed it would dissolve
an operator stop condition and v0.3 would have missed a cheap win.

**It does not exist.** Read from source:

```
terminal_tool.py:1878-1879  config = _get_env_config(); env_type = config["env_type"]   # ONE variable
              :2025             env_type=env_type,          -> _create_environment (BACKEND)
              :2053         approval = _check_all_guards(command, env_type)   (GUARD)

code_execution_tool.py:1098  env_type = _get_env_config()["env_type"]                   # ONE variable
                      :1105  _guard = check_execute_code_guard(code, env_type)   (GUARD)
                      :1114  if env_type != "local": return _execute_remote(...)  (BACKEND)
```

At both sites a single local binding feeds the guard and the dispatch, with no intervening
reassignment. Setting `TERMINAL_ENV=local` (`:1073`) makes the guards run **and** makes execution
local — `_create_environment` returns `_LocalEnvironment` as its first branch (`:1237-1238`). That is
turning the sandbox off, not inverting the guard.

**I also verified v0.3's import-binding asymmetry, which is the subtler half and is correct:**
`terminal_tool.py:255-257` imports `check_all_command_guards` at **module scope** as
`_check_all_guards_impl`, so a post-import patch of `tools.approval` misses it;
`code_execution_tool.py:1104` imports **inside the function**, so it is late-bound and would pick a
patch up. Two targets, two timing requirements — exactly as OQ-4 option (b) records.

**Assessment:** this is the strongest single passage in v0.3. It is a negative result reported
against the author's own interest, with the mechanism traced rather than asserted, and it explicitly
names the temptation it resisted. It is the direct antidote to the v0.1/v0.2 failure mode.

### 3.2 `check_dangerous_command` is dead code — **CONFIRMED**

Repo-wide grep across `engines/hermes_kernel`, excluding vendored tests:

```
tools/approval.py:1037        def check_dangerous_command(...)          <- the definition
tools/approval.py:1596        # ...in check_all_command_guards / check_dangerous_command.   <- a comment
tools/thread_context.py:10    ``check_dangerous_command``'s ... branch and                  <- a docstring
```

Every other hit is under `vendor/hermes-agent/tests/`. I additionally checked for dynamic/late-bound
invocation (`getattr(approval…)`, `globals()[…]`) and found none; `test_managed_browserbase_and_modal.py:160`
patches it as a kwarg in a test double, which is not a production caller. And I confirmed the live
call graph positively: `_check_all_guards` is referenced at exactly `terminal_tool.py:260` (def),
`:262` (delegation) and `:2053` (the one call), and `check_execute_code_guard` at exactly
`code_execution_tool.py:1104-1105`. **Two live sites, not three. Confirmed.**

### 3.3 N-3 is FOUR swallow sites — **CONFIRMED, all four swallow AND permit**

| Site | Verified behaviour |
|---|---|
| `plugins.py:1673-1685` | `for cb in callbacks: try: ret = cb(**kwargs) … except Exception as exc: logger.warning(…)` then `return results` — the throw appends **nothing** to `results`, so no block directive, and the loop continues |
| `agent_runtime_helpers.py:1670-1683` | `try: block_message = get_pre_tool_call_block_message(…) except Exception: pass` → `:1684 if block_message is not None:` is False → **executes** |
| `tool_executor.py:345-358` | `except Exception: block_message = None` → `:360 if block_message is not None:` False → **executes** |
| `tool_executor.py:836-849` | `except Exception: pass`, `_block_msg` unset → `:852 if _block_msg is None:` → **executes** |

All four both swallow and permit. **The corollary also verifies exactly**: `plugins.py:1890-1898`
requires `isinstance(result, dict)`, `result.get("action") == "block"`, **and**
`isinstance(message, str) and message` — an empty-string message falls through the loop to
`return None`, i.e. **a block with an empty message is silently ignored**. v0.3's "a block with an
empty message is not a block" is literally true at `:1896`.

This is the most important requirement in the PRD and it is now specified normatively, with
`BaseException` rather than `Exception`, with the returned-block-not-raised discipline, and with
SA-16 proving it against **each of the four callers**. Correctly handled.

### 3.4 N-2 withdrawal — **CONFIRMED, including both NEW claims**

The default **is** a host bind. `if self._persistent:` (`:610`) → `-v {home}:/root` (`:614-616`)
→ `if not bind_host_cwd and not workspace_explicitly_mounted:` (`:617`) → `-v {workspace}:/workspace`
(`:618-622`). Persistence True at `:1231` **and** `:1172`.

**New claim A — `/root`'s bind is unconditional within the persistent branch: TRUE.** The
`bind_host_cwd` gate at `:617` is nested *after* the `/root` extend at `:614-616`. `/root` is bound on
**every** persistent run regardless of any cwd-mount setting. v0.2 never noticed `/root` at all; v0.3
found it and drew the right §5 consequence (shell history, `.gitconfig`, `.npmrc`, `.ssh/config`
persisting to a host directory read by the **next** container).

**New claim B — one shared host-bound directory across the top agent and every `delegate_task`
child: TRUE.** `effective_task_id = _resolve_container_task_id(task_id)` (`:1885`), and the comment at
`:1881-1884` states the collapse verbatim. Combined with `persist_across_processes` default True
(`:1183-1185`, `:1259`) and `_find_reusable_container` (`docker.py:1122`), the composition in §3b is
sound.

**Independently reproduced on this host** (Docker 28.3.2, `--rm`, no socket, `--cap-drop ALL
--security-opt no-new-privileges --pids-limit 256 --memory 64m`, host-bind `/workspace`):

```
host-side:  -rwxr-xr-x 1 Barry 197121 21 ... /workspace/.git/hooks/post-checkout
            lrwxrwxrwx 1 Barry 197121 11 ... /workspace/escape -> /etc/passwd
```

Executable host-side, owned by the operator, symlink persisted with a host-interpreted target. **E-2
reproduces, and per the verified default it is default-on.** Artifacts deleted; absence confirmed.

The consequence v0.3 draws — SB2a promoted to a **P0 peer** of SB2, with the sentence *"That is not a
sandbox; it is a sandbox-shaped audit finding"* — is the correct and the more expensive reading.

### 3.5 N-1 — fix verified from SOURCE; the SB5 framing is right

Verified from the working tree, not from `72b4d36`'s message:

- `frontierGrantFenced` (`dispatch.ts:505-508`) is `diag.tier === ComputeTier.FRONTIER &&
  (req.payload.grantedTools?.length ?? 0) > 0`. **No flag, no env read.**
- `grep collabEnabled packages/gateway/src/dispatch.ts` → the `import` at `:19` and the doc comment at
  `:494`. Nothing else.
- Both `APPROVE_TOOL` branches refuse `diag.tier === ComputeTier.FRONTIER` before `dispatch`
  (`server.ts:433-439` C2; `:489-495` legacy — the default-configuration path).
- `tests/frontier-grant-fence-unconditional.test.ts` exists: 5 `it` blocks plus a 3-case parametrized
  `it` over unset/`true`/`false` = **8 test cases**, matching v0.3's "8 assertions across all three
  flag states." The unset case is present and is the load-bearing one.

**On v0.3's claim that SB5 must EXTEND the fence — I agree, and it is the harder of the three
framings.** v0.2 said "retire"; my own prior verdict said "build." Both are now wrong: a real
unconditional refusal exists at HEAD, so SB5 is neither retiring nor building — it is converting
"refuse all" into "refuse all except an exact-argv match," with the refusal remaining the **default
arm**. v0.3 states that constraint normatively, backs it with a §12 stop condition against
re-conditionalisation, and cites the `dispatch.ts:481-489` doc comment recording that this mistake has
now been made three times. That is the correct design conclusion and the correct guardrail.

### 3.6 SB6 arithmetic — **CONFIRMED, and I verified the swap claim empirically**

`container_memory` defaults **5120** MB at three consistent points (`:1085`, `:1089`, `:1229`), not
512. `--memory-swap` is never emitted (`grep -c` → 0). Measured on this host:

```
docker run --rm --memory 64m           -> memory.max=67108864  swap.max=67108864   (2x total)
docker run --rm --memory 64m --memory-swap 64m -> memory.max=67108864  swap.max=0
```

Docker's `--memory-swap = 2 × --memory` default is confirmed by execution. So a container nominally
capped at 5120 MB can consume **10240 MB** of memory+swap, and §9 item 10's "20× what v0.2 stated" is
arithmetically correct. Moving it out of OQ-6 into a required SB2 flag is right — it is one flag with
no trade-off, and an open question is for a decision that has one.

---

## 4. Are SA-1..SA-16 unpassable by assertion or by mocking the backend?

v0.1's SA-4/5/6 failed exactly this way; v0.2 partially fixed it. **v0.3 closes the remaining three
leaks (AC-1, AC-2, AC-3) and adds SA-16.** My audit of all sixteen:

| ID | Passable by asserting config / mocking the backend? | Note |
|---|---|---|
| SA-1 | **No** | Mutation probe with a real RED — I re-confirmed **0 hits** for `realpath\|lstat\|readlink` in `packages/bridge/src` and zero symlink tests |
| SA-2 | **No** | `pathScope.ts:44` fail-open and `COMMON_PATH_KEYS:54-57` omitting `outputPath` both verified at the exact lines |
| SA-3 | **No** | "Real container executed, not a config assertion" |
| SA-4 | **No** | Real backend + genuinely dead `DOCKER_HOST` + assert on the **constructed class**, not an error string. `:1237-1238` verified as the first branch |
| SA-5 | **No** — closed by AC-1 | The channel list is now 16 rows and I checked it for omissions: `TERMINAL_CONTAINER_PERSISTENT`, `TERMINAL_SANDBOX_DIR`, `TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE`, `TERMINAL_DOCKER_IMAGE`, `TERMINAL_DOCKER_RUN_AS_HOST_USER`, `_PERSIST_ACROSS_PROCESSES` all added. One probe each |
| SA-6 | **No** | Two **distinct container IDs** + pins both vendored defaults (`:1183-1185`/`:1259` and `:1881-1885`), both verified real |
| SA-7 | **No** | Replay against a different argv **and** assert the default arm is still refusal — the second half is what stops an SB5 that only proves the allow path |
| SA-8 | **No** — and now correctly BLOCKED | Isolated into SB2b, gated on OQ-4. Both live sites named with `def` and skip lines; the dead third is flagged as "for completeness, not a live path" |
| SA-9 | **No** — closed by AC-2 | The v0.2 ambiguity is resolved in the **refuse** direction: host binds are REFUSED, not expected, and the criterion "must fail against today's configuration — that is its RED." Asserts at the container via `docker inspect`, not in config |
| SA-10 | **No** | Real container **with a network attached**; explicitly notes `--network=none` does not exercise it |
| SA-11 | **No** | Three named payloads (hook, `vitest.config.ts`, out-of-tree symlink) — depends on **no** UNVERIFIED list. I reproduced two of the three on this host |
| SA-12 | **No** | Honestly self-labelled a regression guard; `server.ts:159` verified |
| SA-13 | **No** — closed by AC-3 | Now compares the audit record's flag and mount set **field-by-field against the actual `docker inspect`** of the container it describes, with a defined RED (emit one flag that was not passed). Tests the run, not the logger |
| SA-14 | **No** | "Assert a **live** orphan is reaped"; RED guaranteed by `docker.py:172`'s `status=exited` |
| SA-15 | **No** — and now BLOCKED | `pnpm install` / `git fetch` genuinely succeeding is unfakeable |
| SA-16 | **No** | Forces the verifier to raise **for real**, asserts the tool did not execute **and** no `_LocalEnvironment` was constructed **on the class**, and requires running it against **each of the four** swallow sites. RED is guaranteed by `plugins.py:1678-1684` |

**None of the sixteen is passable by asserting a config value or mocking the backend.** Two additional
protections matter given this repo's recorded defect of tests that pass against deliberately broken
code: §7's header forbids config assertions and mocked backends globally, and §8 now adds the
**no-op-mutation** rule — *"a recorded RED must be traceable to a verified change in the file under
test"* — written directly from the `python3`-absent incident that manufactured a false green earlier
in this program. That is precisely the trap that produced a false green today, and it is now spec.

---

## 5. Is the UNVERIFIED quarantine honest?

**Yes — and the v0.2 leak is genuinely closed, structurally rather than by relabelling.**

| Item | Quarantined? | Assessment |
|---|---|---|
| §9 item 4 — SB2a **scanner path list** | **Yes** | SA-11 names three concrete payloads and states "Depends on no `UNVERIFIED` list." No criterion consumes the list |
| §9 item 7 — **seccomp** interpreter blocking | **Yes** | Appears only in OQ-6. I re-confirmed `grep -c seccomp docker.py` → **0**. No SA depends on it, and §9 item 7 concedes the honest conclusion that execution control is not implemented |
| §6 SB3 — **Windows 9p/virtiofs** measurement | **Yes** | Marked UNVERIFIED with the adoption consequence stated; SB3 is listed BLOCKED on it in §6a. No SA depends on it |
| §9 item 8 — **registry/git egress allowlist** | **Yes, now structurally** | This was v0.2's leak. Now an explicit **SB4-spike deliverable ordered before SB2 is authorised**, SA-15 marked `BLOCKED` in §7 with "must not be scheduled, attempted, or reported as discharged before then," and §12 adds "Authorising SB2 before the SB4-spike returns" as an **operator stop condition**. Three independent mechanisms, not one label |

I traced every acceptance criterion for a hidden dependency on a quarantined item and found **none**.
SA-11 was the risk (scanner list) and is explicitly severed; SA-15 was the v0.2 leak and is now
blocked at three levels. **No acceptance criterion secretly depends on an UNVERIFIED item.**

---

## 6. Is the slice ordering coherent and shippable in sequence?

**Yes.** The v0.2 contradiction is genuinely resolved rather than papered over. v0.2 had §9 item 8
calling SB4 "a precondition for SB2's adoptability" while §6 shipped SB4 **after** SB2. v0.3 §6a
resolves it **in favour of item 8** — the load-bearing claim — and says so explicitly.

The authoritative order in §6a is internally consistent and I checked each stated dependency against
the document's own text:

```
SB0                     independent; states plainly it delivers ZERO mitigation for the motivating threat
SB1                     independent
[N-1 refusal            ALREADY LANDED (72b4d36) — correctly marked "not a slice"]
SB4-spike               gates SB2's authorisation           <- resolves the v0.2 contradiction
SB6-audit               precedes SB2's acceptance so SA-13 has ground truth  <- resolves AC-3's dependency
SB2 + SB2a + SB4 fetch  PEERS, both P0                      <- resolves the N-2 consequence
SB2b                    BLOCKED ON OQ-4                     <- resolves N-4
SB3                     BLOCKED on SB2a AND the Windows measurement
SB5                     EXTENDS the 72b4d36 fence
SB6                     remainder
```

Three orderings that were wrong or absent in v0.2 are now correct: **SB4-spike before SB2** (the
contradiction), **SB6-audit before SB2's acceptance** (otherwise SA-13's ground-truth comparison has
nothing to compare against — a dependency AC-3 created and v0.3 noticed), and **SB2a as a P0 peer**
rather than a P1 predecessor of SB3.

Two things I checked for and did not find: no slice is listed before a slice it depends on, and no
slice carries a criterion blocked on an undischarged stop condition — SA-8 moved to SB2b, and v0.3
states plainly that *"until OQ-4 is ruled and SB2b ships, believed containment still disables the
command guards. SB2 alone does NOT close M-3"*, with a release-note obligation. That sentence costs
SB2 its headline and is the right call.

**SB0's honesty deserves the same credit the prior review gave it**, now improved: v0.3 adds the §1b
justification (`registry.ts:135` spawns MCP servers as **host** processes via `StdioClientTransport`,
unconditional — I verified it), so SB0 ships for a stated reason rather than because it is easy.

---

## 7. Is the "no containers, no tests" disclosure honest?

**Yes, and the attribution is explicit and correctly placed.** §0's closing and §3c both mark the
experimental results as carried from prior reports rather than re-run. §3c is headed *"What survives
the flag set anyway (G1R, demonstrated on this host)"* and each entry names its source: E-2 says
*"The second G1R independently reproduced both E-2 and a persisting `escape -> /etc/passwd` symlink"*;
E-7 says *"Re-confirmed by the second G1R"*; E-13 and E-8 are presented as prior-G1R findings.

Crucially, where v0.3 adds to a carried result, it marks the addition and its own basis separately:
E-2's *"Reachability, corrected in v0.3: the host bind is the DEFAULT (`:610` → `:618-622`,
`:614-616`), so E-2 is default-on"* is a **source-read** claim layered on a **carried experimental**
claim, and the two are distinguishable. **The document does not read as though it re-verified them.**
No criterion depends on a carried experiment — SA-11 restates the payloads as things a future probe
must plant, not as things already proven.

I re-ran E-2 myself anyway, and it reproduces (§3.4 above). E-7's `host.docker.internal` routability
I did not re-test; it is attributed and no criterion rests on it.

---

## 8. Does §12 assign OQ-4 to the OPERATOR?

**Yes, correctly and at four independent points**, with no reviewer seat named anywhere in the chain:

- §11 OQ-4 header: *"**REQUIRES AN OPERATOR RULING**; SB2b is BLOCKED on it"*, with a four-row
  mechanism table (a)-(d) giving cost and risk for each, and a **recommendation for the operator to
  accept or reject** — (a) with (d)'s discipline. That is the right shape: the reviewer recommends,
  the operator decides.
- §6 SB2b: *"**BLOCKED ON OQ-4 OPERATOR RULING**"* in the slice heading.
- §7 SA-8: *"**BLOCKED ON OQ-4**"* in the criterion itself.
- §12: *"Any change to vendored Hermes beyond the wrapper — including §9 item 3's `approval.py`
  inversion, which is now isolated in SB2b and BLOCKED ON OQ-4"* as an operator stop condition.

Option (c) is listed in the table as **INVESTIGATED AND RULED OUT** with a pointer to §9 item 3a, so
the operator is not asked to rule on an option that was already disproven. Correct.

The related §9 item 9 cross-lane disposition also assigns ownership to **the operator (King Flowers)**
as "the only party with authority in both lanes" — the right party, since the fix lives in
`E:\TORQ-CONSOLE` which `CLAUDE.md:34` forbids this lane from touching. See the one condition below
for the defect in *how* that ownership is recorded.

---

## 9. THE ONE CONDITION (must fix before build; not a blocker)

### C-1 — §9 item 9 asserts a cross-reference line that does not exist

*Cited as:* §9 item 9, "CROSS-LANE TRACKING OWNER (added in v0.3)", lines 815-819:

> **Tracking artifact:** this section is the record of origin;
> `docs/security/agent-execution-isolation-audit.md` **carries** a cross-reference line to it so the
> finding is discoverable from the security-audit index rather than only from a PRD about a different
> subject.

*What the file says.* I read `docs/security/agent-execution-isolation-audit.md`. It contains:

- **no** occurrence of `proxy_secret_required`
- **no** occurrence of `torq-console` (case-insensitive)
- **no** occurrence of "cross-lane", "cross-reference", or "orphan"
- exactly one reference to this PRD, at `:157`, which predates the finding entirely: *"Recommended: a
  dedicated PRD (`PRD-TCLAW-AGENT-SANDBOX-006`) for Phase B"*

`git status` shows the file unmodified; `git log -1` on it returns `ccc94b9`, a PRD-005 console commit.
**The cross-reference line was never written.**

*Why this matters, and why it is a condition rather than a blocker.* The sentence is in the present
indicative — "carries" — describing a state of the world that does not obtain. It is the
unenforced-claim pattern this repo's memory names as its recurring defect, appearing in the very
paragraph whose purpose is to ensure a finding does not go unowned. The prior verdict asked for a
tracking line *because* "unowned findings do not get fixed"; v0.3 answered by **describing** the line
instead of **writing** it, which leaves the finding exactly as unowned as before while reading as
though it is not.

It is not a blocker because: it is documentation-of-documentation, not a control; no acceptance
criterion depends on it; the owner assignment and discharge condition around it are correct and
actionable; and the fix is one line in one file.

*Suggested fix — either is acceptable:*
1. **Write the line.** Add to `docs/security/agent-execution-isolation-audit.md` a short cross-lane
   entry naming the `proxy_secret_required` default, the TORQ-CONSOLE jurisdiction, the operator as
   owner, and a pointer to `PRD-TCLAW-AGENT-SANDBOX-006` §9 item 9. Then the PRD's sentence becomes
   true. **This is the better fix** — it is what the tracking mechanism was for.
2. **Or restate it as an obligation:** change "carries a cross-reference line" to "**must carry** a
   cross-reference line, to be added when this PRD passes Gate 1", so the document stops asserting an
   unwritten artifact.

Note the edit in option 1 lands in **this** lane (`docs/security/` in TorqClaw), not in
`E:\TORQ-CONSOLE`, so it trips no stop condition.

---

## 10. Prior blockers — closed vs not

### N-1 — **CLOSED.** Verified from source at HEAD `1776938`, not from the commit message.
`frontierGrantFenced` (`dispatch.ts:505-508`) carries no `collabEnabled()`; `grep` confirms the only
survivors are the import (`:19`) and the historical doc comment (`:494`). Both `APPROVE_TOOL` branches
refuse FRONTIER before dispatch (`server.ts:433-439`, `:489-495`), the legacy one being the
default-configuration path and refusing before the ROUTING emit as claimed. Regression guard exists
with 8 test cases across unset/`true`/`false`. §1a tabulates all five sites with enclosing conditions;
§10 restates the true three-row baseline including the honest admission that an **ungranted** FRONTIER
`COMPLEX_CODING` run still executes on the host, so SB1 is a live behaviour change and not a
formalisation of the status quo. That last point is v0.3 arguing **against** its own convenience.

### N-2 — **CLOSED.** The "SCOPE CORRECTION" is explicitly withdrawn as wrong with all four
sub-claims corrected; §3's two workspace rows now carry both branches, both defaults and both
`file:line`s; §3b composes the defaults into the shared-directory finding; SB2a is re-derived as a
**P0 peer**; SA-9 is disambiguated in the refuse direction; `TERMINAL_CONTAINER_PERSISTENT` and
`TERMINAL_SANDBOX_DIR` are added to SA-5. The two **new** claims (unconditional `/root` bind; task_id
collapse ⇒ one shared directory) are both true and were both absent from v0.2 and from my prior
verdict.

### N-3 — **CLOSED, and enlarged.** Four swallow sites, not two — I verified all four swallow and
permit. The normative requirement (total hook body, `try/except BaseException`, except arm **returns**
a block) is stated in the spec rather than left to the implementer, with the load-bearing constraint
"**the hook MAY NEVER RAISE**" called out explicitly and the reason given. The empty-message corollary
at `plugins.py:1890-1898` is verified true. SA-16 proves it against each of the four callers.

### N-4 — **CLOSED.** SA-8 split into **SB2b**, marked BLOCKED ON OQ-4 in the slice, in the criterion,
and in §12. OQ-4 enumerates four mechanisms with costs and risks and makes a recommendation for the
operator to rule on. Option (c) — the one my prior verdict speculated "appears to achieve the
inversion with no vendored edit at all" — was **investigated and disproven**, and I confirm the
disproof. The prior review was wrong on that point and v0.3 corrected it with source evidence.

### Also closed from the v0.2 residuals
- **AC-1** (SA-5 channel list) — six channels added; list re-checked for omissions.
- **AC-2** (SA-9 ambiguity) — resolved in the refuse direction with a defined RED.
- **AC-3** (SA-13 shape-vs-truth) — now a field-by-field comparison against `docker inspect`.
- **§7 ordering contradiction** — resolved in §6a in favour of §9 item 8.
- **B-5 residue** (`docker_extra_args` ordering) — now in §3's row and in SA-5: *"`validated_extra` is
  concatenated LAST (`:783`), after `security_args` (`:777`) — so a duplicate user flag overrides a
  security flag. The ordering is part of the vulnerability."* Verified at `:776-784`.
- **NB-4** (SB6 arithmetic) — corrected 512 → 5120, with the 10× understatement named.
- **NB-7** (bridge MCP servers outside the boundary) — now §1b, with `registry.ts:135` verified.

### Not closed
**None.** All four v0.2 blockers and all three AC leaks are discharged.

---

## 11. New defects introduced in v0.3

**One, and it is C-1 above** (the asserted-but-unwritten cross-reference line). I looked specifically
for the v0.1→v0.2 pattern of *new* errors appearing inside the fixes, since that is how v0.2 failed,
and found no other instance: every correction in §3a, §6a, §9 items 3a/4/8/10 and §1a verifies against
source.

Two things I checked and cleared:
- **§3's `--memory-swap` row** claims "swap exceeds the memory limit." Confirmed by execution, not
  taken on trust (2× is Docker's documented default and I measured it).
- **§1a's five-row table** could have overstated coverage by listing sites without their conditions.
  It does not — each row carries its enclosing condition, and the C2 row correctly notes that
  `decideApprovalC2` returns `legacy` when the flag is off (`c2Broker.ts:197`), which is what makes
  the legacy row the load-bearing one.

---

## 12. Non-blocking notes

1. **§0 is now a working rule rather than a confession.** v0.2 adopted the citation rule and failed to
   execute it; v0.3 adds parts (b) and (c) — every enclosing branch, every variable default — plus the
   adversarial-direction corollary, and then **executes them across the whole document**. The
   "Reachability column added in v0.3" in §3 is the visible mechanism. Hold this rule; it worked.
2. **The N-4 negative result is the best passage in the document** and should be quoted into the build
   brief. *"I record this as a negative result because the alternative — reporting the cheap option as
   viable without tracing the variable — is exactly the error class §0 exists to prevent, and it would
   have resolved in this document's favour."* That is the discipline this program has been missing.
3. **§8's no-op-mutation rule is new and important.** *"A recorded RED must be traceable to a verified
   change in the file under test"* — written from the `python3`-absent incident. This host does not
   have `python3`; a mutation script invoking it silently no-ops. Quote this verbatim into the build
   brief alongside "a probe reported without its RED output is not a discharged probe."
4. **§3's `docker_extra_args` row now carries the ordering**, closing B-5's residue at the spec level.
   The mechanism B-5 originally asked for — a wrapper-side allowlist of permissible extra args,
   default empty, with SB2 refusing to start when any `TERMINAL_DOCKER_*` var is set outside it — is
   still stated as a property ("the ENTIRE container flag set is gateway-owned") rather than a
   mechanism. SA-5's per-channel probe covers detection; consider naming the allowlist explicitly in
   SB1 so the implementer builds it rather than infers it. **Owed, not blocking.**
5. **`skip_pre_tool_call_hook=True`** at `tool_executor.py:1207`, `:1249`, `agent_runtime_helpers.py:1823`
   remains benign (the hook already fired in the enclosing layer). Recorded so no implementer "fixes"
   it. Carried from the prior review; unchanged.
6. **`capability.ts` `P4_EXEC` vs `approval_hook.py:23-25`** — the `process` divergence is real
   (`_GATED` includes `process`); SB5's note carries it. Verified again; keep the note.
7. **§9 item 9's severity scoping remains careful and correct** — it records the operator's ruling
   that loopback-only on a host with no internet path is not an exposure and needs no rotation, then
   refuses to let that settle the *design* question via §2 corollary 2. Getting that distinction right
   in a public repo without overstating a credential exposure is good work. Only the tracking-artifact
   sentence (C-1) is defective, not the disposition.
8. **The four `torq-console-verify:*` containers now read `Exited (137) 8 hours ago`**, consistent
   with §9 item 9's note that the operator stopped them. The reaper gap at `docker.py:172` is
   unchanged and SA-14 remains the right criterion.

---

## 13. Final verdict

# APPROVE_WITH_CONDITIONS

**Condition:** fix **C-1** — either write the cross-reference line into
`docs/security/agent-execution-isolation-audit.md`, or restate the PRD sentence as an obligation
rather than a fact. One line, this lane, no stop condition tripped. **No re-review required**; a
memory-writer or G2A check that the sentence and the file agree is sufficient.

This document failed twice for the same reason: it adopted a rule and did not execute it. The whole
purpose of this review was to determine whether v0.3 broke that pattern. **It did.** I sampled 21
claims across the sections where the prior failures lived, walked every enclosing branch and every
variable default, weighted the sample toward claims that would flatter the document, and found **21 of
21 reachability chains intact** — not one cite off, not one branch skipped, including the two lines
(`docker.py:626`, `dispatch.ts:262`) that sank v0.2.

Three findings resolve **against** the document, which is the strongest available evidence that the
adversarial-direction corollary is being applied rather than recited. The wrapper-only escape from the
vendored edit was investigated and **disproven**, keeping an operator stop condition alive that a
lazier answer would have dissolved — and my own prior verdict had speculated that option would work,
so v0.3 corrected its reviewer with source evidence. The `/workspace` default was corrected in the
direction that **enlarges** the program, promoting SB2a to a P0 peer and adding a `/root` bind and a
shared-directory finding that neither v0.2 nor I had noticed. And the fence framing was corrected
against **both** prior readings — v0.2's "retire" and my "build" — to the harder and correct "extend,
with refusal as the default arm."

The acceptance criteria are now sixteen, and I could not construct a pass for any of them by asserting
a config value or mocking the backend. SA-9, SA-13 and SA-16 close the three leaks the prior review
named; SA-16 in particular tests the one failure mode no amount of citation-checking would surface.
The UNVERIFIED quarantine is honest and, for the item that leaked in v0.2, now structural at three
independent points. The slice ordering resolves its predecessor's contradiction explicitly and in
favour of the load-bearing claim, and each stated dependency holds.

C-1 is real and it is the same defect class in miniature — an accountability artifact described rather
than created. I record it as a condition rather than a blocker because it is documentation about
documentation, no criterion consumes it, and the fix is one line. Rejecting a third time over it would
be ceremony, and this program cannot afford ceremony in place of judgement any more than it can afford
a rubber stamp.

**Fix C-1 and build.** The threat model is right, §5 is a genuine contribution, §3b is a finding the
prior two rounds both missed, the slicing is coherent in sequence, the stop conditions are assigned to
the operator, and the evidence rule that failed twice has now been executed under adversarial
sampling. This is a document I would approve, and I do.

---

*Reviewed by G1R (`claude-opus-5`) — the seat `CLAUDE.md` §2 names for G1R, so no substitution
applies. 2026-08-17, branch `phase1-server-owned-authority`, HEAD `1776938`. No repo file modified
except this review. No commits, no push. Three Docker experiments, all `--rm`, no socket mounted, all
auto-removed; `docker ps -a` shows 16 containers before and after, none of them mine; no pre-existing
container started, stopped, or removed. All probe artifacts deleted and their absence confirmed. No
`.env` values or secrets appear above.*
