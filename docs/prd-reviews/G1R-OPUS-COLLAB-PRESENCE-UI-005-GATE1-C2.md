# G1R — Gate 1 Adversarial Design Review, CYCLE 2 — PRD-TCLAW-COLLAB-PRESENCE-UI-005

**Subject:** `docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` (DRAFT **v0.2**, 2026-08-16)
**Prior cycle:** `docs/prd-reviews/G1R-OPUS-COLLAB-PRESENCE-UI-005-GATE1.md` (REJECT, 6 blocking)
**Review date:** 2026-08-16
**Reviewer seat:** G1R (independent design reviewer) — **fresh reviewer, cycle 2**

> **MODEL LINEAGE DISCLOSURE — read before weighting this verdict.**
> The governing profile (`CLAUDE.md` §2) names **Opus 4.7** (historical) for this seat and
> **Opus 5** (operator-updated 2026-08-12) as current G1R. Opus 4.7 is **not invocable in
> this session**. This review was produced by the session's `opus` alias, which resolves to
> **`claude-opus-5`**. I am filling the **G1R ROLE**; I make no claim to be any other model.
> If the operator requires a specific historical model for lineage purposes, this review does
> not satisfy that requirement.
>
> I am **not** the cycle-1 reviewer. I read the cycle-1 verdict as input and re-derived every
> judgment below against the code myself. Where I agree with cycle 1, I say so because I
> verified it — not because it was asserted.

**Posture:** read-only. This file is the single authorized write. No source file, no PRD, no
git state was modified. All code claims are quoted from **`HEAD` (`4b0ee58`)** via `git show`.
Working-tree dirtiness is established via `git status --porcelain` (paths only, no content read).

---

## VERDICT: **REJECT**

**Blocking findings: 4** (0 unresolved from cycle 1 · **4 new**) · Non-blocking: 5

Let me be precise about what this verdict is and is not, because the distinction matters for
the operator's next decision.

**All six cycle-1 blockers are genuinely resolved.** I re-derived each against HEAD and none
is a rename-without-remedy. §2a's two-lattice model is the correct architectural answer to
B-1/B-2 — it is, in fact, a *better* formulation than the correction cycle 1 asked for,
because it names the lattice confusion as the shared root rather than patching two symptoms.
B-4's rescope to hint-then-refetch is the right engineering call and honestly withdraws an
overclaim. B-5's cut is the right call and I endorse it. This is a substantially improved PRD
and the direction is not in question.

**It is rejected for a single, systematic, mechanical defect: §4 was revised and §6, §8, and
§9 were not.** The v0.2 slice bodies now describe a different system than the PRD's own
acceptance criteria, required tests, and rollback procedure describe. Three of my four
blocking findings are instances of that one drift. In a governed chain where §6 is the
Builder's completion contract and §8 is the test obligation, a §4 that disagrees with them is
not a documentation nit — it is two conflicting specifications handed to a Builder with no
rule for which wins. The fourth finding is a field-name error in the B-3 fix that would fail
at the substrate boundary.

Every one of these is a text edit. I expect v0.3 to approve. I am **not** re-litigating any
resolved blocker, and I am not manufacturing disagreement with the parts that are right.

---

## 1. Controlling Invariant — independent derivation

v0.2 §2 adopts cycle 1's formulation verbatim. I derive independently and arrive at the same
sentence, which I therefore endorse rather than restate as a novelty:

> **A co-presence surface may render only what its own authenticated subject is already
> entitled to see, write only what that subject may write, and never become a path by which
> either entitlement is computed, widened, or acted upon.**

**Is it complete for the revised slices?** This was an explicit question in my charge, and the
answer is **yes, with one gap that is not the invariant's fault.**

The invariant's four clauses (a) gateway sole execution authority, (b) `approve` reserved,
(c) identity server-derived, (d) message-is-data — plus §2a's lattice split — cover S1, S2,
S3, and S5 completely. I traced each revised slice against it:

- **S1/S2 (read):** covered by §2a's subject rule + the untouched membership predicate. I
  verified the predicate is genuinely untouched-able as specified — see B-2 evidence below.
- **S3 (write):** covered by (c) + (d). The server-stamps-author rule is structurally
  enforced by the substrate (`actorPrincipalId` comes from `caller.principalId`, HEAD
  store.ts:1470-ish, never from `body`), so the contract cannot express a spoof.
- **S5 (presence, post-cut):** covered by (a) and (d) trivially — after the mirroring cut,
  S5 writes nothing at all. The cut *shrinks* S5 inside the invariant rather than needing new
  invariant coverage. This is the clean way to resolve B-5 and I endorse it.

**The one gap:** the invariant governs *entitlement*, and S4's rescope introduced a property
that is not an entitlement property — **completeness of what is rendered**. Hint-then-refetch
makes the store authoritative, which is correct, but a console that renders a *non-contiguous*
cursor range is not violating anyone's entitlement; it is silently lying about the
conversation. §2 as written does not forbid that, and neither does §6. This is not a defect
in the invariant — it is a missing companion clause, and I record it as **NB-1** with a
concrete cheap remedy rather than inflating it into a blocker, because the substrate makes
detection arithmetic (`channel_seq` is dense).

