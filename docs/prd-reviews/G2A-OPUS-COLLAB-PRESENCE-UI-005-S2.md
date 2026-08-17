# G2A FINAL AUDIT — PRD-TCLAW-COLLAB-PRESENCE-UI-005 slice S2

**Verdict: APPROVE** — both blockers confirmed closed by my own mutation probes; no regression in the honesty machine; no new defect found by an 13-probe adversarial hunt.

**Date:** 2026-08-17
**Branch:** `phase1-server-owned-authority`
**Commits audited:** `ccc94b9` (original S2 build) + `f458222` (B-1/B-2 remediation) — HEAD at `f458222`
**Role:** G2A, final verifier. **My verdict controls pass/fail.**

## Seat statement (No False Delegation)

The routing profile seats **G2A = Claude Opus 5**. I **am** `claude-opus-5`. **No substitution
applies to this seat and none is claimed.** This is recorded explicitly because the
*preceding* gate in this chain did involve a disclosed substitution (a fresh `claude-opus-5`
thread filling the Opus-4.8-named independent-verifier seat). That substitution is theirs and
remains disclosed in their document; it does not propagate to this one.

Fresh thread, no builder or prior-verifier context beyond the documents I was directed to read.
No commits, no pushes. Every mutation probe was performed on committed files and reverted via
`git checkout` with a confirming `git status --short`. No untracked operator file was created,
modified, moved, or deleted.

---

## 1. Evidence table — executed vs inherited

| # | Check | Method | Result |
|---|---|---|---|
| 1 | `npx vitest run tests/channels-panel.test.tsx` | **EXECUTED** | **19/19 passed**, 228ms |
| 2 | Adjacent console suites (approvals + receipts + terminal-presence) | **EXECUTED** | **42/42 passed** (18+19+5) |
| 3 | `pnpm typecheck` (cached) | **EXECUTED** | 14/14, FULL TURBO — **not accepted as proof** |
| 4 | `pnpm typecheck --force` (**cold**) | **EXECUTED** | **14/14 successful, 0 cached**, 11.381s |
| 5 | `pnpm reachability` | **EXECUTED** | **PASS — 120 modules**, 3 declared dormant |
| 6 | **Mutation probe A** — revert kind-branching | **EXECUTED** | **2 tests RED**, restored green, tree clean |
| 7 | **Mutation probe B** — revert accumulation to replace | **EXECUTED** | **1 test RED**, restored green, tree clean |
| 8 | **Mutation probe C** — honesty machine `null` → `[]` | **EXECUTED** | **4 tests RED**, restored green, tree clean |
| 9 | Payload shapes for all 6 kinds, read at insertion sites | **EXECUTED** | All 6 confirmed; commit message accurate |
| 10 | `store.ts` paging direction + `nextCursor` semantics | **EXECUTED** | Forward-only confirmed; B-2 premise correct |
| 11 | Adversarial probe suite (11 probes, self-authored) | **EXECUTED** | **11/11 passed**; probe files deleted |
| 12 | P8 follow-up probe (reselect semantics, 2 probes) | **EXECUTED** | **2/2 passed**; resolved a false positive |
| 13 | Scope check across **both** commits | **EXECUTED** | **Nothing** under gateway/contracts/collab |
| 14 | Test-integrity diff (rename vs weakening) | **EXECUTED** | Pure rename; 6 lines, all label/title |
| 15 | `tests/failover/controller-timeout.test.ts` in isolation | **EXECUTED (spot-check)** | **7/7 passed**, 37.7s — corroborates flake claim |
| 16 | Full suite 2051/2052 on the pre-fix tree | **INHERITED** — not re-run | Accepted; #15 corroborates the diagnosis |

**On #3 vs #4.** The first typecheck returned FULL TURBO (14/14 cached). A cached pass is not
evidence that new code typechecks. I re-ran with `--force`: **0 cached, 14/14, 11.4s.** That is
the load-bearing result. The builder's claim of a console cache-MISS is plausible but I did not
rely on it.

