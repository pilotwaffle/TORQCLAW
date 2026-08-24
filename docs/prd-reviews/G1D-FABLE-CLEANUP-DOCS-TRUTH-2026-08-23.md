# G1D Packet — Cleanup slice (filed non-blockers) + Docs-truth pass (2026-08-23)

**Author:** Claude Fable 5 (G1D). **Base:** `origin/master` @ `a3c6180`. **Seats:** G1R/verifier/G2A = fresh `claude-opus-5` (disclosed substitutes for 4.7/4.8); Builders = `claude-sonnet-5`; docs = sonnet. Operator authorized commit/push/merge for this session's slices.

## Operator rulings recorded this session (by explicit delegation, 2026-08-23)
- **007 OQ-5 — RULED: silence stays model-side** (A3-f). No gateway silence rule. Observability = existing `no_post` accounting.
- **Remote-skills OQ-1/OQ-2 — DEFERRED explicitly**: no pilot publisher chosen (none in use); TTL re-ratification (30d) ships with the first real publisher. Flag posture unchanged.
- **AUTH-005 Phase 1/2A — LAND as its own gated slice in a following session**: rebase onto current master → fresh verify → fresh G2A → push. V2_FINAL/cutover remain unauthorized.
- **PRD-1 residuals — ledger closed**: R-3 acknowledged; held container: extract audit artifacts then delete (operator-gated deletion); Phase-C worktrees: delete once commits confirmed merged (operator-gated).
- **e2e-channel auth contract — RULED: tokens-required-always** (consistent with auth v2; loopback is not a trust boundary per standing memory). The CI step must provision a token, not expect dev-mode acceptance.
- **cron NB-5 — RULED: recovery stays non-flag-gated**, documented as deliberate (recovery of committed state must not depend on a feature flag).

## Item C — bounded corrections (all filed non-blocking in prior gate records; sources: STATE.md:28, docs/FOLLOWUPS-CI-E2E-GATES.md, PRD-007 §9 F1/F2)

**Controlling invariant:** every fix closes a *recorded* gap exactly as filed — no behavior change beyond the filed defect, no test weakened, fail-closed direction preserved everywhere.

