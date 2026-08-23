# G2A Re-Audit — PRD-TCLAW-COLLAB-PRESENCE-UI-005 S3 (D-1 fix) + S4 (hint-then-refetch)

**Seat:** G2A final verifier.
**Model:** `claude-opus-4-8`. CLAUDE.md §2 names Claude Opus 4.8 for this seat and I *am* Opus 4.8 — **no substitution applies.**
**Scope:** `72b4d36..cc95499` = `c404a24` (S3, audited in pass 1) + `e7c1726` (D-1 gateway half) + `cc95499` (S4 + D-1 console half). `36e89bf` in range is the PRD-006 doc, declared unrelated — confirmed docs-only, ignored.
**Pass-1 verdict:** `docs/prd-reviews/G2A-OPUS48-COLLAB-PRESENCE-UI-005-S3.md` (REJECT, blocker D-1).
**Date:** 2026-08-17. **Method:** full diff read of both fix commits, re-execution of my original silent-drop scenario against the fix, and three fresh mutation probes on the new guards. Scratch probe file deleted after use; tree byte-identical to HEAD afterward (`git diff HEAD --stat` empty).

**Framing the brief insists on, confirmed:** the D-1 fix and both NB fixes were authored by G1D — the party that built the slice — and reviewed by no one before this audit. I treated every fix as unproven until I drove it myself.

---

## VERDICT: **APPROVE WITH CONDITIONS** — D-1 blocker CLOSED; one condition (RC-1), four non-blocking notes

The D-1 fix is correct and I proved it by execution, including re-driving the exact scenario that killed the first pass. S4's load-bearing claims (coalescing, no-delivery-guarantee, A6/T-9 not-applicable) are all true and pinned. The one condition: **the field the entire D-1 fix hinges on — `idempotencyKey` in the ack metadata — is pinned by no test.** I removed it and the full 82-test S3/S4 suite stayed green. That is this repo's recurring unenforced-claim pattern sitting on the load-bearing field of the fix I ordered. Cheap to close; see RC-1.

---

## D-1 fix — verified by execution

**Gateway half (`e7c1726`):** `collabSurface.ts:365` adds `idempotencyKey` to the ack metadata. Minimal, correct.

**Console half (`cc95499`):**
- `ChannelsPanel.tsx:228` — `selectLatestPostAck` now requires `typeof meta.idempotencyKey === 'string'`; keyless acks are skipped, never guessed at.
- `ChannelsPanel.tsx:832-835` — the ack effect correlates by `idempotencyKey` and requires `phase === 'sending'`; one ack can no longer stamp a sibling.
- Regression test (`channels-panel.test.tsx`, "G2A D-1: an ack for send A must NOT clear a DIFFERENT in-flight send B") drives my exact scenario and asserts on the DOM (B visible, still `border-dashed`).

**My independent re-drive** (scratch component test, since deleted): two sends, only A acked with its real key, re-read containing only A → **B remains rendered** (`B rendered after A ack+re-read = true`); after `TIMEOUT_MS` B degrades to **"no response — retry"**, still dashed-pending. The silent drop is gone; the failure surface is the honest one.

**Probe R1 (falsifiability):** reverted the per-key correlation to channelId-wide stamping →
```
FAIL … G2A D-1: an ack for send A must NOT clear a DIFFERENT in-flight send B (no silent drop)
Tests  1 failed | 42 passed (43)
```
Restored, GREEN. The regression test has teeth.

## S4 — audited, claims hold

- **"No new wire command" — TRUE.** The hint is the `collabMessagePosted` publishOnly frame S3 already emits; the only dispatch added anywhere is `GET_CHANNEL_TIMELINE` (existing S1 command). The A6/T-9 not-applicable declaration is accurate, not an omission.
- **Coalescing — real and pinned.** At most one in-flight `GET_CHANNEL_TIMELINE` per channel; N hints during it set one dirty flag → exactly one follow-up. Asserted on call counts, not intent. **Probe R2:** I removed the new-frame identity guard (`isNewFrame`, `ChannelsPanel.tsx:587`) →
  ```
  COALESCING VIOLATION … expected 4 to be 1
  Tests  1 failed | 42 passed (43)
  ```
  matching the commit message's recorded RED verbatim. Restored, GREEN. The dirty flag is consumed exactly once (a test proves the follow-up's resolution fires nothing further).
- **No delivery guarantee claimed or tested — TRUE.** A sweep test asserts no "delivered"/"live"/checkmark language reaches the DOM; the module doc defers backpressure to §19 explicitly. Hint frames are driven as observed props; no test asserts arrival.
- **Reconnect path:** new-CONNECTED-id dedup tested; from-cursor-`'0'` re-read asserted; same-id re-render does not re-fire.
- **Citation spot-checks:** `events.ts:15` (`Map<string, Set<Listener>>`), `events.ts:96-101` (publishOnly, seq-less), `server.ts:273` (sessionBus resubscribe), `server.ts:282-288` (CONNECTED frame) — all resolve correctly. One slip: `useGatewayStream.ts:35` lives at `apps/console/src/components/`, not `apps/console/src/hooks/` (the cited line 35 is the right line — the sessionStorage sessionId replay — only the path is wrong). Cosmetic.

## NB closures from pass 1

