# INDEPENDENT VERIFICATION — PRD-TCLAW-COLLAB-PRESENCE-UI-005 slice S2

**Verdict: REJECT** (2 blocking defects, both proven by executed probe, both invisible to the committed test suite)

**Date:** 2026-08-17
**Commit reviewed:** `ccc94b99320f335520d657b35ccd3dad08cacc02` — *feat(console): PRD-005 S2 — Channels view (read-only) behind NEXT_PUBLIC_COLLAB_UI*
**Branch:** `phase1-server-owned-authority`
**Role:** Independent verifier (G2A-adjacent pre-audit gate)

## Substitution disclosure (No False Delegation)

The operator profile names **Opus 4.8** for this verification seat. **Opus 4.8 is not invocable in this environment.** This review was performed by a **fresh `claude-opus-5` thread with no builder context** — a different model filling the ROLE, not the named model. This substitution is disclosed here rather than silently absorbed. The prior slice in this program was passed by both a builder and a verifier before G2A caught a process-killing defect (D-1, handler totality); this review was conducted adversarially with that history in mind.

No commits, no pushes, and no changes to any operator file were made. The one mutation performed (obligation 2) was reverted via `git checkout` with a confirming status check.

---

## 1. Evidence table — executed vs inherited

| # | Check | Method | Result |
|---|---|---|---|
| 1 | `npx vitest run tests/channels-panel.test.tsx` | **EXECUTED** | **15/15 passed**, 210ms |
| 2 | `npx vitest run tests/approvals-panel.test.tsx tests/receipts-panel.test.tsx tests/torq-terminal-presence.test.tsx` | **EXECUTED** | **42/42 passed** (18+19+5), 3 files |
| 3 | `pnpm typecheck` | **EXECUTED** | **14/14 successful**, FULL TURBO (cached) |
| 4 | `pnpm reachability` | **EXECUTED** | **PASS — 120 modules** reachable from 6 entry points, 3 declared dormant |
| 5 | Mutation probe (`null` → `[]`) | **EXECUTED** | **4 tests RED**, restored green 15/15, tree clean |
| 6 | Non-message event-kind render probe | **EXECUTED** | **DEFECT FOUND** (B-1) |
| 7 | Paging accumulation probe | **EXECUTED** | **DEFECT FOUND** (B-2) |
| 8 | Cross-channel leak probe | **EXECUTED** | Clean — no leak, correct cache restore |
| 9 | Malformed-wire-cursor clamp probe | **EXECUTED** | Clean — clamped to `"0"` |
| 10 | Scope check (gateway/contracts/collab) | **EXECUTED** | **NONE changed** — frontend-only confirmed |
| 11 | Flake claim: `tests/failover/controller-timeout.test.ts` | **EXECUTED (spot-check)** | **7/7 passed** in isolation, 38.5s — corroborates the inherited claim |
| 12 | Full suite 2051/2052 | **INHERITED** — not re-run | Accepted; #11 corroborates the diagnosis |

Note on #3: typecheck reported FULL TURBO cache hits. The cache key covers the changed sources, and the new `.tsx` files are type-clean under the same graph; I did not force a cold re-run.

---

## 2. Findings per obligation

### (2) The honesty machine — **PASS, and genuinely falsifiable**

`ChannelsPanel.tsx:155` initializes the channel-list snapshot to `null`:

```ts
const [channels, setChannels] = useState<ChannelListEntry[] | null>(null);
```

Confirmed **not** copied from the known-bad sibling:
- `ReceiptsPanel.tsx:98` — `useState<ReceiptSummary[]>([])` ← the known bug, **not** replicated
- `ApprovalHistoryPanel.tsx:66` — `useState<ApprovalSummaryLike[] | null>(null)` ← the correct pattern, replicated
- `ChannelsPanel.tsx:202` — timeline snapshots `Record<string, TimelineSnapshot | null>`, also null-initialized

The timeline snapshot is additionally null-per-channel, which is stricter than ReceiptsPanel's keyed-detail pattern. `selectLatestChannelList` (line 69–77) returns `null` for a malformed frame rather than an empty array — a malformed frame can never masquerade as "genuinely empty".

**Mutation probe record.** Changed line 155 initializer `null` → `[]`, re-ran the file. **4 tests went RED** — verbatim:

