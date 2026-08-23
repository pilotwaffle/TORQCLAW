# PRD-TCLAW-AGENT-PARTICIPATION-007 — Agent Participation in Channels

**Status:** v0.1 **DRAFT — pre-Gate-1.** Not reviewed by G1R. Not authorized for build.
**Repo:** `E:\TorqClaw` · **Branch:** `phase1-server-owned-authority` · **HEAD:** `8c8e7c5`
**Amends:** `docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` (v0.6). This PRD is **additive**: it
weakens, reworks, and removes nothing in 005. Where 005 froze a rule, that rule is inherited
verbatim and cited, never restated in a looser form.

**Relationship to 005.** 005 built the *human* surface: a human reads channels (S1/S2), a
human posts (S3), a human sees freshness (S4) and a roster (S5). Every message on that
surface is human→human. This PRD adds the **other participant**: the agent. It does not
re-open 005's substrate semantics, authority model, or non-scope.

---

## 0. The operator's target (verbatim, the thing being built)

> "The Human will start and the agents will answer, and the human can direct the agents to
> chat with each other. And also if one agent was already working on something and the human
> assigns another agent to work on it, those two agents can start talking automatically
> because they're working on the same project."

Three capabilities, in dependency order:

1. **Agents post into a channel and answer the human.**
2. **The human directs agents to chat with each other.**
3. **Two agents in the same channel converse automatically**, with no human in the loop on a
   per-turn basis.

Capability 3 is the product. Capabilities 1 and 2 are its prerequisites, and 1 is blocked on
a gap that must be closed before any of this is buildable (§1).

---

## 0a. Operator rulings governing this PRD (binding — not re-litigated here)

These were ruled by the operator before this draft. They are recorded so a reviewer can see
what is *settled* and does not need re-arguing, and so a Builder cannot quietly reopen one.

| # | Ruling | Consequence for this PRD |
|---|---|---|
| **R-1** | **"Same project" == SAME CHANNEL.** No project entity, no task-linkage table. | The channel IS the shared context. The human putting two agents in one channel is the act that makes them collaborators. §4 S3's trigger is channel membership, nothing else. **No new join table, no `project_id`.** |
| **R-2** | **Auto-reply is UNBOUNDED by default.** | A turn budget was proposed on runaway-**spend** grounds and **overridden**: the operator runs subscription models where the marginal cost of a turn is zero. **That premise is accepted. No turn cap may be re-proposed on cost grounds.** An optional cap MAY be specified for API-key/per-token models — **OFF by default, and NOT built in this PRD** (§6, deferred). |
| **R-3** | **What survives, for reasons that are NOT cost:** (a) a visible **STOP** control; (b) **write-capable tools remain individually approved on BOTH tiers.** | (a) Subscriptions cap cost, not *usefulness* — two agents can loop unproductively for free, and the human needs a way to end it. (b) Core invariant 5. **Talking is unbounded; ACTING is not.** Auto-conversation must never become an approval bypass (§4 S2, §5). |
| **R-4** | **Still declined:** reaction-triggered execution; in-channel approval gates; `@mention` → dispatch. | Inherited from 005 §3 / §12a. `approve` remains reserved operator-surface authority (frozen ruling, collab-gateway-004). Mention is **addressing, never dispatch**. |
| **R-5** | **Auto-reply between agents ALREADY ASSIGNED to a channel is a DIFFERENT trigger from a mention.** | The operator placed them there deliberately; membership is a standing, human-authored grant. **Do not use R-5 to justify mention-dispatch, and do not use R-4's mention prohibition to forbid membership-triggered reply.** They are separate triggers with separate authority sources. |

---

## 1. THE GAP — no agent can post to a channel today

**Finding: every message in every channel today is human→human. An agent has neither a read
path nor a write path into a channel. This is not a permissions gap — it is a missing
transport.** This is the first thing this PRD must close, and everything else depends on it.

### 1.1 Verified evidence (branch conditions and defaults included)

**The only production write path into a channel is a console ClientCommand on the operator's
websocket.**

- `POST_CHANNEL_MESSAGE` is declared as a wire ClientCommand at
  `packages/contracts/src/commands.ts:206`.
- Its sole gateway dispatch arm is `packages/gateway/src/server.ts:650`, inside the
  `socket.on('message')` switch. **Enclosing conditions, all of which must hold:**
  - the frame arrives on an authenticated gateway websocket connection;
  - `collabSurfaceCommandsEnabled()` is true (`server.ts:654` — else `sendErr('NOT_ENABLED')`
    and `break`). That function (`collabSurface.ts:63-66`) requires **both**
    `collabEnabled()` **and** `TORQCLAW_COLLAB_SURFACE_COMMANDS` ∈ `{1,true,yes,on}`.
  - `collabEnabled()` (`principalBridge.ts:71-72`) reads `TORQCLAW_COLLAB_ENABLED`;
    **default is unset ⇒ `''` ⇒ not in `TRUTHY` ⇒ false.** The module doc states
    "TORQCLAW_COLLAB_ENABLED, default off" (`principalBridge.ts:2`). **Both flags default
    OFF: the entire collab surface is dark in a default install.**
  - `connectionAuth?.principalId` must be non-null, else `handlePostChannelMessage` returns
    `COLLAB_IDENTITY_REQUIRED` and posts nothing (`server.ts:664-669`,
    `collabSurface.ts:344`).
- The handler `handlePostChannelMessage` (`collabSurface.ts:337`) is the **only** production
  caller of `store.postChannelMessage`. Verified by repo-wide grep: the only other hits are
  comments, `dist/` build output, `.torq/worktrees/` copies, and the store definition itself
  (`store.ts:1422`).

**There is no non-websocket entrypoint.** The only other channel adapter,
`packages/channel-http`, exposes `POST /task` — a task-submission surface, not a collab
surface. It has no `POST_CHANNEL_MESSAGE` path.

**Agents have no read path either.** `LIST_CHANNELS` / `GET_CHANNEL_TIMELINE`
(`collabSurface.ts:202`, `:244`) are wire commands on the same socket, gated by the same
flag. An executing task (LOCAL_EDGE tool loop or FRONTIER Hermes) has **no** tool, no MCP
namespace, and no API by which to read a channel timeline. **UNVERIFIED-adjacent note:** this
is an absence claim; it is supported by the bridge tool-registration survey (§3.3) finding no
collab-backed tool, but absence proofs are weaker than presence proofs. The Gate-1 reviewer
should confirm independently.

### 1.2 Why the gap is transport-only, not authority

This is the load-bearing finding of this PRD, and it is what makes the work small.

**The substrate already models agents as first-class speaking principals.** Verified:

- **Agent principals exist.** `store.createAgent` (`store.ts:426`) inserts
  `principals(kind='agent', owner_principal_id=<operator>, status='active', auth_epoch=1)`
  at `store.ts:459-461`.
- **Agent credentials exist.** The same call mints one via `issueCredentialRow`
  (`store.ts:463`), returning a `tq1_<credentialId>_<secret>` token
  (`credentials.ts:45`, `:84`). `createPrincipalCredential` (`store.ts:486`) mints
  additional ones for an existing principal.
- **Agents are the ONLY kind that can be added to a channel.** `addChannelMember`
  (`store.ts:1005`) rejects the target unless `target.kind === 'agent'` **and** the target is
  owned by the channel's owner (`store.ts:1040`); it inserts `role='agent'`
  (`store.ts:1085`). The membership row for an agent is the normal case, not an exception.
- **The post predicate never inspects caller kind.** `postChannelMessage`'s predicate slot is
  `assertChannelVisible` and nothing else (`store.ts:1447`). That function
  (`store.ts:2032-2046`) checks exactly two things: the channel row exists, and the caller has
  a `collab_members` row with `state === 'active'`. **It never reads `caller.kind`.**
  Corroborated by `collabIdentity.ts:206-207`: "`caller.kind` is read nowhere in `store.ts`"
  (grep-verified there, re-verified here).
- **Credential verification is kind-agnostic.** `verifySurfaceCredential` /
  `resolveConnectIdentity` (`collabIdentity.ts:241`, `:299`) verify any principal's
  credential and return its `principalKind` as *data*; neither refuses `kind === 'agent'`.
  `principalAuthorityForCredential` requires only `principalStatus === 'active'`
  (`collabIdentity.ts:258`).

**Therefore: if an agent principal held its credential and could open a connection, it could
already post — with no substrate change at all.** The substrate was designed for this. What
is missing is that nothing in the execution path (task dispatch, LOCAL_EDGE tool loop,
FRONTIER Hermes) ever *holds* such a credential or *speaks* the collab wire protocol.

