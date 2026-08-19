# G1R — Gate 1 Adversarial Design Review, CYCLE 3 — PRD-TCLAW-COLLAB-PRESENCE-UI-005

**Subject:** `docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` (DRAFT **v0.3**, 2026-08-16)
**Prior cycles:**
- `docs/prd-reviews/G1R-OPUS-COLLAB-PRESENCE-UI-005-GATE1.md` (Cycle 1: REJECT, 6 blocking)
- `docs/prd-reviews/G1R-OPUS-COLLAB-PRESENCE-UI-005-GATE1-C2.md` (Cycle 2: REJECT, 0 unresolved + 4 NEW)

**Review date:** 2026-08-16
**Reviewer seat:** G1R (independent design reviewer) — **fresh reviewer, cycle 3**

> **MODEL LINEAGE DISCLOSURE — read before weighting this verdict.**
> The governing profile (`CLAUDE.md` §2) names **Opus 4.7** for this seat historically and
> **Opus 5** (operator-updated 2026-08-12) as current G1R. Opus 4.7 is **not invocable in this
> session**. This review was produced by the session's `opus` alias, which resolves to
> **`claude-opus-5`**. I am filling the **G1R ROLE**; I make no claim to be any other model.
> If the operator requires a specific historical model for lineage purposes, this review does
> not satisfy that requirement.
>
> I am **neither** the cycle-1 nor the cycle-2 reviewer. I read both verdicts as input and
> re-derived every judgment below against the code myself. Where I agree with a prior cycle,
> I say so because I verified it — not because it was asserted.

**Posture:** read-only. This file is the single authorized write. No source file, no PRD, and
no git state was modified. All code claims are quoted from **`HEAD` (`4b0ee58`)** via
`git show`. Working-tree dirtiness is established via `git status --porcelain` (paths only).

---

## VERDICT: **APPROVE**

**Blocking findings: 0** · Non-blocking: 4

All four Cycle-2 blockers are genuinely resolved in the v0.3 text — not renamed, not softened.
I re-derived each against HEAD, including re-verifying the substrate signature that NEW-4
turned on. The whole-document consistency sweep found **no** surviving contradiction of the
§4 rescopes: §6, §8, and §9 now describe the same system §4 describes, and every claim the two
prior cycles killed is dead everywhere in the text, not merely at its original site.

This is the convergence the chain was driving at. The v0.3 edits are not cosmetic compliance:
§8's rewrite in particular converted five prose guarantees into named, falsifiable test
obligations, which is the specific remedy this repo's recorded `unenforced-claim-pattern`
memory exists to force. T-2's byte-identity requirement is the highest-value line in the
document and it is stated correctly.

I record one thing plainly so the operator can weigh it: my sweep found a **real gap** — the
flag-matrix obligation that Cycle 2 explicitly designated as the mechanical pin for its own
NEW-3 fix did not survive §8's renumbering (NB-1 below). I examined it hard, because a
reviewer who finds the one thing that slipped through a renumber is normally looking at a
blocker. It is not one, for reasons I set out in full in NB-1: the half of it that governs
*this PRD's* behavior survives as an evidence-required acceptance criterion in §6 A1, and the
other half is a regression test for code this PRD is **prohibited** from touching. Requiring a
fourth cycle for a test-hardening item on out-of-scope code would be ceremony, not diligence.
I raise it as the first non-blocking item and recommend the Builder be handed it explicitly.

I am not re-litigating any resolved blocker and I did not manufacture disagreement with the
parts that are right. Three of the four non-blocking items below are carried forward from
Cycle 2 unresolved-but-non-material; I re-checked each and none has grown teeth.

---

## 1. Cycle-2 Blocker Resolution Table

Each row re-derived against the v0.3 text and, where the fix asserted a code fact, against
HEAD. "RESOLVED" means the **failure scenario is eliminated**, not that the wording changed.