- **NB-1 — CLOSED, correctly.** The retitled test asserts both branches: empty (`rawBytes === 0`) disabled, whitespace-only **enabled** — the right call: the substrate has no trim for message text and persists all-LF/leading-trailing-space messages byte-identical (`text.ts:105`), so declining whitespace-only would be the console inventing a rule the substrate lacks. The brief's warning ("if that reading is wrong the new assertion is wrong in the opposite direction") checked: the reading is right.
- **NB-2 — MOSTLY CLOSED.** The header no longer claims a nonexistent evidence block and names three real locations. Two resolve. One still doesn't: "builder-side probes (…): commit c404a24's message" — that message records only the C-1 RED (`expected 'operator' to be 'agent'`); it contains **no** RED excerpts for the four T-9 matrix parts. The guards are nonetheless discharged — by my five pass-1 probes, correctly pointed at my first verdict — so this is a pointer-accuracy residue, not an undischarged-probe problem. (NB-RA-3 below.)

## Condition

### RC-1 (condition, non-blocking) — the ack's `idempotencyKey` is unpinned server-side

**Probe R3:** I deleted `idempotencyKey` from the ack metadata (`collabSurface.ts:365`) and ran both S3/S4 test files: **82/82 GREEN.** No gateway test inspects the ack frame's metadata (the `publishedFrames` capture in `collab-surface-post.test.ts` records it but asserts nothing about it), and the console tests construct their own keyed ack frames — so the suite cannot see the field's absence.

**Failure scenario:** a future refactor drops or renames the field. No silent drop returns (the console guard fails safe — keyless acks are ignored), but *every* send then degrades: pending rows never confirm, all hit "no response — retry" while their messages visibly render as sent. The fix this whole re-audit exists to validate would be dead code with a fully green suite — the C-1 shape again, on the fix itself.

**Suggested fix (two lines):** in `collab-surface-post.test.ts`, assert the published ack's `metadata.idempotencyKey` equals the key passed to `handlePostChannelMessage` (the capture plumbing already exists).

## Non-blocking notes

- **NB-RA-1 — same-batch double-ack skip.** `selectLatestPostAck` returns only the *newest* keyed ack per effect run. If two of the operator's own acks land in one render batch, the older is never processed (the effect's deps don't change again), so that entry times out to "no response — retry" while its message is visibly rendered as sent. No loss — retry is idempotent (same key, server dedups) and recovers it — but it is a transient false-failure display. Consider iterating unprocessed keyed acks rather than taking only the latest.
- **NB-RA-2 — coalescing exactness leaks in two edge paths, both bounded to one extra read.** (a) Reselect race: `selectChannel` (`:688`) deletes `lastTimelineFrameIdRef[channelId]`, but the old frame is still found via `timelineByChannelId` (a memo over `events`, `:468-474`), so the resolved effect (`:586-602`) sees a "new" frame and clears the just-armed in-flight flag; a hint landing in that window fires a second concurrent request. (b) Timeout-with-dirty: the timeout arm (`:560-570`) clears in-flight but leaves `dirty` set, so a later unrelated resolution fires a stale follow-up. Neither affects rendered truth (merge dedups by event id; cursor monotonic); both are at most one redundant `GET_CHANNEL_TIMELINE`.
- **NB-RA-3 —** the NB-2 pointer residue described above.
- **NB-RA-4 —** the `useGatewayStream.ts` path slip described above.

## Gate results — my own runs, this audit

| gate | result |
|---|---|
| `pnpm --filter @torqclaw/contracts build` | PASS — 8 schemas → both targets |
| `npx vitest run tests/collab-surface-post.test.ts tests/channels-panel.test.tsx` | PASS — **82/82** |
| `npx vitest run tests/authz.test.ts tests/collab-identity.test.ts tests/connection-auth.test.ts tests/collab-connect-dataflow.test.ts` | PASS — **60/60**, with one candid caveat: the first run failed `1 failed | 59 passed` on a byte-clean tree and I did not capture the failing test's name; six subsequent identical runs are all 60/60. This is **not** the documented controller-timeout flake (different file set). Unreproducible; recorded, not chased. |
| `npx tsc --noEmit -p packages/gateway/tsconfig.json` | PASS (exit 0) |
| `npx tsc --noEmit -p apps/console/tsconfig.json` | PASS (exit 0) |
| `pnpm reachability` | PASS — every substantial module reachable or declared dormant |
| `git diff --stat 72b4d36..cc95499` | 13 files (12 S3 + 2 fix commits sharing 2 files each + the unrelated PRD-006 doc commit `36e89bf`) |

**Scope / the `git add -A` incident:** the committed trees are clean — `e7c1726` touches exactly `collabSurface.ts` + `collab-surface-post.test.ts`; `cc95499` touches exactly `ChannelsPanel.tsx` + `channels-panel.test.tsx`. No screenshots, logs, or backups rode along. Nothing unrelated in either commit.

## What pass-1's reviewers (including me) should note

The D-1 fix authored by the orchestrator is correct — verified by driving it, not reading it. The remaining risk on this surface is no longer behavioral; it is **pinning**: RC-1's unpinned key field and NB-RA-1's batch edge are both places where the suite would stay green while the confirmed-send path degraded. The behavior is right; the tests lag the invariants by one layer.

## Tree state afterward

Clean. All three probe mutations restored byte-identical; scratch probe file deleted; this verdict is the only file created.

---

**Bottom line:** D-1 is dead — proven, not asserted. S4's coalescing and no-delivery claims hold under mutation. Ship it once RC-1's two-line assertion lands, or ship it now and file RC-1 as carried obligation CO-S3-2 — the failure direction is safe (false failure, never silent success), which is why this is a condition and not a blocker.
