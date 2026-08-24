# Build Evidence — Channels live-defects follow-up (collapse fix + T-1..T-8 + rider)

**Date:** 2026-08-24 · **Builder:** Sonnet 5 · **Branch:** phase1-server-owned-authority
**Controlling packets:** `G1D-FABLE-CHANNELS-LIVE-DEFECTS-2026-08-24.md` (v1.1 amendment),
`G1R-CHANNELS-LIVE-DEFECTS-2026-08-24.md`

## Objective
Correct `collapseSelfRuns` so a self-repetition collapse survives interleaving with other
actors (the real live shape) while never destroying a non-duplicate self-authored message —
with T-1 first closing (or reopening) the persona-injection defect claim.

## Scope
- `packages/gateway/src/autoReplyContext.ts` — `collapseSelfRuns` (:109-137) + its doc
  comment ONLY. No other function, no constant, no export surface change.
- New test file `tests/agent-participation-collapse-live-shape.test.ts` (T-1..T-7 + rider).
- `autoReplyDispatcher.ts` — **ZERO hunks** (frozen; proof below).
- `packages/inference/src/ollama.ts` — **not touched** (T-1 closed D-A as NOT-A-DEFECT; no
  new packet needed).

## Controlling invariant
An agent's own prior output must never displace the operator's newest message as the
effective instruction — enforced at both the prompt the model sees (persona + collapsed
window) and the commit gate (existing guard).

---

## T-1 outcome: D-A CLOSED (NOT-A-DEFECT)