| # | Cycle-2 blocker | Status | Evidence and reasoning |
|---|---|---|---|
| **NEW-1** | §6 A4/A5 still specified the two behaviors §4 withdrew; two conflicting specs, no precedence rule | **RESOLVED** | Both criteria are rewritten to match the §4 rescopes, and rewritten to the *correct* property rather than merely deleted. **A4** (lines 163-168) now reads: *"store-backed contiguous recovery… the rendered timeline is a contiguous, prefix-consistent sequence of committed events re-read from the durable store via `channel_seq` cursors… **No delivery guarantee is claimed or tested for hint frames.**"* That is the withdrawn claim explicitly negated in the acceptance criterion itself — the strongest available form, because a Builder cannot read A4 and reach branch (1) of Cycle-2's failure scenario (silently absorbing the §19 backpressure item). It also folds Cycle-2's NB-1 contiguity clause, closing the "silently lying about the conversation" gap. **A5** (lines 169-172) now reads: *"a full task lifecycle (submit → run → terminal) produces **ZERO writes to `collab_events`** (DB-provable), and no roster row carries any dispatch affordance."* The word "mirrored" does not appear anywhere in v0.3 — I grepped the whole document. The unsatisfiable criterion is gone, and what replaced it is a *positive, DB-provable* assertion, which is stronger than deletion: it converts the B-5 cut from an absence into an enforced property. Note the second clause ("no roster row carries any dispatch affordance") correctly **retains** the no-dispatch property while dropping its dependence on mirrored rows — that is the precise edit, and G1D made it rather than dropping the clause wholesale. |
| **NEW-2** | §8's required tests unrevised; B-2/B-3/B-4 resolutions entirely unenforced; §8 still mandated the un-falsifiable test | **RESOLVED** | §8 is replaced in full (lines 196-224) by named, non-negotiable **T-1..T-7**, each carrying an explicit "enforces X" mapping to the Gate-1 resolution it pins. Coverage check against Cycle-2's table of unenforced guarantees, item by item: §2a NULL-principal refusal ⇒ **T-1** (*"one test per command"*, terminal `COLLAB_IDENTITY_REQUIRED`); §2a membership scoping / indistinguishability ⇒ **T-2**; S3 idempotent retry ⇒ **T-4**; S4 hint-then-refetch recovery ⇒ **T-6**; S5 zero-writes ⇒ **T-7**. All five gaps closed. **T-2 is stated to the correct standard** and this is the one I checked hardest, because it is the highest-consequence property in the PRD: *"an operator-kind caller who is NOT a member of a hidden channel receives a **byte-identical `COLLAB_NOT_FOUND` payload** to the nonexistent-channel case (**byte equality, not error-code equality**)"*. That matches the substrate's own definition of the property, which I verified at HEAD: `store.ts:96-102` — *"COLLAB_NOT_FOUND is byte-identical across every denial cause — absent, hidden, archived-hidden, non-member, and owner-only-by-non-owner. Fixed message text, retryable:false, so no code path may construct this error with a different message string (**which would create a distinguishing oracle even though the `code` matches**)"*, with `COLLAB_NOT_FOUND_MESSAGE = 'Request could not be completed'`. A code-equality test would not have established the property; T-2 asks for the right assertion. Both stale v0.1 tests are **explicitly deleted on the record** (lines 221-224) with the reason stated per test — deleted, not silently dropped, which leaves an audit trail for G2A. **T-6 additionally carries a negative assertion** — *"contains **no** socket-delivery assertion"* — which forecloses the exact re-entry path Cycle 2 warned about. `pnpm contracts:check` (T-3) verified to exist as a real root script (`package.json:21` at HEAD ⇒ `pnpm --filter @torqclaw/contracts check`; `packages/contracts/package.json:9` defines `check`). |
| **NEW-3** | §9 named `TORQCLAW_COLLAB_ENABLED=0` as the rollback — the flag the narrowing flag exists to stop using | **RESOLVED** | §9 (lines 225-237) names `TORQCLAW_COLLAB_SURFACE_COMMANDS=0` as this PRD's rollback and `NEXT_PUBLIC_COLLAB_UI=0` for the view, then adds a dedicated bolded prohibition: *"**`TORQCLAW_COLLAB_ENABLED=0` is NOT a rollback for this PRD's surface and must never be used as one**"*, with the mechanism cited — *"flag-off returns `authorizeOperator` to the legacy blanket ALLOW (`if (!surface) return ALLOW`), silently dropping the H-1 hardening's live `currentRole()==='operator'` and `holdsAuthority('approve')` checks"* — and correctly assigns the decision (*"a security decision about the C0/C1 identity layer, owned by the operator, outside this PRD"*). I verified the mechanism independently at HEAD: `authz.ts` `authorizeOperator` opens `const surface = ctx.surface; if (!surface) return ALLOW;` under the shipped comment *"When `ctx.surface` is absent -- flag off, or a legacy/root-token connection -- there is no surface authority to intersect, so this resolves to the legacy blanket ALLOW byte-identically"*, and the `APPROVE_TOOL` arm below it is exactly the pair of live checks §9 names (`currentRole() !== 'operator'` ⇒ `DENY_SURFACE_NOT_OPERATOR`; `!holdsAuthority('approve')` ⇒ `DENY_AUTHORITY`). **The PRD's cited mechanism is accurate to the character.** This is the section an operator reads under time pressure, and it now leads them away from the dangerous flag rather than toward it. ⚠️ The *test* Cycle 2 specified to pin this fix did not survive the renumber — see **NB-1**; it does not reopen the blocker, because the blocker was the instruction and the instruction is corrected. |
| **NEW-4** | S3 named the message field `body`; the substrate's field is `text`; the B-3 fix did not typecheck against HEAD | **RESOLVED — verified against HEAD** | §4 S3 (lines 106-108) now specifies *"carrying exactly `{channelId, text, idempotencyKey}` — field name `text` per the substrate's actual contract"* and, unusually and correctly, **quotes the substrate signature inline** as its own justification: `postChannelMessage(caller, { channelId, text }, idempotencyKey)`, `normalizeMessageText(body.text)`. I verified both against HEAD rather than accepting the quotation: `packages/collab/src/store.ts:1422-1428` is `async postChannelMessage(caller: CallerContext, body: { channelId: string; text: string }, idempotencyKey: string)` with `const normalized = normalizeMessageText(body.text);` at :1428, and `normalizeMessageText` is exported from `packages/collab/src/text.ts:110` via `index.ts:6`. The PRD's shape now matches the callee exactly. The §9a B-3 row (line 245) was **also** corrected in the same pass (*"field name corrected per Cycle-2 NEW-4"*), so the wrong identifier does not survive in the resolution record — I checked, because a half-applied rename that leaves the old name in a summary table is the classic way this defect returns. `grep` confirms the token `body` appears in v0.3 only inside the quoted substrate signature (line 108), never as a wire field name. Cycle 2's specific worry — a Builder passing `{channelId, body}` straight through to produce `normalizeMessageText(undefined)` at a layer with no schema left to catch it — is structurally foreclosed. |

