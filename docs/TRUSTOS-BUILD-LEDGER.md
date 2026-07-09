# TORQCLAW TrustOS — Build Ledger

Program: PRD-TCLAW-TRUSTOS-001 rev 1.2 · Orchestrator: Fable 5 (G1D)
Role mapping note: G1R and G2A run as independent Opus instances; GLM-5.2 (RB) unavailable in this harness — substitutions are logged per ticket.

## Ticket log

### TCLAW-0A (stage v0) — CI pipeline: TypeScript core

- date: 2026-07-08
- branch: master @ c206d7a (committed: 0251bf4 docs, c206d7a ci; pushed to origin 2026-07-08)
- ticket: TCLAW-0A stage v0 (PRD §9.0.2)
- what changed: new file `.github/workflows/ci.yml` — push-to-master + PR triggers, ubuntu-latest, timeout 15m, checkout (no submodules), pnpm via packageManager field, Node 22 (required by --experimental-strip-types in contracts build), steps: install --frozen-lockfile → contracts build → typecheck → test. No other files touched; turbo.json ruled not-required (root test script is direct vitest, documented deviation from PRD line "add test to turbo pipeline").
- tests/checks run: local `pnpm install --frozen-lockfile` PASS, contracts build PASS (3 schemas × 2 dirs), `pnpm typecheck` PASS (12/12), `pnpm test` PASS (94/94); G2A independently re-ran contracts build + tests, 94/94 confirmed.
- G1R: not required (infra-only, no security/routing/approval/cost/contract-semantics surface).
- G2A result: PASS. Informational notes: (1) turbo test-task deviation should be mentioned in PR text; (2) consider concurrency + explicit permissions block at CI v1.
- github verification: CI run 28988129021 on c206d7a GREEN (all steps passed). Runner annotation: actions @v4 majors target deprecated Node 20 - bump action versions at CI v1.
- next ticket: TCLAW-10A (contracts:check drift gate + ConnectFrame emission + golden fixtures), then CI v1 wiring back into TCLAW-0A.
- blockers: none. TICKET COMPLETE AND ACCEPTED. Operator approved commit+push 2026-07-08.

### TCLAW-10A — contracts drift gate, ConnectFrame emission, golden fixtures

- date: 2026-07-08
- branch: master @ dcce64d (committed: 92e8515 feat, eedcc28 chore, dcce64d docs; pushed 2026-07-08; CI run 28990952999 GREEN; all 8 schema artifacts i/lf w/lf)
- ticket: TCLAW-10A (PRD §9.10.3, Epic 10 scope pulled into Phase 0)
- what changed: emit-schemas.ts emits ConnectFrame as 4th artifact (4 schemas × 2 dirs); new check-schemas.ts drift gate (re-emit to OS temp dir, file-set assertion + parsed-JSON deep-equality against both dirs, exit 1 on drift); scripts wired as contracts `check` + root `contracts:check`; 9 golden fixtures in tests/fixtures/ (6 ClientCommand variants + GatewayRequest + GatewayEvent + ConnectFrame) with vitest validation test; .gitignore un-ignores both generated schema dirs (G1R Option A ruling); new .gitattributes pins schema/fixture JSON to eol=lf, schema dirs linguist-generated; PRD §9.10.3 wording amended byte-diff → semantic (parsed-JSON) diff.
- design rulings: G1R APPROVE-WITH-CHANGES (CRLF hazard → deep-JSON compare + .gitattributes; 9 fixtures not 4; file-set assertion; temp-dir emission). Mid-ticket G1R ruling Option A: track both generated dirs — rationale: CI gate is a tautology against ignored dirs; turbo package-relative outputs cannot cover the cross-package Python schema write (cache-hit staleness hole); contracts.py self-containment promise for GPU-box deploys requires schemas present without a Node build.
- tests/checks run: contracts build (4×2) PASS; contracts:check exit 0 clean / exit 1 on three builder tamper tests + one independent G2A tamper (nested enum, single-dir) with precise JSON path reported; determinism verified (double-build md5 match); pnpm test 103/103 (94 pre-existing + 9 fixtures); typecheck 12/12.
- G2A result: PASS-WITH-NOTES. Note remediated: connect-frame fixture token was secret-shaped in a public repo → changed to FIXTURE-NOT-A-REAL-TOKEN; re-verified 103/103 + check exit 0. Residual: two short synthetic row IDs in fixtures assessed non-credential by G2A, Builder, and G1D.
- deferred notes: consider pinning zod exactly (caret bump can legitimately change emitted schemas — gate will catch it, regenerate+commit is the response); CI wiring of contracts:check is next ticket (TCLAW-0A v1) along with action-major bumps for the Node 20 runner deprecation.
- next ticket: TCLAW-0A v1 (wire contracts:check + six stub-mode e2e scripts into ci.yml, bump action majors).
- blockers: none. TICKET COMPLETE AND ACCEPTED. Operator approved 3-commit plan 2026-07-08.

