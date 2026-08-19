# G1R Gate-1 Review — PRD-TCLAW-AGENT-PARTICIPATION-007 v0.1

**Seat:** G1R — Independent Design Reviewer.
**Model disclosure:** The routing profile names **Opus 5** for this seat and I **am**
`claude-opus-5`. **No substitution was made.** Fresh thread, no authoring context.

**Target:** `docs/PRD-TCLAW-AGENT-PARTICIPATION-007.md` v0.1 (commit `68cb598`).
**Repo:** `E:\TorqClaw` · **Branch:** `phase1-server-owned-authority` · **HEAD at review:** `63e53f8`
(the PRD headers `8c8e7c5`; `63e53f8` is one commit later — see B-4).
**Date:** 2026-08-17.

---

## VERDICT: **APPROVE_WITH_CONDITIONS**

**The design is sound and the authority model is correct.** The PRD's central finding —
that this is a **transport** gap and not an **authority** gap — is verified true against
source, and it is the finding that makes the work safe. No new permission model is needed,
and none may be built.

**But three slices are conditioned, and one of them is conditioned on a hole that is real,
verified, and currently open in the default configuration.** Conditions are enumerated in
§Blockers. **S1 and S5 may proceed once B-4 and B-5 are discharged. S2 is blocked on OQ-6
(ruled below). S3 is blocked on OQ-7 (ruled below) and on B-1/B-2/B-3.**

**⚠️ SCOPE ADDITION RULED — cron / scheduled autonomous execution (§2A).** The operator's
requirement for gateway-hosted scheduled execution **does not change this verdict, but it does
change the build order.** Cron is the same threat shape as auto-reply and strictly worse. **B-1
is therefore promoted from "a condition on S3" to the prerequisite slice S0 for the entire
unattended program**, and two new blockers (B-7, B-8) are cron-specific. **Prerequisite order:
argument-scoped grants FIRST, then auto-reply and cron in either order.** See §2A.6.

The PRD is unusually honest — it names its own tensions, quarantines its unverified claims,
and twice promoted its own findings from "unverified" to "blocker" in a direction that made
the work *larger*. That is the behavior this program's discipline is supposed to produce. I
found **no overclaim** in §1–§3. Every `file:line` I re-derived matched, including branch
conditions and defaults.

---

## 1. RULING ON OQ-6 — the bridge admits no in-process tool provider

### 1.1 The PRD's claim is VERIFIED TRUE, in every part

Re-derived from `packages/bridge/src/registry.ts` (read in full this session):

| PRD claim | Verified | Evidence |
|---|---|---|
| `connectServer` is the sole registrar | **TRUE** | `registry.ts:123`; the only `registry.push` is `:157` |
| Requires a live `client.connect()` | **TRUE** | `:138`; on throw, `transport.close()` + rethrow (`:139-143`) — registers nothing |
| Transport is a strict 2-member union | **TRUE** | `ServerConfig.transport` at `:30-32` — `streamable-http` \| `stdio`. No third variant. Construction at `:128-135` is a binary ternary with no fallthrough |
| Tools come only from `client.listTools()` | **TRUE** | `:146` |
| `RegisteredTool` has no handler field | **TRUE** | `:9-26` — nine fields, none a handler. Dispatch is `sourceServerId` → `getClient(...).callTool(...)` at `:222-225` |

**The PRD is right: exposing collab tools to agents is a structural change, not "add a tool."**

### 1.2 The ruling

**Mechanism: (a) — extend the bridge with an in-process transport, implemented as
`InMemoryTransport` from the MCP SDK, with the collab tool server as a real
`McpServer` object living in-process.**

**Not (b), not (c), and not "extend `RegisteredTool` with a handler field."**

### 1.3 Why — and why the other three are worse

**Why not (c) — direct injection into the LOCAL_EDGE loop.** The PRD calls it "not
recommended"; I rule it **prohibited**. Verified from `registry.ts:189-231`, `executeTool` is
the single chokepoint carrying **four** enforcement layers:

1. `assertOperationAllowed(effectiveProfile, entry)` — profile policy (`:196-199`)
2. Profile path admissibility — `scopes.path === 'none'` refusal (`:205-213`)
3. `checkPath(p, entry.pathScope, mode)` with `scopeModeFor(entry.capability)` (`:214-220`)
4. `result.isError` → throw, so a tool error cannot be mistaken for a result (`:226-229`)

And upstream of it, `toolFilter.ts:57-65` applies `TOOL_ROUTING_MAP` filtering and
`isOperationAllowed`, and `:64` computes the `approvalSet`. Option (c) forfeits **all** of
this. A collab tool injected past `executeTool` runs with no profile policy, no path scope,
and — critically — **outside the `requiresApproval` closure**, which means a future
collab-adjacent tool that *should* be gated could not be. **Option (c) is a bypass of the
security seam, not an implementation of a feature. Prohibited.**

**Why not "extend `RegisteredTool` with a local handler field."** This is the option the
brief asks me to price, and it is the **most dangerous** of the four, because it looks
cheapest. Adding `handler?: (args) => Promise<unknown>` to `:9-26` and branching in
`executeTool` at `:222` creates a **second dispatch path**. This repo's own history is
decisive here: `dispatch.ts:481-505` documents the N-1/D-2 defect class in its own comment —
*"a fence that guards one route while another route reaches the same engine"* — and records
that **the same mistake was made three times**. A handler branch at `:222` is structurally
that mistake a fourth time: every future enforcement added to the MCP arm must be remembered
for the handler arm, and the failure mode is silent. **Rejected on precedent, not on taste.**

**Why not (b) — a real out-of-process MCP server TorqClaw ships.** It is *secure* — it
inherits the full seam unchanged — but it is the **worst** on a different axis. It needs its
own credential-holding path back to the gateway's store (the PRD names this). That means an
agent's collab credential crosses a **process boundary**, which converts OQ-1 (where does the
credential live at rest) from a storage question into an **IPC authentication** question,
and drags in the still-stubbed CredMan `SecretStore` (005 §7.5, §19-owed). It also means the
gateway's SQLite store is opened by a second process — a concurrency posture nothing in this
repo currently has. **It buys nothing over (a) and costs a new trust boundary.**

**Why (a) via `InMemoryTransport` is correct.** The decisive property: it is a **transport**
change, not a **dispatch** change. `InMemoryTransport.createLinkedPair()` is part of
`@modelcontextprotocol/sdk` — already a dependency (`registry.ts:1-3`). It satisfies
`client.connect(transport)` at `:138` genuinely, so `listTools()` at `:146` returns real
tools, `classifyCapability` at `:156` runs, `requiresApproval` at `:164` is computed by the
same expression, and `executeTool` dispatches through `getClient(...).callTool(...)` at
`:222` **on the identical code path as every remote server**. There is **no second arm**.
The registry cannot tell the difference, which is precisely the point — **the seam stays
single**.

The cost is honest and bounded: `ServerConfig.transport` gains a third union member (`:30-32`
and the zod `discriminatedUnion` at `serverConfig.ts:12-23`), and `connectServer`'s ternary
at `:128-135` becomes a three-way switch. That is a change to a security-critical package and
requires its own review — but it is a change that **preserves** the invariant rather than
carving an exception into it.

> **Constraint on the config surface (binding).** The in-process variant must **not** be
> constructible from `~/.torqclaw/servers.json`. `loadServerConfigs()` (`registry.ts:252-259`)
> reads user-supplied config; if `{type:'in-process'}` were accepted there, a user config file
> could name an arbitrary in-process provider. The in-process server must be constructed
> **only** in `connectBridge()` from code, and the zod schema for the user-facing roster must
> continue to admit exactly the two remote variants. **This is a required condition (B-2).**

### 1.4 Protections that must be preserved — and exactly where they must sit

Each must sit **inside `executeTool` or upstream of it**, never inside the collab tool's own
handler, because a protection implemented in the handler is one a future tool can forget:

1. **`assertOperationAllowed(effectiveProfile, entry)`** — `registry.ts:196-199`. Stays where
   it is; the in-process entry is a normal `RegisteredTool` and passes through it.
2. **Path-scope enforcement** — `registry.ts:205-220` (`extractPaths` + `checkPath`, deny
   wins, `scopeModeFor(capability)`). Must still execute. Collab tools take no path arguments,
   so this is a no-op *for them* — **but it must be a no-op by evaluation, not by omission.**
3. **`requiresApproval` computed by the same expression** — `registry.ts:164`,
   `isWriteClass(cap) || patterns.some(...)`. **Do not hand-set `requiresApproval` on the
   in-process entry.**