### 1.3 Why identity cannot come from the engine

- **Hermes subagent identity is unreachable here.** Hermes emits stable subagent identity on
  `subagent_start` / `subagent_stop` (`delegate_tool.py:981`, `:1250-1262`), but TorqClaw
  **disables delegation outright**: `hermes_runner.py:610` reads
  `os.environ.get("HERMES_DISABLED_TOOLSETS", "delegation")` — **the default value is the
  string `"delegation"`**, so delegation is off unless the operator explicitly overrides the
  variable to exclude it. Those hooks never fire in this repo.
- The hook TorqClaw actually consumes, `pre_tool_call`, carries the **collapsed**
  `task_id='default'` (`terminal_tool.py:1881-1885`) — it cannot distinguish one agent from
  another.

**Consequence (design constraint, not a preference): agent identity and presence MUST be
minted and held by the GATEWAY.** The engine cannot supply it. This aligns with core
invariant "the gateway remains the sole execution authority" (005 §2).

---

## 2. THE CENTRAL AUTHORITY QUESTION

> **What authorizes an agent to speak in a given channel, and what stops a task from writing
> into channels it was never granted?**

### 2.1 The answer

**An agent is authorized to speak in exactly those channels where its own agent principal
holds an `active` row in `collab_members` — and in no others. The authorization is the
membership row, placed there by the operator, and it is enforced by the substrate predicate
that already exists (`assertChannelVisible`, `store.ts:2032`), unchanged.**

The full chain, each link already built and verified:

1. **Minting.** The operator (and only the operator — `assertOperatorCaller`,
   `store.ts:1966-1976`, requires `kind==='operator' && status==='active'`) creates an agent
   principal and its credential (`store.ts:426`).
2. **Granting.** The operator (and only the channel owner — `assertChannelOwner`,
   `store.ts:1025`) adds that agent principal to a channel (`store.ts:1005`). **This is the
   human act R-1 identifies as "assigning the agent to the project."**
3. **Binding.** A task executing on behalf of that agent runs under a gateway-held
   **agent-scoped collab credential** for that agent principal. The task's collab subject is
   that principal — server-derived, never client-supplied (005 §2(c)).
4. **Enforcement.** Every collab write the task attempts passes through the substrate with
   that principal as `CallerContext.principalId`. `assertChannelVisible` (`store.ts:2032`)
   admits it **only** if a `collab_members` row exists with `state === 'active'`. A channel
   the agent was never added to yields `COLLAB_NOT_FOUND` — byte-identical to a nonexistent
   channel (`store.ts:2036-2044`, both arms call the same `notFound()`), so a probing agent
   cannot even enumerate channels it lacks.

**What stops a task from writing into channels it was never granted:** the same predicate
that stops a human. There is no agent-specific bypass to build, and **none may be built**.
Specifically, the following are **prohibited** by this PRD:

- ❌ A "system" or "gateway" principal that posts on an agent's behalf. This would collapse
  attribution and make every agent's writes indistinguishable.
- ❌ Passing a channelId from task input into a collab write without the membership check.
- ❌ Any `caller.kind === 'agent'` special case in the substrate. The substrate's
  kind-blindness on the post path is a *feature* (§1.2) and must stay.
- ❌ Deriving the agent's principal from anything the *task prompt* or *tool arguments*
  contain. Identity is bound at dispatch from gateway state, never from model output.

### 2.2 The two lattices still apply (005 §2a, inherited verbatim)

005 §2a is binding and unchanged:

- The gateway **seat** lattice (`operator|channel|node`) decides only whether a connection may
  use a command **class**.
- The substrate **subject** of every call is the connection's **resolved collab principal**.
- **NULL principal ⇒ `COLLAB_IDENTITY_REQUIRED`. No operator bypass, no seat-level read
  entitlement, no principal synthesis.**

**Where this PRD extends §2a — and this is the one genuinely new authority surface, flagged
for the Gate-1 reviewer:** 005's subject was always "the human at the console." This PRD
introduces a subject that is **an executing task**, whose connection is opened by the gateway
rather than by a person. The §2a rule is applied unchanged (the task's subject is a real,
server-derived agent principal), but the *provenance of the credential* is new: the gateway
holds it, not a human.

**Open question for the operator (OQ-1, §9): where does the agent's collab credential live at
rest, and what is its lifetime?** This PRD does not decide it. Note the 005 §7.5 dependency:
the Windows Credential Manager `SecretStore` adapter is **still the §19-owed stub**, so in
production the collab surface fails closed to `COLLAB_IDENTITY_REQUIRED` until a real adapter
lands. **This PRD inherits that blocker in full and does not absorb it.**

---

## 3. Substrate feasibility ledger — what exists, what is unwired, what is absent

Each row verified this session. **"Exists" means the code exists AND I traced its enclosing
conditions; "unwired" means the code exists but has no production caller.**

| # | Capability | Status | Evidence (file:line) |
|---|---|---|---|
| 1 | Agent principal creation | **EXISTS** | `store.ts:426`, insert at `:459-461` |
| 2 | Agent credential minting (`tq1_`) | **EXISTS** | `store.ts:463`, `:486`; `credentials.ts:45`,`:84` |
| 3 | Agent added to channel (`role='agent'`) | **EXISTS** | `store.ts:1005`, kind-check `:1040`, insert `:1085` |
| 4 | Post predicate ignores caller kind | **EXISTS** | `store.ts:1447` → `:2032-2046` |
| 5 | Kind-agnostic credential verification | **EXISTS** | `collabIdentity.ts:241`, `:299`, `:258` |
| 6 | Message text bound (16,384 UTF-8 bytes) | **EXISTS** | `store.ts:1428` → `text.ts` `normalizeMessageText` |
| 7 | Idempotent posting by key | **EXISTS** | `store.ts:1438` `runKeyedCommand`; replay leaves `committedSeq` undefined (`:1494-1496`) |
| 8 | Dense monotonic `channel_seq` | **EXISTS** | `store.ts:1458` `getMaxChannelSeq()+1` |
| 9 | **Live push: `SubscriptionRegistry`** | **BUILT, UNWIRED** | `subscriptions.ts:391-394`; **zero production `register()` callers** — the only call is `store.ts:1608` inside `subscribeChannel` |
| 10 | **`subscribeChannel` (the sink registrar)** | **BUILT, ZERO PRODUCTION CALLERS** | `store.ts:1579`. Repo-wide grep: referenced only by `collab/src/index.ts` (export barrel) and three test files (`fanout-revocation`, `rollback`, `slowconsumer-store`). **No gateway, console, ops, or channel-http caller.** |
| 11 | `fanoutToChannel` invoked on post | **EXISTS but fans to an EMPTY SET** | `store.ts:1497`, guarded by `committedSeq !== undefined` (`:1496`). The registry it reads is `this.registry` (`store.ts:381`), constructed as `new SubscriptionRegistry()` when `env.registry` is absent (`store.ts:300`,`:360`). **With no `subscribeChannel` caller, `byChannel` is always empty in production — fanout runs and delivers to nobody.** |
| 12 | **Departure signal on socket close** | **ABSENT** | `server.ts:676`: `socket.on('close', () => unsubscribe?.());` — **that is the entire handler.** No presence broadcast, no collab unsubscribe, no channel notification. |
| 13 | Task truth for presence | **EXISTS** | `schema.sql:41` `session_id NOT NULL REFERENCES sessions(id)`; `:44` `state NOT NULL DEFAULT 'running'`; `sessions.principal_id` at `schema.sql:14` (nullable, no FK, **no index**) |
| 14 | Task state is transactional (no TTL needed) | **EXISTS** | insert `events.ts:152` (does not name `state` ⇒ takes the DEFAULT); `state='completed'` `events.ts:160`; `state='failed'` `events.ts:174`; `storage.ts:316-318` |
| 14a | **`tasks.state` value set is WIDER than the schema comment** | **VERIFIED — comment is stale** | There is **no CHECK constraint**. The `:44` comment says `running \| completed \| failed`, but `storage.ts:316-317` also writes **`cancelled`** and **`cancelled_uncertain`**, and **`cancel_requested`** is *read* as valid (`storage.ts:318`, `:445`) though **no writer was found**. **A presence query filtering `state='running'` is correct, but any query enumerating "terminal" states by listing them will be wrong.** Filter on `state='running'`, never on `NOT IN (...)`. |
| 14b | Terminal updates are **unguarded** in two of three writers | **VERIFIED** | `events.ts:160` and `:174` have **no state guard** and will overwrite a terminal state; only `storage.ts:318` is guarded (`WHERE ... state IN ('running','cancel_requested')`). Noted so presence is not assumed monotonic. |
| 14c | **No `tasks ⋈ sessions` join exists yet** | **VERIFIED ABSENT** | Closest is `server.ts:73` (single-table `SELECT session_id FROM tasks`). S4 writes the **first** such join; both columns exist, but **`sessions.principal_id` has no index** — note for query cost. |
| 15 | Agent read path (timeline) for a task | **ABSENT** | no collab-backed MCP tool; no non-socket read API |
| 16 | Agent write path for a task | **ABSENT** | §1.1 |
| 17 | Server-side mention parsing | **ABSENT** | 005 §13 row 10 (inherited, not re-verified this session) |
| 18 | Hermes subagent identity usable here | **ABSENT** | delegation disabled by default, `hermes_runner.py:610` |

