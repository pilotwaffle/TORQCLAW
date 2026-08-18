# G2A Final Audit — PRD-TCLAW-COLLAB-PRESENCE-UI-005 S5 (roster / agent co-presence)

**Seat:** G2A final verifier.
**Model:** `claude-opus-4-8`. CLAUDE.md §2 names Claude Opus 4.8 for this seat and I *am* Opus 4.8 — **no substitution applies.**
**Scope:** `86d3914..8c8e7c5` (single commit `8c8e7c5`, 4 files: `ChannelsPanel.tsx`, `channels-panel.test.tsx`, `collab-presence-a5-zero-writes.test.ts` (new), the G1R verdict doc).
**G1R verdict read:** `docs/prd-reviews/VERIFY-OPUS-COLLAB-PRESENCE-UI-005-S5.md` (REJECT — blocker B-1, 2 non-blocking, plus the identity ruling). Not deferred to: I re-ran its decisive attack myself and probed a branch it did not.
**Date:** 2026-08-17. **Method:** execution — scratch attack test against the A5 proof, two mutation probes on the roster guards, gate runs. Scratch file deleted; probe mutations restored; `git diff HEAD --stat` empty afterward.

**Framing:** the B-1 fix was authored by G1D — the party that built the slice and directs the builders — reviewed by no one else before this pass. Treated as unproven until driven.

---

## VERDICT: **APPROVE WITH CONDITIONS** — B-1 genuinely closed; two conditions, both cheap and test-only/copy-only

S5's engineering is sound and its safety claims are now *falsifiable*, which is the whole game in this repo. The spine criterion (A5 zero-writes) is aimed at the right database and I proved it breaks when it should. Two conditions: the T-11 roster test has a blind branch I found by probing where G1R didn't (C-S5-1), and the "Working now" label overclaim G1R ruled on needs its two-string fix before this surface's flag comes off (C-S5-2). Neither is a live defect in shipped behavior; both are exactly the kind of thing that rots silently if filed as a note instead of a condition.

---

## 1. B-1 (G1R's blocker: A5's zero-writes proof was vacuous) — CLOSED, verified by re-running the attack

**The fix:** `tests/collab-presence-a5-zero-writes.test.ts` now sets `TORQCLAW_COLLAB_DB_PATH` into a per-run `mkdtempSync` dir **before any import that could resolve it** (`:87-88`), and the load-bearing assertion counts `collab_events` through `getCollabDb()` itself (`:135-141`) — the same function `collabSurface.ts`'s `getStore()` writes through.

**My re-execution of G1R's attack** (scratch test, since deleted — same lifecycle drive, but with a real `postChannelMessage` into the production handle injected between `prodBefore` and `prodAfter`):

```
FAIL … injected mirroring write mid-lifecycle => zero-writes assertion goes RED
AssertionError: expected 2 to be 1
```