4. **Capability classification must be an EXPLICIT config decision.** `capability.ts:172`
   fails closed to `'write'` (verified: *"P6: fail-closed default … UNKNOWN NEVER MEANS
   READ"*). So a collab tool with no `capabilities` entry is write-class ⇒
   `requiresApproval: true`. **§5's speech exemption must be written as an explicit
   `capabilities: { post_message: 'read'|<explicit> }` entry, never obtained by omission** —
   the PRD says this at §3.4 row 1 and is **correct**.
5. **`toolFilter` task-type gating** — `toolFilter.ts:57-63`. The `collab__` prefix must be
   added to `TOOL_ROUTING_MAP` explicitly; a namespace absent from the map is silently
   invisible (no else-branch, verified). **Deny rules win.**
6. **Tool-error opacity** — `registry.ts:226-229`. `COLLAB_NOT_FOUND` must reach the model as
   a tool error and **must not** be distinguishable from a nonexistent channel (005 T-2). The
   in-process handler must therefore return the substrate's error **unelaborated**; it must not
   add a "you are not a member" hint. **This is a real risk of the in-process path**: the
   handler has access to richer error context than a remote server would, and enriching it
   would break the indistinguishability the substrate spent effort establishing
   (`store.ts:2036-2044`, both denial arms call the same `notFound()`).

**Consequence for slice sizing:** S2 is a bridge change *and* a collab-tools change *and* a
`TOOL_ROUTING_MAP` change. The PRD's judgment that S2 is "materially larger than a 'just add a
tool' slice" is **correct and should be preserved verbatim in the scoping doc.**

---

## 2. RULING ON OQ-7 — `grantedTools` is a name allowlist, not a per-invocation grant

### 2.1 Every claim VERIFIED — with one correction that matters, in the PRD's favor and against it

**Claim 1: `grantedTools` is a name allowlist checked by `.includes()`.** **VERIFIED.**
`packages/inference/src/ollama.ts`:

```
const granted = req.payload.grantedTools.includes(realName);
if (requiresApproval(realName) && !granted) {
  throw new ToolApprovalRequired(realName, toolArgs);
}
```

The check is on `realName` only. **Arguments are not consulted.** Within one re-minted
granted request, a granted tool may be invoked repeatedly with **different arguments**, and
each invocation passes.

**Claim 2: the frame advertises `grantScope: 'one-shot'`.** **VERIFIED** at
`dispatch.ts:389`, and also `approvalCard.ts:96` (type) and `:234` (value). **The frame's
advertisement is not true of the `grantedTools` mechanism.** It is true of the C2 mechanism —
when C2 is on.

**Claim 3: `admitTool` defaults to a no-op.** **VERIFIED.** `ollama.ts:33`:
`let admitTool: ToolAdmissionCheck = () => ({ ok: true });`

**Claim 4: it short-circuits when `collabEnabled()` is false — the default.** **VERIFIED, and
the branch structure is worse than a single condition.** `server.ts:144-155` (read with
enclosing conditions, per the evidence rule):

```
setToolAdmissionCheck((requestId, toolName, args) => {
  if (!collabEnabled()) return { ok: true };                    // condition 1
  const carriesGrant = db.prepare(
    'SELECT 1 FROM gateway_action_grants WHERE dispatch_request_id = ?',
  ).get(requestId) !== undefined;
  if (!carriesGrant) return { ok: true };                       // condition 2
  const result = admitToolCall(db, {...path: 'LOCAL_EDGE'});
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
});
```

**Two** independent short-circuits to `{ok:true}`, not one.

**Default of `collabEnabled()`:** `principalBridge.ts:71-72` —
`TRUTHY.has((process.env.TORQCLAW_COLLAB_ENABLED ?? '').trim().toLowerCase())`, with
`TRUTHY = new Set(['1','true','yes','on'])` at `:57`. Unset ⇒ `''` ⇒ **false**. I additionally
verified that **`.env.example` sets no collab flag at all** (grep: no match). **So the seam is
inert in a default install, confirmed at the config level and not merely at the code level.**

**And the producer is gated too:** `c2Broker.ts:132` — `registerApprovalC2` opens with
`if (!collabEnabled()) return null;`. So with the flag off, **no grant row is ever minted**,
which means condition 2 in `server.ts` would *also* short-circuit even if condition 1 were
removed. **The amplification is double-fenced open by default.** This is a stronger finding
than the PRD states, and it means a partial fix (removing only condition 1) would not close it.

**Correction the PRD does not have — and it cuts both ways.** The PRD's §5 A5-a and OQ-7 were
written against `8c8e7c5`. At `63e53f8` the tree contains commit **`72b4d36`**, dated
**2026-08-17 11:40**, titled *"fix(gateway): FRONTIER granted-run refusal must not depend on a
feature flag (N-1)"*. I read `dispatch.ts:481-507`. `frontierGrantFenced` is now:

```
return diag.tier === ComputeTier.FRONTIER
    && (req.payload.grantedTools?.length ?? 0) > 0;
```

with a comment recording that the `&& collabEnabled()` term was removed because *"a security
refusal that a feature flag can switch off is not a refusal."*

**Consequence, stated precisely:**
- **FRONTIER is now CLOSED** — a granted FRONTIER run is refused outright, flag-independently.
  `admitToolCall` also fails closed for FRONTIER before touching state
  (`grantAdmission.ts:141-142`, `refuseFrontier()`).
- **LOCAL_EDGE remains OPEN by default** — `server.ts:145` still carries `if (!collabEnabled())
  return { ok: true }`, and `c2Broker.ts:132` still carries the matching producer gate.

**So the hole OQ-7 names is real, is currently open on LOCAL_EDGE, and is the exact residue of
a defect class this program fixed on FRONTIER eight hours ago and did not carry across.**

### 2.2 The ruling

**`canAutoReplyShipFirst`: NO. S3 must not ship before this is fixed.**

**Reasoning.** The amplification is not incremental — it is a **change of kind**, and the
brief identifies why correctly: *there is no human present to notice.*

Under human pacing, the exposure is bounded by human attention. An operator approves
`fs__write_file` for `report.md`, sees the next call, and can intervene. The mechanism is
weak, but a human is standing next to it.

Under S3, the request is re-minted with `grantedTools: ['fs__write_file']` and the loop
continues **unattended and unbounded** (R-2, accepted). The model may now invoke that tool
with **any** arguments, **any number of times**, and `.includes()` passes every one. Nobody
is watching, by design.

**This is not a cost objection and I am not re-proposing a cap.** The operator's premise —
subscription models, zero marginal per-turn cost — is accepted in full, and it is *irrelevant*
here. A once-approved `fs__write_file` re-invoked with a different path costs nothing and is
still an unapproved write. R-3b is explicit: **"Talking is unbounded; ACTING is not."** Shipping
S3 over an open LOCAL_EDGE argument-blind grant makes acting unbounded too, by the same
mechanism that makes talking unbounded. **It would silently invert the operator's own ruling.**

The PRD's own §5.2 boundary argument depends on this being closed. It says: *"When that other
agent acts, the action is gated at THAT tool — the approval boundary sits where the effect
occurs, and every effect still crosses it."* **That sentence is currently false on LOCAL_EDGE
for the second and subsequent invocations within a granted request.** The boundary is crossed
once, not per effect. The PRD's central safety argument therefore rests on a property the code
does not yet have. **That is the blocker.**

### 2.3 Required fix

**Do not adopt the PRD's option "require `TORQCLAW_COLLAB_ENABLED` as a precondition for
`TORQCLAW_AGENT_AUTOREPLY`."** It is the cheapest option and it is wrong, for the reason
`72b4d36` gives in its own comment: **a security property that a feature flag can switch off is
not a security property.** It also produces a live configuration in which auto-reply is enabled
and the seam is inert (operator sets `TORQCLAW_AGENT_AUTOREPLY=1`, forgets
`TORQCLAW_COLLAB_ENABLED=1`) — a silent downgrade with no signal, which is precisely the
`72b4d36` failure mode.

**Required (B-1), in the same shape as `72b4d36`:**

1. **Make the LOCAL_EDGE exact-action admission fence flag-independent for auto-turn
   requests.** The property being enforced — *a name grant cannot prove argv identity* — has
   nothing to do with whether collab is enabled, exactly as `dispatch.ts:494-505` argues for
   FRONTIER. The narrow, honest version: a request executing as an **auto-turn** must not carry
   a populated `grantedTools` unless an args-bound grant exists for the call. Concretely, one
   of:
   - **(i) Preferred — carry the fix across from FRONTIER.** Remove condition 1 at
     `server.ts:145` *and* the producer gate at `c2Broker.ts:132`, so C2 grant minting and
     consumption run unconditionally. This closes the hole for **all** LOCAL_EDGE traffic, not
     just auto-turns, and eliminates the flag-dependence class entirely. Larger blast radius —
     it changes behavior for existing human-paced runs — so it needs its own slice and its own
     G2A. **This is the right fix and should be its own ticket, not folded into S3.**
   - **(ii) Minimum acceptable — fence auto-turns.** An auto-turn dispatch must be refused if
     `grantedTools` is non-empty and no consumable args-bound grant exists, by the same
     `frontierGrantFenced` pattern: a predicate consulted by **every** executor path reaching an
     auto-turn, flag-independent, returning a first-class refusal terminal. **Auto-turns must
     never re-mint `grantedTools` from a prior turn's approval.**

2. **Whichever is chosen, the falsifiability probe must exercise the LOCAL_EDGE handle the
   assertion reads** (§7.4 rule 3). Specifically: seed an approval for tool `T` with args `A`,
   drive an auto-turn that invokes `T` with args `B ≠ A`, and assert **`T`'s real side effect is
   absent** — not that a refusal event was emitted (§7.5). Then remove the fence and show the
   test turns **RED**. A probe that asserts the refusal frame would pass against a fence that
   emits the frame and executes anyway.

3. **Correct the PRD's §5 A5-a FRONTIER text.** It describes the pre-`72b4d36` world. At
   `63e53f8`, a granted FRONTIER run is **refused**, not approved-through. A5-a's FRONTIER leg
   must assert the **refusal terminal** (`frontierGrantRefusal()`,
   `grantAdmission.ts:216-243`, `reason: 'frontier-structured-grant-unavailable'`), not a
   `pre_tool_call` relay. **As written, A5-a's FRONTIER leg tests behavior that no longer
   exists and would be written against a stale mental model.** (B-4.)

**S1 and S2 are NOT blocked by OQ-7.** Neither creates an unattended loop. A human-triggered
agent post has a human in the loop. **The blocker is scoped exactly to S3 — and now to cron
(§2A).**

---

## 2A. SCOPE ADDITION — cron / scheduled autonomous execution

The operator has ruled that **gateway-hosted scheduled execution is REQUIRED**, not optional
(Hermes Bot Mode equivalent: the gateway wakes the agent on a schedule, runs the task, pushes
the result to a messaging surface). This is not re-litigated. It is assessed here because it
lands on OQ-7 and it **changes the prerequisite order**.

**Headline: cron does not change my verdict, but it does change the build order, and it
promotes B-1 from "a condition on S3" to "the prerequisite slice for the entire unattended
program."**

### 2A.1 Cron is the same threat shape as auto-reply, and strictly worse

The coordinator's framing is correct and I adopt it. Both are **unattended invocation**. Both
amplify OQ-7 by the identical mechanism: `.includes(realName)` at `ollama.ts:356` binds a tool
**name**, so an approval given for `terminal ls` covers `terminal curl … | sh` on any later
invocation within a granted request. The coordinator's example is not hypothetical — it is
exactly what a name-only allowlist permits.

Cron is worse on **three** axes, and the third is one the coordinator did not name:

1. **No human proximity.** Auto-reply at least begins with a human posting into a channel; the
   operator is plausibly at the keyboard. A cron turn fires at 03:00 with certainty that nobody
   is watching. Auto-reply's human-nearby property is weak, but it is not zero; cron's is zero
   **by design**.
2. **No conversational bound.** Auto-reply terminates naturally when an agent produces no post
   (A3-f). A cron schedule has **no natural terminator at all** — it re-fires forever until an
   operator disables it. R-3a's STOP control is scoped to a channel and to a running loop; **it
   does not reach a schedule.**
3. **Persistence across the fix.** An auto-reply loop is transient — closing the hole before S3
   ships means no loop ever ran under it. **A cron schedule is durable state.** A schedule
   created under a permissive regime keeps firing after the regime is tightened, unless the
   tightening is evaluated **at wake time** rather than at creation time. **This is the axis
   that makes ordering matter most**, and it is why cron must not ship first and be fixed later.

### 2A.2 Ruling 1 — Is `admitTool` the right fix? **YES for LOCAL_EDGE. NO for FRONTIER, which needs a separate answer that already exists.**

**Verified current state of the seam** (re-derived this session, with enclosing conditions and
defaults, per §7.1):

- **Default is a no-op.** `ollama.ts:33`: `let admitTool: ToolAdmissionCheck = () => ({ ok: true });`
- **Its one production wiring is double-short-circuited.** `server.ts:144-155`:
  condition 1 `if (!collabEnabled()) return { ok: true }`; condition 2
  `if (!carriesGrant) return { ok: true }`.
- **`collabEnabled()` defaults false** — `principalBridge.ts:71-72`, `TRUTHY` at `:57`, and
  **`.env.example` sets no collab flag** (verified by grep).
- **The producer is gated too** — `c2Broker.ts:132`: `if (!collabEnabled()) return null;`, so
  with the flag off **no grant row is ever minted** and condition 2 would short-circuit even if
  condition 1 were removed.

**The PRD's claim is verified true, and the branch structure is worse than it states.**

**But the mechanism itself is the right one, and it is genuinely good.** `admitToolCall`
(`grantAdmission.ts:135-247`) does exactly what argument-scoped grants require:

- It **re-canonicalizes the actual args independently** rather than trusting stored bytes —
  *"that independence is what makes the hash comparison meaningful"* (`:142-146`).
- It re-validates the **live** profile delegation (`:215-225`) and the **live** deciding-surface
  auth epoch (`:228-236`), so a revocation that committed first wins.
- **Consumption is the check**: a single `UPDATE … SET consumed_at=? WHERE grant_id=? AND
  consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`, with `changes !== 1` ⇒
  `grant-consumed` (`:238-246`). That is a correct one-shot under concurrency — no
  read-then-write race.
- It fires at the right moment. `ollama.ts:25-31` states the design reason: *"The check lives
  HERE, immediately before the side effect, rather than at task dispatch, because this is the
  first moment the model-generated arguments actually exist."* **That is exactly the property
  unattended execution needs**, and it is already articulated in the source.

**So: do not build a new mechanism. Finish wiring the one that exists.**

**"Finishing the wiring" concretely requires four things:**

1. **Remove the flag-dependence on both sides** — condition 1 at `server.ts:145` **and** the
   producer gate at `c2Broker.ts:132`. Removing only one leaves the seam inert via the other.
   Rationale is already written in this repo's own source, `dispatch.ts:501-505`: *"a security
   refusal that a feature flag can switch off is not a refusal."*
2. **Close condition 2's gap for unattended runs.** Condition 2 (`!carriesGrant ⇒ ok`) exists for
   a legitimate reason — the D-3/SI-4 fix, so a legacy connection that never went through C2 is
   not refused `grant-missing`. That reasoning is sound **for human-paced legacy connections**.
   It is **not** sound for an unattended run: an unattended run has no legacy path to preserve,
   and "no grant row ⇒ allow" is precisely the hole. **An unattended turn carrying a populated
   `grantedTools` with no matching grant row must be REFUSED, not admitted.** This is a narrow,
   surgical change that preserves the D-3 fix for the connections it was written for.
3. **Make the approval and grant TTL sweep flag-independent.** `server.ts:761` wraps
   `revokeInertGrants` / `sweepExpiredApprovals` / `sweepExpiredGrants` in `if (collabEnabled())`.
   **This is the same flag-dependence class as B-1, in the recovery path.** With collab off, a
   crashed gateway leaves inert grants unrevoked. For unattended execution this matters
   materially more than for human runs, because nobody notices. **(New blocker B-7.)**
4. **Prove it on the LOCAL_EDGE handle the assertion reads** (§7.4 rule 3), by side effect
   absence (§7.5), shown RED.

**FRONTIER needs a separate answer, and it already has one — which must be preserved, not
"fixed."** `frontierGrantFenced` (`dispatch.ts:505-507`) refuses **every** granted FRONTIER run,
flag-independently since `72b4d36`, and `admitToolCall` fails closed for FRONTIER before touching
state (`grantAdmission.ts:141-142` → `refuseFrontier()`). The reason is structural and stated at
`grantAdmission.ts:216-243`: *"FRONTIER has no args-aware structured grant protocol at the Hermes
pre-tool-call hook."* The engine's hook grants by **name** and never inspects args.

**Consequence for cron, stated plainly: a scheduled FRONTIER task cannot execute a
write-capable tool at all today.** It is refused, loudly, with a first-class terminal. **That is
correct behavior and must not be "fixed" to make cron work.** Anyone implementing cron will hit
this refusal and be tempted to relax it. **Relaxing it would re-open the exact hole `72b4d36`
closed this morning.** Either cron's write-capable work runs on LOCAL_EDGE under a finished
`admitTool`, or an args-aware FRONTIER grant protocol is separately authorized as its own effort
— which is explicitly out of scope for this PRD and for cron.

### 2A.3 Ruling 2 — Can ANY unattended-trigger slice ship before argument-scoped grants exist?

**NO. Plainly: no.**

**Argument-scoped grants are the prerequisite slice, and they must be ordered FIRST — before
S3, and before any cron slice.**

**Reasoning.** The property that makes approval meaningful is that *the thing approved is the
thing that runs*. Under human pacing, a human standing at the console supplies that property
informally: they see the next call and can intervene. **Unattended execution removes the human
and therefore removes the only thing currently supplying the property on LOCAL_EDGE.** Shipping
either unattended trigger first would mean shipping a system in which the operator's approval
means *"this tool name may run with any arguments, repeatedly, while I sleep."* No operator
consented to that, and R-3b — the operator's own ruling that **acting is not unbounded** — is
directly falsified by it.

**This is not a cost argument** and I am not re-proposing a turn cap. The zero-marginal-cost
premise is accepted and is irrelevant: a once-approved `terminal` re-invoked with new arguments
costs nothing and is still an unapproved execution.

**The ordering-specific argument, which is decisive for cron:** a cron schedule is **durable
state that outlives the regime it was created under**. Ship cron first, and every schedule
created in the interim keeps firing after the fix lands. You would then need a migration that
re-evaluates existing schedules — strictly more work than ordering correctly, and with a window
of exposure in between. **Ordering the grant slice first costs one slice of delay and eliminates
the window entirely.**

**Recommended build order, revised (this supersedes §7's ordering for the unattended program):**

```
S0 — ARGUMENT-SCOPED GRANTS (new, FIRST, prerequisite for everything unattended)
      finish the admitTool wiring: flag-independent, condition-2 gap closed
      for unattended runs, sweeps flag-independent (B-7)
             │
S1 (identity) ──► S2 (tools) ──► S3 (auto-reply)   ─┐
                                                     ├── both now UNBLOCKED by S0
                             CRON (separate PRD)    ─┘
```

**S0 is not part of PRD-007.** It is a gateway/approval-subsystem slice, it changes behavior for
existing human-paced LOCAL_EDGE runs, and it deserves its own scoping, its own G1R, and its own
G2A. **It should be filed immediately as its own ticket, exactly as `72b4d36` was filed as its
own slice rather than waiting on PRD-006** — the commit message records that reasoning and it
applies identically here. **Do not fold S0 into S3.**

### 2A.4 Ruling 3 — Is the read-only middle path genuinely safe, or does it merely feel safe?

**Assessment: the read-only restriction is genuinely safe IF AND ONLY IF it is enforced at the
`executeTool` chokepoint by capability class, and the suspend-and-queue half is NOT safe as
described and must be replaced.** Split verdict — the two halves of the proposal have different
answers.

**Half 1 — "unattended turns restricted to read-only tools": GENUINELY SAFE, and structurally
enforceable.** This is not a convention; the machinery already exists:

- `classifyCapability` (`capability.ts`) fails closed to `'write'` at `:172` —
  *"P6: fail-closed default … UNKNOWN NEVER MEANS READ."* An unclassified tool is **write**, so
  the restriction cannot be defeated by omission. **This is the single most important property
  making the middle path viable**, and it is already true.
- `isWriteClass(cap)` is the same predicate driving `requiresApproval` at `registry.ts:164`, so
  the restriction reuses the classification the approval system already trusts.
- Enforcement sits at **`executeTool`** (`registry.ts:189-231`), the one chokepoint every tool
  call crosses (§1.4). A refusal there is structural: an unattended run carries a flag, and
  `executeTool` refuses any entry whose `capability` is write-class. **No per-tool remembering,
  no allowlist to maintain, no second dispatch path.**

**One necessary correction to the proposal:** it must be enforced on **`capability`**, not on
`requiresApproval`. Those differ — `requiresApproval` is
`isWriteClass(cap) || patterns.some(...)`, and it is additionally **LOCAL_EDGE-only** at
`toolFilter.ts:77-78` (`tier === 'LOCAL_EDGE' && approvalSet.has(realName)`), so it returns
`false` for every tool on FRONTIER. **A middle path keyed on `requiresApproval` would be
vacuous on FRONTIER — permitting everything.** Keying on `capability` is tier-independent and
correct.

**Half 2 — "any write-capable tool suspends the loop and queues for operator approval": NOT
safe as described. It merely feels safe.** Three reasons, the third fatal:

1. **It reintroduces the hole it was meant to avoid.** The moment the operator approves the
   queued item and the run resumes, the resumed run carries `grantedTools` with that name — and
   the resumed run is **still unattended**. `.includes()` then admits **any** arguments for the
   rest of that request. The middle path would have deferred the exposure by one operator click,
   not removed it. **Without S0, "queue for approval" is not a mitigation.**
2. **The queue has no reader at 03:00.** See §2A.5 — `APPROVAL_TTL_SECONDS = 15 * 60`
   (`approvalWriter.ts:54`, verified). A queued approval from a cron run expires in **fifteen
   minutes**, long before anyone wakes.
3. **"Suspend and resume" is a new execution mode** — durable mid-run state, resumption
   semantics, credential validity across the pause. That is materially more machinery than S0
   itself. **The middle path is not cheaper than the fix it defers.**

**Ruling on the middle path:** **adopt Half 1, reject Half 2.**

> **A genuinely safe middle path: unattended turns are READ-ONLY, full stop.** A write-capable
> tool in an unattended turn **terminates the turn** with an explicit, surfaced, first-class
> refusal — the same terminal discipline `refuseFrontierGrantedRun` (`dispatch.ts:513+`) already
> uses. It does **not** suspend, does **not** queue, does **not** resume. The operator sees a
> refusal record and can re-run the work attended.

This is safe **without S0**, because no grant is ever consumed in an unattended run. It is
enforceable at one chokepoint on a fail-closed classification. And it is **honest**: the operator
gets a clear "this needed a write and I would not do it unattended" rather than a silent skip.

**But note what it costs, so the operator is not misled:** a read-only cron is a **reporting and
monitoring** capability, not an acting one. If the operator's target for cron includes scheduled
work that writes — and "everybody is using it" suggests it does — **the middle path does not
deliver that target, and S0 remains the real prerequisite.** The middle path is a way to ship
*useful* unattended execution one slice early. **It is not a way to ship the full capability
early, and it should not be sold as one.**

### 2A.5 Ruling 4 — What cron introduces that auto-reply does not

Four items. **The first is better than feared; the second and third are real and unsolved; the
fourth is the one that must not be got wrong.**

**(a) No live socket to deliver an approval prompt to — LESS SEVERE THAN IT LOOKS. Verified.**
`persistAndPublish` (`events.ts:66-82`) **INSERTs the event first**, assigns `seq` from
`lastInsertRowid`, and **then** calls `sessionBus.publish`. So a `PENDING_APPROVAL` emitted with
no subscriber is **durably recorded** and carries a monotonic `seq`. Combined with core
invariant 2 (sessions outlive sockets, resume by `seq` cursor), **an approval raised at 03:00 is
retrievable when the operator connects at 09:00.** The delivery architecture already handles
this correctly, and the design decision that makes it work — persist-then-publish — is the same
one that makes S3's "trigger on committed events, never socket delivery" correct. **No new
mechanism needed for durability.**

**(b) The 15-minute TTL defeats (a). REAL, UNSOLVED, and the sharpest cron-specific defect.**
`APPROVAL_TTL_SECONDS = 15 * 60` (`approvalWriter.ts:54`) and `GRANT_TTL_SECONDS = 60` (`:55`).
`sweepExpiredApprovals` (`:191-200`) sets `status='expired'` for any pending row past its
deadline. **A 03:00 approval is `expired` by 03:15.** The event is durable; the *actionability*
is not. **A 15-minute TTL is correct for a human at a console and wrong for a scheduled run.**

**Required (B-8):** a cron-originated approval needs a **different, longer, explicitly-configured
TTL**, or an explicit **non-expiring pending-operator-attention** state. This is a design
decision for the cron PRD, not for PRD-007 — **but PRD-007's S3 must not assume a queued approval
survives, and no cron slice may ship without ruling it.**

**(c) No operator session to attribute the run to. REAL — and PRD-007 already contains the
correct answer, which cron must reuse rather than reinvent.** The PRD's §2.1 chain is exactly
right for cron: the schedule runs as an **agent principal**, bound at dispatch from gateway
state, never from schedule content. §2.1's prohibition list applies **verbatim and with more
force**: ❌ no "system"/"gateway" principal posting on an agent's behalf; ❌ no principal derived
from schedule payload. **A cron run must have a real agent principal or it must not run.**
§2a's rule holds unchanged: unresolved principal ⇒ `COLLAB_IDENTITY_REQUIRED`, no synthesis.
**If cron cannot name a real agent principal, that is a reason to refuse the run, not a reason
to invent a principal.**

**(d) Wake-time credential and authority validity. REAL, and the mechanism already exists —
it must be reused, not bypassed.** A schedule created in January and firing in June may reference
a revoked credential, a removed membership, or a stale profile delegation. **`admitToolCall`
already re-reads all of this live** — profile delegation at `grantAdmission.ts:215-225`
(`profile-delegation-stale`) and deciding-surface auth epoch at `:228-236`
(`authority-epoch-stale`), specifically so *"a revoke-then-dispatch race has one durable
outcome."*

**The binding rule for cron: every authority input must be evaluated at WAKE TIME, never cached
at schedule-creation time.** Membership (`assertChannelVisible`, `store.ts:2032`), principal
status (`principalAuthorityForCredential` requires `principalStatus === 'active'`), credential
validity, and profile delegation — all re-read at wake. **A schedule is a trigger, never a stored
authorization.** This is the exact same principle as T-1's INV-T1: the trigger selects *when*,
never *what is permitted*.

**(e) The item the coordinator flags as must-not-get-wrong: an approval with no one to answer
it must NOT time out into a silent skip OR a silent proceed. AGREED, and I make it binding.**

Both failure modes are live risks here. **Silent proceed** is the catastrophic one and is
exactly what an un-finished `admitTool` produces — condition 1 or 2 returns `{ok:true}` and the
call executes. **Silent skip** is the insidious one: `sweepExpiredApprovals` writes
`status='expired'`, and if the cron run simply ends, the operator sees a completed schedule with
no indication that work was silently dropped. **That is the same class as S-5's silently-dead
loop — a failure indistinguishable from a legitimate outcome.**

> **Binding rule (B-8, part 2): an unattended run whose approval is unanswered must terminate in
> a THIRD, explicitly distinguishable state — neither success nor a bare failure.** The repo
> already has the right pattern: `materializeExpiry`'s own comment (`approvalWriter.ts:169-171`)
> states that *"[the expired] terminal shape is deliberately distinguishable from a decided
> one."* **Preserve that distinguishability all the way to the operator-facing surface.** The
> schedule's run record must say *"blocked awaiting approval, never answered, work not
> performed"* — never a bare "completed", never a bare "failed", and never nothing at all. This
> is core invariant 7 (one terminal event per task) plus the §6 S6 honesty standard applied to a
> run nobody watched.

### 2A.6 Does cron change the verdict or the ordering? **Ordering: YES. Verdict: NO.**

**Verdict unchanged: APPROVE_WITH_CONDITIONS.** Cron does not make PRD-007's design wrong. It
**validates** it — the PRD's authority chain (§2.1), its persist-then-publish trigger discipline,
and its §2a no-synthesis rule are all exactly what a cron scheduler will need. **PRD-007 is the
right foundation for cron and should be built.**

**Ordering changed, and this is the answer the operator asked for undiluted:**

> **The true prerequisite order is: argument-scoped grants (S0) FIRST, then unattended triggers —
> auto-reply and cron — in either order.**
>
> **The operator can have cron. The honest cost is one slice of delay, not a reduced
> capability.** S0 is a bounded, well-understood change to a mechanism that already exists and is
> already correct in its core (`admitToolCall`); what is missing is wiring, and the wiring's
> flag-dependence is a defect class this program **already fixed once today on FRONTIER**
> (`72b4d36`). This is not new architecture. It is carrying a known fix across a boundary that
> was missed.
>
> **If the operator wants unattended execution before S0 lands, the read-only middle path
> (§2A.4, Half 1 only) is genuinely safe and ships a real capability** — scheduled reporting and
> monitoring — **but it will not run write-capable work, and it must not be described as though
> it will.**

**I am not softening this.** Shipping either unattended trigger over an open name-only grant
would hand the operator a system in which "approve `terminal ls`" silently authorizes
`terminal curl … | sh` at 03:00. That is not a hypothetical construction; it is the direct
reading of `ollama.ts:356` plus `server.ts:145`, both verified.

---

## 3. RULING ON T-1 — mention-dispatch (declined) vs. membership-triggered auto-reply (specified)

### 3.1 AFFIRMED

**I affirm the PRD's reading.** The distinction is real, load-bearing, and rests on the
authorization source — not on a verbal difference.

**Reasoning.** The frozen rule (005 §2(d), restated by the PRD at §5.2) is *"a message is data,
not a command."* The correct test for whether a trigger violates it is not *"did a message cause
something to happen"* — under that test, a human reading a message and acting would violate it.
The correct test is: **can the content of a message change the set of principals whose
authority is exercised?**

- **Mention-dispatch fails that test.** The mention names an arbitrary principal. The set of
  agents that can be activated is **exactly the set of principal identifiers anyone with write
  access can type**. Authorization is read out of the message body. That is message content
  functioning as a command, and it is what 005 §12a froze.

- **Membership-triggered auto-reply passes it.** The trigger set is
  `{agents with an active collab_members row in this channel}`. That set is written by
  `addChannelMember`, whose guards I verified at `store.ts:1030-1050`:
  `assertChannelOwner` upstream, and `target.kind !== 'agent' || target.owner_principal_id !==
  channel.owner_principal_id` ⇒ `notFound()`. **A message cannot add a row to
  `collab_members`.** The membership row is standing, human-authored state, written through an
  operator-only path. Message content selects **nothing**. It is a *clock tick* against a
  human-fixed set, not a *selector* over an open set.

The sharpest way to state it: **under mention-dispatch, the blast radius is the set of
principals that exist. Under membership-triggering, the blast radius is the set of principals
the human put in the room — and it is identical whether the message says "hello" or names every
agent in the system.** The message cannot widen it. That is the whole difference, and it is
sufficient.

### 3.2 The invariant that must hold forever

The PRD proposes it and it is correct. I restate it as binding, in enforceable form:

> **INV-T1. The set of agent principals eligible to be triggered by a committed channel event
> MUST be a pure function of `(channelId)` evaluated against `collab_members`, and MUST NOT
> depend on any byte of the triggering event's `content_json`, on the event's `kind`, or on any
> model output.**
>
> **Corollary A.** The trigger may read `actor_principal_id` (to exclude the author, anti-storm
> requirement 1) and `channel_seq` (idempotency, requirement 2) — both are **substrate
> metadata**, not content. It may **not** read `text`.
>
> **Corollary B.** The eligible set is identical for every message in a channel at a given
> membership state. Two different messages in the same channel at the same membership state
> **must** yield byte-identical eligible sets.
>
> **Corollary C.** No tool, no message, and no model output may cause a write to
> `collab_members`. (Reinforces the PRD §6 non-scope "agent-initiated channel creation or
> self-add," which is correct and must be mechanically true, not merely declared.)

### 3.3 How it must be ENFORCED — not asserted

**The PRD does not currently say how, and this is a gap.** T-1 is a paragraph of prose in §10.
Prose is exactly what this repo's unenforced-claim pattern is made of. **Three mechanisms are
required (B-3):**

1. **Structural: the trigger's resolver must not be given the content.** The function that
   computes the eligible set must take a **type-level narrowed input** that does not carry
   `text` — e.g. `resolveEligibleAgents(channelId: string, actorPrincipalId: string, seq:
   number)`. It must **not** take the event row or the content. **A type signature is a
   compile-time enforcement of INV-T1 and is the cheapest durable one.** If the resolver cannot
   see the text, no future edit can accidentally consult it.

2. **Behavioral, falsifiable: the differential-content probe.** Seed one channel, fixed
   membership. Post message `M1` = `"hello"`. Record the eligible set. Reset. Post `M2` =
   a message crafted as an adversarial mention payload — containing every member principal id,
   every non-member principal id in the DB, `@everyone`, and a JSON-shaped
   `{"trigger":["<principalId>"]}` fragment. **Assert the two eligible sets are byte-identical,
   and assert the non-member principal ids appear in neither.** Then **falsify it**: patch the
   resolver to union in any principal id found in the text, and show the test turns **RED**.
   Per §7.4 rule 2, the mutation must be **proved to have applied** by asserting the mutated
   artifact differs — **not** by trusting an exit code, and **not** through `python3`, which
   does not exist on this host.

3. **Regression-resistant: a source-level assertion.** The trigger module's eligible-set
   resolver must be asserted (by source inspection, the pattern
   `tests/collab/fanout-revocation.test.ts:97-108` already uses in this repo for a structural
   claim) to contain **no reference** to `content_json`, `text`, or the event body. This is the
   weakest of the three and must not stand alone, but it catches the specific reintroduction
   route — someone adding "just a small mention convenience."

**With all three, T-1 is enforced. With only the prose, it is an unenforced claim, and this
program has four of those from today alone.**

---

## 4. Context / memory for unbounded exchanges — SUMMARIZATION

### 4.1 Ruling: **NOT a Gate-1 blocker. It is a required S3 slice-level criterion.**

The orchestrator's judgment — that summarization-on-handoff is now a **correctness**
requirement rather than an optimization, because turns are unbounded — is **correct in
substance**. Unbounded turns against a finite context window is a physics problem, and it will
be hit. But it is **not a Gate-1 blocker**, for two reasons:

**Reason 1 — the substrate already provides the necessary primitive, verified.**
`getChannelTimeline` (`store.ts:1789-1814`) takes `{channelId, afterCursor, limit}`, enforces
`limit` ∈ [1,100] (`:1795-1797`), and queries
`WHERE channel_id = ? AND channel_seq > ? ORDER BY channel_seq ASC LIMIT ?` (`:1811-1814`). **An
agent can fetch a bounded window rather than the whole log.** The failure mode "agent reads the
entire channel and blows its context on turn 200" is **already preventable** with the API as it
exists. No substrate work is needed.

**Reason 2 — it is a per-turn property, not an architectural one.** Each auto-turn is a fresh
task dispatch. There is no accumulating in-memory conversation object that must be compacted
across turns; the durable state is `collab_events`, and each turn re-reads a window of it. This
is structurally *better* than a long-lived chat session, and it is a consequence of the PRD's
correct decision to trigger on **committed substrate events** rather than socket delivery
(§4 S5). **The architecture already avoids the worst version of this problem.**

### 4.2 But cursor-paging alone is NOT sufficient, and S3 must say so

**Where I disagree with a purely "the substrate handles it" reading:** a bounded window
guarantees the agent's context **fits**. It does not guarantee the agent's context is
**useful**. At turn 200, an agent reading the last 50 events sees the tail of a conversation
whose premise was established at event 3. Two failure modes follow, both correctness failures,
not efficiency ones:

- **Premise loss** — the agents converge on something contradicting the human's original
  instruction, which has scrolled out of the window. The human's authorizing message is the
  *most* important message and the *first* to fall off.
- **Loop-by-amnesia** — A and B re-derive the same exchange because neither can see they
  already had it. This produces exactly the "loop unproductively for free" outcome R-3a's STOP
  control exists to let the human end — but it makes STOP the *only* defense, which is a manual
  defense against a mechanical failure.

**Required S3 criterion (non-blocking at Gate 1, blocking at S3 acceptance) — carried as N-1
in §Non-blocking:** S3 must specify the agent's read strategy explicitly, and it must be a
**named, tested** strategy rather than "the agent reads the channel." The minimum honest
version: **anchor + window** — always include the channel's first N events (which contain the
human's authorizing instruction) plus the most recent M, with the elision explicitly marked so
the model knows the record is partial. This needs no new substrate: two `getChannelTimeline`
calls. **A silent truncation is dishonest to the model in the same way a silent truncation is
dishonest to a human** — and `truncateHeadTail` (`ollama.ts:44-58`) already establishes exactly
this head+tail-with-marker discipline in this codebase, for exactly this reason (*"errors and
the useful tail of a result cluster at log ends; a head-only cut drops them"*). **Reuse the
established pattern; do not invent a new one.**

**Why not a Gate-1 blocker:** it changes no authority, no interface, and no slice ordering. It
is discharged inside S3 by specifying the read strategy, and it can be specified after Gate 1
without invalidating anything ruled here.

---

## 5. Anti-storm mechanics — storm scenarios constructed and tested against the spec

The PRD specifies four mechanisms (§4 S3). I constructed six scenarios. **Four hold. Two do
not**, and both gaps are in mechanism 2 (idempotency), whose spec is under-determined in a way
that matters.

### S-1. Two agents, alternating (the product) — **HOLDS**
A and B are members; human posts at seq 1. Trigger evaluates {A,B}, excludes neither (author is
the human). A posts seq 2 → B triggered (A excluded by mechanism 1, `actor_principal_id`
comparison on committed truth). B posts seq 3 → A triggered. **Evidence:** mechanism 1 compares
`collab_events.actor_principal_id` (written from `caller.principalId`, `store.ts:1463-1473`,
verified) against the candidate — server-side on committed DB truth, not a model convention.
Alternation is stable. **This is the intended behavior and it works.**

### S-2. Three agents — **HOLDS, but with a fan-out property the PRD does not name**
A, B, C all members. Human posts seq 1 → **three** turns dispatched. A posts seq 2 → B and C
triggered (2 turns). B posts seq 3 → A and C triggered. **Each message produces N−1 turns, so
message volume grows as O(N) per message and turn volume as O(N²) per round.** With N=3 this
is 6 turns per round; with N=6, 30.

**This is not a cost objection** — R-2 accepts zero marginal cost, and I am not re-proposing a
cap. It is a **legibility and STOP-latency** objection: the human's STOP (R-3a) must halt
before the *next* turn dispatches, and with N−1 turns already in flight per message, "the next
turn" is ambiguous. **Required clarification (N-2, non-blocking):** A3-e must specify STOP
semantics under fan-out — I recommend **STOP prevents any new dispatch immediately, and
in-flight turns complete but their posts do not re-trigger.** That is implementable (STOP is
checked at trigger evaluation, which runs on commit) and honest. The PRD says "halts before the
next turn is dispatched, not after the in-flight one completes its tool calls," which is the
right instinct but is written for N=2 and is ambiguous for N>2.

### S-3. An agent posts twice in one turn — **HOLDS**
A's turn calls `collab__post_message` twice → seq 2 and seq 3, distinct server-minted
idempotency keys (S2's rule: key is server-minted per tool call, never model-supplied — **this
rule is correct and load-bearing**, and A2-c tests it). B is triggered by seq 2 and by seq 3.
Mechanism 2 keys on `(channelId, channel_seq, agentPrincipalId)`; **seq 2 ≠ seq 3, so these are
two legitimately distinct triggers, not a double-reply.** The dispatch-layer rule (mechanism 3,
one in-flight turn per (agent, channel), with a **dirty flag coalescing to exactly one**
follow-up) collapses them into **one** follow-up turn for B, which reads both messages. Correct
and desirable.

### S-4. Concurrent posts by A and B — **HOLDS at the substrate; the PRD is right about why**
Verified: `postChannelMessage` runs inside `withReadThenSequencer(() => this.mutex.withLock(...))`
(`store.ts:1435-1437`) and takes `getMaxChannelSeq(tx, channel.id) + 1` **inside** the lock
(`store.ts:1458`). `channel_seq` is therefore totally ordered and dense regardless of
concurrency. The PRD's claim is **verified true**, and its conclusion — that the remaining
requirement is at the *dispatch* layer, not the substrate — is correct.

### S-5. Reconnect / gateway restart mid-exchange — **DOES NOT HOLD as specified. GAP.**

The PRD requires (mechanism 2) that the trigger *"record the highest `channel_seq` each agent
has been dispatched for and refuse to dispatch at or below it,"* and that this *"must be
durable, or a gateway restart mid-loop re-triggers the whole backlog."* **The requirement is
correctly identified. The mechanism is under-specified in a way that admits a wrong
implementation, and the wrong implementation is the natural one.**

The gap: **"highest seq dispatched" and "highest seq completed" are different watermarks, and
the PRD names only one.** Consider: A is dispatched for seq 5. The watermark is written as 5.
The gateway crashes before A's turn produces anything. On restart, the trigger sees watermark 5
and **refuses to dispatch at or below it** — so **seq 5 is never answered**. The loop dies
silently, and it dies in a way that looks like the legitimate outcome A3-f (silence is valid),
so **nothing surfaces**. That is worse than a storm: a storm is visible.

The mirror error is equally available: write the watermark on **completion**, and a crash
mid-turn re-dispatches on restart — the exact replay the PRD forbids.

**Neither is caught by A3-b as written.** A3-b says *"a simulated gateway restart with a loop
mid-flight does not re-dispatch any `channel_seq` already dispatched."* **That criterion is
satisfied by the silently-dead-loop implementation.** It tests only one direction. **A3-b is
therefore satisfiable by broken code**, which puts it in the assertable-criteria list below.

**Required (B-3, part 2):** S3 must specify the watermark's **write point** and its
**crash semantics** explicitly, and A3-b must be **bidirectional**: (i) restart must not
re-dispatch a completed turn; **and (ii) restart must not strand a dispatched-but-unstarted
turn** — the event must either be re-dispatched or the branch must terminate with an **explicit,
surfaced** outcome distinguishable from A3-f silence. **A silent stall must not be
indistinguishable from a legitimate choice not to speak.** The honest design: a durable
`dispatched` record with a terminal transition, and recovery that **re-dispatches** un-terminated
records — matching `revokeInertGrants` (`grantAdmission.ts:250-270`), which handles exactly this
crash-between-decision-and-effect class and resolves it by an **explicit** sweep rather than by
inference. Reuse that pattern.

### S-6. Membership removed mid-flight — **DOES NOT HOLD. GAP the PRD does not name.**

The PRD lists "by membership" as a termination path: *"removing an agent from the channel ends
its participation (`removeChannelMember`, `store.ts:1205`)."* **Verified that the substrate
enforces this at commit time** — `postChannelMessage`'s predicate is `assertChannelVisible`
(`store.ts:1447` → `:2032-2046`), which requires `member.state === 'active'`. So a removed
agent's post is refused `COLLAB_NOT_FOUND`. **Good — the substrate holds.**

**But the PRD does not say what the auto-turn does with that refusal.** The turn was dispatched
while the agent was a member; by the time it calls `collab__post_message`, it is not. The tool
returns a structured error. **Under S2's design, that error goes back to the model as a tool
error** (`registry.ts:226-229`). A model receiving "not found" will plausibly **retry with a
different channelId**, or retry the same one. This interacts badly with mechanism 4 ("a turn
that fails must not silently retry forever") — which governs **dispatch** failures, not
**in-turn tool** failures. **The two are different layers and mechanism 4 does not reach this
one.**

**Required (B-3, part 3):** S3 must specify that an auto-turn whose `collab__post_message`
returns `COLLAB_NOT_FOUND` **terminates the branch** rather than being left to model judgment,
and that removal takes effect **at trigger evaluation** as well as at commit — so a removed
agent is not dispatched at all. **This must not be left to the model.** Note the constraint from
§1.4 item 6: the refusal must remain byte-identical to the nonexistent-channel case, so the
**gateway**, not the model, must be the one that knows which case it is — reinforcing that this
be handled at the trigger layer.

---

## 6. Are the acceptance criteria satisfiable by assertion or by mocking?

The PRD's §7.5 is the strongest anti-unenforced-claim section I have seen in this program, and
most criteria are well-formed against it — A1-a ("reading the DB row, not the return value"),
A2-d ("the rendered tool list the model actually receives"), A4-b (**key-set equality**, which
correctly fails on a *future added field* — this is the right shape), A5-a ("the tool's real
side effect absent, not an approval event emitted"), A5-b/A3-a with explicit RED requirements.

**But five criteria are satisfiable by broken code as written.** Each is listed with the break
that would pass it.

1. **A3-b (idempotency across restart).** Passes against the **silently-dead-loop**
   implementation (S-5). Tests only the no-replay direction. **Fix: make it bidirectional.**

2. **A1-d (flag-off inertness).** *"proven by asserting the absent-deny response, not the flag's
   value."* The shape is right, but **"the absent-deny response" is not specified**, and there
   are two possible ones (`NOT_ENABLED` from `collabSurfaceCommandsEnabled`, vs.
   `COLLAB_IDENTITY_REQUIRED` from a null principal). A test asserting "some error occurred"
   passes against a build where the flag does nothing and the failure comes from an unrelated
   layer. **Fix: name the exact expected code and assert on it, and prove RED by enabling the
   flag and observing the response change.**

3. **A5-d (`collab__post_message` does not match `approvalPatterns`).** *"asserted against the
   effective, rendered policy for the tool, not the pattern list in config."* Right instinct,
   but the criterion tests a **negative on a name**. It passes trivially and would **still pass**
   if `capabilities` were omitted and `capability.ts:172` classified the tool `'write'` ⇒
   `requiresApproval: true` — because `requiresApproval` is
   `isWriteClass(cap) || patterns.some(...)` (`registry.ts:164`), and A5-d only tests the second
   disjunct. **A5-d as written cannot detect the exact failure §3.4 row 1 warns about.**
   **Fix: assert the registered entry's `requiresApproval` is `false` AND its `capability` is the
   explicitly configured value — the whole expression, not one term.**

4. **A2-a (`post_message` to a non-member channel writes zero rows).** "DB-provable" and
   correct — **but it passes identically against a build where the tool is broken and writes
   zero rows for *every* channel.** A zero-row assertion with no positive control proves nothing
   about the guard. **Fix: pair it with the positive case in the same test — member channel
   writes exactly one row, non-member writes zero — so a universally-broken tool fails.** This is
   precisely the V-1/RC-1/B-1 shape (§7.4 rule 3): the probe must exercise the same handle as the
   assertion.

5. **A6-a (no surface renders a global negative).** *"string-level assertion over the built UI
   source"* for prohibited phrasings. This catches the **exact strings** and nothing else. A
   reintroduction as `"Nothing " + noun + " right now"`, or in a different casing, or via an i18n
   key, passes. **Fix: keep it, but downgrade the claim** — it is a **regression guard for known
   phrasings**, not a proof of the property. **State that honestly in the criterion**, per the
   PRD's own §6 S6 honesty standard. A criterion that overclaims its own strength inside a
   label-honesty slice would be self-refuting.

**Additionally, A3-c is the best criterion in the document** — *"asserted on committed
`collab_events` rows with their `actor_principal_id` values and `channel_seq` ordering — not on a
mocked dispatcher."* That criterion cannot pass against broken code, and it is the one that
proves the product exists. **Keep it exactly as written.**

---

## 7. Slice ordering — **COHERENT**, with one required correction

The chain **S1 → S2 → S3** is correct and strictly necessary: no tool without identity, no loop
without tools. **S5 correctly declared parallel and explicitly barred from becoming an S3
dependency** — the reasoning (S3 triggers on committed substrate events, never socket delivery,
because the §19 backpressure debt is undischarged) is **excellent** and is the single best piece
of design reasoning in the PRD. It turns an undischarged debt into a **binding architectural
constraint** rather than pretending it away. **Preserve that reasoning verbatim in code
comments.**

**Correction required (B-6): the ordering diagram at §11 is inconsistent with §12 on S4.**
§4 S4 says *"Until ruled, S4 ships membership ('Members') only, without the working overlay,"*
and §11 says *"S4 is blocked on OQ-2 for its working overlay; its 'Members' half may ship
earlier."* Both are fine. But the §11 **diagram** annotates the whole of S4 as
`[BLOCKED on OQ-2]`, which contradicts the prose beside it. **A Builder reading the diagram
would block the wrong thing.** Split S4 into **S4a (Members — unblocked)** and **S4b (working
overlay — BLOCKED on OQ-2)** in the diagram. Trivial, but this repo has shipped defects from
exactly this kind of doc/diagram drift.

**No slice carries a criterion blocked on an undischarged stop condition, with one exception
already correctly flagged:** A4-a/A4-b belong to S4b and are gated behind OQ-2, which the PRD
states. Good.

**One ordering observation the PRD gets right and should be defended:** S6 (label honesty)
"ships alongside the first UI-visible slice." Since S6 also **applies retroactively to 005 S5's
labels**, there is a temptation to defer it. **Do not.** It is the cheapest slice and it fixes a
shipped honesty defect.

---

## 8. §1 authority answer — **VERIFIED TRUE**

The PRD's central claim is that an agent's authority to speak **is** its own active row in
`collab_members`, and that `postChannelMessage`'s only predicate is `assertChannelVisible`,
which never reads `caller.kind`. **I verified this directly and it is true.**

`store.ts:1435-1447` — the predicate slot passed to `runKeyedCommand` is exactly:
```
(tx) => this.assertChannelVisible(tx, caller, normalizedBody.channelId),
```
and nothing else.

`store.ts:2032-2046` — `assertChannelVisible` checks **exactly two** things:
```
const channel = tx.prepare('SELECT * FROM collab_channels WHERE id = ?').get(channelId);
if (!channel) throw notFound();
const member = tx.prepare('SELECT * FROM collab_members WHERE channel_id = ? AND principal_id = ?')
  .get(channelId, caller.principalId);
if (!member || member.state !== 'active') throw notFound();
return member;
```
**`caller.kind` appears nowhere.** Both denial arms call the same `notFound()`, so a probing
agent cannot distinguish "not a member" from "does not exist" — the T-2 indistinguishability
property, verified intact.

**And the membership gate is genuinely operator-only and agent-only**, verified at
`store.ts:1038-1041`:
```
if (!target || target.kind !== 'agent' || target.owner_principal_id !== channel.owner_principal_id) {
  throw notFound();
}
```
plus the comment at `:1032-1036` recording that **no caller-supplied role parameter exists** —
this path only ever inserts `role='agent'`, so privilege escalation via role injection is
structurally impossible, not merely checked.

**Stated plainly, as the brief asks: this means NO NEW PERMISSION MODEL IS NEEDED.** The
substrate was built kind-blind on the post path, deliberately, and that kind-blindness is the
feature that makes agent participation a transport problem. **The PRD's §2.1 prohibition list —
no system/gateway principal posting on an agent's behalf, no channelId from task input without
the membership check, no `caller.kind === 'agent'` special case, no principal derived from prompt
or model output — is exactly right and must be carried into the scoping doc as binding.**

I additionally confirm the PRD's §2.1 step-1/step-2 chain: minting is `assertOperatorCaller`-gated
and granting is `assertChannelOwner`-gated, so the human act of adding an agent to a channel **is**
the authorization, exactly as R-1 frames it.

---

## 9. Is the UNVERIFIED quarantine honest?

**YES — and it is the most honest quarantine I have reviewed in this program.** I checked each
§8 row against the acceptance criteria for a secret dependency:

- **U-2** (no agent read path exists — an absence claim). The PRD asks the Gate-1 reviewer to
  confirm independently. **I confirm it:** `getToolsForTask` has one call site (`ollama.ts:189`,
  hardcoding `'LOCAL_EDGE'`), the registry is populated only by `connectServer` from remote
  `listTools()`, and no collab-backed server exists in `connectBridge()` (`registry.ts:235-260`,
  which connects only `hermes` plus the user roster from `~/.torqclaw/servers.json`). **No
  acceptance criterion depends on U-2 being true** — the criteria assert what the *new* tools do,
  which is a presence claim.
- **U-3** (Buzz internals). Used only as design rationale in §4 S4 and T-4. **Correctly barred**;
  no criterion cites it. **Safe as used**, as the PRD says.
- **U-4** (Hermes line numbers). The PRD explicitly separates the unverified half (upstream line
  numbers) from the **verified load-bearing half** (`hermes_runner.py:610`, delegation disabled by
  default). Only the verified half carries weight. **Correct split.**
- **U-5** (005 §13 row 10). Supports only a non-scope item. **No criterion depends on it.**
- **U-6** (STOP restart persistence). Correctly escalated to **OQ-3 (BLOCKING S3
  completeness)** rather than assumed. **Right call.**
- **U-1 and U-7 were resolved during drafting** and struck through, with U-1 **promoted to a
  blocker** (OQ-6) — i.e., the author resolved an unknown in the direction that made their own
  work larger. **That is the behavior the discipline exists to produce.**

**The PRD's closing claim — "No acceptance criterion in this document rests on an unverified
claim" — is TRUE.** I attempted to falsify it and could not.

**One honesty correction (B-4):** the PRD's §5 A5-a FRONTIER description is **stale relative to
`63e53f8`** (see §2.1). This is not a quarantine failure — the claim was true at `8c8e7c5` — but
it must be corrected before it becomes an acceptance criterion, because a Builder would write a
test against behavior that no longer exists. **Also update the header, which reads `HEAD: 8c8e7c5`.**

---

## 10. Blockers (conditions of approval)

| ID | Title | Detail | Suggested fix |
|---|---|---|---|
| **B-1** | **LOCAL_EDGE argument-blind grant must be closed before ANY unattended trigger (S3 *and* cron) — this is the prerequisite slice S0** | `ollama.ts:356` checks `grantedTools.includes(realName)` — name only. The exact-action seam `admitTool` short-circuits at `server.ts:145` (`if (!collabEnabled()) return {ok:true}`) **and** its producer is gated at `c2Broker.ts:132` (`if (!collabEnabled()) return null`). `collabEnabled()` defaults **false** (`principalBridge.ts:71-72`; `.env.example` sets no collab flag — verified). FRONTIER was closed flag-independently by `72b4d36` today; **LOCAL_EDGE was not carried across.** An unattended loop or a 03:00 cron turn can re-invoke a once-approved tool with new arguments indefinitely — "approve `terminal ls`" silently covers `terminal curl … \| sh`. Directly falsifies §5.2's "every effect still crosses [the approval boundary]" and R-3b. | **File S0 as its own slice, ordered FIRST**, exactly as `72b4d36` was filed independently of PRD-006. Finish the `admitTool` wiring (§2A.2): (1) remove flag-dependence at `server.ts:145` **and** `c2Broker.ts:132`; (2) close condition 2's `!carriesGrant ⇒ ok` gap **for unattended runs only**, preserving the D-3/SI-4 fix for legacy human connections; (3) B-7; (4) prove on the LOCAL_EDGE handle by **side-effect absence**, shown RED. **Do NOT gate `TORQCLAW_AGENT_AUTOREPLY` on `TORQCLAW_COLLAB_ENABLED`** — a security property a flag can switch off is not one (`dispatch.ts:501-505`). **Do NOT relax `frontierGrantFenced`** to make cron work. |
| **B-7** | **The C2 recovery sweep is flag-gated — same defect class as B-1, in the recovery path** | `server.ts:761` wraps `revokeInertGrants` / `sweepExpiredApprovals` / `sweepExpiredGrants` in `if (collabEnabled())`, which defaults false. A crashed gateway therefore leaves inert grants unrevoked and stale approvals actionable in the default configuration. Matters materially more for unattended execution: nobody notices. | Make the boot recovery sweep **flag-independent**, on the same reasoning as `72b4d36`. Ship with S0. |
| **B-8** | **Unattended approval has no reader, and both timeout outcomes are silent** | `APPROVAL_TTL_SECONDS = 15 * 60` (`approvalWriter.ts:54`, verified) — a 03:00 cron approval is `status='expired'` by 03:15, long before anyone wakes. Durability is fine (`persistAndPublish` INSERTs before publishing, `events.ts:66-82`), but **actionability is not**. Both failure modes are silent: **silent proceed** (what an unfinished `admitTool` produces) and **silent skip** (expired sweep + run ends, operator sees a clean completion with work dropped) — the latter is the same class as S-5's silently-dead loop. | Cron-originated approvals need an explicitly-configured longer TTL or a non-expiring pending-attention state (a cron-PRD decision, but **no cron slice ships without ruling it**). **And bindingly:** an unattended run whose approval goes unanswered must terminate in a **third, explicitly distinguishable state** — never bare "completed", never bare "failed", never nothing. Preserve the distinguishability `materializeExpiry` already establishes (`approvalWriter.ts:169-171`) all the way to the operator surface. |
| **B-2** | **In-process transport must not be user-configurable** | OQ-6 ruled to option (a). `loadServerConfigs()` (`registry.ts:252`) builds `ServerConfig` from `~/.torqclaw/servers.json`. If the new `in-process` variant is added to the zod `discriminatedUnion` (`serverConfig.ts:12-23`), a user config file could declare arbitrary in-process providers. | The in-process variant is constructible **only from code in `connectBridge()`**. The user-roster zod schema must continue to admit exactly `stdio` and `streamable-http`. Test: a `servers.json` containing `{"type":"in-process"}` is **rejected by validation**, and no entry is registered. |
| **B-3** | **T-1 and the two anti-storm gaps need mechanisms, not prose** | Three parts. **(a) INV-T1 unenforced:** §10 is prose; a mention convenience could be added with no test failing. **(b) Idempotency watermark under-specified (S-5):** "highest seq dispatched" vs "completed" are different watermarks; the dispatched-and-crashed case strands the branch **silently, indistinguishably from A3-f**. A3-b tests only the no-replay direction and passes against the dead-loop build. **(c) Membership removal mid-turn (S-6):** substrate refuses the post (verified), but S3 does not say the branch terminates; the model receives a tool error and may retry. Mechanism 4 governs dispatch failures, not in-turn tool failures. | **(a)** Type-narrow the resolver so it cannot receive `text`; add the differential-content probe (identical eligible sets for `"hello"` vs. an adversarial mention payload) with a **proved-applied** mutation (not via `python3` — it does not exist on this host); add the source-level no-`content_json` assertion. **(b)** Specify the watermark write point and crash semantics; make A3-b **bidirectional**; recover un-terminated dispatches by an explicit sweep, reusing the `revokeInertGrants` pattern (`grantAdmission.ts:250-270`). **(c)** Evaluate membership at **trigger time**, and terminate the branch on `COLLAB_NOT_FOUND` at the gateway — never leave it to model judgment. |
| **B-4** | **PRD is stale at `63e53f8` on the FRONTIER approval path** | §5 A5-a describes FRONTIER approval as the `pre_tool_call` relay at `hermes.ts:177-182`. At `63e53f8`, `frontierGrantFenced` (`dispatch.ts:505-507`) **refuses** a granted FRONTIER run outright, flag-independently (`72b4d36`), and `admitToolCall` fails closed for FRONTIER before touching state (`grantAdmission.ts:141-142`). A Builder would write A5-a's FRONTIER leg against behavior that no longer exists. Header also reads `HEAD: 8c8e7c5`. | Rebase the PRD onto `63e53f8`. A5-a's FRONTIER leg must assert the **refusal terminal** (`reason: 'frontier-structured-grant-unavailable'`), not an approval relay. Update the header. |
| **B-5** | **Five acceptance criteria are satisfiable by broken code** | A3-b, A1-d, A5-d, A2-a, A6-a — each with its specific break, enumerated in §6 above. This is the repo's recurring unenforced-claim pattern (four instances today: V-1, RC-1, B-1, C-S5-1). | Apply the five named fixes in §6. In particular: A5-d must assert the **whole** `requiresApproval` expression plus the explicit `capability`, not just the pattern disjunct; A2-a must carry a **positive control** in the same test. |
| **B-6** | **§11 diagram contradicts §4 S4 / §12 prose on S4** | The diagram annotates all of S4 `[BLOCKED on OQ-2]`; the prose says the "Members" half may ship earlier. A Builder following the diagram blocks unblocked work. | Split into **S4a (Members, unblocked)** and **S4b (working overlay, BLOCKED on OQ-2)** in the diagram. |

**Also carried forward as a hard precondition, already correctly stated by the PRD (§7.7):**
implementation may not begin while `commands.ts`, `server.ts`, `authz.ts`, `sessions.ts`,
`collabIdentity.ts` carry uncommitted operator WIP and `connectionAuth.ts` is untracked. **I
re-confirmed at `63e53f8` that these remain modified/untracked.** Repo rule: **stop and ask
before co-editing files with owner edits.** This is an operator decision, not a reviewer's.

---

## 11. Non-blocking observations

- **N-1. Summarization / read-strategy (§4 above).** Not a Gate-1 blocker; **required S3
  criterion**. Cursor paging (`store.ts:1789-1814`, `limit` ∈ [1,100]) makes the context
  **fit**; it does not make it **useful**. Specify **anchor + window** with an explicit elision
  marker, reusing the `truncateHeadTail` head+tail-with-marker discipline already in this
  codebase (`ollama.ts:44-58`) rather than inventing a new one.
- **N-2. STOP semantics under N>2 fan-out (S-2).** A3-e is written for N=2. Each message
  produces N−1 turns; "before the next turn is dispatched" is ambiguous with several in flight.
  Recommend: **STOP prevents any new dispatch immediately; in-flight turns complete but their
  posts do not re-trigger.** Not a cost control.
- **N-3. `predictTools` routing side effect (§3.4 row 6).** The PRD correctly flags that adding
  two collab tools can push a task past `requiredTools.length > 3` and re-route it to FRONTIER
  (`router/src/engine.ts:142`). With B-4's correction this is now **sharper**: a FRONTIER
  re-route of a granted run hits the `72b4d36` **refusal**, so the failure is loud rather than
  silent. Good — but S2 must **measure** the re-route, as the PRD says, because a task type
  silently changing tier changes which approval mechanism governs it.
- **N-4. OQ-5 (model-side vs. gateway-side silence judgment)** interacts with S-5. If silence is
  a model judgment, a stalled branch and a chosen silence are **indistinguishable at the
  gateway**. That argues for at least a gateway-side **record** of "turn completed with no post"
  as distinct from "turn never completed," independent of which side makes the judgment. Worth
  the operator's attention when ruling OQ-5.
- **N-5. The kind-fallback test debt (§4 S1).** The PRD correctly requires S1 to add the missing
  test for the three-way least-privilege fallback (`collabSurface.ts:175-180`), noting that
  flipping it to `'operator'` left 38 tests green. **Endorsed as a hard S1 requirement** — S1 is
  the slice that makes a wrong `kind` stop being hypothetical.
- **N-6. Preserve the "trigger on committed events, never socket delivery" reasoning verbatim in
  code.** It is the load-bearing consequence of an undischarged §19 debt (§4 S5), and its
  rationale will not survive a refactor unless it is written where the code is.
- **N-7. Naming is load-bearing (§3.4 row 3).** `post_message` matches none of the seven
  `DEFAULT_WRITE_PATTERNS` (`registry.ts:49`); `send_message` would match `/send/i`. Verified.
  Record the name choice as deliberate, and **set `capabilities` explicitly regardless** — the
  name must never be the thing carrying the policy.

---

## 12. Summary judgment

**APPROVE_WITH_CONDITIONS.**

The authority model is **correct and verified** — the substrate is kind-blind on the post path
by design, the membership row is the authorization, and it is written through an operator-only
path that no message can reach. **No new permission model is needed, and §2.1's prohibition
list must be carried into scoping as binding.**

**OQ-6 is ruled: option (a), in-process transport via `InMemoryTransport`,** because it is the
only option that keeps `executeTool` a **single** dispatch path. A local handler field would be
the fourth instance of the fence-one-route defect this repo documented in its own source today.

**OQ-7 is ruled: S3 must not ship first.** The hole is real, verified, and open on LOCAL_EDGE in
the default configuration. It is the un-carried half of a fix this program landed on FRONTIER
eight hours ago. **This is not a cost objection** — the operator's zero-marginal-cost premise is
accepted and irrelevant. It is a direct threat to R-3b, the operator's own ruling that **acting
is not unbounded**.

**T-1 is affirmed** — the distinction rests on whether message content can widen the set of
principals whose authority is exercised, and it cannot. **But the invariant must be enforced by
a type-narrowed resolver, a falsifiable differential-content probe, and a source-level
assertion — not by a paragraph in §10.**

**S1 and S5 may proceed** once B-4 and B-5 are discharged and the operator resolves the §7.7 WIP
collision. **S2 is unblocked by this ruling on OQ-6** but must carry B-2. **S3 is blocked on
B-1 and B-3.**

**On the cron scope addition (§2A): the verdict is unchanged, the ordering is not.** Cron is the
same threat shape as auto-reply and strictly worse — no human proximity, no natural terminator,
and **durable state that outlives the regime it was created under**. It does not make this design
wrong; it **validates** it, because PRD-007's authority chain, its persist-then-publish trigger
discipline, and its no-synthesis rule are exactly what a scheduler needs.

**The true prerequisite order — stated undiluted, as asked: argument-scoped grants (S0) FIRST,
then auto-reply and cron in either order.** The operator can have cron; the honest cost is **one
slice of delay, not a reduced capability**. S0 is not new architecture — `admitToolCall` is
already correct in its core; what is missing is wiring whose flag-dependence is a defect class
**this program already fixed once today on FRONTIER** (`72b4d36`) and did not carry across.

**If unattended execution must ship before S0**, the read-only middle path is genuinely safe —
but **only Half 1** (§2A.4). Restrict unattended turns to read-only tools, enforced at
`executeTool` on **`capability`** (not `requiresApproval`, which is vacuous on FRONTIER at
`toolFilter.ts:77-78`), riding `capability.ts:172`'s fail-closed default. **Reject Half 2:**
"suspend and queue for approval" reintroduces the hole on resume, has no reader at 03:00, and is
more machinery than S0 itself. A read-only cron is a **reporting** capability, not an acting one
— **it must not be sold as the full target.**

**The document earns its approval.** Its evidence discipline is real — I re-derived every
load-bearing citation in §1–§3 with its enclosing branch conditions and defaults, and found no
overclaim. Its two self-promoted blockers both made the work larger. The conditions above are
about **enforcement mechanisms and one stale fact**, not about a flawed design.

---

*G1R · Opus 5 · 2026-08-17 · reviewed at `63e53f8` · no files modified other than this one.*