### TCLAW-0A (stage v1) — CI integration: drift gate + stub-mode e2e

- date: 2026-07-08
- branch: master @ 38e6a38 (committed: 2d65635 ci, 9d2f083 docs, 38e6a38 fixup; CI run 28994626483 GREEN in 1m39s - all 18 steps incl. drift gate + six e2e in structural stub mode on Linux)
- ticket: TCLAW-0A stage v1 (PRD §9.0.2)
- what changed: ci.yml only. Added `pnpm contracts:check` after contracts build; `concurrency` (cancel-in-progress) + `permissions: contents: read`; action majors bumped (checkout v4→v7, setup-node v4→v6, pnpm/action-setup v4→v6, astral-sh/setup-uv v8 added) clearing the Node-20 runner deprecation; `uv sync` in engines/hermes_kernel (no submodule init — stub mode verified to require only mcp+jsonschema); `pnpm build` before e2e (Builder catch: e2e spawns gateway/channel-http dist/server.js which v0 never built); six named e2e steps.
- tests/checks run: Builder ran all six e2e locally exit 0 (one env-only retry: stale ports from a prior dev session), contracts:check exit 0, typecheck 12/12, vitest 103/103. G2A independently ran full `pnpm build` on cleared turbo cache (exit 0, 23.7s, console Next build succeeds with zero env vars — all env reads have ?? fallbacks), timed representative e2e (~10-12s each), YAML-validated the workflow, verified stub-mode guard at hermes_runner.py vendor-exists check.
- G1R: not required (infra-only; same rationale as v0).
- G2A result: PASS. Deferred INFO notes: (1) six e2e steps share ~/.torqclaw/state.db on the runner — benign today (assertions self-scoped per WS session) but set TORQCLAW_DATA_DIR per step if a future e2e asserts absolute DB state; (2) local stub path was HERMES_MODEL-unset, CI exercises missing-vendor path — both converge on the same guard.
- fixup: first run 28994268063 failed at job setup - astral-sh/setup-uv publishes exact tags only, no floating v8 major ref. Pinned v8.3.2; other three action refs verified to resolve as bare majors. Lesson recorded: verify ref RESOLUTION (git matching-refs), not release existence.
- next ticket: TCLAW-0B (role-based command authorization + channel task ownership) — G1R review MANDATORY (security surface).
- blockers: none. TICKET COMPLETE AND ACCEPTED (v0+v1). CI v2 deferred until TCLAW-0E delivers the Python test suite.

### TCLAW-0B — role-based command authorization + channel task ownership