---

## 2. B-1 — CONFIRMED CLOSED

**Requirement:** branch on kind; system kinds visually distinct (mono, not the message font)
with a kind label; only fields actually present on each payload; unknown kinds degrade
honestly; `"(no text)"` unreachable for non-message kinds.

### 2.1 Payload shapes — verified by me at the insertion sites, not from the commit message

I read every `canonicalJson({...})` write in `packages/collab/src/store.ts`:

| kind | store.ts insertion | payload actually written | component renders |
|---|---|---|---|
| `channel_created` | `:992` | `{channelId, name}` | kind label + `name` ✔ |
| `member_added` | `:1100` | `{channelId, principalId, membershipEpoch}` | label + `principalId.slice(0,8)` ✔ |
| `member_removed` | `:1221` | `{channelId, principalId, membershipEpoch}` | label + `principalId.slice(0,8)` ✔ |
| `channel_archived` | `:1323` | `{channelId, channelEpoch}` | label only ✔ |
| `channel_unarchived` | `:1406` | `{channelId, channelEpoch}` | label only ✔ |
| `message_posted` | `:1471` | `{channelId, text}` | `text` in `font-reading` ✔ |

Every claim in the commit message is accurate. The six-kind universe is pinned by a DB CHECK
constraint at `packages/collab/src/migration.ts:116-119`, so no seventh kind can exist today.
The gateway passes `payload` through unmodified (`collabSurface.ts:185-190`,
`events: result.events`) — no redaction layer to account for.

The label-only treatment of `channel_archived`/`channel_unarchived` is **correct**: `channelEpoch`
is bookkeeping, and rendering it would be noise, not honesty.

### 2.2 Implementation

`ChannelsPanel.tsx:533` `const isMessage = event.kind === 'message_posted';` — strict equality on
the exact wire literal. `:540-549`: message branch keeps `font-reading`; system branch uses
`font-mono text-[11px] text-faint` with `SYSTEM_EVENT_LABELS[event.kind] ?? event.kind`. The
`??` fallback is what makes an unknown kind degrade to the raw kind string. `systemEventDetail`
(`:172-184`) guards every field with `typeof === 'string'` before rendering.

`messageText` is now **unreachable** for any non-message kind — it is called only inside the
`isMessage` branch. The docstring at `:141-143` warns future callers to gate on kind first.

### 2.3 Mutation probe A — EXECUTED BY ME

Reverted `TimelineEventRow`'s branch to the unconditional `messageText` render. Verbatim RED:

```
 ❯ tests/channels-panel.test.tsx (19 tests | 2 failed) 235ms
   × ChannelsPanel > B-1: non-message event kinds render with their kind label, not the
     message font, and "(no text)" appears nowhere in the DOM  15ms
     → expected 'Channelsrefreshclosegeneralownerprinc…' not to contain '(no text)'
   × ChannelsPanel > B-1: an unknown/future event kind degrades honestly — kind label
     rendered, never "(no text)", never crashes  7ms
     → expected 'Channelsrefreshclosegeneralownerprinc…' not to contain '(no text)'

 FAIL  tests/channels-panel.test.tsx > ChannelsPanel > B-1: non-message event kinds render …
 AssertionError: expected 'Channelsrefreshclosegeneralownerprinc…' not to contain '(no text)'
 Expected: "(no text)"
 Received: "Channelsrefreshclosegeneralownerprincipa2026-08-16 23:55:12.345 UTC(no text)
            principa2026-08-16 23:55:12.345 UTC(no text)principa2026-08-16 23:55:12.345 UTC
            real message"
 ❯ tests/channels-panel.test.tsx:304:39

 Test Files  1 failed (1)
      Tests  2 failed | 17 passed (19)
```