**Unresolved Cycle-2 blockers: 0.**

---

## 2. Cycle-1 Blockers — Confirmation Spot-Check

Per my charge I spot-checked rather than re-deriving from scratch, and looked specifically for
regression: an edit made to satisfy a Cycle-2 finding that damaged a Cycle-1 resolution. **None
found.** All six remain resolved.

| # | Cycle-1 blocker | Status | Spot-check |
|---|---|---|---|
| **B-1** | Subjectless reads | **STILL RESOLVED** | §2a (lines 55-72) intact and unedited in substance: substrate subject = resolved collab principal from an authenticated `tq1_` credential; NULL principal ⇒ *"an honest terminal refusal — error code `COLLAB_IDENTITY_REQUIRED`"*; the three-wrong-answers framing still names **refuse** as the specified behavior and forecloses substitute/synthesize. v0.3 **strengthened** this: it is now enforced by T-1, which v0.2 lacked. |
| **B-2** | Hidden-channel indistinguishability | **STILL RESOLVED, now enforced** | §2a's *"applies **unmodified** — there is NO operator bypass, NO seat-level read entitlement, NO principal synthesis"* is unchanged, and T-2 now pins it mechanically. This is the largest net improvement in v0.3. I re-verified the underlying substrate property is membership-only at HEAD (`COLLAB_NOT_FOUND` fixed-message construction, `store.ts:96-105`). |
| **B-3** | S3 wire shape / idempotency | **STILL RESOLVED** | Client-supplied canonical UUID retained with its rationale (retry after dropped socket must not duplicate; text-derived key would collapse two legitimate identical messages); *"The server stamps the author from the connection's resolved principal — the command has no author field to spoof."* Field name now correct (NEW-4). Enforced by T-4, whose second half — *"two posts with identical `text` but distinct keys commit two"* — correctly tests the collapse hazard in the opposite direction. Good test design; I note it approvingly. |
| **B-4** | No-loss overclaim | **STILL RESOLVED** | §4 S4 unchanged in substance (*"invalidation hints only"*, store authoritative, *"v0.1 overclaimed; withdrawn"*, §19 item *"remains owed… not discharged by this slice"*). Now consistent with A4 and T-6 rather than contradicted by them. |
| **B-5** | Mirror = second source of truth | **STILL RESOLVED** | §4 S5 cut intact with both hazards named (uncorrectable second truth in a different DB/WAL; telemetry-to-members disclosure). §5's *"S3 posting is the only new mutation"* (line 147) re-verified true against v0.3's slice set — S1/S2 read, S4 re-reads, S5 is *"Presence only, read-side only."* Now enforced by A5 + T-7. |
| **B-6** | Incomplete dirty-file gate | **STILL RESOLVED** | §7.1 still names all five modified files plus untracked `connectionAuth.ts`. I re-verified against the **current** working tree, not Cycle 2's snapshot: `git status --short` reports ` M` for `contracts/src/commands.ts`, `gateway/src/server.ts`, `gateway/src/authz.ts`, `gateway/src/sessions.ts`, `gateway/src/collabIdentity.ts`, and `??` for `packages/gateway/src/connectionAuth.ts`. **The list is still complete and accurate one day later** — the WIP has not landed, so the §7 gate is still live and still binding. §7.2's extension of the C2 dependency to S1 reads is intact. |

