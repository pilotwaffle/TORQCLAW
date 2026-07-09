# TORQCLAW TrustOS — Build Ledger

Program: PRD-TCLAW-TRUSTOS-001 rev 1.2 · Orchestrator: Fable 5 (G1D)
Role mapping note: G1R and G2A run as independent Opus instances; GLM-5.2 (RB) unavailable in this harness — substitutions are logged per ticket.

## Ticket log

### TCLAW-0A (stage v0) — CI pipeline: TypeScript core

- date: 2026-07-08
- branch: master @ 29953ed (work uncommitted, pending operator approval)
- ticket: TCLAW-0A stage v0 (PRD §9.0.2)
- what changed: new file `.github/workflows/ci.yml` — push-to-master + PR triggers, ubuntu-latest, timeout 15m, checkout (no submodules), pnpm via packageManager field, Node 22 (required by --experimental-strip-types in contracts build), steps: install --frozen-lockfile → contracts build → typecheck → test. No other files touched; turbo.json ruled not-required (root test script is direct vitest, documented deviation from PRD line "add test to turbo pipeline").
- tests/checks run: local `pnpm install --frozen-lockfile` PASS, contracts build PASS (3 schemas × 2 dirs), `pnpm typecheck` PASS (12/12), `pnpm test` PASS (94/94); G2A independently re-ran contracts build + tests, 94/94 confirmed.
- G1R: not required (infra-only, no security/routing/approval/cost/contract-semantics surface).
- G2A result: PASS. Informational notes: (1) turbo test-task deviation should be mentioned in PR text; (2) consider concurrency + explicit permissions block at CI v1.
- limitation: GitHub-side green run unverifiable until pushed (operator-gated).
- next ticket: TCLAW-10A (contracts:check drift gate + ConnectFrame emission + golden fixtures), then CI v1 wiring back into TCLAW-0A.
- blockers: none. Awaiting operator approval to commit.