In scope (Builder M — TS/gateway/collab):
1. `ignoredKinds` — thread into dispatch telemetry (RESULT metadata) so the doc claim becomes true; fix the two overclaiming comments (`subscriptionAcpRuntime.ts:274,479`).
2. `frame.id` validated as `string|number` before echo into the `-32601` reply (`subscriptionAcpRuntime.ts:91,189`).
3. T-6 adapter-version pin: test asserting installed `@agentclientprotocol/claude-agent-acp` version === the version T-6 was proven against (0.64.2); on mismatch fail with "re-run T-6 before trusting endpoint_bound".
4. kind-from-role guard: `listChannelMembers` selects `principals.kind` (JOIN already present) instead of deriving from role; keep-set equality tests unchanged in shape.
5. 007 F1: apply the self-reply guard on the coalesced re-dispatch path (mirror `resolveEligibleAgents`' `principal_id != actor` check before dispatching a coalesced row).
6. 007 F2: a deterministic policy failure must not re-dispatch one extra lap under a new PK; bound it to zero extra laps, loudly logged.
7. CO-9: fix the throwing `code` getter (see FOLLOWUPS/PRD-005 record for location).
8. cron NB-2 (test title fix) and NB-4 (recovered run must carry `promptHint`).

In scope (Builder N — ops/CI/Python):
9. `pnpm lint` vacuous: implement the smallest HONEST lint gate — if ESLint config exists anywhere, wire `lint` tasks so turbo runs them; if none exists, add a minimal flat-config ESLint (recommended rules, no stylistic churn; errors only for correctness classes) to the TS packages and a `lint` script each. If that exceeds ~30 min of scope, downgrade to making `pnpm lint` EXIT NON-ZERO with "lint not configured" (an honest red beats a vacuous green) and file the full setup.
10. TRUTHY-vs-"1": widen the Python `TORQCLAW_WEB_SEARCH_ENABLED` gate to the same truthy set as TS ({"1","true","yes","on"}, case-insensitive) — per G2A's direction (widen Python, never narrow TS). Update the flag test.
11. `ops/doctor.mjs:62` legacy-token staleness — align with the credential-file runtime (probe operator credential path, not the deprecated env token).
12. e2e-channel 502 red CI step — under the tokens-required-always ruling: make the CI step provision `TORQCLAW_CHANNEL_SERVICE_TOKEN` and assert 200; cite run `32212529483` in the commit.
13. cron NB-1 (commit the poison-router FRONTIER test if it exists uncommitted; else write it per the FOLLOWUPS description).

**Explicitly deferred (filed, not this slice):** C-S3-1/CO-S3-1 (gateway-wide ERROR-envelope fix — needs its own G1R, it touches every frame consumer), cron NB-3 (unmodeled mid-turn refusals — needs design), NB-RA-1/2 (underspecified), §19 backpressure.

**Non-scope / prohibited:** no authz/approval/routing semantics changes; no test weakened or deleted; no vendored edits; no new deps beyond ESLint (item 9, if chosen); `.claude/agents/*`, `ops/skill-staging/**`, unrelated docs untouched.

**Acceptance:** each item has a test or a gate that was previously silent and now bites (RED→GREEN where the defect is reproducible); full vitest + Python suites, typecheck --force, build --force, contracts check, reachability green; pnpm lint either genuinely runs linters or is honestly red — never 0-task green.

## Item D — docs-truth pass (docs must match shipped reality; evidence = git log + STATE.md)
1. `PRD-007` header: v0.1 DRAFT → "v1.0 — S1–S7 SHIPPED (PRs #53/#54, master 4252a6a/962d6bf); Gate records in docs/prd-reviews/". §3 ledger rows 9–12 corrected (live push wired, departure signal shipped — cite server.ts sites). §4 R-3a: mark superseded by OQ-3 closure. §9: OQ-4 (flag names shipped as-is = ruled by adoption), OQ-6 (resolved by the shipped S2 path — record which option), OQ-7 (ruled via B-1 fence fix `a676736`) — all annotated RESOLVED with citations. OQ-1 annotated: FileSecretStore (`9b544ee`) discharged the blocker; CredMan-native adapter remains an owed improvement.
2. `docs/PRD-MAP.md`: recompile the PRD-007 row (S1–S7 shipped), date bump, add the 2026-08-22/23 shipments; correct TrustOS row only where evidenced.
3. `README.md` roadmap: sync the one stale bullet against PRD-MAP (no marketing edits).
4. Record the six operator rulings above in the PRDs they belong to (007 §9 for OQ-5; remote-skills PRD for OQ-1/2 deferral; FOLLOWUPS doc for the e2e auth ruling + NB-5).
5. `STATE.md`: new dated section after this slice's G2A (memory-writer, post-approval only).

**Docs acceptance:** no claim without a citation (commit SHA, file:line, or gate record); nothing deleted from historical gate records; PRD text edits never weaken a frozen ruling.

## Rollback
Every item independently revertible; commits partitioned C-TS / C-ops / D-docs, explicit paths only.

---

## G1D resolution of G1R findings (round 1 — seat `claude-opus-5[1m]`, the designated G1R model per CLAUDE.md §2; verdict REJECT)

**Root cause accepted:** the packet treated STATE.md/FOLLOWUPS as a live defect ledger; the tree at `a3c6180` is the source of truth. Every item now requires RED-on-master or converts to a docs annotation.

| # | Disposition |
|---|---|
| B-1 | **ACCEPTED.** Items 5/6 struck from build scope — F1 guard (`latestChannelSeqAuthor`, "G2A C-1") and F2 bound (`failed` flag, dropped-not-deferred) are shipped. Replaced by TEST-ONLY obligations T-1/T-2 (extend a3c assertion 2 to coalesced rows; deletion-probe both guards; pin `dirty`-cleared-even-when-failed) + docs annotation RESOLVED with citations. `autoReplyDispatcher.ts` source is FROZEN this slice. |
| B-2 | **ACCEPTED.** Item 11 struck — `resolveDoctorAuth` already ships the fail-loud credential path. Docs annotation closes FOLLOWUPS item 2. No degrade-to-OK fallback may be introduced. |
| B-3 | **ACCEPTED.** Item 12's code half struck — `ops/e2e-channel.mjs:63,68` already provisions the token. The operator's tokens ruling is recorded as RATIFYING the conditional contract (`launcher-config.mjs:48-54`), never as authorizing an unconditional requirement. CI-red cause is UNKNOWN and recorded as such — not fixed. |
| B-4 | **ACCEPTED.** Item 7 struck — CO-9 has no reachable defect (`CollabError.code` is a data property); disposition stays conditional-future; the one owed edit is the A6(b) parenthetical (docs). No new try/catch on error paths. |
| B-5 | **ACCEPTED — option (b).** Item 4 proceeds as a decision-reversal, honestly framed as defense-in-depth (not a closed defect): explicit `'operator'→'human'` mapping; forged-membership negative fixture via `store.rawDb` (RED against role-derived kind); wire never carries `kind:'operator'`; `ChannelMemberEntry` doc block updated. |
| B-6 | **ACCEPTED.** Item 9 reduced: NO ESLint this slice; `pnpm lint` becomes self-describing ("lint not configured — see docs/FOLLOWUPS", exit 0, output distinguishable from a pass); scoped ESLint-adoption task filed with named packages and findings-owner = operator. |
| NB-1..NB-6 | Adopted: corrected coordinates (`:274`, `:483-486`); T-4 key-space closure; T-5 scalar contract (number id allowed per JSON-RPC, pinned); NB-3 `.trim()` parity + all three mirroring comments in the same commit; NB-4 absent-package fails loud; NB-5 OQ-4 recorded as "shipped names; **operator ratification still owed**"; NB-6 cron items discovery-first, report before writing. |

Gate 1 **resolved**; build may begin under the corrected boundaries.
