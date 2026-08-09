# PRD — TORQCLAW TrustOS v2 (rev 2.0)

Supersedes: `PRD-TCLAW-TRUSTOS-001` rev 1.2 for Phases 2 and 3 only. Phases 0–1 are
closed and unchanged; Phases 4–6 carry forward from v1 untouched.

Status: **DRAFT — awaiting G1R design review, then operator approval to build**
Date: 2026-08-06
Base: `master` @ `02b7002`
Author: G1D (owner-level revision)
Research input: independent audit of vendored `hermes-agent` @ `bbf020e70` (Opus-class)

---

## 0. Why this revision exists

v1 specified Phase 2 as "**wire skill generation (5.0)**" plus provenance, rollback, and
policies — but left the *trigger* undefined and assumed TORQCLAW already overrode
upstream Hermes auto-deploy. A source-level audit of the vendored engine found both
assumptions wrong in ways that change the design:

1. **The claimed override does not exist.** `mcp_wrapper/server.py:298` states
   `draft_and_queue_skill` "Overrides Hermes auto-deploy." Nothing overrides anything.
2. **Upstream's write path is live and auto-activating**, suppressed today only by an
   accidental side-effect of a toolset allowlist written for a different purpose.
3. **The governed path is dead code** — `draft_and_queue_skill` has no autonomous caller.
4. **A stronger implementation already exists, unwired** — `verified_skill_store.py`
   (947 lines) has the digests, audit log, and rollback v1 asks for.

v2 therefore reorders Phase 2 to put *suppression before generation*, and adopts the
existing verified store instead of extending the weaker queue.

---

## 1. Verified baseline (source audit, 2026-08-06)

Every claim below was read in the tree. Phases 0–1 facts are carried from the v1
closeout and re-verified.

### 1.1 What is real and working

| Property | Evidence |
|---|---|
| Role authz enforced, default-deny | `gateway/src/authz.ts:99-128` |
| Receipts rebuildable from event log | `ops/receipts-rebuild.mjs`, `receipt-projection.test.ts` |
| Session + daily spend caps | `gateway/src/spend.ts:58,72,90` |
| Privacy override non-overridable | `router/src/engine.ts:68` |
| Honest headless approval | `channel-http/src/server.ts:98-108` |
| Gate | 991 TS / 43 files · 186 Py (1 skipped) · typecheck 12/12 · contracts 8 schemas 2 dirs · build 7/7 |

### 1.2 Upstream Hermes learning loop — as it actually is

- **Two loops.** Loop A: per-turn background review (`vendor/.../agent/background_review.py`).
  Loop B: curator maintenance pass (`vendor/.../agent/curator.py`).
- **Loop A trigger** — `vendor/.../agent/turn_finalizer.py:375-381`: fires when
  `_iters_since_skill >= skill_nudge_interval` (default 15; fallback 10), the counter
  resets only when `skill_manage` runs, accumulates across turns, and requires
  `skill_manage ∈ valid_tool_names`. It is **outcome-blind** — no success/failure input.
- **Loop A is tuned to over-generate.** `background_review.py:46-49`: *"Be ACTIVE — most
  sessions produce at least one skill update… A pass that does nothing is a missed
  learning opportunity."* Upstream relies on the curator to garbage-collect.
- **Auto-activation is real** — `tools/skill_manager_tool.py:959-964` clears the prompt
  cache and disk snapshot immediately on write, so the next prompt build re-enumerates
  the skills dir. A new skill is live with zero human review.
- **Upstream provenance is thin**: `created_by`, timestamps, counters. **No** source task,
  session, model, content hash, or version.
