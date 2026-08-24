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

**Update 2026-08-23 (docs-truth pass) — verified.** Token provisioning is
**already present** in the e2e harness: `ops/e2e-channel.mjs:63` and `:68`
pass `TORQCLAW_CHANNEL_SERVICE_TOKEN: CHANNEL_TOKEN` when launching the
gateway and the http-channel process respectively. The operator's 2026-08-23
ruling ("tokens-required-always") is recorded as **ratifying the conditional
contract already in `ops/launcher-config.mjs:48-54`** (`requireEnabledChannelCredential`:
a non-placeholder `TORQCLAW_CHANNEL_SERVICE_TOKEN` is required **if and only
if** `TORQCLAW_HTTP_CHANNEL === '1'`) — **not** as authorizing an unconditional
token requirement that would apply even when the HTTP channel is disabled.
**The actual CI-red cause remains UNKNOWN/undiagnosed.** This item is
explicitly NOT fixed by this docs-truth pass; the 502 symptom above still
needs live diagnosis.

## 2. `ops/doctor.mjs:62` — same legacy-token staleness (not CI-gated) — **CLOSED 2026-08-23**

~~The standalone CLI doctor connects with
`token: process.env.TORQCLAW_GATEWAY_TOKEN || ''`. Against a production
runtime (where that variable is forbidden and the server's root token is
empty) it will always report gateway-down. Either give it the surface-
credential path (read `<dataDir>/operator-credential.token` after bootstrap,
or accept a `--credential` arg) or mark it dev-only in its banner.~~

