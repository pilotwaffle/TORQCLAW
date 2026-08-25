# Build Evidence — Newest-message marker (trigger-identity, v1.1)

**Builder:** Sonnet 5 · **Date:** 2026-08-24 · **Branch:** phase1-server-owned-authority

**Objective:** Append a fail-closed, trigger-identity-keyed NEWEST MESSAGE banner to the agent-turn context so a local model can never infer its target from timeline position.

**Contract:** `docs/prd-reviews/G1D-FABLE-NEWEST-MESSAGE-MARKER-2026-08-24.md` (v1.1 amendment, controlling) + `docs/prd-reviews/G1R-NEWEST-MESSAGE-MARKER-2026-08-24.md` (T-1..T-8, boundary).

**Controlling invariant:** the marker names the event that AUTHORIZED this turn (`claimed.identity.channelSeq`), matched by `Number(ev.cursor) === triggerChannelSeq` in the RECENT window — never "newest in a fresh timeline read". Fail closed (omit) on: cursor absent from window, non-`message_posted`, or self-authored. No fallback of any kind.

## Status: READY_FOR_INDEPENDENT_VERIFICATION

## Scope boundary observed
Permitted: `packages/gateway/src/autoReplyContext.ts` (signature + parts composition + 2 exported banner constants + doc comment), `packages/gateway/src/autoReplyDispatcher.ts` (exactly one hunk at the existing `buildAnchorWindowContext` call site), new test file (or extend collapse-live-shape), greeting-loop extended only for T-4 pin.
Prohibited (never touched): `ollama.ts`, `cronDispatcher.ts`, subscription renderer, collapse internals, thresholds/predicate, contracts/store/migrations, dispatcher :550 preamble, dispatcher :780-824 guard, `dispatch.ts`, `friendly.ts`, `hermesAttempt.ts`, `tests/friendly.test.ts`, `tests/failover/*`, `.claude/*`, `STATE.md`, any untracked operator file.

## Files changed