---

## 2. Cycle-1 Blocker Resolution Table

Each row re-derived against HEAD. "RESOLVED" means the *failure scenario* is eliminated, not
that the wording changed.

| # | Cycle-1 blocker | Status | Evidence and reasoning |
|---|---|---|---|
| **B-1** | S1 has no authenticated subject to read as | **RESOLVED** | §2a names the subject normatively: substrate calls take the connection's resolved collab principal as `CallerContext`, established at CONNECT from an authenticated `tq1_` credential. Critically, it **picks one** of the three wrong-answer options and names it: *"Of B-1's three wrong answers (refuse / substitute / synthesize), **refuse is the specified behavior**"*, with a concrete error code `COLLAB_IDENTITY_REQUIRED`. It also explicitly forecloses the other two ("NO operator bypass, NO seat-level read entitlement, NO principal synthesis"). Verified the underlying facts still hold at HEAD: `CallerContext` is `{principalId, kind}` (`store.ts:318`) with the shipped comment *"established by the (not-yet-built) session layer"*; `sessions.ts:65-68` inserts `caller?.principalId ?? null`. The Builder now has exactly one instruction, and it fails closed. **This is a real resolution, not a rename.** |
| **B-2** | "operator seat reads everything" breaks hidden-channel indistinguishability | **RESOLVED** | §2a: *"Substrate visibility scoping (membership JOINs, byte-identical `COLLAB_NOT_FOUND` hidden-channel denial) applies **unmodified**"*. I re-verified the property is membership-only and not kind-sensitive at HEAD: `listChannels` (store.ts:1720-1735) joins `collab_members ... WHERE m.principal_id = ? AND m.state = 'active'` with no `kind` arm; `assertChannelVisible` (store.ts:2032) reads `collab_members` for the caller's own row and consults `principals.kind` **not at all**; by contrast `assertOperatorCaller` (store.ts:1966) and `assertChannelOwner` (store.ts:2005) *do* check `kind` — and they gate administration, not reads. The deliberate separation cycle 1 described is real. §2a's prohibition binds the Builder away from the attractive wrong answer. **Resolved at the design level.** ⚠️ But see **NEW-2**: the *test* that would catch a regression here was never added to §8, so the resolution is unenforced. |
| **B-3** | S3 wire shape cannot call the substrate write path; idempotency key missing | **RESOLVED in substance, DEFECTIVE in detail** — see **NEW-4** | The substantive fix is correct and I endorse it: §4 S3 now carries `idempotencyKey` as a **client-supplied canonical UUID**, with the right rationale stated (a retry after a dropped socket must not commit a duplicate; a text-derived key would collapse two legitimate identical messages). That is precisely the correct reading, and the PRD correctly notes the key confers no authority so accepting it from the client is safe. **However** the field name is wrong: v0.2 specifies `{channelId, body, idempotencyKey}`; the substrate signature is `postChannelMessage(caller, body: { channelId: string; **text**: string }, idempotencyKey)` (HEAD store.ts:1422-1428, and `normalizeMessageText(body.text)` at :1428). Cycle 1's required correction said `{channelId, **text**, idempotencyKey}`. Counting the blocker itself RESOLVED and raising the naming error separately as NEW-4, because the reasoning is right and only the identifier is wrong. |
| **B-4** | S4's "no-lost-event" acceptance unachievable on the chosen transport | **RESOLVED in §4, CONTRADICTED in §6/§8** — see **NEW-1** | §4 S4's rescope is the right answer and is honestly argued. It correctly states the two facts I re-verified: `publishOnly` frames omit `seq` entirely and are never INSERTed (`events.ts` `publishOnly`, HEAD — *"The built event OMITS seq entirely"*), and the console only advances its resume cursor on `ev.seq != null` (`useGatewayStream.ts:54`), so a publishOnly frame is structurally unreplayable; and `DeliverySink` models write-initiation with *"real backpressure/completion coupling is OWED to Slice 5 (M3)"* (`subscriptions.ts:102-104`). The rescope resolves this by making the durable store the source of truth and **explicitly withdrawing the overclaim** (*"v0.1 overclaimed; withdrawn"*) and explicitly **not** discharging the §19 item. That is exactly the intellectual honesty cycle 1 asked for. **But §6 A4 still demands the withdrawn property verbatim, and §8 still mandates the un-falsifiable test.** The blocker is resolved in the slice and re-opened in the acceptance criteria. |
| **B-5** | S5 mirror = second source of truth + telemetry disclosure | **RESOLVED in §4, CONTRADICTED in §6/§8** — see **NEW-1** | §4 S5 **cuts** the mirroring outright, with correct reasoning on both hazards cycle 1 named (uncorrectable second truth in a different DB/WAL; telemetry-to-members disclosure) and correctly restores §5's "S3 is the only new mutation" to truth. Deferral-with-a-rebuild-story is the right disposition and I endorse it over cycle 1's alternative (b). I verified §5's mutation line is now accurate: after the cut, no v0.2 slice writes to `collab_events` except S3. **But §6 A5 still requires testing "its mirrored lifecycle events" and §8 still mandates the "S5 no-dispatch-surface structural test"** for a feature that no longer exists. |
| **B-6** | §7.1 dirty-file gate materially incomplete | **RESOLVED — verified against the live tree** | §7.1 now names all five: `commands.ts`, `server.ts`, `authz.ts`, `sessions.ts`, `collabIdentity.ts`, plus the untracked `connectionAuth.ts`. I verified against `git status --porcelain` on exactly those paths: all five report ` M`, `connectionAuth.ts` reports `??`. The list is complete and accurate. §7.2 correctly extends the C2 dependency to S1 reads (*"The C2 connect-path governs S1 reads too, not just S3"*), closing the second half. §7.1's rule and §10's stop conditions are correctly stated. Minor: `tests/connection-auth.test.ts` (also `??`) is unnamed, but the module is named and the rule is file-class-general — non-material, recorded as NB-5. |