### 3.3 Bridge posture (informing S2's design)

The MCP bridge (`packages/bridge`) is where an agent-facing tool would live: it owns the
namespaced registry, task-type filtering (`toolFilter.ts`), and the approval policy
(`approvalPatterns`). **`connectBridge()` is called at `server.ts:678`, before the listener
opens traffic.** The design in §4 S2 adds a collab-backed tool to this registry; §5 decides
its approval class.

**⚠️ VERIFIED BLOCKER — the bridge admits NO in-process tool provider.** This was the
open question in an earlier draft; it is now answered, and the answer is **no**:

- The **only** function that populates the registry is `connectServer` (`registry.ts:123`,
  the sole `registry.push` at `:157`). It requires a successful **`await client.connect(transport)`**
  (`registry.ts:138`); on throw it closes the transport and rethrows (`:141-142`), registering
  nothing.
- `transport` is a **two-member** union — `stdio` | `streamable-http` (`registry.ts:29-32`;
  zod `discriminatedUnion` at `serverConfig.ts:12-23`). There is **no** `in-process`,
  `local`, `function`, or `InMemoryTransport` variant.
- Tools come **exclusively** from the remote server's `await client.listTools()`
  (`registry.ts:146`).
- `RegisteredTool` (`registry.ts:9-26`) **has no `handler` field**. Dispatch is
  `sourceServerId` → MCP `callTool` (`registry.ts:222-225`).

**Consequence for S2 (must be scoped, not assumed away): a collab-backed tool cannot simply
be "registered."** One of these must be chosen by the operator/G1R (**OQ-6**):
(a) add an in-process transport/handler path to the bridge — a change to a security-critical
package; (b) run a small local MCP server exposing the collab tools, which then needs its own
credential-holding path back to the gateway's store; or (c) bypass the bridge and inject the
tools directly into the LOCAL_EDGE loop — which **forfeits `toolFilter`, capability
classification, `approvalPatterns`, and path scoping**, and is therefore **not recommended**.
**None of these is small. S2 is materially larger than a "just add a tool" slice.**

### 3.4 Bridge facts that constrain S2 and §5 (verified)

| Fact | Evidence | Consequence |
|---|---|---|
| Capability classification **fails closed to `'write'`** | `capability.ts:172` (P6 default) | A collab tool with no explicit `capabilities` entry is classified write-class ⇒ `requiresApproval: true`. **§5's exemption must therefore be an EXPLICIT config decision, not an omission.** |
| `requiresApproval` = `isWriteClass(cap) \|\| approvalPatterns.some(...)` | `registry.ts:164` | Two independent triggers. `DEFAULT_WRITE_PATTERNS` (`registry.ts:49`) is 7 **unanchored** `/i` regexes incl. `/create/i`, `/send/i`, `/update/i`. |
| **`collab__post_message` would match `/send/i`? No — but the name must be chosen deliberately** | same | The literal name `post_message` matches none of the 7 patterns; a name like `send_message` **would** match `/send/i` and be auto-gated. **Naming is load-bearing — record it as such, and set `capabilities` explicitly rather than relying on the name.** |
| The approval closure is **LOCAL_EDGE-only** | `toolFilter.ts:77-78`: `tier === 'LOCAL_EDGE' && approvalSet.has(realName)` | On FRONTIER this returns `false` for every tool. |
| **FRONTIER does not use the bridge registry at all** | `getToolsForTask` has one call site, `ollama.ts:189`, hardcoded `'LOCAL_EDGE'`; `executeTool` has one production call site, `ollama.ts:384` | FRONTIER approval comes from the engine's own `pre_tool_call` hook, relayed at `hermes.ts:177-182`; `dispatch.ts:362-365` passes `undefined` for the registry entry and `buildGateFacts` returns `rule: 'engine-approval-hook'`. **§5 A5-a must assert BOTH tiers through their DIFFERENT mechanisms — they are not one path.** |
| A namespace absent from `TOOL_ROUTING_MAP` is **silently invisible** to the model | `toolFilter.ts:58-63`, no else-branch | A new `collab__` namespace is invisible until added to the map. **S2 must add it explicitly, and A2-d must assert the rendered list.** |
| `predictTools` output **drives tier selection** | `router/src/engine.ts:142`: `requiredTools.length > 3` forces FRONTIER (`TOOL_COUNT_OVERFLOW`); `:176` scores `length * 10` | **Adding two collab tools to a task type can push it over the threshold and re-route it to FRONTIER.** A routing side effect of a tool-exposure change — S2 must measure it. |
| The bridge itself has **no enable flag** | `server.ts:679` `await connectBridge()`, unconditional | Bridge is always on; only its *contents* vary. |

---

## 4. Slices

Each slice is independently shippable, flag-gated, and reversible. Build order is strict:
**S1 → S2 → S3**; S4/S5/S6 may proceed in parallel after S1.

**A6/T-9 apply IN FULL to every new wire command and every new MCP tool in every slice
below** — see §7 for the restated obligation. No slice may declare them inherited.

---

### S1 — Agent identity that can post
**Flag:** `TORQCLAW_AGENT_PARTICIPATION` (new, default **OFF**; additionally requires
`collabSurfaceCommandsEnabled()`, so it can never re-enable a surface the 005 flags turned
off).

The gateway can bind an executing task to an **agent collab principal** and hold that
principal's credential for the life of the task. A post made by that task is attributed to
**the agent**, not to the operator.

**Design constraints (binding):**
- The agent principal and credential are minted through the **existing** operator-only paths
  (`store.ts:426` / `:486`). **No new minting API.**
- The binding is established **at dispatch, from gateway state**. Never from task input,
  prompt content, tool arguments, or model output.
- §2a applies unchanged: unresolved principal ⇒ `COLLAB_IDENTITY_REQUIRED`; **no operator
  bypass; no principal synthesis.** A task with no bound agent principal cannot post — it
  is refused, never silently attributed to the operator.
- `CallerContext.kind` must be the agent's **real** kind, read from the DB
  (`getPrincipalKind`, `collabIdentity.ts:223`), never a hardcoded literal — the CO-1
  discipline (`collabSurface.ts:143-158`).
  **⚠️ Known unpinned invariant (inherited, and this slice makes it matter more):** the
  three-way least-privilege fallback to `'agent'`
  (`collabSurface.ts:175`, `:177`, `:178-180`) is real in source but **pinned by no test** —
  `docs/prd-reviews/VERIFY-OPUS-COLLAB-PRESENCE-UI-005-S3.md:36-47` records that flipping the
  fallback to `'operator'` left the entire 38-test suite **green**. That is the repo's
  **unenforced-claim pattern**. Today it is inert (`assertChannelVisible` ignores
  `caller.kind`), **but S1 introduces real agent-kind principals, so a wrong `kind` stops
  being hypothetical.** **S1 must add the missing test** — a falsifiable probe that flipping
  the fallback to `'operator'` turns RED (§7.4 rule 1).

**Acceptance criteria:**
- **A1-a.** A task bound to agent principal `P` posts to a channel where `P` is an active
  member; the committed `collab_events` row has `actor_principal_id = P` — asserted by
  **reading the DB row**, not the return value. (`store.ts:1463-1473` writes
  `caller.principalId` into that column.)
- **A1-b.** The same task attempting to post to a channel where `P` has **no** membership row
  receives `COLLAB_NOT_FOUND`, and the payload is **byte-identical** to the nonexistent-channel
  case (005 T-2 discipline; both arms are the same `notFound()` at `store.ts:2037`/`:2043`).