**Verified 2026-08-23: already fixed.** `ops/doctor.mjs:75-95`
(`resolveDoctorAuth`) ships the fail-loud credential path this item asked
for: it tries `TORQCLAW_OPERATOR_CREDENTIAL`, then falls back to reading
`<dataDir>/operator-credential.token` (`:81-88`), and only in production with
neither present does it return `{ kind: 'problem', ... }` — which
`ops/doctor.mjs:132-137` records as `record('gateway', 'fail', ...)`, an
explicit non-degrading failure (comment: "A structural inability to
authenticate is NOT a healthy gateway and is NOT a warning"), not a silent
"gateway down" misreport. No degrade-to-OK fallback exists in this path.

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

## 5. Rulings owed (not buildable by agents — operator decisions, recorded so they survive session restarts)

- **suspendAgent zombie schedules** — same shape as the revoke fix (`f2397fb`) but deliberately NOT fixed: suspend is reversible, revoke is not. Orchestrator's lean: leave as-is. Needs an operator confirm or override.
- **OQ-2 (PRD-007 S4)** — is "working now" an explicit entitlement? Blocks the S4 presence overlay. G1R's disclosure analysis (self-only `principalId` on CONNECTED as S5b) is the designed-enough answer; awaiting operator ruling.
- **OQ-4 (PRD-006 sandbox)** — editing vendored `approval.py` at two live guard sites (`check_all_command_guards` `:1283-1284`, `check_execute_code_guard` `:1597-1598`; `check_dangerous_command` is dead code). Wrapper-only workaround is proven dead (one `env_type` drives both guard and backend). **G2A's standing recommendation: option (a) with (d)'s discipline — edit the two sites, pin them with SA-8 as a permanent RED-on-revert gate.** SB2b is BLOCKED until ruled.

## 4. Carried obligations already on record (pointers, not new work)

- **CO-9 (`CollabError`-code throwing-getter, `docs/prd-reviews/G2A-OPUS-COLLAB-PRESENCE-UI-005-S1-REAUDIT.md:348`) — verified 2026-08-23, disposition unchanged: conditional-future, no reachable defect.** `CollabError.code` (`packages/collab/src/store.ts:110`) is a plain data property (`readonly code: CollabErrorCode`), not a throwing accessor; zero `get code()` accessors exist in `packages/collab/src/`. Revisit only if a non-`CollabError` throw source is introduced. The one owed edit is the A6(b) parenthetical noted in `docs/prd-reviews/G1R-OPUS-COLLAB-PRESENCE-UI-005-A6-T9.md` (see that file's NB-4).
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

## ESLint adoption (filed 2026-08-23)

Filed per B-6 (G1D-FABLE-CLEANUP-DOCS-TRUTH-2026-08-23's resolution of G1R
findings): item 9's original scope ("if ESLint config exists anywhere, wire
`lint` tasks; if none exists, add a minimal flat-config ESLint... to the TS
packages") was struck for this slice. `pnpm lint` was made honestly
self-describing instead (exits 0, stdout states plainly that lint is not
configured) — see `ops/lint-not-configured.mjs` and
`tests/lint-gate-honesty.test.ts`. This entry is the scoped follow-up task
for actually adopting ESLint, so the gap does not go unrecorded.

**Packages in scope** (first-party TS workspace packages only — vendored
`engines/hermes_kernel/vendor/hermes-agent` already has its own ESLint
configs under `apps/desktop`, `web`, `ui-tui` and is explicitly OUT of
scope; CLAUDE.md's "do not rewrite vendored upstream" applies):
- `apps/console`
- `packages/bridge`
- `packages/collab`
- `packages/contracts`
- `packages/gateway`
- `packages/inference`
- `packages/router`
- `packages/channel-http` (if present as a workspace package at adoption time)

**Rule set — correctness-only, no stylistic churn.** The explicit intent
(per B-6: "recommended rules, no stylistic churn; errors only for
correctness classes") is to catch real defects, not to relitigate this
repo's existing formatting. Minimum bar:
- `@typescript-eslint/recommended` (type-aware correctness rules: no-floating-promises,
  no-misused-promises, no-unnecessary-condition where practical) — NOT
  `@typescript-eslint/recommended-requiring-type-checking`'s stylistic
  siblings, and NOT `@typescript-eslint/stylistic`.
  See docs/security/profile-conformance.md and CLAUDE.md §4 invariants for
  the shapes a correctness lint pass should NOT be tempted to "fix" (e.g.
  contract-validated frame handling, seq-cursor resume logic) without
  understanding why they are written the way they are.
- `eslint-plugin-import`'s `no-cycle` and `no-self-import` (this repo's
  reachability/orphan-module discipline already checks structure at the
  package level via `pnpm reachability`; a lint-level cycle check catches
  the file-level case that gate does not).
- No stylistic rule additions (no `prettier`/formatting-plugin wiring as part
  of this task — a separate, explicitly-scoped follow-up if ever wanted).
- No new runtime dependency; ESLint and its plugins are devDependencies only,
  scoped to the packages listed above (or hoisted to the workspace root if
  that is cheaper to maintain — implementer's call, but keep it OUT of
  vendored `engines/hermes_kernel/vendor/hermes-agent`).

**Findings owner:** the operator. This task's implementer wires the lint
tooling and gets it running clean (or with a documented, explicitly-approved
baseline suppression list) — it does NOT unilaterally "fix" every finding it
surfaces. Findings that look like real bugs get reported to the operator
for a ruling on priority and correct fix, per this repo's "no drive-by
cleanup" discipline (CLAUDE.md §4, Change scoping) and the standing rule
that Builder-tier work stays inside its approved scope.

**Acceptance for the adoption task itself:** `pnpm lint` runs a REAL linter
across the packages listed above and exits non-zero on an introduced
correctness violation (proven with a throwaway RED case, e.g. an
unreachable `no-floating-promises` violation, removed before commit); the
root `lint` script is updated to invoke the real tool instead of
`ops/lint-not-configured.mjs`; `tests/lint-gate-honesty.test.ts`'s
"root package.json no longer routes lint through turbo" assertion is
revisited (superseded, not deleted) once turbo is reintroduced as the
task orchestrator, if that is the chosen wiring.