The `Received` string **is** the original defect, reproduced: two consecutive `(no text)` rows
where `channel_created` and `member_added` should be, and only the third row carrying content.
Restored via `git checkout --`; `git status --short` on that path returned empty; re-ran **19/19
green**. The B-1 tests are genuinely load-bearing, not decorative.

---

## 3. B-2 — CONFIRMED CLOSED

### 3.1 The wire premise — independently re-derived

`packages/collab/src/store.ts:1812-1815`:

```sql
SELECT * FROM collab_events WHERE channel_id = ? AND channel_seq > ? ORDER BY channel_seq ASC LIMIT ?
```

and `:1849`:

```ts
const nextCursor = events.length > 0 ? events[events.length - 1]!.cursor : String(effectiveAfter);
```

`afterCursor` is a **strictly exclusive lower bound** and `nextCursor` is the **newest** event of
the page. The wire pages **forward only**; there is no backward-paging capability. The verifier's
B-2 analysis is correct and the relabel to "Load more" is **honest, not cosmetic** — the old label
named a direction the wire cannot page in.

### 3.2 Accumulation implementation

`ChannelsPanel.tsx:256-272`. Dedupe key is `event.id` via a `Map` (`:262-264`) — later frames win
on collision, which is right for an immutable append-only log. Ordering is
`Number(a.cursor) - Number(b.cursor)` (`:265-267`) — numeric, so `'10'` sorts after `'9'`, which a
lexicographic sort would get wrong. Running `cursor`/`hasMore` are taken from the newest frame
(`:270`), which is correct because `nextCursor` is monotonically advancing on a forward-paging wire.

Re-selection resets that channel to `null` (`:311`) so a fresh cursor-0 page never folds onto stale
history. `loadOlder` (`:317-322`) early-returns unless `hasMore` — end-of-history is never inferred
from a short page, which matters given the 64 KiB frame cut at `store.ts:1836-1839`.

### 3.3 Mutation probe B — EXECUTED BY ME

Reverted the merge effect to `setTimelineSnapshots((prev) => ({ ...prev, [selectedChannelId]: found }))`.
RED, and the DOM dump is decisive — **only page two survives**:

```
 FAIL  tests/channels-panel.test.tsx > ChannelsPanel > B-2: paging accumulates — after
       "Load more" both page 1 and page 2 content are visible, in ascending channel_seq order
 TestingLibraryElementError: Unable to find an element with the text: page one msg.
   …
   <p class="mt-0.5 font-reading text-[13px] leading-[1.6] text-ink">
     page two msg
   </p>
   …
 ❯ tests/channels-panel.test.tsx:386:19
    384|
    385|     // BOTH pages' content must still be visible.
    386|     expect(screen.getByText('page one msg')).toBeInTheDocument();
       |                   ^

 Test Files  1 failed (1)
      Tests  1 failed | 18 passed (19)
```

Restored via `git checkout --`; path status empty; **19/19 green**.

---

## 4. Regression check on the honesty machine — PASS (strongest evidence in this audit)

The remediation restructured the snapshot effect, which is exactly where the honesty machine
lives. The decisive check:

```
git diff ccc94b9 f458222 -- apps/console/src/components/ChannelsPanel.tsx \
  | grep -E "^[-+].*(useState|TIMEOUT_MS|sendFailed|setTimeout|listTimer|timelineTimer)"
→ (no output)
```

**Zero lines** matching any honesty-machine primitive changed between the two commits. Current state:

- `:197` `useState<ChannelListEntry[] | null>(null)` — channel list still **null**-initialized, never `[]`
- `:251` `useState<Record<string, TimelineSnapshot | null>>({})` — per-channel snapshots still nullable
- `:40` `TIMEOUT_MS = 5000` — unchanged
- `:208` / `:286` — `if (!sent) { setPhase('sendFailed'); return; }` **returns before** arming any timer

