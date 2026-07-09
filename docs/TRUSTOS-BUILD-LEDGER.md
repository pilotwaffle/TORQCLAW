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
- branch: master (worktree changes complete, pending operator commit approval)
- ticket: TCLAW-10A (PRD §9.10.3, Epic 10 scope pulled into Phase 0)
- what changed: emit-schemas.ts emits ConnectFrame as 4th artifact (4 schemas × 2 dirs); new check-schemas.ts drift gate (re-emit to OS temp dir, file-set assertion + parsed-JSON deep-equality against both dirs, exit 1 on drift); scripts wired as contracts `check` + root `contracts:check`; 9 golden fixtures in tests/fixtures/ (6 ClientCommand variants + GatewayRequest + GatewayEvent + ConnectFrame) with vitest validation test; .gitignore un-ignores both generated schema dirs (G1R Option A ruling); new .gitattributes pins schema/fixture JSON to eol=lf, schema dirs linguist-generated; PRD §9.10.3 wording amended byte-diff → semantic (parsed-JSON) diff.
- design rulings: G1R APPROVE-WITH-CHANGES (CRLF hazard → deep-JSON compare + .gitattributes; 9 fixtures not 4; file-set assertion; temp-dir emission). Mid-ticket G1R ruling Option A: track both generated dirs — rationale: CI gate is a tautology against ignored dirs; turbo package-relative outputs cannot cover the cross-package Python schema write (cache-hit staleness hole); contracts.py self-containment promise for GPU-box deploys requires schemas present without a Node build.
- tests/checks run: contracts build (4×2) PASS; contracts:check exit 0 clean / exit 1 on three builder tamper tests + one independent G2A tamper (nested enum, single-dir) with precise JSON path reported; determinism verified (double-build md5 match); pnpm test 103/103 (94 pre-existing + 9 fixtures); typecheck 12/12.
- G2A result: PASS-WITH-NOTES. Note remediated: connect-frame fixture token was secret-shaped in a public repo → changed to FIXTURE-NOT-A-REAL-TOKEN; re-verified 103/103 + check exit 0. Residual: two short synthetic row IDs in fixtures assessed non-credential by G2A, Builder, and G1D.
- deferred notes: consider pinning zod exactly (caret bump can legitimately change emitted schemas — gate will catch it, regenerate+commit is the response); CI wiring of contracts:check is next ticket (TCLAW-0A v1) along with action-major bumps for the Node 20 runner deprecation.
- next ticket: TCLAW-0A v1 (wire contracts:check + six stub-mode e2e scripts into ci.yml, bump action majors).
- blockers: none. Awaiting operator approval to commit (3-commit plan: feat drift gate / chore track artifacts / docs PRD+ledger).
