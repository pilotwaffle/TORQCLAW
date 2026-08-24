# G1R — INDEPENDENT DESIGN REVIEW — PRD-TCLAW-COLLAB-PRESENCE-UI-005 v0.5 amendment (A6 / T-9)

## VERDICT: **REJECT** — 3 blocking, 5 non-blocking. The amendment is genuinely additive and its core is sound; it is rejected on three wording defects that make it evadable, not on its premise.

**Seat:** G1R (independent design reviewer; reviews non-trivial design/risk before build).
**Model — No-False-Delegation record:** the session routing profile seats G1R = **Claude Opus 5**.
I **am** `claude-opus-5`. **No substitution applies and none is claimed.** This is a stronger record
than G1R Cycles 1–3 on this same PRD, which disclosed `claude-opus-5` filling an Opus-4.7-named seat.
**Review date:** 2026-08-16
**Branch:** `phase1-server-owned-authority` · **HEAD:** `b418e87`
**Reviewed:** the **uncommitted working-tree amendment** to `docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md`
(v0.4 → v0.5), adding **A6** (§6), **T-9** (§8), and **§9b** (amendment record).
**Authored by:** G1D — the same seat that authored the PRD, which is why this review exists.
**Posture:** read-only on every tracked file. Zero edits to the PRD. No commits, no pushes. Three
temporary comparison scripts were written to the session scratchpad (outside the repo) and no
untracked operator file at repo root (`.png`/`.md`/`.log`/`.bak`) was read, moved, or touched.

---

## 0. The decision in one paragraph

A6/T-9 is the **right criterion**, derived from a real defect rather than speculation, and its
central insight — part 2, residue enumeration — is the part that actually closes CO-4 and is
something I would not have expected G1D to get right. The amendment is also **strictly additive**;
I proved that mechanically rather than accepting the claim, and the claim is true to the byte.

I nevertheless return **REJECT**, on three defects that are each a one-to-three-line fix:

1. **B-1 — the falsifiability obligation cites a standard that does not exist.** T-9 says its
   revert-observe-RED probe is "the same standard as T-2/T-6." I read T-2 and T-6: **neither
   carries any falsifiability, mutation, or revert obligation.** The only existing mutation-probe
   discipline in this program lives in G2A verdict documents, not in the PRD. A Builder who reads
   T-2/T-6 to calibrate "the same standard" will correctly conclude the standard is *no probe at
   all*. This is the unenforced-claim pattern reproduced **inside the criterion written to cure the
   unenforced-claim pattern**.
2. **B-2 — A6(a) rests on "narrowest," which a Builder can satisfy by assertion.** As written, the
   pre-fix `z.string().min(1)` is defensible as "narrowest" under a bad-faith or merely lazy
   reading, and A6 supplies no mechanical test to contradict it.
3. **B-3 — T-9's four parts are individually required but the matrix never requires the union to be
   exhaustive**, and part 3's enumeration is scoped to "each handler," which does not reach the
   dispatch arm in `server.ts` where the return value is consumed. A slice can produce four green
   parts and still ship a process-killer.

Every one of these is fixable in the amendment's own idiom. **None requires touching A1–A5 or
T-1–T-8.** With the three fixes applied I would approve without a further cycle.

---

## 1. Obligation (1) — ADDITIVE-ONLY VERIFICATION. **VERIFIED, mechanically, not accepted.**

I did not take the §9b "additive-only proof" row on trust. Three independent checks:

**Check 1 — the deletion audit.** `git diff --numstat` reports **68 insertions / 1 deletion**.
`git diff -U0 | grep '^-[^-]' | cat -A` returns **exactly one line**, in full:

```
-**Status:** v0.4 — **GATE 1 APPROVED (design)** at G1R Cycle 3 (`GATE1-C3.md`, APPROVE, 0 blocking,
 4 non-blocking folded into this version). **Implementation remains closed behind the §7 operator
 gate** — no code slice may begin until the operator lands the auth-migration WIP or explicitly
 authorizes co-editing its files.
```

That is the v0.4 status header and nothing else. **The claim is exact.**

**Check 2 — section-level byte comparison.** I extracted `HEAD:docs/PRD-…-005.md`, split both
versions on `^## ` headings, and compared each section body byte-for-byte:

| Section | Result |
|---|---|
| `__PREAMBLE__` (status header) | **DIFF** — expected; 1198 → 1423 ch |
| §0 Research finding | **SAME** (1796 ch) |
| §1 Objective | **SAME** (450) |
| §2 Controlling invariant (**contains §2a**, a `###` subsection) | **SAME** (2032) |
| §3 Non-scope | **SAME** (641) |
| §4 Slices | **SAME** (3679) |
| §5 Authority & state contract | **SAME** (556) |
| §6 Acceptance criteria | **DIFF** — 1530 → 3020 |
| §7 Dependencies / operator gate | **SAME** (1640) |
| §8 Required tests | **DIFF** — 2639 → 5189 |
| §9 Rollback | **SAME** (726) |
| §9a G1D resolution record | **SAME** (2381) |
| §10 Operator stop conditions | **SAME** (173) |
| §9b Amendment record | **NEW SECTION** |

**§2a is inside §2 and §2 is byte-identical**, so the §2a indistinguishability rules A6(c) invokes
are untouched — I checked this specifically because A6(c) *references* §2a and a subtle rewording
there would be exactly the defect class.