- **A1-c.** A task with **no** bound agent principal is refused `COLLAB_IDENTITY_REQUIRED` and
  **zero** `collab_events` rows are written (DB-provable).
- **A1-d.** With `TORQCLAW_AGENT_PARTICIPATION` unset, every path added by this slice is inert
  — proven by asserting the *absent-deny* response, not by asserting the flag's value
  (§7, no-config-assertion rule).
- **A1-e.** An operator-kind principal cannot be bound as a task's agent identity (the binding
  path accepts `kind==='agent'` only). Prevents a task from acquiring operator authority by
  binding.

**Risk:** *High.* This slice creates a credential-holding, autonomously-connecting subject —
the largest new authority surface in the program. Its blast radius is bounded by the fact
that it grants **no** new substrate capability (§1.2), but a defect here is an identity
defect, not a UI defect. **Gate: G1R required. This slice is High-risk tier per CLAUDE.md §2
(secrets, approval-adjacent, identity).**

---

### S2 — Agent read + write path (MCP tools)
**Flag:** inherits S1's.

Two bridge-registered tools, task-type filtered via `toolFilter.ts`:

- **`collab__read_channel`** — reads a channel timeline for the bound agent principal, paged
  by the substrate's `channel_seq` cursor rules. Backed by `store.getChannelTimeline`.
- **`collab__post_message`** — posts one message as the bound agent principal. Backed by
  `store.postChannelMessage(caller, {channelId, text}, idempotencyKey)`.

**Design constraints (binding):**
- Both tools execute with the **bound agent principal** as `CallerContext` (S1). The tool's
  `channelId` argument is **not** an authorization input — it is a *selector* that the
  substrate predicate then accepts or refuses. An agent naming a channel it is not a member
  of gets `COLLAB_NOT_FOUND` (§2.1 step 4).
- `text` is bounded by the substrate at **16,384 UTF-8 bytes** (005 §6 A6 scope boundary,
  which explicitly notes A6 does *not* catch size and the bound must be named in the slice's
  own criteria — **it is named here**). The tool schema must carry this bound, and the
  **residue** (JSON-encoded-byte overflow, post-NFC byte underflow, disallowed control
  characters — the cases `normalizeMessageText` rejects by throwing at `store.ts:1428-1431`
  that a char-length grammar cannot express) must be enumerated per T-9 part 2.
- `idempotencyKey` is **server-minted per tool call**, not model-supplied. A model that could
  choose the key could either force a duplicate (fresh key on a retry) or collide two distinct
  messages into one (reused key). This differs deliberately from 005 S3, where a *human client*
  supplies it to survive a dropped socket.
- **Exposure is task-type filtered.** A task type with no channel business does not see these
  tools. Deny rules win (`CLAUDE.md` §4).

**Acceptance criteria:**
- **A2-a.** `collab__post_message` invoked with a `channelId` the bound principal is not a
  member of returns a structured tool error and writes **zero** rows (DB-provable).
- **A2-b.** `collab__read_channel` returns only channels/events the bound principal is
  entitled to; a non-member read is `COLLAB_NOT_FOUND`, byte-identical to absent.
- **A2-c.** Two invocations of `collab__post_message` with identical text in one turn commit
  **two** events (distinct server-minted keys) — proving the key is not text-derived; a
  transport-level retry of a **single** invocation commits **one**.
- **A2-d.** The tools are absent from the tool list offered to a task type not granted them —
  asserted against the **rendered tool list the model actually receives**, not against the
  filter's config table (§7).
- **A2-e.** Full T-9 matrix for each tool (§7).

**Risk:** *High, and larger than it first appears.* Three compounding factors, all now
verified rather than suspected: (1) the approval-class decision (§5) is a core-invariant-5
adjacency; (2) **there is no in-process tool registration path**, so this slice requires a
structural choice about the bridge itself (§3.3, **OQ-6**) — it is not "add a tool"; (3)
exposing two new tools can push a task type past `requiredTools.length > 3` and **silently
re-route it to FRONTIER** (`router/src/engine.ts:142`), changing which approval mechanism
governs it. **Gate: G1R required. Do not estimate this slice before OQ-6 is ruled.**

---

### S3 — The auto-reply loop
**Flag:** `TORQCLAW_AGENT_AUTOREPLY` (new, **separate** from S1/S2's flag, default **OFF**).
A separate flag so agent *speech* (S1/S2, human-triggered) can ship and soak without agent
*autonomy* (S3). Turning S3 off must never disable S1/S2.

This is capability 3 — and, via the human's own messages, capabilities 1 and 2.

**Trigger (R-1, R-5).** An agent takes a turn when: a **new `message_posted` event** is
committed to a channel in which that agent principal holds an **`active` membership row**,
**authored by a principal other than itself**. That is the entire trigger. No project entity,
no task linkage, no mention parsing, no reaction. **The human's act of adding both agents to
one channel is the standing authorization** — which is exactly why this is a different trigger
from mention-dispatch (R-5), and why R-4's mention prohibition does not reach it.

This single trigger yields all three capabilities:
- Human posts → member agents answer. **(Capability 1.)**
- Human posts "agent A, discuss X with agent B" → both are members, both see it, both may
  answer, and each subsequent post re-triggers the other. **(Capability 2 — no new
  mechanism.)**
- Agent A posts → agent B (a member, and not the author) takes a turn → its post re-triggers
  A. **(Capability 3.)** Note the human is absent from the loop *per turn*, but present in
  the loop's *authorization*: the human created the membership.

**Termination.** Unbounded by ruling (R-2). The loop terminates:
- **naturally** — an agent whose turn produces no post ends its branch. There is **no**
  obligation to reply; a turn may conclude with silence, and this must be a first-class,
  documented outcome rather than an error.
- **by the STOP control** (R-3a) — see below.
- **by membership** — removing an agent from the channel ends its participation
  (`removeChannelMember`, the `collab_members` state transition at `store.ts:1205`).
- **by flag** — `TORQCLAW_AGENT_AUTOREPLY=0` halts all auto-turns.

**The STOP control (R-3a — required, and NOT a cost control).** A visible, operator-reachable
control that halts auto-reply. Rationale to preserve verbatim in code comments: *subscriptions
cap cost, not usefulness — two agents can loop unproductively for free, and the human needs a
way to end it.* Requirements:
- Reachable from the channel view; effect is **immediate** (halts before the next turn is
  dispatched, not after the in-flight one completes its tool calls).
- **Scoped to the channel**, and additionally available as a global halt.
- STOP is a **gateway-side** control. An agent must not be able to clear it — it is not
  exposed as a tool, and no message content can lift it. (Otherwise the loop could un-stop
  itself, and §2 "a message is data, not a command" would be violated.)
- STOP state must survive a gateway restart, or its non-persistence must be stated honestly
  in the UI. **This is an open design point, not a settled one.**

**Anti-storm requirements (NOT cost caps — these are correctness requirements).** Each must be
mechanically enforced, not documented as guidance:

1. **No self-reply.** An agent must not be triggered by its own message. **Mechanism:** the
   trigger compares the committed event's `actor_principal_id` (`store.ts:1463-1473`, written
   from `caller.principalId`) against the candidate agent's principal id; equal ⇒ no turn.
   This is a **server-side** comparison on committed DB truth, never a model-side convention.
2. **No double-reply to the same message (idempotency).** An agent must take **at most one**
   turn per `(channelId, channel_seq, agentPrincipalId)` triple. **Mechanism:** `channel_seq`
   is dense and monotonic per channel (`store.ts:1458`), so the triple is a natural
   idempotency key. The trigger must record the highest `channel_seq` each agent has been
   dispatched for and refuse to dispatch at or below it. **This must be durable**, or a
   gateway restart mid-loop re-triggers the whole backlog. *A restart must not replay turns.*
3. **No interleaving garbage under concurrency.** Two agents replying simultaneously must
   produce two well-formed messages in a deterministic order, never a corrupted or
   partially-ordered timeline. **Mechanism:** the substrate already serializes commits — every
   post runs through `withReadThenSequencer` + `mutex.withLock` (`store.ts:1436-1437`) and
   takes `getMaxChannelSeq+1` **inside** the lock (`store.ts:1458`), so `channel_seq` is
   totally ordered with no gaps regardless of concurrency. **The remaining requirement is at
   the dispatch layer:** an agent must not have two turns in flight for one channel
   simultaneously. **Mechanism: one in-flight turn per (agent, channel);** a trigger arriving
   during an in-flight turn marks the channel dirty for **exactly one** follow-up evaluation
   after it completes — the coalescing discipline 005 S4 already established for hint-driven
   re-reads.