- date: 2026-07-09
- branch: master (worktree changes complete, pending operator commit approval)
- ticket: TCLAW-0B (PRD §9.0.2) — the PRD's #1 security fix; G1R review MANDATORY, completed
- what changed (4 code files): NEW packages/gateway/src/authz.ts — pure authorize(role,cmd,ctx) allow-list with default-deny + checkResumeRole() guard; sessions.ts resolve() now returns persisted role (SELECT id,role) in both create/resume branches; server.ts — single default-deny authz gate before the dispatch switch (returns on deny), resume-role-mismatch guard closes socket 4003 before any command, denials via ephemeral sendErr + app.log.warn (not persisted), inline lookupTaskSession(SELECT session_id FROM tasks WHERE request_id=?); NEW tests/authz.test.ts. No contract/schema/dispatch/cancellations/channel-http changes; no migration.
- policy: operator=full; channel=SUBMIT_PROMPT + MEMORY SHOW + CANCEL_TASK(own session only, not-found denies) + all else deny; node=deny-all incl SUBMIT_PROMPT. Unmapped/future actions default-deny for non-operator.
- vulns closed (both G1R-confirmed pre-existing, beyond PRD text): (1) CANCEL_TASK was unauthenticated cross-session — fired cancellations.request() for any UUID with no ownership check; (2) resume path never validated role — a client could hijack any session id or lie about role in a resume frame, bypassing the whole scheme. Guard rejects both directions (operator↔channel) with 4003.
- design rulings: G1R APPROVE-WITH-CHANGES — required single pre-switch default-deny gate (not per-case), resolve() role plumbing, 4003 reject on mismatch (never mint fresh session), CANCEL ownership via tasks.session_id, ephemeral denials, documented residuals.
- tests/checks run: typecheck 12/12; pnpm test 146/146 (103 baseline + 43 across authz suite incl. role×action matrix, CANCEL ownership own/other/unknown, node deny-all, default-deny unmapped, reason-no-leak, checkResumeRole all ordered pairs + fresh-session inertness, real-sqlite integration proving both hijack directions rejected); contracts:check exit 0; pnpm build 7/7; e2e-cancel exit 0 (operator cancel intact), e2e-channel exit 0 (channel seat SUBMIT_PROMPT through new gate).
- G2A result: PASS-WITH-NOTES on first pass — all 6 core security properties verified closed with file:line evidence; sole finding was ZERO coverage on the resume-mismatch 4003 guard. G1D did not accept an untested load-bearing security guard: sent back to Builder, who extracted checkResumeRole() as a pure helper called verbatim by server.ts and added exhaustive tests (production path == tested unit). Gap closed; re-verified 146/146 + both e2e green.
- build incident: Builder subagent was killed mid-amendment by an account monthly spend limit, but had already completed the helper extraction, server.ts wiring, and tests before termination (its dying message understated progress). G1D verified the tree directly (compiles, 146 tests, e2e green, no parallel untested copy) rather than trusting the interrupted report. NOTE: spend limit is live on the Fable 5 model — may constrain further subagent dispatch.
- residuals (documented, out of scope for 0B): shared gateway token still lets a token holder CREATE an operator session (0B closes resume-hijack + per-command escalation, not session creation); a permitted channel seat can still burn unbounded FRONTIER budget and submit unbounded prompt volume — per-channel budget clamps + rate limiting tracked in Epic 7; channel-http shared-session callers within one front-door token are one trust domain (per-caller isolation deferred until per-caller channel identity exists).
- next ticket: TCLAW-0C (behavior-based capability classification, fail-closed unknown default, path-scope write-check fix). G1R review recommended (touches approval/path-scope security surface).
- blockers: operator commit approval pending. Account spend limit may block further work — operator action may be required (/usage-credits or model switch).

### TCLAW-0C — behavior-based capability classification, fail-closed, path-scope fix