**Check 3 — per-criterion identity inside the two changed sections.** Section-level SAME/DIFF is
not enough for §6 and §8, since a criterion could be reworded while the section grows. I split both
sections into top-level bullets and tested each old bullet for verbatim presence in the new:

- **§6:** 6 old bullets → all 6 **PRESENT-IDENTICAL** (A1, A2, A3, A4, A5, and the shared `Gate:`
  row). One new bullet: **A6**.
- **§8:** 8 old bullets → all 8 **PRESENT-IDENTICAL** (T-1 … T-8). One new bullet: **T-9**.

And a line-level survival sweep over §6 and §8 — every non-blank line of the old section tested for
verbatim presence in the new — returns **`(none)`** for both: *not one old line was reworded,
re-indented, or dropped.* The trailing prose in §8 (the "v0.1 tests deleted" note, the roster-label
rule, the CallerContext.kind rule) survives verbatim; the new material is inserted **above** it, so
the deleted-test note still reads correctly.

**FINDING (1): the amendment is strictly additive. No acceptance criterion was edited to fit an
implementation. The repo's most-recorded defect class is not present here.** This obligation is
discharged, and the §9b "additive-only proof" row is accurate as written.

*One process note, non-blocking (NB-1 below): §9b instructs the reader to "verify with `git diff`."
Once this is committed, `git diff` will be empty and the instruction becomes dead. It should name
the commit range or this review.*

---

## 2. Obligation (2) — WOULD A6/T-9 HAVE CAUGHT D-1? **YES — but only because of part 2, and only if B-1/B-2 are fixed.**

This is the central question, so I walked the **pre-fix** code (`df49276`) clause by clause rather
than reasoning from the amendment's own narrative.

### 2.1 The pre-fix state, established from source

- **Contract** (`git show df49276:packages/contracts/src/commands.ts`, the `GET_CHANNEL_TIMELINE`
  member): `cursor: z.string().min(1).default('0')` — no grammar.
- **Substrate** (`df49276:packages/collab/src/store.ts`, `parseCursor`): **two** throws —
  `!/^(0|[1-9][0-9]*)$/.test(cursor)` → `CollabError('INVALID_REQUEST', …)`, and then
  `!Number.isSafeInteger(n) || n < 0` → a second `CollabError('INVALID_REQUEST', …)`.
- **Handler** (`df49276:packages/gateway/src/collabSurface.ts:165-170`): `handleGetChannelTimeline`
  catches **only** `err?.code === 'COLLAB_NOT_FOUND'` and ends `throw err;` at `:169`.
  `handleListChannels` (`:112-130`) has **no try/catch at all**.
- **Net** (`packages/gateway/src/server.ts:186-192`): `socket.on('message', async (raw) => {…})`
  wraps only `JSON.parse`. I re-grepped `packages/` and `ops/` for `unhandledRejection` /
  `uncaughtException`: **zero hits**, confirming the G2A finding at present HEAD.

### 2.2 Clause-by-clause: is D-1 forced out?

| Clause | Applied to the pre-fix code | Would it FORCE the finding? |
|---|---|---|
| **A6(a)** "contract constrains each free-form field to the narrowest grammar the consuming layer accepts" | `cursor` is free-form; the consuming layer accepts `^(0\|[1-9][0-9]*)$`; `.min(1)` is not that. | **Yes in substance — but see B-2.** "Narrowest" is a judgement word with no mechanical test attached. A Builder who never opens `parseCursor` has no clause telling them they must. |
| **A6(b)** "no input the contract still admits can cause the handler to throw" | Post-regex, `"9"×21` is still admitted and still throws. | **Yes — this is the load-bearing clause of A6.** It is stated over *inputs the contract admits*, not over "malformed inputs," which is the correct and non-evadable framing. |
| **A6(c)** "no new distinguishing signal on any indistinguishability-protected path" | The new `COLLAB_INVALID_REQUEST` arm could have become a membership oracle. | Yes for the regression it targets; it is a guard on the *fix*, not a detector of D-1. Correct to include. |
| **T-9 part 1** contract-boundary rejection, **against the emitted artifact** | Would have forced a test that `"abc"` is rejected → the `.min(1)` gap surfaces immediately. | **Yes — catches the contract half of D-1.** The "parse the built artifact" instruction is correct and load-bearing (§4.2). |
| **T-9 part 2** residue enumeration | Forces the Builder to read `parseCursor` end-to-end and enumerate what the *regex still lets through*: the `Number.isSafeInteger` branch. **Then** requires each such input to "resolve to a structured error" — which fails against `throw err;` at `:169`. | **YES. This is the clause that closes D-1 completely, and it is the only one that does.** |
| **T-9 part 3** throw-class totality | Drives each handler with a domain error carrying *some other code*, a plain `Error`, and non-`Error` throws. Against pre-fix `handleGetChannelTimeline`, the "other code" case hits `throw err;` → **rejected promise → assertion fails**. Against `handleListChannels`, *every* class escapes. | **YES — and independently of part 2.** Part 3 alone kills the pre-fix handler. |
| **T-9 part 4** no new oracle | A guard on the fix, not a detector. | N/A for detection; correct to include. |

### 2.3 The finding

