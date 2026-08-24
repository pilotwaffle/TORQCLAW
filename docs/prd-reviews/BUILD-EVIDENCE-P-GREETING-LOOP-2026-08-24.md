# Builder Evidence Packet — Builder P (Claude Sonnet 5), Item A: greeting-loop dedupe, 2026-08-24

> Filed post-hoc by the coordinator to discharge verifier condition C-2 (`VERIFY-CHANNELS-SLICE-2026-08-24.md` §7 D-1): Builder P delivered this evidence in-gate only, without a disk packet. Every claim below was independently reproduced or source-verified by the slice verifier (see §2 Item A and §5 Probe A of the verify doc). Contract: `G1D-FABLE-CHANNELS-AGENT-UX-2026-08-24.md` Item A, G1R resolutions B-1..B-6 as applicable.

## Defect

Subscription agents in channels replied with the same canned greeting repeatedly: the anchor-window context omitted the agent's own prior turns, so each turn regenerated from a polluted anchor window (in-context self-imitation, probe-proven — not context blindness). No duplicate suppression existed; a repeated reply resolved `completed` and posted.

## Changes (working tree, uncommitted at packet time)

- `packages/gateway/src/autoReplyContext.ts` (+145/-13) — `collapseSelfRuns`, new optional 4th param `selfPrincipalId` on the context builder, NEAR_DUPLICATE constants, actor-blind `"[N earlier replies omitted]"` marker in subscription text.
- `packages/gateway/src/autoReplyDispatcher.ts` — EXACTLY the two operator-granted hunks (file otherwise frozen):
  1. `:498` — `buildAnchorWindowContext(store, caller, channelId, agentPrincipalId)`: the agent's own principal is passed so its prior replies appear in its window.
  2. `:768-823` — inline 57-line duplicate-suppression guard: near-duplicate of the agent's own recent reply resolves the turn `no_post` with `resolution_note='duplicate_suppressed'` and returns (no retry, no post).
- `packages/collab/src/migration.ts` (+44, additive) — `runAgentTurnResolutionNoteMigration`, id `20260824_008_agent_turn_resolution_note_v1`: `ALTER TABLE collab_agent_turns ADD COLUMN resolution_note TEXT`.
- `packages/collab/src/autoReply.ts` (+15/-4) — `resolveAgentTurn` accepts optional `note?`.
- `tests/agent-participation-greeting-loop.test.ts` (new, 7 tests).

## RED → GREEN

RED (guard absent): duplicate reply path resolved `completed` — `expected 'no_post', received 'completed'`. GREEN: 7/7 pass. Independently re-proven by the slice verifier via Edit-based probe (`if (false && isDuplicate)`) → 3 failures exactly matching the RED class (obligations 5, 9: `expected 'completed' to be 'no_post'`; obligation 14: count 18 vs 17), restored byte-clean (sha256 `cd05271a…`, hunk count re-verified = 2).

## Boundaries held

- `autoReplyDispatcher.ts` diff = exactly 2 hunks (verifier-counted, twice).
- Migration purely additive; no store.ts edits by P.
- Speech/action split untouched; suppression produces `no_post` accounting, never a silent drop.

## Status

READY → independently verified 2026-08-24 (Item A PASS in `VERIFY-CHANNELS-SLICE-2026-08-24.md`). Known knock-on (disclosed, dispositioned): the additive migration legitimately drifted the `collab-c1-built-artifact` migration pin; the authorized pin-bump was executed by Builder D and audited in verify §10.
