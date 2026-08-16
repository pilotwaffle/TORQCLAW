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
| C2-8 grant admission | `2d517b1` | one-shot exact-action consumption at the real pre-tool seam |
| (SI-4) flag-off identity | `c837e6d` | approval-bearing transcript proven byte-identical flag-off |
| **G2A round 1 fixes** | `94db711`, `a15b414` | D-1 producer wiring, D-2 FRONTIER fences, D-3 APPROVE leg, D-4 primitive allowlist, D-5 admission-aware E2E seam, D-7 count anchor |

## 2. Gates

| Gate | Result |
|---|---|
| TS suite (**no exclusions**) | **94 files / 1730 tests** — all pass; see the load-sensitivity note below |
| Reachability | **PASS — 107 modules** (baseline 100; +7 C2 modules), `skillTrust.ts` still the only declared dormant |
| Build | 8/8 successful |
| PRD gate | **PASS 225 checks / 0 failed** — unchanged from baseline (kernel-adjacent files stayed neutral) |
| Built-artifact (§5(c)) | 5/5 — boot migration, idempotent re-boot, raw-args-never-on-wire, flag-off inertness |
| **Flag-ON built-artifact E2E** | **3/3** — pending -> C2 binding -> APPROVE mints one grant -> re-run admitted once -> replay mints no second grant; plus both FRONTIER fences |
| SI-4 flag-off | **both decision legs** byte-identical (REJECT and APPROVE), **0 rows** in all three C2 tables, all six columns NULL, the decision still transitions |

### Load sensitivity of `collab-build-lock` (re-run before calling it a regression)

Under FULL-suite parallel load on this box, `tests/collab-build-lock.test.ts`
intermittently fails on wall-clock assertions (`reclaims a valid dead PID
immediately` asserts the reclaim completes in under 2 s). It passes reliably
in isolation (6/6), and co-run with both new C2 E2E suites (11/11).

This is a pre-existing property of that test, not a C2 regression: it
measures elapsed real time, so it degrades with CPU saturation rather than
with anything C2 changed. The C2 lane did make saturation more likely by
adding two suites that boot real gateways, and that is worth stating rather
than hiding. **No C2 test is load-sensitive** — the flag-on E2E, SI-4, and
built-artifact suites pass in every run recorded here.

Method used, and recommended: re-run a suspected failure isolated before
treating it as a regression. Same discipline the fanout-unit C1 probe needed.

### A note on the briefed exclusions

The brief said to exclude `tests/failover/**` and
`tests/collab-connect-dataflow.test.ts` as pre-existing breakage from a broken
Python venv. **Both actually pass in this worktree** — `tests/failover/` is
9 files / 62 tests green, and the dataflow test is 1/1 green. The exclusion
appears to be stale. The headline number above is therefore the *unexcluded*
run, which is the stronger claim.

## 3. Deletion probes (sabotage → RED → restore)

Eight controls, each sabotaged, each confirmed RED, each restored green.
Probes 7 and 8 target the NEW wiring and are the ones that would have
caught the G2A round-1 defects.

| # | Control | Sabotage | Result |
|---|---|---|---|
| 1 | Additive migration | replace guarded ALTERs with `DROP TABLE` + `CREATE` rebuild | **3 RED** — row/rowid/`args_json` preservation, original CREATE survival, six-column delta |
| 2 | `CTXHASH_V1` framing | use JS char length instead of UTF-8 byte length | **4 RED** — both frozen digests + the byte-length assertions |
| 3 | Single writer / live role read | remove the live `surfaceRole !== 'operator'` check | **2 RED** — the demotion attack and deny-first revocation |
| 4 | Redaction (prop 8) | restore `args: error.args` on the emit | **3 RED** — including the **booted-artifact** gate |
| 5 | FRONTIER refusal (unit) | remove the `path === 'FRONTIER'` refusal in `admitToolCall` | **3 RED** — all three obligation-5 unit tests |
| 6 | Grant consumption | stop writing `consumed_at` | **2 RED** — durable consumption + one-shot |
| 7 | **C2 producer wiring (D-1)** | revert `dispatch.ts` to the legacy-only `registerApproval` — the exact original defect | **RED** — flag-on E2E fails "registration MUST write a C2 binding" |
| 8 | **FRONTIER fences (D-2)** | remove BOTH the APPROVE_TOOL guard and the `dispatchLegacy` executor fence | **2 RED** — the booted-artifact refusal and the shipped-guard assertion |
| 8c | **Failover fence (N-1)** | remove ONLY the `dispatchFailover` fence, leaving the legacy one intact | **RED** — the failover case terminates `FAILOVER: failover_failed` instead of the refusal, while the legacy case stays green |