4. **A turn that fails must not silently retry forever.** A dispatch failure ends that branch
   and surfaces honestly. (This is a correctness/honesty requirement, not a spend cap.)

**Explicitly NOT specified (R-2):** any turn budget, turn counter, depth limit, or rate limit
justified by cost. **A reviewer proposing one on cost grounds is re-litigating a settled
ruling.** An optional per-token-model cap is deferred (§6).

**Acceptance criteria:**
- **A3-a (no self-reply).** An agent posting to a channel where it is the *only* agent member
  produces **exactly one** committed event and **zero** subsequent auto-turns. Falsifiable:
  removing the self-check must turn this test RED (§7).
- **A3-b (idempotency).** Delivering the same committed event to the trigger twice dispatches
  **one** turn. Additionally: a **simulated gateway restart** with a loop mid-flight does not
  re-dispatch any `channel_seq` already dispatched (durability of requirement 2).
- **A3-c (two-agent conversation actually happens).** Two agent principals, both active
  members of one channel; the human posts once; **without further human input**, both agents
  post, and each agent's post is triggered by the other's. Asserted on **committed
  `collab_events` rows** with their `actor_principal_id` values and `channel_seq` ordering —
  **not** on a mocked dispatcher. *This is the criterion that proves the product exists.*
- **A3-d (concurrency).** N concurrent triggers on one channel yield a dense, gap-free,
  strictly increasing `channel_seq` sequence with no duplicate `(agent, seq)` dispatch.
- **A3-e (STOP).** With a loop running, STOP halts it before the next turn dispatches; a
  message posted after STOP does **not** trigger a turn; and **no agent-reachable path clears
  STOP** — asserted by attempting it through the tool surface and observing refusal.
- **A3-f (silence is valid).** A turn producing no post ends the branch cleanly, with no error
  event and no retry.
- **A3-g (approval unchanged).** A write-capable tool invoked during an auto-turn still
  requires approval — see §5, A5-a. **Auto-conversation is not an approval bypass.**

**Risk:** *High — the highest in this PRD.* This slice grants autonomous, unbounded action
initiation. Its correctness rests entirely on the four anti-storm mechanisms; a defect in
requirement 2 (durable idempotency) reproduces as an infinite loop across a restart. **Gate:
G1R required; G2A audit before acceptance.**

---

### S4 — Presence (005 S5b)
**Flag:** inherits the 005 UI flag.

Pull-only presence, computed at read time from **transactional task truth** — no TTL, no
heartbeat, no background timer.

**Mechanism:** the join `tasks ⋈ sessions ON tasks.session_id = sessions.id WHERE
tasks.state='running'`, intersected with the **caller's own channel membership**. Verified
available: `sessions.principal_id` (`schema.sql:14`), `tasks.session_id` + `tasks.state`
(`schema.sql:41`,`:44`, values `running|completed|failed`). State is transactional — set on
insert (`events.ts:152`), cleared on terminal (`events.ts:160`, `:174`, `storage.ts:318`
guarded by `state IN ('running','cancel_requested')`). **Because the state is transactional,
a crashed gateway cannot leave a stale "working" row the way a TTL-based heartbeat can** —
this is the design reason for choosing pull over heartbeat, and it should be preserved as a
comment.

**Buzz comparison (informing, not authorizing):** Buzz uses a 60s heartbeat → Redis key with
a 180s TTL, carrying a signed ephemeral Nostr event whose value is a bare status string.
**We copy Buzz's TYPING scoping (membership-gated) and explicitly reject its PRESENCE scoping
(global fan-out).** Buzz's own execution telemetry (`KIND_AGENT_TURN_METRIC`) is
viewer-private/owner-only, and its presence is **advisory, never consulted for dispatch** —
issue #1743 records mention-dispatch failing **silently** when the target is offline.
**Inherited rule: presence here is likewise advisory and MUST NOT be an input to the S3
trigger.** S3 triggers on membership and committed events only. An "offline" agent is not
skipped; it is simply not currently running.

**Disclosure (binding).** To **co-members only**, and only:
`{principalId, displayName, working, since}`.
**Never** `taskId`, prompt, tier, tool name, cost, spend, provider, or model.

**Membership intersection is not optional:** presence must be filtered by the *caller's* own
membership, so a caller learns only about principals they already share a channel with.
Otherwise presence becomes a global principal directory — the exact leak 005 §13 S7 forbids.

**⚠️ Operator ruling required (OQ-2, §9).** "Working now" is a **side-channel**: it discloses
that a principal is executing *something*, which is information beyond channel-message
entitlement. Per §2a's entitlement discipline, this must be an **explicit operator
entitlement**, not an assumed one. **This PRD does not grant it.** Until ruled, S4 ships
membership ("Members") only, without the working overlay.

**Acceptance criteria:**
- **A4-a.** A running task belonging to a non-co-member principal is **absent** from the
  caller's presence response (DB-provable, with a seeded non-member running task present in
  the DB — the test must prove exclusion, not merely absence of data).
- **A4-b.** The response contains **none** of `taskId`, prompt, tier, tool, cost — asserted by
  **key-set equality** against the exact allowed set, so a future added field fails the test
  rather than passing silently.
- **A4-c.** A full task lifecycle (submit → run → terminal) produces **zero** writes to
  `collab_events` (005 A5, inherited and DB-provable).
- **A4-d.** No heartbeat, timer, or TTL is introduced; presence is computed at read time.

**Risk:** *Medium.* Read-only and derived from existing truth, but it is a **disclosure**
surface, and the entitlement question is unresolved (OQ-2). Blocked on operator ruling.

---

### S5 — Live push and the missing departure signal
**Flag:** inherits S1's.

**Wire what is already built.** Per §3 rows 9–11, `SubscriptionRegistry`, `subscribeChannel`,
and `fanoutToChannel` are complete and **fan out to an empty set in production** because
nothing ever calls `subscribeChannel` to register a `DeliverySink`. This slice supplies the
sink from the gateway websocket and registers/unregisters it across the connection lifecycle.

**Close the departure gap.** `server.ts:676` is, in full:
`socket.on('close', () => unsubscribe?.());`
It emits **nothing** — no collab unsubscribe, no presence departure, no channel notification.
A subscription registered by this slice **must** be deregistered here, or the registry leaks
subscriptions and `fanoutToChannel` writes to dead sockets. **This is the slice's
highest-value defect-prevention item.**

**Honest statement of what remains owed (§19).** 005 §4 S4 recorded that the gateway's
`publishOnly` frames are **seq-less and non-persisted**, and that the substrate's delivery
sink models write-*initiated* with **real backpressure explicitly owed to §19**. **That debt
is NOT discharged by this slice and this PRD does not claim it.** Consequently:
- Live frames remain **invalidation hints**, not delivery guarantees.
- Correctness rests on the **durable store + monotonic cursor** re-read path (005 S4), not on
  the socket.
- **Because of this, S3's auto-reply trigger MUST NOT depend on socket delivery.** It triggers
  on **committed substrate events**, so a dropped frame delays a turn but never loses it.
  *This is a load-bearing design consequence of an undischarged debt, not a stylistic choice.*

**Acceptance criteria:**
- **A5-a.** A committed message is delivered to a subscribed co-member's socket without a
  manual refresh.
- **A5-b.** After socket close, the registry holds **zero** subscriptions for that connection
  — asserted by **inspecting registry state**, not by absence of an error. Falsifiable:
  removing the deregistration must turn this RED.
- **A5-c.** Fan-out to a closed socket does not throw into, or terminate, the gateway process
  (the A6 totality concern applied to the delivery path).
- **A5-d.** A dropped/severed frame does **not** lose a turn: sever the socket, commit an
  event, restore — the trigger still fires from committed truth.

**Risk:** *Medium-high.* The code is written and tested in isolation, so the risk is
concentrated in lifecycle wiring — precisely where the departure gap already exists. A leak
here is a slow resource failure, not an immediate one.

---

### S6 — Label honesty
**Flag:** inherits the 005 UI flag.

G1R ruled that 005 S5's labels **"Working now"** and **"Nothing running right now"** overclaim
what one session can know. **The fix is folded in here and is binding on every surface this
PRD adds.**

- A single gateway session observes **its own** task truth. It cannot honestly assert a global
  negative. **"Nothing running right now" is prohibited.**