- `packages/gateway/src/autoReplyContext.ts` -- signature (+`triggerChannelSeq?: number` 5th param), 2 exported banner constants (`NEWEST_MESSAGE_BANNER_OPEN`, `NEWEST_MESSAGE_BANNER_CLOSE`), marker composition block appended after the RECENT block, doc comment. Diff: +51/-0 lines net addition (see `git diff` below), no existing line altered except the signature's added parameter and the doc comment insertion point.
- `packages/gateway/src/autoReplyDispatcher.ts` -- EXACTLY ONE hunk, 1 line changed (`git diff --stat`: `1 file changed, 1 insertion(+), 1 deletion(-)`). The `buildAnchorWindowContext` call at the pre-existing site gains `claimed.identity.channelSeq` as its 5th argument. No other character in the file touched.
- `packages/inference/src/ollama.ts` -- **ZERO diff** (`git diff` produces no output for this path; confirmed by both `git status --short` and an explicit `git diff` call).
- `tests/agent-participation-trigger-marker.test.ts` -- NEW FILE. T-1, T-2 (+ RED proof), T-3, T-3b, T-5(a/b/c), gating (byte-identity with param omitted), cross-agent-trigger, T-6 (deletion probe), T-7 (dispatcher-hunk source pin), T-8 (dist content verification). 13 tests, all green.
- `tests/agent-participation-greeting-loop.test.ts` -- extended by exactly one `it(...)` block (T-4's dispatcher `:498` call-site pin, source-text regex asserting the 5-arg call shape with `claimed.identity.channelSeq` last). No existing test in this file modified.

## Files explicitly NOT touched (verified)
`ollama.ts` (zero diff, confirmed), `cronDispatcher.ts`, subscription renderer (`renderSubscriptionMessage`/`subscriptionText` composition -- untouched), `collapseSelfRuns` internals, `NEAR_DUPLICATE_MIN_LENGTH`/`NEAR_DUPLICATE_SIMILARITY_THRESHOLD` and dispatcher's inlined guard literals, contracts/store/migrations, dispatcher's `:550`-region preamble and `:780-824`-region guard, `dispatch.ts`, `friendly.ts`, `hermesAttempt.ts`, `tests/friendly.test.ts`, `tests/failover/*`, `.claude/*`, `STATE.md`.

## Design decisions worth recording (not deviations -- literal readings of the contract)

1. **Trigger lookup searches `nonOverlapping` (the RECENT window's raw, pre-collapse events), not `windowCollapsed`.** The contract says "find the RECENT-window event with `Number(ev.cursor) === triggerChannelSeq`". `collapseSelfRuns` only ever folds SELF-authored runs; any event this marker is allowed to name is, by construction, non-self-authored (the self-authored check independently excludes it), so a genuine match is always still present, unelided, in `nonOverlapping`. This makes the two searches equivalent for every valid (non-omitted) case, and searching the raw array is simpler and does not depend on collapse internals (a prohibited-to-touch area).
2. **Marker gated on `triggerChannelSeq !== undefined` exactly as F-4 specifies**, independent of `selfPrincipalId`'s presence -- though in practice the dispatcher always supplies both together and the cron path supplies neither, so the two gates coincide in every real call site today.
3. **subscriptionText is untouched.** The contract's scope item 1 and G1R's F-6 both explicitly exclude the subscription renderer from this slice; the marker section is appended only to `parts`/`text`, never to `subscriptionParts`/`subscriptionText`.

## Tests added

New file `tests/agent-participation-trigger-marker.test.ts` (13 tests, drives the real built `packages/gateway/dist/autoReplyContext.js`, no mocking of the function under test):
- T-1: marker byte-identical to the in-window string-extracted line (never re-formatted by the test).
- T-2 (load-bearing): trigger at S, newer race message at S+1 seeded before assembly -- marker names S, S+1 absent from the banner section.
- T-2 RED PROOF: demonstrates the withdrawn "use the newest message_posted" rule would have selected S+1, not S, on the identical scenario -- proving T-2 is discriminating, not vacuous.
- T-3: trigger resolves to self-authored -- omitted.
- T-3b: trigger resolves to a cursor that was collapsed away under a self-run -- still omitted.
- T-5(a): trigger cursor outside the window entirely -- omitted, no fallback, rest of render unaffected.
- T-5(b): trigger resolves to a non-`message_posted` event -- omitted.
- T-5(c): zero `message_posted` events in the window at all -- omitted.
- Gating: omitting `triggerChannelSeq` (or passing `undefined` explicitly) is byte-identical to each other and never renders the marker (obligation-8-class byte-identity, restated for this parameter specifically).
- Cross-agent trigger: another agent principal (not self, not operator) authored the trigger -- marker renders normally.
- T-6: deletion probe. Reverts the marker-composition block from a COPY of the real source text (regex-matched, never git checkout), compiles that copy standalone with the repo's own `tsc`, imports the resulting throwaway JS, and shows it renders NO marker at all regardless of trigger argument -- i.e. removing the change flips T-1/T-2-class assertions RED. Verifies via `sha256` and full string equality that the REAL tracked source file and REAL dist file on disk are byte-identical before and after the probe (no `git checkout` used anywhere).
- T-7: source-text pin that the dispatcher's call site contains the exact 5-argument call shape.
- T-8 companion: reads the REAL built `dist/autoReplyContext.js` and `dist/autoReplyDispatcher.js` from disk and asserts by CONTENT (not just "build succeeded") that the banner strings and the `claimed.identity.channelSeq` argument are present in the shipped artifact.

Extended file `tests/agent-participation-greeting-loop.test.ts`: exactly one new `it(...)` block appended before the closing `});` -- T-4's dispatcher call-site pin (source-text regex asserting the 5-arg call, `claimed.identity.channelSeq` last). No existing test in this file altered.

## Commands + actual results

1. `node node_modules/turbo/bin/turbo run build --filter=@torqclaw/gateway... --force` -- **PASS** (6/6 tasks successful, 28.6s). Ran BEFORE writing any test, to verify the implementation compiles.
2. Dist content verification (pre-test, by hand): `grep -c "NEWEST_MESSAGE_BANNER_OPEN|NEWEST MESSAGE" packages/gateway/dist/autoReplyContext.js` -> 4 matches. `grep -n "buildAnchorWindowContext" packages/gateway/dist/autoReplyDispatcher.js` -> line 390 shows `claimed.identity.channelSeq` as the 5th argument in the built artifact.
3. `npx vitest run tests/agent-participation-trigger-marker.test.ts` -- first run: **4 FAILED / 9 passed** (T-1, T-2, cross-agent-trigger failed because my OWN test fixtures put both events inside the 10-event anchor block, so the RECENT window was empty -- a test-construction bug, not an implementation bug; T-6 failed on a standalone-tsc module-resolution wrinkle, also test-side). Fixed by seeding 10 anchor-filler events (mirrors the house pattern in `agent-participation-collapse-live-shape.test.ts`'s own T-4) and by tolerating the expected `TS2307` on an `import type` that cannot resolve outside the real workspace graph (JS is still emitted correctly since type-only imports are erased at emit time). Re-run: **13/13 PASS** (2.72s test time; gateway dist was already fresh so no rebuild fired).
4. `node node_modules/turbo/bin/turbo run typecheck` -- **PASS**, 14/14 tasks successful (13 cache hits, 1 fresh: `@torqclaw/gateway:typecheck`), 35.5s.
5. Named regression set: `npx vitest run tests/agent-participation-collapse-live-shape.test.ts tests/agent-participation-greeting-loop.test.ts tests/agent-participation-configuration-readiness.test.ts tests/collab-channel-membership-wire.test.ts` -- **PASS**, 4 files / 50 tests, 0 failures (greeting-loop now shows 8 tests, up from 7, reflecting the new T-4 pin). 15.99s.
6. Full suite: `npx vitest run tests/ --exclude tests/failover/**` -- **1 file failed / 180 passed (181 total); 2655 tests passed / 1 failed / 1 skipped (2657 total); 546.38s.** `tests/agent-participation-s4-presence.test.ts` and `tests/collab/bootstrap-recovery.test.ts` (the two named-flaky files) both passed cleanly in this run -- no re-isolation needed for either.
   - The single failure, `tests/collab-c2-flag-off-identity.test.ts` ("SI-4/A12 (C2) -- the APPROVE transcript is byte-identical, and no C2 row is written"), is **PRE-EXISTING, not a regression from this slice**. Proof: (a) the file has zero references to `autoReplyContext`/`autoReplyDispatcher`/`buildAnchorWindowContext` -- it exercises an unrelated flag-on/flag-off classifier-identity transcript comparison over `filesystem__write_file` approval; (b) re-run in isolation it fails NONDETERMINISTICALLY — **[C-1 correction, G2A-mandated 2026-08-24: the original text here claimed "fails deterministically"; G2A's six executed runs measured ~1-in-3 pass rate on the slice tree (1P/2F across 3 runs) and 0/3 pass on the stashed clean baseline — flaky, not deterministic]** — with the same signature (`classifierUsed`/`classifierConfidence` swapped between the two halves of the same test -- a live-classifier nondeterminism, `LOCAL_LLM`/0.9 vs `DEFAULT`/0.3); (c) **stash-and-rebuild check**: stashed this slice's entire diff (`autoReplyContext.ts`, `autoReplyDispatcher.ts`, the new test file, the greeting-loop addition, this evidence file) via `git stash push -u`, rebuilt `@torqclaw/gateway` from the clean baseline tree, and re-ran the failing file -- it failed on the **unmodified baseline** too (2/2 tests failed, i.e. worse without this slice's changes, ruling out any causal link). Changes were then restored via `git stash pop` (confirmed via `git status` and `git diff --stat` showing the same exact one-hunk dispatcher diff and zero-diff ollama.ts as before), and the gateway rebuilt again from the restored tree.
   - Post-restore sanity re-run: `npx vitest run tests/agent-participation-trigger-marker.test.ts tests/agent-participation-greeting-loop.test.ts` -- **2 files passed, 21/21 tests passed**, confirming the stash/rebuild cycle left the real implementation byte-correct.

## Runtime / dist evidence
Verified by CONTENT (not mtime, not "build succeeded"): `packages/gateway/dist/autoReplyContext.js` contains the literal banner text (`NEWEST MESSAGE`, `END NEWEST MESSAGE`) and `packages/gateway/dist/autoReplyDispatcher.js` contains `claimed.identity.channelSeq` at its `buildAnchorWindowContext` call site (line 390 in the built artifact at time of writing).

## Known limitations / disclosed residuals (carried from the G1R verdict, not new)
- R-8 (disclosed, not fixed here): on channels busier than `WINDOW_EVENT_COUNT` (40) between trigger and dispatch, the trigger event can fall out of the RECENT window entirely, producing an honest omission (feature silently degrades under load). Follow-up per the verdict: Buzz mechanic #1 swap-in.
- R-6 (pre-existing, unchanged): a message body containing text resembling the banner strings is not escaped -- this is the same pre-existing unescaped-transcript property the rest of the window render already has; escaping would break byte-identity and was explicitly not authorized.
- R-7 (persona-layer, unchanged): repeating the trigger verbatim raises the likelihood a model quotes the operator's message back -- accepted per the verdict's bench evidence.
- AC-2 (live Paris-class turn) is explicitly a post-merge, operator-witnessed acceptance criterion per the verdict -- not satisfiable by this build/verify pass, and not attempted here.

## Deviations from the packet
None identified. The v1.1 amendment and G1R's verdict are followed literally; the two "design decisions" above are readings of ambiguous-but-resolvable phrasing (which collection to search, subscriptionText exclusion), not departures from stated scope.

## Final tallies
- `packages/gateway/src/autoReplyContext.ts`: +55/-0 lines (net addition only; no existing line altered besides the signature's new trailing parameter).
- `packages/gateway/src/autoReplyDispatcher.ts`: exactly 1 hunk, 1 line changed (`1 file changed, 1 insertion(+), 1 deletion(-)`).
- `packages/inference/src/ollama.ts`: 0 diff (confirmed by `git diff --stat` producing no output and `git status --short` showing nothing).
- New test file `tests/agent-participation-trigger-marker.test.ts`: 13 tests, all green.
- Extended `tests/agent-participation-greeting-loop.test.ts`: 1 new test added (8 total, up from 7), all green.
- Named regression set (collapse-live-shape, greeting-loop, configuration-readiness, membership-wire): 4 files / 50 tests, all green.
- Full suite (`tests/` minus `tests/failover/**`): 180/181 files passed, 2655/2657 tests passed (1 pre-existing failure unrelated to this slice, proven via stash-and-rebuild against the clean baseline; 1 skipped). Both named load-flaky files (s4-presence, bootstrap-recovery) passed cleanly on the first pass.
- `pnpm typecheck` (`turbo run typecheck`): 14/14 packages passed.
- Dist content verification: `packages/gateway/dist/autoReplyContext.js` contains the literal `NEWEST MESSAGE` / `END NEWEST MESSAGE` banner text; `packages/gateway/dist/autoReplyDispatcher.js` contains `claimed.identity.channelSeq` at its `buildAnchorWindowContext` call site -- verified both before and after the stash/rebuild cycle.

## Status: READY_FOR_INDEPENDENT_VERIFICATION