- date: 2026-07-09
- branch: ticket/tclaw-0c-capability-classifier -> PR #1 (base master). Commits: 12705da (wip: classifier + path-scope fix), d429ffd (remove name->read inference, fail-closed), 86d2784 + c5ff9e3 (OS-portable test fixtures). NOT merged — awaiting operator approval.
- ticket: TCLAW-0C (PRD §9.0.2). Security-sensitive; G1R + G2A mandatory.
- what changed (4 files): NEW packages/bridge/src/capability.ts (pure classifyCapability + isWriteClass + scopeModeFor); registry.ts (capability field, path-scope mode = scopeModeFor(capability) — the bug fix, decoupled from requiresApproval; requiresApproval = isWriteClass(cap) || approvalPatterns); serverConfig.ts (capabilities annotation map); tests/capability.test.ts + tests/registry-scope.test.ts (NEW); ops/servers.example.json (annotation remedy example).
- FINAL DESIGN (after 2 rejected attempts): NO path from a bare tool name to 'read'. read reachable only via P1 explicit config annotation or P3 MCP readOnlyHint. Name patterns classify write/exec/send by token-bounded verb match; everything else fails closed to write. Satisfies PRD "unknown never means read". Honest read tools fail closed to gated write-scope until annotated (PRD-intended; remedy = capabilities map in servers.json).
- design rulings: G1R APPROVE-WITH-CHANGES (decision table: config->MCP->name-pattern->fail-closed; preserved-default guarantee; read allowlist to avoid mass regression). NOTE: the read-allowlist that G1R+G1D initially specified was itself the defect — see audit history.
- ADVERSARIAL AUDIT HISTORY (3 rounds, multi-agent workflows): v1 (prefix read-allowlist) — single-agent G2A passed PASS-WITH-NOTES, but a parallel 4-skeptic workflow found it leaked 196 dangerous names -> REJECTED. v2 (whole-name read grammar) — leaked 62 honest-dangerous names (get_all_secrets, read_private_key) AND over-gated 100% of 53 real MCP read tools incl. the repo's entire TradingView surface, plus a P4 substring bug (get_deployment->write) -> REJECTED. v3 (no name->read path, PRD-faithful) — 3-lens confirmation workflow: no-name-read-path PROVEN structurally + empirically (266-name corpus, 0 leaks, non-vacuous controls); PRD-conformant; scope clean -> PASS-WITH-NOTES, merge-approved. Lesson: multi-agent adversarial verification caught what single-pass G2A and 2 builder rounds shipped past.
- hardening added: frozen 33-name adversarial regression-guard corpus in tests/capability.test.ts locks the no-name-read-path invariant in CI (with non-vacuous P1/P3 controls + non-ASCII fixture guards) so it cannot silently regress.
- CI incident: first two PR CI runs failed on tests/registry-scope.test.ts — hardcoded C:\ fixture paths resolved relative to cwd on Linux, flipping in-scope vs outside. First fixup was incomplete (search-replace missed 6 literals; local Windows run passed anyway, masking it). Second fixup made all fixtures platform-anchored; verified in-scope/outside resolution correct under both win32 and posix semantics before pushing. LESSON: a green local run on Windows does NOT prove OS-portability; verify POSIX path semantics explicitly.
- tests/checks: typecheck 12/12; pnpm test 266/266; contracts:check 0; build 7/7; both approval e2e exit 0. CI run 29022942408 GREEN in 1m42s (full v1 pipeline incl. 6 e2e on Linux).
- G2A result: PASS-WITH-NOTES (merge-approved). Residuals documented: (1) intentional over-gating + annotation remedy is the headline operator note; (2) example annotation lists tools beyond the allowlist (clarified in servers.example.json comment); (3) regression-guard corpus added.
- next ticket: TCLAW-0D/0E/0F (cost-breaker unit tests, Python test suite, token hygiene) then CI v2. TCLAW-0D/0F low-risk; 0E enables CI v2.
- blockers: operator merge approval for PR #1.

### TCLAW-0D — cost-breaker unit tests

