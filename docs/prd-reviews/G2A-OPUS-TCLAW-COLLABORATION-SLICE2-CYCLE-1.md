# G2A Receipt - TORQCLAW Collaboration Substrate - Slice 2 (channels), Cycle 1

- Date: 2026-08-07
- Verifier: independent Opus instance (G2A per operator routing policy)
- Audited: Slice 2 channel layer (builder: Sonnet 5), uncommitted, on Slice 0+1 substrate (@9beef09), PRD v0.14
- Verdict: `APPROVE` (0 Critical, 0 High) — first-cycle pass
- Baseline: typecheck clean; collab 319/319 (14 files); full 1310/1310 (57 files); Slice 0/1 sources byte-unchanged except store.ts/index.ts; store.ts restored byte-identical post-audit (md5 d4035e5632a7ec59fa0a9b61d82d8f0c)

## Both catastrophe axes verified empirically (live SQLite)

- **Hidden-channel indistinguishability:** all 7 denial causes (absent, hidden, archived-hidden, removed-member, owner-command ARCHIVE/ADD/REMOVE by agent) dumped byte-identical COLLAB_NOT_FOUND {code, message:"Request could not be completed"}. Removed-member idempotency replay (same-body AND changed-body) returns COLLAB_NOT_FOUND, never the stored success — predicate fails in-transaction before the result lookup. Oversize/invalid against hidden returns INVALID_REQUEST byte-identical to visible (step 3 before step 6). Non-member to archived == non-member to hidden (M3); only a predicate-passer observes CHANNEL_ARCHIVED. Global collab_events.seq never in any returned object.
- **Re-add truncation math:** PRD worked example reproduced exactly — add A rejoined_seq 1 (member_added@2), re-add A rejoined_seq 8 (member_added@9), timeline from cursor 0 = [9] only, {2,3,4,6,7,8} unreachable. Strict `>` confirmed; rejoined_seq captured before the member_added insert; cursor two-branch bound both branches present (normal + re-added-at-head degenerate).

## Revisions closed (C1-C3, H1-H3, M1-M3, L1-L2)

All ten closed with probe evidence: driver split (ACK/reads write no mutation-result row, reads take no mutex); in-transaction predicate with no pre-BEGIN channel resolution; byte-identical error envelope; strict-inequality timeline; dense gap-free channel_seq with UNIQUE backstop; two-branch cursor bound + LIST triad (own-cursor/"0"/active-membership/includeArchived/pagination); per-row membership_epoch isolation; unarchive name_key recompute + rollback-leaves-archived; compound-denial ordering; normalize-before-hash; SQL MAX ack.

## Mutation results (6 injected, shipped suite): all KILLED

1 timeline >->= (re-add fixture asserts event-8 ABSENCE via exact array equality); 2 pre-predicate archived resolution (M3+C3); 3 dropped cursor "otherwise" branch (re-added-at-head ack); 4 foreign cursor in LIST; 5 rejoined_seq captured after insert (first-timer + worked-example); 6 same-state archive bumps epoch/emits event. No survivors.

## Residual risks accepted

- Metadata (event-count) leak to predicate-passing members via dense channel_seq — the sole accepted leak (G1R H4), bounded to members, never widens to hidden channels.
- Malformed-UUID channelId returns COLLAB_NOT_FOUND rather than INVALID_REQUEST — conservative (collapses to not-found), not a distinguishing oracle.
- In-process mutex only; no socket/concurrency layer yet (Live slice); H2 gap/dup safety rests on single mutex + UNIQUE backstop, both verified.

## Scope

git diff = only store.ts (+923 net) and index.ts (additive re-exports); new tests store-channels/membership/timeline; no other Slice 0/1 source touched; no migration DDL change. Slice 0 (110) and Slice 1 identity tests still pass within the 319.