```
× ChannelsPanel > T-10: loading(null) !== empty([]) for the channel list  22ms
  → Unable to find an element with the text: Loading….
× ChannelsPanel > T-10: sendFailed shows retry affordance and never arms the timeout timer  9ms
  → Unable to find an element with the text: /couldn't request the channel list — connection may be reconnecting/.
× ChannelsPanel > T-10: timeout fires at exactly the 5000ms boundary, not before  8ms
  → Unable to find an element with the text: No response — refresh to try again.
× ChannelsPanel > malformed-frame resilience: good-then-malformed keeps good rows, never crashes; malformed-only stays Loading  15ms
  → Unable to find an element with the text: Loading….

Test Files  1 failed (1)
     Tests  4 failed | 11 passed (15)
```

Restored via `git checkout -- apps/console/src/components/ChannelsPanel.tsx`; `git status --short` on that path returned **empty**; line 155 confirmed back to `null`; re-run **15/15 green**. The honesty machine is real, not decorative.

### (3) No-fabrication sweep (§2 + T-12) — **PASS**

`LIST_CHANNELS` returns only `channelId, name, state, role, lastAcknowledgedCursor` (§11 row 14, confirmed against `store.ts` `listChannels`). Rendered fields, exhaustively:

| Rendered | Line | Wire source |
|---|---|---|
| `channel.name` | `ChannelsPanel.tsx:425` | ✔ LIST_CHANNELS |
| `archived` badge | `:426` | ✔ derived from `channel.state`, exact equality |
| `channel.role` | `:432` | ✔ LIST_CHANNELS |
| `authorLabel(actorPrincipalId)` | `:452` | ✔ TimelineEventObject |
| `formatOccurredAt(occurredAt)` | `:453` | ✔ TimelineEventObject |
| `messageText(payload)` | `:455` | ✔ `payload.text` — **see B-1** |

Grep for fabrication vectors (`.length`, `count`, `Math.`, `Date.now`, `unread`, `member`, `preview`) returns only emptiness checks (`:304`, `:357`) and the author truncation — **no derived display value**. `lastAcknowledgedCursor` is typed at `:46` and **never rendered**, which is correct: without the channel's max seq an unread badge would be fabrication (§11 row 15). No roster, no composer, no last-message preview, no member count. **`Date.now()` appears nowhere.** Confirmed: no last-message preview, no member count, no numeric unread badge, no roster, no composer.

### (4) Display-name question — **RULING: the builder was correct. See §3 for the full adjudication.**

### (5) Structural inertness (T-11) — **PASS**

Only two `sendCommand` call sites exist in the entire file: `:165` (`LIST_CHANNELS`) and `:216–221` (`GET_CHANNEL_TIMELINE`). Only two `action:` literals exist. No mutation path exists — there is no composer, no post affordance, not even a disabled one.

The test at `tests/channels-panel.test.tsx:153–174` clicks **every** rendered button twice (re-querying between passes so controls that appear after selection are also clicked), asserts `actions.length > 0` (anti-vacuous), then asserts every dispatched action is in the read-only allowlist **and** disjoint from `{SUBMIT_PROMPT, CANCEL_TASK, APPROVE_TOOL, APPROVE_SKILL, POST_CHANNEL_MESSAGE}`. `ChannelRow` receives a narrow `onSelect(channelId)` callback, never `sendCommand`; `TimelineEventRow` has no callback in scope at all. Structural boundary holds.

### (6) Cursor grammar — **PASS**

`CURSOR_GRAMMAR = /^(0|[1-9][0-9]*)$/` (`:100`) matches `packages/contracts/src/commands.ts:151` **exactly**. `safeCursor()` (`:101–103`) clamps to `'0'` on any non-match. Both dispatch paths route through it — `selectChannel` sends the literal `'0'`, and `loadOlder` sends `safeCursor(snap.cursor)`. `limit: 50` is inside the schema's `min(1).max(100)`.

**Executed probe:** injected a wire frame carrying `cursor: "not-a-number"` and clicked the paging control. Dispatch was `{"action":"GET_CHANNEL_TIMELINE","channelId":"chan-1","cursor":"0","limit":50}` — the clamp is load-bearing, not decorative. **No code path can send a malformed cursor.**

`loadOlder` (`:249–254`) is correctly gated: it early-returns unless `snap.hasMore`, and the control only renders under `selectedSnapshot.hasMore` (`:375`). **The code never infers end-of-history from a short page** — `hasMore` is the sole signal, which is correct given the 64 KiB frame cut at `store.ts:1837–1839`. That specific requirement is satisfied. **However, the control's paging behavior is defective for two other reasons — see B-2.**

### (7) Timestamps — **PASS**

`occurredAt` is ISO-8601: `collabSurface.ts:91` builds the store with `clock: { next: () => new Date().toISOString() }`, and `getChannelTimeline` (`store.ts:1833`) sets `occurredAt` from `row.created_at`, stamped from that same clock. The builder's independent verification of this is **correct**, and the PRD's own §13 S2 text is conditional (*"**if** they arrive in SQLite `YYYY-MM-DD HH:MM:SS` shape"*) — so routing away from `formatApprovalTimestamp` obeys the PRD rather than departing from it.