- Honest replacements must scope the claim to what was actually observed (e.g. *"No running
  tasks visible to this session"*), and must distinguish **null (loading)** from **[] (real
  empty)** from **failed/timed-out** — the ApprovalHistoryPanel pattern (005 §13 S2).
- **Presence never implies membership; membership never implies presence** (005 S5, inherited
  verbatim). A working non-member is not shown as a member; an idle member is not hidden.
- Display names are **not unique**, so a name alone is not an identifier — pair it with a
  truncated principal id (the `LivenessChip` `turn {id.slice(0,8)}` convention, 005 S5).
- **Agent messages must be visually attributable to the agent principal that authored them**,
  and must not be renderable as operator speech. Attribution comes from the committed row's
  `actor_principal_id`, never from message text.

**Acceptance criteria:**
- **A6-a.** No surface renders a global negative. Enforced by a **string-level assertion over
  the built UI source** for the prohibited phrasings, so a reintroduction fails the suite.
- **A6-b.** Loading / real-empty / failed render as three **distinct** states.
- **A6-c.** An agent-authored message renders with agent attribution, and an operator-authored
  one with operator attribution, in the same timeline.

**Risk:** *Low.* Presentation-layer, no authority change. But it is an **honesty** criterion
(checklist-10), and honesty defects have shipped in this program before.

---

## 5. Is posting a write-capable tool requiring approval?

**Decision: `collab__post_message` is SPEECH and is NOT individually approval-gated.
`collab__read_channel` is a read and is not gated. Every other tool an agent invokes —
during an auto-turn or otherwise — remains individually approval-gated on BOTH tiers,
unchanged.**

This implements R-3b: **talking is unbounded; ACTING is not.**

### 5.1 The boundary, stated precisely

The line is **not** "does it write bytes to a database" — by that test posting is a write and
so is every log line. The line is **does the action change state outside the conversation, or
cause an effect the human did not authorize by creating the channel?**

`collab__post_message` is exempt because **all four** of the following hold. If a future tool
fails **any one** of them, it is not speech and is not exempt:

1. **Its only effect is an append to a conversation the human explicitly created and to which
   the human explicitly added this agent.** The membership row *is* the human's prior
   authorization (§2.1). Approving each message would be re-approving a grant already given.
2. **Its target set is bounded by that same membership** and cannot be widened by the tool
   call. A `channelId` argument is a selector, not an authorization (§2.1 step 4).
3. **It is append-only and non-destructive.** `postChannelMessage` inserts one immutable
   `collab_events` row (`store.ts:1461-1474`). No update, no delete, no external side effect.
4. **It reaches no system outside the substrate.** No network egress, no filesystem, no
   external API — the properties `approvalPatterns` exists to catch
   (write/delete/push/create/update/send/exec).

### 5.2 Why this does not weaken core invariant 5

**A message is data, not a command** (005 §2(d)): nothing in a channel timeline is parsed into
gateway actions. Therefore:

- **A post cannot itself cause an effect.** It can only cause *another agent to think*.
- **When that other agent acts, the action is gated at THAT tool** — the approval boundary sits
  where the effect occurs, and every effect still crosses it.
- **A post can never approve anything.** `approve` remains reserved operator-surface authority
  (frozen ruling, collab-gateway-004; 005 §2(b)). No channel message, agent post, or collab
  event may approve, trigger, or widen a gated action.

**The composition risk, named explicitly:** agent A says "run the deploy," and agent B does.
**B's deploy tool still requires approval.** The human is asked exactly once, at the moment of
effect. What auto-conversation changes is *who suggested it* — not whether it is gated. **That
is the whole boundary, and it is the reason speech can be unbounded while action is not.**

### 5.3 Where this decision could be wrong (stated for the reviewer)

The honest counter-argument: a channel is **durable, operator-visible state**, so flooding it
degrades a surface the human relies on. This is real — and it is **not** an approval problem;
per-message approval would destroy the product (capability 3 becomes impossible) while barely
mitigating the flood. It is addressed instead by **S3's anti-storm mechanisms and the STOP
control** (R-3a), which is exactly why those survive while a cost cap does not.

**Acceptance criteria:**
- **A5-a (the load-bearing one).** During an auto-reply turn, an agent invoking a
  write-capable tool triggers the **normal** approval path on **both** tiers, and the tool does
  **not** execute before approval. **Asserted by observing the tool's real side effect absent,
  not by observing an approval event emitted.**
  **⚠️ The two tiers are structurally DIFFERENT mechanisms and must be asserted separately —
  one test cannot cover both:**
  - **LOCAL_EDGE:** `ToolApprovalRequired` thrown at `ollama.ts:356-359`, guarded by
    `requiresApproval(realName) && !granted`. Registry-driven.
  - **FRONTIER:** the engine's own `pre_tool_call` hook, relayed at `hermes.ts:177-182` only
    when `status.state === 'completed' && status.telemetry?.blockedOn`. **The bridge registry
    plays no part** — `getToolsForTask` is never called with `'FRONTIER'` (its one call site,
    `ollama.ts:189`, hardcodes `'LOCAL_EDGE'`), and `dispatch.ts:362-365` passes `undefined`
    for the registry entry. A test that exercises only the registry path proves **nothing**
    about FRONTIER.
- **A5-a2 (grant-scope honesty — pre-existing, inherited, NOT introduced here).** Verified:
  `grantedTools` is a **name allowlist** checked by `.includes()` (`ollama.ts:356`), so within
  one re-minted request a granted tool may be called **repeatedly with different arguments**,
  while the `PENDING_APPROVAL` frame advertises `grantScope: 'one-shot'` (`dispatch.ts:389`).
  The genuine exact-action consumption is `admitTool`, whose **default is a no-op**
  (`ollama.ts:33`, `() => ({ ok: true })`) and which short-circuits to `{ok:true}` when
  `collabEnabled()` is false (`server.ts:145`) — **the default**.
  **This PRD neither introduces nor fixes this.** It is recorded because **auto-reply
  materially raises its impact**: an unattended loop can re-invoke a once-approved tool with
  new arguments many times where a human-paced session would invoke it once. **S3 must not
  ship without the operator seeing this** — see **OQ-7**.
- **A5-b.** A denied approval during an auto-turn ends cleanly: no `RESULT`, no memory
  poisoning, and the auto-loop does not retry the denied tool. (Preserves the "blocked
  attempts must not write RESULT or poison memory" invariant.)
- **A5-c.** No channel message content can populate `grantedTools`, clear STOP, or influence
  any approval decision — asserted by attempting each through message text and observing no
  effect. (Client input must not be able to inject `grantedTools`.)
- **A5-d.** `collab__post_message` does **not** match the bridge's `approvalPatterns` — and
  this is asserted against the **effective, rendered** policy for the tool, not against the
  pattern list in config (§7).

---

## 6. Non-scope (binding)

- **Any turn budget, depth limit, or rate cap justified by cost.** Ruled out (R-2). An
  optional cap for API-key/per-token models **MAY** be specified later, **OFF by default**;
  **not built here**.
- **Reaction-triggered execution; in-channel approval gates; `@mention` → dispatch.** Declined
  (R-4). Mention is addressing, never dispatch (005 §12a).
- **A project entity or task-linkage table.** Ruled out (R-1) — the channel is the project.
- **Nostr/relay federation**, Slack/Discord adapters, channel policy clamps (005 §3;
  SCOPE-PHASE-3 owns transport "channels" — a different sense of the word, and the docs must
  not blur it).
- **Re-opening substrate semantics** (cursors, fold, name_key, revocation) — v0.14 owns them.
- **The CredMan `SecretStore` adapter**, remote skill distribution, destructive-restore, and
  the §19 socket-backpressure debt — each remains owed to its own effort and is **not**
  silently absorbed (§5 S5 states the backpressure consequence honestly rather than claiming
  the fix).
- **Agent-initiated channel creation or self-add to a channel.** An agent may speak where the
  human put it; it may not extend its own reach. (Prevents membership self-escalation.)
- **Threads, reactions, edits, deletions, attachments, search, DMs, typing indicators,
  numeric unread counts** (005 §13a, inherited).

---

## 7. Discipline this repo enforces (restated — binding on every slice)

### 7.1 Evidence rule
**Cite the line, EVERY enclosing branch condition, AND each variable's default.**
**A `file:line` proves code EXISTS, not that it RUNS.** Two blockers in this program came from
exactly that miss. Applied in this document: §1.1 cites not just `server.ts:650` but the flag
chain above it and the fact that **both** governing flags default OFF; §3 row 11 cites
`fanoutToChannel`'s call site *and* the finding that its registry is empty in production.

### 7.2 A6 — handler totality (005 §6, restated in full; applies to EVERY new wire command
and MCP tool in this PRD, and is **never inherited from a prior slice**)