---

## 3. Whole-Document Consistency Sweep

My charge was to sweep the entire document once for surviving contradictions of the §4
rescopes, tests that cannot enforce what they claim, and killed claims that survive elsewhere.
Findings, in the order I ran them:

**3.1 — Killed-claim survival (the Cycle-2 defect class, checked directly).** Cycle 2's whole
verdict was one defect: §4 moved, §6/§8/§9 stayed. So I checked whether v0.3 repeated it in
miniature — a rescope propagated to the primary section but not to a summary table. It did
not. `grep` for the withdrawn vocabulary across all 273 lines:
- `"mirror"` / `"mirrored"` — **0 hits**. The cut is complete; it survives in no AC, no test,
  no resolution row, no §5 line.
- `"no-lost-event"` / any socket-delivery guarantee — appears **only** in line 221's explicit
  deletion record and in A4/T-6's explicit *negations*. There is no site in v0.3 where a
  delivery guarantee is asserted.
- `"body"` as a wire field — **0 hits** outside the quoted substrate signature.
- `TORQCLAW_COLLAB_ENABLED=0` as a rollback — appears only in §9's prohibition and §9a's
  record of that prohibition.

This is the check that would have caught a half-landed fix, and it is clean.

**3.2 — §4 ⇄ §6 ⇄ §8 alignment (all five slices, both directions).** I walked each slice to
its acceptance criterion to its test and back:

| Slice | §4 says | §6 AC | §8 test | Aligned? |
|---|---|---|---|---|
| S1 | read surface, principal subject, deny arms, narrowing flag | A1 | T-1, T-2, T-3, T-5 | **Yes** |
| S2 | read-only view, honest empty states | A2 | T-7 (component tests) | **Yes** |
| S3 | `{channelId, text, idempotencyKey}`, server-stamped author | A3 | T-4 | **Yes** |
| S4 | hints only, store authoritative, coalesced | A4 | T-6 | **Yes** |
| S5 | presence only, read-side only, mirroring cut | A5 | T-7 | **Yes** |

No slice is accepted by a criterion it contradicts; no criterion is enforced by a test that
tests something else. That was the Cycle-2 failure and it is gone in both directions.

**3.3 — Can each test enforce what it claims? (falsifiability, per test).** I checked each
T- item for the Cycle-1 defect that killed the original S4 test — a test that structurally
cannot fail.
- **T-1** — falsifiable; a bypass that substitutes a principal returns data instead of the
  refusal, and the test *"asserted distinct from an empty result"* logic is implied by
  requiring a *terminal refusal* with a named code. **Adequate.**
- **T-2** — falsifiable and correctly specified; byte-equality is exactly the assertion that
  fails when someone adds an `OR kind = 'operator'` arm or a distinguishing message.
- **T-3** — falsifiable (named seat arms; drift gate is a real script, verified).
- **T-4** — falsifiable in both directions (one key ⇒ one row; two keys ⇒ two rows). The
  bidirectional form is what makes it bite.
- **T-5** — falsifiable; dense `channel_seq` makes contiguity arithmetic, per substrate v0.14.
- **T-6** — falsifiable and, critically, **crosses the real transport** (*"sever the socket
  mid-stream, commit events, reconnect"*), which is precisely what the deleted substrate-harness
  test did not do. This directly remedies Cycle 1's un-falsifiability finding.
- **T-7** — falsifiable; *"zero `collab_events` rows"* over a full lifecycle is DB-provable and
  fails the moment anything resurrects a write path.

**No test in §8 is un-falsifiable as specified.** This was the specific thing I was asked to
check and it passes.

**3.4 — §4 S1 ⇄ §9 flag coherence.** S1 gates on `TORQCLAW_COLLAB_SURFACE_COMMANDS` *requiring*
`TORQCLAW_COLLAB_ENABLED`; §9 rolls back via the narrowing flag and prohibits the broad one.
Coherent, and the *"final flag naming is an operator decision"* carve-out in S1 does not
destabilize §9, because §9's binding content is the rollback **semantics**, not the identifier.
One gap in the enforcement of this pairing — **NB-1**.

**3.5 — Internal cross-references resolve.** §9a and the Cycle-2 record table (lines 239-267)
accurately describe what the body now says; I checked each row against its target section
rather than trusting the table. §5's mutation line, §3's non-scope list, and §10's stop
conditions are all consistent with the v0.3 slice set. §7.4's terminology note (substrate
channels vs. SCOPE-PHASE-3 transport channels) is retained and still needed.