`formatOccurredAt` (`:119–124`) does **not** call `formatApprovalTimestamp`; it guards with `Number.isNaN(d.getTime())` and returns the raw string verbatim on failure. The local-time footgun the PRD warns about applies to zone-less space-separated strings, not to `T`/`Z` ISO strings — correctly reasoned. Malformed path tested at `tests/channels-panel.test.tsx:237–251`, asserting `not-a-date` renders verbatim and `/Invalid Date/` is absent. My own probe DOM dump confirms `"Invalid Date"` never reaches the DOM.

### (8) Flag discipline — **PASS**

`TorqTerminal.tsx:58`: `const COLLAB_UI_ENABLED = process.env.NEXT_PUBLIC_COLLAB_UI === '1';` — module-level const, strict `===`, matching the `ATTACHMENTS_ENABLED` house pattern. Gated at **both** sites: nav item (`:857`) and render/mount branch (`:890`).

Flag-off is provably zero-behavior-change: `ChannelsPanel` dispatches **only** from its own mount effect and from handlers on controls it renders. Gating the mount therefore gates every possible dispatch — with the flag off the component never mounts, so no collab command can fire. Repo-wide grep finds no other reader of the flag. **Correct: the flag is checked at every site that could fire a command, not only at render.**

### (9) Shell regression — **PASS**

The `TorqTerminal.tsx` diff is **purely additive**. The entire diff contains exactly **one** removed line, the view-union widening:

```diff
-  const [view, setView] = useState<'tasks' | 'approvals' | 'memory'>('tasks');
+  const [view, setView] = useState<'tasks' | 'approvals' | 'memory' | 'channels'>('tasks');
```

Everything else is insertion: one import, one flag const, one nav button, one render branch. No restructuring, no reordering, no change to any existing view. The `view === 'tasks'` visibility expression at the scroll container is untouched. `tests/torq-terminal-presence.test.tsx` passes 5/5.

### (10) Scope — **PASS**

`git show --name-only ccc94b9` returns exactly four paths; **nothing** under `packages/gateway`, `packages/contracts`, or `packages/collab` changed. Frontend-only confirmed. `git show --stat ccc94b9 -- tests/` shows `1 file changed, 296 insertions(+)` — **zero deletions, no existing test weakened, modified, or removed.**

---

## 3. The display-name ruling

**Ruling: the builder was correct, and correct for a stronger reason than the one given. Do not block the slice on this. It should be recorded as an explicit deferral to S3/S5, not as a resolved question.**

The facts, verified independently:

1. PRD §13 S2 prose specifies the timeline shows *"author display name"*.
2. The S1 wire's `TimelineEventObject` (`store.ts:1828–1835`) carries `cursor, id, kind, actorPrincipalId, occurredAt, payload` — **no name field**.
3. `message_posted` payload is exactly `{channelId, text}` (`store.ts:1503–1506`, §11 row 5).
4. **A display name does exist in the substrate** — `principals.display_name` (`store.ts:139`, written at `:459–461`). It is simply **not plumbed onto the S1 read surface.**

Point 4 matters and neither the builder nor the commit message states it. The PRD prose was not describing a nonexistent concept; it described a real column that S1 did not expose. This makes the conflict a **wire-surface gap**, not a PRD error.

Given that, the three candidate resolutions:

- **Fabricate a name** — forbidden outright. §2 is the controlling invariant and any synthesized label ("Agent 1", "Operator") is invented data. Correctly rejected.
- **Block the slice until the wire carries a name** — disproportionate and out of scope. S2 is declared frontend-only; adding a name to `TimelineEventObject` means touching `packages/collab` and `packages/contracts`, which would violate the slice's own scope boundary and drag a substrate change through a UI review gate. Worse, exposing `display_name` on a timeline read is a **disclosure decision** (§11 row 24 notes display names carry no uniqueness constraint, and names are user-controlled) that deserves its own review, not a side effect of a console slice.
- **Render the truncated principal id** — what the builder did. It renders only what the wire actually sent, degrades honestly, and follows the existing `LivenessChip` `{id.slice(0,8)}` house convention.

The third is right. §2 is a *controlling invariant*; §13 S2 is descriptive product prose. When an invariant and prose conflict, the invariant wins — that is what "controlling" means, and the PRD says so explicitly ("Part II **adds no authority and relaxes nothing** in Part I"). The builder escalating rather than silently resolving is exactly the behavior this chain wants.