**A Builder honestly applying T-9 could not have shipped D-1.** Two independent parts catch it:

- **Part 3 is the blunt instrument.** It requires a rejected promise to be a test failure. Pre-fix
  `handleListChannels` has no catch whatsoever, so *the very first* throw-class probe goes red. This
  works even for a Builder who never understands *why* the cursor is dangerous.
- **Part 2 is the precise instrument, and the one that earns the amendment its existence.** It is
  the clause that encodes the re-audit's most valuable finding — that the contract regex **alone**
  would not have closed D-1, because `"9".repeat(21)` has no leading zero, satisfies
  `^(0|[1-9][0-9]*)$`, passes the contract, and then dies on `Number.isSafeInteger`. Part 2's
  sentence *"A grammar constraint that mirrors a downstream validator is **not equivalent to
  it**"* is the single most important line in the amendment. Without part 2, a Builder could
  discharge parts 1/3/4, ship the regex, believe the contract now covers the field, and leave the
  21-digit residue live behind a handler nobody widened.

I looked hard for a way to satisfy all four parts while still shipping D-1 and **could not
construct one against the pre-fix code**, provided part 3 is read as written ("Assert every case
**resolves**; a rejected promise is a failure"). That phrasing is unambiguous and mechanically
checkable. Credit where due: this is a criterion written *from measured evidence*, and §9b's
"Applies to" row is right that S1's own remediation is what made it writable.

**But see B-3:** the totality it proves is scoped to the handler function, and the handler function
is not the whole of what runs inside the unprotected async socket handler.

---

## 3. Obligation (3) — FALSIFIABLE AND ENFORCEABLE, OR ASPIRATIONAL PROSE?

Mixed. T-9's four parts are mostly mechanically gradeable; A6's prose and the falsifiability
obligation are not.

### 3.1 What IS mechanically checkable (good)

| Clause | Grader's mechanical test |
|---|---|
| T-9 p1 | Does a test file import the schema and assert `safeParse(...).success === false` for named malformed values and `=== true` for valid ones **plus the default**? Binary. |
| T-9 p2 "**Name, in the test**, every input the contract still admits that the consuming layer rejects by throwing" | The words "name, in the test" turn this from an intention into an artifact a reviewer can point at. Strong drafting. |
| T-9 p3 | The four throw-classes are **enumerated by name** (expected code / other code / plain `Error` / string, `null`, `undefined`, number), and the pass condition is stated as `.resolves`. Fully binary. |
| T-9 p4 | "Unclassified failures must return a **detail-free** generic code" — checkable by reading the generic arm. "a caller-supplied value echoed back is acceptable, server state is not" is a real, applicable rule. |
| A6(b) | Follows from p2 + p3. |
| A6 "graded per slice and never inherited from a prior slice" | Explicitly forecloses the CO-3 failure mode (inheriting a PARTIAL as green). Excellent. |
| T-9 "A slice adding no wire command declares T-9 not-applicable **and says so explicitly**" | Forces S2 to produce a sentence rather than silence. Correct — silence is how obligations evaporate. |

### 3.2 What is NOT mechanically checkable (the blockers)

**A6(a) "the narrowest grammar the consuming layer accepts."** There is no test a reviewer can run
against a Builder's assertion that their grammar is narrowest. Worse, the pre-fix `.min(1)` is
*arguably* narrowest under a Builder who never located `parseCursor` — the criterion contains no
instruction to go find the consuming validator. The clause states a conclusion and omits the
procedure. **B-2.**

**"Falsifiability obligation (same standard as T-2/T-6)."** I read T-2 and T-6 in full:

> **T-2 …** substrate visibility parity — an operator-kind caller who is NOT a member of a hidden
> channel receives a **byte-identical `COLLAB_NOT_FOUND` payload** to the nonexistent-channel case
> (byte equality, not error-code equality) …

> **T-6 …** hint-then-refetch recovery — sever the socket mid-stream, commit events, reconnect: the
> re-read renders the contiguous committed sequence. Asserts store-backed recovery only …

**Neither contains any falsifiability, mutation, revert, or RED-probe obligation.** I grepped the
whole PRD for `falsifiab|mutation|revert`: the only hits outside T-9 itself are §4's "S3 is the only
new mutation" (a different sense of the word), §9's rollback prose, and §8's note that a *deleted*
v0.1 test "was un-falsifiable as specified." **The standard T-9 invokes does not exist in this
document.** The mutation-probe discipline that does exist lives in G2A verdict files (M-1/M-2/M-3 in
the re-audit) — i.e. in the *audit* layer, downstream of the Builder, in documents the Builder is
not obliged to have read.

This is not pedantry. The reference is the *only* thing defining how rigorous the probe must be, and
a Builder who follows it lands on "no probe required." **This is the unenforced-claim pattern —
the repo's recurring defect, and the exact pathology A6 was written to cure — reproduced inside the
cure.** That is why it is blocking rather than cosmetic. **B-1.**

**"total on every input its contract admits."** "Total" is a load-bearing word used without
definition. It happens to be salvaged by A6(b)'s gloss ("every failure resolves to a structured
error frame, never an exception") and by T-9 p3's `.resolves` rule — so I do **not** raise it as a
blocker. Note for the record that the re-audit's **CO-9** (a thrown object whose `code` getter
itself throws) is a real, acknowledged exception to the word "total"; see §5.5.

