# G1R Gate-1 Verdict — Channels live defects packet (2026-08-24)

> Filed verbatim by the coordinator from the G1R seat's reply (seat has no Write tool). Verdict: REJECT, with an explicit path to APPROVE. Seat: DISCLOSED SUBSTITUTE, runtime claude-opus-5[1m] (Opus 4.7 not invocable); recorded as substitution.

## VERDICT: REJECT (two blockers)

**F-1 (BLOCKING) — D-A's root cause is FALSE; the proposed :550 hunk is a trust-boundary inversion.**
Persona already reaches the local model as a dedicated `role:'system'` message: `packages/inference/src/ollama.ts:278` (`validateManagedPersonaEnvelope(req)`), `:332-338` ("SUBORDINATE AGENT PERSONA (operator-authored) ... --- AGENT DIRECTIVES ---"), while `:339` wraps `payload.prompt` in `--- BEGIN UNTRUSTED CHANNEL CONTENT ---`. The envelope is set at `autoReplyDispatcher.ts:664`, revision/sha/turn-ownership cross-checked, refusal on mismatch (`MANAGED_AGENT_PERSONA_ENVELOPE_REFUSED`). Built dist verified current (contains the block; mtime newer than src). The packet measured `payload.prompt` — the field contractually REQUIRED to exclude persona — and declared a correct control absent ("measure the artifact" class, inverted). Injecting persona into `payload.prompt` would (i) duplicate operator directives inside the explicitly-untrusted region, giving channel text a forgeable neighbor, and (ii) feed persona text into `requestedLocalToolSequence`'s regex (`ollama.ts:296-299`), which can FORCE tool sequences on a deliberately text-only path (speech/action violation). REQUIRED: withdraw D-A; run a single-variable probe (T-1) capturing the ACTUAL messages array; the packet's raw-`/api/chat` probe changed persona framing AND window content simultaneously and discriminates nothing. Leading hypothesis (guess, source-derived): persona present; the 7 uncollapsed self-greetings (D-B) drove the imitation; D-B alone explains the silence.

**F-2 (BLOCKING) — window-wide per-actor collapse at 0.82 Jaccard is information-destroying and silently reverses parent ruling N-1 (obligation 6b, the amputation test).**
Jaccard over word sets is order-blind: "deploy the staging build to production" vs "deploy the production build to staging" = 1.0 → the chain-collapse would delete a decision reversal from the model's view while the operator still sees it; the "[N earlier replies omitted]" marker would then assert redundancy it cannot prove. "Keep most recent" also privileges the loop output over older substantive posts in exactly this defect shape. REQUIRED CORRECTION (a) — RECOMMENDED: keep run semantics but let the per-actor "last kept self-post" reference SURVIVE interleaving (other actors' messages and non-message events no longer reset it); collapse only on a near-duplicate hit against that reference. Handles the alternating live shape; amputation test stays green unmodified. Alternative (b) window-wide EXACT-match-only, keep earliest — inferior, not recommended.

## Rulings
- (2) Do NOT reuse assembleSubscriptionPrompt on the local path — subscription has no system-role seam (string-flattening + JSON trailer is its only defense); local HAS the role seam and already uses it. The paths are correctly different.
- (3) AC-4 (cron byte-identical) holds trivially — cron never passes selfPrincipalId — and therefore proves nothing about the collapse change. Keep, but T-4 is the real guard.
- (5) Parent invariants at risk in the packet as written: N-1 reversal unacknowledged; speech/action (tool-sequence regex); marker honesty (§2a spirit). One-terminal and never-retry unaffected.

## Unfreeze grants
- `autoReplyDispatcher.ts`: **ZERO new hunks. Frozen at the PR #59 two-hunk state.** :550 persona hunk DENIED (F-1). B-FOLLOWUP-2 (:719 guard) DEFERRED to its own slice — intended form: extract the inlined guard (:780-824) into autoReplyContext.ts and call from both branches (one small hunk), only after F-2 settles. Recorded as accepted residual R-1.
- `autoReplyContext.ts`: NOT frozen; edits bounded to `collapseSelfRuns` (:109-137) + its doc comment, per correction (a)/(b). PROHIBITED: threshold/min-length constants, `looksLikeNearDuplicateOfOwnRecent`, ANCHOR/WINDOW counts, subscription renderer actor-blindness, the `selfPrincipalId ?` ternaries.
- `packages/inference/src/ollama.ts`: not frozen but NOT authorized this slice. A real persona gap (if T-1 finds one) is a NEW packet.
- Tests: additions unrestricted; deleting/weakening any existing assertion prohibited (esp. greeting-loop obligations 6a/6b/7/8).

