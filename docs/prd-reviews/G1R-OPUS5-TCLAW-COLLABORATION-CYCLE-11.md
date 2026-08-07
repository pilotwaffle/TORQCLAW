# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 11

- Date: 2026-08-06
- Reviewer model: `claude-opus-5`
- Reviewer role: independent G1R
- Reviewed commit: `fe20293`
- Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.11.md`
- Consistency evidence: `PASS 119/119` (internal consistency only)
- Verdict: `REJECT`
- Critical: 1
- High: 4
- Medium: 4
- Low: 2
- Builder handoff: `BLOCKED`

## Findings (summary; full impact analyses retained in the review transcript)

### Critical

**`CHANNEL_WRITABLE` folds channel state into the authorization predicate, making `CHANNEL_ARCHIVED` unreachable for `POST_CHANNEL_MESSAGE`** — Sections 4.2, 7.4, 7.6. An authorized member posting to an archived channel fails the predicate at step 6, where the only permissible response is `COLLAB_NOT_FOUND`; yet Sections 4.2 and 7.4 mandate `CHANNEL_ARCHIVED` for exactly that caller. Three normative statements are mutually exclusive; denial fixtures cannot be pinned, and an authorized member cannot distinguish archive from removal, contradicting Section 5.4. Correction: `CHANNEL_WRITABLE` = `CHANNEL_VISIBLE`; the active-channel check is a step-8 state error; no predicate may reference channel state; add a linter rule.

### High

1. **Re-add permanently destroys access to the member's own prior intervals, undocumented and untested** — Sections 5.3, 7.4, 9, 10. The scalar `rejoined_seq` floor excludes events the member lawfully read and acknowledged before removal; the stated `max(acknowledged_seq, rejoined_seq)` floor is dead logic (verified: `rejoined_seq` always dominates in legal flows); the (N, M) interval test passes while missing the exclusion. Correction: document the truncation explicitly with pinned sequence numbers, or add a membership-intervals table.
2. **`CURSOR_OWNER` is unsatisfiable on the first acknowledgement** — Sections 4.2, 7.4, 9, 10. The predicate references a cursor row that does not exist until the first ack; a literal implementation denies every first acknowledgement. Correction: `CURSOR_OWNER` = `CHANNEL_VISIBLE`; ack upserts from `acknowledged_seq` 0.
3. **Rotating the operator's sole credential can strand the installation** — Sections 5.1, 6.1, 7.4. The `LAST_OPERATOR_CREDENTIAL` guard covers revocation only; a dropped first-response frame after rotating the only credential forces `locked_recovery` from routine hygiene. Correction: extend the guard to rotation; document create-verify-revoke.
4. **`name_key` full case folding is not implementable from what the PRD names** — Sections 7.1, 7.4, 9, 10, 15. Verified on Node 22: `toLowerCase` is simple lowercasing ("Strasse-form" pairs do not collide as full folding requires), no core Default Case Folding primitive exists, and the Unicode 15.0 pin conflicts with host-ICU Unicode versions. Correction: vendor `CaseFolding.txt` (Unicode 15.0, C+F) as the normative table with a startup version assertion and conflict fixtures.

### Medium

1. **Rotation result shape specified twice with different fields** — Section 7.4 general sentence vs the command signature (missing `principalId`, extra `replacedCredentialId`); byte fixtures unpinnable. Correction: explicit shapes for all three credential commands.
2. **Determinism harness omits `revokedAt`** — the enumeration is scoped to Section 7.2/7.3 shapes while `REVOKE_PRINCIPAL_CREDENTIAL` returns a server timestamp outside it. Correction: extend the enumeration to Section 7.4 results; add a linter coverage check.
3. **Argon2id is not in Node core and no dependency is named** — verified `crypto` exposes scrypt, not argon2; an unnamed native dependency sits on the security-critical path. Correction: pin the package, add to slice 2 deliverables and the risk table with a scrypt fallback.
4. **Body-content validation is assigned to two conflicting precedence steps** — oversize text against a hidden channel yields `INVALID_REQUEST` or `COLLAB_NOT_FOUND` depending on reading (verified no information leak either way). Correction: step 3 owns all channel-state-independent syntactic validation; pin the fixture.

### Low

1. **Validation 6's `rejoined_seq` conjunct is a tautology with an unsatisfiable negative fixture** — verified true in every legal flow. Correction: drop it; restate as a doctor invariant.
2. **Dangling pepper-rotation reference** — the doctor warning names an operation no section defines. Correction: remove the clause and exclude rotation in Section 3.2.

## Reviewer verification note (sound findings pinned so later cycles do not re-litigate)

All four Section 10 message byte fixtures recomputed exactly correct. Flag matrix exactly 6 valid / 10 invalid. Worst-case `channel_event` frame 16,802 bytes and single-event timeline 16,799 — inside 64 KiB; 100 maximum-length `LIST_CHANNELS` rows about 44 KB. The three lock classes impose a consistent global order with writer preference and no upgrade path — no deadlock found, including across the post-lock delivery step. Partial unique index enforces at most one operator. `JSON.parse` duplicate-key and `1e999` Infinity behaviors verified, so both Section 7.1 rules are meaningful. No content leak outside membership intervals, no hidden-channel discovery oracle, no cross-principal cursor leak; the deliberately accepted count-metadata disclosure is correctly scoped and was not counted as a finding.

## Rubric score

| Criterion | Result | Basis |
|---|---|---|
| 1. Problem, target user, measurable outcome | Pass | Ten falsifiable release proofs. |
| 2. Scope and non-goals | Pass | Exclusions bound to separate PRDs; supersession mapped. |
| 3. Flows, edge cases, acceptance criteria testable | Fail | The Critical predicate contradiction plus the shape/harness/step ambiguities leave required fixtures unpinnable. |
| 4. Functional and non-functional requirements | Partial | Strong and specific, but Argon2id and full case folding lack named dependencies. |
| 5. Assumptions, risks, owners, deadlines | Pass | Named accountable owner, dated, delegation rule. |
| 6. Analytics, rollout, rollback, support | Pass | Nested flags, gated slices, typed-confirmation destructive restore. |
| 7. Feasible independently verifiable slices | Partial | Slice 3 carries the unimplementable folding requirement; slice 2 an unnamed native dependency. |

Total: 4 Pass, 2 Partial, 1 Fail.

## Builder handoff conditions

1. Redefine `CHANNEL_WRITABLE` as `CHANNEL_VISIBLE`; move the active-channel check to step 8; state predicate state-purity; add the linter rule.
2. Document re-add truncation explicitly (or add an intervals table) and pin the test with explicit excluded/included sequence numbers.
3. Redefine `CURSOR_OWNER` as `CHANNEL_VISIBLE` with upsert-from-zero ack semantics and a first-ack fixture.
4. Extend `LAST_OPERATOR_CREDENTIAL` to sole-credential rotation with the guard fixture and the create-verify-revoke sequence.
5. Name the vendored fold-table implementation as normative over host ICU with conflict fixtures and a version assertion.
6. Pin the rotation result shape for first response and replay, reconciled with the general credential-shape sentence.
7. Extend the harness enumeration to every server-generated field including `revokedAt`, with a linter coverage check.
8. Name the Argon2id package, add it to slice 2 and the risk table with a stated fallback.
9. Assign all Section 7.1 bounds to step 3 and pin the oversize-versus-hidden fixture.
10. Drop the tautological validation-6 conjunct (restate as doctor invariant) and resolve the pepper-rotation dangling reference.