**Unresolved cycle-1 blockers: 0.** I want that on the record plainly. G1D did the work.

---

## 3. NEW Blocking Findings

### NEW-1 (HIGH) — §6 acceptance criteria still specify the two behaviors §4 withdrew; the PRD contains two conflicting specifications and no precedence rule

**Finding.** The v0.2 rescopes changed §4 and left §6 untouched. Verbatim at v0.2:

```
§4 S4:  "live frames are **invalidation hints only** ... No-loss holds because the store
         is authoritative ... not because the socket promises delivery. The real-socket
         backpressure item **remains owed to §19** and is not discharged by this slice
         (v0.1 overclaimed; withdrawn)."

§6 A4:  "live delivery beats polling (event arrives without refresh); backlog→live
         transition loses no committed event (substrate C3 semantics exercised over a
         real socket)."          <-- the withdrawn claim, still an acceptance criterion
```

```
§4 S5:  "The v0.1 lifecycle-event *mirroring* into channels is **CUT** ... If narrative
         mirroring is ever wanted, it gets its own PRD with a rebuild story."

§6 A5:  "a running task appears in the roster with anchored elapsed; its **mirrored
         lifecycle events** carry no dispatch surface (grep-provable: no onClick/command
         affordance in **mirrored rows**)."     <-- tests the cut feature
```

**Failure scenario (concrete, and it is the bad one).** A Builder implements §4 S4 correctly —
hint-then-refetch, store authoritative, no delivery promise. They then reach §6, the
completion contract, and find A4 requires proving "backlog→live transition loses no committed
event ... over a real socket." Two branches, both bad:

1. The Builder treats §6 as controlling (the ordinary reading — §6 is titled *"Acceptance
   criteria (per slice, evidence required)"* and §8 is titled *"Required tests"*; §4 is a
   slice description). They build the socket-delivery guarantee anyway — which is the §19
   owed backpressure item, which §4 S4 explicitly says is **not** in scope. The slice silently
   absorbs an owed §19 line item, un-reviewed, against a `DeliverySink` that HEAD documents as
   write-initiated-only. That is exactly the overclaim B-4 was raised to prevent, re-entering
   through the acceptance door.
2. The Builder treats §4 as controlling and writes A4 off. They now ship a slice whose stated
   acceptance criterion is knowingly false, and G2A — which audits against ACs — has no honest
   basis to pass it. The gate jams, or worse, someone edits the AC post-hoc to match what was
   built, which is the "unenforced-claim" defect class this repo has recorded four times.

A5 is the same shape but sharper: it requires a grep-provable test over "mirrored rows" that
**cannot exist**, because §4 cut the code that would produce them. A Builder cannot satisfy
A5 by any means. Either they resurrect the mirroring (reopening B-5 in full, including the
telemetry-to-agent-principal disclosure path), or A5 is unsatisfiable and the slice cannot
close.

**Violated invariant.** Repo core invariant 9 (*"Do not fabricate ... completion state"*) —
an acceptance criterion that cannot be met, or that contradicts the slice it accepts, makes
honest completion reporting impossible. Also `CLAUDE.md` §7: *"Confirm every completion claim
against actual file diffs, command output, logs, or tests."* Also this repo's recorded
**unenforced-claim pattern**, in its mirror image: here the claim is *over*-enforced by a
stale criterion.

**Required correction.** Rewrite §6 A4 and A5 to match the v0.2 slices. Normatively:

> **A4 (S4, corrected):** a committed channel event becomes visible in the console without a
> manual refresh (hint arrives ⇒ console refetches via the S1 cursor path). On reconnect
> after a socket kill, the console re-reads from the durable store and the rendered
> `channel_seq` range is **contiguous** and includes every event committed during the outage.
> The property under test is *store-backed recovery*, **not** socket delivery. A4 explicitly
> does **not** assert any delivery guarantee and does **not** discharge §19's real-socket
> backpressure item.
>
> **A5 (S5, corrected):** a running task appears in the roster with epoch-anchored elapsed,
> derived at render time from gateway task truth. No channel write occurs for any task
> lifecycle transition (assertable: zero new `collab_events` rows during a task's full
> lifecycle with the Channels view open). The mirroring clause is **deleted**, not softened.