---

## 4. Obligation (4) — OVER-REACH AND COST. **Proportionate. One part will be faked.**

### 4.1 Blast radius is correctly bounded

A6/T-9 are scoped to "**EVERY slice that adds or changes a wire command**." Against §4: **S1** (done,
explicitly not re-graded), **S3** (`POST_CHANNEL_MESSAGE` — a *write* with a free-form `text` field
and a client-supplied UUID `idempotencyKey`, i.e. exactly two more free-form fields feeding
substrate validators that throw). **S2, S4, S5 add no wire command** and declare not-applicable in
one sentence. So the real cost is **one slice: S3.** That is not ceremony; that is one matrix on the
single highest-risk slice remaining. **Not over-reach.**

And S3 is precisely where it is needed. `normalizeMessageText(body.text)` and the idempotency-key
path are both substrate validators reached from a free-form wire field — the identical shape as
`cursor`, with a mutation behind it instead of a SELECT.

### 4.2 "Parse the compiled/emitted schema, not the Zod source" — **correct and practical. Keep it.**

This is the strongest instruction in T-9 and I want it on the record as endorsed, because it will
look like pedantry to a Builder in a hurry.

- **Correct:** `vitest.config.ts:8-16` aliases `@torqclaw/contracts` to `packages/contracts/dist`.
  A test that mutates only `src/commands.ts` observes a stale `dist` and goes **falsely green** —
  the `verify-the-artifact-not-the-unit-test` trap in project memory, and the exact reason the
  re-audit's M-3 probe had to rebuild `dist` before it would bite.
- **Practical:** zero extra cost. The alias already resolves to `dist`, so an ordinary
  `import { ClientCommandSchema } from '@torqclaw/contracts'` **is** parsing the emitted artifact.
  `tests/collab-surface.test.ts:418-431` already does exactly this. The instruction costs a Builder
  nothing; it only forbids a specific shortcut.

**Latent hazard worth naming (NB-2):** `vitest.config.ts:14` flips that alias to **source** when
`TORQCLAW_PROFILE_CONFORMANCE_SOURCE_CONTRACTS=1`. I grepped the repo: that variable is set nowhere
(single hit, the config line itself), so it is inert today. But a future suite that exports it would
silently convert every T-9 part-1 test into a Zod-source test while staying green — defeating the
instruction by environment rather than by code.

### 4.3 The falsifiability obligation — **this is the part that will be faked.** (Feeds B-1.)

"Each part must be shown able to fail — revert the guard, observe RED, restore, observe GREEN" is
**four mutation probes per command**, and for part 1 the revert additionally requires
`pnpm --filter @torqclaw/contracts build`, plus restoring **three** files (the source and both
checked-in generated copies, which the build script rewrites) and rebuilding again. The re-audit
documents that exact dance for M-3. For S3, times four parts.

I do not think that is unreasonable *work*. I think it is unreasonable **unverifiably**: a Builder
who skips it and writes "probes run, all RED then GREEN" in their evidence file is indistinguishable
from one who did it, because the obligation specifies no artifact. Compare the parts that *are*
enforceable — p2's "**Name, in the test**" and p3's named throw-classes both leave a durable artifact
in the test file. The falsifiability obligation leaves nothing but a sentence.