Pre-existing test `tests/local-inference-model-routing.test.ts:102` ("sends immutable
policy, persona directives, then channel content as distinct roles") already dispatches a
real local auto-turn through `executeLocalEdge` (packages/inference/src/ollama.ts) with the
real envelope plumbing (mocks only `fetch`), and asserts:
- `body.messages.map(m => m.role) === ['system','system','user']`
- `body.messages[1].content` (the SECOND system message) contains the persona directive
  text ("Answer as the local Torq architect.")
- `body.messages[2].content` (the user message / `payload.prompt`) does **NOT** contain
  "AGENT DIRECTIVES"

Ran in isolation before any edit:

```
npx vitest run tests/local-inference-model-routing.test.ts
```

Result: **10 passed (10)**, including the T-1/T-2-shaped test above, in 1691ms.

This independently reproduces G1R's F-1 finding from source
(`ollama.ts:278` `validateManagedPersonaEnvelope`, `:308` `agentDirectives = personaContent`,
`:332-338` the dedicated `role:'system'` "SUBORDINATE AGENT PERSONA" message, `:339`
`payload.prompt` wrapped as `--- BEGIN UNTRUSTED CHANNEL CONTENT ---`). **D-A is withdrawn as
NOT-A-DEFECT.** No code change to ollama.ts or the dispatcher's prompt assembly is made or
needed. Per G1R's path-to-APPROVE, this closes the precondition for proceeding to the
collapse fix.

Dedicated T-1/T-2 assertions (referencing, not duplicating, this coverage) are also added in
the new test file below for direct traceability to this evidence packet.

---

## T-4 RED capture (against pre-fix code, BEFORE any edit)

First run of the new test file `tests/agent-participation-collapse-live-shape.test.ts`
against the genuinely-unmodified `collapseSelfRuns` (before any edit to
`autoReplyContext.ts`):

```
npx vitest run tests/agent-participation-collapse-live-shape.test.ts
```

```
 ❯ tests/agent-participation-collapse-live-shape.test.ts (9 tests | 3 failed)
   × T-4 (the live shape, RED against pre-fix code): 7 near-identical agent
     greetings alternating with 7 distinct operator messages
     → T-4: at most 1 of the 7 near-identical greetings survives verbatim:
       expected 7 to be less than or equal to 1
   × T-6: marker honesty — count equals items omitted...
     → expected 4 to be 1
   × Rider ... DISCLOSURE + source-text deletion-sensitivity pin ...
     → ADD_CHANNEL_MEMBER must have a named case arm BEFORE the default arm:
       expected -1 to be greater than -1   (test-construction bug, fixed
       below; comment-text false-positive matched "default:" inside a prose
       comment before the real case label — see the fixed regex-anchored
       search in the final test file)
 Tests  3 failed | 6 passed (9)
```

T-1 passed on this same run (D-A closed as NOT-A-DEFECT, confirmed before touching
`collapseSelfRuns`).

T-4's RED is the load-bearing capture required by G1R's T-5 (deletion-probe framing): with
the original run-reset-on-interleaving logic, all 7 greetings survive uncollapsed (0
collapsing at all) because every intervening operator message resets `runStart` to `-1`
before a second self-message can ever be compared against a kept reference.

**Independent re-verification after the T-4 test construction was later corrected** (to
account for the pre-existing, unmodified anchor/window 10-event split — see "T-4
construction note" below), done via an isolated scratch script (not touching any tracked
file or the shared git index, which had a live lock held by a concurrent session) that
copies the exact original `collapseSelfRuns` body and runs it against the corrected T-4
event shape in-process:

```
node <scratch>/red-check.mjs
```

```
anchor greeting-bearing entries: 0
tail greeting-bearing entries: 7
TOTAL entries carrying the greeting text (verbatim or as elision target): 7
RED check (expect >1): RED CONFIRMED
```

Both captures agree: the original logic never collapses the alternating live shape at all.

## T-4 construction note (mid-build correction)

The first T-4 draft placed all 14 events (7 greeting/operator pairs) in a single channel
with no filler. `buildAnchorWindowContext` splits a channel's events into an ANCHOR block
(first `ANCHOR_EVENT_COUNT=10` events) and a separate tail WINDOW block, and
`collapseSelfRuns` is applied **independently within each block** (pre-existing, documented,
unmodified behavior — this split and the ANCHOR/WINDOW counts are explicitly frozen by
G1R's unfreeze grant). With 14 raw events, 10 landed in the anchor and 4 in the tail,
so each block could independently retain 1 survivor — 2 total, not ≤1. This is not a defect
in the fix; it is a property of the (frozen, unrelated) anchor/window split colliding with a
test shape sized to exceed it. Fixed by seeding 10 filler events (5 unrelated exchanges)
first, pushing the entire 14-event target shape into the tail window block, matching G1R's
T-4 spec of "the live shape" as a single alternating window. Documented in the test file's
own comment.

## T-3 spec-tension disclosure (reported, not silently resolved)

G1R's T-3 obligation (verdict file line 27) specifies a "hostile amputation pair" — two
self-posts with **identical normalized word sets in different order** ("deploy the staging
build to production" vs "deploy the production build to staging"), separated by one operator
message — and states both must survive, "GREEN against correction (a)".

This is the SAME sentence pair G1R's own F-2 finding (verdict line 11) uses as its
illustrative argument against a *window-wide* Jaccard collapse. Under a literal, correct
implementation of correction (a) as G1R described its mechanism ("collapse only on a
near-duplicate hit against that reference" — the SAME unchanged, order-blind
`looksLikeNearDuplicateOfOwnRecent` predicate, applied only across the survives-interleaving
per-actor reference), this exact pair **is** a near-duplicate hit (same normalized word set,
Jaccard 1.0) separated by exactly one intervening message — precisely the interleaving
correction (a) is designed to survive through. So under an honest implementation, B (the
more recent) is kept and A is elided; both do not survive.

Reconciling this literally would require either (a) editing `looksLikeNearDuplicateOfOwnRecent`
to be order-sensitive — **explicitly PROHIBITED** by G1R's unfreeze grant — or (b) inventing
new order-sensitivity heuristics inside `collapseSelfRuns` beyond what correction (a)
specifies — an unauthorized scope expansion this Builder will not silently add. Supporting
evidence for this reading: G1R's own "Path to APPROVE" summary line (verdict line 41)
restates only "T-3 RED against window-wide Jaccard" (not the GREEN clause), and the
"deleting/weakening any existing assertion prohibited" instruction (line 22) names
"greeting-loop obligations 6a/6b/7/8" as the amputation test that must stay green — that is
the PRE-EXISTING obligation 6b test in `agent-participation-greeting-loop.test.ts`, which
uses genuinely distinct wording (DISTINCT_A / DISTINCT_B), not a word-set reordering, and
which remains green, unmodified, under this fix.

**Disposition:** T-3 in the new test file proves (1) RED against a literal, minimal
reimplementation of the rejected window-wide-Jaccard alternative (this exact pair collapses
under it, losing A), and (2) documents correction (a)'s actual, honest behavior on this
adversarial pair (B survives, A is elided — a disclosed residual), rather than asserting a
false "both survive" claim. This is flagged as a **finding for G1D/G1R**, not fixed
unilaterally. If the operator/G1R wants this exact reordered-pair case to fully survive, it
needs a fresh unfreeze grant for new order-sensitivity logic — out of this slice's scope.

---

## The fix

`packages/gateway/src/autoReplyContext.ts`, `collapseSelfRuns` (:109-137 pre-fix, now
slightly longer due to the expanded doc comment) + its doc comment — the ONLY function
touched. Mechanism: renamed `runStart` to `lastSelfIndex` conceptually (the per-actor "last
kept self-post" reference) and changed the reset condition — previously any non-self event
reset the reference to `-1` (line `runStart = isSelfMessage ? out.length - 1 : -1;`); now a
non-self event (another actor's message, or a non-message event) is pushed through
unconditionally and **leaves the existing reference untouched**. The reference only changes
when a self-message is pushed as a new, non-collapsed entry. The near-duplicate predicate
(`looksLikeNearDuplicateOfOwnRecent`), the threshold/min-length constants, and the
anchor/window split are all untouched, exactly as G1R's unfreeze grant requires.

## T-1/T-2/T-3..T-7/rider outcomes (post-fix)

```
npx vitest run tests/agent-participation-collapse-live-shape.test.ts
```
```
 Test Files  1 passed (1)
      Tests  9 passed (9)
```
All 9 tests green: T-1 (persona present), T-2 (payload.prompt clean, folded into the T-1
test body), T-3 (disclosed, both sub-assertions pass), T-4 (live shape, ≤1 survivor + marker
+ all 7 operator messages verbatim/in-order/newest-last), T-5 (deletion-probe surrogate:
omitting selfPrincipalId reproduces zero collapsing), T-6 (marker honesty: exact count,
never consumes non-message events or other actors), T-7 (constant parity via source text),
rider outcome pin, rider disclosure + source-text deletion-sensitivity pin, cleanup.

## T-8 regression (post-fix)

```
npx vitest run tests/agent-participation-greeting-loop.test.ts \
  tests/agent-participation-configuration-readiness.test.ts \
  tests/collab-channel-membership-wire.test.ts \
  tests/agent-participation-collapse-live-shape.test.ts \
  tests/local-inference-model-routing.test.ts
```
```
 Test Files  5 passed (5)
      Tests  58 passed (58)
```
Obligations 6a/6b/7/8 (in `agent-participation-greeting-loop.test.ts`) all still pass,
unmodified, unweakened.

## Zero-diff proof — autoReplyDispatcher.ts

```
git diff --stat -- packages/gateway/src/autoReplyDispatcher.ts
```
Output: **empty** (exit 0, no changes). Confirms the frozen file was never touched.

Note: the shared git index (`.git/index.lock`) was held by a concurrent session's git
process during part of this build (per the task briefing's warning about concurrent WIP in
this working tree). No git write commands were attempted; `git diff --stat` (read-only) was
used, which does not require the index lock.

## Build / typecheck

```
pnpm --filter @torqclaw/gateway build   # exit 0
pnpm typecheck                          # exit 0, 14/14 tasks successful
```

## Full suite (excluding tests/failover/**)

```
npx vitest run tests/ --exclude "tests/failover/**"
```
Result (exit code 0):
```
 Test Files  172 passed (172)
      Tests  2584 passed | 1 skipped (2585)
   Duration  294.32s
```
Log scanned for any failure markers (`grep -n "FAIL\|✗\|failed)"`): every match is either an
expected test-name substring ("FAILS verification", "FAILS when a substantial unreachable
module appears" — both are PASSING tests whose names describe negative controls) or expected
negative-control log output (`AUTH_FAILED` / close 4001 from tests deliberately probing wrong
credentials). Zero actual test failures. Full log saved at
`C:\Users\asdasd\AppData\Local\Temp\claude\E--TorqClaw\3c41855f-d118-441b-af53-3de59bf123d8\scratchpad\full-suite.log`.

## Final diff confirmation

```
git diff --stat -- packages/gateway/src/autoReplyContext.ts
```
```
 packages/gateway/src/autoReplyContext.ts | 63 +++++++++++++++++++++-----------
 1 file changed, 42 insertions(+), 21 deletions(-)
```
```
git status --short docs/prd-reviews/BUILD-EVIDENCE-COLLAPSE-FIX-2026-08-24.md tests/agent-participation-collapse-live-shape.test.ts
```
```
?? docs/prd-reviews/BUILD-EVIDENCE-COLLAPSE-FIX-2026-08-24.md
?? tests/agent-participation-collapse-live-shape.test.ts
```
```
git diff --stat -- packages/gateway/src/autoReplyDispatcher.ts    # empty
git diff --stat -- packages/inference/src/ollama.ts               # empty
```
Both frozen files confirmed byte-identical to the pre-slice tree. No other tracked file was
touched by this Builder. (Note: several OTHER tracked files show as modified in `git status`
at the repo root — `.claude/agents/README.md`, `.claude/settings.json`,
`apps/console/src/components/friendly.ts`, `packages/bridge/src/hermesAttempt.ts`,
`packages/gateway/src/dispatch.ts`, `tests/failover/mcp-contract.test.ts`,
`tests/friendly.test.ts` — these are the pre-existing concurrent-session WIP the task
briefing explicitly warned not to touch, and this Builder made no edits to any of them.)

## Files changed

- `packages/gateway/src/autoReplyContext.ts` — `collapseSelfRuns` + doc comment only
  (modified, tracked file).
- `tests/agent-participation-collapse-live-shape.test.ts` — new file (T-1..T-7 + rider).
- `docs/prd-reviews/BUILD-EVIDENCE-COLLAPSE-FIX-2026-08-24.md` — this file (new).

No other file touched. `packages/gateway/src/autoReplyDispatcher.ts` and
`packages/inference/src/ollama.ts` are byte-identical to the pre-slice tree.

## Known limitations / residuals

- **T-3 residual (disclosed above):** the exact word-set-reordered adversarial pair does not
  fully survive under an honest reading of correction (a); this is a spec tension for
  G1D/G1R, not silently patched.
- **R-1 (from G1R, accepted, unchanged this slice):** the subscription commit branch (:719 in
  the dispatcher) still relies on window collapse alone, no duplicate-suppression guard —
  deferred to its own slice (B-FOLLOWUP-2), per G1R's explicit deferral.
- **Rider (B-FOLLOWUP-1):** channel/node named-arm vs. default-arm discrimination is
  black-box unpinnable without editing `authz.ts` (both return the identical
  `DENY_NOT_PERMITTED` singleton) — disclosed in the rider test itself; outcome-level
  denial and a source-text deletion-sensitivity pin are provided instead, matching what the
  pre-existing T-D5 suite already does for the operator-role side (which DOES have a
  fail-open tail to discriminate against).

## Deviations from the packet

- T-3 does not assert the packet's literal "both survive" claim for the exact adversarial
  pair; see disclosure above. All other G1R-specified T-1..T-8 obligations and the rider are
  implemented as specified.
- T-4's synthetic event shape includes 10 filler events not in G1R's literal spec text,
  needed only to keep the pre-existing, frozen anchor/window split from splitting the target
  14-event shape across two independently-collapsed blocks. This does not change what T-4
  proves; it only ensures the test measures collapse behavior across the intended single
  alternating window.

## Status

**READY_FOR_INDEPENDENT_VERIFICATION**

Summary: T-1 closed D-A as NOT-A-DEFECT (persona system message confirmed present, source-
verified and test-verified). The one authorized code change (`collapseSelfRuns` +
doc comment in `autoReplyContext.ts`) implements G1R's correction (a) — the per-actor
"last kept self-post" reference survives interleaving; the near-duplicate predicate,
constants, anchor/window split, and dispatcher are all untouched. T-4/T-5/T-6/T-7 and the
rider are green; T-3 is green but with an honestly-disclosed spec tension (see above) rather
than a literal "both survive" claim, flagged as a finding for G1D/G1R rather than resolved
unilaterally. Zero hunks in `autoReplyDispatcher.ts` (proven). Full repo suite (2584 tests,
172 files, excluding `tests/failover/**`) passes with zero regressions. Typecheck and
gateway build both exit 0.

---

## Addendum — 2026-08-24: pre-commit fix from independent verification (Finding A)

**Source:** `docs/prd-reviews/VERIFY-COLLAPSE-FIX-2026-08-24.md`, verdict READY_FOR_G2A with
one pre-commit fix, Finding A.

**Finding:** T-1 ("a dispatched local auto-turn carries the persona directives in a
role:system message") ran inside vitest's default 5000ms per-test timeout, while every other
test in this file (T-3 through the rider tests) carried an explicit `20000` timeout argument.
The verifier measured T-1 at 8260ms on a cold run and 346ms warm — cold, it would exceed the
default 5s budget and fail spuriously, not because of a logic defect but because the dynamic
`await import('../packages/inference/src/ollama.js')` inside the test body pays real
first-import module-resolution cost that the other tests amortize via the file's shared
`beforeAll`/module-level dist imports.

**Fix (the only change made):** added `, 20000` as the timeout argument to the T-1 `it(...)`
call, exactly matching the pattern already used by T-3 through T-6 and the rider tests in
this same file. One line changed, at what is now line 139
(`tests/agent-participation-collapse-live-shape.test.ts`). No other file touched; no other
line in this file touched.

**Verification runs performed (as instructed):**

```
npx vitest run tests/agent-participation-collapse-live-shape.test.ts   # run 1
```
```
 Test Files  1 passed (1)
      Tests  9 passed (9)
   T-1 duration: 344ms
```
```
npx vitest run tests/agent-participation-collapse-live-shape.test.ts   # run 2
```
```
 Test Files  1 passed (1)
      Tests  9 passed (9)
   T-1 duration: 377ms
```

**Honest note on cold-cache reproduction:** each `npx vitest run` invocation above runs in a
fresh Node process, so module resolution for `ollama.js` is not warmed by a prior process —
these are not "hot-process-cache" runs. Both nonetheless measured well under 500ms for T-1,
nowhere near the verifier's reported 8260ms cold outlier. This Builder cannot force the exact
condition the verifier's cold measurement hit (likely first-ever `tsc`/module-graph
resolution on a colder OS file-cache state, or contention from the concurrent session's own
build activity in this shared working tree at measurement time) and is not claiming to have
reproduced it — only reporting, honestly, what these two runs actually showed: consistently
fast, well within the new 20000ms budget either way. The fix removes the failure mode
regardless of which cold-start magnitude actually recurs, since 20000ms comfortably covers
even the verifier's observed 8260ms cold case.

**Named 5-file regression set, run once more post-fix:**

```
npx vitest run tests/agent-participation-greeting-loop.test.ts \
  tests/agent-participation-configuration-readiness.test.ts \
  tests/collab-channel-membership-wire.test.ts \
  tests/agent-participation-collapse-live-shape.test.ts \
  tests/local-inference-model-routing.test.ts
```
```
 Test Files  5 passed (5)
      Tests  58 passed (58)
   Duration  4.64s
```

**Diff proof:**

```
git status --short tests/agent-participation-collapse-live-shape.test.ts
```
```
?? tests/agent-participation-collapse-live-shape.test.ts
```
The file remains untracked (new in this slice, never committed), so `git diff --stat`
against HEAD shows nothing for it — there is no prior committed version to diff against; the
correct proof of the fix's scope is that this is the ONLY file touched in this addendum, and
the only change within it is the single `, 20000)` timeout argument added at line 139.

**Correction (2026-08-24, per G2A round-1 N-1 finding):** the claim directly above this line
originally said `grep -n "20000);"` found **three** occurrences (139/337/398). That count was
wrong at the time it was written — the actual count on that exact revision of the file was
**five**: lines 139, 337, 398, 428, 476. This Builder undercounted rather than miscounted in
a way that hid anything (the direction was harmless — all five were legitimate, pre-existing
or newly-added timeout arguments, none missing), but the claim itself was unsupported/wrong
and is corrected here rather than silently left. See the Round-2 addendum below for the
current, freshly re-verified count on the file as it now stands after the B-1/T-9 changes
(which added a sixth).

No other file was touched. Status at this point in the packet's history:
READY_FOR_INDEPENDENT_VERIFICATION (Finding A addressed) — superseded by the Round-2
addendum below (G2A round-1 REJECT on B-1, now corrected).

---

## Round-2 addendum — 2026-08-24: G2A round-1 REJECT, blocking defect B-1, corrected

**Source:** `docs/prd-reviews/G2A-COLLAPSE-FIX-2026-08-24.md`, VERDICT: REJECT — one blocking
defect (B-1), introduced by this slice, undisclosed by both prior evidence packets.

### B-1 finding (as filed)

`autoReplyContext.ts:145` (pre-correction) wrote the elision entry IN PLACE at
`out[lastSelfIndex]` — the position of the OLD (first-seen) self-post reference — while
storing the MOST RECENT event's content and cursor association. Pre-fix (G1R correction (a)
as originally implemented by this Builder) that was harmless because the reference was always
the immediately-preceding slot; once the reference was changed to survive interleaving, the
write target could be arbitrarily far back in the `out` array, producing a non-monotonic
rendered `[#N]` cursor order in exactly the alternating live shape (measured by G2A:
`1, 14, 3, 5, 7, 9, 11, 13`). Consequences per G2A: (1) the model is told the agent's reply
preceded operator questions it actually answered after; (2) the "earlier replies" marker
asserts chronology it cannot prove; (3) the actor-blind subscription render strands the
agent's participation above apparently-unanswered operator questions, a plausible re-trigger
for loop-by-amnesia; (4) violates G1D D-B "preserving event order otherwise" and G1R delta
(iii) "in order" on their face.

### B-1 correction (the only production-code change made this round)

`packages/gateway/src/autoReplyContext.ts`, inside `collapseSelfRuns`'s near-duplicate-hit
branch, exactly as G2A specified:

```diff
       if (looksLikeNearDuplicateOfOwnRecent(ev.payload.text as string, prevText)) {
-        // Extend the reference: replace the kept representative with THIS
-        // (more recent) event, tallying how many were collapsed under it.
+        // Extend the reference: THIS (more recent) event becomes the kept
+        // representative ... (see full comment in source: removing the
+        // stale entry and pushing the new one at the end preserves event
+        // order; writing in place at the old slot does not).
         const priorCollapsed = 'elisionOf' in prevEntry ? prevEntry.collapsedCount : 0;
-        out[lastSelfIndex] = { elisionOf: ev, collapsedCount: priorCollapsed + 1 };
+        out.splice(lastSelfIndex, 1);
+        out.push({ elisionOf: ev, collapsedCount: priorCollapsed + 1 });
+        lastSelfIndex = out.length - 1;
         continue;
       }
```

Mechanism: on a near-duplicate hit, the stale entry at the old `lastSelfIndex` slot is
removed (`splice`), the new elision entry (carrying the newest event and the accumulated
`priorCollapsed + 1` count) is pushed at the current (end) position, and `lastSelfIndex` is
updated to point there. The marker count still accumulates correctly across multiple hops
(verified by T-6, unchanged, still green — see tallies below). Anchor/window blocks remain
independent (untouched). No other line in `collapseSelfRuns`, the predicate, the constants,
or the renderer was touched. This is the ONLY change to `autoReplyContext.ts` this round.

### T-9 (new obligation): order monotonicity

Added to `tests/agent-participation-collapse-live-shape.test.ts`, directly after T-4 (before
T-5), covering the exact T-4 alternating shape: asserts every rendered `[#N]` cursor token is
strictly increasing left-to-right, and that the surviving self-representative (the single
kept greeting) renders AFTER every operator message that preceded it in real
(channel_seq) time.

**T-9 RED capture (against the pre-B-1-fix logic, verified via an isolated scratch script —
not touching any tracked file or the shared git index, which had a live lock held by a
concurrent session throughout this round):**

```
node <scratch>/t9-red-check.mjs
```
```
PRE-B1-FIX (bug live): cursors = [1,2,3,4,5,6,7,8,9,10,11,24,13,15,17,19,21,23]
PRE-B1-FIX (bug live): monotonic = false
POST-B1-FIX (corrected): cursors = [1,2,3,4,5,6,7,8,9,10,11,13,15,17,19,21,23,24]
POST-B1-FIX (corrected): monotonic = true
---
T-9 RED (pre-fix must be non-monotonic): RED CONFIRMED
T-9 GREEN (post-fix must be monotonic): GREEN CONFIRMED
```

The pre-fix cursor sequence (`..., 11, 24, 13, 15, ...` — 24 appearing early, then dropping
back to 13) independently reproduces G2A's own cited symptom (`1, 14, 3, 5, 7, 9, 11, 13`)
almost exactly (differs only in filler-event count between G2A's desk-check shape and this
Builder's T-4 fixture, which includes 5 filler pairs) — same defect, same mechanism,
independently confirmed non-monotonic pre-fix and monotonic post-fix.

**T-9 GREEN capture (real test file, against the real built dist, post-fix):**
`npx vitest run tests/agent-participation-collapse-live-shape.test.ts` — T-9 passes as part
of the 10/10 result below.

### Incidental fix: T-4's stale "newest operator message last" assertion

Running the real (post-B-1-fix) code against the existing T-4 test revealed T-4's own final
assertion was inverted: it asserted "the last operator message is the last thing in the
window," but this shape's TRUE chronology is `(operator, greeting) x7` — the 7th greeting is
genuinely the newest event, posted after the 7th (last) operator message. That original
assertion only ever passed because of the B-1 bug (the surviving greeting used to render at
the OLD, stale slot instead of its true, most-recent position, coincidentally keeping it
before the last operator message in the rendered text). With B-1 fixed, the greeting
correctly renders last — which is objectively correct behavior — so T-4's stale assertion was
corrected to check the true invariant (the surviving representative renders after the last
operator message), matching what T-9 already independently verifies. This is a
test-file-only correction (no production code touched by it); the assertion was factually
wrong given the corrected system behavior, and correcting it is not a weakening — the
replacement assertion is a strictly accurate restatement of "self output must never precede
the human input it responds to," the same invariant the stale version was reaching for but
got backwards.

### Re-run tallies (post B-1-fix + T-9 + T-4 correction)

```
npx vitest run tests/agent-participation-collapse-live-shape.test.ts
```
```
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

```
npx vitest run tests/agent-participation-greeting-loop.test.ts
```
```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```
(unmodified, unweakened — obligations 5/6a/6b/7/8/9/10/11/14 all still pass)

```
npx vitest run tests/agent-participation-greeting-loop.test.ts \
  tests/agent-participation-configuration-readiness.test.ts \
  tests/collab-channel-membership-wire.test.ts \
  tests/agent-participation-collapse-live-shape.test.ts \
  tests/local-inference-model-routing.test.ts
```
```
 Test Files  5 passed (5)
      Tests  59 passed (59)
```
(58 from Round 1 + T-9 = 59)

```
pnpm typecheck
```
Exit 0, 14/14 tasks successful.

### Zero-diff re-confirmation

```
git diff --stat -- packages/gateway/src/autoReplyDispatcher.ts    # empty
git diff --stat -- packages/inference/src/ollama.ts               # empty
```
Both re-confirmed byte-identical to the pre-slice tree after the B-1 correction.

```
git diff --stat -- packages/gateway/src/autoReplyContext.ts
```
```
 packages/gateway/src/autoReplyContext.ts | 73 +++++++++++++++++++++++---------
 1 file changed, 52 insertions(+), 21 deletions(-)
```
(grown from the Round-1 42+/21- to 52+/21- — the additional 10 insertions are the B-1 fix's
3 replaced lines becoming 6, plus the expanded inline comment explaining why splice+push is
required instead of in-place write; still `collapseSelfRuns` + its immediately-surrounding
comment only, no other function touched)

```
git status --short tests/agent-participation-collapse-live-shape.test.ts
```
```
?? tests/agent-participation-collapse-live-shape.test.ts
```
Still untracked/new (never committed); the file now contains 10 tests (T-1/T-2, T-3, T-4,
T-9, T-5, T-6, T-7, rider outcome pin, rider disclosure, cleanup).

**Corrected `20000);` count (current file state, post T-9):**
```
grep -n "20000);" tests/agent-participation-collapse-live-shape.test.ts
```
```
139:  }, 20000);
337:  }, 20000);
410:  }, 20000);
485:  }, 20000);
515:  }, 20000);
563:  }, 20000);
```
Six occurrences on the CURRENT file (T-1, T-4, T-9 [new], T-5, T-6, T-7 — the rider tests and
cleanup do not use async DB/store fixtures and rely on the default timeout). This supersedes
both this round's and Round 1's counts, which were of two different, now-stale file
revisions; this is the count that matches the file as committed at the end of this round.

### Files touched this round

- `packages/gateway/src/autoReplyContext.ts` — the B-1 splice/push fix inside
  `collapseSelfRuns`'s near-duplicate branch (only).
- `tests/agent-participation-collapse-live-shape.test.ts` — added T-9; corrected T-4's stale
  inverted assertion (see above).
- `docs/prd-reviews/BUILD-EVIDENCE-COLLAPSE-FIX-2026-08-24.md` — this Round-2 addendum plus
  the miscount correction above.

No other file touched. `autoReplyDispatcher.ts` and `ollama.ts` remain byte-identical to the
pre-slice tree (re-confirmed above).

### Status

**READY_FOR_INDEPENDENT_VERIFICATION** — B-1 corrected exactly as specified (splice + push,
no other logic change), T-9 added and RED→GREEN captured both via an isolated scratch
reproduction and via the real built dist, T-4's now-inconsistent assertion corrected to match
the true (fixed) chronology, full named regression set green (59/59), dispatcher/ollama
zero-diff re-confirmed, and the prior evidence packet's `20000);` miscount corrected with a
dated note rather than silently overwritten.