The counter sees the write. Pre-fix this exact attack stayed green (G1R's proof); post-fix it cannot. Consistent with G1D's reported `expected 2 to be +0`.

**The brief's four pointed questions, answered:**

1. **Attack re-run:** RED, above. The standing falsifiability test (`:233-308`) now writes through `getCollabDb()` — the same handle the guarded assertion reads — satisfying the rule this defect class keeps violating.
2. **Handle identity / import order:** sound. `getCollabDb()` (`collabIdentity.ts:146-157`) resolves `process.env.TORQCLAW_COLLAB_DB_PATH || join(DATA_DIR, 'collab.db')` **lazily at first call**, then caches a module singleton. In this file the env var is assigned at module top (`:88`), and the first `getCollabDb()` call happens inside test 1 — no import before it can trigger resolution (`events.js`/`storage.js` don't touch collabIdentity). Vitest's per-file module isolation means no other suite's singleton leaks in. The counted handle is the handle production code would write through *under this env*, exercised via the same function — not a look-alike.
3. **Cleanup masking:** no. The falsifiability test deletes only its own `message_posted` row and asserts the count returns to exactly `before` (`:301-307`); the zero-writes tests run earlier in declaration order; the temp dir is unique per run (`mkdtempSync`), so no cross-run state can make a later assertion pass vacuously.
4. **Env leak:** restored in `afterAll` (`:105-110`), both variables, handling the previously-undefined case. No leak to other files.

Header claim also spot-checked: `packages/gateway/src/storage.ts` contains zero references to the collab DB — the gateway lifecycle genuinely has no collab handle.

## 2. What G1R missed — C-S5-1: the T-11 roster test is blind to the populated Working-now branch

**Probe:** I injected a rogue `<button onClick={…}>cancel task</button>` into RosterSection's **Working-now populated branch** (`ChannelsPanel.tsx:1372-1374` area). Result:

```
Tests  62 passed (62)
```

**GREEN.** G1R's P1 probed the *member chip* and was caught; but the T-11 roster test's fixture (`tests/channels-panel.test.tsx:1314-1340`) renders a member and **no live task**, so `workingNow === null` and the Working-now branch renders only its empty text. The `queryAllByRole('button')` sweep never sees that branch's content. A rogue dispatch control added to the working-now row — the row A5's "no roster row carries any dispatch affordance" most cares about, since it names a live task — **ships green today.**

This is the fourth instance this session of a suite passing identically with and without the guard. Severity: **condition, not blocker** — the shipped code carries no affordance (the defect would be in a future edit), and the structural boundary (plain-data props) narrows but does not eliminate the risk, as my probe demonstrates. **Fix:** extend the T-11 roster fixture with a live task (`TIER_SELECTED` without terminal) so the Working-now branch renders inside the zero-button sweep. Test-only.

## 3. The label overclaim — my ruling: condition, not blocker (C-S5-2)

The substrate facts are confirmed (G1R verified; I spot-checked the schema and the CONNECTED frame shape): no `principalId` on any frame, `sessionBus` keyed by sessionId, each socket subscribed to its own session only. **"Working now" can only ever render the viewer's own task**, and it renders inside a channel detail view, implying channel-scoped, possibly multi-agent presence. The empty state "Nothing running right now." asserts system-wide idleness the console cannot know.

**Why not a blocker:** the *data* rendered is truthful — a real task, epoch-anchored, no fabricated field. The overclaim is in scope implied by label and placement, not in any rendered value. The surface is flag-gated (`NEXT_PUBLIC_COLLAB_UI`). The fix is two strings and needs no wire data. Blocking the entire slice — whose safety spine is now genuinely enforced — on label copy would misorder the risks.

**Why a condition and not a note:** §2's honesty discipline is this PRD's core value, and G1R is right that the honesty in the code comments never reached the operator-facing label — the `PresenceCard` precedent ("the ONE agent the console watches… no roster here to populate") was available and not followed. If this condition is filed as a note it will be rediscovered at demo time. **C-S5-2:** before `NEXT_PUBLIC_COLLAB_UI` broadens beyond its current gate, scope the section (e.g. "This console's task" or a caption in the Members-caption's honest register: "this session only — other agents' work is not on the wire yet") and scope the empty state to match ("Nothing running in this session."). S5b (self-only `principalId` on CONNECTED, per G1R's disclosure analysis at §1.3 of its verdict) is the right follow-on and should adopt that analysis verbatim.

## 4. Everything else — re-checked, holds

- **Epoch-anchored elapsed:** my mutation (`selectTurnStartMs(events, requestId)` → `Date.now()`) → **RED, 2 failed** (the remount test and the pure-selector anchor test). Real enforcement, not decoration. Restored.
- **T-10 / "Invalid Date":** `formatOccurredAt` (`:514-519`) returns unparseable input verbatim; the NB-2 tooltip fix routes `m.since` through it (`:1351`). Garbage/absent timestamps cannot produce "Invalid Date" in chip or tooltip.
- **A9:** two separately-labeled sections from two distinct sources, independent renders, no cross-gating — confirmed in code and test. G1R's NB-1 caveat is correct and worth repeating: the "working non-member" property is proven **structurally** (render-independence), not semantically (no identity join exists to test). A9's wording should be amended when S5b lands.
- **A6/T-9 not-applicable declaration — TRUE.** The range touches nothing under `packages/`; no `ClientCommand` variant, no `GatewayEvent` field, no new `sendCommand` action. Declaration is accurate, not an omission.
- **S4 coalescing:** S5 adds no re-read path (pure `useMemo` selectors over existing props); the V-1 guard is untouched. No regression vector.
- **Member replay logic:** latest-event-wins per principal by numeric cursor (`selectChannelMembers`, `:445-468`), removals net out, `role` is the literal `'member'` with no fabricated role/display-name claim — matches the wire's actual payload shape. The "as loaded so far" undercount caption is present and honest (G1R's NB-2 heading-tightening suggestion stands as a nice-to-have).
- **Scope discipline:** 4 files, all S5. Nothing unrelated rode along.

## 5. Gate results — my own runs

| gate | result |
|---|---|
| `npx vitest run tests/channels-panel.test.tsx tests/collab-presence-a5-zero-writes.test.ts` | PASS — **65/65** |
| `npx vitest run` (full suite) | PASS — **2149/2149 across 119 files**, zero failures (the documented `controller-timeout` flake did not manifest) |
| `npx tsc --noEmit -p apps/console/tsconfig.json` | PASS (exit 0) |
| `pnpm reachability` | PASS — every substantial module reachable or declared dormant |
| `git diff --stat 86d3914..8c8e7c5` | 4 files, 1016+/9- |

## 6. Tree state afterward

Clean. Rogue-button and `Date.now()` mutations restored byte-identical; the B-1 attack scratch file deleted; this verdict is the only file created.

---

**Bottom line:** B-1's fix satisfies the rule this defect class keeps violating — the probe and the assertion now read the same handle, and I watched it break. Approve, with C-S5-1 (cover the Working-now branch in the T-11 sweep) and C-S5-2 (scope the Working-now label and empty state before the flag broadens) tracked as conditions, and S5b carrying G1R's disclosure analysis as the designed follow-on.