**Mutation probe C (executed by me, not inherited):** set the list initializer to `[]`. **4 tests RED** —
`loading(null) !== empty([])`, `sendFailed … never arms the timeout timer`, `timeout fires at exactly
the 5000ms boundary`, and `malformed-frame resilience`. Restored; 19/19 green; path clean. The
honesty machine is still genuinely falsifiable **after** the restructure.

Refresh-failure behavior re-proven live in probe P11: last-known rows stay visible after a failed
refresh.

---

## 5. Cursor grammar (D-1) — PASS

`CURSOR_GRAMMAR = /^(0|[1-9][0-9]*)$/` (`:101`) matches `packages/contracts/src/commands.ts` exactly.
Both dispatch paths are covered: `selectChannel` sends the literal `'0'` (`:314`), and `loadOlder`
sends `safeCursor(snap.cursor)` (`:321`), which clamps any non-match to `'0'`.

The accumulation change **cannot** emit a malformed cursor: the stored `cursor` is copied verbatim
from the wire frame and only ever leaves through `safeCursor`. The reset-on-reselect path sends the
hard-coded literal `'0'`. Executed proofs:

- **P9** — wire frame carrying `cursor: 'NOT-A-NUMBER'`, clicked the control → dispatched `cursor: '0'`.
- **P7** — pathological `hasMore: true` with **zero** events → cursors dispatched `["0","0"]`, all grammar-valid.
- **P8** — reselect after paging → last dispatch exactly `{action:'GET_CHANNEL_TIMELINE', channelId:'chan-1', cursor:'0', limit:50}`.

`limit: 50` sits inside the schema's `min(1).max(100)`.

---

## 6. No-fabrication sweep (§2 / T-12) — PASS

Every rendered field, with its wire source:

| Rendered | Line | Wire source |
|---|---|---|
| `channel.name` | `:500` | LIST_CHANNELS ✔ |
| `archived` badge | `:501-505` | derived from `channel.state`, exact equality ✔ |
| `channel.role` | `:506-508` | LIST_CHANNELS ✔ |
| `authorLabel(actorPrincipalId)` | `:537` | TimelineEventObject ✔ |
| `formatOccurredAt(occurredAt)` | `:538` | TimelineEventObject ✔ |
| `messageText(payload)` | `:541` | `payload.text`, gated on `message_posted` ✔ |
| **kind label (NEW)** | `:544` | `event.kind` — real wire field, previously dropped ✔ |
| **`systemEventDetail` (NEW)** | `:546` | `payload.name` / `payload.principalId` ✔ |

**Adjudication of the flagged `systemEventDetail` scope question — CORRECT, does not exceed scope.**
The obligation asked me to rule explicitly. My ruling:

1. Both fields are **verified present** on their kinds' payloads at the insertion sites I read
   myself (§2.1). Rendering them is displaying wire data — the *opposite* of fabrication.
2. §2 forbids **inventing** data, not displaying data the wire sent. A blanket "kind label only"
   rule is not what §2 says.
3. The alternative is **less** honest: "member added" with no indication of *who* was added
   strips real, security-relevant information the wire carried. B-1 was blocking precisely
   because information present on the wire was being dropped; refusing to render `principalId`
   would repeat that error in a smaller form.
4. The `slice(0,8)` truncation reuses the convention already upheld for `authorLabel` —
   consistent with house style, not a novel disclosure.

Negative checks, all confirmed absent: **no** last-message preview, **no** member count, **no**
numeric unread badge, **no** roster, **no** composer (no `<form>`, `<textarea>`, `<input>`, or
`contenteditable` anywhere in the file). `lastAcknowledgedCursor` is typed at `:47` and **never
rendered** — correct, since without the channel's max seq a badge would be fabrication (§11 row 15).
`Date.now()` appears nowhere. Every `.length` occurrence is a loop bound or emptiness check.

---

## 7. Test integrity — PASS

`git diff ccc94b9 f458222 -- tests/` = **159 insertions, 6 deletions**. All six deleted lines:

```
-  it('timeline paging: … Load older uses the returned cursor; hasMore=false hides it', () => {
-    // hasMore:false -> no "Load older" control.
-    expect(screen.queryByText('Load older')).not.toBeInTheDocument();
-  it('timeline paging: hasMore=true shows Load older, which dispatches …', () => {
-    const loadOlder = screen.getByText('Load older');
-    fireEvent.click(loadOlder);
```

Two test titles, one comment, three label strings. **A pure rename tracking a mandated relabel.**
No test deleted, no threshold relaxed, no assertion weakened:

- `queryByText('Load more').not.toBeInTheDocument()` has **identical** strength to the old
  `'Load older'` form — same matcher, same negation.
- The new B-2 test at `:372` **adds** `expect(screen.queryByText('Load older')).not.toBeInTheDocument()`
  — strictly **stronger**, proving a relabel rather than an alias.
- All 15 original tests still assert what they did; count went 15 → **19**.

**No acceptance criterion was edited.** `docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` is **absent from
both commits** — the build was judged against a fixed spec.

---

## 8. Scope — PASS

`git diff ccc94b9~1 f458222 --name-only` across **both** commits:

```
apps/console/src/components/ChannelsPanel.tsx
apps/console/src/components/TorqTerminal.tsx
docs/prd-reviews/VERIFY-OPUS-COLLAB-PRESENCE-UI-005-S2.md
docs/security/agent-execution-isolation-audit.md
tests/channels-panel.test.tsx
```

**Nothing** under `packages/gateway`, `packages/contracts`, or `packages/collab`. Frontend-only
confirmed. `f458222` touched only `ChannelsPanel.tsx` + tests.

**TorqTerminal.tsx is purely additive** — the entire diff contains exactly **one** removed line,
the view-union widening (`'tasks'|'approvals'|'memory'` → `+ 'channels'`). Everything else is
insertion: one import, one flag const (`COLLAB_UI_ENABLED`, strict `=== '1'`, matching the
`ATTACHMENTS_ENABLED` house pattern), one flag-gated nav button (`:857`), one flag-gated render
branch (`:890`). No existing view restructured or reordered; the `view === 'tasks'` scroll-container
expression is untouched. Flag-gated at **both** sites, so with the flag off the component never
mounts and no collab command can fire.

---

## 9. T-11 structural inertness — PASS (by reading **and** by execution)

By reading: the **only** two `sendCommand` call sites in the entire file are `:207`
(`LIST_CHANNELS`) and `:280-285` (`GET_CHANNEL_TIMELINE`). Only two `action:` literals exist.
Grep for `SUBMIT_PROMPT|CANCEL_TASK|APPROVE_TOOL|APPROVE_SKILL|POST_CHANNEL_MESSAGE` over the
file returns **nothing**. `ChannelRow` receives a narrow `onSelect(channelId)` callback, never
`sendCommand`; `TimelineEventRow` has no callback in scope at all.

By execution — my probe **P10** clicked every rendered button three times with a mixed-kind
timeline loaded (so the paging control was live):

```
P10 dispatched action set: ["GET_CHANNEL_TIMELINE","LIST_CHANNELS"]
```

Exactly the allowlist, disjoint from the dangerous set. The committed T-11 test is anti-vacuous
(`expect(actions.length).toBeGreaterThan(0)`).

---

## 10. Adversarial gap hunt — 13 self-authored probes, NO new defect

I wrote and executed a throwaway probe suite (deleted afterward; never committed). **11/11 + 2/2 passed.**

