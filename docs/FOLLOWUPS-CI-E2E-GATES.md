# FOLLOW-UPS — CI e2e gates & PR dispositions (staged 2026-08-19)

Staged by the G2A seat after the #47 CI repair sequence. Each item is scoped
enough to hand to a builder directly. Nothing here is blocking #47's merge
unless marked otherwise.

## 1. `e2e-channel` (CI step "http channel adapter") — RED, needs harness modernization

**Status:** the ONLY remaining red e2e step as of run `32212529483`. All other
steps pass: vitest 131/131 files, production-launch (fixed `952e547`),
e2e.mjs, e2e-approval.mjs, approval-cloud (fixed `9152543`), cancel, budget.

**Symptom:** `POST /task` through the channel-http adapter returns
`HTTP 502 {"ok":false,"error":"task failed","sessionId":""}`, then
`=== E2E FAIL (no clean RESULT from the channel) ===`.

**Best-current hypothesis (unverified — first thing to check):** the channel
adapter's gateway connection fails to authenticate in the collab-era auth
shape. The adapter logs `CHANNEL_HTTP_TOKEN unset — accepting all callers
(loopback dev only)`, while the gateway's `connectionAuth` channel-service
path returns null when `deps.channelServiceToken` is unset. The `502` body
carries an empty `sessionId`, consistent with a task whose gateway session
never established. `authz.ts` itself is NOT the suspect: the channel seat is
allowed `SUBMIT_PROMPT` (`authz.ts:100`).

**Build note:** same class as the two already-fixed gates — an e2e written
for the pre-hardening auth contract. Decide deliberately whether the dev-mode
contract for channel-http is "both tokens unset ⇒ loopback dev accepted" (then
fix the gateway side to honor it) or "tokens required always" (then fix the
e2e to set matching `TORQCLAW_CHANNEL_SERVICE_TOKEN` / `CHANNEL_HTTP_TOKEN`).
Do not relax the production guard (`requireProductionTokens`) to make it pass.

## 2. `ops/doctor.mjs:62` — same legacy-token staleness (not CI-gated)

The standalone CLI doctor connects with
`token: process.env.TORQCLAW_GATEWAY_TOKEN || ''`. Against a production
runtime (where that variable is forbidden and the server's root token is
empty) it will always report gateway-down. Either give it the surface-
credential path (read `<dataDir>/operator-credential.token` after bootstrap,
or accept a `--credential` arg) or mark it dev-only in its banner.

## 3. PR dispositions (post-#47 merge)

- **#47** — merge when CI goes green (one red step left, item 1 above).
- **#46** (`w3/phase0-profile-conformance`) — **close unmerged.** Superseded:
  all three of its files exist on master in evolved form (the conformance
  suite was re-landed and grew; `ba7caea` extended it). CONFLICTING anyway.
- **#45** (`docs/claude-md-refresh`) — **close, or rewrite fresh.** Merges
  cleanly but its content predates the entire collab program (005/007, seat
  tables, standing rules); merging it would silently revert CLAUDE.md to a
  pre-collab state. A consolidation should be rewritten against current
  master, not rebased.

## 4. Carried obligations already on record (pointers, not new work)

- `docs/prd-reviews/G2A-OPUS48-COLLAB-PRESENCE-UI-005-S3-S4-PASS3.md` — CO-S3-1
  (ERROR frames invisible to the console; gateway-wide envelope fix),
  NB-P3-1 (`awaitingConfirm` limbo), NB-RA-1/2.
- `docs/prd-reviews/G2A-OPUS48-COLLAB-PRESENCE-UI-005-S5.md` — C-S5-1 (T-11
  roster fixture must cover the populated Working-now branch), C-S5-2
  (Working-now label scope) + S5b (self-only principalId on CONNECTED, with
  G1R's disclosure analysis).
- `docs/prd-reviews/G2A-OPUS48-AGENT-PARTICIPATION-S2.md` — C-S2-1 (commit the
  `_meta` spoof probe as a permanent test), NB-S2-1 (invert the collab_write
  classifier to fail-closed), N-S2-4 (missing drift-guard test), and the
  binding S3 condition (auto-reply needs STOP or a per-principal post-rate
  bound — STOP exists now; the rate bound was ruled satisfied-by-STOP? —
  verify against the shipped S3 before S4-scale deployment).
- `docs/prd-reviews/G2A-OPUS48-AGENT-PARTICIPATION-S0-S1-SELFHEAL.md` — C-1 /
  B-S0-1 (booted flag-off consumer-side test for the S0 fence; WIP was in
  flight — check if it landed).
- `docs/prd-reviews/G2A-OPUS48-A3C-STRUCTURAL-FIX.md` — C-1 (coalesced-path
  self-reply guard), NB-1 (deterministic-failure retry contradicts header
  claim 4), NB-2 (vacuous DETECTOR PROOF test), NB-3 (stale validator pointer).
- `docs/prd-reviews/G2A-OPUS48-CRON.md` — C-1 was FIXED (`64f579a`,
  idempotencyKey now honored). NB-1 (commit G1R's poison-router FRONTIER
  test), NB-2 (FALSIFIABILITY title), NB-3 (unmodeled mid-turn refusals →
  no_post), NB-4 (recovered run drops promptHint), NB-5 (recovery not
  flag-gated — needs an explicit decision).
- **OQ-4 / SB2b** (PRD-006 sandbox): operator ruling owed on editing vendored
  `approval.py` (two live sites). G2A's assessment is on record in session:
  option (a) with (d)'s discipline, SA-8 as a permanent RED-on-revert gate.
  SB2b is BLOCKED until ruled.
