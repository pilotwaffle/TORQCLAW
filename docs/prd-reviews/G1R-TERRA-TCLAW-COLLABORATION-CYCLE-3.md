# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 3

- Date: 2026-08-06
- Reviewer model: `gpt-5.6-terra`
- Reviewer role: independent final G1R
- Context isolation: reviewer received only PRD v0.3 and the rubric
- Verdict: `REJECT`
- Critical findings: `0`
- High findings: `5`
- Builder handoff: `BLOCKED`

## Verbatim reviewer output

King Flowers

## VERDICT: REJECT

No Critical findings. Five High findings block safe implementation and builder handoff.

## Findings

### Critical
None.

### High

1. **Every command is required to have active membership and an active channel, making required commands impossible.**  
   **Section:** Addendum C, “Every command and socket write”; Addendum D.1.  
   **Impact:** `CREATE_AGENT` and `CREATE_CHANNEL` have no channel context. `UNARCHIVE_CHANNEL` necessarily targets an archived, not active, channel. This also conflicts with the v0.2 archived read-only behavior.  
   **Concrete correction:** Define separate authorization predicates:
   - Base: open session, active credential, active principal, matching auth epoch.
   - Channel-scoped: base plus membership/channel checks.
   - Operator global commands: base plus operator authority only.
   - `UNARCHIVE_CHANNEL`: owner authorization against an archived channel.
   - State explicitly whether archived channels remain readable and subscribable.

2. **The only normative connect frame hard-codes `role:"channel"`, so the operator cannot establish the required operator session.**  
   **Section:** Addendum D, “Client connect”; Section 4.1.  
   **Impact:** Operator-only commands, including agent creation, credential rotation, and channel creation, cannot be issued through the defined v2 protocol.  
   **Concrete correction:** Define `role` as `operator|channel`, require `operator` for operator principals and `channel` for agents, and add operator and agent connect fixtures plus mismatch denials.

3. **The exhaustive v0.3 command allowlist omits channel discovery and durable cursor acknowledgement.**  
   **Section:** Addendum A; Addendum D.1; v0.2 Sections 9, 11.2, 16.  
   **Impact:** An added agent has no contracted way to discover its channels, and `ACK_CHANNEL_CURSOR` is prohibited by the v0.3 exhaustive allowlist despite durable per-principal cursors and acknowledgement acceptance criteria remaining required.  
   **Concrete correction:** Add normative `LIST_CHANNELS` and `ACK_CHANNEL_CURSOR` commands, including strict request/result schemas, archived-channel behavior, pagination, authorization rules, denial fixtures, and acceptance criteria. Alternatively, explicitly replace server cursors with a defined client-held cursor model, then remove all server-cursor requirements consistently.

4. **Credential rotation does not identify which prior credential is revoked.**  
   **Section:** Addendum C; Addendum D.1; v0.2 Section 6.2.  
   **Impact:** `ROTATE_PRINCIPAL_CREDENTIAL {principalId}` conflicts with the prior selected-old-credential behavior, while Addendum C says rotation revokes “the credential.” Builders cannot determine whether rotation revokes one credential, all active credentials, or none. This can leave unintended credentials active.  
   **Concrete correction:** Choose one rule and encode it in the command. Recommended: `ROTATE_PRINCIPAL_CREDENTIAL {principalId, replaceCredentialId}`; atomically create the replacement and revoke the specified active credential. Define the idempotent retry response and reject credentials not owned by the target principal.

5. **The required migration is not executable as written.**  
   **Section:** Addendum E; v0.2 Section 10.  
   **Impact:** Addendum E requires a unique index on `lower(channel.name)`, but the mandated table is `collab_channels`; no `channel` table exists. Session-binding storage is also not supplied as exact migration DDL despite being mandatory. Slice 0 cannot produce the required exact migration.  
   **Concrete correction:** Provide complete SQL, including:
   ```sql
   CREATE UNIQUE INDEX collab_channels_active_name_ci
     ON collab_channels(lower(name))
     WHERE state = 'active';
   ```
   Specify exact session-table or `ALTER TABLE` DDL, foreign keys, nullability, upgrade behavior for Phase 1 rows, and all required indexes.

