# TorqClaw agent routing policy

Adapted from the TORQ Console harness (`E:\TORQ-CONSOLE\.claude\agents`).
**These are TorqClaw-local definitions.** The Console harness drives a different
product through `.torq/launch/*` watcher scripts and hardcoded
`E:\TORQ-CONSOLE\...` paths; running those agents against this repo would read
specs from and write verdicts into the wrong product. What is ported here is the
*discipline*, re-pathed to `E:\TorqClaw`.

## Roles and model assignments (operator-set, 2026-08-09)

| Role | Model | Responsibility |
|---|---|---|
| **G1D / planner / router** | Fable-5 | Orchestrate. Scope the ticket, route work, hold the sequence. Does not implement. |
| **G1R / reviewer** | Opus 4.7 | Independent review when design, architecture, risk, or **security** is involved. Reviews the SPEC before the Builder spends compute. |
| **Builder** | Sonnet 5 | Implement the spec precisely. Does not design or approve. |
| **G2A / final verifier** | Opus 4.8 | Grade high-impact changes against **files, tests, build output, git state, and acceptance criteria**. Sole authority to authorize a push. |
| **Cheap verification** | Haiku / fast | Checklist grading, log triage, scope sanity checks. **Never** sole final authority for risky code, merges, security, production, or architecture. |
| **Memory-writer** | — | Updates `STATE.md` / `MEMORY.md` **only after** meaningful progress, tests pass, and verifier/G2A passes. |

## Hard rules

1. **Do not stop** until tests pass and verifier/G2A passes — unless blocked by
   missing authority, unsafe repo state, permission limits, or an
   operator-required decision.
2. **Never** push, merge, delete, clean, reset, overwrite operator files, or run
   destructive commands without explicit operator approval. G2A approval is a
   *technical precondition* for a push, not operator authorization.
3. Project-local `CLAUDE.md`, `MEMORY.md`, `.claude/agents`, hooks, and workflows
   are the active authority.

## Two practices worth keeping from the Console harness

**Spec review before build.** The verifier grades the SPEC (Mode 1) before the
Builder starts, so a bad spec costs a review instead of a build. Gates:
completeness (every section present, real file paths and line numbers, no
"TBD"), correctness (does not contradict the PRD, referenced paths exist),
project-rule compliance, and clarity (Builder could execute without asking a
question).

**Fault attribution on rejection.** A REJECT names *whose* fault it was —
`send_back_to: builder` (implemented the spec wrong) vs `send_back_to: architect`
(the spec was wrong). Conflating these is how the same defect ships twice.

## TorqClaw-specific gates (these have caught real defects)

- **Reachability**: `pnpm reachability` must PASS. A module no program can reach
  is not shipped, however well tested. See `ops/reachability.mjs`.
- **Invariant-path proof**: reachability proves code is *live*; it cannot prove
  the *correct control* runs on the *correct operation*. Governance controls need
  a test that fails when the control is bypassed **with the import left intact**.
- **Verify the artifact, not the unit test**: `tsc` can exit 0 without emitting.
  A stale `dist/` once let a "fixed" auth hole stay open while 14 unit tests
  passed. For any control that must hold at runtime, boot the real binary.
- **Sabotage discipline**: for each control, break it, predict which named test
  fails, confirm ONLY that one fails, restore, re-verify byte-identical.
- **One owner per file** while a sabotage cycle is in flight.

## Artifact layout

`.torq/artifacts/` — `00_input` (PRD/ticket), `01_architect` (spec),
`02_builder` (build result), `03_verifier` (verdict), `status`
(`harness_status.json`).

`harness_status.json` fields: `state` (idle → architect_complete →
builder_complete → complete | revision_needed | blocked), `current_owner`,
`verdict` (APPROVED | REJECTED), `spec_verdict`, `send_back_to`,
`push_authorized`, `commits_verified[]`, `last_updated`.

`push_authorized: true` means G2A found no technical blocker. **The operator
still gates the actual push.**

## Specialist fleet

`E:\TORQ-CONSOLE\.claude\agents\fleet\` holds ~30 specialists (security,
database, performance, deployment, review). Not copied wholesale — pull one in
only when a ticket genuinely needs that lens, and re-path it first.
