# README Conformance Review — 2026-08-16

Can TorqClaw perform in every way the README describes? **Substantially yes.**
~44 claims audited (6 parallel code auditors with file:line evidence, journal:
session workflow `wf_09115a19-1e4`) plus a live interrogation session against a
running stack (frontier stubbed via empty `HERMES_MODEL`, ollama live, operator
watching in Chrome). **Zero claims FAIL. Seven are PARTIAL** — nuances and one
real divergence, listed below. Everything else HOLDS as written.

## Live-proven this session (operator-visible, real stack)

- Hybrid LOCAL_EDGE/FRONTIER routing — tasks ran on both tiers.
- Privacy chain end-to-end: credential-looking prompt → suggestion banner
  (fired at its designed ≥16-char `sk-` threshold; never flips the flag, never
  blocks), "keep private" → task forced LOCAL, lock line visible during the run.
- Route transparency: simulate-route showed rule id `PRIVACY_OVERRIDE`, tier,
  `Locked — safety rule: SENSITIVE_DATA`, the counterfactual ("would have used
  API_EXTERNAL, but…"), routing profile, task type, context size, and the
  honest "classified by keyword fallback — lower confidence" note.
- Receipts from real telemetry: `local · free · 21.0s · tools: read text file,
  search files, list directory… · context: N chars`; stub-frontier tasks showed
  `cost n/a` — never a fabricated $0.
- Pre-flight estimate: real kernel sizing pass — `~375 TOKENS · CLOUD` for a
  cloud draft, `$0.00 · LOCAL` when enrichment steered local (dollars only
  where true by construction).
- Workspace path scoping: the local model's out-of-scope file attempts were
  denied by the bridge and surfaced honestly in answers; five chained tool
  calls all stayed contained.
- Honest degradation: the stub frontier *declined* a file-write task ("No file
  was written") instead of pretending.
- Memory: real episode (`taskType/summary/timestamp`) rendered in the Memory
  view; session budget/cost frames real.
- Connection states: CONNECTED / RECONNECTING… / stale badge all exercised.

## The seven PARTIALs (none contradicts the README as worded, one is a real divergence)

1. **FRONTIER profile enforcement is toolset-granular — and `workspace_write`
   is deliberately given the read-only `web` toolset** although the profile
   contract declares network scope `none`
   (`engines/hermes_kernel/mcp_wrapper/hermes_runner.py:317-320` vs
   `packages/contracts/src/profile.ts:84`). The wrapper comment records it as
   intentional broadening. **This is the one finding worth an operator ruling:
   either the contract/README should say frontier `workspace_write` includes
   web research, or the wrapper should stop offering it.** LOCAL_EDGE
   enforcement is per-operation and exact.
2. "No static pricing tables" — true for every first-party enforcement/receipt
   path; the *vendored* hermes-agent ships an upstream pricing table
   (`vendor/hermes-agent/agent/usage_pricing.py`) that nothing in the
   enforcement chain references. README's own wording scopes correctly.
3. Failover env vars: all ten exist; a subset is consumed on the TS side and
   the rest in the Python runtime — names all real, wiring split across tiers.
4. Failover default-off/fail-closed holds (`FAILOVER_CONFIG_REJECTED` thrown);
   PARTIAL only for evidence granularity in the audit.
5. Configuration table: spot-checked variables match code; a few defaults are
   derived in `ops/launcher-config.mjs` rather than the cited package.
6. channel-http: flag, port 18792, `role: 'channel'`, and honest
   pending-approval mapping all verified in code; not exercised live this
   session (needs `TORQCLAW_HTTP_CHANNEL=1` boot).
7. Console profile binding: one profile resolved before dispatch, asserted
   before routing, tier constrained — holds; caveat folded into (1).

## Live limits found (environmental, not claim failures)

- **The write-approval gate could not be triggered live**: the stub frontier
  exposes only web tools, and the local model chose read-only tools for file
  tasks. The both-tier approval pause, gateway-owned grants, deny-is-terminal,
  and DB-read `APPROVE_TOOL` are all code-verified (HOLDS) and covered by the
  repo's tests; a live demonstration needs a real provider run or a local
  model that elects a write tool.
- **Stop/cancel not conclusively exercised** — the click raced task
  completion; `CANCEL_TASK` path code-verified.
- Observation (no claim violated): a private-flagged task's prompt is retained
  verbatim in its local memory episode (`task_episodes`). Local-only storage,
  so "never leaves this machine" holds — noted for hygiene consideration.
- The gate figures quoted in the README (`991/991` at `e3ae332`) are
  historical master-state records, consistent with the project's memory of
  that verification; not re-reproduced in this session.

## Session context

Run on branch `phase1-server-owned-authority`, whose working tree carries the
in-flight server-owned-authority CONNECT/auth migration. The auditors judged
mechanism changes explicitly: the WIP *strengthens* the README's authority
claims (server-minted roles; operator-authority intersection on APPROVE_TOOL).
The console handshake required the matching `NEXT_PUBLIC_GATEWAY_TOKEN` —
exactly what the README's quickstart instructs.