- date: 2026-07-09
- branch: ticket/tclaw-0d-cost-breaker-tests @ e3d3a69 -> PR (base master). NOT merged — awaiting operator approval.
- ticket: TCLAW-0D (PRD §9.0.2). Conservation mode (self-implemented, no builder subagent) — but touches cost-enforcement, so independent Opus G2A was mandatory and NOT skipped.
- what changed (4 files, minimal seams): dispatch.ts resolveBudget made `export` (one word, no logic change); hermes.ts circuit-breaker decision extracted from the poll loop into a pure exported evaluateSpend(costUsd,budget,state,now,intervalMs) + HeartbeatState (loop calls it verbatim — production path == tested unit, no parallel copy); NEW tests/budget.test.ts (8) + tests/circuit-breaker.test.ts (15).
- coverage: resolveBudget precedence (maxCost -> env default -> unlimited) incl. maxCost:0 honored as real budget, 0/negative/non-numeric/empty env ignored; breaker trip on strict over-budget, no-trip at/under/unlimited, $0-budget trips on any spend; unreportable spend (null/undefined/NaN/string) skipped with NO fabricated zero and state untouched; heartbeat cadence (once per interval, only on cost change, injected clock — no timer flake); /budget/i regression guard tied to e2e-budget + dispatch BUDGET mapping; CircuitBreakerError shape.
- behavior-preserving: message strings unchanged (Budget exceeded / Spend so far); e2e-budget exit 0 (BUDGET terminal ERROR fired through refactored loop); both FRONTIER approval e2e + one-shot e2e exit 0.
- tests/checks: typecheck 12/12; pnpm test 289/289 (+23); contracts:check 0; build 7/7; e2e-budget + e2e-approval-cloud + e2e exit 0.
- G2A result (independent Opus 4.8): PASS — merge-ready. Reconstructed old-vs-new logic as a truth table over {number,null,undefined,NaN,string} x {budget undefined,0,1} x interval x cost-change; confirmed semantically identical on every cell; no parallel copy; teeth-check (flip > to >=) broke exactly the boundary test, proving non-vacuous. 2 info notes (NaN heartbeat cosmetics pre-existing/preserved; test-seam widening acceptable) — non-blocking.
- next ticket: TCLAW-0F (token hygiene) then TCLAW-0E (Python test suite, gates CI v2).
- blockers: operator merge approval.

### TCLAW-0F — token hygiene

- date: 2026-07-09
- branch: ticket/tclaw-0f-token-hygiene @ a4a7b52 -> PR (base master). NOT merged — awaiting operator approval.
- ticket: TCLAW-0F (PRD §9.0.2). Conservation mode (self-implemented); touches auth-token handling so independent Opus G2A mandatory and NOT skipped.
- what changed (3 files): channel-http adapter's upstream gateway token no longer defaults to the literal 'dev' when TORQCLAW_GATEWAY_TOKEN is unset. gatewayClient.ts adds pure exported resolveGatewayToken(env) returning TORQCLAW_GATEWAY_TOKEN || '' (matches the gateway's own || '' convention); server.ts calls it (production path == tested unit); tests/channel-http.test.ts +4 token tests. Two remaining 'dev' strings in channel-http src are comments documenting the removed behavior.
- security reasoning (G2A gate): '' is >= 'dev' in safety across all 4 config cases {gateway token set/unset} x {adapter set/unset} — never weaker, strictly safer when the gateway has a real token (old 'dev' could auth against a gateway whose token was literally 'dev'; '' never masquerades as a plausible secret). No server/engine code ever treated 'dev' as valid; both '' and 'dev' only ever worked via the tokenless-gateway-accepts-all dev-mode branch.
- completeness: channel adapter was the ONLY production upstream-token 'dev' default. Gateway's own GATEWAY_TOKEN was already || '' (out of scope). ops/*.mjs e2e scripts still hardcode client-side || 'dev' — harmless (rely on tokenless dev gateway), logged as a future test-hygiene candidate, out of 0F scope.
- tests/checks: typecheck 12/12; pnpm test 293/293 (+4); contracts:check 0; build 7/7; e2e-channel exit 0 (adapter sends '' to tokenless dev gateway, full HTTP 200 round-trip). NOTE: first local e2e-channel run failed 'ws not up' — environmental cold-start of the operator's real ~/.torqclaw/servers.json (filesystem+tradingview MCP), NOT a regression; passed on retry once servers warmed; G2A confirmed pass twice on a clean machine.
- G2A result (independent Opus 4.8): PASS — merge-ready. 4-case security matrix, completeness grep, teeth-check (revert to 'dev' broke 3 of 4 new tests). 1 info note (ops client-side 'dev', non-blocking).
- next ticket: TCLAW-0E (Python test suite bootstrap — full G1R scope, unlocks CI v2). Last Phase-0 ticket.
- blockers: operator merge approval.