**One caveat I attach to the ruling:** truncating to 8 characters (`:133`) is a lossy, non-unique label. §11 row 24 records that display names have no uniqueness constraint; principal-id prefixes have no guarantee either. Two principals sharing a prefix would render identically with nothing to distinguish them. The full id is preserved in the `title` attribute (`:452`), which mitigates but does not resolve it. **Non-blocking**, but S3/S5 should either plumb `display_name` onto the wire deliberately or widen the truncation.

---

## 4. Blockers

### B-1 — Non-message timeline events render as content-free "(no text)" rows; the `kind` field is on the wire and never rendered

**File:** `apps/console/src/components/ChannelsPanel.tsx:140–142`, `:448–457`
**Obligation:** (3) no-fabrication sweep / §2 controlling invariant / T-12

`getChannelTimeline` returns **every** event kind in `collab_events`, not just messages. Four kinds are written to that table:

| kind | store.ts | payload | has `text`? |
|---|---|---|---|
| `channel_created` | `:992–993` | `{channelId, name}` | **no** |
| `member_added` | `:1100–1101` | `{channelId, principalId, membershipEpoch}` | **no** |
| `member_removed` | `:1221` | `{channelId, principalId, membershipEpoch}` | **no** |
| `message_posted` | `:1471` | `{channelId, text}` | yes |

`TimelineEventRow` renders every event through `messageText(payload)`, which returns `'(no text)'` for anything lacking a string `text`. `event.kind` is captured in the type (`:52`) and **never rendered anywhere**.

Because `channel_created` is always `channel_seq = 1` (`store.ts:990`), **the first row of every real channel timeline renders as a blank "(no text)" message.** Any channel with membership activity shows more.

**Executed proof.** Rendered the real component with a three-event timeline (`channel_created`, `member_added`, `message_posted`). DOM output:

```html
<li ...><span title="principal-op">principa</span><span>2026-08-16 23:00:00.000 UTC</span>
  <p class="... font-reading ...">(no text)</p></li>     <!-- channel_created -->
<li ...><span title="principal-op">principa</span><span>2026-08-16 23:01:00.000 UTC</span>
  <p class="... font-reading ...">(no text)</p></li>     <!-- member_added -->
<li ...><span title="principal-op">principa</span><span>2026-08-16 23:02:00.000 UTC</span>
  <p class="... font-reading ...">real message</p></li>  <!-- message_posted -->
```

Console probe output: `COUNT (no text) rows = 2`, `kind label channel_created present? false`, `kind label member_added present? false`.

**Why this is blocking, not cosmetic.** It is a §2 honesty failure of the same family the slice was built to avoid. A membership change — *a security-relevant event* — is rendered in the message font as an empty message attributed to the actor who performed it. The operator cannot distinguish "someone was added to this channel" from "a message arrived whose text was malformed", and `(no text)` actively implies the latter. Real information present on the wire (`kind`) is dropped, and the resulting render misleads. The panel's own header comment claims it renders only what the wire sent; here it renders *less*, in a way that changes meaning.

**Test blind spot:** every fixture in `tests/channels-panel.test.tsx` uses `kind: 'message_posted'` (line 54 is the only `kind:` in the file). The suite cannot see this.

**Suggested remediation (S2-sized, frontend-only):** branch `TimelineEventRow` on `event.kind` — render `message_posted` as today, and render the three system kinds as a visually distinct system-event row labeled with the kind, using only fields the payload actually carries. No wire change required.

### B-2 — "Load older" pages the wrong direction *and* discards the page you were reading

**File:** `apps/console/src/components/ChannelsPanel.tsx:203–209`, `:249–254`, `:372–384`
**Obligation:** (6) cursor grammar / paging

Two distinct defects in one control.

**(a) Direction is inverted relative to the label.** The wire pages **forward**: `store.ts:1813` is `WHERE channel_seq > ? ORDER BY channel_seq ASC`, and `nextCursor` is the **last (newest)** event of the page (`store.ts:1849`). Sending `nextCursor` therefore fetches events **newer** than what you have. A control labeled **"Load older"** that fetches newer events is mislabeled. There is no backward-paging capability on this wire at all — `afterCursor` is strictly exclusive-lower-bound.

**(b) The new page replaces the old one instead of accumulating.** The snapshot setter at `:203–209` overwrites the whole entry:

```ts
setTimelineSnapshots((prev) => ({ ...prev, [selectedChannelId]: found }));
```

`found` is the latest single frame. `selectLatestTimeline` (`:81–95`) returns only the newest matching frame, so prior pages are dropped, and the render maps `selectedSnapshot.events` alone (`:367`).

