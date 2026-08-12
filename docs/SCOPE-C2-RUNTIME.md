# SCOPE — C2 Approval Broker RUNTIME

Branch `c2-runtime-work`, worktree `E:/TorqClaw-worktrees/c2-runtime`, from `master` @ `76b8189`.
Spec: `docs/prd-reviews/PRD-TCLAW-COLLAB-GATEWAY-004.md` (revision 4, adopted).
Operator authorization for the C2 runtime build recorded 2026-08-12.

**NOT merged, NOT pushed.** C1 is shipped and untouched except where the PRD
requires C2 to extend it. A9 is C3 and was deliberately not built.

---

## 1. Status: all eight C2 tickets landed

| Ticket | Commit | What landed |
|---|---|---|
| C2-1 additive migration | `9b0d525` | six guarded nullable columns on canonical `tool_approvals`, `idx_tool_approvals_status_expires`, the three additive sidecars; plus the C1 §7 owed item (`gateway_profile_delegations` + four delegation columns on `gateway_task_origins`) |
| (cross-cutting 9) storage handle | `1fbf209` | `state.db` handle made lazy + re-resolvable; own commit, own tests |
| C2-5 `CTXHASH_V1`/`ACTIONHASH_V1` | `119d717` | versioned length-prefix-framed serializer, all five frozen vectors reproduced, §3.1 argument validation |
| C2-2 decision evidence | `119d717` | origin at registration, decision evidence written in the SAME guarded transaction, one grant on APPROVE only |
| C2-3 authority vs origin | `119d717` | CT-2 live role + `holdsAuthority` gate, structural self-approve refusal, channel/automation exclusion |
| C2-4 expiry | `119d717` | one canonical clock, one writer, sweep + lazy materialization, legacy NULL rows inert |
| C2-6 redacted card | `09d2e9d` | allowlist card projection, raw-args emit replaced, console updated, built-artifact gate |
| C2-7 delivery projection | `2d517b1` | rebuildable/droppable `approval_deliveries`, eligibility re-evaluated at rebuild |
| C2-8 grant admission | `2d517b1` | one-shot exact-action consumption at the real pre-tool seam, FRONTIER fail-closed |
| (SI-4) flag-off identity | `HEAD` | approval-bearing transcript proven byte-identical flag-off |

## 2. Gates

| Gate | Result |
|---|---|
| TS suite (**no exclusions**) | **93 files / 1723 tests, ALL PASS** |
| TS suite (briefed exclusion set) | 83 files / 1660 tests, all pass (baseline 75/1536) |
| Reachability | **PASS — 106 modules** (baseline 100; +6 C2 modules), `skillTrust.ts` still the only declared dormant |
| Build | 8/8 successful |
| PRD gate | **PASS 225 checks / 0 failed** — unchanged from baseline (kernel-adjacent files stayed neutral) |
| Built-artifact (§5(c)) | 5/5 — boot migration, idempotent re-boot, raw-args-never-on-wire, flag-off inertness |
| SI-4 flag-off | byte-identical approval transcript, **0 rows** in all three C2 tables, all six columns NULL, legacy REJECT still transitions |

### A note on the briefed exclusions

The brief said to exclude `tests/failover/**` and
`tests/collab-connect-dataflow.test.ts` as pre-existing breakage from a broken
Python venv. **Both actually pass in this worktree** — `tests/failover/` is
9 files / 62 tests green, and the dataflow test is 1/1 green. The exclusion
appears to be stale. The headline number above is therefore the *unexcluded*
run, which is the stronger claim.

## 3. Deletion probes (sabotage → RED → restore)

Six controls, each sabotaged, each confirmed RED, each restored green.

| # | Control | Sabotage | Result |
|---|---|---|---|
| 1 | Additive migration | replace guarded ALTERs with `DROP TABLE` + `CREATE` rebuild | **3 RED** — row/rowid/`args_json` preservation, original CREATE survival, six-column delta |
| 2 | `CTXHASH_V1` framing | use JS char length instead of UTF-8 byte length | **4 RED** — both frozen digests + the byte-length assertions |
| 3 | Single writer / live role read | remove the live `surfaceRole !== 'operator'` check | **2 RED** — the demotion attack and deny-first revocation |
| 4 | Redaction (prop 8) | restore `args: error.args` on the emit | **3 RED** — including the **booted-artifact** gate |
| 5 | FRONTIER fail-closed | remove the `path === 'FRONTIER'` refusal | **3 RED** — all three obligation-5 tests |
| 6 | Grant consumption | stop writing `consumed_at` | **2 RED** — durable consumption + one-shot |