## Required test obligations
- **T-1 (FIRST, before any code):** capture the actual Ollama `messages` array for a dispatched local auto-turn (via executeLocalEdge with the real envelope plumbing); assert the persona system message is present → close D-A as NOT-A-DEFECT, or report the true mechanism before proposing any fix.
- **T-2:** assert `payload.prompt` contains NO persona content (pins the trust separation; replaces the packet's AC-2).
- **T-3:** hostile amputation pair — two self-posts with identical normalized word sets in different order, separated by an operator message; BOTH survive. Must be RED against window-wide Jaccard, GREEN against correction (a).
- **T-4:** the live shape — alternating 7 near-identical agent greetings / 7 distinct operator messages: ≤1 greeting survives, marker present, ALL operator messages survive verbatim in order, newest operator message last. RED against current code.
- **T-5:** deletion probe — removing the collapse call flips T-4 RED.
- **T-6:** marker honesty — count equals items omitted; never consumes non-message events or other actors.
- **T-7:** constant parity — context constants equal the dispatcher guard's inlined literals (read from source text).
- **T-8:** full greeting-loop + configuration-readiness + membership-wire suites green; `git diff` proves autoReplyDispatcher.ts = ZERO hunks vs 8209d30... (post-#59 tree).

## Non-blocking
NB-1 doc comment at dispatcher :549 naming where persona travels (rider). NB-2 contextSize/estimatedTokens undercount (pre-existing; record only). NB-3 B-FOLLOWUP-1 seat-lattice pin is test-only and may proceed in parallel. NB-4 G2A's cron row was accurate but not load-bearing for collapse coverage.

## Residual risks
R-1 subscription branch stays guard-free this slice (window collapse + commit re-check mitigate). R-2 threshold not corpus-fit; commit-time guard is the fail-closed second line. R-3 authorizeOperator fail-open default still open. R-4 packet's live evidence partially misread; every finding here re-derived from source.

## Path to APPROVE
T-1 run and reported honestly; D-A withdrawn or re-diagnosed single-variable; F-2 respecified as correction (a) with T-3 RED against window-wide Jaccard. Zero dispatcher unfreeze; one non-frozen file + tests.

---

# DELTA RULING (same G1R seat, 2026-08-24) — Builder's T-3 disclosure: ACCEPT-AS-RESIDUAL

The Builder implemented correction (a) exactly and disclosed that the original T-3 hostile pair elides under it. On review: **T-3 as originally written was an incoherent obligation** — it demanded behavior the mandated mechanism cannot produce with the predicate this verdict prohibited changing ("the amputation test stays green under (a)" was true only for the obligation-6b pair, not the hostile pair; both statements were this seat's and were inconsistent). The Builder's response — implement, measure, disclose, no unauthorized order-sensitivity — was correct.

**Not reopened, on the merits:** the hostile pair's loss under (a) is strictly narrower than the window-wide exposure F-2 blocked — the pair must be consecutive in the agent's own self-post chain; any intervening non-duplicate self-post resets the reference; other actors' messages are never collapsed; the most recent (currently-operative) statement is always kept.

**T-3 respecified:** the hostile pair must (i) elide with the MOST RECENT member kept verbatim, (ii) emit a marker whose count equals exactly the number omitted, (iii) leave the interleaved operator message uncollapsed and in order. The retained amputation guarantee is obligation 6b's real one: distinct self-posts below the near-duplicate threshold are never collapsed, at any distance.

**Residual R-5 (accepted, for the record):** an order-inverted same-word-set self-restatement in exact self-chain adjacency (Jaccard 1.0, order-blind set predicate) elides, keeping the reversing statement plus a count marker; the superseded statement leaves the model's window only — the channel record in collab_events remains intact and operator-visible; the commit-time guard (autoReplyDispatcher.ts:780-824) is unchanged and fails closed. Accepted rather than fixed because closing it requires editing `looksLikeNearDuplicateOfOwnRecent` (prohibited; would desynchronize the dispatcher's inlined copy — recorded drift hazard). Revisit only if a live self-reversal is observed being lost.

**Standing:** T-1/T-2/F-1 not discharged by this delta (D-A portion); T-4..T-8 stand; T-7 constant parity is now load-bearing for R-5's bound. Independently verified before ruling: autoReplyContext.ts:109-150 implements (a); dispatcher and ollama.ts zero-diff at HEAD 3361b75.
