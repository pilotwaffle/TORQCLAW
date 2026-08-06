# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 5

- Date: 2026-08-06
- Reviewer model: `gpt-5.6-terra`
- Reviewed commit: `f851aae`
- Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.5.md`
- Consistency evidence: `PASS 40/40`
- Verdict: `REJECT`
- Critical: `0`
- High: `2`
- Medium: `1`
- Low: `1`
- Builder handoff: `BLOCKED`

## Verbatim reviewer output

King Flowers,

## VERDICT: REJECT

**Critical: 0**  
**High: 2**  
**BUILDER_HANDOFF: BLOCKED**

### High findings

1. **64 KiB frame limit conflicts with 512 KiB timeline pages**
   - Sections: PRD §7.1, §7.3, §7.4, §10
   - Impact: All protocol frames are capped at 64 KiB, but `GET_CHANNEL_TIMELINE` permits a 512 KiB encoded page returned in a `result` frame. The specified maximum response is therefore impossible to transmit, and the required timeline acceptance test cannot be satisfied as written.
   - Correction: Either cap the encoded timeline response, including envelope overhead, below 64 KiB, or define a distinct larger maximum for server result frames and update framing fixtures/validators accordingly.

2. **Unicode case-insensitive channel uniqueness is not enforceable by the stated DDL**
   - Sections: PRD §7.1, §7.4, §9, §10
   - Impact: SQLite's built-in `lower()` does not provide Unicode case folding. The exact index `UNIQUE ... lower(name)` therefore cannot enforce the required NFC, Unicode case-insensitive uniqueness. Concurrent `CREATE_CHANNEL` or `UNARCHIVE_CHANNEL` operations can create names that the protocol declares conflicting.
   - Correction: Specify one deterministic strategy:
     - restrict channel names to ASCII, or
     - add a persisted canonical Unicode case-fold key with a named/versioned algorithm and a unique index on that key.
   - Apply the same key to creation, unarchive conflict detection, and acceptance fixtures.

### Medium findings

1. **Archive socket-write guarantee is ambiguous**
   - Sections: PRD §2, §5.4, §7.4, §8.1-§8.2, §10
   - Impact: §2 groups archive with changes that prevent new socket writes after linearization, while archived channels remain readable and subscribable. The PRD does not say whether archive closes existing subscriptions, drops pre-archive buffered events, or permits read-only post-archive deliveries. The acceptance condition is not deterministically testable.
   - Correction: State whether the guarantee means “no newly unauthorized write” or “no channel delivery after archive.” Define subscription/queue behavior and the required close reason or read-only continuation behavior.

### Low findings

1. **Final-status pre-gate evidence is stale and internally confusing**
   - Artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-FINAL-STATUS.md`
   - Impact: It cites a v0.4 `34/34` report in several places while the committed v0.5 consistency artifact reports `40/40`. This can mislead future gate readers.
   - Correction: Replace stale v0.4 pre-gate references with the v0.5 report and explicitly label historical v0.4 evidence as historical.

## Rubric score

| Rubric criterion | Result |
|---|---|
| Problem, user, measurable outcome | Pass |
| Scope and non-goals | Pass |
| Testable flows, edge cases, acceptance | Partial |
| Functional/non-functional requirements | Partial |
| Assumptions, risks, owners | Pass |
| Analytics, rollout, rollback, support | Pass |
| Feasible, independently verifiable slices | Partial |

**Score: 31/40, assessed independently.**

The committed consistency report’s **PASS 40/40** is valid only as internal-consistency evidence; it does not prove protocol feasibility or Unicode semantic correctness.

## Audit focus disposition

- Authorization before idempotency: specified correctly.
- One-time credential delivery/recovery: secret-redacted and recoverable through new credential issuance.
- Keyed-command atomicity and lock ordering: specified with transaction/result atomicity and race barriers.
- `CollaborationStore` invariants: explicitly required and acceptance-tested.
- Session vs. subscription closure: separated correctly.
- Rollback safety: adequately guarded.
- Node denial: deterministic.
- Event/DDL parity: aligned.
- Replay concurrency: sequencer/high-water design is specified.
- Privacy controls: appropriate for scope.

## Receipt-ready Cycle 5 summary

**Cycle 5 G1R Receipt**  
Reviewed commit: `f851aae`  
Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.5.md`  
Supporting committed artifacts: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-V0.5-CONSISTENCY-REPORT.md`; `docs/prd-reviews/PRD-TCLAW-COLLABORATION-FINAL-STATUS.md`  
Rubric: `C:\Users\asdasd\.agents\skills\prd-review-pipeline\references\prd-rubric.md`  
Verdict: `REJECT`  
Counts: Critical `0`, High `2`, Medium `1`, Low `1`  
Consistency evidence: `PASS 40/40`, treated as internal consistency only, not correctness proof.  
Builder handoff: `BLOCKED` pending resolution of the timeline-frame contradiction and Unicode channel-name uniqueness contract.
