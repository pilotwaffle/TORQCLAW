# PRD MAP — every product document in `docs/`, its build status, and what's owed

Compiled 2026-08-19 by the G2A seat from a 20-agent scan of the documents,
cross-checked against repo history. Statuses are evidence-based, not the
documents' own (often stale) headers. Full per-document briefs available on
request. See `docs/FOLLOWUPS-CI-E2E-GATES.md` for the CI/harness backlog.

**Updated 2026-08-23** (docs-truth pass, `docs/prd-reviews/G1D-FABLE-CLEANUP-DOCS-TRUTH-2026-08-23.md`):
PRD-007 row recompiled to S1–S7 shipped; 2026-08-22/23 shipments added below.

## Active programs

| Document | Program | Status | What remains |
|---|---|---|---|
| `PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` (v0.6) | Collab surface (channels/chat in console) | **S1–S5 SHIPPED** (G2A-approved, conditions on record in `docs/prd-reviews/`) | S6 (read state, needs `ackChannelCursor` + A6/T-9), S7 (mention rendering, client-only). Owed: §19 socket backpressure (explicitly NOT discharged), CO-9 (throwing `code` getter). Threads/reactions/search/DMs etc. each need their own PRD. |
| `PRD-TCLAW-AGENT-PARTICIPATION-007.md` (v1.0, updated 2026-08-23) | Agents as channel participants | **S1–S7 SHIPPED** (PR #53 `master 4252a6a`, PR #54 `master 962d6bf`; identity, MCP tools S2 `d1abe09`, auto-reply, presence, live push S5 `7fb4ac1`, label honesty S6, S7). OQ-2 ("working now" entitlement) RULED GRANTED 2026-08-22/23; OQ-3 (STOP survives restart) CLOSED via `84bfda3`; F1/F2 auto-reply defects RESOLVED ON MASTER (`autoReplyDispatcher.ts`). | Owed: S5b (self-only `principalId` on CONNECTED, per G1R's disclosure analysis), §19 backpressure (explicitly not discharged by S5). OQ-1 credential-at-rest lifetime partially discharged (`FileSecretStore`, `9b544ee`); CredMan-native adapter remains owed. OQ-4 flag naming shipped as-is; **operator ratification of the specific names is still owed.** |
| `PRD-TCLAW-AGENT-SANDBOX-006.md` (v0.3) | Container containment for agent execution | **NOT STARTED** (Gate-1 V3: APPROVE_WITH_CONDITIONS, 0 blockers, 1 must-fix cross-ref) | **SB2b BLOCKED on OQ-4** (vendored `approval.py` edit — operator ruling owed; G2A assessment on record: option (a)+(d), SA-8 permanent gate). SB4-spike gates SB2. SA-1..SA-16 unbuilt. |
| `PRD-TCLAW-COLLAB-GATEWAY-004` (spec, in `prd-reviews/`) | C1/C2 identity + approval broker | **C1, C2 SHIPPED** (`SCOPE-C1-RUNTIME.md`, `SCOPE-C2-RUNTIME.md`) | **C3 lane**: delivery transport (nothing pushes a card to a surface), D-6 read-time eligibility re-check (must close before any card is delivered), A9/prop-10 async re-validation, bridge-executor admission seam, `registry_enforcement_hash` real producer, socket-close on revocation. OQ-5 TTL ratification, OQ-8 performance budgets (runtime-authz blocker). FRONTIER usable-tier needs the Hermes structured-grant protocol. |
| `PRD-TCLAW-REMOTE-SKILL-SOURCES-005.md` (v1.2) + `SCOPE-PHASE4-REMOTE-SOURCES.md` + `RUNBOOK-REMOTE-SKILL-SOURCES.md` | Signed remote skill sources | **SHIPPED** (P4-1..P4-9, merged) | OQ-1 pilot publisher host (operator choice, never really run), OQ-2 TTL re-ratification (owed before flag-on in production). Deferred: background trust refresher (revoked key discovered at next governed op, not within 24h), R-7 capability bound beyond `["read"]` (needs its own approval-UX phase), gateway-side skill-approval history (R-10, later console phase). |
| `PRD-TCLAW-TRUSTOS-001.md` (rev 1.2) + `TRUSTOS-BUILD-LEDGER.md` | TrustOS master program | **Phase 0–1 SHIPPED; Phase 2 IN FLIGHT** (see TRUSTOS-002) | Phase 2 (governed learning) is governed by v2.0 below. Phase 3 scoped (below). Phase 5 architecturally blocked (needs deferred epochs/generations — decide before scoping P5-2). Marketplace: 4 unmet exit criteria, separate PRD required. |
| `PRD-TCLAW-TRUSTOS-002-v2.0.md` | TrustOS Phase 2–3 revision | **IN FLIGHT**: P2-0, P2-1h, P2-1g, P2-1g.1, P2-1g.2 merged (PRs #39–#43) | P2-1a–1f (activation path, `skills.external_dirs` publication — P2-1a landed per memory; verify), P2-2…P2-5, Phase 3 tickets. Owed: §6b three FAIL controls (curator-control test, D5 disclosure owed P2-4, D4 activation e2e owed P2-1); SEC-1 queue-jumper (cross-channel session hijack, HIGH, live); delete legacy `skill_queue.py:77-82` write (pending in P2-1); "may an operator approve a channel-originated task?" (unresolved, blocks Phases 2/3). |
| `SCOPE-PHASE-3-CHANNEL-PRESENCE-FABRIC.md` | TrustOS Phase 3 (channels reach) | **NOT STARTED** (G1R APPROVE-WITH-CHANGES, 9 RCs) | Everything: P3-1..P3-6 (registry, policy clamps, Slack/Discord adapters, Channel Manager UI). Pre-existing defects owed regardless: SEC-1 (channel session hijack, HIGH), SEC-2 (single global token = unauthenticated channel identity), H-4 (`sourceChannel` hardcoded). Two §11 operator decisions block P3-2. |
| `PRD-TCLAW-RESILIENT-EXTENSIBILITY-001.md` (v0.5) | Failover / profiles / skill lifecycle | **SUBSTANTIALLY BUILT** (Slice A failover, Slice B profiles, Slice C incl. Phase 4 signing) | §12/§14 acceptance-gate verification never formally recorded. Owed: §17 OQs (provider ceilings before Phase 1 pilot, pilot publisher revocation authority before Phase 4 pilot, etc.), post-v1 replay protocol (ruled-deferred), §15 operator docs. |

## Shipped / closed (no open build work)

- **GLM-5.3 alias binding (`endpoint_bound`)** — shipped `b8f92ce` ("feat(gateway): GLM-5.3 alias binding (endpoint_bound) + first completed live subscription-agent turn"); OQ-2 ruling recorded in `053c5ea` ("docs(prd-007): OQ-2 ruled (granted, operator's own words); S4 + GLM alias packet with G1R resolution").
- **Web-search egress gate (`research__web_search`, default OFF)** — shipped `126e4c2` ("feat(research): keyless web-search + agent-reach probe modules (operator WIP; default OFF)") and `f592091` ("feat(agents): PRD-007 S7 — subscription-model agents as channel participants; research__web_search default OFF"). Gated by `TORQCLAW_WEB_SEARCH_ENABLED` (TS) / the Python twin in `engines/hermes_kernel/mcp_wrapper/server.py`, both default off.
- `TORQCLAW_UI_SPEC.md` (PRD-UI-1) — console redesign, all §0–§8 committed. Caveat: no recorded full §9 checklist sign-off.
- `SCOPE-GS-ROLLBACK.md`, `SCOPE-GS-DISABLE.md` — governed rollback/disable lanes, shipped; minor recorded residues (retained-projection cleanup obligation is standing).
- `HANDOFF-GS-COORD.md` — superseded; everything it owed is closed in history.
- `sprint2-3-refinements.md` — closed punch-list.
- `graphify-remediation-report.md` — shipped; 3 upstream follow-ups belong to Torq-graphify, not this repo.

## Not started / external

- `PRD-TORQ-ARCHITECTURE-VISUALIZER-V2.md` (TORQ-VIS-002) + `BLUEPRINT-TORQ-VIS-002-v1.0.md` — **NOT STARTED**, sign-off block blank, and execution targets the separate `TORQ-CONSOLE` repo anyway.

## Cross-cutting owed items that recur in multiple documents

1. **§19 real-socket backpressure** — owed since PRD-005 v0.1's overclaim was withdrawn; re-owed by 007. No owner slice yet.
2. **"May an operator approve a channel-originated task?"** — blocks Phase 2/3 of TrustOS and the C3 delivery lane; needs an operator ruling with a cross-session approval read surface if yes.
3. **SEC-1/SEC-2** (channel session hijack, unauthenticated channel identity) — HIGH, live, required by both Phase 3 and any channel-adapter expansion.
4. **Pilot deployments never really run** — remote-skill publisher pilot (OQ-1), provider pilot (R-E-001 §17): every "pilot" to date has been a loopback fixture.