- **Upstream has its own approval gate, defaulting OFF** — `tools/write_approval.py:74-89`,
  and `write_approval_enabled` returns `False` on **any** config-load exception
  (`:85-87`), on an unknown subsystem (`:80-81`), and by default. A control that reports
  "disabled" on every error path is not a layer.
  *(Citation corrected per G1R: an earlier draft cited `:845-846`; the file is 493 lines
  and that line does not exist. A PRD whose thesis is "a comment claimed a control that
  did not exist" must not itself carry an unverifiable cite.)*

### 1.3 The gap — SEC-7 (must fix first)

`skill_manage` is absent from every TORQCLAW toolset allowlist
(`hermes_runner.py:140-146`: `web`, `files`, `terminal`, `code_execution` only), so
Loop A's guard fails and the review never spawns. **This is incidental.** The allowlist's
documented purpose is host-shell containment, not skill suppression.

`HERMES_FRONTIER_TOOLSETS="*"` returns `None` (`hermes_runner.py:163-167`) = upstream
full default = `skills` re-enabled = unapproved, auto-activated `SKILL.md` writes.
Nothing sets `skills.creation_nudge_interval: 0`; nothing sets `skills.write_approval: true`.

- **Exploitability today: LOW.** The var is unset in `.env` and `.env.example` (verified).
- **Structural fragility: HIGH.** One env var, no deny-list backstop, no assertion, no test,
  and the protection is undocumented as a security control — precisely what a future
  refactor removes while adding `skills` to a task type for a legitimate reason.
- **Honesty defect: the code comment claims a control that does not exist.**

---

## 2. Revised Definition of Done (Phases 2–3)

v1 §17 items restated with the mechanism that will prove each.

| # | Item | Proof |
|---|---|---|
| D1 | Upstream auto-deploy is affirmatively suppressed, not incidentally | Test asserts the **three conjuncts of `turn_finalizer.py:377-379` cannot all be true**. Precisely: under `HERMES_FRONTIER_TOOLSETS="*"` the `skills` toolset IS restored and `skill_manage` MAY appear in `valid_tool_names` — the loop stays dead because `_skill_nudge_interval == 0` (L1b). Claiming "the wildcard cannot re-enable skills" would be false; the honest claim is that the **trigger** is dead in every configuration |
| D2 | Skill generation fires under policy | trigger evaluated gateway-side on terminal tasks; test proves it fires on allow and does not on deny |
| D3 | Every skill has provenance | source task, session, model, sha256 digest, version, timestamp — persisted, on the receipt |
| D4 | No activation without approval | write path unreachable except through operator decision; test |
| D5 | Rollback **provably deactivates the skill and enumerates every retained copy** | **Renamed per G1R RC-8 — "provably removes" was false.** The store's `rollback()` (`verified_skill_store.py:296-360`) deliberately never deletes an installed digest; it re-points `state["active"]`. Five residue targets: (1) `skills/<name>/` package dir, (2) `.usage.json` entry, (3) `.skills_prompt_snapshot.json`, (4) in-process `_SKILLS_PROMPT_CACHE`, (5) **the store's own `versions/<id>/<digest>/` tree** — omitted from the earlier draft and the only residue always present. Proof = a test that walks every residue root and asserts the returned manifest matches. Per invariant 14, an undisclosed-residue check that is not tested is not a control |
| D6 | never-learn-private enforced | private tasks never produce a draft; test |
| D7 | Channels have clamping policies | clamp at the sole `GatewayRequest` constructor, required param |
| D8 | Channel identity authenticated | per-channel hashed tokens; no shared secret |
| D9 | No cross-channel data access | resume guard on channel identity (fixes SEC-1) |
| D10 | Channel receipts show source + applied policy | fixes H-4 hardcoded `'torq-console'` |

---

## 3. Architecture — governed learning

### 3.1 Current state (the defect)

```text
  TORQCLAW task ──> Hermes engine ──> turn_finalizer
                                          │
                          _iters_since_skill >= 15 ?
                                          │
                        requires skill_manage ∈ toolset
                                          │
              ┌───────────────────────────┴──────────────┐
              │ TODAY: guard fails — 'skills' not in the │
              │ allowlist. INCIDENTAL, not designed.     │
              │ HERMES_FRONTIER_TOOLSETS="*" re-arms it. │
              └───────────────────────────┬──────────────┘
                                          ▼  (if re-armed)
                              skill_manager_tool write
                                          │
                          ~/.hermes/skills/<n>/SKILL.md
                                          │
                        clear_skills_system_prompt_cache()
                                          ▼
                        LIVE ON NEXT TURN — no human review

  Meanwhile, the governed path:
    draft_and_queue_skill ──> skill_queue ──> (nothing ever calls this)
```

### 3.2 Target state

```text
 ┌──────────────────────── ENGINE (vendored, unmodified) ─────────────────────┐
 │  Loop A suppressed AFFIRMATIVELY — layers, strongest first:                │
 │    L1  'skills' asserted absent from enabled_toolsets — IN OUR CODE,       │
 │        at hermes_runner.py:342 construction. Repo-versioned + CI-tested.   │
 │    L1b agent._skill_nudge_interval = 0 set POST-CONSTRUCTION on the        │
 │        instance we build (agent_init.py:1230 sets it as an attribute;      │
 │        we overwrite it). Does NOT depend on operator config.               │
 │    L2  ~/.hermes/config.yaml skills.creation_nudge_interval: 0 —           │
 │        DEFENCE IN DEPTH ONLY. Operator-owned file OUTSIDE the repo:        │
 │        unversioned, absent on a fresh machine, not CI-verifiable.          │
 │        MUST NOT be the primary control (see invariant 11).                 │
 │    L3  skills.write_approval: true — weakest layer; write_approval.py      │
 │        :845-846 FAILS OPEN on import error. Never rely on it alone.        │
 │  Loop B (curator) disabled — but it forks its own agent and does not read  │
 │  our enabled_toolsets, so L1 does not cover it. Needs its own control.     │
 └──────────────────────────────────┬─────────────────────────────────────────┘
                                    │ terminal task + telemetry
                                    ▼
 ┌──────────────────────── GATEWAY (TORQCLAW owns) ───────────────────────────┐
 │  TRIGGER POLICY  (outcome-gated — the inverse of upstream)                 │
 │    state == 'completed'        AND  no blockedOn                           │
 │    AND NOT containsSensitiveData         (D6, never-learn-private)         │
 │    AND taskType ∈ domain allowlist                                         │
 │    AND repetition: plan_hash or tool-sequence seen >= N times              │
 │    AND upstream negative-list respected (no env-dependent failures,        │
 │        no negative tool claims — background_review.py:124-143)             │
 └──────────────────────────────────┬─────────────────────────────────────────┘
                                    ▼
 ┌──────────────── verified_skill_store  (EXISTS, 947 lines, unwired) ────────┐
 │  stage → review → approve(digest-bound) → activate → disable → rollback    │
 │  sha256 package digest · append-only audit · capability-diff gate          │
 │  crash reconcile · containment hardening                                   │
 └──────────────────────────────────┬─────────────────────────────────────────┘
                                    ▼ operator decision only
 ┌────────────────────────────────────────────────────────────────────────────┐
 │  ACTIVATE: write package + register .usage.json {pinned:true, provenance}  │
 │  ROLLBACK must undo ALL FOUR:                                              │
 │    1. skills/<name>/  (whole package: references/ templates/ scripts/)     │
 │    2. .usage.json entry                                                    │
 │    3. .skills_prompt_snapshot.json                                         │
 │    4. in-process _SKILLS_PROMPT_CACHE (clear_skills_system_prompt_cache)   │
 │  Residue policy: .curator_backups/*.tar.gz and .archive/ MUST be declared  │
 │    in scope or explicitly excluded — upstream never truly deletes.         │
 └────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Trigger policy — rationale

Upstream fires on **effort** (iteration count) because it has no outcome signal and can
afford noise; the curator cleans up. TORQCLAW has the inverse cost function: every draft
is operator toil, so it must fire on **outcome**. TORQCLAW already owns strictly more
signal than upstream's trigger consumes — `tasks.state`, `blockedOn`, `costUsd`,
`engineUsed`, `taskType`, the full `task_events` tool sequence, and retry counts.

> **CORRECTION (G1R RC-4).** An earlier draft called `plan_hash` a ready-made task-shape
> fingerprint. **It is not, and using it would have produced a permanently dead trigger.**
> `_validate_plan` (`attempt_ledger.py:515-528`) requires the hashed plan to contain
> **`taskId`** — unique per submission — plus `taskDeadlineMs` (absolute wall-clock),
> provider ids, and budget. The identical prompt submitted three times yields three
> different hashes, so a repetition count never exceeds 1 and the trigger never fires for
> any input. A test written against a fixture that reuses one `taskId` would pass over a
> dead production branch — the exact defect class this revision exists to catch.
>
> **Required instead:** a purpose-built fingerprint computed gateway-side over normalized
> task shape — `taskType` + normalized prompt digest + observed tool sequence from
> `task_events` — explicitly EXCLUDING `taskId`, timestamps, provider identity, and
> budget. Open Decision 1's threshold N is meaningless until that equivalence class is
> defined, so N must be re-derived against the new fingerprint, not carried over.

**Do not port the threshold.** Gate on outcome, not effort.

Adopt upstream's **negative list verbatim** (`background_review.py:124-143`): never
capture environment-dependent failures or negative tool claims, because they *"harden
into refusals the agent cites against itself for months."* That is battle-tested policy.

---

## 4. Phase 2 — Governed Learning MVP (revised ticket plan)

| Ticket | Scope | Why this order |
|---|---|---|
| **P2-0** | **Affirmative suppression (SEC-7).** L1 assertion + L1b `agent._skill_nudge_interval = 0` **in `hermes_runner.py`** (repo-versioned, CI-tested); L2/L3 config as declared defence-in-depth only; a curator control that does not rely on `enabled_toolsets`; regression test that `HERMES_FRONTIER_TOOLSETS="*"` cannot re-arm the loop; correct the false comment at `server.py:298` | **Ships first.** Closing an ungoverned write path precedes building a governed one. Pure security fix, no dependency on the rest of Phase 2. |
| **P2-1** | Adopt `verified_skill_store`. **Re-scoped per G1R RC-5/RC-6 — this is new wiring, not a swap**, and splits into: (a) a **publish step** from `versions/<id>/<digest>/` into the Hermes skills dir — `activate()` (`:228-229`) targets the store's own tree and has zero references to `~/.hermes`, so **an activated skill is one Hermes never loads**; (b) a **package-format decision** — `_read_package` (`:690-692`) requires exactly `["SKILL.md","skill.json"]` and rejects subdirectories (`:688`), so a skill with `references/`/`templates/`/`scripts/` **cannot be staged at all**; (c) an **MCP/gateway surface** — the store has no MCP tool and no `queue_id` concept, while `bridge/src/hermes.ts:194` calls `decide_skill`; (d) the **`editedMarkdown` contract break** — `contracts/src/commands.ts:19-26` ships approve-with-edits, but editing changes the digest and invalidates a digest-bound one-use token. Recommended resolution: edit → re-stage → re-approve against the new digest | Two disconnected implementations exist; only the weaker is reachable. Consolidate before extending — but re-estimate first. |
| **P2-2** | Provenance model (D3): source task, session, model, sha256, version, timestamp; surfaced on the receipt | Prereq for rollback and for the dashboard |
| **P2-3** | Trigger policy engine (D2, D6) gateway-side + domain allow/deny + never-learn-private | Needs P2-1's store to deposit into |
| **P2-4** | Rollback (D5), all four undo targets + residue assertion | Needs provenance to know what to undo |
| **P2-5** | Learning Dashboard v1 — source evidence, provenance, decisions | Read surface last |

**P2-0 is separable and should merge on its own.** It is a security fix with no dependency
on the rest of Phase 2, and leaving it bundled delays it behind feature work.

---

## 5. Phase 3 — Channel Presence Fabric

Scope unchanged from `SCOPE-PHASE-3-CHANNEL-PRESENCE-FABRIC.md` (G1R-reviewed,
APPROVE-WITH-CHANGES, 9 RCs). Summarized here for continuity; that document governs.

Ticket order: **P3-1** (policy contract + pure clamp) → **P3-1b** (wire clamp into
`enrichCommand`, required param) → **P3-2** (channel registry, hashed tokens, resume
guard, real `sourceChannel`) → **P3-3** (gateway-side rate limits) → **P3-4/P3-5**
(Slack / Discord) → **P3-6** (Channel Manager UI).

Carried defects: **SEC-1** cross-channel session hijack (live today, exploitable once a
second adapter ships), **SEC-2** shared credential defeats per-channel policy, **H-4**
`sourceChannel` hardcoded to `'torq-console'`.

Carried ruling: **per-channel tool allowlists are CUT** — unenforceable, because
`getToolsForTask(taskType, tier)` takes no policy argument and the FRONTIER toolset is
chosen inside the Python engine. The UI must not display one.

---

## 5b. Adopted prior art (OpenClaw, Buzz, Hermes)

Researched at source 2026-08-06. Both repos verified public, active (pushed same day),
and read directly — not reconstructed. **OpenClaw** (MIT, TS monorepo, local gateway,
multi-surface) is TORQCLAW's closest structural analogue and the high-yield target.
**Buzz** (Block, Apache-2.0, Rust/Nostr team workspace) solves a multi-tenant problem
TORQCLAW does not have; it contributes four narrow ideas, not architecture.

| # | Adopt | From | Lands in | Phase |
|---|---|---|---|---|
| A1 | **Longest-first secret redaction** — sort known secret values by descending length before scrubbing, so a short secret that is a substring of a longer one cannot leave a partial leak | Buzz | `gateway/src/export.ts` (upgrade, not rebuild) | **Now** — hours |
| A2 | **Access groups that grant nothing** — named allowlist aliases conferring no roles/permissions; a *missing* group authorizes nobody | OpenClaw | channel policy schema | P3-1 |
| A3 | **Monotonic tool-narrowing chain** — ordered layers where each may only further restrict; deny is irreversible; reject `allow`+`alsoAllow` in one scope | OpenClaw | `bridge/src/toolFilter.ts` + policy resolution | P3-1/P3-1b |
| A4 | **Approval targets decoupled from request origin** — approvals route to configured operator targets, never the originating chat; universal `/approve <id> <decision>` fallback; `askFallback: deny` when no UI is reachable; unknown/malformed/mismatched/missing/timed-out **all fail closed** | OpenClaw | gateway approval dispatch + channel registry | P3-2 |
| A5 | **Pairing gate** — 8-char codes excluding `0O1I`, 1h TTL, **max 3 pending per account** (anti-DoS), persisted | OpenClaw | channel registry + `db/schema.sql` | P3-2 |
| A6 | **`installPolicy`** — one trusted *local* command run before any skill install, receiving metadata + staged source path, applied on **every** path including the dependency installer, failing closed on invalid output | OpenClaw | beside `verified_skill_store.py` | P2-1 |
| A7 | **Manifest inspectable before code executes** — capability contracts, dangerous-flag/SecretRef declarations, sensitivity hints, all cheap to read without booting the extension | OpenClaw | extension manifest in `packages/contracts` | P2-2 |
| A8 | **Shared correlator across planes** — run-start nonce binding lifecycle events to logs | Buzz | receipts / event log | P2-2 |

**A4 resolves the headless-approval problem structurally**: a bot surface never renders a
dialog — it emits a request ID, and the *operator's* surface adjudicates. That turns
"channel seats cannot approve" from a role check into a routing property.

### Rejected, with reasons

- **OpenClaw's exec-approval trust model.** Its docs state exec approvals are "**not a
  per-user auth boundary**" — gateway-authenticated callers are trusted as operators.
  That **conflicts with TORQCLAW's invariant** that channel seats structurally cannot
  approve. Take A4's routing and fail-closed mechanics; **reject the trust model beneath
  it.** TORQCLAW's is stricter and stays stricter.
- **`autoApproveCidrs`** — auto-approval keyed on network position is hidden authority.
  Loopback-only makes it pointless regardless.
- **Plugin-owned `allow-always` persistence.** Letting the *requesting* component own its
  approval memory is authority laundering. If adopted, persist centrally with a receipt.
- **Trust-signal scoring** (stars +5, recent commits +5) as an install gate — popularity
  is not security. It may *inform* an operator; it must never *be* the gate.
- **Buzz's Nostr/relay/multi-tenant substrate** and **agents-as-room-members** — solves
  federation TORQCLAW does not have, and moves the authority boundary off the gateway.
- **Buzz handing an agent private key to an arbitrary provider binary.** Steal their
  *candor pattern* (enumerate which properties hold despite an untrusted component), not
  the arrangement.
- **OpenClaw's marketplace/plugin surface** (68+ plugin docs, ClawHub) — scope trap and
  unbounded review burden. Adopt the manifest and install policy; skip the marketplace.
- **Prompt-injection defense by content-wrapping alone** — OpenClaw's own threat model
  rates residual risk high and lists output validation and skill sandboxing as **missing
  P0s**. TORQCLAW's approval-before-write is *stronger* than that mitigation; never trade
  down, and if adopting their skill lifecycle, do not inherit the sandboxing gap.

## 6. Invariants added by this revision

11. **A security control must be affirmative, asserted, and tested.** A protection that
    works only as a side-effect of unrelated configuration is not a control. Where the
    tree claims a control in a comment, the claim is a defect until the mechanism exists.
12. **Prefer wiring an existing verified implementation over extending a weaker one.**
13. **Learning gates on outcome, never on effort.**
14. **Rollback is defined by residue, not by the delete call.** A rollback that passes its
    own test while the artifact remains in a backup tarball has not rolled back.

---

## 6b. Invariant 11 applied to this document (G1R RC-9)

Invariant 11 demands every security control be **affirmative, asserted, and tested**.
Scoring v2's own proposals, because a revision premised on catching unenforced claims
must survive its own standard:

| Control | Affirmative | Asserted | Tested | Verdict |
|---|---|---|---|---|
| L1 — `skills ∉ enabled_toolsets` | yes | yes | yes | **PASS** |
| L1b — `_skill_nudge_interval = 0` | yes | yes | yes | **PASS** |
| L2 — `config.yaml` | no | no | no | correctly demoted; **declared, not claimed** |
| L3 — `write_approval` | no | no | no | **NOT A LAYER** — fails open (`:85-87`) |
| Curator control | no | no | no | **must reach PASS in P2-0** (RC-3 test) |
| D5 residue disclosure | no | no | no | **must reach PASS in P2-4** (RC-8 test) |
| D4 end-to-end activation | partial | no | no | **must reach PASS in P2-1** (RC-5) |

**Suppression rests on exactly two repo-versioned controls: L1 and L1b.** Any statement
implying four layers is inflation. Three rows above are currently FAIL; each is assigned
to the ticket that must close it, and none may be claimed as delivered until it does.

## 6c. Operator rulings (2026-08-07)

**GREEN LIGHT: P2-0 only. Not coupled to P2-1.**

Rationale recorded verbatim, because it is a sharper statement of the defect class than
§1.3: *"TORQCLAW currently appears to satisfy a governance invariant partly because the
relevant upstream capability is unreachable under today's configuration, rather than
because TORQCLAW explicitly suppresses it. That's an accidental safety property."*

**P2-0 establishes exactly one invariant:**

> No Hermes skill creation, activation, or creation nudge may bypass TORQCLAW's governed
> skill path, **regardless of toolset configuration**.

Four merge gates, operator-required:

1. **Configuration-independent** — tests exercise the normal allowlist *and*
   `HERMES_FRONTIER_TOOLSETS="*"`. The wildcard is the regression case that matters most.
2. **Fail-closed** — if upstream changes and `_skill_nudge_interval` disappears or cannot
   be set, TORQCLAW must not silently continue claiming governed skill creation. Detect
   and surface the incompatibility.
3. **No collateral damage** — suppress autonomous creation/nudging only; normal Hermes
   execution and the existing governed workflow must be unaffected.
4. **Fix the misleading claim** — until P2-1 actually wires a governed replacement into
   the Hermes-loaded skill tree, TORQCLAW must not claim that it does.

Plus one adversarial test that protects **the claim, not the implementation**:

```text
Given:  HERMES_FRONTIER_TOOLSETS="*"
        upstream skill capability available
        a task that would normally trigger skill creation/nudging
Then:   no autonomous skill becomes active
        no unreviewed skill reaches the Hermes-loadable skills tree
        TORQCLAW records/surfaces suppression
```

### P2-0 — BUILT and G2A-VERIFIED (2026-08-07)

Sonnet 5 Builder → Opus 4.8 G2A: **PASS-WITH-NOTES, nothing blocks merge.** Awaiting the
operator merge gate. Not pushed, no branch, no commit.

Implementation, all in TORQCLAW-owned code (`vendor/` verified byte-clean, submodule
pointer unchanged at `bbf020e70`):

- **L1b (primary)** — `_suppress_skill_nudge(agent)` in `hermes_runner.py`, called
  **unconditionally** immediately after the `AIAgent(...)` constructor and before
  `run_conversation`. Sets `_skill_nudge_interval = 0`, verifies the attribute exists
  before writing, and **reads back** after. Either failure raises
  `SkillNudgeSuppressionUnavailable` and fails the task closed.
- **L1 (secondary)** — raises if `skills` appears in an explicit toolset allowlist.
  Documented in-line that it *cannot* hold under `HERMES_FRONTIER_TOOLSETS="*"`, where
  `enabled` is `None`; L1b is what holds there. **No overclaim.**
- **Evidence** — a `SYSTEM` task event records the resolved suppression state, so
  "TORQCLAW records/surfaces suppression" is independently observable.
- **Docstring corrected** — `server.py` no longer claims to override auto-deploy; it now
  states plainly that there is no autonomous caller and that P2-1 is out of scope.

**Sabotage-verified with teeth.** G2A designed eight independent sabotages; every one was
caught by the predicted test. Two proved the assertions are load-bearing rather than
decorative: weakening the check to `_skill_nudge_interval == 0` alone is still caught by
the evidence-emit and fail-closed tests, and a plausible *wrong-conjunct* fix
(zeroing `_iters_since_skill` instead) is caught **only** by the strong three-conjunct
assertion. Local suite green.

**Bypass traced and closed.** G2A found the background-review fork hardcodes
`enabled_toolsets=["memory","skills"]` (`background_review.py:470-475`) — a skills grant
independent of TORQCLAW's allowlist. It is unreachable because `_spawn_background_review`
is gated on `(_should_review_memory or _should_review_skills)` (`turn_finalizer.py:393`):
P2-0 falsifies the second, and `skip_memory=True` (`hermes_runner.py:425`) falsifies the
first by leaving `_memory_store` unpopulated (`turn_context.py:209-213`). **`skip_memory=True`
is therefore load-bearing for the P2-0 invariant while existing for an unrelated reason** —
now being regression-tested so flipping it trips CI.

### P2-1 — HELD pending redesign

G1R's finding changes P2-1 materially: the control loop does not close.

```text
  Intended:  Generate → Stage → Review → Approve → Activate → Hermes loads it

  Actual:    Generate → Stage → Review → Approve → "Activate"
                                                        │
                                                 isolated store
                                                        ✕
                                                     Hermes
```

That is a redesign, not a patch. **No P2-1 activation-path changes are authorized.**

**Redesign completed 2026-08-07 (design only, nothing built).** Two findings change it:

**The unlock — publish to an external dir, not Hermes' own skills tree.** Hermes supports
`skills.external_dirs` (`vendor/.../agent/skill_utils.py:341-421`), scanned directly with
**no snapshot caching** (`prompt_builder.py:1249-1252`, verified). Publishing there instead
of into `<hermes_home>/skills/` eliminates two of the five residue targets *by
construction*: the prompt snapshot can never contain a governed skill, and `.usage.json`
is local-dir-only (`tools/skill_usage.py:86`). Local skills also take precedence on name
collision, so a governed skill can never silently shadow the operator's own. The
integration point becomes a documented upstream config key rather than a directory we
co-inhabit with Hermes' writer — the strongest form of wrap-don't-rewrite.

**R1 — a live governance-claim defect in the code we were about to promote.**
`verified_skill_store.py:639` executes `del audit[:-MAX_AUDIT_ENTRIES]`, silently
discarding the oldest records at 1,000 entries **with no marker**, while the module
describes the log as append-only. Verified. This is the same defect class as the
`draft_and_queue_skill` docstring — a claimed governance property that is not mechanically
enforced — and it sits inside the "strong" implementation. Ships as **P2-1h**, a small
independent correctness fix: either rename the claim or make truncation observable.

**Package format: ship narrow, extend later.** The store's triple-lock (`:688`, `:691`,
`:739-740`) rejects directory packages outright. P2-1 governs single-file skills and must
**fail loudly and specifically** on a directory package — silently flattening one would
publish an artifact differing from what the operator reviewed, i.e. a digest-bound
approval authorizing something else. Directory packages become P2-2. Accepted cost:
governed skills are temporarily less expressive than native Hermes skills, and the
dangerous ones (those with `scripts/`) are exactly the ones deferred.

**Legacy migration: freeze, do not backfill.** Existing `skill_queue` rows have no digest
and no recorded model, so provenance cannot be reconstructed — fabricating it is the
prohibited move. Pending rows are superseded and re-drafted; already-approved rows are
reported as `provenance: none (pre-P2-1)`, never retroactively claimed as governed. **The
single most important line-level change: delete the legacy filesystem write at
`skill_queue.py:77-82`**, or two writers target the skills tree and the governed loop is
bypassable.

**Nine sub-tickets; four ship standalone gate-green** (P2-1a publisher, P2-1h audit fix,
P2-1c manifest inspectability, P2-1b installPolicy). Order: 1a → 1h → 1c → 1b → 1d →
1e+1f atomic → 1g.

**RESOLVED — P2-1g uses synchronous in-process invalidation, not IPC.** Independently
verified: the launcher starts one engine process (`python -m mcp_wrapper.server`),
`server.py:113` calls `run_hermes_sync` via `asyncio.to_thread`, that constructs `AIAgent`
directly, and `hermes_runner.py:107` documents the live-agent registry as **"Single-process
only."** So the wrapper and the agent share a process and `_SKILLS_PROMPT_CACHE` is
directly reachable.

Use the upstream primitive with **`clear_snapshot=False`**:
`clear_skills_system_prompt_cache(clear_snapshot=False)`. Because the publish target is
`skills.external_dirs` — which is never snapshot-cached — clearing the snapshot would
delete unrelated Hermes state for no benefit.

**New P2-1g invariant (operator-added):**

> Activation or rollback must not be declared effective while an affected Hermes run can
> still carry the superseded skill prompt.

No generation epochs this phase. Conservative quiescence check instead:

```text
publish/rollback requested
        ↓
check RUNNING
        ↓
affected Hermes run exists?
   YES → block/defer mutation
   NO  → mutate external skill directory
        ↓
clear_skills_system_prompt_cache(clear_snapshot=False)
        ↓
verify filesystem state
        ↓
declare activation/rollback effective
```

This is preferable to reporting "rollback complete" while a superseded skill is still
resident in an active prompt.

**P2-1h moves up** — the audit-truncation integrity fix is the next small independent
patch after P2-0, ahead of the larger activation wiring. Silently trimming the oldest
records while calling the log append-only violates the governance model being built.

### P2-1h ruling — fail closed, do NOT make the audit unbounded

**Operator correction, verified:** simply deleting `del audit[:-MAX_AUDIT_ENTRIES]` would
trade one defect for a worse one. `audit[]` lives inside `state.json`, and
`MAX_STATE_BYTES = 2 MiB` (`verified_skill_store.py:36`) is enforced at `:582` by raising
`SkillValidationError("state exceeds bounded size")`. An unbounded audit therefore
converts *silent history loss* into *eventual total skill-store failure*.

**Invariant:**

> TORQCLAW must never silently discard skill-governance audit history. If the current
> bounded audit representation reaches capacity, the store must fail closed with an
> explicit, typed capacity error rather than deleting prior evidence.

Fix is conservative: raise `SkillAuditCapacityError` when `len(audit) >= MAX_AUDIT_ENTRIES`,
**before any governed state is mutated**. That ordering is the main correctness risk —
at `approve()` (`:204`) the in-memory `state` dict is already mutated before
`_append_audit` runs; only `_save_state()` persists. Five call sites: approved (`:204`),
activated (`:266`), disabled (`:295`), rolled_back (`:359`), and **recovered (`:504`) —
which must not bypass the guard**.

Seven required behaviors: records 1..1000 intact in order · attempt 1001 fails explicitly ·
nothing ever deleted · **the governed operation fails too — no state change without its
audit evidence** · restart preserves the audit · the error is typed and distinguishable
from corruption/recovery errors · recovery does not bypass the guard.

Plus a mutation-sabotage test: reverting to `del audit[:-MAX_AUDIT_ENTRIES]` must fail the
suite.

**Explicitly out of scope:** no new persistent audit subsystem in P2-1h. Moving audit out
of mutable `state.json` — leaving `installed`/`active`/`approvals` there and putting
immutable governance events in SQLite (durable append-only semantics, ordering, indexing,
transactions, and no invented JSONL recovery protocol) — is the eventual P2-1
architecture. **P2-1h makes the current system truthful first.**

**Process:** built in a clean worktree off current `origin/master`. `stash@{0}` (110 files
of mixed prior work, already conflicting) stays quarantined until these small governance
patches land individually.

#### P2-1h — BUILT, G2A PASS-WITH-NOTES (2026-08-07)

Verified: 197 baseline → **204 passed, 1 skipped**. All seven conditions confirmed through
the **real public API**, not fixtures. `vendor/` untouched; no P2-1 activation/cache creep.

G2A ran nine independent sabotages and found **two the suite missed**; both closed and
re-proven to fail before commit:

- **In-memory mutation on the raising path.** `audit.pop(0)` followed by a raise destroys
  the oldest record while still failing closed — and every other capacity test asserts on
  state *reloaded from disk*, so it was invisible. Now pinned by a direct assertion on the
  list object handed to `_append_audit`.
- **The error subclassing `ValueError`**, which would make it swallowable by the broad
  `except (SkillStoreError, OSError, ValueError)` handlers in `reconcile()`.

**Operator runbook note (behavior, not a defect).** If `activate()` fails at capacity its
transaction journal is deliberately retained, and `__init__` → `reconcile()` now re-raises
— so **the store cannot be constructed until an operator frees audit capacity**. Verified
self-healing: once freed, construction succeeds and the pending activation completes. This
is the invariant working as specified, but a full audit log must not be mistaken for
corruption. Document it before P2-1 ships.

**Bound confirmed:** 1,000 records serialize to 139,241 / 2,097,152 bytes — comfortably
under `MAX_STATE_BYTES`, so the audit is bounded, not unbounded.

**Merged** as `2604937` (PR #40), CI green.

#### P2-1g — runtime coherence primitives (authorized 2026-08-07)

Deliberately **narrower than activation**: build the runtime safety primitives; publish
nothing into `skills.external_dirs`.

**Invariant:**

> TORQCLAW must never report a skill activation, rollback, or publication as effective
> while a running Hermes agent can still hold the superseded skill prompt, and cache
> invalidation must fail closed if TORQCLAW cannot prove it occurred.

Two typed errors, both `SkillStoreError` subclasses outside the recovery and `ValueError`
families (the `SkillAuditCapacityError` precedent): `SkillRuntimeBusyError` and
`SkillPromptInvalidationError`.

- **Quiescence authority = `RUNNING` empty** (`hermes_runner.py:108`, the live agent
  registry, "Single-process only"). Deliberately **not** per-agent affectedness analysis —
  a skill directory/cache change modifies a *global* prompt-building substrate. 0 active
  runs → may proceed; 1+ → blocked. Epochs/generations are explicit future work.
- **Synchronous in-process invalidation**, `clear_skills_system_prompt_cache(clear_snapshot=False)`
  (`prompt_builder.py:966`, keyword-only). `clear_snapshot=False` because the publish
  target is never snapshot-cached — clearing it would delete unrelated Hermes state.
  **No fallback** to signalling, restart, or snapshot deletion; absent or erroring
  capability fails closed.
- **One process-wide mutation lock covering quiescence AND invalidation together**, not
  the cache clear alone — two activations must not both observe quiescence and race.

**Critical failure semantic:** cache invalidation is part of the future activation
*transaction*, not post-success cleanup. Never `publish → mark active → try to clear cache
→ oops`. The required ordering, which the API shape must make unavoidable:

```text
acquire lock → assert RUNNING == {} → validate → mutate → invalidate → verify
             → commit → declare effective → release
```

**UX:** a busy mutation is not corruption and not an activation failure. Operator-facing
wording: *"Skill change waiting for active Hermes work to finish. No skill state was
changed."* Returns a typed busy result — **no auto-queue, no auto-retry** in this ticket;
P2-1 later decides whether the governed workflow retries or exposes a control. That
preserves operator control.

Twelve required tests, including **#12: a busy failure mutates neither `RUNNING` nor any
supplied state object** — carrying forward P2-1h's lesson that asserting only on reloaded
disk state hides in-memory mutation on the raising path.

**BUILT, G2A PASS-WITH-NOTES (2026-08-07).** PR #41. 204 baseline → **221 passed,
1 skipped**. Two new files only; `vendor/` untouched; no publish/activation/IPC/epoch creep.

**G2A found a real hole, and it was closed rather than deferred.** The transaction as
first written enforced **mutual exclusion but not ordering** — a caller could acquire the
lock, skip the quiescence assertion, mutate, and commit with a live agent running.
Reproduced independently:

```text
committed with RUNNING non-empty: True | RUNNING size: 1
```

The docstring claimed the ordering was "structurally hard to get wrong," overstating the
guarantee. G2A rated it non-blocking because no caller exists yet. **Closed anyway** — the
requirement was that the API make ordering *unavoidable*, not advisory, and a future
implementer would reasonably have trusted that docstring. Both bookends are now structural:

```python
with _MUTATION_LOCK:
    assert_skill_runtime_quiescent()   # entry — cannot be skipped
    yield
    invalidate_skill_prompt_cache()    # exit — cannot be forgotten
```

A raising body **skips invalidation on purpose**: a mutation that did not complete must not
report a cleared cache. Three new tests pin this; reverting to the advisory shape fails two.

**Notes carried to the first caller:**
- Real detection coverage is 12 of 17 tests. Test 5 and test 12's `supplied_state` half are
  non-binding — behavior 5 is arguably unfalsifiable, since a function cannot be proven to
  ignore an argument it does not accept.
- `RLock` permits same-thread nesting (depth 3 demonstrated); cross-thread exclusion, the
  property that matters, is intact. Worth a comment before a caller lands.
- Test 10 silently skips if the vendored submodule is absent; its signature tripwire binds.

**Process note:** during this ticket the coordinator sabotage-tested the Builder's file
concurrently and corrupted its state mid-run. Detected via a leftover marker; the Builder
reconstructed from a verified-clean on-disk backup rather than either party's memory, and
re-ran every sabotage cleanly. **Rule going forward: one owner per file while a
sabotage cycle is in flight.**

**Merged** as `dc9b356` (PR #41), CI green.

#### P2-1g.1 — run admission + effective-commit boundary (authorized 2026-08-07)

Reviewing P2-1g against the *first real activation caller* exposed two gaps. Both verified
in the merged code. **The activation caller is blocked until these close.**

**Gap 1 — run-admission TOCTOU race (confirmed: `grep` finds zero `_MUTATION_LOCK`
references in `hermes_runner.py`; `RUNNING[task_id] = agent` at `:596` is unfenced).**
P2-1g solved "a future caller cannot skip quiescence." It did not solve the other half:

```text
Mutation                         New Hermes run
lock acquired
RUNNING == {}
                                 AIAgent constructed
publish skill
                                 RUNNING[task] = agent
invalidate cache
```

Both sides behave correctly individually and the invariant still breaks. Fix: Hermes
startup briefly acquires the **same** `_MUTATION_LOCK` before `AIAgent` construction,
holding it through `RUNNING` registration. A run starting first makes a later mutation
fail busy; a mutation in progress makes new construction wait. **The fence covers
construction + registration only — never `run_conversation` — so concurrent Hermes runs
are not serialized for their lifetime.** No epochs, no IPC.

**Gap 2 — the transaction cannot safely commit activation.** `activate()`
(`verified_skill_store.py:236-292`) already installs the version, sets `state["active"]`,
consumes the approval, appends audit, and persists — all before returning. So
`with skill_mutation_transaction(): store.activate(...)` marks governance ACTIVE *before*
the cache is invalidated on exit; **if invalidation fails, the store already claims the
skill is active.** Committing after the `with` block is equally wrong: the lock has
released and a new run could start before governance state lands.

Required sequencing, all inside one lock hold:

```text
LOCK → QUIESCENCE → prepare/publish external projection → invalidate cache
     → commit governed active state + consume approval + audit → verify → UNLOCK
```

On any post-publication failure: restore the previous external projection, do **not**
consume the approval as successful, do **not** claim active, and do **not** release the
lock until restoration completes. This means evolving the context manager into a
**coordinator/callback transaction** rather than wedging `activate()` in unchanged —
`activate()` itself is not modified in this ticket.

Eight adversarial tests, including *"start Hermes between the quiescence check and the
mutation → impossible"* and *"multiple ordinary Hermes tasks still run concurrently"*
(proving the fence stays narrow).

Once both halves share the same boundary, governed learning has a foundation that is
genuinely stronger than upstream Hermes rather than merely wrapping it.

**BUILT, G2A PASS-WITH-NOTES, PR #42.** 221 baseline → **232 passed, 2 skipped**.

**G2A found an escape the Builder's suite missed.** Moving `RUNNING` registration outside
the fence passed all 11 original tests — every one drove construction and registration
together or used the fence helper directly, so nothing pinned *registration inside the
fence*, the precise invariant the ticket exists to establish. Reproduced live:

```text
agent-constructed
MUTATION COMMITTED (RUNNING=0)     <- committed while an agent was live
registered-LIVE-AGENT
```

Closed with a structural source assertion, since the defect is *where the statement sits*,
not the behaviour of any single call.

**Carried to the activation caller:** RLock reentrancy self-admits if admission is nested
inside a mutation on one thread (unreachable today; the pipeline must not invoke Hermes
inside its transaction). The coordinator enforces *when* each slot runs, not *what belongs
in it* — a caller could smuggle the commit into `publish()`. And a pre-existing
stale-`RUNNING` wedge (`try/finally` begins after registration) turns any post-registration
exception into a permanent activation block.

#### P2-1g.2 — per-task lifecycle integrity (authorized 2026-08-07)

**Merged** P2-1g.1 as `6a360a8` (PR #42). One prerequisite remains before the activation
caller.

**Defect, verified in `master`:** `hermes_runner.py` registers the live agent at line 615,
but the guaranteed-cleanup `try` does not open until line 625. Lines 620
(`_snapshot_account_usage_usd`) and 624 (`_build_system_message`) sit in between,
unguarded. An exception there leaves a **permanently stale `RUNNING` entry**.

Before governed activation this was lifecycle debt. After P2-1g/P2-1g.1 it is serious:
`assert_skill_runtime_quiescent()` blocks mutation whenever `RUNNING` is non-empty, so
**one leaked entry makes every future activation and rollback fail busy forever.** The
guard designed to protect activation becomes the thing that permanently prevents it.

**Invariant:**

> Every successful insertion into `RUNNING` must be structurally paired with guaranteed
> removal, regardless of any later setup, prompt construction, accounting, execution, or
> cleanup failure.

Fix is to move the cleanup boundary to start immediately after registration rather than
immediately before `run_conversation()`. The `hermes_run_admission()` fence scope is
unchanged.

**Extension — one guaranteed lifetime for all per-task process-local state.**
`approval_hook.set_task_context` is called at line 471, ~150 lines before the `try`, so
everything between (including `AIAgent` construction, which can raise) can leak the
approval context. Four pieces of state must share one lifetime: **approval context ·
`RUNNING` entry · usage baseline · agent resource.** No process-local task residue may
survive a failed startup. Constraint to respect: the approval context must still be live
before any tool call can occur, or the gate breaks.

Ten tests, including failure injected at every meaningful point after registration and a
direct invariant test over all post-registration paths. Six sabotages, the first being a
revert to the original boundary.

**Sequence after this lands:** `skills.external_dirs` publication → governed activation →
rollback publication → fingerprint semantics → threshold N.

**BUILT, awaiting G2A.** 232 baseline → **253 passed, 1 skipped** (20 new tests).

**The `approval_hook` boundary resolved without weakening the gate.** The binding
constraint was that `set_task_context` must be live before any tool call. Rather than
moving it later — which would have traded a leak for a security hole — the fix opens the
`try` *immediately after* it. This is safe because `set_task_context`
(`approval_hook.py:34-47`) is only `with _lock: _ctx[task_id] = {...}` — verified, no
fallible operation — so no statement can fail between it and the `try`. The residual risk
was never "the context might not get set"; it was "if something after it fails, nothing
clears it." The `finally` closes that.

`agent = None` is seeded before the `try` so `finally` can guard `agent.close()` without
relying on `UnboundLocalError` handling.

Independently probed: injecting a failure at `_snapshot_account_usage_usd` — the exact
previously-unguarded call — leaves `RUNNING`, `_USAGE_BASELINE`, and `approval_hook._ctx`
all clean.

**Skip-count note:** the "2 skipped" figure quoted from the P2-1g.1 worktree included the
vendor tripwire skipping on an uninitialised submodule. With the submodule properly
checked out it runs and passes, so **1 skipped** (`os.fork` unavailable on Windows) is the
true baseline. The Builder flagged the discrepancy rather than silently reconciling it —
the correct instinct.

---

## 12. Remaining-phase decomposition (2026-08-07)

Full ticket map for Phases 2–6 produced and recorded separately. Load-bearing findings:

**A fourth unenforced-claim instance found: `skillTrust.ts`.** 661 lines of Ed25519
signature verification, revocation, and quarantine — imported by **zero** production files
(verified: only the module and its compiled `.d.ts`). Pre-loaded for Phase 4 exactly like
`draft_and_queue_skill`, the "append-only" audit, and the advisory transaction ordering.
**Claiming skill signature verification on the strength of this file existing would be the
same defect a fourth time.** P4-1 must gate on an *activation-path* test, not a unit test.

**RETRACTED 2026-08-07 — this section previously claimed PRD-001 §17 contained an
unsatisfiable DoD reading *"rollback provably removes the artifact."* Both halves were
wrong, and the quoted phrase appears in no document.** §17 of PRD-001 is *Open questions
and decision deadlines* and contains no DoD at all. Verified verbatim against
`docs/PRD-TCLAW-RESILIENT-EXTENSIBILITY-001.md`:

- §14: "Skill rollback disables new activation, **restores the prior version** atomically,
  and preserves provenance/audit records."
- §18: "Feature-off rollback is demonstrated." (feature-flag, not artifacts)

`rollback()` requiring the target digest still be installed is therefore the **specified**
behavior, not a defect — and deleting artifacts would *violate* §14's preserve-provenance
clause. No amendment to PRD-001 is needed and Phase 2 is not blocked. D5's rename stands
on its own merits (it is a more precise statement of the same requirement), not as a
correction to §17.

**The lesson is this document's own subject.** A fabricated citation — a quoted phrase
attributed to a section never read — is the unenforced-claim pattern applied to prose: a
confident, specific, checkable-sounding assertion with nothing behind it. It survived into
a PRD that exists to catch exactly that. Before citing any spec line as a blocker, `grep`
the literal text and read the surrounding section.

**Phase 5 is architecturally blocked, not merely unscoped.** Concurrent agents mean
`RUNNING` is essentially never empty, and `assert_skill_runtime_quiescent()` requires it to
be empty — so skill mutation could essentially never proceed. Phase 5 and Phase 2's
activation model are in direct conflict; resolving it needs the epochs/generations work
P2-1g explicitly deferred. Decide that before scoping P5-2.

**Security-first exceptions that should jump the queue:** SEC-1 (cross-channel session
hijack — live HIGH, carve it out of the large P3-2 rather than burying it), A1
(longest-first redaction, hours of work), and the non-loopback token requirement
(`channel-http/src/server.ts:36` returns `true` when the token is unset — accept-all, and
`:47-49` only warns).

**Additional cuts, same category as the tool-allowlist cut:** L3 `skills.write_approval`
(returns `False` on every error path — never cite it as a layer); L2 `config.yaml` controls
(operator-owned, unversioned, not CI-verifiable); per-agent exact cost on the Team Board
(unattributable under account-delta); "allow for this task" grant scope (no TTL exists
anywhere — single-use grants are *stronger*).

**Do NOT cut:** the console multi-surface refactor. Budgeted for Phase 1 and never done;
`TorqTerminal.tsx` is 1,287 lines and every remaining phase adds a panel.

**Ratified sequencing:** P2-0 merge → P2-1h audit integrity → lock P2-1g to same-process
sync invalidation + quiescence → finish P2-1 activation design around `skills.external_dirs`
→ define purpose-fingerprint semantics → only then choose threshold N.

### Ratified sub-rulings

- **`editedMarkdown` → edit / re-stage / re-approve.** A digest-bound approval must
  authorize the exact artifact that executes; once an edit changes the artifact, the
  prior approval becomes invalid automatically. Anything else weakens the provenance
  model.
- **Threshold N is NOT chosen yet.** Define and test fingerprint semantics first — what
  constitutes "the same purpose" — then pick N from observed repeated-task behavior.
  Choosing N now would tune a threshold against an undefined identity function.

## 7. Open operator decisions

1. ~~**Repetition threshold N**~~ **DEFERRED by operator ruling (§6c).** Not a decision
   yet: define and test fingerprint semantics first, then derive N from observed
   repeated-task behavior. The earlier N=3-on-`plan_hash` recommendation is withdrawn on
   both counts — `plan_hash` is invalid (RC-4) and a threshold over an undefined identity
   function is untunable.
2. **Rollback residue scope** (D5): do `.curator_backups/*.tar.gz` and `.archive/` count
   as residue that must be purged, or as intentional recovery history? Recommend: declare
   them out of scope for "removal" but **disclose** them in the rollback report — honest
   rather than silently incomplete.
3. ~~**Curator**: disable outright or pin approved skills?~~ **RESOLVED by G1R RC-3 — no
   operator decision needed.** `maybe_run_curator` (`curator.py:1817`) is called only from
   `cli.py:10996`, `gateway/run.py:15749`, and the `hermes_cli` surface. TORQCLAW invokes
   none of them — `hermes_runner.py:27` imports `run_agent.AIAgent` directly and never
   starts the Hermes gateway or CLI. The curator is **structurally unreachable**, unlike
   SEC-7 which was incidental. Two corrections to the earlier draft: (a) `curator.enabled:
   false` was the wrong mechanism — it lives in the operator-owned `config.yaml` demoted
   to L2, and it defaults **ON** (`curator.py:135-137`); (b) the `pinned: true` option is
   **struck as unsafe** — pinning blocks deletion/archive/consolidation but explicitly
   **not content updates** (`background_review.py:118-120`), and for the LLM consolidation
   pass it is merely prompt text (`curator.py:364`). A pinned, operator-approved skill's
   content remains mutable. P2-0 instead adds a repo-versioned test asserting TORQCLAW
   imports no curator entry point; `curator.enabled: false` is declared defence-in-depth
   only, same tier as L2.
4. **Phase 2 approval-surface question carried from Phase 3 scoping**: may an operator
   approve a channel-originated task? Affects both phases.