**3.6 — Prior-cycle declines, re-audited.** The epoch-anchored-elapsed decline (§9a) was
upheld by Cycle 2 against HEAD. I did not re-derive it; two independent reviewers verifying
the same code fact is sufficient, and A5 depends on it only for the phrase "anchored elapsed",
which is satisfied at HEAD either way. Recorded as inherited, not re-verified by me.

---

## 4. New Blocking Findings

**None.**

I want this stated plainly rather than as an absence, because the honest reviewer failure mode
at cycle 3 is inventing a fourth-cycle finding to look rigorous. I ran the sweep in §3 looking
for one, found the flag-matrix gap, tested whether it was a blocker, and concluded it is not —
reasoning in NB-1 rather than reasoning hidden. The document is clean.

---

## 5. Non-Blocking Findings

### NB-1 (the one that nearly was) — Cycle-2's flag-matrix test did not survive §8's renumber, so §9's corrected rollback rule has no mechanical pin

**Finding.** Cycle 2's NEW-2 specified seven test obligations, and its **T-6** was:
*"Flag matrix: `TORQCLAW_COLLAB_ENABLED=1` with `TORQCLAW_COLLAB_SURFACE_COMMANDS` off ⇒ new
commands absent-denied **and** the H-1 intersection still active (**this is the test that pins
NEW-3's fix**)."* v0.3 rewrote §8 into a differently-numbered T-1..T-7 and this obligation is
not among them. Verified by grep: `H-1`, `holdsAuthority`, `currentRole`, and "flag matrix"
appear nowhere in v0.3's §8, and `holdsAuthority`/`currentRole` appear in the whole document
only at line 235 — inside §9's prose warning. So the NEW-3 correction is, at present, protected
by prose alone. Given that this repo's `unenforced-claim-pattern` memory records four
instances of exactly that, I took this seriously.

**Why it is not blocking.** I split the lost obligation into its two halves and tested each:

1. **"New commands absent-denied when the narrowing flag is off"** — this *did* survive, as
   §6 **A1**: *"flag off ⇒ commands absent-deny."* §6 is titled *"Acceptance criteria (per
   slice, evidence required)"* and is the Builder's completion contract that G2A audits
   against. This half is a live, evidence-required obligation. It is weaker than a named test
   (an AC states the property; a T- item names the artifact), but it is not unenforced.
2. **"The H-1 intersection still active"** — this is a regression assertion about
   `authorizeOperator`, which **this PRD is prohibited from modifying** (Cycle-2 prohibition #5,
   which I carry forward in §8 below). A missing regression test for pre-existing, correct,
   out-of-scope code is a hardening gap in the *repo's* suite, not a defect this PRD
   introduces or can discharge. Blocking a PRD on a test for code it may not touch would be
   scope drift dressed as rigor.

The failure scenario a blocker requires does not close. For harm, a Builder would have to
modify `authorizeOperator` — which §9, prohibition #5, and §7's dirty-file gate all forbid
independently — and the modification would have to survive G2A auditing against A1 and §9's
explicit text. That is three independent controls deep. **Non-blocking.**

**Recommended remedy (cheap, and I recommend it be handed to the Builder as an obligation
even though it is not a gate condition).** Add to §8:

> **T-8.** Flag matrix: with `TORQCLAW_COLLAB_ENABLED=1` and
> `TORQCLAW_COLLAB_SURFACE_COMMANDS` off, every new command is absent-denied **and** the H-1
> intersection remains active (`APPROVE_TOOL` still requires live
> `currentRole()==='operator'` and `holdsAuthority('approve')`) — the regression test that
> pins §9's prohibition on using `TORQCLAW_COLLAB_ENABLED=0` as a rollback.

I endorse T-1..T-7 as written and amend the set only by this addition (see §7).

### NB-2 (carried from Cycle 2, unresolved, still non-material) — the roster is specified twice with two data sources and no label rule

