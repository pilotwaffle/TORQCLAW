# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 4

- Date: 2026-08-06
- Reviewer model: `gpt-5.6-terra`
- Reviewer role: independent final G1R
- Reviewed commit: `2f40e3a`
- Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.4.md`
- Consistency evidence: `PASS 34/34`
- Verdict: `REJECT`
- Critical findings: `0`
- High findings: `3`
- Builder handoff: `BLOCKED`

## Verbatim reviewer output

King Flowers, **review receipt: commit `2f40e3a` only.**

## VERDICT: REJECT

**Critical findings: 0**  
**High findings: 3**

The 34/34 linter PASS supports identifier and limit consistency only. It does not resolve the authorization, credential-handling, or concurrent idempotency defects below.

### Critical
None.

### High

| Finding | Exact section | Impact | Concrete correction |
|---|---|---|---|
| Idempotency is evaluated before channel authorization/state. | §§4.2, 7.4, 7.6 | A removed member can retry a prior channel mutation and receive a stored success; an archived channel can return a prior `POST_CHANNEL_MESSAGE` success instead of `CHANNEL_ARCHIVED`. A changed-body retry can return `IDEMPOTENCY_CONFLICT`, distinguishing a hidden resource from an absent one. This violates the hidden-resource and immediate-revocation guarantees. | Evaluate the current command predicate before idempotency lookup for channel-scoped commands. After membership loss, return `COLLAB_NOT_FOUND`; after archive, return `CHANNEL_ARCHIVED`. Add fixtures for same-key and changed-body retries after membership removal and archive. |
| Credential-return behavior conflicts with the plaintext non-persistence rule and can strand a principal. | §§6.1, 7.4, 9 | `CREATE_AGENT` and rotation return a credential but every keyed result is stored in `collab_mutation_results.result_json`; storing it violates §6.1. Returning `credentialAvailable:false` can leave an active agent/replacement credential unusable, and creation does not return a credential ID or define a safe credential-issuance recovery command. | Define a secret-redacted persisted result and one-time live handoff. Always return `credentialId`, including agent creation. Add an exhaustive `CREATE_PRINCIPAL_CREDENTIAL` command or equivalent recovery flow that can issue a new credential without knowing an unavailable token. Specify replay behavior and acceptance tests for delivery failure after commit. |
| No atomic, concurrent idempotency protocol is required for all keyed mutations. | §§7.4, 8.3, 9, 10 | The PRD promises retries commit once, but only rotation explicitly requires one transaction and §8.3 covers event writers. Concurrent duplicate `CREATE_AGENT`, membership, channel, or lifecycle requests have no mandated lookup/mutate/result-record transaction or loser behavior. The acceptance plan lacks a same-key race test. | Require every keyed command to perform lookup, mutation/event writes, and redacted result persistence in one `BEGIN IMMEDIATE` transaction. On unique-key contention, re-read and return the canonical stored result. Add deterministic parallel same-key tests for every mutation class, including an injected pre-commit race. |

### Medium

| Finding | Exact section | Impact | Concrete correction |
|---|---|---|---|
| The “exact” DDL does not enforce the authority invariants it claims to support, while “transaction checks” are unspecified. | §§4.1, 5.3, 9 | The schema permits an agent to own a channel, an agent to own another agent, arbitrary owner-role memberships, and cursor rows without active membership. The broad final sentence in §9 is not an executable or testable enforcement contract. | Include exact SQLite triggers, or an explicit mandatory transaction-validation algorithm, for operator-only ownership, agent ownership, owner membership, membership role, legal transitions, cursor visibility, and event payload validation. Add direct persistence-level negative fixtures. |
| Session and subscription closure registries are conflated. | §§5.5, 7.4, 8.1, 9 | `UNSUBSCRIBE_CHANNEL` closes a subscription, yet `unsubscribed` is defined and persisted as a **session** close reason. A session may hold multiple subscriptions, so closing it is incorrect; no subscription close record or exact in-memory lifecycle contract exists. | Separate session close reasons from subscription close reasons. Remove `unsubscribed` from `collab_session_bindings`, define subscription lifecycle storage explicitly, and test that unsubscribing one channel leaves the session and other subscriptions live. |
| Rollback is destructive but lacks an operational safety contract. | §11 | Restoring the pre-migration backup discards all post-migration data, including unrelated Phase 1 changes. The PRD does not require a current pre-rollback backup, explicit operator acknowledgement, downtime procedure, or recovery/support receipt. | State the data-loss boundary explicitly; require a current backup before rollback, explicit destructive confirmation, a restore receipt, and rollback-rehearsal assertions for Phase 1 and collaboration data. |

### Low

| Finding | Exact section | Impact | Concrete correction |
|---|---|---|---|
| `node` handling is not protocol-deterministic. | §§4.1, 7.2 | §4.1 defines `node`, while the connect frame only permits `operator|channel`; fixtures nevertheless require “node denial.” Implementers cannot determine whether it is `INVALID_REQUEST` or `ROLE_PRINCIPAL_MISMATCH`. | Define the exact node frame outcome and close behavior, or remove node from the collaboration connection model and its fixture requirement. |

## Rubric

| Criterion | Status | Basis |
|---|---|---|
| Problem, user, measurable outcome | Pass | §§1–2 are concrete and measurable. |
| Scope and non-goals | Pass | §3 is bounded and explicit. |
| Testable flows, edges, acceptance | Partial | Key post-revocation/idempotency and concurrent replay cases are unspecified. |
| Functional/non-functional requirements | Partial | Authority, credential persistence, and subscription-state contracts are incomplete. |
| Assumptions, risks, owners, deadlines | Partial | Risks are present, but named owners remain unassigned before Slice 2. |
| Analytics, rollout, rollback, support | Partial | Observability is strong; destructive rollback handling is insufficient. |
| Independently verifiable implementation slices | Partial | Slice plan exists, but high-risk invariants are not independently executable. |

**Score: 4.5 / 7**

## BUILDER_HANDOFF: BLOCKED

Required conditions:

1. Correct authorization/idempotency precedence and add revoked-member/archive replay tests.
2. Specify safe one-time credential delivery, redacted persistence, credential IDs, and a recoverable credential-issuance path.
3. Define atomic idempotency behavior for every keyed command and add concurrent duplicate-request tests.
4. Resolve the medium findings before implementation handoff to preserve DDL/protocol and rollback feasibility.

## Cycle 4 receipt-ready summary

Commit `2f40e3a` is **REJECTED** for G1R. Critical: **0**; High: **3**. The candidate is internally lint-consistent, but not builder-ready: idempotency precedence bypasses current channel authorization, credential results conflict with secret non-persistence and recovery, and keyed mutation concurrency is not specified atomically.
