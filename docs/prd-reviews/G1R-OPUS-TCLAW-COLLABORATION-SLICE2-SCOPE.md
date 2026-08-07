# G1R Receipt - TORQCLAW Collaboration Substrate - Slice 2 Scope Review

- Date: 2026-08-07
- Reviewer: independent Opus instance (G1R, security/design), pre-build
- Review object: G1D implementation scope for Slice 2 (channels) against PRD v0.14 Sections 4.2, 5.3, 5.4, 7.1, 7.4, 7.5, 7.6, 8.3, 9, 10, on the built Slice 0 + Slice 1 substrate (@9beef09)
- Verdict: `APPROVE-SCOPE` conditional on the eight-item revision list (all folded into the builder brief)

## Headline

Faithful to v0.14 on both catastrophe axes. Re-add truncation math traces exactly to the PRD worked numbers (added@2 rejoined 1 -> sees 2-4; removed@5; re-added@9 rejoined 8 -> sees 9+; 2-4 and 6-8 permanently unreachable) with no off-by-one. Predicate-before-idempotency ordering already exists structurally in the Slice 1 driver. Defects are under-specified mechanism, not wrong design.

## Findings and required revisions

- **C1** Driver supports only keyed mutations; must split into three §8.3 lock-class paths: keyed (existing), naturally-idempotent (ACK: mutex + tx, NO collab_mutation_results read/write), read-path (LIST/TIMELINE: no mutex, no result row).
- **C2** Every channel-scoped predicate (channel resolution + membership + owner check) must run INSIDE the transaction in the step-2 predicate slot, throw COLLAB_NOT_FOUND for all denial causes, with NO channel resolution before BEGIN IMMEDIATE — this is what makes a removed member's replay indistinguishable.
- **C3** Add COLLAB_NOT_FOUND / CHANNEL_ARCHIVED / CHANNEL_NAME_CONFLICT / CURSOR_OUT_OF_RANGE to CollabErrorCode; pin the byte-identical COLLAB_NOT_FOUND envelope; step-3 INVALID_REQUEST (size/char-class/UUID) fires before step-6 auth so it is byte-identical across absent/hidden/visible.
- **H1** Pin strict `>` in the timeline filter and clamp, and rejoined_seq = MAX(channel_seq) captured BEFORE the member_added INSERT, same transaction (the two off-by-ones that would re-expose removal-window content).
- **H2** channel_seq = 1 + MAX(channel_seq) for that channel, in-transaction, UNIQUE(channel_id,channel_seq) as backstop; global seq never exposed. No gap/dup/race under the single mutex (confirmed).
- **H3** Enumerate BOTH cursor-bound branches (greatest committed when events above rejoined_seq exist, otherwise rejoined_seq); enumerate LIST_CHANNELS own-cursor / "0"-when-absent / active-membership / includeArchived / pagination-token requirements.
- **M1** membership_epoch is per-(channel_id,principal_id) row; add/remove of one member changes no other row's epoch (Slice 3 subscription-survival depends on this).
- **M2** UNARCHIVE recomputes name_key and on conflict rolls back leaving the target archived, no epoch bump, CHANNEL_NAME_CONFLICT.
- **M3** POST evaluation order explicit (predicate -> active-channel state); non-member posting to an archived channel returns COLLAB_NOT_FOUND byte-identical to non-member/hidden, never CHANNEL_ARCHIVED.
- **H4** metadata-visibility (dense channel_seq count leak) is the ONLY accepted leak, bounded to predicate-passing members, never widens to hidden channels.
- L1/L2 advisory: reuse the store's H1/F2 normalize-before-hash discipline for POST text/channel name; ACK max in SQL not JS RMW.

## Answers

(a) indistinguishability preserved by design, conditioned on C2+C3. (b) re-add math is exactly the PRD's; H1 forbids the two builder-plausible mutations. (c) no channel_seq race/gap/dup under the single mutex + sole writer. (d) two silent narrowings: cursor "otherwise" branch and LIST_CHANNELS triad (H3). (e) Slice 3 deferral clean; one foreclosure risk (per-row epoch isolation) closed by M1; ADD/REMOVE/ARCHIVE/UNARCHIVE correctly classed as authorization mutations.
