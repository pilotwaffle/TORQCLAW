# TORQCLAW Collaboration PRD Synthesis Log

**Canonical directory:** `E:\TorqClaw\docs\prd-reviews`
**Date:** 2026-08-06

## Cycle 1: v0.1 -> v0.2

Verdict: Reject. All Critical/High findings accepted.

- Added explicit authority concepts and matrix.
- Added epoch/linearization revocation model.
- Removed task bridge, search, Git, threads, reactions, edits, and hash chain.
- Added state, schema, credential, and hidden-channel contracts.

## Cycle 2: v0.2 -> v0.3

Verdict: Reject. All Critical/High findings accepted.

- Added offline recovery transition and gateway modes.
- Added strict v2 envelopes and command/event allowlists.
- Bound credentials to sessions/subscriptions.
- Added migration, denial precedence, and commit/high-water ordering.
- Removed tombstones and channel rename from v1.

## Cycle 3: v0.3 -> v0.4

Verdict on v0.3: Reject; zero Critical, five High. All five accepted.

- Replaced universal authorization validation with operation-scoped predicates.
- Added operator connect.
- Added `LIST_CHANNELS` and `ACK_CHANNEL_CURSOR`.
- Made rotation replace one named credential.
- Replaced layered migration prose with executable DDL.
- Froze benchmark values in the PRD.
- Consolidated the source.

## Post-cycle source audit

Three additional blockers were accepted:

- Added `SUSPEND_AGENT`, `RESTORE_AGENT`, and `REVOKE_AGENT`.
- Regenerated `collab_events.kind` directly from the protocol event allowlist and removed tombstone columns.
- Added mandatory encrypted offline export of both peppers and recovery secret.

Five consistency conflicts were accepted and normalized:

- message: 1-16,384 UTF-8 bytes;
- timeline: 100 events and 512 KiB;
- slow consumer: 1 MiB or 10 seconds, `SLOW_CONSUMER`;
- authentication rate limit: 5/credential and 20/address per 5 minutes, 15-minute lockout;
- idempotency: UUID keyed by principal+command in `collab_mutation_results`.

## Rejected reviewer suggestions

None. Scope-reducing recommendations were preferred where they preserved the product outcome.

## Current state

v0.4 is a consolidated candidate. Builder handoff remains blocked until the deterministic consistency pre-gate and a new independent G1R pass with no Critical/High findings.

## Final v0.4 hardening pass

The post-consolidation audit was accepted in full:

- Added an offline, authenticated, exclusive-lock operator-revocation procedure.
- Restored zero usable operator credentials as a `locked_recovery` condition and prohibited revoking the final active operator credential.
- Removed `auth_epoch` increments from credential rotation/revocation so unrelated credential sessions remain valid.
- Registered `AUTH_FAILED`, `CHANNEL_NAME_CONFLICT`, `CURSOR_OUT_OF_RANGE`, and `LAST_OPERATOR_CREDENTIAL`.
- Classified `ACK_CHANNEL_CURSOR` as naturally idempotent without mutation-result growth.
- Added `secrets restore` and the explicit recovery-pepper Credential Manager location.
- Added indexes for channel discovery and principal credential lookup.
- Replaced the stale `D.2` reference with Section 7.5.
- Defined create/unarchive name-collision behavior.

No finding was rejected. No new precedence layer was created; all changes were made directly in the consolidated v0.4 source.

## Consistency pre-gate implementation

The final Medium/Low audit was accepted:

- Added domain-separated principal/recovery pepper checks verified at startup.
- Enumerated and constrained all session close reasons.
- Classified every command as idempotency-keyed, naturally idempotent, or no-key.
- Stated that failures are never persisted as mutation results.
- Added display-name validation and minor command/error behavior.
- Added doctor reporting for mutation-result growth.

`scripts/lint_collaboration_prd.py` is the deterministic Section 14 gate. Its generated report records the executable result.

## Corruption incident and repair

Applying the final hardening edits via PowerShell regex replacement expanded `$1` captures as empty shell variables and silently deleted matched lines from v0.4. The linter correctly failed (`missing section: ### 8.1 Session binding`). Repair on 2026-08-06 restored seven lost items from a verified pre-corruption copy: the 6.2, 7.1, and 8.1 headings; the Section 6.3 bootstrap paragraph; the Section 7.4 channel-collision paragraph; the Section 9 transaction-checks sentence and Section 14 extended-rules paragraph; and the `recovery_secret_hmac` column in `collab_installation`. All intended hardening additions were preserved.

One linter defect was also fixed: the forbidden-literal check substring-matched, so the legacy `4 MiB` ban fired on the Argon2id `64 MiB` parameter. The check is now boundary-aware. After repair and linter fix: PASS, 34/34 checks, exit 0, report `PRD-TCLAW-COLLABORATION-V0.4-CONSISTENCY-REPORT.md`.

Process rule adopted: structured patching only for document edits; PowerShell regex replacement with `$` captures is prohibited in workspace guidance (`TORQCLAW_CLAUDE.md`, "Shell Editing Safety").