Combined with B-1 (the cited standard doesn't exist), this clause is currently the weakest link in
an otherwise strong criterion: maximum ceremony, minimum verifiability, and a dangling reference
that reads as licence to do nothing.

**This does not mean drop it.** It means make it produce an artifact and cite a standard that exists.
See the suggested fix under B-1.

---

## 5. Obligation (5) — GAPS THE AMENDMENT STILL LEAVES

I take the six shapes named in the brief in turn, and rule each **absorb now** or **out of scope**.

### 5.1 Synchronous throws vs rejected promises — **COVERED.**

T-9 p3 says "Assert every case **resolves**; a rejected promise is a failure." A synchronous throw
from an `async` function produces a rejected promise, so both shapes fail the same assertion. No gap.

### 5.2 Throws from code paths reached AFTER the handler returns — **PARTIALLY COVERED. Absorb now (B-3).**

This is the real residual and it is not hypothetical. Read the dispatch arm,
`packages/gateway/src/server.ts:599-617`:

```js
const listErr = await handleListChannels(sid, connectionAuth?.principalId ?? null, cmd.data.limit);
if (listErr) sendErr(listErr.code, listErr.detail);
break;
```

`sendErr` (`server.ts:183-184`) is `socket.send(JSON.stringify({ type:'ERROR', code, detail }))` —
**outside** the handler's try/catch and inside the unprotected `async socket.on('message')`.
`JSON.stringify` throws on a circular structure or a `BigInt`, and `socket.send` throws on a
closed/erroring socket. Today `detail` is only ever `err.message` (a string) so it is safe — but A6
is written as a claim about *the handler*, and a Builder can make the handler perfectly total while
the arm that consumes its return value is not.

`publishOnly` is the near-miss that proves the point. `events.ts:116` is
`GatewayEventSchema.parse(built)` — a **throwing** validator, invoked on `metadata` built from store
rows. Today it sits *inside* both handlers' try/catch, so it is netted. Nothing in A6/T-9 requires
it to stay there; a refactor moving publication into the dispatch arm — a natural thing to do for
S3 — silently reopens D-1's exact shape with all four T-9 parts still green.

**Absorb now.** The cost is one sentence, and this is the highest-value gap remaining.

### 5.3 Resource exhaustion rather than throws — **correctly OUT OF SCOPE, but say so.**

A6 is a *totality* criterion, not a *resource* criterion. A grammatically valid 100 000-character
`text` in S3, or an unbounded result set, is a different failure mode (memory/latency) requiring a
different control (length caps, `limit` clamps). The prior G2A audit already confirmed the existing
`limit` is clamped at two layers and frame size is bounded at 64 KiB by the substrate encoder.

Stretching A6 to cover exhaustion would blur a criterion whose strength is its sharp binary pass
condition. **Correctly out of scope** — but the *rationale* note should say so explicitly, so a
future reader does not mistake A6's silence for coverage, and so S3's free-form `text` gets its
length bound from somewhere. **NB-3.**

### 5.4 Commands whose handler is total but whose DISPATCH arm is not — **the same gap as §5.2. Absorb now (B-3).**

Also note the flag-off residue: `if (!collabSurfaceCommandsEnabled()) { sendErr(…); break; }` at
`server.ts:606` and `:620` sits **entirely outside** any handler and is untested over a real socket
(open **CO-2**). A6/T-9 as written never reach it.

### 5.5 CO-9 — a thrown object whose `code` getter itself throws — **correctly OUT OF SCOPE.**

The re-audit adjudicated this as N-1/CO-9: unreachable, because `CollabError.code`
(`store.ts:108-115`) is a plain `readonly` data property and `grep` for `get code` /
`Object.defineProperty` across `packages/collab/src/` returns zero hits. Requiring a
`try { err.code } catch` in every handler would be belt-and-braces against a source that does not
exist. **Correct to leave in CO-9, not in A6.** One caveat: A6 says the command is "**total** on
every input its contract admits," and CO-9 is a live exception to the word "total." Since a future
G2A will read A6 literally, the amendment should acknowledge the exception rather than let a later
auditor discover the PRD overclaims. **NB-4.**

### 5.6 Additional gap I found, not in the brief: **the criterion never requires the net.**

The deepest reading of D-1 is that the gateway has **no `unhandledRejection` listener** — I re-grepped
`packages/` and `ops/` and confirmed **zero hits** at `b418e87`. A6/T-9 make every *new* handler
total, one command at a time, forever. The house pattern is per-arm defence
(`CANCEL_TASK`, `server.ts:508-528`, wraps its async calls), which A6 correctly codifies — but it
leaves the class permanently one forgotten arm away from a process kill.

The prior G2A explicitly declined to require a process-level net, calling it "a gateway-wide decision
outside S1's scope," and I agree it does not belong in **this** PRD. But the amendment is the natural
place to *record* that A6 is a per-command mitigation of a gateway-wide gap, so it is not later
mistaken for a structural fix. **NB-5** (route to the auth/gateway lane, not to S3).

---

## 6. Obligation (6) — HOUSE-STYLE FIT

**A6 vs A1–A5: mostly conforming, one real inconsistency.**

- ✅ §6's heading is "**per slice**, evidence required." A6 says "graded per slice and never
  inherited from a prior slice" and "**Evidence required:** the T-9 matrix below, not an assertion
  of care." Both conform, and the anti-inheritance clause is a genuine improvement on A1–A5, which
  have no such guard (and CO-3 exists precisely because A1 risks being inherited as green).
- ⚠️ **Structural inconsistency:** A1–A5 are keyed to a **named slice** — `A1 (S1)`, `A2 (S2)` … A6
  is keyed to a **predicate** — "EVERY slice that adds or changes a wire command." A reader
  scanning §6 for "what must S3 prove" no longer gets an answer by looking up `A?(S3)`; they must
  evaluate a condition. That is a deliberate and correct design choice (the criterion *should*
  generalize), but it should be made visibly, e.g. `**A6 (cross-slice; applies to S1, S3 — every
  slice adding or changing a wire command)**`. Naming the slices that actually trigger it also
  makes the S2/S4/S5 not-applicable declaration self-evident. **NB-6.**
- ⚠️ A6 is the only §6 bullet with **bold markup and a following prose block**. A1–A5 are plain
  bullets. The prose block ("A6 rationale — do not delete as boilerplate") is a **new structural
  element in §6**. I judge it **justified and would keep it** — a criterion whose origin is invisible
  gets deleted as boilerplate in two revisions, which is how gates rot — but flag that §6 previously
  had no prose blocks, and prose blocks after a bullet list are ambiguous in scope (does the
  rationale attach to A6, or to the `Gate:` bullet that now precedes it in reading order?). Worth a
  one-line anchor. **NB-6.**
- ⚠️ **Ordering:** the `Gate:` bullet — the shared, non-slice row — now sits **between** A6 and A6's
  own rationale. A6 is inserted before `Gate:` and the rationale after it. Minor, but it separates a
  criterion from its explanation by an unrelated bullet. **NB-6.**

**T-9 vs T-1–T-8: conforming, and the strongest-drafted member of the set.**

- ✅ Named, non-negotiable, and carries an "**enforces A6 — closes CO-4**" tag matching the
  house form ("enforces B-1/§2a refuse", "enforces B-4 rescope"). T-9 enforces an *acceptance
  criterion* rather than a *Gate-1 blocker resolution*, which is a new-but-correct variant — CO-4
  is a G2A carried obligation, a category that did not exist when §8's heading was written. The
  heading "each enforces a Gate-1 resolution" is now **slightly false** for T-9. Cosmetic. **NB-7.**
- ✅ T-9's internal structure (numbered sub-parts + a trailing obligation) is heavier than T-1–T-8's
  single-sentence form, but it is the only T carrying a *matrix*, and each sub-part is
  independently gradeable. Justified.
- ✅ Placement is correct: appended after T-8, **before** the "v0.1 tests deleted" note and the two
  trailing rules, so no existing prose is orphaned. Verified — every old §8 line survives verbatim.

**§9b vs §9a: conforming, with one improvement over the existing style.**

§9a is `| Blocker | Resolution |`; §9b is `| Item | Record |`. Different columns, same two-column
markdown-table idiom, appended after §9a and before §10 — the same pattern §9a itself used when the
Cycle-2 record was appended as a `###` subsection. §9b is a **top-level `##`** whereas §9a folded
Cycle 2 in as `### Cycle-2 resolution record (v0.3)`. Given §9b records an *amendment* rather than a
*review cycle*, a peer section is defensible.

The **"Additive-only proof"** row is a genuine addition to house style: it makes the amendment's
safety property auditable from the document itself. I endorse it, subject to NB-1 (it must not cite
a `git diff` that will be empty post-commit).

---

## 7. BLOCKERS

### **B-1 (BLOCKING) — T-9's falsifiability obligation cites a standard that does not exist in this PRD, and produces no artifact.**

**Where:** §8, T-9 trailing paragraph — *"Falsifiability obligation (same standard as T-2/T-6)."*

**Why blocking:** T-2 (§8 lines 226-231) and T-6 (§8 lines 238-242) contain **no** falsifiability,
mutation, revert, or RED-probe obligation. I grepped the entire PRD for `falsifiab|mutation|revert`:
outside T-9 the only hits are §4's "only new mutation" (unrelated sense), §9's rollback prose, and
§8's note that a *deleted* v0.1 test "was un-falsifiable as specified." The mutation discipline T-9
is gesturing at exists only in G2A verdict files (M-1/M-2/M-3), downstream of the Builder.

A Builder calibrating "the same standard as T-2/T-6" therefore correctly derives **no probe is
required**. And because the obligation names no artifact, a skipped probe is textually
indistinguishable from a performed one. **This is the unenforced-claim pattern inside the criterion
written to cure the unenforced-claim pattern** — the amendment would create false confidence
exactly where D-1 created it.

**SUGGESTED FIX** — replace the sentence with a self-contained, artifact-producing standard:

> **Falsifiability obligation.** Each of the four parts must be shown able to fail. For each part:
> revert the specific guard it pins, run the test file, **record the observed RED output (test name
> + failure message + counts)**, restore, and re-run GREEN. The **four RED excerpts and the exact
> revert applied** are recorded in the slice's verification evidence file; a probe reported without
> its RED output is not a discharged probe. For part 1 the revert must include
> `pnpm --filter @torqclaw/contracts build`, and the restore must `git checkout` the source **and
> both checked-in generated copies** and rebuild, or the probe is vacuous. *(This is the mutation-probe
> discipline used by the S1 G2A re-audit, M-1/M-2/M-3; it is stated here in full because no other
> §8 test carries it — do not read T-2/T-6 as the calibration.)*

---

### **B-2 (BLOCKING) — A6(a)'s "narrowest grammar" is satisfiable by assertion; the criterion omits the procedure that finds the answer.**

**Where:** §6, A6 clause (a) — *"the contract constrains each free-form field to the narrowest
grammar the consuming layer accepts."*

**Why blocking:** there is no mechanical test a reviewer can apply to a Builder's claim that their
grammar is narrowest, and the clause never instructs the Builder to *locate* the consuming
validator. Applied honestly-but-shallowly to pre-fix S1: a Builder who never opens `parseCursor`
can hold that `z.string().min(1)` is the narrowest grammar they know the consumer accepts. The
finding is only forced once someone reads `store.ts:2066-2075` — and no clause says to. T-9 p2 does
this work implicitly ("every input the contract still admits that the consuming layer rejects by
throwing" cannot be enumerated without reading the consumer), but A6(a) is graded in §6 on its own
terms, and §6 is where a reviewer looks first.

**SUGGESTED FIX** — make the citation the deliverable:

> (a) the contract constrains each free-form field to the narrowest grammar the consuming layer
> accepts, **and the slice's evidence cites the consuming validator by `file:line` for every
> free-form field — the specific function that would reject the value downstream (e.g. `cursor` →
> `store.ts` `parseCursor`). A field whose consuming validator is not cited is not graded green**;
> and the emitted schemas carry that constraint.

This converts an adjective into an artifact, and it is the same move that makes T-9 p2 enforceable
("**Name, in the test**, …").

---

### **B-3 (BLOCKING) — A6/T-9 prove totality of the HANDLER, not of the dispatch arm that runs inside the unprotected async socket handler.**

**Where:** §6 A6(b) ("no input … can cause **the handler** to throw"); §8 T-9 p3 ("Drive **each
handler** through its test seam").

**Why blocking:** D-1's actual mechanism was *"a throw reaches the unprotected `async
socket.on('message')` handler."* The handler function is only part of what executes there.
`packages/gateway/src/server.ts:599-617`, the shipped dispatch arms:

```js
const listErr = await handleListChannels(sid, connectionAuth?.principalId ?? null, cmd.data.limit);
if (listErr) sendErr(listErr.code, listErr.detail);
break;
```

`sendErr` (`server.ts:183-184`, `socket.send(JSON.stringify(...))`) is **outside** the handler's
try/catch and inside the unprotected async handler. `JSON.stringify` throws on a circular value or a
`BigInt`; `socket.send` throws on a closed socket. Also outside any handler: the flag-off
`sendErr('NOT_ENABLED', …)` residue at `:606` / `:620` (still uncovered — open CO-2).

`publishOnly` is the live near-miss. `events.ts:116` is `GatewayEventSchema.parse(built)` — a
throwing validator over store-derived `metadata`. It is netted **only** because it happens to sit
inside both handlers' try/catch. Nothing in A6/T-9 requires it to stay there. A Builder can pass all
four T-9 parts, then move publication into the dispatch arm during S3 — and reopen D-1's exact shape
with a fully green matrix.

**SUGGESTED FIX** — extend the unit of analysis from "the handler" to "everything the socket handler
runs," in two places:

In **A6(b)**:
> (b) **no input the contract still admits can cause the handler — or the `server.ts` dispatch arm
> that consumes its return value — to throw**; every failure resolves to a structured error frame,
> never an exception. **The unit of totality is the entire code path executed inside
> `socket.on('message')` for that command, not the handler function alone.**

In **T-9 p3**, append:
> Additionally, the slice's evidence names **every throwing call reachable from the command's
> dispatch arm but outside the handler's own try/catch** — including `sendErr`'s
> `JSON.stringify`/`socket.send`, any `publishOnly`/`GatewayEventSchema.parse`, and the flag-off
> `NOT_ENABLED` residue — and states for each why it cannot throw on any wire-admissible input, or
> nets it.

---

## 8. NON-BLOCKING NOTES

- **NB-1 — §9b's "Verify with `git diff`" goes stale on commit.** The row instructs a future reader
  to run `git diff`, which will be empty once this lands. Replace with the commit range or
  *"verified in `docs/prd-reviews/G1R-OPUS-COLLAB-PRESENCE-UI-005-A6-T9.md` §1: 68 insertions /
  1 deletion, the deletion being the v0.4 status header; A1–A5 and T-1–T-8 byte-identical."*

- **NB-2 — latent defeat of T-9 p1 via `vitest.config.ts:14`.** `TORQCLAW_PROFILE_CONFORMANCE_SOURCE_CONTRACTS=1`
  flips the `@torqclaw/contracts` alias from `dist` to `src`, silently converting every T-9 part-1
  test into a Zod-source test while staying green. Inert today (I grepped: the variable is set
  nowhere else in the repo). Worth one clause in p1: *"and the test must fail if the contracts alias
  resolves to source rather than `dist`."*

- **NB-3 — say that resource exhaustion is out of scope.** A6 is a totality criterion, not a
  resource criterion; a grammatically valid 100 000-character `text` in S3 is a different failure
  mode needing a different control. Correctly excluded, but the rationale note should say so, so a
  later reader does not mistake A6's silence for coverage — and so S3's free-form `text` gets its
  length bound named somewhere.

- **NB-4 — A6 says "total"; CO-9 is a live exception.** The re-audit's N-1 (a thrown object whose
  `code` getter throws) escapes both handlers and is unreachable-by-construction, not impossible.
  One parenthetical in A6(b) — *"(the sole recorded exception is CO-9's throwing-`code`-getter,
  unreachable while every thrown value is a `CollabError` with a data-property `code`)"* — keeps the
  word "total" honest against a future literal-minded auditor.
  **Status 2026-08-23 (docs-truth pass): recorded, not applied verbatim to the A6(b) criterion
  text.** CO-9 is confirmed as the sole recorded exception to "total" (verified:
  `packages/collab/src/store.ts:110`, `CollabError.code` is a data property, zero throwing
  accessors in `packages/collab/src/`; see `docs/FOLLOWUPS-CI-E2E-GATES.md` §4). This note
  stands as the citation for that exception until the parenthetical is folded into the A6(b)
  definition itself.

- **NB-5 — record that A6 mitigates, but does not close, a gateway-wide gap.** There is still **no
  `unhandledRejection` listener** anywhere in `packages/` or `ops/` (re-grepped at `b418e87`: zero
  hits). A6 hardens each new command individually; the class remains one forgotten arm from a
  process kill. Correctly **out of scope for this PRD** (the prior G2A said so and I agree) — but
  the rationale note should say it, so A6 is never mistaken for the structural fix. Route to the
  auth/gateway lane.

- **NB-6 — §6 structural drift (three small items).** (i) A6 is keyed to a *predicate* while A1–A5
  are keyed to *named slices*; name the triggering slices inline — `**A6 (cross-slice; applies to
  S1, S3 …)**`. (ii) A6 is the only §6 bullet with a following prose block; keep the block (it is
  the right call — an unexplained criterion gets deleted as boilerplate) but anchor it explicitly to
  A6. (iii) the shared `Gate:` bullet now sits **between** A6 and A6's own rationale; move the
  rationale to sit directly under A6, or the `Gate:` row after it.

- **NB-7 — §8's heading is now slightly false.** It reads *"each enforces a Gate-1 resolution."*
  T-9 enforces an **acceptance criterion (A6) closing a G2A carried obligation (CO-4)** — a category
  that did not exist when the heading was written. One-word fix: *"each enforces a named
  resolution or carried obligation."*

---

## 9. What I checked that came up EMPTY

Recording the probes that found nothing, since a review reporting only hits is not auditable.

- **Did the amendment reword an existing AC while appearing to add?** No. Every old line in §6 and
  §8 survives **verbatim** (line-level survival sweep, §1 Check 3). Zero hits.
- **Did anything change in §2a, which A6(c) references?** No — §2 (containing §2a) is byte-identical
  at 2032 characters. I checked this specifically because a referenced section is the natural place
  to hide a weakening.
- **Does A6 quietly retro-grade S1 to green?** No — §9b explicitly says *"S1 is not retroactively
  re-graded."* And it does **not** disturb CO-3 (A1 remains PARTIAL). Clean.
- **Does the amendment touch §9's rollback story, §7's operator gate, or §10's stop conditions?**
  No — all three byte-identical.
- **Is the "S1 already satisfies A6 in substance" claim in §9b true?** Yes, and I verified it against
  the code rather than the audit narrative: `collabSurface.ts:144-157` and `:194-216` now catch
  `INVALID_REQUEST` and fall through to a detail-free `COLLAB_UNAVAILABLE`; the contract at
  `commands.ts:151` carries the regex. The claim is honest.
- **Is T-9 satisfiable by a slice that ships D-1?** I could not construct one against the pre-fix
  code. Part 3 alone goes red on `handleListChannels` (no catch at all), and part 2 alone catches
  the 21-digit residue. Two independent catches. **This is the amendment's strongest property.**

---

## 10. FINAL VERDICT

# REJECT

**Three blockers, all in the amendment's own new text, none requiring any change to A1–A5 or
T-1–T-8.**

I want the record to be clear about what is *right* here, because the fixes are small and the
criterion should survive them. A6/T-9 is derived from a measured defect rather than imagined risk.
Its scope is correctly bounded — S3 is realistically the only slice that pays the cost, and S3 is
exactly the slice that should. Its central clause, T-9 part 2, encodes the one insight that a lesser
amendment would have missed: **a contract regex mirroring a downstream validator is not equivalent to
it**, proven by the 21-digit cursor that satisfies `^(0|[1-9][0-9]*)$` and then fails
`Number.isSafeInteger`. Without part 2, this amendment would have been a regex-shaped placebo, and I
would be rejecting it as aspirational prose. It is not. And the "parse the compiled/emitted schema,
not the Zod source" instruction is correct, costs nothing given the existing vitest alias, and
forbids precisely the shortcut that produced a false green in this repo before.

**The amendment is also exactly what it says it is.** I verified additive-only three ways rather
than accepting the §9b claim: one deleted line (the v0.4 status header), every §6 and §8 line
surviving verbatim, and ten of thirteen sections byte-identical. The repo's most-recorded defect
class — editing an acceptance criterion to fit an implementation — is **not** present.

**But it is rejected, and B-1 is why it must be.** T-9 anchors its falsifiability obligation to
"the same standard as T-2/T-6," and **that standard does not exist** — T-2 and T-6 carry no probe
requirement of any kind. A Builder following the reference lands on *no probe required*, and since
the obligation names no artifact, a skipped probe reads identically to a performed one. That is the
unenforced-claim pattern reproduced inside the criterion written to cure it: a clause that reads
rigorous, enforces nothing, and manufactures the confidence that let D-1 through. Left as written it
is worse than omitting the clause. B-2 is the same disease in milder form — "narrowest" without the
procedure that finds the answer. B-3 is the sharper structural point: A6 proves the *handler* total,
while D-1's mechanism was *a throw reaching the unprotected async socket handler* — and `sendErr`,
the flag-off `NOT_ENABLED` residue, and (one refactor away) `publishOnly`'s throwing
`GatewayEventSchema.parse` all run there, outside every handler's try/catch, with all four T-9 parts
green.

**To flip this to APPROVE:** apply the three suggested fixes verbatim or in equivalent wording —
a self-contained falsifiability standard that produces recorded RED output (B-1); a `file:line`
citation of the consuming validator per free-form field (B-2); and extension of the unit of totality
from "the handler" to "the whole dispatch path inside `socket.on('message')`" (B-3). All three are
additive to the already-additive amendment. On that revision I would approve **without a further
cycle**, and I would expect A6/T-9 to hold at S3.

**Owner of the revision: G1D.** I have not edited the PRD and will not.

---

*G1R seat filled by `claude-opus-5` — the model the routing profile seats for G1R; no substitution
claimed or applied. All code claims cite `file:line` and were read at HEAD `b418e87`. Read-only on
all tracked files: no tracked file other than the pre-existing PRD modification appears in
`git status --short`, and this verdict file is the only file I wrote. The 28 pre-existing untracked
operator files at repo root were never read, moved, or touched. No commits, no pushes.*