### Medium

1. **Performance gate is internally inconsistent and lacks one executable pass condition.**  
   **Section:** v0.2 Sections 3 and 14; Addendum G.  
   **Impact:** v0.2 requires a 100-event timeline query under 100 ms p95 over 100,000 events, while Addendum G specifies a 10,000-event reference environment and does not restate pass/fail latency targets. Builders cannot know the release benchmark.  
   **Concrete correction:** State one authoritative benchmark manifest: dataset size, client count, warm-up, observation count, percentile method, and pass thresholds for timeline, commit, and fan-out.

2. **v0.3 precedence resolves some old clauses, but the source is not consolidated enough for Slice 0 implementation.**  
   **Section:** Addendum A and E; v0.2 Sections 7.4, 10, 11.2, 12, 15, and 16.  
   **Impact:** The precedence clause correctly supersedes v0.2 public tombstone, rename, and client-supplied-principal behavior. However, v0.2 still mandates tombstone state machines, payloads, tests, acceptance criteria, and schema support while Addendum A removes tombstones. This creates avoidable implementation and test-scope ambiguity.  
   **Concrete correction:** Publish a consolidated v0.3 normative command list, event list, state-machine list, acceptance checklist, and migration DDL. Explicitly mark each displaced v0.2 clause as superseded.

### Low

1. **Document front matter still identifies the base PRD as Version 0.2.**  
   **Section:** PRD header; Addendum title.  
   **Impact:** Review, implementation, and release artifacts can cite the wrong version.  
   **Concrete correction:** Change the document header to Version 0.3 and identify the addendum as incorporated.

## Rubric score

Scoring: Pass = 3, Partial = 2, Fail = 0.

| Criterion | Result | Basis |
|---|---:|---|
| Problem, target user, measurable outcome | Pass | Clear target user and measurable collaboration goals. |
| Scope and non-goals | Partial | Scope is bounded, but exhaustive v0.3 commands omit required cursor and discovery flows. |
| User flows, edge cases, acceptance criteria | Fail | Core operator, unarchive, discovery, and durable-cursor flows are not executable under the stated protocol. |
| Functional and non-functional requirements | Fail | Authorization and migration contracts are internally inconsistent; performance gate is ambiguous. |
| Assumptions, risks, owners, deadlines | Pass | Risks, accountable roles, and decision timing are visible. |
| Analytics, rollout, rollback, support | Partial | Coverage is proportionate, but the benchmark and superseded requirements need consolidation. |
| Feasible, independently verifiable slices | Fail | Slice 0 requires an exact migration and frozen contracts that are currently incomplete or contradictory. |
| **Total** | **10 / 21** | **REJECT** |

## Precedence assessment

The addendum’s stated precedence does resolve clearly displaced v0.2 behavior at the public protocol level, including tombstones, rename, and client-supplied principal identity. It does **not** resolve the v0.3 internal authorization contradictions, omitted required commands, invalid migration reference, or benchmark ambiguity.

## BUILDER_HANDOFF: BLOCKED

Builder handoff becomes **READY** only when all of the following are completed:

1. Replace the universal Addendum C validator with operation-scoped authorization rules.
2. Define operator and agent v2 connect frames and role binding.
3. Add or explicitly replace `LIST_CHANNELS` and `ACK_CHANNEL_CURSOR`.
4. Define deterministic credential-rotation revocation semantics.
5. Supply executable, complete v0.3 migration DDL and indexes.
6. Publish one authoritative v0.3 performance manifest with pass thresholds.
7. Consolidate superseded v0.2 state machines, tests, acceptance criteria, and schema instructions into a single v0.3 normative source.