---

### NEW-2 (HIGH) — §8's required tests were not revised either; the resolutions of B-2, B-3, and B-4 are entirely unenforced, and §8 still mandates the test cycle 1 called un-falsifiable

**Finding.** §8 is unchanged from v0.1 in full:

```
§8 (v0.2, verbatim): "Authz deny arms (channel/node x new commands); contract emit + drift
gate; timeline cursor paging against a live store; honest-empty states (component tests); S3
round-trip integration; S4 no-lost-event transition test (substrate harness reuse); S5
no-dispatch-surface structural test."
```

Cross-referencing against what v0.2 now claims to guarantee:

| v0.2 guarantee | Test in §8? |
|---|---|
| §2a — NULL principal ⇒ `COLLAB_IDENTITY_REQUIRED` refusal (the B-1 resolution) | **None** |
| §2a — membership scoping unmodified; byte-identical `COLLAB_NOT_FOUND` (the B-2 resolution) | **None.** §8's "authz deny arms" tests the *gateway seat* lattice; §2a's whole point is that this is the *other* lattice |
| S3 — idempotent retry returns the same `{eventId, cursor}`, exactly one row (the B-3 resolution) | **None.** "S3 round-trip integration" tests one post, not a retry |
| S4 — hint-then-refetch, contiguous recovery (the B-4 resolution) | **Wrong test.** §8 mandates "S4 no-lost-event transition test (**substrate harness reuse**)" — the exact test cycle 1 identified as un-falsifiable, and which now tests a property §4 withdrew |
| S5 — no channel writes (the B-5 resolution) | **Wrong test.** "S5 no-dispatch-surface structural test" tests the cut feature |

**Failure scenario.** This is the failure mode with the worst signature, because it is
*silent* and *passes*. A Builder implements §4 faithfully and runs §8. Every §8 test that can
run, passes. The suite is green. G2A audits against §8 and finds the required tests present
and passing. The slice ships.

Nothing in that green suite asserts that an operator-kind principal who is not a member of
channel X gets X omitted from `LIST_CHANNELS` and a byte-identical `COLLAB_NOT_FOUND` from
`GET_CHANNEL_TIMELINE`. So the highest-consequence property in this PRD — the G2A-verified
hidden-channel indistinguishability that B-2 exists to protect — is protected **only by
prose in §2a**. The first refactor that touches the read path, or the first Builder who adds
an `OR` arm to make a demo non-empty, silently destroys it, and the suite stays green. This
repo's own `reachability-gate` and `unenforced-claim-pattern` memory entries describe exactly
this defect class: a correct decision with no mechanical enforcement is a decision that will
be reverted by accident.

Note the compounding: because §8 also still mandates the **substrate-harness** S4 test, the
one test in §8 that touches recovery is the one that structurally cannot fail on the real
transport, since it never crosses it. A green §8 is therefore actively misleading about S4.

**Violated invariant.** Repo core invariant 9; `CLAUDE.md` §6 (*"Never remove or weaken tests
to make a build pass"* — its intent applies equally to never *specifying* a test too weak to
bite); the recorded unenforced-claim pattern.

**Required correction.** §8 must gain, as named, non-negotiable obligations:

> - **T-1 (enforces B-1/§2a).** A connection with `sessions.principal_id IS NULL` (legacy
>   root-token operator, both flags ON) receives `COLLAB_IDENTITY_REQUIRED` on `LIST_CHANNELS`
>   and `GET_CHANNEL_TIMELINE` — a **refusal**, asserted distinct from an empty result.
> - **T-2 (enforces B-2 — the highest-value test in this suite).** Substrate visibility
>   parity: given an **operator-kind** principal that is not a member of channel X,
>   `LIST_CHANNELS` omits X and `GET_CHANNEL_TIMELINE(X)` returns the **byte-identical**
>   payload returned for a channel that does not exist. Assert byte-identity, not error-code
>   equality — the property is indistinguishability, and code equality does not establish it.
> - **T-3 (enforces B-3).** Idempotent retry: the same `POST_CHANNEL_MESSAGE` with the same
>   `idempotencyKey` sent twice returns the identical `{eventId, cursor}` and leaves exactly
>   one `collab_events` row.
> - **T-4 (replaces the withdrawn S4 test).** Real-socket recovery: kill the WS mid-stream
>   between two committed channel events, reconnect, assert the console renders **both** via
>   the store refetch path and that the rendered `channel_seq` range is contiguous. Must be
>   able to fail. Delete "S4 no-lost-event transition test (substrate harness reuse)".
> - **T-5 (replaces the cut S5 test).** Zero-write assertion: a full task lifecycle with the
>   Channels view open commits **no** new `collab_events` row. Delete "S5 no-dispatch-surface
>   structural test".
> - **T-6.** Flag matrix: `TORQCLAW_COLLAB_ENABLED=1` with `TORQCLAW_COLLAB_SURFACE_COMMANDS`
>   off ⇒ new commands absent-denied **and** the H-1 intersection still active (this is the
>   test that pins NEW-3's fix).
> - **T-7.** Contract emit + drift gate (`pnpm --filter @torqclaw/contracts check`) and
>   `pnpm reachability` — already house rule, non-negotiable given the WIP collision.

---

### NEW-3 (MEDIUM-HIGH) — §9 Rollback still instructs the operator to roll back via the flag the narrowing flag was introduced to stop using; the adopted NB-2 fix is half-landed

**Finding.** v0.2 §4 S1 adopts cycle 1's non-blocking flag finding and introduces a dedicated
narrowing flag, correctly reasoned:

```
§4 S1: "Gated on a **dedicated narrowing flag** `TORQCLAW_COLLAB_SURFACE_COMMANDS` that
requires `TORQCLAW_COLLAB_ENABLED` — so turning the read surface off never reverts the
C0/C1 identity hardening"
```

§9 was not updated and still says:

```
§9: "`TORQCLAW_COLLAB_ENABLED=0` removes the wire surface; `NEXT_PUBLIC_COLLAB_UI=0`
removes the view; both default off."
```

`TORQCLAW_COLLAB_SURFACE_COMMANDS` appears exactly once in the whole document (line 93). §9
— the section an operator reads *while backing out a problem, under time pressure* — names
only the broad flag.

**Failure scenario.** The Channels view misbehaves in a soak. The operator opens §9, the
rollback section, and does what it says: `TORQCLAW_COLLAB_ENABLED=0`. The Channels view goes
away — and so does C0/C1 identity resolution and, with it, the H-1 operator-authority
subordination. I verified the mechanism at HEAD: `authorizeOperator` (`authz.ts`) begins
`const surface = ctx.surface; if (!surface) return ALLOW;` with the shipped comment *"When
`ctx.surface` is absent -- flag off, or a legacy/root-token connection -- there is no surface
authority to intersect, so this resolves to the legacy blanket ALLOW"*. So flipping
`TORQCLAW_COLLAB_ENABLED` off returns `APPROVE_TOOL` to blanket operator ALLOW, dropping both
the `surface.currentRole() === 'operator'` check and the live `holdsAuthority('approve')`
check. **Rolling back a UI feature silently re-opens a landed security hardening**, and §9 is
the document that told the operator to do it. The narrowing flag exists precisely to prevent
this and §9 does not mention it.

**Violated invariant.** `CLAUDE.md` §4 tool-approval discipline (the H-1 intersection is an
approval-path control and must not be relaxed as a side effect); the frozen 2026-08-08 ruling
subordinating the operator short-circuit.

**Required correction.** §9 becomes:

> `TORQCLAW_COLLAB_SURFACE_COMMANDS=0` removes the wire surface and is **the correct rollback
> for this PRD**. `NEXT_PUBLIC_COLLAB_UI=0` removes the view. `TORQCLAW_COLLAB_ENABLED=0` is
> **not** a rollback for this PRD's surface: it additionally reverts C0/C1 identity resolution
> and the H-1 operator-authority intersection (`authorizeOperator` returns to blanket ALLOW
> when `ctx.surface` is absent), i.e. it re-opens a landed security hardening. Do not use it
> to back out a Channels-view problem.

Pinned by NEW-2's T-6. Final flag *naming* remains an operator decision per §4 S1; the
*rollback semantics* above are not discretionary.

---

### NEW-4 (MEDIUM) — S3's corrected wire shape names the message field `body`, but the substrate's field is `text`; the B-3 fix does not typecheck against HEAD

**Finding.** §4 S3 and the §9a resolution row both specify:

```
"POST_CHANNEL_MESSAGE carrying exactly `{channelId, body, idempotencyKey}`"
```

The substrate at HEAD:

```ts
// HEAD:packages/collab/src/store.ts:1422-1428
async postChannelMessage(
  caller: CallerContext,
  body: { channelId: string; text: string },
  idempotencyKey: string
): Promise<PostChannelMessageResult> {
  const normalized = normalizeMessageText(body.text);
```

`body` is the name of the **wrapper object**; the message field inside it is `text`, and
`normalizeMessageText(body.text)` is what consumes it. A wire shape whose payload field is
literally named `body` collides with the substrate's parameter name and does not supply
`text`. Cycle 1's required correction said `{ channelId, text, idempotencyKey }`; v0.2
substituted `body`.

**Failure scenario.** The Builder writes the Zod contract with `body: z.string()`, per the
PRD's "carrying **exactly**" wording. The gateway handler calls
`store.postChannelMessage(caller, { channelId, text: cmd.body }, cmd.idempotencyKey)` — which
works, but now the wire vocabulary and the substrate vocabulary disagree for no reason, in a
`ClientCommandSchema` that is the contract source of truth and is emitted to JSON Schema for
the Python boundary. Worse, a Builder reading "carrying exactly `{channelId, body, ...}`"
literally may pass `{ channelId, body }` straight through, producing `body.text === undefined`
⇒ `normalizeMessageText(undefined)` at a layer with no schema left to catch it. This is a
small defect with a real edge, and it is one word to fix.

Note this is **not** a re-litigation of B-3. B-3's substance — client-supplied canonical UUID
idempotency key, author absent from the wire — is correct and I endorse it.

**Violated invariant.** Repo core invariant 1 (every external frame is contract-validated) —
a contract whose field name does not correspond to the field the callee reads is validating
the wrong thing. `CLAUDE.md` §3: `packages/contracts` is the source of truth and must stay
aligned with the boundary.

**Required correction.** S3's shape becomes `{ channelId, text, idempotencyKey }` in §4 and in
the §9a B-3 row. `idempotencyKey` is contract-validated as a canonical lowercase UUID. Author
field stays absent.

---

## 4. Non-Blocking Findings

**NB-1 — the invariant's missing companion clause: contiguity.** Covered in §1 above. S4's
rescope makes the store authoritative (correct) but nothing in §2 or §6 forbids rendering a
*non-contiguous* timeline. A console showing seqs 1-4 and 9-11 with no indication of the gap
is not violating entitlement — it is silently misrepresenting the conversation, which the
honesty rules were written to prevent. `channel_seq` is dense (substrate v0.14 §7.4), so a gap
is detectable by arithmetic at zero cost. Recommend §2 gain a fifth clause — *a rendered
timeline is either contiguous or visibly marked as gapped* — and A4 assert it (already folded
into NEW-1's corrected A4). Non-blocking because NEW-1's correction naturally carries it.

**NB-2 — the roster is now specified twice, with two different data sources and no label
rule.** §4 S2: *"member roster from real membership rows."* §4 S5: *"The roster shows working
agents derived from the gateway's existing task truth."* These are different things —
`collab_members` is *membership* (who is in the room), gateway task truth is *activity* (who
is working). §6 A2 forbids "invented presence." A roster that renders membership rows under a
"present" label is fabricated presence by A2's own standard; a roster that renders only active
agents omits idle members. Neither §4 S2 nor §4 S5 says which element is which, or how they
compose. Recommend one sentence: the roster renders **membership** as the row set and overlays
a **derived activity state** from task truth, with distinct labels, and no row implies socket
presence (the substrate's live presence signal is the in-memory, non-persisted
`SubscriptionRegistry`, which this PRD does not read). Non-blocking: it is a UI specification
gap that A2's honesty bar will catch at build time, not a security or integrity defect.

**NB-3 — hint-then-refetch has a real read-amplification profile that the PRD should bound.**
S4's rescope is correct, but I traced its cost honestly: `fanoutToChannel` (HEAD
`fanout.ts:246-254`) iterates candidate subscriptions and delivers per-subscriber, so one
committed message produces N hints, each of which triggers a `GET_CHANNEL_TIMELINE` refetch —
N reads per write instead of N pushes. On this deployment the practical blast radius is small:
TorqClaw is loopback-first, N is realistically small, and `getChannelTimeline` is a read-only
SQLite query behind `withReadOnly` with a `limit` bounded to 1-100 (store.ts). So I am **not**
raising this as a blocker and I decline to inflate it. But a busy channel with several
connected surfaces will do measurably more DB work than v0.1's push design, and the cheap
mitigation is one line: **coalesce hints — a refetch already in flight absorbs subsequent
hints for the same channel, and hints are debounced (a small fixed window) before a refetch
is issued.** Recommend §4 S4 state it so a Builder does not implement refetch-per-hint.

**NB-4 — `CallerContext.kind` has no stated source, and the gateway binding does not carry
it.** `CallerContext` is `{ principalId, kind: 'operator' | 'agent' }` (store.ts:318), but the
gateway's `PrincipalBinding` is `{ principalId, surfaceId }` only (`principalBridge.ts`) — no
`kind`. §2a specifies the subject but never says where `kind` comes from. I checked whether
this is a security hazard and it is **not**: the read paths S1 uses (`listChannels`,
`assertChannelVisible`) do not consult `caller.kind` at all, and the paths that care about
operator-ness (`assertOperatorCaller` store.ts:1966, `assertChannelOwner` store.ts:2005) read
`principals.kind` **from the DB**, never from the caller struct — so a mis-set `kind` cannot
escalate. It is a mechanical gap, not a hole. Recommend §2a add: `kind` is read from the
`principals` row for the resolved `principalId`, never inferred from the gateway seat.
Non-blocking precisely because the substrate refuses to trust it.

**NB-5 — §7.1 omits `tests/connection-auth.test.ts`.** Verified `??` in the working tree
alongside `connectionAuth.ts`. §7.1 names the module and states a file-class-general rule, so
the gate is not defeated. One-word addition for completeness. Non-material.

**Confirmations I am recording explicitly, because they are load-bearing and I verified them
rather than inheriting them:**

- **The CI-a authority hazard remains genuinely closed in v0.2.** I re-traced it. After S5's
  mirroring cut, the only new write is S3, which commits a `message_posted` row into
  `collab_events` and returns; nothing in the gateway reads `collab_events`;
  `ClientCommandSchema` is a closed discriminated union so a message body is never parsed as a
  command; `APPROVE_TOOL` reads its tool name server-side; and `authorizeOperator`'s H-1
  intersection additionally requires `surface.currentRole() === 'operator'` **and** a live
  `holdsAuthority('approve')`. §2(b) and §3's prohibition of approval mirrors should be
  preserved verbatim. **This is still the PRD's strongest work.**
- **G1D's declined non-blocking finding is correct, and I checked rather than deferring.**
  §9a declines extracting an epoch-anchored-elapsed fix on the grounds that the console's
  elapsed surfaces are already epoch-anchored. Verified at HEAD:
  `LiveDuration.tsx` — *"Elapsed-time ticker anchored to a REAL start timestamp (epoch ms),
  never a mount counter ... a mid-task remount ... jumps to wall-clock instead of resetting to
  0:00"*; and `presence.ts` `selectActiveTurnStartMs` — *"The anchor is a property of the task
  — NOT of the console mount."* The gap cycle 1 flagged does not exist at HEAD. **The decline
  is honest and correctly reasoned**, and I am recording that a decline was audited and upheld.
- **`COLLAB_IDENTITY_REQUIRED` does not meaningfully leak collab-enabled state.** I was asked
  to test this hypothesis and it does not survive. The refusal is only reachable by a
  connection that has already authenticated an operator seat with a valid root token — not an
  unauthenticated party — and collab-enabled state is already inferable from CONNECT-path
  behavior at HEAD. I decline to raise it. It would be manufactured disagreement.
- **The S5 render-time join does not put task-truth queries on a hot render path.** Also asked,
  also does not survive contact. The console's task truth is already in memory as
  `GatewayEvent[]`, and `presence.ts` selectors are pure in-memory folds over that array with
  no I/O. A render-time join is an array traversal, not a query. Declined.

---

## 5. Required Test Obligations for the Builder

§8 as corrected by **NEW-2** (T-1 through T-7) is the binding list; it is reproduced there and
not duplicated here. In addition, and independent of the §8 rewrite:

1. Every new test must be able to **fail**. For T-2 and T-4 specifically, demonstrate the
   failing state before the passing state (the deletion-probe method recorded in this repo's
   GS-COORD memory: a gate that stays green after you delete the thing it guards is not a gate).
2. T-2's assertion is **byte-identity** of the two `COLLAB_NOT_FOUND` payloads, not equality of
   error codes. Code equality does not establish indistinguishability; the substrate's own
   comment at store.ts:96-102 defines the property as byte-identical across every denial cause.
3. Authz deny arms for `channel` and `node` on each new command, per the house pattern in
   `authz.ts` (explicit named case, not default-deny) so the decision is legible and pinned.
4. Do not satisfy any acceptance criterion by editing the criterion. If a corrected §6 item
   proves unachievable, stop and report — do not adjust the AC to match what was built.

---

## 6. Approved Implementation Boundaries

Binding if the operator overrides this REJECT and authorizes partial work. This is the
**maximum** approved scope.

- **Approved now, no dependencies:** none. Cycle 1's standalone elapsed-fix carve-out is
  **withdrawn** — verified already landed at HEAD (NB-4 confirmations above). There is no
  longer any slice of this PRD that is independent of the WIP.
- **Approved only after (i) the operator lands the WIP or explicitly authorizes co-editing on
  the §7.1 list, and (ii) §6/§8/§9 are corrected per NEW-1/NEW-2/NEW-3:** S1 as a
  credential-authenticated, membership-scoped read surface, gated behind
  `TORQCLAW_COLLAB_SURFACE_COMMANDS` requiring `TORQCLAW_COLLAB_ENABLED`. Not before either
  condition.
- **Approved after S1 lands green:** S2, read-only, with NB-1's gap indicator and NB-2's roster
  source/label rule resolved in the PRD text first.
- **Approved after NEW-4's field rename:** S3.
- **Approved after NEW-1's A4 rewrite and NEW-2's T-4:** S4, as hint-then-refetch only, with
  NB-3's coalescing rule stated.
- **Approved after NEW-1's A5 rewrite:** S5, presence-only, read-side only.

---

## 7. Prohibited Changes

Binding on the Builder regardless of any later authorization. Items 1-8 are carried forward
from cycle 1 unchanged — they were correct and v0.2 does not disturb them — with 9-11 added.

1. **No widening of substrate visibility for any seat, kind, or role.** No `OR kind =
   'operator'` arm in `assertChannelVisible`, no operator bypass in `listChannels`, no second
   query path that skips `collab_members`.
2. **No synthetic `CallerContext`.** `principalId` comes from the server-derived connection
   binding or the command is refused with `COLLAB_IDENTITY_REQUIRED`. Never from a gateway
   role, never from a frame field, never from a config default, never from "the single
   operator principal."
3. **No new `ClientCommandSchema` field that is an authorization input.** `channelId`,
   `text`, and `idempotencyKey` are permitted (none confers entitlement — `channelId` is
   re-checked against membership server-side). A `principalId`, `surfaceId`,
   `authorPrincipalId`, or any seat/role field is prohibited.
4. **No approval affordance, mirror, reaction, or command-parse anywhere in a channel
   timeline**, in the wire surface or the UI (frozen operator ruling 2026-08-08; PRD §3).
5. **No modification of `authorizeOperator`'s H-1 intersection** to accommodate a new command.
   New commands earn explicit arms; the intersection is not relaxed.
6. **No editing of any WIP-dirty file** until the operator lands the migration or explicitly
   authorizes co-editing on the §7.1 list.
7. **No second execution/event/receipt/approval state machine.**
8. **No weakening or deletion of the substrate's existing tests** to accommodate the bridge.
9. **No resurrection of S5 lifecycle mirroring** under any framing (including "just for the
   roster", "read-only mirror", or "denormalized cache"). §4 S5 cut it; reinstating it requires
   its own PRD with a rebuild story, per §4 S5's own terms.
10. **No delivery guarantee may be asserted for the publishOnly hint transport**, in code
    comments, PRD text, acceptance criteria, or commit messages. The store is the source of
    truth; the hint is advisory. §19's real-socket backpressure item stays owed.
11. **No use of `TORQCLAW_COLLAB_ENABLED=0` as this PRD's rollback path**, and no §9 text that
    presents it as one (NEW-3).

---

## 8. Accepted Residual Risks

Accepted **if** the corrections above are made — not waived.

- **R-1.** `collab.db` and `state.db` have separate WALs; no cross-database atomicity is
  claimed or possible. **Materially reduced by v0.2**: with S5's mirroring cut, no v0.2 slice
  writes across both, so the divergence hazard cycle 1 accepted under a reconciliation rule
  no longer arises. Recorded as closed-by-scope, not as solved.
- **R-2.** Substrate §7.4's accepted metadata visibility: `channel_seq` is dense, so a current
  member can derive the **count** — never content — of events committed during a removal
  window. Pre-existing and accepted in v0.14. This PRD's read surface exposes it to a human
  eye for the first time, changing its practical (not formal) significance. Compounded
  slightly by NB-1's contiguity indicator, which makes density legible by design. Accepted;
  recorded so the UI implies no stronger guarantee.
- **R-3.** `WindowsCredentialManagerStore` is still a stub that throws `NOT_IMPLEMENTED`
  (`collabIdentity.ts` header, verified at HEAD; §19 owed list). With §2a's subject rule, S1
  therefore does not function in production until a real `SecretStore` adapter lands — every
  connection resolves to no principal and receives `COLLAB_IDENTITY_REQUIRED`. Accepted: the
  failure is **closed** and honest. But §7 should state it, so the gap is not discovered at
  demo time and mistaken for a bug in S1.
- **R-4.** Slice-3's C3 no-gap property was verified structurally against an in-process
  sequencer. v0.2 no longer inherits it as a socket guarantee — S4's rescope correctly
  declines to. Accepted as scoped work.
- **R-5.** Read-amplification under hint-then-refetch (NB-3), unbounded as currently written.
  Accepted for a loopback-first, small-N deployment; recorded so it is not inherited as a
  scaling property.
- **R-6.** This is a design review of committed state (`HEAD` `4b0ee58`) plus a declared WIP
  dependency. I did not execute the test suite, boot the gateway, or read the content of the
  uncommitted working-tree diff — dirtiness was established by `git status --porcelain` on
  paths only. Every code claim is quoted from HEAD and verifiable by `git show`. Conclusions
  about the WIP's *content* are deliberately absent.

---

## 9. Handoff

**Verdict: REJECT.** Four blocking findings, all new, all text edits, none architectural.

The architecture cleared this cycle. §2a is the right model, correctly derived to the shared
root of B-1 and B-2. B-4's withdrawal and B-5's cut are the honest engineering calls, made for
the stated reasons. B-6 is complete against the live tree. G1D resolved all six.

What did not clear is that **§4 moved and §6, §8, and §9 stayed put.** NEW-1 (§6 accepts two
withdrawn behaviors), NEW-2 (§8 enforces none of the four resolutions and mandates one wrong
test), and NEW-3 (§9 names the dangerous rollback flag) are one defect wearing three hats: the
revision was applied to the slice descriptions and not propagated to the three sections that
turn a slice description into an obligation. NEW-4 is a one-word field-name error in an
otherwise-correct B-3 fix.

There is a lesson here worth stating for the next revision, because it will recur: in this
chain, §4 says what will be built, but **§6 is what the Builder must prove and §8 is what
G2A audits.** A resolution that lives only in §4 is a resolution with no enforcement surface —
which is this repo's recorded unenforced-claim pattern, arriving on schedule. Propagate every
§4 change into §6, §8, and §9 in the same edit.

Return path: G1D revises to v0.3 addressing NEW-1 through NEW-4 (and, cheaply, NB-1 through
NB-5 while in the file), then re-review. **I expect v0.3 to approve.** The corrections are
mechanical, the direction is right, the invariant is complete once NB-1's contiguity clause
lands, and the two highest-consequence properties — execution-authority isolation and
hidden-channel indistinguishability — are structurally sound in design and need only the tests
that NEW-2 specifies to make them stay that way.

No file other than this one was created or modified.