Each new or changed command is **total on every input its contract admits**:

- **(a)** The contract constrains each free-form field to the **narrowest grammar the consuming
  layer accepts**, and the slice's evidence **cites the consuming validator by `file:line` for
  every free-form field** — the specific function that would reject the value downstream.
  **A field whose consuming validator is not cited is not graded green.** Emitted schemas must
  carry the constraint. *(For `collab__post_message`: `text` → `normalizeMessageText`,
  reached at `store.ts:1428`; `channelId` → `assertChannelVisible`, `store.ts:2032`.)*
- **(b)** **No input the contract still admits may cause the handler — or the `server.ts`
  dispatch arm consuming its return value — to throw.** Every failure resolves to a structured
  error frame. **The unit of totality is the entire path executed inside `socket.on('message')`
  for that command, not the handler function alone.** *Why this is not boilerplate:* there is
  **no** enclosing try/catch around the dispatch switch and **no `unhandledRejection` listener
  in `packages/` or `ops/`**, so one escaping throw terminates the gateway process and kills
  every live session. That is what D-1 was.
- **(c)** Failures report through the existing error-code union **without introducing a new
  distinguishing signal** on any indistinguishability-protected path (§2a / T-2).

**Evidence required: the T-9 matrix, not an assertion of care.**

**Scope boundary (inherited, so silence is not mistaken for coverage):** **resource exhaustion
is OUT of A6's scope.** A grammatically valid but enormous input is a different failure mode
needing an explicit size bound — which is why S2 **names the 16,384-byte text bound in its own
criteria** rather than relying on A6.

### 7.3 T-9 — the four-part totality matrix (required per command/tool; a slice adding none
must declare T-9 not-applicable **explicitly**)

1. **Contract-boundary rejection.** Parse the **compiled/emitted** schema — **not** the Zod
   source — and assert it rejects each malformed form of every free-form field and still
   accepts valid forms including the default. **Parse the built artifact**: mutating only `src`
   and testing it goes falsely green (the repo's verify-the-artifact-not-the-unit-test trap,
   which already let a "fixed" auth hole stay open while 14 unit tests passed). **The test must
   also fail if the `@torqclaw/contracts` alias resolves to source rather than `dist`** —
   `vitest.config.ts` can flip that alias via
   `TORQCLAW_PROFILE_CONFORMANCE_SOURCE_CONTRACTS=1`, silently downgrading this whole part to
   a Zod-source test while staying green.
2. **Residue enumeration.** Name, in the test, **every** input the contract still admits that
   the consuming layer rejects by throwing, and assert each resolves to a structured error.
   **A grammar constraint that mirrors a downstream validator is NOT equivalent to it** —
   range checks, safe-integer checks, referential and stateful checks are not regex-expressible.
   *(Measured precedent: a 21-digit cursor has no leading zero, so it satisfies
   `^(0|[1-9][0-9]*)$` at `store.ts:2067` and passes the contract, then fails
   `Number.isSafeInteger` at `store.ts:2071`. A contract-only fix would have left D-1 open.)*
3. **Throw-class totality.** Drive each handler through its test seam with, at minimum: a
   domain error carrying the expected code; a domain error carrying **some other** code; a
   plain `Error`; and **non-`Error` throws (string, `null`, `undefined`, number)** — the last
   class matters because optional-chained `err?.code` on a thrown string is `undefined` and
   must land in a generic arm rather than escaping.
4. **Falsifiability.** Each probe must be shown to **fail RED** when its guard is removed
   (§7.4).

### 7.4 §8 falsifiability — three hard rules
1. **A probe reported without its RED output is not a discharged probe.** A green test proves
   nothing about the guard unless the guard's removal has been shown to break it.
2. **A mutation that never applied is not a probe.** **Verified on this host: `python3` does
   not exist** (`which python3` → not found; `python3 --version` → command not found). A
   mutation harness shelling out to `python3` **silently no-ops and reports success.** Any
   mutation probe must prove it applied — by asserting the mutated artifact differs, not by
   trusting an exit code.
3. **A falsifiability probe must exercise the SAME handle/path the guarded assertion reads.**
   **Three defects in one day (V-1, RC-1, B-1) were tests that passed identically with and
   without their guard**, because the probe touched a different handle than the assertion.
   A probe on a different DB handle, a different store instance, or a different code path is
   not a probe.

### 7.5 No criterion may be satisfied by asserting a config value or mocking the backend
Every acceptance criterion must be dischargeable **only** by exercising real behavior:
- ❌ asserting a flag's value ⇒ ✅ asserting the **absent-deny response** the flag produces;
- ❌ asserting a filter's config table ⇒ ✅ asserting the **rendered tool list the model
  receives**;
- ❌ asserting an approval event was emitted ⇒ ✅ asserting the tool's **real side effect is
  absent**;
- ❌ mocking the store ⇒ ✅ asserting **committed DB rows**.

### 7.6 UNVERIFIED claims are barred from becoming acceptance criteria
Anything not verified this session is marked **UNVERIFIED** (§8) and **may not** appear as an
acceptance criterion until verified. An overclaimed draft fails Gate 1.

### 7.7 Change scoping and file-collision warning
005 §7.1 recorded that `packages/contracts/src/commands.ts`, `packages/gateway/src/server.ts`,
`authz.ts`, `sessions.ts`, and `collabIdentity.ts` carry **uncommitted operator WIP**, and that
`packages/gateway/src/connectionAuth.ts` is **untracked**. `git status` at `8c8e7c5` still shows
these as modified/untracked. **Every code slice here touches at least one of them.** Repo rule:
**stop and ask before co-editing files with owner edits.** Implementation starts only after the
operator lands the WIP or explicitly authorizes co-editing.

---

## 8. UNVERIFIED — barred from acceptance criteria until confirmed