§4 S2 (line 101): *"member roster from real membership rows."* §4 S5 (line 133): *"The roster
shows working agents derived from the gateway's existing task truth."* These remain two
different things — `collab_members` is *membership* (who is in the room); gateway task truth is
*activity* (who is working) — and v0.3 still does not say which element is which or how they
compose. §6 A2's *"zero fabricated fields (no invented presence)"* is the control that will
catch a wrong composition at build time, which is why Cycle 2 declined to block and why I
decline too. Recommend one sentence in S2: the roster renders **membership** as the row set and
overlays a **derived activity state** from task truth, with distinct labels, and no row implies
socket presence. Cheap, and it prevents a Builder from picking one source and shipping a roster
that is honest by A2's letter but misleading in effect.

### NB-3 (carried from Cycle 2, unresolved, confirmed harmless) — `CallerContext.kind` has no stated source

§2a specifies the subject (`principalId`) but never says where `kind` comes from, and T-2 now
says *"operator-kind caller"* without saying how kind is established. I re-checked Cycle 2's
conclusion that this is mechanical rather than a hole, and it holds: the substrate's
security-relevant paths read `principals.kind` **from the DB** (`assertOperatorCaller`,
`assertChannelOwner`), never from the caller struct, so a mis-set `kind` cannot escalate; and
the read paths S1 uses do not consult it at all. Recommend §2a add one clause: `kind` is read
from the `principals` row for the resolved `principalId`, never inferred from the gateway seat.
Non-blocking precisely because the substrate refuses to trust it.

### NB-4 (carried from Cycle 2) — R-3's production reality is still not stated in §7

