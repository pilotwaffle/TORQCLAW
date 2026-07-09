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
- branch: master (ci.yml modified in worktree, pending operator commit approval)
- ticket: TCLAW-0A stage v1 (PRD §9.0.2)
- what changed: ci.yml only. Added `pnpm contracts:check` after contracts build; `concurrency` (cancel-in-progress) + `permissions: contents: read`; action majors bumped (checkout v4→v7, setup-node v4→v6, pnpm/action-setup v4→v6, astral-sh/setup-uv v8 added) clearing the Node-20 runner deprecation; `uv sync` in engines/hermes_kernel (no submodule init — stub mode verified to require only mcp+jsonschema); `pnpm build` before e2e (Builder catch: e2e spawns gateway/channel-http dist/server.js which v0 never built); six named e2e steps.
- tests/checks run: Builder ran all six e2e locally exit 0 (one env-only retry: stale ports from a prior dev session), contracts:check exit 0, typecheck 12/12, vitest 103/103. G2A independently ran full `pnpm build` on cleared turbo cache (exit 0, 23.7s, console Next build succeeds with zero env vars — all env reads have ?? fallbacks), timed representative e2e (~10-12s each), YAML-validated the workflow, verified stub-mode guard at hermes_runner.py vendor-exists check.
- G1R: not required (infra-only; same rationale as v0).
- G2A result: PASS. Deferred INFO notes: (1) six e2e steps share ~/.torqclaw/state.db on the runner — benign today (assertions self-scoped per WS session) but set TORQCLAW_DATA_DIR per step if a future e2e asserts absolute DB state; (2) local stub path was HERMES_MODEL-unset, CI exercises missing-vendor path — both converge on the same guard.
- limitation: GitHub-side run of the new steps unverifiable until pushed (operator-gated).
- next ticket: TCLAW-0B (role-based command authorization + channel task ownership) — G1R review MANDATORY (security surface).
- blockers: none. Awaiting operator approval to commit.
