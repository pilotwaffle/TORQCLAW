# G1R RULING — `collab_write` profile admission

**Seat:** G1R (independent design reviewer)
**Model:** claude-opus-5 — the routing profile names Opus 5 for this seat and this review was performed by Opus 5. No substitution.
**Repo:** E:\TorqClaw · branch `phase1-server-owned-authority` · HEAD `71d11dc`
**Scope:** MCP write-permission / profile decision (High-risk tier per CLAUDE.md §2 gate table)
**Authoring context:** none. Fresh thread. G1D's proposal was evaluated adversarially, not ratified.

**VERDICT: APPROVE WITH REQUIRED CHANGES.** A new profile is right. G1D's shape is
*directionally* correct but **under-constrained in two places** and **incomplete in one**
— it does not by itself make the loop work, because admission is only half the gate.

> **SCOPE REVISED after three research inputs (see §9A/§9C/§9D).** `collab_write` is one of
> **four dead classes** in the same enum family (`browser_mutation`, `network_send`,
> capability `send` are also admitted by no profile). The root cause is that
> `toolFilter.ts:54,100` silently `.filter()` out inadmissible tools, so **the enforcement
> point that produces an error is unreachable from the enforcement point that denies.**
> Therefore: **the structural fix (§5A + the reachability conformance test) is the PRIMARY
> deliverable; the `agent_conversation` profile is the SECONDARY, instance-level unblock.**
> I would not approve shipping the profile alone.

---

## 0. Defect verified independently

Confirmed by direct read, not by accepting the brief.

- `packages/contracts/src/profile.ts:41` — `'collab_write'` is a member of `SideEffectClassSchema`.
- `packages/contracts/src/profile.ts:83-124` — `BUILT_IN_PROFILE_DEFINITIONS`, all four:
  - `read_only:84-93` → `allowedSideEffects: ['none']`
  - `workspace_write:94-103` → `['none','filesystem_write']`
  - `browser_research:104-113` → `['none']`
  - `terminal_power:114-123` → `['none','process']`
  - **Zero occurrences of `collab_write`.**
- `packages/bridge/src/profilePolicy.ts:88-90` — inside `if (namespaceOf(tool.name) === 'collab')`,
  returns `COLLAB_READ_ONLY_TOOLS.has(tool.name) ? 'none' : 'collab_write'`. `COLLAB_READ_ONLY_TOOLS`
  (`:47`) contains exactly `'collab__read_channel'`. So `collab__post_message` → `'collab_write'`,
  unconditionally.
- `packages/bridge/src/profilePolicy.ts:106-112` — admission is **conjunctive**: namespace AND
  capability AND `definition.allowedSideEffects.includes(sideEffectFor(tool))`. The third
  conjunct is false for every shipped profile.

**The defect is real and total.** `collab__post_message` is outside every effective profile.
No auto-turn can post under any model, ever. Origin as stated in the brief is accurate:
`7c0a4af` created the class and excluded it everywhere — correct for `read_only`, unasked
for everything else.

**Why it is silent** — confirmed at `autoReplyDispatcher.ts:301-317`. Outcome is decided by
`countAgentPostsSince(...) > 0`; when zero and the agent is still an active member, the
`else` branch at `:316` writes `state: 'no_post'`. A structurally-impossible post and a
deliberately silent agent produce a byte-identical row. Enabling `TORQCLAW_AGENT_AUTOREPLY=1`
today yields silent turns forever with nothing surfaced.

---

## 1. New profile, not a widening — and the shape needs three amendments

### Widening any existing profile is rejected

| Candidate | Why rejected |
|---|---|
| `read_only` | `allowedNamespaces: ['*']` (`:87`). Adding `collab_write` here grants it to **every task type that defaults to read_only** — `DATA_EXTRACTION` and `SUMMARIZATION` (`profileResolver.ts:10-11`) — i.e. ordinary human-submitted tasks. This is precisely V-S2-1 reopened by another door. Also destroys the profile's contract ("nothing here mutates"), which the conformance suite and `docs/security/profile-conformance.md` both publish as a claim. |
| `workspace_write` | `allowedNamespaces: ['filesystem']` (`:97`) — a collab tool would never match the namespace conjunct, so admission would additionally require widening namespaces. Carries `capability: 'write'` and `FRONTIER`. Wrong on three axes. |
| `browser_research` | Unrelated namespace set. Would be incoherent. |
| `terminal_power` | Carries `exec` + `FRONTIER`. See §4. |

G1D's rejection reasoning here is **sound and I adopt it**. A new profile is correct.

### Required amendments to G1D's shape

G1D proposed:
```
allowedSideEffects: ['none', 'collab_write']
allowedNamespaces: ['collab']
allowedCapabilities: ['read']
allowedTiers: ['LOCAL_EDGE']
approvalRequirements: { write: false, exec: false, send: false }
```

**AMENDMENT 1 — `scopes` is missing entirely.** `BuiltInProfileDefinitionSchema:69-78`
requires `scopes: ProfileScopesSchema` (a required, non-optional field). G1D's shape omits
it; as written it **does not type-check and does not parse**. Must be
`scopes: { path: 'none', network: 'none' }`. Not cosmetic: `noBroaderScopes`
(`profilePolicy.ts:215-220`) uses these for the stricter/broader lattice, and anything
other than `none/none` silently makes this profile non-comparable to `read_only`.

**AMENDMENT 2 — `allowedNamespaces: ['collab']` is correct but load-bearing for a reason
G1D did not state, and must be documented as such.** The namespace conjunct is the *only*
thing preventing this profile from admitting non-collab tools. Because
`allowedCapabilities: ['read']` and `sideEffectFor` short-circuits `capability === 'read'`
→ `'none'` (`profilePolicy.ts:91`), **every read-capable tool in the entire registry
derives side-effect `'none'`, which this profile admits.** If the namespace list were ever
widened to `'*'`, this profile would instantly become `read_only` **plus** collab-write.
The namespace restriction is not stylistic scoping — it is the containment boundary.
This must be a comment in the definition, not tribal knowledge.