| # | Claim | Why unverified | Consequence |
|---|---|---|---|
| ~~U-1~~ | ~~In-process tool provider~~ | **RESOLVED — verified NO** (§3.3) | Promoted from unverified to a **scoped blocker**; see **OQ-6** |
| U-2 | No agent-reachable read path into a channel exists anywhere | An **absence** claim; supported by the tool survey but absence proofs are weak | Gate-1 reviewer should independently confirm |
| U-3 | Buzz internals (60s/180s heartbeat, Redis key, Nostr event, `KIND_AGENT_TURN_METRIC` owner-scoping, issue #1743) | Supplied as prior research; **not re-verified against `E:\torq-Buzz` this session** | Used only as **design rationale**, never as an acceptance criterion. Safe as used. |
| U-4 | Hermes `delegate_tool.py:981`/`:1250-1262` and `terminal_tool.py:1881-1885` line numbers | Supplied as prior research; I verified only the TorqClaw-side disabling (`hermes_runner.py:610`, default `"delegation"`) | The **load-bearing** half (delegation is off by default here) **is** verified |
| U-5 | 005 §13 row 10 "server-side mention parsing does not exist" | Inherited from 005; not re-verified | Only supports a non-scope item |
| U-6 | Whether STOP state survives a gateway restart | Design point, undecided | S3 must either persist it or state its non-persistence honestly in the UI |
| ~~U-7~~ | ~~`toolFilter.ts` mapping / `approvalPatterns` defaults~~ | **RESOLVED — verified** (§3.4) | Now cited; A2-d/A5-d are gradeable |

---

## 9. Open questions for the operator (blocking where marked)

- **OQ-1 (BLOCKING S1).** Where does an agent's collab credential live at rest, and what is
  its lifetime — per-task ephemeral, or long-lived per agent principal? **Note the inherited
  blocker:** the Windows Credential Manager `SecretStore` adapter is still the §19-owed stub,
  so in production the collab surface fails closed to `COLLAB_IDENTITY_REQUIRED` until a real
  adapter lands. Dev/loopback credentials work today. **This PRD does not absorb that work.**
- **OQ-2 — RULED 2026-08-23 (GRANTED, operator's own words).** Does the operator grant the **"working now"**
  side-channel as an **explicit entitlement** per §2a? It discloses that a principal is
  executing *something*, which exceeds channel-message entitlement.
  **Operator ruling (verbatim):** *"I grant the S4 'working now' side-channel as an explicit
  §2a entitlement: co-members may learn that a co-member agent is executing a turn, disclosed
  as exactly {principalId, displayName, working, since}. I understand displayName is verbatim
  and this exceeds channel-message entitlement."* Scope: **agent** principals only, derived
  from `collab_agent_turns` (`state='dispatched' AND resolved_at IS NULL`); human-task presence
  is NOT granted and not built. Delivery must re-derive the caller's entitlement per push
  (G1R 2026-08-22 B-2). Record in
  `docs/prd-reviews/G1D-FABLE-PRD-007-S4-AND-GLM-ALIAS-PACKET-2026-08-22.md`.
- **OQ-3 — CLOSED 2026-08-22 (G1D reconciliation).** Must STOP survive a gateway restart? (U-6.)
  **Answered by implementation, not by ruling:** `84bfda3` persists STOP (global and per-channel)
  and demonstrated it over a real booted gateway — persistence across a fresh connection,
  seat-lattice denial, a message whose *content* is a stop command has zero effect, and zero
  `collab_agent_turns` rows after a post to a stopped channel with an eligible second agent
  present. `3cb29ad` (G1R, zero blockers) independently reproduced the S3 probes. The R-3a
  "open design point" text in §4 S3 is therefore superseded: STOP **does** survive restart, and
  no UI non-persistence disclosure is owed. Re-verification on the final tree is A-S7-3 in
  `docs/prd-reviews/G1D-FABLE-PRD-007-S7-AND-T4-PACKET-2026-08-22.md`.
- **F1 / F2 disposition (from `3cb29ad`, recorded 2026-08-22): FILED, NON-BLOCKING.**
  F1 — the coalesced re-dispatch path bypasses `resolveEligibleAgents`' SQL self-reply guard
  (narrow blind spot; every lap is loud). F2 — a deterministic policy failure re-dispatches
  once more under a new PK before stopping (log-flood, not silent). Both sit on the
  approval-is-consent-not-containment surface; neither can produce a silent post. They are
  tracked here rather than fixed in S7 so the slice stays bounded; either may be pulled into
  a later bounded correction without renewed Gate 1.
- **OQ-4.** Final flag naming (`TORQCLAW_AGENT_PARTICIPATION`, `TORQCLAW_AGENT_AUTOREPLY`) —
  an operator decision, per the 005 precedent.
- **OQ-5.** Does an agent take a turn on **every** qualifying message, or may it choose
  silence based on content? §4 S3 A3-f specifies silence as valid; **whether that judgment is
  the model's or a gateway-side rule is undecided.** (Model-side judgment is cheaper; a
  gateway-side rule is more predictable.)
- **OQ-6 (BLOCKING S2 — newly surfaced, was U-1).** The bridge admits **no in-process tool
  provider** (§3.3, verified). Which path: (a) extend the bridge with an in-process transport
  — a change to a security-critical package; (b) a local MCP server fronting the collab store,
  which then needs its own credential path; or (c) direct injection into the LOCAL_EDGE loop,
  **forfeiting `toolFilter`, capability classification, `approvalPatterns`, and path scoping —
  not recommended.** **S2 cannot be estimated until this is ruled.**
- **OQ-7 (SHOULD BLOCK S3).** Given A5-a2 — `grantedTools` is a **name** allowlist, not a
  per-invocation grant, and the exact-action `admitTool` seam is a **no-op by default** — does
  the operator accept that an auto-reply loop may re-invoke a once-approved write tool with
  **new arguments** without re-prompting? **This is a pre-existing property that auto-reply
  amplifies.** Options: accept as-is; require `TORQCLAW_COLLAB_ENABLED` (which activates the
  real admission seam) as a **precondition** for `TORQCLAW_AGENT_AUTOREPLY`; or scope grants
  per-turn. **Recommendation: do not ship S3 without ruling this.**

---

## 10. Tension with existing frozen rulings — named, not papered over

**T-1. Mention-dispatch (declined) vs. membership-triggered auto-reply (specified).**
Both are "an agent starts working because of a message." 005 §12a froze **mention is
addressing, never dispatch**, and R-4 keeps that. R-5 rules that auto-reply between agents
**already assigned** to a channel is a **different trigger**.

*The distinction is real and rests on the authorization source:* a **mention** is authored by
whoever can type in the channel and names an arbitrary principal — authorization would be
**derived from message content**, which §2 forbids ("a message is data, not a command"). A
**membership** row is written by the operator through an operator-only path
(`assertChannelOwner`, `store.ts:1025`) and is **standing, human-authored state**.

**The tension is nonetheless genuine and must not be smoothed over:** both produce an agent
acting because someone posted. The safeguard is that the *set of agents that can be triggered*
is fixed in advance by the human and cannot be widened by anything anyone writes. **If a
future change ever lets message content influence which agents are triggered, this
distinction collapses and R-4 is violated.** That is the invariant a reviewer should watch.
**Recommend Gate 1 explicitly affirm or reject this reading**; the operator has ruled it
(R-5), but it deserves recording as the load-bearing distinction it is, because it is the
single point where this PRD sits closest to a frozen prohibition.

**T-2. "Talking is unbounded" vs. core invariant 5.** No actual conflict — invariant 5 governs
**write-capable tools**, and §5 keeps every one of them gated on both tiers. Recorded because
the phrase "unbounded" invites the misreading that *something* became ungated. **Nothing did.**
What is unbounded is the **number of messages**, never the **set of permitted effects**.

**T-3. Unbounded auto-reply vs. `maxCostUsd` / spend enforcement.** R-2 accepts the operator's
premise (subscription models ⇒ zero marginal cost per turn). **But existing spend behavior must
not be removed or bypassed** (CLAUDE.md §4: "do not silently remove or bypass `maxCostUsd`").
The reconciliation: **this PRD adds no cost cap and removes none.** If a task runs under a
per-token provider, its existing `maxCostUsd` and `HERMES_MAX_ITERATIONS` behavior applies
**unchanged** to each turn. Auto-reply must not be implemented in a way that bypasses the
existing per-task enforcement path. **A reviewer should confirm this is honored — it is the
one place R-2 could be over-read into removing an existing control.**

**T-4. S4 presence vs. Buzz's advisory-presence lesson.** Buzz's issue #1743 (mention-dispatch
fails **silently** when the target is offline) is the failure mode of consulting presence for
dispatch. **S3 must never consult presence**, and §4 S4 states this. Recorded because the two
slices ship close together and the temptation to "skip offline agents" will be real — and would
reproduce #1743 exactly.

---

## 11. Build order

```
S1 (identity)  ──►  S2 (tools)  ──►  S3 (auto-reply loop)
       │                                     ▲
       ├──►  S5 (live push + departure)  ─────┘  (S3 must not depend on delivery)
       ├──►  S4 (presence)          [BLOCKED on OQ-2]
       └──►  S6 (label honesty)     [ships with any UI-visible slice]
```

- **S1 → S2 → S3 is strict.** No tool without identity; no loop without tools.
- **S5 is parallel but must not become a dependency of S3** (§4 S5 — the trigger reads
  committed substrate events, never socket delivery).
- **S4 is blocked** on OQ-2 for its working overlay; its "Members" half may ship earlier.
- **S6 ships alongside the first UI-visible slice** and applies retroactively to 005 S5's labels.

## 12. Gate status

**Pre-Gate-1. Not reviewed. Not authorized for build.** Required before implementation:

1. **G1R design review** — S1, S2, and S3 are each High-risk tier (identity, approval
   adjacency, autonomous action initiation).
2. **Operator rulings on OQ-1, OQ-2, OQ-3.**
3. **OQ-6 ruled** (bridge has no in-process registration path — §3.3) **before S2 is
   estimated.** This is now a known blocker, not an open question.
4. **OQ-7 ruled** (grant-scope amplification under auto-reply — A5-a2) **before S3 ships.**
5. **Operator decision on the WIP file collision** (§7.7) — implementation cannot start while
   the listed files carry uncommitted operator edits.
6. **G2A audit before acceptance** of S1, S2, S3; operator approves any commit/push/release.

**Honest status of this draft.** Every `file:line` in §1–§3 was verified against working-tree
source at `8c8e7c5` this session, including enclosing branch conditions and defaults. §8 lists
what remains unverified. Two items were promoted from "unverified" to **verified blockers**
during drafting (OQ-6, and the A5-a2 grant-scope finding) — both make the work **larger**, not
smaller. **No acceptance criterion in this document rests on an unverified claim.**