## 4. Pre-registered obligations

| # | Obligation | Status | Where |
|---|---|---|---|
| 1 | Demotion-without-revocation cannot regress | **DONE** | `collab-c2-writer.test.ts` — demoted-but-unrevoked surface refused (`surface-not-operator`); re-promotion does not resurrect the stale-epoch grant |
| 2 | Raw-args emit replaced, proven on the built artifact | **DONE** | `dispatch.ts` emit replaced; `collab-c2-built-artifact.test.ts` drives a real gated call and asserts the prompt arg is `withheld` |
| 3 | `gateway_profile_delegations` + `delegation_id` in origin capture | **DONE** | `surfaceSecurity.ts` ledger + four guarded columns on `gateway_task_origins` |
| 4 | storage.ts singleton test-isolation hazard | **DONE** | own commit `1fbf209`, 5 tests, production behaviour unchanged |
| 5 | FRONTIER fail-closed at the grant seam | **DONE** | `grantAdmission.ts` refuses by name before touching state; 3 tests incl. "consumes nothing" |

## 5. Findings worth recording

**A vacuous mandatory gate, caught and fixed.** The first version of the
prop-8 built-artifact test passed while producing **zero** `PENDING_APPROVAL`
frames — no local model is installed, so the run never reached a gated tool
and the operator's mandatory gate was asserting over an empty set. It now
drives the shipped `TORQCLAW_E2E_FORCE_GATED_TOOL` seam and **asserts at
least one approval frame exists** before asserting anything about it. Any
built-artifact gate that can silently observe nothing is not a gate.

**`approvals.ts` was a second status writer.** M-1/M-2 requires exactly one
writer of `tool_approvals.status`, and the shipped `decideApproval` had its
own inline `UPDATE`. It now delegates the byte-identical legacy predicate to
`approvalWriter.legacyStatusTransition`. The single-writer audit is itself a
test that greps every gateway module, so this cannot silently regress.

**Expiry inside the decision transaction was rolled back by its own
refusal.** Materializing expiry and then throwing to refuse the decision
undid the `expired` write, stranding past-deadline rows at `pending` forever.
Expiry now commits in its own transaction before the decision opens.

**The reachability gate caught two orphans**, which is what it is for:
`grantAdmission.ts` and `approvalDelivery.ts` were fully tested but wired to
nothing. Both now sit on real paths (boot recovery; the LOCAL_EDGE admission
injection). Green units on an unreachable module prove nothing.

**Scope note on prop 8.** The operator's typed prompt *does* still appear in
the `USER_PROMPT` echo, because they typed it themselves and the gateway
echoes submitted prompts back to the submitting session. That is separate
pre-existing behaviour, not what property 8 governs — prop 8 concerns the
model's *proposed tool arguments* being reflected onto the approval card. The
assertion is scoped accordingly and the reasoning is recorded in the test.

## 6. Owed / deliberately not built

- **A9 and property-10 async apply re-validation** — C3 by spec. Not built.
- **OQ-5 TTLs** are implemented at the PRD's fail-closed defaults (15 min
  approval, 60 s grant) as named constants. Operator ratification still owed
  before R3 canary.
- **OQ-8 performance budgets** — no numeric latency/lock thresholds were
  measured or ratified; §6.10 makes this a runtime-authorization blocker.
- **The BRIDGE executor path** is accepted by `admitToolCall` but only the
  LOCAL_EDGE loop is wired to call it. Every bridge executor must traverse
  the same seam before C2-8's AC is fully discharged; FRONTIER is explicitly
  fail-closed rather than unwired.
- **`registry_enforcement_hash` is stored and compared but not yet computed
  from the live registry** — the §2.13 formula needs a real producer at
  provisioning time. Comparison is exact, so a wrong value denies; it cannot
  open authority.
- **Socket-close on revocation** (OQ-6) remains deferred, as in C1.
- **Delivery transport** — `approval_deliveries` is written and rebuilt, but
  nothing yet pushes a card to a surface over the wire; that is the C3
  channel-adapter lane.