**AMENDMENT 3 — `approvalRequirements` is correct but for a non-obvious reason; keep it and
document it.** All three flags false is right, but *not* because "nothing needs approval."
It is because `policyMaterial`'s approval derivation (`:122-130`) keys on
`tool.capability === 'write' | 'exec' | 'send'`. `post_message` is `capability: 'read'`
(`collabAgentTools.ts:155`, per the operator's speech ruling), so **none of the three flags
can ever fire for it regardless of their values.** Setting them true would be inert
theatre — it would not gate posting. Anyone later trying to "add approval to posting" by
flipping `write: true` here will achieve nothing. Record that.

### The ruled shape

```ts
agent_conversation: {
  profileId: 'agent_conversation',
  profileVersion: PROFILE_VERSION,
  // LOAD-BEARING: the ONLY conjunct preventing this profile from admitting
  // every read-capable tool in the registry. capability:'read' derives
  // side-effect 'none' (profilePolicy.ts:91), which this profile admits.
  // Widening this to '*' turns this into read_only + collab-write.
  allowedNamespaces: ['collab'],
  allowedCapabilities: ['read'],
  allowedSideEffects: ['none', 'collab_write'],
  // Unattended. FRONTIER's approval posture for an agent-authored prompt has
  // never been evaluated (autoReplyDispatcher.ts:282-291).
  allowedTiers: ['LOCAL_EDGE'],
  scopes: { path: 'none', network: 'none' },
  // Inert-by-construction, not a policy choice: approval derivation keys on
  // capability write/exec/send; post_message is capability:'read', so no flag
  // here can ever gate it. Do not "add approval" by flipping these.
  approvalRequirements: { write: false, exec: false, send: false },
}
```

Name: **`agent_conversation`**. G1D did not name it. Prefer this over
`collab_post`/`autoreply` — it names the seat, not the mechanism, matching the existing
naming convention (`browser_research`, `terminal_power` name activities).

### Nothing too permissive; one thing genuinely absent

`'none'` in `allowedSideEffects` is **required**, not slack — without it `collab__read_channel`
(side-effect `'none'`) drops out and the agent could post but not read, which the prompt at
`autoReplyDispatcher.ts:243-244` explicitly instructs it to do.

**What is absent from the whole design (flagged, not blocking):** this profile grants
post rights to *every channel the agent is a member of*, with no per-channel scoping and
no rate limit in the profile layer. Containment rests entirely on `collab_members`
membership plus the anti-storm mechanisms in the dispatcher. That is defensible for S3, but
it means the profile is not the containment boundary people will assume it is. Consistent
with the standing memory entry that approval is consent, not containment.

---

## 2. Blast radius of a fifth `ProfileId`

Every consumer was checked against source. **Two are frozen contracts that break loudly —
which is the correct outcome and must not be "fixed" by loosening them.**

| Consumer | Breaks | Detail |
|---|---|---|
| `tests/profile-conformance-declared.test.ts:19-22` | **YES — loudly, by design** | `expect(Object.keys(golden.profiles)).toEqual(['read_only','workspace_write','browser_research','terminal_power'])` is a hardcoded four-element deep-equal, and `:22` deep-equals `BUILT_IN_PROFILE_DEFINITIONS` to the golden. A fifth key fails both. **This is a FROZEN CONTRACT and it is working.** Update the golden fixture and this literal together, in the same commit, as a deliberate reviewable act. Do NOT relax to `toContain`. |
| `tests/fixtures/profile-conformance-golden.json:4-45` | **YES** | Enumerates all four profiles verbatim plus `baseCommit` (`:3`, pinned, asserted at `declared:18`). Needs a fifth entry and a `baseCommit` bump. |
| `docs/security/profile-conformance.md:11-14` | **YES** | `declared:25-29` byte-matches a marker-delimited GFM table against `renderProfileTable(golden)` (`helpers/profile-conformance.ts:111-123`, which iterates `Object.keys(manifest.profiles)`). The doc table auto-derives from golden, so it fails until a row is added. Documentation drift is gated. Good. |
| `packages/contracts/generated/GatewayRequest.json:150-154` + `engines/hermes_kernel/mcp_wrapper/schemas/GatewayRequest.json` | **Regenerates — verified empirically** | I added a probe profile and both files auto-regenerated with the new enum member; `diff` showed them identical to each other. `emit-schemas.ts:28` writes both dirs, `check-schemas.ts:60` verifies both. **The Python boundary is gated, not silent** — `pnpm --filter @torqclaw/contracts check` fails on drift. Requires running the contracts build; will not silently desync. |
| `profileResolver.ts:9-15` `DEFAULT_PROFILE_BY_TASK` | **NO — and this is the danger** | Typed `Record<TaskType, ProfileId>`. A new **ProfileId** requires no change (it is the value type). Only a new **TaskType** would break it. So the map compiles untouched and the new profile is simply never a default. This is exactly why the resolution mechanism in §3 matters — a fifth profile is *inert* until something resolves to it, and TypeScript will not remind you. |
| `policyHash` / `resolveEffectiveProfile` | **NO** | Hash is computed per-profile over that profile's own material (`policyMaterial:104-147`). Adding a profile does not perturb the other four's hashes. The pinned `fixedPolicyVector` (`golden.json:120-124`) is `read_only`-only and stays valid. Verified: `profile-conformance-declared` passed green at baseline before my probe. |
| `profile-conformance-runtime.test.ts:132,161,254-263` | **NO structurally** | Iterates `Object.entries(readGolden().profiles)` and `Object.keys(BUILT_IN_PROFILE_DEFINITIONS)` dynamically — picks up a fifth automatically and will assert it against its declared row. Note `:252,:261,:263` carry "all four profiles" in assertion *messages* only; cosmetic, worth updating for honesty. |
| `ProfileIdSchema` (zod enum) | **NO** | Additive. Existing parses unaffected. |
| `compareProfilePolicies` lattice | **NO, but note** | The new profile will be `incomparable` to `read_only` (different namespaces, and `collab_write` ⊄ `['none']`). That is correct and is what makes `resolveProfile:40-46` refuse it as an un-authorized request — see §3. |

**Net:** three gates fail loudly and must be updated deliberately; nothing fails silently;
nothing else is disturbed. The conformance suite is doing precisely the job it was built
for. **The one real hazard is the inert-by-default behavior of `DEFAULT_PROFILE_BY_TASK`.**

---

## 3. Resolution mechanism — direct override, and the escalation proof

**RULING: a direct profile override on the gateway-minted request. NOT a new TaskType.**

Replace `autoReplyDispatcher.ts:237-238`:
```ts
const taskType = 'SUMMARIZATION' as const;
const effectiveProfile = resolveProfile({ taskType }).profile;
```
with an explicit, commented override:
```ts
const taskType = 'SUMMARIZATION' as const; // toolFilter's collab__ prefix routing
const effectiveProfile = resolveProfile({
  taskType,
  requestedProfile: 'agent_conversation',
  sessionDefaultProfile: 'agent_conversation',
  operatorAuthorized: false,
}).profile;
```

Setting **both** `requestedProfile` and `sessionDefaultProfile` matters: `resolveProfile:40-46`
throws when `requestedId !== sessionId` and the relation is `broader`/`incomparable` without
`operatorAuthorized`. Since `agent_conversation` is `incomparable` to `read_only`, passing
only `requestedProfile` would **throw at every auto-turn** — converting the silent failure
into a crash-loop in the dispatcher. Setting both makes them equal, the guard is not
engaged, and `operatorAuthorized` stays `false` so no authority is fabricated. This is a
real trap and G1D's write-up did not mention it.

### Why not a new TaskType

A fifth `TaskType` breaks strictly more: `TOOL_ROUTING_MAP` (`toolFilter.ts:21-27`) and
`DEFAULT_PROFILE_BY_TASK` (`profileResolver.ts:9-15`) are both exhaustive
`Record<TaskType, …>`, plus the classifier, the router's heuristics, and the emitted
`TaskType` schema. It would also make the profile reachable through *classification* —
i.e. through prompt content — which is the exact escalation vector to avoid.

### Escalation prevention — the mechanism, stated exactly

**A profile reachable through ordinary task submission would be privilege escalation. Three
independent facts prevent it. I verified each.**

1. **The wire contract cannot express a profile request.** `packages/contracts/src/commands.ts`
   contains **zero** occurrences of `profileId`, `effectiveProfile`, or `requestedProfile`
   (grepped). A client literally cannot ask for a profile — there is no field. This is the
   strongest of the three: it is structural, not a check that could be forgotten.
2. **The ordinary submission path never passes one.** `enrich.ts:37` calls
   `resolveProfile({ taskType: cls.taskType })` with **only** `taskType`. `requestedProfile`
   is `undefined`, so `resolveProfile:35` falls back to `sessionId`, which comes from
   `DEFAULT_PROFILE_BY_TASK` — a map that will contain **no** entry pointing at
   `agent_conversation`. Every human-submitted task therefore resolves to one of the
   original four, by construction.
3. **The guard fails closed even if 1 and 2 were bypassed.** `resolveProfile:40-46` throws
   on a `broader`/`incomparable` request without `operatorAuthorized`. `agent_conversation`
   is `incomparable` to every default.

**The load-bearing invariant to pin with a test:** *`agent_conversation` appears as a value
in `DEFAULT_PROFILE_BY_TASK` for zero task types, and `enrich.ts` never passes
`requestedProfile`.* Both are cheap source-level assertions. Add them — otherwise a future
edit adding `agent_conversation` to the task map would silently expose it to human traffic,
and nothing currently would catch that.

### The half G1D's proposal omits

**Admission alone does not make the loop work.** `getToolsForTask` (`toolFilter.ts:91-101`)
filters on `prefixes.some(...)` **AND** `isOperationAllowed` **AND** the identity gate at
`:99`. `TOOL_ROUTING_MAP.SUMMARIZATION` (`:23`) includes `'collab__'`, so keeping
`taskType='SUMMARIZATION'` is required for the tool to be *rendered* at all. If someone
"cleans up" the now-vestigial-looking `taskType` line while adding the profile override,
the tool silently disappears from the model's list again — same silent failure, new cause.
The comment must say the taskType is retained **for prefix routing**, not out of inertia.

---

## 4. `terminal_power` — RULING: NO, do not admit `collab_write`. Separate decision, and it is not needed.

Explicit ruling, since silence here becomes another no-admission gap.

**Do not add `collab_write` to `terminal_power` now.** Reasons:

1. **It would not work anyway.** `terminal_power.allowedNamespaces` is
   `['desktop_commander','sandbox','shell','terminal']` (`:117`) — no `collab`. Admission is
   conjunctive (`:106-112`), so adding `collab_write` to `allowedSideEffects` alone changes
   **nothing**. Anyone doing it would produce an inert edit that *looks* like it granted
   posting. That is a fresh unenforced-claim defect of exactly the kind this program keeps
   producing. If it is ever done, it requires **both** lists.
2. **It couples the blast radii.** `terminal_power` carries `exec` and **FRONTIER** (`:120`).
   Under FRONTIER the engine's `pre_tool_call` hook grants by name only — the reason
   auto-turns are force-pinned to LOCAL_EDGE (`autoReplyDispatcher.ts:282-291`). Granting
   collab-write there means an unattended-capable posting right under a mechanism this
   program has already ruled insufficient.
3. **The use case is real but unbuilt.** A human-directed coding agent posting progress is
   legitimate. It is also a *different* threat model: attended, human-initiated, with a
   human watching. It deserves its own decision with its own evidence.

**Ruled: deferred, explicitly, not silently.** File it. When it is taken up, the answer is
most likely a *composed* or second profile, not a widening of `terminal_power` — because
posting should not be bundled with `exec`.

---

## 5. The stale comment — and the structural fix (the real lesson)

`autoReplyDispatcher.ts:237` says `read_only admits the free-speech post_message tool`. That
was true when S3 was written and was made false by `7c0a4af`. Fixing the words is necessary
and insufficient; comments cannot be gated.

**RULING: yes, assert loudly at dispatch. Adopt it. This is the most important item in this review.**

The failure mode is not "wrong profile" — it is **a policy failure wearing the costume of a
legitimate product outcome.** A3-f makes `no_post` valid, so an impossible turn and a
thoughtful silence are indistinguishable (`autoReplyDispatcher.ts:301-317`). That is the
same shape as S-5's silent stall, one layer up, and the same shape as the eight guards that
passed identically with and without themselves.

### Required structural fix

**A. Precondition assertion at dispatch — fail loudly, before minting the request.**
After resolving the profile in `runAgentTurn`, assert that the turn's *required* tools are
actually admitted:

```ts
const requiredTools = predictTools(taskType, effectiveProfile, agentPrincipalId);
// A turn that cannot post is a POLICY DEFECT, not a silent 'no_post'. A3-f
// makes silence a valid MODEL choice; it must never be a valid STRUCTURAL
// outcome. These two must not be able to look alike.
if (!requiredTools.includes('collab__post_message')) {
  resolveAgentTurn(db, { ..., state: 'terminated', ... });
  // plus a SYSTEM event / error log naming the resolved profileId
  throw new Error(
    `agent turn cannot post: 'collab__post_message' not admitted by effective ` +
    `profile '${effectiveProfile.profileId}'`
  );
}
```

Key properties: it is derived from the **same** `predictTools` the model's tool list comes
from (not a parallel reimplementation that could drift — the mirroring-validator failure
mode already recorded in this program's memory), it fires **before** any model call, and it
resolves `terminated`, never `no_post`.

**B. The generalizable rule — adopt as program policy:**
> *When a capability is a precondition for a turn's purpose, its absence must terminate the
> turn loudly. A structural inability to act must never resolve to the same state as a
> deliberate choice not to act.*

**C. Third-order:** consider distinguishing `no_post` from a new terminal state such as
`blocked_by_policy` in `collab_agent_turns`. Then the substrate itself carries the
distinction and an operator can query for it. Optional; A alone closes the defect.

---

## 6. Cheaper correct fix? — NO. Both alternatives are worse and one is dangerous.

I looked for one specifically, per the brief.

**Alternative A — reclassify `post_message` as not `collab_write`.**
**Rejected, and it is the dangerous one.** It would revert V-S2-1. The class exists because
`capability` is overloaded: `'read'` correctly encodes "no approval" (operator's speech
ruling) while `sideEffectFor`'s `'read' → 'none'` short-circuit (`profilePolicy.ts:91`)
asserts "mutates nothing", which is false — it commits a durable `collab_events` row.
G2A's S2 audit recorded this reproduced by execution (before=0, after=1). Reclassifying
would restore posting *and* re-admit it into `read_only` for ordinary `SUMMARIZATION` and
`DATA_EXTRACTION` tasks. It is cheaper only because it re-opens the hole. **No.**

**Alternative B — exempt in-process gateway-owned tools from profile admission.**
**Rejected.** Superficially appealing (collab tools are gateway-owned, not third-party MCP)
but it introduces a *class of tool that policy does not describe*. The profile system's
value is that it is total; a bypass category is a permanent blind spot, and the next
gateway-owned tool inherits an exemption nobody re-reviewed. It also contradicts the
S2 posture explicitly chosen at `profilePolicy.ts:83-87` — fail closed, admission is
declared not inherited.

**Alternative C — do nothing, leave auto-reply off.** Honest but not a fix; the defect
stays armed behind a flag, and the silence means the next person to flip it learns nothing.

**Conclusion: the new profile is the cheapest *correct* fix.** G1D's core judgment is right.

---

## 7. Is A3-c's pinning right?

**Yes — with one required change.**

Asserting the exact refusal string
`"Tool 'collab__post_message' is outside effective profile 'read_only'"`
(`agent-participation-a3c.test.ts:401-404`) is **the right instinct**: it pins the *precise
reason*, so the test cannot pass for an unrelated reason, and it is falsifiable. The
"it will change when fixed" property is a feature — that is what makes it a real RED.

It is also **not as brittle as it looks**: `:402` uses `.some()` with a regex over
`observedRefusals`, not string equality, and the string is produced by a single
`throw` site (`profilePolicy.ts:192`). Churn risk is low.

**Required change: the test asserts the defect, so when the profile lands, this test must be
INVERTED, not deleted.** The danger is that whoever fixes the profile sees a failing test
asserting brokenness and deletes it — losing the only end-to-end proof of the round trip.
The file's own header (`:76-88`) documents the intent well, but intent in a comment is
exactly the thing this review just ruled insufficient.

Concretely, on fix: assertion 1 flips from "must fail" to "**two agents actually converse**"
— `posts.length === 3` (human + A + B), turn states `completed`. That is the A3-c criterion
the file says "proves the product exists," and it has never once been proven green. The
mechanics assertions (2,3,4) and the falsifiability probe (`:484-529`) survive unchanged.
**Landing the profile without flipping this test means A3-c is still unproven.**

---

## 8. Do the two unbuilt items block this decision?

**RULING: NO. Neither blocks. Both were correctly reported rather than skipped.**

- **`buildAnchorWindowContext` has no unit test.** Confirmed — `grep` finds it only in
  `autoReplyContext.ts:48`, `autoReplyDispatcher.ts:87,223`, and an A3-c comment. It is
  upstream of the profile decision (it builds the prompt, `:223-224`), and its failure mode
  is already handled: a `COLLAB_NOT_FOUND` throw terminates the turn at `:229-231`. It
  does not interact with profile admission. **Owed, not blocking.** Should be built before
  the loop is declared live, since it shapes every prompt an agent ever sees.
- **S-6 gateway-side membership-removal termination is code-trace only.** Confirmed at
  `:304-313`, and it is genuinely unexercised today **for a reason that this fix removes**:
  no turn can currently reach the post stage, so the `countAgentPostsSince === 0` +
  `!agentIsActiveMember` branch is unreachable in practice. **It does not block the
  decision, but it becomes testable the moment the profile lands** — and it *should* be
  tested then, because after the fix the `no_post` / `terminated` distinction carries real
  weight. Track it as a follow-on to this change, not a prerequisite.

Neither touches profile admission. The decision stands on its own evidence.

---

## 9. Falsifiability — how to prove this fix real, and how it would be caught if fake

Per the program's standing rule (eight guards passed identically with and without
themselves), every claim below is stated with its disconfirming test.

1. **The profile actually admits the tool.** `resolveEffectiveProfile('agent_conversation')`
   → `allowedOperationIds` contains `collab__post_message`.
   *Falsified by:* removing `'collab_write'` from `allowedSideEffects` → must go RED. If it
   stays green, admission is coming from somewhere else and the profile is decorative.
2. **The namespace conjunct is load-bearing (§1 Amendment 2).** Change
   `allowedNamespaces` to `['*']` → the profile must start admitting unrelated read tools
   (`filesystem__read_file`, `websearch__search`). If it does not, my containment analysis
   is wrong and this must be re-reviewed.
3. **A3-c goes GREEN end-to-end.** Three `message_posted` rows, both turns `completed`.
   *Falsified by:* reverting the profile → must return to the pinned `read_only` refusal.
   **This is the primary proof and it must run against `dist/`, after `pnpm build`** — the
   test imports from `packages/*/dist/` (`a3c:101-103,227-233`), and a stale `dist` is a
   recorded false-green source in this repo.
4. **No escalation.** Assert `Object.values(DEFAULT_PROFILE_BY_TASK)` excludes
   `agent_conversation`, and that a normal `SUBMIT_PROMPT` through `enrich.ts` resolves a
   profile whose `allowedOperationIds` excludes `collab__post_message`.
   *Falsified by:* adding it to the task map → must go RED.
5. **The loud assertion is real (§5).** Temporarily strip `collab_write` from the profile
   while leaving the dispatcher intact → the turn must **throw/terminate**, and must **not**
   record `no_post`. *If it records `no_post`, the assertion is not wired* — this is the
   single highest-value probe here, because it tests the guard against its own absence,
   which is exactly what the eight prior guards failed.
6. **Conformance gates fired deliberately.** `profile-conformance-declared` must have
   required a golden + doc-table update. If it passed untouched, the golden was loosened
   and the freeze is gone.
7. **Python boundary consistent.** `pnpm --filter @torqclaw/contracts check` PASS after
   `build`. **Empirically verified during this review:** I added a probe fifth profile and
   both `packages/contracts/generated/GatewayRequest.json` and
   `engines/hermes_kernel/mcp_wrapper/schemas/GatewayRequest.json` regenerated in lockstep
   (`diff` → identical). The mirror is gated by `check-schemas.ts:60`, not silent.

**Method note:** `python3` does not exist on this host — no probe here used it. All
mutation was applied via structured `Edit` (never PowerShell `-replace`), the file was
backed up to scratchpad first, and it was restored with `cp` + `git checkout` for the two
auto-regenerated schema artifacts.

---

## 9A. Upstream (Hermes) counter-evidence — considered, verified, ruling UNCHANGED

Research landed mid-review arguing *against* the new-profile recommendation. I verified its
load-bearing claims in our pinned vendor copy rather than accepting them. **All four
factual claims are TRUE. The conclusion drawn from them does not follow for our system.**

### Verified in our pin

- **`delegate_tool.py:44-53`** — `DELEGATE_BLOCKED_TOOLS` frozenset contains `send_message`
  ("no cross-platform side effects") and `memory` ("no writes to shared MEMORY.md"). Exact
  text confirmed. Upstream does strip messaging from delegated contexts rather than gate it.
- **`delegate_tool.py:1005-1007`** — `if toolsets:` → `child_toolsets = [t for t in toolsets
  if t in expanded_parent]`, commented *"Intersect with parent — subagent must not gain tools
  the parent lacks."* A real set intersection, server-side. Confirmed.
- **`model_tools.py` / `send_message_tool.py:1773-1774`** — confirmed:
  `if os.environ.get("HERMES_KANBAN_TASK"): return True`, and it sits **before** the
  `is_gateway_running()` check. An env var alone flips `send_message` from unavailable to
  available, bypassing the profile's declared toolset. Upstream violates its own
  intersection invariant.
- **`approval.py:1071-1072`** — `is_dangerous, ... = detect_dangerous_command(command)` /
  `if not is_dangerous: return {"approved": True}`. Unmatched ⇒ approved. Fail-open confirmed.

### Ruling on the "don't mint a profile to route around your own check" objection

**The objection is well-posed and I reject it as disanalogous.** Three reasons, in order of
weight:

1. **It mistakes an *unmade decision* for a *deliberate block*.** `collab_write` was never
   denied on the merits. `7c0a4af` created the class to fix wrong-admission in `read_only`
   and, as the brief concedes, "never asked which profile should admit it." There is no
   check being routed around, because no check ever ruled on this question. Contrast
   `DELEGATE_BLOCKED_TOOLS`, which is an *affirmative* upstream judgment with a stated
   rationale per entry. Minting a profile to reverse a considered denial would be the
   anti-pattern named; making the omitted decision is not.
2. **The disanalogy the coordinator proposes is the correct one, and it is decisive.**
   Upstream's mechanism is a **flat frozenset of tool names** — subtractive, unstructured,
   with no place to record *under what conditions* a tool is permissible. Given that
   substrate, removal is genuinely the only safe move: there is nothing to attach a
   condition to. Ours is a **declarative policy object** with namespace × capability ×
   side-effect × tier × scopes × approval, conjunctively enforced
   (`profilePolicy.ts:106-112`), hashed, and conformance-pinned. A new profile is not a
   loophole in that system — **it is the system's only expressive unit.** Saying "don't add
   a profile" in a profile-based policy engine is saying "don't use the policy engine."
3. **The researcher's own reframing supports the fix, not the objection.** They are right
   that our unreachability is fail-closed working as designed, and that "the bug is only
   that nobody made the admission decision." **That is exactly what this ruling is: the
   admission decision.** Agreeing that the posture is sound is not an argument for leaving
   the capability permanently unreachable — it is an argument for deciding deliberately,
   loudly, and narrowly. Which is what §1 does.

**Upstream's example actually strengthens the case for a narrow new profile.** Their
messaging capability escaped its own denylist via an ambient env var
(`send_message_tool.py:1773`) — precisely the "cannot prove argument identity" failure our
constraints forbid, and precisely what a *declarative, hashed, gateway-resolved* profile
prevents. Our request object cannot carry a profile (§3, `commands.ts` grep: zero hits) and
no env var participates in admission. We should not copy a pattern whose authors could not
keep it safe.

### On admitting `collab_write` to one existing profile instead

**Rejected — and the coordinator's instinct is right.** That is the same objection raised
against widening `read_only`, merely relocated. Every existing profile already serves other
traffic: `read_only` serves `DATA_EXTRACTION` + `SUMMARIZATION`, `terminal_power` serves
`COMPLEX_CODING` (`profileResolver.ts:10-15`). Admitting `collab_write` to any of them
grants posting to **all** traffic resolving there, including human-submitted tasks. A tight
namespace allowlist does not fix this — it constrains *which tools*, not *which callers*.
The new profile is safer precisely because **nothing routes to it** except the one
dispatcher line, and §3's three independent facts keep it that way. A "tight allowlist on
an existing profile" is strictly more exposed for identical capability.

### On the child ⊆ parent narrowing invariant

**Genuinely valuable; SEPARATE SLICE. It does not belong in this ruling.**

The principle — a derived or unattended context may only narrow, never widen — is sound,
matches `compareProfilePolicies`'s existing `stricter`/`broader`/`incomparable` lattice
(`profilePolicy.ts:225-245`), and is already *partially* enforced at `resolveProfile:40-46`
(broadening without `operatorAuthorized` throws).

I exclude it here for a specific reason: **`agent_conversation` is `incomparable` to
`read_only`, not `stricter`.** A naive child ⊆ parent rule, encoded now, would forbid this
very fix — an auto-turn derived from no parent, resolving to a laterally-different profile,
is neither narrowing nor widening. Encoding the invariant properly requires deciding how
*incomparable* derivations are treated, which is a real design question deserving its own
review with its own evidence. Bundling it here would either block the fix or produce a
rule with a silent exception carved for the case that motivated it — the exact
unenforced-claim pattern this repo keeps repeating.

**Recommend: file it as its own slice.** Note when it is taken up that upstream's version
is enforced at one site and defeated at another by an env var; ours should be enforced
centrally in `resolveProfile`, the single chokepoint both callers already pass through
(`enrich.ts:37`, `autoReplyDispatcher.ts:238`).

### Worth adopting: per-call-site fail-closed declaration

**Agreed, and it converges with §5A independently.** Upstream's
`fail_closed_when_no_human=True` as an explicit per-call-site parameter — rather than an
ambient default — is the right shape, for the same reason §5A puts the precondition
assertion *at the dispatch site* rather than inside the policy layer: the call site is what
knows whether a human is present. Our auto-turn path is unambiguously unattended and
should declare so explicitly. Fold this into §5A's assertion as a named, explicit
parameter rather than an implicit property of being in `autoReplyDispatcher.ts`.

**Net effect on the ruling: none of the ten required changes in §10 is altered.** The
counter-evidence sharpened the rationale and added one adopted item; it did not move the
verdict.

---

## 9B. SEPARATE URGENT EXPOSURE — CONFIRMED REAL, filed independently

Not part of this ruling; verified because it was raised and it is a live safety issue.

**`engines/hermes_kernel/vendor/hermes-agent/tools/approval.py:1082-1100` — CONFIRMED.**
Read directly in our pin. The path:

```
is_cli     = env_var_enabled("HERMES_INTERACTIVE")
is_gateway = _is_gateway_approval_context()
if not is_cli and not is_gateway:
    if env_var_enabled("HERMES_CRON_SESSION"):        # cron branch, may deny
        if _get_cron_approval_mode() == "deny": ...return approved:False
    logger.warning("AUTO-APPROVED dangerous command in non-interactive "
                   "non-gateway context ...")
    return {"approved": True, "message": None}
```

**Enclosing conditions and defaults, stated per this repo's citation rule:** reached only
when the command has **already been classified dangerous** (`detect_dangerous_command` at
`:1070` returned true — the `not is_dangerous` early-return at `:1071-1072` did not fire),
`_YOLO_MODE_FROZEN`/session-yolo is false (`:1067`), it is not already session-approved
(`:1075-1076`), `HERMES_INTERACTIVE` is unset/falsey, `_is_gateway_approval_context()` is
false, and either `HERMES_CRON_SESSION` is unset **or** `_get_cron_approval_mode()` is not
`"deny"`. Under those conditions a **known-dangerous** command is auto-approved with only a
log line. Hardline blocks (`:1060-1063`) still apply and are unaffected.

Our pin is **1,751 lines** (`wc -l` confirmed), consistent with the claim that upstream's
current `approval.py` is far larger and has since added `approvals.single_query_mode`
(default deny), which is **absent from our pin**.

**Assessment: the exposure is real but currently latent for TorqClaw**, because this repo
routes FRONTIER through `mcp_wrapper/` and auto-turns are force-pinned to LOCAL_EDGE
(`autoReplyDispatcher.ts:282-291`). The risk materializes if anything ever routes work
through the pin's non-interactive `chat -q` path. Compounding factor already recorded in
program memory: FRONTIER's terminal/code-execution bypasses bridge path scoping entirely,
so this auto-approval is not backstopped by our own containment.

**Recommendation:** treat as a real finding; either set `HERMES_INTERACTIVE`/gateway context
on every invocation path, or advance the pin to obtain `single_query_mode`. Per instruction
this is filed separately and did not delay this ruling.

---

## 9C. Prior-art survey — ADOPTED with one amendment; §5 upgraded, verdict unchanged

Second research landed: a prior-art survey on "permission class exists, nobody grants it."
It is the strongest input received and it **upgrades §5 from a recommendation to a
requirement**. It does not change the verdict on the profile.

### On whether declare-then-validate changes the profile answer

**ORTHOGONAL. Profile now; coupling as its own slice.** The researcher's own ranking says
this explicitly — a new profile is "the immediate unblock ONLY... necessary but
insufficient; prior art does not treat it as a fix." **I adopt that framing verbatim and it
is the correct characterization of §1.** The profile is what makes posting *possible*; the
structural work in §5 is what makes its absence *visible*. Neither substitutes for the
other, and shipping only the profile would fix this instance while leaving the bug class
armed for the next side-effect class someone adds.

The survey's sharpest point is correct and I adopt it: **my §5 as originally written asks
the weaker question.** "Is this class admitted anywhere?" is satisfiable by a lazy fix that
adds the class to an unrelated profile. The right question is **"for each tool, does at
least one profile that can REACH this tool admit its class?"** — reachability, not mere
existence. That question would have answered NO for `collab_write` on day one of `7c0a4af`,
in the very PR that introduced the class. §5A's assertion is per-turn and already
reachability-shaped (it runs `predictTools` for the actual turn), so it satisfies the strong
form; the *build-time* half must be written to the strong form too, not the weak one.

### On the `needed` vs `provided` payload and the T-2 tension — RULING

The coordinator is right that this is the sharp question, and the researcher did not have
T-2 in view. **Ruling: adopt Slack's `needed`/`provided` shape for the OPERATOR-FACING
channel ONLY; the MODEL-FACING channel stays byte-identical opaque. These are two different
sinks and must not share a payload.**

T-2 verified as a hard guarantee, not a style preference: `store.ts:96-105` defines
`COLLAB_NOT_FOUND_MESSAGE = 'Request could not be completed'`, documented as *"byte-identical
across every denial cause"*, and `collabAgentTools.ts:128-131` deliberately mirrors it
byte-for-byte so a model cannot distinguish nonexistent-channel from not-a-member. That is
a channel-enumeration defense and it must not be weakened.

The tension **dissolves on inspection**, because the two failures are at different layers
and carry different information:

- **T-2 protects substrate facts** — which channels exist, who is a member. Those are
  *runtime, per-caller, data-dependent* facts a model must not learn by probing.
- **§5A's assertion reports a policy-configuration fact** — "profile `X` does not admit
  side-effect class `collab_write`". That is *static, caller-independent, and identical for
  every agent and every channel.* It leaks nothing about the substrate. It is knowable from
  the source tree.

So the correct split is:

| Sink | Content | Rationale |
|---|---|---|
| Gateway log / SYSTEM event / thrown error (**operator**) | Full `needed` vs `provided`: `needed: 'collab_write'`, `provided: <profile.sideEffectClasses>`, `profileId`, `agentPrincipalId`, `channelId` | Never reaches the model. This is the diagnostic Slack's `missing_scope` payload exists to provide, and its absence is exactly why this defect stayed invisible. |
| Anything reaching the model's transcript | Nothing — the turn **terminates before the model is invoked** | §5A fires *before* the request is minted, so there is no model turn to leak into. The model never sees this error at all. |

**This is why §5A's placement is load-bearing and not merely convenient:** because the
assertion runs pre-dispatch, the T-2 question is moot by construction — there is no model
in the loop yet. Had the check been placed at tool-execution time instead, the refusal
string would enter the transcript and T-2 would genuinely constrain it. The existing
`assertOperationAllowed` message (`profilePolicy.ts:192`) *does* reach a model transcript
when a tool call is refused mid-turn; it names only the tool and profile — no channel, no
membership — so it is T-2-clean today and must stay that way. **Do not add `needed`/`provided`
to `profilePolicy.ts:192`.** Add it only at the pre-dispatch site and the operator log.

Recording the general rule, since it generalizes past this ticket:
> *Diagnostic richness is bounded by the sink, not by the error. Static policy-configuration
> facts may be reported in full to operators. Runtime, per-caller substrate facts stay
> byte-identical opaque on any path a model can observe.*

The survey's downstream-harm finding is the decisive argument and I want it on the record:
**silent denial drives people to disable the permission system entirely.** In the cited
incident, silent failure pushed users toward a skip-permissions flag to "fix" it. Our
equivalent is an operator concluding auto-reply is broken and reaching for whatever switch
makes it stop being broken. A loud, specific, operator-facing error is not a nicety — it is
what prevents the security control from being torn out by someone who cannot tell it is
working.

### On the TypeScript `Record` compile gate — VIABLE, with a caveat

**Yes, viable, and it is the cheapest of the four.** Confirmed against our source: this is
already a proven pattern in this repo. `DEFAULT_PROFILE_BY_TASK` is
`Record<TaskType, ProfileId>` (`profileResolver.ts:9`) and `TOOL_ROUTING_MAP` is
`Record<TaskType, string[]>` (`toolFilter.ts:21`) — both exhaustive over `TaskType`, both
compile-error on a new member. The mechanism works here today.

**It does NOT disturb `policyHash` or the Python schemas.** Verified: `policyHash` is
computed per-profile over that profile's own material (`policyMaterial:104-147`) — a
type-level exhaustiveness map is a separate declaration and contributes nothing to the
hashed material. The emitted schemas derive from the zod enums, not from any `Record`.
Empirically corroborated by my §2 probe: adding a profile regenerated only the `profileId`
enum in both `GatewayRequest.json` files and perturbed nothing else.

**The right shape here is keyed on `SideEffectClass`, not `ProfileId`** — the defect was a
side-effect class with no home:
```ts
// Every side-effect class must be explicitly routed or explicitly excluded.
// Adding a member to SideEffectClassSchema without a decision here is a BUILD
// ERROR, not a silent no-admission gap. This is the gate 7c0a4af would have hit.
const SIDE_EFFECT_ADMISSION: Record<SideEffectClass, ProfileId[] | 'INTENTIONALLY_UNADMITTED'> = {
  none:             ['read_only', 'workspace_write', 'browser_research', 'terminal_power', 'agent_conversation'],
  filesystem_write: ['workspace_write'],
  browser_mutation: 'INTENTIONALLY_UNADMITTED', // no profile grants browser writes
  process:          ['terminal_power'],
  network_send:     'INTENTIONALLY_UNADMITTED', // pinned by declared:69-75
  collab_write:     ['agent_conversation'],
};
```
**Caveat, stated plainly:** a hand-maintained map is itself an unenforced claim unless it is
*derived from or validated against* `BUILT_IN_PROFILE_DEFINITIONS`. A CI assertion that
each listed profile genuinely admits that class — and that each
`INTENTIONALLY_UNADMITTED` genuinely appears in no profile — converts it from documentation
into a gate. Without that check it is a second copy of the truth that can drift, which is
the mirroring-validator failure mode already recorded in this program's memory. **Ship the
map only with its validating assertion.**

Note this also subsumes the existing `declared:69-75` test, which hardcodes the
`network_send`/`send` case as a bespoke assertion. That test is the weak, one-off form of
this map — good instinct, not generalized.

### Adopted ranking

I adopt the researcher's ranking, with §5A promoted to blocking:

1. **Dispatch-time loud assertion (§5A)** — loudest, widest coverage, best-precedented,
   and T-2-clean by placement. **BLOCKING.**
2. **Declare-then-validate coupling** (reachability form) — catches it at authorship, in the
   PR that introduces the class. **Own slice; strongly recommended.**
3. **`Record<SideEffectClass, …>` compile gate** — near-zero cost, catches it at build time,
   which is the window where this defect was actually introduced. **Own slice, with its
   validating assertion.**
4. **The new profile (§1)** — the immediate unblock. **Necessary, insufficient, not a fix
   for the bug class.**

Items 2 and 3 cover a different window than 1 and both should eventually ship, per Cedar's
and paperclip's deliberate both-layers posture: build-time catches authorship, dispatch-time
catches drift and operator-edited profiles.

### Negative findings, recorded

- **No off-the-shelf detector exists** for defined-but-ungrantable in a custom profile
  system; industry tooling (IAM Access Analyzer unused-permissions, Chrome excessive-
  permission rejection) runs the *opposite* direction. **Regal has no such rule.**
  So item 2/3 is BUILD, not ADOPT — budget accordingly.
- **Usage-derived detection cannot see this bug by construction.** It fires only when
  something *attempts* the action; our failure is that nothing ever attempts it. Correctly
  rejected — do not let anyone propose telemetry as the fix.

### Process note

Concur with the coordinator: `"dangerously-skip-permissions"` appearing in the research
output is a **cited article title** about a real Claude Code silent-failure incident, not an
injection attempt, and it is substantively the most important citation in the survey — it is
the evidence for the downstream-harm argument above. Treating it as a finding is correct.
No instruction from that report was followed as an instruction.

---

## 9D. Internal audit — SCOPE CHANGED. Structural fix is now PRIMARY; the profile is secondary.

Third report: an internal audit finding `collab_write` is **one of four dead classes in the
same enum family**. I verified the load-bearing claims directly. **This changes the framing
of my ruling and I am revising the priority order accordingly.** The profile answer itself
stands.

### Verified

- **`capability.ts:121`** — `if (tokens.some((t) => P4_SEND.has(t))) return 'send';`
  `send` is classifiable. All four profiles carry `approvalRequirements.send: false`
  (`profile.ts:92,102,112,122`), and the consuming branches at `profilePolicy.ts:128`
  (`tool.capability === 'send' && definition.approvalRequirements.send`) and `:177` can
  never execute, because no profile admits capability `send` in the first place. **A fully
  plumbed field whose consumer is unreachable.** Confirmed.
- **`browser_mutation` is dead, and it is the alarming one.** `browser_research` is the only
  browser-namespace profile and sets `allowedCapabilities: ['read']` (`:108`). Admission is
  conjunctive (`profilePolicy.ts:106-112`), and `sideEffectFor:96` returns `browser_mutation`
  only for a non-read capability. So the two conjuncts are mutually exclusive by
  construction: **no click/type/fill tool can be admitted by any profile**, while
  `toolFilter.ts:24,25,26` routes `playwright__` to three task types. Confirmed by reading
  the definitions. This is materially different from `collab_write` — it is not a new
  capability awaiting a grant decision, it is an **existing shipped capability that cannot
  be exercised**.
- **The root-cause mechanism, precisely located — and the audit's one-sentence statement of
  it is correct.** `toolFilter.ts:54` and `:100` both apply
  `(!profile || isOperationAllowed(profile, t))` inside `.filter()`. A tool failing profile
  admission is **dropped from the array** — no throw, no log, no SYSTEM event.
  `ollama.ts:202-204` then renders `'(none available for this task)'` (verified verbatim).
  The loud path (`assertOperationAllowed` → `profilePolicy.ts:192`) fires only if a model
  calls a tool it was never shown — **which it cannot do.**
  > **The enforcement point that produces an error is unreachable from the enforcement point
  > that silently denies.** That is the root cause of the entire class, and it is why §5A is
  > not optional.
- **The prompt actively explains the failure away.** `autoReplyDispatcher.ts:245-246`
  instructs the agent that *"Staying silent (posting nothing) is a valid, expected outcome."*
  Verified verbatim. So the system **pre-authorizes the exact symptom its own defect
  produces**. An operator sees the agent read the channel, say nothing, and complete green.
  This is worse than silence: it is a built-in exculpatory explanation for a policy failure.
  I flag this as the single most important sentence in the audit.

### The phantom-`dist` warning — checked against my own probe, clean

The audit warns that `pnpm build` reported SUCCESS while `tsc` incrementally **skipped**
`profile.ts` because dist mtime predated src, producing a phantom fifth profile in
`dist/` only — which *"would have reported collab_write as already fixed."*

**My §2 probe used exactly the mutation name that phantom carried (`PROBE_agent_conversation`),
so I verified my own residue directly:**
`packages/contracts/src/profile.ts` → 0; `packages/contracts/dist/profile.js` → 0;
`dist/profile.d.ts` → 0; `packages/bridge/dist/profilePolicy.js` → 0.
**No residue anywhere.** My probe was reverted cleanly in both src and the two emitted
schema files, and it never propagated to dist. My §2 conclusions were additionally derived
from *reading assertion source*, not from executing against dist, so they do not depend on
build state. The one command I ran against dist (`profile-conformance-declared`, green at
baseline) preceded the mutation entirely.

**Adopted as a standing method rule, and it belongs in §9's falsifiability plan:**
`pnpm build` alone is NOT sufficient in this working tree. Any dist-dependent probe — which
includes **A3-c itself** (`a3c:101-103,227-233` imports from `packages/*/dist/`) — must be
preceded by `rm -rf dist tsconfig.tsbuildinfo` and a forced clean rebuild. This is a new
instance of the repo's recorded "verify the artifact, not the unit test" trap, with a
sharper edge: here the stale artifact would have produced a **false GREEN on the very defect
under review.**

### Ruling on the three questions

**1. Does a per-class profile decision scale? NO — and yes, this promotes the structural fix
to primary.**

**I am revising the priority order.** In §9C I ranked the dispatch-time assertion first and
called the profile "necessary but insufficient." With four dead classes in view that is no
longer strong enough. Four independent no-admission gaps, produced by four different
authors at four different times, none noticed, is not four coincidences — **it is a
systematic failure to make grant-side decisions, and a system that cannot report one.**
Deciding them one at a time, by G1R review each time, does not scale and does not prevent
the fifth.

**Revised deliverable order:**
- **PRIMARY: the structural fix** (§5A dispatch assertion + the reachability conformance
  test below). Catches all four now and every future one at authorship.
- **SECONDARY: the `agent_conversation` profile** (§1). Still correct, still needed to
  unblock A3-c, still my ruling — but it is the *instance* fix, not the deliverable.

**2. The conformance test with a RESERVED list — ADOPTED, and the "or reserved" half is
essential.**

Assert every `SideEffectClassSchema` and `CapabilityClassSchema` member is either admitted
by ≥1 profile **or** explicitly registered as RESERVED with a stated reason. One test,
all four classes, and every future member.

**The reserved half is not a softening — it is what makes the test correct.** Without it,
the only way to go green is to *grant* the class somewhere, which would force someone to
admit `network_send` or `browser_mutation` purely to satisfy CI. **That converts a
detection test into a privilege-escalation pump** — strictly worse than the defect, and it
is precisely the failure mode of a test that can only be satisfied in the permissive
direction. The audit is right to insist on it.

This is the same construct as §9C's `Record<SideEffectClass, …>` gate with
`'INTENTIONALLY_UNADMITTED'`, arrived at independently by a second reviewer — which I take
as convergent evidence it is the right shape. **They should be built as one artifact, not
two.** The `Record` gives the compile-time exhaustiveness; the conformance test validates
the map against `BUILT_IN_PROFILE_DEFINITIONS` so the map cannot drift into being a second,
lying copy of the truth (§9C's caveat).

Required RESERVED entries on current evidence, each needing a one-line stated reason:
`network_send` (no profile grants messaging; pinned today by the bespoke `declared:69-75`
test, which this subsumes), `browser_mutation` (**RESERVED-BY-DEFECT, not by design — see
below**), capability `send` (same as `network_send`).

**3. Does `browser_mutation` change my reading? YES — decisively, and it settles the
"gap awaiting a decision" vs "systematic failure" question.**

`collab_write` alone was defensible as an unmade decision on a new capability: the class was
minted days ago, in the same commit that fixed V-S2-1, and nobody asked the follow-on
question. Honest oversight, narrow blast radius.

`browser_mutation` is not that. It is an **older, shipped capability with tools routed to
three task types that has never once been exercisable**, and the conjunctive exclusion is
visible in a four-line profile definition. That it survived shows the system has **no
feedback path at all from "declared" to "reachable"** — which is exactly the audit's
root-cause sentence. Combined with `send` being fully plumbed down to unreachable branches
at `profilePolicy.ts:128,177`, the pattern is unmistakable.

**Ruling: this is the systematic reading. The structural fix is NOT optional.** I would not
approve shipping the `agent_conversation` profile alone; it would fix one of four and leave
the mechanism that produced all four fully intact.

**Important scoping caveat I attach to `browser_mutation`:** classify it RESERVED
**-BY-DEFECT**, not RESERVED-by-design, and file it. Do **not** let the conformance test's
introduction become the occasion to grant it — that decision needs its own review with its
own threat model (browser mutation under an unattended profile is a materially larger
question than posting to a channel). Marking it RESERVED records the finding honestly
without silently granting it. Same for the task-routing mismatches the audit found
(`COMPLEX_CODING` routing `filesystem` while `terminal_power` excludes it;
`desktop_commander__write_file` admitted by nothing) — real findings, **out of scope for
this ruling**, file separately. They are the same bug class on the namespace axis rather
than the side-effect axis, which further supports the systematic reading.

**On `grantProfileDelegation` having zero production callers** (all six are tests) and
`c2Broker.ts:81`'s `if (!delegation) return null` being byte-identical to the C2 flag being
off at `dispatch.ts:355` — noted, consistent with the recorded "unenforced-claim" pattern
and with the "wired-to-nothing" class the `pnpm reachability` gate exists to catch. **Out
of scope here; file separately.** It does not bear on the profile decision.

### Net effect

Verdict unchanged: **APPROVE WITH REQUIRED CHANGES.** The `agent_conversation` profile as
shaped in §1 remains correct. What changes is **which deliverable is primary** — §10 item 5
is promoted from "blocking for this fix" to "the point of the work," and the reachability
conformance test + RESERVED registry is added as blocking alongside it.

---

## 10. Summary of required changes to G1D's proposal

**Ordering note (post-§9D):** items 5 and 11 are the PRIMARY deliverable and address the
bug class. Items 1-4 and 6-10 are the instance-level unblock. Shipping the instance without
the class fix is **not approved**.

1. **Add `scopes: { path: 'none', network: 'none' }`** — the shape as proposed does not parse. *(blocking)*
2. **Name it `agent_conversation`.**
3. **Set both `requestedProfile` and `sessionDefaultProfile`** in the dispatcher, else
   `resolveProfile:40-46` throws on every turn. *(blocking — G1D did not identify this)*
4. **Keep `taskType='SUMMARIZATION'`** and comment that it is retained for `TOOL_ROUTING_MAP`
   prefix routing — admission alone does not render the tool. *(blocking)*
5. **Add the loud dispatch-time precondition assertion** (§5A) — the actual lesson. *(blocking)*
6. **Update, do not relax,** the golden fixture, the hardcoded four-name list at
   `declared:19-22`, and the doc table.
7. **Add the two escalation-invariant tests** (§3).
8. **Invert, do not delete, A3-c's assertion 1** (§7). *(blocking for A3-c to mean anything)*
9. **Comment the namespace and approval-requirement rationale** into the definition (§1).
10. **`terminal_power`: explicitly deferred** — file it, do not leave it silent (§4).

11. **Add the reachability conformance test + RESERVED registry** (§9C/§9D, converged): every
    `SideEffectClassSchema` and `CapabilityClassSchema` member is admitted by ≥1 profile
    **or** explicitly RESERVED with a stated reason. Build it as ONE artifact with the
    `Record<SideEffectClass, …>` compile gate, validated against
    `BUILT_IN_PROFILE_DEFINITIONS` so the map cannot drift. Seed RESERVED with
    `network_send`, capability `send`, and `browser_mutation` (**RESERVED-BY-DEFECT**, filed,
    not granted). *(blocking — this is the class fix)*
12. **Force a clean rebuild before any dist-dependent verification** (§9D):
    `rm -rf dist tsconfig.tsbuildinfo` then rebuild. `pnpm build` alone is insufficient in
    this tree and has already produced a phantom profile in `dist/` that would have reported
    this very defect as fixed. Applies to A3-c, which imports from `packages/*/dist/`.

**Risk if shipped without items 3, 4, or 5:** the loop stays broken and the failure remains
silent — a different cause wearing the same costume.

**Risk if shipped without item 11:** one of four dead classes is fixed and the mechanism
that produced all four survives intact, with `browser_mutation` still unexercisable and the
next side-effect class free to be born dead.

---

*G1R (claude-opus-5). Read-only review. No source modified; the one probe edit was reverted
and the tracked tree verified clean (`git status --porcelain -uno` empty, `git diff --stat`
empty). No commits, no pushes. Operator approval required before any of the above lands.*