| Probe | Scenario | Result |
|---|---|---|
| P1 | Timeline mixing **all six** kinds | **PASS** — every kind labelled; exactly **one** `font-reading` element in the whole timeline (the real message); archived/unarchived correctly label-only |
| P2 | Channel whose **only** event is `channel_created` | PASS — system row renders; not the empty card; no `(no text)` |
| P3 | **Malformed/missing** payloads on system kinds | PASS — no crash; no `undefined`, `null`, or a numeric `principalId` leaked into the DOM |
| P4 | **Rapid channel switch** mid-request; stale response lands | PASS — stale chan-1 content never appears while chan-2 is selected |
| P5 | Frame for a **no-longer-selected** channel | PASS — ignored; correct channel's content shown, previous channel's absent |
| P6 | **Duplicate event ids** across pages | PASS — deduped, body rendered exactly once, no key collision |
| P7 | `hasMore: true` with **zero** events | PASS — honest empty card + control; cursors `["0","0"]`, grammar-valid |
| P8 | Reselect semantics | PASS (see below) |
| P9 | Malformed **wire** cursor | PASS — clamped to `'0'` |
| P10 | Click-everything with mixed-kind timeline | PASS — dispatch set exactly the allowlist |
| P11 | Refresh **failure** | PASS — last-known rows stay visible |
| P8a | Reselect with old frames still buffered | PASS — accumulation **correctly reset** |
| P8b | Reselect after ring-buffer **eviction** | PASS — shows `Loading…`, **not** a fabricated empty card |

P1's DOM dump, verbatim, is the single best piece of evidence that B-1 is closed:

```
channel created — general | member added — principa | a real message |
member removed — principa | channel archived | channel unarchived
```

**One false positive I chased down and cleared.** My initial P8 logged `reselect renders stale? true`.
I did not accept that at face value; I wrote P8a/P8b to isolate it. P8a shows the timeline pane
after reselect contains only `PAGE TWO`, **not** `PAGE ONE` — accumulation *is* reset exactly as
`:311` claims. My original probe had checked whole-panel `textContent` (including the sidebar),
not the timeline pane. **Not a defect.**

**One honest observation, non-blocking (NB-7 below):** in P8a, immediately after reselect and
*before* the fresh cursor-0 response lands, the pane briefly shows the newest cached page rather
than `Loading…` — because `selectLatestTimeline` re-derives from a frame still in the buffer. This
is real wire data, correctly attributed to the correct channel, self-correcting within one round
trip. It is stale-but-real display, not fabrication — the same "last-known data stays visible"
property the honesty machine implements deliberately elsewhere. P8b confirms that once frames are
evicted, the state is honestly `Loading…` and never a fabricated empty card.

---

## 11. Adjudication of the verifier's six non-blocking notes

| # | Note | My ruling |
|---|---|---|
| 1 | Unrelated security doc bundled into `ccc94b9` | **UPHELD as a real process violation, not promoted to blocking.** See §12. |
| 2 | 8-char principal truncation is non-unique | **ACCEPT as non-blocking.** A collision renders two principals identically. But the full id is in the `title` attribute (`:537`), and the alternative — fabricating a display name — is forbidden by §2. Truncation is lossy-but-honest. **Carried to S3/S5** as a deliberate wire-surface decision. Note the remediation *extends* this convention to `systemEventDetail`; that widens the surface of a known-lossy label but does not change its nature. |
| 3 | `formatOccurredAt` always renders UTC | **ACCEPT as non-blocking.** It is explicitly suffixed `" UTC"`, so it is honest — it never implies local time. Localizing would introduce a timezone-inference layer that is a product decision, not a defect. Carried. |
| 4 | `messageText` accepts `text` from any kind | **CLOSED by the remediation.** It is now unreachable outside the `isMessage` branch (`:540-541`), and `:141-143` documents the requirement for future callers. |
| 5 | `timelineByChannelId` single-entry map is awkward | **ACCEPT as non-blocking style.** The remediation left the shape and added the merge on top. It works — probes P4/P5/P6 exercise it hard. Simplification is optional, not owed. |
| 6 | `selectChannel` sets `pending` then `requestTimeline` sets it again | **ACCEPT as harmless redundancy.** No behavioral consequence; `requestTimeline` may also set `sendFailed`, so the second write is not dead. |