Probe 8 is also the reason the executor fence sits **before** the
engine-availability check. With the fence placed after it, this probe stayed
GREEN on a box with no reachable Hermes engine: `FRONTIER_UNAVAILABLE` masked
the missing control entirely. A security refusal that only fires when the
engine happens to be down is not a control, and the first version of that
test would have shipped the hole a second time.

## 4. Pre-registered obligations

| # | Obligation | Status | Where |
|---|---|---|---|
| 1 | Demotion-without-revocation cannot regress | **DONE** | `collab-c2-writer.test.ts` — demoted-but-unrevoked surface refused (`surface-not-operator`); re-promotion does not resurrect the stale-epoch grant |
| 2 | Raw-args emit replaced, proven on the built artifact | **DONE** | `dispatch.ts` emit replaced; `collab-c2-built-artifact.test.ts` drives a real gated call and asserts the prompt arg is `withheld` |
| 3 | `gateway_profile_delegations` + `delegation_id` in origin capture | **DONE** | `surfaceSecurity.ts` ledger + four guarded columns on `gateway_task_origins` |
| 4 | storage.ts singleton test-isolation hazard | **DONE** | own commit `1fbf209`, 5 tests, production behaviour unchanged |
| 5 | FRONTIER fail-closed at the grant seam | **DONE (corrected after G2A D-2)** | `grantAdmission.ts` refuses by name; **and, because that function was unreachable from the real FRONTIER path, two live fences now exist** — the APPROVE_TOOL guard and the `dispatchLegacy` executor fence, sharing one exported refusal. Pinned by the booted-artifact test in `collab-c2-flag-on-e2e.test.ts` |

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

**THE ROUND-1 VERDICT, RECORDED PLAINLY.** G2A rejected the first C2
submission with two blocking defects, and both were the same failure:
**controls that existed but were connected to nothing.**

- **D-1:** `registerC2Approval` / `decideC2Approval` had ZERO production
  callers. Every C2 unit test was green, every built-artifact test was
  green, and the slice was 100% non-functional flag-on — the live flow
  still ran the legacy register/decide, so no grant was ever minted and
  every approved LOCAL_EDGE re-run would have been refused `grant-missing`.
- **D-2:** `refuseFrontier` was reachable only through `admitToolCall`,
  which the FRONTIER path never calls. It was dead code, the tier was
  **unwired-and-OPEN**, and §6 of this document asserted it was
  "explicitly fail-closed rather than unwired" — **which was false as a
  runtime statement.** That sentence has been removed and replaced below.

What let both survive a full green review: there was no **flag-ON**
end-to-end test. Every gate ran either flag-off or against modules in
isolation, so "the machine works" was never actually asserted. The
mandatory flag-on E2E added here (`collab-c2-flag-on-e2e.test.ts`) fails
loudly under both defects, and probes 7 and 8 prove it.

**Two real bugs the new flag-on E2E immediately found**, neither of which
any unit test could have surfaced:

1. The re-minted task row is written inside the decision transaction (the
   grant's FK requires it) and `dispatch` then created it again — a UNIQUE
   violation that **killed the gateway process**. `taskStore.create` is now
   idempotent, using DO NOTHING rather than upsert so the authoritative
   pre-execution record is never silently rewritten.
2. Fencing admission on `collabEnabled()` alone refused *legacy* flag-on
   traffic with `grant-missing` — a genuine SI-4 break, caught only because
   D-3 forced the APPROVE leg into the identity transcript. The fence now
   requires both the flag and an actual grant row for that dispatch request.

**Round 2 (G2A N-1): the same mistake, one route over.** Round 1's D-2 was
a FRONTIER refusal that no path reached. Round 2 found the executor fence
added to fix it guarding only ONE of the two routes `dispatch()` can take —
`TORQCLAW_PROVIDER_FAILOVER_ENABLED=true` sends FRONTIER to
`dispatchFailover`, which had no fencing at all, so a flag-on legacy/unbound
approval re-minted to FRONTIER reached the cloud engine under a name-only
grant. The fix factors the predicate and the terminal into one shared pair
consulted by both routes, because "add another copy of the check" is how
this defect keeps regenerating. `hasC2Binding` was deleted in the same pass
(N-2): it had no caller and its comment claimed an enforcement role it never
had, which is worse than absent in a security module.

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
  the same seam before C2-8's AC is fully discharged.
- **FRONTIER is refused, not fenced.** Stated precisely, because earlier
  wordings here were twice false. There is no args-aware admission on the
  FRONTIER path and none is claimed. Instead, under the flag, a FRONTIER
  run carrying a gateway-issued grant is **refused at three sites**,
  covering every route that can reach the engine:

  | Site | Path it closes |
  |---|---|
  | `server.ts` APPROVE_TOOL guard | a C2-bound approval never dispatches a FRONTIER re-mint |
  | `dispatchLegacy` executor fence | a granted FRONTIER run with failover **off** |
  | `dispatchFailover` executor fence | a granted FRONTIER run with `TORQCLAW_PROVIDER_FAILOVER_ENABLED=true` (G2A N-1) |

  The two executor fences share one predicate (`frontierGrantFenced`) and
  one terminal (`refuseFrontierGrantedRun`), so they cannot drift apart,
  and each is placed before any engine or projection side effect on its
  route. Both are pinned by the parameterized booted-artifact test, and
  deletion probe 8 sabotages each site independently.

  With all three closed, the tier is genuinely unusable for gated tools
  under the flag — the intended fail-closed posture. Making it *usable*
  requires the separately authorized Hermes structured-grant protocol
  (PRD §3.4.2 step 5). **BRIDGE executors remain owed** (above): they are
  accepted by `admitToolCall` but nothing yet routes them through it.
- **D-6 (C3 obligation):** `approvalDelivery.actionableForSurface` does not
  re-check surface eligibility at read time — it filters on the approval
  still being pending, not on the target still being an eligible operator
  surface. Harmless until C3 gives the projection a real transport (rebuild
  does re-check), but it MUST be closed before any card is actually
  delivered to a surface.
- **`registry_enforcement_hash` is stored and compared but not yet computed
  from the live registry** — the §2.13 formula needs a real producer at
  provisioning time. Comparison is exact, so a wrong value denies; it cannot
  open authority.
- **Socket-close on revocation** (OQ-6) remains deferred, as in C1.
- **Delivery transport** — `approval_deliveries` is written and rebuilt, but
  nothing yet pushes a card to a surface over the wire; that is the C3
  channel-adapter lane.
- **Delivery transport** — `approval_deliveries` is written and rebuilt, but
  nothing yet pushes a card to a surface over the wire; that is the C3
  channel-adapter lane.

### Noted by G2A, judgment applied, not fixed here

- **`GRANT_TTL_SECONDS = 60` measured from the DECISION clock** can expire a
  legitimately approved action behind slow local inference — on this box a
  cold re-run takes multiple seconds, so the margin is real but not
  comfortable. Left as-is deliberately: changing when the clock starts (e.g.
  at delivery) is a semantic change to the §1.4 invariant and belongs with
  the OQ-5 ratification, not in a defect-fix pass. **Operator remedy is
  re-approval**, which is safe by construction (a fresh approval mints a
  fresh grant). Flagged for OQ-5.
- **`resetStateDbForTest` and module-scope prepared statements — now FIXED
  for the one statement that mattered.** This bit during the N-1 work: the
  parameterized FRONTIER test re-points the data dir between cases, and
  `events.ts` had prepared its `INSERT INTO events` at import time. A
  prepared statement is bound to the connection it was prepared on, so
  events kept going to the OLD database while the test seeded its session
  into the NEW one — surfacing as an unhandled `FOREIGN KEY constraint
  failed` that looked exactly like a defect in the fence under test.
  `insertEvent` is now prepared lazily and re-prepared when the handle
  changes; production is unaffected (the handle resolves once at boot, so
  it still prepares exactly once). `resetStateDbForTest` also gained a
  `{ close: false }` detach mode for the case where in-flight async work
  still needs the old connection. Other module-scope statements elsewhere
  remain, but none is on a path that re-points mid-process today.
- **The channel-kind deny-list is triplicated** (`approvalWriter.ts:58`,
  `surfaceSecurity.ts:45`, `approvalDelivery.ts:64`). All three agree today
  and each is independently tested. Consolidating is correct, but the same
  three-copy pattern is what makes each seam readable in isolation; recorded
  so the next lane can unify it deliberately rather than discovering it.
