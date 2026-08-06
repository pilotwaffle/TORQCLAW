# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 10

- Date: 2026-08-06
- Reviewer model: `claude-opus-5`
- Reviewer role: independent G1R
- Reviewed commit: `9fdc95b`
- Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.10.md`
- Consistency evidence: `PASS 107/107` (internal consistency only)
- Verdict: `REJECT`
- Critical: 0
- High: 1
- Medium: 4
- Low: 4
- Builder handoff: `BLOCKED`

## Findings

### Critical

None.

### High

**Byte-for-byte fixtures are unsatisfiable: no determinism mechanism is specified for server-generated UUIDs and timestamps**

Sections: 10, 7.1, 7.3.

Impact: Section 10 requires byte fixtures for every command success, pinned byte-for-byte, yet every success frame contains values the server generates fresh per run: canonical lowercase UUIDs and RFC 3339 millisecond timestamps in `sessionId`, `principalId`, `credentialId`, `eventId`, `subscriptionId`, `serverTime`, and `occurredAt`. No injected clock, seeded UUID generator, or pre-comparison substitution table is defined anywhere in the 884-line document. A builder records the `CREATE_CHANNEL` fixture at T0; CI reruns the identical scenario and the byte comparison fails on the second execution of every one of roughly forty fixture requirements. The Section 19 gate is permanently unsatisfiable and slice 1 cannot close. High rather than Critical because the design is sound and the omission is purely additive.

Concrete correction: specify a determinism harness — an injected monotonic clock at a pinned start instant with a pinned tick rule, and a deterministic UUID generator seeded per fixture — covering every server-generated field in the Section 7.2/7.3 frame shapes, so two builders produce identical fixture bytes.

### Medium

**`revocation-commit-to-last-write-boundary` is a benchmark pass condition with no definition** — Sections 15, 13, 2. Three defensible measurement endpoints diverge materially under the mandated slow-consumer condition; PASS/FAIL is unadjudicable. Correction: define start (SQLite commit return) and end events, excluding writes initiated before commit.

**Section 15 observation floor is infeasible for the revocation phase, and revocation is single-use** — Sections 15, 5.2. 10,000 observations at a serialized ~6.67/s ceiling need ~1,499 s of a 1,740 s budget across four phases with unstated sequencing, and terminal `REVOKE_AGENT` cannot be repeated per agent. Correction: state phase sequencing, a proportionate revocation floor, and which repeatable mutation supplies observations from what pool.

**`nextChannelId` is returned by `LIST_CHANNELS` but never defined, including for frame-cut and empty pages** — Sections 7.4, 7.1, 10, 14. A builder mirroring the timeline's empty-page fallback can produce a non-advancing token and an infinite client loop; the existing fixture only asserts `hasMore`, not advancement. (Frame-cut computed unreachable at stated limits: worst case 46,490 bytes, capping this at Medium.) Correction: define the token for both cases and add an advancement fixture.

**`torqclaw collab secrets verify` is a mandatory bootstrap gate with no defined arguments or semantics** — Sections 6.3, 9, 10. Under the weak (checksum-only) reading, a kit whose passphrase the operator mistyped passes the gate and the installation reaches healthy with an unusable kit, making the "unrecoverable by design" state reachable with the kit in hand. No audit kind exists for verification. Correction: full invocation line; decrypt-with-passphrase semantics; write `recovery_kit_verified_at`; add the audit enum value and a fixture.

### Low

**"Reject duplicate keys" is not achievable with `JSON.parse`** — Section 7.1. Verified: `JSON.parse` silently keeps the last duplicate and a reviver cannot observe it; detection requires a raw-text position-aware parser. Correction: flag the trap and add an `INVALID_FRAME` duplicate-key fixture.

**The 64 KiB frame limit does not state its measurement basis** — Section 7.1. A `string.length` reading counts UTF-16 code units. Correction: state raw UTF-8 bytes of the complete frame.

**Section 9 DDL permits self-owned and agent-owned agents** — Section 9. Verified against SQLite: both insert successfully; application validations 1 and 3 are the sole enforcement. Defense-in-depth note, not a gap. Correction: strengthen the CHECK or document the deliberate application-layer enforcement.

**Section 15 does not pin the Node.js version for a numeric pass/fail gate** — Section 15. "Node.js LTS" spans majors with materially different V8/libuv behavior. Correction: pin the exact version.

## Reviewer refutation note

Several hostile readings were tested and refuted, and are explicitly NOT findings: the Section 8.3 backlog drain is not a lock-order inversion (mutex scope is decisively stated); the scalar `rejoined_seq` does not contradict the Section 10 re-add test; the ack floor and timeline clamp do not conflict; all four message byte fixtures verify exactly by computation; the flag matrix is exactly 6 valid / 10 invalid; the single-operator partial index, foreign keys, and index coverage verify correct against real SQLite.

## Rubric score

| Criterion | Result | Basis |
|---|---|---|
| 1. Problem, target user, measurable outcome | Pass | Ten falsifiable release conditions. |
| 2. Scope and non-goals | Pass | Exclusions each require a separate PRD; linter enforces them. |
| 3. Flows, edge cases, acceptance criteria testable | Partial | Byte-fixture requirement unsatisfiable without a determinism harness (High); revocation boundary undefined (Medium). |
| 4. Functional and non-functional requirements | Pass | DDL executes as literal SQLite; security, rate limits, accessibility concrete; duplicate-key trap is Low. |
| 5. Assumptions, risks, owners, deadlines | Pass | Named accountable individual, dated, with delegation rules. |
| 6. Analytics, rollout, rollback, support | Pass | Nested flags with startup validation; typed-confirmation destructive path. |
| 7. Feasible independently verifiable slices | Partial | Slice 1's fixture gate cannot close (High); slice 5's benchmark phase infeasible/undefined (Mediums). |

Total: 5 Pass, 2 Partial, 0 Fail.

## Builder handoff conditions

1. Specify the conformance-fixture determinism harness (injected pinned clock, seeded UUID generator, coverage of every server-generated field). Sole High; the only blocking condition.
2. Define `revocation-commit-to-last-write-boundary` with exact start/end events.
3. Resolve the Section 15 observation budget: phase sequencing, proportionate revocation floor, observation source and pool size.
4. Define `nextChannelId` for normal and empty pages with a token-advancement fixture.
5. Give `secrets verify` an invocation line and decrypt-semantics paragraph, the audit enum value, and a fixture.

Items 2-5 are Medium; close them in the same revision. The four Lows may be dispositioned during implementation but are all one-line corrections.