**No note is promoted to blocking.** I add one of my own:

| # | New note | Ruling |
|---|---|---|
| 7 | Post-reselect, a cached newest page may render briefly before the cursor-0 response lands (§10) | **Non-blocking.** Real, correctly-attributed wire data; self-corrects in one round trip; never fabricates. Worth a deliberate decision if S4's freshness work touches this path. |

---

## 12. The bundled security doc — adjudicated

`ccc94b9` bundles `docs/security/agent-execution-isolation-audit.md` (158 lines), an unrelated
security document, into a feature commit. Root `CLAUDE.md` §"Change scoping" requires docs-only
changes stay separate from runtime behavior changes.

**I agree this was wrong**, and I record it rather than waive it: it pollutes the slice's blast
radius, and a revert of S2 would also revert an unrelated security audit. The orchestrator has
already conceded the point.

**It does not block.** It is a history-hygiene violation with **zero** functional effect on S2:
the file is documentation, it changes no runtime behavior, and it does not touch the audited
surface. Blocking a functionally-correct slice on commit hygiene that the orchestrator has
already acknowledged would burn a cycle for no product gain. **Carried as an obligation:** split
it out before merge if the history is still malleable, and if not, note it in the merge record.

---

## 13. Defects

**None.** No blocking defect. No new defect found by 13 adversarial probes. Both original
blockers confirmed closed by mutation probes I executed myself.

---

## 14. Carried obligations (to S3 and beyond)

1. **Split the bundled security doc** out of `ccc94b9` before merge if history is still malleable;
   otherwise record it in the merge record. (§12)
2. **Principal display names** — `principals.display_name` exists in the substrate but is not on the
   S1 read surface. Exposing it is a **disclosure decision** deserving its own slice, not a side
   effect of a console view. Until then the 8-char truncation stands, now in two places
   (`authorLabel`, `systemEventDetail`). (NB-2)
3. **UTC-only timestamps** — deliberate product decision owed if localization is ever wanted. (NB-3)
4. **Post-reselect transient partial render** — revisit if S4's freshness work touches this path. (NB-7)
5. **A seventh event kind** would need the `migration.ts` CHECK constraint widened; the component
   already degrades honestly, but its `SYSTEM_EVENT_LABELS` map should be updated in the same change.

---

## 15. Final verdict

**APPROVE.** S2 is done; the chain proceeds to **S3**.

Both blockers are closed, and I confirmed each with my own mutation probe rather than trusting the
builder's report — reverting the kind-branching turns 2 tests RED reproducing the exact `(no text)`
defect, and reverting the accumulation turns the both-pages test RED leaving only page two in the
DOM. The wire premises underlying both fixes I re-derived independently from `store.ts`, including
reading all six payload shapes at their insertion sites; every claim in the commit message checked
out. The honesty machine did **not** regress: no honesty-machine line changed between the two
commits, and the `null` → `[]` mutation still turns 4 tests RED. Scope held exactly, the shell edit
is purely additive, no test was weakened, and the PRD was never edited. Thirteen adversarial probes
— including the all-six-kinds timeline, malformed payloads, rapid channel switching, duplicate ids
across pages, and ring-buffer eviction — found no new defect, and the one suspicious result I saw I
chased down and cleared as an artifact of my own probe rather than reporting it as a finding.

The one real process violation (the bundled security doc) is a history-hygiene issue with zero
functional effect, already conceded, and is carried rather than used to burn a cycle on correct work.

**Working tree at end of audit:** all tracked files clean — `git diff --stat HEAD` empty, and
`git status --short` over `tests/`, `apps/`, and `packages/` returned nothing. All three mutation
probes were reverted via `git checkout` with confirming path-level status checks. Both throwaway
probe files were deleted. The only entries in `git status --short` are pre-existing untracked
operator files (logs, screenshots, `.bak` files, unrelated docs), **none** of which I created,
modified, moved, or deleted.