`WindowsCredentialManagerStore` is a stub that throws `NOT_IMPLEMENTED`; I re-verified the
shipped rationale at HEAD (`collabIdentity.ts` header: *"The real adapter is a stub that throws
NOT_IMPLEMENTED (packages/collab/src/secrets.ts) -- a known, separately-tracked gap… so
production fails CLOSED (AUTH_FAILED, never a crash or a silent bypass) until a real SecretStore
adapter lands"*). Under §2a's subject rule this means **S1 does not function in production until
a real `SecretStore` adapter lands** — every connection resolves to no principal and receives
`COLLAB_IDENTITY_REQUIRED`. The failure is closed and honest, which is why it is not a blocker.
But §7 is the dependencies section and does not say it. Recommend one line, so the behavior is
not discovered at demo time and mistaken for a bug in S1. This is a documentation completeness
item with real operator-experience cost and near-zero fix cost.

---

## 6. Confirmations I Verified Rather Than Inherited

Recorded because they are load-bearing for the Builder packet and because inherited
confirmations decay:

- **The `postChannelMessage` signature at HEAD is exactly as v0.3 quotes it.** `store.ts:1422-1428`.
  The NEW-4 fix typechecks against the real callee.
- **The `COLLAB_NOT_FOUND` byte-identity property is real and is defined at the substrate level
  as byte-identity, not code-identity.** `store.ts:96-105`, fixed message
  `'Request could not be completed'`. T-2's assertion standard is correct, and a weaker test
  would have been a false gate.
- **`authorizeOperator`'s blanket-ALLOW-on-absent-surface is real at HEAD**, and §9's cited
  mechanism is character-accurate (`authz.ts`, `if (!surface) return ALLOW;` plus the
  `APPROVE_TOOL` arm's two live checks). §9's warning is not speculative.
- **`pnpm contracts:check` is a real root script** (`package.json:21`), so T-3's gate reference
  resolves rather than naming a command that does not exist.
- **The §7.1 dirty-file list is still accurate against the current working tree**, one day after
  Cycle 2 verified it. The WIP has not landed; §7's gate is live.
- **The CI-a authority hazard remains closed.** After the S5 cut the only new write is S3;
  nothing in the gateway reads `collab_events`; §2(b) and §3's approval-mirror prohibition are
  preserved verbatim in v0.3. This remains the PRD's strongest work and must not be disturbed.

---

## 7. Required Test Obligations for the Builder (APPROVE-side restatement)

**T-1 through T-7 as written in §8 of the PRD are ENDORSED unamended.** They are correctly
named, correctly mapped to the resolutions they enforce, and each can fail. Reproduced by
reference, not restated, so that §8 remains the single source.

**Amended by exactly one addition:**

- **T-8 (new, per NB-1).** Flag matrix: with `TORQCLAW_COLLAB_ENABLED=1` and
  `TORQCLAW_COLLAB_SURFACE_COMMANDS` off, every new command is absent-denied **and** the H-1
  intersection remains active (`APPROVE_TOOL` still requires live `currentRole()==='operator'`
  and `holdsAuthority('approve')`). This is the regression test that pins §9's prohibition.
  Required of the Builder; **not** a Gate-1 condition (the PRD is approved without it).

**Cross-cutting obligations, binding independent of the T- list:**

1. **Every new test must be able to fail.** For **T-2** and **T-6** specifically, demonstrate
   the failing state before the passing state — the deletion-probe method recorded in this
   repo's GS-COORD memory: *a gate that stays green after you delete the thing it guards is not
   a gate.* T-2 is the one to be most rigorous about; it protects the highest-consequence
   property in the PRD.
2. **T-2's assertion is byte-identity of the two payloads**, not equality of error codes.
   Verified against the substrate's own definition. Code equality does not establish
   indistinguishability.
3. **Authz deny arms for `channel` and `node` on each new command** must be explicit named cases
   per the house pattern in `authz.ts` — not default-deny — so the decision is legible and
   pinned.
4. **Do not satisfy any acceptance criterion by editing the criterion.** If a §6 item proves
   unachievable, stop and report. Post-hoc AC editing is the `unenforced-claim-pattern` defect
   this repo has recorded four times.
5. **`pnpm reachability` and `pnpm contracts:check` green**, non-negotiable given the WIP
   collision and the contract-emit surface.

---

## 8. Approved Implementation Boundaries

This is the **maximum** approved scope. Gate 1 is passed at the **design** level; the §7
operator gate is a separate, still-closed condition and this approval does not open it.

- **Approved now, no dependencies: none.** There is no slice of this PRD independent of the WIP
  (Cycle 1's standalone elapsed-fix carve-out was withdrawn in Cycle 2 as already landed at
  HEAD; I concur — it is not resurrected here).
- **S1** — approved **only after the operator lands the WIP or explicitly authorizes co-editing
  on the §7.1 file list.** As a credential-authenticated, membership-scoped read surface, gated
  behind `TORQCLAW_COLLAB_SURFACE_COMMANDS` requiring `TORQCLAW_COLLAB_ENABLED`. Subject rules
  per §2a: no NULL subject, `COLLAB_IDENTITY_REQUIRED` on unresolved principal.
- **S2** — approved after S1 lands green. Read-only. Resolve **NB-2**'s roster source/label rule
  in the PRD text before building the roster.
- **S3** — approved after S1. Wire shape exactly `{channelId, text, idempotencyKey}`;
  `idempotencyKey` contract-validated as a canonical lowercase UUID; author field absent.
- **S4** — approved after S1/S2. Hint-then-refetch **only**, with coalescing per §4 S4 (one
  in-flight re-read per channel; further hints mark dirty for exactly one follow-up).
- **S5** — approved after S2. Presence-only, read-side only, zero channel writes.
- Each slice ships as a **separate commit** whose revert restores the prior gate-green state,
  per §9.

---

## 9. Prohibited Changes

Binding on the Builder regardless of any later authorization. Items 1-11 carry forward from
Cycles 1 and 2 unchanged — I re-derived them against v0.3 and they remain correct and
necessary. I add none; adding prohibitions at an approving cycle without a failure scenario
would be ceremony.

1. **No widening of substrate visibility for any seat, kind, or role.** No `OR kind = 'operator'`
   arm in `assertChannelVisible`, no operator bypass in `listChannels`, no second query path
   that skips `collab_members`.
2. **No synthetic `CallerContext`.** `principalId` comes from the server-derived connection
   binding, or the command is refused with `COLLAB_IDENTITY_REQUIRED`. Never from a gateway
   role, a frame field, a config default, or "the single operator principal."
3. **No new `ClientCommandSchema` field that is an authorization input.** `channelId`, `text`,
   and `idempotencyKey` are permitted (none confers entitlement; `channelId` is re-checked
   against membership server-side). `principalId`, `surfaceId`, `authorPrincipalId`, or any
   seat/role field is prohibited.
4. **No approval affordance, mirror, reaction, or command-parse anywhere in a channel timeline**,
   in the wire surface or the UI (frozen operator ruling 2026-08-08; PRD §3).
5. **No modification of `authorizeOperator`'s H-1 intersection** to accommodate a new command.
   New commands earn explicit arms; the intersection is not relaxed. (NB-1 makes this
   prohibition load-bearing until T-8 exists — observe it strictly.)
6. **No editing of any WIP-dirty file** until the operator lands the migration or explicitly
   authorizes co-editing on the §7.1 list.
7. **No second execution/event/receipt/approval state machine.**
8. **No weakening or deletion of the substrate's existing tests** to accommodate the bridge.
9. **No resurrection of S5 lifecycle mirroring** under any framing — including "just for the
   roster", "read-only mirror", or "denormalized cache." Reinstating it requires its own PRD
   with a rebuild story, per §4 S5's own terms.
10. **No delivery guarantee may be asserted for the publishOnly hint transport** — in code
    comments, PRD text, acceptance criteria, or commit messages. The store is the source of
    truth; the hint is advisory. §19's real-socket backpressure item stays owed.
11. **No use of `TORQCLAW_COLLAB_ENABLED=0` as this PRD's rollback path**, and no text anywhere
    that presents it as one.

---

## 10. Accepted Residual Risks

Accepted as conditions of this APPROVE — recorded, not waived.

- **R-1.** `collab.db` and `state.db` have separate WALs; no cross-database atomicity is claimed
  or possible. **Closed by scope** in v0.3: with S5's mirroring cut, no slice writes across
  both. Recorded as closed-by-scope, not solved — it returns if mirroring ever does.
- **R-2.** Substrate §7.4's accepted metadata visibility: `channel_seq` is dense, so a current
  member can derive the **count** — never content — of events committed during a removal window.
  Pre-existing and accepted in v0.14. This PRD's read surface exposes it to a human eye for the
  first time, and A4's contiguity requirement makes density legible **by design**. Accepted;
  recorded so the UI implies no stronger guarantee than the substrate provides.
- **R-3.** `WindowsCredentialManagerStore` is a stub throwing `NOT_IMPLEMENTED` (verified at
  HEAD). Under §2a, **S1 does not function in production until a real `SecretStore` adapter
  lands** — every connection fails closed to `COLLAB_IDENTITY_REQUIRED`. Accepted: the failure
  is closed and honest. See **NB-4** — §7 should say so.
- **R-4.** Slice-3's C3 no-gap property was verified structurally against an in-process
  sequencer. v0.3 correctly declines to inherit it as a socket guarantee. Accepted as scoped.
- **R-5.** Read-amplification under hint-then-refetch. **Materially reduced** in v0.3 by the
  adopted coalescing rule (§4 S4), but not bounded by a stated limit. Accepted for a
  loopback-first, small-N deployment; recorded so it is not inherited as a scaling property.
- **R-6.** The flag-matrix regression test gap (**NB-1**) is accepted for Gate 1 and assigned to
  the Builder as **T-8**. Until T-8 exists, §9's rollback rule and prohibition #5 are enforced
  by document and review rather than by suite.
- **R-7.** This is a design review of committed state (`HEAD` `4b0ee58`) plus a declared WIP
  dependency. I did not execute the test suite, boot the gateway, or read the content of the
  uncommitted working-tree diff — dirtiness was established by `git status --porcelain` on paths
  only. Every code claim is quoted from HEAD and verifiable by `git show`. **Conclusions about
  the WIP's content are deliberately absent**, and this approval is therefore of the design, not
  of any implementation.

---

## 11. Handoff

**Verdict: APPROVE.** Zero blocking findings. Gate 1 passes at cycle 3.

All four Cycle-2 blockers are resolved in substance, and the two that mattered most are
resolved *better* than the minimum: §6's A4/A5 negate the withdrawn claims explicitly rather
than merely omitting them, and §8's T-1..T-7 convert five prose guarantees into falsifiable
test obligations — which is the structural remedy for this repo's most-recorded defect class.
The NEW-4 field name typechecks against the real substrate signature at HEAD, and it was fixed
in the resolution table as well as the slice body.

The consistency sweep is clean: no killed claim survives anywhere in the document, all five
slices align §4 ⇄ §6 ⇄ §8 in both directions, and no test in §8 is un-falsifiable as specified.

Four non-blocking items go forward with the Builder packet — **NB-1** (add T-8, the flag-matrix
regression test) is the one I would hand over first, and prohibition #5 should be treated as
load-bearing until it exists. **NB-2** (roster source/label rule) should be resolved in the PRD
text before S2 is built. **NB-3** and **NB-4** are one-line documentation completeness items.

**This approval does not open the §7 operator gate.** The WIP on the five dirty files plus
untracked `connectionAuth.ts` has not landed — I re-verified against the current tree — and no
code slice may begin until the operator lands it or explicitly authorizes co-editing. The
operator stop conditions in §10 of the PRD remain in force: WIP co-edit authorization, any §11-004
open decision an S-slice touches, push/merge/release of any slice, and enabling either flag in
a deployment.

Recommended next step: G1D updates the PRD to v0.4 with T-8 and the three documentation items
(NB-2/NB-3/NB-4) — none requiring another G1R cycle — and takes the §7 gate to the operator.

---

*G1R Cycle 3 · reviewer seat filled by `claude-opus-5` (lineage disclosed above) · read-only ·
this file is the single authorized write · all code claims quoted from HEAD `4b0ee58`.*