**Executed proof.** Page 1 (`cursor:'1'`, `hasMore:true`, one message "page one msg") → clicked the control → page 2 frame arrived (`cursor:'2'`, `hasMore:false`, "page two msg"):

```
PAGE1 still visible after paging? false
PAGE2 visible?                    true
```

The user clicks a button offering *more* history and the content they were reading **vanishes**, replaced by a different page. Combined with (a), clicking it on a channel where you are already at the newest event yields an empty or near-empty view.

**Why this is blocking.** §13 S2 requires the timeline be "paged by the S1 cursor" with "Load older" as an explicit control. As built, the control neither loads older content nor pages — it swaps to a different, forward slice while destroying the current view. This is a functional break of the slice's only non-trivial interaction, not a polish item. It also interacts badly with the 64 KiB frame cut the design explicitly reasoned about: on a large channel, `hasMore` is true often, so this is the common path, not an edge case.

**Test blind spot:** the suite asserts the *dispatch* (`tests/channels-panel.test.tsx:213–225`) — that clicking sends `cursor:'7'` — but never asserts what is **rendered afterward**. No test contains any accumulation assertion (grep for `append|accumul|both pages|page one|prev` returns nothing). Verifying the dispatch while never verifying the resulting render is precisely how this survived.

**Suggested remediation:** accumulate pages per channel (merge by `event.id` / `cursor`, keep `channel_seq` ascending) and store the running `nextCursor` + `hasMore`; relabel the control to reflect forward paging (e.g. "Load newer" / "Load more"). Add a test asserting **both** pages are visible after a paging click.

---

## 5. Non-blocking notes

1. **Unrelated doc bundled into a feature commit.** `docs/security/agent-execution-isolation-audit.md` (158 lines, a security findings document from a different operator instruction) rides in `ccc94b9` alongside the S2 slice. Root `CLAUDE.md` §"Change scoping" requires docs-only changes stay separate from runtime behavior changes. **Bundling it was wrong** — it pollutes the slice's blast radius and makes a revert of S2 also revert an unrelated security audit. Not a functional defect; it should be split out before merge if the history is still malleable.

2. **8-char principal truncation is non-unique** (`:133`) — see the ruling caveat in §3. Full id is preserved in `title`. Revisit in S3/S5.

3. **`formatOccurredAt` re-serializes to UTC** (`:123`), so a viewer in a non-UTC zone always reads UTC. Correct and honest (explicitly suffixed `" UTC"`), but worth an explicit product decision in a later slice.

4. **`messageText` accepts `payload.text` from any kind.** Should B-1 be fixed by branching on `kind`, tighten this so a future event kind that happens to carry a `text` field is not silently rendered as a chat message.

5. **`timelineByChannelId` (`:194–200`) builds a single-entry map**, which is a slightly awkward shape for what is effectively "the latest frame for the selected channel". Harmless; noted only because the useMemo/useEffect pair around it is where B-2(b) lives, and simplifying it would make the accumulation fix cleaner.

6. **`selectChannel` sets phase `pending` then calls `requestTimeline`**, which sets it again (`:245–246`). Harmless redundancy.

---

## 6. What the builder got right

Stated plainly, because the REJECT is narrow and the surrounding work is strong: the honesty machine is correct and provably falsifiable; the known ReceiptsPanel `[]` bug was explicitly identified and **not** copied; the no-fabrication discipline is real and survives adversarial grep; the cursor clamp genuinely defends against a malformed wire value; the ISO-vs-SQLite timestamp correction was independently verified and is right; flag discipline is airtight; the shell edit is purely additive; scope held exactly; no test was weakened; and the display-name conflict was escalated honestly rather than resolved silently. The two blockers are both **omissions of rendering logic** — neither is a safety, authority, or fabrication breach.

---

## 7. Final verdict

**REJECT** — 2 blocking defects (B-1, B-2), both proven by executed probe against the real component, both invisible to the committed test suite.

Neither blocker touches the gateway, contracts, or the substrate; both are fixable inside `ChannelsPanel.tsx` with no wire change. Recommend: fix B-1 and B-2, add the two missing tests (non-message event kinds; page accumulation), split the unrelated security doc out of the commit, then return for re-verification. The slice's security and honesty posture is sound — this is a functional-completeness rejection, not an architectural one.

**Working tree at end of review:** clean with respect to all tracked files. Both probe files were deleted; the mutation was reverted via `git checkout` and confirmed. The only entries in `git status --short` are pre-existing untracked operator files (logs, screenshots, `.bak` files, unrelated docs), none of which were created, modified, moved, or deleted by this review.
